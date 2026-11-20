// core-svc → ops-svc 내부 승인 업무 생성 클라이언트(BAT-615 LCH-070, ADR-0320 결정 3).
// PUT /internal/v1/approval-requests/{approvalId}는 같은 승인 ID 재호출에 같은 답을 준다(멱등). 서비스 사이 토큰을 붙이고 시간 상한은 3초 [가정]이다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { OpsApprovalClient } from '../domain/promoter-ports.js';

export const OPS_APPROVAL_TIMEOUT_MS = 3_000;

export class HttpOpsApprovals implements OpsApprovalClient {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async createContractTermsChange(input: Parameters<OpsApprovalClient['createContractTermsChange']>[0]): Promise<{ approvalId: string; status: string; requestedAt: string }> {
    const res = await this.client.request({
      method: 'PUT',
      path: '/internal/v1/approval-requests/{approvalId}',
      params: { approvalId: input.approvalId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({
        kind: 'CONTRACT_TERMS_CHANGE',
        targetRef: input.promoterId,
        requestedBy: input.requestedBy,
        reasonText: input.reasonText,
        current: input.current,
        requested: input.requested,
      }),
      timeoutCapMs: OPS_APPROVAL_TIMEOUT_MS,
    });
    const text = await res.text().catch(() => '');
    if (res.status < 200 || res.status > 299) throw new Error(`ops-svc 승인 업무 생성 ${res.status}`);
    const body = text ? (JSON.parse(text) as { approvalId?: unknown; status?: unknown; requestedAt?: unknown }) : {};
    return {
      approvalId: typeof body.approvalId === 'string' ? body.approvalId : input.approvalId,
      status: typeof body.status === 'string' ? body.status : 'PENDING_APPROVAL',
      requestedAt: typeof body.requestedAt === 'string' ? body.requestedAt : new Date(0).toISOString(),
    };
  }
}

/** 메모리 시험·로컬: ops를 부르지 않고 승인 업무를 받은 것으로 기록한다(운영 조립에는 쓰지 않는다) */
export class MemoryOpsApprovals implements OpsApprovalClient {
  readonly requests: Parameters<OpsApprovalClient['createContractTermsChange']>[0][] = [];
  async createContractTermsChange(input: Parameters<OpsApprovalClient['createContractTermsChange']>[0]) {
    this.requests.push(input);
    return { approvalId: input.approvalId, status: 'PENDING_APPROVAL', requestedAt: new Date().toISOString() };
  }
}

/** 주소가 없을 때: 변경 요청 경로만 503이고 서비스 시작은 막지 않는다(ADR-0320) */
export class UnavailableOpsApprovals implements OpsApprovalClient {
  async createContractTermsChange(): Promise<never> {
    throw new Error('PEAKET_OPS_HTTP_URL이 없어 승인 업무를 만들 수 없다');
  }
}
