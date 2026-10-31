// SCR-014 티켓 양도 상태별 구역 시험(FRN-090 재리뷰 결함 B, d5 §5.14·§9.2, ADR-0173 결정 3).
// 409 transfer-locked 뒤에는 표가 이미 잠겼으므로 잠김 상태처럼 ③④⑤(받는 분 확인·보내기·법정 고지)를 숨긴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferView } from './view.ts';

test('ADR0173결정3_409 transfer-locked 뒤에는 받는 분 확인·보내기를 숨기고 잠김 구성으로 그린다', () => {
  const v = transferView('오류 · transfer-locked');
  assert.equal(v.transferLockedError, true);
  assert.equal(v.fraudLocked, true);
  assert.equal(v.form, false);
  assert.equal(v.sendSec, false);
  assert.equal(v.rcOk, false);
  assert.equal(v.policy, true);
});

test('ADR0173결정3_부정 예매 조사로 잠김은 409 띠가 아니라 상태 글을 쓴다', () => {
  const v = transferView('부정 예매 조사로 잠김');
  assert.equal(v.fraudLocked, true);
  assert.equal(v.transferLockedError, false);
  assert.equal(v.form, false);
});

test('받는 사람 확인은 그대로 받는 분 확인·보내기를 보인다(회귀)', () => {
  const v = transferView('받는 사람 확인');
  assert.equal(v.form, true);
  assert.equal(v.sendSec, true);
  assert.equal(v.fraudLocked, false);
  assert.equal(v.transferLockedError, false);
});
