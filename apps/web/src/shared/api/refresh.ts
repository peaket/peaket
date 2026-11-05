// 팬 요청의 401 다루기(docs/frontend.md §4.1 '401', ADR-0199 결정 3): 401이면 토큰을 한 번 갱신하고 원래 요청을 한 번 더 보낸다.
// 갱신이 401로 거절되거나 다시 401이면 그 401을 던진다(부르는 쪽이 비로그인으로 본다). 갱신이 일시 장애(연결 끊김·5xx)면 401이 아닌 오류를
// 던져 비로그인으로 바꾸지 않게 한다(새 맥락 재검토). 갱신 자체는 다시 보내지 않는다. 순수 함수라 바로 시험한다.
import type { RefreshResult } from '../lib/token-refresh.ts';
/** 401 응답 오류인가(ApiError의 status. api-client를 가져오지 않고 모양만 본다) */
export function isUnauthorizedError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 401;
}

/** 오류 이름(type URI의 마지막 경로) */
export function problemName(e: unknown): string | undefined {
  const t = typeof e === 'object' && e !== null ? (e as { type?: unknown }).type : undefined;
  return typeof t === 'string' ? t.split('/').pop() : undefined;
}

/** 갱신이 일시 장애로 끝났을 때 던지는 오류(401이 아니다. 화면은 '잠시 뒤 다시') */
export function refreshUnavailableError(): Error & { status: 503; type: string } {
  return Object.assign(new Error('토큰 갱신이 일시 장애로 끝났다'), { status: 503 as const, type: 'https://peaket.example/problems/refresh-unavailable' });
}

/** 갱신이 일시 장애로 끝난 오류인가(refreshUnavailableError). 다시 불러오기 상태가 없는 첫 조회는 이때 비로그인 모양으로 둔다 */
export function isRefreshUnavailableError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 503 && problemName(e) === 'refresh-unavailable';
}

export async function retryOnceAfterRefresh<T>(call: () => Promise<T>, isUnauthorized: (e: unknown) => boolean, refresh: () => Promise<RefreshResult>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    const r = await refresh();
    if (r === 'rejected') throw e;
    if (r !== 'ok') throw refreshUnavailableError();
    return call();
  }
}
