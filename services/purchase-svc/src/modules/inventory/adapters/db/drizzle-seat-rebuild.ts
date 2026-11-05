// 다시 만들기의 purchase DB 쪽(BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현', docs/data.md §4 '다시 만들기 표와 원장 칸').
// acquire는 seat_rebuild 회차 행 하나를 임대로 잡으면서 판 번호를 올리는 한 문장이다(바로 커밋. 행이 없으면 판 번호 2로 넣는다).
//
// 구현에서 정한 세부(PRF-143):
// - 모든 문장은 트랜잭션 없이 한 문장씩 보낸다(자동 커밋. 열린 트랜잭션을 남기지 않는다). 시각은 모두 DB 시계 now()다.
// - acquire: INSERT … VALUES (회차, 2, holder, now() + 임대) ON CONFLICT (event_id) DO UPDATE SET gen = gen + 1, holder, lease_until
//   WHERE lease_until이 비었거나 지남 RETURNING gen. 임대 중이면(같은 holder여도) 0행이라 null. 두 파드가 한꺼번에 불러도 행 잠금으로 하나만 받는다.
// - release: 그 holder일 때만 holder·lease_until을 비운다. setGen이면 같은 문장에서 gen = setGen(세대 키의 gen에 맞춘다, 코드 리뷰로 revertGen 대신).
// - sales: seat_sale PENDING·SOLD, holds: seat_hold HELD이고 expires_at > now(), saleHolds: seat_hold HELD이고 같은 회차·좌석·계정의 활성 판매(PENDING·SOLD)가 있는 행
//   (만료 조건 없음). 토큰(bigint)은 안전한 정수로 바꾸고, 아니면 Error. 차례는 좌석 ID(와 토큰) 순.
// - ledgerRows(BUILD_ORDER PRF-167 리뷰 고침 M2): 그 회차·그 좌석들의 seat_hold 행 전부(상태·holdId 상관없이 좌석·holdId·상태·토큰). 묶인 주문 좌석의 원장 대조용.
// - 회차 ID가 소문자 UUID가 아니거나 holder가 빈 글이면 DB를 부르기 전에 RangeError다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SeatRebuildSource } from '../../domain/ports.js';
import { REBUILD_LEASE_MS, type RebuildHold, type RebuildLedgerRow, type RebuildSale } from '../../domain/rebuild.js';
import { SALE_UUID_PATTERN } from '../../domain/seat-sale.js';

/** ledgerRows 한 질의의 좌석 ID 수 [가정] */
const LEDGER_SEAT_CHUNK = 1_000;

const assertEvent = (eventId: string): void => {
  if (!SALE_UUID_PATTERN.test(eventId)) throw new RangeError('회차 ID가 소문자 UUID가 아니다');
};
const assertHolder = (holder: string): void => {
  if (typeof holder !== 'string' || holder.length === 0) throw new RangeError('holder가 비었다');
};

/** pg가 돌려준 bigint 글(또는 수) → 안전한 정수 */
function safeIntOf(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isSafeInteger(n)) throw new Error(`${what}이(가) 안전한 정수가 아니다: ${String(v)}`);
  return n;
}

const msOf = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

export class DrizzleSeatRebuildSource implements SeatRebuildSource {
  readonly #leaseMs: number;

  constructor(
    private readonly database: Database,
    /** 임대 길이(기본 REBUILD_LEASE_MS) */
    leaseMs?: number,
  ) {
    const ms = leaseMs ?? REBUILD_LEASE_MS;
    if (!Number.isSafeInteger(ms) || ms < 1) throw new RangeError(`임대 길이는 1 이상의 정수(ms)다: ${ms}`);
    this.#leaseMs = ms;
  }

  async acquire(eventId: string, holder: string): Promise<number | null> {
    assertEvent(eventId);
    assertHolder(holder);
    const r = await this.database.db.execute(sql`
      insert into seat_rebuild (event_id, gen, holder, lease_until)
      values (${eventId}::uuid, 2, ${holder}, now() + ${this.#leaseMs}::int * interval '1 millisecond')
      on conflict (event_id) do update set gen = seat_rebuild.gen + 1, holder = excluded.holder, lease_until = excluded.lease_until
      where seat_rebuild.lease_until is null or seat_rebuild.lease_until < now()
      returning gen`);
    if (r.rows.length === 0) return null;
    return safeIntOf((r.rows[0] as { gen: unknown }).gen, '판 번호');
  }

  async sales(eventId: string): Promise<RebuildSale[]> {
    assertEvent(eventId);
    const r = await this.database.db.execute(sql`
      select seat_id::text as seat_id, account_id::text as account_id, order_id::text as order_id
        from seat_sale
       where event_id = ${eventId}::uuid and status in ('PENDING', 'SOLD')
       order by seat_id`);
    return r.rows.map((x) => {
      const row = x as { seat_id: string; account_id: string; order_id: string };
      return { seatId: row.seat_id, accountId: row.account_id, orderId: row.order_id };
    });
  }

  async holds(eventId: string): Promise<RebuildHold[]> {
    assertEvent(eventId);
    const r = await this.database.db.execute(sql`
      select seat_id::text as seat_id, account_id::text as account_id, fencing_token::text as fencing_token, kind, held_at, expires_at,
             hold_id::text as hold_id, purchase_session_id
        from seat_hold
       where event_id = ${eventId}::uuid and status = 'HELD' and expires_at > now()
       order by seat_id, fencing_token`);
    return r.rows.map(holdOf);
  }

  async saleHolds(eventId: string): Promise<RebuildHold[]> {
    assertEvent(eventId);
    const r = await this.database.db.execute(sql`
      select h.seat_id::text as seat_id, h.account_id::text as account_id, h.fencing_token::text as fencing_token, h.kind, h.held_at, h.expires_at,
             h.hold_id::text as hold_id, h.purchase_session_id
        from seat_hold h
       where h.event_id = ${eventId}::uuid and h.status = 'HELD'
         and exists (select 1 from seat_sale s
                      where s.event_id = h.event_id and s.seat_id = h.seat_id and s.account_id = h.account_id and s.status in ('PENDING', 'SOLD'))
       order by h.seat_id, h.fencing_token`);
    return r.rows.map(holdOf);
  }

  async ledgerRows(eventId: string, seatIds: readonly string[]): Promise<RebuildLedgerRow[]> {
    assertEvent(eventId);
    for (const id of seatIds) if (!SALE_UUID_PATTERN.test(id)) throw new RangeError('좌석 ID가 소문자 UUID가 아니다');
    const ids = [...new Set(seatIds)];
    const out: RebuildLedgerRow[] = [];
    // 좌석 ID는 배열 글 하나(`{…}`::uuid[])로, 1,000개씩 [가정] 나눠 묻는다. 기본 키(event_id, seat_id, fencing_token)의 앞 두 칸으로 닿는다
    for (let k = 0; k < ids.length; k += LEDGER_SEAT_CHUNK) {
      const chunk = ids.slice(k, k + LEDGER_SEAT_CHUNK);
      const r = await this.database.db.execute(sql`
        select seat_id::text as seat_id, hold_id::text as hold_id, status, fencing_token::text as fencing_token
          from seat_hold
         where event_id = ${eventId}::uuid and seat_id = any(${`{${chunk.join(',')}}`}::uuid[])
         order by seat_id, fencing_token`);
      for (const x of r.rows) {
        const row = x as { seat_id: string; hold_id: string | null; status: string; fencing_token: unknown };
        if (row.status !== 'HELD' && row.status !== 'RELEASED' && row.status !== 'EXPIRED') throw new Error(`원장 행 상태가 HELD·RELEASED·EXPIRED가 아니다: ${row.status}`);
        out.push({ seatId: row.seat_id, holdId: row.hold_id, status: row.status, fencingToken: safeIntOf(row.fencing_token, '펜싱 토큰') });
      }
    }
    return out;
  }

  async release(eventId: string, holder: string, o?: { setGen?: number }): Promise<void> {
    assertEvent(eventId);
    assertHolder(holder);
    if (o?.setGen !== undefined) {
      if (!Number.isSafeInteger(o.setGen) || o.setGen < 1) throw new RangeError(`맞출 판 번호가 1 이상의 정수가 아니다: ${o.setGen}`);
      await this.database.db.execute(sql`
        update seat_rebuild set gen = ${o.setGen}, holder = null, lease_until = null
         where event_id = ${eventId}::uuid and holder = ${holder}`);
      return;
    }
    await this.database.db.execute(sql`
      update seat_rebuild set holder = null, lease_until = null
       where event_id = ${eventId}::uuid and holder = ${holder}`);
  }
}

/** seat_hold 행 → RebuildHold(토큰은 안전한 정수, 종류는 FAN·PRIORITY만) */
function holdOf(x: unknown): RebuildHold {
  const row = x as { seat_id: string; account_id: string; fencing_token: string; kind: string; held_at: unknown; expires_at: unknown; hold_id: string | null; purchase_session_id: string | null };
  if (row.kind !== 'FAN' && row.kind !== 'PRIORITY') throw new Error(`원장 홀드의 종류를 모른다: ${row.kind}`);
  return {
    seatId: row.seat_id,
    accountId: row.account_id,
    fencingToken: safeIntOf(row.fencing_token, '펜싱 토큰'),
    kind: row.kind,
    heldAtMs: row.held_at === null ? null : msOf(row.held_at),
    expiresAtMs: msOf(row.expires_at),
    holdId: row.hold_id,
    purchaseSessionId: row.purchase_session_id,
  };
}
