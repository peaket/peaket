// 주문 생성 POST /v1/orders를 앱째로 돈다: 실제 PostgreSQL 18·실제 Valkey 8.1, identity-svc는 루프백의 가짜 gRPC 서버(BUILD_ORDER PRF-161).
// 정본: docs/features/payment.md §2 '주문 생성의 첫 구현'·'예매 제한 확인'·'판매 종료'·'주문 생성 사건의 조사용 칸', 시험 표 P-T35·P-T37·P-T45·P-T49·P-T52,
// docs/data.md purchase_order(hold_id·purchase_session_id)·§3 s:rst·§5 '주문 생성', docs/features/seat-hold.md §2·§3, openapi POST /v1/orders.
//
// 약속:
// - 앱 조립은 booking.module.ts·main.ts '주문 생성의 조립 자리' 주석대로 한다: AppModule.register({ redis, …, booking })에 DrizzleOrderWrites·RedisOrderHolds·
//   SeatMapSaleConfigs·InventoryOrderSessions·GrpcIdentityRecheck·GrpcContactRefs·RedisBookingRestrictions와 기록용 지표·로그 대역을 넘긴다.
// - 구매 세션은 입장 토큰을 서명해 실제 열기 유스케이스(OpenPurchaseSession, Valkey 저장소)로 열고, 홀드는 실제 홀드 경로(POST /v1/events/{eventId}/holds)로 잡는다
//   (test/purchase-session-http.test.ts와 같은 서명·요청 인증 꼴).
// - 앱 시계는 가짜 시계다. 홀드 Lua·홀드 확인 Lua는 Redis TIME을 쓰므로 가짜 시계를 Valkey 시계(시험 프로세스 시계 + 잰 차이)에서 시작한다.
// - 회차·계정·좌석 ID는 시험마다 새 UUID다(주문 표의 uuid 칸). 표·Valkey를 비우지 않는다.
// - 판매 종료 시험은 그 회차의 좌석맵 판을 바꿔 넣어 saleEndsAt을 옮긴다.
import 'reflect-metadata';
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { identityV1Identity } from '@peaket/contracts/proto';
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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  bookingRestrictionKey,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  type FallbackReason,
  GrpcContactRefs,
  GrpcIdentityRecheck,
  InventoryOrderSessions,
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
  RedisSeatStore,
  ServerEcdhKey,
  StoredPurchaseSessions,
  seatKeys,
  sessionKeys,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from '../test/admission-fixtures.js';
import { clientKeyOf } from '../test/session-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
/** 지금 동의 문안 판(PEAKET_ORDER_CONSENT_VERSION 자리) */
const CONSENT = 'consent-2026.11_v1';
/** 등급 가격(원). 판 파일 tierPrices 자리 */
const PRICES = { R: 99_000, S: 132_000 } as const;
/** 회차 좌석 수: 구역 A(등급 R) 색인 0~5, 구역 B(등급 S) 색인 6~9 */
const SEAT_COUNT = 10;
const PHONE_RAW = '010-1234-5678';
const PHONE_E164 = '+821012345678';
/** Outbox·로그에 번호 원문이 있는지 볼 때 찾는 조각(어느 표기든 이 숫자열을 담는다) */
const PHONE_DIGITS = '1012345678';

// ───────────────────────────── 가짜 identity-svc(gRPC) ─────────────────────────────

interface Step {
  delayMs?: number;
  code?: grpc.status;
  reply?: Record<string, unknown>;
}
/** 계정 → 재확인 답(없으면 verified 참과 그 팬의 pid) */
const identityPlan = new Map<string, Step>();
/** 계정 → pid(가짜 identity가 재확인에 돌려주는 값) */
const pidOf = new Map<string, string>();
const recheckCalls: Record<string, unknown>[] = [];
const contactCalls: Record<string, unknown>[] = [];
/** 가명 답을 바꿀 때(없으면 contactRefOf 값을 바로 답한다) */
let contactPlan: Step | undefined;
/** 가짜 invRef("contact", 번호): 같은 E.164 번호면 같은 값 */
const contactRefOf = (e164: string) => `k1.${createHash('sha256').update(`contact:${e164}`).digest('base64url').slice(0, 22)}`;

function answer(step: Step, callback: grpc.sendUnaryData<Record<string, unknown>>) {
  const go = () =>
    step.code !== undefined
      ? callback({ code: step.code, details: 'fake', metadata: new grpc.Metadata(), name: 'Error', message: 'fake' } as grpc.ServiceError)
      : callback(null, step.reply ?? {});
  if (step.delayMs) setTimeout(go, step.delayMs);
  else go();
}

async function startFakeIdentity(): Promise<{ server: grpc.Server; address: string }> {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const v1 = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  const server = new grpc.Server();
  server.addService(v1.IdentityService!.service, {
    GetVerificationStatus: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<Record<string, unknown>>) => {
      recheckCalls.push({ ...call.request });
      const account = String(call.request.account_id);
      answer(identityPlan.get(account) ?? { reply: { verified: true, pid: pidOf.get(account) ?? '', previous_pid: '' } }, cb);
    },
  });
  server.addService(v1.ContactRefService!.service, {
    ComputeContactRef: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<Record<string, unknown>>) => {
      contactCalls.push({ ...call.request });
      answer(contactPlan ?? { reply: { contact_ref: contactRefOf(String(call.request.phone_e164)) } }, cb);
    },
  });
  const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return { server, address: `127.0.0.1:${port}` };
}

// ───────────────────────────── 앱 ─────────────────────────────

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let identity: { server: grpc.Server; address: string } | undefined;
let redis: HotRedis;
let database: Database;
let admin: Database;
let recheck: GrpcIdentityRecheck | undefined;
let contactRefs: GrpcContactRefs | undefined;
let svc: Awaited<ReturnType<typeof createService>> | undefined;

const logs: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    logs.push(String(c));
    cb();
  },
});
/** 앱 시계(beforeAll에서 Valkey 시계로 맞춘다) */
let clock: ReturnType<typeof fakeClock>;
const seatMap = new MemorySeatMap();
const admissionKey = newKey('k1');
const serverPriv = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-1' });
})();
const serverPub = createPublicKey({ key: serverPriv.publicJwk(), format: 'jwk' });

/** 지표·로그 대역(쓰임새가 부른 것을 적는다) */
const fallbacks: FallbackReason[] = [];
const fallbackLines: Parameters<OrderLog['identityFallback']>[0][] = [];
const configLines: Parameters<OrderLog['configError']>[0][] = [];
const payingFailedLines: Parameters<OrderLog['payingMarkFailed']>[0][] = [];
const signals: OrderSignals = { historyMismatch: () => {}, identityFallback: (r) => void fallbacks.push(r) };
const orderLog: OrderLog = {
  identityFallback: (e) => void fallbackLines.push(e),
  configError: (e) => void configLines.push(e),
  payingMarkFailed: (e) => void payingFailedLines.push(e),
};

let opener: OpenPurchaseSession;

beforeAll(async () => {
  const [p, v, i] = await Promise.allSettled([startPostgres(), startValkey(), startFakeIdentity()]);
  if (p.status === 'fulfilled') pgServer = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  if (i.status === 'fulfilled') identity = i.value;
  for (const r of [p, v, i]) if (r.status === 'rejected') throw r.reason as Error;

  redis = await createHotRedis({ url: valkey!.url });
  // Valkey 시계 − 시험 프로세스 시계(purchase-session.int.test.ts와 같은 잼)
  const samples: number[] = [];
  for (let k = 0; k < 5; k += 1) {
    const before = Date.now();
    const t = (await redis.command(['TIME'], {})) as unknown[];
    samples.push(Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000) - Math.round((before + Date.now()) / 2));
  }
  clock = fakeClock({ now: Date.now() + samples.sort((a, b) => a - b)[2]! });

  await migratePurchase(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 10, applicationName: 'orders-e2e' });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'orders-e2e-admin' });
  await ensureOutboxPartitions(admin, clock);

  const sessionStore = new RedisPurchaseSessionStore(redis);
  const sessions = new StoredPurchaseSessions({ store: sessionStore, ecdh: serverPriv, clock });
  const startedLog = new RecordingSessionStartedLog();
  const keys = new Map([['k1', admissionKey.pub]]);
  opener = new OpenPurchaseSession({ store: sessionStore, log: startedLog, keys, issuer: ISS, clock });
  recheck = new GrpcIdentityRecheck({ address: identity!.address });
  contactRefs = new GrpcContactRefs({ address: identity!.address });

  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      redis,
      seatMap,
      attempts: new RecordingHoldAttempts(),
      podId: 'pod-orders-e2e',
      sessions,
      admission: { store: sessionStore, startedLog, keys, issuer: ISS },
      booking: {
        writes: new DrizzleOrderWrites({ database, store: new DrizzleOrderStore({ clock }), clock }),
        holds: new RedisOrderHolds(redis, seatMap),
        saleConfigs: new SeatMapSaleConfigs(seatMap),
        sessions: new InventoryOrderSessions({ sessions, store: sessionStore }),
        identity: recheck,
        contactRefs,
        restrictions: new RedisBookingRestrictions(redis),
        signals,
        log: orderLog,
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
  try {
    recheck?.close();
    contactRefs?.close();
  } catch {
    // 뼈대(미구현)에서는 close도 던진다
  }
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  if (identity) await new Promise<void>((r) => identity!.server.tryShutdown(() => r()));
  valkey?.stop();
  pgServer?.stop();
});

beforeEach(() => {
  fallbacks.length = 0;
  fallbackLines.length = 0;
  configLines.length = 0;
  payingFailedLines.length = 0;
  recheckCalls.length = 0;
  contactCalls.length = 0;
  contactPlan = undefined;
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);
const ordersOf = (accountId: string) => count('select count(*) as n from purchase_order where account_id = $1', [accountId]);
const idemCount = (accountId: string) => count('select count(*) as n from order_idempotency where account_ref = $1', [accountId]);
async function outboxOf(eventId: string): Promise<{ raw: string; event: Record<string, unknown> }[]> {
  const rows = await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]);
  return rows.map((r) => {
    const raw = Buffer.from(r.payload).toString('utf8');
    return { raw, event: JSON.parse(raw) as Record<string, unknown> };
  });
}

interface World {
  eventId: string;
  config: EventSeatConfig;
  /** 등급 R 좌석 6개(색인 0~5), 등급 S 좌석 4개(색인 6~9). 좌석 ID는 새 UUID */
  r: string[];
  s: string[];
  indexOf: Map<string, number>;
}

/** 회차 하나: 좌석맵 판(UUID 좌석, tierPrices)을 넣고 좌석 Redis 판매를 연다 */
async function world(o: { tierPrices?: Record<string, number> } = {}): Promise<World> {
  const eventId = randomUUID();
  const r = Array.from({ length: 6 }, () => randomUUID()).sort();
  const s = Array.from({ length: 4 }, () => randomUUID()).sort();
  const defs: MemorySeatDef[] = [
    ...r.map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' })),
    ...s.map((seatId, i) => ({ seatId, index: 6 + i, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: i, tierId: 'S' })),
  ];
  const config: EventSeatConfig = { eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: clock.now() + DAY, tierPrices: o.tierPrices ?? { ...PRICES } };
  seatMap.put(config, defs);
  await new RedisSeatStore(redis).openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  return { eventId, config, r, s, indexOf: new Map(defs.map((d) => [d.seatId, d.index])) };
}

/** 그 회차의 좌석맵 판 설정만 바꿔 다시 넣는다(좌석은 그대로) */
function reconfigure(w: World, change: Partial<EventSeatConfig>) {
  const defs: MemorySeatDef[] = [
    ...w.r.map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' })),
    ...w.s.map((seatId, i) => ({ seatId, index: 6 + i, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: i, tierId: 'S' })),
  ];
  w.config = { ...w.config, ...change };
  seatMap.put(w.config, defs);
}

interface Fan {
  eventId: string;
  accountId: string;
  login: string;
  pid: string;
  jti: string;
  jny: string;
  token: string;
  macKey: Buffer;
  seq: number;
}

/** 그 회차에 입장 토큰으로 구매 세션을 연 팬(계정·로그인 세션·pid·여정 ID는 새 값) */
async function fan(w: World): Promise<Fan> {
  const jti = randomUUID();
  const accountId = randomUUID();
  const login = randomUUID();
  const jny = uuidv7(clock);
  const pid = `pid-${randomUUID()}`;
  pidOf.set(accountId, pid);
  const token = signAdmission(admissionKey, claimsOf({ nowMs: clock.now(), jti, accountId, loginSessionId: login, eventId: w.eventId }, { jny }));
  const client = clientKeyOf();
  await opener.execute({ token, accountId, loginSessionId: login, eventId: w.eventId, clientKey: client.text });
  const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), jti));
  return { eventId: w.eventId, accountId, login, pid, jti, jny, token, macKey, seq: 0 };
}

/** 서명한 구매 요청(게이트웨이가 넘기는 신원 머리 + 멱등 키 + 구매 요청 서명) */
function signed(f: Fan, url: string, body: unknown, o: { idemKey?: string; pid?: string | null; scope?: string } = {}) {
  const payload = JSON.stringify(body);
  const n = ++f.seq;
  const headers: Record<string, string> = {
    'x-user-id': f.accountId,
    'x-session-id': f.login,
    'x-user-aud': 'fan',
    'x-user-scope': o.scope ?? 'ticket:buy',
    'content-type': 'application/json',
    'idempotency-key': o.idemKey ?? randomUUID(),
    'x-purchase-seq': String(n),
    'x-purchase-mac': purchaseMac(f.macKey, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8'))),
    'x-admission-token': f.token,
  };
  const pid = o.pid === undefined ? f.pid : o.pid;
  if (pid !== null) headers['x-user-pid'] = pid;
  return svc!.http.inject({ method: 'POST', url, headers, payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

/** 실제 홀드 경로로 좌석을 잡고 holdId를 돌려준다 */
async function hold(f: Fan, seatIds: string[]): Promise<string> {
  const r = await signed(f, `/v1/events/${f.eventId}/holds`, { seatIds });
  expect(r.statusCode, r.payload).toBe(201);
  return String(json(r).holdId);
}
/** 그 좌석의 홀드 Hash heldAt(Redis TIME으로 잡은 시각) */
async function heldAtOf(w: World, seatId: string): Promise<number> {
  const key = seatKeys.hold(w.eventId, w.indexOf.get(seatId)!);
  return Number(await redis.command(['HGET', key, 'heldAt'], { key }));
}

const orderBody = (holdId: string, o: { phone?: string; name?: string; consents?: unknown } = {}) => ({
  holdId,
  buyer: { name: o.name ?? '김피켓', phone: o.phone ?? PHONE_RAW },
  ...(o.consents === null ? {} : { consents: o.consents ?? { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } }),
});
const order = (f: Fan, body: unknown, o: { idemKey?: string; pid?: string | null; scope?: string } = {}) => signed(f, '/v1/orders', body, o);

/** 문제 상세 응답(이름 있는 type) */
function expectProblem(r: { statusCode: number; payload: string; headers: Record<string, unknown> }, status: number, slug: string) {
  expect(r.statusCode, r.payload).toBe(status);
  expect(json(r)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}${slug}`, status });
  expect(r.headers['cache-control']).toBe('no-store');
}

const payField = async (jti: string) => {
  const key = sessionKeys.session(jti);
  const v = await redis.command(['HGET', key, 'pay'], { key });
  return v === null || v === undefined ? undefined : String(v);
};

// ───────────────────────────── 201 ─────────────────────────────

describe('POST /v1/orders 201', () => {
  test('201 Order(금액 = 등급 가격 합, 항목은 좌석 ID 차례)이고 주문 행(buyer_phone E.164, hold_id, purchase_session_id = jti)·항목·이력 1·Outbox CREATED(journeyId·contactRef)·멱등 기록을 쓰며, 커밋 뒤 구매 세션 pay 칸이 1이다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.2.1]', async () => {
    const w = await world();
    const f = await fan(w);
    const seats = [w.s[0]!, w.r[0]!];
    const holdId = await hold(f, seats);
    const idemKey = randomUUID();

    const r = await order(f, orderBody(holdId), { idemKey });

    expect(r.statusCode, r.payload).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = json(r);
    const sorted = [...seats].sort();
    const tierOf = (id: string) => (w.r.includes(id) ? { tierId: 'R', sectionId: 'SEC-A', price: PRICES.R } : { tierId: 'S', sectionId: 'SEC-B', price: PRICES.S });
    expect(body).toEqual({ orderId: expect.any(String), amount: PRICES.R + PRICES.S, status: 'CREATED', items: sorted.map((seatId) => ({ seatId, ...tierOf(seatId) })) });
    const orderId = String(body.orderId);

    const [row] = await q<Record<string, unknown>>(
      'select account_id, event_id, status, amount, buyer_name, buyer_phone, idempotency_key, consent_version, seat_assignment, hold_id, purchase_session_id from purchase_order where id = $1',
      [orderId],
    );
    expect(row).toEqual({
      account_id: f.accountId,
      event_id: w.eventId,
      status: 'CREATED',
      amount: PRICES.R + PRICES.S,
      buyer_name: '김피켓',
      buyer_phone: PHONE_E164,
      idempotency_key: idemKey,
      consent_version: CONSENT,
      seat_assignment: 'PICK',
      hold_id: holdId,
      purchase_session_id: f.jti,
    });
    expect(await q('select line_no, seat_id, tier, section_id, unit_price from order_item where order_id = $1 order by line_no', [orderId])).toEqual(
      sorted.map((seatId, i) => ({ line_no: i + 1, seat_id: seatId, tier: tierOf(seatId).tierId, section_id: tierOf(seatId).sectionId, unit_price: tierOf(seatId).price })),
    );
    expect(await q('select seq, from_status, to_status, cause, actor from order_event where order_id = $1', [orderId])).toEqual([
      { seq: 1, from_status: null, to_status: 'CREATED', cause: 'T1', actor: `account:${f.accountId}` },
    ]);
    const outbox = await outboxOf(w.eventId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.event).toMatchObject({
      type: 'CREATED',
      orderId,
      eventId: w.eventId,
      accountId: f.accountId,
      amount: PRICES.R + PRICES.S,
      purchaseSessionId: f.jti,
      journeyId: f.jny,
      contactRef: contactRefOf(PHONE_E164),
      refMissing: false,
      seatAssignment: 'PICK',
    });
    expect(OrderEvent.safeParse(outbox[0]!.event).error?.issues ?? []).toEqual([]);
    expect(await q('select result_ref from order_idempotency where account_ref = $1 and operation = $2 and idempotency_key = $3', [f.accountId, 'CREATE_ORDER', idemKey])).toEqual([
      { result_ref: orderId },
    ]);
    // 커밋 뒤 Paying 표시(POL-009: 결제가 끝날 때까지 유휴로 끝나지 않게)
    expect(await payField(f.jti)).toBe('1');
    // 재확인은 그 계정·로그인 세션으로, 가명은 E.164 번호로 한 번씩
    expect(recheckCalls).toEqual([expect.objectContaining({ account_id: f.accountId, session_id: f.login })]);
    expect(contactCalls).toEqual([{ phone_e164: PHONE_E164 }]);
  });

  test('PT52_①_예매자 번호를 010-1234-5678과 +82 10-1234-5678로 넣은 두 주문의 CREATED contactRef가 같고, journeyId는 각 구매 세션 입장 토큰의 jny이며, Outbox 값과 서비스 로그에 번호 원문이 없다 [ASVS v5.0.0-14.2.4]', async () => {
    const w = await world();
    const a = await fan(w);
    const b = await fan(w);
    const ra = await order(a, orderBody(await hold(a, [w.r[1]!]), { phone: '010-1234-5678' }));
    const rb = await order(b, orderBody(await hold(b, [w.r[2]!]), { phone: '+82 10-1234-5678' }));
    expect(ra.statusCode, ra.payload).toBe(201);
    expect(rb.statusCode, rb.payload).toBe(201);

    const outbox = await outboxOf(w.eventId);
    expect(outbox).toHaveLength(2);
    const byOrder = new Map(outbox.map((x) => [String(x.event.orderId), x]));
    const ea = byOrder.get(String(json(ra).orderId))!.event;
    const eb = byOrder.get(String(json(rb).orderId))!.event;
    expect(ea.contactRef).toBe(eb.contactRef);
    expect(ea.contactRef).toBe(contactRefOf(PHONE_E164));
    expect(ea.journeyId).toBe(a.jny);
    expect(eb.journeyId).toBe(b.jny);
    for (const x of outbox) expect(x.raw).not.toContain(PHONE_DIGITS);
    expect(logs.filter((l) => l.includes(PHONE_DIGITS))).toEqual([]);
    expect(contactCalls).toEqual([{ phone_e164: PHONE_E164 }, { phone_e164: PHONE_E164 }]);
  });

  test.each<[string, Step]>([
    ['50ms를 넘겨 답함', { delayMs: 400, reply: { contact_ref: 'k1.late' } }],
    ['RESOURCE_EXHAUSTED(요청 상한)', { code: grpc.status.RESOURCE_EXHAUSTED }],
  ])('PT52_가명을 받지 못하면(%s) 주문을 막지 않고 201이며 CREATED 사건은 contactRef 없이 refMissing 참이다', async (_label, step) => {
    contactPlan = step;
    const w = await world();
    const f = await fan(w);
    const r = await order(f, orderBody(await hold(f, [w.r[3]!])));
    expect(r.statusCode, r.payload).toBe(201);
    const [x] = await outboxOf(w.eventId);
    expect(x!.event).toMatchObject({ refMissing: true, journeyId: f.jny });
    expect(x!.event).not.toHaveProperty('contactRef');
    expect(x!.raw).not.toContain(PHONE_DIGITS);
  });
});

// ───────────────────────────── 멱등 키(P-T45) ─────────────────────────────

describe('POST /v1/orders 멱등 키(P-T45)', () => {
  test('PT45_①_같은 키·같은 본문으로 두 번 보내면 두 번째도 같은 201·같은 주문 ID이고 주문·Outbox는 하나다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const body = orderBody(await hold(f, [w.r[0]!]));
    const idemKey = randomUUID();

    const first = await order(f, body, { idemKey });
    const second = await order(f, body, { idemKey });

    expect(first.statusCode, first.payload).toBe(201);
    expect(second.statusCode, second.payload).toBe(201);
    expect(json(second)).toEqual(json(first));
    expect(await ordersOf(f.accountId)).toBe(1);
    expect(await outboxOf(w.eventId)).toHaveLength(1);
  });

  test('PT45_①_처음 201 뒤 홀드가 끝나도(홀드 Hash를 지움) 같은 키·같은 본문은 같은 201이다(커밋된 기록 읽기가 홀드 확인보다 먼저다) [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const seat = w.r[1]!;
    const body = orderBody(await hold(f, [seat]));
    const idemKey = randomUUID();
    const first = await order(f, body, { idemKey });
    expect(first.statusCode, first.payload).toBe(201);
    const key = seatKeys.hold(w.eventId, w.indexOf.get(seat)!);
    await redis.command(['DEL', key], { key });

    const again = await order(f, body, { idemKey });

    expect(again.statusCode, again.payload).toBe(201);
    expect(json(again)).toEqual(json(first));
  });

  test('PT45_②_같은 키로 다른 holdId의 주문을 보내면 422 idempotency-key-reused이고 새 주문이 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const idemKey = randomUUID();
    expect((await order(f, orderBody(await hold(f, [w.r[2]!])), { idemKey })).statusCode).toBe(201);
    const otherHold = await hold(f, [w.r[3]!]);

    const r = await order(f, orderBody(otherHold), { idemKey });

    expectProblem(r, 422, 'idempotency-key-reused');
    expect(await ordersOf(f.accountId)).toBe(1);
    expect(await count('select count(*) as n from purchase_order where hold_id = $1', [otherHold])).toBe(0);
  });

  test('PT45_④_다른 계정이 같은 키로 주문을 만들면 따로 처리된다(둘 다 201, 서로 다른 주문) [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const a = await fan(w);
    const b = await fan(w);
    const idemKey = randomUUID();
    const ra = await order(a, orderBody(await hold(a, [w.r[4]!])), { idemKey });
    const rb = await order(b, orderBody(await hold(b, [w.r[5]!])), { idemKey });
    expect(ra.statusCode, ra.payload).toBe(201);
    expect(rb.statusCode, rb.payload).toBe(201);
    expect(json(ra).orderId).not.toBe(json(rb).orderId);
    expect(await ordersOf(a.accountId)).toBe(1);
    expect(await ordersOf(b.accountId)).toBe(1);
  });
});

// ───────────────────────────── 홀드·판매 종료 ─────────────────────────────

describe('POST /v1/orders 홀드 확인과 판매 종료', () => {
  test('같은 홀드로 다른 멱등 키의 주문을 또 보내면 409 hold-already-ordered이고 주문은 하나다 [ASVS v5.0.0-2.3.4]', async () => {
    const w = await world();
    const f = await fan(w);
    const holdId = await hold(f, [w.s[1]!]);
    expect((await order(f, orderBody(holdId))).statusCode).toBe(201);

    const r = await order(f, orderBody(holdId));

    expectProblem(r, 409, 'hold-already-ordered');
    expect(await count('select count(*) as n from purchase_order where hold_id = $1', [holdId])).toBe(1);
  });

  test('ST28_없는 holdId·남의 holdId는 같은 404 not-found이고 주문이 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await world();
    const a = await fan(w);
    const b = await fan(w);
    const others = await hold(b, [w.s[2]!]);

    expectProblem(await order(a, orderBody(uuidv7(clock))), 404, 'not-found');
    expectProblem(await order(a, orderBody(others)), 404, 'not-found');
    expect(await ordersOf(a.accountId)).toBe(0);
    expect(await ordersOf(b.accountId)).toBe(0);
  });

  test('PT37_③_판매 종료 뒤, 판매 종료 전에 잡지 않은 홀드(heldAt ≥ saleEndsAt)는 410 sale-ended이고 주문이 없다. 없는 holdId도 404가 아니라 410이다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const f = await fan(w);
    const seat = w.s[3]!;
    const holdId = await hold(f, [seat]);
    const heldAt = await heldAtOf(w, seat);
    // 판매 종료를 그 홀드를 잡은 시각(과 지금 가운데 이른 쪽)으로 옮긴다: 지금 ≥ 판매 종료이고 heldAt ≥ 판매 종료다
    reconfigure(w, { saleEndsAtMs: Math.min(heldAt, clock.now()) });

    expectProblem(await order(f, orderBody(holdId)), 410, 'sale-ended');
    expectProblem(await order(f, orderBody(uuidv7(clock))), 410, 'sale-ended');
    expect(await ordersOf(f.accountId)).toBe(0);
  });

  test('PT37_①_판매 종료 뒤라도 판매 종료 전에 잡은 유효한 홀드(heldAt < saleEndsAt)의 주문은 201이다', async () => {
    const w = await world();
    const f = await fan(w);
    const seat = w.r[0]!;
    const holdId = await hold(f, [seat]);
    const heldAt = await heldAtOf(w, seat);
    reconfigure(w, { saleEndsAtMs: heldAt + 1 });
    if (clock.now() < heldAt + 1) clock.advance(heldAt + 1 - clock.now());

    const r = await order(f, orderBody(holdId));

    expect(r.statusCode, r.payload).toBe(201);
  });

  test('가격이 없는 등급의 좌석이면 500(이름 없는 오류)이고 주문을 만들지 않으며 설정 오류 로그(tier_price_missing, 등급 S)를 남긴다', async () => {
    const w = await world({ tierPrices: { R: PRICES.R } });
    const f = await fan(w);
    const r = await order(f, orderBody(await hold(f, [w.r[1]!, w.s[0]!])));
    expect(r.statusCode, r.payload).toBe(500);
    expect(json(r)).toMatchObject({ type: 'about:blank', status: 500 });
    expect(r.payload).not.toContain('"S"');
    expect(await ordersOf(f.accountId)).toBe(0);
    expect(configLines).toEqual([{ what: 'tier_price_missing', eventId: w.eventId, tierId: 'S' }]);
  });
});

// ───────────────────────────── 동의·예매자 ─────────────────────────────

describe('POST /v1/orders 동의·예매자', () => {
  test.each<[string, unknown]>([
    ['동의가 없음', null],
    ['판매자 제공 동의가 거짓', { provisionToSeller: false, salesTerms: true, consentVersion: CONSENT }],
    ['판매 약관 동의가 빠짐', { provisionToSeller: true, consentVersion: CONSENT }],
    ['문안 판이 빠짐', { provisionToSeller: true, salesTerms: true }],
  ])('%s이면 422 consent-required이고 주문이 없다', async (_label, consents) => {
    const w = await world();
    const f = await fan(w);
    expectProblem(await order(f, orderBody(await hold(f, [w.r[2]!]), { consents })), 422, 'consent-required');
    expect(await ordersOf(f.accountId)).toBe(0);
  });

  test('문안 판이 지금 판과 다르면 422 consent-version-outdated다', async () => {
    const w = await world();
    const f = await fan(w);
    const r = await order(f, orderBody(await hold(f, [w.r[3]!]), { consents: { provisionToSeller: true, salesTerms: true, consentVersion: 'consent-2026.10_v9' } }));
    expectProblem(r, 422, 'consent-version-outdated');
    expect(await ordersOf(f.accountId)).toBe(0);
  });

  test.each<[string, { name?: string; phone?: string }]>([
    ['번호를 E.164로 맞출 수 없음', { phone: 'abc-defg' }],
    ['번호가 1로 시작(국내·국제 표기가 아님)', { phone: '1012345678' }],
    ['성명 101자', { name: '가'.repeat(101) }],
    ['성명 빈 글', { name: '' }],
  ])('예매자가 틀리면(%s) 400이고 주문이 없다 [ASVS v5.0.0-2.2.1]', async (_label, buyer) => {
    const w = await world();
    const f = await fan(w);
    const r = await order(f, orderBody(await hold(f, [w.r[4]!]), buyer));
    expect(r.statusCode, r.payload).toBe(400);
    expect(await ordersOf(f.accountId)).toBe(0);
    expect(r.payload).not.toContain(PHONE_DIGITS);
  });
});

// ───────────────────────────── 본인확인 재확인(P-T35 일부) ─────────────────────────────

describe('POST /v1/orders 본인확인 재확인(P-T35 일부)', () => {
  test("PT35_identity가 '무효'(verified 거짓)로 답하면 403 identity-verification-required이고 주문이 없으며 대체 판정을 세지 않는다", async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { reply: { verified: false, pid: '', previous_pid: '' } });
    const r = await order(f, orderBody(await hold(f, [w.s[0]!])));
    expectProblem(r, 403, 'identity-verification-required');
    expect(await ordersOf(f.accountId)).toBe(0);
    expect(fallbacks).toEqual([]);
  });

  test('PT35_재확인의 pid가 토큰 pid와 다르면(previous_pid와도 다름) 403이다', async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { reply: { verified: true, pid: 'pid-someone-else', previous_pid: 'pid-older' } });
    expectProblem(await order(f, orderBody(await hold(f, [w.s[1]!]))), 403, 'identity-verification-required');
    expect(await ordersOf(f.accountId)).toBe(0);
  });

  test('PT35_pid 키 전환 중 토큰 pid가 previous_pid와 같으면 통과한다(201)', async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { reply: { verified: true, pid: 'pid-rotated', previous_pid: f.pid } });
    const r = await order(f, orderBody(await hold(f, [w.s[2]!])));
    expect(r.statusCode, r.payload).toBe(201);
  });

  test('PT35_identity가 데드라인 안에 답하지 않으면 토큰 판정: ticket:buy와 pid가 모두 있으면 201이고 대체 판정 지표(deadline)·보안 로그(계정·까닭·통과·멱등 키) 한 번씩이다', async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { delayMs: 600, reply: { verified: true, pid: f.pid } });
    const idemKey = randomUUID();
    const r = await order(f, orderBody(await hold(f, [w.r[5]!])), { idemKey });
    expect(r.statusCode, r.payload).toBe(201);
    expect(fallbacks).toEqual(['deadline']);
    expect(fallbackLines).toEqual([{ accountId: f.accountId, reason: 'deadline', passed: true, idempotencyKey: idemKey }]);
  });

  test('PT35_identity가 답하지 않을 때 토큰에 pid가 없으면 403이고, 대체 판정(거부)도 지표·로그를 남긴다', async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { delayMs: 600, reply: { verified: true, pid: f.pid } });
    const idemKey = randomUUID();
    const r = await order(f, orderBody(await hold(f, [w.s[3]!])), { idemKey, pid: null });
    expectProblem(r, 403, 'identity-verification-required');
    expect(await ordersOf(f.accountId)).toBe(0);
    expect(fallbacks).toEqual(['deadline']);
    expect(fallbackLines).toEqual([{ accountId: f.accountId, reason: 'deadline', passed: false, idempotencyKey: idemKey }]);
  });

  test('PT35_identity가 PERMISSION_DENIED(호출 신원이 허용 목록 밖)면 대체 판정 없이 503 dependency-unavailable이고 설정 오류 로그를 남긴다', async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { code: grpc.status.PERMISSION_DENIED });
    const r = await order(f, orderBody(await hold(f, [w.r[0]!])));
    expectProblem(r, 503, 'dependency-unavailable');
    expect(await ordersOf(f.accountId)).toBe(0);
    expect(fallbacks).toEqual([]);
    expect(configLines).toEqual([{ what: 'identity_misconfigured', reason: 'permission_denied' }]);
  });

  // 리뷰 고침 M2(2026-11-05): 정본 목록 밖의 gRPC 코드는 대체 판정 없이 503(설정 오류)
  test.each<[string, grpc.status]>([
    ['UNIMPLEMENTED', grpc.status.UNIMPLEMENTED],
    ['UNAUTHENTICATED', grpc.status.UNAUTHENTICATED],
  ])('PT35_ASVS16.5.3_identity가 %s(정본 목록 밖)로 답하면 토큰이 있어도 대체 판정 없이 503 dependency-unavailable이고 설정 오류 로그(unexpected)를 남긴다 [ASVS v5.0.0-16.5.3]', async (_label, code) => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { code });
    const r = await order(f, orderBody(await hold(f, [w.r[1]!])));
    expectProblem(r, 503, 'dependency-unavailable');
    expect(await ordersOf(f.accountId)).toBe(0);
    expect(fallbacks).toEqual([]);
    expect(configLines).toEqual([{ what: 'identity_misconfigured', reason: 'unexpected' }]);
  });

  // 리뷰 고침 M4(2026-11-05): 재확인이 데드라인 안에 답하지 않았으면 같은 identity-svc의 가명 호출도 건너뛴다
  test('PT52_identity가 재확인에 데드라인 안에 답하지 않으면(대체 판정 통과) ComputeContactRef를 부르지 않고 CREATED 사건은 contactRef 없이 refMissing 참이다', async () => {
    const w = await world();
    const f = await fan(w);
    identityPlan.set(f.accountId, { delayMs: 600, reply: { verified: true, pid: f.pid } });
    const r = await order(f, orderBody(await hold(f, [w.s[2]!])));
    expect(r.statusCode, r.payload).toBe(201);
    expect(contactCalls).toEqual([]);
    const [x] = await outboxOf(w.eventId);
    expect(x!.event).toMatchObject({ refMissing: true, journeyId: f.jny });
    expect(x!.event).not.toHaveProperty('contactRef');
  });
});

// ───────────────────────────── 예매 제한(P-T49 ①) ─────────────────────────────

describe('POST /v1/orders 예매 제한(P-T49 ①)', () => {
  const restrict = async (accountId: string, fields: Record<string, string>) => {
    const key = bookingRestrictionKey(accountId);
    await redis.command(['HSET', key, ...Object.entries(fields).flat()], { key });
  };

  test('PT49_①_s:rst가 ACTIVE(끝 없음)이면 403 booking-restricted이고 주문 행·멱등 기록이 0건이다(홀드 풀기는 HOT-070이라 여기서 보지 않는다)', async () => {
    const w = await world();
    const f = await fan(w);
    const holdId = await hold(f, [w.r[1]!, w.r[2]!]);
    await restrict(f.accountId, { st: 'ACTIVE', rid: randomUUID(), ver: '1' });

    expectProblem(await order(f, orderBody(holdId)), 403, 'booking-restricted');

    expect(await ordersOf(f.accountId)).toBe(0);
    expect(await idemCount(f.accountId)).toBe(0);
    expect(await outboxOf(w.eventId)).toEqual([]);
  });

  test('PT49_①_ACTIVE이고 끝 시각이 지금보다 뒤면 403, 끝 시각이 지났으면 201이다', async () => {
    const w = await world();
    const a = await fan(w);
    await restrict(a.accountId, { st: 'ACTIVE', until: String(clock.now() + DAY), ver: '1' });
    expectProblem(await order(a, orderBody(await hold(a, [w.s[0]!]))), 403, 'booking-restricted');

    const b = await fan(w);
    await restrict(b.accountId, { st: 'ACTIVE', until: String(clock.now() - 1), ver: '1' });
    const r = await order(b, orderBody(await hold(b, [w.s[1]!])));
    expect(r.statusCode, r.payload).toBe(201);
  });

  test('PT49_④_LIFTED면 201이다', async () => {
    const w = await world();
    const f = await fan(w);
    await restrict(f.accountId, { st: 'LIFTED', rid: randomUUID(), ver: '2' });
    const r = await order(f, orderBody(await hold(f, [w.s[2]!])));
    expect(r.statusCode, r.payload).toBe(201);
  });
});
