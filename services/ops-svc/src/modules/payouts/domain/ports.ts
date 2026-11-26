// 지급 승인 업무 저장·payment-svc 호출·재인증 포트.
import type { AuditChain } from '../../audit/index.js';
import type { AuditRecord } from '../../audit/audit.js';
import type { PayoutApprovalRecord, PayoutBatchDetailView, PayoutBatchView } from './payout-approval.js';

export interface PayoutApprovalStore {
  /** 상태 행과 감사 기록을 같은 트랜잭션에 쓴다(감사 기록이 있으면) */
  insert(record: PayoutApprovalRecord, audit?: AuditRecord): Promise<void>;
  find(approvalId: string): Promise<PayoutApprovalRecord | undefined>;
  findActiveByBatch(batchId: string): Promise<PayoutApprovalRecord | undefined>;
  /** version 조건부 갱신과 감사 기록을 같은 트랜잭션에 쓴다. 다른 승인이 먼저 갱신했으면 false */
  save(record: PayoutApprovalRecord, audit?: AuditRecord): Promise<boolean>;
  list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }): Promise<PayoutApprovalRecord[]>;
}

export interface PayoutPaymentClient {
  createBatch(input: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; payoutDate: string; portoneBalance?: { amount: number; observedAt: string } | undefined; actor: string }): Promise<PayoutBatchView>;
  listBatches(filter: { payoutDate?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; status?: readonly string[] | undefined; limit: number }): Promise<PayoutBatchView[]>;
  /** SCR-049 묶음 상세(정산서·지급 건·보류·KYC 예고). */
  getBatchDetail(batchId: string): Promise<PayoutBatchDetailView>;
  approveBatch(batchId: string, approvalId: string, payeeDigest?: string): Promise<PayoutBatchView>;
  executeBatch(batchId: string): Promise<PayoutBatchView>;
  /** 15시 미승인 만료(F-06-3). PREPARED·PENDING_APPROVAL이고 지급 건이 없을 때만 푼다. */
  expireBatch?(batchId: string, input: { approvalId: string; postponedPayoutDate: string }): Promise<{ batchId: string; status: 'EXPIRED'; postponedPayoutDate: string }>;
  /** 반려한 배치를 풀어 정산서를 CONFIRMED로 되돌린다(CONS-V02). */
  releaseBatch(batchId: string): Promise<void>;
  recordPortoneExecution(batchId: string, bulkPayoutId: string): Promise<PayoutBatchView>;
  listStatements(filter: { kind?: string | undefined; status?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; payoutDate?: string | undefined; limit: number }): Promise<unknown[]>;
  listReceivables(filter: { limit: number }): Promise<unknown[]>;
  /** 보증금·이행보증보험 충당(payment-svc 내부). commander 재인증은 ops가 먼저 확인한다. */
  collectGuarantee(receivableId: string, input: { actor: string; sessionId: string; reauthToken?: string | undefined; idempotencyKey: string; reason: string }): Promise<unknown>;
  /** 결제사 서킷 상태(재개 조건 표시). payment-svc 내부 /internal/v1/circuits */
  listCircuits(): Promise<{ items: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; state: 'closed' | 'half_open' | 'open' }[] }>;
}

/** payment-svc 내부 조정 행 한 줄(ops가 승인 업무와 대조할 값만) */
export interface SettlementAdjustmentRow {
  adjustmentId: string;
  statementId: string;
  approvalId: string;
  reasonCode: string;
  disputeId: string | null;
  amount: number;
  status: 'PENDING' | 'APPLIED' | 'VOID';
}

/**
 * payment-svc 정산서 이의 기각·수기 조정 내부 HTTP(F-07-5, ADR-0368 결정 6·7·8). payment 4xx는 그 상태·종류 그대로,
 * 5xx·시간 초과·연결 실패는 503으로 전한다.
 */
export interface SettlementPaymentClient {
  dismissDispute(statementId: string, input: { reason: string; actorId: string }): Promise<unknown>;
  registerAdjustment(statementId: string, input: { approvalId: string; amount: number; reasonCode: string; disputeId?: string | undefined; evidenceNote?: string | undefined; requestedBy: string }): Promise<SettlementAdjustmentRow>;
  applyAdjustment(approvalId: string): Promise<unknown>;
  voidAdjustment(approvalId: string): Promise<unknown>;
}

/** 위험 작업의 재인증 작업 묶음(identity reauth 토큰의 act, authz-matrix §6, ADR-0206·0322) */
export type ReauthAct = 'APPROVAL' | 'OPS_COMMAND' | 'PERMISSION_CHANGE';
export interface ApprovalReauthVerifier {
  verify(token: string | undefined, o: { sessionId: string; act: ReauthAct }): Promise<{ accountId: string; factors: string[] }>;
}
/** 재인증 확인기·jti 저장소에 닿지 못했다(받는 층은 503 reauth-unavailable, Retry-After 5초 [가정]) */
export class ReauthUnavailable extends Error {
  constructor(cause?: unknown) {
    super('재인증 확인기나 jti 저장소에 닿지 못했다', { cause });
    this.name = 'ReauthUnavailable';
  }
}

export const PAYOUT_APPROVAL_STORE = Symbol.for('peaket.ops.payout-approval-store');
export const PAYOUT_PAYMENT_CLIENT = Symbol.for('peaket.ops.payout-payment-client');
export const APPROVAL_REAUTH_VERIFIER = Symbol.for('peaket.ops.approval-reauth-verifier');
export const PAYOUT_AUDIT_CHAIN = Symbol.for('peaket.ops.payout-audit-chain');
export const SETTLEMENT_PAYMENT_CLIENT = Symbol.for('peaket.ops.settlement-payment-client');

/** 지급 클라이언트가 정산 이의·조정 경로도 갖는가(HttpPayoutPaymentClient는 둘 다 갖는다) */
export const isSettlementPaymentClient = (v: unknown): v is SettlementPaymentClient =>
  typeof v === 'object' && v !== null && ['dismissDispute', 'registerAdjustment', 'applyAdjustment', 'voidAdjustment'].every((m) => typeof (v as Record<string, unknown>)[m] === 'function');

export type PayoutAuditChain = Pick<AuditChain, 'append'>;
