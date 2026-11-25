// 부정 예매 조치 승인자 지정·최근 거둠 조회. identity-svc 지정과 ops 감사 체인의 거둠 기록을 함께 본다(IR-01·IR-19).
import type { Database } from '@peaket/platform';
import type { AdminIdentity } from '../../admin-accounts/index.js';
import type { FraudApproverDirectory, FraudApproverIdentity } from '../domain/ports.js';

export class AuditFraudApproverIdentity implements FraudApproverIdentity {
  constructor(private readonly o: { identity: Pick<AdminIdentity, 'designations'>; database: Database }) {}

  async designations(adminAccountId: string): Promise<readonly string[]> {
    return this.o.identity.designations(adminAccountId);
  }

  async recentlyRevoked(adminAccountId: string): Promise<readonly { kind: string; revokedAtMs: number }[]> {
    const rows = await this.o.database.pool.query(
      `select record_json->'payload'->>'designationKind' as kind, (extract(epoch from created_at) * 1000)::bigint as revoked_at_ms
       from audit_chain
       where record_type = 'ADMIN_ACCOUNT_DESIGNATION_REVOKED'
         and record_id = $1::uuid
         and record_json->'payload'->>'status' = 'SUCCEEDED'
         and created_at > now() - interval '90 days'
       order by created_at desc`,
      [adminAccountId],
    );
    return rows.rows
      .filter((r: any) => typeof r.kind === 'string')
      .map((r: any) => ({ kind: r.kind, revokedAtMs: Number(r.revoked_at_ms) }));
  }
}

export class AdminFraudApproverDirectory implements FraudApproverDirectory {
  constructor(private readonly identity: Pick<AdminIdentity, 'list' | 'designations'>) {}

  async listEligible(): Promise<readonly string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.identity.list({ group: 'OPS', limit: 100, ...(cursor ? { cursor } : {}) });
      for (const a of page.items) {
        if (a.role !== 'commander' || a.status !== 'ACTIVE') continue;
        const designations = await this.identity.designations(a.adminAccountId);
        if (designations.includes('PSEUDONYM_HANDLER')) continue;
        out.push(a.adminAccountId);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return out;
  }
}
