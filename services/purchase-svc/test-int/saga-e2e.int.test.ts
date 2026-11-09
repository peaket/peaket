// 주문 Saga 1단계를 처음부터 끝까지 돈다: 실제 PostgreSQL 18·실제 Valkey 8.1, 승인 명령만 대역(BUILD_ORDER PRF-165).
// 홀드(홀드 Lua) → 주문 생성(DrizzleOrderStore.createOrder) → 결제 시도 READY 직접 넣기 → 결제 접수(DrizzleOrderAccepts.accept, 판 번호는 회차 슬롯 읽기)
// → 실행기(OrderSagaRunner.runOne·kick: 묶기 Lua → 판매 예약 트랜잭션 → 승인 명령 대역 → 결제 참조 지우기·작업 행 AWAIT).
// 승인 명령이 접수되면 작업 행을 지우지 않고 AWAIT로 남긴다(결과 당기기가 찾는다, payment §2 단계 CONFIRM, 추천 적용 2026-11-06, BUILD_ORDER PRF-171).
// 정본: docs/features/payment.md §2 'Saga 1단계의 첫 구현'(실행기·RESERVE ①~③·CONFIRM·실패 해제와 늦은 묶기·좌석 묶기 입력의 구매 세션 ID·실패 사유)·
// '결제 접수의 첫 구현'(결제 참조의 자리), 시험 표 P-T10(홀드 만료 후 결제 접수)·seat-hold.md S-T7, docs/data.md §5 'Saga 1단계'·§3 실패 표시 키.
//
// 약속:
// - 조립은 main.ts 머리 주석의 차례와 같다: DrizzleSaga({ database, store, sales: DrizzleSeatSales, clock }), InventoryOrderSeatPins({ pins: RedisSeatStore, seatMap }),
//   SeatMapSagaConfigs(seatMap), 승인 명령은 시험의 기록 대역(늘 ACCEPTED, 또는 시험이 고른 답), Saga 로그는 기록 대역, 반복 타이머는 손으로 부르는 대역.
//   HTTP 경로(POST /v1/orders·payment-acceptance)와 onAccepted 조립은 accept-e2e.int.test.ts·orders-e2e.int.test.ts가 이미 보므로 여기서는 포트 차례로 부른다.
// - 앱 시계는 Valkey 시계에 맞춘 가짜 시계다(홀드·묶기 Lua가 Redis TIME을 쓴다). 홀드 만료는 홀드 Hash exp·만료 인덱스 점수를 지난 시각으로 고친 뒤 만료 Lua로 푼다.
//   승인 기한은 앱 시계(authenticated_at = 접수 시각)로 넘긴다(가짜 시계를 앞으로).
// - 회차·계정·좌석 ID는 시험마다 새 UUID다(좌석맵 판은 MemorySeatMap).
//
// 정본 모호:
// - runOne의 결과는 마지막 단계의 결과다(RESERVE가 ADVANCED면 같은 실행에서 CONFIRM을 이어 돌아 DONE, order-saga.ts runJob 설명).
// - 승인 명령 데드라인은 min(200ms, 기한까지 남은 시간)이라 1 이상 200 이하로만 본다.
// - 다시 하기 첫 간격은 1초(sagaRetryDelayMs(1), payment §2 '1초에서 두 배씩')로 본다.
// - 승인 기한의 경계(인증 + 10분 정각)는 넘긴 것으로 본다(saga.ts isPastConfirmDeadline).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, requestFingerprint, uuidv7 } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import {
  type ConfirmCommand,
  type ConfirmOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzleRebuildOrders,
  DrizzleSaga,
  InventoryOrderSeatPins,
  InventorySeatSlots,
  type NewOrder,
  OrderSagaRunner,
  type OrderSeatPins,
  OrderSeatStoreUnavailable,
  type PaymentConfirms,
  type PaymentRefs,
  type SagaLog,
  type SagaOrders,
  SeatMapSagaConfigs,
} from '../src/modules/booking/index.js';
import {
  DrizzleSeatRebuildSource,
  DrizzleSeatSales,
  EXPIRY_BATCH_SIZE,
  type EventSeatConfig,
  type HoldInput,
  KEEP_AFTER_SALE_END_MS,
  MemorySeatMap,
  RedisSeatSlots,
  RedisSeatStore,
  SeatRebuilder,
  type SeatRef,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { fingerprintOf } from '../test/hold-cases.js';
import { accountActor, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const MIN = 60_000;
const PRICES = { R: 99_000, S: 132_000 } as const;
const SEAT_COUNT = 10;
const LIMIT = 4;

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
  // 앱 시계를 Valkey 시계에 맞춘다(accept-e2e.int.test.ts와 같은 방식)
  const samples: number[] = [];
  for (let k = 0; k < 5; k += 1) {
    const before = Date.now();
    const t = (await redis.command(['TIME'], {})) as unknown[];
    samples.push(Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) - Math.round((before + Date.now()) / 2));
  }
  clock = fakeClock({ now: Date.now() + samples.sort((a, b) => a - b)[2]! });
  await migratePurchase(pgServer!.url);
  // 홀드 원장(seat_hold) 월 파티션(PRF-167 시험이 원장 HELD 행을 넣는다)
  await ensureSeatHoldPartitions(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 10, applicationName: 'saga-e2e' });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'saga-e2e-admin' });
  await ensureOutboxPartitions(admin, clock);
});

afterAll(async () => {
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  pgServer?.stop();
});

// ───────────────────────────── 조립 ─────────────────────────────

/**
 * 승인 명령 기록 대역. answers가 비면 늘 { ACCEPTED, IN_PROGRESS }. 어댑터처럼 차단기가 들여보낼 때(답이 circuit_open이 아닐 때)만 보내기 바로 전에
 * beforeSend(작업 행 confirm_sent_at 적기, 리뷰 H1)를 부르고 보낸 것으로 센다(calls)
 */
function recordingConfirms(answers: ConfirmOutcome[] = []): PaymentConfirms & { calls: ConfirmCommand[] } {
  const calls: ConfirmCommand[] = [];
  return {
    calls,
    confirm: async (c, o) => {
      const answer = answers.shift() ?? { status: 'ACCEPTED', result: 'IN_PROGRESS' };
      if (answer.status === 'RETRYABLE' && answer.reason === 'circuit_open') return answer;
      await o?.beforeSend?.();
      calls.push(c);
      return answer;
    },
  };
}
function recordingLog(): SagaLog & { lines: { kind: string; e: unknown }[] } {
  const lines: { kind: string; e: unknown }[] = [];
  return {
    lines,
    releaseFailed: (e) => void lines.push({ kind: 'releaseFailed', e }),
    confirmRejected: (e) => void lines.push({ kind: 'confirmRejected', e }),
    stepError: (e) => void lines.push({ kind: 'stepError', e: { orderId: e.orderId, step: e.step, err: String(e.err) } }),
  };
}
const manualTimer = { setInterval: () => 1, clearInterval: () => {} };

/** afterPinned: 실행기가 주문 pinned_at을 적은(recordPinned가 true) 바로 뒤에 부른다(PRF-167, 묶은 뒤 판매 예약 전의 틈) */
function assemble(confirms = recordingConfirms(), o: { pins?: OrderSeatPins; afterPinned?: (orderId: string) => Promise<void> } = {}) {
  const store = new DrizzleOrderStore({ clock });
  const saga = new DrizzleSaga({ database, store, sales: new DrizzleSeatSales(database), clock });
  const log = recordingLog();
  const afterPinned = o.afterPinned;
  const orders: SagaOrders =
    afterPinned === undefined
      ? saga
      : {
          read: (id) => saga.read(id),
          recordPinned: async (id, from, to) => {
            const ok = await saga.recordPinned(id, from, to);
            if (ok) await afterPinned(id);
            return ok;
          },
        };
  const runner = new OrderSagaRunner({
    jobs: saga,
    orders,
    reserve: saga,
    failures: saga,
    confirmSent: saga,
    pins: o.pins ?? new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap }),
    confirms,
    configs: new SeatMapSagaConfigs(seatMap),
    log,
    clock,
    timer: manualTimer,
  });
  return { store, saga, runner, confirms, log, accepts: new DrizzleOrderAccepts({ database, store, clock }) };
}

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];

interface World {
  eventId: string;
  refs: SeatRef[];
  keepUntilMs: number;
}
/**
 * 회차 하나: 좌석맵 판(구역 A 등급 R 6석, 구역 B 등급 S 4석, 1인 한도 4)과 좌석 Redis 판매 열기(세대 키 gen 1).
 * 홀드 원장(seat_hold, 회차 ID UUIDv7 범위 월 파티션)에 행을 넣는 시험은 eventId로 uuidv7을 준다(PRF-167)
 */
async function world(o: { eventId?: string } = {}): Promise<World> {
  const eventId = o.eventId ?? randomUUID();
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
  /** 접수(인증) 시각 */
  at: number;
}

/** 홀드 Lua로 좌석을 잡는다 */
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

/** 홀드 → 주문(T1) → READY 시도 → 결제 접수(판 번호는 회차 슬롯 읽기). 접수 뒤 작업 행 RESERVE */
async function placeAndAccept(a: ReturnType<typeof assemble>, w: World, x: { seats?: SeatRef[]; psid?: string; refs?: PaymentRefs; accountId?: string } = {}): Promise<Placed> {
  const accountId = x.accountId ?? randomUUID();
  const psid = x.psid ?? randomUUID();
  const seats = x.seats ?? [w.refs[0]!, w.refs[1]!];
  const hold = await holdSeats(w, accountId, seats, psid);
  const items = hold.seats.map((s) => ({ seatId: s.seatId, tierId: s.tierId, sectionId: s.sectionId, unitPrice: PRICES[s.tierId as 'R' | 'S'] }));
  const o = newOrderInput(clock, { eventId: w.eventId, accountId, holdId: hold.holdId, purchaseSessionId: psid, items });
  await database.transaction((tx) => a.store.createOrder(tx, o));
  const refs = x.refs ?? { pg: 'TOSS', paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` };
  const attemptId = uuidv7(clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [
    attemptId,
    o.id,
    refs.pg,
    refs.pg === 'PORTONE' ? `pay-${o.id}` : o.id,
    'READY',
    new Date(clock.now()),
  ]);
  const slot = await new InventorySeatSlots(new RedisSeatSlots(redis)).read(w.eventId);
  expect(slot.status).toBe('OK');
  const seatGen = slot.status === 'OK' ? slot.gen : 1;
  clock.advance(1_000);
  const at = clock.now();
  const once = {
    accountRef: accountId,
    operation: 'ACCEPT_PAYMENT',
    key: randomUUID(),
    requestHash: requestFingerprint('POST', `/v1/orders/${o.id}/payment-acceptance`, Buffer.from(JSON.stringify({ n: randomUUID() }), 'utf8')),
  };
  expect(await a.accepts.accept(once, { orderId: o.id, attemptId, eventId: w.eventId, refs, seatGen, actor: accountActor(accountId) })).toEqual({ status: 'ACCEPTED' });
  return { w, o, hold, attemptId, refs, at };
}

const orderRow = async (id: string) =>
  (await q<{ status: string; failure_reason: string | null; seat_gen: number | null }>('select status, failure_reason, seat_gen from purchase_order where id = $1', [id]))[0];
const attemptRefs = async (id: string) =>
  (await q<{ pg_payment_key: string | null; pg_tx_id: string | null; pg_payment_token: string | null }>('select pg_payment_key, pg_tx_id, pg_payment_token from payment_attempt where id = $1', [id]))[0];
const jobOf = async (orderId: string) => (await q<{ step: string; attempts: number; next_attempt_at: Date }>('select step, attempts, next_attempt_at from order_saga_job where order_id = $1', [orderId]))[0];
const salesOf = (eventId: string) => q<{ seat_id: string; order_id: string; status: string }>('select seat_id, order_id, status from seat_sale where event_id = $1 order by seat_id', [eventId]);
const quotaOf = async (accountId: string, eventId: string) => (await q<{ used: number }>('select used from purchase_quota where account_id = $1 and event_id = $2', [accountId, eventId]))[0]?.used;
const outboxTypes = async (eventId: string, orderId: string) =>
  (await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]))
    .map((r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string; orderId: string })
    .filter((e) => e.orderId === orderId)
    .map((e) => e.type);
const NO_REFS = { pg_payment_key: null, pg_tx_id: null, pg_payment_token: null };

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const bit = async (e: string, i: number) => Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(i)]));
async function holdHash(e: string, i: number): Promise<Record<string, string> | null> {
  const v = await cmd(seatKeys.hold(e, i), ['HGETALL', seatKeys.hold(e, i)]);
  let o: Record<string, string> = {};
  if (v instanceof Map) o = Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  else if (Array.isArray(v)) for (let k = 0; k + 1 < v.length; k += 2) o[String(v[k])] = String(v[k + 1]);
  else if (v && typeof v === 'object') o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return Object.keys(o).length ? o : null;
}
const inExpiry = async (e: string, i: number) => (await cmd(seatKeys.expiry(e), ['ZSCORE', seatKeys.expiry(e), String(i)])) !== null;
const failedMark = async (e: string, holdId: string) => {
  const k = `s:{event:${e}}:failed:${holdId}`;
  const v = await cmd(k, ['GET', k]);
  return v === null || v === undefined ? null : String(v);
};

/** 홀드 시간이 다 된 것으로 만들고(Hash exp·만료 인덱스 점수를 1분 전으로) 만료 Lua로 푼다. 푼 좌석 수 */
async function expireHold(p: Placed): Promise<number> {
  const store = new RedisSeatStore(redis);
  const past = clock.now() - MIN;
  for (const s of p.hold.seats) {
    await cmd(seatKeys.hold(p.w.eventId, s.index), ['HSET', seatKeys.hold(p.w.eventId, s.index), 'exp', String(past)]);
    await cmd(seatKeys.expiry(p.w.eventId), ['ZADD', seatKeys.expiry(p.w.eventId), String(past), String(s.index)]);
  }
  const due = await store.dueExpiries({ eventId: p.w.eventId, nowMs: clock.now(), limit: EXPIRY_BATCH_SIZE });
  const seats = due.map((d) => {
    const seat = p.w.refs.find((r) => r.index === d.index);
    return seat && d.hold ? { index: d.index, expected: d.hold, seat } : { index: d.index, expected: d.hold };
  });
  const r = await store.expire({ eventId: p.w.eventId, keepUntilMs: p.w.keepUntilMs, seats });
  expect(r.kind).toBe('OK');
  return r.kind === 'OK' ? r.released : 0;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ───────────────────────────── 행복 길 ─────────────────────────────

describe('Saga 1단계 행복 길(묶기 → 판매 예약 → 승인 명령 → 결제 참조 지우기·작업 행 AWAIT)', () => {
  test('토스: runOne이 DONE이고 주문 RESERVED·판매 행 PENDING·좌석 묶음(만료 인덱스 밖), 승인 명령 한 번(결제 키·서버 금액), 결제 참조 비움·작업 행 AWAIT(PRF-171) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-14.2.4]', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });

    expect(await orderRow(p.o.id)).toEqual({ status: 'RESERVED', failure_reason: null, seat_gen: 1 });
    expect(await outboxTypes(w.eventId, p.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED']);
    expect(await salesOf(w.eventId)).toEqual(p.hold.seats.map((s) => ({ seat_id: s.seatId, order_id: p.o.id, status: 'PENDING' })));
    expect(await quotaOf(p.o.accountId, w.eventId)).toBe(2);
    for (const s of p.hold.seats) {
      expect(await bit(w.eventId, s.index)).toBe(1);
      expect(await holdHash(w.eventId, s.index)).toMatchObject({ holdId: p.hold.holdId, owner: p.o.accountId, pin: '1' });
      expect(await inExpiry(w.eventId, s.index)).toBe(false);
    }
    expect(a.confirms.calls).toHaveLength(1);
    const c = a.confirms.calls[0]!;
    expect(c).toMatchObject({ orderId: p.o.id, attemptId: p.attemptId, pg: 'TOSS', refs: p.refs, amount: p.o.amount });
    expect(c.deadlineMs).toBeGreaterThanOrEqual(1);
    expect(c.deadlineMs).toBeLessThanOrEqual(200);
    expect(await attemptRefs(p.attemptId)).toEqual(NO_REFS);
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'AWAIT' });
    expect(a.log.lines).toEqual([]);
    // 끝난 작업을 다시 부르면 집지 않는다(AWAIT 행은 Saga 잡기가 고르지 않는다. 집지 못한 까닭은 정본에 없어 SKIPPED만 본다)
    expect((await a.runner.runOne(p.o.id)).kind).toBe('SKIPPED');
    expect(a.confirms.calls).toHaveLength(1);
  });

  test('포트원: 승인 명령의 결제 참조는 payment_id = pay-{주문 ID}·tx_id·payment_token이고, 끝나면 거래 ID·토큰을 비운다 [ASVS v5.0.0-14.2.4]', async () => {
    const a = assemble();
    const w = await world();
    const refs: PaymentRefs = { pg: 'PORTONE', txId: `tx-${randomUUID()}`, paymentToken: `ptok_${randomUUID().replaceAll('-', '')}` };
    const p = await placeAndAccept(a, w, { refs });
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });
    expect(a.confirms.calls[0]).toMatchObject({ pg: 'PORTONE', refs: { pg: 'PORTONE', paymentId: `pay-${p.o.id}`, txId: refs.txId, paymentToken: refs.paymentToken } });
    expect(await attemptRefs(p.attemptId)).toEqual(NO_REFS);
  });

  test('kick: 접수 직후 깨우면 기다리지 않고 비동기로 한 번 돌아 작업 행이 AWAIT가 되고 RESERVED다. stop은 돌던 kick을 기다린다', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);
    expect(() => a.runner.kick(p.o.id)).not.toThrow();
    expect(await waitFor(async () => (await jobOf(p.o.id))?.step === 'AWAIT', 10_000)).toBe(true);
    await a.runner.stop();
    expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
    expect(a.confirms.calls.map((c) => c.orderId)).toEqual([p.o.id]);
  });

  test('pollOnce: 기한이 된 작업을 집어 돈다(돈 수를 돌려준다)', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);
    expect(await a.runner.pollOnce()).toBeGreaterThanOrEqual(1);
    expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'AWAIT' });
  });

  test('구매 세션 ID가 UUID가 아닌 입장 토큰 jti 모양이어도 묶기·판매 예약·승인까지 간다(payment §2 좌석 묶기 입력의 구매 세션 ID)', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w, { psid: `jti_${randomUUID().replaceAll('-', '').slice(0, 24)}` });
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });
    expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
  });
});

// ───────────────────────────── 홀드 만료 뒤(P-T10·S-T7) ─────────────────────────────

describe('홀드 만료 뒤 Saga(P-T10, S-T7)', () => {
  test('PT10_ST7_첫 갈래: 홀드 시간이 다 돼 좌석이 풀렸어도 비어 있으면 묶기가 같은 holdId로 다시 잡아 RESERVED까지 가고 승인 명령을 보낸다 [ASVS v5.0.0-2.3.4]', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);
    expect(await expireHold(p)).toBe(2);
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });

    for (const s of p.hold.seats) {
      expect(await bit(w.eventId, s.index)).toBe(1);
      expect(await holdHash(w.eventId, s.index)).toMatchObject({ holdId: p.hold.holdId, owner: p.o.accountId, psid: p.o.purchaseSessionId, pin: '1' });
    }
    expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
    expect((await salesOf(w.eventId)).map((x) => x.order_id)).toEqual([p.o.id, p.o.id]);
    expect(a.confirms.calls).toHaveLength(1);
  });

  test('PT10_ST7_둘째 갈래: 홀드 만료 뒤 다른 계정이 그 좌석을 잡았으면 T8 FAILED(SEAT_TAKEN)이고 승인 명령이 없으며(과금 없음) 남의 홀드는 그대로, 실패 표시가 남는다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.1]', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);
    expect(await expireHold(p)).toBe(2);
    const rivalSeat = p.hold.seats[0]!;
    const rival = await holdSeats(w, randomUUID(), [rivalSeat], randomUUID());

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'SEAT_TAKEN' });

    expect(a.confirms.calls).toEqual([]);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'SEAT_TAKEN' });
    expect(await outboxTypes(w.eventId, p.o.id)).toEqual(['CREATED', 'ACCEPTED', 'FAILED']);
    expect(await salesOf(w.eventId)).toEqual([]);
    expect(await jobOf(p.o.id)).toBeUndefined();
    expect(await attemptRefs(p.attemptId)).toEqual(NO_REFS);
    expect(await holdHash(w.eventId, rivalSeat.index)).toMatchObject({ holdId: rival.holdId, owner: rival.accountId });
    expect(await bit(w.eventId, p.hold.seats[1]!.index)).toBe(0);
    expect(await failedMark(w.eventId, p.hold.holdId)).toBe('1');
  });

  test('늦은 묶기: 실패로 끝난 주문의 묶기를 다시 불러도(같은 holdId) FAILED_HOLD라 풀린 좌석을 다시 잡지 않는다 [ASVS v5.0.0-15.4.2]', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);
    expect(await expireHold(p)).toBe(2);
    await holdSeats(w, randomUUID(), [p.hold.seats[0]!], randomUUID());
    expect((await a.runner.runOne(p.o.id)).kind).toBe('FAILED');
    const pins = new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap });
    expect(
      await pins.pin({
        eventId: w.eventId,
        accountId: p.o.accountId,
        holdId: p.hold.holdId,
        purchaseSessionId: p.o.purchaseSessionId,
        seatIds: [p.hold.seats[1]!.seatId],
        limit: LIMIT,
        orderGen: 1,
        keepUntilMs: w.keepUntilMs,
      }),
    ).toEqual({ status: 'FAILED_HOLD' });
    expect(await bit(w.eventId, p.hold.seats[1]!.index)).toBe(0);
  });
});

// ───────────────────────────── 승인 기한(인증 + 10분) ─────────────────────────────

describe('승인 기한 넘김(가짜 시계)', () => {
  test('RESERVE: 인증 + 10분을 넘겨 처음 돌면 묶지 않고 T8 FAILED(EXPIRED)와 실패 해제(홀드를 푼다), 승인 명령 없음 [ASVS v5.0.0-2.3.4]', async () => {
    const a = assemble();
    const w = await world();
    const p = await placeAndAccept(a, w);
    clock.advance(10 * MIN);

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'EXPIRED' });

    expect(a.confirms.calls).toEqual([]);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'EXPIRED' });
    expect(await salesOf(w.eventId)).toEqual([]);
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);
    expect(await failedMark(w.eventId, p.hold.holdId)).toBe('1');
    expect(await jobOf(p.o.id)).toBeUndefined();
    expect(await attemptRefs(p.attemptId)).toEqual(NO_REFS);
  });

  // 리뷰 고침 H1(2026-11-05): 승인 명령을 한 번이라도 보냈으면 purchase는 혼자 T11을 하지 않는다(결과를 모르는 명령이 payment-svc에 적혔을 수 있다).
  // 같은 주문 ID로 계속 다시 보내고 결과는 payment-svc가 정해 trade.payments로 온다(PRF-163)
  test('H1_CONFIRM: 대역이 매번 200ms를 넘겨 답하면(RETRYABLE deadline) 승인 기한을 넘긴 뒤에도 T11을 하지 않고 다시 보낸다: 주문 RESERVED·판매 행 PENDING·한도·좌석 묶음 그대로, 실패 표시 없음 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.1]', async () => {
    const a = assemble(recordingConfirms(Array.from({ length: 3 }, () => ({ status: 'RETRYABLE', reason: 'deadline' }) as const)));
    const w = await world();
    const p = await placeAndAccept(a, w);

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: clock.now() + 1_000 });
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'CONFIRM', attempts: 1 });
    expect((await q<{ confirm_sent_at: Date | null }>('select confirm_sent_at from order_saga_job where order_id = $1', [p.o.id]))[0]?.confirm_sent_at).not.toBeNull();

    clock.advance(10 * MIN);
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: clock.now() + 2_000 });

    expect(a.confirms.calls.map((c) => c.orderId)).toEqual([p.o.id, p.o.id]);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'RESERVED', failure_reason: null });
    expect(await outboxTypes(w.eventId, p.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED']);
    expect((await salesOf(w.eventId)).map((x) => [x.order_id, x.status])).toEqual([
      [p.o.id, 'PENDING'],
      [p.o.id, 'PENDING'],
    ]);
    expect(await quotaOf(p.o.accountId, w.eventId)).toBe(2);
    for (const s of p.hold.seats) {
      expect(await bit(w.eventId, s.index)).toBe(1);
      expect(await holdHash(w.eventId, s.index)).toMatchObject({ holdId: p.hold.holdId, pin: '1' });
    }
    expect(await failedMark(w.eventId, p.hold.holdId)).toBeNull();
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'CONFIRM', attempts: 2 });
    expect((await attemptRefs(p.attemptId))?.pg_payment_key).toBe((p.refs as { paymentKey: string }).paymentKey);
  });

  test('H1_CONFIRM: 차단기 열림만 계속돼 한 번도 보내지 않았으면(confirm_sent_at 비움) 승인 기한을 넘긴 다음 실행은 혼자 T11 FAILED(EXPIRED)·판매 행 PENDING 지우기·한도 되돌리기·실패 해제다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.1]', async () => {
    const a = assemble(recordingConfirms([{ status: 'RETRYABLE', reason: 'circuit_open' }]));
    const w = await world();
    const p = await placeAndAccept(a, w);

    const first = await a.runner.runOne(p.o.id);
    expect(first).toEqual({ kind: 'RETRY', reason: 'confirm_retryable', nextAtMs: clock.now() + 1_000 });
    expect((await orderRow(p.o.id))?.status).toBe('RESERVED');
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'CONFIRM', attempts: 1, next_attempt_at: new Date(clock.now() + 1_000) });
    expect(await quotaOf(p.o.accountId, w.eventId)).toBe(2);
    expect(a.confirms.calls).toHaveLength(0);

    clock.advance(10 * MIN);
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'FAILED', transition: 'T11', reason: 'EXPIRED' });

    expect(a.confirms.calls).toHaveLength(0);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'EXPIRED' });
    expect(await outboxTypes(w.eventId, p.o.id)).toEqual(['CREATED', 'ACCEPTED', 'RESERVED', 'FAILED']);
    expect(await salesOf(w.eventId)).toEqual([]);
    expect(await quotaOf(p.o.accountId, w.eventId)).toBe(0);
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);
    expect(await failedMark(w.eventId, p.hold.holdId)).toBe('1');
    expect(await jobOf(p.o.id)).toBeUndefined();
    expect(await attemptRefs(p.attemptId)).toEqual(NO_REFS);
  });
});

// ───────────────────────────── 다시 만들기와 겹친 묶기(리뷰 고침 M1) ─────────────────────────────

/** 회차 슬롯 키를 모두 지우고(전체 유실) 다시 만든다(SeatRebuilder, 원장·판매가 없으면 빈 좌석이 된다). 다시 만든 판 번호 */
async function loseAndRebuild(w: World): Promise<number> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, items] = (await cmd(seatKeys.epoch(w.eventId), ['SCAN', cursor, 'MATCH', `s:{event:${w.eventId}}:*`, 'COUNT', '1000'])) as [unknown, unknown[]];
    for (const x of items) keys.push(String(x));
    cursor = String(next);
  } while (cursor !== '0');
  for (const k of keys) await cmd(k, ['DEL', k]);
  await cmd(seatKeys.ctlEvents(), ['SREM', seatKeys.ctlEvents(), w.eventId]);
  const r = await new SeatRebuilder({ source: new DrizzleSeatRebuildSource(database), target: new RedisSeatStore(redis), seatMap, holder: 'saga-e2e-rebuild' }).rebuild(w.eventId, {
    keepUntilMs: w.keepUntilMs,
  });
  expect(r.result).toBe('REBUILT');
  return (await q<{ gen: number }>('select gen from seat_rebuild where event_id = $1', [w.eventId]))[0]!.gen;
}

describe('실패 해제가 끝나지 못한 작업(리뷰 고침 M4)', () => {
  test('M4_실패 해제가 좌석 Redis 장애로 끝나지 못하면 작업 행이 RELEASE로 남고, 다음 실행이 실패 해제를 마친 뒤 작업 행을 지운다(RELEASED) [ASVS v5.0.0-15.4.2]', async () => {
    const w = await world();
    const inner = new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap });
    let failRelease = true;
    const pins: OrderSeatPins = {
      pin: (i, o) => inner.pin(i, o),
      releaseFailed: async (i, o) => {
        if (failRelease) {
          failRelease = false;
          throw new OrderSeatStoreUnavailable(new Error('ECONNRESET'));
        }
        return inner.releaseFailed(i, o);
      },
    };
    const a = assemble(recordingConfirms(), { pins });
    const p = await placeAndAccept(a, w);
    clock.advance(10 * MIN);

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'EXPIRED' });
    expect(await jobOf(p.o.id)).toMatchObject({ step: 'RELEASE', attempts: 1, next_attempt_at: new Date(clock.now() + 1_000) });
    expect(a.log.lines.map((l) => l.kind)).toEqual(['releaseFailed']);
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(1);

    clock.advance(1_000);
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'RELEASED' });
    expect(await jobOf(p.o.id)).toBeUndefined();
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);
    expect(await failedMark(w.eventId, p.hold.holdId)).toBe('1');
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'FAILED', failure_reason: 'EXPIRED' });
  });
});

describe('다시 만들기와 겹친 묶기(리뷰 고침 M1, 명세 pin·saleStep)', () => {
  test('M1_묶은 뒤 판매 예약 전에 전체 유실이 두 번 나 다시 만든 판(판 번호 3)에서 내 홀드가 사라졌으면, 낡은 주문(판 번호 1)의 다시 묶기는 빈 좌석을 다시 잡지 않고 T8 FAILED(STALE_GEN)다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world();
    const inner = new InventoryOrderSeatPins({ pins: new RedisSeatStore(redis), seatMap });
    let first = true;
    const gens: number[] = [];
    // 첫 묶기가 OK로 끝난 직후(판매 예약 전) 전체 유실 → 다시 만들기를 두 번 한다(원장이 비어 내 홀드는 되살아나지 않는다)
    const pins: OrderSeatPins = {
      pin: async (i, o) => {
        const r = await inner.pin(i, o);
        if (first && r.status === 'OK') {
          first = false;
          gens.push(await loseAndRebuild(w), await loseAndRebuild(w));
        }
        return r;
      },
      releaseFailed: (i, o) => inner.releaseFailed(i, o),
    };
    const a = assemble(recordingConfirms(), { pins });
    const p = await placeAndAccept(a, w);

    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'FAILED', transition: 'T8', reason: 'STALE_GEN' });

    expect(gens).toEqual([2, 3]);
    expect(a.confirms.calls).toEqual([]);
    expect(await orderRow(p.o.id)).toEqual({ status: 'FAILED', failure_reason: 'STALE_GEN', seat_gen: 1 });
    expect(await salesOf(w.eventId)).toEqual([]);
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index), `좌석 ${s.index}`).toBe(0);
    expect(await jobOf(p.o.id)).toBeUndefined();
  });
});

// ───────────────────────────── 주문 기준 되살리기(BUILD_ORDER PRF-167, K1·K3) ─────────────────────────────

/** 전체 유실 뒤 주문 근거까지 읽어 다시 만든다(SeatRebuilder + DrizzleRebuildOrders). 다시 만든 판 번호 */
async function loseAndRebuildByOrders(w: World): Promise<number> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, items] = (await cmd(seatKeys.epoch(w.eventId), ['SCAN', cursor, 'MATCH', `s:{event:${w.eventId}}:*`, 'COUNT', '1000'])) as [unknown, unknown[]];
    for (const x of items) keys.push(String(x));
    cursor = String(next);
  } while (cursor !== '0');
  for (const k of keys) await cmd(k, ['DEL', k]);
  await cmd(seatKeys.ctlEvents(), ['SREM', seatKeys.ctlEvents(), w.eventId]);
  const r = await new SeatRebuilder({
    source: new DrizzleSeatRebuildSource(database),
    target: new RedisSeatStore(redis),
    seatMap,
    holder: 'saga-e2e-rebuild-orders',
    orders: new DrizzleRebuildOrders(database),
    clock,
  }).rebuild(w.eventId, { keepUntilMs: w.keepUntilMs });
  expect(r.result).toBe('REBUILT');
  return (await q<{ gen: number }>('select gen from seat_rebuild where event_id = $1', [w.eventId]))[0]!.gen;
}
const pinnedAtOf = async (id: string) => (await q<{ pinned_at: Date | null }>('select pinned_at from purchase_order where id = $1', [id]))[0]?.pinned_at ?? null;
/** 원장 행 하나(seat_hold, 회차 ID가 UUIDv7인 세계에서만. 상태 기본 HELD) */
const putLedgerHeld = (
  eventId: string,
  r: { seatId: string; accountId: string; token: number; heldAtMs: number; expiresAtMs: number; holdId: string; psid: string; status?: 'HELD' | 'RELEASED' | 'EXPIRED' },
) =>
  q(
    `insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, held_at, expires_at, hold_id, purchase_session_id)
     values ($1, $2, $3, $4, $9, 'FAN', $5, $6, $7, $8)`,
    [eventId, r.seatId, r.accountId, r.token, new Date(r.heldAtMs), new Date(r.expiresAtMs), r.holdId, r.psid, r.status ?? 'HELD'],
  );
/**
 * 홀드 원장 적재 흉내(PRF-167): 그 홀드의 좌석마다 홀드 Hash의 토큰·잡은 시각·만료 시각으로 원장 HELD 행을 넣는다(묶기 전에 부른다). 넣은 토큰(좌석 차례).
 * expiresAtMs를 주면 원장 만료 시각을 그 값으로 둔다(묶인 채 홀드 시간이 지남). seats를 주면 그 좌석만, status를 주면 그 상태로 넣는다
 */
async function relayHeld(p: Placed, o: { expiresAtMs?: number; seats?: SeatRef[]; status?: 'HELD' | 'RELEASED' | 'EXPIRED' } = {}): Promise<number[]> {
  const tokens: number[] = [];
  for (const s of o.seats ?? p.hold.seats) {
    const h = await holdHash(p.w.eventId, s.index);
    expect(h, `좌석 ${s.index}의 홀드 Hash`).not.toBeNull();
    tokens.push(Number(h!.fence));
    await putLedgerHeld(p.w.eventId, {
      seatId: s.seatId,
      accountId: p.o.accountId,
      token: Number(h!.fence),
      heldAtMs: Number(h!.heldAt),
      expiresAtMs: o.expiresAtMs ?? Number(h!.exp),
      holdId: p.hold.holdId,
      psid: p.hold.purchaseSessionId,
      ...(o.status !== undefined ? { status: o.status } : {}),
    });
  }
  return tokens;
}
/** DrizzleRebuildOrders에 넘겨 DB 문장을 엿보는 대역(문장마다 sqls에 쌓고 실제 DB로 보낸다) */
function spyDatabase(): { db: Database; sqls: SQL[] } {
  const sqls: SQL[] = [];
  const db = {
    db: {
      execute: (x: SQL) => {
        sqls.push(x);
        return database.db.execute(x);
      },
    },
  } as unknown as Database;
  return { db, sqls };
}
/** EXPLAIN(FORMAT JSON) 계획의 노드들(평평하게) */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const kids = (plan.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...kids.flatMap(planNodes)];
}

describe('주문 기준 되살리기(PRF-167, K1·K3)', () => {
  test('ST26_④_recordPinned(리뷰 고침 L5): ACCEPTED이고 seat_gen이 그대로인 주문에만 판 번호와 pinned_at을 한 번에 적고(true), 다시 불러도 pinned_at은 처음 값 그대로이며, 없는 주문·ACCEPTED가 아닌 주문·판 번호가 다른 주문은 false다(상태 칸은 그대로) [ASVS v5.0.0-2.3.4]', async () => {
    const w = await world();
    const a = assemble();
    const p = await placeAndAccept(a, w);
    expect(await pinnedAtOf(p.o.id)).toBeNull();
    expect(await a.saga.recordPinned(p.o.id, 2, 3)).toBe(false);
    expect(await pinnedAtOf(p.o.id)).toBeNull();
    expect(await a.saga.recordPinned(p.o.id, 1, 1)).toBe(true);
    const first = await pinnedAtOf(p.o.id);
    expect(first).not.toBeNull();
    clock.advance(5_000);
    expect(await a.saga.recordPinned(p.o.id, 1, 2)).toBe(true);
    expect(await pinnedAtOf(p.o.id)).toEqual(first);
    expect(await orderRow(p.o.id)).toMatchObject({ status: 'ACCEPTED', seat_gen: 2 });
    expect(await a.saga.recordPinned(randomUUID(), 1, 1)).toBe(false);
    // ACCEPTED가 아닌 주문(Saga가 판매 예약까지 간 주문)
    const q2 = await placeAndAccept(a, w, { seats: [w.refs[3]!] });
    expect(await a.runner.runOne(q2.o.id)).toEqual({ kind: 'DONE' });
    await q('update purchase_order set pinned_at = null where id = $1', [q2.o.id]);
    expect(await a.saga.recordPinned(q2.o.id, 1, 1)).toBe(false);
    expect(await pinnedAtOf(q2.o.id)).toBeNull();
  });

  test('ST26_④_Saga가 묶기 OK 뒤 주문 pinned_at을 적는다(판매 예약 RESERVED까지 간 주문에 남는다) [ASVS v5.0.0-2.3.4]', async () => {
    const w = await world();
    const a = assemble();
    const p = await placeAndAccept(a, w);
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });
    expect((await orderRow(p.o.id))!.status).toBe('RESERVED');
    expect(await pinnedAtOf(p.o.id)).not.toBeNull();
  });

  test('ST26_④_K1: 묶어 pinned_at을 적은 뒤 판매 예약 전에 전체 유실이 나도(원장에 그 홀드의 HELD 행이 있고 만료 시각은 지남) 다시 만들기가 그 주문의 좌석을 holdId·psid 그대로 살아 있는 홀드(묶음 아님, 만료 = 지금 + 7분, 만료 인덱스에 있음)로 되살리고, Saga의 다음 묶기가 내 홀드로 OK라 RESERVED까지 간다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world({ eventId: uuidv7(clock) });
    let first = true;
    const gens: number[] = [];
    const restored: Array<Record<string, string> | null> = [];
    const expiry: boolean[] = [];
    let rebuiltAt = 0;
    let fenceAfter = 0;
    // 첫 묶기 뒤 실행기가 pinned_at을 적은 바로 뒤(판매 예약 전)에 전체 유실과 다시 만들기
    const a = assemble(recordingConfirms(), {
      afterPinned: async () => {
        if (!first) return;
        first = false;
        rebuiltAt = clock.now();
        gens.push(await loseAndRebuildByOrders(w));
        for (const s of [w.refs[0]!, w.refs[1]!]) {
          restored.push(await holdHash(w.eventId, s.index));
          expiry.push(await inExpiry(w.eventId, s.index));
        }
        fenceAfter = Number(await cmd(seatKeys.fence(w.eventId), ['GET', seatKeys.fence(w.eventId)]));
      },
    });
    const p = await placeAndAccept(a, w);
    // 원장 적재(묶기 전 HELD 사건). 원장 만료 시각은 이미 지났다(묶인 채 홀드 시간이 지남): 만료 전 원장 홀드로는 되살아나지 않는다
    const tokens = await relayHeld(p, { expiresAtMs: Math.min(clock.now(), Date.now()) - MIN });
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });
    expect(gens).toEqual([2]);
    expect(restored).toHaveLength(2);
    for (const h of restored) {
      expect(h).toMatchObject({ holdId: p.hold.holdId, owner: p.o.accountId, psid: p.hold.purchaseSessionId, kind: 'FAN' });
      expect(h!.pin === '1').toBe(false);
      expect(Number(h!.exp)).toBe(rebuiltAt + 420_000);
    }
    // 되살린 홀드의 펜싱 토큰은 그 원장 HELD 행의 토큰이고(리뷰 고침 L4), 끝내기가 펜싱 카운터를 그 이상으로 되살렸다
    expect(restored.map((h) => h!.fence)).toEqual(tokens.map(String));
    expect(fenceAfter).toBeGreaterThanOrEqual(Math.max(...tokens));
    expect(expiry).toEqual([true, true]);
    expect(await orderRow(p.o.id)).toEqual({ status: 'RESERVED', failure_reason: null, seat_gen: 2 });
    expect((await salesOf(w.eventId)).map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });

  test('ST26_④_K3: 원장 행이 없는 판매 좌석을 다시 만들면 holdId·psid가 그 주문의 것이라, 승인 거절 뒤 그 시도의 holdId로 부른 실패 해제가 그 좌석을 푼다 [ASVS v5.0.0-15.4.2]', async () => {
    const w = await world();
    const a = assemble();
    const p = await placeAndAccept(a, w);
    expect(await a.runner.runOne(p.o.id)).toEqual({ kind: 'DONE' });
    await loseAndRebuildByOrders(w);
    for (const s of p.hold.seats) {
      expect(await holdHash(w.eventId, s.index)).toMatchObject({ holdId: p.hold.holdId, owner: p.o.accountId, psid: p.hold.purchaseSessionId, pin: '1' });
    }
    const r = await new RedisSeatStore(redis).releaseFailed({ eventId: w.eventId, accountId: p.o.accountId, holdId: p.hold.holdId, seats: p.hold.seats, keepUntilMs: w.keepUntilMs });
    expect(r).toMatchObject({ kind: 'OK', released: p.hold.seats.length });
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);
  });

  test('ST26_④_우선순위: 같은 좌석에 활성 판매와 다른 계정의 묶인 주문(원장 HELD 행 있음)이 있으면 판매가 이기고(묶음·판매 계정·판매 주문의 holdId), 묶인 주문의 나머지 좌석은 살아 있는 홀드다. 보유 수는 근거를 합쳐 센다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world({ eventId: uuidv7(clock) });
    const a = assemble();
    const sold = await placeAndAccept(a, w);
    expect(await a.runner.runOne(sold.o.id)).toEqual({ kind: 'DONE' });
    const other = await placeAndAccept(a, w, { seats: [w.refs[2]!] });
    // 묶인 주문(ACCEPTED·pinned_at)의 원장 HELD 행(그 홀드의 좌석)
    await relayHeld(other);
    // 묶인 주문의 항목과 원장에 판매 좌석 하나를 더 넣는다(손으로 만든 겹침. 판매 주문의 홀드는 원장에 없어 좌석마다 HELD 하나 제약에 걸리지 않는다)
    const s0 = w.refs[0]!;
    await q('insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) values ($1, 2, $2, $3, $4, $5)', [other.o.id, s0.seatId, s0.tierId, s0.sectionId, PRICES.R]);
    await putLedgerHeld(w.eventId, {
      seatId: s0.seatId,
      accountId: other.o.accountId,
      token: 1,
      heldAtMs: clock.now(),
      expiresAtMs: clock.now() + 7 * MIN,
      holdId: other.hold.holdId,
      psid: other.hold.purchaseSessionId,
    });
    await q('update purchase_order set pinned_at = now() where id = $1', [other.o.id]);
    await loseAndRebuildByOrders(w);
    expect(await holdHash(w.eventId, s0.index)).toMatchObject({ holdId: sold.hold.holdId, owner: sold.o.accountId, pin: '1' });
    const h2 = await holdHash(w.eventId, w.refs[2]!.index);
    expect(h2).toMatchObject({ holdId: other.hold.holdId, owner: other.o.accountId, psid: other.hold.purchaseSessionId });
    expect(h2!.pin === '1').toBe(false);
    const quota = async (acc: string) => Number(await cmd(seatKeys.quota(w.eventId, acc), ['GET', seatKeys.quota(w.eventId, acc)]));
    expect([await quota(sold.o.accountId), await quota(other.o.accountId)]).toEqual([2, 1]);
  });

  test('ST26_④_K1(리뷰 B①): 결제 접수·묶인 주문의 세 좌석 가운데 원장 행이 RELEASED인 좌석·원장 행이 없는 좌석은 되살리지 않고, HELD 행이 있는 셋째 좌석만 되살린다(보유 수 1) [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world({ eventId: uuidv7(clock) });
    const a = assemble();
    const [s1, s2, s3] = [w.refs[0]!, w.refs[1]!, w.refs[2]!];
    const p = await placeAndAccept(a, w, { seats: [s1, s2, s3] });
    await relayHeld(p, { seats: [s1], status: 'RELEASED' });
    await relayHeld(p, { seats: [s3] });
    expect(await a.saga.recordPinned(p.o.id, 1, 1)).toBe(true);
    await loseAndRebuildByOrders(w);
    expect([await bit(w.eventId, s1.index), await bit(w.eventId, s2.index), await bit(w.eventId, s3.index)]).toEqual([0, 0, 1]);
    expect(await holdHash(w.eventId, s3.index)).toMatchObject({ holdId: p.hold.holdId, owner: p.o.accountId, psid: p.hold.purchaseSessionId });
    expect(Number(await cmd(seatKeys.quota(w.eventId, p.o.accountId), ['GET', seatKeys.quota(w.eventId, p.o.accountId)]))).toBe(1);
  });

  test('ST26_④_K1(리뷰 B②): pinned_at이 있고 원장 HELD 행이 남았어도 주문이 ACCEPTED가 아니면(FAILED) 되살리지 않는다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world({ eventId: uuidv7(clock) });
    const a = assemble();
    const p = await placeAndAccept(a, w);
    // 원장 행은 만료된 HELD(원장 홀드 길로는 되살아나지 않아 주문 근거만 본다). 앞 시험이 가짜 시계를 앞으로 돌렸을 수 있어
    // DB의 now()와 견주는 만료 시각은 실제 시각 기준으로도 지난 값으로 둔다
    await relayHeld(p, { expiresAtMs: Math.min(clock.now(), Date.now()) - MIN });
    expect(await a.saga.recordPinned(p.o.id, 1, 1)).toBe(true);
    // 손으로 만든 어긋남: 작업 행(RESERVE)은 그대로 두고 주문만 FAILED로(상태 조건만 이 주문을 거른다).
    // 상태 이력 지연 제약(order_status_has_event)이 이력 행 없는 상태 쓰기를 막으므로 같은 문장에서 이력 행도 넣는다
    await q(
      `with e as (insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at)
                  select id, event_seq + 1, status, 'FAILED', 'TEST', 'test', now() from purchase_order where id = $1)
       update purchase_order set status = 'FAILED', event_seq = event_seq + 1 where id = $1`,
      [p.o.id],
    );
    await loseAndRebuildByOrders(w);
    for (const s of p.hold.seats) expect(await bit(w.eventId, s.index)).toBe(0);
  });

  test('리뷰 고침 H1: 묶인 주문 읽기(pinnedOrders)는 작업 표 order_saga_job에서 출발해 purchase_order·order_item을 색인 조건으로만 읽는다(EXPLAIN에 purchase_order 통째 읽기가 없다) [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world();
    const a = assemble();
    const p = await placeAndAccept(a, w);
    expect(await a.saga.recordPinned(p.o.id, 1, 1)).toBe(true);
    const spy = spyDatabase();
    const got = await new DrizzleRebuildOrders(spy.db).pinnedOrders(w.eventId);
    expect(got).toEqual([{ orderId: p.o.id, accountId: p.o.accountId, holdId: p.hold.holdId, purchaseSessionId: p.hold.purchaseSessionId, seatIds: p.hold.seats.map((s) => s.seatId) }]);
    expect(spy.sqls).toHaveLength(1);
    const { sql: text, params } = new PgDialect().sqlToQuery(spy.sqls[0]!);
    // 시험 DB는 주문·항목 표가 작아 계획기가 그 표를 기본 키 차례로 통째 읽는 편(정렬을 아낌)을 고른다. 운영처럼 두 표가 작업 표보다 훨씬 크게
    // 다른 회차 주문 2만 건(항목 하나씩)을 같은 트랜잭션에 넣고 통계를 새로 낸 뒤(되돌려 남기지 않는다), 통째 읽기·해시·병합 조인을 꺼서 색인으로 닿는 길을 본다
    const client = await admin.pool.connect();
    let nodes: Record<string, unknown>[];
    try {
      await client.query('begin');
      await client.query(
        `with o as (insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
                    select gen_random_uuid(), gen_random_uuid(), $1::uuid, 'CONFIRMED', 0, 1, 'k', 'v1', 'PICK', now(), gen_random_uuid(), 'ps' from generate_series(1, 20000)
                    returning id),
              e as (insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) select id, 1, null, 'CONFIRMED', 'TEST', 'test', now() from o)
         insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) select id, 1, gen_random_uuid(), 'R', 'A', 0 from o`,
        [uuidv7(clock)],
      );
      for (const t of ['purchase_order', 'order_item', 'order_saga_job']) await client.query(`analyze ${t}`);
      await client.query('set local enable_seqscan = off');
      await client.query('set local enable_hashjoin = off');
      await client.query('set local enable_mergejoin = off');
      const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${text}`, params);
      nodes = planNodes(r.rows[0]!['QUERY PLAN'][0].Plan);
      await client.query('rollback');
    } finally {
      client.release();
    }
    const on = (rel: string) => nodes.filter((n) => n['Relation Name'] === rel);
    expect(on('order_saga_job').length).toBeGreaterThan(0);
    for (const rel of ['purchase_order', 'order_item']) {
      expect(on(rel).length, rel).toBeGreaterThan(0);
      for (const n of on(rel)) {
        expect(n['Node Type'], `${rel} ${JSON.stringify(n)}`).not.toBe('Seq Scan');
        expect(n['Index Cond'] ?? n['Recheck Cond'], `${rel}는 색인 조건으로 읽는다: ${JSON.stringify(n)}`).toBeDefined();
      }
    }
  });

  test('saleOrders: 주문 ID가 1,000개를 넘으면(겹친 ID 포함) 겹치지 않게 나눠 묻고(두 문장) 그 회차에 있는 주문만 한 번씩 돌려준다. 0개면 DB를 부르지 않고 [], 소문자 UUID가 아니면 RangeError [ASVS v5.0.0-2.3.4]', async () => {
    const w = await world();
    const a = assemble();
    const p1 = await placeAndAccept(a, w);
    const p2 = await placeAndAccept(a, w, { seats: [w.refs[2]!] });
    const ids = [p1.o.id, ...Array.from({ length: 1_200 }, () => randomUUID()), p2.o.id, p1.o.id, p2.o.id];
    const spy = spyDatabase();
    const got = await new DrizzleRebuildOrders(spy.db).saleOrders(w.eventId, ids);
    expect(spy.sqls).toHaveLength(2);
    expect([...got].sort((x, y) => (x.orderId < y.orderId ? -1 : 1))).toEqual(
      [p1, p2]
        .map((p) => ({ orderId: p.o.id, holdId: p.hold.holdId, purchaseSessionId: p.hold.purchaseSessionId }))
        .sort((x, y) => (x.orderId < y.orderId ? -1 : 1)),
    );
    // 다른 회차로 물으면 없다
    expect(await new DrizzleRebuildOrders(database).saleOrders(randomUUID(), [p1.o.id])).toEqual([]);
    const none = spyDatabase();
    expect(await new DrizzleRebuildOrders(none.db).saleOrders(w.eventId, [])).toEqual([]);
    expect(none.sqls).toHaveLength(0);
    await expect(new DrizzleRebuildOrders(database).saleOrders(w.eventId, [p1.o.id.toUpperCase()])).rejects.toThrow(RangeError);
    await expect(new DrizzleRebuildOrders(database).pinnedOrders('evt')).rejects.toThrow(RangeError);
  });
});
