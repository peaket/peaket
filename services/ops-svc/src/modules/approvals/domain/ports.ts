// 승인 업무 저장소와 core 계약 적용 클라이언트의 포트(BAT-615 LCH-070, ADR-0320).
import type { AuditRecord } from '../../audit/audit.js';
import type { ApprovalReauthVerifier } from '../../payouts/index.js';
import type { ApprovalFailureCases } from '../../cases/index.js';
import type { ContractApprovalRecord, SettlementAdjustmentApprovalRecord } from './approval.js';

export interface ApprovalVote {
  approvalId: string;
  approverId: string;
  requesterId: string;
  approvedAt: Date;
  reason: string | null;
}

export interface ContractApprovalStore {
  /** 승인 업무와 계약 변경 값을 한 트랜잭션에 넣는다. 같은 승인 ID가 있으면 그 행을 그대로 돌려준다(멱등). 그 파트너에 열린 변경이 있으면 'conflict' */
  insert(record: ContractApprovalRecord, audit?: AuditRecord): Promise<{ record: ContractApprovalRecord; created: boolean } | 'conflict'>;
  find(approvalId: string): Promise<ContractApprovalRecord | undefined>;
  /** 그 파트너에 열린 변경(없으면 undefined). 부분 유일 인덱스와 같은 규칙이다 */
  findOpenByPromoter(promoterId: string): Promise<ContractApprovalRecord | undefined>;
  /** 상태·버전을 조건부로 쓴다. 투표는 승인이 끝났을 때만 같은 트랜잭션에 넣는다 */
  save(record: ContractApprovalRecord, audit?: AuditRecord, vote?: ApprovalVote): Promise<boolean>;
  list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; promotorId?: string | undefined; limit: number }): Promise<ContractApprovalRecord[]>;
}

/** ops-svc가 core-svc에 계약 승인을 적용하거나 예약을 푼다. 같은 승인 ID 재호출은 같은 답이다 */
export interface CoreContractClient {
  apply(input: { promoterId: string; approvalId: string; commissionRateBp?: number; guaranteeRateBp?: number; guaranteeKind?: string; approvedAt: Date; approverId: string }): Promise<void>;
  cancel(input: { promoterId: string; approvalId: string; reason?: string }): Promise<void>;
}

export interface ContractApprovalDeps {
  readonly store: ContractApprovalStore;
  readonly core: CoreContractClient;
  readonly reauth: ApprovalReauthVerifier;
  readonly clock: import('@peaket/platform').Clock;
  /** 실행 실패 때 CS '승인 업무 실행 실패' 건을 열고 다시 실행이 성공하면 닫는다(F-06-2 ADR-0364 결정 6). 없으면 부르지 않는다 */
  readonly failureCases?: ApprovalFailureCases;
}

/** 정산서 수기 조정 승인 업무 저장소(approval_request kind SETTLEMENT_ADJUSTMENT·approval_vote) */
export interface SettlementAdjustmentApprovalStore {
  /** 같은 승인 ID가 있으면 그 행(created=false). 감사는 같은 트랜잭션에 쓴다 */
  insert(record: SettlementAdjustmentApprovalRecord, audit?: AuditRecord): Promise<{ record: SettlementAdjustmentApprovalRecord; created: boolean }>;
  find(approvalId: string): Promise<SettlementAdjustmentApprovalRecord | undefined>;
  /** 버전 조건부. 투표가 있으면 같은 트랜잭션에 넣는다(같은 승인자 한 번) */
  save(record: SettlementAdjustmentApprovalRecord, audit?: AuditRecord, vote?: ApprovalVote): Promise<boolean>;
  list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }): Promise<SettlementAdjustmentApprovalRecord[]>;
}

export const APPROVAL_STORE = Symbol('APPROVAL_STORE');
export const SETTLEMENT_ADJUSTMENT_APPROVAL_STORE = Symbol('SETTLEMENT_ADJUSTMENT_APPROVAL_STORE');
export const CORE_CONTRACT_CLIENT = Symbol('CORE_CONTRACT_CLIENT');
export const APPROVAL_REAUTH = Symbol('APPROVAL_REAUTH');
