// 회차 취소 확정 때 판매 멈춤(BAT-420 GAT-110 H, ADR-0280 결정 1).
// 판매 중지 집행(HttpCommandExecutor의 SALE_STOP: purchase-svc → queue-svc, 제어 gRPC가 있으면 그 길)을 회차 취소 요청 ID로 부른다.
// 명령 ID와 중지 참조(suspensionRef)가 요청 ID라 다시 확정해도 받는 쪽이 같은 중지로 본다. 실패하면 던져 확정을 멈춘다.
import type { Command, CommandExecutionActor } from '../modules/commands/domain/command.js';
import type { CommandExecutor } from '../modules/commands/domain/ports.js';
import type { EventSaleStopper } from '../modules/event-cancellations/domain/ports.js';

/** 판매 중지 사유(purchase-svc sale_control 사유 칸에 남는다) */
const REASON = 'EVENT_CANCELLATION';
const SYSTEM: CommandExecutionActor = { accountId: 'system:event-cancellation', sessionId: '', role: 'system' };

export class HttpEventSaleStopper implements EventSaleStopper {
  constructor(
    private readonly executor: CommandExecutor,
    private readonly now: () => number = Date.now,
  ) {}

  async stop(q: { eventId: string; requestId: string }): Promise<void> {
    const nowMs = this.now();
    // 판매 중지 사유 코드(reasonCode)는 운영 명령의 값이라 비운다(SUSPENSION_REASON_CODES 검사는 값이 있을 때만 한다)
    const command: Command = {
      commandId: q.requestId,
      type: 'SALE_STOP',
      state: 'APPROVED',
      reason: REASON,
      params: { eventId: q.eventId, suspensionRef: q.requestId },
      requestedBy: SYSTEM.accountId,
      requestedRole: SYSTEM.role,
      eventId: q.eventId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      approvals: [],
      attempts: 0,
    };
    const result = await this.executor.execute(command, SYSTEM);
    if (result.status === 'FAILED') throw new Error(`sale-stop-failed:${result.error}`);
  }
}
