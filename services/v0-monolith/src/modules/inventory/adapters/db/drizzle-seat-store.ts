// 좌석 저장 포트의 PostgreSQL 어댑터(docs/features/seat-hold.md §14). 좌석 행을 요청 순서대로 SELECT … FOR UPDATE로 잠근다(K2·K3의 v0).
// SQL은 Drizzle 빌더와 sql 템플릿의 매개변수로만 쓴다(asvs/v0-baseline.md 1.2.4). 목록 값은 JSON 매개변수 하나로 넘긴다
// (sql 템플릿은 배열을 값 여러 개로 펼치므로). 변경분은 같은 트랜잭션의 pg_notify로 내므로 커밋될 때만 나간다.
import { randomUUID } from 'node:crypto';
import { type Database, type DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import {
  STATEMENT_TIMEOUT_MS,
  type ExtendResult,
  type HoldRecord,
  type HoldResult,
  type ReleaseResult,
  type SeatDefinition,
  type SeatDelta,
  type SeatEventConfig,
  type SeatStatus,
  type SeatView,
} from '../../domain/inventory.js';
import type { SeatStore } from '../../domain/ports.js';
import { DELTA_CHANNEL } from './pg-delta-feed.js';
import { v0Seat, v0SeatEvent } from './schema.js';

/** 잠금 경합으로 PostgreSQL이 끊은 오류: 교착 상태, 문장 시간 초과, 잠금 대기 실패(§14 동작 2) */
const BUSY_CODES = new Set(['40P01', '57014', '55P03']);
/** pg_notify 한 번에 싣는 좌석 수(64자 ID 50개도 알림 본문 상한 8000바이트 안, 새 맥락 리뷰) */
const NOTIFY_CHUNK = 50;
/** 좌석을 넣을 때 한 문장의 행 수 */
const INSERT_CHUNK = 1_000;

function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** 바꾸지 않고 끝낼 결과. 던져서 트랜잭션을 되돌린다(앞에서 넣은 보유 수 행 같은 쓰기가 남지 않게, 새 맥락 리뷰) */
class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super('되돌림');
  }
}

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000)`;
const msOf = (v: unknown): number => Math.round(Number(v));

interface HoldRow {
  hold_id: string;
  event_id: string;
  account_id: string;
  seat_ids: string[];
  status: string;
  extended: boolean;
  expires_ms: string | number;
}

async function rows<T>(tx: DbTransaction, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)).rows as T[];
}

async function notify(tx: DbTransaction, eventId: string, seatIds: string[], status: SeatStatus, atMs: number): Promise<void> {
  for (let i = 0; i < seatIds.length; i += NOTIFY_CHUNK) {
    const delta: SeatDelta = { eventId, changes: seatIds.slice(i, i + NOTIFY_CHUNK).map((seatId) => ({ seatId, status })), atMs };
    await tx.execute(sql`select pg_notify(${DELTA_CHANNEL}, ${JSON.stringify(delta)})`);
  }
}

/** 홀드의 좌석을 빈 좌석으로 되돌린다(해제·만료). 좌석은 기본 키로 찾는다(회차 전체를 훑지 않게, 새 맥락 리뷰) */
async function freeSeats(tx: DbTransaction, h: HoldRow, to: 'RELEASED' | 'EXPIRED', nowMs: number): Promise<void> {
  const ids = JSON.stringify(h.seat_ids);
  await tx.execute(
    sql`update v0_seat set status = 'AVAILABLE', hold_id = null where event_id = ${h.event_id} and seat_id in (select jsonb_array_elements_text(${ids}::jsonb)) and hold_id = ${h.hold_id}`,
  );
  await tx.execute(sql`update v0_hold set status = ${to} where hold_id = ${h.hold_id}`);
  await notify(tx, h.event_id, h.seat_ids, 'AVAILABLE', nowMs);
}

/** 보유 수를 줄인다. (회차, 계정) 순서로 잠가 복제본 둘의 만료가 서로 기다리지 않게 한다(새 맥락 리뷰) */
async function decreaseQuota(tx: DbTransaction, holds: HoldRow[]): Promise<void> {
  const by = new Map<string, { eventId: string; accountId: string; n: number }>();
  for (const h of holds) {
    const k = JSON.stringify([h.event_id, h.account_id]);
    const cur = by.get(k) ?? { eventId: h.event_id, accountId: h.account_id, n: 0 };
    cur.n += h.seat_ids.length;
    by.set(k, cur);
  }
  const ordered = [...by.values()].sort((a, b) => (a.eventId === b.eventId ? (a.accountId < b.accountId ? -1 : 1) : a.eventId < b.eventId ? -1 : 1));
  for (const q of ordered) {
    await tx.execute(sql`update v0_quota set held = greatest(held - ${q.n}::int, 0) where event_id = ${q.eventId} and account_id = ${q.accountId}`);
  }
}

const holdColumns = sql`hold_id, event_id, account_id, seat_ids, status, extended, extract(epoch from expires_at) * 1000 as expires_ms`;

const record = (h: HoldRow): HoldRecord => ({ holdId: h.hold_id, eventId: h.event_id, seatIds: h.seat_ids, expiresAtMs: msOf(h.expires_ms), extended: h.extended });

export class DrizzleSeatStore implements SeatStore {
  constructor(private readonly database: Database) {}

  /** 트랜잭션 하나(문장 시간 상한 1초). 잠금 경합으로 끊기면 busy */
  private async tx<T>(fn: (tx: DbTransaction) => Promise<T>, busy: T): Promise<T> {
    try {
      return await this.database.transaction(fn, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof Rollback) return err.result as T;
      const code = pgCode(err);
      if (code && BUSY_CODES.has(code)) return busy;
      throw err;
    }
  }

  async open(eventId: string, config: Required<SeatEventConfig>, seats: SeatDefinition[]): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx
        .insert(v0SeatEvent)
        .values({ eventId, perPersonLimit: config.perPersonLimit, holdTtlMs: config.holdTtlMs, extendMs: config.extendMs })
        .onConflictDoUpdate({ target: v0SeatEvent.eventId, set: { perPersonLimit: config.perPersonLimit, holdTtlMs: config.holdTtlMs, extendMs: config.extendMs } });
      for (let i = 0; i < seats.length; i += INSERT_CHUNK) {
        await tx
          .insert(v0Seat)
          .values(
            seats.slice(i, i + INSERT_CHUNK).map((s) => ({
              eventId,
              seatId: s.id,
              section: s.section,
              rowLabel: s.row,
              seatNumber: s.number,
              x: s.x,
              y: s.y,
              grade: s.grade,
              status: 'AVAILABLE',
            })),
          )
          .onConflictDoNothing();
      }
    });
  }

  async seats(eventId: string): Promise<SeatView[] | null> {
    const found = await this.database.db.execute(sql`select 1 from v0_seat_event where event_id = ${eventId}`);
    if (found.rows.length === 0) return null;
    const r = await this.database.db.execute(
      sql`select seat_id as id, section, row_label as row, seat_number as number, x, y, grade, status from v0_seat where event_id = ${eventId} order by seat_id`,
    );
    return r.rows as unknown as SeatView[];
  }

  async hold(eventId: string, accountId: string, seatIds: string[], nowMs: number): Promise<HoldResult> {
    const ids = JSON.stringify(seatIds);
    return this.tx<HoldResult>(async (tx) => {
      const [ev] = await rows<{ per_person_limit: number; hold_ttl_ms: number }>(tx, sql`select per_person_limit, hold_ttl_ms from v0_seat_event where event_id = ${eventId}`);
      if (!ev) throw new Rollback<HoldResult>({ kind: 'seats-not-found' });
      const [known] = await rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from v0_seat where event_id = ${eventId} and seat_id in (select jsonb_array_elements_text(${ids}::jsonb))`,
      );
      if (!known || known.n !== seatIds.length) throw new Rollback<HoldResult>({ kind: 'invalid-seat' });
      // 요청에 적힌 순서대로 하나씩 잠근다(정렬하지 않는다: K3의 v0)
      for (const seatId of seatIds) {
        const [seat] = await rows<{ status: string }>(tx, sql`select status from v0_seat where event_id = ${eventId} and seat_id = ${seatId} for update`);
        if (!seat || seat.status !== 'AVAILABLE') throw new Rollback<HoldResult>({ kind: 'seat-already-held', seatId });
      }
      await tx.execute(sql`insert into v0_quota (event_id, account_id, held) values (${eventId}, ${accountId}, 0) on conflict do nothing`);
      const n = seatIds.length;
      const quota = await rows(
        tx,
        sql`update v0_quota set held = held + ${n}::int where event_id = ${eventId} and account_id = ${accountId} and held + ${n}::int <= ${ev.per_person_limit}::int returning held`,
      );
      if (quota.length === 0) throw new Rollback<HoldResult>({ kind: 'purchase-limit-exceeded' });
      const holdId = randomUUID();
      const expiresAtMs = nowMs + ev.hold_ttl_ms;
      await tx.execute(sql`update v0_seat set status = 'HELD', hold_id = ${holdId} where event_id = ${eventId} and seat_id in (select jsonb_array_elements_text(${ids}::jsonb))`);
      await tx.execute(
        sql`insert into v0_hold (hold_id, event_id, account_id, seat_ids, status, extended, held_at, expires_at)
            values (${holdId}, ${eventId}, ${accountId}, array(select jsonb_array_elements_text(${ids}::jsonb)), 'HELD', false, ${ts(nowMs)}, ${ts(expiresAtMs)})`,
      );
      await notify(tx, eventId, seatIds, 'HELD', nowMs);
      return { kind: 'held', hold: { holdId, eventId, seatIds: [...seatIds], expiresAtMs, extended: false } };
    }, { kind: 'busy' });
  }

  async release(holdId: string, accountId: string, nowMs: number): Promise<ReleaseResult> {
    return this.tx<ReleaseResult>(async (tx) => {
      const [h] = await rows<HoldRow>(tx, sql`select ${holdColumns} from v0_hold where hold_id = ${holdId} for update`);
      if (!h || h.account_id !== accountId) return { kind: 'hold-not-found' };
      if (h.status !== 'HELD') return { kind: 'already-ended' };
      await freeSeats(tx, h, 'RELEASED', nowMs);
      await decreaseQuota(tx, [h]);
      return { kind: 'released' };
    }, { kind: 'busy' });
  }

  async extend(holdId: string, accountId: string, nowMs: number): Promise<ExtendResult> {
    return this.tx<ExtendResult>(async (tx) => {
      const [h] = await rows<HoldRow>(tx, sql`select ${holdColumns} from v0_hold where hold_id = ${holdId} for update`);
      if (!h || h.account_id !== accountId || h.status !== 'HELD' || msOf(h.expires_ms) <= nowMs) return { kind: 'hold-not-found' };
      if (h.extended) return { kind: 'hold-already-extended' };
      const [u] = await rows<HoldRow>(
        tx,
        sql`update v0_hold set expires_at = expires_at + make_interval(secs => e.extend_ms::double precision / 1000), extended = true
            from v0_seat_event e where v0_hold.hold_id = ${holdId} and e.event_id = v0_hold.event_id
            returning v0_hold.hold_id, v0_hold.event_id, v0_hold.account_id, v0_hold.seat_ids, v0_hold.status, v0_hold.extended, extract(epoch from v0_hold.expires_at) * 1000 as expires_ms`,
      );
      if (!u) return { kind: 'hold-not-found' };
      return { kind: 'extended', hold: record(u) };
    }, { kind: 'busy' });
  }

  async expireDue(nowMs: number, limit: number): Promise<number> {
    const n = await this.tx<number | 'busy'>(async (tx) => {
      const due = await rows<HoldRow>(
        tx,
        sql`select ${holdColumns} from v0_hold where status = 'HELD' and expires_at <= ${ts(nowMs)} order by expires_at limit ${limit}::int for update skip locked`,
      );
      for (const h of due) await freeSeats(tx, h, 'EXPIRED', nowMs);
      await decreaseQuota(tx, due);
      return due.length;
    }, 'busy');
    if (n === 'busy') throw new Error('홀드 만료가 잠금 경합으로 끊겼다(다음 간격에 다시 한다)');
    return n;
  }
}
