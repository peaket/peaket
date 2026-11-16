// 판매 재개 막기의 회차 취소 확인(BAT-420 GAT-110 H, ADR-0280 결정 2, 빈 뼈대). 회차 취소 요청 저장소를 읽는다.
import type { CancelledEventGuard } from '../../commands/index.js';
import type { EventCancellationStore } from '../domain/ports.js';

export class StoreCancelledEventGuard implements CancelledEventGuard {
  constructor(private readonly store: EventCancellationStore) {}

  async isCancelled(_eventId: string): Promise<boolean> {
    void this.store;
    throw new Error('아직 없음');
  }
}
