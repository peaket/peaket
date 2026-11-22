// 정산서·지급 묶음·KYC 도메인(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·POL-039, ADR-0047·0062·0101).
// 금액 식과 상태 전이는 docs/features/settlement.md §4·§5·§6, 표는 docs/data.md settlement_statement…payout.
export type Pg = 'TOSS' | 'PORTONE';
export type PgStore = 'STANDARD' | 'ESCROW';
export type StatementKind = 'EVENT' | 'PRODUCT';
export type StatementStatus = 'CALCULATED' | 'NOTIFIED' | 'DISPUTED' | 'CONFIRMED' | 'HELD' | 'SCHEDULED' | 'FAILED' | 'PAID' | 'CARRIED_OVER' | 'SUPERSEDED';
export type HoldReason = 'KYC' | 'ACCOUNT_CHANGE' | 'BALANCE' | 'ACCOUNT_MISMATCH' | 'SALE_SUSPENDED';
export type DisputeReasonCode = 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER';
export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';
/** 토스페이먼츠 셀러 상태(settlement §3·§6). PARTIALLY_APPROVED는 KYC 예고 대상이다. */
export type TossSellerStatus = 'PENDING' | 'PARTIALLY_APPROVED' | 'APPROVED' | 'KYC_REQUIRED' | 'REJECTED';
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
}

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
  createdAt: Date;
  updatedAt: Date;
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
  const candidates = input.payments.filter((p) => p.status === 'APPROVED' || p.status === 'PARTIAL_CANCELED' || p.status === 'CANCELED');
  const excludedPayments = candidates.filter((p) => p.excludedReason).map((p) => `${p.paymentId}:${p.excludedReason}`);
  const included = candidates.filter((p) => !p.excludedReason);
  // CANCELED는 전액 취소라 매출 0이고 환급은 원금 전액이다. cancelled_amount가 비어 있어도 원금을 환급으로 센다(A1-H3).
  const grossOf = (p: PaymentFact): number => (p.status === 'CANCELED' ? 0 : p.amount);
  const refundOf = (p: PaymentFact): number => (p.status === 'CANCELED' ? Math.max(p.cancelledAmount, p.amount) : p.cancelledAmount);
  const grossAmount = included.reduce((s, p) => s + grossOf(p), 0);
  const refundAmount = included.reduce((s, p) => s + refundOf(p), 0);
  const commissionAmount = Math.floor((Math.max(0, grossAmount - refundAmount) * input.commissionRateBp) / 10_000);
  const commissionVat = Math.floor(commissionAmount / 10);
  const offsetAmount = 0;
  const payoutAmount = Math.max(0, grossAmount - refundAmount - commissionAmount - commissionVat - offsetAmount);
  const kycVerified = input.kyc?.status === 'VERIFIED' && input.kyc.businessVerified && input.kyc.representativeVerified;
  const status: StatementStatus = payoutAmount <= 0 ? 'CARRIED_OVER' : kycVerified ? 'NOTIFIED' : 'HELD';
  const holdReason: HoldReason | null = status === 'HELD' ? 'KYC' : null;
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
      disputeDueAt: addBusinessDays(input.now, 2),
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
  const payoutAmount = Math.max(0, grossAmount - refundAmount - commissionAmount - commissionVat - offsetAmount);
  const kycVerified = input.kyc?.status === 'VERIFIED' && input.kyc.businessVerified && input.kyc.representativeVerified;
  const status: StatementStatus = payoutAmount <= 0 ? 'CARRIED_OVER' : kycVerified ? 'NOTIFIED' : 'HELD';
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
      holdReason: status === 'HELD' ? 'KYC' : null,
      disputeDueAt: addBusinessDays(input.now, 2),
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
