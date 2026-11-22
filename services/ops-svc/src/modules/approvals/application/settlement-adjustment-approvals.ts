// 정산서 수기 조정 승인 업무 유스케이스(F-07-5 LCH-100, ADR-0368 결정 7·8·9, POL-038 ⑦, settlement §4.3).
// 요청: cs_lead가 부르면 승인 업무 ID를 먼저 정해(sha256('settlement-adjustment:<계정>:<멱등 키>') 앞 16바이트) payment-svc에 조정 행을 PENDING으로 등록하고,
//       그다음 공통 승인 표에 승인 업무를 만든다. payment가 거절하면(4xx) 승인 업무를 만들지 않는다. 같은 멱등 키는 같은 승인 업무다.
// 승인: 요청자가 아닌 commander가 act=APPROVAL 재인증 뒤 승인하면 투표·EXECUTING·감사를 한 트랜잭션에 쓰고 payment 적용을 부른다.
//       성공이면 DONE, 실패면 FAILED(같은 승인을 다시 부르면 다시 적용한다. payment는 ops 승인 기록과 대조해 적용하고, 재적용은 처음 결과다).
// 반려: REJECTED 뒤 payment 조정 행을 VOID로 닫는다(실패해도 7일 [가정] 뒤 payment 일꾼이 닫는다).
import { createHash } from 'node:crypto';
import { ProblemError, type Clock } from '@peaket/platform';
import type { AuditRecord } from '../../audit/audit.js';
import type { ApprovalReauthVerifier, OpsActor, SettlementPaymentClient } from '../../payouts/index.js';
import {
  ADJUSTMENT_REASON_TEXT_MAX,
  assertCanDecideAdjustment,
  canSeeSettlementAdjustmentApproval,
  ContractApprovalProblem,
  settlementAdjustmentApprovalFacts,
  settlementAdjustmentApprovalView,
  type SettlementAdjustmentApprovalFacts,
  type SettlementAdjustmentApprovalRecord,
  type SettlementAdjustmentApprovalView,
} from '../domain/approval.js';
import type { ApprovalVote, SettlementAdjustmentApprovalStore } from '../domain/ports.js';

export interface SettlementAdjustmentApprovalDeps {
  readonly store: SettlementAdjustmentApprovalStore;
  readonly payments: SettlementPaymentClient;
  readonly reauth: ApprovalReauthVerifier;
  readonly clock: Clock;
}

export interface SettlementAdjustmentRequestInput {
  amount: number;
  reasonCode: string;
  disputeId?: string | undefined;
  evidenceNote?: string | undefined;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ContractApprovalProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

/** 계정·멱등 키에서 정한 승인 업무 ID(UUID 꼴, 판 8). 같은 계정의 같은 키는 같은 ID다 */
export function settlementAdjustmentApprovalId(accountId: string, idempotencyKey: string): string {
  const b = createHash('sha256').update(`settlement-adjustment:${accountId}:${idempotencyKey}`, 'utf8').digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const auditOf = (recordType: string, r: SettlementAdjustmentApprovalRecord, extra: Record<string, unknown>, nowMs: number): AuditRecord => ({
  recordType,
  recordId: r.approvalId,
  // 근거 메모 원문은 payment에만 있다. 감사에는 정산서·금액·사유 코드·요청자·상태만 남긴다
  payload: { approvalId: r.approvalId, statementId: r.statementId, amount: r.amount, reasonCode: r.reasonCode, requesterId: r.requestedBy, status: r.status, ...extra },
  nowMs,
});

const CONFLICT = () => new ProblemError({ type: 'approval-conflict', status: 409, title: '다른 사람이 먼저 처리했습니다' });

export class SettlementAdjustmentApprovals {
  constructor(private readonly d: SettlementAdjustmentApprovalDeps) {}

  /** cs_lead의 조정 요청(202). 같은 멱등 키 재요청은 같은 승인 업무이고, 다른 내용이면 422 idempotency-key-reused다 */
  async request(statementId: string, input: SettlementAdjustmentRequestInput, idempotencyKey: string, actor: OpsActor): Promise<SettlementAdjustmentApprovalView> {
    return guard(async () => {
      if (actor.role !== 'cs_lead') throw new ContractApprovalProblem('approval-role-required', 403, 'cs_lead만 정산서 조정을 요청할 수 있습니다');
      const approvalId = settlementAdjustmentApprovalId(actor.accountId, idempotencyKey);
      const existing = await this.d.store.find(approvalId);
      if (existing) {
        if (existing.statementId !== statementId || existing.amount !== input.amount || existing.reasonCode !== input.reasonCode) {
          throw new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다' });
        }
        return settlementAdjustmentApprovalView(existing, actor);
      }
      // 검사(사유 코드·이의 대조·상태)는 정산서를 가진 payment가 한다. 거절(4xx)이면 승인 업무를 만들지 않는다
      const row = await this.d.payments.registerAdjustment(statementId, {
        approvalId,
        amount: input.amount,
        reasonCode: input.reasonCode,
        requestedBy: actor.accountId,
        ...(input.disputeId !== undefined ? { disputeId: input.disputeId } : {}),
        ...(input.evidenceNote !== undefined ? { evidenceNote: input.evidenceNote } : {}),
      });
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      const record: SettlementAdjustmentApprovalRecord = {
        approvalId,
        statementId,
        amount: row.amount,
        reasonCode: row.reasonCode,
        reasonText: (input.evidenceNote ?? '').trim().slice(0, ADJUSTMENT_REASON_TEXT_MAX),
        requestedBy: actor.accountId,
        requesterRole: actor.role,
        status: 'PENDING_APPROVAL',
        closeReason: null,
        approverId: null,
        approvals: [],
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      const out = await this.d.store.insert(record, auditOf('SETTLEMENT_ADJUSTMENT_REQUESTED', record, { disputeId: row.disputeId }, nowMs));
      return settlementAdjustmentApprovalView(out.record, actor);
    });
  }

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: SettlementAdjustmentApprovalView[]; nextCursor: null }> {
    const rows = await this.d.store.list({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.requestedByMe ? { requesterId: actor.accountId } : {}),
      ...(filter.awaitingMyApproval ? { awaitingApprover: actor.accountId } : {}),
      limit: filter.limit,
    });
    return { items: rows.filter((r) => canSeeSettlementAdjustmentApproval(r, actor)).map((r) => settlementAdjustmentApprovalView(r, actor)), nextCursor: null };
  }

  async get(approvalId: string, actor: OpsActor): Promise<SettlementAdjustmentApprovalView> {
    const r = await this.d.store.find(approvalId);
    if (!r || !canSeeSettlementAdjustmentApproval(r, actor)) throw notFound();
    return settlementAdjustmentApprovalView(r, actor);
  }

  /** 라우터가 종류를 가를 때 쓴다(가시성과 무관). 판정 경로가 지급 승인으로 새지 않게 한다 */
  async exists(approvalId: string): Promise<boolean> {
    return (await this.d.store.find(approvalId)) !== undefined;
  }

  /** payment-svc 내부 사실 조회. 없으면 undefined(404) */
  async facts(approvalId: string): Promise<SettlementAdjustmentApprovalFacts | undefined> {
    const r = await this.d.store.find(approvalId);
    return r ? settlementAdjustmentApprovalFacts(r) : undefined;
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined, reason?: string): Promise<SettlementAdjustmentApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      assertCanDecideAdjustment(r, actor, 'approve');
      const verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId, act: 'APPROVAL' });
      if (verified.accountId !== actor.accountId) throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
      const voteReason = reason?.trim();
      if (voteReason !== undefined && voteReason.length > 1_000) throw new ContractApprovalProblem('invalid-query', 422, '판단 이유는 1,000자까지입니다');
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      // 투표·EXECUTING·감사를 한 트랜잭션에 쓴다. payment는 이 기록(EXECUTING·2인·승인 시각)과 대조해야만 적용한다(ADR-0368 결정 8)
      const vote: ApprovalVote = { approvalId, approverId: actor.accountId, requesterId: r.requestedBy, approvedAt: now, reason: voteReason ? voteReason : null };
      const executing: SettlementAdjustmentApprovalRecord = { ...r, status: 'EXECUTING', approverId: actor.accountId, updatedAt: now, version: r.version + 1 };
      if (!(await this.d.store.save(executing, auditOf('SETTLEMENT_ADJUSTMENT_EXECUTING', executing, { approverId: actor.accountId }, nowMs), vote))) throw CONFLICT();
      try {
        await this.d.payments.applyAdjustment(approvalId);
      } catch (e) {
        const failedMs = this.d.clock.now();
        const failed: SettlementAdjustmentApprovalRecord = { ...executing, status: 'FAILED', closeReason: e instanceof Error ? e.message.slice(0, 500) : 'adjustment-apply-failed', updatedAt: new Date(failedMs), version: executing.version + 1 };
        await this.d.store.save(failed, auditOf('SETTLEMENT_ADJUSTMENT_FAILED', failed, { approverId: actor.accountId, failure: failed.closeReason }, failedMs));
        // payment의 4xx(대조 불일치 409·상태 409)는 그대로, 5xx·연결 실패는 클라이언트가 503으로 바꿔 던진다
        throw e;
      }
      const doneMs = this.d.clock.now();
      const done: SettlementAdjustmentApprovalRecord = { ...executing, status: 'DONE', closeReason: null, updatedAt: new Date(doneMs), version: executing.version + 1 };
      // payment 적용은 이미 끝났다. DONE 저장이 실패해 EXECUTING이 남아도 같은 승인을 다시 부르면 payment가 처음 결과를 준다
      if (!(await this.d.store.save(done, auditOf('SETTLEMENT_ADJUSTMENT_APPROVED', done, { approverId: actor.accountId }, doneMs)))) throw CONFLICT();
      return settlementAdjustmentApprovalView((await this.d.store.find(approvalId)) ?? done, actor);
    });
  }

  async reject(approvalId: string, actor: OpsActor, reason: string): Promise<SettlementAdjustmentApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      assertCanDecideAdjustment(r, actor, 'reject');
      const text = reason.trim();
      if (text.length < 1 || text.length > 2_000) throw new ContractApprovalProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
      const nowMs = this.d.clock.now();
      const next: SettlementAdjustmentApprovalRecord = { ...r, status: 'REJECTED', approverId: actor.accountId, closeReason: text, updatedAt: new Date(nowMs), version: r.version + 1 };
      if (!(await this.d.store.save(next, auditOf('SETTLEMENT_ADJUSTMENT_REJECTED', next, { approverId: actor.accountId, reasonLength: text.length }, nowMs)))) throw CONFLICT();
      try {
        await this.d.payments.voidAdjustment(approvalId);
      } catch {
        // payment가 답하지 않아도 반려는 남는다. 승인 기록이 REJECTED라 payment는 적용하지 않고, 7일 [가정] 뒤 일꾼이 VOID로 닫는다
      }
      return settlementAdjustmentApprovalView(next, actor);
    });
  }
}
