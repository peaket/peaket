// core-svc 지금 계약 조건 HTTP 클라이언트(GET /internal/v1/promoters/{promoterId}/contract).
// 계약이 없으면 404이고 payment-svc는 보증 충당을 409 guarantee-contract-missing으로 닫는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { PromoterContractSource } from '../domain/ports.js';
import type { GuaranteeKind } from '../domain/settlement.js';

export class HttpPromoterContractSource implements PromoterContractSource {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
  ) {
    this.#client = createExternalHttpClient({ provider: 'core-svc', baseUrl, timeoutCapMs: 5_000 });
  }

  async current(promoterId: string): Promise<{ commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: GuaranteeKind } | undefined> {
    const res = await this.#client.request({
      method: 'GET',
      path: '/internal/v1/promoters/{promoterId}/contract',
      params: { promoterId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: 5_000,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { commissionRateBp?: unknown; guaranteeRateBp?: unknown; guaranteeKind?: unknown };
    if (typeof body.commissionRateBp !== 'number' || typeof body.guaranteeRateBp !== 'number') return undefined;
    if (body.guaranteeKind !== 'DEPOSIT' && body.guaranteeKind !== 'PERFORMANCE_BOND') return undefined;
    return { commissionRateBp: body.commissionRateBp, guaranteeRateBp: body.guaranteeRateBp, guaranteeKind: body.guaranteeKind };
  }
}

export class UnavailablePromoterContractSource implements PromoterContractSource {
  async current(): Promise<undefined> {
    return undefined;
  }
}
