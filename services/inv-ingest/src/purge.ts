// 조사 저장소 보존 파기(docs/streaming.md §6.4 '보존', docs/features/forensic-replay.md §6.7.1, ADR-0173 결정 7, ST-T24, F-04-10).
// 파기 작업 inv-partition-purge는 retain_until이 지난 회차를 찾아 표 넷에서 그 회차 파티션을 DROP PARTITION으로 지운다.
// TTL은 보조라 백그라운드 병합을 기다리지 않는다. 결과는 표마다 행 수와 함께 ops_event 줄(INV_PARTITION_PURGE)로 남긴다.
// ops DB ops_purge_writer 쓰기는 F-04-11의 ops-svc 파기 작업이 이 결과를 받아 붙인다.
import { INV_TABLES, retainUntilOf, type InvTable } from './records.js';

export interface PurgeLogLine {
  kind: 'ops_event';
  opsEvent: 'INV_PARTITION_PURGE';
  eventId: string;
  table: InvTable;
  rows: number;
  result: 'DROPPED' | 'FAILED';
  at: string;
}

export interface DuePartition {
  eventId: string;
  retainUntil: string;
  counts: Partial<Record<InvTable, number>>;
}

export interface PurgeReader {
  rows<T>(sql: string, params?: Record<string, string>): Promise<T[]>;
}

export interface PurgeExec {
  exec(sql: string, params?: Record<string, string>): Promise<unknown>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const quote = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** 보존이 지난 회차와 표마다의 행 수. retain_until과 같은 시각은 아직 남긴다(그날까지 보존) */
export async function partitionsToPurge(ch: PurgeReader, now: number): Promise<DuePartition[]> {
  const due = new Map<string, DuePartition>();
  for (const table of INV_TABLES) {
    const rows = await ch.rows<{ event_id: string; rows: string | number; until: string }>(
      `SELECT event_id, count() AS rows, max(retain_until) AS until FROM ${table} GROUP BY event_id`,
    );
    for (const r of rows) {
      const until = Date.parse(String(r.until));
      if (!Number.isFinite(until) || until >= now) continue;
      const item = due.get(r.event_id) ?? { eventId: r.event_id, retainUntil: String(r.until), counts: {} };
      item.counts[table] = Number(r.rows);
      item.retainUntil = Date.parse(item.retainUntil) < until ? String(item.retainUntil) : String(r.until);
      due.set(r.event_id, item);
    }
  }
  return [...due.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
}

export interface PurgeResult {
  eventId: string;
  result: 'DROPPED' | 'FAILED';
  tables: { table: InvTable; rows: number; result: 'DROPPED' | 'FAILED' }[];
}

export async function purgeExpired(o: {
  clickhouse: PurgeReader & PurgeExec;
  now: number;
  log?: (line: PurgeLogLine) => void;
}): Promise<PurgeResult[]> {
  const due = await partitionsToPurge(o.clickhouse, o.now);
  const out: PurgeResult[] = [];
  for (const d of due) {
    const tables: PurgeResult['tables'] = [];
    for (const table of INV_TABLES) {
      const rows = d.counts[table] ?? 0;
      let result: 'DROPPED' | 'FAILED' = 'DROPPED';
      try {
        await o.clickhouse.exec(`ALTER TABLE ${table} DROP PARTITION ${quote(d.eventId)}`);
      } catch {
        result = 'FAILED';
      }
      tables.push({ table, rows, result });
      o.log?.({ kind: 'ops_event', opsEvent: 'INV_PARTITION_PURGE', eventId: d.eventId, table, rows, result, at: iso(o.now) });
    }
    out.push({ eventId: d.eventId, result: tables.every((t) => t.result === 'DROPPED') ? 'DROPPED' : 'FAILED', tables });
  }
  return out;
}

/** 공연 날짜가 바뀐 회차의 retain_until을 고친다(정비 잡). 표마다 같은 값을 쓴다 */
export function retainUntilUpdate(table: InvTable, eventId: string, performanceDate: string): string {
  const retain = retainUntilOf(performanceDate);
  if (!retain) throw new Error(`공연일 모양이 틀렸다: ${performanceDate}`);
  return `ALTER TABLE ${table} UPDATE retain_until = ${quote(retain)} WHERE event_id = ${quote(eventId)}`;
}
