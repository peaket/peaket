// N-T15 파트너 웹훅 관리 화면의 주소 검사·상태 말·구독 토글(SCR-025, docs/features/notify.md §9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkWebhookUrl, deliveryResult, deliveryView, endpointView, eventTypeLabel, subscriptionText, toggleEvent } from './live.ts';

const ui = readFileSync(new URL('../ui/live/WebhooksLive.tsx', import.meta.url), 'utf8');

test('N-T15 웹훅 주소: https 443만 받는다', () => {
  assert.equal(checkWebhookUrl('https://partner.example.com/hook').ok, true);
  assert.equal(checkWebhookUrl('http://partner.example.com/hook').reason, 'scheme');
  assert.equal(checkWebhookUrl('https://partner.example.com:8443/hook').reason, 'port');
});

test('N-T15 웹훅 주소: 사용자 정보·IP 그대로·사설 호스트를 거절한다', () => {
  assert.equal(checkWebhookUrl('https://user:pass@partner.example.com/hook').reason, 'credentials');
  assert.equal(checkWebhookUrl('https://203.0.113.10/hook').reason, 'ip-literal');
  assert.equal(checkWebhookUrl('https://localhost/hook').reason, 'private-address');
  assert.equal(checkWebhookUrl('https://metadata.google.internal/hook').reason, 'private-address');
});

test('N-T15 웹훅 주소: 모양이 틀리면 format이다', () => {
  assert.equal(checkWebhookUrl('not a url').reason, 'format');
});

test('N-T15 웹훅 상태: 계속 실패로 꺼진 주소는 다시 켤 수 있다', () => {
  const e = {
    endpointId: 'e1',
    url: 'https://partner.example.com/hook',
    eventTypes: [],
    status: 'DISABLED',
    disabledReason: 'FAILING',
    secretIssuedAt: '2026-10-01T01:30:00.000Z',
    previousSecretValidUntil: null,
    version: 2,
  };
  assert.equal(endpointView(e).label, '꺼짐 · 계속 실패');
  assert.equal(endpointView(e).canEdit, true);
});

test('N-T15 발송 상태: DLQ·성공만 다시 보낼 수 있다', () => {
  const base = {
    deliveryId: 'd1',
    webhookId: 'w1',
    eventType: 'order.confirmed',
    attemptCount: 3,
    lastHttpStatus: null,
    lastError: null,
    nextAttemptAt: null,
    createdAt: '2026-10-14T11:03:40.000Z',
    finishedAt: null,
  };
  assert.equal(deliveryView({ ...base, status: 'RETRYING' }).canRedeliver, false);
  assert.equal(deliveryView({ ...base, status: 'DEAD' }).canRedeliver, true);
  assert.equal(deliveryView({ ...base, status: 'SUCCEEDED' }).canRedeliver, true);
  assert.equal(deliveryResult({ ...base, lastError: 'TIMEOUT' }), '응답 없음(시간 초과)');
});

test('N-T15 구독: 이벤트를 켜고 끄며 8종 이름을 쓴다', () => {
  assert.deepEqual(toggleEvent(['order.confirmed'], 'event.sold_out'), ['order.confirmed', 'event.sold_out']);
  assert.deepEqual(toggleEvent(['order.confirmed', 'event.sold_out'], 'order.confirmed'), ['event.sold_out']);
  assert.equal(eventTypeLabel('payout.failed'), '지급 실패');
  assert.equal(subscriptionText([]), '고른 이벤트가 없어 보내지 않습니다');
});

test('N-T15 서명 비밀 원문은 등록·재발급 응답의 newSecret으로만 보인다', () => {
  assert.match(ui, /setNewSecret\(\{ secret: created\.secret \}\)/);
  assert.match(ui, /setNewSecret\(\{ secret: r\.secret, previousValidUntil: r\.previousSecretValidUntil \}\)/);
  assert.doesNotMatch(ui, /secret: endpoint\./);
});
