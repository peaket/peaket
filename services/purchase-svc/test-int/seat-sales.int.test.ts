// 판매 확정(Hard Sale) 저장소 `SeatSales`(DrizzleSeatSales)의 통합 시험: 실제 PostgreSQL 18 컨테이너 하나를 describe 전체가 나눠 쓴다.
// 규칙의 정본은 docs/features/seat-hold.md §6 'Hard Sale 저장소의 첫 구현'이고, 경합 행은 docs/data.md §5 '결제 접수 reserve'·'다중 좌석 판매 확정 때 DB 트랜잭션 간 데드락',
// 시험 행은 seat-hold.md §12의 S-T7·S-T8·S-T10·S-T11이다(BUILD_ORDER PRF-140 ①).
//
// 약속 두 가지:
// - 시험마다 새 회차 ID(소문자 UUID)를 써서 서로 영향이 없다. 표를 비우지 않는다.
// - DB 상태는 저장소를 거치지 않고 `admin.pool.query`의 직접 SQL로 읽어 단언한다(저장소가 자기 상태를 스스로 증명하지 않게).
//
// 풀: 순서대로 도는 시험은 핫패스 풀(대기 100ms, 연결 10개)을 쓴다. 동시성 시험은 호출 수보다 큰 풀(general 대기 1초)을 쓰고,
// 시험 앞에서 연결을 미리 맺어 두어(warm) '연결 맺기가 몰려 429로 거절되는' 우연한 실패를 없앤다. 풀 대기 초과가 주제인 시험(17번)만 일부러 작은 핫패스 풀을 쓴다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type AddressInfo, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDatabase, type Database, ProblemError } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleSeatSales, type ReserveInput, type ReserveResult, type SeatSaleOrder, type SeatSaleRelease, type SeatSales } from '../src/modules/inventory/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 핫패스 풀(대기 100ms, 연결 10개): 순서대로 도는 시험이 저장소에 넘긴다 */
let database: Database;
let sales: SeatSales;
/** 읽기·뒷정리용 풀. 저장소가 쓰는 풀과 따로 둬서 읽기가 저장소의 연결을 뺏지 않는다 */
let admin: Database;
/** 동시성 시험용 풀(general 대기 1초, 연결 50개) */
let wide: Database;
let wideSales: SeatSales;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  database = createDatabase({ url: server.url, profile: 'hot', max: 10, applicationName: 'seat-sales-hot' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'seat-sales-admin' });
  wide = createDatabase({ url: server.url, profile: 'general', max: 50, applicationName: 'seat-sales-wide' });
  sales = new DrizzleSeatSales(database);
  wideSales = new DrizzleSeatSales(wide);
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close(), wide?.close()]);
  server?.stop();
});

// 핫패스 풀은 쉬는 연결이 10초 지나면 닫히고 새 연결을 맺는 데 걸리는 시간이 대기 한도(100ms)를 먹는다.
// 시험마다 쉬는 연결 하나를 미리 만들어 두면 저장소 호출이 곧바로 그 연결을 쓴다
beforeEach(async () => {
  await warm(database, 1);
});

// ───────────────────────────── 도우미 ─────────────────────────────

/** 정렬 순서가 분명한 좌석 ID(소문자 UUID). seatId(2) < seatId(10)이 문자 코드 순에서도 성립한다 */
const seatId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const seatIds = (count: number, from = 1): string[] => Array.from({ length: count }, (_, i) => seatId(from + i));
const randomSeats = (count: number): string[] => Array.from({ length: count }, () => randomUUID());

interface Party {
  eventId: string;
  accountId: string;
  orderId: string;
}
/** 새 구매자(계정)와 주문. 회차를 주면 그 회차의 새 구매자 */
const newParty = (eventId: string = randomUUID()): Party => ({ eventId, accountId: randomUUID(), orderId: randomUUID() });
/** 같은 계정·같은 회차의 다른 주문 */
const nextOrder = (p: Party): Party => ({ ...p, orderId: randomUUID() });

const reserveOf = (p: Party, seats: readonly string[], extra: { limit?: number; pendingUntilMs?: number } = {}): ReserveInput => ({
  eventId: p.eventId,
  accountId: p.accountId,
  orderId: p.orderId,
  seatIds: seats,
  limit: extra.limit ?? 4,
  ...(extra.pendingUntilMs === undefined ? {} : { pendingUntilMs: extra.pendingUntilMs }),
});
const orderOf = (p: Party, seats: readonly string[]): SeatSaleOrder => ({ eventId: p.eventId, orderId: p.orderId, seatIds: seats });
const releaseOf = (p: Party, seats: readonly string[]): SeatSaleRelease => ({ ...orderOf(p, seats), accountId: p.accountId });

/** 예약하고 RESERVED인지 확인한다(준비 단계) */
async function place(p: Party, seats: readonly string[], extra: { limit?: number; pendingUntilMs?: number } = {}): Promise<void> {
  expect(await sales.reserve(reserveOf(p, seats, extra)), '준비 단계의 예약').toEqual({ status: 'RESERVED' });
}
/** 예약하고 판매 확정까지 한다(준비 단계) */
async function placeSold(p: Party, seats: readonly string[]): Promise<void> {
  await place(p, seats);
  expect(await sales.markSold(orderOf(p, seats)), '준비 단계의 판매 확정').toBe(seats.length);
}

type SaleRow = { seat_id: string; order_id: string; status: string; reserved_at: Date | null; pending_until: Date | null };
/** 그 회차의 seat_sale 모든 행(좌석·주문 순) */
const rowsOf = async (eventId: string): Promise<SaleRow[]> =>
  (
    await admin.pool.query<SaleRow>(
      'select seat_id, order_id, status, reserved_at, pending_until from seat_sale where event_id = $1 order by seat_id, order_id',
      [eventId],
    )
  ).rows;
/** 한 주문의 행을 좌석 → 상태로 */
const statusesOf = async (p: Party): Promise<Record<string, string>> =>
  Object.fromEntries((await rowsOf(p.eventId)).filter((r) => r.order_id === p.orderId).map((r) => [r.seat_id, r.status]));
/** 활성 판매 행(PENDING·SOLD) 수. 좌석을 주면 그 좌석만 */
async function activeCount(eventId: string, seats?: readonly string[]): Promise<number> {
  const { rows } = await admin.pool.query<{ n: number }>(
    `select count(*)::int as n from seat_sale where event_id = $1 and status in ('PENDING', 'SOLD') and ($2::uuid[] is null or seat_id = any($2::uuid[]))`,
    [eventId, seats ?? null],
  );
  return rows[0]!.n;
}
/** 한도 행. 없으면 null */
async function quotaOf(accountId: string, eventId: string): Promise<{ used: number; limit: number } | null> {
  const { rows } = await admin.pool.query<{ used: number; limit: number }>('select used, limit_count as "limit" from purchase_quota where account_id = $1 and event_id = $2', [accountId, eventId]);
  return rows[0] ?? null;
}
/** 한 구매자의 모든 흔적(회차의 행 전부 + 한도 행). 아무것도 안 바뀌었는지 견줄 때 쓴다 */
const traceOf = async (p: Party) => ({ rows: await rowsOf(p.eventId), quota: await quotaOf(p.accountId, p.eventId) });

/** 오류와 그 원인 사슬의 글을 한 줄로(AggregateError 포함) */
function errorText(err: unknown, depth = 0): string {
  if (depth > 5 || err === undefined || err === null) return '';
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const inner = err instanceof AggregateError ? err.errors.map((e: unknown) => errorText(e, depth + 1)).join(' ') : '';
  return `${err.name}: ${err.message} ${typeof code === 'string' ? code : ''} ${errorText(err.cause, depth + 1)} ${inner}`.trim();
}
/** Promise.allSettled 결과에서 던진 것만 글로 */
const rejections = (settled: readonly PromiseSettledResult<unknown>[]): string[] =>
  settled.flatMap((r, i) => (r.status === 'rejected' ? [`#${i}: ${errorText(r.reason)}`] : []));
const fulfilledValues = <T>(settled: readonly PromiseSettledResult<T>[]): T[] => settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));

/** 풀에 쉬는 연결을 count개 미리 만든다. 4개씩 맺고 429(대기 초과)면 다시 시도한다 */
async function warm(db: Database, count: number): Promise<void> {
  const held: pg.PoolClient[] = [];
  try {
    for (let made = 0; made < count; made += 4) {
      const batch = await Promise.all(Array.from({ length: Math.min(4, count - made) }, () => connectWithRetry(db)));
      held.push(...batch);
    }
  } finally {
    for (const c of held) c.release();
  }
}
async function connectWithRetry(db: Database): Promise<pg.PoolClient> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.pool.connect();
    } catch (err) {
      if (!(err instanceof ProblemError && err.status === 429) || attempt >= 20) throw err;
      await sleep(50);
    }
  }
}

/** 시험 하나가 쓰는 풀. 끝나면 닫는다(연결이 닫혀야 그 연결이 센 통계가 DB에 모인다) */
async function withPool<T>(max: number, fn: (db: Database, repo: SeatSales) => Promise<T>): Promise<T> {
  const db = createDatabase({ url: server.url, profile: 'general', max, applicationName: 'seat-sales-test' });
  try {
    await warm(db, max);
    return await fn(db, new DrizzleSeatSales(db));
  } finally {
    await db.close();
  }
}

const newClient = (): pg.Client => new pg.Client({ connectionString: server.url });
/** pg_stat_database.deadlocks(이 DB). 새 연결로 읽어 통계 스냅샷이 묵지 않게 한다 */
async function readDeadlocks(): Promise<number> {
  const c = newClient();
  await c.connect();
  try {
    const { rows } = await c.query<{ n: number }>('select deadlocks::int as n from pg_stat_database where datname = current_database()');
    return rows[0]!.n;
  } finally {
    await c.end();
  }
}
/**
 * work가 도는 동안 DB가 센 교착 수. work는 자기 연결을 모두 닫고 끝나야 한다.
 * PostgreSQL은 연결(백엔드)이 쉬거나 끝날 때 통계를 모으므로, 연결이 닫힌 뒤 잠깐 기다렸다가 읽는다
 */
async function deadlocksDuring(work: () => Promise<void>): Promise<number> {
  const before = await readDeadlocks();
  await work();
  await sleep(1500);
  return (await readDeadlocks()) - before;
}

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));

// ───────────────────────────── reserve 기본 ─────────────────────────────

describe('reserve 기본', () => {
  test.each([1, 2, 3, 4])('빈 좌석 %i개를 예약하면 RESERVED이고 PENDING 행이 좌석 수만큼 생기며 한도 행은 used가 좌석 수, limit_count가 준 한도가 된다 [ASVS v5.0.0-2.3.2]', async (n) => {
    const p = newParty();
    const seats = seatIds(n);

    expect(await sales.reserve(reserveOf(p, seats, { limit: 4 }))).toEqual({ status: 'RESERVED' });

    const rows = await rowsOf(p.eventId);
    expect(rows.map((r) => [r.seat_id, r.order_id, r.status])).toEqual(seats.map((s) => [s, p.orderId, 'PENDING']));
    // 기한을 주지 않았으니 비어 있고, 예약 시각은 DB 시계 기준으로 방금이다
    expect(rows.map((r) => r.pending_until)).toEqual(seats.map(() => null));
    const { rows: fresh } = await admin.pool.query<{ n: number }>(
      `select count(*)::int as n from seat_sale where event_id = $1 and reserved_at is not null and reserved_at <= now() and reserved_at > now() - interval '5 minutes'`,
      [p.eventId],
    );
    expect(fresh[0]!.n).toBe(n);
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: n, limit: 4 });
  });

  test('pendingUntilMs를 주면 모든 PENDING 행의 pending_until이 그 시각이다 [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();
    const pendingUntilMs = Date.UTC(2026, 10, 6, 3, 4, 5, 678);

    await place(p, seatIds(2), { pendingUntilMs });

    expect((await rowsOf(p.eventId)).map((r) => r.pending_until?.getTime())).toEqual([pendingUntilMs, pendingUntilMs]);
  });

  test('같은 계정이 다른 주문으로 다시 예약하면 used가 쌓이고 limit_count는 호출이 준 값으로 맞춰진다(4에서 3으로 바꿔 불러도) [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();
    const [s1, s2, s3, s4] = seatIds(4);

    await place(p, [s1], { limit: 4 });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 1, limit: 4 });

    await place(nextOrder(p), [s2], { limit: 3 });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 2, limit: 3 });

    // 정확히 한도(3)까지는 된다
    await place(nextOrder(p), [s3], { limit: 3 });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 3 });

    expect(await sales.reserve(reserveOf(nextOrder(p), [s4], { limit: 3 }))).toEqual({ status: 'QUOTA_EXCEEDED' });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 3 });
  });

  test('한도 행은 (계정, 회차)마다 따로다: 다른 회차·다른 계정의 예약은 서로의 used를 올리지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const a = newParty();
    const otherEvent = { ...a, eventId: randomUUID() };
    const otherAccount = newParty(a.eventId);

    await place(a, seatIds(2), { limit: 2 });
    // 같은 계정이라도 다른 회차는 한도가 새로 시작한다
    await place(otherEvent, seatIds(2), { limit: 2 });
    // 같은 회차라도 다른 계정은 한도가 새로 시작한다(좌석은 달라야 한다)
    await place(otherAccount, seatIds(2, 3), { limit: 2 });

    expect(await quotaOf(a.accountId, a.eventId)).toEqual({ used: 2, limit: 2 });
    expect(await quotaOf(a.accountId, otherEvent.eventId)).toEqual({ used: 2, limit: 2 });
    expect(await quotaOf(otherAccount.accountId, a.eventId)).toEqual({ used: 2, limit: 2 });
  });

  test('좌석 정확히 10개(상한)는 한도만 허락하면 예약된다 [ASVS v5.0.0-2.2.1]', async () => {
    const p = newParty();

    expect(await sales.reserve(reserveOf(p, seatIds(10), { limit: 10 }))).toEqual({ status: 'RESERVED' });

    expect(await activeCount(p.eventId)).toBe(10);
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 10, limit: 10 });
  });
});

describe('reserve 한도', () => {
  test('한도 4에서 3석을 예약한 뒤 2석은 QUOTA_EXCEEDED이고 그 주문의 행은 없으며 used는 3 그대로다 [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();
    await place(p, seatIds(3), { limit: 4 });
    const second = nextOrder(p);

    expect(await sales.reserve(reserveOf(second, seatIds(2, 4), { limit: 4 }))).toEqual({ status: 'QUOTA_EXCEEDED' });

    expect(await statusesOf(second)).toEqual({});
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 4 });
    // 거절된 좌석은 비어 있다: 다른 계정이 잡을 수 있다
    expect(await sales.reserve(reserveOf(newParty(p.eventId), seatIds(2, 4)))).toEqual({ status: 'RESERVED' });
  });

  test('정확히 한도까지(3+1=4)는 RESERVED이고 한 석 더는 QUOTA_EXCEEDED다 [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();
    await place(p, seatIds(3), { limit: 4 });

    await place(nextOrder(p), seatIds(1, 4), { limit: 4 });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 4, limit: 4 });

    expect(await sales.reserve(reserveOf(nextOrder(p), seatIds(1, 5), { limit: 4 }))).toEqual({ status: 'QUOTA_EXCEEDED' });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 4, limit: 4 });
  });

  test('좌석 수가 한도보다 많으면 처음부터 QUOTA_EXCEEDED이고 DB에 한도 행도 좌석 행도 남지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();

    expect(await sales.reserve(reserveOf(p, seatIds(3), { limit: 2 }))).toEqual({ status: 'QUOTA_EXCEEDED' });

    expect(await traceOf(p)).toEqual({ rows: [], quota: null });
  });

  test('이미 쓴 만큼보다 낮은 한도를 주고 부르면 QUOTA_EXCEEDED이고 limit_count는 이전 값 그대로다(실패한 호출은 한도를 바꾸지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();
    await place(p, seatIds(3), { limit: 4 });

    expect(await sales.reserve(reserveOf(nextOrder(p), seatIds(1, 4), { limit: 2 }))).toEqual({ status: 'QUOTA_EXCEEDED' });

    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 4 });
  });

  test('한도 초과와 좌석 경합이 함께면 한도 검사가 먼저라 QUOTA_EXCEEDED다(좌석 ID를 알려 주지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    const p = newParty();
    const rival = newParty(p.eventId);
    await place(p, seatIds(3), { limit: 4 });
    await place(rival, seatIds(1, 10));

    expect(await sales.reserve(reserveOf(nextOrder(p), [seatId(10), seatId(11)], { limit: 4 }))).toEqual({ status: 'QUOTA_EXCEEDED' });

    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 4 });
  });
});

describe('reserve 좌석 경합', () => {
  test('다른 주문이 PENDING이거나 SOLD로 잡은 좌석이 섞이면 SEAT_TAKEN에 잡힌 좌석만 입력 순서로 담기고 새 행과 올린 한도가 모두 되돌려진다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.4]', async () => {
    const eventId = randomUUID();
    const [s1, s2, s5, s9] = [1, 2, 5, 9].map(seatId);
    const pendingHolder = newParty(eventId);
    const soldHolder = newParty(eventId);
    const buyer = newParty(eventId);
    await place(pendingHolder, [s2]);
    await placeSold(soldHolder, [s5]);
    // 구매자는 이미 다른 주문으로 한 석(used 1)을 쥔 상태다
    await place(nextOrder(buyer), [s9]);
    const before = await rowsOf(eventId);

    // 입력 순서 [s5, s1, s2]는 정렬 순서([s1, s2, s5])와 다르다: 잡힌 좌석은 입력 순서로 돌려준다
    expect(await sales.reserve(reserveOf(buyer, [s5, s1, s2]))).toEqual({ status: 'SEAT_TAKEN', seatIds: [s5, s2] });

    expect(await rowsOf(eventId)).toEqual(before);
    expect(await statusesOf(buyer)).toEqual({});
    expect(await quotaOf(buyer.accountId, eventId)).toEqual({ used: 1, limit: 4 });
    // 되돌려졌으니 잡히지 않았던 좌석(s1)은 여전히 비어 있다
    expect(await sales.reserve(reserveOf(newParty(eventId), [s1]))).toEqual({ status: 'RESERVED' });
  });

  test('한도 행이 없던 계정이 SEAT_TAKEN을 받으면 한도 행도 남지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const eventId = randomUUID();
    const holder = newParty(eventId);
    const buyer = newParty(eventId);
    await place(holder, seatIds(1));

    expect(await sales.reserve(reserveOf(buyer, seatIds(2)))).toEqual({ status: 'SEAT_TAKEN', seatIds: [seatId(1)] });

    expect(await traceOf(buyer)).toEqual({ rows: await rowsOf(eventId), quota: null });
    expect(await statusesOf(buyer)).toEqual({});
  });

  test('요청한 좌석이 모두 잡혀 있으면 SEAT_TAKEN에 모두 담긴다 [ASVS v5.0.0-2.3.3]', async () => {
    const eventId = randomUUID();
    const [a, b, c] = seatIds(3);
    await place(newParty(eventId), [a, c]);
    await placeSold(newParty(eventId), [b]);

    expect(await sales.reserve(reserveOf(newParty(eventId), [c, b, a]))).toEqual({ status: 'SEAT_TAKEN', seatIds: [c, b, a] });
  });

  test('RETURNED 행만 있는 좌석은 다시 예약되고 이력 행이 함께 남는다 [ASVS v5.0.0-2.3.4]', async () => {
    const eventId = randomUUID();
    const first = newParty(eventId);
    const second = newParty(eventId);
    const seats = seatIds(2);
    await placeSold(first, seats);
    expect(await sales.returnSold(releaseOf(first, seats))).toBe(2);

    expect(await sales.reserve(reserveOf(second, seats))).toEqual({ status: 'RESERVED' });

    expect(await statusesOf(first)).toEqual({ [seats[0]!]: 'RETURNED', [seats[1]!]: 'RETURNED' });
    expect(await statusesOf(second)).toEqual({ [seats[0]!]: 'PENDING', [seats[1]!]: 'PENDING' });
    expect(await activeCount(eventId)).toBe(2);
  });

  test('같은 좌석 ID라도 다른 회차는 서로 영향이 없다 [ASVS v5.0.0-2.3.4]', async () => {
    const a = newParty();
    const b = newParty();
    const seats = seatIds(2);

    await place(a, seats);
    await place(b, seats);

    expect(await activeCount(a.eventId)).toBe(2);
    expect(await activeCount(b.eventId)).toBe(2);
  });
});

// ───────────────────────────── 입력 검사 ─────────────────────────────

describe('reserve 입력 검사', () => {
  const cases: { label: string; make: (p: Party) => ReserveInput }[] = [
    { label: '대문자 UUID 좌석', make: (p) => reserveOf(p, [seatId(0xabc).toUpperCase()]) },
    { label: '하이픈 없는 UUID 좌석', make: (p) => reserveOf(p, [seatId(1).replaceAll('-', '')]) },
    { label: '중괄호로 감싼 UUID 좌석', make: (p) => reserveOf(p, [`{${seatId(1)}}`]) },
    { label: 'UUID가 아닌 좌석 코드(A01)', make: (p) => reserveOf(p, ['A01']) },
    { label: '빈 글 좌석', make: (p) => reserveOf(p, ['']) },
    { label: '좌석 일부만 틀림', make: (p) => reserveOf(p, [seatId(1), 'A01']) },
    { label: '좌석 0개', make: (p) => reserveOf(p, []) },
    { label: '좌석 11개', make: (p) => reserveOf(p, seatIds(11), { limit: 11 }) },
    { label: '같은 좌석이 두 번', make: (p) => reserveOf(p, [seatId(1), seatId(2), seatId(1)]) },
    { label: '한도 0', make: (p) => reserveOf(p, seatIds(1), { limit: 0 }) },
    { label: '한도 음수', make: (p) => reserveOf(p, seatIds(1), { limit: -1 }) },
    { label: '한도가 소수', make: (p) => reserveOf(p, seatIds(1), { limit: 1.5 }) },
    { label: '한도가 NaN', make: (p) => reserveOf(p, seatIds(1), { limit: Number.NaN }) },
    { label: '한도가 무한대', make: (p) => reserveOf(p, seatIds(1), { limit: Number.POSITIVE_INFINITY }) },
  ];

  test.each(cases)('입력이 틀리면($label) RangeError로 거절하고 DB에는 행도 한도 행도 남지 않는다 [ASVS v5.0.0-2.2.1]', async ({ make }) => {
    const p = newParty();

    await expect(sales.reserve(make(p))).rejects.toThrow(RangeError);

    expect(await traceOf(p)).toEqual({ rows: [], quota: null });
  });

  const methods = ['markSold', 'releasePending', 'returnSold'] as const;
  test.each(methods)('%s는 소문자 UUID가 아닌 좌석·중복 좌석·빈 목록·11개를 RangeError로 거절하고 이미 있는 행과 한도를 건드리지 않는다 [ASVS v5.0.0-2.2.1]', async (method) => {
    const p = newParty();
    await place(p, seatIds(2));
    const before = await traceOf(p);
    const bad: string[][] = [[seatId(0xabc).toUpperCase()], ['A01'], [], [seatId(1), seatId(1)], seatIds(11)];

    for (const seats of bad) {
      await expect(sales[method](releaseOf(p, seats)), `좌석 ${JSON.stringify(seats.slice(0, 2))}…`).rejects.toThrow(RangeError);
    }

    expect(await traceOf(p)).toEqual(before);
  });
});

describe('reserve 좌석 순서', () => {
  const orders = permutations(seatIds(3)).map((order) => ({ label: order.map((s) => s.slice(-1)).join(''), order }));

  test.each(orders)('좌석을 $label 순서로 줘도 같은 결과다: 예약되면 같은 행이 생기고, 하나가 잡혀 있으면 같은 좌석만 SEAT_TAKEN이다', async ({ order }) => {
    const free = newParty();
    expect(await sales.reserve(reserveOf(free, order))).toEqual({ status: 'RESERVED' });
    expect(Object.keys(await statusesOf(free))).toEqual(seatIds(3));

    const contested = newParty();
    await place(newParty(contested.eventId), [seatId(2)]);
    expect(await sales.reserve(reserveOf(contested, order))).toEqual({ status: 'SEAT_TAKEN', seatIds: [seatId(2)] });
  });

  test('입력 배열과 입력 객체를 바꾸지 않는다(얼린 입력도 받는다)', async () => {
    const p = newParty();
    const seats = Object.freeze([seatId(3), seatId(1), seatId(2)]);
    const input = Object.freeze(reserveOf(p, seats));

    expect(await sales.reserve(input)).toEqual({ status: 'RESERVED' });

    expect(seats).toEqual([seatId(3), seatId(1), seatId(2)]);
    expect(input.seatIds).toBe(seats);
  });
});

// ───────────────────────────── 상태 바꾸기 ─────────────────────────────

describe('markSold', () => {
  test('PENDING 행을 SOLD로 바꾸고 pending_until을 비우며 바꾼 행 수를 돌려준다. 한도 used는 그대로다 [S-T7]', async () => {
    const p = newParty();
    const seats = seatIds(3);
    await place(p, seats, { pendingUntilMs: Date.now() + 3_600_000 });
    expect((await rowsOf(p.eventId)).every((r) => r.pending_until !== null)).toBe(true);

    expect(await sales.markSold(orderOf(p, seats))).toBe(3);

    expect(await statusesOf(p)).toEqual(Object.fromEntries(seats.map((s) => [s, 'SOLD'])));
    expect((await rowsOf(p.eventId)).map((r) => r.pending_until)).toEqual([null, null, null]);
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 4 });
  });

  test('두 번째 호출은 0이고 아무것도 바뀌지 않는다(멱등)', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await placeSold(p, seats);
    const before = await traceOf(p);

    expect(await sales.markSold(orderOf(p, seats))).toBe(0);

    expect(await traceOf(p)).toEqual(before);
  });

  test('다른 주문 ID·다른 회차 ID·없는 행에는 0이고 아무것도 바뀌지 않는다', async () => {
    const p = newParty();
    const seats = seatIds(3);
    await place(p, seats);
    const before = await traceOf(p);

    expect(await sales.markSold(orderOf({ ...p, orderId: randomUUID() }, seats)), '다른 주문 ID').toBe(0);
    expect(await sales.markSold(orderOf({ ...p, eventId: randomUUID() }, seats)), '다른 회차 ID').toBe(0);
    expect(await sales.markSold(orderOf(p, seatIds(2, 100))), '없는 좌석').toBe(0);

    expect(await traceOf(p)).toEqual(before);
    expect(await statusesOf(p)).toEqual(Object.fromEntries(seats.map((s) => [s, 'PENDING'])));
  });

  test('좌석 일부만 넘기면 넘긴 좌석만 바뀌고, 나머지를 이어서 넘기면 이미 SOLD인 좌석은 세지 않는다', async () => {
    const p = newParty();
    const [s1, s2, s3] = seatIds(3);
    await place(p, [s1, s2, s3]);

    expect(await sales.markSold(orderOf(p, [s1]))).toBe(1);
    expect(await statusesOf(p)).toEqual({ [s1!]: 'SOLD', [s2!]: 'PENDING', [s3!]: 'PENDING' });

    expect(await sales.markSold(orderOf(p, [s1, s2, s3]))).toBe(2);
    expect(await statusesOf(p)).toEqual({ [s1!]: 'SOLD', [s2!]: 'SOLD', [s3!]: 'SOLD' });
  });

  test('주문에 없는 좌석이 섞여 있어도 그 주문의 PENDING 행만 바뀌고 다른 주문의 행은 그대로다', async () => {
    const eventId = randomUUID();
    const mine = newParty(eventId);
    const other = newParty(eventId);
    await place(mine, seatIds(2));
    await place(other, seatIds(1, 10));

    expect(await sales.markSold(orderOf(mine, [...seatIds(2), seatId(10)]))).toBe(2);

    expect(await statusesOf(other)).toEqual({ [seatId(10)]: 'PENDING' });
  });

  test('RETURNED 행에는 0이다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await placeSold(p, seats);
    expect(await sales.returnSold(releaseOf(p, seats))).toBe(2);

    expect(await sales.markSold(orderOf(p, seats))).toBe(0);

    expect(await statusesOf(p)).toEqual(Object.fromEntries(seats.map((s) => [s, 'RETURNED'])));
  });
});

describe('releasePending', () => {
  test('PENDING 행을 지우고 used를 지운 행 수만큼 줄이며, 두 번째 호출은 0이고 used가 더 줄지 않는다 [S-T7]', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await place(p, seats);
    await place(nextOrder(p), seatIds(1, 5)); // 같은 계정의 다른 주문: used는 3이 된다
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 4 });

    expect(await sales.releasePending(releaseOf(p, seats))).toBe(2);

    expect(await statusesOf(p)).toEqual({});
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 1, limit: 4 });

    expect(await sales.releasePending(releaseOf(p, seats))).toBe(0);
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 1, limit: 4 });
  });

  test('SOLD 행은 건드리지 않고 0이며 used도 그대로다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await placeSold(p, seats);
    const before = await traceOf(p);

    expect(await sales.releasePending(releaseOf(p, seats))).toBe(0);

    expect(await traceOf(p)).toEqual(before);
  });

  test('used는 0 밑으로 내려가지 않는다: 한도 행을 일부러 used=0으로 고친 뒤 불러도 0이 유지되고 오류가 없다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await place(p, seats);
    await admin.pool.query('update purchase_quota set used = 0 where account_id = $1 and event_id = $2', [p.accountId, p.eventId]);

    expect(await sales.releasePending(releaseOf(p, seats))).toBe(2);

    expect(await statusesOf(p)).toEqual({});
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 0, limit: 4 });
  });

  test('한도 행이 아예 없어도 오류 없이 좌석 행만 지우고 한도 행을 새로 만들지 않는다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await place(p, seats);
    await admin.pool.query('delete from purchase_quota where account_id = $1 and event_id = $2', [p.accountId, p.eventId]);

    expect(await sales.releasePending(releaseOf(p, seats))).toBe(2);

    expect(await traceOf(p)).toEqual({ rows: [], quota: null });
  });

  test('지운 뒤 같은 좌석을 다른 주문이 예약할 수 있다(승인 실패 뒤 다시 잡기) [S-T7]', async () => {
    const eventId = randomUUID();
    const failed = newParty(eventId);
    const next = newParty(eventId);
    const seats = seatIds(3);
    await place(failed, seats);
    expect(await sales.reserve(reserveOf(next, seats)), '풀기 전에는 잡혀 있다').toMatchObject({ status: 'SEAT_TAKEN' });

    expect(await sales.releasePending(releaseOf(failed, seats))).toBe(3);

    expect(await sales.reserve(reserveOf(next, seats))).toEqual({ status: 'RESERVED' });
    expect(await activeCount(eventId)).toBe(3);
    expect(await quotaOf(failed.accountId, eventId)).toEqual({ used: 0, limit: 4 });
  });

  test('좌석 일부만 넘기면 그 좌석의 PENDING 행만 지우고 그만큼만 used를 줄인다', async () => {
    const p = newParty();
    const [s1, s2, s3] = seatIds(3);
    await place(p, [s1, s2, s3]);

    expect(await sales.releasePending(releaseOf(p, [s2]))).toBe(1);

    expect(await statusesOf(p)).toEqual({ [s1!]: 'PENDING', [s3!]: 'PENDING' });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 2, limit: 4 });
  });

  test('다른 주문 ID·다른 회차 ID로는 0이고 아무것도 바뀌지 않는다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await place(p, seats);
    const before = await traceOf(p);

    expect(await sales.releasePending(releaseOf({ ...p, orderId: randomUUID() }, seats))).toBe(0);
    expect(await sales.releasePending(releaseOf({ ...p, eventId: randomUUID() }, seats))).toBe(0);

    expect(await traceOf(p)).toEqual(before);
  });
});

describe('returnSold', () => {
  test('SOLD 행을 RETURNED로 바꾸고 used를 바꾼 행 수만큼 줄이며, 두 번째 호출은 0이고 used가 더 줄지 않는다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await placeSold(p, seats);
    await place(nextOrder(p), seatIds(1, 5));
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 3, limit: 4 });

    expect(await sales.returnSold(releaseOf(p, seats))).toBe(2);

    expect(await statusesOf(p)).toEqual(Object.fromEntries(seats.map((s) => [s, 'RETURNED'])));
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 1, limit: 4 });

    expect(await sales.returnSold(releaseOf(p, seats))).toBe(0);
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 1, limit: 4 });
    expect(await statusesOf(p)).toEqual(Object.fromEntries(seats.map((s) => [s, 'RETURNED'])));
  });

  test('PENDING 행에는 0이고 아무것도 바뀌지 않는다(승인 전 행은 반품이 아니라 해제로 푼다)', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await place(p, seats);
    const before = await traceOf(p);

    expect(await sales.returnSold(releaseOf(p, seats))).toBe(0);

    expect(await traceOf(p)).toEqual(before);
  });

  test('바뀐 좌석은 다시 예약할 수 있고, 남은 RETURNED 이력 행의 주문 ID로 다시 returnSold를 해도 0이며 새 주문의 행은 그대로다', async () => {
    const eventId = randomUUID();
    const first = newParty(eventId);
    const second = newParty(eventId);
    const seats = seatIds(2);
    await placeSold(first, seats);
    expect(await sales.returnSold(releaseOf(first, seats))).toBe(2);

    expect(await sales.reserve(reserveOf(second, seats))).toEqual({ status: 'RESERVED' });
    expect(await sales.markSold(orderOf(second, seats))).toBe(2);

    // 이력 행(first, RETURNED)의 주문 ID로 부르면 0이고, 같은 좌석의 새 SOLD 행(second)은 건드리지 않는다
    expect(await sales.returnSold(releaseOf(first, seats))).toBe(0);
    expect(await statusesOf(second)).toEqual(Object.fromEntries(seats.map((s) => [s, 'SOLD'])));
    expect(await quotaOf(second.accountId, eventId)).toEqual({ used: 2, limit: 4 });
    expect(await quotaOf(first.accountId, eventId)).toEqual({ used: 0, limit: 4 });
  });

  test('다른 주문 ID·다른 회차 ID로는 0이고 아무것도 바뀌지 않는다', async () => {
    const p = newParty();
    const seats = seatIds(2);
    await placeSold(p, seats);
    const before = await traceOf(p);

    expect(await sales.returnSold(releaseOf({ ...p, orderId: randomUUID() }, seats))).toBe(0);
    expect(await sales.returnSold(releaseOf({ ...p, eventId: randomUUID() }, seats))).toBe(0);

    expect(await traceOf(p)).toEqual(before);
  });
});

describe('섞인 상태', () => {
  test('한 주문의 일부 좌석만 SOLD이고 일부는 PENDING일 때, releasePending은 PENDING만 지우고 그 수만큼만 used를 줄이며 returnSold는 SOLD만 바꾼다', async () => {
    const p = newParty();
    const [s1, s2, s3] = seatIds(3);
    await place(p, [s1, s2, s3]);
    expect(await sales.markSold(orderOf(p, [s1]))).toBe(1);
    expect(await statusesOf(p)).toEqual({ [s1!]: 'SOLD', [s2!]: 'PENDING', [s3!]: 'PENDING' });

    expect(await sales.releasePending(releaseOf(p, [s1, s2, s3]))).toBe(2);

    expect(await statusesOf(p)).toEqual({ [s1!]: 'SOLD' });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 1, limit: 4 });

    expect(await sales.returnSold(releaseOf(p, [s1, s2, s3]))).toBe(1);

    expect(await statusesOf(p)).toEqual({ [s1!]: 'RETURNED' });
    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 0, limit: 4 });
  });
});

// ───────────────────────────── 동시성(진짜 경합) ─────────────────────────────

describe('동시성', () => {
  test('S-T8_같은 한 좌석을 서로 다른 두 계정의 주문이 동시에 예약하면 정확히 한 건만 RESERVED이고 진 쪽은 SEAT_TAKEN이며 활성 행은 하나다(20회) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]', async () => {
    await warm(wide, 4);
    const eventId = randomUUID();

    for (let round = 0; round < 20; round++) {
      const seat = randomUUID();
      const parties = [newParty(eventId), newParty(eventId)];
      const settled = await Promise.allSettled(parties.map((p) => wideSales.reserve(reserveOf(p, [seat]))));

      expect(rejections(settled), `${round}회차에 던진 오류`).toEqual([]);
      const results = fulfilledValues(settled);
      expect(results.map((r) => r.status).sort(), `${round}회차 결과`).toEqual(['RESERVED', 'SEAT_TAKEN']);
      const winner = parties[results.findIndex((r) => r.status === 'RESERVED')]!;
      const loser = parties[results.findIndex((r) => r.status === 'SEAT_TAKEN')]!;
      expect(results[parties.indexOf(loser)], `${round}회차 진 쪽`).toEqual({ status: 'SEAT_TAKEN', seatIds: [seat] });
      expect(await activeCount(eventId, [seat]), `${round}회차 활성 행`).toBe(1);
      expect(await statusesOf(winner), `${round}회차 이긴 쪽 행`).toEqual({ [seat]: 'PENDING' });
      expect(await statusesOf(loser), `${round}회차 진 쪽 행`).toEqual({});
      expect(await quotaOf(winner.accountId, eventId), `${round}회차 이긴 쪽 한도`).toEqual({ used: 1, limit: 4 });
      // 진 쪽이 한도 행을 먼저 올렸더라도 되돌려져 used 0이다(행이 없어도 된다)
      expect((await quotaOf(loser.accountId, eventId))?.used ?? 0, `${round}회차 진 쪽 한도`).toBe(0);
    }
  });

  test('S-T8_확장_같은 한 좌석에 서른 주문이 동시에 오면 정확히 한 건만 RESERVED이고 스물아홉은 오류 없이 SEAT_TAKEN이며 활성 행은 하나다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-15.4.2]', async () => {
    await warm(wide, 30);
    const eventId = randomUUID();
    const seat = randomUUID();
    const parties = Array.from({ length: 30 }, () => newParty(eventId));

    const settled = await Promise.allSettled(parties.map((p) => wideSales.reserve(reserveOf(p, [seat]))));

    expect(rejections(settled)).toEqual([]);
    const results = fulfilledValues(settled);
    expect(results.filter((r) => r.status === 'RESERVED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'SEAT_TAKEN')).toHaveLength(29);
    expect(results.filter((r) => r.status === 'SEAT_TAKEN')).toEqual(Array.from({ length: 29 }, () => ({ status: 'SEAT_TAKEN', seatIds: [seat] })));
    expect(await activeCount(eventId, [seat])).toBe(1);
    expect(await rowsOf(eventId)).toHaveLength(1);
    // 진 29명의 한도 행은 모두 되돌려졌다: 올라가 남은 used의 합은 이긴 한 명의 1뿐이다
    const { rows } = await admin.pool.query<{ total: number }>('select coalesce(sum(used), 0)::int as total from purchase_quota where event_id = $1', [eventId]);
    expect(rows[0]!.total).toBe(1);
  });

  test('S-T10_측정 장치 점검: 일부러 만든 교착은 40P01로 끝나고 pg_stat_database.deadlocks를 1 올린다(아래 교착 시험의 0이 헛된 0이 아님을 보인다)', async () => {
    const eventId = randomUUID();
    const [seat1, seat2] = randomSeats(2);
    await admin.pool.query(`insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $6, 'PENDING'), ($1, $4, $5, $6, 'PENDING')`, [
      eventId,
      seat1,
      randomUUID(),
      seat2,
      randomUUID(),
      randomUUID(),
    ]);
    const touch = 'update seat_sale set pending_until = now() where event_id = $1 and seat_id = $2';
    let outcomes: (pg.DatabaseError | null)[] = [];

    const delta = await deadlocksDuring(async () => {
      const [c1, c2] = [newClient(), newClient()];
      await Promise.all([c1.connect(), c2.connect()]);
      try {
        await Promise.all([c1.query('begin'), c2.query('begin')]);
        await c1.query(touch, [eventId, seat1]);
        await c2.query(touch, [eventId, seat2]);
        const first = c1.query(touch, [eventId, seat2]).then(() => null, (e: pg.DatabaseError) => e);
        await sleep(200); // c1이 c2의 잠금을 기다리기 시작한 뒤에 c2가 서로의 잠금을 기다리게 한다
        const second = c2.query(touch, [eventId, seat1]).then(() => null, (e: pg.DatabaseError) => e);
        outcomes = await Promise.all([first, second]);
      } finally {
        await Promise.allSettled([c1.end(), c2.end()]);
      }
    });

    expect(outcomes.filter((e) => e !== null).map((e) => e!.code)).toEqual(['40P01']);
    expect(delta).toBe(1);
  }, 30_000);

  describe('겹치는 좌석을 엇갈린 순서로 줄 때(S-T10)', () => {
    type Shape = { seatsA: string[]; seatsB: string[]; shared: string[] };
    /** 라운드마다 PAIRS쌍을 한꺼번에 불러 겹침을 늘린다. 쌍마다 이긴 쪽과 진 쪽이 하나씩이어야 한다 */
    async function run(rounds: number, shape: () => Shape): Promise<{ failures: string[]; deadlocks: number }> {
      const PAIRS = 4;
      const failures: string[] = [];
      const eventId = randomUUID();
      const deadlocks = await deadlocksDuring(() =>
        withPool(2 * PAIRS, async (_db, repo) => {
          for (let round = 0; round < rounds && failures.length === 0; round++) {
            const pairs = Array.from({ length: PAIRS }, () => ({ buyerA: newParty(eventId), buyerB: newParty(eventId), ...shape() }));
            const settled = await Promise.allSettled(pairs.flatMap((x) => [repo.reserve(reserveOf(x.buyerA, x.seatsA)), repo.reserve(reserveOf(x.buyerB, x.seatsB))]));
            failures.push(...rejections(settled).map((m) => `${round}회차 ${m}`));
            if (failures.length > 0) return;
            for (const [k, x] of pairs.entries()) {
              const ra = (settled[2 * k] as PromiseFulfilledResult<ReserveResult>).value;
              const rb = (settled[2 * k + 1] as PromiseFulfilledResult<ReserveResult>).value;
              if ([ra.status, rb.status].sort().join() !== 'RESERVED,SEAT_TAKEN') {
                failures.push(`${round}회차 쌍${k}: ${JSON.stringify([ra, rb])}`);
                continue;
              }
              // 진 쪽은 겹친 좌석만 자기 입력 순서로 돌려받는다
              const [loserResult, loserSeats] = ra.status === 'SEAT_TAKEN' ? [ra, x.seatsA] : [rb, x.seatsB];
              const expected = { status: 'SEAT_TAKEN', seatIds: loserSeats.filter((s) => x.shared.includes(s)) };
              if (JSON.stringify(loserResult) !== JSON.stringify(expected)) failures.push(`${round}회차 쌍${k}: 진 쪽 ${JSON.stringify(loserResult)} != ${JSON.stringify(expected)}`);
              // 겹친 좌석마다 활성 행은 하나다
              const active = await activeCount(eventId, x.shared);
              if (active !== x.shared.length) failures.push(`${round}회차 쌍${k}: 겹친 좌석 ${x.shared.length}개의 활성 행이 ${active}개`);
            }
          }
        }),
      );
      return { failures, deadlocks };
    }

    test('주문 A [s1,s2,s3,s4]와 주문 B [s4,s3,s2,s1]을 동시에 50회 예약해도 오류로 던지는 건 0건이고 쌍마다 RESERVED 하나·SEAT_TAKEN 하나이며 교착 수가 늘지 않는다 [ASVS v5.0.0-15.4.3]', async () => {
      const { failures, deadlocks } = await run(50, () => {
        const seats = randomSeats(4);
        return { seatsA: seats, seatsB: [...seats].reverse(), shared: seats };
      });

      expect(failures).toEqual([]);
      expect(deadlocks).toBe(0);
    }, 120_000);

    test('일부만 겹치는 두 주문([x1,x2,c1,c2]와 [c2,c1,y1,y2])을 동시에 30회 예약해도 오류 0건·쌍마다 RESERVED 하나와 SEAT_TAKEN 하나이며 교착 수가 늘지 않는다 [ASVS v5.0.0-15.4.3]', async () => {
      const { failures, deadlocks } = await run(30, () => {
        const [x1, x2, c1, c2, y1, y2] = randomSeats(6) as [string, string, string, string, string, string];
        return { seatsA: [x1, x2, c1, c2], seatsB: [c2, c1, y1, y2], shared: [c1, c2] };
      });

      expect(failures).toEqual([]);
      expect(deadlocks).toBe(0);
    }, 120_000);

    test('서로 겹치지 않는 주문들은 엇갈린 순서로 줘도 동시에 모두 RESERVED다', async () => {
      await warm(wide, 12);
      const eventId = randomUUID();
      const orders = Array.from({ length: 12 }, (_, k) => {
        const seats = seatIds(4, 1 + k * 4);
        return reserveOf(newParty(eventId), k % 2 === 0 ? seats : [...seats].reverse());
      });

      const settled = await Promise.allSettled(orders.map((o) => wideSales.reserve(o)));

      expect(rejections(settled)).toEqual([]);
      expect(fulfilledValues(settled)).toEqual(orders.map(() => ({ status: 'RESERVED' })));
      expect(await activeCount(eventId)).toBe(48);
    });
  });

  describe.each(['releasePending', 'returnSold'] as const)('같은 계정의 새 예약과 앞선 주문의 %s가 겹칠 때(S-T10, 한도 행 → 좌석 행 잠금 순서)', (method) => {
    test(`새 예약이 방금 풀리는 좌석을 노려도 교착(40P01)·던지는 오류가 0건이고, 끝에 used가 활성 행(PENDING+SOLD) 수와 같다(40회) [ASVS v5.0.0-15.4.3]`, async () => {
      const failures: string[] = [];
      // [풀기 시작 지연 ms, 새 예약 시작 지연 ms]: 두 호출이 서로 다른 시점에 겹치도록 돌려 쓴다
      const delays = [[0, 0], [0, 1], [1, 0], [0, 2], [2, 0], [0, 3], [3, 0]] as const;

      const deadlocks = await deadlocksDuring(() =>
        withPool(8, async (_db, repo) => {
          for (let round = 0; round < 40 && failures.length === 0; round++) {
            const earlier = newParty();
            const later = nextOrder(earlier);
            const [a1, a2] = randomSeats(2) as [string, string];
            const wanted = [a1, randomUUID()]; // 풀리는 좌석 a1 + 새 좌석
            expect(await repo.reserve(reserveOf(earlier, [a1, a2])), '준비 단계의 예약').toEqual({ status: 'RESERVED' });
            if (method === 'returnSold') expect(await repo.markSold(orderOf(earlier, [a1, a2])), '준비 단계의 판매 확정').toBe(2);
            const [freeDelay, reserveDelay] = delays[round % delays.length]!;

            const settled = await Promise.allSettled([
              sleep(freeDelay).then(() => repo[method](releaseOf(earlier, [a1, a2]))),
              sleep(reserveDelay).then(() => repo.reserve(reserveOf(later, wanted))),
            ]);

            failures.push(...rejections(settled).map((m) => `${round}회차 ${m}`));
            if (failures.length > 0) return;
            const [freed, again] = fulfilledValues<number | ReserveResult>(settled) as [number, ReserveResult];
            if (freed !== 2) failures.push(`${round}회차: ${method}가 ${freed}행을 바꿨다(2여야 한다)`);
            if (again.status !== 'RESERVED' && again.status !== 'SEAT_TAKEN') failures.push(`${round}회차: 새 예약 ${JSON.stringify(again)}`);
            const active = await activeCount(earlier.eventId);
            const used = (await quotaOf(earlier.accountId, earlier.eventId))?.used;
            if (used !== active) failures.push(`${round}회차: used ${used} != 활성 행 ${active} (새 예약 ${again.status})`);
            if (again.status === 'RESERVED' && active !== 2) failures.push(`${round}회차: 새 예약이 됐는데 활성 행이 ${active}개`);
            if (again.status === 'SEAT_TAKEN' && active !== 0) failures.push(`${round}회차: 새 예약이 거절됐는데 활성 행이 ${active}개`);
          }
        }),
      );

      expect(failures).toEqual([]);
      expect(deadlocks).toBe(0);
    }, 120_000);
  });

  test('한도 경쟁: 같은 계정이 서로 다른 단일 좌석 주문 8개를 한도 4로 동시에 하면 정확히 4건 RESERVED·4건 QUOTA_EXCEEDED이고 used는 4, 활성 행도 4개다 [ASVS v5.0.0-2.3.2]', async () => {
    await warm(wide, 8);
    const base = newParty();
    const orders = Array.from({ length: 8 }, (_, k) => reserveOf(nextOrder(base), [seatId(k + 1)], { limit: 4 }));

    const settled = await Promise.allSettled(orders.map((o) => wideSales.reserve(o)));

    expect(rejections(settled)).toEqual([]);
    const results = fulfilledValues(settled);
    expect(results.filter((r) => r.status === 'RESERVED')).toHaveLength(4);
    expect(results.filter((r) => r.status === 'QUOTA_EXCEEDED')).toHaveLength(4);
    expect(await quotaOf(base.accountId, base.eventId)).toEqual({ used: 4, limit: 4 });
    expect(await activeCount(base.eventId)).toBe(4);
    // 진 주문의 좌석 행은 남지 않았다: 4개 행은 모두 RESERVED를 받은 주문의 것이다
    const winners = new Set(orders.filter((_, i) => results[i]!.status === 'RESERVED').map((o) => o.orderId));
    expect((await rowsOf(base.eventId)).every((r) => winners.has(r.order_id))).toBe(true);
  });

  test('같은 주문(PENDING)에 markSold와 releasePending을 동시에 부르기를 여러 번 해도 한쪽만 효과가 있고(n과 0) 끝 상태가 일관되며 교착이 없다(30회)', async () => {
    const failures: string[] = [];
    const delays = [[0, 0], [0, 1], [1, 0], [0, 2], [2, 0]] as const;

    const deadlocks = await deadlocksDuring(() =>
      withPool(6, async (_db, repo) => {
        for (let round = 0; round < 30 && failures.length === 0; round++) {
          const p = newParty();
          const seats = randomSeats(3);
          expect(await repo.reserve(reserveOf(p, seats)), '준비 단계의 예약').toEqual({ status: 'RESERVED' });
          const [soldDelay, releaseDelay] = delays[round % delays.length]!;

          const settled = await Promise.allSettled([
            sleep(soldDelay).then(() => repo.markSold(orderOf(p, seats))),
            sleep(releaseDelay).then(() => repo.releasePending(releaseOf(p, seats))),
          ]);

          failures.push(...rejections(settled).map((m) => `${round}회차 ${m}`));
          if (failures.length > 0) return;
          const [sold, released] = fulfilledValues<number>(settled);
          const states = Object.values(await statusesOf(p));
          const used = (await quotaOf(p.accountId, p.eventId))?.used;
          if (sold === 3 && released === 0) {
            if (states.length !== 3 || !states.every((s) => s === 'SOLD') || used !== 3) failures.push(`${round}회차: markSold가 이겼는데 상태 ${states} used ${used}`);
          } else if (sold === 0 && released === 3) {
            if (states.length !== 0 || used !== 0) failures.push(`${round}회차: releasePending이 이겼는데 상태 ${states} used ${used}`);
          } else {
            failures.push(`${round}회차: 바뀐 행 수가 markSold ${sold}, releasePending ${released} (한쪽이 3, 다른 쪽이 0이어야 한다) 상태 ${states} used ${used}`);
          }
        }
      }),
    );

    expect(failures).toEqual([]);
    expect(deadlocks).toBe(0);
  }, 120_000);
});

// ───────────────────────────── 격리 수준 비교(S-T11) ─────────────────────────────

describe('S-T11 격리 수준 비교', () => {
  /** 백엔드 pid가 잠금 때문에 기다리는 중이 될 때까지 기다린다 */
  async function waitUntilBlocked(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await admin.pool.query<{ wait_event_type: string | null }>('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
      if (rows[0]?.wait_event_type === 'Lock') return;
      if (Date.now() > deadline) throw new Error(`백엔드 ${pid}가 5초 안에 잠금 대기에 들어가지 않았다`);
      await sleep(20);
    }
  }

  test.each(['read committed', 'repeatable read', 'serializable'] as const)(
    '부분 유일 인덱스가 마지막 방어선이다: %s에서 두 트랜잭션이 모두 빈 좌석으로 보고 넣으려 해도 활성 행은 하나뿐이고 하나는 23505(또는 40001)로 끝난다 [S-T11] [ASVS v5.0.0-15.4.2]',
    async (level) => {
      const eventId = randomUUID();
      const seat = randomUUID();
      const [c1, c2] = [newClient(), newClient()];
      await Promise.all([c1.connect(), c2.connect()]);
      const errors: (pg.DatabaseError | null)[] = [];
      try {
        const pid2 = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
        await Promise.all([c1.query(`begin isolation level ${level}`), c2.query(`begin isolation level ${level}`)]);

        // 쓰기 스큐: 둘 다 '그 좌석에 활성 판매 행이 없다'를 읽는다
        const look = `select count(*)::int as n from seat_sale where event_id = $1 and seat_id = $2 and status in ('PENDING', 'SOLD')`;
        const [seen1, seen2] = await Promise.all([c1.query<{ n: number }>(look, [eventId, seat]), c2.query<{ n: number }>(look, [eventId, seat])]);
        expect([seen1.rows[0]!.n, seen2.rows[0]!.n], '둘 다 빈 좌석으로 본다').toEqual([0, 0]);

        const put = `insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, gen_random_uuid(), 'PENDING')`;
        await c1.query(put, [eventId, seat, randomUUID()]);
        // c1이 아직 끝나지 않았으니 c2의 같은 키 삽입은 c1의 결과를 기다린다
        const second = c2.query(put, [eventId, seat, randomUUID()]).then(() => null, (e: pg.DatabaseError) => e);
        await waitUntilBlocked(pid2);
        errors.push(await c1.query('commit').then(() => null, (e: pg.DatabaseError) => e));
        errors.push(await second);
        if (errors[1] === null) await c2.query('commit').catch((e: pg.DatabaseError) => errors.push(e));
        else await c2.query('rollback');
      } finally {
        await Promise.allSettled([c1.end(), c2.end()]);
      }

      // 둘 다 성공했다면 오버셀이다. 하나는 반드시 막혀야 하고, 막은 오류는 유일 위반(23505)이나 직렬화 실패(40001)다
      const failed = errors.filter((e): e is pg.DatabaseError => e !== null);
      expect(failed.length, '막힌 쪽이 하나는 있어야 한다').toBeGreaterThanOrEqual(1);
      expect(failed.map((e) => e.code).every((code) => code === '23505' || code === '40001')).toBe(true);
      expect(await activeCount(eventId, [seat])).toBe(1);
    },
  );
});

// ───────────────────────────── 실패 모양 ─────────────────────────────

describe('실패 모양', () => {
  test('풀 대기가 100ms를 넘으면 reserve는 429 server-busy ProblemError로 거절되고 DB에는 아무것도 남지 않으며, 연결이 풀린 뒤 같은 입력으로 다시 부르면 RESERVED다 [ASVS v5.0.0-16.5.2]', async () => {
    const tight = createDatabase({ url: server.url, profile: 'hot', max: 1, applicationName: 'seat-sales-tight' });
    const tightSales = new DrizzleSeatSales(tight);
    const p = newParty();
    const input = reserveOf(p, seatIds(2));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });

    try {
      // 첫 연결 맺기가 대기 한도(100ms)를 먹지 않게 쉬는 연결을 미리 만들어 둔다
      await warm(tight, 1);
      // 하나뿐인 연결을 열린 트랜잭션이 붙들고 있다
      const holder = tight.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        signalHeld();
        await gate;
      });
      try {
        await Promise.race([held, holder]);

        const startedAt = performance.now();
        const error = await tightSales.reserve(input).then(
          () => undefined,
          (e: unknown) => e,
        );
        const waitedMs = performance.now() - startedAt;

        expect(error, 'reserve가 거절되지 않고 끝났다').toBeInstanceOf(ProblemError);
        expect(error).toMatchObject({ status: 429, slug: 'server-busy' });
        // 핫패스 대기 한도 100ms 안팎: 기다리지 않고 곧바로 거절되지도, general 프로필의 1초까지 끌지도 않는다
        expect(waitedMs).toBeGreaterThanOrEqual(80);
        expect(waitedMs).toBeLessThan(900);
        expect(await traceOf(p)).toEqual({ rows: [], quota: null });
      } finally {
        openGate();
        await holder.catch(() => undefined);
      }

      expect(await tightSales.reserve(input)).toEqual({ status: 'RESERVED' });
      expect(await activeCount(p.eventId)).toBe(2);
    } finally {
      openGate();
      await tight.close();
    }
  });

  test('DB에 접속할 수 없으면(닫힌 포트) reserve는 던지고 RESERVED를 답하지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    // 지금 비어 있는 포트를 얻어 바로 닫는다: 그 포트에는 아무도 듣고 있지 않다
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const dead = createDatabase({ url: `postgres://postgres:peaket-test@127.0.0.1:${port}/peaket`, profile: 'general', max: 2, applicationName: 'seat-sales-dead' });

    try {
      const outcome = await new DrizzleSeatSales(dead).reserve(reserveOf(newParty(), seatIds(1))).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      expect(outcome, '접속할 수 없는데 결과를 답했다').not.toHaveProperty('result');
      const { error } = outcome as { error: unknown };
      expect(error).toBeInstanceOf(Error);
      // 뼈대의 '구현 전' 오류가 아니라 접속 거부가 원인이어야 한다
      expect(errorText(error)).toMatch(/ECONNREFUSED/);
    } finally {
      await dead.close();
    }
  });
});

// ───────────────────────────── 시험 검토(B)가 더한 시험 ─────────────────────────────

describe('잠금 차례와 입력 한계(시험 검토 B가 더함)', () => {
  /** 시험이 쓰는 풀의 application_name이 잠금 대기에 들어갈 때까지 기다린다 */
  async function waitUntilAppBlocked(applicationName: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await admin.pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'`,
        [applicationName],
      );
      if (rows[0]!.n > 0) return;
      if (Date.now() > deadline) throw new Error(`${applicationName}가 5초 안에 잠금 대기에 들어가지 않았다`);
      await sleep(20);
    }
  }

  test.each(['markSold', 'releasePending', 'returnSold'] as const)(
    '%s는 바꿀 행을 물리 순서가 아니라 좌석 ID 순으로 잠근다: 순차 훑기에서도 첫 좌석을 쥔 채 둘째 좌석에서 기다린다 [S-T10] [ASVS v5.0.0-15.4.3]',
    async (method) => {
      const p = newParty();
      const [s1, s2, s3] = seatIds(3);
      const status = method === 'returnSold' ? 'SOLD' : 'PENDING';
      // 물리 순서를 좌석 ID 내림차순으로 넣는다(order by가 없으면 순차 훑기가 s3, s2, s1 차례로 잠근다)
      for (const s of [s3!, s2!, s1!]) {
        await admin.pool.query(`insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, $5)`, [p.eventId, s, p.orderId, p.accountId, status]);
      }
      // 순차 훑기만 쓰는 풀: 인덱스 훑기를 끄면 계획이 물리 순서로 훑는다
      const applicationName = `seat-sales-lockorder-${method}`;
      const db = createDatabase({ url: server.url, profile: 'general', max: 2, applicationName });
      db.pool.on('connect', (client) => {
        void client.query('set enable_indexscan = off; set enable_bitmapscan = off');
      });
      const blocker = newClient();
      await blocker.connect();
      try {
        await warm(db, 1);
        await blocker.query('begin');
        await blocker.query('select 1 from seat_sale where event_id = $1 and seat_id = $2 and order_id = $3 for update', [p.eventId, s2, p.orderId]);
        const repo = new DrizzleSeatSales(db);
        const call = method === 'markSold' ? repo.markSold(orderOf(p, [s1!, s2!, s3!])) : repo[method](releaseOf(p, [s1!, s2!, s3!]));
        await waitUntilAppBlocked(applicationName);
        // 호출이 쥔 행은 건너뛴다: 좌석 ID 순이면 호출이 s1을 쥐고 s2에서 기다리니 s3만 비어 있다
        const free = await admin.pool.query<{ seat_id: string }>(
          'select seat_id from seat_sale where event_id = $1 and order_id = $2 order by seat_id for update skip locked',
          [p.eventId, p.orderId],
        );
        await blocker.query('rollback');
        expect(await call, '막은 쪽이 놓으면 세 행 모두 바꾼다').toBe(3);
        expect(free.rows.map((r) => r.seat_id), '호출은 s1을 쥐고 s2에서 기다린다(s3은 아직 안 잠갔다)').toEqual([s3]);
      } finally {
        await blocker.end().catch(() => undefined);
        await db.close();
      }
    },
  );

  test('한도가 DB 칸(int4)보다 크면 칸의 최댓값으로 맞춰 예약된다 [ASVS v5.0.0-2.2.1]', async () => {
    const p = newParty();
    expect(await sales.reserve(reserveOf(p, seatIds(2), { limit: Number.MAX_SAFE_INTEGER }))).toEqual({ status: 'RESERVED' });

    expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 2, limit: 2_147_483_647 });
  });

  test('기한이 날짜 범위를 넘으면 RangeError이고 한도 행도 좌석 행도 남지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const p = newParty();

    await expect(sales.reserve(reserveOf(p, seatIds(2), { pendingUntilMs: Number.MAX_SAFE_INTEGER }))).rejects.toThrow(RangeError);

    expect(await traceOf(p)).toEqual({ rows: [], quota: null });
  });
});

// ───────────────────────────── 코드 리뷰가 찾은 결함(재현 시험) ─────────────────────────────

describe('코드 리뷰가 찾은 결함(재현 시험)', () => {
  test('커밋 응답을 잃은 재시도: 같은 주문·같은 좌석으로 다시 부르면 RESERVED이고 한도를 다시 올리지 않으며 행도 그대로다(한도를 꽉 채운 주문도) [S-T8] [ASVS v5.0.0-2.3.3]', async () => {
    const p = newParty();
    const seats = seatIds(4);
    await place(p, seats, { limit: 4 });
    const before = await traceOf(p);

    expect(await sales.reserve(reserveOf(p, [...seats].reverse(), { limit: 4 }))).toEqual({ status: 'RESERVED' });

    expect(await traceOf(p)).toEqual(before);
  });

  test('같은 주문이 이미 넣은 좌석에 새 좌석을 더해 부르면 RESERVED가 아니라 SEAT_TAKEN(이미 넣은 좌석)이고 아무것도 바뀌지 않는다', async () => {
    const p = newParty();
    const [s1, s2, s3] = seatIds(3);
    await place(p, [s1!, s2!], { limit: 10 });
    const before = await traceOf(p);

    expect(await sales.reserve(reserveOf(p, [s1!, s2!, s3!], { limit: 10 }))).toEqual({ status: 'SEAT_TAKEN', seatIds: [s1, s2] });

    expect(await traceOf(p)).toEqual(before);
  });

  test.each(['releasePending', 'returnSold'] as const)(
    '%s에 그 주문의 계정이 아닌 계정을 넘기면 0행이고 좌석 행과 두 계정의 한도 행이 그대로다 [ASVS v5.0.0-2.3.2]',
    async (method) => {
      const owner = newParty();
      const other = newParty(owner.eventId);
      const seats = seatIds(2);
      if (method === 'returnSold') await placeSold(owner, seats);
      else await place(owner, seats);
      await place(other, randomSeats(1));
      const [ownerBefore, otherQuota] = [await traceOf(owner), await quotaOf(other.accountId, other.eventId)];

      expect(await sales[method]({ ...releaseOf(owner, seats), accountId: other.accountId })).toBe(0);

      expect(await traceOf(owner)).toEqual(ownerBefore);
      expect(await quotaOf(other.accountId, other.eventId)).toEqual(otherQuota);
    },
  );

  test('DB 기본 격리 수준이 REPEATABLE READ여도 같은 계정의 한도 경쟁이 오류 없이 정확히 한도만큼 예약된다(저장소가 READ COMMITTED를 직접 고른다) [S-T10] [ASVS v5.0.0-2.3.2]', async () => {
    const db = createDatabase({ url: server.url, profile: 'general', max: 10, applicationName: 'seat-sales-rr' });
    db.pool.on('connect', (client) => {
      void client.query(`set default_transaction_isolation = 'repeatable read'`);
    });
    try {
      await warm(db, 8);
      const repo = new DrizzleSeatSales(db);
      const p = newParty();
      const settled = await Promise.allSettled(randomSeats(8).map((s) => repo.reserve(reserveOf(nextOrder(p), [s], { limit: 4 }))));

      expect(rejections(settled)).toEqual([]);
      expect(
        fulfilledValues(settled)
          .map((r) => r.status)
          .sort(),
      ).toEqual(['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'RESERVED', 'RESERVED', 'RESERVED', 'RESERVED']);
      expect(await quotaOf(p.accountId, p.eventId)).toEqual({ used: 4, limit: 4 });
    } finally {
      await db.close();
    }
  });

  test('풀 대기가 넘치면 markSold도 reserve와 같은 모양(429 server-busy ProblemError 그대로)으로 거절되고 행이 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const tight = createDatabase({ url: server.url, profile: 'hot', max: 1, applicationName: 'seat-sales-tight-sold' });
    const p = newParty();
    const seats = seatIds(2);
    await place(p, seats);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    try {
      await warm(tight, 1);
      const holder = tight.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        signalHeld();
        await gate;
      });
      try {
        await Promise.race([held, holder]);
        const error = await new DrizzleSeatSales(tight).markSold(orderOf(p, seats)).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(error, 'markSold가 감싼 오류가 아니라 ProblemError 그대로 던져야 한다').toBeInstanceOf(ProblemError);
        expect(error).toMatchObject({ status: 429, slug: 'server-busy' });
        expect(Object.values(await statusesOf(p))).toEqual(['PENDING', 'PENDING']);
      } finally {
        openGate();
        await holder.catch(() => undefined);
      }
    } finally {
      openGate();
      await tight.close();
    }
  });

  test('좌석 수가 한도보다 많아도 틀린 기한은 QUOTA_EXCEEDED보다 먼저 RangeError로 거절한다 [ASVS v5.0.0-2.2.1]', async () => {
    const p = newParty();

    await expect(sales.reserve(reserveOf(p, seatIds(5), { limit: 4, pendingUntilMs: Number.MAX_SAFE_INTEGER }))).rejects.toThrow(RangeError);

    expect(await traceOf(p)).toEqual({ rows: [], quota: null });
  });
});
