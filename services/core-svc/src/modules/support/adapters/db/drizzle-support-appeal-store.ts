// F-04-15 support 소명 저장소(운영 core DB). 멱등 기록은 이 동결 트랙에서 프로세스 메모리에 둔다(남은 위험).
import type { Database } from '@peaket/platform';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import type { AppealRecord } from '../../domain/appeal.js';
import type { IdempotentLookup, IdempotentWrite, SupportAppealStore } from '../../domain/ports.js';
import { appeal } from './schema.js';

const sameHash = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const rowOf = (r: typeof appeal.$inferSelect): AppealRecord => ({
  id: r.id,
  accountId: r.accountId,
  kind: r.kind as AppealRecord['kind'],
  targetId: r.targetId,
  body: r.body,
  status: r.status as AppealRecord['status'],
  result: r.result as AppealRecord['result'],
  caseId: r.caseId,
  submittedAtMs: r.submittedAt.getTime(),
  decidedAtMs: r.decidedAt ? r.decidedAt.getTime() : null,
});

export class DrizzleSupportAppealStore implements SupportAppealStore {
  readonly idem = new Map<string, { requestHash: Uint8Array; result: unknown }>();
  constructor(private readonly db: Database) {}
  private readonly keyOf = (i: IdempotentWrite): string => `${i.accountRef}:${i.operation}:${i.key}`;

  async put(a: AppealRecord, o?: { idem?: IdempotentWrite; result?: unknown }): Promise<{ replayed: boolean; result?: unknown }> {
    if (o?.idem) {
      const k = this.keyOf(o.idem);
      const found = this.idem.get(k);
      if (found && sameHash(found.requestHash, o.idem.requestHash)) return { replayed: true, ...(found.result === undefined ? {} : { result: found.result }) };
      this.idem.set(k, { requestHash: new Uint8Array(o.idem.requestHash), result: o.result });
    }
    await this.db.db.insert(appeal).values({
      id: a.id,
      accountId: a.accountId,
      kind: a.kind,
      targetId: a.targetId,
      body: a.body,
      status: a.status,
      result: a.result,
      caseId: a.caseId,
      submittedAt: new Date(a.submittedAtMs),
      decidedAt: a.decidedAtMs === null ? null : new Date(a.decidedAtMs),
    });
    return { replayed: false };
  }

  async get(id: string): Promise<AppealRecord | null> {
    const r = await this.db.db.select().from(appeal).where(eq(appeal.id, id)).limit(1);
    return r[0] ? rowOf(r[0]) : null;
  }

  async listByAccount(accountId: string, q: { cursor?: string; limit: number }): Promise<{ items: AppealRecord[]; nextCursor: string | null }> {
    // 커서는 앞 페이지 마지막 소명 ID다. 시각 내림차순·ID 오름차순(메모리 저장소와 같다)의 바로 뒤부터 준다.
    const cursored = q.cursor
      ? await this.db.db
          .select({ submittedAt: appeal.submittedAt, id: appeal.id })
          .from(appeal)
          .where(and(eq(appeal.accountId, accountId), eq(appeal.id, q.cursor)))
          .limit(1)
      : [];
    const cur = cursored[0];
    const where = cur
      ? and(eq(appeal.accountId, accountId), or(lt(appeal.submittedAt, cur.submittedAt), and(eq(appeal.submittedAt, cur.submittedAt), gt(appeal.id, cur.id))))
      : eq(appeal.accountId, accountId);
    const rows = await this.db.db.select().from(appeal).where(where).orderBy(desc(appeal.submittedAt), asc(appeal.id)).limit(q.limit + 1);
    const items = rows.slice(0, q.limit).map(rowOf);
    return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async update(a: AppealRecord): Promise<boolean> {
    const r = await this.db.db
      .update(appeal)
      .set({ body: a.body, status: a.status, result: a.result, caseId: a.caseId, decidedAt: a.decidedAtMs === null ? null : new Date(a.decidedAtMs) })
      .where(eq(appeal.id, a.id))
      .returning({ id: appeal.id });
    return r.length > 0;
  }

  async findIdempotent(i: IdempotentWrite): Promise<IdempotentLookup> {
    const found = this.idem.get(this.keyOf(i));
    if (!found) return { kind: 'none' };
    return sameHash(found.requestHash, i.requestHash) ? { kind: 'replay', result: found.result } : { kind: 'reused' };
  }
}
