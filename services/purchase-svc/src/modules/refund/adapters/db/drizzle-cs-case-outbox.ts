// 열지 않은 CS 건(차액 DEDUCTION_GAP·이상 표시 FLAGGED) 다시 열기(웨이브 끝 리뷰 C2·S1, transfer-refund §3.1 ②·§5 '그래도 남는 건',
// guidelines §8.1 'ops-svc CS 처리함 내부 HTTP'). order_cancellation.deduction_gap_at·deduction_gap_request_id·deduction_gap_opened_at·entry_flag_opened_at(0025)을 쓴다.
// 목록은 부분 색인(order_cancellation_deduction_gap_open_idx·order_cancellation_entry_flag_open_idx)이 받친다. 연 시각은 ops-svc가 2xx로 받은 뒤에만 쓴다(부른 쪽).
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

  // ---- 다시 보기 2 N2 빈 뼈대(시험 담당, 구현 전에 씀): 0026이 받칠 칸을 쓰는 질의는 구현 담당이 채운다 ----
  async pendingItemFailures(_limit: number): ReturnType<CsCaseOutbox['pendingItemFailures']> {
    throw new Error('아직 없음');
  }

  async markItemFailureOpened(_requestId: string, _ticketId: string, _nowMs: number): Promise<void> {
    throw new Error('아직 없음');
  }

  async pendingRefundFailures(_limit: number): ReturnType<CsCaseOutbox['pendingRefundFailures']> {
    throw new Error('아직 없음');
  }

  async markRefundFailureOpened(_cancellationId: string, _nowMs: number): Promise<void> {
    throw new Error('아직 없음');
  }
}
