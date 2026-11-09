// 결제 시도·결제창의 값 시험(SCR-011, docs/frontend.md §5.3, ADR-0253·0255, BUILD_ORDER HOT-358).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { attemptIdempotencyKey, attemptOf, attemptOutcome, tossMethodAllowed } from './payment-attempt.ts';
import { orderOutcome } from './order.ts';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { tossWindow } = await import('../windows/toss.ts');
const { portoneWindow } = await import('../windows/portone.ts');
const { simulatorWindow } = await import('../windows/simulator.ts');

test('HOT-358 결제 시도 실패 대응: 503 new-payment-paused는 멈춤, 그 밖의 503은 다시 시도', () => {
  assert.deepEqual(attemptOutcome({ status: 503, type: 'new-payment-paused', extensions: { holdRemainingSeconds: 180 }, retryAfterSeconds: 5 }), { kind: 'pay-paused', holdRemainingSeconds: 180, retryAfterSeconds: 5 });
  assert.deepEqual(attemptOutcome({ status: 503, type: 'pg-unavailable' }), { kind: 'unavailable' });
  assert.equal(attemptOutcome({ status: 503 }).kind, 'unavailable');
});

test('HOT-358 모르는 코드는 성공이나 확정 실패로 단정하지 않고 다시 시도다', () => {
  assert.equal(attemptOutcome({ status: 500 }).kind, 'retry');
  assert.equal(attemptOutcome({}).kind, 'retry');
  assert.equal(attemptOutcome({ status: 409, type: 'unknown-409' }).kind, 'retry');
});

test('HOT-358 409·401·404 뜻이 서버와 같다', () => {
  assert.equal(attemptOutcome({ status: 409, type: 'payment-already-accepted' }).kind, 'already-accepted');
  assert.equal(attemptOutcome({ status: 409, type: 'order-expired' }).kind, 'order-expired');
  assert.equal(attemptOutcome({ status: 409, type: 'payment-attempts-exceeded' }).kind, 'exceeded');
  assert.equal(attemptOutcome({ status: 401, type: 'about:blank' }).kind, 'refresh');
  assert.equal(attemptOutcome({ status: 401, type: 'purchase-session-ended' }).kind, 'ended');
  assert.equal(attemptOutcome({ status: 404 }).kind, 'hold-gone');
  assert.equal(attemptOutcome({ status: 423 }).kind, 'sale-paused');
});

test('HOT-358 같은 결제수단은 같은 멱등 키, 다른 수단은 새 키', () => {
  let n = 0;
  const make = () => `k${(n += 1)}`;
  const a = attemptIdempotencyKey(null, '', make);
  assert.equal(attemptIdempotencyKey(a, '', make).key, a.key);
  assert.notEqual(attemptIdempotencyKey(a, 'CARD', make).key, a.key);
});

test('HOT-358 응답 모양이 틀리면 쓰지 않는다', () => {
  assert.equal(attemptOf({ attemptId: 'a', pg: 'OTHER', checkout: {} }), null);
  assert.equal(attemptOf(null), null);
  assert.equal(attemptOf({ attemptId: 'a', pg: 'SIMULATOR' }), null);
  assert.ok(attemptOf({ attemptId: 'a', pg: 'SIMULATOR', checkout: {} }));
});

test('HOT-358 ADR-0255 409 hold-already-ordered에 orderId가 있으면 주문을 잇고 없으면 다른 곳 진행 안내다', () => {
  assert.deepEqual(orderOutcome({ status: 409, type: 'hold-already-ordered', extensions: { orderId: 'o1' } }), { kind: 'other-tab', orderId: 'o1' });
  assert.deepEqual(orderOutcome({ status: 409, type: 'hold-already-ordered' }), { kind: 'other-tab' });
});

test('P-T9 PRF-190 토스 위젯에서 허용되지 않은 수단은 막고 모르는 값도 막는다', () => {
  assert.equal(tossMethodAllowed('VIRTUAL_ACCOUNT', ['CARD']), false);
  assert.equal(tossMethodAllowed('CARD', ['CARD']), true);
  assert.equal(tossMethodAllowed('NEW_METHOD', ['CARD']), false);
  assert.equal(tossMethodAllowed('VIRTUAL_ACCOUNT', undefined), true);
});

const tossAttempt = { attemptId: 'a1', pg: 'TOSS', allowedPayMethods: ['CARD'], checkout: { clientKey: 'k', customerKey: 'c', orderId: 'order-1', orderName: 'n', amount: 1000, successUrl: 'https://w/s', failUrl: 'https://w/f' } };

function fakeToss(method = 'CARD') {
  const calls = { requested: 0 };
  const widgets = {
    setAmount: async () => {},
    renderPaymentMethods: async () => ({ getSelectedPaymentMethod: async () => ({ method }) }),
    renderAgreement: async () => ({}),
    requestPayment: async () => {
      calls.requested += 1;
    },
  };
  return { sdk: { widgets: () => widgets }, calls };
}

test('HOT-358 토스 창: 위젯을 그린 뒤 허용된 수단이면 결제를 요청한다', async () => {
  const { sdk, calls } = fakeToss('CARD');
  const w = tossWindow(tossAttempt, async () => sdk);
  await w.mount({ methods: '#m', agreement: '#a' });
  await w.pay({});
  assert.equal(calls.requested, 1);
});

test('P-T9 HOT-358 토스 창: 고를 수 없는 수단을 고르면 결제를 요청하지 않는다', async () => {
  const { sdk, calls } = fakeToss('VIRTUAL_ACCOUNT');
  const w = tossWindow(tossAttempt, async () => sdk);
  await w.mount({ methods: '#m', agreement: '#a' });
  await assert.rejects(() => w.pay({}), (e) => e.reason === 'method-not-allowed');
  assert.equal(calls.requested, 0);
});

test('HOT-358 포트원 창: forceRedirect로 페이지 이동을 요청하고 돌아온 실패를 알린다', async () => {
  const attempt = { attemptId: 'a1', pg: 'PORTONE', allowedPayMethods: ['CARD', 'TRANSFER'], checkout: { storeId: 's', channelKey: 'c', paymentId: 'pay-o', orderName: 'n', totalAmount: 100, currency: 'KRW', redirectUrl: 'https://w/r' } };
  const seen = [];
  const w = portoneWindow(attempt, async (p) => {
    seen.push(p);
    return undefined;
  });
  await w.pay({ payMethod: 'TRANSFER' });
  assert.equal(seen[0].forceRedirect, true);
  assert.equal(seen[0].payMethod, 'TRANSFER');
  const failed = portoneWindow(attempt, async () => ({ code: 'FAILURE_TYPE_PG' }));
  await assert.rejects(() => failed.pay({}), (e) => e.reason === 'failed');
});

test('HOT-358 데모 창: 서버 경로로 인증하고 복귀 주소로 넘긴다. 비밀 키는 브라우저에 없다', async () => {
  const attempt = { attemptId: 'a1', pg: 'SIMULATOR', checkout: { clientKey: 'k', customerKey: 'c', orderId: 'order-1', orderName: 'n', amount: 1000, successUrl: 'https://w/booking/e/checkout/return?order=o&pg=SIMULATOR', failUrl: 'https://w/f' } };
  const urls = [];
  const bodies = [];
  const w = simulatorWindow(attempt, (u) => urls.push(u), async (u, init) => {
    bodies.push({ u, init });
    return new Response(JSON.stringify({ paymentKey: 'tsim_x' }), { status: 200 });
  });
  await w.pay({});
  assert.equal(bodies[0].u, '/demo/pg-simulator/authenticate');
  assert.ok(!JSON.stringify(bodies[0]).includes('sim_sk'));
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get('paymentKey'), 'tsim_x');
  assert.equal(u.searchParams.get('amount'), '1000');
  assert.equal(u.searchParams.get('pg'), 'SIMULATOR');
});
