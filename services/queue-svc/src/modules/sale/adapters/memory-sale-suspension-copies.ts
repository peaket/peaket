// 시험용 메모리 사본. 실제 어댑터(redis-sale-suspension-copies)와 같은 칸을 남긴다.
import type { SaleSuspensionCopies, SaleSuspensionCopyWrite } from '../domain/sale-suspension.js';

export class MemorySaleSuspensionCopies implements SaleSuspensionCopies {
  /** 회차 → { notice, ctl }의 칸 */
  readonly written = new Map<string, { notice: Record<string, string>; ctl: Record<string, string> }>();

  async write(c: SaleSuspensionCopyWrite): Promise<void> {
    const fields = { suspended: c.suspended ? '1' : '0', suspRev: String(c.revision), suspCmd: c.commandId };
    const prev = this.written.get(c.eventId);
    this.written.set(c.eventId, { notice: { ...(prev?.notice ?? {}), ...fields }, ctl: { ...(prev?.ctl ?? {}), ...fields } });
  }
}
