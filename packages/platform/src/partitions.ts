// 월 범위 파티션 정비(openspec 변경 add-maintenance-control-and-consumers 결정 11, ADR-0086 결정 4 ②·③, docs/data.md §2 '파티션 표 규칙').
// - 회차 ID(UUIDv7) 범위(scan_event·seat_hold·scanner_change)와 발송 시각 범위(notification_delivery)로 한국 시각 한 달씩 나눈다
// - 이번 달부터 3개월 [가정] 앞까지 없는 파티션을 만든다(첫 파티션 포함). 하나라도 만들면 부모 표를 ANALYZE한다
// - 지우기는 정비 시간에만, 표마다 넘긴 조건이 '지워도 됨'이라 답한 파티션만(Outbox의 dropExpiredOutboxPartitions와 같은 길)
// 정비는 PgBouncer를 거치지 않는 직접 연결로 한다(DETACH … CONCURRENTLY는 트랜잭션 밖이다)
import { sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import { inMaintenanceWindow, type DropResult } from './outbox.js';
import { uuidLowerBound } from './uuid.js';

export const MONTHLY_PARTITION_DEFAULTS = { monthsAhead: 3, minAheadMonths: 2 } as const;

const HOUR = 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * HOUR;
const LOCK_TIMEOUT = '2s';
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,40}$/;

export interface MonthlyPartitionSpec {
  /** 부모 표(소문자·밑줄) */
  table: string;
  /** 나누는 열의 종류: UUIDv7 ID(회차 ID 등) 또는 timestamptz(발송 시각) */
  key: 'uuidv7' | 'timestamptz';
  monthsAhead?: number;
}

export interface MonthlyPartition {
  name: string;
  /** 그달 1일 0시(KST, 유닉스 밀리초) */
  month: number;
  from: string;
  to: string;
}

/** 그 시각이 든 한국 시각 달의 1일 0시 */
export function kstMonthStart(ms: number): number {
  const d = new Date(ms + KST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - KST_OFFSET_MS;
}

export function addKstMonths(monthStart: number, n: number): number {
  const d = new Date(monthStart + KST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) - KST_OFFSET_MS;
}

const ym = (monthStart: number): string => new Date(monthStart + KST_OFFSET_MS).toISOString().slice(0, 7).replace('-', '');
const kstIsoMonth = (monthStart: number): string => `${new Date(monthStart + KST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;

function checkTable(table: string): void {
  if (!TABLE_NAME.test(table)) throw new Error(`파티션 표 이름은 소문자·숫자·밑줄이다: ${table}`);
}

export function monthlyPartitionOf(spec: MonthlyPartitionSpec, monthStart: number): MonthlyPartition {
  checkTable(spec.table);
  if (kstMonthStart(monthStart) !== monthStart) throw new Error(`한국 시각 1일 0시가 아니다: ${new Date(monthStart).toISOString()}`);
  const next = addKstMonths(monthStart, 1);
  const bound = spec.key === 'uuidv7' ? uuidLowerBound : kstIsoMonth;
  return { name: `${spec.table}_p${ym(monthStart)}`, month: monthStart, from: bound(monthStart), to: bound(next) };
}

interface PartitionTable {
  name: string;
  month: number;
  attached: boolean;
  detachPending: boolean;
}

async function partitionTables(database: Database, table: string): Promise<PartitionTable[]> {
  checkTable(table);
  const rows = (
    await database.db.execute(sql`
      select c.relname as name, i.inhrelid is not null as attached, coalesce(i.inhdetachpending, false) as pending
      from pg_class c
      left join pg_inherits i on i.inhrelid = c.oid and i.inhparent = ${table}::regclass
      where c.relkind = 'r' and c.relname ~ ${`^${table}_p[0-9]{6}$`}
        and c.relnamespace = (select relnamespace from pg_class where oid = ${table}::regclass)`)
  ).rows as { name: string; attached: boolean; pending: boolean }[];
  return rows
    .map((r) => {
      const m = /_p(\d{4})(\d{2})$/.exec(r.name)!;
      return { name: r.name, month: Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - KST_OFFSET_MS, attached: r.attached, detachPending: r.pending };
    })
    .sort((a, b) => a.month - b.month);
}

/** 부모 표 통계(자동 청소는 파티션 부모 표를 ANALYZE하지 않는다, data.md §2) */
export async function analyzeTable(database: Database, table: string): Promise<void> {
  checkTable(table);
  await database.db.execute(sql`analyze ${sql.identifier(table)}`);
}

/** 이번 달부터 monthsAhead 달 뒤까지 없는 파티션을 만든다. 하나라도 만들면 부모 표를 ANALYZE한다 */
export async function ensureMonthlyPartitions(database: Database, clock: Clock, spec: MonthlyPartitionSpec): Promise<{ created: string[] }> {
  const ahead = spec.monthsAhead ?? MONTHLY_PARTITION_DEFAULTS.monthsAhead;
  const thisMonth = kstMonthStart(clock.now());
  const existing = new Set((await partitionTables(database, spec.table)).filter((p) => p.attached).map((p) => p.name));
  const created: string[] = [];
  for (let i = 0; i <= ahead; i += 1) {
    const p = monthlyPartitionOf(spec, addKstMonths(thisMonth, i));
    if (existing.has(p.name)) continue;
    const name = sql.identifier(p.name);
    // 경계 값은 DDL이라 매개변수로 넘길 수 없다. 위 함수가 만든 UUID·시각 문자열만 넣는다
    const range = sql.raw(`FROM ('${p.from}') TO ('${p.to}')`);
    await database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
      await tx.execute(sql`create table if not exists ${name} (like ${sql.identifier(spec.table)} including defaults including constraints)`);
      await tx.execute(sql`alter table ${sql.identifier(spec.table)} attach partition ${name} for values ${range}`);
    });
    created.push(p.name);
  }
  if (created.length > 0) await analyzeTable(database, spec.table);
  return { created };
}

/** 이번 달 뒤로 이어서 미리 만든 달 수(2 [가정]보다 적으면 SEV2, partitions_ahead) */
export async function monthlyPartitionsAhead(database: Database, clock: Clock, spec: MonthlyPartitionSpec): Promise<number> {
  const months = new Set((await partitionTables(database, spec.table)).filter((p) => p.attached).map((p) => p.month));
  const thisMonth = kstMonthStart(clock.now());
  let n = 0;
  while (months.has(addKstMonths(thisMonth, n + 1))) n += 1;
  return n;
}

/**
 * 조건 함수가 '지워도 됨'이라 답한 지난 달 파티션을 떼어 내 지운다(이번 달과 앞 달은 보지 않는다). 정비 시간 밖에서는 하지 않는다.
 * 조건이 거짓이면 blocked, 떼어 내기·지우기가 오류면 failed(그 범위를 가리키는 행이 남았을 수 있다. 다음 정비 때 다시)
 */
export async function dropMonthlyPartitions(
  database: Database,
  clock: Clock,
  spec: MonthlyPartitionSpec,
  canDrop: (p: MonthlyPartition) => Promise<boolean>,
  o: { ignoreWindow?: boolean } = {},
): Promise<DropResult> {
  const now = clock.now();
  const result: DropResult = { dropped: [], blocked: [], failed: [] };
  if (!o.ignoreWindow && !inMaintenanceWindow(now)) return { ...result, skipped: 'outside-window' };
  const thisMonth = kstMonthStart(now);
  for (const t of await partitionTables(database, spec.table)) {
    if (t.month >= thisMonth) continue;
    const p = monthlyPartitionOf(spec, t.month);
    if (!(await canDrop(p))) {
      result.blocked.push(p.name);
      continue;
    }
    const client = await database.pool.connect();
    try {
      await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
      if (t.attached) await client.query(`alter table "${spec.table}" detach partition "${p.name}" ${t.detachPending ? 'finalize' : 'concurrently'}`);
      await client.query(`drop table "${p.name}"`);
      result.dropped.push(p.name);
    } catch {
      result.failed.push(p.name);
    } finally {
      await client.query('reset lock_timeout').catch(() => {});
      client.release();
    }
  }
  return result;
}
