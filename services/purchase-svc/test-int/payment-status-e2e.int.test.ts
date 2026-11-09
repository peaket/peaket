// 결제 결과 long polling GET /v1/orders/{orderId}/payment-status를 앱째로 돈다: 실제 PostgreSQL 18·실제 Valkey 8.1(BUILD_ORDER PRF-166).
// 결제 접수 → Saga(RESERVED) → 기다리는 요청 → 결제 결과 반영(ApplyPaymentResult) → 답. 정본: docs/features/payment.md §2 '결제 결과 long polling의 첫 구현'
// ('기다리는 상태'·'알림 길'·'시간 한도'), §11 P-T44 ①(결과가 3초 뒤 정해지면 3초에 확정으로 답한다), openapi GET /v1/orders/{orderId}/payment-status.
//
// 약속:
// - 주문 쪽 조립은 payment-result-e2e.int.test.ts와 같다(홀드 Lua → 구매 세션 Paying → 주문 T1 → READY 시도 직접 → 결제 접수 → Saga runOne(승인 명령 대역)).
//   결제 결과는 Kafka 없이 ApplyPaymentResult.execute를 직접 부른다.
// - 앱은 AppModule을 메모리 조립(주문 생성·접수 포트는 test/의 가짜)으로 띄우고, long polling만 실제로 잇는다:
//   reads = DrizzlePaymentStatus(같은 DB), waiters = PaymentStatusWaitTable(실제 타이머. 묶음 조회 반복은 pollingOn이 참일 때만 돈다).
//   같은 파드의 반영은 onOrderChanged = waitTable.notify로 깨우고, '다른 파드의 반영'은 onOrderChanged가 없는 ApplyPaymentResult로 흉내 낸다.
// - 앱 시계는 Valkey 시계에 맞춘 가짜 시계다(홀드·묶기 Lua가 Redis TIME을 쓴다). 흐르지 않으므로 요청의 남은 시간은 min(머리 값, 27초)에 머문다.
//   걸린 시간은 벽시계(performance.now)로 잰다. 시간 단언은 여유를 둔다(곧바로 < 1.5초, 묶음 조회 < 1초 + 여유, 3초 ± 여유).
//
// 정본(payment §2 '기다리는 상태'): issueDelayed가 거짓인 APPROVED는 기다리는 상태다(발권이 붙으면 곧 CONFIRMED가 된다, PRF-170).
//   이 시험에는 발권이 없어 승인 주문은 CONFIRMED가 되지 않는다. 그래서 '곧바로 답함'(확정)은 FAILED 사건(과금 없는 실패)으로 보고,
//   APPROVED는 ① 남은 시간 상한까지 기다렸다가 그때의 상태(APPROVED, issueDelayed 거짓)로 답하는 것과
//   ② 기다리는 동안 issueDelayed가 거짓 → 참으로 바뀌면(첫 발권 시도 실패를 SQL로 흉내, 또는 가짜 시계를 60초 당김) 묶음 조회가 깨워
//   issueDelayed 참으로 곧바로 답하는 것(ADR-0106, 리뷰 고침 M1·M2)으로 본다. 같은 파드의 승인 반영은 깨우지 않는다(리뷰 고침 L3).
// 정본 모호:
// - 기다릴 시간을 줄이는 주입 칸은 없다. '남은 시간 상한에 걸려 그때의 상태로 답한다'는 머리 x-peaket-deadline-ms 3000(→ 기다림 2초)으로 본다.
// - 다른 파드의 반영은 '묶음 조회로 1초 안팎'(payment §2 '알림 길': 결과는 1초 안팎이 목표)이다: 반영 뒤 답까지 200ms 간격 + 질의 몫으로 1초 안을 본다(여유 1.5초).
// - 가짜 시계를 60초 당기면 앱 시계가 Valkey 시계보다 앞선다. 그래서 그 시험은 파일의 마지막에 두고, 당긴 뒤에는 좌석·구매 세션을 쓰지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDatabase, createHotRedis, createService, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  ApplyPaymentResult,
  type ConfirmOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzlePaymentResults,
  DrizzlePaymentStatus,
  DrizzleSaga,
  InventoryOrderSeatPins,
  InventoryPaymentResultSessions,
  InventorySeatSlots,
  type NewOrder,
  OrderSagaRunner,
  type PaymentConfirms,
  type PaymentRefs,
  type PaymentResultEvent,
  type PaymentResultLog,
  PaymentStatusWaitTable,
  type SagaLog,
  SeatMapSagaConfigs,
  type WaitTableTimer,
} from '../src/modules/booking/index.js';
import {
  DrizzleSeatSales,
  EndPurchaseSession,
  type EventSeatConfig,
  type HoldInput,
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessions,
  MemorySeatMap,
  RedisPurchaseSessionStore,
  RedisSeatSlots,
  RedisSeatStore,
  RedisSessionEndedLog,
  type SeatRef,
} from '../src/modules/inventory/index.js';
import { AcceptFakes } from '../test/accept-cases.js';
import { fingerprintOf } from '../test/hold-cases.js';
import { CONSENT_VERSION, OrderFakes } from '../test/order-cases.js';
import { openInput } from '../test/purchase-session-cases.js';
import { accountActor, iso, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const PRICES = { R: 99_000, S: 132_000 } as const;
const SEAT_COUNT = 10;
const LIMIT = 4;
/** 곧바로 답함의 상한(25초를 기다리지 않음을 넉넉히 가른다) */
const PROMPT_MS = 1_500;

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let database: Database;
let admin: Database;
let clock: ReturnType<typeof fakeClock>;
let svc: Awaited<ReturnType<typeof createService>> | undefined;
let table: PaymentStatusWaitTable;
const seatMap = new MemorySeatMap();
const quiet = new Writable({ write: (_c, _e, cb) => cb() });

/** 묶음 조회 반복을 켜고 끄는 문(같은 파드의 notify만으로 깨는지 따로 본다) */
let pollingOn = false;
const realTimer: WaitTableTimer = {
  setInterval: (fn, ms) =>
    setInterval(() => {
      if (pollingOn) fn();
    }, ms).unref(),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'fulfilled') pgServer = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  for (const r of [p, v]) if (r.status === 'rejected') throw r.reason as Error;
  redis = await createHotRedis({ url: valkey!.url });
  const samples: number[] = [];
  for (let k = 0; k < 5; k += 1) {
    const before = Date.now();
    const t = (await redis.command(['TIME'], {})) as unknown[];
    samples.push(Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) - Math.round((before + Date.now()) / 2));
  }
  clock = fakeClock({ now: Date.now() + samples.sort((a, b) => a - b)[2]! });
  await migratePurchase(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 10, applicationName: 'payment-status-e2e' });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'payment-status-e2e-admin' });
  await ensureOutboxPartitions(admin, clock);

  table = new PaymentStatusWaitTable({ reads: new DrizzlePaymentStatus({ database }), clock, timer: realTimer });
  const appSessions = new MemoryPurchaseSessions();
  svc = await createService({
    name: 'purchase-svc',
    purchaseSessions: appSessions,
    module: AppModule.register({
      memory: true,
      sessions: appSessions,
      booking: {
        ...new OrderFakes(clock).ports(),
        ...new AcceptFakes().bookingPorts(),
        consentVersion: CONSENT_VERSION,
        clock,
        paymentStatus: { reads: new DrizzlePaymentStatus({ database }), waiters: table },
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
  // 묶음 조회 반복은 시험마다 준비(주문 RESERVED)를 마친 뒤 켠다(start는 두 번 불러도 하나다)
});

afterAll(async () => {
  // 뼈대에서는 stop()이 곧바로 던지므로 약속 안에서 부른다(컨테이너 정리를 건너뛰지 않게)
  await Promise.resolve()
    .then(() => table?.stop())
    .catch(() => undefined);
  await svc?.close().catch(() => undefined);
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  pgServer?.stop();
});

beforeEach(() => {
  pollingOn = false;
});

// ───────────────────────────── 조립(payment-result-e2e.int.test.ts와 같다) ─────────────────────────────

const manualTimer = { setInterval: () => 1, clearInterval: () => {} };
const sagaLog: SagaLog = { releaseFailed: () => {}, confirmRejected: () => {}, stepError: () => {} };
const resultLog: PaymentResultLog = { held: () => {}, afterCommitFailed: () => {} };

function assemble() {
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  const saga = new DrizzleSaga({ database, store, sales, clock });
  const confirms: PaymentConfirms = {
    confirm: async (_c, o): Promise<ConfirmOutcome> => {
      await o?.beforeSend?.();
      return { status: 'ACCEPTED', result: 'IN_PROGRESS' };
    },
  };
  const runner = new OrderSagaRunner({
    jobs: saga,
    orders: saga,
    reserve: saga,
    failures: saga,
    confirmSent: saga,
    pins: new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap }),
    confirms,
    configs: new SeatMapSagaConfigs(seatMap),
    log: sagaLog,
    clock,
    timer: manualTimer,
  });
  const results = new DrizzlePaymentResults({ database, store, sales, clock });
  const sessionStore = new RedisPurchaseSessionStore(redis);
  const sessions = new InventoryPaymentResultSessions({ end: new EndPurchaseSession({ store: sessionStore, ended: new RedisSessionEndedLog(redis), clock }), store: sessionStore });
  /** 같은 파드의 반영(커밋 뒤 기다림을 깨운다) */
  const samePod = new ApplyPaymentResult({ reads: results, writes: results, sessions, saga: runner, log: resultLog, clock, onOrderChanged: (id) => table.notify(id) });
  /** 다른 파드의 반영(이 파드의 기다림 표를 모른다) */
  const otherPod = new ApplyPaymentResult({ reads: results, writes: results, sessions, saga: runner, log: resultLog, clock });
  return { store, runner, sessionStore, samePod, otherPod, accepts: new DrizzleOrderAccepts({ database, store, clock }) };
}
type Assembled = ReturnType<typeof assemble>;

interface World {
  eventId: string;
  refs: SeatRef[];
  keepUntilMs: number;
}
async function world(): Promise<World> {
  const eventId = randomUUID();
  const r = Array.from({ length: 6 }, () => randomUUID()).sort();
  const s = Array.from({ length: 4 }, () => randomUUID()).sort();
  const refs: SeatRef[] = [
    ...r.map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' })),
    ...s.map((seatId, i) => ({ seatId, index: 6 + i, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: i, tierId: 'S' })),
  ];
  const config: EventSeatConfig = { eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: LIMIT, saleEndsAtMs: clock.now() + DAY, tierPrices: { ...PRICES } };
  seatMap.put(config, refs);
  const keepUntilMs = config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS;
  await new RedisSeatStore(redis).openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });
  return { eventId, refs, keepUntilMs };
}

interface Placed {
  w: World;
  o: NewOrder;
}
async function holdSeats(w: World, accountId: string, seats: SeatRef[], psid: string): Promise<HoldInput> {
  const sorted = [...seats].sort((a, b) => (a.seatId < b.seatId ? -1 : 1));
  const h: HoldInput = {
    eventId: w.eventId,
    accountId,
    purchaseSessionId: psid,
    holdId: uuidv7(clock),
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf(sorted.map((x) => x.seatId)),
    seats: sorted,
    limit: LIMIT,
    keepUntilMs: w.keepUntilMs,
  };
  const r = await new RedisSeatStore(redis).hold(h);
  expect(r.kind, JSON.stringify(r)).toBe('OK');
  return h;
}
/** 구매 세션·홀드 → 주문(T1) → READY 시도 → 결제 접수 → Saga runOne → RESERVED */
async function reserved(a: Assembled): Promise<Placed> {
  const w = await world();
  const accountId = randomUUID();
  const psid = `jti-${randomUUID()}`;
  expect((await a.sessionStore.open(openInput({ now: () => clock.now() }, psid, { accountId, eventId: w.eventId }))).kind).toBe('CREATED');
  expect(await a.sessionStore.setPaying(psid, true)).toBe(true);
  const hold = await holdSeats(w, accountId, [w.refs[0]!, w.refs[1]!], psid);
  const items = hold.seats.map((s) => ({ seatId: s.seatId, tierId: s.tierId, sectionId: s.sectionId, unitPrice: PRICES[s.tierId as 'R' | 'S'] }));
  const o = newOrderInput(clock, { eventId: w.eventId, accountId, holdId: hold.holdId, purchaseSessionId: psid, items });
  await database.transaction((tx) => a.store.createOrder(tx, o));
  const refs: PaymentRefs = { pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` };
  const attemptId = uuidv7(clock);
  await admin.pool.query('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [attemptId, o.id, refs.pg, o.id, 'READY', new Date(clock.now())]);
  const slot = await new InventorySeatSlots(new RedisSeatSlots(redis)).read(w.eventId);
  expect(slot.status).toBe('OK');
  clock.advance(1_000);
  const once = {
    accountRef: accountId,
    operation: 'ACCEPT_PAYMENT',
    key: randomUUID(),
    requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from(JSON.stringify({ n: randomUUID() }), 'utf8')),
  };
  const seatGen = slot.status === 'OK' ? slot.gen : 1;
  expect(await a.accepts.accept(once, { orderId: o.id, attemptId, eventId: w.eventId, refs, seatGen, actor: accountActor(accountId) })).toEqual({ status: 'ACCEPTED' });
  expect(await a.runner.runOne(o.id)).toEqual({ kind: 'DONE' });
  const row = (await admin.pool.query('select status from purchase_order where id = $1', [o.id])).rows[0] as { status: string };
  expect(row.status).toBe('RESERVED');
  return { w, o };
}

/** 결제 사건(도메인 PaymentResultEvent) */
const eventOf = (p: Placed, x: Partial<PaymentResultEvent> = {}): PaymentResultEvent => ({
  eventId: p.w.eventId,
  orderId: p.o.id,
  pg: 'TOSS',
  type: 'APPROVED',
  amount: p.o.amount,
  payMethodCategory: 'CARD',
  refMissing: false,
  result: 'APPROVED',
  attemptNo: 1,
  latencyMs: 120,
  occurredAt: iso(clock.now()),
  eventSeq: 1,
  eventKey: randomUUID(),
  ...x,
});

/** 그 주문 계정으로 long polling 요청을 보낸다(팬 신원 머리만). 보낸 때부터 답까지의 벽시계 시간을 함께 준다 */
function poll(p: Placed, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  return svc!.http
    .inject({ method: 'GET', url: `/v1/orders/${p.o.id}/payment-status`, headers: { 'x-user-id': p.o.accountId, 'x-session-id': `ls-${p.o.accountId}`, 'x-user-aud': 'fan', ...headers } })
    .then((r) => ({ r, at: performance.now(), tookMs: performance.now() - t0, body: JSON.parse(r.payload) as Record<string, unknown> }));
}
/** 기다림 표에 n개가 들 때까지(요청이 기다리기 시작했다) */
async function waiting(n: number, timeoutMs = 5_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (table.size() < n) {
    if (performance.now() > end) throw new Error(`기다림 표에 ${n}개가 들지 않았다(지금 ${table.size()})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── 시험 ─────────────────────────────

describe('결제 결과 long polling(앱째)', () => {
  test('FR011_바로 답할 상태가 아닌 RESERVED는 기다리고, 같은 파드의 결제 결과 반영(FAILED → onOrderChanged)이 곧바로 깨워 25초를 기다리지 않고 답한다', async () => {
    const a = assemble();
    const p = await reserved(a);
    table.start();
    const pending = poll(p);
    await waiting(1);
    const appliedAt = performance.now();
    await a.samePod.execute(eventOf(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'USER_ABORTED' }));
    const { r, at, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(body).toEqual({ status: 'FAILED', reason: 'USER_ABORTED', issueDelayed: false, pg: 'TOSS' });
    // 묶음 조회는 꺼 두었다: notify만으로 곧바로 깼다
    expect(at - appliedAt).toBeLessThan(PROMPT_MS);
    expect(table.size()).toBe(0);
  }, 30_000);

  test('FR011_FAILED 반영은 reason(failure_reason = failureCategory)을 실어 곧바로 답한다', async () => {
    const a = assemble();
    const p = await reserved(a);
    table.start();
    const pending = poll(p);
    await waiting(1);
    const appliedAt = performance.now();
    await a.samePod.execute(eventOf(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }));
    const { r, at, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' });
    expect(at - appliedAt).toBeLessThan(PROMPT_MS);
  }, 30_000);

  test('FR011_다른 파드가 바꾼 주문(notify 없음)은 200ms [가정] 묶음 조회로 1초 안팎에 답한다', async () => {
    pollingOn = true;
    const a = assemble();
    const p = await reserved(a);
    table.start();
    const pending = poll(p);
    await waiting(1);
    const appliedAt = performance.now();
    await a.otherPod.execute(eventOf(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'PG_ERROR' }));
    const { r, at, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'FAILED', reason: 'PG_ERROR', issueDelayed: false, pg: 'TOSS' });
    // 목표는 1초 안팎이다(200ms 간격 + 질의 몫). 몰린 기계를 생각해 1.5초까지 둔다(25초 기다림과는 넉넉히 갈린다)
    expect(at - appliedAt).toBeLessThan(PROMPT_MS);
  }, 30_000);

  test('FR011_묶음 조회가 꺼져 있고 notify도 없으면 결과가 정해져도(FAILED) 남은 시간 끝까지 기다린다(대조: 깨움 길 둘만 깨운다)', async () => {
    const a = assemble();
    const p = await reserved(a);
    table.start();
    // 머리 3000 → 기다림 min(25초, 3초 − 1초) = 2초
    const pending = poll(p, { 'x-peaket-deadline-ms': '3000' });
    await waiting(1);
    await a.otherPod.execute(eventOf(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }));
    const { r, tookMs, body } = await pending;
    expect(r.statusCode).toBe(200);
    // 시간이 다 된 뒤 다시 읽어 그때의 상태(FAILED)로 답한다
    expect(body).toEqual({ status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' });
    expect(tookMs).toBeGreaterThanOrEqual(1_900);
    expect(tookMs).toBeLessThan(4_500);
  }, 30_000);

  test('NFR006_남은 시간 상한에 걸리면 그때의 상태(RESERVED)로 200이다(머리 3000 → 약 2초 뒤)', async () => {
    pollingOn = true;
    const a = assemble();
    const p = await reserved(a);
    table.start();
    const { r, tookMs, body } = await poll(p, { 'x-peaket-deadline-ms': '3000' });
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'RESERVED', issueDelayed: false, pg: 'TOSS' });
    expect(tookMs).toBeGreaterThanOrEqual(1_900);
    expect(tookMs).toBeLessThan(4_500);
    expect(table.size()).toBe(0);
  }, 30_000);

  test('FR011_APPROVED(issueDelayed 거짓)는 기다리는 상태다: 같은 파드의 승인 반영이 깨워도 남은 시간 상한까지 기다렸다가 그때의 상태로 답한다(머리 3000 → 약 2초)', async () => {
    pollingOn = true;
    const a = assemble();
    const p = await reserved(a);
    table.start();
    const pending = poll(p, { 'x-peaket-deadline-ms': '3000' });
    await waiting(1);
    // 승인 반영은 기다림을 깨우지 않고(APPROVED는 기다리는 상태, 리뷰 고침 L3), 묶음 조회도 기다리는 상태 사이의 이동으로는 깨우지 않는다
    await a.samePod.execute(eventOf(p));
    const { r, tookMs, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'APPROVED', issueDelayed: false, pg: 'TOSS' });
    expect(tookMs).toBeGreaterThanOrEqual(1_900);
    expect(tookMs).toBeLessThan(4_500);
    expect(table.size()).toBe(0);
  }, 30_000);

  test('PT44_①_결과가 3초 뒤 정해지면(FAILED) 3초 안팎에 확정으로 답한다(25초를 기다리지 않는다)', async () => {
    pollingOn = true;
    const a = assemble();
    const p = await reserved(a);
    table.start();
    const pending = poll(p);
    await waiting(1);
    await sleep(3_000);
    await a.samePod.execute(eventOf(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }));
    const { r, tookMs, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' });
    expect(tookMs).toBeGreaterThanOrEqual(2_900);
    expect(tookMs).toBeLessThan(3_000 + PROMPT_MS + 1_500);
  }, 40_000);

  test('FR011_이미 정해진 주문(FAILED)은 기다리지 않고 바로 답하고, 남의 계정이면 같은 404다', async () => {
    const a = assemble();
    const p = await reserved(a);
    table.start();
    await a.otherPod.execute(eventOf(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }));
    const mine = await poll(p);
    expect(mine.r.statusCode).toBe(200);
    expect(mine.body).toEqual({ status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' });
    expect(mine.tookMs).toBeLessThan(PROMPT_MS);
    const other = await poll({ ...p, o: { ...p.o, accountId: randomUUID() } });
    expect(other.r.statusCode).toBe(404);
    expect(other.body).toMatchObject({ status: 404 });
    const missing = await poll({ ...p, o: { ...p.o, id: randomUUID() } });
    expect(missing.r.statusCode).toBe(404);
    expect({ type: missing.body.type, title: missing.body.title }).toEqual({ type: other.body.type, title: other.body.title });
  }, 30_000);

  test('M1_M2_APPROVED를 기다리는 동안 첫 발권 시도가 실패해 다시 시도 중이 되면(큐 행 시도 1·마지막 오류) 묶음 조회가 깨워 issueDelayed 참으로 곧바로 답한다', async () => {
    pollingOn = true;
    const a = assemble();
    const p = await reserved(a);
    table.start();
    await a.otherPod.execute(eventOf(p));
    const pending = poll(p);
    await waiting(1);
    const failedAt = performance.now();
    // 발권 실행기(PRF-170)가 할 일을 SQL로 흉내 낸다: 첫 발권 시도가 실패했다
    await admin.pool.query("update ticket_issue_job set attempts = 1, last_error = 'UNAVAILABLE' where order_id = $1", [p.o.id]);
    const { r, at, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'APPROVED', issueDelayed: true, pg: 'TOSS' });
    expect(at - failedAt).toBeLessThan(PROMPT_MS);
    expect(table.size()).toBe(0);
  }, 30_000);

  // 가짜 시계를 60초 당기므로 파일의 마지막에 둔다(머리 주석 '정본 모호')
  test('M2_ADR0106_APPROVED를 기다리는 동안 승인 뒤 60초 [가정]가 지나면(issueDelayed 거짓 → 참) 묶음 조회가 깨워 곧바로 답한다', async () => {
    pollingOn = true;
    const a = assemble();
    const p = await reserved(a);
    table.start();
    await a.otherPod.execute(eventOf(p));
    // 시작 때는 issueDelayed 거짓이라 기다린다
    const pending = poll(p);
    await waiting(1);
    // 승인(큐 행 created_at = 그때의 앱 시계)부터 60초가 흐른다. 큐 행을 지울 발권은 이 시험에 없다
    const advancedAt = performance.now();
    clock.advance(60_000);
    const { r, at, body } = await pending;
    expect(r.statusCode).toBe(200);
    expect(body).toEqual({ status: 'APPROVED', issueDelayed: true, pg: 'TOSS' });
    expect(at - advancedAt).toBeLessThan(PROMPT_MS);
    expect(table.size()).toBe(0);
  }, 30_000);
});
