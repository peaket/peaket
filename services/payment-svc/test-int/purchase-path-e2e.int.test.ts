// 구매 경로 실제 연결 시험(BUILD_ORDER HOT-070·HOT-358 시범 묶음). 가짜 API 대신 실제 서비스를 잇는다:
// purchase-svc HTTP(홀드·다시 읽기·연장·주문·결제 시도·결제 접수, 실제 Valkey·PostgreSQL)
// → 실제 gRPC PrepareCheckout(payment-svc) → 시뮬레이터 인증(/sim/authenticate, 결제창 대신)
// → 실제 gRPC ConfirmPayment → 승인 실행기 → PG 시뮬레이터 HTTP 승인 → payment-svc Outbox의 PaymentEvent → purchase-svc 결과 반영.
// Kafka만 빠진다(이 PC에서 네이티브 모듈이 막혀 있어 Outbox 행의 값을 소비 처리기에 그대로 넘긴다).
import 'reflect-metadata';
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { type ConsumedMessage, createDatabase, createHotRedis, createPlatformLogger, createService, type Database, ensureOutboxPartitions, type HotRedis, PlatformMetrics, purchaseMac, purchaseMacInput, purchaseRequestKey, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../../purchase-svc/src/app.module.js';
import { migratePurchase } from '../../purchase-svc/scripts/migrate.mjs';
import {
  ApplyPaymentResult,
  discardBehaviorSignals,
  DrizzleOrderAccepts,
  DrizzleOrderStarts,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  DrizzlePaymentResults,
  DrizzleSaga,
  GrpcPaymentCheckouts,
  GrpcPaymentConfirms,
  InventoryOrderHoldExpiries,
  InventoryOrderSeatPins,
  InventoryOrderSessions,
  InventoryPaymentResultSessions,
  InventorySeatSlots,
  missingContactRefs,
  OrderSagaRunner,
  PaymentResultHandler,
  RedisBookingRestrictions,
  SeatMapSaleConfigs,
  SeatMapSagaConfigs,
  type StartPaymentSignals,
} from '../../purchase-svc/src/modules/booking/index.js';
import { DrizzleSeatSales, EndPurchaseSession, KEEP_AFTER_SALE_END_MS, ManageHolds, MemorySeatMap, OpenPurchaseSession, RecordingHoldAttempts, RedisHoldLifecycle, RedisOrderHolds, RedisPurchaseSessionStore, RedisSeatSlots, RedisSeatStore, RedisSessionEndedLog, seatKeys, ServerEcdhKey, StoredPurchaseSessions } from '../../purchase-svc/src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from '../../purchase-svc/test/admission-fixtures.js';
import { clientKeyOf } from '../../purchase-svc/test/session-fixtures.js';
import { startValkey, type ValkeyContainer } from '../../purchase-svc/test-int/valkey.js';
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  CachedEntryPauseReader,
  CachedPgSelectionReader,
  CancelDepositPayment,
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

const CONSENT = '2026-10-30';
const WEB = 'https://www.it.example';
const SIM_KEY = 'sim_sk_e2e_only';

let pgc: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let sim: SimulatorApp;
let simUrl: string;
let adminP: Database;
let adminPay: Database;
let purchaseDb: Database;
let payHot: Database;
let closeAll: (() => Promise<void>)[] = [];
let svc: Awaited<ReturnType<typeof createService>>;
let confirmRunner: PaymentConfirmRunner;
let saga: OrderSagaRunner;
let results: PaymentResultHandler;
let opener: OpenPurchaseSession;
let mismatch = 0;

const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const seatMap = new MemorySeatMap();
const admissionKey = newKey('k1');
const serverPriv = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const serverPub = createPublicKey({ key: serverPriv.publicJwk(), format: 'jwk' });

async function dbUrl(base: string, name: string): Promise<string> {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'fulfilled') pgc = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  for (const r of [p, v]) if (r.status === 'rejected') throw r.reason as Error;

  redis = await createHotRedis({ url: valkey!.url });
  sim = buildSimulatorApp({ secretKey: SIM_KEY });
  simUrl = await sim.listen({ host: '127.0.0.1', port: 0 });

  const root = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'e2e-root' });
  await root.pool.query('create database purchase_e2e');
  await root.pool.query('create database payment_e2e');
  await root.close();
  const purchaseUrl = await dbUrl(pgc!.url, 'purchase_e2e');
  const paymentUrl = await dbUrl(pgc!.url, 'payment_e2e');
  await migratePurchase(purchaseUrl);
  await migratePayment(paymentUrl);
  adminP = createDatabase({ url: purchaseUrl, profile: 'general', max: 4, applicationName: 'e2e-admin-p' });
  adminPay = createDatabase({ url: paymentUrl, profile: 'general', max: 4, applicationName: 'e2e-admin-pay' });
  await ensureOutboxPartitions(adminP, systemClock);
  await ensureOutboxPartitions(adminPay, systemClock);
  purchaseDb = createDatabase({ url: purchaseUrl, profile: 'general', max: 10, applicationName: 'e2e-purchase' });
  payHot = createDatabase({ url: paymentUrl, profile: 'general', max: 10, applicationName: 'e2e-pay' });

  // payment-svc: 실제 쓰임새·gRPC 서버·시뮬레이터 어댑터
  const metrics = new PlatformMetrics('payment-svc');
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: systemClock, level: 'fatal', destination: quiet });
  const cmdSignals = new PromPaymentCommandSignals();
  cmdSignals.register(metrics.registry);
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const store = new DrizzlePaymentStore({ database: payHot, batchDatabase: payHot });
  const gateway = new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: SIM_KEY, clientKey: 'sim_ck_e2e' });
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
  const handlers = paymentServiceHandlers({ accept: new AcceptPaymentCommand({ store, clock: systemClock, log: paymentCommandLog(logger), signals: cmdSignals }), batchGet: new BatchGetPaymentStates({ reader: store, signals: cmdSignals }), prepareCheckout }, () => undefined);
  const grpcServer = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
  closeAll.push(() => grpcServer.close());
  const address = `127.0.0.1:${grpcServer.port}`;
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: systemClock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger) });
  const confirmJobs = new DrizzleConfirmJobs({ database: payHot, clock: systemClock });
  confirmRunner = new PaymentConfirmRunner({
    jobs: confirmJobs,
    gateways,
    log: paymentConfirmLog(logger),
    signals: new PromPaymentConfirmSignals().register(metrics.registry),
    clock: systemClock,
    podId: 'e2e-pay',
    guards,
    disallowedDeposit: async (i: { paymentId: string }) => {
      await new CancelDepositPayment({ store: confirmJobs, gateways, guards, signals: { cancel: () => {} } as never, clock: systemClock }).execute({ paymentId: i.paymentId, cancellationId: i.paymentId, reason: '가상계좌를 받지 않는 공연' });
    },
    timer: { setInterval: () => 0, clearInterval: () => {} },
  } as never);

  // purchase-svc: 실제 HTTP·Lua·DB·gRPC 클라이언트
  const sessionStore = new RedisPurchaseSessionStore(redis);
  const sessions = new StoredPurchaseSessions({ store: sessionStore, ecdh: serverPriv, clock: systemClock });
  const startedLog = { appendStarted: async () => undefined };
  const keys = new Map([['k1', admissionKey.pub]]);
  opener = new OpenPurchaseSession({ store: sessionStore, log: startedLog, keys, issuer: ISS, clock: systemClock });
  const orderStore = new DrizzleOrderStore({ clock: systemClock });
  const manageHolds = new ManageHolds({ lifecycle: new RedisHoldLifecycle(redis), seatMap, sessions: sessionStore, keys, issuer: ISS, clock: systemClock });
  const checkouts = new GrpcPaymentCheckouts({ address });
  const confirms = new GrpcPaymentConfirms({ address });
  closeAll.push(async () => {
    checkouts.close();
    confirms.close();
  });
  const startSignals: StartPaymentSignals = { paymentAttempt: () => {}, telemetryDropped: () => {} };
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      redis,
      seatMap,
      attempts: new RecordingHoldAttempts(),
      podId: 'pod-e2e',
      sessions,
      admission: { store: sessionStore, startedLog, endedLog: new RedisSessionEndedLog(redis), keys, issuer: ISS, manageHolds },
      booking: {
        startPayment: { starts: new DrizzleOrderStarts({ database: purchaseDb, store: orderStore, clock: systemClock }), checkouts, holdExpiries: new InventoryOrderHoldExpiries(new RedisOrderHolds(redis, seatMap)), behavior: discardBehaviorSignals, signals: startSignals },
        writes: new DrizzleOrderWrites({ database: purchaseDb, store: orderStore, clock: systemClock }),
        accepts: new DrizzleOrderAccepts({ database: purchaseDb, store: orderStore, clock: systemClock }),
        slots: new InventorySeatSlots(new RedisSeatSlots(redis)),
        holds: new RedisOrderHolds(redis, seatMap),
        holdMarks: manageHolds,
        saleConfigs: new SeatMapSaleConfigs(seatMap),
        sessions: new InventoryOrderSessions({ sessions, store: sessionStore }),
        identity: { check: async (q) => ({ status: 'VERIFIED', pid: pidOf.get(q.accountId) ?? '' }) },
        contactRefs: missingContactRefs,
        restrictions: new RedisBookingRestrictions(redis),
        signals: { historyMismatch: () => {} },
        log: { identityFallback: () => {}, configError: () => {}, payingMarkFailed: () => {} },
        acceptLog: { attemptMismatch: () => void mismatch++ },
        consentVersion: CONSENT,
        clock: systemClock,
        onAccepted: (orderId) => saga.kick(orderId),
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock: systemClock,
    logDestination: quiet,
  });
  const sales = new DrizzleSeatSales(purchaseDb);
  const sagaStore = new DrizzleSaga({ database: purchaseDb, store: orderStore, sales, clock: systemClock });
  saga = new OrderSagaRunner({
    jobs: sagaStore,
    orders: sagaStore,
    reserve: sagaStore,
    failures: sagaStore,
    confirmSent: sagaStore,
    pins: new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap }),
    confirms,
    configs: new SeatMapSagaConfigs(seatMap),
    log: { sagaFailure: () => {} } as never,
    clock: systemClock,
    timer: { setInterval: () => 1, clearInterval: () => {} },
  } as never);
  const payResults = new DrizzlePaymentResults({ database: purchaseDb, store: orderStore, sales, clock: systemClock });
  const resultSessions = new InventoryPaymentResultSessions({ end: new EndPurchaseSession({ store: sessionStore, ended: new RedisSessionEndedLog(redis), clock: systemClock }), store: sessionStore });
  results = new PaymentResultHandler(new ApplyPaymentResult({ reads: payResults, writes: payResults, sessions: resultSessions, saga, log: { applied: () => {} } as never, clock: systemClock } as never));
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  for (const f of closeAll) await f().catch(() => undefined);
  await sim?.close();
  await Promise.allSettled([redis?.close(), adminP?.close(), adminPay?.close(), purchaseDb?.close(), payHot?.close()]);
  valkey?.stop();
  pgc?.stop();
});

const pidOf = new Map<string, string>();
const PRICES = { R: 150_000 };
const SEAT_COUNT = 8;

async function world(): Promise<{ eventId: string; seats: string[] }> {
  const eventId = randomUUID();
  const seats = Array.from({ length: SEAT_COUNT }, () => randomUUID()).sort();
  seatMap.put(
    { eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: Date.now() + 2 * 86400_000, tierPrices: { ...PRICES }, tierNames: { R: 'R석' }, orderName: '시범 공연', virtualAccountAllowed: false },
    seats.map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R', label: `A구역 ${i + 1}번` })),
  );
  await new RedisSeatStore(redis).openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + 2 * 86400_000 + KEEP_AFTER_SALE_END_MS });
  return { eventId, seats };
}

interface Fan {
  eventId: string;
  accountId: string;
  login: string;
  pid: string;
  jti: string;
  token: string;
  macKey: Buffer;
  seq: number;
}

async function fan(eventId: string, accountId: string = randomUUID()): Promise<Fan> {
  const jti = randomUUID();
  const login = randomUUID();
  const pid = pidOf.get(accountId) ?? `pid-${randomUUID()}`;
  pidOf.set(accountId, pid);
  const token = signAdmission(admissionKey, claimsOf({ nowMs: Date.now(), jti, accountId, loginSessionId: login, eventId }, { jny: randomUUID() }));
  const client = clientKeyOf();
  await opener.execute({ token, accountId, loginSessionId: login, eventId, clientKey: client.text });
  const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), jti));
  return { eventId, accountId, login, pid, jti, token, macKey, seq: 0 };
}

function call(f: Fan, method: 'POST' | 'DELETE' | 'GET', url: string, body?: unknown, o: { idem?: string; unsigned?: boolean } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'x-user-id': f.accountId, 'x-session-id': f.login, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': f.pid, 'x-admission-token': f.token };
  if (payload) headers['content-type'] = 'application/json';
  if (o.idem) headers['idempotency-key'] = o.idem;
  if (!o.unsigned) {
    const n = ++f.seq;
    headers['x-purchase-seq'] = String(n);
    headers['x-purchase-mac'] = purchaseMac(f.macKey, purchaseMacInput(method, url, n, Buffer.from(payload ?? '', 'utf8')));
  }
  return svc.http.inject({ method, url, headers, ...(payload ? { payload } : {}) });
}
const json = (r: { payload: string }) => {
  const v = JSON.parse(r.payload) as Record<string, unknown>;
  if (typeof v.type === 'string') v.type = v.type.split('/').pop();
  return v;
};

async function sim_(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${simUrl}${path}`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${SIM_KEY}:`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

describe('실제 연결: 홀드 → 주문 → 결제 시도 → 결제창 준비 → 승인 결과', () => {
  test('HOT070_HOT358_ 실제 서비스를 지나 주문이 승인되고 좌석이 팔린다', async () => {
    const w = await world();
    const f = await fan(w.eventId);

    // 홀드 → 다시 읽기(응답 칸 seats·totalAmount, 서명 없음) → 연장
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[0]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    const hold = json(held) as { holdId: string; seats: { label: string; price: number; tierName: string }[]; totalAmount: number; expiresAt: string };
    expect(hold.seats[0]).toMatchObject({ label: 'A구역 1번', price: 150_000, tierName: 'R석' });
    expect(hold.totalAmount).toBe(150_000);
    const seqBeforeRead = f.seq;
    const read = await call(f, 'GET', `/v1/holds/${hold.holdId}`, undefined, { unsigned: true });
    expect(read.statusCode, read.payload).toBe(200);
    expect(f.seq).toBe(seqBeforeRead);
    expect(json(read)).toMatchObject({ holdId: hold.holdId, extendable: true, expiresAt: hold.expiresAt });
    const ext = await call(f, 'POST', `/v1/holds/${hold.holdId}/extension`);
    expect(ext.statusCode, ext.payload).toBe(200);
    expect(Date.parse(String(json(ext).expiresAt)) - Date.parse(hold.expiresAt)).toBe(180_000);
    const ext2 = await call(f, 'POST', `/v1/holds/${hold.holdId}/extension`);
    expect(ext2.statusCode).toBe(409);
    expect(json(ext2).type).toBe('hold-already-extended');

    // 다른 계정은 같은 holdId를 읽지 못한다(소유 확인)
    const other = await fan(w.eventId);
    expect((await call(other, 'GET', `/v1/holds/${hold.holdId}`, undefined, { unsigned: true })).statusCode).toBe(404);
    expect((await call(other, 'DELETE', `/v1/holds/${hold.holdId}`)).statusCode).toBe(404);

    // 주문 → 결제 시도(실제 PrepareCheckout)
    const orderBody = { holdId: hold.holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } };
    const ordered = await call(f, 'POST', '/v1/orders', orderBody, { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    expect(Number(await redis.command(['ZSCORE', seatKeys.ordered(w.eventId), '0'], { key: seatKeys.ordered(w.eventId) }))).toBeGreaterThan(0);
    // 다른 멱등 키로 같은 홀드를 다시 주문하면 409이고 같은 세션이면 주문 ID를 함께 준다(ADR-0255)
    const again = await call(f, 'POST', '/v1/orders', { ...orderBody, buyer: { name: '김피켓', phone: '010-9999-8888' } }, { idem: randomUUID() });
    expect(again.statusCode, again.payload).toBe(409);
    expect(json(again)).toMatchObject({ type: 'hold-already-ordered', orderId });

    const attemptRes = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(attemptRes.statusCode, attemptRes.payload).toBe(201);
    const attempt = json(attemptRes) as { attemptId: string; pg: string; checkout: { amount: number; orderId: string; successUrl: string } };
    expect(attempt.pg).toBe('SIMULATOR');
    expect(attempt.checkout.amount).toBe(150_000);
    expect(attempt.checkout.successUrl.startsWith(WEB)).toBe(true);

    // 결제창(시뮬레이터 인증) → 접수. 금액·attemptId는 서버가 대조한다
    const { paymentKey } = (await sim_('/sim/authenticate', { orderId: attempt.checkout.orderId, amount: attempt.checkout.amount, orderName: '시범 공연' })) as { paymentKey: string };
    const wrongAttempt = await call(f, 'POST', `/v1/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: 150_000, attemptId: randomUUID() }, { idem: randomUUID() });
    expect(wrongAttempt.statusCode).toBe(409);
    expect(json(wrongAttempt).type).toBe('payment-attempt-mismatch');
    const accepted = await call(f, 'POST', `/v1/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: 150_000, attemptId: attempt.attemptId }, { idem: randomUUID() });
    expect(accepted.statusCode, accepted.payload).toBe(202);

    // Saga(실제 묶기·판매 예약·ConfirmPayment gRPC)
    await until(async () => (await adminP.pool.query('select status from purchase_order where id = $1', [orderId])).rows[0]?.status === 'RESERVED', 'RESERVED', 20_000, 50);
    expect((await redis.command(['HGET', seatKeys.hold(w.eventId, 0), 'pin'], { key: seatKeys.hold(w.eventId, 0) }))?.toString()).toBe('1');
    // 묶인 뒤에는 해제·연장되지 않고, 다른 사람도 잡지 못한다(좌석이 두 번 팔리지 않음)
    expect((await call(f, 'DELETE', `/v1/holds/${hold.holdId}`)).statusCode).toBe(409);
    expect((await call(other, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[0]] }, { idem: randomUUID() })).statusCode).toBe(409);

    // 승인 실행기 → 시뮬레이터 승인 → Outbox PaymentEvent
    await until(async () => {
      await confirmRunner.tick();
      await confirmRunner.whenIdle();
      return (await adminPay.pool.query('select status from payment where order_id = $1', [orderId])).rows[0]?.status === 'APPROVED';
    }, '승인', 20_000, 100);
    const rows = (await adminPay.pool.query<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by seq', [w.eventId])).rows;
    expect(rows.length).toBeGreaterThan(0);
    let offset = 0n;
    for (const r of rows) {
      offset += 1n;
      const m: ConsumedMessage = { topic: 'trade.payments', partition: 0, offset, key: w.eventId, value: r.payload, headers: {}, timestamp: Date.now() };
      await results.handle(results.decode(m), m);
    }
    await until(async () => (await adminP.pool.query('select status from purchase_order where id = $1', [orderId])).rows[0]?.status === 'APPROVED', '주문 승인', 10_000, 50);
    const sold = (await adminP.pool.query("select count(*)::int n from seat_sale where event_id = $1 and status = 'SOLD'", [w.eventId])).rows[0] as { n: number };
    expect(sold.n).toBe(1);
    expect(mismatch).toBe(1);
    // 시뮬레이터 비밀 키가 응답에 실리지 않았다
    expect(attemptRes.payload).not.toContain(SIM_KEY);
    expect(createHash('sha256').update(attemptRes.payload).digest('hex')).toHaveLength(64);
  }, 120_000);

  test('H2 P-T9 POL-014 가상계좌를 끈 회차에서 SDK를 직접 불러 가상계좌로 승인되면 입금 전 취소로 주문을 끝내고 좌석을 푼다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[3]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    const holdId = String(json(held).holdId);
    const ordered = await call(f, 'POST', '/v1/orders', { holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } }, { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    const started = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(started.statusCode, started.payload).toBe(201);
    const a = json(started) as { attemptId: string; checkout: { orderId: string; amount: number } };
    // 브라우저 검사를 지나치고 시뮬레이터에 가상계좌로 인증한다(SDK 직접 호출과 같은 상황)
    const { paymentKey } = (await sim_('/sim/authenticate', { orderId: a.checkout.orderId, amount: a.checkout.amount, method: '가상계좌' })) as { paymentKey: string };
    const accepted = await call(f, 'POST', `/v1/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: 150_000, attemptId: a.attemptId }, { idem: randomUUID() });
    expect(accepted.statusCode, accepted.payload).toBe(202);
    await until(async () => (await adminP.pool.query('select status from purchase_order where id = $1', [orderId])).rows[0]?.status === 'RESERVED', 'RESERVED', 20_000, 50);
    await until(async () => {
      await confirmRunner.tick();
      await confirmRunner.whenIdle();
      return (await adminPay.pool.query('select status from payment where order_id = $1', [orderId])).rows[0]?.status !== 'ACCEPTED';
    }, '승인 처리', 20_000, 100);
    await until(async () => (await adminPay.pool.query('select status from payment where order_id = $1', [orderId])).rows[0]?.status === 'FAILED', '입금 전 취소', 10_000, 100);
    const rows = (await adminPay.pool.query<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by seq', [w.eventId])).rows;
    let offset = 0n;
    for (const r of rows) {
      offset += 1n;
      const m: ConsumedMessage = { topic: 'trade.payments', partition: 0, offset, key: w.eventId, value: r.payload, headers: {}, timestamp: Date.now() };
      await results.handle(results.decode(m), m);
    }
    await until(async () => (await adminP.pool.query('select status from purchase_order where id = $1', [orderId])).rows[0]?.status === 'FAILED', '주문 실패', 10_000, 50);
    expect((await adminP.pool.query("select count(*)::int n from seat_sale where event_id = $1 and status in ('PENDING','SOLD')", [w.eventId])).rows[0]).toEqual({ n: 0 });
    await until(async () => Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '3'], { key: seatKeys.bitmap(w.eventId) })) === 0, '좌석 해제', 15_000, 100);
  }, 120_000);

  test('L1 시도가 둘 이상이면 attemptId 없는 접수를 받지 않는다. L4 결제 시도 시작이 주문 뒤 표시를 복구한다. L14 형식 틀린 holdId는 404다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[4]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    const holdId = String(json(held).holdId);
    expect((await call(f, 'GET', '/v1/holds/bad~id', undefined, { unsigned: true })).statusCode).toBe(404);
    expect((await call(f, 'DELETE', '/v1/holds/bad~id')).statusCode).toBe(404);
    const ordered = await call(f, 'POST', '/v1/orders', { holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } }, { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    const key = seatKeys.ordered(w.eventId);
    await redis.command(['ZREM', key, '4'], { key });
    const first = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(first.statusCode, first.payload).toBe(201);
    expect(await redis.command(['ZSCORE', key, '4'], { key })).not.toBeNull();
    const second = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(second.statusCode, second.payload).toBe(201);
    const a = json(second) as { checkout: { orderId: string; amount: number } };
    const { paymentKey } = (await sim_('/sim/authenticate', { orderId: a.checkout.orderId, amount: a.checkout.amount })) as { paymentKey: string };
    const noAttempt = await call(f, 'POST', `/v1/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: a.checkout.amount }, { idem: randomUUID() });
    expect(noAttempt.statusCode, noAttempt.payload).toBe(409);
    expect(json(noAttempt).type).toBe('payment-attempt-mismatch');
  }, 60_000);

  test('P-T49 HOT070_ 예매 제한 403은 그 세션의 홀드를 풀고 해제는 같은 계정의 재홀드를 30초 막는다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[1]] }, { idem: randomUUID() });
    expect(held.statusCode).toBe(201);
    const holdId = String(json(held).holdId);
    await redis.command(['HSET', `s:rst:${f.accountId}`, 'st', 'ACTIVE', 'rid', 'r1', 'ver', '1'], { key: `s:rst:${f.accountId}` });
    const blocked = await call(f, 'POST', '/v1/orders', { holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } }, { idem: randomUUID() });
    expect(blocked.statusCode, blocked.payload).toBe(403);
    expect(json(blocked).type).toBe('booking-restricted');
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '1'], { key: seatKeys.bitmap(w.eventId) }))).toBe(0);
    const again = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[1]] }, { idem: randomUUID() });
    expect(again.statusCode).toBe(409);
    expect(json(again).type).toBe('seat-recently-released');
    expect((await call(f, 'GET', `/v1/holds/${holdId}`, undefined, { unsigned: true })).statusCode).toBe(404);
  }, 60_000);

  test('S-T33 ⑥ S-T29 구매 세션을 나가면(LEFT) 그 세션의 홀드가 풀리고, 같은 계정의 새 세션도 30초 동안 다시 잡지 못한다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[2]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    const left = await call(f, 'DELETE', `/v1/events/${w.eventId}/purchase-session`);
    expect(left.statusCode, left.payload).toBe(204);
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '2'], { key: seatKeys.bitmap(w.eventId) }))).toBe(0);
    const again = await fan(w.eventId, f.accountId);
    const retry = await call(again, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[2]] }, { idem: randomUUID() });
    expect(retry.statusCode, retry.payload).toBe(409);
    expect(json(retry).type).toBe('seat-recently-released');
  }, 60_000);
});
