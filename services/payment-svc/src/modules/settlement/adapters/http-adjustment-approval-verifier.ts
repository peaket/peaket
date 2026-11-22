// ops-svc 수기 조정 승인 기록 확인(F-07-5 LCH-100, ADR-0368 결정 8, ADR-0345와 같은 방식).
// payment-svc는 승인 ID만 믿고 조정을 적용하지 않는다. ops-svc 내부 GET /internal/v1/approval-requests/{approvalId}로
// 종류·대상 정산서·금액·사유 코드·상태·2인 승인·승인 시각을 읽어 조정 행과 대조한다.
// ops가 5xx·시간 초과·응답 모양 위반이면 503으로 닫고 아무것도 바꾸지 않는다(fail-closed). 없는 승인은 undefined(409로 닫는다).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import { SettlementProblem } from '../domain/settlement.js';
import type { AdjustmentApprovalVerifier, VerifiedAdjustmentApproval } from '../domain/ports.js';

const ApprovalFacts = z.object({
  approvalId: z.string().min(1),
  kind: z.literal('SETTLEMENT_ADJUSTMENT'),
  targetRef: z.string().min(1),
  amount: z.number().int(),
  reasonCode: z.string().min(1),
  status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED', 'WITHDRAWN', 'EXPIRED']),
  requiredApprovals: z.number().int().nonnegative(),
  requestedBy: z.string().min(1),
  approvals: z.array(z.string().min(1)),
  approvedAt: z.string().nullable(),
});

const unavailable = (detail: string) => new SettlementProblem('dependency-unavailable', 503, `조정 승인 기록을 확인할 수 없습니다(${detail})`);

export class HttpAdjustmentApprovalVerifier implements AdjustmentApprovalVerifier {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
    fetchImpl?: typeof fetch,
    timeoutCapMs = 3_000,
  ) {
    this.#client = createExternalHttpClient({ provider: 'ops-svc', baseUrl, timeoutCapMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async verify(approvalId: string): Promise<VerifiedAdjustmentApproval | undefined> {
    let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
    try {
      res = await this.#client.request({
        method: 'GET',
        path: '/internal/v1/approval-requests/{approvalId}',
        params: { approvalId },
        headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
        timeoutCapMs: 3_000,
      });
    } catch {
      throw unavailable('connection');
    }
    if (res.status === 404) return undefined;
    if (!res.ok) throw unavailable(`status-${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw unavailable('json');
    }
    const parsed = ApprovalFacts.safeParse(body);
    if (!parsed.success) throw unavailable('shape');
    return parsed.data;
  }
}

/** ops 주소가 없는 조립에서 조정 적용을 무조건 막는다(503) */
export class UnavailableAdjustmentApprovalVerifier implements AdjustmentApprovalVerifier {
  async verify(): Promise<VerifiedAdjustmentApproval | undefined> {
    throw unavailable('not-configured');
  }
}
