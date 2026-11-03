// v0 모놀리스 DB 마이그레이션(Drizzle 마이그레이터, Node.js 네이티브). 로컬·시험 실행용이다.
// 운영 실행기(트랜잭션 밖 단계·잠금 대기 제한·실행 잠금)는 BUILD_ORDER BAS-060이다(ADR-0037 결정 6, ADR-0083).
// 쓰는 법: PEAKET_V0_DATABASE_URL=postgres://… node scripts/migrate.mjs
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * 마이그레이션을 적용한다(시험도 이 함수를 쓴다)
 * @param {string} databaseUrl
 */
export async function migrateV0(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.PEAKET_V0_DATABASE_URL;
  if (!url) {
    console.error('PEAKET_V0_DATABASE_URL이 없다');
    process.exit(2);
  }
  await migrateV0(url);
  console.log('v0 마이그레이션 끝');
}
