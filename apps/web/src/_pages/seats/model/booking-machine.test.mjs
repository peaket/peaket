// 예매 흐름 기계(docs/frontend.md §3.6, BUILD_ORDER HOT-353, ADR-0225). 모델 기반 시험: @xstate/graph로 경로를 만들어 모든 전이를 돈다(ADR-0135 낮음-096).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdjacencyMap, getShortestPaths } from '@xstate/graph';
import { createActor } from 'xstate';
import { behaviorForHold, bookingMachine, holdIdempotencyKey, holdOutcome } from './booking-machine.ts';
import { holdClock } from '../../../shared/lib/hold-clock.ts';

const seat = (n) => ({ seatId: `A-1-${n}`, label: `A구역 1열 ${n}번`, tier: 'tier-r' });
const start = (limit = 4) => createActor(bookingMachine, { input: { limit } }).start();
const send = (a, ...events) => (events.forEach((e) => a.send(e)), a.getSnapshot());

const EVENTS = [
  { type: 'TOGGLE', seat: seat(1) },
  { type: 'HOLD' },
  { type: 'AUTO' },
  { type: 'HOLD_OK', hold: { holdId: 'h' } },
  { type: 'HOLD_LOST', suggested: ['B-1'] },
  { type: 'HOLD_RECENT', seats: ['A-1-1'], availableAt: 'x' },
  { type: 'HOLD_LIMIT' },
  { type: 'HOLD_PAUSED' },
  { type: 'HOLD_SALE_ENDED' },
  { type: 'HOLD_FAILED' },
  { type: 'SESSION_ENDED' },
  { type: 'EXPIRED' },
  { type: 'RESUME' },
];
const opts = { events: EVENTS, input: { limit: 4 }, serializeState: (s) => JSON.stringify([s.value, s.context.picks.length > 0]) };

test('SCR-010 §3.6 표: 고르고 → 홀드 중 → 201이면 held다', () => {
  const a = start();
  assert.equal(a.getSnapshot().value, 'selecting');
  assert.equal(send(a, { type: 'HOLD' }).value, 'selecting', '고른 좌석이 없으면 홀드하지 않는다');
  assert.equal(send(a, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }).value, 'holding');
  assert.equal(send(a, { type: 'HOLD_OK', hold: { holdId: 'h' } }).value, 'held');
  assert.deepEqual(a.getSnapshot().context.hold, { holdId: 'h' });
});

test('SCR-010 경합 패배(409)는 고른 좌석을 되돌리고 가까운 좌석을 안내한다', () => {
  const a = start();
  const s = send(a, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_LOST', suggested: ['B-1', 'B-2'] });
  assert.equal(s.value, 'selecting');
  assert.deepEqual(s.context.picks, []);
  assert.deepEqual(s.context.notice, { kind: 'lost', suggested: ['B-1', 'B-2'] });
});

test('SCR-010 방금 놓은 좌석(409)도 고른 좌석을 되돌리고 알린다', () => {
  const s = send(start(), { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_RECENT', seats: ['A-1-1'], availableAt: 't' });
  assert.equal(s.value, 'selecting');
  assert.deepEqual(s.context.picks, []);
  assert.deepEqual(s.context.notice, { kind: 'recent', seats: ['A-1-1'], availableAt: 't' });
});

test('SCR-010 한도(422)는 고른 좌석을 두고 selecting으로, 화면 한도를 넘는 고르기는 막고 알린다', () => {
  const a = start(2);
  let s = send(a, { type: 'TOGGLE', seat: seat(1) }, { type: 'TOGGLE', seat: seat(2) }, { type: 'TOGGLE', seat: seat(3) });
  assert.equal(s.context.picks.length, 2);
  assert.equal(s.context.notice?.kind, 'limit');
  // 같은 좌석을 다시 누르면 푼다(한도 안내도 지운다)
  s = send(a, { type: 'TOGGLE', seat: seat(2) });
  assert.equal(s.context.picks.length, 1);
  assert.equal(s.context.notice, null);
  s = send(a, { type: 'HOLD' }, { type: 'HOLD_LIMIT' });
  assert.equal(s.value, 'selecting');
  assert.equal(s.context.picks.length, 1);
  assert.equal(s.context.notice?.kind, 'limit');
});

test('SCR-010 일시 정지(423)·판매 종료(410)는 홀드를 막고, 세션 끝은 어디서든 끝이다', () => {
  const p = start();
  assert.equal(send(p, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_PAUSED' }).value, 'paused');
  assert.equal(send(p, { type: 'HOLD' }).value, 'paused');
  const e = start();
  assert.equal(send(e, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_SALE_ENDED' }).value, 'saleEnded');
  assert.equal(send(e, { type: 'HOLD' }).value, 'saleEnded');
  assert.equal(send(start(), { type: 'SESSION_ENDED' }).value, 'ended');
  const h = start();
  assert.equal(send(h, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'SESSION_ENDED' }).value, 'ended');
});

test('SCR-010 일시 정지는 잠시 뒤 다시 홀드할 수 있다(RESUME, 고른 좌석은 그대로)', () => {
  const a = start();
  const s = send(a, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_PAUSED' }, { type: 'RESUME' });
  assert.equal(s.value, 'selecting');
  assert.equal(s.context.picks.length, 1);
});

test('SCR-010 일시 오류는 고른 좌석을 두고 다시 시도할 수 있다', () => {
  const s = send(start(), { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_FAILED' });
  assert.equal(s.value, 'selecting');
  assert.equal(s.context.picks.length, 1);
  assert.equal(s.context.notice?.kind, 'error');
});

test('SCR-010 판매 종료 뒤에는 고른 좌석을 풀 수만 있고 새로 고르지 못한다(d5 §5.10 판매 종료)', () => {
  const a = start();
  assert.equal(send(a, { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_SALE_ENDED' }).value, 'saleEnded');
  assert.deepEqual(send(a, { type: 'TOGGLE', seat: seat(2) }).context.picks.map((p) => p.seatId), [seat(1).seatId]);
  assert.deepEqual(send(a, { type: 'TOGGLE', seat: seat(1) }).context.picks, []);
});

test('SCR-010 모델 기반: 최단 경로로 모든 상태에 닿고, 인접 맵으로 모든 전이를 돈다', () => {
  const shortest = getShortestPaths(bookingMachine, opts);
  const reached = new Set(shortest.map((p) => p.state.value));
  assert.deepEqual([...reached].sort(), ['ended', 'held', 'holding', 'paused', 'saleEnded', 'selecting']);
  // 인접 맵은 (상태·고른 좌석 유무)마다 모든 이벤트의 다음 상태를 준다: 단순 경로는 되돌아오는 전이를 빼므로 전이는 여기서 센다
  const seen = new Set();
  for (const { state, transitions } of Object.values(getAdjacencyMap(bookingMachine, opts))) {
    for (const { event, state: next } of Object.values(transitions)) if (state.value !== next.value) seen.add(`${state.value}-${event.type}->${next.value}`);
  }
  for (const t of [
    'selecting-HOLD->holding',
    'selecting-AUTO->holding',
    'holding-HOLD_OK->held',
    'holding-HOLD_LOST->selecting',
    'holding-HOLD_RECENT->selecting',
    'holding-HOLD_LIMIT->selecting',
    'holding-HOLD_FAILED->selecting',
    'holding-HOLD_PAUSED->paused',
    'holding-HOLD_SALE_ENDED->saleEnded',
    'holding-SESSION_ENDED->ended',
    'selecting-SESSION_ENDED->ended',
    'held-EXPIRED->selecting',
    'paused-RESUME->selecting',
  ]) assert.ok(seen.has(t), t);
});

test('SCR-010 홀드 시간이 끝나면 고른 좌석을 비우고 알린다', () => {
  const s = send(start(), { type: 'TOGGLE', seat: seat(1) }, { type: 'HOLD' }, { type: 'HOLD_OK', hold: { holdId: 'h' } }, { type: 'EXPIRED' });
  assert.equal(s.value, 'selecting');
  assert.deepEqual(s.context.picks, []);
  assert.equal(s.context.hold, null);
  assert.deepEqual(s.context.notice, { kind: 'expired' });
});

test('SCR-010 회차 요약의 매수 한도로 바꾼다', () => {
  const a = start(4);
  const s = send(a, { type: 'SET_LIMIT', limit: 1 }, { type: 'TOGGLE', seat: seat(1) }, { type: 'TOGGLE', seat: seat(2) });
  assert.equal(s.context.picks.length, 1);
});

test('SCR-010 홀드 실패 → 이벤트(§3.6 holding 행)', () => {
  assert.deepEqual(holdOutcome({ status: 409, type: 'seat-already-held', extensions: { suggestedSeats: ['B-1', 3] } }), { type: 'HOLD_LOST', suggested: ['B-1'] });
  assert.deepEqual(holdOutcome({ status: 409, type: 'seat-recently-released', extensions: { recentlyReleasedSeats: ['A'], reholdAvailableAt: 't' } }), { type: 'HOLD_RECENT', seats: ['A'], availableAt: 't' });
  assert.deepEqual(holdOutcome({ status: 422, type: 'purchase-limit-exceeded' }), { type: 'HOLD_LIMIT' });
  assert.deepEqual(holdOutcome({ status: 422, type: 'invalid-seat' }), { type: 'HOLD_FAILED' });
  assert.deepEqual(holdOutcome({ status: 423, type: 'sale-paused' }), { type: 'HOLD_PAUSED' });
  assert.deepEqual(holdOutcome({ status: 410, type: 'sale-ended' }), { type: 'HOLD_SALE_ENDED' });
  assert.deepEqual(holdOutcome({ status: 403 }), { type: 'SESSION_ENDED' });
  assert.deepEqual(holdOutcome({ status: 401, type: 'purchase-session-ended' }), { type: 'SESSION_ENDED' });
  assert.deepEqual(holdOutcome({ status: 401, type: 'purchase-seq-reused' }), { type: 'SESSION_ENDED' });
  // 서명 불일치·입장 토큰 무효도 다시 보내지 않고 끝낸다(docs/frontend.md §5.3 '401', HOT-361)
  assert.deepEqual(holdOutcome({ status: 401, type: 'purchase-signature-invalid' }), { type: 'SESSION_ENDED' });
  assert.deepEqual(holdOutcome({ status: 401, type: 'admission-token-invalid' }), { type: 'SESSION_ENDED' });
  assert.deepEqual(holdOutcome({ status: 401, type: 'about:blank' }), { type: 'REFRESH' });
  // 본문 없는 401은 ApiError가 http-401로 준다
  assert.deepEqual(holdOutcome({ status: 401, type: 'http-401' }), { type: 'REFRESH' });
  assert.deepEqual(holdOutcome({ status: 503 }), { type: 'HOLD_FAILED' });
  assert.deepEqual(holdOutcome({}), { type: 'HOLD_FAILED' });
});

test('SCR-010 홀드 타이머 글: 올림, 마지막 1분은 warning', () => {
  assert.deepEqual(holdClock(419_001), { text: '홀드 7:00', ariaLabel: '홀드 남은 시간 7분 0초', tone: 'normal' });
  assert.equal(holdClock(60_000).tone, 'warning');
  assert.equal(holdClock(-5).text, '홀드 0:00');
});

test('SCR-010 멱등 키: 같은 좌석을 다시 시도하면 같은 키, 좌석이 바뀌면 새 키다(§4.1 멱등키)', () => {
  let n = 0;
  const make = () => `k${++n}`;
  const a = holdIdempotencyKey(null, ['B', 'A'], make);
  assert.deepEqual(a, { key: 'k1', seats: 'A,B' });
  assert.equal(holdIdempotencyKey(a, ['A', 'B'], make), a);
  assert.deepEqual(holdIdempotencyKey(a, ['A'], make), { key: 'k2', seats: 'A' });
});

test('[B-T19] 행동 요약은 첫 직접 선택 홀드에만 싣고, 같은 키의 재전송은 같은 값이며, 다음 좌석은 싣지 않는다', () => {
  let taken = 0;
  const take = () => {
    taken += 1;
    return { v: 1, windowMs: taken };
  };
  const a = behaviorForHold(null, 'k1', take);
  assert.deepEqual(a.behavior, { v: 1, windowMs: 1 });
  const again = behaviorForHold(a.first, 'k1', take);
  assert.equal(again.behavior, a.behavior);
  const next = behaviorForHold(again.first, 'k2', take);
  assert.equal(next.behavior, undefined);
  assert.equal(taken, 1);
  // 요약을 재지 못한 첫 요청 뒤에도 뒤 좌석에 싣지 않는다
  assert.equal(behaviorForHold(behaviorForHold(null, 'k1', () => undefined).first, 'k2', take).behavior, undefined);
});
