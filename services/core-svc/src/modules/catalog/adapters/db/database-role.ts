// 서비스 시작 때 접속 사용자의 DB 역할을 확인한다(ADR-0241, docs/security/authz-matrix.md §5.3). 소유자·슈퍼유저이거나 역할을 겸하면 행 보안이 조용히 꺼져서다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';

export type ServiceDbRole = 'core_app' | 'core_partner' | 'core_ops' | 'core_maintenance';

const ROLES: readonly ServiceDbRole[] = ['core_app', 'core_partner', 'core_ops', 'core_maintenance'];

interface RoleFacts {
  member: boolean;
  other: boolean;
  privileged: boolean;
  owner: boolean;
}

/** 이 연결의 사용자가 그 역할 하나만 가졌고 행 보안의 대상인지 본다. 아니면 던진다 */
export async function assertDatabaseRole(database: Database, role: ServiceDbRole): Promise<void> {
  const others = ROLES.filter((r) => r !== role);
  const r = await database.db.execute(sql`
    select
      pg_has_role(current_user, ${role}, 'member') as member,
      (${sql.join(others.map((o) => sql`pg_has_role(current_user, ${o}, 'member')`), sql` or `)}) as other,
      (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as privileged,
      exists (select 1 from pg_class c where c.relname in ('production', 'event') and c.relkind = 'r' and pg_has_role(current_user, c.relowner, 'member')) as owner
  `);
  const f = (r.rows as unknown as RoleFacts[])[0];
  if (!f || f.privileged || f.owner) throw new Error(`DB 사용자가 슈퍼유저이거나 표 소유자라 행 보안이 걸리지 않는다(${role}로 접속해야 한다)`);
  if (!f.member) throw new Error(`DB 사용자가 ${role} 역할이 아니다`);
  if (f.other) throw new Error(`DB 사용자가 ${others.join('·')} 역할을 함께 가져 행 보안 정책이 합쳐진다`);
}
