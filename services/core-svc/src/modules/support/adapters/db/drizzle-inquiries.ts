// core-svc support 문의 Drizzle 저장소(F-06-5, 0055). 문의·기록·Outbox를 한 트랜잭션으로 쓴다.
// 조회·갱신은 drizzle 식·파라미터로만 한다(ASVS 1.2.4).
import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { InquiryCaseRequestRow, InquiryMessageRow, InquiryRow, InquiryStatus } from '../../domain/inquiry.js';
import type { InquiryStore } from '../../domain/inquiry-ports.js';
import { inquiry, inquiryMessage, outbox } from './schema.js';

const TOPIC = 'support.cases-requested';

const rowOf = (r: typeof inquiry.$inferSelect): InquiryRow => ({
  inquiryId: r.id,
  number: r.number,
  accountId: r.accountId,
  category: r.category as InquiryRow['category'],
  orderRef: r.orderRef,
  orderSummary: r.orderSummary,
  title: r.title,
  body: r.body,
  status: r.status as InquiryStatus,
  caseId: r.caseId,
  requestKey: r.requestKey,
  requestHash: r.requestHash,
  createdAtMs: r.createdAt.getTime(),
  answeredAtMs: r.answeredAt?.getTime() ?? null,
  fanViewedAtMs: r.fanViewedAt?.getTime() ?? null,
  closedAtMs: r.closedAt?.getTime() ?? null,
  purgeAtMs: r.purgeAt?.getTime() ?? null,
  progressDueAtMs: r.progressDueAt?.getTime() ?? null,
  resultDueAtMs: r.resultDueAt.getTime(),
});
const messageOf = (r: typeof inquiryMessage.$inferSelect): InquiryMessageRow => ({
  messageId: r.id,
  inquiryId: r.inquiryId,
  authorKind: r.authorKind as InquiryMessageRow['authorKind'],
  kind: r.kind as InquiryMessageRow['kind'],
  body: r.body,
  requestKey: r.requestKey ?? '',
  requestHash: r.requestHash ?? '',
  createdAtMs: r.createdAt.getTime(),
});

export class DrizzleInquiryStore implements InquiryStore {
  constructor(private readonly database: Database) {}

  async create(r: InquiryRow, m: InquiryMessageRow, c: InquiryCaseRequestRow): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(inquiry).values({
        id: r.inquiryId, number: r.number, accountId: r.accountId, category: r.category, orderRef: r.orderRef, orderSummary: r.orderSummary,
        title: r.title, body: r.body, status: r.status, caseId: r.caseId, requestKey: r.requestKey, requestHash: r.requestHash,
        createdAt: new Date(r.createdAtMs), answeredAt: null, fanViewedAt: null, closedAt: null, purgeAt: null,
        progressDueAt: r.progressDueAtMs === null ? null : new Date(r.progressDueAtMs), resultDueAt: new Date(r.resultDueAtMs),
      });
      await tx.insert(inquiryMessage).values({ id: m.messageId, inquiryId: m.inquiryId, authorKind: m.authorKind, kind: m.kind, body: m.body, requestKey: m.requestKey, requestHash: m.requestHash, createdAt: new Date(m.createdAtMs) });
      await tx.insert(outbox).values({ id: randomUUID(), topic: TOPIC, msgKey: c.sourceId, payload: Buffer.from(JSON.stringify(c), 'utf8'), headers: {} });
    });
  }

  async find(inquiryId: string): Promise<InquiryRow | undefined> {
    const rows = await this.database.db.select().from(inquiry).where(eq(inquiry.id, inquiryId)).limit(1);
    return rows[0] ? rowOf(rows[0]) : undefined;
  }

  async findByRequestKey(accountId: string, requestKey: string): Promise<InquiryRow | undefined> {
    const rows = await this.database.db.select().from(inquiry).where(and(eq(inquiry.accountId, accountId), eq(inquiry.requestKey, requestKey))).limit(1);
    return rows[0] ? rowOf(rows[0]) : undefined;
  }

  async listByAccount(accountId: string, statuses: readonly InquiryStatus[] | undefined, limit: number, offset: number): Promise<InquiryRow[]> {
    const where = statuses && statuses.length ? and(eq(inquiry.accountId, accountId), inArray(inquiry.status, [...statuses])) : eq(inquiry.accountId, accountId);
    const rows = await this.database.db.select().from(inquiry).where(where).orderBy(sql`${inquiry.createdAt} desc`).limit(limit).offset(offset);
    return rows.map(rowOf);
  }

  async countByAccount(accountId: string, statuses: readonly InquiryStatus[] | undefined): Promise<number> {
    const where = statuses && statuses.length ? and(eq(inquiry.accountId, accountId), inArray(inquiry.status, [...statuses])) : eq(inquiry.accountId, accountId);
    const rows = await this.database.db.select({ n: sql<number>`count(*)::int` }).from(inquiry).where(where);
    return Number(rows[0]?.n ?? 0);
  }

  async countSince(accountId: string, sinceMs: number): Promise<number> {
    const rows = await this.database.db.select({ n: sql<number>`count(*)::int` }).from(inquiry).where(and(eq(inquiry.accountId, accountId), gte(inquiry.createdAt, new Date(sinceMs))));
    return Number(rows[0]?.n ?? 0);
  }

  async nextSequence(ym: string): Promise<number> {
    const rows = await this.database.db
      .select({ n: sql<number>`coalesce(max(right(${inquiry.number}, 4)::int), 0)` })
      .from(inquiry)
      .where(eq(sql`left(${inquiry.number}, 6)`, `Q-${ym}`));
    return Number(rows[0]?.n ?? 0) + 1;
  }

  async messages(inquiryId: string): Promise<InquiryMessageRow[]> {
    const rows = await this.database.db.select().from(inquiryMessage).where(eq(inquiryMessage.inquiryId, inquiryId)).orderBy(asc(inquiryMessage.createdAt));
    return rows.map(messageOf);
  }

  async findMessageByRequestKey(inquiryId: string, requestKey: string): Promise<InquiryMessageRow | undefined> {
    const rows = await this.database.db.select().from(inquiryMessage).where(and(eq(inquiryMessage.inquiryId, inquiryId), eq(inquiryMessage.requestKey, requestKey))).limit(1);
    return rows[0] ? messageOf(rows[0]) : undefined;
  }

  async addFanMessage(m: InquiryMessageRow, status: InquiryStatus, c: InquiryCaseRequestRow): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(inquiryMessage).values({ id: m.messageId, inquiryId: m.inquiryId, authorKind: m.authorKind, kind: m.kind, body: m.body, requestKey: m.requestKey, requestHash: m.requestHash, createdAt: new Date(m.createdAtMs) });
      await tx.update(inquiry).set({ status }).where(eq(inquiry.id, m.inquiryId));
      await tx.insert(outbox).values({ id: randomUUID(), topic: TOPIC, msgKey: c.sourceId, payload: Buffer.from(JSON.stringify(c), 'utf8'), headers: {} });
    });
  }

  async addAgentMessage(m: InquiryMessageRow, status: InquiryStatus, answeredAtMs: number | null): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(inquiryMessage).values({ id: m.messageId, inquiryId: m.inquiryId, authorKind: m.authorKind, kind: m.kind, body: m.body, requestKey: m.requestKey, requestHash: m.requestHash, createdAt: new Date(m.createdAtMs) });
      await tx.update(inquiry).set({ status, ...(answeredAtMs === null ? {} : { answeredAt: new Date(answeredAtMs) }) }).where(eq(inquiry.id, m.inquiryId));
    });
  }

  async markViewed(inquiryId: string, nowMs: number): Promise<void> {
    await this.database.db.update(inquiry).set({ fanViewedAt: new Date(nowMs) }).where(eq(inquiry.id, inquiryId));
  }

  async setCaseId(inquiryId: string, caseId: string): Promise<boolean> {
    const rows = await this.database.db.update(inquiry).set({ caseId }).where(eq(inquiry.id, inquiryId)).returning({ id: inquiry.id });
    return rows.length > 0;
  }

  async close(inquiryId: string, nowMs: number, purgeAtMs: number): Promise<void> {
    await this.database.db.update(inquiry).set({ status: 'CLOSED', closedAt: new Date(nowMs), purgeAt: new Date(purgeAtMs) }).where(eq(inquiry.id, inquiryId));
  }

  async closeIdle(nowMs: number, idleMs: number, purgeYears: number): Promise<number> {
    const cutoff = new Date(nowMs - idleMs);
    const purge = new Date(Date.UTC(new Date(nowMs).getUTCFullYear() + purgeYears, new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate(), new Date(nowMs).getUTCHours(), new Date(nowMs).getUTCMinutes(), new Date(nowMs).getUTCSeconds(), new Date(nowMs).getUTCMilliseconds()));
    const rows = await this.database.db
      .update(inquiry)
      .set({ status: 'CLOSED', closedAt: new Date(nowMs), purgeAt: purge })
      .where(and(eq(inquiry.status, 'ANSWERED'), isNotNull(inquiry.answeredAt), lt(inquiry.answeredAt, cutoff)))
      .returning({ id: inquiry.id });
    return rows.length;
  }

  async outboxRows(): Promise<InquiryCaseRequestRow[]> {
    return [];
  }
}
