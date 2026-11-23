// 결제사 잔액 대사의 장부 원천(F-07-6 LCH-110, settlement §5.5, ADR-0369 결정 11). payment-svc가 소유한 payment·payout·payout_batch 표만 읽는다.
// - 승인·취소: 회차 정산 원천(DrizzleSettlementPaymentSource)과 같은 규칙이다. 승인 시각이 있고(승인된 적 없는 취소는 뺀다) 그 시각이 대사 시각 이하이며,
//   입금 오류 되돌림(DEPOSIT_CANCELED)을 빼고, 결제사·상점이 같은 APPROVED·PARTIAL_CANCELED·CANCELED 결제. 취소(CANCELED)는 원금 전액이 환불이다.
// - 지급: 그 결제사·상점 묶음의 COMPLETED 지급 건 합과 지급일 달별 건 수(대사 시각의 KST 날짜까지).
import type { Database } from '@peaket/platform';
import type { PgLedgerSource } from '../../domain/ports.js';
import type { Pg, PgStore } from '../../domain/settlement.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export class DrizzlePgLedgerSource implements PgLedgerSource {
  constructor(private readonly db: Database) {}

  async ledger(input: { pg: Pg; pgStore: PgStore; cutoffAt: Date }): Promise<{ approvedAmount: number; refundedAmount: number; paidOutAmount: number; payoutCountByMonth: Record<string, number>; firstPaymentAt: Date | null }> {
    const payments = await this.db.pool.query<{ approved: string | null; refunded: string | null; first_at: Date | null }>(
      `select coalesce(sum(p.amount), 0) as approved,
              coalesce(sum(case when p.status = 'CANCELED' then p.amount else least(greatest(p.cancelled_amount, 0), p.amount) end), 0) as refunded,
              min(p.approved_at) as first_at
         from payment p
        where p.pg = $1 and p.pg_store = $2
          and p.status in ('APPROVED', 'PARTIAL_CANCELED', 'CANCELED')
          and p.approved_at is not null and p.approved_at <= $3
          and (p.failure_category is null or p.failure_category <> 'DEPOSIT_CANCELED')`,
      [input.pg, input.pgStore, input.cutoffAt],
    );
    const cutoffDate = new Date(input.cutoffAt.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
    const payouts = await this.db.pool.query<{ month: string; amount: string; n: string }>(
      `select to_char(o.payout_date, 'YYYY-MM') as month, coalesce(sum(o.amount), 0) as amount, count(*) as n
         from payout o
         join payout_batch b on b.id = o.batch_id
        where b.pg = $1 and b.pg_store = $2 and o.status = 'COMPLETED' and o.payout_date <= $3::date
        group by 1
        order by 1`,
      [input.pg, input.pgStore, cutoffDate],
    );
    const row = payments.rows[0];
    const payoutCountByMonth: Record<string, number> = {};
    let paidOutAmount = 0;
    for (const r of payouts.rows) {
      payoutCountByMonth[r.month] = Number(r.n);
      paidOutAmount += Number(r.amount);
    }
    return {
      approvedAmount: Number(row?.approved ?? 0),
      refundedAmount: Number(row?.refunded ?? 0),
      paidOutAmount,
      payoutCountByMonth,
      firstPaymentAt: row?.first_at ? new Date(row.first_at) : null,
    };
  }
}
