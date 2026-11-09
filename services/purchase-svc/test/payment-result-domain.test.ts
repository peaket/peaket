// 결제 결과 반영의 순수 규칙(booking domain/payment-result.ts decidePaymentResult·ticketIssueDueAtMs,
// docs/features/payment.md §2 '결제 결과 반영의 첫 구현'의 '사건 종류 × 지금 상태 → 전이'·'있을 수 없는 조합과 대조', §3 T9~T17, BUILD_ORDER PRF-163).
// 전이 표의 모든 칸(종류 넷 × 출발 상태 셋), 표 밖의 조합(모든 주문 상태), 다시 온 사건(순번·도착 상태), 기록·아직 맡지 않은 종류, 금액·결제사 대조,
// 보는 차례(뼈대 [정함] ①~⑦, 리뷰 M2가 결제사 대조 앞에 닫힌 주문 검사를 더함), 실패 사유 대체값, 발권 기한(승인 + 30분 [가정]), 보류 까닭별 로그 수준(리뷰 M2·M4·L6).
// 리뷰(2026-11-05) M2: 닫힌 주문(FAILED·EXPIRED·COMPENSATED)에 과금 사건은 CHARGED_ON_CLOSED_ORDER, M3: DEPOSIT_REVERSED·취소류는 건너뛰지 않고 보류.
// 상수 값은 함수 시험 안에서 함께 본다(함수가 아직 없으면 같이 실패하게).
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import {
  decidePaymentResult,
  ORDER_STATUSES,
  type OrderStatus,
  PAYMENT_EVENT_TYPES,
  PAYMENT_FAILURE_CATEGORIES,
  PAYMENT_FAILURE_FALLBACK,
  PAYMENT_RESULT_ARRIVAL,
  PAYMENT_RESULT_HOLD_LOG,
  PAYMENT_RESULT_NAMES,
  PAYMENT_RESULT_TABLE,
  PAYMENT_RESULT_WRITES,
  type PaymentEventType,
  type PaymentFailureCategory,
  type PaymentResultDecision,
  type PaymentResultOrderView,
  TICKET_ISSUE_WINDOW_MS,
  ticketIssueDueAtMs,
} from '../src/modules/booking/index.js';
import { AMOUNT } from './order-cases.js';
import { EVENT_SEQ, OCCURRED_AT, OCCURRED_AT_MS, ORDER_ID, ORDER_PAYMENT_SEQ, paymentEvent } from './payment-result-cases.js';

const MIN = 60_000;

/** 결정이 보는 주문 모습(RESERVED, 순번 2, 토스로 접수함) */
function view(over: Partial<PaymentResultOrderView> = {}): PaymentResultOrderView {
  return { orderId: ORDER_ID, status: 'RESERVED', amount: AMOUNT, paymentEventSeq: ORDER_PAYMENT_SEQ, acceptedPg: 'TOSS', ...over };
}

const decide = (type: PaymentEventType, status: OrderStatus, over: { event?: Parameters<typeof paymentEvent>[0]; order?: Partial<PaymentResultOrderView> } = {}) =>
  decidePaymentResult(paymentEvent({ type, ...(type === 'FAILED' ? { failureCategory: 'CARD_DECLINED', result: 'DECLINED' } : {}), ...over.event }), view({ status, ...over.order }));

const apply = (write: 'APPROVE' | 'FAIL' | 'MARK', transition: string, failureReason?: PaymentFailureCategory): PaymentResultDecision =>
  (write === 'FAIL' ? { kind: 'APPLY', write, transition, failureReason } : { kind: 'APPLY', write, transition }) as PaymentResultDecision;
const skip = (reason: string) => ({ kind: 'SKIP', reason }) as PaymentResultDecision;
const hold = (reason: string) => ({ kind: 'HOLD', reason }) as PaymentResultDecision;

/** 정본 표(payment §2 '사건 종류 × 지금 상태 → 전이')를 시험 쪽에 따로 적은 것. 코드 표(PAYMENT_RESULT_TABLE)와 견준다 */
const CANON: Record<'APPROVED' | 'FAILED' | 'UNKNOWN' | 'AWAITING_DEPOSIT' | 'DEPOSIT_REVERSED' | 'CANCELED', Partial<Record<OrderStatus, string>>> = {
  CANCELED: { RESERVED: 'T11', UNKNOWN: 'T15' },
  APPROVED: { RESERVED: 'T9', UNKNOWN: 'T13', AWAITING_DEPOSIT: 'T16' },
  FAILED: { RESERVED: 'T11', UNKNOWN: 'T15', AWAITING_DEPOSIT: 'T17' },
  UNKNOWN: { RESERVED: 'T12' },
  AWAITING_DEPOSIT: { RESERVED: 'T10', UNKNOWN: 'T14' },
  DEPOSIT_REVERSED: { CONFIRMED: 'T21' },
};
const APPLIED_TYPES = ['APPROVED', 'FAILED', 'UNKNOWN', 'AWAITING_DEPOSIT'] as const;
const SOURCE_STATUSES = ['RESERVED', 'UNKNOWN', 'AWAITING_DEPOSIT'] as const;

describe('decidePaymentResult: 대사가 닫은 결제의 CANCELED(BUILD_ORDER HOT-153)', () => {
  test('P-T32_결과 모름 주문의 CANCELED는 T15다(실패 사유는 없음: 기본값 PG_ERROR). 돈이 나가지 않은 실패다', () => {
    expect(decide('CANCELED', 'UNKNOWN')).toEqual({ kind: 'APPLY', write: 'FAIL', transition: 'T15', failureReason: 'PG_ERROR' });
  });

  test('P-T32_리뷰 고침 M6: 결과 모름이 아직 반영되지 않은 RESERVED 주문의 CANCELED도 보류하지 않고 실패로 끝낸다(명세 applyResult, 전이 표의 RESERVED → FAILED는 T11이다)', () => {
    expect(decide('CANCELED', 'RESERVED')).toEqual({ kind: 'APPLY', write: 'FAIL', transition: 'T11', failureReason: 'PG_ERROR' });
  });

  test('P-T32_이미 FAILED인 주문에 온 CANCELED는 다시 온 사건이다', () => {
    expect(decide('CANCELED', 'FAILED')).toEqual({ kind: 'SKIP', reason: 'ALREADY_THERE' });
  });

  test('P-T32_결과 모름 주문이어도 금액·결제사가 어긋나면 보류한다(다른 사건과 같다)', () => {
    expect(decide('CANCELED', 'UNKNOWN', { event: { amount: AMOUNT + 1 } })).toEqual(hold('AMOUNT_MISMATCH'));
    expect(decide('CANCELED', 'UNKNOWN', { event: { pg: 'PORTONE' } })).toEqual(hold('PG_MISMATCH'));
  });
});

describe('decidePaymentResult: 전이 표의 칸(종류 넷 × 출발 상태 셋)', () => {
  test.each([
    // [사건 종류, 주문 상태, 기대 결정]
    ['APPROVED', 'RESERVED', apply('APPROVE', 'T9')],
    ['APPROVED', 'UNKNOWN', apply('APPROVE', 'T13')],
    ['APPROVED', 'AWAITING_DEPOSIT', apply('APPROVE', 'T16')],
    ['FAILED', 'RESERVED', apply('FAIL', 'T11', 'CARD_DECLINED')],
    ['FAILED', 'UNKNOWN', apply('FAIL', 'T15', 'CARD_DECLINED')],
    ['FAILED', 'AWAITING_DEPOSIT', apply('FAIL', 'T17', 'CARD_DECLINED')],
    ['UNKNOWN', 'RESERVED', apply('MARK', 'T12')],
    // 도착 상태와 같다: 다시 온 사건
    ['UNKNOWN', 'UNKNOWN', skip('ALREADY_THERE')],
    // 입금 대기 주문에 UNKNOWN은 표 밖이다
    ['UNKNOWN', 'AWAITING_DEPOSIT', hold('IMPOSSIBLE')],
    ['AWAITING_DEPOSIT', 'RESERVED', apply('MARK', 'T10')],
    ['AWAITING_DEPOSIT', 'UNKNOWN', apply('MARK', 'T14')],
    ['AWAITING_DEPOSIT', 'AWAITING_DEPOSIT', skip('ALREADY_THERE')],
  ] as const)('FR011_%s 사건 × %s 주문 → %o', (type, status, expected) => {
    expect(decide(type, status)).toEqual(expected);
  });

  test('FR011_코드 표(PAYMENT_RESULT_TABLE)·도착 상태·쓰기 갈래가 정본 표와 같고, 표의 칸마다 결정이 그 전이·그 쓰기 갈래다', () => {
    expect(PAYMENT_RESULT_TABLE).toEqual(CANON);
    expect(PAYMENT_RESULT_ARRIVAL).toEqual({ APPROVED: 'APPROVED', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN', AWAITING_DEPOSIT: 'AWAITING_DEPOSIT', DEPOSIT_REVERSED: 'AWAITING_DEPOSIT', CANCELED: 'FAILED' });
    expect(PAYMENT_RESULT_WRITES).toEqual({ T9: 'APPROVE', T13: 'APPROVE', T16: 'APPROVE', T11: 'FAIL', T15: 'FAIL', T17: 'FAIL', T10: 'MARK', T12: 'MARK', T14: 'MARK', T21: 'REVERSE' });
    for (const type of APPLIED_TYPES) {
      for (const status of SOURCE_STATUSES) {
        const t = CANON[type][status];
        if (t === undefined) continue;
        const d = decide(type, status);
        expect(d, `${type} × ${status}`).toMatchObject({ kind: 'APPLY', transition: t, write: PAYMENT_RESULT_WRITES[t as keyof typeof PAYMENT_RESULT_WRITES] });
      }
    }
  });

  test('PT2_FAILED의 실패 사유는 사건의 failureCategory 그대로다(일곱 값 모두, 주문 failure_reason에 적는다)', () => {
    expect(PAYMENT_FAILURE_CATEGORIES).toEqual(['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED', 'DEPOSIT_CANCELED']);
    for (const failureCategory of PAYMENT_FAILURE_CATEGORIES) {
      for (const [status, t] of [
        ['RESERVED', 'T11'],
        ['UNKNOWN', 'T15'],
        ['AWAITING_DEPOSIT', 'T17'],
      ] as const) {
        expect(decide('FAILED', status, { event: { failureCategory } }), `${failureCategory} × ${status}`).toEqual(apply('FAIL', t, failureCategory));
      }
    }
  });

  test('PT2_FAILED에 failureCategory가 없으면 실패 사유는 PG_ERROR다(보류하면 좌석이 PENDING으로 묶이므로 결제사 오류로 보고 반영한다, [정함])', () => {
    expect(PAYMENT_FAILURE_FALLBACK).toBe('PG_ERROR');
    const e = paymentEvent({ type: 'FAILED', result: 'DECLINED' });
    expect(e.failureCategory).toBeUndefined();
    expect(decidePaymentResult(e, view({ status: 'RESERVED' }))).toEqual(apply('FAIL', 'T11', 'PG_ERROR'));
    expect(decidePaymentResult(e, view({ status: 'UNKNOWN' }))).toEqual(apply('FAIL', 'T15', 'PG_ERROR'));
    expect(decidePaymentResult(e, view({ status: 'AWAITING_DEPOSIT' }))).toEqual(apply('FAIL', 'T17', 'PG_ERROR'));
  });

  test('FR011_승인·상태만 바꾸는 결정에는 실패 사유가 없다(APPROVED·UNKNOWN·AWAITING_DEPOSIT 사건에 failureCategory가 실려 와도)', () => {
    for (const [type, status] of [
      ['APPROVED', 'RESERVED'],
      ['UNKNOWN', 'RESERVED'],
      ['AWAITING_DEPOSIT', 'UNKNOWN'],
    ] as const) {
      const d = decidePaymentResult(paymentEvent({ type, failureCategory: 'PG_ERROR' }), view({ status }));
      expect(d.kind, `${type} × ${status}`).toBe('APPLY');
      expect(d, `${type} × ${status}`).not.toHaveProperty('failureReason');
    }
  });
});

/** 닫힌 주문(리뷰 M2): 과금 사건(APPROVED·AWAITING_DEPOSIT)이 오면 CHARGED_ON_CLOSED_ORDER(SEV1) */
const CLOSED = ['FAILED', 'EXPIRED', 'COMPENSATED'] as const;
const CHARGES = ['APPROVED', 'AWAITING_DEPOSIT'] as const;
const isClosedCharge = (type: string, status: string) => (CHARGES as readonly string[]).includes(type) && (CLOSED as readonly string[]).includes(status);

describe('decidePaymentResult: 표 밖의 조합은 보류(HOLD IMPOSSIBLE, 닫힌 주문에 과금 사건은 CHARGED_ON_CLOSED_ORDER)', () => {
  test('FR011_반영하는 종류 넷 × 모든 주문 상태: 표에 있으면 APPLY, 도착 상태와 같으면 SKIP ALREADY_THERE, 닫힌 주문에 과금 사건은 CHARGED_ON_CLOSED_ORDER, 그 밖은 HOLD IMPOSSIBLE이다', () => {
    for (const type of APPLIED_TYPES) {
      for (const status of ORDER_STATUSES) {
        const t = CANON[type][status];
        const expected =
          t !== undefined
            ? { kind: 'APPLY', transition: t }
            : isClosedCharge(type, status)
              ? { kind: 'HOLD', reason: 'CHARGED_ON_CLOSED_ORDER' }
              : status === type
                ? { kind: 'SKIP', reason: 'ALREADY_THERE' }
                : { kind: 'HOLD', reason: 'IMPOSSIBLE' };
        expect(decide(type, status), `${type} × ${status}`).toMatchObject(expected);
      }
    }
  });

  test.each(CLOSED)('FR011_닫힌 %s 주문에 APPROVED·AWAITING_DEPOSIT(새 순번)는 과금됐는데 주문이 닫힌 것이라 HOLD CHARGED_ON_CLOSED_ORDER다(리뷰 M2, SEV1)', (status) => {
    for (const type of CHARGES) expect(decide(type, status), type).toEqual(hold('CHARGED_ON_CLOSED_ORDER'));
  });

  test.each(['CONFIRMED', 'REFUNDED', 'CREATED', 'ACCEPTED'] as const)('FR011_%s 주문에 APPROVED(새 순번)는 있을 수 없는 조합이라 HOLD IMPOSSIBLE이다(SEV2)', (status) => {
    expect(decide('APPROVED', status)).toEqual(hold('IMPOSSIBLE'));
  });

  test('FR011_닫힌 주문에 과금이 아닌 사건(FAILED·UNKNOWN)은 CHARGED_ON_CLOSED_ORDER가 아니다(FAILED 주문에 FAILED는 ALREADY_THERE, EXPIRED 주문에 FAILED·UNKNOWN은 IMPOSSIBLE)', () => {
    expect(decide('FAILED', 'FAILED')).toEqual(skip('ALREADY_THERE'));
    expect(decide('FAILED', 'EXPIRED')).toEqual(hold('IMPOSSIBLE'));
    expect(decide('UNKNOWN', 'EXPIRED')).toEqual(hold('IMPOSSIBLE'));
    expect(decide('UNKNOWN', 'COMPENSATED')).toEqual(hold('IMPOSSIBLE'));
  });

  test('FR011_닫힌 주문 검사가 결제사·금액 대조보다 먼저다: 접수한 결제 시도가 없는 EXPIRED 주문(T5)·결제사·금액이 다른 FAILED 주문에 APPROVED도 CHARGED_ON_CLOSED_ORDER다(리뷰 M2)', () => {
    expect(decide('APPROVED', 'EXPIRED', { order: { acceptedPg: undefined } })).toEqual(hold('CHARGED_ON_CLOSED_ORDER'));
    expect(decide('AWAITING_DEPOSIT', 'EXPIRED', { order: { acceptedPg: undefined } })).toEqual(hold('CHARGED_ON_CLOSED_ORDER'));
    expect(decide('APPROVED', 'FAILED', { event: { pg: 'PORTONE', amount: AMOUNT + 1 } })).toEqual(hold('CHARGED_ON_CLOSED_ORDER'));
    // 다시 온 사건(순번)은 그보다 먼저다
    expect(decide('APPROVED', 'FAILED', { event: { eventSeq: ORDER_PAYMENT_SEQ } })).toEqual(skip('DUPLICATE'));
  });

  test('FR011_보류 까닭마다 로그 수준과 표시가 정해져 있다: 닫힌 주문 과금·판매 행 어긋남은 SEV1(payment-charged-closed는 닫힌 주문 과금만), 금액·결제사 대조 실패는 SEV2 보안 이벤트(ASVS 16.3.3), 그 밖은 SEV2', () => {
    expect(PAYMENT_RESULT_HOLD_LOG).toEqual({
      IMPOSSIBLE: { severity: 'SEV2' },
      AMOUNT_MISMATCH: { severity: 'SEV2', kind: 'security' },
      PG_MISMATCH: { severity: 'SEV2', kind: 'security' },
      NOT_YET_SUPPORTED: { severity: 'SEV2' },
      CHARGED_ON_CLOSED_ORDER: { severity: 'SEV1', kind: 'payment-charged-closed' },
      DEPOSIT_REVERSED_NOT_CONFIRMED: { severity: 'SEV1' },
      SOLD_MISMATCH: { severity: 'SEV1' },
    });
  });

  test('FR011_주문이 없으면 HOLD IMPOSSIBLE이다(없는 주문도 같은 까닭으로 묶는다, [정함] ①). 종류가 기록·아직 맡지 않은 것이어도 같다', () => {
    for (const type of PAYMENT_EVENT_TYPES) expect(decidePaymentResult(paymentEvent({ type }), undefined), type).toEqual(hold('IMPOSSIBLE'));
  });
});

describe('decidePaymentResult: 다시 온 사건과 건너뛰는 종류', () => {
  test('PT15_사건 순번이 주문이 반영한 순번 이하면 SKIP DUPLICATE다(같음·작음). 한 칸 크면 반영한다(사건 길과 당기기로 두 번 온 사건, 늦게 온 앞 순번)', () => {
    expect(decide('APPROVED', 'RESERVED', { event: { eventSeq: ORDER_PAYMENT_SEQ } })).toEqual(skip('DUPLICATE'));
    expect(decide('APPROVED', 'RESERVED', { event: { eventSeq: ORDER_PAYMENT_SEQ - 1 } })).toEqual(skip('DUPLICATE'));
    expect(decide('APPROVED', 'RESERVED', { event: { eventSeq: 1 }, order: { paymentEventSeq: 40 } })).toEqual(skip('DUPLICATE'));
    expect(decide('APPROVED', 'RESERVED', { event: { eventSeq: ORDER_PAYMENT_SEQ + 1 } })).toEqual(apply('APPROVE', 'T9'));
    expect(EVENT_SEQ).toBe(ORDER_PAYMENT_SEQ + 1);
  });

  test('PT15_당기기로 반영한 뒤(주문 APPROVED, 순번 3) 같은 사건·앞 순번 사건이 늦게 오면 모두 DUPLICATE다(종류와 상관없이)', () => {
    const approved = { status: 'APPROVED' as const, paymentEventSeq: 3 };
    for (const type of PAYMENT_EVENT_TYPES) {
      expect(decidePaymentResult(paymentEvent({ type, eventSeq: 3 }), view(approved)), `${type} 순번 3`).toEqual(skip('DUPLICATE'));
      expect(decidePaymentResult(paymentEvent({ type, eventSeq: 2 }), view(approved)), `${type} 순번 2`).toEqual(skip('DUPLICATE'));
    }
  });

  test.each(APPLIED_TYPES)('PT15_%s 사건이 새 순번으로 왔는데 주문이 이미 그 도착 상태면 SKIP ALREADY_THERE다', (type) => {
    expect(decide(type, PAYMENT_RESULT_ARRIVAL[type])).toEqual(skip('ALREADY_THERE'));
  });

  test.each(ORDER_STATUSES)('FR011_RESOLVED(UNKNOWN 해소 기록)는 %s 주문에서 SKIP RECORD_ONLY다(결과는 APPROVED·AWAITING_DEPOSIT·FAILED 사건이 따로 온다, ADR-0073)', (status) => {
    expect(decide('RESOLVED', status, { event: { result: 'APPROVED' } })).toEqual(skip('RECORD_ONLY'));
  });

  test('P-T36 ④_DEPOSIT_REVERSED는 CONFIRMED 주문에서 T21(REVERSE)이다 [ASVS v5.0.0-2.3.1]', () => {
    expect(decide('DEPOSIT_REVERSED', 'CONFIRMED')).toEqual({ kind: 'APPLY', write: 'REVERSE', transition: 'T21' });
  });

  test.each(['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'] as const)('P-T36 ④_DEPOSIT_REVERSED는 %s 주문이면 전이하지 않고 보류한다 [ASVS v5.0.0-2.3.1]', (status) => {
    expect(decide('DEPOSIT_REVERSED', status)).toEqual(hold('DEPOSIT_REVERSED_NOT_CONFIRMED'));
  });

  test.each(['PARTIAL_CANCELED', 'CANCELED'] as const)(
    'FR011_%s는 건너뛰지 않고 HOLD NOT_YET_SUPPORTED다(맡을 단계가 생기면 보류 표에서 다시 처리한다, 리뷰 M3. CONFIRMED·APPROVED 주문 모두)',
    (type) => {
      for (const status of ['CONFIRMED', 'APPROVED'] as const) expect(decide(type, status), status).toEqual(hold('NOT_YET_SUPPORTED'));
    },
  );

  test('FR011_부분 취소는 RESERVED 주문에서도 보류한다(전액 취소만 실패로 끝낸다, HOT-153 리뷰 고침 M6)', () => {
    expect(decide('PARTIAL_CANCELED', 'RESERVED')).toEqual(hold('NOT_YET_SUPPORTED'));
  });

  test('FR011_사건 종류 목록은 계약(asyncapi PaymentEvent.type)과 같은 값·차례이고, 여덟 종류 모두 결정이 던지지 않는다', () => {
    expect([...PAYMENT_EVENT_TYPES]).toEqual(PaymentEvent.shape.type.options);
    expect([...PAYMENT_FAILURE_CATEGORIES]).toEqual(PaymentEvent.shape.failureCategory.unwrap().options);
    expect([...PAYMENT_RESULT_NAMES]).toEqual(PaymentEvent.shape.result.unwrap().options);
    for (const type of PAYMENT_EVENT_TYPES) for (const status of ORDER_STATUSES) expect(() => decide(type, status), `${type} × ${status}`).not.toThrow();
  });
});

describe('decidePaymentResult: 금액·결제사 대조', () => {
  test.each([AMOUNT + 1, AMOUNT - 1, 0])('FR011_사건 금액(%i원)이 주문 금액과 다르면 HOLD AMOUNT_MISMATCH다(반영하지 않는다, SEV2)', (amount) => {
    expect(decide('APPROVED', 'RESERVED', { event: { amount } })).toEqual(hold('AMOUNT_MISMATCH'));
    expect(decide('FAILED', 'RESERVED', { event: { amount } })).toEqual(hold('AMOUNT_MISMATCH'));
    expect(decide('AWAITING_DEPOSIT', 'RESERVED', { event: { amount } })).toEqual(hold('AMOUNT_MISMATCH'));
  });

  test('PT29_사건 결제사가 주문의 접수한 결제 시도의 결제사와 다르면 HOLD PG_MISMATCH다(결제사 고정, ADR-0044)', () => {
    expect(decide('APPROVED', 'RESERVED', { event: { pg: 'PORTONE' } })).toEqual(hold('PG_MISMATCH'));
    expect(decide('APPROVED', 'RESERVED', { event: { pg: 'SIMULATOR' } })).toEqual(hold('PG_MISMATCH'));
    expect(decide('FAILED', 'UNKNOWN', { event: { pg: 'TOSS' }, order: { acceptedPg: 'PORTONE' } })).toEqual(hold('PG_MISMATCH'));
    // 같으면 반영한다
    expect(decide('APPROVED', 'RESERVED', { event: { pg: 'PORTONE' }, order: { acceptedPg: 'PORTONE' } })).toEqual(apply('APPROVE', 'T9'));
  });

  test('PT29_접수한 결제 시도가 없으면(acceptedPg 없음) HOLD PG_MISMATCH다', () => {
    const noAttempt: PaymentResultOrderView = { orderId: ORDER_ID, status: 'RESERVED', amount: AMOUNT, paymentEventSeq: ORDER_PAYMENT_SEQ };
    expect(decidePaymentResult(paymentEvent(), noAttempt)).toEqual(hold('PG_MISMATCH'));
    expect(decidePaymentResult(paymentEvent({ type: 'FAILED' }), { ...noAttempt, status: 'UNKNOWN' })).toEqual(hold('PG_MISMATCH'));
  });
});

describe('decidePaymentResult: 보는 차례([정함] ① 주문 없음 → ② 순번 → ③ 기록·아직 맡지 않음 → ③-2 닫힌 주문에 과금(리뷰 M2) → ④ 결제사 → ⑤ 금액 → ⑥ 도착 상태 → ⑦ 표)', () => {
  test('PT15_② 순번이 결제사·금액 대조와 표보다 먼저다: 다시 온 사건은 결제사·금액이 달라도, 표 밖 조합이어도 DUPLICATE다', () => {
    const dup = { eventSeq: ORDER_PAYMENT_SEQ };
    expect(decide('APPROVED', 'RESERVED', { event: { ...dup, pg: 'PORTONE' } })).toEqual(skip('DUPLICATE'));
    expect(decide('APPROVED', 'RESERVED', { event: { ...dup, amount: AMOUNT + 1 } })).toEqual(skip('DUPLICATE'));
    expect(decide('APPROVED', 'FAILED', { event: dup })).toEqual(skip('DUPLICATE'));
    expect(decide('APPROVED', 'RESERVED', { event: dup, order: { acceptedPg: undefined } })).toEqual(skip('DUPLICATE'));
  });

  test('FR011_② 순번이 ③ 종류보다 먼저다: 다시 온 RESOLVED·DEPOSIT_REVERSED는 DUPLICATE다', () => {
    expect(decide('RESOLVED', 'RESERVED', { event: { eventSeq: ORDER_PAYMENT_SEQ } })).toEqual(skip('DUPLICATE'));
    expect(decide('DEPOSIT_REVERSED', 'CONFIRMED', { event: { eventSeq: ORDER_PAYMENT_SEQ } })).toEqual(skip('DUPLICATE'));
  });

  test('FR011_③ 기록·아직 맡지 않은 종류는 결제사·금액을 보지 않는다(RESOLVED는 결제사·금액이 달라도 건너뛰고, CANCELED·PARTIAL_CANCELED는 NOT_YET_SUPPORTED로 보류한다)', () => {
    expect(decide('RESOLVED', 'UNKNOWN', { event: { pg: 'PORTONE', amount: AMOUNT + 1 } })).toEqual(skip('RECORD_ONLY'));
    expect(decide('CANCELED', 'CONFIRMED', { event: { pg: 'PORTONE', amount: AMOUNT + 1 } })).toEqual(hold('NOT_YET_SUPPORTED'));
    expect(decide('PARTIAL_CANCELED', 'CONFIRMED', { order: { acceptedPg: undefined } })).toEqual(hold('NOT_YET_SUPPORTED'));
  });

  test('PT29_④ 결제사가 ⑤ 금액보다 먼저다(둘 다 다르면 PG_MISMATCH)', () => {
    expect(decide('APPROVED', 'RESERVED', { event: { pg: 'PORTONE', amount: AMOUNT + 1 } })).toEqual(hold('PG_MISMATCH'));
  });

  test('FR011_④⑤ 대조가 ⑥ 도착 상태·⑦ 표보다 먼저다: 이미 APPROVED인 주문에 결제사·금액이 다른 새 순번 APPROVED는 보류, CONFIRMED 주문에 금액이 다른 APPROVED는 AMOUNT_MISMATCH다', () => {
    expect(decide('APPROVED', 'APPROVED', { event: { pg: 'PORTONE' } })).toEqual(hold('PG_MISMATCH'));
    expect(decide('APPROVED', 'APPROVED', { event: { amount: AMOUNT + 1 } })).toEqual(hold('AMOUNT_MISMATCH'));
    expect(decide('APPROVED', 'CONFIRMED', { event: { amount: AMOUNT + 1 } })).toEqual(hold('AMOUNT_MISMATCH'));
  });

  test('FR011_① 주문 없음이 맨 먼저다(순번·종류를 보기 전에 HOLD IMPOSSIBLE)', () => {
    expect(decidePaymentResult(paymentEvent({ type: 'RESOLVED', eventSeq: 1 }), undefined)).toEqual(hold('IMPOSSIBLE'));
  });

  test('FR011_순수 함수다: 얼린 입력을 바꾸지 않고, 같은 입력에 같은 결정을 돌려준다', () => {
    const e = Object.freeze(paymentEvent({ type: 'FAILED', failureCategory: 'THROTTLED' }));
    const o = Object.freeze(view({ status: 'UNKNOWN' }));
    const first = decidePaymentResult(e, o);
    expect(first).toEqual(apply('FAIL', 'T15', 'THROTTLED'));
    expect(decidePaymentResult(e, o)).toEqual(first);
    expect(e).toEqual(paymentEvent({ type: 'FAILED', failureCategory: 'THROTTLED' }));
    expect(o).toEqual(view({ status: 'UNKNOWN' }));
  });
});

describe('ticketIssueDueAtMs: 발권 기한 = 승인 시각(occurredAt) + 30분 [가정]', () => {
  test('PT39_occurredAt(Z)에 30분을 더한 epoch ms다', () => {
    expect(TICKET_ISSUE_WINDOW_MS).toBe(30 * MIN);
    expect(ticketIssueDueAtMs(OCCURRED_AT)).toBe(OCCURRED_AT_MS + 30 * MIN);
    expect(ticketIssueDueAtMs('2026-11-05T03:00:00.000Z')).toBe(Date.parse('2026-11-05T03:30:00.000Z'));
  });

  test('PT39_오프셋이 붙은 시각도 같은 순간으로 읽는다(+09:00), 밀리초도 그대로다', () => {
    expect(ticketIssueDueAtMs('2026-11-05T12:00:05.000+09:00')).toBe(OCCURRED_AT_MS + 30 * MIN);
    expect(ticketIssueDueAtMs('2026-11-05T03:00:05.123Z')).toBe(OCCURRED_AT_MS + 123 + 30 * MIN);
  });

  test.each(['', 'not-a-date', '2026-13-45T99:99:99Z'])('PT39_날짜로 읽히지 않는 occurredAt(%j)은 RangeError다', (s) => {
    expect(() => ticketIssueDueAtMs(s)).toThrow(RangeError);
  });
});
