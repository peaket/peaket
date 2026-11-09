// 판매 확정(Hard Sale) 저장소의 purchase DB 구현(Drizzle, BUILD_ORDER PRF-140 ①, 규칙은 docs/features/seat-hold.md §6 'Hard Sale 저장소의 첫 구현').
// 트랜잭션은 모두 READ COMMITTED 하나고(서버 기본값에 기대지 않고 직접 고른다), 잠그는 순서는 한도 행(purchase_quota) → 좌석 행(seat_sale, 좌석 ID 순)이다.
// 좌석 ID 묶음은 `array[$1::uuid, …]`로 넘긴다(drizzle의 sql 템플릿은 배열 값을 나열로 펼치므로 uuid[] 매개변수 하나로 넘길 수 없다).
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SeatSales } from '../../domain/ports.js';
import {
  assertReserveInput,
  assertSeatSaleOrder,
  assertSeatSaleRelease,
  type ReserveInput,
  type ReserveResult,
  type SeatSaleOrder,
  type SeatSaleRelease,
  sortedSeatIds,
} from '../../domain/seat-sale.js';

/** 트랜잭션을 되돌리려고 던지는 표지. 바깥에서 받아 결과로 돌려준다(오류가 아니다) */
class Rollback extends Error {
  constructor(readonly result: ReserveResult) {
    super('rollback');
  }
}

/** PostgreSQL int4의 최댓값. 한도 칸이 int4라 이보다 큰 한도는 '사실상 한도 없음'으로 이 값에 맞춘다(주문 하나가 10석 이하라 쌓이는 값이 이 값에 닿을 수 없다) */
const INT4_MAX = 2_147_483_647;

/** 모든 트랜잭션의 격리 수준. 서버·역할 기본값에 기대지 않는다(기본값이 REPEATABLE READ면 한도 행 경쟁이 40001로 끝난다) */
const TX = { isolationLevel: 'read committed' } as const;

const uuidArray = (ids: readonly string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;

/**
 * 바꿀 행을 좌석 ID 순으로 잠그는 조회. 같은 주문의 markSold·releasePending·returnSold가 겹쳐도 다중 좌석 행을 같은 차례로 잠가
 * 서로를 기다리지 않는다(문장 하나의 갱신·삭제는 행을 훑는 차례를 약속하지 않는다). accountId를 주면 그 계정이 넣은 행만 잡는다
 */
const lockedRows = (eventId: string, orderId: string, seatIds: readonly string[], status: 'PENDING' | 'SOLD', accountId?: string) => sql`
  select seat_id from seat_sale
  where event_id = ${eventId}::uuid and order_id = ${orderId}::uuid and seat_id = any(${uuidArray(seatIds)}) and status = ${status}
    ${accountId === undefined ? sql`` : sql`and account_id = ${accountId}::uuid`}
  order by seat_id for update`;

export class DrizzleSeatSales implements SeatSales {
  constructor(private readonly database: Database) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const checked = checkedReserve(input);
    // 좌석 수가 한도보다 크면 DB에 가지 않는다(행을 새로 넣는 길에서 CHECK 제약이 먼저 터지지 않게 하는 이유도 된다)
    if (checked.n > input.limit) return { status: 'QUOTA_EXCEEDED' };
    try {
      return await this.database.transaction(async (tx) => {
        const r = await reserveRows(tx, input, checked);
        // RESERVED가 아니면 앞서 올린 한도와 넣은 행이 남지 않게 트랜잭션째 되돌린다
        if (r.status !== 'RESERVED') throw new Rollback(r);
        return r;
      }, TX);
    } catch (err) {
      if (err instanceof Rollback) return err.result;
      throw err;
    }
  }

  /**
   * reserve와 같은 규칙(⓪ → ① 한도 행 → ② 좌석 행)을 부르는 쪽의 트랜잭션 안에서 한다(Saga 판매 예약 트랜잭션, BUILD_ORDER PRF-165).
   * 트랜잭션을 열지도 끝내지도 않는다(격리 수준은 부르는 쪽이 READ COMMITTED로 고른다).
   * RESERVED가 아니면(QUOTA_EXCEEDED·SEAT_TAKEN) 한도 행 올림이나 넣은 좌석 행이 남아 있을 수 있어 부르는 쪽이 그 트랜잭션째 되돌려야 한다.
   * @throws RangeError 입력 모양이 틀림(assertReserveInput, DB에 가지 않는다) · DB 오류는 그대로
   */
  async reserveIn(tx: DbTransaction, input: ReserveInput): Promise<ReserveResult> {
    const checked = checkedReserve(input);
    if (checked.n > input.limit) return { status: 'QUOTA_EXCEEDED' };
    return reserveRows(tx, input, checked);
  }

  /**
   * releasePending과 같은 규칙(한도 행 잠금 → 좌석 ID 순 잠금 → PENDING 지우기 → 한도 줄이기)을 부르는 쪽의 트랜잭션 안에서 한다(Saga T11, PRF-165).
   * 지운 행 수를 돌려준다(두 번째 호출은 0).
   * @throws RangeError 입력 모양이 틀림(assertSeatSaleRelease) · DB 오류는 그대로
   */
  async releasePendingIn(tx: DbTransaction, release: SeatSaleRelease): Promise<number> {
    assertSeatSaleRelease(release);
    return settleIn(tx, release, deletePending(release));
  }

  /**
   * markSold와 같은 규칙(그 주문의 PENDING 행을 좌석 ID 순으로 잠가 SOLD로, pending_until 비움)을 부르는 쪽의 트랜잭션 안에서 한다
   * (결제 결과 반영의 승인 트랜잭션, BUILD_ORDER PRF-163). 트랜잭션을 열지도 끝내지도 않는다(격리 수준은 부르는 쪽이 READ COMMITTED로 고른다).
   * 바꾼 행 수를 돌려준다(두 번째 호출은 0).
   * @throws RangeError 입력 모양이 틀림(assertSeatSaleOrder, DB에 가지 않는다) · DB 오류는 그대로
   */
  /**
   * 그 주문의 PENDING 행을 좌석 ID 순으로 잠가 pending_until을 쓴다(입금 대기, 부르는 쪽의 트랜잭션 안, BUILD_ORDER HOT-151). 바꾼 행 수.
   * @throws RangeError seatIds가 비었거나 pendingUntilMs가 날짜 범위 밖
   */
  async setPendingUntilIn(tx: DbTransaction, order: SeatSaleOrder & { pendingUntilMs: number }): Promise<number> {
    const seatIds = sortedSeatIds(order.seatIds);
    const until = new Date(order.pendingUntilMs);
    if (Number.isNaN(until.getTime())) throw new RangeError('pendingUntilMs가 날짜 범위를 넘었다');
    const done = await tx.execute(sql`
      with locked as (${lockedRows(order.eventId, order.orderId, seatIds, 'PENDING')})
      update seat_sale s set pending_until = ${until}::timestamptz
      from locked l
      where s.event_id = ${order.eventId}::uuid and s.order_id = ${order.orderId}::uuid and s.seat_id = l.seat_id and s.status = 'PENDING'
      returning s.seat_id`);
    return done.rows.length;
  }

  async markSoldIn(tx: DbTransaction, order: SeatSaleOrder): Promise<number> {
    assertSeatSaleOrder(order);
    return markSoldRows(tx, order, sortedSeatIds(order.seatIds));
  }

  async markSold(order: SeatSaleOrder): Promise<number> {
    assertSeatSaleOrder(order);
    const seatIds = sortedSeatIds(order.seatIds);
    // 트랜잭션으로 부른다: 풀 대기 초과가 다른 연산과 같은 모양(429 ProblemError 그대로)으로 나온다
    return this.database.transaction((tx) => markSoldRows(tx, order, seatIds), TX);
  }

  async releasePending(release: SeatSaleRelease): Promise<number> {
    assertSeatSaleRelease(release);
    return this.#settle(release, deletePending(release));
  }

  async returnSold(release: SeatSaleRelease): Promise<number> {
    assertSeatSaleRelease(release);
    const seatIds = sortedSeatIds(release.seatIds);
    return this.#settle(release, (tx) =>
      tx.execute(sql`
        with locked as (${lockedRows(release.eventId, release.orderId, seatIds, 'SOLD', release.accountId)})
        update seat_sale s set status = 'RETURNED'
        from locked l
        where s.event_id = ${release.eventId}::uuid and s.order_id = ${release.orderId}::uuid and s.seat_id = l.seat_id and s.status = 'SOLD'
        returning s.seat_id`),
    );
  }

  /**
   * 한도를 되돌리는 두 연산의 공통 길: 한도 행을 먼저 잠그고(reserve와 같은 차례) 그 계정이 넣은 좌석 행만 바꾼 뒤 바뀐 행 수만큼 줄인다.
   * 다른 계정을 넘기면 좌석 행이 잡히지 않아 0행이고 어느 한도 행도 줄지 않는다
   */
  #settle(release: SeatSaleRelease, change: (tx: DbTransaction) => Promise<{ rows: unknown[] }>): Promise<number> {
    return this.database.transaction((tx) => settleIn(tx, release, change), TX);
  }
}

/** 판매 예약 입력 검사(DB에 가기 전)와 정렬한 좌석·한도·기한 */
function checkedReserve(input: ReserveInput): { seatIds: string[]; n: number; limit: number; pendingUntil: Date | null } {
  assertReserveInput(input);
  const seatIds = sortedSeatIds(input.seatIds);
  const pendingUntil = input.pendingUntilMs === undefined ? null : new Date(input.pendingUntilMs);
  if (pendingUntil !== null && Number.isNaN(pendingUntil.getTime())) throw new RangeError('pendingUntilMs가 날짜 범위를 넘었다');
  return { seatIds, n: seatIds.length, limit: Math.min(input.limit, INT4_MAX), pendingUntil };
}

/**
 * 판매 예약의 문장들(⓪ → ① 한도 행 → ② 좌석 행)을 주어진 트랜잭션에서 한다. 되돌리지 않는다: RESERVED가 아니면 부르는 쪽이 트랜잭션째 되돌린다
 * (reserve는 표지 오류로, Saga 판매 예약 트랜잭션은 자기 표지 오류로)
 */
async function reserveRows(
  tx: DbTransaction,
  input: ReserveInput,
  c: { seatIds: string[]; n: number; limit: number; pendingUntil: Date | null },
): Promise<ReserveResult> {
  const { seatIds, n, limit, pendingUntil } = c;
  // ⓪ 커밋 응답을 잃은 재시도: 같은 계정·주문의 활성 행이 그 좌석들에 모두 있으면 이미 반영된 것이다. 한도를 다시 올리지 않는다
  const own = await tx.execute(sql`
    select count(*)::int as n from seat_sale
    where event_id = ${input.eventId}::uuid and order_id = ${input.orderId}::uuid and account_id = ${input.accountId}::uuid
      and seat_id = any(${uuidArray(seatIds)}) and status in ('PENDING', 'SOLD')`);
  if ((own.rows[0] as { n: number }).n === n) return { status: 'RESERVED' };
  // ① 한도 행을 조건부로 올린다(한 문장). 올리면 한도를 넘는 경우엔 갱신되지 않아 행이 돌아오지 않는다
  const quota = await tx.execute(sql`
    insert into purchase_quota (account_id, event_id, used, limit_count)
    values (${input.accountId}::uuid, ${input.eventId}::uuid, ${n}::int, ${limit}::int)
    on conflict (account_id, event_id) do update
      set used = purchase_quota.used + ${n}::int, limit_count = excluded.limit_count
      where purchase_quota.used + ${n}::int <= excluded.limit_count
    returning used`);
  if (quota.rows.length === 0) return { status: 'QUOTA_EXCEEDED' };
  // ② 좌석을 정렬 순서대로 한 문장으로 넣는다. 활성 판매 행이 있는 좌석은 돌아오지 않는다
  const inserted = await tx.execute(sql`
    insert into seat_sale (event_id, seat_id, order_id, account_id, status, reserved_at, pending_until)
    select ${input.eventId}::uuid, t.seat_id, ${input.orderId}::uuid, ${input.accountId}::uuid, 'PENDING', now(), ${pendingUntil}::timestamptz
    from unnest(${uuidArray(seatIds)}) with ordinality as t(seat_id, ord)
    order by t.ord
    on conflict (event_id, seat_id) where status in ('PENDING', 'SOLD') do nothing
    returning seat_id`);
  if (inserted.rows.length !== n) {
    const got = new Set((inserted.rows as { seat_id: string }[]).map((r) => r.seat_id));
    return { status: 'SEAT_TAKEN', seatIds: input.seatIds.filter((id) => !got.has(id)) };
  }
  return { status: 'RESERVED' };
}

/** 그 주문의 PENDING 행을 좌석 ID 순으로 잠가 SOLD로 바꾸는 문장(pending_until 비움, markSold·markSoldIn). 바꾼 행 수 */
async function markSoldRows(tx: DbTransaction, order: SeatSaleOrder, seatIds: readonly string[]): Promise<number> {
  const done = await tx.execute(sql`
    with locked as (${lockedRows(order.eventId, order.orderId, seatIds, 'PENDING')})
    update seat_sale s set status = 'SOLD', pending_until = null
    from locked l
    where s.event_id = ${order.eventId}::uuid and s.order_id = ${order.orderId}::uuid and s.seat_id = l.seat_id and s.status = 'PENDING'
    returning s.seat_id`);
  return done.rows.length;
}

/** 그 주문·계정의 PENDING 행을 좌석 ID 순으로 잠가 지우는 문장(releasePending·releasePendingIn) */
function deletePending(release: SeatSaleRelease): (tx: DbTransaction) => Promise<{ rows: unknown[] }> {
  const seatIds = sortedSeatIds(release.seatIds);
  return (tx) =>
    tx.execute(sql`
      with locked as (${lockedRows(release.eventId, release.orderId, seatIds, 'PENDING', release.accountId)})
      delete from seat_sale s using locked l
      where s.event_id = ${release.eventId}::uuid and s.order_id = ${release.orderId}::uuid and s.seat_id = l.seat_id and s.status = 'PENDING'
      returning s.seat_id`);
}

/**
 * 한도를 되돌리는 연산의 공통 문장들(주어진 트랜잭션 안): 한도 행을 먼저 잠그고(reserve와 같은 차례) 그 계정이 넣은 좌석 행만 바꾼 뒤 바뀐 행 수만큼 줄인다.
 * 다른 계정을 넘기면 좌석 행이 잡히지 않아 0행이고 어느 한도 행도 줄지 않는다
 */
async function settleIn(tx: DbTransaction, release: SeatSaleRelease, change: (tx: DbTransaction) => Promise<{ rows: unknown[] }>): Promise<number> {
  await tx.execute(sql`select 1 from purchase_quota where account_id = ${release.accountId}::uuid and event_id = ${release.eventId}::uuid for update`);
  const changed = (await change(tx)).rows.length;
  if (changed > 0) {
    await tx.execute(sql`
      update purchase_quota set used = greatest(used - ${changed}::int, 0)
      where account_id = ${release.accountId}::uuid and event_id = ${release.eventId}::uuid`);
  }
  return changed;
}
