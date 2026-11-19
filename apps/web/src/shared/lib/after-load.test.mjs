// BAT-177: 첫 화면이 다 그려진(load) 뒤에 무거운 조각을 받는 도우미의 바깥 동작
// (docs/frontend.md §5.8, 계획 docs/review/plans/BAT-177.md 4·5의 T5).
// window·document를 대역으로 세우고, load 듣기가 한 번만 불리며 정리 함수가 듣기를 떼는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterLoad } from './after-load.ts';

/** window.addEventListener('load')를 흉내 내는 대역. once 옵션과 removeEventListener를 실제처럼 다룬다 */
function installDom(readyState) {
  const listeners = [];
  const document = { readyState };
  const window = {
    addEventListener(type, fn, options) {
      if (type === 'load') listeners.push({ fn, once: Boolean(options?.once) });
    },
    removeEventListener(type, fn) {
      if (type !== 'load') return;
      const i = listeners.findIndex((l) => l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  globalThis.window = window;
  globalThis.document = document;
  return {
    window,
    document,
    emitLoad() {
      for (const listener of [...listeners]) {
        if (listener.once) listeners.splice(listeners.indexOf(listener), 1);
        listener.fn();
      }
    },
    listenerCount: () => listeners.length,
    restore() {
      delete globalThis.window;
      delete globalThis.document;
    },
  };
}

test('BAT-177 T5 ① load 전에는 부르지 않고 load 한 번에 한 번 부른다', () => {
  const dom = installDom('interactive');
  try {
    let calls = 0;
    afterLoad(() => {
      calls += 1;
    });
    assert.equal(calls, 0, 'load 전에는 부르지 않는다');
    assert.equal(dom.listenerCount(), 1, 'load 듣기를 하나 건다');
    dom.emitLoad();
    assert.equal(calls, 1);
    dom.emitLoad();
    assert.equal(calls, 1, 'load를 두 번 보내도 한 번만 부른다');
  } finally {
    dom.restore();
  }
});

test('BAT-177 T5 ② 이미 load가 지났으면(complete) 그 자리에서 한 번 부른다', () => {
  const dom = installDom('complete');
  try {
    let calls = 0;
    const cleanup = afterLoad(() => {
      calls += 1;
    });
    assert.equal(calls, 1, 'complete면 기다리지 않고 바로 부른다');
    assert.equal(dom.listenerCount(), 0);
    assert.equal(typeof cleanup, 'function');
    cleanup();
    assert.equal(calls, 1, '정리 함수는 이미 부른 run을 다시 부르지 않는다');
  } finally {
    dom.restore();
  }
});

test('BAT-177 T5 ③ 정리 함수는 아직 load 전이면 듣기를 뗀다', () => {
  const dom = installDom('loading');
  try {
    let calls = 0;
    const cleanup = afterLoad(() => {
      calls += 1;
    });
    cleanup();
    assert.equal(dom.listenerCount(), 0, 'load 듣기를 뗀다');
    dom.emitLoad();
    assert.equal(calls, 0, '정리 뒤에는 부르지 않는다');
    cleanup();
    assert.equal(calls, 0, '정리를 두 번 해도 던지지 않는다');
  } finally {
    dom.restore();
  }
});

test('BAT-177 T5 ④ run이 던지면 그대로 던지고, load 듣기는 다시 남지 않는다', () => {
  const dom = installDom('loading');
  try {
    let calls = 0;
    afterLoad(() => {
      calls += 1;
      throw new Error('run 실패');
    });
    assert.throws(() => dom.emitLoad(), /run 실패/, 'run의 예외를 삼키지 않는다');
    assert.equal(calls, 1);
    dom.emitLoad();
    assert.equal(calls, 1, '한 번 던진 뒤 다시 부르지 않는다');
  } finally {
    dom.restore();
  }
});

test('BAT-177 T5 ⑤ window·document가 없는 곳(SSR)에서는 부르지 않는다', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  let calls = 0;
  const cleanup = afterLoad(() => {
    calls += 1;
  });
  assert.equal(calls, 0);
  assert.equal(typeof cleanup, 'function');
  cleanup();
});
