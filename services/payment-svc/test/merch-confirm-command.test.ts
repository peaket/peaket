// 굿즈 결제의 승인 명령 입력 검사와 명령 대조(ADR-0299 결정 2, docs/features/payment.md §2 '받는 주문'·§11 P-T55, BAT-600).
// 공개 도메인 함수 parseConfirmPaymentInput·isSameCommand를 바깥 경계로 본다. 실제 PostgreSQL·gRPC는 test-int/payment-merch-grpc.int.test.ts가 본다.
// 값은 정본에서 적는다: 인증 시각 상한 지금 + 5분 [가정](payment.md §2 입력 검사), 원장 금액 상한은 int 칸(2,147,483,647).
import { describe, expect, test } from 'vitest';
import { type ConfirmPaymentInput, isSameCommand, PaymentInputError, parseConfirmPaymentInput } from '../src/modules/payment/domain/confirm-command.js';
import { AUTHENTICATED_AT, commandOf, EVENT_ID, NOW, ORDER_ID, portoneRef, recordOf, thrownBy, tossInput } from './confirm-cases.js';

/** 굿즈 명령: 회차 칸이 비어 있다 */
const merch = (over: Partial<ConfirmPaymentInput> = {}): ConfirmPaymentInput => tossInput({ orderKind: 'MERCH', eventId: '', ...over });
const parse = (input: ConfirmPaymentInput) => parseConfirmPaymentInput(input, NOW);

function fieldOf(fn: () => unknown): string {
  const err = thrownBy(fn);
  expect(err, String(err)).toBeInstanceOf(PaymentInputError);
  return (err as PaymentInputError).field;
}

/** 정본의 인증 시각 상한: 지금 + 5분 */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

describe('굿즈 승인 명령 입력(ADR-0299 결정 2)', () => {
  test('P-T55 ① MERCH에 회차 칸이 비면 받고 명령의 주문 종류는 MERCH, 회차는 null이다 [ASVS v5.0.0-2.2.1]', () => {
    const c = parse(merch());
    expect(c.orderKind).toBe('MERCH');
    expect(c.eventId).toBeNull();
    expect(c).not.toHaveProperty('entryOpensAtMs');
    expect(c).toMatchObject({ orderId: ORDER_ID, amount: 55_000, pg: 'TOSS', authenticatedAtMs: AUTHENTICATED_AT });
  });

  test('P-T55 ③ MERCH에 회차를 실으면 INVALID_ARGUMENT(event_id)다 [ASVS v5.0.0-2.2.1]', () => {
    expect(fieldOf(() => parse(merch({ eventId: EVENT_ID })))).toBe('event_id');
    // 모양이 틀린 회차도 '비어 있지 않음'으로 거절한다
    expect(fieldOf(() => parse(merch({ eventId: 'x' })))).toBe('event_id');
  });

  test('P-T55 ③ MERCH에 입장 시각을 실으면 INVALID_ARGUMENT(entry_opens_at)다 [ASVS v5.0.0-2.2.1]', () => {
    expect(fieldOf(() => parse(merch({ entryOpensAtMs: NOW + 3_600_000 })))).toBe('entry_opens_at');
  });

  test('P-T55 ③ MERCH에 회차와 입장 시각을 둘 다 실어도 거절한다 [ASVS v5.0.0-2.2.1]', () => {
    expect(['event_id', 'entry_opens_at']).toContain(fieldOf(() => parse(merch({ eventId: EVENT_ID, entryOpensAtMs: NOW + 3_600_000 }))));
  });

  test('P-T55 ④ 주문 종류 없이(UNSPECIFIED) 회차 칸이 빈 요청은 티켓 규칙대로 INVALID_ARGUMENT(event_id)다 [ASVS v5.0.0-2.2.1]', () => {
    expect(fieldOf(() => parse(tossInput({ orderKind: 'UNSPECIFIED', eventId: '' })))).toBe('event_id');
    expect(fieldOf(() => parse(tossInput({ eventId: '' })))).toBe('event_id');
    expect(fieldOf(() => parse(tossInput({ orderKind: '', eventId: '' })))).toBe('event_id');
    expect(fieldOf(() => parse(tossInput({ orderKind: 'TICKET', eventId: '' })))).toBe('event_id');
  });

  test('P-T55 ④ UNSPECIFIED에 회차가 있으면 티켓 명령으로 받는다(지금 purchase-svc는 칸을 보내지 않는다)', () => {
    for (const orderKind of [undefined, 'UNSPECIFIED', 'TICKET']) {
      const c = parse(tossInput(orderKind === undefined ? {} : { orderKind }));
      expect(c.orderKind, String(orderKind)).toBe('TICKET');
      expect(c.eventId, String(orderKind)).toBe(EVENT_ID);
    }
  });

  test('P-T55 ④ 목록 밖의 주문 종류는 값마다 INVALID_ARGUMENT(order_kind)다 [ASVS v5.0.0-2.2.1]', () => {
    for (const orderKind of ['UNRECOGNIZED', 'GIFT', 'merch', 'ORDER_KIND_MERCH', ' MERCH']) {
      expect(fieldOf(() => parse(merch({ orderKind }))), orderKind).toBe('order_kind');
    }
  });

  test('P-T55 ③ MERCH도 티켓과 같은 입력 검사를 한다: 소문자 UUID·금액·시도 순번 [ASVS v5.0.0-2.2.1]', () => {
    expect(fieldOf(() => parse(merch({ orderId: ORDER_ID.toUpperCase() })))).toBe('order_id');
    expect(fieldOf(() => parse(merch({ attemptId: 'attempt' })))).toBe('attempt_id');
    expect(fieldOf(() => parse(merch({ amount: 0 })))).toBe('amount');
    expect(fieldOf(() => parse(merch({ amount: 1.5 })))).toBe('amount');
    expect(fieldOf(() => parse(merch({ amount: 2_147_483_648 })))).toBe('amount');
    expect(parse(merch({ amount: 2_147_483_647 })).amount).toBe(2_147_483_647);
    expect(parse(merch({ amount: 1 })).amount).toBe(1);
    expect(fieldOf(() => parse(merch({ attemptNo: 0 })))).toBe('attempt_no');
  });

  test('P-T55 ③ MERCH의 인증 시각 상한은 지금 + 5분이다(경계 양쪽) [ASVS v5.0.0-2.2.1]', () => {
    expect(parse(merch({ authenticatedAtMs: NOW + FIVE_MINUTES_MS })).authenticatedAtMs).toBe(NOW + FIVE_MINUTES_MS);
    expect(fieldOf(() => parse(merch({ authenticatedAtMs: NOW + FIVE_MINUTES_MS + 1 })))).toBe('authenticated_at');
    expect(fieldOf(() => parse(merch({ authenticatedAtMs: 0 })))).toBe('authenticated_at');
    expect(fieldOf(() => parse(merch({ authenticatedAtMs: undefined })))).toBe('authenticated_at');
  });

  test('P-T55 ③ MERCH의 결제 참조도 결제사와 짝이 맞아야 하고 포트원 paymentId는 pay-{주문 ID}다 [ASVS v5.0.0-2.2.3]', () => {
    // TOSS에 포트원 참조, 포트원에 토스 참조
    expect(() => parse(merch({ paymentRef: portoneRef() }))).toThrow(PaymentInputError);
    expect(() => parse(merch({ pg: 'PORTONE' }))).toThrow(PaymentInputError);
    expect(() => parse(merch({ pg: 'PORTONE', paymentRef: portoneRef({ paymentId: 'pay-other' }) }))).toThrow(PaymentInputError);
    expect(parse(merch({ pg: 'PORTONE', paymentRef: portoneRef() })).paymentRef).toEqual(portoneRef());
    expect(() => parse(merch({ paymentRef: undefined }))).toThrow(PaymentInputError);
  });
});

describe('굿즈 명령 대조(ADR-0299 결정 2: attempt_id·pg·amount·order_kind)', () => {
  test('P-T55 ② 같은 주문을 같은 MERCH 명령으로 다시 부르면 같은 명령이다', () => {
    expect(isSameCommand(recordOf({ orderKind: 'MERCH' }), commandOf({ orderKind: 'MERCH', eventId: null }))).toBe(true);
  });

  test('P-T55 ② MERCH로 적힌 결제를 TICKET으로 다시 부르면 다른 명령이다(그 반대도) [ASVS v5.0.0-2.3.4]', () => {
    expect(isSameCommand(recordOf({ orderKind: 'MERCH' }), commandOf({ orderKind: 'TICKET' }))).toBe(false);
    expect(isSameCommand(recordOf({ orderKind: 'TICKET' }), commandOf({ orderKind: 'MERCH', eventId: null }))).toBe(false);
  });

  test('P-T55 ② 주문 종류가 없는 옛 원장 값은 TICKET으로 견준다', () => {
    expect(isSameCommand(recordOf(), commandOf({ orderKind: 'TICKET' }))).toBe(true);
    expect(isSameCommand(recordOf(), commandOf({ orderKind: 'MERCH', eventId: null }))).toBe(false);
  });

  test('P-T55 ② 주문 종류가 같아도 시도·결제사·금액이 다르면 다른 명령이다', () => {
    const rec = recordOf({ orderKind: 'MERCH' });
    expect(isSameCommand(rec, commandOf({ orderKind: 'MERCH', eventId: null, amount: 55_001 }))).toBe(false);
    expect(isSameCommand(rec, commandOf({ orderKind: 'MERCH', eventId: null, pg: 'PORTONE' }))).toBe(false);
    expect(isSameCommand(rec, commandOf({ orderKind: 'MERCH', eventId: null, attemptId: '0193a1b2-c3d4-7e5f-8a6b-1234567890ff' }))).toBe(false);
  });
});
