// SCR-033·SCR-035 actual-data mapping and freshness (GAT-170).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChanges, formatAge, formatClockOffset, freshnessOf, loadSyncSnapshot, reloginRequired, saveSyncSnapshot, serverClockOffsetMs, sessionExpiryDelayMs, sessionTerminatedOf, setupStateOf, syncChangePages, syncStateOf, type SyncSnapshot } from '../src/api/live.ts';
import type { ScannerShiftResponse, ScannerVersionVector } from '../src/api/client.ts';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60_000;

const vector = (over: Partial<ScannerVersionVector> = {}): ScannerVersionVector => ({
  eventId: 'ev-1',
  seq: 10,
  ticketSeq: 4,
  keySeq: 0,
  policySeq: 0,
  placementSeq: 1,
  flagSeq: 0,
  issuedAt: new Date(NOW).toISOString(),
  maxOfflineMs: 24 * HOUR,
  ...over,
});

const shift = (over: Partial<ScannerShiftResponse['device']> = {}, packageOver: Partial<ScannerShiftResponse['package']> = {}): ScannerShiftResponse => ({
  serverTime: new Date(NOW).toISOString(),
  eventId: 'ev-1',
  reentryAllowed: false,
  placement: { gateZone: '동문', mode: 'IN' },
  packageSeq: 10,
  role: 'gate_staff',
  proxy: false,
  device: { deviceId: 'dev-1', name: '동문-03', status: 'ACTIVE', credentialType: 'DEVICE_KEY', enrolled: true, mtls: false, ...over },
  assignment: { assignmentId: 'a-1', role: 'gate_staff', validFrom: new Date(NOW - HOUR).toISOString(), validUntil: new Date(NOW + HOUR).toISOString(), proxy: false },
  package: { seq: 10, issuedAt: new Date(NOW).toISOString(), maxOfflineMs: 24 * HOUR, stale: false, ...packageOver },
  versionVector: vector(),
  auth: { deviceProof: 'DPOP', staffSession: true },
});

test('setupStateOf는 기기 상태·등록·낡은 목록을 가른다', () => {
  assert.equal(setupStateOf(shift()), '준비 완료');
  assert.equal(setupStateOf(shift({ status: 'REVOKED' })), '미등록·폐기 기기');
  assert.equal(setupStateOf(shift({ enrolled: false })), '미등록·폐기 기기');
  assert.equal(setupStateOf(shift({}, { stale: true })), '준비 중');
});

test('시계 오차·나이 표기 경계', () => {
  assert.equal(formatClockOffset(undefined), '—');
  assert.equal(formatClockOffset(400), '+400ms');
  assert.equal(formatClockOffset(-1500), '-1.5초');
  assert.equal(formatClockOffset(0), '+0ms');
  assert.equal(formatAge(0), '0초 전');
  assert.equal(formatAge(59_999), '59초 전');
  assert.equal(formatAge(60_000), '1분 전');
  assert.equal(formatAge(59 * 60_000), '59분 전');
  assert.equal(formatAge(60 * 60_000), '1시간 전');
  assert.equal(formatAge(24 * HOUR), '1일 전');
});

test('신선도는 오프라인 허용 시간 경계에서 뒤집힌다', () => {
  const snapshot: SyncSnapshot = { eventId: 'ev-1', lastSeq: 10, syncedAtMs: NOW };
  const fresh = freshnessOf({ stored: vector(), current: vector(), snapshot, nowMs: NOW + 24 * HOUR, queue: 0 });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.resync, false);
  const stale = freshnessOf({ stored: vector(), current: vector(), snapshot, nowMs: NOW + 24 * HOUR + 1, queue: 0 });
  assert.equal(stale.stale, true);
  assert.equal(stale.resync, true);
  assert.equal(syncStateOf({ freshness: stale, queue: 0 }), '변경분 지연');
});

test('서버 벡터가 저장 벡터보다 뒤처지면 재동기화가 필요하다', () => {
  const snapshot: SyncSnapshot = { eventId: 'ev-1', lastSeq: 10, syncedAtMs: NOW };
  const behind = freshnessOf({ stored: vector({ seq: 12, ticketSeq: 9 }), current: vector({ seq: 10 }), snapshot, nowMs: NOW, queue: 0 });
  assert.equal(behind.resync, true);
  assert.equal(behind.stale, true);
  const ahead = freshnessOf({ stored: vector({ seq: 9 }), current: vector({ seq: 10 }), snapshot, nowMs: NOW, queue: 0 });
  assert.equal(ahead.resync, false);
  assert.equal(ahead.stale, false);
});

test('업로드 실패는 대기 건이 있을 때만 표시한다', () => {
  const f = freshnessOf({ stored: vector(), current: vector(), snapshot: { eventId: 'ev-1', lastSeq: 10, syncedAtMs: NOW }, nowMs: NOW, queue: 3 });
  assert.equal(syncStateOf({ freshness: f, queue: 3, uploadFailed: true }), '업로드 실패');
  assert.equal(syncStateOf({ freshness: f, queue: 0, uploadFailed: true }), '정상');
});

test('동기화 스냅샷과 변경분 반영은 마지막 번호를 서버 값으로 둔다', () => {
  const storage = new Map<string, string>();
  const s: SyncSnapshot = { eventId: 'ev-1', lastSeq: 10, syncedAtMs: NOW, lastUploadAtMs: NOW - 1000 };
  saveSyncSnapshot({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) }, s);
  assert.deepEqual(loadSyncSnapshot({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) }), s);
  const next = applyChanges(s, { changes: [], lastSeq: 12, hasMore: false, versionVector: vector({ seq: 12 }) }, NOW + 500);
  assert.equal(next.lastSeq, 12);
  assert.equal(next.syncedAtMs, NOW + 500);
});

test('라이브 401·기기 폐기·세션 종료는 재로그인으로 돌린다(C1-09)', () => {
  assert.equal(reloginRequired(401, 'invalid_token'), true);
  assert.equal(reloginRequired(403, 'device-revoked'), true);
  assert.equal(reloginRequired(403, 'invalid_token'), true);
  assert.equal(reloginRequired(403, 'scanner-override-forbidden'), false);
  assert.equal(reloginRequired(503, 'scanner-auth-unavailable'), false);
});

test('DPoP 시계 보정과 세션 만료 타이머는 서버 시각·만료 경계를 쓴다(C1-07·C1-08)', () => {
  assert.equal(serverClockOffsetMs(new Date(NOW + 4_000).toISOString(), NOW), 4_000);
  assert.equal(serverClockOffsetMs('깨진 시각', NOW), 0);
  assert.equal(sessionExpiryDelayMs(NOW + 10_000, NOW), 10_000);
  assert.equal(sessionExpiryDelayMs(NOW, NOW), 0);
  assert.equal(sessionExpiryDelayMs(Number.MAX_SAFE_INTEGER, NOW), undefined);
});

test('변경분 페이지는 페이지 끝 번호를 다음 커서로 쓰고, 세션 종료에서 멈춘다(C1-05·C1-06)', async () => {
  const seen: number[] = [];
  const pages = [
    { changes: [{ seq: 1, kind: 'TICKET_STATUS', payload: {} }], lastSeq: 1, hasMore: true, versionVector: vector({ seq: 3 }) },
    { changes: [{ seq: 2, kind: 'SCAN_STATE', payload: {} }], lastSeq: 2, hasMore: true, versionVector: vector({ seq: 3 }) },
    { changes: [{ seq: 3, kind: 'FLAG', payload: {} }], lastSeq: 3, hasMore: false, versionVector: vector({ seq: 3 }) },
  ];
  const result = await syncChangePages({
    snapshot: { eventId: 'ev-1', lastSeq: 0, syncedAtMs: 0 },
    after: 0,
    deviceId: 'dev-1',
    nowMs: NOW,
    fetchPage: async (after) => {
      seen.push(after);
      return pages[after]!;
    },
  });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(result.snapshot.lastSeq, 3);
  assert.equal(result.last?.lastSeq, 3);

  const terminated = await syncChangePages({
    snapshot: { eventId: 'ev-1', lastSeq: 1, syncedAtMs: NOW },
    after: 1,
    deviceId: 'dev-1',
    nowMs: NOW,
    fetchPage: async () => ({
      changes: [{ seq: 2, kind: 'SESSION_TERMINATED', payload: { v: 1, deviceId: 'dev-1', reason: 'DEVICE_REVOKED' } }],
      lastSeq: 2,
      hasMore: true,
      versionVector: vector({ seq: 2 }),
    }),
  });
  assert.deepEqual(terminated.terminated, { reason: 'DEVICE_REVOKED' });
  assert.equal(terminated.snapshot.lastSeq, 1);
});

test('SESSION_TERMINATED 변경분은 그 기기의 세션 종료만 골라 읽는다', () => {
  const base = { lastSeq: 13, hasMore: false, versionVector: vector({ seq: 13 }) };
  const other = sessionTerminatedOf({ ...base, changes: [{ seq: 12, kind: 'SESSION_TERMINATED', payload: { v: 1, deviceId: 'other', reason: 'DEVICE_REVOKED' } }] }, 'mine');
  assert.equal(other, undefined);
  const mine = sessionTerminatedOf({ ...base, changes: [{ seq: 12, kind: 'TICKET_STATUS', payload: {} }, { seq: 13, kind: 'SESSION_TERMINATED', payload: { v: 1, deviceId: 'mine', reason: 'DEVICE_REVOKED' } }] }, 'mine');
  assert.deepEqual(mine, { reason: 'DEVICE_REVOKED' });
  assert.deepEqual(sessionTerminatedOf({ ...base, changes: [{ seq: 13, kind: 'SESSION_TERMINATED', payload: { deviceId: 'mine' } }] }, 'mine'), {});
});
