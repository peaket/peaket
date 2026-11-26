// 승인 업무 수명주기 유스케이스(F-06-3, transfer-refund §3.2·§7.2, POL-038).
// 요청·1·2인 투표·승인·반려·철회·만료·1영업일 상위 알림을 한 곳에서 다룬다.
// 실행 결과가 실제로 끝나지 않았으면(SKIPPED·REFUND_PENDING·REQUESTED) DONE으로 두지 않고 FAILED·CS 건으로 남긴다.
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
  ApprovalRefundBasis,
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
  /** BOOKING_RESTRICTION만(F-06-4). ISO 시각 */
  restrictionEndsAt?: string;
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
const open = (r: ApprovalLifecycleRecord): boolean => r.status === 'PENDING_APPROVAL' || r.status === 'ESCALATED' || r.status === 'FAILED';
/** 감사에는 계정 ID(targetRef)를 싣지 않는다(BOOKING_RESTRICTION, F-06-4) */
const auditTarget = (kind: string, targetRef: string): { targetRef?: string } => (kind === 'BOOKING_RESTRICTION' ? {} : { targetRef });
const RESTRICTION_REASONS = new Set(['ABUSE_CANCEL', 'ABUSE_TRANSFER', 'ABUSE_MULTI_ACCOUNT', 'ABUSE_RESALE']);
const addOneYear = (ms: number): number => {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
};

export class ApprovalLifecycle {
  constructor(private d: ApprovalLifecycleDeps) {}

  /** 시작 조립이 서비스 어댑터를 늦게 꽂는다(IR-01). 이미 꽂힌 실행기는 남기고 새 실행기만 더한다(F-06-4). */
  configure(ports: {
    targets?: ApprovalLifecycleDeps['targets'];
    executors?: Partial<ApprovalLifecycleExecutors>;
    notifier?: ApprovalLifecycleDeps['notifier'];
    alerts?: ApprovalLifecycleDeps['alerts'];
    failureCases?: ApprovalLifecycleDeps['failureCases'];
  }): void {
    const prev = this.d;
    const mergedExecutors = ports.executors ? ({ ...prev.executors, ...ports.executors } as ApprovalLifecycleDeps['executors']) : prev.executors;
    let mergedTargets: ApprovalLifecycleDeps['targets'] | undefined;
    if (ports.targets && prev.targets) {
      const added = ports.targets;
      const base = prev.targets;
      mergedTargets = {
        ...base,
        basis: (kind, targetRef, relatedOrderIds) =>
          kind === 'BOOKING_RESTRICTION' ? added.basis(kind, targetRef, relatedOrderIds) : base.basis(kind, targetRef, relatedOrderIds),
        changed: (kind, targetRef, nowMs) =>
          kind === 'BOOKING_RESTRICTION' ? added.changed(kind, targetRef, nowMs) : base.changed(kind, targetRef, nowMs),
        ...(base.voidCancellation ? { voidCancellation: base.voidCancellation } : {}),
      };
    }
    const nextTargets = mergedTargets ?? ports.targets ?? prev.targets;
    this.d = {
      ...prev,
      ...(nextTargets ? { targets: nextTargets } : {}),
      ...(mergedExecutors ? { executors: mergedExecutors } : {}),
      ...(ports.notifier ? { notifier: ports.notifier } : {}),
      ...(ports.alerts ? { alerts: ports.alerts } : {}),
      ...(ports.failureCases ? { failureCases: ports.failureCases } : {}),
    };
  }

  async request(input: LifecycleRequestInput, actor: OpsActor): Promise<ApprovalLifecycleView> {
    return guard(async () => {
      this.d.store.resetForClock?.(this.d.clock.now());
      if (!isLifecycleKind(input.kind)) throw new ApprovalLifecycleProblem('approval-kind-not-allowed', 422, '이 경로로 만들 수 없는 승인 종류입니다');
      const kind = input.kind as LifecycleKind;
      if (input.relatedOrderIds !== undefined && kind !== 'DISCRETIONARY_WAIVER') throw new ApprovalLifecycleProblem('invalid-body', 400, '여러 주문은 재량 면제에만 쓸 수 있습니다');
      if (!canRequestKind(kind, actor.role)) throw new ApprovalLifecycleProblem('approval-role-required', 403, '이 종류를 요청할 역할이 아닙니다');
      if (kind === 'MINOR_CONTRACT_CANCEL' && !isEvidenceChecked(input.evidenceChecked)) throw new ApprovalLifecycleProblem('approval-evidence-required', 422, '증빙 확인 사실이 필요합니다');
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      let restrictionEndsAtMs = Number.NaN;
      if (kind === 'BOOKING_RESTRICTION') {
        if (input.restrictionEndsAt === undefined) throw new ApprovalLifecycleProblem('invalid-body', 400, '제한 끝 시각이 필요합니다');
        restrictionEndsAtMs = Date.parse(input.restrictionEndsAt);
        if (!Number.isFinite(restrictionEndsAtMs)) throw new ApprovalLifecycleProblem('invalid-body', 400, '제한 끝 시각이 올바르지 않습니다');
        if (input.amount !== 0) throw new ApprovalLifecycleProblem('invalid-body', 400, '예매 제한의 금액은 0입니다');
        if (!RESTRICTION_REASONS.has(input.reasonCode)) throw new ApprovalLifecycleProblem('restriction-reason-not-allowed', 422, '이 경로로 쓸 수 없는 예매 제한 사유입니다');
        if (restrictionEndsAtMs <= nowMs) throw new ApprovalLifecycleProblem('invalid-body', 400, '제한 끝 시각이 지났습니다');
        if (restrictionEndsAtMs > addOneYear(nowMs)) throw new ApprovalLifecycleProblem('restriction-too-long', 422, '예매 제한 끝이 1년을 넘습니다');
      } else if (input.restrictionEndsAt !== undefined) {
        throw new ApprovalLifecycleProblem('invalid-body', 400, '이 종류는 제한 끝 시각을 받지 않습니다');
      }
      const basis = this.d.targets ? await this.d.targets.basis(kind, input.targetRef, input.relatedOrderIds) : await unavailable();
      if (!basis) throw notFound();
      const relatedOrderIds = [...new Set(input.relatedOrderIds ?? [])];
      const orderCount = new Set([input.targetRef, ...relatedOrderIds]).size;
      let requiredApprovals: 2 | 3 = 2;
      if (kind === 'DISCRETIONARY_WAIVER') {
        const prior = basis.targetAccountId ? await this.d.store.list({ kind: 'DISCRETIONARY_WAIVER', targetAccountId: basis.targetAccountId, limit: 1000 }) : [];
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
        expectedHolderAccountId: basis.expectedHolderAccountId ?? null,
        approverId: null,
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
        restrictionEndsAt: kind === 'BOOKING_RESTRICTION' ? new Date(restrictionEndsAtMs) : null,
        escalatedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await this.d.store.insert(record, auditRecord('APPROVAL_REQUESTED', record.approvalId, { kind, ...auditTarget(kind, record.targetRef), amount: record.amount, requiredApprovals, status: record.status }, nowMs));
      return lifecycleView(record, actor);
    });
  }

  async get(approvalId: string, actor: OpsActor): Promise<ApprovalLifecycleView> {
    this.d.store.resetForClock?.(this.d.clock.now());
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    if (r.requesterId !== actor.accountId && !r.approverRoles.includes(actor.role)) throw notFound();
    return lifecycleView(r, actor);
  }

  async find(approvalId: string): Promise<ApprovalLifecycleRecord | undefined> {
    this.d.store.resetForClock?.(this.d.clock.now());
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
      if (r.status === 'FAILED') return this.#execute({ ...r, status: 'EXECUTING', updatedAt: new Date(nowMs), version: r.version + 1 }, actor, nowMs);
      if (r.approvals.some((v) => v.approverId === actor.accountId)) throw new ApprovalLifecycleProblem('approval-vote-duplicate', 409, '이미 표를 냈습니다');
      const voted: ApprovalLifecycleRecord = {
        ...r,
        approvals: [...r.approvals, { approverId: actor.accountId, role: actor.role, votedAt: new Date(nowMs), reason: reason?.trim() || null }],
        updatedAt: new Date(nowMs),
        version: r.version + 1,
      };
      if (voted.approvals.length < r.approverRoles.length) {
        const pending: ApprovalLifecycleRecord = { ...voted, status: 'PENDING_APPROVAL' };
        if (!(await this.#save(pending, 'APPROVAL_APPROVED', { kind: r.kind, ...auditTarget(r.kind, r.targetRef), approvals: pending.approvals.map((v) => v.approverId), status: pending.status }, nowMs))) throw new ApprovalLifecycleProblem('approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
        return lifecycleView(pending, actor);
      }
      // 마지막 표는 실행 상태와 함께 한 번만 저장하되, 승인 감사도 같은 트랜잭션에 남긴다(IR-07).
      return this.#execute({ ...voted, status: 'EXECUTING' }, actor, nowMs, auditRecord('APPROVAL_APPROVED', r.approvalId, { kind: r.kind, ...auditTarget(r.kind, r.targetRef), approvals: voted.approvals.map((v) => v.approverId), status: 'EXECUTING' }, nowMs));
    });
  }

  async reject(approvalId: string, actor: OpsActor, reason: string, ifMatch: string | undefined): Promise<ApprovalLifecycleView> {
    return guard(async () => {
      this.d.store.resetForClock?.(this.d.clock.now());
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      this.#assertIfMatch(r, ifMatch);
      if (!open(r)) throw new ApprovalLifecycleProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
      if (r.requesterId === actor.accountId) {
        await this.#denied(r, actor, 'SELF', this.d.clock.now());
        throw new ApprovalLifecycleProblem('approval-self-not-allowed', 403, '요청자는 반려할 수 없습니다');
      }
      if (!r.approverRoles.includes(actor.role)) {
        await this.#denied(r, actor, 'ROLE', this.d.clock.now());
        throw new ApprovalLifecycleProblem('approval-role-required', 403, '승인 역할이 아닙니다');
      }
      const nowMs = this.d.clock.now();
      const next: ApprovalLifecycleRecord = { ...r, status: 'REJECTED', closeReason: reason.trim(), approverId: actor.accountId, updatedAt: new Date(nowMs), version: r.version + 1 };
      await this.#save(next, 'APPROVAL_REJECTED', { kind: r.kind, ...auditTarget(r.kind, r.targetRef), reason: next.closeReason, approverId: actor.accountId, status: next.status }, nowMs);
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
      await this.#save(next, 'APPROVAL_WITHDRAWN', { kind: r.kind, ...auditTarget(r.kind, r.targetRef), reason: next.closeReason, status: next.status }, nowMs);
      await this.#notify(r, 'WITHDRAWN');
      return lifecycleView(next, actor);
    });
  }

  /** 5분 작업·시험이 같은 함수를 부른다. 만료·상위 알림·고착 실행 복구와 지급 묶음 15시 만료를 함께 센다. */
  async tick(): Promise<{ escalated: number; expired: number; failed: number }> {
    if (this.d.store.withTickLease) return (await this.d.store.withTickLease(() => this.#tickInner())) ?? { escalated: 0, expired: 0, failed: 0 };
    return this.#tickInner();
  }

  async #tickInner(): Promise<{ escalated: number; expired: number; failed: number }> {
    const nowMs = this.d.clock.now();
    this.d.store.resetForClock?.(nowMs);
    let escalated = 0;
    let expired = 0;
    let failed = 0;
    const rows = await this.d.store.list({ status: ['PENDING_APPROVAL', 'ESCALATED', 'EXECUTING'], limit: 10_000 });
    for (const r of rows) {
      if (r.status === 'EXECUTING') {
        if (nowMs >= r.dueAt.getTime()) {
          const failedRow: ApprovalLifecycleRecord = { ...r, status: 'FAILED', closeReason: 'DEADLINE_PASSED', updatedAt: new Date(nowMs) };
          if (await this.#save(failedRow, 'APPROVAL_FAILED', { kind: r.kind, ...auditTarget(r.kind, r.targetRef), status: failedRow.status, closeReason: failedRow.closeReason }, nowMs)) {
            failed += 1;
            try {
              await this.d.failureCases?.failed({ approvalId: r.approvalId, kind: r.kind, dueAtMs: r.dueAt.getTime() });
            } catch {
              // 건 열기 실패는 FAILED를 되돌리지 않는다
            }
          }
          continue;
        }
        try {
          await this.#runExecution(r, { accountId: r.requesterId, sessionId: 'system', role: 'system' }, nowMs);
        } catch {
          failed += 1;
        }
        continue;
      }
      if (!open(r)) continue;
      if (r.approvals.length >= r.approverRoles.length) {
        try {
          await this.#execute({ ...r, status: 'EXECUTING', updatedAt: new Date(nowMs), version: r.version + 1 }, { accountId: r.requesterId, sessionId: 'system', role: 'system' }, nowMs);
        } catch {
          failed += 1;
        }
        continue;
      }
      if (await this.#targetChanged(r, nowMs)) {
        if (await this.#expire(r, 'TARGET_CHANGED', nowMs)) expired += 1;
        continue;
      }
      if (nowMs >= r.dueAt.getTime()) {
        if (await this.#expire(r, 'DEADLINE_PASSED', nowMs)) expired += 1;
        continue;
      }
      if (r.status === 'PENDING_APPROVAL' && r.escalatedAt === null && nowMs >= addBusinessDaysKst(r.createdAt.getTime(), 1)) {
        const next: ApprovalLifecycleRecord = { ...r, status: 'ESCALATED', escalatedAt: new Date(nowMs), updatedAt: new Date(nowMs), version: r.version + 1 };
        if (await this.#save(next, 'APPROVAL_ESCALATED', { kind: r.kind, ...auditTarget(r.kind, r.targetRef), status: next.status }, nowMs)) {
          escalated += 1;
          try {
            await this.d.alerts?.open({ approvalId: r.approvalId, kind: 'APPROVAL_ESCALATED', recipient: { kind: 'ROLE', role: 'commander' } });
          } catch {
            // 경보 실패는 승인 상태를 되돌리지 않는다
          }
        }
      }
    }
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

  /** 실행 상태(EXECUTING)를 이미 저장한 레코드를 실제로 실행한다. 실패·SKIPPED는 FAILED로 남긴다. */
  async #execute(r: ApprovalLifecycleRecord, actor: OpsActor, nowMs: number, extraAudit?: AuditRecord): Promise<ApprovalLifecycleView> {
    if (this.d.executors) {
      const executingAudit = auditRecord('APPROVAL_EXECUTING', r.approvalId, { kind: r.kind, ...auditTarget(r.kind, r.targetRef), status: r.status }, nowMs);
      if (!(await this.d.store.save(r, extraAudit ? [extraAudit, executingAudit] : executingAudit))) throw new ApprovalLifecycleProblem('approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
    } else {
      await unavailable();
    }
    return this.#runExecution(r, actor, nowMs);
  }

  async #runExecution(executing: ApprovalLifecycleRecord, actor: OpsActor, nowMs: number): Promise<ApprovalLifecycleView> {
    const executors = this.d.executors;
    if (!executors) {
      await unavailable();
      throw new Error('unreachable');
    }
    let outcome: string;
    try {
      if (executing.kind === 'BOOKING_RESTRICTION') {
        if (!executors.restriction) await unavailable();
        const r = await executors.restriction!({
          approvalId: executing.approvalId,
          targetRef: executing.targetRef,
          reasonCode: executing.reasonCode,
          restrictionEndsAtMs: executing.restrictionEndsAt?.getTime() ?? executing.dueAt.getTime(),
          approvedBy: executing.approvals.at(-1)?.approverId ?? null,
        });
        if (r.status === 'PENDING') return lifecycleView(executing, actor);
        outcome = 'REFUNDED';
      } else if (executing.kind === 'TRANSFER_RECLAIM') {
        if (!executors.reclaim) await unavailable();
        const r = await executors.reclaim({ approvalId: executing.approvalId, targetRef: executing.targetRef, targetAccountId: executing.targetAccountId, expectedHolderAccountId: executing.expectedHolderAccountId, deadlineMs: executing.dueAt.getTime() });
        outcome = r.result;
      } else {
        if (!executors.refund) await unavailable();
        const r = await executors.refund({ approvalId: executing.approvalId, kind: executing.kind, targetRef: executing.targetRef, ...(executing.relatedOrderIds.length > 0 ? { orderIds: [executing.targetRef, ...executing.relatedOrderIds] } : {}), targetAccountId: executing.targetAccountId, amount: executing.amount, reasonText: executing.reasonText });
        outcome = r.status;
      }
    } catch (e) {
      const failed: ApprovalLifecycleRecord = { ...executing, status: 'FAILED', closeReason: e instanceof Error ? e.message.slice(0, 500) : 'execute-failed', updatedAt: new Date(nowMs) };
      await this.#save(failed, 'APPROVAL_FAILED', { kind: executing.kind, ...auditTarget(executing.kind, executing.targetRef), status: failed.status }, nowMs);
      try {
        await this.d.failureCases?.failed({ approvalId: executing.approvalId, kind: executing.kind, dueAtMs: executing.dueAt.getTime() });
      } catch {
        // 건 열기 실패는 원래 오류를 바꾸지 않는다
      }
      throw new ProblemError({ type: 'approval-execution-failed', status: 500, title: '승인 업무 실행에 실패했습니다' });
    }
    if (executing.kind === 'TRANSFER_RECLAIM' ? outcome !== 'RECLAIMED' : !['REFUNDED', 'REFUND_PENDING', 'REQUESTED'].includes(outcome)) {
      const failed: ApprovalLifecycleRecord = { ...executing, status: 'FAILED', closeReason: outcome, updatedAt: new Date(nowMs) };
      await this.#save(failed, 'APPROVAL_FAILED', { kind: executing.kind, ...auditTarget(executing.kind, executing.targetRef), status: failed.status, outcome }, nowMs);
      try {
        await this.d.failureCases?.failed({ approvalId: executing.approvalId, kind: executing.kind, dueAtMs: executing.dueAt.getTime() });
      } catch {
        // 건 열기 실패는 FAILED를 되돌리지 않는다
      }
      return lifecycleView(failed, actor);
    }
    const doneMs = this.d.clock.now();
    const done: ApprovalLifecycleRecord = { ...executing, status: 'DONE', updatedAt: new Date(doneMs), version: executing.version + 1 };
    await this.#save(done, 'APPROVAL_DONE', { kind: executing.kind, ...auditTarget(executing.kind, executing.targetRef), status: done.status }, doneMs);
    try {
      await this.d.failureCases?.succeeded(executing.approvalId);
    } catch {
      // 닫기 실패는 승인 성공을 바꾸지 않는다
    }
    return lifecycleView(done, actor);
  }

  /**
   * FLAGGED 처리 행동의 승인 근거(IR-11·IR-30). 대상이 취소 ID면 purchase basis가 주문 ID로 풀어 준다.
   * 근거가 없으면 undefined(404)이고, 남은 환급액이 없으면 0이다(0원 승인을 만들지 않는 것은 부르는 쪽이 본다)
   */
  async refundBasis(targetRef: string): Promise<ApprovalRefundBasis | undefined> {
    const b = await this.d.targets?.basis('SYSTEM_FAULT_REFUND', targetRef);
    if (!b) return undefined;
    return {
      orderId: b.orderId ?? targetRef,
      refundableAmount: typeof b.refundableAmount === 'number' ? b.refundableAmount : 0,
      entryRecorded: b.entryRecorded === true,
      ...(b.issueGeneration !== undefined ? { issueGeneration: b.issueGeneration } : {}),
      ...(b.eventId !== undefined ? { eventId: b.eventId } : {}),
      ...(b.ticketIds !== undefined ? { ticketIds: b.ticketIds } : {}),
      ...(b.cancellationState !== undefined ? { cancellationState: b.cancellationState } : {}),
    };
  }

  /** 승인 업무의 남은 환급액을 대상 포트에서 읽는다(IR-11). 없으면 0 */
  async refundableAmount(targetRef: string): Promise<number> {
    return (await this.refundBasis(targetRef))?.refundableAmount ?? 0;
  }

  /** FLAGGED 취소 무효(IR-30). 실행기가 없으면 503 */
  async voidOrder(orderId: string, reason: string, o: { issueGeneration?: number; eventId?: string; ticketIds?: readonly string[] } = {}): Promise<{ voided: number; alreadyEntered: number }> {
    if (!this.d.executors?.voidOrder) await unavailable();
    return this.d.executors!.voidOrder!({
      orderId,
      reason,
      ...(o.issueGeneration !== undefined ? { issueGeneration: o.issueGeneration } : {}),
      ...(o.eventId !== undefined ? { eventId: o.eventId } : {}),
      ...(o.ticketIds !== undefined ? { ticketIds: o.ticketIds } : {}),
    });
  }

  /** FLAGGED 취소 무효 뒤 purchase의 기존 취소 행을 VOIDED로 끝낸다(IR-30). 포트가 없으면 503, 바꾼 행이 없으면 false */
  async voidCancellation(cancellationId: string): Promise<boolean> {
    if (!this.d.targets?.voidCancellation) await unavailable();
    return this.d.targets!.voidCancellation!(cancellationId);
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

  async #expire(r: ApprovalLifecycleRecord, closeReason: 'DEADLINE_PASSED' | 'TARGET_CHANGED', nowMs: number): Promise<boolean> {
    const next: ApprovalLifecycleRecord = { ...r, status: 'EXPIRED', closeReason, updatedAt: new Date(nowMs), version: r.version + 1 };
    if (!(await this.#save(next, 'APPROVAL_EXPIRED', { kind: r.kind, ...auditTarget(r.kind, r.targetRef), closeReason, status: next.status }, nowMs))) return false;
    await this.#notify(r, 'EXPIRED');
    return true;
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
      await this.d.audit?.append(auditRecord('APPROVAL_DENIED', r.approvalId, { kind: r.kind, ...auditTarget(r.kind, r.targetRef), reason, actorRef: actor.accountId, status: r.status }, nowMs));
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

function isEvidenceChecked(value: string | undefined): boolean {
  return value === 'PHONE_VERIFICATION' || (typeof value === 'string' && value.startsWith('DOCUMENT:') && value.length > 'DOCUMENT:'.length);
}
