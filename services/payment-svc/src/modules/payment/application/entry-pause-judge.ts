// 새 결제 진입 정지 판정자(docs/features/payment.md §2 '정지 판정자의 첫 구현', ADR-0105 결정 2·3·4·8, BUILD_ORDER PRF-202).
// Lease로 뽑은 파드 하나에서 1초 [가정]마다 결제사마다 따로 돈다(한 결제사의 느린 호출이 다른 결제사를 막지 않게, 앞 틱이 돌면 그 결제사만 건너뛴다).
// 행은 캐시 없이 DB에서 읽고, 쓰기는 읽은 판 번호가 그대로일 때만 한다. 영향 행이 0이면 그 틱을 버린다.
// 판단은 domain/entry-pause-judge.ts의 순수 함수가 하고, 이 파일은 입력을 모으고 확인 호출을 보내고 결과를 쓴다. 틱·호출은 실행기를 만든 때(시작 파일, 요청 밖)의 비동기 맥락에서 돈다(승인 실행기와 같은 까닭).
// 구현에서 정한 것(정본·설계에 없다):
// - 확인 호출과 입력 읽기를 함께 돌린다. 확인 호출이 기한까지 걸려도 입력 읽기가 밀리지 않게 한다.
// - 실행기 한도로 어댑터 호출을 1.5초 [가정] 감싼다(어댑터가 기한을 지키지 않아도 틱이 묶이지 않게). 넘기면 실패로 센다.
// - 서킷이 끊어 부르지 않은 호출은 창에 넣지 않는다(skipped). 확인 호출은 토큰 버킷을 거치지 않는다(파드 몫 토큰에 묶이면 표본 80% [가정]를 못 넘어 PROBING에 갇힌다, 코드 리뷰).
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import {
  channelWaitSeconds,
  classifyProbeAnswer,
  type ClusterPauseReading,
  decideEntryPause,
  ENTRY_PAUSE_JUDGE_DEFAULTS,
  ENTRY_PAUSE_WAITING_COUNT_CAP,
  type EntryPauseFacts,
  type EntryPauseJudgeConfig,
  EntryPauseProbeWindow,
  type EntryPauseRecord,
  type EntryTrialSummary,
  freshClusterReading,
  nextChannelBelowSince,
  nextPauseRecord,
  p99WindowOf,
  summarizeEntryTrial,
} from '../domain/entry-pause-judge.js';
import type { PaymentGatewayPort, PgName, QueryResult } from '../domain/payment-gateway.js';
import { PG_NAMES, type PgCallGuard, type PgCallGuards } from '../domain/pg-call-guard.js';
import { isProbeFailure, PG_CIRCUIT_PROBE_PAYMENT_REF, PG_CIRCUIT_PROBE_TIMEOUT_MS, PgCircuitOpenError } from '../domain/pg-circuit.js';
import type { EntryPauseClusterInputs, EntryPauseJudgeErrorWhat, EntryPauseJudgeLog, EntryPauseJudgeSignals, EntryPauseLeadership, EntryPauseStore, PaymentGateways } from '../domain/ports.js';

/** 실행기가 확인 호출을 감싸는 한도 1.5초 [가정](기한 1초 [가정]보다 조금 길게) */
const PROBE_GUARD_MS = 1_500;

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval·clearInterval) */
export interface EntryPauseJudgeTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface EntryPauseJudgeDeps {
  store: EntryPauseStore;
  inputs: EntryPauseClusterInputs;
  gateways: PaymentGateways;
  guards: PgCallGuards;
  leader: EntryPauseLeadership;
  /** PEAKET_PAYMENT_POD_COUNT */
  podCount: number;
  clock: Clock;
  signals: EntryPauseJudgeSignals;
  log: EntryPauseJudgeLog;
  timer?: EntryPauseJudgeTimer;
  /** 시험에서 값을 줄인다 */
  config?: Partial<EntryPauseJudgeConfig>;
}

/** 결제사마다 판정자 메모리에 두는 값 */
interface PgMemory {
  readonly window: EntryPauseProbeWindow;
  channelBelowSinceMs: number | undefined;
}

class ProbeGuardTimeout extends Error {
  constructor() {
    super('확인 호출이 실행기 한도를 넘겼다');
    this.name = 'ProbeGuardTimeout';
  }
}

export class EntryPauseJudge {
  readonly #config: EntryPauseJudgeConfig;
  readonly #memory = new Map<PgName, PgMemory>();
  /** 틱이 도는 결제사(겹치지 않게, 한 결제사가 느려도 다른 결제사는 돈다) */
  readonly #running = new Set<PgName>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #scope = new AsyncResource('EntryPauseJudge');
  #handle: unknown;
  #stopped = false;

  constructor(readonly deps: EntryPauseJudgeDeps) {
    this.#config = { ...ENTRY_PAUSE_JUDGE_DEFAULTS, ...deps.config };
  }

  /** 반복을 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다) */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => {
      if (!this.#stopped) void this.tick();
    }, this.#config.tickMs);
  }

  /** 반복을 끄고 돌던 틱을 기다린다. 멈춘 뒤의 틱·start는 아무것도 하지 않는다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.whenIdle();
  }

  /** 틱 하나. 리더가 아니면 메모리를 비우고 끝난다. 던지지 않는다 */
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const p = this.#scope.runInAsyncScope(() => this.#tickOnce());
    this.#track(p);
    return p;
  }

  /** 돌고 있는 틱이 모두 끝나면 풀린다(시험과 stop이 쓴다) */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  // ---- 안쪽 ----

  #timer(): EntryPauseJudgeTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  async #tickOnce(): Promise<void> {
    if (!this.deps.leader.isLeader()) {
      this.#memory.clear();
      return;
    }
    await Promise.all(PG_NAMES.map((pg) => this.#turn(pg)));
  }

  /** 그 결제사의 앞 틱이 돌고 있지 않을 때만 돈다. 던지지 않는다 */
  async #turn(pg: PgName): Promise<void> {
    if (this.#running.has(pg)) return;
    let gateway: PaymentGatewayPort | undefined;
    let guard: PgCallGuard | undefined;
    try {
      gateway = this.deps.gateways.of(pg);
      if (gateway !== undefined) guard = this.deps.guards.of(pg);
    } catch (err) {
      this.#error('read', pg, err);
      return;
    }
    if (gateway === undefined || guard === undefined) return;
    this.#running.add(pg);
    try {
      await this.#judge(pg, gateway, guard);
    } catch (err) {
      this.#error('write', pg, err);
    } finally {
      this.#running.delete(pg);
    }
  }

  async #judge(pg: PgName, gateway: PaymentGatewayPort, guard: PgCallGuard): Promise<void> {
    const { store, clock } = this.deps;
    let row: EntryPauseRecord | undefined;
    try {
      row = await store.readRecord(pg);
    } catch (err) {
      this.#error('read', pg, err);
      return;
    }
    const memory = this.#memoryOf(pg);
    const probing = row !== undefined && row.stage !== 'OPEN' && row.reason === 'PG_FAILURE';
    if (!probing) memory.window.clear();
    const [cluster, channelSeconds, trial] = await Promise.all([this.#cluster(pg, row), this.#channel(pg, row, gateway, guard), this.#trial(pg, row), probing ? this.#probe(pg, gateway, guard, memory.window) : undefined]);
    // 서킷이 열리면 창을 비운다(열린 동안의 표본을 정상으로 세지 않는다)
    const localCircuitClosed = guard.circuitClosed();
    if (!localCircuitClosed) memory.window.clear();
    const nowMs = clock.now();
    memory.channelBelowSinceMs = row?.reason === 'CHANNEL_WAIT' && row.stage !== 'OPEN' ? nextChannelBelowSince(memory.channelBelowSinceMs, channelSeconds, nowMs, this.#config) : undefined;
    const probe = memory.window.status(nowMs, this.#config);
    const facts: EntryPauseFacts = {
      nowMs,
      cluster: freshClusterReading(cluster, nowMs, this.#config),
      localCircuitClosed,
      channel: channelSeconds === undefined ? undefined : { waitSeconds: channelSeconds, ...(memory.channelBelowSinceMs === undefined ? {} : { belowSinceMs: memory.channelBelowSinceMs }) },
      probeHealthy: probe === 'HEALTHY',
      probeFilling: probe === 'FILLING',
      trial,
    };
    const decision = decideEntryPause(row, facts, this.#config);
    if (decision.kind === 'STAY') return;
    const next = nextPauseRecord(pg, row, decision, nowMs);
    let written: boolean;
    try {
      written = await store.write(row, next);
    } catch (err) {
      this.#error('write', pg, err);
      return;
    }
    if (!written) {
      this.#safe(() => this.deps.signals.writeConflict(pg));
      return;
    }
    if (decision.kind === 'PROBING' || decision.kind === 'OPEN') memory.window.clear();
    this.#safe(() => this.deps.log.transition({ pg, from: row?.stage ?? 'OPEN', to: next.stage, reason: next.reason, actor: next.actor }));
  }

  #memoryOf(pg: PgName): PgMemory {
    let memory = this.#memory.get(pg);
    if (memory === undefined) {
      memory = { window: new EntryPauseProbeWindow(), channelBelowSinceMs: undefined };
      this.#memory.set(pg, memory);
    }
    return memory;
  }

  /** 클러스터 입력. p99는 열림일 때만 묻는다(시작 조건에만 쓴다). 실패는 어댑터가 undefined로 돌려준다 */
  async #cluster(pg: PgName, row: EntryPauseRecord | undefined): Promise<ClusterPauseReading | undefined> {
    const opened = row === undefined || row.stage === 'OPEN';
    const p99WindowMs = opened ? p99WindowOf(row, this.deps.clock.now(), this.#config) : undefined;
    try {
      return await this.deps.inputs.read(pg, p99WindowMs === undefined ? {} : { p99WindowMs });
    } catch (err) {
      this.#error('read', pg, err);
      return undefined;
    }
  }

  /** 예상 대기(초). 열림과 상한 정지일 때만 읽는다. 읽지 못하면 undefined다 */
  async #channel(pg: PgName, row: EntryPauseRecord | undefined, gateway: PaymentGatewayPort, guard: PgCallGuard): Promise<number | undefined> {
    if (!(row === undefined || row.stage === 'OPEN' || row.reason === 'CHANNEL_WAIT')) return undefined;
    try {
      const waiting = await this.deps.store.countWaitingConfirms(pg, this.deps.clock.now(), ENTRY_PAUSE_WAITING_COUNT_CAP);
      // 채널의 초당 승인 수 = 파드당 초당 상한 × 파드 수 ÷ 승인 호출 비용(낮춘 상한은 이 파드의 값이다)
      const approvalsPerSecond = (guard.limits().rps * this.deps.podCount) / (gateway.capabilities().confirmCallCost ?? 1);
      return channelWaitSeconds(waiting, approvalsPerSecond);
    } catch (err) {
      this.#error('channel', pg, err);
      return undefined;
    }
  }

  /** 시험 재개 요약. 읽지 못하거나 앞 표본에 답을 기다리는 호출이 있으면 undefined다(그 틱은 전이하지 않는다) */
  async #trial(pg: PgName, row: EntryPauseRecord | undefined): Promise<EntryTrialSummary | undefined> {
    if (row?.stage !== 'TRIAL' || row.trialStartedAtMs === undefined) return undefined;
    try {
      return summarizeEntryTrial(await this.deps.store.readTrialResults(pg, row.trialStartedAtMs, this.#config.trialSampleSize), this.deps.clock.now(), this.#config);
    } catch (err) {
      this.#error('trial', pg, err);
      return undefined;
    }
  }

  /** 확인 호출 한 번. 원장을 바꾸지 않는다. 던지지 않는다 */
  async #probe(pg: PgName, gateway: PaymentGatewayPort, guard: PgCallGuard, window: EntryPauseProbeWindow): Promise<void> {
    if (!guard.admitsQuery()) {
      this.#safe(() => this.deps.signals.probe(pg, 'skipped'));
      return;
    }
    try {
      const answer = await guard.run(() => this.#guarded(gateway.query(PG_CIRCUIT_PROBE_PAYMENT_REF, { timeoutMs: PG_CIRCUIT_PROBE_TIMEOUT_MS })), isProbeFailure, 'query');
      const { outcome, found } = classifyProbeAnswer(answer);
      if (found) this.#safe(() => this.deps.log.probeFound({ pg }));
      window.add(this.deps.clock.now(), outcome === 'ok');
      this.#safe(() => this.deps.signals.probe(pg, outcome));
    } catch (err) {
      if (err instanceof PgCircuitOpenError) {
        this.#safe(() => this.deps.signals.probe(pg, 'skipped'));
        return;
      }
      window.add(this.deps.clock.now(), false);
      this.#safe(() => this.deps.signals.probe(pg, 'fail'));
    }
  }

  async #guarded(work: Promise<QueryResult>): Promise<QueryResult> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => reject(new ProbeGuardTimeout()), PROBE_GUARD_MS);
      handle.unref();
    });
    try {
      return await Promise.race([work, guard]);
    } finally {
      clearTimeout(handle);
    }
  }

  #error(what: EntryPauseJudgeErrorWhat, pg: PgName, err: unknown): void {
    this.#safe(() => this.deps.signals.judgeError(what));
    this.#safe(() => this.deps.log.judgeError({ what, pg, err }));
  }

  #track(p: Promise<unknown>): void {
    const tracked: Promise<void> = p.then(noop, noop).finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
  }

  /** 로그·지표는 던지지 않기로 했지만, 던져도 판정을 막지 않는다 */
  #safe(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

const noop = (): undefined => undefined;

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: EntryPauseJudgeTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
