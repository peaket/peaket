// F-06-8 반복 실패 사건 보류: core DB `held_event`(ADR-0142). 같은 주제·eventKey는 한 번만 적는다.
import type { Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NotifyHeldEvents } from '../../domain/fan-notify-ports.js';

const TOPIC = 'trade.orders';

export class DrizzleNotifyHeldEvents implements NotifyHeldEvents {
  constructor(private readonly db: Database) {}

  async find(eventKey: string): Promise<boolean> {
    const r = await this.db.db.execute(sql`select 1 from held_event where topic = ${TOPIC} and event_key = ${eventKey} limit 1`);
    return (r as unknown as { rows: unknown[] }).rows.length > 0;
  }

  async hold(e: { eventKey: string; kind: string; payload: Record<string, unknown>; attempts: number; partition?: number; kafkaOffset?: number }, now: Date): Promise<void> {
    await this.db.db.execute(sql`
      insert into held_event (id, topic, partition, kafka_offset, event_key, business_key, error, record_at, held_at, headers, value)
      values (${randomUUID()}::uuid, ${TOPIC}, ${e.partition ?? 0}, ${e.kafkaOffset ?? 0}, ${e.eventKey}, ${String(e.payload.orderId ?? e.eventKey)}, ${`notify-intake:${e.kind}:attempts=${e.attempts}`}, ${now}::timestamptz, ${now}::timestamptz, ${JSON.stringify({ kind: e.kind })}::jsonb, null)
      on conflict do nothing`);
  }
}
