// 결제 접수의 purchase DB 읽기·쓰기(booking DrizzleOrderAccepts)를 실제 PostgreSQL 18로 돈다(BUILD_ORDER PRF-162).
// 정본: docs/features/payment.md §2 '결제 접수의 첫 구현'(검사 차례·상태 표·한 트랜잭션·결제 참조의 자리), docs/data.md payment_attempt(결제 참조 칸 다섯)·
// purchase_order.seat_gen·§4 여섯 번째 마이그레이션(order_saga_job)·§5 '결제 접수' 줄(두 탭 동시, 같은 멱등 키 겹침, 접수와 주문 만료가 겹침),
// docs/security/data-classification.md '결제사 결제 참조' 행, booking domain/ports.ts OrderAcceptReads·OrderAcceptWrites와 adapters/db/drizzle-order-accepts.ts의 설명.
//
// 약속:
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase, Outbox 일 파티션은 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다(order-writes.int.test.ts와 같다).
// - 주문은 주문 전이 함수(DrizzleOrderStore.createOrder·transition)로 만든다. 결제 시도 READY 행은 시험이 직접 넣는다(결제 시도 시작 API는 PRF-190).
// - 시험마다 새 주문·새 회차·새 계정을 쓰고 표를 비우지 않는다. 시각은 시험마다 따로 만든 가짜 시계다.
// - DB 상태는 어댑터를 거치지 않고 admin 풀의 직접 SQL로 읽는다. 기대 값(전이 표·사건 모양)은 order-fixtures.ts에 정본에서 따로 적은 것을 쓴다.
//
// 정본 모호(drizzle-order-accepts.ts·ports.ts의 정한 것을 따른다):
// - T3·T4 이력의 행위자는 둘 다 입력 actor(account:<계정>)이고 시각은 둘 다 접수 시각이다(정본은 T4 행위자를 적지 않았다).
// - authenticated_at = accepted_at = 접수 시각, order_saga_job.next_attempt_at = created_at = 접수 시각, lease_until 비움.
// - 잠금 차례는 주문 행(T3) → 결제 시도 행이다(리뷰 고침 M2, 2026-11-05). 두 탭 경합의 진 쪽은 T3에서 기다렸다가 0행이라 STALE ORDER_STATE(current ACCEPTED)이고,
//   시도 UPDATE 0행은 시도가 READY가 아니게 된 것(대체·만료)뿐이라 STALE ATTEMPT_GONE(current = 시도 상태)이다.
// - 주문이 AUTHENTICATED·ACCEPTED·EXPIRED면 STALE ORDER_STATE이고 current는 지금 상태다(시도는 건드리지 않는다).
// - 재생(REPLAYED)은 입력(결제 참조·seatGen)이 달라도 처음 결과 그대로다(지문만 본다).
import { randomUUID } from 'node:crypto';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, ProblemError, requestFingerprint, uuidv7 } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  type AcceptInput,
  type AcceptOutcome,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  type NewOrder,
  type OrderRequestOnce,
  type PaymentRefs,
  type TransitionId,
} from '../src/modules/booking/index.js';
import { accountActor, BASE_MS, CREATED_ONLY, DAY, laterEvent, makeItems, messagesOf, newOrderInput, rejections, SAGA } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 어댑터가 쓰는 풀(동시성 시험이 연결 여럿을 쓴다) */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;
/** 주문 만료(T5)를 붙잡아 두는 풀(접수와 만료가 겹침) */
let race: Database;

const APP = 'order-accepts-test';

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: APP });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'order-accepts-admin' });
  race = createDatabase({ url: server.url, profile: 'general', max: 2, applicationName: 'order-accepts-race' });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), race?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/** 시험 하나의 가짜 시계·주문 전이 함수·접수 어댑터 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  return { clock, store, accepts: new DrizzleOrderAccepts({ database, store, clock }) };
}
type Fresh = ReturnType<typeof fresh>;

/** 주문 하나(T1, 지금 시각) */
async function placed(s: Fresh, o: Partial<NewOrder> = {}): Promise<NewOrder> {
  const order = newOrderInput(s.clock, { items: makeItems(2), ...o });
  await database.transaction((tx) => s.store.createOrder(tx, order));
  return order;
}
/** 주문 전이 함수로 상태를 옮긴다(이력이 함께 남는다) */
async function walk(s: Fresh, o: NewOrder, path: readonly TransitionId[], actor = SAGA): Promise<void> {
  for (const transition of path) {
    const r = await database.transaction((tx) => s.store.transition(tx, { orderId: o.id, transition, actor }));
    expect(r.status, transition).toBe('APPLIED');
  }
}

type Pg = 'TOSS' | 'PORTONE' | 'SIMULATOR';
/** 결제 시도 행을 직접 넣는다(결제 시도 시작은 PRF-190). pg_order_ref: 토스·시뮬레이터 = 주문 ID, 포트원 = pay-{주문 ID}(payment §2.1 '주문 식별자 재사용') */
async function putAttempt(s: Fresh, o: NewOrder, x: { pg?: Pg; status?: string; createdAtMs?: number; pgOrderRef?: string | null } = {}): Promise<string> {
  const pg = x.pg ?? 'TOSS';
  const id = uuidv7(s.clock);
  const ref = x.pgOrderRef === undefined ? (pg === 'PORTONE' ? `pay-${o.id}` : o.id) : x.pgOrderRef;
  await q('insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at) values ($1, $2, $3, $4, $5, $6)', [
    id,
    o.id,
    pg,
    ref,
    x.status ?? 'READY',
    new Date(x.createdAtMs ?? s.clock.now()),
  ]);
  return id;
}

/** 결제 접수 요청 지문(platform requestFingerprint: 메서드·경로·본문) */
const fingerprint = (orderId: string, body: unknown) =>
  requestFingerprint('POST', `/v1/orders/${orderId}/payment-acceptance`, Buffer.from(JSON.stringify(body), 'utf8'));

/** 결제 접수 멱등 값(범위 = 그 계정 × ACCEPT_PAYMENT) */
const onceOf = (o: NewOrder, body: unknown = { n: randomUUID() }, key: string = randomUUID()): OrderRequestOnce => ({
  accountRef: o.accountId,
  operation: 'ACCEPT_PAYMENT',
  key,
  requestHash: fingerprint(o.id, body),
});

const tossRefs = (paymentKey = `tgen_${randomUUID().replaceAll('-', '').slice(0, 20)}`): PaymentRefs => ({ pg: 'TOSS', paymentKey });
const portoneRefs = (): PaymentRefs => ({ pg: 'PORTONE', txId: `tx-${randomUUID()}`, paymentToken: `ptok_${randomUUID().replaceAll('-', '')}` });

const inputOf = (o: NewOrder, attemptId: string, refs: PaymentRefs = tossRefs(), seatGen = 7): AcceptInput => ({
  orderId: o.id,
  attemptId,
  eventId: o.eventId,
  refs,
  seatGen,
  actor: accountActor(o.accountId),
});

const orderRow = async (id: string) =>
  (await q<{ status: string; event_seq: number; seat_gen: number | null }>('select status, event_seq, seat_gen from purchase_order where id = $1', [id]))[0];
const attemptRow = async (id: string) =>
  (
    await q<{
      status: string;
      pg_payment_key: string | null;
      pg_tx_id: string | null;
      pg_payment_token: string | null;
      authenticated_at: Date | null;
      accepted_at: Date | null;
    }>('select status, pg_payment_key, pg_tx_id, pg_payment_token, authenticated_at, accepted_at from payment_attempt where id = $1', [id])
  )[0];
const historyOf = (id: string) =>
  q<{ seq: number; from_status: string | null; to_status: string; cause: string; actor: string; occurred_at: Date }>(
    'select seq, from_status, to_status, cause, actor, occurred_at from order_event where order_id = $1 order by seq',
    [id],
  );
async function outboxOf(eventId: string): Promise<{ raw: string; event: Record<string, unknown> }[]> {
  const rows = await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by outbox.seq', [eventId]);
  return rows.map((r) => {
    const raw = Buffer.from(r.payload).toString('utf8');
    return { raw, event: JSON.parse(raw) as Record<string, unknown> };
  });
}
const sagaJobsOf = (orderId: string) =>
  q<{ order_id: string; event_id: string; step: string; attempts: number; next_attempt_at: Date; lease_until: Date | null; created_at: Date }>(
    'select order_id, event_id, step, attempts, next_attempt_at, lease_until, created_at from order_saga_job where order_id = $1',
    [orderId],
  );
const acceptIdemRows = (accountRef: string) =>
  q<{ idempotency_key: string; request_hash: Buffer; result_ref: string | null; created_at: Date }>(
    `select idempotency_key, request_hash, result_ref, created_at from order_idempotency where account_ref = $1 and operation = 'ACCEPT_PAYMENT' order by created_at, idempotency_key`,
    [accountRef],
  );
/** 처리 중이거나 결과 참조를 손으로 넣은 멱등 기록 */
const putIdem = (once: OrderRequestOnce, resultRef: string | null, createdAtMs: number) =>
  q('insert into order_idempotency (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, $5, $6)', [
    once.accountRef,
    once.operation,
    once.key,
    Buffer.from(once.requestHash),
    resultRef,
    new Date(createdAtMs),
  ]);

/** 아무것도 남지 않았는지 볼 때의 주문 흔적(주문 행·이력 수·Outbox 수·Saga 작업 수·접수 멱등 기록) */
const traceOf = async (o: NewOrder) => ({
  order: await orderRow(o.id),
  history: (await historyOf(o.id)).length,
  outbox: (await outboxOf(o.eventId)).length,
  saga: (await sagaJobsOf(o.id)).length,
  idem: (await acceptIdemRows(o.accountId)).map((r) => r.idempotency_key),
});

const contractIssues = (event: unknown) => OrderEvent.safeParse(event).error?.issues ?? [];

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}
/** 어댑터 풀(APP)에서 행 잠금을 기다리는 연결 수 */
const lockWaiters = () => count(`select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`, [APP]);

// ───────────────────────────── findCommitted ─────────────────────────────

describe('DrizzleOrderAccepts.findCommitted(트랜잭션 밖의 커밋된 멱등 기록 읽기)', () => {
  test('기록이 없으면 NONE이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    expect(await s.accepts.findCommitted(onceOf(o))).toEqual({ status: 'NONE' });
    expect(await acceptIdemRows(o.accountId)).toEqual([]);
  });

  test('PT45_③_같은 키·같은 지문으로 커밋한 접수가 있으면 COMMITTED와 그 주문 ID(result_ref)다. 주문이 그 뒤 상태로 가도 같다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    const once = onceOf(o);
    expect(await s.accepts.accept(once, inputOf(o, attemptId))).toEqual({ status: 'ACCEPTED' });
    expect(await s.accepts.findCommitted(once)).toEqual({ status: 'COMMITTED', orderId: o.id });
    await walk(s, o, ['T7']);
    expect(await s.accepts.findCommitted(once)).toEqual({ status: 'COMMITTED', orderId: o.id });
  });

  test('같은 키에 다른 지문이면 MISMATCH다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    await putIdem(once, o.id, s.clock.now());
    expect(await s.accepts.findCommitted({ ...once, requestHash: fingerprint(o.id, { other: true }) })).toEqual({ status: 'MISMATCH' });
    // 같은 지문이면 COMMITTED(지문만 바꿔 MISMATCH가 된다)
    expect(await s.accepts.findCommitted(once)).toEqual({ status: 'COMMITTED', orderId: o.id });
  });

  test('범위는 계정 × ACCEPT_PAYMENT다: 같은 계정·같은 키의 CREATE_ORDER·START_PAYMENT 기록과 다른 계정의 같은 키·같은 지문 기록은 NONE이다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    await putIdem({ ...once, operation: 'CREATE_ORDER' }, o.id, s.clock.now());
    await putIdem({ ...once, operation: 'START_PAYMENT' }, uuidv7(s.clock), s.clock.now());
    await putIdem({ ...once, accountRef: randomUUID() }, o.id, s.clock.now());
    expect(await s.accepts.findCommitted(once)).toEqual({ status: 'NONE' });
    await putIdem(once, o.id, s.clock.now());
    expect(await s.accepts.findCommitted(once)).toEqual({ status: 'COMMITTED', orderId: o.id });
  });

  test('처리 중인 기록(result_ref 비어 있음)은 NONE이다(검사를 이어 간다)', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    await putIdem(once, null, s.clock.now());
    expect(await s.accepts.findCommitted(once)).toEqual({ status: 'NONE' });
  });

  test('보관 기간(24시간 [가정])이 지난 기록은 NONE이고, 지나기 전이면 COMMITTED다', async () => {
    const s = fresh();
    const o = await placed(s);
    const once = onceOf(o);
    await putIdem(once, o.id, BASE_MS);
    const before = new DrizzleOrderAccepts({ database, store: s.store, clock: fakeClock({ now: BASE_MS + DAY - 1 }) });
    expect(await before.findCommitted(once)).toEqual({ status: 'COMMITTED', orderId: o.id });
    const after = new DrizzleOrderAccepts({ database, store: s.store, clock: fakeClock({ now: BASE_MS + DAY + 1 }) });
    expect(await after.findCommitted(once)).toEqual({ status: 'NONE' });
  });
});

// ───────────────────────────── order·activeAttempt ─────────────────────────────

describe('DrizzleOrderAccepts.order·activeAttempt(트랜잭션 밖 읽기)', () => {
  test('order는 주문 ID·계정·회차·구매 세션(purchase_session_id)·상태·금액이고, 상태는 지금 행이다', async () => {
    const s = fresh();
    const o = await placed(s);
    expect(await s.accepts.order(o.id)).toEqual({
      orderId: o.id,
      accountId: o.accountId,
      eventId: o.eventId,
      purchaseSessionId: o.purchaseSessionId,
      status: 'CREATED',
      amount: o.amount,
    });
    await walk(s, o, ['T5']);
    expect((await s.accepts.order(o.id))?.status).toBe('EXPIRED');
  });

  test.each<[string, (id: string) => string]>([
    ['없는 주문(새 UUIDv7)', () => uuidv7(fakeClock({ now: BASE_MS }))],
    ['대문자 UUID', (id) => id.toUpperCase()],
    ['UUID가 아님', () => 'order-1'],
    ['빈 글', () => ''],
  ])('order: %s면 undefined다(던지지 않는다)', async (_label, idOf) => {
    const s = fresh();
    const o = await placed(s);
    // 맞는 ID는 읽힌다(아무것이나 undefined인 구현이 통과하지 않게)
    expect((await s.accepts.order(o.id))?.orderId).toBe(o.id);
    expect(await s.accepts.order(idOf(o.id))).toBeUndefined();
  });

  test.each<[Pg, string]>([
    ['TOSS', 'READY'],
    ['SIMULATOR', 'READY'],
    ['PORTONE', 'READY'],
    ['TOSS', 'ACCEPTED'],
  ])('activeAttempt: %s %s 시도는 시도 ID·결제사·상태·pg_order_ref·만든 시각(epoch ms)이다', async (pg, status) => {
    const s = fresh();
    const o = await placed(s);
    const createdAtMs = s.clock.now() + 1234;
    const attemptId = await putAttempt(s, o, { pg, status, createdAtMs });
    expect(await s.accepts.activeAttempt(o.id)).toEqual({ attemptId, pg, status, attemptCount: 1, pgOrderRef: pg === 'PORTONE' ? `pay-${o.id}` : o.id, createdAtMs });
  });

  test('activeAttempt: pg_order_ref가 널이면 pgOrderRef가 없다', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o, { pg: 'PORTONE', pgOrderRef: null });
    const r = await s.accepts.activeAttempt(o.id);
    expect(r).toEqual({ attemptId, pg: 'PORTONE', status: 'READY', attemptCount: 1, createdAtMs: s.clock.now() });
    expect(r?.pgOrderRef).toBeUndefined();
  });

  test('activeAttempt: 시도가 없거나 SUPERSEDED·EXPIRED뿐이면 undefined이고, 대체된 시도 뒤의 READY 시도가 있으면 그것이다', async () => {
    const s = fresh();
    const o = await placed(s);
    expect(await s.accepts.activeAttempt(o.id)).toBeUndefined();
    await putAttempt(s, o, { status: 'SUPERSEDED' });
    s.clock.advance(1);
    await putAttempt(s, o, { status: 'EXPIRED' });
    expect(await s.accepts.activeAttempt(o.id)).toBeUndefined();
    s.clock.advance(1);
    const ready = await putAttempt(s, o, { pg: 'SIMULATOR' });
    expect(await s.accepts.activeAttempt(o.id)).toMatchObject({ attemptId: ready, pg: 'SIMULATOR', status: 'READY' });
    // 다른 주문의 시도는 보지 않는다
    const other = await placed(s);
    expect(await s.accepts.activeAttempt(other.id)).toBeUndefined();
  });
});

// ───────────────────────────── accept: 접수 ─────────────────────────────

describe('DrizzleOrderAccepts.accept(한 트랜잭션: 멱등 기록 → 시도 ACCEPTED → T3 → T4 → seat_gen → order_saga_job)', () => {
  test.each<'TOSS' | 'SIMULATOR'>(['TOSS', 'SIMULATOR'])(
    'ACCEPTED(%s): 시도 ACCEPTED·pg_payment_key·authenticated_at = accepted_at = 지금, 주문 ACCEPTED·event_seq 3·seat_gen, 이력 T3·T4(행위자 그 계정), Outbox ACCEPTED 하나(T3는 사건 없음), Saga 작업 RESERVE 한 행, 멱등 기록(결과 참조 = 주문 ID) [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.1]',
    async (pg) => {
      const s = fresh();
      const o = await placed(s);
      const createdAt = s.clock.now();
      s.clock.advance(1000);
      const attemptId = await putAttempt(s, o, { pg });
      s.clock.advance(60_000);
      const at = s.clock.now();
      const refs: PaymentRefs = { pg, paymentKey: `tgen_${randomUUID().replaceAll('-', '')}` };
      const once = onceOf(o);

      expect(await s.accepts.accept(once, inputOf(o, attemptId, refs, 7))).toEqual({ status: 'ACCEPTED' });

      expect(await attemptRow(attemptId)).toEqual({
        status: 'ACCEPTED',
        pg_payment_key: (refs as { paymentKey: string }).paymentKey,
        pg_tx_id: null,
        pg_payment_token: null,
        authenticated_at: new Date(at),
        accepted_at: new Date(at),
      });
      expect(await orderRow(o.id)).toEqual({ status: 'ACCEPTED', event_seq: 3, seat_gen: 7 });
      const fan = accountActor(o.accountId);
      expect(await historyOf(o.id)).toEqual([
        { seq: 1, from_status: null, to_status: 'CREATED', cause: 'T1', actor: o.actor, occurred_at: new Date(createdAt) },
        { seq: 2, from_status: 'CREATED', to_status: 'AUTHENTICATED', cause: 'T3', actor: fan, occurred_at: new Date(at) },
        { seq: 3, from_status: 'AUTHENTICATED', to_status: 'ACCEPTED', cause: 'T4', actor: fan, occurred_at: new Date(at) },
      ]);
      const outbox = await outboxOf(o.eventId);
      expect(outbox.map((x) => x.event.type)).toEqual(['CREATED', 'ACCEPTED']);
      expect(outbox[1]!.event).toMatchObject(laterEvent(o, 'ACCEPTED', 3, at, true));
      for (const k of CREATED_ONLY) expect(outbox[1]!.event).not.toHaveProperty(k);
      expect(contractIssues(outbox[1]!.event)).toEqual([]);
      // 결제 참조는 사건에 싣지 않는다(data-classification '결제 참조', ADR-0053)
      for (const x of outbox) expect(x.raw).not.toContain((refs as { paymentKey: string }).paymentKey);
      expect(await sagaJobsOf(o.id)).toEqual([
        { order_id: o.id, event_id: o.eventId, step: 'RESERVE', attempts: 0, next_attempt_at: new Date(at), lease_until: null, created_at: new Date(at) },
      ]);
      expect(await acceptIdemRows(o.accountId)).toEqual([{ idempotency_key: once.key, request_hash: Buffer.from(once.requestHash), result_ref: o.id, created_at: new Date(at) }]);
    },
  );

  test('ACCEPTED(PORTONE): pg_tx_id·pg_payment_token을 적고 pg_payment_key는 비우며, txId·토큰이 Outbox 값에 없다 [ASVS v5.0.0-14.2.4]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o, { pg: 'PORTONE' });
    s.clock.advance(5_000);
    const at = s.clock.now();
    const refs = portoneRefs() as Extract<PaymentRefs, { pg: 'PORTONE' }>;

    expect(await s.accepts.accept(onceOf(o), inputOf(o, attemptId, refs, 1))).toEqual({ status: 'ACCEPTED' });

    expect(await attemptRow(attemptId)).toEqual({
      status: 'ACCEPTED',
      pg_payment_key: null,
      pg_tx_id: refs.txId,
      pg_payment_token: refs.paymentToken,
      authenticated_at: new Date(at),
      accepted_at: new Date(at),
    });
    expect(await orderRow(o.id)).toEqual({ status: 'ACCEPTED', event_seq: 3, seat_gen: 1 });
    const outbox = await outboxOf(o.eventId);
    expect(outbox).toHaveLength(2);
    for (const x of outbox) {
      expect(x.raw).not.toContain(refs.paymentToken);
      expect(x.raw).not.toContain(refs.txId);
    }
  });

  test('PT45_③_같은 키·같은 지문으로 다시 접수하면 REPLAYED이고 새 이력·Outbox·Saga 작업이 없으며 시도의 접수 시각·결제 참조가 처음 그대로다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    const once = onceOf(o);
    const first = inputOf(o, attemptId);
    expect(await s.accepts.accept(once, first)).toEqual({ status: 'ACCEPTED' });
    const attemptBefore = await attemptRow(attemptId);
    const before = await traceOf(o);
    s.clock.advance(2_000);

    expect(await s.accepts.accept(once, inputOf(o, attemptId, tossRefs(), 9))).toEqual({ status: 'REPLAYED' });

    expect(await traceOf(o)).toEqual(before);
    expect(before).toMatchObject({ history: 3, outbox: 2, saga: 1, order: { status: 'ACCEPTED', seat_gen: 7 } });
    expect(await attemptRow(attemptId)).toEqual(attemptBefore);
  });

  test('같은 키에 다른 지문이면 422 idempotency-key-reused(ProblemError)이고 아무것도 바뀌지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    const once = onceOf(o, { a: 1 });
    expect(await s.accepts.accept(once, inputOf(o, attemptId))).toEqual({ status: 'ACCEPTED' });
    const before = await traceOf(o);

    const err = await s.accepts.accept({ ...once, requestHash: fingerprint(o.id, { a: 2 }) }, inputOf(o, attemptId)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 422, slug: 'idempotency-key-reused' });
    expect(await traceOf(o)).toEqual(before);
  });
});

// ───────────────────────────── accept: STALE ─────────────────────────────

describe('DrizzleOrderAccepts.accept STALE(조건부 UPDATE 0행이면 트랜잭션째 되돌린다)', () => {
  // 리뷰 고침 M2(2026-11-05): 잠금 차례가 주문 행(T3) → 결제 시도 행이라, 시도 UPDATE 0행은 시도가 READY가 아니게 된 것(대체·만료 등)이고 current는 시도의 지금 상태다.
  // T3는 이미 했지만 트랜잭션째 되돌려 주문도 CREATED 그대로다
  test.each(['ACCEPTED', 'SUPERSEDED', 'EXPIRED'])(
    'PT28_시도가 이미 %s(READY가 아님)면 STALE ATTEMPT_GONE(current = 시도 상태)이고 주문·이력·Outbox·Saga 작업·멱등 기록이 하나도 남지 않으며, 같은 키는 처음 요청으로 남는다 [ASVS v5.0.0-2.3.4]',
    async (status) => {
      const s = fresh();
      const o = await placed(s);
      const attemptId = await putAttempt(s, o, { status });
      const before = await traceOf(o);
      const attemptBefore = await attemptRow(attemptId);
      const once = onceOf(o);

      expect(await s.accepts.accept(once, inputOf(o, attemptId))).toEqual({ status: 'STALE', reason: 'ATTEMPT_GONE', current: status });

      expect(await traceOf(o)).toEqual(before);
      expect(before).toEqual({ order: { status: 'CREATED', event_seq: 1, seat_gen: null }, history: 1, outbox: 1, saga: 0, idem: [] });
      expect(await attemptRow(attemptId)).toEqual(attemptBefore);
      expect(await s.accepts.findCommitted(once)).toEqual({ status: 'NONE' });
    },
  );

  test.each<[string, readonly TransitionId[], string]>([
    ['EXPIRED(T5)', ['T5'], 'EXPIRED'],
    ['AUTHENTICATED(T3)', ['T3'], 'AUTHENTICATED'],
    ['ACCEPTED(T3·T4)', ['T3', 'T4'], 'ACCEPTED'],
  ])(
    '주문이 %s면 STALE ORDER_STATE와 지금 상태(current)이고, 시도는 READY로 돌아가며(결제 참조·시각 비움) 아무것도 남지 않는다 [ASVS v5.0.0-2.3.4]',
    async (_label, path, current) => {
      const s = fresh();
      const o = await placed(s);
      await walk(s, o, path);
      const attemptId = await putAttempt(s, o);
      const before = await traceOf(o);
      const once = onceOf(o);

      expect(await s.accepts.accept(once, inputOf(o, attemptId))).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current });

      expect(await traceOf(o)).toEqual(before);
      expect(before.idem).toEqual([]);
      expect(before.saga).toBe(0);
      expect(await attemptRow(attemptId)).toEqual({
        status: 'READY',
        pg_payment_key: null,
        pg_tx_id: null,
        pg_payment_token: null,
        authenticated_at: null,
        accepted_at: null,
      });
      expect(await s.accepts.findCommitted(once)).toEqual({ status: 'NONE' });
    },
  );
});

// ───────────────────────────── accept: 입력 검사 ─────────────────────────────

describe('DrizzleOrderAccepts.accept 입력 검사(RangeError, DB에 가지 않는다)', () => {
  test.each<[string, (i: AcceptInput) => AcceptInput]>([
    ['orderId가 UUID가 아님', (i) => ({ ...i, orderId: 'order-1' })],
    ['orderId가 대문자 UUID', (i) => ({ ...i, orderId: i.orderId.toUpperCase() })],
    ['attemptId가 UUID가 아님', (i) => ({ ...i, attemptId: 'attempt-1' })],
    ['eventId가 UUID가 아님', (i) => ({ ...i, eventId: 'ev-1' })],
    ['seatGen 0', (i) => ({ ...i, seatGen: 0 })],
    ['seatGen 음수', (i) => ({ ...i, seatGen: -1 })],
    ['seatGen 소수', (i) => ({ ...i, seatGen: 1.5 })],
    ['seatGen이 int4를 넘음', (i) => ({ ...i, seatGen: 2 ** 31 })],
    ['seatGen NaN', (i) => ({ ...i, seatGen: Number.NaN })],
    ['토스 paymentKey 빈 글', (i) => ({ ...i, refs: { pg: 'TOSS', paymentKey: '' } })],
    ['포트원 txId 빈 글', (i) => ({ ...i, refs: { pg: 'PORTONE', txId: '', paymentToken: 'ptok_1' } })],
    ['포트원 paymentToken 빈 글', (i) => ({ ...i, refs: { pg: 'PORTONE', txId: 'tx-1', paymentToken: '' } })],
    ['토스인데 포트원 칸', (i) => ({ ...i, refs: { pg: 'TOSS', txId: 'tx-1', paymentToken: 'ptok_1' } as unknown as PaymentRefs })],
    ['모르는 결제사', (i) => ({ ...i, refs: { pg: 'KAKAO', paymentKey: 'k' } as unknown as PaymentRefs })],
    ['행위자 모양이 틀림', (i) => ({ ...i, actor: 'fan:abc' })],
  ])('%s면 RangeError이고 멱등 기록·시도·주문이 그대로이며, 맞는 입력으로 다시 부르면 ACCEPTED다 [ASVS v5.0.0-2.2.1]', async (_label, change) => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    const once = onceOf(o);
    const good = inputOf(o, attemptId);
    const before = await traceOf(o);

    await expect(s.accepts.accept(once, change(good))).rejects.toThrow(RangeError);

    expect(await traceOf(o)).toEqual(before);
    expect((await attemptRow(attemptId))?.status).toBe('READY');
    expect(await s.accepts.accept(once, good)).toEqual({ status: 'ACCEPTED' });
  });
});

// ───────────────────────────── accept: 동시성 ─────────────────────────────

describe('DrizzleOrderAccepts.accept 동시성(data.md §5 결제 접수)', () => {
  test('PT23_같은 주문을 두 탭이 다른 멱등 키로 두 연결에서 동시에 접수하면 하나는 ACCEPTED, 하나는 STALE ATTEMPT_TAKEN이고 Saga 작업 행 하나·이력 빈틈 없음·이긴 쪽의 키와 결제 참조만 남는다(다섯 번) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = fresh();
      const o = await placed(s);
      const attemptId = await putAttempt(s, o);
      const tabs = [0, 1].map(() => ({ once: onceOf(o), input: inputOf(o, attemptId, tossRefs()) }));

      const settled = await Promise.allSettled(tabs.map((t) => s.accepts.accept(t.once, t.input)));

      expect(rejections(settled), `${round}회`).toEqual([]);
      const out = settled.map((x) => (x as PromiseFulfilledResult<AcceptOutcome>).value);
      expect(out.map((x) => x.status).sort(), `${round}회`).toEqual(['ACCEPTED', 'STALE']);
      // 진 쪽은 주문 행 잠금(T3)에서 기다렸다가 0행이 된다(리뷰 고침 M2: 잠금 차례 주문 행 → 결제 시도 행)
      expect(out.find((x) => x.status === 'STALE'), `${round}회`).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' });
      const winner = tabs[out.findIndex((x) => x.status === 'ACCEPTED')]!;
      expect((await sagaJobsOf(o.id)).length, `${round}회`).toBe(1);
      expect((await historyOf(o.id)).map((h) => h.seq), `${round}회`).toEqual([1, 2, 3]);
      expect(await orderRow(o.id)).toMatchObject({ status: 'ACCEPTED', event_seq: 3 });
      expect((await acceptIdemRows(o.accountId)).map((r) => r.idempotency_key), `${round}회`).toEqual([winner.once.key]);
      expect((await attemptRow(attemptId))?.pg_payment_key, `${round}회`).toBe((winner.input.refs as { paymentKey: string }).paymentKey);
      expect((await outboxOf(o.eventId)).map((x) => x.event.type), `${round}회`).toEqual(['CREATED', 'ACCEPTED']);
    }
  });

  test('같은 키·같은 지문의 두 접수를 동시에 보내면 하나는 ACCEPTED, 다른 하나는 REPLAYED(또는 1초 [가정] 안에 끝나지 않으면 409 idempotency-request-in-progress)이고 Saga 작업 행은 하나다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = fresh();
      const o = await placed(s);
      const attemptId = await putAttempt(s, o);
      const once = onceOf(o);

      const settled = await Promise.allSettled([s.accepts.accept(once, inputOf(o, attemptId)), s.accepts.accept(once, inputOf(o, attemptId))]);

      const ok = settled.filter((x): x is PromiseFulfilledResult<AcceptOutcome> => x.status === 'fulfilled').map((x) => x.value);
      const bad = settled.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => x.reason as unknown);
      expect(ok.filter((x) => x.status === 'ACCEPTED'), `${round}회`).toHaveLength(1);
      for (const x of ok.filter((y) => y.status !== 'ACCEPTED')) expect(x, `${round}회`).toEqual({ status: 'REPLAYED' });
      for (const e of bad) expect(e, `${round}회 ${messagesOf(e)}`).toMatchObject({ status: 409, slug: 'idempotency-request-in-progress' });
      expect((await sagaJobsOf(o.id)).length).toBe(1);
      expect((await historyOf(o.id)).map((h) => h.seq)).toEqual([1, 2, 3]);
    }
  });

  test('주문 만료(T5)가 주문 행을 잡은 채 있는 동안 접수가 오면 접수는 T3에서 기다리고, 만료가 커밋되면 STALE ORDER_STATE EXPIRED로 되돌린다(시도 READY 그대로, 멱등 기록 없음) [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    const once = onceOf(o);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let expired = false;
    const expiring = race.transaction(async (tx) => {
      const r = await s.store.transition(tx, { orderId: o.id, transition: 'T5', actor: SAGA });
      expect(r.status).toBe('APPLIED');
      expired = true;
      await gate;
    });
    let settled = false;
    try {
      expect(await waitFor(async () => expired, 5_000)).toBe(true);
      const accepting = s.accepts.accept(once, inputOf(o, attemptId)).finally(() => {
        settled = true;
      });
      accepting.catch(() => undefined);
      // 접수가 주문 행 잠금을 기다리는 것을 본다(뼈대처럼 바로 끝나면 기다리지 않는다)
      const waited = await waitFor(async () => settled || (await lockWaiters()) > 0, 5_000);
      expect(waited).toBe(true);
      expect(settled).toBe(false);
      release();
      await expiring;
      expect(await accepting).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'EXPIRED' });
    } finally {
      release();
      await expiring.catch(() => undefined);
    }
    expect(await orderRow(o.id)).toEqual({ status: 'EXPIRED', event_seq: 2, seat_gen: null });
    expect((await attemptRow(attemptId))?.status).toBe('READY');
    expect(await acceptIdemRows(o.accountId)).toEqual([]);
    expect(await sagaJobsOf(o.id)).toEqual([]);
  });

  test.each(['SUPERSEDED', 'EXPIRED'])(
    'PT28_결제 시도를 다른 연결이 잡은 채 %s로 바꾸는 동안 접수가 오면 접수는 시도 UPDATE에서 기다리고, 그 바꾸기가 커밋되면 STALE ATTEMPT_GONE이며 T3까지 되돌린다(리뷰 고침 M2) [ASVS v5.0.0-15.4.1]',
    async (status) => {
      const s = fresh();
      const o = await placed(s);
      const attemptId = await putAttempt(s, o);
      const once = onceOf(o);
      const c = await race.pool.connect();
      let settled = false;
      try {
        await c.query('begin');
        await c.query('select id from payment_attempt where id = $1 for update', [attemptId]);
        const accepting = s.accepts.accept(once, inputOf(o, attemptId)).finally(() => {
          settled = true;
        });
        accepting.catch(() => undefined);
        expect(await waitFor(async () => settled || (await lockWaiters()) > 0, 5_000)).toBe(true);
        expect(settled).toBe(false);
        await c.query('update payment_attempt set status = $2 where id = $1', [attemptId, status]);
        await c.query('commit');
        expect(await accepting).toEqual({ status: 'STALE', reason: 'ATTEMPT_GONE', current: status });
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
      expect(await orderRow(o.id)).toEqual({ status: 'CREATED', event_seq: 1, seat_gen: null });
      expect((await historyOf(o.id)).length).toBe(1);
      expect(await acceptIdemRows(o.accountId)).toEqual([]);
      expect(await sagaJobsOf(o.id)).toEqual([]);
    },
  );

  test('L3_서버 기본 격리 수준이 repeatable read인 연결 풀에서도 두 탭 경합은 진 쪽이 STALE ORDER_STATE로 끝난다(직렬화 실패 40001이 아니다, 트랜잭션이 read committed를 건다) [ASVS v5.0.0-15.4.1]', async () => {
    const u = new URL(server.url);
    u.searchParams.set('options', '-c default_transaction_isolation=repeatable\\ read');
    const rr = createDatabase({ url: u.toString(), profile: 'general', max: 4, applicationName: `${APP}-rr` });
    try {
      // 풀 기본이 정말 repeatable read인지 먼저 본다(시험이 헛돌지 않게)
      expect((await rr.pool.query('show transaction_isolation')).rows[0]).toEqual({ transaction_isolation: 'repeatable read' });
      for (let round = 0; round < 3; round += 1) {
        const s = fresh();
        const accepts = new DrizzleOrderAccepts({ database: rr, store: s.store, clock: s.clock });
        const o = await placed(s);
        const attemptId = await putAttempt(s, o);
        const settled = await Promise.allSettled([0, 1].map(() => accepts.accept(onceOf(o), inputOf(o, attemptId))));
        expect(rejections(settled), `${round}회`).toEqual([]);
        const out = settled.map((x) => (x as PromiseFulfilledResult<AcceptOutcome>).value);
        expect(out.map((x) => x.status).sort(), `${round}회`).toEqual(['ACCEPTED', 'STALE']);
        expect(out.find((x) => x.status === 'STALE'), `${round}회`).toEqual({ status: 'STALE', reason: 'ORDER_STATE', current: 'ACCEPTED' });
      }
    } finally {
      await rr.close();
    }
  });
});

// ───────────────────────────── accept: 문장 차례 ─────────────────────────────

describe('DrizzleOrderAccepts.accept 문장 차례(리뷰 고침 M2, ADR-0116 결정 3)', () => {
  /** tx.execute를 감싸 문장마다 '첫 낱말 표 이름'을 적는 Database(나머지는 그대로 넘긴다) */
  function recordingDatabase(inner: Database) {
    const dialect = new PgDialect();
    const statements: string[] = [];
    const db: Database = {
      db: inner.db,
      pool: inner.pool,
      close: () => inner.close(),
      transaction: (fn, opts) =>
        inner.transaction((tx) => {
          const wrapped = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === 'execute') {
                return (q: SQL) => {
                  const text = dialect.sqlToQuery(q).sql.trim().replace(/\s+/g, ' ').toLowerCase();
                  const m = /^(insert into|update|select|delete from)\s+"?([a-z_]+)"?/.exec(text);
                  statements.push(m ? `${m[1]} ${m[2]}` : text.slice(0, 40));
                  return target.execute(q);
                };
              }
              const v = Reflect.get(target, prop, receiver) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          });
          return fn(wrapped);
        }, opts),
    };
    return { db, statements };
  }

  test('주문 행 잠금(T3·T4 한 UPDATE) → order_event(T3·T4) → 결제 시도 → Saga 작업 → Outbox(T4)이고, Outbox INSERT 뒤에는 멱등 기록 result_ref UPDATE뿐이다 [ASVS v5.0.0-15.4.1]', async () => {
    const s = fresh();
    const o = await placed(s);
    const attemptId = await putAttempt(s, o);
    const rec = recordingDatabase(database);
    const accepts = new DrizzleOrderAccepts({ database: rec.db, store: s.store, clock: s.clock });

    expect(await accepts.accept(onceOf(o), inputOf(o, attemptId))).toEqual({ status: 'ACCEPTED' });

    const writes = rec.statements.filter((x) => x.startsWith('insert') || x.startsWith('update'));
    expect(writes).toEqual([
      'insert into order_idempotency',
      // T3·T4(주문 행 한 번, T3 이력 + T4 이력·사건)
      'update purchase_order',
      'insert into order_event',
      'update payment_attempt',
      'insert into order_saga_job',
      'insert into outbox',
      'update order_idempotency',
    ]);
    // 주문 행을 처음 바꾸는 문장(T3·T4)이 결제 시도 UPDATE보다 앞이다
    expect(writes.indexOf('update purchase_order')).toBeLessThan(writes.indexOf('update payment_attempt'));
    const afterOutbox = rec.statements.slice(rec.statements.lastIndexOf('insert into outbox') + 1);
    expect(afterOutbox).toEqual(['update order_idempotency']);
  });
});
