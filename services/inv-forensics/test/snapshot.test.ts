// FX-T14 기록 고정·해시 사슬. 동결 로컬 F-04-11.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import {
  canAddVersion,
  buildSnapshot,
  freezeDecision,
  HASH_COLUMNS,
  inSnapshotRange,
  sortKeyOf,
  tableHash,
  verifySnapshot,
  versionHash,
  type SnapshotTable,
} from '../src/snapshot.js';

const MIN = 60_000;
const req = (o: Record<string, unknown> = {}) => ({
  event_id: 'e1',
  request_id: 'r1',
  ts: 1_000,
  ingested_at: 1_000,
  journey_id: '',
  gateway: 'GW_QUEUE',
  route_kind: 'QUEUE_ENTER',
  status: 200,
  account_id: 'a1',
  pid: 'p1',
  ip: '::ffff:203.0.113.7',
  asn: 0,
  net_class: 'OTHER',
  ja4: '',
  edge_bot_labels: [],
  device_ref: '',
  ...o,
});
const step = (o: Record<string, unknown> = {}) => ({
  event_id: 'e1',
  source_key: 's1',
  ts: 1_000,
  ingested_at: 1_000,
  journey_id: 'j1',
  step: 'ADMIT',
  pid: 'p1',
  account_id: 'a1',
  queue_entry_id: '',
  purchase_session_id: '',
  order_id: '',
  ticket_id: '',
  seat_ids: [],
  held_at: '',
  result: '',
  verify_route: '',
  payment_method_ref: '',
  card_bin: '',
  ref_missing: 0,
  ...o,
});

const emptyTables = () => ({ inv_request: [], inv_step: [], inv_behavior: [], inv_link: [] });

describe('표 해시', () => {
  test('FX-T14 ② 정렬 키 순으로 같고 입력 행 순서를 섞어도 같다', () => {
    const a = req({ request_id: 'r-2' });
    const b = req({ request_id: 'r-1' });
    const c = req({ request_id: 'r-3' });
    const h1 = tableHash('inv_request', [a, b, c]);
    const h2 = tableHash('inv_request', [c, a, b]);
    expect(h2).toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // 표마다 정렬 키가 다르다. inv_step은 source_key 순이다
    expect(sortKeyOf('inv_step', step({ source_key: 's-1' }))).toEqual(['e1', 's-1']);
    expect(tableHash('inv_step', [step({ source_key: 's-2' }), step({ source_key: 's-1' })])).toBe(
      tableHash('inv_step', [step({ source_key: 's-1' }), step({ source_key: 's-2' })]),
    );
  });

  test('FX-T14 ② 한 칸이 바뀌면 표 해시가 바뀌고 저장 전용 칸은 넣지 않는다', () => {
    const base = tableHash('inv_step', [step()]);
    expect(tableHash('inv_step', [step({ result: 'HELD' })])).not.toBe(base);
    expect(tableHash('inv_step', [step({ ingested_at: 2_000 })])).not.toBe(base);
    // ingest_rank·retain_until은 해시 칸이 아니다
    expect(tableHash('inv_step', [step({ ingest_rank: '1', retain_until: 9_999 })])).toBe(base);
  });

  test('FX-T14 ② 표 해시는 행 한 줄씩 정규 JSON을 이어 붙인 UTF-8의 SHA-256이다', () => {
    const rows = [step({ source_key: 's-1', result: 'HELD' }), step({ source_key: 's-2', result: 'LIMIT' })];
    const columns = HASH_COLUMNS.inv_step;
    const payload =
      rows.map((r) => canonicalize(Object.fromEntries(columns.map((c) => [c, (r as Record<string, unknown>)[c]])))).join('\n') + '\n';
    const expected = createHash('sha256').update(payload, 'utf8').digest('hex');
    expect(tableHash('inv_step', rows)).toBe(expected);
    expect(tableHash('inv_step', [...rows].reverse())).toBe(expected);
  });
});

describe('판 해시 사슬', () => {
  const hashes = (n: string) => ({ inv_request: n.repeat(64), inv_step: n.repeat(64), inv_behavior: n.repeat(64), inv_link: n.repeat(64) });

  test('FX-T14 ③ 직전 판 해시를 이어 사슬을 만들고 한 글자만 달라도 값이 달라진다', () => {
    const h1 = versionHash({ eventId: 'e1', version: 1, prevHash: null, tableHashes: hashes('a') });
    const h1b = versionHash({ eventId: 'e1', version: 1, prevHash: null, tableHashes: hashes('a') });
    const h2 = versionHash({ eventId: 'e1', version: 2, prevHash: h1, tableHashes: hashes('b') });
    const h2b = versionHash({ eventId: 'e1', version: 2, prevHash: h1, tableHashes: hashes('b') });
    const h2c = versionHash({ eventId: 'e1', version: 2, prevHash: h1b, tableHashes: hashes('c') });
    expect(h1b).toBe(h1);
    expect(h2b).toBe(h2);
    expect(h2c).not.toBe(h2);
    const expected = createHash('sha256')
      .update(['PEAKET-fraud-snapshot-v1', 'e1', '2', h1, 'b'.repeat(64), 'b'.repeat(64), 'b'.repeat(64), 'b'.repeat(64)].join('\n'), 'utf8')
      .digest('hex');
    expect(h2).toBe(expected);
  });

  test('FX-T14 ③ 판 1은 직전 해시가 없고 판 2부터는 있어야 한다', () => {
    expect(() => buildSnapshot({ eventId: 'e1', version: 2, frozenAt: 10, prevHash: null, rangeFrom: null, late: false, tables: emptyTables() })).toThrow(/직전/);
    expect(() => buildSnapshot({ eventId: 'e1', version: 1, frozenAt: 10, prevHash: 'a'.repeat(64), rangeFrom: null, late: false, tables: emptyTables() })).toThrow(/판 1/);
    expect(() => buildSnapshot({ eventId: 'e1', version: 0, frozenAt: 10, prevHash: null, rangeFrom: null, late: false, tables: emptyTables() })).toThrow(/판/);
  });
});

describe('기록 고정', () => {
  test('FX-T14 ④ 같은 판을 다시 계산하면 같고 한 행을 바꾸면 불일치를 낸다', () => {
    const rows = [req(), req({ request_id: 'r2', account_id: 'a2' })];
    const tables = { ...emptyTables(), inv_request: rows };
    const s1 = buildSnapshot({ eventId: 'e1', version: 1, frozenAt: 10_000, prevHash: null, rangeFrom: null, late: false, tables });
    const s1b = buildSnapshot({ eventId: 'e1', version: 1, frozenAt: 10_000, prevHash: null, rangeFrom: null, late: false, tables });
    expect(s1b).toEqual(s1);
    expect(s1.rowCounts.inv_request).toBe(2);
    expect(s1.tableHashes.inv_request).toBe(tableHash('inv_request', rows));

    const ok = verifySnapshot(s1, tables);
    expect(ok).toMatchObject({ ok: true, mismatched: [], invHashMatches: true, severity: null });

    const tampered = { ...emptyTables(), inv_request: [req({ status: 201 }), rows[1]!] };
    const bad = verifySnapshot(s1, tampered);
    expect(bad.ok).toBe(false);
    expect(bad.mismatched).toEqual(['inv_request']);
    expect(bad.severity).toBe('SEV2');
  });

  test('FX-T14 ④ 표 해시가 모두 같아도 판 해시가 다르면 불일치다', () => {
    const tables = { ...emptyTables(), inv_step: [step()] };
    const s1 = buildSnapshot({ eventId: 'e1', version: 1, frozenAt: 10_000, prevHash: null, rangeFrom: null, late: false, tables });
    const forged = { ...s1, invHash: 'f'.repeat(64) };
    const out = verifySnapshot(forged, tables);
    expect(out.ok).toBe(false);
    expect(out.mismatched).toEqual([]);
    expect(out.invHashMatches).toBe(false);
    expect(out.severity).toBe('SEV2');
  });
});

describe('고정 대기와 판매 종료', () => {
  // 온세일 끝 T+60분, 목표 T+65분, 기한 T+95분
  const END = 60 * MIN;
  test('FX-T14 ⑤ 적재 진행·기한 경계에서 고정과 늦은 적재를 가른다', () => {
    expect(freezeDecision({ windowEndsAt: END, now: END, ingestProgressAt: 65 * MIN - 1 })).toEqual({ action: 'wait', late: false });
    expect(freezeDecision({ windowEndsAt: END, now: 65 * MIN - 1, ingestProgressAt: 64 * MIN })).toEqual({ action: 'wait', late: false });
    expect(freezeDecision({ windowEndsAt: END, now: 65 * MIN, ingestProgressAt: 65 * MIN })).toEqual({ action: 'freeze', late: false });
    expect(freezeDecision({ windowEndsAt: END, now: 70 * MIN, ingestProgressAt: 65 * MIN })).toEqual({ action: 'freeze', late: false });
    expect(freezeDecision({ windowEndsAt: END, now: 95 * MIN - 1, ingestProgressAt: 65 * MIN - 1 })).toEqual({ action: 'wait', late: false });
    expect(freezeDecision({ windowEndsAt: END, now: 95 * MIN, ingestProgressAt: 65 * MIN - 1 })).toEqual({ action: 'freeze', late: true });
    expect(freezeDecision({ windowEndsAt: END, now: 95 * MIN, ingestProgressAt: 65 * MIN })).toEqual({ action: 'freeze', late: false });
    expect(freezeDecision({ windowEndsAt: END, now: 300 * MIN, ingestProgressAt: 65 * MIN - 1 })).toEqual({ action: 'freeze', late: true });
  });

  test('FX-T14 ⑥ 판 범위는 ingested_at으로 가르고 경계를 포함한다', () => {
    expect(inSnapshotRange({ ingested_at: 100 }, null, 300)).toBe(true);
    expect(inSnapshotRange({ ingested_at: 100 }, 100, 300)).toBe(false);
    expect(inSnapshotRange({ ingested_at: 200 }, 100, 300)).toBe(true);
    expect(inSnapshotRange({ ingested_at: 300 }, 100, 300)).toBe(true);
    expect(inSnapshotRange({ ingested_at: 301 }, 100, 300)).toBe(false);

    const tables = {
      ...emptyTables(),
      inv_step: [step({ source_key: 's1', ingested_at: 100 }), step({ source_key: 's2', ingested_at: 200 }), step({ source_key: 's3', ingested_at: 300 })],
    };
    const v1 = buildSnapshot({ eventId: 'e1', version: 1, frozenAt: 300, prevHash: null, rangeFrom: null, late: false, tables });
    expect(v1.rowCounts.inv_step).toBe(3);
    const v2 = buildSnapshot({ eventId: 'e1', version: 2, frozenAt: 400, prevHash: v1.invHash, rangeFrom: 300, late: false, tables });
    expect(v2.rowCounts.inv_step).toBe(0);
    const v2b = buildSnapshot({ eventId: 'e1', version: 2, frozenAt: 400, prevHash: v1.invHash, rangeFrom: 200, late: false, tables });
    expect(v2b.rowCounts.inv_step).toBe(1);
  });

  test('FX-T14 ⑥ 판매 종료 뒤에는 판·후보를 더하지 않는다', () => {
    expect(canAddVersion({ now: 99, saleEndsAt: 100 })).toBe(true);
    expect(canAddVersion({ now: 100, saleEndsAt: 100 })).toBe(false);
    expect(canAddVersion({ now: 101, saleEndsAt: 100 })).toBe(false);
    expect(() => freezeDecision({ windowEndsAt: Number.NaN, now: 0, ingestProgressAt: 0 })).toThrow(/시각/);
    expect(() => canAddVersion({ now: 0, saleEndsAt: Number.POSITIVE_INFINITY })).toThrow(/시각/);
  });
});

describe('해시 칸', () => {
  test('FX-T14 ② 표마다 해시 칸이 있고 저장 전용 칸은 없다', () => {
    const tables: SnapshotTable[] = ['inv_request', 'inv_step', 'inv_behavior', 'inv_link'];
    for (const t of tables) {
      const h = tableHash(t, []);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(tableHash('inv_step', [step({ ingest_rank: 'x' })])).toBe(tableHash('inv_step', [step({ ingest_rank: 'y' })]));
  });
});
