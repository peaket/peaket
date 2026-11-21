// 월렛 서비스 워커의 경로·캐시·메시지 규칙(docs/frontend.md §5.4 '서비스 워커'·'갱신' ①⑤, ASVS 14.3.2, BUILD_ORDER HOT-390).
// app/sw.ts가 이 규칙들을 써서 워커를 만든다. 워커 묶음에 들어가므로 브라우저·워커 표준 API만 쓴다.
// 런타임 캐시 판(docs/frontend.md §5.4 '갱신'의 런타임 캐시 판, §3.12 저장 표, ADR-0336 결정 5): 런타임 캐시는 `wallet-shell-{판}` 하나이고,
// 새 판이 활성화되면 옛 판 캐시의 월렛 문서 주소를 네트워크로 다시 받아 넣은 뒤 옛 판 캐시와 판 없던 옛 이름 둘을 지운다(rotateWalletCaches).
import type { SerwistPlugin } from 'serwist';

/** 페이지 이동 캐시를 받는 두 꼴: `/my/tickets`와 `/my/tickets/{ticketId}`(끝 `/`는 같은 주소) */
const WALLET_DOCUMENT = /^\/my\/tickets(?:\/[^/]+)?\/?$/;

/** 페이지 이동 캐시를 받는 주소인지: `/my/tickets`와 `/my/tickets/{ticketId}` 두 꼴만(끝 `/`는 같은 주소) */
export function isWalletDocumentPath(pathname: string): boolean {
  return WALLET_DOCUMENT.test(pathname);
}

/** 캐시하지 않고 네트워크로만 받는 주소인지: API(`/v1/`)와 워커 자신(`/serwist/`) */
export function isNetworkOnlyPath(pathname: string): boolean {
  return pathname.startsWith('/v1/') || pathname.startsWith('/serwist/');
}

/** `Cache-Control` 지시어 가운데 `no-store`가 있는지(대소문자·쉼표 사이 빈칸 무시) */
function hasNoStore(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  return cacheControl.split(',').some((d) => d.trim().toLowerCase() === 'no-store');
}

/** 응답의 `Cache-Control`에 `no-store`가 있으면 Cache Storage에 넣지 않는다(cacheWillUpdate가 null) */
export const rejectNoStore: SerwistPlugin = {
  async cacheWillUpdate({ response }) {
    return hasNoStore(response.headers.get('cache-control')) ? null : response;
  },
};

/** 창이 보낸 활성화 요청(`{ type: 'SKIP_WAITING' }`)인지 */
export function isSkipWaitingMessage(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING';
}

/** 런타임 캐시 이름의 접두(§3.12 저장 표 `wallet-shell-{판}`) */
export const WALLET_CACHE_PREFIX = 'wallet-shell-';
/** 판 이름이 없던 첫 구현의 런타임 캐시 이름 둘(BAT-350 첫 구현). 새 판이 활성화될 때 지운다 */
export const LEGACY_WALLET_CACHES = ['wallet-pages', 'wallet-assets'] as const;
/** 판 꼴: 공유 캐시의 빌드 칸과 같다(docs/frontend.md §5.18 '공유 캐시 처리기 세부') */
const WALLET_CACHE_VERSION = /^[A-Za-z0-9_-]{1,64}$/;
/** 활성화 때 옛 판 문서를 다시 받는 데 쓰는 전체 시간 [가정](docs/frontend.md §5.4 런타임 캐시 판) */
const WARM_BUDGET_MS = 10_000;

/** 판 값이 정한 꼴(영숫자·`_`·`-` 1~64자)인지 */
export function isWalletCacheVersion(version: string): boolean {
  return typeof version === 'string' && WALLET_CACHE_VERSION.test(version);
}

/** 판을 붙인 런타임 캐시 이름. 꼴 밖이면 던진다 */
export function walletCacheName(version: string): string {
  if (!isWalletCacheVersion(version)) throw new Error(`월렛 런타임 캐시 판이 꼴([A-Za-z0-9_-]{1,64}) 밖이다: ${JSON.stringify(version)}`);
  return `${WALLET_CACHE_PREFIX}${version}`;
}

/** 지울 캐시: 이름이 `wallet-shell-`로 시작하고 지금 판이 아닌 것과 옛 이름 둘. 미리 저장 캐시·이름이 다른 캐시는 남긴다 */
export function staleWalletCaches(names: readonly string[], version: string): string[] {
  const current = walletCacheName(version);
  const legacy: readonly string[] = LEGACY_WALLET_CACHES;
  return names.filter((n) => (n.startsWith(WALLET_CACHE_PREFIX) && n !== current) || legacy.includes(n));
}

/** 다시 받은 응답을 넣어도 되는가: ⑤의 규칙(5xx·`no-store` 거절)에 200·같은 주소(이동 아님)만 */
function warmable(response: Response): boolean {
  if (response.status !== 200 || response.redirected || response.type === 'opaqueredirect' || response.type === 'opaque') return false;
  return !hasNoStore(response.headers.get('cache-control'));
}

export interface RotateWalletCachesOptions {
  caches: CacheStorage;
  fetch: typeof fetch;
  /** 지금 워커의 판(미리 저장 판과 같은 값) */
  version: string;
  /** 다시 받기 전체 시간(기본 10초). 이 시간 안에 본문까지 받지 못한 주소는 넣지 않는다 */
  budgetMs?: number;
  now?: () => number;
}

/**
 * 새 판 활성화(`activate`, `clients.claim()` 전) 때 부른다. ① 옛 판 런타임 캐시에 든 월렛 문서 주소(`/my/tickets`·`/my/tickets/{ticketId}`)를
 * 네트워크로 다시 받아 지금 판 캐시에 넣는다(옛 응답은 옮기지 않는다). ② 지금 판이 아닌 `wallet-shell-` 캐시와 옛 이름 둘을 지운다.
 * 다시 받기가 실패해도 지우기는 한다. 돌려주는 값은 넣은 주소와 지운 캐시 이름이다
 */
export async function rotateWalletCaches(o: RotateWalletCachesOptions): Promise<{ warmed: string[]; deleted: string[] }> {
  const now = o.now ?? (() => Date.now());
  const budgetMs = o.budgetMs ?? WARM_BUDGET_MS;
  const current = walletCacheName(o.version);
  const stale = staleWalletCaches(await o.caches.keys(), o.version);
  const urls = new Set<string>();
  for (const name of stale) {
    try {
      const cache = await o.caches.open(name);
      for (const request of await cache.keys()) {
        if (isWalletDocumentPath(new URL(request.url).pathname)) urls.add(request.url);
      }
    } catch {
      // 옛 캐시를 읽지 못하면 그 주소는 다시 받지 않는다(지우기는 한다)
    }
  }
  const warmed: string[] = [];
  if (urls.size > 0) {
    const target = await o.caches.open(current);
    const started = now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), budgetMs);
    try {
      // 하나씩 차례로 받는다(옛 캐시에서 읽은 차례). 처음부터 다 합쳐 budgetMs가 지나면 남은 주소는 받지 않는다
      for (const url of urls) {
        if (now() - started >= budgetMs) break;
        try {
          const response = await o.fetch(url, { cache: 'reload', credentials: 'same-origin', signal: timeout.signal });
          if (!warmable(response)) continue;
          // 본문까지 받은 뒤 시간을 본다(다 합쳐 budgetMs 안에 받은 주소만 넣는다)
          const body = await response.arrayBuffer();
          if (now() - started >= budgetMs) continue;
          await target.put(url, new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
          warmed.push(url);
        } catch {
          // 끊김·시간 초과는 넣지 않는다
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const deleted: string[] = [];
  for (const name of stale) {
    try {
      if (await o.caches.delete(name)) deleted.push(name);
    } catch {
      // 지우지 못한 캐시는 다음 활성화 때 다시 지운다
    }
  }
  return { warmed, deleted };
}
