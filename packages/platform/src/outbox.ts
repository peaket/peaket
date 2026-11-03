// Outbox 쓰기와 일 파티션 정비(openspec 변경 add-idempotency-and-outbox 결정 7·8, docs/data.md §2 '파티션 표 규칙'·§4의 7번, ADR-0083·0114·0116).
// - Outbox 행은 업무와 같은 트랜잭션의 마지막 문장으로 넣는다(seq 순서 규칙, ADR-0116 결정 3). 이 규칙은 부르는 쪽이 지킨다
// - ID는 주입한 시계의 UUIDv7이고, 표는 ID 범위로 한국 시각 하루씩 나눈다. 기본 파티션은 두지 않는다
// - 정비(미리 만들기·지우기)는 PgBouncer를 거치지 않고 직접 붙는다(세션 SET lock_timeout, DETACH … CONCURRENTLY는 트랜잭션 밖)
import { context, propagation } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import type { Database, DbTransaction } from './database.js';
import { uuidLowerBound, uuidv7, uuidv7Time } from './uuid.js';

export const OUTBOX_TABLE = 'outbox';

/** 제어 사건 주제(ADR-0143 결정 3). control.settings는 ops-svc, control.sessions-terminated는 identity-svc Outbox로 낸다 */
export const CONTROL_TOPICS = { settings: 'control.settings', sessionsTerminated: 'control.sessions-terminated' } as const;

export interface OutboxMessage {
  /** Kafka 주제 */
  topic: string;
  /** Kafka 키(UTF-8). 같은 키의 사건은 같은 파티션에 순서대로 간다 */
  key: string;
  /** Kafka 값. 서비스가 공용 Avro 인코더로 만든 Confluent 형식 바이트(docs/api/avro/README.md §3). 릴레이는 바꾸지 않는다 */
  payload: Uint8Array;
  /** 더 실을 머리. 지금 추적 문맥(W3C traceparent·tracestate)은 저절로 싣는다 */
  headers?: Record<string, string>;
}

/**
 * 같은 트랜잭션에 Outbox 행을 넣고 그 ID들을 돌려준다. 트랜잭션의 마지막 문장으로 부른다
 * (같은 주문·좌석을 바꾸는 뒤 트랜잭션의 seq가 늘 크게, ADR-0116 결정 3)
 */
export async function writeOutbox(tx: DbTransaction, clock: Clock, messages: readonly OutboxMessage[]): Promise<string[]> {
  if (messages.length === 0) return [];
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  const ids: string[] = [];
  const values = messages.map((m) => {
    if (!m.topic) throw new Error('Outbox 주제가 비었다');
    if (typeof m.key !== 'string') throw new Error('Outbox 키는 문자열(UTF-8)이다');
    const id = uuidv7(clock);
    ids.push(id);
    const headers = JSON.stringify({ ...trace, ...(m.headers ?? {}) });
    return sql`(${id}, ${m.topic}, ${m.key}, ${Buffer.from(m.payload)}, ${headers}::jsonb)`;
  });
  await tx.execute(sql`insert into ${sql.identifier(OUTBOX_TABLE)} (id, topic, msg_key, payload, headers) values ${sql.join(values, sql`, `)}`);
  return ids;
}

// ---- 일 파티션(결정 8) ----

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const KST_OFFSET_MS = 9 * HOUR;

/** 미리 만들 날(7일 [가정], 2026-11-01 확정), 지우기 전 보관(3일 [가정]), 미리 만든 날 경보 기준(3일 [가정]) */
export const OUTBOX_PARTITION_DEFAULTS = { daysAhead: 7, keepDays: 3, minAheadDays: 3 } as const;
/** 정비 시간(한국 시각 04:00~06:00, docs/data.md §2) */
export const MAINTENANCE_WINDOW_KST = { startHour: 4, endHour: 6 } as const;
/** 정비 문장의 잠금 기다림 한도(2초 [가정]). 넘으면 실패하고 다음 정비 때 다시 한다 */
const MAINTENANCE_LOCK_TIMEOUT = '2s';

/** 그 시각이 든 한국 시각 날의 0시(유닉스 밀리초) */
export function kstDayStart(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY) * DAY - KST_OFFSET_MS;
}

export function inMaintenanceWindow(ms: number): boolean {
  const hour = ((ms + KST_OFFSET_MS) % DAY) / HOUR;
  return hour >= MAINTENANCE_WINDOW_KST.startHour && hour < MAINTENANCE_WINDOW_KST.endHour;
}

const ymd = (dayStart: number): string => new Date(dayStart + KST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
const PARTITION_NAME = /^outbox_p(\d{4})(\d{2})(\d{2})$/;
const dayOfName = (name: string): number | undefined => {
  const m = PARTITION_NAME.exec(name);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_OFFSET_MS : undefined;
};

/** 그날(한국 시각 0시)의 파티션 이름과 ID 범위 */
export function outboxPartitionOf(dayStart: number): { name: string; from: string; to: string } {
  if (kstDayStart(dayStart) !== dayStart) throw new Error(`한국 시각 0시가 아니다: ${new Date(dayStart).toISOString()}`);
  return { name: `outbox_p${ymd(dayStart)}`, from: uuidLowerBound(dayStart), to: uuidLowerBound(dayStart + DAY) };
}

interface PartitionTable {
  name: string;
  day: number;
  /** 부모에 붙어 있다(떼어 내는 중 포함) */
  attached: boolean;
  detachPending: boolean;
}

/**
 * 부모와 같은 스키마의 outbox_pYYYYMMDD 표들. 붙은 파티션만이 아니라 떨어진 표도 찾는다
 * (떼어 낸 뒤 DROP이 실패한 표가 부모 목록에서 빠져 다시 지우지도 지표에 잡히지도 않았다, 코드 리뷰 2026-11-01)
 */
async function partitionTables(database: Database): Promise<PartitionTable[]> {
  const rows = (
    await database.db.execute(sql`
      select c.relname as name, i.inhrelid is not null as attached, coalesce(i.inhdetachpending, false) as pending
      from pg_class c
      left join pg_inherits i on i.inhrelid = c.oid and i.inhparent = ${OUTBOX_TABLE}::regclass
      where c.relkind = 'r' and c.relname ~ '^outbox_p[0-9]{8}$'
        and c.relnamespace = (select relnamespace from pg_class where oid = ${OUTBOX_TABLE}::regclass)`)
  ).rows as { name: string; attached: boolean; pending: boolean }[];
  const out: PartitionTable[] = [];
  for (const r of rows) {
    const day = dayOfName(r.name);
    if (day !== undefined) out.push({ name: r.name, day, attached: r.attached, detachPending: r.pending });
  }
  return out.sort((a, b) => a.day - b.day);
}

/**
 * 오늘(KST)부터 daysAhead일 뒤까지 없는 파티션을 만든다. 첫 파티션도 이 함수가 만든다(마이그레이션 직후와 매일 정비 잡).
 * 부모를 오래 막지 않게 따로 만든 표를 붙인다(ATTACH는 부모에 SHARE UPDATE EXCLUSIVE만 건다). 붙일 때 기본 키·부분 인덱스가 생긴다
 */
export async function ensureOutboxPartitions(database: Database, clock: Clock, o: { daysAhead?: number } = {}): Promise<{ created: string[] }> {
  const daysAhead = o.daysAhead ?? OUTBOX_PARTITION_DEFAULTS.daysAhead;
  const today = kstDayStart(clock.now());
  // 떨어진 같은 이름의 표가 있으면 만들기는 건너뛰고 붙이기만 한다
  const existing = new Set((await partitionTables(database)).filter((p) => p.attached).map((p) => p.name));
  const created: string[] = [];
  for (let i = 0; i <= daysAhead; i += 1) {
    const p = outboxPartitionOf(today + i * DAY);
    if (existing.has(p.name)) continue;
    const name = sql.identifier(p.name);
    // 경계 값은 DDL이라 매개변수로 넘길 수 없다. uuidLowerBound가 만든 16진수·하이픈 문자열만 넣는다
    const range = sql.raw(`FROM ('${p.from}') TO ('${p.to}')`);
    await database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${MAINTENANCE_LOCK_TIMEOUT}, true)`);
      await tx.execute(sql`create table if not exists ${name} (like ${sql.identifier(OUTBOX_TABLE)} including defaults including constraints)`);
      await tx.execute(sql`alter table ${sql.identifier(OUTBOX_TABLE)} attach partition ${name} for values ${range}`);
    });
    created.push(p.name);
  }
  return { created };
}

export interface DropResult {
  dropped: string[];
  /** 보내지 않은 행이 남아 지우지 않은 파티션(SEV2) */
  blocked: string[];
  /** 떼어 내기·지우기가 오류로 끝난 파티션(다음 정비 때 다시 한다) */
  failed: string[];
  skipped?: 'outside-window';
}

/**
 * 끝이 오늘 0시(KST)보다 keepDays일 이상 앞인 파티션을 떼어 내 지운다. 정비 시간 밖에서는 하지 않는다.
 * 보내지 않은 행이 남은 파티션은 지우지 않는다(ADR-0116 결정 4). 떼어 내기는 CONCURRENTLY(부모의 쓰기를 막지 않는다)
 */
export async function dropExpiredOutboxPartitions(database: Database, clock: Clock, o: { keepDays?: number; ignoreWindow?: boolean } = {}): Promise<DropResult> {
  const now = clock.now();
  const result: DropResult = { dropped: [], blocked: [], failed: [] };
  if (!o.ignoreWindow && !inMaintenanceWindow(now)) return { ...result, skipped: 'outside-window' };
  const limit = kstDayStart(now) - (o.keepDays ?? OUTBOX_PARTITION_DEFAULTS.keepDays) * DAY;
  for (const p of await partitionTables(database)) {
    if (p.day + DAY > limit) continue;
    const ident = sql.identifier(p.name);
    const unsent = await database.db.execute(sql`select 1 from ${ident} where sent_at is null limit 1`);
    if (unsent.rows.length > 0) {
      result.blocked.push(p.name);
      continue;
    }
    const client = await database.pool.connect();
    try {
      const quoted = `"${p.name}"`;
      await client.query(`set lock_timeout = '${MAINTENANCE_LOCK_TIMEOUT}'`);
      // 앞서 끊긴 떼어 내기는 FINALIZE로 마치고, 이미 떨어진 표는 지우기만 한다
      if (p.attached) await client.query(`alter table "${OUTBOX_TABLE}" detach partition ${quoted} ${p.detachPending ? 'finalize' : 'concurrently'}`);
      await client.query(`drop table ${quoted}`);
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

export interface OutboxHealth {
  /** 가장 오래 기다린 보내지 않은 행(seq가 가장 작은 행)의 나이(초). 없으면 0 */
  lagSeconds: number;
  /** 내일부터 이어서 미리 만든 날 수 */
  aheadDays: number;
  /** 지울 날에서 하루 더 지났는데 남은 파티션 수(보내지 않은 행에 막혔거나 정비 잡이 돌지 않았다). 떼어 냈지만 지우지 못한 표도 센다 */
  overdue: number;
}

/** 릴레이가 5초마다 재는 값(리더가 아니어도 잰다, ADR-0116 결정 5) */
export async function outboxHealth(database: Database, clock: Clock, o: { keepDays?: number } = {}): Promise<OutboxHealth> {
  const now = clock.now();
  const oldest = (await database.db.execute(sql`select id::text as id from ${sql.identifier(OUTBOX_TABLE)} where sent_at is null order by seq limit 1`)).rows as { id: string }[];
  const lagSeconds = oldest[0] ? Math.max(0, now - uuidv7Time(oldest[0].id)) / 1000 : 0;
  const parts = await partitionTables(database);
  const days = new Set(parts.filter((p) => p.attached).map((p) => p.day));
  const today = kstDayStart(now);
  let aheadDays = 0;
  while (days.has(today + (aheadDays + 1) * DAY)) aheadDays += 1;
  const overdueLimit = today - ((o.keepDays ?? OUTBOX_PARTITION_DEFAULTS.keepDays) + 1) * DAY;
  const overdue = parts.filter((p) => p.day + DAY <= overdueLimit).length;
  return { lagSeconds, aheadDays, overdue };
}
