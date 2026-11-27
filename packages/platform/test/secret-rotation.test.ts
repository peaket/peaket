// 저장소 비밀 교대 교체 시험(기능 F-09-4, D-T34 ①~③, ASVS v5.0.0-13.3.4, 계획 docs/review/plans/F-09-4.md §5·§6).
// 실제 PostgreSQL·PgBouncer를 쓰지 않고, SCRAM 검증기와 PgBouncer 사용자 목록을 모의한다.
// 실제 무대 실행은 packages/platform/test-int/secret-rotation.int.test.ts(구현 차례, 이번 턴 미실행)가 맡는다.
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  parseScramVerifier,
  rotateDbSecret,
  scramSha256Verifier,
  type RotationPorts,
  type SecretRotationError,
} from '../src/secret-rotation.js';

const ITERATIONS = 4096;

/** PostgreSQL SCRAM-SHA-256 검증기를 표준 알고리즘으로 직접 확인한다(구현을 믿지 않는다) */
function verifyPassword(password: string, verifier: string): boolean {
  const parsed = parseScramVerifier(verifier);
  const salted = pbkdf2Sync(password, parsed.salt, parsed.iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  return storedKey.equals(parsed.storedKey);
}

class FakeSecrets {
  readonly versions = new Map<string, { id: string; value: { username: string; password: string }; stage?: 'AWSCURRENT' | 'AWSPREVIOUS' }>();
  readonly putCalls: { secretId: string; token: string; value: { username: string; password: string } }[] = [];
  readonly stageCalls: { versionId: string; stage: 'AWSCURRENT' | 'AWSPREVIOUS' }[] = [];
  currentId: string;
  failPut = false;
  failStage = false;

  constructor(username: string, password: string) {
    this.currentId = 'v0';
    this.versions.set('v0', { id: 'v0', value: { username, password }, stage: 'AWSCURRENT' });
  }

  describe(): Promise<{ currentVersionId?: string; previousVersionId?: string }> {
    const current = this.versions.get(this.currentId);
    const previous = [...this.versions.values()].find((v) => v.stage === 'AWSPREVIOUS');
    return Promise.resolve({ currentVersionId: current?.id, previousVersionId: previous?.id });
  }

  get(_secretId: string, versionId: string): Promise<{ username: string; password: string }> {
    const version = this.versions.get(versionId);
    if (!version) return Promise.reject(new Error(`없는 판: ${versionId}`));
    return Promise.resolve(version.value);
  }

  put(_secretId: string, token: string, value: { username: string; password: string }): Promise<{ versionId: string }> {
    if (this.failPut) return Promise.reject(new Error('put 실패'));
    this.putCalls.push({ secretId: _secretId, token, value });
    this.versions.set(token, { id: token, value });
    return Promise.resolve({ versionId: token });
  }

  updateStage(_secretId: string, versionId: string, stage: 'AWSCURRENT' | 'AWSPREVIOUS'): Promise<void> {
    if (this.failStage) return Promise.reject(new Error('stage 실패'));
    this.stageCalls.push({ versionId, stage });
    if (stage === 'AWSCURRENT') {
      for (const version of this.versions.values()) {
        if (version.stage === 'AWSCURRENT' && version.id !== versionId) version.stage = 'AWSPREVIOUS';
      }
      this.currentId = versionId;
    }
    const target = this.versions.get(versionId);
    if (target) target.stage = stage;
    return Promise.resolve();
  }

  lastPut() {
    return this.putCalls.at(-1);
  }
}

class FakeDatabase {
  readonly verifiers = new Map<string, string>();
  alterCalls = 0;
  fail = false;

  alterRolePassword(username: string, verifier: string): Promise<void> {
    this.alterCalls += 1;
    if (this.fail) return Promise.reject(new Error('ALTER ROLE 실패'));
    this.verifiers.set(username, verifier);
    return Promise.resolve();
  }
}

class FakePgBouncer {
  readonly users = new Map<string, string>();
  reloadCalls = 0;
  reloadError: Error | undefined;
  /** reload가 끝났는데 아직 목록이 반영되지 않은 한 번의 시험 접속을 흉내 낸다(D-T34 ②) */
  staleOnceAfterReload = false;
  rejectUser: string | undefined;

  readUserlist(): Promise<string> {
    return Promise.resolve([...this.users].map(([user, verifier]) => `"${user}" "${verifier}"`).join('\n') + '\n');
  }

  writeUserlist(text: string): Promise<void> {
    this.users.clear();
    for (const line of text.split('\n')) {
      const match = /^"([^"]+)"\s+"([^"]+)"$/.exec(line.trim());
      if (match) this.users.set(match[1]!, match[2]!);
    }
    return Promise.resolve();
  }

  reload(): Promise<void> {
    this.reloadCalls += 1;
    if (this.reloadError) return Promise.reject(this.reloadError);
    return Promise.resolve();
  }

  testConnect(username: string, password: string): Promise<void> {
    if (this.rejectUser === username) return Promise.reject(new Error('AUTH_FAILED'));
    if (this.staleOnceAfterReload) {
      this.staleOnceAfterReload = false;
      return Promise.reject(new Error('AUTH_FAILED'));
    }
    const verifier = this.users.get(username);
    if (!verifier || !verifyPassword(password, verifier)) return Promise.reject(new Error('AUTH_FAILED'));
    return Promise.resolve();
  }
}

function ports(options: { username?: string; password?: string; clonePassword?: string; secretId?: string } = {}) {
  const username = options.username ?? 'purchase_app';
  const password = options.password ?? 'first-password';
  const clonePassword = options.clonePassword ?? 'clone-password';
  const secretId = options.secretId ?? 'peaket/purchase/db';
  const secrets = new FakeSecrets(username, password);
  const database = new FakeDatabase();
  const pgbouncer = new FakePgBouncer();
  const metrics: { name: string; labels?: Record<string, string> }[] = [];
  database.verifiers.set(username, scramSha256Verifier(password, Buffer.alloc(16, 1)));
  database.verifiers.set(`${username}_clone`, scramSha256Verifier(clonePassword, Buffer.alloc(16, 2)));
  pgbouncer.users.set(username, database.verifiers.get(username)!);
  pgbouncer.users.set(`${username}_clone`, database.verifiers.get(`${username}_clone`)!);
  const p: RotationPorts = {
    secrets: {
      describe: () => secrets.describe(),
      get: (id, versionId) => secrets.get(id, versionId),
      put: (id, token, value) => secrets.put(id, token, value),
      updateStage: (id, versionId, stage) => secrets.updateStage(id, versionId, stage),
    },
    database: { alterRolePassword: (user, verifier) => database.alterRolePassword(user, verifier) },
    pgbouncer: {
      readUserlist: () => pgbouncer.readUserlist(),
      writeUserlist: (text) => pgbouncer.writeUserlist(text),
      reload: () => pgbouncer.reload(),
      testConnect: (user, pass) => pgbouncer.testConnect(user, pass),
    },
    metrics: { increment: (name, labels) => metrics.push({ name, labels }) },
  };
  return { p, secrets, database, pgbouncer, metrics, secretId, username, password, clonePassword };
}

describe('D-T34 저장소 비밀 교대 교체', () => {
  test('D-T34 ① 교체 뒤 옛 판·새 판 사용자 모두 PgBouncer로 새 연결을 맺는다', async () => {
    const { p, secrets, database, pgbouncer, secretId } = ports();
    const result = await rotateDbSecret({ secretId, clientRequestToken: 'token-1', ports: p });
    const newValue = secrets.lastPut()!.value;
    expect(result.rotatedUser).toBe('purchase_app_clone');
    expect(result.previousUser).toBe('purchase_app');
    // 두 판 사용자 모두 인증된다
    await expect(pgbouncer.testConnect('purchase_app', 'first-password')).resolves.toBeUndefined();
    await expect(pgbouncer.testConnect('purchase_app_clone', newValue.password)).resolves.toBeUndefined();
    // DB와 PgBouncer 사용자 목록이 같은 검증기를 쓴다
    expect(database.verifiers.get('purchase_app_clone')).toBeDefined();
    expect(pgbouncer.users.get('purchase_app_clone')).toBe(database.verifiers.get('purchase_app_clone'));
    expect(pgbouncer.reloadCalls).toBe(1);
    // AWSCURRENT만 새 판으로 옮기고, 옛 판은 AWSPREVIOUS가 된다
    expect(secrets.stageCalls).toEqual([{ versionId: 'token-1', stage: 'AWSCURRENT' }]);
    expect(secrets.currentId).toBe('token-1');
    expect(secrets.versions.get('v0')!.stage).toBe('AWSPREVIOUS');
  });

  test('D-T34 ② 사용자 목록을 다시 읽기 전에 새 판을 받은 파드는 연결 재시도 안에서 성공한다', async () => {
    const { p, pgbouncer, metrics, secretId } = ports();
    pgbouncer.staleOnceAfterReload = true;
    const result = await rotateDbSecret({ secretId, clientRequestToken: 'token-2', ports: p, retryDelaysMs: [0, 0, 0] });
    expect(result.testRetries).toBe(1);
    expect(metrics.filter((m) => m.name === 'datastore_auth_failures_total')).toEqual([
      { name: 'datastore_auth_failures_total', labels: { store: 'pgbouncer' } },
    ]);
    expect(pgbouncer.reloadCalls).toBe(1);
  });

  test('D-T34 ③ 두 번째 교체 뒤 첫 판 비밀을 쥔 파드는 인증이 실패하고 SEV2 지표가 오른다', async () => {
    const { p, pgbouncer, metrics, secretId } = ports();
    const metricsForApp = { increment: (name: string, labels?: Record<string, string>) => metrics.push({ name, labels }) };
    const connectAsPod = async (user: string, password: string) => {
      try {
        await pgbouncer.testConnect(user, password);
        return 'ok';
      } catch {
        metricsForApp.increment('datastore_auth_failures_total', { store: 'pgbouncer' });
        return 'auth-failed';
      }
    };

    const first = await rotateDbSecret({ secretId, clientRequestToken: 'token-3', ports: p });
    const refreshedPod = { user: first.rotatedUser, password: (await p.secrets.get(secretId, first.versionId)).password };
    const second = await rotateDbSecret({ secretId, clientRequestToken: 'token-4', ports: p });
    expect(second.rotatedUser).toBe('purchase_app');

    // 두 번 교체 뒤 첫 판 비밀을 쥔 파드
    expect(await connectAsPod('purchase_app', 'first-password')).toBe('auth-failed');
    expect(metrics.filter((m) => m.name === 'datastore_auth_failures_total')).toHaveLength(1);
    // 교체 사이에 다시 뜬 파드(1차 교체의 새 판을 쥔다)는 실패 0
    expect(await connectAsPod(refreshedPod.user, refreshedPod.password)).toBe('ok');
    expect(metrics.filter((m) => m.name === 'datastore_auth_failures_total')).toHaveLength(1);
  });

  test('D-T34 ① SCRAM-SHA-256 검증기는 표준 시험 벡터와 같다', () => {
    const verifier = scramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), ITERATIONS);
    expect(verifier).toBe(
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    );
    expect(verifyPassword('pencil', verifier)).toBe(true);
    expect(verifyPassword('pencil2', verifier)).toBe(false);
    expect(parseScramVerifier(verifier).iterations).toBe(4096);
  });

  test('[ASVS v5.0.0-13.3.4] 교체는 DB → 사용자 목록 → RELOAD → 두 판 접속 → AWSCURRENT 순서다', async () => {
    const { p, secrets, database, pgbouncer, secretId } = ports();
    const order: string[] = [];
    const wrap = (name: string) => () => {
      order.push(name);
    };
    const originalAlter = database.alterRolePassword.bind(database);
    database.alterRolePassword = (user, verifier) => {
      wrap('db')();
      return originalAlter(user, verifier);
    };
    const originalWrite = pgbouncer.writeUserlist.bind(pgbouncer);
    pgbouncer.writeUserlist = (text) => {
      wrap('userlist')();
      return originalWrite(text);
    };
    const originalReload = pgbouncer.reload.bind(pgbouncer);
    pgbouncer.reload = () => {
      wrap('reload')();
      return originalReload();
    };
    const originalTest = pgbouncer.testConnect.bind(pgbouncer);
    pgbouncer.testConnect = (user, pass) => {
      order.push(`test:${user}`);
      return originalTest(user, pass);
    };
    const originalStage = secrets.updateStage.bind(secrets);
    secrets.updateStage = (id, versionId, stage) => {
      order.push(`stage:${stage}`);
      return originalStage(id, versionId, stage);
    };
    await rotateDbSecret({ secretId, clientRequestToken: 'token-5', ports: p });
    expect(order).toEqual(['db', 'userlist', 'reload', 'test:purchase_app_clone', 'test:purchase_app', 'stage:AWSCURRENT']);
  });

  test('실패하면 AWSCURRENT를 옮기지 않는다', async () => {
    const { p, secrets, pgbouncer, secretId } = ports();
    pgbouncer.reloadError = new Error('RELOAD 실패');
    await expect(rotateDbSecret({ secretId, clientRequestToken: 'token-6', ports: p })).rejects.toMatchObject({
      code: 'RELOAD',
    } satisfies Partial<SecretRotationError>);
    expect(secrets.currentId).toBe('v0');
    expect(secrets.stageCalls).toEqual([]);
    expect(secrets.putCalls).toEqual([]);
  });

  test('두 판 접속 확인이 계속 실패하면 TEST_CONNECT로 멈추고 지표를 시도마다 올린다', async () => {
    const { p, secrets, pgbouncer, metrics, secretId } = ports();
    pgbouncer.rejectUser = 'purchase_app_clone';
    await expect(
      rotateDbSecret({ secretId, clientRequestToken: 'token-7', ports: p, retryDelaysMs: [0, 0], maxAttempts: 2 }),
    ).rejects.toMatchObject({ code: 'TEST_CONNECT' } satisfies Partial<SecretRotationError>);
    expect(secrets.currentId).toBe('v0');
    expect(metrics.filter((m) => m.name === 'datastore_auth_failures_total')).toHaveLength(2);
  });

  test('비밀 값의 사용자 이름이 정본 꼴이 아니면 USER_PAIR로 멈춘다', async () => {
    const { p, secretId } = ports({ username: 'purchase-app' });
    await expect(rotateDbSecret({ secretId, clientRequestToken: 'token-8', ports: p })).rejects.toMatchObject({
      code: 'USER_PAIR',
    } satisfies Partial<SecretRotationError>);
  });

  test('현재 판이 없으면 SECRET_STAGE로 멈춘다', async () => {
    const { p, secrets, secretId } = ports();
    secrets.currentId = 'none';
    await expect(rotateDbSecret({ secretId, clientRequestToken: 'token-9', ports: p })).rejects.toMatchObject({
      code: 'SECRET_STAGE',
    } satisfies Partial<SecretRotationError>);
  });

  test('사용자 목록을 읽지 못하면 USERLIST로 멈춘다', async () => {
    const { p, secretId, pgbouncer } = ports();
    pgbouncer.readUserlist = () => Promise.reject(new Error('읽기 실패'));
    await expect(rotateDbSecret({ secretId, clientRequestToken: 'token-10', ports: p })).rejects.toMatchObject({
      code: 'USERLIST',
    } satisfies Partial<SecretRotationError>);
  });
});
