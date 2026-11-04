// 팬 요청의 401 다루기(docs/frontend.md §4.1 '401', ADR-0199 결정 3): 401이면 토큰을 한 번 갱신하고 원래 요청을 한 번 더 보낸다.
// 갱신이 안 되거나 다시 401이면 그 401을 던진다(부르는 쪽이 비로그인으로 본다). 갱신 자체는 다시 보내지 않는다. 순수 함수라 바로 시험한다.
/** 401 응답 오류인가(ApiError의 status. api-client를 가져오지 않고 모양만 본다) */
export function isUnauthorizedError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 401;
}

/** 오류 이름(type URI의 마지막 경로) */
export function problemName(e: unknown): string | undefined {
  const t = typeof e === 'object' && e !== null ? (e as { type?: unknown }).type : undefined;
  return typeof t === 'string' ? t.split('/').pop() : undefined;
}

export async function retryOnceAfterRefresh<T>(call: () => Promise<T>, isUnauthorized: (e: unknown) => boolean, refresh: () => Promise<boolean>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!isUnauthorized(e) || !(await refresh())) throw e;
    return call();
  }
}
