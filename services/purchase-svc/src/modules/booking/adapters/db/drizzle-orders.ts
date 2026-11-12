// 주문 전이 함수와 주문 만들기(purchase DB, Drizzle). 주문 상태를 바꾸는 SQL은 이 파일에만 있다(ADR-0113 결정 2, docs/features/payment.md §3 '주문 저장소의 첫 구현', BUILD_ORDER PRF-160).
// 두 함수 모두 부르는 쪽의 트랜잭션 안에서 돈다(멱등 기록·판매 행과 같은 트랜잭션). Outbox 행은 마지막 문장이다(ADR-0116 결정 3).
// - 입력이 틀리면 DB에 가기 전에 RangeError를 던진다(코드 오류). DB 오류는 잡지 않고 그대로 던진다(바깥 트랜잭션이 되돌린다).
// - 조건이 맞지 않는 전이는 0행이라 아무것도 쓰지 않고 STALE을 돌려준다. 같은 주문의 두 전이가 겹치면 행 쓰기 잠금에서 줄을 서고,
//   뒤 쪽은 앞 쪽이 커밋한 뒤 조건을 다시 평가해 0행이 된다(READ COMMITTED, data.md §5 '주문 상태 전이').
// - 좌석·주문 ID 묶음은 `array[$1::uuid, …]`로 넘긴다(drizzle의 sql 템플릿은 배열 값을 나열로 펼친다, inventory drizzle-seat-sales.ts와 같다).
import { type Clock, type Database, type DbTransaction, type OutboxMessage, writeOutbox } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import {
  ACTOR_PATTERN,
  buildOrderEvent,
  FIRST_IN_STAGE_STATUSES,
  ORDER_HISTORY_BATCH,
  orderEventType,
  PAYMENT_RESULT_TRANSITIONS,
  transitionById,
  type OrderItem,
  type OrderRow,
  type OrderStatus,
  type OrderTransition,
  type SeatAssignment,
} from '../../domain/order.js';
import type { NewOrder, OrderEventCodec, OrderHistoryMismatch, OrderHistoryReport, TransitionInput, TransitionResult } from '../../domain/ports.js';
import { jsonOrderEventCodec, TRADE_ORDERS_TOPIC } from '../order-events.js';

export interface DrizzleOrderStoreOptions {
  clock: Clock;
  /** 기본은 JSON 대역(jsonOrderEventCodec) */
  codec?: OrderEventCodec;
}

// ---- 입력 검사(DB에 가기 전) ----

/** 표의 uuid 글(소문자). 좌석 판매 저장소와 같은 모양이다(inventory SALE_UUID_PATTERN) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 소문자로 맞춘 UUID v4(Idempotency-Key, platform parseIdempotencyKey가 돌려주는 모양) */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 여정 ID(UUIDv7). 사건 계약이 RFC 9562 UUID라(zod uuid) 판 자리 1~8·변형 자리 8~b인 소문자 UUID만 받는다 */
const JOURNEY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 두 동의에 보인 고지 문안의 판 */
const CONSENT_VERSION = /^[0-9A-Za-z._-]{1,32}$/;
/** 구매 세션 ID(입장 토큰 jti). 좌석 Redis 키 조각과 같은 모양이다(inventory KEY_PART) */
const PURCHASE_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** PostgreSQL int4 최댓값(amount·unit_price 칸) */
const INT4_MAX = 2_147_483_647;
/** 주문 하나의 좌석 수 상한 [가정: 주문 하나 10석 이하] */
const MAX_ITEMS = 10;
/** 등급·구역 ID 글 길이 상한 */
const ITEM_TEXT_MAX = 64;
const SEAT_ASSIGNMENTS: ReadonlySet<string> = new Set<SeatAssignment>(['PICK', 'AUTO']);

const T1 = transitionById('T1')!;
const T3 = transitionById('T3')!;
const T4 = transitionById('T4')!;
/**
 * 결제 결과 반영 전이 가운데 결제 사건 순번 없이도 받는 것: T11(RESERVED → FAILED). Saga가 승인 기한을 넘겨 끝낼 때는 결제 사건이 없어
 * 상태 조건만으로 바꾼다(payment §3 '주문 저장소의 첫 구현', 추천 적용 2026-11-05, BUILD_ORDER PRF-165)
 */
const SEQ_OPTIONAL_TRANSITIONS: ReadonlySet<string> = new Set(['T11']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function assertUuid(v: unknown, name: string): void {
  if (typeof v !== 'string' || !UUID.test(v)) throw new RangeError(`${name}가 소문자 UUID가 아니다`);
}

function assertInt4(v: unknown, name: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > INT4_MAX) throw new RangeError(`${name}는 0~${INT4_MAX}의 정수여야 한다: ${String(v)}`);
}

/** 예매자 성명·번호 글 길이 상한 [가정: 100자] */
const BUYER_TEXT_MAX = 100;

function assertBuyerText(v: unknown, name: string): void {
  if (typeof v !== 'string' || v.length === 0 || v.length > BUYER_TEXT_MAX) throw new RangeError(`${name}는 1~${BUYER_TEXT_MAX}자 글이어야 한다`);
}

function assertActor(v: unknown): void {
  if (typeof v !== 'string' || !ACTOR_PATTERN.test(v)) throw new RangeError('행위자(actor)가 account:<UUID>·admin:<UUID>·system:<작업 이름> 모양이 아니다');
}

function assertNewOrder(o: NewOrder): void {
  if (!isObject(o)) throw new RangeError('주문 입력이 객체가 아니다');
  assertUuid(o.id, 'id');
  assertUuid(o.accountId, 'accountId');
  assertUuid(o.eventId, 'eventId');
  assertInt4(o.amount, 'amount');
  if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > MAX_ITEMS) throw new RangeError(`items는 1~${MAX_ITEMS}개여야 한다`);
  const seats = new Set<string>();
  o.items.forEach((item: unknown, i) => {
    if (!isObject(item)) throw new RangeError(`items[${i}]가 객체가 아니다`);
    assertUuid(item.seatId, `items[${i}].seatId`);
    if (seats.has(item.seatId as string)) throw new RangeError('items에 같은 좌석이 두 번 있다');
    seats.add(item.seatId as string);
    for (const k of ['tierId', 'sectionId'] as const) {
      const v = item[k];
      if (typeof v !== 'string' || v.length < 1 || v.length > ITEM_TEXT_MAX) throw new RangeError(`items[${i}].${k}는 1~${ITEM_TEXT_MAX}자 글이어야 한다`);
    }
    assertInt4(item.unitPrice, `items[${i}].unitPrice`);
  });
  if (typeof o.idempotencyKey !== 'string' || !UUID_V4.test(o.idempotencyKey)) throw new RangeError('idempotencyKey가 소문자 UUID v4가 아니다');
  if (typeof o.consentVersion !== 'string' || !CONSENT_VERSION.test(o.consentVersion)) throw new RangeError('consentVersion은 1~32자의 영문·숫자·._-여야 한다');
  assertBuyerText(o.buyerName, 'buyerName');
  assertBuyerText(o.buyerPhone, 'buyerPhone');
  if (typeof o.seatAssignment !== 'string' || !SEAT_ASSIGNMENTS.has(o.seatAssignment)) throw new RangeError('seatAssignment는 PICK·AUTO 가운데 하나다');
  assertActor(o.actor);
  // 0004(PRF-161): 주문을 만든 홀드(소문자 UUID, hold_id 유일)와 구매 세션(입장 토큰 jti, 1~64자 키 조각 글)
  assertUuid(o.holdId, 'holdId');
  if (typeof o.purchaseSessionId !== 'string' || !PURCHASE_SESSION_ID.test(o.purchaseSessionId)) throw new RangeError('purchaseSessionId가 1~64자의 영문·숫자·_-가 아니다');
  const c: unknown = o.created;
  if (!isObject(c)) throw new RangeError('created가 객체가 아니다');
  if (c.journeyId !== undefined && (typeof c.journeyId !== 'string' || !JOURNEY_UUID.test(c.journeyId))) throw new RangeError('created.journeyId가 UUID가 아니다');
  if (c.purchaseSessionId !== undefined && typeof c.purchaseSessionId !== 'string') throw new RangeError('created.purchaseSessionId가 글이 아니다');
  // CREATED 사건의 구매 세션은 주문 행의 구매 세션과 같은 값이다(NewOrder.purchaseSessionId 설명)
  if (c.purchaseSessionId !== undefined && c.purchaseSessionId !== o.purchaseSessionId) throw new RangeError('created.purchaseSessionId가 purchaseSessionId와 다르다');
  if (c.contactRef !== undefined && typeof c.contactRef !== 'string') throw new RangeError('created.contactRef가 글이 아니다');
  if (typeof c.refMissing !== 'boolean') throw new RangeError('created.refMissing이 불리언이 아니다');
  // 조사용 가명은 계산하지 못했을 때만 비운다(refMissing 참 ⇔ contactRef 없음, 계약 OrderEvent.refMissing)
  if (c.refMissing !== (c.contactRef === undefined)) throw new RangeError('created.refMissing은 contactRef가 없을 때만 참이다(둘이 맞지 않는다)');
}

/** 전이 입력을 검사하고 표의 전이를 돌려준다 */
function transitionOf(input: TransitionInput): OrderTransition & { from: OrderStatus } {
  if (!isObject(input)) throw new RangeError('전이 입력이 객체가 아니다');
  const t = typeof input.transition === 'string' ? transitionById(input.transition) : undefined;
  if (!t) throw new RangeError(`전이 표에 없는 전이다: ${String(input.transition)}`);
  if (t.from === null) throw new RangeError('T1(주문 생성)은 createOrder로 한다');
  assertActor(input.actor);
  assertUuid(input.orderId, 'orderId');
  const seq = input.paymentEventSeq;
  if (PAYMENT_RESULT_TRANSITIONS.has(t.id)) {
    // T11은 순번 없이도 받는다(Saga가 승인 명령을 접수시키지 못한 채 승인 기한을 넘김, 결제 사건이 없다). 주면 다른 결제 결과 전이처럼 조건을 건다(PRF-165)
    if (seq === undefined && SEQ_OPTIONAL_TRANSITIONS.has(t.id)) return t as OrderTransition & { from: OrderStatus };
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`결제 결과 반영 전이(${t.id})에는 양의 정수 paymentEventSeq가 있어야 한다`);
  } else if (seq !== undefined) {
    throw new RangeError(`paymentEventSeq는 결제 결과 반영 전이(T9~T17·T21)에만 준다: ${t.id}`);
  }
  return t as OrderTransition & { from: OrderStatus };
}

// ---- 행 바꾸기 ----

type Executor = Pick<DbTransaction, 'execute'>;

const uuidArray = (ids: readonly string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;

/** RETURNING·SELECT의 주문 칸(이 차례로 읽는다) */
const ORDER_COLUMNS = sql.raw('id, account_id, event_id, status, amount, event_seq, payment_event_seq, seat_assignment');

type OrderDbRow = {
  id: string;
  account_id: string;
  event_id: string;
  status: string;
  amount: number;
  event_seq: number;
  /** bigint는 글로 온다 */
  payment_event_seq: string | number;
  seat_assignment: string;
};

const orderRowOf = (r: OrderDbRow): OrderRow => ({
  id: r.id,
  accountId: r.account_id,
  eventId: r.event_id,
  status: r.status as OrderStatus,
  amount: Number(r.amount),
  eventSeq: Number(r.event_seq),
  paymentEventSeq: Number(r.payment_event_seq),
  seatAssignment: r.seat_assignment as SeatAssignment,
});

const isDatabase = (db: Database | DbTransaction): db is Database => 'pool' in db && 'db' in db;

export class DrizzleOrderStore {
  private readonly codec: OrderEventCodec;

  constructor(private readonly o: DrizzleOrderStoreOptions) {
    this.codec = o.codec ?? jsonOrderEventCodec;
  }

  /**
   * 주문 행·항목·이력 1(T1, 출발 비움)·Outbox(CREATED)를 바깥 트랜잭션에 쓴다.
   * @throws RangeError 입력이 틀림(DB에 가지 않는다)
   */
  async createOrder(tx: DbTransaction, order: NewOrder): Promise<{ seq: 1; outboxId: string }> {
    assertNewOrder(order);
    const now = this.o.clock.now();
    const at = new Date(now);
    const row: OrderRow = {
      id: order.id,
      accountId: order.accountId,
      eventId: order.eventId,
      status: T1.to,
      amount: order.amount,
      eventSeq: 1,
      paymentEventSeq: 0,
      seatAssignment: order.seatAssignment,
    };
    // 사건을 먼저 만든다(순수 계산). 시각이 날짜 범위 밖이면 DB에 가기 전에 던진다. CREATED는 단계 목록 밖이라 firstInStage는 거짓이다
    const message = buildOrderEvent({ order: row, items: order.items, transition: T1, seq: 1, occurredAtMs: now, reachedBefore: false, created: order.created });
    if (!message) throw new Error('T1은 CREATED 사건을 낸다');
    // 주문·항목·이력 1을 한 문장(CTE)으로 묶는다(BAT-035). 항목·이력은 같은 주문 ID를 쓰므로 왕복 세 번을 한 번으로 줄인다
    const lines = order.items.map((item, i) => sql`(${i + 1}::int, ${item.seatId}::uuid, ${item.tierId}, ${item.sectionId}, ${item.unitPrice}::int)`);
    await tx.execute(sql`
      with o as (
        insert into purchase_order (id, account_id, event_id, status, amount, event_seq, payment_event_seq, buyer_name, buyer_phone, idempotency_key, consent_version, seat_assignment, created_at,
                                    hold_id, purchase_session_id)
        values (${order.id}::uuid, ${order.accountId}::uuid, ${order.eventId}::uuid, ${T1.to}, ${order.amount}::int, 1, 0,
                ${order.buyerName}, ${order.buyerPhone}, ${order.idempotencyKey}, ${order.consentVersion}, ${order.seatAssignment}, ${at}::timestamptz,
                ${order.holdId}::uuid, ${order.purchaseSessionId})
        returning id
      ), items as (
        insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price)
        select o.id, v.line_no, v.seat_id, v.tier, v.section_id, v.unit_price
        from o cross join (values ${sql.join(lines, sql`, `)}) as v(line_no, seat_id, tier, section_id, unit_price)
      ), ev as (
        insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
        select o.id, 1, null, ${T1.to}, ${T1.id}, ${order.actor}, ${at}::timestamptz from o
      )
      select id from o`);
    // 마지막 문장(ADR-0116 결정 3). Kafka 키는 회차 ID다
    const [outboxId] = await writeOutbox(tx, this.o.clock, [{ topic: TRADE_ORDERS_TOPIC, key: order.eventId, payload: this.codec.encode(message) }]);
    return { seq: 1, outboxId: outboxId! };
  }

  /**
   * 전이 하나를 바깥 트랜잭션에서 한다: 조건부 UPDATE(출발 상태, 결제 결과면 순번) → order_event → Outbox(사건이 있는 전이만).
   * 조건이 맞지 않으면 STALE을 돌려준다(던지지 않는다).
   * T11은 순번 없이도 받는다(그때는 상태 조건만, PRF-165).
   * @throws RangeError 표에 없는 전이, 행위자 모양 틀림, 결제 결과 전이에 순번 없음(T11은 빼고)·결제 결과가 아닌 전이에 순번 있음, T1(createOrder로 한다)
   */
  async transition(tx: DbTransaction, input: TransitionInput): Promise<TransitionResult> {
    const t = transitionOf(input);
    const paymentSeq = PAYMENT_RESULT_TRANSITIONS.has(t.id) ? input.paymentEventSeq : undefined;
    // ① 조건부 UPDATE 한 문장: 출발 상태일 때만(결제 결과면 반영한 순번보다 클 때만) 바꾸고 이력 번호를 1 올린다
    const setPayment = paymentSeq === undefined ? sql`` : sql`, payment_event_seq = ${paymentSeq}::bigint`;
    const wherePayment = paymentSeq === undefined ? sql`` : sql` and payment_event_seq < ${paymentSeq}::bigint`;
    const updated = await tx.execute(sql`
      update purchase_order set status = ${t.to}, event_seq = event_seq + 1${setPayment}
      where id = ${input.orderId}::uuid and status = ${t.from}${wherePayment}
      returning ${ORDER_COLUMNS}`);
    const changed = updated.rows[0] as OrderDbRow | undefined;
    if (!changed) return staleOf(tx, input.orderId, t, paymentSeq);
    const order = orderRowOf(changed);
    const seq = order.eventSeq;
    const now = this.o.clock.now();
    // ② 돌려받은 번호로 이력 한 행
    await tx.execute(sql`
      insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
      values (${order.id}::uuid, ${seq}::int, ${t.from}, ${t.to}, ${t.id}, ${input.actor}, ${new Date(now)}::timestamptz)`);
    // 사건이 없는 전이(도착 AUTHENTICATED·UNKNOWN, T2·T19)는 이력만 쓴다
    if (orderEventType(t) === undefined) return { status: 'APPLIED', seq, order };
    const reachedBefore = FIRST_IN_STAGE_STATUSES.has(t.to) ? await reachedBeforeOf(tx, order.id, t.to, seq) : false;
    const items = await itemsOf(tx, order.id);
    const message = buildOrderEvent({ order, items, transition: t, seq, occurredAtMs: now, reachedBefore });
    if (!message) throw new Error(`사건 종류가 있는 전이인데 사건이 없다: ${t.id}`);
    // ③ 마지막 문장
    const [outboxId] = await writeOutbox(tx, this.o.clock, [{ topic: TRADE_ORDERS_TOPIC, key: order.eventId, payload: this.codec.encode(message) }]);
    return { status: 'APPLIED', seq, order, outboxId: outboxId! };
  }

  /**
   * 결제 접수의 T3(CREATED→AUTHENTICATED)·T4(AUTHENTICATED→ACCEPTED)를 한 UPDATE와 한 order_event 묶음으로 쓴다(BAT-035).
   * T3는 사건이 없고, T4만 ACCEPTED 사건을 만든다. Outbox 행은 호출자가 업무 문장의 마지막에 쓴다(ADR-0116 결정 3).
   * 두 전이를 따로 부르면 주문 행 UPDATE와 order_event INSERT가 두 번씩 나가 연결 보유 시간이 길어지므로, 한 트랜잭션 안에서 한 번에 쓴다.
   * 반환 모양은 transition과 같다(0행이면 STALE). 호출자는 APPLIED가 아니면 트랜잭션째 되돌린다.
   * @throws RangeError orderId·actor·seatGen 모양이 틀림
   */
  async acceptTransitions(
    tx: DbTransaction,
    input: { orderId: string; actor: string; seatGen: number; at: Date },
  ): Promise<{ status: 'APPLIED'; seq: number; order: OrderRow; outbox: OutboxMessage } | Extract<TransitionResult, { status: 'STALE' }>> {
    assertUuid(input.orderId, 'orderId');
    assertActor(input.actor);
    assertInt4(input.seatGen, 'seatGen');
    // ① T3·T4를 한 조건부 UPDATE로: 출발 상태 CREATED일 때만 ACCEPTED로 두 칸 올리고 seat_gen도 같은 문장에서 쓴다
    const updated = await tx.execute(sql`
      update purchase_order
         set status = ${T4.to}, event_seq = event_seq + 2, seat_gen = ${input.seatGen}::int
       where id = ${input.orderId}::uuid and status = ${T3.from}
       returning ${ORDER_COLUMNS}`);
    const changed = updated.rows[0] as OrderDbRow | undefined;
    if (!changed) return staleOf(tx, input.orderId, T3, undefined);
    const order = orderRowOf(changed);
    const seq = order.eventSeq;
    // ② T3·T4 이력을 한 문장으로(순번은 새 event_seq의 앞 두 칸)
    await tx.execute(sql`
      insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
      values (${order.id}::uuid, ${seq - 1}::int, ${T3.from}, ${T3.to}, ${T3.id}, ${input.actor}, ${input.at}::timestamptz),
             (${order.id}::uuid, ${seq}::int, ${T4.from}, ${T4.to}, ${T4.id}, ${input.actor}, ${input.at}::timestamptz)`);
    // ③ T4 사건: ACCEPTED가 이 주문 이력에 처음인지 보고(첫 단계 퍼널), 항목은 한 번만 읽는다
    const reachedBefore = await reachedBeforeOf(tx, order.id, T4.to, seq);
    const items = await itemsOf(tx, order.id);
    const message = buildOrderEvent({ order, items, transition: T4, seq, occurredAtMs: input.at.getTime(), reachedBefore });
    if (!message) throw new Error('T4는 ACCEPTED 사건을 낸다');
    return { status: 'APPLIED', seq, order, outbox: { topic: TRADE_ORDERS_TOPIC, key: order.eventId, payload: this.codec.encode(message) } };
  }

  /** 주문 행 하나(없으면 undefined) */
  async getOrder(db: Database | DbTransaction, orderId: string): Promise<OrderRow | undefined> {
    assertUuid(orderId, 'orderId');
    const exec: Executor = isDatabase(db) ? db.db : db;
    const r = await exec.execute(sql`select ${ORDER_COLUMNS} from purchase_order where id = ${orderId}::uuid`);
    const row = r.rows[0] as OrderDbRow | undefined;
    return row ? orderRowOf(row) : undefined;
  }
}

/**
 * 전이하지 않은 까닭을 가른다: 주문 없음, 지금 상태가 출발이 아님, 상태는 출발이지만 그 순번 이상을 이미 반영함.
 * UPDATE와 이 조회 사이에 다른 트랜잭션이 상태를 바꿨을 수 있어, 순번 조건이 지금도 막는 때만 PAYMENT_SEQ로 본다
 */
async function staleOf(tx: Executor, orderId: string, t: OrderTransition, paymentSeq: number | undefined): Promise<Extract<TransitionResult, { status: 'STALE' }>> {
  const r = await tx.execute(sql`select status, payment_event_seq from purchase_order where id = ${orderId}::uuid`);
  const row = r.rows[0] as { status: string; payment_event_seq: string | number } | undefined;
  if (!row) return { status: 'STALE', reason: 'NOT_FOUND' };
  const current = row.status as OrderStatus;
  if (current === t.from && paymentSeq !== undefined && Number(row.payment_event_seq) >= paymentSeq) return { status: 'STALE', reason: 'PAYMENT_SEQ' };
  return { status: 'STALE', reason: 'STATUS', current };
}

/** 그 주문 이력에 같은 도착 상태가 이 번호 앞에 있었나(firstInStage) */
async function reachedBeforeOf(tx: Executor, orderId: string, to: OrderStatus, seq: number): Promise<boolean> {
  const r = await tx.execute(sql`
    select exists(select 1 from order_event where order_id = ${orderId}::uuid and to_status = ${to} and seq < ${seq}::int) as reached`);
  return (r.rows[0] as { reached: boolean } | undefined)?.reached === true;
}

/** 주문 항목(줄 번호 차례) */
async function itemsOf(tx: Executor, orderId: string): Promise<OrderItem[]> {
  const r = await tx.execute(sql`select seat_id, tier, section_id, unit_price from order_item where order_id = ${orderId}::uuid order by line_no`);
  return (r.rows as { seat_id: string; tier: string; section_id: string; unit_price: number }[]).map((x) => ({
    seatId: x.seat_id,
    tierId: x.tier,
    sectionId: x.section_id,
    unitPrice: Number(x.unit_price),
  }));
}

// ---- 매일 상태·이력 검사 ----

/** 묶음의 주문마다 이력 행 수·마지막 번호·마지막 도착과 주문 행을 한 질의로 견줘, 어긋난 것만 돌려준다 */
async function mismatchesOf(database: Database, orderIds: readonly string[]): Promise<OrderHistoryMismatch[]> {
  const r = await database.db.execute(sql`
    select o.id as order_id, o.status, o.event_seq, h.row_count, h.last_seq, h.last_to
    from purchase_order o
    cross join lateral (
      select count(*)::int as row_count, max(e.seq) as last_seq, (array_agg(e.to_status order by e.seq desc))[1] as last_to
      from order_event e where e.order_id = o.id
    ) h
    where o.id = any(${uuidArray(orderIds)})
      and (h.last_to is distinct from o.status or h.last_seq is distinct from o.event_seq or h.row_count is distinct from h.last_seq)
    order by o.id`);
  return (r.rows as { order_id: string; status: string; event_seq: number; row_count: number; last_seq: number; last_to: string }[]).map((x) => ({
    orderId: x.order_id,
    status: x.status as OrderStatus,
    eventSeq: Number(x.event_seq),
    lastSeq: Number(x.last_seq),
    rows: Number(x.row_count),
    lastTo: x.last_to as OrderStatus,
  }));
}

const validDate = (ms: number, name: string): Date => {
  const d = new Date(ms);
  if (typeof ms !== 'number' || Number.isNaN(d.getTime())) throw new RangeError(`${name}가 날짜(유닉스 밀리초)가 아니다: ${String(ms)}`);
  return d;
};

/**
 * 매일 상태·이력 검사(ADR-0113 결정 2): occurred_at이 [fromMs, toMs)인 이력이 있는 주문 ID를 범위 질의 한 번(BRIN)으로 모아 정렬한 뒤
 * batchSize(기본 1,000 [가정])씩 마지막 이력 도착 = 지금 상태, 이력 행 수 = 마지막 번호, event_seq = 마지막 번호인지 견준다.
 * 묶음마다 범위를 다시 훑지 않는다(커서로 다시 읽으면 묶음마다 BRIN 범위와 정렬을 처음부터 되풀이했다, 리뷰 2026-11-05).
 * signal이 끊기면 다음 묶음을 시작하지 않는다
 * @throws RangeError batchSize가 양의 정수가 아님, 시각이 날짜가 아님, fromMs >= toMs(DB에 가지 않는다)
 */
export async function checkOrderHistory(
  database: Database,
  o: { fromMs: number; toMs: number; batchSize?: number; signal?: AbortSignal },
): Promise<OrderHistoryReport> {
  const batch = o.batchSize ?? ORDER_HISTORY_BATCH;
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError(`batchSize는 양의 정수여야 한다: ${String(batch)}`);
  const from = validDate(o.fromMs, 'fromMs');
  const to = validDate(o.toMs, 'toMs');
  if (o.fromMs >= o.toMs) throw new RangeError('검사 범위가 비었거나 뒤집혔다(fromMs >= toMs)');
  let checked = 0;
  const mismatched: OrderHistoryMismatch[] = [];
  // 멈춤 신호(프로세스 종료)를 이미 받았으면 범위 질의도 하지 않는다(0건으로 끝)
  if (o.signal?.aborted) return { checked, mismatched };
  // 그날 이력이 생긴 주문 ID 모두(하루치 ID 글만 메모리에 든다. 주문 행·이력은 묶음마다 읽는다)
  const r = await database.db.execute(sql`
    select distinct order_id from order_event
    where occurred_at >= ${from}::timestamptz and occurred_at < ${to}::timestamptz
    order by order_id`);
  const ids = (r.rows as { order_id: string }[]).map((x) => x.order_id);
  for (let i = 0; i < ids.length; i += batch) {
    // 묶음 사이에 멈춤 신호를 본다. 끊겼으면 본 것까지만 돌려준다
    if (o.signal?.aborted) break;
    const chunk = ids.slice(i, i + batch);
    checked += chunk.length;
    mismatched.push(...(await mismatchesOf(database, chunk)));
  }
  return { checked, mismatched };
}
