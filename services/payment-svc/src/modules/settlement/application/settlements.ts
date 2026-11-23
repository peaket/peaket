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
  PayoutFactSnapshot,
  PayoutGateway,
  PayoutWrite,
  PgBalanceSource,
  PgLedgerSource,
  ProductSettlementSource,
  PromoterContractSource,
  ReauthVerifier,
  ReceivableUpdate,
  SaleSuspensionSource,
  SettlementApprovalLog,
  SettlementCaseNotice,
  SettlementPaymentSource,
  SettlementSignals,
  SettlementStore,
  StatementFilter,
  StatementTransition,
  StatementUpdate,
  TossPayoutTransport,
  TossSendResult,
  VerifiedAdjustmentApproval,
  VerifiedPayoutApproval,
} from '../domain/ports.js';
import type { OpsIntakeRow, OpsIntakeTarget, PayoutAccountAuditSink, PortonePlatformTransport, SettlementAlertSink, VerifiedReauth } from '../domain/ports.js';
import { REFUND_BANK_CODES } from '@peaket/validation/refund-account';
import { kstDateOf } from './portone-payouts.js';
import { z } from 'zod';
import { PayoutAgencies, type PayoutAgencySyncInput, type PayoutAgencySyncResult } from './payout-agencies.js';
import { EventRecalculations } from './event-recalculation.js';
import { ExcludedPaymentResolution } from './excluded-payment-resolution.js';
import { RefundsAfterCalculation } from './refunds-after-calculation.js';
import { portoneLedgerBalance, PortonePayouts } from './portone-payouts.js';
import type { PortonePayoutConfig } from '../domain/payout-adapters.js';
import { classifyTossFailure, DEFAULT_TOSS_PAYOUT_TERMS, ledgerBalance, splitTossPayoutAmount, TOSS_PAYOUT_DATE_ERRORS, type TossPayoutTerms } from '../domain/payout-adapters.js';
import { nextBankBusinessDay, payoutFailureAction, retryPayoutDate, submitBackoffMs, submitDeadlineFor } from '../domain/payout-failure.js';
import { kstMonthOf, payoutUsageFee, pgBalanceSeverity } from '../domain/pg-balance-reconciliation.js';
import { isBatchableTossSeller, parseTossSellerRegistration, TOSS_SELLER_STORES, tossRefSellerId, type TossSellerRegistrationInput } from '../domain/toss-seller.js';
import { addBusinessDays as addKstBusinessDays, isFirstBusinessDayOfKstWeek, previousKstWeek } from '../domain/business-calendar.js';
import {
  ADJUSTMENT_PENDING_TTL_MS,
  adjustmentView,
  assertAdjustable,
  isDisputeAdjustmentCode,
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
  payoutAmountOf,
  payoutBatchView,
  receivableOpenedEvent,
  RENOTIFY_WINDOW_BUSINESS_DAYS,
  SettlementProblem,
  statementEvent,
  statementView,
  validateDispute,
  type DisputeRecord,
  type HoldReason,
  type GuaranteeCollectionRecord,
  type GuaranteeKind,
  type KycNotice,
  type KycRecord,
  type KycStatus,
  type OpsRefusal,
  type PayoutAccountChangeRecord,
  type PayoutAccountRecord,
  type PayoutAgency,
  type PayoutAgencyResults,
  payoutEvent,
  receivableClosedEvent,
  ReceivableBalanceConflict,
  TOSS_SELLER_STATUSES,
  type PayoutBatchAuditRecord,
  type PgBalanceReconciliationRecord,
  type SettlementCaseKind,
  type SettlementCaseRequestRecord,
  type TossSellerRecord,
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
  type EventRecalculationView,
  type RecalculationKind,
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
  /** 토스 지급대행 전송(셀러 등록·셀러 조회·미완료 점검·잔액 대사, F-07-6). 없으면 셀러 등록은 503이고 토스 자동 일(09시 묶음·점검·대사)을 하지 않는다 */
  readonly tossTransport?: TossPayoutTransport;
  /** 정산 지급 지표(ADR-0369 결정 12) */
  readonly signals?: SettlementSignals;
  /** 토스 지급대행 이용료 계약 조건(없으면 공개 안내 기본값) */
  readonly tossTerms?: TossPayoutTerms;
  /** 결제사 잔액 대사의 장부 원천. 없으면 잔액 대사를 하지 않는다 */
  readonly pgLedger?: PgLedgerSource;
  /** 포트원 플랫폼 전송(F-07-7 ADR-0370 결정 1·7·8). 없으면 포트원 지급대행 꺼짐(예금주 조회 불가, 콘솔 실행 기록만) */
  readonly portone?: PortonePlatformTransport;
  /** 포트원 지급대행 설정(계약 ID). portone과 함께 있다 */
  readonly portoneConfig?: PortonePayoutConfig;
  /** ops 감사 받기(PAYOUT_ACCOUNT_CHANGED). 없으면 변경 행은 남고 보낸 시각이 빈다 */
  readonly payoutAccountAudit?: PayoutAccountAuditSink;
  /** ops 운영 경보 받기. 없으면 경보 요청 행은 남고 보낸 시각이 빈다 */
  readonly alerts?: SettlementAlertSink;
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
/** 묶음 전송을 잡아 두는 시간(잡은 파드가 멈추면 이 뒤 다른 파드가 다시 본다) [가정] */
const SUBMIT_CLAIM_MS = 5 * 60 * 1_000;
const SUBMIT_LIMIT = 20;
const OVERDUE_LIMIT = 100;
const RECON_BATCH_WINDOW_MS = DAY_MS;
/** 09시 묶음의 503 실패를 이 수만큼 겪으면 CS PAYOUT_DELAYED(ADR-0369 결정 13) */
const PREPARE_FAILURE_CASE_AT = 3;
const LIVE_BATCH_STATUSES = ['PREPARED', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED'] as const;
const UNFINISHED_PAYOUT: readonly PayoutRecord['status'][] = ['REQUESTED', 'IN_PROGRESS'];
const sum = (rows: readonly { amount: number }[]): number => rows.reduce((s, r) => s + r.amount, 0);
const caseOf = (kind: SettlementCaseKind, sourceId: string, eventKey: string, at: Date): SettlementCaseRequestRecord => ({ eventKey, kind, sourceId, createdAt: at, requestedAt: null });
/** 살아 있는 지급 건: 다른 지급 건이 대신한(재요청) 옛 건과 취소한 건을 뺀다 */
const livePayouts = (rows: readonly PayoutRecord[]): PayoutRecord[] => {
  const replaced = new Set(rows.map((r) => r.retryOfPayoutId).filter((id): id is string => id !== null));
  return rows.filter((r) => !replaced.has(r.payoutId) && r.status !== 'CANCELED');
};
/** 살아 있는 지급 건으로 다시 센 묶음 상태(모두 완료 COMPLETED, 실패가 있으면 PARTIAL_FAILED, 접수 전 건이 남으면 그대로) */
const batchStatusOf = (current: PayoutBatchRecord['status'], live: readonly PayoutRecord[]): PayoutBatchRecord['status'] => {
  if (live.length > 0 && live.every((p) => p.status === 'COMPLETED')) return 'COMPLETED';
  if (live.some((p) => p.status === 'FAILED')) return 'PARTIAL_FAILED';
  if (live.some((p) => p.pgPayoutId === null && p.status === 'REQUESTED')) return current === 'APPROVED' ? 'APPROVED' : current;
  return current === 'APPROVED' || current === 'COMPLETED' || current === 'PARTIAL_FAILED' ? 'SUBMITTED' : current;
};
/** ops 받기 거절 몇 번째에 영구 실패로 둘지 [가정 3번, F-07-7 계획 §5.1 (파) (마)] */
const OPS_REFUSAL_LIMIT = 3;
const REFUSALS = new Set(['NOT_ACCEPTED', 'HTTP_400', 'HTTP_422']);
/** ops 어댑터의 거절(OpsIntakeRefused: SettlementProblem 503에 refusal 칸)인지. 일시 실패면 undefined */
const refusalOf = (e: unknown): OpsRefusal | undefined => {
  const r = e instanceof SettlementProblem ? (e as SettlementProblem & { refusal?: unknown }).refusal : undefined;
  return typeof r === 'string' && REFUSALS.has(r) ? (r as OpsRefusal) : undefined;
};

/** 정산 계좌 변경 본문(F-07-7, 계약 PayoutAccountChange). 은행 코드는 packages/validation 두 자리 표, 계좌번호 숫자 6~20자리 */
const PayoutAccountChangeBody = z.strictObject({
  bankCode: z.string().refine((v) => /^[0-9]{2}$/.test(v) && REFUND_BANK_CODES.has(v)),
  accountNumber: z.string().regex(/^[0-9]{6,20}$/),
  holderName: z.string().min(1).max(100),
});
const parsePayoutAccountChange = (body: unknown): void => {
  if (!PayoutAccountChangeBody.safeParse(body).success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
};

const failedAgencies = (agencies: PayoutAgencyResults): PayoutAgency[] => (['TOSS_STANDARD', 'TOSS_ESCROW', 'PORTONE'] as const).filter((a) => agencies[a] === 'FAILED');

const payoutAccountOut = (a: PayoutAccountRecord) => ({
  bankCode: a.bankCode,
  payoutAccountLast4: a.accountLast4,
  holderVerified: a.holderVerified,
  holdUntil: a.holdUntil.toISOString(),
  agencySyncPending: a.agencySyncPending ?? false,
  version: a.version,
});

/** 등록 읽기(core 내부, ADR-0370 결정 4) */
export interface PayoutRegistrationView {
  payoutAccount: { bankCode: string; last4: string; holdUntil: string | null; holderVerified: boolean } | null;
  agencySyncPending: boolean;
  tossEnabled: boolean;
  portoneEnabled: boolean;
  tossSellers: { pgStore: PgStore; status: TossSellerStatus }[];
  portonePartnerRegistered: boolean;
}

/** 지급 묶음이 미수금 남은 금액 겹침으로 다시 판정하는 최대 횟수 [가정] */
const BATCH_RECEIVABLE_RETRIES = 3;

const errorReason = (e: unknown): string => (e instanceof Error ? `${e.name}:${e.message}`.slice(0, 200) : 'unknown');

export class Settlements {
  /** 09시 토스 묶음의 상점·지급일별 503 실패 수(셋째에 CS PAYOUT_DELAYED, ADR-0369 결정 13). 리더 파드 메모리다 */
  readonly #prepareFailures = new Map<string, number>();

  #refundsUseCase: RefundsAfterCalculation | undefined;
  #recalcUseCase: EventRecalculations | undefined;
  #excludedUseCase: ExcludedPaymentResolution | undefined;

  constructor(private readonly d: SettlementDeps) {}

  // ---- F-07-8 계산 뒤 환급 미수금·회차 취소 다시 계산·대사 미완 결제 풀림(ADR-0380). 새 파일의 유스케이스에 넘긴다 ----

  #refunds(): RefundsAfterCalculation {
    return (this.#refundsUseCase ??= new RefundsAfterCalculation({
      store: this.d.store,
      payments: this.d.payments,
      clock: this.d.clock,
      eventCommission: this.d.eventCommission,
      commissionRateBp: this.d.commissionRateBp,
      signals: this.d.signals,
    }));
  }

  #recalculations(): EventRecalculations {
    return (this.#recalcUseCase ??= new EventRecalculations({
      store: this.d.store,
      payments: this.d.payments,
      clock: this.d.clock,
      holidays: this.#holidays(),
      refunds: this.#refunds(),
      tossTransport: this.d.tossTransport,
      portone: this.d.portone,
      log: this.d.log,
      eventCommission: this.d.eventCommission,
      commissionRateBp: this.d.commissionRateBp,
      onCancelFailed: (o) => this.d.log?.payoutJobFailed?.({ job: 'settlement_recalculation_cancel_failed', reason: `${o.statementId}:${o.pg}:${o.reason}`, at: this.#now() }),
    }));
  }

  #excluded(): ExcludedPaymentResolution {
    return (this.#excludedUseCase ??= new ExcludedPaymentResolution({ store: this.d.store, payments: this.d.payments, clock: this.d.clock, commissionRateBp: this.d.commissionRateBp }));
  }

  /** 회차 취소·연기 확정 직후 그 회차 정산서의 지급을 막는다(PUT /internal/v1/settlements/event-recalculations/{requestId}, ADR-0380 결정 1·4) */
  async openEventRecalculation(input: { requestId: string; eventId: string; kind: RecalculationKind; confirmedAt: Date }): Promise<EventRecalculationView> {
    return this.#recalculations().open(input);
  }

  /** 일괄 환불이 끝난 뒤 그 회차 정산서를 새 판으로 다시 계산한다(POST …/{requestId}/completion, ADR-0380 결정 3·6·8). 없는 요청은 404 SettlementProblem */
  async completeEventRecalculation(requestId: string, input: { completedAt: Date; partial?: boolean }): Promise<EventRecalculationView> {
    return this.#recalculations().complete(requestId, input);
  }

  /** 정산 일꾼 30분 tick: 결제사 취소가 실패한 정산서를 다시 하고, 완료를 받은 요청은 남은 다시 계산을 마친다 */
  async retryEventRecalculations(limit?: number): Promise<{ retried: number; pending: number }> {
    const out = await this.#recalculations().retry(limit);
    this.d.signals?.recalculationPending?.(out.pending);
    return out;
  }

  /** 정산 일꾼 30분 tick: 계산 뒤(지급 뒤) 환급의 미수금(J-T11, ADR-0197 결정 2) */
  async recordRefundsAfterCalculation(limit?: number): Promise<{ created: number; skipped: number }> {
    return this.#refunds().run(limit);
  }

  /** 정산 일꾼 30분 tick: 대사 불일치로 뺀 결제가 풀리면 조정 제안 CS 건(J-T23 ③, ADR-0380 결정 7) */
  async resolveExcludedPayments(limit?: number): Promise<{ suggested: number; waiting: number }> {
    return this.#excluded().run(limit);
  }

  /**
   * 파트너 회차 정산서 목록. 다른 파트너의 회차면 없는 회차와 같은 빈 목록이고(존재를 알리지 않는다),
   * 인가 실패 보안 로그 settlement_authz_denied를 남긴다(J-T10, ASVS 8.2.2·16.3.2).
   */
  async listEvent(promoterId: string, eventId: string, accountId?: string): Promise<StatementView[]> {
    const rows = await this.d.store.listEvent(promoterId, eventId);
    if (rows.length === 0 && accountId !== undefined && (await this.d.store.hasEventStatementOfOther(promoterId, eventId))) {
      this.d.log?.authzDenied?.({ partnerId: promoterId, accountId, statementId: null, eventId, action: 'list-event', at: this.#now() });
    }
    // 파트너 응답만 KYC 예고를 싣는다(토스만 계산, 포트원 false, F-07-7 I-08 (a))
    return Promise.all(
      rows.map(async (s) => ({
        ...statementView(s),
        kycNotice: s.pg === 'TOSS' && s.payoutDate !== null ? (await this.kycNotice(s.promoterId, s.payoutDate, s.pgStore)).notice : false,
      })),
    );
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

  /** 지급 묶음 때의 보류(T7). 출발 CONFIRMED·묶음에 붙지 않은 정산서만이고 감사와 PAYOUT_HELD(금액 = 지급액)를 함께 쓴다(ADR-0369 결정 6) */
  #holdUpdate(s: StatementRecord, reason: HoldReason, now: Date): StatementUpdate {
    const audit = this.#audit(s.statementId, s.status, 'HELD', `hold-${reason.toLowerCase()}`, 'system', now);
    const held: StatementRecord = { ...s, status: 'HELD', holdReason: reason, updatedAt: now };
    return {
      statementId: s.statementId,
      status: 'HELD',
      holdReason: reason,
      offsetAmount: s.offsetAmount,
      payoutAmount: s.payoutAmount,
      updatedAt: now,
      from: ['CONFIRMED'],
      audits: [audit],
      events: [payoutEvent(held, 'PAYOUT_HELD', s.payoutAmount, now, audit.auditId)],
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
    const notice = this.d.caseNotice;
    if (!notice) return false;
    // ops 거절(202 accepted:false·400·422)은 세고 3번째에 영구 실패로 둔다(F-07-7 계획 §5.1 (파) (마)). 일시 실패는 세지 않는다
    if (!(await this.#deliver('dispute', 'cs-case', d.disputeId, d.disputeId, 'STATEMENT_DISPUTE', () => notice.openDispute({ disputeId: d.disputeId, statementId: d.statementId, createdAt: d.submittedAt })))) {
      this.d.log?.caseNoticeFailed?.({ disputeId: d.disputeId, statementId: d.statementId, at: this.#now() });
      return false;
    }
    // 이의는 이미 커밋됐다. 표시 쓰기가 실패해도 응답을 바꾸지 않고 다음 점검이 다시 보낸다(ops는 eventKey로 한 건으로 모은다, 리뷰 RV-05)
    try {
      await this.d.store.markDisputeCaseRequested(d.disputeId, this.#now());
    } catch {
      this.d.log?.caseNoticeFailed?.({ disputeId: d.disputeId, statementId: d.statementId, at: this.#now(), reason: 'mark-failed' });
      return false;
    }
    return true;
  }

  /** 건을 열지 못한 열린 이의를 다시 보낸다(정산 일꾼 30분마다, ADR-0368 결정 5). 한 건 실패가 나머지를 멈추지 않는다. 연 수를 돌려준다 */
  async retryDisputeCases(limit = CASE_RETRY_LIMIT): Promise<{ opened: number; pending: number }> {
    const pending = await this.d.store.listDisputesAwaitingCase(limit);
    let opened = 0;
    for (const d of pending) {
      try {
        if (await this.#openDisputeCase(d)) opened += 1;
      } catch {
        this.d.log?.caseNoticeFailed?.({ disputeId: d.disputeId, statementId: d.statementId, at: this.#now() });
      }
    }
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
    // 다시 계산 대기 보류는 풀지 않는다(새 판으로 대신한다, ADR-0380 결정 4). 이름 그대로의 SettlementProblem 409이고 내부 경로가 같은 이름의 Problem으로 바꾼다
    const pre = await this.d.store.findStatementById(statementId);
    if (pre?.status === 'HELD' && pre.holdReason === 'RECALCULATION' && (await this.#recalculations().pendingFor(pre))) {
      throw new SettlementProblem('statement-recalculation-pending', 409, '회차 취소 다시 계산을 기다리는 정산서입니다');
    }
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
        // 결제사 수정 대기가 남았으면 보류가 끝나도 풀지 않는다(F-07-7 ADR-0370 결정 5)
        if (account && (account.holdUntil.getTime() > now.getTime() || account.agencySyncPending === true)) throw new SettlementProblem('payout-account-change-hold', 409, '정산 계좌 변경 보류 중이라 다시 확정할 수 없습니다');
      } else if (s.holdReason === 'ACCOUNT_MISMATCH') {
        const account = await this.d.store.findPayoutAccount(s.promoterId);
        const partner = s.pg === 'PORTONE' ? await this.d.store.findPortonePartner(s.promoterId) : undefined;
        if (partner) {
          // 포트원 파트너 계좌 대조 불일치(F-07-7 I-14, ADR-0370 결정 8 ②): 증빙만으로는 풀지 않는다. 마지막 대조가 MATCHED이고 그 대조가 마지막 계좌 변경 뒤이며 보류가 끝났을 때만
          const ok =
            account !== undefined &&
            partner.lastAccountCheck === 'MATCHED' &&
            partner.lastAccountCheckedAt !== null &&
            partner.lastAccountCheckedAt.getTime() >= account.changedAt.getTime() &&
            account.holdUntil.getTime() <= now.getTime() &&
            account.agencySyncPending !== true;
          if (!ok) throw new SettlementProblem('payout-account-change-hold', 409, '포트원 파트너 계좌 대조가 맞고 계좌 변경 보류가 끝나야 다시 확정할 수 있습니다');
        } else {
          const reconciled = o.evidence?.accountReconciled === true || Boolean(account && account.holderVerified && account.holdUntil.getTime() <= now.getTime());
          if (!reconciled) throw new SettlementProblem('payout-account-mismatch', 409, '계좌 대조가 확인되지 않아 다시 확정할 수 없습니다');
        }
      } else if (s.holdReason === 'RECALCULATION') {
        // 다시 계산 대기 중에는 풀지 않는다(새 판으로 대신한다, ADR-0380 결정 4). 대기가 끝났으면(겹친 완료가 먼저 끝냄) 다른 보류처럼 다시 확정한다
        if (await this.#recalculations().pendingFor(s)) throw new SettlementProblem('statement-recalculation-pending', 409, '회차 취소 다시 계산을 기다리는 정산서입니다');
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
      assertAdjustable(s.status, s.payoutBatchId);
      const dispute = a.disputeId !== null ? (await this.d.store.listDisputes(s.statementId)).find((d) => d.disputeId === a.disputeId) : undefined;
      if (a.disputeId !== null && (s.status !== 'DISPUTED' || !dispute || dispute.result !== null)) throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 409, '그 이의가 이미 닫혔거나 정산서가 이의 중이 아닙니다');
      // 이의 없는 조정은 이의 중(DISPUTED) 정산서에 적용하지 않는다(§4.3 '검사', J-T36 ②, 리뷰 RV-07). 아무것도 쓰지 않는다
      if (a.disputeId === null && s.status === 'DISPUTED') throw new SettlementProblem('settlement-adjustment-not-allowed', 409, '이의 중인 정산서에는 이의 없는 조정을 적용하지 않습니다');
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
      // 지급액 식 하나(RV-02): 계산 칸 그대로 + 바뀐 조정 합계
      const payoutAmount = payoutAmountOf({ ...s, adjustmentAmount });
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

  /**
   * 토스 셀러 등록(F-07-6 ADR-0369 결정 3, settlement §3). 두 결제 상점에 한 번씩 등록하고 상점마다 toss_seller 한 행을 남긴다.
   * 이미 행이 있는 상점은 등록 요청을 다시 보내지 않고 셀러 단건 조회로 상태만 고친다. 한 상점이 실패해도 다른 상점 결과는 남기고 502다.
   * 계좌번호는 결제사로 넘길 때만 쓰고 저장·로그·응답·예외 메시지에 남기지 않는다(ASVS 16.2.5).
   */
  async registerTossSellers(input: TossSellerRegistrationInput): Promise<{ bankCode: string; accountLast4: string; sellers: { pgStore: PgStore; status: TossSellerStatus }[] }> {
    return guard(async () => {
      const body = parseTossSellerRegistration(input);
      const transport = this.d.tossTransport;
      if (!transport) throw new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
      const sellers: { pgStore: PgStore; status: TossSellerStatus }[] = [];
      const failedStores: PgStore[] = [];
      for (const pgStore of TOSS_SELLER_STORES) {
        try {
          const existing = await this.d.store.findTossSeller(body.promoterId, pgStore);
          if (existing) {
            const fact = await transport.getSeller(pgStore, existing.tossSellerId);
            const now = this.#now();
            await this.d.store.saveTossSeller({ ...existing, status: fact.status, statusCheckedAt: now, updatedAt: now });
            sellers.push({ pgStore, status: fact.status });
            continue;
          }
          const refSellerId = tossRefSellerId(body.promoterId, pgStore);
          const created = await transport.registerSeller(pgStore, { refSellerId, businessType: body.businessType, company: body.company, account: body.account });
          const now = this.#now();
          await this.d.store.saveTossSeller({ promoterId: body.promoterId, pgStore, tossSellerId: created.tossSellerId, refSellerId, status: created.status, businessType: body.businessType, registeredAt: now, statusCheckedAt: now, updatedAt: now });
          sellers.push({ pgStore, status: created.status });
        } catch {
          // 그 상점만 실패로 둔다(다른 상점 결과는 남긴다). 오류 글에는 계좌번호가 있을 수 있어 싣지 않는다
          failedStores.push(pgStore);
        }
      }
      if (failedStores.length > 0) throw new ProblemError({ type: 'toss-seller-registration-failed', status: 502, title: '결제사 셀러 등록에 실패했습니다', extensions: { failedStores } });
      return { bankCode: body.account.bankCode, accountLast4: accountLast4(body.account.accountNumber), sellers };
    });
  }

  /**
   * 셀러 단건 조회 결과 반영(seller.changed·재등록·지급 실패 뒤 조회, ADR-0369 결정 4·9). 그 상점 toss_seller만 바꾸고 PEAKET 판매자 확인(seller_kyc)은 바꾸지 않는다.
   * KYC_REQUIRED면 CS SELLER_KYC_REQUIRED(사건 키 seller-kyc:{셀러 ID}:{확인 시각}), APPROVED면 그 파트너·상점의 HELD·KYC 토스 정산서를 CONFIRMED로 돌리고
   * (PEAKET 확인이 안 끝났으면 건너뜀) 그 셀러의 한도/KYC 실패 지급 건을 새 순번으로 한 번 다시 보낸다.
   */
  async applyTossSellerFact(fact: { pgStore: PgStore; tossSellerId: string; status: TossSellerStatus; checkedAt: Date }): Promise<void> {
    return guard(async () => {
      if (!TOSS_SELLER_STATUSES.includes(fact.status)) throw new SettlementProblem('invalid-query', 422, '셀러 상태가 맞지 않습니다');
      const row = await this.d.store.findTossSellerById(fact.tossSellerId);
      if (!row) return;
      const now = this.#now();
      await this.d.store.saveTossSeller({ ...row, status: fact.status, statusCheckedAt: fact.checkedAt, updatedAt: now });
      if (fact.status === 'KYC_REQUIRED') {
        await this.d.store.insertCaseRequests([caseOf('SELLER_KYC_REQUIRED', row.tossSellerId, `seller-kyc:${row.tossSellerId}:${fact.checkedAt.toISOString()}`, now)]);
        // 지급 요청 뒤 KYC가 필요해지면 그 상점의 이미 접수된 예약지급을 취소한다(F-07-7 I-06, settlement §12). 실패해도 셀러 상태 반영은 그대로다
        try {
          await this.cancelScheduledTossPayouts({ promoterId: row.promoterId, pgStore: row.pgStore, reason: 'KYC' });
        } catch (e) {
          this.d.log?.payoutJobFailed?.({ job: 'scheduled-payout-cancel', pgStore: row.pgStore, reason: errorReason(e), at: now });
        }
      }
      this.d.signals?.sellerKycRequired('TOSS', await this.d.store.countTossSellers('KYC_REQUIRED'));
      if (fact.status === 'APPROVED') {
        await this.#releaseKycHolds(row, now);
        await this.#retryKycFailures(row, now);
      }
    });
  }

  /** 셀러 APPROVED 확인 뒤 그 파트너·상점의 HELD·KYC 토스 정산서를 CONFIRMED로(T8, 감사 사유 toss-seller-approved, 행위자 system) */
  async #releaseKycHolds(seller: TossSellerRecord, now: Date): Promise<void> {
    const kyc = await this.d.store.findKyc(seller.promoterId);
    if (!(kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified)) return;
    for (const s of await this.d.store.listHeldStatementsOf(seller.promoterId, 'TOSS', seller.pgStore)) {
      if (s.holdReason !== 'KYC') continue;
      const { transition } = this.#confirmTransition(s, now, { from: ['HELD'], reason: 'toss-seller-approved', actor: 'system' });
      // 다른 전이가 먼저 썼으면 건너뛴다(다음 묶음 판정이 다시 본다)
      await this.d.store.transitionStatement(transition);
    }
  }

  /** 셀러 APPROVED 확인 뒤 그 셀러의 한도/KYC 실패 지급 건을 새 순번으로 한 번(ADR-0369 결정 8·9). 이미 대신한 건이 있으면 저장소가 거절한다 */
  async #retryKycFailures(seller: TossSellerRecord, now: Date): Promise<void> {
    for (const p of await this.d.store.listUnretriedFailedPayouts({ promoterId: seller.promoterId, pgStore: seller.pgStore, failureClass: 'LIMIT_KYC' })) {
      const payoutDate = retryPayoutDate(now);
      await this.d.store.writePayoutChanges({
        retries: [{ oldPayoutId: p.payoutId, newPayoutId: uuidv7(this.d.clock), auditId: uuidv7(this.d.clock), payoutDate, autoRetryCount: p.autoRetryCount, actor: 'system', reason: 'LIMIT_KYC', at: now }],
        batch: { batchId: p.batchId, set: { nextSubmitAt: now, submitDeadlineAt: submitDeadlineFor(payoutDate), updatedAt: now } },
      });
    }
  }

  /** KYC 예고(settlement §6, J-T19). 그 묶음 상점의 토스 셀러가 PARTIALLY_APPROVED이고 지급일 앞뒤 6일 토스 지급 합계가 1,000만 원 이상일 때만 true다. */
  async kycNotice(promoterId: string, aroundDate: string, pgStore: PgStore = 'STANDARD'): Promise<KycNotice> {
    return guard(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(aroundDate)) throw new SettlementProblem('invalid-query', 422, '지급일이 맞지 않습니다');
      const seller = await this.d.store.findTossSeller(promoterId, pgStore);
      const sellerStatus = seller?.status ?? 'PENDING';
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

  /** SCR-049 묶음 상세. 묶인 정산서(PREPARED면 그 지급일의 지금 확정 정산서 후보)·지급 건·같은 지급일의 HELD 정산서·그 상점 KYC 예고를 함께 준다. */
  async getPayoutBatchDetail(batchId: string): Promise<PayoutBatchDetail> {
    return guard(async () => {
      const batch = await this.d.store.findPayoutBatch(batchId);
      if (!batch) throw notFound();
      const [statements, payouts, holds] = await Promise.all([
        batch.status === 'PREPARED' ? this.d.store.listConfirmed(batch.pg, batch.pgStore, batch.payoutDate) : this.d.store.listStatementsByBatch(batchId),
        this.d.store.listPayouts(batchId),
        this.d.store.listHeldStatements(batch.pg, batch.pgStore, batch.payoutDate),
      ]);
      const promoterIds = [...new Set([...statements, ...holds].map((s) => s.promoterId))];
      const kycNotices = await Promise.all(promoterIds.map((id) => this.kycNotice(id, batch.payoutDate, batch.pgStore)));
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

  /**
   * 지급 묶음 판정(ADR-0369 결정 4·6·13): 확정 정산서를 읽어 판매 중지·KYC(토스는 그 상점 셀러도)·계좌 보류·예금주를 보고 보류를 정하고,
   * 남은 정산서의 미수금 상계를 셈하고 잔액(토스는 끝나지 않은 예약지급을 더해)을 견준다. 모두 보류·잔액 부족이면 보류를 저장하고,
   * 묶음 요청(request)은 409를 던지고 09시 묶음(prepare)은 undefined를 돌려준다. 판매 중지·잔액 원천이 답하지 않으면 503을 던진다(상태를 바꾸기 전).
   */
  async #judgeBatch(
    input: { pg: Pg; pgStore: PgStore; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined },
    now: Date,
    mode: 'request' | 'prepare',
  ): Promise<
    | {
        included: StatementRecord[];
        holdUpdates: StatementUpdate[];
        offsetUpdates: StatementUpdate[];
        receivableUpdates: ReceivableUpdate[];
        receivableMoves: ReceivableMoveRecord[];
        closedEvents: SettlementEventValue[];
        totalAmount: number;
        /** 포트원 이체 원장으로 계산한 지급대행 계좌 잔액(F-07-7 I-15 (a)). 포트원 플랫폼이 꺼졌거나 원장이 비면 undefined */
        portoneLedger?: number;
      }
    | undefined
  > {
    const confirmed = await this.d.store.listConfirmed(input.pg, input.pgStore, input.payoutDate);
    // 판매 중지된 공연의 회차 정산서는 결제사와 관계없이 이번 묶음에서 뺀다(ADR-0123, settlement §6).
    // core가 답하지 않으면 묶음을 만들지 않는다(503). 상태를 바꾸기 전에 확인한다.
    const suspended = await this.#suspendedEventIds(confirmed);
    const included: StatementRecord[] = [];
    const holdUpdates: StatementUpdate[] = [];
    let heldKyc = 0;
    let heldAccount = 0;
    let heldMismatch = 0;
    let heldSuspended = 0;
    let heldRecalculation = 0;
    for (const s of confirmed) {
      // 회차 취소·연기 다시 계산 대기(PENDING) 회차의 확정 정산서는 묶지 않고 HELD(RECALCULATION)로 둔다(ADR-0380 결정 4)
      if (await this.#recalculations().pendingFor(s)) {
        heldRecalculation += 1;
        holdUpdates.push(this.#holdUpdate(s, 'RECALCULATION', now));
        continue;
      }
      if (s.eventId !== null && suspended.has(s.eventId)) {
        heldSuspended += 1;
        holdUpdates.push(this.#holdUpdate(s, 'SALE_SUSPENDED', now));
        continue;
      }
      const kyc = await this.d.store.findKyc(s.promoterId);
      // 토스 정산서는 PEAKET 판매자 확인에 더해 그 상점 토스 셀러가 묶을 수 있는 상태여야 한다(셀러 없음도 보류). 포트원은 토스 셀러와 무관하다(ADR-0369 결정 4)
      const sellerOk = input.pg === 'PORTONE' || isBatchableTossSeller((await this.d.store.findTossSeller(s.promoterId, input.pgStore))?.status);
      if (kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified && sellerOk) {
        const account = await this.d.store.findPayoutAccount(s.promoterId);
        // 결제사 수정 대기(agency_sync_pending)는 보류가 끝나도 지급하지 않는다(F-07-7 ADR-0370 결정 5)
        if (account && (account.holdUntil.getTime() > now.getTime() || account.agencySyncPending === true)) {
          heldAccount += 1;
          holdUpdates.push(this.#holdUpdate(s, 'ACCOUNT_CHANGE', now));
          continue;
        }
        if (account && !account.holderVerified) {
          heldMismatch += 1;
          holdUpdates.push(this.#holdUpdate(s, 'ACCOUNT_MISMATCH', now));
          continue;
        }
        included.push(s);
      } else {
        heldKyc += 1;
        holdUpdates.push(this.#holdUpdate(s, 'KYC', now));
      }
    }
    if (included.length === 0) {
      // 모두 보류됐어도 보류를 조건부로 저장한 뒤 409다(BAT-625 RV-04, ADR-0368 결정 11). 다른 전이가 먼저 썼으면 409 settlement-state-conflict
      if (holdUpdates.length > 0 && !(await this.d.store.transitionStatements(holdUpdates.map((u) => Settlements.#holdTransition(u))))) throw stateConflict();
      if (mode === 'prepare') return undefined;
      if (heldRecalculation > 0 && heldRecalculation === holdUpdates.length) throw new SettlementProblem('statement-recalculation-pending', 409, '회차 취소 다시 계산을 기다리는 정산서입니다');
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
    const offsetUpdates: StatementUpdate[] = [];
    const receivableMoves: ReceivableMoveRecord[] = [];
    const receivableRemaining = new Map<string, { remaining: number; status: ReceivableRecord['status']; amount: number; closedBy?: StatementRecord }>();
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
        receivableRemaining.set(r.receivableId, { remaining: nextRemaining, status: nextRemaining === 0 ? 'CLOSED' : 'OPEN', amount: r.amount, ...(nextRemaining === 0 ? { closedBy: s } : {}) });
        // 이동 ID를 정해 넣는다(다시 계산의 상계 되돌림이 이 ID를 가리킨다, F-07-8)
        receivableMoves.push({ moveId: uuidv7(this.d.clock), receivableId: r.receivableId, statementId: s.statementId, amount: take, kind: 'OFFSET', movedAt: now });
        offset += take;
        remaining -= take;
      }
      if (offset > 0) {
        // 지급액 식 하나(RV-02): 상계를 더한 칸으로 다시 센다(상계는 지급액까지만이라 remaining과 같다)
        const offsetAmount = s.offsetAmount + offset;
        const payoutAfter = payoutAmountOf({ ...s, offsetAmount });
        const next: StatementRecord = { ...s, offsetAmount, payoutAmount: payoutAfter, status: payoutAfter > 0 ? s.status : 'CARRIED_OVER', updatedAt: now };
        const carried = next.status === 'CARRIED_OVER' ? this.#audit(s.statementId, s.status, 'CARRIED_OVER', 'offset-exhausted', 'system', now) : undefined;
        offsetUpdates.push({
          statementId: s.statementId,
          status: next.status,
          holdReason: next.holdReason,
          offsetAmount: next.offsetAmount,
          payoutAmount: next.payoutAmount,
          updatedAt: now,
          from: ['CONFIRMED'],
          ...(carried ? { audits: [carried], events: [statementEvent(next, 'STATEMENT_CARRIED_OVER', now, carried.auditId)] } : {}),
        });
        if (payoutAfter > 0) includedAfterOffset.push(next);
      } else {
        includedAfterOffset.push(s);
      }
    }
    const receivableUpdates: ReceivableUpdate[] = [];
    const closedEvents: SettlementEventValue[] = [];
    for (const [receivableId, u] of receivableRemaining) {
      receivableUpdates.push({ receivableId, remaining: u.remaining, status: u.status, updatedAt: now });
      // 상계로 남은 금액이 0이 된 미수금마다 RECEIVABLE_CLOSED(금액 = 그 미수금 금액, ADR-0369 결정 6)
      if (u.status === 'CLOSED' && u.closedBy) closedEvents.push(receivableClosedEvent(u.closedBy, { receivableId, amount: u.amount }, now));
    }
    if (includedAfterOffset.length === 0) {
      if (mode === 'prepare') return undefined;
      throw new SettlementProblem('payout-batch-empty', 409, '상계 뒤 지급할 정산서가 없습니다');
    }
    const totalAmount = includedAfterOffset.reduce((total, s) => total + s.payoutAmount, 0);
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
    // 포트원은 operator 입력값과 이체 원장 계산값 가운데 작은 값으로 판정한다(F-07-7 I-15 (a), ADR-0370 결정 8 ③). 원장을 읽지 못하면 묶음을 만들지 않는다
    let portoneLedger: number | undefined;
    if (input.pg === 'PORTONE' && this.d.portone) {
      try {
        portoneLedger = await portoneLedgerBalance(this.d.portone, now);
      } catch {
        throw new SettlementProblem('pg-balance-unavailable', 503, '결제사 잔액을 확인할 수 없습니다');
      }
    }
    // 토스는 결제사에 이미 예약된 끝나지 않은 지급을 더해 견준다(settlement §5.1·§6, ADR-0369 결정 7)
    const reserved = input.pg === 'TOSS' && tossBalance ? await this.d.store.sumUnfinishedTossPayouts(input.pgStore) : 0;
    const operatorBalance = input.portoneBalance?.amount;
    const portoneAvailable = operatorBalance === undefined ? undefined : portoneLedger === undefined ? operatorBalance : Math.min(operatorBalance, portoneLedger);
    const available = input.pg === 'PORTONE' ? portoneAvailable : tossBalance === undefined ? undefined : tossBalance.availableAmount - reserved;
    if (available !== undefined && available < totalAmount) {
      // 잔액이 모자라면 묶음을 만들지 않고 그 정산서를 HELD·BALANCE로 남긴다(settlement §6, J-T13). 상계는 아직 적용하지 않는다. 미수금은 다음 묶음에서 다시 본다.
      // 같은 요청에서 다른 사유로 빠진 정산서의 보류도 함께 저장한다(모두 보류된 묶음과 같은 규칙, ADR-0368 결정 11)
      const holds = [...holdUpdates.map((u) => Settlements.#holdTransition(u)), ...included.map((s) => Settlements.#holdTransition(this.#holdUpdate(s, 'BALANCE', now)))];
      if (!(await this.d.store.transitionStatements(holds))) throw stateConflict();
      if (mode === 'prepare') return undefined;
      throw new SettlementProblem('payout-balance-insufficient', 409, '결제사 잔액이 모자라 지급일을 미룹니다');
    }
    return { included: includedAfterOffset, holdUpdates, offsetUpdates, receivableUpdates, receivableMoves, closedEvents, totalAmount, ...(portoneLedger === undefined ? {} : { portoneLedger }) };
  }

  #newBatch(input: { pg: Pg; pgStore: PgStore; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }, o: { totalAmount: number; statementCount: number; status: PayoutBatchRecord['status'] }, now: Date): PayoutBatchRecord {
    return {
      batchId: uuidv7(this.d.clock),
      pg: input.pg,
      pgStore: input.pgStore,
      payoutDate: input.payoutDate,
      totalAmount: o.totalAmount,
      statementCount: o.statementCount,
      approvalId: null,
      portoneBulkPayoutId: null,
      pgBalanceKrw: input.portoneBalance?.amount ?? null,
      pgBalanceSource: input.pg === 'PORTONE' ? 'OPERATOR_CONSOLE' : null,
      pgBalanceObservedAt: input.portoneBalance ? new Date(input.portoneBalance.observedAt) : null,
      pgBalanceObservedBy: input.pg === 'PORTONE' ? input.actor : null,
      pgBalanceLedgerKrw: null,
      status: o.status,
      submitAttempts: 0,
      nextSubmitAt: null,
      submitDeadlineAt: null,
      lastSubmitError: null,
      dateRetryUsed: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * operator 확인 요청의 지급 묶음(ADR-0369 결정 13). 같은 결제사·상점·지급일의 09시 PREPARED 묶음이 있으면 새로 만들지 않고 그 ID로
   * 그때의 확정 정산서를 다시 판정해 묶은 뒤 PENDING_APPROVAL로 바꾼다(겹친 두 요청은 하나만 이긴다). 묶을 때 정산서는 CONFIRMED 그대로다(결정 14 ①).
   */
  async createPayoutBatch(input: { pg: Pg; pgStore: PgStore; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }): Promise<ReturnType<typeof payoutBatchView>> {
    // 같은 미수금을 겹친 다른 묶음·다시 계산이 먼저 썼으면(남은 금액이 읽은 값과 다름) 아무것도 쓰지 않았으므로 다시 판정한다(F-07-8 F-20·F-25, 세 번 [가정])
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#createPayoutBatchOnce(input);
      } catch (e) {
        if (!(e instanceof ReceivableBalanceConflict) || attempt >= BATCH_RECEIVABLE_RETRIES) throw e instanceof SettlementProblem ? new ProblemError({ type: e.type, status: e.status, title: e.title }) : e;
      }
    }
  }

  async #createPayoutBatchOnce(input: { pg: Pg; pgStore: PgStore; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }): Promise<ReturnType<typeof payoutBatchView>> {
    {
      const now = this.#now();
      const existing = await this.d.store.listPayoutBatches({ pg: input.pg, pgStore: input.pgStore, payoutDate: input.payoutDate, status: [...LIVE_BATCH_STATUSES], limit: 2 });
      if (existing.some((b) => b.status !== 'PREPARED')) throw new SettlementProblem('payout-batch-exists', 409, '이미 지급 묶음이 있습니다');
      const prepared = existing.find((b) => b.status === 'PREPARED');
      const j = await this.#judgeBatch(input, now, 'request');
      if (!j) throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
      const fresh: PayoutBatchRecord = { ...this.#newBatch(input, { totalAmount: j.totalAmount, statementCount: j.included.length, status: 'PENDING_APPROVAL' }, now), ...(j.portoneLedger === undefined ? {} : { pgBalanceLedgerKrw: j.portoneLedger }) };
      const batch: PayoutBatchRecord = prepared
        ? { ...fresh, batchId: prepared.batchId, createdAt: prepared.createdAt, submitAttempts: prepared.submitAttempts, nextSubmitAt: prepared.nextSubmitAt, submitDeadlineAt: prepared.submitDeadlineAt, lastSubmitError: prepared.lastSubmitError, dateRetryUsed: prepared.dateRetryUsed }
        : fresh;
      await this.d.store.createPayoutBatchAtomically({
        batch,
        statementIds: j.included.map((s) => s.statementId),
        statementUpdates: [...j.holdUpdates, ...j.offsetUpdates],
        receivableUpdates: j.receivableUpdates,
        receivableMoves: j.receivableMoves,
        events: j.closedEvents,
        ...(prepared ? { promotePrepared: true } : {}),
      });
      // operator 입력값과 원장 계산값이 다르면 CS PORTONE_LEDGER_MISMATCH(대상 = 묶음)와 차이 게이지(F-07-7 I-15 (a))
      if (j.portoneLedger !== undefined && input.portoneBalance) {
        const diff = input.portoneBalance.amount - j.portoneLedger;
        this.d.signals?.portoneBalanceDiff?.(diff);
        if (diff !== 0) await this.d.store.insertCaseRequests([caseOf('PORTONE_LEDGER_MISMATCH', batch.batchId, `portone-balance:${batch.batchId}`, now)]);
      }
      return payoutBatchView(batch);
    }
  }

  /**
   * 09시 토스 지급 묶음 자동 만들기(ADR-0369 결정 13, settlement §5.1). 상점마다 판정만 해서 PREPARED 묶음(정산서 묶지 않음·상계 쓰지 않음)을 보류 저장과 한 트랜잭션에 넣는다.
   * 같은 결제사·상점·지급일의 살아 있는 묶음이 있으면 건너뛴다. 확정 정산서가 없거나 모두 보류·잔액 부족이면 묶음이 없다(보류는 저장한다).
   */
  async prepareTossBatches(payoutDate: string): Promise<{ prepared: number }> {
    const r = await this.runTossBatchPreparation(payoutDate);
    return { prepared: r.prepared };
  }

  /** 정산 일꾼이 부르는 09시 묶음. 판매 중지·잔액 원천 503 등으로 실패한 상점을 돌려주고, 같은 상점·지급일의 셋째 실패에 CS PAYOUT_DELAYED(대상 TOSS:{상점}:{지급일})를 남긴다 */
  async runTossBatchPreparation(payoutDate: string): Promise<{ prepared: number; failedStores: PgStore[] }> {
    let prepared = 0;
    const failedStores: PgStore[] = [];
    for (const pgStore of TOSS_SELLER_STORES) {
      const key = `TOSS:${pgStore}:${payoutDate}`;
      try {
        if (await this.#prepareStore(pgStore, payoutDate)) prepared += 1;
        this.#prepareFailures.delete(key);
      } catch (e) {
        const count = (this.#prepareFailures.get(key) ?? 0) + 1;
        this.#prepareFailures.set(key, count);
        failedStores.push(pgStore);
        const now = this.#now();
        this.d.log?.payoutJobFailed?.({ job: 'prepare-toss-batch', pgStore, reason: errorReason(e), at: now });
        if (count >= PREPARE_FAILURE_CASE_AT) await this.d.store.insertCaseRequests([caseOf('PAYOUT_DELAYED', key, key, now)]);
      }
    }
    return { prepared, failedStores };
  }

  async #prepareStore(pgStore: PgStore, payoutDate: string): Promise<boolean> {
    const live = await this.d.store.listPayoutBatches({ pg: 'TOSS', pgStore, payoutDate, status: [...LIVE_BATCH_STATUSES], limit: 1 });
    if (live.length > 0) return false;
    const now = this.#now();
    const input = { pg: 'TOSS' as const, pgStore, payoutDate, actor: 'system' };
    const j = await this.#judgeBatch(input, now, 'prepare');
    if (!j) return false;
    const batch = this.#newBatch(input, { totalAmount: j.totalAmount, statementCount: j.included.length, status: 'PREPARED' }, now);
    try {
      // 묶지 않고 상계하지 않는다. 보류만 같은 트랜잭션에 쓴다
      await this.d.store.createPayoutBatchAtomically({ batch, statementIds: [], statementUpdates: j.holdUpdates, receivableUpdates: [], receivableMoves: [] });
    } catch (e) {
      if (e instanceof SettlementProblem && e.type === 'payout-batch-exists') return false;
      throw e;
    }
    return true;
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

  /**
   * 승인된 묶음 실행(operator, 내부 실행 경로). 토스는 결과 넷을 던지지 않고 묶음 보기로 돌려준다(lastSubmitError·nextSubmitAt·submitDeadlineAt, ADR-0369 결정 7).
   * 접수된 지급 건에 결제사 지급 ID를 저장하고, 조각이 모두 접수된 정산서만 T9(CONFIRMED → SCHEDULED)·PAYOUT_SCHEDULED를 같은 트랜잭션에 쓴다(결정 6).
   */
  async executeBatch(batchId: string): Promise<ReturnType<typeof payoutBatchView>> {
    return guard(async () => {
      const b = await this.d.store.findPayoutBatch(batchId);
      if (!b) throw notFound();
      if (b.status !== 'APPROVED') throw new SettlementProblem('payout-batch-not-approved', 409, '승인된 지급 묶음이 아닙니다');
      // 승인 기록을 거치지 않고 APPROVED가 된 묶음은 실행하지 않는다(승인 ID가 없으면 승인 근거가 없다).
      if (!b.approvalId) throw new SettlementProblem('payout-batch-not-approved', 409, '승인 업무 ID가 없는 지급 묶음입니다');
      return payoutBatchView(await this.#submitBatch(b));
    });
  }

  /**
   * 다음 전송 시각이 지난 토스 묶음을 다시 보낸다(전송 일꾼 1분마다, ADR-0369 결정 7). 묶음마다 next_submit_at 조건부 잡기로 한 파드만 보내고,
   * 자동 전송 마감(지급일 전 영업일 22:00 KST)이 된 승인 묶음은 보내지 않고 지급일을 다음 은행 영업일로 미룬다.
   */
  async submitDueBatches(limit = SUBMIT_LIMIT): Promise<{ submitted: number; postponed: number }> {
    const now = this.#now();
    let submitted = 0;
    let postponed = 0;
    for (const b of await this.d.store.listDueSubmitBatches(now, limit)) {
      const claim = new Date(now.getTime() + SUBMIT_CLAIM_MS);
      if (!(await this.d.store.claimBatchSubmit(b.batchId, b.nextSubmitAt, claim))) continue;
      const claimed: PayoutBatchRecord = { ...b, nextSubmitAt: claim };
      try {
        if (b.status === 'APPROVED' && b.submitDeadlineAt !== null && now.getTime() >= b.submitDeadlineAt.getTime()) {
          await this.#postpone(claimed, now);
          postponed += 1;
          continue;
        }
        await this.#submitBatch(claimed);
        submitted += 1;
      } catch (e) {
        // 한 묶음의 실패가 나머지를 멈추지 않는다. 잡은 시각(5분 [가정]) 뒤 다시 본다
        this.d.log?.payoutJobFailed?.({ job: 'submit-payout-batch', batchId: b.batchId, reason: errorReason(e), at: now });
      }
    }
    return { submitted, postponed };
  }

  async #submitBatch(b: PayoutBatchRecord): Promise<PayoutBatchRecord> {
    const boundStatements = await this.d.store.listStatementsByBatch(b.batchId);
    if (boundStatements.length === 0) throw new SettlementProblem('payout-batch-empty', 409, '지급할 확정 정산서가 없습니다');
    // 승인 뒤 판매가 중지됐을 수 있다. 결제사에 요청하기 직전에 다시 확인하고, 하나라도 중지면 멈춘다(ADR-0123).
    await this.#assertNoSaleSuspension(boundStatements);
    const gateway = this.d.gateways.find((g) => g.pg === b.pg);
    if (!gateway) throw new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
    const now = this.#now();
    const boundTotal = boundStatements.reduce((total, s) => total + s.payoutAmount, 0);
    if (boundTotal !== b.totalAmount) throw new SettlementProblem('payout-batch-amount-mismatch', 409, '승인한 지급 금액과 정산서 합계가 다릅니다');
    // 포트원 플랫폼이 켜진 갈래(PortonePlatformPayoutGateway는 전송을 들고 있다, F-07-7 I-07)
    if (b.pg === 'PORTONE' && this.d.portone && 'transport' in gateway) return this.#submitPortonePlatform(b, this.d.portone, boundStatements, now);
    let payouts = await this.d.store.listPayouts(b.batchId);
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
            batchId: b.batchId,
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
            payoutDate: b.payoutDate,
            failureClass: null,
            retryOfPayoutId: null,
            autoRetryCount: 0,
            createdAt: now,
            updatedAt: now,
          });
        });
      }
      payouts = next;
      await this.d.store.insertPayouts(payouts);
    }
    const live = livePayouts(payouts);
    if (sum(live) !== b.totalAmount) throw new SettlementProblem('payout-batch-amount-mismatch', 409, '승인한 지급 금액과 정산서 합계가 다릅니다');
    if (b.pg !== 'TOSS') return this.#submitManual(b, await gateway.submit({ batch: b, payouts }), boundStatements, now);
    return this.#submitToss(b, gateway, live, boundStatements, now);
  }

  /**
   * 포트원 플랫폼이 켜진 실행(F-07-7 I-07, ADR-0370 결정 7): 정산서마다 수기 정산건(아이디 = 정산서 ID)을 만들고, 지급 건 한 행({정산서 ID}-1, 결제사 지급 ID = 수기 정산건 ID)·
   * T9(CONFIRMED → SCHEDULED)·PAYOUT_SCHEDULED를 한 쓰기에 둔다. 같은 아이디가 이미 있고 금액·정산일이 같으면 만들지 않고 이어 쓰며, 다르면 502로 멈춘다(그 정산서는 아무것도 쓰지 않음).
   * 이미 지급 건이 있는 정산서는 건너뛴다(앞선 시도가 쓴 것). 모두 쓰면 묶음을 SUBMITTED로 둔다
   */
  async #submitPortonePlatform(b: PayoutBatchRecord, transport: PortonePlatformTransport, boundStatements: readonly StatementRecord[], now: Date): Promise<PayoutBatchRecord> {
    const existing = new Set((await this.d.store.listPayouts(b.batchId)).map((p) => p.statementId));
    for (const s of boundStatements) {
      if (existing.has(s.statementId) || s.status !== 'CONFIRMED') continue;
      const partner = await this.d.store.findPortonePartner(s.promoterId);
      if (!partner) throw new SettlementProblem('payout-gateway-unavailable', 503, '포트원 파트너 등록이 없는 정산서가 있어 실행할 수 없습니다');
      try {
        await transport.createManualTransfer({ transferId: s.statementId, partnerId: partner.portonePartnerId, amount: s.payoutAmount, settlementDate: b.payoutDate });
      } catch (e) {
        const kind = typeof e === 'object' && e !== null && 'kind' in e ? (e as { kind: unknown }).kind : undefined;
        if (kind === 'REJECTED') throw new SettlementProblem('portone-transfer-conflict', 502, '포트원 수기 정산건이 정산서와 맞지 않습니다');
        throw new SettlementProblem('payout-gateway-unavailable', 503, '포트원 수기 정산건을 만들지 못했습니다');
      }
      const payout: PayoutRecord = {
        payoutId: uuidv7(this.d.clock),
        batchId: b.batchId,
        statementId: s.statementId,
        seq: 1,
        amount: s.payoutAmount,
        refPayoutId: `${s.statementId}-1`,
        pgPayoutId: s.statementId,
        status: 'REQUESTED',
        errorCode: null,
        pgTransferId: null,
        transferCheck: null,
        transferCheckedAt: null,
        payoutDate: b.payoutDate,
        failureClass: null,
        retryOfPayoutId: null,
        autoRetryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      const audit = this.#audit(s.statementId, s.status, 'SCHEDULED', 'portone-transfer-created', 'system', now);
      const scheduled: StatementRecord = { ...s, status: 'SCHEDULED', updatedAt: now };
      const out = await this.d.store.writePayoutChanges({
        insertPayouts: [payout],
        transitions: [{ statementId: s.statementId, from: ['CONFIRMED'], to: 'SCHEDULED', expect: { payoutBatchId: b.batchId }, updatedAt: now, audits: [audit], events: [payoutEvent(scheduled, 'PAYOUT_SCHEDULED', s.payoutAmount, now, audit.auditId)] }],
      });
      if (!out.ok) throw stateConflict();
    }
    const next: PayoutBatchRecord = { ...b, status: 'SUBMITTED', updatedAt: now };
    await this.d.store.savePayoutBatch(next);
    return next;
  }

  /** 포트원(콘솔 수기 실행): 실행 기록만 남기고 묶인 정산서를 SCHEDULED로 옮긴다(LCH-120 몫의 결과 반영은 F-07-7) */
  async #submitManual(b: PayoutBatchRecord, result: { status: 'SUBMITTED' | 'COMPLETED' | 'PENDING' }, boundStatements: readonly StatementRecord[], now: Date): Promise<PayoutBatchRecord> {
    const nextStatus = result.status === 'COMPLETED' ? 'COMPLETED' : 'SUBMITTED';
    const next: PayoutBatchRecord = { ...b, status: nextStatus, updatedAt: now };
    await this.d.store.savePayoutBatch(next);
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
    return next;
  }

  /** 다음 시도 시각만 남기고 보내지 않는다(응답 없음·잔액 모자람·잔액 원천 실패) */
  async #scheduleRetry(b: PayoutBatchRecord, attempts: number, code: string, deadline: Date, now: Date, cases: readonly SettlementCaseRequestRecord[] = []): Promise<PayoutBatchRecord> {
    const set = { submitAttempts: attempts, nextSubmitAt: new Date(now.getTime() + submitBackoffMs(attempts)), lastSubmitError: code, submitDeadlineAt: deadline, updatedAt: now };
    const out = await this.d.store.writePayoutChanges({ batch: { batchId: b.batchId, set }, caseRequests: cases });
    if (!out.ok) throw stateConflict();
    return { ...b, ...set };
  }

  async #tossSellerIds(payouts: readonly PayoutRecord[], statements: readonly StatementRecord[], pgStore: PgStore): Promise<Record<string, string>> {
    const promoterOf = new Map(statements.map((s) => [s.statementId, s.promoterId]));
    const sellerOf = new Map<string, string | undefined>();
    const out: Record<string, string> = {};
    for (const p of payouts) {
      const promoterId = promoterOf.get(p.statementId);
      if (!promoterId) continue;
      if (!sellerOf.has(promoterId)) sellerOf.set(promoterId, (await this.d.store.findTossSeller(promoterId, pgStore))?.tossSellerId);
      const id = sellerOf.get(promoterId);
      if (id) out[p.payoutId] = id;
    }
    return out;
  }

  async #submitToss(b: PayoutBatchRecord, gateway: PayoutGateway, live: readonly PayoutRecord[], boundStatements: readonly StatementRecord[], now: Date): Promise<PayoutBatchRecord> {
    let pending = live.filter((p) => p.pgPayoutId === null && p.status === 'REQUESTED');
    const attempts = b.submitAttempts + 1;
    // 자동 전송 마감: 처음 실행 때 지급일 전 영업일 22:00 KST [가정]. 지난 마감(사람이 다시 실행)은 지금 지급일로 다시 잡는다
    const deadline = b.submitDeadlineAt !== null && b.submitDeadlineAt.getTime() > now.getTime() ? b.submitDeadlineAt : submitDeadlineFor(b.payoutDate);
    if (pending.length === 0) {
      const status = batchStatusOf(b.status, live);
      const set = { status, nextSubmitAt: null, submitDeadlineAt: deadline, updatedAt: now };
      const out = await this.d.store.writePayoutChanges({ batch: { batchId: b.batchId, set } });
      if (!out.ok) throw stateConflict();
      return { ...b, ...set };
    }
    // 요청 직전 잔액: 지급 가능 − 이 묶음 밖의 끝나지 않은 예약지급 < 보낼 금액이면 보내지 않는다(settlement §5.1, ADR-0369 결정 7)
    if (this.d.pgBalance) {
      let balance: { availableAmount: number; pendingAmount: number } | undefined;
      try {
        balance = await this.d.pgBalance.available({ pg: 'TOSS', pgStore: b.pgStore });
      } catch {
        return this.#scheduleRetry(b, attempts, 'NO_RESPONSE', deadline, now);
      }
      if (balance) {
        const reserved = await this.d.store.sumUnfinishedTossPayouts(b.pgStore, b.batchId);
        if (balance.availableAmount - reserved < sum(pending)) return this.#scheduleRetry(b, attempts, 'BALANCE_SHORT', deadline, now, [caseOf('PAYOUT_DELAYED', b.batchId, `payout-balance:${b.batchId}`, now)]);
      }
    }
    const sellerIds = await this.#tossSellerIds(pending, boundStatements, b.pgStore);
    const first = await gateway.submit({ batch: b, payouts: pending, tossSellerIds: sellerIds });
    // 묶음별 결과가 없는 실행 기록 어댑터는 묶음 전체의 결과만 반영한다(포트원과 같다)
    if (!first.groups) return this.#submitManual(b, first, boundStatements, now);
    let groups = first.groups;
    let batchDate = b.payoutDate;
    let dateRetryUsed = b.dateRetryUsed;
    const payoutDates = new Map<string, string>();
    // 예약 날짜 오류는 지급일을 다음 은행 영업일로 바꿔 새 키로 곧바로 한 번 다시 보낸다(settlement §12 날짜 오류 행)
    const dateRejected = groups.filter((g) => g.result.kind === 'REJECTED' && TOSS_PAYOUT_DATE_ERRORS.has(g.result.code));
    if (dateRejected.length > 0 && !dateRetryUsed) {
      const refs = new Set(dateRejected.flatMap((g) => g.refPayoutIds));
      const moved = pending.filter((p) => refs.has(p.refPayoutId)).map((p) => ({ ...p, payoutDate: nextBankBusinessDay(p.payoutDate) }));
      batchDate = nextBankBusinessDay(b.payoutDate);
      dateRetryUsed = true;
      const saved = await this.d.store.writePayoutChanges({
        payoutUpdates: moved.map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED'], set: { payoutDate: p.payoutDate, updatedAt: now } })),
        batch: { batchId: b.batchId, set: { payoutDate: batchDate, dateRetryUsed: true, updatedAt: now } },
      });
      if (!saved.ok) throw stateConflict();
      for (const p of moved) payoutDates.set(p.payoutId, p.payoutDate);
      pending = pending.map((p) => moved.find((m) => m.payoutId === p.payoutId) ?? p);
      const again = await gateway.submit({ batch: { ...b, payoutDate: batchDate }, payouts: moved, tossSellerIds: sellerIds });
      groups = [...groups.filter((g) => !dateRejected.includes(g)), ...(again.groups ?? [])];
    }
    const accepted = new Map<string, { pgPayoutId: string; status: PayoutRecord['status'] }>();
    let waitCode: string | undefined;
    let rejectedCode: string | undefined;
    for (const g of groups) {
      const r: TossSendResult = g.result;
      if (r.kind === 'ACCEPTED') for (const p of r.payouts) accepted.set(p.refPayoutId, { pgPayoutId: p.pgPayoutId, status: p.status });
      else if (r.kind === 'REJECTED') rejectedCode ??= r.code;
      else waitCode ??= r.kind;
    }
    const after = live.map((p) => {
      const a = accepted.get(p.refPayoutId);
      const date = payoutDates.get(p.payoutId) ?? p.payoutDate;
      return a && p.pgPayoutId === null ? { ...p, pgPayoutId: a.pgPayoutId, status: a.status, payoutDate: date } : { ...p, payoutDate: date };
    });
    const touched = new Set(pending.filter((p) => accepted.has(p.refPayoutId)).map((p) => p.statementId));
    const transitions: StatementTransition[] = [];
    for (const s of boundStatements) {
      if (!touched.has(s.statementId)) continue;
      const mine = after.filter((p) => p.statementId === s.statementId);
      // 조각이 모두 접수된(그리고 실패가 남지 않은) 정산서만 T9(CONFIRMED → SCHEDULED)·T13(FAILED → SCHEDULED)와 PAYOUT_SCHEDULED(금액 = 지급액)
      if (mine.length === 0 || mine.some((p) => p.pgPayoutId === null || p.status === 'FAILED')) continue;
      const audit = this.#audit(s.statementId, s.status, 'SCHEDULED', 'payout-accepted', 'system', now);
      const scheduled: StatementRecord = { ...s, status: 'SCHEDULED', updatedAt: now };
      transitions.push({ statementId: s.statementId, from: ['CONFIRMED', 'FAILED'], to: 'SCHEDULED', expect: { payoutBatchId: b.batchId }, optional: true, updatedAt: now, audits: [audit], events: [payoutEvent(scheduled, 'PAYOUT_SCHEDULED', s.payoutAmount, now, audit.auditId)] });
    }
    const remaining = after.filter((p) => p.pgPayoutId === null && p.status === 'REQUESTED');
    const cases: SettlementCaseRequestRecord[] = [];
    // 오류 응답은 키를 바꾸지 않고 사람에게(CS PAYOUT_ERROR, 대상 = 묶음). 결제사 오류 원문은 넣지 않는다
    if (rejectedCode) cases.push(caseOf('PAYOUT_ERROR', b.batchId, `payout-error:${b.batchId}:${attempts}`, now));
    const set =
      remaining.length === 0
        ? { status: batchStatusOf(b.status, after), nextSubmitAt: null, lastSubmitError: null, submitAttempts: attempts, submitDeadlineAt: deadline, dateRetryUsed, updatedAt: now }
        : {
            submitAttempts: attempts,
            // 응답 없음·처리 중은 같은 키로 1분에서 두 배씩·30분 상한 간격, 오류 응답만 남았으면 자동으로 다시 보내지 않는다
            nextSubmitAt: waitCode ? new Date(now.getTime() + submitBackoffMs(attempts)) : null,
            lastSubmitError: rejectedCode ?? waitCode ?? null,
            submitDeadlineAt: deadline,
            dateRetryUsed,
            updatedAt: now,
          };
    const out = await this.d.store.writePayoutChanges({
      payoutUpdates: pending.filter((p) => accepted.has(p.refPayoutId)).map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED'], set: { pgPayoutId: accepted.get(p.refPayoutId)!.pgPayoutId, status: accepted.get(p.refPayoutId)!.status, updatedAt: now } })),
      transitions,
      batch: { batchId: b.batchId, set },
      caseRequests: cases,
    });
    if (!out.ok) throw stateConflict();
    return { ...b, payoutDate: batchDate, ...set };
  }

  /**
   * 자동 전송 마감을 넘긴 묶음(ADR-0369 결정 7·14 ①): 보내지 않고 지급일을 다음 은행 영업일로 미룬다. 묶인 CONFIRMED 정산서마다 지급일·같은 상태 감사(payout-postponed)·
   * PAYOUT_HELD를, 묶음에 CS PAYOUT_DELAYED(대상 = 묶음)를 한 트랜잭션에 쓴다. 그 뒤 자동 전송은 없고 operator가 다시 실행하면 새 지급일·새 키다.
   */
  async #postpone(b: PayoutBatchRecord, now: Date): Promise<void> {
    const newDate = nextBankBusinessDay(b.payoutDate);
    const payouts = livePayouts(await this.d.store.listPayouts(b.batchId)).filter((p) => p.pgPayoutId === null && p.status === 'REQUESTED');
    const transitions: StatementTransition[] = [];
    for (const s of await this.d.store.listStatementsByBatch(b.batchId)) {
      if (s.status !== 'CONFIRMED') continue;
      const audit = this.#audit(s.statementId, 'CONFIRMED', 'CONFIRMED', 'payout-postponed', 'system', now);
      const next: StatementRecord = { ...s, payoutDate: newDate, updatedAt: now };
      transitions.push({ statementId: s.statementId, from: ['CONFIRMED'], to: 'CONFIRMED', set: { payoutDate: newDate }, expect: { payoutBatchId: b.batchId }, optional: true, updatedAt: now, audits: [audit], events: [payoutEvent(next, 'PAYOUT_HELD', s.payoutAmount, now, audit.auditId)] });
    }
    const out = await this.d.store.writePayoutChanges({
      payoutUpdates: payouts.map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED'], set: { payoutDate: nextBankBusinessDay(p.payoutDate), updatedAt: now } })),
      transitions,
      batch: { batchId: b.batchId, expectStatus: ['APPROVED'], set: { payoutDate: newDate, nextSubmitAt: null, submitDeadlineAt: submitDeadlineFor(newDate), updatedAt: now } },
      caseRequests: [caseOf('PAYOUT_DELAYED', b.batchId, `payout-deadline:${b.batchId}:${b.payoutDate}`, now)],
    });
    if (!out.ok) throw stateConflict();
  }

  /**
   * 지급 결과 반영(웹훅·미완료 점검의 단건 조회 결과, ADR-0369 결정 6·8). 지급 건 조건부 갱신이 0행이면 아무것도 하지 않는다(applied false).
   * COMPLETED면 그 정산서의 살아 있는 지급 건이 모두 완료일 때 T11·PAYOUT_COMPLETED(금액 = 지급액), FAILED면 실패 갈래를 적고 T12·PAYOUT_FAILED(금액 = 그 지급 건)와
   * 갈래별 처리(점검은 새 순번 재요청, 계좌·모름·셋째 실패는 CS PAYOUT_FAILED, 한도/KYC는 CS SELLER_KYC_REQUIRED)를, 묶음 상태와 함께 한 트랜잭션에 쓴다.
   */
  async applyPayoutFact(fact: { pgPayoutId: string; status: PayoutRecord['status']; errorCode?: string; observedAt: Date }): Promise<{ applied: boolean }> {
    const p = await this.d.store.findPayoutByPgPayoutId(fact.pgPayoutId);
    if (!p || !UNFINISHED_PAYOUT.includes(p.status) || fact.status === p.status || fact.status === 'REQUESTED') return { applied: false };
    const now = this.#now();
    const failureClass = fact.status === 'FAILED' ? classifyTossFailure(fact.errorCode ?? '') : null;
    const statement = await this.d.store.findStatementById(p.statementId);
    const seller = failureClass === 'LIMIT_KYC' && statement ? await this.d.store.findTossSeller(statement.promoterId, statement.pgStore) : undefined;
    const res = await this.d.store.applyPayoutFact({
      payoutId: p.payoutId,
      from: UNFINISHED_PAYOUT,
      set: { status: fact.status, errorCode: fact.status === 'FAILED' ? (fact.errorCode ?? null) : null, failureClass, updatedAt: now },
      decide: (snap) => this.#afterPayoutFact(snap, now, seller?.tossSellerId),
    });
    if (!res) return { applied: false };
    if (failureClass) this.d.signals?.payoutFailed('TOSS', failureClass);
    // 한도/KYC 실패면 그 셀러 상태를 단건 조회로 다시 본다(KYC_REQUIRED면 그 상점 토스 정산서가 다음 묶음에서 보류된다). 실패해도 반영은 그대로다
    if (failureClass === 'LIMIT_KYC' && seller && this.d.tossTransport) {
      try {
        const s = await this.d.tossTransport.getSeller(seller.pgStore, seller.tossSellerId);
        await this.applyTossSellerFact({ pgStore: seller.pgStore, tossSellerId: s.tossSellerId, status: s.status, checkedAt: now });
      } catch (e) {
        this.d.log?.payoutJobFailed?.({ job: 'toss-seller-refresh', pgStore: seller.pgStore, reason: errorReason(e), at: now });
      }
    }
    return { applied: true };
  }

  /** 결과 반영의 같은 트랜잭션 쓰기(저장소가 지급 건을 바꾼 뒤 정산서·묶음 행을 잠근 채 읽은 값으로 부른다) */
  #afterPayoutFact(snap: PayoutFactSnapshot, now: Date, tossSellerId: string | undefined): PayoutWrite {
    const { payout, statement, statementPayouts, batch, batchPayouts } = snap;
    const transitions: StatementTransition[] = [];
    const caseRequests: SettlementCaseRequestRecord[] = [];
    const retries: NonNullable<PayoutWrite['retries']>[number][] = [];
    const batchSet: Partial<Pick<PayoutBatchRecord, 'status' | 'nextSubmitAt' | 'submitDeadlineAt'>> = {};
    let retriedNew: PayoutRecord | undefined;
    if (payout.status === 'COMPLETED') {
      const live = livePayouts(statementPayouts);
      if (live.length > 0 && live.every((p) => p.status === 'COMPLETED')) {
        const audit = this.#audit(statement.statementId, statement.status, 'PAID', 'payout-completed', 'system', now);
        const paid: StatementRecord = { ...statement, status: 'PAID', updatedAt: now };
        transitions.push({ statementId: statement.statementId, from: ['SCHEDULED'], to: 'PAID', optional: true, updatedAt: now, audits: [audit], events: [payoutEvent(paid, 'PAYOUT_COMPLETED', statement.payoutAmount, now, payout.payoutId)] });
      }
    } else if (payout.status === 'FAILED' && payout.failureClass) {
      const audit = this.#audit(statement.statementId, statement.status, 'FAILED', `payout-failed-${payout.failureClass.toLowerCase()}`, 'system', now);
      const failed: StatementRecord = { ...statement, status: 'FAILED', updatedAt: now };
      transitions.push({ statementId: statement.statementId, from: ['SCHEDULED', 'FAILED'], to: 'FAILED', optional: true, updatedAt: now, audits: [audit], events: [payoutEvent(failed, 'PAYOUT_FAILED', payout.amount, now, payout.payoutId)] });
      const action = payoutFailureAction(payout.failureClass, payout.autoRetryCount);
      if (action === 'AUTO_RETRY') {
        const payoutDate = retryPayoutDate(now);
        const newPayoutId = uuidv7(this.d.clock);
        retries.push({ oldPayoutId: payout.payoutId, newPayoutId, auditId: uuidv7(this.d.clock), payoutDate, autoRetryCount: payout.autoRetryCount + 1, actor: 'system', reason: 'TRANSIENT', at: now });
        batchSet.nextSubmitAt = now;
        batchSet.submitDeadlineAt = submitDeadlineFor(payoutDate);
        retriedNew = { ...payout, payoutId: newPayoutId, pgPayoutId: null, status: 'REQUESTED', retryOfPayoutId: payout.payoutId, failureClass: null };
      } else if (action === 'AWAIT_SELLER' && tossSellerId) {
        caseRequests.push(caseOf('SELLER_KYC_REQUIRED', tossSellerId, `seller-kyc:${tossSellerId}:payout:${payout.payoutId}`, now));
      } else {
        caseRequests.push(caseOf('PAYOUT_FAILED', payout.payoutId, `payout-failed:${payout.payoutId}`, now));
      }
    }
    const status = batchStatusOf(batch.status, livePayouts(retriedNew ? [...batchPayouts, retriedNew] : batchPayouts));
    if (status !== batch.status) batchSet.status = status;
    return {
      ...(retries.length > 0 ? { retries } : {}),
      transitions,
      ...(Object.keys(batchSet).length > 0 ? { batch: { batchId: batch.batchId, set: { ...batchSet, updatedAt: now } } } : {}),
      caseRequests,
    };
  }

  /**
   * 사람의 재요청(ADR-0369 결정 8): 같은 금액·같은 셀러로만 새 순번을 만들고 감사(행위자 = 계정 ID, 사유 = 실패 갈래)를 남긴다. 2인 승인을 다시 받지 않는다.
   * 정산 계좌 변경 보류 중(hold_until > 지금)이면 409 payout-account-change-hold, 예금주 미확인이면 409 payout-account-mismatch,
   * 금액이나 상점을 바꾸면 409 payout-retry-approval-required(다시 계산·새 지급 묶음 승인으로)다.
   */
  async retryPayout(payoutId: string, input: { actorId: string; amount?: number; pgStore?: PgStore }): Promise<PayoutRecord> {
    return guard(async () => {
      if (typeof input?.actorId !== 'string' || input.actorId.trim() === '' || input.actorId.length > 128) throw new SettlementProblem('invalid-query', 422, '재요청 행위자가 필요합니다');
      const p = await this.d.store.findPayout(payoutId);
      if (!p) throw notFound();
      if (p.status !== 'FAILED') throw new SettlementProblem('payout-not-retryable', 409, '실패한 지급 건만 다시 보낼 수 있습니다');
      const s = await this.d.store.findStatementById(p.statementId);
      if (!s) throw notFound();
      if ((input.amount !== undefined && input.amount !== p.amount) || (input.pgStore !== undefined && input.pgStore !== s.pgStore)) {
        throw new SettlementProblem('payout-retry-approval-required', 409, '금액이나 셀러를 바꾼 재요청은 새 지급 묶음 승인이 필요합니다');
      }
      const now = this.#now();
      const account = await this.d.store.findPayoutAccount(s.promoterId);
      if (account && account.holdUntil.getTime() > now.getTime()) throw new SettlementProblem('payout-account-change-hold', 409, '정산 계좌 변경 보류 중이라 지급할 수 없습니다');
      if (account && !account.holderVerified) throw new SettlementProblem('payout-account-mismatch', 409, '예금주가 확인되지 않은 정산 계좌라 지급할 수 없습니다');
      const batch = await this.d.store.findPayoutBatch(p.batchId);
      const toss = batch?.pg === 'TOSS';
      const payoutDate = toss ? retryPayoutDate(now) : p.payoutDate;
      const out = await this.d.store.writePayoutChanges({
        retries: [{ oldPayoutId: p.payoutId, newPayoutId: uuidv7(this.d.clock), auditId: uuidv7(this.d.clock), payoutDate, autoRetryCount: p.autoRetryCount, actor: input.actorId, reason: p.failureClass ?? 'UNKNOWN', at: now }],
        ...(toss ? { batch: { batchId: p.batchId, set: { nextSubmitAt: now, submitDeadlineAt: submitDeadlineFor(payoutDate), updatedAt: now } } } : {}),
      });
      const created = out.retried[0];
      if (!out.ok || !created) throw new SettlementProblem('payout-not-retryable', 409, '실패한 지급 건만 다시 보낼 수 있습니다');
      return created;
    });
  }

  /** 보내지 못한 지급 쪽 CS 건 요청을 ops에 보낸다(정산 일꾼 30분마다, ADR-0369 결정 10). 한 건 실패가 나머지를 멈추지 않는다 */
  async retryPayoutCases(limit = CASE_RETRY_LIMIT): Promise<{ sent: number; pending: number }> {
    const rows = await this.d.store.listUnsentCaseRequests(limit);
    if (!this.d.caseNotice) return { sent: 0, pending: rows.length };
    let sent = 0;
    const notice = this.d.caseNotice;
    for (const c of rows) {
      // 건 본문 글이 있으면 같은 글을 다시 싣는다(F-07-7 계획 §5.1 (타) 결정 2). 거절은 세고 3번째에 영구 실패(§5.1 (파) (마))
      const ok = await this.#deliver('case-request', 'cs-case', c.eventKey, c.eventKey, c.kind, () =>
        notice.openCase({ eventKey: c.eventKey, kind: c.kind, sourceId: c.sourceId, createdAt: c.createdAt, ...(c.detail ? { detail: c.detail } : {}) }),
      );
      if (!ok) {
        this.d.log?.payoutCaseNoticeFailed?.({ eventKey: c.eventKey, kind: c.kind, at: this.#now() });
        continue;
      }
      try {
        await this.d.store.markCaseRequestSent(c.eventKey, this.#now());
        sent += 1;
      } catch {
        this.d.log?.payoutCaseNoticeFailed?.({ eventKey: c.eventKey, kind: c.kind, at: this.#now() });
      }
    }
    return { sent, pending: rows.length - sent };
  }

  /**
   * 지급일 다음 영업일 12:00 KST가 지난 끝나지 않은 토스 지급 건을 단건 조회해 반영하고, 그래도 끝나지 않았으면 CS PAYOUT_DELAYED(사건 키 payout-overdue:{지급 건 ID})와
   * settlement_payout_overdue_total 1(ADR-0369 결정 12). 같은 건의 다음 점검은 건·지표를 다시 늘리지 않는다
   */
  async checkOverduePayouts(limit = OVERDUE_LIMIT): Promise<{ checked: number; delayed: number }> {
    const transport = this.d.tossTransport;
    if (!transport) return { checked: 0, delayed: 0 };
    const now = this.#now();
    let checked = 0;
    let delayed = 0;
    for (const p of await this.d.store.listOverduePayouts(now, limit)) {
      try {
        const batch = await this.d.store.findPayoutBatch(p.batchId);
        const fact = await transport.getPayout(batch?.pgStore ?? 'STANDARD', p.pgPayoutId!);
        checked += 1;
        await this.applyPayoutFact({ pgPayoutId: fact.pgPayoutId, status: fact.status, ...(fact.errorCode ? { errorCode: fact.errorCode } : {}), observedAt: now });
        const latest = await this.d.store.findPayout(p.payoutId);
        if (latest && UNFINISHED_PAYOUT.includes(latest.status)) {
          const inserted = await this.d.store.insertCaseRequests([caseOf('PAYOUT_DELAYED', p.payoutId, `payout-overdue:${p.payoutId}`, now)]);
          if (inserted > 0) {
            delayed += 1;
            this.d.signals?.payoutOverdue('TOSS');
          }
        }
      } catch (e) {
        this.d.log?.payoutJobFailed?.({ job: 'overdue-payout-check', batchId: p.batchId, reason: errorReason(e), at: now });
      }
    }
    return { checked, delayed };
  }

  /** 토스 지급대행 전송이 조립됐는가(09시 묶음·미완료 점검의 조건) */
  /** 포트원 플랫폼 지급대행이 조립되었는가(F-07-7). 꺼지면 정산 일꾼이 포트원 실행·대사를 하지 않는다 */
  portonePayoutEnabled(): boolean {
    return this.d.portone !== undefined && this.d.portoneConfig !== undefined;
  }

  tossPayoutEnabled(): boolean {
    return this.d.tossTransport !== undefined;
  }

  /** 결제사 잔액 대사를 할 수 있는가(전송·장부 원천) */
  tossReconciliationEnabled(): boolean {
    return this.d.tossTransport !== undefined && this.d.pgLedger !== undefined;
  }

  /**
   * 토스 결제 상점의 결제사 잔액 대사(ADR-0369 결정 11, settlement §5.5). 있어야 할 잔액(장부)과 보이는 잔액(지급 가능 + 정산 대기)의 차이를 적고,
   * 차이가 0이 아니면 같은 트랜잭션에 CS PG_BALANCE_MISMATCH(대상 TOSS:{상점}, 사건 키 = 대사 행 ID)를 쓴다. 같은 달·같은 묶음이면 undefined
   */
  async reconcileTossBalance(input: { pgStore: PgStore; kind: 'MONTHLY'; periodMonth: string } | { pgStore: PgStore; kind: 'BATCH'; batchId: string }): Promise<PgBalanceReconciliationRecord | undefined> {
    return guard(async () => {
      const transport = this.d.tossTransport;
      const ledgerSource = this.d.pgLedger;
      if (!transport || !ledgerSource) throw new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
      const terms = this.d.tossTerms ?? DEFAULT_TOSS_PAYOUT_TERMS;
      const now = this.#now();
      const ledger = await ledgerSource.ledger({ pg: 'TOSS', pgStore: input.pgStore, cutoffAt: now });
      const prev = await this.d.store.lastPgBalanceReconciliation('TOSS', input.pgStore);
      // 정산 조회 수수료는 지난 대사 뒤 기간만 읽어 앞 누적에 더하고(첫 대사는 그 상점 첫 결제일부터), 이용료는 첫 지급 달부터 달마다 다시 센다
      const prevSettlementFees = prev ? prev.pgFeeAmount - payoutUsageFee(ledger.payoutCountByMonth, kstMonthOf(prev.cutoffAt), terms) : 0;
      const from = prev ? prev.cutoffAt : (ledger.firstPaymentAt ?? now);
      const newFees = await transport.listSettlementFees(input.pgStore, from, now);
      const pgFeeAmount = prevSettlementFees + newFees + payoutUsageFee(ledger.payoutCountByMonth, kstMonthOf(now), terms);
      const expectedAmount = ledgerBalance({ approvedAmount: ledger.approvedAmount, refundedAmount: ledger.refundedAmount, pgFees: pgFeeAmount, paidOut: ledger.paidOutAmount, peaketWithdrawn: 0 });
      const balance = await transport.balance(input.pgStore);
      const observedAmount = balance.availableAmount + balance.pendingAmount;
      const diffAmount = observedAmount - expectedAmount;
      const record: PgBalanceReconciliationRecord = {
        reconciliationId: uuidv7(this.d.clock),
        pg: 'TOSS',
        pgStore: input.pgStore,
        kind: input.kind,
        periodMonth: input.kind === 'MONTHLY' ? input.periodMonth : null,
        batchId: input.kind === 'BATCH' ? input.batchId : null,
        cutoffAt: now,
        approvedAmount: ledger.approvedAmount,
        refundedAmount: ledger.refundedAmount,
        pgFeeAmount,
        paidOutAmount: ledger.paidOutAmount,
        peaketWithdrawnAmount: 0,
        expectedAmount,
        observedAmount,
        diffAmount,
        severity: pgBalanceSeverity(diffAmount),
        createdAt: now,
      };
      const caseRequest = diffAmount !== 0 ? caseOf('PG_BALANCE_MISMATCH', `TOSS:${input.pgStore}`, record.reconciliationId, now) : undefined;
      if (!(await this.d.store.insertPgBalanceReconciliation(record, caseRequest))) return undefined;
      this.d.signals?.pgBalanceDiff('TOSS', input.pgStore, diffAmount);
      return record;
    });
  }

  /** 대사 행이 없는, 만든 지 24시간 [가정] 안의 토스 묶음마다 BATCH 잔액 대사(정산 일꾼 30분마다). 대사가 묶음을 멈추지 않는다 */
  async reconcileRecentBatches(limit = SUBMIT_LIMIT): Promise<number> {
    if (!this.tossReconciliationEnabled()) return 0;
    const now = this.#now();
    let done = 0;
    for (const b of await this.d.store.listBatchesAwaitingReconciliation(new Date(now.getTime() - RECON_BATCH_WINDOW_MS), limit)) {
      try {
        if (await this.reconcileTossBalance({ pgStore: b.pgStore, kind: 'BATCH', batchId: b.batchId })) done += 1;
      } catch (e) {
        this.d.log?.payoutJobFailed?.({ job: 'pg-balance-batch', batchId: b.batchId, pgStore: b.pgStore, reason: errorReason(e), at: now });
      }
    }
    return done;
  }

  // ---- F-07-7 포트원 실행·동기화·사후 대사(application/portone-payouts.ts, ADR-0370 결정 7·8) ----

  #portonePayouts(): PortonePayouts {
    return new PortonePayouts(this.d, { applyPayoutFact: (fact) => this.applyPayoutFact(fact) });
  }

  /** 지급일 09:00 KST 실행 건(계획 I-07). 묶음마다 CS PORTONE_PAYOUT_EXECUTION 한 건, 보류 셋·계좌 대조 불일치는 수기 정산건 취소 뒤 HELD */
  async preparePortoneExecution(payoutDate: string): Promise<{ cases: number; held: number; halted: boolean }> {
    return guard(() => this.#portonePayouts().preparePortoneExecution(payoutDate));
  }

  /** 30분 지급 내역 동기화(계획 I-07). 일괄 지급 ID가 적힌 포트원 묶음의 지급 내역을 지급 건에 반영한 수 */
  async syncPortonePayouts(limit?: number): Promise<{ applied: number }> {
    return guard(() => this.#portonePayouts().syncPortonePayouts(limit));
  }

  /** 30분 출금 대사(계획 I-13, J-T20) */
  async reconcilePortoneTransfers(): Promise<{ checked: number; mismatched: number; unlinked: number; missing: number }> {
    return guard(() => this.#portonePayouts().reconcilePortoneTransfers());
  }

  /** 포트원 파트너 계좌 대조(계획 I-14, J-T21). 파트너를 고르지 않으면 전체 */
  async checkPortonePartnerAccounts(input?: { promoterIds?: readonly string[]; settlementDate?: string }): Promise<{ checked: number; mismatched: number; excludedStatements: readonly string[] }> {
    return guard(async () => {
      const r = await this.#portonePayouts().checkPortonePartnerAccounts(input);
      return { checked: r.checked, mismatched: r.mismatched, excludedStatements: r.excludedStatements };
    });
  }

  /** 08:00 KST 뒤 그날 첫 전체 계좌 대조(하루 한 번). 정산 일꾼이 tick마다 부른다. 이미 했거나 08:00 전이면 undefined */
  async runDailyPortonePartnerCheck(): Promise<{ checked: number; mismatched: number } | undefined> {
    return guard(() => this.#portonePayouts().runDailyPartnerCheck());
  }

  /** 포트원 결제분 잔액 대사(계획 I-15 (b)). 같은 달·같은 묶음이면 undefined */
  async reconcilePortoneBalance(input: { kind: 'MONTHLY'; periodMonth: string } | { kind: 'BATCH'; batchId: string }): Promise<PgBalanceReconciliationRecord | undefined> {
    return guard(() => this.#portonePayouts().reconcilePortoneBalance(input));
  }

  /** 대사 멈춤 점검(계획 I-15 (c)). 30분 tick 끝에 부른다 */
  async checkPortoneLedgerStale(): Promise<{ stale: readonly ('WITHDRAWAL' | 'PARTNER_ACCOUNT')[] }> {
    return guard(() => this.#portonePayouts().checkPortoneLedgerStale());
  }

  /** 지급일 15:00 KST 실행 기록 없음 점검(계획 I-15 (d)) */
  async checkPortoneExecutionPending(payoutDate: string): Promise<{ pending: number }> {
    return guard(() => this.#portonePayouts().checkPortoneExecutionPending(payoutDate));
  }

  /**
   * 정산 계좌 변경(F-07-7 I-04, ADR-0370 결정 5, settlement §6). 차례: 재인증 → If-Match → 본문 → 판매자 확인 → 예금주 조회·이름 비교 → 세 곳 수정.
   * 불일치는 계좌를 그대로 두고 HOLDER_MISMATCH 행과 422, 모두 성공(또는 꺼짐으로 건너뜀)이면 판 조건부 갱신·3영업일 보류·ACCEPTED 행과 200,
   * 한 곳이라도 실패하면 같은 쓰기에 수정 대기(agency_sync_pending)·AGENCY_FAILED 행과 502다. 계좌번호는 결제사 요청에만 넘긴다.
   * 받은 변경(ACCEPTED·AGENCY_FAILED)은 보류 끝 날짜까지의 토스 REQUESTED 예약지급을 취소한다(I-06).
   */
  async putPayoutAccount(
    promoterId: string,
    sessionId: string,
    body: { bankCode: string; accountNumber: string; holderName: string },
    ifMatch: string | undefined,
    reauthToken: string | undefined,
  ): Promise<{ bankCode: string; payoutAccountLast4: string; holderVerified: boolean; holdUntil: string; agencySyncPending: boolean; version: number }> {
    return guard(async () => {
      let reauth: VerifiedReauth;
      try {
        reauth = await this.d.reauth.verify(reauthToken, { sessionId, act: 'PAYOUT_ACCOUNT' });
      } catch (e) {
        // 보안 로그: 파트너와 사유 종류만(토큰·계좌 없음, ASVS 16.3.3)
        this.d.log?.payoutAccountReauthRejected?.({ promoterId, reason: reauthToken === undefined ? 'missing' : 'invalid', at: this.#now() });
        throw e;
      }
      const expected = parseIfMatch(ifMatch);
      const current = await this.d.store.findPayoutAccount(promoterId);
      if ((current?.version ?? 0) !== expected) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
      parsePayoutAccountChange(body);
      const kyc = await this.d.store.findKyc(promoterId);
      if (!kyc?.legalName) throw new SettlementProblem('payout-seller-unverified', 409, '판매자 확인이 끝나지 않아 정산 계좌를 받을 수 없습니다');
      const result = await this.#agencies().sync({
        promoterId,
        mode: 'CHANGE',
        businessType: 'CORPORATE',
        company: { name: kyc.legalName, representativeName: kyc.representative ?? kyc.legalName, businessRegistrationNumber: '', email: '', phone: '' },
        account: body,
      });
      const now = this.#now();
      const last4 = accountLast4(body.accountNumber);
      const change = (r: PayoutAccountChangeRecord['result'], holdUntil: Date | null): PayoutAccountChangeRecord => ({
        id: uuidv7(this.d.clock),
        promoterId,
        actorAccountId: reauth.accountId,
        reauthJti: reauth.jti,
        result: r,
        bankCode: body.bankCode,
        accountLast4: last4,
        holdUntil,
        agencyResults: result.agencies,
        reauthFactors: [...reauth.factors],
        createdAt: now,
        auditSentAt: null,
        auditRefusedCount: 0,
        auditFailedAt: null,
      });
      if (!result.holderMatched) {
        await this.d.store.insertPayoutAccountChange(change('HOLDER_MISMATCH', null));
        this.d.signals?.payoutAccountChange?.('HOLDER_MISMATCH');
        throw new SettlementProblem('payout-account-holder-mismatch', 422, '예금주가 판매자 상호나 대표자와 다릅니다');
      }
      const failed = failedAgencies(result.agencies);
      const holdUntil = addBusinessDays(now, 3);
      const record: PayoutAccountRecord = { promoterId, bankCode: body.bankCode, accountLast4: last4, version: expected + 1, changedAt: now, holdUntil, holderVerified: true, agencySyncPending: failed.length > 0 };
      const outcome = failed.length > 0 ? 'AGENCY_FAILED' : 'ACCEPTED';
      const written = await this.d.store.writePayoutChanges({ payoutAccount: { record, expectedVersion: expected }, payoutAccountChange: change(outcome, holdUntil) });
      if (!written.ok) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
      this.d.signals?.payoutAccountChange?.(outcome);
      this.d.signals?.agencySyncPending?.(await this.d.store.countAgencySyncPending());
      // 보류 기간에 지급일이 오는 토스 예약지급을 취소한다(실패해도 변경은 남고, 묶음 판정·09시가 보류로 막는다)
      try {
        await this.cancelScheduledTossPayouts({ promoterId, reason: 'ACCOUNT_CHANGE', payoutDateThrough: kstDateOf(holdUntil) });
      } catch (e) {
        this.d.log?.payoutJobFailed?.({ job: 'scheduled-payout-cancel', reason: errorReason(e), at: now });
      }
      if (failed.length > 0) throw new ProblemError({ type: 'payout-agency-update-failed', status: 502, title: '결제사에 정산 계좌를 반영하지 못했습니다', extensions: { failedAgencies: failed } });
      return payoutAccountOut(record);
    });
  }

  /** 지금 정산 계좌(파트너 GET, ETag = 판). 계좌가 없으면 null 칸과 판 0 */
  async getPayoutAccount(promoterId: string): Promise<{ bankCode: string | null; payoutAccountLast4: string | null; holderVerified: boolean; holdUntil: string | null; agencySyncPending: boolean; version: number }> {
    const a = await this.d.store.findPayoutAccount(promoterId);
    if (!a) return { bankCode: null, payoutAccountLast4: null, holderVerified: false, holdUntil: null, agencySyncPending: false, version: 0 };
    return { ...payoutAccountOut(a), holdUntil: a.holdUntil.getTime() > this.d.clock.now() ? a.holdUntil.toISOString() : null };
  }

  #agencies(): PayoutAgencies {
    return new PayoutAgencies({ store: this.d.store, portone: this.d.portone, portoneConfig: this.d.portoneConfig, toss: this.d.tossTransport, clock: this.d.clock });
  }

  /**
   * 지급대행 등록(판매 승인 요청, core 내부 경로, ADR-0370 결정 1·3). 포트원 플랫폼이 꺼져 있으면 holderChecked false·모두 SKIPPED이고 아무것도 쓰지 않는다.
   * 맞으면 은행·끝 4자리(보류 없음)·판매자 확인(PENDING, 상호·대표자)을 남기고, 한 곳이라도 실패하면 502(성공한 곳은 남는다).
   */
  async registerPayoutAgencies(input: Omit<PayoutAgencySyncInput, 'mode'>): Promise<{ bankCode: string; accountLast4: string; holderChecked: boolean; agencies: PayoutAgencySyncResult['agencies'] }> {
    return guard(async () => {
      const result = await this.#agencies().sync({ ...input, mode: 'REGISTER' });
      const last4 = accountLast4(input.account.accountNumber);
      if (!result.holderChecked) return { bankCode: input.account.bankCode, accountLast4: last4, holderChecked: false, agencies: result.agencies };
      if (!result.holderMatched) throw new SettlementProblem('payout-account-holder-mismatch', 422, '예금주가 판매자 상호나 대표자와 다릅니다');
      const now = this.#now();
      const current = await this.d.store.findPayoutAccount(input.promoterId);
      await this.d.store.savePayoutAccount({
        promoterId: input.promoterId,
        bankCode: input.account.bankCode,
        accountLast4: last4,
        version: (current?.version ?? 0) + 1,
        changedAt: now,
        holdUntil: now,
        holderVerified: true,
        agencySyncPending: current?.agencySyncPending ?? false,
      });
      const kyc = await this.d.store.findKyc(input.promoterId);
      const sameSeller = kyc?.legalName === input.company.name && kyc?.representative === input.company.representativeName;
      if (!(kyc?.status === 'VERIFIED' && sameSeller)) {
        await this.d.store.saveKyc({
          promoterId: input.promoterId,
          status: 'PENDING',
          businessVerified: false,
          representativeVerified: false,
          legalName: input.company.name,
          representative: input.company.representativeName,
          verifiedAt: null,
          source: 'MANUAL',
          updatedAt: now,
        });
      }
      const failed = failedAgencies(result.agencies);
      if (failed.length > 0) throw new ProblemError({ type: 'payout-agency-update-failed', status: 502, title: '결제사에 정산 계좌를 반영하지 못했습니다', extensions: { failedAgencies: failed } });
      return { bankCode: input.account.bankCode, accountLast4: last4, holderChecked: true, agencies: result.agencies };
    });
  }

  /** 등록 읽기(core 판매 승인 조건·관제 상세, ADR-0370 결정 4). 결제사의 셀러·파트너 ID 원문은 싣지 않는다 */
  async getPayoutRegistration(promoterId: string): Promise<PayoutRegistrationView> {
    const [account, partner] = await Promise.all([this.d.store.findPayoutAccount(promoterId), this.d.store.findPortonePartner(promoterId)]);
    const tossSellers: PayoutRegistrationView['tossSellers'] = [];
    for (const pgStore of TOSS_SELLER_STORES) {
      const row = await this.d.store.findTossSeller(promoterId, pgStore);
      if (row) tossSellers.push({ pgStore, status: row.status });
    }
    const now = this.d.clock.now();
    return {
      payoutAccount: account ? { bankCode: account.bankCode, last4: account.accountLast4, holdUntil: account.holdUntil.getTime() > now ? account.holdUntil.toISOString() : null, holderVerified: account.holderVerified } : null,
      agencySyncPending: account?.agencySyncPending ?? false,
      tossEnabled: this.d.tossTransport !== undefined,
      portoneEnabled: this.d.portone !== undefined && this.d.portoneConfig !== undefined,
      tossSellers,
      portonePartnerRegistered: partner !== undefined,
    };
  }

  /** 판매 승인 때 판매자 확인을 쓴다(core 내부 경로, ADR-0370 결정 4). 같은 값이면 행을 그대로 둔다(멱등) */
  async verifySeller(promoterId: string, input: { legalName: string; representative: string; verifiedAt: Date }): Promise<{ status: 'VERIFIED' }> {
    const kyc = await this.d.store.findKyc(promoterId);
    const same =
      kyc?.status === 'VERIFIED' && kyc.businessVerified && kyc.representativeVerified && kyc.legalName === input.legalName && kyc.representative === input.representative && kyc.verifiedAt?.getTime() === input.verifiedAt.getTime();
    if (!same) {
      await this.d.store.saveKyc({
        source: 'MANUAL',
        ...kyc,
        promoterId,
        status: 'VERIFIED',
        businessVerified: true,
        representativeVerified: true,
        legalName: input.legalName,
        representative: input.representative,
        verifiedAt: input.verifiedAt,
        updatedAt: this.#now(),
      });
    }
    return { status: 'VERIFIED' };
  }

  /**
   * 이미 접수된 토스 예약지급 취소(F-07-7 I-06, ADR-0370 결정 6, settlement §5.2·§12). 그 파트너(·상점)의 SCHEDULED 토스 정산서 가운데 지급일 ≤ payoutDateThrough이고
   * 살아 있는 지급 건이 모두 REQUESTED인 것만 지급 건마다 취소를 부른다. 모두 취소되면 지급 건 CANCELED·T10 HELD·PAYOUT_HELD를 한 쓰기에,
   * 일부만 취소되면 취소된 것만 CANCELED로 쓰고 정산서는 그대로 두며 CS PAYOUT_ERROR(사건 키 payout-cancel:{정산서 ID})다.
   */
  async cancelScheduledTossPayouts(input: {
    promoterId: string;
    pgStore?: PgStore;
    /** RECALCULATION: 회차 취소·연기 다시 계산(F-07-8, T10의 보류 사유도 RECALCULATION) */
    reason: 'KYC' | 'ACCOUNT_CHANGE' | 'RECALCULATION';
    payoutDateThrough?: string;
    /** 주면 그 정산서만(F-07-8) */
    statementIds?: readonly string[];
  }): Promise<{ cancelled: number; waiting: number }> {
    const toss = this.d.tossTransport;
    const targets = (await this.d.store.listStatementsOfPromoter(input.promoterId, 'TOSS', ['SCHEDULED'])).filter(
      (s) =>
        (input.pgStore === undefined || s.pgStore === input.pgStore) &&
        (input.payoutDateThrough === undefined || (s.payoutDate !== null && s.payoutDate <= input.payoutDateThrough)) &&
        (input.statementIds === undefined || input.statementIds.includes(s.statementId)) &&
        s.payoutBatchId !== null,
    );
    let cancelled = 0;
    let waiting = 0;
    for (const s of targets) {
      const live = (await this.d.store.listPayouts(s.payoutBatchId!)).filter((p) => p.statementId === s.statementId && p.status !== 'CANCELED' && p.status !== 'FAILED');
      if (live.length === 0) continue;
      if (live.some((p) => p.status !== 'REQUESTED' || p.pgPayoutId === null)) {
        waiting += 1;
        continue;
      }
      if (!toss) continue;
      const done: PayoutRecord[] = [];
      for (const p of live) {
        try {
          await toss.cancelPayout(s.pgStore, p.pgPayoutId!);
          done.push(p);
        } catch (e) {
          this.d.log?.payoutJobFailed?.({ job: 'scheduled-payout-cancel', pgStore: s.pgStore, reason: errorReason(e), at: this.#now() });
        }
      }
      if (done.length === 0) continue;
      const now = this.#now();
      const payoutUpdates = done.map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED'] as PayoutRecord['status'][], set: { status: 'CANCELED' as const, updatedAt: now } }));
      if (done.length < live.length) {
        await this.d.store.writePayoutChanges({ payoutUpdates, caseRequests: [caseOf('PAYOUT_ERROR', s.statementId, `payout-cancel:${s.statementId}`, now)] });
        continue;
      }
      const audit = this.#audit(s.statementId, 'SCHEDULED', 'HELD', `scheduled-payout-cancelled:${input.reason}`, 'system', now);
      const held: StatementRecord = { ...s, status: 'HELD', holdReason: input.reason, updatedAt: now };
      const res = await this.d.store.writePayoutChanges({
        payoutUpdates,
        transitions: [{ statementId: s.statementId, from: ['SCHEDULED'], to: 'HELD', set: { holdReason: input.reason }, updatedAt: now, audits: [audit], events: [payoutEvent(held, 'PAYOUT_HELD', s.payoutAmount, now, audit.auditId)] }],
      });
      if (res.ok) cancelled += 1;
    }
    return { cancelled, waiting };
  }

  /**
   * 계좌 변경 뒤 예약지급 취소 다시 시도(F-07-7 계획 §5.1 (하) 3, 정리 목록 C-10). 계좌 변경 때의 취소 호출이 실패하거나 응답이 없으면
   * 보류 기간 안의 REQUESTED 토스 예약지급이 남는다. 정산 일꾼 30분 tick이 보류가 아직 끝나지 않은 파트너의 SCHEDULED 토스 정산서를 다시 찾아 취소를 다시 시도한다.
   * 이미 취소된 정산서는 HELD라 다시 잡히지 않는다
   */
  async retryAccountChangeCancellations(limit = 500): Promise<{ promoters: number; cancelled: number }> {
    if (!this.d.tossTransport) return { promoters: 0, cancelled: 0 };
    const now = this.d.clock.now();
    const scheduled = await this.d.store.listStatements({ status: 'SCHEDULED', pg: 'TOSS', limit });
    let promoters = 0;
    let cancelled = 0;
    for (const promoterId of new Set(scheduled.map((s) => s.promoterId))) {
      const account = await this.d.store.findPayoutAccount(promoterId);
      if (!account || account.holdUntil.getTime() <= now) continue;
      promoters += 1;
      const out = await this.cancelScheduledTossPayouts({ promoterId, reason: 'ACCOUNT_CHANGE', payoutDateThrough: kstDateOf(account.holdUntil) });
      cancelled += out.cancelled;
    }
    return { promoters, cancelled };
  }

  /** 보내지 않은 정산 계좌 변경 행을 ops 감사(PAYOUT_ACCOUNT_CHANGED)로 보낸다(정산 일꾼 30분마다, ADR-0370 결정 5) */
  async retryPayoutAccountAudits(limit = CASE_RETRY_LIMIT): Promise<{ sent: number; pending: number }> {
    const rows = await this.d.store.listUnsentPayoutAccountChanges(limit);
    const sink = this.d.payoutAccountAudit;
    if (!sink) return { sent: 0, pending: rows.length };
    let sent = 0;
    for (const r of rows) {
      const eventKey = `payout-account-change:${r.id}`;
      const ok = await this.#deliver('payout-account-change', 'audit-record', r.id, eventKey, 'PAYOUT_ACCOUNT_CHANGED', () =>
        sink.send({
          eventKey,
          recordId: r.id,
          occurredAt: r.createdAt,
          payload: {
            promoterId: r.promoterId,
            actorAccountId: r.actorAccountId,
            result: r.result,
            reauthFactors: [...(r.reauthFactors ?? [])],
            holderMatched: r.result !== 'HOLDER_MISMATCH',
            bankCode: r.bankCode,
            accountLast4: r.accountLast4,
            holdUntil: r.holdUntil ? r.holdUntil.toISOString() : null,
            agencies: r.agencyResults,
          },
        }),
      );
      if (ok) {
        await this.d.store.markPayoutAccountChangeSent(r.id, this.#now());
        sent += 1;
      }
    }
    return { sent, pending: rows.length - sent };
  }

  /** 보내지 않은 운영 경보 요청을 ops 운영 경보 받기로 보낸다(정산 일꾼 30분마다, ADR-0370 결정 8) */
  async retrySettlementAlerts(limit = CASE_RETRY_LIMIT): Promise<{ sent: number; pending: number }> {
    const rows = await this.d.store.listUnsentAlertRequests(limit);
    const sink = this.d.alerts;
    if (!sink) return { sent: 0, pending: rows.length };
    let sent = 0;
    for (const a of rows) {
      const ok = await this.#deliver('alert-request', 'ops-alert', a.eventKey, a.eventKey, a.kind, () =>
        sink.send({ eventKey: a.eventKey, kind: a.kind, severity: a.severity, sourceId: a.sourceId, reason: a.kind, createdAt: a.createdAt }),
      );
      if (ok) {
        await this.d.store.markAlertRequestSent(a.eventKey, this.#now());
        sent += 1;
      }
    }
    return { sent, pending: rows.length - sent };
  }

  /**
   * ops 받기 한 번(F-07-7 계획 §5.1 (파) (마)). 거절(202 accepted:false·400·422)은 거절 수를 올리고 3번째에 영구 실패로 남기며 로그 ops_intake_refused,
   * 일시 실패는 세지 않는다. 둘 다 보낸 것으로 보지 않는다(false)
   */
  async #deliver(row: OpsIntakeRow, target: OpsIntakeTarget, key: string, eventKey: string, kind: string, send: () => Promise<void>): Promise<boolean> {
    try {
      await send();
      return true;
    } catch (e) {
      const refusal = refusalOf(e);
      if (!refusal) return false;
      const now = this.#now();
      this.d.signals?.opsIntakeRefused?.(target);
      const counted = await this.d.store.markRefused(row, key, refusal, now, OPS_REFUSAL_LIMIT);
      if (counted?.failed) {
        this.d.log?.opsIntakeRefused?.({ target, eventKey, kind, refusal, count: counted.refusedCount, at: now });
        this.d.signals?.opsIntakeFailed?.(target, await this.d.store.countIntakeFailed(row));
      }
      return false;
    }
  }

  /** 지급일 계산에 쓰는 기본값. 시험·운영이 같은 함수를 쓴다. */
  payoutDateFor(now: Date): string {
    return dateOnly(addBusinessDays(now, 5));
  }
}
