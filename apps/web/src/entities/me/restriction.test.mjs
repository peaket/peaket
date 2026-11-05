// 예매 제한(ADR-0213 결정 2·3, BUILD_ORDER HOT-344): 공연 상세 ⑦의 글·소명 링크와, 회원일 때 한 번 받는 가게
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restrictionCta, toRestriction } from './restriction-model.ts';
import { createRestrictionStore } from './restriction-store.ts';

const NOW = Date.parse('2026-10-25T03:00:00Z'); // 10/25 12:00 KST
const appeal = (id) => `/my/appeals/${id}`;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('SCR-002 예매 제한: NONE이나 모르는 값은 제한 없음', () => {
  assert.deepEqual(toRestriction({ status: 'NONE' }), { status: 'none' });
  assert.deepEqual(toRestriction({ status: 'LIFTED' }), { status: 'none' });
  assert.deepEqual(toRestriction({}), { status: 'none' });
  assert.equal(restrictionCta({ status: 'none' }, NOW, appeal), null);
});

test('SCR-002 예매 제한: 소명 기한 전이면 "예매가 제한되어 있습니다 · 소명 기한 M/D"와 ( 소명하기 › )를 제한 ID로', () => {
  const r = toRestriction({ status: 'ACTIVE', restrictionId: 'rst-1', reasonCode: 'LIMIT', appealDueAt: '2026-10-27T05:00:00Z', endsAt: null });
  assert.deepEqual(r, { status: 'active', restrictionId: 'rst-1', reasonCode: 'LIMIT', appealDueAtMs: Date.parse('2026-10-27T05:00:00Z') });
  assert.deepEqual(restrictionCta(r, NOW, appeal), { text: '예매가 제한되어 있습니다 · 소명 기한 10/27', appealHref: '/my/appeals/rst-1' });
});

test('SCR-002 예매 제한: 소명 기한이 KST 날짜로 바뀌는 때(UTC 15:00 뒤는 다음 날)', () => {
  const r = toRestriction({ status: 'ACTIVE', restrictionId: 'rst-1', appealDueAt: '2026-10-27T15:30:00Z' });
  assert.equal(restrictionCta(r, NOW, appeal).text, '예매가 제한되어 있습니다 · 소명 기한 10/28');
});

test('SCR-002 예매 제한: 소명 기한이 지났으면 링크 없이, 끝이 정해졌으면 "· M/D까지"', () => {
  const r = toRestriction({ status: 'ACTIVE', restrictionId: 'rst-1', appealDueAt: '2026-10-24T05:00:00Z', endsAt: '2026-11-30T05:00:00Z' });
  assert.deepEqual(restrictionCta(r, NOW, appeal), { text: '예매가 제한되어 있습니다 · 11/30까지' });
  const open = toRestriction({ status: 'ACTIVE', restrictionId: 'rst-1', appealDueAt: '2026-10-24T05:00:00Z', endsAt: null });
  assert.deepEqual(restrictionCta(open, NOW, appeal), { text: '예매가 제한되어 있습니다' });
});

test('SCR-002 예매 제한: 제한 ID가 없으면 소명 링크를 만들지 않는다', () => {
  const r = toRestriction({ status: 'ACTIVE', restrictionId: null, appealDueAt: '2026-10-27T05:00:00Z' });
  assert.deepEqual(restrictionCta(r, NOW, appeal), { text: '예매가 제한되어 있습니다 · 소명 기한 10/27' });
});

test('SCR-002 예매 제한 가게: 시작하기 전에는 idle, 시작하면 한 번만 받는다', async () => {
  let calls = 0;
  const s = createRestrictionStore({ fetchStatus: async () => (calls++, { status: 'ACTIVE', restrictionId: 'rst-1' }) });
  assert.deepEqual(s.get(), { status: 'idle' });
  const seen = [];
  s.subscribe(() => seen.push(s.get().status));
  s.subscribe(() => {});
  assert.equal(s.get().status, 'loading');
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(s.get(), { status: 'active', restrictionId: 'rst-1', reasonCode: null });
  assert.deepEqual(seen, ['loading', 'active']);
});

test('SCR-002 예매 제한 가게: 401·5xx·연결 실패는 제한 없음(집행은 입장 확정 403)', async () => {
  const s = createRestrictionStore({ fetchStatus: async () => Promise.reject(Object.assign(new Error('503'), { status: 503 })) });
  s.subscribe(() => {});
  await tick();
  assert.deepEqual(s.get(), { status: 'none' });
});

test('SCR-002 예매 제한 가게: 3초 안에 답이 없으면 제한 없음, 늦은 답이 오면 그때 바꾼다', async () => {
  let release;
  const timers = [];
  const s = createRestrictionStore({
    fetchStatus: () => new Promise((r) => (release = r)),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  s.subscribe(() => {});
  assert.equal(s.get().status, 'loading');
  assert.equal(timers[0].ms, 3000);
  timers[0].fn();
  assert.deepEqual(s.get(), { status: 'none' });
  release({ status: 'ACTIVE', restrictionId: 'rst-9' });
  await tick();
  assert.equal(s.get().status, 'active');
});

test('SCR-002 예매 제한 가게: 다시 받기(페이지 보관에서 돌아옴)는 시작했을 때만, 늦게 온 앞선 답은 버린다', async () => {
  const answers = [];
  const s = createRestrictionStore({ fetchStatus: () => new Promise((r) => answers.push(r)) });
  await s.refreshIfStarted();
  assert.equal(answers.length, 0);
  s.subscribe(() => {});
  void s.refreshIfStarted();
  assert.equal(answers.length, 2);
  answers[1]({ status: 'NONE' });
  await tick();
  answers[0]({ status: 'ACTIVE', restrictionId: 'old' });
  await tick();
  assert.deepEqual(s.get(), { status: 'none' });
});

test('SCR-002 예매 제한 차례: 회원이고 살 수 있는 때(오픈 전·로비·대기열)만 덮는다, 판매 종료·취소는 그대로', async () => {
  const { restrictionGate } = await import('./restriction-model.ts');
  const member = { status: 'member', me: { signupCompleted: false, verified: false } };
  const active = { status: 'active', restrictionId: 'rst-1', reasonCode: null };
  for (const phase of ['closed', 'pending', 'notYet', 'lobby', 'fifo', 'queue']) {
    assert.equal(restrictionGate(phase, member, active, NOW), 'restricted', phase);
    assert.equal(restrictionGate(phase, member, { status: 'none' }, NOW), null, phase);
  }
  for (const phase of ['ended', 'cancelled', undefined]) assert.equal(restrictionGate(phase, member, active, NOW), null, String(phase));
  // 비로그인·모름·받는 중인 세션은 덮지 않는다(로그인 버튼·뼈대가 먼저)
  for (const s of [{ status: 'guest' }, { status: 'unknown' }, { status: 'loading' }]) assert.equal(restrictionGate('queue', s, active, NOW), null, s.status);
});

test('SCR-002 예매 제한 받는 중(리뷰 중간): 들어갈 수 있는 때(로비 차례 기다림·로비·대기열)만 뼈대, 로비 열리기 전·선착순 오픈 전은 지금 버튼을 둔다', async () => {
  const { restrictionGate } = await import('./restriction-model.ts');
  const member = { status: 'member', me: { signupCompleted: true, verified: true } };
  for (const r of [{ status: 'loading' }, { status: 'idle' }]) {
    for (const phase of ['notYet', 'lobby', 'queue']) assert.equal(restrictionGate(phase, member, r, NOW), 'loading', phase);
    for (const phase of ['closed', 'pending', 'fifo']) assert.equal(restrictionGate(phase, member, r, NOW), null, phase);
  }
});

test('SCR-002 예매 제한이 끝났으면(endsAt 지남, 리뷰 중간) 덮지 않는다: 오픈 시각에 다시 고를 때 [대기열 들어가기]가 돌아온다', async () => {
  const { restrictionGate, restrictionCta } = await import('./restriction-model.ts');
  const member = { status: 'member', me: { signupCompleted: true, verified: true } };
  const r = toRestriction({ status: 'ACTIVE', restrictionId: 'rst-1', endsAt: '2026-10-25T10:00:00Z', appealDueAt: '2026-10-24T00:00:00Z' });
  const before = Date.parse('2026-10-25T09:30:00Z');
  const after = Date.parse('2026-10-25T11:00:00Z');
  assert.equal(restrictionGate('fifo', member, r, before), 'restricted');
  assert.equal(restrictionGate('queue', member, r, after), null);
  assert.equal(restrictionCta(r, after, appeal), null);
});
