// 통계 스냅샷(openspec 변경 add-maintenance-control-and-consumers 결정 12, ADR-0086 결정 7, docs/data.md §5).
// 정비 잡이 매일 pg_stat_user_tables·pg_stat_user_indexes를 서비스 DB의 stat_snapshot 표에 한 행씩 남긴다
// (큰 표 순차 스캔, idx_scan = 0인 인덱스, 죽은 행 수, HOT 비율을 날짜별로 견준다). 표·인덱스 이름과 수만 든다(개인정보 없음).
import { sql } from 'drizzle-orm';
import { bigint, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import { kstDayStart } from './outbox.js';

export const STAT_SNAPSHOT_TABLE = 'stat_snapshot';
/** 지난 스냅샷 보관(90일 [가정]) */
export const STAT_SNAPSHOT_KEEP_DAYS = 90;

/** 표 정의(서비스 마이그레이션 0003과 같다) */
export function statSnapshotTable() {
  return pgTable(
    STAT_SNAPSHOT_TABLE,
    {
      takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
      kind: text('kind').notNull(),
      relname: text('relname').notNull(),
      indexrelname: text('indexrelname').notNull().default(''),
      seqScan: bigint('seq_scan', { mode: 'number' }),
      seqTupRead: bigint('seq_tup_read', { mode: 'number' }),
      idxScan: bigint('idx_scan', { mode: 'number' }),
      nLiveTup: bigint('n_live_tup', { mode: 'number' }),
      nDeadTup: bigint('n_dead_tup', { mode: 'number' }),
      nTupUpd: bigint('n_tup_upd', { mode: 'number' }),
      nTupHotUpd: bigint('n_tup_hot_upd', { mode: 'number' }),
      totalBytes: bigint('total_bytes', { mode: 'number' }),
    },
    (t) => [primaryKey({ name: 'stat_snapshot_pkey', columns: [t.takenAt, t.kind, t.relname, t.indexrelname] })],
  );
}

/** 오늘(KST) 스냅샷이 없으면 남기고, 지난 것을 지운다. 리더가 바뀌어 다시 불러도 하루 한 벌이다 */
export async function takeStatSnapshot(database: Database, clock: Clock, o: { keepDays?: number } = {}): Promise<{ taken: boolean; rows: number; deleted: number }> {
  const now = clock.now();
  const at = new Date(now).toISOString();
  const today = new Date(kstDayStart(now)).toISOString();
  const keep = new Date(kstDayStart(now) - (o.keepDays ?? STAT_SNAPSHOT_KEEP_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  return database.transaction(async (tx) => {
    const t = sql.identifier(STAT_SNAPSHOT_TABLE);
    const deleted = (await tx.execute(sql`delete from ${t} where taken_at < ${keep}::timestamptz`)).rowCount ?? 0;
    const has = await tx.execute(sql`select 1 from ${t} where taken_at >= ${today}::timestamptz limit 1`);
    if (has.rows.length > 0) return { taken: false, rows: 0, deleted };
    const tables = await tx.execute(sql`
      insert into ${t} (taken_at, kind, relname, indexrelname, seq_scan, seq_tup_read, idx_scan, n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd, total_bytes)
      select ${at}::timestamptz, 'table', relname, '', seq_scan, seq_tup_read, idx_scan, n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd, pg_total_relation_size(relid)
      from pg_stat_user_tables where schemaname = current_schema()`);
    const indexes = await tx.execute(sql`
      insert into ${t} (taken_at, kind, relname, indexrelname, idx_scan, total_bytes)
      select ${at}::timestamptz, 'index', relname, indexrelname, idx_scan, pg_relation_size(indexrelid)
      from pg_stat_user_indexes where schemaname = current_schema()`);
    return { taken: true, rows: (tables.rowCount ?? 0) + (indexes.rowCount ?? 0), deleted };
  });
}
