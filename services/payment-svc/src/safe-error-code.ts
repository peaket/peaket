// 로그에 실어도 되는 오류 표지(BUILD_ORDER PRF-180, ASVS v5.0.0-16.2.5).
// 드라이버·Drizzle 오류의 글에는 SQL 문장과 값(결제 키·토큰)이 실릴 수 있어 오류 객체를 로그에 그대로 싣지 않는다.

const SAFE = /^[A-Za-z0-9_]{1,64}$/;

/** 오류와 그 원인(cause)에서 코드(SQLSTATE·ECONNREFUSED 등)를 찾는다. 코드가 없으면 오류 이름, 그것도 없으면 'UNKNOWN'이다. 글(message)은 보지 않는다 */
export function safeErrorCode(err: unknown): string {
  let e = err as { code?: unknown; cause?: unknown } | null | undefined;
  for (let n = 0; e && n < 4; n++) {
    if (typeof e.code === 'string' && SAFE.test(e.code)) return e.code;
    e = e.cause as typeof e;
  }
  const name = err instanceof Error ? err.name : '';
  return SAFE.test(name) ? name : 'UNKNOWN';
}
