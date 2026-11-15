// A2-17 J-T26 ④(W7-audit): purchase 예매자 명단 원천(DrizzleAttendeeReader)은 SOLD 좌석이 없는 주문을 걸러서 한 페이지가 limit보다 적거나 0건이어도
// 정확한 nextCursor를 준다. 끝은 nextCursor가 null일 때뿐이다(docs/api/guidelines.md §3, docs/features/settlement.md §9). 실제 PostgreSQL 18.
// 주문·좌석 행은 저장소를 거치지 않고 표에 직접 넣는다(이 시험은 읽기 쪽만 본다).
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleAttendeeReader } from '../src/modules/booking/adapters/db/drizzle-attendee-reader.js';
import { orderItem, purchaseOrder } from '../src/modules/booking/adapters/db/schema.js';
import { seatSale } from '../src/modules/inventory/index.js';
import { BASE_MS, newOrderInput } from './order-fixtures.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let server: PostgresContainer;
let admin: Database;
let reader: DrizzleAttendeeReader;
const clock = fakeClock({ now: BASE_MS });

/** 결제 완료 주문 하나와 좌석 하나를 넣는다. seat가 RETURNED면 SOLD 좌석이 없는 주문이다 */
async function paidOrder(eventId: string, seat: 'SOLD' | 'RETURNED'): Promise<string> {
  clock.advance(1_000); // 주문 ID(UUIDv7)가 넣은 차례로 커지게 한다
  const o = newOrderInput(clock, { eventId, items: [{ seatId: randomUUID(), tierId: 'R', sectionId: 'SEC-A', unitPrice: 99_000 }] });
  const it = o.items[0]!;
  await admin.db.insert(purchaseOrder).values({
    id: o.id,
    accountId: o.accountId,
    eventId,
    status: 'CONFIRMED',
    amount: o.amount,
    eventSeq: 1,
    buyerName: o.buyerName,
    buyerPhone: o.buyerPhone,
    idempotencyKey: o.idempotencyKey,
    consentVersion: o.consentVersion,
    seatAssignment: o.seatAssignment,
    createdAt: new Date(clock.now()),
    holdId: o.holdId,
    purchaseSessionId: o.purchaseSessionId,
  });
  await admin.db.insert(orderItem).values({ orderId: o.id, lineNo: 1, seatId: it.seatId, tier: it.tierId, sectionId: it.sectionId, unitPrice: it.unitPrice });
  await admin.db.insert(seatSale).values({ eventId, seatId: it.seatId, orderId: o.id, accountId: o.accountId, status: seat });
  return o.id;
}

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'attendee-reader-it' });
  reader = new DrizzleAttendeeReader(admin);
});
afterAll(async () => {
  await admin?.close();
  server?.stop();
});

describe('A2-17 purchase 명단 원천 커서', () => {
  test('A2-17 J-T26 ④ purchase 명단 원천은 SOLD 좌석이 없는 주문을 걸러도 다음 커서를 준다', async () => {
    const eventId = randomUUID();
    const o1 = await paidOrder(eventId, 'SOLD');
    const o2 = await paidOrder(eventId, 'RETURNED');
    const o3 = await paidOrder(eventId, 'SOLD');
    expect([o1, o2, o3]).toEqual([o1, o2, o3].sort());

    // limit 2: o1·o2를 읽고 o2를 걸러 1건이지만 뒤에 o3가 있어 커서가 있다
    const first = await reader.list(eventId, 2);
    expect(first.items.map((r) => r.orderId)).toEqual([o1]);
    expect(first.nextCursor).not.toBeNull();
    expect({ bookingCount: first.bookingCount, ticketCount: first.ticketCount }).toEqual({ bookingCount: 2, ticketCount: 2 });
    const second = await reader.list(eventId, 2, first.nextCursor!);
    expect(second.items.map((r) => r.orderId)).toEqual([o3]);
    expect(second.nextCursor).toBeNull();
    // 그 커서는 마지막으로 돌려준 o1이 아니라 마지막으로 읽은 o2 뒤다(limit 1로 바로 o3가 온다)
    const afterO2 = await reader.list(eventId, 1, first.nextCursor!);
    expect(afterO2.items.map((r) => r.orderId)).toEqual([o3]);
    expect(afterO2.nextCursor).toBeNull();

    // limit 1: o2만 읽은 페이지는 0건이고 커서가 null이 아니다
    const p1 = await reader.list(eventId, 1);
    expect(p1.items.map((r) => r.orderId)).toEqual([o1]);
    expect(p1.nextCursor).not.toBeNull();
    const empty = await reader.list(eventId, 1, p1.nextCursor!);
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).not.toBeNull();
    const p3 = await reader.list(eventId, 1, empty.nextCursor!);
    expect(p3.items.map((r) => r.orderId)).toEqual([o3]);
    expect(p3.nextCursor).toBeNull();
  });
});
