// 정산서·지급 묶음·KYC 도메인(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·POL-039, ADR-0047·0062·0101).
// 금액 식과 상태 전이는 docs/features/settlement.md §4·§5·§6, 표는 docs/data.md settlement_statement…payout.
export type Pg = 'TOSS' | 'PORTONE';
export type PgStore = 'STANDARD' | 'ESCROW';
export type StatementKind = 'EVENT' | 'PRODUCT';
export type StatementStatus = 'CALCULATED' | 'NOTIFIED' | 'DISPUTED' | 'CONFIRMED' | 'HELD' | 'SCHEDULED' | 'FAILED' | 'PAID' | 'CARRIED_OVER' | 'SUPERSEDED';
export type HoldReason = 'KYC' | 'ACCOUNT_CHANGE' | 'BALANCE' | 'ACCOUNT_MISMATCH' | 'SALE_SUSPENDED';
export type DisputeReasonCode = 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER';
export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';
export type PayoutBatchStatus = 'PREPARED' | 'PENDING_APPROVAL' | 'APPROVED' | 'SUBMITTED' | 'COMPLETED' | 'PARTIAL_FAILED';
export type PayoutStatus = 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED';

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
}

export interface KycRecord {
  promoterId: string;
  status: KycStatus;
  businessVerified: boolean;
  representativeVerified: boolean;
  verifiedAt: Date | null;
  source: string;
  updatedAt: Date;
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

export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

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
  statementId: string;
}

/** 회차 정산서 한 판. 판매 대금은 승인 결제의 원금, 환급은 취소된 금액이다(settlement §4.1). */
export function calculateEventStatement(input: EventCalculationInput): { record: StatementRecord; sources: StatementSource[] } {
  if (!Number.isInteger(input.commissionRateBp) || input.commissionRateBp < 0 || input.commissionRateBp > 10000) {
    throw new SettlementProblem('settlement-commission-rate-invalid', 422, '수수료율이 맞지 않습니다');
  }
  const included = input.payments.filter((p) => p.status === 'APPROVED' || p.status === 'PARTIAL_CANCELED' || p.status === 'CANCELED');
  const grossAmount = included.reduce((s, p) => s + p.amount, 0);
  const refundAmount = included.reduce((s, p) => s + p.cancelledAmount, 0);
  const commissionAmount = Math.floor((Math.max(0, grossAmount - refundAmount) * input.commissionRateBp) / 10_000);
  const commissionVat = Math.floor(commissionAmount / 10);
  const offsetAmount = 0;
  const payoutAmount = grossAmount - refundAmount - commissionAmount - commissionVat - offsetAmount;
  const kycVerified = input.kyc?.status === 'VERIFIED' && input.kyc.businessVerified && input.kyc.representativeVerified;
  const status: StatementStatus = payoutAmount <= 0 ? 'CARRIED_OVER' : kycVerified ? 'NOTIFIED' : 'HELD';
  const holdReason: HoldReason | null = status === 'HELD' ? 'KYC' : null;
  const sources: StatementSource[] = [];
  for (const p of included) {
    sources.push({ statementId: input.statementId, sourceId: p.paymentId, kind: 'GROSS', paymentId: p.paymentId, amount: p.amount });
    if (p.cancelledAmount > 0) sources.push({ statementId: input.statementId, sourceId: p.paymentId, kind: 'REFUND', paymentId: p.paymentId, amount: p.cancelledAmount });
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
      excludedPayments: [],
      status,
      holdReason,
      disputeDueAt: addBusinessDays(input.now, 2),
      payoutDate: dateOnly(addBusinessDays(input.now, 5)),
      payoutBankCode: input.account?.bankCode ?? null,
      payoutAccountLast4: input.account?.accountLast4 ?? null,
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
