// ticket-svc DB 마이그레이션(로컬·시험 실행용). migrations/*.sql을 이름 순으로 한 번씩 적용하고
// ticket_migration 표에 적용 이름을 남긴다. 운영 실행은 트랜잭션 안의 스키마·인덱스·제약·파티션
// 마이그레이션(BUILD_ORDER BAS-060)이다(ADR-0037 결정 6).
// 실행: PEAKET_DATABASE_URL=postgres://... node scripts/migrate.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * 마이그레이션을 적용한다(시험에서도 부를 수 있다). 이미 적용한 이름은 건너뛴다.
 * @param {string} databaseUrl
 * @returns {Promise<string[]>} 이번에 적용한 이름
 */
export async function migrateTicket(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied = [];
  try {
    await client.query('CREATE TABLE IF NOT EXISTS ticket_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const names = readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith('.sql'))
      .sort();
    for (const name of names) {
      const seen = await client.query('SELECT 1 FROM ticket_migration WHERE name = $1', [name]);
      if (seen.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(`${MIGRATIONS}/${name}`, 'utf8'));
        await client.query('INSERT INTO ticket_migration (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.PEAKET_DATABASE_URL;
  if (!url) {
    console.error('PEAKET_DATABASE_URL이 없다');
    process.exit(2);
  }
  const applied = await migrateTicket(url);
  console.log(`ticket 마이그레이션 끝(${applied.length}개 적용)`);
}
