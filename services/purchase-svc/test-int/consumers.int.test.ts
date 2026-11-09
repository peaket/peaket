// API 파드의 Kafka 소비자 둘(startPurchaseConsumers)의 통합 시험(BUILD_ORDER PRF-164): 실제 PostgreSQL 18·Valkey 8.1·Kafka(apache/kafka:3.9.2) 한 대씩.
// 결제 결과(trade.payments → PaymentResultHandler → ApplyPaymentResult)와 홀드 원장 적재(trade.seats → SeatHoldLedgerHandler → seat_hold)를
// 실제 플랫폼 키 단위 소비자(runKeyedConsumer, ADR-0142)로 돈다.
// 정본: docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현'(프로세스 둘·소비자 그룹), docs/features/payment.md §2 '결제 결과 반영의 첫 구현',
// docs/streaming.md §2.6, docs/data.md §4의 15번(held_event: 같은 결과일 실패 5회 뒤 보류), docs/verification.md §4.1 'API 파드의 Kafka 소비자 둘'.
//
// 약속:
// - 결제 결과 쪽 조립: Saga는 payment-result-e2e.int.test.ts와 같고(DrizzleSaga·OrderSagaRunner(승인 명령 기록 대역·손으로 부르는 타이머)), 반영 쓰임새는
//   운영 main.ts와 같은 조립 함수 paymentResultApply(src/consumers.ts, 리뷰 고침 변이 검토)로 만든다. onOrderChanged는 불린 주문 ID를 적는 대역이다
//   (운영 main.ts는 기다림 표 notify를 넘긴다).
// - Kafka 메시지는 시험의 생산자가 직접 보낸다(trade.payments: 키 = 회차 ID, 값 = PaymentEvent JSON / trade.seats: 키 = 회차 ID, 값 = SeatEvent JSON).
// - 소비 진행은 브로커의 소비자 그룹 커밋 위치로 본다. 그룹 이름은 정본 글(peaket.purchase-svc-hold-ledger.<환경>·peaket.purchase-svc-order-saga.<환경>)을
//   시험이 따로 적는다(운영 상수를 기대 값으로 쓰지 않는다).
// - 소비자는 파일 전체가 하나를 나눠 쓴다(처음 부른 시험이 켠다). 시험 준비(주문 만들기 등)를 끝낸 뒤 켠다(뼈대 단계에서도 준비가 맞는지 드러나게).
//   stop() 시험은 맨 끝이다.
// - 앱 시계는 Valkey 시계에 맞춘 가짜 시계다(홀드·묶기 Lua가 Redis TIME을 쓴다). 소비자의 커밋·다시 하기 쉬기는 실제 시간이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, PlatformMetrics, requestFingerprint, uuidv7 } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { paymentResultApply, type PurchaseConsumers, startPurchaseConsumers } from '../src/consumers.js';
import {
  type ConfirmCommand,
  type ConfirmOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzleSaga,
  InventoryOrderSeatPins,
  InventorySeatSlots,
  type NewOrder,
  OrderSagaRunner,
  type PaymentConfirms,
  type PaymentRefs,
  type SagaLog,
  SeatMapSagaConfigs,
} from '../src/modules/booking/index.js';
import {
  DrizzleSeatHoldLedger,
  DrizzleSeatSales,
  EndPurchaseSession,
  type EventSeatConfig,
  type HoldInput,
  KEEP_AFTER_SALE_END_MS,
  MemorySeatMap,
  RedisPurchaseSessionStore,
  RedisSeatSlots,
  RedisSeatStore,
  RedisSessionEndedLog,
  SEAT_TOPIC,
  type SeatRef,
} from '../src/modules/inventory/index.js';
import { fingerprintOf } from '../test/hold-cases.js';
import { openInput } from '../test/purchase-session-cases.js';
import { type KafkaContainer, startKafka, until } from './kafka.js';
import { accountActor, iso, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { seatEventKeyOf } from './seat-stream.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const PRICES = { R: 99_000, S: 132_000 } as const;
const SEAT_COUNT = 10;
const LIMIT = 4;
/** trade.payments(asyncapi). 운영 상수를 가져오지 않고 따로 적는다 */
const PAYMENTS = 'trade.payments';
/** 환경 이름(소비자 그룹 이름 끝) */
const ENV = 'it';
const SAGA_GROUP = 'peaket.purchase-svc-order-saga.it';
const LEDGER_GROUP = 'peaket.purchase-svc-hold-ledger.it';
/** 보류까지 해 보는 횟수 5회 [가정]와 그 사이 쉬기 0.2·0.4·0.8·1.6초 [가정](합 3초)를 넉넉히 넘는 기다림 */
const HELD_WAIT_MS = 30_000;

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let kafka: KafkaContainer | undefined;
let redis: HotRedis;
let database: Database;
let admin: Database;
let producer: KafkaProducer;
let clock: ReturnType<typeof fakeClock>;
const seatMap = new MemorySeatMap();

beforeAll(async () => {
  const [p, v, k] = await Promise.allSettled([startPostgres(), startValkey(), startKafka()]);
  if (p.status === 'fulfilled') pgServer = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  if (k.status === 'fulfilled') kafka = k.value;
  for (const r of [p, v, k]) if (r.status === 'rejected') throw r.reason as Error;
  await kafka!.createTopic(PAYMENTS, 3);
  await kafka!.createTopic(SEAT_TOPIC, 3);
  redis = await createHotRedis({ url: valkey!.url });
  // 앱 시계를 Valkey 시계에 맞춘다(payment-result-e2e.int.test.ts와 같은 방식)
  const samples: number[] = [];
  for (let n = 0; n < 5; n += 1) {
    const before = Date.now();
    const t = (await redis.command(['TIME'], {})) as unknown[];
    samples.push(Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) - Math.round((before + Date.now()) / 2));
  }
  clock = fakeClock({ now: Date.now() + samples.sort((a, b) => a - b)[2]! });
  await migratePurchase(pgServer!.url);
  await ensureSeatHoldPartitions(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 10, applicationName: 'consumers-it' });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'consumers-it-admin' });
  await ensureOutboxPartitions(admin, clock);
  producer = createKafkaProducer({ brokers: kafka!.brokers, clientId: 'consumers-it-producer', kind: 'default' });
  await producer.connect();
}, 240_000);

afterAll(async () => {
  const c = await consumers?.catch(() => undefined);
  await c?.stop().catch(() => {});
  await producer?.disconnect().catch(() => {});
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  kafka?.stop();
  pgServer?.stop();
});

// ───────────────────────────── 조립 ─────────────────────────────

function recordingConfirms(): PaymentConfirms & { calls: ConfirmCommand[] } {
  const calls: ConfirmCommand[] = [];
  return {
    calls,
    confirm: async (c, o): Promise<ConfirmOutcome> => {
      await o?.beforeSend?.();
      calls.push(c);
      return { status: 'ACCEPTED', result: 'IN_PROGRESS' };
    },
  };
}
const sagaLog: SagaLog = { releaseFailed: () => {}, confirmRejected: () => {}, stepError: () => {} };
/** 결제 결과 반영 로그(LoggerPaymentResultLog)가 남긴 줄. 로거 형은 플랫폼(pino) 로거라 대역은 never로 넘긴다(order-adapters.test.ts와 같은 방식) */
const resultLines: { level: 'warn' | 'error'; obj: object; msg?: string }[] = [];
const resultLogger = {
  warn: (obj: object, msg?: string) => void resultLines.push({ level: 'warn', obj, msg }),
  error: (obj: object, msg?: string) => void resultLines.push({ level: 'error', obj, msg }),
} as never;
const manualTimer = { setInterval: () => 1, clearInterval: () => {} };
/** onOrderChanged가 불린 주문 ID(불린 차례) */
const changed: string[] = [];

function assemble() {
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  const saga = new DrizzleSaga({ database, store, sales, clock });
  const runner = new OrderSagaRunner({
    jobs: saga,
    orders: saga,
    reserve: saga,
    failures: saga,
    confirmSent: saga,
    pins: new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap }),
    confirms: recordingConfirms(),
    configs: new SeatMapSagaConfigs(seatMap),
    log: sagaLog,
    clock,
    timer: manualTimer,
  });
  const sessionStore = new RedisPurchaseSessionStore(redis);
  // 운영 main.ts와 같은 조립 함수(리뷰 고침 변이 검토): 결과 저장소·판매 저장소·구매 세션 다리·로그를 이 함수가 만든다
  const apply = paymentResultApply({
    database,
    store,
    sessions: { end: new EndPurchaseSession({ store: sessionStore, ended: new RedisSessionEndedLog(redis), clock }), store: sessionStore },
    saga: runner,
    logger: resultLogger,
    clock,
    onOrderChanged: (id) => void changed.push(id),
  });
  return { store, runner, sessionStore, apply, accepts: new DrizzleOrderAccepts({ database, store, clock }) };
}
type Assembled = ReturnType<typeof assemble>;
let assembled: Assembled | undefined;
const app = (): Assembled => (assembled ??= assemble());

const consumerWarnings: string[] = [];
let consumers: Promise<PurchaseConsumers> | undefined;
/** 파일 전체가 나눠 쓰는 소비자 둘(처음 부를 때 켜고 연결·구독까지 기다린다) */
function running(): Promise<PurchaseConsumers> {
  consumers ??= (async () => {
    const c = startPurchaseConsumers({
      env: ENV,
      brokers: kafka!.brokers,
      clientId: `purchase-svc-${ENV}-consumers-it`,
      database,
      ledger: new DrizzleSeatHoldLedger(database),
      applyPaymentResult: app().apply,
      registry: new PlatformMetrics('purchase-svc').registry,
      logger: { warn: (_o, msg) => void consumerWarnings.push(String(msg)) },
    });
    await c.started;
    return c;
  })();
  return consumers;
}

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];

interface World {
  eventId: string;
  refs: SeatRef[];
  keepUntilMs: number;
}
/** 회차 하나: 좌석맵 판(구역 A 등급 R 6석, 구역 B 등급 S 4석, 1인 한도 4)과 좌석 Redis 판매 열기 */
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
  hold: HoldInput;
}

/** 구매 세션 열기·Paying → 홀드 → 주문(T1) → READY 시도 → 결제 접수 → Saga 한 번(묶기·판매 예약·승인 명령 대역) → RESERVED */
async function reservedOrder(w: World, seats: SeatRef[] = [w.refs[0]!, w.refs[1]!]): Promise<Placed> {
  const a = app();
  const accountId = randomUUID();
  const psid = `jti-${randomUUID()}`;
  expect((await a.sessionStore.open(openInput({ now: () => clock.now() }, psid, { accountId, eventId: w.eventId }))).kind).toBe('CREATED');
  expect(await a.sessionStore.setPaying(psid, true)).toBe(true);
  const sorted = [...seats].sort((x, y) => (x.seatId < y.seatId ? -1 : 1));
  const hold: HoldInput = {
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
  const held = await new RedisSeatStore(redis).hold(hold);
  expect(held.kind, JSON.stringify(held)).toBe('OK');
  const items = sorted.map((s) => ({ seatId: s.seatId, tierId: s.tierId, sectionId: s.sectionId, unitPrice: PRICES[s.tierId as 'R' | 'S'] }));
  const o = newOrderInput(clock, { eventId: w.eventId, accountId, holdId: hold.holdId, purchaseSessionId: psid, items });
  await database.transaction((tx) => a.store.createOrder(tx, o));
  const refs: PaymentRefs = { pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` };
  const attemptId = uuidv7(clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [attemptId, o.id, refs.pg, o.id, 'READY', new Date(clock.now())]);
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
  expect((await orderRow(o.id))?.status).toBe('RESERVED');
  return { w, o, hold };
}

/** 결제 사건 값(asyncapi PaymentEvent) */
const paymentEvent = (p: Placed, x: Record<string, unknown> = {}): Record<string, unknown> => ({
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

/** 직접 만든 HELD SeatEvent(릴레이를 거치지 않는 레코드, seat-hold-ledger-e2e.int.test.ts와 같은 모양). 회차 ID는 이번 달 UUIDv7(seat_hold 파티션) */
function directHeld(eventId: string, seatId: string, heldAtMs: number): Record<string, unknown> {
  const holdId = uuidv7(clock);
  const token = 1_762_250_000_000_301;
  return {
    eventId,
    seatId,
    tierId: 'R',
    sectionId: 'SEC-A',
    type: 'HELD',
    fencingToken: token,
    sectionVersion: 1,
    seatEpoch: 1,
    holdId,
    holdKind: 'FAN',
    purchaseSessionId: randomUUID(),
    accountId: randomUUID(),
    expiresAt: iso(heldAtMs + 7 * 60_000),
    occurredAt: iso(heldAtMs),
    eventKey: seatEventKeyOf('HELD', eventId, holdId, seatId, token),
  };
}

const send = (topic: string, key: string, value: object) => producer.send({ topic, messages: [{ key, value: Buffer.from(JSON.stringify(value), 'utf8') }] });

const orderRow = async (id: string) =>
  (await q<{ status: string; failure_reason: string | null; payment_event_seq: string }>('select status, failure_reason, payment_event_seq::text as payment_event_seq from purchase_order where id = $1', [id]))[0];
const historyCauses = async (id: string) => (await q<{ cause: string }>('select cause from order_event where order_id = $1 order by seq', [id])).map((r) => r.cause);
const salesOf = (eventId: string) => q<{ seat_id: string; status: string }>('select seat_id, status from seat_sale where event_id = $1 order by seat_id', [eventId]);
const issueJobs = (orderId: string) => q<{ order_id: string }>('select order_id from ticket_issue_job where order_id = $1', [orderId]);
const outboxTypes = async (eventId: string, orderId: string) =>
  (await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]))
    .map((r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string; orderId: string })
    .filter((e) => e.orderId === orderId)
    .map((e) => e.type);
const seatHoldRows = (eventId: string) =>
  q<{ seat_id: string; account_id: string; fencing_token: string; status: string }>(
    'select seat_id, account_id, fencing_token::text as fencing_token, status from seat_hold where event_id = $1 order by seat_id',
    [eventId],
  );
const heldOf = (topic: string, businessKey: string) =>
  q<{ business_key: string; event_key: string | null; error: string }>('select business_key, event_key, error from held_event where topic = $1 and business_key = $2 order by kafka_offset', [
    topic,
    businessKey,
  ]);

/** 소비자 그룹이 토픽의 끝까지 처리하고 커밋했다(레코드가 있는 모든 파티션의 커밋 위치 = 끝 위치) */
async function drained(group: string, topic: string): Promise<boolean> {
  const [ends, committed] = await Promise.all([kafka!.endOffsets(topic), kafka!.groupOffsets(group, topic)]);
  return [...ends].every(([p, end]) => end === 0 || committed.get(p) === end);
}

// ───────────────────────────── 시험 ─────────────────────────────

describe('결제 결과 소비자(trade.payments, 그룹 peaket.purchase-svc-order-saga.<환경>)', () => {
  test('PT12_trade.payments의 APPROVED 사건 하나 → 주문 APPROVED(T9)·판매 행 SOLD·ticket_issue_job, 승인 전이라 onOrderChanged는 부르지 않고(APPROVED는 아직 기다리는 상태, docs/features/payment.md §2 \'알림 길\') 그룹 peaket.purchase-svc-order-saga.it가 끝까지 커밋한다(보류 없음) [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const p = await reservedOrder(w);
    await running();

    await send(PAYMENTS, w.eventId, paymentEvent(p, { occurredAt: iso(clock.now()) }));
    await until(async () => (await orderRow(p.o.id))?.status === 'APPROVED', '주문 APPROVED', 30_000, 100);
    await until(() => drained(SAGA_GROUP, PAYMENTS), '결제 결과 그룹이 끝까지 커밋', 30_000, 500);

    expect(await orderRow(p.o.id)).toEqual({ status: 'APPROVED', failure_reason: null, payment_event_seq: '1' });
    expect(await historyCauses(p.o.id)).toEqual(['T1', 'T3', 'T4', 'T7', 'T9']);
    expect((await salesOf(w.eventId)).map((s) => s.status)).toEqual(['SOLD', 'SOLD']);
    expect(await issueJobs(p.o.id)).toHaveLength(1);
    expect(changed).not.toContain(p.o.id);
    expect(await heldOf(PAYMENTS, p.o.id)).toEqual([]);
  }, 90_000);

  test('PT2_trade.payments의 FAILED(CARD_DECLINED) 사건 하나 → 주문 FAILED·failure_reason, 바로 답할 상태라 onOrderChanged가 그 주문 ID로 한 번 불린다(조립이 기다림 표 깨우기를 넘김) [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const p = await reservedOrder(w);
    await running();

    await send(PAYMENTS, w.eventId, paymentEvent(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }));
    await until(async () => (await orderRow(p.o.id))?.status === 'FAILED', '주문 FAILED', 30_000, 100);
    await until(async () => changed.includes(p.o.id), 'onOrderChanged', 10_000, 50);
    await until(() => drained(SAGA_GROUP, PAYMENTS), '결제 결과 그룹이 끝까지 커밋', 30_000, 500);

    expect(await orderRow(p.o.id)).toEqual({ status: 'FAILED', failure_reason: 'CARD_DECLINED', payment_event_seq: '1' });
    expect(changed.filter((id) => id === p.o.id)).toHaveLength(1);
    expect(await issueJobs(p.o.id)).toHaveLength(0);
    expect(await heldOf(PAYMENTS, p.o.id)).toEqual([]);
  }, 90_000);
});

describe('홀드 원장 적재 소비자(trade.seats, 그룹 peaket.purchase-svc-hold-ledger.<환경>)', () => {
  test('ST35_trade.seats의 HELD 사건 하나 → seat_hold HELD 행 하나(좌석·계정·펜싱 토큰 그대로), 그룹 peaket.purchase-svc-hold-ledger.it가 끝까지 커밋한다(보류 없음)', async () => {
    const eventId = uuidv7(clock);
    const seatId = randomUUID();
    const e = directHeld(eventId, seatId, Date.now());
    await running();

    await send(SEAT_TOPIC, eventId, e);
    await until(async () => (await seatHoldRows(eventId)).length > 0, 'seat_hold 행', 30_000, 100);
    await until(() => drained(LEDGER_GROUP, SEAT_TOPIC), '원장 적재 그룹이 끝까지 커밋', 30_000, 500);

    expect(await seatHoldRows(eventId)).toEqual([{ seat_id: seatId, account_id: e.accountId, fencing_token: String(e.fencingToken), status: 'HELD' }]);
    expect(await heldOf(SEAT_TOPIC, `${eventId}:${seatId}`)).toEqual([]);
  }, 90_000);
});

describe('다시 온 사건·처리할 수 없는 사건', () => {
  test('PT15_같은 사건이 두 번(다른 오프셋) 와도 한 번만 반영한다: APPROVED 두 번 → 이력 T9·Outbox APPROVED·ticket_issue_job이 하나씩(승인 전이라 onOrderChanged는 없음), HELD 두 번 → seat_hold 행 하나 [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world();
    const p = await reservedOrder(w);
    const seatEvent = uuidv7(clock);
    const seatId = randomUUID();
    const heldValue = directHeld(seatEvent, seatId, Date.now());
    const value = paymentEvent(p, { eventSeq: 4 });
    await running();

    await send(PAYMENTS, w.eventId, value);
    await send(PAYMENTS, w.eventId, value);
    await send(SEAT_TOPIC, seatEvent, heldValue);
    await send(SEAT_TOPIC, seatEvent, heldValue);
    await until(async () => (await drained(SAGA_GROUP, PAYMENTS)) && (await drained(LEDGER_GROUP, SEAT_TOPIC)), '두 그룹이 끝까지 커밋', 30_000, 500);

    expect(await orderRow(p.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '4' });
    expect(await historyCauses(p.o.id)).toEqual(['T1', 'T3', 'T4', 'T7', 'T9']);
    expect((await outboxTypes(w.eventId, p.o.id)).filter((t) => t === 'APPROVED')).toHaveLength(1);
    expect(await issueJobs(p.o.id)).toHaveLength(1);
    expect(changed.filter((id) => id === p.o.id)).toHaveLength(0);
    expect(await heldOf(PAYMENTS, p.o.id)).toEqual([]);
    expect(await seatHoldRows(seatEvent)).toHaveLength(1);
  }, 90_000);

  test('처리할 수 없는 사건(amount가 빠진 결제 사건, accountId가 빠진 HELD)은 5회 [가정] 해 본 뒤 purchase DB held_event에 보류되고(결제는 주문 ID 키, HELD는 회차:좌석 키), 같은 회차의 바른 HELD(다른 좌석)는 막히지 않는다. 주문은 RESERVED 그대로 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-16.3.3]', async () => {
    const w = await world();
    const p = await reservedOrder(w);
    const { amount: _amount, ...badPayment } = paymentEvent(p);
    const seatEvent = uuidv7(clock);
    const badSeat = randomUUID();
    const goodSeat = randomUUID();
    const { accountId: _account, ...badHeld } = directHeld(seatEvent, badSeat, Date.now());
    const goodHeld = directHeld(seatEvent, goodSeat, Date.now());
    await running();

    await send(PAYMENTS, w.eventId, badPayment);
    await send(SEAT_TOPIC, seatEvent, badHeld);
    await send(SEAT_TOPIC, seatEvent, goodHeld);
    await until(
      async () => (await heldOf(PAYMENTS, p.o.id)).length > 0 && (await heldOf(SEAT_TOPIC, `${seatEvent}:${badSeat}`)).length > 0,
      '두 소비자의 보류 행',
      HELD_WAIT_MS,
      200,
    );
    await until(async () => (await drained(SAGA_GROUP, PAYMENTS)) && (await drained(LEDGER_GROUP, SEAT_TOPIC)), '두 그룹이 끝까지 커밋', 30_000, 500);

    const heldPayment = await heldOf(PAYMENTS, p.o.id);
    expect(heldPayment.map((h) => [h.business_key, h.event_key])).toEqual([[p.o.id, null]]);
    expect(heldPayment[0]!.error).toContain('RangeError');
    expect(heldPayment[0]!.error).not.toContain(String(p.o.amount));
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'RESERVED', payment_event_seq: '0' });
    expect(changed).not.toContain(p.o.id);
    expect(await heldOf(SEAT_TOPIC, `${seatEvent}:${badSeat}`)).toHaveLength(1);
    expect((await seatHoldRows(seatEvent)).map((r) => r.seat_id)).toEqual([goodSeat]);
  }, 90_000);
});

describe('멈춤(맨 끝)', () => {
  test('stop() 뒤에는 더 읽지 않는다: 멈춘 뒤 보낸 APPROVED는 반영되지 않고(주문 RESERVED·onOrderChanged 없음) 그룹 커밋 위치가 끝에 닿지 않으며, stop()을 두 번 불러도 된다', async () => {
    const w = await world();
    const p = await reservedOrder(w);
    const c = await running();
    await until(() => drained(SAGA_GROUP, PAYMENTS), '멈추기 전 결제 결과 그룹이 끝까지 커밋', 30_000, 500);

    await c.stop();
    await send(PAYMENTS, w.eventId, paymentEvent(p));
    // '읽지 않음'을 보는 자리라 커밋 주기(1초 [가정])와 처리 시간을 넉넉히 넘게 기다린다
    await new Promise((r) => setTimeout(r, 4_000));

    expect(await orderRow(p.o.id)).toMatchObject({ status: 'RESERVED', payment_event_seq: '0' });
    expect(changed).not.toContain(p.o.id);
    expect(await drained(SAGA_GROUP, PAYMENTS)).toBe(false);
    await expect(c.stop()).resolves.toBeUndefined();
  }, 90_000);
});
