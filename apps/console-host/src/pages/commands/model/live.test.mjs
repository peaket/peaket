// SCR-030 SSE 흐름의 화면 값 시험(BAT-465 R-584).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/console-host test`). 타입 지우기로 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveUrl, mergeCommand, parseLiveFrame } from './live.ts';

test('R584_주소는_끝의_빗금을_하나로_줄인다', () => {
  assert.equal(liveUrl('https://ops.example/'), 'https://ops.example/v1/ops/live');
  assert.equal(liveUrl('https://ops.example'), 'https://ops.example/v1/ops/live');
});

test('R584_사건을_읽고_id가_숫자가_아니면_뺀다', () => {
  assert.deepEqual(parseLiveFrame({ lastEventId: '1763000000000', type: 'command', data: '{"commandId":"c1"}' }), { id: 1763000000000, event: 'command', data: { commandId: 'c1' } });
  assert.deepEqual(parseLiveFrame({ lastEventId: 'x', type: 'reset', data: '{"reason":"too-old"}' }), { event: 'reset', data: { reason: 'too-old' } });
  assert.equal(parseLiveFrame({ data: '{not json' }), null);
  assert.equal(parseLiveFrame({}), null);
});

test('R584_명령_한_건을_합치면_같은_ID는_하나이고_최신순이다', () => {
  const a = { commandId: 'a', updatedAt: '2026-11-14T09:00:00.000Z' };
  const b = { commandId: 'b', updatedAt: '2026-11-14T09:00:02.000Z' };
  assert.deepEqual(
    mergeCommand([a], b).map((x) => x.commandId),
    ['b', 'a'],
  );
  assert.deepEqual(
    mergeCommand([a, b], { ...a, updatedAt: '2026-11-14T09:00:03.000Z' }).map((x) => x.commandId),
    ['a', 'b'],
  );
  assert.deepEqual(mergeCommand([a, b], b, 1), [b]);
});
