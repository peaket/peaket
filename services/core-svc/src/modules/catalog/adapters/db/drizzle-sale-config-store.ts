// core DB의 회차 판매 설정 사본(event_sale_config, 판매 승인 LCH-080). purchase-svc(BAT-051)가 이 표를 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import type { EventSaleConfig } from '../../domain/event-sale-config.js';
import { OPS_DATABASE, type SaleConfigReader, type SaleConfigStore } from '../../domain/sale-config-ports.js';
import { eventSaleConfig } from './schema.js';

/** 내부 HTTP 읽기 전용 사본 읽기(core_app). 쓰기 역할(core_ops)을 읽기에 쓰지 않는다 */
@Injectable()
export class DrizzleSaleConfigReader implements SaleConfigReader {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async get(eventId: string): Promise<EventSaleConfig | undefined> {
    const [row] = await this.database.db.select({ payload: eventSaleConfig.payload }).from(eventSaleConfig).where(eq(eventSaleConfig.eventId, eventId)).limit(1);
    return row ? (row.payload as EventSaleConfig) : undefined;
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
}
