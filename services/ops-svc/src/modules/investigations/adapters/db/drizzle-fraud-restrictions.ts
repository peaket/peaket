// F-04-13 부정 예매 이용 제한 행 저장소 Drizzle 판(ops DB booking_restriction).
import { sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { FraudRestrictionRows } from '../../domain/ports.js';

export class DrizzleFraudRestrictions implements FraudRestrictionRows {
  constructor(private readonly database: Database) {}

  async restrict(i: { accountId: string; caseId: string; restrictionId: string; version: number; untilMs: number; actedBy: string }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`update booking_restriction set status = 'LIFTED' where account_id = ${i.accountId}::uuid and status = 'ACTIVE'`);
      await tx.execute(sql`
        insert into booking_restriction (id, account_id, reason_code, fraud_case_id, confirmed_by, starts_at, ends_at, appeal_due_at, status, version)
        values (${i.restrictionId}::uuid, ${i.accountId}::uuid, 'FRAUD', ${i.caseId}::uuid, ${i.actedBy}::uuid, now(), ${new Date(i.untilMs)}, now(), 'ACTIVE', ${i.version})
      `);
    });
  }

  async lift(i: { accountId: string; caseId: string; restrictionId: string; version: number; actedBy: string }): Promise<void> {
    await this.database.pool.query(
      "update booking_restriction set status = 'LIFTED', version = $2 where id = $1 and account_id = $3 and fraud_case_id = $4",
      [i.restrictionId, i.version, i.accountId, i.caseId],
    );
  }

  async activeForCase(caseId: string): Promise<readonly { accountId: string; caseId: string; restrictionId: string; untilMs: number; version: number }[]> {
    const rows = await this.database.pool.query(
      "select id, account_id, fraud_case_id, ends_at, version from booking_restriction where fraud_case_id = $1 and status = 'ACTIVE' order by version",
      [caseId],
    );
    return rows.rows.map((r: any) => ({ accountId: r.account_id, caseId: r.fraud_case_id, restrictionId: r.id, untilMs: new Date(r.ends_at).getTime(), version: Number(r.version) }));
  }
}
