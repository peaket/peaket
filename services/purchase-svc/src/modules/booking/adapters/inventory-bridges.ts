// booking 포트를 inventory의 좌석맵 판·구매 세션에 잇는 어댑터(BUILD_ORDER PRF-161). inventory 공개 면을 가져오지 않고
// 필요한 메서드 모양만 받는다(조립은 app.module.ts·main.ts가 LayoutSeatMap·StoredPurchaseSessions·RedisPurchaseSessionStore를 넘긴다).
import type { Clock } from '@peaket/platform';
import {
  type OrderExpiryInventory,
  type OrderHoldExpiries,
  type OrderHoldQuery,
  type OrderPinInput,
  type OrderPinResult,
  type OrderReleaseInput,
  type OrderReleaseResult,
  OrderSeatStoreUnavailable,
  type OrderSeatPins,
  type OrderSessions,
  type OrderSessionView,
  type PaymentResultSessions,
  type SagaEventConfig,
  type SagaEventConfigs,
  type SaleConfig,
  type SaleConfigs,
  type SeatSlotRead,
  type SeatSlotReads,
} from '../domain/ports.js';

/** inventory SeatMap.config의 필요한 칸(EventSeatConfig의 saleEndsAtMs·tierPrices) */
export interface SaleConfigSource {
  config(eventId: string): Promise<
    | { readonly saleEndsAtMs: number; readonly tierPrices?: Readonly<Record<string, number>>; readonly orderName?: string; readonly entryOpensAtMs?: number; readonly virtualAccountAllowed?: boolean }
    | undefined
  >;
}

/** SaleConfigs의 좌석맵 판 구현: config가 없으면 undefined, tierPrices가 없으면 빈 객체. 던지지 않는다(읽기 실패는 undefined) */
export class SeatMapSaleConfigs implements SaleConfigs {
  constructor(private readonly source: SaleConfigSource) {}

  /** 취소 견적·Saga가 쓰는 이름(같은 값을 get으로도 준다) */
  config(eventId: string): Promise<SaleConfig | undefined> {
    return this.get(eventId);
  }

  async get(eventId: string): Promise<SaleConfig | undefined> {
    let c: Awaited<ReturnType<SaleConfigSource['config']>>;
    try {
      c = await this.source.config(eventId);
    } catch {
      // 판을 읽지 못했으면 판이 없는 것과 같게 본다(쓰임새가 503 seat-store-unavailable)
      return undefined;
    }
    if (!c) return undefined;
    return {
      saleEndsAtMs: c.saleEndsAtMs,
      tierPrices: c.tierPrices ?? NO_PRICES,
      ...(c.orderName !== undefined ? { orderName: c.orderName } : {}),
      ...(c.entryOpensAtMs !== undefined ? { entryOpensAtMs: c.entryOpensAtMs } : {}),
      ...(c.virtualAccountAllowed !== undefined ? { virtualAccountAllowed: c.virtualAccountAllowed } : {}),
    };
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

// ---- Saga 1단계의 좌석 묶기·실패 해제와 회차 설정(BUILD_ORDER PRF-165) ----

/** inventory SeatRef의 모양(좌석맵 판 resolve의 결과) */
export interface SeatRefShape {
  seatId: string;
  index: number;
  sectionId: string;
  sectionIndex: number;
  seatOffset: number;
  tierId: string;
}

/** inventory PinResult의 모양(FAILED_HOLD는 PRF-165가 Lua에 더한다) */
export type PinResultShape =
  | { kind: 'OK'; gen: number; regrabbed: number; fencingToken?: number }
  | { kind: 'NOT_READY' }
  | { kind: 'TAKEN'; seatIndex: number }
  | { kind: 'STALE_GEN'; gen: number }
  | { kind: 'QUOTA_EXCEEDED' }
  | { kind: 'FAILED_HOLD' };

/** inventory SeatPins(운영 RedisSeatStore·시험 MemorySeatStore)와 SeatMap.resolve(운영 LayoutSeatMap)의 모양 */
export interface SeatPinSource {
  pins: {
    pin(
      input: {
        eventId: string;
        accountId: string;
        purchaseSessionId: string;
        holdId: string;
        seats: readonly SeatRefShape[];
        limit: number;
        orderGen: number;
        keepUntilMs: number;
      },
      o?: { deadlineMs?: number },
    ): Promise<PinResultShape>;
    releaseFailed(
      input: { eventId: string; accountId: string; holdId: string; seats: readonly SeatRefShape[]; keepUntilMs: number },
      o?: { deadlineMs?: number },
    ): Promise<{ kind: 'OK'; released: number } | { kind: 'NOT_READY' }>;
  };
  seatMap: { resolve(eventId: string, seatIds: readonly string[]): Promise<(SeatRefShape | undefined)[]> };
}

/**
 * OrderSeatPins의 inventory 구현: 좌석 ID를 좌석맵 판 resolve로 SeatRef로 바꾸고(좌석 ID 오름차순으로 맞춘다) pin·releaseFailed를 부른 뒤
 * 결과를 주문 모습으로 바꾼다(OK → { OK, gen }, TAKEN → TAKEN(색인은 버린다), STALE_GEN → { STALE_GEN, gen }, FAILED_HOLD 그대로).
 * 좌석맵 판에 없는 좌석이 하나라도 있으면 Error(설정 오류. 좌석 Redis를 부르지 않는다). 좌석 Redis 장애는 OrderSeatStoreUnavailable로 바꿔 던진다
 */
export class InventoryOrderSeatPins implements OrderSeatPins {
  constructor(private readonly source: SeatPinSource) {}

  async pin(input: OrderPinInput, o?: { deadlineMs?: number }): Promise<OrderPinResult> {
    const seats = await this.#seatsOf(input.eventId, input.seatIds);
    let r: PinResultShape;
    try {
      r = await this.source.pins.pin(
        {
          eventId: input.eventId,
          accountId: input.accountId,
          purchaseSessionId: input.purchaseSessionId,
          holdId: input.holdId,
          seats,
          limit: input.limit,
          orderGen: input.orderGen,
          keepUntilMs: input.keepUntilMs,
        },
        ...callOptions(o),
      );
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
    switch (r.kind) {
      case 'OK':
        return { status: 'OK', gen: r.gen };
      case 'STALE_GEN':
        return { status: 'STALE_GEN', gen: r.gen };
      case 'NOT_READY':
      case 'TAKEN':
      case 'QUOTA_EXCEEDED':
      case 'FAILED_HOLD':
        return { status: r.kind };
    }
  }

  async releaseFailed(input: OrderReleaseInput, o?: { deadlineMs?: number }): Promise<OrderReleaseResult> {
    const seats = await this.#seatsOf(input.eventId, input.seatIds);
    let r: Awaited<ReturnType<SeatPinSource['pins']['releaseFailed']>>;
    try {
      r = await this.source.pins.releaseFailed({ eventId: input.eventId, accountId: input.accountId, holdId: input.holdId, seats, keepUntilMs: input.keepUntilMs }, ...callOptions(o));
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
    return r.kind === 'OK' ? { status: 'OK', released: r.released } : { status: 'NOT_READY' };
  }

  /** 좌석 ID → SeatRef(좌석 ID 오름차순, 겹친 ID는 하나로). 판에 없는 좌석이 하나라도 있으면 Error(설정 오류. 좌석 Redis를 부르지 않는다) */
  async #seatsOf(eventId: string, seatIds: readonly string[]): Promise<SeatRefShape[]> {
    const sorted = [...new Set(seatIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const refs = await this.source.seatMap.resolve(eventId, sorted);
    const missing = refs.filter((r) => r === undefined).length;
    if (missing > 0 || refs.length !== sorted.length) throw new Error(`좌석맵 판에 없는 주문 좌석이 ${missing}석 있다(회차 ${eventId})`);
    return refs as SeatRefShape[];
  }
}

/** 마감을 준 때만 둘째 인자로 넘긴다(받는 쪽이 undefined와 '없음'을 가르지 않아도 되게) */
function callOptions(o: { deadlineMs?: number } | undefined): [] | [{ deadlineMs: number }] {
  return o?.deadlineMs === undefined ? [] : [{ deadlineMs: o.deadlineMs }];
}

/** inventory SeatMap.config의 필요한 칸(EventSeatConfig의 perAccountLimit·saleEndsAtMs) */
export interface SagaConfigSource {
  config(eventId: string): Promise<{ readonly perAccountLimit: number; readonly saleEndsAtMs: number; readonly entryOpensAtMs?: number; readonly virtualAccountAllowed?: boolean } | undefined>;
}

/** SagaEventConfigs의 좌석맵 판 구현: config가 없거나 읽기가 던지면 undefined. 던지지 않는다 */
export class SeatMapSagaConfigs implements SagaEventConfigs {
  constructor(private readonly source: SagaConfigSource) {}

  async get(eventId: string): Promise<SagaEventConfig | undefined> {
    try {
      const c = await this.source.config(eventId);
      return c ? { perAccountLimit: c.perAccountLimit, saleEndsAtMs: c.saleEndsAtMs, ...(c.entryOpensAtMs !== undefined ? { entryOpensAtMs: c.entryOpensAtMs } : {}), ...(c.virtualAccountAllowed !== undefined ? { virtualAccountAllowed: c.virtualAccountAllowed } : {}) } : undefined;
    } catch {
      // 판을 읽지 못했으면 판이 없는 것과 같게 본다(실행기가 설정 오류로 보고 다시 한다)
      return undefined;
    }
  }
}

// ---- 결제 결과 반영의 커밋 뒤 구매 세션 일(BUILD_ORDER PRF-163) ----

/** inventory의 구매 세션 끝내기(EndPurchaseSession.execute)와 저장소(PurchaseSessionStore.setPaying, 운영 RedisPurchaseSessionStore)의 모양 */
export interface PaymentSessionSource {
  end: { execute(c: { sessionId: string; reason: 'LEFT' | 'COMPLETED'; expectEventId?: string }): Promise<boolean> };
  store: { setPaying(jti: string, paying: boolean, o?: { deadlineMs?: number }): Promise<boolean> };
}

/**
 * PaymentResultSessions의 inventory 구현: complete는 source.end.execute({ sessionId, reason: 'COMPLETED' }) 그대로,
 * unmarkPaying은 source.store.setPaying(jti, false). inventory가 던지는 좌석 Redis 장애(SeatStoreUnavailable, 이름으로 가른다)는
 * OrderSeatStoreUnavailable로 바꿔 던지고, 그 밖(RangeError 등)은 그대로 던진다
 */
export class InventoryPaymentResultSessions implements PaymentResultSessions {
  constructor(private readonly source: PaymentSessionSource) {}

  async complete(purchaseSessionId: string): Promise<boolean> {
    try {
      return await this.source.end.execute({ sessionId: purchaseSessionId, reason: 'COMPLETED' });
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }

  async unmarkPaying(purchaseSessionId: string): Promise<boolean> {
    try {
      return await this.source.store.setPaying(purchaseSessionId, false);
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }
}

// ---- 결제 시도 시작의 홀드 만료 시각(BUILD_ORDER PRF-191) ----

/** 주문 좌석의 홀드 만료 읽기(운영 RedisOrderHolds.holdExpiry)의 모양 */
export interface OrderHoldExpirySource {
  holdExpiry(eventId: string, holdId: string, seatIds: readonly string[], o?: { deadlineMs?: number }): Promise<number | undefined>;
}

/** OrderHoldExpiries의 inventory 구현. 좌석 Redis 장애(SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 던지고, 그 밖의 오류는 그대로 던진다 */
export class InventoryOrderHoldExpiries implements OrderHoldExpiries {
  constructor(private readonly source: OrderHoldExpirySource) {}

  async expiresAt(q: Parameters<OrderHoldExpiries['expiresAt']>[0], o?: { deadlineMs?: number }): Promise<number | undefined> {
    try {
      return await this.source.holdExpiry(q.eventId, q.holdId, q.seatIds, o);
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }
}

// ---- 결제하지 않은 주문의 만료(BUILD_ORDER PRF-172 설계 1) ----

/** inventory의 세션 상태 읽기(PurchaseSessionStore.read, 운영 RedisPurchaseSessionStore)와 주문 좌석의 홀드 남음 읽기(운영 RedisOrderHolds.holdLeft)의 모양 */
export interface OrderExpirySource {
  /** 시간으로 거르지 않는다(최대 체류가 지났어도 키가 있으면 준다). 릴레이 프로세스에도 있는 읽기라 StoredPurchaseSessions(서버 ECDH 키가 든다)를 쓰지 않는다 */
  sessions: { read(jti: string): Promise<{ readonly maxStayUntilMs: number } | undefined> };
  holds: { holdLeft(eventId: string, holdId: string, seatIds: readonly string[]): Promise<boolean> };
  /** 최대 체류 시각과 견주는 '지금' */
  clock: Clock;
}

/**
 * OrderExpiryInventory의 inventory 구현. sessionEnded는 세션 상태가 없거나 지금 ≥ 최대 체류 시각이면 true, holdRemains는 주문 항목 좌석의 홀드 Hash를 직접 읽는다(RedisOrderHolds.holdLeft).
 * 주문 생성의 check는 쓰지 않는다: 구매 세션의 홀드 목록부터 읽어 세션을 끝낸 뒤에는 살아 있는 홀드도 NOT_FOUND로 답한다(docs/features/payment.md §2).
 * 좌석 Redis 장애(SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 던진다(끝났다·풀렸다로 보지 않는다). 그 밖의 오류는 그대로 던진다
 */
export class InventoryOrderExpiry implements OrderExpiryInventory {
  constructor(private readonly source: OrderExpirySource) {}

  async sessionEnded(purchaseSessionId: string): Promise<boolean> {
    try {
      const s = await this.source.sessions.read(purchaseSessionId);
      return s === undefined || this.source.clock.now() >= s.maxStayUntilMs;
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }

  async holdRemains(q: OrderHoldQuery): Promise<boolean> {
    try {
      return await this.source.holds.holdLeft(q.eventId, q.holdId, q.seatIds ?? []);
    } catch (e) {
      throw seatStoreErrorOf(e);
    }
  }
}

/** inventory의 좌석 Redis 장애(SeatStoreUnavailable. 이름으로 가른다, inventory를 가져오지 않으려고)는 OrderSeatStoreUnavailable로, 그 밖은 그대로 */
function seatStoreErrorOf(e: unknown): unknown {
  return e instanceof Error && e.name === 'SeatStoreUnavailable' ? new OrderSeatStoreUnavailable(e) : e;
}
