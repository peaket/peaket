// 정비 일 `sale-config-publish`의 입력: 승인된 공연(모든 테넌트, core_maintenance 역할).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { ApprovedProduction, SaleConfigMaintenanceStore } from '../../domain/sale-config-ports.js';
import { production } from './schema.js';

@Injectable()
export class DrizzleSaleConfigMaintenanceStore implements SaleConfigMaintenanceStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async approvedProductions(limit: number): Promise<ApprovedProduction[]> {
    const rows = await this.database.db
      .select({ productionId: production.id, promoterId: production.promoterId })
      .from(production)
      .where(and(eq(production.saleReview, 'APPROVED'), isNotNull(production.saleApprovedAt)))
      .orderBy(asc(production.saleApprovedAt))
      .limit(limit);
    return rows;
  }
}
