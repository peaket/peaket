// 저장소 비밀 교대 교체(기능 F-09-4, D-T34 ①~③, docs/devops.md §8.3·D-T34, ASVS v5.0.0-13.3.4).
// Aurora 서비스 DB 사용자를 둘(`<서비스>_app`·`<서비스>_app_clone`) 두고, 교체마다 지금 쓰지 않는 쪽의
// 비밀번호만 바꾼다. 새 비밀번호의 SCRAM-SHA-256 검증기를 DB와 PgBouncer 사용자 목록(`auth_file`)에 같이 쓰고,
// RELOAD와 두 판 접속 확인이 끝난 뒤에만 AWSCURRENT를 옮긴다. 실패하면 AWSCURRENT를 그대로 둔다(닫힘 실패).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export type SecretRotationErrorCode =
  | 'SECRET_SHAPE'
  | 'USER_PAIR'
  | 'DB_PASSWORD'
  | 'USERLIST'
  | 'RELOAD'
  | 'TEST_CONNECT'
  | 'SECRET_STAGE'
  | 'METRIC';

export class SecretRotationError extends Error {
  readonly code: SecretRotationErrorCode;
  constructor(code: SecretRotationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretRotationError';
    this.code = code;
  }
}

export interface RotationSecret {
  username: string;
  password: string;
}

export interface SecretStage {
  currentVersionId?: string;
  previousVersionId?: string;
}

/** 교체 함수가 바깥 세계와 만나는 포트. AWS SDK·pg는 구현이 주입한다. */
export interface RotationPorts {
  secrets: {
    describe(secretId: string): Promise<SecretStage>;
    get(secretId: string, versionId: string): Promise<RotationSecret>;
    put(secretId: string, clientRequestToken: string, value: RotationSecret): Promise<{ versionId: string }>;
    updateStage(secretId: string, versionId: string, stage: 'AWSCURRENT' | 'AWSPREVIOUS'): Promise<void>;
  };
  database: {
    alterRolePassword(username: string, verifier: string): Promise<void>;
    currentVerifier?(username: string): Promise<string | undefined>;
  };
  pgbouncer: {
    readUserlist(): Promise<string>;
    writeUserlist(text: string): Promise<void>;
    reload(): Promise<void>;
    testConnect(username: string, password: string): Promise<void>;
  };
  metrics: {
    increment(name: string, labels?: Record<string, string>): void;
  };
}

export interface RotateDbSecretOptions {
  secretId: string;
  clientRequestToken: string;
  ports: RotationPorts;
  /** 시도 사이 간격(ms). 기본 [100, 200, 400] */
  retryDelaysMs?: number[];
  /** 두 판 접속 확인의 최대 시도. 기본 3 */
  maxAttempts?: number;
  /** 지금 시각. 서명·만료가 아니라 기록용으로만 쓴다 */
  now?: () => Date;
  /** 난수 주입(시험용) */
  randomBytes?: (size: number) => Buffer;
  /** 비밀번호 생성 주입(시험용) */
  randomPassword?: () => string;
}

export interface RotateDbSecretResult {
  rotatedUser: string;
  previousUser: string;
  versionId: string;
  testRetries: number;
}

export interface ConnectWithSecretRetryOptions {
  password: string;
  connect: (password: string) => Promise<void>;
  retryDelaysMs?: number[];
  maxAttempts?: number;
  metrics?: Pick<RotationPorts['metrics'], 'increment'>;
}

const USERNAME = /^[a-z][a-z0-9_]{0,62}$/;
const DEFAULT_RETRY_DELAYS = [100, 200, 400];
const DEFAULT_MAX_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** PostgreSQL SCRAM-SHA-256 검증기. salt는 16바이트 이상, iterations 기본 4096(PostgreSQL 기본) */
export function scramSha256Verifier(password: string, salt: Buffer, iterations = 4096): string {
  if (salt.length < 16) throw new SecretRotationError('SECRET_SHAPE', 'SCRAM salt가 16바이트 미만이다');
  if (!Number.isInteger(iterations) || iterations < 4096) throw new SecretRotationError('SECRET_SHAPE', 'SCRAM 반복이 4096 미만이다');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export interface ParsedScramVerifier {
  iterations: number;
  salt: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
}

export function parseScramVerifier(verifier: string): ParsedScramVerifier {
  const match = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(verifier);
  if (!match) throw new SecretRotationError('SECRET_SHAPE', 'SCRAM 검증기 꼴이 아니다');
  const iterations = Number(match[1]);
  if (!Number.isInteger(iterations) || iterations < 4096) throw new SecretRotationError('SECRET_SHAPE', 'SCRAM 반복이 4096 미만이다');
  return {
    iterations,
    salt: Buffer.from(match[2]!, 'base64'),
    storedKey: Buffer.from(match[3]!, 'base64'),
    serverKey: Buffer.from(match[4]!, 'base64'),
  };
}

function metric(ports: RotationPorts, name: string, labels?: Record<string, string>): void {
  try {
    ports.metrics.increment(name, labels);
  } catch (error) {
    throw new SecretRotationError('METRIC', `지표를 올리지 못했다: ${name}`, { cause: error });
  }
}

function assertUsername(username: string): void {
  if (!USERNAME.test(username)) throw new SecretRotationError('USER_PAIR', `교대 사용자 이름이 정본 꼴이 아니다: ${username}`);
}

/** 지금 사용자의 짝. `_clone`이 붙은 쪽이면 떼고, 아니면 붙인다. */
export function pairedUsername(username: string): string {
  assertUsername(username);
  const other = username.endsWith('_clone') ? username.slice(0, -'_clone'.length) : `${username}_clone`;
  assertUsername(other);
  if (other === username) throw new SecretRotationError('USER_PAIR', '교대 사용자 짝이 같다');
  return other;
}

/** PgBouncer `auth_file`의 한 사용자 줄만 바꾼다. 다른 사용자 줄과 순서는 그대로 둔다. */
export function upsertUserlistLine(text: string, username: string, verifier: string): string {
  const line = `"${username}" "${verifier}"`;
  const lines = text.split('\n');
  let replaced = false;
  const next = lines.map((row) => {
    const match = /^"([^"]+)"\s+"([^"]+)"\s*$/.exec(row.trim());
    if (match?.[1] === username) {
      replaced = true;
      return line;
    }
    return row;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] === '') next.splice(next.length - 1, 0, line);
    else next.push(line);
  }
  return `${next.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * 교체 ①~⑤를 실행한다. ① 사용자 짝 ② SCRAM 검증기 계산·ALTER ROLE ③ 사용자 목록 쓰기·RELOAD
 * ④ 두 판 접속 확인 ⑤ 새 판 put·AWSCURRENT 이동. 어느 단계든 실패하면 AWSCURRENT를 옮기지 않는다.
 */
export async function rotateDbSecret(options: RotateDbSecretOptions): Promise<RotateDbSecretResult> {
  const { secretId, clientRequestToken, ports } = options;
  if (!secretId || !clientRequestToken) throw new SecretRotationError('SECRET_SHAPE', 'secretId 또는 clientRequestToken이 비었다');

  const stage = await ports.secrets.describe(secretId);
  if (!stage.currentVersionId) throw new SecretRotationError('SECRET_STAGE', 'AWSCURRENT 판이 없다');

  const current = await ports.secrets.get(secretId, stage.currentVersionId);
  if (!current || typeof current.username !== 'string' || typeof current.password !== 'string' || !current.password) {
    throw new SecretRotationError('SECRET_SHAPE', '현재 비밀 값의 모양이 틀렸다');
  }
  const previousUser = current.username;
  const rotatedUser = pairedUsername(previousUser);

  const bytes = options.randomBytes ?? randomBytes;
  const password = options.randomPassword ? options.randomPassword() : bytes(32).toString('base64url');
  if (!password) throw new SecretRotationError('SECRET_SHAPE', '새 비밀번호가 비었다');
  const verifier = scramSha256Verifier(password, bytes(16));

  try {
    await ports.database.alterRolePassword(rotatedUser, verifier);
  } catch (error) {
    throw new SecretRotationError('DB_PASSWORD', `ALTER ROLE ${rotatedUser} 실패`, { cause: error });
  }

  let userlist: string;
  try {
    userlist = await ports.pgbouncer.readUserlist();
  } catch (error) {
    throw new SecretRotationError('USERLIST', 'PgBouncer 사용자 목록을 읽지 못했다', { cause: error });
  }
  try {
    await ports.pgbouncer.writeUserlist(upsertUserlistLine(userlist, rotatedUser, verifier));
  } catch (error) {
    throw new SecretRotationError('USERLIST', 'PgBouncer 사용자 목록을 쓰지 못했다', { cause: error });
  }
  try {
    await ports.pgbouncer.reload();
  } catch (error) {
    throw new SecretRotationError('RELOAD', 'PgBouncer RELOAD 실패', { cause: error });
  }

  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let testRetries = 0;
  let connected = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ports.pgbouncer.testConnect(rotatedUser, password);
      connected = true;
      break;
    } catch (error) {
      lastError = error;
      metric(ports, 'datastore_auth_failures_total', { store: 'pgbouncer' });
      if (attempt < maxAttempts) {
        testRetries += 1;
        await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0);
      }
    }
  }
  if (!connected) {
    throw new SecretRotationError('TEST_CONNECT', `새 판 사용자 ${rotatedUser} 접속 확인 실패`, { cause: lastError });
  }

  try {
    await ports.pgbouncer.testConnect(previousUser, current.password);
  } catch (error) {
    metric(ports, 'datastore_auth_failures_total', { store: 'pgbouncer' });
    throw new SecretRotationError('TEST_CONNECT', `옛 판 사용자 ${previousUser} 접속 확인 실패`, { cause: error });
  }

  let versionId: string;
  try {
    const put = await ports.secrets.put(secretId, clientRequestToken, { username: rotatedUser, password });
    versionId = put.versionId;
    if (!versionId) throw new Error('versionId가 비었다');
  } catch (error) {
    throw new SecretRotationError('SECRET_STAGE', '새 비밀 판을 쓰지 못했다', { cause: error });
  }
  try {
    await ports.secrets.updateStage(secretId, versionId, 'AWSCURRENT');
  } catch (error) {
    throw new SecretRotationError('SECRET_STAGE', 'AWSCURRENT를 옮기지 못했다', { cause: error });
  }

  return { rotatedUser, previousUser, versionId, testRetries };
}

/**
 * 앱 연결 풀이 새 판을 받은 뒤 PgBouncer 목록이 반영되기 전의 인증 실패를 다시 시도한다.
 * 시도마다 `datastore_auth_failures_total{store="pgbouncer"}`를 올리고, 모두 실패하면 마지막 오류를 던진다.
 */
export async function connectWithSecretRetry(options: ConnectWithSecretRetryOptions): Promise<{ attempts: number }> {
  if (!options.password) throw new SecretRotationError('SECRET_SHAPE', '연결할 비밀번호가 비었다');
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await options.connect(options.password);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      try {
        options.metrics?.increment('datastore_auth_failures_total', { store: 'pgbouncer' });
      } catch (metricError) {
        throw new SecretRotationError('METRIC', '연결 실패 지표를 올리지 못했다', { cause: metricError });
      }
      if (attempt < maxAttempts) await sleep(delays[attempt - 1] ?? delays.at(-1) ?? 0);
    }
  }
  throw lastError;
}
