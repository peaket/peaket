// COMMANDER_ROLE_CHANGE 승인 업무(요청→승인→적용, POL-038 ⑨, ADR-0322).
// 요청자가 아닌 commander가 act=APPROVAL로 승인하면 identity ChangeAdminRole(approval_id)을 부르고,
// 그때 권한 변경 감사(SUCCEEDED)를 감사 체인에 남긴다. 요청자 본인·다른 역할의 승인은 403이고, 마감 지난 승인은 409다.
import { randomUUID } from 'node:crypto';
import { ProblemError, type Clock } from '@peaket/platform';
import type { AuditChain } from '../../audit/index.js';
import { addBusinessDays, APPROVAL_DUE_BUSINESS_DAYS, roleChangeApprovalView, type RoleChangeApprovalView } from '../domain/role-change-approval.js';
import { AdminAccountProblem, type AdminRole } from '../domain/admin-account.js';
import type { RoleChangeApprovalRecord, RoleChangeApprovalStore, AdminIdentity, AdminReauth } from '../domain/ports.js';

export interface RoleChangeApprovalsDeps {
  readonly store: RoleChangeApprovalStore;
  readonly identity: AdminIdentity;
  readonly reauth: AdminReauth | undefined;
  readonly audit: AuditChain | undefined;
  readonly clock: Clock;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다', detail: '승인 업무를 찾을 수 없습니다' });
const conflict = (title: string) => new ProblemError({ type: 'admin-account-state-conflict', status: 409, title });

export class RoleChangeApprovals {
  constructor(private readonly d: RoleChangeApprovalsDeps) {}

  async create(i: { targetRef: string; targetVersion: number; fromRole: AdminRole; requestedRole: AdminRole; reason: string; requestedBy: string }): Promise<RoleChangeApprovalRecord> {
    const now = this.d.clock.now();
    const r: RoleChangeApprovalRecord = {
      approvalId: randomUUID(),
      kind: 'COMMANDER_ROLE_CHANGE',
      targetRef: i.targetRef,
      requestedRole: i.requestedRole,
      fromRole: i.fromRole,
      targetVersion: i.targetVersion,
      reason: i.reason,
      requestedBy: i.requestedBy,
      status: 'PENDING_APPROVAL',
      requiredApprovals: 2,
      approverId: null,
      closeReason: null,
      createdAtMs: now,
      updatedAtMs: now,
      dueAtMs: addBusinessDays(now, APPROVAL_DUE_BUSINESS_DAYS),
    };
    await this.d.store.insert(r);
    return r;
  }

  async list(filter: { status?: readonly string[]; limit: number }, actor: { accountId: string; role: string }): Promise<{ items: RoleChangeApprovalView[]; nextCursor: null }> {
    const rows = await this.d.store.list(filter);
    return { items: rows.filter((r) => r.requestedBy === actor.accountId || actor.role === 'commander').map((r) => roleChangeApprovalView(r, actor)), nextCursor: null };
  }

  /** 라우터가 계약 승인과 나눠 볼 때 쓴다. 없거나 볼 수 없으면 null */
  async tryGet(approvalId: string, actor: { accountId: string; role: string }): Promise<RoleChangeApprovalView | null> {
    const r = await this.d.store.find(approvalId);
    if (!r) return null;
    if (r.requestedBy !== actor.accountId && actor.role !== 'commander') return null;
    return roleChangeApprovalView(r, actor);
  }

  /** 이 ID의 승인 업무인가(볼 수 있는지는 보지 않는다). 승인·반려 갈래를 고르는 데만 쓴다 */
  async exists(approvalId: string): Promise<boolean> {
    return (await this.d.store.find(approvalId)) !== null;
  }

  async get(approvalId: string, actor: { accountId: string; role: string }): Promise<RoleChangeApprovalView> {
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    if (r.requestedBy !== actor.accountId && actor.role !== 'commander') throw notFound();
    return roleChangeApprovalView(r, actor);
  }

  async approve(approvalId: string, actor: { accountId: string; sessionId: string; role: string }, reauthToken: string | undefined): Promise<RoleChangeApprovalView> {
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    // FAILED는 identity 일시 장애 뒤 재시도할 수 있다(openapi 승인 설명, RV-06)
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw conflict('지금 판정할 수 있는 승인 업무가 아닙니다');
    if (r.requestedBy === actor.accountId) throw new ProblemError({ type: 'approval-self-not-allowed', status: 403, title: '요청자는 승인할 수 없습니다' });
    if (actor.role !== 'commander') throw new ProblemError({ type: 'approval-role-required', status: 403, title: 'commander만 승인할 수 있습니다' });
    const now = this.d.clock.now();
    if (now > r.dueAtMs) {
      await this.d.store.save({ ...r, status: 'EXPIRED', closeReason: 'DEADLINE_PASSED', updatedAtMs: now }, r.updatedAtMs);
      throw conflict('승인 기한이 지났습니다');
    }
    const verified = await this.#verify(reauthToken, actor);
    if (verified.accountId !== actor.accountId) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    let changed;
    try {
      // 같은 승인 ID를 request_id로 써서 응답을 잃은 재시도가 identity에서 멱등이다(RV-06)
      changed = await this.d.identity.changeRole({ requestId: r.approvalId, actedBy: actor.accountId, adminAccountId: r.targetRef, role: r.requestedRole, expectedVersion: r.targetVersion, approvalId: r.approvalId });
    } catch (e) {
      const failedAt = this.d.clock.now();
      await this.d.store.save({ ...r, status: 'FAILED', approverId: actor.accountId, closeReason: e instanceof Error ? e.message.slice(0, 200) : 'change-failed', updatedAtMs: failedAt }, r.updatedAtMs);
      // identity 문제는 ProblemError로 바꿔 승인 컨트롤러를 지나 412·409·503으로 나가게 한다(RV-03)
      if (e instanceof AdminAccountProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title, ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
      throw e;
    }
    const doneAt = this.d.clock.now();
    const done: RoleChangeApprovalRecord = { ...r, status: 'DONE', approverId: actor.accountId, updatedAtMs: doneAt };
    let saved = false;
    try {
      saved = await this.d.store.save(done, r.updatedAtMs);
    } catch {
      saved = false;
    }
    // identity가 역할을 바꿨으므로 저장이 낡은 판에 져도 감사 SUCCEEDED는 남긴다(RV-03)
    await this.d.audit?.append({
      recordType: 'ADMIN_ACCOUNT_ROLE_CHANGED',
      recordId: r.targetRef,
      payload: {
        accountId: r.targetRef,
        action: 'ROLE_CHANGED',
        fromRole: r.fromRole,
        toRole: r.requestedRole,
        actorAdminAccountId: actor.accountId,
        actorRole: actor.role,
        approvalId: r.approvalId,
        reason: r.reason,
        status: 'SUCCEEDED',
        accountVersion: changed.version,
      },
      nowMs: doneAt,
    });
    if (!saved) {
      const latest = await this.d.store.find(r.approvalId);
      if (latest?.status === 'DONE' && latest.approverId === actor.accountId) return roleChangeApprovalView(latest, actor);
      throw conflict('역할은 바뀌었지만 승인 행을 다른 처리와 맞추지 못했습니다');
    }
    return roleChangeApprovalView(done, actor);
  }

  async reject(approvalId: string, actor: { accountId: string; role: string }, reason: string): Promise<RoleChangeApprovalView> {
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    if (r.status !== 'PENDING_APPROVAL') throw conflict('지금 판정할 수 있는 승인 업무가 아닙니다');
    if (r.requestedBy === actor.accountId) throw new ProblemError({ type: 'approval-self-not-allowed', status: 403, title: '요청자는 승인할 수 없습니다', detail: '요청자는 반려할 수 없습니다' });
    if (actor.role !== 'commander') throw new ProblemError({ type: 'approval-role-required', status: 403, title: 'commander만 승인할 수 있습니다', detail: 'commander만 반려할 수 있습니다' });
    const text = reason.trim();
    if (text === '') throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다', detail: '반려 사유가 필요합니다' });
    const now = this.d.clock.now();
    const next: RoleChangeApprovalRecord = { ...r, status: 'REJECTED', approverId: actor.accountId, closeReason: text, updatedAtMs: now };
    if (!(await this.d.store.save(next, r.updatedAtMs))) throw conflict('다른 사람이 먼저 처리했습니다');
    return roleChangeApprovalView(next, actor);
  }

  async #verify(token: string | undefined, actor: { sessionId: string }): Promise<{ accountId: string }> {
    if (!this.d.reauth) throw new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5 });
    return this.d.reauth.verify(token, { sessionId: actor.sessionId, act: 'APPROVAL' });
  }
}
