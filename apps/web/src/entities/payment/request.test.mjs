// IR-17 결제 생산 경로 시험(2026-11-24). 결제 시도·접수는 주소에 회차가 없어, 팬 웹이 아는 회차 ID를
// `x-peaket-event-id` 머리로 싣는다. 시험이 머리를 직접 넣지 않고 화면이 부르는 보내기 함수가 싣는지 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { sendPaymentAcceptance, sendPaymentAttempt } = await import('./request.ts');

const purchase = { jti: 'jti', clientPublicKey: 'key', admissionToken: 'token', run: async () => undefined, end: async () => undefined };

test('IR-17 결제 시도·접수 보내기가 같은 회차 ID를 x-peaket-event-id로 싣는다', async () => {
  const calls = [];
  const client = {
    async send(op, o) {
      calls.push({ op: op.operationId, o });
      return { data: {}, status: 200, headers: new Headers() };
    },
  };
  await sendPaymentAttempt(client, { eventId: 'event-1', orderId: 'order-1', body: { payMethod: 'CARD' }, idempotencyKey: 'key-1', purchase });
  await sendPaymentAcceptance(client, { eventId: 'event-1', orderId: 'order-1', body: { pg: 'TOSS' }, idempotencyKey: 'key-2', purchase });
  assert.deepEqual(
    calls.map((c) => c.op),
    ['createOrderPayment', 'createOrderPaymentAcceptance'],
  );
  for (const c of calls) {
    assert.equal(c.o.params.orderId, 'order-1');
    assert.deepEqual(c.o.headers, { 'x-peaket-event-id': 'event-1' });
    assert.equal(c.o.purchase, purchase);
  }
});

test('IR-17 결제 화면 두 곳이 그 보내기 함수에 회차 ID를 넘긴다', () => {
  const live = readFileSync(new URL('../../_pages/checkout/ui/CheckoutLive.tsx', import.meta.url), 'utf8');
  const back = readFileSync(new URL('../../_pages/checkout-return/ui/CheckoutReturnLive.tsx', import.meta.url), 'utf8');
  assert.match(live, /sendPaymentAttempt(?:<[^>]*>)?\(client, \{[\s\S]*?eventId/);
  assert.match(back, /sendPaymentAcceptance(?:<[^>]*>)?\(client, \{[\s\S]*?eventId/);
});
