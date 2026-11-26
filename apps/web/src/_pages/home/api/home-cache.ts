// 내부 HTTP POST /internal/v1/home-cache 처리기 팩토리(HOT-305, ADR-0199).
// core-svc·ops-svc가 'home' 태그를 비울 때만 호출한다. 게이트웨이 밖 내부망 엔드포인트다.
export interface HomeCacheHandlerOptions {
  revalidate: (tag: string, profile: { expire: number }) => void | Promise<void>;
  token: string | undefined;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function createHomeCacheHandler(o: HomeCacheHandlerOptions): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: NO_STORE });
    }
    if (!tokenMatches(request.headers.get('x-peaket-internal-token'), o.token)) {
      return new Response(null, { status: 401, headers: NO_STORE });
    }
    await o.revalidate('home', { expire: 0 });
    return new Response(null, { status: 204, headers: NO_STORE });
  };
}

function tokenMatches(actual: string | null, expected: string | undefined): boolean {
  if (!expected || !actual) return false;
  const len = Math.max(actual.length, expected.length);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}
