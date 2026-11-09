// 시뮬레이터의 가상계좌(docs/features/payment.md §6 '입금 확인의 첫 구현' 시뮬레이터, BUILD_ORDER HOT-151, P-T36).
import { afterEach, describe, expect, it } from 'vitest';
import { buildSimulatorApp, type SimulatorApp } from '../src/index.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const AUTH = { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` };
const ORDER = '0195f3a0-0000-7000-8000-000000000011';
const AMOUNT = 12_000;
const START = Date.parse('2026-11-09T01:00:00.000Z');

const apps: SimulatorApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function start() {
  const app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => START }, confirmLatency: { kind: 'none' } });
  apps.push(app);
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { ...AUTH, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {} };
  };
  const issue = async () => {
    const a = await call('POST', '/sim/authenticate', { orderId: ORDER, amount: AMOUNT, method: '가상계좌' });
    const paymentKey = a.body.paymentKey as string;
    const confirmed = await call('POST', '/v1/payments/confirm', { paymentKey, orderId: ORDER, amount: AMOUNT });
    return { paymentKey, confirmed };
  };
  return { call, issue };
}

describe('가상계좌 발급', () => {
  it('P-T36_승인은 WAITING_FOR_DEPOSIT이고 계좌·기한·secret을 준다', async () => {
    const { issue } = start();
    const { confirmed } = await issue();
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'WAITING_FOR_DEPOSIT', approvedAt: null, method: '가상계좌' });
    const va = confirmed.body.virtualAccount as { accountNumber: string; bankCode: string; dueDate: string };
    expect(va.accountNumber).toMatch(/^\d+$/);
    expect(va.bankCode).toMatch(/^\d{2}$/);
    expect(Date.parse(va.dueDate)).toBe(START + 3 * 86_400_000);
    expect(typeof confirmed.body.secret).toBe('string');
  });

  it('P-T36_카드 결제에는 가상계좌 칸이 없다', async () => {
    const { call } = start();
    const a = await call('POST', '/sim/authenticate', { orderId: ORDER, amount: AMOUNT });
    const r = await call('POST', '/v1/payments/confirm', { paymentKey: a.body.paymentKey, orderId: ORDER, amount: AMOUNT });
    expect(r.body.status).toBe('DONE');
    expect(r.body.virtualAccount).toBeNull();
    expect(r.body.secret).toBeNull();
  });

  it('P-T36_다시 승인하면 이미 처리됨이다', async () => {
    const { call, issue } = start();
    const { paymentKey } = await issue();
    const again = await call('POST', '/v1/payments/confirm', { paymentKey, orderId: ORDER, amount: AMOUNT });
    expect(again.body.code).toBe('ALREADY_PROCESSED_PAYMENT');
  });

  it('P-T36_조회도 입금 대기와 계좌를 보여 준다(기한이 지나도 상태가 그대로다)', async () => {
    const { call, issue } = start();
    const { paymentKey } = await issue();
    const q = await call('GET', `/v1/payments/${paymentKey}`);
    expect(q.body.status).toBe('WAITING_FOR_DEPOSIT');
    expect((q.body.virtualAccount as { bankCode: string }).bankCode).toMatch(/^\d{2}$/);
  });
});

describe('입금과 만료 제어', () => {
  it('P-T36_입금하면 DONE·승인 시각이고 입금 통보 본문이 쌓인다', async () => {
    const { call, issue } = start();
    const { paymentKey, confirmed } = await issue();
    const r = await call('POST', `/sim/deposits/${paymentKey}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('DONE');
    expect(r.body.approvedAt).not.toBeNull();
    const q = await call('GET', `/v1/payments/${paymentKey}`);
    expect(q.body.status).toBe('DONE');
    const callbacks = (await call('GET', `/sim/deposit-callbacks?orderId=${ORDER}`)).body as unknown as Array<Record<string, unknown>>;
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({ orderId: ORDER, status: 'DONE', secret: confirmed.body.secret });
    expect(typeof callbacks[0]!.transactionKey).toBe('string');
  });

  it('P-T36_입금은 승인 원장(ledger)에 한 건이다', async () => {
    const { call, issue } = start();
    const { paymentKey } = await issue();
    await call('POST', `/sim/deposits/${paymentKey}`);
    const raw = await apps[0]!.inject({ method: 'GET', url: '/sim/ledger', headers: AUTH });
    expect(raw.body.trim().split('\n')).toHaveLength(1);
  });

  it('P-T36_입금 대기가 아니면 입금할 수 없다', async () => {
    const { call, issue } = start();
    const { paymentKey } = await issue();
    await call('POST', `/sim/deposits/${paymentKey}`);
    expect((await call('POST', `/sim/deposits/${paymentKey}`)).status).toBe(400);
  });

  it('P-T36_없는 결제는 404다', async () => {
    const { call } = start();
    expect((await call('POST', '/sim/deposits/none')).status).toBe(404);
  });

  it('P-T36_결제사 쪽 만료를 만들면 조회가 EXPIRED이고 입금 통보는 없다', async () => {
    const { call, issue } = start();
    const { paymentKey } = await issue();
    expect((await call('POST', `/sim/deposits/${paymentKey}/expire`)).body.status).toBe('EXPIRED');
    expect((await call('GET', `/v1/payments/${paymentKey}`)).body.status).toBe('EXPIRED');
    expect(((await call('GET', '/sim/deposit-callbacks')).body as unknown as unknown[]).length).toBe(0);
  });

  it('P-T36_초기화하면 입금 통보도 지운다', async () => {
    const { call, issue } = start();
    const { paymentKey } = await issue();
    await call('POST', `/sim/deposits/${paymentKey}`);
    await apps[0]!.inject({ method: 'POST', url: '/sim/reset', headers: AUTH });
    expect(((await call('GET', '/sim/deposit-callbacks')).body as unknown as unknown[]).length).toBe(0);
  });
});

describe('포트원 모양', () => {
  it('P-T36_입금 대기는 VIRTUAL_ACCOUNT_ISSUED이고 method에 계좌·기한이 있다', async () => {
    const { call } = start();
    const a = await apps[0]!.inject({ method: 'POST', url: '/sim/portone/authenticate', headers: { ...AUTH, 'content-type': 'application/json' }, payload: JSON.stringify({ orderId: ORDER, amount: AMOUNT, method: '가상계좌' }) });
    const { paymentId, paymentToken, txId } = JSON.parse(a.body) as { paymentId: string; paymentToken: string; txId: string };
    const portoneAuth = { authorization: `PortOne ${KEY}`, 'content-type': 'application/json' };
    const confirm = await apps[0]!.inject({ method: 'POST', url: `/payments/${paymentId}/confirm`, headers: portoneAuth, payload: JSON.stringify({ paymentToken, txId, totalAmount: AMOUNT, currency: 'KRW', isTest: true }) });
    expect(confirm.statusCode).toBe(200);
    // P-T36_리뷰 고침 L10: 입금 전 승인 답에는 paidAt이 없다
    expect(JSON.parse(confirm.body)).not.toHaveProperty('paidAt');
    expect(JSON.parse(confirm.body).pgTxId).toEqual(expect.any(String));
    const q = await apps[0]!.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: { authorization: `PortOne ${KEY}` } });
    const view = JSON.parse(q.body) as { status: string; method: Record<string, unknown>; amount: { paid: number } };
    expect(view.status).toBe('VIRTUAL_ACCOUNT_ISSUED');
    expect(view.amount.paid).toBe(0);
    expect(view.method).toMatchObject({ type: 'PaymentMethodVirtualAccount', accountNumber: expect.any(String), bank: expect.any(String), expiredAt: expect.any(String) });
    expect(call).toBeDefined();
  });
});
