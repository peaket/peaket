// Drizzle 저장소: 회차 → 공연 → 판매자 읽기, 공연 등록·회차 더하기(한 번만 하는 쓰기), 찜(같은 core 논리 DB, docs/data.md ②).
// 값은 빌더로만 넘긴다(ASVS v5.0.0-1.2.4). 등록 쓰기는 멱등 기록 → 판정·쓰기를 한 트랜잭션에 한다(docs/api/guidelines.md §4, ADR-0198).
// 오픈 간격은 공개 중인 공연과만 견주고 새 등록은 DRAFT라, 동시에 온 두 등록이 서로를 놓쳐도 공개 전 판매 승인(LCH-080)이 다시 본다. 그래서 전역 잠금을 두지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, DATABASE, type Database, type DbTransaction, IdempotencyStore } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DescriptionDoc } from '../../domain/description.js';
import type { CatalogRepository, EventSummaryRow, LayoutPreview, MemberList, NewProduction, ProductionForUpdate, RegistrationTx, RequestOnce, NameEntry, PlaceNameEntry, SaleEligibilityEvent } from '../../domain/ports.js';
import { MAX_ARTISTS, MAX_PUBLIC_ROUNDS } from '../../domain/event-detail.js';
import { type EventStatus, type Genre, isPublic, SALE_END_BEFORE_START_MS, type SaleReview } from '../../domain/production.js';
import type { EventDraft, PendingEvent } from '../../domain/registration.js';
import { destroyTime, lockTime } from '../../domain/sale-eligibility.js';
import { readLayoutFiles } from './layout-rows.js';
import { artist, event, place, priceTier, production, productionArtist, productionImage, promoter, saleEligibilityList, saleEligibilityMember, searchAlias, wish } from './schema.js';

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
    const [artists, rounds, images, tiers] = await Promise.all([
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
      // 포스터 하나와 상세 이미지 열 장까지(ADR-0257 결정 3)
      this.db.db
        .select({ id: productionImage.id, kind: productionImage.kind, alt: productionImage.alt, order: productionImage.displayOrder })
        .from(productionImage)
        .where(eq(productionImage.productionId, r.p.id))
        .orderBy(productionImage.kind, productionImage.displayOrder)
        .limit(11),
      // 회차 배치본의 가격 등급 행(마지막 승인 내용, 보이는 순서). 재승인 대기 가격(venue.pending_layout)은 읽지 않는다(ADR-0260 결정 12)
      r.e.venueId
        ? this.db.db
            .select({ tierId: priceTier.tierId, name: priceTier.name, price: priceTier.price })
            .from(priceTier)
            // 판매자 조건도 넣는다(묶음 외래키가 막지만 조회가 그 하나에 기대지 않게, 리뷰 S1)
            .where(and(eq(priceTier.venueId, r.e.venueId), eq(priceTier.promoterId, r.e.promoterId)))
            .orderBy(asc(priceTier.displayOrder))
        : Promise.resolve([]),
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
      production: {
        id: r.p.id,
        promoterId: r.p.promoterId,
        placeId: r.p.placeId,
        title: r.p.title,
        genre: r.p.genre as Genre,
        saleReview: r.p.saleReview as SaleReview,
        saleApprovedAt: r.p.saleApprovedAt,
        ageRating: r.p.ageRating,
        runningMinutes: r.p.runningMinutes,
        description: r.p.description,
        descriptionDoc: r.p.descriptionDoc as DescriptionDoc | null,
        // 공개본(마지막 승인 내용)의 규칙. 재승인 대기 변경분(pending_revision.salePolicy)은 읽지 않는다(ADR-0261 결정 5)
        salePolicy: Array.isArray(r.p.salePolicy) ? (r.p.salePolicy as SalePolicyRule[]) : [],
      },
      sellerName: r.s.legalName,
      seller: { legalName: r.s.legalName, representative: r.s.representative, address: r.s.address, phone: r.s.phone, email: r.s.email, businessRegNo: r.s.businessRegNo, mailOrderReportNo: r.s.mailOrderReportNo, exemptionBasis: r.s.exemptionBasis },
      place: r.place ? { id: r.place.id, name: r.place.name, address: r.place.address } : null,
      artists,
      rounds: (rounds.some((x) => x.id === self.id) ? rounds : [...rounds, self]).map((x) => ({ ...x, status: x.status as EventStatus })),
      images: images.map((i) => ({ ...i, kind: i.kind as 'POSTER' | 'DETAIL' })),
      priceTiers: tiers,
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
        // 한 공연의 회차는 모두 같은 배치본이다. 배치본을 잇는 중(첫 저장의 두 트랜잭션 사이)에 더한 회차가 비어 있을 수 있어 찬 값을 읽는다
        const [v] = await tx
          .select({ venueId: event.venueId })
          .from(event)
          .where(and(eq(event.productionId, id), isNotNull(event.venueId)))
          .limit(1);
        const rev = (p.pendingRevision ?? {}) as { addedEvents?: StoredPendingEvent[]; salePolicy?: unknown };
        const added = (rev.addedEvents ?? []).map(fromStored);
        // 지금 고치는 규칙(재승인 대기 변경분이 있으면 그것). 회차 더하기가 1인 한도를 규칙 한도와 견준다(리뷰 A5)
        const rules = (Array.isArray(rev.salePolicy) ? rev.salePolicy : Array.isArray(p.salePolicy) ? p.salePolicy : []) as SalePolicyRule[];
        return { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview as SaleReview, saleApprovedAt: p.saleApprovedAt, venueId: v?.venueId ?? null, pendingEvents: added, rules };
      },
      insertEvent: async (productionId, promoterId, venueId, e) => {
        await tx.insert(event).values(eventRow(productionId, promoterId, venueId, e));
      },
      layoutFiles: (venueId, tenantId) => readLayoutFiles(tx, venueId, tenantId),
      savePending: async (productionId, events, saleReview) => {
        const added = JSON.stringify(events.map(toStored));
        await tx
          .update(production)
          .set({ saleReview, pendingRevision: sql`coalesce(${production.pendingRevision}, '{}'::jsonb) || jsonb_build_object('addedEvents', ${added}::jsonb)` })
          .where(eq(production.id, productionId));
      },
      // 회차 행과 공개본 규칙으로 잠금·파기 시각을 다시 계산하고 새 사본 판을 매긴다(사본의 회차·수명이 바뀐다, 리뷰 H1). 테넌트는 트랜잭션의 행 보안과 공연 조건이 함께 막는다
      refreshEligibility: async (productionId, now) => {
        const lists = await tx.select().from(saleEligibilityList).where(eq(saleEligibilityList.productionId, productionId));
        if (lists.length === 0) return;
        const rounds = (await tx.select({ eventId: event.id, startsAt: event.startsAt, openAt: event.openAt, status: event.status }).from(event).where(eq(event.productionId, productionId))).map((r) => ({ ...r, status: r.status as EventStatus }));
        const [p] = await tx.select({ salePolicy: production.salePolicy }).from(production).where(eq(production.id, productionId));
        const rules = (Array.isArray(p?.salePolicy) ? p.salePolicy : []) as SalePolicyRule[];
        const due = destroyTime(rounds);
        for (const l of lists) {
          await tx
            .update(saleEligibilityList)
            .set({ destroyDueAt: due, lockedAt: lockTime(rules, l.key, l.lockedAt, now, rounds), copySeq: sql`nextval('sale_eligibility_copy_seq')` })
            .where(and(eq(saleEligibilityList.id, l.id), eq(saleEligibilityList.productionId, productionId)));
        }
      },
    };
  }

  async findSaleEligibilityEvent(eventId: string): Promise<SaleEligibilityEvent | undefined> {
    if (!UUID.test(eventId)) return undefined;
    // 쿼리 하나: 회차·공연의 필요한 칸과 배치본 등급 ID(마지막 승인 내용, 보이는 순서). 공개 요약 전체 조회를 쓰지 않는다(리뷰 C3, docs/verification.md §4.1)
    const tiers = sql<string[]>`coalesce((select array_agg(${priceTier.tierId} order by ${priceTier.displayOrder}) from ${priceTier} where ${priceTier.venueId} = ${event.venueId} and ${priceTier.promoterId} = ${event.promoterId}), '{}')`;
    const [r] = await this.db.db
      .select({ eventId: event.id, productionId: event.productionId, openAt: event.openAt, startsAt: event.startsAt, perPersonLimit: event.perPersonLimit, saleReview: production.saleReview, saleApprovedAt: production.saleApprovedAt, salePolicy: production.salePolicy, grades: tiers })
      .from(event)
      .innerJoin(production, eq(production.id, event.productionId))
      .where(eq(event.id, eventId))
      .limit(1);
    if (!r) return undefined;
    return { ...r, saleReview: r.saleReview as SaleReview, salePolicy: Array.isArray(r.salePolicy) ? (r.salePolicy as SalePolicyRule[]) : [], grades: r.grades ?? [] };
  }

  async memberLists(productionId: string, accountId: string, now: Date): Promise<MemberList[]> {
    if (!UUID.test(productionId) || !UUID.test(accountId)) return [];
    // 공연의 명단(10개 [가정]까지)에서 그 계정의 구성원 행을 기본 키로 찾는다. 파기 시각이 지난 명단은 뺀다(정비가 아직 지우지 않았어도)
    return this.db.db
      .select({ key: saleEligibilityList.key, name: saleEligibilityList.name, destroyDueAt: saleEligibilityList.destroyDueAt })
      .from(saleEligibilityList)
      .innerJoin(saleEligibilityMember, and(eq(saleEligibilityMember.listId, saleEligibilityList.id), eq(saleEligibilityMember.accountId, accountId)))
      .where(and(eq(saleEligibilityList.productionId, productionId), gt(saleEligibilityList.destroyDueAt, now)))
      .orderBy(asc(saleEligibilityList.key));
  }

  async layoutFilesFor(productionId: string, tenantId: string): Promise<LayoutPreview | undefined> {
    if (!UUID.test(productionId)) return undefined;
    return this.partnerDb.transaction(
      async (tx) => {
        const [p] = await tx.select({ saleReview: production.saleReview, approvedAt: production.saleApprovedAt }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId)));
        if (!p) return undefined;
        const [v] = await tx
          .select({ venueId: event.venueId })
          .from(event)
          .where(and(eq(event.productionId, productionId), isNotNull(event.venueId)))
          .limit(1);
        const venueId = v?.venueId ?? null;
        return { venueId, approvedBefore: p.approvedAt !== null, suspended: p.saleReview === 'SUSPENDED', files: venueId ? await readLayoutFiles(tx, venueId, tenantId) : [] };
      },
      { tenantId, isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
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
