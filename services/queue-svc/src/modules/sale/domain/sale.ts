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
  /** 셈(available·held·paying·avgTicketsPerOrder)을 한 시각. 셈을 실은 사건(판이 바뀔 때와 같은 판의 다시 내기)에만 있다(ADR-0219 결정 5) */
  countedAt?: string;
  /** 그 회차에서 결제가 끝난 주문의 평균 좌석 수(주문 100건 [가정] 이상일 때만, ADR-0219 결정 6) */
  avgTicketsPerOrder?: number;
}

/** notice에 쓰는 회차 판매 상태. UPCOMING은 대기열에서 ON_SALE과 같아 ON_SALE로 쓴다(ADR-0214 결정 2) */
export type QueueSaleState = 'ON_SALE' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED';

/** 회차 일정 사본이 없을 때 notice의 수명 [가정](ADR-0214 결정 2) */
export const SALE_STATE_FALLBACK_TTL_MS = 2 * 86_400_000;

/** 셈 시각이 queue-svc 시계보다 이만큼 넘게 앞서면 셈을 쓰지 않는다 [가정](앞선 시각 하나가 뒤의 셈을 모두 막지 않게, 신선도 30초보다 작게, ADR-0219 결정 5) */
export const SEAT_COUNT_CLOCK_SKEW_MS = 5_000;
/** 평균 구매 매수로 받는 범위(한 주문은 1~10석, openapi HoldRequest.seatIds). 밖이면 버린다 */
export const AVG_TICKETS_MIN = 1;
export const AVG_TICKETS_MAX = 10;

/** notice에 쓰는 남은 좌석 수 칸(ADR-0219 결정 5·6) */
export interface SeatCounts {
  /** 남은(가용) 좌석 = 사건의 available */
  remaining: number;
  /** 셈 시각(유닉스 밀리초) */
  countedAtMs: number;
  /** 없으면 notice의 칸을 지운다(파일은 기본값을 쓴다) */
  avgTicketsPerOrder?: number;
}

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
  /** 남은 좌석 수 칸. 판 번호가 지금 판 이상이고 셈 시각이 둔 것보다 늦을 때만 쓴다(같은 Lua) */
  counts?: SeatCounts;
}

/** APPLIED: 썼다(매진 판이면 그때의 seq를 soldOutLastSeq로 둠). STALE: 판 번호가 같거나 작아 그대로 둠 */
export type SaleApplyResult = { kind: 'APPLIED'; soldOutLastSeq?: number } | { kind: 'STALE' };

/** 저장소가 돌려주는 결과: 위 결과와 쓴 뒤 notice의 지금 판매 상태·판 번호(STALE이면 둔 값). 엣지 매진 표시를 이 판으로 맞춘다(ADR-0219 결정 2) */
export type SaleApplyOutcome = SaleApplyResult & { current: { state: string; version: number } };

export const SALE_STATES = Symbol('sale.SaleStates');
/**
 * 회차 슬롯 Lua 하나로 판 번호를 견주고 쓴다. SOLD_OUT 판이면 같은 Lua에서 q:{event:E}:seq를 읽어 soldOutLastSeq에 쓴다(매진이 풀려도 지우지 않는다).
 * 같은 Lua에서 남은 좌석 수 칸(remainingSeats·seatsAtMs·avgTicketsPerOrder)을 판 번호와 셈 시각으로 견주고 쓴다(ADR-0219).
 * 제어 받는 쪽의 칸(paused·suspended·banner·version·commandId)은 건드리지 않는다. 대기열 Redis가 잠시 안 되면 QueueStoreUnavailable
 */
export interface SaleStates {
  apply(c: SaleChange): Promise<SaleApplyOutcome>;
  /** notice의 지금 판매 상태와 판 번호(엣지 다시 맞추기가 읽는다). notice나 판이 없으면 null. 대기열 Redis가 잠시 안 되면 QueueStoreUnavailable */
  current(eventId: string): Promise<{ state: string; version: number } | null>;
}
