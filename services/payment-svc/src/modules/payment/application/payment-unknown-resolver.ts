// UNKNOWN 조회 실행기(docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현'·§4.2 14번, docs/data.md §5, BUILD_ORDER PRF-182, 명세 specs/payment.qnt `query`).
// PaymentConfirmRunner와 같은 꼴이다. 모든 API 파드가 1초 [가정]마다 빈자리만큼 UNKNOWN 행을 짧은 트랜잭션으로 잡고(next_query_at을 먼저 민다) 커밋한 뒤 잠금 밖에서 결제사를 부른다.
// 틱은 잡기까지만 기다리고 조회를 기다리지 않는다. 행 하나의 차례:
//   ① 어댑터가 없으면 건너뛴다(잡을 때 민 시각이 남아 있다, 지표 no_adapter, 파드당 1분에 경고 한 줄)
//   ② gateway.query(결제 참조, 시간 한도 10초 [가정]). 실행기도 12초 [가정]로 감싼다. 어댑터가 던지거나 한도를 넘으면 조회 실패로 본다
//   ③ 답 → decideQueryAnswer → RESOLVE면 resolve(한 트랜잭션, status = 'UNKNOWN' 조건)
//      ASK_AGAIN이면 어긋난 답의 SEV1을 결제마다 한 번 내고(anomaly_logged_at 조건부 쓰기) 답을 본 시각 + 실제 간격을 쓴다
// 입금 대기(AWAITING_DEPOSIT) 행도 같은 실행기가 잡는다(docs/features/payment.md §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151). 전이 표는 decideQueryAnswer이고, 답을 그대로 두는 간격만 입금 기한 + 10분 [가정]이다. 1시간 표시는 UNKNOWN만이다.
// 1시간 [가정] 표시는 잡기와 별개의 1분 반복이다(markOverdueBatch 한 문장, 100건까지 [가정]). 빈자리가 없거나 잡기가 실패해도 돈다.
// 틱·호출은 실행기를 만든 때(시작 파일, 요청 밖)의 비동기 맥락에서 돈다(PaymentConfirmRunner와 같은 까닭). 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
// 구현에서 정한 것(정본·설계에 없다):
// - 임대 칸이 없다: 잡을 때 다음 조회 시각을 미는 것이 임대 노릇을 한다(조회 중 파드가 죽어도 그 간격 뒤 다시 잡힌다).
// - query_attempts는 잡을 때 오른다(어댑터 없음·조회 실패로 끝나도 간격은 늘어난다).
// - 멈춘 뒤에는 새로 잡지 않고, 잡았지만 부르지 않은 행은 그대로 둔다(밀어 둔 간격 뒤 다시 잡힌다). stop은 돌던 조회와 그 뒤 쓰기를 기다린다.
// - 답 반영이 실패하면 다시 하지 않는다(승인 실행기의 finish와 다르다: 밀어 둔 간격 뒤 다시 조회해 같은 답을 쓰고, 조회는 멱등이다).
// - SEV1 표시 쓰기가 실패하면 로그를 내지 않는다(다음 조회가 다시 낸다). 지표는 조회마다 오른다.
// - 간격 쓰기가 실패하면 다시 하지 않는다(잡을 때 민 시각에 다시 잡힌다).
// - 틱은 잡기 전에 빈자리와 토큰을 먼저 쥔다(겹쳐 부른 틱이 상한을 넘겨 잡지 않게). 잡은 수만큼 남기고 나머지는 돌려준다.
// - 결제사 호출 보호(BUILD_ORDER PRF-183): 조회 한 번이 채널 토큰 하나를 쓴다(벌크헤드는 잡지 않는다). 틱은 채널마다 토큰을 미리 빼고 그 수만큼만 잡으며(코드 리뷰), 부르지 않은 행의 토큰은 돌려준다. 바로 돌리는 runJob은 토큰이 없으면 부르지 않고 다음 조회 시각을 1초 [가정] 뒤로 쓰며 잡을 때 올린 횟수를 되돌린다(부르지 않은 조회로 간격이 늘지 않게).
//   조회의 429는 어댑터가 throttled로 알리면 지표로만 센다(상한은 그대로다, 다음 시도는 조회 간격이 늦춘다).
// - 빈자리는 어댑터가 있는 채널끼리 나눈다(앞 채널이 뒤 채널을 굶기지 않게). 어댑터가 없는 채널은 그 뒤 남은 자리로 잡아 no_adapter로 드러낸다(운영에는 그런 행이 없다). 틱은 채널마다 독립이다(한 채널의 느린 잡기가 다른 채널을 막지 않는다).
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import type { ConfirmCard, ConfirmVirtualAccount, PaymentGatewayPort, PgName, QueryResult } from '../domain/payment-gateway.js';
import { type PaymentMethodLink, paymentMethodLinkOf } from '../domain/payment-method-ref.js';
import { PG_NAMES, type PgCallGuard, type PgCallGuards } from '../domain/pg-call-guard.js';
import { isProbeFailure, isQueryOutage, PG_CIRCUIT_DEFER_MS, PG_CIRCUIT_PROBE_PAYMENT_REF, PG_CIRCUIT_PROBE_TIMEOUT_MS, PgCircuitOpenError } from '../domain/pg-circuit.js';
import type { PaymentGateways, PaymentMethodRefSignals, PaymentMethodRefs, PaymentResolutionSignals, PaymentUnknownLog, PaymentUnknownQueries, PaymentUnknownSignals } from '../domain/ports.js';
import {
  decideQueryAnswer,
  decideReversalAnswer,
  type PaymentUnknownQueryOutcome,
  type QueryAnomaly,
  type QueryDecision,
  type ResolvedFinish,
  UNKNOWN_NO_ADAPTER_WARN_INTERVAL_MS,
  UNKNOWN_OVERDUE_BATCH,
  UNKNOWN_OVERDUE_SWEEP_INTERVAL_MS,
  UNKNOWN_QUERY_BATCH,
  UNKNOWN_QUERY_CONCURRENCY,
  UNKNOWN_QUERY_GUARD_MS,
  UNKNOWN_QUERY_NO_TOKEN_DELAY_MS,
  UNKNOWN_QUERY_POLL_INTERVAL_MS,
  UNKNOWN_QUERY_TIMEOUT_MS,
  unknownQueryDelayMs,
  type UnknownQueryJob,
  type UnknownRunOutcome,
} from '../domain/unknown-resolver.js';
import { safeErrorCode } from '../../../safe-error-code.js';
import { reversalDueAtMs } from '../domain/virtual-account.js';
import { depositWriteOf, type DepositWriteDeps } from './deposit-write.js';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval·clearInterval) */
export interface UnknownResolverTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 실행기가 쓰는 포트와 설정 */
export interface PaymentUnknownResolverDeps {
  queries: PaymentUnknownQueries;
  gateways: PaymentGateways;
  log: PaymentUnknownLog;
  signals: PaymentUnknownSignals;
  clock: Clock;
  /** 채널별 호출 보호기(승인 실행기와 같은 것을 넘긴다. 토큰을 함께 쓴다) */
  guards: PgCallGuards;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: UnknownResolverTimer;
  /** 잡기 주기(기본 UNKNOWN_QUERY_POLL_INTERVAL_MS 1초 [가정]) */
  pollIntervalMs?: number;
  /** 파드의 동시 자리 수(기본 UNKNOWN_QUERY_CONCURRENCY 16 [가정]). 1 이상의 안전한 정수가 아니면 기본값으로 본다 */
  concurrency?: number;
  /** 실행기가 조회를 감싸는 한도(기본 UNKNOWN_QUERY_GUARD_MS 12초 [가정]) */
  queryGuardMs?: number;
  /** 결제 수단 연결값(라벨 키 pay, BUILD_ORDER HOT-145). 없으면 카드 결제는 refMissing 참이다 */
  methodRefs?: PaymentMethodRefs;
  methodRefSignals?: PaymentMethodRefSignals;
  /** 입금 대기 쓰기의 포트(BUILD_ORDER HOT-151). 없으면 발급 정보를 쓰지 않는다 */
  deposit?: DepositWriteDeps;
  /** 결제 확정 소요 지표(BUILD_ORDER PRF-200). 없으면 재지 않는다 */
  resolution?: PaymentResolutionSignals;
}

/** 틱 하나의 결과 */
export interface UnknownTickResult {
  /** 잡은 행 수(부르기 시작한 수이고, 끝난 수가 아니다) */
  readonly claimed: number;
}

/** 1시간 표시 한 번의 결과 */
export interface UnknownSweepResult {
  /** 이번에 표시한 행 수 */
  readonly marked: number;
}

/** 이 행 몫으로 미리 뺀 토큰. 호출 직전에 false가 되고, 끝날 때 true로 남아 있으면 돌려준다 */
interface TokenHold {
  held: boolean;
}

/** 실행기 한도를 넘긴 조회(어댑터가 시간 한도를 지키지 않았다) */
class UnknownQueryGuardTimeout extends Error {
  constructor() {
    super('단독 조회가 실행기 한도를 넘겼다');
    this.name = 'UnknownQueryGuardTimeout';
  }
}

/**
 * UNKNOWN 조회 실행기. start()로 1초 반복을 켜고 stop()으로 끈다(돌던 조회와 그 뒤 쓰기를 기다린다).
 * 같은 행을 두 파드가 잡지 않는다(SKIP LOCKED·먼저 밀기). 겹치면 payment 행 잠금과 status = 'UNKNOWN' 조건이 하나만 쓰게 한다.
 */
export class PaymentUnknownResolver {
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  /** 1시간 표시 반복의 손잡이 */
  #sweepHandle: unknown;
  #stopped = false;
  /** 잡기가 도는 채널(겹치지 않게 채널마다 하나만, 한 채널이 느려도 다른 채널의 틱은 돈다) */
  readonly #claiming = new Set<PgName>();
  /** 타이머가 시작한 1시간 표시가 도는 중인가(겹치지 않게 하나만) */
  #sweeping = false;
  /** 돌고 있는 틱의 잡기와 행(stop·whenIdle이 기다린다) */
  readonly #inflight = new Set<Promise<void>>();
  /** 쥔 자리 수(호출과 그 뒤 쓰기, 잡기 전에 미리 쥔 것 포함) */
  #held = 0;
  /** 지금 돌고 있는 조회 수(지표) */
  #calls = 0;
  /** 마지막으로 어댑터 없음 경고를 낸 시각(epoch ms) */
  #lastNoAdapterWarnMs: number | undefined;
  /** 만든 때(시작 파일, 요청 밖)의 비동기 맥락. 틱·호출이 이 맥락에서 돈다(끝난 요청의 남은 시간을 물려받지 않게) */
  readonly #scope = new AsyncResource('PaymentUnknownResolver');

  constructor(readonly deps: PaymentUnknownResolverDeps) {}

  /** 잡기 반복과 1시간 표시 반복을 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다). 앞 일이 끝나지 않았으면 그 회차를 건너뛴다 */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#loopTick(), this.deps.pollIntervalMs ?? UNKNOWN_QUERY_POLL_INTERVAL_MS);
    this.#sweepHandle = this.#timer().setInterval(() => this.#loopSweep(), UNKNOWN_OVERDUE_SWEEP_INTERVAL_MS);
  }

  /** 반복을 끄고 돌던 일(조회와 그 뒤 쓰기, 1시간 표시)을 기다린다. 멈춘 뒤의 틱·표시·start는 아무것도 하지 않는다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const handle of [this.#handle, this.#sweepHandle]) if (handle !== undefined) this.#timer().clearInterval(handle);
    this.#handle = undefined;
    this.#sweepHandle = undefined;
    await this.whenIdle();
  }

  /** 1시간 표시 한 번(잡기와 별개다, 머리 주석). 표시한 행마다 SEV2 로그와 지표를 낸다. 던지지 않는다(실패는 log.runError(what overdue) 뒤 0) */
  async sweepOverdue(): Promise<UnknownSweepResult> {
    if (this.#stopped) return NOTHING_SWEPT;
    const p = this.#scope.runInAsyncScope(() => this.#sweepOnce());
    this.#track(p);
    return p;
  }

  /**
   * 틱 하나: 빈자리가 있으면 그만큼(한 번에 UNKNOWN_QUERY_BATCH까지) 잡고, 잡은 행을 시작만 시키고 돌아온다(조회를 기다리지 않는다).
   * 빈자리가 0이거나 멈춘 뒤면 잡지 않고 claimed 0이다. 던지지 않는다(잡기 실패는 log.runError(what claim) 뒤 0)
   */
  async tick(): Promise<UnknownTickResult> {
    if (this.#stopped) return NOTHING;
    const p = this.#scope.runInAsyncScope(() => this.#tickOnce());
    this.#track(p);
    return p;
  }

  /** 지금 돌고 있는 행이 모두 끝나면 풀린다(시험과 stop이 쓴다) */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /** 잡은 행 하나를 돈다(머리 주석의 차례). 던지지 않는다. 빈자리를 쥐고 돌며(동시 상한), 멈춘 뒤면 부르지 않고 SKIPPED STOPPED다 */
  async runJob(job: UnknownQueryJob): Promise<UnknownRunOutcome> {
    this.#held += 1;
    return this.#startHeld(job, { held: false });
  }

  // ---- 안쪽 ----

  #timer(): UnknownResolverTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  #concurrency(): number {
    const c = this.deps.concurrency ?? UNKNOWN_QUERY_CONCURRENCY;
    return Number.isSafeInteger(c) && c >= 1 ? c : UNKNOWN_QUERY_CONCURRENCY;
  }

  /** 반복 타이머의 틱: 잡기가 도는 채널은 그 틱 안에서 건너뛴다. 멈춘 뒤에는 돌지 않는다 */
  #loopTick(): void {
    if (this.#stopped) return;
    void this.tick();
  }

  /** 반복 타이머의 1시간 표시: 앞 표시가 아직 돌면 건너뛴다. 멈춘 뒤에는 돌지 않는다 */
  #loopSweep(): void {
    if (this.#stopped || this.#sweeping) return;
    this.#sweeping = true;
    void this.sweepOverdue().finally(() => {
      this.#sweeping = false;
    });
  }

  async #sweepOnce(): Promise<UnknownSweepResult> {
    let orderIds: string[];
    try {
      orderIds = await this.deps.queries.markOverdueBatch(UNKNOWN_OVERDUE_BATCH);
    } catch (err) {
      this.#runError('overdue', err);
      return NOTHING_SWEPT;
    }
    for (const orderId of orderIds) {
      this.#safe(() => this.deps.log.overdue({ orderId }));
      this.#safe(() => this.deps.signals.overdue());
    }
    return { marked: orderIds.length };
  }

  async #tickOnce(): Promise<UnknownTickResult> {
    const adapted: [PgName, PgCallGuard][] = [];
    const bare: PgName[] = [];
    for (const pg of PG_NAMES) {
      try {
        const guard = this.deps.guards.of(pg);
        if (guard === undefined) bare.push(pg);
        else adapted.push([pg, guard]);
      } catch (err) {
        // 어댑터 결함: 그 채널만 건너뛴다(행은 표에서 기다린다)
        this.#runError('claim', err);
      }
    }
    const called = await Promise.all(this.#split(adapted.map(([pg]) => pg)).map(([pg, share], i) => this.#turn(pg, () => this.#claimAdapted(pg, adapted[i]![1], share))));
    if (this.#stopped) return this.#tickResult(called);
    // 어댑터가 있는 채널이 못 잡고 남긴 자리로 잡는다
    const skipped = await Promise.all(this.#split(bare).map(([pg, share]) => this.#turn(pg, () => this.#claimBare(pg, share))));
    return this.#tickResult([...called, ...skipped]);
  }

  #tickResult(counts: readonly number[]): UnknownTickResult {
    return { claimed: counts.reduce((a, b) => a + b, 0) };
  }

  /** 지금 빈자리를 채널들에 고르게 나눈다(앞 채널이 뒤 채널을 굶기지 않게) */
  #split(pgs: readonly PgName[]): [PgName, number][] {
    let free = Math.max(0, this.#concurrency() - this.#held);
    return pgs.map((pg, i) => {
      const share = Math.ceil(free / (pgs.length - i));
      free -= share;
      return [pg, share];
    });
  }

  /** 그 채널의 잡기가 돌고 있지 않을 때만 work를 돌리고, 끝나면 표시를 지운다 */
  async #turn(pg: PgName, work: () => Promise<number>): Promise<number> {
    if (this.#claiming.has(pg)) return 0;
    this.#claiming.add(pg);
    try {
      return await work();
    } finally {
      this.#claiming.delete(pg);
    }
  }

  /** 어댑터가 있는 채널 하나: 몫과 쓸 수 있는 토큰 가운데 작은 수만큼 토큰과 자리를 쥐고, 잡은 수만큼 남기고 나머지는 돌려준다 */
  async #claimAdapted(pg: PgName, guard: PgCallGuard, share: number): Promise<number> {
    const want = Math.min(UNKNOWN_QUERY_BATCH, share);
    if (want === 0) return 0;
    const reserved = guard.takeQueryTokens(want);
    if (reserved === 0) {
      await this.#noteBlockedIfWaiting(pg, guard);
      return 0;
    }
    const jobs = await this.#claim(pg, reserved);
    guard.refundTokens(Math.max(0, reserved - jobs.length));
    guard.noteTrialClaimed(jobs.length);
    for (const job of jobs) void this.#startHeld(job, { held: true });
    if (jobs.length === 0) this.#probeIfTrialWaits(pg, guard);
    return jobs.length;
  }

  /** 잡을 UNKNOWN이 없는 반 열림: 없는 결제 조회를 시험 호출로 보낸다(고객 승인을 시험으로 내보내지 않는다, 코드 리뷰). 토큰이 없으면 다음 틱에 다시 본다 */
  #probeIfTrialWaits(pg: PgName, guard: PgCallGuard): void {
    if (this.#stopped || !guard.awaitsTrial() || !guard.tryTakeToken()) return;
    this.#held += 1;
    const p = this.#scope.runInAsyncScope(() => this.#probe(pg, guard)).finally(() => {
      this.#held -= 1;
    });
    this.#track(p);
  }

  /** 없는 결제 조회 한 번. 원장을 바꾸지 않고 서킷만 판정한다. 던지지 않는다 */
  async #probe(pg: PgName, guard: PgCallGuard): Promise<void> {
    try {
      const gateway = this.deps.gateways.of(pg);
      if (gateway !== undefined) await guard.run(() => this.#guarded(gateway.query(PG_CIRCUIT_PROBE_PAYMENT_REF, { timeoutMs: PG_CIRCUIT_PROBE_TIMEOUT_MS })), isProbeFailure, 'query');
    } catch (err) {
      if (err instanceof PgCircuitOpenError) guard.refundTokens();
      else this.#runError('call', err);
    }
  }

  /** 어댑터가 없는 채널 하나: 몫만큼 잡아 지표로 드러낸다(부르지 않으므로 토큰을 쓰지 않는다) */
  async #claimBare(pg: PgName, share: number): Promise<number> {
    const want = Math.min(UNKNOWN_QUERY_BATCH, share);
    if (want === 0) return 0;
    const jobs = await this.#claim(pg, want);
    for (const job of jobs) void this.#startHeld(job, { held: false });
    return jobs.length;
  }

  /** 잡기 전에 자리를 쥐고 잡은 행마다 쥔 자리 하나를 넘기며 남은 자리는 놓는다. 잡기가 실패하면 빈 목록이다 */
  async #claim(pg: PgName, count: number): Promise<UnknownQueryJob[]> {
    this.#held += count;
    let jobs: UnknownQueryJob[] = [];
    try {
      jobs = await this.deps.queries.claimDueQueries(pg, count);
    } catch (err) {
      this.#runError('claim', err);
    }
    this.#held -= Math.max(0, count - jobs.length);
    return jobs;
  }

  /** 기다리는 행이 있을 때만 토큰에 막힌 것으로 센다. 확인이 실패하면 세지 않는다 */
  async #noteBlockedIfWaiting(pg: PgName, guard: PgCallGuard): Promise<void> {
    // 서킷 때문이면 어차피 세지 않으므로 표를 묻지 않는다(코드 리뷰)
    if (!guard.circuitClosed()) return;
    try {
      if (await this.deps.queries.hasDueQueries(pg)) guard.noteBlocked('token');
    } catch (err) {
      this.#runError('claim', err);
    }
  }

  /** 자리를 이미 쥔 행을 시작한다(stop·whenIdle이 기다리게 적는다) */
  #startHeld(job: UnknownQueryJob, hold: TokenHold): Promise<UnknownRunOutcome> {
    const p = this.#scope.runInAsyncScope(() => this.#runHeld(job, hold));
    this.#track(p);
    return p;
  }

  /** 자리를 쥔 채 행 하나를 돈다. 끝나면(어느 갈래든) 쓰지 않은 토큰을 돌려주고 자리를 놓는다 */
  async #runHeld(job: UnknownQueryJob, hold: TokenHold): Promise<UnknownRunOutcome> {
    try {
      return await this.#run(job, hold);
    } finally {
      if (hold.held) this.#guardOf(job.pg)?.refundTokens();
      this.#held -= 1;
    }
  }

  /** 그 채널의 보호기. 어댑터가 없거나 만들지 못하면 undefined */
  #guardOf(pg: PgName): PgCallGuard | undefined {
    try {
      return this.deps.guards.of(pg);
    } catch {
      return undefined;
    }
  }

  async #run(job: UnknownQueryJob, hold: TokenHold): Promise<UnknownRunOutcome> {
    if (this.#stopped) return STOPPED;

    let gateway: PaymentGatewayPort | undefined;
    let guard: PgCallGuard | undefined;
    try {
      gateway = this.deps.gateways.of(job.pg);
      if (gateway !== undefined) guard = this.deps.guards.of(job.pg);
    } catch (err) {
      this.#runError('gateway', err, job.orderId);
      return job.lateDepositCheck ? this.#lateDeposit(job, QUERY_UNKNOWN) : this.#askedAgain(job, 'query_failed');
    }
    if (gateway === undefined) return job.lateDepositCheck ? this.#lateDeposit(job, QUERY_UNKNOWN) : this.#noAdapter(job);
    if (this.#stopped) return STOPPED;
    // 서킷이 열렸으면 조회를 건너뛰고 간격만 민다(토큰은 #runHeld가 돌려준다, BUILD_ORDER PRF-200)
    if (guard !== undefined && !guard.admitsQuery()) return this.#circuitSkipped(job);
    // 토큰을 못 얻었거나 보호기가 없으면 상한 없이 부르지 않는다. 틱이 잡은 행은 토큰을 미리 뺐다
    if (guard === undefined || (!hold.held && !guard.tryTakeToken())) return this.#noToken(job);

    hold.held = false;
    const answer = await this.#query(gateway, guard, job);
    if (answer === CIRCUIT_OPEN) {
      hold.held = true;
      return this.#circuitSkipped(job);
    }
    // 조회의 429는 그 조회의 다음 시도만 늦추고 상한은 그대로다(지표로만 센다)
    if (answer.kind === 'UNKNOWN' && answer.throttled === true) guard.noteThrottled({ first: false });
    if (job.lateDepositCheck) return this.#lateDeposit(job, answer);
    if (job.reversalCheck !== undefined) return this.#reversal(job, job.reversalCheck, answer);
    const card = answer.kind === 'FOUND' ? answer.card : undefined;
    const decision = decideQueryAnswer(answer, job, this.deps.clock.now(), () => this.#linkOf(card));
    if (decision.kind === 'ASK_AGAIN') {
      await this.#reportAnomaly(job, decision);
      await this.#reschedule(job, decision.nextAtMs, decision.keepAttempts === true);
      return this.#askedAgain(job, decision.outcome);
    }
    return this.#resolve(job, decision, answer.kind === 'FOUND' ? answer.virtualAccount : undefined);
  }

  /** 주문·금액 대조를 통과한 승인 답의 결제 수단 연결값(가린 번호를 넘기지 않는다. 던지지 않는다) */
  #linkOf(card: ConfirmCard | undefined): PaymentMethodLink {
    return paymentMethodLinkOf(card, this.deps.methodRefs, (reason) => this.#safe(() => this.deps.methodRefSignals?.missing(reason)));
  }

  /**
   * FAILED로 끝난 행의 늦은 입금 확인(조회 한 번, BUILD_ORDER HOT-151 코드 리뷰). 조회 시각을 비운 파드만 입금 완료를 SEV1·지표로 알린다. 원장은 바꾸지 않는다(HOT-153이 닫는다). 던지지 않는다.
   * 조회가 실패해도 다시 묻지 않는다(한 번 규칙이다. 놓친 건은 대사가 찾는다)
   */
  async #lateDeposit(job: UnknownQueryJob, answer: QueryResult): Promise<UnknownRunOutcome> {
    const paid = answer.kind === 'FOUND' && answer.orderRef === job.orderId && answer.status === 'APPROVED';
    let finished = false;
    try {
      finished = await this.deps.queries.finishLateDepositCheck(job);
    } catch (err) {
      this.#runError('reschedule', err, job.orderId);
    }
    if (paid && finished) {
      this.#safe(() => this.deps.log.lateDeposit({ orderId: job.orderId }));
      this.#outcome(job, 'late_deposit');
    }
    return { kind: 'LATE_DEPOSIT', paid };
  }

  /** 승인 원장의 입금 오류 확인(BUILD_ORDER HOT-152): 결제사 상태가 입금 대기로 돌아왔을 때만 되돌린다. 던지지 않는다 */
  async #reversal(job: UnknownQueryJob, check: NonNullable<UnknownQueryJob['reversalCheck']>, answer: QueryResult): Promise<UnknownRunOutcome> {
    const now = this.deps.clock.now();
    const decision = decideReversalAnswer(answer, job, check.notifiedAtMs, now);
    if (decision.kind === 'ASK_AGAIN') {
      await this.#reportAnomaly(job, decision);
      if (decision.overdue === true) await this.#reportReversalOverdue(job);
      await this.#reschedule(job, decision.nextAtMs, true);
      return this.#askedAgain(job, decision.outcome);
    }
    if (decision.kind === 'END') {
      let finished = false;
      try {
        finished = await this.deps.queries.finishReversalCheck(job);
      } catch (err) {
        this.#runError('reschedule', err, job.orderId);
      }
      if (finished) {
        this.#safe(() => this.deps.log.reversalUnconfirmed({ orderId: job.orderId }));
        this.#outcome(job, 'reversal_unconfirmed');
      }
      return REVERSAL_ENDED;
    }
    return this.#reverse(job, decision.virtualAccount, now);
  }

  /** 입금 오류를 1시간 [가정] 넘게 확인하지 못했다: 표시를 이번에 쓴 행만 SEV1을 낸다(결제마다 한 번). 표시 쓰기가 실패하면 다음 조회가 다시 낸다. 던지지 않는다 */
  async #reportReversalOverdue(job: UnknownQueryJob): Promise<void> {
    let marked: boolean;
    try {
      marked = await this.deps.queries.markReversalOverdue(job);
    } catch (err) {
      this.#runError('anomaly', err, job.orderId);
      return;
    }
    if (marked) this.#safe(() => this.deps.log.reversalOverdue({ orderId: job.orderId }));
  }

  /** 입금 대기로 되돌린다(원장·사건·Outbox 한 트랜잭션, 암호화는 트랜잭션 앞이다). 던지면 밀어 둔 간격 뒤의 조회에 맡긴다 */
  async #reverse(job: UnknownQueryJob, va: ConfirmVirtualAccount | undefined, nowMs: number): Promise<UnknownRunOutcome> {
    const answerDue = va?.dueAt === undefined ? Number.NaN : Date.parse(va.dueAt);
    const dueAtMs = reversalDueAtMs(Number.isNaN(answerDue) ? undefined : answerDue, nowMs, job.entryOpensAtMs);
    if (dueAtMs === undefined) return this.#closeReversal(job, nowMs);
    try {
      const written = this.deps.deposit === undefined ? undefined : await depositWriteOf(this.deps.deposit, { paymentId: job.paymentId, orderId: job.orderId }, va);
      const result = await this.deps.queries.reverseDeposit(job, { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', reversed: true, deposit: { ...written, dueAtMs } });
      if (result === 'STALE') {
        this.#safe(() => this.deps.log.staleAnswer({ orderId: job.orderId }));
        return STALE;
      }
      this.#safe(() => this.deps.log.depositReversed({ orderId: job.orderId }));
      this.#outcome(job, 'deposit_reversed');
      return REVERSED;
    } catch (err) {
      this.#safe(() => this.deps.signals.writeFailure());
      this.#safe(() => this.deps.log.writeFailed({ orderId: job.orderId, code: safeErrorCode(err) }));
      return WRITE_FAILED;
    }
  }

  /** 입장이 2시간 [가정] 안이라 다시 입금할 수 없다: T21과 T17을 한 트랜잭션으로 쓰고 SEV2를 낸다(BUILD_ORDER PRF-190 코드 리뷰). 던지면 밀어 둔 간격 뒤의 조회에 맡긴다 */
  async #closeReversal(job: UnknownQueryJob, nowMs: number): Promise<UnknownRunOutcome> {
    try {
      const result = await this.deps.queries.closeReversedDeposit(job, { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', reversed: true, deposit: { dueAtMs: nowMs } }, { status: 'FAILED', result: 'DECLINED', failureCategory: 'EXPIRED' });
      if (result === 'STALE') {
        this.#safe(() => this.deps.log.staleAnswer({ orderId: job.orderId }));
        return STALE;
      }
      this.#safe(() => this.deps.log.reversalNoTime({ orderId: job.orderId }));
      this.#outcome(job, 'reversal_no_time');
      return REVERSAL_CLOSED;
    } catch (err) {
      this.#safe(() => this.deps.signals.writeFailure());
      this.#safe(() => this.deps.log.writeFailed({ orderId: job.orderId, code: safeErrorCode(err) }));
      return WRITE_FAILED;
    }
  }

  /** 답을 본 시각 + 실제 간격을 쓴다(잡을 때 민 더 긴 시각을 줄인다). 입금 대기가 그대로라는 답은 그 답이 정한 시각을 쓰고 조회 횟수를 비운다(통보 뒤 다시 묻는 동안은 횟수를 남겨 간격을 늘린다). 던지지 않는다 */
  async #reschedule(job: UnknownQueryJob, nextAtMs?: number, keepAttempts = false): Promise<void> {
    try {
      if (nextAtMs === undefined) await this.deps.queries.rescheduleQuery(job, this.deps.clock.now() + unknownQueryDelayMs(job.queryAttempts));
      else if (keepAttempts) await this.deps.queries.rescheduleQuery(job, nextAtMs);
      else await this.deps.queries.rescheduleQuery(job, nextAtMs, { resetAttempts: true });
    } catch (err) {
      this.#runError('reschedule', err, job.orderId);
    }
  }

  /** 토큰이 없다: 부르지 않고 다음 조회 시각만 짧게 쓰며 잡을 때 올린 횟수를 되돌린다. 쓰기가 실패하면 잡을 때 민 시각에 다시 잡힌다. 던지지 않는다 */
  async #noToken(job: UnknownQueryJob): Promise<UnknownRunOutcome> {
    try {
      await this.deps.queries.rescheduleQuery(job, this.deps.clock.now() + UNKNOWN_QUERY_NO_TOKEN_DELAY_MS, { refundAttempt: true });
    } catch (err) {
      this.#runError('reschedule', err, job.orderId);
    }
    return NO_TOKEN;
  }

  /** 서킷이 열려 조회를 건너뛴다: 다음 조회 시각을 1초 [가정] 뒤로 밀고 잡을 때 올린 횟수를 되돌린다(부르지 않았다, BUILD_ORDER PRF-200). 던지지 않는다 */
  async #circuitSkipped(job: UnknownQueryJob): Promise<UnknownRunOutcome> {
    try {
      await this.deps.queries.rescheduleQuery(job, this.deps.clock.now() + PG_CIRCUIT_DEFER_MS, { refundAttempt: true });
    } catch (err) {
      this.#runError('reschedule', err, job.orderId);
    }
    return CIRCUIT_SKIPPED;
  }

  /** 단독 조회 한 번(서킷 안에서). 어댑터가 던지거나 실행기 한도를 넘으면 조회 실패 답으로 바꾼다. 서킷이 끊어 부르지 않았으면 CIRCUIT_OPEN이다 */
  async #query(gateway: PaymentGatewayPort, guard: PgCallGuard, job: UnknownQueryJob): Promise<QueryResult | typeof CIRCUIT_OPEN> {
    this.#calls += 1;
    this.#safe(() => this.deps.signals.inFlight(this.#calls));
    try {
      return await guard.run(() => this.#guarded(gateway.query(job.paymentRef, { timeoutMs: UNKNOWN_QUERY_TIMEOUT_MS, ...(job.txId === undefined ? {} : { expectedTxId: job.txId }) })), isQueryOutage, 'query');
    } catch (err) {
      if (err instanceof PgCircuitOpenError) return CIRCUIT_OPEN;
      this.#runError('call', err, job.orderId);
      return QUERY_UNKNOWN;
    } finally {
      this.#calls -= 1;
      this.#safe(() => this.deps.signals.inFlight(this.#calls));
    }
  }

  /** 실행기 한도로 감싼다. 한도를 넘기면 UnknownQueryGuardTimeout으로 거절하고, 어댑터가 늦게 끝나도 자리는 이미 돌아갔다 */
  async #guarded(work: Promise<QueryResult>): Promise<QueryResult> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => reject(new UnknownQueryGuardTimeout()), this.deps.queryGuardMs ?? UNKNOWN_QUERY_GUARD_MS);
      handle.unref();
    });
    try {
      return await Promise.race([work, guard]);
    } finally {
      clearTimeout(handle);
    }
  }

  /** 어긋난 답의 SEV1을 결제마다 한 번 낸다(표시를 이번에 쓴 행만 로그를 낸다). 던지지 않는다 */
  async #reportAnomaly(job: UnknownQueryJob, decision: { readonly anomaly?: QueryAnomaly }): Promise<void> {
    if (decision.anomaly === undefined || job.anomalyLogged) return;
    let marked: boolean;
    try {
      marked = await this.deps.queries.markAnomalyLogged(job);
    } catch (err) {
      this.#runError('anomaly', err, job.orderId);
      return;
    }
    if (!marked) return;
    const e = { orderId: job.orderId };
    if (decision.anomaly === 'amount') this.#safe(() => this.deps.log.amountMismatch(e));
    else if (decision.anomaly === 'order') this.#safe(() => this.deps.log.orderMismatch(e));
    else this.#safe(() => this.deps.log.cancelledAtPg(e));
  }

  /** 어댑터가 없다: 지표를 세고 파드당 1분에 경고 한 줄 */
  #noAdapter(job: UnknownQueryJob): UnknownRunOutcome {
    const now = this.deps.clock.now();
    if (this.#lastNoAdapterWarnMs === undefined || now - this.#lastNoAdapterWarnMs >= UNKNOWN_NO_ADAPTER_WARN_INTERVAL_MS) {
      this.#lastNoAdapterWarnMs = now;
      this.#safe(() => this.deps.log.noAdapter({ pg: job.pg }));
    }
    return this.#askedAgain(job, 'no_adapter');
  }

  #askedAgain(job: UnknownQueryJob, outcome: PaymentUnknownQueryOutcome): UnknownRunOutcome {
    this.#outcome(job, outcome);
    return { kind: 'ASKED_AGAIN', outcome };
  }

  /** 답 반영(원장·사건·Outbox 한 트랜잭션). 던지면 다시 하지 않고 밀어 둔 간격 뒤의 조회에 맡긴다 */
  async #resolve(job: UnknownQueryJob, decision: Extract<QueryDecision, { kind: 'RESOLVE' }>, va: ConfirmVirtualAccount | undefined): Promise<UnknownRunOutcome> {
    try {
      const result = await this.deps.queries.resolve(job, await this.#withDeposit(job, decision.finish, va));
      if (result === 'STALE') {
        this.#safe(() => this.deps.log.staleAnswer({ orderId: job.orderId }));
        return STALE;
      }
      this.#outcome(job, decision.outcome);
      // 결제 확정 소요: 승인이 UNKNOWN을 지나 결과가 정해진 때만 잰다(입금 대기 등은 승인 확정 소요가 아니다). UNKNOWN을 거친 건은 늘 retry_queue다(다시 연 직후 재정지 방지, ADR-0105 결정 5·6, BUILD_ORDER PRF-200 코드 리뷰)
      if (job.deposit === undefined && job.lateDepositCheck !== true && job.reversalCheck === undefined && job.acceptedAtMs !== undefined) {
        const seconds = Math.max(0, (this.deps.clock.now() - job.acceptedAtMs) / 1000);
        this.#safe(() => this.deps.resolution?.resolutionSeconds(job.pg, 'retry_queue', seconds));
      }
      return { kind: 'RESOLVED', status: decision.finish.status, outcome: decision.outcome };
    } catch (err) {
      this.#safe(() => this.deps.signals.writeFailure());
      this.#safe(() => this.deps.log.writeFailed({ orderId: job.orderId, code: safeErrorCode(err) }));
      return WRITE_FAILED;
    }
  }

  /** 입금 대기 결과(T14)에 가상계좌 칸을 붙인다(트랜잭션에 들어가기 전에 암호화한다, BUILD_ORDER HOT-151). 던지지 않는다 */
  async #withDeposit(job: UnknownQueryJob, finish: ResolvedFinish, va: ConfirmVirtualAccount | undefined): Promise<ResolvedFinish> {
    if (finish.status !== 'AWAITING_DEPOSIT' || this.deps.deposit === undefined) return finish;
    const deposit = await depositWriteOf(this.deps.deposit, { paymentId: job.paymentId, orderId: job.orderId }, va, job.entryOpensAtMs);
    return deposit === undefined ? finish : { ...finish, deposit };
  }

  #outcome(job: UnknownQueryJob, outcome: PaymentUnknownQueryOutcome): void {
    this.#safe(() => this.deps.signals.outcome(job.pg, outcome));
  }

  #runError(what: 'claim' | 'gateway' | 'call' | 'anomaly' | 'reschedule' | 'overdue', err: unknown, orderId?: string): void {
    this.#safe(() => this.deps.log.runError(orderId === undefined ? { what, err } : { what, orderId, err }));
  }

  /** stop·whenIdle이 기다릴 일로 적고, 끝나면 뺀다 */
  #track(p: Promise<unknown>): void {
    const tracked: Promise<void> = p.then(noop, noop).finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
  }

  /** 로그·지표는 던지지 않기로 했지만, 던져도 실행기를 막지 않는다 */
  #safe(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

const noop = (): undefined => undefined;
const NOTHING: UnknownTickResult = Object.freeze({ claimed: 0 });
const NOTHING_SWEPT: UnknownSweepResult = Object.freeze({ marked: 0 });
const STOPPED: UnknownRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'STOPPED' });
const NO_TOKEN: UnknownRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'NO_TOKEN' });
const CIRCUIT_SKIPPED: UnknownRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
/** #query가 돌려주는 '서킷이 끊어 부르지 않음' 표시 */
const CIRCUIT_OPEN = Symbol('circuit-open');
const STALE: UnknownRunOutcome = Object.freeze({ kind: 'STALE' });
const WRITE_FAILED: UnknownRunOutcome = Object.freeze({ kind: 'WRITE_FAILED' });
const REVERSED: UnknownRunOutcome = Object.freeze({ kind: 'REVERSED' });
const REVERSAL_CLOSED: UnknownRunOutcome = Object.freeze({ kind: 'REVERSAL_CLOSED' });
const REVERSAL_ENDED: UnknownRunOutcome = Object.freeze({ kind: 'REVERSAL_ENDED' });
const QUERY_UNKNOWN: QueryResult = Object.freeze({ kind: 'UNKNOWN' });

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: UnknownResolverTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
