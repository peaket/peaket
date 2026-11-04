// 소비자 웹의 API 클라이언트(docs/frontend.md §4.1, ADR-0196, ADR-0199 결정 3, BUILD_ORDER HOT-300).
// 화면 부품은 이 파일과 생성 호출 함수를 늦게 가져온다(await import). 첫 화면 JS 예산(§5.8)에 실행부·작업 서술 표가 들지 않게 한다.
// 생성 호출 함수(@peaket/api-client/endpoints/<태그>)는 setOrvalClient로 꽂은 클라이언트 하나로 같은 실행 정책(시간 초과·재시도·멱등 키)을 탄다.
// setOrvalClient는 이 파일만 부른다(린트가 막는다). 한 실행 환경에 클라이언트는 하나이고, 앱이 쓰는 호스트를 모두 담아 한 번에 만든다
// (화면마다 따로 꽂으면 먼저 꽂은 쪽 설정에 다른 화면의 호스트가 빠진다, HOT-300 새 맥락 리뷰 중간 3).
// - 서버: 공개 값(홈 피드)만 부른다. 쿠키·요청 머리를 싣지 않는다(캐시 화면 HTML에 개인 값이 섞이지 않게). 요청마다 다른 값이 필요한 호출은 이 클라이언트를 쓰지 않는다.
//   주소는 PEAKET_API_ORIGIN(앱 서버가 gw-fan을 부르는 주소). 없으면 부르지 않고 빈 피드로 그린다. 빌드가 아닌 실행 중에 없으면 경고를 남긴다(배포 설정 누락).
// - 브라우저: 개인 값(찜·알림)을 부른다. 팬 API는 NEXT_PUBLIC_API_ORIGIN(ORIGINS.api), 같은 출처 정적 파일(www)은 지금 출처다.
//   팬 요청이 401이면 토큰을 한 번 갱신하고 다시 보낸다(§4.1 '401', withFanRefresh).
import { createApiClient, setOrvalClient } from '@peaket/api-client';
import { ORIGINS } from '@/shared/config/origins';
import { isUnauthorizedError, retryOnceAfterRefresh } from './refresh';

let serverReady = false;
let browserReady = false;
let warned = false;

/** 서버에서 부를 API 주소. 없으면 undefined(부르지 않는다) */
export function serverApiOrigin(): string | undefined {
  const o = process.env.PEAKET_API_ORIGIN?.trim();
  return o ? o : undefined;
}

/** 서버 쪽 클라이언트를 꽂는다. 주소가 없으면 false(빌드 밖이면 한 번 경고한다) */
export function ensureServerApi(): boolean {
  const api = serverApiOrigin();
  if (!api) {
    if (!warned && process.env.NEXT_PHASE !== 'phase-production-build' && process.env.NODE_ENV === 'production') {
      warned = true;
      console.warn(JSON.stringify({ level: 'warn', kind: 'home-feed', msg: 'PEAKET_API_ORIGIN이 없어 홈 피드를 부르지 않고 빈 피드로 그린다(배포 설정을 확인한다)' }));
    }
    return false;
  }
  if (!serverReady) {
    setOrvalClient(createApiClient({ baseUrls: { api } }));
    serverReady = true;
  }
  return true;
}

/** 브라우저 쪽 클라이언트(앱이 쓰는 호스트 전부)를 한 번 꽂는다. 서버에서 부르면 false */
export function ensureBrowserApi(): boolean {
  if (typeof window === 'undefined') return false;
  if (!browserReady) {
    const hosts = { api: ORIGINS.api, queue: ORIGINS.queue, 'queue-files': ORIGINS.queueFiles, www: window.location.origin };
    setOrvalClient(createApiClient({ baseUrls: Object.fromEntries(Object.entries(hosts).filter(([, v]) => v)) }));
    browserReady = true;
  }
  return true;
}

/** 팬 API를 부를 수 있는가(개발 서버에서 주소를 넣지 않았으면 개인 값은 비로그인처럼 둔다) */
export const fanApiAvailable = (): boolean => ORIGINS.api !== '';

/** 토큰 갱신을 창끼리 하나씩(Web Locks, 다른 기능과 같은 잠금 이름). 같은 리프레시 토큰으로 두 창이 갱신하면 재사용 탐지에 걸린다 */
const REFRESH_LOCK = 'peaket.refresh';
let refreshing: Promise<boolean> | null = null;

/** 팬 액세스 토큰 갱신(POST /v1/identity/access-tokens). 성공하면 true. 같은 창의 동시 갱신은 하나로 묶는다 */
export function refreshFanToken(): Promise<boolean> {
  refreshing ??= (async () => {
    const run = async () => {
      try {
        const r = await fetch(`${ORIGINS.api}/v1/identity/access-tokens`, { method: 'POST', credentials: 'include', cache: 'no-store' });
        return r.ok;
      } catch {
        return false;
      }
    };
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    try {
      return locks ? ((await locks.request(REFRESH_LOCK, run)) as boolean) : await run();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const isUnauthorized = isUnauthorizedError;

/** 팬 요청: 401이면 한 번 갱신하고 다시 보낸다. 갱신이 안 되거나 다시 401이면 그 401을 던진다(부르는 쪽이 비로그인으로 본다) */
export function withFanRefresh<T>(call: () => Promise<T>): Promise<T> {
  return retryOnceAfterRefresh(call, isUnauthorized, refreshFanToken);
}

export { isUnauthorized };
