// 공연 상세의 상태 파일 가게: 읽는 때(문서마다 한 번, 다시 보일 때 30초)·시간 한도(3초)·늦은 답(SCR-002, ADR-0272 결정 1 '읽는 때'·'요청', BUILD_ORDER HOT-346)
// 시간은 가짜 시계로 한도 − 1ms와 한도를 잰다. 단언 값은 정본 값(30초·3초)을 적는다(코드 상수를 가져오지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSaleStore } from './live-sale-store.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const BASE = Date.parse('2026-11-20T11:05:00Z');
const ok = (saleStatus, soldOutTiers = []) => ({ status: 200, body: { serving: 1, saleStatus, soldOutTiers, generatedAtMs: BASE } });

/** 가짜 시계와 타이머 */
function fakeTime() {
  let now = BASE;
  const timers = [];
  return {
    now: () => now,
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

/** 답을 손으로 주는 받기 */
function deferredFetch() {
  const calls = [];
  return {
    calls,
    fetchFile: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
  };
}

test('SCR-002 상태 파일은 start 때 한 번만 받는다(두 번 불러도 한 번)', async () => {
  const time = fakeTime();
  let calls = 0;
  const s = createLiveSaleStore({ fetchFile: async () => (calls++, ok('ON_SALE', ['tier-r'])), now: time.now, setTimer: time.setTimer });
  assert.deepEqual(s.get(), { status: 'loading' }, '받기 전은 뼈대');
  const seen = [];
  const off = s.listen(() => seen.push(s.get().status));
  s.start();
  s.start();
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(s.get(), { status: 'known', saleStatus: 'ON_SALE', soldOutTiers: ['tier-r'] });
  assert.ok(seen.includes('known'), '듣는 쪽에 알린다');
  off();
  await time.advance(60_000);
  assert.equal(calls, 1, '주기 조회는 하지 않는다');
});

test('SCR-002 다시 보일 때 마지막으로 받은 지 29,999ms면 받지 않고 30,000ms면 한 번 더 받는다(시작 전 onVisible은 받지 않는다)', async () => {
  const time = fakeTime();
  const answers = [ok('ON_SALE'), ok('SOLD_OUT', []), ok('ON_SALE', ['tier-s'])];
  let calls = 0;
  const s = createLiveSaleStore({ fetchFile: async () => answers[calls++], now: time.now, setTimer: time.setTimer });
  s.onVisible();
  await tick();
  assert.equal(calls, 0, '시작 전(오픈 전) onVisible은 받지 않는다');
  assert.deepEqual(s.get(), { status: 'loading' });
  s.start();
  await tick();
  assert.equal(calls, 1);
  await time.advance(29_999);
  s.onVisible();
  await tick();
  assert.equal(calls, 1, '29,999ms는 받지 않는다');
  await time.advance(1);
  s.onVisible();
  await tick();
  assert.equal(calls, 2, '30,000ms는 한 번 더 받는다');
  assert.deepEqual(s.get(), { status: 'known', saleStatus: 'SOLD_OUT', soldOutTiers: [] });
  s.onVisible();
  await tick();
  assert.equal(calls, 2, '방금 받았으면 다시 받지 않는다');
  await time.advance(30_000);
  s.onVisible();
  await tick();
  assert.equal(calls, 3, '그 뒤에도 30초마다 많아야 한 번');
});

test('SCR-002 3초 한도: 2,999ms에 온 답은 그대로, 3,000ms까지 답이 없으면 unknown이고 늦은 답이 오면 그때 바꾼다', async () => {
  // 2,999ms에 온 답
  let time = fakeTime();
  let f = deferredFetch();
  let s = createLiveSaleStore({ fetchFile: f.fetchFile, now: time.now, setTimer: time.setTimer });
  s.start();
  await time.advance(2_999);
  assert.deepEqual(s.get(), { status: 'loading' }, '2,999ms는 아직 받는 중');
  f.calls[0].resolve(ok('TIER_SOLD_OUT', ['tier-a']));
  await tick();
  await time.advance(1);
  assert.deepEqual(s.get(), { status: 'known', saleStatus: 'TIER_SOLD_OUT', soldOutTiers: ['tier-a'] }, '한도 타이머가 받은 값을 덮지 않는다');
  // 3,000ms까지 답이 없음 → unknown, 늦은 답 → 바꾼다
  time = fakeTime();
  f = deferredFetch();
  s = createLiveSaleStore({ fetchFile: f.fetchFile, now: time.now, setTimer: time.setTimer });
  s.start();
  await time.advance(2_999);
  assert.deepEqual(s.get(), { status: 'loading' });
  await time.advance(1);
  assert.deepEqual(s.get(), { status: 'unknown' }, '3,000ms');
  f.calls[0].resolve(ok('SOLD_OUT', []));
  await tick();
  assert.deepEqual(s.get(), { status: 'known', saleStatus: 'SOLD_OUT', soldOutTiers: [] });
  // 받기가 던지면(연결 실패) unknown
  time = fakeTime();
  s = createLiveSaleStore({ fetchFile: () => Promise.reject(new TypeError('Failed to fetch')), now: time.now, setTimer: time.setTimer });
  s.start();
  await tick();
  assert.deepEqual(s.get(), { status: 'unknown' });
  // 404 답도 unknown
  time = fakeTime();
  s = createLiveSaleStore({ fetchFile: async () => ({ status: 404, body: null }), now: time.now, setTimer: time.setTimer });
  s.start();
  await tick();
  assert.deepEqual(s.get(), { status: 'unknown' });
});

test('SCR-002 늦게 온 앞선 답은 버린다', async () => {
  const time = fakeTime();
  const f = deferredFetch();
  const s = createLiveSaleStore({ fetchFile: f.fetchFile, now: time.now, setTimer: time.setTimer });
  s.start();
  await time.advance(3_000);
  assert.deepEqual(s.get(), { status: 'unknown' });
  await time.advance(27_000);
  s.onVisible();
  await tick();
  assert.equal(f.calls.length, 2, '다시 보일 때 마지막으로 보낸 지 30초');
  f.calls[1].resolve(ok('ON_SALE', ['tier-r']));
  await tick();
  f.calls[0].resolve(ok('SOLD_OUT', []));
  await tick();
  assert.deepEqual(s.get(), { status: 'known', saleStatus: 'ON_SALE', soldOutTiers: ['tier-r'] });
});

test('SCR-002 다시 받기 30초는 보낸 시각부터: 보내고 20,000ms에 답이 와도 보낸 지 29,999ms면 받지 않고 30,000ms면 받는다', async () => {
  // 계획 '시험 뒤 정한 것' S2, ADR-0272 결정 1 '읽는 때'(보낸 시각부터, 경계 30,000ms는 보낸다)
  const time = fakeTime();
  const f = deferredFetch();
  const s = createLiveSaleStore({ fetchFile: f.fetchFile, now: time.now, setTimer: time.setTimer });
  s.start();
  await time.advance(20_000);
  f.calls[0].resolve(ok('ON_SALE'));
  await tick();
  await time.advance(9_999);
  s.onVisible();
  await tick();
  assert.equal(f.calls.length, 1, '보낸 지 29,999ms(답을 받은 지 9,999ms)는 받지 않는다');
  await time.advance(1);
  s.onVisible();
  await tick();
  assert.equal(f.calls.length, 2, '보낸 지 30,000ms는 받는다(답을 받은 시각부터 세면 여기서 보내지 않는다)');
});

test('SCR-002 답이 없는 채 보낸 지 30,000ms면 새로 보내고 앞선 답은 늦게 와도 버린다', async () => {
  const time = fakeTime();
  const f = deferredFetch();
  const s = createLiveSaleStore({ fetchFile: f.fetchFile, now: time.now, setTimer: time.setTimer });
  s.start();
  await time.advance(29_999);
  s.onVisible();
  await tick();
  assert.equal(f.calls.length, 1, '답이 없어도 보낸 지 29,999ms는 보내지 않는다');
  await time.advance(1);
  s.onVisible();
  await tick();
  assert.equal(f.calls.length, 2, '앞선 받기가 끝나지 않았어도 30,000ms면 새로 보낸다');
  s.onVisible();
  await tick();
  assert.equal(f.calls.length, 2, '방금 보냈으면 다시 보내지 않는다(30초에 많아야 한 번)');
  f.calls[1].resolve(ok('PAUSED', ['tier-s']));
  await tick();
  f.calls[0].resolve(ok('SOLD_OUT', []));
  await tick();
  assert.deepEqual(s.get(), { status: 'known', saleStatus: 'PAUSED', soldOutTiers: ['tier-s'] }, '늦게 온 앞선 답은 버린다');
});
