// 좌석 연결 화면 상태 기계(FE-T11, docs/frontend.md §3.5, ADR-0240). 모델 기반 시험: @xstate/graph로 모든 상태와 전이를 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdjacencyMap, getShortestPaths } from '@xstate/graph';
import { createActor } from 'xstate';
import { connectionEvent, connectionMachine } from './connection-machine.ts';

const EVENTS = [{ type: 'OPENED' }, { type: 'LOST' }, { type: 'BATCH', degraded: true }, { type: 'BATCH', degraded: false }, { type: 'ENDED', reason: 'token-invalid' }];
const opts = { events: EVENTS };
const start = () => createActor(connectionMachine).start();
const send = (a, ...e) => (e.forEach((x) => a.send(x)), a.getSnapshot());

test('FE-T11 모델 기반: 최단 경로로 네 상태에 닿고 모든 전이를 돈다', () => {
  const reached = new Set(getShortestPaths(connectionMachine, opts).map((p) => p.state.value));
  assert.deepEqual([...reached].sort(), ['connecting', 'ended', 'live', 'reconnecting']);
  const seen = new Set();
  for (const { state, transitions } of Object.values(getAdjacencyMap(connectionMachine, opts))) {
    for (const { event, state: next } of Object.values(transitions)) if (state.value !== next.value) seen.add(`${state.value}-${event.type}->${next.value}`);
  }
  for (const t of ['connecting-OPENED->live', 'connecting-LOST->reconnecting', 'connecting-ENDED->ended', 'live-LOST->reconnecting', 'live-ENDED->ended', 'reconnecting-OPENED->live', 'reconnecting-ENDED->ended']) assert.ok(seen.has(t), t);
});

test('FE-T11 Worker 알림을 이벤트로 바꾼다', () => {
  assert.equal(connectionEvent('connecting'), null);
  assert.deepEqual(connectionEvent('live'), { type: 'OPENED' });
  assert.deepEqual(connectionEvent('live', { degraded: true }), { type: 'BATCH', degraded: true });
  assert.deepEqual(connectionEvent('reconnecting'), { type: 'LOST' });
  assert.deepEqual(connectionEvent('ended', { reason: 'forbidden' }), { type: 'ENDED', reason: 'forbidden' });
});

test('SCR-010 Degraded는 live 안의 표시이고, 다시 붙으면 지워진다', () => {
  const a = start();
  let s = send(a, { type: 'OPENED' }, { type: 'BATCH', degraded: true });
  assert.equal(s.value, 'live');
  assert.equal(s.context.degraded, true);
  s = send(a, { type: 'LOST' });
  assert.equal(s.value, 'reconnecting');
  s = send(a, { type: 'OPENED' });
  assert.equal(s.context.degraded, false);
});

test('SCR-010 끝난 까닭을 남기고 더 움직이지 않는다', () => {
  const a = start();
  const s = send(a, { type: 'OPENED' }, { type: 'ENDED', reason: 'token-expired' });
  assert.equal(s.value, 'ended');
  assert.equal(s.context.endReason, 'token-expired');
});
