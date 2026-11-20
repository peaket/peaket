// ops-svc → core-svc 계약 승인 적용·취소 클라이언트(BAT-615 LCH-070, ADR-0320 결정 3·9).
// core 내부 경로에 서비스 사이 토큰을 붙이고 시간 상한 3초 [가정]을 건다. 2xx만 성공이고 나머지는 오류다(승인은 FAILED로 남는다).
import type { ExternalHttpClient } from '@peaket/platform';
import type { CoreContractClient } from '../modules/approvals/domain/ports.js';

export const CORE_CONTRACT_TIMEOUT_MS = 3_000;

export class HttpCoreContract implements CoreContractClient {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async apply(q: Parameters<CoreContractClient['apply']>[0]): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/promoters/{promoterId}/contract-approvals/{approvalId}',
      params: { promoterId: q.promoterId, approvalId: q.approvalId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({
        ...(q.commissionRateBp !== undefined ? { commissionRateBp: q.commissionRateBp } : {}),
        ...(q.guaranteeRateBp !== undefined ? { guaranteeRateBp: q.guaranteeRateBp } : {}),
        ...(q.guaranteeKind !== undefined ? { guaranteeKind: q.guaranteeKind } : {}),
        approvedAt: q.approvedAt.toISOString(),
        approverId: q.approverId,
      }),
      timeoutCapMs: CORE_CONTRACT_TIMEOUT_MS,
    });
    await res.text().catch(() => undefined);
    if (res.status < 200 || res.status > 299) throw new Error(`core-svc 계약 적용 ${res.status}`);
  }

  async cancel(q: Parameters<CoreContractClient['cancel']>[0]): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/promoters/{promoterId}/contract-approvals/{approvalId}/cancellations',
      params: { promoterId: q.promoterId, approvalId: q.approvalId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ ...(q.reason !== undefined ? { reason: q.reason } : {}) }),
      timeoutCapMs: CORE_CONTRACT_TIMEOUT_MS,
    });
    await res.text().catch(() => undefined);
    if (res.status < 200 || res.status > 299) throw new Error(`core-svc 계약 예약 취소 ${res.status}`);
  }
}

/** 주소가 없을 때: 승인·반려·철회가 503이고 시작은 막지 않는다 */
export class UnavailableCoreContract implements CoreContractClient {
  async apply(): Promise<never> {
    throw new Error('PEAKET_CORE_HTTP_URL이 없어 계약을 적용할 수 없다');
  }
  async cancel(): Promise<never> {
    throw new Error('PEAKET_CORE_HTTP_URL이 없어 계약 예약을 풀 수 없다');
  }
}

/** 시험·로컬: core 대신 기록만 한다 */
export class MemoryCoreContract implements CoreContractClient {
  readonly applied: Parameters<CoreContractClient['apply']>[0][] = [];
  readonly cancelled: Parameters<CoreContractClient['cancel']>[0][] = [];
  async apply(q: Parameters<CoreContractClient['apply']>[0]): Promise<void> {
    this.applied.push(q);
  }
  async cancel(q: Parameters<CoreContractClient['cancel']>[0]): Promise<void> {
    this.cancelled.push(q);
  }
}
