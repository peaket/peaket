// 주문 저장소(docs/features/payment.md §13). 상태는 조건부 갱신으로만 바꾸고, 바꾸는 트랜잭션이 이력을 덧붙인다(빈틈 없는 번호).
// SQL은 Drizzle sql 템플릿의 매개변수로만 쓴다(asvs/v0-baseline.md 1.2.4). 목록 값은 JSON 매개변수 하나로 넘긴다.
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { STATEMENT_TIMEOUT_MS, type NewOrder, type OrderRecord, type OrderStatus } from '../../domain/booking.js';
import type { OrderStore, StartPaymentResult } from '../../domain/ports.js';

/** 잠금 경합으로 PostgreSQL이 끊은 오류: 교착 상태, 문장 시간 초과, 잠금 대기 실패 */
const BUSY_CODES = new Set(['40P01', '57014', '55P03']);

function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** 바꾸지 않고 끝낼 결과. 던져서 트랜잭션을 되돌린다 */
class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super('되돌림');
  }
}

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000)`;

interface OrderRow {
  order_id: string;
  event_id: string;
  account_id: string;
  hold_id: string;
  status: OrderStatus;
  amount: number;
  order_name: string;
  seat_ids: string[];
  created_ms: string | number;
}

const orderColumns = sql`order_id, event_id, account_id, hold_id, status, amount, order_name, seat_ids, extract(epoch from created_at) * 1000 as created_ms`;

const record = (r: OrderRow): OrderRecord => ({
  orderId: r.order_id,
  eventId: r.event_id,
  accountId: r.account_id,
  holdId: r.hold_id,
  status: r.status,
  amount: Number(r.amount),
  orderName: r.order_name,
  seatIds: r.seat_ids,
  createdAtMs: Math.round(Number(r.created_ms)),
});

async function rows<T>(tx: DbTransaction, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)).rows as T[];
}

/** 이력 한 줄. 주문 행을 잠그거나 바꾼 같은 트랜잭션에서만 부른다(번호가 겹치거나 비지 않게) */
async function appendEvent(tx: DbTransaction, orderId: string, to: OrderStatus, reason: string, nowMs: number): Promise<void> {
  await tx.execute(
    sql`insert into v0_order_event (order_id, seq, to_status, reason, occurred_at)
        select ${orderId}, coalesce(max(seq), 0) + 1, ${to}, ${reason}, ${ts(nowMs)} from v0_order_event where order_id = ${orderId}`,
  );
}

export class DrizzleOrderStore implements OrderStore {
  constructor(private readonly database: Database) {}

  private run<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(fn, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  }

  async prices(eventId: string, grades: string[]): Promise<Map<string, number>> {
    const list = JSON.stringify(grades);
    const r = await this.run((tx) =>
      rows<{ grade: string; price: number }>(
        tx,
        sql`select grade, price from v0_price where event_id = ${eventId} and grade in (select jsonb_array_elements_text(${list}::jsonb))`,
      ),
    );
    return new Map(r.map((x) => [x.grade, Number(x.price)]));
  }

  async create(o: NewOrder): Promise<'created' | 'order-already-exists'> {
    const seatIds = JSON.stringify(o.items.map((i) => i.seatId));
    try {
      return await this.run(async (tx) => {
        const inserted = await rows<{ order_id: string }>(
          tx,
          sql`insert into v0_order (order_id, event_id, account_id, hold_id, seat_ids, amount, order_name, status, created_at)
              values (${o.orderId}, ${o.eventId}, ${o.accountId}, ${o.holdId}, array(select jsonb_array_elements_text(${seatIds}::jsonb)), ${o.amount}, ${o.orderName}, 'CREATED', ${ts(o.nowMs)})
              on conflict (hold_id) do nothing returning order_id`,
        );
        if (inserted.length === 0) throw new Rollback<'order-already-exists'>('order-already-exists');
        for (const [i, item] of o.items.entries()) {
          await tx.execute(
            sql`insert into v0_order_item (order_id, line_no, seat_id, grade, price) values (${o.orderId}, ${i + 1}, ${item.seatId}, ${item.grade}, ${item.price})`,
          );
        }
        await appendEvent(tx, o.orderId, 'CREATED', 'order-created', o.nowMs);
        return 'created' as const;
      });
    } catch (err) {
      if (err instanceof Rollback) return err.result as 'order-already-exists';
      throw err;
    }
  }

  async find(orderId: string, accountId: string): Promise<OrderRecord | null> {
    const [r] = await this.run((tx) => rows<OrderRow>(tx, sql`select ${orderColumns} from v0_order where order_id = ${orderId} and account_id = ${accountId}`));
    return r ? record(r) : null;
  }

  async startPayment(orderId: string, accountId: string, amount: number, nowMs: number): Promise<StartPaymentResult> {
    try {
      return await this.run<StartPaymentResult>(async (tx) => {
        const [r] = await rows<OrderRow>(tx, sql`select ${orderColumns} from v0_order where order_id = ${orderId} for update`);
        if (!r || r.account_id !== accountId) return { kind: 'order-not-found' };
        if (r.status !== 'CREATED') return { kind: 'order-not-payable' };
        if (Number(r.amount) !== amount) return { kind: 'amount-mismatch' };
        await tx.execute(sql`update v0_order set status = 'PAYING' where order_id = ${orderId}`);
        await appendEvent(tx, orderId, 'PAYING', 'payment-requested', nowMs);
        return { kind: 'paying', order: { ...record(r), status: 'PAYING' } };
      });
    } catch (err) {
      const code = pgCode(err);
      if (code && BUSY_CODES.has(code)) return { kind: 'busy' };
      throw err;
    }
  }

  async transition(orderId: string, from: OrderStatus, to: OrderStatus, reason: string, nowMs: number): Promise<boolean> {
    return this.run(async (tx) => {
      const changed = await rows(tx, sql`update v0_order set status = ${to} where order_id = ${orderId} and status = ${from} returning order_id`);
      if (changed.length === 0) return false;
      await appendEvent(tx, orderId, to, reason, nowMs);
      return true;
    });
  }

  async confirm(orderId: string, tickets: { seatId: string; ticketId: string }[], nowMs: number): Promise<boolean> {
    return this.run(async (tx) => {
      const changed = await rows(tx, sql`update v0_order set status = 'CONFIRMED' where order_id = ${orderId} and status = 'APPROVED' returning order_id`);
      if (changed.length === 0) return false;
      for (const t of tickets) {
        await tx.execute(sql`update v0_order_item set ticket_id = ${t.ticketId} where order_id = ${orderId} and seat_id = ${t.seatId}`);
      }
      await appendEvent(tx, orderId, 'CONFIRMED', 'tickets-issued', nowMs);
      return true;
    });
  }

  async setPrices(eventId: string, prices: Map<string, number>): Promise<void> {
    await this.run(async (tx) => {
      for (const [grade, price] of prices) {
        await tx.execute(
          sql`insert into v0_price (event_id, grade, price) values (${eventId}, ${grade}, ${price}) on conflict (event_id, grade) do update set price = excluded.price`,
        );
      }
    });
  }
}
