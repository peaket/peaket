// Drizzle 공연 이미지 저장소(파트너 경로, ADR-0241·ADR-0257, docs/data.md production_image·§5 마지막 줄).
// 파트너 전용 DB 사용자(core_partner)로 접속하고 트랜잭션마다 테넌트(app.tenant_id)를 건다. 조회에도 테넌트 조건을 넣는다(범위 인자, 행 보안은 2차 방어).
// 장수·순서·포스터 바꾸기는 공연 행을 잠근 트랜잭션 안에서 한다. 잠금은 등록 경로와 같은 FOR NO KEY UPDATE다
// (공연 행끼리는 FOR UPDATE처럼 줄을 세우고, 찜·회차 넣기의 외래키 잠금(KEY SHARE)은 막지 않는다).
import { Inject, Injectable } from '@nestjs/common';
import type { Database, DbTransaction } from '@peaket/platform';
import { and, eq, sql } from 'drizzle-orm';
import type { PartnerProductionMedia, ProductionImageTx } from '../../domain/media-ports.js';
import type { ImageKind, ProductionImageRow } from '../../domain/production-image.js';
import { PARTNER_DATABASE } from './drizzle-catalog-repository.js';
import { production, productionImage } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const toRow = (r: typeof productionImage.$inferSelect): ProductionImageRow => ({
  id: r.id,
  productionId: r.productionId,
  promoterId: r.promoterId,
  kind: r.kind as ImageKind,
  alt: r.alt,
  order: r.displayOrder,
  width: r.width,
  height: r.height,
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

@Injectable()
export class DrizzleProductionMedia implements PartnerProductionMedia {
  constructor(@Inject(PARTNER_DATABASE) private readonly db: Database) {}

  async owns(productionId: string, tenantId: string): Promise<boolean> {
    if (!UUID.test(productionId)) return false;
    return this.db.transaction(
      async (tx) => (await tx.select({ id: production.id }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId))).limit(1)).length > 0,
      { tenantId },
    );
  }

  async detailCount(productionId: string, tenantId: string): Promise<number> {
    if (!UUID.test(productionId)) return 0;
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(productionImage)
        .where(and(eq(productionImage.productionId, productionId), eq(productionImage.promoterId, tenantId), eq(productionImage.kind, 'DETAIL')));
      return r?.n ?? 0;
    }, { tenantId });
  }

  async withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: ProductionImageTx) => Promise<T>): Promise<T | 'not-found'> {
    if (!UUID.test(productionId)) return 'not-found';
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ id: production.id }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId))).for('no key update');
      if (!p) return 'not-found' as const;
      return fn(this.#tx(tx, productionId, tenantId));
    }, { tenantId });
  }

  #tx(tx: DbTransaction, productionId: string, tenantId: string): ProductionImageTx {
    const mine = (id: string) => and(eq(productionImage.id, id), eq(productionImage.productionId, productionId), eq(productionImage.promoterId, tenantId));
    return {
      images: async () =>
        (await tx.select().from(productionImage).where(and(eq(productionImage.productionId, productionId), eq(productionImage.promoterId, tenantId))).orderBy(productionImage.kind, productionImage.displayOrder)).map(toRow),
      insert: async (r) => {
        await tx.insert(productionImage).values({
          id: r.id,
          productionId: r.productionId,
          promoterId: r.promoterId,
          kind: r.kind,
          alt: r.alt,
          displayOrder: r.order,
          width: r.width,
          height: r.height,
          version: r.version,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      },
      remove: async (id) => {
        await tx.delete(productionImage).where(mine(id));
      },
      update: async (id, p) => {
        await tx
          .update(productionImage)
          .set({ ...(p.alt !== undefined ? { alt: p.alt } : {}), ...(p.order !== undefined ? { displayOrder: p.order } : {}), version: p.version, updatedAt: p.updatedAt })
          .where(mine(id));
      },
    };
  }
}
