// 주문 사건 Avro 바이트와 업무 트랜잭션을 실제 PostgreSQL 18로 돈다(F-04-2 계획 §6 A-T26 ⑤·①, ADR-0357 결정 8, ADR-0150 결정 5).
// 고객 취소로 끝난 주문의 REFUNDED는 그 전이를 일으킨 취소의 환급액(order_cancellation.refund_amount)을 refundAmount로 싣는다(asyncapi OrderEvent.refundAmount, 시험 이의 받아들임).
// 주문 전이 함수(DrizzleOrderStore)에 운영 조립과 같은 Avro 코덱(avroOrderEventCodec + 공용 인코더)을 주고, 주문 생성 한 트랜잭션을 본다.
// 정본: 주문 사건을 만들지 못하면 그 업무 트랜잭션이 실패해 주문이 생기지 않는다(A-T26 ⑤), Outbox 값은 매직 바이트 0 + 설정의 주제 ID + 계약 판 Avro(README §3).
// DB 상태는 어댑터를 거치지 않고 admin 풀의 직접 SQL로 읽는다. 스키마 ID는 코드 상수와 겹치지 않게 19로 고른다.
import { randomUUID } from 'node:crypto';
import { avroSchemas } from '@peaket/contracts/avro';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { AvroEncodeError, createAvroEncoder } from '@peaket/platform/avro';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeProduced } from '../../../packages/platform/test/produced-avro.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { avroOrderEventCodec, DrizzleOrderStore, ORDER_EVENT_RECORD, type TransitionId, TRADE_ORDERS_TOPIC } from '../src/modules/booking/index.js';
import { DrizzleCancellationWrites } from '../src/modules/refund/index.js';
import { BASE_MS, makeItems, newOrderInput, PATH_TO, PAYMENT_RESULT, SAGA } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const SUBJECT = 'trade.orders-peaket.trade.OrderEvent';
const SCHEMA_ID = 19;

let server: PostgresContainer;
let database: Database;
let admin: Database;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'order-avro-test' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 2, applicationName: 'order-avro-admin' });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close()]);
  server?.stop();
});

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[]) => Number((await q<{ n: string }>(text, params))[0]!.n);

function store() {
  const clock = fakeClock({ now: BASE_MS });
  const codec = avroOrderEventCodec(createAvroEncoder({ schemaIds: { [SUBJECT]: SCHEMA_ID }, schemas: avroSchemas, produces: [{ topic: TRADE_ORDERS_TOPIC, record: ORDER_EVENT_RECORD }] }));
  return { clock, store: new DrizzleOrderStore({ clock, codec }) };
}

describe('A-T26 ⑤ 주문 사건 인코딩 실패와 주문 생성 트랜잭션', () => {
  test('A-T26 ⑤ 주문 사건을 만들지 못하면 주문이 생기지 않는다', async () => {
    const s = store();
    // CREATED 사건에 구매 세션 ID가 없다(x-present-when type CREATED): 계약을 채우지 못한다
    const bad = newOrderInput(s.clock, { items: makeItems(2), created: { refMissing: true } });
    await expect(database.transaction((tx) => s.store.createOrder(tx, bad))).rejects.toBeInstanceOf(AvroEncodeError);
    expect(await count('select count(*) as n from purchase_order where id = $1', [bad.id])).toBe(0);
    expect(await count('select count(*) as n from order_item where order_id = $1', [bad.id])).toBe(0);
    expect(await count('select count(*) as n from order_event where order_id = $1', [bad.id])).toBe(0);
    expect(await count('select count(*) as n from outbox where msg_key = $1', [bad.eventId])).toBe(0);

    // 계약을 채운 주문은 만든다(위 0건이 '무엇이든 실패'로 통과하지 않게). Outbox 값은 계약 판 Avro다
    const good = newOrderInput(s.clock, { items: makeItems(2) });
    await database.transaction((tx) => s.store.createOrder(tx, good));
    expect(await count('select count(*) as n from purchase_order where id = $1', [good.id])).toBe(1);
    const rows = await q<{ topic: string; payload: Buffer }>('select topic, payload from outbox where msg_key = $1', [good.eventId]);
    expect(rows.map((r) => r.topic)).toEqual(['trade.orders']);
    const payload = Buffer.from(rows[0]!.payload);
    expect([...payload.subarray(0, 5)]).toEqual([0, 0, 0, 0, SCHEMA_ID]);
    const p = decodeProduced(payload, ORDER_EVENT_RECORD);
    expect(p.violations).toEqual([]);
    expect(p.value).toMatchObject({ type: 'CREATED', orderId: good.id, eventId: good.eventId, accountId: good.accountId, amount: good.amount, purchaseSessionId: good.purchaseSessionId, refMissing: false, occurredAt: BASE_MS });
  });
});

describe('A-T26 ① 고객 취소로 끝난 주문의 REFUNDED(T23·T24) — 저장소 경로', () => {
  /** 주문을 만들고 CONFIRMED까지 보낸다(결제 결과 반영 전이에는 결제 사건 순번을 준다) */
  async function confirmed(s: ReturnType<typeof store>, unitPrices: number[]) {
    const items = unitPrices.map((unitPrice) => ({ seatId: randomUUID(), tierId: 'R', sectionId: 'SEC-A', unitPrice }));
    const o = newOrderInput(s.clock, { items });
    await database.transaction((tx) => s.store.createOrder(tx, o));
    let pay = 0;
    for (const t of PATH_TO.CONFIRMED as readonly TransitionId[]) {
      const r = await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition: t, actor: SAGA, ...(PAYMENT_RESULT.has(t) ? { paymentEventSeq: ++pay } : {}) }));
      expect(r.status, t).toBe('APPLIED');
    }
    return o;
  }
  /** 취소 행 하나(공제 10% [시험 값]: 환급액 = 단가 − 공제) */
  const cancel = (w: DrizzleCancellationWrites, orderId: string, price: number, status: 'REFUND_PENDING' | 'REFUNDED') => {
    const deductionAmount = Math.round(price * 0.1);
    return w.create({
      cancellationId: randomUUID(),
      orderId,
      ticketId: randomUUID(),
      reason: 'USER',
      daysBefore: 7,
      within24h: false,
      deductionBp: 1000,
      deductionAmount,
      refundAmount: price - deductionAmount,
      status,
      nowMs: BASE_MS,
      actor: SAGA,
    });
  };
  /** 그 회차 Outbox의 REFUNDED 사건(계약 판으로 풀고 공통 판정을 본다) */
  async function refundedEvents(eventId: string) {
    const rows = await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by id', [eventId]);
    return rows
      .map((r) => decodeProduced(Buffer.from(r.payload), ORDER_EVENT_RECORD))
      .filter((p) => p.value.type === 'REFUNDED')
      .map((p) => {
        expect(p.schemaId).toBe(SCHEMA_ID);
        expect(p.violations).toEqual([]);
        return p.value;
      });
  }

  test('A-T26 ① 취소 쓰기가 주문을 REFUNDED로 끝내면 Outbox 바이트의 refundAmount가 그 취소의 refund_amount다', async () => {
    const s = store();
    const writes = new DrizzleCancellationWrites(database, s.store);

    // T24: 표 하나짜리 확정 주문을 환급 완료 취소로 바로 끝낸다(77,000원 − 공제 7,700원 = 69,300원, 주문 금액과 다르다)
    const one = await confirmed(s, [77_000]);
    expect((await cancel(writes, one.id, 77_000, 'REFUNDED')).status).toBe('CREATED');
    const [cancelOne] = await q<{ refund_amount: number }>('select refund_amount from order_cancellation where order_id = $1', [one.id]);
    expect(cancelOne!.refund_amount).toBe(69_300);
    const e1 = await refundedEvents(one.eventId);
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ orderId: one.id, amount: 77_000, refundAmount: 69_300 });

    // T22 → T23: 표 둘. 첫 표는 환급 완료(T22 부분 환불), 둘째 표는 환급 대기로 만든 뒤 환급 완료가 주문을 끝낸다(T23).
    // REFUNDED의 refundAmount는 그 전이를 일으킨 둘째 취소의 환급액이다(합계·주문 금액이 아니다)
    const two = await confirmed(s, [55_000, 41_000]);
    expect((await cancel(writes, two.id, 55_000, 'REFUNDED')).status).toBe('CREATED');
    expect((await cancel(writes, two.id, 41_000, 'REFUND_PENDING')).status).toBe('CREATED');
    expect(await refundedEvents(two.eventId)).toEqual([]);
    const [pending] = await q<{ id: string; refund_amount: number }>("select id, refund_amount from order_cancellation where order_id = $1 and status = 'REFUND_PENDING'", [two.id]);
    expect(pending!.refund_amount).toBe(36_900);
    expect(await writes.updateStatus({ cancellationId: pending!.id, status: 'REFUNDED', nowMs: BASE_MS + 1_000 })).toBe(true);
    const [status] = await q<{ status: string }>('select status from purchase_order where id = $1', [two.id]);
    expect(status!.status).toBe('REFUNDED');
    const e2 = await refundedEvents(two.eventId);
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({ orderId: two.id, amount: 96_000, refundAmount: 36_900 });
  });
});
