// 실제 PostgreSQL에서 마이그레이션 실행기 계약을 본다(D-T44 ②③④·D-T10, F-09-2 계획 §6).
// Docker 엔진이 필요하다. 이번 동결 로컬 턴에는 돌리지 않았고(미실행), 구현·검증 차례에 돌린다.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationClient } from '../src/migrations.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const quiet = { log: () => {} };
let container: PostgresContainer;
const dirs: string[] = [];

async function migrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'peaket-migrations-int-'));
  dirs.push(dir);
  await mkdir(join(dir, 'meta'), { recursive: true });
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, sql] of entries) await writeFile(join(dir, name), sql, 'utf8');
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries: entries.map(([name], idx) => ({ idx, tag: name.replace(/\.sql$/, ''), when: 1000 + idx })) }),
    'utf8',
  );
  return dir;
}

const clientFor = async (url = container.url): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: url, application_name: 'peaket-migration-test' });
  await client.connect();
  return client;
};
const asMigrationClient = (client: pg.Client): MigrationClient => ({
  query: async (sql: string, params?: readonly unknown[]) => client.query(sql, params as unknown[] | undefined),
});

beforeAll(async () => {
  container = await startPostgres();
});

afterAll(() => {
  container.stop();
});

beforeEach(async () => {
  const admin = await clientFor();
  await admin.query('DROP TABLE IF EXISTS a, b, hot, account, ops_migration, ticket_migration, peaket_migration CASCADE');
  await admin.query('DROP ROLE IF EXISTS peaket_ddl_test').catch(() => {});
  await admin.end();
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('마이그레이션 실행기(실제 PostgreSQL)', () => {
  it('D-T44 ② 트랜잭션 밖 표시 파일은 트랜잭션 없이 문장마다 실행한다', async () => {
    const dir = await migrations({
      '0000_a.sql': 'CREATE TABLE a (id int);',
      '0001_index.sql': '-- peaket:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);',
    });
    const client = await clientFor();
    try {
      const result = await runMigrations({ client: asMigrationClient(client), dir, ...quiet });
      expect(result.applied).toEqual(['0000_a.sql', '0001_index.sql']);
      const index = await client.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'a_idx'");
      expect(index.rowCount).toBe(1);
      const ledger = await client.query('SELECT name FROM peaket_migration ORDER BY name');
      expect(ledger.rows.map((r) => r.name)).toEqual(['0000_a.sql', '0001_index.sql']);
    } finally {
      await client.end();
    }
  });

  it('D-T44 ③ 다른 트랜잭션이 표를 잡고 있으면 3초 뒤 물러나 5회 다시 시도한 뒤 실패한다', async () => {
    const setup = await clientFor();
    await setup.query('CREATE TABLE hot (id int)');
    await setup.end();
    const dir = await migrations({ '0000_hot.sql': 'ALTER TABLE hot ADD COLUMN c int;' });
    const blocker = await clientFor();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE hot IN ACCESS EXCLUSIVE MODE');
    const client = await clientFor();
    try {
      await expect(
        runMigrations({ client: asMigrationClient(client), dir, lockTimeoutMs: 200, maxLockRetries: 2, ...quiet }),
      ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
      const ledger = await client.query("SELECT to_regclass('public.peaket_migration') AS t");
      expect(ledger.rows[0]?.t).toBe('peaket_migration');
      const rows = await client.query('SELECT name FROM peaket_migration');
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.end();
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
    const retry = await clientFor();
    try {
      const result = await runMigrations({ client: asMigrationClient(retry), dir, ...quiet });
      expect(result.applied).toEqual(['0000_hot.sql']);
    } finally {
      await retry.end();
    }
  });

  it('D-T44 ④ 같은 DB의 두 실행은 하나만 돌고 다른 하나는 기다리거나 실패한다', async () => {
    const dir = await migrations({ '0000_slow.sql': 'SELECT pg_sleep(0.4);\nCREATE TABLE b (id int);' });
    const one = await clientFor();
    const two = await clientFor();
    try {
      const results = await Promise.allSettled([
        runMigrations({ client: asMigrationClient(one), dir, lockTimeoutMs: 100, maxLockRetries: 5, ...quiet }),
        runMigrations({ client: asMigrationClient(two), dir, lockTimeoutMs: 100, maxLockRetries: 5, ...quiet }),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      const check = await clientFor();
      try {
        const rows = await check.query('SELECT name FROM peaket_migration');
        expect(rows.rows.map((r) => r.name)).toEqual(['0000_slow.sql']);
      } finally {
        await check.end();
      }
      const rejected = results.filter((r) => r.status === 'rejected');
      for (const r of rejected) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'LOCK_BUSY' });
    } finally {
      await one.end();
      await two.end();
    }
  });

  it('D-T10 긴 트랜잭션이 표를 잡고 있으면 마이그레이션이 실패하고 롤아웃이 시작되지 않는다', async () => {
    const setup = await clientFor();
    await setup.query('CREATE TABLE hot (id int)');
    await setup.end();
    const dir = await migrations({ '0000_hot.sql': 'ALTER TABLE hot ADD COLUMN c int;' });
    const blocker = await clientFor();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE hot IN ACCESS EXCLUSIVE MODE');
    const client = await clientFor();
    try {
      await expect(
        runMigrations({ client: asMigrationClient(client), dir, lockTimeoutMs: 200, maxLockRetries: 2, ...quiet }),
      ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
      const rows = await client.query('SELECT name FROM peaket_migration');
      expect(rows.rowCount).toBe(0);
      const column = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'hot' AND column_name = 'c'",
      );
      expect(column.rowCount).toBe(0);
    } finally {
      await client.end();
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
  });

  it('D-T10 statement_timeout 57014은 다시 시도하지 않고 STATEMENT_TIMEOUT이다', async () => {
    const dir = await migrations({ '0000_slow.sql': 'SELECT pg_sleep(1);' });
    const client = await clientFor();
    try {
      await expect(
        runMigrations({ client: asMigrationClient(client), dir, statementTimeoutMs: 100, ...quiet }),
      ).rejects.toMatchObject({ code: 'STATEMENT_TIMEOUT' });
      const rows = await client.query('SELECT name FROM peaket_migration');
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('D-T8 확장 뒤 N-1 앱 질의가 동작한다', async () => {
    const setup = await clientFor();
    await setup.query('CREATE TABLE account (id int PRIMARY KEY, email text NOT NULL)');
    await setup.query("INSERT INTO account (id, email) VALUES (1, 'a@example.com')");
    await setup.end();
    const dir = await migrations({ '0000_expand.sql': 'ALTER TABLE account ADD COLUMN nickname text;' });
    const client = await clientFor();
    try {
      await runMigrations({ client: asMigrationClient(client), dir, ...quiet });
      const oldRead = await client.query('SELECT id, email FROM account WHERE email = $1', ['a@example.com']);
      expect(oldRead.rows).toEqual([{ id: 1, email: 'a@example.com' }]);
      await client.query("INSERT INTO account (id, email) VALUES (2, 'b@example.com')");
      const count = await client.query('SELECT count(*)::int AS n FROM account');
      expect(count.rows[0]?.n).toBe(2);
    } finally {
      await client.end();
    }
  });

  it('D-T44 ⑤ DDL 역할로 직접 붙어 마이그레이션한다', async () => {
    const admin = await clientFor();
    await admin.query("CREATE ROLE peaket_ddl_test LOGIN PASSWORD 'peaket-test'");
    await admin.query('GRANT CREATE, USAGE ON SCHEMA public TO peaket_ddl_test');
    await admin.end();
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const client = await clientFor(container.urlFor('peaket_ddl_test', 'peaket-test'));
    try {
      const result = await runMigrations({ client: asMigrationClient(client), dir, ...quiet });
      expect(result.applied).toEqual(['0000_a.sql']);
      const me = await client.query('SELECT current_user AS user');
      expect(me.rows[0]?.user).toBe('peaket_ddl_test');
    } finally {
      await client.end();
      const cleanup = await clientFor();
      await cleanup.query('DROP OWNED BY peaket_ddl_test').catch(() => {});
      await cleanup.query('DROP ROLE IF EXISTS peaket_ddl_test').catch(() => {});
      await cleanup.end();
    }
  });

  it('D-T44 기존 ops_migration 기록이 있는 DB를 peaket_migration으로 이관한다', async () => {
    const setup = await clientFor();
    await setup.query('CREATE TABLE ops_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await setup.query("INSERT INTO ops_migration (name) VALUES ('0000_a.sql')");
    await setup.end();
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const client = await clientFor();
    try {
      const result = await runMigrations({
        client: asMigrationClient(client),
        dir,
        legacy: { table: 'ops_migration', kind: 'name' },
        ...quiet,
      });
      expect(result.adopted).toEqual(['0000_a.sql']);
      expect(result.applied).toEqual([]);
      const a = await client.query("SELECT to_regclass('public.a') AS t");
      expect(a.rows[0]?.t).toBeNull();
      const ledger = await client.query('SELECT name FROM peaket_migration');
      expect(ledger.rows.map((r) => r.name)).toEqual(['0000_a.sql']);
    } finally {
      await client.end();
    }
  });

  it('드라이런은 빈 DB에 기록 표를 만들지 않는다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const client = await clientFor();
    try {
      const result = await runMigrations({ client: asMigrationClient(client), dir, dryRun: true, ...quiet });
      expect(result.pending).toEqual(['0000_a.sql']);
      const table = await client.query("SELECT to_regclass('public.peaket_migration') AS t");
      expect(table.rows[0]?.t).toBeNull();
      const a = await client.query("SELECT to_regclass('public.a') AS t");
      expect(a.rows[0]?.t).toBeNull();
    } finally {
      await client.end();
    }
  });
});
