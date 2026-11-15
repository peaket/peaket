// 지급 승인 업무 저장·payment-svc 호출·재인증 포트.
import type { AuditChain } from '../../audit/index.js';
import type { AuditRecord } from '../../audit/audit.js';
import type { PayoutApprovalRecord, PayoutBatchView } from './payout-approval.js';

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
  approveBatch(batchId: string, approvalId: string): Promise<PayoutBatchView>;
  executeBatch(batchId: string): Promise<PayoutBatchView>;
  recordPortoneExecution(batchId: string, bulkPayoutId: string): Promise<PayoutBatchView>;
  listStatements(filter: { kind?: string | undefined; status?: string | undefined; pg?: string | undefined; pgStore?: string | undefined; payoutDate?: string | undefined; limit: number }): Promise<unknown[]>;
  listReceivables(filter: { limit: number }): Promise<unknown[]>;
  /** 결제사 서킷 상태(재개 조건 표시). payment-svc 내부 /internal/v1/circuits */
  listCircuits(): Promise<{ items: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; state: 'closed' | 'half_open' | 'open' }[] }>;
}

export interface ApprovalReauthVerifier {
  verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }): Promise<{ accountId: string; factors: string[] }>;
}

export const PAYOUT_APPROVAL_STORE = Symbol.for('peaket.ops.payout-approval-store');
export const PAYOUT_PAYMENT_CLIENT = Symbol.for('peaket.ops.payout-payment-client');
export const APPROVAL_REAUTH_VERIFIER = Symbol.for('peaket.ops.approval-reauth-verifier');
export const PAYOUT_AUDIT_CHAIN = Symbol.for('peaket.ops.payout-audit-chain');

export type PayoutAuditChain = Pick<AuditChain, 'append'>;
