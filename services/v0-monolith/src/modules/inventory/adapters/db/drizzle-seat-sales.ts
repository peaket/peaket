// 좌석 판매의 PostgreSQL 어댑터(docs/features/seat-hold.md §14 동작 9). booking 모듈이 공개 함수로 부른다.
// 잠그는 차례는 홀드·해제·만료와 같다: 홀드 행 → 좌석 행 → 보유 수 행(서로 엇갈려 기다리지 않게).
// 변경분은 같은 트랜잭션의 pg_notify로 내므로 커밋될 때만 나간다.
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { STATEMENT_TIMEOUT_MS } from '../../domain/inventory.js';
import type { SaleHoldResult, SaleSeat, SeatSales, SellResult, UnsellResult } from '../../domain/sales.js';
import { BUSY_CODES, Rollback, msOf, notify, pgCode, rows } from './drizzle-seat-store.js';

interface HoldRow {
  hold_id: string;
  event_id: string;
  account_id: string;
  seat_ids: string[];
  status: string;
  expires_ms: string | number;
}

const holdColumns = sql`hold_id, event_id, account_id, seat_ids, status, extract(epoch from expires_at) * 1000 as expires_ms`;

export class DrizzleSeatSales implements SeatSales {
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

  /** 읽기만 한다(잠그지 않는다). 문장 시간 초과 같은 오류는 그대로 던진다 */
  async holdForOrder(holdId: string, accountId: string, nowMs: number): Promise<SaleHoldResult> {
    return this.database.transaction<SaleHoldResult>(async (tx) => {
      const [h] = await rows<HoldRow>(tx, sql`select ${holdColumns} from v0_hold where hold_id = ${holdId}`);
      if (!h || h.account_id !== accountId) return { kind: 'hold-not-found' };
      if (h.status !== 'HELD' || msOf(h.expires_ms) <= nowMs) return { kind: 'hold-expired' };
      const ids = JSON.stringify(h.seat_ids);
      const graded = await rows<{ seat_id: string; grade: string }>(
        tx,
        sql`select seat_id, grade from v0_seat where event_id = ${h.event_id} and seat_id in (select jsonb_array_elements_text(${ids}::jsonb))`,
      );
      const gradeOf = new Map(graded.map((r) => [r.seat_id, r.grade]));
      const seats: SaleSeat[] = h.seat_ids.map((seatId) => {
        const grade = gradeOf.get(seatId);
        if (grade === undefined) throw new Error(`홀드 ${holdId}의 좌석 ${seatId}이 좌석 표에 없다`);
        return { seatId, grade };
      });
      return { kind: 'ok', hold: { holdId: h.hold_id, eventId: h.event_id, accountId: h.account_id, seats, expiresAtMs: msOf(h.expires_ms) } };
    }, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  }

  async sell(holdId: string, accountId: string, orderId: string, nowMs: number): Promise<SellResult> {
    return this.tx<SellResult>(async (tx) => {
      const [h] = await rows<HoldRow>(tx, sql`select ${holdColumns} from v0_hold where hold_id = ${holdId} for update`);
      if (!h || h.account_id !== accountId) throw new Rollback<SellResult>({ kind: 'hold-not-found' });
      if (h.status !== 'HELD' || msOf(h.expires_ms) <= nowMs) throw new Rollback<SellResult>({ kind: 'hold-expired' });
      const ids = JSON.stringify(h.seat_ids);
      const sold = await rows<{ seat_id: string }>(
        tx,
        sql`update v0_seat set status = 'SOLD', hold_id = null, order_id = ${orderId}
            where event_id = ${h.event_id} and seat_id in (select jsonb_array_elements_text(${ids}::jsonb)) and hold_id = ${holdId} and status = 'HELD'
            returning seat_id`,
      );
      // 살아 있는 홀드의 좌석은 늘 그 홀드의 HELD다. 아니면 표가 깨진 것이라 바꾸지 않는다
      if (sold.length !== h.seat_ids.length) throw new Error(`홀드 ${holdId}의 좌석 ${h.seat_ids.length}개 중 ${sold.length}개만 HELD였다`);
      await tx.execute(sql`update v0_hold set status = 'SOLD' where hold_id = ${holdId}`);
      const n = h.seat_ids.length;
      await tx.execute(
        sql`update v0_quota set held = greatest(held - ${n}::int, 0), sold = sold + ${n}::int where event_id = ${h.event_id} and account_id = ${h.account_id}`,
      );
      await notify(tx, h.event_id, h.seat_ids, 'SOLD', nowMs);
      return { kind: 'sold', eventId: h.event_id, seatIds: [...h.seat_ids] };
    }, { kind: 'busy' });
  }

  async unsell(holdId: string, orderId: string, nowMs: number): Promise<UnsellResult> {
    return this.tx<UnsellResult>(async (tx) => {
      const [h] = await rows<HoldRow>(tx, sql`select ${holdColumns} from v0_hold where hold_id = ${holdId} for update`);
      if (!h || h.status !== 'SOLD') throw new Rollback<UnsellResult>({ kind: 'not-sold' });
      const ids = JSON.stringify(h.seat_ids);
      const freed = await rows<{ seat_id: string }>(
        tx,
        sql`update v0_seat set status = 'AVAILABLE', order_id = null
            where event_id = ${h.event_id} and seat_id in (select jsonb_array_elements_text(${ids}::jsonb)) and order_id = ${orderId} and status = 'SOLD'
            returning seat_id`,
      );
      if (freed.length === 0) throw new Rollback<UnsellResult>({ kind: 'not-sold' });
      await tx.execute(sql`update v0_hold set status = 'RELEASED' where hold_id = ${holdId}`);
      await tx.execute(
        sql`update v0_quota set sold = greatest(sold - ${freed.length}::int, 0) where event_id = ${h.event_id} and account_id = ${h.account_id}`,
      );
      // 변경분은 홀드에 적힌 좌석 순서로 낸다
      const freedSet = new Set(freed.map((r) => r.seat_id));
      const seatIds = h.seat_ids.filter((s) => freedSet.has(s));
      await notify(tx, h.event_id, seatIds, 'AVAILABLE', nowMs);
      return { kind: 'returned', seatIds };
    }, { kind: 'busy' });
  }
}
