// 결제 결과 기계(FE-T24, docs/frontend.md §3.6 '결제 결과 기계', ADR-0079 결정 8, ADR-0230). 모델 기반 시험: @xstate/graph로 모든 상태와 전이를 돈다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAdjacencyMap, getShortestPaths } from '@xstate/graph';
import { createActor } from 'xstate';
import { FINISHED, nextPollMs, resultMachine, statusOutcome } from './result-machine.ts';
import { failureText } from './result-text.ts';

const start = () => createActor(resultMachine).start();
const send = (a, ...events) => (events.forEach((e) => a.send(e)), a.getSnapshot());
const S = (status, extra = {}) => ({ type: 'STATUS', status, ...extra });

const EVENTS = [
  S('ACCEPTED'),
  S('RESERVED'),
  S('APPROVED'),
  S('APPROVED', { issueDelayed: true }),
  S('CONFIRMED'),
  S('AWAITING_DEPOSIT', { virtualAccount: { bank: '은행', accountNumber: '1', dueAt: 'x' } }),
  S('FAILED', { reason: 'CARD_DECLINED' }),
  S('UNKNOWN'),
  S('COMPENSATED'),
  { type: 'LONG' },
  { type: 'UNKNOWN_HOUR' },
  { type: 'NOT_ACCEPTED' },
  { type: 'ORDER_EXPIRED' },
  { type: 'GONE' },
];
const ALL = ['checking', 'checkingLong', 'issuing', 'unknown', 'confirmed', 'awaitingDeposit', 'failed', 'compensated', 'notAccepted', 'orderExpired', 'gone'];
const opts = { events: EVENTS, serializeState: (s) => JSON.stringify([s.value, s.context.unknownLong, s.context.reason ?? null, s.context.account ? 1 : 0]) };

test('FE-T24 모든 상태에 이르는 경로가 있고 끝난 상태에서는 더 가지 않는다', () => {
  const paths = getShortestPaths(resultMachine, opts);
  const reached = new Set(paths.map((p) => p.state.value));
  assert.deepEqual([...reached].sort(), [...ALL].sort());
  const map = getAdjacencyMap(resultMachine, opts);
  for (const [key, node] of Object.entries(map)) {
    const value = JSON.parse(key)[0];
    if (!FINISHED.has(value)) continue;
    for (const t of Object.values(node.transitions)) assert.equal(JSON.parse(JSON.stringify(t.state.value)), value, `${value}에서 나가면 안 된다`);
  }
});

test('FE-T24 §3.6 표: 진행 중 상태는 확인 중에 머물고 끝 상태로 간다', () => {
  for (const st of ['ACCEPTED', 'RESERVED', 'APPROVED']) assert.equal(send(start(), S(st)).value, 'checking');
  assert.equal(send(start(), S('APPROVED', { issueDelayed: true })).value, 'issuing');
  assert.equal(send(start(), S('CONFIRMED')).value, 'confirmed');
  assert.equal(send(start(), S('COMPENSATED')).value, 'compensated');
  const f = send(start(), S('FAILED', { reason: 'SEAT_TAKEN' }));
  assert.deepEqual([f.value, f.context.reason], ['failed', 'SEAT_TAKEN']);
  const d = send(start(), S('AWAITING_DEPOSIT', { virtualAccount: { bank: 'B', accountNumber: '9', dueAt: 'D' } }));
  assert.deepEqual([d.value, d.context.account.bank], ['awaitingDeposit', 'B']);
});

test('FE-T24 120초가 지나면 결과 확인 중이고, 그 뒤에도 끝 상태로 간다', () => {
  const a = start();
  assert.equal(send(a, { type: 'LONG' }).value, 'checkingLong');
  assert.equal(send(a, S('APPROVED')).value, 'checkingLong');
  assert.equal(send(a, S('CONFIRMED')).value, 'confirmed');
});

test('FE-T24 발급 중과 결과 불명에서도 확정으로 바뀐다', () => {
  const a = start();
  assert.equal(send(a, S('APPROVED', { issueDelayed: true }), S('APPROVED', { issueDelayed: true })).value, 'issuing');
  assert.equal(send(a, S('CONFIRMED')).value, 'confirmed');
  const b = start();
  assert.equal(send(b, S('UNKNOWN')).value, 'unknown');
  assert.equal(send(b, { type: 'UNKNOWN_HOUR' }).context.unknownLong, true);
  assert.equal(send(b, S('UNKNOWN')).context.unknownLong, true, '다시 불명이어도 1시간 문구를 유지한다');
  assert.equal(send(b, S('CONFIRMED')).value, 'confirmed');
});

test('FE-T24 다시 묻는 간격: 120초까지 0.5~1.5초, 그 뒤 보이는 동안 30초, 10분이면 멈춘다', () => {
  assert.equal(nextPollMs('checking', 0, true, () => 0), 500);
  assert.equal(nextPollMs('checking', 119_999, false, () => 1), 1500);
  assert.equal(nextPollMs('checkingLong', 120_000, true), 30_000);
  assert.equal(nextPollMs('checkingLong', 120_000, false), null, '숨긴 탭은 120초 뒤 묻지 않는다');
  assert.equal(nextPollMs('checkingLong', 600_000, true), null);
  assert.equal(nextPollMs('unknown', 1000, true), 30_000);
  assert.equal(nextPollMs('issuing', 1000, true, () => 0), 500);
  for (const s of FINISHED) assert.equal(nextPollMs(s, 0, true), null);
});

test('FE-T24 조회 실패 → 기계 이벤트(openapi getOrderPaymentStatus)', () => {
  assert.deepEqual(statusOutcome({ status: 401 }), { kind: 'refresh' });
  assert.deepEqual(statusOutcome({ status: 404 }), { kind: 'event', event: { type: 'GONE' } });
  assert.deepEqual(statusOutcome({ status: 409, type: 'payment-not-accepted' }), { kind: 'event', event: { type: 'NOT_ACCEPTED' } });
  assert.deepEqual(statusOutcome({ status: 409, type: 'order-expired' }), { kind: 'event', event: { type: 'ORDER_EXPIRED' } });
  assert.deepEqual(statusOutcome({ status: 429 }), { kind: 'retry' });
  assert.deepEqual(statusOutcome({ status: 504 }), { kind: 'retry' });
  assert.deepEqual(statusOutcome({}), { kind: 'retry' });
});

test('FE-T24 실패 문구는 사유별이고 모두 요금 안내를 담는다(d5 §9.2)', () => {
  assert.equal(failureText('CARD_DECLINED'), '카드사에서 결제를 승인하지 않아 좌석이 해제되었습니다. 요금은 청구되지 않았습니다. 좌석을 다시 골라 주세요');
  assert.equal(failureText('SEAT_TAKEN'), '좌석이 이미 판매되어 결제되지 않았습니다. 요금은 청구되지 않습니다');
  assert.equal(failureText('EXPIRED'), '결제 승인 시간이 지나 결제되지 않았습니다. 요금은 청구되지 않습니다');
  for (const r of ['VALIDATION', 'PG_ERROR', 'THROTTLED', 'QUOTA_EXCEEDED', 'STALE_GEN', 'STORE_GONE', undefined, '모름']) assert.match(failureText(r), /요금은 청구되지 않/);
});
