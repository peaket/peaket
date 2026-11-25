// 기록 고정과 해시 사슬(docs/features/forensic-replay.md §6.7.2, FX-T14, F-04-11).
// - 판 1은 ingested_at ≤ frozen_at, 판 N은 range_from < ingested_at ≤ frozen_at인 행이다.
// - 표 해시: 표의 정렬 키 순으로 행을 늘어놓고 정규 JSON 한 줄씩 이어 붙인 UTF-8의 SHA-256.
// - 판 해시: "PEAKET-fraud-snapshot-v1" ‖ 회차 ‖ 판 ‖ 직전 판 해시 ‖ 표 해시 넷을 \n으로 이은 글의 SHA-256.
// 저장 전용 칸(ingest_rank·retain_until)은 해시에 넣지 않는다. DateTime64 칸은 읽는 쪽이 밀리초 정수로 바꾼다.
import { canonicalize, sha256Hex } from './canonical.js';

export type SnapshotTable = 'inv_request' | 'inv_step' | 'inv_behavior' | 'inv_link';
export type Row = Record<string, unknown>;

export const SNAPSHOT_DOMAIN = 'PEAKET-fraud-snapshot-v1';
export const SNAPSHOT_TABLES: readonly SnapshotTable[] = ['inv_request', 'inv_step', 'inv_behavior', 'inv_link'];

const SORT_KEYS: Record<SnapshotTable, readonly string[]> = {
  inv_request: ['event_id', 'request_id'],
  inv_step: ['event_id', 'source_key'],
  inv_behavior: ['event_id', 'event_key'],
  inv_link: ['event_id', 'kind', 'value', 'account_id', 'pid', 'journey_id'],
};

/** 해시에 넣는 칸. data/clickhouse/inv/0001_inv_tables.sql의 칸 가운데 저장 전용 ingest_rank·retain_until을 뺀다 */
export const HASH_COLUMNS: Record<SnapshotTable, readonly string[]> = {
  inv_request: [
    'event_id', 'request_id', 'ts', 'ingested_at', 'journey_id', 'gateway', 'route_kind', 'status',
    'account_id', 'pid', 'ip', 'asn', 'net_class', 'ja4', 'edge_bot_labels', 'device_ref',
  ],
  inv_step: [
    'event_id', 'source_key', 'ts', 'ingested_at', 'journey_id', 'step', 'pid', 'account_id',
    'queue_entry_id', 'purchase_session_id', 'order_id', 'ticket_id', 'seat_ids', 'held_at', 'result',
    'verify_route', 'payment_method_ref', 'card_bin', 'ref_missing',
  ],
  inv_behavior: [
    'event_id', 'event_key', 'ts', 'ingested_at', 'journey_id', 'pid', 'screen', 'device_ref',
    'ref_missing', 'net_class', 'asn', 'v', 'window_ms', 'pointer_moves', 'pointer_entropy',
    'input_interval_mean_ms', 'input_interval_std_ms', 'scroll_events', 'scroll_distance_px',
  ],
  inv_link: [
    'event_id', 'kind', 'value', 'account_id', 'pid', 'journey_id', 'source', 'first_seen_at',
    'last_seen_at', 'ingested_at',
  ],
};

export interface SnapshotRecord {
  eventId: string;
  version: number;
  /** ISO 8601(UTC) */
  frozenAt: string;
  /** 16진 소문자 SHA-256 */
  invHash: string;
  prevHash: string | null;
  tableHashes: Record<SnapshotTable, string>;
  rowCounts: Record<SnapshotTable, number>;
  /** ISO 8601(UTC). 판 1은 null */
  rangeFrom: string | null;
  late: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const assertTime = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`${name} 시각이 유한한 밀리초가 아니다`);
};

export function sortKeyOf(table: SnapshotTable, row: Row): readonly string[] {
  return SORT_KEYS[table].map((c) => {
    const v = row[c];
    if (v === undefined || v === null) throw new Error(`해시: ${table}.${c} 칸이 없다`);
    return String(v);
  });
}

/** ingested_at이 (from, to]에 드는가. 판 1은 from이 null이다 */
export function inSnapshotRange(row: Row, from: number | null, to: number): boolean {
  const at = Number(row.ingested_at);
  if (!Number.isFinite(at)) throw new Error('해시: ingested_at이 유한한 밀리초가 아니다');
  return (from === null || at > from) && at <= to;
}

export function tableHash(table: SnapshotTable, rows: readonly Row[]): string {
  const lines = rows.map((row) => {
    const picked: Record<string, unknown> = {};
    for (const c of HASH_COLUMNS[table]) picked[c] = row[c];
    return { key: sortKeyOf(table, row), line: canonicalize(picked) };
  });
  // 정렬 키가 같은 행이 둘 이상이면 정규 JSON 줄로 한 번 더 정렬해 결정적으로 만든다.
  lines.sort((a, b) => {
    const n = Math.min(a.key.length, b.key.length);
    for (let i = 0; i < n; i += 1) {
      const c = cmp(a.key[i]!, b.key[i]!);
      if (c !== 0) return c;
    }
    if (a.key.length !== b.key.length) return a.key.length - b.key.length;
    return cmp(a.line, b.line);
  });
  const payload = lines.length === 0 ? '' : `${lines.map((x) => x.line).join('\n')}\n`;
  return sha256Hex(payload);
}

export function versionHash(o: {
  eventId: string;
  version: number;
  prevHash: string | null;
  tableHashes: Record<SnapshotTable, string>;
}): string {
  if (!o.eventId) throw new Error('판 해시: 회차 ID가 필요하다');
  const parts = [
    SNAPSHOT_DOMAIN,
    o.eventId,
    String(o.version),
    o.prevHash ?? '',
    ...SNAPSHOT_TABLES.map((t) => o.tableHashes[t]),
  ];
  return sha256Hex(parts.join('\n'));
}

export function buildSnapshot(o: {
  eventId: string;
  version: number;
  frozenAt: number;
  prevHash: string | null;
  rangeFrom: number | null;
  late: boolean;
  tables: Partial<Record<SnapshotTable, readonly Row[]>>;
}): SnapshotRecord {
  if (!o.eventId) throw new Error('기록 고정: 회차 ID가 필요하다');
  if (!Number.isInteger(o.version) || o.version < 1) throw new Error(`기록 고정: 판은 1 이상 정수여야 한다(${o.version})`);
  assertTime('기록 고정', o.frozenAt);
  if (o.version === 1) {
    if (o.prevHash !== null) throw new Error('기록 고정: 판 1은 직전 판 해시가 없다');
    if (o.rangeFrom !== null) throw new Error('기록 고정: 판 1은 범위 시작(range_from)이 없다');
  } else {
    if (o.prevHash === null) throw new Error('기록 고정: 판 2부터는 직전 판 해시가 필요하다');
    if (o.rangeFrom === null) throw new Error('기록 고정: 판 2부터는 범위 시작(range_from)이 필요하다');
    assertTime('기록 고정 범위', o.rangeFrom);
  }
  const tableHashes = {} as Record<SnapshotTable, string>;
  const rowCounts = {} as Record<SnapshotTable, number>;
  for (const table of SNAPSHOT_TABLES) {
    const rows = (o.tables[table] ?? []).filter((r) => inSnapshotRange(r, o.rangeFrom, o.frozenAt));
    tableHashes[table] = tableHash(table, rows);
    rowCounts[table] = rows.length;
  }
  const invHash = versionHash({ eventId: o.eventId, version: o.version, prevHash: o.prevHash, tableHashes });
  return {
    eventId: o.eventId,
    version: o.version,
    frozenAt: iso(o.frozenAt),
    invHash,
    prevHash: o.prevHash,
    tableHashes,
    rowCounts,
    rangeFrom: o.rangeFrom === null ? null : iso(o.rangeFrom),
    late: o.late,
  };
}

export function verifySnapshot(
  snapshot: SnapshotRecord,
  tables: Partial<Record<SnapshotTable, readonly Row[]>>,
): { ok: boolean; mismatched: SnapshotTable[]; invHashMatches: boolean; recomputedInvHash: string; severity: 'SEV2' | null } {
  const from = snapshot.rangeFrom === null ? null : Date.parse(snapshot.rangeFrom);
  const to = Date.parse(snapshot.frozenAt);
  if (from !== null) assertTime('검증 범위', from);
  assertTime('검증', to);
  const mismatched: SnapshotTable[] = [];
  const recomputed = {} as Record<SnapshotTable, string>;
  for (const table of SNAPSHOT_TABLES) {
    const rows = (tables[table] ?? []).filter((r) => inSnapshotRange(r, from, to));
    recomputed[table] = tableHash(table, rows);
    if (recomputed[table] !== snapshot.tableHashes[table]) mismatched.push(table);
  }
  const recomputedInvHash = versionHash({
    eventId: snapshot.eventId,
    version: snapshot.version,
    prevHash: snapshot.prevHash,
    tableHashes: recomputed,
  });
  const invHashMatches = recomputedInvHash === snapshot.invHash;
  const ok = mismatched.length === 0 && invHashMatches;
  return { ok, mismatched, invHashMatches, recomputedInvHash, severity: ok ? null : 'SEV2' };
}

/** 온세일 끝 + 5분까지 적재가 따라오면 바로, 30분을 기다려도 못 따라오면 '늦은 적재'로 고정한다 */
export function freezeDecision(o: { windowEndsAt: number; now: number; ingestProgressAt: number }): { action: 'freeze' | 'wait'; late: boolean } {
  assertTime('온세일 끝', o.windowEndsAt);
  assertTime('지금', o.now);
  assertTime('적재 진행', o.ingestProgressAt);
  const target = o.windowEndsAt + 5 * 60_000;
  const deadline = target + 30 * 60_000;
  if (o.ingestProgressAt >= target) return { action: 'freeze', late: false };
  if (o.now >= deadline) return { action: 'freeze', late: true };
  return { action: 'wait', late: false };
}

/** 판매 종료(공연 시작 24시간 전) 뒤에는 판·후보를 더하지 않는다 */
export function canAddVersion(o: { now: number; saleEndsAt: number }): boolean {
  assertTime('지금', o.now);
  assertTime('판매 종료', o.saleEndsAt);
  return o.now < o.saleEndsAt;
}
