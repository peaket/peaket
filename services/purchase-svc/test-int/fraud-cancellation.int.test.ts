// 부정 예매 운영자 취소(fraud_cancellation.proto, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', BUILD_ORDER GAT-080, BAT-415 몫 F)를
// 실제 PostgreSQL 18(purchase·ticket·payment 데이터베이스)·Valkey 8.1·실제 ticket-svc gRPC·실제 payment-svc gRPC·실제 purchase gRPC 서버(내부 토큰)로 돈다.
// 결제사만 기록 대역이다. 운영자 취소 호출은 결제사를 부르지 않고, 환급 재시도 실행기(RefundAfterEntry)가 REFUND_PENDING을 집어 같은 cancel-{cancellationId}로 부른다.
// 약속: 컨테이너 하나를 파일이 나눠 쓰고 회차·주문·표 ID는 시험마다 새 UUID다. 클라이언트는 계약 설명자(@peaket/contracts/proto)에서 따로 만든다.
// 양도 기능(GAT-050) 전이라 '받은 사람이 가진 표'는 ticket 행의 account_id를 SQL로 바꿔 흉내 낸다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Fraudcancellation } from '@peaket/contracts/proto';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, INTERNAL_GRPC_ACTOR_HEADER, INTERNAL_GRPC_ACTOR_PROOF_HEADER, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, internalGrpcActorProof } from '@peaket/platform';
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
import { startPurchaseGrpcServer } from '../src/grpc-server.js';
import { DrizzleOrderStore } from '../src/modules/booking/index.js';
import { DrizzleSeatSales, MemorySeatMap, RedisSeatStore, seatKeys } from '../src/modules/inventory/index.js';
import {
  CancelFraudTickets,
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleFraudCancellationStore,
  DrizzleSeatReturns,
  fraudCancellationHandlers,
  fraudCancellationId,
  GetFraudCancellation,
  GrpcPaymentCancellations,
  GrpcTicketCancellations,
  RedisSeatReturnNotices,
  RefundAfterEntry,
  type SeatReturns,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const kst = (s: string): number => Date.parse(`${s}+09:00`);
/** 공연 2026-11-20 19:00 → 판매 종료 11-19 19:00 → 취소 마감 11-19 17:00. 지금은 마감 전이다 */
const NOW = kst('2026-11-16T10:00:00');
const EVENT_STARTS = kst('2026-11-20T19:00:00');
const SALE_ENDS = EVENT_STARTS - 86_400_000;
const PRICE = 33_333;
const TOKEN = 'internal-grpc-token-fraud-it';
const APPROVED_BY = 'commander-2';
const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Reply = Record<string, unknown>;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Reply) => void) => grpc.ClientUnaryCall;
type Client = grpc.Client & { CancelFraudTickets: Unary; GetFraudCancellation: Unary };

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
let purchaseServer: { port: number; close(): Promise<void> } | undefined;
let ticketCancels: GrpcTicketCancellations | undefined;
let paymentCancels: GrpcPaymentCancellations | undefined;
let writes: DrizzleCancellationWrites;
let fraudStore: DrizzleFraudCancellationStore;
let get: GetFraudCancellation;
let client: Client | undefined;
let gatewayCalls: Parameters<PaymentGatewayPort['cancel']>[0][] = [];
const gatewayOutcome: CancelResult['outcome'] = 'CANCELLED';
const calendar = new WeekendBusinessCalendar();

async function createNamedDatabase(serverUrl: string, name: string): Promise<string> {
  const c = new pg.Client({ connectionString: serverUrl });
  await c.connect();
  try {
    await c.query(`create database "${name}"`);
  } finally {
    await c.end();
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
  purchaseDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'fraud-it-purchase' });
  ticketDb = createDatabase({ url: ticketUrl, profile: 'general', max: 6, applicationName: 'fraud-it-ticket' });
  paymentDb = createDatabase({ url: paymentUrl, profile: 'general', max: 6, applicationName: 'fraud-it-payment' });
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'fraud-it-admin' });
  await ensureOutboxPartitions(admin, fakeClock({ now: NOW }));
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
  const gateway = {
    pg: 'TOSS',
    cancel: async (c: Parameters<PaymentGatewayPort['cancel']>[0]) => {
      gatewayCalls.push(c);
      return { outcome: gatewayOutcome };
    },
  } as unknown as PaymentGatewayPort;
  const confirmed = new CancelConfirmedPayment({ store: jobs, gateways: { of: () => gateway }, guards: { of: () => ({ circuitClosed: () => true, tryTakeToken: () => true }) as never }, clock });
  const getPayment = new GetPaymentDetail({
    reader: new DrizzlePaymentStore({ database: paymentDb, batchDatabase: paymentDb }),
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
            cancelPayment: new CancelPayment({ execute: async () => Promise.reject(new Error('입금 전 취소 갈래가 아니다')) } as never, confirmed, jobs),
          },
          () => {},
        ),
      },
    ],
  });

  writes = new DrizzleCancellationWrites(purchaseDb, new DrizzleOrderStore({ clock }));
  ticketCancels = new GrpcTicketCancellations({ address: `127.0.0.1:${ticketServer.port}` });
  paymentCancels = new GrpcPaymentCancellations({ address: `127.0.0.1:${paymentServer.port}` });
  fraudStore = new DrizzleFraudCancellationStore(purchaseDb);
  const cancel = new CancelFraudTickets({
    store: fraudStore,
    tickets: ticketCancels,
    orders: new DrizzleCancellationOrders(purchaseDb, seatMap),
    configs: seatMap,
    writes,
    calendar,
    seats: new DrizzleSeatReturns(sales, seatMap, new RedisSeatReturnNotices(redis)),
  });
  get = new GetFraudCancellation(fraudStore);
  const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(purchaseV1Fraudcancellation as Parameters<typeof protoLoader.fromJSON>[0], LOAD)) as unknown as {
    peaket: { purchase: { v1: { FraudCancellationService: grpc.ServiceClientConstructor } } };
  }).peaket.purchase.v1;
  purchaseServer = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: pkg.FraudCancellationService.service, handlers: fraudCancellationHandlers({ cancel, get, nowMs: () => NOW }, { internalToken: TOKEN }) }],
    internal: { token: TOKEN, services: ['peaket.purchase.v1.FraudCancellationService'] },
  });
  client = new pkg.FraudCancellationService(`127.0.0.1:${purchaseServer.port}`, grpc.credentials.createInsecure()) as unknown as Client;
}, 180_000);

afterAll(async () => {
  client?.close();
  ticketCancels?.close();
  paymentCancels?.close();
  await purchaseServer?.close();
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
  payerId: string;
  paymentId: string;
  /** 표 i의 ID·좌석 ID·좌석 색인 */
  tickets: { ticketId: string; seatId: string; index: number }[];
}

/** 한 주문에 표 n장(좌석 색인 3, 4, …), 판매 확정·결제 원장(금액 n × 33,333원)·Redis 비트맵을 맞춰 넣는다 */
async function world(n: number): Promise<World> {
  const eventId = randomUUID();
  const orderId = randomUUID();
  const payerId = randomUUID();
  const seats = Array.from({ length: n }, (_v, i) => ({ seatId: randomUUID(), index: 3 + i }));
  seatMap.put(
    { eventId, layoutVersion: 'v1', seatCount: 20, perAccountLimit: 10, saleEndsAtMs: SALE_ENDS, tierPrices: { R: PRICE } },
    seats.map((s) => ({ seatId: s.seatId, index: s.index, sectionId: 'A', sectionIndex: 0, seatOffset: s.index, tierId: 'R' })),
  );
  const bookedAt = new Date(kst('2026-11-01T10:00:00'));
  const c = await admin.pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', $6, $7, 'ps-test')`,
      [orderId, payerId, eventId, PRICE * n, randomUUID(), bookedAt, randomUUID()],
    );
    await c.query(`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)`, [orderId, bookedAt]);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  const issued = await ticketService.issue({ orderId, eventId, payerAccountId: payerId, seatIds: seats.map((s) => s.seatId), issueGeneration: 0 });
  const tickets = seats.map((s) => ({ ...s, ticketId: issued.tickets.find((t) => t.seatId === s.seatId)!.ticketId }));
  for (const [i, t] of tickets.entries()) {
    await admin.pool.query(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, $2, $3, 'R', 'A', $4, $5)`, [orderId, i + 1, t.seatId, PRICE, t.ticketId]);
  }
  expect(await sales.reserve({ eventId, accountId: payerId, orderId, seatIds: seats.map((s) => s.seatId), limit: 10 })).toEqual({ status: 'RESERVED' });
  expect(await sales.markSold({ eventId, orderId, seatIds: seats.map((s) => s.seatId) })).toBe(n);
  await store.openSale({ eventId, seatCount: 20, keepUntilMs: SALE_ENDS + 86_400_000 });
  for (const s of seats) await redis.command(['SETBIT', seatKeys.bitmap(eventId), String(s.index), '1'], { key: seatKeys.bitmap(eventId) });
  const paymentId = randomUUID();
  await paymentDb.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, created_at, approved_at, status_changed_at)
     values ($1, $2, $3, $4, 1, 'TOSS', $5, $6, 'APPROVED', $7, $8, $8, $8, $8)`,
    [paymentId, orderId, eventId, randomUUID(), `ref-${orderId}`, PRICE * n, `confirm-${orderId}`, bookedAt],
  );
  return { eventId, orderId, payerId, paymentId, tickets };
}

const opsMeta = (): grpc.Metadata => {
  const m = new grpc.Metadata();
  m.set(INTERNAL_GRPC_TOKEN_HEADER, TOKEN);
  m.set(INTERNAL_GRPC_CALLER_HEADER, 'ops-svc');
  m.set(INTERNAL_GRPC_ACTOR_HEADER, APPROVED_BY);
  m.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof(TOKEN, APPROVED_BY));
  return m;
};
const unary = (method: 'CancelFraudTickets' | 'GetFraudCancellation', req: object, meta: grpc.Metadata = opsMeta()): Promise<Reply> =>
  new Promise((resolve, reject) => {
    client![method](req, meta, { deadline: new Date(Date.now() + 10_000) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
  });
const requestOf = (w: World, approvalId: string, fraudCaseId: string, holders: readonly string[]) => ({
  approval_id: approvalId,
  fraud_case_id: fraudCaseId,
  event_id: w.eventId,
  targets: w.tickets.map((t, i) => ({ ticket_id: t.ticketId, expected_holder_account_id: holders[i] ?? w.payerId })),
  requested_by: 'investigator-1',
  approved_by: APPROVED_BY,
  approved_at: { seconds: Math.floor((NOW - 60_000) / 1000), nanos: 0 },
});
const cancellationRows = async (orderId: string) =>
  (
    await admin.pool.query(
      'select id, ticket_id, reason, fraud_case_id, approval_id, deduction_bp, deduction_amount, refund_amount, status from order_cancellation where order_id = $1 order by ticket_id',
      [orderId],
    )
  ).rows as { id: string; ticket_id: string; reason: string; fraud_case_id: string; approval_id: string; deduction_bp: number; deduction_amount: number; refund_amount: number; status: string }[];
const orderStatus = async (orderId: string): Promise<string> => (await admin.pool.query('select status from purchase_order where id = $1', [orderId])).rows[0].status as string;
const ticketRow = async (ticketId: string) => (await ticketDb.pool.query('select status, key_revoked_at from ticket where id = $1', [ticketId])).rows[0] as { status: string; key_revoked_at: Date | null };
const bit = async (eventId: string, index: number): Promise<number> => Number(await redis.command(['GETBIT', seatKeys.bitmap(eventId), String(index)], { key: seatKeys.bitmap(eventId) }));

describe('GAT-080 몫 F 부정 예매 운영자 취소 [실제 DB·ticket-svc·payment-svc·purchase gRPC]', () => {
  test('GAT-080 F15 실제 ticket-svc·payment-svc로 표 둘을 운영자 취소하면 결제자에게 공제 없이 한 번씩 환급된다', async () => {
    const w = await world(2);
    const recipient = randomUUID();
    await ticketDb.pool.query('update ticket set account_id = $2 where id = $1', [w.tickets[1]!.ticketId, recipient]);
    const approvalId = randomUUID();
    const fraudCaseId = randomUUID();
    gatewayCalls = [];

    const reply = await unary('CancelFraudTickets', requestOf(w, approvalId, fraudCaseId, [w.payerId, recipient]));
    const results = reply.results as Reply[];
    expect(results.map((r) => [r.ticket_id, r.outcome])).toEqual(w.tickets.map((t) => [t.ticketId, 'FRAUD_CANCELLATION_OUTCOME_ACCEPTED']));
    for (const [i, r] of results.entries()) expect(r).toMatchObject({ cancellation_id: fraudCancellationId(approvalId, w.tickets[i]!.ticketId), refund_amount: { krw: PRICE } });
    // 이 호출은 결제사를 부르지 않는다
    expect(gatewayCalls).toHaveLength(0);

    for (const t of w.tickets) {
      const row = await ticketRow(t.ticketId);
      expect(row.status).toBe('REFUNDED');
      expect(row.key_revoked_at).not.toBeNull();
    }
    expect(await cancellationRows(w.orderId)).toEqual(
      w.tickets
        .map((t) => ({
          id: fraudCancellationId(approvalId, t.ticketId),
          ticket_id: t.ticketId,
          reason: 'FRAUD',
          fraud_case_id: fraudCaseId,
          approval_id: approvalId,
          deduction_bp: 0,
          deduction_amount: 0,
          refund_amount: PRICE,
          status: 'REFUND_PENDING',
        }))
        .sort((a, b) => a.ticket_id.localeCompare(b.ticket_id)),
    );
    for (const t of w.tickets) {
      expect((await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, t.seatId])).rows[0].status).toBe('RETURNED');
      expect(await bit(w.eventId, t.index)).toBe(0);
    }
    expect(await orderStatus(w.orderId)).toBe('PARTIALLY_REFUNDED');

    const retry = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + 60_001 });
    await expect(retry.run()).resolves.toEqual({ refunded: 2, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls.map((c) => c.idemKey).sort()).toEqual(w.tickets.map((t) => `cancel-${fraudCancellationId(approvalId, t.ticketId)}`).sort());
    expect(gatewayCalls.every((c) => c.paymentRef === `ref-${w.orderId}` && c.reason === 'FRAUD')).toBe(true);
    expect((await paymentDb.pool.query('select status, cancelled_amount from payment where id = $1', [w.paymentId])).rows[0]).toEqual({ status: 'CANCELED', cancelled_amount: PRICE * 2 });
    expect((await cancellationRows(w.orderId)).map((r) => r.status)).toEqual(['REFUNDED', 'REFUNDED']);
    expect(await orderStatus(w.orderId)).toBe('REFUNDED');

    const progress = await unary('GetFraudCancellation', { approval_id: approvalId }, (() => {
      const m = new grpc.Metadata();
      m.set(INTERNAL_GRPC_TOKEN_HEADER, TOKEN);
      m.set(INTERNAL_GRPC_CALLER_HEADER, 'ops-svc');
      return m;
    })());
    expect((progress.results as Reply[]).map((r) => r.outcome)).toEqual(['FRAUD_CANCELLATION_OUTCOME_ACCEPTED', 'FRAUD_CANCELLATION_OUTCOME_ACCEPTED']);
    const refunds = progress.refunds as Reply[];
    expect(refunds).toHaveLength(2);
    for (const r of refunds) {
      expect(r.state).toBe('FRAUD_REFUND_STATE_REFUNDED');
      expect(r.refunded_at).not.toBeNull();
    }

    // 내부 토큰 없는 호출은 인터셉터가 막는다
    const noToken = new grpc.Metadata();
    noToken.set(INTERNAL_GRPC_CALLER_HEADER, 'ops-svc');
    await expect(unary('CancelFraudTickets', requestOf(w, randomUUID(), fraudCaseId, []), noToken)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
  });

  test('GAT-080 F16 같은 요청이 동시에 두 번 와도 표마다 취소 행·티켓 운영자 취소 기록·환급이 하나다', async () => {
    const w = await world(2);
    const approvalId = randomUUID();
    const fraudCaseId = randomUUID();
    gatewayCalls = [];
    const req = requestOf(w, approvalId, fraudCaseId, []);
    const [a, b] = await Promise.all([unary('CancelFraudTickets', req), unary('CancelFraudTickets', req)]);
    expect(a.results).toEqual(b.results);
    expect((a.results as Reply[]).map((r) => r.outcome)).toEqual(['FRAUD_CANCELLATION_OUTCOME_ACCEPTED', 'FRAUD_CANCELLATION_OUTCOME_ACCEPTED']);
    const perTicket = await admin.pool.query<{ ticket_id: string; n: number }>('select ticket_id, count(*)::int as n from order_cancellation where order_id = $1 group by ticket_id order by ticket_id', [w.orderId]);
    expect(perTicket.rows.map((r) => r.n)).toEqual([1, 1]);
    const opRows = await ticketDb.pool.query<{ n: number }>('select count(*)::int as n from ticket_operator_cancellation where approval_id = $1 group by ticket_id', [approvalId]);
    expect(opRows.rows.map((r) => r.n)).toEqual([1, 1]);

    const retry = new RefundAfterEntry({ writes, payments: paymentCancels!, entries: ticketCancels!, claims: writes, nowMs: () => NOW + 60_001 });
    await retry.run();
    const forThisOrder = gatewayCalls.filter((c) => c.paymentRef === `ref-${w.orderId}`);
    expect(forThisOrder.map((c) => c.idemKey).sort()).toEqual(w.tickets.map((t) => `cancel-${fraudCancellationId(approvalId, t.ticketId)}`).sort());
    expect((await paymentDb.pool.query('select cancelled_amount from payment where id = $1', [w.paymentId])).rows[0].cancelled_amount).toBe(PRICE * 2);
  });

  test('GAT-080 F17 진행 읽기는 order_cancellation 상태를 REFUNDED(바뀐 시각)·NEEDS_CS(refund_failed_at·VOIDED)·PENDING으로 준다', async () => {
    const w = await world(4);
    const approvalId = randomUUID();
    const reply = await unary('CancelFraudTickets', requestOf(w, approvalId, randomUUID(), []));
    expect((reply.results as Reply[]).every((r) => r.outcome === 'FRAUD_CANCELLATION_OUTCOME_ACCEPTED')).toBe(true);
    const [refunded, failed, voided, pending] = w.tickets.map((t) => fraudCancellationId(approvalId, t.ticketId)) as [string, string, string, string];
    const refundedAt = new Date(NOW + 3_600_000);
    await admin.pool.query("update order_cancellation set status = 'REFUNDED', status_changed_at = $2 where id = $1", [refunded, refundedAt]);
    await admin.pool.query('update order_cancellation set refund_failed_at = $2 where id = $1', [failed, new Date(NOW + 60_000)]);
    await admin.pool.query("update order_cancellation set status = 'VOIDED' where id = $1", [voided]);

    const got = await get.execute(approvalId);
    expect(got.results).toHaveLength(4);
    const byId = new Map(got.refunds.map((r) => [r.cancellationId, r]));
    expect(byId.get(refunded)).toEqual({ ticketId: w.tickets[0]!.ticketId, cancellationId: refunded, state: 'REFUNDED', refundedAtMs: refundedAt.getTime() });
    expect(byId.get(failed)).toMatchObject({ ticketId: w.tickets[1]!.ticketId, state: 'NEEDS_CS' });
    expect(byId.get(voided)).toMatchObject({ ticketId: w.tickets[2]!.ticketId, state: 'NEEDS_CS' });
    expect(byId.get(pending)).toMatchObject({ ticketId: w.tickets[3]!.ticketId, state: 'PENDING' });
    expect(byId.get(pending)!.refundedAtMs).toBeUndefined();

    await expect(get.execute(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---- BAT-415 리뷰 반영 B5(계획 §11 F21): 저장 문장이 끝난 결과를 덮지 않는다 ----
describe('GAT-080 F21 늦은 실패의 저장 [실제 DB]', () => {
  test('GAT-080 F21 같은 승인의 늦은 실패가 먼저 끝난 결과를 덮지 않는다(행은 ACCEPTED 그대로, 진행 읽기도 ACCEPTED와 환급 진행), FAILED 행은 덮어 쓴다', async () => {
    const w = await world(1);
    const approvalId = randomUUID();
    const reply = await unary('CancelFraudTickets', requestOf(w, approvalId, randomUUID(), []));
    expect((reply.results as Reply[]).map((r) => r.outcome)).toEqual(['FRAUD_CANCELLATION_OUTCOME_ACCEPTED']);
    const ticketId = w.tickets[0]!.ticketId;
    const cancellationId = fraudCancellationId(approvalId, ticketId);

    // 겹친 호출 B가 시작 때 결과를 못 읽은 채 그 표를 TICKET_UNAVAILABLE로 저장하려 한다
    await fraudStore.saveResults(approvalId, [{ ticketId, outcome: 'FAILED', failureCode: 'TICKET_UNAVAILABLE', expectedHolderAccountId: w.payerId }], NOW + 1_000);
    const row = await admin.pool.query('select outcome, cancellation_id, refund_amount, failure_code from fraud_cancellation_ticket where approval_id = $1 and ticket_id = $2', [approvalId, ticketId]);
    expect(row.rows).toEqual([{ outcome: 'ACCEPTED', cancellation_id: cancellationId, refund_amount: PRICE, failure_code: null }]);
    const got = await get.execute(approvalId);
    expect(got.results).toEqual([{ ticketId, outcome: 'ACCEPTED', cancellationId, refundAmount: PRICE }]);
    expect(got.refunds).toEqual([{ ticketId, cancellationId, state: 'PENDING' }]);

    // FAILED였던 표는 다시 부르기가 마친 결과로 덮어 쓴다
    const other = randomUUID();
    await fraudStore.saveResults(approvalId, [{ ticketId: other, outcome: 'FAILED', failureCode: 'SEAT_RETURN_FAILED', expectedHolderAccountId: w.payerId }], NOW + 2_000);
    await fraudStore.saveResults(approvalId, [{ ticketId: other, outcome: 'SKIPPED_HOLDER_CHANGED', expectedHolderAccountId: w.payerId }], NOW + 3_000);
    expect((await admin.pool.query('select outcome, failure_code from fraud_cancellation_ticket where approval_id = $1 and ticket_id = $2', [approvalId, other])).rows).toEqual([
      { outcome: 'SKIPPED_HOLDER_CHANGED', failure_code: null },
    ]);
  });
});

// ---- 다시 보기 R2(계획 §11 보충 3, 78d8dbd8, docs/features/transfer-refund.md §7.4 '결과 저장'): FAILED끼리 덮어쓰기 차례 ----
describe('GAT-080 F21 FAILED끼리의 저장 차례 [실제 DB]', () => {
  test('GAT-080 F21 FAILED끼리는 티켓 단계 뒤 까닭을 모르는 까닭으로 덮지 않는다(TICKET_UNAVAILABLE·INTERNAL은 못 덮고, ORDER_STATE는 덮고, 반대 차례는 바뀐다)', async () => {
    const w = await world(1);
    const approvalId = randomUUID();
    await unary('CancelFraudTickets', requestOf(w, approvalId, randomUUID(), []));
    const outcomeOf = async (ticketId: string) =>
      (await admin.pool.query('select outcome, failure_code from fraud_cancellation_ticket where approval_id = $1 and ticket_id = $2', [approvalId, ticketId])).rows[0] as { outcome: string; failure_code: string | null };
    const save = (ticketId: string, failureCode: string, atMs: number) =>
      fraudStore.saveResults(approvalId, [{ ticketId, outcome: 'FAILED', failureCode: failureCode as never, expectedHolderAccountId: w.payerId }], atMs);

    const t = randomUUID();
    await save(t, 'SEAT_RETURN_FAILED', NOW + 1_000);
    await save(t, 'TICKET_UNAVAILABLE', NOW + 2_000);
    expect(await outcomeOf(t)).toEqual({ outcome: 'FAILED', failure_code: 'SEAT_RETURN_FAILED' });
    await save(t, 'INTERNAL', NOW + 3_000);
    expect(await outcomeOf(t)).toEqual({ outcome: 'FAILED', failure_code: 'SEAT_RETURN_FAILED' });
    await save(t, 'ORDER_STATE', NOW + 4_000);
    expect(await outcomeOf(t)).toEqual({ outcome: 'FAILED', failure_code: 'ORDER_STATE' });

    const u = randomUUID();
    await save(u, 'TICKET_UNAVAILABLE', NOW + 1_000);
    await save(u, 'SEAT_RETURN_FAILED', NOW + 2_000);
    expect(await outcomeOf(u)).toEqual({ outcome: 'FAILED', failure_code: 'SEAT_RETURN_FAILED' });
    await save(u, 'INTERNAL', NOW + 3_000);
    expect(await outcomeOf(u)).toEqual({ outcome: 'FAILED', failure_code: 'SEAT_RETURN_FAILED' });

    const v = randomUUID();
    await save(v, 'TICKET_UNAVAILABLE', NOW + 1_000);
    await save(v, 'INTERNAL', NOW + 2_000);
    expect(await outcomeOf(v)).toEqual({ outcome: 'FAILED', failure_code: 'INTERNAL' });
  });

  test('GAT-080 F21 좌석 되돌리기가 실패한 표에 늦은 TICKET_UNAVAILABLE 저장이 와도 까닭이 남아, 마감 뒤 다시 부르기가 그 표의 나머지를 마친다', async () => {
    const w = await world(1);
    const approvalId = randomUUID();
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
    const flaky = new CancelFraudTickets({ store: fraudStore, tickets: ticketCancels!, orders: new DrizzleCancellationOrders(purchaseDb, seatMap), configs: seatMap, writes, calendar, seats });
    const input = (nowMs: number) => ({
      approvalId,
      fraudCaseId: '0193a000-0000-7000-8000-0000000000d1',
      eventId: w.eventId,
      targets: [{ ticketId: w.tickets[0]!.ticketId, expectedHolderAccountId: w.payerId }],
      requestedBy: 'investigator-1',
      approvedBy: APPROVED_BY,
      nowMs,
      deadlineMs: 5_000,
    });
    const ticketId = w.tickets[0]!.ticketId;
    expect((await flaky.execute(input(NOW))).map((r) => [r.outcome, r.failureCode])).toEqual([['FAILED', 'SEAT_RETURN_FAILED']]);
    expect(failures).toBe(1);
    // 겹친 호출이 그 표를 ticket-svc 실패로 늦게 저장하려 한다
    await fraudStore.saveResults(approvalId, [{ ticketId, outcome: 'FAILED', failureCode: 'TICKET_UNAVAILABLE', expectedHolderAccountId: w.payerId }], NOW + 1_000);
    // 마감(판매 종료 − 2시간 = 2026-11-19 17:00) 정각에 다시 부르면 티켓 단계 뒤 실패의 나머지를 마친다(F20 (가)와 같은 끝)
    const late = await flaky.execute(input(kst('2026-11-19T17:00:00')));
    expect(late).toEqual([{ ticketId, outcome: 'ACCEPTED', cancellationId: fraudCancellationId(approvalId, ticketId), refundAmount: PRICE }]);
    expect((await admin.pool.query('select count(*)::int as n from order_cancellation where ticket_id = $1', [ticketId])).rows[0].n).toBe(1);
  });
});
