// 승인 업무 라우터. 지급 묶음·계약 조건 변경·commander 역할 변경·정산 조정·부정 예매 조치를 kind로 나눈다.
import { ProblemError } from '@peaket/platform';
import { PayoutApprovals, type OpsActor } from '../../payouts/index.js';
import type { RoleChangeApprovals } from '../../admin-accounts/index.js';
import type { FraudActions } from '../../investigations/index.js';
import { ContractApprovals } from './contract-approvals.js';
import { SettlementAdjustmentApprovals } from './settlement-adjustment-approvals.js';

type AnyView = Record<string, unknown> & { approvalId: string; requestedAt: string };

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });

export class ApprovalRouter {
  constructor(
    private readonly payouts: PayoutApprovals,
    private readonly contracts: ContractApprovals,
    private readonly roleChanges: RoleChangeApprovals,
    private readonly adjustments?: SettlementAdjustmentApprovals,
    private readonly fraud?: FraudActions,
  ) {}

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: AnyView[]; nextCursor: null }> {
    const [payoutPage, contractPage, rolePage, adjustmentPage, fraudPage] = await Promise.all([
      this.payouts.list(filter, actor),
      this.contracts.list(filter, actor),
      this.roleChanges.list(filter, actor),
      this.adjustments ? this.adjustments.list(filter, actor) : Promise.resolve({ items: [] }),
      this.fraud ? this.fraud.listApprovals(actor, filter) : Promise.resolve({ items: [], nextCursor: null }),
    ]);
    const items = [
      ...(payoutPage.items as unknown as AnyView[]),
      ...(contractPage.items as unknown as AnyView[]),
      ...(rolePage.items as unknown as AnyView[]),
      ...(adjustmentPage.items as unknown as AnyView[]),
      ...(fraudPage.items as unknown as AnyView[]),
    ].sort((a, b) => (b.requestedAt > a.requestedAt ? 1 : b.requestedAt < a.requestedAt ? -1 : 0));
    return { items: items.slice(0, filter.limit), nextCursor: null };
  }

  async get(approvalId: string, actor: OpsActor): Promise<Record<string, unknown>> {
    const contract = await this.contracts.tryGet(approvalId, actor);
    if (contract) return contract as unknown as Record<string, unknown>;
    const role = await this.roleChanges.tryGet(approvalId, actor);
    if (role) return role as unknown as Record<string, unknown>;
    if (this.adjustments && (await this.adjustments.exists(approvalId))) return (await this.adjustments.get(approvalId, actor)) as unknown as Record<string, unknown>;
    if (this.fraud) {
      try {
        return await this.fraud.getApproval(approvalId, actor);
      } catch (e) {
        if ((e as { type?: string }).type === 'not-found') {
          // 다른 종류의 승인일 수 있으므로 지급 승인으로 넘긴다
        } else throw e;
      }
    }
    return (await this.payouts.get(approvalId, actor)) as unknown as Record<string, unknown>;
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined, reason?: string, body?: { excludeAccountIds?: string[]; excludeTicketIds?: string[] }): Promise<Record<string, unknown>> {
    if (await this.contracts.exists(approvalId)) return (await this.contracts.approve(approvalId, actor, reauthToken, reason)) as unknown as Record<string, unknown>;
    if (await this.roleChanges.exists(approvalId)) return (await this.roleChanges.approve(approvalId, actor, reauthToken)) as unknown as Record<string, unknown>;
    if (this.adjustments && (await this.adjustments.exists(approvalId))) return (await this.adjustments.approve(approvalId, actor, reauthToken, reason)) as unknown as Record<string, unknown>;
    if (this.fraud) {
      const found = await this.fraud.getApprovalOrNull(approvalId);
      if (found) return await this.fraud.approve(approvalId, actor, reauthToken, { ...(reason ? { reason } : {}), ...(body ?? {}) });
    }
    return (await this.payouts.approve(approvalId, actor, reauthToken)) as unknown as Record<string, unknown>;
  }

  async reject(approvalId: string, actor: OpsActor, reason: string): Promise<Record<string, unknown>> {
    if (await this.contracts.exists(approvalId)) return (await this.contracts.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    if (await this.roleChanges.exists(approvalId)) return (await this.roleChanges.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    if (this.adjustments && (await this.adjustments.exists(approvalId))) return (await this.adjustments.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    if (this.fraud && (await this.fraud.getApprovalOrNull(approvalId))) return await this.fraud.reject(approvalId, actor, reason);
    return (await this.payouts.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
  }

  async withdraw(approvalId: string, actor: OpsActor, reason: string): Promise<Record<string, unknown>> {
    if (await this.contracts.exists(approvalId)) return (await this.contracts.withdraw(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    if (this.fraud && (await this.fraud.getApprovalOrNull(approvalId))) return await this.fraud.withdraw(approvalId, actor, reason);
    throw notFound();
  }
}
