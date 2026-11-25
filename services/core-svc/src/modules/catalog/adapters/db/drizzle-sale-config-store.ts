// core DB의 회차 판매 설정 사본(event_sale_config, 판매 승인 LCH-080). purchase-svc(BAT-051)가 이 표를 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import type { EventSaleConfig } from '../../domain/event-sale-config.js';
import { ONSALE_WINDOW_END_MS, OPS_DATABASE, type DueEventConfig, type OnsaleClosedEvent, type SaleConfigReader, type SaleConfigStore } from '../../domain/sale-config-ports.js';
import { eventSaleConfig, event } from './schema.js';

const dueEvents = async (database: Database, through: Date, limit: number): Promise<DueEventConfig[]> => {
  const rows = await database.db
    .select({ payload: eventSaleConfig.payload })
    .from(eventSaleConfig)
    .where(sql`(${eventSaleConfig.payload}->>'endsAtMs')::bigint <= ${through.getTime()}`)
    .orderBy(eventSaleConfig.eventId)
    .limit(limit);
  return rows
    .map((r) => r.payload as EventSaleConfig)
    .filter((p): p is EventSaleConfig & { endsAtMs: number } => typeof p.endsAtMs === 'number')
    .map((p) => ({ eventId: p.eventId, promoterId: p.promoterId, endsAt: new Date(p.endsAtMs) }));
};

/** 판매 시작 + 60분이 [from, to)에 든 회차(ID·마감 시각만, ADR-0348 결정 9) */
const onsaleClosed = async (database: Database, from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]> => {
  const closedAt = sql`((${eventSaleConfig.payload}->>'opensAtMs')::bigint + ${ONSALE_WINDOW_END_MS})`;
  const rows = await database.db
    .select({ eventId: eventSaleConfig.eventId, closedAtMs: sql<string>`${closedAt}` })
    .from(eventSaleConfig)
    .where(sql`${closedAt} >= ${from.getTime()} and ${closedAt} < ${to.getTime()}`)
    .orderBy(sql`${closedAt}`, eventSaleConfig.eventId)
    .limit(limit);
  return rows.map((r) => ({ eventId: r.eventId, closedAt: new Date(Number(r.closedAtMs)) }));
};

/** 판매 시작이 [from, to)에 든 취소되지 않은 회차(회차·오픈 시각·규모). F-02-5 온세일 로그 표본 */
const onsaleOpens = async (database: Database, from: Date, to: Date, limit: number): Promise<{ eventId: string; opensAtMs: number; scale: 'LARGE' | 'MEDIUM' | 'SMALL' | null }[]> => {
  const rows = await database.db
    .select({ eventId: event.id, openAt: event.openAt, scale: event.scale })
    .from(event)
    .where(sql`${event.status} <> 'CANCELLED' and ${event.openAt} >= ${from} and ${event.openAt} < ${to}`)
    .orderBy(event.openAt, event.id)
    .limit(limit);
  return rows.map((r) => ({
    eventId: r.eventId,
    opensAtMs: r.openAt.getTime(),
    scale: r.scale === 'LARGE' || r.scale === 'MEDIUM' || r.scale === 'SMALL' ? r.scale : null,
  }));
};

/** 내부 HTTP 읽기 전용 사본 읽기(core_app). 쓰기 역할(core_ops)을 읽기에 쓰지 않는다 */
@Injectable()
export class DrizzleSaleConfigReader implements SaleConfigReader {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async get(eventId: string): Promise<EventSaleConfig | undefined> {
    const [row] = await this.database.db.select({ payload: eventSaleConfig.payload }).from(eventSaleConfig).where(eq(eventSaleConfig.eventId, eventId)).limit(1);
    return row ? (row.payload as EventSaleConfig) : undefined;
  }

  listEndedBefore(through: Date, limit: number): Promise<DueEventConfig[]> {
    return dueEvents(this.database, through, limit);
  }

  listOnsaleClosed(from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]> {
    return onsaleClosed(this.database, from, to, limit);
  }

  listOnsaleOpens(from: Date, to: Date, limit: number): Promise<{ eventId: string; opensAtMs: number; scale: 'LARGE' | 'MEDIUM' | 'SMALL' | null }[]> {
    return onsaleOpens(this.database, from, to, limit);
  }

  async commissionRateBp(eventId: string): Promise<number | undefined> {
    const [row] = await this.database.db.select({ payload: eventSaleConfig.payload }).from(eventSaleConfig).where(eq(eventSaleConfig.eventId, eventId)).limit(1);
    const rate = (row?.payload as EventSaleConfig | undefined)?.commissionRateBp;
    return typeof rate === 'number' ? rate : undefined;
  }
}

@Injectable()
export class DrizzleSaleConfigStore implements SaleConfigStore {
  constructor(@Inject(OPS_DATABASE) private readonly database: Database) {}

  async put(configs: readonly EventSaleConfig[], _admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void> {
    const now = new Date();
    for (const c of configs) {
      await this.database.db
        .insert(eventSaleConfig)
        .values({ eventId: c.eventId, productionId: c.productionId, promoterId: c.promoterId, rev: c.rev, payload: c, updatedAt: now })
        .onConflictDoUpdate({
          target: eventSaleConfig.eventId,
          set: { productionId: c.productionId, promoterId: c.promoterId, rev: c.rev, payload: c, updatedAt: now },
        });
    }
  }

  async get(eventId: string): Promise<EventSaleConfig | undefined> {
    const [row] = await this.database.db.select({ payload: eventSaleConfig.payload }).from(eventSaleConfig).where(eq(eventSaleConfig.eventId, eventId)).limit(1);
    return row ? (row.payload as EventSaleConfig) : undefined;
  }

  listEndedBefore(through: Date, limit: number): Promise<DueEventConfig[]> {
    return dueEvents(this.database, through, limit);
  }

  listOnsaleClosed(from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]> {
    return onsaleClosed(this.database, from, to, limit);
  }

  listOnsaleOpens(from: Date, to: Date, limit: number): Promise<{ eventId: string; opensAtMs: number; scale: 'LARGE' | 'MEDIUM' | 'SMALL' | null }[]> {
    return onsaleOpens(this.database, from, to, limit);
  }

  async commissionRateBp(eventId: string): Promise<number | undefined> {
    const [row] = await this.database.db.select({ payload: eventSaleConfig.payload }).from(eventSaleConfig).where(eq(eventSaleConfig.eventId, eventId)).limit(1);
    const rate = (row?.payload as EventSaleConfig | undefined)?.commissionRateBp;
    return typeof rate === 'number' ? rate : undefined;
  }
}
