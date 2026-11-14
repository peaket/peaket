// 시험용 메모리 사본. 실제 어댑터(redis-sale-control-copies)와 같은 값을 남긴다.
import type { SaleControlCopies } from '../domain/ports.js';
import type { SaleControl } from '../domain/sale-control.js';

export class MemorySaleControlCopies implements SaleControlCopies {
  readonly written = new Map<string, Record<string, string>>();

  async write(c: Pick<SaleControl, 'eventId' | 'suspended' | 'revision' | 'commandId' | 'suspensionRef'>): Promise<void> {
    const fields: Record<string, string> = { suspended: c.suspended ? '1' : '0', rev: String(c.revision) };
    if (c.commandId !== undefined) fields.cmd = c.commandId;
    if (c.suspensionRef !== undefined) fields.suspRef = c.suspensionRef;
    this.written.set(c.eventId, { ...(this.written.get(c.eventId) ?? {}), ...fields });
  }
}
