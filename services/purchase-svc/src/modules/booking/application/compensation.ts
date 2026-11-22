// 보상 세 걸음의 쓰임새와 실행기(BAT-011, PRF-173, ADR-0354, docs/features/payment.md §3 '보상 세 걸음의 첫 구현').
// 회차 취소 실행기(event-refund-service)가 APPROVED·발권 대기 주문을 EventCompensationQueue로 큐에 넣고,
// CompensationRunner(API 파드 1초 [가정] 틱, 릴레이 리더 CompensationLoop)가 집어 ① 발권 막기(FenceCompensation) → ② 결제 취소(CancelCompensation)를 돈다.
// ③ 주문 T20(COMPENSATED)은 CancelCompensation이 결제 취소 답을 받은 저장소 compensated 트랜잭션에서 한 번만 쓴다.
// 쓰임새의 run은 정본에 없는 어긋남(보상 행 없음, 발권 막기 전 결제 취소, 사유 없음)을 던진다. 실행기는 그 오류를 실패 코드로 접어
// 다시 보내거나 FAILED로 끝낸다(영구 실패는 SEV2). 발권 막기가 끝나기 전에는 결제 취소를 부르지 않는다(T6, 명세 compCancel의 not(ISSUE_FENCE) or closed).
// 실행기는 던지지 않는다(틱·행마다 오류는 로그·지표 뒤 다음으로 간다). 저장소·gRPC는 포트로만 쓴다(architecture §3.1).
// 구현에서 정한 것(정본에 없다):
// - start는 사유가 없으면 저장소에 가기 전에 던진다. 주문이 APPROVED가 아니면 큐 행 삭제까지 되돌리고 NOT_APPROVED를 준다(멱등 no-op).
// - fence는 status STARTED에서만 부른다. 결제 취소(cancel)는 FENCED·COMPENSATED에서만 부르고 STARTED·FAILED면 던진다.
// - cancel의 다시 보내기·실패 쓰기는 던지지 않는다(행 상태가 그대로면 실행기가 다음 틱에 다시 본다). 결제사·저장소 장애로 던진 오류만 실행기가 접는다.
// - started 지표는 큐에 새 행을 만들었을 때, fenced·compensated·retry·failed는 그 걸음의 결과마다 하나다.
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import {
  COMPENSATION_CANCEL_DEADLINE_MS,
  COMPENSATION_CANDIDATE_BATCH,
  COMPENSATION_CLAIM_LIMIT,
  COMPENSATION_FENCE_DEADLINE_MS,
  COMPENSATION_GAUGE_INTERVAL_MS,
  COMPENSATION_LEASE_MS,
  COMPENSATION_POLL_INTERVAL_MS,
  COMPENSATION_REASON,
  compensationCancellationId,
  compensationFailureKind,
  compensationRetryDelayMs,
  type CompensationJobs,
  type CompensationLog,
  type CompensationPaymentAnswer,
  type CompensationSignals,
  type CompensationStatus,
  type OrderCompensation,
  type PaymentCancelAnswerName,
  type PaymentCompensator,
  noopCompensationLog,
  noopCompensationSignals,
  type StartCompensationWriteResult,
  type TicketFencer,
  TicketFenceCallError,
} from '../domain/compensation.js';
import type { SagaTimer } from './order-saga.js';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. Saga 실행기와 같은 모양) */
export type CompensationTimer = SagaTimer;

/** 실행기·유스케이스의 시계(없으면 시스템 시계). 시험은 fakeClock을 준다 */
interface ClockLike {
  now(): number;
}

function timeOf(o: { readonly clock?: ClockLike; readonly nowMs?: () => number }): number {
  if (o.nowMs) return o.nowMs();
  if (o.clock) return o.clock.now();
  return Date.now();
}

/** ① 보상 시작: 발권 큐 행을 지우고 주문이 APPROVED일 때만 STARTED 행을 만든다(specs compStart) */
export interface StartCompensationDeps {
  readonly store: CompensationJobs;
  readonly clock?: ClockLike;
  readonly nowMs?: () => number;
  /** 그 주문의 마지막 APPROVED 결제 ID(ADR-0354 결정 4). 없으면 빈 값으로 시작하고 어댑터가 원장을 찾는다 */
  readonly paymentIdOf?: (orderId: string) => Promise<string | undefined>;
  readonly log?: CompensationLog;
  readonly signals?: CompensationSignals;
}

/** start의 입력(정본에 없는 칸은 거절하지 않고 무시한다: eventId·cause·requestId는 감사·로그용이다) */
export interface StartCompensationInput {
  readonly orderId: string;
  readonly paymentId?: string;
  readonly reason?: string;
  /** 회차 취소 확정의 사유 이름. reason이 없으면 이것을 쓴다 */
  readonly cause?: string;
  readonly eventCancellationRequestId?: string;
  readonly requestId?: string;
}

export class StartCompensation {
  constructor(private readonly o: StartCompensationDeps) {}

  /**
   * 주문 하나를 보상 큐에 넣는다. 같은 주문은 한 번만 만든다(EXISTS). APPROVED가 아니면 아무것도 바꾸지 않는다(NOT_APPROVED).
   * @throws Error 사유가 없음(정본에 없는 호출을 거절한다), orderId가 소문자 UUID가 아님(저장소)
   */
  async run(input: StartCompensationInput): Promise<StartCompensationWriteResult> {
    const reason = (input.reason ?? input.cause ?? '').trim();
    if (reason.length === 0) throw new Error('보상 사유가 없다(회차 취소 확정 또는 CS 확인이 있어야 한다)');
    const paymentId = input.paymentId !== undefined && input.paymentId !== '' ? input.paymentId : await this.o.paymentIdOf?.(input.orderId);
    const result = await this.o.store.start({
      orderId: input.orderId,
      reason,
      nowMs: timeOf(this.o),
      ...(paymentId !== undefined && paymentId !== '' ? { paymentId } : {}),
    });
    if (result.status === 'CREATED') (this.o.signals ?? noopCompensationSignals).result('started');
    return result;
  }
}

/** ② 발권 막기(specs compFence) */
export interface FenceCompensationDeps {
  readonly store: CompensationJobs;
  readonly fence: TicketFencer;
  readonly clock?: ClockLike;
  readonly nowMs?: () => number;
  readonly log?: CompensationLog;
  readonly signals?: CompensationSignals;
}

/** fence의 답(테스트 포트는 already_entered, 운영 어댑터는 alreadyEntered를 쓴다) */
export interface FenceCompensationAnswer {
  readonly blocked: true;
  readonly alreadyEntered: number;
  readonly voided?: number;
}

/**
 * 그 주문의 발권을 막는다. STARTED에서만 부른다. 포트가 던지면 임대를 풀지 않고 그대로 던진다(실행기가 다시 보내거나 FAILED로 끝낸다).
 * 성공하면 FENCED로 쓰고, 이미 입장 기록이 있으면 SEV1 로그를 남긴다
 */
export class FenceCompensation {
  constructor(private readonly o: FenceCompensationDeps) {}

  /** @throws Error 보상 행이 없거나 STARTED가 아님, 포트가 던진 것 */
  async run(input: { readonly orderId: string }): Promise<FenceCompensationAnswer> {
    const row = await this.o.store.get(input.orderId);
    if (!row) throw new Error('보상 행이 없다');
    if (row.status !== 'STARTED') {
      if (row.status === 'FENCED' || row.status === 'COMPENSATED') return { blocked: true, alreadyEntered: 0 };
      throw new Error(`발권을 막을 수 있는 보상 상태가 아니다: ${row.status}`);
    }
    const answer = await this.o.fence.block({ orderId: row.orderId, reason: row.reason, deadlineMs: COMPENSATION_FENCE_DEADLINE_MS });
    const alreadyEntered = answer.alreadyEntered ?? answer.already_entered ?? 0;
    const written = await this.o.store.fenced({
      orderId: row.orderId,
      nowMs: timeOf(this.o),
      ...(row.leaseUntilMs === undefined ? {} : { leaseUntilMs: row.leaseUntilMs }),
    });
    if (!written) throw new Error('보상 행을 FENCED로 쓰지 못했다(다른 실행이 잡았거나 끝냈다)');
    const log = this.o.log ?? noopCompensationLog;
    (this.o.signals ?? noopCompensationSignals).result('fenced');
    if (alreadyEntered > 0) log.entered({ orderId: row.orderId, alreadyEntered });
    return { blocked: true, alreadyEntered, ...(answer.voided === undefined ? {} : { voided: answer.voided }) };
  }
}

/** ③ 결제 취소(specs compCancel) */
export interface CancelCompensationDeps {
  readonly store: CompensationJobs;
  readonly payments: PaymentCompensator;
  readonly clock?: ClockLike;
  readonly nowMs?: () => number;
  readonly log?: CompensationLog;
  readonly signals?: CompensationSignals;
  /** 흔들기 난수([0, 1)). 없으면 0.5(흔들기 없음) */
  readonly random?: () => number;
}

/** 결제 취소의 답을 갈래로 접는다. 문자열(시험 대역)과 객체(운영 어댑터)를 모두 받는다 */
function answerKindOf(answer: CompensationPaymentAnswer | PaymentCancelAnswerName | { readonly kind: string; readonly code?: string; readonly paymentId?: string }): {
  readonly kind: 'COMPENSATED' | 'RETRY' | 'FAILED';
  readonly code?: string;
  readonly paymentId?: string;
} {
  if (typeof answer === 'string') {
    if (answer === 'CANCELLED') return { kind: 'COMPENSATED' };
    if (answer === 'CANCEL_PENDING' || answer === 'PENDING' || answer === 'UNKNOWN') return { kind: 'RETRY', code: answer };
    return { kind: 'FAILED', code: answer };
  }
  if (answer.kind === 'CANCELED') return { kind: 'COMPENSATED', ...(answer.paymentId === undefined ? {} : { paymentId: answer.paymentId }) };
  if (answer.kind === 'RETRY') return { kind: 'RETRY', code: answer.code ?? 'UNKNOWN', ...(answer.paymentId === undefined ? {} : { paymentId: answer.paymentId }) };
  if (answer.kind === 'FAILED') return { kind: 'FAILED', code: answer.code ?? 'REJECTED', ...(answer.paymentId === undefined ? {} : { paymentId: answer.paymentId }) };
  return { kind: 'RETRY', code: 'UNKNOWN' };
}

/**
 * 그 주문의 결제를 전액 취소하고, 성공한 뒤에만 주문 T20(APPROVED → COMPENSATED)을 쓴다.
 * FENCED·COMPENSATED에서만 부른다(발권 막기가 끝나기 전 결제 취소는 던진다). 결과 모름·처리 중은 같은 취소 ID로 다시 보내고,
 * 업무 거절·계좌 필요는 FAILED·SEV2다. 이미 COMPENSATED인 행의 다시 부름도 결제를 다시 부르지만 T20은 한 번뿐이다(이중 환급 0)
 */
export class CancelCompensation {
  constructor(private readonly o: CancelCompensationDeps) {}

  /**
   * @throws Error 보상 행이 없거나 결제 취소를 부를 상태가 아님(STARTED·FAILED), 결제 포트가 던진 것
   */
  async run(input: { readonly orderId: string }): Promise<void> {
    const row = await this.o.store.get(input.orderId);
    if (!row) throw new Error('보상 행이 없다');
    if (row.status === 'STARTED') throw new Error('발권 막기가 끝나지 않아 결제 취소를 부르지 않는다');
    if (row.status === 'FAILED') throw new Error('이미 실패로 끝난 보상이다');
    const nowMs = timeOf(this.o);
    const answer = await this.o.payments.cancel({
      orderId: row.orderId,
      paymentId: row.paymentId ?? '',
      cancellationId: compensationCancellationId(row.orderId),
      reason: row.reason,
      deadlineMs: COMPENSATION_CANCEL_DEADLINE_MS,
    });
    const kind = answerKindOf(answer);
    if (kind.kind === 'COMPENSATED') {
      const written = await this.o.store.compensated({
        orderId: row.orderId,
        nowMs,
        ...(kind.paymentId === undefined && row.paymentId === undefined ? {} : { paymentId: kind.paymentId ?? row.paymentId }),
        ...(row.leaseUntilMs === undefined ? {} : { leaseUntilMs: row.leaseUntilMs }),
      });
      if (written.status === 'COMPENSATED') {
        (this.o.signals ?? noopCompensationSignals).result('compensated');
        return;
      }
      if (written.status === 'LEASE_LOST') throw new Error('보상 행의 임대를 잃었다(다른 실행이 이어 받는다)');
      // 주문이 APPROVED가 아니다: 결제는 취소됐을 수 있어 사람에게 넘긴다
      await this.#failed(row, 'ORDER_STALE', nowMs);
      throw new Error('주문이 APPROVED가 아니라 T20을 쓰지 못했다');
    }
    if (kind.kind === 'RETRY') {
      const delay = this.#retryDelayMs(row.attempts + 1);
      await this.o.store.retry({
        orderId: row.orderId,
        code: kind.code ?? 'UNKNOWN',
        nextAtMs: nowMs + delay,
        nowMs,
        ...(kind.paymentId === undefined ? {} : { paymentId: kind.paymentId }),
        ...(row.leaseUntilMs === undefined ? {} : { leaseUntilMs: row.leaseUntilMs }),
      });
      (this.o.signals ?? noopCompensationSignals).result('retry');
      return;
    }
    await this.#failed(row, kind.code ?? 'REJECTED', nowMs);
  }

  async #failed(row: OrderCompensation, code: string, nowMs: number): Promise<void> {
    const written = await this.o.store.failed({
      orderId: row.orderId,
      code,
      nowMs,
      ...(row.leaseUntilMs === undefined ? {} : { leaseUntilMs: row.leaseUntilMs }),
    });
    if (!written) return;
    (this.o.signals ?? noopCompensationSignals).result('failed');
    (this.o.log ?? noopCompensationLog).failed({ orderId: row.orderId, stage: 'cancel', code });
  }

  #retryDelayMs(attempts: number): number {
    const raw = (this.o.random ?? (() => 0.5))();
    const unit = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.5;
    try {
      return compensationRetryDelayMs(attempts, unit);
    } catch {
      return compensationRetryDelayMs(Number.MAX_SAFE_INTEGER, unit);
    }
  }
}

/** 실행기가 쓰는 포트와 설정 */
export interface CompensationRunnerDeps {
  readonly jobs: CompensationJobs;
  readonly fence: Pick<FenceCompensation, 'run'>;
  readonly cancel: Pick<CancelCompensation, 'run'>;
  readonly log: CompensationLog;
  readonly signals: CompensationSignals;
  readonly clock: ClockLike;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  readonly timer?: CompensationTimer;
  readonly pollIntervalMs?: number;
  readonly claimLimit?: number;
  readonly leaseMs?: number;
  readonly gaugeIntervalMs?: number;
}

/** 틱 하나의 결과(시험·로그용 수) */
export interface CompensationTickResult {
  readonly claimed: number;
  readonly fenced: number;
  readonly compensated: number;
  readonly retried: number;
  readonly failed: number;
  readonly measured: boolean;
}

/**
 * 보상 실행기. start()로 1초 [가정] 반복을 켜고 stop()으로 끈다(돌던 틱을 기다린다).
 * 틱 하나: 기한이 된 STARTED·FENCED 행을 잡아(STARTED → 발권 막기 → 이어서 결제 취소, FENCED → 결제 취소) 차례로 돈다. 10초 [가정]마다 게이지를 잰다.
 * 같은 행을 두 파드가 함께 잡아도 저장소가 SKIP LOCKED·자기 임대 조건으로 하나만 효과 있게 한다. 던지지 않는다
 */
export class CompensationRunner {
  #handle: unknown;
  #stopped = false;
  #ticking: Promise<void> | undefined;
  readonly #inflight = new Set<Promise<void>>();
  #measuredAtMs: number | undefined;
  readonly #scope = new AsyncResource('CompensationRunner');

  constructor(private readonly deps: CompensationRunnerDeps) {}

  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#loopTick(), this.deps.pollIntervalMs ?? COMPENSATION_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await Promise.allSettled([...this.#inflight]);
  }

  /** 틱 하나. 멈춘 뒤에는 아무것도 하지 않고 0을 돌려준다 */
  async tick(): Promise<CompensationTickResult> {
    if (this.#stopped) return NOTHING;
    const p = this.#tickOnce();
    this.#track(p.then(noop, noop));
    return p;
  }

  async #tickOnce(): Promise<CompensationTickResult> {
    let rows: readonly OrderCompensation[] = [];
    try {
      rows = await this.deps.jobs.claimDue(this.#claimLimit(), this.#leaseMs(), this.deps.clock.now());
    } catch (err) {
      this.#runError('claim', err);
    }
    let fenced = 0;
    let compensated = 0;
    let retried = 0;
    let failed = 0;
    for (const row of rows) {
      const outcome = await this.#runRow(row);
      if (outcome === 'fenced') fenced += 1;
      else if (outcome === 'compensated') compensated += 1;
      else if (outcome === 'retried') retried += 1;
      else if (outcome === 'failed') failed += 1;
    }
    // 게이지: 시작 뒤 첫 틱, 그 뒤 10초 [가정]마다. 재지 못했으면 다음 틱에 다시
    let measured = false;
    const now = this.deps.clock.now();
    if (this.#measuredAtMs === undefined || now - this.#measuredAtMs >= (this.deps.gaugeIntervalMs ?? COMPENSATION_GAUGE_INTERVAL_MS)) {
      try {
        const g = await this.deps.jobs.gauges();
        this.#safe(() => this.deps.signals.jobs('pending', g.pending));
        this.#safe(() => this.deps.signals.jobs('failed', g.failed));
        this.#measuredAtMs = now;
        measured = true;
      } catch (err) {
        this.#runError('gauges', err);
      }
    }
    return { claimed: rows.length, fenced, compensated, retried, failed, measured };
  }

  /** 행 하나. STARTED면 발권 막기부터, 그 뒤 결제 취소. 던지지 않는다 */
  async #runRow(row: OrderCompensation): Promise<'fenced' | 'compensated' | 'retried' | 'failed' | 'none'> {
    let current = row;
    if (current.status === 'STARTED') {
      try {
        await this.deps.fence.run({ orderId: current.orderId });
      } catch (err) {
        return this.#failure(current, err, 'fence');
      }
      current = (await this.deps.jobs.get(current.orderId)) ?? { ...current, status: 'FENCED' as CompensationStatus };
    }
    if (current.status !== 'FENCED' && current.status !== 'COMPENSATED') return 'none';
    try {
      await this.deps.cancel.run({ orderId: current.orderId });
    } catch (err) {
      return this.#failure(current, err, 'cancel');
    }
    const after = await this.deps.jobs.get(current.orderId).catch(() => undefined);
    if (after?.status === 'COMPENSATED') return 'compensated';
    if (after?.status === 'FAILED') return 'failed';
    return 'retried';
  }

  /** 쓰임새가 던진 오류를 실패 코드로 접어 다시 보내거나 FAILED로 끝낸다. 던지지 않는다 */
  async #failure(row: OrderCompensation, err: unknown, stage: 'fence' | 'cancel'): Promise<'retried' | 'failed' | 'none'> {
    const code = err instanceof TicketFenceCallError ? err.code : 'UNKNOWN';
    if (!(err instanceof TicketFenceCallError)) this.#runError(stage, err, row.orderId);
    if (compensationFailureKind(code) === 'FAILED') {
      try {
        const written = await this.deps.jobs.failed({ orderId: row.orderId, code, nowMs: this.deps.clock.now(), ...(row.leaseUntilMs === undefined ? {} : { leaseUntilMs: row.leaseUntilMs }) });
        if (written) {
          this.#safe(() => this.deps.signals.result('failed'));
          this.#safe(() => this.deps.log.failed({ orderId: row.orderId, stage, code }));
        }
        return written ? 'failed' : 'none';
      } catch (e) {
        this.#runError('cancel', e, row.orderId);
        return 'none';
      }
    }
    try {
      const attempts = row.attempts + 1;
      const nextAtMs = this.deps.clock.now() + safeRetryDelay(attempts);
      const written = await this.deps.jobs.retry({ orderId: row.orderId, code, nextAtMs, nowMs: this.deps.clock.now(), ...(row.leaseUntilMs === undefined ? {} : { leaseUntilMs: row.leaseUntilMs }) });
      if (written) this.#safe(() => this.deps.signals.result('retry'));
      return written ? 'retried' : 'none';
    } catch (e) {
      this.#runError(stage, e, row.orderId);
      return 'none';
    }
  }

  #timer(): CompensationTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  #claimLimit(): number {
    const c = this.deps.claimLimit ?? COMPENSATION_CLAIM_LIMIT;
    return Number.isSafeInteger(c) && c >= 1 ? c : COMPENSATION_CLAIM_LIMIT;
  }

  #leaseMs(): number {
    return this.deps.leaseMs ?? COMPENSATION_LEASE_MS;
  }

  #loopTick(): void {
    if (this.#stopped || this.#ticking) return;
    const p = this.#scope.runInAsyncScope(() => this.tick()).then(noop, noop);
    this.#ticking = p;
    void p.finally(() => {
      this.#ticking = undefined;
    });
  }

  #track(p: Promise<void>): void {
    const tracked = p.finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
  }

  #runError(stage: string, err: unknown, orderId?: string): void {
    try {
      this.deps.log.runError({ stage, ...(orderId === undefined ? {} : { orderId }), err });
    } catch {
      // 삼킨다
    }
  }

  #safe(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

/** 간격 계산이 범위 밖이어도 실행기를 멈추지 않는다(상한 간격) */
function safeRetryDelay(attempts: number): number {
  try {
    return compensationRetryDelayMs(attempts, 0.5);
  } catch {
    return compensationRetryDelayMs(Number.MAX_SAFE_INTEGER, 0.5);
  }
}

/**
 * 회차 취소 실행기가 부르는 보상 큐(BAT-011). 그 회차에서 발권이 끝나지 않은(APPROVED) 주문 가운데 ticket_issue_job 행이 있는 것을
 * 최대 100건 [가정] 골라 StartCompensation으로 STARTED 행을 만든다. 다음 틱이 나머지를 넣는다.
 * 한 주문이 실패해도 나머지는 이어 넣고, 실패는 경고·지표만 남긴다(회차 취소 요청 상태는 바꾸지 않는다)
 */
export class EventCompensationQueue {
  constructor(
    private readonly o: {
      readonly jobs: Pick<CompensationJobs, 'candidates'>;
      readonly start: Pick<StartCompensation, 'run'>;
      readonly log?: CompensationLog;
    },
  ) {}

  /** 새로 만든 보상 행 수 */
  async queue(eventId: string): Promise<number> {
    let orderIds: readonly string[];
    try {
      orderIds = await this.o.jobs.candidates(eventId, COMPENSATION_CANDIDATE_BATCH);
    } catch (err) {
      (this.o.log ?? noopCompensationLog).runError({ stage: 'start', err });
      return 0;
    }
    let created = 0;
    for (const orderId of orderIds) {
      try {
        const result = await this.o.start.run({ orderId, reason: COMPENSATION_REASON });
        if (result.status === 'CREATED') created += 1;
      } catch (err) {
        (this.o.log ?? noopCompensationLog).runError({ stage: 'start', orderId, err });
      }
    }
    return created;
  }
}

/** 릴레이 리더가 1초 [가정]마다 CompensationRunner.tick을 부른다(EventRefundLoop와 같은 꼴) */
export const COMPENSATION_LOOP_TICK_MS = 1000;

export interface CompensationLoopDeps {
  readonly runner: Pick<CompensationRunner, 'tick'>;
  readonly leader: { isLeader(): boolean };
  readonly logger?: { warn(o: object, msg: string): void; info?(o: object, msg: string): void };
  readonly tickMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** 릴레이 리더 전용 반복(리더가 아니면 틱을 건너뛴다) */
export class CompensationLoop {
  readonly name = 'order-compensation-runner';
  readonly #tickMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly deps: CompensationLoopDeps) {
    this.#tickMs = deps.tickMs ?? COMPENSATION_LOOP_TICK_MS;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  async tick(): Promise<CompensationTickResult | { skipped: 'not_leader' }> {
    if (!this.deps.leader.isLeader()) return { skipped: 'not_leader' };
    return this.deps.runner.tick();
  }

  start(): void {
    if (this.#abort) return;
    const ac = new AbortController();
    this.#abort = ac;
    this.#loop = this.#run(ac.signal);
  }

  async stop(): Promise<void> {
    const ac = this.#abort;
    if (!ac) return;
    ac.abort();
    await this.#loop;
    this.#abort = undefined;
    this.#loop = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const r = await this.tick();
        if ('claimed' in r && (r.compensated > 0 || r.failed > 0)) {
          this.deps.logger?.info?.({ kind: 'order-compensation-runner', ...r }, '보상 한 바퀴를 마쳤다');
        }
      } catch (err) {
        this.deps.logger?.warn({ kind: 'order-compensation-runner', err: (err as Error).name }, '보상 틱이 실패했다(다음 틱이 다시 한다)');
      }
      try {
        await this.#sleep(this.#tickMs, signal);
      } catch {
        // 바꿔 끼운 쉬기가 던져도 반복을 끝내지 않는다
      }
    }
  }
}

const noop = (): undefined => undefined;
const NOTHING: CompensationTickResult = Object.freeze({ claimed: 0, fenced: 0, compensated: 0, retried: 0, failed: 0, measured: false });

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: CompensationTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
