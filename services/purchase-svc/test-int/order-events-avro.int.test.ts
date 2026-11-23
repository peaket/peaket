// 주문 사건 Avro 바이트와 업무 트랜잭션을 실제 PostgreSQL 18로 돈다(F-04-2 계획 §6 A-T26 ⑤·①, ADR-0357 결정 8, ADR-0150 결정 5).
// 주문 전이 함수(DrizzleOrderStore)에 운영 조립과 같은 Avro 코덱(avroOrderEventCodec + 공용 인코더)을 주고, 주문 생성 한 트랜잭션을 본다.
// 정본: 주문 사건을 만들지 못하면 그 업무 트랜잭션이 실패해 주문이 생기지 않는다(A-T26 ⑤), Outbox 값은 매직 바이트 0 + 설정의 주제 ID + 계약 판 Avro(README §3).
// DB 상태는 어댑터를 거치지 않고 admin 풀의 직접 SQL로 읽는다. 스키마 ID는 코드 상수와 겹치지 않게 19로 고른다.
import { avroSchemas } from '@peaket/contracts/avro';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { AvroEncodeError, createAvroEncoder } from '@peaket/platform/avro';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeProduced } from '../../../packages/platform/test/produced-avro.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { avroOrderEventCodec, DrizzleOrderStore, ORDER_EVENT_RECORD, TRADE_ORDERS_TOPIC } from '../src/modules/booking/index.js';
import { BASE_MS, makeItems, newOrderInput } from './order-fixtures.js';
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
