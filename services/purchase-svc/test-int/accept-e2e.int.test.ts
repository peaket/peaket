// 결제 접수 POST /v1/orders/{orderId}/payment-acceptance를 앱째로 돈다: 실제 PostgreSQL 18·실제 Valkey 8.1(BUILD_ORDER PRF-162).
// 정본: docs/features/payment.md §2 '결제 접수의 첫 구현'(검사 차례·상태 표·활성 결제 시도 대조·한 트랜잭션·결제 참조의 자리)·§4.2 2·18,
// 시험 표 P-T7·P-T23·P-T28·P-T45 ③, docs/features/seat-hold.md S-T29 ⑥, docs/data.md payment_attempt·purchase_order.seat_gen·order_saga_job·§3 세대 키·판매 정지 사본·
// §5 '결제 접수' 줄, docs/security/data-classification.md '결제사 결제 참조' 행, openapi POST /v1/orders/{orderId}/payment-acceptance.
//
// 약속:
// - 앱 조립은 orders-e2e.int.test.ts와 같고 booking에 accepts = DrizzleOrderAccepts, slots = InventorySeatSlots(RedisSeatSlots), acceptLog = 기록 대역을 더 넘긴다.
//   본인확인 재확인은 gRPC 대신 늘 VERIFIED(그 팬의 pid)인 대역, 가명은 missingContactRefs다(주문 생성의 재확인은 orders-e2e가 본다).
// - 주문은 실제 경로(홀드 → POST /v1/orders)로 만들고, 결제 시도 READY 행은 시험이 직접 넣는다(결제 시도 시작 API는 PRF-190).
// - 주문 만료는 시험이 SQL로 만든다: PRF-160의 상태 이력 지연 제약 트리거를 그 트랜잭션에서만 끈다(set local session_replication_role = replica).
// - 두 탭 동시·같은 키 겹침은 결제 시도 행을 admin 연결의 SELECT … FOR UPDATE로 붙잡아 두 요청이 트랜잭션 안에서 겹치게 한다
//   (같은 구매 세션의 요청 번호는 차례대로 올라야 해서 두 요청을 그냥 함께 보내면 서명 단계에서 하나가 401로 끝날 수 있다).
// - 앱 시계는 Valkey 시계에 맞춘 가짜 시계다(홀드 Lua가 Redis TIME을 쓴다). 회차·계정·좌석 ID는 시험마다 새 UUID다.
//
// 정본 모호(accept-payment.ts·orders.controller.ts의 정한 것을 따른다):
// - 40분 [가정] 경계는 '만든 지 ≥ 40분이면 맞지 않음'이다(40분 − 1초는 받는다).
// - 금액 불일치 400은 요청 검사 실패와 같은 about:blank이고 받은 금액·주문 금액을 싣지 않는다. 보안 로그는 대조 실패와 같은 꼴로 한 줄(까닭 amount_mismatch)을 남긴다
//   (payment §2 '활성 결제 시도 대조', ASVS 16.3.3, 2026-11-05 정본 바로잡음).
// - 404 셋(남의 주문·없는 주문·UUID가 아닌 주문 ID)은 type·status·title이 같다(traceId는 요청마다 다르다).
// - 접수 뒤 다른 키의 두 번째 접수는 상태 표에서 409 payment-already-accepted다(§4.2 2. 결제창을 다시 여는 길은 PRF-190).
// - 포트원 서버 금액 불일치(P-T28 다섯째)는 승인 단계라 Saga(PRF-165)가 본다. 401 purchase-session-ended는 쓰임새 단위 시험이 본다.
import 'reflect-metadata';
import { createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import {
  createDatabase,
  createHotRedis,
  createService,
  type Database,
  ensureOutboxPartitions,
  fakeClock,
  type HotRedis,
  PROBLEM_TYPE_BASE,
  purchaseMac,
  purchaseMacInput,
  purchaseRequestKey,
  uuidv7,
} from '@peaket/platform';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  type AcceptLog,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  type IdentityRecheck,
  InventoryOrderSessions,
  InventorySeatSlots,
  missingContactRefs,
  type OrderLog,
  type OrderSignals,
  RedisBookingRestrictions,
  SeatMapSaleConfigs,
} from '../src/modules/booking/index.js';
import {
  type EventSeatConfig,
  KEEP_AFTER_SALE_END_MS,
  MemorySeatMap,
  type MemorySeatDef,
  OpenPurchaseSession,
  RecordingHoldAttempts,
  RecordingSessionStartedLog,
  RedisOrderHolds,
  RedisPurchaseSessionStore,
  RedisSeatSlots,
  RedisSeatStore,
  ServerEcdhKey,
  StoredPurchaseSessions,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from '../test/admission-fixtures.js';
import { clientKeyOf } from '../test/session-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const MIN = 60_000;
const CONSENT = 'consent-2026.11_v1';
const PRICES = { R: 99_000, S: 132_000 } as const;
const SEAT_COUNT = 10;
/** 앱 DB 풀 이름(pg_stat_activity에서 잠금을 기다리는 연결을 찾는다) */
const APP = 'accept-e2e';

// ───────────────────────────── 앱 ─────────────────────────────

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let database: Database;
let admin: Database;
let svc: Awaited<ReturnType<typeof createService>> | undefined;

const logs: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    logs.push(String(c));
    cb();
  },
});
let clock: ReturnType<typeof fakeClock>;
const seatMap = new MemorySeatMap();
const admissionKey = newKey('k1');
const serverPriv = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const serverPub = createPublicKey({ key: serverPriv.publicJwk(), format: 'jwk' });

/** 계정 → pid(재확인 대역이 돌려주는 값) */
const pidOf = new Map<string, string>();
const identity: IdentityRecheck = { check: async (q) => ({ status: 'VERIFIED', pid: pidOf.get(q.accountId) ?? '' }) };
const signals: OrderSignals = { historyMismatch: () => {} };
const orderLog: OrderLog = { identityFallback: () => {}, configError: () => {}, payingMarkFailed: () => {} };
/** 결제 시도 대조 실패 보안 로그 */
const mismatchLines: Parameters<AcceptLog['attemptMismatch']>[0][] = [];
const acceptLog: AcceptLog = { attemptMismatch: (e) => void mismatchLines.push(e) };

let opener: OpenPurchaseSession;

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
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 10, applicationName: APP });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'accept-e2e-admin' });
  await ensureOutboxPartitions(admin, clock);

  const sessionStore = new RedisPurchaseSessionStore(redis);
  const sessions = new StoredPurchaseSessions({ store: sessionStore, ecdh: serverPriv, clock });
  const startedLog = new RecordingSessionStartedLog();
  const keys = new Map([['k1', admissionKey.pub]]);
  opener = new OpenPurchaseSession({ store: sessionStore, log: startedLog, keys, issuer: ISS, clock });
  const orderStore = new DrizzleOrderStore({ clock });

  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      redis,
      seatMap,
      attempts: new RecordingHoldAttempts(),
      podId: 'pod-accept-e2e',
      sessions,
      admission: { store: sessionStore, startedLog, keys, issuer: ISS },
      booking: {
        writes: new DrizzleOrderWrites({ database, store: orderStore, clock }),
        accepts: new DrizzleOrderAccepts({ database, store: orderStore, clock }),
        slots: new InventorySeatSlots(new RedisSeatSlots(redis)),
        holds: new RedisOrderHolds(redis, seatMap),
        saleConfigs: new SeatMapSaleConfigs(seatMap),
        sessions: new InventoryOrderSessions({ sessions, store: sessionStore }),
        identity,
        contactRefs: missingContactRefs,
        restrictions: new RedisBookingRestrictions(redis),
        signals,
        log: orderLog,
        acceptLog,
        consentVersion: CONSENT,
        clock,
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  pgServer?.stop();
});

beforeEach(() => {
  mismatchLines.length = 0;
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/** 이력 없이 주문 행을 바꾸는 준비 SQL(그 트랜잭션에서만 상태 이력 지연 제약 트리거를 끈다, order-store.int.test.ts의 rawNoHistory와 같은 꼴) */
async function rawNoHistory(text: string, params: unknown[] = []): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(text, params);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

interface World {
  eventId: string;
  r: string[];
  s: string[];
}

/** 회차 하나: 좌석맵 판을 넣고 좌석 Redis 판매를 연다(세대 키 gen 1) */
async function world(): Promise<World> {
  const eventId = randomUUID();
  const r = Array.from({ length: 6 }, () => randomUUID()).sort();
  const s = Array.from({ length: 4 }, () => randomUUID()).sort();
  const defs: MemorySeatDef[] = [
    ...r.map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' })),
    ...s.map((seatId, i) => ({ seatId, index: 6 + i, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: i, tierId: 'S' })),
  ];
  const config: EventSeatConfig = { eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: clock.now() + DAY, tierPrices: { ...PRICES } };
  seatMap.put(config, defs);
  await new RedisSeatStore(redis).openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  return { eventId, r, s };
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

/** 그 회차에 입장 토큰으로 구매 세션을 연 팬. accountId를 주면 그 계정의 다른 구매 세션(다른 탭·기기)이다 */
async function fan(w: World, accountId: string = randomUUID()): Promise<Fan> {
  const jti = randomUUID();
  const login = randomUUID();
  const pid = pidOf.get(accountId) ?? `pid-${randomUUID()}`;
  pidOf.set(accountId, pid);
  const token = signAdmission(admissionKey, claimsOf({ nowMs: clock.now(), jti, accountId, loginSessionId: login, eventId: w.eventId }, { jny: uuidv7(clock) }));
  const client = clientKeyOf();
  await opener.execute({ token, accountId, loginSessionId: login, eventId: w.eventId, clientKey: client.text });
  const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), jti));
  return { eventId: w.eventId, accountId, login, pid, jti, token, macKey, seq: 0 };
}

/** 서명한 구매 요청(게이트웨이가 넘기는 신원 머리 + 멱등 키 + 구매 요청 서명) */
function signed(f: Fan, url: string, body: unknown, o: { idemKey?: string } = {}) {
  const payload = JSON.stringify(body);
  const n = ++f.seq;
  const headers: Record<string, string> = {
    'x-user-id': f.accountId,
    'x-session-id': f.login,
    'x-user-aud': 'fan',
    'x-user-scope': 'ticket:buy',
    'x-user-pid': f.pid,
    'content-type': 'application/json',
    'idempotency-key': o.idemKey ?? randomUUID(),
    'x-purchase-seq': String(n),
    'x-purchase-mac': purchaseMac(f.macKey, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8'))),
    'x-admission-token': f.token,
  };
  return svc!.http.inject({ method: 'POST', url, headers, payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

/** 홀드 → 주문(201). 주문 ID와 서버가 계산한 금액 */
async function placeOrder(f: Fan, seatIds: string[]): Promise<{ orderId: string; amount: number }> {
  const h = await signed(f, `/v1/events/${f.eventId}/holds`, { seatIds });
  expect(h.statusCode, h.payload).toBe(201);
  const r = await signed(f, '/v1/orders', {
    holdId: String(json(h).holdId),
    buyer: { name: '김피켓', phone: '010-1234-5678' },
    consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT },
  });
  expect(r.statusCode, r.payload).toBe(201);
  return { orderId: String(json(r).orderId), amount: Number(json(r).amount) };
}

type Pg = 'TOSS' | 'PORTONE' | 'SIMULATOR';
/** 결제 시도 행을 직접 넣는다. pg_order_ref: 토스·시뮬레이터 = 주문 ID, 포트원 = pay-{주문 ID}(payment §2.1 '주문 식별자 재사용') */
async function putAttempt(orderId: string, o: { pg?: Pg; createdAtMs?: number; status?: string } = {}): Promise<string> {
  const pg = o.pg ?? 'TOSS';
  const id = uuidv7(clock);
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [
    id,
    orderId,
    pg,
    pg === 'PORTONE' ? `pay-${orderId}` : orderId,
    o.status ?? 'READY',
    new Date(o.createdAtMs ?? clock.now()),
  ]);
  return id;
}

const tossBody = (amount: number, paymentKey = `tgen_${randomUUID().replaceAll('-', '').slice(0, 24)}`) => ({ pg: 'TOSS', paymentKey, amount });
const portoneBody = (orderId: string) => ({ pg: 'PORTONE', paymentId: `pay-${orderId}`, paymentToken: `ptok_${randomUUID().replaceAll('-', '')}`, txId: `tx-${randomUUID()}` });
const acceptUrl = (orderId: string) => `/v1/orders/${orderId}/payment-acceptance`;
const accept = (f: Fan, orderId: string, body: unknown, o: { idemKey?: string } = {}) => signed(f, acceptUrl(orderId), body, o);

/** 문제 상세 응답(이름 있는 type) */
function expectProblem(r: { statusCode: number; payload: string; headers: Record<string, unknown> }, status: number, slug: string) {
  expect(r.statusCode, r.payload).toBe(status);
  expect(json(r)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}${slug}`, status });
  expect(r.headers['cache-control']).toBe('no-store');
}
/** 202(본문 없음, 캐시하지 않음) */
function expectAccepted(r: { statusCode: number; payload: string; headers: Record<string, unknown> }) {
  expect(r.statusCode, r.payload).toBe(202);
  expect(r.payload).toBe('');
  expect(r.headers['cache-control']).toBe('no-store');
}

async function outboxOf(eventId: string): Promise<{ raw: string; event: Record<string, unknown> }[]> {
  const rows = await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]);
  return rows.map((r) => {
    const raw = Buffer.from(r.payload).toString('utf8');
    return { raw, event: JSON.parse(raw) as Record<string, unknown> };
  });
}
const orderRow = async (id: string) =>
  (await q<{ status: string; event_seq: number; seat_gen: number | null }>('select status, event_seq, seat_gen from purchase_order where id = $1', [id]))[0];
const attemptRow = async (id: string) =>
  (
    await q<{ status: string; pg_payment_key: string | null; pg_tx_id: string | null; pg_payment_token: string | null; accepted_at: Date | null }>(
      'select status, pg_payment_key, pg_tx_id, pg_payment_token, accepted_at from payment_attempt where id = $1',
      [id],
    )
  )[0];
const sagaJobsOf = (orderId: string) => q('select order_id, event_id, step, attempts, lease_until from order_saga_job where order_id = $1', [orderId]);
const acceptIdemCount = (accountId: string) => count(`select count(*) as n from order_idempotency where account_ref = $1 and operation = 'ACCEPT_PAYMENT'`, [accountId]);

/** 아무것도 바뀌지 않았는지 볼 흔적 */
const traceOf = async (f: Fan, orderId: string, attemptId?: string) => ({
  order: await orderRow(orderId),
  attempt: attemptId === undefined ? undefined : await attemptRow(attemptId),
  history: await count('select count(*) as n from order_event where order_id = $1', [orderId]),
  outbox: (await outboxOf(f.eventId)).length,
  saga: (await sagaJobsOf(orderId)).length,
  idem: await acceptIdemCount(f.accountId),
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const lockWaiters = () => count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [APP]);

/** 결제 시도 행을 admin 연결의 SELECT … FOR UPDATE로 붙잡는다(풀 때 commit) */
async function lockAttempt(attemptId: string): Promise<{ release: () => Promise<void> }> {
  const c: PoolClient = await admin.pool.connect();
  await c.query('begin');
  await c.query('select id from payment_attempt where id = $1 for update', [attemptId]);
  let done = false;
  return {
    release: async () => {
      if (done) return;
      done = true;
      try {
        await c.query('commit');
      } finally {
        c.release();
      }
    },
  };
}
/** 요청 Promise가 끝났는지 */
function tracked<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let s = false;
  void p.then(
    () => {
      s = true;
    },
    () => {
      s = true;
    },
  );
  return { p, settled: () => s };
}

// ───────────────────────────── 202 ─────────────────────────────

describe('POST /v1/orders/{orderId}/payment-acceptance 202', () => {
  test('토스 202(본문 없음): 주문 ACCEPTED·seat_gen = 세대 키 gen, 시도 ACCEPTED·결제 키, 이력 T3·T4, Outbox ACCEPTED 하나(계약 맞음), Saga 작업 RESERVE 한 행, 멱등 기록(결과 참조 = 주문 ID). 결제 키는 Outbox·로그·응답에 없다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-14.2.4]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[0]!, w.s[0]!]);
    expect(amount).toBe(PRICES.R + PRICES.S);
    const attemptId = await putAttempt(orderId);
    const epochKey = seatKeys.epoch(w.eventId);
    await redis.command(['HSET', epochKey, 'gen', '3'], { key: epochKey });
    const body = tossBody(amount);
    const idemKey = randomUUID();
    const logsBefore = logs.length;

    const r = await accept(f, orderId, body, { idemKey });

    expectAccepted(r);
    expect(await orderRow(orderId)).toEqual({ status: 'ACCEPTED', event_seq: 3, seat_gen: 3 });
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'ACCEPTED', pg_payment_key: body.paymentKey, pg_tx_id: null, pg_payment_token: null, accepted_at: new Date(clock.now()) });
    expect(await q('select seq, from_status, to_status, cause, actor from order_event where order_id = $1 order by seq', [orderId])).toEqual([
      { seq: 1, from_status: null, to_status: 'CREATED', cause: 'T1', actor: `account:${f.accountId}` },
      { seq: 2, from_status: 'CREATED', to_status: 'AUTHENTICATED', cause: 'T3', actor: `account:${f.accountId}` },
      { seq: 3, from_status: 'AUTHENTICATED', to_status: 'ACCEPTED', cause: 'T4', actor: `account:${f.accountId}` },
    ]);
    const outbox = await outboxOf(w.eventId);
    expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED']);
    expect(outbox[1]!.event).toMatchObject({ type: 'ACCEPTED', orderId, eventId: w.eventId, accountId: f.accountId, amount, firstInStage: true });
    expect(OrderEvent.safeParse(outbox[1]!.event).error?.issues ?? []).toEqual([]);
    for (const x of outbox) expect(x.raw).not.toContain(body.paymentKey);
    expect(await sagaJobsOf(orderId)).toEqual([{ order_id: orderId, event_id: w.eventId, step: 'RESERVE', attempts: 0, lease_until: null }]);
    expect(await q('select result_ref from order_idempotency where account_ref = $1 and operation = $2 and idempotency_key = $3', [f.accountId, 'ACCEPT_PAYMENT', idemKey])).toEqual([
      { result_ref: orderId },
    ]);
    expect(logs.slice(logsBefore).filter((l) => l.includes(body.paymentKey))).toEqual([]);
    expect(mismatchLines).toEqual([]);
  });

  test('포트원 202: paymentId = 시도의 pg_order_ref(pay-{주문 ID})이면 txId·토큰을 시도에 적고, txId·토큰은 Outbox·로그·응답에 없다 [ASVS v5.0.0-14.2.4]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId } = await placeOrder(f, [w.r[1]!]);
    const attemptId = await putAttempt(orderId, { pg: 'PORTONE' });
    const body = portoneBody(orderId);
    const logsBefore = logs.length;

    const r = await accept(f, orderId, body);

    expectAccepted(r);
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'ACCEPTED', pg_payment_key: null, pg_tx_id: body.txId, pg_payment_token: body.paymentToken });
    expect(await orderRow(orderId)).toEqual({ status: 'ACCEPTED', event_seq: 3, seat_gen: 1 });
    for (const x of await outboxOf(w.eventId)) {
      expect(x.raw).not.toContain(body.paymentToken);
      expect(x.raw).not.toContain(body.txId);
    }
    const fresh = logs.slice(logsBefore);
    expect(fresh.filter((l) => l.includes(body.paymentToken) || l.includes(body.txId))).toEqual([]);
  });

  test('시뮬레이터 202: 토스와 같은 본문(paymentKey·amount)이다', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.s[1]!]);
    const attemptId = await putAttempt(orderId, { pg: 'SIMULATOR' });
    const body = { ...tossBody(amount), pg: 'SIMULATOR' };
    expectAccepted(await accept(f, orderId, body));
    expect(await attemptRow(attemptId)).toMatchObject({ status: 'ACCEPTED', pg_payment_key: body.paymentKey });
  });

  test('PT23_접수(202) 뒤 다른 멱등 키로 또 접수하면 상태 표에서 409 payment-already-accepted이고 새 이력·Saga 작업이 없다(§4.2 2)', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[2]!]);
    const attemptId = await putAttempt(orderId);
    expectAccepted(await accept(f, orderId, tossBody(amount)));
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(f, orderId, tossBody(amount)), 409, 'payment-already-accepted');

    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expect(before).toMatchObject({ history: 3, saga: 1, idem: 1 });
  });
});

// ───────────────────────────── 두 탭 동시(P-T23) ─────────────────────────────

describe('POST …/payment-acceptance 두 탭 동시(P-T23, data.md §5 결제 접수)', () => {
  test('PT23_같은 주문을 두 탭이 다른 멱등 키로 동시에 접수하면(둘 다 트랜잭션 안에서 결제 시도 행을 기다리게 한 뒤 함께 풀기) 하나는 202, 하나는 409 payment-already-accepted이고 Saga 작업 행 하나·이력 빈틈 없음이다(세 번) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.1]', async () => {
    const w = await world();
    for (let round = 0; round < 3; round += 1) {
      const f = await fan(w);
      const { orderId, amount } = await placeOrder(f, [w.r[3 + round]!]);
      const attemptId = await putAttempt(orderId);
      const bodies = [tossBody(amount), tossBody(amount)];
      const lock = await lockAttempt(attemptId);
      let a: ReturnType<typeof tracked<Awaited<ReturnType<typeof accept>>>>;
      let b: ReturnType<typeof tracked<Awaited<ReturnType<typeof accept>>>>;
      try {
        a = tracked(accept(f, orderId, bodies[0]));
        expect(await waitFor(async () => a.settled() || (await lockWaiters()) >= 1, 5_000), `${round}회 a`).toBe(true);
        b = tracked(accept(f, orderId, bodies[1]));
        expect(await waitFor(async () => b.settled() || (await lockWaiters()) >= 2, 5_000), `${round}회 b`).toBe(true);
        // 두 요청 모두 아직 끝나지 않았다(트랜잭션 안에서 결제 시도 행을 기다린다)
        expect([a.settled(), b.settled()], `${round}회`).toEqual([false, false]);
      } finally {
        await lock.release();
      }
      const [ra, rb] = await Promise.all([a!.p, b!.p]);
      const codes = [ra.statusCode, rb.statusCode].sort();
      expect(codes, `${round}회 ${ra.payload} ${rb.payload}`).toEqual([202, 409]);
      const [won, lost] = ra.statusCode === 202 ? [0, 1] : [1, 0];
      expectProblem([ra, rb][lost]!, 409, 'payment-already-accepted');
      expect(await sagaJobsOf(orderId)).toHaveLength(1);
      expect((await q<{ seq: number }>('select seq from order_event where order_id = $1 order by seq', [orderId])).map((x) => x.seq)).toEqual([1, 2, 3]);
      expect(await acceptIdemCount(f.accountId), `${round}회 진 쪽 멱등 기록은 남지 않는다`).toBe(1);
      expect((await attemptRow(attemptId))?.pg_payment_key).toBe(bodies[won]!.paymentKey);
    }
  });
});

describe('POST …/payment-acceptance 접수 중 결제 시도가 대체·만료됨(리뷰 고침 M2)', () => {
  test.each(['SUPERSEDED', 'EXPIRED'])(
    'PT28_접수 트랜잭션이 결제 시도 행을 기다리는 동안 다른 연결이 시도를 %s로 바꿔 커밋하면 409 payment-attempt-mismatch이고 보안 로그 한 줄이며 주문은 CREATED 그대로다 [ASVS v5.0.0-15.4.1]',
    async (status) => {
      const w = await world();
      const f = await fan(w);
      const { orderId, amount } = await placeOrder(f, [w.s[0]!]);
      const attemptId = await putAttempt(orderId);
      const c: PoolClient = await admin.pool.connect();
      let req: ReturnType<typeof tracked<Awaited<ReturnType<typeof accept>>>>;
      try {
        await c.query('begin');
        await c.query('select id from payment_attempt where id = $1 for update', [attemptId]);
        req = tracked(accept(f, orderId, tossBody(amount)));
        expect(await waitFor(async () => req.settled() || (await lockWaiters()) >= 1, 5_000)).toBe(true);
        expect(req.settled()).toBe(false);
        await c.query('update payment_attempt set status = $2 where id = $1', [attemptId, status]);
        await c.query('commit');
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
      const r = await req!.p;
      expectProblem(r, 409, 'payment-attempt-mismatch');
      expect(mismatchLines).toEqual([{ accountId: f.accountId, orderId, reason: status === 'EXPIRED' ? 'attempt_expired' : 'no_attempt' }]);
      expect(await orderRow(orderId)).toEqual({ status: 'CREATED', event_seq: 1, seat_gen: null });
      expect(await sagaJobsOf(orderId)).toEqual([]);
      expect(await acceptIdemCount(f.accountId)).toBe(0);
    },
  );
});

// ───────────────────────────── 대조(P-T28·P-T7) ─────────────────────────────

describe('POST …/payment-acceptance 결제 시도 대조(P-T28·P-T7, §4.2 18)', () => {
  test('PT28_결제사 불일치(시도 토스, 본문 포트원)면 409 payment-attempt-mismatch이고 보안 로그 한 줄(계정·주문·pg_mismatch)이며 아무것도 바뀌지 않는다. 맞는 본문이면 202다', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[4]!]);
    const attemptId = await putAttempt(orderId, { pg: 'TOSS' });
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(f, orderId, portoneBody(orderId)), 409, 'payment-attempt-mismatch');

    expect(mismatchLines).toEqual([{ accountId: f.accountId, orderId, reason: 'pg_mismatch' }]);
    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });

  test('PT28_포트원 paymentId가 시도의 pg_order_ref와 다르면 409 payment-attempt-mismatch(payment_id_mismatch)이고 아무것도 바뀌지 않는다. 맞는 paymentId면 202다', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId } = await placeOrder(f, [w.r[5]!]);
    const attemptId = await putAttempt(orderId, { pg: 'PORTONE' });
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(f, orderId, { ...portoneBody(orderId), paymentId: `pay-${uuidv7(clock)}` }), 409, 'payment-attempt-mismatch');

    expect(mismatchLines).toEqual([{ accountId: f.accountId, orderId, reason: 'payment_id_mismatch' }]);
    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expectAccepted(await accept(f, orderId, portoneBody(orderId)));
  });

  test('PT28_활성 결제 시도가 없으면 409 payment-attempt-mismatch(no_attempt)이고, 시도를 넣은 뒤에는 202다', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.s[2]!]);

    expectProblem(await accept(f, orderId, tossBody(amount)), 409, 'payment-attempt-mismatch');
    expect(mismatchLines).toEqual([{ accountId: f.accountId, orderId, reason: 'no_attempt' }]);
    expect(await acceptIdemCount(f.accountId)).toBe(0);

    await putAttempt(orderId);
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });

  test('PT28_READY 시도가 만든 지 40분 [가정] 이상이면 409 payment-attempt-mismatch(attempt_expired)이고, 40분 − 1초면 202다(ADR-0107)', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.s[3]!]);
    const attemptId = await putAttempt(orderId, { createdAtMs: clock.now() - 40 * MIN });

    expectProblem(await accept(f, orderId, tossBody(amount)), 409, 'payment-attempt-mismatch');
    expect(mismatchLines).toEqual([{ accountId: f.accountId, orderId, reason: 'attempt_expired' }]);
    expect((await attemptRow(attemptId))?.status).toBe('READY');

    await q('update payment_attempt set created_at = $2 where id = $1', [attemptId, new Date(clock.now() - 40 * MIN + 1000)]);
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });

  test.each<[string, number]>([
    ['1원 많음', 1],
    ['1원 적음', -1],
  ])('PT7_토스 본문 amount가 주문 금액과 다르면(%s) 400(about:blank)이고 보안 로그 한 줄(계정·주문·amount_mismatch)을 남기며 아무것도 바뀌지 않고 응답에 금액이 없다. 맞는 금액이면 202다 [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-16.3.3]', async (_label, delta) => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[0]!, w.r[1]!]);
    const attemptId = await putAttempt(orderId);
    const before = await traceOf(f, orderId, attemptId);

    const r = await accept(f, orderId, tossBody(amount + delta));

    expect(r.statusCode, r.payload).toBe(400);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 400 });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.payload).not.toContain(String(amount + delta));
    expect(r.payload).not.toContain(String(amount));
    // 금액 변조도 보안 사건이라 한 줄을 남긴다(금액은 싣지 않는다, payment §2 '활성 결제 시도 대조', 2026-11-05 정본 바로잡음)
    expect(mismatchLines).toEqual([{ accountId: f.accountId, orderId, reason: 'amount_mismatch' }]);
    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });

  test('PT28_허용 밖 칸·빠진 칸·모르는 결제사·틀린 형이면 400이고 아무것도 바뀌지 않는다. 그 뒤 맞는 본문이면 202다(400이 본문 때문임을 본다) [ASVS v5.0.0-2.2.1]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.s[0]!, w.s[1]!]);
    const attemptId = await putAttempt(orderId);
    const before = await traceOf(f, orderId, attemptId);
    const toss = tossBody(amount);
    const bad: [string, unknown][] = [
      ['토스에 orderId 칸', { ...toss, orderId }],
      ['토스에 paymentType 칸', { ...toss, paymentType: 'NORMAL' }],
      ['토스에 포트원 칸', { ...toss, paymentToken: 'ptok_1' }],
      ['포트원에 amount 칸', { ...portoneBody(orderId), amount }],
      ['토스에 paymentKey 없음', { pg: 'TOSS', amount }],
      ['포트원에 txId 없음', { pg: 'PORTONE', paymentId: `pay-${orderId}`, paymentToken: 'ptok_1' }],
      ['모르는 결제사', { ...toss, pg: 'KAKAO' }],
      ['amount가 글', { ...toss, amount: String(amount) }],
      ['amount가 소수', { ...toss, amount: amount + 0.5 }],
      // 리뷰 고침 M1: 결제 참조 칸은 1~200자의 보이는 ASCII만(어댑터의 RangeError 500까지 가지 않는다)
      ['paymentKey 빈 글', { ...toss, paymentKey: '' }],
      ['paymentKey 201자', { ...toss, paymentKey: 'k'.repeat(201) }],
      ['paymentKey 공백', { ...toss, paymentKey: 'tgen key' }],
      ['paymentKey 제어 문자', { ...toss, paymentKey: 'tgen\u0001key' }],
      ['paymentKey 한글', { ...toss, paymentKey: 'tgen_결제키' }],
      ['포트원 txId 빈 글', { ...portoneBody(orderId), txId: '' }],
      ['포트원 paymentToken 빈 글', { ...portoneBody(orderId), paymentToken: '' }],
      ['포트원 paymentId 한글', { ...portoneBody(orderId), paymentId: '결제' }],
    ];
    for (const [label, body] of bad) {
      const r = await accept(f, orderId, body);
      expect(r.statusCode, `${label}: ${r.payload}`).toBe(400);
    }
    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expectAccepted(await accept(f, orderId, toss));
  });
});

// ───────────────────────────── 멱등 키(P-T45) ─────────────────────────────

describe('POST …/payment-acceptance 멱등 키(P-T45 ③)', () => {
  test('PT45_③_같은 키·같은 본문을 다시 보내면 같은 202이고 새 이력·Outbox·Saga 작업이 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[2]!]);
    const attemptId = await putAttempt(orderId);
    const body = tossBody(amount);
    const idemKey = randomUUID();
    expectAccepted(await accept(f, orderId, body, { idemKey }));
    const before = await traceOf(f, orderId, attemptId);

    expectAccepted(await accept(f, orderId, body, { idemKey }));

    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expect(before).toMatchObject({ history: 3, saga: 1, idem: 1 });
  });

  test('PT45_③_첫 접수 트랜잭션이 붙잡힌 채(결제 시도 행 잠금) 같은 키로 다시 보내면 1초 [가정] 기다린 뒤 409 idempotency-request-in-progress와 Retry-After이고, 첫 접수가 끝난 뒤 다시 보내면 처음 응답(202)이다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[3]!]);
    const attemptId = await putAttempt(orderId);
    const body = tossBody(amount);
    const idemKey = randomUUID();
    const lock = await lockAttempt(attemptId);
    let first: ReturnType<typeof tracked<Awaited<ReturnType<typeof accept>>>>;
    try {
      first = tracked(accept(f, orderId, body, { idemKey }));
      expect(await waitFor(async () => first.settled() || (await lockWaiters()) >= 1, 5_000)).toBe(true);
      expect(first.settled()).toBe(false);

      const second = await accept(f, orderId, body, { idemKey });

      expectProblem(second, 409, 'idempotency-request-in-progress');
      expect(second.headers['retry-after']).toBeDefined();
    } finally {
      await lock.release();
    }
    expectAccepted(await first!.p);
    expectAccepted(await accept(f, orderId, body, { idemKey }));
    expect(await sagaJobsOf(orderId)).toHaveLength(1);
    expect(await acceptIdemCount(f.accountId)).toBe(1);
  });

  test('같은 키로 다른 본문(다른 paymentKey)을 보내면 422 idempotency-key-reused다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[4]!]);
    const attemptId = await putAttempt(orderId);
    const idemKey = randomUUID();
    expectAccepted(await accept(f, orderId, tossBody(amount), { idemKey }));
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(f, orderId, tossBody(amount), { idemKey }), 422, 'idempotency-key-reused');

    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
  });
});

// ───────────────────────────── 자기 주문만(S-T29 ⑥) ─────────────────────────────

describe('POST …/payment-acceptance 자기 주문만(S-T29 ⑥)', () => {
  test('ST29_⑥_A가 B의 orderId·없는 orderId·UUID가 아닌 orderId로 접수하면 모두 같은 404 not-found이고 B의 주문·결제 시도는 그대로다. B 자신은 202다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await world();
    const a = await fan(w);
    const b = await fan(w);
    const { orderId, amount } = await placeOrder(b, [w.r[5]!]);
    const attemptId = await putAttempt(orderId);
    const before = await traceOf(b, orderId, attemptId);

    const others = await accept(a, orderId, tossBody(amount));
    const missing = await accept(a, uuidv7(clock), tossBody(amount));
    const malformed = await accept(a, 'not-a-uuid', tossBody(amount));

    for (const r of [others, missing, malformed]) expectProblem(r, 404, 'not-found');
    const shape = (r: { payload: string }) => {
      const { type, status, title } = json(r);
      return { type, status, title };
    };
    expect(shape(others)).toEqual(shape(missing));
    expect(shape(malformed)).toEqual(shape(missing));
    expect(await traceOf(b, orderId, attemptId)).toEqual(before);
    expect(await acceptIdemCount(a.accountId)).toBe(0);
    expect(mismatchLines).toEqual([]);
    expectAccepted(await accept(b, orderId, tossBody(amount)));
  });

  test('ST29_⑥_같은 계정이라도 주문을 만든 구매 세션이 아닌 다른 구매 세션(다른 탭·기기)에서 접수하면 404 not-found이고, 만든 구매 세션에서는 202다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.s[2]!]);
    const attemptId = await putAttempt(orderId);
    const other = await fan(w, f.accountId);
    expect(other.jti).not.toBe(f.jti);
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(other, orderId, tossBody(amount)), 404, 'not-found');

    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });
});

// ───────────────────────────── 회차 슬롯·상태 표 ─────────────────────────────

describe('POST …/payment-acceptance 회차 슬롯 읽기와 상태 표', () => {
  test('세대 키가 없으면(좌석 저장소 준비 안 됨) 503 seat-store-unavailable(Retry-After 2)이고 아무것도 바뀌지 않는다. 세대 키를 되돌리면 202다', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.s[3]!]);
    const attemptId = await putAttempt(orderId);
    const key = seatKeys.epoch(w.eventId);
    const saved = (await redis.command(['HGETALL', key], { key })) as unknown;
    const fields = Array.isArray(saved) ? saved.map(String) : Object.entries(saved as Record<string, string>).flat();
    expect(fields.length).toBeGreaterThan(0);
    await redis.command(['DEL', key], { key });
    const before = await traceOf(f, orderId, attemptId);

    const r = await accept(f, orderId, tossBody(amount));

    expectProblem(r, 503, 'seat-store-unavailable');
    expect(r.headers['retry-after']).toBe('2');
    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    await redis.command(['HSET', key, ...fields], { key });
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });

  test.each(['paused', 'allPaused', 'suspended'])("판매 정지 사본의 %s가 '1'이면 423 sale-paused이고 아무것도 바뀌지 않는다. '0'으로 되돌리면 202다", async (field) => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[0]!]);
    const attemptId = await putAttempt(orderId);
    const key = seatKeys.ctl(w.eventId);
    await redis.command(['HSET', key, field, '1'], { key });
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(f, orderId, tossBody(amount)), 423, 'sale-paused');

    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    await redis.command(['HSET', key, field, '0'], { key });
    expectAccepted(await accept(f, orderId, tossBody(amount)));
  });

  test('주문이 EXPIRED면(시험이 SQL로 만듦) 409 order-expired이고 시도는 READY 그대로, 멱등 기록·Saga 작업이 없다', async () => {
    const w = await world();
    const f = await fan(w);
    const { orderId, amount } = await placeOrder(f, [w.r[1]!]);
    const attemptId = await putAttempt(orderId);
    // 맞는 주문이면 접수 전 검사를 지난다는 것은 다른 시험이 본다. 여기서는 만료만 바꾼다
    await rawNoHistory(`update purchase_order set status = 'EXPIRED', event_seq = event_seq + 1 where id = $1`, [orderId]);
    const before = await traceOf(f, orderId, attemptId);

    expectProblem(await accept(f, orderId, tossBody(amount)), 409, 'order-expired');

    expect(await traceOf(f, orderId, attemptId)).toEqual(before);
    expect(before).toMatchObject({ order: { status: 'EXPIRED' }, attempt: { status: 'READY' }, saga: 0, idem: 0 });
    expect(mismatchLines).toEqual([]);
  });
});
