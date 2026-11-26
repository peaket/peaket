// FLAGGED 취소 무효(IR-30)의 purchase 쪽 한 걸음. ticket-svc가 티켓을 VOIDED로 바꾼 뒤
// order_cancellation 행을 VOIDED로 끝낸다. 같은 요청을 다시 보내도 같은 답이다.
import type { Clock } from '@peaket/platform';
import type { CancellationWrites } from '../domain/ports.js';

export class ApprovalCancellationVoid {
  constructor(private readonly d: { writes: Pick<CancellationWrites, 'updateStatus'>; clock: Clock }) {}

  /** 취소 행이 있으면 VOIDED로 바꾸고 true, 없으면 false */
  async execute(cancellationId: string): Promise<boolean> {
    const out = await this.d.writes.updateStatus({ cancellationId, status: 'VOIDED', nowMs: this.d.clock.now() });
    return out !== false;
  }
}
