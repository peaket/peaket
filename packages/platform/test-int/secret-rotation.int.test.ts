// D-T34 ①~③ 로컬 통합 시험: 교대 사용자 둘의 SCRAM 비밀과 세대별 인증.
// 정본: docs/devops.md:689~693, docs/security/secrets-and-keys.md:10.
// 이 시험은 실제 PostgreSQL 18 컨테이너만 쓴다(Docker 필요). PgBouncer 컨테이너의 RELOAD 경로는
// 이 파일이 다루지 않는다. PgBouncer를 거치는 ①~③은 구현 차례에 PgBouncer 컨테이너를 더해 확인하고,
// 그전에는 이 파일의 PostgreSQL 직접 인증으로 SCRAM verifier·두 세대·옛 세대 거절만 본다.
// 이번 턴(2026-11-27)은 Docker를 쓰지 않아 미실행이다.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import pg, { type Client } from 'pg';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { alternatingUsers, isAuthFailure, scramSha256Verifier } from '../src/secret-rotation.js';

const USERS = alternatingUsers('purchase_app');
const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
const PASSWORDS = {
  first: 'first-generation-password',
  second: 'second-generation-password',
  third: 'third-generation-password',
  cloneFirst: 'clone-first-generation-password',
  cloneSecond: 'clone-second-generation-password',
};

let container: PostgresContainer;
let admin: Client;

async function setPassword(user: string, password: string): Promise<void> {
  const verifier = scramSha256Verifier(password, SALT, 4096);
  await admin.query(`alter role ${user} with login password '${verifier.replaceAll("'", "''")}'`);
}

async function tryConnect(user: string, password: string): Promise<{ ok: true; client: pg.Client } | { ok: false; error: unknown }> {
  const client = new pg.Client({
    host: container.host,
    port: container.port,
    user,
    password,
    database: 'peaket',
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    await client.query('select 1');
    return { ok: true, client };
  } catch (error) {
    await client.end().catch(() => {});
    return { ok: false, error };
  }
}

async function close(result: { ok: true; client: pg.Client }): Promise<void> {
  await result.client.end().catch(() => {});
}

describe('D-T34 저장소 비밀 교대 사용자', () => {
  beforeAll(async () => {
    container = await startPostgres();
    admin = new pg.Client({ connectionString: container.url });
    await admin.connect();
    for (const user of USERS) {
      await admin.query(`drop role if exists ${user}`);
      await admin.query(`create role ${user} login`);
    }
  }, 120_000);

  beforeEach(async () => {
    await setPassword(USERS[0], PASSWORDS.first);
    await setPassword(USERS[1], PASSWORDS.cloneFirst);
  });

  afterAll(async () => {
    await admin?.end().catch(() => {});
    container?.stop();
  });

  test('D-T34 ① 교체 직후 옛 판·새 판 사용자가 모두 새 연결을 맺는다', async () => {
    // 첫 세대: 두 사용자 모두 접속한다.
    const first = await tryConnect(USERS[0], PASSWORDS.first);
    const cloneFirst = await tryConnect(USERS[1], PASSWORDS.cloneFirst);
    expect(first.ok).toBe(true);
    expect(cloneFirst.ok).toBe(true);
    if (first.ok) await close(first);
    if (cloneFirst.ok) await close(cloneFirst);

    // 첫 교체: active 사용자의 비밀만 바꾼다. 목록에는 두 사용자가 모두 있다.
    await setPassword(USERS[0], PASSWORDS.second);
    const rotated = await tryConnect(USERS[0], PASSWORDS.second);
    const previous = await tryConnect(USERS[1], PASSWORDS.cloneFirst);
    expect(rotated.ok).toBe(true);
    expect(previous.ok).toBe(true);
    if (rotated.ok) await close(rotated);
    if (previous.ok) await close(previous);
  });

  test('D-T34 ② 새 판 비밀이 목록 재읽기보다 늦어도 연결 재시도 안에서 성공하고 실패 수만 남는다', async () => {
    // 옛 연결을 유지한 채 active 사용자의 비밀을 바꾼다. 실행 중 연결은 끊기지 않는다.
    const held = await tryConnect(USERS[0], PASSWORDS.first);
    expect(held.ok).toBe(true);
    await setPassword(USERS[0], PASSWORDS.second);

    let failures = 0;
    let connected = false;
    // 재시도 간격(20초×3=60초)과 RELOAD는 정적 시험이 본다. 여기서는 새 비밀이 몇 번 실패해도
    // 재시도 안에서 성공하는지만 본다(PgBouncer 목록 재읽기 전이면 1~2회 실패할 수 있다).
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
    expect(failures).toBeLessThanOrEqual(2);
    if (held.ok) {
      const alive = await held.client.query('select 1');
      expect(alive.rowCount).toBe(1);
      await close(held);
    }

    // 이전 세대 사용자도 아직 접속한다(목록에 남아 있다).
    const previous = await tryConnect(USERS[1], PASSWORDS.cloneFirst);
    expect(previous.ok).toBe(true);
    if (previous.ok) await close(previous);
  });

  test('D-T34 ③ 두 번째 교체 뒤 첫 판 비밀은 거절되고 재시작한 파드는 실패가 0이다', async () => {
    // 첫 교체: active 사용자.
    await setPassword(USERS[0], PASSWORDS.second);
    // 재시작 잡이 교체 사이에 파드를 다시 띄운 판: 지금 비밀로 다시 붙는다.
    const restarted = await tryConnect(USERS[0], PASSWORDS.second);
    let restartFailures = 0;
    if (!restarted.ok) restartFailures += 1;
    expect(restartFailures).toBe(0);
    if (restarted.ok) await close(restarted);

    // 두 번째 교체: clone 사용자. 이제 첫 세대 비밀은 어느 사용자와도 맞지 않는다.
    await setPassword(USERS[1], PASSWORDS.cloneSecond);
    const cloneRotated = await tryConnect(USERS[1], PASSWORDS.cloneSecond);
    const activeStill = await tryConnect(USERS[0], PASSWORDS.second);
    expect(cloneRotated.ok).toBe(true);
    expect(activeStill.ok).toBe(true);
    if (cloneRotated.ok) await close(cloneRotated);
    if (activeStill.ok) await close(activeStill);

    let failures = 0;
    const stale = await tryConnect(USERS[0], PASSWORDS.first);
    if (!stale.ok) {
      failures += 1;
      expect(isAuthFailure(stale.error)).toBe(true);
    }
    expect(failures).toBe(1);

    // 세 번째 교체 뒤에도 지금 세대(third)와 직전 세대(cloneSecond)는 접속한다.
    await setPassword(USERS[0], PASSWORDS.third);
    const third = await tryConnect(USERS[0], PASSWORDS.third);
    const previous = await tryConnect(USERS[1], PASSWORDS.cloneSecond);
    expect(third.ok).toBe(true);
    expect(previous.ok).toBe(true);
    if (third.ok) await close(third);
    if (previous.ok) await close(previous);
  });
});
