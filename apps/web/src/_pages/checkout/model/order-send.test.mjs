// IR-24 주문 생성 생산 경로 시험(2026-11-24). `/v1/orders`에는 경로에 회차가 없어
// 결제 화면이 아는 회차 ID를 `x-peaket-event-id` 머리로 싣는다. 시험이 머리를 직접 넣지 않고 화면이 부르는 함수가 싣는지 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { sendOrder } = await import('./order-send.ts');

const purchase = { jti: 'jti', clientPublicKey: 'key', admissionToken: 'token', run: async () => undefined, end: async () => undefined };

test('IR-24 주문 생성 보내기가 회차 ID를 x-peaket-event-id로 싣는다', async () => {
  const calls = [];
  const client = {
    async send(op, o) {
      calls.push({ op: op.operationId, o });
      return { data: { orderId: 'order-1', amount: 1000 }, status: 201, headers: new Headers() };
    },
  };
  await sendOrder(client, { eventId: 'event-1', body: { holdId: 'hold-1' }, idempotencyKey: 'key-1', purchase });
  assert.equal(calls[0].op, 'createOrder');
  assert.deepEqual(calls[0].o.headers, { 'x-peaket-event-id': 'event-1' });
  assert.equal(calls[0].o.purchase, purchase);
});

test('IR-24 결제 화면이 주문 생성 보내기에 회차 ID를 넘긴다', () => {
  const live = readFileSync(new URL('../ui/CheckoutLive.tsx', import.meta.url), 'utf8');
  assert.match(live, /sendOrder(?:<[^>]*>)?\(client, \{[\s\S]*?eventId/);
});
