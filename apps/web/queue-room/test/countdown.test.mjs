// FE-T42 카운트다운 갱신과 낭독(docs/frontend.md §4.8, d1 §5, ADR-0208 결정 10). 가짜 시계·가짜 타이머·가짜 보이기 사건으로 돈다.
// 보정 시계(§3.3): 고른 표본의 서버 시각 + 그 뒤 단조 시계로 잰 경과라 기기 시계가 바뀌어도 흔들리지 않는다(steady).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdown, milestoneAnnouncer } from '../src/ui/timers.ts';
import { createSteady } from '../src/live/steady.ts';

/** 가짜 타이머: late만큼 늦게 깨고, 숨긴 동안에는 1분 경계에만 깬다(Chrome의 강한 타이머 제한 흉내) */
function fakeTimers(start) {
  let now = start;
  let hidden = false;
  let late = 0;
  let seq = 0;
  const timers = new Map();
  const vis = new Set();
  const wakes = [];
  return {
    deps: {
      now: () => now,
      setTimer: (fn, ms) => {
        const id = ++seq;
        timers.set(id, { fn, at: now + ms + late });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
      onVisible: (cb) => {
        vis.add(cb);
        return () => vis.delete(cb);
      },
    },
    wakes,
    get now() {
      return now;
    },
    set late(v) {
      late = v;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          const at = hidden ? Math.ceil(t.at / 60_000) * 60_000 : t.at;
          if (at <= end && (!next || at < next.at)) next = { id, at, fn: t.fn };
        }
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.at);
        wakes.push(now);
        next.fn();
      }
      now = end;
    },
    hide() {
      hidden = true;
    },
    show() {
      hidden = false;
      for (const cb of vis) cb();
    },
  };
}

test('FE-T42 카운트다운 10분: 초당 깨어남 2회 이하, 늦게 깨도 다음 표시는 남은 초와 같고, 숨겼다 보이면 첫 표시가 맞다. requestAnimationFrame을 부르지 않는다', () => {
  const start = 1_000_000;
  const deadline = start + 10 * 60_000;
  const f = fakeTimers(start);
  const shown = [];
  let raf = 0;
  globalThis.requestAnimationFrame = () => {
    raf++;
    return 0;
  };
  const stop = countdown(deadline, (sec) => shown.push([f.now, sec]), undefined, f.deps);
  const check = () => {
    for (const [at, sec] of shown) assert.equal(sec, Math.max(0, Math.ceil((deadline - at) / 1000)), `${at - start}ms에 ${sec}`);
  };
  f.advance(60_000);
  f.late = 300; // 300ms 늦게 깨기
  f.advance(60_000);
  f.late = 0;
  check();
  // 탭을 숨겼다가 2분 뒤 다시 보이기
  f.hide();
  f.advance(120_000);
  const n = shown.length;
  f.show();
  assert.equal(shown.length, n + 1, '다시 보이면 바로 한 번 맞춘다');
  assert.equal(shown.at(-1)[1], Math.ceil((deadline - f.now) / 1000));
  f.advance(deadline - f.now + 1000);
  check();
  assert.equal(shown.at(-1)[1], 0);
  // 보이는 동안 1초 칸마다 깨어남 2회 이하
  const perSecond = new Map();
  for (const at of f.wakes) perSecond.set(Math.floor(at / 1000), (perSecond.get(Math.floor(at / 1000)) ?? 0) + 1);
  assert.ok(Math.max(...perSecond.values()) <= 2, `초당 최대 ${Math.max(...perSecond.values())}회`);
  assert.equal(raf, 0);
  stop();
  delete globalThis.requestAnimationFrame;
});

test('FE-T42 낭독은 남은 5분·1분·10초를 지날 때 한 번씩(10분에 3번). 숨긴 동안 지나친 이정표는 늦게 읽지 않는다', () => {
  const region = { textContent: '' };
  const said = [];
  const say = milestoneAnnouncer(region, '오픈까지');
  for (let s = 600; s >= 0; s--) {
    const before = region.textContent;
    say(s);
    if (region.textContent !== before) said.push(region.textContent);
  }
  assert.deepEqual(said, ['오픈까지 5분 남았습니다', '오픈까지 1분 남았습니다', '오픈까지 10초 남았습니다']);
  // 늦게 깨 300을 건너뛰어도(301 → 299) 읽는다
  const r2 = { textContent: '' };
  const say2 = milestoneAnnouncer(r2, '오픈까지');
  say2(301);
  say2(299);
  assert.equal(r2.textContent, '오픈까지 5분 남았습니다');
  // 숨겨서 6분 → 50초로 건너뛰면 지나친 5분·1분은 읽지 않는다(틀린 남은 시간을 읽지 않게)
  const r3 = { textContent: '' };
  const say3 = milestoneAnnouncer(r3, '오픈까지');
  say3(360);
  say3(50);
  assert.equal(r3.textContent, '');
  say3(10);
  assert.equal(r3.textContent, '오픈까지 10초 남았습니다');
});

test('보정 시계의 바탕(steady): 페이지를 연 때의 기기 시각 + 단조 시계 경과라 기기 시계를 바꿔도 흔들리지 않는다', () => {
  let wall = 5_000_000;
  let mono = 100;
  const steady = createSteady(() => wall, () => mono);
  assert.equal(steady(), 5_000_000);
  mono += 1500;
  wall += 1500 + 2000; // 기기 시계를 2초 앞당김
  assert.equal(steady(), 5_001_500);
});
