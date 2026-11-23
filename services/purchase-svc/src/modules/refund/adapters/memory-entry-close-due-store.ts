// 시험·로컬용 환급 잇기 저장소(운영은 DrizzleCancellationWrites의 waitingEvents·pullDue).
// 같은 계약(entry-close-due-store-contract)을 실제 PostgreSQL 어댑터와 함께 돌린다.
import type { EntryCloseDueStore } from '../domain/entry-close-due.js';

export interface MemoryDueRow {
  cancellationId: string;
  eventId: string;
  status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
  refundDueAtMs: number | null;
  entryRecordedAtMs: number | null;
  eventCancellationRequestId: string | null;
  createdAtMs: number;
}

/** 그 회차가 기다리는 행인가: REQUESTED ∧ 입장 기록 없음 ∧ 회차 취소 아님 ∧ refund_due_at 있음 */
const waiting = (r: MemoryDueRow): boolean => r.status === 'REQUESTED' && r.entryRecordedAtMs === null && r.eventCancellationRequestId === null && r.refundDueAtMs !== null;

export class MemoryEntryCloseDueStore implements EntryCloseDueStore {
  readonly rows = new Map<string, MemoryDueRow>();

  put(row: MemoryDueRow): void {
    this.rows.set(row.cancellationId, { ...row });
  }

  get(cancellationId: string): MemoryDueRow | undefined {
    const r = this.rows.get(cancellationId);
    return r ? { ...r } : undefined;
  }

  async waitingEvents(nowMs: number, limit: number, after?: { dueAtMs: number; eventId: string }): Promise<{ eventId: string; dueAtMs: number }[]> {
    const due = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (!waiting(r)) continue;
      const at = r.refundDueAtMs!;
      if (at <= nowMs) continue;
      const current = due.get(r.eventId);
      if (current === undefined || at < current) due.set(r.eventId, at);
    }
    return [...due.entries()]
      .map(([eventId, dueAtMs]) => ({ eventId, dueAtMs }))
      .filter((w) => after === undefined || w.dueAtMs > after.dueAtMs || (w.dueAtMs === after.dueAtMs && w.eventId > after.eventId))
      .sort((a, b) => a.dueAtMs - b.dueAtMs || a.eventId.localeCompare(b.eventId))
      .slice(0, limit);
  }

  async pullDue(eventId: string, closedAtMs: number): Promise<number> {
    let changed = 0;
    for (const r of this.rows.values()) {
      if (r.eventId !== eventId || !waiting(r)) continue;
      if (r.refundDueAtMs! <= closedAtMs) continue;
      this.rows.set(r.cancellationId, { ...r, refundDueAtMs: closedAtMs });
      changed++;
    }
    return changed;
  }
}
