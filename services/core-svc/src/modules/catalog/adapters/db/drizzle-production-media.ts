// Drizzle 공연 이미지 저장소(파트너 경로, ADR-0241·ADR-0257, docs/data.md production_image·§5 마지막 줄).
// 파트너 전용 DB 사용자(core_partner)로 접속하고 트랜잭션마다 테넌트(app.tenant_id)를 건다. 조회에도 테넌트 조건을 넣는다(범위 인자, 행 보안은 2차 방어).
// 장수·순서·포스터 바꾸기는 공연 행을 잠근 트랜잭션 안에서 한다. 잠금은 등록 경로와 같은 FOR NO KEY UPDATE다
// (공연 행끼리는 FOR UPDATE처럼 줄을 세우고, 찜·회차 넣기의 외래키 잠금(KEY SHARE)은 막지 않는다).
// 포스터를 게시·지우거나 고친 트랜잭션은 같은 트랜잭션에서 검색 읽기 모델의 포스터 칸을 고친다(ADR-0271 결정 2·17, search_sync_poster). 공개 전 공연이면 바꿀 것이 없다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, type Database, type DbTransaction } from '@peaket/platform';
import { and, eq, sql } from 'drizzle-orm';
import type { PartnerProductionMedia, ProductionImageTx } from '../../domain/media-ports.js';
import type { ImageKind, ProductionImageRow } from '../../domain/production-image.js';
import { SEARCH_READ_MODEL_SYNC, type SearchReadModelSync } from '../../domain/search.js';
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
  constructor(
    @Inject(PARTNER_DATABASE) private readonly db: Database,
    @Optional() @Inject(SEARCH_READ_MODEL_SYNC) private readonly search?: SearchReadModelSync,
    @Optional() @Inject(CLOCK) private readonly clock?: Clock,
  ) {}

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
      let posterTouched = false;
      const out = await fn(this.#tx(tx, productionId, tenantId, () => (posterTouched = true)));
      // 파트너 역할은 검색 표를 직접 쓰지 못한다. 정의자 함수가 테넌트를 확인하고 포스터 칸만 고친다(ADR-0271 결정 17)
      if (posterTouched && this.search) await this.search.syncPoster(tx, productionId);
      return out;
    }, { tenantId });
  }

  /** touched: 포스터(검색 카드의 그림)가 바뀔 수 있는 쓰기를 했다 */
  #tx(tx: DbTransaction, productionId: string, tenantId: string, touched: () => void): ProductionImageTx {
    const mine = (id: string) => and(eq(productionImage.id, id), eq(productionImage.productionId, productionId), eq(productionImage.promoterId, tenantId));
    const kindOf = async (id: string) => (await tx.select({ kind: productionImage.kind }).from(productionImage).where(mine(id)))[0]?.kind;
    return {
      images: async () =>
        (await tx.select().from(productionImage).where(and(eq(productionImage.productionId, productionId), eq(productionImage.promoterId, tenantId))).orderBy(productionImage.kind, productionImage.displayOrder)).map(toRow),
      insert: async (r) => {
        if (r.kind === 'POSTER') touched();
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
        if ((await kindOf(id)) === 'POSTER') touched();
        await tx.delete(productionImage).where(mine(id));
      },
      update: async (id, p) => {
        if ((await kindOf(id)) === 'POSTER') touched();
        await tx
          .update(productionImage)
          .set({ ...(p.alt !== undefined ? { alt: p.alt } : {}), ...(p.order !== undefined ? { displayOrder: p.order } : {}), version: p.version, updatedAt: p.updatedAt })
          .where(mine(id));
      },
    };
  }
}
