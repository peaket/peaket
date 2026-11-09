// 승인 실행기(docs/features/payment.md §2 '승인 실행기의 첫 구현', docs/data.md §5 '승인 실행기', BUILD_ORDER PRF-181,
// 명세 specs/payment.qnt `send`·`expireCommand`·`respond`·`timeout`·`restart`). purchase-svc OrderSagaRunner·TicketIssueRunner와 같은 꼴이다.
// 모든 API 파드가 100ms [가정]마다 결제사 채널별 여유(벌크헤드 빈자리와 토큰 수 가운데 작은 쪽, BUILD_ORDER PRF-183)만큼 승인 명령을 짧은 트랜잭션으로 잡고(claimDue, 임대 75초 [가정]) 커밋한 뒤 잠금 밖에서 결제사를 부른다. 재시도 큐는 payment_confirm_job 표 자체다.
// 틱은 잡기까지만 기다리고 호출을 기다리지 않는다(승인 호출은 60초 [가정]까지 걸려, 기다리면 빈자리가 있어도 다음 틱이 돌지 못한다).
// 행 하나의 차례(confirmGateOf):
//   ① 원장 읽기. ACCEPTED가 아니면 명령 행만 지운다
//   ② 앞 소유자가 있었고 CONFIRM_SENT가 있으면 임대가 끊긴 잔해: 결제사를 부르지 않고 UNKNOWN(조회로 확정, PRF-182)
//   ③ 그 결제사의 어댑터가 없으면 부르지 않고 30초 [가정] 뒤로 미룬다(지표 no_adapter, 파드당 1분에 경고 한 줄)
//   ④ 승인 기한(인증 + capabilities().confirmDeadlineMs)이 지났으면, CONFIRM_SENT가 없으면 부르지 않고 FAILED(EXPIRED), 있으면 UNKNOWN
//   ⑤ 틱이 잡기 전에 미리 뺀 토큰을 쓴다(바로 돌리는 runJob은 여기서 하나 쓰고, 못 얻으면 임대를 놓고 다음 틱으로). markSent로 임대를 확인한다. CONFIRM_SENT가 없으면 표시를 쓰고 커밋한 뒤에 부르고, 있으면(ALREADY) 표시를 더하지 않고 같은 멱등키로 다시 보낸다
//   ⑥ gateway.confirm(주문 ID·결제 참조·원장 금액·confirm-{주문 ID}, 실행기 한도 72초 [가정]). 어댑터가 던지거나 한도를 넘기면 UNKNOWN(결과를 가정하지 않는다). 부르지 않고 끝난 행의 토큰은 돌려준다
//   ⑦ 답 → decideConfirmAnswer(재전송 여부 포함) → 끝난 답은 finish(한 트랜잭션), IN_PROGRESS·THROTTLED는 reschedule(지금 + confirmRetryDelayMs(attempts + 1), 재전송 횟수를 올린다)
//   ⑧ finish가 던지면 100ms·400ms [가정] 뒤 두 번 다시 하고, 그래도 안 되면 행을 그대로 둔다(임대가 끝나면 ②가 UNKNOWN으로 맞춘다)
// 틱·호출은 실행기를 만든 때(시작 파일, 요청 밖)의 비동기 맥락에서 돈다(OrderSagaRunner와 같은 까닭). 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
// 시험 재개의 첫 승인 호출(BUILD_ORDER PRF-202): 정지 캐시가 TRIAL인 결제사의 첫 승인 호출(재전송·재시도 큐 건 제외)은 시작 시각을 호출 전에, 결과를 원장 확정 뒤에 payment_entry_trial에 쓴다. 쓰기 실패는 흐름을 바꾸지 않는다.
// 구현에서 정한 것(정본·설계에 없다):
// - 어댑터 없음을 승인 기한보다 먼저 본다(기한은 어댑터 capabilities에서 받는다).
// - 멈춘 뒤에는 새로 잡지 않고, 잡았지만 부르지 않은 행은 임대를 놓는다. stop은 돌던 호출과 그 뒤 쓰기를 기다린다. 종료 유예를 넘겨 프로세스가 끝나면 임대가 끝난 뒤 ②가 UNKNOWN으로 맞춘다.
// - 앞 소유자가 있던 행은 멈출 때 임대를 놓지 않는다(놓으면 lease_owner가 비어 다음 잡기가 잔해로 알아보지 못하고 결제사를 다시 부른다). 임대가 끝나면 다음 잡기가 ②로 본다.
// - 표시를 쓴 뒤 호출 바로 앞에서도 멈췄는지 본다(아직 보내지 않았으므로 임대를 놓아도 다음 실행기가 같은 멱등키로 보낸다).
// - 어댑터가 THROTTLED로 거절해도 지표는 in_progress다(설계의 outcome 값에 throttled가 없고, 429는 pg_throttled_total이 센다).
// - 첫 호출 429로 상한을 낮추는 판단은 그 명령의 첫 승인 호출(재전송이 아닌 호출)에서만 한다(BUILD_ORDER PRF-183).
// - 어댑터가 없는 채널은 1초 [가정]에 한 번, 채널마다 동시 8건 [가정]까지만 잡는다(운영에는 그런 행이 없어 틱마다 묻지 않는다, BUILD_ORDER PRF-183).
// - 원장을 읽지 못하거나 어댑터의 능력을 받지 못하면(capabilities가 던짐) 부르지 않고 SKIPPED READ_FAILED다. 앞 소유자가 없던 행은 임대를 놓고(남기면 다음 잡기가 잔해로 본다), 앞 소유자가 있던 행은 그대로 둔다. 원장 행이 없으면(외래 키가 있어 나오지 않는다) 오류 한 줄 뒤 명령 행을 지운다.
// - 금액 어긋남의 SEV1 로그는 답을 판단한 때 남긴다(쓰기가 실패해도 어긋남 자체는 알려야 한다).
// - 다시 하기는 finish만 한다. 표시·미루기·지우기는 한 번만 하고, 실패하면 행을 그대로 둔다(임대가 끝나면 다시 잡힌다).
// - 틱은 잡기 전에 벌크헤드 빈자리와 토큰을 먼저 쥔다(겹쳐 부른 틱이 상한을 넘겨 잡지 않게, TicketIssueRunner와 같다). 잡은 수만큼 남기고 나머지는 돌려준다(BUILD_ORDER PRF-183 코드 리뷰).
// - 틱은 채널마다 독립이다(한 채널의 느린 잡기가 다른 채널의 틱을 막지 않게 채널별로 진행 중을 표시하고, 그 채널의 앞 잡기가 돌면 이번 틱을 건너뛴다).
// - 기한 지난 행은 벌크헤드·토큰과 상관없이 채널당 50건 [가정]까지 따로 잡아 부르지 않고 끝낸다(여유가 없어도 끝나지 않고 쌓이지 않게). 그 행이 어쩌다 호출 갈래로 가도 보호기 없이는 부르지 않고 임대를 놓는다.
// - 여유가 0인 틱은 표에 기다리는 행이 있을 때만 상한에 막힌 것으로 센다(표 없는 틱에서 지표가 오르지 않게).
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import {
  CONFIRM_CALL_GUARD_MS,
  CONFIRM_EXPIRED_BATCH,
  CONFIRM_FINISH_RETRY_DELAYS_MS,
  CONFIRM_LEASE_MS,
  CONFIRM_NO_ADAPTER_CLAIM_INTERVAL_MS,
  CONFIRM_NO_ADAPTER_CONCURRENCY,
  CONFIRM_NO_ADAPTER_DELAY_MS,
  CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS,
  CONFIRM_PG_ERROR_LOG_INTERVAL_MS,
  CONFIRM_RUNNER_POLL_INTERVAL_MS,
  type ConfirmFinish,
  confirmGateOf,
  type ConfirmJob,
  confirmRetryDelayMs,
  type ConfirmRunOutcome,
  type ConfirmTarget,
  decideConfirmAnswer,
  type PaymentConfirmOutcome,
} from '../domain/confirm-runner.js';
import { firstResultOf, isEntryTrialConclusion } from '../domain/entry-pause-judge.js';
import { confirmIdemKey, type ConfirmCard, type ConfirmResult, type ConfirmVirtualAccount, type PaymentGatewayPort, type PgName } from '../domain/payment-gateway.js';
import { type PaymentMethodLink, paymentMethodLinkOf } from '../domain/payment-method-ref.js';
import { PG_NAMES, type PgCallGuard, type PgCallGuards } from '../domain/pg-call-guard.js';
import { isConfirmOutage, PG_CIRCUIT_DEFER_MS, PgCircuitOpenError } from '../domain/pg-circuit.js';
import type { EntryPauseReader, EntryTrialResults, EntryTrialSignals, MarkConfirmSentResult, PaymentConfirmJobs, PaymentConfirmLog, PaymentConfirmSignals, PaymentGateways, PaymentMethodRefSignals, PaymentMethodRefs, PaymentResolutionSignals } from '../domain/ports.js';
import { safeErrorCode } from '../../../safe-error-code.js';
import { depositWriteOf, type DepositWriteDeps } from './deposit-write.js';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval·clearInterval) */
export interface ConfirmRunnerTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 실행기가 쓰는 포트와 설정 */
export interface PaymentConfirmRunnerDeps {
  jobs: PaymentConfirmJobs;
  gateways: PaymentGateways;
  log: PaymentConfirmLog;
  signals: PaymentConfirmSignals;
  clock: Clock;
  /** lease_owner에 적는 값(파드 이름) */
  podId: string;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: ConfirmRunnerTimer;
  /** 잡기 주기(기본 CONFIRM_RUNNER_POLL_INTERVAL_MS 100ms [가정]) */
  pollIntervalMs?: number;
  /** 채널별 호출 보호기(단독 조회 실행기와 같은 것을 넘긴다) */
  guards: PgCallGuards;
  /** 임대 길이(기본 CONFIRM_LEASE_MS 75초 [가정]) */
  leaseMs?: number;
  /** ms만큼 쉰다(답 반영 다시 하기 사이). 없으면 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 실행기가 승인 호출을 감싸는 한도(기본 CONFIRM_CALL_GUARD_MS 72초 [가정]) */
  confirmGuardMs?: number;
  /** 결제 수단 연결값(라벨 키 pay, BUILD_ORDER HOT-145). 없으면 카드 결제는 refMissing 참이다 */
  methodRefs?: PaymentMethodRefs;
  methodRefSignals?: PaymentMethodRefSignals;
  /** 입금 대기 쓰기의 포트(BUILD_ORDER HOT-151). 없으면 발급 정보를 쓰지 않는다 */
  deposit?: DepositWriteDeps;
  /** 결제 확정 소요 지표(BUILD_ORDER PRF-200). 없으면 재지 않는다 */
  resolution?: PaymentResolutionSignals;
  /** 시험 재개의 첫 승인 호출 시작 시각과 결과 쓰기(BUILD_ORDER PRF-202). 없으면 쓰지 않는다 */
  trialResults?: EntryTrialResults;
  /** 정지 행(파드 캐시). TRIAL이 아니면 시험 행 문장을 내지 않는다(BUILD_ORDER PRF-202) */
  pauses?: EntryPauseReader;
  trialSignals?: EntryTrialSignals;
}

/** 틱 하나의 결과 */
export interface ConfirmTickResult {
  /** 잡은 행 수(부르기 시작한 수이고, 끝난 수가 아니다) */
  readonly claimed: number;
}

/** 이 행 몫으로 미리 뺀 토큰. 호출 직전에 false가 되고, 끝날 때 true로 남아 있으면 돌려준다 */
interface TokenHold {
  held: boolean;
}

/** 실행기 한도를 넘긴 승인 호출(어댑터가 시간 한도를 지키지 않았다) */
class ConfirmCallGuardTimeout extends Error {
  constructor() {
    super('승인 호출이 실행기 한도를 넘겼다');
    this.name = 'ConfirmCallGuardTimeout';
  }
}

/**
 * 승인 실행기. start()로 100ms 반복을 켜고 stop()으로 끈다(돌던 호출과 그 뒤 쓰기를 기다린다).
 * 같은 행을 두 파드가 잡지 않는다(SKIP LOCKED·임대). 겹치면 payment 행 잠금과 status = 'ACCEPTED' 조건이 하나만 쓰게 한다.
 */
export class PaymentConfirmRunner {
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  #stopped = false;
  /** 잡기가 도는 채널(겹치지 않게 채널마다 하나만, 한 채널이 느려도 다른 채널의 틱은 돈다) */
  readonly #claiming = new Set<PgName>();
  /** 돌고 있는 틱의 잡기와 행(stop·whenIdle이 기다린다) */
  readonly #inflight = new Set<Promise<void>>();
  /** 어댑터가 없는 채널마다 쥔 자리 수(미루기까지, 잡기 전에 미리 쥔 것 포함) */
  readonly #noAdapterHeld = new Map<PgName, number>();
  /** 채널마다 돌고 있는 기한 지난 행 수(끝내기까지, 잡기 전에 미리 센 것 포함) */
  readonly #expiredHeld = new Map<PgName, number>();
  /** 어댑터가 없는 채널을 마지막으로 잡은 단조 시각 */
  #noAdapterClaimedAtMs: number | undefined;
  /** 지금 돌고 있는 결제사 호출 수(지표) */
  #calls = 0;
  /** 마지막으로 어댑터 없음 경고를 낸 시각(epoch ms) */
  #lastNoAdapterWarnMs: number | undefined;
  /** 채널마다 마지막으로 결제사 오류 로그를 낸 시각(epoch ms) */
  readonly #lastPgErrorLogMs = new Map<PgName, number>();
  /** 만든 때(시작 파일, 요청 밖)의 비동기 맥락. 틱·호출이 이 맥락에서 돈다(끝난 요청의 남은 시간을 물려받지 않게) */
  readonly #scope = new AsyncResource('PaymentConfirmRunner');

  constructor(readonly deps: PaymentConfirmRunnerDeps) {}

  /** 반복을 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다). 앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다 */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#loopTick(), this.deps.pollIntervalMs ?? CONFIRM_RUNNER_POLL_INTERVAL_MS);
  }

  /** 반복을 끄고 돌던 행(호출과 그 뒤 쓰기)을 기다린다. 멈춘 뒤의 틱·start는 아무것도 하지 않는다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.whenIdle();
  }

  /**
   * 틱 하나: 빈자리가 있으면 그만큼 claimDue로 잡고, 잡은 행을 시작만 시키고 돌아온다(호출을 기다리지 않는다). 돌던 행은 whenIdle·stop이 기다린다.
   * 빈자리가 0이거나 멈춘 뒤면 잡지 않고 claimed 0이다. 던지지 않는다(잡기 실패는 log.runError(what claim) 뒤 0)
   */
  async tick(): Promise<ConfirmTickResult> {
    if (this.#stopped) return NOTHING;
    const p = this.#scope.runInAsyncScope(() => this.#tickOnce());
    this.#track(p);
    return p;
  }

  /** 지금 돌고 있는 행이 모두 끝나면 풀린다(시험과 stop이 쓴다) */
  async whenIdle(): Promise<void> {
    // 틱이 끝나며 행을 더 시작할 수 있어 비어 있을 때까지 다시 본다
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /**
   * 잡은 행 하나를 돈다(머리 주석의 차례). 던지지 않는다. 호출·쓰기가 실패하면 해당 ConfirmRunOutcome을 돌려준다.
   * 빈자리를 쥐고 돌며(동시 상한), 멈춘 뒤면 부르지 않고 임대를 놓아 SKIPPED RELEASED다.
   * 지표: 끝난 행마다 outcome 하나(FINISHED·RETRY 갈래). STALE·SKIPPED·DROPPED·WRITE_FAILED는 outcome을 세지 않는다(WRITE_FAILED는 writeFailure를 센다)
   */
  async runJob(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    const guard = this.#guardOf(job.pg);
    guard?.holdOne();
    return this.#startHeld(job, guard, { held: false });
  }

  // ---- 안쪽 ----

  #timer(): ConfirmRunnerTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  /** 반복 타이머의 틱: 잡기가 도는 채널은 그 틱 안에서 건너뛴다. 멈춘 뒤에는 돌지 않는다 */
  #loopTick(): void {
    if (this.#stopped) return;
    void this.tick();
  }

  /** 채널마다 여유만큼 잡는다(어댑터가 있는 채널은 틱마다, 없는 채널은 1초 [가정]에 한 번). 앞 잡기가 도는 채널은 건너뛴다. 잡은 행은 호출을 기다리지 않고 시작만 시킨다 */
  async #tickOnce(): Promise<ConfirmTickResult> {
    const adapted: Promise<number>[] = [];
    const bare: PgName[] = [];
    for (const pg of PG_NAMES) {
      try {
        const guard = this.deps.guards.of(pg);
        if (guard === undefined) bare.push(pg);
        else adapted.push(this.#turn(pg, () => this.#claimAdapted(pg, guard)));
      } catch (err) {
        // 어댑터 결함: 그 채널만 건너뛴다(명령은 표에서 기다린다)
        this.#runError('claim', err);
      }
    }
    const counts = await Promise.all([...adapted, ...this.#claimBareTurn(bare)]);
    const claimed = counts.reduce((a, b) => a + b, 0);
    return claimed === 0 ? NOTHING : { claimed };
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

  /** 어댑터가 있는 채널 하나: 호출할 명령과 기한 지난 명령을 함께 잡는다 */
  async #claimAdapted(pg: PgName, guard: PgCallGuard): Promise<number> {
    const [called, expired] = await Promise.all([this.#claimChannel(pg, guard), this.#claimExpired(pg)]);
    return called + expired;
  }

  /** 호출할 명령: 여유만큼 자리와 토큰을 쥐고, 잡은 수만큼 남기고 나머지는 돌려준다. 여유가 0이면 기다리는 행이 있을 때만 막힌 것으로 센다 */
  async #claimChannel(pg: PgName, guard: PgCallGuard): Promise<number> {
    const reserved = guard.reserve();
    if (reserved === 0) {
      await this.#noteBlockedIfWaiting(pg, guard);
      return 0;
    }
    let jobs: ConfirmJob[] = [];
    try {
      jobs = await this.deps.jobs.claimDue(pg, reserved, this.deps.podId, this.deps.leaseMs ?? CONFIRM_LEASE_MS);
    } catch (err) {
      this.#runError('claim', err);
    }
    const unused = Math.max(0, reserved - jobs.length);
    guard.release(unused);
    guard.refundConfirmTokens(unused);
    for (const job of jobs) void this.#startHeld(job, guard, { held: true });
    return jobs.length;
  }

  /** 기다리는 행이 있을 때만 상한에 막힌 것으로 센다. 확인이 실패하면 세지 않는다 */
  async #noteBlockedIfWaiting(pg: PgName, guard: PgCallGuard): Promise<void> {
    // 서킷 때문이면 어차피 세지 않으므로 틱마다 표를 묻지 않는다(코드 리뷰)
    if (!guard.circuitClosed()) return;
    try {
      if (await this.deps.jobs.hasDue(pg)) guard.noteBlocked();
    } catch (err) {
      this.#runError('claim', err);
    }
  }

  /** 기한 지난 명령: 벌크헤드·토큰과 상관없이 채널당 동시 50건 [가정]까지 잡아 부르지 않고 끝낸다 */
  async #claimExpired(pg: PgName): Promise<number> {
    const reserved = Math.max(0, CONFIRM_EXPIRED_BATCH - (this.#expiredHeld.get(pg) ?? 0));
    if (reserved === 0) return 0;
    const deadlineMs = this.#deadlineOf(pg);
    if (deadlineMs === undefined) return 0;
    const leaseMs = this.deps.leaseMs ?? CONFIRM_LEASE_MS;
    return this.#claimUnguarded(pg, reserved, this.#expiredHeld, () => this.deps.jobs.claimExpired(pg, reserved, this.deps.podId, leaseMs, deadlineMs));
  }

  /** 그 채널의 승인 기한(ms). 어댑터가 없거나 능력을 받지 못하면 undefined다 */
  #deadlineOf(pg: PgName): number | undefined {
    try {
      return this.deps.gateways.of(pg)?.capabilities().confirmDeadlineMs;
    } catch (err) {
      this.#runError('claim', err);
      return undefined;
    }
  }

  /** 어댑터가 없는 채널들: 1초 [가정]에 한 번, 채널마다 동시 8건 [가정]까지. 운영에는 그런 행이 없어 틱마다 묻지 않는다 */
  #claimBareTurn(bare: readonly PgName[]): Promise<number>[] {
    if (bare.length === 0) return [];
    const now = this.deps.clock.monotonicMs();
    if (this.#noAdapterClaimedAtMs !== undefined && now - this.#noAdapterClaimedAtMs < CONFIRM_NO_ADAPTER_CLAIM_INTERVAL_MS) return [];
    this.#noAdapterClaimedAtMs = now;
    return bare.map((pg) => this.#turn(pg, () => this.#claimBare(pg)));
  }

  #claimBare(pg: PgName): Promise<number> {
    const reserved = Math.max(0, CONFIRM_NO_ADAPTER_CONCURRENCY - (this.#noAdapterHeld.get(pg) ?? 0));
    if (reserved === 0) return Promise.resolve(0);
    return this.#claimUnguarded(pg, reserved, this.#noAdapterHeld, () => this.deps.jobs.claimDue(pg, reserved, this.deps.podId, this.deps.leaseMs ?? CONFIRM_LEASE_MS));
  }

  /** 보호기의 자리·토큰 없이 도는 잡기(부르지 않는 행). held에 미리 세고 잡은 수만큼 남겨 행이 끝날 때 뺀다 */
  async #claimUnguarded(pg: PgName, reserved: number, held: Map<PgName, number>, claim: () => Promise<ConfirmJob[]>): Promise<number> {
    this.#addHeld(held, pg, reserved);
    let jobs: ConfirmJob[] = [];
    try {
      jobs = await claim();
    } catch (err) {
      this.#runError('claim', err);
    }
    this.#addHeld(held, pg, -Math.max(0, reserved - jobs.length));
    for (const job of jobs) {
      const p = this.#scope.runInAsyncScope(() => this.#run(job, undefined, { held: false }).finally(() => this.#addHeld(held, pg, -1)));
      this.#track(p);
    }
    return jobs.length;
  }

  #addHeld(held: Map<PgName, number>, pg: PgName, delta: number): void {
    held.set(pg, (held.get(pg) ?? 0) + delta);
  }

  /** 그 채널의 보호기. 어댑터가 없거나 만들지 못하면 undefined(이어지는 #run이 같은 까닭을 다룬다) */
  #guardOf(pg: PgName): PgCallGuard | undefined {
    try {
      return this.deps.guards.of(pg);
    } catch {
      return undefined;
    }
  }

  /** 자리를 이미 쥔 행을 시작한다(stop·whenIdle이 기다리게 적는다) */
  #startHeld(job: ConfirmJob, guard: PgCallGuard | undefined, hold: TokenHold): Promise<ConfirmRunOutcome> {
    const p = this.#scope.runInAsyncScope(() => this.#runHeld(job, guard, hold));
    this.#track(p);
    return p;
  }

  /** 자리를 쥔 채 행 하나를 돈다. 끝나면(어느 갈래든) 쓰지 않은 토큰을 돌려주고 자리를 놓는다 */
  async #runHeld(job: ConfirmJob, guard: PgCallGuard | undefined, hold: TokenHold): Promise<ConfirmRunOutcome> {
    try {
      return await this.#run(job, guard, hold);
    } finally {
      if (hold.held) guard?.refundConfirmTokens();
      guard?.release();
    }
  }

  async #run(job: ConfirmJob, guard: PgCallGuard | undefined, hold: TokenHold): Promise<ConfirmRunOutcome> {
    if (this.#stopped) return this.#letGo(job);
    let target: ConfirmTarget | undefined;
    let gateway: PaymentGatewayPort | undefined;
    let deadlineMs: number | undefined;
    try {
      target = await this.deps.jobs.read(job.paymentId);
      if (target !== undefined) {
        gateway = this.deps.gateways.of(target.pg);
        deadlineMs = gateway?.capabilities().confirmDeadlineMs;
      }
    } catch (err) {
      this.#runError('read', err);
      await this.#letGo(job);
      return READ_FAILED;
    }
    if (target === undefined) {
      this.#runError('read', new Error('승인 명령의 원장 행이 없다'));
      return this.#drop(job, undefined);
    }
    if (this.#stopped) return this.#letGo(job);

    const gate = confirmGateOf(target, job, deadlineMs, this.deps.clock.now());
    switch (gate.kind) {
      case 'DROP_JOB':
        return this.#drop(job, target);
      case 'UNKNOWN':
        return this.#finish(job, target, { status: 'UNKNOWN', result: 'UNKNOWN' }, gate.cause === 'restart' ? 'restart' : 'unknown');
      case 'NO_ADAPTER':
        return this.#noAdapter(job, target);
      case 'EXPIRE':
        return this.#finish(job, target, { status: 'FAILED', failureCategory: 'EXPIRED' }, 'expired');
      case 'SEND':
        return this.#send(job, target, gateway!, guard, gate.markFirst, hold);
    }
  }

  /** 토큰 → 표시·임대 확인 → 호출 → 답 반영 */
  async #send(job: ConfirmJob, target: ConfirmTarget, gateway: PaymentGatewayPort, guard: PgCallGuard | undefined, markFirst: boolean, hold: TokenHold): Promise<ConfirmRunOutcome> {
    // 표시를 쓰기 전에 토큰을 얻는다(먼저 쓰면 부르지 않았는데 다음 시도가 재전송이 된다). 보호기가 없으면 상한 없이 부르지 않는다. 틱이 잡은 행은 토큰을 미리 뺐다
    if (guard === undefined || (!hold.held && !guard.tryTakeConfirmTokens())) return this.#noToken(job);
    hold.held = true;
    // 서킷이 닫혀 있지 않으면 표시를 쓰기 전에 미룬다(부르지 않았으므로 UNKNOWN으로 쓰지 않는다. 표시가 있는 재전송도 같다, 반 열림의 시험 호출은 단독 조회다, 토큰·자리는 #runHeld가 돌려준다, BUILD_ORDER PRF-200)
    if (!guard.circuitClosed()) return this.#circuitOpen(job, target);
    let mark: MarkConfirmSentResult;
    try {
      mark = await this.deps.jobs.markSent(job);
    } catch (err) {
      // 표시 없이 보낸 호출은 재시작 때 가려낼 수 없고, 재전송은 임대를 확인하지 못했으므로 부르지 않는다
      return this.#writeFailed(target, 'mark', err);
    }
    if (mark === 'LEASE_LOST') return LEASE_LOST;
    if (mark === 'STALE') return this.#drop(job, target);
    if (this.#stopped) return this.#letGo(job);
    // 읽은 뒤 다른 실행이 표시를 썼으면(ALREADY) 앞선 요청이 있는 것이라 재전송으로 본다
    const resend = !markFirst || mark === 'ALREADY';
    // 시험 재개는 첫 승인 호출만 본다: 재전송과 재시도 큐 건은 쓰지 않는다(BUILD_ORDER PRF-202)
    const trialCall = !resend && job.queued !== true;
    if (trialCall) await this.#noteTrialCall(target);

    hold.held = false;
    const startedMs = this.deps.clock.monotonicMs();
    this.#calls += 1;
    this.#safe(() => this.deps.signals.inFlight(this.#calls));
    guard.callStarted();
    let answer: ConfirmResult | undefined;
    let failure: { err: unknown } | undefined;
    let notCalled = false;
    try {
      answer = await guard.run(
        () =>
          this.#guarded(
            gateway.confirm({ orderId: target.orderId, paymentRef: target.paymentRef, amount: target.amount, idemKey: confirmIdemKey(target.orderId), ...(target.confirmToken === undefined ? {} : { confirmToken: target.confirmToken }), ...(target.txId === undefined ? {} : { txId: target.txId }) }),
          ),
        isConfirmOutage,
        'confirm',
      );
    } catch (err) {
      // 서킷이 끊어 부르지 않았다(판단과 호출 사이에 열렸다): 결과를 가정하지 않고 미룬다
      if (err instanceof PgCircuitOpenError) notCalled = true;
      else failure = { err };
    } finally {
      this.#calls -= 1;
      this.#safe(() => this.deps.signals.inFlight(this.#calls));
      guard.callFinished();
    }
    if (notCalled) {
      hold.held = true;
      // 이번에 쓴 표시는 같은 임대 조건으로 함께 지운다(남기면 부른 적 없는 다음 호출이 재전송으로 판정된다, 코드 리뷰)
      return this.#circuitOpen(job, target, mark === 'MARKED');
    }
    // 429: 첫 승인 호출만 상한을 낮춘다(낮추기 전에 나간 호출의 429는 옛 상한의 결과라 보지 않는다). 다시 보낸 호출은 그 호출의 다음 시도만 늦춘다(아래 RETRY)
    if (answer?.outcome === 'DECLINED' && answer.failureCategory === 'THROTTLED') guard.noteThrottled({ first: !resend, startedAtMs: startedMs });
    if (answer?.outcome === 'DECLINED') this.#noteDeclined(target.pg, answer);
    const latencyMs = Math.max(0, Math.round(this.deps.clock.monotonicMs() - startedMs));
    this.#safe(() => this.deps.signals.callSeconds(target.pg, latencyMs / 1000));

    const settled = await this.#settle(job, target, answer, failure, latencyMs, resend);
    // 원장을 확정한 뒤에 쓴다(시험 행 쓰기가 늦어도 승인 확정을 늦추지 않는다, BUILD_ORDER PRF-202 코드 리뷰)
    if (trialCall) await this.#noteTrialResult(target, answer, latencyMs);
    return settled;
  }

  /** 호출의 답을 원장·재시도에 반영한다 */
  async #settle(job: ConfirmJob, target: ConfirmTarget, answer: ConfirmResult | undefined, failure: { err: unknown } | undefined, latencyMs: number, resend: boolean): Promise<ConfirmRunOutcome> {
    if (failure !== undefined || answer === undefined) {
      // 읽기 시간 초과·연결 실패 등: 결과를 가정하지 않는다
      this.#runError('call', failure?.err, target.orderId);
      return this.#finish(job, target, { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs }, 'unknown');
    }
    const { card } = answer;
    const decision = decideConfirmAnswer(answer, target.amount, this.deps.clock.now(), latencyMs, resend, () => this.#linkOf(card));
    if (decision.kind === 'RETRY') return this.#reschedule(job, target, decision.outcome, this.deps.clock.now() + confirmRetryDelayMs(job.attempts + 1));
    if (decision.amountMismatch) this.#safe(() => this.deps.log.amountMismatch({ orderId: target.orderId }));
    return this.#finish(job, target, await this.#withDeposit(target, decision.finish, answer.virtualAccount), decision.outcome);
  }

  /** 이 파드의 정지 캐시가 그 결제사를 TRIAL로 보는가. 캐시를 오래 기다리지 않는다(시한이 끝나면 쓸 수 있는 마지막 값을 쓴다) */
  async #inTrial(pg: PgName, pauses: EntryPauseReader): Promise<boolean> {
    return (await pauses.read(TRIAL_PAUSE_READ_BUDGET)).get(pg)?.stage === 'TRIAL';
  }

  /**
   * 첫 승인 호출을 시작한 시각을 시험 재개 행에 쓴다(판정자가 호출 시작 순으로 센다, BUILD_ORDER PRF-202 코드 리뷰). 실패해도 호출은 그대로 나가고 지표만 오른다. 던지지 않는다.
   * 판단과 호출 사이에 서킷이 끊으면 시작 시각만 남아 5초 [가정] 뒤 실패로 세인다(서킷이 막 열린 때라 다시 멈추는 쪽이 맞다)
   */
  async #noteTrialCall(target: ConfirmTarget): Promise<void> {
    const { trialResults, pauses, trialSignals, clock } = this.deps;
    if (trialResults === undefined || pauses === undefined) return;
    try {
      if (await this.#inTrial(target.pg, pauses)) await trialResults.recordFirstCall(target.orderId, clock.now());
    } catch {
      this.#safe(() => trialSignals?.trialWriteFailed('call'));
    }
  }

  /**
   * 첫 승인 호출의 결과를 시험 재개 행에 쓴다(BUILD_ORDER PRF-202). 이 파드의 정지 캐시가 그 결제사를 TRIAL로 볼 때만 문장을 낸다(평상시 핫패스에 문장을 더하지 않는다).
   * 시험 행이 없는 주문이면 0행이고 지표를 세지 않는다. 실패해도 승인 흐름을 바꾸지 않는다. 던지지 않는다
   */
  async #noteTrialResult(target: ConfirmTarget, answer: ConfirmResult | undefined, callMs: number): Promise<void> {
    const { trialResults, pauses, trialSignals, clock } = this.deps;
    if (trialResults === undefined || pauses === undefined) return;
    const firstResult = firstResultOf(answer);
    try {
      if (!(await this.#inTrial(target.pg, pauses))) return;
      if (!(await trialResults.recordFirstResult(target.orderId, { firstResult, atMs: clock.now(), callMs }))) return;
    } catch {
      this.#safe(() => trialSignals?.trialWriteFailed('result'));
      return;
    }
    this.#safe(() => trialSignals?.trial(target.pg, isEntryTrialConclusion({ firstResult, firstCallMs: callMs }) ? 'success' : 'failure'));
  }

  /** 서킷이 끊어 부르지 않았다: 1초 [가정] 뒤로 미룬다(UNKNOWN으로 쓰지 않는다, attempts는 그대로, 큐 표시를 적는다, BUILD_ORDER PRF-200). clearSent가 참이면 이번에 쓴 CONFIRM_SENT를 함께 지운다 */
  #circuitOpen(job: ConfirmJob, target: ConfirmTarget, clearSent = false): Promise<ConfirmRunOutcome> {
    return this.#reschedule(job, target, 'circuit_open', this.deps.clock.now() + PG_CIRCUIT_DEFER_MS, clearSent);
  }

  /** 금액 대조를 통과한 승인 답의 결제 수단 연결값(가린 번호를 넘기지 않는다. 던지지 않는다) */
  #linkOf(card: ConfirmCard | undefined): PaymentMethodLink {
    return paymentMethodLinkOf(card, this.deps.methodRefs, (reason) => this.#safe(() => this.deps.methodRefSignals?.missing(reason)));
  }

  /** 실행기 한도로 감싼다(어댑터가 한도를 지키지 않아도 자리를 영구히 쥐지 않게). 한도를 넘기면 ConfirmCallGuardTimeout으로 거절한다 */
  async #guarded(work: Promise<ConfirmResult>): Promise<ConfirmResult> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => reject(new ConfirmCallGuardTimeout()), this.deps.confirmGuardMs ?? CONFIRM_CALL_GUARD_MS);
      handle.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(handle);
    }
  }

  /** 토큰이 없다(경합): 부르지 않았으므로 임대만 놓고 다음 틱으로 넘긴다(attempts는 오르지 않는다). 놓기가 실패해도 임대가 끝나면 다시 잡힌다 */
  async #noToken(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    try {
      await this.deps.jobs.release(job);
    } catch {
      // 삼킨다
    }
    return NO_TOKEN;
  }

  /** 거절을 범주별로 세고(범주가 없으면 실행기가 쓰는 PG_ERROR로), PG_ERROR면 채널당 1분에 한 줄 결제사 코드를 남긴다(키 폐기·IP 변경 등을 찾는 단서, BUILD_ORDER PRF-184 코드 리뷰) */
  #noteDeclined(pg: PgName, answer: ConfirmResult): void {
    const category = answer.failureCategory ?? 'PG_ERROR';
    this.#safe(() => this.deps.signals.declined(pg, category));
    if (category !== 'PG_ERROR') return;
    const now = this.deps.clock.now();
    const last = this.#lastPgErrorLogMs.get(pg);
    if (last !== undefined && now - last < CONFIRM_PG_ERROR_LOG_INTERVAL_MS) return;
    this.#lastPgErrorLogMs.set(pg, now);
    this.#safe(() => this.deps.log.pgError({ pg, ...(answer.pgCode === undefined ? {} : { pgCode: answer.pgCode }) }));
  }

  /** 어댑터가 없다: 미루고 지표를 세며 파드당 1분에 경고 한 줄 */
  #noAdapter(job: ConfirmJob, target: ConfirmTarget): Promise<ConfirmRunOutcome> {
    const now = this.deps.clock.now();
    if (this.#lastNoAdapterWarnMs === undefined || now - this.#lastNoAdapterWarnMs >= CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS) {
      this.#lastNoAdapterWarnMs = now;
      this.#safe(() => this.deps.log.noAdapter({ pg: target.pg }));
    }
    return this.#reschedule(job, target, 'no_adapter', now + CONFIRM_NO_ADAPTER_DELAY_MS);
  }

  async #reschedule(job: ConfirmJob, target: ConfirmTarget, outcome: 'in_progress' | 'no_adapter' | 'circuit_open', nextAtMs: number, clearSent = false): Promise<ConfirmRunOutcome> {
    let ok: boolean;
    try {
      ok = await this.deps.jobs.reschedule(job, nextAtMs, { countRetry: outcome === 'in_progress', ...(outcome === 'circuit_open' ? { queued: true } : {}), ...(clearSent ? { clearSent: true } : {}) });
    } catch (err) {
      return this.#writeFailed(target, 'reschedule', err);
    }
    if (!ok) return LEASE_LOST;
    this.#outcome(target, outcome);
    return { kind: 'RETRY', outcome, nextAtMs };
  }

  /** 명령 행만 지운다. target이 없으면(원장 행 없음) 쓰기 실패를 로그에 남길 주문 ID가 없다 */
  async #drop(job: ConfirmJob, target: ConfirmTarget | undefined): Promise<ConfirmRunOutcome> {
    let ok: boolean;
    try {
      ok = await this.deps.jobs.dropJob(job);
    } catch (err) {
      if (target !== undefined) return this.#writeFailed(target, 'drop', err);
      this.#runError('read', err);
      this.#safe(() => this.deps.signals.writeFailure());
      return { kind: 'WRITE_FAILED', stage: 'drop' };
    }
    return ok ? DROPPED : LEASE_LOST;
  }

  /** 답 반영(원장·사건·Outbox·명령 행 지움 한 트랜잭션). 던지면 100ms·400ms 뒤 두 번 다시 한다 */
  /** 입금 대기 결과에 가상계좌 칸을 붙인다(트랜잭션에 들어가기 전에 암호화한다, BUILD_ORDER HOT-151). 던지지 않는다 */
  async #withDeposit(target: ConfirmTarget, finish: ConfirmFinish, va: ConfirmVirtualAccount | undefined): Promise<ConfirmFinish> {
    if (finish.status !== 'AWAITING_DEPOSIT' || this.deps.deposit === undefined) return finish;
    const deposit = await depositWriteOf(this.deps.deposit, { paymentId: target.paymentId, orderId: target.orderId }, va, target.entryOpensAtMs);
    return deposit === undefined ? finish : { ...finish, deposit };
  }

  async #finish(job: ConfirmJob, target: ConfirmTarget, finish: ConfirmFinish, outcome: PaymentConfirmOutcome): Promise<ConfirmRunOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.deps.jobs.finish(target, finish);
        if (result === 'STALE') {
          this.#safe(() => this.deps.log.staleAnswer({ orderId: target.orderId }));
          return STALE;
        }
        this.#outcome(target, outcome);
        // 결제 확정 소요: 결과가 정해진 전이만 잰다(UNKNOWN은 단독 조회가 정할 때 잰다, BUILD_ORDER PRF-200)
        if (finish.status !== 'UNKNOWN' && target.acceptedAtMs !== undefined) {
          const seconds = Math.max(0, (this.deps.clock.now() - target.acceptedAtMs) / 1000);
          this.#safe(() => this.deps.resolution?.resolutionSeconds(target.pg, job.queued === true ? 'retry_queue' : 'direct', seconds));
        }
        return { kind: 'FINISHED', status: finish.status, outcome };
      } catch (err) {
        const delayMs = CONFIRM_FINISH_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) return this.#writeFailed(target, 'finish', err);
        await (this.deps.sleep ?? defaultSleep)(delayMs);
      }
    }
  }

  /**
   * 멈춘 뒤라 부르지 않는다. 앞 소유자가 없던 행만 임대를 놓는다(앞 소유자가 있던 행은 다음 잡기가 잔해로 보게 그대로 둔다).
   * 놓기가 실패해도 임대가 끝나면 다시 잡힌다
   */
  async #letGo(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    if (!job.hadPreviousOwner) {
      try {
        await this.deps.jobs.release(job);
      } catch {
        // 삼킨다
      }
    }
    return RELEASED;
  }

  #writeFailed(target: ConfirmTarget, stage: 'mark' | 'finish' | 'reschedule' | 'drop', err: unknown): ConfirmRunOutcome {
    this.#safe(() => this.deps.signals.writeFailure());
    this.#safe(() => this.deps.log.writeFailed({ orderId: target.orderId, stage, code: safeErrorCode(err) }));
    return { kind: 'WRITE_FAILED', stage };
  }

  #outcome(target: ConfirmTarget, outcome: PaymentConfirmOutcome): void {
    this.#safe(() => this.deps.signals.outcome(target.pg, outcome));
  }

  #runError(what: 'claim' | 'read' | 'call', err: unknown, orderId?: string): void {
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
/** 시험 결과를 쓸지 볼 때 정지 캐시를 기다리는 시간 50ms [가정](BUILD_ORDER PRF-202) */
const TRIAL_PAUSE_READ_BUDGET = Object.freeze({ remainingMs: 50 });
const NOTHING: ConfirmTickResult = Object.freeze({ claimed: 0 });
const DROPPED: ConfirmRunOutcome = Object.freeze({ kind: 'DROPPED' });
const STALE: ConfirmRunOutcome = Object.freeze({ kind: 'STALE' });
const LEASE_LOST: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
const RELEASED: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'RELEASED' });
const READ_FAILED: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'READ_FAILED' });
const NO_TOKEN: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'NO_TOKEN' });

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: ConfirmRunnerTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
