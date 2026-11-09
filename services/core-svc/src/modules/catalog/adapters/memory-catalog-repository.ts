// 메모리 저장소(시험·로컬). 운영은 Drizzle 저장소다. 등록 쓰기는 fn이 끝난 뒤에만 반영해(던지면 버린다) DB 트랜잭션과 같게 답한다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused } from '@peaket/platform';
import type { CatalogRepository, NameEntry, PlaceNameEntry, EventPublicFields, EventSummaryRow, NewProduction, ProductionForUpdate, ProductionPublicFields, RegistrationTx, RequestOnce } from '../domain/ports.js';
import { type CatalogEvent, isPublic, type Production } from '../domain/production.js';
import type { EventDraft, PendingEvent } from '../domain/registration.js';

export class MemoryCatalogRepository implements CatalogRepository {
  readonly productions = new Map<string, Production>();
  readonly events = new Map<string, CatalogEvent>();
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
      production: { ageRating: null, runningMinutes: null, description: null, descriptionDoc: null, ...production, ...d?.production },
      sellerName,
      seller: { legalName: sellerName, representative: null, address: null, phone: null, email: null, businessRegNo: null, mailOrderReportNo: null, exemptionBasis: null, ...d?.seller },
      place: d?.place ?? null,
      artists: d?.artists ?? [],
      rounds: [...this.events.values()].filter((e) => e.productionId === event.productionId).map((e) => ({ id: e.id, startsAt: e.startsAt, openAt: e.openAt, status: e.status })),
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
      savePending: async (productionId, events, saleReview) => {
        writes.push(() => {
          this.pending.set(productionId, events);
          const p = this.productions.get(productionId);
          if (p) this.productions.set(productionId, { ...p, saleReview });
        });
      },
    };
    const value = await fn(tx);
    for (const w of writes) w();
    this.#once.set(scope, { hash, result: JSON.stringify(value) });
    return JSON.parse(JSON.stringify(value)) as T;
  }

  #putEvent(productionId: string, venueId: string | null, e: EventDraft & { id: string }): void {
    this.events.set(e.id, { id: e.id, productionId, venueId, openAt: e.openAt, startsAt: e.startsAt, status: 'SCHEDULED' });
    this.eventDrafts.set(e.id, e);
  }

  #forUpdate(id: string): ProductionForUpdate | undefined {
    const p = this.productions.get(id);
    if (!p) return undefined;
    const venue = [...this.events.values()].find((e) => e.productionId === id)?.venueId ?? null;
    return { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview, saleApprovedAt: p.saleApprovedAt, venueId: venue, pendingEvents: this.pending.get(id) ?? [] };
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
