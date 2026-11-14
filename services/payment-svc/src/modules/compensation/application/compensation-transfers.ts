// 배상 송금 유스케이스(BAT-425 GAT-130 잔여). 모양을 보고 포트로 넘긴다.
import type { CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest } from '../domain/ports.js';

export class CompensationTransferProblem extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'CompensationTransferProblem';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CompensationTransfers {
  constructor(private readonly port: CompensationTransferPort) {}

  async request(input: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    if (!UUID.test(input.compensationId) || !UUID.test(input.orderId) || !UUID.test(input.accountId)) throw new CompensationTransferProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (!Number.isSafeInteger(input.amount) || input.amount < 1) throw new CompensationTransferProblem('INVALID', '금액이 올바르지 않습니다');
    if (!input.bankCode || !input.accountNumber || !input.holderName) throw new CompensationTransferProblem('INVALID', '계좌 정보가 필요합니다');
    return this.port.request(input);
  }

  async get(transferId: string): Promise<CompensationTransferRecord> {
    const r = await this.port.get(transferId);
    if (!r) throw new CompensationTransferProblem('NOT_FOUND', '송금 건을 찾을 수 없습니다');
    return r;
  }
}
