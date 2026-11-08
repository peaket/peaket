// 주문 만들기의 값 시험(SCR-011, docs/features/payment.md §2 '주문 생성의 첫 구현', ADR-0228).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buyerErrors, gradeLines, orderIdempotencyKey, orderOutcome, readCheckoutRefs, roundText } from './order.ts';

const store = (m) => ({ getItem: (k) => m[k] ?? null });

test('SCR-011 입장 저장값과 홀드 저장값을 읽는다. 없거나 깨졌으면 알린다', () => {
  const adm = JSON.stringify({ admissionToken: 't' });
  const hold = JSON.stringify({ holdId: 'h1', seatIds: ['a'], expiresAt: 'x' });
  assert.deepEqual(readCheckoutRefs('e', store({ 'peaket.admission.e': adm, 'peaket.hold.e': hold })), { kind: 'ok', admission: { admissionToken: 't' }, holdId: 'h1' });
  assert.deepEqual(readCheckoutRefs('e', store({ 'peaket.hold.e': hold })), { kind: 'no-admission' });
  assert.deepEqual(readCheckoutRefs('e', store({ 'peaket.admission.e': adm })), { kind: 'no-hold' });
  assert.deepEqual(readCheckoutRefs('e', store({ 'peaket.admission.e': adm, 'peaket.hold.e': '{' })), { kind: 'no-hold' });
  assert.deepEqual(readCheckoutRefs('e', store({ 'peaket.admission.e': '{}', 'peaket.hold.e': hold })), { kind: 'no-admission' });
});

test('SCR-011 예매자: 서버와 같은 기준으로 먼저 본다(이름 1~100자·제어 문자 없음, 번호는 E.164로 맞출 수 있어야 한다)', () => {
  assert.deepEqual(buyerErrors('지민', '010-1234-5678'), {});
  assert.deepEqual(buyerErrors('지민', '+82 10 1234 5678'), {});
  assert.deepEqual(buyerErrors('지민', '0082-10-1234-5678'), {});
  assert.deepEqual(buyerErrors('  ', '01012345678'), { name: '예매자 이름을 입력해 주세요' });
  assert.deepEqual(buyerErrors('가'.repeat(101), '01012345678'), { name: '예매자 이름은 100자 이하로 입력해 주세요' });
  assert.deepEqual(buyerErrors('a\u0007b', '01012345678'), { name: '예매자 이름에 쓸 수 없는 글자가 있습니다' });
  assert.deepEqual(buyerErrors('지민', '010-1234-56'), { phone: '휴대폰 번호 자릿수가 맞지 않습니다. 숫자 10~11자리로 입력해 주세요.' });
  assert.deepEqual(buyerErrors('지민', ''), { phone: '휴대폰 번호를 입력해 주세요' });
});

test('SCR-011 주문 실패 → 화면(정본 createOrder 응답표)', () => {
  assert.deepEqual(orderOutcome({ status: 401, type: 'about:blank' }), { kind: 'refresh' });
  assert.deepEqual(orderOutcome({ status: 401, type: 'http-401' }), { kind: 'refresh' });
  for (const type of ['purchase-session-ended', 'purchase-signature-invalid', 'admission-token-invalid', 'purchase-seq-reused']) assert.deepEqual(orderOutcome({ status: 401, type }), { kind: 'ended' });
  assert.deepEqual(orderOutcome({ status: 403, type: 'identity-verification-required' }), { kind: 'no-id' });
  assert.deepEqual(orderOutcome({ status: 403, type: 'booking-restricted' }), { kind: 'restricted' });
  assert.deepEqual(orderOutcome({ status: 403 }), { kind: 'ended' });
  assert.deepEqual(orderOutcome({ status: 404 }), { kind: 'hold-gone' });
  assert.deepEqual(orderOutcome({ status: 409, type: 'hold-already-ordered' }), { kind: 'other-tab' });
  assert.deepEqual(orderOutcome({ status: 409, type: 'idempotency-request-in-progress' }), { kind: 'retry' });
  assert.deepEqual(orderOutcome({ status: 410, type: 'sale-ended' }), { kind: 'sale-ended' });
  assert.deepEqual(orderOutcome({ status: 423, type: 'sale-paused' }), { kind: 'sale-paused' });
  assert.deepEqual(orderOutcome({ status: 422, type: 'consent-required' }), { kind: 'consent' });
  assert.deepEqual(orderOutcome({ status: 422, type: 'consent-version-outdated' }), { kind: 'consent' });
  assert.deepEqual(orderOutcome({ status: 400 }), { kind: 'input' });
  assert.deepEqual(orderOutcome({ status: 503 }), { kind: 'retry' });
  assert.deepEqual(orderOutcome({}), { kind: 'retry' });
});

test('SCR-011 멱등 키: 같은 본문을 다시 보내면 같은 키, 예매자가 바뀌면 새 키(서버는 같은 키의 다른 본문을 422로 막는다)', () => {
  let n = 0;
  const make = () => `k${++n}`;
  const a = orderIdempotencyKey(null, 'h1|지민|010', make);
  assert.equal(a.key, 'k1');
  assert.equal(orderIdempotencyKey(a, 'h1|지민|010', make), a);
  assert.equal(orderIdempotencyKey(a, 'h1|지민|011', make).key, 'k2');
});

test('SCR-011 좌석 줄: 등급과 가격이 같은 좌석을 묶어 서버 금액을 그대로 보인다', () => {
  assert.deepEqual(gradeLines([{ tierName: 'R석', tierId: 'r', price: 100 }, { tierName: 'R석', tierId: 'r', price: 100 }, { tierId: 's', price: 50 }]), [
    { grade: 'R석', price: 100, quantity: 2 },
    { grade: 's', price: 50, quantity: 1 },
  ]);
});

test('SCR-011 회차 시각은 기기 시간대와 상관없이 한국 시각이다', () => {
  assert.equal(roundText('2026-11-28T10:00:00Z'), '11. 28. (토) 19:00');
  assert.equal(roundText(undefined), '');
  assert.equal(roundText('틀림'), '');
});
