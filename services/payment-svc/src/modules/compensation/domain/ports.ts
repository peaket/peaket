// 배상 송금 포트(BAT-425 GAT-130 잔여, FR-056, POL-014·019, ADR-0046 결정 5).
// 실제 지급대행·은행 계정이 없으면 UNAVAILABLE로 답하고 받는 쪽이 503으로 드러낸다.
export type CompensationTransferStatus = 'REQUESTED' | 'PAID' | 'FAILED' | 'UNAVAILABLE';

export interface CompensationTransferRequest {
  readonly compensationId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly holderName: string;
  readonly requestedBy: string;
}

export interface CompensationTransferRecord {
  readonly transferId: string;
  readonly compensationId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly status: CompensationTransferStatus;
  readonly failureReason?: string;
}

export interface CompensationTransferPort {
  request(input: CompensationTransferRequest): Promise<CompensationTransferRecord>;
  get(transferId: string): Promise<CompensationTransferRecord | undefined>;
}
