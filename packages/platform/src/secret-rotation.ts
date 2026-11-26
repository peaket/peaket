// 저장소 비밀 교대 사용자와 SCRAM verifier의 공용 조각(F-09-3, HOT-430, D-T34).
// 정본: docs/devops.md:689~693, docs/security/secrets-and-keys.md:10.
// 이 모듈은 교체 함수 3종·Secrets Manager·KMS를 만들지 않는다(F-09-4 몫). 이름·verifier·실패 판정만 둔다.
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';

/** PgBouncer 목록·앱 비밀·재시작·경보의 정본 값(docs/devops.md:691~693). */
export const ROTATION_POLICY = {
  strategy: 'alternating-users' as const,
  intervalDays: 30,
  userlistRefreshSeconds: 60,
  appSecretRefreshSeconds: 3600,
  reloadOnRotation: true,
  reloadCommand: 'RELOAD' as const,
  connectRetrySeconds: 20,
  connectRetryAttempts: 3,
  restartWithinDays: 30,
  authFailureMetric: 'datastore_auth_failures_total' as const,
  severity: 'SEV2' as const,
};

/** 교대 사용자 둘: `<base>`와 `<base>_clone`(docs/devops.md:690). */
export function alternatingUsers(base: string): [string, string] {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(base)) {
    throw new Error(`교대 사용자 기준 이름이 PostgreSQL 역할 이름 규칙에 맞지 않는다: ${base}`);
  }
  return [base, `${base}_clone`];
}

/**
 * PostgreSQL `SCRAM-SHA-256$<iterations>:<salt-base64>$<stored-key-base64>:<server-key-base64>` verifier.
 * PgBouncer `auth_file`과 `ALTER ROLE ... PASSWORD '...'`에 같은 값을 쓴다(docs/devops.md:692).
 */
export function scramSha256Verifier(password: string, salt: Buffer, iterations = 4096): string {
  if (password.length === 0) throw new Error('SCRAM 비밀번호가 비었다');
  if (salt.length < 8) throw new Error('SCRAM salt가 8바이트보다 짧다');
  if (!Number.isInteger(iterations) || iterations < 4096) throw new Error('SCRAM 반복 수가 4096보다 작다');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** PostgreSQL 인증 실패(28P01 잘못된 비밀번호, 28000 인증 거절)인지 가른다.
 * PgBouncer는 클라이언트 SCRAM 실패를 08P01(protocol_violation) + "SASL authentication failed"로 보낸다. */
export function isAuthFailure(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown } | null | undefined;
  if (err?.code === '28P01' || err?.code === '28000') return true;
  return err?.code === '08P01' && typeof err.message === 'string' && /SASL authentication failed/i.test(err.message);
}

/** 재시도 창(초)이 PgBouncer 목록 재읽기(60초)를 덮는지. D-T34 ②. */
export function retryWindowSeconds(): number {
  return ROTATION_POLICY.connectRetrySeconds * ROTATION_POLICY.connectRetryAttempts;
}

/** 교체 뒤 PgBouncer에 보낼 명령. `false`면 보내지 않는다. */
export function reloadCommandForRotation(): string | null {
  return ROTATION_POLICY.reloadOnRotation ? ROTATION_POLICY.reloadCommand : null;
}
