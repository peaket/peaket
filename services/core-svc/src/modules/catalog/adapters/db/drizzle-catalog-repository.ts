// Drizzle 저장소: 회차 → 공연 → 판매자 읽기, 공연 등록·회차 더하기(한 번만 하는 쓰기), 찜(같은 core 논리 DB, docs/data.md ②).
// 값은 빌더로만 넘긴다(ASVS v5.0.0-1.2.4). 등록 쓰기는 멱등 기록 → 판정·쓰기를 한 트랜잭션에 한다(docs/api/guidelines.md §4, ADR-0198).
// 오픈 간격은 공개 중인 공연과만 견주고 새 등록은 DRAFT라, 동시에 온 두 등록이 서로를 놓쳐도 공개 전 판매 승인(LCH-080)이 다시 본다. 그래서 전역 잠금을 두지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, DATABASE, type Database, type DbTransaction, IdempotencyStore } from '@peaket/platform';
import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { DescriptionDoc } from '../../domain/description.js';
import type { CatalogRepository, EventSummaryRow, NewProduction, ProductionForUpdate, RegistrationTx, RequestOnce, NameEntry, PlaceNameEntry } from '../../domain/ports.js';
import { MAX_ARTISTS, MAX_PUBLIC_ROUNDS } from '../../domain/event-detail.js';
import { type EventStatus, type Genre, isPublic, SALE_END_BEFORE_START_MS, type SaleReview } from '../../domain/production.js';
import type { EventDraft, PendingEvent } from '../../domain/registration.js';
import { artist, event, place, production, productionArtist, promoter, searchAlias, wish } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 찜 잠금의 종류 번호(계정마다 따로 잠근다) */
const WISH_LOCK_CLASS = 7_301_171;

/** 변경분 JSON의 회차(날짜는 ISO 문자열로 둔다) */
type StoredPendingEvent = Omit<PendingEvent, 'openAt' | 'startsAt' | 'endsAt' | 'entryOpensAt' | 'addedAt'> & {
  openAt: string;
  startsAt: string;
  endsAt: string;
  entryOpensAt?: string;
  addedAt: string;
};

const toStored = ({ entryOpensAt, ...e }: PendingEvent): StoredPendingEvent => ({
  ...e,
  openAt: e.openAt.toISOString(),
  startsAt: e.startsAt.toISOString(),
  endsAt: e.endsAt.toISOString(),
  ...(entryOpensAt ? { entryOpensAt: entryOpensAt.toISOString() } : {}),
  addedAt: e.addedAt.toISOString(),
});
const fromStored = ({ entryOpensAt, ...e }: StoredPendingEvent): PendingEvent => ({
  ...e,
  openAt: new Date(e.openAt),
  startsAt: new Date(e.startsAt),
  endsAt: new Date(e.endsAt),
  ...(entryOpensAt ? { entryOpensAt: new Date(entryOpensAt) } : {}),
  addedAt: new Date(e.addedAt),
});

const eventRow = (productionId: string, promoterId: string, venueId: string | null, e: EventDraft & { id: string }) => ({
  id: e.id,
  productionId,
  promoterId,
  venueId,
  openAt: e.openAt,
  entryOpensAt: e.entryOpensAt ?? null,
  startsAt: e.startsAt,
  endsAt: e.endsAt,
  reentryAllowed: e.reentryAllowed,
  lobbyMinutes: e.lobbyMinutes,
  lobbyShuffle: e.lobbyShuffle,
  openBatch: e.openBatch,
  seatAssignment: e.seatAssignment,
  perPersonLimit: e.perPersonLimit,
});

/** 파트너 경로의 DB 연결(core_partner 사용자, ADR-0241) */
export const PARTNER_DATABASE = Symbol.for('peaket.core.partner-database');

@Injectable()
export class DrizzleCatalogRepository implements CatalogRepository {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PARTNER_DATABASE) private readonly partnerDb: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.idempotency = new IdempotencyStore({ clock: this.clock });
  }

  async listArtistNames(): Promise<NameEntry[]> {
    const [rows, aliases] = await Promise.all([this.db.db.select({ id: artist.id, name: artist.name }).from(artist), this.#aliases('ARTIST')]);
    return rows.map((r) => ({ ...r, aliases: aliases.get(r.id) ?? [] }));
  }

  async listPlaceNames(): Promise<PlaceNameEntry[]> {
    const [rows, aliases] = await Promise.all([
      this.db.db.select({ id: place.id, name: place.name, address: place.address }).from(place).where(eq(place.status, 'ACTIVE')),
      this.#aliases('PLACE'),
    ]);
    return rows.map((r) => ({ ...r, aliases: aliases.get(r.id) ?? [] }));
  }

  async #aliases(kind: 'ARTIST' | 'PLACE'): Promise<Map<string, string[]>> {
    const rows = await this.db.db
      .select({ targetId: searchAlias.targetId, alias: searchAlias.alias })
      .from(searchAlias)
      .where(and(eq(searchAlias.targetKind, kind), isNull(searchAlias.removedAt)));
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.targetId, [...(out.get(r.targetId) ?? []), r.alias]);
    return out;
  }

  async findEventSummary(eventId: string): Promise<EventSummaryRow | undefined> {
    // 회차 ID는 uuid 칸이다. 모양이 아닌 값은 DB 오류 대신 없음으로 답한다(없는 회차와 같은 404)
    if (!UUID.test(eventId)) return undefined;
    const rows = await this.db.db
      .select({ e: event, p: production, s: promoter, place })
      .from(event)
      .innerJoin(production, eq(production.id, event.productionId))
      .innerJoin(promoter, eq(promoter.id, production.promoterId))
      // 새 공연장 요청을 아직 잇지 않은 공연은 공연장이 없다
      .leftJoin(place, eq(place.id, production.placeId))
      .where(eq(event.id, eventId))
      .limit(1);
    const r = rows[0];
    if (!r) return undefined;
    const [artists, rounds] = await Promise.all([
      this.db.db
        .select({ artistId: artist.id, name: artist.name })
        .from(productionArtist)
        .innerJoin(artist, eq(artist.id, productionArtist.artistId))
        .where(eq(productionArtist.productionId, r.p.id))
        .orderBy(productionArtist.sortOrder, artist.id)
        .limit(MAX_ARTISTS),
      // 공개할 회차만 시작 순으로 읽는다(회차가 많은 공연도 상한만큼만). 이 회차는 아래에서 늘 넣는다
      this.db.db
        .select({ id: event.id, startsAt: event.startsAt, openAt: event.openAt, status: event.status })
        .from(event)
        .where(and(eq(event.productionId, r.p.id), ne(event.status, 'CANCELLED'), gte(event.startsAt, new Date(this.clock.now() + SALE_END_BEFORE_START_MS))))
        .orderBy(event.startsAt, event.id)
        .limit(MAX_PUBLIC_ROUNDS),
    ]);
    const self = { id: r.e.id, startsAt: r.e.startsAt, openAt: r.e.openAt, status: r.e.status };
    return {
      event: {
        id: r.e.id,
        productionId: r.e.productionId,
        venueId: r.e.venueId,
        openAt: r.e.openAt,
        startsAt: r.e.startsAt,
        status: r.e.status as EventStatus,
        entryOpensAt: r.e.entryOpensAt,
        endsAt: r.e.endsAt,
        reentryAllowed: r.e.reentryAllowed,
        lobbyMinutes: r.e.lobbyMinutes,
        lobbyShuffle: r.e.lobbyShuffle,
        openBatch: r.e.openBatch,
        seatAssignment: r.e.seatAssignment as 'PICK' | 'AUTO',
        perPersonLimit: r.e.perPersonLimit,
      },
      production: { id: r.p.id, promoterId: r.p.promoterId, placeId: r.p.placeId, title: r.p.title, genre: r.p.genre as Genre, saleReview: r.p.saleReview as SaleReview, saleApprovedAt: r.p.saleApprovedAt, ageRating: r.p.ageRating, runningMinutes: r.p.runningMinutes, description: r.p.description, descriptionDoc: r.p.descriptionDoc as DescriptionDoc | null },
      sellerName: r.s.legalName,
      seller: { legalName: r.s.legalName, representative: r.s.representative, address: r.s.address, phone: r.s.phone, email: r.s.email, businessRegNo: r.s.businessRegNo, mailOrderReportNo: r.s.mailOrderReportNo, exemptionBasis: r.s.exemptionBasis },
      place: r.place ? { id: r.place.id, name: r.place.name, address: r.place.address } : null,
      artists,
      rounds: (rounds.some((x) => x.id === self.id) ? rounds : [...rounds, self]).map((x) => ({ ...x, status: x.status as EventStatus })),
    };
  }

  registerOnce<T>(once: RequestOnce, tenantId: string, fn: (tx: RegistrationTx) => Promise<T>): Promise<T> {
    // 파트너 전용 DB 사용자로 접속하고 트랜잭션에 테넌트를 건다(SET LOCAL app.tenant_id). 조회 조건이 빠져도 행 보안이 거른다(authz-matrix §5.3, ADR-0241)
    return this.partnerDb.transaction(
      (tx) =>
      this.idempotency.run(tx, once, {
        execute: async () => {
          const value = await fn(this.#tx(tx));
          return { resultRef: JSON.stringify(value), value };
        },
        replay: async (ref) => JSON.parse(ref) as T,
      }),
      { tenantId },
    );
  }

  #tx(tx: DbTransaction): RegistrationTx {
    return {
      // 공개 중인 다른 공연의 회차만 본다(승인 전 공연은 남을 막지 않고 드러나지도 않는다, ADR-0198 결정 2)
      otherOpenTimes: async (from, to, exclude) => {
        // 다른 파트너의 회차는 행 보안으로 볼 수 없어 오픈 시각 한 칸만 주는 함수로 읽는다(ADR-0241 결정 5)
        const r = await tx.execute(sql`select open_at from public_open_times(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, ${exclude}::uuid)`);
        return (r.rows as Array<{ open_at: Date | string }>).map((x) => new Date(x.open_at));
      },
      // 닫은 공연장(CLOSED)은 고를 수 없다 [가정]
      placeExists: async (id) => (await tx.select({ id: place.id }).from(place).where(and(eq(place.id, id), eq(place.status, 'ACTIVE'))).limit(1)).length > 0,
      existingArtists: async (ids) => (await tx.select({ id: artist.id }).from(artist).where(inArray(artist.id, ids))).map((r) => r.id),
      insertProduction: async (p: NewProduction) => {
        await tx.insert(production).values({
          id: p.id,
          promoterId: p.promoterId,
          placeId: p.placeId ?? null,
          requestedPlace: p.requestedPlace ?? null,
          requestedArtists: p.requestedArtists.length > 0 ? p.requestedArtists : null,
          title: p.title,
          genre: p.genre,
          ageRating: p.ageRating ?? null,
          runningMinutes: p.runningMinutes ?? null,
          description: p.description ?? null,
          descriptionDoc: p.descriptionDoc ?? null,
          kopisFields: p.kopisFields ?? null,
        });
        if (p.artists.length > 0) await tx.insert(productionArtist).values(p.artists.map((a) => ({ productionId: p.id, artistId: a.artistId, sortOrder: a.sortOrder })));
        if (p.aliases.length > 0) {
          await tx.insert(searchAlias).values(p.aliases.map((a) => ({ id: a.id, targetKind: 'PRODUCTION', targetId: p.id, alias: a.alias, source: 'PARTNER', createdBy: p.createdBy })));
        }
        await tx.insert(event).values(p.events.map((e) => eventRow(p.id, p.promoterId, null, e)));
      },
      // 범위 인자(테넌트)로 찾고, 찜·회차 넣기의 외래키 잠금(KEY SHARE)과 부딪치지 않는 NO KEY UPDATE로 잠근다
      productionForUpdate: async (id, tenantId): Promise<ProductionForUpdate | undefined> => {
        if (!UUID.test(id)) return undefined;
        const [p] = await tx
          .select()
          .from(production)
          .where(and(eq(production.id, id), eq(production.promoterId, tenantId)))
          .for('no key update');
        if (!p) return undefined;
        const [v] = await tx.select({ venueId: event.venueId }).from(event).where(eq(event.productionId, id)).limit(1);
        const added = ((p.pendingRevision as { addedEvents?: StoredPendingEvent[] } | null)?.addedEvents ?? []).map(fromStored);
        return { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview as SaleReview, saleApprovedAt: p.saleApprovedAt, venueId: v?.venueId ?? null, pendingEvents: added };
      },
      insertEvent: async (productionId, promoterId, venueId, e) => {
        await tx.insert(event).values(eventRow(productionId, promoterId, venueId, e));
      },
      savePending: async (productionId, events, saleReview) => {
        const added = JSON.stringify(events.map(toStored));
        await tx
          .update(production)
          .set({ saleReview, pendingRevision: sql`coalesce(${production.pendingRevision}, '{}'::jsonb) || jsonb_build_object('addedEvents', ${added}::jsonb)` })
          .where(eq(production.id, productionId));
      },
    };
  }

  async putWish(accountId: string, productionId: string, now: Date, limit: number): Promise<'ok' | 'not-found' | 'limit'> {
    if (!UUID.test(productionId)) return 'not-found';
    return this.db.transaction(async (tx) => {
      // 같은 계정의 찜만 줄 세운다(셈과 넣기 사이에 다른 찜이 끼어 상한을 넘지 않게)
      await tx.execute(sql`select pg_advisory_xact_lock(${WISH_LOCK_CLASS}, hashtext(${accountId}))`);
      const [p] = await tx.select({ saleReview: production.saleReview, saleApprovedAt: production.saleApprovedAt }).from(production).where(eq(production.id, productionId)).limit(1);
      if (!p || !isPublic({ saleReview: p.saleReview as SaleReview, saleApprovedAt: p.saleApprovedAt })) return 'not-found';
      const [had] = await tx.select({ n: sql<number>`1` }).from(wish).where(and(eq(wish.accountId, accountId), eq(wish.productionId, productionId))).limit(1);
      if (had) return 'ok';
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(wish).where(eq(wish.accountId, accountId));
      if (n >= limit) return 'limit';
      await tx.insert(wish).values({ accountId, productionId, createdAt: now });
      return 'ok';
    });
  }

  async deleteWish(accountId: string, productionId: string): Promise<void> {
    if (!UUID.test(productionId)) return;
    await this.db.db.delete(wish).where(and(eq(wish.accountId, accountId), eq(wish.productionId, productionId)));
  }
}
