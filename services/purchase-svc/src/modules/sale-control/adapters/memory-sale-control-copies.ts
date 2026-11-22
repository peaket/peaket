// 시험용 메모리 사본. 실제 어댑터(redis-sale-control-copies)와 같은 값·같은 비교 규칙을 남긴다.
import type { SaleControlCopies } from '../domain/ports.js';
import type { SaleControl } from '../domain/sale-control.js';

export class MemorySaleControlCopies implements SaleControlCopies {
  readonly written = new Map<string, Record<string, string>>();
  /** 회차 목록 s:ctl:events(전체 범위 사본을 쓸 회차) */
  readonly events = new Set<string>();

  async write(c: Pick<SaleControl, 'eventId' | 'suspended' | 'revision' | 'commandId' | 'suspensionRef'>): Promise<void> {
    const fields: Record<string, string> = { suspended: c.suspended ? '1' : '0', rev: String(c.revision) };
    if (c.commandId !== undefined) fields.cmd = c.commandId;
    if (c.suspensionRef !== undefined) fields.suspRef = c.suspensionRef;
    this.written.set(c.eventId, { ...(this.written.get(c.eventId) ?? {}), ...fields });
  }

  async writePause(c: { eventId: string; paused: boolean; revision: number; commandId?: string }): Promise<number> {
    const cur = this.written.get(c.eventId) ?? {};
    const rev = Number(cur.pausedRev ?? '0');
    if (c.revision <= rev) return rev;
    this.written.set(c.eventId, { ...cur, paused: c.paused ? '1' : '0', pausedRev: String(c.revision), pausedCmd: c.commandId ?? '' });
    return c.revision;
  }

  async writePlatformPause(c: { paused: boolean; revision: number; commandId?: string }): Promise<number> {
    let n = 0;
    for (const eventId of this.events) {
      const cur = this.written.get(eventId) ?? {};
      if (c.revision <= Number(cur.allRev ?? '0')) continue;
      this.written.set(eventId, { ...cur, allPaused: c.paused ? '1' : '0', allRev: String(c.revision), allCmd: c.commandId ?? '' });
      n += 1;
    }
    return n;
  }
}
