// 탈퇴 참여자(purchase-svc WithdrawalParticipantService.ProcessAccountWithdrawal·QuoteAccountWithdrawal)를 실제 PostgreSQL 18과
// 실제 ticket-svc·payment-svc gRPC(운영 처리기·저장소)로 돈다.
// 정본: docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현' '미사용 티켓 견적' '미사용 티켓 취소'·§11 P-T55·I-T26, §6 '입금 전 취소와 입금 오류 되돌림의 첫 구현'(CancelPayment 쪽),
// docs/features/identity.md §8 '미사용 티켓 확인과 취소', ADR-0284, docs/data.md §5.1 '탈퇴 참여자의 계정 주문 찾기',
// docs/api/proto/peaket/purchase/v1/account.proto(BAT-010·BAT-013 시험 담당).
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 purchase·payment는 서로 다른 데이터베이스다. 계정·주문·결제 ID는 시험마다 새 UUID라 서로 닿지 않는다.
// - payment-svc는 운영 처리기(CancelPayment 갈래 고르기·CancelDepositPayment·CancelConfirmedPayment·GetPaymentDetail)와 저장소(DrizzleConfirmJobs·DrizzlePaymentStore)를
//   start.ts와 같은 조립으로 띄운다. 결제사만 기록 대역이고(취소 요청의 멱등키·사유를 적는다), 결제사 호출 보호기(서킷·토큰)는 늘 열어 둔다.
// - purchase 쪽은 운영 받는 층(withdrawalParticipantHandlers)·쓰임새(ProcessAccountWithdrawal)·저장소(DrizzleWithdrawalOrders)·일반 취소 어댑터(GrpcPaymentCancellations)다.
//   답 유실과 payment-svc 멈춤은 그 어댑터 앞에 끼운 전환기로 만든다(시험의 장애 주입).
// - gRPC 데드라인이 벽시계라 시계는 systemClock이다. Kafka는 쓰지 않는다.
// - 값은 정본에서 적는다: 취소 ID withdrawal-{주문 ID}, 결제사 멱등키 cancel-withdrawal-{주문 ID}, 사유 ACCOUNT_WITHDRAWAL. 코드 상수를 가져오지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migratePayment } from '../../payment-svc/scripts/migrate.mjs';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../../payment-svc/src/modules/payment/domain/payment-gateway.js';
import {
  CancelConfirmedPayment,
  CancelDepositPayment,
  CancelPayment,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  GetPaymentDetail,
  NoKeyVirtualAccountCipher,
  paymentPackage,
  paymentServiceHandlers,
} from '../../payment-svc/src/modules/payment/server.js';
import { startGrpcServer } from '../../ticket-svc/src/grpc-server.js';
import { DrizzleTicketStore } from '../../ticket-svc/src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { TicketService } from '../../ticket-svc/src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../../ticket-svc/src/modules/ticket/inbound/ticket.grpc.js';
import { migrateTicket } from '../../ticket-svc/scripts/migrate.mjs';
import { GrpcWithdrawalParticipant } from '../../identity-svc/src/modules/session/adapters/grpc-withdrawal-participants.js';
import { DrizzleOrderStore, DrizzleWithdrawalOrders, ProcessAccountWithdrawal, QuoteAccountWithdrawal, type WithdrawalDepositCancellations, type WithdrawalOrder, withdrawalParticipantHandlers } from '../src/modules/booking/index.js';
import {
  AccountWithdrawalTickets,
  CancelTicket,
  DrizzleCancellationOrders,
  DrizzleCancellationWrites,
  DrizzleWithdrawalTickets,
  GrpcPaymentCancellations,
  GrpcTicketCancellations,
  type CancellationConfigs,
  RefundAfterEntry,
  type SeatReturns,
  WeekendBusinessCalendar,
  withdrawalTicketCancellationId,
} from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';

const TOKEN = 'bat010-withdrawal-internal-token';
const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { WithdrawalParticipantService: grpc.ServiceClientConstructor };
const accountPkg = (() => {
  const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
})();
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
type Client = grpc.Client & { ProcessAccountWithdrawal: Unary; QuoteAccountWithdrawal: Unary };

// ---- 결제사 대역 ----
type Mode = 'CANCEL' | 'CANCEL_PENDING' | 'UNKNOWN' | 'DEPOSITED' | 'LOSE_AFTER_CANCEL';
interface GatewayCancel {
  paymentRef: string;
  idemKey: string;
  reason: string;
  amount: number | 'ALL';
}
/** 결제사가 받은 취소 요청(차례대로) */
const gatewayCancels: GatewayCancel[] = [];
/** 결제사 쪽에서 실제로 취소된 결제(결제 참조) */
const gatewayCanceled = new Set<string>();
const modes = new Map<string, Mode>();
/** 결제 참조 → 주문 ID·금액 */
const refs = new Map<string, { orderId: string; amount: number }>();
/** 결제 참조마다 '답 유실'을 이미 한 번 했는지 */
const lostOnce = new Set<string>();

const gateway = {
  pg: 'TOSS',
  cancel: async (c: { paymentRef: string; amount: number | 'ALL'; reason: string; idemKey: string }): Promise<CancelResult> => {
    gatewayCancels.push({ paymentRef: c.paymentRef, idemKey: c.idemKey, reason: c.reason, amount: c.amount });
    const mode = modes.get(c.paymentRef) ?? 'CANCEL';
    if (mode === 'CANCEL_PENDING') return { outcome: 'CANCEL_PENDING' } as CancelResult;
    if (mode === 'UNKNOWN') return { outcome: 'UNKNOWN' } as CancelResult;
    if (mode === 'DEPOSITED') return { outcome: 'REJECTED' } as CancelResult;
    gatewayCanceled.add(c.paymentRef);
    if (mode === 'LOSE_AFTER_CANCEL' && !lostOnce.has(c.paymentRef)) {
      lostOnce.add(c.paymentRef);
      throw new Error('결제사가 취소한 뒤 답을 잃었다(주입)');
    }
    return { outcome: 'CANCELLED' } as CancelResult;
  },
  query: async (paymentRef: string): Promise<QueryResult> => {
    const r = refs.get(paymentRef);
    if (!r) return { kind: 'NOT_FOUND' };
    const mode = modes.get(paymentRef) ?? 'CANCEL';
    // 답을 잃은 첫 호출 뒤의 조회도 답하지 못한다(결과 모름)
    if (mode === 'LOSE_AFTER_CANCEL' && lostOnce.has(paymentRef) && gatewayCancels.filter((x) => x.paymentRef === paymentRef).length === 1) return { kind: 'UNKNOWN' };
    if (mode === 'UNKNOWN') return { kind: 'UNKNOWN' };
    const status = mode === 'DEPOSITED' ? 'APPROVED' : gatewayCanceled.has(paymentRef) ? 'CANCELED' : 'WAITING_FOR_DEPOSIT';
    return { kind: 'FOUND', paymentRef, orderRef: r.orderId, status, amount: r.amount, balanceAmount: r.amount } as QueryResult;
  },
} as unknown as PaymentGatewayPort;
const openGuard = { circuitClosed: () => true, tryTakeToken: () => true, admitsQuery: () => true, run: <T>(fn: () => Promise<T>) => fn() };

// ---- 조립 ----
let pgc: PostgresContainer | undefined;
let purchaseDb: Database;
let paymentDb: Database;
let ticketDb: Database;
let admin: Database;
let payAdmin: Database;
let ticketAdmin: Database;
let deadDb: Database;
let paymentServer: grpc.Server;
let purchaseServer: grpc.Server;
let brokenServer: grpc.Server;
let ticketServer: { port: number; close(): Promise<void> } | undefined;
let client: Client;
let brokenClient: Client;
let paymentAddress: string;
let purchaseAddress: string;
let realCancels: GrpcPaymentCancellations;
let deadCancels: GrpcPaymentCancellations;
let ticketCancels: GrpcTicketCancellations;
let ticketService: TicketService;
/** 회차 판매 설정(공연 시작 = 판매 종료 + 24시간). 시험마다 넣는다 */
const eventConfigs = new Map<string, { saleEndsAtMs: number; entryOpensAtMs?: number }>();
const ticketConfigs: CancellationConfigs = { config: async (eventId) => eventConfigs.get(eventId) };
/** 좌석 반환 기록(운영 DrizzleSeatReturns 대신 seat_sale 행을 RETURNED로 바꾸고 부른 값을 적는다) */
const seatReturns: Array<{ eventId: string; orderId: string; seatId: string; accountId: string }> = [];
/** CancelPayment가 받은 입력(payment-svc 쪽) */
const cancelInputs: { paymentId: string; cancellationId: string; reason: string; amount?: number }[] = [];
/** purchase가 payment-svc에 보내는 길: 'real'(그대로)·'dead'(듣는 곳 없는 주소)·'lose'(payment-svc의 답을 받은 뒤 버리고 UNKNOWN) */
let route: 'real' | 'dead' | 'lose' = 'real';
/** 'lose'에서 버린 답(끊긴 사례가 실제로 있었는지 본다) */
const lostAnswers: string[] = [];
const warns: string[] = [];

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
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}
const bind = (s: grpc.Server) => new Promise<number>((res, rej) => s.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));

function purchaseService(orders: DrizzleWithdrawalOrders, tickets?: AccountWithdrawalTickets) {
  const deposits: WithdrawalDepositCancellations = {
    cancel: async (q) => {
      if (route === 'dead') return deadCancels.cancel(q);
      const r = await realCancels.cancel(q);
      if (route === 'lose') {
        lostAnswers.push(r);
        return 'UNKNOWN';
      }
      return r;
    },
  };
  return new ProcessAccountWithdrawal({ orders, deposits, ...(tickets ? { tickets } : {}), clock: systemClock, log: { warn: (obj, msg) => void warns.push(JSON.stringify({ obj, msg })) } });
}

/** 미사용 티켓 포트(실제 purchase DB·실제 ticket-svc 취소 Saga·실제 payment-svc 취소) */
function withdrawalTickets(database: Database) {
  const seats: SeatReturns = {
    returnSold: async (q) => {
      seatReturns.push({ eventId: q.eventId, orderId: q.orderId, seatId: q.seatId, accountId: q.accountId });
      const r = await admin.pool.query("update seat_sale set status = 'RETURNED' where event_id = $1 and seat_id = $2 and order_id = $3 and status = 'SOLD'", [q.eventId, q.seatId, q.orderId]);
      return r.rowCount ?? 0;
    },
  };
  const cancelTicket = new CancelTicket({
    orders: new DrizzleCancellationOrders(database, ticketConfigs),
    calendar: new WeekendBusinessCalendar(),
    tickets: ticketCancels,
    payments: realCancels,
    writes: new DrizzleCancellationWrites(database, new DrizzleOrderStore({ clock: systemClock })),
    seats,
  });
  return new AccountWithdrawalTickets({
    store: new DrizzleWithdrawalTickets(database),
    configs: ticketConfigs,
    calendar: new WeekendBusinessCalendar(),
    cancelTicket,
    log: { warn: (obj, msg) => void warns.push(JSON.stringify({ obj, msg })) },
  });
}
/** 받는 층에 견적(읽기 전용)까지 연 조립 */
function participantHandlers(database: Database) {
  const orders = new DrizzleWithdrawalOrders(database);
  const tickets = withdrawalTickets(database);
  const process = purchaseService(orders, tickets);
  return withdrawalParticipantHandlers({ run: (i) => process.run(i), quote: new QuoteAccountWithdrawal({ tickets, clock: systemClock }) }, { internalToken: TOKEN, onError: () => {} });
}

beforeAll(async () => {
  pgc = await startPostgres();
  const paymentUrl = await createNamedDatabase(pgc.url, 'payment');
  const ticketUrl = await createNamedDatabase(pgc.url, 'ticket');
  await migratePurchase(pgc.url);
  await migratePayment(paymentUrl);
  await migrateTicket(ticketUrl);
  purchaseDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'withdrawal-it-purchase' });
  paymentDb = createDatabase({ url: paymentUrl, profile: 'general', max: 8, applicationName: 'withdrawal-it-payment' });
  ticketDb = createDatabase({ url: ticketUrl, profile: 'general', max: 6, applicationName: 'withdrawal-it-ticket' });
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'withdrawal-it-admin' });
  payAdmin = createDatabase({ url: paymentUrl, profile: 'general', max: 4, applicationName: 'withdrawal-it-pay-admin' });
  ticketAdmin = createDatabase({ url: ticketUrl, profile: 'general', max: 4, applicationName: 'withdrawal-it-ticket-admin' });
  // 듣는 곳 없는 포트의 purchase DB(닿지 못함)
  deadDb = createDatabase({ url: pgc.urlFor('postgres', 'peaket-test').replace(/:(\d+)\/peaket$/, `:${await freePort()}/peaket`), profile: 'general', max: 2, applicationName: 'withdrawal-it-dead' });
  await ensureOutboxPartitions(admin, systemClock);
  await ensureOutboxPartitions(payAdmin, systemClock);

  // payment-svc(start.ts와 같은 갈래 고르기)
  const jobs = new DrizzleConfirmJobs({ database: paymentDb, clock: systemClock });
  const store = new DrizzlePaymentStore({ database: paymentDb, batchDatabase: paymentDb });
  const gateways = { of: (pgName: string) => (pgName === 'TOSS' ? gateway : undefined) } as never;
  const guards = { of: () => openGuard } as never;
  const realCancelPayment = new CancelPayment(
    new CancelDepositPayment({ store: jobs, gateways, guards, signals: { cancel: () => {} }, clock: systemClock }),
    new CancelConfirmedPayment({ store: jobs, gateways, guards, clock: systemClock }),
    jobs,
  );
  const cancelPayment = {
    execute: (input: Parameters<CancelPayment['execute']>[0], budget?: Parameters<CancelPayment['execute']>[1]) => {
      cancelInputs.push({ paymentId: input.paymentId, cancellationId: input.cancellationId, reason: input.reason, ...(input.amount === undefined ? {} : { amount: input.amount }) });
      return realCancelPayment.execute(input, budget);
    },
  };
  const getPayment = new GetPaymentDetail({
    reader: store,
    signals: { getPayment: () => {} } as never,
    cipher: new NoKeyVirtualAccountCipher(),
    depositLog: { infoMissing: () => {}, accountUnsaved: () => {}, accountUnopened: () => {} } as never,
    depositSignals: { fieldFailure: () => {} } as never,
    clock: systemClock,
  });
  paymentServer = new grpc.Server();
  paymentServer.addService(
    paymentPackage().PaymentService.service,
    paymentServiceHandlers(
      {
        accept: { execute: async () => Promise.reject(new Error('이 시험은 승인 명령을 부르지 않는다')) } as never,
        batchGet: { execute: async () => Promise.reject(new Error('이 시험은 결과 당기기를 부르지 않는다')) } as never,
        getPayment,
        cancelPayment,
      },
      () => {},
    ),
  );
  paymentAddress = `127.0.0.1:${await bind(paymentServer)}`;
  realCancels = new GrpcPaymentCancellations({ address: paymentAddress });
  deadCancels = new GrpcPaymentCancellations({ address: `127.0.0.1:${await freePort()}` });

  // 실제 ticket-svc(발권·취소 Saga의 티켓 단계)
  ticketService = new TicketService({ store: new DrizzleTicketStore({ database: ticketDb }), clock: systemClock });
  ticketServer = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: ticketService, nowMs: () => systemClock.now() }, () => {}) }],
  });
  ticketCancels = new GrpcTicketCancellations({ address: `127.0.0.1:${ticketServer.port}` });

  // purchase-svc 받는 층(내부 토큰을 설정한 운영 꼴). 견적까지 연다
  purchaseServer = new grpc.Server();
  purchaseServer.addService(accountPkg.WithdrawalParticipantService.service, participantHandlers(purchaseDb));
  purchaseAddress = `127.0.0.1:${await bind(purchaseServer)}`;
  client = new accountPkg.WithdrawalParticipantService(purchaseAddress, grpc.credentials.createInsecure()) as unknown as Client;
  brokenServer = new grpc.Server();
  brokenServer.addService(accountPkg.WithdrawalParticipantService.service, participantHandlers(deadDb));
  brokenClient = new accountPkg.WithdrawalParticipantService(`127.0.0.1:${await bind(brokenServer)}`, grpc.credentials.createInsecure()) as unknown as Client;
}, 180_000);

afterAll(async () => {
  client?.close();
  brokenClient?.close();
  realCancels?.close();
  deadCancels?.close();
  ticketCancels?.close();
  for (const s of [purchaseServer, brokenServer, paymentServer]) if (s) await new Promise<void>((r) => s.tryShutdown(() => r()));
  await ticketServer?.close();
  await Promise.allSettled([purchaseDb?.close(), paymentDb?.close(), ticketDb?.close(), admin?.close(), payAdmin?.close(), ticketAdmin?.close(), deadDb?.close()]);
  pgc?.stop();
});

beforeEach(() => {
  gatewayCancels.length = 0;
  cancelInputs.length = 0;
  lostAnswers.length = 0;
  warns.length = 0;
  seatReturns.length = 0;
  route = 'real';
});

// ---- 자료 만들기 ----
const metadata = (o: { token?: string | null; caller?: string } = {}) => {
  const m = new grpc.Metadata();
  if (o.token !== null) m.set('x-peaket-internal-grpc-token', o.token ?? TOKEN);
  m.set('x-peaket-internal-grpc-caller', o.caller ?? 'identity-svc');
  return m;
};
const call = (accountId: string, o: { md?: grpc.Metadata; deadlineMs?: number; via?: Client } = {}) =>
  new Promise<Record<string, unknown>>((res, rej) =>
    (o.via ?? client).ProcessAccountWithdrawal({ account_id: accountId }, o.md ?? metadata(), { deadline: new Date(Date.now() + (o.deadlineMs ?? 10_000)) }, (e, v) => (e ? rej(e) : res(v!))),
  );
const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: grpc.ServiceError) => grpc.status[e.code]);
const DONE = { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE', reasons: [], payment_pending_orders: 0, deposit_orders_cancelled: 0, deposit_orders_pending: 0, unused_tickets_cancelled: 0, unused_tickets_pending: 0 };
const TICKET_PENDING = 'WITHDRAWAL_PENDING_REASON_TICKET_REFUND_PENDING';
const PAY = 'WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER';
const DEP = 'WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING';

interface Order {
  orderId: string;
  accountId: string;
  eventId: string;
  amount: number;
  status: string;
}
/** 주문과 첫 이력 행을 한 트랜잭션에 넣는다(지연 제약 order_status_has_event) */
async function order(accountId: string, status: string, amount = 70_000 + Math.floor(Math.random() * 9_000), o2: { eventId?: string; createdAtMs?: number } = {}): Promise<Order> {
  const o = { orderId: randomUUID(), accountId, eventId: o2.eventId ?? randomUUID(), amount, status };
  const createdAt = new Date(o2.createdAtMs ?? Date.now() - 60 * 60_000);
  const c = await admin.pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, $4, $5, 1, $6, 'v1', 'PICK', $7, $8, 'ps-withdrawal-test')`,
      [o.orderId, accountId, o.eventId, status, amount, randomUUID(), createdAt, randomUUID()],
    );
    await c.query(`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, $2, 'T1', 'test', $3)`, [o.orderId, status, createdAt]);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  return o;
}
/** 그 주문의 결제 원장 행(payment DB) */
async function ledger(o: Order, status: 'AWAITING_DEPOSIT' | 'APPROVED' | 'UNKNOWN' | 'ACCEPTED', mode?: Mode): Promise<{ paymentId: string; paymentRef: string }> {
  const paymentId = randomUUID();
  const paymentRef = `tgen_${randomUUID().replaceAll('-', '')}`;
  refs.set(paymentRef, { orderId: o.orderId, amount: o.amount });
  if (mode) modes.set(paymentRef, mode);
  const nextQuery = status === 'AWAITING_DEPOSIT' || status === 'UNKNOWN' ? new Date(Date.now() + 3 * 86_400_000) : null;
  await payAdmin.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, status_changed_at, next_query_at, approved_at)
     values ($1, $2, $3, $4, 1, 'TOSS', $5, $6, $7, $8, now() - interval '1 hour', now() - interval '30 minutes', $9, $10)`,
    [paymentId, o.orderId, o.eventId, randomUUID(), paymentRef, o.amount, status, `confirm-${o.orderId}`, nextQuery, status === 'APPROVED' ? new Date(Date.now() - 60_000) : null],
  );
  return { paymentId, paymentRef };
}
/** 좌석 판매 행 하나(바뀌지 않는지 본다) */
const seatSale = (o: Order) => admin.pool.query(`insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, 'PENDING')`, [o.eventId, randomUUID(), o.orderId, o.accountId]);
const ordersOf = async (accountId: string) => (await admin.pool.query('select * from purchase_order where account_id = $1 order by id', [accountId])).rows;
const salesOf = async (accountId: string) => (await admin.pool.query('select * from seat_sale where account_id = $1 order by seat_id', [accountId])).rows;
const paymentsOf = async (orderIds: string[]) => (await payAdmin.pool.query('select id, status, failure_category, cancelled_amount, next_query_at from payment where order_id = any($1::uuid[]) order by id', [orderIds])).rows;
const paymentRowOf = async (orderId: string) => (await payAdmin.pool.query<{ status: string; failure_category: string | null }>('select status, failure_category from payment where order_id = $1', [orderId])).rows[0]!;
const cancelsFor = (paymentRef: string) => gatewayCancels.filter((c) => c.paymentRef === paymentRef);

// ---- 미사용 티켓(I-T26) 자료 만들기: 실제 ticket-svc 발권·purchase DB 주문 항목·payment 원장 ----
const DAY = 86_400_000;
const HOUR = 3_600_000;
interface TicketOrder extends Order {
  ticketId: string;
  seatId: string;
  payment: { paymentId: string; paymentRef: string };
  eventStartsAtMs: number;
}
/** 주문·티켓 발권·주문 항목·좌석 판매·결제 원장 APPROVED를 한 회차에 맞춰 넣는다(미사용 티켓의 취소 Saga가 도는 조건) */
async function ticketOrder(accountId: string, o: { eventStartsAtMs: number; entryOpensAtMs?: number; status?: string; price?: number }): Promise<TicketOrder> {
  const eventId = randomUUID();
  const price = o.price ?? 33_333;
  const eventStartsAtMs = o.eventStartsAtMs;
  eventConfigs.set(eventId, { saleEndsAtMs: eventStartsAtMs - DAY, ...(o.entryOpensAtMs !== undefined ? { entryOpensAtMs: o.entryOpensAtMs } : {}) });
  // 예매 뒤 영업시간 24시간 특례를 피하려고 20일 전에 예매한 주문이다
  const base = await order(accountId, o.status ?? 'CONFIRMED', price, { eventId, createdAtMs: Date.now() - 20 * DAY });
  const seatId = randomUUID();
  const issued = await ticketService.issue({ orderId: base.orderId, eventId, payerAccountId: accountId, seatIds: [seatId], issueGeneration: 0 });
  const ticketId = issued.tickets[0]!.ticketId;
  await admin.pool.query(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'R', 'A', $3, $4)`, [base.orderId, seatId, price, ticketId]);
  await admin.pool.query(`insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, 'SOLD')`, [eventId, seatId, base.orderId, accountId]);
  const payment = await ledger(base, 'APPROVED');
  return { ...base, ticketId, seatId, payment, eventStartsAtMs };
}
const ticketRow = async (ticketId: string) => (await ticketAdmin.pool.query('select status, key_revoked_at from ticket where id = $1', [ticketId])).rows[0] as { status: string; key_revoked_at: Date | null };
const seatRow = async (t: TicketOrder) => (await admin.pool.query('select status from seat_sale where event_id = $1 and seat_id = $2', [t.eventId, t.seatId])).rows[0]?.status as string | undefined;
interface CancellationRow {
  status: string;
  reason: string;
  deduction_bp: number;
  deduction_amount: number;
  refund_amount: number;
  refund_due_at: Date | null;
}
const cancellationOf = async (cancellationId: string): Promise<CancellationRow | undefined> =>
  (await admin.pool.query('select status, reason, deduction_bp, deduction_amount, refund_amount, refund_due_at from order_cancellation where id = $1', [cancellationId])).rows[0] as CancellationRow | undefined;
const cancellationCount = async () => (await admin.pool.query('select count(*)::int as n from order_cancellation')).rows[0].n as number;
/** 받는 층의 견적 RPC(실제 서버·내부 토큰) */
const quoteCall = (accountId: string, o: { md?: grpc.Metadata; deadlineMs?: number; via?: Client } = {}) =>
  new Promise<Record<string, unknown>>((res, rej) =>
    (o.via ?? client).QuoteAccountWithdrawal({ account_id: accountId }, o.md ?? metadata(), { deadline: new Date(Date.now() + (o.deadlineMs ?? 2_000)) }, (e, v) => (e ? rej(e) : res(v!))),
  );

describe('결제 결과를 기다리는 주문(P-T55 ①②)', () => {
  test('P-T55①_주문이없는계정은DONE이고이유가없고세수가0이다', async () => {
    expect(await call(randomUUID())).toEqual(DONE);
    expect(cancelInputs).toEqual([]);
  });

  test('P-T55①_APPROVED·CONFIRMED·FAILED·EXPIRED·COMPENSATED·PARTIALLY_REFUNDED·REFUNDED주문만있으면DONE이고취소를부르지않는다', async () => {
    const a = randomUUID();
    for (const s of ['APPROVED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED']) await order(a, s);
    expect(await call(a)).toEqual(DONE);
    expect(cancelInputs).toEqual([]);
    expect(gatewayCancels).toEqual([]);
  });

  test.each(['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'UNKNOWN'])('P-T55②_%s 주문 하나만 있어도 PENDING·이유 PAYMENT_PENDING_ORDER·payment_pending_orders 1이다', async (status) => {
    const a = randomUUID();
    await order(a, status);
    await order(a, 'CONFIRMED');
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [PAY], payment_pending_orders: 1, deposit_orders_cancelled: 0, deposit_orders_pending: 0, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    expect(cancelInputs).toEqual([]);
  });

  test('P-T55②_결제결과대기주문이둘이면payment_pending_orders가2이고_주문행·좌석판매행·결제원장은바뀌지않는다', async () => {
    const a = randomUUID();
    const r = await order(a, 'RESERVED');
    const u = await order(a, 'UNKNOWN');
    await seatSale(r);
    await seatSale(u);
    await ledger(r, 'ACCEPTED');
    await ledger(u, 'UNKNOWN');
    const before = { orders: await ordersOf(a), sales: await salesOf(a), payments: await paymentsOf([r.orderId, u.orderId]) };
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [PAY], payment_pending_orders: 2, deposit_orders_cancelled: 0, deposit_orders_pending: 0, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    expect({ orders: await ordersOf(a), sales: await salesOf(a), payments: await paymentsOf([r.orderId, u.orderId]) }).toEqual(before);
    expect(gatewayCancels).toEqual([]);
  });
});

describe('입금 대기 주문의 입금 전 취소(P-T55 ③④)', () => {
  test('P-T55③_입금대기주문둘은각각CancelPayment(취소ID withdrawal-{주문ID}·금액=주문금액·사유ACCOUNT_WITHDRAWAL)가한번불리고_결제사취소는주문마다1건·멱등키cancel-withdrawal-{주문ID}이며_DONE·cancelled 2다', async () => {
    const a = randomUUID();
    const d1 = await order(a, 'AWAITING_DEPOSIT', 88_000);
    const d2 = await order(a, 'AWAITING_DEPOSIT', 132_500);
    const p1 = await ledger(d1, 'AWAITING_DEPOSIT');
    const p2 = await ledger(d2, 'AWAITING_DEPOSIT');
    const ordersBefore = await ordersOf(a);
    expect(await call(a)).toEqual({ ...DONE, deposit_orders_cancelled: 2 });
    expect([...cancelInputs].sort((x, y) => x.paymentId.localeCompare(y.paymentId))).toEqual(
      [
        { paymentId: p1.paymentId, cancellationId: `withdrawal-${d1.orderId}`, reason: 'ACCOUNT_WITHDRAWAL', amount: 88_000 },
        { paymentId: p2.paymentId, cancellationId: `withdrawal-${d2.orderId}`, reason: 'ACCOUNT_WITHDRAWAL', amount: 132_500 },
      ].sort((x, y) => x.paymentId.localeCompare(y.paymentId)),
    );
    expect(cancelsFor(p1.paymentRef).map((c) => [c.idemKey, c.reason])).toEqual([[`cancel-withdrawal-${d1.orderId}`, 'ACCOUNT_WITHDRAWAL']]);
    expect(cancelsFor(p2.paymentRef).map((c) => [c.idemKey, c.reason])).toEqual([[`cancel-withdrawal-${d2.orderId}`, 'ACCOUNT_WITHDRAWAL']]);
    // 결제 원장은 payment-svc가 입금 전 취소로 끝낸다(주문 T17은 결제 사건으로 온다). purchase는 주문 행을 직접 바꾸지 않는다
    expect(await paymentRowOf(d1.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'DEPOSIT_CANCELED' });
    expect(await paymentRowOf(d2.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'DEPOSIT_CANCELED' });
    expect(await ordersOf(a)).toEqual(ordersBefore);
  });

  test('P-T55③_입금대기주문이0개면CancelPayment를한번도부르지않는다', async () => {
    const a = randomUUID();
    await order(a, 'CREATED');
    await call(a);
    expect(cancelInputs).toEqual([]);
    expect(gatewayCancels).toEqual([]);
  });

  test.each<[string, Mode]>([
    ['CANCEL_PENDING', 'CANCEL_PENDING'],
    ['UNKNOWN', 'UNKNOWN'],
    ['REJECTED(결제사에 입금이 먼저 들어옴)', 'DEPOSITED'],
  ])('P-T55④_취소 답이 %s면 PENDING·이유 DEPOSIT_CANCEL_PENDING·deposit_orders_pending 1이다', async (_name, mode) => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    const ok = await order(a, 'AWAITING_DEPOSIT');
    await ledger(d, 'AWAITING_DEPOSIT', mode);
    await ledger(ok, 'AWAITING_DEPOSIT');
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [DEP], payment_pending_orders: 0, deposit_orders_cancelled: 1, deposit_orders_pending: 1, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    if (mode === 'DEPOSITED') expect(warns.filter((w) => w.includes('withdrawal-deposit-cancel-rejected') && w.includes(d.orderId))).toHaveLength(1);
  });

  test('P-T55④_결제원장이이미APPROVED(입금확정이먼저,주문은아직입금대기)면REJECTED로PENDING이고_결제사에취소를보내지않는다(탈퇴가결제를환불하지않는다)', async () => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    const p = await ledger(d, 'APPROVED');
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [DEP], payment_pending_orders: 0, deposit_orders_cancelled: 0, deposit_orders_pending: 1, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    expect(cancelsFor(p.paymentRef)).toEqual([]);
    expect(await paymentRowOf(d.orderId)).toMatchObject({ status: 'APPROVED' });
  });

  test('P-T55④_장애주입_결제사가취소한뒤답을잃으면PENDING이고_다시부르면같은취소ID·같은멱등키로보내CANCELLED를받아DONE이다(결제사가받은요청은모두같은멱등키)', async () => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    const p = await ledger(d, 'AWAITING_DEPOSIT', 'LOSE_AFTER_CANCEL');
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [DEP], payment_pending_orders: 0, deposit_orders_cancelled: 0, deposit_orders_pending: 1, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    // 끊긴 자리가 결제사 취소 뒤였다(결제사 쪽은 이미 취소됨)
    expect(gatewayCanceled.has(p.paymentRef)).toBe(true);
    expect(lostOnce.has(p.paymentRef)).toBe(true);
    expect(await call(a)).toEqual({ ...DONE, deposit_orders_cancelled: 1 });
    expect(cancelsFor(p.paymentRef).map((c) => c.idemKey)).toEqual([`cancel-withdrawal-${d.orderId}`, `cancel-withdrawal-${d.orderId}`]);
    expect(cancelInputs.map((c) => c.cancellationId)).toEqual([`withdrawal-${d.orderId}`, `withdrawal-${d.orderId}`]);
    expect(await paymentRowOf(d.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'DEPOSIT_CANCELED' });
  });

  test('P-T55④_장애주입_payment-svc가결제사취소를마치고원장을쓴뒤purchase가답을잃으면PENDING이고_다음호출은같은취소ID로CANCELLED를받아DONE이며결제사취소는한번이다', async () => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    const p = await ledger(d, 'AWAITING_DEPOSIT');
    route = 'lose';
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [DEP], payment_pending_orders: 0, deposit_orders_cancelled: 0, deposit_orders_pending: 1, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    // 버린 답은 CANCELLED였고 원장은 이미 끝났다(끊는 자리가 커밋 뒤까지 닿았다)
    expect(lostAnswers).toEqual(['CANCELLED']);
    expect(await paymentRowOf(d.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'DEPOSIT_CANCELED' });
    route = 'real';
    expect(await call(a)).toEqual({ ...DONE, deposit_orders_cancelled: 1 });
    expect(cancelInputs.map((c) => c.cancellationId)).toEqual([`withdrawal-${d.orderId}`, `withdrawal-${d.orderId}`]);
    expect(cancelsFor(p.paymentRef).map((c) => c.idemKey)).toEqual([`cancel-withdrawal-${d.orderId}`]);
  });

  test('P-T55④_장애주입_payment-svc에닿지못하면PENDING이고결제사를부르지않으며_돌아오면같은취소ID로끝낸다', async () => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    const p = await ledger(d, 'AWAITING_DEPOSIT');
    route = 'dead';
    expect(await call(a)).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [DEP], payment_pending_orders: 0, deposit_orders_cancelled: 0, deposit_orders_pending: 1, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
    expect(cancelInputs).toEqual([]);
    expect(cancelsFor(p.paymentRef)).toEqual([]);
    expect(await paymentRowOf(d.orderId)).toMatchObject({ status: 'AWAITING_DEPOSIT' });
    route = 'real';
    expect(await call(a)).toEqual({ ...DONE, deposit_orders_cancelled: 1 });
    expect(cancelsFor(p.paymentRef).map((c) => c.idemKey)).toEqual([`cancel-withdrawal-${d.orderId}`]);
  });

  test('P-T55②④_결제결과대기와취소남은입금대기가함께면이유둘을겹치지않게싣는다', async () => {
    const a = randomUUID();
    await order(a, 'CREATED');
    await order(a, 'ACCEPTED');
    const d = await order(a, 'AWAITING_DEPOSIT');
    await ledger(d, 'AWAITING_DEPOSIT', 'CANCEL_PENDING');
    const r = await call(a);
    expect({ ...r, reasons: [...(r.reasons as string[])].sort() }).toEqual({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [DEP, PAY].sort(), payment_pending_orders: 2, deposit_orders_cancelled: 0, deposit_orders_pending: 1, unused_tickets_cancelled: 0, unused_tickets_pending: 0 });
  });
});

describe('계정 대조·부르는 쪽·저장소 장애(P-T55 ⑥)', () => {
  test('P-T55⑥_B의주문은읽지도바꾸지도않는다: A를부르면B의입금대기취소0건·B의결제원장과주문행그대로이고_A의수에B가섞이지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const aDep = await order(a, 'AWAITING_DEPOSIT');
    await ledger(aDep, 'AWAITING_DEPOSIT');
    const bDep = await order(b, 'AWAITING_DEPOSIT');
    const bPay = await ledger(bDep, 'AWAITING_DEPOSIT');
    await order(b, 'CREATED');
    await order(b, 'UNKNOWN');
    const bBefore = { orders: await ordersOf(b), payments: await paymentsOf([bDep.orderId]) };
    expect(await call(a)).toEqual({ ...DONE, deposit_orders_cancelled: 1 });
    expect(cancelInputs.map((c) => c.cancellationId)).toEqual([`withdrawal-${aDep.orderId}`]);
    expect(cancelsFor(bPay.paymentRef)).toEqual([]);
    expect({ orders: await ordersOf(b), payments: await paymentsOf([bDep.orderId]) }).toEqual(bBefore);
  });

  test('P-T55⑥_계정ID가대문자이거나UUID가아니면INVALID_ARGUMENT이고아무것도부르지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    await ledger(d, 'AWAITING_DEPOSIT');
    for (const bad of [a.toUpperCase(), `${a.slice(0, 35)}X`, 'account-1', '']) expect({ bad, code: await codeOf(call(bad)) }).toEqual({ bad, code: 'INVALID_ARGUMENT' });
    expect(cancelInputs).toEqual([]);
    expect(await paymentRowOf(d.orderId)).toMatchObject({ status: 'AWAITING_DEPOSIT' });
  });

  test('P-T55⑥_내부토큰이없거나틀리면UNAUTHENTICATED_부르는쪽이identity-svc가아니면PERMISSION_DENIED이고아무것도부르지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const a = randomUUID();
    const d = await order(a, 'AWAITING_DEPOSIT');
    await ledger(d, 'AWAITING_DEPOSIT');
    expect(await codeOf(call(a, { md: metadata({ token: null }) }))).toBe('UNAUTHENTICATED');
    expect(await codeOf(call(a, { md: metadata({ token: 'not-the-token' }) }))).toBe('UNAUTHENTICATED');
    expect(await codeOf(call(a, { md: metadata({ caller: 'ops-svc' }) }))).toBe('PERMISSION_DENIED');
    expect(await codeOf(call(a, { md: metadata({ caller: 'ticket-svc' }) }))).toBe('PERMISSION_DENIED');
    expect(cancelInputs).toEqual([]);
    expect(await paymentRowOf(d.orderId)).toMatchObject({ status: 'AWAITING_DEPOSIT' });
  });

  test('P-T55⑥_장애주입_purchase DB에닿지못하면UNAVAILABLE이다(INTERNAL·DONE이아니다)', async () => {
    expect(await codeOf(call(randomUUID(), { via: brokenClient, deadlineMs: 3_000 }))).toBe('UNAVAILABLE');
    expect(cancelInputs).toEqual([]);
  });

  test('P-T55⑥_장애주입_주문찾기가문장시간한도(400ms)를넘기면UNAVAILABLE이고_데드라인3초보다훨씬앞에돌아온다', async () => {
    const a = randomUUID();
    await order(a, 'CREATED');
    const c = await admin.pool.connect();
    try {
      await c.query('begin');
      await c.query('lock table purchase_order in access exclusive mode');
      const started = Date.now();
      expect(await codeOf(call(a, { deadlineMs: 3_000 }))).toBe('UNAVAILABLE');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });
});

// ---- I-T26 ②: 실제 ticket-svc·payment-svc로 미사용 티켓 취소·환급·미룸(BAT-013) ----
// 값은 정본에서 적는다: 33,333원 10% = 3,333/30,000, 당일 90% = 29,999/3,334. 취소 ID는 표 ID에서 만든 고정 UUID,
// 결제사 멱등키 cancel-{취소 ID}, 사유 ACCOUNT_WITHDRAWAL, 마감 뒤 환급 시각 = 공연 시작 + 50시간.
describe('미사용 티켓의 취소·환급·미룸(I-T26 ②, 실제 ticket-svc·payment-svc)', () => {
  test('I-T26②_입장전표는결제사취소까지하고_입장시작뒤표는REQUESTED로접수하며_다시불러도취소는늘지않고_환급기가끝낸뒤DONE이고_다른계정은그대로다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-8.2.2]', async () => {
    const a = randomUUID();
    const before = Date.now();
    const t1 = await ticketOrder(a, { eventStartsAtMs: before + 7 * DAY });
    const t2 = await ticketOrder(a, { eventStartsAtMs: before + 2 * HOUR, entryOpensAtMs: before - HOUR });
    const b = randomUUID();
    const b1 = await ticketOrder(b, { eventStartsAtMs: before + 7 * DAY });
    const bBefore = { orders: await ordersOf(b), ticket: await ticketRow(b1.ticketId), cancellations: await cancellationCount() };
    gatewayCancels.length = 0;
    cancelInputs.length = 0;

    const r1 = await call(a);
    expect({ ...r1, reasons: [...(r1.reasons as string[])].sort() }).toEqual({
      state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING',
      reasons: [TICKET_PENDING],
      payment_pending_orders: 0,
      deposit_orders_cancelled: 0,
      deposit_orders_pending: 0,
      unused_tickets_cancelled: 1,
      unused_tickets_pending: 1,
    });
    const id1 = withdrawalTicketCancellationId(t1.ticketId);
    const id2 = withdrawalTicketCancellationId(t2.ticketId);
    // ① 입장 전 표: 기존 취소 Saga가 사유 ACCOUNT_WITHDRAWAL·POL-032 10%로 결제사 취소까지 하고 좌석을 되돌린다
    expect(await cancellationOf(id1)).toMatchObject({ status: 'REFUNDED', reason: 'ACCOUNT_WITHDRAWAL', deduction_bp: 1_000, deduction_amount: 3_333, refund_amount: 30_000, refund_due_at: null });
    expect(cancelsFor(t1.payment.paymentRef).map((c) => [c.idemKey, c.reason, c.amount])).toEqual([[`cancel-${id1}`, 'ACCOUNT_WITHDRAWAL', 30_000]]);
    expect(await seatRow(t1)).toBe('RETURNED');
    expect(await ticketRow(t1.ticketId)).toMatchObject({ status: 'REFUNDED' });
    // ② 입장 시작 뒤 표: 접수만 하고(REQUESTED) 환급은 입장 기록 마감 뒤로 미룬다. 좌석은 취소표로 되돌린다
    expect(await cancellationOf(id2)).toMatchObject({ status: 'REQUESTED', reason: 'ACCOUNT_WITHDRAWAL', deduction_bp: 9_000, deduction_amount: 29_999, refund_amount: 3_334 });
    expect((await cancellationOf(id2))!.refund_due_at?.getTime()).toBe(t2.eventStartsAtMs + 50 * HOUR);
    expect(cancelsFor(t2.payment.paymentRef)).toEqual([]);
    expect(await seatRow(t2)).toBe('RETURNED');
    expect(await ticketRow(t2.ticketId)).toMatchObject({ status: 'REFUNDED' });

    // ③ 다시 부르면 결제사 취소가 늘지 않고 같은 수다(취소 ID 고정)
    expect(await call(a)).toMatchObject({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', unused_tickets_cancelled: 0, unused_tickets_pending: 1 });
    expect(gatewayCancels).toHaveLength(1);

    // ⑤ 다른 계정 B의 표·주문은 그대로다
    expect(await ordersOf(b)).toEqual(bBefore.orders);
    expect(await ticketRow(b1.ticketId)).toEqual(bBefore.ticket);
    expect(await cancellationCount()).toBe(bBefore.cancellations + 2);
    expect(cancelsFor(b1.payment.paymentRef)).toEqual([]);

    // ④ 환급 실행기가 마감 뒤 후자를 REFUNDED로 바꾸면 다시 부르는 답은 DONE이다
    const writes = new DrizzleCancellationWrites(purchaseDb, new DrizzleOrderStore({ clock: systemClock }));
    const refund = new RefundAfterEntry({ writes, payments: realCancels, entries: ticketCancels, claims: writes, nowMs: () => t2.eventStartsAtMs + 50 * HOUR });
    expect(await refund.run()).toMatchObject({ refunded: 1 });
    expect(await cancellationOf(id2)).toMatchObject({ status: 'REFUNDED', refund_amount: 3_334 });
    expect(cancelsFor(t2.payment.paymentRef).map((c) => [c.idemKey, c.amount])).toEqual([[`cancel-${id2}`, 3_334]]);
    expect(await call(a)).toEqual(DONE);
    // B는 여전히 그대로다
    expect(await ordersOf(b)).toEqual(bBefore.orders);
    expect(await ticketRow(b1.ticketId)).toEqual(bBefore.ticket);
  });

  test('I-T26①_PostgreSQL에서견적RPC는그계정이결제한미사용표만세고_취소기록·REFUNDED주문·다른계정표는빼며_POL-032금액을돌려준다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const event = Date.now() + 7 * DAY;
    const t1 = await ticketOrder(a, { eventStartsAtMs: event });
    const t2 = await ticketOrder(a, { eventStartsAtMs: event, status: 'PARTIALLY_REFUNDED' });
    // 취소 기록이 있는 표(어떤 사유든)와 REFUNDED 주문은 견적에서 뺀다
    const t3 = await ticketOrder(a, { eventStartsAtMs: event });
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
       values ($1, $2, $3, 'USER', 0, false, 9000, 29999, 3334, 'REFUNDED', now(), now())`,
      [randomUUID(), t3.orderId, t3.ticketId],
    );
    const t4 = await ticketOrder(a, { eventStartsAtMs: event, status: 'REFUNDED' });
    const b1 = await ticketOrder(b, { eventStartsAtMs: event });
    const before = { orders: await ordersOf(a), cancellations: await cancellationCount() };

    // t1·t2만 센다: 결제 66,666원, 10% 공제 6,666원, 환급 60,000원. 양도 마감 전이라 둘 다 양도 가능하다
    expect(await quoteCall(a)).toEqual({ unused_tickets: 2, ticket_amount: 66_666, deduction_amount: 6_666, refund_amount: 60_000, transferable_tickets: 2, refund_deferred_tickets: 0 });
    expect(await quoteCall(b)).toEqual({ unused_tickets: 1, ticket_amount: 33_333, deduction_amount: 3_333, refund_amount: 30_000, transferable_tickets: 1, refund_deferred_tickets: 0 });
    // 읽기 전용이다(주문·취소 행이 그대로)
    expect(await ordersOf(a)).toEqual(before.orders);
    expect(await cancellationCount()).toBe(before.cancellations);
    // 0장 계정은 모두 0이다
    expect(await quoteCall(randomUUID())).toEqual({ unused_tickets: 0, ticket_amount: 0, deduction_amount: 0, refund_amount: 0, transferable_tickets: 0, refund_deferred_tickets: 0 });
    // 견적도 같은 부르는 쪽 검사를 한다
    expect(await codeOf(quoteCall(a, { md: metadata({ token: null }) }))).toBe('UNAUTHENTICATED');
    expect(await codeOf(quoteCall(a.toUpperCase()))).toBe('INVALID_ARGUMENT');
    void t1;
    void t2;
    void t4;
    void b1;
  });

  // RV-02(보안, BAT-013 리뷰): pendingRefunds가 그 계정 주문의 취소 행만 세는지 실제 PostgreSQL로 본다.
  // A·B에 각각 사유 ACCOUNT_WITHDRAWAL의 대기 행을 두고, A의 답이 B의 행을 세지 않는지(B를 넣으면 2가 된다)와 두 행이 그대로인지 본다.
  test('I-T26 ③_RV-02_A의미사용티켓대기수는A의주문취소행만세고_B의ACCOUNT_WITHDRAWAL대기행은세지않으며_B의행은그대로다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const aOrder = await order(a, 'CONFIRMED');
    const bOrder = await order(b, 'CONFIRMED');
    const aCancellation = randomUUID();
    const bCancellation = randomUUID();
    // A는 자기 대기 행 1장(REFUND_PENDING), B는 대기 행 1장(REQUESTED)을 가진다
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
       values ($1, $2, $3, 'ACCOUNT_WITHDRAWAL', 0, false, 0, 0, 33333, 'REFUND_PENDING', now(), now())`,
      [aCancellation, aOrder.orderId, randomUUID()],
    );
    await admin.pool.query(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
       values ($1, $2, $3, 'ACCOUNT_WITHDRAWAL', 0, false, 0, 0, 30000, 'REQUESTED', now(), now())`,
      [bCancellation, bOrder.orderId, randomUUID()],
    );
    const bBefore = await cancellationOf(bCancellation);
    expect(bBefore).toMatchObject({ status: 'REQUESTED', reason: 'ACCOUNT_WITHDRAWAL', refund_amount: 30_000 });

    // A의 답은 A의 1장만 센다. B의 행을 세면 2가 되고, 두 계정을 섞으면 이 단언이 잡는다
    expect(await call(a)).toEqual({
      state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING',
      reasons: [TICKET_PENDING],
      payment_pending_orders: 0,
      deposit_orders_cancelled: 0,
      deposit_orders_pending: 0,
      unused_tickets_cancelled: 0,
      unused_tickets_pending: 1,
    });
    // 읽기 전용이다: A·B의 취소 행과 주문 행이 그대로다
    expect(await cancellationOf(aCancellation)).toMatchObject({ status: 'REFUND_PENDING', reason: 'ACCOUNT_WITHDRAWAL', refund_amount: 33_333 });
    expect(await cancellationOf(bCancellation)).toEqual(bBefore);
    expect(await ordersOf(b)).toHaveLength(1);
    expect((await ordersOf(b))[0]).toMatchObject({ id: bOrder.orderId, status: 'CONFIRMED' });
    // B도 자기 행만 1장으로 센다(반대 방향 격리)
    expect(await call(b)).toMatchObject({ state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [TICKET_PENDING], unused_tickets_cancelled: 0, unused_tickets_pending: 1 });
    expect(await cancellationOf(aCancellation)).toMatchObject({ status: 'REFUND_PENDING' });
    expect(await cancellationOf(bCancellation)).toMatchObject({ status: 'REQUESTED' });
  });
});

describe('identity-svc 클라이언트와 잇기(I-T84 ③ · P-T55, 계약 양쪽)', () => {
  beforeEach(() => {
    vi.stubEnv('PEAKET_INTERNAL_GRPC_TOKEN', TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('P-T55_identity-svc의GrpcWithdrawalParticipant가운영받는층을부르면_결제대기주문이있으면PENDING과이유이름이고_없으면DONE이다', async () => {
    const p = new GrpcWithdrawalParticipant({ address: purchaseAddress });
    try {
      const a = randomUUID();
      expect(await p.process(a, { deadlineMs: 3_000 })).toEqual({ state: 'DONE' });
      await order(a, 'RESERVED');
      const d = await order(a, 'AWAITING_DEPOSIT');
      await ledger(d, 'AWAITING_DEPOSIT', 'UNKNOWN');
      const r = await p.process(a, { deadlineMs: 3_000 });
      expect(r.state).toBe('PENDING');
      expect([...(r as { reasons: readonly string[] }).reasons].sort()).toEqual(['DEPOSIT_CANCEL_PENDING', 'PAYMENT_PENDING_ORDER']);
    } finally {
      p.close();
    }
  });
});
