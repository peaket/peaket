// 통합 시험의 DB 로그인 사용자(ADR-0241). 마이그레이션이 만든 그룹 역할(core_app·core_partner·core_notify 등)에 시험용 로그인 사용자를 넣어, 운영과 같은 권한으로 접속한다.
import { createDatabase, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PostgresContainer } from './postgres.js';

export async function loginFor(admin: Database, pg: PostgresContainer, user: string, role: 'core_app' | 'core_partner' | 'core_ops' | 'core_maintenance' | 'core_search' | 'core_notify', max: number): Promise<Database> {
  const password = 'peaket-test';
  await admin.db.execute(sql.raw(`CREATE USER ${user} PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER; GRANT ${role} TO ${user}`));
  return createDatabase({ url: pg.urlFor(user, password), applicationName: `core-svc-${role}`, max });
}

/**
 * 검색 전용 연결의 로그인 사용자(그룹 역할 core_search, 리뷰 W7L2-S6·ADR-0271 결정 18). 여러 번 불러도 한 번만 만든다. 그 주소를 돌려준다.
 * main.ts를 띄우는 시험은 PEAKET_SEARCH_DATABASE_URL에 이 주소를 준다
 */
export async function ensureSearchLogin(admin: Database, pg: PostgresContainer): Promise<string> {
  const user = 'core_search_login';
  const password = 'peaket-test';
  const exists = (await admin.pool.query('select 1 from pg_roles where rolname = $1', [user])).rows.length > 0;
  if (!exists) await admin.db.execute(sql.raw(`CREATE USER ${user} PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER; GRANT core_search TO ${user}`));
  return pg.urlFor(user, password);
}
