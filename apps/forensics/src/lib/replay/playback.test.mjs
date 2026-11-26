// F-04-17 재생 상태·키보드·숫자 입력 시험. 정본: docs/features/forensic-replay.md §2.3·§8 FX-T8.
// 키보드만 쓴 사람도 재생·되감기·구간 고르기를 할 수 있어야 한다(WCAG 2.1.1·2.5.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load() {
  try {
    return await import('./playback.ts');
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const playback = await load();

function need(name) {
  assert.ok(playback, '재생 상태(src/lib/replay/playback.ts)가 없다');
  assert.equal(typeof playback[name], 'function', `${name}이 없다`);
}

const BOUNDS = { fromMs: -600000, toMs: 1800000 };
const key = (k, shiftKey = false) => ({ key: k, shiftKey });

test('FX-T8 ① 타임라인은 ←→ 1초, Shift+←→ 10초, Home·End, Space로 움직인다', () => {
  need('initialPlayback');
  need('timelineKey');
  const start = playback.initialPlayback(BOUNDS);
  assert.deepEqual(start, { playing: true, speed: 1, playheadMs: -600000, range: null, anchorMs: null });

  const right = playback.timelineKey(start, key('ArrowRight'), BOUNDS);
  assert.equal(right.playheadMs, -599000);
  const shiftRight = playback.timelineKey(start, key('ArrowRight', true), BOUNDS);
  assert.equal(shiftRight.playheadMs, -590000);
  const leftAtStart = playback.timelineKey(start, key('ArrowLeft'), BOUNDS);
  assert.equal(leftAtStart.playheadMs, -600000, '처음에서 왼쪽은 그대로다');

  const end = playback.timelineKey(start, key('End'), BOUNDS);
  assert.equal(end.playheadMs, 1800000);
  const rightAtEnd = playback.timelineKey(end, key('ArrowRight'), BOUNDS);
  assert.equal(rightAtEnd.playheadMs, 1800000, '끝에서 오른쪽은 그대로다');
  const home = playback.timelineKey(end, key('Home'), BOUNDS);
  assert.equal(home.playheadMs, -600000);

  const paused = playback.timelineKey(start, key(' '), BOUNDS);
  assert.equal(paused.playing, false);
  const playing = playback.timelineKey(paused, key(' '), BOUNDS);
  assert.equal(playing.playing, true);

  const middle = { ...start, playheadMs: 0 };
  assert.deepEqual(playback.timelineKey(middle, key('a'), BOUNDS), middle, '모르는 키는 상태를 바꾸지 않는다');

  need('timelineAria');
  assert.deepEqual(playback.timelineAria(start, BOUNDS), { min: -600000, max: 1800000, now: -600000, text: 'T−10:00' });
  assert.deepEqual(playback.timelineAria(end, BOUNDS), { min: -600000, max: 1800000, now: 1800000, text: 'T+30:00' });
  const withRange = { ...middle, range: { fromMs: 0, toMs: 60000 } };
  assert.deepEqual(playback.timelineAria(withRange, BOUNDS), {
    min: -600000,
    max: 1800000,
    now: 0,
    text: 'T+00:00 · 구간 T+00:00~T+01:00',
  });
});

test('FX-T8 ① [ 두 번은 재생 위치로 구간을 만들고 Esc는 지운다', () => {
  need('timelineKey');
  const start = playback.initialPlayback(BOUNDS);
  const anchored = playback.timelineKey(start, key('['), BOUNDS);
  assert.equal(anchored.anchorMs, -600000);
  assert.equal(anchored.range, null);

  const moved = { ...anchored, playheadMs: -597000 };
  const ranged = playback.timelineKey(moved, key('['), BOUNDS);
  assert.deepEqual(ranged.range, { fromMs: -600000, toMs: -597000 });
  assert.equal(ranged.anchorMs, null);

  const reversed = playback.timelineKey({ ...start, anchorMs: 0, playheadMs: -5000 }, key('['), BOUNDS);
  assert.deepEqual(reversed.range, { fromMs: -5000, toMs: 0 }, '두 끝은 작은·큰 값으로 정리한다');

  const same = playback.timelineKey({ ...start, anchorMs: 0, playheadMs: 0 }, key('['), BOUNDS);
  assert.equal(same.range, null, '같은 자리면 구간이 아니다');
  assert.equal(same.anchorMs, null);

  const cleared = playback.timelineKey(ranged, key('Escape'), BOUNDS);
  assert.equal(cleared.range, null);
  assert.equal(cleared.anchorMs, null);
  const anchorCleared = playback.timelineKey(anchored, key('Esc'), BOUNDS);
  assert.equal(anchorCleared.anchorMs, null, '한 번만 잡은 끝도 Esc로 지운다');
});

test('FX-T8 ① 재생은 배속 ×1·×10·×60으로 흐르고 끝에서 멈춘다', () => {
  need('initialPlayback');
  need('advancePlayback');
  need('setSpeed');
  const start = { ...playback.initialPlayback(BOUNDS), playheadMs: 0 };
  assert.equal(playback.advancePlayback(start, 1000, BOUNDS).playheadMs, 1000);
  assert.equal(playback.advancePlayback({ ...start, speed: 10 }, 1000, BOUNDS).playheadMs, 10000);
  assert.equal(playback.advancePlayback({ ...start, speed: 60 }, 1000, BOUNDS).playheadMs, 60000);
  assert.equal(playback.advancePlayback({ ...start, playing: false }, 1000, BOUNDS).playheadMs, 0, '일시정지 중에는 흐르지 않는다');
  assert.equal(playback.advancePlayback(start, 0, BOUNDS).playheadMs, 0);
  assert.equal(playback.advancePlayback(start, -1000, BOUNDS).playheadMs, 0);

  const nearEnd = { ...start, playheadMs: BOUNDS.toMs - 500, speed: 10 };
  const stopped = playback.advancePlayback(nearEnd, 1000, BOUNDS);
  assert.equal(stopped.playheadMs, BOUNDS.toMs);
  assert.equal(stopped.playing, false, '끝에 닿으면 멈춘다');

  assert.equal(playback.setSpeed(start, 10).speed, 10);
  assert.equal(playback.setSpeed(start, 60).speed, 60);
  assert.throws(() => playback.setSpeed(start, 2), TypeError);
  assert.throws(() => playback.setSpeed(start, 0), TypeError);
});

test('FX-T8 ③ T+MM:SS·T−MM:SS·MM:SS·-MM:SS·정수 초를 읽고 같은 글로 돌려준다', () => {
  need('parseOffset');
  need('formatOffset');
  assert.equal(playback.parseOffset('T+01:30'), 90000);
  assert.equal(playback.parseOffset('T−01:30'), -90000);
  assert.equal(playback.parseOffset('01:30'), 90000);
  assert.equal(playback.parseOffset('-01:30'), -90000);
  assert.equal(playback.parseOffset('90'), 90000);
  assert.equal(playback.parseOffset('0'), 0);
  assert.equal(playback.parseOffset('T-01:30'), undefined, 'T 뒤 ASCII 하이픈은 정본에 없다');
  for (const bad of ['', 'T+', 'T+00:60', 'T+00:00:01', '1:2', 'abc', '1.5', '+T01:30']) {
    assert.equal(playback.parseOffset(bad), undefined, bad);
  }

  assert.equal(playback.formatOffset(-600000), 'T−10:00');
  assert.equal(playback.formatOffset(0), 'T+00:00');
  assert.equal(playback.formatOffset(90000), 'T+01:30');
  assert.equal(playback.formatOffset(-1500), 'T−00:01');
  for (const ms of [-600000, -90000, -1500, 0, 1000, 90000, 1800000]) {
    assert.equal(playback.parseOffset(playback.formatOffset(ms)), Math.trunc(ms / 1000) * 1000, `${ms}`);
  }
});

test('FX-T8 ③ 숫자 입력으로 고른 구간은 끌어서 고른 구간과 같은 값을 낸다', () => {
  need('rangeFromInput');
  need('initialPlayback');
  need('timelineKey');
  assert.deepEqual(playback.rangeFromInput('T+01:00', 'T+02:30', BOUNDS), { fromMs: 60000, toMs: 150000 });
  assert.deepEqual(playback.rangeFromInput('T+02:30', 'T+01:00', BOUNDS), { fromMs: 60000, toMs: 150000 }, '뒤집힌 입력을 정리한다');
  assert.deepEqual(playback.rangeFromInput('T+00:00', 'T+30:00', BOUNDS), { fromMs: 0, toMs: 1800000 }, '경계 끝을 넣는다');
  assert.deepEqual(playback.rangeFromInput('T−10:00', 'T+30:00', BOUNDS), { fromMs: -600000, toMs: 1800000 }, '양 끝 경계');
  assert.equal(playback.rangeFromInput('T+02:30', 'T+02:30', BOUNDS), undefined, '같은 값은 구간이 아니다');
  assert.equal(playback.rangeFromInput('T−11:00', 'T+01:00', BOUNDS), undefined, '범위 밖은 거절한다');
  assert.equal(playback.rangeFromInput('T+01:00', 'T+31:00', BOUNDS), undefined, '범위 밖은 거절한다');
  assert.equal(playback.rangeFromInput('', 'T+01:00', BOUNDS), undefined);
  assert.equal(playback.rangeFromInput('abc', 'T+01:00', BOUNDS), undefined);

  let state = { ...playback.initialPlayback(BOUNDS), playheadMs: 60000 };
  state = playback.timelineKey(state, key('['), BOUNDS);
  state = { ...state, playheadMs: 150000 };
  state = playback.timelineKey(state, key('['), BOUNDS);
  assert.deepEqual(state.range, playback.rangeFromInput('T+01:00', 'T+02:30', BOUNDS), '키보드 구간과 숫자 입력이 같다');
  assert.deepEqual(state.range, { fromMs: 60000, toMs: 150000 });
});
