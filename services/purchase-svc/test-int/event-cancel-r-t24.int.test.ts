// 입장 시작 뒤 확정한 회차 취소(R-T24)·보류 취소 전환(GAT-110 E1)·좌석을 되돌리지 않음(R-T37 ⑦)을 실제 PostgreSQL 18(purchase·ticket 두 DB)과
// 실제 ticket-svc gRPC(EventCancelTickets)로 돈다. 결제사 취소는 PaymentCancellations 기록 대역이다(멱등키 = cancel-{cancellationId}는 payment-svc 몫, 금액·취소 ID를 본다).
// 정본: docs/features/transfer-refund.md §5 '입장 상태와 대상'·'대상 선택과 보류 취소 전환'·'확정 때 판매 멈춤·좌석·늦게 끝난 주문', ADR-0280 결정 3.
// 좌석 Redis 비트맵은 회차 취소 전용 취소기에 좌석 포트가 아예 없어 바뀔 길이 없으므로 이 파일은 DB(seat_sale·purchase_quota)만 본다(남은 한계, 실패 확인 절).
// 시험 담당이 구현 전에 썼다(ADR-0270).
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database, type ExternalRequest } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../../ticket-svc/src/grpc-server.js';
import { DrizzleTicketStore } from '../../ticket-svc/src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleScannerGateStore } from '../../ticket-svc/src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { TicketService } from '../../ticket-svc/src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../../ticket-svc/src/modules/ticket/inbound/ticket.grpc.js';
import { migrateTicket } from '../../ticket-svc/scripts/migrate.mjs';
import { DrizzleOrderStore } from '../src/modules/booking/index.js';
import { DrizzleSeatSales } from '../src/modules/inventory/index.js';
import {
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleDeductionGapCancellations,
  DrizzleEventOpenOrders,
  DrizzleEventRefundHolds,
  DrizzleEventRefundStore,
  DrizzleEventRefundTargets,
  DrizzlePendingCancellationConversions,
  EventRefundService,
  EventTicketCanceller,
  GrpcTicketCancellations,
  HttpDeductionGapNotice,
  RefundAfterEntry,
  WeekendBusinessCalendar,
  eventRefundCancellationId,
  type PaymentCancellations,
} from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-20T18:30:00+09:00');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PRICE = 33_333;
/** 입장 시작 = 지금 − 30분, 공연 시작 = 지금 + 30분 */
const ENTRY_OPENS = NOW - 30 * MINUTE;
const STARTS = NOW + 30 * MINUTE;

let pgc: PostgresContainer | undefined;
let purchaseDb: Database;
let ticketDb: Database;
let ticketServer: { port: number; close(): Promise<void> } | undefined;
let ticketCancels: GrpcTicketCancellations | undefined;
let ticketService: TicketService;
let sales: DrizzleSeatSales;
let writes: DrizzleCancellationWrites;
const clock = fakeClock({ now: NOW });
const pays: { cancellationId: string; orderId: string; amount: number; reason: string }[] = [];
const payments: PaymentCancellations = {
  cancel: async (q) => {
    pays.push({ cancellationId: q.cancellationId, orderId: q.orderId, amount: q.amount, reason: q.reason });
    return 'CANCELLED';
  },
};
const configs = { config: async () => ({ saleEndsAtMs: STARTS - DAY, entryOpensAtMs: ENTRY_OPENS }) };

async function createNamedDatabase(serverUrl: string, name: string): Promise<string> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
  return serverUrl.replace(/\/peaket$/, `/${name}`);
}

beforeAll(async () => {
  pgc = await startPostgres();
  const ticketUrl = await createNamedDatabase(pgc.url, 'ticket');
  await migratePurchase(pgc.url);
  await migrateTicket(ticketUrl);
  purchaseDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'event-cancel-r-t24-purchase' });
  ticketDb = createDatabase({ url: ticketUrl, profile: 'general', max: 6, applicationName: 'event-cancel-r-t24-ticket' });
  await ensureOutboxPartitions(purchaseDb, clock);
  ticketService = new TicketService({ store: new DrizzleTicketStore({ database: ticketDb, changes: new DrizzleScannerGateStore(ticketDb) }), clock });
  ticketServer = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: ticketService, nowMs: () => NOW }, () => {}) }],
  });
  ticketCancels = new GrpcTicketCancellations({ address: `127.0.0.1:${ticketServer.port}` });
  sales = new DrizzleSeatSales(purchaseDb);
  writes = new DrizzleCancellationWrites(purchaseDb, new DrizzleOrderStore({ clock }));
}, 180_000);

afterAll(async () => {
  ticketCancels?.close();
  await ticketServer?.close();
  await Promise.allSettled([purchaseDb?.close(), ticketDb?.close()]);
  pgc?.stop();
});

interface Seat {
  orderId: string;
  accountId: string;
  seatId: string;
  ticketId: string;
}

/** 결제 완료 주문 하나·표 하나·판매 확정 좌석을 넣는다(표는 실제 ticket-svc 발권) */
async function seat(eventId: string): Promise<Seat> {
  const orderId = randomUUID();
  const accountId = randomUUID();
  const seatId = randomUUID();
  const client = await purchaseDb.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', $6, $7, 'ps-test')`,
      [orderId, accountId, eventId, PRICE, randomUUID(), new Date(NOW - 10 * DAY), randomUUID()],
    );
    await client.query("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T8', 'test', $2)", [orderId, new Date(NOW - 10 * DAY)]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const issued = await ticketService.issue({ orderId, eventId, payerAccountId: accountId, seatIds: [seatId], issueGeneration: 0, eventStartsAtMs: STARTS });
  const ticketId = issued.tickets[0]!.ticketId;
  await purchaseDb.pool.query("insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'R', 'A', $3, $4)", [orderId, seatId, PRICE, ticketId]);
  await purchaseDb.pool.query("insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $1, 'TOSS', 'ACCEPTED', now())", [orderId]);
  expect(await sales.reserve({ eventId, accountId, orderId, seatIds: [seatId], limit: 4 })).toEqual({ status: 'RESERVED' });
  expect(await sales.markSold({ eventId, orderId, seatIds: [seatId] })).toBe(1);
  return { orderId, accountId, seatId, ticketId };
}

let scanSeq = 0;
const scan = (eventId: string, ticketId: string, direction: 'IN' | 'OUT', atMs: number) =>
  ticketDb.pool.query(
    `insert into scan_event (id, event_id, ticket_id, scanner_device_id, direction, method, result, scanned_at_device, known_seq, device_seq, received_at)
     values ($1, $2, $3, $4, $5, 'QR', 'PASS', $6, 0, $7, $6)`,
    [randomUUID(), eventId, ticketId, randomUUID(), direction, new Date(atMs), ++scanSeq],
  );
/** 입장 시작 뒤 팬 취소로 보류(REQUESTED)된 표: ticket-svc는 키를 폐기했고 purchase는 공제 29,999·환급 3,334로 마감 뒤 환급을 기다린다 */
async function heldFanCancel(eventId: string, s: Seat, status: 'REQUESTED' | 'REFUND_PENDING' = 'REQUESTED'): Promise<string> {
  const cancellationId = randomUUID();
  await ticketDb.pool.query("update ticket set status = 'REFUNDED', key_revoked_at = $2, version = version + 1 where id = $1", [s.ticketId, new Date(NOW - 10 * MINUTE)]);
  await purchaseDb.pool.query(
    `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, refund_due_at, created_at, status_changed_at)
     values ($1, $2, $3, 'USER', 0, false, 9000, 29999, 3334, $4, $5, $6, $6)`,
    [cancellationId, s.orderId, s.ticketId, status, status === 'REQUESTED' ? new Date(STARTS + 50 * HOUR) : null, new Date(NOW - 10 * MINUTE)],
  );
  void eventId;
  return cancellationId;
}

const notices: string[] = [];
const service = () =>
  new EventRefundService({
    store: new DrizzleEventRefundStore(purchaseDb, clock),
    targets: new DrizzleEventRefundTargets(purchaseDb, configs),
    canceller: new EventTicketCanceller({
      tickets: ticketCancels!,
      conversions: new DrizzlePendingCancellationConversions(purchaseDb),
      orders: new DrizzleCancellationOrders(purchaseDb, configs),
      writes,
      payments,
      calendar: new WeekendBusinessCalendar(),
    }),
    items: new DrizzleEventRefundStore(purchaseDb, clock),
    openOrders: new DrizzleEventOpenOrders(purchaseDb),
    notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
    nowMs: () => NOW,
    deadlineMs: () => NOW + 30_000,
    concurrency: 2,
  });
const ticketRow = async (ticketId: string) =>
  (await ticketDb.pool.query('select status, account_id, transfer_pending, key_revoked_at, version from ticket where id = $1', [ticketId])).rows[0] as {
    status: string;
    account_id: string;
    transfer_pending: boolean;
    key_revoked_at: Date | null;
    version: number;
  };
const cancellationsOf = async (orderIds: string[]) =>
  (
    await purchaseDb.pool.query<{ id: string; ticket_id: string; reason: string; deduction_bp: number; deduction_amount: number; refund_amount: number; status: string; event_cancellation_request_id: string | null; refund_due_at: Date | null }>(
      'select id, ticket_id, reason, deduction_bp, deduction_amount, refund_amount, status, event_cancellation_request_id, refund_due_at from order_cancellation where order_id = any($1::uuid[])',
      [orderIds],
    )
  ).rows;

describe('R-T24 입장 시작 뒤 확정한 회차 취소 [PostgreSQL·실제 ticket-svc gRPC]', () => {
  let eventId: string;
  let requestId: string;
  let seats: Record<'t1' | 't2' | 't3' | 't4' | 't5' | 't6' | 't7', Seat>;
  let t4Cancellation: string;
  let ticketsBefore: Record<string, { version: number }>;
  let quotaBefore: unknown[];

  beforeAll(async () => {
    eventId = randomUUID();
    requestId = randomUUID();
    seats = {
      t1: await seat(eventId),
      t2: await seat(eventId),
      t3: await seat(eventId),
      t4: await seat(eventId),
      t5: await seat(eventId),
      t6: await seat(eventId),
      t7: await seat(eventId),
    };
    await scan(eventId, seats.t1.ticketId, 'IN', NOW - 20 * MINUTE);
    await scan(eventId, seats.t2.ticketId, 'IN', NOW - 20 * MINUTE);
    await scan(eventId, seats.t2.ticketId, 'OUT', NOW - 10 * MINUTE);
    t4Cancellation = await heldFanCancel(eventId, seats.t4);
    await ticketDb.pool.query("update ticket set status = 'FLAGGED' where id = $1", [seats.t5.ticketId]);
    await ticketDb.pool.query('update ticket set transfer_pending = true where id = $1', [seats.t6.ticketId]);
    await ticketDb.pool.query('update ticket set account_id = $2 where id = $1', [seats.t7.ticketId, randomUUID()]);
    ticketsBefore = Object.fromEntries(await Promise.all(Object.values(seats).map(async (s) => [s.ticketId, await ticketRow(s.ticketId)] as const)));
    quotaBefore = (await purchaseDb.pool.query('select * from purchase_quota where event_id = $1 order by account_id', [eventId])).rows;
    pays.length = 0;
  });

  test('R-T24 입장 시작 뒤 확정한 회차 취소는 여섯 가지 표(들어감·재입장 퇴장·미입장·보류 취소·이상 표시·양도 중)와 남이 가진 표를 모두 공제 없이 한 번씩 환급한다', async () => {
    const started = await service().start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    // 지금은 공연 시작 + 50시간(입장 기록 마감) 전이다. 회차 취소는 마감을 기다리지 않는다
    expect(NOW).toBeLessThan(STARTS + 50 * HOUR);
    expect(started.progress).toMatchObject({ total: 7, done: 7, failed: 0 });
    expect(pays).toHaveLength(7);
    expect(pays.every((p) => p.amount === 33_333 && p.reason === 'EVENT_CANCELLED')).toBe(true);
    const byOrder = new Map(pays.map((p) => [p.orderId, p.cancellationId]));
    expect(byOrder.get(seats.t4.orderId)).toBe(t4Cancellation);
    for (const k of ['t1', 't2', 't3', 't5', 't6', 't7'] as const) expect(byOrder.get(seats[k].orderId), k).toBe(eventRefundCancellationId(requestId, seats[k].ticketId));

    const rows = await cancellationsOf(Object.values(seats).map((s) => s.orderId));
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r, r.ticket_id).toMatchObject({ reason: 'EVENT_CANCELLED', deduction_bp: 0, deduction_amount: 0, refund_amount: 33_333, status: 'REFUNDED', event_cancellation_request_id: requestId });
    }
    const t4Row = rows.find((r) => r.ticket_id === seats.t4.ticketId)!;
    expect(t4Row.id).toBe(t4Cancellation);
    expect(t4Row.refund_due_at).toBeNull();

    for (const k of ['t1', 't2', 't3', 't5', 't6', 't7'] as const) {
      const t = await ticketRow(seats[k].ticketId);
      expect(t, k).toMatchObject({ status: 'REFUNDED', transfer_pending: false, version: ticketsBefore[seats[k].ticketId]!.version + 1 });
      expect(t.key_revoked_at, k).not.toBeNull();
    }
    expect(await ticketRow(seats.t4.ticketId)).toEqual(ticketsBefore[seats.t4.ticketId]);
    const ticketCancels6 = await ticketDb.pool.query<{ result: string }>('select result from ticket_cancellation where ticket_id = any($1::uuid[])', [
      (['t1', 't2', 't3', 't5', 't6', 't7'] as const).map((k) => seats[k].ticketId),
    ]);
    expect(ticketCancels6.rows.map((r) => r.result)).toEqual(Array(6).fill('EVENT_CANCELED'));
    const items = await purchaseDb.pool.query<{ status: string }>('select status from event_refund_item where request_id = $1', [requestId]);
    expect(items.rows.map((r) => r.status)).toEqual(Array(7).fill('REFUNDED'));
  });

  test('R-T24 같은 작업을 다시 돌리고 같은 요청으로 다시 시작해도 표마다 취소 행·결제사 호출이 하나다', async () => {
    const s = service();
    await s.runDue();
    await s.runDue();
    await s.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(pays).toHaveLength(7);
    expect(await cancellationsOf(Object.values(seats).map((s2) => s2.orderId))).toHaveLength(7);
    const n = await ticketDb.pool.query<{ n: number }>("select count(*)::int as n from ticket_cancellation where result = 'EVENT_CANCELED' and ticket_id = any($1::uuid[])", [Object.values(seats).map((s2) => s2.ticketId)]);
    expect(n.rows[0]!.n).toBe(6);
  });

  test('R-T37 ⑦ 회차 취소로 환급한 표의 좌석은 SOLD 그대로이고 1인 한도가 바뀌지 않는다', async () => {
    const seatRows = await purchaseDb.pool.query<{ seat_id: string; status: string }>('select seat_id, status from seat_sale where event_id = $1', [eventId]);
    expect(seatRows.rows).toHaveLength(7);
    expect(seatRows.rows.every((r) => r.status === 'SOLD')).toBe(true);
    expect((await purchaseDb.pool.query('select * from purchase_quota where event_id = $1 order by account_id', [eventId])).rows).toEqual(quotaBefore);
  });
});

describe('GAT-110 E1 보류 취소 전환 경합 [PostgreSQL]', () => {
  test('GAT-110 E1 보류 취소가 확정 전에 이미 REFUND_PENDING(공제한 금액으로 집힘)이면 그 표는 대상이 아니고 취소 행이 그대로다(OPEN[45] 전 이번 문장)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const claimed = await seat(eventId);
    const other = await seat(eventId);
    const claimedId = await heldFanCancel(eventId, claimed, 'REFUND_PENDING');
    pays.length = 0;
    notices.length = 0;
    await service().start({ eventId, requestId, fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    // REFUND_PENDING인 표는 대상에서 빠지므로(OPEN[45] 전 이번 문장) 다른 표만 환급한다
    expect(pays.map((p) => p.orderId)).toEqual([other.orderId]);
    const row = (await cancellationsOf([claimed.orderId]))[0]!;
    expect(row).toMatchObject({ id: claimedId, reason: 'USER', deduction_amount: 29_999, refund_amount: 3_334, status: 'REFUND_PENDING' });
  });

  test('GAT-110 E1 대상을 고른 뒤 환급 실행기가 먼저 집으면 전환하지 않고 FAILED cancellation-in-progress이며, OPEN[45] 결정대로 일반 일괄 환불 실패 대신 그 행 공제액의 차액 건(DEDUCTION_GAP) 하나다(GAT-110 D7)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const held = await seat(eventId);
    const heldId = await heldFanCancel(eventId, held, 'REQUESTED');
    pays.length = 0;
    notices.length = 0;
    const gap = gapNoticeOf();
    // 대상 고르기와 전환 사이에 환급 실행기가 집은 것처럼, 대상 목록을 읽은 뒤 행을 REFUND_PENDING으로 바꾼다
    const targets = new DrizzleEventRefundTargets(purchaseDb, configs);
    const racing = {
      list: async (id: string) => {
        const got = await targets.list(id);
        await purchaseDb.pool.query("update order_cancellation set status = 'REFUND_PENDING', refund_due_at = null where id = $1", [heldId]);
        return got;
      },
    };
    const s = new EventRefundService({
      store: new DrizzleEventRefundStore(purchaseDb, clock),
      targets: racing,
      canceller: new EventTicketCanceller({
        tickets: ticketCancels!,
        conversions: new DrizzlePendingCancellationConversions(purchaseDb),
        orders: new DrizzleCancellationOrders(purchaseDb, configs),
        writes,
        payments,
        calendar: new WeekendBusinessCalendar(),
      }),
      notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
      gaps: new DrizzleDeductionGapCancellations(purchaseDb),
      gapNotice: gap.notice,
      configs,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 30_000,
    });
    await s.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(pays).toEqual([]);
    expect(notices).toEqual([]);
    // CS 건 하나 = 그 취소 하나(eventKey가 취소 ID로 정해진다). 확정 때 차액 찾기와 진 항목이 같은 행을 둘 다 볼 수 있어 보낸 횟수는 1 이상을 받는다
    const bodies = gap.bodies();
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const b of bodies) expect(b).toEqual({ eventKey: gapKey(heldId), kind: 'REFUND_FAILED', sourceId: heldId, category: 'DEDUCTION_GAP', createdAt: new Date(NOW).toISOString() });
    const item = await purchaseDb.pool.query<{ status: string; last_error: string; cancellation_id: string }>('select status, last_error, cancellation_id from event_refund_item where request_id = $1', [requestId]);
    expect(item.rows).toEqual([{ status: 'FAILED', last_error: 'cancellation-in-progress', cancellation_id: heldId }]);
    expect((await cancellationsOf([held.orderId]))[0]).toMatchObject({ id: heldId, reason: 'USER', deduction_amount: 29_999, refund_amount: 3_334, status: 'REFUND_PENDING' });
  });
});

// ---- BAT-420 몫 D(시험 담당, 구현 전에 씀): 확정 때 미룸 풀기와 남는 공제 차액 CS 건(OPEN[45], R-T38 ③④,
// docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸', docs/data.md event_refund_hold) ----
/** sha256(`deduction-gap:${id}`) 앞 16바이트를 8-4-4-4-12로(시험이 직접 계산한다) */
const gapKey = (id: string) => {
  const h = createHash('sha256').update(`deduction-gap:${id}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const putHold = (eventId: string, requestId: string) =>
  purchaseDb.pool.query('insert into event_refund_hold (event_id, cancellation_request_id, held_at, expires_at) values ($1, $2, $3, $4)', [eventId, requestId, new Date(NOW - HOUR), new Date(NOW - HOUR + 259_200_000)]);
const holdOf = async (eventId: string) => (await purchaseDb.pool.query<{ released_at: Date | null }>('select released_at from event_refund_hold where event_id = $1', [eventId])).rows[0];
const requestRows = async (requestId: string) => Number((await purchaseDb.pool.query<{ n: string }>('select count(*) as n from event_cancellation_request where id = $1', [requestId])).rows[0]!.n);
/** 그 회차의 끝난 팬·운영자 취소 행(차액 대상 고르기 재료). 표는 대상에서 빠진다(취소 행이 VOIDED·REQUESTED가 아니다) */
async function doneCancel(s: Seat, o: { reason: 'USER' | 'FRAUD'; deduction: number; status: 'REFUND_PENDING' | 'REFUNDED'; createdAtMs: number }): Promise<string> {
  const id = randomUUID();
  await purchaseDb.pool.query(
    `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
     values ($1, $2, $3, $4, 0, false, $5, $6, $7, $8, $9, $9)`,
    [id, s.orderId, s.ticketId, o.reason, o.deduction === 0 ? 0 : Math.round((o.deduction / PRICE) * 10_000), o.deduction, PRICE - o.deduction, o.status, new Date(o.createdAtMs)],
  );
  return id;
}
const gapNoticeOf = () => {
  const sent: ExternalRequest[] = [];
  const notice = new HttpDeductionGapNotice({ request: async (r: ExternalRequest) => (sent.push(r), new Response('{"accepted":true}', { status: 202 })) }, 'it-token');
  const bodies = () => sent.map((r) => JSON.parse(String(r.body)) as { eventKey: string; kind: string; sourceId: string; category: string; createdAt: string });
  return { notice, sent, bodies };
};
const gapService = (gap: ReturnType<typeof gapNoticeOf>, over: { canceller?: ConstructorParameters<typeof EventRefundService>[0]['canceller'] } = {}) =>
  new EventRefundService({
    store: new DrizzleEventRefundStore(purchaseDb, clock),
    targets: new DrizzleEventRefundTargets(purchaseDb, configs),
    canceller:
      over.canceller ??
      new EventTicketCanceller({
        tickets: ticketCancels!,
        conversions: new DrizzlePendingCancellationConversions(purchaseDb),
        orders: new DrizzleCancellationOrders(purchaseDb, configs),
        writes,
        payments,
        calendar: new WeekendBusinessCalendar(),
      }),
    items: new DrizzleEventRefundStore(purchaseDb, clock),
    openOrders: new DrizzleEventOpenOrders(purchaseDb),
    notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
    gaps: new DrizzleDeductionGapCancellations(purchaseDb),
    gapNotice: gap.notice,
    configs,
    nowMs: () => NOW,
    deadlineMs: () => NOW + 30_000,
    concurrency: 2,
  });

describe('R-T38 확정 때 미룸 풀기와 남는 공제 차액 [PostgreSQL·실제 ticket-svc gRPC, BAT-420 몫 D]', () => {
  test('R-T38 ③ 확정하면 미룸이 요청 행과 같은 트랜잭션에서 풀리고(저장이 실패하면 둘 다 없다) 보류 취소는 권면 전액 33,333원으로 한 번 환급된다(시작 뒤 실행기가 먼저 돌아도)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const held = await seat(eventId);
    const heldId = await heldFanCancel(eventId, held, 'REQUESTED');
    // 확정은 그 회차의 열린 미룸을 요청 ID와 관계없이 푼다(계획 §11). 건 요청 ID를 일부러 다르게 둔다
    await putHold(eventId, randomUUID());
    pays.length = 0;
    const fail = (name: string, table: string, cond: string) =>
      purchaseDb.pool.query(
        `create or replace function ${name}() returns trigger language plpgsql as $$ begin raise exception 'injected ${name}'; end $$;
         create trigger ${name} before ${table} for each row when (${cond}) execute function ${name}();`,
      );
    const drop = (name: string, table: string) => purchaseDb.pool.query(`drop trigger if exists ${name} on ${table}; drop function if exists ${name}();`);
    // ⓐ 항목 저장이 실패하면 요청 행도 없고 미룸도 그대로 걸려 있다(풀기를 트랜잭션 앞에서 따로 하면 여기서 풀린다)
    await fail('rt38_item_fail', 'insert on event_refund_item', `new.request_id = '${requestId}'`);
    try {
      await expect(gapService(gapNoticeOf()).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' })).rejects.toThrow();
    } finally {
      await drop('rt38_item_fail', 'event_refund_item');
    }
    expect(await requestRows(requestId)).toBe(0);
    expect(await holdOf(eventId)).toEqual({ released_at: null });
    // ⓑ 미룸 풀기가 실패하면 요청 행도 없다(풀기를 커밋 뒤에 따로 하면 요청 행이 남는다)
    await fail('rt38_hold_fail', `update on event_refund_hold`, `old.event_id = '${eventId}'`);
    try {
      await expect(gapService(gapNoticeOf()).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' })).rejects.toThrow();
    } finally {
      await drop('rt38_hold_fail', 'event_refund_hold');
    }
    expect(await requestRows(requestId)).toBe(0);
    expect(await holdOf(eventId)).toEqual({ released_at: null });
    expect(pays.filter((p) => p.orderId === held.orderId)).toEqual([]);

    // 성공: 요청 행을 만든 뒤 항목을 처리하기 직전에 마감 뒤 환급 실행기가 먼저 돈다(미룸은 풀렸지만 RUNNING 일괄 환불이 막는다)
    const inner = new EventTicketCanceller({
      tickets: ticketCancels!,
      conversions: new DrizzlePendingCancellationConversions(purchaseDb),
      orders: new DrizzleCancellationOrders(purchaseDb, configs),
      writes,
      payments,
      calendar: new WeekendBusinessCalendar(),
    });
    let ranRunner = false;
    const runnerFirst: ConstructorParameters<typeof EventRefundService>[0]['canceller'] = {
      cancel: async (t, q) => {
        if (!ranRunner) {
          ranRunner = true;
          expect((await holdOf(eventId))?.released_at).not.toBeNull();
          await new RefundAfterEntry({ writes, payments, entries: ticketCancels!, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), nowMs: () => STARTS + 50 * HOUR }).run();
          expect(pays.filter((p) => p.cancellationId === heldId)).toEqual([]);
        }
        return inner.cancel(t, q);
      },
    };
    const started = await gapService(gapNoticeOf(), { canceller: runnerFirst }).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(ranRunner).toBe(true);
    expect(started.progress).toMatchObject({ total: 1, done: 1, failed: 0 });
    expect(await requestRows(requestId)).toBe(1);
    expect((await holdOf(eventId))?.released_at).not.toBeNull();
    const mine = pays.filter((p) => p.orderId === held.orderId);
    expect(mine).toEqual([{ cancellationId: heldId, orderId: held.orderId, amount: 33_333, reason: 'EVENT_CANCELLED' }]);
    expect((await cancellationsOf([held.orderId]))[0]).toMatchObject({ id: heldId, reason: 'EVENT_CANCELLED', deduction_amount: 0, refund_amount: 33_333, status: 'REFUNDED' });
  });

  test('R-T38 ④ 확정 때 입장 시작 뒤(정각 포함) 접수돼 공제하고 나간 USER 취소마다 차액 건이 한 번 생기고(1ms 앞·FRAUD 0원·다른 회차는 아님) 결제사 추가 호출은 0, 다시 시작하면 0이다', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const normal = await seat(eventId);
    const after = await doneCancel(await seat(eventId), { reason: 'USER', deduction: 29_999, status: 'REFUNDED', createdAtMs: NOW - 10 * MINUTE });
    const onTheDot = await doneCancel(await seat(eventId), { reason: 'USER', deduction: 29_999, status: 'REFUND_PENDING', createdAtMs: ENTRY_OPENS });
    const before = await doneCancel(await seat(eventId), { reason: 'USER', deduction: 3_333, status: 'REFUNDED', createdAtMs: ENTRY_OPENS - 1 });
    const fraud = await doneCancel(await seat(eventId), { reason: 'FRAUD', deduction: 0, status: 'REFUNDED', createdAtMs: NOW - 5 * MINUTE });
    const otherEvent = randomUUID();
    const elsewhere = await doneCancel(await seat(otherEvent), { reason: 'USER', deduction: 29_999, status: 'REFUNDED', createdAtMs: NOW - 10 * MINUTE });
    pays.length = 0;
    notices.length = 0;
    const gap = gapNoticeOf();
    await gapService(gap).start({ eventId, requestId, fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    // 결제사는 대상 표 한 장(normal)만: 차액 건은 결제사 호출이 아니다
    expect(pays).toEqual([{ cancellationId: eventRefundCancellationId(requestId, normal.ticketId), orderId: normal.orderId, amount: 33_333, reason: 'EVENT_CANCELLED' }]);
    const bodies = gap.bodies();
    expect(bodies.map((b) => b.sourceId).sort()).toEqual([after, onTheDot].sort());
    for (const b of bodies) expect(b).toEqual({ eventKey: gapKey(b.sourceId), kind: 'REFUND_FAILED', sourceId: b.sourceId, category: 'DEDUCTION_GAP', createdAt: new Date(NOW).toISOString() });
    for (const id of [before, fraud, elsewhere]) expect(bodies.map((b) => b.sourceId)).not.toContain(id);
    expect(gap.sent.every((r) => r.method === 'POST' && r.path === '/internal/v1/cs-cases')).toBe(true);
    expect(notices).toEqual([]);
    // 같은 요청으로 다시 시작하면 차액 건을 다시 열지 않는다
    const again = gapNoticeOf();
    await gapService(again).start({ eventId, requestId, fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(again.sent).toEqual([]);
    expect(pays).toHaveLength(1);
  });
});
