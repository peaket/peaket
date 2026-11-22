// 팬 API 손 호출 한 번과 401 뒤 갱신 한 번(docs/frontend.md §4.1 '401'·'api-client 밖의 호출'). 로그인한 기기 흐름(features/device-sessions/flow.ts)의
// call과 같은 규칙을 현장 스태프 화면 흐름(초대 수락·스캐너 승인·내 현장 배정, BUILD_ORDER F-05-7, ADR-0362)이 함께 쓴다.
// - 보내고 401이면 토큰을 한 번 갱신하고 다시 보낸다. 갱신이 401로 거절되거나 다시 401이면 'login', 갱신이 일시 장애(연결 끊김·5xx)면 'unavailable'이다.
// - 시간 한도(읽기 10초·쓰기 15초)는 본문을 다 읽을 때까지 세고, 읽지 않은 본문(401 포함)은 버린다(shared/lib/timed-fetch.ts).
// 경로 별칭 없이 상대 경로로 가져온다(node 시험이 바로 읽는다).
import { fetchOnce } from './timed-fetch.ts';
import { refreshOnce, type RefreshResult } from './token-refresh.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FanCaller {
  /** 액세스 토큰 갱신(재인증 양식을 보내기 직전 등) */
  refresh(): Promise<RefreshResult>;
  /** 401이 아닌 응답은 read가 읽는다. 연결 실패·시간 초과는 던진다 */
  call<T>(path: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<T | 'login' | 'unavailable'>;
}

/** origin: API 출처(gw-fan). lock: 토큰 갱신을 창끼리 하나씩(본인확인·탈퇴·로그인한 기기 흐름과 같은 잠금) */
export function createFanCaller(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): FanCaller {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const url = (p: string) => `${o.origin}${p}`;
  const refresh = (): Promise<RefreshResult> => lock(() => refreshOnce(o.fetch, url('/v1/identity/access-tokens')));
  return {
    refresh,
    async call<T>(path: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<T | 'login' | 'unavailable'> {
      const UNAUTHORIZED = Symbol('401');
      const readOr401 = async (r: Response): Promise<T | typeof UNAUTHORIZED> => (r.status === 401 ? UNAUTHORIZED : read(r));
      const send = () => fetchOnce(o.fetch, url(path), { credentials: 'include', cache: 'no-store', ...init }, readOr401);
      const first = await send();
      if (first !== UNAUTHORIZED) return first;
      const refreshed = await refresh();
      if (refreshed === 'rejected') return 'login';
      if (refreshed !== 'ok') return 'unavailable';
      const second = await send();
      return second === UNAUTHORIZED ? 'login' : second;
    },
  };
}

/** 문제 상세 type의 끝(예: …/problems/session-not-found → session-not-found). 본문이 JSON이 아니면 '' */
export async function problemTypeOf(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}
