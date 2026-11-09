// 결제창 복귀의 값 시험(SCR-011, docs/frontend.md §5.3 '복귀 화면', openapi PaymentAccept, ADR-0229).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptOutcome, findAcceptRecord, parseReturn, paymentReturnUrls, readAcceptRecord, writeAcceptRecord } from './payment-return.ts';

function store() {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    m,
  };
}

test('SCR-011 토스 성공 주소: 우리 주문 ID와 결제 값을 읽고 금액은 정수만 받는다', () => {
  assert.deepEqual(parseReturn('?order=o1&paymentKey=pk&orderId=pg-ref&amount=110000'), { kind: 'success', orderId: 'o1', body: { pg: 'TOSS', paymentKey: 'pk', amount: 110000 } });
  assert.deepEqual(parseReturn('?order=o1&pg=SIMULATOR&paymentKey=pk&amount=5'), { kind: 'success', orderId: 'o1', body: { pg: 'SIMULATOR', paymentKey: 'pk', amount: 5 } });
  assert.deepEqual(parseReturn('?order=o1&paymentKey=pk&amount=1.5'), { kind: 'none' });
  assert.deepEqual(parseReturn('?order=o1&paymentKey=pk'), { kind: 'none' });
});

test('SCR-011 포트원 복귀 주소: 세 값이 다 있어야 접수한다', () => {
  assert.deepEqual(parseReturn('?order=o1&paymentId=p&paymentToken=t&txId=x'), { kind: 'success', orderId: 'o1', body: { pg: 'PORTONE', paymentId: 'p', paymentToken: 't', txId: 'x' } });
  assert.deepEqual(parseReturn('?order=o1&paymentId=p'), { kind: 'none' });
});

test('SCR-011 실패 주소는 코드로 알고, 결제사가 준 글은 그대로 믿어 넘기지 않는다', () => {
  assert.deepEqual(parseReturn('?order=o1&code=PAY_PROCESS_CANCELED&message=x'), { kind: 'fail', orderId: 'o1', cancelled: true });
  assert.deepEqual(parseReturn('?order=o1&code=REJECT_CARD&message=<b>x</b>'), { kind: 'fail', orderId: 'o1', cancelled: false });
  assert.deepEqual(parseReturn('?code=X'), { kind: 'fail', cancelled: false });
});

test('SCR-011 값이 없으면(새로고침) none이고, 주문 ID 없는 성공 값도 접수하지 않는다', () => {
  assert.deepEqual(parseReturn(''), { kind: 'none' });
  assert.deepEqual(parseReturn('?paymentKey=pk&amount=1'), { kind: 'none' });
});

test('SCR-011 접수 기록에는 시각·멱등 키·회차만 있고 결제사 값이 없다. 새로고침하면 그 회차의 기록을 찾는다', () => {
  const s = store();
  writeAcceptRecord(s, 'o1', { eventId: 'e1', key: 'k1', at: 7 });
  assert.deepEqual(JSON.parse(s.m.get('peaket.accept.o1')), { eventId: 'e1', key: 'k1', at: 7 });
  assert.deepEqual(readAcceptRecord(s, 'o1'), { eventId: 'e1', key: 'k1', at: 7 });
  assert.equal(readAcceptRecord(s, 'o2'), null);
  assert.equal(findAcceptRecord(s, 'e1'), 'o1');
  assert.equal(findAcceptRecord(s, 'e2'), null);
  s.setItem('peaket.accept.bad', '{');
  assert.equal(readAcceptRecord(s, 'bad'), null);
  // 기록이 둘이면 가장 나중에 접수한 주문이다
  writeAcceptRecord(s, 'o0', { eventId: 'e1', key: 'k0', at: 3 });
  writeAcceptRecord(s, 'o2', { eventId: 'e1', key: 'k2', at: 9 });
  assert.equal(findAcceptRecord(s, 'e1'), 'o2');
});

test('SCR-011 결제 접수 실패 → 화면(openapi createOrderPaymentAcceptance)', () => {
  assert.deepEqual(acceptOutcome({ status: 400 }), { kind: 'mismatch' });
  assert.deepEqual(acceptOutcome({ status: 401, type: 'about:blank' }), { kind: 'refresh' });
  for (const type of ['purchase-session-ended', 'purchase-signature-invalid', 'admission-token-invalid', 'purchase-seq-reused']) assert.deepEqual(acceptOutcome({ status: 401, type }), { kind: 'ended' });
  assert.deepEqual(acceptOutcome({ status: 404 }), { kind: 'not-finished' });
  assert.deepEqual(acceptOutcome({ status: 409, type: 'payment-already-accepted' }), { kind: 'other-tab' });
  assert.deepEqual(acceptOutcome({ status: 409, type: 'payment-attempt-mismatch' }), { kind: 'mismatch' });
  assert.deepEqual(acceptOutcome({ status: 409, type: 'order-expired' }), { kind: 'order-expired' });
  assert.deepEqual(acceptOutcome({ status: 409, type: 'idempotency-request-in-progress' }), { kind: 'retry' });
  assert.deepEqual(acceptOutcome({ status: 423 }), { kind: 'retry' });
  assert.deepEqual(acceptOutcome({ status: 503 }), { kind: 'retry' });
  assert.deepEqual(acceptOutcome({}), { kind: 'retry' });
});

test('SCR-011 결제창 이동 주소를 한곳에서 만든다(토스 successUrl·failUrl, 포트원 redirectUrl)', () => {
  const u = paymentReturnUrls('https://www.example', 'e 1', 'o/1', 'TOSS');
  assert.equal(u.successUrl, 'https://www.example/booking/e%201/checkout/return?order=o%2F1&pg=TOSS');
  assert.equal(u.failUrl, u.successUrl);
  assert.equal(paymentReturnUrls('https://www.example', 'e', 'o', 'PORTONE').redirectUrl, 'https://www.example/booking/e/checkout/return?order=o&pg=PORTONE');
});
