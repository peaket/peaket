// 팬 액세스 토큰 갱신 한 번(POST /v1/identity/access-tokens)의 결과를 셋으로 나눈다(docs/frontend.md §4.1 '401').
// 401만 갱신 거절(세션이 끝남 → 로그인 화면)이고, 연결 끊김·5xx 같은 그 밖은 일시 장애(로그인 화면으로 보내지 않고 '잠시 뒤 다시')다.
// 본인확인·탈퇴·로그인 수단 흐름이 함께 쓴다(2026-11-05, 새 맥락 리뷰). 잠금(refresh-lock)은 부르는 쪽이 씌운다. 경로 별칭이 없어 node 시험이 바로 읽는다.
// 쓰기 한도(15초) 안에 답이 없으면 일시 장애다. 잠금을 쥔 채 멈추면 다른 탭의 갱신까지 멈춘다. 본문은 쓰지 않으므로 버린다(§4.1 'api-client 밖의 호출', 2026-11-06).
import { fetchOnce } from './timed-fetch.ts';

export type RefreshResult = 'ok' | 'rejected' | 'unavailable';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function refreshOnce(fetch: FetchLike, url: string): Promise<RefreshResult> {
  try {
    return await fetchOnce(fetch, url, { method: 'POST', credentials: 'include', cache: 'no-store' }, async (r) => (r.ok ? 'ok' : r.status === 401 ? 'rejected' : 'unavailable'));
  } catch {
    return 'unavailable';
  }
}
