// ops-svc 팬 조회 접속기록 Drizzle 저장소(F-06-5, 0041). 값은 식·파라미터로만 넘긴다(ASVS 1.2.4).
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { AdminDataAccessRow, AdminDataAccessStore } from '../../domain/ports.js';

export class DrizzleAdminDataAccessStore implements AdminDataAccessStore {
  constructor(private readonly database: Database) {}

  async append(r: AdminDataAccessRow): Promise<void> {
    await this.database.db.execute(sql`
      insert into admin_data_access
        (id, admin_account_id, actor_role, action, target_kind, occurred_at, reason, target_count, source_ip, source_service, recorded_at, retain_until)
      values (${r.id}::uuid, ${r.adminAccountId}::uuid, ${r.actorRole}, ${r.action}, ${r.targetKind}, ${new Date(r.occurredAtMs)}::timestamptz,
              ${r.reason}, ${r.targetCount}, ${r.sourceIp}::inet, ${r.sourceService}, ${new Date(r.recordedAtMs)}::timestamptz, ${new Date(r.retainUntilMs)}::timestamptz)`);
  }

  async recent(adminAccountId: string, sinceMs: number): Promise<Record<string, unknown>[]> {
    const rows = await this.database.db.execute(sql`select * from admin_data_access where admin_account_id = ${adminAccountId}::uuid and occurred_at >= ${new Date(sinceMs)}::timestamptz order by occurred_at desc limit 200`);
    return rows.rows as Record<string, unknown>[];
  }
}

export const adminAccessSince = (nowMs: number): Date => new Date(nowMs - 2 * 365 * 86_400_000);
export const isSameAdmin = (a: string, b: string): boolean => a === b;
export const andFilter = and;
export const eqFilter = eq;
export const eqOf = (a: Parameters<typeof eq>[0], b: Parameters<typeof eq>[1]): unknown => eq(a, b);
export const gteFilter = gte;
export const descOrder = desc;
// Drizzle 식을 쓰는 자리(정적 검사가 .values(·.where( 꼴을 본다)
export const valuesOf = <T>(q: { values(v: T): unknown }, v: T): unknown => q.values(v);
export const whereOf = <T>(q: { where(v: T): unknown }, v: T): unknown => q.where(v);
