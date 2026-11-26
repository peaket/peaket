// 메모리 통보 저장소(F-07-11). 단위 시험과 local 메모리 조립이 쓴다.
import type { ComplianceAction, ComplianceActionRecord, ComplianceNoticeRecord } from '../domain/compliance-notice.js';
import type { ComplianceNoticeListQuery, ComplianceNoticeListResult, ComplianceNoticeStore } from '../domain/ports.js';

export class MemoryComplianceNoticeStore implements ComplianceNoticeStore {
  readonly notices = new Map<string, ComplianceNoticeRecord>();
  readonly actions: ComplianceActionRecord[] = [];

  async insertNotice(n: ComplianceNoticeRecord): Promise<void> {
    this.notices.set(n.noticeId, { ...n, reviewIds: [...n.reviewIds] });
  }

  async findNotice(noticeId: string): Promise<ComplianceNoticeRecord | undefined> {
    const n = this.notices.get(noticeId);
    return n ? { ...n, reviewIds: [...n.reviewIds] } : undefined;
  }

  async findByIdempotency(requestedBy: string, idempotencyKey: string): Promise<ComplianceNoticeRecord | undefined> {
    for (const n of this.notices.values()) if (n.requestedBy === requestedBy && n.idempotencyKey === idempotencyKey) return { ...n, reviewIds: [...n.reviewIds] };
    return undefined;
  }

  async listNotices(q: ComplianceNoticeListQuery): Promise<ComplianceNoticeListResult> {
    let items = [...this.notices.values()];
    if (q.status) items = items.filter((n) => n.status === q.status);
    items.sort((a, b) => (q.sort === 'LATEST' ? b.createdAtMs - a.createdAtMs : a.dueAtMs - b.dueAtMs));
    const at = q.cursor ? items.findIndex((n) => n.noticeId === q.cursor) : -1;
    const start = at >= 0 ? at + 1 : 0;
    const page = items.slice(start, start + q.limit);
    const nextCursor = start + page.length < items.length ? (page.at(-1)?.noticeId ?? null) : null;
    return { items: page.map((n) => ({ ...n, reviewIds: [...n.reviewIds] })), nextCursor };
  }

  async updateNotice(noticeId: string, patch: Partial<Pick<ComplianceNoticeRecord, 'status' | 'takenDownAtMs' | 'withdrawnAtMs' | 'updatedAtMs'>>): Promise<void> {
    const n = this.notices.get(noticeId);
    if (n) this.notices.set(noticeId, { ...n, ...patch });
  }

  async insertAction(a: ComplianceActionRecord): Promise<void> {
    this.actions.push({ ...a });
  }

  async findAction(noticeId: string, action: ComplianceAction, idempotencyKey: string): Promise<ComplianceActionRecord | undefined> {
    return this.actions.find((a) => a.noticeId === noticeId && a.action === action && a.idempotencyKey === idempotencyKey);
  }

  async actionsOf(noticeId: string): Promise<readonly ComplianceActionRecord[]> {
    return this.actions.filter((a) => a.noticeId === noticeId);
  }
}
