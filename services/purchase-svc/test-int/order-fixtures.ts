// 주문 저장소 통합 시험(order-store.int.test.ts)의 도움 값과 함수(BUILD_ORDER PRF-160).
// 기대 값은 정본(docs/features/payment.md §3 전이 표·'주문 저장소의 첫 구현', docs/data.md §2 purchase_order·order_item·order_event)에서
// 시험이 따로 적는다. 운영 코드의 표(ORDER_TRANSITIONS·PAYMENT_RESULT_TRANSITIONS 등)나 함수(orderEventKey·orderEventType 등)를 기대 값으로 쓰지 않는다
// (시험이 자기 답을 베끼지 않게).
import { createHash, randomUUID } from 'node:crypto';
import { type Clock, type DbTransaction, uuidv7 } from '@peaket/platform';
import type { NewOrder, OrderEventType, OrderItem, OrderRow, OrderStatus, TransitionId } from '../src/modules/booking/index.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 시험의 기준 시각(한국 시각 2026-11-05 12:00). Outbox 일 파티션은 이 날부터 7일 [가정] 앞까지 만든다 */
export const BASE_MS = Date.parse('2026-11-05T03:00:00.000Z');

/** trade.orders 주제 이름(asyncapi, payment §3). 운영 상수를 가져오지 않고 따로 적는다 */
export const TRADE_ORDERS = 'trade.orders';

/** 주문 저장 값 열세 개(docs/data.md purchase_order.status) */
export const STATUSES: readonly OrderStatus[] = [
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
];

/**
 * 전이 표(payment §3)를 시험이 따로 적은 것: [출발, 도착, 사건 종류]. 사건 종류는 도착 상태와 같은 이름이고 T21만 DEPOSIT_REVERSED다.
 * 도착이 AUTHENTICATED·UNKNOWN인 전이와 같은 상태로 도는 T2·T19는 사건이 없다(undefined). T1의 출발은 비움이라 여기 두지 않는다
 */
export const TABLE: Readonly<Record<string, readonly [from: OrderStatus, to: OrderStatus, event: OrderEventType | undefined]>> = {
  T2: ['CREATED', 'CREATED', undefined],
  T3: ['CREATED', 'AUTHENTICATED', undefined],
  T4: ['AUTHENTICATED', 'ACCEPTED', 'ACCEPTED'],
  T5: ['CREATED', 'EXPIRED', 'EXPIRED'],
  T6: ['AUTHENTICATED', 'EXPIRED', 'EXPIRED'],
  T7: ['ACCEPTED', 'RESERVED', 'RESERVED'],
  T8: ['ACCEPTED', 'FAILED', 'FAILED'],
  T9: ['RESERVED', 'APPROVED', 'APPROVED'],
  T10: ['RESERVED', 'AWAITING_DEPOSIT', 'AWAITING_DEPOSIT'],
  T11: ['RESERVED', 'FAILED', 'FAILED'],
  T12: ['RESERVED', 'UNKNOWN', undefined],
  T13: ['UNKNOWN', 'APPROVED', 'APPROVED'],
  T14: ['UNKNOWN', 'AWAITING_DEPOSIT', 'AWAITING_DEPOSIT'],
  T15: ['UNKNOWN', 'FAILED', 'FAILED'],
  T16: ['AWAITING_DEPOSIT', 'APPROVED', 'APPROVED'],
  T17: ['AWAITING_DEPOSIT', 'FAILED', 'FAILED'],
  T18: ['APPROVED', 'CONFIRMED', 'CONFIRMED'],
  T19: ['APPROVED', 'APPROVED', undefined],
  T20: ['APPROVED', 'COMPENSATED', 'COMPENSATED'],
  T21: ['CONFIRMED', 'AWAITING_DEPOSIT', 'DEPOSIT_REVERSED'],
  T22: ['CONFIRMED', 'PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'],
  T23: ['PARTIALLY_REFUNDED', 'REFUNDED', 'REFUNDED'],
  T24: ['CONFIRMED', 'REFUNDED', 'REFUNDED'],
  T25: ['PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'],
  T26: ['REFUNDED', 'REFUNDED', 'REFUNDED'],
};

/**
 * 결제 결과 반영 전이(T9~T17과 T21 입금 되돌림): 결제 사건 순번이 있어야 하고 payment_event_seq < 순번일 때만 바꾼다(payment §3, ADR-0146 결정 2).
 * T21은 결제사가 입금 완료를 되돌린 결제 사건으로 오므로 같은 순번 조건을 건다(리뷰 2026-11-05)
 */
export const PAYMENT_RESULT: ReadonlySet<string> = new Set(['T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T21']);

/** firstInStage를 세는 도착 상태(payment §3, ADR-0099) */
export const STAGE: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['ACCEPTED', 'APPROVED', 'CONFIRMED']);

/** 주문 생성(T1) 뒤 그 출발 상태에 이르는 전이 길. 나가는 전이가 있는 상태만 둔다 */
export const PATH_TO: Readonly<Partial<Record<OrderStatus, readonly TransitionId[]>>> = {
  CREATED: [],
  AUTHENTICATED: ['T3'],
  ACCEPTED: ['T3', 'T4'],
  RESERVED: ['T3', 'T4', 'T7'],
  AWAITING_DEPOSIT: ['T3', 'T4', 'T7', 'T10'],
  UNKNOWN: ['T3', 'T4', 'T7', 'T12'],
  APPROVED: ['T3', 'T4', 'T7', 'T9'],
  CONFIRMED: ['T3', 'T4', 'T7', 'T9', 'T18'],
  PARTIALLY_REFUNDED: ['T3', 'T4', 'T7', 'T9', 'T18', 'T22'],
  REFUNDED: ['T3', 'T4', 'T7', 'T9', 'T18', 'T24'],
};

/** 전이의 도착 상태(표에 없으면 던진다) */
export function toOf(t: string): OrderStatus {
  const row = TABLE[t];
  if (!row) throw new Error(`시험 표에 없는 전이: ${t}`);
  return row[1];
}

/** Saga·만료·정비가 쓰는 행위자(system:<작업 이름>) */
export const SAGA = 'system:order-saga';
export const accountActor = (accountId: string): string => `account:${accountId}`;
export const adminActor = (adminId: string): string => `admin:${adminId}`;

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 UUID 글(RFC 9562) */
export function uuid8(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input, 'utf8').digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 주문 사건의 eventKey(정본: UUID 버전 8(SHA-256('OrderEvent:' + 주문 ID + ':' + 이력 번호)의 앞 16바이트), payment §3) */
export const orderEventKeyOf = (orderId: string, seq: number): string => uuid8(`OrderEvent:${orderId}:${seq}`);

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * 주문 항목 n개. 좌석 ID를 내림차순으로 두어 받은 차례가 좌석 ID 정렬 차례와 다르다(줄 번호는 받은 차례로 매긴다, NewOrder.items).
 * 마지막 항목은 0원(unit_price >= 0의 경계)이다
 */
export function makeItems(n: number): OrderItem[] {
  const seats = Array.from({ length: n }, () => randomUUID())
    .sort()
    .reverse();
  return seats.map((seatId, i) => ({
    seatId,
    tierId: i % 2 === 0 ? 'R' : 'VIP',
    sectionId: i % 2 === 0 ? 'SEC-B' : 'SEC-A',
    unitPrice: i === n - 1 ? 0 : 99_000 + i * 11_000,
  }));
}

/** 새 주문 입력(T1). 주문 ID는 그 시계의 UUIDv7, 계정·회차·좌석 ID는 새 UUID, 금액은 항목 가격의 합이다. 행위자는 그 계정의 팬 */
export function newOrderInput(clock: Clock, o: Partial<NewOrder> = {}): NewOrder {
  const items = o.items ?? makeItems(3);
  const accountId = o.accountId ?? randomUUID();
  return {
    id: uuidv7(clock),
    eventId: randomUUID(),
    amount: items.reduce((sum, it) => sum + it.unitPrice, 0),
    buyerName: '김피켓',
    buyerPhone: '01012345678',
    idempotencyKey: randomUUID(),
    consentVersion: 'consent-2026.11_v1',
    seatAssignment: 'PICK',
    created: { purchaseSessionId: randomUUID(), journeyId: uuidv7(clock), contactRef: 'c1.contact-ref-Zk3QpL0', refMissing: false },
    ...o,
    items,
    accountId,
    actor: o.actor ?? accountActor(accountId),
  };
}

/** 저장소가 돌려주는 주문 행의 기대 값 */
export const rowOf = (o: NewOrder, status: OrderStatus, eventSeq: number, paymentEventSeq = 0): OrderRow => ({
  id: o.id,
  accountId: o.accountId,
  eventId: o.eventId,
  status,
  amount: o.amount,
  eventSeq,
  paymentEventSeq,
  seatAssignment: o.seatAssignment,
});

/** 주문 사건의 items 기대 값(줄 번호 차례, price = unitPrice) */
export const eventItemsOf = (o: NewOrder) => o.items.map((it) => ({ seatId: it.seatId, tierId: it.tierId, sectionId: it.sectionId, price: it.unitPrice }));

/**
 * CREATED 사건의 기대 값(전부). purchaseSessionId·journeyId·contactRef·refMissing은 CREATED에만 싣는다(payment §3, ADR-0150·0171).
 * 정본 모호: OrderEvent.seatIds의 차례가 적혀 있지 않다. 항목 줄 번호 차례(받은 차례)로 가정한다
 */
export function createdEvent(o: NewOrder, atMs: number): Record<string, unknown> {
  return {
    eventId: o.eventId,
    orderId: o.id,
    accountId: o.accountId,
    type: 'CREATED',
    amount: o.amount,
    seatIds: o.items.map((it) => it.seatId),
    ...(o.created.purchaseSessionId === undefined ? {} : { purchaseSessionId: o.created.purchaseSessionId }),
    ...(o.created.journeyId === undefined ? {} : { journeyId: o.created.journeyId }),
    ...(o.created.contactRef === undefined ? {} : { contactRef: o.created.contactRef }),
    refMissing: o.created.refMissing,
    items: eventItemsOf(o),
    seatAssignment: o.seatAssignment,
    firstInStage: false,
    occurredAt: iso(atMs),
    eventKey: orderEventKeyOf(o.id, 1),
  };
}

/** CREATED가 아닌 사건에서 늘 싣는 칸의 기대 값(seatAssignment·items의 등급·구역은 뒤 사건에도 싣는다, ADR-0150) */
export function laterEvent(o: NewOrder, type: OrderEventType, seq: number, atMs: number, firstInStage: boolean): Record<string, unknown> {
  return {
    eventId: o.eventId,
    orderId: o.id,
    accountId: o.accountId,
    type,
    amount: o.amount,
    seatIds: o.items.map((it) => it.seatId),
    items: eventItemsOf(o),
    seatAssignment: o.seatAssignment,
    firstInStage,
    occurredAt: iso(atMs),
    eventKey: orderEventKeyOf(o.id, seq),
  };
}

/** CREATED에만 싣는 칸(뒤 사건에는 없어야 한다) */
export const CREATED_ONLY = ['purchaseSessionId', 'journeyId', 'contactRef'] as const;

/**
 * 건드리면 던지는 트랜잭션 대역. 입력 검사가 DB에 가기 전에 던지는지 본다(무엇이든 읽으면 touched에 남고 던진다)
 */
export function untouchableTx(): { tx: DbTransaction; touched: string[] } {
  const touched: string[] = [];
  const tx = new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(String(prop));
        throw new Error(`DB에 갔다: tx.${String(prop)}`);
      },
    },
  ) as unknown as DbTransaction;
  return { tx, touched };
}

/** 오류와 그 원인 사슬(Drizzle은 질의 오류를 DrizzleQueryError로 감싸고 원래 pg 오류를 cause에 둔다) */
export function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let e: unknown = err;
  for (let i = 0; i < 8 && e !== undefined && e !== null; i += 1) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}
/** 원인 사슬의 PostgreSQL 오류 코드들 */
export const pgCodesOf = (err: unknown): string[] =>
  errorChain(err)
    .map((e) => (e as { code?: unknown }).code)
    .filter((c): c is string => typeof c === 'string');
/** 원인 사슬의 메시지를 한 줄로 */
export const messagesOf = (err: unknown): string => errorChain(err).map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))).join(' <- ');

/** Promise.allSettled 결과에서 던진 것만 글로 */
export const rejections = (settled: readonly PromiseSettledResult<unknown>[]): string[] =>
  settled.flatMap((r, i) => (r.status === 'rejected' ? [`#${i}: ${messagesOf(r.reason)}`] : []));
