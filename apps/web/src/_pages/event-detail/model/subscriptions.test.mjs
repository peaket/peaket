// 공연 상세의 알림 신청 상태: 오픈 알림·취소표 알림(SCR-002, ADR-0272 결정 2, openapi SubscriptionState, BUILD_ORDER HOT-346)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionFlags } from './subscriptions.ts';

const EV = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const item = (o = {}) => ({ eventId: EV, open: false, cancellation: false, nightPush: false, cancellationStatus: null, endReason: null, sentCount: 0, ...o });

test('SCR-002 알림 상태: 그 회차의 open true와 cancellationStatus ACTIVE만 켜짐(다른 회차·ENDED·칸 없음·items 아님은 꺼짐)', () => {
  assert.deepEqual(subscriptionFlags([item({ open: true, cancellation: true, cancellationStatus: 'ACTIVE' })], EV), { open: true, cancel: true });
  assert.deepEqual(subscriptionFlags([item({ open: true })], EV), { open: true, cancel: false });
  assert.deepEqual(subscriptionFlags([item({ cancellation: true, cancellationStatus: 'ACTIVE' })], EV), { open: false, cancel: true });
  // 끝난 취소표 신청(cancellation true, ENDED)은 꺼짐: cancellation 칸이 아니라 cancellationStatus로 읽는다
  assert.deepEqual(subscriptionFlags([item({ cancellation: true, cancellationStatus: 'ENDED', endReason: 'SENT_MAX' })], EV), { open: false, cancel: false });
  assert.deepEqual(subscriptionFlags([item({ cancellation: true, cancellationStatus: null })], EV), { open: false, cancel: false });
  assert.deepEqual(subscriptionFlags([item({ cancellation: true, cancellationStatus: 'active' })], EV), { open: false, cancel: false }, '대소문자가 다른 값');
  // 다른 회차의 신청은 이 회차가 아니다
  assert.deepEqual(subscriptionFlags([item({ eventId: 'e2', open: true, cancellation: true, cancellationStatus: 'ACTIVE' }), item()], EV), { open: false, cancel: false });
  // 칸 없음·모양 틀림
  assert.deepEqual(subscriptionFlags([{ eventId: EV }], EV), { open: false, cancel: false });
  assert.deepEqual(subscriptionFlags([{ eventId: EV, open: 'true', cancellationStatus: 'ACTIVE ' }], EV), { open: false, cancel: false });
  for (const items of [null, undefined, 'x', {}, { items: [item({ open: true })] }, [null, 1]]) assert.deepEqual(subscriptionFlags(items, EV), { open: false, cancel: false }, JSON.stringify(items));
  assert.deepEqual(subscriptionFlags([], EV), { open: false, cancel: false });
});
