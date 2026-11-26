// 승인 업무 수명주기 포트(F-06-3). 시험은 HTTP 바깥 경계만 보고, 이 포트는 서비스 사이 어댑터가 채운다.
import type { AuditRecord } from '../../audit/audit.js';
import type { ApprovalLifecycleRecord, LifecycleKind } from './approval-lifecycle.js';

export interface ApprovalTargetBasis {
  targetAccountId: string | null;
  dueAtMs?: number;
  entryStartsAtMs?: number;
  /** 양도 회수 승인 시점의 보유자(IR-08) */
  expectedHolderAccountId?: string;
  /** 남은 환급액(IR-11) */
  refundableAmount?: number;
  entryRecorded?: boolean;
  orderCount?: number;
  /** 취소 ID를 주문 ID로 푼 값(IR-11·IR-30). 없으면 targetRef가 주문 ID다 */
  orderId?: string;
  /** 무효화할 발권 세대(IR-30). 없으면 0(모든 세대) */
  issueGeneration?: number;
  /** 회차 ID(IR-30 ticket 호출) */
  eventId?: string;
  /** 이 승인 대상의 티켓들(FLAGGED는 취소된 티켓 하나, IR-30) */
  ticketIds?: readonly string[];
  /** FLAGGED 취소 행의 지금 상태(REFUNDED·VOIDED면 무효로 덮지 않는다, IR-30) */
  cancellationState?: string;
}

/** FLAGGED 처리 행동이 읽는 승인 근거(IR-11·IR-30) */
export interface ApprovalRefundBasis {
  orderId: string;
  refundableAmount: number;
  entryRecorded: boolean;
  issueGeneration?: number;
  eventId?: string;
  ticketIds?: readonly string[];
  cancellationState?: string;
}

export interface ApprovalLifecycleTargets {
  basis(kind: LifecycleKind, targetRef: string, relatedOrderIds?: readonly string[]): Promise<ApprovalTargetBasis | undefined>;
  changed(kind: LifecycleKind, targetRef: string, nowMs: number): Promise<'OK' | 'TARGET_CHANGED'>;
  /** ticket 무효 뒤 purchase의 기존 취소 행을 VOIDED로 끝낸다(IR-30). 바꾼 행이 없으면 false. 없으면 503 */
  voidCancellation?(cancellationId: string): Promise<boolean>;
}

export interface ApprovalLifecycleExecutors {
  refund(i: { approvalId: string; kind: 'SYSTEM_FAULT_REFUND' | 'DISCRETIONARY_WAIVER' | 'MINOR_CONTRACT_CANCEL'; targetRef: string; orderIds?: readonly string[]; targetAccountId: string | null; amount: number; reasonText: string }): Promise<{ status: 'REFUNDED' | 'REFUND_PENDING' | 'REQUESTED'; cancellationId: string; refundAmount: number }>;
  /** FLAGGED 취소 무효(IR-30). ticket-svc가 그 주문·발권 세대의 티켓을 VOIDED로 바꾼다 */
  voidOrder?(i: { orderId: string; reason: string; issueGeneration?: number; eventId?: string; ticketIds?: readonly string[] }): Promise<{ voided: number; alreadyEntered: number }>;
  reclaim(i: { approvalId: string; targetRef: string; targetAccountId: string | null; expectedHolderAccountId: string | null; deadlineMs: number }): Promise<{ result: 'RECLAIMED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_NOT_TRANSFERRED' | 'SKIPPED_HOLDER_CHANGED'; previousHolderAccountId?: string }>;
  /** BOOKING_RESTRICTION(F-06-4). 제한 행·queue·purchase·화면 사본을 집행한다. 사본이 아직 안 끝났으면 PENDING(EXECUTING 유지) */
  restriction?(i: { approvalId: string; targetRef: string; reasonCode: string; restrictionEndsAtMs: number; approvedBy: string | null }): Promise<{ status: 'DONE' | 'PENDING' }>;
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
  /** 5분 tick 한 번에 한 파드만 실행하는 임차(IR-29). 다른 파드가 잡았으면 undefined */
  withTickLease?<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

export const APPROVAL_LIFECYCLE_STORE = Symbol('APPROVAL_LIFECYCLE_STORE');
