// core-svc DB 마이그레이션(BAS-060, F-09-2). 공용 실행기(@peaket/platform/migrations)를 부른다.
// 운영 실행은 ArgoCD PreSync Job이 같은 이미지의 이 파일을 부른다. DDL·정비 역할 주소는 PEAKET_MIGRATION_DATABASE_URL·PEAKET_MAINTENANCE_DATABASE_URL로만 받는다.
// 쓰는 법: PEAKET_MIGRATION_DATABASE_URL=postgres://... node scripts/migrate.mjs
import { fileURLToPath } from 'node:url';
import { createDatabase, ensureOutboxPartitions, ensureMonthlyPartitions, systemClock } from '@peaket/platform';
import { assertDirectDatabaseUrl, runMigrations } from '@peaket/platform/migrations';
import pg from 'pg';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * 마이그레이션을 적용한다(시험도 이 함수를 쓴다)
 * @param {string} databaseUrl
 */
export async function migrateCore(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'core-svc-migrate' });
  await client.connect();
  try {
    return await runMigrations({
      client,
      dir: MIGRATIONS,
      legacy: { table: 'drizzle.__drizzle_migrations', kind: 'drizzle' },
      afterMigrate: async () => {
        const database = createDatabase({
          url: process.env.PEAKET_MAINTENANCE_DATABASE_URL ?? databaseUrl,
          applicationName: 'core-svc-migrate-hooks',
          max: 1,
        });
        try {
      const { created } = await ensureOutboxPartitions(database, systemClock);
      console.log(`Outbox 파티션 ${created.length}개를 만들었다`);
      const notify = await ensureMonthlyPartitions(database, systemClock, { table: 'notification_delivery', key: 'timestamptz' });
      console.log(`알림 발송 기록 파티션 ${notify.created.length}개를 만들었다`);
        } finally {
          await database.close();
        }
      },
      log: (line) => console.log(line),
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.PEAKET_MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('PEAKET_MIGRATION_DATABASE_URL이 없다');
    process.exit(2);
  }
  const env = process.env.PEAKET_ENV ?? '';
  assertDirectDatabaseUrl(url, { requireTls: !['local', 'ci'].includes(env) });
  const result = await migrateCore(url);
  console.log(`core-svc 마이그레이션 끝(${result.applied.length}개 적용, ${result.adopted.length}개 이관)`);
}
