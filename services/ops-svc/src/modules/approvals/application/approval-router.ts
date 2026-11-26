// 승인 업무 라우터(BAT-615 LCH-070, ADR-0320 결정 3, BAT-045 BOT-152, F-06-3).
// 지급 묶음·계약 조건 변경·commander 역할 변경·정산서 조정·일반 승인 수명주기를 kind로 나눈다.
// 일반 수명주기는 approval_request에 있고, 각 유스케이스의 공개 모양은 그대로 두고 HTTP 경로만 이 라우터를 지난다.
import { ProblemError } from '@peaket/platform';
import { PayoutApprovals, type OpsActor } from '../../payouts/index.js';
import type { RoleChangeApprovals } from '../../admin-accounts/index.js';
import { ContractApprovals } from './contract-approvals.js';
import { SettlementAdjustmentApprovals } from './settlement-adjustment-approvals.js';
import { ApprovalLifecycle, type LifecycleRequestInput } from './approval-lifecycle.js';

type AnyView = Record<string, unknown> & { approvalId: string; requestedAt: string };

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });

export class ApprovalRouter {
  constructor(
    private readonly payouts: PayoutApprovals,
    private readonly contracts: ContractApprovals,
    private readonly roleChanges: RoleChangeApprovals,
    private readonly adjustments?: SettlementAdjustmentApprovals,
    private readonly lifecycle?: ApprovalLifecycle,
  ) {}

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: AnyView[]; nextCursor: null }> {
    const [payoutPage, contractPage, rolePage, adjustmentPage, lifecyclePage] = await Promise.all([
      this.payouts.list(filter, actor),
      this.contracts.list(filter, actor),
      this.roleChanges.list(filter, actor),
      this.adjustments ? this.adjustments.list(filter, actor) : Promise.resolve({ items: [] }),
      this.lifecycle ? this.lifecycle.list(filter, actor) : Promise.resolve({ items: [] }),
    ]);
    const items = [
      ...(payoutPage.items as unknown as AnyView[]),
      ...(contractPage.items as unknown as AnyView[]),
      ...(rolePage.items as unknown as AnyView[]),
      ...(adjustmentPage.items as unknown as AnyView[]),
      ...(lifecyclePage.items as unknown as AnyView[]),
    ].sort((a, b) =>
      b.requestedAt > a.requestedAt ? 1 : b.requestedAt < a.requestedAt ? -1 : 0,
    );
    return { items: items.slice(0, filter.limit), nextCursor: null };
  }

  async create(input: LifecycleRequestInput, actor: OpsActor): Promise<Record<string, unknown>> {
    if (!this.lifecycle) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '승인 업무 연결을 사용할 수 없습니다' });
    return (await this.lifecycle.request(input, actor)) as unknown as Record<string, unknown>;
  }

  async get(approvalId: string, actor: OpsActor): Promise<Record<string, unknown>> {
    if (this.lifecycle && (await this.lifecycle.find(approvalId))) return (await this.lifecycle.get(approvalId, actor)) as unknown as Record<string, unknown>;
    const contract = await this.contracts.tryGet(approvalId, actor);
    if (contract) return contract as unknown as Record<string, unknown>;
    const role = await this.roleChanges.tryGet(approvalId, actor);
    if (role) return role as unknown as Record<string, unknown>;
    // 조정 승인은 볼 수 없으면 없는 것과 같은 404다(지급 승인으로 새지 않는다)
    if (this.adjustments && (await this.adjustments.exists(approvalId))) return (await this.adjustments.get(approvalId, actor)) as unknown as Record<string, unknown>;
    return (await this.payouts.get(approvalId, actor)) as unknown as Record<string, unknown>;
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined, reason?: string, ifMatch?: string): Promise<Record<string, unknown>> {
    if (this.lifecycle && (await this.lifecycle.find(approvalId))) return (await this.lifecycle.approve(approvalId, actor, reauthToken, reason, ifMatch)) as unknown as Record<string, unknown>;
    if (await this.contracts.exists(approvalId)) return (await this.contracts.approve(approvalId, actor, reauthToken, reason)) as unknown as Record<string, unknown>;
    if (await this.roleChanges.exists(approvalId)) return (await this.roleChanges.approve(approvalId, actor, reauthToken)) as unknown as Record<string, unknown>;
    if (this.adjustments && (await this.adjustments.exists(approvalId))) return (await this.adjustments.approve(approvalId, actor, reauthToken, reason)) as unknown as Record<string, unknown>;
    return (await this.payouts.approve(approvalId, actor, reauthToken)) as unknown as Record<string, unknown>;
  }

  async reject(approvalId: string, actor: OpsActor, reason: string, ifMatch?: string): Promise<Record<string, unknown>> {
    if (this.lifecycle && (await this.lifecycle.find(approvalId))) return (await this.lifecycle.reject(approvalId, actor, reason, ifMatch)) as unknown as Record<string, unknown>;
    if (await this.contracts.exists(approvalId)) return (await this.contracts.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    if (await this.roleChanges.exists(approvalId)) return (await this.roleChanges.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    if (this.adjustments && (await this.adjustments.exists(approvalId))) return (await this.adjustments.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    return (await this.payouts.reject(approvalId, actor, reason)) as unknown as Record<string, unknown>;
  }

  async withdraw(approvalId: string, actor: OpsActor, reason: string, ifMatch?: string): Promise<Record<string, unknown>> {
    if (this.lifecycle && (await this.lifecycle.find(approvalId))) return (await this.lifecycle.withdraw(approvalId, actor, reason, ifMatch)) as unknown as Record<string, unknown>;
    if (await this.contracts.exists(approvalId)) return (await this.contracts.withdraw(approvalId, actor, reason)) as unknown as Record<string, unknown>;
    // 지급 묶음·역할 변경 승인의 철회는 이 묶음 몫이 아니다(GAT-290·BAT-045)
    throw notFound();
  }

  /** 내부 tick. 일반 수명주기와 지급 묶음 15시 만료를 함께 본다. */
  async tick(): Promise<{ escalated: number; expired: number; failed: number }> {
    if (!this.lifecycle) return { escalated: 0, expired: 0, failed: 0 };
    return this.lifecycle.tick();
  }
}
