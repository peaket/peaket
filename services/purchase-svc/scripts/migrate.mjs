// purchase-svc DB 마이그레이션(Drizzle 마이그레이터, Node.js 네이티브). 로컬·시험 실행용이다.
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
export async function migratePurchase(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
  } finally {
    await client.end();
  }
}

/**
 * 마이그레이션 직후 seat_hold의 월 파티션(이번 달부터 3개월 [가정] 앞)을 만든다. 첫 쓰기가 파티션 없이 실패하지 않게 한다.
 * 운영 실행기와 매일 정비 잡의 같은 일은 BUILD_ORDER BAS-060·wbs 2.11이다
 * @param {string} databaseUrl
 * @returns {Promise<string[]>} 새로 만든 파티션 이름
 */
export async function ensureSeatHoldPartitions(databaseUrl) {
  const { createDatabase, ensureMonthlyPartitions, systemClock } = await import('@peaket/platform');
  const database = createDatabase({ url: databaseUrl, applicationName: 'purchase-svc-migrate', max: 1 });
  try {
    const { created } = await ensureMonthlyPartitions(database, systemClock, { table: 'seat_hold', key: 'uuidv7' });
    return created;
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.PEAKET_DATABASE_URL;
  if (!url) {
    console.error('PEAKET_DATABASE_URL이 없다');
    process.exit(2);
  }
  await migratePurchase(url);
  const created = await ensureSeatHoldPartitions(url);
  console.log(`seat_hold 파티션 ${created.length}개를 만들었다`);
  console.log('purchase 마이그레이션 끝');
}
