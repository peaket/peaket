// 발권·검표 저장소(docs/features/offline-gate.md §13). SQL은 Drizzle sql 템플릿의 매개변수로만 쓴다(asvs/v0-baseline.md 1.2.4).
// 입장은 entered_at이 비어 있을 때만 채우는 조건부 갱신이라, 같은 티켓을 두 스캐너가 함께 찍어도 통과는 하나다(ASVS v5.0.0-2.3.4).
import { randomUUID } from 'node:crypto';
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { ScanOutcome, TicketStore } from '../../domain/ports.js';
import type { IssueRequest, IssuedTicket } from '../../domain/ticket.js';

/** 판정마다 문장 시간 상한(좌석 v0와 같다) */
const STATEMENT_TIMEOUT_MS = 1_000;
/** 잠금 경합으로 PostgreSQL이 끊은 오류 */
const BUSY_CODES = new Set(['40P01', '57014', '55P03']);
const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000)`;

function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function rows<T>(tx: DbTransaction, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)).rows as T[];
}

export class DrizzleTicketStore implements TicketStore {
  constructor(private readonly database: Database) {}

  private run<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(fn, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  }

  async issue(r: IssueRequest, codes: () => string): Promise<IssuedTicket[]> {
    const got = await this.run(async (tx) => {
      for (const seatId of r.seatIds) {
        await tx.execute(
          sql`insert into v0_ticket (ticket_id, order_id, event_id, seat_id, account_id, code, status, issued_at)
              values (${randomUUID()}, ${r.orderId}, ${r.eventId}, ${seatId}, ${r.accountId}, ${codes()}, 'ISSUED', ${ts(r.nowMs)})
              on conflict (order_id, seat_id) do nothing`,
        );
      }
      return rows<{ ticket_id: string; seat_id: string; code: string }>(tx, sql`select ticket_id, seat_id, code from v0_ticket where order_id = ${r.orderId}`);
    });
    const bySeat = new Map(got.map((t) => [t.seat_id, t]));
    return r.seatIds.map((seatId) => {
      const t = bySeat.get(seatId);
      if (!t) throw new Error(`주문 ${r.orderId}의 좌석 ${seatId} 티켓이 없다`);
      return { ticketId: t.ticket_id, seatId, code: t.code };
    });
  }

  async ticketsOf(orderId: string): Promise<IssuedTicket[]> {
    const got = await this.run((tx) =>
      rows<{ ticket_id: string; seat_id: string; code: string }>(tx, sql`select ticket_id, seat_id, code from v0_ticket where order_id = ${orderId} order by seat_id`),
    );
    return got.map((t) => ({ ticketId: t.ticket_id, seatId: t.seat_id, code: t.code }));
  }

  async scan(eventId: string, staffAccountId: string, code: string, nowMs: number): Promise<ScanOutcome> {
    try {
      return await this.run<ScanOutcome>(async (tx) => {
        // 역할은 토큰에 없다. 요청마다 그 회차의 검표 스태프인지 DB로 본다(FND-010)
        const staff = await rows(tx, sql`select 1 from v0_gate_staff where event_id = ${eventId} and account_id = ${staffAccountId}`);
        if (staff.length === 0) return { kind: 'not-assigned' };
        const [t] = await rows<{ ticket_id: string; event_id: string; seat_id: string }>(tx, sql`select ticket_id, event_id, seat_id from v0_ticket where code = ${code}`);
        if (!t) return { kind: 'invalid' };
        if (t.event_id !== eventId) return { kind: 'wrong-event' };
        const entered = await rows(
          tx,
          sql`update v0_ticket set entered_at = ${ts(nowMs)}, entered_by = ${staffAccountId} where ticket_id = ${t.ticket_id} and entered_at is null returning ticket_id`,
        );
        if (entered.length > 0) return { kind: 'admitted', ticketId: t.ticket_id, seatId: t.seat_id, enteredAtMs: nowMs };
        const [prev] = await rows<{ ms: string | number }>(tx, sql`select extract(epoch from entered_at) * 1000 as ms from v0_ticket where ticket_id = ${t.ticket_id}`);
        return { kind: 'already-entered', ticketId: t.ticket_id, seatId: t.seat_id, enteredAtMs: Math.round(Number(prev!.ms)) };
      });
    } catch (err) {
      const c = pgCode(err);
      if (c && BUSY_CODES.has(c)) return { kind: 'busy' };
      throw err;
    }
  }

  async assignStaff(eventId: string, accountIds: string[]): Promise<void> {
    await this.run(async (tx) => {
      for (const accountId of accountIds) {
        await tx.execute(sql`insert into v0_gate_staff (event_id, account_id) values (${eventId}, ${accountId}) on conflict do nothing`);
      }
    });
  }
}
