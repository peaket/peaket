// 결제 결과 반영을 처음부터 끝까지 돈다: 실제 PostgreSQL 18·실제 Valkey 8.1, 승인 명령만 대역, Kafka 없이 키 단위 처리기(BUILD_ORDER PRF-163).
// 홀드(홀드 Lua) → 구매 세션 열기·Paying → 주문 생성 → 결제 시도 READY 직접 넣기 → 결제 접수 → Saga(OrderSagaRunner.runOne: 묶기 → 판매 예약 → 승인 명령 대역)
// → trade.payments PaymentEvent(JSON 대역) → 플랫폼 KeyedPartition(파티션 하나의 키 단위 규칙, Kafka 클라이언트와 상관없다)
// → PaymentResultHandler → ApplyPaymentResult(DrizzlePaymentResults, InventoryPaymentResultSessions, 깨우기는 OrderSagaRunner.kick) → 보류 표 held_event(drizzleHeldEventStore).
// 정본: docs/features/payment.md §2 '결제 결과 반영의 첫 구현'(전이·보류·승인·실패 트랜잭션·커밋 뒤)·'Saga 1단계의 첫 구현'(작업 행의 끝·실패 해제와 늦은 묶기)·
// '주문 Saga 소비자의 키 단위 동시 처리'(ADR-0142), 시험 표 P-T2(승인 실패: PENDING 삭제·비트맵 해제·과금 0)·P-T12(결제에 성공하면 세션을 비운다)·
// P-T15(같은 eventKey 한 번, 늦게 온 앞 순번 건너뜀), docs/data.md §4의 15번(held_event: 같은 결과일 실패 5회 뒤 보류, 같은 키의 뒤 사건도 보류)·§5 '결제 결과 반영'.
//
// 약속:
// - 조립은 saga-e2e.int.test.ts와 같다(DrizzleSaga·InventoryOrderSeatPins·SeatMapSagaConfigs·기록 대역 승인 명령·손으로 부르는 타이머). 결제 결과 쪽 조립은 PRF-164가
//   main.ts에 붙일 차례를 따른다: DrizzlePaymentResults({ database, store, sales: DrizzleSeatSales, clock }),
//   InventoryPaymentResultSessions({ end: EndPurchaseSession(RedisPurchaseSessionStore·RedisSessionEndedLog), store: RedisPurchaseSessionStore }).
// - 소비자는 KeyedPartition을 직접 만든다(실제 Kafka의 runKeyedConsumer는 seat-hold-ledger-e2e.int.test.ts가 이미 본다). 메시지는 토픽 trade.payments,
//   Kafka 키 = 회차 ID(asyncapi 설명), 오프셋은 시험이 매긴다. 같은 결과일 실패 사이 쉬기는 기록만 하고 기다리지 않는 sleep 대역이다.
// - 앱 시계는 Valkey 시계에 맞춘 가짜 시계다(홀드·묶기 Lua가 Redis TIME을 쓴다). 회차·계정·좌석 ID는 시험마다 새 UUID다.
//
// 정본 모호:
// - 결제 사건 eventId 칸은 회차 ID다(payment-result.ts PaymentResultEvent). 보류 행의 business_key는 주문 ID(처리기 keyOf), event_key는 사건 eventKey다.
// - 보류 행 error는 플랫폼 errorSummary('이름: 글')다. 금액·결제 참조를 싣지 않는지만 본다.
// - '과금 0'(P-T2)은 FAILED 뒤 승인 명령을 더 보내지 않고(대역 호출 수 그대로) ticket_issue_job이 없다는 것으로 본다(결제 쪽 과금은 payment-svc 몫).
// 리뷰(2026-11-05) 반영: M1 Saga가 RETRYABLE로 기다리는 사이 AWAITING_DEPOSIT → 결제 참조 비움, M2 닫힌 주문 과금은 CHARGED_ON_CLOSED_ORDER,
// M3 취소 사건은 보류 표에 남김, L5 보류 한 건에 쓰임새 보류 로그 한 줄. 보류 시험은 20초 시간 한도를 건다(보류 오류가 일시 실패로 바뀌면 멈추지 않고 실패하게).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  type ConsumedMessage,
  createDatabase,
  createHotRedis,
  type Database,
  drizzleHeldEventStore,
  ensureOutboxPartitions,
  fakeClock,
  type HotRedis,
  KEYED_CONSUMER_DEFAULTS,
  KeyedPartition,
  requestFingerprint,
  uuidv7,
} from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  ApplyPaymentResult,
  type ConfirmCommand,
  type ConfirmOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzlePaymentResults,
  DrizzleSaga,
  InventoryOrderSeatPins,
  InventoryPaymentResultSessions,
  InventorySeatSlots,
  type NewOrder,
  OrderSagaRunner,
  type PaymentConfirms,
  type PaymentRefs,
  type PaymentResultLog,
  PaymentResultHandler,
  type PaymentResultRecord,
  type SagaLog,
  SeatMapSagaConfigs,
} from '../src/modules/booking/index.js';
import {
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
  type SeatRef,
  seatKeys,
  sessionKeys,
} from '../src/modules/inventory/index.js';
import { fingerprintOf } from '../test/hold-cases.js';
import { openInput } from '../test/purchase-session-cases.js';
import { accountActor, iso, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const MIN = 60_000;
const PRICES = { R: 99_000, S: 132_000 } as const;
const SEAT_COUNT = 10;
const LIMIT = 4;
/** trade.payments(asyncapi). 운영 상수를 가져오지 않고 따로 적는다 */
const TOPIC = 'trade.payments';
/** 발권 기한 = 승인 + 30분 [가정] */
const ISSUE_WINDOW_MS = 30 * MIN;

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let database: Database;
let admin: Database;
let clock: ReturnType<typeof fakeClock>;
const seatMap = new MemorySeatMap();

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'fulfilled') pgServer = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  for (const r of [p, v]) if (r.status === 'rejected') throw r.reason as Error;
  redis = await createHotRedis({ url: valkey!.url });
  // 앱 시계를 Valkey 시계에 맞춘다(saga-e2e.int.test.ts와 같은 방식)
  const samples: number[] = [];
  for (let k = 0; k < 5; k += 1) {
    const before = Date.now();
    const t = (await redis.command(['TIME'], {})) as unknown[];
    samples.push(Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) - Math.round((before + Date.now()) / 2));
  }
  clock = fakeClock({ now: Date.now() + samples.sort((a, b) => a - b)[2]! });
  await migratePurchase(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 10, applicationName: 'payment-result-e2e' });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'payment-result-e2e-admin' });
  await ensureOutboxPartitions(admin, clock);
});

afterAll(async () => {
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  pgServer?.stop();
});

// ───────────────────────────── 조립 ─────────────────────────────

/** 승인 명령 기록 대역(기본 늘 ACCEPTED). 보내기 바로 전에 beforeSend(confirm_sent_at 적기)를 부른다 */
function recordingConfirms(answer: () => ConfirmOutcome = () => ({ status: 'ACCEPTED', result: 'IN_PROGRESS' })): PaymentConfirms & { calls: ConfirmCommand[] } {
  const calls: ConfirmCommand[] = [];
  return {
    calls,
    confirm: async (c, o): Promise<ConfirmOutcome> => {
      await o?.beforeSend?.();
      calls.push(c);
      return answer();
    },
  };
}
function recordingSagaLog(): SagaLog & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    releaseFailed: () => void lines.push('releaseFailed'),
    confirmRejected: () => void lines.push('confirmRejected'),
    stepError: (e) => void lines.push(`stepError:${e.step}:${String(e.err)}`),
  };
}
function recordingResultLog(): PaymentResultLog & { lines: { kind: string; e: unknown }[] } {
  const lines: { kind: string; e: unknown }[] = [];
  return {
    lines,
    held: (e) => void lines.push({ kind: 'held', e }),
    afterCommitFailed: (e) => void lines.push({ kind: 'afterCommitFailed', e }),
  };
}
const manualTimer = { setInterval: () => 1, clearInterval: () => {} };

function assemble(o: { confirm?: () => ConfirmOutcome } = {}) {
  const store = new DrizzleOrderStore({ clock });
  const sales = new DrizzleSeatSales(database);
  const saga = new DrizzleSaga({ database, store, sales, clock });
  const confirms = recordingConfirms(o.confirm);
  const sagaLog = recordingSagaLog();
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
  const resultLog = recordingResultLog();
  const apply = new ApplyPaymentResult({ reads: results, writes: results, sessions, saga: runner, log: resultLog, clock });
  const handler = new PaymentResultHandler(apply);
  return { store, saga, runner, confirms, sagaLog, resultLog, handler, sessionStore, accepts: new DrizzleOrderAccepts({ database, store, clock }) };
}
type Assembled = ReturnType<typeof assemble>;

/** 키 단위 처리기 파티션 하나(Kafka 없이). 같은 결과일 실패 사이 쉬기는 기록만 한다 */
async function partitionOf(a: Assembled) {
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  const p = new KeyedPartition<PaymentResultRecord>({
    topic: TOPIC,
    partition: 0,
    handler: a.handler,
    held: drizzleHeldEventStore(database, clock),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onError: (e) => void errors.push(e),
  });
  await p.init();
  return { p, sleeps, errors };
}
let offset = 0n;
/** trade.payments 메시지 하나(Kafka 키 = 회차 ID, 값 = PaymentEvent JSON) */
function messageOf(value: Record<string, unknown> | null, key: string): ConsumedMessage {
  offset += 1n;
  return { topic: TOPIC, partition: 0, offset, key, value: value === null ? null : Buffer.from(JSON.stringify(value), 'utf8'), headers: {}, timestamp: clock.now() };
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
  attemptId: string;
  refs: PaymentRefs;
  psid: string;
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

/** 구매 세션 열기(jti = 구매 세션 ID)·Paying → 홀드 → 주문(T1) → READY 시도 → 결제 접수(작업 RESERVE) */
async function placeAndAccept(a: Assembled, w: World, x: { seats?: SeatRef[] } = {}): Promise<Placed> {
  const accountId = randomUUID();
  const psid = `jti-${randomUUID()}`;
  const opened = await a.sessionStore.open(openInput({ now: () => clock.now() }, psid, { accountId, eventId: w.eventId }));
  expect(opened.kind).toBe('CREATED');
  expect(await a.sessionStore.setPaying(psid, true)).toBe(true);
  const hold = await holdSeats(w, accountId, x.seats ?? [w.refs[0]!, w.refs[1]!], psid);
  const items = hold.seats.map((s) => ({ seatId: s.seatId, tierId: s.tierId, sectionId: s.sectionId, unitPrice: PRICES[s.tierId as 'R' | 'S'] }));
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
  return { w, o, hold, attemptId, refs, psid };
}
/** 접수 뒤 Saga를 한 번 돌려 RESERVED(승인 명령 대역이 접수, 결제 참조 지움·작업 행 AWAIT, PRF-171)까지 */
async function reservedBySaga(a: Assembled, w: World, x: { seats?: SeatRef[] } = {}): Promise<Placed> {
  const p = await placeAndAccept(a, w, x);
  expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });
  expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
  return p;
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

const orderRow = async (id: string) =>
  (await q<{ status: string; failure_reason: string | null; payment_event_seq: string }>('select status, failure_reason, payment_event_seq::text as payment_event_seq from purchase_order where id = $1', [id]))[0];
const historyCauses = async (id: string) => (await q<{ cause: string }>('select cause from order_event where order_id = $1 order by seq', [id])).map((r) => r.cause);
const jobOf = async (orderId: string) => (await q<{ step: string; attempts: number }>('select step, attempts from order_saga_job where order_id = $1', [orderId]))[0];
const salesOf = (eventId: string) => q<{ seat_id: string; order_id: string; status: string }>('select seat_id, order_id, status from seat_sale where event_id = $1 order by seat_id', [eventId]);
const quotaOf = async (accountId: string, eventId: string) => (await q<{ used: number }>('select used from purchase_quota where account_id = $1 and event_id = $2', [accountId, eventId]))[0]?.used;
const issueJobOf = async (orderId: string) =>
  (await q<{ event_id: string; attempts: number; issue_due_at: Date }>('select event_id, attempts, issue_due_at from ticket_issue_job where order_id = $1', [orderId]))[0];
const outboxTypes = async (eventId: string, orderId: string) =>
  (await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]))
    .map((r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string; orderId: string })
    .filter((e) => e.orderId === orderId)
    .map((e) => e.type);
const heldOf = (businessKey: string) =>
  q<{ business_key: string; event_key: string | null; error: string; msg_key: string | null; kafka_offset: string }>(
    // 차례는 표의 bigint 칸으로 본다(글로 바꾼 별칭으로 줄 세우면 '10'이 '9'보다 앞선다)
    'select business_key, event_key, error, msg_key, kafka_offset::text as kafka_offset from held_event where topic = $1 and business_key = $2 order by held_event.kafka_offset',
    [TOPIC, businessKey],
  );

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const bit = async (e: string, i: number) => Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(i)]));
async function hashOf(key: string): Promise<Record<string, string> | null> {
  const v = await cmd(key, ['HGETALL', key]);
  let o: Record<string, string> = {};
  if (v instanceof Map) o = Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  else if (Array.isArray(v)) for (let k = 0; k + 1 < v.length; k += 2) o[String(v[k])] = String(v[k + 1]);
  else if (v && typeof v === 'object') o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return Object.keys(o).length ? o : null;
}
const failedMark = async (e: string, holdId: string) => {
  const k = `s:{event:${e}}:failed:${holdId}`;
  const v = await cmd(k, ['GET', k]);
  return v === null || v === undefined ? null : String(v);
};
const sessionOf = (psid: string) => hashOf(sessionKeys.session(psid));
const attemptRefs = async (id: string) =>
  (await q<{ pg_payment_key: string | null; pg_tx_id: string | null; pg_payment_token: string | null }>('select pg_payment_key, pg_tx_id, pg_payment_token from payment_attempt where id = $1', [id]))[0];
/** 보류 시험의 시간 한도(보류 오류가 일시 실패로 읽히면 파티션이 끝없이 다시 해 멈추므로, 멈추지 않고 실패하게) */
const HELD_TEST_TIMEOUT_MS = 20_000;

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ───────────────────────────── 승인 ─────────────────────────────

describe('APPROVED 사건 → 주문 APPROVED', () => {
  test('PT12_결제 접수 → Saga(승인 명령 대역) → APPROVED 사건 → 주문 APPROVED·판매 행 SOLD·ticket_issue_job(발권 기한 = 승인 + 30분)·구매 세션 끝남(COMPLETED)이고, 좌석 Redis의 묶인 홀드는 그대로·보류 없음 [ASVS v5.0.0-2.3.1]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    expect(await sessionOf(p.psid)).toMatchObject({ pay: '1' });
    clock.advance(2_000);
    const approvedAt = clock.now();
    const k = await partitionOf(a);

    await k.p.push(messageOf(paymentEvent(p, { occurredAt: iso(approvedAt), eventSeq: 1 }), w.eventId));
    await k.p.drain();

    expect(k.errors).toEqual([]);
    expect(await heldOf(p.o.id)).toEqual([]);
    expect(await orderRow(p.o.id)).toEqual({ status: 'APPROVED', failure_reason: null, payment_event_seq: '1' });
    expect(await historyCauses(p.o.id)).toEqual(['T1', 'T3', 'T4', 'T7', 'T9']);
    expect(await outboxTypes(w.eventId, p.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'APPROVED']);
    expect(await salesOf(w.eventId)).toEqual(p.hold.seats.map((s) => ({ seat_id: s.seatId, order_id: p.o.id, status: 'SOLD' })));
    expect(await quotaOf(p.o.accountId, w.eventId)).toBe(2);
    expect(await issueJobOf(p.o.id)).toEqual({ event_id: w.eventId, attempts: 0, issue_due_at: new Date(approvedAt + ISSUE_WINDOW_MS) });
    expect(await jobOf(p.o.id)).toBeUndefined();
    // 결제에 성공하면 구매 세션을 비운다(P-T12)
    expect(await sessionOf(p.psid)).toBeNull();
    // 판매 좌석은 판매 종료 + 1일까지 묶음으로 남는다
    for (const s of p.hold.seats) {
      expect(await bit(w.eventId, s.index)).toBe(1);
      expect(await hashOf(seatKeys.hold(w.eventId, s.index))).toMatchObject({ holdId: p.hold.holdId, pin: '1' });
    }
    expect(await failedMark(w.eventId, p.hold.holdId)).toBeNull();
    expect(a.confirms.calls).toHaveLength(1);
    expect(k.sleeps).toEqual([]);
    expect(k.p.committable()).toBe(offset + 1n);
  });
});

describe('AWAITING_DEPOSIT 사건 → 주문 AWAITING_DEPOSIT(리뷰 M1)', () => {
  // PRF-171(추천 적용 2026-11-06, payment §2 '중간 결과 뒤에도 당긴다'): 입금 대기 반영은 작업 행을 지우지 않고 AWAIT로 남겨 pull_next_at = 지금 + 60초 [가정]으로 둔다.
  // AWAIT 행은 Saga 잡기가 고르지 않으므로 승인 명령을 다시 보내지 않는다
  test('M1_Saga가 승인 명령 RETRYABLE로 다시 하기를 기다리는 사이(작업 CONFIRM·결제 참조 남음) AWAITING_DEPOSIT이 오면 T10 뒤 결제 참조가 비고 작업 행이 AWAIT(다음 당기기 점검 60초 뒤)로 바뀌어 승인 명령을 다시 보내지 않는다. 판매 행은 PENDING, 구매 세션은 끝난다 [ASVS v5.0.0-14.2.4]', async () => {
    const a = assemble({ confirm: () => ({ status: 'RETRYABLE', reason: 'unavailable' }) });
    const w = await world();
    const p = await placeAndAccept(a, w);
    expect(await a.runner.runOne(p.o.id)).toMatchObject({ kind: 'RETRY', reason: 'confirm_retryable' });
    expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'CONFIRM', attempts: 1 });
    expect(await attemptRefs(p.attemptId)).toMatchObject({ pg_payment_key: (p.refs as { paymentKey: string }).paymentKey });
    const k = await partitionOf(a);

    await k.p.push(messageOf(paymentEvent(p, { type: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', eventSeq: 1 }), w.eventId));
    await k.p.drain();

    expect(k.errors).toEqual([]);
    expect(await heldOf(p.o.id)).toEqual([]);
    expect(await orderRow(p.o.id)).toEqual({ status: 'AWAITING_DEPOSIT', failure_reason: null, payment_event_seq: '1' });
    expect(await attemptRefs(p.attemptId)).toEqual({ pg_payment_key: null, pg_tx_id: null, pg_payment_token: null });
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'AWAIT' });
    expect((await q<{ pull_next_at: Date | null }>('select pull_next_at from order_saga_job where order_id = $1', [p.o.id]))[0]?.pull_next_at).toEqual(new Date(clock.now() + 60_000));
    expect((await salesOf(w.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    expect(await sessionOf(p.psid)).toBeNull();
    // 다시 하기 기한이 지나도 Saga가 집지 않는다(승인 명령 1번 그대로. 집지 못한 까닭은 정본에 없어 SKIPPED만 본다)
    clock.advance(30_000);
    expect((await a.runner.runOne(p.o.id)).kind).toBe('SKIPPED');
    expect(a.confirms.calls).toHaveLength(1);
  });
});

// ───────────────────────────── 실패(P-T2) ─────────────────────────────

describe('FAILED 사건 → 주문 FAILED(P-T2)', () => {
  test('PT2_FAILED(CARD_DECLINED) → 주문 FAILED·failure_reason·PENDING 지움·한도 되돌림 → kick 뒤 Saga RELEASE가 좌석 Redis를 풀고(비트 0)·실패 표시를 남기고 작업 행을 지운다. Paying이 풀리고(세션은 남는다) 승인 명령은 더 없으며 ticket_issue_job이 없다(과금 0) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);

    await k.p.push(messageOf(paymentEvent(p, { type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' }), w.eventId));
    await k.p.drain();

    expect(k.errors).toEqual([]);
    expect(await heldOf(p.o.id)).toEqual([]);
    expect(await orderRow(p.o.id)).toEqual({ status: 'FAILED', failure_reason: 'CARD_DECLINED', payment_event_seq: '1' });
    expect(await outboxTypes(w.eventId, p.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'FAILED']);
    expect(await salesOf(w.eventId)).toEqual([]);
    expect(await quotaOf(p.o.accountId, w.eventId)).toBe(0);
    expect(await issueJobOf(p.o.id)).toBeUndefined();
    // 커밋 뒤 깨운 실행기가 RELEASE 작업을 돌아 지운다
    expect(await waitFor(async () => (await jobOf(p.o.id)) === undefined, 10_000)).toBe(true);
    await a.runner.stop();
    for (const s of p.hold.seats) {
      expect(await bit(w.eventId, s.index), `좌석 ${s.index}`).toBe(0);
      expect(await hashOf(seatKeys.hold(w.eventId, s.index))).toBeNull();
    }
    expect(await failedMark(w.eventId, p.hold.holdId)).toBe('1');
    const session = await sessionOf(p.psid);
    expect(session).not.toBeNull();
    expect(session).not.toHaveProperty('pay');
    expect(a.confirms.calls).toHaveLength(1);
    expect(a.sagaLog.lines).toEqual([]);
  });

  test('PT2_실패 뒤 늦은 묶기(같은 holdId)는 FAILED_HOLD라 풀린 좌석을 다시 잡지 않는다 [ASVS v5.0.0-15.4.2]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);
    await k.p.push(messageOf(paymentEvent(p, { type: 'FAILED', failureCategory: 'USER_ABORTED' }), w.eventId));
    await k.p.drain();
    expect(await waitFor(async () => (await jobOf(p.o.id)) === undefined, 10_000)).toBe(true);
    await a.runner.stop();
    const pins = new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap });
    expect(
      await pins.pin({
        eventId: w.eventId,
        accountId: p.o.accountId,
        holdId: p.hold.holdId,
        purchaseSessionId: p.psid,
        seatIds: p.hold.seats.map((s) => s.seatId),
        limit: LIMIT,
        orderGen: 1,
        keepUntilMs: w.keepUntilMs,
      }),
    ).toEqual({ status: 'FAILED_HOLD' });
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'USER_ABORTED' });
  });
});

// ───────────────────────────── 멱등(P-T15) ─────────────────────────────

describe('다시 온 사건(P-T15)', () => {
  test('PT15_같은 eventKey의 APPROVED가 두 번(다른 오프셋) 와도 한 번만 반영한다: 이력 T9·Outbox APPROVED·ticket_issue_job이 하나씩, 보류 없음 [ASVS v5.0.0-15.4.1]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);
    const value = paymentEvent(p, { eventSeq: 4 });

    await k.p.push(messageOf(value, w.eventId));
    await k.p.push(messageOf(value, w.eventId));
    await k.p.drain();

    expect(k.errors).toEqual([]);
    expect(await heldOf(p.o.id)).toEqual([]);
    expect(await historyCauses(p.o.id)).toEqual(['T1', 'T3', 'T4', 'T7', 'T9']);
    expect((await outboxTypes(w.eventId, p.o.id)).filter((t) => t === 'APPROVED')).toHaveLength(1);
    expect(await q('select order_id from ticket_issue_job where order_id = $1', [p.o.id])).toHaveLength(1);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '4' });
    expect(a.resultLog.lines).toEqual([]);
    expect(k.p.committable()).toBe(offset + 1n);
  });

  test('PT15_당기기로 순번 2를 반영한 뒤 늦게 온 앞 순번(1, UNKNOWN) 사건은 건너뛴다(주문 APPROVED·순번 2 그대로) [ASVS v5.0.0-15.4.1]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);

    await k.p.push(messageOf(paymentEvent(p, { eventSeq: 2 }), w.eventId));
    await k.p.push(messageOf(paymentEvent(p, { type: 'UNKNOWN', result: 'UNKNOWN', eventSeq: 1 }), w.eventId));
    await k.p.drain();

    expect(await heldOf(p.o.id)).toEqual([]);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '2' });
    expect(await historyCauses(p.o.id)).toEqual(['T1', 'T3', 'T4', 'T7', 'T9']);
  });
});

// ───────────────────────────── 보류(held_event) ─────────────────────────────

describe('있을 수 없는 조합·대조 실패 → 5회 [가정] 뒤 held_event 보류(같은 주문의 뒤 사건도 보류)', () => {
  test('M2_FAILED(EXPIRED) 주문에 APPROVED(과금됐는데 주문이 실패)는 CHARGED_ON_CLOSED_ORDER로 5회 해 본 뒤 주문 ID 키로 보류되고, 같은 주문의 뒤 사건도 보류되며, 같은 파티션 다른 주문의 사건은 막히지 않는다. 쓰임새 보류 로그는 한 줄(SEV1, 리뷰 L5) [ASVS v5.0.0-16.3.3]', async () => {
    const a = assemble();
    const w = await world();
    const failed = await placeAndAccept(a, w, { seats: [w.refs[0]!, w.refs[1]!] });
    clock.advance(10 * MIN);
    expect(await a.runner.runOne(failed.o.id)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'EXPIRED' });
    const ok = await reservedBySaga(a, w, { seats: [w.refs[6]!, w.refs[7]!] });
    const k = await partitionOf(a);
    const impossible = paymentEvent(failed, { eventSeq: 1 });
    const later = paymentEvent(failed, { type: 'UNKNOWN', result: 'UNKNOWN', eventSeq: 2 });

    await k.p.push(messageOf(impossible, w.eventId));
    await k.p.push(messageOf(later, w.eventId));
    await k.p.push(messageOf(paymentEvent(ok, { eventSeq: 1 }), w.eventId));
    await k.p.drain();

    const held = await heldOf(failed.o.id);
    expect(held.map((h) => [h.business_key, h.event_key, h.msg_key])).toEqual([
      [failed.o.id, impossible.eventKey, w.eventId],
      [failed.o.id, later.eventKey, w.eventId],
    ]);
    expect(held[0]!.error).toContain('PaymentResultHeld');
    expect(held[0]!.error).toContain('CHARGED_ON_CLOSED_ORDER');
    expect(held[0]!.error).not.toContain(String(failed.o.amount));
    // 같은 결과일 실패 사이 쉬기(0.2·0.4·0.8·1.6초 [가정])를 거친 뒤 보류했다(5회)
    expect(k.sleeps).toEqual(Array.from({ length: KEYED_CONSUMER_DEFAULTS.attempts - 1 }, (_, i) => KEYED_CONSUMER_DEFAULTS.retryBaseMs * 2 ** i));
    // 5회 해 보는 동안 쓰임새 보류 로그는 한 줄이다(SEV1·payment-charged-closed, 주문 ID·사건 종류·결제사만, 리뷰 M2·L5)
    expect(a.resultLog.lines.filter((l) => l.kind === 'held')).toEqual([
      { kind: 'held', e: { orderId: failed.o.id, type: 'APPROVED', pg: 'TOSS', reason: 'CHARGED_ON_CLOSED_ORDER', severity: 'SEV1', kind: 'payment-charged-closed' } },
    ]);
    expect(await orderRow(failed.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'EXPIRED', payment_event_seq: '0' });
    expect(await issueJobOf(failed.o.id)).toBeUndefined();
    // 다른 주문은 반영됐다
    expect(await orderRow(ok.o.id)).toMatchObject({ status: 'APPROVED' });
    expect(await heldOf(ok.o.id)).toEqual([]);
    expect(k.p.committable()).toBe(offset + 1n);
  }, HELD_TEST_TIMEOUT_MS);

  test('M3_승인된 주문에 CANCELED(취소 단계가 아직 없음)는 건너뛰지 않고 NOT_YET_SUPPORTED로 보류 표에 남는다(그 사건을 잃지 않는다). 주문은 APPROVED 그대로 [ASVS v5.0.0-16.3.3]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);
    const canceled = paymentEvent(p, { type: 'CANCELED', result: undefined, eventSeq: 2 });

    await k.p.push(messageOf(paymentEvent(p, { eventSeq: 1 }), w.eventId));
    await k.p.push(messageOf(canceled, w.eventId));
    await k.p.drain();

    const held = await heldOf(p.o.id);
    expect(held.map((h) => [h.business_key, h.event_key, h.msg_key])).toEqual([[p.o.id, canceled.eventKey, w.eventId]]);
    expect(held[0]!.error).toContain('NOT_YET_SUPPORTED');
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'APPROVED', payment_event_seq: '1' });
    expect(a.resultLog.lines.filter((l) => l.kind === 'held')).toEqual([
      { kind: 'held', e: { orderId: p.o.id, type: 'CANCELED', pg: 'TOSS', reason: 'NOT_YET_SUPPORTED', severity: 'SEV2' } },
    ]);
    expect(k.p.committable()).toBe(offset + 1n);
  }, HELD_TEST_TIMEOUT_MS);

  test('금액이 주문 금액과 1원 다른 APPROVED는 AMOUNT_MISMATCH로 보류되고 주문 RESERVED·판매 행 PENDING이 그대로다 [ASVS v5.0.0-16.3.3]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);
    const e = paymentEvent(p, { amount: p.o.amount + 1 });

    await k.p.push(messageOf(e, w.eventId));
    await k.p.drain();

    const held = await heldOf(p.o.id);
    expect(held.map((h) => h.event_key)).toEqual([e.eventKey]);
    expect(held[0]!.error).toContain('AMOUNT_MISMATCH');
    expect(held[0]!.error).not.toContain(String(p.o.amount + 1));
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'RESERVED', payment_event_seq: '0' });
    expect((await salesOf(w.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
    expect(await sessionOf(p.psid)).toMatchObject({ pay: '1' });
    // 금액 대조 실패는 보안 이벤트 표시가 붙은 보류 로그 한 줄이다(리뷰 L6·L5)
    expect(a.resultLog.lines.filter((l) => l.kind === 'held')).toEqual([
      { kind: 'held', e: { orderId: p.o.id, type: 'APPROVED', pg: 'TOSS', reason: 'AMOUNT_MISMATCH', severity: 'SEV2', kind: 'security' } },
    ]);
  }, HELD_TEST_TIMEOUT_MS);

  test('모양이 틀린 사건(amount 빠짐)은 읽은 주문 ID 키로 보류되고(eventKey 없음), 같은 주문의 바른 뒤 사건도 보류된다 [ASVS v5.0.0-2.2.1]', async () => {
    const a = assemble();
    const w = await world();
    const p = await reservedBySaga(a, w);
    const k = await partitionOf(a);
    const { amount: _drop, ...bad } = paymentEvent(p);
    const good = paymentEvent(p, { eventSeq: 2 });

    await k.p.push(messageOf(bad, w.eventId));
    await k.p.push(messageOf(good, w.eventId));
    await k.p.drain();

    const held = await heldOf(p.o.id);
    expect(held.map((h) => [h.business_key, h.event_key])).toEqual([
      [p.o.id, null],
      [p.o.id, good.eventKey],
    ]);
    expect(held[0]!.error).toContain('RangeError');
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'RESERVED' });
  }, HELD_TEST_TIMEOUT_MS);
});
