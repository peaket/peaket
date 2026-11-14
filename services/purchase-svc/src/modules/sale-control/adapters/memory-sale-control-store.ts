// 시험용 메모리 sale_control 저장소. Drizzle 구현과 같은 조건부 쓰기 규칙을 지킨다.
import type { SaleControlStore } from '../domain/ports.js';
import type { SaleControl, SaleSuspensionApplied, SaleSuspensionWrite } from '../domain/sale-control.js';

export class MemorySaleControlStore implements SaleControlStore {
  readonly rows = new Map<string, SaleControl>();

  async find(eventId: string): Promise<SaleControl | undefined> {
    return this.rows.get(eventId);
  }

  async apply(write: SaleSuspensionWrite): Promise<SaleSuspensionApplied> {
    const current = this.rows.get(write.eventId);
    if (current && current.commandId === write.commandId && current.suspended === write.suspended) return { control: current, changed: false };
    if (current && write.version !== undefined && write.version <= current.revision) return { control: current, changed: false };
    const control: SaleControl = {
      eventId: write.eventId,
      paused: current?.paused ?? false,
      suspended: write.suspended,
      revision: Math.max((current?.revision ?? 0) + 1, write.version ?? 0),
      commandId: write.commandId,
      ...(write.suspensionRef !== undefined ? { suspensionRef: write.suspensionRef } : current?.suspensionRef !== undefined ? { suspensionRef: current.suspensionRef } : {}),
      reason: write.reason,
      updatedAtMs: write.nowMs,
    };
    this.rows.set(write.eventId, control);
    return { control, changed: true };
  }
}
