// 회차 취소 일괄 환불의 결제사 호출 기록(BAT-425 GAT-130). 자동 정지의 1분 창·연속 실패·실패 금액을 센다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { EventRefundAttempt, EventRefundWindowStats, RefundPgProvider } from '../../domain/event-refund.js';
import type { EventRefundAttemptStore } from '../../domain/event-refund-ports.js';

interface StatsRow {
  calls: string | number;
  failures: string | number;
  rejects: string | number;
  failed_amount: string | number;
}

const statsOf = (row: StatsRow): EventRefundWindowStats => ({
  calls: Number(row.calls),
  failures: Number(row.failures),
  rejects: Number(row.rejects),
  failedAmount: Number(row.failed_amount),
});

@Injectable()
export class DrizzleEventRefundAttempts implements EventRefundAttemptStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async record(a: EventRefundAttempt): Promise<void> {
    await this.database.db.execute(sql`
      insert into event_refund_attempt (request_id, ticket_id, pg, amount, outcome, attempted_at)
      values (${a.requestId}::uuid, ${a.ticketId}::uuid, ${a.pg}, ${a.amount}, ${a.outcome}, ${new Date(a.atMs)}::timestamptz)`);
  }

  async window(pg: RefundPgProvider, sinceMs: number): Promise<EventRefundWindowStats> {
    const r = await this.database.db.execute(sql`
      select count(*) as calls,
             count(*) filter (where outcome in ('FAILURE', 'UNKNOWN')) as failures,
             count(*) filter (where outcome = 'REJECT') as rejects,
             coalesce(sum(amount) filter (where outcome in ('FAILURE', 'UNKNOWN')), 0) as failed_amount
        from event_refund_attempt
       where pg = ${pg} and attempted_at >= ${new Date(sinceMs)}::timestamptz`);
    return statsOf(r.rows[0] as unknown as StatsRow);
  }

  async windowAll(sinceMs: number): Promise<EventRefundWindowStats> {
    const r = await this.database.db.execute(sql`
      select count(*) as calls,
             count(*) filter (where outcome in ('FAILURE', 'UNKNOWN')) as failures,
             count(*) filter (where outcome = 'REJECT') as rejects,
             coalesce(sum(amount) filter (where outcome in ('FAILURE', 'UNKNOWN')), 0) as failed_amount
        from event_refund_attempt
       where attempted_at >= ${new Date(sinceMs)}::timestamptz`);
    return statsOf(r.rows[0] as unknown as StatsRow);
  }

  async consecutiveFailures(pg: RefundPgProvider): Promise<number> {
    // 그 결제사의 마지막 성공 뒤에 쌓인 실패·결과 모름 수. 성공이 없으면 전체를 센다.
    // 같은 밀리초에 들어온 실패도 세도록 마지막 성공 시각과 같은 시각(>=)을 포함한다(과소 계산보다 보수적).
    const r = await this.database.db.execute(sql`
      with last_success as (
        select coalesce(max(attempted_at), '-infinity'::timestamptz) as at
          from event_refund_attempt
         where pg = ${pg} and outcome = 'SUCCESS'
      )
      select count(*) as n
        from event_refund_attempt a, last_success s
       where a.pg = ${pg}
         and a.attempted_at >= s.at
         and a.outcome in ('FAILURE', 'UNKNOWN', 'REJECT')`);
    return Number((r.rows[0] as { n: string | number } | undefined)?.n ?? 0);
  }
}
