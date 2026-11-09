// 시뮬레이터의 거래 목록(BUILD_ORDER HOT-153, docs/features/payment.md §8 '대사의 첫 구현'): 토스 모양 `GET /v1/transactions`, 포트원 모양 `GET /payments-by-cursor`, 시험 씨앗 `POST /sim/transactions/seed`.
import { afterEach, describe, expect, it } from 'vitest';
import { buildSimulatorApp, type SimulatorApp } from '../src/index.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const BASIC = { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` };
const PORTONE = { authorization: `PortOne ${KEY}` };
const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const DAY = '2026-11-09';
const AT = KST(`${DAY}T12:00:00`);

const apps: SimulatorApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function make(): SimulatorApp {
  const app = buildSimulatorApp({ secretKey: KEY, clock: { now: () => AT }, seed: 7, confirmLatency: { kind: 'none' } });
  apps.push(app);
  return app;
}

const seed = async (app: SimulatorApp, items: object[]) => {
  const r = await app.inject({ method: 'POST', url: '/sim/transactions/seed', headers: BASIC, payload: { items } });
  expect(r.statusCode).toBe(200);
};

describe('거래 목록', () => {
  it('토스 모양: 승인과 취소가 거래마다 한 줄이고 시각 차례다', async () => {
    const app = make();
    await seed(app, [
      { paymentKey: 'pk-b', orderId: 'order-bbb', amount: 2000, status: 'CANCELED', atMs: AT + 5000 },
      { paymentKey: 'pk-a', orderId: 'order-aaa', amount: 1000, status: 'DONE', atMs: AT },
    ]);
    const r = await app.inject({ method: 'GET', url: `/v1/transactions?startDate=${DAY}T00:00:00&endDate=2026-11-10T00:00:00&limit=10`, headers: BASIC });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { paymentKey: string; status: string; amount: number; orderId: string; transactionKey: string; transactionAt: string }[];
    expect(body.map((x) => [x.paymentKey, x.status])).toEqual([
      ['pk-a', 'DONE'],
      ['pk-b', 'DONE'],
      ['pk-b', 'CANCELED'],
    ]);
    expect(body[0]).toMatchObject({ orderId: 'order-aaa', amount: 1000, transactionAt: '2026-11-09T12:00:00.000+09:00' });
    expect(new Set(body.map((x) => x.transactionKey)).size).toBe(3);
  });

  it('토스 모양: 범위 밖은 빼고 startingAfter로 나눠 읽는다', async () => {
    const app = make();
    await seed(app, [
      { paymentKey: 'pk-1', orderId: 'order-111', amount: 1000, status: 'DONE', atMs: AT },
      { paymentKey: 'pk-2', orderId: 'order-222', amount: 1000, status: 'DONE', atMs: AT + 1000 },
      { paymentKey: 'pk-out', orderId: 'order-out', amount: 1000, status: 'DONE', atMs: KST('2026-11-08T23:00:00') },
    ]);
    const url = `/v1/transactions?startDate=${DAY}T00:00:00&endDate=2026-11-10T00:00:00&limit=1`;
    const first = (await app.inject({ method: 'GET', url, headers: BASIC })).json() as { paymentKey: string; transactionKey: string }[];
    expect(first.map((x) => x.paymentKey)).toEqual(['pk-1']);
    const next = (await app.inject({ method: 'GET', url: `${url}&startingAfter=${first[0]!.transactionKey}`, headers: BASIC })).json() as { paymentKey: string }[];
    expect(next.map((x) => x.paymentKey)).toEqual(['pk-2']);
  });

  it('포트원 모양: 결제 한 건이 한 줄이고(최종 상태) cursor로 나눠 읽는다', async () => {
    const app = make();
    await seed(app, [
      { paymentKey: 'pay-order-111', orderId: 'order-111', amount: 1000, status: 'CANCELED', atMs: AT },
      { paymentKey: 'pay-order-222', orderId: 'order-222', amount: 2000, status: 'DONE', atMs: AT + 1000 },
    ]);
    const url = `/payments-by-cursor?storeId=store-sim&from=${encodeURIComponent(new Date(KST(`${DAY}T00:00:00`)).toISOString())}&until=${encodeURIComponent(new Date(KST('2026-11-10T00:00:00')).toISOString())}&size=1`;
    const first = (await app.inject({ method: 'GET', url, headers: PORTONE })).json() as { items: { id: string; status: string; amount: { total: number }; statusChangedAt: string }[]; cursor?: string };
    expect(first.items).toMatchObject([{ id: 'pay-order-111', status: 'CANCELLED', amount: { total: 1000 }, statusChangedAt: '2026-11-09T12:00:00.000+09:00' }]);
    expect(first.cursor).toBeTypeOf('string');
    const second = (await app.inject({ method: 'GET', url: `${url}&cursor=${first.cursor}`, headers: PORTONE })).json() as { items: { id: string; status: string }[]; cursor?: string };
    expect(second.items).toMatchObject([{ id: 'pay-order-222', status: 'PAID' }]);
    expect(second.cursor).toBeUndefined();
  });

  it('포트원 경로는 포트원 인증을 요구하고 다른 상점이면 빈 답이다', async () => {
    const app = make();
    await seed(app, [{ paymentKey: 'pay-order-111', orderId: 'order-111', amount: 1000, status: 'DONE', atMs: AT }]);
    expect((await app.inject({ method: 'GET', url: '/payments-by-cursor?from=2026-11-09T00:00:00.000Z&until=2026-11-10T00:00:00.000Z', headers: BASIC })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/payments-by-cursor?storeId=other&from=2026-11-09T00:00:00.000Z&until=2026-11-10T00:00:00.000Z', headers: PORTONE });
    expect(r.json()).toEqual({ items: [] });
  });

  it('씨앗: 넣은 결제를 단독 조회로 볼 수 있다', async () => {
    const app = make();
    await seed(app, [{ paymentKey: 'pk-a', orderId: 'order-aaa', amount: 1000, status: 'PARTIAL_CANCELED', atMs: AT }]);
    const r = (await app.inject({ method: 'GET', url: '/v1/payments/pk-a', headers: BASIC })).json() as { status: string; balanceAmount: number };
    expect(r).toMatchObject({ status: 'PARTIAL_CANCELED', balanceAmount: 500 });
  });
});
