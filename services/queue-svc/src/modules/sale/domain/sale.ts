// 회차 판매 상태 받기의 규칙 값과 포트(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', docs/data.md §3 q:{event:E}:notice, ADR-0122·0214).

/** 회차 판매 상태(docs/planning/03 §2.15) */
export type EventSaleStatus = 'UPCOMING' | 'ON_SALE' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED';

/** 받는 사건(asyncapi EventSaleChanged와 같은 모양. 계약 모양 검사는 받는 층이 한다) */
export interface SaleChangedEvent {
  eventId: string;
  status: EventSaleStatus;
  previousStatus?: EventSaleStatus;
  available: number;
  held: number;
  paying: number;
  soldOutTiers: string[];
  version: number;
  changedAt: string;
  eventKey: string;
}

/** notice에 쓰는 회차 판매 상태. UPCOMING은 대기열에서 ON_SALE과 같아 ON_SALE로 쓴다(ADR-0214 결정 2) */
export type QueueSaleState = 'ON_SALE' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED';

/** 회차 일정 사본이 없을 때 notice의 수명 [가정](ADR-0214 결정 2) */
export const SALE_STATE_FALLBACK_TTL_MS = 2 * 86_400_000;

export interface SaleChange {
  eventId: string;
  state: QueueSaleState;
  /** EventSaleChanged.version. notice의 saleVersion보다 클 때만 쓴다 */
  version: number;
  /** 매진 등급(겹침을 뺀 받은 차례) */
  soldOutTiers: string[];
  /** notice의 만료 시각(늘리기만 한다) */
  expireAtMs: number;
  /** 판이 같거나 작아 쓰지 않을 때(STALE)도 수명을 늘리나. 일정 사본이 없으면(지금 + 2일) 늘리지 않는다(같은 판을 계속 다시 내도 끝없이 밀리지 않게, HOT-010 리뷰) */
  extendOnStale: boolean;
}

/** APPLIED: 썼다(매진 판이면 그때의 seq를 soldOutLastSeq로 둠). STALE: 판 번호가 같거나 작아 그대로 둠 */
export type SaleApplyResult = { kind: 'APPLIED'; soldOutLastSeq?: number } | { kind: 'STALE' };

export const SALE_STATES = Symbol('sale.SaleStates');
/**
 * 회차 슬롯 Lua 하나로 판 번호를 견주고 쓴다. SOLD_OUT 판이면 같은 Lua에서 q:{event:E}:seq를 읽어 soldOutLastSeq에 쓴다(매진이 풀려도 지우지 않는다).
 * 제어 받는 쪽의 칸(paused·suspended·banner·version·commandId)은 건드리지 않는다. 대기열 Redis가 잠시 안 되면 QueueStoreUnavailable
 */
export interface SaleStates {
  apply(c: SaleChange): Promise<SaleApplyResult>;
}
