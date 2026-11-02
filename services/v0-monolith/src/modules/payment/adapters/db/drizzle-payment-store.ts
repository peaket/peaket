// 결제 행 저장(docs/features/payment.md §13 동작 2 ③). 주문 하나에 결제 행 하나(order_id 유일).
// SQL은 Drizzle sql 템플릿의 매개변수로만 쓴다(asvs/v0-baseline.md 1.2.4).
import { randomUUID } from 'node:crypto';
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PaymentInsert, PaymentStore } from '../../domain/ports.js';

/** 판정마다 문장 시간 상한(좌석 v0와 같다) */
const STATEMENT_TIMEOUT_MS = 1_000;
const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000)`;

export class DrizzlePaymentStore implements PaymentStore {
  constructor(private readonly database: Database) {}

  /** CONFIRMING 행을 넣는다. 그 주문의 행이 이미 있으면 already-exists */
  async insertConfirming(r: { orderId: string; eventId: string; pg: string; paymentKey: string; amount: number; nowMs: number }): Promise<PaymentInsert> {
    const paymentId = randomUUID();
    const res = await this.database.transaction(
      (tx) =>
        tx.execute(
          sql`insert into v0_payment (payment_id, order_id, event_id, pg, payment_key, amount, status, created_at)
              values (${paymentId}, ${r.orderId}, ${r.eventId}, ${r.pg}, ${r.paymentKey}, ${r.amount}, 'CONFIRMING', ${ts(r.nowMs)})
              on conflict (order_id) do nothing returning payment_id`,
        ),
      { statementTimeoutMs: STATEMENT_TIMEOUT_MS },
    );
    return res.rows.length === 0 ? { kind: 'already-exists' } : { kind: 'inserted', paymentId };
  }

  async markApproved(paymentId: string, approvedAtMs: number): Promise<void> {
    await this.database.transaction(
      (tx) => tx.execute(sql`update v0_payment set status = 'APPROVED', approved_at = ${ts(approvedAtMs)} where payment_id = ${paymentId} and status = 'CONFIRMING'`),
      { statementTimeoutMs: STATEMENT_TIMEOUT_MS },
    );
  }

  async markFailed(paymentId: string, failure: string): Promise<void> {
    await this.database.transaction(
      (tx) => tx.execute(sql`update v0_payment set status = 'FAILED', failure = ${failure} where payment_id = ${paymentId} and status = 'CONFIRMING'`),
      { statementTimeoutMs: STATEMENT_TIMEOUT_MS },
    );
  }
}
