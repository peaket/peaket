// 공연 상세의 사전 검증 토큰(SCR-002, docs/frontend.md §3.12·§4.2.1 3번, ADR-0211 결정 3·4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBehaviorTracker, needsRefresh, readPreverify, usableForEntry, writePreverify } from './model.ts';
import { outcomeOfError, preverifyFromResponse } from './flow.ts';
import { createStore } from '../../../queue-room/src/live/store.ts';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
const NOW = 1_800_000_000_000;

test('SCR-002 사전 검증 토큰을 회차 키에 쓰되 대기실이 둔 다른 값(대기표·진행 중 진입)은 그대로 둔다', () => {
  const kv = memory();
  kv.setItem('peaket.queue.e1', JSON.stringify({ entry: { entryRequestId: 'r1', token: 'old' }, savedAt: NOW - 10 }));
  assert.equal(writePreverify(kv, 'e1', { token: 'pv-1', issuedAt: NOW, expiresAt: NOW + 900_000 }, NOW), true);
  const r = JSON.parse(kv.getItem('peaket.queue.e1'));
  assert.deepEqual([r.preverifyToken, r.preverifyIssuedAt, r.preverifyExpiresAt, r.savedAt, r.entry.entryRequestId], ['pv-1', NOW, NOW + 900_000, NOW, 'r1']);
  assert.deepEqual(readPreverify(kv, 'e1', NOW + 1000), { token: 'pv-1', issuedAt: NOW, expiresAt: NOW + 900_000 });
  assert.equal(readPreverify(kv, 'e1', NOW + 900_000), null, '만료되면 없다');
  // 대기실이 다시 써서 만료 칸이 없으면 발급 + 15분으로 본다
  kv.setItem('peaket.queue.e1', JSON.stringify({ preverifyToken: 'pv-2', preverifyIssuedAt: NOW, savedAt: NOW }));
  assert.equal(readPreverify(kv, 'e1', NOW).expiresAt, NOW + 900_000);
  // 꼴이 틀리거나 저장소를 못 쓰면
  kv.setItem('peaket.queue.e1', '{oops');
  assert.equal(readPreverify(kv, 'e1', NOW), null);
  assert.equal(writePreverify(kv, 'e1', { token: 'pv-3', issuedAt: NOW, expiresAt: NOW + 1 }, NOW), true, '깨진 값은 새로 쓴다');
  assert.equal(writePreverify({ getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined }, 'e1', { token: 'x', issuedAt: NOW, expiresAt: NOW + 1 }, NOW), false);
  assert.equal(readPreverify(null, 'e1', NOW), null);
});

test('SCR-002 만료 2분 전부터 갱신하고, 진입에 쓰려면 30초 넘게 남아야 한다', () => {
  const p = { token: 't', issuedAt: NOW, expiresAt: NOW + 900_000 };
  assert.equal(needsRefresh(p, NOW + 900_000 - 120_001), false);
  assert.equal(needsRefresh(p, NOW + 900_000 - 120_000), true);
  assert.equal(usableForEntry(p, NOW + 900_000 - 30_001), true);
  assert.equal(usableForEntry(p, NOW + 900_000 - 30_000), false);
  assert.equal(usableForEntry(null, NOW), false);
});

test('SCR-002 201 본문(PreverifyResult)을 읽는다. 꼴이 틀리면 null', () => {
  assert.deepEqual(preverifyFromResponse({ preverifyToken: 'pv', expiresAt: new Date(NOW + 900_000).toISOString(), serverTimeMs: NOW }, NOW), { token: 'pv', issuedAt: NOW, expiresAt: NOW + 900_000 });
  assert.equal(preverifyFromResponse({ preverifyToken: '', expiresAt: 'x' }, NOW), null);
  assert.equal(preverifyFromResponse(null, NOW), null);
});

test('SCR-002 사전 검증 오류: 본인확인 전 403은 본인확인, 404는 대기열 미개방, 400·403·428은 사람 확인 실패, 503·429·연결 실패는 하한 위 지터 뒤 다시, 401은 로그인', () => {
  const err = (status, type, retryAfter = null) => Object.assign(new Error('x'), { name: 'ApiError', status, type, retryAfter });
  const r = () => 0.5;
  assert.deepEqual(outcomeOfError(err(403, 'identity-verification-required'), r), { kind: 'verify' });
  assert.deepEqual(outcomeOfError(err(404, 'queue-not-found'), r), { kind: 'not-open' });
  for (const [s, t] of [[400, 'about:blank'], [403, 'human-check-failed'], [428, 'human-check-required']]) assert.deepEqual(outcomeOfError(err(s, t), r), { kind: 'failed' }, `${s}`);
  assert.deepEqual(outcomeOfError(err(503, 'human-check-unavailable', '4'), r), { kind: 'retry', delayMs: 4400 }, 'Retry-After × (1 + U(0, 0.2))');
  assert.deepEqual(outcomeOfError(err(429, 'server-busy', '1.5'), r), { kind: 'retry', delayMs: 1000 }, '정수 초가 아니면 버리고 전체 지터(첫 시도 0.5 × 2초)');
  assert.deepEqual(outcomeOfError(new TypeError('끊김'), r), { kind: 'retry', delayMs: 1000 });
  assert.deepEqual(outcomeOfError(err(401, 'about:blank'), r), { kind: 'login' });
  assert.deepEqual(outcomeOfError(err(503, 'refresh-unavailable'), r, 3), { kind: 'retry', delayMs: 4000 }, '실패 수만큼 늘린다(상한 8초)');
  // HTTP 날짜 꼴 Retry-After는 같은 응답의 Date와 견준다(§5.9)
  const dated = Object.assign(err(503, 'human-check-unavailable', 'Thu, 05 Nov 2026 12:00:05 GMT'), { date: 'Thu, 05 Nov 2026 12:00:00 GMT' });
  assert.deepEqual(outcomeOfError(dated, r, 1, 0), { kind: 'retry', delayMs: 5500 });
});

test('SCR-002 행동 신호 요약 v1: 수·엔트로피·입력 간격만(좌표·키 값은 남기지 않는다)', () => {
  let t = 1000;
  const b = createBehaviorTracker(() => t);
  const empty = b.summary();
  assert.deepEqual(empty, { v: 1, windowMs: 0, pointerMoves: 0, pointerEntropy: 0, scrollEvents: 0, scrollDistancePx: 0 });
  // 네 방향으로 같은 수만큼 움직이면 엔트로피 2비트
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  for (const [x, y] of pts) b.move(x, y);
  for (const dt of [100, 200, 300]) {
    t += dt;
    b.input();
  }
  b.scroll(-120);
  b.scroll(80);
  t = 61_000;
  const s = b.summary();
  assert.equal(s.v, 1);
  assert.equal(s.windowMs, 60_000);
  assert.equal(s.pointerMoves, 9);
  assert.equal(s.pointerEntropy, 2);
  assert.equal(s.inputIntervalMeanMs, 250);
  assert.equal(s.inputIntervalStdMs, 50);
  assert.deepEqual([s.scrollEvents, s.scrollDistancePx], [2, 200]);
  assert.deepEqual(Object.keys(s).sort(), ['inputIntervalMeanMs', 'inputIntervalStdMs', 'pointerEntropy', 'pointerMoves', 'scrollDistancePx', 'scrollEvents', 'v', 'windowMs']);
  t = 10_000_000;
  assert.equal(b.summary().windowMs, 3_600_000, '계약 상한');
  b.move(5, 5);
  assert.equal(b.summary().pointerMoves, 9, '1시간이 지나면 더 세지 않는다');
  // 단조 시계(performance.now)는 소수다: 계약의 정수 칸은 정수로 보낸다(브라우저 확인에서 400으로 찾음)
  let f = 0.25;
  const c = createBehaviorTracker(() => f);
  f = 1234.567;
  assert.equal(c.summary().windowMs, 1234);
  assert.ok(Number.isInteger(c.summary().windowMs));
});

test('SCR-002 공연 상세가 쓴 값을 대기실 저장소가 그대로 읽는다(보정 시계가 소수여도, 브라우저 확인에서 찾음)', () => {
  const kv = memory();
  const now = NOW + 0.375;
  const p = preverifyFromResponse({ preverifyToken: 'pv-x', expiresAt: new Date(NOW + 900_000).toISOString() }, now);
  assert.ok(writePreverify(kv, 'e1', p, now));
  const store = createStore('e1', kv, memory(), () => NOW + 1000, (n) => new Uint8Array(n).fill(1));
  const rec = store.read();
  assert.equal(rec?.preverifyToken, 'pv-x', '대기실이 버리지 않는다');
  assert.equal(rec.preverifyExpiresAt, NOW + 900_000);
  // 대기실이 다시 써도 만료 시각이 남아 공연 상세가 다시 읽는다
  store.write({ entry: { entryRequestId: 'r', token: 'pv-x' } });
  assert.equal(readPreverify(kv, 'e1', NOW + 1000)?.expiresAt, NOW + 900_000);
});
