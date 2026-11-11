// 결제 결과 반영 쓰임새(application/apply-payment-result.ts ApplyPaymentResult, docs/features/payment.md §2 '결제 결과 반영의 첫 구현', §3 T9~T17, BUILD_ORDER PRF-163)를
// 메모리 가짜 포트로 본다. 결정별 쓰기 갈래와 그 입력 칸(전이·순번·행위자·좌석·발권 기한·실패 사유·판매 행 지우기), 건너뛰기, 보류 표지의 칸,
// 쓰기가 STALE일 때([정함]: PAYMENT_SEQ → DUPLICATE, NOT_FOUND → 보류, STATUS → 다시 읽고 한 번 더 → 그래도면 Conflict), 커밋 뒤 일(구매 세션 끝내기·Paying 풀기·Saga 깨우기,
// 던져도 결과는 그대로), DB 오류는 그대로 던짐. 끝에 커밋 뒤 구매 세션 일의 inventory 다리(InventoryPaymentResultSessions)를 본다.
// 리뷰(2026-11-05) 반영: M2 닫힌 주문 과금 보류(CHARGED_ON_CLOSED_ORDER, SEV1), M3 취소류 보류(NOT_YET_SUPPORTED), M4 판매 행 어긋남 보류(SOLD_MISMATCH, SEV1),
// L1 승인된 주문의 다시 온 사건은 구매 세션 끝내기만 다시, L5 같은 사건의 보류 로그는 한 번(시간 창 안), L6 금액·결제사 대조 실패는 보안 이벤트 표시.
// PRF-170: 승인(T9·T13·T16)을 커밋한 뒤 발권 실행기 깨우기(onApproved)를 한 번 부르고, 실패·입금 대기·보류·건너뜀에는 부르지 않는다.
// 실제 PostgreSQL로 도는 승인·실패 트랜잭션은 test-int(다른 담당)다.
import { fakeClock, type HotPathMetrics, isTransientError } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  ApplyPaymentResult,
  type ApplyPaymentResultDeps,
  InventoryPaymentResultSessions,
  OrderSeatStoreUnavailable,
  PAYMENT_RESULT_ACTOR,
  PAYMENT_RESULT_HELD_LOG_WINDOW_MS,
  PAYMENT_RESULT_STALE_RETRIES,
  PaymentResultConflict,
  PaymentResultHeld,
  type PaymentResultEvent,
  type PaymentResultHoldReason,
  type PaymentResultOrder,
  type PaymentSessionSource,
  TICKET_ISSUE_WINDOW_MS,
} from '../src/modules/booking/index.js';
import { ACCOUNT, AMOUNT, EVENT, PSID } from './order-cases.js';
import {
  APPLY_NOW,
  EVENT_SEQ,
  OCCURRED_AT,
  OCCURRED_AT_MS,
  ORDER_ID,
  ORDER_PAYMENT_SEQ,
  paymentEvent,
  type ResultCall,
  ResultFakes,
  resultOrder,
  SEAT_IDS,
} from './payment-result-cases.js';

const MIN = 60_000;
const clock = fakeClock({ now: APPLY_NOW });
const fx = new ResultFakes();
const deps = (over: Partial<ApplyPaymentResultDeps> = {}): ApplyPaymentResultDeps => ({
  reads: fx.reads,
  writes: fx.writes,
  sessions: fx.sessions,
  saga: fx.saga,
  log: fx.log,
  clock,
  ...over,
});
const run = (event: PaymentResultEvent = paymentEvent(), over: Partial<ApplyPaymentResultDeps> = {}) => new ApplyPaymentResult(deps(over)).execute(event);

/** 발권 기한(사건의 승인 시각 + 30분. 반영 시각 APPLY_NOW가 아니다) */
const DUE = OCCURRED_AT_MS + 30 * MIN;
/** 판매 행 지우기 입력(주문의 회차·계정·좌석) */
const RELEASE = { eventId: EVENT, orderId: ORDER_ID, accountId: ACCOUNT, seatIds: SEAT_IDS };
const PG_DOWN = () => Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });

/** 보류 까닭별 로그 수준·표시(리뷰 M2·M4·L6을 시험 쪽에 따로 적은 것) */
const HOLD_LOG: Record<PaymentResultHoldReason, { severity: 'SEV1' | 'SEV2'; kind?: string }> = {
  IMPOSSIBLE: { severity: 'SEV2' },
  AMOUNT_MISMATCH: { severity: 'SEV2', kind: 'security' },
  PG_MISMATCH: { severity: 'SEV2', kind: 'security' },
  NOT_YET_SUPPORTED: { severity: 'SEV2' },
  CHARGED_ON_CLOSED_ORDER: { severity: 'SEV1', kind: 'payment-charged-closed' },
  SOLD_MISMATCH: { severity: 'SEV1' },
  DEPOSIT_REVERSED_NOT_CONFIRMED: { severity: 'SEV1' },
};
/** 보류 로그 한 줄의 기대 값(주문 ID·사건 종류·결제사·까닭·수준·표시만. 금액·결제 참조는 없다) */
const heldLine = (reason: PaymentResultHoldReason, event: PaymentResultEvent = paymentEvent()) => ({ orderId: event.orderId, type: event.type, pg: event.pg, reason, ...HOLD_LOG[reason] });

/** 이 포트들은 부르지 않았다 */
function notCalled(...ports: ResultCall[]) {
  for (const p of ports) expect(fx.calls, `${p}를 부르면 안 된다`).not.toContain(p);
}
/** 커밋 뒤 일이 없었다 */
function noAfterCommit() {
  notCalled('sessions.complete', 'sessions.unmarkPaying', 'saga.kick', 'log.afterCommitFailed');
}

beforeEach(() => {
  fx.reset();
});

describe('승인 반영(T9·T13·T16): approve 한 트랜잭션 → 커밋 뒤 구매 세션 끝내기', () => {
  test.each([
    ['RESERVED', 'T9'],
    ['UNKNOWN', 'T13'],
    ['AWAITING_DEPOSIT', 'T16'],
  ] as const)('FR011_%s 주문에 APPROVED → APPLIED %s(APPROVE), 읽기 → approve → sessions.complete 차례로 한 번씩 부른다', async (status, transition) => {
    fx.order = resultOrder({ status });
    expect(await run()).toEqual({ status: 'APPLIED', transition, write: 'APPROVE' });
    expect(fx.calls).toEqual(['reads.read', 'writes.approve', 'sessions.complete']);
    expect(fx.readIds).toEqual([ORDER_ID]);
    expect(fx.approved.map((a) => a.transition)).toEqual([transition]);
    expect(fx.completed).toEqual([PSID]);
  });

  test('PT13_approve 입력 칸: 주문 ID·전이·사건 순번·행위자 system:payment-result·회차·주문 좌석(줄 번호 차례)·발권 기한(승인 시각 + 30분)', async () => {
    await run();
    expect(PAYMENT_RESULT_ACTOR).toBe('system:payment-result');
    expect(fx.approved).toEqual([
      { orderId: ORDER_ID, transition: 'T9', paymentEventSeq: EVENT_SEQ, actor: 'system:payment-result', eventId: EVENT, seatIds: SEAT_IDS, issueDueAtMs: DUE },
    ]);
  });

  test('PT39_발권 기한은 반영 시각이 아니라 사건의 occurredAt + 30분이다(당기기로 10분 늦게 반영해도 실제 승인에 묶인다)', async () => {
    expect(APPLY_NOW - OCCURRED_AT_MS).toBeGreaterThan(9 * MIN);
    await run(paymentEvent({ occurredAt: '2026-11-05T12:00:05.000+09:00' }));
    expect(fx.approved[0]!.issueDueAtMs).toBe(Date.parse(OCCURRED_AT) + TICKET_ISSUE_WINDOW_MS);
    expect(fx.approved[0]!.issueDueAtMs).not.toBe(APPLY_NOW + TICKET_ISSUE_WINDOW_MS);
  });

  test('P-T3_리뷰 고침 M5: UNKNOWN을 푼 승인(T13)의 발권 기한은 반영 시각 + 30분이다(오래전에 승인된 결제가 반영하자마자 기한 넘김이 되지 않는다)', async () => {
    expect(APPLY_NOW).toBeGreaterThan(OCCURRED_AT_MS);
    fx.order = resultOrder({ status: 'UNKNOWN' });
    await run();
    expect(fx.approved.map((a) => [a.transition, a.issueDueAtMs])).toEqual([['T13', APPLY_NOW + TICKET_ISSUE_WINDOW_MS]]);
  });

  test('P-T3_리뷰 고침 M5: T13에서 사건 시각이 반영 시각보다 뒤면 사건 시각 + 30분이다(둘 가운데 늦은 쪽)', async () => {
    const later = new Date(APPLY_NOW + 5 * MIN).toISOString();
    fx.order = resultOrder({ status: 'UNKNOWN' });
    await run(paymentEvent({ occurredAt: later }));
    expect(fx.approved[0]!.issueDueAtMs).toBe(Date.parse(later) + TICKET_ISSUE_WINDOW_MS);
  });

  test('P-T3_리뷰 고침 M5: T9의 발권 기한은 그대로 사건 시각 + 30분이다', async () => {
    await run();
    expect(fx.approved.map((a) => [a.transition, a.issueDueAtMs])).toEqual([['T9', DUE]]);
  });

  test('P-T36_리뷰 고침 M4: 입금 승인(T16)의 발권 기한도 반영 시각 + 30분이다(오래전 입금이 반영하자마자 기한 넘김이 되지 않는다)', async () => {
    expect(APPLY_NOW).toBeGreaterThan(OCCURRED_AT_MS);
    fx.order = resultOrder({ status: 'AWAITING_DEPOSIT' });
    await run();
    expect(fx.approved.map((a) => [a.transition, a.issueDueAtMs])).toEqual([['T16', APPLY_NOW + TICKET_ISSUE_WINDOW_MS]]);
  });

  test('P-T36_리뷰 고침 M4: T16에서 사건 시각이 반영 시각보다 뒤면 사건 시각 + 30분이다(T13과 같은 규칙)', async () => {
    const later = new Date(APPLY_NOW + 5 * MIN).toISOString();
    fx.order = resultOrder({ status: 'AWAITING_DEPOSIT' });
    await run(paymentEvent({ occurredAt: later }));
    expect(fx.approved[0]!.issueDueAtMs).toBe(Date.parse(later) + TICKET_ISSUE_WINDOW_MS);
  });

  test('FR011_사건 회차가 아니라 주문의 회차·좌석을 쓴다(trade.payments의 eventId는 Kafka 키로 쓰는 회차다)', async () => {
    const otherEvent = '0190f3a1-7c2e-7c00-8000-0000000000c9';
    await run(paymentEvent({ eventId: otherEvent }));
    expect(fx.approved[0]).toMatchObject({ eventId: EVENT, seatIds: SEAT_IDS });
  });
});

describe('실패 반영(T11·T15·T17): fail 한 트랜잭션 → 커밋 뒤 Paying 풀기와 Saga 깨우기', () => {
  test.each([
    ['RESERVED', 'T11'],
    ['UNKNOWN', 'T15'],
    ['AWAITING_DEPOSIT', 'T17'],
  ] as const)('PT2_%s 주문에 FAILED → APPLIED %s(FAIL), fail 입력 칸이 실패 사유·회차·판매 행 지우기(주문의 회차·계정·좌석)를 싣는다', async (status, transition) => {
    fx.order = resultOrder({ status });
    expect(await run(paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }))).toEqual({ status: 'APPLIED', transition, write: 'FAIL' });
    expect(fx.failed).toEqual([
      { orderId: ORDER_ID, transition, paymentEventSeq: EVENT_SEQ, actor: PAYMENT_RESULT_ACTOR, failureReason: 'CARD_DECLINED', eventId: EVENT, release: RELEASE },
    ]);
    expect(fx.calls.slice(0, 2)).toEqual(['reads.read', 'writes.fail']);
    // 커밋 뒤 일 둘의 차례는 정본에 없다
    expect([...fx.calls.slice(2)].sort()).toEqual(['saga.kick', 'sessions.unmarkPaying']);
    expect(fx.unmarked).toEqual([PSID]);
    expect(fx.kicked).toEqual([ORDER_ID]);
    notCalled('sessions.complete', 'writes.approve', 'writes.mark');
  });

  test('PT2_failureCategory가 없는 FAILED는 실패 사유 PG_ERROR로 반영한다', async () => {
    await run(paymentEvent({ type: 'FAILED', result: 'DECLINED' }));
    expect(fx.failed.map((f) => f.failureReason)).toEqual(['PG_ERROR']);
  });

  test('PT2_실패 사유는 사건의 failureCategory 그대로다(EXPIRED·THROTTLED)', async () => {
    await run(paymentEvent({ type: 'FAILED', failureCategory: 'EXPIRED' }));
    fx.order = resultOrder({ status: 'UNKNOWN' });
    await run(paymentEvent({ type: 'FAILED', failureCategory: 'THROTTLED' }));
    expect(fx.failed.map((f) => [f.transition, f.failureReason])).toEqual([
      ['T11', 'EXPIRED'],
      ['T15', 'THROTTLED'],
    ]);
  });
});

describe('상태만 반영(T10·T12·T14): mark 한 트랜잭션', () => {
  test.each([
    ['AWAITING_DEPOSIT', 'RESERVED', 'T10'],
    ['AWAITING_DEPOSIT', 'UNKNOWN', 'T14'],
  ] as const)('PT36_%s 사건 × %s 주문 → APPLIED %s(MARK), 커밋 뒤 구매 세션을 끝낸다(입금 대기는 세션이 끝나고 좌석은 PENDING 유지)', async (type, status, transition) => {
    fx.order = resultOrder({ status });
    expect(await run(paymentEvent({ type, result: 'WAITING_FOR_DEPOSIT' }))).toEqual({ status: 'APPLIED', transition, write: 'MARK' });
    expect(fx.marked).toEqual([{ orderId: ORDER_ID, transition, paymentEventSeq: EVENT_SEQ, actor: PAYMENT_RESULT_ACTOR }]);
    expect(fx.calls).toEqual(['reads.read', 'writes.mark', 'sessions.complete']);
    expect(fx.completed).toEqual([PSID]);
  });

  test('PT3_UNKNOWN 사건 × RESERVED 주문 → APPLIED T12(MARK), 커밋 뒤에는 아무것도 하지 않는다(결과가 정해지지 않았다, [정함])', async () => {
    expect(await run(paymentEvent({ type: 'UNKNOWN', result: 'UNKNOWN' }))).toEqual({ status: 'APPLIED', transition: 'T12', write: 'MARK' });
    expect(fx.marked).toEqual([{ orderId: ORDER_ID, transition: 'T12', paymentEventSeq: EVENT_SEQ, actor: PAYMENT_RESULT_ACTOR }]);
    expect(fx.calls).toEqual(['reads.read', 'writes.mark']);
  });
});

describe('건너뛰기(결정의 SKIP): 쓰지 않고 SKIPPED', () => {
  test('PT15_순번이 이미 반영한 것 이하면 SKIPPED DUPLICATE이고, 읽기만 하며 로그도 남기지 않는다', async () => {
    expect(await run(paymentEvent({ eventSeq: ORDER_PAYMENT_SEQ }))).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(fx.calls).toEqual(['reads.read']);
  });

  test('PT15_주문이 이미 도착 상태면 SKIPPED ALREADY_THERE이고 로그를 남기지 않는다(UNKNOWN 주문은 승인되지 않아 구매 세션 일도 없다)', async () => {
    fx.order = resultOrder({ status: 'UNKNOWN' });
    expect(await run(paymentEvent({ type: 'UNKNOWN' }))).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(fx.calls).toEqual(['reads.read']);
  });

  test('FR011_RESOLVED는 SKIPPED RECORD_ONLY이고 로그를 남기지 않는다', async () => {
    fx.order = resultOrder({ status: 'UNKNOWN' });
    expect(await run(paymentEvent({ type: 'RESOLVED', result: 'APPROVED' }))).toEqual({ status: 'SKIPPED', reason: 'RECORD_ONLY' });
    expect(fx.calls).toEqual(['reads.read']);
  });

  test('P-T36 ④_되돌림은 T21 한 트랜잭션이고 판매 행 기한은 새 기한 + 10분이며 커밋 뒤 무효 실행기를 깨운다 [ASVS v5.0.0-2.3.3]', async () => {
    fx.order = resultOrder({ status: 'CONFIRMED' });
    const reversed: string[] = [];
    const due = '2026-11-20T10:00:00.000+09:00';
    const out = await run(paymentEvent({ type: 'DEPOSIT_REVERSED', depositDueAt: due }), { onDepositReversed: (id) => void reversed.push(id) });
    expect(out).toEqual({ status: 'APPLIED', transition: 'T21', write: 'REVERSE' });
    expect(fx.reversed).toEqual([{ orderId: ORDER_ID, transition: 'T21', paymentEventSeq: EVENT_SEQ, actor: 'system:payment-result', eventId: EVENT, seatIds: SEAT_IDS, pendingUntilMs: Date.parse(due) + 10 * MIN }]);
    expect(reversed).toEqual([ORDER_ID]);
    noAfterCommit();
  });

  test('P-T36 ④_사건에 기한이 없으면 경고 뒤 판매 행 기한 없이 쓴다', async () => {
    fx.order = resultOrder({ status: 'CONFIRMED' });
    const missing: string[] = [];
    await run(paymentEvent({ type: 'DEPOSIT_REVERSED' }), { log: { ...fx.log, depositDueMissing: (e: { orderId: string }) => void missing.push(e.orderId) } });
    expect(fx.reversed[0]!.pendingUntilMs).toBeUndefined();
    expect(missing).toEqual([ORDER_ID]);
  });

  test('P-T36 ④_출발 상태가 CONFIRMED가 아니면 쓰지 않고 SEV1 보류다 [ASVS v5.0.0-16.3.3]', async () => {
    fx.order = resultOrder({ status: 'APPROVED' });
    const e = paymentEvent({ type: 'DEPOSIT_REVERSED' });
    await expect(run(e)).rejects.toMatchObject({ reason: 'DEPOSIT_REVERSED_NOT_CONFIRMED' });
    expect(fx.reversed).toEqual([]);
    expect(fx.heldLogs).toEqual([heldLine('DEPOSIT_REVERSED_NOT_CONFIRMED', e)]);
  });

  test('P-T36 ④_리뷰 고침 M4: APPROVED 주문의 되돌림은 보류하면서 그 주문의 발권 작업을 멈춘다(미납 티켓이 새로 나가지 않게) [ASVS v5.0.0-16.3.3]', async () => {
    fx.order = resultOrder({ status: 'APPROVED' });
    const e = paymentEvent({ type: 'DEPOSIT_REVERSED' });
    await expect(run(e)).rejects.toMatchObject({ reason: 'DEPOSIT_REVERSED_NOT_CONFIRMED' });
    expect(fx.heldIssues).toEqual([ORDER_ID]);
    expect(fx.calls).toEqual(['reads.read', 'writes.holdIssue', 'log.held']);
    expect(fx.reversed).toEqual([]);
  });

  test.each(['PARTIALLY_REFUNDED', 'AWAITING_DEPOSIT'] as const)('P-T36 ④_리뷰 고침 M4: %s 주문은 멈출 발권 작업이 없어 부르지 않고 보류만 한다', async (status) => {
    fx.order = resultOrder({ status });
    await expect(run(paymentEvent({ type: 'DEPOSIT_REVERSED' }))).rejects.toMatchObject({ reason: 'DEPOSIT_REVERSED_NOT_CONFIRMED' });
    expect(fx.heldIssues).toEqual([]);
  });

  test('P-T36 ④_리뷰 고침 M4: 발권 작업을 멈추지 못했으면 보류하지 않고 DB 오류를 그대로 던진다(일시 실패로 다시 한다)', async () => {
    fx.order = resultOrder({ status: 'APPROVED' });
    fx.holdIssueAnswer = PG_DOWN();
    await expect(run(paymentEvent({ type: 'DEPOSIT_REVERSED' }))).rejects.toMatchObject({ code: '57P01' });
    expect(fx.heldLogs).toEqual([]);
  });

  test('P-T36 ④_리뷰 고침 M4: 다시 처리(RB-11) 때 주문이 CONFIRMED면 정상 경로 T21이다', async () => {
    fx.readQueue = [resultOrder({ status: 'APPROVED' }), resultOrder({ status: 'CONFIRMED' })];
    const e = paymentEvent({ type: 'DEPOSIT_REVERSED' });
    await expect(run(e)).rejects.toBeInstanceOf(PaymentResultHeld);
    expect(await run(e)).toEqual({ status: 'APPLIED', transition: 'T21', write: 'REVERSE' });
    expect(fx.heldIssues).toEqual([ORDER_ID]);
  });

  test.each(['PARTIAL_CANCELED', 'CANCELED'] as const)(
    'FR011_%s는 건너뛰지 않고 PaymentResultHeld(NOT_YET_SUPPORTED)로 보류한다(보류 표에 남아 맡을 단계가 생기면 다시 처리, 리뷰 M3). log.held 한 줄(SEV2), 쓰기·구매 세션 일 없음',
    async (type) => {
      fx.order = resultOrder({ status: 'CONFIRMED' });
      const e = paymentEvent({ type });
      const err = await run(e).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(err).toBeInstanceOf(PaymentResultHeld);
      expect(err).toMatchObject({ reason: 'NOT_YET_SUPPORTED', orderId: ORDER_ID, eventType: type });
      expect(fx.calls).toEqual(['reads.read', 'log.held']);
      expect(fx.heldLogs).toEqual([heldLine('NOT_YET_SUPPORTED', e)]);
    },
  );
});

describe('승인된 주문의 다시 온 사건(리뷰 L1): 구매 세션 끝내기만 다시 부른다', () => {
  test.each(['APPROVED', 'CONFIRMED', 'AWAITING_DEPOSIT'] as const)(
    'POL009_%s 주문에 다시 온 사건(DUPLICATE)은 SKIPPED이고 sessions.complete를 한 번 부른다(커밋 뒤 일이 한 번 실패한 경우를 메움). Paying 풀기·쓰기·로그는 없다',
    async (status) => {
      fx.order = resultOrder({ status, paymentEventSeq: EVENT_SEQ });
      expect(await run()).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
      expect(fx.calls).toEqual(['reads.read', 'sessions.complete']);
      expect(fx.completed).toEqual([PSID]);
    },
  );

  test.each([
    ['APPROVED', 'APPROVED'],
    ['AWAITING_DEPOSIT', 'AWAITING_DEPOSIT'],
  ] as const)('POL009_%s 주문에 새 순번 %s(ALREADY_THERE)도 SKIPPED이고 sessions.complete만 부른다', async (status, type) => {
    fx.order = resultOrder({ status });
    expect(await run(paymentEvent({ type }))).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(fx.calls).toEqual(['reads.read', 'sessions.complete']);
    expect(fx.completed).toEqual([PSID]);
  });

  test('POL009_다시 온 사건의 구매 세션 끝내기가 던져도 SKIPPED 그대로이고 afterCommitFailed(complete_session) 한 줄이다', async () => {
    fx.order = resultOrder({ status: 'APPROVED' });
    fx.completeAnswer = new OrderSeatStoreUnavailable();
    expect(await run()).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(fx.afterCommitLogs).toEqual([{ orderId: ORDER_ID, what: 'complete_session', errorName: 'OrderSeatStoreUnavailable' }]);
  });

  test('POL009_승인되지 않은 주문(RESERVED·FAILED·UNKNOWN)의 다시 온 사건과 승인된 주문의 RESOLVED(RECORD_ONLY)는 구매 세션 일이 없다', async () => {
    for (const status of ['RESERVED', 'FAILED', 'UNKNOWN'] as const) {
      fx.reset();
      fx.order = resultOrder({ status, paymentEventSeq: EVENT_SEQ });
      expect(await run(), status).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
      expect(fx.calls, status).toEqual(['reads.read']);
    }
    fx.reset();
    fx.order = resultOrder({ status: 'APPROVED' });
    expect(await run(paymentEvent({ type: 'RESOLVED', result: 'APPROVED' }))).toEqual({ status: 'SKIPPED', reason: 'RECORD_ONLY' });
    expect(fx.calls).toEqual(['reads.read']);
  });
});

describe('보류(결정의 HOLD): log.held 한 줄 뒤 PaymentResultHeld', () => {
  const holdCases: [string, PaymentResultHoldReason, PaymentResultOrder | undefined, PaymentResultEvent][] = [
    ['주문 없음', 'IMPOSSIBLE', undefined, paymentEvent()],
    ['CONFIRMED 주문에 새 순번 APPROVED', 'IMPOSSIBLE', resultOrder({ status: 'CONFIRMED' }), paymentEvent()],
    ['FAILED 주문에 APPROVED(과금됐는데 주문이 실패, 리뷰 M2)', 'CHARGED_ON_CLOSED_ORDER', resultOrder({ status: 'FAILED' }), paymentEvent()],
    ['EXPIRED 주문에 APPROVED(리뷰 M2)', 'CHARGED_ON_CLOSED_ORDER', resultOrder({ status: 'EXPIRED' }), paymentEvent()],
    ['접수한 결제 시도가 없는 EXPIRED 주문에 APPROVED(PG_MISMATCH가 아니다, 리뷰 M2)', 'CHARGED_ON_CLOSED_ORDER', resultOrder({ status: 'EXPIRED', acceptedPg: undefined }), paymentEvent()],
    ['COMPENSATED 주문에 AWAITING_DEPOSIT(리뷰 M2)', 'CHARGED_ON_CLOSED_ORDER', resultOrder({ status: 'COMPENSATED' }), paymentEvent({ type: 'AWAITING_DEPOSIT' })],
    ['결제사 다름', 'PG_MISMATCH', resultOrder(), paymentEvent({ pg: 'PORTONE' })],
    ['접수한 결제 시도 없음', 'PG_MISMATCH', resultOrder({ acceptedPg: undefined }), paymentEvent()],
    ['금액 다름', 'AMOUNT_MISMATCH', resultOrder(), paymentEvent({ amount: AMOUNT + 1000 })],
  ];
  test.each(holdCases)('FR011_%s → PaymentResultHeld(%s)를 던지고, 쓰기·커밋 뒤 일이 없다', async (_name, reason, order, event) => {
    fx.order = order;
    const err = await run(event).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentResultHeld);
    const held = err as PaymentResultHeld;
    expect({ name: held.name, reason: held.reason, orderId: held.orderId, eventType: held.eventType }).toEqual({ name: 'PaymentResultHeld', reason, orderId: ORDER_ID, eventType: event.type });
    // 로그 한 줄: 주문 ID·사건 종류·결제사·까닭·수준(닫힌 주문 과금은 SEV1)·표시(금액·결제사 대조 실패는 보안 이벤트, 리뷰 L6)
    expect(fx.heldLogs).toEqual([heldLine(reason, event)]);
    expect(JSON.stringify(fx.heldLogs)).not.toContain(String(event.amount));
    expect(fx.calls).toEqual(['reads.read', 'log.held']);
    expect(fx.writeCount()).toBe(0);
    noAfterCommit();
  });

  test('ADR0142_보류 표지는 같은 결과일 실패다: 일시 실패로 읽히지 않고(이름·code·cause 없음), 글에 까닭만 싣는다(금액·조사용 가명·순번을 싣지 않는다)', async () => {
    const err = await run(paymentEvent({ amount: 123_456 })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentResultHeld);
    expect(isTransientError(err)).toBe(false);
    const e = err as Error & { code?: unknown };
    expect(e.code).toBeUndefined();
    expect(e.cause).toBeUndefined();
    expect(e.message).toContain('AMOUNT_MISMATCH');
    expect(e.message).not.toContain('123456');
    expect(e.message).not.toContain('123,456');
    expect(e.message).not.toContain(String(AMOUNT));
  });

  test('ADR0142_같은 사건(eventKey)이 같은 까닭으로 다시 보류되면 시간 창(PAYMENT_RESULT_HELD_LOG_WINDOW_MS) 안에서는 log.held를 다시 남기지 않는다(키 단위 소비자가 5회 해 보는 동안 한 줄, 보류 확정은 플랫폼 onHeld가 한 번 남긴다, 리뷰 L5)', async () => {
    const own = fakeClock({ now: APPLY_NOW });
    const apply = new ApplyPaymentResult(deps({ clock: own }));
    const tries = async (e: PaymentResultEvent, n: number) => {
      for (let i = 0; i < n; i += 1) await expect(apply.execute(e)).rejects.toBeInstanceOf(PaymentResultHeld);
    };
    fx.order = resultOrder({ status: 'FAILED' });
    await tries(paymentEvent(), 5);
    expect(fx.heldLogs).toEqual([heldLine('CHARGED_ON_CLOSED_ORDER')]);
    // 다른 사건은 따로 한 줄
    await tries(paymentEvent({ eventKey: '0190f3a1-7c2e-7f00-8000-0000000000e8', eventSeq: EVENT_SEQ + 1 }), 2);
    expect(fx.heldLogs).toHaveLength(2);
    // 같은 사건이라도 까닭이 바뀌면(그사이 주문이 바뀜) 한 줄 더
    fx.order = resultOrder({ status: 'CONFIRMED' });
    await tries(paymentEvent(), 2);
    expect(fx.heldLogs.map((l) => l.reason)).toEqual(['CHARGED_ON_CLOSED_ORDER', 'CHARGED_ON_CLOSED_ORDER', 'IMPOSSIBLE']);
    // 창이 지나면(운영자가 다시 넣음 등) 다시 남긴다
    expect(PAYMENT_RESULT_HELD_LOG_WINDOW_MS).toBe(60_000);
    own.advance(PAYMENT_RESULT_HELD_LOG_WINDOW_MS);
    await tries(paymentEvent(), 1);
    expect(fx.heldLogs).toHaveLength(4);
  });
});

describe('쓰기가 STALE일 때([정함] 6번)', () => {
  test.each([
    ['approve', paymentEvent(), 'RESERVED'],
    ['fail', paymentEvent({ type: 'FAILED', failureCategory: 'USER_ABORTED' }), 'RESERVED'],
    ['mark', paymentEvent({ type: 'UNKNOWN' }), 'RESERVED'],
  ] as const)('PT15_%s가 STALE PAYMENT_SEQ(그 순번 이상을 이미 반영함)면 SKIPPED DUPLICATE이고, 다시 읽지 않으며 커밋 뒤 일·로그가 없다', async (_w, event, status) => {
    fx.order = resultOrder({ status });
    fx.outcome = { status: 'STALE', reason: 'PAYMENT_SEQ', current: 'APPROVED' };
    expect(await run(event)).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(fx.readIds).toHaveLength(1);
    expect(fx.writeCount()).toBe(1);
    noAfterCommit();
    notCalled('log.held');
  });

  test('FR011_STALE NOT_FOUND(그사이 주문이 없어짐)면 보류(PaymentResultHeld IMPOSSIBLE)이고 log.held 한 줄, 커밋 뒤 일이 없다', async () => {
    fx.outcome = { status: 'STALE', reason: 'NOT_FOUND' };
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentResultHeld);
    expect((err as PaymentResultHeld).reason).toBe('IMPOSSIBLE');
    expect(fx.heldLogs).toEqual([heldLine('IMPOSSIBLE')]);
    noAfterCommit();
  });

  test('FR011_승인 쓰기가 SOLD_MISMATCH(판매 행 SOLD 수가 좌석 수와 다름, 되돌림)면 PaymentResultHeld(SOLD_MISMATCH)이고 SEV1 보류 로그 한 줄, 다시 읽지 않으며 커밋 뒤 일이 없다(리뷰 M4)', async () => {
    fx.outcome = { status: 'SOLD_MISMATCH' };
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentResultHeld);
    expect(err).toMatchObject({ reason: 'SOLD_MISMATCH', orderId: ORDER_ID, eventType: 'APPROVED' });
    expect(isTransientError(err)).toBe(false);
    expect(fx.heldLogs).toEqual([heldLine('SOLD_MISMATCH')]);
    expect(fx.readIds).toHaveLength(1);
    expect(fx.writeCount()).toBe(1);
    noAfterCommit();
  });

  test('FR011_STALE STATUS면 주문을 다시 읽어 한 번 더 정한다: RESERVED로 읽고 T9가 STALE(지금 UNKNOWN)이면 다시 읽은 UNKNOWN 주문에 T13으로 반영한다', async () => {
    fx.readQueue = [resultOrder({ status: 'RESERVED' }), resultOrder({ status: 'UNKNOWN' })];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'UNKNOWN' }, { status: 'APPLIED' }];
    expect(await run()).toEqual({ status: 'APPLIED', transition: 'T13', write: 'APPROVE' });
    expect(fx.calls).toEqual(['reads.read', 'writes.approve', 'reads.read', 'writes.approve', 'sessions.complete']);
    expect(fx.approved.map((a) => a.transition)).toEqual(['T9', 'T13']);
    expect(fx.readIds).toEqual([ORDER_ID, ORDER_ID]);
  });

  test('FR011_STALE STATUS 뒤 다시 읽은 주문이 이미 도착 상태면 SKIPPED ALREADY_THERE, 순번을 이미 반영했으면 SKIPPED DUPLICATE다(두 번째 쓰기 없음)', async () => {
    fx.readQueue = [resultOrder(), resultOrder({ status: 'APPROVED' })];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'APPROVED' }];
    expect(await run()).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(fx.writeCount()).toBe(1);
    // 승인된 주문이라 구매 세션 끝내기만 한다(리뷰 L1)
    expect(fx.completed).toEqual([PSID]);
    notCalled('sessions.unmarkPaying', 'saga.kick', 'log.afterCommitFailed');

    fx.reset();
    fx.readQueue = [resultOrder(), resultOrder({ status: 'APPROVED', paymentEventSeq: EVENT_SEQ })];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'APPROVED' }];
    expect(await run()).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(fx.writeCount()).toBe(1);
    expect(fx.completed).toEqual([PSID]);
    notCalled('sessions.unmarkPaying', 'saga.kick', 'log.afterCommitFailed');
  });

  test('FR011_STALE STATUS 뒤 다시 읽은 주문이 닫혔으면(FAILED 주문에 APPROVED) CHARGED_ON_CLOSED_ORDER로 보류한다(리뷰 M2)', async () => {
    fx.readQueue = [resultOrder(), resultOrder({ status: 'FAILED' })];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'FAILED' }];
    await expect(run()).rejects.toBeInstanceOf(PaymentResultHeld);
    expect(fx.heldLogs).toEqual([heldLine('CHARGED_ON_CLOSED_ORDER')]);
    expect(fx.writeCount()).toBe(1);
  });

  test('FR011_다시 정해도 STALE STATUS면 PaymentResultConflict(주문 ID)를 던진다: 읽기·쓰기는 1 + PAYMENT_RESULT_STALE_RETRIES(1)번씩, 커밋 뒤 일 없음, 일시 실패로 읽히지 않는다', async () => {
    expect(PAYMENT_RESULT_STALE_RETRIES).toBe(1);
    fx.outcome = { status: 'STALE', reason: 'STATUS', current: 'RESERVED' };
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PaymentResultConflict);
    expect({ name: (err as PaymentResultConflict).name, orderId: (err as PaymentResultConflict).orderId }).toEqual({ name: 'PaymentResultConflict', orderId: ORDER_ID });
    expect(isTransientError(err)).toBe(false);
    expect(fx.readIds).toHaveLength(1 + PAYMENT_RESULT_STALE_RETRIES);
    expect(fx.writeCount()).toBe(1 + PAYMENT_RESULT_STALE_RETRIES);
    noAfterCommit();
    // 정본 모호: 경합으로 끝날 때 보류 로그(log.held)를 남기는지 정본에 없다. 보류가 아니므로 남기지 않는다고 본다
    notCalled('log.held');
  });

  test('PT2_실패 쓰기의 STALE STATUS도 다시 읽어 정한다: RESERVED → T11이 STALE(지금 UNKNOWN)이면 T15로 반영하고 커밋 뒤 Paying 풀기·Saga 깨우기를 한 번만 한다', async () => {
    fx.readQueue = [resultOrder(), resultOrder({ status: 'UNKNOWN' })];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'UNKNOWN' }, { status: 'APPLIED' }];
    expect(await run(paymentEvent({ type: 'FAILED', failureCategory: 'PG_ERROR' }))).toEqual({ status: 'APPLIED', transition: 'T15', write: 'FAIL' });
    expect(fx.failed.map((f) => f.transition)).toEqual(['T11', 'T15']);
    expect(fx.unmarked).toEqual([PSID]);
    expect(fx.kicked).toEqual([ORDER_ID]);
  });
});

describe('커밋 뒤 일(최선을 다할 뿐, 실패해도 반영은 그대로)', () => {
  test('POL009_승인 뒤 구매 세션 끝내기가 던지면(좌석 Redis 장애) 결과는 APPLIED 그대로이고 log.afterCommitFailed 한 줄(주문·complete_session·오류 이름만)', async () => {
    fx.completeAnswer = new OrderSeatStoreUnavailable(new Error('READONLY'));
    expect(await run()).toEqual({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' });
    expect(fx.afterCommitLogs).toEqual([{ orderId: ORDER_ID, what: 'complete_session', errorName: 'OrderSeatStoreUnavailable' }]);
  });

  test('POL009_입금 대기(T10) 뒤 구매 세션 끝내기가 아무 오류로 던져도 결과는 APPLIED이고 오류 이름만 남긴다', async () => {
    fx.completeAnswer = new RangeError('세션 ID 모양이 틀렸다');
    expect(await run(paymentEvent({ type: 'AWAITING_DEPOSIT' }))).toEqual({ status: 'APPLIED', transition: 'T10', write: 'MARK' });
    expect(fx.afterCommitLogs).toEqual([{ orderId: ORDER_ID, what: 'complete_session', errorName: 'RangeError' }]);
  });

  test('POL009_실패 뒤 Paying 풀기가 던지면 결과는 APPLIED이고 log.afterCommitFailed(unmark_paying) 한 줄, Saga 깨우기는 그대로 한다', async () => {
    fx.unmarkAnswer = new OrderSeatStoreUnavailable();
    expect(await run(paymentEvent({ type: 'FAILED', failureCategory: 'CARD_DECLINED' }))).toEqual({ status: 'APPLIED', transition: 'T11', write: 'FAIL' });
    expect(fx.afterCommitLogs).toEqual([{ orderId: ORDER_ID, what: 'unmark_paying', errorName: 'OrderSeatStoreUnavailable' }]);
    // 정본 모호: Paying 풀기가 던질 때 Saga 깨우기를 하는지 정본에 없다. 좌석 실패 해제(RELEASE)가 늦지 않게 한다고 본다
    expect(fx.kicked).toEqual([ORDER_ID]);
  });

  test('POL009_세션이 이미 없어 false로 답해도(끝냄·Paying 풀기) 결과는 APPLIED이고 로그가 없다', async () => {
    fx.completeAnswer = false;
    expect(await run()).toEqual({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' });
    fx.unmarkAnswer = false;
    expect(await run(paymentEvent({ type: 'FAILED' }))).toEqual({ status: 'APPLIED', transition: 'T11', write: 'FAIL' });
    expect(fx.afterCommitLogs).toEqual([]);
  });

  test('FR011_쓰기가 STALE이면 커밋하지 않았으므로 커밋 뒤 일을 하지 않는다(PAYMENT_SEQ로 건너뜀)', async () => {
    fx.outcome = { status: 'STALE', reason: 'PAYMENT_SEQ' };
    await run(paymentEvent({ type: 'FAILED' }));
    noAfterCommit();
  });
});

describe('DB 오류는 그대로 던진다(처리기가 일시 실패로 보고 파티션을 멈춘다)', () => {
  test('FR011_읽기가 던지면(연결 끊김 57P01) 같은 오류로 던지고 쓰기·로그가 없다. 그 오류는 일시 실패로 읽힌다', async () => {
    const boom = PG_DOWN();
    fx.order = boom;
    await expect(run()).rejects.toBe(boom);
    expect(isTransientError(boom)).toBe(true);
    expect(fx.calls).toEqual(['reads.read']);
  });

  test.each([
    ['approve', paymentEvent()],
    ['fail', paymentEvent({ type: 'FAILED', failureCategory: 'CARD_DECLINED' })],
    ['mark', paymentEvent({ type: 'AWAITING_DEPOSIT' })],
  ] as const)('FR011_%s가 던지면(문장 시간 초과 등) 같은 오류로 던지고 커밋 뒤 일·보류 로그가 없다', async (_w, event) => {
    const boom = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    fx.outcome = boom;
    await expect(run(event)).rejects.toBe(boom);
    noAfterCommit();
    notCalled('log.held');
  });

  test('FR011_STALE STATUS 뒤 다시 읽기가 던져도 그 오류 그대로다', async () => {
    const boom = PG_DOWN();
    fx.readQueue = [resultOrder(), boom];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'UNKNOWN' }];
    await expect(run()).rejects.toBe(boom);
    noAfterCommit();
  });
});

describe('결제 결과 long polling 깨우기(onOrderChanged, PRF-166 리뷰 고침 L3)', () => {
  /** onOrderChanged가 불린 주문과 그때까지의 포트 호출 */
  const watch = () => {
    const seen: { orderId: string; callsBefore: ResultCall[] }[] = [];
    return { seen, onOrderChanged: (orderId: string) => void seen.push({ orderId, callsBefore: [...fx.calls] }) };
  };

  test.each([
    ['RESERVED', 'T11'],
    ['UNKNOWN', 'T15'],
    ['AWAITING_DEPOSIT', 'T17'],
  ] as const)('L3_%s 주문의 FAILED 반영(%s)은 커밋 뒤 일(Saga 깨우기·Paying 풀기)을 마친 뒤 한 번 깨운다', async (status, transition) => {
    fx.order = resultOrder({ status });
    const w = watch();
    expect(await run(paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }), { onOrderChanged: w.onOrderChanged })).toMatchObject({ transition });
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]!.orderId).toBe(ORDER_ID);
    expect(w.seen[0]!.callsBefore).toEqual(fx.calls);
    expect(w.seen[0]!.callsBefore).toEqual(expect.arrayContaining(['writes.fail', 'saga.kick', 'sessions.unmarkPaying']));
  });

  test.each([
    ['AWAITING_DEPOSIT', 'RESERVED', 'WAITING_FOR_DEPOSIT', 'T10'],
    ['AWAITING_DEPOSIT', 'UNKNOWN', 'WAITING_FOR_DEPOSIT', 'T14'],
    ['UNKNOWN', 'RESERVED', 'UNKNOWN', 'T12'],
  ] as const)('L3_%s 사건 × %s 주문(%s → %s, 바로 답할 상태)은 커밋 뒤 일을 마친 뒤 한 번 깨운다', async (type, status, result, transition) => {
    fx.order = resultOrder({ status });
    const w = watch();
    expect(await run(paymentEvent({ type, result }), { onOrderChanged: w.onOrderChanged })).toMatchObject({ transition });
    expect(w.seen.map((s) => s.orderId)).toEqual([ORDER_ID]);
    expect(w.seen[0]!.callsBefore).toEqual(fx.calls);
  });

  test.each([
    ['RESERVED', 'T9'],
    ['UNKNOWN', 'T13'],
    ['AWAITING_DEPOSIT', 'T16'],
  ] as const)('L3_%s 주문의 승인 반영(%s → APPROVED, 기다리는 상태)은 깨우지 않는다', async (status, transition) => {
    fx.order = resultOrder({ status });
    const w = watch();
    expect(await run(paymentEvent(), { onOrderChanged: w.onOrderChanged })).toMatchObject({ transition });
    expect(w.seen).toEqual([]);
  });

  test('L3_반영하지 않은 사건(다시 온 사건·이미 도착 상태)은 깨우지 않는다', async () => {
    const w = watch();
    expect(await run(paymentEvent({ eventSeq: ORDER_PAYMENT_SEQ }), { onOrderChanged: w.onOrderChanged })).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    fx.order = resultOrder({ status: 'UNKNOWN' });
    expect(await run(paymentEvent({ type: 'UNKNOWN' }), { onOrderChanged: w.onOrderChanged })).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(w.seen).toEqual([]);
  });

  test('L3_onOrderChanged가 던져도 반영 결과는 그대로다', async () => {
    const r = await run(paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }), {
      onOrderChanged: () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ status: 'APPLIED', transition: 'T11', write: 'FAIL' });
  });
});

describe('발권 실행기 깨우기(onApproved, BUILD_ORDER PRF-170)', () => {
  /** onApproved가 불린 주문과 그때까지의 포트 호출 */
  const watch = () => {
    const seen: { orderId: string; callsBefore: ResultCall[] }[] = [];
    return { seen, onApproved: (orderId: string) => void seen.push({ orderId, callsBefore: [...fx.calls] }) };
  };
  /** 결과를 기다리고 던진 것은 삼킨다(보류·경합·DB 오류에도 onApproved를 부르지 않았는지 보려고) */
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );

  test.each([
    ['RESERVED', 'T9'],
    ['UNKNOWN', 'T13'],
    ['AWAITING_DEPOSIT', 'T16'],
  ] as const)('%s 주문의 승인 반영(%s, 큐 행을 넣는 커밋)은 커밋 뒤 일(구매 세션 끝내기)을 마친 뒤 onApproved(주문 ID)를 한 번 부른다(1초 틱을 기다리지 않고 발권, P-T39 ①, ADR0106)', async (status, transition) => {
    fx.order = resultOrder({ status });
    const w = watch();
    expect(await run(paymentEvent(), { onApproved: w.onApproved })).toEqual({ status: 'APPLIED', transition, write: 'APPROVE' });
    expect(w.seen.map((s) => s.orderId)).toEqual([ORDER_ID]);
    expect(w.seen[0]!.callsBefore).toEqual(['reads.read', 'writes.approve', 'sessions.complete']);
    expect(w.seen[0]!.callsBefore).toEqual(fx.calls);
  });

  test('STALE STATUS 뒤 다시 정해 T13으로 반영해도 onApproved는 커밋한 한 번만이다 (ADR0106)', async () => {
    fx.readQueue = [resultOrder({ status: 'RESERVED' }), resultOrder({ status: 'UNKNOWN' })];
    fx.outcomeQueue = [{ status: 'STALE', reason: 'STATUS', current: 'UNKNOWN' }, { status: 'APPLIED' }];
    const w = watch();
    expect(await run(paymentEvent(), { onApproved: w.onApproved })).toEqual({ status: 'APPLIED', transition: 'T13', write: 'APPROVE' });
    expect(w.seen.map((s) => s.orderId)).toEqual([ORDER_ID]);
  });

  test('구매 세션 끝내기가 던져도(좌석 Redis 장애) 승인은 커밋했으므로 onApproved를 부른다 (ADR0106) [ASVS v5.0.0-16.5.2]', async () => {
    fx.completeAnswer = new OrderSeatStoreUnavailable();
    const w = watch();
    expect(await run(paymentEvent(), { onApproved: w.onApproved })).toEqual({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' });
    expect(w.seen.map((s) => s.orderId)).toEqual([ORDER_ID]);
    expect(fx.afterCommitLogs).toHaveLength(1);
  });

  test('onApproved가 던져도 반영 결과는 그대로다', async () => {
    const r = await run(paymentEvent(), {
      onApproved: () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ status: 'APPLIED', transition: 'T9', write: 'APPROVE' });
  });

  test('승인이 아닌 반영(실패 T11·T15·T17, 입금 대기 T10·T14, UNKNOWN T12)은 onApproved를 부르지 않는다', async () => {
    const w = watch();
    const cases: [PaymentResultOrder, PaymentResultEvent][] = [
      [resultOrder({ status: 'RESERVED' }), paymentEvent({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' })],
      [resultOrder({ status: 'UNKNOWN' }), paymentEvent({ type: 'FAILED', failureCategory: 'PG_ERROR' })],
      [resultOrder({ status: 'AWAITING_DEPOSIT' }), paymentEvent({ type: 'FAILED', failureCategory: 'EXPIRED' })],
      [resultOrder({ status: 'RESERVED' }), paymentEvent({ type: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' })],
      [resultOrder({ status: 'UNKNOWN' }), paymentEvent({ type: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' })],
      [resultOrder({ status: 'RESERVED' }), paymentEvent({ type: 'UNKNOWN', result: 'UNKNOWN' })],
    ];
    for (const [order, event] of cases) {
      fx.reset();
      fx.order = order;
      expect(await run(event, { onApproved: w.onApproved }), `${order.status} × ${event.type}`).toMatchObject({ status: 'APPLIED' });
    }
    expect(w.seen).toEqual([]);
  });

  test('건너뛴 사건(다시 온 사건·이미 APPROVED·RESOLVED)은 승인된 주문이어도 onApproved를 부르지 않는다(큐 행을 넣은 커밋이 아니다)', async () => {
    const w = watch();
    fx.order = resultOrder({ status: 'APPROVED', paymentEventSeq: EVENT_SEQ });
    expect(await run(paymentEvent(), { onApproved: w.onApproved })).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    fx.order = resultOrder({ status: 'APPROVED' });
    expect(await run(paymentEvent(), { onApproved: w.onApproved })).toEqual({ status: 'SKIPPED', reason: 'ALREADY_THERE' });
    expect(await run(paymentEvent({ type: 'RESOLVED', result: 'APPROVED' }), { onApproved: w.onApproved })).toEqual({ status: 'SKIPPED', reason: 'RECORD_ONLY' });
    fx.order = resultOrder();
    fx.outcome = { status: 'STALE', reason: 'PAYMENT_SEQ' };
    expect(await run(paymentEvent(), { onApproved: w.onApproved })).toEqual({ status: 'SKIPPED', reason: 'DUPLICATE' });
    expect(w.seen).toEqual([]);
  });

  test('보류(PaymentResultHeld)·판매 행 어긋남(SOLD_MISMATCH)·경합(PaymentResultConflict)·DB 오류로 커밋하지 않았으면 onApproved를 부르지 않는다', async () => {
    const w = watch();
    fx.order = resultOrder({ status: 'FAILED' });
    expect(await settle(run(paymentEvent(), { onApproved: w.onApproved }))).toBeInstanceOf(PaymentResultHeld);
    fx.reset();
    fx.outcome = { status: 'SOLD_MISMATCH' };
    expect(await settle(run(paymentEvent(), { onApproved: w.onApproved }))).toBeInstanceOf(PaymentResultHeld);
    fx.reset();
    fx.outcome = { status: 'STALE', reason: 'STATUS', current: 'RESERVED' };
    expect(await settle(run(paymentEvent(), { onApproved: w.onApproved }))).toBeInstanceOf(PaymentResultConflict);
    fx.reset();
    const boom = PG_DOWN();
    fx.outcome = boom;
    expect(await settle(run(paymentEvent(), { onApproved: w.onApproved }))).toBe(boom);
    expect(w.seen).toEqual([]);
  });
});

describe('InventoryPaymentResultSessions(커밋 뒤 구매 세션 일의 inventory 다리)', () => {
  const sourceOf = (o: { end?: () => Promise<boolean>; setPaying?: () => Promise<boolean> } = {}) => {
    const ends: unknown[] = [];
    const payings: unknown[][] = [];
    const source: PaymentSessionSource = {
      end: {
        execute: async (c) => {
          ends.push(c);
          return o.end ? o.end() : true;
        },
      },
      store: {
        setPaying: async (...args) => {
          payings.push(args);
          return o.setPaying ? o.setPaying() : true;
        },
      },
    };
    return { source, ends, payings };
  };

  test('POL009_complete는 end.execute({ sessionId, reason: COMPLETED })를 그대로 부르고 그 답을 돌려준다(회차 확인 칸은 넘기지 않는다)', async () => {
    const { source, ends, payings } = sourceOf({ end: async () => false });
    const s = new InventoryPaymentResultSessions(source);
    expect(await s.complete(PSID)).toBe(false);
    expect(ends).toEqual([{ sessionId: PSID, reason: 'COMPLETED' }]);
    expect(payings).toEqual([]);
  });

  test('POL009_unmarkPaying은 store.setPaying(jti, false)를 부르고 그 답을 돌려준다', async () => {
    const { source, ends, payings } = sourceOf();
    const s = new InventoryPaymentResultSessions(source);
    expect(await s.unmarkPaying(PSID)).toBe(true);
    expect(payings).toEqual([[PSID, false]]);
    expect(ends).toEqual([]);
  });

  test('FR011_inventory의 좌석 Redis 장애(이름 SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 바꿔 던지고(원인은 cause), 그 밖은 그대로 던진다', async () => {
    const down = Object.assign(new Error('좌석 Redis 장애'), { name: 'SeatStoreUnavailable' });
    const { source } = sourceOf({
      end: async () => {
        throw down;
      },
      setPaying: async () => {
        throw down;
      },
    });
    const s = new InventoryPaymentResultSessions(source);
    for (const call of [() => s.complete(PSID), () => s.unmarkPaying(PSID)]) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OrderSeatStoreUnavailable);
      expect((err as Error).cause).toBe(down);
    }
    const bad = new RangeError('jti 모양이 틀렸다');
    const s2 = new InventoryPaymentResultSessions(
      sourceOf({
        end: async () => {
          throw bad;
        },
        setPaying: async () => {
          throw bad;
        },
      }).source,
    );
    await expect(s2.complete(PSID)).rejects.toBe(bad);
    await expect(s2.unmarkPaying(PSID)).rejects.toBe(bad);
  });
});

describe('계측(BAT-029)', () => {
  test('execute는 읽기·쓰기·커밋 뒤 일·전체 구간과 applied 결과를 남긴다', async () => {
    const stages: string[] = [];
    const outcomes: string[] = [];
    const hotPath = {
      start: (stage: string) => {
        stages.push(stage);
        return () => undefined;
      },
      outcome: (outcome: string) => void outcomes.push(outcome),
    } as unknown as HotPathMetrics;
    await run(paymentEvent(), { hotPath });
    expect(stages).toEqual(['payment.result.total', 'payment.result.read', 'payment.result.write', 'payment.result.after_commit']);
    expect(outcomes).toEqual(['applied']);
  });

  test('보류로 끝난 execute는 held 결과를 남긴다', async () => {
    const outcomes: string[] = [];
    const hotPath = { start: () => () => undefined, outcome: (outcome: string) => void outcomes.push(outcome) } as unknown as HotPathMetrics;
    fx.outcome = { status: 'SOLD_MISMATCH' };
    await expect(run(paymentEvent(), { hotPath })).rejects.toBeInstanceOf(PaymentResultHeld);
    expect(outcomes).toEqual(['held']);
  });
});
