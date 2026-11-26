// 지급 묶음 2인 승인·실행 유스케이스(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039).
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import type { ApprovalReauthVerifier, PayoutApprovalStore, PayoutPaymentClient, SettlementPaymentClient } from '../domain/ports.js';
import type { ApprovalFailureCases } from '../../cases/index.js';
import {
  approvalDueAt,
  payoutApprovalFacts,
  payoutApprovalView,
  PayoutApprovalProblem,
  statementDisputeView,
  type StatementDisputeView,
  type PayoutApprovalFacts,
  type PayoutApprovalRecord,
  type PayoutApprovalView,
  type PayoutBatchView,
} from '../domain/payout-approval.js';

export interface PayoutApprovalDeps {
  readonly store: PayoutApprovalStore;
  readonly payments: PayoutPaymentClient;
  readonly reauth: ApprovalReauthVerifier;
  readonly clock: Clock;
  /** 상태 저장과 같은 트랜잭션에 쓰지 못하는 감사(수기 포트원 실행)에 쓴다 */
  readonly audit?: AuditChain;
  /** payment-svc 정산서 이의 기각(F-07-5). 없으면 503 */
  readonly settlements?: SettlementPaymentClient;
  /** 실행 실패 때 CS '승인 업무 실행 실패' 건을 열고(기한은 이 승인의 기한) 다시 실행이 성공하면 닫는다(F-06-2 ADR-0364 결정 6) */
  readonly failureCases?: ApprovalFailureCases;
}

const auditRecord = (recordType: string, recordId: string, payload: Record<string, unknown>, nowMs: number): AuditRecord => ({ recordType, recordId, payload, nowMs });
/** 지급 승인 감사에 원본 대조용 고정 값(묶음·결제사·금액·요청자) */
const payoutBase = (r: PayoutApprovalRecord): Record<string, unknown> => ({
  batchId: r.batchId,
  pg: r.pg,
  pgStore: r.pgStore,
  payoutDate: r.payoutDate,
  amount: r.amount,
  statementCount: r.statementCount,
  requesterId: r.requesterId,
});

export interface OpsActor {
  accountId: string;
  sessionId: string;
  role: string;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PayoutApprovalProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

export class PayoutApprovals {
  constructor(private readonly d: PayoutApprovalDeps) {}

  async request(input: { pg: 'TOSS' | 'PORTONE'; pgStore?: 'STANDARD' | 'ESCROW' | undefined; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; reasonText?: string }, actor: OpsActor): Promise<{ batch: PayoutBatchView; approval: PayoutApprovalView }> {
    return guard(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.payoutDate)) throw new PayoutApprovalProblem('invalid-query', 422, '지급일이 맞지 않습니다');
      if (input.reasonText !== undefined && input.reasonText.trim() === '') throw new PayoutApprovalProblem('invalid-query', 422, '요청 사유가 필요합니다');
      if (input.pg === 'TOSS' && !input.pgStore) throw new PayoutApprovalProblem('invalid-query', 422, '토스페이먼츠는 결제 상점이 필요합니다');
      if (input.pg === 'PORTONE' && !input.portoneBalance) throw new PayoutApprovalProblem('invalid-query', 422, '포트원 지급대행 계좌 잔액이 필요합니다');
      const batch = await this.d.payments.createBatch({
        pg: input.pg,
        pgStore: input.pgStore ?? 'STANDARD',
        payoutDate: input.payoutDate,
        ...(input.portoneBalance ? { portoneBalance: input.portoneBalance } : {}),
        actor: actor.accountId,
      });
      const now = new Date(this.d.clock.now());
      const record: PayoutApprovalRecord = {
        approvalId: uuidv7(this.d.clock),
        batchId: batch.batchId,
        pg: batch.pg,
        pgStore: batch.pgStore,
        payoutDate: batch.payoutDate,
        amount: batch.totalAmount,
        statementCount: batch.statementCount,
        status: 'PENDING_APPROVAL',
        requesterId: actor.accountId,
        requesterRole: actor.role,
        approverId: null,
        reasonText: input.reasonText?.trim() || '지급 묶음 승인 요청',
        failure: null,
        createdAt: now,
        updatedAt: now,
        approvedAt: null,
        executedAt: null,
        version: 1,
      };
      await this.d.store.insert(
        record,
        auditRecord(
          'PAYOUT_APPROVAL_REQUESTED',
          record.approvalId,
          { ...payoutBase(record), reasonText: record.reasonText, status: record.status },
          record.createdAt.getTime(),
        ),
      );
      return { batch: { ...batch, approvalId: record.approvalId }, approval: payoutApprovalView(record, actor) };
    });
  }

  async list(filter: { status?: readonly string[] | undefined; awaitingMyApproval?: boolean | undefined; requestedByMe?: boolean | undefined; limit: number }, actor: OpsActor): Promise<{ items: PayoutApprovalView[]; nextCursor: null }> {
    const rows = await this.d.store.list({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.requestedByMe ? { requesterId: actor.accountId } : {}),
      ...(filter.awaitingMyApproval ? { awaitingApprover: actor.accountId } : {}),
      limit: filter.limit,
    });
    return { items: rows.map((r) => payoutApprovalView(r, actor)), nextCursor: null };
  }

  async get(approvalId: string, actor: OpsActor): Promise<PayoutApprovalView> {
    const r = await this.d.store.find(approvalId);
    if (!r) throw notFound();
    if (r.requesterId !== actor.accountId && actor.role !== 'commander' && actor.role !== 'cs_lead') throw notFound();
    return payoutApprovalView(r, actor);
  }

  /** payment-svc가 부르는 내부 사실 조회(서비스 사이 토큰 가드 뒤). 없으면 undefined(404). */
  async facts(approvalId: string): Promise<PayoutApprovalFacts | undefined> {
    const r = await this.d.store.find(approvalId);
    return r ? payoutApprovalFacts(r) : undefined;
  }

  /** 통합 승인함(지급 + commander 역할 변경)이 종류를 가릴 때 쓴다. 볼 수 없는 승인은 null(없는 것과 같은 404) */
  async findView(approvalId: string, actor: OpsActor): Promise<PayoutApprovalView | null> {
    const r = await this.d.store.find(approvalId);
    if (!r) return null;
    if (r.requesterId !== actor.accountId && actor.role !== 'commander' && actor.role !== 'cs_lead') return null;
    return payoutApprovalView(r, actor);
  }

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined): Promise<PayoutApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw new PayoutApprovalProblem('payout-batch-not-approved', 409, '승인 대기 중인 지급 묶음이 아닙니다');
      if (r.requesterId === actor.accountId) throw new PayoutApprovalProblem('approval-self-not-allowed', 403, '요청자는 승인할 수 없습니다');
      if (actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 승인할 수 있습니다');
      const verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId, act: 'APPROVAL' });
      if (verified.accountId !== actor.accountId) throw new PayoutApprovalProblem('reauth-required', 403, '다시 인증해 주세요');
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      const executing: PayoutApprovalRecord = { ...r, status: 'EXECUTING', approverId: actor.accountId, approvedAt: now, updatedAt: now, version: r.version + 1 };
      // EXECUTING 상태와 감사를 같은 트랜잭션에 쓴다. 감사 append가 실패하면 상태도 PENDING_APPROVAL로 남는다(OPSV-01).
      if (!(await this.d.store.save(executing, auditRecord('PAYOUT_BATCH_EXECUTING', executing.approvalId, { ...payoutBase(executing), status: executing.status }, nowMs))))
        throw new PayoutApprovalProblem('payout-approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
      let executed = false;
      try {
        await this.d.payments.approveBatch(r.batchId, r.approvalId);
        await this.d.payments.executeBatch(r.batchId);
        executed = true;
        const doneMs = this.d.clock.now();
        const done: PayoutApprovalRecord = { ...executing, status: 'DONE', executedAt: new Date(doneMs), updatedAt: new Date(doneMs), version: executing.version + 1 };
        // 성공 상태와 감사도 같은 트랜잭션에 쓴다. 이 append가 실패하면 DONE은 롤백되고 EXECUTING이 남는다.
        await this.d.store.save(
          done,
          auditRecord('PAYOUT_BATCH_DONE', done.approvalId, { ...payoutBase(done), status: done.status }, doneMs),
        );
        await this.#caseSucceeded(done.approvalId, doneMs);
        return payoutApprovalView(done, actor);
      } catch (e) {
        // 지급대행이 이미 성공한 뒤의 감사 실패를 FAILED로 바꾸지 않는다(성공을 실패로 보고하지 않는다).
        if (!executed) {
          const failedMs = this.d.clock.now();
          const failed: PayoutApprovalRecord = { ...executing, status: 'FAILED', failure: e instanceof Error ? e.message.slice(0, 500) : 'execute-failed', updatedAt: new Date(failedMs), version: executing.version + 1 };
          await this.d.store.save(
            failed,
            auditRecord('PAYOUT_BATCH_FAILED', failed.approvalId, { ...payoutBase(failed), status: failed.status, failure: failed.failure }, failedMs),
          );
          await this.#caseFailed(failed, failedMs);
        }
        throw e;
      }
    });
  }

  async reject(approvalId: string, actor: OpsActor, reason: string): Promise<PayoutApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw new PayoutApprovalProblem('payout-batch-not-approved', 409, '승인 대기 중인 지급 묶음이 아닙니다');
      if (r.requesterId === actor.accountId) throw new PayoutApprovalProblem('approval-self-not-allowed', 403, '요청자는 반려할 수 없습니다');
      if (actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 반려할 수 있습니다');
      if (reason.trim() === '') throw new PayoutApprovalProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      // 반려하면 payment-svc의 배치·정산서 결속을 풀어 같은 지급일의 새 배치를 만들 수 있게 한다(CONS-V02).
      await this.d.payments.releaseBatch(r.batchId);
      const next: PayoutApprovalRecord = { ...r, status: 'REJECTED', approverId: actor.accountId, reasonText: reason.trim(), updatedAt: now, version: r.version + 1 };
      if (!(await this.d.store.save(next, auditRecord('PAYOUT_APPROVAL_REJECTED', next.approvalId, { ...payoutBase(next), status: next.status, reason: next.reasonText }, nowMs))))
        throw new PayoutApprovalProblem('payout-approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
      return payoutApprovalView(next, actor);
    });
  }

  async #audit(recordType: string, recordId: string, actorRef: string, payload: Record<string, unknown>, nowMs: number): Promise<void> {
    await this.d.audit?.append({ recordType, recordId, payload: { ...payload, actorRef }, nowMs });
  }

  async recordPortoneExecution(batchId: string, bulkPayoutId: string, actor: string): Promise<PayoutBatchView> {
    const batch = await this.d.payments.recordPortoneExecution(batchId, bulkPayoutId);
    // 수기 포트원 일괄 지급 실행은 돈이 나간 기록이다. 실행 배치·금액·행위자·근거를 감사에 남긴다(settlement §5.4)
    await this.#audit('PAYOUT_PORTONE_EXECUTION', batch.batchId, actor, {
      batchId: batch.batchId,
      bulkPayoutId,
      pg: 'PORTONE',
      status: batch.status,
      amount: batch.totalAmount,
      statementCount: batch.statementCount,
      basis: 'PORTONE_CONSOLE',
    }, this.d.clock.now());
    return batch;
  }

  listBatches(filter: { payoutDate?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchView[]> {
    return this.d.payments.listBatches(filter);
  }

  getBatchDetail(batchId: string) {
    return this.d.payments.getBatchDetail(batchId);
  }

  /** 보증금·이행보증보험 충당(settlement §7). commander가 재인증한 뒤 payment-svc에 넘긴다. */
  async collectGuarantee(
    receivableId: string,
    input: { actor: OpsActor; reason: string; idempotencyKey: string; reauthToken: string | undefined },
  ): Promise<unknown> {
    return guard(async () => {
      if (input.reason.trim() === '') throw new PayoutApprovalProblem('invalid-body', 400, '보증 충당 사유가 필요합니다');
      if (input.actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 보증 충당을 할 수 있습니다');
      const verified = await this.d.reauth.verify(input.reauthToken, { sessionId: input.actor.sessionId, act: 'APPROVAL' });
      if (verified.accountId !== input.actor.accountId) throw new PayoutApprovalProblem('reauth-required', 403, '다시 인증해 주세요');
      const out = (await this.d.payments.collectGuarantee(receivableId, {
        actor: input.actor.accountId,
        sessionId: input.actor.sessionId,
        ...(input.reauthToken ? { reauthToken: input.reauthToken } : {}),
        idempotencyKey: input.idempotencyKey,
        reason: input.reason.trim(),
      })) as { collection?: { amount?: unknown }; receivable?: { promoterId?: unknown } };
      await this.#audit('RECEIVABLE_GUARANTEE_COLLECTED', receivableId, input.actor.accountId, {
        receivableId,
        amount: out.collection?.amount ?? null,
        promoterId: out.receivable?.promoterId ?? null,
        idempotencyKey: input.idempotencyKey,
      }, this.d.clock.now());
      return out;
    });
  }

  async billReceivable(
    receivableId: string,
    input: { actor: OpsActor; reason: string; idempotencyKey: string; reauthToken: string | undefined },
  ): Promise<unknown> {
    return this.#receivableAction('BILLED', receivableId, input);
  }

  async collectReceivable(
    receivableId: string,
    input: { actor: OpsActor; reason: string; idempotencyKey: string; reauthToken: string | undefined; amount: number },
  ): Promise<unknown> {
    return this.#receivableAction('COLLECTED', receivableId, input);
  }

  async writeOffReceivable(
    receivableId: string,
    input: { actor: OpsActor; reason: string; idempotencyKey: string; reauthToken: string | undefined },
  ): Promise<unknown> {
    return this.#receivableAction('WRITE_OFF', receivableId, input);
  }

  async #receivableAction(
    kind: 'BILLED' | 'COLLECTED' | 'WRITE_OFF',
    receivableId: string,
    input: { actor: OpsActor; reason: string; idempotencyKey: string; reauthToken: string | undefined; amount?: number },
  ): Promise<unknown> {
    if (input.reason.trim() === '') throw new PayoutApprovalProblem('invalid-body', 400, '사유가 필요합니다');
    if (input.actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 미수금을 옮길 수 있습니다');
    let verified: { accountId: string; factors: string[] };
    try {
      verified = await this.d.reauth.verify(input.reauthToken, { sessionId: input.actor.sessionId, act: 'APPROVAL' });
    } catch (e) {
      if ((e as { status?: unknown }).status === 503) throw new PayoutApprovalProblem('reauth-unavailable', 503, '재인증을 확인하지 못했습니다');
      throw new PayoutApprovalProblem('reauth-required', 403, '다시 인증해 주세요');
    }
    if (verified.accountId !== input.actor.accountId) throw new PayoutApprovalProblem('reauth-required', 403, '다시 인증해 주세요');
    const base = {
      actor: input.actor.accountId,
      sessionId: input.actor.sessionId,
      ...(input.reauthToken ? { reauthToken: input.reauthToken } : {}),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason.trim(),
    };
    const payments = this.d.payments;
    if ((kind === 'BILLED' && !payments.billReceivable) || (kind === 'COLLECTED' && !payments.collectReceivable) || (kind === 'WRITE_OFF' && !payments.writeOffReceivable)) {
      throw new PayoutApprovalProblem('settlement-unavailable', 503, '정산 서비스를 쓸 수 없습니다');
    }
    const out =
      kind === 'BILLED'
        ? await payments.billReceivable!(receivableId, base)
        : kind === 'COLLECTED'
          ? await payments.collectReceivable!(receivableId, { ...base, amount: input.amount! })
          : await payments.writeOffReceivable!(receivableId, base);
    const result = out as { action?: { amount?: unknown }; amount?: unknown; receivable?: { promoterId?: unknown } };
    await this.#audit(`RECEIVABLE_${kind === 'WRITE_OFF' ? 'WRITTEN_OFF' : kind}`, receivableId, input.actor.accountId, {
      receivableId,
      amount: result.action?.amount ?? result.amount ?? null,
      reason: input.reason.trim(),
      promoterId: result.receivable?.promoterId ?? null,
      idempotencyKey: input.idempotencyKey,
    }, this.d.clock.now());
    return out;
  }

  listStatements(filter: { kind?: string | undefined; status?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; payoutDate?: string | undefined; limit: number }): Promise<unknown[]> {
    return this.d.payments.listStatements(filter);
  }

  listReceivables(filter: { limit: number }): Promise<unknown[]> {
    return this.d.payments.listReceivables(filter);
  }

  /** CS '승인 업무 실행 실패' 건 열기(기한은 이 지급 승인의 기한). 건을 못 열어도 승인 응답을 바꾸지 않는다 */
  async #caseFailed(r: PayoutApprovalRecord, nowMs: number): Promise<void> {
    try {
      await this.d.failureCases?.failed({ approvalId: r.approvalId, kind: 'PAYOUT_BATCH', dueAtMs: approvalDueAt(r.payoutDate).getTime() }, nowMs);
    } catch {
      // 건 열기 실패는 승인 결과와 무관하다
    }
  }

  /** 다시 실행이 성공하면 그 건을 시스템이 닫는다 */
  async #caseSucceeded(approvalId: string, nowMs: number): Promise<void> {
    try {
      await this.d.failureCases?.succeeded(approvalId, nowMs);
    } catch {
      // 닫기 실패는 승인 성공을 바꾸지 않는다
    }
  }

  dueAt(payoutDate: string): Date {
    return approvalDueAt(payoutDate);
  }

  /**
   * 정산 이의 기각(settlement §4.2 '기각', ADR-0368 결정 6). cs_lead만, 사유 1~2,000자. payment-svc가 열린 이의를 DISMISSED로 닫고
   * 정산서를 NOTIFIED(1영업일)로 돌린다. ops 감사에는 행위자·정산서·사유 길이만 남긴다(사유 원문은 payment에만).
   */
  async dismissStatementDispute(statementId: string, reason: string, actor: OpsActor): Promise<StatementDisputeView> {
    return guard(async () => {
      if (actor.role !== 'cs_lead') throw new PayoutApprovalProblem('approval-role-required', 403, 'cs_lead만 정산 이의를 기각할 수 있습니다');
      const text = reason.trim();
      if (text.length < 1 || reason.length > 2_000) throw new PayoutApprovalProblem('invalid-body', 400, '기각 사유는 1~2,000자입니다');
      if (!this.d.settlements) throw new PayoutApprovalProblem('settlement-dependency-unavailable', 503, '정산 서비스에 연결하지 못했습니다');
      const out = await this.d.settlements.dismissDispute(statementId, { reason: text, actorId: actor.accountId });
      await this.#audit('SETTLEMENT_DISPUTE_DISMISSED', statementId, actor.accountId, { statementId, reasonLength: text.length }, this.d.clock.now());
      // CS 역할에게는 정산서 이의 칸만 넘긴다(결제사·계좌·묶음·결제 ID 없음, 리뷰 RV-03)
      return statementDisputeView(out);
    });
  }
}
