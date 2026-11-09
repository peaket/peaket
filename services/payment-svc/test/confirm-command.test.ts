// 승인 명령 접수의 값과 규칙(docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180, P-T53·P-T54).
// 입력 검사(parseConfirmPaymentInput·parseBatchGetOrderIds), 명령 대조(isSameCommand), 원장 → 답(confirmAnswerOf)을 순수 함수로 본다.
import { describe, expect, test } from 'vitest';
import {
  AUTHENTICATED_AT_MAX_FUTURE_MS,
  BATCH_GET_MAX_ORDERS,
  type ConfirmAnswerResult,
  confirmAnswerOf,
  type ConfirmPaymentCommand,
  type ConfirmPaymentInput,
  isSameCommand,
  PAYMENT_AMOUNT_MAX,
  PAYMENT_LEDGER_STATUSES,
  PAYMENT_REF_MAX_LENGTH,
  type PaymentLedgerStatus,
  PaymentInputError,
  parseBatchGetOrderIds,
  parseConfirmPaymentInput,
} from '../src/modules/payment/domain/confirm-command.js';
import {
  ATTEMPT_ID,
  AUTHENTICATED_AT,
  commandOf,
  EVENT_ID,
  NOW,
  ORDER_ID,
  OTHER_ATTEMPT_ID,
  PAYMENT_ID,
  portoneInput,
  portoneRef,
  recordOf,
  SECRET_PAYMENT_KEY,
  SECRET_PAYMENT_TOKEN,
  thrownBy,
  tossInput,
  TX_ID,
  uuidAt,
} from './confirm-cases.js';

/** 시계를 NOW로 고정한 입력 검사 */
const parseAt = (input: ConfirmPaymentInput): ConfirmPaymentCommand => parseConfirmPaymentInput(input, NOW);

/** 결제 참조가 틀렸을 때 field로 올 수 있는 proto 칸 이름(정본이 어느 칸인지까지는 정하지 않았다) */
const REF_FIELDS = ['payment_ref', 'pg', 'toss', 'portone', 'payment_key', 'payment_id', 'tx_id', 'payment_token'];

/** 입력 오류의 field를 돌려준다(PaymentInputError가 아니면 실패) */
function fieldOf(fn: () => unknown): string {
  const err = thrownBy(fn);
  expect(err, String(err)).toBeInstanceOf(PaymentInputError);
  return (err as PaymentInputError).field;
}

/** 오류에서 밖으로 보일 수 있는 글 전부 */
function textOf(err: unknown): string {
  expect(err, String(err)).toBeInstanceOf(PaymentInputError);
  const e = err as PaymentInputError;
  return [e.message, e.field, String(e), JSON.stringify(e), e.stack ?? ''].join('\n');
}

describe('parseConfirmPaymentInput: 받는 값', () => {
  test('P-T53_토스 명령을 그대로 검사를 마친 명령으로 돌려준다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseAt(tossInput())).toEqual({
      orderId: ORDER_ID,
      attemptId: ATTEMPT_ID,
      attemptNo: 1,
      eventId: EVENT_ID,
      pg: 'TOSS',
      paymentRef: { kind: 'toss', paymentKey: SECRET_PAYMENT_KEY },
      amount: 55_000,
      authenticatedAtMs: AUTHENTICATED_AT,
    });
  });

  test('P-T53_포트원 명령은 paymentId·txId·paymentToken을 그대로 싣는다 [ASVS v5.0.0-2.2.3]', () => {
    expect(parseAt(portoneInput()).paymentRef).toEqual({ kind: 'portone', paymentId: `pay-${ORDER_ID}`, txId: TX_ID, paymentToken: SECRET_PAYMENT_TOKEN });
  });

  test('P-T53_시뮬레이터는 토스 칸의 참조로 받는다 [ASVS v5.0.0-2.2.3]', () => {
    const c = parseAt(tossInput({ pg: 'SIMULATOR' }));
    expect(c.pg).toBe('SIMULATOR');
    expect(c.paymentRef).toEqual({ kind: 'toss', paymentKey: SECRET_PAYMENT_KEY });
  });

  test('P-T53_UUID는 판(버전)과 상관없이 소문자 모양이면 받는다(UUIDv7 주문·v4 값) [ASVS v5.0.0-2.2.1]', () => {
    const v4 = '3f2b8c1e-9a4d-4e7b-b1c3-0d9e8f7a6b5c';
    expect(parseAt(tossInput({ eventId: v4 })).eventId).toBe(v4);
  });

  test('P-T53_금액은 1원과 원장 칸 상한까지 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(PAYMENT_AMOUNT_MAX).toBe(2_147_483_647);
    expect(parseAt(tossInput({ amount: 1 })).amount).toBe(1);
    expect(parseAt(tossInput({ amount: PAYMENT_AMOUNT_MAX })).amount).toBe(PAYMENT_AMOUNT_MAX);
  });

  test('P-T53_attempt_no는 1 이상의 정수를 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseAt(tossInput({ attemptNo: 1 })).attemptNo).toBe(1);
    expect(parseAt(tossInput({ attemptNo: 7 })).attemptNo).toBe(7);
  });

  test.each([
    ['1자', 'a'],
    ['상한 길이', 'k'.repeat(PAYMENT_REF_MAX_LENGTH)],
    ['보이는 ASCII의 양 끝(0x21·0x7E)', '!~'],
  ])('P-T53_결제 참조 값은 %s를 받는다 [ASVS v5.0.0-2.2.1]', (_name, value) => {
    expect(PAYMENT_REF_MAX_LENGTH).toBe(200);
    expect(parseAt(tossInput({ paymentRef: { kind: 'toss', paymentKey: value } })).paymentRef).toEqual({ kind: 'toss', paymentKey: value });
    const ok = parseAt(portoneInput({ paymentRef: portoneRef({ txId: value, paymentToken: value }) }));
    expect(ok.paymentRef).toEqual(portoneRef({ txId: value, paymentToken: value }));
  });
});

describe('parseConfirmPaymentInput: 거절', () => {
  const NOT_UUIDS = [
    ['대문자', ORDER_ID.toUpperCase()],
    ['빈 값', ''],
    ['붙임표 없음', ORDER_ID.replace(/-/g, '')],
    ['글자 수 모자람', ORDER_ID.slice(0, -1)],
    ['16진수 밖 글자', `${ORDER_ID.slice(0, -1)}g`],
    ['앞뒤 공백', ` ${ORDER_ID}`],
    ['뒤 줄바꿈', `${ORDER_ID}\n`],
  ] as const;

  test.each(NOT_UUIDS)('P-T53_order_id가 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, value) => {
    expect(fieldOf(() => parseAt(tossInput({ orderId: value })))).toBe('order_id');
  });

  test.each(NOT_UUIDS)('P-T53_attempt_id가 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, value) => {
    expect(fieldOf(() => parseAt(tossInput({ attemptId: value })))).toBe('attempt_id');
  });

  test.each(NOT_UUIDS)('P-T53_event_id가 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, value) => {
    expect(fieldOf(() => parseAt(tossInput({ eventId: value })))).toBe('event_id');
  });

  test.each([
    ['0원', 0],
    ['음수', -1],
    ['소수', 1000.5],
    ['원장 칸 상한 + 1', PAYMENT_AMOUNT_MAX + 1],
    ['칸 없음(NaN)', Number.NaN],
    ['무한대', Number.POSITIVE_INFINITY],
  ])('P-T53_금액이 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, amount) => {
    expect(fieldOf(() => parseAt(tossInput({ amount })))).toMatch(/^amount/);
  });

  test.each([
    ['0(칸 없음)', 0],
    ['음수', -1],
    ['소수', 1.5],
    ['NaN', Number.NaN],
  ])('P-T53_attempt_no가 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, attemptNo) => {
    expect(fieldOf(() => parseAt(tossInput({ attemptNo })))).toBe('attempt_no');
  });

  test.each([
    ['칸 없음', undefined],
    ['NaN', Number.NaN],
    ['무한대', Number.POSITIVE_INFINITY],
  ])('P-T53_authenticated_at이 %s이면 거절한다(승인 기한의 기준) [ASVS v5.0.0-2.2.1]', (_name, authenticatedAtMs) => {
    expect(fieldOf(() => parseAt(tossInput({ authenticatedAtMs })))).toBe('authenticated_at');
  });

  test('P-T53_리뷰 고침 L8: 인증 시각 상한은 지금 + 5분 [가정]이고 그 시각까지는 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(AUTHENTICATED_AT_MAX_FUTURE_MS).toBe(300_000);
    expect(parseAt(tossInput({ authenticatedAtMs: NOW + 300_000 })).authenticatedAtMs).toBe(NOW + 300_000);
  });

  test.each([
    ['지금 + 5분 + 1ms', NOW + 300_001],
    ['하루 뒤', NOW + 86_400_000],
    ['연도 10000 이상', Date.UTC(10_000, 0, 1)],
    ['Date가 나타내지 못하는 값', 8_640_000_000_000_001],
  ])('P-T53_리뷰 고침 L8: authenticated_at이 %s이면 거절한다(저장·기한 계산에 쓸 수 없다) [ASVS v5.0.0-2.2.1]', (_name, authenticatedAtMs) => {
    expect(fieldOf(() => parseAt(tossInput({ authenticatedAtMs })))).toBe('authenticated_at');
  });

  test.each(['UNSPECIFIED', '', 'KAKAO', 'toss', 'Toss'])('P-T53_pg가 %j이면 거절한다(허용 목록은 TOSS·PORTONE·SIMULATOR) [ASVS v5.0.0-2.2.1]', (pg) => {
    expect(fieldOf(() => parseAt(tossInput({ pg })))).toBe('pg');
  });

  test('P-T53_결제 참조가 없으면 거절한다 [ASVS v5.0.0-2.2.1]', () => {
    expect(REF_FIELDS).toContain(fieldOf(() => parseAt(tossInput({ paymentRef: undefined }))));
  });

  test.each([
    ['TOSS에 포트원 참조', 'TOSS', 'portone'],
    ['SIMULATOR에 포트원 참조', 'SIMULATOR', 'portone'],
    ['PORTONE에 토스 참조', 'PORTONE', 'toss'],
  ] as const)('P-T53_%s면 거절한다(결제사와 참조의 짝) [ASVS v5.0.0-2.2.3]', (_name, pg, kind) => {
    const paymentRef = kind === 'portone' ? portoneRef() : ({ kind: 'toss', paymentKey: SECRET_PAYMENT_KEY } as const);
    expect(REF_FIELDS).toContain(fieldOf(() => parseAt(tossInput({ pg, paymentRef }))));
  });

  const BAD_REF_VALUES = [
    ['빈 값', ''],
    ['상한 길이 + 1', 'k'.repeat(PAYMENT_REF_MAX_LENGTH + 1)],
    ['공백(0x20)', 'a b'],
    ['제어 문자 DEL(0x7F)', 'a\u007Fb'],
    ['줄바꿈(로그 줄 위조)', 'a\nb'],
    ['한글', '결제키'],
  ] as const;

  test.each(BAD_REF_VALUES)('P-T53_토스 paymentKey가 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, paymentKey) => {
    expect(REF_FIELDS).toContain(fieldOf(() => parseAt(tossInput({ paymentRef: { kind: 'toss', paymentKey } }))));
  });

  test.each(BAD_REF_VALUES)('P-T53_포트원 txId가 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, txId) => {
    expect(REF_FIELDS).toContain(fieldOf(() => parseAt(portoneInput({ paymentRef: portoneRef({ txId }) }))));
  });

  test.each(BAD_REF_VALUES)('P-T53_포트원 paymentToken이 %s이면 거절한다 [ASVS v5.0.0-2.2.1]', (_name, paymentToken) => {
    expect(REF_FIELDS).toContain(fieldOf(() => parseAt(portoneInput({ paymentRef: portoneRef({ paymentToken }) }))));
  });

  test.each([
    ['다른 주문의 값', `pay-${uuidAt(9)}`],
    ['앞머리 없음', ORDER_ID],
    ['대문자 주문', `pay-${ORDER_ID.toUpperCase()}`],
    ['앞머리 대문자', `PAY-${ORDER_ID}`],
    ['뒤에 덧붙임', `pay-${ORDER_ID}x`],
  ])('P-T53_포트원 paymentId가 %s이면 거절한다(pay-{order_id}) [ASVS v5.0.0-2.2.3]', (_name, paymentId) => {
    expect(REF_FIELDS).toContain(fieldOf(() => parseAt(portoneInput({ paymentRef: portoneRef({ paymentId }) }))));
  });
});

describe('parseConfirmPaymentInput: 오류 글에 값을 싣지 않는다', () => {
  test('P-T53_글은 칸 이름만 싣는다(입력이 틀렸다: order_id) [ASVS v5.0.0-16.2.5]', () => {
    const err = thrownBy(() => parseAt(tossInput({ orderId: 'NOT-A-UUID-VALUE' }))) as PaymentInputError;
    expect(err).toBeInstanceOf(PaymentInputError);
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toBe('입력이 틀렸다: order_id');
    expect(textOf(err)).not.toContain('NOT-A-UUID-VALUE');
  });

  test.each([
    ['토스 paymentKey', () => tossInput({ paymentRef: { kind: 'toss', paymentKey: `${SECRET_PAYMENT_KEY} ` } }), SECRET_PAYMENT_KEY],
    ['포트원 paymentToken', () => portoneInput({ paymentRef: portoneRef({ paymentToken: `${SECRET_PAYMENT_TOKEN} ` }) }), SECRET_PAYMENT_TOKEN],
    ['포트원 txId', () => portoneInput({ paymentRef: portoneRef({ txId: `${TX_ID} ` }) }), TX_ID],
    ['포트원 paymentId(틀린 주문)', () => portoneInput({ paymentRef: portoneRef({ paymentId: 'pay-SECRET-OTHER' }) }), 'SECRET-OTHER'],
  ])('P-T53_틀린 %s의 값이 오류 어디에도 없다 [ASVS v5.0.0-16.2.5]', (_name, input, secret) => {
    expect(textOf(thrownBy(() => parseAt(input())))).not.toContain(secret);
  });

  test('P-T53_다른 칸이 틀려 거절할 때도 멀쩡한 결제 키·토큰을 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const text = textOf(thrownBy(() => parseAt(portoneInput({ amount: 0 }))));
    expect(text).not.toContain(SECRET_PAYMENT_TOKEN);
    expect(text).not.toContain(TX_ID);
  });
});

describe('isSameCommand', () => {
  test('P-T53_attempt_id·pg·금액이 모두 같으면 같은 명령이다 [ASVS v5.0.0-2.2.3]', () => {
    expect(isSameCommand(recordOf(), commandOf())).toBe(true);
  });

  test.each([
    ['attempt_id', commandOf({ attemptId: OTHER_ATTEMPT_ID })],
    ['pg', commandOf({ pg: 'SIMULATOR' })],
    ['금액(1원 차이)', commandOf({ amount: 55_001 })],
  ])('P-T53_%s가 다르면 다른 명령이다 [ASVS v5.0.0-2.2.3]', (_name, command) => {
    expect(isSameCommand(recordOf(), command)).toBe(false);
  });

  test('P-T53_결제 참조만 다른 다시 보내기는 같은 명령이다(대조는 attempt_id·pg·금액 셋뿐) [ASVS v5.0.0-2.3.4]', () => {
    expect(isSameCommand(recordOf(), commandOf({ paymentRef: { kind: 'toss', paymentKey: 'other-key' } }))).toBe(true);
  });

  test.each(PAYMENT_LEDGER_STATUSES)('P-T53_원장 상태가 %s여도 대조 결과는 그 세 칸으로만 정한다 [ASVS v5.0.0-2.3.4]', (status) => {
    expect(isSameCommand(recordOf({ status }), commandOf())).toBe(true);
    expect(isSameCommand(recordOf({ status }), commandOf({ amount: 1 }))).toBe(false);
  });
});

describe('confirmAnswerOf(원장 → 답)', () => {
  const TABLE: readonly (readonly [PaymentLedgerStatus, ConfirmAnswerResult])[] = [
    ['ACCEPTED', 'IN_PROGRESS'],
    ['UNKNOWN', 'IN_PROGRESS'],
    ['APPROVED', 'APPROVED'],
    ['PARTIAL_CANCELED', 'APPROVED'],
    ['CANCELED', 'APPROVED'],
    ['FAILED', 'DECLINED'],
    ['AWAITING_DEPOSIT', 'WAITING_FOR_DEPOSIT'],
  ];

  test('P-T53_답 표는 원장 상태 일곱을 모두 덮는다', () => {
    expect(TABLE.map(([s]) => s).sort()).toEqual([...PAYMENT_LEDGER_STATUSES].sort());
  });

  test.each(TABLE)('P-T53_%s면 %s이고 paymentId를 늘 싣는다', (status, result) => {
    expect(confirmAnswerOf(recordOf({ status }))).toEqual({ result, paymentId: PAYMENT_ID });
  });

  test.each(['APPROVED', 'PARTIAL_CANCELED', 'CANCELED'] as const)('P-T53_%s의 승인 시각을 싣는다', (status) => {
    expect(confirmAnswerOf(recordOf({ status, approvedAtMs: 1_794_200_000_123 }))).toEqual({ result: 'APPROVED', paymentId: PAYMENT_ID, approvedAtMs: 1_794_200_000_123 });
  });

  test('P-T53_FAILED는 실패 범주가 있으면 함께 싣는다', () => {
    expect(confirmAnswerOf(recordOf({ status: 'FAILED', failureCategory: 'CARD_DECLINED' }))).toEqual({ result: 'DECLINED', paymentId: PAYMENT_ID, failureCategory: 'CARD_DECLINED' });
  });

  test('P-T53_승인 시각이 비었으면 답에도 없다', () => {
    expect(confirmAnswerOf(recordOf({ status: 'ACCEPTED' })).approvedAtMs).toBeUndefined();
  });
});

describe('parseBatchGetOrderIds', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => uuidAt(i + 1));

  test('P-T54_1건을 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseBatchGetOrderIds([ORDER_ID])).toEqual([ORDER_ID]);
  });

  test('P-T54_상한 100건을 받는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(BATCH_GET_MAX_ORDERS).toBe(100);
    expect(parseBatchGetOrderIds(ids(100)).sort()).toEqual(ids(100).sort());
  });

  test.each([
    ['0건', []],
    ['101건', ids(101)],
    ['대문자', [ORDER_ID.toUpperCase()]],
    ['빈 값', ['']],
    ['모양이 틀림', ['not-a-uuid']],
    ['하나만 틀림', [ORDER_ID, 'x']],
  ] as const)('P-T54_%s이면 거절한다(field order_ids) [ASVS v5.0.0-2.2.1]', (_name, input) => {
    expect(fieldOf(() => parseBatchGetOrderIds(input))).toBe('order_ids');
  });

  test('P-T54_같은 ID는 합친다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseBatchGetOrderIds([ORDER_ID, uuidAt(1), ORDER_ID]).sort()).toEqual([ORDER_ID, uuidAt(1)].sort());
  });

  test('P-T54_상한은 합치기 전의 건수로 본다(같은 ID 101건은 거절) [ASVS v5.0.0-2.2.1]', () => {
    expect(fieldOf(() => parseBatchGetOrderIds(Array.from({ length: 101 }, () => ORDER_ID)))).toBe('order_ids');
  });

  test('P-T54_입력을 바꾸지 않는다', () => {
    const input = [ORDER_ID, ORDER_ID];
    parseBatchGetOrderIds(input);
    expect(input).toEqual([ORDER_ID, ORDER_ID]);
  });

  test('P-T54_오류 글에 받은 값을 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const text = textOf(thrownBy(() => parseBatchGetOrderIds(['SECRET-LOOKING-VALUE'])));
    expect(text).not.toContain('SECRET-LOOKING-VALUE');
  });
});
