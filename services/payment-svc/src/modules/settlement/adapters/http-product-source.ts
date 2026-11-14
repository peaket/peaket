// core-svc shop 상품 정산 원천 HTTP 클라이언트(GET /internal/v1/shop/product-settlement-items).
import { createExternalHttpClient, ProblemError, type ExternalHttpClient } from '@peaket/platform';
import type { ProductSettlementSource } from '../domain/ports.js';
import type { ProductSettlementItem } from '../domain/settlement.js';

export class HttpProductSettlementSource implements ProductSettlementSource {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
  ) {
    this.#client = createExternalHttpClient({ provider: 'core-svc', baseUrl, timeoutCapMs: 5_000 });
  }

  async listProductItems(from: string, to: string): Promise<ProductSettlementItem[]> {
    const res = await this.#client.request({
      method: 'GET',
      path: '/internal/v1/shop/product-settlement-items',
      params: { from, to },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: 5_000,
    });
    if (!res.ok) throw new ProblemError({ type: 'product-settlement-source-unavailable', status: 503, title: '상품 정산 원천을 읽을 수 없습니다' });
    return ((await res.json()) as { items: ProductSettlementItem[] }).items;
  }
}

/** 원천 주소가 없는 개발·시험 조립. 상품 정산 계산은 503이다. */
export class UnavailableProductSettlementSource implements ProductSettlementSource {
  async listProductItems(): Promise<ProductSettlementItem[]> {
    throw new ProblemError({ type: 'product-settlement-source-unavailable', status: 503, title: '상품 정산 원천을 읽을 수 없습니다' });
  }
}
