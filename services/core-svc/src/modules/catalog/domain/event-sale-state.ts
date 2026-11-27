// F-07-12 RV-02: 회차 판매 상태 사본(event_sale_state)과 검색·카드 판매 상태의 순수 함수.
// 정본: docs/data.md search_document·event_sale, ADR-0122(ALL_HELD), ADR-0093 결정 8(카드 판매 상태), ADR-0271(검색 읽기 모델).
// 이 파일은 프레임워크·DB를 모른다. SQL의 같은 규칙은 0055의 search_document_source_at과 맞춘다.
import type { CardSaleStatus, EventSaleState } from './production.js';
import { SALE_END_BEFORE_START_MS } from './production.js';

/** core가 받는 판매 상태 사건(EventSaleChanged에서 core가 읽는 칸). 셈 칸은 읽지 않는다 */
export interface EventSaleStatusEvent {
  eventId: string;
  status: EventSaleState;
  /** 판 번호. 1 이상이고 회차마다 늘어나기만 한다 */
  version: number;
  /** 사건이 말하는 바뀐 시각(ISO 8601). 적용 함수가 사본에 적는다 */
  changedAt: string;
}

/** 적용 결과: 썼다·늦은 판이라 버렸다·core에 없는 회차다 */
export type EventSaleApplyResult = 'applied' | 'stale' | 'unknown';

/** 회차 판매 상태 사본 저장소(소비자 처리기가 부른다) */
export interface EventSaleStateStore {
  apply(e: EventSaleStatusEvent): Promise<EventSaleApplyResult>;
}

/** search_document.sale_status가 담을 수 있는 값(공개 카드 계약의 네 값 + 내부 ALL_HELD) */
export const SEARCH_SALE_STATUSES = ['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED'] as const;
export type SearchSaleStatus = (typeof SEARCH_SALE_STATUSES)[number];

export function isEventSaleState(v: string): v is EventSaleState {
  return (SEARCH_SALE_STATUSES as readonly string[]).includes(v);
}

/** 판 번호가 지금 값보다 클 때만 쓴다(처음 쓰기는 늘 쓴다). 같은 판의 다시 내기는 상태를 바꾸지 않는다 */
export function shouldApplyEventSale(currentVersion: number | null | undefined, incomingVersion: number): boolean {
  return currentVersion === null || currentVersion === undefined || incomingVersion > currentVersion;
}

/**
 * 회차 하나의 판매 상태: 사본이 있으면 그 값, 없으면 오픈·판매 종료 시각으로 계산한다.
 * 0023의 원천 함수와 같은 차례다(오픈 전 UPCOMING, 판매 종료 뒤 ENDED, 그 밖 ON_SALE).
 */
export function effectiveEventSaleStatus(
  status: EventSaleState | null,
  event: { openAt: Date; startsAt: Date },
  at: Date,
): EventSaleState {
  if (status !== null) return status;
  if (at.getTime() < event.openAt.getTime()) return 'UPCOMING';
  if (at.getTime() >= event.startsAt.getTime() - SALE_END_BEFORE_START_MS) return 'ENDED';
  return 'ON_SALE';
}

/**
 * 공연 단위 합성(0055 search_document_source_at과 같은 규칙):
 * ① ON_SALE이 하나라도 있으면 ON_SALE ② 없고 ALL_HELD가 있으면 ALL_HELD ③ 없고 UPCOMING이 있으면 UPCOMING
 * ④ 남은 것이 SOLD_OUT뿐이면 SOLD_OUT ⑤ 그 밖은 ENDED. 회차가 없으면 ENDED다.
 */
export function searchSaleStatusOf(states: readonly EventSaleState[]): SearchSaleStatus {
  if (states.includes('ON_SALE')) return 'ON_SALE';
  if (states.includes('ALL_HELD')) return 'ALL_HELD';
  if (states.includes('UPCOMING')) return 'UPCOMING';
  if (states.includes('SOLD_OUT')) return 'SOLD_OUT';
  return 'ENDED';
}

/**
 * 공개 카드(openapi ProductionCard.saleStatus)는 네 값만 받는다. DB 사본의 ALL_HELD는 판매 중으로 접는다
 * (docs/data.md search_document.sale_status). 모르는 값은 계약을 깨지 않게 ENDED로 숨긴다.
 */
export function publicSaleStatusOf(status: string): CardSaleStatus {
  if (status === 'ALL_HELD') return 'ON_SALE';
  if (status === 'UPCOMING' || status === 'ON_SALE' || status === 'SOLD_OUT' || status === 'ENDED') return status;
  return 'ENDED';
}

/** 회차 판매 상태 줄을 공연별 배열로 묶는다. 파트너 목록의 saleStatus 필터가 회차 원값을 쓰게 한다 */
export function saleStatesByProduction(rows: readonly { productionId: string; status: EventSaleState }[]): Map<string, EventSaleState[]> {
  const out = new Map<string, EventSaleState[]>();
  for (const r of rows) {
    const list = out.get(r.productionId);
    if (list) list.push(r.status);
    else out.set(r.productionId, [r.status]);
  }
  return out;
}
