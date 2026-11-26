// 승인 업무 수명주기 유스케이스(F-06-3, transfer-refund §3.2·§7.2, POL-038).
// 요청·1·2인 투표·승인·반려·철회·만료·1영업일 상위 알림을 한 곳에서 다룬다.
// 지급 묶음 승인은 PayoutApprovals가 맡고, tick이 그 만료도 함께 부른다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import type { ApprovalReauthVerifier, OpsActor } from '../../payouts/index.js';
import {
  addBusinessDaysKst,
  approverRolesOf,
  ApprovalLifecycleProblem,
  canRequestKind,
  isLifecycleKind,
  lifecycleView,
  NOT_ALLOWED_KINDS,
  type ApprovalLifecycleRecord,
  type ApprovalLifecycleView,
  type LifecycleKind,
} from '../domain/approval-lifecycle.js';
import type {
  ApprovalEscalationAlerts,
  ApprovalLifecycleExecutors,
  ApprovalLifecycleFailureCases,
  ApprovalLifecycleStore,
  ApprovalLifecycleTargets,
  ApprovalNotifier,
} from '../domain/lifecycle-ports.js';

export interface ApprovalLifecycleDeps {
  readonly store: ApprovalLifecycleStore;
  readonly reauth: ApprovalReauthVerifier;
  readonly clock: Clock;
  readonly audit?: AuditChain;
  readonly targets?: ApprovalLifecycleTargets;
  readonly executors?: ApprovalLifecycleExecutors;
  readonly notifier?: ApprovalNotifier;
  readonly alerts?: ApprovalEscalationAlerts;
  readonly failureCases?: ApprovalLifecycleFailureCases;
  /** tick이 지급 묶음 15시 만료도 함께 본다. 없으면 지급 만료는 건너뛴다. */
  readonly payoutExpiry?: { expireDue(nowMs: number, ports: { notifier?: ApprovalNotifier; alerts?: ApprovalEscalationAlerts }): Promise<{ expired: number; failed: number }> };
}

export interface LifecycleRequestInput {
  kind: string;
  targetRef: string;
  amount: number;
  reasonCode: string;
  reasonText: string;
  evidenceChecked?: string;
  relatedOrderIds?: string[];
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApprovalLifecycleProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};
const unavailable = async (): Promise<never> => {
  throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '승인 업무 연결을 사용할 수 없습니다' });
};
const auditRecord = (recordType: string, recordId: string, payload: Record<string, unknown>, nowMs: number): AuditRecord => ({ recordType, recordId, payload, nowMs });
const open = (r: ApprovalLifecycleRecord): boolean => r.status === 'PENDING_APPROVAL' || r.status === 'ESCALATED';

export class ApprovalLifecycle {
  constructor(private readonly d: ApprovalLifecycleDeps) {}

  async request(input: LifecycleRequestInput, actor: OpsActor): Promise<ApprovalLifecycleView> {
    return guard(async () => {
      this.d.store.resetForClock?.(this.d.clock.now());
      if (!isLifecycleKind(input.kind)) throw new ApprovalLifecycleProblem('approval-kind-not-allowed', 422, '이 경로로 만들 수 없는 승인 종류입니다');
      const kind = input.kind as LifecycleKind;
      if (input.relatedOrderIds !== undefined && kind !== 'DISCRETIONARY_WAIVER') throw new ApprovalLifecycleProblem('invalid-body', 400, '여러 주문은 재량 면제에만 쓸 수 있습니다');
      if (!canRequestKind(kind, actor.role)) throw new ApprovalLifecycleProblem('approval-role-required', 403, '이 종류를 요청할 역할이 아닙니다');
      if (kind === 'MINOR_CONTRACT_CANCEL' && !input.evidenceChecked) throw new ApprovalLifecycleProblem('approval-evidence-required', 422, '증빙 확인 사실이 필요합니다');
      const basis = this.d.targets ? await this.d.targets.basis(kind, input.targetRef, input.relatedOrderIds) : await unavailable();
      if (!basis) throw notFound();
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      const relatedOrderIds = [...new Set(input.relatedOrderIds ?? [])];
      const orderCount = 1 + relatedOrderIds.length;
      let requiredApprovals: 2 | 3 = 2;
      if (kind === 'DISCRETIONARY_WAIVER') {
        const prior = basis.targetAccountId && this.d.store.list ? await this.d.store.list({ kind: 'DISCRETIONARY_WAIVER', targetAccountId: basis.targetAccountId, limit: 1000 }) : [];
        const since = nowMs - 90 * 86_400_000;
        const counted = prior.filter((r) => !['REJECTED', 'WITHDRAWN', 'EXPIRED'].includes(r.status) && r.createdAt.getTime() > since);
        if (input.amount > 300_000 || orderCount >= 2 || counted.length > 0) requiredApprovals = 3;
      }
      const approverRoles = approverRolesOf(kind, requiredApprovals);
      let dueMs = basis.dueAtMs ?? addBusinessDaysKst(nowMs, 5);
      if (kind === 'TRANSFER_RECLAIM' && basis.entryStartsAtMs !== undefined) dueMs = Math.min(dueMs, basis.entryStartsAtMs);
      const record: ApprovalLifecycleRecord = {
        approvalId: uuidv7(this.d.clock),
        kind,
        targetRef: input.targetRef,
        relatedOrderIds,
        amount: input.amount,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        evidenceChecked: input.evidenceChecked ?? null,
        targetAccountId: basis.targetAccountId,
        requesterId: actor.accountId,
        requesterRole: actor.role,
        approverRoles,
        approvals: [],
        requiredApprovals,
        status: 'PENDING_APPROVAL',
        closeReason: null,
        dueAt: new Date(dueMs),
        appealNotBefore: kind === 'TRANSFER_RECLAIM' ? new Date(nowMs + 86_400_000) : null,
        entryStartsAt: basis.entryStartsAtMs !== undefined ? new Date(basis.entryStartsAtMs) : null,
        escalatedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await this.d.store.insert(record, auditRecord('APPROVAL_REQUESTED', record.approvalId, { kind, targetRef: record.targetRef, amount: record.amount, requiredApprovals, status: record.status }, nowMs));
      return lifecycleView(record, actor);
    });
  }

  async get(approvalId: string, actor: OpsActor): Promise<ApprovalLifecycleView> {
    this.d.store.resetForClock?.(this.d.clock.now());
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    return lifecycleView(r, actor);
  }

  async find(approvalId: string): Promise<ApprovalLifecycleRecord | undefined> {
    return this.d.store.find(approvalId);
  }

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: ApprovalLifecycleView[]; nextCursor: null }> {
    this.d.store.resetForClock?.(this.d.clock.now());
    const rows = await this.d.store.list({ ...(filter.status ? { status: filter.status } : {}), limit: filter.limit });
    const items = rows
      .filter((r) => (filter.requestedByMe ? r.requesterId === actor.accountId : true))
      .filter((r) => (filter.awaitingMyApproval ? open(r) && r.requesterId !== actor.accountId && r.approverRoles.includes(actor.role) && !r.approvals.some((v) => v.approverId === actor.accountId) : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit)
      .map((r) => lifecycleView(r, actor));
    return { items, nextCursor: null };
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined, reason: string | undefined, ifMatch: string | undefined): Promise<ApprovalLifecycleView> {
    return guard(async () => {
      this.d.store.resetForClock?.(this.d.clock.now());
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      this.#assertIfMatch(r, ifMatch);
      const nowMs = this.d.clock.now();
      if (r.status === 'EXPIRED') throw new ApprovalLifecycleProblem('approval-expired', 409, '기한이 지난 승인 업무입니다');
      if (r.status === 'PENDING_APPROVAL' || r.status === 'ESCALATED') {
        const changed = await this.#targetChanged(r, nowMs);
        if (changed) {
          await this.#expire(r, 'TARGET_CHANGED', nowMs);
          throw new ApprovalLifecycleProblem('approval-target-changed', 409, '승인 대상이 바뀌었습니다');
        }
        if (nowMs >= r.dueAt.getTime()) {
          await this.#expire(r, 'DEADLINE_PASSED', nowMs);
          throw new ApprovalLifecycleProblem('approval-expired', 409, '기한이 지난 승인 업무입니다');
        }
        if (r.kind === 'TRANSFER_RECLAIM' && r.appealNotBefore && nowMs < r.appealNotBefore.getTime()) throw new ApprovalLifecycleProblem('reclaim-appeal-window', 409, '소명 기한 전에는 승인할 수 없습니다');
      } else if (r.status !== 'FAILED') {
        throw new ApprovalLifecycleProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
      }
      if (r.requesterId === actor.accountId) {
        await this.#denied(r, actor, 'SELF', nowMs);
        throw new ApprovalLifecycleProblem('approval-self-not-allowed', 403, '요청자는 승인할 수 없습니다');
      }
      if (!r.approverRoles.includes(actor.role)) {
        await this.#denied(r, actor, 'ROLE', nowMs);
        throw new ApprovalLifecycleProblem('approval-role-required', 403, '승인 역할이 아닙니다');
      }
      const verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId, act: 'APPROVAL' });
      if (verified.accountId !== actor.accountId) throw new ApprovalLifecycleProblem('reauth-required', 403, '다시 인증해 주세요');
      if (r.status === 'FAILED') return this.#execute(r, actor, nowMs);
      if (r.approvals.some((v) => v.approverId === actor.accountId)) throw new ApprovalLifecycleProblem('approval-vote-duplicate', 409, '이미 표를 냈습니다');
      const voted: ApprovalLifecycleRecord = {
        ...r,
        approvals: [...r.approvals, { approverId: actor.accountId, role: actor.role, votedAt: new Date(nowMs), reason: reason?.trim() || null }],
        status: 'PENDING_APPROVAL',
        updatedAt: new Date(nowMs),
        version: r.version + 1,
      };
      if (voted.approvals.length < r.approverRoles.length) {
        await this.#save(voted, 'APPROVAL_APPROVED', { kind: r.kind, targetRef: r.targetRef, approvals: voted.approvals.map((v) => v.approverId), status: voted.status }, nowMs);
        return lifecycleView(voted, actor);
      }
      // 마지막 표는 실행 전에 먼저 저장한다. 실행이 실패해도 표는 남아 같은 승인 ID로 다시 실행할 수 있다.
      if (!(await this.#save(voted, 'APPROVAL_APPROVED', { kind: r.kind, targetRef: r.targetRef, approvals: voted.approvals.map((v) => v.approverId), status: voted.status }, nowMs))) {
        throw new ApprovalLifecycleProblem('approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
      }
      return this.#execute(voted, actor, nowMs);
    });
  }

  async reject(approvalId: string, actor: OpsActor, reason: string, ifMatch: string | undefined): Promise<ApprovalLifecycleView> {
    return guard(async () => {
      this.d.store.resetForClock?.(this.d.clock.now());
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      this.#assertIfMatch(r, ifMatch);
      if (!open(r) && r.status !== 'FAILED') throw new ApprovalLifecycleProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
      if (r.requesterId === actor.accountId) {
        await this.#denied(r, actor, 'SELF', this.d.clock.now());
        throw new ApprovalLifecycleProblem('approval-self-not-allowed', 403, '요청자는 반려할 수 없습니다');
      }
      if (!r.approverRoles.includes(actor.role)) {
        await this.#denied(r, actor, 'ROLE', this.d.clock.now());
        throw new ApprovalLifecycleProblem('approval-role-required', 403, '승인 역할이 아닙니다');
      }
      const nowMs = this.d.clock.now();
      const next: ApprovalLifecycleRecord = { ...r, status: 'REJECTED', closeReason: reason.trim(), updatedAt: new Date(nowMs), version: r.version + 1 };
      await this.#save(next, 'APPROVAL_REJECTED', { kind: r.kind, targetRef: r.targetRef, reason: next.closeReason, status: next.status }, nowMs);
      return lifecycleView(next, actor);
    });
  }

  async withdraw(approvalId: string, actor: OpsActor, reason: string, ifMatch: string | undefined): Promise<ApprovalLifecycleView> {
    return guard(async () => {
      this.d.store.resetForClock?.(this.d.clock.now());
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      this.#assertIfMatch(r, ifMatch);
      if (r.requesterId !== actor.accountId) throw new ApprovalLifecycleProblem('approval-self-not-allowed', 403, '요청자만 철회할 수 있습니다');
      if (r.status === 'WITHDRAWN' || r.status === 'EXPIRED') return lifecycleView(r, actor);
      if (!open(r)) throw new ApprovalLifecycleProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
      const nowMs = this.d.clock.now();
      const next: ApprovalLifecycleRecord = { ...r, status: 'WITHDRAWN', closeReason: reason.trim(), updatedAt: new Date(nowMs), version: r.version + 1 };
      await this.#save(next, 'APPROVAL_WITHDRAWN', { kind: r.kind, targetRef: r.targetRef, reason: next.closeReason, status: next.status }, nowMs);
      await this.#notify(r, 'WITHDRAWN');
      return lifecycleView(next, actor);
    });
  }

  /** 5분 작업·시험이 같은 함수를 부른다. 만료·상위 알림과 지급 묶음 15시 만료를 함께 센다. */
  async tick(): Promise<{ escalated: number; expired: number; failed: number }> {
    const nowMs = this.d.clock.now();
    this.d.store.resetForClock?.(nowMs);
    let escalated = 0;
    let expired = 0;
    const rows = await this.d.store.list({ status: ['PENDING_APPROVAL', 'ESCALATED'], limit: 10_000 });
    for (const r of rows) {
      if (!open(r)) continue;
      if (await this.#targetChanged(r, nowMs)) {
        await this.#expire(r, 'TARGET_CHANGED', nowMs);
        expired += 1;
        continue;
      }
      if (nowMs >= r.dueAt.getTime()) {
        await this.#expire(r, 'DEADLINE_PASSED', nowMs);
        expired += 1;
        continue;
      }
      if (r.status === 'PENDING_APPROVAL' && r.escalatedAt === null && nowMs >= addBusinessDaysKst(r.createdAt.getTime(), 1)) {
        const next: ApprovalLifecycleRecord = { ...r, status: 'ESCALATED', escalatedAt: new Date(nowMs), updatedAt: new Date(nowMs), version: r.version + 1 };
        if (await this.#save(next, 'APPROVAL_ESCALATED', { kind: r.kind, targetRef: r.targetRef, status: next.status }, nowMs)) {
          escalated += 1;
          try {
            await this.d.alerts?.open({ approvalId: r.approvalId, kind: 'APPROVAL_ESCALATED', recipient: { kind: 'ROLE', role: 'commander' } });
          } catch {
            // 경보 실패는 승인 상태를 되돌리지 않는다
          }
        }
      }
    }
    let failed = 0;
    if (this.d.payoutExpiry) {
      try {
        const out = await this.d.payoutExpiry.expireDue(nowMs, { ...(this.d.notifier ? { notifier: this.d.notifier } : {}), ...(this.d.alerts ? { alerts: this.d.alerts } : {}) });
        expired += out.expired;
        failed += out.failed;
      } catch {
        // 지급 만료 작업 실패는 승인 수명주기 tick을 멈추지 않는다
      }
    }
    return { escalated, expired, failed };
  }

  async #execute(r: ApprovalLifecycleRecord, actor: OpsActor, nowMs: number): Promise<ApprovalLifecycleView> {
    const executors = this.d.executors;
    if (!executors) {
      await unavailable();
      throw new ApprovalLifecycleProblem('dependency-unavailable', 503, '승인 업무 연결을 사용할 수 없습니다');
    }
    const baseVersion = r.status === 'FAILED' ? r.version + 1 : r.version;
    const executing: ApprovalLifecycleRecord = { ...r, status: 'EXECUTING', updatedAt: new Date(nowMs), version: baseVersion };
    if (!(await this.#save(executing, 'APPROVAL_EXECUTING', { kind: r.kind, targetRef: r.targetRef, status: executing.status }, nowMs))) {
      throw new ApprovalLifecycleProblem('approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
    }
    try {
      if (r.kind === 'TRANSFER_RECLAIM') {
        await executors.reclaim({ approvalId: r.approvalId, targetRef: r.targetRef, targetAccountId: r.targetAccountId });
      } else {
        await executors.refund({ approvalId: r.approvalId, kind: r.kind, targetRef: r.targetRef, targetAccountId: r.targetAccountId, amount: r.amount, reasonText: r.reasonText });
      }
    } catch (e) {
      // 실행 실패는 FAILED로 남기고 같은 승인 ID로 다시 승인하면 실행만 다시 한다(T15·T16).
      const failed: ApprovalLifecycleRecord = { ...executing, status: 'FAILED', closeReason: e instanceof Error ? e.message.slice(0, 500) : 'execute-failed', updatedAt: new Date(nowMs) };
      await this.#save(failed, 'APPROVAL_FAILED', { kind: r.kind, targetRef: r.targetRef, status: failed.status }, nowMs);
      try {
        await this.d.failureCases?.failed({ approvalId: r.approvalId, kind: r.kind, dueAtMs: r.dueAt.getTime() });
      } catch {
        // 건 열기 실패는 원래 오류를 바꾸지 않는다
      }
      throw new ProblemError({ type: 'approval-execution-failed', status: 500, title: '승인 업무 실행에 실패했습니다' });
    }
    const doneMs = this.d.clock.now();
    const done: ApprovalLifecycleRecord = { ...executing, status: 'DONE', updatedAt: new Date(doneMs), version: executing.version + 1 };
    await this.#save(done, 'APPROVAL_DONE', { kind: r.kind, targetRef: r.targetRef, status: done.status }, doneMs);
    try {
      await this.d.failureCases?.succeeded(r.approvalId);
    } catch {
      // 닫기 실패는 승인 성공을 바꾸지 않는다
    }
    return lifecycleView(done, actor);
  }

  async #targetChanged(r: ApprovalLifecycleRecord, nowMs: number): Promise<boolean> {
    if (r.kind === 'TRANSFER_RECLAIM' && r.entryStartsAt && nowMs >= r.entryStartsAt.getTime()) return true;
    if (!this.d.targets) return false;
    try {
      return (await this.d.targets.changed(r.kind, r.targetRef, nowMs)) === 'TARGET_CHANGED';
    } catch {
      return false;
    }
  }

  async #expire(r: ApprovalLifecycleRecord, closeReason: 'DEADLINE_PASSED' | 'TARGET_CHANGED', nowMs: number): Promise<void> {
    const next: ApprovalLifecycleRecord = { ...r, status: 'EXPIRED', closeReason, updatedAt: new Date(nowMs), version: r.version + 1 };
    await this.#save(next, 'APPROVAL_EXPIRED', { kind: r.kind, targetRef: r.targetRef, closeReason, status: next.status }, nowMs);
    await this.#notify(r, 'EXPIRED');
  }

  async #notify(r: ApprovalLifecycleRecord, event: 'EXPIRED' | 'WITHDRAWN'): Promise<void> {
    if (!this.d.notifier) return;
    const recipients: ({ kind: 'ACCOUNT'; accountId: string } | { kind: 'ROLE'; role: 'cs_lead' | 'commander' })[] = [{ kind: 'ACCOUNT', accountId: r.requesterId }];
    for (const role of r.approverRoles) recipients.push({ kind: 'ROLE', role: role === 'commander' ? 'commander' : 'cs_lead' });
    for (const recipient of recipients) {
      try {
        await this.d.notifier.send({ approvalId: r.approvalId, event, recipient });
      } catch {
        // 알림 한 건 실패가 나머지를 막지 않는다
      }
    }
  }

  async #denied(r: ApprovalLifecycleRecord, actor: OpsActor, reason: 'SELF' | 'ROLE', nowMs: number): Promise<void> {
    try {
      await this.d.audit?.append(auditRecord('APPROVAL_DENIED', r.approvalId, { kind: r.kind, targetRef: r.targetRef, reason, actorRef: actor.accountId, status: r.status }, nowMs));
    } catch {
      // 감사 실패가 403을 바꾸지 않는다
    }
  }

  #assertIfMatch(r: ApprovalLifecycleRecord, ifMatch: string | undefined): void {
    if (ifMatch === undefined) throw new ApprovalLifecycleProblem('precondition-required', 428, 'If-Match가 필요합니다');
    const raw = ifMatch.replace(/^W\//, '').replaceAll('"', '').trim();
    if (raw !== String(r.version)) throw new ApprovalLifecycleProblem('precondition-failed', 412, '다른 사람이 먼저 바꿨습니다');
  }

  async #save(r: ApprovalLifecycleRecord, recordType: string, payload: Record<string, unknown>, nowMs: number): Promise<boolean> {
    return this.d.store.save(r, auditRecord(recordType, r.approvalId, payload, nowMs));
  }
}
