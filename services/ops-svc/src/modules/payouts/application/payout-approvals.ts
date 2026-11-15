// 지�?묶음 2???�인·?�행 ?�스케?�스(BUILD_ORDER BAT-610 ?�여, FR-062, POL-038·039).
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import type { ApprovalReauthVerifier, PayoutApprovalStore, PayoutPaymentClient } from '../domain/ports.js';
import { approvalDueAt, payoutApprovalView, PayoutApprovalProblem, type PayoutApprovalRecord, type PayoutApprovalView, type PayoutBatchView } from '../domain/payout-approval.js';

export interface PayoutApprovalDeps {
  readonly store: PayoutApprovalStore;
  readonly payments: PayoutPaymentClient;
  readonly reauth: ApprovalReauthVerifier;
  readonly clock: Clock;
  /** ?�태 ?�?�과 같�? ?�랜??��???��? 못하??감사(?�기 ?�트???�행)???�다 */
  readonly audit?: AuditChain;
}

const auditRecord = (recordType: string, recordId: string, payload: Record<string, unknown>, nowMs: number): AuditRecord => ({ recordType, recordId, payload, nowMs });
/** 지�??�인 감사???�본 ?�조용 고정 �?묶음·결제??�금?�·요�?��) */
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

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 ???�습?�다' });
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
        reasonText: input.reasonText?.trim() || '지�?묶음 ?�인 ?�청',
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

  async approve(approvalId: string, actor: OpsActor, reauthToken: string | undefined): Promise<PayoutApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw new PayoutApprovalProblem('payout-batch-not-approved', 409, '?�인 ?��?중인 지�?묶음???�닙?�다');
      if (r.requesterId === actor.accountId) throw new PayoutApprovalProblem('approval-self-not-allowed', 403, '?�청?�는 ?�인?????�습?�다');
      if (actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 승인할 수 있습니다');
      const verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId, act: 'APPROVAL' });
      if (verified.accountId !== actor.accountId) throw new PayoutApprovalProblem('reauth-required', 403, '다시 인증해 주세요');
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      const executing: PayoutApprovalRecord = { ...r, status: 'EXECUTING', approverId: actor.accountId, approvedAt: now, updatedAt: now, version: r.version + 1 };
      // EXECUTING ?�태?� 감사�?같�? ?�랜??��???�다. 감사 append가 ?�패?�면 ?�태??PENDING_APPROVAL�??�는??OPSV-01).
      if (!(await this.d.store.save(executing, auditRecord('PAYOUT_BATCH_EXECUTING', executing.approvalId, { ...payoutBase(executing), status: executing.status }, nowMs))))
        throw new PayoutApprovalProblem('payout-approval-conflict', 409, '?�른 ?�람??먼�? 처리?�습?�다');
      let executed = false;
      try {
        await this.d.payments.approveBatch(r.batchId, r.approvalId);
        await this.d.payments.executeBatch(r.batchId);
        executed = true;
        const doneMs = this.d.clock.now();
        const done: PayoutApprovalRecord = { ...executing, status: 'DONE', executedAt: new Date(doneMs), updatedAt: new Date(doneMs), version: executing.version + 1 };
        // ?�공 ?�태?� 감사??같�? ?�랜??��???�다. ??append가 ?�패?�면 DONE?� 롤백?�고 EXECUTING???�는??
        await this.d.store.save(
          done,
          auditRecord('PAYOUT_BATCH_DONE', done.approvalId, { ...payoutBase(done), status: done.status }, doneMs),
        );
        return payoutApprovalView(done, actor);
      } catch (e) {
        // 지급�??�이 ?��? ?�공???�의 감사 ?�패�?FAILED�?바꾸지 ?�는???�공???�패�?보고?��? ?�는??.
        if (!executed) {
          const failedMs = this.d.clock.now();
          const failed: PayoutApprovalRecord = { ...executing, status: 'FAILED', failure: e instanceof Error ? e.message.slice(0, 500) : 'execute-failed', updatedAt: new Date(failedMs), version: executing.version + 1 };
          await this.d.store.save(
            failed,
            auditRecord('PAYOUT_BATCH_FAILED', failed.approvalId, { ...payoutBase(failed), status: failed.status, failure: failed.failure }, failedMs),
          );
        }
        throw e;
      }
    });
  }

  async reject(approvalId: string, actor: OpsActor, reason: string): Promise<PayoutApprovalView> {
    return guard(async () => {
      const r = await this.d.store.find(approvalId);
      if (!r) throw notFound();
      if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw new PayoutApprovalProblem('payout-batch-not-approved', 409, '?�인 ?��?중인 지�?묶음???�닙?�다');
      if (r.requesterId === actor.accountId) throw new PayoutApprovalProblem('approval-self-not-allowed', 403, '요청자는 반려할 수 없습니다');
      if (actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 반려할 수 있습니다');
      if (reason.trim() === '') throw new PayoutApprovalProblem('invalid-query', 422, '반려 사유가 필요합니다');
      const nowMs = this.d.clock.now();
      const now = new Date(nowMs);
      const next: PayoutApprovalRecord = { ...r, status: 'REJECTED', approverId: actor.accountId, reasonText: reason.trim(), updatedAt: now, version: r.version + 1 };
      if (!(await this.d.store.save(next, auditRecord('PAYOUT_APPROVAL_REJECTED', next.approvalId, { ...payoutBase(next), status: next.status, reason: next.reasonText }, nowMs))))
        throw new PayoutApprovalProblem('payout-approval-conflict', 409, '?�른 ?�람??먼�? 처리?�습?�다');
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

  listStatements(filter: { kind?: string | undefined; status?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; payoutDate?: string | undefined; limit: number }): Promise<unknown[]> {
    return this.d.payments.listStatements(filter);
  }

  listReceivables(filter: { limit: number }): Promise<unknown[]> {
    return this.d.payments.listReceivables(filter);
  }

  dueAt(payoutDate: string): Date {
    return approvalDueAt(payoutDate);
  }
}
