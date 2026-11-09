// 주문 생성의 purchase DB 쓰기(booking DrizzleOrderWrites)를 실제 PostgreSQL 18로 돈다(BUILD_ORDER PRF-161).
// 정본: docs/features/payment.md §2 '주문 생성의 첫 구현'(검사 차례의 커밋된 멱등 기록 읽기, 같은 홀드의 두 주문), docs/data.md purchase_order(hold_id 유일·purchase_session_id, 마이그레이션 0004)·
// §5 '주문 생성' 줄(같은 홀드 두 주문 동시, 같은 멱등 키 겹침), docs/api/guidelines.md §4(멱등 키), booking domain/ports.ts OrderWrites·adapters/db/drizzle-order-writes.ts의 설명.
//
// 약속:
// - 마이그레이션은 scripts/migrate.mjs의 migratePurchase, Outbox 일 파티션은 ensureOutboxPartitions(기준 시각의 가짜 시계)로 만든다(order-store.int.test.ts와 같다).
// - 시험마다 새 주문·새 회차·새 계정을 쓰고 표를 비우지 않는다. 시각은 시험마다 따로 만든 가짜 시계다.
// - DB 상태는 쓰기 어댑터를 거치지 않고 admin 풀의 직접 SQL로 읽는다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, ProblemError, requestFingerprint, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleOrderStore, DrizzleOrderWrites, ORDER_HOLD_KEY, type NewOrder, type OrderCreateOutcome, type OrderRequestOnce, type OrderView } from '../src/modules/booking/index.js';
import { BASE_MS, DAY, makeItems, messagesOf, newOrderInput, pgCodesOf, rejections } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 쓰기 어댑터가 쓰는 풀(동시성 시험이 연결 여럿을 쓴다) */
let database: Database;
/** 읽기·준비용 풀 */
let admin: Database;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 20, applicationName: 'order-writes-test' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'order-writes-admin' });
  await ensureOutboxPartitions(admin, fakeClock({ now: BASE_MS }));
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(text, params))[0]!.n);

/** 시험 하나의 가짜 시계와 쓰기 어댑터 */
function fresh(startMs = BASE_MS) {
  const clock = fakeClock({ now: startMs });
  const store = new DrizzleOrderStore({ clock });
  return { clock, store, writes: new DrizzleOrderWrites({ database, store, clock }) };
}
type Fresh = ReturnType<typeof fresh>;

/** 주문 생성 요청 지문(platform requestFingerprint: 메서드·경로·본문) */
const fingerprint = (body: unknown) => requestFingerprint('POST', '/v1/orders', Buffer.from(JSON.stringify(body), 'utf8'));

/** 주문과 그 요청의 멱등 값(범위 = 그 계정 × CREATE_ORDER × 주문의 멱등 키, 지문 = 본문 holdId) */
function orderAndOnce(s: Fresh, o: Partial<NewOrder> = {}, body?: unknown): { order: NewOrder; once: OrderRequestOnce } {
  const order = newOrderInput(s.clock, o);
  return {
    order,
    once: { accountRef: order.accountId, operation: 'CREATE_ORDER', key: order.idempotencyKey, requestHash: fingerprint(body ?? { holdId: order.holdId }) },
  };
}

/** 응답 Order와 재생에 쓰는 주문 모습의 기대 값(줄 번호 차례) */
const viewOf = (o: NewOrder): OrderView => ({ orderId: o.id, amount: o.amount, status: 'CREATED', items: o.items.map((it) => ({ ...it })) });

const orderRow = async (id: string) =>
  (
    await q<{ id: string; account_id: string; hold_id: string; purchase_session_id: string; idempotency_key: string; status: string }>(
      'select id, account_id, hold_id, purchase_session_id, idempotency_key, status from purchase_order where id = $1',
      [id],
    )
  )[0];
const ordersOfHold = (holdId: string) => count('select count(*) as n from purchase_order where hold_id = $1', [holdId]);
const ordersOfAccount = (accountId: string) => count('select count(*) as n from purchase_order where account_id = $1', [accountId]);
const idemRows = (accountRef: string) =>
  q<{ idempotency_key: string; request_hash: Buffer; result_ref: string | null; created_at: Date }>(
    `select idempotency_key, request_hash, result_ref, created_at from order_idempotency where account_ref = $1 and operation = 'CREATE_ORDER' order by created_at, idempotency_key`,
    [accountRef],
  );
const outboxCount = (eventId: string) => count('select count(*) as n from outbox where msg_key = $1', [eventId]);
const historyCount = (orderId: string) => count('select count(*) as n from order_event where order_id = $1', [orderId]);

/** 처리 중(result_ref 비어 있음)이거나 결과 참조를 손으로 넣은 멱등 기록 */
const putIdem = (once: OrderRequestOnce, resultRef: string | null, createdAtMs: number) =>
  q('insert into order_idempotency (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, $5, $6)', [
    once.accountRef,
    once.operation,
    once.key,
    Buffer.from(once.requestHash),
    resultRef,
    new Date(createdAtMs),
  ]);

const created = (r: OrderCreateOutcome) => {
  expect(r.status).toBe('CREATED');
  return (r as Extract<OrderCreateOutcome, { status: 'CREATED' }>).order;
};

// ───────────────────────────── findCommitted ─────────────────────────────

describe('DrizzleOrderWrites.findCommitted(트랜잭션 밖의 커밋된 멱등 기록 읽기)', () => {
  test('기록이 없으면 NONE이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    expect(await s.writes.findCommitted(once)).toEqual({ status: 'NONE' });
    expect(await idemRows(order.accountId)).toEqual([]);
  });

  test('PT45_①_같은 키·같은 지문으로 커밋한 주문이 있으면 COMMITTED와 그 주문(처음 201의 모습)이다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    created(await s.writes.create(once, order));
    expect(await s.writes.findCommitted(once)).toEqual({ status: 'COMMITTED', order: viewOf(order) });
  });

  test('PT45_②_같은 키에 다른 지문(다른 holdId)이면 MISMATCH다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    created(await s.writes.create(once, order));
    expect(await s.writes.findCommitted({ ...once, requestHash: fingerprint({ holdId: uuidv7(s.clock) }) })).toEqual({ status: 'MISMATCH' });
  });

  test('PT45_④_범위는 계정 × CREATE_ORDER다: 다른 계정의 같은 키·같은 지문, 같은 계정의 다른 작업(START_PAYMENT) 기록은 NONE이다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    created(await s.writes.create(once, order));
    expect(await s.writes.findCommitted({ ...once, accountRef: randomUUID() })).toEqual({ status: 'NONE' });
    const other = { ...once, key: randomUUID() };
    await putIdem({ ...other, operation: 'START_PAYMENT' }, order.id, s.clock.now());
    expect(await s.writes.findCommitted(other)).toEqual({ status: 'NONE' });
  });

  test('처리 중인 기록(result_ref 비어 있음)은 NONE이다(검사를 이어 간다)', async () => {
    const s = fresh();
    const { once } = orderAndOnce(s);
    await putIdem(once, null, s.clock.now());
    expect(await s.writes.findCommitted(once)).toEqual({ status: 'NONE' });
  });

  test('PT45_⑥_보관 기간(24시간 [가정])이 지난 기록은 NONE이고, 지나기 전이면 COMMITTED다', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    created(await s.writes.create(once, order));
    const before = new DrizzleOrderWrites({ database, store: s.store, clock: fakeClock({ now: BASE_MS + DAY - 1 }) });
    expect((await before.findCommitted(once)).status).toBe('COMMITTED');
    const after = new DrizzleOrderWrites({ database, store: s.store, clock: fakeClock({ now: BASE_MS + DAY + 1 }) });
    expect(await after.findCommitted(once)).toEqual({ status: 'NONE' });
  });

  // 리뷰 고침 L2(2026-11-05): 멱등 재생은 처음 201 본문이다. 주문이 뒤 상태로 갔어도 status CREATED와 처음 금액·항목을 돌려준다
  test('PT45_①_주문이 T3·T4로 ACCEPTED까지 간 뒤에도 같은 키·같은 지문은 처음 201 모습(status CREATED, 처음 금액·항목)이다: 커밋된 기록 읽기와 트랜잭션 안 재생 둘 다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s, { items: makeItems(2) });
    created(await s.writes.create(once, order));
    for (const transition of ['T3', 'T4'] as const) {
      const r = await database.transaction((tx) => s.store.transition(tx, { orderId: order.id, transition, actor: 'system:order-writes-test' }));
      expect(r.status, transition).toBe('APPLIED');
    }
    expect((await orderRow(order.id))?.status).toBe('ACCEPTED');
    expect(await s.writes.findCommitted(once)).toEqual({ status: 'COMMITTED', order: viewOf(order) });
    const again = { ...newOrderInput(s.clock, { accountId: order.accountId, idempotencyKey: order.idempotencyKey }), holdId: order.holdId };
    expect(await s.writes.create(once, again)).toEqual({ status: 'REPLAYED', order: viewOf(order) });
  });

  test('결과 참조가 가리키는 주문이 없으면(멱등 기록과 주문이 어긋남) Error다', async () => {
    const s = fresh();
    const { once } = orderAndOnce(s);
    // 결과 참조를 넣기 전에는 NONE이다(읽기가 되는 어댑터에서)
    expect(await s.writes.findCommitted(once)).toEqual({ status: 'NONE' });
    await putIdem(once, uuidv7(s.clock), s.clock.now());
    await expect(s.writes.findCommitted(once)).rejects.toThrow(Error);
  });
});

// ───────────────────────────── create ─────────────────────────────

describe('DrizzleOrderWrites.create(한 트랜잭션: 멱등 기록 잡기 → 주문 만들기)', () => {
  test('CREATED: 주문 행(hold_id·purchase_session_id 포함)·이력 1·Outbox CREATED 하나·멱등 기록(결과 참조 = 주문 ID, 지문, 시계 시각)을 쓰고 주문 모습을 돌려준다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s, { items: makeItems(2) });

    const r = await s.writes.create(once, order);

    expect(r).toEqual({ status: 'CREATED', order: viewOf(order) });
    expect(await orderRow(order.id)).toEqual({
      id: order.id,
      account_id: order.accountId,
      hold_id: order.holdId,
      purchase_session_id: order.purchaseSessionId,
      idempotency_key: order.idempotencyKey,
      status: 'CREATED',
    });
    expect(await historyCount(order.id)).toBe(1);
    expect(await outboxCount(order.eventId)).toBe(1);
    expect(await idemRows(order.accountId)).toEqual([{ idempotency_key: once.key, request_hash: Buffer.from(once.requestHash), result_ref: order.id, created_at: new Date(s.clock.now()) }]);
  });

  test('PT45_①_같은 키·같은 지문으로 다시 만들면(새 주문 ID로 불러도) REPLAYED와 처음 주문이고 새 행이 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    created(await s.writes.create(once, order));
    s.clock.advance(1000);
    const again = { ...newOrderInput(s.clock, { accountId: order.accountId, idempotencyKey: order.idempotencyKey }), holdId: order.holdId };

    expect(await s.writes.create(once, again)).toEqual({ status: 'REPLAYED', order: viewOf(order) });

    expect(await ordersOfAccount(order.accountId)).toBe(1);
    expect(await orderRow(again.id)).toBeUndefined();
    expect(await outboxCount(again.eventId)).toBe(0);
    expect(await idemRows(order.accountId)).toHaveLength(1);
  });

  test('PT45_②_같은 키에 다른 지문으로 만들면 422 idempotency-key-reused(ProblemError)이고 새 주문이 없다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    created(await s.writes.create(once, order));
    const other = newOrderInput(s.clock, { accountId: order.accountId, idempotencyKey: order.idempotencyKey });

    const err = await s.writes.create({ ...once, requestHash: fingerprint({ holdId: other.holdId }) }, other).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 422, slug: 'idempotency-key-reused' });
    expect(await orderRow(other.id)).toBeUndefined();
    expect(await ordersOfAccount(order.accountId)).toBe(1);
  });

  test('PT45_④_다른 계정이 같은 키로 만들면 따로 처리된다(둘 다 CREATED, 멱등 기록 둘) [ASVS v5.0.0-2.3.3]', async () => {
    const s = fresh();
    const a = orderAndOnce(s);
    const b = orderAndOnce(s, { idempotencyKey: a.order.idempotencyKey });
    created(await s.writes.create(a.once, a.order));
    created(await s.writes.create(b.once, b.order));
    expect(await idemRows(a.order.accountId)).toHaveLength(1);
    expect(await idemRows(b.order.accountId)).toHaveLength(1);
  });

  test('같은 홀드로 다른 멱등 키의 주문을 만들면 HOLD_ALREADY_ORDERED이고 둘째의 주문·이력·Outbox·멱등 기록이 하나도 남지 않는다(트랜잭션째 되돌림) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const first = orderAndOnce(s);
    created(await s.writes.create(first.once, first.order));
    const second = orderAndOnce(s, { accountId: first.order.accountId, holdId: first.order.holdId, purchaseSessionId: first.order.purchaseSessionId });

    expect(await s.writes.create(second.once, second.order)).toEqual({ status: 'HOLD_ALREADY_ORDERED' });

    expect(await ordersOfHold(first.order.holdId)).toBe(1);
    expect(await orderRow(second.order.id)).toBeUndefined();
    expect(await historyCount(second.order.id)).toBe(0);
    expect(await outboxCount(second.order.eventId)).toBe(0);
    expect((await idemRows(first.order.accountId)).map((r) => r.idempotency_key)).toEqual([first.once.key]);
    // 키 행이 남지 않았으니 같은 둘째 키로 다른 홀드의 주문은 처음 요청이다
    const retry = { ...newOrderInput(s.clock, { accountId: first.order.accountId, idempotencyKey: second.order.idempotencyKey }) };
    expect((await s.writes.create({ ...second.once, requestHash: fingerprint({ holdId: retry.holdId }) }, retry)).status).toBe('CREATED');
  });

  test('다른 계정이 같은 hold_id로 만들어도 HOLD_ALREADY_ORDERED다(한 홀드에 주문 하나는 계정을 가리지 않는 유일 인덱스) [ASVS v5.0.0-2.3.4]', async () => {
    const s = fresh();
    const first = orderAndOnce(s);
    created(await s.writes.create(first.once, first.order));
    const second = orderAndOnce(s, { holdId: first.order.holdId });
    expect(await s.writes.create(second.once, second.order)).toEqual({ status: 'HOLD_ALREADY_ORDERED' });
    expect(await idemRows(second.order.accountId)).toEqual([]);
  });

  test('유일 인덱스 이름은 purchase_order_hold_key이고 ORDER_HOLD_KEY와 같다. 그 밖의 23505(주문 ID 기본 키 위반)는 HOLD_ALREADY_ORDERED가 아니라 그대로 던지고 멱등 기록이 남지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    expect(ORDER_HOLD_KEY).toBe('purchase_order_hold_key');
    const s = fresh();
    const first = orderAndOnce(s);
    created(await s.writes.create(first.once, first.order));
    const dup = orderAndOnce(s, { id: first.order.id });

    const err = await s.writes.create(dup.once, dup.order).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProblemError);
    expect(pgCodesOf(err), messagesOf(err)).toContain('23505');
    expect(await idemRows(dup.order.accountId)).toEqual([]);
    expect(await outboxCount(dup.order.eventId)).toBe(0);
  });

  test.each<[string, (o: NewOrder) => NewOrder]>([
    ['홀드 ID가 UUID가 아님', (o) => ({ ...o, holdId: 'hold-1' })],
    ['항목 0개', (o) => ({ ...o, items: [] })],
    ['금액 음수', (o) => ({ ...o, amount: -1 })],
  ])('입력이 틀리면(%s) RangeError이고 멱등 기록·주문이 남지 않는다 [ASVS v5.0.0-2.2.1]', async (_label, change) => {
    const s = fresh();
    const { order, once } = orderAndOnce(s);
    await expect(s.writes.create(once, change(order))).rejects.toThrow(RangeError);
    expect(await idemRows(order.accountId)).toEqual([]);
    expect(await orderRow(order.id)).toBeUndefined();
  });

  test('readOrder는 주문 행과 항목(줄 번호 차례, unitPrice)으로 주문 모습을 만들고, 없는 주문은 undefined다', async () => {
    const s = fresh();
    const { order, once } = orderAndOnce(s, { items: makeItems(4) });
    created(await s.writes.create(once, order));
    expect(await s.writes.readOrder(order.id)).toEqual(viewOf(order));
    expect(await s.writes.readOrder(uuidv7(s.clock))).toBeUndefined();
  });
});

// ───────────────────────────── 동시성 ─────────────────────────────

describe('DrizzleOrderWrites.create 동시성(data.md §5 주문 생성)', () => {
  test('같은 홀드의 두 주문을 두 연결로 동시에(다른 멱등 키) 만들면 하나는 CREATED, 하나는 HOLD_ALREADY_ORDERED이고 주문 행은 하나다(다섯 번) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = fresh();
      const a = orderAndOnce(s);
      const b = orderAndOnce(s, { accountId: a.order.accountId, holdId: a.order.holdId, purchaseSessionId: a.order.purchaseSessionId });

      const settled = await Promise.allSettled([s.writes.create(a.once, a.order), s.writes.create(b.once, b.order)]);

      expect(rejections(settled), `${round}회`).toEqual([]);
      const outcomes = settled.map((x) => (x as PromiseFulfilledResult<OrderCreateOutcome>).value.status).sort();
      expect(outcomes, `${round}회`).toEqual(['CREATED', 'HOLD_ALREADY_ORDERED']);
      expect(await ordersOfHold(a.order.holdId)).toBe(1);
      // 이긴 쪽의 키 행 하나만 남는다
      expect(await idemRows(a.order.accountId)).toHaveLength(1);
      const winner = (await idemRows(a.order.accountId))[0]!;
      expect([a.once.key, b.once.key]).toContain(winner.idempotency_key);
      // 누가 이길지는 정할 수 없다. 이긴 쪽의 회차 ID로 Outbox 행 하나, 진 쪽 회차로는 0(b의 회차 ID는 따로 무작위다)
      const [won, lost] = winner.idempotency_key === a.once.key ? [a, b] : [b, a];
      expect(await outboxCount(won.order.eventId)).toBe(1);
      expect(await outboxCount(lost.order.eventId)).toBe(0);
    }
  });

  test('같은 키·같은 지문의 두 요청을 동시에 보내면 하나는 CREATED, 다른 하나는 같은 주문의 REPLAYED(또는 1초 [가정] 안에 끝나지 않으면 409 idempotency-request-in-progress)이고 주문은 하나다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-15.4.1]', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = fresh();
      const { order, once } = orderAndOnce(s);
      const twin = { ...newOrderInput(s.clock, { accountId: order.accountId, idempotencyKey: order.idempotencyKey }), holdId: order.holdId };

      const settled = await Promise.allSettled([s.writes.create(once, order), s.writes.create(once, twin)]);

      const ok = settled.filter((x): x is PromiseFulfilledResult<OrderCreateOutcome> => x.status === 'fulfilled').map((x) => x.value);
      const bad = settled.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => x.reason as unknown);
      expect(ok.filter((x) => x.status === 'CREATED'), `${round}회`).toHaveLength(1);
      const winner = (ok.find((x) => x.status === 'CREATED') as Extract<OrderCreateOutcome, { status: 'CREATED' }>).order;
      for (const x of ok.filter((y) => y.status !== 'CREATED')) expect(x, `${round}회`).toEqual({ status: 'REPLAYED', order: winner });
      for (const e of bad) expect(e, `${round}회 ${messagesOf(e)}`).toMatchObject({ status: 409, slug: 'idempotency-request-in-progress' });
      expect(await ordersOfAccount(order.accountId)).toBe(1);
      expect(await ordersOfHold(order.holdId)).toBe(1);
    }
  });
});
