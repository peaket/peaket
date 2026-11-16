// 판매 재개 막기의 회차 취소 확인(BAT-420 GAT-110 H, ADR-0280 결정 2). 회차 취소 요청 저장소를 읽는다.
// 그 회차에 회차 취소(CANCEL) 요청이 확정 뒤 상태(APPROVED·RUNNING·PAUSED·COMPLETED)면 판매 재개를 막는다. 연기(POSTPONE)는 막지 않는다.
import type { CancelledEventGuard } from '../../commands/index.js';
import type { EventCancellationStatus } from '../domain/event-cancellation.js';
import type { EventCancellationStore } from '../domain/ports.js';

const CANCELLED: readonly EventCancellationStatus[] = ['APPROVED', 'RUNNING', 'PAUSED', 'COMPLETED'];

export class StoreCancelledEventGuard implements CancelledEventGuard {
  constructor(private readonly store: EventCancellationStore) {}

  async isCancelled(eventId: string): Promise<boolean> {
    const rows = await this.store.list({ eventId, status: CANCELLED, limit: 100 });
    return rows.some((r) => r.kind === 'CANCEL');
  }
}
