// 회차 정산의 결제 원장 어댑터. payment-svc가 소유한 payment 표만 읽는다(ADR-0101).
// 다른 바운디드 컨텍스트의 Drizzle 스키마를 직접 가져오지 않고, 공개 표 모양을 SQL로 읽는다.
import type { Database } from '@peaket/platform';
import type { SettlementPaymentSource } from '../../domain/ports.js';
import type { PaymentFact, Pg, PgStore } from '../../domain/settlement.js';

interface Row {
  payment_id: string;
  amount: number;
  cancelled_amount: number;
  status: string;
  failure_category: string | null;
  excluded_reason: string | null;
}

export class DrizzleSettlementPaymentSource implements SettlementPaymentSource {
  constructor(private readonly db: Database) {}

  async listEventPayments(eventId: string, pg: Pg, pgStore: PgStore): Promise<PaymentFact[]> {
    const r = await this.db.pool.query<Row>(
      `select p.id as payment_id, p.amount, p.cancelled_amount, p.status, p.failure_category,
              case when exists (
                select 1 from reconciliation_diff d
                 where d.pg = p.pg and d.payment_ref = p.pg_payment_ref and d.state <> 'CLOSED'
              ) then 'RECONCILIATION_OPEN' else null end as excluded_reason
         from payment p
        where p.event_id = $1 and p.pg = $2 and p.pg_store = $3
          and p.status in ('APPROVED', 'PARTIAL_CANCELED', 'CANCELED')
          and (p.failure_category is null or p.failure_category <> 'DEPOSIT_CANCELED')
        order by p.id`,
      [eventId, pg, pgStore],
    );
    return r.rows.map((row) => ({
      paymentId: row.payment_id,
      amount: row.amount,
      cancelledAmount: row.cancelled_amount,
      status: row.status,
      failureCategory: row.failure_category,
      excludedReason: row.excluded_reason,
    }));
  }
}
