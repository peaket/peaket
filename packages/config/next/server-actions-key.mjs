// Next.js 서버 액션 암호화 키 형식 확인(docs/security/secrets-and-keys.md 'Next.js 서버 액션 암호화 키', docs/devops.md §6.6, BUILD_ORDER BAS-220).
// Next.js 16.4.3은 NEXT_SERVER_ACTIONS_ENCRYPTION_KEY를 atob로 풀어 crypto.subtle.importKey('raw', …, 'AES-GCM')로 읽는다
// (next/dist/server/app-render/encryption-utils.js, 2026-11-04 확인). 키가 없으면 빌드가 만들어 서버 액션 매니페스트에 넣은 키로
// 조용히 넘어간다. 그러면 키가 이미지에 들어가고 빌드마다 바뀐다(배포가 바뀌는 순간 옛 화면의 서버 액션이 실패한다).
// 그래서 운영 서버가 뜰 때(next start와 운영 이미지의 standalone server.js 모두, instrumentation.ts의 register) 키가 있고,
// 표준 base64로 쓴 32바이트(AES-256)이며 한 바이트만 되풀이한 값이 아닌지 본다. 키 만들기: `openssl rand -base64 32`.

export const KEY_ENV = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY';
export const KEY_BYTES = 32;

/**
 * @param {string | undefined} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkServerActionsKey(value) {
  if (value === undefined || value === '') return { ok: false, reason: `${KEY_ENV}가 없다(모든 앱 서버 파드가 같은 키를 써야 한다)` };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return { ok: false, reason: `${KEY_ENV}는 표준 base64여야 한다` };
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== KEY_BYTES) return { ok: false, reason: `${KEY_ENV}는 ${KEY_BYTES}바이트(AES-256) 키여야 한다: ${bytes.length}바이트` };
  if (bytes.every((b) => b === bytes[0])) return { ok: false, reason: `${KEY_ENV}가 한 바이트만 되풀이한 값이다(무작위로 만든다)` };
  return { ok: true };
}

/**
 * 앱의 instrumentation.ts register()에서 부른다(서버가 뜰 때 한 번). Node 실행 환경의 운영 서버에서만 보고, 틀리면 던져 서버를 띄우지 않는다.
 * 빌드(NEXT_PHASE=phase-production-build, 정적 생성 작업자)와 개발 서버(NODE_ENV≠production)에서는 보지 않는다(CI 빌드에는 비밀이 없다).
 * @param {Record<string, string | undefined>} [env]
 */
export function assertServerActionsKey(env = process.env) {
  if (env.NEXT_RUNTIME !== 'nodejs' || env.NODE_ENV !== 'production' || env.NEXT_PHASE === 'phase-production-build') return;
  const r = checkServerActionsKey(env[KEY_ENV]);
  if (!r.ok) throw new Error(`서버 액션 암호화 키가 틀렸다: ${r.reason}(docs/security/secrets-and-keys.md)`);
}
