// F-04-13 부정 예매 이용 제한 행 저장소 Drizzle 판(ops DB booking_restriction).
// 계정별 판을 이어 올리고, 같은 사건·같은 제한만 갱신하며, 재시도는 같은 행 ID로 멱등하게 쓴다(IR-13).
import { sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { FraudRestrictionRows } from '../../domain/ports.js';

export class DrizzleFraudRestrictions implements FraudRestrictionRows {
  constructor(private readonly database: Database) {}

  async restrict(i: { accountId: string; caseId: string; restrictionId: string; version: number; untilMs: number; actedBy: string }): Promise<{ version: number }> {
    return this.database.transaction(async (tx) => {
      const existing = await tx.execute(sql`
        select id, version, status
        from booking_restriction
        where account_id = ${i.accountId}::uuid and fraud_case_id = ${i.caseId}::uuid
        order by version desc limit 1 for update
      `);
      const row = (existing as any).rows[0] as { id: string; version: string | number; status: string } | undefined;
      if (row?.status === 'ACTIVE') {
        if (row.id === i.restrictionId) {
          await tx.execute(sql`
            update booking_restriction set ends_at = ${new Date(i.untilMs)}, appeal_due_at = greatest(appeal_due_at, ${new Date(i.untilMs)}::timestamptz + interval '1 day')
            where id = ${row.id}::uuid
          `);
          return { version: Number(row.version) };
        }
        const next = Number(row.version) + 1;
        await tx.execute(sql`
          update booking_restriction set id = ${i.restrictionId}::uuid, ends_at = ${new Date(i.untilMs)},
            appeal_due_at = ${new Date(i.untilMs)}::timestamptz + interval '1 day', version = ${next}, confirmed_by = ${i.actedBy}::uuid
          where id = ${row.id}::uuid
        `);
        return { version: next };
      }
      const max = await tx.execute(sql`select coalesce(max(version), 0) as version from booking_restriction where account_id = ${i.accountId}::uuid`);
      const version = Math.max(Number((max as any).rows[0]?.version ?? 0) + 1, i.version);
      await tx.execute(sql`
        insert into booking_restriction (id, account_id, reason_code, fraud_case_id, confirmed_by, starts_at, ends_at, appeal_due_at, status, version)
        values (${i.restrictionId}::uuid, ${i.accountId}::uuid, 'FRAUD', ${i.caseId}::uuid, ${i.actedBy}::uuid, now(), ${new Date(i.untilMs)}, now() + interval '1 day', 'ACTIVE', ${version})
        on conflict (id) do update set ends_at = excluded.ends_at, appeal_due_at = excluded.appeal_due_at, status = 'ACTIVE', version = excluded.version
      `);
      return { version };
    });
  }

  async lift(i: { accountId: string; caseId: string; restrictionId: string; version: number; actedBy: string }): Promise<{ version: number }> {
    const rows = await this.database.pool.query(
      `update booking_restriction set status = 'LIFTED', version = version + 1
       where id = $1 and account_id = $2 and fraud_case_id = $3 and status = 'ACTIVE'
       returning version`,
      [i.restrictionId, i.accountId, i.caseId],
    );
    return { version: rows.rows[0] ? Number(rows.rows[0].version) : i.version };
  }

  async activeForCase(caseId: string): Promise<readonly { accountId: string; caseId: string; restrictionId: string; untilMs: number; version: number }[]> {
    const rows = await this.database.pool.query(
      "select id, account_id, fraud_case_id, ends_at, version from booking_restriction where fraud_case_id = $1 and status = 'ACTIVE' and ends_at > now() order by version",
      [caseId],
    );
    return rows.rows.map((r: any) => ({ accountId: r.account_id, caseId: r.fraud_case_id, restrictionId: r.id, untilMs: new Date(r.ends_at).getTime(), version: Number(r.version) }));
  }
}
