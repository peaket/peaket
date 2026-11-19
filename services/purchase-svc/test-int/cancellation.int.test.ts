// 예매 취소 Saga(GAT-070·GAT-080)를 실제 PostgreSQL 18·Valkey 8.1·실제 ticket-svc/payment-svc gRPC로 돈다.
// 정본: docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1, docs/data.md order_cancellation,
// docs/api/proto/peaket/ticket/v1/ticket.proto CancelTickets, docs/api/proto/peaket/payment/v1/payment.proto CancelPayment.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰되, purchase·ticket·payment는 서로 다른 데이터베이스다(같은 이름의 outbox 표를 나눈다).
// - 회차·계정·주문·티켓 ID는 시험마다 새 UUID라 서로 닿지 않는다.
// - ticket-svc와 payment-svc는 운영 처리기·저장소를 그대로 띄운다. 결제사만 기록 대역이다(멱등키와 금액을 본다).
// - Redis 비트맵·secver·구역 Pub/Sub은 실제 Valkey에서 읽고, 취소표 Lua가 낸 글을 구독해 확인한다.
// - BAT-415: 맨 아래 묶음이 장부 범위 R-T3(양도 요청 중 거절)·R-T4(돌려받은 표의 결제자 취소, payment_cancel 한 행)를 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createExternalHttpClient, createHotRedis, ensureOutboxPartitions, fakeClock, type Database, type HotRedis } from '@peaket/platform';
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
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../../payment-svc/src/modules/payment/domain/payment-gateway.js';
import { migratePayment } from '../../payment-svc/scripts/migrate.mjs';
import { startGrpcServer } from '../../ticket-svc/src/grpc-server.js';
import { DrizzleTicketStore } from '../../ticket-svc/src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../../ticket-svc/src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../../ticket-svc/src/modules/ticket/inbound/ticket.grpc.js';
import { migrateTicket } from '../../ticket-svc/scripts/migrate.mjs';
import { DrizzleOrderStore } from '../src/modules/booking/index.js';
import { DrizzleSeatSales, MemorySeatMap, RedisSeatStore, seatKeys } from '../src/modules/inventory/index.js';
import {
  CancelTicket,
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleEventRefundHolds,
  DrizzleSeatReturns,
  GrpcPaymentCancellations,
  GrpcTicketCancellations,
  QuoteCancellation,
  RedisSeatReturnNotices,
  RefundAfterEntry,
  RequestRefundAccount,
  type SeatReturns,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
// 다시 보기 2 N1·N2(시험 담당 l3w8-420-n-test)
import { DrizzleCsCaseOutbox, HttpEntryFlagNotice, HttpRefundFailureNotice } from '../src/modules/refund/index.js';
// BAT-420-rest P-T72(시험 담당 l3-b420-test)
import { HttpRefundAccountNotice } from '../src/modules/refund/index.js';
import { startOpsCsDouble } from './ops-cs-double.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type ShardSubscriber, shardSubscriber, startValkey, type ValkeyContainer } from './valkey.js';

// 기준 시각(NOW)은 Valkey 서버 시각에서 잡는다(beforeAll). 판매 보관 시한(NOW + 7일)을 Lua가 PEXPIREAT·Redis TIME과 견주므로
// 고정 날짜로 두면 그날이 지난 뒤 반납 단언이 깨진다(W8-ci-fix). 서버 기준 한국 날짜의 3일 전 10:00(한국 시각)으로 둔다
// 공연 시각도 고정 날짜로 두지 않고 NOW에서 센다: 공제 구간(달력일)이 오늘 날짜에 따라 바뀌지 않게 한다(다시 쌓은 뒤 고침 2026-11-17)
let NOW: number;
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
/** BAT-420 A3: 결제사 대역이 답하기 직전에 부를 끼어들기(그사이 CS가 취소를 무효로 바꾼 경우를 흉내 낸다) */
let beforeGatewayAnswer: (() => Promise<void>) | undefined;
let writes: DrizzleCancellationWrites;
let gatewayOutcome: CancelResult['outcome'] = 'CANCELLED';
let gatewayCalls: Parameters<PaymentGatewayPort['cancel']>[0][] = [];
/** RV-01: 계좌 없이 온 같은 시도의 재시도가 결제사 조회로 정산하는지 본다 */
let gatewayQuery: QueryResult = { kind: 'UNKNOWN' };
let gatewayQueries: string[] = [];
/** BAT-420-rest P-T72: 결제사 대역 거절의 까닭(REFUND_ACCOUNT_INVALID면 계좌 거절) */
let gatewayReason: CancelResult['reason'] | undefined;
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
  const t = (await redis.command(['TIME'], {})) as unknown[];
  const serverMs = Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
  const KST = 9 * HOUR;
  const dayStart = Math.floor((serverMs + KST) / DAY) * DAY - KST; // 서버 기준 한국 날짜 0시(UTC 밀리초)
  NOW = dayStart - 3 * DAY + 10 * HOUR;
  await ensureOutboxPartitions(admin, fakeClock({ now: NOW }));
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
      if (beforeGatewayAnswer) await beforeGatewayAnswer();
      // BAT-420-rest P-T72(시험 담당 l3-b420-test): 계좌 거절의 까닭을 실을 수 있게 한다(없으면 지금과 같다)
      return { outcome: gatewayOutcome, ...(gatewayReason ? { reason: gatewayReason } : {}) };
    },
    query: async (paymentRef: string) => {
      gatewayQueries.push(paymentRef);
      return gatewayQuery;
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
  writes = new DrizzleCancellationWrites(purchaseDb, new DrizzleOrderStore({ clock }));
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

/** Valkey 서버 시각(epoch 밀리초): 초 × 1000 + floor(마이크로초 ÷ 1000) */
const valkeyMs = async (): Promise<number> => {
  const t = (await redis.command(['TIME'], {})) as unknown[];
  return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
};

const cancelOf = (w: World, cancellationId: string, reason: 'USER' | 'FRAUD' | 'EVENT_POSTPONED' = 'USER', nowMs = NOW) =>
  saga.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId, reason, nowMs, deadlineMs: 5_000 });

const cancellationRow = async (cancellationId: string) =>
  (await admin.pool.query('select * from order_cancellation where id = $1', [cancellationId])).rows[0] as
    | {
        status: string;
        reason: string;
        deduction_bp: number;
        deduction_amount: number;
        refund_amount: number;
        refund_due_at: Date | null;
        refund_attempts: number;
        next_refund_at: Date | null;
        refund_failed_at: Date | null;
        refund_last_error: string | null;
      }
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
      // WIR-01: 델타의 변경 시각(changedAtMs)이 Redis TIME의 epoch 밀리초인지 앞뒤 Valkey TIME으로 잰다(앱 시계는 쓰지 않는다)
      const beforeMs = await valkeyMs();
      await expect(cancelOf(w, cancellationId)).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: 90_000, refundAfterEntryClose: false });
      const afterMs = await valkeyMs();

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
      expect((await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status).toBe('REFUNDED');
      expect((await admin.pool.query('select used from purchase_quota where account_id = $1 and event_id = $2', [w.accountId, w.eventId])).rows[0].used).toBe(0);
      expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '3'], { key: seatKeys.bitmap(w.eventId) }))).toBe(0);
      expect(String(await redis.command(['HGET', seatKeys.secver(w.eventId), '0'], { key: seatKeys.secver(w.eventId) }))).toBe('1');
      await sub.sync();
      expect(sub.messages).toHaveLength(1);
      expect(sub.messages[0]!.channel).toBe(`s:{event:${w.eventId}}:sec:0`);
      const delta = /^1 \d+ 0 1 (\d+) 3:0$/.exec(sub.messages[0]!.message);
      expect(delta, sub.messages[0]!.message).not.toBeNull();
      const changedAtMs = Number(delta![1]);
      expect(changedAtMs).toBeGreaterThanOrEqual(beforeMs);
      expect(changedAtMs).toBeLessThanOrEqual(afterMs);
    } finally {
      sub.close();
    }
  });

  test('GAT090_주문에_남은_티켓이_있으면_PARTIALLY_REFUNDED다', async () => {
    const w = await world();
    await admin.pool.query(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) values ($1, 2, $2, 'R', 'A', $3)`, [w.orderId, randomUUID(), PRICE]);
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect((await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status).toBe('PARTIALLY_REFUNDED');
  });

  test('GAT090_두_항목_주문에서_두번째_취소는_T25를_거쳐_T23으로_끝난다', async () => {
    const w = await world();
    const seat2 = randomUUID();
    seatMap.put(
      { eventId: w.eventId, layoutVersion: 'v1', seatCount: 10, perAccountLimit: 4, saleEndsAtMs: w.saleEndsAtMs, tierPrices: { R: PRICE } },
      [
        { seatId: w.seatId, index: 3, sectionId: 'A', sectionIndex: 0, seatOffset: 3, tierId: 'R' },
        { seatId: seat2, index: 4, sectionId: 'A', sectionIndex: 0, seatOffset: 4, tierId: 'R' },
      ],
    );
    const issued = await ticketService.issue({ orderId: w.orderId, eventId: w.eventId, payerAccountId: w.accountId, seatIds: [seat2], issueGeneration: 1 });
    const ticket2 = issued.tickets[0]!.ticketId;
    await admin.pool.query(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 2, $2, 'R', 'A', $3, $4)`, [w.orderId, seat2, PRICE, ticket2]);
    await admin.pool.query('update purchase_order set amount = $2 where id = $1', [w.orderId, PRICE * 2]);
    await paymentDb.pool.query('update payment set amount = $2 where id = $1', [w.paymentId, PRICE * 2]);
    expect(await sales.reserve({ eventId: w.eventId, accountId: w.accountId, orderId: w.orderId, seatIds: [seat2], limit: 4 })).toEqual({ status: 'RESERVED' });
    expect(await sales.markSold({ eventId: w.eventId, orderId: w.orderId, seatIds: [seat2] })).toBe(1);
    await redis.command(['SETBIT', seatKeys.bitmap(w.eventId), '4', '1'], { key: seatKeys.bitmap(w.eventId) });

    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    await expect(cancelOf(w, randomUUID())).resolves.toMatchObject({ status: 'ACCEPTED' });
    await expect(saga.execute({ accountId: w.accountId, ticketId: ticket2, cancellationId: randomUUID(), reason: 'USER', nowMs: NOW, deadlineMs: 5_000 })).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect((await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status).toBe('REFUNDED');
    const causes = (await admin.pool.query<{ cause: string }>('select cause from order_event where order_id = $1 order by seq', [w.orderId])).rows.map((r) => r.cause);
    expect(causes).toEqual(expect.arrayContaining(['T22', 'T25', 'T23']));
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

  test('GAT080_연기_EVENT_POSTPONED는_입장_시작_뒤에도_공제0원으로_전액환급한다', async () => {
    const w = await world({ eventStartsAtMs: NOW + 2 * HOUR, entryOpensAtMs: NOW - HOUR });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId, 'EVENT_POSTPONED')).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: PRICE, refundAfterEntryClose: false });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', reason: 'EVENT_POSTPONED', deduction_bp: 0, deduction_amount: 0, refund_amount: PRICE });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ amount: 'ALL', reason: 'EVENT_POSTPONED' });
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

    const later = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => w.eventStartsAtMs + 50 * HOUR + 1 });
    await expect(later.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
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
    expect(await cancellationRow(cancellationId)).toMatchObject({
      status: 'REFUND_PENDING',
      refund_attempts: 1,
      next_refund_at: new Date(NOW + 60_000),
      refund_failed_at: null,
      refund_last_error: 'UNKNOWN',
    });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'APPROVED', cancelled_amount: 0 });
    expect(gatewayCalls).toHaveLength(1);
    // 환급이 끝나지 않았어도 취소가 접수됐으므로 주문은 부분 환불이고, 이력·Outbox에 T22가 남는다
    expect((await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status).toBe('PARTIALLY_REFUNDED');
    const events = await admin.pool.query<{ cause: string; to_status: string }>('select cause, to_status from order_event where order_id = $1 order by seq', [w.orderId]);
    expect(events.rows.at(-1)).toEqual({ cause: 'T22', to_status: 'PARTIALLY_REFUNDED' });
    const outbox = await admin.pool.query<{ payload: Buffer }>('select payload from outbox where msg_key = $1', [w.eventId]);
    expect(outbox.rows.map((r) => (JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string }).type)).toContain('PARTIALLY_REFUNDED');

    // 같은 티켓의 다른 취소 ID(새 키)는 ticket-svc가 첫 팬 취소(이 취소 ID)를 알려 주므로 그 ID로 잇는다(리뷰 B2,
    // docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기'). 그 취소 행이 REFUND_PENDING이라 같은 멱등키로 결제사를 다시 부른다
    await expect(cancelOf(w, randomUUID())).resolves.toEqual({ status: 'REFUND_PENDING', cancellationId, refundAmount: 90_000, payment: 'UNKNOWN' });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[1]).toMatchObject({ amount: 90_000, idemKey: `cancel-${cancellationId}` });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', refund_attempts: 2, next_refund_at: new Date(NOW + 5 * 60_000), refund_failed_at: null });
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(1);

    // 다음 재시도 시각(두 번째 실패 뒤 5분)이 지나면 실행기가 같은 멱등키로 다시 부른다
    gatewayOutcome = 'CANCELLED';
    const early = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + 5 * 60_000 - 1 });
    await expect(early.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(gatewayCalls).toHaveLength(2);
    const retry = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + 5 * 60_000 });
    await expect(retry.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(gatewayCalls).toHaveLength(3);
    expect(gatewayCalls[2]).toMatchObject({ amount: 90_000, idemKey: `cancel-${cancellationId}` });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempts: 2, next_refund_at: null, refund_failed_at: null });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'PARTIAL_CANCELED', cancelled_amount: 90_000 });
    const sent = await paymentDb.pool.query("select count(*)::int as n from payment_event where payment_id = $1 and type = 'CONFIRMED_CANCEL_SENT'", [w.paymentId]);
    expect(sent.rows[0].n).toBe(1);
    await expect(cancelOf(w, cancellationId)).resolves.toEqual({ status: 'REPLAYED', cancellationId, refundAmount: 90_000, refundAfterEntryClose: false });
    expect(gatewayCalls).toHaveLength(3);
  });

  test('GAT090_업무거절은_refund_failed_at을_남기고_실행기가_건너뛴다', async () => {
    const w = await world();
    gatewayOutcome = 'REJECTED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'REFUND_PENDING', payment: 'REJECTED' });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', refund_attempts: 1, next_refund_at: null, refund_last_error: 'REJECTED' });
    expect((await cancellationRow(cancellationId))!.refund_failed_at).not.toBeNull();
    expect(gatewayCalls).toHaveLength(1);

    gatewayOutcome = 'CANCELLED';
    const retry = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + 24 * HOUR });
    await expect(retry.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(gatewayCalls).toHaveLength(1);
  });

  test('GAT090_재시도_상한을_넘으면_refund_failed_at을_남긴다', async () => {
    const w = await world();
    gatewayOutcome = 'UNKNOWN';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await cancelOf(w, cancellationId);
    await admin.pool.query('update order_cancellation set refund_attempts = 4, next_refund_at = $2 where id = $1', [cancellationId, new Date(NOW + 60_000)]);
    const retry = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + 60_001 });
    await expect(retry.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 1, entryRecorded: 0, unverified: 0, held: 0 });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', refund_attempts: 5, next_refund_at: null, refund_last_error: 'UNKNOWN' });
    expect((await cancellationRow(cancellationId))!.refund_failed_at).not.toBeNull();
    expect(gatewayCalls).toHaveLength(2);
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

// ---- 장부 범위 R-T3·R-T4(docs/features/transfer-refund.md §11, BAT-415 몫 S) ----
describe('R-T3·R-T4 결제자와 보유자', () => {
  test('R-T3 양도 요청 중인 티켓은 실제 ticket-svc가 거절하고 키·상태·좌석·취소 행·결제사 호출이 그대로다', async () => {
    const w = await world();
    await ticketDb.pool.query('update ticket set transfer_pending = true where id = $1', [w.ticketId]);
    const before = (await ticketDb.pool.query('select status, account_id, key_revoked_at, transfer_pending, version from ticket where id = $1', [w.ticketId])).rows[0];
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    await expect(cancelOf(w, randomUUID())).resolves.toEqual({ status: 'TRANSFER_PENDING' });
    expect((await ticketDb.pool.query('select status, account_id, key_revoked_at, transfer_pending, version from ticket where id = $1', [w.ticketId])).rows[0]).toEqual(before);
    expect(before).toMatchObject({ status: 'ISSUED', key_revoked_at: null, transfer_pending: true, version: 0 });
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('SOLD');
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status).toBe('CONFIRMED');
    expect(gatewayCalls).toHaveLength(0);
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'APPROVED', cancelled_amount: 0 });
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '3'], { key: seatKeys.bitmap(w.eventId) }))).toBe(1);
  });

  test('R-T4 돌려받은 티켓을 결제자가 공연 4일 전에 취소하면 20% 공제로 처음 결제의 부분 취소 한 번으로 환급한다', async () => {
    // 권면 33,333원, 공연 NOW + 7일 19:00(한국 시각), 예매 NOW − 12일, 지금 NOW + 3일 10:00(공연 4일 전 달력일, 공제 20%. 예매 뒤 영업시간 24시간이 지나 24시간 안 무료가 아니다)
    const w = await world({ eventStartsAtMs: NOW + 7 * DAY + 9 * HOUR, ticketPrice: 33_333 });
    // 양도 기능(GAT-050) 전이라 '받은 사람에게 넘어갔다가 돌려받음'을 SQL로 흉내 낸다: 보유자 결제자 → 받은 사람(version 1) → 결제자(version 2)
    await ticketDb.pool.query('update ticket set account_id = $2, version = 1 where id = $1', [w.ticketId, randomUUID()]);
    await ticketDb.pool.query('update ticket set account_id = $2, version = 2 where id = $1', [w.ticketId, w.accountId]);
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    const nowMs = NOW + 3 * DAY;
    await expect(cancelOf(w, cancellationId, 'USER', nowMs)).resolves.toEqual({ status: 'ACCEPTED', cancellationId, refundAmount: 26_667, refundAfterEntryClose: false });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', reason: 'USER', deduction_bp: 2_000, deduction_amount: 6_666, refund_amount: 26_667, refund_due_at: null });
    // 처음 결제(그 주문의 원래 결제 참조)로 한 번, 환불 계좌 없이
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ paymentRef: `ref-${w.orderId}`, amount: 26_667, reason: 'USER', idemKey: `cancel-${cancellationId}` });
    expect(gatewayCalls[0]).not.toHaveProperty('refundAccount');
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'PARTIAL_CANCELED', cancelled_amount: 26_667 });
    const cancels = await paymentDb.pool.query('select idempotency_key, amount, expected_balance, status from payment_cancel where payment_id = $1', [w.paymentId]);
    expect(cancels.rows).toEqual([{ idempotency_key: `cancel-${cancellationId}`, amount: 26_667, expected_balance: 33_333, status: 'CANCELED' }]);
    const ticket = (await ticketDb.pool.query('select status, account_id, key_revoked_at, version from ticket where id = $1', [w.ticketId])).rows[0];
    expect(ticket).toMatchObject({ status: 'REFUNDED', account_id: w.accountId, version: 3 });
    expect(ticket.key_revoked_at).not.toBeNull();
  });
});

// ---- BAT-415 리뷰 반영 B2(계획 §11 S2, docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기') ----
describe('GAT-080 S2 앞 시도가 티켓 단계만 마친 팬 취소 잇기 [실제 ticket-svc·payment-svc]', () => {
  test('GAT-080 S2 첫 팬 취소가 티켓 단계만 마친 뒤 새 키로 다시 누르면 첫 취소 ID로 좌석·취소 행·환급을 마친다', async () => {
    // 공연 NOW + 10일 19:00(한국 시각): ticket-svc가 키를 폐기하는 NOW는 공연 10일 전 달력일(공제 0%), K2를 누르는 하루 뒤(NOW + 1일)는 9일 전(10%)
    const w = await world({ eventStartsAtMs: NOW + 10 * DAY + 9 * HOUR, ticketPrice: 33_333 });
    const real = new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis));
    let failures = 0;
    const flaky: SeatReturns = {
      returnSold: async (q) => {
        if (failures === 0) {
          failures++;
          throw new Error('좌석 되돌리기 실패(시험의 장애 주입)');
        }
        return real.returnSold(q);
      },
    };
    const flakySaga = new CancelTicket({ orders: new DrizzleCancellationOrders(purchaseDb, seatMap), calendar, tickets: ticketCancels!, payments: paymentCancels!, writes, seats: flaky });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const k1 = randomUUID();
    const k2 = randomUUID();
    await expect(flakySaga.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: k1, reason: 'USER', nowMs: NOW, deadlineMs: 5_000 })).rejects.toThrow();
    // 장애 주입이 실제로 있었다: ticket-svc는 키를 폐기했는데 좌석·취소 행은 없다
    expect(failures).toBe(1);
    expect(await ticketRow(w.ticketId)).toMatchObject({ status: 'REFUNDED' });
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('SOLD');

    const r = await flakySaga.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: k2, reason: 'USER', nowMs: NOW + DAY, deadlineMs: 5_000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: k1, refundAmount: 33_333, refundAfterEntryClose: false });
    const rows = await admin.pool.query('select id, deduction_bp, deduction_amount, refund_amount, status from order_cancellation where ticket_id = $1', [w.ticketId]);
    expect(rows.rows).toEqual([{ id: k1, deduction_bp: 0, deduction_amount: 0, refund_amount: 33_333, status: 'REFUNDED' }]);
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('RETURNED');
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '3'], { key: seatKeys.bitmap(w.eventId) }))).toBe(0);
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ paymentRef: `ref-${w.orderId}`, idemKey: `cancel-${k1}` });
    expect(await paymentRow(w.paymentId)).toMatchObject({ status: 'CANCELED', cancelled_amount: 33_333 });
    const tc = await ticketDb.pool.query('select cancellation_id, result from ticket_cancellation where ticket_id = $1 order by cancelled_at', [w.ticketId]);
    expect(tc.rows).toEqual([{ cancellation_id: k1, result: 'REFUND_NOW' }]);
  });

  test('GAT-080 S2 운영자 취소로 끝난 표는 새 키로 눌러도 아무것도 쓰지 않는다(취소 행·좌석·결제사 0)', async () => {
    const w = await world();
    await ticketService.operatorCancel({ approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: w.eventId, targets: [{ ticketId: w.ticketId, expectedHolderAccountId: w.accountId }], nowMs: NOW });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    await expect(cancelOf(w, randomUUID())).resolves.toEqual({ status: 'ALREADY_ENDED' });
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('SOLD');
    expect(gatewayCalls).toHaveLength(0);
  });
});

// ---- BAT-420(시험 담당, 구현 전에 씀): 마감 뒤 환급 전 입장 기록 대조(P-T19 ①③)·조건부 집기 경합(A2)·무효 덮기 막기(A3) ----
// 입장 기록은 실제 ticket-svc DB의 scan_event이고, 실행기는 실제 ticket-svc gRPC GetEntryRecords로 묻는다(ticketCancels).
// 정본 값: 마감 = 공연 시작 + 50시간(180,000,000ms), 들어감·통과만 입장, 권면 33,333원의 공연 당일 90% 공제 → 공제 29,999·환급 3,334.
describe('BAT-420 마감 뒤 환급의 입장 기록 대조 [실제 ticket-svc·payment-svc]', () => {
  let scanSeq = 5_000_000;
  const scan = (w: World, direction: 'IN' | 'OUT', result: 'PASS' | 'REJECT', atMs: number) =>
    ticketDb.pool.query(
      `insert into scan_event (id, event_id, ticket_id, scanner_device_id, direction, method, result, scanned_at_device, known_seq, device_seq, received_at)
       values ($1, $2, $3, $4, $5, 'QR', $6, $7, 0, $8, $9)`,
      [randomUUID(), w.eventId, w.ticketId, randomUUID(), direction, result, new Date(atMs), ++scanSeq, new Date(atMs + 1_000)],
    );
  /** 입장 시작 뒤 팬 취소로 REQUESTED(마감 뒤 환급)를 만든다 */
  const heldCancellation = async () => {
    const w = await world({ eventStartsAtMs: NOW + 2 * HOUR, entryOpensAtMs: NOW - HOUR, ticketPrice: 33_333 });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'ACCEPTED', cancellationId, refundAmount: 3_334, refundAfterEntryClose: true });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REQUESTED', deduction_amount: 29_999, refund_amount: 3_334 });
    return { w, cancellationId, dueMs: w.eventStartsAtMs + 180_000_000 };
  };
  const counting = () => {
    const seen = { lookups: 0 };
    return { seen, entries: { lookup: (ids: readonly string[], deadlineMs: number) => (seen.lookups++, ticketCancels!.lookup(ids, deadlineMs)) } };
  };
  const logSink = () => {
    const lines: { level: 'warn' | 'error'; o: object; msg: string }[] = [];
    return { lines, log: { warn: (o: object, msg: string) => void lines.push({ level: 'warn', o, msg }), error: (o: object, msg: string) => void lines.push({ level: 'error', o, msg }) } };
  };
  const entryRecordedAt = async (cancellationId: string) =>
    (await admin.pool.query<{ entry_recorded_at: Date | null; refund_due_at: Date | null }>('select entry_recorded_at, refund_due_at from order_cancellation where id = $1', [cancellationId])).rows[0]!;

  test('P-T19 ① 마감 뒤 실행기가 들어감·통과 기록을 찾으면 결제사를 부르지 않고 가장 이른 입장 시각을 남겨 이상 표시를 한 번 열며 다시 돌려도 묻지 않는다', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    await scan(w, 'IN', 'PASS', w.eventStartsAtMs + 5 * 60_000);
    await scan(w, 'IN', 'PASS', w.eventStartsAtMs + 60_000);
    const flags: Record<string, unknown>[] = [];
    const c = counting();
    const runner = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: c.entries, claims: writes, flags: { open: async (q) => void flags.push({ ...q }) }, nowMs: () => dueMs });
    await expect(runner.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 0, entryRecorded: 1, unverified: 0, held: 0 });
    expect(gatewayCalls).toHaveLength(0);
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REQUESTED', refund_attempts: 0, refund_failed_at: null });
    const recorded = await entryRecordedAt(cancellationId);
    expect(recorded.entry_recorded_at?.getTime()).toBe(w.eventStartsAtMs + 60_000);
    expect(recorded.refund_due_at).toBeNull();
    expect(flags).toEqual([{ cancellationId, orderId: w.orderId, ticketId: w.ticketId, enteredAtMs: w.eventStartsAtMs + 60_000, nowMs: dueMs }]);

    await expect(runner.run()).resolves.toMatchObject({ entryRecorded: 0, refunded: 0 });
    expect(c.seen.lookups).toBe(1);
    expect(gatewayCalls).toHaveLength(0);
    expect(flags).toHaveLength(1);
  });

  test('P-T19 ③ 입장 기록이 거절(IN, REJECT)·나감(OUT, PASS)뿐이면 마감 뒤 한 번만 3,334원을 환급하고 다시 돌려도 그대로다', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    await scan(w, 'IN', 'REJECT', w.eventStartsAtMs + 60_000);
    await scan(w, 'OUT', 'PASS', w.eventStartsAtMs + 2 * 60_000);
    const runner = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => dueMs });
    await expect(runner.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ amount: 3_334, idemKey: `cancel-${cancellationId}` });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_amount: 3_334 });
    expect((await entryRecordedAt(cancellationId)).entry_recorded_at).toBeNull();
    await runner.run();
    expect(gatewayCalls).toHaveLength(1);
  });

  test('P-T19 ③ 마감 시각 1ms 전(공연 시작 + 179,999,999ms)에는 묻지도 집지도 않고 정각(+ 180,000,000ms)에 집는다', async () => {
    const { w, dueMs } = await heldCancellation();
    expect(dueMs).toBe(w.eventStartsAtMs + 180_000_000);
    const early = counting();
    await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: early.entries, claims: writes, nowMs: () => w.eventStartsAtMs + 179_999_999 }).run();
    expect(early.seen.lookups).toBe(0);
    expect(gatewayCalls).toHaveLength(0);
    const onTime = counting();
    await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: onTime.entries, claims: writes, nowMs: () => w.eventStartsAtMs + 180_000_000 }).run();
    expect(onTime.seen.lookups).toBe(1);
    expect(gatewayCalls).toHaveLength(1);
  });

  test('GAT-090 A2 보류 취소 집기는 조건부라 실행기 둘이 겹쳐도 결제사 호출은 한 번이다(두 실행기 모두 조회까지 간 것을 본 뒤)', async () => {
    const { cancellationId, dueMs } = await heldCancellation();
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const entries = {
      lookup: async (ids: readonly string[], deadlineMs: number) => {
        arrived++;
        if (arrived === 2) release();
        await barrier;
        return ticketCancels!.lookup(ids, deadlineMs);
      },
    };
    const a = new RefundAfterEntry({ writes, payments: paymentCancels!, entries, claims: writes, nowMs: () => dueMs });
    const b = new RefundAfterEntry({ writes, payments: paymentCancels!, entries, claims: writes, nowMs: () => dueMs });
    await Promise.all([a.run(), b.run()]);
    expect(arrived).toBe(2);
    expect(gatewayCalls).toHaveLength(1);
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempts: 0 });
  });

  test.each(['CANCELLED', 'UNKNOWN', 'REJECTED'] as const)(
    'GAT-090 A3 결제사 답 %s 직전에 CS가 취소를 무효로 끝냈으면 실행기는 환급·재시도·실패 표시로 VOIDED를 덮지 않는다',
    async (outcome) => {
      const { w, cancellationId, dueMs } = await heldCancellation();
      const orderBefore = (await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status as string;
      gatewayOutcome = outcome;
      beforeGatewayAnswer = async () => {
        await admin.pool.query("update order_cancellation set status = 'VOIDED', status_changed_at = now() where id = $1", [cancellationId]);
      };
      const sink = logSink();
      try {
        await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, log: sink.log, nowMs: () => dueMs }).run();
      } finally {
        beforeGatewayAnswer = undefined;
        gatewayOutcome = 'CANCELLED';
      }
      // 끼어든 사례가 실제로 있었다: 결제사를 한 번 불렀고 그 뒤 행은 VOIDED다
      expect(gatewayCalls).toHaveLength(1);
      expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'VOIDED', next_refund_at: null, refund_failed_at: null });
      expect((await admin.pool.query('select status from purchase_order where id = $1', [w.orderId])).rows[0].status).toBe(orderBefore);
      const voidErrors = sink.lines.filter((l) => l.level === 'error' && JSON.stringify(l).includes('cancellation-refunded-after-void'));
      expect(voidErrors).toHaveLength(outcome === 'CANCELLED' ? 1 : 0);
      if (outcome === 'CANCELLED') expect(JSON.stringify(voidErrors[0])).toContain(cancellationId);
    },
  );
});

// ---- BAT-415 리뷰 반영 B2 보충(계획 §11 보충, 2ab218ad, docs/features/payment.md §4.1 '공연이 시작된 뒤 다시 누른 경우') ----
describe('GAT-080 S4 공연 시작 뒤 다시 누른 팬 취소 [실제 ticket-svc·payment-svc]', () => {
  // 이 파일의 ticket-svc는 키 폐기 시각을 NOW(서버 기준 한국 날짜의 3일 전 10:00)로 적는다. 공연을 NOW + 4일 19:00(한국 시각)에 두면 첫 키 폐기는 공연 4일 전 달력일(공제 20%)이다.
  // NOW는 파일의 beforeAll에서 정해지므로 공연 시각도 그 뒤(이 묶음의 beforeAll)에 정한다
  let EVENT_AT: number;
  let AFTER_START: number;
  beforeAll(() => {
    EVENT_AT = NOW + 4 * DAY + 9 * HOUR;
    AFTER_START = EVENT_AT + 60_000;
  });
  /** 첫 시도 K1이 ticket-svc 키 폐기를 커밋한 뒤 좌석 되돌리기에서 한 번 던진다 */
  const firstFails = async () => {
    const w = await world({ eventStartsAtMs: EVENT_AT, ticketPrice: 33_333 });
    const real = new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis));
    let failures = 0;
    const seats: SeatReturns = {
      returnSold: async (q) => {
        if (failures === 0) {
          failures++;
          throw new Error('좌석 되돌리기 실패(시험의 장애 주입)');
        }
        return real.returnSold(q);
      },
    };
    const s2 = new CancelTicket({ orders: new DrizzleCancellationOrders(purchaseDb, seatMap), calendar, tickets: ticketCancels!, payments: paymentCancels!, writes, seats });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    const k1 = randomUUID();
    await expect(s2.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: k1, reason: 'USER', nowMs: NOW, deadlineMs: 5_000 })).rejects.toThrow();
    expect(failures).toBe(1);
    expect(await ticketRow(w.ticketId)).toMatchObject({ status: 'REFUNDED' });
    return { w, k1, saga: s2 };
  };
  const finished = async (w: World, k1: string) => {
    const rows = await admin.pool.query('select id, deduction_bp, deduction_amount, refund_amount, status from order_cancellation where ticket_id = $1', [w.ticketId]);
    expect(rows.rows).toEqual([{ id: k1, deduction_bp: 2_000, deduction_amount: 6_666, refund_amount: 26_667, status: 'REFUNDED' }]);
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('RETURNED');
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ paymentRef: `ref-${w.orderId}`, amount: 26_667, idemKey: `cancel-${k1}` });
    const tc = await ticketDb.pool.query('select cancellation_id, result from ticket_cancellation where ticket_id = $1', [w.ticketId]);
    expect(tc.rows).toEqual([{ cancellation_id: k1, result: 'REFUND_NOW' }]);
  };

  test('GAT-080 S4 공연 전에 키만 폐기된 팬 취소는 공연 시작 뒤 새 키로 다시 눌러도 첫 시각의 공제율로 환급을 마친다', async () => {
    const { w, k1, saga: s2 } = await firstFails();
    const r = await s2.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: randomUUID(), reason: 'USER', nowMs: AFTER_START, deadlineMs: 5_000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: k1, refundAmount: 26_667, refundAfterEntryClose: false });
    await finished(w, k1);
  });

  test('GAT-080 S4 같은 키(K1)로 공연 시작 뒤 다시 눌러도 첫 시각의 공제율로 환급을 마친다', async () => {
    const { w, k1, saga: s2 } = await firstFails();
    const r = await s2.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: k1, reason: 'USER', nowMs: AFTER_START, deadlineMs: 5_000 });
    expect(r).toEqual({ status: 'ACCEPTED', cancellationId: k1, refundAmount: 26_667, refundAfterEntryClose: false });
    await finished(w, k1);
  });

  test('GAT-080 S4 대조: 아직 유효한 표를 공연 시작 뒤 누르면 EVENT_STARTED이고 ticket 행·취소 기록·결제사가 그대로다', async () => {
    const w = await world({ eventStartsAtMs: EVENT_AT, ticketPrice: 33_333 });
    const before = (await ticketDb.pool.query('select status, key_revoked_at, version from ticket where id = $1', [w.ticketId])).rows[0];
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    await expect(cancelOf(w, randomUUID(), 'USER', AFTER_START)).resolves.toEqual({ status: 'EVENT_STARTED' });
    expect((await ticketDb.pool.query('select status, key_revoked_at, version from ticket where id = $1', [w.ticketId])).rows[0]).toEqual(before);
    expect((await ticketDb.pool.query('select count(*)::int as n from ticket_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(0);
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('SOLD');
    expect(gatewayCalls).toHaveLength(0);
  });
});

// ---- 다시 보기 R1(계획 §11 보충 3, 78d8dbd8, docs/features/payment.md §4.1 '이어 갈 수 있는 앞 기록은 팬 취소뿐이다') ----
describe('GAT-080 S5 일괄 환불 항목이 티켓 단계만 마친 표 [실제 ticket-svc·payment-svc]', () => {
  test('GAT-080 S5 일괄 환불 항목이 티켓 단계만 마친 표에 팬이 새 키로 누르면 아무것도 쓰지 않고, 항목 재시도가 공제 0원·회차 취소 요청 ID로 마친다', async () => {
    // 공연 NOW + 4일 19:00(한국 시각): 지금(NOW)은 공연 4일 전 달력일이라 팬 취소(USER)였다면 20% 공제인 날이다
    const w = await world({ eventStartsAtMs: NOW + 4 * DAY + 9 * HOUR, ticketPrice: 33_333 });
    const real = new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis));
    let failures = 0;
    const seats: SeatReturns = {
      returnSold: async (q) => {
        if (failures === 0) {
          failures++;
          throw new Error('좌석 되돌리기 실패(시험의 장애 주입)');
        }
        return real.returnSold(q);
      },
    };
    const flaky = new CancelTicket({ orders: new DrizzleCancellationOrders(purchaseDb, seatMap), calendar, tickets: ticketCancels!, payments: paymentCancels!, writes, seats });
    const itemCancellationId = randomUUID();
    const requestId = randomUUID();
    const item = () => flaky.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: itemCancellationId, reason: 'EVENT_POSTPONED', nowMs: NOW, deadlineMs: 5_000, eventCancellationRequestId: requestId });
    gatewayOutcome = 'CANCELLED';
    gatewayCalls = [];
    // 연기 일괄 환불 항목의 첫 시도: ticket-svc 키 폐기를 커밋한 뒤 좌석 되돌리기에서 던진다
    await expect(item()).rejects.toThrow();
    expect(failures).toBe(1);
    expect(await ticketRow(w.ticketId)).toMatchObject({ status: 'REFUNDED' });

    // 팬이 새 키로 누른다: 팬 취소 기록이 아니므로 잇지 않고 아무것도 쓰지 않는다(HTTP 409 cancellation-conflict)
    await expect(flaky.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId: randomUUID(), reason: 'USER', nowMs: NOW, deadlineMs: 5_000 })).resolves.toEqual({ status: 'ALREADY_ENDED' });
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [w.ticketId])).rows[0].n).toBe(0);
    expect(gatewayCalls).toHaveLength(0);

    // 항목 재시도가 같은 항목 취소 ID로 공제 0원·회차 취소 요청 ID를 남겨 마친다
    await expect(item()).resolves.toEqual({ status: 'ACCEPTED', cancellationId: itemCancellationId, refundAmount: 33_333, refundAfterEntryClose: false });
    const rows = await admin.pool.query('select id, reason, deduction_bp, deduction_amount, refund_amount, status, event_cancellation_request_id from order_cancellation where ticket_id = $1', [w.ticketId]);
    expect(rows.rows).toEqual([{ id: itemCancellationId, reason: 'EVENT_POSTPONED', deduction_bp: 0, deduction_amount: 0, refund_amount: 33_333, status: 'REFUNDED', event_cancellation_request_id: requestId }]);
    expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, w.seatId])).rows[0].status).toBe('RETURNED');
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ paymentRef: `ref-${w.orderId}`, idemKey: `cancel-${itemCancellationId}` });
    const tc = await ticketDb.pool.query('select cancellation_id, result, reason from ticket_cancellation where ticket_id = $1', [w.ticketId]);
    expect(tc.rows).toEqual([{ cancellation_id: itemCancellationId, result: 'REFUND_NOW', reason: 'EVENT_POSTPONED' }]);
  });
});

// ---- BAT-420 몫 D(시험 담당, 구현 전에 씀): 회차 취소 요청 중 보류 취소의 환급 미룸(OPEN[45], R-T38 ①②⑤, GAT-090 D4·D5,
// docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸', docs/data.md event_refund_hold) ----
describe('BAT-420 몫 D 회차 취소 요청 중 환급 미룸 [실제 ticket-svc·payment-svc]', () => {
  const HOLD_MS = 259_200_000;
  /** 입장 시작 뒤 팬 취소로 REQUESTED(마감 뒤 환급, 공제 29,999·환급 3,334)를 만든다 */
  const heldCancellation = async () => {
    const w = await world({ eventStartsAtMs: NOW + 2 * HOUR, entryOpensAtMs: NOW - HOUR, ticketPrice: 33_333 });
    gatewayOutcome = 'CANCELLED';
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'ACCEPTED', cancellationId, refundAmount: 3_334, refundAfterEntryClose: true });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REQUESTED', reason: 'USER', deduction_amount: 29_999, refund_amount: 3_334 });
    return { w, cancellationId, dueMs: w.eventStartsAtMs + 180_000_000 };
  };
  /** 그 회차에 미룸을 직접 건다(저장소 SQL은 event-refund.int D3가 본다) */
  const putHold = (eventId: string, requestId: string, heldAtMs: number, expiresAtMs: number) =>
    admin.pool.query('insert into event_refund_hold (event_id, cancellation_request_id, held_at, expires_at) values ($1, $2, $3, $4)', [eventId, requestId, new Date(heldAtMs), new Date(expiresAtMs)]);
  const holdRow = async (eventId: string) =>
    (await admin.pool.query<{ released_at: Date | null; expires_at: Date }>('select released_at, expires_at from event_refund_hold where event_id = $1', [eventId])).rows[0];
  const dueAt = async (cancellationId: string) => (await admin.pool.query<{ refund_due_at: Date | null }>('select refund_due_at from order_cancellation where id = $1', [cancellationId])).rows[0]!.refund_due_at;
  /** 뒤 시험의 실행기가 남은 보류 취소를 환급하지 않게 끝낸다 */
  const settle = (cancellationId: string) => admin.pool.query("update order_cancellation set status = 'VOIDED', status_changed_at = now() where id = $1 and status = 'REQUESTED'", [cancellationId]);
  const looking = () => {
    const seen: string[][] = [];
    return { seen, entries: { lookup: (ids: readonly string[], deadlineMs: number) => (seen.push([...ids]), ticketCancels!.lookup(ids, deadlineMs)) } };
  };
  const logSink = () => {
    const lines: { level: 'warn' | 'error'; o: object; msg: string }[] = [];
    return { lines, log: { warn: (o: object, msg: string) => void lines.push({ level: 'warn', o, msg }), error: (o: object, msg: string) => void lines.push({ level: 'error', o, msg }) } };
  };
  /** SEV2 event-refund-hold-expired 줄. eventId를 주면 그 회차 줄만 센다(앞 시험이 남긴 미룸의 기한이 이 시험의 틱과 겹칠 수 있다, 다시 보기 R3) */
  const expiredLines = (lines: { o: object; msg: string }[], eventId?: string) =>
    lines.filter((l) => JSON.stringify(l).includes('event-refund-hold-expired') && (eventId === undefined || JSON.stringify(l).includes(eventId)));
  /** 뒤 시험의 틱에 기한이 걸리지 않게 이 시험이 건 미룸을 푼다 */
  const releaseHold = (eventId: string) => admin.pool.query('update event_refund_hold set released_at = now() where event_id = $1 and released_at is null', [eventId]);

  test('R-T38 ① 회차 취소 요청이 판정 중인 회차의 보류 취소는 마감이 지나도 환급되지 않고(입장 조회·결제사 0, held 1) 다른 회차의 보류 취소는 같은 틱에 환급된다', async () => {
    const held = await heldCancellation();
    const other = await heldCancellation();
    gatewayCalls = [];
    const requestId = randomUUID();
    await putHold(held.w.eventId, requestId, NOW, held.dueMs + HOLD_MS);
    const dueBefore = await dueAt(held.cancellationId);
    const c = looking();
    const runner = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: c.entries, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), nowMs: () => held.dueMs });
    try {
      await expect(runner.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 1 });
      expect(c.seen.flat()).not.toContain(held.w.ticketId);
      expect(c.seen.flat()).toContain(other.w.ticketId);
      expect(gatewayCalls).toHaveLength(1);
      expect(gatewayCalls[0]).toMatchObject({ idemKey: `cancel-${other.cancellationId}`, amount: 3_334 });
      expect(await cancellationRow(held.cancellationId)).toMatchObject({ status: 'REQUESTED', refund_attempts: 0, refund_failed_at: null });
      expect((await dueAt(held.cancellationId))?.getTime()).toBe(dueBefore?.getTime());
      expect(await cancellationRow(other.cancellationId)).toMatchObject({ status: 'REFUNDED' });
    } finally {
      await settle(held.cancellationId);
      await releaseHold(held.w.eventId);
    }
  });

  test('R-T38 ② 판정 전 반려로 미룸이 풀리면(같은 요청 ID) 다음 틱에 공제한 금액 3,334원으로 한 번 환급되고 다시 돌려도 한 번이다', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    gatewayCalls = [];
    const requestId = randomUUID();
    const holds = new DrizzleEventRefundHolds(purchaseDb);
    await putHold(w.eventId, requestId, NOW, dueMs + HOLD_MS);
    const runner = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, holds, nowMs: () => dueMs });
    try {
      await expect(runner.run()).resolves.toMatchObject({ refunded: 0, held: 1 });
      expect(gatewayCalls).toHaveLength(0);
      await expect(holds.set({ eventId: w.eventId, cancellationRequestId: requestId, held: false, nowMs: dueMs })).resolves.toMatchObject({ held: false });
      expect((await holdRow(w.eventId))?.released_at?.getTime()).toBe(dueMs);
      await expect(runner.run()).resolves.toMatchObject({ refunded: 1, held: 0 });
      expect(gatewayCalls).toHaveLength(1);
      expect(gatewayCalls[0]).toMatchObject({ amount: 3_334, idemKey: `cancel-${cancellationId}` });
      expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_amount: 3_334 });
      await runner.run();
      expect(gatewayCalls).toHaveLength(1);
    } finally {
      await settle(cancellationId);
    }
  });

  test('R-T38 ⑤ 72시간 동안 늘리지 않은 미룸은 건 시각 + 259,199,999ms에는 건너뛰고 + 259,200,000ms에 저절로 풀려(released_at) 그 틱에 환급되며 SEV2가 한 번 남는다(다음 틱 0)', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    gatewayCalls = [];
    const requestId = randomUUID();
    const heldAtMs = dueMs - 60_000;
    await putHold(w.eventId, requestId, heldAtMs, heldAtMs + HOLD_MS);
    const sink = logSink();
    let now = heldAtMs + HOLD_MS - 1;
    const runner = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), log: sink.log, nowMs: () => now });
    try {
      await expect(runner.run()).resolves.toMatchObject({ refunded: 0, held: 1 });
      expect(gatewayCalls).toHaveLength(0);
      expect((await holdRow(w.eventId))?.released_at).toBeNull();
      expect(expiredLines(sink.lines, w.eventId)).toHaveLength(0);

      now = heldAtMs + HOLD_MS;
      await expect(runner.run()).resolves.toMatchObject({ refunded: 1, held: 0 });
      expect((await holdRow(w.eventId))?.released_at?.getTime()).toBe(now);
      expect(gatewayCalls).toHaveLength(1);
      expect(gatewayCalls[0]).toMatchObject({ amount: 3_334, idemKey: `cancel-${cancellationId}` });
      const expired = expiredLines(sink.lines, w.eventId);
      expect(expired).toHaveLength(1);
      expect(JSON.stringify(expired[0])).toContain(w.eventId);
      expect(JSON.stringify(expired[0])).toContain(requestId);

      now += 60_000;
      await runner.run();
      expect(expiredLines(sink.lines, w.eventId)).toHaveLength(1);
      expect(gatewayCalls).toHaveLength(1);
    } finally {
      await settle(cancellationId);
    }
  });

  test('R-T38 ③ 진행 중(RUNNING) 회차 취소 일괄 환불이 있는 회차의 보류 취소는 미룸이 없어도 마감 뒤 환급되지 않는다(M-RT38-1c)', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    gatewayCalls = [];
    const requestId = randomUUID();
    await admin.pool.query(
      `insert into event_cancellation_request (id, event_id, kind, status, fault, ruled_by, confirmed_by, created_at, updated_at)
       values ($1, $2, 'CANCEL', 'RUNNING', 'ORGANIZER', 'commander-1', 'operator-2', now(), now())`,
      [requestId, w.eventId],
    );
    const c = looking();
    try {
      await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: c.entries, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), nowMs: () => dueMs }).run();
      expect(c.seen.flat()).not.toContain(w.ticketId);
      expect(gatewayCalls).toHaveLength(0);
      expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REQUESTED' });
      // 대조: 일괄 환불이 끝나면(COMPLETED) 그 조건이 풀린다
      await admin.pool.query("update event_cancellation_request set status = 'COMPLETED' where id = $1", [requestId]);
      await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), nowMs: () => dueMs }).run();
      expect(gatewayCalls).toHaveLength(1);
    } finally {
      await settle(cancellationId);
    }
  });

  test('GAT-090 D4 입장 조회 뒤·집기 전에 걸린 미룸도 조건부 집기가 막는다(끼어든 사례를 확인한 뒤 결제사 0, 행 REQUESTED)', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    gatewayCalls = [];
    let lookups = 0;
    const entries = {
      lookup: async (ids: readonly string[], deadlineMs: number) => {
        lookups++;
        const answer = await ticketCancels!.lookup(ids, deadlineMs);
        // 조회와 집기 사이에 ops가 회차 취소를 요청해 미룸이 걸렸다
        await putHold(w.eventId, randomUUID(), dueMs, dueMs + HOLD_MS);
        return answer;
      },
    };
    try {
      await new RefundAfterEntry({ writes, payments: paymentCancels!, entries, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), nowMs: () => dueMs }).run();
      expect(lookups).toBe(1);
      expect(await holdRow(w.eventId)).toMatchObject({ released_at: null });
      expect(gatewayCalls).toHaveLength(0);
      expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REQUESTED', refund_attempts: 0 });
      // 직접 집어 보아도 미룸이 막는다(겹친 가드 하나만 빼는 틀린 구현을 따로 잡는다)
      await expect(writes.claimDue(cancellationId, dueMs)).resolves.toBe(false);
    } finally {
      await settle(cancellationId);
      await releaseHold(w.eventId);
    }
  });

  test('GAT-090 D5 결제사 결과 모름(REFUND_PENDING)의 재시도는 미룸이 걸린 회차여도 미루지 않는다(결제사 1)', async () => {
    const { w, cancellationId, dueMs } = await heldCancellation();
    gatewayCalls = [];
    gatewayOutcome = 'UNKNOWN';
    try {
      await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => dueMs }).run();
    } finally {
      gatewayOutcome = 'CANCELLED';
    }
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', refund_attempts: 1 });
    expect(gatewayCalls).toHaveLength(1);
    await putHold(w.eventId, randomUUID(), dueMs, dueMs + 2 * DAY);
    await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, holds: new DrizzleEventRefundHolds(purchaseDb), nowMs: () => dueMs + HOUR }).run();
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[1]).toMatchObject({ amount: 3_334, idemKey: `cancel-${cancellationId}` });
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED' });
  });
});

// ---- BAT-420 리뷰 D1(시험 담당, 구현 전에 씀, 계획 §11 보충 3, transfer-refund §3.1 ⑤): 다른 길이 먼저 끝낸 행의 0행 쓰기 ----
describe('BAT-420 리뷰 D1 결제사 환급 뒤 0행 쓰기 [실제 ticket-svc·payment-svc]', () => {
  test('GAT-090 R1 실행기가 결제사 답을 기다리는 동안 다른 길이 같은 행을 REFUNDED로 끝내면 SEV1 없이 환급으로 센다(끼어든 사례를 확인한 뒤)', async () => {
    const w = await world({ eventStartsAtMs: NOW + 2 * HOUR, entryOpensAtMs: NOW - HOUR, ticketPrice: 33_333 });
    gatewayOutcome = 'CANCELLED';
    const cancellationId = randomUUID();
    await expect(cancelOf(w, cancellationId)).resolves.toMatchObject({ status: 'ACCEPTED', cancellationId, refundAmount: 3_334, refundAfterEntryClose: true });
    const dueMs = w.eventStartsAtMs + 180_000_000;
    gatewayCalls = [];
    let intervened = false;
    // 같은 cancel-{ID}로 다른 길(예매 취소 즉시 환급·회차 취소 전용 취소기)이 먼저 끝냈다
    beforeGatewayAnswer = async () => {
      const r = await admin.pool.query("update order_cancellation set status = 'REFUNDED', status_changed_at = now() where id = $1 and status = 'REFUND_PENDING'", [cancellationId]);
      intervened = r.rowCount === 1;
    };
    const lines: { level: string; o: object; msg: string }[] = [];
    try {
      const runner = new RefundAfterEntry({
        writes,
        payments: paymentCancels!,
        entries: ticketCancels!,
        claims: writes,
        orders: new DrizzleCancellationOrders(purchaseDb, seatMap),
        log: { warn: (o, msg) => void lines.push({ level: 'warn', o, msg }), error: (o, msg) => void lines.push({ level: 'error', o, msg }) },
        nowMs: () => dueMs,
      });
      await expect(runner.run()).resolves.toMatchObject({ refunded: 1 });
    } finally {
      beforeGatewayAnswer = undefined;
    }
    expect(intervened).toBe(true);
    expect(gatewayCalls).toHaveLength(1);
    expect(await cancellationRow(cancellationId)).toMatchObject({ status: 'REFUNDED' });
    expect(lines.filter((l) => JSON.stringify(l).includes('cancellation-refunded-after-void'))).toEqual([]);
    expect(lines.filter((l) => JSON.stringify(l).includes('cancellation-refund-state-unexpected'))).toEqual([]);
  });
});

// ---- BAT-420 웨이브 끝 리뷰 K1(시험 담당, 구현 전에 씀, 계획 §11 보충 4, transfer-refund §5 '일괄 환불 항목의 주인과 겹침 막기') ----
describe('BAT-420 웨이브 끝 리뷰 K1 회차 취소 행의 주인 [실제 ticket-svc·payment-svc]', () => {
  test('GAT-110 K1 회차 취소 요청 ID가 붙은 REFUND_PENDING 행(전용 취소기·전환·연기 신청)은 마감 뒤 환급 실행기가 집지 않고, 요청 ID 없는 부정 예매·팬 행만 행마다 한 번 보낸다(차례로)', async () => {
    gatewayOutcome = 'UNKNOWN';
    const made: { cancellationId: string; orderId: string; reason: 'USER' | 'FRAUD' | 'EVENT_CANCELLED' | 'EVENT_POSTPONED'; requestId?: string }[] = [];
    try {
      for (const [reason, tagged] of [
        ['EVENT_CANCELLED', true],
        ['EVENT_CANCELLED', true],
        ['EVENT_POSTPONED', true],
        ['FRAUD', false],
        ['USER', false],
      ] as const) {
        const w = await world();
        const cancellationId = randomUUID();
        await expect(cancelOf(w, cancellationId, reason === 'EVENT_CANCELLED' ? 'USER' : reason)).resolves.toMatchObject({ status: 'REFUND_PENDING' });
        const requestId = tagged ? randomUUID() : undefined;
        await admin.pool.query('update order_cancellation set reason = $2, event_cancellation_request_id = $3, next_refund_at = null where id = $1', [cancellationId, reason, requestId ?? null]);
        made.push({ cancellationId, orderId: w.orderId, reason, ...(requestId ? { requestId } : {}) });
      }
    } finally {
      gatewayOutcome = 'CANCELLED';
    }
    gatewayCalls = [];
    await new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + DAY }).run();
    const keys = gatewayCalls.map((c) => c.idemKey);
    for (const m of made) {
      const n = keys.filter((k) => k === `cancel-${m.cancellationId}`).length;
      expect(n, `${m.reason} ${m.requestId ? '요청 ID 있음' : '요청 ID 없음'}`).toBe(m.requestId ? 0 : 1);
    }
    // 뒤 시험이 다시 집지 않게 끝낸다
    await admin.pool.query("update order_cancellation set status = 'VOIDED', status_changed_at = now() where id = any($1::uuid[]) and status = 'REFUND_PENDING'", [made.map((m) => m.cancellationId)]);
  });
});

// ---- BAT-420 다시 보기 2 N1·N2(시험 담당 l3w8-420-n-test, 구현 전에 씀, 계획 §11 보충 5, transfer-refund §3.1 ⑥) ----
// 마감 뒤 환급 실행기가 실제 SQL(DrizzleCsCaseOutbox)로 열지 않은 환급 실패·이상 표시 건을 찾고, 실제 HTTP 어댑터로 틱 끝에 여는지 본다.
// 결제사·입장 기록 대조는 기록 대역이다(이 묶음은 CS 건의 차례·시간·대상 고르기를 본다). 파일이 DB를 나눠 써서 목록은 이 시험의 행으로만 거른다.
describe('BAT-420 다시 보기 2 N1·N2 마감 뒤 환급 실행기의 CS 건 다시 열기 [PostgreSQL·실제 HTTP]', () => {
  let ops: Awaited<ReturnType<typeof startOpsCsDouble>>;
  const log: string[] = [];
  beforeAll(async () => {
    ops = await startOpsCsDouble(log);
  });
  afterAll(async () => {
    await ops?.close();
  });
  /** 그 표의 취소 행 하나를 칸 값 그대로 넣는다(표마다 진행 중 취소는 하나) */
  const putRow = async (w: World, o: { status: 'REQUESTED' | 'REFUND_PENDING' | 'VOIDED'; dueAt?: Date; entryAt?: Date; failedAt?: Date; requestId?: string; attempts?: number }): Promise<string> => {
    const id = randomUUID();
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at,
                                       refund_due_at, entry_recorded_at, refund_failed_at, refund_last_error, refund_attempts, event_cancellation_request_id)
       values ($1, $2, $3, $4, 0, false, 0, 0, 1000, $5, now(), now(), $6, $7, $8, $9, $10, $11)`,
      [id, w.orderId, w.ticketId, o.requestId ? 'EVENT_CANCELLED' : 'USER', o.status, o.dueAt ?? null, o.entryAt ?? null, o.failedAt ?? null, o.failedAt ? 'REJECTED' : null, o.attempts ?? 0, o.requestId ?? null],
    );
    return id;
  };
  const scoped = (mine: ReadonlySet<string>) => {
    const real = new DrizzleCsCaseOutbox(admin);
    return {
      pendingRefundFailures: async (limit: number) => (await real.pendingRefundFailures(limit)).filter((r) => mine.has(r.cancellationId)),
      markRefundFailureOpened: (id: string, nowMs: number) => real.markRefundFailureOpened(id, nowMs),
      pendingFlags: async (limit: number) => (await real.pendingFlags(limit)).filter((r) => mine.has(r.cancellationId)),
      markFlagOpened: (id: string, nowMs: number) => real.markFlagOpened(id, nowMs),
    };
  };
  const runnerOf = (mine: ReadonlySet<string>, pay: (id: string) => 'CANCELLED' | 'REJECTED') => {
    const client = createExternalHttpClient({ provider: 'ops-svc', baseUrl: ops.url, timeoutCapMs: 5_000 });
    const scopedWrites = Object.create(writes) as typeof writes;
    scopedWrites.dueRefunds = async (nowMs, limit) => (await writes.dueRefunds(nowMs, limit)).filter((r) => mine.has(r.cancellationId));
    return new RefundAfterEntry({
      writes: scopedWrites,
      payments: { cancel: async (q) => (log.push(`pay:${q.cancellationId}`), pay(q.cancellationId)) },
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: writes,
      failureNotice: new HttpRefundFailureNotice(client, 'it-token'),
      flags: new HttpEntryFlagNotice(client, 'it-token'),
      csOutbox: scoped(mine),
      csCaseOpenFailures: { inc: () => undefined, cut: () => undefined },
      log: { warn: () => undefined, error: () => undefined },
      nowMs: () => Date.now(),
    });
  };
  const opened = async (ids: readonly string[], column: 'entry_flag_opened_at' | 'refund_failed_opened_at') =>
    Number((await admin.pool.query<{ n: string }>(`select count(*) as n from order_cancellation where id = any($1::uuid[]) and ${column} is not null`, [ids])).rows[0]!.n);

  test('GAT-090 N1 실제 DB에서 느린 ops(4초)에도 마감 뒤 환급 실행기는 결제사를 먼저 부르고 한 틱에 2건만 연다', async () => {
    const hourAgo = new Date(Date.now() - HOUR);
    const flagged: string[] = [];
    for (let i = 0; i < 3; i++) flagged.push(await putRow(await world(), { status: 'REQUESTED', entryAt: hourAgo }));
    const due = await putRow(await world(), { status: 'REQUESTED', dueAt: hourAgo });
    const mine = new Set([...flagged, due]);
    log.length = 0;
    ops.state.requests.length = 0;
    ops.state.mode = { slowMs: 4_000, status: 202 };
    await runnerOf(mine, () => 'CANCELLED').run();
    // 장애 주입이 끼어들었는지 먼저: 느린 ops가 요청을 받았다
    expect(ops.state.requests.length).toBeGreaterThan(0);
    expect(log.filter((l) => l === `pay:${due}`)).toHaveLength(1);
    expect(log.indexOf(`pay:${due}`)).toBeLessThan(log.findIndex((l) => l.startsWith('ops:')));
    expect(ops.state.requests.map((r) => r.body.kind)).toEqual(['FLAGGED', 'FLAGGED']);
    expect(await opened(flagged, 'entry_flag_opened_at')).toBe(2);
    await runnerOf(mine, () => 'CANCELLED').run();
    expect(await opened(flagged, 'entry_flag_opened_at')).toBe(3);
  }, 60_000);

  test('GAT-090 N2 마감 뒤 환급 실행기는 환급 실패 건을 2xx로 받은 행만 연 것으로 적고 다음 틱에 다시 연다', async () => {
    const hourAgo = new Date(Date.now() - HOUR);
    // 예매 취소 Saga가 결제사 거절로 표시한 팬 행(이 실행기 밖에서 표시됨)
    const fanMarked = await putRow(await world(), { status: 'REFUND_PENDING', failedAt: hourAgo, attempts: 1 });
    // 이 실행기가 이번 틱에 결제사 거절로 표시할 행
    const rejected = await putRow(await world(), { status: 'REFUND_PENDING', attempts: 0 });
    // 열지 않는 행: 회차 취소 요청 ID가 달린 실패 행(그 항목의 일괄 환불 실패 건 하나만), CS가 무효로 끝낸 행
    const withRequest = await putRow(await world(), { status: 'REFUND_PENDING', failedAt: hourAgo, attempts: 1, requestId: randomUUID() });
    const voided = await putRow(await world(), { status: 'VOIDED', failedAt: hourAgo, attempts: 1 });
    const mine = new Set([fanMarked, rejected, withRequest, voided]);
    log.length = 0;
    ops.state.requests.length = 0;
    ops.state.mode = 500;
    await expect(runnerOf(mine, () => 'REJECTED').run()).resolves.toMatchObject({ failed: 1 });
    expect((await cancellationRow(rejected))?.refund_failed_at).not.toBeNull();
    // 틱 끝 ops 500: 두 행 모두 불렀고 연 시각은 빔
    expect(ops.state.requests.map((r) => r.body.sourceId).sort()).toEqual([fanMarked, rejected].sort());
    expect(ops.state.requests.every((r) => r.body.kind === 'REFUND_FAILED' && r.body.category === 'REFUND' && r.token === 'it-token')).toBe(true);
    expect(await opened([fanMarked, rejected], 'refund_failed_opened_at')).toBe(0);
    // 다음 틱 202 → 연 시각
    ops.state.mode = 202;
    await runnerOf(mine, () => 'REJECTED').run();
    expect(await opened([fanMarked, rejected], 'refund_failed_opened_at')).toBe(2);
    const n = ops.state.requests.length;
    await runnerOf(mine, () => 'REJECTED').run();
    expect(ops.state.requests).toHaveLength(n);
    expect(ops.state.requests.map((r) => r.body.sourceId)).not.toContain(withRequest);
    expect(ops.state.requests.map((r) => r.body.sourceId)).not.toContain(voided);
    expect(await opened([withRequest, voided], 'refund_failed_opened_at')).toBe(0);
    // 뒤 시험이 다시 집지 않게 끝낸다
    await admin.pool.query("update order_cancellation set status = 'VOIDED', status_changed_at = now() where id = any($1::uuid[]) and status = 'REFUND_PENDING'", [[...mine]]);
  }, 60_000);
});

// BAT-420-rest P-T72 ②③④⑤⑥(시험 담당 l3-b420-test, 2026-11-19): 예매 취소의 환불 계좌 규칙과 계좌 대기를 실제 PostgreSQL(purchase·ticket·payment)·
// 실제 ticket-svc·payment-svc gRPC(운영 처리기·저장소)로 돈다. 결제사만 기록 대역이다. 가상계좌 결제는 payment 원장에 수출 사건 AWAITING_DEPOSIT·APPROVED를 넣어 만든다
// (정본 docs/features/payment.md §6 '가상계좌였는지'). 결제 수단 읽기는 실제 GrpcPaymentCancellations.virtualAccountPaid(GetPayment)다.
// HTTP 422·503 모양과 견적은 test/cancel-refund-account-http.test.ts가 본다. 계좌 글 누설은 세 DB의 모든 행에서 찾는다.
describe('P-T72 예매 취소의 환불 계좌 규칙과 계좌 대기 [실제 PostgreSQL·ticket-svc·payment-svc gRPC]', () => {
  const ACCOUNT_NO = '110-987-654321';
  const ACCOUNT_DIGITS = '110987654321';
  const HOLDER = '김환불';
  const REFUND_ACCOUNT = { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER };
  let ops: Awaited<ReturnType<typeof startOpsCsDouble>>;
  const log: string[] = [];
  let vaSaga: CancelTicket;
  beforeAll(async () => {
    ops = await startOpsCsDouble(log);
    vaSaga = new CancelTicket({
      orders: new DrizzleCancellationOrders(purchaseDb, seatMap),
      calendar,
      tickets: ticketCancels!,
      payments: paymentCancels!,
      writes,
      seats: new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis)),
      paymentMethods: paymentCancels!,
    });
  });
  afterAll(async () => {
    await ops?.close();
    gatewayReason = undefined;
    gatewayOutcome = 'CANCELLED';
  });

  /** 입금 확정까지 간 가상계좌 결제(수출 사건 AWAITING_DEPOSIT·APPROVED) */
  const virtualWorld = async (): Promise<World> => {
    const w = await world();
    await paymentDb.pool.query(
      `insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, 1, $2, 'AWAITING_DEPOSIT', true, now()), ($1, 2, $3, 'APPROVED', true, now())`,
      [w.paymentId, randomUUID(), randomUUID()],
    );
    return w;
  };
  const vaCancel = (w: World, cancellationId: string, refundAccount?: typeof REFUND_ACCOUNT) =>
    vaSaga.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId, reason: 'USER', nowMs: NOW, deadlineMs: 5_000, ...(refundAccount ? { refundAccount } : {}) });
  const accountRow = async (cancellationId: string) =>
    (
      await admin.pool.query<{ status: string; next_refund_at: Date | null; refund_account_required_at: Date | null; refund_account_case_opened_at: Date | null; refund_attempts: number; refund_failed_at: Date | null }>(
        'select status, next_refund_at, refund_account_required_at, refund_account_case_opened_at, refund_attempts, refund_failed_at from order_cancellation where id = $1',
        [cancellationId],
      )
    ).rows[0];
  const paymentCancelRows = async (paymentId: string) => (await paymentDb.pool.query('select status from payment_cancel where payment_id = $1', [paymentId])).rows as { status: string }[];
  /** 세 DB 모든 공개 표·모든 행에서 계좌 글을 찾는다 */
  const leaks = async (): Promise<string[]> => {
    const found: string[] = [];
    for (const [name, d] of [
      ['purchase', admin],
      ['ticket', ticketDb],
      ['payment', paymentDb],
    ] as const) {
      const tables = (await d.pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
      for (const t of tables) {
        const rows = (await d.pool.query<{ line: string }>(`select t::text as line from "${t}" t`)).rows;
        for (const r of rows) for (const needle of [ACCOUNT_NO, ACCOUNT_DIGITS, HOLDER]) if (r.line.includes(needle)) found.push(`${name}.${t}:${needle}`);
      }
    }
    return found;
  };

  test('P-T72 ② 가상계좌·입장 시작 전에 계좌 없이 취소하면 REFUND_ACCOUNT_REQUIRED이고 실제 ticket 행·order_cancellation·payment_cancel·결제사 호출이 그대로다(0)', async () => {
    const w = await virtualWorld();
    const before = await ticketRow(w.ticketId);
    gatewayCalls = [];
    const cancellationId = randomUUID();
    await expect(vaCancel(w, cancellationId)).resolves.toEqual({ status: 'REFUND_ACCOUNT_REQUIRED' });
    expect(await ticketRow(w.ticketId)).toEqual(before);
    expect(await cancellationRow(cancellationId)).toBeUndefined();
    expect((await admin.pool.query('select 1 from order_cancellation where order_id = $1', [w.orderId])).rows).toEqual([]);
    expect(await paymentCancelRows(w.paymentId)).toEqual([]);
    expect(gatewayCalls).toEqual([]);
    expect(await paymentRow(w.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
  });

  test('P-T72 ③ 계좌를 실으면 결제사 대역이 받은 계좌가 본문과 같고(하이픈을 뺀 숫자) 환급액이 한 번 나간다. 카드 결제에 실은 계좌는 결제사에 가지 않는다', async () => {
    const w = await virtualWorld();
    gatewayCalls = [];
    gatewayOutcome = 'CANCELLED';
    const cancellationId = randomUUID();
    const r = await vaCancel(w, cancellationId, REFUND_ACCOUNT);
    expect(r).toMatchObject({ status: 'ACCEPTED', cancellationId });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]!.refundAccount).toEqual({ bankCode: '88', accountNumber: ACCOUNT_DIGITS, holderName: HOLDER });
    expect(gatewayCalls[0]!.idemKey).toBe(`cancel-${cancellationId}`);
    const row = await cancellationRow(cancellationId);
    expect(row).toMatchObject({ status: 'REFUNDED' });
    expect((await paymentRow(w.paymentId))!.cancelled_amount).toBe(row!.refund_amount);

    const card = await world();
    gatewayCalls = [];
    await expect(vaCancel(card, randomUUID(), REFUND_ACCOUNT)).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).not.toHaveProperty('refundAccount');
  });

  test('P-T72 ④ 결제사가 계좌를 거절해 payment가 REFUND_ACCOUNT_REQUIRED로 답하면 REFUND_PENDING·refundAccountRequired이고, 행은 next_refund_at 빔·refund_account_required_at = 취소 시각·재시도 횟수 0·실패 표시 없음이며 마감 뒤 환급 실행기가 집지 않는다', async () => {
    const w = await virtualWorld();
    gatewayCalls = [];
    gatewayOutcome = 'REJECTED';
    gatewayReason = 'REFUND_ACCOUNT_INVALID';
    const cancellationId = randomUUID();
    try {
      const r = await vaCancel(w, cancellationId, REFUND_ACCOUNT);
      expect(r).toMatchObject({ status: 'REFUND_PENDING', cancellationId, payment: 'REFUND_ACCOUNT_REQUIRED', refundAccountRequired: true });
    } finally {
      gatewayOutcome = 'CANCELLED';
      gatewayReason = undefined;
    }
    // 장애 주입이 실제로 끼어들었다: 결제사가 한 번 불렸고 payment_cancel 행이 FAILED다
    expect(gatewayCalls).toHaveLength(1);
    expect(await paymentCancelRows(w.paymentId)).toEqual([{ status: 'FAILED' }]);
    const row = await accountRow(cancellationId);
    expect(row).toMatchObject({ status: 'REFUND_PENDING', next_refund_at: null, refund_attempts: 0, refund_failed_at: null, refund_account_case_opened_at: null });
    expect(row!.refund_account_required_at?.getTime()).toBe(NOW);
    expect(await paymentRow(w.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    // 하루 뒤에도 실제 집기 질의(dueRefunds)에 없다
    const due = await writes.dueRefunds(NOW + DAY, 1_000);
    expect(due.map((d) => d.cancellationId)).not.toContain(cancellationId);
    // 0029 CHECK: 표시 없이 연 시각을 쓸 수 없다
    await expect(admin.pool.query('update order_cancellation set refund_account_required_at = null, refund_account_case_opened_at = now() where id = $1', [cancellationId])).rejects.toMatchObject({
      code: '23514',
      constraint: 'order_cancellation_refund_account_case_check',
    });
  });

  test("P-T72 ⑤ 틱 끝 다시 열기는 환급 실패 건 다음에 '환불 대기'(REFUND_ACCOUNT_PENDING) 건을 열고 2xx 뒤에만 refund_account_case_opened_at을 쓰며, ops가 500이면 다음 틱에 다시 열고 연 뒤에는 다시 부르지 않는다", async () => {
    const w = await virtualWorld();
    gatewayOutcome = 'REJECTED';
    gatewayReason = 'REFUND_ACCOUNT_INVALID';
    const pendingId = randomUUID();
    try {
      await vaCancel(w, pendingId, REFUND_ACCOUNT);
    } finally {
      gatewayOutcome = 'CANCELLED';
      gatewayReason = undefined;
    }
    // 환급 실패로 표시된 다른 팬 행(차례 대조)
    const failedWorld = await world();
    const failedId = randomUUID();
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at, refund_failed_at, refund_last_error, refund_attempts)
       values ($1, $2, $3, 'USER', 0, false, 0, 0, 1000, 'REFUND_PENDING', now(), now(), now(), 'REJECTED', 1)`,
      [failedId, failedWorld.orderId, failedWorld.ticketId],
    );
    const mine = new Set<string>([pendingId, failedId]);
    const real = new DrizzleCsCaseOutbox(admin);
    const client = createExternalHttpClient({ provider: 'ops-svc', baseUrl: ops.url, timeoutCapMs: 5_000 });
    const scopedWrites = Object.create(writes) as typeof writes;
    scopedWrites.dueRefunds = async (nowMs, limit) => (await writes.dueRefunds(nowMs, limit)).filter((r) => mine.has(r.cancellationId));
    const failures: string[] = [];
    const runner = () =>
      new RefundAfterEntry({
        writes: scopedWrites,
        payments: { cancel: async (q) => (log.push(`pay:${q.cancellationId}`), 'CANCELLED') },
        entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
        claims: writes,
        failureNotice: new HttpRefundFailureNotice(client, 'it-token'),
        flags: new HttpEntryFlagNotice(client, 'it-token'),
        accountNotice: new HttpRefundAccountNotice(client, 'it-token'),
        csOutbox: {
          pendingRefundFailures: async (limit: number) => (await real.pendingRefundFailures(limit)).filter((r) => mine.has(r.cancellationId)),
          markRefundFailureOpened: (id: string, nowMs: number) => real.markRefundFailureOpened(id, nowMs),
          pendingFlags: async (limit: number) => (await real.pendingFlags(limit)).filter((r) => mine.has(r.cancellationId)),
          markFlagOpened: (id: string, nowMs: number) => real.markFlagOpened(id, nowMs),
          pendingRefundAccounts: async (limit: number) => (await real.pendingRefundAccounts(limit)).filter((r) => mine.has(r.cancellationId)),
          markRefundAccountOpened: (id: string, nowMs: number) => real.markRefundAccountOpened(id, nowMs),
        },
        csCaseOpenFailures: { inc: (k) => void failures.push(k), cut: () => undefined },
        log: { warn: () => undefined, error: () => undefined },
        nowMs: () => Date.now(),
      });
    log.length = 0;
    ops.state.requests.length = 0;
    ops.state.mode = 500;
    await runner().run();
    // 장애 주입이 끼어들었다: 두 건 모두 불렸고 500을 받았다
    expect(ops.state.requests.map((r) => [r.body.kind, r.body.sourceId])).toEqual([
      ['REFUND_FAILED', failedId],
      ['REFUND_ACCOUNT_PENDING', pendingId],
    ]);
    expect(failures).toEqual(['REFUND_FAILED', 'REFUND_ACCOUNT_PENDING']);
    expect((await accountRow(pendingId))!.refund_account_case_opened_at).toBeNull();
    // 계좌 대기 행은 결제사로 다시 가지 않는다
    expect(log.filter((l) => l === `pay:${pendingId}`)).toEqual([]);

    ops.state.requests.length = 0;
    ops.state.mode = 202;
    await runner().run();
    expect(ops.state.requests.map((r) => [r.body.kind, r.body.sourceId, r.body.category, r.token])).toEqual([
      ['REFUND_FAILED', failedId, 'REFUND', 'it-token'],
      ['REFUND_ACCOUNT_PENDING', pendingId, 'REFUND', 'it-token'],
    ]);
    expect((await accountRow(pendingId))!.refund_account_case_opened_at).not.toBeNull();
    ops.state.requests.length = 0;
    await runner().run();
    expect(ops.state.requests).toEqual([]);
    expect(log.filter((l) => l === `pay:${pendingId}`)).toEqual([]);
    // 뒤 시험이 다시 집지 않게 끝낸다
    await admin.pool.query("update order_cancellation set status = 'VOIDED', status_changed_at = now() where id = any($1::uuid[]) and status = 'REFUND_PENDING'", [[...mine]]);
  }, 60_000);

  test('P-T72 ⑥ 계좌를 실은 취소·계좌 거절·계좌 대기를 돈 뒤 purchase·ticket·payment DB의 모든 행(order_cancellation·Outbox 포함)에 계좌번호·예금주 글이 없다 [ASVS v5.0.0-14.2.4]', async () => {
    const w = await virtualWorld();
    await vaCancel(w, randomUUID(), REFUND_ACCOUNT);
    const w2 = await virtualWorld();
    gatewayOutcome = 'REJECTED';
    gatewayReason = 'REFUND_ACCOUNT_INVALID';
    try {
      await vaCancel(w2, randomUUID(), REFUND_ACCOUNT);
    } finally {
      gatewayOutcome = 'CANCELLED';
      gatewayReason = undefined;
    }
    expect(await leaks()).toEqual([]);
  });
});

// BAT-420-rest 리뷰 반영 재현 RV-03·판정 대조 P-T72 ③(시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/payment.md §6 '계좌 대기' 끝(계좌 대기 행을 같은 표의 다시 누름이 부르면 payment-svc를 부르지 않고 실패 표시 없이 202 REFUND_PENDING·refundAccountRequired),
// §11 P-T73 ④, P-T72 ③(재시도 실행기의 호출에도 계좌가 없다).
describe('P-T73 ④·P-T72 ③ 계좌 대기 표의 다시 누름과 재시도 실행기 [실제 PostgreSQL·ticket-svc·payment-svc gRPC]', () => {
  const REFUND_ACCOUNT = { bankCode: '88', accountNumber: '110-987-654321', holderName: '김환불' };
  let ops: Awaited<ReturnType<typeof startOpsCsDouble>>;
  const paymentCalls: { cancellationId: string; refundAccount?: unknown }[] = [];
  let countingSaga: CancelTicket;
  beforeAll(async () => {
    ops = await startOpsCsDouble();
    countingSaga = new CancelTicket({
      orders: new DrizzleCancellationOrders(purchaseDb, seatMap),
      calendar,
      tickets: ticketCancels!,
      payments: {
        cancel: (q) => {
          paymentCalls.push({ cancellationId: q.cancellationId, ...(q.refundAccount !== undefined ? { refundAccount: q.refundAccount } : {}) });
          return paymentCancels!.cancel(q);
        },
      },
      writes,
      seats: new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis)),
      paymentMethods: paymentCancels!,
    });
  });
  afterAll(async () => {
    await ops?.close();
    gatewayOutcome = 'CANCELLED';
    gatewayReason = undefined;
  });
  const virtualWorld = async (o: { entryOpensAtMs?: number } = {}): Promise<World> => {
    const w = await world(o);
    await paymentDb.pool.query(
      `insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, 1, $2, 'AWAITING_DEPOSIT', true, now()), ($1, 2, $3, 'APPROVED', true, now())`,
      [w.paymentId, randomUUID(), randomUUID()],
    );
    return w;
  };
  const press = (w: World, cancellationId: string, refundAccount?: typeof REFUND_ACCOUNT) =>
    countingSaga.execute({ accountId: w.accountId, ticketId: w.ticketId, cancellationId, reason: 'USER', nowMs: NOW, deadlineMs: 5_000, ...(refundAccount ? { refundAccount } : {}) });

  test("P-T73 ④ 팬이 계좌 거절 뒤 새 멱등 키로 같은 표를 다시 누르면 202 REFUND_PENDING·refundAccountRequired 참이고 payment 호출 0, refund_failed_at 빔, 그 취소의 CS 건은 '환불 대기' 하나뿐이다", async () => {
    const w = await virtualWorld();
    gatewayOutcome = 'REJECTED';
    gatewayReason = 'REFUND_ACCOUNT_INVALID';
    const first = randomUUID();
    try {
      await expect(press(w, first, REFUND_ACCOUNT)).resolves.toMatchObject({ status: 'REFUND_PENDING', refundAccountRequired: true });
    } finally {
      gatewayOutcome = 'CANCELLED';
      gatewayReason = undefined;
    }
    paymentCalls.length = 0;
    gatewayCalls = [];
    const again = await press(w, randomUUID(), REFUND_ACCOUNT);
    expect(again).toMatchObject({ status: 'REFUND_PENDING', cancellationId: first, refundAccountRequired: true });
    expect(paymentCalls).toEqual([]);
    expect(gatewayCalls).toEqual([]);
    const row = (await admin.pool.query<{ refund_failed_at: Date | null; refund_account_required_at: Date | null; status: string }>('select status, refund_failed_at, refund_account_required_at from order_cancellation where id = $1', [first])).rows[0]!;
    expect(row).toMatchObject({ status: 'REFUND_PENDING', refund_failed_at: null });
    expect(row.refund_account_required_at).not.toBeNull();
    // 틱 끝 다시 열기 한 번: 그 취소의 건은 '환불 대기' 하나뿐이다(환급 실패 건이 없다)
    const real = new DrizzleCsCaseOutbox(admin);
    const mine = new Set<string>([first]);
    const client = createExternalHttpClient({ provider: 'ops-svc', baseUrl: ops.url, timeoutCapMs: 5_000 });
    const scopedWrites = Object.create(writes) as typeof writes;
    scopedWrites.dueRefunds = async (nowMs, limit) => (await writes.dueRefunds(nowMs, limit)).filter((r) => mine.has(r.cancellationId));
    ops.state.requests.length = 0;
    ops.state.mode = 202;
    await new RefundAfterEntry({
      writes: scopedWrites,
      payments: { cancel: async () => 'CANCELLED' },
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: writes,
      failureNotice: new HttpRefundFailureNotice(client, 'it-token'),
      accountNotice: new HttpRefundAccountNotice(client, 'it-token'),
      csOutbox: {
        pendingRefundFailures: async (limit: number) => (await real.pendingRefundFailures(limit)).filter((r) => mine.has(r.cancellationId)),
        markRefundFailureOpened: (id: string, nowMs: number) => real.markRefundFailureOpened(id, nowMs),
        pendingFlags: async () => [],
        markFlagOpened: async () => undefined,
        pendingRefundAccounts: async (limit: number) => (await real.pendingRefundAccounts(limit)).filter((r) => mine.has(r.cancellationId)),
        markRefundAccountOpened: (id: string, nowMs: number) => real.markRefundAccountOpened(id, nowMs),
      },
      csCaseOpenFailures: { inc: () => undefined, cut: () => undefined },
      log: { warn: () => undefined, error: () => undefined },
      nowMs: () => Date.now(),
    }).run();
    expect(ops.state.requests.map((r) => [r.body.kind, r.body.sourceId])).toEqual([['REFUND_ACCOUNT_PENDING', first]]);
    await admin.pool.query("update order_cancellation set status = 'VOIDED', status_changed_at = now() where id = $1 and status = 'REFUND_PENDING'", [first]);
  }, 60_000);

  test('P-T72 ③ 재시도 실행기는 실제로 집은 행으로도 계좌를 싣지 않는다: 입장 시작 뒤 취소(본문에 계좌)를 실제 DB에 쓰고 마감 뒤 실제 dueRefunds·실제 실행기로 돌리면 payment 호출에 refundAccount가 없다', async () => {
    const w = await virtualWorld({ entryOpensAtMs: NOW - HOUR });
    const cancellationId = randomUUID();
    paymentCalls.length = 0;
    await expect(press(w, cancellationId, REFUND_ACCOUNT)).resolves.toMatchObject({ status: 'ACCEPTED', refundAfterEntryClose: true });
    expect(paymentCalls).toEqual([]);
    const due = (await admin.pool.query<{ refund_due_at: Date }>('select refund_due_at from order_cancellation where id = $1', [cancellationId])).rows[0]!.refund_due_at;
    const mine = new Set<string>([cancellationId]);
    const scopedWrites = Object.create(writes) as typeof writes;
    scopedWrites.dueRefunds = async (nowMs, limit) => (await writes.dueRefunds(nowMs, limit)).filter((r) => mine.has(r.cancellationId));
    const runnerCalls: Record<string, unknown>[] = [];
    await new RefundAfterEntry({
      writes: scopedWrites,
      payments: { cancel: async (q) => (runnerCalls.push({ ...q }), 'CANCELLED') },
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: writes,
      log: { warn: () => undefined, error: () => undefined },
      nowMs: () => due.getTime() + 1,
    }).run();
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({ cancellationId });
    expect(runnerCalls[0]).not.toHaveProperty('refundAccount');
  }, 60_000);
});

// RV-01(높음): 계좌를 실은 시도가 결과 모름(CANCEL_PENDING·UNKNOWN)이면 purchase는 계좌를 저장하지 않으므로
// 1분 뒤 재시도는 계좌 없이 온다. payment-svc가 같은 시도의 행을 조회로 정산하면 새 전송 0·이중 환급 0으로 끝나야 한다.
// 지금 코드는 attempt > 0 && account === undefined를 행 조회보다 먼저 거절해 재시도가 끝내 실패(CS '환급 실패')한다.
describe('P-T76 ② 계좌 시도의 재시도 [실제 PostgreSQL·ticket-svc·payment-svc gRPC]', () => {
  const REFUND_ACCOUNT = { bankCode: '88', accountNumber: '110-987-654321', holderName: '김환불' };
  const accountRow = async (cancellationId: string) =>
    (
      await admin.pool.query<{ status: string; refund_attempt: number; next_refund_at: Date | null; refund_account_required_at: Date | null; refund_failed_at: Date | null }>(
        'select status, refund_attempt, next_refund_at, refund_account_required_at, refund_failed_at from order_cancellation where id = $1',
        [cancellationId],
      )
    ).rows[0]!;
  const cancelRows = async (paymentId: string) =>
    (await paymentDb.pool.query<{ idempotency_key: string; attempt: number; status: string }>('select idempotency_key, attempt, status from payment_cancel where payment_id = $1', [paymentId])).rows;

  test('P-T76 ②_계좌_시도가_UNKNOWN으로_남은_뒤_재시도는_계좌_없이_조회로_정산하고_새_전송_0·이중_환급_0이다', async () => {
    const w = await world();
    await paymentDb.pool.query(
      `insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, 1, $2, 'AWAITING_DEPOSIT', true, now()), ($1, 2, $3, 'APPROVED', true, now())`,
      [w.paymentId, randomUUID(), randomUUID()],
    );
    const cancellationId = randomUUID();
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at, refund_account_required_at, refund_attempts, refund_attempt)
       values ($1, $2, $3, 'USER', 7, false, 1000, 10000, 90000, 'REFUND_PENDING', $4, $4, $4, 0, 0)`,
      [cancellationId, w.orderId, w.ticketId, new Date(NOW)],
    );

    gatewayCalls = [];
    gatewayQueries = [];
    gatewayQuery = { kind: 'UNKNOWN' };
    gatewayOutcome = 'UNKNOWN';
    gatewayReason = undefined;
    try {
      const request = new RequestRefundAccount({ orders: new DrizzleCancellationOrders(purchaseDb, seatMap), writes, payments: paymentCancels!, nowMs: () => NOW });
      await expect(request.run({ accountId: w.accountId, cancellationId, account: REFUND_ACCOUNT, reauthToken: undefined, idempotencyKey: randomUUID() })).resolves.toEqual({
        cancellationId,
        status: 'REFUND_PENDING',
        refundAmount: 90_000,
      });
    } finally {
      gatewayOutcome = 'CANCELLED';
    }
    // 첫 시도는 계좌를 실어 결제사에 한 번 갔고, 결과 모름이라 행은 시도 1·REQUESTED다
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ amount: 90_000, idemKey: `cancel-${cancellationId}-a1`, refundAccount: { bankCode: '88', accountNumber: '110987654321', holderName: '김환불' } });
    expect(await cancelRows(w.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}-a1`, attempt: 1, status: 'REQUESTED' }]);
    expect(await accountRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', refund_attempt: 1, next_refund_at: new Date(NOW + 60_000), refund_account_required_at: null, refund_failed_at: null });

    // 결제사에는 첫 시도가 반영됐다(지금 취소 가능 잔액 = 100,000 - 90,000 = 10,000)
    gatewayQuery = { kind: 'FOUND', paymentRef: `ref-${w.orderId}`, orderRef: w.orderId, status: 'APPROVED', amount: PRICE, balanceAmount: PRICE - 90_000 };
    gatewayQueries = [];
    const retry = new RefundAfterEntry({
      writes,
      payments: paymentCancels!,
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: writes,
      nowMs: () => NOW + 60_000,
    });
    await expect(retry.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    // 새 결제사 취소는 0, 조회는 1이다(이중 환급 0)
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayQueries).toHaveLength(1);
    expect(await cancelRows(w.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}-a1`, attempt: 1, status: 'CANCELED' }]);
    expect(await paymentRow(w.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 90_000 });
    expect(await accountRow(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempt: 1, next_refund_at: null, refund_failed_at: null });
  }, 60_000);

  // RV-21(높음): a1이 CANCEL_PENDING으로 남고 1분 뒤 같은 시도의 재시도 조회가 아직 '반영 아님'이면,
  // payment-svc가 REFUND_ACCOUNT_REQUIRED(422)를 주면 purchase가 계좌 대기로 멈춘다. 같은 시도의 재시도는
  // 202 REFUND_PENDING(CANCEL_PENDING·UNKNOWN)이어야 재시도 루프가 a1을 계속 조회한다(ADR-0316 결정 4, B9).
  test('P-T76 ②_RV21_결제사가_CANCEL_PENDING인_a1의_재시도_조회가_반영_아니면_계좌_대기로_멈추지_않고_재시도를_유지한다', async () => {
    const w = await world();
    await paymentDb.pool.query(
      `insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, 1, $2, 'AWAITING_DEPOSIT', true, now()), ($1, 2, $3, 'APPROVED', true, now())`,
      [w.paymentId, randomUUID(), randomUUID()],
    );
    const cancellationId = randomUUID();
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at, refund_account_required_at, refund_attempts, refund_attempt)
       values ($1, $2, $3, 'USER', 7, false, 1000, 10000, 90000, 'REFUND_PENDING', $4, $4, $4, 0, 0)`,
      [cancellationId, w.orderId, w.ticketId, new Date(NOW)],
    );

    gatewayCalls = [];
    gatewayQueries = [];
    gatewayQuery = { kind: 'UNKNOWN' };
    gatewayOutcome = 'CANCEL_PENDING';
    gatewayReason = undefined;
    try {
      const request = new RequestRefundAccount({ orders: new DrizzleCancellationOrders(purchaseDb, seatMap), writes, payments: paymentCancels!, nowMs: () => NOW });
      await expect(request.run({ accountId: w.accountId, cancellationId, account: REFUND_ACCOUNT, reauthToken: undefined, idempotencyKey: randomUUID() })).resolves.toEqual({
        cancellationId,
        status: 'REFUND_PENDING',
        refundAmount: 90_000,
      });
    } finally {
      gatewayOutcome = 'CANCELLED';
    }
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ idemKey: `cancel-${cancellationId}-a1`, refundAccount: { bankCode: '88', accountNumber: '110987654321', holderName: '김환불' } });
    expect(await cancelRows(w.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}-a1`, attempt: 1, status: 'CANCEL_PENDING' }]);
    expect(await accountRow(cancellationId)).toMatchObject({ status: 'REFUND_PENDING', refund_attempt: 1, next_refund_at: new Date(NOW + 60_000), refund_account_required_at: null, refund_failed_at: null });

    // 1분 뒤 같은 시도(a1, 계좌 없음)의 조회는 아직 '반영 아님'이다(지금 취소 가능 잔액 = 100,000)
    gatewayQuery = { kind: 'FOUND', paymentRef: `ref-${w.orderId}`, orderRef: w.orderId, status: 'APPROVED', amount: PRICE, balanceAmount: PRICE };
    gatewayQueries = [];
    const retry = new RefundAfterEntry({
      writes,
      payments: paymentCancels!,
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: writes,
      nowMs: () => NOW + 60_000,
    });
    await expect(retry.run()).resolves.toEqual({ refunded: 0, pending: 1, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    // 새 전송 0·조회 1이고, 계좌 대기(refund_account_required_at)로 멈추지 않고 다음 재시도를 예약한다
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayQueries).toHaveLength(1);
    expect(await cancelRows(w.paymentId)).toEqual([{ idempotency_key: `cancel-${cancellationId}-a1`, attempt: 1, status: 'CANCEL_PENDING' }]);
    const row = await accountRow(cancellationId);
    expect(row).toMatchObject({ status: 'REFUND_PENDING', refund_attempt: 1, refund_account_required_at: null, refund_failed_at: null });
    expect(row.next_refund_at).not.toBeNull();
  }, 60_000);
});
