// Go/No-Go 판정 기록의 PostgreSQL 구현(마이그레이션 0029 ops_go_no_go_judgement, ADR-0371 결정 5).
// 판정 행과 감사 체인 GO_NO_GO_JUDGED를 한 트랜잭션에 남긴다(appendAuditIn). 같은 회차의 순번은 회차 단위 트랜잭션 잠금(pg_advisory_xact_lock) 안에서 매긴다.
import { type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { appendAuditIn } from '../../../audit/index.js';
import { GO_NO_GO_JUDGED, judgementAuditPayload, type GoNoGoJudgement, type JudgementStore, type ReadinessItem } from '../../domain/readiness.js';

interface Row {
  id: string;
  event_id: string;
  sequence: number | string;
  verdict: 'go' | 'no-go';
  failed_required: string[] | string;
  failed_recommended: string[] | string;
  recommended_reasons: Record<string, string> | string;
  items: ReadinessItem[] | string;
  judged_by_ref: string;
  judged_at: Date | string;
}

const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

const toJudgement = (r: Row): GoNoGoJudgement => ({
  judgementId: r.id,
  eventId: r.event_id,
  verdict: r.verdict,
  failedRequired: json(r.failed_required),
  failedRecommended: json(r.failed_recommended),
  recommendedReasons: json(r.recommended_reasons),
  items: json(r.items),
  judgedAtMs: new Date(r.judged_at).getTime(),
  sequence: Number(r.sequence),
  judgedByRef: r.judged_by_ref,
});

export class DrizzleJudgementStore implements JudgementStore {
  constructor(private readonly database: Database) {}

  async record(input: Omit<GoNoGoJudgement, 'sequence'>): Promise<GoNoGoJudgement> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ops_go_no_go_judgement:${input.eventId}`}))`);
      const [seqRow] = (await tx.execute(sql`select coalesce(max(sequence), 0) + 1 as next from ops_go_no_go_judgement where event_id = ${input.eventId}::uuid`)).rows as { next: number | string }[];
      const sequence = Number(seqRow?.next ?? 1);
      const rows = (
        await tx.execute(sql`
          insert into ops_go_no_go_judgement (id, event_id, sequence, verdict, failed_required, failed_recommended, recommended_reasons, items, judged_by_ref, judged_at)
          values (${input.judgementId}::uuid, ${input.eventId}::uuid, ${sequence}, ${input.verdict}, ${JSON.stringify(input.failedRequired)}::jsonb,
                  ${JSON.stringify(input.failedRecommended)}::jsonb, ${JSON.stringify(input.recommendedReasons)}::jsonb, ${JSON.stringify(input.items)}::jsonb,
                  ${input.judgedByRef}, ${new Date(input.judgedAtMs)}::timestamptz)
          returning *`)
      ).rows as unknown as Row[];
      await appendAuditIn(tx, { recordType: GO_NO_GO_JUDGED, recordId: input.judgementId, payload: judgementAuditPayload({ ...input, sequence }), nowMs: input.judgedAtMs });
      return toJudgement(rows[0]!);
    });
  }

  async last(eventId: string): Promise<GoNoGoJudgement | undefined> {
    const rows = (await this.database.db.execute(sql`select * from ops_go_no_go_judgement where event_id = ${eventId}::uuid order by sequence desc limit 1`)).rows as unknown as Row[];
    return rows[0] ? toJudgement(rows[0]) : undefined;
  }
}
