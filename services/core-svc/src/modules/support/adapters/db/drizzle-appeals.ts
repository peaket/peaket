// core-svc support Drizzle 저장소(F-06-4, 0049). 소명과 CS 건 요청(Outbox)을 한 트랜잭션으로 쓴다.
// 조회·갱신은 drizzle 식·파라미터로만 한다(ASVS 1.2.4). 보내기 값은 기존 outbox 표(JSON 바이트, 아브로 인코더 전)에 둔다.
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { AppealRow, CaseRequestedRow } from '../../domain/appeal.js';
import type { AppealStore } from '../../domain/ports.js';
import { appeal, outbox } from './schema.js';

const topik = 'support.cases-requested';

const rowOf = (r: typeof appeal.$inferSelect): AppealRow => ({
  appealId: r.id,
  accountId: r.accountId,
  kind: r.kind as AppealRow['kind'],
  targetId: r.targetId,
  body: r.body,
  status: r.status as AppealRow['status'],
  result: (r.result as AppealRow['result']) ?? null,
  resultNote: r.resultNote,
  caseId: r.caseId,
  submittedAtMs: r.submittedAt.getTime(),
  decidedAtMs: r.decidedAt?.getTime() ?? null,
  dispatchState: r.dispatchState as AppealRow['dispatchState'],
  dispatchAttempts: r.dispatchAttempts,
  nextDispatchAtMs: r.nextDispatchAt?.getTime() ?? null,
  dispatchedAtMs: r.dispatchedAt?.getTime() ?? null,
});

export class DrizzleAppealStore implements AppealStore {
  constructor(private readonly database: Database) {}

  async saveAppeal(row: AppealRow, caseRequest: CaseRequestedRow): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(appeal).values({
        id: row.appealId,
        accountId: row.accountId,
        kind: row.kind,
        targetId: row.targetId,
        body: row.body,
        status: row.status,
        result: row.result,
        resultNote: row.resultNote,
        caseId: row.caseId,
        submittedAt: new Date(row.submittedAtMs),
        decidedAt: null,
        dispatchState: row.dispatchState,
        dispatchAttempts: row.dispatchAttempts,
        nextDispatchAt: row.nextDispatchAtMs === null ? null : new Date(row.nextDispatchAtMs),
        dispatchedAt: null,
      });
      await tx.insert(outbox).values({
        id: randomUUID(),
        topic: topik,
        msgKey: caseRequest.sourceId,
        payload: Buffer.from(JSON.stringify(caseRequest), 'utf8'),
        headers: {},
      });
    });
  }

  async find(appealId: string): Promise<AppealRow | undefined> {
    const rows = await this.database.db.select().from(appeal).where(eq(appeal.id, appealId)).limit(1);
    return rows[0] ? rowOf(rows[0]) : undefined;
  }

  async listByAccount(accountId: string, limit: number): Promise<AppealRow[]> {
    const rows = await this.database.db
      .select()
      .from(appeal)
      .where(eq(appeal.accountId, accountId))
      .orderBy(desc(appeal.submittedAt))
      .limit(limit);
    return rows.map(rowOf);
  }

  async saveResult(appealId: string, patch: { status: AppealRow['status']; result?: string | null; resultNote?: string | null; decidedAtMs: number; caseId?: string | null }): Promise<void> {
    await this.database.db
      .update(appeal)
      .set({
        status: patch.status,
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.resultNote !== undefined ? { resultNote: patch.resultNote } : {}),
        decidedAt: new Date(patch.decidedAtMs),
        ...(patch.caseId !== undefined ? { caseId: patch.caseId } : {}),
        dispatchState: 'SENT',
        nextDispatchAt: null,
      })
      .where(eq(appeal.id, appealId));
  }

  async saveDispatch(appealId: string, patch: { state: AppealRow['dispatchState']; attempts: number; nextAtMs: number | null; dispatchedAtMs: number | null }): Promise<void> {
    await this.database.db
      .update(appeal)
      .set({ dispatchState: patch.state, dispatchAttempts: patch.attempts, nextDispatchAt: patch.nextAtMs === null ? null : new Date(patch.nextAtMs), dispatchedAt: patch.dispatchedAtMs === null ? null : new Date(patch.dispatchedAtMs) })
      .where(eq(appeal.id, appealId));
  }

  async dueDispatch(nowMs: number, limit: number): Promise<AppealRow[]> {
    const rows = await this.database.db
      .select()
      .from(appeal)
      .where(and(inArray(appeal.dispatchState, ['PENDING', 'RETRY']), lte(appeal.nextDispatchAt, new Date(nowMs))))
      .limit(limit);
    return rows.map(rowOf);
  }

  async outboxRows(): Promise<CaseRequestedRow[]> {
    const rows = await this.database.db.select().from(outbox).where(eq(outbox.topic, topik));
    return rows.map((r) => JSON.parse(r.payload.toString('utf8')) as CaseRequestedRow);
  }
}
