// 보존 기한 나눠 지우기와 부푼 인덱스 다시 만들기(openspec 변경 add-maintenance-control-and-consumers 결정 13·14, ADR-0114 결정 3, docs/data.md §2).
// - 주문·결제·티켓처럼 나누지 않는 표: 기한 경계(UUIDv7 아래 경계)보다 작은 ID를 ID 순으로 1만 건 [가정]씩, 한 트랜잭션에서 자식 → 부모
// - 묶음 사이 0.5초 [가정], 묶음마다 지키는 선(읽기 복제본 지연 1초 [가정]·CPU)과 정비 시간 끝을 보고 멈춘다(그날 밤은 멈추고 다음에 이어 한다)
// - 외래 키에는 연쇄 삭제를 걸지 않는다(무엇을 지우는지 여기서 적는다)
import { sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import { inMaintenanceWindow } from './outbox.js';
import { uuidLowerBound, uuidv7Time } from './uuid.js';

export const RETENTION_DEFAULTS = {
  batchSize: 10_000,
  pauseMs: 500,
  /** 기한 뒤 이만큼 넘게 못 지우면 SEV2(kind legal) [가정] */
  legalGraceMs: 5 * 24 * 60 * 60 * 1000,
} as const;

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RetentionSpec {
  /** 부모 표. 기본 키는 UUIDv7 `id`다 */
  table: string;
  /** 자식 표와 부모를 가리키는 칸(지우는 순서대로) */
  children?: { table: string; column: string }[];
  /** 만든 뒤 이만큼 지나면 지운다(예: 전자상거래법 5년) */
  retentionMs: number;
}

export interface RetentionResult {
  deleted: number;
  batches: number;
  /** done: 기한이 지난 행이 없다. guard: 지키는 선이 멈춤. window: 정비 시간이 끝남 */
  stopped: 'done' | 'guard' | 'window';
  reason?: string;
}

const arr = (ids: string[]) => `{${ids.join(',')}}`;

function check(spec: RetentionSpec): void {
  for (const n of [spec.table, ...(spec.children ?? []).flatMap((c) => [c.table, c.column])]) if (!NAME.test(n)) throw new Error(`표·칸 이름이 아니다: ${n}`);
  if (!(spec.retentionMs > 0)) throw new Error('보존 기간이 비었다');
}

/** 기한 경계: 지금 − 보존 기간의 UUID 아래 경계(이보다 작은 ID가 지울 행) */
export const retentionBoundary = (clock: Clock, spec: RetentionSpec): string => uuidLowerBound(clock.now() - spec.retentionMs);

export async function deleteExpiredRows(
  database: Database,
  clock: Clock,
  spec: RetentionSpec,
  o: {
    batchSize?: number;
    pauseMs?: number;
    /** 묶음 전마다 부른다. 멈출 까닭(예: '읽기 복제본 지연 1.4초')을 돌려주면 그날 밤은 멈춘다 */
    guard?: () => Promise<string | undefined>;
    /** 정비 시간 밖에서도 돈다(시험·손으로 돌릴 때) */
    ignoreWindow?: boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<RetentionResult> {
  check(spec);
  const batchSize = o.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const pause = o.pauseMs ?? RETENTION_DEFAULTS.pauseMs;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const boundary = retentionBoundary(clock, spec);
  const result: RetentionResult = { deleted: 0, batches: 0, stopped: 'done' };
  for (;;) {
    if (!o.ignoreWindow && !inMaintenanceWindow(clock.now())) return { ...result, stopped: 'window' };
    const reason = await o.guard?.();
    if (reason) return { ...result, stopped: 'guard', reason };
    const n = await database.transaction(async (tx) => {
      const ids = ((await tx.execute(sql`select id::text as id from ${sql.identifier(spec.table)} where id < ${boundary}::uuid order by id limit ${batchSize} for update`)).rows as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) return 0;
      for (const c of spec.children ?? []) await tx.execute(sql`delete from ${sql.identifier(c.table)} where ${sql.identifier(c.column)} = any(${arr(ids)}::uuid[])`);
      await tx.execute(sql`delete from ${sql.identifier(spec.table)} where id = any(${arr(ids)}::uuid[])`);
      return ids.length;
    });
    if (n === 0) return result;
    result.deleted += n;
    result.batches += 1;
    if (n < batchSize) return result;
    await sleep(pause);
  }
}

/** 남은 가장 오래된 지울 행이 기한을 넘긴 시간(초). 없으면 0(maintenance_retention_overdue_seconds) */
export async function retentionOverdueSeconds(database: Database, clock: Clock, spec: RetentionSpec): Promise<number> {
  check(spec);
  const rows = (await database.db.execute(sql`select id::text as id from ${sql.identifier(spec.table)} where id < ${retentionBoundary(clock, spec)}::uuid order by id limit 1`)).rows as { id: string }[];
  if (!rows[0]) return 0;
  return Math.max(0, clock.now() - (uuidv7Time(rows[0].id) + spec.retentionMs)) / 1000;
}

export const REINDEX_DEFAULTS = {
  /** 채움 비율 90%로 다시 만든 크기보다 30% [가정] 넘게 크면 다시 만든다 */
  bloat: 0.3,
  /** 이보다 작은 인덱스는 보지 않는다 [가정] */
  minBytes: 8 * 1024 * 1024,
  /** B-tree 기본 채움 비율(%) */
  fillfactor: 90,
} as const;

export interface ReindexResult {
  reindexed: string[];
  checked: number;
  /** pgstattuple 확장이 없으면 하지 않는다(설치는 BAS-060) */
  skipped?: 'pgstattuple-missing';
}

/**
 * 표들의 B-tree 인덱스 가운데 부푼 것을 REINDEX INDEX CONCURRENTLY한다(트랜잭션 밖, 직접 연결).
 * 부푼 정도 = 채움 비율 / 잎 밀도 − 1(pgstatindex의 avg_leaf_density)
 */
export async function reindexBloatedIndexes(database: Database, o: { tables: string[]; bloat?: number; minBytes?: number }): Promise<ReindexResult> {
  for (const t of o.tables) if (!NAME.test(t)) throw new Error(`표 이름이 아니다: ${t}`);
  const ext = await database.db.execute(sql`select 1 from pg_extension where extname = 'pgstattuple'`);
  if (ext.rows.length === 0) return { reindexed: [], checked: 0, skipped: 'pgstattuple-missing' };
  const bloat = o.bloat ?? REINDEX_DEFAULTS.bloat;
  const minBytes = o.minBytes ?? REINDEX_DEFAULTS.minBytes;
  const candidates = (
    await database.db.execute(sql`
      select ic.relname as name, pg_relation_size(i.indexrelid) as bytes
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class tc on tc.oid = i.indrelid
      join pg_am am on am.oid = ic.relam
      where am.amname = 'btree' and ic.relkind = 'i' and i.indisvalid
        and tc.relname = any(${`{${o.tables.join(',')}}`}::text[])
        and tc.relnamespace = (select oid from pg_namespace where nspname = current_schema())`)
  ).rows as { name: string; bytes: string }[];
  const reindexed: string[] = [];
  let checked = 0;
  for (const c of candidates) {
    if (Number(c.bytes) < minBytes) continue;
    checked += 1;
    const stat = (await database.db.execute(sql`select avg_leaf_density as d from pgstatindex(${c.name}::regclass)`)).rows[0] as { d: number } | undefined;
    const density = Number(stat?.d);
    if (!(density > 0) || REINDEX_DEFAULTS.fillfactor / density - 1 <= bloat) continue;
    const client = await database.pool.connect();
    try {
      await client.query(`reindex index concurrently "${c.name}"`);
      reindexed.push(c.name);
    } finally {
      client.release();
    }
  }
  return { reindexed, checked };
}
