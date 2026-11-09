// 결제 시도 시작을 실제 PostgreSQL 18과 gRPC(같은 프로세스의 가짜 payment-svc, 실제 클라이언트 GrpcPaymentCheckouts)로 돈다(BUILD_ORDER PRF-191).
// 정본: docs/features/payment.md §2 '결제 시도 시작의 첫 구현', docs/data.md §5 '결제 시도 시작', 명세 specs/payment.qnt `newAttempt`.
//
// 약속:
// - 이 파일은 Kafka 네이티브 모듈을 불러오지 않는다(platform stream-worker를 가져오지 않는다. 행동 신호는 기록 대역이다).
// - 마이그레이션은 migratePurchase, Outbox 일 파티션은 ensureOutboxPartitions로 만든다. 주문은 주문 전이 함수로 만든다.
// - 구매 세션·회차 슬롯·홀드 만료는 메모리 대역이다(좌석 Redis의 Lua는 order-holds·seat-store 통합 시험이 본다).
// - 시험마다 새 주문·새 계정이다. DB 상태는 어댑터를 거치지 않고 admin 풀의 직접 SQL로 읽는다.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  AcceptPayment,
  type BehaviorSignalMessage,
  DrizzleOrderAccepts,
  DrizzleOrderStarts,
  DrizzleOrderStore,
  GrpcPaymentCheckouts,
  type NewOrder,
  type OrderRequestOnce,
  type StartOutcome,
  StartPayment,
  type StartPaymentCommand,
} from '../src/modules/booking/index.js';
import { accountActor, BASE_MS, DAY, makeItems, newOrderInput } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
let database: Database;
let admin: Database;
/** 주문 행을 붙잡아 두는 풀(경합 시험) */
let race: Database;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: 'start-payment-test' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'start-payment-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 2, applicationName: 'start-payment-race' });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  return { clock, store, starts: new DrizzleOrderStarts({ database, store, clock }), accepts: new DrizzleOrderAccepts({ database, store, clock }) };
}
type Fresh = ReturnType<typeof fresh>;

async function placed(s: Fresh, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2), ...o });
  await database.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}

const fingerprint = (orderId: string, body: unknown) => requestFingerprint('POST', `/v1/orders/${orderId}/payments`, Buffer.from(JSON.stringify(body), 'utf8'));
const onceOf = (o: NewOrder, body: unknown = {}, key: string = randomUUID()): OrderRequestOnce => ({ accountRef: o.accountId, operation: 'START_PAYMENT', key, requestHash: fingerprint(o.id, body) });
const inputOf = (s: Fresh, o: NewOrder, x: { pg?: 'TOSS' | 'PORTONE' | 'SIMULATOR'; attemptId?: string } = {}) => {
  const pg = x.pg ?? 'TOSS';
  return { orderId: o.id, attemptId: x.attemptId ?? uuidv7(s.clock), pg, pgOrderRef: pg === 'PORTONE' ? `pay-${o.id}` : o.id, actor: accountActor(o.accountId) };
};

const attemptsOf = (orderId: string) =>
  q<{ id: string; pg: string; pg_order_ref: string | null; status: string; created_at: Date }>('select id, pg, pg_order_ref, status, created_at from payment_attempt where order_id = $1 order by created_at, id', [orderId]);
const orderRow = async (id: string) => (await q<{ status: string; event_seq: number }>('select status, event_seq from purchase_order where id = $1', [id]))[0];
const historyOf = (id: string) => q<{ seq: number; from_status: string; to_status: string; cause: string; actor: string }>('select seq, from_status, to_status, cause, actor from order_event where order_id = $1 order by seq', [id]);
const outboxCount = async (eventId: string) => Number((await q<{ n: string }>('select count(*) as n from outbox where msg_key = $1', [eventId]))[0]!.n);
const idemRows = (accountRef: string) => q<{ result_ref: string | null }>(`select result_ref from order_idempotency where account_ref = $1 and operation = 'START_PAYMENT'`, [accountRef]);

/** 같은 프로세스의 가짜 payment-svc. switchTo가 있으면(전환 켜짐) 고정이 없는 요청은 그 결제사로 고른다 */
async function paymentServer() {
  const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
  const srv = new grpc.Server();
  const state = { switchTo: undefined as 'PORTONE' | undefined, pausedDetails: undefined as string | undefined, requests: [] as Record<string, unknown>[] };
  srv.addService(pkg.PaymentService.service, {
    PrepareCheckout: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const r = call.request;
      state.requests.push(r);
      if (state.pausedDetails !== undefined) {
        cb({ code: grpc.status.FAILED_PRECONDITION, details: state.pausedDetails });
        return;
      }
      const pinned = r.pinned_pg === 'PG_PROVIDER_UNSPECIFIED' ? undefined : String(r.pinned_pg).replace('PG_PROVIDER_', '');
      const pg = pinned ?? state.switchTo ?? 'TOSS';
      const krw = (r.amount as { krw: number }).krw;
      const orderId = String(r.order_id);
      if (pg === 'PORTONE') {
        cb(null, {
          pg: 'PG_PROVIDER_PORTONE',
          switched: true,
          portone: { store_id: 's', channel_key: 'c', payment_id: `pay-${orderId}`, order_name: r.order_name, total_amount: { krw }, currency: 'KRW', redirect_url: 'https://p.test/r', custom_data: { order_id: orderId } },
          allowed_pay_methods: ['CARD'],
        });
        return;
      }
      cb(null, {
        pg: 'PG_PROVIDER_TOSS',
        switched: false,
        toss: { client_key: 'ck', customer_key: randomUUID(), order_id: orderId, order_name: r.order_name, amount: { krw }, success_url: 'https://p.test/ok', fail_url: 'https://p.test/fail' },
        allowed_pay_methods: ['CARD', 'VIRTUAL_ACCOUNT'],
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) => srv.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  return { address: `127.0.0.1:${port}`, state, close: () => srv.forceShutdown() };
}

/** 실제 StartPayment 조립(DB·gRPC는 실제, 구매 세션·슬롯·홀드 만료는 대역) */
function world(s: Fresh, o: NewOrder, address: string) {
  const published: BehaviorSignalMessage[] = [];
  const checkouts = new GrpcPaymentCheckouts({ address });
  const sessions = { get: async () => ({ sessionId: o.purchaseSessionId, accountId: o.accountId, eventId: o.eventId, journeyId: o.created.journeyId! }), markPaying: async () => true };
  const slots = { read: async () => ({ status: 'OK' as const, gen: 3 }) };
  const start = new StartPayment({
    sessions,
    reads: s.starts,
    writes: s.starts,
    slots,
    saleConfigs: { get: async () => ({ saleEndsAtMs: BASE_MS + DAY, tierPrices: {}, orderName: '통합 공연', entryOpensAtMs: BASE_MS + 3 * DAY, virtualAccountAllowed: false }) },
    holdExpiries: { expiresAt: async () => BASE_MS + 420_000 },
    checkouts,
    behavior: { publish: async (m) => void published.push(m) },
    signals: { paymentAttempt: () => {}, telemetryDropped: () => {} },
    log: { attemptsExceeded: () => {}, checkoutMisconfigured: () => {}, holdExpiryUnreadable: () => {} },
    clock: s.clock,
  });
  const accept = new AcceptPayment({ sessions, reads: s.accepts, writes: s.accepts, slots, log: { attemptMismatch: () => {} }, clock: s.clock });
  const command = (over: Partial<StartPaymentCommand> = {}, key = randomUUID(), body: unknown = {}): StartPaymentCommand => ({
    accountId: o.accountId,
    pid: 'pid-it',
    purchaseSessionId: o.purchaseSessionId,
    orderId: o.id,
    idem: onceOf(o, body, key),
    body: {},
    ...over,
  });
  return { start, accept, command, published, close: () => checkouts.close() };
}
const settle = () => new Promise((r) => setImmediate(r));

// ───────────────────────────── 어댑터 ─────────────────────────────

describe('DrizzleOrderStarts.start: 한 트랜잭션', () => {
  test('PT23_새 시도: READY·UUIDv7·결제사·결제사 참조이고, T2 이력 한 행과 순번이 늘며 Outbox는 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const before = await outboxCount(o.eventId);
    const input = inputOf(s, o, { pg: 'PORTONE' });
    expect(input.attemptId).toMatch(UUID_V7);
    expect(await s.starts.start(onceOf(o), input)).toEqual({ status: 'STARTED', attemptNo: 1 });
    expect(await attemptsOf(o.id)).toMatchObject([{ id: input.attemptId, pg: 'PORTONE', pg_order_ref: `pay-${o.id}`, status: 'READY' }]);
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 2 });
    expect((await historyOf(o.id)).at(-1)).toEqual({ seq: 2, from_status: 'CREATED', to_status: 'CREATED', cause: 'T2', actor: accountActor(o.accountId) });
    expect(await outboxCount(o.eventId)).toBe(before);
  });

  test('PT23_PT27_다시 시작하면 이전 READY가 SUPERSEDED이고 활성 시도는 하나다. 다른 결제사로 바뀔 수 있다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const o = await placed(s);
    const first = inputOf(s, o);
    await s.starts.start(onceOf(o), first);
    s.clock.advance(1_000);
    const second = inputOf(s, o, { pg: 'PORTONE' });
    expect(await s.starts.start(onceOf(o), second)).toEqual({ status: 'STARTED', attemptNo: 2 });
    expect((await attemptsOf(o.id)).map((a) => [a.id, a.status, a.pg])).toEqual([
      [first.attemptId, 'SUPERSEDED', 'TOSS'],
      [second.attemptId, 'READY', 'PORTONE'],
    ]);
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 3 });
  });

  test('PT25_네 번째는 ATTEMPTS_EXCEEDED이고 트랜잭션째 되돌린다(시도·이력·멱등 기록이 늘지 않는다) [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    for (let i = 1; i <= 3; i += 1) {
      s.clock.advance(1_000);
      expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'STARTED', attemptNo: i });
    }
    const seq = (await orderRow(o.id))!.event_seq;
    const idem = (await idemRows(o.accountId)).length;
    s.clock.advance(1_000);
    expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'ATTEMPTS_EXCEEDED' });
    expect(await attemptsOf(o.id)).toHaveLength(3);
    expect((await orderRow(o.id))!.event_seq).toBe(seq);
    expect(await idemRows(o.accountId)).toHaveLength(idem);
  });

  test('PT25_끝난 시도(EXPIRED·SUPERSEDED)도 상한에 센다', async () => {
    const s = fresh();
    const o = await placed(s);
    for (const status of ['SUPERSEDED', 'EXPIRED', 'EXPIRED']) {
      await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [uuidv7(s.clock), o.id, 'TOSS', o.id, status, new Date(s.clock.now())]);
    }
    expect(await s.starts.attemptCount(o.id)).toBe(3);
    expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'ATTEMPTS_EXCEEDED' });
  });

  test.each(['AUTHENTICATED', 'ACCEPTED', 'EXPIRED'] as const)('PT23_주문이 %s면 STALE ORDER_STATE이고 시도를 쓰지 않는다 [ASVS v5.0.0-2.3.1]', async (target) => {
    const s = fresh();
    const o = await placed(s);
    const path = target === 'AUTHENTICATED' ? ['T3'] : target === 'ACCEPTED' ? ['T3', 'T4'] : ['T5'];
    for (const transition of path) await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition: transition as 'T3', actor: 'system:test' }));
    expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: target });
    expect(await attemptsOf(o.id)).toHaveLength(0);
  });

  test('PT23_활성 시도 유일 위반은 ACTIVE_CONFLICT다(ACCEPTED 시도가 남은 비정상 주문, 마지막 안전망) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const o = await placed(s);
    await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [uuidv7(s.clock), o.id, 'TOSS', o.id, 'ACCEPTED', new Date(s.clock.now())]);
    expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'ACTIVE_CONFLICT' });
    expect(await attemptsOf(o.id)).toHaveLength(1);
  });

  test('FR011_입력이 틀리면 DB에 가기 전에 RangeError다', async () => {
    const s = fresh();
    const o = await placed(s);
    await expect(s.starts.start(onceOf(o), { ...inputOf(s, o), attemptId: 'x' })).rejects.toThrow(RangeError);
    await expect(s.starts.start(onceOf(o), { ...inputOf(s, o), pg: 'KCP' as 'TOSS' })).rejects.toThrow(RangeError);
    await expect(s.starts.start(onceOf(o), { ...inputOf(s, o), pgOrderRef: '' })).rejects.toThrow(RangeError);
    await expect(s.starts.start(onceOf(o), { ...inputOf(s, o), actor: 'nobody' })).rejects.toThrow(RangeError);
  });

  test('PT45_같은 키·같은 지문은 REPLAYED이고 시도·이력이 늘지 않는다', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    const first = inputOf(s, o);
    await s.starts.start(once, first);
    const seq = (await orderRow(o.id))!.event_seq;
    expect(await s.starts.start(once, inputOf(s, o))).toEqual({ status: 'REPLAYED', attemptId: first.attemptId });
    expect(await attemptsOf(o.id)).toHaveLength(1);
    expect((await orderRow(o.id))!.event_seq).toBe(seq);
  });

  test('PT45_같은 키가 겹치면 하나만 만들고 다른 쪽은 REPLAYED다', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    const results: StartOutcome[] = await Promise.all([s.starts.start(once, inputOf(s, o)), s.starts.start(once, inputOf(s, o))]);
    expect(results.map((r) => r.status).sort()).toEqual(['REPLAYED', 'STARTED']);
    expect(await attemptsOf(o.id)).toHaveLength(1);
  });

  test('PT45_⑤같은 키를 다른 작업(주문 생성)에 썼어도 범위가 달라 따로 처리된다', async () => {
    const s = fresh();
    const o = await placed(s);
    const key = randomUUID();
    await q('insert into order_idempotency (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, $5, $6)', [o.accountId, 'CREATE_ORDER', key, Buffer.alloc(32, 1), o.id, new Date(s.clock.now())]);
    expect((await s.starts.start(onceOf(o, {}, key), inputOf(s, o))).status).toBe('STARTED');
    expect((await s.starts.findCommitted(onceOf(o, {}, key))).status).toBe('COMMITTED');
  });
});

describe('DrizzleOrderStarts 읽기', () => {
  test('PT45_findCommitted: 없으면 NONE, 커밋 뒤 같은 지문은 COMMITTED(시도 ID), 다른 지문은 MISMATCH다', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    expect(await s.starts.findCommitted(once)).toEqual({ status: 'NONE' });
    const input = inputOf(s, o);
    await s.starts.start(once, input);
    expect(await s.starts.findCommitted(once)).toEqual({ status: 'COMMITTED', attemptId: input.attemptId });
    expect(await s.starts.findCommitted({ ...once, requestHash: fingerprint(o.id, { other: true }) })).toEqual({ status: 'MISMATCH' });
  });

  test('PT45_⑥보관 기간(24시간)이 지난 기록은 NONE이다', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    await s.starts.start(once, inputOf(s, o));
    s.clock.advance(DAY);
    expect(await s.starts.findCommitted(once)).toEqual({ status: 'NONE' });
  });

  test('FR011_order: 소유자·구매 세션·금액·홀드·좌석(줄 번호 차례)을 읽고, 없거나 UUID가 아니면 undefined다', async () => {
    const s = fresh();
    const o = await placed(s);
    expect(await s.starts.order(o.id)).toEqual({ orderId: o.id, accountId: o.accountId, eventId: o.eventId, purchaseSessionId: o.purchaseSessionId, status: 'CREATED', amount: o.amount, holdId: o.holdId, seatIds: o.items.map((i) => i.seatId) });
    expect(await s.starts.order(randomUUID())).toBeUndefined();
    expect(await s.starts.order('not-a-uuid')).toBeUndefined();
  });

  test('FR011_attempt: 시도의 주문·결제사를 읽고 없으면 undefined다', async () => {
    const s = fresh();
    const o = await placed(s);
    const input = inputOf(s, o, { pg: 'PORTONE' });
    await s.starts.start(onceOf(o), input);
    expect(await s.starts.attempt(input.attemptId)).toEqual({ attemptId: input.attemptId, orderId: o.id, pg: 'PORTONE' });
    expect(await s.starts.attempt(randomUUID())).toBeUndefined();
    expect(await s.starts.attempt('x')).toBeUndefined();
  });
});

describe('경합(주문 행 잠금)', () => {
  /** 주문 행을 FOR UPDATE로 잡고 있다가 release를 부르면 놓는다 */
  async function hold(orderId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const acquired = new Promise<void>((r) => (locked = r));
    const done = race.transaction(async (tx) => {
      await tx.execute(`select 1 from purchase_order where id = '${orderId}' for update` as never);
      locked();
      await gate;
    });
    await acquired;
    return { release, done };
  }

  test('PT23_두 탭이 동시에 시작해도 둘 다 시작하고 활성 시도는 하나이며 앞 시도는 SUPERSEDED다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const o = await placed(s);
    const results = await Promise.all([s.starts.start(onceOf(o), inputOf(s, o)), s.starts.start(onceOf(o), inputOf(s, o))]);
    expect(results.map((r) => r.status)).toEqual(['STARTED', 'STARTED']);
    expect(results.map((r) => (r as { attemptNo: number }).attemptNo).sort()).toEqual([1, 2]);
    const rows = await attemptsOf(o.id);
    expect(rows.filter((r) => r.status === 'READY')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'SUPERSEDED')).toHaveLength(1);
    expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 3 });
  });

  test('PT25_동시 네 요청이 와도 상한을 넘지 않는다(주문 행을 잡은 뒤 센다) [ASVS v5.0.0-2.3.2]', async () => {
    const s = fresh();
    const o = await placed(s);
    const results = await Promise.all(Array.from({ length: 5 }, () => s.starts.start(onceOf(o), inputOf(s, o))));
    expect(results.filter((r) => r.status === 'STARTED')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'ATTEMPTS_EXCEEDED')).toHaveLength(2);
    expect((await attemptsOf(o.id)).length).toBe(3);
  });

  const tossRefs = { pg: 'TOSS' as const, paymentKey: 'tgen_race' };
  const acceptInput = (o: NewOrder, attemptId: string) => ({ orderId: o.id, attemptId, eventId: o.eventId, refs: tossRefs, seatGen: 3, actor: accountActor(o.accountId) });
  const acceptOnce = (o: NewOrder): OrderRequestOnce => ({ accountRef: o.accountId, operation: 'ACCEPT_PAYMENT', key: randomUUID(), requestHash: new Uint8Array(32).fill(3) });

  test('PT23_접수가 먼저 커밋되면 시작은 STALE(ACCEPTED)이고 시도는 그대로다 [ASVS v5.0.0-2.3.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    const first = inputOf(s, o);
    await s.starts.start(onceOf(o), first);
    expect(await s.accepts.accept(acceptOnce(o), acceptInput(o, first.attemptId))).toEqual({ status: 'ACCEPTED' });
    expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' });
    expect(await attemptsOf(o.id)).toMatchObject([{ id: first.attemptId, status: 'ACCEPTED' }]);
  });

  test('PT27_시작이 먼저 커밋되면 이전 시도의 늦은 접수는 STALE ATTEMPT_GONE이다(과금 0건)', async () => {
    const s = fresh();
    const o = await placed(s);
    const first = inputOf(s, o);
    await s.starts.start(onceOf(o), first);
    await s.starts.start(onceOf(o), inputOf(s, o, { pg: 'PORTONE' }));
    expect(await s.accepts.accept(acceptOnce(o), acceptInput(o, first.attemptId))).toEqual({ status: 'STALE', reason: 'ATTEMPT_GONE', current: 'SUPERSEDED' });
    expect((await orderRow(o.id))!.status).toBe('CREATED');
  });

  test('PT23_시작과 접수를 주문 행 앞에 줄 세우면 하나만 효과가 있다(교착 없음) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const o = await placed(s);
    const first = inputOf(s, o);
    await s.starts.start(onceOf(o), first);
    const lock = await hold(o.id);
    const accept = s.accepts.accept(acceptOnce(o), acceptInput(o, first.attemptId));
    const start = s.starts.start(onceOf(o), inputOf(s, o, { pg: 'PORTONE' }));
    await new Promise((r) => setTimeout(r, 100));
    lock.release();
    await lock.done;
    const [a, b] = await Promise.all([accept, start]);
    const rows = await attemptsOf(o.id);
    if (a.status === 'ACCEPTED') {
      expect(b).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' });
      expect(rows.map((r) => r.status)).toEqual(['ACCEPTED']);
    } else {
      expect(a).toEqual({ status: 'STALE', reason: 'ATTEMPT_GONE', current: 'SUPERSEDED' });
      expect(b.status).toBe('STARTED');
      expect(rows.filter((r) => r.status === 'READY')).toHaveLength(1);
    }
  });

  test('PT41_만료(T5)가 먼저 커밋되면 시작은 STALE(EXPIRED)이다', async () => {
    const s = fresh();
    const o = await placed(s);
    await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition: 'T5', actor: 'system:order-expiry' }));
    expect(await s.starts.start(onceOf(o), inputOf(s, o))).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' });
  });
});

// ───────────────────────────── 쓰임새 + 실제 DB·gRPC ─────────────────────────────

describe('StartPayment + 실제 PostgreSQL·gRPC', () => {
  test('PT26_PT28_토스 시도: 판의 값이 선을 지나고 시도 행의 결제사 참조는 주문 ID다', async () => {
    const srv = await paymentServer();
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    try {
      const r = await w.start.execute(w.command());
      if (r.status !== 201) throw new Error(`거절: ${r.reason}`);
      expect(r).toMatchObject({ replayed: false, attempt: { pg: 'TOSS', switched: false, holdExpiresAtMs: BASE_MS + 420_000, allowedPayMethods: ['CARD', 'VIRTUAL_ACCOUNT'] } });
      expect(srv.state.requests[0]).toMatchObject({ order_id: o.id, event_id: o.eventId, amount: { krw: o.amount }, order_name: '통합 공연', virtual_account_allowed: false, entry_opens_at: { seconds: Math.floor((BASE_MS + 3 * DAY) / 1000) } });
      expect(await attemptsOf(o.id)).toMatchObject([{ id: r.attempt.attemptId, pg: 'TOSS', pg_order_ref: o.id, status: 'READY' }]);
    } finally {
      w.close();
      srv.close();
    }
  });

  test('PT27_전환이 켜져도 같은 키의 재생은 처음 결제사이고, 새 키의 다음 시도는 대체 결제사다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.3.4]', async () => {
    const srv = await paymentServer();
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    try {
      const key = randomUUID();
      const first = await w.start.execute(w.command({}, key));
      if (first.status !== 201) throw new Error('거절');
      srv.state.switchTo = 'PORTONE';
      s.clock.advance(1_000);
      const replay = await w.start.execute(w.command({}, key));
      expect(replay).toMatchObject({ status: 201, replayed: true, attempt: { attemptId: first.attempt.attemptId, pg: 'TOSS' } });
      expect(srv.state.requests.at(-1)).toMatchObject({ pinned_pg: 'PG_PROVIDER_TOSS', attempt_id: first.attempt.attemptId });
      expect(await attemptsOf(o.id)).toHaveLength(1);
      s.clock.advance(1_000);
      const next = await w.start.execute(w.command());
      if (next.status !== 201) throw new Error('거절');
      expect(next).toMatchObject({ replayed: false, attempt: { pg: 'PORTONE', switched: true } });
      expect((await attemptsOf(o.id)).map((a) => [a.pg, a.status, a.pg_order_ref])).toEqual([
        ['TOSS', 'SUPERSEDED', o.id],
        ['PORTONE', 'READY', `pay-${o.id}`],
      ]);
      // 대체된 시도의 늦은 접수는 409다
      const late = await w.accept.execute({ accountId: o.accountId, purchaseSessionId: o.purchaseSessionId, orderId: o.id, idem: { accountRef: o.accountId, operation: 'ACCEPT_PAYMENT', key: randomUUID(), requestHash: new Uint8Array(32).fill(4) }, body: { pg: 'TOSS', paymentKey: 'tgen_late', amount: o.amount } });
      expect(late).toEqual({ status: 'REJECTED', reason: 'ATTEMPT_MISMATCH' });
    } finally {
      w.close();
      srv.close();
    }
  });

  test('PT27_리뷰 고침 M2: 같은 결제사로 다시 시작한 뒤 대체된 시도의 늦은 접수(attemptId)는 409이고 주문·새 시도는 그대로다(과금 0건) [ASVS v5.0.0-2.3.4]', async () => {
    const srv = await paymentServer();
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    try {
      const first = await w.start.execute(w.command());
      if (first.status !== 201) throw new Error('거절');
      s.clock.advance(1_000);
      const second = await w.start.execute(w.command());
      if (second.status !== 201) throw new Error('거절');
      expect(second.attempt.pg).toBe(first.attempt.pg);
      const acceptOf = (attemptId: string, key: string) =>
        w.accept.execute({ accountId: o.accountId, purchaseSessionId: o.purchaseSessionId, orderId: o.id, idem: { accountRef: o.accountId, operation: 'ACCEPT_PAYMENT', key, requestHash: new Uint8Array(32).fill(6) }, body: { pg: 'TOSS', paymentKey: 'tgen_late_same_pg', amount: o.amount, attemptId } });
      expect(await acceptOf(first.attempt.attemptId, randomUUID())).toEqual({ status: 'REJECTED', reason: 'ATTEMPT_MISMATCH' });
      expect((await orderRow(o.id))!.status).toBe('CREATED');
      expect((await attemptsOf(o.id)).map((a) => [a.id, a.status])).toEqual([
        [first.attempt.attemptId, 'SUPERSEDED'],
        [second.attempt.attemptId, 'READY'],
      ]);
      expect(await acceptOf(second.attempt.attemptId, randomUUID())).toEqual({ status: 202, replayed: false });
    } finally {
      w.close();
      srv.close();
    }
  });

  test('PT25_네 번째 시도는 409이고 재생은 세지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const srv = await paymentServer();
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    try {
      const key = randomUUID();
      for (let i = 0; i < 3; i += 1) {
        s.clock.advance(1_000);
        expect((await w.start.execute(w.command({}, i === 0 ? key : randomUUID()))).status).toBe(201);
      }
      expect(await w.start.execute(w.command())).toEqual({ status: 'REJECTED', reason: 'ATTEMPTS_EXCEEDED' });
      expect((await w.start.execute(w.command({}, key))).status).toBe(201);
      expect(await attemptsOf(o.id)).toHaveLength(3);
    } finally {
      w.close();
      srv.close();
    }
  });

  test('PT51_행동 요약은 첫 시도만 낸다(재시도·재생은 버린다)', async () => {
    const srv = await paymentServer();
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    const behavior = { v: 1, windowMs: 9_000 } as const;
    try {
      const key = randomUUID();
      await w.start.execute(w.command({ body: { behavior } }, key, { behavior }));
      await settle();
      expect(w.published).toHaveLength(1);
      expect(w.published[0]).toMatchObject({ screen: 'PAYMENT', eventId: o.eventId, journeyId: o.created.journeyId, pid: 'pid-it', features: behavior });
      await w.start.execute(w.command({ body: { behavior } }, key, { behavior }));
      s.clock.advance(1_000);
      await w.start.execute(w.command({ body: { behavior } }));
      await settle();
      expect(w.published).toHaveLength(1);
    } finally {
      w.close();
      srv.close();
    }
  });

  test.each(['TOSS', 'PORTONE'] as const)('PT28_전체 흐름 생성 → 시도(%s) → 접수: 새 API로 만든 시도가 접수되어 주문이 ACCEPTED다', async (pg) => {
    const srv = await paymentServer();
    srv.state.switchTo = pg === 'PORTONE' ? 'PORTONE' : undefined;
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    try {
      const started = await w.start.execute(w.command());
      if (started.status !== 201) throw new Error('거절');
      const idem: OrderRequestOnce = { accountRef: o.accountId, operation: 'ACCEPT_PAYMENT', key: randomUUID(), requestHash: new Uint8Array(32).fill(5) };
      const body = pg === 'TOSS' ? ({ pg: 'TOSS', paymentKey: 'tgen_flow', amount: o.amount } as const) : ({ pg: 'PORTONE', paymentId: `pay-${o.id}`, paymentToken: 'ptok_flow', txId: 'tx-flow' } as const);
      const accepted = await w.accept.execute({ accountId: o.accountId, purchaseSessionId: o.purchaseSessionId, orderId: o.id, idem, body });
      expect(accepted).toEqual({ status: 202, replayed: false });
      expect((await orderRow(o.id))!.status).toBe('ACCEPTED');
      expect(await attemptsOf(o.id)).toMatchObject([{ id: started.attempt.attemptId, pg, status: 'ACCEPTED' }]);
      const again = await w.start.execute(w.command());
      expect(again).toEqual({ status: 'REJECTED', reason: 'ALREADY_ACCEPTED' });
    } finally {
      w.close();
      srv.close();
    }
  });

  test('P-T43_payment-svc가 새 결제 일시 정지면 503 쪽 결과이고 시도·이력·멱등 기록이 남지 않으며 홀드 남은 초를 싣는다(BUILD_ORDER PRF-201) [ASVS v5.0.0-16.5.3]', async () => {
    const srv = await paymentServer();
    srv.state.pausedDetails = 'new-payment-paused';
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, srv.address);
    try {
      expect(await w.start.execute(w.command())).toEqual({ status: 'REJECTED', reason: 'NEW_PAYMENT_PAUSED', holdRemainingSeconds: 420 });
      expect(await attemptsOf(o.id)).toHaveLength(0);
      expect((await orderRow(o.id))!.event_seq).toBe(1);
      expect(await idemRows(o.accountId)).toHaveLength(0);
    } finally {
      w.close();
      srv.close();
    }
  });

  test('PT26_payment-svc가 UNAVAILABLE이면 시도·이력·멱등 기록이 남지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const w = world(s, o, '127.0.0.1:1');
    try {
      expect(await w.start.execute(w.command())).toEqual({ status: 'REJECTED', reason: 'PG_UNAVAILABLE' });
      expect(await attemptsOf(o.id)).toHaveLength(0);
      expect((await orderRow(o.id))!.event_seq).toBe(1);
      expect(await idemRows(o.accountId)).toHaveLength(0);
    } finally {
      w.close();
    }
  });
});
