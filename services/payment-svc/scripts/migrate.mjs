// payment-svc DB 마이그레이션(Drizzle 마이그레이터, Node.js 네이티브). 로컬·시험 실행용이다.
// 운영 실행기(트랜잭션 밖 단계·잠금 대기 제한·실행 잠금)는 BUILD_ORDER BAS-060이다(ADR-0037 결정 6, ADR-0083).
// 쓰는 법: PEAKET_DATABASE_URL=postgres://… node scripts/migrate.mjs
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * 마이그레이션을 적용한다(시험도 이 함수를 쓴다)
 * @param {string} databaseUrl
 */
export async function migratePayment(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.PEAKET_DATABASE_URL;
  if (!url) {
    console.error('PEAKET_DATABASE_URL이 없다');
    process.exit(2);
  }
  await migratePayment(url);
  // 마이그레이션 직후 Outbox 일 파티션을 만든다(첫 쓰기가 파티션 없이 실패하지 않게). 운영 실행기의 같은 일은 BUILD_ORDER BAS-060이다
  const { createDatabase, ensureOutboxPartitions, systemClock } = await import('@peaket/platform');
  const database = createDatabase({ url, applicationName: 'payment-svc-migrate', max: 1 });
  try {
    const { created } = await ensureOutboxPartitions(database, systemClock);
    console.log(`Outbox 파티션 ${created.length}개를 만들었다`);
  } finally {
    await database.close();
  }
  console.log('payment 마이그레이션 끝');
}
