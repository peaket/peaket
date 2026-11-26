// F-04-17 Arrow 표 해독·검증 연결 시험. 정본: docs/features/forensic-replay.md §4.2·§8 FX-T21,
// docs/security/asvs/forensic-replay.md(v5.0.0-1.1.1·1.4.1·1.4.2·1.5.2).
// apache-arrow 없이 표 모양(ArrowTableLike)만 만들고, 실제 IPC 바이트 읽기는 arrow-ipc.ts 소스로 고정한다(미실행).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COLUMN_SPECS,
  EVENT_KIND,
  MAX_EVENTS,
  NET_TYPE,
  NO_SEAT,
  RESULT,
  SCHEMA_NAME,
  SEAT_STATE,
  columnsFromRows,
  validateEventCount,
} from '../forensics/events.ts';
import { reconstructAt } from '../forensics/checkpoint.ts';
import { replayFileValidation } from '../replay-export.ts';

const CASE_ID = '11111111-1111-7111-8111-111111111111';
const EXPORT_ID = '22222222-2222-7222-8222-222222222222';
const TARGET_INV = { source: 'INVESTIGATION', sourceLabel: 'investigation', eventId: 'evt-lumen-1', caseId: CASE_ID, exportId: null };
const TARGET_RES = { source: 'RESEARCH', sourceLabel: 'research', eventId: 'evt-lumen-1', caseId: null, exportId: EXPORT_ID };
const TARGET_SYN = { source: 'SYNTHETIC', sourceLabel: 'synthetic', eventId: 'evt-lumen-1', caseId: null, exportId: null };
const ENVELOPE = { byteLength: 4096, head: 'ARROW1', tail: 'ARROW1' };
const ARROW_TYPES = { int32: 'Int32', uint8: 'Uint8', uint16: 'Uint16', uint32: 'Uint32', float32: 'Float32' };

/** 파일이 없을 때만 null이다. 구현 파일의 문법·초기화 오류는 그대로 드러낸다(RV0417-15). */
async function load(name) {
  try {
    return await import(name);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

const arrow = await load('./arrow.ts');
const session = await load('./session.ts');

function need(mod, name, path) {
  assert.ok(mod, `${path}가 없다`);
  assert.equal(typeof mod[name], 'function', `${path}의 ${name}이 없다`);
}

/** F-04-16의 경계를 그대로 쓴다. ReplayEnvelope를 Envelope로 바꾸는 일은 이 함수가 한다(RV0417-01). */
function validateSyn(file) {
  return replayFileValidation(file, TARGET_SYN);
}

/** apache-arrow Table이 구조적으로 만족하는 좁은 포트의 시험용 표. */
function tableOf({ rows, meta = {}, fields, numRows = rows.length, values }) {
  const calls = [];
  const columns = {};
  for (const spec of COLUMN_SPECS) {
    columns[spec.name] = values?.[spec.name] ?? rows.map((r) => (r[spec.name] === undefined ? null : r[spec.name]));
  }
  return {
    calls,
    table: {
      numRows,
      schema: {
        fields: fields ?? COLUMN_SPECS.map((c) => ({ name: c.name, type: ARROW_TYPES[c.type] })),
        metadata: new Map(Object.entries(meta)),
      },
      getChild(name) {
        calls.push(name);
        if (!(name in columns)) return null;
        const valuesOf = columns[name];
        return { length: valuesOf.length, get: (i) => valuesOf[i] };
      },
    },
  };
}

const META = {
  schema: SCHEMA_NAME,
  source: 'SYNTHETIC',
  seatCount: '1000',
  sectionCount: '4',
  saleStart: '2026-11-28T09:00:00.000Z',
  seed: 'f0417',
  generatorVersion: '2',
  windowFromMs: '-600000',
  windowToMs: '1800000',
};

function metaOf(overrides = {}) {
  return {
    schema: SCHEMA_NAME,
    source: 'SYNTHETIC',
    seatCount: 1000,
    sectionCount: 4,
    saleStart: '2026-11-28T09:00:00.000Z',
    seed: 'f0417',
    generatorVersion: 2,
    loaderRunId: undefined,
    eventId: undefined,
    caseId: undefined,
    windowFromMs: -600000,
    windowToMs: 1800000,
    snapshotVersion: undefined,
    ...overrides,
  };
}

const ROWS = [
  { t_ms: -600000, kind: EVENT_KIND.QUEUE_ENTER, seat: NO_SEAT, section: 0, session: 1 },
  { t_ms: -590000, kind: EVENT_KIND.ADMIT, seat: NO_SEAT, section: 0, session: 1 },
  { t_ms: 0, kind: EVENT_KIND.HOLD_TRY, seat: 3, section: 1, session: 1, result: RESULT.HELD },
  { t_ms: 1000, kind: EVENT_KIND.PAY_TRY, seat: 3, section: 1, session: 1 },
  { t_ms: 1500, kind: EVENT_KIND.HOLD_TRY, seat: 4, section: 1, session: 2, result: RESULT.CONFLICT },
  { t_ms: 2000, kind: EVENT_KIND.SALE, seat: 3, section: 1, session: 1 },
];

test('FX-T21 ⑥ [ASVS v5.0.0-1.1.1] Arrow 표는 스키마·메타·행 수를 먼저 보고 통과한 뒤에만 열 값을 한 번 읽는다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  const { table, calls } = tableOf({ rows: ROWS, meta: META });
  const decoded = arrow.decodeReplayTable(table, ENVELOPE);
  assert.equal(decoded.ok, true, JSON.stringify(decoded));
  assert.deepEqual(decoded.file.meta, metaOf());
  assert.deepEqual(decoded.file.envelope, ENVELOPE);
  assert.equal(decoded.file.schema.length, COLUMN_SPECS.length);
  assert.deepEqual(decoded.file.schema.map((c) => `${c.name}:${c.type}`), COLUMN_SPECS.map((c) => `${c.name}:${c.type}`));
  assert.deepEqual(decoded.file.columns.t_ms, new Int32Array(ROWS.map((r) => r.t_ms)));
  assert.deepEqual(decoded.file.columns.kind, new Uint8Array(ROWS.map((r) => r.kind)));
  assert.deepEqual(decoded.file.columns.seat, new Uint32Array(ROWS.map((r) => r.seat)));
  assert.deepEqual(decoded.file.columns.section, new Uint16Array(ROWS.map((r) => r.section)));
  assert.deepEqual(decoded.file.columns.session, new Uint32Array(ROWS.map((r) => r.session)));
  assert.deepEqual(decoded.file.columns.result, new Uint8Array([0, 0, RESULT.HELD, 0, RESULT.CONFLICT, 0]));
  assert.equal(calls.length, COLUMN_SPECS.length, '열을 한 번씩만 읽어야 한다');
  assert.deepEqual(calls, COLUMN_SPECS.map((c) => c.name));

  const unknown = tableOf({ rows: ROWS, meta: META, fields: [{ name: 't_ms', type: 'Int32' }] });
  const badSchema = arrow.decodeReplayTable(unknown.table, ENVELOPE);
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.reject.code, 'schema-columns');
  assert.equal(unknown.calls.length, 0, '스키마가 틀리면 열 값을 읽지 않는다');

  const badMeta = tableOf({ rows: ROWS, meta: { ...META, source: 'NOPE' } });
  const badMetaResult = arrow.decodeReplayTable(badMeta.table, ENVELOPE);
  assert.equal(badMetaResult.ok, false);
  assert.equal(badMetaResult.reject.code, 'meta');
  assert.equal(badMeta.calls.length, 0, '메타가 틀리면 열 값을 읽지 않는다');

  const tooMany = tableOf({ rows: [], meta: META, numRows: MAX_EVENTS + 1 });
  const tooManyResult = arrow.decodeReplayTable(tooMany.table, ENVELOPE);
  assert.equal(tooManyResult.ok, false);
  assert.equal(tooManyResult.reject.code, 'event-limit');
  assert.equal(tooMany.calls.length, 0, '행 수 상한을 넘으면 열 값을 읽지 않는다');
});

test('FX-T21 ⑥ [ASVS v5.0.0-1.5.2] 열 이름·형·순서·사전 표시가 다르면 열 값을 읽기 전에 거절한다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  const base = COLUMN_SPECS.map((c) => ({ name: c.name, type: ARROW_TYPES[c.type] }));
  const swapped = base.map((f, i) => (i === 0 ? { ...f, name: 'kind' } : i === 1 ? { ...f, name: 't_ms' } : f));
  const cases = [
    { name: '열 형', fields: base.map((f, i) => (i === 1 ? { ...f, type: 'Int32' } : f)), code: 'schema-columns' },
    { name: '열 순서', fields: swapped, code: 'schema-columns' },
    { name: '모르는 열', fields: [...base, { name: 'extra', type: 'Uint8' }], code: 'schema-columns' },
    { name: '사전 열', fields: base.map((f, i) => (i === 3 ? { ...f, dictionary: true } : f)), code: 'schema-dictionary' },
  ];
  for (const c of cases) {
    const { table, calls } = tableOf({ rows: ROWS, meta: META, fields: c.fields });
    const decoded = arrow.decodeReplayTable(table, ENVELOPE);
    assert.equal(decoded.ok, false, c.name);
    assert.equal(decoded.reject.code, c.code, c.name);
    assert.equal(calls.length, 0, `${c.name}이면 열 값을 읽지 않는다`);
  }
  assert.equal(arrow.arrowTypeName('Int32'), 'int32');
  assert.equal(arrow.arrowTypeName('Uint8'), 'uint8');
  assert.equal(arrow.arrowTypeName('Uint16'), 'uint16');
  assert.equal(arrow.arrowTypeName('Uint32'), 'uint32');
  assert.equal(arrow.arrowTypeName('Float32'), 'float32');
  assert.equal(arrow.arrowTypeName('Int64'), 'Int64');
});

test('FX-T21 ⑥ [ASVS v5.0.0-1.4.1] 해독 결과는 형식 배열 16개이고 null은 좌석 없음·NaN·0으로 채운다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  const rows = [
    { t_ms: -600000, kind: EVENT_KIND.QUEUE_ENTER, session: 9 },
    { t_ms: 0, kind: EVENT_KIND.HOLD_TRY, seat: 7, section: 2, session: 9, result: RESULT.HELD, entropy: 1.25, net_type: NET_TYPE.WIFI },
  ];
  const { table } = tableOf({ rows, meta: META });
  const decoded = arrow.decodeReplayTable(table, ENVELOPE);
  assert.equal(decoded.ok, true);
  const expected = {
    t_ms: Int32Array,
    kind: Uint8Array,
    seat: Uint32Array,
    section: Uint16Array,
    session: Uint32Array,
    result: Uint8Array,
    retry: Uint8Array,
    latency_ms: Uint16Array,
    first_hold_ms: Uint32Array,
    entropy: Float32Array,
    net_type: Uint8Array,
    asn: Uint32Array,
    device_group: Uint32Array,
    bot_tier: Uint8Array,
    member: Uint8Array,
    post_seat: Uint8Array,
  };
  assert.deepEqual(Object.keys(decoded.file.columns).sort(), Object.keys(expected).sort());
  for (const [name, Type] of Object.entries(expected)) {
    assert.ok(decoded.file.columns[name] instanceof Type, `${name}이 ${Type.name}이 아니다`);
    assert.equal(decoded.file.columns[name].length, 2, `${name} 길이`);
  }
  assert.deepEqual(decoded.file.columns.seat, new Uint32Array([NO_SEAT, 7]));
  assert.deepEqual(decoded.file.columns.section, new Uint16Array([0, 2]));
  assert.deepEqual(decoded.file.columns.result, new Uint8Array([0, RESULT.HELD]));
  assert.deepEqual(decoded.file.columns.net_type, new Uint8Array([0, NET_TYPE.WIFI]));
  assert.ok(Number.isNaN(decoded.file.columns.entropy[0]));
  assert.equal(decoded.file.columns.entropy[1], Math.fround(1.25));
  for (const name of ['retry', 'latency_ms', 'first_hold_ms', 'asn', 'device_group', 'bot_tier', 'member', 'post_seat']) {
    assert.deepEqual([...decoded.file.columns[name]], [0, 0], `${name} null은 0`);
  }
});

test('FX-T21 ⑥ [ASVS v5.0.0-1.4.2] 행 수 0과 300만 상한, Uint32 값 0xFFFFFFFF를 넘침 없이 다룬다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  need(session, 'prepareReplay', 'src/lib/replay/session.ts');
  need(session, 'replayScreenState', 'src/lib/replay/session.ts');
  assert.equal(validateEventCount(MAX_EVENTS).ok, true, 'MAX_EVENTS 정확히는 허용한다');
  assert.equal(validateEventCount(MAX_EVENTS + 1).code, 'event-limit');

  const empty = tableOf({ rows: [], meta: META });
  const zero = arrow.decodeReplayTable(empty.table, ENVELOPE);
  assert.equal(zero.ok, true);
  for (const spec of COLUMN_SPECS) assert.equal(zero.file.columns[spec.name].length, 0, spec.name);
  const zeroValidation = validateSyn(zero.file);
  assert.equal(zeroValidation.ok, true, JSON.stringify(zeroValidation));
  assert.equal(zeroValidation.rowCount, 0);
  const zeroSession = session.prepareReplay(zero.file, zeroValidation, TARGET_SYN);
  assert.equal(zeroSession.rowCount, 0);
  assert.equal(zeroSession.kept, 0);
  assert.equal(zeroSession.columns.t_ms.length, 0);
  assert.equal(session.replayScreenState({ file: true, problem: false, session: zeroSession }), 'replay', '0행도 재생 화면이다');
  assert.equal(session.replayScreenState({ file: true, problem: false, session: null }), 'receiving');
  assert.equal(session.replayScreenState({ file: false, problem: false, session: null }), 'receiving');
  assert.equal(session.replayScreenState({ file: true, problem: true, session: zeroSession }), 'problem', '거절이면 재생 화면을 그리지 않는다');

  const rows = [
    { t_ms: 0, kind: EVENT_KIND.HOLD_TRY, seat: NO_SEAT, section: 0, session: 0xffffffff, result: RESULT.HELD },
    { t_ms: 1, kind: EVENT_KIND.HOLD_END, seat: NO_SEAT, section: 0, session: 0xffffffff },
  ];
  const full = tableOf({ rows, meta: META });
  const decoded = arrow.decodeReplayTable(full.table, ENVELOPE);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.file.columns.seat, new Uint32Array([NO_SEAT, NO_SEAT]));
  assert.deepEqual(decoded.file.columns.session, new Uint32Array([0xffffffff, 0xffffffff]));
  const validated = validateSyn(decoded.file);
  assert.equal(validated.ok, true, JSON.stringify(validated));

  const short = tableOf({ rows, meta: META, values: { t_ms: [0], kind: [EVENT_KIND.HOLD_TRY] } });
  const shortResult = arrow.decodeReplayTable(short.table, ENVELOPE);
  assert.equal(shortResult.ok, false);
  assert.equal(shortResult.reject.code, 'row-count');
});

test('FX-T21 ⑥ 원천별 메타데이터가 모자라면 validateDecodedReplay가 meta로 거절한다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  const syntheticNoSeed = tableOf({ rows: ROWS, meta: { ...META, seed: undefined, generatorVersion: undefined } });
  const a = arrow.decodeReplayTable(syntheticNoSeed.table, ENVELOPE);
  assert.equal(a.ok, true, '해독은 하고');
  assert.equal(validateSyn(a.file).code, 'meta');

  const research = { ...META, source: 'RESEARCH', seed: undefined, generatorVersion: undefined, eventId: 'evt-lumen-1', windowFromMs: '0', windowToMs: '1800000' };
  const researchRows = [
    { t_ms: 0, kind: EVENT_KIND.QUEUE_ENTER, session: 3 },
    { t_ms: 10, kind: EVENT_KIND.ADMIT, session: 3 },
  ];
  const r1 = tableOf({ rows: researchRows, meta: { ...research, windowFromMs: undefined, windowToMs: undefined } });
  const r1d = arrow.decodeReplayTable(r1.table, ENVELOPE);
  assert.equal(r1d.ok, true);
  assert.equal(replayFileValidation(r1d.file, TARGET_RES).code, 'meta');
  const r2 = tableOf({ rows: researchRows, meta: { ...research, eventId: undefined } });
  const r2d = arrow.decodeReplayTable(r2.table, ENVELOPE);
  assert.equal(r2d.ok, true);
  assert.equal(replayFileValidation(r2d.file, TARGET_RES).code, 'meta');

  const investigation = {
    ...META,
    source: 'INVESTIGATION',
    seed: undefined,
    generatorVersion: undefined,
    eventId: 'evt-lumen-1',
    caseId: 'case-2610-0007',
    snapshotVersion: '2',
    windowFromMs: '-600000',
    windowToMs: '1800000',
  };
  const invRows = [
    { t_ms: -600000, kind: EVENT_KIND.QUEUE_ENTER, session: 3 },
    { t_ms: 0, kind: EVENT_KIND.HOLD_TRY, seat: 2, section: 1, session: 3, result: RESULT.HELD, member: 1, entropy: 1.2, net_type: NET_TYPE.HOSTING, asn: 64500, device_group: 4 },
  ];
  const i1 = tableOf({ rows: invRows, meta: { ...investigation, caseId: undefined } });
  const i1d = arrow.decodeReplayTable(i1.table, ENVELOPE);
  assert.equal(i1d.ok, true);
  assert.equal(replayFileValidation(i1d.file, TARGET_INV).code, 'meta');
  const i2 = tableOf({ rows: invRows, meta: { ...investigation, snapshotVersion: undefined } });
  const i2d = arrow.decodeReplayTable(i2.table, ENVELOPE);
  assert.equal(i2d.ok, true);
  assert.equal(replayFileValidation(i2d.file, TARGET_INV).code, 'meta');
});

test('FX-T21 ⑥ 원천이 다르거나 원천별 칸 규칙을 어기면 파일 거절이다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  const synthetic = tableOf({ rows: ROWS, meta: META });
  const syn = arrow.decodeReplayTable(synthetic.table, ENVELOPE);
  assert.equal(syn.ok, true);
  assert.equal(replayFileValidation(syn.file, TARGET_INV).code, 'source-mismatch');
  assert.equal(replayFileValidation(syn.file, TARGET_RES).code, 'source-mismatch');

  const researchMeta = { ...META, source: 'RESEARCH', seed: undefined, generatorVersion: undefined, eventId: 'evt-lumen-1', windowFromMs: '0', windowToMs: '1800000' };
  const researchRows = [{ t_ms: 0, kind: EVENT_KIND.QUEUE_ENTER, session: 3, entropy: 1.5 }];
  const research = tableOf({ rows: researchRows, meta: researchMeta });
  const res = arrow.decodeReplayTable(research.table, ENVELOPE);
  assert.equal(res.ok, true);
  assert.equal(replayFileValidation(res.file, TARGET_RES).code, 'source-rule');
  assert.equal(replayFileValidation(res.file, TARGET_INV).code, 'source-mismatch');

  const memberMeta = { ...META, source: 'SYNTHETIC' };
  const memberRows = [{ t_ms: 0, kind: EVENT_KIND.QUEUE_ENTER, session: 3, member: 1 }];
  const member = tableOf({ rows: memberRows, meta: memberMeta });
  const mem = arrow.decodeReplayTable(member.table, ENVELOPE);
  assert.equal(mem.ok, true);
  assert.equal(validateSyn(mem.file).code, 'source-rule');

  const invMeta = { ...META, source: 'INVESTIGATION', seed: undefined, generatorVersion: undefined, eventId: 'evt-lumen-1', caseId: 'case-1', snapshotVersion: '1', windowFromMs: '-600000', windowToMs: '1800000' };
  const invRows = [{ t_ms: 0, kind: EVENT_KIND.QUEUE_ENTER, session: 3, bot_tier: 2 }];
  const inv = tableOf({ rows: invRows, meta: invMeta });
  const invd = arrow.decodeReplayTable(inv.table, ENVELOPE);
  assert.equal(invd.ok, true);
  assert.equal(replayFileValidation(invd.file, TARGET_INV).code, 'source-rule');
});

test('FX-T21 ⑦ 일관성 규칙에서 버린 사건은 압축 열에서 빠지고 버린 수를 띠 문구로 알린다', () => {
  need(arrow, 'decodeReplayTable', 'src/lib/replay/arrow.ts');
  need(session, 'prepareReplay', 'src/lib/replay/session.ts');
  const rows = [
    { t_ms: -600000, kind: EVENT_KIND.QUEUE_ENTER, session: 1 },
    { t_ms: -590000, kind: EVENT_KIND.ADMIT, session: 1 },
    { t_ms: 0, kind: EVENT_KIND.HOLD_TRY, seat: 1, section: 1, session: 1, result: RESULT.HELD },
    { t_ms: 1000, kind: EVENT_KIND.SALE, seat: 1, section: 1, session: 1 },
    { t_ms: 2000, kind: EVENT_KIND.HOLD_TRY, seat: 2, section: 1, session: 2, result: RESULT.HELD },
  ];
  const { table } = tableOf({ rows, meta: META });
  const decoded = arrow.decodeReplayTable(table, ENVELOPE);
  assert.equal(decoded.ok, true);
  const validation = validateSyn(decoded.file);
  assert.equal(validation.ok, true);
  assert.equal(validation.rowCount, 5);
  assert.equal(validation.kept, 4);
  assert.equal(validation.dropped, 1);
  assert.deepEqual(validation.droppedBy, [{ code: 'SALE_WITHOUT_PAY', count: 1 }]);

  const prepared = session.prepareReplay(decoded.file, validation, TARGET_INV);
  assert.equal(prepared.rowCount, 5);
  assert.equal(prepared.kept, 4);
  assert.equal(prepared.dropped, 1);
  assert.deepEqual(prepared.columns.t_ms, new Int32Array([-600000, -590000, 0, 2000]));
  assert.deepEqual(prepared.bounds, { fromMs: -600000, toMs: 1800000 });
  assert.equal(prepared.checkpoints.seatCount, 1000);
  const state = reconstructAt(prepared.checkpoints, prepared.columns, 2500);
  assert.equal(state[1], SEAT_STATE.HELD, '버린 판매는 좌석 상태에 반영되지 않는다');
  assert.equal(state[2], SEAT_STATE.HELD);
  assert.equal(state[3], SEAT_STATE.EMPTY);
  assert.equal(session.droppedNotice(1), '규칙에 맞지 않는 사건 1건을 빼고 보입니다');
  assert.equal(session.droppedNotice(12), '규칙에 맞지 않는 사건 12건을 빼고 보입니다');
  assert.equal(session.droppedNotice(0), '');
});

test('FX-T21 ⑥ Arrow IPC 읽기는 apache-arrow의 tableFromIPC 한 번으로 하고 실패를 arrow-ipc로 끝낸다', () => {
  const ipcPath = resolve(process.cwd(), 'src/lib/replay/arrow-ipc.ts');
  const arrowPath = resolve(process.cwd(), 'src/lib/replay/arrow.ts');
  assert.ok(existsSync(ipcPath), 'Arrow IPC 읽기(src/lib/replay/arrow-ipc.ts)가 없다');
  assert.ok(existsSync(arrowPath), 'Arrow 표 해독(src/lib/replay/arrow.ts)이 없다');
  const ipc = readFileSync(ipcPath, 'utf8');
  const pure = readFileSync(arrowPath, 'utf8');
  assert.match(ipc, /from\s+['"]apache-arrow['"]/, 'apache-arrow를 가져오지 않는다');
  assert.equal((ipc.match(/tableFromIPC\(/g) ?? []).length, 1, 'tableFromIPC를 정확히 한 번 부른다');
  assert.equal((ipc.match(/decodeReplayTable\(/g) ?? []).length, 1, 'decodeReplayTable에 표를 넘긴다');
  assert.match(ipc, /catch\s*\(/, '해독 실패를 잡지 않는다');
  assert.match(ipc, /arrow-ipc/, '실패를 arrow-ipc로 끝내지 않는다');
  assert.doesNotMatch(ipc, /compressed\s*:/, '실제 Field에 없는 압축 표시를 옮기지 않는다');
  assert.doesNotMatch(pure, /compressed\s*:/, '가짜 압축 표시를 만들지 않는다');
  assert.doesNotMatch(pure, /from\s+['"]apache-arrow['"]/, '순수 해독 모듈이 apache-arrow를 가져온다');
});
