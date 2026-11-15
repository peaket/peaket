// core-svc 회차 수수료율 HTTP 클라이언트(GET /internal/v1/events/{eventId}/commission-rate).
// 설정이 없으면 404이고 payment-svc는 회차 정산을 503 event-commission-rate-unavailable로 닫는다(A1-H10).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { EventCommissionRateSource } from '../domain/ports.js';

export class HttpEventCommissionRateSource implements EventCommissionRateSource {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
  ) {
    this.#client = createExternalHttpClient({ provider: 'core-svc', baseUrl, timeoutCapMs: 5_000 });
  }

  async rateBp(eventId: string): Promise<number | undefined> {
    const res = await this.#client.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/commission-rate',
      params: { eventId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: 5_000,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { commissionRateBp?: unknown };
    return typeof body.commissionRateBp === 'number' ? body.commissionRateBp : undefined;
  }
}
