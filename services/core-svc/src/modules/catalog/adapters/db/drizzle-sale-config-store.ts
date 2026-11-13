// core DB의 회차 판매 설정 사본(event_sale_config, 판매 승인 LCH-080). purchase-svc(BAT-051)가 이 표를 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import type { EventSaleConfig } from '../../domain/event-sale-config.js';
import { OPS_DATABASE, type SaleConfigStore } from '../../domain/sale-config-ports.js';
import { eventSaleConfig } from './schema.js';

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
