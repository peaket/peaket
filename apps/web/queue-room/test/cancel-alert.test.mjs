// SCR-018 [취소표 알림 받기](ADR-0213 결정 5): 처음 그릴 때 신청 상태 확인, 누르면 한 번 보내고 응답마다 화면 값으로 나눈다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCancelAlert } from '../src/live/cancel-alert.ts';
import { reply } from './harness.mjs';

function fakeNet(answers) {
  const calls = [];
  const next = (c) => {
    calls.push(c);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a ?? reply(500);
  };
  return {
    calls,
    net: {
      getFan: async (url) => next({ m: 'GET', url }),
      postJson: async (url, body) => next({ m: 'POST', url, body }),
    },
  };
}

test('SCR-018 취소표 알림 상태: ACTIVE면 신청됨, 판매 종료로 끝났으면 닫힘, 끝난 신청·없음·실패·비로그인은 신청할 수 있음', async () => {
  const item = (over) => reply(200, { items: [{ eventId: 'e1', open: false, cancellation: true, nightPush: false, cancellationStatus: 'ACTIVE', endReason: null, sentCount: 0, ...over }], nextCursor: null });
  const cases = [
    [item({}), 'subscribed'],
    [item({ cancellationStatus: 'ENDED', endReason: 'SALE_ENDED' }), 'closed'],
    [item({ cancellationStatus: 'ENDED', endReason: 'SENT_MAX' }), 'available'],
    [item({ cancellationStatus: 'ENDED', endReason: 'BOOKED' }), 'available'],
    [item({ cancellation: false, cancellationStatus: null }), 'available'],
    [reply(200, { items: [], nextCursor: null }), 'available'],
    [reply(401), 'available'],
    [reply(503), 'available'],
    [new Error('offline'), 'available'],
  ];
  for (const [answer, want] of cases) {
    const f = fakeNet([answer]);
    const a = createCancelAlert({ net: f.net, api: 'https://api', eventId: 'e1', refresh: async () => 'ok' });
    assert.equal(await a.status(), want, JSON.stringify(answer?.body ?? answer?.message));
    assert.equal(f.calls[0].url, 'https://api/v1/subscriptions?eventIds=e1');
  }
});

test('SCR-018 취소표 알림 신청: CANCELLATION·nightPush false를 한 번 보내고, 201·200 신청됨, 410 닫힘, 422 한도, 429·5xx·연결 실패는 실패(다시 보내지 않는다)', async () => {
  const cases = [
    [[reply(201, {})], 'subscribed', 1],
    [[reply(200, {})], 'subscribed', 1],
    [[reply(410, {}, { problem: 'sale-ended' })], 'closed', 1],
    [[reply(422, {}, { problem: 'subscription-limit' })], 'limit', 1],
    [[reply(429, {}, { retryAfterMs: 5000 })], 'failed', 1],
    [[reply(503)], 'failed', 1],
    [[new Error('offline')], 'failed', 1],
  ];
  for (const [answers, want, n] of cases) {
    const f = fakeNet(answers);
    const a = createCancelAlert({ net: f.net, api: 'https://api', eventId: 'e 1', refresh: async () => 'ok' });
    assert.equal(await a.subscribe(), want);
    assert.equal(f.calls.length, n);
    assert.deepEqual(f.calls[0], { m: 'POST', url: 'https://api/v1/events/e%201/subscriptions', body: { kind: 'CANCELLATION', nightPush: false } });
  }
});

test('SCR-018 취소표 알림 상태 401(리뷰 중간): 토큰을 한 번 갱신하고 다시 읽는다. 갱신이 안 되면 신청할 수 있음', async () => {
  let refreshes = 0;
  const active = reply(200, { items: [{ eventId: 'e1', cancellation: true, nightPush: true, cancellationStatus: 'ACTIVE' }], nextCursor: null });
  const f = fakeNet([reply(401), active]);
  assert.equal(await createCancelAlert({ net: f.net, api: 'https://api', eventId: 'e1', refresh: async () => (refreshes++, 'ok') }).status(), 'subscribed');
  assert.deepEqual([f.calls.length, refreshes], [2, 1]);
  const g = fakeNet([reply(401)]);
  assert.equal(await createCancelAlert({ net: g.net, api: 'https://api', eventId: 'e1', refresh: async () => 'rejected' }).status(), 'available');
  assert.equal(g.calls.length, 1);
});

test('SCR-018 취소표 알림 신청(리뷰 중간): 이미 있던 신청의 nightPush를 그대로 보낸다(다시 신청이 SCR-054의 밤에도 받기를 끄지 않게)', async () => {
  const ended = reply(200, { items: [{ eventId: 'e1', cancellation: true, nightPush: true, cancellationStatus: 'ENDED', endReason: 'SENT_MAX' }], nextCursor: null });
  const f = fakeNet([ended, reply(200, {})]);
  const a = createCancelAlert({ net: f.net, api: 'https://api', eventId: 'e1', refresh: async () => 'ok' });
  assert.equal(await a.status(), 'available');
  assert.equal(await a.subscribe(), 'subscribed');
  assert.deepEqual(f.calls[1].body, { kind: 'CANCELLATION', nightPush: true });
});

test('SCR-018 취소표 알림 상태는 페이지에 하나다(리뷰 낮음): 다시 그린 화면이 알고 있는 상태와 보내는 중인 신청을 이어받는다', async () => {
  let release;
  const f = { calls: [], net: { getFan: async () => reply(200, { items: [], nextCursor: null }), postJson: () => new Promise((r) => (release = r)) } };
  const a = createCancelAlert({ net: f.net, api: 'https://api', eventId: 'e1', refresh: async () => 'ok' });
  assert.equal(a.known(), null, '아직 모른다');
  await a.status();
  assert.equal(a.known(), 'available');
  const first = a.subscribe();
  assert.ok(a.pending(), '보내는 중');
  const second = a.subscribe();
  release(reply(201, {}));
  assert.equal(await first, 'subscribed');
  assert.equal(await second, 'subscribed', '보내는 중에 다시 부르면 같은 결과를 기다린다(두 번 보내지 않는다)');
  assert.equal(a.known(), 'subscribed');
  assert.equal(a.pending(), null);
});

test('SCR-018 취소표 알림 신청 401: 토큰을 한 번 갱신하고 다시 보내며, 갱신이 거절되거나 또 401이면 로그인', async () => {
  let refreshes = 0;
  const ok = fakeNet([reply(401), reply(201, {})]);
  assert.equal(await createCancelAlert({ net: ok.net, api: 'https://api', eventId: 'e1', refresh: async () => (refreshes++, 'ok') }).subscribe(), 'subscribed');
  assert.deepEqual([ok.calls.length, refreshes], [2, 1]);
  const again = fakeNet([reply(401), reply(401)]);
  assert.equal(await createCancelAlert({ net: again.net, api: 'https://api', eventId: 'e1', refresh: async () => 'ok' }).subscribe(), 'login');
  const rejected = fakeNet([reply(401)]);
  assert.equal(await createCancelAlert({ net: rejected.net, api: 'https://api', eventId: 'e1', refresh: async () => 'rejected' }).subscribe(), 'login');
  assert.equal(rejected.calls.length, 1);
  const down = fakeNet([reply(401)]);
  assert.equal(await createCancelAlert({ net: down.net, api: 'https://api', eventId: 'e1', refresh: async () => 'unavailable' }).subscribe(), 'failed', '갱신 서버가 안 되면 로그인으로 보내지 않는다');
});
