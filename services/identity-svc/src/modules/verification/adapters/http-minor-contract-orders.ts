// purchase-svc 주문 근거 HTTP 클라이언트(F-06-3 IR-04). identity의 미성년 계약 취소 확인이 읽는다.
import { createExternalHttpClient } from '@peaket/platform';
import type { MinorContractOrders } from '../domain/ports.js';

export class HttpMinorContractOrders implements MinorContractOrders {
  readonly #client;
  constructor(
    baseUrl: string,
    private readonly token: string | undefined,
  ) {
    this.#client = createExternalHttpClient({ provider: 'purchase-svc', baseUrl, timeoutCapMs: 5_000 });
  }

  async basis(orderId: string) {
    const res = await this.#client.request({
      method: 'GET',
      path: `/internal/v1/orders/${orderId}/minor-contract-basis`,
      headers: this.token ? { 'x-peaket-internal-token': this.token } : {},
      timeoutCapMs: 5_000,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { payerAccountId?: unknown; paidAt?: unknown };
    if (typeof body.payerAccountId !== 'string' || typeof body.paidAt !== 'string') return undefined;
    const paidAtMs = Date.parse(body.paidAt);
    return Number.isFinite(paidAtMs) ? { payerAccountId: body.payerAccountId, paidAtMs } : undefined;
  }
}
