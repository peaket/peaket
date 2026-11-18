// shop 저장·조회 포트. 메모리(단위 시험)와 Drizzle(운영)이 같은 모양을 쓴다.
import type { ProductFilter, ProductRecord } from './product.js';

export interface ProductListPage {
  items: ProductRecord[];
  nextCursor: string | null;
}

export interface ProductStore {
  list(promoterId: string, filter: ProductFilter): Promise<ProductListPage>;
  find(promoterId: string, productId: string): Promise<ProductRecord | undefined>;
  insert(record: ProductRecord): Promise<void>;
  /**
   * 전체 행을 덮어쓰고 version을 1 올린다. expectedVersion이 다르면 'conflict'.
   * 한정 수량 재고(product_stock)는 stock대로 바꾼다: keep 그대로, set 새로 둠, delta 남은 수 + delta(결과가 음수면 'stock-negative'이고 아무것도 바꾸지 않는다), remove 지움(ADR-0300 결정 3)
   */
  save(promoterId: string, record: ProductRecord, expectedVersion: number, stock?: StockChange): Promise<ProductRecord | 'conflict' | 'stock-negative'>;
}

/** 한정 수량을 고칠 때의 재고 바꾸기(ADR-0300 결정 3: 남은 수 + (새 수량 − 옛 수량), 덮어쓰지 않는다) */
export type StockChange = { kind: 'keep' } | { kind: 'set'; stock: number } | { kind: 'delta'; delta: number } | { kind: 'remove' };

export interface ProductEventDirectory {
  productionOf(eventId: string): Promise<{ productionId: string; title: string } | undefined>;
}

/** 파트너 회차 찾기(명단 내려받기·권한 확인). 소속 파트너의 회차만 준다. */
export interface PartnerEventDirectory {
  find(promoterId: string, eventId: string): Promise<{ eventId: string; title: string; endsAt: Date } | undefined>;
}

/** 상품을 처음 게시할 때 고정하는 중개수수료율(만분율, ADR-0062) */
export interface CommissionRateSource {
  rateBp(promoterId: string): Promise<number>;
}

export const PRODUCT_STORE = Symbol.for('peaket.shop.product-store');
export const PRODUCT_EVENT_DIRECTORY = Symbol.for('peaket.shop.product-event-directory');
export const COMMISSION_RATE_SOURCE = Symbol.for('peaket.shop.commission-rate-source');
