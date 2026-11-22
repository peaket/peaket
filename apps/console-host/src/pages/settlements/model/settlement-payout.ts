// SCR-049 정산 지급 연결 화면의 순수 부분(BAT-630 LCH-110, d5 §7.10, settlement §9).
// 역할 판정·금액·날짜·승인 기한·API 응답을 화면 모양으로 바꾸는 함수만 둔다.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';

export type LoadKind = 'loading' | 'ready' | 'config' | 'forbidden' | 'error';

export interface BatchRow {
  batchId: string;
  pg: 'TOSS' | 'PORTONE';
  pgStore: 'STANDARD' | 'ESCROW';
  payoutDate: string;
  totalAmount: number;
  statementCount: number;
  status: string;
  approvalId: string | null;
  approvalDueAt: string | null;
  portoneBulkPayoutId: string | null;
}

export interface StatementRow {
  statementId: string;
  kind: 'EVENT' | 'PRODUCT';
  eventId: string | null;
  pg: 'TOSS' | 'PORTONE';
  pgStore: 'STANDARD' | 'ESCROW';
  grossAmount: number;
  refundAmount: number;
  commissionAmount: number;
  commissionVat: number;
  offsetAmount: number;
  payoutAmount: number;
  status: string;
  holdReason: string | null;
  payoutDate: string | null;
  payoutBankCode: string | null;
  payoutAccountLast4: string | null;
  payoutBatchId: string | null;
}

export interface PayoutRow {
  payoutId: string;
  statementId: string;
  seq: number;
  amount: number;
  refPayoutId: string;
  pgPayoutId: string | null;
  status: string;
  errorCode: string | null;
  transferCheck: string | null;
}

export interface KycNoticeRow {
  promoterId: string;
  sellerStatus: string;
  from: string;
  to: string;
  amount: number;
  threshold: number;
  notice: boolean;
}

export interface ReceivableRow {
  receivableId: string;
  promoterId: string;
  pg: 'TOSS' | 'PORTONE' | null;
  cause: string;
  amount: number;
  remaining: number;
  status: string;
  createdAt?: string;
}

export interface BatchDetail {
  batch: BatchRow;
  statements: StatementRow[];
  payouts: PayoutRow[];
  holds: StatementRow[];
  kycNotices: KycNoticeRow[];
}

export interface ApprovalRow {
  approvalId: string;
  kind: string;
  targetRef: string;
  amount: number;
  status: string;
  requestedBy?: { adminAccountId?: string; role?: string } | undefined;
  requestedAt: string;
  dueAt: string | null;
  canApprove: boolean;
}

export function canRead(role: ConsoleRole | null | undefined): boolean {
  return role !== 'cs_agent' && role !== 'cs_lead';
}

export function canRequest(role: ConsoleRole | null | undefined): boolean {
  return role === 'operator' || role === 'commander';
}

export function canRecordExecution(role: ConsoleRole | null | undefined): boolean {
  return role === 'operator' || role === 'commander';
}

export function canApprove(role: ConsoleRole | null | undefined): boolean {
  return role === 'commander';
}

export function won(n: number | null | undefined): string {
  return `₩${Number(n ?? 0).toLocaleString('ko-KR')}`;
}

export function formatKst(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function formatDateKst(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium' }).format(d);
}

/** 지급일 전 영업일 15시(KST). 서버 approvalDueAt과 같은 규칙이다(settlement §5.1). */
export function approvalDueAt(payoutDate: string): string {
  const [y, m, d] = payoutDate.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  do {
    base.setUTCDate(base.getUTCDate() - 1);
  } while (base.getUTCDay() === 0 || base.getUTCDay() === 6);
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T15:00:00+09:00`;
}

export function remainingText(dueAt: string | null, now = new Date()): string {
  if (!dueAt) return '승인 기한 없음';
  const left = Date.parse(dueAt) - now.getTime();
  if (Number.isNaN(left)) return '승인 기한 없음';
  if (left <= 0) return '승인 기한 지남';
  const minutes = Math.floor(left / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}일 ${hours % 24}시간 남음`;
  return `${hours}시간 ${minutes % 60}분 남음`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function mapBatch(raw: Record<string, unknown>): BatchRow {
  const pg = raw.pg === 'PORTONE' ? 'PORTONE' : 'TOSS';
  return {
    batchId: str(raw.batchId),
    pg,
    pgStore: raw.pgStore === 'ESCROW' ? 'ESCROW' : 'STANDARD',
    payoutDate: str(raw.payoutDate),
    totalAmount: num(raw.totalAmount),
    statementCount: num(raw.statementCount),
    status: str(raw.status),
    approvalId: nullableStr(raw.approvalId),
    approvalDueAt: nullableStr(raw.approvalDueAt) ?? (str(raw.payoutDate) ? approvalDueAt(str(raw.payoutDate)) : null),
    portoneBulkPayoutId: nullableStr(raw.portoneBulkPayoutId),
  };
}

export function mapStatement(raw: Record<string, unknown>): StatementRow {
  return {
    statementId: str(raw.statementId),
    kind: raw.kind === 'PRODUCT' ? 'PRODUCT' : 'EVENT',
    eventId: nullableStr(raw.eventId),
    pg: raw.pg === 'PORTONE' ? 'PORTONE' : 'TOSS',
    pgStore: raw.pgStore === 'ESCROW' ? 'ESCROW' : 'STANDARD',
    grossAmount: num(raw.grossAmount),
    refundAmount: num(raw.refundAmount),
    commissionAmount: num(raw.commissionAmount),
    commissionVat: num(raw.commissionVat),
    offsetAmount: num(raw.offsetAmount),
    payoutAmount: num(raw.payoutAmount),
    status: str(raw.status),
    holdReason: nullableStr(raw.holdReason),
    payoutDate: nullableStr(raw.payoutDate),
    payoutBankCode: nullableStr(raw.payoutBankCode),
    payoutAccountLast4: nullableStr(raw.payoutAccountLast4),
    payoutBatchId: nullableStr(raw.payoutBatchId),
  };
}

export function mapPayout(raw: Record<string, unknown>): PayoutRow {
  return {
    payoutId: str(raw.payoutId),
    statementId: str(raw.statementId),
    seq: num(raw.seq),
    amount: num(raw.amount),
    refPayoutId: str(raw.refPayoutId),
    pgPayoutId: nullableStr(raw.pgPayoutId),
    status: str(raw.status),
    errorCode: nullableStr(raw.errorCode),
    transferCheck: nullableStr(raw.transferCheck),
  };
}

export function mapBatchDetail(raw: Record<string, unknown>): BatchDetail {
  return {
    batch: mapBatch((raw.batch ?? {}) as Record<string, unknown>),
    statements: Array.isArray(raw.statements) ? raw.statements.map((x) => mapStatement(x as Record<string, unknown>)) : [],
    payouts: Array.isArray(raw.payouts) ? raw.payouts.map((x) => mapPayout(x as Record<string, unknown>)) : [],
    holds: Array.isArray(raw.holds) ? raw.holds.map((x) => mapStatement(x as Record<string, unknown>)) : [],
    kycNotices: Array.isArray(raw.kycNotices)
      ? raw.kycNotices.map((x) => {
          const o = x as Record<string, unknown>;
          return { promoterId: str(o.promoterId), sellerStatus: str(o.sellerStatus), from: str(o.from), to: str(o.to), amount: num(o.amount), threshold: num(o.threshold), notice: o.notice === true };
        })
      : [],
  };
}

export function mapApproval(raw: Record<string, unknown>): ApprovalRow {
  return {
    approvalId: str(raw.approvalId),
    kind: str(raw.kind),
    targetRef: str(raw.targetRef),
    amount: num(raw.amount),
    status: str(raw.status),
    requestedBy: (raw.requestedBy ?? undefined) as ApprovalRow['requestedBy'],
    requestedAt: str(raw.requestedAt),
    dueAt: nullableStr(raw.dueAt),
    canApprove: raw.canApprove === true,
  };
}

export function mapReceivable(raw: Record<string, unknown>): ReceivableRow {
  return {
    receivableId: str(raw.receivableId),
    promoterId: str(raw.promoterId),
    pg: raw.pg === 'TOSS' || raw.pg === 'PORTONE' ? raw.pg : null,
    cause: str(raw.cause),
    amount: num(raw.amount),
    remaining: num(raw.remaining),
    status: str(raw.status),
    ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
  };
}

export function holdLabel(reason: string | null): string {
  switch (reason) {
    case 'KYC':
      return 'KYC 필요';
    case 'ACCOUNT_CHANGE':
      return '정산 계좌 변경 보류';
    case 'BALANCE':
      return '결제사 잔액 부족';
    case 'ACCOUNT_MISMATCH':
      return '포트원 계좌 불일치';
    case 'SALE_SUSPENDED':
      return '판매 중지';
    default:
      return reason ?? '보류';
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'PENDING_APPROVAL':
      return '승인 대기';
    case 'APPROVED':
      return '승인됨';
    case 'SUBMITTED':
      return '지급 요청됨';
    case 'COMPLETED':
      return '지급 완료';
    case 'PARTIAL_FAILED':
      return '일부 실패';
    case 'PREPARED':
      return '준비';
    case 'CONFIRMED':
      return '확정';
    case 'HELD':
      return '보류';
    case 'SCHEDULED':
      return '예약됨';
    case 'FAILED':
      return '실패';
    case 'PAID':
      return '지급됨';
    default:
      return status;
  }
}
