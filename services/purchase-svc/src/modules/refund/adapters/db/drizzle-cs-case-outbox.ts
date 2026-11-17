// 열지 않은 CS 건(차액 DEDUCTION_GAP·이상 표시 FLAGGED·환급 실패·일괄 환불 실패) 다시 열기(웨이브 끝 리뷰 C2·S1, 다시 보기 2 N2, transfer-refund §3.1 ②·⑥·§5 '그래도 남는 건',
// guidelines §8.1 'ops-svc CS 처리함 내부 HTTP'). order_cancellation.deduction_gap_at·deduction_gap_request_id·deduction_gap_opened_at·entry_flag_opened_at(0025),
// order_cancellation.refund_failed_opened_at·event_refund_item.failure_case_at·failure_case_opened_at(0026)을 쓴다.
// 목록은 부분 색인(order_cancellation_deduction_gap_open_idx·order_cancellation_entry_flag_open_idx·order_cancellation_refund_failed_open_idx·
// event_refund_item_failure_case_open_idx)이 받친다. 연 시각은 ops-svc가 2xx로 받은 뒤에만 쓴다(부른 쪽).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CsCaseOutbox } from '../../domain/event-refund-ports.js';

export class DrizzleCsCaseOutbox implements CsCaseOutbox {
  constructor(private readonly database: Database) {}

  /** 차액 대상으로 표시했는데 아직 열지 않은 행(표시 시각·취소 ID 순) */
  async pendingGaps(limit: number): ReturnType<CsCaseOutbox['pendingGaps']> {
    const r = await this.database.db.execute(sql`
      select id, order_id, deduction_amount, deduction_gap_request_id
        from order_cancellation
       where deduction_gap_at is not null and deduction_gap_opened_at is null
       order by deduction_gap_at, id
       limit ${limit}`);
    return (r.rows as { id: string; order_id: string; deduction_amount: number | string; deduction_gap_request_id: string }[]).map((x) => ({
      cancellationId: x.id,
      orderId: x.order_id,
      deductionAmount: Number(x.deduction_amount),
      requestId: x.deduction_gap_request_id,
    }));
  }

  async markGapOpened(cancellationId: string, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`
      update order_cancellation set deduction_gap_opened_at = ${new Date(nowMs)}::timestamptz
       where id = ${cancellationId}::uuid and deduction_gap_at is not null and deduction_gap_opened_at is null`);
  }

  /**
   * 입장 기록이 나왔는데 이상 표시 건을 아직 열지 않은 행(입장 시각·취소 ID 순). CS가 이미 끝낸 행(REQUESTED가 아님: 무효·환급으로 정함)은 다시 열지 않는다
   */
  async pendingFlags(limit: number): ReturnType<CsCaseOutbox['pendingFlags']> {
    const r = await this.database.db.execute(sql`
      select id, order_id, ticket_id, entry_recorded_at
        from order_cancellation
       where entry_recorded_at is not null and entry_flag_opened_at is null and status = 'REQUESTED'
       order by entry_recorded_at, id
       limit ${limit}`);
    return (r.rows as { id: string; order_id: string; ticket_id: string; entry_recorded_at: Date | string }[]).map((x) => ({
      cancellationId: x.id,
      orderId: x.order_id,
      ticketId: x.ticket_id,
      enteredAtMs: new Date(x.entry_recorded_at).getTime(),
    }));
  }

  async markFlagOpened(cancellationId: string, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`
      update order_cancellation set entry_flag_opened_at = ${new Date(nowMs)}::timestamptz
       where id = ${cancellationId}::uuid and entry_recorded_at is not null and entry_flag_opened_at is null`);
  }

  /**
   * 일괄 환불 실패 건을 열 대상으로 표시했는데 아직 열지 않은 항목(표시 시각·요청·표 순). 그 취소 행이 환급·무효로 끝났으면 다시 열지 않는다(행이 없는 항목은 넣는다:
   * 대상 없음·전환에서 진 항목·팬 취소와 겹친 항목도 건 하나 = 항목 하나다, 다시 보기 2 N2)
   */
  async pendingItemFailures(limit: number): ReturnType<CsCaseOutbox['pendingItemFailures']> {
    const r = await this.database.db.execute(sql`
      select i.request_id, i.order_id, i.ticket_id, i.cancellation_id, i.attempts, i.last_error
        from event_refund_item i
        left join order_cancellation c on c.id = i.cancellation_id
       where i.failure_case_at is not null and i.failure_case_opened_at is null
         and (c.id is null or c.status not in ('REFUNDED', 'VOIDED'))
       order by i.failure_case_at, i.request_id, i.ticket_id
       limit ${limit}`);
    return (r.rows as { request_id: string; order_id: string; ticket_id: string; cancellation_id: string; attempts: number | string; last_error: string | null }[]).map((x) => ({
      requestId: x.request_id,
      orderId: x.order_id,
      ticketId: x.ticket_id,
      cancellationId: x.cancellation_id,
      attempts: Number(x.attempts),
      lastError: x.last_error ?? 'failed',
    }));
  }

  async markItemFailureOpened(requestId: string, ticketId: string, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`
      update event_refund_item set failure_case_opened_at = ${new Date(nowMs)}::timestamptz
       where request_id = ${requestId}::uuid and ticket_id = ${ticketId}::uuid
         and failure_case_at is not null and failure_case_opened_at is null`);
  }

  /**
   * 환급 실패로 표시했는데 아직 열지 않은 행(표시 시각·취소 ID 순). 회차 취소 요청 ID가 달린 행은 그 항목의 일괄 환불 실패 건이 맡으므로 넣지 않고,
   * CS가 이미 끝낸 행(REFUND_PENDING이 아님: 무효·환급으로 정함)도 다시 열지 않는다. 예매 취소 Saga가 결제사 거절로 표시한 팬·부정 예매 행도 여기서 연다
   */
  async pendingRefundFailures(limit: number): ReturnType<CsCaseOutbox['pendingRefundFailures']> {
    const r = await this.database.db.execute(sql`
      select id, order_id, refund_attempts, refund_last_error
        from order_cancellation
       where refund_failed_at is not null and refund_failed_opened_at is null
         and event_cancellation_request_id is null and status = 'REFUND_PENDING'
       order by refund_failed_at, id
       limit ${limit}`);
    return (r.rows as { id: string; order_id: string; refund_attempts: number | string; refund_last_error: string | null }[]).map((x) => ({
      cancellationId: x.id,
      orderId: x.order_id,
      attempts: Number(x.refund_attempts),
      lastError: x.refund_last_error ?? 'failed',
    }));
  }

  async markRefundFailureOpened(cancellationId: string, nowMs: number): Promise<void> {
    await this.database.db.execute(sql`
      update order_cancellation set refund_failed_opened_at = ${new Date(nowMs)}::timestamptz
       where id = ${cancellationId}::uuid and refund_failed_at is not null and refund_failed_opened_at is null`);
  }
}
