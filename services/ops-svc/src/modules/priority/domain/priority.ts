// ops-svc 우선 구매 권리 발급·회수(GAT-135, POL-046 ⑦, ADR-0171).
// purchase-svc가 권리의 원본을 만들고, queue-svc는 입장 확인용 사본(q:prio:{account}:E)을 판 번호·만료와 함께 받는다.
// 두 서비스가 모두 반영해야 이 API가 성공한다(작업 워커의 다시 보내기도 같은 순서로 멱등이다).
export interface GrantPriorityInput {
  readonly fraudCaseId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly cancelledTicketId: string;
  readonly actedBy: string;
}

export type PriorityGrantResult = 'SAME_SEAT' | 'SAME_TIER' | 'NO_SEAT' | 'ENTRY_STARTED';

export interface GrantPriorityView {
  readonly result: PriorityGrantResult;
  readonly grantId?: string;
  readonly seatId?: string;
  readonly price?: number;
  readonly expiresAt?: string;
  readonly version?: number;
}

export interface WithdrawPriorityView {
  readonly grantId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly status: 'OFFERED' | 'USED' | 'EXPIRED' | 'WITHDRAWN';
  readonly expiresAt: string;
  readonly version: number;
}

/** purchase-svc 내부 HTTP(PriorityPurchaseService의 첫 내부 경로) */
export interface PurchasePriorityGrants {
  grant(i: GrantPriorityInput): Promise<GrantPriorityView>;
  withdraw(grantId: string): Promise<WithdrawPriorityView>;
}

/** queue-svc 내부 HTTP(SetPriorityGrant 사본) */
export interface QueuePriorityGrantCopies {
  set(i: { accountId: string; eventId: string; grantId: string; state: 'OFFERED' | 'WITHDRAWN'; expiresAt: string; version: number }): Promise<void>;
}

export class PriorityDependencyUnavailable extends Error {
  constructor(readonly dependency: 'purchase-svc' | 'queue-svc', readonly status: number) {
    super(`${dependency}가 우선 구매 권리 요청을 처리하지 못했다(${status})`);
    this.name = 'PriorityDependencyUnavailable';
  }
}
