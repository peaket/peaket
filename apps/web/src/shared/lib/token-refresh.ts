// 팬 액세스 토큰 갱신 한 번(POST /v1/identity/access-tokens)의 결과를 셋으로 나눈다(docs/frontend.md §4.1 '401').
// 401만 갱신 거절(세션이 끝남 → 로그인 화면)이고, 연결 끊김·5xx 같은 그 밖은 일시 장애(로그인 화면으로 보내지 않고 '잠시 뒤 다시')다.
// 본인확인·탈퇴·로그인 수단 흐름이 함께 쓴다(2026-11-05, 새 맥락 리뷰). 잠금(refresh-lock)은 부르는 쪽이 씌운다. 경로 별칭이 없어 node 시험이 바로 읽는다.
// 쓰기 한도(15초) 안에 답이 없으면 일시 장애다. 잠금을 쥔 채 멈추면 다른 탭의 갱신까지 멈춘다. 401 본문은 세션 종료 사유(ended)를 읽고, 그 밖의 본문은 쓰지 않으므로 버린다(§4.1 'api-client 밖의 호출', 2026-11-06, ADR-0235).
import { fetchOnce } from './timed-fetch.ts';

export type RefreshResult = 'ok' | 'rejected' | 'unavailable';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 로그인 화면이 받는 팬 세션 종료 사유(d5 §3.5, ADR-0235 결정 2). 다른 값은 싣지 않는다 */
const ENDED_REASONS: ReadonlySet<string> = new Set(['LOGOUT', 'ADMIN_FORCE', 'REFRESH_REUSE', 'DEVICE_LIMIT', 'MERGED', 'DELETE', 'LOGIN_METHOD_CHANGED']);

/** 이 문서가 받은 마지막 세션 종료 사유. 문서를 벗어나면 잊는다 */
let endedReason: string | null = null;

/**
 * 허용 목록의 사유가 있을 때만 덮어쓴다. 첫 거절이 쿠키를 지우면 뒤따른 갱신은 사유 없는 401이라, 그 답으로 지우면 안내를 잃는다.
 * 기억한 사유를 지우는 것은 갱신이 성공했을 때(살아 있는 세션)뿐이다
 */
async function rememberEnded(r: Response): Promise<void> {
  try {
    const body: unknown = await r.json();
    const ended = typeof body === 'object' && body !== null ? (body as { ended?: unknown }).ended : undefined;
    if (typeof ended === 'string' && ENDED_REASONS.has(ended)) endedReason = ended;
  } catch {
    // 본문이 JSON이 아니면 사유를 모르는 거절이다
  }
}

/** 기억한 세션 종료 사유를 꺼낸다(꺼내면 지운다). 없으면 null */
export function takeSessionEndedReason(): string | null {
  const r = endedReason;
  endedReason = null;
  return r;
}

/** 갱신이 거절된 뒤 로그인 화면으로 갈 주소(docs/frontend.md §3 '세션이 끝났을 때', ADR-0235 결정 2) */
export function loginHrefAfterRefresh(next: string): string {
  const ended = takeSessionEndedReason();
  return `/login?next=${encodeURIComponent(next)}${ended ? `&ended=${ended}` : ''}`;
}

export async function refreshOnce(fetch: FetchLike, url: string): Promise<RefreshResult> {
  try {
    return await fetchOnce(fetch, url, { method: 'POST', credentials: 'include', cache: 'no-store' }, async (r) => {
      if (r.ok) {
        endedReason = null;
        return 'ok';
      }
      if (r.status !== 401) return 'unavailable';
      await rememberEnded(r);
      return 'rejected';
    });
  } catch {
    return 'unavailable';
  }
}
