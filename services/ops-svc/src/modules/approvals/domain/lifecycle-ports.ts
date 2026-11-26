// 승인 업무 수명주기 포트(F-06-3). 시험은 HTTP 바깥 경계만 보고, 이 포트는 서비스 사이 어댑터가 채운다.
import type { AuditRecord } from '../../audit/audit.js';
import type { ApprovalLifecycleRecord, LifecycleKind } from './approval-lifecycle.js';

export interface ApprovalTargetBasis {
  targetAccountId: string | null;
  dueAtMs?: number;
  entryStartsAtMs?: number;
  /** 양도 회수 승인 시점의 보유자(IR-08) */
  expectedHolderAccountId?: string;
  entryRecorded?: boolean;
  orderCount?: number;
}

export interface ApprovalLifecycleTargets {
  basis(kind: LifecycleKind, targetRef: string, relatedOrderIds?: readonly string[]): Promise<ApprovalTargetBasis | undefined>;
  changed(kind: LifecycleKind, targetRef: string, nowMs: number): Promise<'OK' | 'TARGET_CHANGED'>;
}

export interface ApprovalLifecycleExecutors {
  refund(i: { approvalId: string; kind: 'SYSTEM_FAULT_REFUND' | 'DISCRETIONARY_WAIVER' | 'MINOR_CONTRACT_CANCEL'; targetRef: string; targetAccountId: string | null; amount: number; reasonText: string }): Promise<{ status: 'REFUNDED' | 'REFUND_PENDING'; cancellationId: string; refundAmount: number }>;
  reclaim(i: { approvalId: string; targetRef: string; targetAccountId: string | null; expectedHolderAccountId: string | null; deadlineMs: number }): Promise<{ result: 'RECLAIMED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_NOT_TRANSFERRED' | 'SKIPPED_HOLDER_CHANGED'; previousHolderAccountId?: string }>;
}

export interface ApprovalNotifier {
  send(i: {
    approvalId: string;
    event: 'EXPIRED' | 'ESCALATED' | 'WITHDRAWN' | 'PAYOUT_POSTPONED';
    recipient: { kind: 'ACCOUNT'; accountId: string } | { kind: 'ROLE'; role: 'cs_lead' | 'commander' } | { kind: 'PARTNER'; promoterId: string };
    payoutDate?: string;
  }): Promise<void>;
}

export interface ApprovalEscalationAlerts {
  open(i: {
    approvalId?: string;
    kind: 'APPROVAL_ESCALATED' | 'settlement_batch_unapproved';
    recipient: { kind: 'ACCOUNT'; accountId: string } | { kind: 'ROLE'; role: 'cs_lead' | 'commander' };
    pg?: 'TOSS' | 'PORTONE';
    payoutDate?: string;
  }): Promise<void>;
}

export interface ApprovalLifecycleFailureCases {
  failed(i: { approvalId: string; kind: string; dueAtMs: number | null }): Promise<void>;
  succeeded(approvalId: string): Promise<void>;
}

export interface ApprovalLifecycleStore {
  /** 상태 행과 감사 기록을 같은 트랜잭션에 쓴다 */
  insert(record: ApprovalLifecycleRecord, audit?: AuditRecord): Promise<void>;
  find(approvalId: string): Promise<ApprovalLifecycleRecord | undefined>;
  /** version 조건부 갱신과 감사·투표를 같은 트랜잭션에 쓴다 */
  save(record: ApprovalLifecycleRecord, audit?: AuditRecord | readonly AuditRecord[]): Promise<boolean>;
  list(filter: { status?: readonly string[] | undefined; kind?: LifecycleKind | undefined; targetAccountId?: string | undefined; limit: number }): Promise<ApprovalLifecycleRecord[]>;
  /** 메모리 저장소만: 단위 시험이 시계를 되돌리면 앞선 시험의 행을 버린다(운영 DB 저장소는 구현하지 않는다). */
  resetForClock?(nowMs: number): void;
}

export const APPROVAL_LIFECYCLE_STORE = Symbol('APPROVAL_LIFECYCLE_STORE');
