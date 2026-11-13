// 메모리 저장소(시험·로컬). 운영은 Drizzle 저장소다. 등록 쓰기는 fn이 끝난 뒤에만 반영해(던지면 버린다) DB 트랜잭션과 같게 답한다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import type { CatalogRepository, NameEntry, PlaceNameEntry, EventPublicFields, EventSummaryRow, LayoutFile, LayoutPreview, MemberList, NewProduction, ProductionForUpdate, ProductionPublicFields, RegistrationTx, RequestOnce, SaleEligibilityEvent } from '../domain/ports.js';
import { type CatalogEvent, type EventSaleState, isPublic, type Production } from '../domain/production.js';
import type { PartnerProductionMedia, ProductionImageTx } from '../domain/media-ports.js';
import type { ProductionImageRow } from '../domain/production-image.js';
import type { EventDraft, PendingEvent } from '../domain/registration.js';
import { destroyTime, lockTime } from '../domain/sale-eligibility.js';
import type { EventEditable, StoredList } from '../domain/sale-ports.js';
import type { LayoutDoc } from '../domain/seatmap-layout.js';

/** 공연 하나의 배치본(메모리, ADR-0260): 판 차례·행 판·대기 판·복제한 틀 */
export interface MemoryLayout {
  venueId: string;
  versionSeq: number;
  rows: { version: number; doc: LayoutDoc } | null;
  /** 행 판을 공개 위치에 게시했으면 그 판 */
  publishedVersion: number | null;
  pending: { version: number; doc: LayoutDoc; staged: boolean } | null;
  templateVenueId: string | null;
}

/** 공연 하나의 판매 정책 규칙(메모리, ADR-0261 결정 1·2) */
export interface MemorySalePolicy {
  /** production.sale_policy(공개본) */
  rules: SalePolicyRule[];
  version: number;
  /** pending_revision.salePolicy */
  pending?: SalePolicyRule[];
}

/** 판매 자격 명단 하나(메모리). 구성원은 계정 ID 집합이다 */
export interface MemorySaleList extends StoredList {
  productionId: string;
  promoterId: string;
  fileSha256: Uint8Array;
  uploadedBy: string;
  members: Set<string>;
}

export class MemoryCatalogRepository implements CatalogRepository {
  readonly productions = new Map<string, Production>();
  readonly events = new Map<string, CatalogEvent>();
  /** 회차 ID → 판매 상태(시험이 넣는다. 없으면 시각으로 UPCOMING·ON_SALE·ENDED를 계산한다) */
  readonly saleStates = new Map<string, EventSaleState>();
  /** 판매자(promoter) ID → 상호. 판매자 행이 있다는 뜻이기도 하다 */
  readonly sellerNames = new Map<string, string>();
  /** 회차 ID → 공연 상세의 나머지 칸(시험이 넣는다. 없으면 기본값) */
  readonly details = new Map<string, Partial<Pick<EventSummaryRow, 'place' | 'artists'>> & { event?: Partial<EventPublicFields>; production?: Partial<ProductionPublicFields>; seller?: Partial<EventSummaryRow['seller']> }>();
  /** 찾기 목록(시험이 넣는다) */
  artistNames: NameEntry[] = [];
  placeNames: PlaceNameEntry[] = [];
  readonly places = new Set<string>();
  readonly artists = new Set<string>();
  /** 등록으로 넣은 공연의 나머지 칸(시험이 들여다본다) */
  readonly registrations = new Map<string, NewProduction>();
  /** 회차 ID → 등록 입력(정렬 설정·1인 한도 등) */
  readonly eventDrafts = new Map<string, EventDraft>();
  readonly pending = new Map<string, PendingEvent[]>();
  /** 계정 → (공연 → 처음 찜한 시각) */
  readonly wishes = new Map<string, Map<string, Date>>();
  /** 공연 이미지 행(이미지 ID → 행) */
  readonly images = new Map<string, ProductionImageRow>();
  /** 공연 ID → 배치본(메모리 배치본 저장소가 쓴다) */
  readonly layouts = new Map<string, MemoryLayout>();
  /** 공연장 틀(TEMPLATE) ID → 판 0 초안과 공개 표시(시험이 넣는다) */
  readonly templates = new Map<string, { doc: LayoutDoc; published: boolean }>();
  /** 공연 ID → 판매 정책 규칙(없으면 규칙 없음·판 1) */
  readonly salePolicies = new Map<string, MemorySalePolicy>();
  /** 회차 ID → 회차 고치기 판(없으면 1) */
  readonly eventVersions = new Map<string, number>();
  /** 회차 ID → 판매 승인 때 정한 규모(ADR-0078 규모 올리기) */
  readonly eventScales = new Map<string, 'LARGE' | 'MEDIUM' | 'SMALL'>();
  /** 공연 ID → pending_revision.eventChanges */
  readonly eventChanges = new Map<string, Record<string, Partial<EventEditable>>>();
  /** 명단 ID → 판매 자격 명단 */
  readonly saleLists = new Map<string, MemorySaleList>();
  /** 지운 명단의 사본 지우기 기록(리뷰 S1) */
  readonly saleDrops: { productionId: string; promoterId: string; listKey: string; copySeq: number; createdAt: Date }[] = [];
  /** 공연 ID → 올리기 시각(시간당 횟수 한도, 리뷰 S5) */
  readonly saleUploads = new Map<string, Date[]>();
  #copySeq = 0;

  /** 사본 판(DB 순번 sale_eligibility_copy_seq와 같은 뜻) */
  nextCopySeq(): number {
    return ++this.#copySeq;
  }
  readonly #once = new Map<string, { hash: Buffer; result: string }>();
  /** 등록 쓰기를 한 줄로 세운다(시험이 늘 같은 결과를 보게) */
  #queue: Promise<unknown> = Promise.resolve();

  async listArtistNames(): Promise<NameEntry[]> {
    return this.artistNames.map((a) => ({ ...a }));
  }

  async listPlaceNames(): Promise<PlaceNameEntry[]> {
    return this.placeNames.map((a) => ({ ...a }));
  }

  async findEventSummary(eventId: string): Promise<EventSummaryRow | undefined> {
    const event = this.events.get(eventId);
    const production = event && this.productions.get(event.productionId);
    const sellerName = production && this.sellerNames.get(production.promoterId);
    if (!event || !production || sellerName === undefined) return undefined;
    const d = this.details.get(eventId);
    return {
      event: { entryOpensAt: null, endsAt: new Date(event.startsAt.getTime() + 2 * 3_600_000), reentryAllowed: false, lobbyMinutes: 10, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, ...event, ...d?.event },
      production: { ageRating: null, runningMinutes: null, description: null, descriptionDoc: null, salePolicy: this.salePolicies.get(production.id)?.rules ?? [], ...production, ...d?.production },
      sellerName,
      seller: { legalName: sellerName, representative: null, address: null, phone: null, email: null, businessRegNo: null, mailOrderReportNo: null, exemptionBasis: null, ...d?.seller },
      place: d?.place ?? null,
      artists: d?.artists ?? [],
      rounds: [...this.events.values()].filter((e) => e.productionId === event.productionId).map((e) => ({ id: e.id, startsAt: e.startsAt, openAt: e.openAt, status: e.status })),
      images: [...this.images.values()].filter((i) => i.productionId === event.productionId).map((i) => ({ id: i.id, kind: i.kind, alt: i.alt, order: i.order })),
      priceTiers: event.venueId ? ([...this.layouts.values()].find((l) => l.venueId === event.venueId)?.rows?.doc.priceTiers.map((t) => ({ ...t })) ?? []) : [],
    };
  }

  registerOnce<T>(once: RequestOnce, _tenantId: string, fn: (tx: RegistrationTx) => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => this.#registerOnce(once, fn));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #registerOnce<T>(once: RequestOnce, fn: (tx: RegistrationTx) => Promise<T>): Promise<T> {
    const scope = `${once.accountRef}\n${once.operation}\n${once.key}`;
    const hash = Buffer.from(once.requestHash);
    const seen = this.#once.get(scope);
    if (seen) {
      if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
      return JSON.parse(seen.result) as T;
    }
    const writes: (() => void)[] = [];
    const tx: RegistrationTx = {
      otherOpenTimes: async (from, to, exclude) =>
        [...this.events.values()]
          .filter((e) => {
            const p = this.productions.get(e.productionId);
            return e.productionId !== exclude && p !== undefined && isPublic(p) && e.status !== 'CANCELLED' && e.openAt >= from && e.openAt <= to;
          })
          .map((e) => e.openAt),
      placeExists: async (id) => this.places.has(id),
      existingArtists: async (ids) => ids.filter((id) => this.artists.has(id)),
      insertProduction: async (p) => {
        if (!this.sellerNames.has(p.promoterId)) throw new Error(`판매자 행이 없다(외래키): ${p.promoterId}`);
        writes.push(() => {
          this.productions.set(p.id, { id: p.id, promoterId: p.promoterId, placeId: p.placeId ?? null, title: p.title, genre: p.genre, saleReview: 'DRAFT', saleApprovedAt: null });
          this.registrations.set(p.id, p);
          for (const e of p.events) this.#putEvent(p.id, null, e);
        });
      },
      productionForUpdate: async (id, tenantId) => {
        const p = this.#forUpdate(id);
        return p && p.promoterId === tenantId ? p : undefined;
      },
      insertEvent: async (productionId, _promoterId, venueId, e) => {
        writes.push(() => this.#putEvent(productionId, venueId, e));
      },
      layoutFiles: async (venueId) => this.#layoutFiles(venueId),
      savePending: async (productionId, events, saleReview) => {
        writes.push(() => {
          this.pending.set(productionId, events);
          const p = this.productions.get(productionId);
          if (p) this.productions.set(productionId, { ...p, saleReview });
        });
      },
      refreshEligibility: async (productionId, now) => {
        writes.push(() => this.refreshEligibility(productionId, now));
      },
    };
    const value = await fn(tx);
    for (const w of writes) w();
    this.#once.set(scope, { hash, result: JSON.stringify(value) });
    return JSON.parse(JSON.stringify(value)) as T;
  }

  async layoutFilesFor(productionId: string, tenantId: string): Promise<LayoutPreview | undefined> {
    const p = this.productions.get(productionId);
    if (!p || p.promoterId !== tenantId) return undefined;
    const venueId = this.#forUpdate(productionId)?.venueId ?? null;
    return { venueId, approvedBefore: p.saleApprovedAt !== null, suspended: p.saleReview === 'SUSPENDED', files: venueId ? this.#layoutFiles(venueId) : [] };
  }

  #layoutFiles(venueId: string): LayoutFile[] {
    const l = [...this.layouts.values()].find((x) => x.venueId === venueId);
    if (!l) return [];
    return [
      ...(l.rows && l.publishedVersion === l.rows.version ? [{ version: l.rows.version, where: 'public' as const, doc: structuredClone(l.rows.doc) }] : []),
      ...(l.pending?.staged ? [{ version: l.pending.version, where: 'staging' as const, doc: structuredClone(l.pending.doc) }] : []),
    ];
  }

  #putEvent(productionId: string, venueId: string | null, e: EventDraft & { id: string }): void {
    this.events.set(e.id, { id: e.id, productionId, venueId, openAt: e.openAt, startsAt: e.startsAt, status: 'SCHEDULED' });
    this.eventDrafts.set(e.id, e);
  }

  #forUpdate(id: string): ProductionForUpdate | undefined {
    const p = this.productions.get(id);
    if (!p) return undefined;
    const venue = [...this.events.values()].find((e) => e.productionId === id && e.venueId !== null)?.venueId ?? null;
    const policy = this.salePolicies.get(id);
    return { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview, saleApprovedAt: p.saleApprovedAt, venueId: venue, pendingEvents: this.pending.get(id) ?? [], rules: policy?.pending ?? policy?.rules ?? [] };
  }

  /** 그 공연 명단의 잠금·파기 시각을 회차와 공개본 규칙으로 다시 계산하고 새 사본 판을 매긴다 */
  refreshEligibility(productionId: string, now: Date): void {
    const rounds = [...this.events.values()].filter((e) => e.productionId === productionId).map((e) => ({ eventId: e.id, startsAt: e.startsAt, openAt: e.openAt, status: e.status }));
    if (rounds.length === 0) return;
    const due = destroyTime(rounds);
    const rules = this.salePolicies.get(productionId)?.rules ?? [];
    for (const l of this.saleLists.values()) {
      if (l.productionId !== productionId) continue;
      Object.assign(l, { destroyDueAt: due, lockedAt: lockTime(rules, l.key, l.lockedAt, now, rounds), copySeq: this.nextCopySeq() });
    }
  }

  async findSaleEligibilityEvent(eventId: string): Promise<SaleEligibilityEvent | undefined> {
    const e = this.events.get(eventId);
    const p = e && this.productions.get(e.productionId);
    if (!e || !p) return undefined;
    const d = this.details.get(eventId)?.event;
    const layout = e.venueId ? [...this.layouts.values()].find((l) => l.venueId === e.venueId) : undefined;
    return {
      eventId: e.id,
      productionId: p.id,
      openAt: e.openAt,
      startsAt: e.startsAt,
      perPersonLimit: d?.perPersonLimit ?? this.eventDrafts.get(eventId)?.perPersonLimit ?? 4,
      saleReview: p.saleReview,
      saleApprovedAt: p.saleApprovedAt,
      salePolicy: this.salePolicies.get(p.id)?.rules ?? [],
      grades: layout?.rows?.doc.priceTiers.map((t) => t.tierId) ?? [],
    };
  }

  async memberLists(productionId: string, accountId: string, now: Date): Promise<MemberList[]> {
    return [...this.saleLists.values()]
      .filter((l) => l.productionId === productionId && l.members.has(accountId) && l.destroyDueAt.getTime() > now.getTime())
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((l) => ({ key: l.key, name: l.name, destroyDueAt: l.destroyDueAt }));
  }

  async putWish(accountId: string, productionId: string, now: Date, limit: number): Promise<'ok' | 'not-found' | 'limit'> {
    const p = this.productions.get(productionId);
    if (!p || !isPublic(p)) return 'not-found';
    const mine = this.wishes.get(accountId) ?? new Map<string, Date>();
    if (mine.has(productionId)) return 'ok';
    if (mine.size >= limit) return 'limit';
    mine.set(productionId, now);
    this.wishes.set(accountId, mine);
    return 'ok';
  }

  async deleteWish(accountId: string, productionId: string): Promise<void> {
    this.wishes.get(accountId)?.delete(productionId);
  }
}

/** 메모리 공연 이미지 저장소: 메모리 카탈로그의 공연·이미지 지도를 함께 쓴다. 공연마다 한 줄로 세워 잠금을 흉내 낸다 */
export class MemoryProductionMedia implements PartnerProductionMedia {
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(private readonly repo: MemoryCatalogRepository) {}

  async owns(productionId: string, tenantId: string): Promise<boolean> {
    return this.repo.productions.get(productionId)?.promoterId === tenantId;
  }

  async detailCount(productionId: string, tenantId: string): Promise<number> {
    return [...this.repo.images.values()].filter((i) => i.productionId === productionId && i.promoterId === tenantId && i.kind === 'DETAIL').length;
  }

  withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: ProductionImageTx) => Promise<T>): Promise<T | 'not-found'> {
    const prev = this.#locks.get(productionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      if (!(await this.owns(productionId, tenantId))) return 'not-found' as const;
      const writes: (() => void)[] = [];
      const mine = () => [...this.repo.images.values()].filter((i) => i.productionId === productionId);
      const tx: ProductionImageTx = {
        images: async () => mine().map((i) => ({ ...i })),
        insert: async (r) => void writes.push(() => this.repo.images.set(r.id, { ...r })),
        remove: async (id) => void writes.push(() => this.repo.images.delete(id)),
        update: async (id, patch) =>
          void writes.push(() => {
            const cur = this.repo.images.get(id);
            if (cur) this.repo.images.set(id, { ...cur, ...(patch.alt !== undefined ? { alt: patch.alt } : {}), ...(patch.order !== undefined ? { order: patch.order } : {}), version: patch.version, updatedAt: patch.updatedAt });
          }),
      };
      const value = await fn(tx);
      for (const w of writes) w();
      return value;
    });
    this.#locks.set(productionId, run.catch(() => undefined));
    return run;
  }
}
