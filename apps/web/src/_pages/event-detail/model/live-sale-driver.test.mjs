// 리뷰 지적 R040-1 재현: 상태 파일 받기 운전자(계획 '리뷰 뒤 정한 것' RV1~RV4, ADR-0272 결정 1 '읽는 때'·결정 5, docs/frontend.md:397)
// 받기를 시작하는 때는 ① 문서가 처음 고른 상태가 queue일 때 한 번, ② queue인 동안 화면이 다시 보일 때뿐이다. 오픈 순간에는 받지 않는다.
// 진짜 createLiveSaleStore에 가짜 받기·가짜 시계를 넣고, 운전자와 등급 배지(tierBadge)까지 이어서 본다(부르는 쪽 바깥 경계).
// 끝나지 않는 받기 대역을 기다리는 틀린 구현이 실행기 한도(300초)까지 매달리지 않게 시험마다 시간 한도 5초를 둔다(코드 상수 3초·30초와 다른 값, 계획 '검증 뒤 정한 것' VV5, V040-42)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierBadge } from './detail.ts';
import { createLiveSaleDriver, createLiveSaleStore } from './live-sale-store.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const BASE = Date.parse('2026-11-20T10:55:00Z');
const ok = (saleStatus, soldOutTiers = []) => ({ status: 200, body: { serving: 1, saleStatus, soldOutTiers, generatedAtMs: BASE } });
const ON = { text: '판매 중', kind: 'muted' };

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

/** 진짜 가게 + 손으로 답하는 받기 */
function setup() {
  const time = fakeTime();
  const calls = [];
  const store = createLiveSaleStore({ fetchFile: () => new Promise((resolve) => calls.push(resolve)), now: time.now, setTimer: time.setTimer });
  return { time, calls, driver: createLiveSaleDriver(store) };
}

test("[R040-1] 오픈 전(closed·pending·notYet·lobby·fifo)에 연 문서는 오픈을 지나 queue가 돼도 상태 파일을 받지 않고 배지는 '판매 중'이다", { timeout: 5_000 }, async () => {
  for (const first of ['closed', 'pending', 'notYet', 'lobby', 'fifo']) {
    const { time, calls, driver } = setup();
    driver.phase(undefined); // 첫 그리기(아직 시각을 모름)는 첫 상태가 아니다
    driver.phase(first);
    await time.advance(5 * 60_000); // 오픈 시각을 지난다
    driver.phase('queue');
    driver.phase('queue');
    await tick();
    assert.equal(calls.length, 0, `${first} → queue: 오픈 순간에는 받지 않는다`);
    assert.deepEqual(tierBadge('queue', driver.view(), 'tier-r'), ON, `${first}: 받지 않은 동안은 뼈대가 아니라 고정 글`);
  }
});

test('[R040-1] 그 문서가 오픈 뒤 다시 보이면 한 번 받고, 그 뒤 다시 보임은 보낸 시각부터 29,999ms는 0번·30,000ms는 1번 더', { timeout: 5_000 }, async () => {
  const { time, calls, driver } = setup();
  driver.phase('lobby');
  driver.phase('queue');
  await time.advance(60_000);
  driver.visible();
  await tick();
  assert.equal(calls.length, 1, '다시 보일 때 첫 받기');
  assert.deepEqual(driver.view(), { status: 'loading' }, '받는 동안은 뼈대');
  assert.equal(tierBadge('queue', driver.view(), 'tier-r'), undefined);
  calls[0](ok('TIER_SOLD_OUT', ['tier-r']));
  await tick();
  assert.deepEqual(driver.view(), { status: 'known', saleStatus: 'TIER_SOLD_OUT', soldOutTiers: ['tier-r'] });
  await time.advance(29_999);
  driver.visible();
  await tick();
  assert.equal(calls.length, 1, '보낸 지 29,999ms');
  await time.advance(1);
  driver.visible();
  await tick();
  assert.equal(calls.length, 2, '보낸 지 30,000ms');
});

test('[R040-1] 오픈 뒤(queue)에 연 문서는 첫 상태에서 한 번 받고(phase를 여러 번 불러도 1번), 받는 동안 배지는 뼈대다', { timeout: 5_000 }, async () => {
  const { calls, driver } = setup();
  driver.phase(undefined);
  driver.phase('queue');
  driver.phase('queue');
  driver.phase('queue');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(tierBadge('queue', driver.view(), 'tier-r'), undefined, '받는 동안 뼈대');
  calls[0](ok('SOLD_OUT'));
  await tick();
  assert.deepEqual(tierBadge('queue', driver.view(), 'tier-s'), { text: '매진', kind: 'badge', tone: 'neutral' });
});

test('[R040-1] 오픈 전(fifo)·판매 종료(ended) 상태에서 다시 보여도 받지 않는다', { timeout: 5_000 }, async () => {
  // 오픈 전에 다시 보임
  let s = setup();
  s.driver.phase('fifo');
  await s.time.advance(60_000);
  s.driver.visible();
  await tick();
  assert.equal(s.calls.length, 0, 'fifo에서 다시 보임');
  // queue에서 한 번 받은 뒤 판매 종료
  s = setup();
  s.driver.phase('queue');
  await tick();
  assert.equal(s.calls.length, 1);
  s.calls[0](ok('ON_SALE'));
  await tick();
  s.driver.phase('ended');
  await s.time.advance(30_000);
  s.driver.visible();
  await tick();
  assert.equal(s.calls.length, 1, '판매 종료 뒤 30초가 지나 다시 보여도 받지 않는다');
});
