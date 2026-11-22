// 굿즈 결제 실제 연결 시험(BAT-600, P-T57 ①②, P-T56 ⑤⑥, V-T35 ①, P-T58 ①④⑤). 가짜 API 대신 실제 서비스를 잇는다:
// core-svc HTTP(주문·결제 시도·결제 접수, 실제 PostgreSQL·Valkey 재고 Lua) → 실제 gRPC PrepareCheckout(payment-svc, ORDER_KIND_MERCH)
// → 시뮬레이터 인증(/sim/authenticate, 결제창 대신) → 실제 gRPC ConfirmPayment → 승인 실행기 → PG 시뮬레이터 승인
// → core-svc 결과 당기기(MerchPaymentResults, 실제 BatchGetPayments) → 주문 PAID·FAILED. 미수령 자동 취소는 실제 CancelPayment로 시뮬레이터 결제를 취소한다.
// 부가 상품의 티켓 보유는 실제 ticket-svc gRPC 서버(ListHeldTickets, 메모리 저장소)로 확인한다.
// Kafka만 빠진다(이 PC에서 네이티브 모듈이 막혀 있어 Outbox 행의 값을 purchase-svc 결과 처리기에 그대로 넘긴다).
// 단언 값은 정본에서: docs/features/payment.md §11 P-T56·P-T57·P-T58, docs/verification.md V-T35, ADR-0299 결정 1·3·4, ADR-0300 결정 3~6, ADR-0301 결정 1~5.
// 한정 수량은 3(코드 기본값과 상관없는 시험 값), 재고 키 이름은 ADR-0300 결정 3의 글자 그대로 적는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { type Clock, type ConsumedMessage, createDatabase, createHotRedis, createPlatformLogger, createService, type Database, ensureOutboxPartitions, type HotRedis, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// core-svc
import { migrateCore } from '../../core-svc/scripts/migrate.mjs';
import { AppModule as CoreAppModule } from '../../core-svc/src/app.module.js';
import { event as eventTable, place, production, promoter } from '../../core-svc/src/modules/catalog/adapters/db/schema.js';
import { DrizzleShopOrderStore, GrpcHeldTickets, GrpcMerchPayments, MerchPaymentResults, MerchUnclaimed, RedisMerchStock } from '../../core-svc/src/modules/shop/index.js';
import { fan as fanHeaders, FakeIdentity, testMedia } from '../../core-svc/test/support.js';
import { loginFor } from '../../core-svc/test-int/roles.js';
// ticket-svc(보유 티켓 확인 서버)
import { startGrpcServer as startTicketGrpc } from '../../ticket-svc/src/grpc-server.js';
import { MemoryTicketStore } from '../../ticket-svc/src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../../ticket-svc/src/modules/ticket/application/ticket-service.js';
import { ticketPackage, ticketServiceHandlers } from '../../ticket-svc/src/modules/ticket/inbound/ticket.grpc.js';
// purchase-svc(결제 사건 소비자)
import { PaymentResultHandler, PromPaymentEventSkipSignals } from '../../purchase-svc/src/modules/booking/index.js';
import { startValkey, type ValkeyContainer } from '../../purchase-svc/test-int/valkey.js';
// payment-svc
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  CachedEntryPauseReader,
  CachedPgSelectionReader,
  CancelConfirmedPayment,
  CancelPayment,
  channelTableOf,
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePaymentStore,
  DrizzlePgSelection,
  paymentCheckoutLog,
  paymentCommandLog,
  paymentConfirmLog,
  PaymentConfirmRunner,
  paymentPackage,
  paymentServiceHandlers,
  PgCallGuards,
  pgCallGuardLog,
  PrepareCheckout,
  PromPaymentCheckoutSignals,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { until } from './support.js';

const WEB = 'https://www.it.example';
const SIM_KEY = 'sim_sk_merch_e2e';
const CONSENT = '2026-11-09';
const LIMITED = 3;

let pgc: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let sim: SimulatorApp;
let simUrl: string;
let coreAdmin: Database;
let coreApp: Database;
let corePartner: Database;
let adminPay: Database;
let payHot: Database;
let core: Awaited<ReturnType<typeof createService>>;
let confirmRunner: PaymentConfirmRunner;
let results: MerchPaymentResults;
let unclaimed: MerchUnclaimed;
let tickets: TicketService;
const closeAll: (() => Promise<void> | void)[] = [];
const identity = new FakeIdentity();
const quiet = new Writable({ write: (_c, _e, cb) => cb() });

/** core-svc 시계: 실제 시각 + 앞당김(미수령 정비 일을 토·월요일로 돌릴 때만 앞당긴다. payment-svc·시뮬레이터는 실제 시계) */
let offsetMs = 0;
const coreClock: Clock = { now: () => Date.now() + offsetMs, monotonicMs: () => performance.now() };

const PROMOTER = randomUUID();
const EVENT = randomUUID();

/** ADR-0300 결정 3의 키 넷(글자 그대로) */
const keys = (productId: string) => ({
  stock: `shop:{product:${productId}}:stock`,
  resv: `shop:{product:${productId}}:resv`,
  resvQty: `shop:{product:${productId}}:resv_qty`,
  unpaid: `shop:{product:${productId}}:unpaid`,
});
const r = (args: string[], key: string) => redis.command(args, { key });
const counter = async (productId: string) => Number((await r(['GET', keys(productId).stock], keys(productId).stock))?.toString());
const resvScore = async (productId: string, orderId: string) => (await r(['ZSCORE', keys(productId).resv, orderId], keys(productId).resv)) ?? null;
const resvQty = async (productId: string, orderId: string) => (await r(['HGET', keys(productId).resvQty, orderId], keys(productId).resvQty)) ?? null;
const unpaidOf = async (productId: string, accountId: string) => (await r(['HGET', keys(productId).unpaid, accountId], keys(productId).unpaid))?.toString() ?? null;
const productStock = async (productId: string) => Number((await coreAdmin.pool.query<{ stock: number }>('select stock from product_stock where product_id = $1', [productId])).rows[0]?.stock);
/** 회차 정산서 결제 읽기(drizzle-payment-source listEventPayments)의 회차 고르기 조건 event_id = 회차에 걸리는 그 결제 행 수 */
const eventPaymentRows = async (eventId: string, paymentId: string) => Number((await adminPay.pool.query('select count(*)::int n from payment where event_id = $1 and id = $2', [eventId, paymentId])).rows[0].n);
const orderRow = async (orderId: string) => (await coreAdmin.pool.query<{ status: string; payment_id: string | null; amount: number }>('select status, payment_id, amount from merch_order where id = $1', [orderId])).rows[0];

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'fulfilled') pgc = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  for (const x of [p, v]) if (x.status === 'rejected') throw x.reason as Error;

  redis = await createHotRedis({ url: valkey!.url });
  sim = buildSimulatorApp({ secretKey: SIM_KEY });
  simUrl = await sim.listen({ host: '127.0.0.1', port: 0 });

  // payment-svc는 별도 DB, core-svc는 기본 DB(peaket, 시험 로그인 사용자가 그 DB 주소를 쓴다)
  const root = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'merch-e2e-root' });
  await root.pool.query('create database payment_e2e');
  await root.close();
  const payUrl = new URL(pgc!.url);
  payUrl.pathname = '/payment_e2e';
  await migratePayment(payUrl.toString());
  await migrateCore(pgc!.url);
  adminPay = createDatabase({ url: payUrl.toString(), profile: 'general', max: 4, applicationName: 'merch-e2e-admin-pay' });
  payHot = createDatabase({ url: payUrl.toString(), profile: 'general', max: 10, applicationName: 'merch-e2e-pay' });
  await ensureOutboxPartitions(adminPay, systemClock);
  coreAdmin = createDatabase({ url: pgc!.url, applicationName: 'merch-e2e-core-admin', max: 4 });
  await ensureOutboxPartitions(coreAdmin, systemClock);
  coreApp = await loginFor(coreAdmin, pgc!, 'core_app_login', 'core_app', 6);
  corePartner = await loginFor(coreAdmin, pgc!, 'core_partner_login', 'core_partner', 4);

  // payment-svc: 실제 쓰임새·gRPC 서버·시뮬레이터 어댑터(purchase-path-e2e와 같은 조립에 CancelPayment를 더함)
  const metrics = new PlatformMetrics('payment-svc');
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: systemClock, level: 'fatal', destination: quiet });
  const cmdSignals = new PromPaymentCommandSignals();
  cmdSignals.register(metrics.registry);
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const store = new DrizzlePaymentStore({ database: payHot, batchDatabase: payHot });
  const gateway = new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: SIM_KEY, clientKey: 'sim_ck_merch_e2e', readTimeoutMs: 2_500 });
  const gateways = new StaticPaymentGateways([gateway]);
  const entry = new DrizzleEntryPause({ database: payHot });
  const prepareCheckout = new PrepareCheckout({
    selection: new CachedPgSelectionReader({ reader: new DrizzlePgSelection({ database: payHot }), clock: systemClock }),
    pauses: new CachedEntryPauseReader({ reader: entry, clock: systemClock, signals: checkoutSignals }),
    trials: entry,
    gateways,
    channels: channelTableOf(gateways),
    defaults: { primary: 'SIMULATOR', fallback: 'SIMULATOR' },
    webOrigin: WEB,
    virtualAccountReady: false,
    clock: systemClock,
    log: paymentCheckoutLog(logger),
    signals: checkoutSignals,
  });
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: systemClock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger) });
  const confirmJobs = new DrizzleConfirmJobs({ database: payHot, clock: systemClock });
  const confirmed = new CancelConfirmedPayment({ store: confirmJobs, gateways, guards, clock: systemClock });
  const cancelPayment = new CancelPayment({ execute: async () => Promise.reject(new Error('굿즈는 입금 전 취소 갈래가 없다')) } as never, confirmed, confirmJobs);
  const handlers = paymentServiceHandlers(
    {
      accept: new AcceptPaymentCommand({ store, clock: systemClock, log: paymentCommandLog(logger), signals: cmdSignals }),
      batchGet: new BatchGetPaymentStates({ reader: store, signals: cmdSignals }),
      prepareCheckout,
      cancelPayment,
    },
    () => undefined,
  );
  const payGrpc = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
  closeAll.push(() => payGrpc.close());
  confirmRunner = new PaymentConfirmRunner({
    jobs: confirmJobs,
    gateways,
    log: paymentConfirmLog(logger),
    signals: new PromPaymentConfirmSignals().register(metrics.registry),
    clock: systemClock,
    podId: 'merch-e2e-pay',
    guards,
    disallowedDeposit: async () => undefined,
    timer: { setInterval: () => 0, clearInterval: () => {} },
  } as never);

  // ticket-svc: 실제 gRPC 서버(메모리 저장소)
  tickets = new TicketService({ store: new MemoryTicketStore(), clock: systemClock });
  const ticketGrpc = await startTicketGrpc({ host: '127.0.0.1', port: 0, services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: tickets, nowMs: () => Date.now() }, () => {}) }] });
  closeAll.push(() => ticketGrpc.close());

  // core-svc: 실제 HTTP·Drizzle·재고 Lua·gRPC 클라이언트
  await coreAdmin.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)굿즈시험' });
  // 파트너 HTTP로 게시하는 판매자의 지금 계약(기간 끝이 열림). core-svc 0042 트리거가 게시 상품 수수료율을 계약에서 정한다(ADR-0338 결정 4). 조립의 FixedCommissionRate(1000)와 같은 값
  await coreAdmin.pool.query(
    `insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during) values ($1, $2, 1000, 1000, 'DEPOSIT', tstzrange('2026-01-01T00:00:00Z', NULL, '[)'))`,
    [randomUUID(), PROMOTER],
  );
  const PLACE = randomUUID();
  const PROD = randomUUID();
  await coreAdmin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: PROMOTER });
  await coreAdmin.db.insert(production).values({ id: PROD, promoterId: PROMOTER, placeId: PLACE, title: 'LUMEN 콘서트', genre: '콘서트', saleReview: 'DRAFT' });
  await coreAdmin.db.insert(eventTable).values({ id: EVENT, productionId: PROD, promoterId: PROMOTER, venueId: null, openAt: new Date('2027-01-01T00:00:00Z'), startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') });
  const stock = new RedisMerchStock(redis);
  const payments = new GrpcMerchPayments(`127.0.0.1:${payGrpc.port}`);
  const held = new GrpcHeldTickets(`127.0.0.1:${ticketGrpc.port}`);
  closeAll.push(() => {
    payments.close();
    held.close();
  });
  core = await createService({
    name: 'core-svc',
    module: CoreAppModule.register({ database: coreApp, partnerDatabase: corePartner, media: testMedia(), shop: { stock, payments, held, consentVersion: CONSENT } }),
    env: { PEAKET_ENV: 'ci' },
    clock: coreClock,
    logDestination: quiet,
    adminAuthz: identity,
  });
  const orders = new DrizzleShopOrderStore(coreApp, coreClock);
  results = new MerchPaymentResults({ store: orders, stock, payments, clock: coreClock });
  unclaimed = new MerchUnclaimed({ store: orders, payments, clock: coreClock });
}, 240_000);

afterAll(async () => {
  await core?.close().catch(() => undefined);
  for (const f of closeAll) await Promise.resolve(f()).catch(() => undefined);
  await sim?.close();
  await Promise.allSettled([redis?.close(), coreApp?.close(), corePartner?.close(), coreAdmin?.close(), adminPay?.close(), payHot?.close()]);
  valkey?.stop();
  pgc?.stop();
});

const json = (res: { payload: string }) => {
  const v = JSON.parse(res.payload) as Record<string, unknown>;
  if (typeof v.type === 'string') v.type = v.type.split('/').pop();
  return v;
};
const fanCall = (accountId: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  core.http.inject({
    method,
    url,
    headers: { ...fanHeaders(accountId), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });

async function createProduct(over: Record<string, unknown>): Promise<string> {
  const res = await core.http.inject({
    method: 'POST',
    url: '/v1/partner/products',
    headers: { ...identity.partner(PROMOTER), 'content-type': 'application/json' },
    payload: JSON.stringify({
      type: 'MERCH',
      name: '시험 굿즈',
      price: 20_000,
      shippingFee: 3_000,
      returnShippingFee: 3_000,
      returnAddress: '서울특별시 마포구',
      ticketLinked: false,
      linkedEventId: null,
      limitedQty: LIMITED,
      fulfillments: ['PICKUP'],
      transferable: false,
      status: 'PUBLISHED',
      attributes: {},
      ...over,
    }),
  });
  expect(res.statusCode, res.payload).toBe(201);
  return String(json(res).productId);
}

async function slot(productId: string, startsAt: Date, endsAt: Date): Promise<string> {
  const id = randomUUID();
  await coreAdmin.pool.query('insert into pickup_slot (id, product_id, event_id, starts_at, ends_at, ticket_holders_only) values ($1, $2, $3, $4, $5, false)', [id, productId, EVENT, startsAt, endsAt]);
  return id;
}
const farSlot = (productId: string) => slot(productId, new Date(Date.now() + 30 * 86_400_000), new Date(Date.now() + 30 * 86_400_000 + 3_600_000));

async function simAuth(body: unknown): Promise<string> {
  const res = await fetch(`${simUrl}/sim/authenticate`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${SIM_KEY}:`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return String(((await res.json()) as { paymentKey: string }).paymentKey);
}
async function simPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${simUrl}${path}`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${SIM_KEY}:`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect([200, 204]).toContain(res.status);
}
async function simLedger(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${simUrl}/sim/ledger`, { headers: { authorization: `Basic ${Buffer.from(`${SIM_KEY}:`).toString('base64')}` } });
  expect(res.status).toBe(200);
  const t = await res.text();
  return t
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
async function simPayment(paymentKey: string): Promise<{ status: string; balanceAmount?: number; cancels: Array<{ cancelAmount: number }> | null }> {
  const res = await fetch(`${simUrl}/v1/payments/${paymentKey}`, { headers: { authorization: `Basic ${Buffer.from(`${SIM_KEY}:`).toString('base64')}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as never;
}

/** 결제 시도 → 시뮬레이터 인증 → 접수 202 → 승인 실행기가 결제사까지 보냄 → payment 행이 끝 상태가 될 때까지 */
async function pay(accountId: string, orderId: string, expectedAmount: number): Promise<{ paymentKey: string; checkoutOrderId: string; successUrl: string; attemptId: string }> {
  const started = await fanCall(accountId, 'POST', `/v1/shop/orders/${orderId}/payments`, {});
  expect(started.statusCode, started.payload).toBe(201);
  const attempt = json(started) as { attemptId: string; pg: string; allowedPayMethods: string[]; checkout: { orderId: string; amount: number; successUrl: string; failUrl: string } };
  expect(attempt.pg).toBe('SIMULATOR');
  expect(attempt.checkout.amount).toBe(expectedAmount);
  expect(attempt.allowedPayMethods).not.toContain('VIRTUAL_ACCOUNT');
  const paymentKey = await simAuth({ orderId: attempt.checkout.orderId, amount: attempt.checkout.amount, orderName: '시험 굿즈' });
  return { paymentKey, checkoutOrderId: attempt.checkout.orderId, successUrl: attempt.checkout.successUrl, attemptId: attempt.attemptId };
}
async function accept(accountId: string, orderId: string, a: { paymentKey: string; attemptId?: string }, amount: number): Promise<void> {
  const res = await fanCall(accountId, 'POST', `/v1/shop/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey: a.paymentKey, amount, attemptId: a.attemptId });
  expect(res.statusCode, res.payload).toBe(202);
}
/** 승인 실행기를 돌린다. 접수 때의 ConfirmPayment(데드라인 200ms)가 시간 안에 받아지지 않았으면 core-svc 결과 당기기 반복이 다시 보낸다(ADR-0300 결정 5·6) */
async function runConfirm(orderId: string, done: (status: string | undefined) => boolean): Promise<void> {
  try {
    await until(async () => {
      await results.tick();
      await confirmRunner.tick();
      await confirmRunner.whenIdle();
      return done((await adminPay.pool.query<{ status: string }>('select status from payment where order_id = $1', [orderId])).rows[0]?.status);
    }, '결제사 결과', 20_000, 100);
  } catch (e) {
    const pay = (await adminPay.pool.query('select status, failure_category from payment where order_id = $1', [orderId])).rows;
    const job = (await coreAdmin.pool.query('select sent, tries, next_at from merch_confirm_job where order_id = $1', [orderId])).rows;
    const ord = await orderRow(orderId);
    throw new Error(`${String(e)} payment=${JSON.stringify(pay)} job=${JSON.stringify(job)} order=${JSON.stringify(ord)}`);
  }
}
async function pullUntil(orderId: string, status: string): Promise<void> {
  await until(async () => {
    await results.tick();
    return (await orderRow(orderId))?.status === status;
  }, `주문 ${status}`, 20_000, 200);
}

async function pickupOrder(accountId: string, productId: string, slotId: string, quantity = 1): Promise<string> {
  const res = await fanCall(accountId, 'POST', '/v1/shop/orders', { fulfillment: 'PICKUP', pickupSlotId: slotId, items: [{ productId, quantity }] });
  expect(res.statusCode, res.payload).toBe(201);
  return String(json(res).orderId);
}

describe('굿즈 결제 실제 연결(core-svc → payment-svc → 시뮬레이터)', () => {
  test('P-T57 ① P-T56 ⑤⑥ 한정 3개 상품을 주문·결제 시도·접수·승인하면 PAID, product_stock 2, 카운터 2, 예약 원소 0이고 승인 사건은 MERCH·회차 없음·주문 ID 키다', async () => {
    const productId = await createProduct({ name: '한정 응원봉' });
    const slotId = await farSlot(productId);
    const account = randomUUID();
    const orderId = await pickupOrder(account, productId, slotId);
    // 주문 직후: 카운터가 1 깎이고 예약 원소·수량·결제 전 칸이 그 주문을 가리킨다
    expect(await counter(productId)).toBe(LIMITED - 1);
    expect(await resvScore(productId, orderId)).not.toBeNull();
    expect(Number((await resvQty(productId, orderId))?.toString())).toBe(1);
    expect(await unpaidOf(productId, account)).toBe(orderId);

    const a = await pay(account, orderId, 20_000);
    // P-T56 ⑤: 굿즈 복귀 주소(ADR-0299 결정 3), 회차 주소(/booking/…)가 아니다
    expect(a.successUrl).toBe(`${WEB}/shop/checkout/return?order=${orderId}&pg=SIMULATOR`);
    await accept(account, orderId, a, 20_000);
    // 접수 트랜잭션이 PostgreSQL 재고를 깎는다(조건부 갱신)
    expect(await productStock(productId)).toBe(LIMITED - 1);
    await runConfirm(orderId, (s) => s === 'APPROVED');
    await pullUntil(orderId, 'PAID');

    expect(await productStock(productId)).toBe(2);
    expect(await counter(productId)).toBe(2);
    expect(await resvScore(productId, orderId)).toBeNull();
    expect(await resvQty(productId, orderId)).toBeNull();
    expect(await unpaidOf(productId, account)).toBeNull();
    const row = await orderRow(orderId);
    expect(row?.payment_id).toMatch(/^[0-9a-f-]{36}$/);
    const items = (await coreAdmin.pool.query<{ status: string }>('select status from merch_order_item where order_id = $1', [orderId])).rows;
    expect(items.map((i) => i.status)).toEqual(['READY']);

    // P-T56 ⑥: 원장 order_kind MERCH·event_id NULL(ADR-0299 결정 1), Outbox 승인 사건 키 = 주문 ID, orderKind MERCH, eventId 없음
    const ledger = (await adminPay.pool.query<{ order_kind: string; event_id: string | null; id: string }>('select id, order_kind, event_id from payment where order_id = $1', [orderId])).rows;
    expect(ledger).toEqual([{ id: row!.payment_id, order_kind: 'MERCH', event_id: null }]);
    const outByJson = (await adminPay.pool.query<{ topic: string; msg_key: string; payload: Buffer }>('select topic, msg_key, payload from outbox order by seq')).rows.filter((x) => (JSON.parse(x.payload.toString('utf8')) as { orderId?: string }).orderId === orderId);
    expect(outByJson.length).toBeGreaterThan(0);
    for (const m of outByJson) {
      expect(m.topic).toBe('trade.payments');
      expect(m.msg_key).toBe(orderId);
      const v = JSON.parse(m.payload.toString('utf8')) as Record<string, unknown>;
      expect(v.orderKind).toBe('MERCH');
      expect(v.eventId ?? null).toBeNull();
    }
    const approved = outByJson.map((m) => JSON.parse(m.payload.toString('utf8')) as Record<string, unknown>).filter((v) => v.type === 'APPROVED');
    expect(approved).toHaveLength(1);

    // 소비자(purchase-svc 결과 처리기)에 사건 값을 그대로 넘기면 반영하지 않고 payment_result_skipped_total{reason="merch"}가 사건 수만큼 오른다
    const reg = new PlatformMetrics('purchase-svc');
    const skips = new PromPaymentEventSkipSignals().register(reg.registry);
    let applied = 0;
    const handler = new PaymentResultHandler({ execute: async () => void applied++ } as never, skips);
    let offset = 0n;
    for (const m of outByJson) {
      offset += 1n;
      const msg: ConsumedMessage = { topic: 'trade.payments', partition: 0, offset, key: m.msg_key, value: m.payload, headers: {}, timestamp: Date.now() };
      await handler.handle(handler.decode(msg), msg);
    }
    expect(applied).toBe(0);
    const metric = (await reg.registry.getSingleMetric('payment_result_skipped_total')!.get()).values;
    expect(metric.find((x) => x.labels.reason === 'merch')?.value).toBe(outByJson.length);
    expect(metric.find((x) => x.labels.reason === 'unrecognized')?.value).toBe(0);

    // 회차 정산서의 결제 읽기(listEventPayments는 event_id = 회차로 고른다)에 수령 시간대의 회차로 읽어도 이 결제가 0건이다.
    // 정산서 어댑터는 시뮬레이터 결제사를 받지 않으므로(Pg = TOSS·PORTONE) 그 고르기 조건(event_id)을 원장에 직접 묻는다
    expect(await eventPaymentRows(EVENT, row!.payment_id!)).toBe(0);
    // 시뮬레이터 과금은 이 주문 1건
    expect((await simLedger()).filter((x) => x.order_ref === a.checkoutOrderId)).toHaveLength(1);
  }, 120_000);

  test('P-T57 ② 결제사가 거절하면 주문 FAILED, product_stock과 카운터가 3으로 돌아오고 과금이 0건이다', async () => {
    const productId = await createProduct({ name: '한정 머플러' });
    const slotId = await farSlot(productId);
    const account = randomUUID();
    const orderId = await pickupOrder(account, productId, slotId);
    const a = await pay(account, orderId, 20_000);
    await simPost('/sim/faults', { op: 'confirm', orderId: a.checkoutOrderId, kind: 'decline', code: 'REJECT_CARD_PAYMENT' });
    await accept(account, orderId, a, 20_000);
    expect(await productStock(productId)).toBe(LIMITED - 1);
    await runConfirm(orderId, (s) => s === 'FAILED');
    await pullUntil(orderId, 'FAILED');

    expect(await productStock(productId)).toBe(3);
    expect(await counter(productId)).toBe(3);
    expect(await resvScore(productId, orderId)).toBeNull();
    expect(await resvQty(productId, orderId)).toBeNull();
    expect(await unpaidOf(productId, account)).toBeNull();
    expect((await simLedger()).filter((x) => x.order_ref === a.checkoutOrderId)).toEqual([]);
    // 같은 계정이 다시 살 수 있다(결제 전 주문 칸이 비었다)
    const again = await pickupOrder(account, productId, slotId);
    expect(again).not.toBe(orderId);
    expect(await counter(productId)).toBe(2);
  }, 120_000);

  test('V-T35 ① 실제 ticket-svc로 보유를 확인해 부가 상품을 사고, 결제 뒤 그 티켓의 부가 상품 목록에 보이며, 회차 정산서 결제 읽기에는 0건이다', async () => {
    const holder = randomUUID();
    const issued = await tickets.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: holder, seatIds: [randomUUID()], issueGeneration: 0 });
    const ticketId = issued.tickets[0]!.ticketId;
    const productId = await createProduct({ type: 'PARKING', name: '주차권', price: 15_000, ticketLinked: true, linkedEventId: EVENT, fulfillments: ['WALLET'], limitedQty: null, shippingFee: 0 });

    // 티켓이 없는 계정은 404(남의 티켓·없는 티켓 같은 답)이고 주문이 생기지 않는다
    const stranger = randomUUID();
    const refused = await fanCall(stranger, 'POST', `/v1/tickets/${ticketId}/addons`, { productId, quantity: 1 });
    expect(refused.statusCode, refused.payload).toBe(404);
    expect(json(refused).type).toBe('not-found');
    expect(Number((await coreAdmin.pool.query('select count(*)::int n from merch_order where account_id = $1', [stranger])).rows[0].n)).toBe(0);

    const created = await fanCall(holder, 'POST', `/v1/tickets/${ticketId}/addons`, { productId, quantity: 1 });
    expect(created.statusCode, created.payload).toBe(201);
    const view = json(created) as { orderId: string; fulfillment: string };
    expect(view.fulfillment).toBe('WALLET');
    const item = (await coreAdmin.pool.query<{ linked_ticket_id: string }>('select linked_ticket_id from merch_order_item where order_id = $1', [view.orderId])).rows;
    expect(item).toEqual([{ linked_ticket_id: ticketId }]);

    const a = await pay(holder, view.orderId, 15_000);
    await accept(holder, view.orderId, a, 15_000);
    await runConfirm(view.orderId, (s) => s === 'APPROVED');
    await pullUntil(view.orderId, 'PAID');

    const list = await fanCall(holder, 'GET', `/v1/tickets/${ticketId}/addons`);
    expect(list.statusCode, list.payload).toBe(200);
    const items = (json(list) as { items: Array<{ orderId: string | null; productId: string; quantity: number }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ orderId: view.orderId, productId, quantity: 1 });
    // 보유자가 아닌 계정은 그 티켓의 목록을 보지 못한다
    expect((await fanCall(stranger, 'GET', `/v1/tickets/${ticketId}/addons`)).statusCode).toBe(404);

    // ADR-0299 결정 1: 연결 회차가 있는 부가 상품도 원장은 MERCH·event_id NULL이라 회차 정산서에 걸리지 않는다
    const paymentId = (await orderRow(view.orderId))!.payment_id!;
    expect((await adminPay.pool.query('select order_kind, event_id from payment where id = $1', [paymentId])).rows).toEqual([{ order_kind: 'MERCH', event_id: null }]);
    expect(await eventPaymentRows(EVENT, paymentId)).toBe(0);
  }, 120_000);

  test('P-T58 ①④⑤ 금요일 21:00 KST에 끝난 현장 수령 주문: 토요일은 그대로, 월요일에 받지 않은 항목 금액만 실제 CancelPayment로 취소하고 두 번 돌려도 시뮬레이터 취소는 1건이다', async () => {
    // 지금 뒤의 첫 금요일 21:00 KST(= 그날 12:00Z, 지금 + 1시간보다 뒤)
    const now = Date.now();
    let fri = Date.UTC(new Date(now + 9 * 3_600_000).getUTCFullYear(), new Date(now + 9 * 3_600_000).getUTCMonth(), new Date(now + 9 * 3_600_000).getUTCDate(), 12);
    while (new Date(fri).getUTCDay() !== 5 || fri <= now + 3_600_000) fri += 86_400_000;
    const satRun = fri + 13 * 3_600_000; // 토요일 10:00 KST
    const monRun = fri + 61 * 3_600_000; // 월요일 10:00 KST

    const pa = await createProduct({ name: '현장 수령 포스터', price: 20_000 });
    const pb = await createProduct({ name: '현장 수령 스티커', price: 7_000, limitedQty: null });
    const slotA = await slot(pa, new Date(fri - 3 * 3_600_000), new Date(fri));
    await slot(pb, new Date(fri - 3 * 3_600_000), new Date(fri));
    const account = randomUUID();
    const res = await fanCall(account, 'POST', '/v1/shop/orders', { fulfillment: 'PICKUP', pickupSlotId: slotA, items: [{ productId: pa, quantity: 1 }, { productId: pb, quantity: 2 }] });
    expect(res.statusCode, res.payload).toBe(201);
    const orderId = String(json(res).orderId);
    const total = 20_000 + 7_000 * 2;
    const a = await pay(account, orderId, total);
    await accept(account, orderId, a, total);
    await runConfirm(orderId, (s) => s === 'APPROVED');
    await pullUntil(orderId, 'PAID');
    // ④ 스티커(B)는 현장에서 받았다(교환권 확인 I4)
    await coreAdmin.pool.query("update merch_order_item set status = 'PICKED_UP', picked_up_at = now() where order_id = $1 and product_id = $2", [orderId, pb]);
    const stockBefore = { a: await productStock(pa), counterA: await counter(pa) };
    const snapshot = async () => (await coreAdmin.pool.query('select product_id, status, cancel_reason, refunded_amount from merch_order_item where order_id = $1 order by product_id', [orderId])).rows;
    const beforeRows = await snapshot();

    // ① 토요일 10:00 KST: 영업일이 아니라 바뀐 행이 없고 결제 취소가 없다
    offsetMs = satRun - Date.now();
    expect(await unclaimed.run()).toEqual({ skipped: 'not-business-day' });
    expect(await snapshot()).toEqual(beforeRows);
    expect((await simPayment(a.paymentKey)).cancels ?? []).toEqual([]);

    // ① 월요일 10:00 KST: 받지 않은 포스터(A)만 CANCELLED를 거쳐 REFUNDED(cancel_reason UNCLAIMED), 금액은 A 단가 × 수량(④)
    offsetMs = monRun - Date.now();
    const first = await unclaimed.run();
    expect(first).toEqual({ cancelled: 1, refunds: 1 });
    const after = await snapshot();
    const rowA = after.find((x) => x.product_id === pa);
    const rowB = after.find((x) => x.product_id === pb);
    expect(rowA).toMatchObject({ status: 'REFUNDED', cancel_reason: 'UNCLAIMED', refunded_amount: 20_000 });
    expect(rowB).toMatchObject({ status: 'PICKED_UP', cancel_reason: null, refunded_amount: 0 });
    const simPay = await simPayment(a.paymentKey);
    expect((simPay.cancels ?? []).map((c) => c.cancelAmount)).toEqual([20_000]);
    expect(simPay.balanceAmount).toBe(total - 20_000);
    // 재고는 돌리지 않는다
    expect(await productStock(pa)).toBe(stockBefore.a);
    expect(await counter(pa)).toBe(stockBefore.counterA);

    // ⑤ 월요일에 두 번 돌려도 결제 취소는 1건이다
    const second = await unclaimed.run();
    expect(second).toEqual({ cancelled: 0, refunds: 0 });
    expect(((await simPayment(a.paymentKey)).cancels ?? []).map((c) => c.cancelAmount)).toEqual([20_000]);
    expect(await snapshot()).toEqual(after);
    offsetMs = 0;
  }, 120_000);

  test('P-T77 ② 실제 PrepareCheckout 재생은 같은 시도 ID·결제사로 결제창 값을 다시 만들고 멱등 기록에는 시도 ID만 남으며 그 값으로 결제 접수·승인이 된다 [ASVS v5.0.0-8.2.2]', async () => {
    const productId = await createProduct({ name: '재생 실제 연결 굿즈' });
    const slotId = await farSlot(productId);
    const account = randomUUID();
    const orderId = await pickupOrder(account, productId, slotId);
    const key = randomUUID();
    const keyed = () =>
      core.http.inject({
        method: 'POST',
        url: `/v1/shop/orders/${orderId}/payments`,
        headers: { ...fanHeaders(account), 'content-type': 'application/json', 'idempotency-key': key },
        payload: '{}',
      });
    type View = { attemptId: string; pg: string; checkout: { clientKey: string; customerKey: string; orderId: string; amount: number; successUrl: string } };
    const first = await keyed();
    expect(first.statusCode, first.payload).toBe(201);
    const firstView = json(first) as View;
    expect(firstView.pg).toBe('SIMULATOR');
    expect(firstView.checkout.successUrl).toBe(`${WEB}/shop/checkout/return?order=${orderId}&pg=SIMULATOR`);
    const row = (
      await coreAdmin.pool.query('select result_ref from idempotency_record where account_ref = $1 and operation = $2 and idempotency_key = $3', [account, 'START_MERCH_PAYMENT', key])
    ).rows[0] as { result_ref: string };
    expect(row.result_ref).toBe(firstView.attemptId);
    for (const token of ['clientKey', 'customerKey', 'successUrl', 'failUrl', 'redirectUrl', 'totalAmount', '"checkout"']) {
      expect(row.result_ref.includes(token), `기록에 ${token}`).toBe(false);
    }

    const again = await keyed();
    expect(again.statusCode, again.payload).toBe(201);
    const againView = json(again) as View;
    expect({ attemptId: againView.attemptId, pg: againView.pg, orderId: againView.checkout.orderId, amount: againView.checkout.amount }).toEqual({
      attemptId: firstView.attemptId,
      pg: 'SIMULATOR',
      orderId,
      amount: 20_000,
    });
    // 실제 PrepareCheckout을 다시 불러 시뮬레이터가 구매자 키를 새로 만들었다(저장값을 돌려주지 않는다)
    expect(againView.checkout.customerKey).not.toBe(firstView.checkout.customerKey);
    expect(againView.checkout.successUrl).toBe(firstView.checkout.successUrl);
    expect((await coreAdmin.pool.query('select count(*)::int as n from merch_payment_attempt where order_id = $1', [orderId])).rows[0].n).toBe(1);

    // 재생이 다시 만든 값으로 결제사 인증 → 접수 → 승인까지 간다(같은 시도 ID가 쓰인다)
    const paymentKey = await simAuth({ orderId: againView.checkout.orderId, amount: againView.checkout.amount, orderName: '시험 굿즈' });
    await accept(account, orderId, { paymentKey, attemptId: againView.attemptId }, againView.checkout.amount);
    await runConfirm(orderId, (s) => s === 'APPROVED');
    await pullUntil(orderId, 'PAID');
    expect((await adminPay.pool.query('select count(*)::int as n from payment where order_id = $1', [orderId])).rows[0].n).toBe(1);
  }, 120_000);
});
