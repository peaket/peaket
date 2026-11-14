// SCR-033·SCR-035 actual-data mapping and freshness (GAT-170).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChanges, formatAge, formatClockOffset, freshnessOf, loadSyncSnapshot, saveSyncSnapshot, setupStateOf, syncStateOf, type SyncSnapshot } from '../src/api/live.ts';
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
