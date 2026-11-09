// 서버 시각 보정(docs/frontend.md §3.3, ADR-0110): 캐시하지 않는 응답의 Date로 표본을 받아 왕복이 가장 짧은 표본을 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from './clock.ts';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('표본이 없으면 기기 시계를 그대로 쓴다', () => {
  const c = createClock({ wall: () => 1_000_000, mono: () => 0, storage: memoryStorage() });
  assert.equal(c.now(), 1_000_000);
});

test('offset = 서버 시각 + 왕복/2 − 받은 시각이고, 받은 뒤의 경과는 단조 시계로 잰다(기기 시계가 바뀌어도 흔들리지 않는다)', () => {
  let wall = 1_000_000;
  let mono = 500;
  const c = createClock({ wall: () => wall, mono: () => mono, storage: memoryStorage() });
  // 보낸 때 mono 500, 받은 때 mono 700(왕복 200ms), 서버 시각 1,010,000 → 받은 순간 서버 시각 1,010,100
  mono = 700;
  c.addSample({ serverMs: 1_010_000, sentMono: 500, receivedMono: 700 });
  assert.equal(c.now(), 1_010_100);
  mono = 1_700; // 1초 뒤
  wall = 0; // 기기 시계를 크게 바꿔도
  assert.equal(c.now(), 1_011_100);
});

test('최근 8개 가운데 왕복이 가장 짧은 표본을 쓴다', () => {
  let mono = 0;
  const c = createClock({ wall: () => 0, mono: () => mono, storage: memoryStorage() });
  c.addSample({ serverMs: 5_000, sentMono: 0, receivedMono: 400 }); // 왕복 400
  c.addSample({ serverMs: 9_000, sentMono: 1_000, receivedMono: 1_050 }); // 왕복 50 → 받은 순간 9,025
  c.addSample({ serverMs: 9_999, sentMono: 1_100, receivedMono: 1_400 }); // 왕복 300
  mono = 1_050;
  assert.equal(c.now(), 9_025);
  // 짧은 표본이 8개 밖으로 밀리면 남은 것 가운데 가장 짧은 것을 쓴다
  for (let i = 0; i < 8; i += 1) c.addSample({ serverMs: 20_000, sentMono: 2_000, receivedMono: 2_100 }); // 왕복 100 → 20,050
  mono = 2_100;
  assert.equal(c.now(), 20_050);
});

test('Date 머리(초 단위)를 표본으로 받는다: 초의 가운데(+500ms)로 보고, 머리가 없거나 틀리면 버린다', () => {
  const c = createClock({ wall: () => 0, mono: () => 100, storage: memoryStorage() });
  assert.equal(c.addDateHeader(null, 0, 100), false);
  assert.equal(c.addDateHeader('not a date', 0, 100), false);
  assert.equal(c.addDateHeader('Thu, 05 Nov 2026 03:00:00 GMT', 0, 100), true);
  assert.equal(c.now(), Date.parse('2026-11-05T03:00:00Z') + 500 + 50);
});

test('보정값은 peaket.clock에 두고 30분 안이면 다시 연 탭도 쓴다(30분이 지났거나 모양이 틀리면 버린다)', () => {
  const storage = memoryStorage();
  let wall = 1_000_000;
  const a = createClock({ wall: () => wall, mono: () => 0, storage });
  a.addSample({ serverMs: 1_005_000, sentMono: 0, receivedMono: 0 });
  const saved = JSON.parse(storage.m.get('peaket.clock'));
  assert.equal(saved.offsetMs, 5_000);
  assert.equal(saved.sampledAt, 1_000_000);
  assert.equal(saved.rttMs, 0);
  wall = 1_000_000 + 29 * 60_000;
  assert.equal(createClock({ wall: () => wall, mono: () => 0, storage }).now(), wall + 5_000);
  wall = 1_000_000 + 31 * 60_000;
  assert.equal(createClock({ wall: () => wall, mono: () => 0, storage }).now(), wall);
  storage.setItem('peaket.clock', '{"offsetMs":"x"}');
  assert.equal(createClock({ wall: () => wall, mono: () => 0, storage }).now(), wall);
});

test('저장소를 쓸 수 없어도(사생활 보호 모드) 동작한다', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const c = createClock({ wall: () => 10, mono: () => 0, storage: broken });
  c.addSample({ serverMs: 20, sentMono: 0, receivedMono: 0 });
  assert.equal(c.now(), 20);
});
