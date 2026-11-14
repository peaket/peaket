// 회차 정산의 결제 원장 어댑터. payment-svc가 소유한 payment 표만 읽는다(ADR-0101).
// 다른 바운디드 컨텍스트의 Drizzle 스키마를 직접 가져오지 않고, 공개 표 모양을 SQL로 읽는다.
import type { Database } from '@peaket/platform';
import type { SettlementPaymentSource } from '../../domain/ports.js';
import type { PaymentFact, Pg } from '../../domain/settlement.js';

interface Row {
  payment_id: string;
  amount: number;
  cancelled_amount: number;
  status: string;
  failure_category: string | null;
}

export class DrizzleSettlementPaymentSource implements SettlementPaymentSource {
  constructor(private readonly db: Database) {}

  async listEventPayments(eventId: string, pg: Pg): Promise<PaymentFact[]> {
    const r = await this.db.pool.query<Row>(
      `select id as payment_id, amount, cancelled_amount, status, failure_category
         from payment
        where event_id = $1 and pg = $2
          and status in ('APPROVED', 'PARTIAL_CANCELED', 'CANCELED')
          and (failure_category is null or failure_category <> 'DEPOSIT_CANCELED')
        order by id`,
      [eventId, pg],
    );
    return r.rows.map((row) => ({
      paymentId: row.payment_id,
      amount: row.amount,
      cancelledAmount: row.cancelled_amount,
      status: row.status,
      failureCategory: row.failure_category,
    }));
  }
}
