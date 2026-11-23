// 회차 정산의 결제 원장 어댑터. payment-svc가 소유한 payment 표만 읽는다(ADR-0101).
// 다른 바운디드 컨텍스트의 Drizzle 스키마를 직접 가져오지 않고, 공개 표 모양을 SQL로 읽는다.
// PEAKET 부담 취소(payment_cancel.settlement_burden = PEAKET, 0033)는 결제마다 합을 함께 읽어 정산 환급에서 뺀다(F-07-8 I-02, settlement §7).
import type { Database } from '@peaket/platform';
import type { SettlementPaymentSource } from '../../domain/ports.js';
import { partnerRefundOf, type PaymentFact, type Pg, type PgStore, type RefundFact } from '../../domain/settlement.js';

interface Row {
  payment_id: string;
  amount: number;
  cancelled_amount: number;
  status: string;
  failure_category: string | null;
  excluded_reason: string | null;
  approved_at: Date | null;
  peaket_borne: string | number | null;
  refunded_at: Date | null;
}

/** 결제마다 끝난 결제 취소의 PEAKET 부담 합과 마지막 끝난 시각 */
const CANCEL_FACTS = `select c.payment_id,
            coalesce(sum(c.amount) filter (where c.settlement_burden = 'PEAKET'), 0) as peaket_borne,
            max(c.canceled_at) as refunded_at
       from payment_cancel c
      where c.status = 'CANCELED' and c.canceled_at is not null`;

const factOf = (row: Row): PaymentFact => ({
  paymentId: row.payment_id,
  amount: Number(row.amount),
  cancelledAmount: Number(row.cancelled_amount),
  status: row.status,
  failureCategory: row.failure_category,
  excludedReason: row.excluded_reason,
  // 승인 시각이 없는 CANCELED는 승인된 적 없는 취소라 계산에서 뺀다(settlement §4.1, F-07-5 리뷰 RV-01)
  approvedAt: row.approved_at === null ? null : new Date(row.approved_at),
  peaketBorneRefund: Number(row.peaket_borne ?? 0),
  refundedAt: row.refunded_at === null ? null : new Date(row.refunded_at),
});

export class DrizzleSettlementPaymentSource implements SettlementPaymentSource {
  constructor(private readonly db: Database) {}

  async listEventPayments(eventId: string, pg: Pg, pgStore: PgStore): Promise<PaymentFact[]> {
    const r = await this.db.pool.query<Row>(
      `select p.id as payment_id, p.amount, p.cancelled_amount, p.status, p.failure_category, p.approved_at,
              case when exists (
                select 1 from reconciliation_diff d
                 where d.pg = p.pg and d.payment_ref = p.pg_payment_ref and d.state <> 'CLOSED'
              ) then 'RECONCILIATION_OPEN' else null end as excluded_reason,
              x.peaket_borne, x.refunded_at
         from payment p
         left join (${CANCEL_FACTS} and c.payment_id in (select id from payment where event_id = $1) group by c.payment_id) x on x.payment_id = p.id
        where p.event_id = $1 and p.pg = $2 and p.pg_store = $3
          and p.status in ('APPROVED', 'PARTIAL_CANCELED', 'CANCELED')
          and (p.failure_category is null or p.failure_category <> 'DEPOSIT_CANCELED')
        order by p.id`,
      [eventId, pg, pgStore],
    );
    return r.rows.map(factOf);
  }

  /**
   * 끝난 결제 취소가 있는 결제를 (마지막 취소 끝난 시각, 결제 ID) 열쇠 뒤부터 차례로(F-07-8 계산 뒤 환급 훑기, ADR-0380 결정 5).
   * 답의 환급은 계산과 같은 식(partnerRefundOf: 전액 취소는 원금, 그 밖은 취소 금액, PEAKET 부담을 뺌)이다
   */
  async listRefundsAfter(after: { at: Date; paymentId: string }, limit: number): Promise<RefundFact[]> {
    const r = await this.db.pool.query<Row & { event_id: string; pg: Pg; pg_store: PgStore }>(
      `select p.id as payment_id, p.event_id, p.pg, p.pg_store, p.amount, p.cancelled_amount, p.status, p.failure_category, p.approved_at,
              null as excluded_reason, x.peaket_borne, x.refunded_at
         from (${CANCEL_FACTS}
                 and c.payment_id in (select payment_id from payment_cancel where status = 'CANCELED' and canceled_at >= $1)
               group by c.payment_id) x
         join payment p on p.id = x.payment_id
        where p.event_id is not null
          and (x.refunded_at > $1 or (x.refunded_at = $1 and p.id::text > $2))
        order by x.refunded_at, p.id::text
        limit $3`,
      [after.at, after.paymentId, limit],
    );
    return r.rows.map((row) => {
      const fact = factOf(row);
      return { paymentId: row.payment_id, eventId: row.event_id, pg: row.pg, pgStore: row.pg_store, partnerRefund: partnerRefundOf(fact), refundedAt: fact.refundedAt! };
    });
  }
}
