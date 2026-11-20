// 승인 업무 라우터(BAT-615 LCH-070, ADR-0320 결정 3). 지급 묶음 승인과 계약 조건 변경 승인을 kind로 나눈다.
// PayoutApprovals의 공개 모양은 그대로 두고, HTTP 경로만 이 라우터를 지나 두 종류를 함께 답한다.
import { ProblemError } from '@peaket/platform';
import { PayoutApprovals, type OpsActor } from '../../payouts/index.js';
import { ContractApprovals } from './contract-approvals.js';

type AnyView = Record<string, unknown> & { approvalId: string; requestedAt: string };

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });

export class ApprovalRouter {
  constructor(
    private readonly payouts: PayoutApprovals,
    private readonly contracts: ContractApprovals,
  ) {}

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: AnyView[]; nextCursor: null }> {
    const [payoutPage, contractPage] = await Promise.all([this.payouts.list(filter, actor), this.contracts.list(filter, actor)]);
    const items = [...(payoutPage.items as unknown as AnyView[]), ...(contractPage.items as unknown as AnyView[])].sort((a, b) => (b.requestedAt > a.requestedAt ? 1 : b.requestedAt < a.requestedAt ? -1 : 0));
    return { items: items.slice(0, filter.limit), nextCursor: null };
  }

  async get(approvalId: string, actor: OpsActor): Promise<Record<string, unknown>> {
    const contract = await this.contracts.tryGet(approvalId, actor);
    if (contract) return contract as unknown as Record<string, unknown>;
    return (await this.payouts.get(approvalId, actor)) as unknown as Record<string, unknown>;
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined, reason?: string): Promise<Record<string, unknown>> {
    if (await this.contracts.exists(approvalId)) return (await this.contracts.approve(approvalId, actor, reauthToken, reason)) as unknown as Record<string, unknown>;
    return (await this.payouts.approve(approvalId, actor, reauthToken)) as unknown as Record<string, unknown>;
  }

  async reject(approvalId: string, actor: OpsActor, reason: string): Promise<Record<string, unknown>> {
    if (await this.contracts.exists(approvalId)) return (await this.contracts.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    return (await this.payouts.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
  }

  async withdraw(approvalId: string, actor: OpsActor, reason: string): Promise<Record<string, unknown>> {
    if (await this.contracts.exists(approvalId)) return (await this.contracts.withdraw(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    // 지급 묶음 승인의 철회는 이 묶음 몫이 아니다(GAT-290)
    throw notFound();
  }
}
