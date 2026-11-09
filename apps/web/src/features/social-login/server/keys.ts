// 앱 서버 비밀 하나에서 용도별 키를 HKDF-SHA256으로 나눈다(docs/security/secrets-and-keys.md '로그인 진행 쿠키 암호화 키' 행).
// 한 키를 두 용도로 쓰지 않는다: 진행 쿠키 암호화, CreateSession 멱등 키 HMAC, 재인증 결과 쿠키 암호화, 연결 제안 쿠키 암호화(2026-11-04 BOT-040).
// 비밀마다 키 ID(4바이트)를 두어 봉인한 쿠키에 싣고, 비밀을 바꿀 때 옛 비밀의 키로도 연다(쿠키 수명 동안).
import { createHmac, hkdfSync } from 'node:crypto';
import type { SealKey } from './sealed.ts';

export interface LoginKeys {
  progress: SealKey;
  idempotency: Buffer;
  reauthResult: SealKey;
  link: SealKey;
}

export function deriveLoginKeys(secret: Uint8Array): LoginKeys {
  if (secret.length !== 32) throw new Error('앱 서버 비밀은 32바이트다');
  const k = (info: string) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
  const id = createHmac('sha256', secret).update('peaket-web-auth-secret-id-v1').digest().subarray(0, 4);
  return { progress: { id, key: k('peaket-oidc-progress-v1') }, idempotency: k('peaket-create-session-idempotency-v1'), reauthResult: { id, key: k('peaket-reauth-result-v1') }, link: { id, key: k('peaket-link-proposal-v1') } };
}

/** CreateSession 멱등 키: 로그인 진행 쿠키 state의 HMAC(identity §2). state 원문은 identity로 보내지 않는다 */
export const idempotencyKeyOf = (keys: LoginKeys, state: string): string => createHmac('sha256', keys.idempotency).update(`login:${state}`).digest('base64url');

/** SeparateAccount 멱등 키: 제안 ID의 HMAC(같은 제안의 새 계정 만들기를 두 번 눌러도 세션은 하나, identity §2.1) */
export const separateKeyOf = (keys: LoginKeys, proposalId: string): string => createHmac('sha256', keys.idempotency).update(`separate:${proposalId}`).digest('base64url');
