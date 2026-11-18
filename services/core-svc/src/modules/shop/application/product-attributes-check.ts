// 상품 속성 검증 잡(정비 일 product-attributes-check, ADR-0300 결정 2, V-T46 ③).
// 매일 한 번 정비 시간 안 04:40 KST [가정] 뒤에 모든 상품을 기본 키 차례로 1,000건 [가정]씩 읽어 그 행의 유형·판 스키마(@peaket/validation/product-types)로 다시 검사한다.
// 맞지 않는 상품(모르는 유형·판 포함)이 1건이라도 있으면 SEV3 경고 한 줄(kind hygiene, 상품 ID와 유형·판만, 속성 값은 싣지 않는다)과
// 게이지 shop_product_attributes_invalid(마지막 실행의 건수)를 낸다. 상품을 고치지 않는다.
import type { Clock } from '@peaket/platform';
import { checkProductAttributes } from '@peaket/validation/product-types';
import { kstMinuteOfDay } from '../domain/business-day.js';
import type { ShopOrderStore } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

export const PRODUCT_ATTRIBUTES_TASK = 'product-attributes-check';
/** 한 번에 읽는 상품 1,000건 [가정] */
export const PRODUCT_ATTRIBUTES_BATCH = 1_000;
/** 도는 시각 04:40 KST [가정](분) */
export const PRODUCT_ATTRIBUTES_RUN_MINUTE_KST = 4 * 60 + 40;
/** 경고 한 줄에 싣는 상품 상한 [정함](건수는 따로 싣는다) */
const LISTED_MAX = 100;

export class ProductAttributesCheck {
  readonly #log: ShopLogger;

  constructor(private readonly d: { store: Pick<ShopOrderStore, 'productAttributesPage'>; clock: Clock; signals?: ShopSignals; logger?: ShopLogger }) {
    this.#log = d.logger ?? silentShopLogger;
  }

  async run(signal?: AbortSignal): Promise<{ deferred: true } | { checked: number; invalid: number }> {
    if (kstMinuteOfDay(this.d.clock.now()) < PRODUCT_ATTRIBUTES_RUN_MINUTE_KST) return { deferred: true };
    const invalid: { productId: string; type: string; schemaVersion: number }[] = [];
    let checked = 0;
    let after: string | undefined;
    for (;;) {
      if (signal?.aborted) throw new Error('정비 일을 멈췄다');
      const page = await this.d.store.productAttributesPage(after, PRODUCT_ATTRIBUTES_BATCH);
      for (const p of page) {
        checked++;
        if (!checkProductAttributes(p.type, p.schemaVersion, p.attributes).ok) invalid.push({ productId: p.productId, type: p.type, schemaVersion: p.schemaVersion });
      }
      if (page.length < PRODUCT_ATTRIBUTES_BATCH) break;
      after = page[page.length - 1]!.productId;
    }
    this.d.signals?.attributesInvalid.set(invalid.length);
    if (invalid.length > 0) {
      this.#log.warn({ kind: 'hygiene', severity: 'SEV3', check: PRODUCT_ATTRIBUTES_TASK, count: invalid.length, products: invalid.slice(0, LISTED_MAX) }, '유형 스키마에 맞지 않는 상품 속성이 있다');
    }
    return { checked, invalid: invalid.length };
  }
}
