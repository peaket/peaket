// 입장 시작 뒤 확정한 회차 취소(R-T24)·보류 취소 전환(GAT-110 E1)·좌석을 되돌리지 않음(R-T37 ⑦)을 실제 PostgreSQL 18(purchase·ticket 두 DB)과
// 실제 ticket-svc gRPC(EventCancelTickets)로 돈다. 결제사 취소는 PaymentCancellations 기록 대역이다(멱등키 = cancel-{cancellationId}는 payment-svc 몫, 금액·취소 ID를 본다).
// 정본: docs/features/transfer-refund.md §5 '입장 상태와 대상'·'대상 선택과 보류 취소 전환'·'확정 때 판매 멈춤·좌석·늦게 끝난 주문', ADR-0280 결정 3.
// 좌석 Redis 비트맵은 회차 취소 전용 취소기에 좌석 포트가 아예 없어 바뀔 길이 없으므로 이 파일은 DB(seat_sale·purchase_quota)만 본다(남은 한계, 실패 확인 절).
// 시험 담당이 구현 전에 썼다(ADR-0270).
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, createExternalHttpClient, ensureOutboxPartitions, fakeClock, type Database, type ExternalRequest } from '@peaket/platform';
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
  DrizzleEventRefundClaims,
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
// 다시 보기 2 N7(시험 담당 l3w8-420-n-test)
import {
  CancelTicket,
  CancelTicketEventRefund,
  DrizzleCsCaseOutbox,
  DrizzleEventRefundAttempts,
  EVENT_REFUND_CLAIM_MS,
  EventRefundCancellerRouter,
  HttpRefundFailureNotice,
  OutboxEventRefundFanNotifier,
  eventRefundNoticeKey,
} from '../src/modules/refund/index.js';
import { startOpsCsDouble } from './ops-cs-double.js';
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
/** 결제사 대역의 답(BAT-420 리뷰 D6: 결과 모름 뒤 다시 부르기를 만든다) */
let payOutcome: 'CANCELLED' | 'UNKNOWN' | 'REJECTED' = 'CANCELLED';
const payments: PaymentCancellations = {
  cancel: async (q) => {
    pays.push({ cancellationId: q.cancellationId, orderId: q.orderId, amount: q.amount, reason: q.reason });
    return payOutcome;
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

// ---- BAT-420 리뷰 D5·D6(시험 담당, 구현 전에 씀, 계획 §11 보충 3, transfer-refund §5 '확정 뒤 팬 취소'·'대상 선택과 보류 취소 전환') ----
describe('BAT-420 리뷰 D5·D6 [PostgreSQL·실제 ticket-svc gRPC]', () => {
  const canceller = () =>
    new EventTicketCanceller({
      tickets: ticketCancels!,
      conversions: new DrizzlePendingCancellationConversions(purchaseDb),
      orders: new DrizzleCancellationOrders(purchaseDb, configs),
      writes,
      payments,
      calendar: new WeekendBusinessCalendar(),
    });
  const serviceAt = (nowMs: number, gap = gapNoticeOf(), over: { canceller?: ConstructorParameters<typeof EventRefundService>[0]['canceller'] } = {}) =>
    new EventRefundService({
      store: new DrizzleEventRefundStore(purchaseDb, clock),
      targets: new DrizzleEventRefundTargets(purchaseDb, configs),
      canceller: over.canceller ?? canceller(),
      items: new DrizzleEventRefundStore(purchaseDb, clock),
      openOrders: new DrizzleEventOpenOrders(purchaseDb),
      notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
      gaps: new DrizzleDeductionGapCancellations(purchaseDb),
      gapNotice: gap.notice,
      configs,
      nowMs: () => nowMs,
      deadlineMs: () => nowMs + 30_000,
      concurrency: 2,
    });
  const itemsOf = async (requestId: string) =>
    (await purchaseDb.pool.query<{ ticket_id: string; status: string; last_error: string | null; cancellation_id: string }>('select ticket_id, status, last_error, cancellation_id from event_refund_item where request_id = $1', [requestId])).rows;

  test('GAT-110 R5 확정 확인을 지난 팬 취소가 확정 뒤에 커밋돼 공제 3,333원 환급이 나가면, 그 표의 항목이 끝날 때 일반 실패 대신 그 팬 취소의 차액 건이 생긴다(끼어든 사례를 확인한 뒤)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const s = await seat(eventId);
    pays.length = 0;
    notices.length = 0;
    const fanId = randomUUID();
    let intervened = false;
    const inner = canceller();
    const racing: ConstructorParameters<typeof EventRefundService>[0]['canceller'] = {
      cancel: async (t, q) => {
        if (t.ticketId === s.ticketId && !intervened) {
          // 팬 취소: 키 폐기(ticket-svc) → 공제 3,333원으로 취소 행(REFUND_PENDING, 결제사로 보냄)
          await ticketDb.pool.query("update ticket set status = 'REFUNDED', key_revoked_at = $2, version = version + 1 where id = $1", [s.ticketId, new Date(NOW)]);
          const r = await purchaseDb.pool.query(
            `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
             values ($1, $2, $3, 'USER', 2, false, 1000, 3333, 30000, 'REFUND_PENDING', $4, $4)`,
            [fanId, s.orderId, s.ticketId, new Date(NOW)],
          );
          intervened = r.rowCount === 1;
        }
        return inner.cancel(t, q);
      },
    };
    const gap = gapNoticeOf();
    await serviceAt(NOW, gap, { canceller: racing }).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(intervened).toBe(true);
    const [item] = await itemsOf(requestId);
    expect(item).toMatchObject({ ticket_id: s.ticketId, status: 'FAILED' });
    expect(['ticket-already-ended', 'cancellation-conflict']).toContain(item!.last_error);
    // 일반 '일괄 환불 실패' 대신 그 팬 취소의 차액 건(DEDUCTION_GAP)
    expect(notices.filter((n) => n.startsWith(s.ticketId))).toEqual([]);
    const mine = gap.bodies().filter((b) => b.sourceId === fanId);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const b of mine) expect(b).toEqual({ eventKey: gapKey(fanId), kind: 'REFUND_FAILED', sourceId: fanId, category: 'DEDUCTION_GAP', createdAt: new Date(NOW).toISOString() });
    // 일괄 환불은 그 표로 결제사를 부르지 않았다(팬 취소가 이미 결제사로 보냈다)
    expect(pays.filter((p) => p.orderId === s.orderId)).toEqual([]);
  });

  test('GAT-110 R6 전환한 보류 취소의 결과 모름 항목은 다음 틱에 같은 금액 33,333원·같은 취소 ID로 다시 불리고 target-not-found로 끝나지 않는다', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const held = await seat(eventId);
    const heldId = await heldFanCancel(eventId, held, 'REQUESTED');
    pays.length = 0;
    notices.length = 0;
    payOutcome = 'UNKNOWN';
    try {
      await serviceAt(NOW).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    } finally {
      payOutcome = 'CANCELLED';
    }
    expect(pays.filter((p) => p.orderId === held.orderId)).toEqual([{ cancellationId: heldId, orderId: held.orderId, amount: 33_333, reason: 'EVENT_CANCELLED' }]);
    expect((await cancellationsOf([held.orderId]))[0]).toMatchObject({ id: heldId, status: 'REFUND_PENDING', event_cancellation_request_id: requestId });
    // 그 요청이 만든 REFUND_PENDING 행의 표는 대상에 남는다(정본 예외)
    expect((await new DrizzleEventRefundTargets(purchaseDb, configs).list(eventId)).map((t) => t.ticketId)).toEqual([held.ticketId]);
    await serviceAt(NOW + DAY).runDue();
    const mine = pays.filter((p) => p.orderId === held.orderId);
    expect(mine).toHaveLength(2);
    expect(mine[1]).toEqual({ cancellationId: heldId, orderId: held.orderId, amount: 33_333, reason: 'EVENT_CANCELLED' });
    const [item] = await itemsOf(requestId);
    expect(item).toMatchObject({ cancellation_id: heldId, status: 'REFUNDED' });
    expect(item!.last_error).not.toBe('target-not-found');
    expect((await cancellationsOf([held.orderId]))[0]).toMatchObject({ id: heldId, status: 'REFUNDED', refund_amount: 33_333 });
  });

  test('GAT-110 R6 대조: 다른(끝난) 요청 ID가 만든 REFUND_PENDING 행·팬 USER REFUND_PENDING 행의 표는 대상이 아니다(예외는 진행 중인 그 요청 것만)', async () => {
    const eventId = randomUUID();
    const done = randomUUID();
    await purchaseDb.pool.query(
      `insert into event_cancellation_request (id, event_id, kind, status, fault, ruled_by, confirmed_by, created_at, updated_at)
       values ($1, $2, 'CANCEL', 'COMPLETED', 'ORGANIZER', 'commander-1', 'operator-2', $3, $3)`,
      [done, eventId, new Date(NOW - DAY)],
    );
    const byOld = await seat(eventId);
    await purchaseDb.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, event_cancellation_request_id, created_at, status_changed_at)
       values ($1, $2, $3, 'EVENT_CANCELLED', 0, false, 0, 0, 33333, 'REFUND_PENDING', $4, $5, $5)`,
      [randomUUID(), byOld.orderId, byOld.ticketId, done, new Date(NOW - DAY)],
    );
    const byFan = await seat(eventId);
    await heldFanCancel(eventId, byFan, 'REFUND_PENDING');
    const free = await seat(eventId);
    const listed = (await new DrizzleEventRefundTargets(purchaseDb, configs).list(eventId)).map((t) => t.ticketId);
    expect(listed).toEqual([free.ticketId]);
  });
});

// ---- BAT-420 웨이브 끝 리뷰 K1·K2(시험 담당, 구현 전에 씀, 계획 §11 보충 4, transfer-refund §5 '일괄 환불 항목의 주인과 겹침 막기') ----
// 메인 감독 지시: 두 길이 동시에 도는 경우와 차례로 도는 경우를 모두 둔다
describe('BAT-420 웨이브 끝 리뷰 K1·K2 겹침 막기 [PostgreSQL·실제 ticket-svc gRPC]', () => {
  const failureNotices: string[] = [];
  const wave = (nowMs: number, over: { canceller?: ConstructorParameters<typeof EventRefundService>[0]['canceller'] } = {}) =>
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
      claims: new DrizzleEventRefundClaims(purchaseDb),
      nowMs: () => nowMs,
      deadlineMs: () => nowMs + 30_000,
      concurrency: 2,
    });
  const runner = (nowMs: number, w = writes) =>
    new RefundAfterEntry({
      writes: w,
      payments,
      entries: ticketCancels!,
      claims: writes,
      failureNotice: { open: async (q) => void failureNotices.push(q.cancellationId) },
      nowMs: () => nowMs,
    });
  const itemOf = async (requestId: string, ticketId: string) =>
    (await purchaseDb.pool.query<{ status: string; last_error: string | null; cancellation_id: string }>('select status, last_error, cancellation_id from event_refund_item where request_id = $1 and ticket_id = $2', [requestId, ticketId])).rows[0];
  const rowOf = async (cancellationId: string) =>
    (await purchaseDb.pool.query<{ status: string; refund_failed_at: Date | null; refund_last_error: string | null; event_cancellation_request_id: string | null }>(
      'select status, refund_failed_at, refund_last_error, event_cancellation_request_id from order_cancellation where id = $1',
      [cancellationId],
    )).rows[0];
  const callsFor = (cancellationId: string) => pays.filter((p) => p.cancellationId === cancellationId).length;

  test('GAT-110 K1 일괄 환불을 멈춘 동안 그 요청의 REFUND_PENDING 행에 결제사 호출이 0이고(실행기 셋·runDue 셋), 다시 열면 한 번이다(차례로)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const s = await seat(eventId);
    pays.length = 0;
    payOutcome = 'UNKNOWN';
    try {
      await wave(NOW).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    } finally {
      payOutcome = 'CANCELLED';
    }
    const cancellationId = eventRefundCancellationId(requestId, s.ticketId);
    expect(await rowOf(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', event_cancellation_request_id: requestId });
    expect(callsFor(cancellationId)).toBe(1);
    await wave(NOW).pause({ requestId, reason: '결제사 점검' });
    for (let i = 1; i <= 3; i++) {
      await runner(NOW + i * DAY).run();
      await wave(NOW + i * DAY).runDue();
    }
    expect(callsFor(cancellationId)).toBe(1);
    await wave(NOW + 4 * DAY).resume({ requestId });
    await wave(NOW + 5 * DAY).runDue();
    expect(callsFor(cancellationId)).toBe(2);
    expect(await itemOf(requestId, s.ticketId)).toMatchObject({ status: 'REFUNDED' });
  });

  test('GAT-110 K1 마감 뒤 환급 실행기와 runDue가 같은 틱에 돌아도(두 실행기 모두 목록을 읽은 뒤) 결제사 호출은 하나이고, 거절이면 CS 일괄 환불 실패 하나·환급 실패(REFUND_FAILED) 0·refund_failed_at 한 번이다(동시)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const s = await seat(eventId);
    pays.length = 0;
    notices.length = 0;
    failureNotices.length = 0;
    payOutcome = 'UNKNOWN';
    try {
      await wave(NOW).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    } finally {
      payOutcome = 'CANCELLED';
    }
    const cancellationId = eventRefundCancellationId(requestId, s.ticketId);
    // 두 실행기가 모두 목록을 읽은 뒤에 결제사로 가게 한다
    let listed = 0;
    let release!: () => void;
    const bothListed = new Promise<void>((r) => (release = r));
    const arrive = async () => {
      listed++;
      if (listed === 2) release();
      await Promise.race([bothListed, new Promise((r) => setTimeout(r, 2_000))]);
    };
    const runnerWrites = Object.create(writes) as typeof writes;
    runnerWrites.dueRefunds = async (nowMs, limit) => {
      const rows = await writes.dueRefunds(nowMs, limit);
      await arrive();
      return rows;
    };
    const items = new DrizzleEventRefundStore(purchaseDb, clock);
    const store = new DrizzleEventRefundStore(purchaseDb, clock);
    const listItems = store.items.bind(store);
    store.items = async (id) => {
      const out = await listItems(id);
      if (id === requestId) await arrive();
      return out;
    };
    const svc = new EventRefundService({
      store,
      targets: new DrizzleEventRefundTargets(purchaseDb, configs),
      canceller: new EventTicketCanceller({
        tickets: ticketCancels!,
        conversions: new DrizzlePendingCancellationConversions(purchaseDb),
        orders: new DrizzleCancellationOrders(purchaseDb, configs),
        writes,
        payments,
        calendar: new WeekendBusinessCalendar(),
      }),
      items,
      openOrders: new DrizzleEventOpenOrders(purchaseDb),
      notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
      claims: new DrizzleEventRefundClaims(purchaseDb),
      nowMs: () => NOW + DAY,
      deadlineMs: () => NOW + DAY + 30_000,
    });
    payOutcome = 'REJECTED';
    try {
      await Promise.all([runner(NOW + DAY, runnerWrites).run(), svc.runDue()]);
    } finally {
      payOutcome = 'CANCELLED';
    }
    expect(listed).toBeGreaterThanOrEqual(2);
    expect(callsFor(cancellationId)).toBe(2);
    expect(notices.filter((n) => n.startsWith(s.ticketId))).toHaveLength(1);
    expect(failureNotices.filter((id) => id === cancellationId)).toEqual([]);
    expect((await rowOf(cancellationId))?.refund_failed_at).not.toBeNull();
  });

  test('GAT-110 K1 항목이 실패로 끝나면 행에 refund_failed_at·refund_last_error가 같은 커밋으로 써지고(저장을 실패시키면 둘 다 없다) 요청이 끝난 뒤 그 회차에 주인 없는 REFUND_PENDING 행이 없다', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const s = await seat(eventId);
    const cancellationId = eventRefundCancellationId(requestId, s.ticketId);
    pays.length = 0;
    await purchaseDb.pool.query(
      `create or replace function k1_item_fail() returns trigger language plpgsql as $$ begin raise exception 'injected k1'; end $$;
       create trigger k1_item_fail before update on event_refund_item for each row when (new.request_id = '${requestId}' and new.status = 'FAILED') execute function k1_item_fail();`,
    );
    payOutcome = 'REJECTED';
    try {
      await wave(NOW).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' }).catch(() => undefined);
      // 항목 끝내기가 실패했으니 행 표시도 없다(같은 트랜잭션)
      expect((await rowOf(cancellationId))?.refund_failed_at ?? null).toBeNull();
    } finally {
      await purchaseDb.pool.query('drop trigger if exists k1_item_fail on event_refund_item; drop function if exists k1_item_fail();');
    }
    try {
      await wave(NOW + DAY).runDue();
    } finally {
      payOutcome = 'CANCELLED';
    }
    expect(await itemOf(requestId, s.ticketId)).toMatchObject({ status: 'FAILED' });
    const row = await rowOf(cancellationId);
    expect(row?.refund_failed_at).not.toBeNull();
    expect(row?.refund_last_error).toBe('REJECTED');
    await wave(NOW + 2 * DAY).runDue();
    const orphan = await purchaseDb.pool.query(
      `select count(*)::int as n from order_cancellation c join purchase_order o on o.id = c.order_id
        where o.event_id = $1 and c.status = 'REFUND_PENDING' and c.refund_failed_at is null`,
      [eventId],
    );
    expect(orphan.rows[0].n).toBe(0);
  });

  test('GAT-110 K2 API 파드의 Start가 항목을 잡은 뒤 리더의 runDue가 겹쳐도(두 쪽 모두 잡기를 시도) 표마다 결제사 호출이 하나이고 거짓 실패·CS 건이 없다(동시)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const held = await seat(eventId);
    const heldId = await heldFanCancel(eventId, held, 'REQUESTED');
    const a = await seat(eventId);
    const b = await seat(eventId);
    pays.length = 0;
    notices.length = 0;
    const claims = new DrizzleEventRefundClaims(purchaseDb);
    let claimTries = 0;
    const counting = Object.create(claims) as typeof claims;
    counting.claimOrders = async (...args) => (claimTries++, claims.claimOrders(...args));
    const inner = new EventTicketCanceller({
      tickets: ticketCancels!,
      conversions: new DrizzlePendingCancellationConversions(purchaseDb),
      orders: new DrizzleCancellationOrders(purchaseDb, configs),
      writes,
      payments,
      calendar: new WeekendBusinessCalendar(),
    });
    let overlapped = false;
    const leader = () =>
      new EventRefundService({
        store: new DrizzleEventRefundStore(purchaseDb, clock),
        targets: new DrizzleEventRefundTargets(purchaseDb, configs),
        canceller: inner,
        items: new DrizzleEventRefundStore(purchaseDb, clock),
        openOrders: new DrizzleEventOpenOrders(purchaseDb),
        notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
        claims: counting,
        nowMs: () => NOW,
        deadlineMs: () => NOW + 30_000,
      });
    const api = new EventRefundService({
      store: new DrizzleEventRefundStore(purchaseDb, clock),
      targets: new DrizzleEventRefundTargets(purchaseDb, configs),
      canceller: {
        cancel: async (t, q) => {
          if (!overlapped) {
            overlapped = true;
            await leader().runDue();
          }
          return inner.cancel(t, q);
        },
      },
      items: new DrizzleEventRefundStore(purchaseDb, clock),
      openOrders: new DrizzleEventOpenOrders(purchaseDb),
      notice: { open: async (q) => void notices.push(`${q.ticketId}:${q.lastError}`) },
      claims: counting,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 30_000,
    });
    await api.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(overlapped).toBe(true);
    expect(claimTries).toBeGreaterThanOrEqual(2);
    const ids = [heldId, eventRefundCancellationId(requestId, a.ticketId), eventRefundCancellationId(requestId, b.ticketId)];
    for (const id of ids) expect(callsFor(id), id).toBe(1);
    expect(notices).toEqual([]);
    for (const t of [held, a, b]) expect(await itemOf(requestId, t.ticketId), t.ticketId).toMatchObject({ status: 'REFUNDED' });
  });

  test('GAT-110 K2 차례로 돌면(Start 끝난 뒤 runDue, resume 뒤 runDue) 뒤에 온 쪽은 끝난 항목을 건드리지 않는다(결제사 호출 수 그대로)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const s = await seat(eventId);
    pays.length = 0;
    await wave(NOW).start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    const id = eventRefundCancellationId(requestId, s.ticketId);
    expect(callsFor(id)).toBe(1);
    await wave(NOW + DAY).runDue();
    await wave(NOW + DAY).runDue();
    expect(callsFor(id)).toBe(1);
    expect(await itemOf(requestId, s.ticketId)).toMatchObject({ status: 'REFUNDED' });
  });

  test('GAT-110 K2 같은 요청으로 이미 전환된 행의 전환은 CONVERTED이고 행은 한 번만 바뀌며, 다른 요청 ID로 전환된 행은 NOT_REQUESTED다', async () => {
    const eventId = randomUUID();
    const s = await seat(eventId);
    const heldId = await heldFanCancel(eventId, s, 'REQUESTED');
    const conv = new DrizzlePendingCancellationConversions(purchaseDb);
    const requestId = randomUUID();
    const q = { cancellationId: heldId, eventCancellationRequestId: requestId, refundAmount: 33_333, nowMs: NOW };
    await expect(conv.convert(q)).resolves.toBe('CONVERTED');
    const after = (await purchaseDb.pool.query('select status_changed_at, refund_amount, reason from order_cancellation where id = $1', [heldId])).rows[0];
    await expect(conv.convert({ ...q, nowMs: NOW + 60_000 })).resolves.toBe('CONVERTED');
    expect((await purchaseDb.pool.query('select status_changed_at, refund_amount, reason from order_cancellation where id = $1', [heldId])).rows[0]).toEqual(after);
    await expect(conv.convert({ ...q, eventCancellationRequestId: randomUUID() })).resolves.toBe('NOT_REQUESTED');
  });

  test('GAT-110 K2 잡기는 주문 단위이고 기한 60,000ms 안(59,999ms)에는 다른 쪽이 못 잡으며 기한 정각(60,000ms)에는 다시 잡힌다(경계)', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const a = await seat(eventId);
    const b = await seat(eventId);
    pays.length = 0;
    // 항목만 만들고 처리하지 않는다(첫 묶음 0)
    const svc = new EventRefundService({
      store: new DrizzleEventRefundStore(purchaseDb, clock),
      targets: new DrizzleEventRefundTargets(purchaseDb, configs),
      canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
      items: new DrizzleEventRefundStore(purchaseDb, clock),
      openOrders: new DrizzleEventOpenOrders(purchaseDb),
      firstBatch: 0,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 30_000,
    });
    await svc.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    const claims = new DrizzleEventRefundClaims(purchaseDb);
    const first = await claims.claimOrders(requestId, NOW, 1);
    expect(first.items.map((i) => i.orderId)).toHaveLength(1);
    const other = first.items[0]!.orderId === a.orderId ? b : a;
    const second = await claims.claimOrders(requestId, NOW + 59_999, 10);
    expect(second.items.map((i) => i.orderId)).toEqual([other.orderId]);
    const third = await claims.claimOrders(requestId, NOW + 60_000, 10);
    expect(third.items.map((i) => i.orderId)).toEqual([first.items[0]!.orderId]);
    // 잡기를 잃은 첫 쪽의 끝내기는 0행이다
    await expect(claims.finish({ requestId, ticketId: first.items[0]!.ticketId, claimToken: first.claimToken, status: 'REFUNDED', attempts: 1 })).resolves.toBe(false);
    await expect(claims.finish({ requestId, ticketId: third.items[0]!.ticketId, claimToken: third.claimToken, status: 'REFUNDED', attempts: 1 })).resolves.toBe(true);
    await expect(claims.finish({ requestId, ticketId: third.items[0]!.ticketId, claimToken: third.claimToken, status: 'FAILED', attempts: 2 })).resolves.toBe(false);
  });
});

// ---- BAT-420 다시 보기 2 N7(시험 담당 l3w8-420-n-test, 구현 전에 씀, 계획 §11 보충 5, transfer-refund §5 '주인') ----
// 연기(POSTPONE) 신청 환급을 예매 취소 Saga 그대로(실제 ticket-svc gRPC·실제 DB) 돌리고 결제사 대역이 거절한다.
// 항목은 FAILED로 끝나고(DB 칸 값), 행 실패 표시·팬 실패 알림 Outbox·열 대상 표시가 항목 끝내기 한 커밋이며, '일괄 환불 실패' 건은 틱 끝에 하나다.
describe('BAT-420 다시 보기 2 N7 연기 신청 환급의 결제사 거절 [PostgreSQL·실제 ticket-svc gRPC]', () => {
  let ops: Awaited<ReturnType<typeof startOpsCsDouble>>;
  beforeAll(async () => {
    ops = await startOpsCsDouble();
  });
  afterAll(async () => {
    await ops?.close();
  });
  const postponeService = (nowMs: number, requestId: string, over: { claims?: DrizzleEventRefundClaims } = {}) => {
    const client = createExternalHttpClient({ provider: 'ops-svc', baseUrl: ops.url, timeoutCapMs: 5_000 });
    const real = new DrizzleCsCaseOutbox(purchaseDb);
    return new EventRefundService({
      store: new DrizzleEventRefundStore(purchaseDb, clock),
      targets: new DrizzleEventRefundTargets(purchaseDb, configs),
      canceller: new EventRefundCancellerRouter({
        cancel: new EventTicketCanceller({
          tickets: ticketCancels!,
          conversions: new DrizzlePendingCancellationConversions(purchaseDb),
          orders: new DrizzleCancellationOrders(purchaseDb, configs),
          writes,
          payments,
          calendar: new WeekendBusinessCalendar(),
        }),
        postpone: new CancelTicketEventRefund(new CancelTicket({ orders: new DrizzleCancellationOrders(purchaseDb, configs), writes, tickets: ticketCancels!, payments, calendar: new WeekendBusinessCalendar() })),
      }),
      items: new DrizzleEventRefundStore(purchaseDb, clock),
      openOrders: new DrizzleEventOpenOrders(purchaseDb),
      attempts: new DrizzleEventRefundAttempts(purchaseDb),
      fanNotifier: new OutboxEventRefundFanNotifier(),
      notice: new HttpRefundFailureNotice(client, 'it-token'),
      claims: over.claims ?? new DrizzleEventRefundClaims(purchaseDb),
      // 파일이 DB를 나눠 쓰므로 다시 열기 목록은 이 요청의 항목으로만 거른다
      csOutbox: {
        pendingItemFailures: async (limit: number) => (await real.pendingItemFailures(limit)).filter((r) => r.requestId === requestId),
        markItemFailureOpened: (r: string, t: string, n: number) => real.markItemFailureOpened(r, t, n),
        pendingGaps: async () => [],
        markGapOpened: async () => undefined,
      },
      nowMs: () => nowMs,
      deadlineMs: () => nowMs + 30_000,
      concurrency: 2,
    });
  };
  const startPostpone = (requestId: string, eventId: string) =>
    postponeService(NOW, requestId).start({ eventId, requestId, kind: 'POSTPONE', fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
  const itemOf = async (requestId: string, ticketId: string) =>
    (await purchaseDb.pool.query<{ status: string; last_error: string | null; cancellation_id: string; claim_token: string | null }>('select status, last_error, cancellation_id, claim_token from event_refund_item where request_id = $1 and ticket_id = $2', [requestId, ticketId])).rows[0];
  const rowOf = async (cancellationId: string) =>
    (await purchaseDb.pool.query<{ status: string; refund_failed_at: Date | null; refund_attempts: number; event_cancellation_request_id: string | null }>('select status, refund_failed_at, refund_attempts, event_cancellation_request_id from order_cancellation where id = $1', [cancellationId])).rows[0];
  const fanFailures = async (eventId: string, ticketId: string, requestId: string) =>
    (await purchaseDb.pool.query<{ payload: Buffer }>('select payload from outbox where msg_key = $1', [eventId])).rows
      .map((r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string; eventKey: string })
      .filter((p) => p.type === 'REFUND_FAILED' && p.eventKey === eventRefundNoticeKey(requestId, ticketId, 'REFUND_FAILED'));
  const rejects = async (requestId: string, ticketId: string) =>
    (await purchaseDb.pool.query<{ outcome: string }>('select outcome from event_refund_attempt where request_id = $1 and ticket_id = $2', [requestId, ticketId])).rows.map((r) => r.outcome);
  const callsFor = (cancellationId: string) => pays.filter((p) => p.cancellationId === cancellationId).length;

  test('GAT-110 N7 연기 신청 표가 결제사에 거절되면 항목은 FAILED로 끝나고 CS 건 하나·팬 실패 알림 하나다', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const applied = await seat(eventId);
    const other = await seat(eventId);
    await startPostpone(requestId, eventId);
    // 신청(API 파드의 apply 대신 신청 칸만 쓰고) → 리더 runDue가 처리한다
    expect(await new DrizzleEventRefundStore(purchaseDb, clock).markApplied(requestId, applied.ticketId, NOW)).toBe(true);
    pays.length = 0;
    ops.state.requests.length = 0;
    ops.state.mode = 202;
    payOutcome = 'REJECTED';
    try {
      await postponeService(NOW + MINUTE, requestId).runDue();
    } finally {
      payOutcome = 'CANCELLED';
    }
    const item = await itemOf(requestId, applied.ticketId);
    // 결제사를 실제로 불렀고 거절됐다(장애 주입 확인)
    expect(callsFor(item!.cancellation_id)).toBe(1);
    expect(item).toMatchObject({ status: 'FAILED', last_error: 'REJECTED' });
    const row = await rowOf(item!.cancellation_id);
    expect(row).toMatchObject({ status: 'REFUND_PENDING', event_cancellation_request_id: requestId });
    expect(row?.refund_failed_at).not.toBeNull();
    expect(await fanFailures(eventId, applied.ticketId, requestId)).toHaveLength(1);
    expect(await rejects(requestId, applied.ticketId)).toEqual(['REJECT']);
    expect(ops.state.requests.filter((r) => r.body.sourceId === item!.cancellation_id).map((r) => [r.body.kind, r.body.category])).toEqual([['REFUND_FAILED', 'REFUND']]);
    // 다른 항목이 끝나면(신청 창 닫기로 NOT_APPLIED) 요청은 COMPLETED
    await postponeService(NOW + 2 * MINUTE, requestId).closeWindow({ requestId, closedBy: 'operator-2', reason: '시험' });
    expect((await postponeService(NOW + 2 * MINUTE, requestId).get(requestId)).status).toBe('COMPLETED');
    void other;
    // 다음 runDue에 결제사 호출 0
    await postponeService(NOW + DAY, requestId).runDue();
    expect(callsFor(item!.cancellation_id)).toBe(1);
  }, 60_000);

  test('GAT-110 N7 거절을 받은 뒤 끝내기 전에 끊기면 다시 잡혀 같은 취소 ID로 다시 부르고 FAILED로 끝난다', async () => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const s = await seat(eventId);
    await startPostpone(requestId, eventId);
    expect(await new DrizzleEventRefundStore(purchaseDb, clock).markApplied(requestId, s.ticketId, NOW)).toBe(true);
    pays.length = 0;
    ops.state.requests.length = 0;
    ops.state.mode = 202;
    // 끝내기 저장을 한 번 실패시킨다(거절을 받은 뒤 파드가 끝난 것과 같다)
    await purchaseDb.pool.query(
      `create or replace function n7_item_fail() returns trigger language plpgsql as $$ begin raise exception 'injected n7'; end $$;
       create trigger n7_item_fail before update on event_refund_item for each row when (new.request_id = '${requestId}' and new.status = 'FAILED') execute function n7_item_fail();`,
    );
    // 파드가 끝난 것처럼 실행 끝의 잡기 풀기도 하지 않는다(잡기는 기한까지 남는다)
    const dying = Object.create(new DrizzleEventRefundClaims(purchaseDb)) as DrizzleEventRefundClaims;
    dying.release = async () => undefined;
    payOutcome = 'REJECTED';
    try {
      await postponeService(NOW + MINUTE, requestId, { claims: dying })
        .runDue()
        .catch(() => undefined);
    } finally {
      await purchaseDb.pool.query('drop trigger if exists n7_item_fail on event_refund_item; drop function if exists n7_item_fail();');
    }
    try {
      const cut = await itemOf(requestId, s.ticketId);
      // 장애 주입이 끼어들었는지 먼저: 결제사는 한 번 불렸고, 행에 실패 표시가 없고, 항목은 끝나지 않았고 잡기 값이 남았다
      expect(callsFor(cut!.cancellation_id)).toBe(1);
      expect((await rowOf(cut!.cancellation_id))?.refund_failed_at ?? null).toBeNull();
      expect(cut?.status).not.toBe('FAILED');
      expect(cut?.claim_token).not.toBeNull();
      // 잡기 기한 안(59,999ms)에는 다시 잡히지 않는다
      await postponeService(NOW + MINUTE + EVENT_REFUND_CLAIM_MS - 1, requestId).runDue();
      expect(callsFor(cut!.cancellation_id)).toBe(1);
      // 잡기 기한(60,000ms) 뒤 runDue: 다시 잡혀 같은 cancel-{취소 ID}로 다시 부르고 FAILED로 끝난다
      await postponeService(NOW + MINUTE + EVENT_REFUND_CLAIM_MS, requestId).runDue();
      expect(pays.filter((p) => p.cancellationId === cut!.cancellation_id)).toHaveLength(2);
      // 대역 원장: 거절만 받았으니 나간 돈은 0이다
      expect(await cancellationsOf([s.orderId])).toEqual([expect.objectContaining({ id: cut!.cancellation_id, status: 'REFUND_PENDING' })]);
      expect(await itemOf(requestId, s.ticketId)).toMatchObject({ status: 'FAILED', last_error: 'REJECTED' });
      expect((await rowOf(cut!.cancellation_id))?.refund_failed_at).not.toBeNull();
      expect(ops.state.requests.filter((r) => r.body.sourceId === cut!.cancellation_id)).toHaveLength(1);
      expect(await fanFailures(eventId, s.ticketId, requestId)).toHaveLength(1);
    } finally {
      payOutcome = 'CANCELLED';
    }
  }, 60_000);
});
