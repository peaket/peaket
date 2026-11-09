// 시뮬레이터의 시험 카드·결제 수단 고르기(P-T16·P-T50의 시뮬레이터 몫, BUILD_ORDER HOT-145, docs/features/payment.md §2.1).
// 토스 모양은 Payment.card, 포트원 모양은 method.card(공식 스키마의 칸)로 답한다.
import { afterEach, describe, expect, it } from 'vitest';
import { buildSimulatorApp, type SimulatorApp } from '../src/index.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const BASIC = { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` };
const PORTONE = { authorization: `PortOne ${KEY}` };
const ORDER = '0195f3a0-0000-7000-8000-000000000001';
const IDEM = `"confirm-${ORDER}"`;

let app: SimulatorApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(): Promise<SimulatorApp> {
  app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => Date.parse('2026-11-09T01:00:00.000Z') }, confirmLatency: { kind: 'none' } });
  await app.ready();
  return app;
}

async function tossPay(a: SimulatorApp, extra: Record<string, unknown>) {
  const auth = await a.inject({ method: 'POST', url: '/sim/authenticate', headers: BASIC, payload: { orderId: ORDER, amount: 10_000, ...extra } });
  expect(auth.statusCode).toBe(200);
  const { paymentKey } = auth.json<{ paymentKey: string }>();
  const r = await a.inject({ method: 'POST', url: '/v1/payments/confirm', headers: { ...BASIC, 'idempotency-key': 'confirm-a' }, payload: { paymentKey, orderId: ORDER, amount: 10_000 } });
  expect(r.statusCode).toBe(200);
  return r.json<Record<string, unknown>>();
}

async function portonePay(a: SimulatorApp, extra: Record<string, unknown>) {
  const auth = await a.inject({ method: 'POST', url: '/sim/portone/authenticate', headers: BASIC, payload: { orderId: ORDER, amount: 10_000, ...extra } });
  expect(auth.statusCode).toBe(200);
  const { paymentId, paymentToken } = auth.json<{ paymentId: string; paymentToken: string }>();
  const r = await a.inject({ method: 'POST', url: `/payments/${paymentId}/confirm`, headers: { ...PORTONE, 'idempotency-key': IDEM }, payload: { paymentToken, totalAmount: 10_000, currency: 'KRW', isTest: true } });
  expect(r.statusCode).toBe(200);
  const q = await a.inject({ method: 'GET', url: `/payments/${paymentId}`, headers: PORTONE });
  expect(q.statusCode).toBe(200);
  return q.json<Record<string, any>>();
}

describe('토스 모양 시험 카드', () => {
  it('고른 카드가 Payment.card로 나간다(bin 칸은 토스 모양에 없다)', async () => {
    const body = await tossPay(await make(), { card: { number: '11112222****333*', issuerCode: '41', cardType: '체크' } });
    expect(body.card).toMatchObject({ number: '11112222****333*', issuerCode: '41', cardType: '체크' });
    expect(body.card).not.toHaveProperty('bin');
  });

  it('고르지 않으면 기존 합성 카드다', async () => {
    const body = await tossPay(await make(), {});
    expect(body.card).toMatchObject({ issuerCode: '61', cardType: '신용', number: expect.stringMatching(/^43301234\*{4}/) });
  });

  it.each(['계좌이체', '가상계좌'])('결제 수단 %s는 card가 null이다', async (method) => {
    const body = await tossPay(await make(), { method, card: null });
    expect(body).toMatchObject({ method, card: null });
  });
});

describe('포트원 모양 시험 카드', () => {
  it('고른 카드가 method.card로 나가고 종류는 공식 열거값이다', async () => {
    const body = await portonePay(await make(), { card: { number: '11112222****3333', issuerCode: 'SHINHAN', cardType: '체크', bin: '11112222' } });
    expect(body.method).toEqual({ type: 'PaymentMethodCard', card: { number: '11112222****3333', issuer: 'SHINHAN', type: 'DEBIT', bin: '11112222' } });
  });

  it('bin을 주지 않으면 가린 번호의 앞 8자리이고 null이면 뺀다', async () => {
    const a = await make();
    expect((await portonePay(a, { card: { number: '43301234****123*', issuerCode: '61', cardType: '신용' } })).method.card.bin).toBe('43301234');
    await a.inject({ method: 'POST', url: '/sim/reset', headers: BASIC });
    expect((await portonePay(a, { card: { number: '43301234****123*', issuerCode: '61', cardType: '신용', bin: null } })).method.card).not.toHaveProperty('bin');
  });

  it('issuerCode가 null이면 issuer 칸을 뺀다', async () => {
    expect((await portonePay(await make(), { card: { number: '43301234****123*', issuerCode: null, cardType: '신용' } })).method.card).not.toHaveProperty('issuer');
  });

  it.each([
    ['계좌이체', 'PaymentMethodTransfer'],
    ['가상계좌', 'PaymentMethodVirtualAccount'],
  ])('결제 수단 %s는 %s이고 카드가 없다', async (method, type) => {
    expect((await portonePay(await make(), { method, card: null })).method).toMatchObject({ type });
    expect((await portonePay(await make(), { method, card: null })).method).not.toHaveProperty('card');
  });
});

describe('입력 검사', () => {
  it.each([
    ['모르는 결제 수단', { method: '현금' }],
    ['카드 번호 없음', { card: { issuerCode: '61' } }],
    ['너무 긴 번호', { card: { number: '1'.repeat(21) } }],
  ])('%s면 400이다', async (_n, extra) => {
    const a = await make();
    const r = await a.inject({ method: 'POST', url: '/sim/authenticate', headers: BASIC, payload: { orderId: ORDER, amount: 10_000, ...extra } });
    expect(r.statusCode).toBe(400);
  });
});
