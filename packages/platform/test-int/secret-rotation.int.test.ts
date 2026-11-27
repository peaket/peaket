// 실제 PostgreSQL에서 저장소 비밀 교대 교체를 본다(D-T34 ①~③, 기능 F-09-4, 계획 docs/review/plans/F-09-4.md §6).
// Docker 엔진이 필요하다. 이번 동결 로컬 턴에는 돌리지 않았고(미실행), 구현·검증 차례에 Docker 잠금을 잡고 돌린다.
// PgBouncer 컨테이너는 쓰지 않는다: 목록 반영·RELOAD 지연은 단위 시험(secret-rotation.test.ts)이 모의하고,
// 이 시험은 교체 함수가 만든 SCRAM 검증기를 실제 PostgreSQL이 받아들이는지와 두 판의 접속·거절을 본다.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { rotateDbSecret, scramSha256Verifier, type RotationPorts } from '../src/secret-rotation.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let container: PostgresContainer;
const SECRET_ID = 'peaket/purchase/db';
const CLONE = 'purchase_app_clone';
const APP = 'purchase_app';

async function admin(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: container.url, application_name: 'peaket-secret-rotation-int' });
  await client.connect();
  return client;
}

async function connectAs(user: string, password: string): Promise<string> {
  const client = new pg.Client({ connectionString: container.urlFor(user, password), connectionTimeoutMillis: 3_000 });
  await client.connect();
  try {
    const result = await client.query<{ current_user: string }>('select current_user');
    return result.rows[0]!.current_user;
  } finally {
    await client.end().catch(() => {});
  }
}

class IntSecrets {
  readonly versions = new Map<string, { id: string; value: { username: string; password: string }; stage?: 'AWSCURRENT' | 'AWSPREVIOUS' }>();
  currentId = 'v0';
  constructor(username: string, password: string) {
    this.versions.set('v0', { id: 'v0', value: { username, password }, stage: 'AWSCURRENT' });
  }
  describe() {
    const previous = [...this.versions.values()].find((v) => v.stage === 'AWSPREVIOUS');
    return Promise.resolve({ currentVersionId: this.currentId, previousVersionId: previous?.id });
  }
  get(_id: string, versionId: string) {
    const version = this.versions.get(versionId);
    return version ? Promise.resolve(version.value) : Promise.reject(new Error(`없는 판: ${versionId}`));
  }
  put(_id: string, token: string, value: { username: string; password: string }) {
    this.versions.set(token, { id: token, value });
    return Promise.resolve({ versionId: token });
  }
  updateStage(_id: string, versionId: string, stage: 'AWSCURRENT' | 'AWSPREVIOUS') {
    if (stage === 'AWSCURRENT') {
      for (const version of this.versions.values()) if (version.stage === 'AWSCURRENT' && version.id !== versionId) version.stage = 'AWSPREVIOUS';
      this.currentId = versionId;
    }
    const target = this.versions.get(versionId);
    if (target) target.stage = stage;
    return Promise.resolve();
  }
  lastValue() {
    return this.versions.get(this.currentId)!.value;
  }
}

describe('D-T34 실제 PostgreSQL 교체', () => {
  beforeAll(async () => {
    container = await startPostgres();
  });

  afterAll(() => {
    container.stop();
  });

  beforeEach(async () => {
    const client = await admin();
    for (const role of [CLONE, APP]) {
      await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await client.query(`CREATE ROLE ${role} LOGIN`);
    }
    await client.end();
  });

  function ports(secrets: IntSecrets, options: { failFirstConnect?: boolean; metrics?: { name: string; labels?: Record<string, string> }[] } = {}) {
    const userlist = new Map<string, string>();
    let failOnce = options.failFirstConnect ?? false;
    const p: RotationPorts = {
      secrets: {
        describe: () => secrets.describe(),
        get: (id, versionId) => secrets.get(id, versionId),
        put: (id, token, value) => secrets.put(id, token, value),
        updateStage: (id, versionId, stage) => secrets.updateStage(id, versionId, stage),
      },
      database: {
        alterRolePassword: async (username, verifier) => {
          const client = await admin();
          try {
            await client.query(`ALTER ROLE ${username} PASSWORD '${verifier.replace(/'/g, "''")}'`);
          } finally {
            await client.end();
          }
        },
      },
      pgbouncer: {
        readUserlist: () => Promise.resolve([...userlist].map(([user, verifier]) => `"${user}" "${verifier}"`).join('\n') + '\n'),
        writeUserlist: async (text) => {
          userlist.clear();
          for (const line of text.split('\n')) {
            const match = /^"([^"]+)"\s+"([^"]+)"$/.exec(line.trim());
            if (match) userlist.set(match[1]!, match[2]!);
          }
        },
        reload: () => Promise.resolve(),
        testConnect: async (username, password) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('AUTH_FAILED');
          }
          await connectAs(username, password);
        },
      },
      metrics: { increment: (name, labels) => options.metrics?.push({ name, labels }) },
    };
    return p;
  }

  test('D-T34 ① 교체 뒤 옛 판·새 판 사용자 모두 실제 PostgreSQL에 새 연결을 맺는다', async () => {
    const secrets = new IntSecrets(APP, 'first-password');
    await setPassword(APP, 'first-password');
    await setPassword(CLONE, 'clone-password');
    const result = await rotateDbSecret({ secretId: SECRET_ID, clientRequestToken: 'int-token-1', ports: ports(secrets) });
    expect(result.rotatedUser).toBe(CLONE);
    expect(result.previousUser).toBe(APP);
    const newValue = secrets.lastValue();
    expect(await connectAs(APP, 'first-password')).toBe(APP);
    expect(await connectAs(CLONE, newValue.password)).toBe(CLONE);
  });

  test('D-T34 ② 목록 반영 전에 새 판을 받은 파드는 재시도 안에서 성공한다', async () => {
    const metrics: { name: string; labels?: Record<string, string> }[] = [];
    const secrets = new IntSecrets(APP, 'first-password');
    await setPassword(APP, 'first-password');
    await setPassword(CLONE, 'clone-password');
    const result = await rotateDbSecret({
      secretId: SECRET_ID,
      clientRequestToken: 'int-token-2',
      ports: ports(secrets, { failFirstConnect: true, metrics }),
      retryDelaysMs: [0, 0, 0],
    });
    expect(result.testRetries).toBe(1);
    expect(metrics.filter((m) => m.name === 'datastore_auth_failures_total')).toHaveLength(1);
    expect(await connectAs(CLONE, secrets.lastValue().password)).toBe(CLONE);
  });

  test('D-T34 ③ 두 번째 교체 뒤 첫 판 비밀번호는 실제 PostgreSQL에서 거절된다', async () => {
    const metrics: { name: string; labels?: Record<string, string> }[] = [];
    const secrets = new IntSecrets(APP, 'first-password');
    await setPassword(APP, 'first-password');
    await setPassword(CLONE, 'clone-password');
    await rotateDbSecret({ secretId: SECRET_ID, clientRequestToken: 'int-token-3', ports: ports(secrets, { metrics }) });
    const refreshed = secrets.lastValue();
    await rotateDbSecret({ secretId: SECRET_ID, clientRequestToken: 'int-token-4', ports: ports(secrets, { metrics }) });
    await expect(connectAs(APP, 'first-password')).rejects.toMatchObject({ code: '28P01' });
    expect(await connectAs(refreshed.username, refreshed.password)).toBe(CLONE);
  });

  /** 역할의 비밀번호를 실제 SCRAM 검증기로 바꾼다(초기 상태를 만든다) */
  async function setPassword(user: string, password: string) {
    const verifier = scramSha256Verifier(password, Buffer.from('0123456789abcdef'));
    const client = await admin();
    try {
      await client.query(`ALTER ROLE ${user} PASSWORD '${verifier.replace(/'/g, "''")}'`);
    } finally {
      await client.end();
    }
  }
});
