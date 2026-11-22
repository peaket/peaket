// 정산서·지급 묶음·KYC 유스케이스(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, ADR-0047·0062).
// 결제 원장은 payment-svc의 payment 표만 읽고, 상품 주문 원천은 core-svc shop 내부 HTTP다.
// 정산서 상태는 조건부 전이로만 바꾼다(지금 상태가 출발 상태일 때만, 상태·감사·trade.settlements 사건을 한 트랜잭션에, ADR-0368 결정 2).
// 계산 = 통지(결정 1), 이의(결정 5)·기각(결정 6)·수기 조정(결정 7·8·9)·확정 때의 0 이하 처리(결정 10)·모두 보류된 묶음의 보류 저장(결정 11)을 여기서 한다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type {
  AdjustmentApprovalVerifier,
  DueEventSettlementSource,
  EventCommissionRateSource,
  PayoutApprovalVerifier,
  PayoutGateway,
  PgBalanceSource,
  ProductSettlementSource,
  PromoterContractSource,
  ReauthVerifier,
  ReceivableUpdate,
  SaleSuspensionSource,
  SettlementApprovalLog,
  SettlementCaseNotice,
  SettlementPaymentSource,
  SettlementStore,
  StatementFilter,
  StatementTransition,
  StatementUpdate,
  VerifiedAdjustmentApproval,
  VerifiedPayoutApproval,
} from '../domain/ports.js';
import { normalizeHolderName, splitTossPayoutAmount } from '../domain/payout-adapters.js';
import { addBusinessDays as addKstBusinessDays, isFirstBusinessDayOfKstWeek, previousKstWeek } from '../domain/business-calendar.js';
import {
  ADJUSTMENT_PENDING_TTL_MS,
  adjustmentView,
  assertAdjustable,
  isDisputeAdjustmentCode,
  payoutWithAdjustment,
  sameAdjustmentRequest,
  validateAdjustment,
  type AdjustmentRecord,
  type AdjustmentRequest,
  type AdjustmentView,
} from '../domain/adjustment.js';
import {
  accountLast4,
  addBusinessDays,
  calculateEventStatement,
  calculateProductStatement,
  dateOnly,
  DISPUTE_WINDOW_BUSINESS_DAYS,
  negativeStatementSourceRef,
  payoutBatchView,
  receivableOpenedEvent,
  RENOTIFY_WINDOW_BUSINESS_DAYS,
  SettlementProblem,
  statementEvent,
  statementView,
  validateDispute,
  validatePayoutAccount,
  type DisputeRecord,
  type HoldReason,
  type GuaranteeCollectionRecord,
  type GuaranteeKind,
  type KycNotice,
  type KycRecord,
  type KycStatus,
  type PayoutBatchAuditRecord,
  type PayoutBatchDetail,
  type PayoutBatchRecord,
  type PayoutRecord,
  type Pg,
  type PgStore,
  type ReceivableMoveRecord,
  type ReceivableRecord,
  type SettlementEventValue,
  type StatementAuditRecord,
  type StatementKind,
  type StatementRecord,
  type StatementSource,
  type StatementStatus,
  type StatementView,
  type TossSellerStatus,
} from '../domain/settlement.js';

export interface SettlementDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly products?: ProductSettlementSource;
  readonly events?: DueEventSettlementSource;
  readonly eventCommission?: EventCommissionRateSource;
  /** ops-svc 지급 승인 기록 대조(없거나 5xx면 503). 승인 경로는 이 의존성 없이 열리지 않는다 */
  readonly approvals: PayoutApprovalVerifier;
  /** core-svc 판매 중지 회차 확인(없거나 5xx면 503) */
  readonly saleSuspensions: SaleSuspensionSource;
  /** core-svc 지금 계약 조건(보증 비율·종류). 없으면 보증 충당을 만들지 않는다 */
  readonly promoterContracts?: PromoterContractSource;
  /** 결제사 지급 가능 잔액(토스). 없으면 잔액 확인을 생략한다 */
  readonly pgBalance?: PgBalanceSource;
  readonly gateways: readonly PayoutGateway[];
  readonly reauth: ReauthVerifier;
  readonly clock: Clock;
  readonly commissionRateBp?: number;
  readonly log?: SettlementApprovalLog;
  /** ops-svc CS 처리함 '정산 이의' 건 열기. 없으면 열지 않고 이의 행의 case_requested_at이 빈 채로 남는다 */
  readonly caseNotice?: SettlementCaseNotice;
  /** ops-svc 조정 승인 기록 대조. 없으면 조정 적용은 503이다(승인 ID만 믿지 않는다, ADR-0368 결정 8) */
  readonly adjustmentApprovals?: AdjustmentApprovalVerifier;
  /** KST 공휴일(PEAKET_HOLIDAY_CALENDAR_FILE). 없으면 주말만 뺀다 [가정] */
  readonly holidays?: ReadonlySet<string>;
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

/** 지급 승인 기록과 배치가 어긋날 때의 409. 제목에 어긋난 칸을 적어 운영자가 바로 고치게 한다. */
const approvalMismatch = (type: string, title: string) => new SettlementProblem(type, 409, title);
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const approvalFactsOf = (a: VerifiedPayoutApproval, b: PayoutBatchRecord): void => {
  if (a.kind !== 'PAYOUT_BATCH') throw approvalMismatch('payout-approval-kind-mismatch', '지급 묶음 승인 업무가 아닙니다');
  if (a.batchId !== b.batchId || a.targetRef !== b.batchId) throw approvalMismatch('payout-approval-target-mismatch', '다른 지급 묶음의 승인 업무입니다');
  if (a.pg !== b.pg || a.pgStore !== b.pgStore || a.payoutDate !== b.payoutDate) throw approvalMismatch('payout-approval-terms-mismatch', '승인한 결제사·상점·지급일과 다릅니다');
  if (a.currency !== 'KRW') throw approvalMismatch('payout-approval-currency-mismatch', '승인한 통화가 KRW가 아닙니다');
  if (a.amount !== b.totalAmount) throw approvalMismatch('payout-approval-amount-mismatch', '승인한 지급 금액과 묶음 합계가 다릅니다');
  if (a.statementCount !== b.statementCount) throw approvalMismatch('payout-approval-count-mismatch', '승인한 정산서 건수와 묶음 건수가 다릅니다');
  if (a.status !== 'EXECUTING' && a.status !== 'APPROVED') throw approvalMismatch('payout-approval-not-approved', '승인 대기·반려·이미 쓴 승인 업무입니다');
  if (a.requiredApprovals !== 2) throw approvalMismatch('payout-approval-quorum', '2인 승인이 아닙니다');
  const approvers = a.approvals.filter((id) => typeof id === 'string' && id !== '');
  const distinct = new Set([a.requestedBy, ...approvers]);
  if (approvers.length === 0 || approvers.includes(a.requestedBy) || distinct.size < 2) throw approvalMismatch('payout-approval-quorum', '요청자와 다른 승인자가 없습니다');
  if (a.approvedAt === null || Number.isNaN(Date.parse(a.approvedAt))) throw approvalMismatch('payout-approval-quorum', '승인 시각이 없습니다');
};

/** 조건부 전이가 지금 상태와 맞지 않았다(다른 전이가 먼저 썼다, ADR-0368 결정 2) */
const stateConflict = () => new SettlementProblem('settlement-state-conflict', 409, '정산서 상태가 다른 처리와 겹쳤습니다');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISMISSAL_REASON_MAX = 2_000;
/** CS 건 다시 보내기·오래된 조정 닫기의 한 번 상한(50건·100건 [가정]) */
const CASE_RETRY_LIMIT = 50;
const STALE_ADJUSTMENT_LIMIT = 100;

/** 조정 적용 때 ops 승인 기록과 조정 행 대조(ADR-0368 결정 8). 어긋나면 409이고 아무것도 바꾸지 않는다 */
const adjustmentFactsOf = (f: VerifiedAdjustmentApproval, a: AdjustmentRecord): void => {
  const mismatch = (type: string, title: string) => new SettlementProblem(type, 409, title);
  if (f.kind !== 'SETTLEMENT_ADJUSTMENT' || f.approvalId !== a.approvalId) throw mismatch('settlement-adjustment-approval-kind-mismatch', '수기 조정 승인 업무가 아닙니다');
  if (f.targetRef !== a.statementId) throw mismatch('settlement-adjustment-approval-target-mismatch', '다른 정산서의 승인 업무입니다');
  if (f.amount !== a.amount) throw mismatch('settlement-adjustment-approval-amount-mismatch', '승인한 조정 금액과 조정 행이 다릅니다');
  if (f.reasonCode !== a.reasonCode) throw mismatch('settlement-adjustment-approval-reason-mismatch', '승인한 사유 코드와 조정 행이 다릅니다');
  if (f.requestedBy !== a.requestedBy) throw mismatch('settlement-adjustment-approval-requester-mismatch', '승인 업무의 요청자와 조정 행의 요청자가 다릅니다');
  if (f.status !== 'APPROVED' && f.status !== 'EXECUTING') throw mismatch('settlement-adjustment-approval-not-approved', '승인되지 않은 조정입니다');
  if (f.requiredApprovals !== 2) throw mismatch('settlement-adjustment-approval-quorum', '2인 승인이 아닙니다');
  const approvers = f.approvals.filter((id) => typeof id === 'string' && id !== '');
  if (approvers.length === 0 || approvers.includes(f.requestedBy)) throw mismatch('settlement-adjustment-approval-quorum', '요청자와 다른 승인자가 없습니다');
  if (f.approvedAt === null || Number.isNaN(Date.parse(f.approvedAt))) throw mismatch('settlement-adjustment-approval-quorum', '승인 시각이 없습니다');
};

const batchCurrency = 'KRW';
const DAY_MS = 24 * 60 * 60 * 1000;
const GUARANTEE_DUE_DAYS = 30;
const KYC_NOTICE_THRESHOLD = 10_000_000;
const KYC_NOTICE_WINDOW_DAYS = 6;
const addDays = (date: string, days: number): string => dateOnly(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
const TOSS_SELLER_STATUSES: readonly TossSellerStatus[] = ['PENDING', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED'];

export class Settlements {
  constructor(private readonly d: SettlementDeps) {}

  /**
   * 파트너 회차 정산서 목록. 다른 파트너의 회차면 없는 회차와 같은 빈 목록이고(존재를 알리지 않는다),
   * 인가 실패 보안 로그 settlement_authz_denied를 남긴다(J-T10, ASVS 8.2.2·16.3.2).
   */
  async listEvent(promoterId: string, eventId: string, accountId?: string): Promise<StatementView[]> {
    const rows = await this.d.store.listEvent(promoterId, eventId);
    if (rows.length === 0 && accountId !== undefined && (await this.d.store.hasEventStatementOfOther(promoterId, eventId))) {
      this.d.log?.authzDenied?.({ partnerId: promoterId, accountId, statementId: null, eventId, action: 'list-event', at: this.#now() });
    }
    return rows.map(statementView);
  }

  #now(): Date {
    return new Date(this.d.clock.now());
  }

  #holidays(): ReadonlySet<string> {
    return this.d.holidays ?? new Set();
  }

  #audit(statementId: string, fromStatus: StatementStatus, toStatus: StatementStatus, reason: string, actor: string, at: Date): StatementAuditRecord {
    return { auditId: uuidv7(this.d.clock), statementId, fromStatus, toStatus, reason, actor, createdAt: at };
  }

  /** 계산 = 통지(ADR-0368 결정 1). 넣었으면 NOTIFIED 레코드, 부분 유일에 걸렸으면 undefined */
  async #insertNotified(record: StatementRecord, sources: readonly StatementSource[], now: Date): Promise<StatementRecord | undefined> {
    const disputeDueAt = addKstBusinessDays(now, DISPUTE_WINDOW_BUSINESS_DAYS, this.#holidays());
    const notified: StatementRecord = { ...record, status: 'NOTIFIED', holdReason: null, disputeDueAt, adjustmentAmount: record.adjustmentAmount ?? 0, updatedAt: now };
    const audit = this.#audit(record.statementId, 'CALCULATED', 'NOTIFIED', 'calculated', 'system', now);
    const event = statementEvent(notified, 'STATEMENT_NOTIFIED', now, audit.auditId);
    return (await this.d.store.insertStatement(record, sources, { disputeDueAt, audit, event })) ? notified : undefined;
  }

  /**
   * 확정 전이(T5 자동 확정, T8 보류 풀림)와 이어지는 T6(ADR-0368 결정 10). 지급액이 0 이하면 같은 트랜잭션에서 CARRIED_OVER로 끝내고,
   * 0 아래면 그 결제사의 미수금 NEGATIVE_STATEMENT(근거 negative-statement:{정산서 ID})와 RECEIVABLE_OPENED를 함께 쓴다.
   */
  #confirmTransition(s: StatementRecord, now: Date, o: { from: readonly StatementStatus[]; reason: string; actor: string; expect?: StatementTransition['expect'] }): { transition: StatementTransition; next: StatementRecord } {
    const confirmAudit = this.#audit(s.statementId, s.status, 'CONFIRMED', o.reason, o.actor, now);
    const confirmed: StatementRecord = { ...s, status: 'CONFIRMED', holdReason: null, updatedAt: now };
    const audits = [confirmAudit];
    const events: SettlementEventValue[] = [statementEvent(confirmed, 'STATEMENT_CONFIRMED', now, confirmAudit.auditId)];
    if (s.payoutAmount > 0) {
      return { transition: { statementId: s.statementId, from: o.from, to: 'CONFIRMED', set: { holdReason: null }, ...(o.expect ? { expect: o.expect } : {}), updatedAt: now, audits, events }, next: confirmed };
    }
    const carryAudit = this.#audit(s.statementId, 'CONFIRMED', 'CARRIED_OVER', 'payout-not-positive', o.actor, now);
    const carried: StatementRecord = { ...confirmed, status: 'CARRIED_OVER' };
    audits.push(carryAudit);
    events.push(statementEvent(carried, 'STATEMENT_CARRIED_OVER', now, carryAudit.auditId));
    let receivable: ReceivableRecord | undefined;
    if (s.payoutAmount < 0) {
      const amount = -s.payoutAmount;
      receivable = {
        receivableId: uuidv7(this.d.clock),
        promoterId: s.promoterId,
        pg: s.pg,
        cause: 'NEGATIVE_STATEMENT',
        eventId: s.eventId,
        sourceRef: negativeStatementSourceRef(s.statementId),
        amount,
        remaining: amount,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
      };
      events.push(receivableOpenedEvent(s, amount, now, carryAudit.auditId));
    }
    return {
      transition: { statementId: s.statementId, from: o.from, to: 'CARRIED_OVER', set: { holdReason: null }, ...(o.expect ? { expect: o.expect } : {}), updatedAt: now, audits, events, ...(receivable ? { insertReceivable: receivable } : {}) },
      next: carried,
    };
  }

  /** 지급 묶음 때의 보류(T7). 출발 CONFIRMED·묶음에 붙지 않은 정산서만이고 감사를 함께 쓴다(PAYOUT_HELD 사건은 LCH-110) */
  #holdUpdate(s: StatementRecord, reason: HoldReason, now: Date): StatementUpdate {
    return {
      statementId: s.statementId,
      status: 'HELD',
      holdReason: reason,
      offsetAmount: s.offsetAmount,
      payoutAmount: s.payoutAmount,
      updatedAt: now,
      from: ['CONFIRMED'],
      audits: [this.#audit(s.statementId, s.status, 'HELD', `hold-${reason.toLowerCase()}`, 'system', now)],
      events: [],
    };
  }

  /** 묶음 없이 보류만 저장할 때(모두 보류·잔액 부족)의 조건부 전이 */
  static #holdTransition(u: StatementUpdate): StatementTransition {
    return { statementId: u.statementId, from: u.from ?? ['CONFIRMED'], to: 'HELD', set: { holdReason: u.holdReason }, expect: { unbatched: true }, updatedAt: u.updatedAt, audits: u.audits ?? [], events: u.events ?? [] };
  }

  async listProduct(promoterId: string, filter: StatementFilter): Promise<{ items: StatementView[]; nextCursor: string | null; awaitingSettlementAmount: number }> {
    const page = await this.d.store.listProduct(promoterId, filter);
    return { items: page.items.map(statementView), nextCursor: page.nextCursor, awaitingSettlementAmount: 0 };
  }

  /**
   * 파트너 이의(T3, settlement §4.2 '이의 받기'). NOTIFIED이고 기한 전(기한 1밀리초 전까지)일 때만 받는다.
   * 이의 행·DISPUTED·감사·STATEMENT_DISPUTED를 한 트랜잭션에 쓰고, 커밋 뒤 CS 처리함 건을 연다(실패해도 이의는 남는다).
   * 남의 정산서 ID는 없는 ID와 같은 404이고 인가 실패 보안 로그를 남긴다(J-T10).
   */
  async dispute(promoterId: string, accountId: string, statementId: string, body: { reasonCode: string; detail?: string | undefined }): Promise<{ disputeId: string; statement: StatementView }> {
    return guard(async () => {
      validateDispute(body.reasonCode, body.detail);
      const s = await this.d.store.findStatement(promoterId, statementId);
      if (!s) {
        if (await this.d.store.findStatementById(statementId)) this.d.log?.authzDenied?.({ partnerId: promoterId, accountId, statementId, action: 'dispute', at: this.#now() });
        throw notFound();
      }
      const now = this.#now();
      if (s.status !== 'NOTIFIED') throw new SettlementProblem('settlement-not-disputable', 409, '지금은 이의를 낼 수 없는 정산서입니다');
      // 기한 시각부터 닫힌다(기한 1밀리초 전 이의는 받는다). 자동 확정은 기한 시각부터 한다(같은 시각에 둘 다 되지 않는다)
      if (s.disputeDueAt && now.getTime() >= s.disputeDueAt.getTime()) throw new SettlementProblem('settlement-dispute-window-closed', 409, '이의 기간이 끝났습니다');
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
      const audit = this.#audit(statementId, 'NOTIFIED', 'DISPUTED', `dispute-${dispute.reasonCode.toLowerCase()}`, accountId, now);
      const next: StatementRecord = { ...s, status: 'DISPUTED', updatedAt: now };
      const ok = await this.d.store.transitionStatement({
        statementId,
        from: ['NOTIFIED'],
        to: 'DISPUTED',
        ...(s.disputeDueAt ? { expect: { disputeDueAfter: now } } : {}),
        updatedAt: now,
        audits: [audit],
        events: [statementEvent(next, 'STATEMENT_DISPUTED', now, audit.auditId)],
        insertDispute: dispute,
      });
      if (!ok) throw stateConflict();
      await this.#openDisputeCase(dispute);
      return { disputeId: dispute.disputeId, statement: statementView(next) };
    });
  }

  /** CS 처리함 '정산 이의' 건을 연다. 열면 case_requested_at을 채우고, 못 열면 로그만 남긴다(정산 일꾼이 다시 보낸다) */
  async #openDisputeCase(d: DisputeRecord): Promise<boolean> {
    if (!this.d.caseNotice) return false;
    try {
      await this.d.caseNotice.openDispute({ disputeId: d.disputeId, statementId: d.statementId, createdAt: d.submittedAt });
    } catch {
      this.d.log?.caseNoticeFailed?.({ disputeId: d.disputeId, statementId: d.statementId, at: this.#now() });
      return false;
    }
    await this.d.store.markDisputeCaseRequested(d.disputeId, this.#now());
    return true;
  }

  /** 건을 열지 못한 열린 이의를 다시 보낸다(정산 일꾼 30분마다, ADR-0368 결정 5). 연 수를 돌려준다 */
  async retryDisputeCases(limit = CASE_RETRY_LIMIT): Promise<{ opened: number; pending: number }> {
    const pending = await this.d.store.listDisputesAwaitingCase(limit);
    let opened = 0;
    for (const d of pending) if (await this.#openDisputeCase(d)) opened += 1;
    return { opened, pending: pending.length };
  }

  /**
   * 이의 기각(T4, ADR-0368 결정 6). 열린 이의를 DISMISSED·사유·처리자·시각으로 닫고 정산서를 NOTIFIED(처리 시각 + 1영업일)로 돌리며
   * STATEMENT_NOTIFIED(판본 그대로)를 다시 쓴다. DISPUTED가 아니면 409다. 이의 인정(ADJUSTED)은 수기 조정 적용으로만 한다.
   */
  async dismissDispute(statementId: string, input: { reason: string; actorId: string }): Promise<StatementView> {
    return guard(async () => {
      const reason = input.reason.trim();
      if (reason.length < 1 || input.reason.length > DISMISSAL_REASON_MAX) throw new SettlementProblem('invalid-body', 400, '기각 사유는 1~2,000자입니다');
      if (!UUID.test(input.actorId)) throw new SettlementProblem('invalid-body', 400, '처리자가 맞지 않습니다');
      const s = await this.d.store.findStatementById(statementId);
      if (!s) throw notFound();
      if (s.status !== 'DISPUTED') throw new SettlementProblem('settlement-not-disputed', 409, '이의 중인 정산서가 아닙니다');
      const open = (await this.d.store.listDisputes(statementId)).filter((d) => d.result === null);
      const target = open[0];
      if (!target) throw new SettlementProblem('settlement-dispute-not-open', 409, '열린 이의가 없습니다');
      const now = this.#now();
      const disputeDueAt = addKstBusinessDays(now, RENOTIFY_WINDOW_BUSINESS_DAYS, this.#holidays());
      const audit = this.#audit(statementId, 'DISPUTED', 'NOTIFIED', 'dispute-dismissed', input.actorId, now);
      const next: StatementRecord = { ...s, status: 'NOTIFIED', holdReason: null, disputeDueAt, updatedAt: now };
      const ok = await this.d.store.transitionStatement({
        statementId,
        from: ['DISPUTED'],
        to: 'NOTIFIED',
        set: { holdReason: null, disputeDueAt },
        updatedAt: now,
        audits: [audit],
        events: [statementEvent(next, 'STATEMENT_NOTIFIED', now, audit.auditId)],
        resolveDispute: { disputeId: target.disputeId, result: 'DISMISSED', resolvedBy: input.actorId, resolutionNote: reason, resolvedAt: now },
      });
      if (!ok) throw stateConflict();
      return statementView(next);
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
      const notified = await this.#insertNotified(record, sources, now);
      if (!notified) {
        const raced = await this.d.store.findEventStatement(input.promoterId, input.eventId, input.pg, input.pgStore);
        if (!raced) throw new SettlementProblem('settlement-statement-conflict', 409, '같은 회차 정산서가 이미 있습니다');
        return statementView(raced);
      }
      return statementView(notified);
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
        const notified = await this.#insertNotified(record, sources, now);
        if (!notified) continue;
        out.push(statementView(notified));
      }
      return { created: out.length, items: out };
    });
  }

  /** 그 시각(KST)이 주의 첫 영업일이면 계산할 지난주 월~일, 아니면 undefined(상품 정산서, settlement §4.5, ADR-0368 결정 12) */
  productPeriodFor(at: Date): { periodStart: string; periodEnd: string } | undefined {
    return isFirstBusinessDayOfKstWeek(at, this.#holidays()) ? previousKstWeek(at) : undefined;
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
      const now = this.#now();
      if (s.status === 'NOTIFIED' && (!s.disputeDueAt || now.getTime() >= s.disputeDueAt.getTime())) {
        // 기한 시각부터 확정한다. 이의와 겹치면 조건부 전이로 하나만 이긴다(J-T35 ⑥)
        const { transition, next } = this.#confirmTransition(s, now, { from: ['NOTIFIED'], reason: 'dispute-window-ended', actor: 'system', ...(s.disputeDueAt ? { expect: { disputeDueAtOrBefore: now } } : {}) });
        if (!(await this.d.store.transitionStatement(transition))) throw stateConflict();
        return statementView(next);
      }
      return statementView(s);
    });
  }

  /**
   * HELD를 정본이 허용한 사유·증빙으로 다시 CONFIRMED로 푼다(T8, A2-05, A1V-03·04). 지급액이 0 이하면 같은 트랜잭션에서 CARRIED_OVER까지 간다(T6).
   * DISPUTED는 다시 확정하지 않는다. 이의는 기각이나 이의 인정 조정 적용으로만 푼다(ADR-0368 결정 6).
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
      if (s.status !== 'HELD') throw new SettlementProblem('settlement-not-reconfirmable', 409, '보류 상태의 정산서만 다시 확정할 수 있습니다');
      const now = this.#now();
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
        // 증빙 플래그만 믿지 않고 core의 지금 판매 승인 상태를 다시 본다. 답하지 않으면 보류를 유지한다.
        if (s.eventId === null) throw new SettlementProblem('settlement-sale-not-resumed', 409, '회차를 알 수 없어 판매 재개를 확인할 수 없습니다');
        const suspended = await this.d.saleSuspensions.listSuspended([s.eventId]);
        if (suspended.has(s.eventId)) throw new SettlementProblem('settlement-sale-still-suspended', 409, '판매 중지가 아직 풀리지 않았습니다');
      } else {
        throw new SettlementProblem('settlement-not-reconfirmable', 409, '보류 사유를 확인할 수 없어 다시 확정할 수 없습니다');
      }
      const { transition, next } = this.#confirmTransition(s, now, { from: ['HELD'], reason: o.reason ?? s.holdReason ?? 'reconfirm', actor: o.actor ?? 'system' });
      if (!(await this.d.store.transitionStatement(transition))) throw stateConflict();
      return statementView(next);
    });
  }

  /**
   * @deprecated 옛 이의 결과 입력. 내부 경로(…/disputes/{disputeId}/resolution)는 없앴다(ADR-0368 결정 6).
   * ADJUSTED는 수기 조정 적용으로만 되므로 늘 409이고, DISMISSED는 기각(dismissDispute)과 같은 조건부 전이를 쓴다.
   */
  async resolveDispute(statementId: string, disputeId: string, result: 'ADJUSTED' | 'DISMISSED', actor: string): Promise<StatementView> {
    return guard(async () => {
      if (result === 'ADJUSTED') throw new SettlementProblem('settlement-dispute-adjustment-required', 409, '이의 인정은 수기 조정을 적용할 때만 됩니다');
      const s = await this.d.store.findStatementById(statementId);
      if (!s) throw notFound();
      if (s.status !== 'DISPUTED') throw new SettlementProblem('settlement-not-disputed', 409, '이의 중인 정산서가 아닙니다');
      const dispute = (await this.d.store.listDisputes(statementId)).find((d) => d.disputeId === disputeId);
      if (!dispute) throw notFound();
      if (dispute.result !== null) throw new SettlementProblem('settlement-dispute-already-resolved', 409, '이미 결과가 입력된 이의입니다');
      const now = this.#now();
      const disputeDueAt = addKstBusinessDays(now, RENOTIFY_WINDOW_BUSINESS_DAYS, this.#holidays());
      const audit = this.#audit(statementId, 'DISPUTED', 'NOTIFIED', 'dispute-dismissed', actor, now);
      const next: StatementRecord = { ...s, status: 'NOTIFIED', holdReason: null, disputeDueAt, updatedAt: now };
      const ok = await this.d.store.transitionStatement({
        statementId,
        from: ['DISPUTED'],
        to: 'NOTIFIED',
        set: { holdReason: null, disputeDueAt },
        updatedAt: now,
        audits: [audit],
        events: [statementEvent(next, 'STATEMENT_NOTIFIED', now, audit.auditId)],
        resolveDispute: { disputeId, result: 'DISMISSED', resolvedBy: UUID.test(actor) ? actor : null, resolutionNote: null, resolvedAt: now },
      });
      if (!ok) throw stateConflict();
      return statementView(next);
    });
  }

  /**
   * 이의 기간이 끝난 NOTIFIED 정산서를 자동 확정한다(T5, M1-F3). 정산 일꾼이 30분 [가정]마다 부른다.
   * DISPUTED·HELD·기한 전 NOTIFIED는 대상이 아니다. 다른 전이가 먼저 쓴 정산서(409)는 건너뛴다.
   */
  async confirmDueStatements(limit = 100): Promise<{ confirmed: number; items: StatementView[] }> {
    return guard(async () => {
      const due = await this.d.store.listDueConfirmation(this.#now(), limit);
      const items: StatementView[] = [];
      for (const s of due) {
        try {
          items.push(await this.confirmDue(s.statementId));
        } catch (e) {
          if (e instanceof ProblemError && e.status === 409) continue;
          throw e;
        }
      }
      return { confirmed: items.filter((s) => s.status === 'CONFIRMED' || s.status === 'CARRIED_OVER').length, items };
    });
  }

  // ---- 수기 조정(settlement §4.3, ADR-0368 결정 7·8·9) ----

  /**
   * 조정 행 등록(ops-svc가 승인 업무 ID를 먼저 정해 부른다). 검사는 이쪽이 한다. 같은 승인 ID 재요청은 처음 행이고(내용이 다르면 409),
   * 그 정산서에 적용 전 조정이 있으면 409 settlement-adjustment-pending이다.
   */
  async requestAdjustment(statementId: string, req: AdjustmentRequest): Promise<{ adjustment: AdjustmentView; created: boolean }> {
    return guard(async () => {
      if (!UUID.test(req.approvalId)) throw new SettlementProblem('invalid-body', 400, '승인 업무 ID가 맞지 않습니다');
      if (!UUID.test(req.requestedBy)) throw new SettlementProblem('invalid-body', 400, '요청자가 맞지 않습니다');
      const existing = await this.d.store.findAdjustmentByApproval(req.approvalId);
      if (existing) {
        if (!sameAdjustmentRequest(existing, statementId, req)) throw new SettlementProblem('settlement-adjustment-approval-reused', 409, '이 승인 업무 ID는 다른 조정에 이미 썼습니다');
        return { adjustment: adjustmentView(existing), created: false };
      }
      const s = await this.d.store.findStatementById(statementId);
      if (!s) throw notFound();
      const disputes = await this.d.store.listDisputes(statementId);
      validateAdjustment(req, s, disputes);
      const record: AdjustmentRecord = {
        adjustmentId: uuidv7(this.d.clock),
        statementId,
        approvalId: req.approvalId,
        reasonCode: req.reasonCode,
        disputeId: req.disputeId ?? null,
        amount: req.amount,
        evidenceNote: req.evidenceNote?.trim() ? req.evidenceNote : null,
        status: 'PENDING',
        requestedBy: req.requestedBy,
        requestedAt: this.#now(),
        appliedAt: null,
      };
      const out = await this.d.store.insertAdjustment(record);
      if (out === 'pending') throw new SettlementProblem('settlement-adjustment-pending', 409, '적용 전 조정이 이미 있습니다');
      if (!out.created && !sameAdjustmentRequest(out.record, statementId, req)) throw new SettlementProblem('settlement-adjustment-approval-reused', 409, '이 승인 업무 ID는 다른 조정에 이미 썼습니다');
      return { adjustment: adjustmentView(out.record), created: out.created };
    });
  }

  /**
   * 승인된 조정 적용(T4 이의 인정·T18 이의 없는 조정). 승인 ID를 믿지 않고 ops 승인 기록과 대조한 뒤(ADR-0368 결정 8),
   * 한 트랜잭션에 조정 행 APPLIED·조정 합계·지급액(계산 칸 그대로)·이의 ADJUSTED(인정이면)·NOTIFIED(적용 시각 + 1영업일)·감사·STATEMENT_NOTIFIED를 쓴다.
   * 같은 승인 ID를 다시 부르면 ops를 다시 부르지 않고 처음 결과를 준다.
   */
  async applyAdjustment(approvalId: string): Promise<{ adjustment: AdjustmentView; statement: StatementView }> {
    return guard(async () => {
      if (!UUID.test(approvalId)) throw notFound();
      const a = await this.d.store.findAdjustmentByApproval(approvalId);
      if (!a) throw notFound();
      const s = await this.d.store.findStatementById(a.statementId);
      if (!s) throw notFound();
      if (a.status === 'APPLIED') return { adjustment: adjustmentView(a), statement: statementView(s) };
      if (a.status === 'VOID') throw new SettlementProblem('settlement-adjustment-void', 409, '반려·만료된 조정입니다');
      assertAdjustable(s.status);
      const dispute = a.disputeId !== null ? (await this.d.store.listDisputes(s.statementId)).find((d) => d.disputeId === a.disputeId) : undefined;
      if (a.disputeId !== null && (s.status !== 'DISPUTED' || !dispute || dispute.result !== null)) throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 409, '그 이의가 이미 닫혔거나 정산서가 이의 중이 아닙니다');
      if (a.disputeId === null && s.status === 'DISPUTED') throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 409, '이의 중인 정산서에는 이의 없는 조정을 적용하지 않습니다');
      if (!this.d.adjustmentApprovals) throw new SettlementProblem('dependency-unavailable', 503, '조정 승인 기록을 확인할 수 없습니다');
      let facts: VerifiedAdjustmentApproval | undefined;
      try {
        facts = await this.d.adjustmentApprovals.verify(approvalId);
      } catch (e) {
        // 확인기가 SettlementProblem 밖의 오류를 던져도 돈 경로는 503으로 닫는다(지급 묶음 승인과 같다)
        throw e instanceof SettlementProblem ? e : new SettlementProblem('dependency-unavailable', 503, '조정 승인 기록을 확인하지 못했습니다');
      }
      if (!facts) throw new SettlementProblem('settlement-adjustment-approval-missing', 409, 'ops-svc에서 승인 업무를 찾지 못했습니다');
      adjustmentFactsOf(facts, a);
      const now = this.#now();
      const current = s.adjustmentAmount ?? 0;
      const adjustmentAmount = current + a.amount;
      const payoutAmount = payoutWithAdjustment(s, adjustmentAmount);
      const disputeDueAt = addKstBusinessDays(now, RENOTIFY_WINDOW_BUSINESS_DAYS, this.#holidays());
      const audit = this.#audit(s.statementId, s.status, 'NOTIFIED', `adjustment-applied-${a.reasonCode.toLowerCase()}`, facts.approvals[0] ?? 'system', now);
      const next: StatementRecord = { ...s, status: 'NOTIFIED', holdReason: null, adjustmentAmount, payoutAmount, disputeDueAt, updatedAt: now };
      const ok = await this.d.store.transitionStatement({
        statementId: s.statementId,
        // 이의 인정은 DISPUTED에서만(T4), 이의 없는 조정은 NOTIFIED·CONFIRMED에서(T18). 지급 묶음 등 다른 전이가 먼저 썼으면 409
        from: isDisputeAdjustmentCode(a.reasonCode) ? ['DISPUTED'] : ['NOTIFIED', 'CONFIRMED'],
        to: 'NOTIFIED',
        set: { holdReason: null, adjustmentAmount, payoutAmount, disputeDueAt },
        expect: { adjustmentAmount: current, offsetAmount: s.offsetAmount, unbatched: true },
        updatedAt: now,
        audits: [audit],
        events: [statementEvent(next, 'STATEMENT_NOTIFIED', now, audit.auditId)],
        applyAdjustment: { approvalId, appliedAt: now },
        ...(a.disputeId !== null ? { resolveDispute: { disputeId: a.disputeId, result: 'ADJUSTED' as const, resolvedBy: facts.approvals[0] !== undefined && UUID.test(facts.approvals[0]) ? facts.approvals[0] : null, resolutionNote: null, resolvedAt: now } } : {}),
      });
      if (!ok) {
        // 다른 요청이 같은 승인 ID를 먼저 적용했으면 그 결과를 준다
        const raced = await this.d.store.findAdjustmentByApproval(approvalId);
        const latest = await this.d.store.findStatementById(s.statementId);
        if (raced?.status === 'APPLIED' && latest) return { adjustment: adjustmentView(raced), statement: statementView(latest) };
        throw stateConflict();
      }
      return { adjustment: adjustmentView({ ...a, status: 'APPLIED', appliedAt: now }), statement: statementView(next) };
    });
  }

  /** 반려된 조정(ops 승인 업무 REJECTED)을 VOID로 닫는다. 이의는 열린 채 남는다. 이미 적용했으면 409 */
  async voidAdjustment(approvalId: string): Promise<AdjustmentView> {
    return guard(async () => {
      if (!UUID.test(approvalId)) throw notFound();
      const a = await this.d.store.findAdjustmentByApproval(approvalId);
      if (!a) throw notFound();
      if (a.status === 'VOID') return adjustmentView(a);
      if (a.status === 'APPLIED') throw new SettlementProblem('settlement-adjustment-applied', 409, '이미 적용한 조정입니다');
      if (!(await this.d.store.voidAdjustment(approvalId, this.#now()))) {
        const latest = await this.d.store.findAdjustmentByApproval(approvalId);
        if (latest?.status === 'VOID') return adjustmentView(latest);
        throw new SettlementProblem('settlement-adjustment-applied', 409, '이미 적용한 조정입니다');
      }
      return adjustmentView({ ...a, status: 'VOID' });
    });
  }

  /** 승인 업무가 생기지 않아 남은 PENDING 조정을 7일 [가정] 뒤 VOID로 닫는다(정산 일꾼) */
  async voidStaleAdjustments(): Promise<number> {
    return this.d.store.voidStalePendingAdjustments(new Date(this.d.clock.now() - ADJUSTMENT_PENDING_TTL_MS), STALE_ADJUSTMENT_LIMIT);
  }

  async recordKyc(
    promoterId: string,
    status: KycStatus,
    o: {
      businessVerified?: boolean;
      representativeVerified?: boolean;
      legalName?: string;
      representative?: string;
      source?: string;
      tossSellerId?: string;
      tossSellerStatus?: TossSellerStatus;
    } = {},
  ): Promise<KycRecord> {
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
      ...(o.tossSellerId === undefined ? {} : { tossSellerId: o.tossSellerId }),
      ...(o.tossSellerStatus === undefined ? {} : { tossSellerStatus: o.tossSellerStatus }),
    };
    await this.d.store.saveKyc(record);
    return record;
  }

  /** seller.changed 웹훅이 부른다. 토스 셀러 ID로 찾은 KYC만 바꾸고, 없으면 undefined(404)다. */
  async applySellerChanged(tossSellerId: string, status: string): Promise<KycRecord | undefined> {
    const normalized = status.trim().toUpperCase() as TossSellerStatus;
    if (!TOSS_SELLER_STATUSES.includes(normalized)) throw new SettlementProblem('invalid-query', 422, '셀러 상태가 맞지 않습니다');
    const kyc = await this.d.store.findKycByTossSellerId(tossSellerId);
    if (!kyc) return undefined;
    const now = new Date(this.d.clock.now());
    const next: KycRecord = {
      ...kyc,
      tossSellerStatus: normalized,
      status: normalized === 'APPROVED' ? 'VERIFIED' : normalized === 'REJECTED' ? 'REJECTED' : 'PENDING',
      businessVerified: normalized === 'APPROVED' ? true : kyc.businessVerified,
      representativeVerified: normalized === 'APPROVED' ? true : kyc.representativeVerified,
      verifiedAt: normalized === 'APPROVED' ? now : kyc.verifiedAt,
      updatedAt: now,
    };
    await this.d.store.saveKyc(next);
    return next;
  }

  /** KYC 예고(settlement §6, J-T19). 지급일 앞뒤 6일의 토스 지급 합계가 1,000만 원 이상인 PARTIALLY_APPROVED 셀러만 true다. */
  async kycNotice(promoterId: string, aroundDate: string): Promise<KycNotice> {
    return guard(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(aroundDate)) throw new SettlementProblem('invalid-query', 422, '지급일이 맞지 않습니다');
      const kyc = await this.d.store.findKyc(promoterId);
      const sellerStatus = kyc?.tossSellerStatus ?? 'PENDING';
      const from = addDays(aroundDate, -KYC_NOTICE_WINDOW_DAYS);
      const to = addDays(aroundDate, KYC_NOTICE_WINDOW_DAYS);
      const amount = await this.d.store.sumScheduledTossPayouts(promoterId, from, to);
      return {
        promoterId,
        sellerStatus,
        from,
        to,
        amount,
        threshold: KYC_NOTICE_THRESHOLD,
        notice: sellerStatus === 'PARTIALLY_APPROVED' && amount >= KYC_NOTICE_THRESHOLD,
      };
    });
  }

  /** SCR-049 묶음 상세. 묶인 정산서·지급 건·같은 지급일의 HELD 정산서·KYC 예고를 함께 준다. */
  async getPayoutBatchDetail(batchId: string): Promise<PayoutBatchDetail> {
    return guard(async () => {
      const batch = await this.d.store.findPayoutBatch(batchId);
      if (!batch) throw notFound();
      const [statements, payouts, holds] = await Promise.all([
        this.d.store.listStatementsByBatch(batchId),
        this.d.store.listPayouts(batchId),
        this.d.store.listHeldStatements(batch.pg, batch.pgStore, batch.payoutDate),
      ]);
      const promoterIds = [...new Set([...statements, ...holds].map((s) => s.promoterId))];
      const kycNotices = await Promise.all(promoterIds.map((id) => this.kycNotice(id, batch.payoutDate)));
      return {
        batch: payoutBatchView(batch),
        statements: statements.map(statementView),
        payouts,
        holds: holds.map(statementView),
        kycNotices,
      };
    });
  }

  /**
   * 보증금·이행보증보험 징수(settlement §7, ADR-0046·0320). 미수금 발생 30일 뒤에만,
   * 그 미수금 근거 정산서의 판매 대금 × 계약 보증 비율까지 충당한다. commander 재인증·멱등 키가 필요하다.
   */
  async collectGuarantee(
    receivableId: string,
    input: { actor: string; sessionId: string; reauthToken?: string | undefined; idempotencyKey: string; reason: string },
  ): Promise<{ collection: GuaranteeCollectionRecord; receivable: ReceivableRecord }> {
    return guard(async () => {
      const key = input.idempotencyKey.trim();
      if (key === '' || key.length > 128) throw new SettlementProblem('invalid-query', 422, '멱등 키가 필요합니다');
      if (input.reason.trim() === '' || input.reason.length > 2_000) throw new SettlementProblem('invalid-query', 422, '보증 충당 사유가 필요합니다');
      const existing = await this.d.store.findGuaranteeCollection(key);
      if (existing) {
        const row = await this.d.store.findReceivable(existing.receivableId);
        if (!row) throw notFound();
        return { collection: existing, receivable: row };
      }
      const receivable = await this.d.store.findReceivable(receivableId);
      if (!receivable) throw notFound();
      if (receivable.status !== 'OPEN' || receivable.remaining <= 0) throw new SettlementProblem('guarantee-not-open', 409, '열린 미수금이 아닙니다');
      const now = new Date(this.d.clock.now());
      if (now.getTime() - receivable.createdAt.getTime() < GUARANTEE_DUE_DAYS * DAY_MS) {
        throw new SettlementProblem('guarantee-not-due', 409, '미수금 발생 30일이 지나야 보증으로 충당할 수 있습니다');
      }
      if (!this.d.promoterContracts) throw new SettlementProblem('guarantee-contract-unavailable', 503, '보증 계약을 확인할 수 없습니다');
      const contract = await this.d.promoterContracts.current(receivable.promoterId);
      if (!contract) throw new SettlementProblem('guarantee-contract-missing', 409, '지금 계약 조건이 없습니다');
      const eventId = receivable.eventId;
      if (!eventId) throw new SettlementProblem('guarantee-basis-unavailable', 422, '보증 한도를 계산할 회차를 알 수 없습니다');
      const statements = await this.d.store.listEvent(receivable.promoterId, eventId);
      const basis = statements
        .filter((s) => receivable.pg === null || s.pg === receivable.pg)
        .sort((a, b) => b.grossAmount - a.grossAmount)[0];
      if (!basis) throw new SettlementProblem('guarantee-basis-unavailable', 422, '보증 한도를 계산할 정산서가 없습니다');
      const limit = Math.floor((Math.max(0, basis.grossAmount) * contract.guaranteeRateBp) / 10_000);
      if (limit <= 0) throw new SettlementProblem('guarantee-capacity-exhausted', 409, '계약 보증 한도가 없습니다');
      const moves = await this.d.store.listReceivableMovesForReceivable(receivableId);
      const already = moves.reduce((sum, m) => sum + m.amount, 0);
      const take = Math.min(receivable.remaining, Math.max(0, limit - already));
      if (take <= 0) throw new SettlementProblem('guarantee-capacity-exhausted', 409, '계약 보증 한도를 모두 썼습니다');
      await this.d.reauth.verify(input.reauthToken, { sessionId: input.sessionId, act: 'APPROVAL' });
      const collection: GuaranteeCollectionRecord = {
        collectionId: uuidv7(this.d.clock),
        idempotencyKey: key,
        receivableId,
        promoterId: receivable.promoterId,
        guaranteeKind: contract.guaranteeKind as GuaranteeKind,
        amount: take,
        basisAmount: basis.grossAmount,
        guaranteeRateBp: contract.guaranteeRateBp,
        actor: input.actor,
        reason: input.reason.trim(),
        createdAt: now,
      };
      const remaining = receivable.remaining - take;
      const next: ReceivableRecord = { ...receivable, remaining, status: remaining === 0 ? 'CLOSED' : 'OPEN', updatedAt: now };
      await this.d.store.collectGuaranteeAtomically({
        collection,
        move: { receivableId, statementId: basis.statementId, amount: take, movedAt: now },
        receivable: { receivableId, remaining, status: next.status, updatedAt: now },
      });
      return { collection, receivable: next };
    });
  }

  async createPayoutBatch(input: { pg: Pg; pgStore: PgStore; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const now = new Date(this.d.clock.now());
      const existing = await this.d.store.listPayoutBatches({ pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, status: ['PENDING_APPROVAL', 'APPROVED', 'SUBMITTED'], limit: 1 });
      if (existing.length > 0) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
      const confirmed = await this.d.store.listConfirmed(input.pg, input.pgStore, input.payoutDate);
      // 판매 중지된 공연의 회차 정산서는 결제사와 관계없이 이번 묶음에서 뺀다(ADR-0123, settlement §6).
      // core가 답하지 않으면 묶음을 만들지 않는다(503). 상태를 바꾸기 전에 확인한다.
      const suspended = await this.#suspendedEventIds(confirmed);
      const included: StatementRecord[] = [];
      const statementUpdates: StatementUpdate[] = [];
      const receivableUpdates: ReceivableUpdate[] = [];
      const receivableMoves: ReceivableMoveRecord[] = [];
      let heldKyc = 0;
      let heldAccount = 0;
      let heldMismatch = 0;
      let heldSuspended = 0;
      for (const s of confirmed) {
        if (s.eventId !== null && suspended.has(s.eventId)) {
          heldSuspended += 1;
          statementUpdates.push(this.#holdUpdate(s, 'SALE_SUSPENDED', now));
          continue;
        }
        const kyc = await this.d.store.findKyc(s.promoterId);
        if (kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified) {
          const account = await this.d.store.findPayoutAccount(s.promoterId);
          if (account && account.holdUntil.getTime() > now.getTime()) {
            heldAccount += 1;
            statementUpdates.push(this.#holdUpdate(s, 'ACCOUNT_CHANGE', now));
            continue;
          }
          if (account && !account.holderVerified) {
            heldMismatch += 1;
            statementUpdates.push(this.#holdUpdate(s, 'ACCOUNT_MISMATCH', now));
            continue;
          }
          included.push(s);
        } else {
          heldKyc += 1;
          statementUpdates.push(this.#holdUpdate(s, 'KYC', now));
        }
      }
      if (included.length === 0) {
        // 모두 보류됐어도 보류를 조건부로 저장한 뒤 409다(BAT-625 RV-04, ADR-0368 결정 11). 다른 전이가 먼저 썼으면 409 settlement-state-conflict
        if (statementUpdates.length > 0 && !(await this.d.store.transitionStatements(statementUpdates.map((u) => Settlements.#holdTransition(u))))) throw stateConflict();
        if (heldSuspended > 0) throw new SettlementProblem('payout-sale-suspended', 409, '판매 중지된 공연의 정산서라 지급할 수 없습니다');
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
          const carried = next.status === 'CARRIED_OVER' ? this.#audit(s.statementId, s.status, 'CARRIED_OVER', 'offset-exhausted', 'system', now) : undefined;
          statementUpdates.push({
            statementId: s.statementId,
            status: next.status,
            holdReason: next.holdReason,
            offsetAmount: next.offsetAmount,
            payoutAmount: next.payoutAmount,
            updatedAt: now,
            from: ['CONFIRMED'],
            ...(carried ? { audits: [carried], events: [statementEvent(next, 'STATEMENT_CARRIED_OVER', now, carried.auditId)] } : {}),
          });
          if (remaining > 0) includedAfterOffset.push(next);
        } else {
          includedAfterOffset.push(s);
        }
      }
      for (const [receivableId, u] of receivableRemaining) receivableUpdates.push({ receivableId, remaining: u.remaining, status: u.status, updatedAt: now });
      if (includedAfterOffset.length === 0) throw new SettlementProblem('payout-batch-empty', 409, '상계 뒤 지급할 정산서가 없습니다');
      const totalAmount = includedAfterOffset.reduce((sum, s) => sum + s.payoutAmount, 0);
      if (input.pg === 'PORTONE' && !input.portoneBalance) throw new SettlementProblem('invalid-query', 422, '포트원 지급대행 계좌 잔액이 필요합니다');
      let tossBalance: { availableAmount: number; pendingAmount: number } | undefined;
      if (input.pg === 'TOSS' && this.d.pgBalance) {
        try {
          tossBalance = await this.d.pgBalance.available({ pg: 'TOSS', pgStore: input.pgStore });
        } catch {
          // 잔액을 읽지 못하면 지급 묶음을 만들지 않는다(settlement §5.1). 정산서 상태도 바꾸지 않는다.
          throw new SettlementProblem('pg-balance-unavailable', 503, '결제사 잔액을 확인할 수 없습니다');
        }
      }
      const available = input.pg === 'PORTONE' ? input.portoneBalance?.amount : tossBalance?.availableAmount;
      if (available !== undefined && available < totalAmount) {
        // 잔액이 모자라면 묶음을 만들지 않고 그 정산서를 HELD·BALANCE로 남긴다(settlement §6, J-T13).
        // 상계는 아직 적용하지 않는다. 미수금은 다음 묶음에서 다시 본다.
        const nowForHold = this.#now();
        // 같은 요청에서 다른 사유로 빠진 정산서의 보류도 함께 저장한다(모두 보류된 묶음과 같은 규칙, ADR-0368 결정 11)
        const holds = [...statementUpdates.filter((u) => u.status === 'HELD').map((u) => Settlements.#holdTransition(u)), ...included.map((s) => Settlements.#holdTransition(this.#holdUpdate(s, 'BALANCE', nowForHold)))];
        if (!(await this.d.store.transitionStatements(holds))) throw stateConflict();
        throw new SettlementProblem('payout-balance-insufficient', 409, '결제사 잔액이 모자라 지급일을 미룹니다');
      }
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
      if (typeof approvalId !== 'string' || approvalId.trim() === '') throw new SettlementProblem('invalid-query', 422, '승인 업무 ID가 필요합니다');
      const id = approvalId.trim();
      if (!APPROVAL_ID.test(id)) throw new SettlementProblem('invalid-query', 422, '승인 업무 ID가 올바르지 않습니다');
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      // 실행 실패 뒤 같은 승인 업무로 다시 승인하면 승인은 한 번만 반영하고 실행만 다시 한다.
      // 같은 승인 ID의 멱등 재요청은 ops를 다시 부르지 않고 처음 결과를 그대로 돌려준다.
      if (b.approvalId === id && (b.status === 'APPROVED' || b.status === 'SUBMITTED' || b.status === 'COMPLETED')) return payoutBatchView(b);
      if (b.status !== 'PENDING_APPROVAL') throw new SettlementProblem('payout-batch-not-approved', 409, '승인 대기 중인 지급 묶음이 아닙니다');
      if (b.approvalId !== null) throw new SettlementProblem('payout-approval-reused', 409, '이미 다른 승인으로 처리된 지급 묶음입니다');
      const now = new Date(this.d.clock.now());
      let facts: VerifiedPayoutApproval | undefined;
      try {
        facts = await this.d.approvals.verify(id);
        if (!facts) throw new SettlementProblem('payout-approval-missing', 409, 'ops-svc에서 승인 업무를 찾지 못했습니다');
        approvalFactsOf(facts, b);
      } catch (e) {
        // 확인기가 SettlementProblem 밖의 오류(프로그램 결함·다른 구현)를 던져도 돈 경로는 503으로 닫는다.
        // ops가 5xx·시간 초과일 때와 같은 결과이고, payout_batch 상태는 바꾸지 않는다.
        const problem = e instanceof SettlementProblem ? e : new SettlementProblem('dependency-unavailable', 503, '승인 기록을 확인하지 못했습니다');
        await this.#auditRejected(b, id, problem.type, facts, now);
        throw problem;
      }
      if (!facts) throw new SettlementProblem('payout-approval-missing', 409, 'ops-svc에서 승인 업무를 찾지 못했습니다');
      const next: PayoutBatchRecord = { ...b, status: 'APPROVED', approvalId: id, updatedAt: now };
      const audit: PayoutBatchAuditRecord = {
        auditId: uuidv7(this.d.clock),
        batchId: b.batchId,
        approvalId: id,
        event: 'APPROVED',
        reason: 'verified',
        requesterId: facts.requestedBy,
        approverId: facts.approvals[0] ?? null,
        amount: b.totalAmount,
        currency: batchCurrency,
        createdAt: now,
      };
      const saved = await this.d.store.approvePayoutBatchAtomically(next, audit);
      if (!saved) {
        await this.#auditRejected(b, id, 'payout-approval-conflict', facts, now);
        throw new SettlementProblem('payout-approval-conflict', 409, '다른 사람이 먼저 승인했습니다');
      }
      this.d.log?.approved({
        batchId: b.batchId,
        approvalId: id,
        requesterId: facts.requestedBy,
        approverId: facts.approvals[0]!,
        amount: b.totalAmount,
        pg: b.pg,
        pgStore: b.pgStore,
        payoutDate: b.payoutDate,
        at: now,
      });
      return payoutBatchView(next);
    });
  }

  /** 거절 사유와 확인한 사실(있으면)을 감사 표·로그에 남긴다. 배치 상태는 바꾸지 않는다. */
  async #auditRejected(b: PayoutBatchRecord, approvalId: string, reason: string, facts: VerifiedPayoutApproval | undefined, now: Date): Promise<void> {
    const audit: PayoutBatchAuditRecord = {
      auditId: uuidv7(this.d.clock),
      batchId: b.batchId,
      approvalId,
      event: 'REJECTED',
      reason,
      requesterId: facts?.requestedBy ?? null,
      approverId: facts?.approvals[0] ?? null,
      amount: facts?.amount ?? null,
      currency: batchCurrency,
      createdAt: now,
    };
    try {
      await this.d.store.insertPayoutBatchAudit(audit);
    } catch {
      // 감사 행을 쓰지 못해도 원래 거절(4xx/503)을 500으로 바꾸지 않는다. 로그로 남긴다.
    }
    this.d.log?.rejected({ batchId: b.batchId, approvalId, reason, at: now });
  }

  /** 정산서가 속한 회차 중 판매 중지된 것. 회차가 없는 상품 정산서는 확인 대상이 아니다. */
  async #suspendedEventIds(statements: readonly StatementRecord[]): Promise<ReadonlySet<string>> {
    const eventIds = [...new Set(statements.map((s) => s.eventId).filter((id): id is string => id !== null && id !== ''))];
    if (eventIds.length === 0) return new Set();
    return this.d.saleSuspensions.listSuspended(eventIds);
  }

  async #assertNoSaleSuspension(statements: readonly StatementRecord[]): Promise<void> {
    const suspended = await this.#suspendedEventIds(statements);
    if (suspended.size > 0) throw new SettlementProblem('payout-sale-suspended', 409, '판매 중지된 공연의 정산서가 있어 지급할 수 없습니다');
  }

  async executeBatch(batchId: string): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      if (b.status !== 'APPROVED') throw new SettlementProblem('payout-batch-not-approved', 409, '승인된 지급 묶음이 아닙니다');
      // 승인 기록을 거치지 않고 APPROVED가 된 묶음은 실행하지 않는다(승인 ID가 없으면 승인 근거가 없다).
      if (!b.approvalId) throw new SettlementProblem('payout-batch-not-approved', 409, '승인 업무 ID가 없는 지급 묶음입니다');
      const boundStatements = await this.d.store.listStatementsByBatch(batchId);
      if (boundStatements.length === 0) throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
      // 승인 뒤 판매가 중지됐을 수 있다. 결제사에 요청하기 직전에 다시 확인하고, 하나라도 중지면 멈춘다(ADR-0123).
      await this.#assertNoSaleSuspension(boundStatements);
      const gateway = this.d.gateways.find((g) => g.pg === b.pg);
      if (!gateway) throw new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
      const now = new Date(this.d.clock.now());
      const boundTotal = boundStatements.reduce((sum, s) => sum + s.payoutAmount, 0);
      if (boundTotal !== b.totalAmount) throw new SettlementProblem('payout-batch-amount-mismatch', 409, '승인한 지급 금액과 정산서 합계가 다릅니다');
      let payouts = await this.d.store.listPayouts(batchId);
      if (payouts.length === 0) {
        const next: PayoutRecord[] = [];
        for (const s of boundStatements) {
          // 토스는 한 지급 건이 10억 원 미만이어야 한다(settlement §5.2, J-T4). 정산서 지급액을 조각내고
          // 순번은 정산서마다 1부터 센다. 포트원은 콘솔 수기 실행이라 한 건을 그대로 쓴다.
          const amounts = b.pg === 'TOSS' ? splitTossPayoutAmount(s.payoutAmount) : [s.payoutAmount];
          amounts.forEach((amount, i) => {
            const seq = i + 1;
            next.push({
              payoutId: uuidv7(this.d.clock),
              batchId,
              statementId: s.statementId,
              seq,
              amount,
              refPayoutId: `${s.statementId}-${seq}`,
              pgPayoutId: null,
              status: 'REQUESTED',
              errorCode: null,
              pgTransferId: null,
              transferCheck: null,
              transferCheckedAt: null,
              createdAt: now,
              updatedAt: now,
            });
          });
        }
        payouts = next;
        await this.d.store.insertPayouts(payouts);
      }
      if (payouts.reduce((sum, p) => sum + p.amount, 0) !== b.totalAmount) {
        throw new SettlementProblem('payout-batch-amount-mismatch', 409, '승인한 지급 금액과 지급 건 합계가 다릅니다');
      }
      const result = await gateway.submit({ batch: b, payouts });
      const nextStatus = result.status === 'COMPLETED' ? 'COMPLETED' : 'SUBMITTED';
      const next = { ...b, status: nextStatus as PayoutBatchRecord['status'], updatedAt: now };
      await this.d.store.savePayoutBatch(next);
      // 지급 사건(PAYOUT_*)과 지급 상태의 세부는 LCH-110 몫이다. 여기서는 출발 상태(SCHEDULED·CONFIRMED) 조건만 걸어 덮어쓰지 않는다.
      // 결제사에 이미 보냈으므로 조건이 어긋나도 실행 결과를 뒤집지 않는다
      const target: StatementStatus = nextStatus === 'COMPLETED' ? 'PAID' : 'SCHEDULED';
      for (const s of boundStatements) {
        if (s.status === target) continue;
        await this.d.store.transitionStatement({
          statementId: s.statementId,
          from: ['SCHEDULED', 'CONFIRMED'],
          to: target,
          updatedAt: now,
          audits: [this.#audit(s.statementId, s.status, target, `payout-${nextStatus.toLowerCase()}`, 'system', now)],
          events: [],
        });
      }
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
