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
  approveBatch(batchId: string, approvalId: string): Promise<PayoutBatchView>;
  executeBatch(batchId: string): Promise<PayoutBatchView>;
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

export type PayoutAuditChain = Pick<AuditChain, 'append'>;
