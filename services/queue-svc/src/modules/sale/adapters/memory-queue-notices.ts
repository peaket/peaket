// 시험용 메모리 notice. 실제 어댑터(redis-queue-notices)와 같은 칸·같은 비교 규칙을 남긴다.
import { QUEUE_NOTICE_FIELDS, type QueueNotices, type QueueNoticeWrite } from '../domain/queue-notice.js';

export class MemoryQueueNotices implements QueueNotices {
  /** 범위(회차 ID·PLATFORM) → notice 칸 */
  readonly written = new Map<string, Record<string, string>>();

  async write(w: QueueNoticeWrite): Promise<number> {
    const f = QUEUE_NOTICE_FIELDS[w.kind];
    const cur = { ...(this.written.get(w.scope) ?? {}) };
    const rev = Number(cur[f.rev] ?? '0');
    if (w.revision <= rev) return rev;
    if (w.value === null) delete cur[f.value];
    else cur[f.value] = w.value;
    Object.assign(cur, { [f.rev]: String(w.revision), [f.cmd]: w.commandId, version: String(w.revision), commandId: w.commandId });
    this.written.set(w.scope, cur);
    return w.revision;
  }
}
