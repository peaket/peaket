// 정산서·지급 묶음·KYC 도메인(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·POL-039, ADR-0047·0062·0101).
// 금액 식과 상태 전이는 docs/features/settlement.md §4·§5·§6, 표는 docs/data.md settlement_statement…payout.
import { createHash } from 'node:crypto';

export type Pg = 'TOSS' | 'PORTONE';
export type PgStore = 'STANDARD' | 'ESCROW';
export type StatementKind = 'EVENT' | 'PRODUCT';
export type StatementStatus = 'CALCULATED' | 'NOTIFIED' | 'DISPUTED' | 'CONFIRMED' | 'HELD' | 'SCHEDULED' | 'FAILED' | 'PAID' | 'CARRIED_OVER' | 'SUPERSEDED';
export type HoldReason = 'KYC' | 'ACCOUNT_CHANGE' | 'BALANCE' | 'ACCOUNT_MISMATCH' | 'SALE_SUSPENDED';
export type DisputeReasonCode = 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER';
export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';
/** 토스페이먼츠 셀러 상태(settlement §3·§6, ADR-0369 결정 3). PARTIALLY_APPROVED는 KYC 예고 대상이고, 묶을 수 있는 상태는 PARTIALLY_APPROVED·APPROVED다. */
export type TossSellerStatus = 'PENDING' | 'APPROVAL_REQUIRED' | 'PARTIALLY_APPROVED' | 'APPROVED' | 'KYC_REQUIRED' | 'REJECTED';
export const TOSS_SELLER_STATUSES: readonly TossSellerStatus[] = ['PENDING', 'APPROVAL_REQUIRED', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED'];
/** 지급 건 FAILED의 갈래(settlement §12) */
export type PayoutFailureClass = 'ACCOUNT' | 'TRANSIENT' | 'LIMIT_KYC' | 'UNKNOWN';
/** 지급 쪽 CS 건 요청 종류(payment 0029 settlement_case_request, ADR-0369 결정 10) */
export type SettlementCaseKind = 'PAYOUT_ERROR' | 'PAYOUT_FAILED' | 'PAYOUT_DELAYED' | 'SELLER_KYC_REQUIRED' | 'PG_BALANCE_MISMATCH' | 'PORTONE_PAYOUT_EXECUTION' | 'PORTONE_LEDGER_MISMATCH';
/** ops 받기의 거절 까닭(F-07-7 계획 §5.1 (파) (마)). 일시 실패(연결·401·429·5xx)는 세지 않는다 */
export type OpsRefusal = 'NOT_ACCEPTED' | 'HTTP_400' | 'HTTP_422';
/** 지급대행 결제사 셋(ADR-0370 결정 1) */
export type PayoutAgency = 'PORTONE' | 'TOSS_STANDARD' | 'TOSS_ESCROW';
export type PayoutAgencyOutcome = 'REGISTERED' | 'UPDATED' | 'SKIPPED' | 'FAILED';
export type PayoutAgencyResults = Record<PayoutAgency, PayoutAgencyOutcome>;
export type GuaranteeKind = 'DEPOSIT' | 'PERFORMANCE_BOND';
export type PayoutBatchStatus = 'PREPARED' | 'PENDING_APPROVAL' | 'APPROVED' | 'SUBMITTED' | 'COMPLETED' | 'PARTIAL_FAILED';
export type PayoutStatus = 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED';
export type ReceivableCause = 'REFUND_AFTER_PAYOUT' | 'CHARGEBACK' | 'COMPENSATION_ADVANCE' | 'NEGATIVE_STATEMENT';
export type ReceivableStatus = 'OPEN' | 'OFFSET' | 'GUARANTEE' | 'BILLED' | 'CLOSED' | 'WRITTEN_OFF';

export interface ReceivableRecord {
  receivableId: string;
  promoterId: string;
  /** 돈이 빠진 결제사. COMPENSATION_ADVANCE(배상금 미리 지급)는 결제사 무관이라 null이다(ADR-0317) */
  pg: Pg | null;
  cause: ReceivableCause;
  /** 원래 회차. 상품 환급은 null */
  eventId?: string | null;
  /** 원천 참조. 배상은 `compensation:{id}`이고 부분 유일 인덱스의 재료다(0024) */
  sourceRef?: string | null;
  amount: number;
  remaining: number;
  status: ReceivableStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReceivableMoveRecord {
  /** 0026부터 이동마다 하나. 기존 코드는 생략하고 저장소가 채운다 */
  moveId?: string;
  receivableId: string;
  statementId: string;
  amount: number;
  kind?: 'OFFSET' | 'GUARANTEE' | 'COLLECTED' | 'WRITE_OFF' | 'REVERSAL';
  movedAt: Date;
}

export class SettlementProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'SettlementProblem';
  }
}

export interface PaymentFact {
  paymentId: string;
  amount: number;
  cancelledAmount: number;
  status: string;
  failureCategory: string | null;
  /** 대사가 끝나지 않았으면 그 이유. 있으면 정산서 계산에서 빼고 excludedPayments에 남긴다(A1-H8). */
  excludedReason?: string | null;
  /**
   * 결제 원장의 승인 시각(payment.approved_at). 없는(null) CANCELED는 승인된 적 없이 대사가 닫은 취소라 판매 대금·환급·원본 목록 어디에도 넣지 않는다
   * (settlement §4.1 '전액 취소된 결제', F-07-5 리뷰 RV-01, A1-H3의 원래 경우).
   */
  approvedAt?: Date | null;
}

/**
 * 지급액 식 하나(settlement §4.1 지급액 칸·§4.3 '적용', F-07-5 리뷰 RV-02): 판매 대금 − 환급 − 중개수수료 − 수수료 부가세 − 상계 + 조정 합계.
 * 계산·상품 계산·조정 적용·묶음 상계가 모두 이 함수를 쓴다. 0에서 자르지 않는다(0 아래는 감액 조정뿐이고 확정 때 CARRIED_OVER·NEGATIVE_STATEMENT가 된다).
 */
export const payoutAmountOf = (s: { grossAmount: number; refundAmount: number; commissionAmount: number; commissionVat: number; offsetAmount: number; adjustmentAmount?: number | undefined }): number =>
  s.grossAmount - s.refundAmount - s.commissionAmount - s.commissionVat - s.offsetAmount + (s.adjustmentAmount ?? 0);

export interface KycRecord {
  promoterId: string;
  status: KycStatus;
  businessVerified: boolean;
  representativeVerified: boolean;
  /** 사업자 상호·대표자 이름. 예금주 대조에만 쓰고 계좌번호와 함께 저장하지 않는다(A1-H7). */
  legalName?: string | null;
  representative?: string | null;
  verifiedAt: Date | null;
  source: string;
  updatedAt: Date;
  /** 토스 셀러 ID와 상태. seller.changed 웹훅이 상태를 바꾸고 KYC 예고가 이 값을 본다(0026) */
  tossSellerId?: string | null;
  tossSellerStatus?: TossSellerStatus;
}

export interface PayoutAccountRecord {
  promoterId: string;
  bankCode: string;
  accountLast4: string;
  version: number;
  changedAt: Date;
  holdUntil: Date;
  holderVerified: boolean;
  /** 결제사 수정 대기(payment 0030, ADR-0370 결정 5). 없으면 false로 읽는다(옛 행·고정된 F-07-6 시험) */
  agencySyncPending?: boolean;
}

/** 정산 계좌 변경 시도 한 번(payment 0030 payout_account_change, 덧붙이기만). 계좌번호·예금주명은 없다 */
export interface PayoutAccountChangeRecord {
  id: string;
  promoterId: string;
  actorAccountId: string;
  reauthJti: string;
  result: 'ACCEPTED' | 'HOLDER_MISMATCH' | 'AGENCY_FAILED';
  bankCode: string;
  accountLast4: string;
  /** ACCEPTED·AGENCY_FAILED만 */
  holdUntil: Date | null;
  agencyResults: PayoutAgencyResults;
  /** 재인증 토큰이 거친 요소(감사 본문 reauthFactors) */
  reauthFactors?: readonly string[];
  createdAt: Date;
  auditSentAt: Date | null;
  auditRefusedCount: number;
  auditFailedAt: Date | null;
}

/** 포트원 파트너 등록(payment 0030 portone_partner). 계좌번호는 없다 */
export interface PortonePartnerRecord {
  promoterId: string;
  portonePartnerId: string;
  contractId: string;
  registeredAt: Date;
  accountUpdatedAt: Date;
  lastAccountCheck: 'MATCHED' | 'MISMATCH' | null;
  lastAccountCheckedAt: Date | null;
  updatedAt: Date;
}

/** 포트원 이체 원장의 출금 하나(payment 0032 portone_transfer). 계좌번호 전체·예금주명은 없다 */
export interface PortoneTransferRecord {
  transferId: string;
  withdrawalType: string | null;
  payoutId: string | null;
  amount: number;
  bankCode: string | null;
  accountLast4: string | null;
  holderMatched: boolean | null;
  checkResult: 'MATCHED' | 'MISMATCH' | 'UNLINKED';
  transferredAt: Date;
  checkedAt: Date;
}

export type PortoneLedgerSyncName = 'WITHDRAWAL' | 'PARTNER_ACCOUNT';

/** 포트원 사후 대사 진행(payment 0032 portone_ledger_sync) */
export interface PortoneLedgerSyncRecord {
  name: PortoneLedgerSyncName;
  lastSuccessAt: Date | null;
  readThrough: Date | null;
  /** 'YYYY-MM-DD'(KST) */
  haltedOn: string | null;
  updatedAt: Date;
}

/** 운영 경보 요청(payment 0032 settlement_alert_request). 원인 쓰기와 같은 트랜잭션에 넣고 정산 일꾼이 보낸 뒤 requestedAt을 채운다 */
export interface SettlementAlertRequestRecord {
  eventKey: string;
  kind: string;
  severity: 'SEV2' | 'SEV3';
  sourceId: string;
  createdAt: Date;
  requestedAt: Date | null;
  refusedCount: number;
  failedAt: Date | null;
  lastRefusal: OpsRefusal | null;
}

export interface StatementRecord {
  statementId: string;
  promoterId: string;
  kind: StatementKind;
  eventId: string | null;
  pg: Pg;
  pgStore: PgStore;
  periodStart: string | null;
  periodEnd: string | null;
  grossAmount: number;
  refundAmount: number;
  commissionAmount: number;
  commissionVat: number;
  offsetAmount: number;
  payoutAmount: number;
  revision: number;
  supersedesId: string | null;
  excludedPayments: string[];
  status: StatementStatus;
  holdReason: HoldReason | null;
  disputeDueAt: Date | null;
  payoutDate: string | null;
  payoutBankCode: string | null;
  payoutAccountLast4: string | null;
  /** 이 정산서를 지급하는 묶음. 승인 시점에 묶여 실행은 이 목록만 지급한다(CONS-02). */
  payoutBatchId: string | null;
  /** 적용한 수기 조정의 합계(payment 0027, settlement §4.3). 없으면 0이다. 지급액 = 판매 대금 − 환급 − 수수료 − 부가세 − 상계 + 조정 합계 */
  adjustmentAmount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatementSource {
  statementId: string;
  sourceId: string;
  kind: 'GROSS' | 'REFUND';
  paymentId: string;
  amount: number;
}

export interface DisputeRecord {
  disputeId: string;
  statementId: string;
  reasonCode: DisputeReasonCode;
  detail: string;
  submittedBy: string;
  submittedAt: Date;
  result: 'ADJUSTED' | 'DISMISSED' | null;
  resolvedAt: Date | null;
  /** 기각·인정한 사람(관리 계정 ID, payment 0027) */
  resolvedBy?: string | null;
  /** 기각 사유(1~2,000자, payment 0027). 이의 인정은 조정 행이 근거다 */
  resolutionNote?: string | null;
  /** ops-svc CS 처리함 '정산 이의' 건을 연 시각(payment 0027). 비었으면 정산 일꾼이 다시 보낸다 */
  caseRequestedAt?: Date | null;
  /** ops 거절 횟수·영구 실패 시각(payment 0030, F-07-7 계획 §5.1 (파) (마)) */
  caseRefusedCount?: number;
  caseFailedAt?: Date | null;
}

/** 정산서 상태 전이 감사(A1V-12). 돈이 나가는 전이의 사유·행위자·이전 상태를 남긴다. */
export interface StatementAuditRecord {
  auditId: string;
  statementId: string;
  fromStatus: StatementStatus;
  toStatus: StatementStatus;
  reason: string;
  actor: string;
  createdAt: Date;
}

export interface PayoutBatchRecord {
  batchId: string;
  pg: Pg;
  pgStore: PgStore;
  payoutDate: string;
  totalAmount: number;
  statementCount: number;
  approvalId: string | null;
  portoneBulkPayoutId: string | null;
  pgBalanceKrw: number | null;
  pgBalanceSource: 'PG_API' | 'OPERATOR_CONSOLE' | null;
  pgBalanceObservedAt: Date | null;
  pgBalanceObservedBy: string | null;
  pgBalanceLedgerKrw: number | null;
  status: PayoutBatchStatus;
  /** 토스 전송 시도 수·다음 전송 시각·자동 전송 마감·마지막 전송 결과 이름표·날짜 오류 한 번 재요청을 썼는지(payment 0029, ADR-0369 결정 7) */
  submitAttempts: number;
  nextSubmitAt: Date | null;
  submitDeadlineAt: Date | null;
  lastSubmitError: string | null;
  dateRetryUsed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayoutRecord {
  payoutId: string;
  batchId: string;
  statementId: string;
  seq: number;
  amount: number;
  refPayoutId: string;
  pgPayoutId: string | null;
  status: PayoutStatus;
  errorCode: string | null;
  pgTransferId: string | null;
  transferCheck: 'MATCHED' | 'MISMATCH' | 'MISSING' | null;
  transferCheckedAt: Date | null;
  /** 이 지급 건을 예약한 지급일·실패 갈래·대신한 실패 지급 건·같은 줄기의 자동 재요청 수(payment 0029, ADR-0369 결정 8) */
  payoutDate: string;
  failureClass: PayoutFailureClass | null;
  retryOfPayoutId: string | null;
  autoRetryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 파트너·결제 상점의 토스 셀러 한 행(payment 0029 toss_seller, ADR-0369 결정 3). 계좌번호는 두지 않는다 */
export interface TossSellerRecord {
  promoterId: string;
  pgStore: PgStore;
  tossSellerId: string;
  refSellerId: string;
  status: TossSellerStatus;
  businessType: 'INDIVIDUAL_BUSINESS' | 'CORPORATE';
  registeredAt: Date;
  statusCheckedAt: Date;
  updatedAt: Date;
}

/** 지급 쪽 CS 처리함 건 요청(payment 0029 settlement_case_request). 원인 쓰기와 같은 트랜잭션에 넣고, 정산 일꾼이 보낸 뒤 requestedAt을 채운다 */
export interface SettlementCaseRequestRecord {
  eventKey: string;
  kind: SettlementCaseKind;
  sourceId: string;
  createdAt: Date;
  requestedAt: Date | null;
  /** 건 본문 글(선택, 1~2,000자, payment 0030). 다시 보낼 때 같은 글을 싣는다 */
  detail?: string | null;
  refusedCount?: number;
  failedAt?: Date | null;
  lastRefusal?: OpsRefusal | null;
}

/** 지급 건 재요청 기록(payment 0029 payout_retry_audit, 덧붙이기만) */
export interface PayoutRetryAuditRecord {
  auditId: string;
  payoutId: string;
  newPayoutId: string;
  oldSeq: number;
  newSeq: number;
  actor: string;
  reason: PayoutFailureClass | 'DATE_ERROR';
  createdAt: Date;
}

/** 결제사 잔액 대사 한 번(payment 0029 pg_balance_reconciliation, settlement §5.5, ADR-0369 결정 11) */
export interface PgBalanceReconciliationRecord {
  reconciliationId: string;
  pg: Pg;
  pgStore: PgStore;
  kind: 'MONTHLY' | 'BATCH';
  /** MONTHLY만. 그 달 1일('YYYY-MM-01') */
  periodMonth: string | null;
  /** BATCH만 */
  batchId: string | null;
  cutoffAt: Date;
  approvedAmount: number;
  refundedAmount: number;
  pgFeeAmount: number;
  paidOutAmount: number;
  peaketWithdrawnAmount: number;
  expectedAmount: number;
  observedAmount: number;
  diffAmount: number;
  severity: 'NONE' | 'CASE' | 'SEV3';
  createdAt: Date;
}

/** 보증 충당 한 건(payment 0026). 멱등 키가 유일하고, 같은 키 재요청은 이 행을 그대로 돌려준다. */
export interface GuaranteeCollectionRecord {
  collectionId: string;
  idempotencyKey: string;
  receivableId: string;
  promoterId: string;
  guaranteeKind: GuaranteeKind;
  /** 충당한 금액 */
  amount: number;
  /** 보증 한도를 계산한 기준(그 미수금 근거 정산서의 판매 대금) */
  basisAmount: number;
  guaranteeRateBp: number;
  actor: string;
  reason: string;
  createdAt: Date;
}

/** KYC 예고 한 건(settlement §6, J-T19). notice=false도 화면이 이유를 보일 수 있게 함께 답한다. */
export interface KycNotice {
  promoterId: string;
  sellerStatus: TossSellerStatus;
  from: string;
  to: string;
  amount: number;
  threshold: number;
  notice: boolean;
}

/** SCR-049 묶음 상세. 묶인 정산서·지급 건·같은 지급일의 HELD 정산서·KYC 예고를 함께 준다. */
export interface PayoutBatchDetail {
  batch: ReturnType<typeof payoutBatchView>;
  statements: StatementView[];
  payouts: PayoutRecord[];
  holds: StatementView[];
  kycNotices: KycNotice[];
}

/** 지급 묶음 승인 감사(payment 0025). 돈이 움직이는 승인의 성공·거절을 배치와 같은 트랜잭션(성공)이나 따로 남긴다. */
export interface PayoutBatchAuditRecord {
  auditId: string;
  batchId: string;
  approvalId: string;
  event: 'APPROVED' | 'REJECTED';
  reason: string;
  requesterId: string | null;
  approverId: string | null;
  amount: number | null;
  currency: string;
  createdAt: Date;
}

export interface StatementView {
  statementId: string;
  kind: StatementKind;
  eventId: string | null;
  pg: Pg;
  pgStore: PgStore;
  periodStart: string | null;
  periodEnd: string | null;
  grossAmount: number;
  refundAmount: number;
  commissionAmount: number;
  commissionVat: number;
  offsetAmount: number;
  payoutAmount: number;
  revision: number;
  supersedesId: string | null;
  excludedPayments: string[];
  status: StatementStatus;
  holdReason: HoldReason | null;
  disputeDueAt: string | null;
  payoutDate: string | null;
  payoutBankCode: string | null;
  payoutAccountLast4: string | null;
  payoutBatchId: string | null;
}

export const statementView = (s: StatementRecord): StatementView => ({
  statementId: s.statementId,
  kind: s.kind,
  eventId: s.eventId,
  pg: s.pg,
  pgStore: s.pgStore,
  periodStart: s.periodStart,
  periodEnd: s.periodEnd,
  grossAmount: s.grossAmount,
  refundAmount: s.refundAmount,
  commissionAmount: s.commissionAmount,
  commissionVat: s.commissionVat,
  offsetAmount: s.offsetAmount,
  payoutAmount: s.payoutAmount,
  revision: s.revision,
  supersedesId: s.supersedesId,
  excludedPayments: s.excludedPayments,
  status: s.status,
  holdReason: s.holdReason,
  disputeDueAt: s.disputeDueAt?.toISOString() ?? null,
  payoutDate: s.payoutDate,
  payoutBankCode: s.payoutBankCode,
  payoutAccountLast4: s.payoutAccountLast4,
  payoutBatchId: s.payoutBatchId,
});

export const payoutBatchView = (b: PayoutBatchRecord) => ({
  batchId: b.batchId,
  pg: b.pg,
  pgStore: b.pgStore,
  payoutDate: b.payoutDate,
  totalAmount: b.totalAmount,
  statementCount: b.statementCount,
  status: b.status,
  createdAt: b.createdAt.toISOString(),
  lastSubmitError: b.lastSubmitError ?? null,
  nextSubmitAt: b.nextSubmitAt?.toISOString() ?? null,
  submitDeadlineAt: b.submitDeadlineAt?.toISOString() ?? null,
  ...(b.approvalId ? { approvalId: b.approvalId } : {}),
  ...(b.portoneBulkPayoutId ? { portoneBulkPayoutId: b.portoneBulkPayoutId } : {}),
});

/** 은행 영업일(주말만 건너뛴다. 공휴일 달력은 후속, settlement §5.1) */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

export function subtractBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** 회차 정산 스케줄러의 Lease 이름. 리더 파드 하나만 하루 한 번 돈다. */
export const SETTLEMENT_DUE_LEASE_NAME = 'payment-settlement-due';

export interface EventCalculationInput {
  promoterId: string;
  eventId: string;
  pg: Pg;
  pgStore: PgStore;
  commissionRateBp: number;
  payments: readonly PaymentFact[];
  kyc: KycRecord | undefined;
  account: PayoutAccountRecord | undefined;
  now: Date;
  /** 회차 종료 시각. 있으면 지급일은 종료일 +5영업일이다(정본 §4.1·§5.1, A1V-02). */
  eventEndsAt?: string;
  statementId: string;
}

/** 회차 정산서 한 판. 판매 대금은 승인 결제의 원금, 환급은 취소된 금액이다(settlement §4.1). */
export function calculateEventStatement(input: EventCalculationInput): { record: StatementRecord; sources: StatementSource[] } {
  if (!Number.isInteger(input.commissionRateBp) || input.commissionRateBp < 0 || input.commissionRateBp > 10000) {
    throw new SettlementProblem('settlement-commission-rate-invalid', 422, '수수료율이 맞지 않습니다');
  }
  // 승인된 결제만 센다. 승인 시각이 없는 CANCELED(승인된 적 없이 대사가 닫은 취소)는 후보에서 뺀다(RV-01)
  const candidates = input.payments.filter((p) => p.status === 'APPROVED' || p.status === 'PARTIAL_CANCELED' || (p.status === 'CANCELED' && p.approvedAt != null));
  const excludedPayments = candidates.filter((p) => p.excludedReason).map((p) => `${p.paymentId}:${p.excludedReason}`);
  const included = candidates.filter((p) => !p.excludedReason);
  // 판매 대금은 승인된 결제의 원금이고 취소·환불은 빼지 않는다. 환급은 따로 센다: 승인 뒤 전액 취소(CANCELED)는 원금 전액,
  // 그 밖은 취소 금액(원금을 넘지 않음). 같은 돈을 판매 대금과 환급에서 두 번 빼지 않는다(settlement §4.1, F-07-5 리뷰 RV-01)
  const grossOf = (p: PaymentFact): number => p.amount;
  const refundOf = (p: PaymentFact): number => (p.status === 'CANCELED' ? p.amount : Math.min(Math.max(0, p.cancelledAmount), p.amount));
  const grossAmount = included.reduce((s, p) => s + grossOf(p), 0);
  const refundAmount = included.reduce((s, p) => s + refundOf(p), 0);
  const commissionAmount = Math.floor((Math.max(0, grossAmount - refundAmount) * input.commissionRateBp) / 10_000);
  const commissionVat = Math.floor(commissionAmount / 10);
  const offsetAmount = 0;
  const payoutAmount = payoutAmountOf({ grossAmount, refundAmount, commissionAmount, commissionVat, offsetAmount });
  // 계산 때는 KYC·계좌로 보류하지 않고 지급액 0도 통지한다. 보류는 지급 묶음 때(T7), CARRIED_OVER는 확정 때(T6) 한다(ADR-0368 결정 1·10).
  const status: StatementStatus = 'CALCULATED';
  const holdReason: HoldReason | null = null;
  const sources: StatementSource[] = [];
  for (const p of included) {
    if (grossOf(p) > 0) sources.push({ statementId: input.statementId, sourceId: p.paymentId, kind: 'GROSS', paymentId: p.paymentId, amount: grossOf(p) });
    if (refundOf(p) > 0) sources.push({ statementId: input.statementId, sourceId: p.paymentId, kind: 'REFUND', paymentId: p.paymentId, amount: refundOf(p) });
  }
  return {
    record: {
      statementId: input.statementId,
      promoterId: input.promoterId,
      kind: 'EVENT',
      eventId: input.eventId,
      pg: input.pg,
      pgStore: input.pgStore,
      periodStart: null,
      periodEnd: null,
      grossAmount,
      refundAmount,
      commissionAmount,
      commissionVat,
      offsetAmount,
      payoutAmount,
      revision: 1,
      supersedesId: null,
      excludedPayments,
      status,
      holdReason,
      // 이의 기한은 통지(같은 트랜잭션) 때 KST 공휴일 달력으로 정한다(business-calendar.ts)
      disputeDueAt: null,
      payoutDate: dateOnly(addBusinessDays(input.eventEndsAt ? new Date(input.eventEndsAt) : input.now, 5)),
      payoutBankCode: input.account?.bankCode ?? null,
      payoutAccountLast4: input.account?.accountLast4 ?? null,
      payoutBatchId: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    sources,
  };
}

export function validateDispute(reasonCode: string, detail: string | undefined): asserts reasonCode is DisputeReasonCode {
  const codes: readonly DisputeReasonCode[] = ['GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER'];
  if (!codes.includes(reasonCode as DisputeReasonCode)) throw new SettlementProblem('invalid-query', 400, '정산 이의 사유 코드가 맞지 않습니다');
  if (detail !== undefined && detail.length > 2000) throw new SettlementProblem('invalid-query', 400, '정산 이의 설명이 너무 깁니다');
  if (reasonCode === 'OTHER' && (!detail || detail.trim() === '')) throw new SettlementProblem('invalid-query', 422, '기타 사유는 설명이 필요합니다');
}

export function validatePayoutAccount(body: { bankCode: string; accountNumber: string; holderName: string }): void {
  if (!/^[0-9A-Z]{2,10}$/.test(body.bankCode)) throw new SettlementProblem('invalid-query', 422, '은행 코드가 맞지 않습니다');
  if (!/^\d{8,20}$/.test(body.accountNumber)) throw new SettlementProblem('invalid-query', 422, '계좌번호가 맞지 않습니다');
  if (body.holderName.trim().length === 0 || body.holderName.length > 100) throw new SettlementProblem('invalid-query', 422, '예금주가 맞지 않습니다');
}

export const accountLast4 = (accountNumber: string): string => accountNumber.slice(-4);

/** core-svc shop이 넘기는 상품 정산 원천 한 줄(settlement §4.5). */
export interface ProductSettlementItem {
  itemId: string;
  orderId: string;
  promoterId: string;
  eventId: string | null;
  pg: Pg;
  pgStore: PgStore;
  productId: string;
  productName: string;
  quantity: number;
  grossAmount: number;
  refundedAmount: number;
  commissionRateBp: number;
  basisDate: string;
  returnStatus: string;
  eventEndsAt: string | null;
}

export interface ProductCalculationInput {
  periodStart: string;
  periodEnd: string;
  items: readonly ProductSettlementItem[];
  kyc: KycRecord | undefined;
  account: PayoutAccountRecord | undefined;
  now: Date;
  statementId: string;
}

/**
 * 상품 정산서 한 판(settlement §4.5). 주문 항목마다 복사한 수수료율로 수수료를 계산하고,
 * 지급일은 계산일로부터 4영업일 뒤다(J-T18).
 */
export function calculateProductStatement(input: ProductCalculationInput): { record: StatementRecord; sources: StatementSource[] } {
  const grossAmount = input.items.reduce((s, i) => s + i.grossAmount, 0);
  const refundAmount = input.items.reduce((s, i) => s + i.refundedAmount, 0);
  const commissionAmount = input.items.reduce((s, i) => s + Math.floor((Math.max(0, i.grossAmount - i.refundedAmount) * i.commissionRateBp) / 10_000), 0);
  const commissionVat = Math.floor(commissionAmount / 10);
  const offsetAmount = 0;
  const payoutAmount = payoutAmountOf({ grossAmount, refundAmount, commissionAmount, commissionVat, offsetAmount });
  // 회차 정산서와 같이 계산 때는 보류하지 않는다(ADR-0368 결정 1)
  const status: StatementStatus = 'CALCULATED';
  const first = input.items[0]!;
  const sources: StatementSource[] = input.items.map((i) => ({ statementId: input.statementId, sourceId: i.itemId, kind: 'GROSS' as const, paymentId: i.itemId, amount: i.grossAmount }));
  return {
    record: {
      statementId: input.statementId,
      promoterId: first.promoterId,
      kind: 'PRODUCT',
      eventId: null,
      pg: first.pg,
      pgStore: first.pgStore,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      grossAmount,
      refundAmount,
      commissionAmount,
      commissionVat,
      offsetAmount,
      payoutAmount,
      revision: 1,
      supersedesId: null,
      excludedPayments: [],
      status,
      holdReason: null,
      disputeDueAt: null,
      payoutDate: dateOnly(addBusinessDays(input.now, 4)),
      payoutBankCode: input.account?.bankCode ?? null,
      payoutAccountLast4: input.account?.accountLast4 ?? null,
      payoutBatchId: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    sources,
  };
}

// ---- 통지·이의·확정 사건(trade.settlements, docs/api/asyncapi.yaml SettlementEvent, ADR-0368 결정 3) ----

/** 이의 기간(통지 시각 + 2영업일)과 다시 알림 기간(1영업일). 사람이 일하는 기한이라 KST 공휴일 달력으로 센다(settlement §4.2) */
export const DISPUTE_WINDOW_BUSINESS_DAYS = 2;
export const RENOTIFY_WINDOW_BUSINESS_DAYS = 1;

export const TRADE_SETTLEMENTS_TOPIC = 'trade.settlements';

export type SettlementEventType =
  | 'STATEMENT_NOTIFIED'
  | 'STATEMENT_DISPUTED'
  | 'STATEMENT_CONFIRMED'
  | 'STATEMENT_CARRIED_OVER'
  | 'RECEIVABLE_OPENED'
  | 'RECEIVABLE_CLOSED'
  | 'PAYOUT_SCHEDULED'
  | 'PAYOUT_COMPLETED'
  | 'PAYOUT_FAILED'
  | 'PAYOUT_HELD';

/** 지급 사건 종류(03 §2.12 T7·T9·T11·T12·T13, ADR-0369 결정 6). 금액 칸(amount)을 싣는다 */
export type PayoutEventType = 'PAYOUT_SCHEDULED' | 'PAYOUT_COMPLETED' | 'PAYOUT_FAILED' | 'PAYOUT_HELD';

/** asyncapi SettlementEvent의 칸(이 결정이 쓰는 종류만). 조건부 칸은 그 조건일 때만 싣는다 */
export interface SettlementEventValue {
  promoterId: string;
  statementId: string;
  kind: StatementKind;
  eventId?: string | null;
  pg: Pg;
  pgStore?: PgStore;
  periodStart?: string;
  periodEnd?: string;
  amount?: number;
  salesAmount?: number;
  refundAmount?: number;
  feeAmount?: number;
  revision?: number;
  supersedesId?: string | null;
  type: SettlementEventType;
  occurredAt: string;
  eventKey: string;
}

/** 내용에서 정한 UUID 꼴(sha256 앞 16바이트, 판 8·변형 RFC 4122). 같은 재료면 같은 값이라 다시 보내도 중복 제거된다 */
export function hashUuid(material: string): string {
  const b = createHash('sha256').update(material, 'utf8').digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 사건 중복 제거 키: sha256('<정산서 ID>:<사건 종류>:<전이 감사 ID>') 앞 16바이트(ADR-0368, F-07-5 계획 I-01) */
export const settlementEventKey = (statementId: string, type: SettlementEventType, auditId: string): string => hashUuid(`${statementId}:${type}:${auditId}`);

/** 정산서 상태 사건 한 건. STATEMENT_NOTIFIED는 판매 대금·환급·중개수수료·판본·옛 판을 싣는다 */
export function statementEvent(s: StatementRecord, type: Exclude<SettlementEventType, 'RECEIVABLE_OPENED' | 'RECEIVABLE_CLOSED' | PayoutEventType>, at: Date, auditId: string): SettlementEventValue {
  return {
    promoterId: s.promoterId,
    statementId: s.statementId,
    kind: s.kind,
    ...(s.kind === 'EVENT' ? { eventId: s.eventId } : {}),
    pg: s.pg,
    ...(s.pg === 'TOSS' ? { pgStore: s.pgStore } : {}),
    ...(s.kind === 'PRODUCT' && s.periodStart !== null && s.periodEnd !== null ? { periodStart: s.periodStart, periodEnd: s.periodEnd } : {}),
    ...(type === 'STATEMENT_NOTIFIED' ? { salesAmount: s.grossAmount, refundAmount: s.refundAmount, feeAmount: s.commissionAmount, revision: s.revision, supersedesId: s.supersedesId } : {}),
    type,
    occurredAt: at.toISOString(),
    eventKey: settlementEventKey(s.statementId, type, auditId),
  };
}

/** 확정 때 지급액이 0 아래인 정산서의 미수금(NEGATIVE_STATEMENT) 사건 */
export function receivableOpenedEvent(s: StatementRecord, amount: number, at: Date, auditId: string): SettlementEventValue {
  return {
    promoterId: s.promoterId,
    statementId: s.statementId,
    kind: s.kind,
    ...(s.kind === 'EVENT' ? { eventId: s.eventId } : {}),
    pg: s.pg,
    ...(s.pg === 'TOSS' ? { pgStore: s.pgStore } : {}),
    ...(s.kind === 'PRODUCT' && s.periodStart !== null && s.periodEnd !== null ? { periodStart: s.periodStart, periodEnd: s.periodEnd } : {}),
    amount,
    type: 'RECEIVABLE_OPENED',
    occurredAt: at.toISOString(),
    eventKey: settlementEventKey(s.statementId, 'RECEIVABLE_OPENED', auditId),
  };
}

/**
 * 지급 사건 한 건(PAYOUT_SCHEDULED·PAYOUT_COMPLETED·PAYOUT_FAILED·PAYOUT_HELD). 사건 키 재료는 전이 감사 ID(접수·보류)나 지급 건 ID(결과)다
 * (sha256('<정산서 ID>:<종류>:<재료>'), F-07-5 I-01과 같은 규칙)
 */
export function payoutEvent(s: StatementRecord, type: PayoutEventType, amount: number, at: Date, material: string): SettlementEventValue {
  return {
    promoterId: s.promoterId,
    statementId: s.statementId,
    kind: s.kind,
    ...(s.kind === 'EVENT' ? { eventId: s.eventId } : {}),
    pg: s.pg,
    ...(s.pg === 'TOSS' ? { pgStore: s.pgStore } : {}),
    ...(s.kind === 'PRODUCT' && s.periodStart !== null && s.periodEnd !== null ? { periodStart: s.periodStart, periodEnd: s.periodEnd } : {}),
    amount,
    type,
    occurredAt: at.toISOString(),
    eventKey: settlementEventKey(s.statementId, type, material),
  };
}

/** 묶음 상계로 남은 금액이 0이 된 미수금 사건(RECEIVABLE_CLOSED, 금액 = 그 미수금 금액). 정산서는 그 미수금을 닫은 정산서다 */
export function receivableClosedEvent(s: StatementRecord, receivable: Pick<ReceivableRecord, 'receivableId' | 'amount'>, at: Date): SettlementEventValue {
  return {
    promoterId: s.promoterId,
    statementId: s.statementId,
    kind: s.kind,
    ...(s.kind === 'EVENT' ? { eventId: s.eventId } : {}),
    pg: s.pg,
    ...(s.pg === 'TOSS' ? { pgStore: s.pgStore } : {}),
    amount: receivable.amount,
    type: 'RECEIVABLE_CLOSED',
    occurredAt: at.toISOString(),
    eventKey: settlementEventKey(s.statementId, 'RECEIVABLE_CLOSED', receivable.receivableId),
  };
}

/** 확정 때의 0 이하 미수금 근거(부분 유일 partner_receivable_source_ref_uidx로 한 행) */
export const negativeStatementSourceRef = (statementId: string): string => `negative-statement:${statementId}`;
