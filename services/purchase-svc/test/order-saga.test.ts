// 주문 Saga 1단계 실행기(booking application/order-saga.ts OrderSagaRunner, docs/features/payment.md §2 'Saga 1단계의 첫 구현',
// docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제', docs/data.md §5 'Saga 1단계', BUILD_ORDER PRF-165)를 메모리 가짜 포트로 본다.
// - RESERVE: 승인 기한 → 좌석 묶기 → 판매 예약(판 번호가 바뀌면 묶기부터 다시) → CONFIRM을 같은 실행에서 이어 돈다
// - CONFIRM: 승인 명령 → 결제 참조 지우기·작업 행 AWAIT(지우지 않는다, PRF-171), 다시 보내기, 기한을 넘기면 T11과 실패 해제
// - 실패의 차례(DB 실패 기록을 먼저 커밋 → 실패 해제), 다시 하기 간격, pollOnce·runOne·kick·start/stop, 행위자, 로그에 결제 참조·금액이 없음
// - 승인 명령 접수 뒤(PRF-171, ADR-0140): 작업 행이 AWAIT(confirm_sent_at 그대로)로 남고 Saga 잡기가 그 행을 다시 집지 않는다
// 가짜는 DB가 할 일을 흉내 낸다: 판매 예약 RESERVED면 주문 RESERVED·작업 CONFIRM, GEN_CHANGED면 주문 seat_gen을 새 번호로, 실패 기록 FAILED면 주문 FAILED·작업 RELEASE,
// 승인 명령 접수 뒤 정리(ConfirmSent.done)면 CONFIRM 작업 행을 AWAIT로(지우지 않는다), 잡기(claimDue·claim)는 AWAIT 행을 고르지 않는다(BUILD_ORDER PRF-171 설계 1·2).
// DrizzleSaga가 실제로 그렇게 쓰는지는 test/order-saga-await.test.ts(SQL)와 test-int(다른 담당)가 본다.
// 실제 PostgreSQL·Valkey로 도는 것(작업 임대, 판매 예약 트랜잭션, 늦은 묶기 재현 V-T40 ④)은 test-int(다른 담당)다.
import { CircuitBreaker, Deadline, fakeClock, type FakeClock, type RequestContext, requestContext, runInRequestContext } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  type ConfirmCommand,
  type ConfirmOutcome,
  ORDER_SAGA_ACTOR,
  type OrderPinInput,
  type OrderPinResult,
  type OrderReleaseInput,
  type OrderReleaseResult,
  OrderSagaRunner,
  type OrderSagaDeps,
  OrderSeatStoreUnavailable,
  type ReserveTxInput,
  type ReserveTxOutcome,
  SAGA_CONFIRM_PARK_MS,
  SAGA_GEN_RESTART_MAX,
  SAGA_LEASE_MIN_REMAINING_MS,
  type SagaAttemptView,
  type SagaEventConfig,
  type SagaFailInput,
  type SagaFailOutcome,
  type SagaJob,
  type SagaLog,
  type SagaOrderView,
  type SagaSeat,
  type SagaStep,
  type SagaTimer,
} from '../src/modules/booking/index.js';
import { ATTEMPT_ID, MIN, ORDER_ID, PAYMENT_KEY, PAYMENT_TOKEN, PORTONE_PAYMENT_ID, SEAT_GEN, TX_ID } from './accept-cases.js';
import { ACCOUNT, AMOUNT, DAY, EVENT, HOLD_ID, NOW } from './order-cases.js';

/** 구매 세션 ID(입장 토큰 jti 모양. 묶기 입력은 UUID가 아니라 키 조각 모양으로 받는다, payment §2 '좌석 묶기 입력의 구매 세션 ID') */
const SAGA_PSID = 'jti_Saga-0001';
/** 주문 좌석(소문자 UUID). 항목 차례를 정렬 차례와 다르게 둔다 */
const SEAT_1 = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_2 = '0190f3a1-7c2e-7a00-8000-00000000a002';
const SEATS: readonly SagaSeat[] = Object.freeze([
  { seatId: SEAT_2, tierId: 'R', sectionId: 'SEC-A' },
  { seatId: SEAT_1, tierId: 'S', sectionId: 'SEC-B' },
]);
const SEAT_IDS_SORTED = [SEAT_1, SEAT_2];
/** 다른 주문 둘(pollOnce 시험) */
const ORDER_B = '0190f3a1-7c2e-7f00-8000-0000000000f3';
const ORDER_C = '0190f3a1-7c2e-7f00-8000-0000000000f4';
/** 회차 설정: 1인 한도 4, 판매 종료 이틀 뒤 */
const CONFIG: SagaEventConfig = Object.freeze({ perAccountLimit: 4, saleEndsAtMs: NOW + 2 * DAY });
/** 회차 키 만료 = 판매 종료 + 1일 */
const KEEP_UNTIL = NOW + 3 * DAY;

/** 토스 ACCEPTED 시도(2분 전에 인증) */
function tossAttempt(over: Partial<SagaAttemptView> = {}): SagaAttemptView {
  return { attemptId: ATTEMPT_ID, pg: 'TOSS', pgOrderRef: ORDER_ID, refs: { pg: 'TOSS', paymentKey: PAYMENT_KEY }, authenticatedAtMs: NOW - 2 * MIN, attemptNo: 1, ...over };
}

/** ACCEPTED 주문(판 번호 SEAT_GEN) */
function sagaOrder(over: Partial<SagaOrderView> = {}): SagaOrderView {
  return {
    orderId: ORDER_ID,
    accountId: ACCOUNT,
    eventId: EVENT,
    status: 'ACCEPTED',
    amount: AMOUNT,
    holdId: HOLD_ID,
    purchaseSessionId: SAGA_PSID,
    seatGen: SEAT_GEN,
    seats: SEATS,
    attempt: tossAttempt(),
    ...over,
  };
}

/** 집은 작업 행 */
function sagaJob(over: Partial<SagaJob> = {}): SagaJob {
  return { orderId: ORDER_ID, eventId: EVENT, step: 'RESERVE', attempts: 0, nextAttemptAtMs: NOW, leaseUntilMs: NOW + 30_000, ...over };
}

type Call =
  | 'jobs.claimDue'
  | 'jobs.claim'
  | 'jobs.get'
  | 'jobs.reschedule'
  | 'jobs.setStep'
  | 'jobs.delete'
  | 'jobs.markConfirmSent'
  | 'jobs.release'
  | 'jobs.abandon'
  | 'orders.read'
  | 'orders.recordPinned'
  | 'reserve.reserve'
  | 'failures.fail'
  | 'confirmSent.done'
  | 'pins.pin'
  | 'pins.releaseFailed'
  | 'confirms.confirm'
  | 'configs.get'
  | 'log.releaseFailed'
  | 'log.confirmRejected'
  | 'log.stepError';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 마이크로태스크·즉시 실행 몇 바퀴를 돌린다(kick·틱처럼 기다리지 않는 일이 끝나게) */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** 반복 타이머 대역(손으로 틱을 부른다) */
class FakeTimer implements SagaTimer {
  readonly set: { fn: () => void; ms: number; handle: object }[] = [];
  readonly cleared: unknown[] = [];
  setInterval(fn: () => void, ms: number): unknown {
    const handle = { n: this.set.length };
    this.set.push({ fn, ms, handle });
    return handle;
  }
  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
  }
  tick(): void {
    const last = this.set.at(-1);
    if (!last) throw new Error('setInterval을 부르지 않았다');
    last.fn();
  }
}

/** Saga 포트의 메모리 가짜. calls에 부른 차례를 적고 포트마다 인자를 적는다. 값을 넣어 두면 그대로 답하고 Error면 던진다 */
class SagaFakes {
  calls: Call[] = [];
  jobRows = new Map<string, SagaJob>();
  /** 다른 실행이 임대 중이라 claim이 집지 못하는 주문 */
  leased = new Set<string>();
  orderRows = new Map<string, SagaOrderView>();
  readErrors = new Map<string, Error>();
  due: SagaJob[] | Error = [];
  dueGate: Promise<void> | undefined;
  claimError: Error | undefined;
  /** 차례로 꺼내 답한다. 비면 { OK, gen: 입력의 orderGen } */
  pinQueue: (OrderPinResult | Error)[] = [];
  /** 차례로 꺼내 답한다. 비면 RESERVED */
  reserveQueue: (ReserveTxOutcome | Error)[] = [];
  failOutcome: SagaFailOutcome | Error = { status: 'FAILED' };
  /** 없으면 { OK, released: 좌석 수 } */
  releaseResult: OrderReleaseResult | Error | undefined;
  /** 차례로 꺼내 답한다. 비면 { ACCEPTED, IN_PROGRESS } */
  confirmQueue: (ConfirmOutcome | Error)[] = [];
  config: SagaEventConfig | undefined = CONFIG;

  /** markConfirmSent가 false를 돌려준다(임대를 잃었다) */
  markFails = false;
  claimDueArgs: [number, number][] = [];
  claimArgs: [string, number][] = [];
  reschedules: { orderId: string; nextAtMs: number }[] = [];
  /** reschedule·done·fail·delete·markConfirmSent·release·abandon에 넘긴 임대 값(자기 임대 조건) */
  leaseArgs: { call: Call; leaseUntilMs: number | undefined }[] = [];
  releasedLeases: string[] = [];
  abandons: { orderId: string; step: SagaStep }[] = [];
  pinnedGens: { orderId: string; fromGen: number; toGen: number }[] = [];
  deletes: { orderId: string; step?: SagaStep }[] = [];
  /** 승인 명령 가운데 보내기 전 표시(beforeSend)를 지나 실제로 나간 것 */
  sentCommands: ConfirmCommand[] = [];
  pinInputs: OrderPinInput[] = [];
  reserveInputs: ReserveTxInput[] = [];
  failInputs: SagaFailInput[] = [];
  releaseInputs: OrderReleaseInput[] = [];
  confirmCommands: ConfirmCommand[] = [];
  doneOrders: string[] = [];
  releaseLogs: Parameters<SagaLog['releaseFailed']>[0][] = [];
  rejectLogs: Parameters<SagaLog['confirmRejected']>[0][] = [];
  stepErrors: Parameters<SagaLog['stepError']>[0][] = [];

  constructor(private readonly clock: FakeClock) {}

  /** 주문과 그 작업 행을 둔다 */
  put(order: SagaOrderView, job: SagaJob = sagaJob({ orderId: order.orderId })): void {
    this.orderRows.set(order.orderId, order);
    this.jobRows.set(order.orderId, job);
  }

  private next<T>(queue: (T | Error)[], fallback: T): T {
    const v = queue.length > 0 ? queue.shift()! : fallback;
    if (v instanceof Error) throw v;
    return v;
  }

  private patchOrder(orderId: string, over: Partial<SagaOrderView>): void {
    const o = this.orderRows.get(orderId);
    if (o) this.orderRows.set(orderId, { ...o, ...over });
  }

  readonly jobs = {
    /** DB가 할 일: Saga 잡기는 AWAIT(승인 명령 접수 뒤 결과 기다림) 행을 고르지 않는다(결과 당기기가 고른다, PRF-171 설계 2) */
    claimDue: async (limit: number, leaseMs: number): Promise<SagaJob[]> => {
      this.calls.push('jobs.claimDue');
      this.claimDueArgs.push([limit, leaseMs]);
      if (this.dueGate) await this.dueGate;
      if (this.due instanceof Error) throw this.due;
      return this.due.filter((j) => j.step !== 'AWAIT').map((j) => ({ ...j }));
    },
    claim: async (orderId: string, leaseMs: number): Promise<SagaJob | undefined> => {
      this.calls.push('jobs.claim');
      this.claimArgs.push([orderId, leaseMs]);
      if (this.claimError) throw this.claimError;
      const j = this.jobRows.get(orderId);
      if (!j || j.step === 'AWAIT' || this.leased.has(orderId)) return undefined;
      this.leased.add(orderId);
      return { ...j, leaseUntilMs: this.clock.now() + leaseMs };
    },
    get: async (orderId: string): Promise<SagaJob | undefined> => {
      this.calls.push('jobs.get');
      return this.jobRows.get(orderId);
    },
    reschedule: async (orderId: string, nextAtMs: number, leaseUntilMs?: number): Promise<boolean> => {
      this.calls.push('jobs.reschedule');
      this.leaseArgs.push({ call: 'jobs.reschedule', leaseUntilMs });
      this.reschedules.push({ orderId, nextAtMs });
      const j = this.jobRows.get(orderId);
      if (!j) return false;
      this.jobRows.set(orderId, { ...j, attempts: j.attempts + 1, nextAttemptAtMs: nextAtMs, leaseUntilMs: undefined });
      this.leased.delete(orderId);
      return true;
    },
    setStep: async (orderId: string, step: SagaStep): Promise<boolean> => {
      this.calls.push('jobs.setStep');
      const j = this.jobRows.get(orderId);
      if (!j) return false;
      this.jobRows.set(orderId, { ...j, step, attempts: 0, nextAttemptAtMs: this.clock.now(), leaseUntilMs: undefined });
      return true;
    },
    delete: async (orderId: string, o?: { step?: SagaStep; leaseUntilMs?: number }): Promise<boolean> => {
      this.calls.push('jobs.delete');
      this.leaseArgs.push({ call: 'jobs.delete', leaseUntilMs: o?.leaseUntilMs });
      this.deletes.push({ orderId, ...(o?.step ? { step: o.step } : {}) });
      const j = this.jobRows.get(orderId);
      if (!j || (o?.step !== undefined && j.step !== o.step)) return false;
      return this.jobRows.delete(orderId);
    },
    markConfirmSent: async (orderId: string, leaseUntilMs?: number): Promise<boolean> => {
      this.calls.push('jobs.markConfirmSent');
      this.leaseArgs.push({ call: 'jobs.markConfirmSent', leaseUntilMs });
      const j = this.jobRows.get(orderId);
      if (this.markFails || !j || j.step !== 'CONFIRM') return false;
      this.jobRows.set(orderId, { ...j, confirmSentAtMs: j.confirmSentAtMs ?? this.clock.now() });
      return true;
    },
    release: async (orderId: string, leaseUntilMs: number): Promise<boolean> => {
      this.calls.push('jobs.release');
      this.leaseArgs.push({ call: 'jobs.release', leaseUntilMs });
      this.releasedLeases.push(orderId);
      const j = this.jobRows.get(orderId);
      if (!j) return false;
      this.jobRows.set(orderId, { ...j, leaseUntilMs: undefined });
      this.leased.delete(orderId);
      return true;
    },
    /** DB가 할 일: 주문이 그 단계를 지났으면 작업 행·결제 참조를 지운다(REMOVED), 아니면 그대로(KEPT), 그 단계의 행이 없으면 GONE */
    abandon: async (orderId: string, step: SagaStep, leaseUntilMs?: number): Promise<'REMOVED' | 'KEPT' | 'GONE'> => {
      this.calls.push('jobs.abandon');
      this.leaseArgs.push({ call: 'jobs.abandon', leaseUntilMs });
      this.abandons.push({ orderId, step });
      const j = this.jobRows.get(orderId);
      if (!j || j.step !== step) return 'GONE';
      const o = this.orderRows.get(orderId);
      // 두 단계 모두 RESERVED까지는 '지나지 않음'이다(RESERVE 작업인데 RESERVED인 주문은 손질이 필요해 지우지 않는다)
      if (!o || ['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED'].includes(o.status)) return 'KEPT';
      this.jobRows.delete(orderId);
      if (o.attempt) this.orderRows.set(orderId, { ...o, attempt: { ...o.attempt, refs: undefined } });
      return 'REMOVED';
    },
  };

  /** recordPinned를 부른 주문 ID(차례대로) */
  readonly pinnedOrders: string[] = [];

  readonly orders = {
    read: async (orderId: string): Promise<SagaOrderView | undefined> => {
      this.calls.push('orders.read');
      const err = this.readErrors.get(orderId);
      if (err) throw err;
      return this.orderRows.get(orderId);
    },
    /**
     * 묶기 OK 뒤 실행기가 주문 seat_gen(묶기 결과의 판 번호)과 pinned_at을 한 번에 적는다(ACCEPTED이고 seat_gen = from일 때만 true,
     * BUILD_ORDER PRF-167, 리뷰 고침 L5: 옛 recordPinnedGen을 합쳤다)
     */
    recordPinned: async (orderId: string, fromGen: number, toGen: number): Promise<boolean> => {
      this.calls.push('orders.recordPinned');
      this.pinnedOrders.push(orderId);
      this.pinnedGens.push({ orderId, fromGen, toGen });
      const o = this.orderRows.get(orderId);
      if (!o || o.status !== 'ACCEPTED' || o.seatGen !== fromGen) return false;
      this.patchOrder(orderId, { seatGen: toGen });
      return true;
    },
  };

  readonly reserve = {
    reserve: async (input: ReserveTxInput): Promise<ReserveTxOutcome> => {
      this.calls.push('reserve.reserve');
      this.reserveInputs.push(input);
      const out = this.next<ReserveTxOutcome>(this.reserveQueue, { status: 'RESERVED' });
      if (out.status === 'RESERVED') {
        // 한 트랜잭션: 판매 행 PENDING → 작업 CONFIRM(attempts 0, 보낸 시각 비움, 임대는 그대로) → T7
        this.patchOrder(input.orderId, { status: 'RESERVED' });
        const j = this.jobRows.get(input.orderId);
        if (j) this.jobRows.set(input.orderId, { ...j, step: 'CONFIRM', attempts: 0, nextAttemptAtMs: this.clock.now(), confirmSentAtMs: undefined });
      }
      // GEN_CHANGED는 되돌리기만 한다(주문 seat_gen을 고치지 않는다, 리뷰 M1)
      return out;
    },
  };

  readonly failures = {
    fail: async (input: SagaFailInput): Promise<SagaFailOutcome> => {
      this.calls.push('failures.fail');
      this.leaseArgs.push({ call: 'failures.fail', leaseUntilMs: input.leaseUntilMs });
      this.failInputs.push(input);
      if (this.failOutcome instanceof Error) throw this.failOutcome;
      if (this.failOutcome.status === 'FAILED') {
        // 한 트랜잭션: 작업 행 단계 RELEASE(attempts 0) → 주문 FAILED. 작업 행은 실패 해제가 끝난 뒤 실행기가 지운다(리뷰 M4)
        this.patchOrder(input.orderId, { status: 'FAILED' });
        const j = this.jobRows.get(input.orderId);
        if (j) this.jobRows.set(input.orderId, { ...j, step: 'RELEASE', attempts: 0 });
      }
      return this.failOutcome;
    },
  };

  /**
   * DB가 할 일(PRF-171 설계 1): 한 트랜잭션에서 그 주문의 CONFIRM 작업 행을 지우지 않고 step = AWAIT로 바꾸고(confirm_sent_at 그대로) 결제 참조를 지운다.
   * CONFIRM 행이 없으면 false(아무것도 바꾸지 않는다)
   */
  readonly confirmSent = {
    done: async (orderId: string, leaseUntilMs?: number): Promise<boolean> => {
      this.calls.push('confirmSent.done');
      this.leaseArgs.push({ call: 'confirmSent.done', leaseUntilMs });
      this.doneOrders.push(orderId);
      const j = this.jobRows.get(orderId);
      if (!j || j.step !== 'CONFIRM') return false;
      this.jobRows.set(orderId, { ...j, step: 'AWAIT' });
      const o = this.orderRows.get(orderId);
      if (o?.attempt) this.orderRows.set(orderId, { ...o, attempt: { ...o.attempt, refs: undefined } });
      return true;
    },
  };

  readonly pins = {
    pin: async (input: OrderPinInput, _o?: { deadlineMs?: number }): Promise<OrderPinResult> => {
      this.calls.push('pins.pin');
      this.pinInputs.push(input);
      return this.next<OrderPinResult>(this.pinQueue, { status: 'OK', gen: input.orderGen });
    },
    releaseFailed: async (input: OrderReleaseInput, _o?: { deadlineMs?: number }): Promise<OrderReleaseResult> => {
      this.calls.push('pins.releaseFailed');
      this.releaseInputs.push(input);
      if (this.releaseResult instanceof Error) throw this.releaseResult;
      return this.releaseResult ?? { status: 'OK', released: input.seatIds.length };
    },
  };

  /**
   * 어댑터가 할 일: 차단기가 들여보내면(circuit_open이 아니면) 보내기 바로 전에 beforeSend를 부르고(던지면 보내지 않고 그대로 던진다) 보낸다.
   * 답은 큐에서 꺼낸다(비면 { ACCEPTED, IN_PROGRESS })
   */
  readonly confirms = {
    confirm: async (c: ConfirmCommand, o?: { beforeSend?: () => Promise<void> }): Promise<ConfirmOutcome> => {
      this.calls.push('confirms.confirm');
      this.confirmCommands.push(c);
      const v = this.confirmQueue.length > 0 ? this.confirmQueue.shift()! : ({ status: 'ACCEPTED', result: 'IN_PROGRESS' } as const);
      if (v instanceof Error) throw v;
      if (v.status === 'RETRYABLE' && v.reason === 'circuit_open') return v;
      await o?.beforeSend?.();
      this.sentCommands.push(c);
      return v;
    },
  };

  readonly configs = {
    get: async (_eventId: string): Promise<SagaEventConfig | undefined> => {
      this.calls.push('configs.get');
      return this.config;
    },
  };

  readonly log: SagaLog = {
    releaseFailed: (e) => {
      this.calls.push('log.releaseFailed');
      this.releaseLogs.push(e);
    },
    confirmRejected: (e) => {
      this.calls.push('log.confirmRejected');
      this.rejectLogs.push(e);
    },
    stepError: (e) => {
      this.calls.push('log.stepError');
      this.stepErrors.push(e);
    },
  };
}

let clock: FakeClock;
let fx: SagaFakes;
let timer: FakeTimer;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  fx = new SagaFakes(clock);
  timer = new FakeTimer();
});

const deps = (over: Partial<OrderSagaDeps> = {}): OrderSagaDeps => ({
  jobs: fx.jobs,
  orders: fx.orders,
  reserve: fx.reserve,
  failures: fx.failures,
  confirmSent: fx.confirmSent,
  pins: fx.pins,
  confirms: fx.confirms,
  configs: fx.configs,
  log: fx.log,
  clock,
  timer,
  ...over,
});
const runner = (over: Partial<OrderSagaDeps> = {}) => new OrderSagaRunner(deps(over));

/** seq의 호출이 calls에 이 차례로 있다(사이에 다른 호출이 끼어도 된다) */
function expectInOrder(calls: readonly string[], seq: readonly string[]): void {
  let from = 0;
  for (const c of seq) {
    const i = calls.indexOf(c, from);
    expect(i, `${seq.join(' → ')} 차례여야 한다(${c}): ${calls.join(', ')}`).toBeGreaterThanOrEqual(0);
    from = i + 1;
  }
}

/** 이 포트들은 부르지 않았다 */
function notCalled(...ports: Call[]): void {
  for (const p of ports) expect(fx.calls, `${p}를 부르면 안 된다`).not.toContain(p);
}

/** T8 실패 기록 입력(release 없음, 자기 임대 조건 = 집은 작업의 임대) */
const t8 = (reason: string) => ({ orderId: ORDER_ID, transition: 'T8', reason, actor: 'system:order-saga', leaseUntilMs: NOW + 30_000 });
/** 실패 해제 입력(좌석 차례는 보지 않는다) */
function expectRelease(input: OrderReleaseInput | undefined): void {
  expect(input).toBeDefined();
  expect({ ...input!, seatIds: [...input!.seatIds].sort() }).toEqual({ eventId: EVENT, accountId: ACCOUNT, holdId: HOLD_ID, seatIds: SEAT_IDS_SORTED, keepUntilMs: KEEP_UNTIL });
}

describe('RESERVE ① 승인 기한', () => {
  test('FR011_ADR0107_POL013_인증 + 10분을 넘겼으면 묶지 않고 T8 EXPIRED(과금 없음)이고, DB 실패 기록을 먼저 한 뒤 실패 해제한다', async () => {
    const order = sagaOrder({ attempt: tossAttempt({ authenticatedAtMs: NOW - 10 * MIN }) });
    fx.put(order);
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'EXPIRED' });
    notCalled('pins.pin', 'reserve.reserve', 'confirms.confirm', 'jobs.reschedule');
    expect(fx.failInputs).toEqual([t8('EXPIRED')]);
    expect(fx.failInputs[0]).not.toHaveProperty('release');
    expectInOrder(fx.calls, ['failures.fail', 'pins.releaseFailed']);
    expectRelease(fx.releaseInputs[0]);
  });

  test('FR011_ADR0107_인증 + 10분 1ms 전이면 묶는다', async () => {
    const order = sagaOrder({ attempt: tossAttempt({ authenticatedAtMs: NOW - 10 * MIN + 1 }) });
    fx.put(order);
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    expect(fx.pinInputs).toHaveLength(1);
    notCalled('failures.fail');
  });

  test('FR011_ADR0107_결제 시도의 인증 시각이 없으면 기한을 넘긴 것으로 보고 묶지 않는다(T8 EXPIRED, 정본 모호: 정본은 인증 시각이 없는 경우를 말하지 않는다. 뼈대 주석 isPastConfirmDeadline대로)', async () => {
    const order = sagaOrder({ attempt: tossAttempt({ authenticatedAtMs: undefined }) });
    fx.put(order);
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'EXPIRED' });
    notCalled('pins.pin', 'reserve.reserve');
  });
});

describe('RESERVE ② 좌석 묶기', () => {
  test('FR011_ST35_묶기 입력: 회차·계정·주문의 holdId·구매 세션 ID(jti 모양 그대로)·주문 좌석·회차 1인 한도·주문 seat_gen·회차 키 만료(판매 종료 + 1일)', async () => {
    const order = sagaOrder();
    fx.put(order);
    await runner().reserveStep(sagaJob(), order);
    expect(fx.pinInputs).toHaveLength(1);
    const p = fx.pinInputs[0]!;
    expect({ ...p, seatIds: [...p.seatIds].sort() }).toEqual({
      eventId: EVENT,
      accountId: ACCOUNT,
      holdId: HOLD_ID,
      purchaseSessionId: SAGA_PSID,
      seatIds: SEAT_IDS_SORTED,
      limit: 4,
      orderGen: SEAT_GEN,
      keepUntilMs: KEEP_UNTIL,
    });
  });

  test('FR011_묶기 OK면 판매 예약 트랜잭션을 부른다: 주문·회차·계정·좌석·한도·주문 판 번호·행위자 system:order-saga', async () => {
    const order = sagaOrder();
    fx.put(order);
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    expectInOrder(fx.calls, ['pins.pin', 'reserve.reserve']);
    expect(fx.reserveInputs).toHaveLength(1);
    const r = fx.reserveInputs[0]!;
    // 자기 임대 조건(작업 행을 CONFIRM으로 바꾸는 문장에 건다, 리뷰 낮음)
    expect({ ...r, seatIds: [...r.seatIds].sort() }).toEqual({
      orderId: ORDER_ID,
      eventId: EVENT,
      accountId: ACCOUNT,
      seatIds: SEAT_IDS_SORTED,
      limit: 4,
      orderGen: SEAT_GEN,
      actor: ORDER_SAGA_ACTOR,
      leaseUntilMs: NOW + 30_000,
    });
    expect(ORDER_SAGA_ACTOR).toBe('system:order-saga');
  });

  test('FR011_reserveStep만으로는 승인 명령을 보내지 않는다(ADVANCED까지. CONFIRM은 runJob이 잇는다)', async () => {
    const order = sagaOrder();
    fx.put(order);
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    notCalled('confirms.confirm', 'confirmSent.done', 'failures.fail', 'pins.releaseFailed', 'jobs.reschedule');
  });

  test.each<[OrderPinResult, string]>([
    [{ status: 'TAKEN' }, 'SEAT_TAKEN'],
    [{ status: 'QUOTA_EXCEEDED' }, 'QUOTA_EXCEEDED'],
    [{ status: 'STALE_GEN', gen: SEAT_GEN + 1 }, 'STALE_GEN'],
  ])('FR011_POL013_묶기 %o면 판매 예약을 하지 않고 T8(사유 %s)이며, DB 실패 기록을 먼저 커밋한 뒤 실패 해제한다', async (pin, reason) => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [pin];
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toEqual({ kind: 'FAILED', transition: 'T8', reason });
    notCalled('reserve.reserve', 'confirms.confirm', 'jobs.reschedule');
    expect(fx.failInputs).toEqual([t8(reason)]);
    expectInOrder(fx.calls, ['pins.pin', 'failures.fail', 'pins.releaseFailed']);
    expect(fx.releaseInputs).toHaveLength(1);
    expectRelease(fx.releaseInputs[0]);
  });

  test.each([
    [0, NOW + 1000],
    [1, NOW + 2000],
    [3, NOW + 8000],
    [7, NOW + 10_000],
  ])('FR011_묶기 NOT_READY(회차 키 수명 안)면 다시 하기다: attempts %i → 다음 시각 %i(지금 + sagaRetryDelayMs(attempts + 1))', async (attempts, nextAtMs) => {
    const order = sagaOrder();
    fx.put(order, sagaJob({ attempts }));
    fx.pinQueue = [{ status: 'NOT_READY' }];
    const out = await runner().reserveStep(sagaJob({ attempts }), order);
    expect(out).toEqual({ kind: 'RETRY', reason: 'not_ready', nextAtMs });
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs }]);
    notCalled('reserve.reserve', 'failures.fail', 'pins.releaseFailed');
  });

  test('FR011_묶기 NOT_READY인데 회차 키 수명(판매 종료 + 1일)이 지났으면 끝없이 다시 하지 않고 T8 STORE_GONE이다(정확히 경계 시각)', async () => {
    fx.config = { perAccountLimit: 4, saleEndsAtMs: NOW - DAY };
    // 승인 기한은 아직 안이다(인증 2분 전)
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'NOT_READY' }];
    // 회차 키가 지워진 뒤라 실패 해제도 NOT_READY다(해제가 끝난 것으로 본다)
    fx.releaseResult = { status: 'NOT_READY' };
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'STORE_GONE' });
    expect(fx.failInputs).toEqual([t8('STORE_GONE')]);
    notCalled('reserve.reserve', 'jobs.reschedule', 'log.releaseFailed');
  });

  test('FR011_회차 키 수명 1ms 전의 NOT_READY는 아직 다시 하기다', async () => {
    fx.config = { perAccountLimit: 4, saleEndsAtMs: NOW - DAY + 1 };
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'NOT_READY' }];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'RETRY', reason: 'not_ready', nextAtMs: NOW + 1000 });
    notCalled('failures.fail');
  });

  test('FR011_묶기 FAILED_HOLD(이미 실패 해제한 홀드, 늦은 묶기)면 SKIPPED FAILED_HOLD이고 판매 예약·실패 기록·실패 해제·다시 하기를 하지 않는다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'FAILED_HOLD' }];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'SKIPPED', reason: 'FAILED_HOLD' });
    notCalled('reserve.reserve', 'failures.fail', 'pins.releaseFailed', 'jobs.reschedule');
  });

  test('FR011_묶기가 좌석 Redis 일시 장애(OrderSeatStoreUnavailable)면 다시 하기 seat_store_unavailable이다(실패로 끝내지 않는다)', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [new OrderSeatStoreUnavailable(new Error('ECONNRESET'))];
    expect(await runner().runJob(sagaJob())).toEqual({ kind: 'RETRY', reason: 'seat_store_unavailable', nextAtMs: NOW + 1000 });
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 1000 }]);
    notCalled('reserve.reserve', 'failures.fail', 'pins.releaseFailed');
  });

  test('FR011_주문이 ACCEPTED가 아니면(RESERVED·FAILED·EXPIRED) reserveStep은 SKIPPED ORDER_STATE이고 아무 포트도 쓰지 않는다', async () => {
    for (const status of ['RESERVED', 'FAILED', 'EXPIRED'] as const) {
      fx.calls = [];
      const order = sagaOrder({ status });
      fx.put(order);
      expect(await runner().reserveStep(sagaJob(), order), status).toEqual({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
      notCalled('pins.pin', 'reserve.reserve', 'failures.fail', 'pins.releaseFailed', 'confirms.confirm');
    }
  });
});

describe('RESERVE ② 묶기 OK 뒤 pinned_at 적기(PRF-167, K1)', () => {
  test('ST26_④_묶기가 OK면 판매 예약 전에 주문 판 번호와 pinned_at을 한 번에 적고(recordPinned(주문, 주문 판 번호, 묶기 판 번호), 판 번호가 같아도 부른다), 묶기가 실패하면 적지 않는다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'OK', gen: SEAT_GEN }];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    expect(fx.pinnedOrders).toEqual([ORDER_ID]);
    expect(fx.pinnedGens).toEqual([{ orderId: ORDER_ID, fromGen: SEAT_GEN, toGen: SEAT_GEN }]);
    expectInOrder(fx.calls, ['pins.pin', 'orders.recordPinned', 'reserve.reserve']);
  });

  test('ST26_④_묶기가 TAKEN이면 pinned_at을 적지 않는다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'TAKEN' }];
    await runner().reserveStep(sagaJob(), order);
    notCalled('orders.recordPinned');
  });

  test('ST26_④_pinned_at을 적지 못하면(주문이 그 사이 ACCEPTED가 아님) 판매 예약을 부르지 않고 건너뛴다', async () => {
    const order = sagaOrder();
    fx.put({ ...order, status: 'FAILED' });
    fx.pinQueue = [{ status: 'OK', gen: SEAT_GEN }];
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toMatchObject({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
    notCalled('reserve.reserve');
  });
});

describe('RESERVE ③ 판매 예약 트랜잭션', () => {
  // 리뷰 고침 M1(2026-11-05, 명세 pin·saleStep): GEN_CHANGED 뒤에는 주문 seat_gen을 새 번호로 고치지 않고 그 번호 그대로 다시 묶는다
  // (내 홀드가 남았을 때만 OK, 빈 좌석이면 STALE_GEN). 묶기가 OK면 그 결과의 판 번호를 주문 seat_gen에 적고(recordPinned, 리뷰 고침 L5로 pinned_at과 합침) 그 번호로 판매 예약한다
  test('M1_OPEN15_판매 예약이 GEN_CHANGED면 주문 판 번호를 고치지 않고 그 번호 그대로 다시 묶는다. 묶기가 OK(새 판 번호)면 그 번호를 주문에 적고 그 번호로 판매 예약한다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = [{ status: 'GEN_CHANGED', gen: SEAT_GEN + 2 }];
    // 다시 만들기 뒤에도 내 홀드가 남아 있어 묶기가 지금 판 번호(SEAT_GEN + 2)로 OK다
    fx.pinQueue = [
      { status: 'OK', gen: SEAT_GEN },
      { status: 'OK', gen: SEAT_GEN + 2 },
    ];
    const out = await runner().reserveStep(sagaJob(), order);
    expect(out).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    expect(fx.pinInputs.map((p) => p.orderGen)).toEqual([SEAT_GEN, SEAT_GEN]);
    // 묶기가 OK일 때마다 한 번(리뷰 고침 L5): 처음은 같은 판 번호, 다시 묶기는 새 판 번호
    expect(fx.pinnedGens).toEqual([
      { orderId: ORDER_ID, fromGen: SEAT_GEN, toGen: SEAT_GEN },
      { orderId: ORDER_ID, fromGen: SEAT_GEN, toGen: SEAT_GEN + 2 },
    ]);
    expect(fx.reserveInputs.map((r) => r.orderGen)).toEqual([SEAT_GEN, SEAT_GEN + 2]);
    expectInOrder(fx.calls, ['pins.pin', 'orders.recordPinned', 'reserve.reserve', 'pins.pin', 'orders.recordPinned', 'reserve.reserve']);
    notCalled('failures.fail', 'jobs.reschedule');
  });

  test('M1_OPEN15_GEN_CHANGED 뒤 다시 묶기에서 빈 좌석이 있으면(묶기 STALE_GEN) 빈 좌석을 다시 잡지 않고 T8 STALE_GEN이며 주문 seat_gen은 그대로다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = [{ status: 'GEN_CHANGED', gen: SEAT_GEN + 1 }];
    fx.pinQueue = [
      { status: 'OK', gen: SEAT_GEN },
      { status: 'STALE_GEN', gen: SEAT_GEN + 1 },
    ];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'STALE_GEN' });
    expect(fx.pinInputs.map((p) => p.orderGen)).toEqual([SEAT_GEN, SEAT_GEN]);
    expect(fx.orderRows.get(ORDER_ID)?.seatGen).toBe(SEAT_GEN);
    // 처음 묶기(OK)만 적었다. 두 번째 묶기(STALE_GEN)는 적지 않는다
    expect(fx.pinnedGens).toEqual([{ orderId: ORDER_ID, fromGen: SEAT_GEN, toGen: SEAT_GEN }]);
  });

  test(`FR011_OPEN15_판 번호가 SAGA_GEN_RESTART_MAX(${SAGA_GEN_RESTART_MAX})번 바뀌어도 같은 실행에서 묶기부터 다시 해 RESERVED면 ADVANCED다`, async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = Array.from({ length: SAGA_GEN_RESTART_MAX }, (_, i) => ({ status: 'GEN_CHANGED' as const, gen: SEAT_GEN + 1 + i }));
    fx.pinQueue = Array.from({ length: SAGA_GEN_RESTART_MAX + 1 }, (_, i) => ({ status: 'OK' as const, gen: SEAT_GEN + i }));
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    expect(fx.pinInputs).toHaveLength(SAGA_GEN_RESTART_MAX + 1);
    expect(fx.reserveInputs.map((r) => r.orderGen)).toEqual(Array.from({ length: SAGA_GEN_RESTART_MAX + 1 }, (_, i) => SEAT_GEN + i));
    expect(fx.orderRows.get(ORDER_ID)?.seatGen).toBe(SEAT_GEN + SAGA_GEN_RESTART_MAX);
    expect(SAGA_GEN_RESTART_MAX).toBe(3);
  });

  test('FR011_OPEN15_판 번호가 상한보다 한 번 더 바뀌면 묶기를 더 하지 않고 다시 하기(gen_changed)로 미룬다(정본 모호: 정본은 횟수 상한을 정하지 않았다. 뼈대의 3번 [가정]대로 "3번 다시 묶은 뒤의 네 번째 바뀜"에서 멈춘다고 본다)', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = Array.from({ length: SAGA_GEN_RESTART_MAX + 1 }, (_, i) => ({ status: 'GEN_CHANGED' as const, gen: SEAT_GEN + 1 + i }));
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'RETRY', reason: 'gen_changed', nextAtMs: NOW + 1000 });
    expect(fx.pinInputs).toHaveLength(SAGA_GEN_RESTART_MAX + 1);
    expect(fx.reserveInputs).toHaveLength(SAGA_GEN_RESTART_MAX + 1);
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 1000 }]);
    notCalled('failures.fail', 'pins.releaseFailed');
  });

  test('FR011_OPEN15_다시 묶다가 묶기가 STALE_GEN이면 그때 T8 STALE_GEN과 실패 해제다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = [{ status: 'GEN_CHANGED', gen: SEAT_GEN + 1 }];
    fx.pinQueue = [{ status: 'OK', gen: SEAT_GEN }, { status: 'STALE_GEN', gen: SEAT_GEN + 2 }];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'STALE_GEN' });
    expectInOrder(fx.calls, ['reserve.reserve', 'pins.pin', 'failures.fail', 'pins.releaseFailed']);
  });

  test.each<[ReserveTxOutcome, string]>([
    [{ status: 'SEAT_TAKEN', seatIds: [SEAT_1] }, 'SEAT_TAKEN'],
    [{ status: 'QUOTA_EXCEEDED' }, 'QUOTA_EXCEEDED'],
  ])('FR011_POL013_판매 예약이 %o면 따로 T8(사유 %s)과 실패 해제다(DB 실패 기록 → 해제 차례)', async (reserved, reason) => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = [reserved];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason });
    expect(fx.failInputs).toEqual([t8(reason)]);
    expectInOrder(fx.calls, ['reserve.reserve', 'failures.fail', 'pins.releaseFailed']);
    expectRelease(fx.releaseInputs[0]);
    notCalled('confirms.confirm', 'jobs.reschedule');
  });

  test('FR011_판매 예약이 ORDER_STATE(다른 실행이 먼저 함)면 SKIPPED ORDER_STATE로 끝내고 실패 기록·실패 해제·승인 명령을 하지 않는다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.reserveQueue = [{ status: 'ORDER_STATE', current: 'RESERVED' }];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
    notCalled('failures.fail', 'pins.releaseFailed', 'confirms.confirm');
    expect(fx.pinInputs).toHaveLength(1);
  });
});

describe('실패 해제', () => {
  // 리뷰 고침 M4(2026-11-05): 실패 해제가 끝나지 못하면 작업 행을 지우지 않고 단계 RELEASE로 남겨 다시 한다(실패 기록 트랜잭션이 단계를 RELEASE로 바꾼다)
  test('M4_실패 해제가 좌석 Redis 장애로 끝나지 못해도 결과는 FAILED이고 warn 한 줄이며, 작업 행은 RELEASE 단계로 남아 다시 하기(지금 + 1초)로 미룬다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'TAKEN' }];
    fx.releaseResult = new OrderSeatStoreUnavailable(new Error('ECONNRESET'));
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'SEAT_TAKEN' });
    expect(fx.releaseLogs).toHaveLength(1);
    expect(fx.releaseLogs[0]).toMatchObject({ orderId: ORDER_ID, eventId: EVENT });
    expect(typeof fx.releaseLogs[0]!.why).toBe('string');
    expect(fx.jobRows.get(ORDER_ID)).toMatchObject({ step: 'RELEASE', attempts: 1, nextAttemptAtMs: NOW + 1000 });
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 1000 }]);
    notCalled('jobs.delete');
  });

  test('M4_실패 해제가 OK면 실행기가 작업 행(단계 RELEASE, 자기 임대 조건)을 지운다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'TAKEN' }];
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'SEAT_TAKEN' });
    expect(fx.jobRows.has(ORDER_ID)).toBe(false);
    expect(fx.deletes).toEqual([{ orderId: ORDER_ID, step: 'RELEASE' }]);
    expectInOrder(fx.calls, ['failures.fail', 'pins.releaseFailed', 'jobs.delete']);
    notCalled('jobs.reschedule');
  });

  test('M4_RELEASE 작업은 묶기·판매 예약·승인 없이 실패 해제를 다시 하고, OK면 작업 행을 지워 RELEASED다', async () => {
    const order = sagaOrder({ status: 'FAILED' });
    const job = sagaJob({ step: 'RELEASE', attempts: 2 });
    fx.put(order, job);
    expect(await runner().runJob(job)).toEqual({ kind: 'RELEASED' });
    expectRelease(fx.releaseInputs[0]);
    expect(fx.jobRows.has(ORDER_ID)).toBe(false);
    notCalled('pins.pin', 'reserve.reserve', 'failures.fail', 'confirms.confirm', 'jobs.reschedule');
  });

  test('P-T36 ④_리뷰 고침 H1: 티켓 무효가 끝나지 않은 주문의 RELEASE는 좌석을 풀지 않고 다시 하기로 미룬다(무효 전에 좌석이 다시 팔리지 않게) [ASVS v5.0.0-15.4.1]', async () => {
    const job = sagaJob({ step: 'RELEASE', attempts: 2 });
    fx.put(sagaOrder({ status: 'FAILED', ticketVoidPending: true }), job);
    expect(await runner().runJob(job)).toEqual({ kind: 'RETRY', reason: 'ticket_void_pending', nextAtMs: NOW + 4000 });
    expect(fx.releaseInputs).toEqual([]);
    expect(fx.jobRows.has(ORDER_ID)).toBe(true);
    notCalled('pins.releaseFailed', 'jobs.delete');
  });

  test('P-T36 ④_리뷰 고침 H1: 무효가 끝나면 같은 RELEASE 작업이 좌석을 푼다', async () => {
    const job = sagaJob({ step: 'RELEASE', attempts: 2 });
    fx.put(sagaOrder({ status: 'FAILED', ticketVoidPending: false }), job);
    expect(await runner().runJob(job)).toEqual({ kind: 'RELEASED' });
    expectRelease(fx.releaseInputs[0]);
    expect(fx.jobRows.has(ORDER_ID)).toBe(false);
  });

  test('M4_RELEASE 작업의 실패 해제가 좌석 Redis 장애·회차 키 수명 안의 NOT_READY면 다시 하기(release_failed)이고, 수명 뒤 NOT_READY면 끝난 것으로 지운다', async () => {
    const job = sagaJob({ step: 'RELEASE', attempts: 2 });
    fx.put(sagaOrder({ status: 'FAILED' }), job);
    fx.releaseResult = new OrderSeatStoreUnavailable(new Error('ECONNRESET'));
    expect(await runner().runJob(job)).toEqual({ kind: 'RETRY', reason: 'release_failed', nextAtMs: NOW + 4000 });
    fx.releaseResult = { status: 'NOT_READY' };
    expect(await runner().runJob(job)).toEqual({ kind: 'RETRY', reason: 'release_failed', nextAtMs: NOW + 4000 });
    expect(fx.jobRows.has(ORDER_ID)).toBe(true);
    fx.config = { perAccountLimit: 4, saleEndsAtMs: NOW - DAY };
    expect(await runner().runJob(job)).toEqual({ kind: 'RELEASED' });
    expect(fx.jobRows.has(ORDER_ID)).toBe(false);
  });

  test('FR011_실패 해제가 회차 키 수명 안에서 NOT_READY면 끝나지 못한 것이라 warn 한 줄이다(정본 모호: 정본은 수명 뒤의 NOT_READY만 "끝난 것"으로 정한다. 수명 안은 끝나지 못한 쪽으로 본다)', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'QUOTA_EXCEEDED' }];
    fx.releaseResult = { status: 'NOT_READY' };
    expect(await runner().reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'QUOTA_EXCEEDED' });
    expect(fx.releaseLogs).toHaveLength(1);
    // 끝나지 못했으니 RELEASE 작업이 남아 다시 한다(리뷰 M4)
    expect(fx.jobRows.get(ORDER_ID)?.step).toBe('RELEASE');
  });

  // 리뷰 고침 M3(2026-11-05): 실패 기록이 STALE이면(주문이 그 사이 다른 상태로 감) 그 자리에서 reschedule해 임대를 푼다(실패 해제는 하지 않는다)
  test('M3_실패 기록이 STALE이면 실패 해제를 하지 않고 그 자리에서 다시 하기로 미뤄 임대를 푼다(SKIPPED ORDER_STATE)', async () => {
    fx.put(sagaOrder());
    fx.pinQueue = [{ status: 'TAKEN' }];
    fx.failOutcome = { status: 'STALE', current: 'RESERVED' };
    expect(await runner().runJob(sagaJob())).toEqual({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
    notCalled('pins.releaseFailed');
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 1000 }]);
    expect(fx.jobRows.get(ORDER_ID)?.leaseUntilMs).toBeUndefined();
  });

  test('FR011_DB 실패 기록이 던지면(되돌림) 실패 해제를 하지 않고 다시 하기다(runJob, 오류 로그 뒤)', async () => {
    fx.put(sagaOrder());
    fx.pinQueue = [{ status: 'TAKEN' }];
    fx.failOutcome = new Error('connection terminated');
    expect(await runner().runJob(sagaJob())).toEqual({ kind: 'RETRY', reason: 'error', nextAtMs: NOW + 1000 });
    notCalled('pins.releaseFailed');
    expect(fx.stepErrors).toHaveLength(1);
    expect(fx.stepErrors[0]).toMatchObject({ orderId: ORDER_ID, step: 'RESERVE' });
  });
});

describe('CONFIRM 승인 명령', () => {
  const reserved = (over: Partial<SagaOrderView> = {}) => sagaOrder({ status: 'RESERVED', ...over });
  const confirmJob = (over: Partial<SagaJob> = {}) => sagaJob({ step: 'CONFIRM', ...over });

  test('FR011_토스 승인 명령: 주문·시도·결제사·결제 참조{TOSS, paymentKey}·서버 금액·데드라인 200ms. ACCEPTED면 ConfirmSent.done(결제 참조 지우기·작업 행 AWAIT, PRF-171) 뒤 DONE', async () => {
    const order = reserved();
    fx.put(order, confirmJob());
    const out = await runner().confirmStep(confirmJob(), order);
    expect(out).toEqual({ kind: 'DONE' });
    expect(fx.confirmCommands).toEqual([{ orderId: ORDER_ID, attemptId: ATTEMPT_ID, eventId: EVENT, attemptNo: 1, authenticatedAtMs: NOW - 2 * MIN, pg: 'TOSS', refs: { pg: 'TOSS', paymentKey: PAYMENT_KEY }, amount: AMOUNT, deadlineMs: 200 }]);
    expectInOrder(fx.calls, ['confirms.confirm', 'confirmSent.done']);
    expect(fx.doneOrders).toEqual([ORDER_ID]);
    expect(fx.jobRows.get(ORDER_ID)?.step).toBe('AWAIT');
    notCalled('failures.fail', 'pins.releaseFailed', 'jobs.reschedule', 'pins.pin', 'reserve.reserve', 'jobs.delete');
  });

  test('PT26_회차 판의 입장 시각을 승인 명령에 싣는다. 판에 없거나 판을 읽지 못해도 승인 명령은 보낸다(HOT-152가 넘긴 것, BUILD_ORDER PRF-191)', async () => {
    const order = reserved();
    fx.put(order, confirmJob());
    fx.config = { perAccountLimit: 4, saleEndsAtMs: NOW + 86_400_000, entryOpensAtMs: NOW + 172_800_000 };
    await runner().confirmStep(confirmJob(), order);
    expect(fx.confirmCommands[0]).toMatchObject({ entryOpensAtMs: NOW + 172_800_000 });
  });

  test('PT26_판이 없어도 승인 명령은 보내고 입장 시각 칸만 뺀다', async () => {
    const order = reserved();
    fx.put(order, confirmJob());
    fx.config = undefined;
    expect(await runner().confirmStep(confirmJob(), order)).toEqual({ kind: 'DONE' });
    expect(fx.confirmCommands[0]).not.toHaveProperty('entryOpensAtMs');
  });

  test('FR011_시뮬레이터는 토스 칸(paymentKey)을 쓴다', async () => {
    const order = reserved({ attempt: tossAttempt({ pg: 'SIMULATOR', refs: { pg: 'SIMULATOR', paymentKey: PAYMENT_KEY } }) });
    fx.put(order, confirmJob());
    await runner().confirmStep(confirmJob(), order);
    expect(fx.confirmCommands[0]).toMatchObject({ pg: 'SIMULATOR', refs: { pg: 'SIMULATOR', paymentKey: PAYMENT_KEY } });
  });

  test('FR011_포트원 승인 명령의 결제 참조는 {PORTONE, paymentId = 시도의 pg_order_ref, txId, paymentToken}이다', async () => {
    const order = reserved({ attempt: tossAttempt({ pg: 'PORTONE', pgOrderRef: PORTONE_PAYMENT_ID, refs: { pg: 'PORTONE', txId: TX_ID, paymentToken: PAYMENT_TOKEN } }) });
    fx.put(order, confirmJob());
    await runner().confirmStep(confirmJob(), order);
    expect(fx.confirmCommands).toHaveLength(1);
    expect(fx.confirmCommands[0]!.refs).toEqual({ pg: 'PORTONE', paymentId: PORTONE_PAYMENT_ID, txId: TX_ID, paymentToken: PAYMENT_TOKEN });
    expect(fx.confirmCommands[0]!.pg).toBe('PORTONE');
  });

  test.each([
    [10 * MIN - 150, 150],
    [10 * MIN - 1, 1],
    [10 * MIN - 200, 200],
    [10 * MIN - 201, 200],
  ])('FR011_ADR0107_데드라인은 min(200ms, 승인 기한까지 남은 시간)이다: 인증 %ims 뒤 → %ims', async (elapsed, deadlineMs) => {
    const order = reserved({ attempt: tossAttempt({ authenticatedAtMs: NOW - elapsed }) });
    fx.put(order, confirmJob());
    await runner().confirmStep(confirmJob(), order);
    expect(fx.confirmCommands.map((c) => c.deadlineMs)).toEqual([deadlineMs]);
  });

  test('FR011_ADR0107_POL013_승인 기한을 넘겼으면(정확히 인증 + 10분) 보내지 않고 T11 EXPIRED(판매 행 PENDING 지우기 release 실림) 뒤 실패 해제다', async () => {
    const order = reserved({ attempt: tossAttempt({ authenticatedAtMs: NOW - 10 * MIN }) });
    fx.put(order, confirmJob());
    expect(await runner().confirmStep(confirmJob(), order)).toEqual({ kind: 'FAILED', transition: 'T11', reason: 'EXPIRED' });
    notCalled('confirms.confirm', 'confirmSent.done', 'jobs.reschedule');
    expect(fx.failInputs).toHaveLength(1);
    const f = fx.failInputs[0]!;
    expect({ ...f, release: f.release && { ...f.release, seatIds: [...f.release.seatIds].sort() } }).toEqual({
      orderId: ORDER_ID,
      transition: 'T11',
      reason: 'EXPIRED',
      actor: 'system:order-saga',
      leaseUntilMs: NOW + 30_000,
      release: { eventId: EVENT, orderId: ORDER_ID, accountId: ACCOUNT, seatIds: SEAT_IDS_SORTED },
    });
    expectInOrder(fx.calls, ['failures.fail', 'pins.releaseFailed']);
    expectRelease(fx.releaseInputs[0]);
  });

  test.each(['deadline', 'unavailable', 'circuit_open'] as const)('FR011_RETRYABLE(%s)이면 기한 안에서 다시 보낸다(다시 하기 confirm_retryable, 지금 + 간격)', async (reason) => {
    const order = reserved();
    fx.put(order, confirmJob({ attempts: 2 }));
    fx.confirmQueue = [{ status: 'RETRYABLE', reason }];
    expect(await runner().confirmStep(confirmJob({ attempts: 2 }), order)).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: NOW + 4000 });
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 4000 }]);
    notCalled('confirmSent.done', 'failures.fail', 'pins.releaseFailed');
  });

  // 리뷰 고침 H1(2026-11-05): 승인 명령을 한 번이라도 보냈으면(작업 행 confirm_sent_at) purchase는 혼자 T11을 하지 않는다
  // (결과를 모르는 명령이 payment-svc에 적혔을 수 있다: 결제는 됐는데 주문이 FAILED가 된다). 같은 주문 ID로 계속 다시 보내고 결과는 trade.payments로 온다(PRF-163)
  test('H1_대역이 매번 200ms를 넘겨 답해도(RETRYABLE deadline) 승인 기한이 지난 뒤의 runJob은 T11을 하지 않고 같은 주문 ID로 다시 보낸다: 주문 RESERVED 그대로·판매 행 지우기·실패 해제 없음', async () => {
    const order = reserved({ attempt: tossAttempt({ authenticatedAtMs: NOW - 10 * MIN + 500 }) });
    fx.put(order, confirmJob());
    fx.confirmQueue = [
      { status: 'RETRYABLE', reason: 'deadline' },
      { status: 'RETRYABLE', reason: 'deadline' },
    ];
    const r = runner();
    expect(await r.runJob(confirmJob())).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: NOW + 1000 });
    // 보내기 바로 전에 보낸 시각을 적었다(커밋한 뒤 보낸다)
    expect(fx.jobRows.get(ORDER_ID)?.confirmSentAtMs).toBe(NOW);
    clock.advance(1000);
    const job = { ...fx.jobRows.get(ORDER_ID)!, leaseUntilMs: clock.now() + 30_000 };
    expect(await r.runJob(job)).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: clock.now() + 2000 });
    expect(fx.sentCommands.map((c) => [c.orderId, c.deadlineMs])).toEqual([
      [ORDER_ID, 200],
      [ORDER_ID, 200],
    ]);
    notCalled('failures.fail', 'pins.releaseFailed', 'confirmSent.done');
    expect(fx.orderRows.get(ORDER_ID)?.status).toBe('RESERVED');
  });

  test('H1_ADR0107_차단기 열림만 계속돼 한 번도 보내지 않았으면(confirm_sent_at 비움) 승인 기한 뒤에는 혼자 T11 EXPIRED·판매 행 지우기·실패 해제다', async () => {
    const order = reserved({ attempt: tossAttempt({ authenticatedAtMs: NOW - 10 * MIN + 500 }) });
    fx.put(order, confirmJob());
    fx.confirmQueue = [{ status: 'RETRYABLE', reason: 'circuit_open' }];
    const r = runner();
    expect((await r.runJob(confirmJob())).kind).toBe('RETRY');
    expect(fx.jobRows.get(ORDER_ID)?.confirmSentAtMs).toBeUndefined();
    clock.advance(1000);
    const job = { ...fx.jobRows.get(ORDER_ID)!, leaseUntilMs: clock.now() + 30_000 };
    expect(await r.runJob(job)).toEqual({ kind: 'FAILED', transition: 'T11', reason: 'EXPIRED' });
    expect(fx.sentCommands).toEqual([]);
    expect(fx.failInputs.map((f) => [f.transition, f.reason])).toEqual([['T11', 'EXPIRED']]);
    expect(fx.releaseInputs).toHaveLength(1);
  });

  test('H1_보낸 시각을 적지 못하면(임대를 잃음) 보내지 않고 SKIPPED LEASED다', async () => {
    const order = reserved();
    fx.put(order, confirmJob());
    fx.markFails = true;
    expect(await runner().confirmStep(confirmJob(), order)).toEqual({ kind: 'SKIPPED', reason: 'LEASED' });
    expect(fx.sentCommands).toEqual([]);
    notCalled('confirmSent.done', 'jobs.reschedule', 'failures.fail');
  });

  test(`H1_REJECTED(정해진 거절)면 SEV2 오류 로그(log.confirmRejected: 주문·까닭) 뒤 작업을 ${SAGA_CONFIRM_PARK_MS / 60_000}분 [가정] 멈춘다(실패로 끝내지 않는다. 결과 당기기 PRF-171이 맞춘다)`, async () => {
    const order = reserved();
    fx.put(order, confirmJob());
    fx.confirmQueue = [{ status: 'REJECTED', reason: 'failed_precondition' }];
    expect(await runner().confirmStep(confirmJob(), order)).toEqual({ kind: 'RETRY', reason: 'confirm_rejected', nextAtMs: NOW + 60 * MIN });
    expect(SAGA_CONFIRM_PARK_MS).toBe(60 * MIN);
    expect(fx.rejectLogs).toEqual([{ orderId: ORDER_ID, reason: 'failed_precondition' }]);
    expectInOrder(fx.calls, ['confirms.confirm', 'log.confirmRejected', 'jobs.reschedule']);
    notCalled('failures.fail', 'pins.releaseFailed', 'confirmSent.done');
  });

  test('FR011_주문이 RESERVED가 아니면(ACCEPTED·FAILED·APPROVED) confirmStep은 SKIPPED ORDER_STATE이고 승인 명령을 보내지 않는다', async () => {
    for (const status of ['ACCEPTED', 'FAILED', 'APPROVED'] as const) {
      fx.calls = [];
      const order = reserved({ status });
      fx.put(order, confirmJob());
      expect(await runner().confirmStep(confirmJob(), order), status).toEqual({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
      notCalled('confirms.confirm', 'failures.fail', 'pins.releaseFailed', 'confirmSent.done');
    }
  });

  // 리뷰 고침 M3(2026-11-05): ORDER_STATE로 건너뛸 때 주문이 그 단계를 지났으면 한 트랜잭션에서 작업 행(WHERE step = 지금 단계)과 결제 참조를 지운다
  test('M3_CONFIRM 작업인데 주문이 그 단계를 지났으면(APPROVED·FAILED) 작업 행과 결제 참조를 지운다(abandon REMOVED). ACCEPTED면 남기고 다시 하기로 미룬다', async () => {
    for (const status of ['APPROVED', 'FAILED'] as const) {
      const order = reserved({ status });
      fx.put(order, confirmJob());
      expect(await runner().confirmStep(confirmJob(), order), status).toEqual({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
      expect(fx.jobRows.has(ORDER_ID), status).toBe(false);
      expect(fx.orderRows.get(ORDER_ID)?.attempt?.refs, status).toBeUndefined();
    }
    expect(fx.abandons).toEqual([
      { orderId: ORDER_ID, step: 'CONFIRM' },
      { orderId: ORDER_ID, step: 'CONFIRM' },
    ]);
    fx.reschedules = [];
    const accepted = reserved({ status: 'ACCEPTED' });
    fx.put(accepted, confirmJob());
    expect(await runner().confirmStep(confirmJob(), accepted)).toEqual({ kind: 'SKIPPED', reason: 'ORDER_STATE' });
    expect(fx.jobRows.has(ORDER_ID)).toBe(true);
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 1000 }]);
  });

  test('FR011_승인 명령 포트가 예상 밖으로 던지면(runJob) 오류 로그(step CONFIRM) 뒤 다시 하기 error다', async () => {
    fx.put(reserved(), confirmJob());
    fx.confirmQueue = [new TypeError('boom')];
    expect(await runner().runJob(confirmJob())).toEqual({ kind: 'RETRY', reason: 'error', nextAtMs: NOW + 1000 });
    expect(fx.stepErrors).toHaveLength(1);
    expect(fx.stepErrors[0]).toMatchObject({ orderId: ORDER_ID, step: 'CONFIRM' });
    notCalled('failures.fail', 'confirmSent.done');
  });
});

describe('runJob: 한 작업을 끝까지', () => {
  test('FR011_RESERVE 작업은 주문을 읽고 묶기 → 판매 예약 → (같은 실행에서) 승인 명령 → 정리까지 돌아 DONE이다. 작업 행은 지우지 않고 AWAIT로 남는다(결과 당기기가 찾는다, PRF-171) (ADR0140)', async () => {
    fx.put(sagaOrder());
    expect(await runner().runJob(sagaJob())).toEqual({ kind: 'DONE' });
    expectInOrder(fx.calls, ['orders.read', 'pins.pin', 'reserve.reserve', 'confirms.confirm', 'confirmSent.done']);
    expect(fx.confirmCommands).toHaveLength(1);
    expect(fx.jobRows.get(ORDER_ID)).toMatchObject({ step: 'AWAIT', confirmSentAtMs: NOW });
  });

  test('FR011_RESERVE가 ADVANCED여도 승인 명령이 RETRYABLE이면 결과는 그 다시 하기이고(CONFIRM 단계, attempts 0 → 1초), 작업은 남는다', async () => {
    fx.put(sagaOrder());
    fx.confirmQueue = [{ status: 'RETRYABLE', reason: 'unavailable' }];
    expect(await runner().runJob(sagaJob({ attempts: 4 }))).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: NOW + 1000 });
    expect(fx.jobRows.get(ORDER_ID)?.step).toBe('CONFIRM');
  });

  test('FR011_CONFIRM 작업은 묶기·판매 예약 없이 승인 명령만 보낸다', async () => {
    fx.put(sagaOrder({ status: 'RESERVED' }), sagaJob({ step: 'CONFIRM' }));
    expect(await runner().runJob(sagaJob({ step: 'CONFIRM' }))).toEqual({ kind: 'DONE' });
    notCalled('pins.pin', 'reserve.reserve');
  });

  test('FR011_주문 읽기가 던지면 오류 로그(step RESERVE) 뒤 다시 하기 error다(실행기는 멈추지 않는다)', async () => {
    fx.put(sagaOrder());
    fx.readErrors.set(ORDER_ID, new Error('db down'));
    expect(await runner().runJob(sagaJob({ attempts: 1 }))).toEqual({ kind: 'RETRY', reason: 'error', nextAtMs: NOW + 2000 });
    expect(fx.stepErrors.map((e) => [e.orderId, e.step])).toEqual([[ORDER_ID, 'RESERVE']]);
    expect(fx.reschedules).toEqual([{ orderId: ORDER_ID, nextAtMs: NOW + 2000 }]);
  });

  test('FR011_판매 예약 트랜잭션이 DB 오류로 던지면(되돌림) 실패로 끝내지 않고 다시 하기 error다', async () => {
    fx.put(sagaOrder());
    fx.reserveQueue = [new Error('could not serialize access')];
    expect(await runner().runJob(sagaJob())).toEqual({ kind: 'RETRY', reason: 'error', nextAtMs: NOW + 1000 });
    notCalled('failures.fail', 'pins.releaseFailed', 'confirms.confirm');
    expect(fx.stepErrors).toHaveLength(1);
  });
});

describe('runOne·pollOnce·kick', () => {
  test('FR011_runOne은 claim(주문, 임대 30초)으로 집어 돈다', async () => {
    fx.put(sagaOrder());
    expect(await runner().runOne(ORDER_ID)).toEqual({ kind: 'DONE' });
    expect(fx.claimArgs).toEqual([[ORDER_ID, 30_000]]);
  });

  test('FR011_runOne: 작업 행이 없으면 SKIPPED NO_JOB, 다른 실행이 임대 중이면 SKIPPED LEASED이고 단계를 돌지 않는다', async () => {
    expect(await runner().runOne(ORDER_ID)).toEqual({ kind: 'SKIPPED', reason: 'NO_JOB' });
    fx.put(sagaOrder());
    fx.leased.add(ORDER_ID);
    expect(await runner().runOne(ORDER_ID)).toEqual({ kind: 'SKIPPED', reason: 'LEASED' });
    notCalled('orders.read', 'pins.pin', 'reserve.reserve', 'confirms.confirm');
  });

  test('FR011_pollOnce는 claimDue(50, 30초)로 집은 수만큼 돌고 그 수를 돌려준다. 한 작업의 오류가 다른 작업을 막지 않는다', async () => {
    fx.put(sagaOrder());
    fx.put(sagaOrder({ orderId: ORDER_B }));
    fx.put(sagaOrder({ orderId: ORDER_C }));
    fx.readErrors.set(ORDER_B, new Error('db down'));
    fx.due = [sagaJob(), sagaJob({ orderId: ORDER_B }), sagaJob({ orderId: ORDER_C })];
    expect(await runner().pollOnce()).toBe(3);
    expect(fx.claimDueArgs).toEqual([[50, 30_000]]);
    expect(fx.confirmCommands.map((c) => c.orderId).sort()).toEqual([ORDER_ID, ORDER_C].sort());
    expect(fx.stepErrors.map((e) => e.orderId)).toEqual([ORDER_B]);
    expect(fx.reschedules.map((r) => r.orderId)).toEqual([ORDER_B]);
  });

  test('FR011_pollOnce는 claimLimit·leaseMs 설정을 claimDue에 넘기고, 집은 것이 없으면 0이다', async () => {
    expect(await runner({ claimLimit: 7, leaseMs: 5000 }).pollOnce()).toBe(0);
    expect(fx.claimDueArgs).toEqual([[7, 5000]]);
    notCalled('orders.read');
  });

  test('FR011_pollOnce는 집기가 던져도 던지지 않고 0이며 stepError를 남기지 않는다(다음 틱에 다시)', async () => {
    fx.due = new Error('db down');
    await expect(runner().pollOnce()).resolves.toBe(0);
    notCalled('log.stepError', 'orders.read');
  });

  test('FR011_kick은 기다리지 않고 바로 돌아오며(던지지 않는다) 뒤에서 claim으로 임대를 잡아 그 주문을 돈다', async () => {
    fx.put(sagaOrder());
    const r = runner();
    expect(r.kick(ORDER_ID)).toBeUndefined();
    await flush();
    expect(fx.claimArgs).toEqual([[ORDER_ID, 30_000]]);
    expect(fx.doneOrders).toEqual([ORDER_ID]);
  });

  test('FR011_kick은 claim이 던져도 던지지 않고 처리되지 않은 거절을 남기지 않는다', async () => {
    fx.claimError = new Error('db down');
    const r = runner();
    expect(() => r.kick(ORDER_ID)).not.toThrow();
    await flush();
    expect(fx.claimArgs).toHaveLength(1);
  });
});

// BUILD_ORDER PRF-171 설계 1·2(docs/features/payment.md §2 '결제 결과 당기기의 첫 구현' 결과를 기다리는 주문 찾기·Saga 실행기와 갈림, ADR-0140):
// 승인 명령이 접수되면 작업 행을 지우지 않고 AWAIT로 남겨 결과 당기기가 '접수했는데 결과가 아직 없는 주문'을 작은 작업 표에서 찾는다
describe('승인 명령 접수 뒤 작업 행 AWAIT(PRF-171)', () => {
  test('ADR0140_ACCEPTED 뒤 작업 행은 지우지 않고 AWAIT로 남는다: confirm_sent_at은 보내기 바로 전에 적은 시각 그대로이고 결제 참조는 지웠으며, 주문은 RESERVED 그대로다(long polling이 보는 상태를 바꾸지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    fx.put(sagaOrder());
    expect(await runner().runJob(sagaJob())).toEqual({ kind: 'DONE' });
    expect(fx.jobRows.get(ORDER_ID)).toMatchObject({ orderId: ORDER_ID, eventId: EVENT, step: 'AWAIT', confirmSentAtMs: NOW });
    expect(fx.orderRows.get(ORDER_ID)?.status).toBe('RESERVED');
    expect(fx.orderRows.get(ORDER_ID)?.attempt?.refs).toBeUndefined();
    // 정리는 집은 작업의 자기 임대 조건으로 한 번(작업 행 지우기가 아니다)
    expect(fx.leaseArgs.filter((x) => x.call === 'confirmSent.done')).toEqual([{ call: 'confirmSent.done', leaseUntilMs: NOW + 30_000 }]);
    notCalled('jobs.delete', 'jobs.abandon');
  });

  test('ADR0140_Saga 잡기는 AWAIT 행을 고르지 않는다: 접수 뒤 kick·runOne·틱이 와도 승인 명령을 다시 보내지 않고 작업 행은 AWAIT 그대로다 [ASVS v5.0.0-2.3.4]', async () => {
    fx.put(sagaOrder());
    const r = runner();
    expect(await r.runOne(ORDER_ID)).toEqual({ kind: 'DONE' });
    expect(fx.sentCommands).toHaveLength(1);
    const awaiting = fx.jobRows.get(ORDER_ID)!;
    expect((await r.runOne(ORDER_ID)).kind).toBe('SKIPPED');
    r.kick(ORDER_ID);
    await flush();
    fx.due = [{ ...awaiting, nextAttemptAtMs: NOW, leaseUntilMs: NOW + 30_000 }];
    expect(await r.pollOnce()).toBe(0);
    expect(fx.sentCommands).toHaveLength(1);
    expect(fx.jobRows.get(ORDER_ID)).toEqual(awaiting);
    notCalled('jobs.reschedule', 'jobs.abandon', 'jobs.setStep', 'failures.fail', 'pins.releaseFailed');
  });

  test('ADR0140_정해진 거절(REJECTED)로 1시간 미뤄진 작업은 CONFIRM 그대로 남는다(confirm_sent_at 있음: 결과 당기기가 CONFIRM 행도 대상으로 맞춘다, PRF-165가 넘긴 것)', async () => {
    fx.put(sagaOrder({ status: 'RESERVED' }), sagaJob({ step: 'CONFIRM' }));
    fx.confirmQueue = [{ status: 'REJECTED', reason: 'invalid_argument' }];
    expect(await runner().runJob(sagaJob({ step: 'CONFIRM' }))).toEqual({ kind: 'RETRY', reason: 'confirm_rejected', nextAtMs: NOW + SAGA_CONFIRM_PARK_MS });
    expect(fx.jobRows.get(ORDER_ID)).toMatchObject({ step: 'CONFIRM', confirmSentAtMs: NOW, nextAttemptAtMs: NOW + SAGA_CONFIRM_PARK_MS });
    notCalled('confirmSent.done', 'failures.fail');
  });
});

describe('start·stop', () => {
  test('FR011_start는 1초 반복 하나를 켜고(두 번 불러도 하나), 틱은 pollOnce(claimDue)다. pollIntervalMs를 주면 그 간격이다', async () => {
    const r = runner();
    r.start();
    r.start();
    expect(timer.set.map((s) => s.ms)).toEqual([1000]);
    timer.tick();
    await flush();
    expect(fx.claimDueArgs).toHaveLength(1);
    await r.stop();

    const t2 = new FakeTimer();
    const r2 = runner({ timer: t2, pollIntervalMs: 250 });
    r2.start();
    expect(t2.set.map((s) => s.ms)).toEqual([250]);
    await r2.stop();
  });

  test('FR011_틱이 겹치지 않는다: 앞 틱이 끝나지 않았으면 이번 틱은 건너뛴다', async () => {
    const gate = deferred();
    fx.dueGate = gate.promise;
    const r = runner();
    r.start();
    timer.tick();
    await flush();
    timer.tick();
    await flush();
    expect(fx.claimDueArgs).toHaveLength(1);
    gate.resolve();
    await flush();
    fx.dueGate = undefined;
    timer.tick();
    await flush();
    expect(fx.claimDueArgs).toHaveLength(2);
    await r.stop();
  });

  test('FR011_stop은 반복을 끄고(같은 handle로 clearInterval) 돌던 틱이 끝날 때까지 기다린다. 멈춘 뒤의 kick은 부르지 않는다', async () => {
    const gate = deferred();
    fx.dueGate = gate.promise;
    const r = runner();
    r.start();
    timer.tick();
    await flush();
    let stopped = false;
    const stopping = r.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(timer.cleared).toEqual([timer.set[0]!.handle]);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);

    fx.put(sagaOrder());
    r.kick(ORDER_ID);
    await flush();
    expect(fx.claimArgs).toEqual([]);
  });

  test('FR011_stop은 돌던 kick도 기다린다', async () => {
    const gate = deferred();
    fx.dueGate = undefined;
    fx.put(sagaOrder());
    // 승인 명령을 늦춰 kick이 도는 중에 stop을 부른다
    const slow: ConfirmOutcome = { status: 'ACCEPTED', result: 'IN_PROGRESS' };
    const confirms = {
      confirm: async (c: ConfirmCommand): Promise<ConfirmOutcome> => {
        fx.confirmCommands.push(c);
        await gate.promise;
        return slow;
      },
    };
    const r = runner({ confirms });
    r.kick(ORDER_ID);
    await flush();
    expect(fx.confirmCommands).toHaveLength(1);
    let stopped = false;
    const stopping = r.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(fx.doneOrders).toEqual([ORDER_ID]);
  });
});

describe('리뷰 고침 M2·낮음: 요청 맥락 떼기, 자기 임대 조건, 남은 임대, stop 때 임대 놓기', () => {
  test('M2_남은 시간이 0인 요청 맥락 안에서 kick을 불러도 요청 맥락을 물려받지 않아 승인 명령이 실제로 나간다(차단기가 504로 막지 않는다)', async () => {
    fx.put(sagaOrder());
    const breaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'payment-svc' });
    const seen: unknown[] = [];
    const sent: ConfirmCommand[] = [];
    const confirms = {
      confirm: async (c: ConfirmCommand, o?: { beforeSend?: () => Promise<void> }): Promise<ConfirmOutcome> => {
        seen.push(requestContext());
        return breaker.run(async () => {
          await o?.beforeSend?.();
          sent.push(c);
          return { status: 'ACCEPTED', result: 'IN_PROGRESS' } as const;
        });
      },
    };
    try {
      const r = runner({ confirms });
      const dl = fakeClock({ now: NOW });
      const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(1, dl), route: '/v1/orders/{orderId}/payment-acceptance', method: 'POST', log: {} as RequestContext['log'] };
      dl.advance(10);
      runInRequestContext(ctx, () => {
        // 요청 안에서는 남은 시간이 없다(이 맥락이 새면 차단기가 부르지 않는다)
        expect(requestContext()?.deadline.remainingMs()).toBe(0);
        r.kick(ORDER_ID);
      });
      await flush();
      expect(seen).toEqual([undefined]);
      expect(sent.map((c) => c.orderId)).toEqual([ORDER_ID]);
      expect(fx.doneOrders).toEqual([ORDER_ID]);
    } finally {
      breaker.shutdown();
    }
  });

  test('낮음_실패 기록·작업 지우기·다시 하기·승인 뒤 정리·보낸 시각 적기는 집은 작업의 임대 값을 조건으로 넘긴다', async () => {
    const lease = NOW + 30_000;
    // T8 → 실패 해제 OK → 작업 지우기
    fx.put(sagaOrder());
    fx.pinQueue = [{ status: 'TAKEN' }];
    await runner().runJob(sagaJob());
    // CONFIRM: 보낸 시각 → RETRYABLE → 다시 하기
    fx.put(sagaOrder({ orderId: ORDER_B, status: 'RESERVED' }), sagaJob({ orderId: ORDER_B, step: 'CONFIRM' }));
    fx.confirmQueue = [{ status: 'RETRYABLE', reason: 'deadline' }];
    await runner().runJob(sagaJob({ orderId: ORDER_B, step: 'CONFIRM' }));
    // CONFIRM: ACCEPTED → 정리
    fx.put(sagaOrder({ orderId: ORDER_C, status: 'RESERVED' }), sagaJob({ orderId: ORDER_C, step: 'CONFIRM' }));
    await runner().runJob(sagaJob({ orderId: ORDER_C, step: 'CONFIRM' }));
    const calls = fx.leaseArgs.map((x) => x.call);
    for (const c of ['failures.fail', 'jobs.delete', 'jobs.markConfirmSent', 'jobs.reschedule', 'confirmSent.done'] as const) expect(calls, c).toContain(c);
    for (const x of fx.leaseArgs) expect(x.leaseUntilMs, x.call).toBe(lease);
  });

  test(`낮음_pollOnce는 다음 작업 전에 남은 임대를 보고 ${SAGA_LEASE_MIN_REMAINING_MS / 1000}초 [가정] 미만이면 그 작업을 놓고(임대 비움) 다음 틱으로 넘긴다`, async () => {
    fx.put(sagaOrder());
    fx.put(sagaOrder({ orderId: ORDER_B }));
    fx.due = [sagaJob({ leaseUntilMs: NOW + SAGA_LEASE_MIN_REMAINING_MS - 1 }), sagaJob({ orderId: ORDER_B, leaseUntilMs: NOW + SAGA_LEASE_MIN_REMAINING_MS })];
    expect(await runner().pollOnce()).toBe(2);
    expect(fx.releasedLeases).toEqual([ORDER_ID]);
    expect(fx.confirmCommands.map((c) => c.orderId)).toEqual([ORDER_B]);
    expect(SAGA_LEASE_MIN_REMAINING_MS).toBe(5000);
  });

  test('낮음_stop 때 아직 시작하지 않은 집은 작업은 돌지 않고 임대를 놓는다(돌던 작업은 끝까지 기다린다)', async () => {
    fx.put(sagaOrder());
    fx.put(sagaOrder({ orderId: ORDER_B }));
    fx.put(sagaOrder({ orderId: ORDER_C }));
    fx.due = [sagaJob(), sagaJob({ orderId: ORDER_B }), sagaJob({ orderId: ORDER_C })];
    const gate = deferred();
    const confirms = {
      confirm: async (c: ConfirmCommand, o?: { beforeSend?: () => Promise<void> }): Promise<ConfirmOutcome> => {
        await o?.beforeSend?.();
        fx.confirmCommands.push(c);
        await gate.promise;
        return { status: 'ACCEPTED', result: 'IN_PROGRESS' };
      },
    };
    const r = runner({ confirms });
    r.start();
    timer.tick();
    await flush();
    expect(fx.confirmCommands.map((c) => c.orderId)).toEqual([ORDER_ID]);
    const stopping = r.stop();
    gate.resolve();
    await stopping;
    expect(fx.doneOrders).toEqual([ORDER_ID]);
    expect(fx.releasedLeases).toEqual([ORDER_B, ORDER_C]);
    expect(fx.confirmCommands).toHaveLength(1);
  });
});

describe('행위자와 로그에 싣는 것', () => {
  test('FR011_ADR0113_실패 기록·판매 예약의 행위자는 늘 system:order-saga다(ACTOR_PATTERN의 system:<작업 이름>)', async () => {
    fx.put(sagaOrder());
    fx.reserveQueue = [{ status: 'QUOTA_EXCEEDED' }];
    await runner().runJob(sagaJob());
    expect(fx.reserveInputs.map((r) => r.actor)).toEqual(['system:order-saga']);
    expect(fx.failInputs.map((f) => f.actor)).toEqual(['system:order-saga']);
  });

  test('FR011_ADR0044_ADR0053_결제 키·토큰·거래 ID·금액은 로그 포트(실패 해제 warn·승인 거절·단계 오류)로 가지 않고, 묶기·판매 예약·실패 기록·실패 해제 입력에도 없다', async () => {
    const portone = tossAttempt({ pg: 'PORTONE', pgOrderRef: PORTONE_PAYMENT_ID, refs: { pg: 'PORTONE', txId: TX_ID, paymentToken: PAYMENT_TOKEN } });
    // ① 승인 거절 로그
    fx.put(sagaOrder({ status: 'RESERVED', attempt: portone }), sagaJob({ step: 'CONFIRM' }));
    fx.confirmQueue = [{ status: 'REJECTED', reason: 'invalid_argument' }];
    await runner().runJob(sagaJob({ step: 'CONFIRM' }));
    // ② 실패 해제 warn
    fx.put(sagaOrder({ orderId: ORDER_B }));
    fx.pinQueue = [{ status: 'TAKEN' }];
    fx.releaseResult = new OrderSeatStoreUnavailable(new Error('ECONNRESET'));
    await runner().runJob(sagaJob({ orderId: ORDER_B }));
    // ③ 단계 오류
    fx.releaseResult = undefined;
    fx.put(sagaOrder({ orderId: ORDER_C }));
    fx.reserveQueue = [new Error('db down')];
    await runner().runJob(sagaJob({ orderId: ORDER_C }));

    expect(fx.rejectLogs).toHaveLength(1);
    expect(fx.releaseLogs).toHaveLength(1);
    expect(fx.stepErrors).toHaveLength(1);
    const logged = JSON.stringify([fx.rejectLogs, fx.releaseLogs, fx.stepErrors.map((e) => ({ ...e, err: String(e.err) }))]);
    const ports = JSON.stringify([fx.pinInputs, fx.reserveInputs, fx.failInputs, fx.releaseInputs]);
    for (const secret of [PAYMENT_KEY, PAYMENT_TOKEN, TX_ID]) {
      expect(logged, secret).not.toContain(secret);
      expect(ports, secret).not.toContain(secret);
    }
    expect(logged).not.toContain(String(AMOUNT));
  });
});

describe('결제 결과 long polling 깨우기(onOrderChanged, PRF-166 리뷰 고침 L3)', () => {
  /** onOrderChanged가 불린 주문과 그때까지의 포트 호출 */
  const watch = () => {
    const seen: { orderId: string; callsBefore: string[] }[] = [];
    return { seen, onOrderChanged: (orderId: string) => void seen.push({ orderId, callsBefore: [...fx.calls] }) };
  };

  test('L3_T8 실패 기록(FAILED, 바로 답할 상태)은 커밋 뒤 일(실패 해제·작업 행 지우기)을 마친 뒤 한 번 깨운다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'TAKEN' }];
    const w = watch();
    expect(await runner({ onOrderChanged: w.onOrderChanged }).reserveStep(sagaJob(), order)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'SEAT_TAKEN' });
    expect(w.seen.map((s) => s.orderId)).toEqual([ORDER_ID]);
    expectInOrder(w.seen[0]!.callsBefore, ['failures.fail', 'pins.releaseFailed', 'jobs.delete']);
    expect(w.seen[0]!.callsBefore).toEqual(fx.calls);
  });

  test('L3_실패 해제가 끝나지 못해 다시 하기로 미뤄도(주문은 이미 FAILED) 미룬 뒤 한 번 깨운다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'TAKEN' }];
    fx.releaseResult = new OrderSeatStoreUnavailable(new Error('ECONNRESET'));
    const w = watch();
    expect(await runner({ onOrderChanged: w.onOrderChanged }).reserveStep(sagaJob(), order)).toMatchObject({ kind: 'FAILED' });
    expect(w.seen.map((s) => s.orderId)).toEqual([ORDER_ID]);
    expectInOrder(w.seen[0]!.callsBefore, ['failures.fail', 'pins.releaseFailed', 'jobs.reschedule']);
  });

  test('L3_T7 판매 예약(RESERVED, 기다리는 상태)은 깨우지 않는다', async () => {
    const order = sagaOrder();
    fx.put(order);
    const w = watch();
    expect(await runner({ onOrderChanged: w.onOrderChanged }).reserveStep(sagaJob(), order)).toEqual({ kind: 'ADVANCED', next: 'CONFIRM' });
    expect(w.seen).toEqual([]);
  });

  test('L3_onOrderChanged가 던져도 실패 결과는 그대로다', async () => {
    const order = sagaOrder();
    fx.put(order);
    fx.pinQueue = [{ status: 'TAKEN' }];
    const r = await runner({
      onOrderChanged: () => {
        throw new Error('boom');
      },
    }).reserveStep(sagaJob(), order);
    expect(r).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'SEAT_TAKEN' });
  });
});
