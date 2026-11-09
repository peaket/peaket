// 통합 시험의 DB 로그인 사용자(ADR-0241). 마이그레이션이 만든 그룹 역할(core_app·core_partner)에 시험용 로그인 사용자를 넣어, 운영과 같은 권한으로 접속한다.
import { createDatabase, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PostgresContainer } from './postgres.js';

export async function loginFor(admin: Database, pg: PostgresContainer, user: string, role: 'core_app' | 'core_partner', max: number): Promise<Database> {
  const password = 'peaket-test';
  await admin.db.execute(sql.raw(`CREATE USER ${user} PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER; GRANT ${role} TO ${user}`));
  return createDatabase({ url: pg.urlFor(user, password), applicationName: `core-svc-${role}`, max });
}
