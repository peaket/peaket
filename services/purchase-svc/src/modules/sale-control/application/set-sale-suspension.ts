// 판매 중지·재개를 원본 표에 쓰고 좌석 Redis 사본을 맞춘다(ADR-0123, docs/features/transfer-refund.md §2.1).
// 사본 쓰기는 늘 한다: 같은 명령의 재시도에서 원본이 이미 바뀌어 changed가 거짓이어도, 앞선 시도가 Redis에 못 쓴 것을 고칠 수 있다.
// 사본이 실패하면 던진다. 명령은 FAILED로 남고 재시도가 같은 명령 ID로 다시 부른다(멱등).
import type { SaleControlCopies, SaleControlStore } from '../domain/ports.js';
import type { SaleSuspensionInput, SaleSuspensionResult } from '../domain/sale-control.js';

export class SetSaleSuspension {
  constructor(
    private readonly store: SaleControlStore,
    private readonly copies?: SaleControlCopies,
  ) {}

  async run(input: SaleSuspensionInput): Promise<SaleSuspensionResult> {
    const suspended = input.action === 'SUSPEND';
    const applied = await this.store.apply({
      eventId: input.eventId,
      suspended,
      commandId: input.commandId,
      ...(input.suspensionRef !== undefined ? { suspensionRef: input.suspensionRef } : {}),
      reason: input.reason,
      nowMs: input.nowMs,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    await this.copies?.write({
      eventId: applied.control.eventId,
      suspended: applied.control.suspended,
      revision: applied.control.revision,
      ...(applied.control.commandId !== undefined ? { commandId: applied.control.commandId } : {}),
      ...(applied.control.suspensionRef !== undefined ? { suspensionRef: applied.control.suspensionRef } : {}),
    });
    return { eventId: applied.control.eventId, suspended: applied.control.suspended, revision: applied.control.revision, changed: applied.changed };
  }

  /** 지금 사본(원본 표)을 읽는다. 없으면 판매 중지가 아닌 것으로 본다 */
  async state(eventId: string): Promise<{ eventId: string; suspended: boolean; revision: number }> {
    const row = await this.store.find(eventId);
    return { eventId, suspended: row?.suspended ?? false, revision: row?.revision ?? 0 };
  }
}
