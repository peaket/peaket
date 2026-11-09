// api-client 밖의 손 호출 한 번(docs/frontend.md §4.1 'api-client 밖의 호출', 2026-11-06 BOT-044 뒤처리).
// - 시간 초과는 §4.1의 값(읽기 10초, 쓰기 15초)이고 본문을 다 읽을 때까지 센다. 끝나면 타이머를 지운다(가짜 시계로 시험한다).
// - read가 읽지 않은 본문은 버린다. Chromium은 fetch 응답의 본문을 읽거나 버리기 전에는 그 요청을 끝난 것으로 보지 않는다.
// 로그인한 기기 흐름과 토큰 갱신(token-refresh.ts)이 쓴다. 경로 별칭이 없어 node 시험이 바로 읽는다.

export const READ_TIMEOUT_MS = 10_000;
export const WRITE_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** GET·HEAD는 읽기, 그 밖은 쓰기 한도 */
export const timeoutFor = (method: string | undefined): number => (!method || method === 'GET' || method === 'HEAD' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);

/**
 * 한 번 보내고 read로 읽는다. 시간 초과·연결 실패는 던진다(TimeoutError·TypeError). read가 던져도 남은 본문은 버린다.
 * init.signal은 쓰지 않는다(이 함수의 시간 초과 신호를 싣는다)
 */
export async function fetchOnce<T>(fetch: FetchLike, url: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('시간 초과', 'TimeoutError')), timeoutFor(init.method));
  try {
    const r = await fetch(url, { ...init, signal: timeout.signal });
    try {
      return await read(r);
    } finally {
      // 버리기는 기다리지 않는다: cancel이 끝나지 않는 드문 경우에도 부르는 쪽(갱신 잠금 안)이 멈추지 않는다(리뷰 2026-11-06)
      if (r.body && !r.bodyUsed) void r.body.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
  }
}
