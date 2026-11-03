// 대안 C의 로그인 진행 쿠키 `__Host-peaket_oidc`(ADR-0119 결정 2, docs/features/identity.md §3). C 두 구현만 쓴다(기준 ③에 C로 센다).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const PROGRESS = '__Host-peaket_oidc';
const PROGRESS_TTL_S = 600; // 10분 [가정](identity §3)

/** 로그인 진행 상태를 앱 서버 전용 키로 봉인한다(AES-256-GCM, 쿠키 이름을 덧붙인 자료로 묶음) */
export function seal(key, value) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(PROGRESS));
  const body = Buffer.concat([c.update(JSON.stringify({ ...value, exp: Date.now() + PROGRESS_TTL_S * 1000 })), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

/** 봉인을 푼다. 없거나 바뀌었거나 기한이 지났으면 null */
export function unseal(key, text) {
  try {
    const raw = Buffer.from(text ?? '', 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(PROGRESS));
    d.setAuthTag(raw.subarray(12, 28));
    const v = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString());
    return v.exp > Date.now() ? v : null;
  } catch {
    return null;
  }
}


const attrs = 'HttpOnly; Secure';
export const progressCookie = (v) => `${PROGRESS}=${v}; Path=/; ${attrs}; SameSite=Lax; Max-Age=${PROGRESS_TTL_S}`;
export const clearProgress = () => `${PROGRESS}=; Path=/; ${attrs}; SameSite=Lax; Max-Age=0`;

/** 실패 응답은 이유를 싣지 않는다(내부 사정을 드러내지 않게). 이유는 onError로 서버 쪽에만 남긴다 */
export const failed = (onError, why) => {
  onError('callback', why);
  const h = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  h.append('set-cookie', clearProgress());
  return new Response('로그인하지 못했다. 처음부터 다시 시도한다', { status: 400, headers: h });
};
