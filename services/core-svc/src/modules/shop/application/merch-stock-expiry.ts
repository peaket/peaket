// 굿즈 재고 예약 만료 작업(core-svc 릴레이 리더 반복, ADR-0300 결정 7, ADR-0107 결정 4, P-T42).
// 1초 [가정]마다 한정 상품(limited_qty 있음, DRAFT 아님. 목록은 30초 [가정]마다 다시 읽음)의 resv에서 점수가 지금 이하인 원소를 상품마다 100개 [가정]까지 읽고
// 주문 상태를 한 문장으로 읽어 이렇게 한다.
// - CREATED이고 결제 접수 전: 주문 행 잠금 아래 조건부 EXPIRED(O7). 바뀐 주문만 그 주문의 모든 한정 상품에 RELEASE(restore=1)
// - CREATED이고 결제 접수함: 만료하지 않는다(과금될 수 있다). 점수를 지금 + 60초 [가정]로 미룬다
// - PAID: RELEASE(restore=0). EXPIRED·FAILED·DB에 없는 주문: RELEASE(restore=1)(원소가 있을 때만 돌리므로 한 번만 돌아온다, P-T42 ⑤)
// 한정이 아닌 결제 전 주문(원소가 없다)은 DB의 부분 인덱스(stock_reserved_until, status = 'CREATED')로 같은 조건부 전이를 한다(구현 중 추천 적용, BAT-600).
import type { Clock } from '@peaket/platform';
import { ACCEPTED_EXPIRY_DEFER_MS, EXPIRY_BATCH } from '../domain/merch-order.js';
import { type MerchStock, type ShopOrderStore, StockUnavailable } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

/** 한정 상품 목록을 다시 읽는 간격 30초 [가정] */
export const LIMITED_PRODUCTS_REFRESH_MS = 30_000;

export interface MerchExpiryDeps {
  store: ShopOrderStore;
  stock: MerchStock;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
  /** 장애 주입 자리(시험): 만료를 커밋한 뒤 RELEASE 전에 부른다. 던지면 이번 바퀴를 거기서 멈춘다(F-1) */
  afterExpireCommit?: (orderId: string) => void | Promise<void>;
}

export interface ExpiryTick {
  expired: number;
  released: number;
  deferred: number;
  /** 재고 Redis를 읽지 못한 상품 수 */
  unavailable: number;
}

export class MerchStockExpiry {
  readonly #log: ShopLogger;
  #products: { productId: string }[] = [];
  #readAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: MerchExpiryDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  async tick(): Promise<ExpiryTick> {
    const now = this.d.clock.now();
    if (now - this.#readAtMs >= LIMITED_PRODUCTS_REFRESH_MS) {
      this.#products = await this.d.store.limitedProducts();
      this.#readAtMs = now;
    }
    const out: ExpiryTick = { expired: 0, released: 0, deferred: 0, unavailable: 0 };
    for (const { productId } of this.#products) {
      let due: string[];
      try {
        due = await this.d.stock.due(productId, now, EXPIRY_BATCH);
      } catch (e) {
        if (!(e instanceof StockUnavailable)) throw e;
        out.unavailable++;
        continue;
      }
      for (const orderId of due) await this.#one(productId, orderId, now, out);
    }
    // 한정이 아닌 결제 전 주문(DB만)
    for (const orderId of await this.d.store.dueUnpaidOrders(now, EXPIRY_BATCH)) {
      const released = await this.d.store.expireUnpaid(orderId, now, 'due');
      if (!released) continue;
      out.expired++;
      this.d.signals?.stockExpired.inc();
      this.d.signals?.order('expired');
      await this.d.afterExpireCommit?.(orderId);
      for (const l of released.limited) if ((await this.d.stock.release(l.productId, orderId, true, released.accountId)).removed) out.released++;
    }
    if (out.unavailable > 0) this.#log.warn({ kind: 'merch-stock-unavailable', products: out.unavailable }, '재고 Redis를 읽지 못해 일부 상품의 만료를 미뤘다');
    return out;
  }

  async #one(productId: string, orderId: string, now: number, out: ExpiryTick): Promise<void> {
    const st = await this.d.store.orderState(orderId);
    if (!st) {
      // DB에 없는 주문(넣기 전에 죽은 요청): 원소가 있을 때만 돌린다
      if ((await this.d.stock.release(productId, orderId, true)).removed) out.released++;
      return;
    }
    if (st.status === 'CREATED' && !st.accepted) {
      const released = await this.d.store.expireUnpaid(orderId, now, 'due');
      if (!released) {
        // DB 기한이 아직이면(연장됨) 그 시각으로 미룬다
        await this.d.stock.defer(productId, orderId, Math.max(st.stockReservedUntilMs, now + 1));
        out.deferred++;
        return;
      }
      out.expired++;
      this.d.signals?.stockExpired.inc();
      this.d.signals?.order('expired');
      await this.d.afterExpireCommit?.(orderId);
      for (const l of released.limited) if ((await this.d.stock.release(l.productId, orderId, true, st.accountId)).removed) out.released++;
      return;
    }
    if (st.status === 'CREATED') {
      await this.d.stock.defer(productId, orderId, now + ACCEPTED_EXPIRY_DEFER_MS);
      out.deferred++;
      return;
    }
    const restore = st.status === 'EXPIRED' || st.status === 'FAILED';
    if ((await this.d.stock.release(productId, orderId, restore, st.accountId)).removed) out.released++;
  }
}
