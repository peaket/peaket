// 파트너사 실재 확인(RV-12): core-svc 내부 계약 조회 GET /internal/v1/promoters/{promoterId}/contract를 부른다.
// 404는 없는 파트너사(false), 2xx는 있음(true), 그 밖·시간 초과는 던져 초대를 503 promoter-directory-unavailable로 닫는다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { PromoterDirectory } from '../modules/admin-accounts/index.js';

const TIMEOUT_MS = 3_000;

export class HttpCorePromoterDirectory implements PromoterDirectory {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async exists(promoterId: string): Promise<boolean> {
    const res = await this.client.request({
      method: 'GET',
      path: '/internal/v1/promoters/{promoterId}/contract',
      params: { promoterId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: TIMEOUT_MS,
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`core-svc promoter ${res.status}`);
    return true;
  }
}

/** core 주소가 없을 때: 초대를 닫힌 쪽(503)으로 보낸다 */
export class UnavailablePromoterDirectory implements PromoterDirectory {
  async exists(): Promise<boolean> {
    throw new Error('PEAKET_CORE_HTTP_URL이 없다');
  }
}
