// 정산서·지급 묶음·KYC 유스케이스(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, ADR-0047·0062).
// 결제 원장은 payment-svc의 payment 표만 읽고, 상품 주문 원천은 아직 없다(상품 정산서는 빈 목록).
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { PayoutGateway, ReauthVerifier, SettlementPaymentSource, SettlementStore, StatementFilter } from '../domain/ports.js';
import {
  accountLast4,
  addBusinessDays,
  calculateEventStatement,
  dateOnly,
  payoutBatchView,
  SettlementProblem,
  statementView,
  validateDispute,
  validatePayoutAccount,
  type DisputeRecord,
  type KycRecord,
  type KycStatus,
  type PayoutBatchRecord,
  type PayoutRecord,
  type Pg,
  type PgStore,
  type StatementRecord,
  type StatementView,
} from '../domain/settlement.js';

export interface SettlementDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly gateways: readonly PayoutGateway[];
  readonly reauth: ReauthVerifier;
  readonly clock: Clock;
  readonly commissionRateBp?: number;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SettlementProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

const parseIfMatch = (value: string | undefined): number => {
  if (value === undefined) throw new ProblemError({ type: 'precondition-required', status: 428, title: '고칠 판(If-Match)을 보내 주세요' });
  const m = /^"(\d+)"$/.exec(value.trim());
  if (!m) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
  return Number(m[1]);
};

export class Settlements {
  constructor(private readonly d: SettlementDeps) {}

  async listEvent(promoterId: string, eventId: string): Promise<StatementView[]> {
    return (await this.d.store.listEvent(promoterId, eventId)).map(statementView);
  }

  async listProduct(promoterId: string, filter: StatementFilter): Promise<{ items: StatementView[]; nextCursor: string | null; awaitingSettlementAmount: number }> {
    const page = await this.d.store.listProduct(promoterId, filter);
    return { items: page.items.map(statementView), nextCursor: page.nextCursor, awaitingSettlementAmount: 0 };
  }

  async dispute(promoterId: string, accountId: string, statementId: string, body: { reasonCode: string; detail?: string | undefined }): Promise<void> {
    return guard(async () => {
      validateDispute(body.reasonCode, body.detail);
      const s = await this.d.store.findStatement(promoterId, statementId);
      if (!s) throw notFound();
      const now = new Date(this.d.clock.now());
      if (s.status !== 'NOTIFIED' && s.status !== 'HELD') throw new SettlementProblem('settlement-not-disputable', 409, '지금은 이의를 낼 수 없는 정산서입니다');
      if (s.disputeDueAt && now.getTime() > s.disputeDueAt.getTime()) throw new SettlementProblem('settlement-dispute-window-closed', 409, '이의 기간이 끝났습니다');
      const dispute: DisputeRecord = {
        disputeId: uuidv7(this.d.clock),
        statementId,
        reasonCode: body.reasonCode as DisputeRecord['reasonCode'],
        detail: body.detail ?? '',
        submittedBy: accountId,
        submittedAt: now,
        result: null,
        resolvedAt: null,
      };
      await this.d.store.insertDispute(dispute);
      await this.d.store.saveStatement({ ...s, status: 'DISPUTED', updatedAt: now });
    });
  }

  /** 회차 정산서 한 판을 계산한다. 결제 원장·KYC·계좌를 한 트랜잭션 밖에서 읽고 저장한다. */
  async calculateEvent(input: { promoterId: string; eventId: string; pg: Pg; pgStore: PgStore; commissionRateBp?: number }): Promise<StatementView> {
    return guard(async () => {
      const existing = await this.d.store.findEventStatement(input.promoterId, input.eventId, input.pg, input.pgStore);
      if (existing) return statementView(existing);
      const now = new Date(this.d.clock.now());
      const [payments, kyc, account] = await Promise.all([this.d.payments.listEventPayments(input.eventId, input.pg), this.d.store.findKyc(input.promoterId), this.d.store.findPayoutAccount(input.promoterId)]);
      const { record, sources } = calculateEventStatement({
        promoterId: input.promoterId,
        eventId: input.eventId,
        pg: input.pg,
        pgStore: input.pgStore,
        commissionRateBp: input.commissionRateBp ?? this.d.commissionRateBp ?? 1000,
        payments,
        kyc,
        account,
        now,
        statementId: uuidv7(this.d.clock),
      });
      await this.d.store.insertStatement(record, sources);
      return statementView(record);
    });
  }

  async confirmDue(statementId: string): Promise<StatementView> {
    return guard(async () => {
      const s = await this.d.store.findStatementById(statementId);
      if (!s) throw notFound();
      const now = new Date(this.d.clock.now());
      if (s.status === 'NOTIFIED' && (!s.disputeDueAt || now.getTime() >= s.disputeDueAt.getTime())) {
        const next = { ...s, status: 'CONFIRMED' as const, updatedAt: now };
        await this.d.store.saveStatement(next);
        return statementView(next);
      }
      return statementView(s);
    });
  }

  async recordKyc(promoterId: string, status: KycStatus, o: { businessVerified?: boolean; representativeVerified?: boolean; source?: string } = {}): Promise<KycRecord> {
    const now = new Date(this.d.clock.now());
    const record: KycRecord = {
      promoterId,
      status,
      businessVerified: o.businessVerified ?? status === 'VERIFIED',
      representativeVerified: o.representativeVerified ?? status === 'VERIFIED',
      verifiedAt: status === 'VERIFIED' ? now : null,
      source: o.source ?? 'MANUAL',
      updatedAt: now,
    };
    await this.d.store.saveKyc(record);
    return record;
  }

  async createPayoutBatch(input: { pg: Pg; pgStore: PgStore; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const now = new Date(this.d.clock.now());
      const existing = await this.d.store.listPayoutBatches({ pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, status: ['PENDING_APPROVAL', 'APPROVED', 'SUBMITTED'], limit: 1 });
      if (existing.length > 0) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
      const confirmed = await this.d.store.listConfirmed(input.pg, input.pgStore, input.payoutDate);
      const included: StatementRecord[] = [];
      let heldKyc = 0;
      let heldAccount = 0;
      for (const s of confirmed) {
        const kyc = await this.d.store.findKyc(s.promoterId);
        if (kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified) {
          const account = await this.d.store.findPayoutAccount(s.promoterId);
          if (account && account.holdUntil.getTime() > now.getTime()) {
            heldAccount += 1;
            await this.d.store.saveStatement({ ...s, status: 'HELD', holdReason: 'ACCOUNT_CHANGE', updatedAt: now });
            continue;
          }
          included.push(s);
        } else {
          heldKyc += 1;
          await this.d.store.saveStatement({ ...s, status: 'HELD', holdReason: 'KYC', updatedAt: now });
        }
      }
      if (included.length === 0) {
        if (heldKyc > 0) throw new SettlementProblem('payout-kyc-required', 409, 'KYC 확인이 끝나지 않아 지급할 수 없습니다');
        if (heldAccount > 0) throw new SettlementProblem('payout-account-change-hold', 409, '정산 계좌 변경 보류 중이라 지급할 수 없습니다');
        throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
      }
      const totalAmount = included.reduce((sum, s) => sum + s.payoutAmount, 0);
      if (input.pg === 'PORTONE' && !input.portoneBalance) throw new SettlementProblem('invalid-query', 422, '포트원 지급대행 계좌 잔액이 필요합니다');
      if (input.pg === 'PORTONE' && input.portoneBalance && input.portoneBalance.amount < totalAmount) throw new SettlementProblem('payout-balance-insufficient', 409, '결제사 잔액이 모자라 지급일을 미룹니다');
      const batch: PayoutBatchRecord = {
        batchId: uuidv7(this.d.clock),
        pg: input.pg,
        pgStore: input.pgStore,
        payoutDate: input.payoutDate,
        totalAmount,
        statementCount: included.length,
        approvalId: null,
        portoneBulkPayoutId: null,
        pgBalanceKrw: input.portoneBalance?.amount ?? null,
        pgBalanceSource: input.pg === 'PORTONE' ? 'OPERATOR_CONSOLE' : null,
        pgBalanceObservedAt: input.portoneBalance ? new Date(input.portoneBalance.observedAt) : null,
        pgBalanceObservedBy: input.pg === 'PORTONE' ? input.actor : null,
        pgBalanceLedgerKrw: null,
        status: 'PENDING_APPROVAL',
        createdAt: now,
        updatedAt: now,
      };
      await this.d.store.insertPayoutBatch(batch);
      return payoutBatchView(batch);
    });
  }

  async approveBatch(batchId: string, approvalId: string): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      if (b.status !== 'PENDING_APPROVAL') throw new SettlementProblem('payout-batch-not-approved', 409, '승인 대기 중인 지급 묶음이 아닙니다');
      const next = { ...b, status: 'APPROVED' as const, approvalId, updatedAt: new Date(this.d.clock.now()) };
      await this.d.store.savePayoutBatch(next);
      return payoutBatchView(next);
    });
  }

  async executeBatch(batchId: string): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      if (b.status !== 'APPROVED') throw new SettlementProblem('payout-batch-not-approved', 409, '승인된 지급 묶음이 아닙니다');
      const gateway = this.d.gateways.find((g) => g.pg === b.pg);
      if (!gateway) throw new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
      const now = new Date(this.d.clock.now());
      let payouts = await this.d.store.listPayouts(batchId);
      if (payouts.length === 0) {
        const statements = await this.d.store.listConfirmed(b.pg, b.pgStore, b.payoutDate);
        if (statements.length === 0) throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
        payouts = statements.map((s, i) => ({
          payoutId: uuidv7(this.d.clock),
          batchId,
          statementId: s.statementId,
          seq: i + 1,
          amount: s.payoutAmount,
          refPayoutId: `${s.statementId}-${i + 1}`,
          pgPayoutId: null,
          status: 'REQUESTED',
          errorCode: null,
          pgTransferId: null,
          transferCheck: null,
          transferCheckedAt: null,
          createdAt: now,
          updatedAt: now,
        }));
        await this.d.store.insertPayouts(payouts);
      }
      const result = await gateway.submit({ batch: b, payouts });
      const nextStatus = result.status === 'COMPLETED' ? 'COMPLETED' : 'SUBMITTED';
      const next = { ...b, status: nextStatus as PayoutBatchRecord['status'], updatedAt: now };
      await this.d.store.savePayoutBatch(next);
      const statements = (await Promise.all(payouts.map((p) => this.d.store.findStatementById(p.statementId)))).filter((s): s is StatementRecord => s !== undefined);
      for (const s of statements) await this.d.store.saveStatement({ ...s, status: nextStatus === 'COMPLETED' ? 'PAID' : 'SCHEDULED', updatedAt: now });
      return payoutBatchView(next);
    });
  }

  async retryPayout(payoutId: string): Promise<PayoutRecord> {
    return guard(async () => {
      const p = await this.d.store.findPayout(payoutId);
      if (!p) throw notFound();
      if (p.status !== 'FAILED') throw new SettlementProblem('payout-not-retryable', 409, '실패한 지급 건만 다시 보낼 수 있습니다');
      const siblings = await this.d.store.listPayouts(p.batchId);
      const seq = Math.max(...siblings.filter((x) => x.statementId === p.statementId).map((x) => x.seq)) + 1;
      const now = new Date(this.d.clock.now());
      const next: PayoutRecord = {
        ...p,
        payoutId: uuidv7(this.d.clock),
        seq,
        refPayoutId: `${p.statementId}-${seq}`,
        pgPayoutId: null,
        status: 'REQUESTED',
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.store.insertPayouts([next]);
      return next;
    });
  }

  async putPayoutAccount(promoterId: string, sessionId: string, body: { bankCode: string; accountNumber: string; holderName: string }, ifMatch: string | undefined, reauthToken: string | undefined): Promise<{ bankCode: string; payoutAccountLast4: string; holdUntil: string; version: number }> {
    return guard(async () => {
      await this.d.reauth.verify(reauthToken, { sessionId, act: 'PAYOUT_ACCOUNT' });
      validatePayoutAccount(body);
      const expected = parseIfMatch(ifMatch);
      const current = await this.d.store.findPayoutAccount(promoterId);
      if ((current?.version ?? 0) !== expected) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
      const now = new Date(this.d.clock.now());
      const record = {
        promoterId,
        bankCode: body.bankCode,
        accountLast4: accountLast4(body.accountNumber),
        version: expected + 1,
        changedAt: now,
        holdUntil: addBusinessDays(now, 3),
        holderVerified: false,
      };
      await this.d.store.savePayoutAccount(record);
      return { bankCode: record.bankCode, payoutAccountLast4: record.accountLast4, holdUntil: record.holdUntil.toISOString(), version: record.version };
    });
  }

  /** 지급일 계산에 쓰는 기본값. 시험·운영이 같은 함수를 쓴다. */
  payoutDateFor(now: Date): string {
    return dateOnly(addBusinessDays(now, 5));
  }
}
