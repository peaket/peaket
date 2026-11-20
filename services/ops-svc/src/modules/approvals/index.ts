// 승인 업무 모듈의 공개 파일. 다른 컨텍스트는 이 파일로만 가져온다.
// 계약 조건 변경(BAT-615)을 내보낸다. commander 역할 변경(BAT-045)은 admin-accounts 모듈이 소유한다.
export { ApprovalsModule, type ApprovalsModuleDeps } from './approvals.module.js';
export { ContractApprovals } from './application/contract-approvals.js';
export { ApprovalRouter } from './application/approval-router.js';
export { DrizzleContractApprovalStore } from './adapters/db/drizzle-store.js';
export { MemoryContractApprovalStore } from './adapters/memory-store.js';
export { MemoryCoreContract, UnavailableCoreContract } from '../../adapters/http-core-contract.js';
export type { ContractApprovalRecord } from './domain/approval.js';
export type { ContractApprovalStore, CoreContractClient } from './domain/ports.js';
