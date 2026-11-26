// F-04-17 교차 필터 비트마스크 정확성 시험. 정본: docs/features/forensic-replay.md §2.1·§3.5·§8 FX-T4.
// 비트마스크 집계를 전 행을 도는 기준 구현과 견준다(무작위 조건 500개, 묶음 계정 여부 차원 포함).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KIND,
  NO_SEAT,
  RESULT,
  columnsFromRows,
} from '../forensics/events.ts';

async function load() {
  try {
    return await import('./crossfilter.ts');
  } catch {
    return null;
  }
}

const crossfilter = await load();

function need(name) {
  assert.ok(crossfilter, '교차 필터(src/lib/replay/crossfilter.ts)가 없다');
  assert.equal(typeof crossfilter[name], 'function', `${name}이 없다`);
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const KINDS = [EVENT_KIND.QUEUE_ENTER, EVENT_KIND.ADMIT, EVENT_KIND.HOLD_TRY, EVENT_KIND.HOLD_END, EVENT_KIND.PAY_TRY, EVENT_KIND.SALE, EVENT_KIND.PAY_FAIL];
const RESULTS = [RESULT.NONE, RESULT.HELD, RESULT.CONFLICT, RESULT.LIMIT, RESULT.ERROR];

/** 200행, 20세션. 묶음 계정 여부·봇 등급·망·기기 묶음·구역이 섞여 있다. */
function fixture(rowCount = 200) {
  const rows = [];
  for (let i = 0; i < rowCount; i += 1) {
    const session = Math.floor(i / 10);
    const kind = KINDS[i % KINDS.length];
    const result = kind === EVENT_KIND.HOLD_TRY ? RESULTS[(i % 4) + 1] : kind === EVENT_KIND.PAY_TRY ? (i % 3 === 0 ? RESULT.FAILED : RESULT.PAID) : RESULT.NONE;
    rows.push({
      t_ms: -1000 + i * 100,
      kind,
      seat: kind === EVENT_KIND.QUEUE_ENTER || kind === EVENT_KIND.ADMIT ? NO_SEAT : i % 50,
      section: session % 5,
      session,
      result,
      bot_tier: session % 4,
      net_type: session % 5,
      device_group: session % 3,
      member: session % 3 === 0 ? 1 : 0,
      entropy: session % 3 === 0 ? 1.1 : Number.NaN,
    });
  }
  return columnsFromRows(rows);
}

function pass(columns, i, f) {
  const t = columns.t_ms[i];
  if (f.fromMs !== undefined && t < f.fromMs) return false;
  if (f.toMs !== undefined && t >= f.toMs) return false;
  if (f.sections !== undefined && !f.sections.includes(columns.section[i])) return false;
  if (f.results !== undefined && !f.results.includes(columns.result[i])) return false;
  if (f.kinds !== undefined && !f.kinds.includes(columns.kind[i])) return false;
  if (f.botTiers !== undefined && !f.botTiers.includes(columns.bot_tier[i])) return false;
  if (f.netTypes !== undefined && !f.netTypes.includes(columns.net_type[i])) return false;
  if (f.deviceGroups !== undefined && !f.deviceGroups.includes(columns.device_group[i])) return false;
  if (f.member !== undefined && columns.member[i] !== f.member) return false;
  return true;
}

/** 전 행을 도는 기준 구현. 비트마스크를 쓰지 않는다. */
function reference(columns, keep, f = {}) {
  const rows = [];
  for (let i = 0; i < columns.t_ms.length; i += 1) if (keep[i] === 1 && pass(columns, i, f)) rows.push(i);
  const sessions = new Set(rows.map((i) => columns.session[i]));
  const holdRows = rows.filter((i) => columns.kind[i] === EVENT_KIND.HOLD_TRY);
  const held = holdRows.filter((i) => columns.result[i] === RESULT.HELD).length;
  const conflicts = holdRows.filter((i) => columns.result[i] === RESULT.CONFLICT).length;
  const sales = rows.filter((i) => columns.kind[i] === EVENT_KIND.SALE).length;
  const bots = new Set(rows.filter((i) => columns.bot_tier[i] > 0).map((i) => columns.session[i]));
  const members = new Set(rows.filter((i) => columns.member[i] === 1).map((i) => columns.session[i]));
  return {
    rows: rows.length,
    sessions: sessions.size,
    holdTries: holdRows.length,
    conflictRate: holdRows.length === 0 ? 0 : conflicts / holdRows.length,
    holdToSaleRate: held === 0 ? 0 : sales / held,
    candidateRate: sessions.size === 0 ? 0 : bots.size / sessions.size,
    memberSessions: members.size,
  };
}

function constantRows(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({ t_ms: i, kind: EVENT_KIND.HOLD_TRY, seat: i % 50, section: 1, session: 1, result: RESULT.HELD });
  }
  return columnsFromRows(rows);
}

test('FX-T4 ① 31·32·33·64·65행 경계에서 비트마스크 집계가 기준 구현과 같다', () => {
  need('summarize');
  need('selectionMask');
  need('maskWords');
  for (const n of [0, 1, 31, 32, 33, 64, 65]) {
    const columns = constantRows(n);
    const keep = new Uint8Array(n).fill(1);
    assert.equal(crossfilter.maskWords(n), Math.ceil(n / 32), `${n}행 마스크 단어 수`);
    assert.equal(crossfilter.selectionMask(columns, keep).length, Math.ceil(n / 32), `${n}행 마스크 길이`);
    assert.deepEqual(crossfilter.summarize(columns, keep), reference(columns, keep), `${n}행`);
  }
  const all = constantRows(33);
  const keep = new Uint8Array(33).fill(1);
  const mask = crossfilter.selectionMask(all, keep);
  assert.equal(mask[0], 0xffffffff);
  assert.equal(mask[1], 0x00000001, '마지막 단어의 남는 비트는 0이다');

  const noKeep = crossfilter.summarize(all, new Uint8Array(33), {});
  assert.deepEqual(noKeep, { rows: 0, sessions: 0, holdTries: 0, conflictRate: 0, holdToSaleRate: 0, candidateRate: 0, memberSessions: 0 });
  assert.deepEqual([...crossfilter.selectionMask(all, new Uint8Array(33))], [0, 0]);
});

test('FX-T4 ② 무작위 조건 500개에서 요약 값이 전 행을 도는 기준 구현과 같다', () => {
  need('summarize');
  const columns = fixture();
  const keep = new Uint8Array(columns.t_ms.length).fill(1);
  const rand = lcg(20261127);
  const pick = (list) => list.filter(() => rand() < 0.5);
  const times = [...columns.t_ms];
  for (let turn = 0; turn < 500; turn += 1) {
    const f = {};
    if (rand() < 0.6) {
      f.fromMs = times[Math.floor(rand() * times.length)];
      if (rand() < 0.8) {
        const later = times.filter((t) => t > f.fromMs);
        if (later.length) f.toMs = later[Math.floor(rand() * later.length)];
      }
    } else if (rand() < 0.4) {
      f.toMs = times[Math.floor(rand() * times.length)];
    }
    if (rand() < 0.5) f.sections = pick([0, 1, 2, 3, 4]);
    if (rand() < 0.5) f.results = pick([RESULT.NONE, RESULT.HELD, RESULT.CONFLICT, RESULT.LIMIT, RESULT.ERROR, RESULT.PAID, RESULT.FAILED]);
    if (rand() < 0.5) f.kinds = pick(KINDS);
    if (rand() < 0.4) f.botTiers = pick([0, 1, 2, 3]);
    if (rand() < 0.4) f.netTypes = pick([0, 1, 2, 3, 4]);
    if (rand() < 0.4) f.deviceGroups = pick([0, 1, 2]);
    if (rand() < 0.5) f.member = rand() < 0.5 ? 0 : 1;
    assert.deepEqual(crossfilter.summarize(columns, keep, f), reference(columns, keep, f), `조건 ${turn}`);
  }
});

test('FX-T4 ③ 시간 범위는 시작 이상·끝 미만이고 빈 배열 차원은 아무것도 통과하지 않는다', () => {
  need('summarize');
  const rows = [
    { t_ms: 1000, kind: EVENT_KIND.HOLD_TRY, seat: 1, section: 1, session: 1, result: RESULT.HELD },
    { t_ms: 2000, kind: EVENT_KIND.HOLD_TRY, seat: 2, section: 2, session: 2, result: RESULT.CONFLICT },
  ];
  const columns = columnsFromRows(rows);
  const keep = new Uint8Array(2).fill(1);
  assert.equal(crossfilter.summarize(columns, keep, { fromMs: 1000, toMs: 2000 }).holdTries, 1, '시작은 들고 끝은 뺀다');
  assert.equal(crossfilter.summarize(columns, keep, { fromMs: 1000, toMs: 2000 }).rows, 1);
  assert.equal(crossfilter.summarize(columns, keep, { fromMs: 1001, toMs: 2000 }).holdTries, 0);
  assert.equal(crossfilter.summarize(columns, keep, { sections: [] }).rows, 0, '빈 배열은 아무것도 통과하지 않는다');
  assert.deepEqual(crossfilter.summarize(columns, keep, { sections: [] }), reference(columns, keep, { sections: [] }));

  const filtered = crossfilter.summarize(columns, keep, { sections: [2] });
  assert.equal(filtered.holdTries, 1);
  assert.equal(filtered.conflictRate, 1);
  assert.deepEqual(crossfilter.summarize(columns, keep, {}), reference(columns, keep, {}), '조건을 지우면 전체 집계다');
});

test('FX-T4 ④ 10%를 버린 keep에서도 요약 값이 버린 행을 뺀 기준 구현과 같다', () => {
  need('summarize');
  const columns = fixture();
  const rand = lcg(417);
  for (let turn = 0; turn < 100; turn += 1) {
    const keep = new Uint8Array(columns.t_ms.length);
    for (let i = 0; i < keep.length; i += 1) keep[i] = rand() < 0.9 ? 1 : 0;
    const f = { fromMs: -500, toMs: 15000, member: rand() < 0.5 ? 0 : undefined };
    if (f.member === undefined) delete f.member;
    assert.deepEqual(crossfilter.summarize(columns, keep, f), reference(columns, keep, f), `keep ${turn}`);
  }
});
