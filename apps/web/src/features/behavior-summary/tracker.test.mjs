// 행동 신호 요약(openapi BehaviorSummary v1, docs/features/bot-defense.md §4.1, ADR-0065 결정 9).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBehaviorTracker, listenBehavior } from './tracker.ts';

function target() {
  const t = new EventTarget();
  t.scrollY = 0;
  return t;
}

const fire = (t, type, props = {}) => t.dispatchEvent(Object.assign(new Event(type), props));

test('[B-T19] 창의 이벤트로 수·간격·거리만 세고, 좌표나 입력한 글자는 요약에 없다', () => {
  let now = 0;
  const tracker = createBehaviorTracker(() => now);
  const w = target();
  const off = listenBehavior(w, tracker);
  fire(w, 'pointermove', { clientX: 10, clientY: 20 });
  fire(w, 'pointermove', { clientX: 15, clientY: 20 });
  now = 100;
  fire(w, 'pointerdown');
  now = 300;
  fire(w, 'keydown', { key: '비밀번호', repeat: false });
  fire(w, 'keydown', { key: 'a', repeat: true }); // 누르고 있는 자동 반복은 세지 않는다
  w.scrollY = 120;
  fire(w, 'scroll');
  now = 1000;
  const s = tracker.summary();
  assert.equal(s.windowMs, 1000);
  assert.equal(s.pointerMoves, 2);
  assert.equal(s.scrollEvents, 1);
  assert.equal(s.scrollDistancePx, 120);
  assert.equal(s.inputIntervalMeanMs, 200);
  assert.deepEqual(Object.keys(s).sort(), ['inputIntervalMeanMs', 'inputIntervalStdMs', 'pointerEntropy', 'pointerMoves', 'scrollDistancePx', 'scrollEvents', 'v', 'windowMs']);
  const text = JSON.stringify(s);
  assert.equal(text.includes('비밀번호'), false);
  // 끈 뒤에는 세지 않는다
  off();
  fire(w, 'pointermove', { clientX: 1, clientY: 1 });
  assert.equal(tracker.summary().pointerMoves, 2);
});

test('[Q-T39] 요약 값은 계약의 최댓값을 넘지 않는다(오래 열어 둔 화면이 400을 받지 않게)', () => {
  let now = 0;
  const t = createBehaviorTracker(() => now);
  for (let i = 0; i < 1_000_100; i++) t.scroll(5000);
  now = 3_600_000;
  const s = t.summary();
  assert.equal(s.scrollEvents, 1_000_000);
  assert.equal(s.scrollDistancePx, 1_000_000_000);
  const m = createBehaviorTracker(() => 0);
  for (let i = 0; i < 1_000_100; i++) m.move(0, 0);
  assert.equal(m.summary().pointerMoves, 1_000_000);
});
