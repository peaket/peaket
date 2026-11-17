// ops-svc 파트너 풀의 DB 역할 시작 검사(W9-fix3 F1, docs/security/authz-matrix.md §5.3 'ops-svc 구현' 끝 '시작 검사').
// 파트너 회차 취소 경로는 행 보안이 2차 방어라, 접속 사용자가 표 소유자·슈퍼유저·BYPASSRLS이거나 ops_app을 겸하면 정책이 조용히 꺼지거나 합쳐진다.
// core-svc의 같은 검사(modules/catalog/adapters/db/database-role.ts, ADR-0241)와 같은 꼴로 SQL 한 번에 본다. 관제 풀(ops_app) 검사는 이 묶음 범위 밖이다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';

const ROLE = 'ops_partner';
const OTHER = 'ops_app';
/** 파트너 경로가 행 보안으로 읽고 쓰는 표(소유자면 행 보안이 걸리지 않는다) */
const TABLE = 'event_cancellation_request';

interface RoleFacts {
  member: boolean;
  other: boolean;
  privileged: boolean;
  owner: boolean;
}

/** 파트너 풀의 접속 사용자가 ops_partner이고 ops_app을 겸하지 않으며 특권·표 소유자가 아닌지 본다. 어긋나면 던진다 */
export async function assertOpsPartnerRole(database: Database): Promise<void> {
  const r = await database.db.execute(sql`
    select
      pg_has_role(current_user, ${ROLE}, 'member') as member,
      pg_has_role(current_user, ${OTHER}, 'member') as other,
      (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as privileged,
      exists (select 1 from pg_class c where c.relname = ${TABLE} and c.relkind = 'r' and pg_has_role(current_user, c.relowner, 'member')) as owner
  `);
  const f = (r.rows as unknown as RoleFacts[])[0];
  if (!f || f.privileged) throw new Error(`DB 사용자가 슈퍼유저이거나 BYPASSRLS라 행 보안이 걸리지 않는다(${ROLE}로 접속해야 한다)`);
  if (f.owner) throw new Error(`DB 사용자가 ${TABLE} 표 소유자(소유 역할의 구성원 포함)라 행 보안이 걸리지 않는다(${ROLE}로 접속해야 한다)`);
  if (!f.member) throw new Error(`DB 사용자가 ${ROLE} 역할이 아니다`);
  if (f.other) throw new Error(`DB 사용자가 ${OTHER} 역할을 함께 가져 행 보안 정책이 합쳐진다`);
}
