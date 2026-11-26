// 마이그레이션 공용 실행기 계약 시험(docs/devops.md §7.2, D-T44 ①~⑤·D-T10, F-09-2 계획 §5).
// 실제 DB 없이 가짜 연결로 순서·트랜잭션·잠금·드라이런·체크섬을 본다. 실제 PostgreSQL 판은 test-int/migrations.int.test.ts다.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertDirectDatabaseUrl,
  MigrationError,
  planMigrations,
  readMigrationFiles,
  runMigrations,
  type MigrationClient,
  type MigrationQueryResult,
} from '../src/migrations.js';

type Call = { sql: string; params?: readonly unknown[] };
type SharedLock = { owner: string | null };

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

class FakeClient implements MigrationClient {
  readonly calls: Call[] = [];
  ledger = new Map<string, string>();
  fail: { matcher: RegExp; code: string; times: number }[] = [];

  constructor(
    private readonly lock: SharedLock,
    private readonly id: string,
  ) {}

  async query(sql: string, params?: readonly unknown[]): Promise<MigrationQueryResult> {
    this.calls.push({ sql, params });
    const failure = this.fail.find((f) => f.times > 0 && f.matcher.test(sql));
    if (failure) {
      failure.times -= 1;
      const error = new Error(failure.code) as Error & { code: string };
      error.code = failure.code;
      throw error;
    }
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select pg_try_advisory_lock')) {
      if (this.lock.owner === null) {
        this.lock.owner = this.id;
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      return { rows: [{ locked: false }], rowCount: 1 };
    }
    if (normalized.startsWith('select pg_advisory_unlock')) {
      if (this.lock.owner === this.id) this.lock.owner = null;
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    if (normalized.startsWith('create table if not exists peaket_migration')) {
      return { rows: [], rowCount: null };
    }
    if (normalized.startsWith('select name, checksum from peaket_migration')) {
      return {
        rows: [...this.ledger.entries()].map(([name, checksum]) => ({ name, checksum })),
        rowCount: this.ledger.size,
      };
    }
    if (normalized.startsWith('insert into peaket_migration')) {
      const [name, checksum] = params as readonly [string, string];
      this.ledger.set(name, checksum);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  sqlCalls(): string[] {
    return this.calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
  }
}

const dirs: string[] = [];
async function migrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'peaket-migrations-'));
  dirs.push(dir);
  await mkdir(join(dir, 'meta'), { recursive: true });
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, sql] of entries) await writeFile(join(dir, name), sql, 'utf8');
  const journal = { version: '7', dialect: 'postgresql', entries: entries.map(([name], idx) => ({ idx, tag: name.replace(/\.sql$/, '') })) };
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal), 'utf8');
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const quiet = { log: () => {} };

describe('마이그레이션 실행기', () => {
  it('D-T44 ① 파일마다 트랜잭션을 건다', async () => {
    const dir = await migrations({
      '0000_a.sql': 'CREATE TABLE a (id int);',
      '0001_b.sql': 'CREATE TABLE b (id int);',
    });
    const client = new FakeClient({ owner: null }, 'one');
    const result = await runMigrations({ client, dir, ...quiet });

    expect(result.applied).toEqual(['0000_a.sql', '0001_b.sql']);
    const sql = client.sqlCalls();
    const firstBegin = sql.indexOf('BEGIN');
    const firstA = sql.findIndex((s) => s.includes('CREATE TABLE a'));
    const firstInsertA = sql.findIndex((s) => s.startsWith('INSERT INTO peaket_migration') && s.includes('$1'));
    const firstCommit = sql.indexOf('COMMIT');
    const secondBegin = sql.indexOf('BEGIN', firstCommit + 1);
    const firstB = sql.findIndex((s) => s.includes('CREATE TABLE b'));
    expect(firstBegin).toBeGreaterThanOrEqual(0);
    expect(firstBegin).toBeLessThan(firstA);
    expect(firstA).toBeLessThan(firstCommit);
    expect(firstInsertA).toBeGreaterThan(firstA);
    expect(firstInsertA).toBeLessThan(firstCommit);
    expect(secondBegin).toBeGreaterThan(firstCommit);
    expect(secondBegin).toBeLessThan(firstB);
    expect(client.ledger.size).toBe(2);
  });

  it('D-T44 ② 트랜잭션 밖 표시 파일은 트랜잭션 없이 문장마다 실행한다', async () => {
    const dir = await migrations({
      '0000_index.sql': [
        '-- peaket:no-transaction',
        'CREATE INDEX CONCURRENTLY a_idx ON a (id);--> statement-breakpoint',
        'CREATE INDEX CONCURRENTLY b_idx ON b (id);',
      ].join('\n'),
    });
    const client = new FakeClient({ owner: null }, 'one');
    const result = await runMigrations({ client, dir, ...quiet });

    expect(result.applied).toEqual(['0000_index.sql']);
    const sql = client.sqlCalls();
    expect(sql).not.toContain('BEGIN');
    expect(sql).not.toContain('COMMIT');
    expect(sql.filter((s) => s.startsWith('CREATE INDEX CONCURRENTLY'))).toHaveLength(2);
    expect(sql.some((s) => s.includes('lock_timeout'))).toBe(true);
    expect(client.ledger.size).toBe(1);
  });

  it('D-T44 ③ 잠금을 못 얻으면 3초 뒤 물러나 5회 다시 시도한 뒤 실패한다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const lock: SharedLock = { owner: 'other' };
    const client = new FakeClient(lock, 'me');
    const sleep = vi.fn(async () => {});
    const started = Date.now();
    await expect(
      runMigrations({ client, dir, sleep, lockTimeoutMs: 3000, maxLockRetries: 5, ...quiet }),
    ).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    expect(client.sqlCalls().filter((s) => s.startsWith('SELECT pg_try_advisory_lock'))).toHaveLength(6);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400, 800, 1600]);
    expect(client.ledger.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('D-T44 ④ 같은 DB의 두 실행은 하나만 돌고 다른 하나는 기다리거나 실패한다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const lock: SharedLock = { owner: null };
    const first = new FakeClient(lock, 'first');
    const second = new FakeClient(lock, 'second');
    const [a, b] = await Promise.allSettled([
      runMigrations({ client: first, dir, ...quiet }),
      runMigrations({ client: second, dir, sleep: async () => {}, ...quiet }),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'LOCK_BUSY' });
    expect(first.ledger.size + second.ledger.size).toBe(1);
  });

  it('D-T44 ⑤ PgBouncer 주소를 거절한다', () => {
    expect(() => assertDirectDatabaseUrl('postgres://peaket@db-pgbouncer:6432/purchase')).toThrow(MigrationError);
    expect(() => assertDirectDatabaseUrl('postgres://peaket@db.example:5432/purchase?pgbouncer=true')).toThrow(MigrationError);
    expect(() => assertDirectDatabaseUrl('postgres://peaket@db.example:5432/purchase?sslmode=verify-full')).not.toThrow();
  });

  it('D-T10 잠금이 안 풀리면 3초·5회 뒤 실패하고 기록·COMMIT이 없다', async () => {
    const dir = await migrations({ '0000_hot.sql': 'ALTER TABLE hot ADD COLUMN c int;' });
    const client = new FakeClient({ owner: null }, 'one');
    client.fail.push({ matcher: /ALTER TABLE hot/, code: '55P03', times: 6 });
    const sleep = vi.fn(async () => {});
    await expect(
      runMigrations({ client, dir, sleep, lockTimeoutMs: 3000, maxLockRetries: 5, ...quiet }),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(client.sqlCalls().filter((s) => s.includes('ALTER TABLE hot'))).toHaveLength(6);
    expect(client.sqlCalls()).not.toContain('COMMIT');
    expect(client.ledger.size).toBe(0);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400, 800, 1600]);
  });

  it('D-T10 잠금이 풀리면 다시 시도한 뒤 적용한다', async () => {
    const dir = await migrations({ '0000_hot.sql': 'ALTER TABLE hot ADD COLUMN c int;' });
    const client = new FakeClient({ owner: null }, 'one');
    client.fail.push({ matcher: /ALTER TABLE hot/, code: '55P03', times: 2 });
    const sleep = vi.fn(async () => {});
    const result = await runMigrations({ client, dir, sleep, ...quiet });
    expect(result.applied).toEqual(['0000_hot.sql']);
    expect(client.sqlCalls().filter((s) => s.includes('ALTER TABLE hot'))).toHaveLength(3);
    expect(client.sqlCalls()).toContain('COMMIT');
    expect(client.ledger.size).toBe(1);
  });

  it('D-T9 트랜잭션 밖 표시는 첫 줄에만 인정한다', async () => {
    const dir = await migrations({
      '0000_late.sql': '-- 설명\n-- peaket:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);',
    });
    const files = await readMigrationFiles(dir);
    expect(files[0]?.noTransaction).toBe(false);
  });

  it('D-T9 .down.sql은 받지 않는다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);', '0000_a.down.sql': 'DROP TABLE a;' });
    await expect(readMigrationFiles(dir)).rejects.toMatchObject({ code: 'DOWN_NOT_SUPPORTED' });
  });

  it('D-T9 같은 번호의 파일 둘은 거절한다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);', '0000_b.sql': 'CREATE TABLE b (id int);' });
    await expect(readMigrationFiles(dir)).rejects.toMatchObject({ code: 'DUPLICATE_NUMBER' });
  });

  it('적용한 파일의 체크섬이 다르면 멈춘다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const client = new FakeClient({ owner: null }, 'one');
    client.ledger.set('0000_a.sql', sha256('다른 파일'));
    await expect(runMigrations({ client, dir, ...quiet })).rejects.toMatchObject({ code: 'CHECKSUM_DRIFT' });
    expect(client.sqlCalls()).not.toContain('BEGIN');
  });

  it('DB에만 있는 적용 기록은 멈춘다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const client = new FakeClient({ owner: null }, 'one');
    client.ledger.set('0000_old.sql', sha256('old'));
    await expect(runMigrations({ client, dir, ...quiet })).rejects.toMatchObject({ code: 'UNKNOWN_APPLIED' });
  });

  it('드라이런은 연결 없이 순서만 보여 주고 아무것도 쓰지 않는다', async () => {
    const dir = await migrations({
      '0000_a.sql': 'CREATE TABLE a (id int);',
      '0001_b.sql': '-- peaket:no-transaction\nCREATE INDEX CONCURRENTLY b_idx ON b (id);',
    });
    const log: string[] = [];
    const client = new FakeClient({ owner: null }, 'one');
    const result = await runMigrations({ client, dir, dryRun: true, log: (line) => log.push(line) });
    expect(result.dryRun).toBe(true);
    expect(result.pending).toEqual(['0000_a.sql', '0001_b.sql']);
    expect(result.applied).toEqual([]);
    expect(client.calls).toHaveLength(0);
    expect(log.some((line) => line.includes('0000_a.sql') && line.includes('transaction'))).toBe(true);
    expect(log.some((line) => line.includes('0001_b.sql') && line.includes('no-transaction'))).toBe(true);
  });

  it('마이그레이션 뒤 훅을 한 번 부르고 실패·드라이런에는 부르지 않는다', async () => {
    const dir = await migrations({ '0000_a.sql': 'CREATE TABLE a (id int);' });
    const ok = new FakeClient({ owner: null }, 'one');
    const hook = vi.fn(async () => {});
    await runMigrations({ client: ok, dir, afterMigrate: hook, ...quiet });
    expect(hook).toHaveBeenCalledTimes(1);

    const dry = new FakeClient({ owner: null }, 'two');
    const dryHook = vi.fn(async () => {});
    await runMigrations({ client: dry, dir, dryRun: true, afterMigrate: dryHook, ...quiet });
    expect(dryHook).not.toHaveBeenCalled();

    const broken = new FakeClient({ owner: null }, 'three');
    broken.fail.push({ matcher: /CREATE TABLE a/, code: '23505', times: 1 });
    const brokenHook = vi.fn(async () => {});
    await expect(runMigrations({ client: broken, dir, afterMigrate: brokenHook, ...quiet })).rejects.toBeTruthy();
    expect(brokenHook).not.toHaveBeenCalled();
  });

  it('[ASVS v5.0.0-16.3.4] 마이그레이션 실패 로그는 파일·문장·SQLSTATE를 남기고 값을 싣지 않는다', async () => {
    const secret = 'SECRET_VALUE_DO_NOT_LOG';
    const dir = await migrations({ '0000_a.sql': `CREATE TABLE a (v text DEFAULT '${secret}');` });
    const client = new FakeClient({ owner: null }, 'one');
    client.fail.push({ matcher: /CREATE TABLE a/, code: '42P01', times: 1 });
    const log: string[] = [];
    const error = await runMigrations({ client, dir, log: (line) => log.push(line), ...quiet }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    const text = `${String((error as Error).message)}\n${log.join('\n')}`;
    expect(text).toContain('0000_a.sql');
    expect(text).toContain('42P01');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('CREATE TABLE a');
  });

  it('planMigrations는 적용 기록이 파일 순서의 앞부분일 때만 통과한다', async () => {
    const dir = await migrations({
      '0000_a.sql': 'CREATE TABLE a (id int);',
      '0001_b.sql': 'CREATE TABLE b (id int);',
    });
    const files = await readMigrationFiles(dir);
    const good = planMigrations(files, [{ name: '0000_a.sql', checksum: files[0]?.checksum ?? '' }]);
    expect(good.pending.map((f) => f.name)).toEqual(['0001_b.sql']);
    let outOfOrder: unknown;
    try {
      planMigrations(files, [{ name: '0001_b.sql', checksum: files[1]?.checksum ?? '' }]);
    } catch (error) {
      outOfOrder = error;
    }
    expect((outOfOrder as MigrationError).code).toMatch(/OUT_OF_ORDER|UNKNOWN_APPLIED/);
  });
});
