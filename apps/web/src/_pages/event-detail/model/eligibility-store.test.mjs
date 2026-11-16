// 팬별 판매 자격 가게: 문서마다 한 번, 실패·시간 한도(3초)는 자격 모름, 늦은 답(SCR-002, ADR-0272 결정 3 '부르는 때'·'실패', BUILD_ORDER HOT-346)
// 시간은 가짜 타이머로 한도 − 1ms와 한도를 잰다. 단언 값은 정본 값(3초)을 적는다.
// 끝나지 않는 받기 대역을 기다리는 틀린 구현이 실행기 한도(300초)까지 매달리지 않게 시험마다 시간 한도 5초를 둔다(코드 상수 3초·30초와 다른 값, 계획 '검증 뒤 정한 것' VV5, V040-42)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEligibilityStore } from './eligibility-store.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const T = (iso) => Date.parse(iso);
const EV = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const body = (eligible = true) => ({
  eventId: EV,
  phases: [
    { kind: 'PRESALE', startsAt: '2026-11-20T11:00:00Z', endsAt: '2026-11-20T15:30:00Z', eligible, limitPerPerson: 2 },
    { kind: 'GENERAL', startsAt: '2026-11-20T15:30:00Z', endsAt: '2026-12-23T10:00:00Z', eligible: true, limitPerPerson: 3 },
  ],
  lists: eligible ? [{ name: '팬클럽 선예매', destroyAt: '2026-12-24T15:30:00Z' }] : [],
});
const known = (eligible = true) => ({
  status: 'known',
  phases: [
    { kind: 'PRESALE', startsAtMs: T('2026-11-20T11:00:00Z'), endsAtMs: T('2026-11-20T15:30:00Z'), limit: 2, eligible },
    { kind: 'GENERAL', startsAtMs: T('2026-11-20T15:30:00Z'), endsAtMs: T('2026-12-23T10:00:00Z'), limit: 3, eligible: true },
  ],
  lists: eligible ? [{ name: '팬클럽 선예매', destroyAtMs: T('2026-12-24T15:30:00Z') }] : [],
});

/** 가짜 타이머: 걸린 시각 순으로 손으로 돌린다 */
function fakeTimers() {
  let now = 0;
  const timers = [];
  return {
    setTimer: (fn, ms) => void timers.push({ at: now + ms, fn }),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await tick();
      }
      now = end;
      await tick();
    },
  };
}

test('[ASVS v5.0.0-16.5.2] SCR-002 판매 자격 가게: 시작 전 idle, 한 번만 받고, 던짐·모양 틀림은 none', { timeout: 5_000 }, async () => {
  let calls = 0;
  const s = createEligibilityStore({ fetchEligibility: async () => (calls++, body(false)) });
  assert.deepEqual(s.get(), { status: 'idle' });
  const seen = [];
  s.subscribe(() => seen.push(s.get().status));
  s.subscribe(() => {});
  assert.equal(s.get().status, 'loading');
  await tick();
  assert.equal(calls, 1, '문서마다 한 번');
  assert.deepEqual(s.get(), known(false));
  assert.deepEqual(seen, ['loading', 'known']);
  // 던짐: 401(갱신 뒤)·404·410·5xx·연결 실패 → 자격 모름(none). 고정 글이 아니라 덮지 않는 모양이다
  const errors = [
    Object.assign(new Error('401'), { status: 401 }),
    Object.assign(new Error('404'), { status: 404, type: 'https://peaket.example/problems/not-found' }),
    Object.assign(new Error('410'), { status: 410, type: 'https://peaket.example/problems/event-suspended' }),
    Object.assign(new Error('503'), { status: 503 }),
    new TypeError('Failed to fetch'),
  ];
  for (const e of errors) {
    const x = createEligibilityStore({ fetchEligibility: () => Promise.reject(e) });
    x.subscribe(() => {});
    await tick();
    assert.deepEqual(x.get(), { status: 'none' }, e.message);
  }
  // 모양 틀림
  for (const b of [null, {}, 'x', { eventId: EV, phases: 'x', lists: [] }, { eventId: EV, phases: [], lists: 'x' }]) {
    const x = createEligibilityStore({ fetchEligibility: async () => b });
    x.subscribe(() => {});
    await tick();
    assert.deepEqual(x.get(), { status: 'none' }, JSON.stringify(b));
  }
});

test('[ASVS v5.0.0-16.5.2] SCR-002 3초 안에 답이 없으면 none(2,999ms는 loading), 늦은 답이 오면 바꾼다', { timeout: 5_000 }, async () => {
  const t = fakeTimers();
  let answer;
  const s = createEligibilityStore({ fetchEligibility: () => new Promise((r) => (answer = r)), setTimer: t.setTimer });
  s.subscribe(() => {});
  await t.advance(2_999);
  assert.deepEqual(s.get(), { status: 'loading' }, '2,999ms');
  await t.advance(1);
  assert.deepEqual(s.get(), { status: 'none' }, '3,000ms');
  answer(body(true));
  await tick();
  assert.deepEqual(s.get(), known(true), '늦은 답');
  // 2,999ms에 온 답은 한도 타이머가 덮지 않는다
  const u = fakeTimers();
  let a2;
  const y = createEligibilityStore({ fetchEligibility: () => new Promise((r) => (a2 = r)), setTimer: u.setTimer });
  y.subscribe(() => {});
  await u.advance(2_999);
  a2(body(false));
  await tick();
  await u.advance(1);
  assert.deepEqual(y.get(), known(false));
});

test('SCR-002 다시 받기는 시작했을 때만, 늦게 온 앞선 답은 버린다', { timeout: 5_000 }, async () => {
  const answers = [];
  const s = createEligibilityStore({ fetchEligibility: () => new Promise((r) => answers.push(r)) });
  await s.refreshIfStarted();
  assert.equal(answers.length, 0, '시작 전 다시 받기는 부르지 않는다');
  assert.deepEqual(s.get(), { status: 'idle' });
  s.subscribe(() => {});
  assert.equal(answers.length, 1);
  void s.refreshIfStarted();
  assert.equal(answers.length, 2, '페이지 보관에서 돌아오면 다시 받는다');
  answers[1](body(true));
  await tick();
  answers[0](body(false));
  await tick();
  assert.deepEqual(s.get(), known(true), '앞선 답(대상 아님)은 버린다');
});
