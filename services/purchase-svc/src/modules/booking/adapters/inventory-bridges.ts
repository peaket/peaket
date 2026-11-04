// booking 포트를 inventory의 좌석맵 판·구매 세션에 잇는 어댑터(BUILD_ORDER PRF-161). inventory 공개 면을 가져오지 않고
// 필요한 메서드 모양만 받는다(조립은 app.module.ts·main.ts가 LayoutSeatMap·StoredPurchaseSessions·RedisPurchaseSessionStore를 넘긴다).
import {
  OrderSeatStoreUnavailable,
  type OrderSessions,
  type OrderSessionView,
  type SaleConfig,
  type SaleConfigs,
  type SeatSlotRead,
  type SeatSlotReads,
} from '../domain/ports.js';

/** inventory SeatMap.config의 필요한 칸(EventSeatConfig의 saleEndsAtMs·tierPrices) */
export interface SaleConfigSource {
  config(eventId: string): Promise<{ readonly saleEndsAtMs: number; readonly tierPrices?: Readonly<Record<string, number>> } | undefined>;
}

/** SaleConfigs의 좌석맵 판 구현: config가 없으면 undefined, tierPrices가 없으면 빈 객체. 던지지 않는다(읽기 실패는 undefined) */
export class SeatMapSaleConfigs implements SaleConfigs {
  constructor(private readonly source: SaleConfigSource) {}

  async get(eventId: string): Promise<SaleConfig | undefined> {
    let c: Awaited<ReturnType<SaleConfigSource['config']>>;
    try {
      c = await this.source.config(eventId);
    } catch {
      // 판을 읽지 못했으면 판이 없는 것과 같게 본다(쓰임새가 503 seat-store-unavailable)
      return undefined;
    }
    if (!c) return undefined;
    return { saleEndsAtMs: c.saleEndsAtMs, tierPrices: c.tierPrices ?? NO_PRICES };
  }
}

/** 판 파일에 tierPrices가 없을 때의 빈 가격 표(얼린 것, 프로토타입 없음) */
const NO_PRICES: Readonly<Record<string, number>> = Object.freeze(Object.create(null) as Record<string, number>);

/** inventory의 구매 세션 읽기(PurchaseSessions.get, 운영 StoredPurchaseSessions)와 저장소(PurchaseSessionStore.setPaying, 운영 RedisPurchaseSessionStore)의 모양 */
export interface PurchaseSessionSource {
  sessions: { get(sessionId: string): Promise<OrderSessionView | undefined> };
  store: { setPaying(jti: string, paying: boolean, o?: { deadlineMs?: number }): Promise<boolean> };
}

/**
 * OrderSessions의 구매 세션 구현: get은 source.sessions.get 그대로, markPaying은 source.store.setPaying(jti, true, o).
 * inventory가 던지는 좌석 Redis 장애(SeatStoreUnavailable, 이름으로 가른다)는 OrderSeatStoreUnavailable로 바꿔 던진다
 */
export class InventoryOrderSessions implements OrderSessions {
  constructor(private readonly source: PurchaseSessionSource) {}

  async get(sessionId: string): Promise<OrderSessionView | undefined> {
    try {
      const s = await this.source.sessions.get(sessionId);
      return s ? { sessionId: s.sessionId, accountId: s.accountId, eventId: s.eventId, journeyId: s.journeyId } : undefined;
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }

  async markPaying(sessionId: string, o?: { deadlineMs?: number }): Promise<boolean> {
    try {
      return await this.source.store.setPaying(sessionId, true, o);
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }
}

/** inventory의 회차 슬롯 읽기(SeatSlotReader.read, 운영 RedisSeatSlots·시험 MemorySeatSlots)의 모양(BUILD_ORDER PRF-162) */
export interface SeatSlotSource {
  read(eventId: string, o?: { deadlineMs?: number }): Promise<SeatSlotRead>;
}

/**
 * SeatSlotReads의 회차 슬롯 구현: source.read(eventId, o) 그대로. inventory가 던지는 좌석 Redis 장애(SeatStoreUnavailable, 이름으로 가른다)는
 * OrderSeatStoreUnavailable로 바꿔 던지고, 그 밖(망가진 세대 키·WRONGTYPE·RangeError)은 그대로 던진다(BUILD_ORDER PRF-162)
 */
export class InventorySeatSlots implements SeatSlotReads {
  constructor(private readonly source: SeatSlotSource) {}

  async read(eventId: string, o?: { deadlineMs?: number }): Promise<SeatSlotRead> {
    try {
      return await this.source.read(eventId, o);
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }
}

/** inventory의 좌석 Redis 장애(SeatStoreUnavailable. 이름으로 가른다, inventory를 가져오지 않으려고)는 OrderSeatStoreUnavailable로, 그 밖은 그대로 */
function seatStoreErrorOf(e: unknown): unknown {
  return e instanceof Error && e.name === 'SeatStoreUnavailable' ? new OrderSeatStoreUnavailable(e) : e;
}
