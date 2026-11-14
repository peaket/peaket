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
  /** 전체 행을 덮어쓰고 version을 1 올린다. expectedVersion이 다르면 'conflict' */
  save(promoterId: string, record: ProductRecord, expectedVersion: number): Promise<ProductRecord | 'conflict'>;
}

export interface ProductEventDirectory {
  productionOf(eventId: string): Promise<{ productionId: string; title: string } | undefined>;
}

/** 상품을 처음 게시할 때 고정하는 중개수수료율(만분율, ADR-0062) */
export interface CommissionRateSource {
  rateBp(promoterId: string): Promise<number>;
}

export const PRODUCT_STORE = Symbol.for('peaket.shop.product-store');
export const PRODUCT_EVENT_DIRECTORY = Symbol.for('peaket.shop.product-event-directory');
export const COMMISSION_RATE_SOURCE = Symbol.for('peaket.shop.commission-rate-source');
