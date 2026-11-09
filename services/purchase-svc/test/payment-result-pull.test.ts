// 결제 결과 당기기 실행기(booking application/payment-result-pull.ts PaymentResultPuller, docs/features/payment.md §2 '결제 결과 당기기의 첫 구현',
// ADR-0140 결정 1~4, docs/data.md §5 '결과 당기기를 두 파드가 함께 잡음', BUILD_ORDER PRF-171 설계 4~8)를 메모리 가짜 포트로 본다.
// - tick: 잡기 claimDue(100) → 묶음마다 곧바로 BatchGetPayments(데드라인 500ms) → 답마다 paymentStateToResultEvent → 사건 길과 같은 ApplyPaymentResult.execute
//   → 간격마다 defer 한 번(취소 상태·모양 틀림 60초, 보류·기록 없음 10분, 답이 UNKNOWN 30초·입금 대기 60초). 한 틱에 잡는 묶음은 4개까지이고 첫 묶음의 답을 본 뒤 다음을 잡는다
// - 실패: BatchGetPayments 실패는 지표만(payment-svc가 답하지 못하면 그 묶음 30초 미루기와 남은 잡기 멈춤), 예상 밖 예외는 runError 한 줄,
//   단계끼리·묶음끼리 막지 않음, 지표·로그가 던져도 막지 않음
// - 리뷰 고침(2026-11-06): H1 중간 결과 점검 간격, M2 payment-svc 장애 때 물러나기, M3 파드 둘의 기록 없음 로그 창, L1 종료 차례
// - start·stop: 1초 반복 하나, 틱이 겹치지 않음, 예상 밖 오류에 반복이 죽지 않음, stop이 돌던 묶음을 기다림, 요청 맥락을 물려받지 않음
// - 사건 길과 함께(P-T47·P-T15): 실제 ApplyPaymentResult(메모리 가짜 저장소)로 당긴 승인이 한 번 반영되고 늦게 온 같은 사건은 DUPLICATE
// 가짜는 DB가 할 일을 흉내 내지 않는다(잡기는 정해 둔 답을 차례로 꺼낸다). 실제 PostgreSQL로 도는 잡기·미루기·반영은 test-int/payment-pull.int.test.ts(다른 담당)다.
import { readFileSync } from 'node:fs';
import { Deadline, fakeClock, type FakeClock, type RequestContext, requestContext, runInRequestContext } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ApplyPaymentResult,
  type ApplyPaymentResultOutcome,
  type OrderPaymentState,
  PaymentPullCallError,
  type PaymentPullFailureCode,
  type PaymentPullLog,
  type PaymentPullSignals,
  type PaymentPullTarget,
  type PaymentPullTargets,
  type PaymentPullTimer,
  PaymentResultConflict,
  type PaymentResultEvent,
  PaymentResultHeld,
  PaymentResultPuller,
  type PaymentResultPullDeps,
  type PaymentResultReader,
  type AppliedPaymentEventType,
} from '../src/modules/booking/index.js';
import { EVENT_KEY, EVENT_SEQ, OCCURRED_AT, OCCURRED_AT_MS, ORDER_ID, paymentEvent, ResultFakes, resultOrder } from './payment-result-cases.js';
import { AMOUNT, EVENT, NOW } from './order-cases.js';

const MIN = 60_000;
const ORDER_B = '0190f3a1-7c2e-7f00-8000-0000000000f3';
const ORDER_C = '0190f3a1-7c2e-7f00-8000-0000000000f4';
const ORDER_D = '0190f3a1-7c2e-7f00-8000-0000000000f5';
/** 묻지 않은 주문(답에 섞여 와도 버린다) */
const STRANGER = '0190f3a1-7c2e-7f00-8000-0000000000f9';
/** 60초 미루기의 다음 점검 시각(지금 + 60초 [가정]) */
const SLOW = NOW + 60_000;
/** 기록 없음 10분·보류의 다음 점검 시각(지금 + 10분 [가정], payment §2 '기록 없음이 길어질 때', 리뷰 고침 M3) */
const LONG = NOW + 10 * 60_000;
/** payment-svc가 답하지 못한 묶음의 다음 점검 시각(지금 + 30초 [가정], 같은 절, 리뷰 고침 M2) */
const OUTAGE = NOW + 30_000;

/** i번째 주문 ID(100건·동시 상한 시험용) */
const orderN = (i: number): string => `0190f3a1-7c2e-7f00-8000-${(0x200000 + i).toString(16).padStart(12, '0')}`;

/** 잡은 대상(승인 명령을 보낸 지 6초, 그 주문 ACCEPTED 시도 순번 1) */
function target(orderId: string = ORDER_ID, over: Partial<PaymentPullTarget> = {}): PaymentPullTarget {
  return { orderId, eventId: EVENT, attemptNo: 1, confirmSentAtMs: NOW - 6000, ...over };
}
/** n개의 대상(서로 다른 주문) */
const targets = (n: number, from = 0): PaymentPullTarget[] => Array.from({ length: n }, (_, i) => target(orderN(from + i)));

/** 답 하나(토스 승인, 주문 금액, 순번 3) */
function answer(orderId: string = ORDER_ID, over: Partial<OrderPaymentState> = {}): OrderPaymentState {
  return { orderId, paymentId: '0190f3a1-7c2e-7f00-8000-0000000000a9', pg: 'TOSS', status: 'APPROVED', amount: AMOUNT, approvedAtMs: OCCURRED_AT_MS, eventKey: EVENT_KEY, eventSeq: EVENT_SEQ, ...over };
}

/** 사건 종류마다 반영의 기본 답(APPLIED) */
const APPLIED_OF: Record<AppliedPaymentEventType, ApplyPaymentResultOutcome> = {
  APPROVED: { status: 'APPLIED', transition: 'T9', write: 'APPROVE' },
  FAILED: { status: 'APPLIED', transition: 'T11', write: 'FAIL' },
  UNKNOWN: { status: 'APPLIED', transition: 'T12', write: 'MARK' },
  AWAITING_DEPOSIT: { status: 'APPLIED', transition: 'T10', write: 'MARK' },
  DEPOSIT_REVERSED: { status: 'APPLIED', transition: 'T21', write: 'REVERSE' },
  CANCELED: { status: 'APPLIED', transition: 'T15', write: 'FAIL' },
};

type Call =
  | 'targets.claimDue'
  | 'targets.defer'
  | 'reader.batchGet'
  | 'apply.execute'
  | 'log.missing'
  | 'log.ignored'
  | 'log.runError'
  | 'signals.pulled'
  | 'signals.batch'
  | 'signals.failure';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 기다리지 않고 둔 약속(뒤에서 await한다). 그 전에 시험이 실패해도 처리되지 않은 거절로 남지 않게 빈 처리기를 단다 */
function later<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

/** 마이크로태스크·즉시 실행 몇 바퀴를 돌린다(틱처럼 기다리지 않는 일이 끝나게) */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
}

/** 반복 타이머 대역(손으로 틱을 부른다) */
class FakeTimer implements PaymentPullTimer {
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

/** 던질 값(Error가 아닌 것도 던지게 싼다) */
type Throw = { readonly throws: unknown };
const throws = (v: unknown): Throw => ({ throws: v });
const isThrow = (v: unknown): v is Throw => typeof v === 'object' && v !== null && 'throws' in v;

/** 당기기 실행기 포트의 메모리 가짜. calls에 부른 차례를 적고 포트마다 인자를 적는다 */
class PullFakes {
  calls: Call[] = [];

  /** 잡기마다 차례로 꺼내 답한다(비면 []) */
  claimQueue: (PaymentPullTarget[] | Error)[] = [];
  /** n번째(0부터) 잡기를 이 약속이 풀릴 때까지 붙잡는다 */
  claimGates = new Map<number, Promise<void>>();
  claimArgs: number[] = [];
  defers: { orderIds: string[]; untilMs: number }[] = [];
  deferError: Error | undefined;

  /** 주문마다의 답(답에 없으면 기록 없음) */
  states = new Map<string, OrderPaymentState[]>();
  /** 묻지 않은 주문의 답(섞여 와도 버려야 한다) */
  extraStates: OrderPaymentState[] = [];
  /** 호출마다 차례로 꺼내 던진다(undefined면 정상 답) */
  batchQueue: (Throw | undefined)[] = [];
  /** 참이면 BatchGetPayments가 손으로 풀 때까지 기다린다 */
  holdBatch = false;
  /** n번째(0부터) BatchGetPayments를 이 약속이 풀릴 때까지 붙잡는다 */
  batchGates = new Map<number, Promise<void>>();
  readonly heldBatches: (() => void)[] = [];
  batchArgs: { orderIds: string[]; deadlineMs: number | undefined }[] = [];
  batchInFlight = 0;
  maxBatchInFlight = 0;
  /** 호출 때의 요청 맥락 */
  contexts: unknown[] = [];

  /** 주문마다 반영의 답(없으면 사건 종류의 APPLIED) */
  executeAnswers = new Map<string, ApplyPaymentResultOutcome | Throw>();
  /** 참이면 execute가 손으로 풀 때까지 기다린다 */
  holdExecute = false;
  readonly heldExecutes: (() => void)[] = [];
  events: PaymentResultEvent[] = [];
  executeInFlight = 0;
  maxExecuteInFlight = 0;

  missingLogs: Parameters<PaymentPullLog['missing']>[0][] = [];
  ignoredLogs: Parameters<PaymentPullLog['ignored']>[0][] = [];
  runErrors: Parameters<PaymentPullLog['runError']>[0][] = [];
  pulled: AppliedPaymentEventType[] = [];
  batches = 0;
  failures = 0;

  /** 지표·로그가 모두 던진다 */
  noisy = false;

  /** 주문의 답을 둔다 */
  answer(...xs: OrderPaymentState[]): void {
    for (const x of xs) this.states.set(x.orderId, [...(this.states.get(x.orderId) ?? []), x]);
  }

  releaseBatches(): void {
    for (const r of this.heldBatches.splice(0)) r();
  }

  releaseExecutes(): void {
    for (const r of this.heldExecutes.splice(0)) r();
  }

  readonly targets: PaymentPullTargets = {
    claimDue: async (limit) => {
      const n = this.claimArgs.length;
      this.calls.push('targets.claimDue');
      this.claimArgs.push(limit);
      const gate = this.claimGates.get(n);
      if (gate) await gate;
      const v = this.claimQueue.length > 0 ? this.claimQueue.shift()! : [];
      if (v instanceof Error) throw v;
      return v.map((t) => ({ ...t }));
    },
    defer: async (orderIds, untilMs) => {
      this.calls.push('targets.defer');
      this.defers.push({ orderIds: [...orderIds], untilMs });
      if (this.deferError) throw this.deferError;
      return orderIds.length;
    },
  };

  readonly reader: PaymentResultReader = {
    batchGet: async (orderIds, o) => {
      const n = this.batchArgs.length;
      this.calls.push('reader.batchGet');
      this.batchArgs.push({ orderIds: [...orderIds], deadlineMs: o?.deadlineMs });
      this.contexts.push(requestContext());
      this.batchInFlight += 1;
      this.maxBatchInFlight = Math.max(this.maxBatchInFlight, this.batchInFlight);
      try {
        const gate = this.batchGates.get(n);
        if (gate) await gate;
        if (this.holdBatch) await new Promise<void>((r) => this.heldBatches.push(r));
        const v = this.batchQueue.length > 0 ? this.batchQueue.shift() : undefined;
        if (isThrow(v)) throw v.throws;
        return [...orderIds.flatMap((id) => this.states.get(id) ?? []), ...this.extraStates].map((s) => ({ ...s }));
      } finally {
        this.batchInFlight -= 1;
      }
    },
  };

  readonly apply: Pick<ApplyPaymentResult, 'execute'> = {
    execute: async (event) => {
      this.calls.push('apply.execute');
      this.events.push(event);
      this.executeInFlight += 1;
      this.maxExecuteInFlight = Math.max(this.maxExecuteInFlight, this.executeInFlight);
      try {
        if (this.holdExecute) await new Promise<void>((r) => this.heldExecutes.push(r));
        const v = this.executeAnswers.get(event.orderId) ?? APPLIED_OF[event.type as AppliedPaymentEventType];
        if (isThrow(v)) throw v.throws;
        return v;
      } finally {
        this.executeInFlight -= 1;
      }
    },
  };

  #noise(): void {
    if (this.noisy) throw new Error('telemetry down');
  }

  readonly log: PaymentPullLog = {
    missing: (e) => {
      this.calls.push('log.missing');
      this.missingLogs.push(e);
      this.#noise();
    },
    ignored: (e) => {
      this.calls.push('log.ignored');
      this.ignoredLogs.push(e);
      this.#noise();
    },
    runError: (e) => {
      this.calls.push('log.runError');
      this.runErrors.push(e);
      this.#noise();
    },
  };

  readonly signals: PaymentPullSignals = {
    pulled: (type) => {
      this.calls.push('signals.pulled');
      this.pulled.push(type);
      this.#noise();
    },
    batch: () => {
      this.calls.push('signals.batch');
      this.batches += 1;
      this.#noise();
    },
    failure: () => {
      this.calls.push('signals.failure');
      this.failures += 1;
      this.#noise();
    },
  };
}

let clock: FakeClock;
let fx: PullFakes;
let timer: FakeTimer;
/** 시험 동안 생긴 처리되지 않은 거절(실행기가 남기면 안 된다) */
let unhandled: unknown[];
const onUnhandled = (e: unknown): void => {
  unhandled.push(e);
};

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  fx = new PullFakes();
  timer = new FakeTimer();
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

const deps = (over: Partial<PaymentResultPullDeps> = {}): PaymentResultPullDeps => ({
  targets: fx.targets,
  reader: fx.reader,
  apply: fx.apply,
  log: fx.log,
  signals: fx.signals,
  clock,
  timer,
  ...over,
});
const puller = (over: Partial<PaymentResultPullDeps> = {}) => new PaymentResultPuller(deps(over));

/** 이 포트들은 부르지 않았다 */
function notCalled(...ports: Call[]): void {
  for (const p of ports) expect(fx.calls, `${p}를 부르면 안 된다`).not.toContain(p);
}
/** 틱 결과(아무것도 하지 않은 틱) */
const ZERO = { claimed: 0, batches: 0, failedBatches: 0, applied: 0, deferred: 0 };
/** 미룬 주문(차례 무시) */
const deferredIds = (): string[] => fx.defers.flatMap((d) => d.orderIds).sort();

describe('tick: 잡기와 묶음(설계 3·4, ADR-0140 결정 1·3)', () => {
  test('틱 하나가 claimDue(100)으로 잡고 잡은 주문 ID들로 BatchGetPayments 한 번(데드라인 500ms)을 부르며 지표 batch 하나다. 잡은 것이 100건보다 적으면 더 잡지 않는다 (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B)]];
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 2, batches: 1 });
    expect(fx.claimArgs).toEqual([100]);
    expect(fx.batchArgs).toEqual([{ orderIds: [ORDER_ID, ORDER_B], deadlineMs: 500 }]);
    expect(fx.batches).toBe(1);
    // 둘 다 기록 없음(보낸 지 6초): 반영·미루기·로그가 없다(다음 점검은 잡기가 쓴 5초 뒤)
    notCalled('apply.execute', 'targets.defer', 'log.missing', 'log.ignored', 'log.runError', 'signals.failure');
  });

  test('잡은 것이 없으면 BatchGetPayments를 부르지 않는다(평소에는 사건이 1초 안에 와서 당기기가 거의 돌지 않는다) (ADR0140)', async () => {
    expect(await puller().tick()).toEqual(ZERO);
    expect(fx.claimArgs).toEqual([100]);
    notCalled('reader.batchGet', 'signals.batch');
  });

  test('한 번에 100건·한 틱에 4묶음까지: 잡기가 100건씩 차면 4번까지 잡고(묶음마다 100건) 다섯 번째는 잡지 않는다. 첫 묶음의 답을 본 뒤 나머지는 잡을 때마다 곧바로 불러 겹치고, 동시 BatchGetPayments는 4개를 넘지 않는다 (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [targets(100, 0), targets(100, 100), targets(100, 200), targets(100, 300), targets(100, 400)];
    // 첫 묶음은 곧바로 답하고(리뷰 고침 M2: 그 답을 본 뒤 다음을 잡는다), 나머지 셋은 붙잡아 겹치게 한다
    const gate = deferred();
    for (const n of [1, 2, 3]) fx.batchGates.set(n, gate.promise);
    const r = puller();
    const ticking = later(r.tick());
    await flush();
    expect(fx.claimArgs).toEqual([100, 100, 100, 100]);
    expect(fx.batchArgs.map((b) => b.orderIds.length)).toEqual([100, 100, 100, 100]);
    expect(fx.batchInFlight).toBe(3);
    expect(fx.maxBatchInFlight).toBeLessThanOrEqual(4);
    // 묶음마다 서로 다른 주문이다(같은 주문을 두 번 묻지 않는다)
    expect(new Set(fx.batchArgs.flatMap((b) => b.orderIds)).size).toBe(400);
    gate.resolve();
    expect(await ticking).toEqual({ ...ZERO, claimed: 400, batches: 4 });
    expect(fx.claimQueue).toHaveLength(1);
  });

  test('잡을 때마다 그 묶음의 호출을 곧바로 시작한다: 둘째 잡기가 끝나기 전에 첫 묶음의 BatchGetPayments가 나간다(잠금을 쥔 채 부르지 않는다: 잡기는 이미 커밋했다) (ADR0140)', async () => {
    fx.claimQueue = [targets(100, 0), [target(ORDER_B)]];
    const gate = deferred();
    fx.claimGates.set(1, gate.promise);
    const r = puller();
    const ticking = later(r.tick());
    await flush();
    expect(fx.claimArgs).toHaveLength(2);
    expect(fx.batchArgs).toHaveLength(1);
    expect(fx.batchArgs[0]!.orderIds).toHaveLength(100);
    gate.resolve();
    expect(await ticking).toEqual({ ...ZERO, claimed: 101, batches: 2 });
    expect(fx.batchArgs[1]!.orderIds).toEqual([ORDER_B]);
  });

  test('concurrency·batchSize·deadlineMs 설정: 동시 2개면 두 번까지 잡고, batchSize 30이면 claimDue(30)이며 30건이 차야 더 잡는다. 데드라인 설정을 넘긴다', async () => {
    fx.claimQueue = [targets(30, 0), targets(30, 30), targets(30, 60)];
    expect(await puller({ concurrency: 2, batchSize: 30, deadlineMs: 200 }).tick()).toEqual({ ...ZERO, claimed: 60, batches: 2 });
    expect(fx.claimArgs).toEqual([30, 30]);
    expect(fx.batchArgs.map((b) => b.deadlineMs)).toEqual([200, 200]);
  });

  test('batchSize가 100보다 크면 100이다(payment.proto: 넘으면 INVALID_ARGUMENT) (ADR0140)', async () => {
    await puller({ batchSize: 500 }).tick();
    expect(fx.claimArgs).toEqual([100]);
  });

  test.each([0, -1, 1.5, Number.NaN])('batchSize·concurrency·deadlineMs가 1 이상의 안전한 정수가 아니면(%s) 기본값(100·4·500ms)이다', async (bad) => {
    fx.claimQueue = [targets(100, 0), targets(100, 100), targets(100, 200), targets(100, 300), targets(100, 400)];
    await puller({ batchSize: bad, concurrency: bad, deadlineMs: bad }).tick();
    expect(fx.claimArgs).toEqual([100, 100, 100, 100]);
    expect(fx.batchArgs.map((b) => b.deadlineMs)).toEqual([500, 500, 500, 500]);
  });
});

describe('tick: 답마다(설계 5·6·7)', () => {
  test('APPLY: 답을 사건으로 바꿔(회차 = 작업 행, 시도 순번 = 잡기가 읽은 값, 승인 시각 = approved_at) 사건 길과 같은 execute에 넘기고, APPLIED면 지표 pulled(APPROVED) 하나다 (P-T47, ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    fx.claimQueue = [[target(ORDER_ID, { attemptNo: 2 })]];
    fx.answer(answer(ORDER_ID));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, applied: 1 });
    expect(fx.events).toEqual([
      { eventId: EVENT, orderId: ORDER_ID, pg: 'TOSS', type: 'APPROVED', amount: AMOUNT, refMissing: false, attemptNo: 2, occurredAt: OCCURRED_AT, eventSeq: EVENT_SEQ, eventKey: EVENT_KEY },
    ]);
    expect(fx.pulled).toEqual(['APPROVED']);
    notCalled('targets.defer', 'log.missing', 'log.ignored', 'log.runError', 'signals.failure');
  });

  test.each<[OrderPaymentState['status'], AppliedPaymentEventType]>([
    ['UNKNOWN', 'UNKNOWN'],
    ['AWAITING_DEPOSIT', 'AWAITING_DEPOSIT'],
    ['FAILED', 'FAILED'],
  ])('%s 답도 같은 길이다: 발생 시각은 당긴 시각(앱 시계의 지금), 지표 pulled(%s) (ADR0140) [ASVS v5.0.0-2.3.3]', async (status, type) => {
    clock.advance(7000);
    fx.claimQueue = [[target()]];
    fx.answer(answer(ORDER_ID, { status, approvedAtMs: undefined, ...(status === 'FAILED' ? { failureCategory: 'CARD_DECLINED' as const } : {}) }));
    expect((await puller().tick()).applied).toBe(1);
    expect(fx.events).toHaveLength(1);
    expect(fx.events[0]).toMatchObject({ type, occurredAt: new Date(NOW + 7000).toISOString(), eventSeq: EVENT_SEQ });
    expect(fx.pulled).toEqual([type]);
  });

  test('execute가 SKIPPED(이미 반영한 순번 이하: 사건 길이 먼저 반영)면 지표·미루기·로그가 없다. 같은 순번 거르기는 반영 몫이다 (P-T15, ADR0140)', async () => {
    fx.claimQueue = [[target()]];
    fx.answer(answer());
    fx.executeAnswers.set(ORDER_ID, { status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1 });
    expect(fx.events).toHaveLength(1);
    notCalled('signals.pulled', 'targets.defer', 'log.runError', 'log.ignored');
  });

  test('execute가 보류(PaymentResultHeld)를 던지면 그 주문의 다음 점검을 10분 [가정] 미룬다(defer(지금 + 10분), 리뷰 고침 M3). 보류 로그는 execute 몫이고 당기기 길에는 Kafka 오프셋이 없어 보류 표에 넣지 않는다 (ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    fx.claimQueue = [[target()]];
    fx.answer(answer());
    fx.executeAnswers.set(ORDER_ID, throws(new PaymentResultHeld('AMOUNT_MISMATCH', ORDER_ID, 'APPROVED')));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, deferred: 1 });
    expect(fx.defers).toEqual([{ orderIds: [ORDER_ID], untilMs: LONG }]);
    notCalled('signals.pulled', 'log.runError', 'log.ignored');
  });

  test('execute가 PaymentResultConflict·purchase DB 오류를 던지면 log.runError(apply, 주문 ID) 뒤 다음 점검이다(미루지 않는다). 같은 묶음의 다른 주문은 이어 반영한다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B), target(ORDER_C)]];
    fx.answer(answer(ORDER_ID), answer(ORDER_B), answer(ORDER_C));
    const conflict = new PaymentResultConflict(ORDER_ID);
    const dbDown = new Error('connection terminated');
    fx.executeAnswers.set(ORDER_ID, throws(conflict));
    fx.executeAnswers.set(ORDER_B, throws(dbDown));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 3, batches: 1, applied: 1 });
    expect(fx.runErrors).toEqual([
      { what: 'apply', orderId: ORDER_ID, err: conflict },
      { what: 'apply', orderId: ORDER_B, err: dbDown },
    ]);
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID, ORDER_B, ORDER_C]);
    expect(fx.pulled).toEqual(['APPROVED']);
    notCalled('targets.defer');
  });

  test('ACCEPTED(승인 중) 답이면 WAIT: 반영·미루기·로그가 없다(다음 점검 5초 뒤 다시 묻는다) (ADR0140)', async () => {
    fx.claimQueue = [[target()]];
    fx.answer(answer(ORDER_ID, { status: 'ACCEPTED', approvedAtMs: undefined }));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1 });
    notCalled('apply.execute', 'targets.defer', 'log.ignored', 'log.missing', 'signals.pulled');
  });

  test.each<[OrderPaymentState['status'], 'CANCELED' | 'MALFORMED']>([
    ['PARTIAL_CANCELED', 'CANCELED'],
    ['UNSPECIFIED', 'MALFORMED'],
  ])('%s 답은 반영하지 않고 경고 한 줄(log.ignored: 주문 ID·까닭 %s·상태)과 60초 미루기다(취소 흐름은 PRF-173 몫) (ADR0140)', async (status, reason) => {
    fx.claimQueue = [[target()]];
    fx.answer(answer(ORDER_ID, { status }));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, deferred: 1 });
    expect(fx.ignoredLogs).toEqual([{ orderId: ORDER_ID, reason, status }]);
    expect(fx.defers).toEqual([{ orderIds: [ORDER_ID], untilMs: SLOW }]);
    notCalled('apply.execute', 'signals.pulled');
  });

  test('답에 없는 주문(기록 없음)은 승인 명령을 보낸 지 10분 전이면 아무것도 하지 않는다(다음 점검 5초 뒤. 주문을 실패로 단정하지 않는다) (ADR0140)', async () => {
    fx.claimQueue = [[target(ORDER_ID, { confirmSentAtMs: NOW - 10 * MIN + 1 })]];
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1 });
    notCalled('apply.execute', 'targets.defer', 'log.missing', 'log.runError');
  });

  test('기록 없음이 10분 [가정](경계 포함): SEV2 한 줄(log.missing, 주문 ID만)과 10분 미루기(리뷰 고침 M3). 같은 파드가 다시 잡아도 10분 창 안에서는 다시 남기지 않고(미루기는 매번), 창이 지나면 다시 한 줄이다 (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    const t = target(ORDER_ID, { confirmSentAtMs: NOW - 10 * MIN });
    const r = puller();
    fx.claimQueue = [[t]];
    expect(await r.tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, deferred: 1 });
    expect(fx.missingLogs).toEqual([{ orderId: ORDER_ID }]);
    expect(fx.defers).toEqual([{ orderIds: [ORDER_ID], untilMs: LONG }]);
    // 60초 뒤의 점검(창 안): 미루기만
    clock.advance(60_000);
    fx.claimQueue = [[t]];
    expect((await r.tick()).deferred).toBe(1);
    expect(fx.missingLogs).toHaveLength(1);
    // 창이 끝나기 1ms 전: 미루기만
    clock.advance(9 * MIN - 1);
    fx.claimQueue = [[t]];
    await r.tick();
    expect(fx.missingLogs).toHaveLength(1);
    // 창이 지난 뒤: 다시 한 줄
    clock.advance(2);
    fx.claimQueue = [[t]];
    await r.tick();
    expect(fx.missingLogs).toEqual([{ orderId: ORDER_ID }, { orderId: ORDER_ID }]);
    expect(fx.defers.map((d) => d.untilMs)).toEqual([LONG, LONG + 60_000, NOW + 10 * MIN - 1 + 10 * MIN, NOW + 10 * MIN + 1 + 10 * MIN]);
    notCalled('apply.execute', 'log.runError');
  });

  test('기록 없음 로그 창은 주문마다 따로다(다른 주문은 첫 점검에 한 줄)', async () => {
    const r = puller();
    fx.claimQueue = [[target(ORDER_ID, { confirmSentAtMs: NOW - 11 * MIN })]];
    await r.tick();
    clock.advance(60_000);
    fx.claimQueue = [[target(ORDER_ID, { confirmSentAtMs: NOW - 11 * MIN }), target(ORDER_B, { confirmSentAtMs: NOW - 10 * MIN })]];
    await r.tick();
    expect(fx.missingLogs).toEqual([{ orderId: ORDER_ID }, { orderId: ORDER_B }]);
  });

  test('섞인 묶음: 차례대로 보고, 미룰 주문은 간격마다 그 묶음의 defer 한 번에 모은다(보류·오래 기록 없음 지금 + 10분, 취소 상태 지금 + 60초) (ADR0140)', async () => {
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B), target(ORDER_C, { confirmSentAtMs: NOW - 15 * MIN }), target(ORDER_D)]];
    fx.answer(answer(ORDER_ID), answer(ORDER_B, { status: 'PARTIAL_CANCELED' }), answer(ORDER_D));
    fx.executeAnswers.set(ORDER_ID, throws(new PaymentResultHeld('PG_MISMATCH', ORDER_ID, 'APPROVED')));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 4, batches: 1, applied: 1, deferred: 3 });
    expect(fx.defers).toEqual([
      { orderIds: [ORDER_ID, ORDER_C], untilMs: LONG },
      { orderIds: [ORDER_B], untilMs: SLOW },
    ]);
    expect(deferredIds()).toEqual([ORDER_ID, ORDER_B, ORDER_C].sort());
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID, ORDER_D]);
    expect(fx.calls.lastIndexOf('targets.defer')).toBeGreaterThan(fx.calls.lastIndexOf('apply.execute'));
  });

  test('같은 주문의 답이 둘 이상이면 eventSeq가 가장 큰 것만 반영하고, 묻지 않은 주문의 답은 버린다 (P-T15)', async () => {
    fx.claimQueue = [[target(ORDER_ID)]];
    fx.answer(answer(ORDER_ID, { eventSeq: 3 }), answer(ORDER_ID, { eventSeq: 5, eventKey: 'ek-5' }), answer(ORDER_ID, { eventSeq: 4 }));
    fx.extraStates = [answer(STRANGER, { eventSeq: 9 })];
    expect((await puller().tick()).applied).toBe(1);
    expect(fx.events.map((e) => [e.orderId, e.eventSeq, e.eventKey])).toEqual([[ORDER_ID, 5, 'ek-5']]);
  });

  test('같은 묶음의 반영은 한 번에 하나다(execute를 겹쳐 부르지 않는다)', async () => {
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B)]];
    fx.answer(answer(ORDER_ID), answer(ORDER_B));
    fx.holdExecute = true;
    const ticking = later(puller().tick());
    await flush();
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID]);
    fx.releaseExecutes();
    await flush();
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID, ORDER_B]);
    fx.releaseExecutes();
    expect((await ticking).applied).toBe(2);
    expect(fx.maxExecuteInFlight).toBe(1);
  });
});

describe('tick: 실패(ADR-0140 결정 4)', () => {
  // payment-svc가 답하지 못한 코드(CIRCUIT_OPEN·UNAVAILABLE·DEADLINE_EXCEEDED)는 아래 '리뷰 고침 M2'가 본다(30초 미루기·남은 잡기 멈춤)
  test.each<PaymentPullFailureCode>(['RESOURCE_EXHAUSTED', 'BAD_ANSWER', 'INTERNAL', 'INVALID_ARGUMENT'])(
    'BatchGetPayments가 PaymentPullCallError(%s)면 지표 failure만 센다: 로그·반영·미루기가 없다(다음 점검 5초 뒤, 1분 이어지면 SEV2는 경보식 몫) (ADR0140) [ASVS v5.0.0-16.5.2]',
    async (code) => {
      fx.claimQueue = [[target()]];
      fx.answer(answer());
      fx.batchQueue = [throws(new PaymentPullCallError(code))];
      expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, failedBatches: 1 });
      expect([fx.batches, fx.failures]).toEqual([1, 1]);
      notCalled('log.runError', 'apply.execute', 'targets.defer', 'signals.pulled');
    },
  );

  test('차단기 payment-svc-batch가 열려(CIRCUIT_OPEN) 실패하면 그 묶음을 30초 미루고, 30초 뒤 다음 점검에서 다시 잡아 차단기가 닫혔으면 반영한다 (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    const r = puller();
    fx.claimQueue = [[target()], [target()]];
    fx.answer(answer());
    fx.batchQueue = [throws(new PaymentPullCallError('CIRCUIT_OPEN'))];
    expect(await r.tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, failedBatches: 1, deferred: 1 });
    expect(fx.defers).toEqual([{ orderIds: [ORDER_ID], untilMs: OUTAGE }]);
    clock.advance(30_000);
    expect(await r.tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, applied: 1 });
    expect(fx.claimArgs).toEqual([100, 100]);
    expect(fx.failures).toBe(1);
    expect(fx.batches).toBe(2);
  });

  test('예상 밖 예외(PaymentPullCallError가 아님)는 log.runError(batch_get) 한 줄과 지표 failure다(실행기는 멈추지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [[target()]];
    const boom = new TypeError('Cannot read properties of undefined');
    fx.batchQueue = [throws(boom)];
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, failedBatches: 1 });
    expect(fx.runErrors).toEqual([{ what: 'batch_get', err: boom }]);
    expect(fx.failures).toBe(1);
  });

  test('한 묶음의 실패가 다른 묶음을 막지 않는다: 첫 묶음이 BAD_ANSWER(payment-svc 장애가 아닌 실패)여도 둘째 묶음은 반영한다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [targets(100, 0), [target(ORDER_ID)]];
    fx.answer(answer(ORDER_ID));
    fx.batchQueue = [throws(new PaymentPullCallError('BAD_ANSWER')), undefined];
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 101, batches: 2, failedBatches: 1, applied: 1 });
  });

  test('잡기가 던지면 log.runError(claim) 한 줄이고 아무것도 하지 않은 결과다(던지지 않는다. 다음 틱에 다시) [ASVS v5.0.0-16.5.2]', async () => {
    const down = new Error('db down');
    fx.claimQueue = [down];
    await expect(puller().tick()).resolves.toEqual(ZERO);
    expect(fx.runErrors).toEqual([{ what: 'claim', err: down }]);
    notCalled('reader.batchGet', 'signals.batch', 'signals.failure');
  });

  test('defer가 던지면 log.runError(defer) 한 줄이고 미룬 수에 세지 않는다(다음 점검 5초 뒤 다시 묻는다) [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [[target()]];
    fx.answer(answer(ORDER_ID, { status: 'PARTIAL_CANCELED' }));
    const down = new Error('db down');
    fx.deferError = down;
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, deferred: 0 });
    expect(fx.runErrors).toEqual([{ what: 'defer', err: down }]);
  });

  test('지표·로그가 던져도 실행기를 막지 않는다: 반영·미루기를 이어 하고 틱은 던지지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.noisy = true;
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B), target(ORDER_C, { confirmSentAtMs: NOW - 20 * MIN })]];
    fx.answer(answer(ORDER_ID), answer(ORDER_B, { status: 'PARTIAL_CANCELED' }));
    const out = await puller().tick();
    expect(out).toEqual({ ...ZERO, claimed: 3, batches: 1, applied: 1, deferred: 2 });
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID]);
    expect(deferredIds()).toEqual([ORDER_B, ORDER_C].sort());
    await flush();
    expect(unhandled).toEqual([]);
  });
});

describe('start·stop', () => {
  test('start는 1초 [가정] 반복 하나를 켜고(두 번 불러도 하나), 틱은 잡기(claimDue)다. pollIntervalMs를 주면 그 간격이다 (ADR0140)', async () => {
    const r = puller();
    r.start();
    r.start();
    expect(timer.set.map((s) => s.ms)).toEqual([1000]);
    timer.tick();
    await flush();
    expect(fx.claimArgs).toEqual([100]);
    await r.stop();

    const t2 = new FakeTimer();
    const r2 = puller({ timer: t2, pollIntervalMs: 250 });
    r2.start();
    expect(t2.set.map((s) => s.ms)).toEqual([250]);
    await r2.stop();
  });

  test('틱이 겹치지 않는다: 앞 틱이 끝나지 않았으면(묶음 호출 중) 이번 틱은 건너뛴다', async () => {
    fx.claimQueue = [[target()]];
    fx.holdBatch = true;
    const r = puller();
    r.start();
    timer.tick();
    await flush();
    timer.tick();
    await flush();
    expect(fx.claimArgs).toHaveLength(1);
    fx.releaseBatches();
    await flush();
    fx.holdBatch = false;
    timer.tick();
    await flush();
    expect(fx.claimArgs).toHaveLength(2);
    await r.stop();
  });

  test('예상 밖 오류에 반복이 죽지 않는다: 잡기가 던져도 처리되지 않은 거절이 없고 다음 틱이 잡은 주문을 반영한다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [new Error('db down'), [target()]];
    fx.answer(answer());
    const r = puller();
    r.start();
    timer.tick();
    await flush();
    expect(fx.runErrors.map((e) => e.what)).toEqual(['claim']);
    timer.tick();
    await flush();
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID]);
    expect(unhandled).toEqual([]);
    await r.stop();
  });

  test('stop은 반복을 끄고(같은 handle로 clearInterval) 돌던 틱의 BatchGetPayments와 그 뒤 반영·미루기까지 기다린다. 멈춘 뒤의 start·tick은 아무것도 하지 않는다 (ADR0140)', async () => {
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B)]];
    fx.answer(answer(ORDER_ID), answer(ORDER_B, { status: 'PARTIAL_CANCELED' }));
    fx.holdBatch = true;
    const r = puller();
    r.start();
    timer.tick();
    await flush();
    expect(fx.batchArgs).toHaveLength(1);
    let stopped = false;
    const stopping = later(
      r.stop().then(() => {
        stopped = true;
      }),
    );
    await flush();
    expect(stopped).toBe(false);
    expect(timer.cleared).toEqual([timer.set[0]!.handle]);
    fx.releaseBatches();
    await stopping;
    expect(stopped).toBe(true);
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID]);
    expect(fx.defers).toEqual([{ orderIds: [ORDER_B], untilMs: SLOW }]);

    const before = fx.calls.length;
    fx.claimQueue = [[target(ORDER_C)]];
    r.start();
    expect(await r.tick()).toEqual(ZERO);
    await flush();
    expect(fx.calls.slice(before)).toEqual([]);
    expect(timer.set).toHaveLength(1);
  });

  test('stop은 밖에서 바로 부른 tick(돌던 반영 포함)도 기다린다', async () => {
    fx.claimQueue = [[target()]];
    fx.answer(answer());
    fx.holdExecute = true;
    const r = puller();
    const ticking = later(r.tick());
    await flush();
    expect(fx.events).toHaveLength(1);
    let stopped = false;
    const stopping = later(
      r.stop().then(() => {
        stopped = true;
      }),
    );
    await flush();
    expect(stopped).toBe(false);
    fx.releaseExecutes();
    await stopping;
    expect(stopped).toBe(true);
    expect((await ticking).applied).toBe(1);
  });

  test('멈추는 중에는 더 잡지 않는다: 첫 잡기가 100건을 채웠어도 stop 뒤에는 다음 잡기를 부르지 않는다 (ADR0140)', async () => {
    fx.claimQueue = [targets(100, 0), targets(100, 100)];
    const gate = deferred();
    fx.claimGates.set(0, gate.promise);
    const r = puller();
    const ticking = later(r.tick());
    await flush();
    const stopping = later(r.stop());
    gate.resolve();
    await stopping;
    await ticking;
    expect(fx.claimArgs).toEqual([100]);
  });

  test('틱은 실행기를 만든 때의 비동기 맥락에서 돈다: 남은 시간이 0인 요청 맥락 안에서 반복이 불려도 BatchGetPayments는 요청 맥락 없이 나간다', async () => {
    fx.claimQueue = [[target()]];
    fx.answer(answer());
    const r = puller();
    r.start();
    const dl = fakeClock({ now: NOW });
    const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(1, dl), route: '/v1/orders/{orderId}/payment-status', method: 'GET', log: {} as RequestContext['log'] };
    dl.advance(10);
    runInRequestContext(ctx, () => {
      expect(requestContext()?.deadline.remainingMs()).toBe(0);
      timer.tick();
    });
    await flush();
    expect(fx.contexts).toEqual([undefined]);
    expect(fx.events.map((e) => e.orderId)).toEqual([ORDER_ID]);
    await r.stop();
  });
});

describe('사건 길과 함께: 실제 반영 쓰임새(ApplyPaymentResult, 메모리 가짜 저장소)', () => {
  /** 사건 길과 같은 반영 쓰임새(커밋 뒤 발권 깨우기를 적는다) */
  function realApply(rf: ResultFakes, kicks: string[]) {
    return new ApplyPaymentResult({ reads: rf.reads, writes: rf.writes, sessions: rf.sessions, saga: rf.saga, log: rf.log, clock, onApproved: (id) => kicks.push(id) });
  }

  test('당기기가 승인을 반영한 뒤(T9 쓰기 한 번·발권 기한 = 실제 승인 + 30분·발권 깨우기 한 번·지표 pulled APPROVED) 같은 사건이 trade.payments로 늦게 와도 다시 반영하지 않는다(DUPLICATE, 쓰기 0) (P-T47, P-T15, ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    const rf = new ResultFakes();
    const kicks: string[] = [];
    const apply = realApply(rf, kicks);
    fx.claimQueue = [[target(ORDER_ID)]];
    fx.answer(answer(ORDER_ID));
    clock.advance(20_000);
    expect(await puller({ apply }).tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, applied: 1 });
    expect(rf.approved).toHaveLength(1);
    expect(rf.approved[0]).toMatchObject({ orderId: ORDER_ID, transition: 'T9', paymentEventSeq: EVENT_SEQ, issueDueAtMs: OCCURRED_AT_MS + 30 * MIN });
    expect(kicks).toEqual([ORDER_ID]);
    expect(fx.pulled).toEqual(['APPROVED']);
    // 커밋 뒤 DB의 주문(APPROVED, 순번 3). 같은 사건이 사건 길로 늦게 온다
    rf.order = resultOrder({ status: 'APPROVED', paymentEventSeq: EVENT_SEQ });
    expect(await apply.execute(paymentEvent())).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(rf.writeCount()).toBe(1);
    expect(kicks).toEqual([ORDER_ID]);
  });

  test('사건 길이 먼저 반영했으면(주문 순번 3) 당기기의 같은 순번 답은 건너뛰고 지표 pulled를 올리지 않는다 (P-T15, ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    const rf = new ResultFakes();
    rf.order = resultOrder({ status: 'APPROVED', paymentEventSeq: EVENT_SEQ });
    const kicks: string[] = [];
    fx.claimQueue = [[target(ORDER_ID)]];
    fx.answer(answer(ORDER_ID));
    expect(await puller({ apply: realApply(rf, kicks) }).tick()).toEqual({ ...ZERO, claimed: 1, batches: 1 });
    expect(rf.writeCount()).toBe(0);
    expect(fx.pulled).toEqual([]);
    expect(kicks).toEqual([]);
  });

  test('금액이 다른 답은 반영하지 않는다: 보류 로그 한 줄은 반영 쓰임새가 남기고(AMOUNT_MISMATCH) 실행기는 10분 미룬다(리뷰 고침 M3). 쓰기 0 (ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    const rf = new ResultFakes();
    fx.claimQueue = [[target(ORDER_ID)]];
    fx.answer(answer(ORDER_ID, { amount: AMOUNT + 1 }));
    expect(await puller({ apply: realApply(rf, []) }).tick()).toEqual({ ...ZERO, claimed: 1, batches: 1, deferred: 1 });
    expect(rf.heldLogs.map((h) => h.reason)).toEqual(['AMOUNT_MISMATCH']);
    expect(rf.writeCount()).toBe(0);
    expect(fx.defers).toEqual([{ orderIds: [ORDER_ID], untilMs: LONG }]);
    notCalled('log.runError', 'signals.pulled');
  });
});

/**
 * pull_next_at을 흉내 내는 대상 저장소(리뷰 고침 M3: 실행기 둘이 함께 쓴다). 잡기 기준은 data.md §5.1(보낸 지 5초 [가정]이 지났고 다음 점검 시각이 비었거나 지남,
 * 잡으면 다음 점검 = 지금 + 5초 [가정]), 미루기는 다음 점검 = untilMs다
 */
class ClockedTargets implements PaymentPullTargets {
  readonly #rows = new Map<string, { target: PaymentPullTarget; nextAt: number | undefined }>();
  /** defer에 넘긴 값(차례대로) */
  readonly defers: { orderIds: string[]; untilMs: number }[] = [];
  constructor(private readonly c: FakeClock) {}
  add(t: PaymentPullTarget): void {
    this.#rows.set(t.orderId, { target: t, nextAt: undefined });
  }
  /** 다음에 잡을 수 있는 가장 이른 시각 */
  nextDueAt(): number {
    return Math.min(...[...this.#rows.values()].map((r) => Math.max(r.target.confirmSentAtMs + 5_000, r.nextAt ?? Number.NEGATIVE_INFINITY)));
  }
  readonly claimDue = async (limit: number): Promise<PaymentPullTarget[]> => {
    const now = this.c.now();
    const due = [...this.#rows.values()].filter((r) => r.target.confirmSentAtMs <= now - 5_000 && (r.nextAt === undefined || r.nextAt <= now)).slice(0, limit);
    for (const r of due) r.nextAt = now + 5_000;
    return due.map((r) => ({ ...r.target }));
  };
  readonly defer = async (orderIds: readonly string[], untilMs: number): Promise<number> => {
    this.defers.push({ orderIds: [...orderIds], untilMs });
    let n = 0;
    for (const id of orderIds) {
      const r = this.#rows.get(id);
      if (r) {
        r.nextAt = untilMs;
        n += 1;
      }
    }
    return n;
  };
}

describe('리뷰 고침(2026-11-06 코드 리뷰, payment §2 \'중간 결과 뒤에도 당긴다\'·\'기록 없음이 길어질 때\')', () => {
  test.each<['UNKNOWN' | 'AWAITING_DEPOSIT', number]>([
    ['UNKNOWN', OUTAGE],
    ['AWAITING_DEPOSIT', SLOW],
  ])(
    '리뷰 고침 H1_답이 %s면 반영 결과(APPLIED·SKIPPED·오류)와 상관없이 그 주문의 다음 점검을 답의 상태로 정한다(UNKNOWN 지금 + 30초, 입금 대기 지금 + 60초): 같은 순번의 답을 5초마다 다시 묻지 않는다 (ADR0140) [ASVS v5.0.0-16.5.2]',
    async (status, until) => {
      fx.claimQueue = [[target(ORDER_ID), target(ORDER_B), target(ORDER_C)]];
      fx.answer(answer(ORDER_ID, { status, approvedAtMs: undefined }), answer(ORDER_B, { status, approvedAtMs: undefined }), answer(ORDER_C, { status, approvedAtMs: undefined }));
      // ORDER_B: 이미 반영한 순번(사건 길이 먼저 반영했거나 앞 점검이 반영함), ORDER_C: purchase DB 오류
      fx.executeAnswers.set(ORDER_B, { status: 'SKIPPED', reason: 'DUPLICATE' });
      fx.executeAnswers.set(ORDER_C, throws(new Error('connection terminated')));
      expect(await puller().tick()).toEqual({ ...ZERO, claimed: 3, batches: 1, applied: 1, deferred: 3 });
      expect(fx.defers).toEqual([{ orderIds: [ORDER_ID, ORDER_B, ORDER_C], untilMs: until }]);
      expect(fx.runErrors.map((e) => [e.what, e.orderId])).toEqual([['apply', ORDER_C]]);
    },
  );

  test.each<PaymentPullFailureCode>(['CIRCUIT_OPEN', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'])(
    '리뷰 고침 M2_BatchGetPayments가 %s(payment-svc가 답하지 못함)면 그 틱의 남은 잡기를 멈추고 그 묶음을 지금 + 30초로 미룬다: 대상이 1,000건이어도 claimDue는 한 번이다(purchase DB를 두드리지 않는다) (ADR0140) [ASVS v5.0.0-16.5.2]',
    async (code) => {
      fx.claimQueue = Array.from({ length: 10 }, (_, i) => targets(100, i * 100));
      fx.batchQueue = Array.from({ length: 10 }, () => throws(new PaymentPullCallError(code)));
      expect(await puller().tick()).toEqual({ ...ZERO, claimed: 100, batches: 1, failedBatches: 1, deferred: 100 });
      expect(fx.claimArgs).toEqual([100]);
      expect(fx.defers).toEqual([{ orderIds: targets(100, 0).map((t) => t.orderId), untilMs: OUTAGE }]);
      expect(fx.failures).toBe(1);
      notCalled('log.runError', 'apply.execute');
    },
  );

  test('리뷰 고침 M2_틱의 첫 묶음은 BatchGetPayments 답을 본 뒤에 다음 묶음을 잡는다(답이 오기 전에는 둘째 잡기를 부르지 않는다) (ADR0140)', async () => {
    fx.claimQueue = [targets(100, 0), [target(ORDER_B)]];
    fx.holdBatch = true;
    const ticking = later(puller().tick());
    await flush();
    expect(fx.claimArgs).toEqual([100]);
    fx.holdBatch = false;
    fx.releaseBatches();
    expect(await ticking).toEqual({ ...ZERO, claimed: 101, batches: 2 });
    expect(fx.claimArgs).toEqual([100, 100]);
  });

  test('리뷰 고침 M2_뒤 묶음이 UNAVAILABLE이면 그 묶음을 지금 + 30초로 미루고 그 뒤로는 잡지 않는다(이미 잡은 묶음은 부른다) (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [targets(100, 0), targets(100, 100), targets(100, 200), targets(100, 300)];
    fx.batchQueue = [undefined, throws(new PaymentPullCallError('UNAVAILABLE'))];
    // 셋째 잡기를 붙잡아 둘째 묶음의 실패가 먼저 실행기에 닿게 한다
    const gate = deferred();
    fx.claimGates.set(2, gate.promise);
    const ticking = later(puller().tick());
    await flush();
    gate.resolve();
    expect(await ticking).toEqual({ ...ZERO, claimed: 300, batches: 3, failedBatches: 1, deferred: 100 });
    expect(fx.claimArgs).toEqual([100, 100, 100]);
    expect(fx.defers).toEqual([{ orderIds: targets(100, 100).map((t) => t.orderId), untilMs: OUTAGE }]);
  });

  test('리뷰 고침 M2_payment-svc 장애가 아닌 실패(RESOURCE_EXHAUSTED·BAD_ANSWER)는 잡기를 멈추지 않고 미루지 않는다(다음 점검 5초 뒤) (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    fx.claimQueue = [targets(100, 0), targets(100, 100), [target(ORDER_ID)]];
    fx.answer(answer(ORDER_ID));
    fx.batchQueue = [throws(new PaymentPullCallError('RESOURCE_EXHAUSTED')), throws(new PaymentPullCallError('BAD_ANSWER')), undefined];
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 201, batches: 3, failedBatches: 2, applied: 1 });
    notCalled('targets.defer');
  });

  test('리뷰 고침 M3_파드 둘이 한 작업 표를 번갈아 잡아도 기록 없음 SEV2 한 줄(log.missing)은 10분 동안 주문마다 한 번이다: 그 주문의 다음 점검을 지금 + 10분으로 미룬다(파드 메모리 창만으로는 다른 파드의 줄을 막지 못한다) (ADR0140) [ASVS v5.0.0-16.3.4]', async () => {
    const store = new ClockedTargets(clock);
    // 처음부터 10분이 넘은 주문과, 1분 뒤에 10분이 되는 주문
    store.add(target(ORDER_ID, { confirmSentAtMs: NOW - 10 * MIN }));
    store.add(target(ORDER_B, { confirmSentAtMs: NOW - 9 * MIN }));
    const pods = [puller({ targets: store }), puller({ targets: store })];
    let turns = 0;
    for (let next = store.nextDueAt(); next < NOW + 10 * MIN; next = store.nextDueAt()) {
      clock.advance(Math.max(0, next - clock.now()));
      await pods[turns % 2]!.tick();
      turns += 1;
    }
    const perOrder = new Map<string, number>();
    for (const l of fx.missingLogs) perOrder.set(l.orderId, (perOrder.get(l.orderId) ?? 0) + 1);
    expect(Object.fromEntries(perOrder)).toEqual({ [ORDER_ID]: 1, [ORDER_B]: 1 });
    // 두 파드가 실제로 번갈아 잡았다(ORDER_B는 10분이 되기 전까지 5초마다 잡힌다)
    expect(turns).toBeGreaterThan(10);
    // 처음부터 10분이 넘은 주문은 첫 점검에서 한 번만 미뤘다(지금 + 10분)
    expect(store.defers.filter((d) => d.orderIds.includes(ORDER_ID)).map((d) => d.untilMs)).toEqual([LONG]);
  });

  test('리뷰 고침 M3_반영이 보류(HOLD)로 끝난 주문도 다음 점검을 지금 + 10분으로 미룬다(같은 답은 다시 보류된다). 취소 상태·모양 틀림(IGNORE)은 60초 그대로다 (ADR0140) [ASVS v5.0.0-2.3.3]', async () => {
    fx.claimQueue = [[target(ORDER_ID), target(ORDER_B), target(ORDER_C)]];
    fx.answer(answer(ORDER_ID), answer(ORDER_B, { status: 'PARTIAL_CANCELED' }), answer(ORDER_C, { status: 'UNSPECIFIED' }));
    fx.executeAnswers.set(ORDER_ID, throws(new PaymentResultHeld('AMOUNT_MISMATCH', ORDER_ID, 'APPROVED')));
    expect(await puller().tick()).toEqual({ ...ZERO, claimed: 3, batches: 1, deferred: 3 });
    expect([...fx.defers].sort((a, b) => a.untilMs - b.untilMs)).toEqual([
      { orderIds: [ORDER_B, ORDER_C], untilMs: SLOW },
      { orderIds: [ORDER_ID], untilMs: LONG },
    ]);
  });
});

describe('운영 조립(main.ts)', () => {
  test('리뷰 고침 L1_종료(SIGTERM) 때 당기기 실행기는 Kafka 소비자와 함께 먼저 멈추고, 그 뒤에 Saga·발권 실행기·기다림 표를 멈춘다(당기기의 반영이 그 셋을 깨우므로) (ADR0140)', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    const at = main.indexOf('function shutdown(');
    expect(at, 'main.ts에 function shutdown이 있다').toBeGreaterThan(-1);
    const body = main.slice(at);
    // 첫 단계(첫 .then 앞)와 둘째 단계(그 .then 몸통)
    const firstThen = body.indexOf('.then(');
    const secondThen = body.indexOf('.then(', firstThen + 1);
    const first = body.slice(0, firstThen);
    const second = body.slice(firstThen, secondThen);
    expect(first).toMatch(/consumers\?\.stop\(\)/);
    expect(first).toMatch(/paymentPuller\?\.stop\(\)/);
    expect(second).not.toMatch(/paymentPuller\?\.stop\(\)/);
    for (const later of ['sagaRunner', 'ticketRunner', 'paymentStatusWaiters']) {
      expect(second, later).toMatch(new RegExp(`\\b${later}\\?\\.stop\\(\\)`));
      expect(first, later).not.toMatch(new RegExp(`\\b${later}\\?\\.stop\\(\\)`));
    }
  });

  test('변이 검토 PRF-171_운영 main.ts는 당기기 실행기를 만들고, 듣기 시작한 뒤 start()로 켜며, 종료 때 stop()으로 끈다(빠뜨려도 형 오류가 없어 글로 본다) (ADR0140)', () => {
    // 줄 주석은 뺀다(주석으로 막은 줄이 통과하지 않게)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    expect(main).toMatch(/\bpaymentPuller = new PaymentResultPuller\(\{/);
    const listenAt = main.indexOf('await service.listen();');
    expect(listenAt, 'main.ts에 await service.listen()이 있다').toBeGreaterThan(-1);
    // 1초 반복은 듣기 시작한 뒤에 켠다(Saga·발권 실행기와 같은 자리)
    expect(main.slice(listenAt)).toMatch(/^\s*paymentPuller\?\.start\(\);/m);
    expect(main).toMatch(/\bpaymentPuller\?\.stop\(\)/);
  });
});
