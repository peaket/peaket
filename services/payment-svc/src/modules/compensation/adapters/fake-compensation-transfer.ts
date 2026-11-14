// 배상 송금 가짜 어댑터(BAT-425 GAT-130 잔여). 외부 지급대행·계정이 없어 실제 송금은 하지 않는다.
// PEAKET_COMPENSATION_TRANSFER_MODE=fake일 때만 REQUESTED를 돌려주고, 그 밖에는 UNAVAILABLE(503)이다.
// 계좌 원문은 저장하지 않는다(POL-014). 메모리 기록은 시험·로컬에서만 쓴다.
import { randomUUID } from 'node:crypto';
import type { CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest } from '../domain/ports.js';

export class FakeCompensationTransfer implements CompensationTransferPort {
  readonly #rows = new Map<string, CompensationTransferRecord>();
  readonly #byCompensation = new Map<string, string>();
  readonly #enabled: boolean;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#enabled = env.PEAKET_COMPENSATION_TRANSFER_MODE?.trim() === 'fake';
  }

  async request(input: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    if (!this.#enabled) return { transferId: '', compensationId: input.compensationId, orderId: input.orderId, accountId: input.accountId, amount: input.amount, status: 'UNAVAILABLE', failureReason: 'compensation-transfer-not-configured' };
    const existing = this.#byCompensation.get(input.compensationId);
    if (existing) return this.#rows.get(existing)!;
    const transferId = randomUUID();
    const record: CompensationTransferRecord = { transferId, compensationId: input.compensationId, orderId: input.orderId, accountId: input.accountId, amount: input.amount, status: 'REQUESTED' };
    this.#rows.set(transferId, record);
    this.#byCompensation.set(input.compensationId, transferId);
    return record;
  }

  async get(transferId: string): Promise<CompensationTransferRecord | undefined> {
    return this.#rows.get(transferId);
  }
}
