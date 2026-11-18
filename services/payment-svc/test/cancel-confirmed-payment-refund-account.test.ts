// 결제 후 일반 취소의 가상계좌 갈래(P-T71, BUILD_ORDER GAT-090, BAT-420-rest, 시험 담당 l3-b420-test). DB 없이 돈다.
// 정본: docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'(가상계좌였는지·계약·결제 후 일반 취소의 가상계좌 갈래·'구현에서 정한 것' ①~⑤),
// §11 P-T71, docs/api/proto/peaket/payment/v1/payment.proto RefundAccount·CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED·virtual_account_paid.
// 판정(가상계좌 여부·행 있음)은 저장소가 결제 행 잠금 안에서 한다. 여기서는 저장소가 돌려준 판정을 쓰임새가 그대로 쓰는지(결제사 호출·결과·지표),
// 어댑터가 계좌를 결제사 본문 어느 칸에 싣는지(토스 refundReceiveAccount, 포트원 refundAccount), 계좌 모양 규칙의 경계 양쪽을 본다.
// 실제 PostgreSQL·실제 시뮬레이터로 도는 것은 test-int/payment-cancel-refund-account.int.test.ts다.
import { randomBytes, randomUUID } from 'node:crypto';
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PortoneGateway, type PortoneGatewayOptions } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';
import { virtualAccountPaidOf } from '../src/modules/payment/domain/confirm-command.js';
import { refundAccountOf, type CancelResult, type PaymentGatewayPort, type QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import { CancelConfirmedPayment, type ConfirmedCancelBegin, type ConfirmedCancelRecord, type ConfirmedCancelTarget, cancelInputOf, cancelResponseOf, getPaymentResponseOf, PromPaymentDepositSignals } from '../src/modules/payment/server.js';

const NOW = Date.parse('2026-11-19T01:00:00.000Z');
const PAYMENT = '0193a000-0000-7000-8000-000000000102';
const CANCEL = '0193a000-0000-7000-8000-0000000001c1';
/** 계좌 글 누설 검사용 값(다른 값과 겹치지 않게, 계획 §5) */
const ACCOUNT_NO = '110-987-654321';
const ACCOUNT_DIGITS = '110987654321';
const HOLDER = '김환불';
const RAW_ACCOUNT = { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER };

/** 결제 60,000원 · 누적 취소 0원 */
const TARGET: ConfirmedCancelTarget = { paymentId: PAYMENT, orderId: '0193a000-0000-7000-8000-000000000101', eventId: '0193a000-0000-7000-8000-000000000103', pg: 'TOSS', paymentRef: 'tpk_va_1', amount: 60_000, cancelledAmount: 0, status: 'APPROVED' };
const record = (over: Partial<ConfirmedCancelRecord> = {}): ConfirmedCancelRecord => ({
  idemKey: `cancel-${CANCEL}`,
  amount: 25_000,
  reason: '관객 취소',
  fullCancel: false,
  expectedBalance: 60_000,
  status: 'REQUESTED',
  createdAtMs: NOW,
  ...over,
});
const begun = (o: { replay?: boolean; virtualAccount?: boolean; over?: Partial<ConfirmedCancelRecord> } = {}): ConfirmedCancelBegin => ({
  status: 'BEGUN',
  record: record(o.over),
  replay: o.replay ?? false,
  ...(o.virtualAccount === undefined ? {} : { virtualAccount: o.virtualAccount }),
});

type CancelBody = Parameters<PaymentGatewayPort['cancel']>[0];
/** 결제사 조회 답(FOUND) */
const found = (status: 'APPROVED' | 'PARTIAL_CANCELED', balanceAmount: number): QueryResult => ({ kind: 'FOUND', paymentRef: 'tpk_va_1', orderRef: TARGET.orderId, status, amount: 60_000, balanceAmount });

function fixture(o: { begin?: ConfirmedCancelBegin; cancel?: CancelResult; query?: QueryResult; settle?: { status: 'APPLIED'; cancelledAmount: number } | { status: 'RESEND' } | { status: 'UNDECIDABLE' }; signals?: boolean } = {}) {
  const calls: string[] = [];
  const begins: Record<string, unknown>[] = [];
  const cancels: CancelBody[] = [];
  const marks: [string, string][] = [];
  const ignored: string[] = [];
  const gateway = {
    pg: 'TOSS',
    cancel: async (c: CancelBody) => {
      calls.push('cancel');
      cancels.push(c);
      return o.cancel ?? { outcome: 'CANCELLED' };
    },
    query: async () => {
      calls.push('query');
      return o.query ?? { kind: 'UNKNOWN' };
    },
  } as unknown as PaymentGatewayPort;
  const uc = new CancelConfirmedPayment({
    store: {
      readConfirmedCancelTarget: async () => TARGET,
      beginConfirmedCancel: async (_t, q) => {
        calls.push('begin');
        begins.push({ ...q });
        return o.begin ?? begun();
      },
      finishConfirmedCancel: async () => {
        calls.push('finish');
        return { status: 'APPLIED', cancelledAmount: 25_000 };
      },
      markConfirmedCancel: async (_t, id, status) => {
        calls.push('mark');
        marks.push([id, status]);
      },
      settleConfirmedCancelByQuery: async () => {
        calls.push('settle');
        return o.settle ?? { status: 'UNDECIDABLE' };
      },
    },
    gateways: { of: () => gateway },
    guards: { of: () => ({ tryTakeToken: () => true, circuitClosed: () => true }) as never },
    clock: fakeClock({ now: NOW }),
    ...(o.signals === false ? {} : { refundAccountSignals: { refundAccountIgnored: (pg: string) => void ignored.push(pg) } }),
  });
  return { uc, calls, begins, cancels, marks, ignored };
}

const run = (f: ReturnType<typeof fixture>, refundAccount?: { bankCode: string; accountNumber: string; holderName: string }) =>
  f.uc.execute({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '관객 취소', amount: 25_000, ...(refundAccount ? { refundAccount } : {}) });

describe('P-T71 계좌 모양(정본 \'구현에서 정한 것\' ②)', () => {
  test('P-T71 ② 은행 코드 두 자리·계좌번호 숫자 1~20자(하이픈·공백은 뺀다)·예금주 1~60자(앞뒤 공백은 뺀다)만 계좌로 본다. 경계 양쪽', () => {
    expect(refundAccountOf(RAW_ACCOUNT)).toEqual({ bankCode: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER });
    expect(refundAccountOf({ bankCode: '88', accountNumber: '110 987 654321', holderName: `  ${HOLDER}  ` })).toEqual({ bankCode: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER });
    expect(refundAccountOf({ ...RAW_ACCOUNT, accountNumber: '1'.repeat(20) })?.accountNumber).toBe('1'.repeat(20));
    expect(refundAccountOf({ ...RAW_ACCOUNT, accountNumber: '1'.repeat(21) })).toBeUndefined();
    expect(refundAccountOf({ ...RAW_ACCOUNT, accountNumber: '7' })?.accountNumber).toBe('7');
    expect(refundAccountOf({ ...RAW_ACCOUNT, accountNumber: '-' })).toBeUndefined();
    expect(refundAccountOf({ ...RAW_ACCOUNT, accountNumber: '1101a' })).toBeUndefined();
    expect(refundAccountOf({ ...RAW_ACCOUNT, holderName: '가'.repeat(60) })?.holderName).toBe('가'.repeat(60));
    expect(refundAccountOf({ ...RAW_ACCOUNT, holderName: '가'.repeat(61) })).toBeUndefined();
    expect(refundAccountOf({ ...RAW_ACCOUNT, holderName: '   ' })).toBeUndefined();
    expect(refundAccountOf({ ...RAW_ACCOUNT, holderName: '김\u0000환불' })).toBeUndefined();
    for (const bankCode of ['8', '088', 'AB', '']) expect(refundAccountOf({ ...RAW_ACCOUNT, bankCode }), bankCode).toBeUndefined();
    expect(refundAccountOf(undefined)).toBeUndefined();
    expect(refundAccountOf({ bankCode: 88, accountNumber: ACCOUNT_DIGITS, holderName: HOLDER })).toBeUndefined();
  });
});

describe('P-T71 쓰임새의 가상계좌 갈래(저장소 판정을 쓰는 쪽)', () => {
  test('P-T71 ② 저장소가 ACCOUNT_REQUIRED(가상계좌·계좌 없음·행 없음)면 결제사 호출 0이고 REFUND_ACCOUNT_REQUIRED·누적 취소액 0이다', async () => {
    const f = fixture({ begin: { status: 'ACCOUNT_REQUIRED' } });
    await expect(run(f)).resolves.toEqual({ result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: 0 });
    expect(f.calls).toEqual(['begin']);
    expect(f.begins[0]).not.toHaveProperty('hasRefundAccount');
  });

  test('P-T71 ② 모양이 맞는 계좌만 저장소에 hasRefundAccount 참으로 알린다(모양이 틀리면 계좌 없음과 같다)', async () => {
    const good = fixture({ begin: { status: 'ACCOUNT_REQUIRED' } });
    await run(good, RAW_ACCOUNT);
    expect(good.begins[0]).toMatchObject({ hasRefundAccount: true });
    const bad = fixture({ begin: { status: 'ACCOUNT_REQUIRED' } });
    await run(bad, { ...RAW_ACCOUNT, accountNumber: '1'.repeat(21) });
    expect(bad.begins[0]).not.toHaveProperty('hasRefundAccount');
    expect(bad.calls).toEqual(['begin']);
  });

  test('P-T71 ① 가상계좌에 계좌가 있으면 결제사 본문에 하이픈을 뺀 계좌 세 칸이 그대로 실리고 저장한 금액·기대 잔액과 함께 한 번 보낸다', async () => {
    const f = fixture({ begin: begun({ virtualAccount: true }) });
    await expect(run(f, RAW_ACCOUNT)).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 25_000 });
    expect(f.cancels).toEqual([{ paymentRef: 'tpk_va_1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 60_000, refundAccount: { bankCode: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER } }]);
    expect(f.ignored).toEqual([]);
  });

  test('P-T71 ③ 계좌 없는 재시도(행 있음·가상계좌)는 결제사 취소 0·조회 1이고, 조회 대조가 반영이면 CANCELLED(누적 25,000)다', async () => {
    const f = fixture({ begin: begun({ replay: true, virtualAccount: true }), query: found('PARTIAL_CANCELED', 35_000), settle: { status: 'APPLIED', cancelledAmount: 25_000 } });
    await expect(run(f)).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 25_000 });
    expect(f.calls).toEqual(['begin', 'query', 'settle']);
    expect(f.cancels).toHaveLength(0);
  });

  test('P-T71 ③ 조회 대조가 반영 아님(RESEND)이면 REFUND_ACCOUNT_REQUIRED이고 행을 고치지 않는다(mark 0)', async () => {
    const f = fixture({ begin: begun({ replay: true, virtualAccount: true }), query: found('APPROVED', 60_000), settle: { status: 'RESEND' } });
    await expect(run(f)).resolves.toEqual({ result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: 0 });
    expect(f.calls).toEqual(['begin', 'query', 'settle']);
    expect(f.marks).toEqual([]);
  });

  test('P-T71 ③ 세 상태의 가운데: 조회 실패(UNKNOWN)·가를 수 없음(UNDECIDABLE)은 UNKNOWN이고 계좌 대기로 보지 않는다(결제사 취소 0)', async () => {
    const queryFailed = fixture({ begin: begun({ replay: true, virtualAccount: true }), query: { kind: 'UNKNOWN' } });
    await expect(run(queryFailed)).resolves.toMatchObject({ result: 'UNKNOWN' });
    expect(queryFailed.calls).toEqual(['begin', 'query']);
    const undecidable = fixture({ begin: begun({ replay: true, virtualAccount: true }), query: found('PARTIAL_CANCELED', 41_000), settle: { status: 'UNDECIDABLE' } });
    await expect(run(undecidable)).resolves.toMatchObject({ result: 'UNKNOWN' });
    expect(undecidable.cancels).toHaveLength(0);
  });

  test('P-T71 ③ 대조: 계좌를 다시 실은 재시도(같은 멱등키·같은 본문)는 조회 없이 결제사 취소를 한 번 부른다', async () => {
    const f = fixture({ begin: begun({ replay: true, virtualAccount: true }) });
    await expect(run(f, RAW_ACCOUNT)).resolves.toMatchObject({ result: 'CANCELLED' });
    expect(f.calls).toEqual(['begin', 'cancel', 'finish']);
  });

  test('P-T71 ④ 결제사가 계좌를 거절하면(REJECTED·REFUND_ACCOUNT_INVALID) 행을 FAILED로 끝내고 REFUND_ACCOUNT_REQUIRED다. 까닭 없는 거절은 REJECTED다', async () => {
    const rejected = fixture({ begin: begun({ virtualAccount: true }), cancel: { outcome: 'REJECTED', pgCode: 'INVALID_REFUND_ACCOUNT_NUMBER', reason: 'REFUND_ACCOUNT_INVALID' } });
    await expect(run(rejected, RAW_ACCOUNT)).resolves.toEqual({ result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: 0 });
    expect(rejected.marks).toEqual([[CANCEL, 'FAILED']]);
    const plain = fixture({ begin: begun({ virtualAccount: true }), cancel: { outcome: 'REJECTED', pgCode: 'NOT_CANCELABLE_AMOUNT' } });
    await expect(run(plain, RAW_ACCOUNT)).resolves.toEqual({ result: 'REJECTED', cancelledAmount: 0 });
    expect(plain.marks).toEqual([[CANCEL, 'FAILED']]);
  });

  test('P-T71 ⑤ 가상계좌가 아닌 결제에 온 계좌는 결제사 본문에 없고 지표가 결제사 이름표로 1 오른다(계좌 없는 카드 취소는 0)', async () => {
    const card = fixture({ begin: begun({ virtualAccount: false }) });
    await expect(run(card, RAW_ACCOUNT)).resolves.toMatchObject({ result: 'CANCELLED' });
    expect(card.cancels).toHaveLength(1);
    expect(card.cancels[0]).not.toHaveProperty('refundAccount');
    expect(card.ignored).toEqual(['TOSS']);
    const plain = fixture({ begin: begun({ virtualAccount: false }) });
    await run(plain);
    expect(plain.ignored).toEqual([]);
    // 판정 칸이 없는 옛 저장소(virtualAccount 없음)도 가상계좌가 아니라고 본다
    const legacy = fixture({ begin: begun() });
    await run(legacy, RAW_ACCOUNT);
    expect(legacy.cancels[0]).not.toHaveProperty('refundAccount');
    expect(legacy.ignored).toEqual(['TOSS']);
  });

  test('P-T71 ⑤ 지표 payment_cancel_refund_account_ignored_total{pg}은 세 결제사 0으로 미리 보이고 부를 때마다 1 오른다(계좌 값은 이름표에 없다)', async () => {
    const registry = new PlatformMetrics('payment-svc').registry;
    const signals = new PromPaymentDepositSignals().register(registry);
    const text0 = await registry.metrics();
    for (const pg of ['TOSS', 'PORTONE', 'SIMULATOR']) expect(text0).toContain(`payment_cancel_refund_account_ignored_total{pg="${pg}"} 0`);
    signals.refundAccountIgnored('PORTONE');
    const text1 = await registry.metrics();
    expect(text1).toContain('payment_cancel_refund_account_ignored_total{pg="PORTONE"} 1');
    expect(text1).toContain('payment_cancel_refund_account_ignored_total{pg="TOSS"} 0');
    expect(text1).not.toContain(ACCOUNT_DIGITS);
  });
});

describe('P-T71 ⑥ virtual_account_paid 판정', () => {
  test('P-T71 ⑥ AWAITING_DEPOSIT 사건이 있고 원장이 승인·부분 취소·전액 취소일 때만 참이다. 입금 대기·기한 만료(FAILED)·사건 없는 카드는 거짓이다', () => {
    for (const status of ['APPROVED', 'PARTIAL_CANCELED', 'CANCELED'] as const) {
      expect(virtualAccountPaidOf({ status, depositEvent: true }), status).toBe(true);
      expect(virtualAccountPaidOf({ status, depositEvent: false }), `${status} 카드`).toBe(false);
      expect(virtualAccountPaidOf({ status }), `${status} 칸 없음`).toBe(false);
    }
    for (const status of ['AWAITING_DEPOSIT', 'FAILED', 'UNKNOWN', 'ACCEPTED'] as const) expect(virtualAccountPaidOf({ status, depositEvent: true }), status).toBe(false);
  });

  test('P-T71 ⑥ GetPayment 답은 참일 때만 virtual_account_paid를 싣고, CancelPayment 요청의 refund_account 세 칸을 그대로 옮기며 답 결과는 CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED다', () => {
    const base = { paymentId: PAYMENT, orderId: TARGET.orderId, eventId: TARGET.eventId, pg: 'TOSS', status: 'APPROVED', amount: 60_000, cancelledAmount: 0 } as const;
    expect(getPaymentResponseOf({ ...base, virtualAccountPaid: true } as never)).toMatchObject({ virtual_account_paid: true });
    expect(getPaymentResponseOf(base as never)).not.toHaveProperty('virtual_account_paid');
    expect(cancelInputOf({ payment_id: PAYMENT, cancellation_id: CANCEL, reason: '관객 취소', amount: { krw: 25_000 }, refund_account: { bank_code: '88', account_number: ACCOUNT_NO, holder_name: HOLDER } })).toMatchObject({
      refundAccount: { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER },
    });
    expect(cancelInputOf({ payment_id: PAYMENT, cancellation_id: CANCEL, reason: '관객 취소' })).not.toHaveProperty('refundAccount');
    expect(cancelResponseOf({ result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: 0 })).toEqual({ result: 'CANCEL_RESULT_REFUND_ACCOUNT_REQUIRED', cancelled_amount: { krw: 0 } });
  });
});

// ---- 어댑터 본문(실제 결제사 서버는 부르지 않는다. 기록 fetch) ----

type Scripted = { status: number; body?: unknown };
interface Seen {
  url: string;
  body: string;
}
function scriptedFetch(replies: Scripted[], seen: Seen[]): typeof fetch {
  return async (input, init) => {
    seen.push({ url: String(input), body: String(init?.body ?? '') });
    const next = replies.shift();
    if (!next) throw new Error('답을 더 정하지 않았다');
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
}
const ACCOUNT = { bankCode: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER };
const TOSS_SECRET = `test_sk_${randomBytes(12).toString('hex')}`;
const tossOf = (replies: Scripted[], seen: Seen[]) => new TossPaymentGateway({ baseUrl: 'http://pg.test', secretKey: TOSS_SECRET, clientKey: 'test_ck_1', fetch: scriptedFetch(replies, seen) });
const tossCancelled: Scripted = { status: 200, body: { status: 'PARTIAL_CANCELED', orderId: 'o', totalAmount: 60_000, balanceAmount: 35_000, cancels: [{ cancelAmount: 25_000, transactionKey: 'tx-c1' }] } };

describe('P-T71 ① 토스 모양 본문(refundReceiveAccount)', () => {
  test('P-T71 ① 계좌가 있으면 본문 refundReceiveAccount에 bank·accountNumber·holderName이 정확히 실리고, 없으면 그 칸이 없다', async () => {
    const seen: Seen[] = [];
    const g = tossOf([tossCancelled, tossCancelled], seen);
    await g.cancel({ paymentRef: 'tpk_va_1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, refundAccount: ACCOUNT });
    await g.cancel({ paymentRef: 'tpk_va_1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}` });
    expect(JSON.parse(seen[0]!.body)).toEqual({ cancelReason: '관객 취소', cancelAmount: 25_000, refundReceiveAccount: { bank: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER } });
    expect(JSON.parse(seen[1]!.body)).toEqual({ cancelReason: '관객 취소', cancelAmount: 25_000 });
    expect(seen[0]!.url).toBe('http://pg.test/v1/payments/tpk_va_1/cancel');
  });

  test('P-T71 ④ 토스 계좌 거절 코드 다섯은 계좌를 실은 취소에서만 REJECTED·REFUND_ACCOUNT_INVALID이고, 계좌 없는 취소의 같은 코드는 까닭 없는 REJECTED다. 목록 밖 코드는 까닭이 없다', async () => {
    for (const code of ['INVALID_REFUND_ACCOUNT_INFO', 'INVALID_REFUND_ACCOUNT_NUMBER', 'INVALID_BANK', 'FORBIDDEN_BANK_REFUND_REQUEST', 'FAILED_CLOSED_ACCOUNT_REFUND']) {
      const seen: Seen[] = [];
      const g = tossOf(
        [
          { status: 400, body: { code, message: 'x' } },
          { status: 400, body: { code, message: 'x' } },
        ],
        seen,
      );
      await expect(g.cancel({ paymentRef: 'tpk_va_1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}`, refundAccount: ACCOUNT }), code).resolves.toEqual({ outcome: 'REJECTED', pgCode: code, reason: 'REFUND_ACCOUNT_INVALID' });
      await expect(g.cancel({ paymentRef: 'tpk_va_1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}` }), `${code} 계좌 없음`).resolves.toEqual({ outcome: 'REJECTED', pgCode: code });
    }
    const seen: Seen[] = [];
    const other = tossOf([{ status: 400, body: { code: 'NOT_CANCELABLE_AMOUNT', message: 'x' } }], seen);
    await expect(other.cancel({ paymentRef: 'tpk_va_1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}`, refundAccount: ACCOUNT })).resolves.toEqual({ outcome: 'REJECTED', pgCode: 'NOT_CANCELABLE_AMOUNT' });
  });
});

const PORTONE_SECRET = randomBytes(24).toString('hex');
const portoneOf = (replies: Scripted[], seen: Seen[]) =>
  new PortoneGateway({ baseUrl: 'http://pg.test', secret: PORTONE_SECRET, storeId: 'store-1', channelKey: 'channel-1', webhookSecrets: [`whsec_${randomBytes(32).toString('base64')}`], isTest: true, clock: fakeClock({ now: NOW }), fetch: scriptedFetch(replies, seen) } as PortoneGatewayOptions);
const portoneCancelled: Scripted = { status: 200, body: { cancellation: { status: 'SUCCEEDED', id: 'c1', totalAmount: 25_000 } } };

describe('P-T71 ① 포트원 본문(refundAccount)', () => {
  test('P-T71 ① 토스 은행 코드를 포트원 Bank 값으로 바꿔 refundAccount의 bank·number·holderName에 싣는다(88 SHINHAN, 90 KAKAO, 04는 대응표 밖)', async () => {
    const seen: Seen[] = [];
    const g = portoneOf([portoneCancelled, portoneCancelled], seen);
    await g.cancel({ paymentRef: 'pay-va-1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}`, expectedBalance: 60_000, refundAccount: ACCOUNT });
    await g.cancel({ paymentRef: 'pay-va-1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}`, expectedBalance: 35_000, refundAccount: { ...ACCOUNT, bankCode: '90' } });
    expect(JSON.parse(seen[0]!.body)).toEqual({ storeId: 'store-1', reason: '관객 취소', amount: 25_000, currentCancellableAmount: 60_000, refundAccount: { bank: 'SHINHAN', number: ACCOUNT_DIGITS, holderName: HOLDER } });
    expect(JSON.parse(seen[1]!.body).refundAccount).toEqual({ bank: 'KAKAO', number: ACCOUNT_DIGITS, holderName: HOLDER });
  });

  test('P-T71 ④ 포트원 대응표에 없는 은행 코드는 결제사를 부르지 않고 REJECTED·REFUND_ACCOUNT_INVALID다(계좌 거절과 같다)', async () => {
    const seen: Seen[] = [];
    const g = portoneOf([], seen);
    await expect(g.cancel({ paymentRef: 'pay-va-1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}`, expectedBalance: 60_000, refundAccount: { ...ACCOUNT, bankCode: '99' } })).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'REFUND_ACCOUNT_INVALID',
    });
    expect(seen).toHaveLength(0);
  });

  test('P-T71 ① 계좌가 없으면 포트원 본문에 refundAccount 칸이 없다', async () => {
    const seen: Seen[] = [];
    await portoneOf([portoneCancelled], seen).cancel({ paymentRef: 'pay-va-1', amount: 25_000, reason: '관객 취소', idemKey: `cancel-${randomUUID()}`, expectedBalance: 60_000 });
    expect(JSON.parse(seen[0]!.body)).not.toHaveProperty('refundAccount');
  });
});
