// 열지 않은 CS 건(차액 DEDUCTION_GAP·이상 표시 FLAGGED) 다시 열기(웨이브 끝 리뷰 C2·S1, 빈 뼈대).
// order_cancellation.deduction_gap_at·deduction_gap_request_id·deduction_gap_opened_at·entry_flag_opened_at(0025)을 쓴다.
import type { Database } from '@peaket/platform';
import type { CsCaseOutbox } from '../../domain/event-refund-ports.js';

export class DrizzleCsCaseOutbox implements CsCaseOutbox {
  constructor(private readonly database: Database) {}

  async pendingGaps(_limit: number): ReturnType<CsCaseOutbox['pendingGaps']> {
    void this.database;
    throw new Error('아직 없음');
  }

  async markGapOpened(_cancellationId: string, _nowMs: number): Promise<void> {
    throw new Error('아직 없음');
  }

  async pendingFlags(_limit: number): ReturnType<CsCaseOutbox['pendingFlags']> {
    throw new Error('아직 없음');
  }

  async markFlagOpened(_cancellationId: string, _nowMs: number): Promise<void> {
    throw new Error('아직 없음');
  }
}
