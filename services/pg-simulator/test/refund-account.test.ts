// 시뮬레이터의 가상계좌 환불 계좌(BUILD_ORDER GAT-090, BAT-420-rest, P-T71, 시험 담당 l3-b420-test).
// 정본: docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'(계좌 칸 모양 ②, 토스 계좌 거절 코드 ③, 시뮬레이터는 토스 코드),
// docs/review/plans/BAT-420-rest.md §4 'services/pg-simulator/src/server.ts'(계좌 없는 가상계좌 취소는 업무 거절, 계좌번호 000으로 시작은 계좌 거절 — 시험용 규칙 [가정]).
// 토스 모양(refundReceiveAccount)과 포트원 모양(refundAccount) 두 경로를 본다. 계좌는 저장하지 않으므로 원장(ledger)·조회 답에 계좌 글이 없어야 한다.
import { afterEach, describe, expect, it } from 'vitest';
import { buildSimulatorApp, type SimulatorApp } from '../src/index.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const BASIC = { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` };
const PORTONE = { authorization: `PortOne ${KEY}` };
const START = Date.parse('2026-11-19T01:00:00.000Z');
const AMOUNT = 54_000;
/** 다른 값과 겹치지 않는 시험 계좌(정본 '계좌 글 누설 검사', 계획 §5) */
const ACCOUNT_NO = '110987654321';
const HOLDER = '김환불';

const apps: SimulatorApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

let seq = 0;
const orderId = () => `0195f3a0-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

function start() {
  const app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => START }, confirmLatency: { kind: 'none' } });
  apps.push(app);
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = BASIC) => {
    const r = await app.inject({ method, url, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    return { status: r.statusCode, body: parsed, raw: r.body };
  };
  /** 토스 모양: 인증 → 승인(입금 대기) → 입금(DONE) */
  const tossVirtual = async (deposit = true) => {
    const id = orderId();
    const a = await call('POST', '/sim/authenticate', { orderId: id, amount: AMOUNT, method: '가상계좌' });
    const paymentKey = a.body.paymentKey as string;
    expect((await call('POST', '/v1/payments/confirm', { paymentKey, orderId: id, amount: AMOUNT })).body.status).toBe('WAITING_FOR_DEPOSIT');
    if (deposit) expect((await call('POST', `/sim/deposits/${paymentKey}`)).body.status).toBe('DONE');
    return paymentKey;
  };
  const tossCard = async () => {
    const id = orderId();
    const a = await call('POST', '/sim/authenticate', { orderId: id, amount: AMOUNT });
    const paymentKey = a.body.paymentKey as string;
    expect((await call('POST', '/v1/payments/confirm', { paymentKey, orderId: id, amount: AMOUNT })).body.status).toBe('DONE');
    return paymentKey;
  };
  const tossCancel = (paymentKey: string, body: Record<string, unknown>, idem: string) => call('POST', `/v1/payments/${paymentKey}/cancel`, body, { ...BASIC, 'idempotency-key': idem });
  /** 포트원 모양: 인증(가상계좌) → 승인 → 입금 */
  const portoneVirtual = async () => {
    const id = orderId();
    const a = await call('POST', '/sim/portone/authenticate', { orderId: id, amount: AMOUNT, orderName: '공연 티켓', method: '가상계좌' });
    expect(a.status).toBe(200);
    const { paymentId, paymentToken } = a.body as { paymentId: string; paymentToken: string };
    const c = await call('POST', `/payments/${paymentId}/confirm`, { paymentToken, totalAmount: AMOUNT, currency: 'KRW', isTest: true }, { ...PORTONE, 'idempotency-key': `"confirm-${id}"` });
    expect(c.status).toBe(200);
    expect((await call('POST', `/sim/deposits/${paymentId}`)).body.status).toBe('DONE');
    return paymentId;
  };
  const portoneCancel = (paymentId: string, body: Record<string, unknown>, idem: string) => call('POST', `/payments/${paymentId}/cancel`, body, { ...PORTONE, 'idempotency-key': `"${idem}"` });
  const ledger = async () => (await app.inject({ method: 'GET', url: '/sim/ledger', headers: BASIC })).body;
  return { call, tossVirtual, tossCard, tossCancel, portoneVirtual, portoneCancel, ledger };
}

const account = (accountNumber = ACCOUNT_NO) => ({ bank: '88', accountNumber, holderName: HOLDER });

describe('P-T71 시뮬레이터 토스 모양 가상계좌 환불 계좌(refundReceiveAccount)', () => {
  it('P-T71 ① 입금된 가상계좌 결제에 계좌를 실은 부분 취소는 200 PARTIAL_CANCELED·잔액 54,000 − 20,000 = 34,000이고 조회·원장에 계좌 글이 없다', async () => {
    const s = start();
    const key = await s.tossVirtual();
    const r = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 20_000, refundReceiveAccount: account() }, 'cancel-va-1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'PARTIAL_CANCELED', balanceAmount: 34_000 });
    const q = await s.call('GET', `/v1/payments/${key}`);
    expect(q.body).toMatchObject({ balanceAmount: 34_000 });
    for (const text of [r.raw, q.raw, await s.ledger()]) {
      expect(text).not.toContain(ACCOUNT_NO);
      expect(text).not.toContain(HOLDER);
    }
  });

  it('P-T71 ② 입금된 가상계좌 결제를 계좌 없이 취소하면 400 INVALID_REQUEST이고 잔액이 그대로다(돈이 나가지 않는다)', async () => {
    const s = start();
    const key = await s.tossVirtual();
    const r = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 20_000 }, 'cancel-va-2');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_REQUEST');
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ status: 'DONE', balanceAmount: AMOUNT });
  });

  it('P-T71 ④ 계좌번호가 000으로 시작하면 400 INVALID_REFUND_ACCOUNT_NUMBER(토스 계좌 거절 코드)이고 잔액이 그대로다. 001로 시작하면 받는다(경계)', async () => {
    const s = start();
    const key = await s.tossVirtual();
    const bad = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 1_000, refundReceiveAccount: account('000123456789') }, 'cancel-va-3');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_REFUND_ACCOUNT_NUMBER');
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ status: 'DONE', balanceAmount: AMOUNT });
    const ok = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 1_000, refundReceiveAccount: account('001123456789') }, 'cancel-va-4');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ balanceAmount: 53_000 });
  });

  it('P-T71 계좌 칸 모양: 하이픈이 든 계좌번호·빠진 예금주·21자는 스키마 400이다(숫자 1~20자, 정본 ②)', async () => {
    const s = start();
    const key = await s.tossVirtual();
    const hyphen = await s.tossCancel(key, { cancelReason: '관객 취소', refundReceiveAccount: { bank: '88', accountNumber: '110-987-654321', holderName: HOLDER } }, 'cancel-va-5');
    expect(hyphen.status).toBe(400);
    const missing = await s.tossCancel(key, { cancelReason: '관객 취소', refundReceiveAccount: { bank: '88', accountNumber: ACCOUNT_NO } }, 'cancel-va-7');
    expect(missing.status).toBe(400);
    const tooLong = await s.tossCancel(key, { cancelReason: '관객 취소', refundReceiveAccount: account('1'.repeat(21)) }, 'cancel-va-8');
    expect(tooLong.status).toBe(400);
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ balanceAmount: AMOUNT });
  });

  it('P-T71 ③ 같은 멱등키에 계좌가 다른 본문은 422 IDEMPOTENCY_KEY_REUSED이고, 같은 본문이면 처음 답 그대로다(돈은 한 번)', async () => {
    const s = start();
    const key = await s.tossVirtual();
    const first = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 10_000, refundReceiveAccount: account() }, 'cancel-va-9');
    expect(first.status).toBe(200);
    const same = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 10_000, refundReceiveAccount: account() }, 'cancel-va-9');
    expect(same.raw).toBe(first.raw);
    const other = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 10_000, refundReceiveAccount: account('220987654321') }, 'cancel-va-9');
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ balanceAmount: 44_000 });
  });

  it('P-T71 ⑤ 카드 결제는 계좌 없이 취소된다(시뮬레이터 규칙은 가상계좌에만 걸린다)', async () => {
    const s = start();
    const key = await s.tossCard();
    const r = await s.tossCancel(key, { cancelReason: '관객 취소', cancelAmount: 4_000 }, 'cancel-card-1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ balanceAmount: 50_000 });
  });
});

describe('P-T71 시뮬레이터 포트원 모양 가상계좌 환불 계좌(refundAccount)', () => {
  it('P-T71 ① 포트원 refundAccount(bank·number·holderName)를 실은 취소는 200 SUCCEEDED이고 금액 15,000이 빠진다', async () => {
    const s = start();
    const id = await s.portoneVirtual();
    const r = await s.portoneCancel(id, { reason: '관객 취소', amount: 15_000, currentCancellableAmount: AMOUNT, refundAccount: { bank: 'SHINHAN', number: ACCOUNT_NO, holderName: HOLDER } }, 'cancel-portone-va-0001');
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toMatchObject({ cancellation: { status: 'SUCCEEDED', totalAmount: 15_000 } });
    expect(r.raw).not.toContain(ACCOUNT_NO);
    expect((await s.call('GET', `/v1/payments/${id}`)).body).toMatchObject({ balanceAmount: 39_000 });
  });

  it('P-T71 ② 포트원 모양도 계좌 없는 가상계좌 취소는 거절이고 잔액이 그대로다', async () => {
    const s = start();
    const id = await s.portoneVirtual();
    const r = await s.portoneCancel(id, { reason: '관객 취소', amount: 15_000, currentCancellableAmount: AMOUNT }, 'cancel-portone-va-0002');
    expect(r.status).toBe(400);
    expect((await s.call('GET', `/v1/payments/${id}`)).body).toMatchObject({ balanceAmount: AMOUNT });
  });

  it('P-T71 ④ 포트원 모양도 000으로 시작하는 계좌번호는 거절이고 잔액이 그대로다. 토스 모양 칸 이름(accountNumber)은 스키마 400이다', async () => {
    const s = start();
    const id = await s.portoneVirtual();
    const bad = await s.portoneCancel(id, { reason: '관객 취소', amount: 15_000, currentCancellableAmount: AMOUNT, refundAccount: { bank: 'SHINHAN', number: '000987654321', holderName: HOLDER } }, 'cancel-portone-va-0003');
    expect(bad.status).toBe(400);
    const wrongShape = await s.portoneCancel(id, { reason: '관객 취소', amount: 15_000, currentCancellableAmount: AMOUNT, refundAccount: { bank: 'SHINHAN', accountNumber: ACCOUNT_NO, holderName: HOLDER } }, 'cancel-portone-va-0004');
    expect(wrongShape.status).toBe(400);
    expect((await s.call('GET', `/v1/payments/${id}`)).body).toMatchObject({ balanceAmount: AMOUNT });
  });
});
