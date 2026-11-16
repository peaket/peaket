// 회차 취소 확정 때 판매 멈춤(BAT-420 GAT-110 H, ADR-0280 결정 1, 빈 뼈대).
// 판매 중지 집행(HttpCommandExecutor의 SALE_STOP, purchase-svc → queue-svc)을 회차 취소 요청 ID로 부른다.
import type { CommandExecutor } from '../modules/commands/domain/ports.js';
import type { EventSaleStopper } from '../modules/event-cancellations/domain/ports.js';

export class HttpEventSaleStopper implements EventSaleStopper {
  constructor(
    private readonly executor: CommandExecutor,
    private readonly now: () => number = Date.now,
  ) {}

  async stop(_q: { eventId: string; requestId: string }): Promise<void> {
    void this.executor;
    void this.now;
    throw new Error('아직 없음');
  }
}
