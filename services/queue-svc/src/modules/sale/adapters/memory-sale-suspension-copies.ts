// 시험용 메모리 사본. 실제 어댑터(redis-sale-suspension-copies)와 같은 칸을 남긴다.
import type { SaleSuspensionCopies, SaleSuspensionCopyWrite } from '../domain/sale-suspension.js';

export class MemorySaleSuspensionCopies implements SaleSuspensionCopies {
  /** 회차 → { notice, ctl }의 칸 */
  readonly written = new Map<string, { notice: Record<string, string>; ctl: Record<string, string> }>();

  async write(c: SaleSuspensionCopyWrite): Promise<number> {
    const fields = { suspended: c.suspended ? '1' : '0', suspRev: String(c.revision), suspCmd: c.commandId };
    const prev = this.written.get(c.eventId);
    // 판이 0보다 크면 notice의 suspRev보다 클 때만 쓴다(Redis 구현과 같다)
    const cur = Number(prev?.notice.suspRev ?? '0');
    if (c.revision > 0 && c.revision <= cur) return cur;
    this.written.set(c.eventId, { notice: { ...(prev?.notice ?? {}), ...fields }, ctl: { ...(prev?.ctl ?? {}), ...fields } });
    return c.revision;
  }
}
