// 배상 송금 모듈의 공개 면.
export { CompensationTransferProblem, CompensationTransfers } from './application/compensation-transfers.js';
export { FakeCompensationTransfer } from './adapters/fake-compensation-transfer.js';
export { compensationTransferHandlers, compensationTransferPackage, type CompensationTransferPackage } from './inbound/compensation-transfer.grpc.js';
export type { CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest, CompensationTransferStatus } from './domain/ports.js';
