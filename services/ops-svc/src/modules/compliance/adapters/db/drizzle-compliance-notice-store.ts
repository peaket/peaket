// 운영 통보 저장소(F-07-11, ops 0040). 목록은 통보 수가 적어 DB에서 거른 뒤 커서를 JS에서 자른다.
import type { Database } from '@peaket/platform';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { ComplianceAction, ComplianceActionRecord, ComplianceNoticeRecord } from '../../domain/compliance-notice.js';
import type { ComplianceNoticeListQuery, ComplianceNoticeListResult, ComplianceNoticeStore } from '../../domain/ports.js';
import { takedownNotice, takedownNoticeAction } from './schema.js';

type NoticeRow = typeof takedownNotice.$inferSelect;
type ActionRow = typeof takedownNoticeAction.$inferSelect;

const noticeOf = (r: NoticeRow): ComplianceNoticeRecord => ({
  noticeId: r.id,
  requestedBy: r.requestedBy,
  idempotencyKey: r.idempotencyKey,
  requestHash: r.requestHash,
  requester: r.requester as ComplianceNoticeRecord['requester'],
  agencyName: r.agencyName,
  receivedAtMs: r.receivedAt.getTime(),
  deadline: r.deadline as ComplianceNoticeRecord['deadline'],
  dueAtMs: r.dueAt.getTime(),
  reviewIds: [...r.reviewIds],
  summary: r.summary,
  status: r.status as ComplianceNoticeRecord['status'],
  ...(r.takenDownAt ? { takenDownAtMs: r.takenDownAt.getTime() } : {}),
  ...(r.withdrawnAt ? { withdrawnAtMs: r.withdrawnAt.getTime() } : {}),
  createdAtMs: r.createdAt.getTime(),
  updatedAtMs: r.updatedAt.getTime(),
});

const actionOf = (r: ActionRow): ComplianceActionRecord => ({
  actionId: r.id,
  noticeId: r.noticeId,
  action: r.action as ComplianceAction,
  idempotencyKey: r.idempotencyKey,
  requestHash: Buffer.from(r.requestHash).toString('hex'),
  reason: r.reason,
  actorRef: r.actorRef,
  createdAtMs: r.createdAt.getTime(),
});

export class DrizzleComplianceNoticeStore implements ComplianceNoticeStore {
  constructor(private readonly database: Database) {}

  async insertNotice(n: ComplianceNoticeRecord): Promise<void> {
    await this.database.db.insert(takedownNotice).values({
      id: n.noticeId,
      requestedBy: n.requestedBy,
      idempotencyKey: n.idempotencyKey,
      requestHash: n.requestHash,
      requester: n.requester,
      agencyName: n.agencyName,
      receivedAt: new Date(n.receivedAtMs),
      deadline: n.deadline,
      dueAt: new Date(n.dueAtMs),
      reviewIds: [...n.reviewIds],
      summary: n.summary,
      status: n.status,
      ...(n.takenDownAtMs !== undefined ? { takenDownAt: new Date(n.takenDownAtMs) } : {}),
      ...(n.withdrawnAtMs !== undefined ? { withdrawnAt: new Date(n.withdrawnAtMs) } : {}),
      createdAt: new Date(n.createdAtMs),
      updatedAt: new Date(n.updatedAtMs),
    });
  }

  async findNotice(noticeId: string): Promise<ComplianceNoticeRecord | undefined> {
    const rows = await this.database.db.select().from(takedownNotice).where(eq(takedownNotice.id, noticeId)).limit(1);
    return rows[0] ? noticeOf(rows[0]) : undefined;
  }

  async findByIdempotency(requestedBy: string, idempotencyKey: string): Promise<ComplianceNoticeRecord | undefined> {
    const rows = await this.database.db
      .select()
      .from(takedownNotice)
      .where(and(eq(takedownNotice.requestedBy, requestedBy), eq(takedownNotice.idempotencyKey, idempotencyKey)))
      .limit(1);
    return rows[0] ? noticeOf(rows[0]) : undefined;
  }

  async listNotices(q: ComplianceNoticeListQuery): Promise<ComplianceNoticeListResult> {
    const rows = await this.database.db
      .select()
      .from(takedownNotice)
      .where(q.status ? eq(takedownNotice.status, q.status) : undefined)
      .orderBy(q.sort === 'LATEST' ? desc(takedownNotice.createdAt) : asc(takedownNotice.dueAt), asc(takedownNotice.id));
    const at = q.cursor ? rows.findIndex((r) => r.id === q.cursor) : -1;
    const start = at >= 0 ? at + 1 : 0;
    const page = rows.slice(start, start + q.limit);
    const nextCursor = start + page.length < rows.length ? (page.at(-1)?.id ?? null) : null;
    return { items: page.map(noticeOf), nextCursor };
  }

  async updateNotice(noticeId: string, patch: Partial<Pick<ComplianceNoticeRecord, 'status' | 'takenDownAtMs' | 'withdrawnAtMs' | 'updatedAtMs'>>): Promise<void> {
    await this.database.db
      .update(takedownNotice)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.takenDownAtMs !== undefined ? { takenDownAt: new Date(patch.takenDownAtMs) } : {}),
        ...(patch.withdrawnAtMs !== undefined ? { withdrawnAt: new Date(patch.withdrawnAtMs) } : {}),
        ...(patch.updatedAtMs !== undefined ? { updatedAt: new Date(patch.updatedAtMs) } : {}),
      })
      .where(eq(takedownNotice.id, noticeId));
  }

  async insertAction(a: ComplianceActionRecord): Promise<void> {
    await this.database.db.insert(takedownNoticeAction).values({
      id: a.actionId,
      noticeId: a.noticeId,
      action: a.action,
      idempotencyKey: a.idempotencyKey,
      requestHash: Buffer.from(a.requestHash, 'hex'),
      reason: a.reason,
      actorRef: a.actorRef,
      createdAt: new Date(a.createdAtMs),
    });
  }

  async findAction(noticeId: string, action: ComplianceAction, idempotencyKey: string): Promise<ComplianceActionRecord | undefined> {
    const rows = await this.database.db
      .select()
      .from(takedownNoticeAction)
      .where(and(eq(takedownNoticeAction.noticeId, noticeId), eq(takedownNoticeAction.action, action), eq(takedownNoticeAction.idempotencyKey, idempotencyKey)))
      .limit(1);
    return rows[0] ? actionOf(rows[0]) : undefined;
  }

  async actionsOf(noticeId: string): Promise<readonly ComplianceActionRecord[]> {
    const rows = await this.database.db.select().from(takedownNoticeAction).where(eq(takedownNoticeAction.noticeId, noticeId)).orderBy(asc(takedownNoticeAction.createdAt));
    return rows.map(actionOf);
  }
}
