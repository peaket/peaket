// 가상계좌 입금 확인의 규칙과 쓰임새(docs/features/payment.md §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151, P-T9·P-T36). DB 없이 돈다. 실제 PostgreSQL·시뮬레이터는 test-int/payment-deposit.int.test.ts다.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createPlatformLogger, type Database, fakeClock, PlatformMetrics } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, test, vi } from 'vitest';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';
import type { PaymentGatewayPort, PgName, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import type { PaymentDepositLog, PaymentDepositSignals, PaymentWebhookLog, PaymentWebhookStore, WebhookReceiveRequest, WebhookReceiveResult } from '../src/modules/payment/domain/ports.js';
import {
  buildPaymentEvent,
  decideDepositCallback,
  decideQueryAnswer,
  decideWebhookLedger,
  DEPOSIT_NO_DUE_RECHECK_MS,
  DEPOSIT_NOTIFIED_WINDOW_MS,
  DEPOSIT_PAST_DUE_DELAY_MS,
  DEPOSIT_QUERY_GRACE_MS,
  depositExpired,
  depositNextQueryAtMs,
  depositSecretHashOf,
  depositSecretMatches,
  depositWriteOf,
  DrizzleWebhookStore,
  GetPaymentDetail,
  getPaymentResponseOf,
  LocalVirtualAccountCipher,
  NoKeyVirtualAccountCipher,
  orderPaymentStateOf,
  parseGetPaymentKey,
  PaymentInputError,
  PaymentNotFoundError,
  paymentDepositLog,
  paymentWebhookLog,
  type PaymentWebhookOutcome,
  portoneVirtualAccountOf,
  PromPaymentDepositSignals,
  paymentUnknownLog,
  ReceivePaymentWebhook,
  tossVirtualAccountOf,
  type VirtualAccountCipher,
  virtualAccountCipherFromEnv,
  type WebhookLedgerRow,
  withLateDepositCheck,
} from '../src/modules/payment/server.js';

const NOW = Date.parse('2026-11-09T01:00:00.000Z');
const DUE = Date.parse('2026-11-12T01:00:00.000Z');
const AMOUNT = 10_000;
const ORDER = '0193a000-0000-7000-8000-000000000001';
const PAYMENT = '0193a000-0000-7000-8000-000000000002';
const ACCOUNT = `0${randomBytes(6).toString('hex')}`.replace(/[a-f]/g, '7');
const SECRET = `dep_${randomBytes(12).toString('hex')}`;

const tossBody = (over: Record<string, unknown> = {}) => ({
  status: 'WAITING_FOR_DEPOSIT',
  orderId: ORDER,
  totalAmount: AMOUNT,
  balanceAmount: AMOUNT,
  method: '가상계좌',
  secret: SECRET,
  virtualAccount: { accountNumber: ACCOUNT, bankCode: '20', customerName: '구매자', dueDate: '2026-11-12T10:00:00+09:00', expired: false },
  ...over,
});
const jsonFetch = (replies: unknown[]): typeof fetch => {
  let i = 0;
  return (async () => new Response(JSON.stringify(replies[i++]), { status: 200 })) as unknown as typeof fetch;
};
const toss = (replies: unknown[]) => new TossPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_test', clientKey: 'sim_ck_test', fetch: jsonFetch(replies) });
const CONFIRM = { orderId: ORDER, paymentRef: 'tgen_1', amount: AMOUNT, idemKey: `confirm-${ORDER}` };

describe('어댑터가 발급 정보를 읽는다', () => {
  test('P-T36_토스 응답의 virtualAccount·secret에서 읽는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(tossVirtualAccountOf(tossBody())).toEqual({ accountNumber: ACCOUNT, bank: '20', dueAt: '2026-11-12T10:00:00+09:00', secret: SECRET });
  });

  test('P-T36_토스의 기한·secret이 없으면 그 칸만 없다', () => {
    expect(tossVirtualAccountOf(tossBody({ secret: undefined, virtualAccount: { accountNumber: ACCOUNT, bankCode: '20' } }))).toEqual({ accountNumber: ACCOUNT, bank: '20' });
  });

  test.each([
    ['계좌번호 없음', { virtualAccount: { bankCode: '20' } }, { bank: '20', secret: SECRET }],
    ['은행 없음', { virtualAccount: { accountNumber: ACCOUNT } }, { accountNumber: ACCOUNT, secret: SECRET }],
    ['virtualAccount 없음', { virtualAccount: null }, { secret: SECRET }],
    ['계좌번호 모양이 틀림', { virtualAccount: { accountNumber: 'a b\n', bankCode: '20' } }, { bank: '20', secret: SECRET }],
    ['은행 모양이 틀림', { virtualAccount: { accountNumber: ACCOUNT, bankCode: 'x'.repeat(100) } }, { accountNumber: ACCOUNT, secret: SECRET }],
    ['secret 모양이 틀림', { secret: 'a b', virtualAccount: { accountNumber: ACCOUNT, bankCode: '20' } }, { accountNumber: ACCOUNT, bank: '20' }],
  ])('P-T36_리뷰 고침 M5: 틀린 칸만 버리고 나머지는 남긴다: %s [ASVS v5.0.0-2.2.1]', (_name, over, expected) => {
    expect(tossVirtualAccountOf(tossBody(over))).toEqual(expected);
  });

  test('P-T36_리뷰 고침 M5: 모든 칸이 틀리면 발급 정보가 없다 [ASVS v5.0.0-2.2.1]', () => {
    expect(tossVirtualAccountOf(tossBody({ secret: undefined, virtualAccount: null }))).toBeUndefined();
  });

  test('P-T36_리뷰 고침 M5: 포트원도 틀린 칸만 버린다', () => {
    expect(portoneVirtualAccountOf({ type: 'PaymentMethodVirtualAccount', bank: 'x y', accountNumber: ACCOUNT, expiredAt: 'soon' })).toEqual({ accountNumber: ACCOUNT });
  });

  test('P-T36_리뷰 고침 L9: 토스 dueDate에 시간대가 없으면 KST로 읽는다', () => {
    const va = tossVirtualAccountOf(tossBody({ virtualAccount: { accountNumber: ACCOUNT, bankCode: '20', dueDate: '2026-11-12T10:00:00' } }));
    expect(va?.dueAt).toBe('2026-11-12T10:00:00+09:00');
    expect(Date.parse(va!.dueAt!)).toBe(Date.parse('2026-11-12T01:00:00.000Z'));
  });

  test('P-T36_리뷰 고침 L9: 시간대가 있는 값은 그대로다', () => {
    expect(tossVirtualAccountOf(tossBody({ virtualAccount: { accountNumber: ACCOUNT, bankCode: '20', dueDate: '2026-11-12T01:00:00Z' } }))?.dueAt).toBe('2026-11-12T01:00:00Z');
  });

  test('P-T36_리뷰 고침 L10: 포트원 승인 답에 paidAt이 없어도 입금 대기를 받는다', async () => {
    const id = `pay-${ORDER}`;
    const view = { status: 'VIRTUAL_ACCOUNT_ISSUED', id, amount: { total: AMOUNT, paid: 0, cancelled: 0 }, method: { type: 'PaymentMethodVirtualAccount', bank: 'SHINHAN', accountNumber: ACCOUNT, expiredAt: '2026-11-12T01:00:00Z' } };
    const g = new PortoneGateway({ baseUrl: 'http://pg.test', secret: 'sec', storeId: 's', channelKey: 'c', webhookSecrets: [], isTest: true, clock: fakeClock({ now: NOW }), fetch: jsonFetch([{ pgTxId: 'pgtx' }, view]) });
    await expect(g.confirm({ orderId: ORDER, paymentRef: id, amount: AMOUNT, idemKey: `confirm-${ORDER}`, confirmToken: 'tok' })).resolves.toMatchObject({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: id, amount: AMOUNT });
  });

  test('P-T16_리뷰 고침 L10: 포트원 승인 답에 paidAt이 없으면 승인으로는 받지 않는다', async () => {
    const id = `pay-${ORDER}`;
    const view = { status: 'PAID', id, amount: { total: AMOUNT, paid: AMOUNT, cancelled: 0 }, paidAt: '2026-11-09T01:00:00Z', method: { type: 'PaymentMethodCard' } };
    const g = new PortoneGateway({ baseUrl: 'http://pg.test', secret: 'sec', storeId: 's', channelKey: 'c', webhookSecrets: [], isTest: true, clock: fakeClock({ now: NOW }), fetch: jsonFetch([{ pgTxId: 'pgtx' }, view]) });
    await expect(g.confirm({ orderId: ORDER, paymentRef: id, amount: AMOUNT, idemKey: `confirm-${ORDER}`, confirmToken: 'tok' })).resolves.toEqual({ outcome: 'UNKNOWN', paymentRef: id });
  });

  test('P-T36_토스 기한이 날짜가 아니면 기한 칸만 뺀다', () => {
    expect(tossVirtualAccountOf(tossBody({ virtualAccount: { accountNumber: ACCOUNT, bankCode: '20', dueDate: 'soon' } }))).toEqual({ accountNumber: ACCOUNT, bank: '20', secret: SECRET });
  });

  test('P-T36_포트원 method에서 읽고 secret이 없다', () => {
    expect(portoneVirtualAccountOf({ type: 'PaymentMethodVirtualAccount', bank: 'SHINHAN', accountNumber: ACCOUNT, expiredAt: '2026-11-12T01:00:00Z' })).toEqual({ accountNumber: ACCOUNT, bank: 'SHINHAN', dueAt: '2026-11-12T01:00:00Z' });
  });

  test('P-T36_포트원 공식 스키마처럼 기한이 없으면 칸을 뺀다', () => {
    expect(portoneVirtualAccountOf({ type: 'PaymentMethodVirtualAccount', bank: 'SHINHAN', accountNumber: ACCOUNT })).toEqual({ accountNumber: ACCOUNT, bank: 'SHINHAN' });
  });

  test('P-T36_포트원 결제 수단이 가상계좌가 아니면 없다', () => {
    expect(portoneVirtualAccountOf({ type: 'PaymentMethodCard', bank: 'SHINHAN', accountNumber: ACCOUNT })).toBeUndefined();
  });

  test('P-T36_토스 승인 답이 입금 대기면 virtualAccount를 싣는다', async () => {
    await expect(toss([tossBody()]).confirm(CONFIRM)).resolves.toEqual({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: 'tgen_1', amount: AMOUNT, virtualAccount: { accountNumber: ACCOUNT, bank: '20', dueAt: '2026-11-12T10:00:00+09:00', secret: SECRET } });
  });

  test('P-T36_토스 조회 답에도 virtualAccount를 싣는다(T14)', async () => {
    const r = (await toss([tossBody()]).query('tgen_1')) as Extract<QueryResult, { kind: 'FOUND' }>;
    expect(r.status).toBe('WAITING_FOR_DEPOSIT');
    expect(r.virtualAccount).toEqual({ accountNumber: ACCOUNT, bank: '20', dueAt: '2026-11-12T10:00:00+09:00', secret: SECRET });
  });

  test('P-T36_시뮬레이터 어댑터도 같은 칸을 읽는다(토스 모양)', async () => {
    const g = new SimulatorPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_test', clientKey: 'sim_ck_test', fetch: jsonFetch([tossBody()]) });
    expect((await g.confirm(CONFIRM)).virtualAccount?.bank).toBe('20');
  });

  test('P-T36_포트원 승인 뒤 조회가 가상계좌 발급이면 virtualAccount를 싣는다', async () => {
    const id = `pay-${ORDER}`;
    const view = { status: 'VIRTUAL_ACCOUNT_ISSUED', id, amount: { total: AMOUNT, paid: 0, cancelled: 0 }, method: { type: 'PaymentMethodVirtualAccount', bank: 'SHINHAN', accountNumber: ACCOUNT, expiredAt: '2026-11-12T01:00:00Z' } };
    const g = new PortoneGateway({ baseUrl: 'http://pg.test', secret: 'sec', storeId: 's', channelKey: 'c', webhookSecrets: [], isTest: true, clock: fakeClock({ now: NOW }), fetch: jsonFetch([{ pgTxId: 'pgtx', paidAt: '2026-11-09T01:00:00Z' }, view]) });
    const r = await g.confirm({ orderId: ORDER, paymentRef: id, amount: AMOUNT, idemKey: `confirm-${ORDER}`, confirmToken: 'tok' });
    expect(r).toEqual({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: id, amount: AMOUNT, virtualAccount: { accountNumber: ACCOUNT, bank: 'SHINHAN', dueAt: '2026-11-12T01:00:00Z' } });
  });

  test('P-T9_토스 입금 통보는 secret을 신호에 싣는다 [ASVS v5.0.0-2.2.1]', () => {
    const body = JSON.stringify({ createdAt: '2026-11-09T10:00:00.000000', secret: SECRET, status: 'DONE', transactionKey: 'tx-1', orderId: ORDER });
    expect(toss([]).parseWebhook({}, body)).toEqual({ kind: 'TRIGGER', dedupKey: 'TOSS:deposit:tx-1:DONE:2026-11-09T10:00:00.000000', orderRef: ORDER, depositSecret: SECRET, depositDone: true });
  });

  test('P-T9_리뷰 고침 M3: DONE이 아닌 입금 통보에는 입금 완료 표시가 없다', () => {
    const body = JSON.stringify({ createdAt: 'c', secret: SECRET, status: 'WAITING_FOR_DEPOSIT', transactionKey: 'tx-1', orderId: ORDER });
    // 입금 대기로 돌아왔다는 통보는 입금 오류 되돌림의 신호다(BUILD_ORDER HOT-152)
    expect(toss([]).parseWebhook({}, body)).toEqual({ kind: 'TRIGGER', dedupKey: 'TOSS:deposit:tx-1:WAITING_FOR_DEPOSIT:c', orderRef: ORDER, depositSecret: SECRET, depositReversed: true });
  });

  test.each([
    ['Transaction.Paid', true],
    ['Transaction.VirtualAccountIssued', false],
  ])('P-T36_리뷰 고침 M3: 포트원 %s의 입금 완료 표시는 %s다', (type, done) => {
    const key = randomBytes(32);
    const g = new PortoneGateway({ baseUrl: 'http://pg.test', secret: 'sec', storeId: 's', channelKey: 'c', webhookSecrets: [`whsec_${key.toString('base64')}`], isTest: true, clock: fakeClock({ now: NOW }), fetch: jsonFetch([]) });
    const body = JSON.stringify({ type, data: { paymentId: `pay-${ORDER}` } });
    const ts = Math.floor(NOW / 1000);
    const signature = `v1,${createHmac('sha256', key).update(`wh-1.${ts}.${body}`).digest('base64')}`;
    const parsed = g.parseWebhook({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(ts), 'webhook-signature': signature }, body);
    expect(parsed).toMatchObject({ kind: 'TRIGGER', orderRef: ORDER });
    expect((parsed as { depositDone?: boolean }).depositDone === true).toBe(done);
  });

  test('P-T9_secret이 비었거나 200자를 넘으면 본문이 틀린 것이다 [ASVS v5.0.0-2.2.1]', () => {
    for (const secret of ['', 'x'.repeat(201)]) {
      const body = JSON.stringify({ createdAt: 'c', secret, status: 'DONE', transactionKey: 'tx-1', orderId: ORDER });
      expect(toss([]).parseWebhook({}, body)).toEqual({ kind: 'INVALID', reason: 'BODY' });
    }
  });
});

describe('입금 기한과 secret 값', () => {
  test('P-T36_다음 조회는 입금 기한 + 10분이다', () => {
    expect(depositNextQueryAtMs(DUE, NOW)).toBe(DUE + DEPOSIT_QUERY_GRACE_MS);
    expect(DEPOSIT_QUERY_GRACE_MS).toBe(600_000);
  });

  test('P-T36_기한을 모르면 1시간 뒤다', () => {
    expect(depositNextQueryAtMs(undefined, NOW)).toBe(NOW + DEPOSIT_NO_DUE_RECHECK_MS);
    expect(DEPOSIT_NO_DUE_RECHECK_MS).toBe(3_600_000);
  });

  test('P-T36_기한 + 10분이 이미 지났으면 지금 + 5초다', () => {
    expect(depositNextQueryAtMs(NOW - DEPOSIT_QUERY_GRACE_MS - 1, NOW)).toBe(NOW + DEPOSIT_PAST_DUE_DELAY_MS);
  });

  test.each([
    [DUE + DEPOSIT_QUERY_GRACE_MS - 1, false],
    [DUE + DEPOSIT_QUERY_GRACE_MS, true],
    [DUE + DEPOSIT_QUERY_GRACE_MS + 1, true],
  ])('P-T36_기한 경과 경계: 지금 %d → %s', (now, expected) => {
    expect(depositExpired(DUE, now)).toBe(expected);
  });

  test('P-T36_기한을 모르면 지나지 않은 것이다', () => {
    expect(depositExpired(undefined, NOW)).toBe(false);
  });

  test('P-T9_secret 해시는 SHA-256이다 [ASVS v5.0.0-11.3.2]', () => {
    expect(depositSecretHashOf(SECRET).equals(createHash('sha256').update(SECRET, 'utf8').digest())).toBe(true);
  });

  test('P-T9_같은 해시만 맞고 길이가 달라도 던지지 않는다', () => {
    const a = depositSecretHashOf('a');
    expect(depositSecretMatches(a, depositSecretHashOf('a'))).toBe(true);
    expect(depositSecretMatches(a, depositSecretHashOf('b'))).toBe(false);
    expect(depositSecretMatches(a, Buffer.from('short'))).toBe(false);
  });
});

describe('입금 통보의 판단', () => {
  const HASH = (): Buffer => depositSecretHashOf(SECRET);
  const row = (o: Partial<WebhookLedgerRow> = {}): WebhookLedgerRow => ({ paymentId: PAYMENT, orderId: ORDER, pg: 'TOSS', status: 'AWAITING_DEPOSIT', depositSecretHash: HASH(), ...o });
  const FOUND = { paymentId: PAYMENT, orderId: ORDER };

  test('P-T9_secret이 맞으면 수신 기록을 쓰고 조회 신호를 낸다', () => {
    expect(decideDepositCallback(row(), ['TOSS'], HASH())).toEqual({ decision: { kind: 'QUERY_SIGNAL', ...FOUND }, receipt: true });
  });

  test('P-T9_secret이 틀리면 수신 기록도 신호도 없다(위조가 키를 먼저 차지하지 못한다) [ASVS v5.0.0-16.3.3]', () => {
    expect(decideDepositCallback(row(), ['TOSS'], depositSecretHashOf('forged'))).toEqual({ decision: { kind: 'DEPOSIT_SECRET_MISMATCH', orderId: ORDER }, receipt: false });
  });

  test('P-T9_리뷰 고침 M5: 입금 대기인데 해시가 없으면(발급 답에 secret이 없었다) 수신 기록 없이 조회 신호만 낸다 [ASVS v5.0.0-16.3.3]', () => {
    expect(decideDepositCallback(row({ depositSecretHash: undefined }), ['TOSS'], HASH())).toEqual({ decision: { kind: 'QUERY_SIGNAL', ...FOUND }, receipt: false });
  });

  test('P-T36_리뷰 고침 M6: FAILED로 끝난 원장의 DONE 통보는 늦은 입금 확인 신호다(원장은 바꾸지 않는다)', () => {
    expect(withLateDepositCheck(row({ status: 'FAILED', depositSecretHash: undefined }), true, { decision: { kind: 'STATE_IGNORED', ...FOUND }, receipt: false })).toEqual({ decision: { kind: 'LATE_DEPOSIT_CHECK', ...FOUND }, receipt: false });
  });

  test('P-T36_리뷰 고침 M6: DONE이 아니거나 FAILED가 아니면 늦은 입금 확인이 아니다', () => {
    const ignored = { decision: { kind: 'STATE_IGNORED' as const, ...FOUND }, receipt: false };
    expect(withLateDepositCheck(row({ status: 'FAILED', depositSecretHash: undefined }), false, ignored)).toEqual(ignored);
    expect(withLateDepositCheck(row({ status: 'APPROVED', depositSecretHash: undefined }), true, ignored)).toEqual(ignored);
  });

  test('P-T9_UNKNOWN에 해시가 없으면(승인 답을 잃었다) 수신 기록 없이 조회 신호만 낸다', () => {
    expect(decideDepositCallback(row({ status: 'UNKNOWN', depositSecretHash: undefined }), ['TOSS'], HASH())).toEqual({ decision: { kind: 'QUERY_SIGNAL', ...FOUND }, receipt: false });
  });

  test('P-T9_UNKNOWN이고 해시가 있으면 대조한다', () => {
    expect(decideDepositCallback(row({ status: 'UNKNOWN' }), ['TOSS'], HASH()).receipt).toBe(true);
    expect(decideDepositCallback(row({ status: 'UNKNOWN' }), ['TOSS'], depositSecretHashOf('x')).decision.kind).toBe('DEPOSIT_SECRET_MISMATCH');
  });

  test.each(['APPROVED', 'FAILED', 'ACCEPTED', 'CANCELED', 'PARTIAL_CANCELED'] as const)('P-T9_해시를 지운 %s는 재전송이라 지표만이다(보안 사건이 아니다)', (status) => {
    expect(decideDepositCallback(row({ status, depositSecretHash: undefined }), ['TOSS'], HASH())).toEqual({ decision: { kind: 'STATE_IGNORED', ...FOUND }, receipt: false });
  });

  test('P-T9_원장이 없으면 수신 기록을 쓰지 않는다', () => {
    expect(decideDepositCallback(undefined, ['TOSS'], HASH())).toEqual({ decision: { kind: 'LEDGER_NOT_FOUND' }, receipt: false });
  });

  test('P-T30_결제사가 다르면 secret을 보지 않고 수신 기록을 쓰지 않는다 [ASVS v5.0.0-16.3.3]', () => {
    expect(decideDepositCallback(row({ pg: 'PORTONE' }), ['TOSS'], HASH())).toEqual({ decision: { kind: 'PG_MISMATCH', orderId: ORDER, ledgerPg: 'PORTONE' }, receipt: false });
  });

  test('P-T36_서명을 본 포트원 경로는 입금 대기에 조회 신호를 낸다', () => {
    expect(decideWebhookLedger(row({ pg: 'PORTONE', depositSecretHash: undefined }), ['PORTONE'], true).kind).toBe('QUERY_SIGNAL');
  });

  test('P-T9_서명 없는 경로의 일반 웹훅은 입금 대기에 신호를 내지 못한다(secret 대조를 돌아가지 못한다)', () => {
    expect(decideWebhookLedger(row(), ['TOSS'], false).kind).toBe('STATE_IGNORED');
  });
});

describe('입금 통보 받기', () => {
  const body = (secret: string) => Buffer.from(JSON.stringify({ createdAt: 'c', secret, status: 'DONE', transactionKey: 'tx-1', orderId: ORDER }));
  function harness(answer: WebhookReceiveResult) {
    const requests: WebhookReceiveRequest[] = [];
    const store: PaymentWebhookStore = {
      receive: async (r) => {
        requests.push(r);
        return answer;
      },
    };
    const gateway = toss([]) as PaymentGatewayPort;
    const log: PaymentWebhookLog = { invalid: vi.fn(), pgMismatch: vi.fn(), storeFailed: vi.fn(), depositSecretMismatch: vi.fn() };
    const outcomes: [PgName, PaymentWebhookOutcome][] = [];
    const useCase = new ReceivePaymentWebhook({ store, gateways: { of: (pg) => (pg === 'TOSS' ? gateway : undefined) }, log, signals: { outcome: (pg, o) => outcomes.push([pg, o]) }, clock: fakeClock({ now: NOW }), allowSimulator: false });
    return { useCase, requests, log, outcomes };
  }

  test('P-T9_저장소에는 secret이 아니라 해시만 넘긴다 [ASVS v5.0.0-16.2.5]', async () => {
    const h = harness({ kind: 'QUERY_SIGNAL', paymentId: PAYMENT, orderId: ORDER });
    await expect(h.useCase.receive('toss', {}, body(SECRET))).resolves.toBe('ACCEPTED');
    expect(Buffer.from(h.requests[0]!.depositSecretHash!).equals(depositSecretHashOf(SECRET))).toBe(true);
    expect(JSON.stringify(h.requests[0])).not.toContain(SECRET);
  });

  test('P-T9_불일치는 보안 로그·지표이고 200이다(계약이 200뿐이다) [ASVS v5.0.0-16.3.3]', async () => {
    const h = harness({ kind: 'DEPOSIT_SECRET_MISMATCH', orderId: ORDER });
    await expect(h.useCase.receive('toss', {}, body('forged'))).resolves.toBe('ACCEPTED');
    expect(h.log.depositSecretMismatch).toHaveBeenCalledWith({ route: 'toss', pg: 'TOSS', orderId: ORDER });
    expect(h.outcomes).toEqual([['TOSS', 'deposit_secret_mismatch']]);
  });

  test('P-T9_불일치 로그 줄에 secret이 없고 1분에 한 줄이다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.3.3]', () => {
    const lines: unknown[] = [];
    const clock = fakeClock({ now: NOW });
    const log = paymentWebhookLog({ warn: (o: unknown) => lines.push(o), error: (o: unknown) => lines.push(o) } as never, clock);
    log.depositSecretMismatch({ route: 'toss', pg: 'TOSS', orderId: ORDER });
    log.depositSecretMismatch({ route: 'toss', pg: 'TOSS', orderId: ORDER });
    expect(lines).toEqual([{ kind: 'payment-webhook-deposit-secret-mismatch', severity: 'SEV3', route: 'toss', pg: 'TOSS', orderId: ORDER }]);
    clock.advance(60_000);
    log.depositSecretMismatch({ route: 'toss', pg: 'TOSS', orderId: ORDER });
    expect(lines).toHaveLength(2);
  });
});

describe('입금 통보의 저장 차례', () => {
  const dialect = new PgDialect();

  function store(ledger: Record<string, unknown>) {
    const statements: string[] = [];
    const tx = {
      execute: async (query: SQL) => {
        const text = dialect.sqlToQuery(query).sql.trim();
        statements.push(text);
        if (text.startsWith('select')) return { rows: [ledger] };
        return { rows: [{ dedup_key: 'k', id: ledger.id }], rowCount: 1 };
      },
    };
    const database = { transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx) } as unknown as Database;
    return { statements, store: new DrizzleWebhookStore({ database }) };
  }
  const LEDGER = (): Record<string, unknown> => ({ id: PAYMENT, order_id: ORDER, pg: 'TOSS', status: 'AWAITING_DEPOSIT', deposit_secret_hash: depositSecretHashOf(SECRET) });
  const REQUEST = { pg: 'TOSS' as const, dedupKey: 'TOSS:deposit:tx:DONE', orderRef: ORDER, allowedPgs: ['TOSS' as const], signed: false, nowMs: NOW };

  test('P-T9_secret이 맞으면 찾기 → 수신 기록 → 조회 신호 차례다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = store(LEDGER());
    await h.store.receive({ ...REQUEST, depositSecretHash: depositSecretHashOf(SECRET) });
    expect(h.statements).toHaveLength(3);
    expect(h.statements[1]).toContain('insert into webhook_receipt');
    expect(h.statements[2]).toContain('update payment');
  });

  test('P-T9_secret이 틀리면 찾기 한 문장으로 끝난다 [ASVS v5.0.0-16.3.3]', async () => {
    const h = store(LEDGER());
    await expect(h.store.receive({ ...REQUEST, depositSecretHash: depositSecretHashOf('forged') })).resolves.toEqual({ kind: 'DEPOSIT_SECRET_MISMATCH', orderId: ORDER });
    expect(h.statements).toHaveLength(1);
  });

  test('P-T9_UNKNOWN에 해시가 없으면 찾기 → 조회 신호이고 수신 기록을 쓰지 않는다', async () => {
    const h = store({ ...LEDGER(), status: 'UNKNOWN', deposit_secret_hash: null });
    await h.store.receive({ ...REQUEST, depositSecretHash: depositSecretHashOf(SECRET) });
    expect(h.statements).toHaveLength(2);
    expect(h.statements[1]).toContain('update payment');
  });

  test('P-T36_일반 웹훅의 조회 신호도 입금 대기 행을 고른다', async () => {
    const h = store({ ...LEDGER(), pg: 'PORTONE' });
    await h.store.receive({ pg: 'PORTONE', dedupKey: 'PORTONE:wh', orderRef: ORDER, allowedPgs: ['PORTONE'], signed: true, nowMs: NOW });
    expect(h.statements[2]).toContain("status in ('UNKNOWN', 'AWAITING_DEPOSIT')");
  });

  test('P-T36_리뷰 고침 M3: secret이 맞은 입금 완료 통보는 통보 시각을 쓰고 5초 간격 안에서 조회를 당긴다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = store(LEDGER());
    await h.store.receive({ ...REQUEST, depositSecretHash: depositSecretHashOf(SECRET), depositDone: true });
    expect(h.statements[2]).toContain('deposit_notified_at = coalesce(deposit_notified_at');
    expect(h.statements[2]).toContain("status = 'AWAITING_DEPOSIT'");
  });

  test('P-T9_리뷰 고침 M5: 해시 없는 입금 대기의 DONE 통보는 통보 시각을 쓰지 않고 조회 신호만이다 [ASVS v5.0.0-16.3.3]', async () => {
    const h = store({ ...LEDGER(), deposit_secret_hash: null });
    await h.store.receive({ ...REQUEST, depositSecretHash: depositSecretHashOf(SECRET), depositDone: true });
    expect(h.statements).toHaveLength(2);
    expect(h.statements[1]).not.toContain('deposit_notified_at');
  });

  test('P-T36_리뷰 고침 M6: FAILED 원장의 DONE 통보는 한 번만 조회를 건다', async () => {
    const h = store({ ...LEDGER(), status: 'FAILED', deposit_secret_hash: null });
    await expect(h.store.receive({ ...REQUEST, depositSecretHash: depositSecretHashOf(SECRET), depositDone: true })).resolves.toEqual({ kind: 'LATE_DEPOSIT_CHECK', paymentId: PAYMENT, orderId: ORDER });
    expect(h.statements).toHaveLength(2);
    expect(h.statements[1]).toContain("status = 'FAILED' and deposit_notified_at is null");
  });
});

describe('입금 대기 행의 조회 답', () => {
  const ledger = (deposit: { dueAtMs?: number; notifiedAtMs?: number } = { dueAtMs: DUE }) => ({ orderId: ORDER, amount: AMOUNT, deposit });
  const found = (status: Extract<QueryResult, { kind: 'FOUND' }>['status'], o: Partial<Extract<QueryResult, { kind: 'FOUND' }>> = {}): QueryResult => ({ kind: 'FOUND', paymentRef: 'tgen_1', orderRef: ORDER, status, amount: AMOUNT, balanceAmount: AMOUNT, method: 'OTHER', ...o });

  test('P-T36_입금 완료면 APPROVED다(T16)', () => {
    expect(decideQueryAnswer(found('APPROVED', { approvedAt: '2026-11-10T01:00:00Z' }), ledger(), NOW)).toEqual({ kind: 'RESOLVE', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: Date.parse('2026-11-10T01:00:00Z'), payMethodCategory: 'OTHER' }, outcome: 'deposit_approved' });
  });

  test('P-T36_입금 금액이 원장과 다르면 승인으로 쓰지 않고 SEV1로 다시 묻는다 [ASVS v5.0.0-2.3.3]', () => {
    expect(decideQueryAnswer(found('APPROVED', { amount: AMOUNT + 1 }), ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' });
  });

  test('P-T36_다른 주문의 답은 쓰지 않는다 [ASVS v5.0.0-2.3.3]', () => {
    expect(decideQueryAnswer(found('APPROVED', { orderRef: 'other' }), ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'order' });
  });

  test('P-T36_기한 전 입금 대기면 그대로이고 다음 조회는 기한 + 10분이다', () => {
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: DUE + DEPOSIT_QUERY_GRACE_MS });
  });

  test('P-T36 ②_기한 + 10분이 지나도 입금 대기면 FAILED(EXPIRED)다(토스는 기한이 지나도 상태가 바뀌지 않는다)', () => {
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), ledger(), DUE + DEPOSIT_QUERY_GRACE_MS)).toEqual({ kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'EXPIRED', payMethodCategory: 'OTHER' }, outcome: 'deposit_expired' });
  });

  test.each(['FAILED', 'EXPIRED', 'CANCELED'] as const)('P-T36 ②_조회가 %s이면 FAILED(EXPIRED)다(T17)', (status) => {
    const d = decideQueryAnswer(found(status), ledger(), NOW);
    expect(d).toMatchObject({ kind: 'RESOLVE', outcome: 'deposit_expired', finish: { status: 'FAILED', failureCategory: 'EXPIRED' } });
  });

  test('P-T36_입금 대기 답의 금액이 다르면 다시 묻는다', () => {
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT', { amount: AMOUNT + 1 }), ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' });
  });

  test('P-T36_기한을 모르면 1시간 뒤 다시 묻는다', () => {
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), ledger({}), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: NOW + DEPOSIT_NO_DUE_RECHECK_MS });
  });

  test.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 60_000],
    [6, 60_000],
  ])('P-T36_리뷰 고침 M3: 입금 완료 통보 뒤에도 입금 대기면 %d번째 조회 다음은 %dms 뒤다', (queryAttempts, delay) => {
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), { ...ledger({ dueAtMs: DUE, notifiedAtMs: NOW - 1_000 }), queryAttempts }, NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: NOW + delay, keepAttempts: true });
  });

  test('P-T36_리뷰 고침 M3: 통보 뒤 10분이 지나면 기한 + 10분 규칙으로 돌아간다', () => {
    expect(DEPOSIT_NOTIFIED_WINDOW_MS).toBe(600_000);
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), { ...ledger({ dueAtMs: DUE, notifiedAtMs: NOW - DEPOSIT_NOTIFIED_WINDOW_MS }), queryAttempts: 3 }, NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: DUE + DEPOSIT_QUERY_GRACE_MS });
  });

  test('P-T36_리뷰 고침 M3: 통보 뒤 10분 안이면 기한 + 10분이 지났어도 만료로 쓰지 않는다 [ASVS v5.0.0-2.3.3]', () => {
    const now = DUE + DEPOSIT_QUERY_GRACE_MS + 1;
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), { ...ledger({ dueAtMs: DUE, notifiedAtMs: now - 1_000 }), queryAttempts: 1 }, now)).toEqual({ kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: now + 5_000, keepAttempts: true });
  });

  test('P-T36_원장에 기한이 없으면 답의 기한으로 만료를 정한다', () => {
    const due = new Date(NOW - DEPOSIT_QUERY_GRACE_MS).toISOString();
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT', { virtualAccount: { accountNumber: ACCOUNT, bank: '20', dueAt: due } }), ledger({}), NOW)).toMatchObject({ kind: 'RESOLVE', outcome: 'deposit_expired' });
  });

  test.each(['READY', 'IN_PROGRESS'] as const)('P-T36_%s는 간격대로 다시 묻는다', (status) => {
    expect(decideQueryAnswer(found(status), ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'still_processing' });
  });

  test('P-T36_조회 실패·없음은 UNKNOWN과 같게 다시 묻는다', () => {
    expect(decideQueryAnswer({ kind: 'UNKNOWN' }, ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'query_failed' });
    expect(decideQueryAnswer({ kind: 'NOT_FOUND' }, ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'not_found' });
  });

  test('P-T36_부분 취소는 사람이 본다', () => {
    expect(decideQueryAnswer(found('PARTIAL_CANCELED'), ledger(), NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'cancelled_at_pg', anomaly: 'cancelled' });
  });

  test('P-T36_UNKNOWN 행의 입금 대기 답은 지금처럼 AWAITING_DEPOSIT이다(T14)', () => {
    expect(decideQueryAnswer(found('WAITING_FOR_DEPOSIT'), { orderId: ORDER, amount: AMOUNT }, NOW)).toMatchObject({ kind: 'RESOLVE', outcome: 'waiting', finish: { status: 'AWAITING_DEPOSIT' } });
  });
});

describe('사건', () => {
  const target = { paymentId: PAYMENT, orderId: ORDER, eventId: '0193a000-0000-7000-8000-000000000009', attemptNo: 1, pg: 'TOSS' as const, amount: AMOUNT };

  test('P-T36_입금 대기 사건에 기한을 싣고 계좌번호·secret은 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const m = buildPaymentEvent({ target, finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', deposit: { dueAtMs: DUE, bank: '20', accountNoSealed: 'sealed', secretHash: depositSecretHashOf(SECRET) } }, seq: 3, nowMs: NOW });
    expect(m.depositDueAt).toBe(new Date(DUE).toISOString());
    expect(JSON.stringify(m)).not.toMatch(/sealed|bank|secret/);
  });

  test('P-T36_기한이 없으면 칸이 없다', () => {
    const m = buildPaymentEvent({ target, finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', deposit: { bank: '20' } }, seq: 3, nowMs: NOW });
    expect('depositDueAt' in m).toBe(false);
  });

  test('P-T36_입금 대기가 아닌 사건에는 칸이 없다', () => {
    const m = buildPaymentEvent({ target, finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: NOW }, seq: 3, nowMs: NOW });
    expect('depositDueAt' in m).toBe(false);
  });

  test('P-T36_결과 조회 답에 입금 기한을 싣는다', () => {
    const r = orderPaymentStateOf({ orderId: ORDER, paymentId: PAYMENT, pg: 'TOSS', status: 'AWAITING_DEPOSIT', amount: AMOUNT, depositDueAtMs: DUE });
    expect(r.deposit_due_at).toEqual({ seconds: Math.floor(DUE / 1000), nanos: 0 });
  });
});

describe('필드 암호화', () => {
  const KEY = randomBytes(32);

  test('P-T36_봉투 암호화로 저장하고 같은 결제에서만 열린다 [ASVS v5.0.0-11.3.1] [ASVS v5.0.0-11.3.2] [ASVS v5.0.0-11.3.3]', async () => {
    const c = new LocalVirtualAccountCipher(KEY);
    const sealed = await c.seal(PAYMENT, ACCOUNT);
    expect(sealed).not.toContain(ACCOUNT);
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain(ACCOUNT);
    await expect(c.open(PAYMENT, sealed)).resolves.toBe(ACCOUNT);
    await expect(c.open('0193a000-0000-7000-8000-0000000000ff', sealed)).rejects.toThrow();
  });

  test('P-T36_같은 값도 암호문이 매번 다르다 [ASVS v5.0.0-11.3.2]', async () => {
    const c = new LocalVirtualAccountCipher(KEY);
    expect(await c.seal(PAYMENT, ACCOUNT)).not.toBe(await c.seal(PAYMENT, ACCOUNT));
  });

  test('P-T36_다른 키로는 열리지 않고 망가진 값은 던진다(글에 값이 없다) [ASVS v5.0.0-11.3.3] [ASVS v5.0.0-16.2.5]', async () => {
    const a = new LocalVirtualAccountCipher(KEY);
    const sealed = await a.seal(PAYMENT, ACCOUNT);
    await expect(new LocalVirtualAccountCipher(randomBytes(32)).open(PAYMENT, sealed)).rejects.toThrow();
    const err = await a.open(PAYMENT, 'AAAA').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(ACCOUNT);
  });

  test('P-T36_키가 32바이트가 아니면 만들지 못한다', () => {
    expect(() => new LocalVirtualAccountCipher(randomBytes(16))).toThrow();
  });

  test('P-T36_객체를 JSON으로 바꿔도 키가 실리지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    expect(JSON.stringify(new LocalVirtualAccountCipher(KEY))).not.toContain(KEY.toString('base64'));
  });

  test.each(['local', 'ci', 'demo'])('P-T36_%s는 환경 값 키를 받는다', (env) => {
    const r = virtualAccountCipherFromEnv({ PEAKET_ENV: env, PEAKET_PAYMENT_VA_FIELD_KEY: KEY.toString('base64') });
    expect(r.cipher.ready).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test.each(['prod', 'staging', undefined])('P-T36_%s에 환경 값 키가 있으면 시작 실패다(글에 값이 없다) [ASVS v5.0.0-13.3.1]', (env) => {
    const raw = KEY.toString('base64');
    let message = '';
    try {
      virtualAccountCipherFromEnv({ ...(env ? { PEAKET_ENV: env } : {}), PEAKET_PAYMENT_VA_FIELD_KEY: raw });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(raw);
  });

  test('P-T36_키 길이가 틀리면 시작 실패다', () => {
    expect(() => virtualAccountCipherFromEnv({ PEAKET_ENV: 'ci', PEAKET_PAYMENT_VA_FIELD_KEY: randomBytes(16).toString('base64') })).toThrow();
  });

  test('P-T36_키가 없으면 키 없는 암호기와 경고 한 줄이다', () => {
    const r = virtualAccountCipherFromEnv({ PEAKET_ENV: 'prod' });
    expect(r.cipher).toBeInstanceOf(NoKeyVirtualAccountCipher);
    expect(r.cipher.ready).toBe(false);
    expect(r.warnings).toHaveLength(1);
  });

  test('P-T36_KMS 키 이름만 있어도 받는 길이 없어 키 없는 암호기다(HOT-146)', () => {
    const r = virtualAccountCipherFromEnv({ PEAKET_ENV: 'prod', PEAKET_PAYMENT_VA_FIELD_KMS_KEY: 'alias/x' });
    expect(r.cipher.ready).toBe(false);
    expect(r.warnings[0]).toContain('KMS');
  });

  test('P-T36_키 없는 암호기를 부르면 던진다(부르는 쪽 결함)', async () => {
    await expect(new NoKeyVirtualAccountCipher().seal()).rejects.toThrow();
  });
});

describe('입금 대기 쓰기의 값', () => {
  const ids = { paymentId: PAYMENT, orderId: ORDER };
  const VA = { accountNumber: ACCOUNT, bank: '20', dueAt: new Date(DUE).toISOString(), secret: SECRET };
  function deps(cipher: VirtualAccountCipher) {
    const log = { infoMissing: vi.fn(), accountUnsaved: vi.fn(), accountUnopened: vi.fn() } satisfies PaymentDepositLog;
    const signals = { fieldFailure: vi.fn() } satisfies PaymentDepositSignals;
    return { cipher, log, signals };
  }
  const local = new LocalVirtualAccountCipher(randomBytes(32));

  test('P-T36_기한·은행·암호문·해시를 만든다 [ASVS v5.0.0-14.2.4]', async () => {
    const w = await depositWriteOf(deps(local), ids, VA);
    expect(w).toMatchObject({ dueAtMs: DUE, bank: '20' });
    expect(w!.secretHash!.equals(depositSecretHashOf(SECRET))).toBe(true);
    await expect(local.open(PAYMENT, w!.accountNoSealed!)).resolves.toBe(ACCOUNT);
  });

  test('P-T36_키가 없으면 계좌번호를 쓰지 않고 지표·SEV2다(나머지는 쓴다) [ASVS v5.0.0-14.2.4]', async () => {
    const d = deps(new NoKeyVirtualAccountCipher());
    const w = await depositWriteOf(d, ids, VA);
    expect(w).toMatchObject({ dueAtMs: DUE, bank: '20' });
    expect(w!.accountNoSealed).toBeUndefined();
    expect(w!.secretHash).toBeDefined();
    expect(d.signals.fieldFailure).toHaveBeenCalledWith('seal', 'NO_KEY');
    expect(d.log.accountUnsaved).toHaveBeenCalledWith({ orderId: ORDER, reason: 'NO_KEY' });
  });

  test('P-T36_암호화가 실패해도 던지지 않고 계좌번호만 뺀다(평문을 쓰지 않는다) [ASVS v5.0.0-14.2.4]', async () => {
    const d = deps({ ready: true, seal: async () => Promise.reject(new Error('kms down')), open: async () => '' });
    const w = await depositWriteOf(d, ids, VA);
    expect(w!.accountNoSealed).toBeUndefined();
    expect(JSON.stringify(w)).not.toContain(ACCOUNT);
    expect(d.signals.fieldFailure).toHaveBeenCalledWith('seal', 'ERROR');
    expect(d.log.accountUnsaved).toHaveBeenCalledWith({ orderId: ORDER, reason: 'ERROR' });
  });

  test.each([
    ['은행 없음', { accountNumber: ACCOUNT, dueAt: VA.dueAt, secret: SECRET }, { dueAtMs: DUE }],
    ['기한 없음', { accountNumber: ACCOUNT, bank: '20', secret: SECRET }, { bank: '20' }],
  ])('P-T36_리뷰 고침 M5: 칸이 빠져도(%s) 나머지는 쓰고 SEV2는 한 번이다 [ASVS v5.0.0-16.2.5]', async (_n, va, expected) => {
    const d = deps(local);
    const w = await depositWriteOf(d, ids, va);
    expect(w).toMatchObject(expected);
    await expect(local.open(PAYMENT, w!.accountNoSealed!)).resolves.toBe(ACCOUNT);
    expect(w!.secretHash!.equals(depositSecretHashOf(SECRET))).toBe(true);
    expect(d.log.infoMissing).toHaveBeenCalledTimes(1);
    expect(d.log.infoMissing).toHaveBeenCalledWith({ orderId: ORDER });
  });

  test('P-T36_리뷰 고침 M5: 계좌번호가 없으면 암호화하지 않는다', async () => {
    const d = deps(local);
    const w = await depositWriteOf(d, ids, { bank: '20', dueAt: VA.dueAt });
    expect(w).toEqual({ bank: '20', dueAtMs: DUE });
    expect(d.log.accountUnsaved).not.toHaveBeenCalled();
    expect(d.log.infoMissing).toHaveBeenCalledTimes(1);
  });

  test('P-T36_리뷰 고침 M6: 늦은 입금 로그는 주문 ID·csCase만 싣는 SEV1이다 [ASVS v5.0.0-16.2.5]', () => {
    const error = vi.fn();
    paymentUnknownLog({ warn: vi.fn(), error } as never).lateDeposit({ orderId: ORDER });
    expect(error.mock.calls[0]![0]).toEqual({ kind: 'payment-late-deposit', severity: 'SEV1', orderId: ORDER, csCase: 'PAYMENT_LATE_DEPOSIT' });
  });

  test('P-T36_발급 정보가 없으면 undefined와 SEV2다', async () => {
    const d = deps(local);
    await expect(depositWriteOf(d, ids, undefined)).resolves.toBeUndefined();
    expect(d.log.infoMissing).toHaveBeenCalledWith({ orderId: ORDER });
  });

  test('P-T36_기한이 없으면 칸을 뺀 채 쓰고 SEV2다', async () => {
    const d = deps(local);
    const w = await depositWriteOf(d, ids, { accountNumber: ACCOUNT, bank: '20' });
    expect(w!.dueAtMs).toBeUndefined();
    expect(d.log.infoMissing).toHaveBeenCalledWith({ orderId: ORDER });
  });

  test('P-T36_secret이 없으면(포트원) 해시 칸이 없다', async () => {
    const w = await depositWriteOf(deps(local), ids, { accountNumber: ACCOUNT, bank: 'SHINHAN', dueAt: VA.dueAt });
    expect(w!.secretHash).toBeUndefined();
  });

  const HOUR = 3_600_000;
  const withCounter = () => {
    const d = deps(local);
    const dueCapped = vi.fn();
    return { d: { ...d, signals: { ...d.signals, dueCapped } }, dueCapped };
  };

  test('P-T26_리뷰 고침 5: 답의 기한이 입장 24시간 전을 넘으면 잘라 쓰고 지표를 낸다 [ASVS v5.0.0-2.2.3]', async () => {
    const { d, dueCapped } = withCounter();
    const entry = DUE + 12 * HOUR;
    const w = await depositWriteOf(d, ids, VA, entry);
    expect(w!.dueAtMs).toBe(entry - 24 * HOUR);
    expect(dueCapped).toHaveBeenCalledTimes(1);
  });

  test('P-T26_리뷰 고침 5: 상한 안의 기한은 그대로고 세지 않는다. 입장 시각을 모르면 자르지 않는다', async () => {
    const { d, dueCapped } = withCounter();
    expect((await depositWriteOf(d, ids, VA, DUE + 24 * HOUR))!.dueAtMs).toBe(DUE);
    expect((await depositWriteOf(d, ids, VA))!.dueAtMs).toBe(DUE);
    expect(dueCapped).not.toHaveBeenCalled();
  });

  test('P-T26_리뷰 고침 5: 답에 기한이 없으면 자를 것이 없고 세지 않는다', async () => {
    const { d, dueCapped } = withCounter();
    const w = await depositWriteOf(d, ids, { accountNumber: ACCOUNT, bank: '20' }, DUE);
    expect(w).not.toHaveProperty('dueAtMs');
    expect(dueCapped).not.toHaveBeenCalled();
  });

  test('P-T26_리뷰 고침 5: 지표 payment_deposit_due_capped_total을 0부터 보인다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const s = new PromPaymentDepositSignals().register(metrics.registry);
    expect(await metrics.registry.metrics()).toContain('payment_deposit_due_capped_total 0');
    s.dueCapped();
    expect(await metrics.registry.metrics()).toContain('payment_deposit_due_capped_total 1');
  });

  test('P-T36_로그에 계좌번호·secret이 실리지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write: (chunk, _enc, cb) => {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = paymentDepositLog(createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: fakeClock({ now: NOW }), level: 'info', destination }));
    log.infoMissing({ orderId: ORDER });
    log.accountUnsaved({ orderId: ORDER, reason: 'NO_KEY' });
    log.accountUnopened({ orderId: ORDER, reason: 'ERROR' });
    const text = lines.join('');
    expect(text).toContain('payment-deposit-info-missing');
    expect(text).toContain('payment-virtual-account-unsaved');
    expect(text).toContain('payment-virtual-account-unopened');
    expect(text).toContain('"SEV2"');
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(SECRET);
  });

  test('P-T36_지표 이름표는 op·reason과 outcome이고 미리 보인다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const s = new PromPaymentDepositSignals().register(metrics.registry);
    s.fieldFailure('seal', 'NO_KEY');
    s.getPayment('ok');
    const text = await metrics.registry.metrics();
    expect(text).toContain('payment_virtual_account_field_failures_total{op="seal",reason="NO_KEY"} 1');
    expect(text).toContain('payment_virtual_account_field_failures_total{op="open",reason="ERROR"} 0');
    expect(text).toContain('payment_get_requests_total{outcome="ok"} 1');
    expect(text).toContain('payment_get_requests_total{outcome="not_found"} 0');
  });
});

describe('GetPayment', () => {
  test('P-T36_찾을 값은 결제 ID나 주문 ID 하나다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseGetPaymentKey(PAYMENT, undefined)).toEqual({ kind: 'paymentId', paymentId: PAYMENT });
    expect(parseGetPaymentKey(undefined, ORDER)).toEqual({ kind: 'orderId', orderId: ORDER });
  });

  test.each([
    ['둘 다 없음', undefined, undefined],
    ['둘 다 있음', PAYMENT, ORDER],
    ['결제 ID 모양이 틀림', 'nope', undefined],
    ['주문 ID 모양이 틀림', undefined, 'ABC'],
  ])('P-T36_틀린 입력은 PaymentInputError다: %s [ASVS v5.0.0-2.2.1]', (_n, p, o) => {
    expect(() => parseGetPaymentKey(p, o)).toThrow(PaymentInputError);
  });

  function useCase(row: Record<string, unknown> | undefined, cipher: VirtualAccountCipher, nowMs = NOW) {
    const depositLog = { infoMissing: vi.fn(), accountUnsaved: vi.fn(), accountUnopened: vi.fn() } satisfies PaymentDepositLog;
    const depositSignals = { fieldFailure: vi.fn() } satisfies PaymentDepositSignals;
    const signals = { getPayment: vi.fn() };
    const reader = { getDetail: vi.fn(async () => row as never) };
    return { uc: new GetPaymentDetail({ reader, signals, cipher, depositLog, depositSignals, clock: fakeClock({ now: nowMs }) }), depositLog, depositSignals, signals, reader };
  }
  const BASE = { paymentId: PAYMENT, orderId: ORDER, pg: 'TOSS', status: 'AWAITING_DEPOSIT', amount: AMOUNT };

  test('P-T36 ③_입금 대기면 은행·계좌번호·기한을 연다 [ASVS v5.0.0-11.3.3]', async () => {
    const cipher = new LocalVirtualAccountCipher(randomBytes(32));
    const sealed = await cipher.seal(PAYMENT, ACCOUNT);
    const h = useCase({ ...BASE, virtualAccountBank: '20', virtualAccountNoSealed: sealed, depositDueAtMs: DUE }, cipher);
    await expect(h.uc.execute({ orderId: ORDER })).resolves.toEqual({ ...BASE, cancelledAmount: 0, virtualAccount: { bank: '20', accountNumber: ACCOUNT, dueAtMs: DUE } });
    expect(h.signals.getPayment).toHaveBeenCalledWith('ok');
  });

  test.each([
    ['기한과 같은 시각', DUE],
    ['기한 뒤', DUE + 1],
  ])('P-T36_리뷰 고침 L7: 입금 기한이 지나면(%s) 계좌번호를 빼고 열지도 않는다 [ASVS v5.0.0-14.2.7]', async (_n, now) => {
    const cipher = new LocalVirtualAccountCipher(randomBytes(32));
    const open = vi.spyOn(cipher, 'open');
    const sealed = await cipher.seal(PAYMENT, ACCOUNT);
    const h = useCase({ ...BASE, virtualAccountBank: '20', virtualAccountNoSealed: sealed, depositDueAtMs: DUE }, cipher, now);
    expect((await h.uc.execute({ orderId: ORDER })).virtualAccount).toEqual({ bank: '20', dueAtMs: DUE });
    expect(open).not.toHaveBeenCalled();
  });

  test('P-T36_리뷰 고침 M5: 은행 없이 저장한 입금 대기도 번호·기한을 돌려준다', async () => {
    const cipher = new LocalVirtualAccountCipher(randomBytes(32));
    const sealed = await cipher.seal(PAYMENT, ACCOUNT);
    const h = useCase({ ...BASE, virtualAccountNoSealed: sealed, depositDueAtMs: DUE }, cipher);
    expect((await h.uc.execute({ orderId: ORDER })).virtualAccount).toEqual({ accountNumber: ACCOUNT, dueAtMs: DUE });
  });

  test('P-T36_리뷰 고침 M5: 아무 칸도 저장하지 못했으면 가상계좌 칸이 없다', async () => {
    const h = useCase({ ...BASE }, new NoKeyVirtualAccountCipher());
    expect(await h.uc.execute({ orderId: ORDER })).not.toHaveProperty('virtualAccount');
  });

  test('P-T36_열지 못하면 계좌번호 칸만 비운다 [ASVS v5.0.0-16.3.3]', async () => {
    const h = useCase({ ...BASE, virtualAccountBank: '20', virtualAccountNoSealed: 'bad', depositDueAtMs: DUE }, new LocalVirtualAccountCipher(randomBytes(32)));
    const r = await h.uc.execute({ orderId: ORDER });
    expect(r.virtualAccount).toEqual({ bank: '20', dueAtMs: DUE });
    expect(h.depositSignals.fieldFailure).toHaveBeenCalledWith('open', 'ERROR');
    expect(h.depositLog.accountUnopened).toHaveBeenCalledWith({ orderId: ORDER, reason: 'ERROR' });
  });

  test('P-T36_키가 없으면 열지 않고 계좌번호 칸만 비운다', async () => {
    const h = useCase({ ...BASE, virtualAccountBank: '20', virtualAccountNoSealed: 'x' }, new NoKeyVirtualAccountCipher());
    expect((await h.uc.execute({ orderId: ORDER })).virtualAccount).toEqual({ bank: '20' });
    expect(h.depositSignals.fieldFailure).toHaveBeenCalledWith('open', 'NO_KEY');
  });

  test('P-T36_저장하지 않은 계좌는 열 것이 없어 지표가 오르지 않는다', async () => {
    const h = useCase({ ...BASE, virtualAccountBank: '20' }, new LocalVirtualAccountCipher(randomBytes(32)));
    expect((await h.uc.execute({ orderId: ORDER })).virtualAccount).toEqual({ bank: '20' });
    expect(h.depositSignals.fieldFailure).not.toHaveBeenCalled();
  });

  test('P-T36_입금 대기가 아니면 가상계좌 칸이 없다', async () => {
    const h = useCase({ ...BASE, status: 'APPROVED', approvedAtMs: NOW }, new NoKeyVirtualAccountCipher());
    await expect(h.uc.execute({ paymentId: PAYMENT })).resolves.toEqual({ ...BASE, status: 'APPROVED', approvedAtMs: NOW, cancelledAmount: 0 });
  });

  test('P-T36_없는 결제는 PaymentNotFoundError다', async () => {
    const h = useCase(undefined, new NoKeyVirtualAccountCipher());
    await expect(h.uc.execute({ orderId: ORDER })).rejects.toBeInstanceOf(PaymentNotFoundError);
    expect(h.signals.getPayment).toHaveBeenCalledWith('not_found');
  });

  test('P-T36_틀린 입력은 저장소를 부르지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const h = useCase(undefined, new NoKeyVirtualAccountCipher());
    await expect(h.uc.execute({})).rejects.toBeInstanceOf(PaymentInputError);
    expect(h.reader.getDetail).not.toHaveBeenCalled();
    expect(h.signals.getPayment).toHaveBeenCalledWith('invalid');
  });

  test('P-T36_응답은 proto 칸 이름과 앞머리를 쓴다', () => {
    const r = getPaymentResponseOf({ paymentId: PAYMENT, orderId: ORDER, pg: 'TOSS', status: 'AWAITING_DEPOSIT', amount: AMOUNT, cancelledAmount: 0, virtualAccount: { bank: '20', accountNumber: ACCOUNT, dueAtMs: DUE } });
    expect(r).toEqual({
      payment_id: PAYMENT,
      order_id: ORDER,
      pg: 'PG_PROVIDER_TOSS',
      status: 'PAYMENT_STATUS_AWAITING_DEPOSIT',
      amount: { krw: AMOUNT },
      cancelled_amount: { krw: 0 },
      virtual_account: { bank: '20', account_number: ACCOUNT, due_at: { seconds: Math.floor(DUE / 1000), nanos: 0 } },
    });
  });

  test('P-T36_값이 없는 칸은 싣지 않는다', () => {
    const r = getPaymentResponseOf({ paymentId: PAYMENT, orderId: ORDER, pg: 'TOSS', status: 'APPROVED', amount: AMOUNT, cancelledAmount: 0, approvedAtMs: NOW });
    expect(r).not.toHaveProperty('virtual_account');
    expect(r.approved_at).toEqual({ seconds: Math.floor(NOW / 1000), nanos: 0 });
  });
});

describe('값 검사', () => {
  it('어댑터 대응표의 은행 코드는 글자 그대로다(코드를 은행 이름으로 바꾸지 않는다)', () => {
    expect(tossVirtualAccountOf(tossBody())?.bank).toBe('20');
  });
});
