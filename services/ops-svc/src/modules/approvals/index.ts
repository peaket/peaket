// 승인 업무 모듈의 공개 파일. 다른 컨텍스트는 이 파일로만 가져온다.
// 계약 조건 변경(BAT-615)을 내보낸다. commander 역할 변경(BAT-045)은 admin-accounts 모듈이 소유한다.
export { ApprovalsModule, type ApprovalsModuleDeps } from './approvals.module.js';
export { ContractApprovals } from './application/contract-approvals.js';
export { ApprovalRouter } from './application/approval-router.js';
export { SettlementAdjustmentApprovals, settlementAdjustmentApprovalId } from './application/settlement-adjustment-approvals.js';
export { DrizzleContractApprovalStore, DrizzleSettlementAdjustmentApprovalStore } from './adapters/db/drizzle-store.js';
export { MemoryContractApprovalStore, MemorySettlementAdjustmentApprovalStore } from './adapters/memory-store.js';
export { MemoryCoreContract, UnavailableCoreContract } from '../../adapters/http-core-contract.js';
export type { ContractApprovalRecord, SettlementAdjustmentApprovalFacts, SettlementAdjustmentApprovalRecord, SettlementAdjustmentApprovalView } from './domain/approval.js';
export type { ContractApprovalStore, CoreContractClient, SettlementAdjustmentApprovalStore } from './domain/ports.js';
export { ApprovalLifecycle, type ApprovalLifecycleDeps } from './application/approval-lifecycle.js';
// 예매 제한 사본 상태(F-06-4)를 restrictions 저장소가 같은 트랜잭션에서 읽고 쓴다
export { approvalRequest } from './adapters/db/schema.js';
export { HttpApprovalLifecyclePorts, TicketReclaimClient, LogApprovalNotifier, LogApprovalAlerts } from './adapters/service-ports.js';
