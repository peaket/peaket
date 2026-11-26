// F-04-15 support 소명 저장소(운영 core DB). 멱등은 idempotency_record에 남겨 재시작·다중 인스턴스에서도 재생한다(IR-06).
import { ProblemError, type Database } from '@peaket/platform';
import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import { appealResponse, type AppealRecord } from '../../domain/appeal.js';
import type { IdempotentClaim, IdempotentLookup, IdempotentWrite, SupportAppealStore } from '../../domain/ports.js';
import { appeal } from './schema.js';

/** 처리 중인 키를 이만큼 지나면 죽은 선점으로 보고 다시 잡는다(guidelines §4 1초 [가정]) */
const WAIT_MS = 1_000;
/** 실패한 요청의 선점 표시. UUID 결과 참조와 겹치지 않는다 */
const RELEASED = '__released__';

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

type IdemRow = { request_hash: Buffer; result_ref: string | null; created_at: Date };

export class DrizzleSupportAppealStore implements SupportAppealStore {
  constructor(private readonly db: Database) {}

  private readonly where = (i: IdempotentWrite) =>
    sql`account_ref = ${i.accountRef} and operation = ${i.operation} and idempotency_key = ${i.key}`;

  async put(a: AppealRecord, o?: { idem?: IdempotentWrite; result?: unknown }): Promise<{ replayed: boolean; result?: unknown }> {
    if (!o?.idem) {
      await this.#insert(a);
      return { replayed: false };
    }
    const claim = await this.claim(o.idem);
    if (claim.kind === 'replay') return { replayed: true, result: claim.result };
    if (claim.kind === 'reused') throw new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다' });
    if (claim.kind === 'in_progress') throw new ProblemError({ type: 'idempotency-request-in-progress', status: 409, title: '같은 요청을 아직 처리하고 있습니다', retryAfterSeconds: 1 });
    try {
      await this.finishClaim({ record: a, idem: o.idem, result: o.result });
      return { replayed: false };
    } catch (e) {
      await this.releaseClaim(o.idem).catch(() => undefined);
      throw e;
    }
  }

  async #insert(a: AppealRecord): Promise<void> {
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
    const rows = await this.db.db.execute(sql`select request_hash, result_ref, created_at from idempotency_record where ${this.where(i)} limit 1`);
    const row = rows.rows[0] as IdemRow | undefined;
    if (!row) return { kind: 'none' };
    if (!sameHash(Buffer.from(row.request_hash), Buffer.from(i.requestHash))) return { kind: 'reused' };
    if (row.result_ref === RELEASED) return { kind: 'none' };
    if (row.result_ref === null) {
      return Date.now() - new Date(row.created_at).getTime() >= WAIT_MS ? { kind: 'none' } : { kind: 'in_progress' };
    }
    const a = await this.get(row.result_ref);
    return a ? { kind: 'replay', result: appealResponse(a) } : { kind: 'none' };
  }

  async claim(i: IdempotentWrite): Promise<IdempotentClaim> {
    const now = new Date();
    const stale = new Date(now.getTime() - WAIT_MS);
    const inserted = await this.db.db.execute(sql`
      insert into idempotency_record (account_ref, operation, idempotency_key, request_hash, result_ref, created_at)
      values (${i.accountRef}, ${i.operation}, ${i.key}, ${Buffer.from(i.requestHash)}, null, ${now})
      on conflict (account_ref, operation, idempotency_key) do update
        set request_hash = excluded.request_hash, result_ref = null, created_at = excluded.created_at
        where (idempotency_record.result_ref is null and idempotency_record.created_at <= ${stale})
           or idempotency_record.result_ref = ${RELEASED}
      returning 1 as claimed`);
    if (inserted.rows.length === 1) return { kind: 'claimed' };
    const found = await this.findIdempotent(i);
    return found.kind === 'none' ? { kind: 'in_progress' } : found;
  }

  async finishClaim(o: { record: AppealRecord; idem: IdempotentWrite; result: unknown }): Promise<void> {
    await this.db.db.transaction(async (tx) => {
      await tx.insert(appeal).values({
        id: o.record.id,
        accountId: o.record.accountId,
        kind: o.record.kind,
        targetId: o.record.targetId,
        body: o.record.body,
        status: o.record.status,
        result: o.record.result,
        caseId: o.record.caseId,
        submittedAt: new Date(o.record.submittedAtMs),
        decidedAt: o.record.decidedAtMs === null ? null : new Date(o.record.decidedAtMs),
      });
      const r = await tx.execute(sql`update idempotency_record set result_ref = ${o.record.id} where ${this.where(o.idem)} and result_ref is null`);
      if ((r.rowCount ?? 0) !== 1) throw new Error('멱등 키 선점이 사라졌습니다');
    });
  }

  async releaseClaim(i: IdempotentWrite): Promise<void> {
    await this.db.db.execute(sql`update idempotency_record set result_ref = ${RELEASED} where ${this.where(i)} and result_ref is null`);
  }
}
