// 배상금 기록·계좌 입력·송금(BAT-425 GAT-130 잔여, FR-056, POL-014·019, ADR-0046 결정 5, ADR-0317).
// 회차 취소 확정이 주최 측 귀책(ORGANIZER)·공연 내용 변경(CONTENT_CHANGE)일 때 대상 주문마다 한 행을 만든다.
// 금액은 그 주문의 대상 표 권면 합의 10%를 원 미만 올림해 한 번만 계산·저장하고(FORCE_MAJEURE는 행 0),
// 팬이 계좌를 넣으면 purchase-svc가 payment-svc 배상 송금을 compensation_id 멱등으로 부른다.
// 계좌번호 원문은 저장·로그·사건·Outbox·지표에 싣지 않고 끝 4자리만 남긴다(POL-014).
import type { EventRefundFault, EventRefundTarget } from './event-refund.js';
import { compensationOrdersOf } from './event-refund.js';

/** compensation.status. ACCOUNT_PENDING(계좌 입력 대기)·REQUESTED(송금 요청됨)·PAID(송금 완료)·FAILED(송금 실패) */
export const COMPENSATION_STATUSES = ['ACCOUNT_PENDING', 'REQUESTED', 'PAID', 'FAILED'] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUSES)[number];

/** 배상 사유. compensation 행은 이 둘일 때만 만든다(불가항력은 배상 없음, transfer-refund §6) */
export const COMPENSATION_REASONS = ['ORGANIZER', 'CONTENT_CHANGE'] as const;
export type CompensationReason = (typeof COMPENSATION_REASONS)[number];

/** 배상 계좌를 다시 받기 전 상태가 아니다(OPENAPI 409 compensation-not-account-pending) */
export class CompensationNotAccountPending extends Error {
  constructor(message = '배상 계좌를 기다리는 건이 아닙니다') {
    super(message);
    this.name = 'CompensationNotAccountPending';
  }
}

/** 없는 배상 건이거나 남의 건이다(같은 404로 답한다, authz-matrix §3.2) */
export class CompensationNotFound extends Error {
  constructor(message = '배상 건을 찾을 수 없습니다') {
    super(message);
    this.name = 'CompensationNotFound';
  }
}

/** 지급대행이 송금을 거절했다(422 compensation-transfer-failed, CS COMPENSATION_PENDING 한 건) */
export class CompensationTransferRejected extends Error {
  constructor(message = '배상금 송금이 실패했습니다', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CompensationTransferRejected';
  }
}

/** 지급대행·계정이 없어 지금은 보낼 수 없다(503 compensation-transfer-unavailable, Retry-After 5초 [가정]) */
export class CompensationTransferUnavailable extends Error {
  constructor(message = '지금은 배상금을 보낼 수 없습니다', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CompensationTransferUnavailable';
  }
}

/** 배상 건 하나의 화면용 값(openapi Compensation). 계좌번호 원문은 없다 */
export interface CompensationView {
  readonly compensationId: string;
  readonly orderId: string;
  readonly amount: number;
  readonly status: CompensationStatus;
  readonly accountLast4?: string;
  readonly eventId?: string;
  readonly reason?: CompensationReason;
  readonly createdAt: string;
}

/** 배상 목록 한 페이지(openapi CompensationPage) */
export interface CompensationPage {
  readonly items: readonly CompensationView[];
  readonly nextCursor: string | null;
}

/** 배상 행 하나(저장소·유스케이스가 쓰는 값). 계좌번호 원문은 없다 */
export interface CompensationRecord {
  readonly compensationId: string;
  readonly eventCancellationRequestId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly accountId: string;
  /** 상계할 파트너(주최 측). 지금 purchase-svc가 파트너 ID를 읽는 길이 없어 비어 있을 수 있다(배상 송금이 PAID면 payment-svc가 UNAVAILABLE로 답한다) */
  readonly promoterId?: string;
  readonly baseAmount: number;
  readonly amount: number;
  readonly status: CompensationStatus;
  readonly accountLast4?: string;
  readonly transferId?: string;
  readonly receivableId?: string;
  readonly failureReason?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** 미리보기의 주문 단위 배상 한 줄(dry_run.compensationOrders). event-refund의 같은 이름을 그대로 내보낸다 */
export type { CompensationOrder } from './event-refund.js';

/** 확정 때 compensation 표에 넣는 행(그 요청·주문 유일) */
export interface CompensationRow {
  readonly id: string;
  readonly eventCancellationRequestId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly promoterId?: string;
  readonly baseAmount: number;
  readonly amount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * 확정 트랜잭션에 넣을 compensation 행을 만든다(B13, ADR-0317 결정 2). 주문의 결제자 계정은 대상 표에서 읽는다.
 * 배상 행은 organiser·content change일 때만 만들고(FORCE_MAJEURE는 0행), status = ACCOUNT_PENDING이고 계좌·미수금은 비어 있다.
 * id는 호출이 넘긴 새 UUID를 쓴다(같은 요청·주문은 유일 인덱스가 한 행으로 막는다)
 */
export function compensationRowsOf(q: {
  readonly requestId: string;
  readonly eventId: string;
  readonly fault: EventRefundFault;
  readonly targets: readonly EventRefundTarget[];
  readonly nowMs: number;
  readonly idOf: () => string;
}): readonly CompensationRow[] {
  const accountOf = new Map<string, string>();
  for (const t of q.targets) if (!accountOf.has(t.orderId)) accountOf.set(t.orderId, t.payerAccountId);
  return compensationOrdersOf(q.targets, q.fault).map((o) => ({
    id: q.idOf(),
    eventCancellationRequestId: q.requestId,
    orderId: o.orderId,
    eventId: q.eventId,
    accountId: accountOf.get(o.orderId) ?? '',
    baseAmount: o.baseAmount,
    amount: o.amount,
    createdAtMs: q.nowMs,
    updatedAtMs: q.nowMs,
  }));
}

/** 배상 계좌 끝 4자리(계좌번호 원문은 저장하지 않는다). 하이픈을 뺀 숫자의 끝 4자리다 */
export function accountLast4Of(accountNumber: string): string {
  const digits = accountNumber.replace(/-/g, '');
  return digits.slice(-4);
}
