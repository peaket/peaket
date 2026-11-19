// 정산서·지급 묶음·KYC 유스케이스(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, ADR-0047·0062).
// 결제 원장은 payment-svc의 payment 표만 읽고, 상품 주문 원천은 아직 없다(상품 정산서는 빈 목록).
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { DueEventSettlementSource, EventCommissionRateSource, PayoutGateway, ProductSettlementSource, ReauthVerifier, ReceivableUpdate, SettlementPaymentSource, SettlementStore, StatementFilter, StatementUpdate } from '../domain/ports.js';
import { normalizeHolderName } from '../domain/payout-adapters.js';
import {
  accountLast4,
  addBusinessDays,
  calculateEventStatement,
  calculateProductStatement,
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
  type ReceivableMoveRecord,
  type ReceivableRecord,
  type StatementKind,
  type StatementRecord,
  type StatementView,
} from '../domain/settlement.js';

export interface SettlementDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly products?: ProductSettlementSource;
  readonly events?: DueEventSettlementSource;
  readonly eventCommission?: EventCommissionRateSource;
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
  async calculateEvent(input: { promoterId: string; eventId: string; pg: Pg; pgStore: PgStore; commissionRateBp?: number; eventEndsAt?: string }): Promise<StatementView> {
    return guard(async () => {
      const existing = await this.d.store.findEventStatement(input.promoterId, input.eventId, input.pg, input.pgStore);
      if (existing) return statementView(existing);
      const now = new Date(this.d.clock.now());
      const [payments, kyc, account] = await Promise.all([this.d.payments.listEventPayments(input.eventId, input.pg, input.pgStore), this.d.store.findKyc(input.promoterId), this.d.store.findPayoutAccount(input.promoterId)]);
      // 회차 수수료율은 공연 설정·계약이 정본이다. 없으면 임의 10%를 쓰지 않고 닫는다(A1-H10).
      const commissionRateBp = input.commissionRateBp ?? (this.d.eventCommission ? await this.d.eventCommission.rateBp(input.eventId) : this.d.commissionRateBp);
      if (commissionRateBp === undefined) throw new SettlementProblem('event-commission-rate-unavailable', 503, '회차 수수료율을 확인할 수 없습니다');
      const { record, sources } = calculateEventStatement({
        promoterId: input.promoterId,
        eventId: input.eventId,
        pg: input.pg,
        pgStore: input.pgStore,
        commissionRateBp,
        payments,
        kyc,
        account,
        now,
        ...(input.eventEndsAt ? { eventEndsAt: input.eventEndsAt } : {}),
        statementId: uuidv7(this.d.clock),
      });
      const inserted = await this.d.store.insertStatement(record, sources);
      if (!inserted) {
        const raced = await this.d.store.findEventStatement(input.promoterId, input.eventId, input.pg, input.pgStore);
        if (!raced) throw new SettlementProblem('settlement-statement-conflict', 409, '같은 회차 정산서가 이미 있습니다');
        return statementView(raced);
      }
      return statementView(record);
    });
  }

  async calculateProduct(input: { periodStart: string; periodEnd: string; commissionRateBp?: number }): Promise<{ created: number; items: StatementView[] }> {
    return guard(async () => {
      if (!this.d.products) throw new SettlementProblem('product-settlement-source-unavailable', 503, '상품 정산 원천을 읽을 수 없습니다');
      if (input.periodEnd < input.periodStart) throw new SettlementProblem('invalid-query', 422, '정산 기간이 맞지 않습니다');
      const items = await this.d.products.listProductItems(input.periodStart, input.periodEnd);
      const groups = new Map<string, typeof items>();
      for (const item of items) {
        const key = `${item.promoterId}/${item.pg}/${item.pgStore}`;
        const list = groups.get(key) ?? [];
        list.push(item);
        groups.set(key, list);
      }
      const now = new Date(this.d.clock.now());
      const out: StatementView[] = [];
      for (const [key, list] of groups) {
        const first = list[0]!;
        const existing = await this.d.store.findProductStatement(first.promoterId, first.pg, first.pgStore, input.periodStart, input.periodEnd);
        if (existing) continue;
        const [kyc, account] = await Promise.all([this.d.store.findKyc(first.promoterId), this.d.store.findPayoutAccount(first.promoterId)]);
        const { record, sources } = calculateProductStatement({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          items: list,
          kyc,
          account,
          now,
          statementId: uuidv7(this.d.clock),
        });
        void key;
        const inserted = await this.d.store.insertStatement(record, sources);
        if (!inserted) continue;
        out.push(statementView(record));
      }
      return { created: out.length, items: out };
    });
  }

  /** 회차 종료 5영업일 뒤 스케줄러가 부른다. 결제가 있는 결제사만 계산하고, 이미 있으면 기존 정산서를 돌려준다. */
  async calculateDueEvents(through: string, limit = 100): Promise<{ calculated: number; items: StatementView[] }> {
    return guard(async () => {
      if (!this.d.events) throw new SettlementProblem('event-settlement-source-unavailable', 503, '회차 정산 원천을 읽을 수 없습니다');
      const due = await this.d.events.listDue(through, limit);
      const items: StatementView[] = [];
      for (const e of due) {
        for (const pg of ['TOSS', 'PORTONE'] as const) {
          for (const pgStore of ['STANDARD', 'ESCROW'] as const) {
            const payments = await this.d.payments.listEventPayments(e.eventId, pg, pgStore);
            if (payments.length === 0) continue;
            items.push(await this.calculateEvent({ promoterId: e.promoterId, eventId: e.eventId, pg, pgStore, eventEndsAt: e.endsAt }));
          }
        }
      }
      return { calculated: items.length, items };
    });
  }

  async listAll(filter: { kind?: StatementKind | undefined; status?: string | undefined; pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; limit: number }): Promise<StatementView[]> {
    return (await this.d.store.listStatements(filter)).map(statementView);
  }

  async listBatches(filter: { pg?: Pg | undefined; pgStore?: PgStore | undefined; payoutDate?: string | undefined; status?: readonly string[] | undefined; limit: number }) {
    return (await this.d.store.listPayoutBatches(filter)).map(payoutBatchView);
  }

  async listReceivables(filter: { promoterId?: string | undefined; pg?: Pg | undefined; status?: readonly ReceivableRecord['status'][] | undefined; limit: number }): Promise<ReceivableRecord[]> {
    return this.d.store.listReceivables(filter);
  }

  async recordReceivable(input: { promoterId: string; pg: Pg | null; cause: ReceivableRecord['cause']; amount: number; eventId?: string | undefined; sourceRef?: string | undefined }): Promise<ReceivableRecord> {
    return guard(async () => {
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new SettlementProblem('invalid-query', 422, '미수금 금액이 맞지 않습니다');
      if (input.pg === null && input.cause !== 'COMPENSATION_ADVANCE') throw new SettlementProblem('invalid-query', 422, '결제사 없는 미수금은 배상금 미리 지급뿐입니다');
      const now = new Date(this.d.clock.now());
      const record: ReceivableRecord = {
        receivableId: uuidv7(this.d.clock),
        promoterId: input.promoterId,
        pg: input.pg,
        cause: input.cause,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
        ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
        amount: input.amount,
        remaining: input.amount,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
      };
      await this.d.store.insertReceivable(record);
      return record;
    });
  }

  /**
   * 배상금 미리 지급의 미수금(payment §6, settlement §7, ADR-0317): cause = COMPENSATION_ADVANCE, pg = NULL,
   * source_ref = compensation:{id}. 같은 compensation_id의 겹친 두 요청도 source_ref 유일로 한 행이다.
   */
  async recordCompensationAdvance(input: { compensationId: string; promoterId: string; eventId?: string | undefined; amount: number }): Promise<ReceivableRecord> {
    return guard(async () => {
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new SettlementProblem('invalid-query', 422, '미수금 금액이 맞지 않습니다');
      const sourceRef = `compensation:${input.compensationId}`;
      const existing = await this.d.store.findReceivableBySourceRef(sourceRef);
      if (existing !== undefined) return existing;
      const now = new Date(this.d.clock.now());
      const record: ReceivableRecord = {
        receivableId: uuidv7(this.d.clock),
        promoterId: input.promoterId,
        pg: null,
        cause: 'COMPENSATION_ADVANCE',
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
        sourceRef,
        amount: input.amount,
        remaining: input.amount,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
      };
      await this.d.store.insertReceivableIfAbsent(record);
      return (await this.d.store.findReceivableBySourceRef(sourceRef)) ?? record;
    });
  }

  async recordPortoneExecution(batchId: string, bulkPayoutId: string): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      if (b.pg !== 'PORTONE') throw new SettlementProblem('payout-batch-not-portone', 409, '포트원 지급 묶음이 아닙니다');
      if (b.status !== 'APPROVED' && b.status !== 'SUBMITTED') throw new SettlementProblem('payout-batch-not-approved', 409, '승인된 지급 묶음이 아닙니다');
      if (bulkPayoutId.trim() === '') throw new SettlementProblem('invalid-query', 422, '일괄 지급 ID가 필요합니다');
      const next = { ...b, portoneBulkPayoutId: bulkPayoutId.trim(), status: 'SUBMITTED' as const, updatedAt: new Date(this.d.clock.now()) };
      await this.d.store.savePayoutBatch(next);
      return payoutBatchView(next);
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
        await this.d.store.insertStatementAudit({ auditId: uuidv7(this.d.clock), statementId, fromStatus: s.status, toStatus: next.status, reason: 'dispute-window-ended', actor: 'system', createdAt: now });
        return statementView(next);
      }
      return statementView(s);
    });
  }

  /**
   * HELD를 정본이 허용한 사유·증빙으로 다시 CONFIRMED로 푼다(A2-05, A1V-03·04).
   * DISPUTED는 이의 결과가 모두 입력된 뒤에만 NOTIFIED로 돌리고, 새 1영업일 이의 기간을 준다.
   * PAID·SCHEDULED·SUPERSEDED는 이미 지급 흐름에 들어갔거나 끝났으므로 건드리지 않는다.
   */
  async reconfirmStatement(
    statementId: string,
    o: { actor?: string; reason?: string; evidence?: { balanceConfirmed?: boolean; saleResumed?: boolean; accountReconciled?: boolean } } = {},
  ): Promise<StatementView> {
    return guard(async () => {
      const s = await this.d.store.findStatementById(statementId);
      if (!s) throw notFound();
      if (s.status === 'CONFIRMED') return statementView(s);
      if (s.status !== 'HELD' && s.status !== 'DISPUTED') throw new SettlementProblem('settlement-not-reconfirmable', 409, '보류·이의 상태의 정산서만 다시 확정할 수 있습니다');
      const now = new Date(this.d.clock.now());
      if (s.status === 'DISPUTED') {
        const disputes = await this.d.store.listDisputes(statementId);
        if (disputes.length === 0 || disputes.some((d) => d.result === null)) throw new SettlementProblem('settlement-dispute-open', 409, '이의 결과가 입력되지 않아 다시 확정할 수 없습니다');
        const next: StatementRecord = { ...s, status: 'NOTIFIED', holdReason: null, disputeDueAt: addBusinessDays(now, 1), updatedAt: now };
        await this.d.store.saveStatement(next);
        await this.d.store.insertStatementAudit({ auditId: uuidv7(this.d.clock), statementId, fromStatus: s.status, toStatus: next.status, reason: o.reason ?? 'dispute-resolved', actor: o.actor ?? 'system', createdAt: now });
        return statementView(next);
      }
      if (s.holdReason === 'KYC') {
        const kyc = await this.d.store.findKyc(s.promoterId);
        if (!(kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified)) throw new SettlementProblem('payout-kyc-required', 409, 'KYC 확인이 끝나지 않아 다시 확정할 수 없습니다');
      } else if (s.holdReason === 'ACCOUNT_CHANGE') {
        const account = await this.d.store.findPayoutAccount(s.promoterId);
        if (account && account.holdUntil.getTime() > now.getTime()) throw new SettlementProblem('payout-account-change-hold', 409, '정산 계좌 변경 보류 중이라 다시 확정할 수 없습니다');
      } else if (s.holdReason === 'ACCOUNT_MISMATCH') {
        const account = await this.d.store.findPayoutAccount(s.promoterId);
        const reconciled = o.evidence?.accountReconciled === true || Boolean(account && account.holderVerified && account.holdUntil.getTime() <= now.getTime());
        if (!reconciled) throw new SettlementProblem('payout-account-mismatch', 409, '계좌 대조가 확인되지 않아 다시 확정할 수 없습니다');
      } else if (s.holdReason === 'BALANCE') {
        if (o.evidence?.balanceConfirmed !== true) throw new SettlementProblem('payout-balance-unconfirmed', 409, '잔액 확인 증빙이 없어 다시 확정할 수 없습니다');
      } else if (s.holdReason === 'SALE_SUSPENDED') {
        if (o.evidence?.saleResumed !== true) throw new SettlementProblem('settlement-sale-not-resumed', 409, '판매 재개 확인이 없어 다시 확정할 수 없습니다');
      } else {
        throw new SettlementProblem('settlement-not-reconfirmable', 409, '보류 사유를 확인할 수 없어 다시 확정할 수 없습니다');
      }
      const next: StatementRecord = { ...s, status: 'CONFIRMED', holdReason: null, updatedAt: now };
      await this.d.store.saveStatement(next);
      await this.d.store.insertStatementAudit({ auditId: uuidv7(this.d.clock), statementId, fromStatus: s.status, toStatus: next.status, reason: o.reason ?? s.holdReason ?? 'reconfirm', actor: o.actor ?? 'system', createdAt: now });
      return statementView(next);
    });
  }

  /** 이의 결과를 입력하고 DISPUTED를 NOTIFIED로 돌린다(정본 §4.2, A1V-03). */
  async resolveDispute(statementId: string, disputeId: string, result: 'ADJUSTED' | 'DISMISSED', actor: string): Promise<StatementView> {
    return guard(async () => {
      const s = await this.d.store.findStatementById(statementId);
      if (!s) throw notFound();
      if (s.status !== 'DISPUTED') throw new SettlementProblem('settlement-not-disputed', 409, '이의 중인 정산서가 아닙니다');
      const dispute = (await this.d.store.listDisputes(statementId)).find((d) => d.disputeId === disputeId);
      if (!dispute) throw notFound();
      if (dispute.result !== null) throw new SettlementProblem('settlement-dispute-already-resolved', 409, '이미 결과가 입력된 이의입니다');
      const now = new Date(this.d.clock.now());
      await this.d.store.saveDispute({ ...dispute, result, resolvedAt: now });
      const next: StatementRecord = { ...s, status: 'NOTIFIED', holdReason: null, disputeDueAt: addBusinessDays(now, 1), updatedAt: now };
      await this.d.store.saveStatement(next);
      await this.d.store.insertStatementAudit({ auditId: uuidv7(this.d.clock), statementId, fromStatus: s.status, toStatus: next.status, reason: `dispute-${result.toLowerCase()}`, actor, createdAt: now });
      return statementView(next);
    });
  }

  /** 이의 기간이 끝난 NOTIFIED 정산서를 자동 확정한다(M1-F3). 이의가 걸린 DISPUTED는 대상이 아니다. */
  async confirmDueStatements(limit = 100): Promise<{ confirmed: number; items: StatementView[] }> {
    return guard(async () => {
      const due = await this.d.store.listDueConfirmation(new Date(this.d.clock.now()), limit);
      const items: StatementView[] = [];
      for (const s of due) items.push(await this.confirmDue(s.statementId));
      return { confirmed: items.filter((s) => s.status === 'CONFIRMED').length, items };
    });
  }

  async recordKyc(promoterId: string, status: KycStatus, o: { businessVerified?: boolean; representativeVerified?: boolean; legalName?: string; representative?: string; source?: string } = {}): Promise<KycRecord> {
    const now = new Date(this.d.clock.now());
    const record: KycRecord = {
      promoterId,
      status,
      businessVerified: o.businessVerified ?? status === 'VERIFIED',
      representativeVerified: o.representativeVerified ?? status === 'VERIFIED',
      legalName: o.legalName ?? null,
      representative: o.representative ?? null,
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
      const statementUpdates: StatementUpdate[] = [];
      const receivableUpdates: ReceivableUpdate[] = [];
      const receivableMoves: ReceivableMoveRecord[] = [];
      let heldKyc = 0;
      let heldAccount = 0;
      let heldMismatch = 0;
      for (const s of confirmed) {
        const kyc = await this.d.store.findKyc(s.promoterId);
        if (kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified) {
          const account = await this.d.store.findPayoutAccount(s.promoterId);
          if (account && account.holdUntil.getTime() > now.getTime()) {
            heldAccount += 1;
            statementUpdates.push({ statementId: s.statementId, status: 'HELD', holdReason: 'ACCOUNT_CHANGE', offsetAmount: s.offsetAmount, payoutAmount: s.payoutAmount, updatedAt: now });
            continue;
          }
          if (account && !account.holderVerified) {
            heldMismatch += 1;
            statementUpdates.push({ statementId: s.statementId, status: 'HELD', holdReason: 'ACCOUNT_MISMATCH', offsetAmount: s.offsetAmount, payoutAmount: s.payoutAmount, updatedAt: now });
            continue;
          }
          included.push(s);
        } else {
          heldKyc += 1;
          statementUpdates.push({ statementId: s.statementId, status: 'HELD', holdReason: 'KYC', offsetAmount: s.offsetAmount, payoutAmount: s.payoutAmount, updatedAt: now });
        }
      }
      if (included.length === 0) {
        if (heldKyc > 0) throw new SettlementProblem('payout-kyc-required', 409, 'KYC 확인이 끝나지 않아 지급할 수 없습니다');
        if (heldAccount > 0) throw new SettlementProblem('payout-account-change-hold', 409, '정산 계좌 변경 보류 중이라 지급할 수 없습니다');
        if (heldMismatch > 0) throw new SettlementProblem('payout-account-mismatch', 409, '예금주가 확인되지 않은 정산 계좌라 지급할 수 없습니다');
        throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
      }
      // 미수금 상계(settlement §7): 같은 파트너의 열린 미수금을 지급액에서 먼저 뺀다.
      // 지급 뒤 환불·이의·감액은 그 결제사 정산서에서, 배상금 미리 지급(COMPENSATION_ADVANCE)은 결제사와 무관하게 상계한다(M1-F2).
      // 한 배치 안에서는 미수금 잔액을 로컬 맵으로 차감해 같은 미수금이 두 정산서에서 두 번 소진되지 않게 한다(A1V-01).
      const includedAfterOffset: StatementRecord[] = [];
      const receivableRemaining = new Map<string, { remaining: number; status: ReceivableRecord['status'] }>();
      for (const s of included) {
        let remaining = s.payoutAmount;
        let offset = 0;
        for (const r of await this.d.store.listOpenReceivables(s.promoterId, input.pg)) {
          if (remaining <= 0) break;
          const tracked = receivableRemaining.get(r.receivableId);
          const available = tracked?.remaining ?? r.remaining;
          if (available <= 0) continue;
          const take = Math.min(available, remaining);
          if (take <= 0) continue;
          const nextRemaining = available - take;
          receivableRemaining.set(r.receivableId, { remaining: nextRemaining, status: nextRemaining === 0 ? 'CLOSED' : 'OPEN' });
          receivableMoves.push({ receivableId: r.receivableId, statementId: s.statementId, amount: take, movedAt: now });
          offset += take;
          remaining -= take;
        }
        if (offset > 0) {
          const next: StatementRecord = { ...s, offsetAmount: s.offsetAmount + offset, payoutAmount: remaining, status: remaining > 0 ? s.status : 'CARRIED_OVER', updatedAt: now };
          statementUpdates.push({ statementId: s.statementId, status: next.status, holdReason: next.holdReason, offsetAmount: next.offsetAmount, payoutAmount: next.payoutAmount, updatedAt: now });
          if (remaining > 0) includedAfterOffset.push(next);
        } else {
          includedAfterOffset.push(s);
        }
      }
      for (const [receivableId, u] of receivableRemaining) receivableUpdates.push({ receivableId, remaining: u.remaining, status: u.status, updatedAt: now });
      if (includedAfterOffset.length === 0) throw new SettlementProblem('payout-batch-empty', 409, '상계 뒤 지급할 정산서가 없습니다');
      const totalAmount = includedAfterOffset.reduce((sum, s) => sum + s.payoutAmount, 0);
      if (input.pg === 'PORTONE' && !input.portoneBalance) throw new SettlementProblem('invalid-query', 422, '포트원 지급대행 계좌 잔액이 필요합니다');
      if (input.pg === 'PORTONE' && input.portoneBalance && input.portoneBalance.amount < totalAmount) throw new SettlementProblem('payout-balance-insufficient', 409, '결제사 잔액이 모자라 지급일을 미룹니다');
      const batch: PayoutBatchRecord = {
        batchId: uuidv7(this.d.clock),
        pg: input.pg,
        pgStore: input.pgStore,
        payoutDate: input.payoutDate,
        totalAmount,
        statementCount: includedAfterOffset.length,
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
      await this.d.store.createPayoutBatchAtomically({
        batch,
        statementIds: includedAfterOffset.map((s) => s.statementId),
        statementUpdates,
        receivableUpdates,
        receivableMoves,
      });
      return payoutBatchView(batch);
    });
  }

  /** 반려·취소된 배치를 푼다. 정산서는 다시 CONFIRMED가 되어 같은 지급일의 새 배치에 들어간다(CONS-V02). */
  async releasePayoutBatch(batchId: string): Promise<{ released: true }> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      if (b.status !== 'PENDING_APPROVAL' && b.status !== 'APPROVED') throw new SettlementProblem('payout-batch-not-releasable', 409, '승인 대기·승인된 지급 묶음만 풀 수 있습니다');
      if (!(await this.d.store.releasePayoutBatch(batchId))) throw new SettlementProblem('payout-batch-not-releasable', 409, '지급 건이 있는 묶음은 풀 수 없습니다');
      return { released: true as const };
    });
  }

  async approveBatch(batchId: string, approvalId: string): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      // 실행 실패 뒤 같은 승인 업무로 다시 승인하면 승인은 한 번만 반영하고 실행만 다시 한다.
      if (b.approvalId === approvalId && (b.status === 'APPROVED' || b.status === 'SUBMITTED' || b.status === 'COMPLETED')) return payoutBatchView(b);
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
      const boundStatements = await this.d.store.listStatementsByBatch(batchId);
      if (boundStatements.length === 0) throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
      const boundTotal = boundStatements.reduce((sum, s) => sum + s.payoutAmount, 0);
      if (boundTotal !== b.totalAmount) throw new SettlementProblem('payout-batch-amount-mismatch', 409, '승인한 지급 금액과 정산서 합계가 다릅니다');
      let payouts = await this.d.store.listPayouts(batchId);
      if (payouts.length === 0) {
        const statements = boundStatements;
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

  async putPayoutAccount(promoterId: string, sessionId: string, body: { bankCode: string; accountNumber: string; holderName: string }, ifMatch: string | undefined, reauthToken: string | undefined): Promise<{ bankCode: string; payoutAccountLast4: string; holdUntil: string; version: number; holderVerified: boolean }> {
    return guard(async () => {
      await this.d.reauth.verify(reauthToken, { sessionId, act: 'PAYOUT_ACCOUNT' });
      validatePayoutAccount(body);
      const expected = parseIfMatch(ifMatch);
      const current = await this.d.store.findPayoutAccount(promoterId);
      if ((current?.version ?? 0) !== expected) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
      const now = new Date(this.d.clock.now());
      // 예금주는 KYC 사업자 상호나 대표자 이름과 표기 차이를 흡수해 대조한다(J-T8, A1-H7).
      const kyc = await this.d.store.findKyc(promoterId);
      const holder = normalizeHolderName(body.holderName);
      const holderVerified = Boolean(kyc && [kyc.legalName, kyc.representative].some((name) => name !== null && name !== undefined && normalizeHolderName(name) === holder));
      const record = {
        promoterId,
        bankCode: body.bankCode,
        accountLast4: accountLast4(body.accountNumber),
        version: expected + 1,
        changedAt: now,
        holdUntil: addBusinessDays(now, 3),
        holderVerified,
      };
      await this.d.store.savePayoutAccount(record);
      return { bankCode: record.bankCode, payoutAccountLast4: record.accountLast4, holdUntil: record.holdUntil.toISOString(), version: record.version, holderVerified };
    });
  }

  /** 지급일 계산에 쓰는 기본값. 시험·운영이 같은 함수를 쓴다. */
  payoutDateFor(now: Date): string {
    return dateOnly(addBusinessDays(now, 5));
  }
}
