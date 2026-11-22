// ops-svc 지급 승인 기록 확인(BAT-625 LCH-100, W12-mesh RV-01).
// payment-svc가 REST 8080으로 닿는 내부 신원·공유 토큰만으로 지급 묶음을 승인하지 못하게,
// ops-svc의 payout_approval 한 건을 읽어 대상·금액·통화·건수·2인 승인·상태를 대조한다.
// ops가 5xx·시간 초과·응답 모양 위반이면 503으로 닫고 아무것도 바꾸지 않는다(fail-closed).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import { SettlementProblem } from '../domain/settlement.js';
import type { PayoutApprovalVerifier, VerifiedPayoutApproval } from '../domain/ports.js';

const ApprovalFacts = z.object({
  approvalId: z.string().min(1),
  kind: z.literal('PAYOUT_BATCH'),
  targetRef: z.string().min(1),
  batchId: z.string().min(1),
  pg: z.enum(['TOSS', 'PORTONE']),
  pgStore: z.enum(['STANDARD', 'ESCROW']),
  payoutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.literal('KRW'),
  amount: z.number().int().nonnegative(),
  statementCount: z.number().int().nonnegative(),
  status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED']),
  requiredApprovals: z.number().int().nonnegative(),
  requestedBy: z.string().min(1),
  approvals: z.array(z.string().min(1)),
  approvedAt: z.string().nullable(),
});

const unavailable = (detail: string) => new SettlementProblem('dependency-unavailable', 503, `승인 기록을 확인할 수 없습니다(${detail})`);

export class HttpPayoutApprovalVerifier implements PayoutApprovalVerifier {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken?: string,
    fetchImpl?: typeof fetch,
    timeoutCapMs = 3_000,
  ) {
    this.#client = createExternalHttpClient({ provider: 'ops-svc', baseUrl, timeoutCapMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async verify(approvalId: string): Promise<VerifiedPayoutApproval | undefined> {
    let res: Awaited<ReturnType<ExternalHttpClient['request']>>;
    try {
      res = await this.#client.request({
        method: 'GET',
        path: '/internal/v1/payout-approvals/{approvalId}',
        params: { approvalId },
        headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
        timeoutCapMs: 3_000,
      });
    } catch {
      // 연결 실패·시간 초과·주소 오류는 의존 서비스 장애로 닫는다. 승인은 진행하지 않는다.
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

/** ops 주소가 없는 조립(로컬·시험의 일부)에서 승인을 무조건 막는다. */
export class UnavailablePayoutApprovalVerifier implements PayoutApprovalVerifier {
  async verify(): Promise<VerifiedPayoutApproval | undefined> {
    throw unavailable('not-configured');
  }
}
