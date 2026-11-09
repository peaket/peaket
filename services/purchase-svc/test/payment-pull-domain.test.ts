// 결제 결과 당기기의 순수 규칙(booking domain/payment-pull.ts, docs/features/payment.md §2 '결제 결과 당기기의 첫 구현', ADR-0140 결정 1~4,
// docs/api/proto/peaket/payment/v1/payment.proto OrderPaymentState·PaymentStatus, BUILD_ORDER PRF-171 설계 5·7).
// - paymentStateToResultEvent: 답(OrderPaymentState) 하나 → APPLY(사건과 같은 PaymentResultEvent)·WAIT(승인 중)·IGNORE(취소 상태·모양 틀림)
// - isPaymentResultMissingLong: 승인 명령을 보낸 지 10분 [가정](경계는 넘긴 것)
// - 상수: 1초 반복·보낸 뒤 5초·같은 주문 5초·100건·동시 4개·500ms·60초 미루기·기록 없음 10분·기록 없음 로그 창 10분·전용 풀 2개
// 상수 값은 함수 시험 안에서 함께 본다(함수가 아직 없으면 같이 실패하게, saga-domain.test.ts와 같은 꼴).
// 만든 사건이 사건 길과 같은 반영 결정(decidePaymentResult)을 지나는지도 본다: 같은 순번이면 건너뛴다(P-T15).
import { paymentV1Payment } from '@peaket/contracts/proto';
import { describe, expect, test } from 'vitest';
import {
  decidePaymentResult,
  isPaymentResultMissingLong,
  type OrderPaymentState,
  PAYMENT_FAILURE_CATEGORIES,
  PAYMENT_LEDGER_STATUSES,
  PAYMENT_PULL_AFTER_SENT_MS,
  PAYMENT_PULL_BATCH,
  PAYMENT_PULL_CONCURRENCY,
  PAYMENT_PULL_DB_MAX,
  PAYMENT_PULL_DEADLINE_MS,
  PAYMENT_PULL_HELD_TOPIC,
  PAYMENT_PULL_INTERVAL_MS,
  PAYMENT_PULL_LONG_REPEAT_MS,
  PAYMENT_PULL_MISSING_AFTER_MS,
  PAYMENT_PULL_MISSING_LOG_WINDOW_MS,
  PAYMENT_PULL_OUTAGE_CODES,
  PAYMENT_PULL_OUTAGE_REPEAT_MS,
  PAYMENT_PULL_REPEAT_MS,
  PAYMENT_PULL_SLOW_REPEAT_MS,
  PAYMENT_PULL_TYPES,
  type PaymentPullContext,
  type PaymentResultEvent,
  paymentStateToResultEvent,
  ticketIssueDueAtMs,
  TICKET_ISSUE_WINDOW_MS,
  TRADE_PAYMENTS_TOPIC,
} from '../src/modules/booking/index.js';
import { EVENT_KEY, EVENT_SEQ, OCCURRED_AT, OCCURRED_AT_MS, ORDER_ID, ORDER_PAYMENT_SEQ, resultOrder } from './payment-result-cases.js';
import { AMOUNT, EVENT, NOW } from './order-cases.js';

const MIN = 60_000;
/** 당긴 시각(앱 시계, 승인보다 15초 뒤: 사건 길이 늦은 흉내) */
const PULLED_AT_MS = OCCURRED_AT_MS + 15_000;
const PULLED_AT = new Date(PULLED_AT_MS).toISOString();
/** 결제 원장 ID(반영에는 쓰지 않는다) */
const PAYMENT_ID = '0190f3a1-7c2e-7f00-8000-0000000000a9';

/** 답 하나(토스 승인, 주문 금액과 같다, 순번 3) */
function state(over: Partial<OrderPaymentState> = {}): OrderPaymentState {
  return { orderId: ORDER_ID, paymentId: PAYMENT_ID, pg: 'TOSS', status: 'APPROVED', amount: AMOUNT, approvedAtMs: OCCURRED_AT_MS, eventKey: EVENT_KEY, eventSeq: EVENT_SEQ, ...over };
}
/** 답 밖에서 채우는 값(작업 행의 회차, 그 주문 ACCEPTED 결제 시도 순번 1, 승인 명령을 보낸 시각(승인 2초 전), 당긴 시각) */
const ctx = (over: Partial<PaymentPullContext> = {}): PaymentPullContext => ({ eventId: EVENT, attemptNo: 1, confirmSentAtMs: OCCURRED_AT_MS - 2_000, pulledAtMs: PULLED_AT_MS, ...over });

/** APPLY의 사건(아니면 실패) */
function eventOf(s: OrderPaymentState, c: PaymentPullContext = ctx()): PaymentResultEvent {
  const d = paymentStateToResultEvent(s, c);
  expect(d.kind, JSON.stringify(d)).toBe('APPLY');
  return (d as Extract<typeof d, { kind: 'APPLY' }>).event;
}

/** 사건이 싣는 칸(payMethodCategory·result·latencyMs는 싣지 않는다, 설계 5) */
const BASE_KEYS = ['amount', 'attemptNo', 'eventId', 'eventKey', 'eventSeq', 'occurredAt', 'orderId', 'pg', 'refMissing', 'type'];

describe('paymentStateToResultEvent: 결과로 반영하는 상태(설계 5)', () => {
  test('APPROVED → APPLY type APPROVED: 발생 시각은 approved_at, eventKey·eventSeq·금액·결제사는 답의 값, eventId는 작업 행의 회차, attemptNo는 ACCEPTED 결제 시도 순번, refMissing 거짓 (P-T47, ADR0140) [ASVS v5.0.0-2.3.3]', () => {
    expect(paymentStateToResultEvent(state(), ctx())).toEqual({
      kind: 'APPLY',
      event: {
        eventId: EVENT,
        orderId: ORDER_ID,
        pg: 'TOSS',
        type: 'APPROVED',
        amount: AMOUNT,
        refMissing: false,
        attemptNo: 1,
        occurredAt: OCCURRED_AT,
        eventSeq: EVENT_SEQ,
        eventKey: EVENT_KEY,
      },
    });
    // 사건 길에만 있는 칸(결제 수단 범주·승인 결과 이름·지연)과 실패 범주는 싣지 않는다
    expect(Object.keys(eventOf(state())).sort()).toEqual(BASE_KEYS);
  });

  test('APPROVED의 발생 시각이 approved_at이라 발권 기한(승인 + 30분)이 당긴 시각이 아니라 실제 승인에 묶인다 (P-T47, ADR0140)', () => {
    const e = eventOf(state());
    expect(ticketIssueDueAtMs(e.occurredAt)).toBe(OCCURRED_AT_MS + TICKET_ISSUE_WINDOW_MS);
    expect(ticketIssueDueAtMs(e.occurredAt)).not.toBe(PULLED_AT_MS + TICKET_ISSUE_WINDOW_MS);
  });

  test('APPROVED인데 approved_at이 없으면 발생 시각은 당긴 시각이다(버리면 사건 길이 멈춘 동안 승인이 확정되지 않는다, 뼈대 주석 [정함]) (ADR0140)', () => {
    expect(eventOf(state({ approvedAtMs: undefined })).occurredAt).toBe(PULLED_AT);
  });

  test('리뷰 고침 L2_approved_at이 그 주문의 승인 명령을 보낸 시각보다 1분 [정함]을 넘게 이르면(있을 수 없는 값) 발생 시각은 당긴 시각이다. 1분 안의 어긋남(파드 사이 시계)은 approved_at 그대로다 (ADR0140) [ASVS v5.0.0-2.3.3]', () => {
    // 보내기 10분 전에 승인됐다는 답: 발권 기한(승인 + 30분)을 이미 지난 것으로 잡지 않는다
    expect(eventOf(state(), ctx({ confirmSentAtMs: OCCURRED_AT_MS + 10 * MIN })).occurredAt).toBe(PULLED_AT);
    expect(eventOf(state(), ctx({ confirmSentAtMs: OCCURRED_AT_MS + MIN + 1 })).occurredAt).toBe(PULLED_AT);
    // 경계: 정확히 1분 이르면 그대로다
    expect(eventOf(state(), ctx({ confirmSentAtMs: OCCURRED_AT_MS + MIN })).occurredAt).toBe(OCCURRED_AT);
    expect(eventOf(state(), ctx({ confirmSentAtMs: OCCURRED_AT_MS + 30_000 })).occurredAt).toBe(OCCURRED_AT);
    // 승인 아닌 답은 원래 당긴 시각이다
    expect(eventOf(state({ status: 'UNKNOWN' }), ctx({ confirmSentAtMs: OCCURRED_AT_MS + 10 * MIN })).occurredAt).toBe(PULLED_AT);
  });

  test.each([...PAYMENT_FAILURE_CATEGORIES])('FAILED(%s) → APPLY type FAILED, failureCategory 그대로, 발생 시각은 당긴 시각이다(approved_at이 있어도) (ADR0140) [ASVS v5.0.0-2.3.3]', (failureCategory) => {
    const e = eventOf(state({ status: 'FAILED', failureCategory }));
    expect(e).toMatchObject({ type: 'FAILED', failureCategory, occurredAt: PULLED_AT, eventSeq: EVENT_SEQ, eventKey: EVENT_KEY, amount: AMOUNT, pg: 'TOSS' });
    expect(Object.keys(e).sort()).toEqual([...BASE_KEYS, 'failureCategory'].sort());
  });

  test('FAILED인데 실패 범주가 없으면 failureCategory 칸을 싣지 않는다(반영이 PAYMENT_FAILURE_FALLBACK을 적는다)', () => {
    const e = eventOf(state({ status: 'FAILED', failureCategory: undefined, approvedAtMs: undefined }));
    expect(e.type).toBe('FAILED');
    expect(e).not.toHaveProperty('failureCategory');
    expect(Object.keys(e).sort()).toEqual(BASE_KEYS);
  });

  test.each(['AWAITING_DEPOSIT', 'UNKNOWN'] as const)('%s → APPLY 같은 이름의 type, 발생 시각은 당긴 시각이다(결제사 단독 조회 규칙은 payment-svc 몫, 주문은 지금 전이 함수대로) (ADR0140)', (status) => {
    const e = eventOf(state({ status, approvedAtMs: undefined }));
    expect(e).toMatchObject({ type: status, occurredAt: PULLED_AT, eventId: EVENT, attemptNo: 1, refMissing: false });
    expect(Object.keys(e).sort()).toEqual(BASE_KEYS);
  });

  test('결제사·금액·순번·eventKey·회차·시도 순번을 답과 맥락의 값 그대로 옮긴다(포트원, 다른 회차·순번)', () => {
    const otherEvent = '0190f3a1-7c2e-7c00-8000-0000000000c9';
    const e = eventOf(state({ pg: 'PORTONE', amount: 1000, eventSeq: 42, eventKey: 'ek-2' }), ctx({ eventId: otherEvent, attemptNo: 3 }));
    expect(e).toMatchObject({ pg: 'PORTONE', amount: 1000, eventSeq: 42, eventKey: 'ek-2', eventId: otherEvent, attemptNo: 3, orderId: ORDER_ID });
  });

  test('경계: 금액 0·시도 순번 0(ACCEPTED 시도가 없음, 반영의 결정이 PG_MISMATCH 보류로 다룬다)·순번 1은 반영할 수 있는 모양이다', () => {
    expect(eventOf(state({ amount: 0 })).amount).toBe(0);
    expect(eventOf(state(), ctx({ attemptNo: 0 })).attemptNo).toBe(0);
    expect(eventOf(state({ eventSeq: 1 })).eventSeq).toBe(1);
  });

  test('답 객체를 바꾸지 않는다(순수 함수)', () => {
    const s = Object.freeze(state());
    const c = Object.freeze(ctx());
    expect(() => paymentStateToResultEvent(s, c)).not.toThrow();
    expect(s).toEqual(state());
  });
});

describe('paymentStateToResultEvent: 반영하지 않는 상태(설계 5)', () => {
  test('ACCEPTED(승인 중) → WAIT: 아무것도 하지 않고 다음 점검에 다시 묻는다 (ADR0140)', () => {
    expect(paymentStateToResultEvent(state({ status: 'ACCEPTED', approvedAtMs: undefined }), ctx())).toEqual({ kind: 'WAIT' });
  });

  test('PARTIAL_CANCELED → IGNORE CANCELED(취소 흐름은 PRF-173·환불 단계 몫. 실행기가 경고 한 줄 뒤 60초 미룬다) (ADR0140)', () => {
    expect(paymentStateToResultEvent(state({ status: 'PARTIAL_CANCELED' }), ctx())).toEqual({ kind: 'IGNORE', reason: 'CANCELED' });
  });

  test('P-T32_리뷰 고침 M6: CANCELED는 사건과 같은 처리기로 반영한다(대사가 닫은 전액 취소, 당기기가 결과를 잃지 않는다)', () => {
    expect(paymentStateToResultEvent(state({ status: 'CANCELED' }), ctx())).toMatchObject({ kind: 'APPLY', event: { type: 'CANCELED' } });
  });

  test.each<[string, Partial<OrderPaymentState>, Partial<PaymentPullContext>]>([
    ['상태 UNSPECIFIED(칸이 없거나 모르는 값)', { status: 'UNSPECIFIED' }, {}],
    ['결제사 없음', { pg: undefined }, {}],
    ['금액 NaN(칸 없음)', { amount: Number.NaN }, {}],
    ['금액 음수', { amount: -1 }, {}],
    ['금액 소수', { amount: 1.5 }, {}],
    ['금액 무한대', { amount: Number.POSITIVE_INFINITY }, {}],
    ['금액이 안전한 정수를 넘음', { amount: 2 ** 53 }, {}],
    ['순번 0', { eventSeq: 0 }, {}],
    ['순번 음수', { eventSeq: -1 }, {}],
    ['순번 소수', { eventSeq: 2.5 }, {}],
    ['순번 NaN', { eventSeq: Number.NaN }, {}],
    ['순번이 안전한 정수를 넘음', { eventSeq: 2 ** 53 }, {}],
    ['eventKey 빈 글', { eventKey: '' }, {}],
    ['시도 순번 음수', {}, { attemptNo: -1 }],
    ['시도 순번 소수', {}, { attemptNo: 1.5 }],
    ['시도 순번 NaN', {}, { attemptNo: Number.NaN }],
    ['approved_at이 날짜 범위 밖', { approvedAtMs: 8.64e15 + 1 }, {}],
    ['UNKNOWN인데 당긴 시각이 날짜 범위 밖', { status: 'UNKNOWN', approvedAtMs: undefined }, { pulledAtMs: Number.NaN }],
  ])('%s → IGNORE MALFORMED(반영할 수 없는 모양, 던지지 않는다) [ASVS v5.0.0-2.3.3]', (_name, s, c) => {
    expect(paymentStateToResultEvent(state(s), ctx(c))).toEqual({ kind: 'IGNORE', reason: 'MALFORMED' });
  });

  test('모르는 상태 글이 와도 던지지 않고 IGNORE MALFORMED다(순수 함수)', () => {
    expect(paymentStateToResultEvent(state({ status: 'BOGUS' as never }), ctx())).toEqual({ kind: 'IGNORE', reason: 'MALFORMED' });
  });
});

describe('사건 길과 같은 반영 결정(P-T15: 두 길로 온 같은 결과는 한 번만)', () => {
  test('당기기로 만든 승인 사건은 RESERVED·순번 2인 주문에 T9 승인 쓰기이고, 그 순번을 반영한 뒤(순번 3) 같은 사건이 사건 길로 다시 오면 DUPLICATE로 건너뛴다 (P-T15, P-T47, ADR0140) [ASVS v5.0.0-2.3.3]', () => {
    const pulled = eventOf(state());
    expect(decidePaymentResult(pulled, resultOrder())).toEqual({ kind: 'APPLY', write: 'APPROVE', transition: 'T9' });
    const applied = resultOrder({ status: 'APPROVED', paymentEventSeq: EVENT_SEQ });
    expect(decidePaymentResult(pulled, applied)).toEqual({ kind: 'SKIP', reason: 'DUPLICATE' });
    // 사건 길이 먼저 반영했으면 당기기로 만든 같은 순번 사건도 건너뛴다
    expect(decidePaymentResult(eventOf(state()), applied)).toEqual({ kind: 'SKIP', reason: 'DUPLICATE' });
    expect(ORDER_PAYMENT_SEQ).toBeLessThan(EVENT_SEQ);
  });

  test('당기기로 만든 UNKNOWN·입금 대기·실패 사건도 지금 전이 표대로 간다(T12·T10·T11) (ADR0140)', () => {
    expect(decidePaymentResult(eventOf(state({ status: 'UNKNOWN', approvedAtMs: undefined })), resultOrder())).toEqual({ kind: 'APPLY', write: 'MARK', transition: 'T12' });
    expect(decidePaymentResult(eventOf(state({ status: 'AWAITING_DEPOSIT', approvedAtMs: undefined })), resultOrder())).toEqual({ kind: 'APPLY', write: 'MARK', transition: 'T10' });
    expect(decidePaymentResult(eventOf(state({ status: 'FAILED', failureCategory: 'CARD_DECLINED' })), resultOrder())).toEqual({
      kind: 'APPLY',
      write: 'FAIL',
      transition: 'T11',
      failureReason: 'CARD_DECLINED',
    });
  });
});

describe('isPaymentResultMissingLong: 기록 없음이 길어졌나(설계 7, 10분 [가정])', () => {
  const SENT = NOW;

  test('정확히 보낸 뒤 10분이면 넘긴 것이다(경계 시각은 넘긴 쪽). 기준 상수는 10분이다', () => {
    expect(isPaymentResultMissingLong(SENT, SENT + 10 * MIN)).toBe(true);
    expect(PAYMENT_PULL_MISSING_AFTER_MS).toBe(10 * MIN);
  });

  test('그 1ms 전이면 아직이다', () => {
    expect(isPaymentResultMissingLong(SENT, SENT + 10 * MIN - 1)).toBe(false);
  });

  test('보낸 직후·5초 뒤는 아직이고, 한 시간 뒤는 넘겼다', () => {
    expect(isPaymentResultMissingLong(SENT, SENT)).toBe(false);
    expect(isPaymentResultMissingLong(SENT, SENT + PAYMENT_PULL_AFTER_SENT_MS)).toBe(false);
    expect(isPaymentResultMissingLong(SENT, SENT + 60 * MIN)).toBe(true);
  });

  test('보낸 시각이 지금보다 뒤(파드 사이 시계 어긋남)면 아직이다', () => {
    expect(isPaymentResultMissingLong(SENT + 30_000, SENT)).toBe(false);
  });

  test.each<[unknown, unknown]>([
    [Number.NaN, NOW],
    [NOW, Number.NaN],
    [undefined, NOW + 60 * MIN],
    ['2026-11-05T03:00:00.000Z', NOW + 60 * MIN],
  ])('수가 아닌 값(%s, %s)이면 거짓이다(던지지 않는다)', (sent, now) => {
    expect(isPaymentResultMissingLong(sent as number, now as number)).toBe(false);
  });
});

describe('상수(ADR-0140 결정 1·3, 설계 3·4·5·7)', () => {
  test('반복 1초·보낸 뒤 5초부터·같은 주문 5초에 한 번·한 번에 100건·파드마다 동시 4개·데드라인 500ms·전용 풀 연결 2개 [가정] (ADR0140) [ASVS v5.0.0-16.5.2]', () => {
    expect({
      interval: PAYMENT_PULL_INTERVAL_MS,
      afterSent: PAYMENT_PULL_AFTER_SENT_MS,
      repeat: PAYMENT_PULL_REPEAT_MS,
      batch: PAYMENT_PULL_BATCH,
      concurrency: PAYMENT_PULL_CONCURRENCY,
      deadline: PAYMENT_PULL_DEADLINE_MS,
      dbMax: PAYMENT_PULL_DB_MAX,
    }).toEqual({ interval: 1000, afterSent: 5000, repeat: 5000, batch: 100, concurrency: 4, deadline: 500, dbMax: 2 });
    // 함수가 있는지도 함께 본다(뼈대에서 같이 실패하게)
    expect(isPaymentResultMissingLong(NOW, NOW + PAYMENT_PULL_MISSING_AFTER_MS)).toBe(true);
  });

  test('미루기는 60초 [가정]이고, 기록 없음 SEV2 한 줄은 주문마다 10분 [가정] 창에 한 번이다(점검 간격 60초보다 길게 두어 1분마다 쌓이지 않게, docs/features/payment.md §2) (ADR0140)', () => {
    expect(PAYMENT_PULL_SLOW_REPEAT_MS).toBe(60_000);
    expect(PAYMENT_PULL_MISSING_LOG_WINDOW_MS).toBe(10 * MIN);
    expect(PAYMENT_PULL_MISSING_LOG_WINDOW_MS).toBeGreaterThan(PAYMENT_PULL_SLOW_REPEAT_MS);
    expect(isPaymentResultMissingLong(NOW, NOW + PAYMENT_PULL_MISSING_AFTER_MS - 1)).toBe(false);
  });

  test('리뷰 고침 M2·M3·M4_기록 없음 10분·보류의 다음 점검은 10분 [가정], payment-svc가 답하지 못한 묶음(차단기 열림·UNAVAILABLE·시간 초과)은 30초 [가정]이고, 대상에서 빼는 보류 사건의 토픽은 결제 결과 소비자의 토픽(trade.payments)이다 (ADR0140) [ASVS v5.0.0-16.3.4]', () => {
    expect({ long: PAYMENT_PULL_LONG_REPEAT_MS, outage: PAYMENT_PULL_OUTAGE_REPEAT_MS, topic: PAYMENT_PULL_HELD_TOPIC }).toEqual({ long: 10 * MIN, outage: 30_000, topic: 'trade.payments' });
    expect(PAYMENT_PULL_HELD_TOPIC).toBe(TRADE_PAYMENTS_TOPIC);
    expect([...PAYMENT_PULL_OUTAGE_CODES].sort()).toEqual(['CIRCUIT_OPEN', 'DEADLINE_EXCEEDED', 'UNAVAILABLE']);
  });

  test('당기기로 반영하는 종류(지표 payment_result_pulled_total{type})는 APPROVED·FAILED·AWAITING_DEPOSIT·UNKNOWN·CANCELED 다섯이다 (ADR0140, HOT-153 리뷰 고침 M6)', () => {
    expect([...PAYMENT_PULL_TYPES]).toEqual(['APPROVED', 'FAILED', 'AWAITING_DEPOSIT', 'UNKNOWN', 'CANCELED']);
    for (const type of PAYMENT_PULL_TYPES) {
      const status = type;
      expect(eventOf(state({ status, ...(type === 'FAILED' ? { failureCategory: 'PG_ERROR' as const } : {}) })).type, type).toBe(type);
    }
  });

  test('결제 원장 상태 목록은 payment.proto PaymentStatus에서 앞머리 PAYMENT_STATUS_를 뗀 이름과 같은 값·차례다(계약과 어긋나지 않게)', () => {
    const v1 = (paymentV1Payment as unknown as { nested: { peaket: { nested: { payment: { nested: { v1: { nested: Record<string, { values?: Record<string, number> }> } } } } } } }).nested.peaket.nested
      .payment.nested.v1.nested;
    const values = v1['PaymentStatus']!.values!;
    const names = Object.entries(values)
      .sort((a, b) => a[1] - b[1])
      .map(([n]) => n.replace(/^PAYMENT_STATUS_/, ''));
    expect([...PAYMENT_LEDGER_STATUSES]).toEqual(names);
    // 상태마다 결정 하나(던지지 않는다)
    for (const status of PAYMENT_LEDGER_STATUSES) expect(['APPLY', 'WAIT', 'IGNORE'], status).toContain(paymentStateToResultEvent(state({ status, failureCategory: 'PG_ERROR' }), ctx()).kind);
  });
});
