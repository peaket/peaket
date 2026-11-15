// 지급 묶음 2인 승인·실행 유스케이스(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039).
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { AuditChain } from '../../audit/audit.js';
import type { ApprovalReauthVerifier, PayoutApprovalStore, PayoutPaymentClient } from '../domain/ports.js';
import { approvalDueAt, payoutApprovalView, PayoutApprovalProblem, type PayoutApprovalRecord, type PayoutApprovalView, type PayoutBatchView } from '../domain/payout-approval.js';

export interface PayoutApprovalDeps {
  readonly store: PayoutApprovalStore;
  readonly payments: PayoutPaymentClient;
  readonly reauth: ApprovalReauthVerifier;
  readonly clock: Clock;
  /** 지급 승인 요청·승인·반려·실행·재시도를 감사 체인에 남긴다 */
  readonly audit?: AuditChain;
}

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
        reasonText: input.reasonText?.trim() || '지급 묶음 확인 요청',
        failure: null,
        createdAt: now,
        updatedAt: now,
        approvedAt: null,
        executedAt: null,
        version: 1,
      };
      await this.d.store.insert(record);
      await this.#audit('PAYOUT_APPROVAL_REQUESTED', record.approvalId, actor.accountId, { batchId: record.batchId, amount: record.amount, payoutDate: record.payoutDate, status: record.status }, this.d.clock.now());
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
      if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw new PayoutApprovalProblem('payout-batch-not-approved', 409, '승인 대기 중인 지급 묶음이 아닙니다');
      if (r.requesterId === actor.accountId) throw new PayoutApprovalProblem('approval-self-not-allowed', 403, '요청자는 승인할 수 없습니다');
      if (actor.role !== 'commander') throw new PayoutApprovalProblem('approval-role-required', 403, 'commander만 승인할 수 있습니다');
      const verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId, act: 'APPROVAL' });
      if (verified.accountId !== actor.accountId) throw new PayoutApprovalProblem('reauth-required', 403, '다시 인증해 주세요');
      const now = new Date(this.d.clock.now());
      const retry = r.status === 'FAILED';
      const executing: PayoutApprovalRecord = { ...r, status: 'EXECUTING', approverId: actor.accountId, approvedAt: now, updatedAt: now, version: r.version + 1 };
      if (!(await this.d.store.save(executing))) throw new PayoutApprovalProblem('payout-approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
      await this.#audit(retry ? 'PAYOUT_APPROVAL_RETRIED' : 'PAYOUT_APPROVAL_APPROVED', r.approvalId, actor.accountId, { batchId: r.batchId, amount: r.amount, status: 'EXECUTING' }, this.d.clock.now());
      try {
        await this.d.payments.approveBatch(r.batchId, r.approvalId);
        await this.d.payments.executeBatch(r.batchId);
        const done: PayoutApprovalRecord = { ...executing, status: 'DONE', executedAt: new Date(this.d.clock.now()), updatedAt: new Date(this.d.clock.now()), version: executing.version + 1 };
        await this.d.store.save(done);
        await this.#audit('PAYOUT_APPROVAL_EXECUTED', r.approvalId, actor.accountId, { batchId: r.batchId, amount: r.amount, status: 'DONE' }, this.d.clock.now());
        return payoutApprovalView(done, actor);
      } catch (e) {
        const failed: PayoutApprovalRecord = { ...executing, status: 'FAILED', failure: e instanceof Error ? e.message.slice(0, 500) : 'execute-failed', updatedAt: new Date(this.d.clock.now()), version: executing.version + 1 };
        await this.d.store.save(failed);
        await this.#audit('PAYOUT_APPROVAL_FAILED', r.approvalId, actor.accountId, { batchId: r.batchId, amount: r.amount, status: 'FAILED' }, this.d.clock.now());
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
      if (reason.trim() === '') throw new PayoutApprovalProblem('invalid-query', 422, '반려 사유가 필요합니다');
      const now = new Date(this.d.clock.now());
      const next: PayoutApprovalRecord = { ...r, status: 'REJECTED', approverId: actor.accountId, reasonText: reason.trim(), updatedAt: now, version: r.version + 1 };
      if (!(await this.d.store.save(next))) throw new PayoutApprovalProblem('payout-approval-conflict', 409, '다른 사람이 먼저 처리했습니다');
      await this.#audit('PAYOUT_APPROVAL_REJECTED', r.approvalId, actor.accountId, { batchId: r.batchId, amount: r.amount, reason: reason.trim(), status: 'REJECTED' }, this.d.clock.now());
      return payoutApprovalView(next, actor);
    });
  }

  async #audit(recordType: string, recordId: string, actorRef: string, payload: Record<string, unknown>, nowMs: number): Promise<void> {
    await this.d.audit?.append({ recordType, recordId, payload: { ...payload, actorRef }, nowMs });
  }

  async recordPortoneExecution(batchId: string, bulkPayoutId: string, actor: string): Promise<PayoutBatchView> {
    const batch = await this.d.payments.recordPortoneExecution(batchId, bulkPayoutId);
    // 수기 포트원 일괄 지급 실행은 돈이 나간 기록이다. 실행 배치·금액·행위자·근거를 감사에 남긴다(settlement §5.4)
    await this.#audit('PAYOUT_PORTONE_EXECUTED', batchId, actor, {
      batchId,
      bulkPayoutId,
      totalAmount: batch.totalAmount,
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
