// 배상 송금 포트(BAT-425 GAT-130 잔여, FR-056, POL-014·019, ADR-0046 결정 5, ADR-0317).
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
  /** 요청한 관리 계정(감사 기록용) */
  readonly requestedBy: string;
  /**
   * 배상금을 상계할 파트너(주최 측). PAID일 때 COMPENSATION_ADVANCE 미수금의 promoter_id가 된다(ADR-0317).
   * proto 칸은 필수 글자지만, 옛 단위 시험 대역(송금 상태만 보는 호출)을 위해 타입에서는 선택으로 둔다. PAID인데 없으면 UNAVAILABLE이다
   */
  readonly promoterId?: string;
  /** 원래 회차. 상품 배상은 비운다 */
  readonly eventId?: string;
}

export interface CompensationTransferRecord {
  readonly transferId: string;
  readonly compensationId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly status: CompensationTransferStatus;
  readonly failureReason?: string;
  /** 계좌번호 끝 4자리. 계좌 원문은 저장하지 않는다 */
  readonly accountLast4?: string;
  /** PAID일 때 만든 partner_receivable(COMPENSATION_ADVANCE)의 ID */
  readonly receivableId?: string;
}

/**
 * 배상 송금 기록의 저장소(payment DB compensation_transfer, ADR-0317).
 * compensation_id가 유일하고, 같은 compensation_id의 다시 부름은 저장한 상태·transfer_id를 그대로 준다.
 */
export interface CompensationTransferStore {
  /** compensation_id로 한 행. 없으면 undefined */
  findByCompensationId(compensationId: string): Promise<CompensationTransferRecord | undefined>;
  /** 지급대행 송금 ID로 한 행. 없으면 undefined */
  findByTransferId(transferId: string): Promise<CompensationTransferRecord | undefined>;
  /**
   * 송금 전에 compensation_id 행을 선점한다(BAT-425 RV-23). 유일 인덱스로 한 쪽만 claimed=true를 받으므로
   * 같은 저장소를 보는 두 파드가 겹쳐도 결제사 포트를 부르는 쪽은 하나다.
   * 이미 행이 있으면 그 행을, 선점했으면 아직 답이 없는 REQUESTED 행(transfer_id가 `claim:`로 시작)을 돌려준다.
   * accountLast4는 필수이고 계좌 원문은 받지 않는다.
   */
  claim(record: {
    readonly compensationId: string;
    readonly orderId: string;
    readonly accountId: string;
    readonly amount: number;
    readonly accountLast4: string;
    readonly promoterId: string;
    readonly eventId?: string;
  }): Promise<{ readonly record: CompensationTransferRecord; readonly claimed: boolean }>;
  /**
   * 선점한 행에 포트 답을 쓴다. 그사이 다른 파드가 먼저 썼으면 그 행을 그대로 돌려준다(같은 멱등 키 = 같은 답).
   * 이미 답이 있는 행은 덮지 않는다.
   */
  settle(compensationId: string, record: CompensationTransferRecord & { readonly accountLast4: string; readonly promoterId: string; readonly eventId?: string }): Promise<CompensationTransferRecord>;
  /** PAID 뒤 미수금 ID를 한 번만 적는다(이미 있으면 그대로). 바뀐 행을 돌려준다 */
  attachReceivable(compensationId: string, receivableId: string): Promise<CompensationTransferRecord>;
}

/** 배상 미수금 만들기(정산 모듈의 recordReceivable을 좁혀 잇는다). PAID일 때만 부른다 */
export interface CompensationReceivables {
  /** cause = COMPENSATION_ADVANCE, pg = NULL, source_ref = compensation:{id}. 같은 compensation_id면 한 행이다 */
  recordCompensationAdvance(input: {
    readonly compensationId: string;
    readonly promoterId: string;
    readonly eventId?: string;
    readonly amount: number;
  }): Promise<{ readonly receivableId: string }>;
}

export interface CompensationTransferPort {
  request(input: CompensationTransferRequest): Promise<CompensationTransferRecord>;
  get(transferId: string): Promise<CompensationTransferRecord | undefined>;
}
