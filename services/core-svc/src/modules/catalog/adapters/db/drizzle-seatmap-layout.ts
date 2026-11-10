// Drizzle 배치본 저장소(파트너 경로, ADR-0241·ADR-0260 결정 2·5·8·9·10, docs/data.md venue·section·seat·price_tier·§5).
// 파트너 전용 DB 사용자(core_partner)로 접속하고 트랜잭션마다 테넌트(app.tenant_id)를 건다. 조회에도 테넌트 조건을 넣는다(범위 인자, 행 보안은 2차 방어).
// 저장은 공연 행을 잠근 트랜잭션 두 번(① 판 잡기, ② 판 확인 뒤 쓰기)으로 하고, 잠금은 등록·회차 더하기·이미지와 같은 FOR NO KEY UPDATE다.
// 행 바꿔 넣기는 좌석 → 구역 → 가격 등급 차례로 지우고 반대 차례로 넣는다(외래키). 값은 빌더로만 넘긴다(ASVS v5.0.0-1.2.4).
import { Inject, Injectable } from '@nestjs/common';
import type { Database, DbTransaction } from '@peaket/platform';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Production } from '../../domain/production.js';
import type { LayoutShape } from '../../domain/seatmap-import.js';
import { type LayoutDoc, layoutVenueId } from '../../domain/seatmap-layout.js';
import type { LayoutState, LayoutTx, SeatmapLayoutStore } from '../../domain/seatmap-ports.js';
import { PARTNER_DATABASE } from './drizzle-catalog-repository.js';
import { opt, pendingOf, readRowLayout, sectionDoc, type StoredAdded } from './layout-rows.js';
import { event, priceTier, production, seat, section, venue } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 좌석 넣기 한 번의 행 수(열 13개 × 3,000 = 매개변수 39,000, PostgreSQL 상한 65,535 아래) */
const SEAT_CHUNK = 3_000;

@Injectable()
export class DrizzleSeatmapLayoutStore implements SeatmapLayoutStore {
  constructor(@Inject(PARTNER_DATABASE) private readonly db: Database) {}

  async owns(productionId: string, tenantId: string): Promise<boolean> {
    if (!UUID.test(productionId)) return false;
    return this.db.transaction(async (tx) => (await tx.select({ id: production.id }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId))).limit(1)).length > 0, { tenantId });
  }

  async ownerView(productionId: string, tenantId: string): Promise<{ approvedBefore: boolean } | undefined> {
    if (!UUID.test(productionId)) return undefined;
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ approvedAt: production.saleApprovedAt }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId)));
      return p ? { approvedBefore: p.approvedAt !== null } : undefined;
    }, { tenantId });
  }

  async current(productionId: string, tenantId: string): Promise<{ version: number; doc: LayoutDoc } | undefined | 'not-found'> {
    if (!UUID.test(productionId)) return 'not-found';
    // 읽기 전용 REPEATABLE READ 트랜잭션 하나로 읽는다: 배치본 행·구역·좌석·가격 등급이 같은 판에서 온다(사이에 저장이 커밋돼도 섞이지 않는다, 리뷰 C5)
    return this.db.transaction(
      async (tx) => {
        const [p] = await tx.select({ id: production.id }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId)));
        if (!p) return 'not-found' as const;
        const vid = layoutVenueId(productionId);
        const [v] = await tx.select().from(venue).where(and(eq(venue.id, vid), eq(venue.promoterId, tenantId)));
        const pending = pendingOf(v);
        return pending ? { version: pending.version, doc: pending.doc } : await readRowLayout(tx, vid, tenantId);
      },
      { tenantId, isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async templateDraft(templateVenueId: string, tenantId: string): Promise<LayoutDoc | undefined> {
    if (!UUID.test(templateVenueId)) return undefined;
    return this.db.transaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(venue)
        .where(and(eq(venue.id, templateVenueId), eq(venue.kind, 'TEMPLATE'), eq(venue.published, true)));
      if (!t || t.canvasWidth === null || t.canvasHeight === null) return undefined;
      const sections = await tx.select().from(section).where(and(eq(section.venueId, t.id), isNull(section.promoterId))).orderBy(asc(section.sortOrder));
      return {
        canvas: { width: t.canvasWidth, height: t.canvasHeight },
        stage: (t.stageShapes ?? []) as LayoutShape[],
        // 틀의 구역은 좌석이 없다(채우기 규칙만 있다). 범위는 매기지 않는다
        sections: sections.map((s) => {
          const { seatIndexRange: _drop, ...rest } = sectionDoc(s, []);
          return rest;
        }),
        priceTiers: [],
        templateVenueId: t.id,
      };
    }, { tenantId });
  }

  async withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: LayoutTx) => Promise<T>): Promise<T | 'not-found'> {
    if (!UUID.test(productionId)) return 'not-found';
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId))).for('no key update');
      if (!p) return 'not-found' as const;
      return fn(this.#tx(tx, p, tenantId));
    }, { tenantId });
  }

  #tx(tx: DbTransaction, p: typeof production.$inferSelect, tenantId: string): LayoutTx {
    const vid = layoutVenueId(p.id);
    const venueRow = async () => (await tx.select().from(venue).where(and(eq(venue.id, vid), eq(venue.promoterId, tenantId))))[0];
    const added = () => ((p.pendingRevision as { addedEvents?: StoredAdded[] } | null)?.addedEvents ?? []);
    return {
      state: async (): Promise<LayoutState> => {
        const v = await venueRow();
        const events = await tx
          .select({ id: event.id, openAt: event.openAt, status: event.status })
          .from(event)
          .where(and(eq(event.productionId, p.id), eq(event.promoterId, tenantId)))
          .orderBy(asc(event.id));
        return {
          production: { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview as Production['saleReview'], saleApprovedAt: p.saleApprovedAt },
          venue: v ? { id: v.id, layoutVersion: v.layoutVersion, versionSeq: v.versionSeq, publishedVersion: v.publishedVersion, pending: pendingOf(v), templateVenueId: v.templateVenueId } : null,
          rounds: [
            ...events.map((e) => ({ eventId: e.id, openAt: e.openAt, cancelled: e.status === 'CANCELLED', pending: false })),
            ...added().map((e) => ({ eventId: e.eventId, openAt: new Date(e.openAt), cancelled: false, pending: true })),
          ],
        };
      },
      rowLayout: async () => (await readRowLayout(tx, vid, tenantId))?.doc,
      rowSeatIds: async () => new Set((await tx.select({ k: seat.seatKey }).from(seat).where(and(eq(seat.venueId, vid), eq(seat.promoterId, tenantId)))).map((r) => String(r.k))),
      reserveVersion: async () => {
        const v = await venueRow();
        if (!v) {
          await tx.insert(venue).values({ id: vid, kind: 'LAYOUT', promoterId: tenantId, layoutVersion: 0, versionSeq: 1 });
          return 1;
        }
        const next = v.versionSeq + 1;
        await tx.update(venue).set({ versionSeq: next }).where(and(eq(venue.id, vid), eq(venue.promoterId, tenantId)));
        return next;
      },
      saveRows: async (doc, version, published) => {
        await tx.delete(seat).where(and(eq(seat.venueId, vid), eq(seat.promoterId, tenantId)));
        await tx.delete(section).where(and(eq(section.venueId, vid), eq(section.promoterId, tenantId)));
        await tx.delete(priceTier).where(and(eq(priceTier.venueId, vid), eq(priceTier.promoterId, tenantId)));
        if (doc.priceTiers.length > 0) await tx.insert(priceTier).values(doc.priceTiers.map((t, i) => ({ venueId: vid, tierId: t.tierId, promoterId: tenantId, name: t.name, price: t.price, displayOrder: i })));
        if (doc.sections.length > 0) {
          await tx.insert(section).values(
            doc.sections.map((s, i) => ({
              venueId: vid,
              sectionKey: s.sectionId,
              promoterId: tenantId,
              sortOrder: i,
              seatIndexFrom: s.seatIndexRange?.from ?? null,
              seatIndexTo: s.seatIndexRange?.to ?? null,
              name: s.name,
              level: s.level ?? null,
              shape: s.shape.points,
              editorMeta: { tool: s.shape.kind, ...opt('shapeName', s.shape.name), ...opt('fillRule', s.fillRule) },
              labelX: s.label?.x ?? null,
              labelY: s.label?.y ?? null,
              defaultTier: s.tierId ?? null,
              gateZone: s.gateZone ?? null,
            })),
          );
        }
        const rows = doc.sections.flatMap((s) =>
          s.seats.map((x) => ({
            venueId: vid,
            seatKey: x.seatId,
            sectionKey: s.sectionId,
            promoterId: tenantId,
            seatIndex: x.index,
            rowLabel: x.row,
            number: x.number,
            tierId: x.tierId ?? null,
            unavailable: x.unavailable === true,
            wheelchair: x.wheelchair === true,
            gateZone: x.gateZone ?? null,
            x: x.x,
            y: x.y,
          })),
        );
        for (let i = 0; i < rows.length; i += SEAT_CHUNK) await tx.insert(seat).values(rows.slice(i, i + SEAT_CHUNK));
        await tx
          .update(venue)
          .set({ canvasWidth: doc.canvas.width, canvasHeight: doc.canvas.height, stageShapes: doc.stage, layoutVersion: version, publishedVersion: published ? version : null, pendingLayout: null, templateVenueId: doc.templateVenueId ?? null })
          .where(and(eq(venue.id, vid), eq(venue.promoterId, tenantId)));
      },
      savePending: async (doc, version, saleReview, staged) => {
        await tx
          .update(venue)
          .set({ pendingLayout: { version, doc, staged } })
          .where(and(eq(venue.id, vid), eq(venue.promoterId, tenantId)));
        if (saleReview !== p.saleReview) await tx.update(production).set({ saleReview }).where(and(eq(production.id, p.id), eq(production.promoterId, tenantId)));
      },
      linkRounds: async () => {
        await tx
          .update(event)
          .set({ venueId: vid })
          .where(and(eq(event.productionId, p.id), eq(event.promoterId, tenantId)));
        const list = added();
        if (list.some((e) => e.venueId !== vid)) {
          const rev = (p.pendingRevision ?? {}) as Record<string, unknown>;
          await tx
            .update(production)
            .set({ pendingRevision: { ...rev, addedEvents: list.map((e) => ({ ...e, venueId: vid })) } })
            .where(and(eq(production.id, p.id), eq(production.promoterId, tenantId)));
        }
      },
      templateOk: async (id) => {
        if (!UUID.test(id)) return false;
        const [t] = await tx
          .select({ id: venue.id })
          .from(venue)
          .where(and(eq(venue.id, id), eq(venue.kind, 'TEMPLATE'), eq(venue.published, true)));
        return t !== undefined;
      },
    };
  }
}
