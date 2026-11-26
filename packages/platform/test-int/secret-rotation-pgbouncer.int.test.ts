// D-T34 ①~③ PgBouncer 실제 경로: auth_file SCRAM·RELOAD·이전 세대 거절.
// 정본: docs/devops.md:689~693, docs/security/secrets-and-keys.md:10.
// Docker 엔진이 필요하다. 이 시험은 PostgreSQL 18 컨테이너와 PgBouncer 1.26.1 컨테이너를 띄운다.
// 기존 시험 고정(secret-rotation.int.test.ts)은 PostgreSQL 직접 인증만 보고, 이 파일이 RELOAD 경로를 본다.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import pg, { type Client } from 'pg';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { alternatingUsers, isAuthFailure, scramSha256Verifier } from '../src/secret-rotation.js';

const PGBOUNCER_IMAGE = 'edoburu/pgbouncer:v1.26.1-p0';
const USERS = alternatingUsers('purchase_app');
const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
const PASSWORDS = {
  first: 'first-generation-password',
  second: 'second-generation-password',
  third: 'third-generation-password',
  cloneFirst: 'clone-first-generation-password',
  cloneSecond: 'clone-second-generation-password',
  admin: 'pgbouncer-admin-password',
};

let container: PostgresContainer;
let admin: Client;
let pgbouncer: { id: string; port: number; dir: string; stop(): void };

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

function verifier(password: string): string {
  return scramSha256Verifier(password, SALT, 4096);
}

function writeUserlist(lines: string[]): void {
  const path = join(pgbouncer.dir, 'userlist.txt');
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(path, 0o644);
  // Windows Docker Desktop의 bind mount 캐시를 피해 컨테이너 안 파일도 직접 바꾼다.
  docker(['cp', path, `${pgbouncer.id}:/etc/pgbouncer/userlist.txt`]);
}

function defaultUserlist(): string[] {
  return [
    `"postgres" "${verifier(PASSWORDS.admin)}"`,
    `"${USERS[0]}" "${verifier(PASSWORDS.first)}"`,
    `"${USERS[1]}" "${verifier(PASSWORDS.cloneFirst)}"`,
  ];
}

async function setDbPassword(user: string, password: string): Promise<void> {
  await admin.query(`alter role ${user} with login password '${verifier(password).replaceAll("'", "''")}'`);
}

async function tryConnect(user: string, password: string, database = 'peaket'): Promise<{ ok: true; client: Client } | { ok: false; error: unknown }> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: pgbouncer.port,
    user,
    password,
    database,
    ssl: false,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    await client.query('select 1');
    return { ok: true, client };
  } catch (error) {
    console.error(`PgBouncer connect failed: user=${user} db=${database}`, error);
    await client.end().catch(() => {});
    return { ok: false, error };
  }
}

async function close(result: { ok: true; client: Client }): Promise<void> {
  await result.client.end().catch(() => {});
}

function adminClient(): Client {
  return new pg.Client({
    host: '127.0.0.1',
    port: pgbouncer.port,
    user: 'postgres',
    password: PASSWORDS.admin,
    database: 'pgbouncer',
    ssl: false,
    connectionTimeoutMillis: 3000,
  });
}

async function reload(): Promise<void> {
  const client = adminClient();
  await client.connect();
  try {
    await client.query('RELOAD');
    // PgBouncer가 auth_file을 다시 읽고 새 연결에 반영할 시간을 준다.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await client.end().catch(() => {});
  }
}

async function startPgBouncer(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-pgbouncer-'));
  const config = [
    '[databases]',
    `* = host=host.docker.internal port=${container.port}`,
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'auth_type = scram-sha-256',
    'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction',
    'admin_users = postgres',
    'server_tls_sslmode = disable',
    'ignore_startup_parameters = extra_float_digits',
    'log_connections = 1',
    'log_disconnections = 1',
    'log_pooler_errors = 1',
    'verbose = 1',
    'server_login_retry = 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'pgbouncer.ini'), config, 'utf8');
  writeFileSync(join(dir, 'userlist.txt'), `${defaultUserlist().join('\n')}\n`, 'utf8');
  chmodSync(dir, 0o755);
  chmodSync(join(dir, 'pgbouncer.ini'), 0o644);
  chmodSync(join(dir, 'userlist.txt'), 0o644);
  const id = docker([
    'run',
    '-d',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    '-p',
    '127.0.0.1::6432',
    '-v',
    `${dir}:/etc/pgbouncer:rw`,
    PGBOUNCER_IMAGE,
  ]);
  const mapped = docker(['port', id, '6432/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 멈췄다
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 이미 지웠다
    }
  };
  pgbouncer = { id, port, dir, stop };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = adminClient();
    try {
      await client.connect();
      await client.query('SHOW VERSION');
      await client.end().catch(() => {});
      break;
    } catch (error) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) {
        stop();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

describe('D-T34 PgBouncer RELOAD 경로', () => {
  beforeAll(async () => {
    container = await startPostgres();
    admin = new pg.Client({ connectionString: container.url });
    await admin.connect();
    for (const user of USERS) {
      await admin.query(`drop role if exists ${user}`);
      await admin.query(`create role ${user} login`);
    }
    await setDbPassword(USERS[0], PASSWORDS.first);
    await setDbPassword(USERS[1], PASSWORDS.cloneFirst);
  }, 180_000);

  beforeEach(async () => {
    pgbouncer?.stop();
    await setDbPassword(USERS[0], PASSWORDS.first);
    await setDbPassword(USERS[1], PASSWORDS.cloneFirst);
    await startPgBouncer();
  });

  afterAll(async () => {
    pgbouncer?.stop();
    await admin?.end().catch(() => {});
    container?.stop();
  });

  test('D-T34 ① PgBouncer가 두 SCRAM 사용자를 인증하고 새 비밀도 통한다', async () => {
    const first = await tryConnect(USERS[0], PASSWORDS.first);
    const cloneFirst = await tryConnect(USERS[1], PASSWORDS.cloneFirst);
    expect(first.ok).toBe(true);
    expect(cloneFirst.ok).toBe(true);
    if (first.ok) await close(first);
    if (cloneFirst.ok) await close(cloneFirst);

    await setDbPassword(USERS[0], PASSWORDS.second);
    writeUserlist([
      `"postgres" "${verifier(PASSWORDS.admin)}"`,
      `"${USERS[0]}" "${verifier(PASSWORDS.second)}"`,
      `"${USERS[1]}" "${verifier(PASSWORDS.cloneFirst)}"`,
    ]);
    await reload();

    const rotated = await tryConnect(USERS[0], PASSWORDS.second);
    const previous = await tryConnect(USERS[1], PASSWORDS.cloneFirst);
    expect(rotated.ok).toBe(true);
    expect(previous.ok).toBe(true);
    if (rotated.ok) await close(rotated);
    if (previous.ok) await close(previous);
  });

  test('D-T34 ② RELOAD 전 새 비밀은 실패하고 RELOAD 뒤 성공하며 실패 수만 남는다', async () => {
    const held = await tryConnect(USERS[0], PASSWORDS.first);
    expect(held.ok).toBe(true);

    // DB 비밀과 사용자 목록 비밀을 새 판으로 바꾸지만 RELOAD는 아직 보내지 않는다.
    await setDbPassword(USERS[0], PASSWORDS.second);
    writeUserlist([
      `"postgres" "${verifier(PASSWORDS.admin)}"`,
      `"${USERS[0]}" "${verifier(PASSWORDS.second)}"`,
      `"${USERS[1]}" "${verifier(PASSWORDS.cloneFirst)}"`,
    ]);

    const beforeReload = await tryConnect(USERS[0], PASSWORDS.second);
    expect(beforeReload.ok).toBe(false);
    if (!beforeReload.ok) expect(isAuthFailure(beforeReload.error)).toBe(true);

    let failures = 0;
    let connected = false;
    // 20초×3회는 정적 시험이 본다. 여기서는 RELOAD 한 번 뒤 즉시 다시 붙어 성공을 본다.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt === 0) await reload();
      const result = await tryConnect(USERS[0], PASSWORDS.second);
      if (result.ok) {
        connected = true;
        await close(result);
        break;
      }
      failures += 1;
      expect(isAuthFailure(result.error)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(connected).toBe(true);
    expect(failures).toBe(0);

    const stale = await tryConnect(USERS[0], PASSWORDS.first);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(isAuthFailure(stale.error)).toBe(true);

    if (held.ok) {
      const alive = await held.client.query('select 1');
      expect(alive.rowCount).toBe(1);
      await close(held);
    }
    const cloneStill = await tryConnect(USERS[1], PASSWORDS.cloneFirst);
    expect(cloneStill.ok).toBe(true);
    if (cloneStill.ok) await close(cloneStill);
  });

  test('D-T34 ③ 두 번째 교체 뒤 첫 판 비밀은 RELOAD 뒤에도 거절되고 재시작한 파드는 실패가 0이다', async () => {
    await setDbPassword(USERS[0], PASSWORDS.second);
    writeUserlist([
      `"postgres" "${verifier(PASSWORDS.admin)}"`,
      `"${USERS[0]}" "${verifier(PASSWORDS.second)}"`,
      `"${USERS[1]}" "${verifier(PASSWORDS.cloneFirst)}"`,
    ]);
    await reload();

    const restarted = await tryConnect(USERS[0], PASSWORDS.second);
    let restartFailures = 0;
    if (!restarted.ok) restartFailures += 1;
    expect(restartFailures).toBe(0);
    if (restarted.ok) await close(restarted);

    await setDbPassword(USERS[1], PASSWORDS.cloneSecond);
    writeUserlist([
      `"postgres" "${verifier(PASSWORDS.admin)}"`,
      `"${USERS[0]}" "${verifier(PASSWORDS.second)}"`,
      `"${USERS[1]}" "${verifier(PASSWORDS.cloneSecond)}"`,
    ]);
    await reload();

    const activeStill = await tryConnect(USERS[0], PASSWORDS.second);
    const cloneRotated = await tryConnect(USERS[1], PASSWORDS.cloneSecond);
    expect(activeStill.ok).toBe(true);
    expect(cloneRotated.ok).toBe(true);
    if (activeStill.ok) await close(activeStill);
    if (cloneRotated.ok) await close(cloneRotated);

    const stale = await tryConnect(USERS[0], PASSWORDS.first);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(isAuthFailure(stale.error)).toBe(true);

    await setDbPassword(USERS[0], PASSWORDS.third);
    writeUserlist([
      `"postgres" "${verifier(PASSWORDS.admin)}"`,
      `"${USERS[0]}" "${verifier(PASSWORDS.third)}"`,
      `"${USERS[1]}" "${verifier(PASSWORDS.cloneSecond)}"`,
    ]);
    await reload();
    const third = await tryConnect(USERS[0], PASSWORDS.third);
    const previous = await tryConnect(USERS[1], PASSWORDS.cloneSecond);
    expect(third.ok).toBe(true);
    expect(previous.ok).toBe(true);
    if (third.ok) await close(third);
    if (previous.ok) await close(previous);
  });
});
