// 계약 조건 변경 승인 업무 유스케이스(BAT-615 LCH-070, ADR-0320 결정 2·3·9, POL-038 ⑨).
// 요청은 core가 내부 경로로 만들고, 승인·반려·철회는 ops가 상태·투표·감사를 같은 트랜잭션에 쓴 뒤 core에 적용한다.
// 승인 실패는 FAILED로 남기고 같은 승인 ID로 다시 승인하면 core가 한 번만 적용한다(ADR-0073).
import { ProblemError, uuidv7 } from '@peaket/platform';
import type { AuditRecord } from '../../audit/audit.js';
import {
  assertCanDecide,
  canSeeContractApproval,
  contractApprovalView,
  ContractApprovalProblem,
  hasRequestedChange,
  type ContractApprovalRecord,
  type ContractApprovalView,
  type ContractTermsSnapshot,
  type GuaranteeKind,
  type OpsActor,
} from '../domain/approval.js';
import type { ApprovalVote, ContractApprovalDeps } from '../domain/ports.js';

export interface ContractChangeCreateInput {
  approvalId: string;
  kind: string;
  targetRef: string;
  requestedBy: { accountId: string; role: string };
  reasonText: string;
  current: ContractTermsSnapshot;
  requested: { commissionRateBp: number; guaranteeRateBp: number; guaranteeKind: GuaranteeKind };
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const invalid = (title: string) => new ContractApprovalProblem('invalid-query', 422, title);
/** 도메인 오류를 플랫폼 Problem으로 바꾼다(도메인 층은 바깥 의존을 모른다) */
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ContractApprovalProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

const bp = (name: string, v: number): void => {
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw invalid(`${name}은 0~10,000 사이 정수(만분율)여야 합니다`);
};

const auditOf = (recordType: string, r: ContractApprovalRecord, extra: Record<string, unknown>, nowMs: number): AuditRecord => ({
  recordType,
  recordId: r.approvalId,
  payload: {
    approvalId: r.approvalId,
    promoterId: r.promoterId,
    status: r.status,
    requestedCommissionRateBp: r.requestedCommissionRateBp,
    requestedGuaranteeRateBp: r.requestedGuaranteeRateBp,
    requestedGuaranteeKind: r.requestedGuaranteeKind,
    requesterId: r.requestedBy,
    ...extra,
  },
  nowMs,
});

export class ContractApprovals {
  constructor(private readonly d: ContractApprovalDeps) {}

  /** core-svc 내부 경로가 부른다. 같은 승인 ID 재호출은 같은 답(멱등) */
  async createFromCore(input: ContractChangeCreateInput): Promise<ContractApprovalView> {
    return guard(async () => {
      if (input.kind !== 'CONTRACT_TERMS_CHANGE') throw invalid('이 경로는 CONTRACT_TERMS_CHANGE만 만듭니다');
    const existing = await this.d.store.find(input.approvalId);
    if (existing) return contractApprovalView(existing, { accountId: input.requestedBy.accountId, sessionId: '', role: input.requestedBy.role });
    const reason = input.reasonText.trim();
    if (reason.length < 1 || reason.length > 2_000) throw invalid('변경 사유는 1~2,000자여야 합니다');
    bp('수수료율', input.current.commissionRateBp);
    bp('보증 비율', input.current.guaranteeRateBp);
    bp('요청 수수료율', input.requested.commissionRateBp);
    bp('요청 보증 비율', input.requested.guaranteeRateBp);
    const same =
      input.requested.commissionRateBp === input.current.commissionRateBp &&
      input.requested.guaranteeRateBp === input.current.guaranteeRateBp &&
      input.requested.guaranteeKind === input.current.guaranteeKind;
    if (same) throw invalid('바꿀 칸이 없거나 지금 값과 같습니다');
    const now = new Date(this.d.clock.now());
    const record: ContractApprovalRecord = {
      approvalId: input.approvalId,
      promoterId: input.targetRef,
      current: input.current,
      requestedCommissionRateBp: input.requested.commissionRateBp,
      requestedGuaranteeRateBp: input.requested.guaranteeRateBp,
      requestedGuaranteeKind: input.requested.guaranteeKind,
      requestedBy: input.requestedBy.accountId,
      requesterRole: input.requestedBy.role,
      reasonText: reason,
      status: 'PENDING_APPROVAL',
      closeReason: null,
      approverId: null,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      version: 1,
    };
    if (!hasRequestedChange(record)) throw invalid('바꿀 칸이 없습니다');
    const out = await this.d.store.insert(record, auditOf('CONTRACT_CHANGE_REQUESTED', record, { reasonText: reason }, now.getTime()));
    if (out === 'conflict') throw new ProblemError({ type: 'contract-change-pending', status: 409, title: '이미 승인 대기 중인 계약 변경이 있습니다' });
    return contractApprovalView(out.record, { accountId: input.requestedBy.accountId, sessionId: '', role: input.requestedBy.role });
    });
  }

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: ContractApprovalView[]; nextCursor: null }> {
    const rows = await this.d.store.list({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.requestedByMe ? { requesterId: actor.accountId } : {}),
      ...(filter.awaitingMyApproval ? { awaitingApprover: actor.accountId } : {}),
      limit: filter.limit,
    });
    return { items: rows.filter((r) => canSeeContractApproval(r, actor)).map((r) => contractApprovalView(r, actor)), nextCursor: null };
  }

  async get(approvalId: string, actor: OpsActor): Promise<ContractApprovalView> {
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    if (!canSeeContractApproval(r, actor)) throw notFound();
    return contractApprovalView(r, actor);
  }

  /** 라우터가 지급 승인과 구분할 때 쓴다. 없거나 볼 수 없으면 undefined */
  async tryGet(approvalId: string, actor: OpsActor): Promise<ContractApprovalView | undefined> {
    const r = await this.d.store.find(approvalId);
    if (!r || !canSeeContractApproval(r, actor)) return undefined;
    return contractApprovalView(r, actor);
  }

  /** 이 ID가 계약 승인인가(가시성과 무관). 판정 경로가 지급 승인으로 새지 않게 한다 */
  async exists(approvalId: string): Promise<boolean> {
    return (await this.d.store.find(approvalId)) !== undefined;
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined, reason?: string): Promise<ContractApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      assertCanDecide(r, actor, 'approve');
    const verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId, act: 'APPROVAL' });
    if (verified.accountId !== actor.accountId) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    const voteReason = reason?.trim();
    if (voteReason !== undefined && voteReason.length > 1_000) throw invalid('판단 이유는 1,000자까지입니다');
    const nowMs = this.d.clock.now();
    const now = new Date(nowMs);
    // EXECUTING에 남은 승인은 core 적용까지 끝났지만 DONE·투표·감사 저장이 실패한 상태다.
    // 같은 승인 ID로 다시 승인하면 core 적용은 멱등이라 그대로 두고 남은 저장만 마친다(RV-06). EXECUTING 감사는 다시 쓰지 않는다.
    const alreadyExecuting = r.status === 'EXECUTING';
    const executing: ContractApprovalRecord = { ...r, status: 'EXECUTING', approverId: actor.accountId, updatedAt: now, version: r.version + 1 };
    // EXECUTING과 감사를 같은 트랜잭션에 쓴다. 감사가 실패하면 상태도 PENDING_APPROVAL로 남는다
    if (!alreadyExecuting && !(await this.d.store.save(executing, auditOf('CONTRACT_CHANGE_EXECUTING', executing, { approverId: actor.accountId }, nowMs)))) {
      throw new ProblemError({ type: 'contract-approval-conflict', status: 409, title: '다른 사람이 먼저 처리했습니다' });
    }
    const base = alreadyExecuting ? { ...r, approverId: actor.accountId, updatedAt: now } : executing;
    try {
      await this.d.core.apply({
        promoterId: r.promoterId,
        approvalId: r.approvalId,
        ...(r.requestedCommissionRateBp !== null ? { commissionRateBp: r.requestedCommissionRateBp } : {}),
        ...(r.requestedGuaranteeRateBp !== null ? { guaranteeRateBp: r.requestedGuaranteeRateBp } : {}),
        ...(r.requestedGuaranteeKind !== null ? { guaranteeKind: r.requestedGuaranteeKind } : {}),
        approvedAt: now,
        approverId: actor.accountId,
      });
    } catch (e) {
      const failedMs = this.d.clock.now();
      const failed: ContractApprovalRecord = { ...base, status: 'FAILED', closeReason: e instanceof Error ? e.message.slice(0, 500) : 'contract-apply-failed', updatedAt: new Date(failedMs), version: base.version + 1 };
      await this.d.store.save(failed, auditOf('CONTRACT_CHANGE_FAILED', failed, { failure: failed.closeReason }, failedMs));
      throw new ProblemError({ type: 'contract-apply-failed', status: 503, title: '계약 조건을 적용하지 못했습니다' });
    }
    const doneMs = this.d.clock.now();
    const done: ContractApprovalRecord = { ...base, status: 'DONE', approvedAt: new Date(doneMs), updatedAt: new Date(doneMs), version: base.version + 1 };
    const vote: ApprovalVote = { approvalId: done.approvalId, approverId: actor.accountId, requesterId: r.requestedBy, approvedAt: done.approvedAt ?? new Date(doneMs), reason: voteReason ? voteReason : null };
    // 성공 상태·투표·감사를 같은 트랜잭션에 쓴다. 이 쓰기가 실패하면 DONE은 롤백되고 EXECUTING이 남는다.
    // core는 이미 적용했으므로 실패로 보고하지 않는다(같은 승인 ID 재적용은 멱등).
    if (!(await this.d.store.save(done, auditOf('CONTRACT_CHANGE_APPROVED', done, { approverId: actor.accountId, approvedAt: done.approvedAt?.toISOString() }, doneMs), vote))) {
      throw new ProblemError({ type: 'contract-approval-conflict', status: 409, title: '다른 사람이 먼저 처리했습니다' });
    }
    return contractApprovalView(done, actor);
    });
  }

  async reject(approvalId: string, actor: OpsActor, reason: string): Promise<ContractApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      assertCanDecide(r, actor, 'reject');
    const text = reason.trim();
    if (text.length < 1 || text.length > 2_000) throw invalid('반려 사유는 1~2,000자여야 합니다');
    // 지금 계약을 바꾸지 않는다. core의 승인 대기 표시를 먼저 풀고(멱등) ops 상태를 쓴다
    await this.d.core.cancel({ promoterId: r.promoterId, approvalId: r.approvalId, reason: text });
    const nowMs = this.d.clock.now();
    const next: ContractApprovalRecord = { ...r, status: 'REJECTED', approverId: actor.accountId, closeReason: text, updatedAt: new Date(nowMs), version: r.version + 1 };
    if (!(await this.d.store.save(next, auditOf('CONTRACT_CHANGE_REJECTED', next, { approverId: actor.accountId, reason: text }, nowMs)))) {
      throw new ProblemError({ type: 'contract-approval-conflict', status: 409, title: '다른 사람이 먼저 처리했습니다' });
    }
    return contractApprovalView(next, actor);
    });
  }

  /** 요청자만 철회한다. 반려와 같이 지금 계약은 바뀌지 않고 core의 대기 표시를 푼다 */
  async withdraw(approvalId: string, actor: OpsActor, reason: string): Promise<ContractApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      if (r.requestedBy !== actor.accountId) throw notFound();
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw new ProblemError({ type: 'contract-approval-not-pending', status: 409, title: '승인 대기 중인 계약 변경이 아닙니다' });
    const text = reason.trim();
    if (text.length < 1 || text.length > 2_000) throw invalid('철회 사유는 1~2,000자여야 합니다');
    await this.d.core.cancel({ promoterId: r.promoterId, approvalId: r.approvalId, reason: text });
    const nowMs = this.d.clock.now();
    const next: ContractApprovalRecord = { ...r, status: 'WITHDRAWN', closeReason: text, updatedAt: new Date(nowMs), version: r.version + 1 };
    if (!(await this.d.store.save(next, auditOf('CONTRACT_CHANGE_WITHDRAWN', next, { reason: text }, nowMs)))) {
      throw new ProblemError({ type: 'contract-approval-conflict', status: 409, title: '다른 사람이 먼저 처리했습니다' });
    }
    return contractApprovalView(next, actor);
    });
  }

  /** 승인 업무 ID를 만든다(core가 넘긴 ID가 없을 때만 쓰는 시험·도구용) */
  newApprovalId(): string {
    return uuidv7(this.d.clock);
  }
}
