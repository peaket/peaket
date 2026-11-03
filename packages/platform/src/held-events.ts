// 보류 표 held_event(openspec 변경 add-maintenance-control-and-consumers 결정 6, ADR-0142 결정 2, docs/data.md §4의 15번).
// 처리 못 하는 사건은 Kafka 데드 레터 토픽이 아니라 그 서비스 DB의 이 표로 옮긴다. 사건 값이 그대로 들어가므로 그 서비스 DB와 같은
// 보호 등급으로 다룬다(asvs/delivery.md 14.2.4). 다시 처리(RB-11)는 업무 키마다 들어온 순서대로, 다시 처리한 행은 7일 [가정] 뒤 지운다.
import { sql } from 'drizzle-orm';
import { bigint, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { ConsumedMessage, HeldEventInput, HeldEventStore } from './keyed-consumer.js';
import { errorSummary } from './keyed-consumer.js';
import { uuidv7 } from './uuid.js';

export const HELD_EVENT_TABLE = 'held_event';
/** 다시 처리한 행을 지우기 전 보관(Kafka 보관과 같은 7일 [가정]) */
export const HELD_EVENT_KEEP_DAYS = 7;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** 표 정의(서비스 마이그레이션 0003과 같다) */
export function heldEventTable() {
  return pgTable(
    HELD_EVENT_TABLE,
    {
      id: uuid('id').primaryKey(),
      topic: text('topic').notNull(),
      partition: integer('partition').notNull(),
      kafkaOffset: bigint('kafka_offset', { mode: 'bigint' }).notNull(),
      eventKey: text('event_key'),
      businessKey: text('business_key').notNull(),
      error: text('error').notNull(),
      /** Kafka 키(다시 처리 때 그대로 넘긴다) */
      msgKey: text('msg_key'),
      /** Kafka 레코드 시각 */
      recordAt: timestamp('record_at', { withTimezone: true }).notNull(),
      value: bytea('value'),
      headers: jsonb('headers').notNull().default({}),
      heldAt: timestamp('held_at', { withTimezone: true }).notNull(),
      reprocessedAt: timestamp('reprocessed_at', { withTimezone: true }),
    },
    (t) => [
      uniqueIndex('held_event_position_key').on(t.topic, t.partition, t.kafkaOffset),
      uniqueIndex('held_event_event_key').on(t.topic, t.eventKey).where(sql`event_key IS NOT NULL`),
      index('held_event_pending_idx').on(t.topic, t.businessKey, t.partition, t.kafkaOffset).where(sql`reprocessed_at IS NULL`),
    ],
  );
}

const T = sql.identifier(HELD_EVENT_TABLE);
/** 한 업무 키의 '보류 중인가' 확인과 넣기·다시 처리의 마지막 확인을 묶는 잠금(트랜잭션 끝에 풀린다) */
const keyLock = (topic: string, businessKey: string) => sql`select pg_advisory_xact_lock(hashtextextended(${`${topic}/${businessKey}`}, 0))`;
const insertHeld = (clock: Clock, e: HeldEventInput) => sql`
  insert into ${T} (id, topic, partition, kafka_offset, event_key, business_key, error, msg_key, record_at, value, headers, held_at)
  values (${uuidv7(clock)}, ${e.topic}, ${e.partition}, ${e.offset.toString()}::bigint, ${e.eventKey}, ${e.businessKey}, ${e.error}, ${e.key},
    ${new Date(e.timestamp).toISOString()}::timestamptz, ${e.value}, ${JSON.stringify(e.headers)}::jsonb, ${new Date(clock.now()).toISOString()}::timestamptz)
  on conflict do nothing`;
const pendingOf = (topic: string, businessKey: string) => sql`select 1 from ${T} where topic = ${topic} and business_key = ${businessKey} and reprocessed_at is null limit 1`;

/** 보류 포트의 PostgreSQL 구현. 넣기는 커밋된 뒤에 돌아온다(그 뒤에 위치를 커밋한다) */
export function drizzleHeldEventStore(database: Database, clock: Clock): HeldEventStore {
  return {
    async heldKeys(topic, partition) {
      const rows = (await database.db.execute(sql`select distinct business_key as k from ${T} where topic = ${topic} and partition = ${partition} and reprocessed_at is null`)).rows as { k: string }[];
      return new Set(rows.map((r) => r.k));
    },
    async isHeld(topic, businessKey) {
      return (await database.db.execute(pendingOf(topic, businessKey))).rows.length > 0;
    },
    async hold(e: HeldEventInput) {
      await database.db.execute(insertHeld(clock, e));
    },
    async holdIfHeld(e: HeldEventInput) {
      return database.transaction(async (tx) => {
        await tx.execute(keyLock(e.topic, e.businessKey));
        if ((await tx.execute(pendingOf(e.topic, e.businessKey))).rows.length === 0) return false;
        await tx.execute(insertHeld(clock, e));
        return true;
      });
    },
  };
}

/** 토픽마다 보류 중인 행 수(consumer_held_events) */
export async function heldEventCounts(database: Database): Promise<Map<string, number>> {
  const rows = (await database.db.execute(sql`select topic, count(*)::int as n from ${T} where reprocessed_at is null group by topic`)).rows as { topic: string; n: number }[];
  return new Map(rows.map((r) => [r.topic, r.n]));
}

export interface ReprocessResult {
  reprocessed: number;
  /** 실패해 멈춘 행(그 뒤 행은 그대로 보류 중이다) */
  failed?: { offset: bigint; error: string };
}

/**
 * RB-11 '보류 사건 다시 처리': 한 업무 키의 보류 행을 들어온 순서(파티션·오프셋)대로 처리기에 넘기고 행마다 reprocessed_at을 적는다.
 * 하나가 실패하면 거기서 멈춘다. 그사이 새로 보류된 행도 이어서 한다. 이미 반영된 사건은 처리기가 eventKey로 건너뛴다
 */
export async function reprocessHeldEvents(
  database: Database,
  clock: Clock,
  o: { topic: string; businessKey: string; handle: (m: ConsumedMessage) => Promise<void> },
): Promise<ReprocessResult> {
  let reprocessed = 0;
  for (;;) {
    const rows = (
      await database.db.execute(sql`
        select id::text as id, partition, kafka_offset::text as off, msg_key, record_at, value, headers
        from ${T} where topic = ${o.topic} and business_key = ${o.businessKey} and reprocessed_at is null
        order by partition, kafka_offset limit 100`)
    ).rows as { id: string; partition: number; off: string; msg_key: string | null; record_at: string | Date; value: Buffer | null; headers: Record<string, string> }[];
    if (rows.length === 0) {
      // 끝내기 전에 잠금 아래에서 다시 본다: 실시간 소비자가 그사이 넣은 행(holdIfHeld)이 있으면 이어서 한다
      const more = await database.transaction(async (tx) => {
        await tx.execute(keyLock(o.topic, o.businessKey));
        return (await tx.execute(pendingOf(o.topic, o.businessKey))).rows.length > 0;
      });
      if (more) continue;
      return { reprocessed };
    }
    for (const r of rows) {
      const m: ConsumedMessage = { topic: o.topic, partition: r.partition, offset: BigInt(r.off), key: r.msg_key, value: r.value, headers: r.headers ?? {}, timestamp: new Date(r.record_at).getTime() };
      try {
        await o.handle(m);
      } catch (err) {
        return { reprocessed, failed: { offset: m.offset, error: errorSummary(err) } };
      }
      await database.db.execute(sql`update ${T} set reprocessed_at = ${new Date(clock.now()).toISOString()}::timestamptz where id = ${r.id}::uuid`);
      reprocessed += 1;
    }
  }
}

/** 다시 처리한 지 keepDays일이 지난 행을 지운다(정비 시간) */
export async function deleteReprocessedHeldEvents(database: Database, clock: Clock, o: { keepDays?: number } = {}): Promise<number> {
  const limit = new Date(clock.now() - (o.keepDays ?? HELD_EVENT_KEEP_DAYS) * 24 * 60 * 60 * 1000).toISOString();
  return (await database.db.execute(sql`delete from ${T} where reprocessed_at < ${limit}::timestamptz`)).rowCount ?? 0;
}
