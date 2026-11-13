// 자동 배정 공연의 희망 조건·차례 직전 직접 확인·차례 알림(SCR-007·008, ADR-0212)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreference, readPreference, writePreference } from '../src/live/preference.ts';
import { alertDue, titlePrefix } from '../src/live/alert.ts';
import { createWorld, harness, memory, openTab, reply, START, stateFile } from './harness.mjs';

const TIERS = [
  { id: 'tier-r', name: 'R석' },
  { id: 'tier-s', name: 'S석' },
  { id: 'tier-a', name: 'A석' },
];

test('[ASVS v5.0.0-14.3.3] SCR-008 희망 조건: 기본값은 첫 등급 1매, 저장 꼴을 검사하고 그 회차에 없는 등급·상한을 넘는 매수·2순위 = 1순위는 버린다', () => {
  const kv = memory();
  assert.deepEqual(defaultPreference(TIERS), { firstTierId: 'tier-r', count: 1, wheelchair: false, allowSplit: false });
  assert.equal(readPreference(kv, 'e1', TIERS, 4), null, '저장된 값이 없으면 null(저장됨 표시 없음)');
  assert.equal(writePreference(kv, 'e1', { firstTierId: 'tier-s', count: 2, wheelchair: true, secondTierId: 'tier-a', allowSplit: true }, START), true);
  const raw = JSON.parse(kv.getItem('peaket.autoassign.e1'));
  assert.deepEqual(raw, { v: 1, firstTierId: 'tier-s', count: 2, wheelchair: true, secondTierId: 'tier-a', allowSplit: true, savedAt: START });
  assert.deepEqual(readPreference(kv, 'e1', TIERS, 4), { firstTierId: 'tier-s', count: 2, wheelchair: true, secondTierId: 'tier-a', allowSplit: true });
  for (const bad of [{ firstTierId: 'tier-x', count: 1 }, { firstTierId: 'tier-r', count: 9 }, { firstTierId: 'tier-r', count: 0 }, { firstTierId: 'tier-r', count: 1, secondTierId: 'tier-r' }, { v: 2, firstTierId: 'tier-r', count: 1 }]) {
    kv.setItem('peaket.autoassign.e1', JSON.stringify({ v: 1, wheelchair: false, allowSplit: false, savedAt: START, ...bad }));
    assert.equal(readPreference(kv, 'e1', TIERS, 4), null, JSON.stringify(bad));
  }
  kv.setItem('peaket.autoassign.e1', '{x');
  assert.equal(readPreference(kv, 'e1', TIERS, 4), null);
  assert.equal(writePreference({ getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined }, 'e1', defaultPreference(TIERS), START), false);
});

test('SCR-008 탭 제목 카운트다운: 숨긴 탭이고 예상 대기 5분 안이면 남은 시간을 붙인다(60초 안이면 초)', () => {
  assert.equal(titlePrefix(120, true), '(약 2분) ');
  assert.equal(titlePrefix(45, true), '(45초) ');
  assert.equal(titlePrefix(301, true), '');
  assert.equal(titlePrefix(30, false), '', '보이는 탭은 붙이지 않는다');
  assert.equal(titlePrefix(null, true), '', '예상 대기를 모르면 붙이지 않는다');
});

test('SCR-008 차례 알림: 켜 둔 뒤 예상 대기가 60초 안이거나 유예가 되면 한 번만', () => {
  assert.equal(alertDue({ state: 'waiting', etaSec: 61 }, false), false);
  assert.equal(alertDue({ state: 'waiting', etaSec: 60 }, false), true);
  assert.equal(alertDue({ state: 'grace' }, false), true);
  assert.equal(alertDue({ state: 'waiting', etaSec: 10 }, true), false, '이미 알렸으면 다시 알리지 않는다');
  assert.equal(alertDue({ state: 'paused', etaSec: null }, false), false);
});

const TICKET = { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 };
const AUTO = { openAtMs: START - 60_000, lobbyOpensAtMs: null, autoAssign: true };

test('Q-T25 자동 배정 공연의 차례 직전 직접 확인: 예상 대기 10초 안이면 예상 도래 시각에 보내고, NOT_YET이면 retryAfterMs 뒤 지터 없이 다시', async () => {
  const admits = [];
  let serving = 980; // 앞 19명, 속도 2 → 9.5초
  const h = harness({
    schedule: AUTO,
    rec: { ticket: TICKET },
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        admits.push(now);
        return serving >= 1000 ? reply(200, { status: 'ADMITTED', admissionToken: 'adm', serverTimeMs: now }) : reply(200, { status: 'NOT_YET', retryAfterMs: 3000, serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  await h.run(9000);
  assert.equal(admits.length, 0, '예상 도래 시각(9.5초) 전에는 보내지 않는다');
  await h.run(600);
  assert.equal(admits.length, 1, '예상 도래 시각에 직접 확인');
  assert.ok(admits[0] - START >= 9500);
  await h.run(2899);
  assert.equal(admits.length, 1, 'NOT_YET 하한 전에는 다시 보내지 않는다');
  serving = 1000;
  await h.run(101);
  assert.equal(admits.length, 2);
  assert.equal(admits[1] - admits[0], 3000, '지터 없이 그 시각에');
  assert.deepEqual(h.navs, ['/booking/e1/seats']);
});

test('Q-T25 직접 선택 공연·숨긴 탭은 차례 직전 직접 확인을 하지 않는다', async () => {
  for (const [schedule, hidden] of [[{ ...AUTO, autoAssign: false }, false], [AUTO, true]]) {
    const admits = [];
    const h = harness({
      schedule,
      hidden,
      rec: { ticket: TICKET },
      handler: ({ m, url, now }) => {
        if (m === 'GET') return reply(200, stateFile({ serving: 990, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
        if (m === 'POST' && url.endsWith('/admission')) admits.push(now);
        return reply(500);
      },
    });
    await h.start();
    await h.run(8000);
    assert.equal(admits.length, 0, JSON.stringify({ auto: schedule.autoAssign, hidden }));
  }
});

test('SCR-008 판매 종료(ENDED)면 이 회차의 희망 조건도 지운다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  w.local.setItem('peaket.autoassign.e1', JSON.stringify({ v: 1, firstTierId: 'tier-r', count: 1, wheelchair: false, allowSplit: false, savedAt: START }));
  const t = openTab(w, { handler: ({ now }) => reply(200, stateFile({ saleStatus: 'ENDED', generatedAtMs: now })) });
  await t.start();
  assert.equal(t.last().state, 'ended');
  assert.equal(w.local.getItem('peaket.autoassign.e1'), null);
});

// ── 새 맥락 리뷰(2026-11-05)에서 찾은 것의 재현 ──
test('Q-T25 직접 확인 중에는 화면이 대기 그대로다(입장 중으로 깜박이지 않는다), NOT_YET의 retryAfterMs는 1초보다 짧아도 1초 뒤에', async () => {
  const admits = [];
  const h = harness({
    schedule: AUTO,
    rec: { ticket: TICKET },
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving: 990, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        admits.push(now);
        return reply(200, { status: 'NOT_YET', retryAfterMs: 200, serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  await h.run(8000);
  assert.ok(admits.length >= 2);
  const gaps = admits.slice(1).map((t, i) => t - admits[i]);
  assert.ok(Math.min(...gaps) >= 1000, `간격 ${gaps}`);
  assert.equal(h.states().filter((s) => s === 'turn').length, 0, '차례 전 직접 확인은 화면을 바꾸지 않는다');
});

test('Q-T25 다시 연 탭이 공연 요약을 처음에 못 받아도 다시 받아 직접 확인을 한다', async () => {
  let tries = 0;
  const admits = [];
  const h = harness({
    schedule: () => (++tries < 2 ? null : AUTO),
    rec: { ticket: TICKET },
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving: 985, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        admits.push(now);
        return reply(200, { status: 'NOT_YET', retryAfterMs: 5000, serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  await h.run(10_000);
  assert.ok(tries >= 2);
  assert.ok(admits.length >= 1, '일정을 늦게 받아도 직접 확인');
});

test('SCR-008 진입 410 sale-ended여도 희망 조건을 지운다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ preverifyToken: 'pv', savedAt: START }));
  w.local.setItem('peaket.autoassign.e1', JSON.stringify({ v: 1, firstTierId: 'tier-r', count: 1, wheelchair: false, allowSplit: false, savedAt: START }));
  const t = openTab(w, { handler: ({ m }) => (m === 'POST' ? reply(410, {}, { problem: 'sale-ended' }) : reply(500)) });
  await t.start();
  assert.equal(t.last().state, 'ended');
  assert.equal(w.local.getItem('peaket.autoassign.e1'), null);
});

test('Q-T25 보이지만 리더가 아닌 탭은 직접 확인을 보내지 않는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: TICKET, savedAt: START }));
  const admits = [];
  const handler = ({ m, url, now, tab }) => {
    if (m === 'GET') return reply(200, stateFile({ serving: 990, servingRate: 2, generatedAtMs: Math.floor(now / 1000) * 1000 }));
    if (m === 'POST' && url.endsWith('/admission')) {
      admits.push(tab);
      return reply(200, { status: 'NOT_YET', retryAfterMs: 3000, serverTimeMs: now });
    }
    return reply(500);
  };
  const a = openTab(w, { multi: true, schedule: AUTO, handler });
  const b = openTab(w, { multi: true, schedule: AUTO, handler });
  await a.start();
  await b.start();
  await w.run(8000);
  assert.ok(admits.length >= 1);
  assert.ok(admits.every((t) => t === a), '리더만 보낸다');
});
