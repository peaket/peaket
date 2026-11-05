// 주문 애그리거트의 상태와 전이 표(docs/features/payment.md §3 전이 표·'주문 저장소의 첫 구현', docs/data.md §2 purchase_order·order_event, ADR-0113, BUILD_ORDER PRF-160).
// 주문 상태는 주문 전이 함수(adapters/db/drizzle-orders.ts) 하나로만 바꾼다. 이 파일은 DB를 모르는 규칙(표, 사건 종류, 사건 만들기)이다.
// eventKey 계산(UUID 버전 8)은 좌석·구매 세션 사건(inventory domain/purchase-session.ts uuid8)과 같은 계산을 이 도메인 안에 둔다
// (inventory 공개 면을 가져오면 Nest 모듈까지 끌려 온다, 리뷰 2026-11-05). 같은 값인지는 test/order-domain.test.ts가 견준다.
import { createHash } from 'node:crypto';

/**
 * SHA-256(입력)의 앞 16바이트에 UUID 버전 8(RFC 9562 사용자 정의)·변형 비트를 맞춘 UUID 글.
 * 발권 쪽(ISSUE_DELAYED eventKey, '늘 발권' 대역의 티켓 ID, BUILD_ORDER PRF-170)도 같은 계산을 쓴다(booking 안에서만 쓴다. 공개 면 index.ts에는 내놓지 않는다)
 */
export function uuid8(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 주문 저장 값(docs/data.md purchase_order.status, openapi Order.status와 같은 대문자) */
export const ORDER_STATUSES = [
  'CREATED',
  'AUTHENTICATED',
  'ACCEPTED',
  'RESERVED',
  'AWAITING_DEPOSIT',
  'APPROVED',
  'UNKNOWN',
  'CONFIRMED',
  'FAILED',
  'COMPENSATED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'EXPIRED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 전이 번호(payment §3 표의 T1~T26). order_event.cause에 그대로 쓴다 */
export type TransitionId = `T${number}`;

export interface OrderTransition {
  readonly id: TransitionId;
  /** 출발 상태. T1(주문 생성)만 null */
  readonly from: OrderStatus | null;
  readonly to: OrderStatus;
}

/** 전이 표(payment §3, 정본은 그 표다). 번호 차례로 둔다 */
export const ORDER_TRANSITIONS: readonly OrderTransition[] = [
  { id: 'T1', from: null, to: 'CREATED' },
  { id: 'T2', from: 'CREATED', to: 'CREATED' },
  { id: 'T3', from: 'CREATED', to: 'AUTHENTICATED' },
  { id: 'T4', from: 'AUTHENTICATED', to: 'ACCEPTED' },
  { id: 'T5', from: 'CREATED', to: 'EXPIRED' },
  { id: 'T6', from: 'AUTHENTICATED', to: 'EXPIRED' },
  { id: 'T7', from: 'ACCEPTED', to: 'RESERVED' },
  { id: 'T8', from: 'ACCEPTED', to: 'FAILED' },
  { id: 'T9', from: 'RESERVED', to: 'APPROVED' },
  { id: 'T10', from: 'RESERVED', to: 'AWAITING_DEPOSIT' },
  { id: 'T11', from: 'RESERVED', to: 'FAILED' },
  { id: 'T12', from: 'RESERVED', to: 'UNKNOWN' },
  { id: 'T13', from: 'UNKNOWN', to: 'APPROVED' },
  { id: 'T14', from: 'UNKNOWN', to: 'AWAITING_DEPOSIT' },
  { id: 'T15', from: 'UNKNOWN', to: 'FAILED' },
  { id: 'T16', from: 'AWAITING_DEPOSIT', to: 'APPROVED' },
  { id: 'T17', from: 'AWAITING_DEPOSIT', to: 'FAILED' },
  { id: 'T18', from: 'APPROVED', to: 'CONFIRMED' },
  { id: 'T19', from: 'APPROVED', to: 'APPROVED' },
  { id: 'T20', from: 'APPROVED', to: 'COMPENSATED' },
  { id: 'T21', from: 'CONFIRMED', to: 'AWAITING_DEPOSIT' },
  { id: 'T22', from: 'CONFIRMED', to: 'PARTIALLY_REFUNDED' },
  { id: 'T23', from: 'PARTIALLY_REFUNDED', to: 'REFUNDED' },
  { id: 'T24', from: 'CONFIRMED', to: 'REFUNDED' },
  { id: 'T25', from: 'PARTIALLY_REFUNDED', to: 'PARTIALLY_REFUNDED' },
  { id: 'T26', from: 'REFUNDED', to: 'REFUNDED' },
];

/**
 * 결제 결과 반영 전이(T9~T17과 T21). 결제 사건 순번이 있어야 하고, 같은 UPDATE에 `payment_event_seq < 순번` 조건을 걸어 그 순번으로 바꾼다(ADR-0146 결정 2).
 * T21(입금 되돌림)도 결제사가 입금 완료를 되돌린 결제 사건으로 오므로 같은 사건이 사건 길과 당기기로 두 번 와도 한 번만 되돌린다(리뷰 2026-11-05)
 */
export const PAYMENT_RESULT_TRANSITIONS: ReadonlySet<TransitionId> = new Set<TransitionId>(['T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T21']);

/** trade.orders OrderEvent.type 값(asyncapi) */
export type OrderEventType =
  | 'CREATED'
  | 'ACCEPTED'
  | 'RESERVED'
  | 'AWAITING_DEPOSIT'
  | 'APPROVED'
  | 'CONFIRMED'
  | 'DEPOSIT_REVERSED'
  | 'FAILED'
  | 'COMPENSATED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'EVENT_CANCELLATION_CONFIRMED'
  | 'COMPENSATION_PAID'
  | 'EXPIRED'
  | 'ISSUE_DELAYED';

/** firstInStage를 셀 수 있는 도착 상태(관제 퍼널 단계, ADR-0099) */
export const FIRST_IN_STAGE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['ACCEPTED', 'APPROVED', 'CONFIRMED']);

/** 좌석 고르기 방식(OrderEvent.seatAssignment) */
export type SeatAssignment = 'PICK' | 'AUTO';

/** 주문 항목 하나(order_item, OrderEvent.items) */
export interface OrderItem {
  readonly seatId: string;
  readonly tierId: string;
  readonly sectionId: string;
  /** 원(0 이상 정수) */
  readonly unitPrice: number;
}

/** 주문 행(purchase_order)에서 사건을 만들 때 쓰는 칸 */
export interface OrderRow {
  readonly id: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly status: OrderStatus;
  readonly amount: number;
  readonly eventSeq: number;
  readonly paymentEventSeq: number;
  readonly seatAssignment: SeatAssignment;
}

/** CREATED 사건에만 싣는 칸(주문 행에 두지 않는다, ADR-0150·0171) */
export interface CreatedExtras {
  readonly purchaseSessionId?: string;
  /** UUIDv7 */
  readonly journeyId?: string;
  readonly contactRef?: string;
  /** contactRef를 계산하지 못해 비웠으면 true */
  readonly refMissing: boolean;
}

/** trade.orders OrderEvent(asyncapi, packages/contracts OrderEvent와 같은 모양) */
export interface OrderEventMessage {
  eventId: string;
  orderId: string;
  accountId: string;
  type: OrderEventType;
  amount: number;
  seatIds: string[];
  purchaseSessionId?: string;
  journeyId?: string;
  contactRef?: string;
  refMissing: boolean;
  items: { seatId: string; tierId: string; sectionId: string; price: number }[];
  seatAssignment: SeatAssignment;
  firstInStage: boolean;
  /** ISO 8601(UTC, 밀리초) */
  occurredAt: string;
  eventKey: string;
}

/** 매일 상태·이력 검사가 한 번에 읽는 주문 수(1,000건 [가정], payment §3 '주문 저장소의 첫 구현') */
export const ORDER_HISTORY_BATCH = 1000;

/** 행위자 글: account:<UUID>(팬) | admin:<UUID>(관리 계정) | system:<작업 이름>(소문자·숫자·하이픈, 1~63자) */
export const ACTOR_PATTERN = /^(?:(?:account|admin):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|system:[a-z][a-z0-9-]{0,62})$/;

/** 번호 → 전이(표를 한 번만 훑어 둔다) */
const BY_ID: ReadonlyMap<string, OrderTransition> = new Map(ORDER_TRANSITIONS.map((t) => [t.id, t]));

/** 번호로 전이를 찾는다. 표에 없으면 undefined */
export function transitionById(id: string): OrderTransition | undefined {
  return BY_ID.get(id);
}

/** 같은 상태로 도는 전이 가운데 맞는 사건 종류가 없는 것(새 결제 시도, 발권 재시도) */
const NO_EVENT_LOOPS: ReadonlySet<TransitionId> = new Set<TransitionId>(['T2', 'T19']);
/** 맞는 사건 종류가 없는 도착 상태 */
const NO_EVENT_ARRIVALS: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['AUTHENTICATED', 'UNKNOWN']);

/**
 * 전이가 내는 사건 종류. 도착 상태와 같은 이름이고 T21만 DEPOSIT_REVERSED다.
 * 도착이 AUTHENTICATED·UNKNOWN인 전이와 T2·T19는 사건이 없어 undefined다(이력만 쓰고 Outbox 행을 넣지 않는다)
 */
export function orderEventType(t: OrderTransition): OrderEventType | undefined {
  if (t.id === 'T21') return 'DEPOSIT_REVERSED';
  if (NO_EVENT_LOOPS.has(t.id) || NO_EVENT_ARRIVALS.has(t.to)) return undefined;
  // 남은 도착 상태(CREATED·ACCEPTED·RESERVED·AWAITING_DEPOSIT·APPROVED·CONFIRMED·FAILED·COMPENSATED·PARTIALLY_REFUNDED·REFUNDED·EXPIRED)는 모두 같은 이름의 사건 종류가 있다
  return t.to as Exclude<OrderStatus, 'AUTHENTICATED' | 'UNKNOWN'>;
}

/** 주문 사건의 eventKey: UUID 버전 8(SHA-256('OrderEvent:' + 주문 ID + ':' + 이력 번호)의 앞 16바이트) */
export function orderEventKey(orderId: string, seq: number): string {
  return uuid8(`OrderEvent:${orderId}:${seq}`);
}

export interface BuildOrderEventInput {
  readonly order: OrderRow;
  readonly items: readonly OrderItem[];
  readonly transition: OrderTransition;
  /** 이 전이의 이력 번호(order_event.seq) */
  readonly seq: number;
  /** 사건 시각(주입한 시계, 유닉스 밀리초) */
  readonly occurredAtMs: number;
  /** 그 주문 이력에 같은 도착 상태가 이 번호 앞에 있었나 */
  readonly reachedBefore: boolean;
  /** T1(CREATED)에만 준다 */
  readonly created?: CreatedExtras;
}

/**
 * 전이 하나의 OrderEvent를 만든다. 사건이 없는 전이면 undefined.
 * order는 전이 뒤의 행(status = 도착)이다. items는 줄 번호 차례다
 * @throws RangeError 칸이 틀림(created를 T1 밖에서 줌, T1에 created가 없음, 항목이 비었음 등)
 */
export function buildOrderEvent(input: BuildOrderEventInput): OrderEventMessage | undefined {
  const { order, items, transition, seq, created } = input;
  // 칸 검사를 먼저 한다: 사건이 없는 전이라도 틀린 입력은 코드 오류다
  const isCreate = transition.id === 'T1';
  if (isCreate && created === undefined) throw new RangeError('T1(주문 생성) 사건에는 created 칸이 있어야 한다');
  if (!isCreate && created !== undefined) throw new RangeError(`created 칸은 T1에만 준다: ${transition.id}`);
  if (items.length === 0) throw new RangeError('주문 항목이 비었다');
  const type = orderEventType(transition);
  if (type === undefined) return undefined;
  // 칸 차례는 계약(asyncapi OrderEvent)과 같게 둔다(JSON 대역의 바이트가 늘 같은 모양이 되게)
  return {
    eventId: order.eventId,
    orderId: order.id,
    accountId: order.accountId,
    type,
    amount: order.amount,
    seatIds: items.map((i) => i.seatId),
    // CREATED에만 싣는 칸은 값이 있을 때만 넣는다. refMissing은 늘 넣는다(CREATED 밖은 false)
    ...(created?.purchaseSessionId !== undefined ? { purchaseSessionId: created.purchaseSessionId } : {}),
    ...(created?.journeyId !== undefined ? { journeyId: created.journeyId } : {}),
    ...(created?.contactRef !== undefined ? { contactRef: created.contactRef } : {}),
    refMissing: created?.refMissing ?? false,
    items: items.map((i) => ({ seatId: i.seatId, tierId: i.tierId, sectionId: i.sectionId, price: i.unitPrice })),
    seatAssignment: order.seatAssignment,
    firstInStage: FIRST_IN_STAGE_STATUSES.has(transition.to) && !input.reachedBefore,
    // 밀리초가 날짜 범위 밖이면 toISOString이 RangeError를 던진다
    occurredAt: new Date(input.occurredAtMs).toISOString(),
    eventKey: orderEventKey(order.id, seq),
  };
}
