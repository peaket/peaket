// 앱 서버만 읽는 봉인 쿠키 값(AES-256-GCM, 쿠키 이름을 덧붙인 자료로 묶는다). 기한을 값 안에 함께 봉인한다.
// 로그인 진행 쿠키 `__Host-peaket_oidc`와 재인증 결과 쿠키 `__Host-peaket_reauth`가 쓴다(docs/features/identity.md §3·§7.1).
// 모양: 판(1바이트) ‖ 키 ID(4바이트) ‖ IV(12바이트, 쿠키마다 새로) ‖ 인증 태그(16바이트) ‖ 암호문. 키 ID로 옛 비밀의 키를 고른다(secrets-and-keys '키 버전').
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealKey {
  /** 키 ID 4바이트 */
  id: Buffer;
  key: Buffer;
}

const VERSION = 1;
const HEAD = 1 + 4;

export function seal(k: SealKey, name: string, value: object, expiresAt: number): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(Buffer.from(name));
  const body = Buffer.concat([c.update(JSON.stringify({ v: value, exp: expiresAt })), c.final()]);
  return Buffer.concat([Buffer.of(VERSION), k.id, iv, c.getAuthTag(), body]).toString('base64url');
}

/** 봉인을 푼다(키 ID가 맞는 키로). 없거나 바뀌었거나 기한이 지났으면 undefined */
export function unseal<T>(keys: readonly SealKey[], name: string, text: string | undefined, now: number): T | undefined {
  if (!text) return undefined;
  try {
    const raw = Buffer.from(text, 'base64url');
    if (raw[0] !== VERSION || raw.length < HEAD + 12 + 16) return undefined;
    const k = keys.find((x) => x.id.equals(raw.subarray(1, HEAD)));
    if (!k) return undefined;
    const d = createDecipheriv('aes-256-gcm', k.key, raw.subarray(HEAD, HEAD + 12));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(raw.subarray(HEAD + 12, HEAD + 28));
    const out = JSON.parse(Buffer.concat([d.update(raw.subarray(HEAD + 28)), d.final()]).toString('utf8')) as { v: T; exp: number };
    return typeof out.exp === 'number' && out.exp > now ? out.v : undefined;
  } catch {
    return undefined;
  }
}
