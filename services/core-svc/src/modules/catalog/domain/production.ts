// 도메인 층: 공연(회차 묶음)과 회차, 카드의 대표 회차·판매 상태(ADR-0093 결정 8, docs/data.md ② search_document.sale_status, BUILD_ORDER HOT-170 ①).
// 프레임워크·플랫폼 형을 가져오지 않는다(순수 함수).

/** 장르 정본 목록(openapi Genre, ADR-0063) */
export const GENRES = ['콘서트', '뮤지컬', '연극', '클래식', '페스티벌', '팬미팅', '기타'] as const;
export type Genre = (typeof GENRES)[number];

/** 판매 승인(POL-037, docs/planning/03 §2.14). 공연마다 하나다(ADR-0093 결정 7) */
export type SaleReview = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

export interface Production {
  id: string;
  promoterId: string;
  /** 새 공연장 요청이면 판매 승인 때 운영자가 잇기 전까지 null(ADR-0198 결정 4) */
  placeId: string | null;
  title: string;
  genre: Genre;
  saleReview: SaleReview;
  /** 마지막 판매 승인 시각. 없으면 비공개 */
  saleApprovedAt: Date | null;
}

/** 회차 상태(docs/data.md event.status) */
export type EventStatus = 'SCHEDULED' | 'CANCELLED' | 'POSTPONED';

export interface CatalogEvent {
  id: string;
  productionId: string;
  /** 공연의 배치본. 한 공연의 회차는 모두 같은 값이다(ADR-0093 결정 1). 배치본을 만들기 전에는 null(ADR-0198 결정 4) */
  venueId: string | null;
  openAt: Date;
  startsAt: Date;
  status: EventStatus;
}

/**
 * 회차의 판매 상태(purchase-svc event_sale, EventSaleChanged.status의 값, docs/planning/03 §2.15, ADR-0122). 카탈로그는 사건으로 받은 값을 쓴다.
 * UPCOMING은 오픈 전, ALL_HELD는 남은 좌석이 모두 결제 중인 일시 매진이다. 판매 일시정지·판매 중지는 판매 상태가 아니라
 * 덧씌워 보이는 표시라(§2.15) 여기에 없다. 판매 중지된 공연은 공개 자체가 닫힌다(isPublic)
 */
export const EVENT_SALE_STATES = ['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED'] as const;
export type EventSaleState = (typeof EVENT_SALE_STATES)[number];

/** 공연 카드의 판매 상태(openapi ProductionCard, search_document.sale_status) */
export type CardSaleStatus = 'UPCOMING' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED';

/** 판매 종료 = 공연 시작 − 24시간(칸 없이 계산, ADR-0064) */
export const SALE_END_BEFORE_START_MS = 24 * 60 * 60_000;
export const saleEndsAt = (e: Pick<CatalogEvent, 'startsAt'>): Date => new Date(e.startsAt.getTime() - SALE_END_BEFORE_START_MS);

/** 카드 판매 상태 계산에서 '판매 중'으로 세는 회차 상태. 일시 매진은 판매 중이다(data.md search_document.sale_status) */
const COUNTS_AS_ON_SALE: ReadonlySet<EventSaleState> = new Set(['ON_SALE', 'ALL_HELD']);

export interface EventWithSale {
  event: CatalogEvent;
  sale: EventSaleState;
}

/**
 * 대표 회차(ADR-0093 결정 8): ① 판매 중인 회차 가운데 판매 종료가 가장 이른 것 → ② 없으면 오픈 예정 회차 가운데 오픈이 가장 이른 것 →
 * ③ 없으면 매진 회차 가운데 공연 시작이 가장 이른 것 → ④ 없으면 가장 최근에 공연한 회차(공연 시작이 now 이전인 것 가운데 가장 늦은 것).
 * ④에서 아직 공연한 회차가 없으면(모든 회차가 판매 종료 뒤 공연 전, 시작 24시간 안) 곧 공연할 회차 가운데 시작이 가장 이른 것이다 [가정].
 * 취소된 회차는 고르지 않는다. 고를 회차가 없으면 undefined. 같은 값이면 회차 ID가 작은 것(결과가 늘 같게)
 */
export function representativeEvent(rows: EventWithSale[], now: Date): CatalogEvent | undefined {
  const live = rows.filter((r) => r.event.status !== 'CANCELLED');
  const tie = (a: CatalogEvent, b: CatalogEvent) => (a.id < b.id ? a : b);
  const pick = (rs: EventWithSale[], key: (e: CatalogEvent) => number, newest = false) => {
    let best: CatalogEvent | undefined;
    for (const { event } of rs) {
      if (!best) best = event;
      else {
        const d = key(event) - key(best);
        if (newest ? d > 0 : d < 0) best = event;
        else if (d === 0) best = tie(best, event);
      }
    }
    return best;
  };
  return (
    pick(live.filter((r) => COUNTS_AS_ON_SALE.has(r.sale)), (e) => saleEndsAt(e).getTime()) ??
    pick(live.filter((r) => r.sale === 'UPCOMING'), (e) => e.openAt.getTime()) ??
    pick(live.filter((r) => r.sale === 'SOLD_OUT'), (e) => e.startsAt.getTime()) ??
    pick(live.filter((r) => r.event.startsAt.getTime() <= now.getTime()), (e) => e.startsAt.getTime(), true) ??
    pick(live, (e) => e.startsAt.getTime())
  );
}

/**
 * 카드의 판매 상태(ADR-0093 결정 8): 판매 중인 회차가 하나라도 있으면 판매 중, 없고 오픈 예정 회차가 있으면 오픈 예정,
 * 남은 회차가 모두 매진이면 매진, 모두 판매 종료면 끝남이다. 취소된 회차는 세지 않는다. 남은 회차가 없으면 끝남이다
 */
export function cardSaleStatus(rows: EventWithSale[]): CardSaleStatus {
  const live = rows.filter((r) => r.event.status !== 'CANCELLED');
  if (live.some((r) => COUNTS_AS_ON_SALE.has(r.sale))) return 'ON_SALE';
  if (live.some((r) => r.sale === 'UPCOMING')) return 'UPCOMING';
  const remaining = live.filter((r) => r.sale !== 'ENDED');
  if (remaining.length > 0 && remaining.every((r) => r.sale === 'SOLD_OUT')) return 'SOLD_OUT';
  return 'ENDED';
}

/** 한 공연의 회차는 모두 같은 배치본을 쓴다(ADR-0093 결정 1). 다른 배치본의 회차를 더하려 하면 false */
export function sameVenue(events: Pick<CatalogEvent, 'venueId'>[], candidateVenueId: string): boolean {
  return events.every((e) => e.venueId === candidateVenueId);
}

/**
 * 공개되는 공연: 한 번이라도 판매 승인되었고 판매 중지가 아니다(GET /v1/events/{eventId}, docs/security/authz-matrix.md §3.5).
 * 승인 뒤 바꾼 내용의 재승인 대기·반려 중에도 마지막 승인 내용으로 공개는 이어진다(ADR-0093 결정 7).
 * 전제: production·event 행은 늘 마지막 승인 내용(공개본)이다. 승인 뒤 더하거나 바꾼 회차는 승인 때까지 production.pending_revision에만 두고
 * event 행으로 넣지 않는다(docs/data.md production.pending_revision, planning/03 §2.14). 그래서 공개 판단은 공연 단위 하나로 된다(BUILD_ORDER HOT-171)
 */
export function isPublic(p: Pick<Production, 'saleReview' | 'saleApprovedAt'>): boolean {
  return p.saleApprovedAt !== null && p.saleReview !== 'SUSPENDED';
}

/**
 * 오픈 예약을 예정대로 하는가: 판매 승인 상태일 때만이다. 승인 이력이 있어도 재승인 대기·변경 반려 중이면 공개는 이어지지만
 * 오픈 전 회차의 오픈 예약은 멈춘다(planning/03 §2.14 상태 표, d5 §6.4 '승인 뒤 중요 항목 변경'). 판매 중지도 멈춘다.
 * 대기열·구매 경로의 회차 읽기 모델이 이 값을 싣는다(BUILD_ORDER LCH-080)
 */
export function opensAsScheduled(p: Pick<Production, 'saleReview'>): boolean {
  return p.saleReview === 'APPROVED';
}
