// 예매 취소 Saga(GAT-070·GAT-080)를 실제 PostgreSQL 18·Valkey 8.1·실제 ticket-svc/payment-svc gRPC로 돈다.
// 정본: docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1, docs/data.md order_cancellation,
// docs/api/proto/peaket/ticket/v1/ticket.proto CancelTickets, docs/api/proto/peaket/payment/v1/payment.proto CancelPayment.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰되, purchase·ticket·payment는 서로 다른 데이터베이스다(같은 이름의 outbox 표를 나눈다).
// - 회차·계정·주문·티켓 ID는 시험마다 새 UUID라 서로 닿지 않는다.
// - ticket-svc와 payment-svc는 운영 처리기·저장소를 그대로 띄운다. 결제사만 기록 대역이다(멱등키와 금액을 본다).
// - Redis 비트맵·secver·구역 Pub/Sub은 실제 Valkey에서 읽고, 취소표 Lua가 낸 글을 구독해 확인한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createHotRedis, fakeClock, type Database, type HotRedis } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  CancelConfirmedPayment,
  CancelPayment,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  GetPaymentDetail,
  NoKeyVirtualAccountCipher,
  paymentPackage,
  paymentServiceHandlers,
} from '../../payment-svc/src/modules/payment/server.js';
import type { CancelResult, PaymentGatewayPort } from '../../payment-svc/src/modules/payment/domain/payment-gateway.js';
import { migratePayment } from '../../payment-svc/scripts/migrate.mjs';
import { startGrpcServer } from '../../ticket-svc/src/grpc-server.js';
import { DrizzleTicketStore } from '../../ticket-svc/src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../../ticket-svc/src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../../ticket-svc/src/modules/ticket/inbound/ticket.grpc.js';
import { migrateTicket } from '../../ticket-svc/scripts/migrate.mjs';
import { DrizzleSeatSales, MemorySeatMap, RedisSeatStore, seatKeys } from '../src/modules/inventory/index.js';
import {
  CancelTicket,
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleSeatReturns,
  GrpcPaymentCancellations,
  GrpcTicketCancellations,
  QuoteCancellation,
  RedisSeatReturnNotices,
  RefundAfterEntry,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type ShardSubscriber, shardSubscriber, startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const PRICE = 100_000;

let pgc: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let purchaseDb: Database;
let ticketDb: Database;
let paymentDb: Database;
let admin: Database;
let redis: HotRedis;
let seatMap: MemorySeatMap;
let sales: DrizzleSeatSales;
let store: RedisSeatStore;
let ticketService: TicketService;
let ticketServer: { port: number; close(): Promise<void> } | undefined;
let paymentServer: { port: number; close(): Promise<void> } | undefined;
let ticketCancels: GrpcTicketCancellations | undefined;
let paymentCancels: GrpcPaymentCancellations | undefined;
let saga: CancelTicket;
let quote: QuoteCancellation;
let writes: DrizzleCancellationWrites;
let gatewayOutcome: CancelResult['outcome'] = 'CANCELLED';
let gatewayCalls: Parameters<PaymentGatewayPort['cancel']>[0][] = [];
const calendar = new WeekendBusinessCalendar();

/** 같은 PostgreSQL 서버에 이름이 다른 데이터베이스를 만든다(마이그레이션 표·outbox 이름이 겹치지 않게) */
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
  const paymentUrl = await createNamedDatabase(pgc.url, 'payment');
  await migratePurchase(pgc.url);
  await migrateTicket(ticketUrl);
  await migratePayment(paymentUrl);
  purchaseDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'cancellation-it-purchase' });
  ticketDb = createDatabase({ url: ticketUrl, profile: 'general', max: 6, applicationName: 'cancellation-it-ticket' });
  paymentDb = createDatabase({ url: paymentUrl, profile: 'general', max: 6, applicationName: 'cancellation-it-payment' });
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'cancellation-it-admin' });
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  seatMap = new MemorySeatMap();
  sales = new DrizzleSeatSales(purchaseDb);
  store = new RedisSeatStore(redis);

  const clock = fakeClock({ now: NOW });
  ticketService = new TicketService({ store: new DrizzleTicketStore({ database: ticketDb }), clock });
  ticketServer = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: ticketService, nowMs: () => NOW }, () => {}) }],
  });

  const jobs = new DrizzleConfirmJobs({ database: paymentDb, clock });
  const paymentStore = new DrizzlePaymentStore({ database: paymentDb, batchDatabase: paymentDb });
  const gateway = {
    pg: 'TOSS',
    cancel: async (c: Parameters<PaymentGatewayPort['cancel']>[0]) => {
      gatewayCalls.push(c);
      return { outcome: gatewayOutcome };
    },
  } as unknown as PaymentGatewayPort;
  const confirmed = new CancelConfirmedPayment({
    store: jobs,
    gateways: { of: () => gateway },
    guards: { of: () => ({ circuitClosed: () => true, tryTakeToken: () => true }) as never },
    clock,
  });
  const cancelPayment = new CancelPayment({ execute: async () => Promise.reject(new Error('입금 전 취소 갈래가 아니다')) } as never, confirmed, jobs);
  const getPayment = new GetPaymentDetail({
    reader: paymentStore,
    signals: { getPayment: () => {} },
    cipher: new NoKeyVirtualAccountCipher(),
    depositLog: { infoMissing: () => {}, accountUnsaved: () => {}, accountUnopened: () => {} },
    depositSignals: { fieldFailure: () => {} },
    clock,
  });
  paymentServer = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: paymentPackage().PaymentService.service,
        handlers: paymentServiceHandlers(
          {
            accept: { execute: async () => Promise.reject(new Error('이 시험은 승인 명령을 부르지 않는다')) } as never,
            batchGet: { execute: async () => Promise.reject(new Error('이 시험은 결과 당기기를 부르지 않는다')) } as never,
            getPayment,
            cancelPayment,
          },
          () => {},
        ),
      },
    ],
  });

  const orders = new DrizzleCancellationOrders(purchaseDb, seatMap);
  writes = new DrizzleCancellationWrites(purchaseDb);
  ticketCancels = new GrpcTicketCancellations({ address: `127.0.0.1:${ticketServer.port}` });
  paymentCancels = new GrpcPaymentCancellations({ address: `127.0.0.1:${paymentServer.port}` });
  quote = new QuoteCancellation({ orders, calendar });
  saga = new CancelTicket({
    orders,
    calendar,
    tickets: ticketCancels,
    payments: paymentCancels,
    writes,
    seats: new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis)),
  });
}, 180_000);

afterAll(async () => {
  ticketCancels?.close();
  paymentCancels?.close();
  await ticketServer?.close();
  await paymentServer?.close();
  await Promise.allSettled([purchaseDb?.close(), ticketDb?.close(), paymentDb?.close(), admin?.close()]);
  await redis?.close();
  valkey?.stop();
  pgc?.stop();
});

interface World {
  eventId: string;
  orderId: string;
  accountId: string;
  seatId: string;
  ticketId: string;
  paymentId: string;
  eventStartsAtMs: number;
  saleEndsAtMs: number;
  entryOpensAtMs?: number;
}

/** 주문·티켓·판매 확정·결제 원장·Redis 비트맵을 한 회차에 맞춰 넣는다 */
async function world(o: { eventStartsAtMs?: number; entryOpensAtMs?: number; ticketPrice?: number } = {}): Promise<World> {
  const eventId = randomUUID();
  const orderId = randomUUID();
  const accountId = randomUUID();
  const seatId = randomUUID();
  const ticketPrice = o.ticketPrice ?? PRICE;
  const eventStartsAtMs = o.eventStartsAtMs ?? NOW + 7 * DAY;
  const saleEndsAtMs = eventStartsAtMs - DAY;
  seatMap.put(
    {
      eventId,
      layoutVersion: 'v1',
      seatCount: 10,
      perAccountLimit: 4,
      saleEndsAtMs,
      tierPrices: { R: ticketPrice },
      ...(o.entryOpensAtMs !== undefined ? { entryOpensAtMs: o.entryOpensAtMs } : {}),
    },
    [{ seatId, index: 3, sectionId: 'A', sectionIndex: 0, seatOffset: 3, tierId: 'R' }],
  );
  const bookedAt = new Date(NOW - 12 * DAY);
  // 주문과 첫 이력(T1)은 한 트랜잭션에 쓴다: 지연 제약 order_status_has_event가 커밋 때 둘을 맞춘다
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', $6, $7, 'ps-test')`,
      [orderId, accountId, eventId, ticketPrice, randomUUID(), bookedAt, randomUUID()],
    );
    await client.query(
      `insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
       values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)`,
      [orderId, bookedAt],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const issued = await ticketService.issue({ orderId, eventId, payerAccountId: accountId, seatIds: [seatId], issueGeneration: 0 });
  const ticketId = issued.tickets[0]!.ticketId;
  await admin.pool.query(
    `insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id)
     values ($1, 1, $2, 'R', 'A', $3, $4)`,
    [orderId, seatId, ticketPrice, ticketId],
  );
  expect(await sales.reserve({ eventId, accountId, orderId, seatIds: [seatId], limit: 4 })).toEqual({ status: 'RESERVED' });
  expect(await sales.markSold({ eventId, orderId, seatIds: [seatId] })).toBe(1);
  await store.openSale({ eventId, seatCount: 10, keepUntilMs: saleEndsAtMs + DAY });
  await redis.command(['SETBIT', seatKeys.bitmap(eventId), '3', '1'], { key: seatKeys.bitmap(eventId) });

  const paymentId = randomUUID();
  await paymentDb.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, created_at, approved_at, status_changed_at)
     values ($1, $2, $3, $4, 1, 'TOSS', $5, $6, 'APPROVED', $7, $8, $8, $8, $8)`,
    [paymentId, orderId, eventId, randomUUID(), `ref-${orderId}`, ticketPrice, `confirm-${orderId}`, bookedAt],
  );
  return { eventId, orderId, accountId, seatId, ticketId, paymentId, eventStartsAtMs, saleEndsAtMs, ...(o.entryOpensAtMs !== undefined ? { entryOpensAtMs: o.entryOpensAtMs } : {}) };
}

const cancelOf = (w: World, cancellationId: string, reason: 'USER' | 'FRAUD' = 'USER', nowMs = NOW) =>
  saga.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId, reason, nowMs, deadlineMs: 5_000 });

const cancellationRow = async (cancellationId: string) =>
  (await admin.pool.query('select * from order_cancellation where id = $1', [cancellationId])).rows[0] as
    | { status: string; reason: string; deduction_bp: number; deduction_amount: number; refund_amount: number; refund_due_at: Date | null }
    | undefined;
const paymentRow = async (paymentId: string) =>
  (await paymentDb.pool.query('select status, cancelled_amount from payment where id = $1', [paymentId])).rows[0] as
    | { status: string; cancelled_amount: number }
    | undefined;
const ticketRow = async (ticketId: string) => (await ticketDb.pool.query('select status, key_revoked_at from ticket where id = $1', [ticketId])).rows[0] as { status: string; key_revoked_at: Date | null };

describe('0014 order_cancellation', () => {
  test('GAT080_0014는 order_cancellation과 refund_due_at·진행 중 취소 1건 유일 색인을 만든다', async () => {
    const cols = await admin.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'order_cancellation' order by ordinal_position",
    );
    expect(cols.rows).toEqual(
      expect.arrayContaining([
        { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'order_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'ticket_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'deduction_bp', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'refund_amount', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'refund_due_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      ]),
    );
    const idx = await admin.pool.query<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'order_cancellation'");
    expect(idx.rows.find((r) => r.indexname === 'order_cancellation_active_key')?.indexdef).toContain("status <> 'VOIDED'");
    expect(idx.rows.find((r) => r.indexname === 'order_cancellation_status_idx')?.indexdef).toContain('(status, created_at)');
  });
});

describe('Redis 취소표', () => {
  test('GAT080_세대키가_없으면_NOT_READY이고_비트맵을_건드리지_않는다', async () => {
    const eventId = randomUUID();
    const notices = new RedisSeatReturnNotices(redis);
    await expect(notices.returnSold({ eventId, seats: [{ index: 3, sectionIndex: 0, seatOffset: 3 }], keepUntilMs: NOW + DAY })).resolves.toBe('NOT_READY');
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(eventId), '3'], { key: seatKeys.bitmap(eventId) }))).toBe(0);
    expect(await redis.command(['HGET', seatKeys.secver(eventId), '0'], { key: seatKeys.secver(eventId) })).toBeNull();
  });
});

describe('견적·취소 Saga', () => {
  test('GAT070_견적은_결제자에게_공제율과_환급액을_준다', async () => {
    const w = await world();
    const q = await quote.execute({ accountId: w.accountId, ticketId: w.ticketId, nowMs: NOW });
    expect(q).toMatchObject({
      status: 'OK',
      quote: { ticketId: w.ticketId, orderId: w.orderId, ticketPrice: PRICE, daysBefore: 7, deductionBp: 1000, deductionAmount: 10_000, refundAmount: 90_000, refundAfterEntryClose: false },
    });
    expect(await quote.execute({ accountId: randomUUID(), ticketId: w.ticketId, nowMs: NOW })).toEqual({ status: 'NOT_PAYER' });
  });

  test('GAT080_취소는_티켓키폐기·좌석RETURNED·Redis비트해제·결제사부분취소를_한번에_한다', async () => {
    const w = await world();
    const sub: ShardSubscriber = await shardSubscriber(valkey!.url);
    await sub.subscribe([`s:{event:${w.eventId}}:sec:0`]);
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    try {
      const cancellationId = randomUUID();
      await expect(cancelOf(w, cancellationId)).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: 90_000, refundAfterEntryClose: false });

      expect(await cancellationRow(cancellationId)).toMatchObject({
        status: 'REFUNDED',
        reason: 'USER',
        deduction_bp: 1000,
        deduction_amount: 10_000,
        refund_amount: 90_000,
        refund_due_at: null,
      });
      expect(gatewayCalls).toHaveLength(1);
      expect(gatewayCalls[0]).toMatchObject({ paymentRef: `ref-${w.orderId}`, amount: 90_000, reason: 'USER', idemKey: `cancel-${cancellationId}` });
      expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'PARTIAL_CANCELED', cancelled_amount: 90_000 });
      expect(await ticketRow(w.ticketId)).toMatchObject({ status: 'REFUNDED' });
      expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('RETURNED');
      expect((await admin.pool.query('select used from purchase_quota where account_id = $1 and event_id = $2', [w.accountId, w.eventId])).rows[0].used).toBe(0);
      expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '3'], { key: seatKeys.bitmap(w.eventId) }))).toBe(0);
      expect(String(await redis.command(['HGET', seatKeys.secver(w.eventId), '0'], { key: seatKeys.secver(w.eventId) }))).toBe('1');
      await sub.sync();
      expect(sub.messages).toHaveLength(1);
      expect(sub.messages[0]!.channel).toBe(`s:{event:${w.eventId}}:sec:0`);
      expect(sub.messages[0]!.message).toMatch(/^1 \d+ 0 1 \d+ 3:0$/);
    } finally {
      sub.close();
    }
  });

  test('GAT080_부정예매_FRAUD는_공제0원으로_전액환급한다', async () => {
    const w = await world();
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId, 'FRAUD')).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: PRICE, refundAfterEntryClose: false });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', reason: 'FRAUD', deduction_bp: 0, deduction_amount: 0, refund_amount: PRICE });
    // 남은 금액 전액이면 결제사 어댑터가 'ALL'로 보낸다
    expect(gatewayCalls[0]).toMatchObject({ amount: 'ALL', reason: 'FRAUD' });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'CANCELED', cancelled_amount: PRICE });
  });

  test('GAT080_입장시작뒤취소는_REQUESTED와_refund_due_at을_남기고_마감뒤_환급기가_결제사를_부른다', async () => {
    const w = await world({ eventStartsAtMs: NOW + 2 * HOUR, entryOpensAtMs: NOW - HOUR });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: 10_000, refundAfterEntryClose: true });
    expect(gatewayCalls).toHaveLength(0);
    expect(await cancellationRow(cancellationId)).toMatchObject({
      status: 'REQUESTED',
      deduction_bp: 9000,
      deduction_amount: 90_000,
      refund_amount: 10_000,
    });
    const due = (await admin.pool.query('select refund_due_at from order_cancellation where id = $1', [cancellationId])).rows[0].refund_due_at as Date;
    // 입장 기록 마감의 보수적 상한 = 공연 시작 + 50시간(공연 24 + 역할 유효 끝 2 + 미보고 24)
    expect(due.getTime()).toBe(w.eventStartsAtMs + 50 * HOUR);
    // ticket-svc는 공연 시작 전이라 REFUND_NOW를 주지만, 견적이 입장 시작 뒤라고 했으므로 환급을 미룬다
    expect(await ticketRow(w.ticketId)).toMatchObject({ status: 'REFUNDED' });

    const later = new RefundAfterEntry({ writes, payments: paymentCancels!, nowMs: () => w.eventStartsAtMs + 50 * HOUR + 1 });
    await expect(later.run()).resolves.toEqual({ refunded: 1, pending: 0 });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_amount: 10_000 });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ amount: 10_000, idemKey: `cancel-${cancellationId}` });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'PARTIAL_CANCELED', cancelled_amount: 10_000 });
  });

  test('GAT080_결제사_UNKNOWN은_REFUND_PENDING으로_남고_같은취소ID_재요청이_같은멱등키로_다시부른다', async () => {
    const w = await world();
    gatewayOutcome = 'UNKNOWN';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'REFUND_PENDING', cancellationId, refundAmount: 90_000, payment: 'UNKNOWN' });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING' });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'APPROVED', cancelled_amount: 0 });
    expect(gatewayCalls).toHaveLength(1);

    // 같은 티켓의 다른 취소 ID는 진행 중 취소와 겹쳐 CONFLICT다(결제사를 부르지 않는다)
    await expect(cancelOf(w, randomUUID())).resolves.toEqual({ status: 'CONFLICT' });
    expect(gatewayCalls).toHaveLength(1);

    gatewayOutcome = 'CANCELLED';
    await expect(cancelOf(w, cancellationId)).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: 90_000, refundAfterEntryClose: false });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[1]).toMatchObject({ amount: 90_000, idemKey: `cancel-${cancellationId}` });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED' });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'PARTIAL_CANCELED', cancelled_amount: 90_000 });
    const sent = await paymentDb.pool.query("select count(*)::int as n from payment_event where payment_id = $1 and type = 'CONFIRMED_CANCEL_SENT'", [w.paymentId]);
    expect(sent.rows[0].n).toBe(1);
  });

  test('GAT080_같은취소ID_재요청은_끝난뒤_결제사를_다시부르지_않는다', async () => {
    const w = await world();
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'ACCEPTED' });
    await expect(cancelOf(w, cancellationId)).resolves.toEqual({ status: 'REPLAYED', cancellationId, refundAmount: 90_000, refundAfterEntryClose: false });
    expect(gatewayCalls).toHaveLength(1);
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED' });
  });
});
