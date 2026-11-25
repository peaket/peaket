// F-05-10 현장 책임자 신선도 알림(앱) 시험(계획 docs/review/plans/F-05-10.md §3·§5).
// 정본: docs/features/offline-gate.md §7.2 '현장 책임자 신선도 알림', O-T20(2분 [정본], 경계는 아직 신선).
// 서버가 gate_lead에게만 staleDevices를 주고, 앱은 같은 구역 것만 배너로 보인다. React를 읽지 않는 순수 모듈이다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

type Stale = { deviceId: string; deviceName: string; gateZone: string; lastChangesAt: string; ageMs: number; thresholdMs: number };
type Banner = { deviceId: string; title: string; detail: string };
type Module = {
  freshnessBannersOf(i: { role?: 'gate_staff' | 'gate_lead'; placementZone?: string; staleDevices?: readonly Stale[] }): Banner[];
  isFreshnessStale(i: { lastChangesAtMs: number; nowMs: number; thresholdMs?: number }): boolean;
};

const MODULE = '../src/app/freshness-notice.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<Module>;
function mod(): Module {
  for (const name of ['freshnessBannersOf', 'isFreshnessStale'] as const) {
    assert.equal(typeof loaded[name], 'function', `${MODULE}의 ${name}가 없다`);
  }
  return loaded as Module;
}

const NOW = Date.parse('2026-11-26T19:03:00+09:00');
const stale = (over: Partial<Stale> = {}): Stale => ({
  deviceId: '0190f3a1-7c2e-7a00-8000-0000000f5482',
  deviceName: '동문-03',
  gateZone: '동문',
  lastChangesAt: new Date(NOW - 180_000).toISOString(),
  ageMs: 180_000,
  thresholdMs: 120_000,
  ...over,
});

test('O-T20 현장 책임자 화면은 같은 구역 기기의 동기화 지연을 2분 기준과 경과로 보인다', () => {
  const m = mod();
  const banners = m.freshnessBannersOf({
    role: 'gate_lead',
    placementZone: '동문',
    staleDevices: [
      stale(),
      stale({ deviceId: 'd-2', deviceName: '동문-04', ageMs: 121_000 }),
      stale({ deviceId: 'd-3', deviceName: '서문-01', gateZone: '서문', ageMs: 200_000 }),
    ],
  });
  assert.equal(banners.length, 2, '응답에 섞인 다른 구역 기기는 배너로 만들지 않는다');
  assert.deepEqual(banners.map((b) => b.deviceId), ['0190f3a1-7c2e-7a00-8000-0000000f5482', 'd-2']);
  assert.match(banners[0].title, /동문-03/);
  assert.match(banners[0].title, /2분/);
  assert.match(banners[0].detail, /3분/);
  assert.match(banners[1].detail, /2분/);
});

test('O-T20 현장 책임자가 아니거나 다른 구역이면 알림을 보이지 않는다', () => {
  const m = mod();
  assert.deepEqual(m.freshnessBannersOf({ role: 'gate_staff', placementZone: '동문', staleDevices: [stale()] }), []);
  assert.deepEqual(m.freshnessBannersOf({ placementZone: '동문', staleDevices: [stale()] }), []);
  assert.deepEqual(m.freshnessBannersOf({ role: 'gate_lead', placementZone: '서문', staleDevices: [stale()] }), []);
  assert.deepEqual(m.freshnessBannersOf({ role: 'gate_lead', staleDevices: [stale()] }), []);
  assert.deepEqual(m.freshnessBannersOf({ role: 'gate_lead', placementZone: '동문' }), []);
  assert.deepEqual(m.freshnessBannersOf({ role: 'gate_lead', placementZone: '동문', staleDevices: [] }), []);
});

test('O-T20 기기가 다시 동기화하면 다음 변경분에서 알림이 사라진다', () => {
  const m = mod();
  const before = m.freshnessBannersOf({ role: 'gate_lead', placementZone: '동문', staleDevices: [stale()] });
  assert.equal(before.length, 1);
  const after = m.freshnessBannersOf({ role: 'gate_lead', placementZone: '동문', staleDevices: [] });
  assert.deepEqual(after, []);
});

test('O-T20 신선도 경계는 정확히 2분이면 아직 신선하고 1ms 뒤부터 늦다', () => {
  const m = mod();
  assert.equal(m.isFreshnessStale({ lastChangesAtMs: NOW - 120_000, nowMs: NOW }), false);
  assert.equal(m.isFreshnessStale({ lastChangesAtMs: NOW - 120_001, nowMs: NOW }), true);
  assert.equal(m.isFreshnessStale({ lastChangesAtMs: NOW - 120_001, nowMs: NOW, thresholdMs: 60_000 }), true);
  assert.equal(m.isFreshnessStale({ lastChangesAtMs: NOW - 59_999, nowMs: NOW, thresholdMs: 60_000 }), false);
  assert.equal(m.isFreshnessStale({ lastChangesAtMs: NOW + 1_000, nowMs: NOW }), false, '앞선 시각은 늦지 않다');
});
