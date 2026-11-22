// 보상 세 걸음의 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-011, PRF-173, P-T39 ③).
// 정본: docs/features/payment.md §3 '승인 뒤 발권', specs/payment.qnt `compStart`·`compFence`·`compCancel`,
// docs/adr/0354-prf-173-split-compensation-fence.md 결정 3·4, docs/features/transfer-refund.md §5 '발권 대기 주문',
// docs/data.md `order_compensation`(0032_order_compensation.sql)·`ticket_issue_guard`(ticket 0011).
// 실제 PostgreSQL 18(purchase·ticket 두 DB), 실제 ticket-svc gRPC(BlockTicketIssuance), 실제 purchase 코드(보상 쓰임새·주문 전이·발권 큐)로 돈다.
// 결제 취소만 payment-svc gRPC 대역이다: 부른 요청의 payment_id·cancellation_id와 답(UNKNOWN→CANCELLED)을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { migrateTicket } from '../../ticket-svc/scripts/migrate.mjs';
import { startGrpcServer } from '../../ticket-svc/src/grpc-server.js';
import { DrizzleTicketStore, TicketService } from '../../ticket-svc/src/modules/ticket/index.js';
import { ticketPackage, ticketServiceHandlers } from '../../ticket-svc/src/modules/ticket/inbound/ticket.grpc.js';
import {
  CancelCompensation,
  DrizzleCompensation,
  DrizzleOrderStore,
  DrizzleTicketIssue,
  EventCompensationQueue,
  FenceCompensation,
  StartCompensation,
  TICKET_ISSUE_ACTOR,
  type TicketIssueCompleteOutcome,
} from '../src/modules/booking/index.js';
import {
  DrizzleEventOpenOrders,
  EventRefundService,
  MemoryEventRefundStore,
  type EventRefundCanceller,
  type EventRefundTargets,
} from '../src/modules/refund/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const PRICE = 10_000;
const clock = fakeClock({ now: NOW });

let pgc: PostgresContainer | undefined;
let purchaseDb: Database;
let ticketDb: Database;
let ticketServer: { port: number; close(): Promise<void> } | undefined;
let ticketClient: TicketClient;

interface TicketClient {
  IssueTickets(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
  BlockTicketIssuance(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: any) => void): void;
}

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
  purchaseDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'compensation-int-purchase' });
  ticketDb = createDatabase({ url: ticketUrl, profile: 'general', max: 6, applicationName: 'compensation-int-ticket' });
  await ensureOutboxPartitions(purchaseDb, clock);
  const ticket = new TicketService({ store: new DrizzleTicketStore({ database: ticketDb }), clock });
  ticketServer = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket, nowMs: () => NOW }, () => {}) }],
  });
  ticketClient = new (ticketPackage().TicketService)(`127.0.0.1:${ticketServer.port}`, grpc.credentials.createInsecure()) as unknown as TicketClient;
}, 180_000);

afterAll(async () => {
  await ticketServer?.close();
  await Promise.allSettled([purchaseDb?.close(), ticketDb?.close()]);
  pgc?.stop();
});

/** gRPC 한 번(성공·실패 모두 약속으로) */
const call = <T>(fn: (cb: (err: grpc.ServiceError | null, res: any) => void) => void): Promise<T> => new Promise((res, rej) => fn((err, r) => (err ? rej(err) : res(r as T))));

async function issueTicket(orderId: string, seatId: string): Promise<string> {
  const out = await call<{ tickets: Array<{ ticket_id: string }> }>((cb) =>
    ticketClient.IssueTickets({ order_id: orderId, event_id: ORDER_EVENT.get(orderId)!, payer_account_id: ORDER_ACCOUNT.get(orderId)!, seat_ids: [seatId], issue_generation: 0 }, cb),
  );
  return out.tickets[0]!.ticket_id;
}

const ORDER_EVENT = new Map<string, string>();
const ORDER_ACCOUNT = new Map<string, string>();

interface Fixture {
  orderId: string;
  eventId: string;
  accountId: string;
  seatId: string;
  paymentId: string;
}

/** 결제 승인(APPROVED) 주문 하나와 발권 재시도 큐 한 줄(승인 뒤 발권 전). 결제 원장은 payment-svc 몫이라 여기서 만들지 않는다 */
async function approvedOrder(o: { readonly eventId?: string; readonly status?: 'APPROVED' | 'AWAITING_DEPOSIT' } = {}): Promise<Fixture> {
  const orderId = randomUUID();
  const eventId = o.eventId ?? randomUUID();
  const status = o.status ?? 'APPROVED';
  const accountId = randomUUID();
  const seatId = randomUUID();
  const paymentId = randomUUID();
  ORDER_EVENT.set(orderId, eventId);
  ORDER_ACCOUNT.set(orderId, accountId);
  const client = await purchaseDb.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, $8, $4, 1, $5, 'v1', 'PICK', $6, $7, 'ps-compensation')`,
      [orderId, accountId, eventId, PRICE, randomUUID(), new Date(NOW - 60_000), randomUUID(), status],
    );
    await client.query("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, $3, $4, 'test', $2)", [
      orderId,
      new Date(NOW - 60_000),
      status,
      status === 'APPROVED' ? 'T9' : 'T5',
    ]);
    await client.query("insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) values ($1, 1, $2, 'R', 'A', $3)", [orderId, seatId, PRICE]);
    await client.query("insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $2, 'TOSS', 'ACCEPTED', $3)", [paymentId, orderId, new Date(NOW - 60_000)]);
    await client.query(
      `insert into ticket_issue_job (order_id, event_id, attempts, next_attempt_at, issue_due_at, created_at)
       values ($1, $2, 0, $3, $4, $3)`,
      [orderId, eventId, new Date(NOW), new Date(NOW + 30 * 60_000)],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { orderId, eventId, accountId, seatId, paymentId };
}

interface PaymentCall {
  readonly orderId?: string;
  readonly paymentId?: string;
  readonly cancellationId: string;
  readonly reason?: string;
}
const paymentCalls: PaymentCall[] = [];
let paymentOutcome: 'CANCELLED' | 'UNKNOWN' | 'REJECTED' = 'CANCELLED';
/** 결제 취소 포트 대역(payment-svc gRPC CancelPayment 자리). 답 이름은 payment.proto CancelResult의 접두어를 뗀 값이다 */
const payments = {
  cancel: async (q: PaymentCall & { readonly deadlineMs?: number }) => {
    paymentCalls.push(q);
    return paymentOutcome;
  },
};
const fenceCalls: string[] = [];
/** 발권 막기 포트 대역. 실제 ticket-svc BlockTicketIssuance를 부른다(생산 어댑터와 같은 계약) */
const fence = {
  block: async (q: { readonly orderId: string } | string) => {
    const orderId = typeof q === 'string' ? q : q.orderId;
    fenceCalls.push(orderId);
    const out = await call<{ already_entered: number }>((cb) => ticketClient.BlockTicketIssuance({ order_id: orderId, reason: 'EVENT_CANCELLED' }, cb));
    return { blocked: true, alreadyEntered: out.already_entered, already_entered: out.already_entered };
  },
};

/** 보상 쓰임새를 실제 저장소·대역과 묶는다(시작 파일 조립의 최소판). 실행 코드의 공개 면만 쓴다 */
function compensation() {
  const store = new DrizzleCompensation({ database: purchaseDb });
  const orders = new DrizzleOrderStore({ clock });
  const deps = { store, compensations: store, compensationStore: store, orders, orderStore: orders, clock, nowMs: () => NOW, database: purchaseDb, db: purchaseDb };
  return {
    store,
    start: new StartCompensation({ ...deps, fence } as never),
    fence: new FenceCompensation({ ...deps, fence, ticketFence: fence, tickets: fence } as never),
    cancel: new CancelCompensation({ ...deps, payments, paymentCancels: payments, paymentCancel: payments } as never),
  };
}

const startInput = (f: Fixture, requestId: string) => ({
  orderId: f.orderId,
  eventId: f.eventId,
  paymentId: f.paymentId,
  reason: 'EVENT_CANCELLED',
  cause: 'EVENT_CANCELLED',
  eventCancellationRequestId: requestId,
  requestId,
});

const orderRow = async (orderId: string) => (await purchaseDb.pool.query<{ status: string; event_seq: number }>('select status, event_seq from purchase_order where id = $1', [orderId])).rows[0]!;
const compensationRow = async (orderId: string) =>
  (await purchaseDb.pool.query<{ status: string; reason: string; payment_id: string | null; attempts: number }>('select status, reason, payment_id, attempts from order_compensation where order_id = $1', [orderId])).rows[0];
const jobRows = async (orderId: string) => (await purchaseDb.pool.query('select 1 from ticket_issue_job where order_id = $1', [orderId])).rows;
const t20Rows = async (orderId: string) =>
  (await purchaseDb.pool.query("select 1 from order_event where order_id = $1 and cause = 'T20' and to_status = 'COMPENSATED'", [orderId])).rows;

test('P-T39 ③_회차_취소_확정은_APPROVED_주문의_큐_행을_지우고_order_compensation을_STARTED로_만든다', async () => {
  const f = await approvedOrder();
  const requestId = randomUUID();
  const c = compensation();

  await c.start.run(startInput(f, requestId));

  expect(await jobRows(f.orderId)).toEqual([]);
  const row = await compensationRow(f.orderId);
  expect(row).toMatchObject({ status: 'STARTED', reason: 'EVENT_CANCELLED', payment_id: f.paymentId });
  // 결제 취소 전에는 주문을 바꾸지 않는다(T20은 compCancel이 끝낸 뒤 한 번)
  expect(await orderRow(f.orderId)).toEqual({ status: 'APPROVED', event_seq: 1 });
  expect(await t20Rows(f.orderId)).toEqual([]);
});

test('P-T39 ③_compFence가_발권을_막은_뒤에만_compCancel이_결제를_취소하고_주문은_한_번만_COMPENSATED가_된다', async () => {
  const f = await approvedOrder();
  const requestId = randomUUID();
  const ticketId = await issueTicket(f.orderId, f.seatId);
  const c = compensation();

  await c.start.run(startInput(f, requestId));
  expect(await compensationRow(f.orderId)).toMatchObject({ status: 'STARTED' });
  expect((await ticketDb.pool.query('select status from ticket where id = $1', [ticketId])).rows[0].status).toBe('ISSUED');

  await c.fence.run({ orderId: f.orderId });
  expect(fenceCalls).toEqual([f.orderId]);
  expect(await compensationRow(f.orderId)).toMatchObject({ status: 'FENCED' });
  // 막은 뒤 티켓은 폐기·키 폐기되고, 결제 취소 전이라 주문은 아직 APPROVED다
  expect((await ticketDb.pool.query('select status, key_revoked_at from ticket where id = $1', [ticketId])).rows[0]).toMatchObject({ status: 'VOIDED' });
  expect((await ticketDb.pool.query('select key_revoked_at from ticket where id = $1', [ticketId])).rows[0].key_revoked_at).not.toBeNull();
  expect(await orderRow(f.orderId)).toEqual({ status: 'APPROVED', event_seq: 1 });

  paymentOutcome = 'CANCELLED';
  paymentCalls.length = 0;
  await c.cancel.run({ orderId: f.orderId });
  expect(paymentCalls).toHaveLength(1);
  // ADR-0354 결정 4: `compensation:{orderId}`의 UUIDv8 고정 취소 ID와 그 주문의 APPROVED 결제 ID
  expect(paymentCalls[0]).toMatchObject({ paymentId: f.paymentId, cancellationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
  expect(paymentCalls[0]!.cancellationId).toBe(await compensationCancellationIdOf(f.orderId));
  expect(await compensationRow(f.orderId)).toMatchObject({ status: 'COMPENSATED' });
  expect(await orderRow(f.orderId)).toEqual({ status: 'COMPENSATED', event_seq: 2 });
  expect(await t20Rows(f.orderId)).toHaveLength(1);

  // 다시 돌아도 같은 취소 ID이고 T20은 한 번뿐이다(이중 환급 0)
  await c.cancel.run({ orderId: f.orderId });
  expect(paymentCalls.map((x) => x.cancellationId)).toEqual([paymentCalls[0]!.cancellationId, paymentCalls[0]!.cancellationId]);
  expect(await t20Rows(f.orderId)).toHaveLength(1);
});

test('P-T39 ③_보상_뒤에_늦게_온_발권_성공_답은_티켓을_남기지_않고_주문도_바꾸지_않는다', async () => {
  const f = await approvedOrder();
  const requestId = randomUUID();
  const c = compensation();
  const lateTicketId = await issueTicket(f.orderId, f.seatId);

  await c.start.run(startInput(f, requestId));
  await c.fence.run({ orderId: f.orderId });

  // 막은 뒤(결제 취소 전) 같은 주문의 발권은 FAILED_PRECONDITION이고 새 티켓이 생기지 않는다(compFence)
  await expect(
    call((cb) => ticketClient.IssueTickets({ order_id: f.orderId, event_id: f.eventId, payer_account_id: f.accountId, seat_ids: [f.seatId], issue_generation: 0 }, cb)),
  ).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
  expect((await ticketDb.pool.query("select 1 from ticket where order_id = $1 and status in ('ISSUED', 'ACTIVE')", [f.orderId])).rows).toEqual([]);

  paymentOutcome = 'CANCELLED';
  await c.cancel.run({ orderId: f.orderId });
  expect(await orderRow(f.orderId)).toEqual({ status: 'COMPENSATED', event_seq: 2 });

  // 늦게 도착한 성공 답(발권 큐의 complete)은 주문이 APPROVED가 아니어서 상태를 바꾸지 않는다(STALE 또는 큐 행이 이미 없어 LEASE_LOST)
  const jobs = new DrizzleTicketIssue({ database: purchaseDb, store: new DrizzleOrderStore({ clock }), clock });
  const late: TicketIssueCompleteOutcome = await jobs.complete({
    orderId: f.orderId,
    tickets: [{ seatId: f.seatId, ticketId: lateTicketId, status: 'ISSUED' }],
    actor: TICKET_ISSUE_ACTOR,
    leaseUntilMs: NOW - 1,
  });
  expect(['STALE', 'LEASE_LOST']).toContain(late.status);
  expect(await orderRow(f.orderId)).toEqual({ status: 'COMPENSATED', event_seq: 2 });
  expect(await t20Rows(f.orderId)).toHaveLength(1);
});

test('P-T39 ③_회차_취소_요청은_보상이_끝날_때까지_RUNNING이고_끝나면_COMPLETED다', async () => {
  const f = await approvedOrder();
  const requestId = randomUUID();
  const store = new MemoryEventRefundStore();
  const service = new EventRefundService({
    store,
    targets: { list: async () => [] } as unknown as EventRefundTargets,
    canceller: { cancel: async () => { throw new Error('대상 표가 없어 결제사 취소를 부르지 않는다'); } } as unknown as EventRefundCanceller,
    items: store,
    openOrders: new DrizzleEventOpenOrders(purchaseDb),
    nowMs: () => NOW,
    deadlineMs: () => NOW + 30_000,
  });
  const request = await service.start({ requestId, eventId: f.eventId, fault: 'ORGANIZER', ruledBy: 'admin:test-ruler', confirmedBy: 'admin:test-confirmer', kind: 'CANCEL' });
  expect(request.status).toBe('RUNNING');
  expect(await service.runDue()).toBeDefined();
  expect((await service.get(requestId)).status).toBe('RUNNING');

  const c = compensation();
  await c.start.run(startInput(f, requestId));
  await service.runDue();
  expect((await service.get(requestId)).status).toBe('RUNNING');
  await c.fence.run({ orderId: f.orderId });
  await service.runDue();
  expect((await service.get(requestId)).status).toBe('RUNNING');
  paymentOutcome = 'CANCELLED';
  await c.cancel.run({ orderId: f.orderId });
  await service.runDue();
  expect((await service.get(requestId)).status).toBe('COMPLETED');
});

test('P-T39 ③_보상_사유가_없으면_보상을_시작하지_않는다', async () => {
  const f = await approvedOrder();
  const c = compensation();
  await expect(c.start.run({ orderId: f.orderId })).rejects.toBeDefined();
  expect(await compensationRow(f.orderId)).toBeUndefined();
  expect(await jobRows(f.orderId)).toHaveLength(1);
  expect(await orderRow(f.orderId)).toEqual({ status: 'APPROVED', event_seq: 1 });
});

test('P-T39 ③_compFence가_실패하면_결제_취소를_부르지_않고_재시도한다', async () => {
  const f = await approvedOrder();
  const requestId = randomUUID();
  const c = compensation();
  await c.start.run(startInput(f, requestId));
  const before = await compensationRow(f.orderId);
  // 발권 막기 대역이 실패한다(일시 장애). 결제 취소는 부르지 않고 보상 행은 FENCED로 넘어가지 않는다
  const failing = { block: async () => { throw new Error('ticket-svc UNAVAILABLE'); } };
  const fenceStep = new FenceCompensation({ store: c.store, fence: failing, ticketFence: failing, tickets: failing, clock, nowMs: () => NOW } as never);
  await expect(fenceStep.run({ orderId: f.orderId })).rejects.toBeDefined();
  paymentCalls.length = 0;
  await expect(c.cancel.run({ orderId: f.orderId })).rejects.toBeDefined();
  expect(paymentCalls).toEqual([]);
  expect((await compensationRow(f.orderId))?.status).toBe(before?.status);
  expect(await orderRow(f.orderId)).toEqual({ status: 'APPROVED', event_seq: 1 });
  expect(await t20Rows(f.orderId)).toEqual([]);
});

test('P-T39 ③_compCancel의_첫_답이_UNKNOWN이면_같은_취소_ID로_다시_불러_CANCELLED를_받고_COMPENSATED는_한_번만_된다', async () => {
  const f = await approvedOrder();
  const requestId = randomUUID();
  const c = compensation();
  await c.start.run(startInput(f, requestId));
  await c.fence.run({ orderId: f.orderId });

  paymentOutcome = 'UNKNOWN';
  paymentCalls.length = 0;
  await c.cancel.run({ orderId: f.orderId });
  expect(await compensationRow(f.orderId)).toMatchObject({ status: 'FENCED' });
  expect(await orderRow(f.orderId)).toEqual({ status: 'APPROVED', event_seq: 1 });

  paymentOutcome = 'CANCELLED';
  await c.cancel.run({ orderId: f.orderId });
  expect(paymentCalls).toHaveLength(2);
  expect(paymentCalls[0]!.cancellationId).toBe(paymentCalls[1]!.cancellationId);
  expect(await compensationRow(f.orderId)).toMatchObject({ status: 'COMPENSATED' });
  expect(await t20Rows(f.orderId)).toHaveLength(1);
});

test('P-T39 ③_RV-02_임대를_잃은_실행기는_보상을_끝내지_못한다', async () => {
  const f = await approvedOrder();
  const c = compensation();
  // start → claimDue(임대 30초) → fenced. 그 뒤 옛 임대(stale)로 compensated를 부르면 T20을 쓰지 않아야 한다
  await c.store.start({ orderId: f.orderId, reason: 'EVENT_CANCELLED', nowMs: NOW });
  const claimed = (await c.store.claimDue(50, 30_000, NOW)).find((r) => r.orderId === f.orderId);
  expect(claimed?.orderId).toBe(f.orderId);
  expect(await c.store.fenced({ orderId: f.orderId, nowMs: NOW + 1, leaseUntilMs: claimed!.leaseUntilMs })).toBe(true);
  const out = await c.store.compensated({ orderId: f.orderId, nowMs: NOW + 2, leaseUntilMs: NOW - 1 });
  expect(out).toEqual({ status: 'LEASE_LOST' });
  expect(await compensationRow(f.orderId)).toMatchObject({ status: 'FENCED' });
  expect(await orderRow(f.orderId)).toEqual({ status: 'APPROVED', event_seq: 1 });
  expect(await t20Rows(f.orderId)).toEqual([]);
});

test('P-T39 ③_RV-03_회차_취소_실행기는_APPROVED_발권_대기_주문을_보상_큐에_넣고_중복_없이_RUNNING을_유지한다', async () => {
  const eventId = randomUUID();
  const f1 = await approvedOrder({ eventId });
  const f2 = await approvedOrder({ eventId });
  const queueStore = new DrizzleCompensation({ database: purchaseDb });
  const queue = new EventCompensationQueue({ jobs: queueStore, start: new StartCompensation({ store: queueStore, clock, nowMs: () => NOW }) });
  const mem = new MemoryEventRefundStore();
  const service = new EventRefundService({
    store: mem,
    targets: { list: async () => [] } as unknown as EventRefundTargets,
    canceller: { cancel: async () => { throw new Error('대상 표가 없어 결제사 취소를 부르지 않는다'); } } as unknown as EventRefundCanceller,
    items: mem,
    openOrders: new DrizzleEventOpenOrders(purchaseDb),
    compensation: queue,
    log: { warn: () => undefined, info: () => undefined },
    nowMs: () => NOW,
    deadlineMs: () => NOW + 30_000,
  });
  const requestId = randomUUID();
  const request = await service.start({ requestId, eventId, fault: 'ORGANIZER', ruledBy: 'admin:test-ruler', confirmedBy: 'admin:test-confirmer', kind: 'CANCEL' });
  expect(request.status).toBe('RUNNING');
  expect(await compensationRow(f1.orderId)).toMatchObject({ status: 'STARTED' });
  expect(await compensationRow(f2.orderId)).toMatchObject({ status: 'STARTED' });
  expect(await jobRows(f1.orderId)).toEqual([]);
  expect(await jobRows(f2.orderId)).toEqual([]);

  // runDue가 다시 불러도 같은 주문을 두 번 넣지 않는다(candidates의 NOT EXISTS)
  await service.runDue();
  expect(await queue.queue(eventId)).toBe(0);
  expect((await purchaseDb.pool.query('select count(*)::int as n from order_compensation where order_id = any($1::uuid[])', [[f1.orderId, f2.orderId]])).rows[0].n).toBe(2);

  // PAUSED 요청도 실행기 틱이 큐에 넣는다. 그 뒤 확정 주문을 모두 보상해야 COMPLETED가 된다
  const f3 = await approvedOrder({ eventId });
  await service.pause({ requestId, reason: 'RV-03 확인' });
  await service.runDue();
  expect(await compensationRow(f3.orderId)).toMatchObject({ status: 'STARTED' });
  expect(await queue.queue(eventId)).toBe(0);

  const c = compensation();
  paymentOutcome = 'CANCELLED';
  paymentCalls.length = 0;
  for (const f of [f1, f2, f3]) {
    await c.fence.run({ orderId: f.orderId });
    await c.cancel.run({ orderId: f.orderId });
  }
  await service.resume({ requestId });
  await service.runDue();
  expect((await service.get(requestId)).status).toBe('COMPLETED');

  // 입금 대기(AWAITING_DEPOSIT) 주문은 candidates에 들지 않는다(보상은 승인 뒤 발권 대기만)
  const depositEventId = randomUUID();
  const deposit = await approvedOrder({ eventId: depositEventId, status: 'AWAITING_DEPOSIT' });
  const depositRequestId = randomUUID();
  const depositService = new EventRefundService({
    store: new MemoryEventRefundStore(),
    targets: { list: async () => [] } as unknown as EventRefundTargets,
    canceller: { cancel: async () => { throw new Error('대상 표가 없어 결제사 취소를 부르지 않는다'); } } as unknown as EventRefundCanceller,
    items: new MemoryEventRefundStore(),
    openOrders: new DrizzleEventOpenOrders(purchaseDb),
    compensation: queue,
    nowMs: () => NOW,
    deadlineMs: () => NOW + 30_000,
  });
  await depositService.start({ requestId: depositRequestId, eventId: depositEventId, fault: 'ORGANIZER', ruledBy: 'admin:test-ruler', confirmedBy: 'admin:test-confirmer', kind: 'CANCEL' });
  expect(await compensationRow(deposit.orderId)).toBeUndefined();
  expect(await jobRows(deposit.orderId)).toHaveLength(1);
  expect(await queue.queue(depositEventId)).toBe(0);
});

/** 시험에서 정본 식(SHA-256('compensation:' + 주문 ID) → UUIDv8)을 직접 계산한다 */
async function compensationCancellationIdOf(orderId: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const b = Buffer.from(createHash('sha256').update(`compensation:${orderId}`).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
