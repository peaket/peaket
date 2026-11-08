// 결제 결과 반영의 값과 규칙(docs/features/payment.md §2 '결제 결과 반영의 첫 구현', §3 T9~T17, docs/data.md §5 '결제 결과 반영', BUILD_ORDER PRF-163).
// trade.payments PaymentEvent 하나를 주문의 지금 상태와 견주어 '반영(APPLY) · 건너뜀(SKIP) · 보류(HOLD)' 가운데 하나로 정한다.
// 키 단위 처리기(inbound/payment-result.handler.ts, 주문 ID, ADR-0142)와 결과 당기기(PRF-171)가 같은 쓰임새(application/apply-payment-result.ts)를 부른다.
// 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수). 사건 모양은 계약(asyncapi PaymentEvent)의 칸을 다시 적은 것이다(order.ts OrderEventMessage와 같은 방식).
import type { OrderStatus } from './order.js';
import type { PaymentPg } from './ports.js';

/** PaymentEvent.type(asyncapi). 차례는 계약과 같다 */
export const PAYMENT_EVENT_TYPES = ['AWAITING_DEPOSIT', 'APPROVED', 'DEPOSIT_REVERSED', 'FAILED', 'UNKNOWN', 'RESOLVED', 'PARTIAL_CANCELED', 'CANCELED'] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/**
 * 결제 쪽 실패 사유(PaymentEvent.failureCategory, 결제 어댑터가 정한다, payment §2.1). 실패 트랜잭션이 주문 failure_reason에 그대로 적는다(0007, data.md §4).
 * - CARD_DECLINED: 카드사·결제사가 거절 · USER_ABORTED: 사용자가 그만둠 · VALIDATION: 요청 검증 실패
 * - EXPIRED: 승인 기한을 넘김 · PG_ERROR: 결제사 오류 · THROTTLED: 결제사 한도에 걸림
 */
export const PAYMENT_FAILURE_CATEGORIES = ['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED'] as const;
export type PaymentFailureCategory = (typeof PAYMENT_FAILURE_CATEGORIES)[number];

/**
 * FAILED 사건에 failureCategory가 없을 때 주문 failure_reason에 적는 값 [정함: 계약은 '실패일 때만' 싣는다고 하지만 칸이 선택이다.
 * 보류하면 좌석이 PENDING으로 묶이므로 결제사 오류로 보고 실패를 반영한다]
 */
export const PAYMENT_FAILURE_FALLBACK: PaymentFailureCategory = 'PG_ERROR';

/** PaymentEvent.result(payment §2.1 정규화 결과) */
export const PAYMENT_RESULT_NAMES = ['APPROVED', 'ALREADY_APPROVED', 'IN_PROGRESS', 'DECLINED', 'WAITING_FOR_DEPOSIT', 'UNKNOWN'] as const;
export type PaymentResultName = (typeof PAYMENT_RESULT_NAMES)[number];

/** PaymentEvent.payMethodCategory */
export type PayMethodCategory = 'CARD' | 'EASY_PAY' | 'TRANSFER' | 'OTHER';

/**
 * 반영에 쓰는 결제 사건(asyncapi PaymentEvent의 칸, 처리기가 zod로 검사한 뒤 넘긴다).
 * 조사용 가명 칸(paymentMethodRef·cardBin)은 purchase가 쓰지 않아 옮기지 않는다 [정함: 주문 반영에 필요 없는 조사 칸을 들고 다니지 않는다].
 */
export interface PaymentResultEvent {
  /** 회차 ID(trade.payments의 eventId 칸. 계약 설명은 Kafka 키로 쓰는 회차다) */
  readonly eventId: string;
  readonly orderId: string;
  /** 결제 접수에서 고정된 결제사(ADR-0044). 주문의 접수한(ACCEPTED) 결제 시도와 견준다 */
  readonly pg: PaymentPg;
  readonly type: PaymentEventType;
  /** 결제 금액(원). 주문 금액과 견준다 */
  readonly amount: number;
  readonly payMethodCategory?: PayMethodCategory;
  readonly refMissing: boolean;
  readonly result?: PaymentResultName;
  /** FAILED일 때만 */
  readonly failureCategory?: PaymentFailureCategory;
  /** 같은 주문의 결제 시도 순번 */
  readonly attemptNo: number;
  readonly latencyMs?: number;
  /** ISO 8601(오프셋 포함) */
  readonly occurredAt: string;
  /** 결제 하나 안에서 늘어나기만 하는 사건 순번(payment_event.seq). 주문 payment_event_seq와 견준다(ADR-0140·0146 결정 2) */
  readonly eventSeq: number;
  /** 중복 제거 키(ADR-0052). 키 단위 처리기의 eventKeyOf */
  readonly eventKey: string;
}

/** 결정에 쓰는 주문 모습(주문 행 몇 칸과 접수한 결제 시도의 결제사) */
export interface PaymentResultOrderView {
  readonly orderId: string;
  readonly status: OrderStatus;
  /** 서버가 계산한 금액(원) */
  readonly amount: number;
  /** 반영한 마지막 결제 사건 순번(purchase_order.payment_event_seq, 처음 0) */
  readonly paymentEventSeq: number;
  /** 그 주문의 ACCEPTED 결제 시도의 결제사. 없으면 undefined(접수하지 않은 주문) */
  readonly acceptedPg?: PaymentPg;
}

/** 결제 결과 반영 전이 가운데 이번 단계(PRF-163)가 하는 것. T21(입금 되돌림)은 가상계좌 단계가 맡는다 */
export type PaymentResultTransition = 'T9' | 'T10' | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17';

/** 반영 쓰기의 세 갈래(ports.ts PaymentResultWrites의 approve·fail·mark) */
export type PaymentResultWrite = 'APPROVE' | 'FAIL' | 'MARK';

/** 전이 표에 있는 사건 종류(그 밖의 종류는 기록·아직 맡지 않음으로 건너뛴다) */
export type AppliedPaymentEventType = 'APPROVED' | 'FAILED' | 'UNKNOWN' | 'AWAITING_DEPOSIT';

/**
 * 사건 종류 × 지금 상태 → 전이(payment §2 '사건 종류 × 지금 상태 → 전이'). 표 밖의 조합은 있을 수 없는 조합(HOLD IMPOSSIBLE)이다.
 * APPROVED: RESERVED→T9, UNKNOWN→T13, AWAITING_DEPOSIT→T16 · FAILED: RESERVED→T11, UNKNOWN→T15, AWAITING_DEPOSIT→T17
 * UNKNOWN: RESERVED→T12 · AWAITING_DEPOSIT: RESERVED→T10, UNKNOWN→T14
 */
export const PAYMENT_RESULT_TABLE: Readonly<Record<AppliedPaymentEventType, Readonly<Partial<Record<OrderStatus, PaymentResultTransition>>>>> = {
  APPROVED: { RESERVED: 'T9', UNKNOWN: 'T13', AWAITING_DEPOSIT: 'T16' },
  FAILED: { RESERVED: 'T11', UNKNOWN: 'T15', AWAITING_DEPOSIT: 'T17' },
  UNKNOWN: { RESERVED: 'T12' },
  AWAITING_DEPOSIT: { RESERVED: 'T10', UNKNOWN: 'T14' },
};

/** 사건 종류의 도착 상태(주문이 이미 이 상태면 다시 온 사건으로 건너뛴다, ALREADY_THERE) */
export const PAYMENT_RESULT_ARRIVAL: Readonly<Record<AppliedPaymentEventType, OrderStatus>> = {
  APPROVED: 'APPROVED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  AWAITING_DEPOSIT: 'AWAITING_DEPOSIT',
};

/** 전이 → 쓰기 갈래: 승인(T9·T13·T16), 실패(T11·T15·T17), 상태만(T10·T12·T14) */
export const PAYMENT_RESULT_WRITES: Readonly<Record<PaymentResultTransition, PaymentResultWrite>> = {
  T9: 'APPROVE',
  T13: 'APPROVE',
  T16: 'APPROVE',
  T11: 'FAIL',
  T15: 'FAIL',
  T17: 'FAIL',
  T10: 'MARK',
  T12: 'MARK',
  T14: 'MARK',
};

/**
 * 건너뛰는 까닭.
 * - DUPLICATE: 이미 반영한 순번 이하(event.eventSeq ≤ order.paymentEventSeq). 사건 길과 당기기로 두 번 온 사건
 * - ALREADY_THERE: 주문이 이미 그 사건의 도착 상태(다시 온 사건)
 * - RECORD_ONLY: RESOLVED(UNKNOWN 해소 기록. 결과는 APPROVED·AWAITING_DEPOSIT·FAILED 사건이 따로 온다, ADR-0073)
 */
export type PaymentResultSkipReason = 'DUPLICATE' | 'ALREADY_THERE' | 'RECORD_ONLY';

/**
 * 보류하는 까닭(held_event로 옮기고 같은 주문의 뒤 사건도 보류, RB-11로 원인을 본 뒤 다시 넣는다). 로그 수준·표시는 PAYMENT_RESULT_HOLD_LOG.
 * - IMPOSSIBLE: 표 밖의 조합(예: CONFIRMED 주문에 새 순번 APPROVED), 주문이 없음 [정함: 없는 주문도 같은 까닭으로 묶는다]
 * - AMOUNT_MISMATCH: 사건 금액이 주문 금액과 다름
 * - PG_MISMATCH: 사건 결제사가 주문의 접수한 결제 시도의 결제사와 다름, 또는 접수한 결제 시도가 없음
 * - NOT_YET_SUPPORTED: DEPOSIT_REVERSED(T21)·PARTIAL_CANCELED·CANCELED. 맡을 단계(가상계좌·취소)가 생기면 보류 표에서 다시 처리한다
 *   (건너뛰면 그 사건을 영영 잃는다, 리뷰 M3)
 * - CHARGED_ON_CLOSED_ORDER: 닫힌 주문(FAILED·EXPIRED·COMPENSATED)에 과금 사건(APPROVED·AWAITING_DEPOSIT) — 과금됐는데 주문이 닫혔다(SEV1, 리뷰 M2).
 *   CS 처리함 건과 환불로 닫는 길은 보상 세 걸음(PRF-173) 무렵이다(TICKET_NOT_ISSUED와 같은 꼴, CS 건 요청 계약은 GAT-280, docs/features/payment.md §2)
 * - SOLD_MISMATCH: 승인 쓰기에서 SOLD로 바꾼 판매 행 수가 주문 좌석 수와 다름(판매 행이 없어졌다. 되돌렸다, SEV1, 리뷰 M4)
 */
export type PaymentResultHoldReason = 'IMPOSSIBLE' | 'AMOUNT_MISMATCH' | 'PG_MISMATCH' | 'NOT_YET_SUPPORTED' | 'CHARGED_ON_CLOSED_ORDER' | 'SOLD_MISMATCH';

/** 보류 로그의 경보 수준(SEV1: 과금됐는데 반영하지 못함, SEV2: 그 밖) */
export type PaymentResultHoldSeverity = 'SEV1' | 'SEV2';
/** 보류 로그의 종류 표시(payment-charged-closed: 닫힌 주문에 과금 사건, security: 금액·결제사 대조 실패 — 보안 이벤트, ASVS v5.0.0-16.3.3) */
export type PaymentResultHoldKind = 'payment-charged-closed' | 'security';

/** 보류 까닭 → 로그 수준·표시(리뷰 M2·M4·L6) */
export const PAYMENT_RESULT_HOLD_LOG: Readonly<Record<PaymentResultHoldReason, { readonly severity: PaymentResultHoldSeverity; readonly kind?: PaymentResultHoldKind }>> = {
  IMPOSSIBLE: { severity: 'SEV2' },
  AMOUNT_MISMATCH: { severity: 'SEV2', kind: 'security' },
  PG_MISMATCH: { severity: 'SEV2', kind: 'security' },
  NOT_YET_SUPPORTED: { severity: 'SEV2' },
  CHARGED_ON_CLOSED_ORDER: { severity: 'SEV1', kind: 'payment-charged-closed' },
  SOLD_MISMATCH: { severity: 'SEV1' },
};

/** 닫힌 주문 상태(과금 사건이 오면 CHARGED_ON_CLOSED_ORDER, 리뷰 M2) */
export const PAYMENT_RESULT_CLOSED_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['FAILED', 'EXPIRED', 'COMPENSATED']);
/** 과금을 뜻하는 사건 종류(리뷰 M2) */
export const PAYMENT_RESULT_CHARGE_TYPES: ReadonlySet<PaymentEventType> = new Set<PaymentEventType>(['APPROVED', 'AWAITING_DEPOSIT']);
/**
 * 승인된 주문 상태: 다시 온 사건(DUPLICATE·ALREADY_THERE)이어도 구매 세션 끝내기만 다시 부른다(커밋 뒤 일이 한 번 실패한 경우를 메운다, 리뷰 L1)
 */
export const PAYMENT_RESULT_SESSION_DONE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['APPROVED', 'CONFIRMED', 'AWAITING_DEPOSIT']);

/** 결정 결과. APPLY는 쓰기 갈래와 전이를 함께 싣는다(실패는 주문에 적을 실패 사유도) */
export type PaymentResultDecision =
  | { readonly kind: 'APPLY'; readonly write: 'APPROVE'; readonly transition: 'T9' | 'T13' | 'T16' }
  | { readonly kind: 'APPLY'; readonly write: 'FAIL'; readonly transition: 'T11' | 'T15' | 'T17'; readonly failureReason: PaymentFailureCategory }
  | { readonly kind: 'APPLY'; readonly write: 'MARK'; readonly transition: 'T10' | 'T12' | 'T14' }
  | { readonly kind: 'SKIP'; readonly reason: PaymentResultSkipReason }
  | { readonly kind: 'HOLD'; readonly reason: PaymentResultHoldReason };

/** 발권 기한 = 결제 승인 + 30분 [가정](ticket_issue_job.issue_due_at, ADR-0106) */
export const TICKET_ISSUE_WINDOW_MS = 30 * 60_000;

/** 결제 결과 반영의 행위자(order_event.actor, ACTOR_PATTERN의 system:<작업 이름>) */
export const PAYMENT_RESULT_ACTOR = 'system:payment-result';

/**
 * 결제 사건 하나를 주문의 지금 상태와 견주어 정한다(순수 함수, 던지지 않는다).
 * 보는 차례 [정함: 정본은 각 규칙만 적었고 차례는 없다]:
 *  ① 주문이 없음(order undefined) → HOLD IMPOSSIBLE
 *  ② event.eventSeq ≤ order.paymentEventSeq → SKIP DUPLICATE
 *  ③ RESOLVED → SKIP RECORD_ONLY, DEPOSIT_REVERSED·PARTIAL_CANCELED·CANCELED → HOLD NOT_YET_SUPPORTED(리뷰 M3)
 *  ③-2 닫힌 주문(PAYMENT_RESULT_CLOSED_STATUSES)에 과금 사건(PAYMENT_RESULT_CHARGE_TYPES) → HOLD CHARGED_ON_CLOSED_ORDER
 *      (결제사 대조보다 먼저: 접수한 결제 시도가 없는 EXPIRED 주문도 이 까닭이다, 리뷰 M2)
 *  ④ 접수한 결제 시도가 없거나 그 결제사 ≠ event.pg → HOLD PG_MISMATCH
 *  ⑤ event.amount ≠ order.amount → HOLD AMOUNT_MISMATCH
 *  ⑥ 주문이 PAYMENT_RESULT_ARRIVAL[type]이면 SKIP ALREADY_THERE
 *  ⑦ PAYMENT_RESULT_TABLE[type][status]가 있으면 APPLY(쓰기 갈래는 PAYMENT_RESULT_WRITES, FAIL이면 failureReason = failureCategory ?? PAYMENT_FAILURE_FALLBACK),
 *     없으면 HOLD IMPOSSIBLE
 */
export function decidePaymentResult(event: PaymentResultEvent, order: PaymentResultOrderView | undefined): PaymentResultDecision {
  // ① 주문이 없다
  if (order === undefined) return { kind: 'HOLD', reason: 'IMPOSSIBLE' };
  // ② 이미 반영한 순번 이하(다시 온 사건, 늦게 온 앞 순번)
  if (event.eventSeq <= order.paymentEventSeq) return { kind: 'SKIP', reason: 'DUPLICATE' };
  // ③ 기록만 하는 종류는 건너뛰고, 아직 맡지 않은 종류는 보류 표에 남긴다(결제사·금액을 보지 않는다)
  if (event.type === 'RESOLVED') return { kind: 'SKIP', reason: 'RECORD_ONLY' };
  if (!isAppliedType(event.type)) return { kind: 'HOLD', reason: 'NOT_YET_SUPPORTED' };
  // ③-2 닫힌 주문에 과금 사건(과금됐는데 주문이 닫혔다). 결제사 대조보다 먼저 본다
  if (PAYMENT_RESULT_CHARGE_TYPES.has(event.type) && PAYMENT_RESULT_CLOSED_STATUSES.has(order.status)) return { kind: 'HOLD', reason: 'CHARGED_ON_CLOSED_ORDER' };
  // ④ 결제사 고정(ADR-0044): 접수한 결제 시도가 없거나 결제사가 다르다
  if (order.acceptedPg === undefined || order.acceptedPg !== event.pg) return { kind: 'HOLD', reason: 'PG_MISMATCH' };
  // ⑤ 금액
  if (event.amount !== order.amount) return { kind: 'HOLD', reason: 'AMOUNT_MISMATCH' };
  // ⑥ 이미 그 사건의 도착 상태(다시 온 사건)
  if (order.status === PAYMENT_RESULT_ARRIVAL[event.type]) return { kind: 'SKIP', reason: 'ALREADY_THERE' };
  // ⑦ 전이 표. 표 밖은 있을 수 없는 조합이다
  const transition = PAYMENT_RESULT_TABLE[event.type][order.status];
  if (transition === undefined) return { kind: 'HOLD', reason: 'IMPOSSIBLE' };
  return applyOf(transition, event.failureCategory ?? PAYMENT_FAILURE_FALLBACK);
}

/** 전이 표에 있는 사건 종류인가 */
const isAppliedType = (type: PaymentEventType): type is AppliedPaymentEventType => Object.hasOwn(PAYMENT_RESULT_TABLE, type);

/** 전이 → APPLY 결정(쓰기 갈래는 PAYMENT_RESULT_WRITES, 실패 갈래만 실패 사유를 싣는다) */
function applyOf(transition: PaymentResultTransition, failureReason: PaymentFailureCategory): PaymentResultDecision {
  switch (transition) {
    case 'T9':
    case 'T13':
    case 'T16':
      return { kind: 'APPLY', write: 'APPROVE', transition };
    case 'T11':
    case 'T15':
    case 'T17':
      return { kind: 'APPLY', write: 'FAIL', transition, failureReason };
    case 'T10':
    case 'T12':
    case 'T14':
      return { kind: 'APPLY', write: 'MARK', transition };
  }
}

/**
 * 발권 기한 시각(epoch ms) = 승인 시각 + TICKET_ISSUE_WINDOW_MS.
 * 승인 시각은 사건의 occurredAt이다 [정함: 당기기로 늦게 반영해도 기한이 실제 승인에 묶이게].
 * @throws RangeError occurredAt이 날짜로 읽히지 않음
 */
export function ticketIssueDueAtMs(occurredAt: string): number {
  const ms = typeof occurredAt === 'string' ? Date.parse(occurredAt) : Number.NaN;
  if (!Number.isFinite(ms)) throw new RangeError('occurredAt이 날짜로 읽히지 않는다');
  return ms + TICKET_ISSUE_WINDOW_MS;
}

/**
 * 승인 전이의 발권 기한 시각(epoch ms). T9·T16은 ticketIssueDueAtMs(occurredAt)다.
 * T13(UNKNOWN → APPROVED)은 max(occurredAt, 반영 시각) + 30분이다: 결제사 승인 시각이 오래전이어도 우리가 승인을 안 것은 지금이라, 반영하자마자 기한 넘김이 되지 않게 한다(BUILD_ORDER PRF-182, 코드 리뷰).
 * @throws RangeError occurredAt이 날짜로 읽히지 않음
 */
export function approvalIssueDueAtMs(transition: 'T9' | 'T13' | 'T16', occurredAt: string, appliedAtMs: number): number {
  const due = ticketIssueDueAtMs(occurredAt);
  return transition === 'T13' ? Math.max(due, appliedAtMs + TICKET_ISSUE_WINDOW_MS) : due;
}
