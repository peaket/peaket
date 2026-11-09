// 구매 경로 실제 연결 시험(BUILD_ORDER HOT-070·HOT-358 시범 묶음). 가짜 API 대신 실제 서비스를 잇는다:
// purchase-svc HTTP(홀드·다시 읽기·연장·주문·결제 시도·결제 접수, 실제 Valkey·PostgreSQL)
// → 실제 gRPC PrepareCheckout(payment-svc) → 시뮬레이터 인증(/sim/authenticate, 결제창 대신)
// → 실제 gRPC ConfirmPayment → 승인 실행기 → PG 시뮬레이터 HTTP 승인 → payment-svc Outbox의 PaymentEvent → purchase-svc 결과 반영.
// Kafka만 빠진다(이 PC에서 네이티브 모듈이 막혀 있어 Outbox 행의 값을 소비 처리기에 그대로 넘긴다).
import 'reflect-metadata';
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
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
  DrizzlePaymentStatus,
  PaymentStatusWaitTable,
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
import { DrizzleSeatSales, EndPurchaseSession, ExpirySweeper, HoldPauseView, KEEP_AFTER_SALE_END_MS, ManageHolds, type PaymentPauseAnswer, RedisSweepLeases, MemorySeatMap, OpenPurchaseSession, RecordingHoldAttempts, RedisHoldLifecycle, RedisOrderHolds, RedisPurchaseSessionStore, RedisSeatSlots, RedisSeatStore, RedisSessionEndedLog, seatKeys, ServerEcdhKey, StoredPurchaseSessions } from '../../purchase-svc/src/modules/inventory/index.js';
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
  PaymentUnknownResolver,
  paymentUnknownLog,
  PromPaymentUnknownSignals,
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
const WEB = process.env.PEAKET_LOCAL_WEB ?? 'https://www.it.example';
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
let unknownResolver: PaymentUnknownResolver;
let redisGate: RedisGate;

/** 앱과 Valkey 사이의 TCP 중계(새 패키지 없이 연결을 끊는다, BUILD_ORDER HOT-358 리뷰 V4) */
interface RedisGate {
  url: string;
  /** n번째 명령 덩어리를 보낸 뒤 연결을 끊고 막는다 */
  cutAfter(n: number): void;
  cutNow(): void;
  mend(): void;
  close(): Promise<void>;
}

async function startRedisGate(target: string): Promise<RedisGate> {
  const t = new URL(target);
  const live = new Set<Socket>();
  let down = false;
  let armed = -1;
  const cutNow = () => {
    down = true;
    armed = -1;
    for (const s of live) s.destroy();
    live.clear();
  };
  const server: Server = createServer((c) => {
    if (down) return void c.destroy();
    const u = connect(Number(t.port), t.hostname);
    live.add(c);
    live.add(u);
    c.on('data', (d) => {
      u.write(d);
      if (armed > 0 && (armed -= 1) === 0) setImmediate(cutNow);
    });
    u.on('data', (d) => c.write(d));
    for (const s of [c, u]) {
      s.on('error', () => undefined);
      s.on('close', () => {
        c.destroy();
        u.destroy();
      });
    }
  });
  await new Promise<void>((f) => server.listen(0, '127.0.0.1', f));
  const port = (server.address() as { port: number }).port;
  return {
    url: `redis://127.0.0.1:${port}`,
    cutAfter: (n) => void (armed = n),
    cutNow,
    mend: () => {
      down = false;
      armed = -1;
    },
    close: () => {
      cutNow();
      return new Promise<void>((f) => server.close(() => f()));
    },
  };
}

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

  redisGate = await startRedisGate(valkey!.url);
  redis = await createHotRedis({ url: redisGate.url });
  sim = buildSimulatorApp({ secretKey: SIM_KEY });
  simUrl = await sim.listen({ host: '127.0.0.1', port: Number(process.env.PEAKET_LOCAL_SIM_PORT ?? 0) });

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
  const gateway = new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: SIM_KEY, clientKey: 'sim_ck_e2e', readTimeoutMs: 2_500 });
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

  unknownResolver = new PaymentUnknownResolver({ queries: confirmJobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(metrics.registry), clock: systemClock, timer: { setInterval: () => 0, clearInterval: () => {} } } as never);

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
        // 결과 화면용(실제 화면 연결, V2)
        paymentStatus: (() => {
          const reads = new DrizzlePaymentStatus({ database: purchaseDb });
          return { reads, waiters: new PaymentStatusWaitTable({ reads, clock: systemClock, signals: new Proxy({}, { get: () => () => {} }) as never }) };
        })(),
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
  await redisGate?.close().catch(() => undefined);
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

function call(f: Fan, method: 'POST' | 'DELETE' | 'GET', url: string, body?: unknown, o: { idem?: string; unsigned?: boolean; macKey?: Buffer; seq?: number; headers?: Record<string, string> } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'x-user-id': f.accountId, 'x-session-id': f.login, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': f.pid, 'x-admission-token': f.token };
  if (payload) headers['content-type'] = 'application/json';
  if (o.idem) headers['idempotency-key'] = o.idem;
  if (!o.unsigned) {
    const n = o.seq ?? ++f.seq;
    headers['x-purchase-seq'] = String(n);
    headers['x-purchase-mac'] = purchaseMac(o.macKey ?? f.macKey, purchaseMacInput(method, url, n, Buffer.from(payload ?? '', 'utf8')));
  }
  Object.assign(headers, o.headers);
  return svc.http.inject({ method, url, headers, ...(payload ? { payload } : {}) });
}
const json = (r: { payload: string }) => {
  const v = JSON.parse(r.payload) as Record<string, unknown>;
  if (typeof v.type === 'string') v.type = v.type.split('/').pop();
  return v;
};

async function sim_(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${simUrl}${path}`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${SIM_KEY}:`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status === 200 || r.status === 204).toBe(true);
  return (r.status === 204 ? {} : await r.json()) as Record<string, unknown>;
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
      // 결제 행은 승인 명령(gRPC)이 만든다. 아직 없으면(undefined) 기다린다(RESERVED와 행 사이의 틈에서 끝나면 이 뒤의 입금 전 취소가 돌지 않는다)
      const status = (await adminPay.pool.query<{ status: string }>('select status from payment where order_id = $1', [orderId])).rows[0]?.status;
      return status !== undefined && status !== 'ACCEPTED';
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

  test('S-T16 ② S-T29 서명 없음·다른 키·재전송의 해제·연장은 401이고, ticket:buy가 없으면 403, 팬이 아니면 401이다. 홀드는 그대로다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[6]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    const holdId = String(json(held).holdId);
    const url = `/v1/holds/${holdId}`;
    const wrongKey = Buffer.alloc(32, 7);
    const attempts = {
      unsignedDelete: await call(f, 'DELETE', url, undefined, { unsigned: true }),
      unsignedExtend: await call(f, 'POST', `${url}/extension`, undefined, { unsigned: true }),
      wrongKeyDelete: await call(f, 'DELETE', url, undefined, { macKey: wrongKey, seq: f.seq + 1 }),
      wrongKeyExtend: await call(f, 'POST', `${url}/extension`, undefined, { macKey: wrongKey, seq: f.seq + 1 }),
      // 앞선 홀드 요청이 쓴 일련번호를 다시 쓴다
      replayDelete: await call(f, 'DELETE', url, undefined, { seq: f.seq }),
      otherAudDelete: await call(f, 'DELETE', url, undefined, { headers: { 'x-user-aud': 'ops' } }),
      otherAudRead: await call(f, 'GET', url, undefined, { unsigned: true, headers: { 'x-user-aud': 'ops' } }),
    };
    for (const [what, r] of Object.entries(attempts)) expect({ what, status: r.statusCode }, r.payload).toEqual({ what, status: 401 });
    // 신원 머리 없이 입장 토큰만으로는 다시 읽지 못한다(공개 경로가 아니다)
    expect((await svc.http.inject({ method: 'GET', url, headers: { 'x-admission-token': f.token } })).statusCode).toBe(401);
    const noScope = { 'x-user-scope': 'other:scope' };
    expect((await call(f, 'DELETE', url, undefined, { headers: noScope })).statusCode).toBe(403);
    expect((await call(f, 'POST', `${url}/extension`, undefined, { headers: noScope })).statusCode).toBe(403);
    // 거절된 요청은 아무것도 바꾸지 않았다
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '6'], { key: seatKeys.bitmap(w.eventId) }))).toBe(1);
    const read = await call(f, 'GET', url, undefined, { unsigned: true });
    expect(read.statusCode, read.payload).toBe(200);
    expect(json(read)).toMatchObject({ extendable: true, expiresAt: json(held).expiresAt });
  }, 60_000);

  test('S-T29 ⑤ 남의 holdId로 주문하면 404이고 주문이 생기지 않는다. ⑥ 남의 주문으로 결제 시도를 시작하면 404이고 시도가 생기지 않는다', async () => {
    const w = await world();
    const a = await fan(w.eventId);
    const b = await fan(w.eventId);
    const held = await call(b, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[7]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    const holdId = String(json(held).holdId);
    const body = { holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } };
    // ①② 남의 holdId와 없는 holdId는 같은 404 본문이다(그런 홀드가 있는지 알리지 않는다)
    const shape = (r: { statusCode: number; payload: string }) => {
      const v = JSON.parse(r.payload) as Record<string, unknown>;
      return { statusCode: r.statusCode, type: v.type, title: v.title, detail: v.detail };
    };
    const foreignHold = await call(a, 'DELETE', `/v1/holds/${holdId}`);
    const noSuchHold = await call(a, 'DELETE', `/v1/holds/${randomUUID()}`);
    expect(foreignHold.statusCode, foreignHold.payload).toBe(404);
    expect(shape(foreignHold)).toEqual(shape(noSuchHold));
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '7'], { key: seatKeys.bitmap(w.eventId) }))).toBe(1);
    const foreign = await call(a, 'POST', '/v1/orders', body, { idem: randomUUID() });
    expect(foreign.statusCode, foreign.payload).toBe(404);
    expect((await adminP.pool.query('select count(*)::int n from purchase_order where hold_id = $1', [holdId])).rows[0]).toEqual({ n: 0 });
    const ordered = await call(b, 'POST', '/v1/orders', body, { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    const start = await call(a, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(start.statusCode, start.payload).toBe(404);
    expect((await adminP.pool.query('select count(*)::int n from payment_attempt where order_id = $1', [orderId])).rows[0]).toEqual({ n: 0 });
  }, 60_000);

  test('P-T49 ② 제한 뒤 같은 세션은 다른 좌석을 잡지만 주문은 다시 403이다. ③ 제한 전에 만든 주문의 결제 시도와 접수는 막지 않는다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const before = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[0]] }, { idem: randomUUID() });
    expect(before.statusCode, before.payload).toBe(201);
    const body = (holdId: string) => ({ holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } });
    const madeFirst = await call(f, 'POST', '/v1/orders', body(String(json(before).holdId)), { idem: randomUUID() });
    expect(madeFirst.statusCode, madeFirst.payload).toBe(201);
    const earlierOrder = String(json(madeFirst).orderId);
    await redis.command(['HSET', `s:rst:${f.accountId}`, 'st', 'ACTIVE', 'rid', 'r2', 'ver', '1'], { key: `s:rst:${f.accountId}` });
    // ② 다른 좌석의 홀드는 된다(주문을 막는 것이지 세션을 끝내지 않는다). 주문은 다시 403이다
    const another = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[5]] }, { idem: randomUUID() });
    expect(another.statusCode, another.payload).toBe(201);
    const blocked = await call(f, 'POST', '/v1/orders', body(String(json(another).holdId)), { idem: randomUUID() });
    expect(blocked.statusCode, blocked.payload).toBe(403);
    expect(json(blocked).type).toBe('booking-restricted');
    expect((await adminP.pool.query('select count(*)::int n from purchase_order where hold_id = $1', [String(json(another).holdId)])).rows[0]).toEqual({ n: 0 });
    // ③ 제한 전 주문은 그대로 결제까지 간다
    const attempt = await call(f, 'POST', `/v1/orders/${earlierOrder}/payments`, {}, { idem: randomUUID() });
    expect(attempt.statusCode, attempt.payload).toBe(201);
    const a = json(attempt) as { attemptId: string; checkout: { orderId: string; amount: number } };
    const { paymentKey } = (await sim_('/sim/authenticate', { orderId: a.checkout.orderId, amount: a.checkout.amount })) as { paymentKey: string };
    const accepted = await call(f, 'POST', `/v1/orders/${earlierOrder}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: a.checkout.amount, attemptId: a.attemptId }, { idem: randomUUID() });
    expect(accepted.statusCode, accepted.payload).toBe(202);
  }, 60_000);
});

describe('장애 주입(BUILD_ORDER HOT-358 리뷰 V4): 좌석 이중 판매 0, 금액·주문 불일치 0, 묶인 좌석은 풀리고, 결과 모름은 해소된다', () => {
  const ORDER_BODY = (holdId: string) => ({ holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } });
  const delivered = new Set<string>();
  let offset = 1_000_000n;

  /** payment-svc Outbox의 새 행을 소비 처리기에 넣는다(Kafka 대신) */
  async function drain(eventId: string): Promise<void> {
    const rows = (await adminPay.pool.query<{ payload: Buffer; id: string }>('select seq::text as id, payload from outbox where msg_key = $1 order by seq', [eventId])).rows;
    for (const r of rows) {
      if (delivered.has(r.id)) continue;
      delivered.add(r.id);
      offset += 1n;
      const m: ConsumedMessage = { topic: 'trade.payments', partition: 0, offset, key: eventId, value: r.payload, headers: {}, timestamp: Date.now() };
      await results.handle(results.decode(m), m);
    }
  }
  const orderStatus = async (id: string) => (await adminP.pool.query<{ status: string }>('select status from purchase_order where id = $1', [id])).rows[0]?.status;
  const payStatus = async (id: string) => (await adminPay.pool.query<{ status: string }>('select status from payment where order_id = $1', [id])).rows[0]?.status;
  async function holdSeat(w: { eventId: string; seats: string[] }, f: Fan, i: number): Promise<string> {
    const held = await call(f, 'POST', `/v1/events/${w.eventId}/holds`, { seatIds: [w.seats[i]] }, { idem: randomUUID() });
    expect(held.statusCode, held.payload).toBe(201);
    return String(json(held).holdId);
  }
  async function healthy(): Promise<void> {
    redisGate.mend();
    await until(async () => (await redis.command(['PING'], { key: 'x' }).catch(() => null)) === 'PONG', 'Redis 복구', 15_000, 50);
  }
  /** 주문까지 된 상태에서 결제창(시뮬레이터 인증)과 접수를 지나 Saga가 승인 명령을 낼 때까지 */
  async function acceptedOrder(f: Fan, orderId: string, fault?: Record<string, unknown>): Promise<void> {
    const started = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(started.statusCode, started.payload).toBe(201);
    const a = json(started) as { attemptId: string; checkout: { orderId: string; amount: number } };
    const { paymentKey } = (await sim_('/sim/authenticate', { orderId: a.checkout.orderId, amount: a.checkout.amount })) as { paymentKey: string };
    if (fault) await sim_('/sim/faults', { op: 'confirm', orderId: a.checkout.orderId, times: 1, ...fault });
    const accepted = await call(f, 'POST', `/v1/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: a.checkout.amount, attemptId: a.attemptId }, { idem: randomUUID() });
    expect(accepted.statusCode, accepted.payload).toBe(202);
    await until(async () => (await orderStatus(orderId)) === 'RESERVED', 'RESERVED', 20_000, 50);
  }
  async function runConfirm(orderId: string): Promise<string> {
    await until(async () => {
      await confirmRunner.tick();
      await confirmRunner.whenIdle();
      // 결제 행은 승인 명령이 만든다. 아직 없으면(undefined) 기다린다(acceptedOrder의 RESERVED와 행 사이의 틈)
      const status = await payStatus(orderId);
      return status !== undefined && status !== 'ACCEPTED';
    }, '승인 실행', 25_000, 100);
    return (await payStatus(orderId))!;
  }
  /** 결과 모름을 조회로 해소한다(다음 조회 시각을 앞당긴다) */
  async function resolveUnknown(orderId: string): Promise<string> {
    await until(async () => {
      await adminPay.pool.query("update payment set next_query_at = now() - interval '1 second' where order_id = $1 and status = 'UNKNOWN'", [orderId]);
      await unknownResolver.tick();
      await unknownResolver.whenIdle();
      return (await payStatus(orderId)) !== 'UNKNOWN';
    }, '결과 모름 해소', 25_000, 150);
    return (await payStatus(orderId))!;
  }
  async function verdict(w: { eventId: string }, orderId: string, expected: 'SOLD' | 'RELEASED', seat: number): Promise<void> {
    await drain(w.eventId);
    const sales = (await adminP.pool.query<{ seat_id: string; n: number }>("select seat_id, count(*)::int n from seat_sale where event_id = $1 and status in ('PENDING','SOLD') group by seat_id", [w.eventId])).rows;
    expect(sales.every((r) => r.n === 1), '좌석 이중 판매').toBe(true);
    const order = (await adminP.pool.query<{ amount: number; status: string }>('select amount, status from purchase_order where id = $1', [orderId])).rows[0]!;
    const pay = (await adminPay.pool.query<{ amount: number; status: string }>('select amount, status from payment where order_id = $1', [orderId])).rows[0]!;
    expect(Number(pay.amount), '금액 불일치').toBe(Number(order.amount));
    if (expected === 'SOLD') {
      expect(order.status).toBe('APPROVED');
      expect(sales.length).toBe(1);
    } else {
      await until(async () => (await adminP.pool.query('select count(*)::int n from seat_sale where event_id = $1 and status in ($2, $3)', [w.eventId, 'PENDING', 'SOLD'])).rows[0]?.n === 0, '판매 행 지움', 10_000, 50);
    }
    expect(['UNKNOWN', 'ACCEPTED']).not.toContain(pay.status);
    // 풀림은 판매 행을 지운 뒤 Saga가 응답 밖에서 하므로 기다린다(판매 행 지움과 비트 끄기 사이의 틈)
    if (expected === 'RELEASED') await until(async () => Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), String(seat)], { key: seatKeys.bitmap(w.eventId) })) === 0, '좌석 해제', 15_000, 100);
    else expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), String(seat)], { key: seatKeys.bitmap(w.eventId) }))).toBe(1);
  }

  test('V4 ① 주문 도중 Redis 연결이 어느 명령에서 끊겨도 복구 뒤 같은 키로 주문은 하나다', async () => {
    // 요청의 Redis 명령을 앞에서부터 하나씩 끊어 본다. 끊는 자리가 주문 커밋 뒤의 표시까지 닿아야 복구(재생·표시)를 본다
    let committedAtCut = 0;
    for (let n = 1; n <= 14; n += 1) {
      const w = await world();
      const f = await fan(w.eventId);
      const holdId = await holdSeat(w, f, 0);
      const idem = randomUUID();
      redisGate.cutAfter(n);
      const first = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem });
      await healthy();
      if ((await adminP.pool.query<{ n: number }>('select count(*)::int n from purchase_order where hold_id = $1', [holdId])).rows[0]!.n === 1) committedAtCut += 1;
      const again = await until2(async () => {
        const r = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem });
        return r.statusCode < 500 ? r : null;
      }, `주문 재시도 n=${n}`);
      expect(again.statusCode, `n=${n} 첫 답 ${first.statusCode}: ${again.payload}`).toBe(201);
      const orderId = String(json(again).orderId);
      const rows = (await adminP.pool.query('select count(*)::int n from purchase_order where hold_id = $1', [holdId])).rows[0];
      expect(rows, `n=${n}`).toEqual({ n: 1 });
      // 결제 시도 시작이 주문 뒤 표시를 복구한다(L4)
      const started = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
      expect(started.statusCode, `n=${n} ${started.payload}`).toBe(201);
      const key = seatKeys.ordered(w.eventId);
      expect(await redis.command(['ZSCORE', key, '0'], { key }), `n=${n} 주문 뒤 표시`).not.toBeNull();
    }
    expect(committedAtCut, '끊는 자리가 커밋 뒤까지 닿지 않았다').toBeGreaterThan(0);
  }, 300_000);

  test('V4 ① 결제 시도 도중 Redis가 끊겨도 복구 뒤 같은 키는 시도 행 하나이고 끝까지 팔린다', async () => {
    for (const n of [1, 3, 5]) {
      const w = await world();
      const f = await fan(w.eventId);
      const holdId = await holdSeat(w, f, 0);
      const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
      expect(ordered.statusCode, ordered.payload).toBe(201);
      const orderId = String(json(ordered).orderId);
      const idem = randomUUID();
      redisGate.cutAfter(n);
      await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem });
      await healthy();
      const again = await until2(async () => {
        const r = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem });
        return r.statusCode < 500 ? r : null;
      }, `시도 재시도 n=${n}`);
      expect(again.statusCode, again.payload).toBe(201);
      expect((await adminP.pool.query('select count(*)::int n from payment_attempt where order_id = $1', [orderId])).rows[0], `n=${n}`).toEqual({ n: 1 });
      await acceptedOrderAfterAttempt(f, orderId, again);
      expect(await runConfirm(orderId)).toBe('APPROVED');
      await verdict(w, orderId, 'SOLD', 0);
    }
  }, 180_000);

  async function acceptedOrderAfterAttempt(f: Fan, orderId: string, started: { payload: string }): Promise<void> {
    const a = json(started) as { attemptId: string; checkout: { orderId: string; amount: number } };
    const { paymentKey } = (await sim_('/sim/authenticate', { orderId: a.checkout.orderId, amount: a.checkout.amount })) as { paymentKey: string };
    const accepted = await call(f, 'POST', `/v1/orders/${orderId}/payment-acceptance`, { pg: 'SIMULATOR', paymentKey, amount: a.checkout.amount, attemptId: a.attemptId }, { idem: randomUUID() });
    expect(accepted.statusCode, accepted.payload).toBe(202);
    await until(async () => (await orderStatus(orderId)) === 'RESERVED', 'RESERVED', 20_000, 50);
  }

  test('V4 ① 정지 옮기기 도중 Redis가 끊겨도 좌석을 잃지 않고 복구 뒤 옮겨지며 되돌린 뒤 팔린다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    let answer: PaymentPauseAnswer = { status: 'OK', pauses: [{ eventId: w.eventId, pausedSinceMs: Date.now() - 500 }] };
    const sweeper = new ExpirySweeper({ expiries: new RedisSeatStore(redis), seatMap, leases: new RedisSweepLeases(redis), clock: systemClock, podId: `pod-v4-${randomUUID()}`, lifecycle: new RedisHoldLifecycle(redis), pauseView: new HoldPauseView({ read: async () => answer }, systemClock) } as never);
    for (const n of [1, 2, 3, 4]) {
      redisGate.cutAfter(n);
      await sweeper.tick().catch(() => undefined);
      await healthy();
      expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '0'], { key: seatKeys.bitmap(w.eventId) })), `n=${n}`).toBe(1);
    }
    const pausedKey = seatKeys.paused(w.eventId);
    // 끊겼던 틱의 임대가 끝나면 옮겨진다
    await until(async () => {
      await sweeper.tick();
      return (await redis.command(['ZSCORE', pausedKey, '0'], { key: pausedKey })) !== null;
    }, '복구 뒤 옮기기', 20_000, 200);
    answer = { status: 'OK', pauses: [] };
    await sweeper.tick();
    await new Promise((r) => setTimeout(r, 1_100));
    redisGate.cutAfter(2);
    await sweeper.tick().catch(() => undefined);
    await healthy();
    await sweeper.tick();
    await until(async () => {
      await sweeper.tick();
      return (await redis.command(['ZSCORE', pausedKey, '0'], { key: pausedKey })) === null;
    }, '되돌리기', 10_000, 100);
    await acceptedOrder(f, orderId);
    expect(await runConfirm(orderId)).toBe('APPROVED');
    await verdict(w, orderId, 'SOLD', 0);
  }, 120_000);

  test('V4 ② PG 지연: 승인이 시간 안에 오면 그대로 팔린다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    const orderId = String(json(ordered).orderId);
    await acceptedOrder(f, orderId, { kind: 'delay', ms: 800 });
    expect(await runConfirm(orderId)).toBe('APPROVED');
    await verdict(w, orderId, 'SOLD', 0);
  }, 90_000);

  test('V4 ② PG 무응답(시간 초과): 결과 모름이 되고 조회가 승인으로 해소해 한 번만 팔린다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    const orderId = String(json(ordered).orderId);
    await acceptedOrder(f, orderId, { kind: 'delay', ms: 4_000 });
    const first = await runConfirm(orderId);
    expect(first).toBe('UNKNOWN');
    await drain(w.eventId);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await resolveUnknown(orderId)).toBe('APPROVED');
    await verdict(w, orderId, 'SOLD', 0);
  }, 120_000);

  test('V4 ② PG 무응답(처리 안 됨): 결과 모름이 조회로 실패로 끝나 묶인 좌석이 풀린다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    const orderId = String(json(ordered).orderId);
    await acceptedOrder(f, orderId, { kind: 'drop', applied: false });
    expect(await runConfirm(orderId)).toBe('UNKNOWN');
    await drain(w.eventId);
    // 결제사가 결과를 정하기 전에는 상태를 바꾸지 않는다: 다음 조회 시각을 당겨 조회가 실제로 돌게 하고(처리 중 답), 세션이 끝나 EXPIRED를 답하면 실패로 닫힌다
    await adminPay.pool.query("update payment set next_query_at = now() - interval '1 second' where order_id = $1 and status = 'UNKNOWN'", [orderId]);
    await unknownResolver.tick();
    await unknownResolver.whenIdle();
    expect(await payStatus(orderId)).toBe('UNKNOWN');
    const { rows } = await adminPay.pool.query<{ key: string }>('select pg_payment_ref as key from payment where order_id = $1', [orderId]);
    await sim_(`/sim/sessions/${encodeURIComponent(rows[0]!.key)}/expire`, {});
    expect(await resolveUnknown(orderId)).toBe('FAILED');
    await verdict(w, orderId, 'RELEASED', 0);
  }, 120_000);

  test('V4 ③ 승인 응답 유실(처리됨): 결과 모름이 조회로 승인되어 금액이 맞고 한 번만 팔린다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    const orderId = String(json(ordered).orderId);
    await acceptedOrder(f, orderId, { kind: 'drop', applied: true });
    expect(await runConfirm(orderId)).toBe('UNKNOWN');
    await drain(w.eventId);
    expect(await resolveUnknown(orderId)).toBe('APPROVED');
    await verdict(w, orderId, 'SOLD', 0);
  }, 120_000);

  test('P-T25 승인 단계 거절은 주문 FAILED와 좌석 해제로 끝나고 과금이 없다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    await acceptedOrder(f, orderId, { kind: 'decline', code: 'REJECT_CARD_COMPANY' });
    expect(await runConfirm(orderId)).toBe('FAILED');
    await verdict(w, orderId, 'RELEASED', 0);
    expect(await orderStatus(orderId)).toBe('FAILED');
  }, 120_000);

  test('P-T25 결제창 단계 세 번 뒤 네 번째 시도는 409이고 행이 늘지 않으며 홀드는 유지된다', async () => {
    const w = await world();
    const f = await fan(w.eventId);
    const holdId = await holdSeat(w, f, 0);
    const ordered = await call(f, 'POST', '/v1/orders', ORDER_BODY(holdId), { idem: randomUUID() });
    expect(ordered.statusCode, ordered.payload).toBe(201);
    const orderId = String(json(ordered).orderId);
    for (let i = 0; i < 3; i += 1) {
      const started = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
      expect(started.statusCode, started.payload).toBe(201);
    }
    const fourth = await call(f, 'POST', `/v1/orders/${orderId}/payments`, {}, { idem: randomUUID() });
    expect(fourth.statusCode, fourth.payload).toBe(409);
    expect(json(fourth).type).toBe('payment-attempts-exceeded');
    expect((await adminP.pool.query('select count(*)::int n from payment_attempt where order_id = $1', [orderId])).rows[0]).toEqual({ n: 3 });
    expect(Number(await redis.command(['GETBIT', seatKeys.bitmap(w.eventId), '0'], { key: seatKeys.bitmap(w.eventId) }))).toBe(1);
    expect((await call(f, 'GET', `/v1/holds/${holdId}`, undefined, { unsigned: true })).statusCode).toBe(200);
  }, 60_000);
});

async function until2<T>(f: () => Promise<T | null>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error(`기다림 끝: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// 실제 화면 연결용 로컬 스택(BUILD_ORDER HOT-358 리뷰 V2). 평소에는 돌지 않는다. PEAKET_LOCAL_STACK=1이면 실제 서비스를 포트에 묶고 멈춤 파일이 생길 때까지 기다린다.
// 좌석맵 파일과 회차 요약은 가짜 API의 값을 그대로 쓴다(좌석 ID·등급이 화면과 같아야 한다).
describe.runIf(process.env.PEAKET_LOCAL_STACK === '1')('로컬 스택', () => {
  test('화면이 붙을 수 있게 띄워 둔다', async () => {
    const mock = (await import(/* @vite-ignore */ new URL('../../../apps/web/scripts/mock-api.mjs', import.meta.url).href)) as { eventDetail(o: string, id: string): { priceTiers: { tierId: string; name: string; price: number }[] } };
    const layoutMod = (await import(/* @vite-ignore */ new URL('../../../apps/web/scripts/mock-api/seatmap.mjs', import.meta.url).href)) as { seatmapLayoutV(v: number): { sections: { sectionId: string; name: string; seatIndexRange: { from: number }; seats: { seatId: string[]; row: string[]; number: string[]; tier: number[] } }[]; tiers: string[]; seatCount: number } };
    const eventId = process.env.PEAKET_LOCAL_EVENT!;
    const layout = layoutMod.seatmapLayoutV(3);
    const tiers = mock.eventDetail('', eventId).priceTiers;
    // 주문 DB의 좌석 ID는 UUID다: 가짜 파일의 글 ID를 같은 값으로 바꿔 판과 파일에 함께 쓴다
    const uuidOf = (id: string): string => {
      const h = createHash('sha256').update(id).digest('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    };
    for (const s of layout.sections) s.seats.seatId = s.seats.seatId.map(uuidOf);
    const layoutBody = JSON.stringify(layout);
    const seats = layout.sections.flatMap((s, si) => s.seats.seatId.map((seatId, o) => ({ seatId, index: s.seatIndexRange.from + o, sectionId: s.sectionId, sectionIndex: si, seatOffset: o, tierId: layout.tiers[s.seats.tier[o]!]!, label: `${s.name} ${s.seats.row[o]}열 ${s.seats.number[o]}번` })));
    seatMap.put({ eventId, layoutVersion: '3', seatCount: layout.seatCount, perAccountLimit: 4, saleEndsAtMs: Date.now() + 2 * 86400_000, tierPrices: Object.fromEntries(tiers.map((x) => [x.tierId, x.price])), tierNames: Object.fromEntries(tiers.map((x) => [x.tierId, x.name])), orderName: 'LUMEN 콘서트', virtualAccountAllowed: false } as never, seats as never);
    await new RedisSeatStore(redis).openSale({ eventId, seatCount: layout.seatCount, keepUntilMs: Date.now() + 2 * 86400_000 + KEEP_AFTER_SALE_END_MS });
    const accountId = process.env.PEAKET_LOCAL_ACCOUNT!;
    const login = process.env.PEAKET_LOCAL_LOGIN!;
    pidOf.set(accountId, process.env.PEAKET_LOCAL_PID!);
    await svc.http.listen({ host: '127.0.0.1', port: Number(process.env.PEAKET_LOCAL_PURCHASE_PORT) });
    const { createServer: http } = await import('node:http');
    const admission = http((req, res) => {
      if (req.url?.includes('/seatmap-layouts/')) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return void res.end(layoutBody);
      }
      const jti = randomUUID();
      const token = signAdmission(admissionKey, claimsOf({ nowMs: Date.now(), jti, accountId, loginSessionId: login, eventId }, { jny: randomUUID() }));
      const pub = serverPriv.publicJwk();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ admissionToken: token, purchaseSessionExpiresAt: new Date(Date.now() + 40 * 60_000).toISOString(), serverEcdhPublicKey: pub, seatmapLayoutPath: `/v1/events/${eventId}/seatmap-layouts/3.json` }));
      req.resume();
    });
    await new Promise<void>((f) => admission.listen(Number(process.env.PEAKET_LOCAL_ADMISSION_PORT), '127.0.0.1', f));
    const seen = new Set<string>();
    let offset = 5_000_000n;
    const stopFile = process.env.PEAKET_LOCAL_STOP!;
    const { existsSync } = await import('node:fs');
    while (!existsSync(stopFile)) {
      await confirmRunner.tick().catch(() => undefined);
      await confirmRunner.whenIdle().catch(() => undefined);
      await unknownResolver.tick().catch(() => undefined);
      const rows = (await adminPay.pool.query<{ payload: Buffer; id: string }>('select seq::text as id, payload from outbox where msg_key = $1 order by seq', [eventId])).rows;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        offset += 1n;
        const m: ConsumedMessage = { topic: 'trade.payments', partition: 0, offset, key: eventId, value: r.payload, headers: {}, timestamp: Date.now() };
        await results.handle(results.decode(m), m).catch((e: unknown) => console.error('result', e));
      }
      await new Promise((f) => setTimeout(f, 300));
    }
    admission.close();
  }, 3_600_000);
});
