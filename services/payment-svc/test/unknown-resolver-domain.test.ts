// UNKNOWN 해소의 순수 규칙(domain/unknown-resolver.ts, docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현', BUILD_ORDER PRF-182, 명세 specs/payment.qnt `query`).
// 조회 답 → 할 일의 표(모든 상태·금액), 조회 간격과 잡을 때 미는 시간, RESOLVED 사건을 DB 없이 본다.
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test, vi } from 'vitest';
import { buildPaymentEvent, type PaymentEventMessage, paymentEventKey } from '../src/modules/payment/domain/confirm-runner.js';
import type { QueryResult, QueryStatus } from '../src/modules/payment/domain/payment-gateway.js';
import {
  buildResolvedEvent,
  decideQueryAnswer,
  PAYMENT_UNKNOWN_QUERY_OUTCOMES,
  RESOLVED_EVENT_TYPE,
  UNKNOWN_OVERDUE_BATCH,
  UNKNOWN_OVERDUE_MS,
  UNKNOWN_OVERDUE_SWEEP_INTERVAL_MS,
  UNKNOWN_QUERY_BASE_MS,
  UNKNOWN_QUERY_BATCH,
  UNKNOWN_QUERY_CLAIM_HOLD_MS,
  UNKNOWN_QUERY_CONCURRENCY,
  UNKNOWN_QUERY_FACTOR,
  UNKNOWN_QUERY_GUARD_MS,
  UNKNOWN_QUERY_MAX_MS,
  UNKNOWN_QUERY_POLL_INTERVAL_MS,
  UNKNOWN_QUERY_TIMEOUT_MS,
  unknownQueryClaimHoldMs,
  unknownQueryDelayMs,
} from '../src/modules/payment/domain/unknown-resolver.js';
import { EVENT_ID, NOW, ORDER_ID, PAYMENT_ID, SECRET_PAYMENT_KEY } from './confirm-cases.js';

const AMOUNT = 55_000;
const APPROVED_AT = '2026-11-09T03:00:05.000Z';
const APPROVED_AT_MS = Date.parse(APPROVED_AT);
const LEDGER = { orderId: ORDER_ID, amount: AMOUNT };

const found = (status: QueryStatus, over: Partial<Extract<QueryResult, { kind: 'FOUND' }>> = {}): QueryResult => ({
  kind: 'FOUND',
  paymentRef: SECRET_PAYMENT_KEY,
  orderRef: ORDER_ID,
  status,
  amount: AMOUNT,
  balanceAmount: AMOUNT,
  ...over,
});
const decide = (answer: QueryResult, nowMs = NOW) => decideQueryAnswer(answer, LEDGER, nowMs);

describe('상수', () => {
  test('PRF182_가정 값이 정본과 같다(주기 1초·동시 16·묶음 50·5초에서 두 배 최대 60초·1시간)', () => {
    expect([UNKNOWN_QUERY_POLL_INTERVAL_MS, UNKNOWN_QUERY_CONCURRENCY, UNKNOWN_QUERY_BATCH]).toEqual([1_000, 16, 50]);
    expect([UNKNOWN_QUERY_BASE_MS, UNKNOWN_QUERY_FACTOR, UNKNOWN_QUERY_MAX_MS]).toEqual([5_000, 2, 60_000]);
    expect(UNKNOWN_OVERDUE_MS).toBe(3_600_000);
    expect(PAYMENT_UNKNOWN_QUERY_OUTCOMES).toEqual(['approved', 'failed', 'waiting', 'still_processing', 'not_found', 'amount_mismatch', 'cancelled_at_pg', 'query_failed', 'no_adapter', 'deposit_approved', 'deposit_expired', 'deposit_waiting', 'late_deposit', 'deposit_reversed', 'reversal_waiting', 'reversal_unconfirmed', 'reversal_no_time']);
    expect(RESOLVED_EVENT_TYPE).toBe('RESOLVED');
  });
});

describe('decideQueryAnswer', () => {
  test('P-T3_APPROVED 답은 금액이 원장과 같으면 APPROVED이고 승인 시각은 결제사 값이다 [ASVS v5.0.0-2.2.3]', () => {
    expect(decide(found('APPROVED', { approvedAt: APPROVED_AT }))).toEqual({ kind: 'RESOLVE', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS }, outcome: 'approved' });
  });

  test.each([undefined, '날짜가 아니다'])('P-T3_승인 시각이 없거나 읽지 못하면(%s) 지금이다', (approvedAt) => {
    expect(decide(found('APPROVED', approvedAt === undefined ? {} : { approvedAt }))).toMatchObject({ finish: { approvedAtMs: NOW } });
  });

  test('P-T3_APPROVED 답의 금액이 원장과 다르면 UNKNOWN 그대로 다시 묻고 금액 어긋남을 표시한다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', () => {
    expect(decide(found('APPROVED', { amount: AMOUNT + 1, approvedAt: APPROVED_AT }))).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' });
  });

  test.each(['APPROVED', 'FAILED', 'EXPIRED', 'WAITING_FOR_DEPOSIT', 'READY'] as const)('P-T3_답의 주문 ID가 원장과 다르면 %s여도 결과를 쓰지 않고 주문 어긋남을 표시한다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', (status) => {
    expect(decide(found(status, { orderRef: 'other-order' }))).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'order' });
  });

  test('P-T3_FAILED 답은 FAILED(PG_ERROR)다', () => {
    expect(decide(found('FAILED'))).toEqual({ kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'PG_ERROR' }, outcome: 'failed' });
  });

  test('P-T3_EXPIRED 답은 FAILED(EXPIRED)다', () => {
    expect(decide(found('EXPIRED'))).toEqual({ kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'EXPIRED' }, outcome: 'failed' });
  });

  test('P-T3_FAILED·EXPIRED 답은 금액을 보지 않는다(승인되지 않은 결제다)', () => {
    expect(decide(found('FAILED', { amount: 1 })).kind).toBe('RESOLVE');
    expect(decide(found('EXPIRED', { amount: 1 })).kind).toBe('RESOLVE');
  });

  test('P-T3_WAITING_FOR_DEPOSIT 답은 AWAITING_DEPOSIT이다', () => {
    expect(decide(found('WAITING_FOR_DEPOSIT'))).toEqual({ kind: 'RESOLVE', finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' }, outcome: 'waiting' });
  });

  test.each(['READY', 'IN_PROGRESS'] as const)('P-T3_%s 답은 결제사가 아직 정하지 않았으므로 그대로 두고 다시 묻는다 [ASVS v5.0.0-16.5.3]', (status) => {
    expect(decide(found(status))).toEqual({ kind: 'ASK_AGAIN', outcome: 'still_processing' });
  });

  test('P-T3_조회 실패(UNKNOWN)와 형 밖의 답은 결과를 가정하지 않고 다시 묻는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', () => {
    expect(decide({ kind: 'UNKNOWN' })).toEqual({ kind: 'ASK_AGAIN', outcome: 'query_failed' });
    expect(decide({ kind: 'OTHER' } as unknown as QueryResult)).toEqual({ kind: 'ASK_AGAIN', outcome: 'query_failed' });
    expect(decide(found('NEW_STATUS' as unknown as QueryStatus))).toEqual({ kind: 'ASK_AGAIN', outcome: 'query_failed' });
  });
});

describe('리뷰 고침(BUILD_ORDER PRF-182, 코드 리뷰)', () => {
  const LONG_AFTER = NOW + 30 * 24 * 3_600_000;

  test('P-T3_리뷰 고침 H2: 기록 없음은 승인 기한이 아무리 지나도 결과가 아니라 다시 묻는다(명세 query에 그 갈래가 없다) [ASVS v5.0.0-16.5.3]', () => {
    expect(decide({ kind: 'NOT_FOUND' }, LONG_AFTER)).toEqual({ kind: 'ASK_AGAIN', outcome: 'not_found' });
  });

  test.each([
    ['CANCELED', AMOUNT],
    ['PARTIAL_CANCELED', AMOUNT],
    ['CANCELED', AMOUNT + 1],
  ] as const)('P-T3_리뷰 고침 H3: %s(금액 %i)는 승인으로 쓰지 않고 UNKNOWN 그대로 사람이 보게 표시한다 [ASVS v5.0.0-16.5.3]', (status, amount) => {
    expect(decide(found(status, { amount, approvedAt: APPROVED_AT }))).toEqual({ kind: 'ASK_AGAIN', outcome: 'cancelled_at_pg', anomaly: 'cancelled' });
  });

  test('P-T3_리뷰 고침 H3: 주문 ID가 다르면 취소 상태보다 주문 어긋남이 먼저다 [ASVS v5.0.0-2.2.3]', () => {
    expect(decide(found('CANCELED', { orderRef: 'other-order' }))).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'order' });
  });

  test('P-T3_리뷰 고침 L9: 입금 대기 답도 금액이 다르면 쓰지 않고 금액 어긋남이다 [ASVS v5.0.0-2.2.3]', () => {
    expect(decide(found('WAITING_FOR_DEPOSIT', { amount: AMOUNT + 1 }))).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' });
  });

  test.each([
    ['APPROVED', 'CARD'],
    ['FAILED', 'EASY_PAY'],
    ['EXPIRED', 'TRANSFER'],
    ['WAITING_FOR_DEPOSIT', 'OTHER'],
  ] as const)('P-T3_리뷰 고침 L10: %s 답의 결제 수단 분류(%s)를 해소 사건에 싣는다', (status, method) => {
    expect(decide(found(status, { method }))).toMatchObject({ kind: 'RESOLVE', finish: { payMethodCategory: method } });
  });

  test('P-T3_리뷰 고침 L10: 답에 분류가 없으면 칸을 비운다', () => {
    expect(decide(found('APPROVED'))).not.toHaveProperty('finish.payMethodCategory');
  });

  test.each([
    [1, 15_000],
    [2, 15_000],
    [3, 20_000],
    [4, 40_000],
    [5, 60_000],
  ])('P-T3_리뷰 고침 M6: %i번째 잡기는 최소 15초 [가정]를 민다(%ims, 조회가 도는 동안 다시 잡히지 않게)', (attempts, ms) => {
    expect(unknownQueryClaimHoldMs(attempts)).toBe(ms);
  });

  test('P-T50_승인 답에 연결값을 함께 싣는다', () => {
    expect(decideQueryAnswer(found('APPROVED'), LEDGER, NOW, () => ({ kind: 'LINKED', paymentMethodRef: 'k1.abc', cardBin: '433012' }))).toMatchObject({ kind: 'RESOLVE', finish: { status: 'APPROVED', paymentMethodRef: 'k1.abc', cardBin: '433012' } });
  });

  test('P-T50_계산하지 못한 승인은 refMissing 참이고 두 칸이 없다', () => {
    expect(decideQueryAnswer(found('APPROVED'), LEDGER, NOW, () => ({ kind: 'MISSING', reason: 'CARD_SHAPE' }))).toEqual({ kind: 'RESOLVE', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: NOW, refMissing: true }, outcome: 'approved' });
  });

  test('P-T50_리뷰 고침 L4: 승인이 아닌 답과 금액이 어긋난 답은 연결값을 계산하지 않는다', () => {
    const linkOf = vi.fn(() => ({ kind: 'LINKED', paymentMethodRef: 'k1.abc', cardBin: '433012' }) as const);
    expect(decideQueryAnswer(found('FAILED'), LEDGER, NOW, linkOf)).toEqual({ kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'PG_ERROR' }, outcome: 'failed' });
    expect(decideQueryAnswer(found('APPROVED', { amount: AMOUNT + 1 }), LEDGER, NOW, linkOf)).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' });
    expect(linkOf).not.toHaveBeenCalled();
  });

  test('P-T3_리뷰 고침 M6: 시간 한도의 차례는 어댑터 10초 < 실행기 < 잡을 때 민 최소 15초다 [가정]', () => {
    expect(UNKNOWN_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(UNKNOWN_QUERY_GUARD_MS).toBeGreaterThan(UNKNOWN_QUERY_TIMEOUT_MS);
    expect(UNKNOWN_QUERY_CLAIM_HOLD_MS).toBe(15_000);
    expect(UNKNOWN_QUERY_CLAIM_HOLD_MS).toBeGreaterThan(UNKNOWN_QUERY_GUARD_MS);
  });

  test('P-T3_리뷰 고침 M7: 1시간 표시는 1분에 한 번, 100건까지다 [가정]', () => {
    expect(UNKNOWN_OVERDUE_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(UNKNOWN_OVERDUE_BATCH).toBe(100);
  });
});

describe('unknownQueryDelayMs', () => {
  test.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 60_000],
    [6, 60_000],
    [1_000_000, 60_000],
  ])('P-T3_%i번째 조회 뒤 간격은 %ims다', (attempts, ms) => {
    expect(unknownQueryDelayMs(attempts)).toBe(ms);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_VALUE])('PRF182_횟수가 %s이면 RangeError다', (attempts) => {
    expect(() => unknownQueryDelayMs(attempts)).toThrow(RangeError);
  });
});

describe('buildResolvedEvent', () => {
  const target = { paymentId: PAYMENT_ID, orderId: ORDER_ID, eventId: EVENT_ID, attemptNo: 1, pg: 'SIMULATOR' as const, amount: AMOUNT };
  const approved: PaymentEventMessage = buildPaymentEvent({ target, finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS }, seq: 4, nowMs: NOW });

  test('P-T3_승인 해소 기록은 type RESOLVED, result APPROVED이고 순번·키가 자기 것이며 계약 zod를 지난다', () => {
    const e = buildResolvedEvent(PAYMENT_ID, approved, 5, NOW);
    expect(e).toMatchObject({ type: 'RESOLVED', result: 'APPROVED', eventSeq: 5, eventKey: paymentEventKey(PAYMENT_ID, 5), eventId: EVENT_ID, orderId: ORDER_ID, amount: AMOUNT, occurredAt: new Date(NOW).toISOString() });
    expect(PaymentEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });

  test('P-T50_승인 해소 기록에 결과 사건과 같은 연결값 두 칸을 싣는다', () => {
    const linked = buildPaymentEvent({ target, finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, paymentMethodRef: 'k1.abc', cardBin: '433012' }, seq: 4, nowMs: NOW });
    const e = buildResolvedEvent(PAYMENT_ID, linked, 5, NOW);
    expect(e).toMatchObject({ type: 'RESOLVED', paymentMethodRef: 'k1.abc', cardBin: '433012', refMissing: false });
    expect(PaymentEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
    const keys = Object.keys(e);
    expect(keys).toEqual(Object.keys(PaymentEvent.shape).filter((k) => keys.includes(k)));
  });

  test('P-T50_계산하지 못한 승인의 해소 기록은 refMissing이 그대로다', () => {
    const missing = buildPaymentEvent({ target, finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, refMissing: true }, seq: 4, nowMs: NOW });
    const e = buildResolvedEvent(PAYMENT_ID, missing, 5, NOW);
    expect(e.refMissing).toBe(true);
    expect(e).not.toHaveProperty('paymentMethodRef');
    expect(e).not.toHaveProperty('cardBin');
  });

  test('P-T3_실패 해소 기록은 실패 범주를 싣지 않는다(FAILED 사건에만 싣는 칸이다) [ASVS v5.0.0-16.2.5]', () => {
    const failed = buildPaymentEvent({ target, finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'PG_ERROR' }, seq: 4, nowMs: NOW });
    const e = buildResolvedEvent(PAYMENT_ID, failed, 5, NOW);
    expect(e.result).toBe('DECLINED');
    expect(e).not.toHaveProperty('failureCategory');
    expect(PaymentEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });

  test('P-T3_입금 대기 해소 기록의 result는 WAITING_FOR_DEPOSIT이다', () => {
    const waiting = buildPaymentEvent({ target, finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' }, seq: 4, nowMs: NOW });
    expect(buildResolvedEvent(PAYMENT_ID, waiting, 5, NOW).result).toBe('WAITING_FOR_DEPOSIT');
  });

  test('PRF182_순번이 틀리면 RangeError다', () => {
    expect(() => buildResolvedEvent(PAYMENT_ID, approved, 0, NOW)).toThrow(RangeError);
  });
});
