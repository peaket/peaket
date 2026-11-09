// 티켓 무효 큐의 purchase DB 쪽(TicketVoidJobs, docs/data.md §2 ERD ticket_void_job, BUILD_ORDER HOT-152). drizzle-ticket-issue.ts와 같은 꼴이다:
// 잡기는 짧은 트랜잭션에서 FOR UPDATE SKIP LOCKED로 골라 임대를 쓰고 커밋한다(잠금 밖에서 ticket-svc를 부른다). 끝내기·다시 보내기·멈추기는 자기 임대 조건의 문장 하나다.
import type { Clock, Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { TicketVoidJob, TicketVoidJobs } from '../../domain/ports.js';
import { SAGA_STATEMENT_TIMEOUT_MS } from '../../domain/saga.js';
import type { TicketIssueFailureCode } from '../../domain/ticket-issue.js';

export interface DrizzleTicketVoidOptions {
  database: Database;
  clock: Clock;
}

const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;

type JobRow = { order_id: string; event_id: string; issue_generation: string | number; attempts: number | string; lease_until: Date | string };

const jobOf = (r: JobRow): TicketVoidJob => ({ orderId: r.order_id, eventId: r.event_id, issueGeneration: Number(r.issue_generation), attempts: Number(r.attempts), leaseUntilMs: new Date(r.lease_until).getTime() });

const RETURNING = sql.raw('j.order_id::text as order_id, j.event_id::text as event_id, j.issue_generation::text as issue_generation, j.attempts, j.lease_until');

export class DrizzleTicketVoid implements TicketVoidJobs {
  constructor(private readonly o: DrizzleTicketVoidOptions) {}

  async claimDue(limit: number, leaseMs: number): Promise<TicketVoidJob[]> {
    const now = this.o.clock.now();
    const at = new Date(now);
    const until = new Date(now + leaseMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from ticket_void_job
          where next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until < ${at}::timestamptz)
          order by next_attempt_at, order_id
          limit ${limit}::int
          for update skip locked)
        update ticket_void_job j set lease_until = ${until}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning ${RETURNING}`),
    );
    return (r.rows as JobRow[]).map(jobOf);
  }

  async claim(orderId: string, leaseMs: number): Promise<TicketVoidJob | undefined> {
    const now = this.o.clock.now();
    const at = new Date(now);
    const until = new Date(now + leaseMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from ticket_void_job
          where order_id = ${orderId}::uuid and next_attempt_at <= ${at}::timestamptz and (lease_until is null or lease_until < ${at}::timestamptz)
          for update skip locked)
        update ticket_void_job j set lease_until = ${until}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning ${RETURNING}`),
    );
    const row = r.rows[0] as JobRow | undefined;
    return row ? jobOf(row) : undefined;
  }

  async done(orderId: string, leaseUntilMs: number): Promise<boolean> {
    const r = await this.#tx((tx) => tx.execute(sql`delete from ticket_void_job where order_id = ${orderId}::uuid and lease_until = ${new Date(leaseUntilMs)}::timestamptz returning order_id`));
    return r.rows.length > 0;
  }

  async retry(i: { readonly orderId: string; readonly nextAtMs: number; readonly code: TicketIssueFailureCode; readonly leaseUntilMs: number }): Promise<boolean> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update ticket_void_job set attempts = attempts + 1, last_error = ${i.code}, next_attempt_at = ${new Date(i.nextAtMs)}::timestamptz, lease_until = null
        where order_id = ${i.orderId}::uuid and lease_until = ${new Date(i.leaseUntilMs)}::timestamptz
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async stop(i: { readonly orderId: string; readonly code: TicketIssueFailureCode; readonly leaseUntilMs: number }): Promise<boolean> {
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update ticket_void_job set attempts = attempts + 1, last_error = ${i.code}, next_attempt_at = null, lease_until = null
        where order_id = ${i.orderId}::uuid and lease_until = ${new Date(i.leaseUntilMs)}::timestamptz
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }
}
