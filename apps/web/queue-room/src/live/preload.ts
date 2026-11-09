// 좌석 자원 미리 받기(ADR-0216 결정 2~5, docs/frontend.md §5.1 '차례와 입장'). 차례 1분 [가정] 전 리더 탭이 좌석맵 파일과
// 좌석 화면 자산(/_q/seat-preload.json)을 낮은 우선순위로 받아 HTTP 캐시를 채운다. Safari는 <link rel="prefetch">를 지원하지 않아 fetch로 한다.
// 경로는 서버가 준 값이라도 꼴을 본다(ASVS 1.2.2): 이 회차의 좌석맵 파일과 /_next/static/ 아래 .js·.css만.

/** 좌석 화면 자산 목록(빌드가 만든다, HOT-350) */
export const SEAT_PRELOAD_LIST = '/_q/seat-preload.json';

const SAFE = /^[A-Za-z0-9._~%-]+$/;

/** 대기 상태 파일의 seatmapLayoutPath가 이 회차의 같은 출처 좌석맵 경로면 그대로, 아니면 null */
export function seatmapPath(eventId: string, path: unknown): string | null {
  if (typeof path !== 'string') return null;
  // 판 이름은 계약의 정수 layoutVersion이다(퍼센트로 쓴 점·빗금 같은 것을 받지 않는다)
  const m = /^\/v1\/events\/([^/?#]+)\/seatmap-layouts\/([1-9]\d{0,9})\.json$/.exec(path);
  if (!m || !SAFE.test(m[1]!) || Number(m[2]) > 4_294_967_295) return null;
  return m[1] === encodeURIComponent(eventId) ? path : null;
}

/** /_q/seat-preload.json v1의 자산 가운데 /_next/static/ 아래 .js·.css만 */
export function preloadAssets(body: unknown): string[] {
  const b = body as { v?: unknown; assets?: unknown } | null;
  if (!b || b.v !== 1 || !Array.isArray(b.assets)) return [];
  return b.assets.filter((a): a is string => typeof a === 'string' && /^\/_next\/static\/[A-Za-z0-9._~\/-]+\.(?:js|css)$/.test(a) && !a.includes('..') && !a.includes('//'));
}

type FetchLow = (url: string, init: RequestInit & { priority?: 'low' | 'high' | 'auto' }) => Promise<Response>;

/**
 * 브라우저에서 받는다. 좌석맵은 좌석 화면 Worker와 같은 credentials omit(같은 캐시 항목), 자산은 same-origin,
 * 목록은 빌드마다 바뀌어 no-cache. priority를 모르는 엔진은 무시한다. 실패는 버린다(좌석 화면이 어차피 받는다)
 */
export async function preloadSeat(fetchImpl: FetchLow, layoutPath: string): Promise<void> {
  const quiet = (p: Promise<Response>) => p.then((r) => r.arrayBuffer()).catch(() => undefined);
  await Promise.all([
    quiet(fetchImpl(layoutPath, { priority: 'low', credentials: 'omit' })),
    fetchImpl(SEAT_PRELOAD_LIST, { priority: 'low', credentials: 'same-origin', cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((list: unknown) => Promise.all(preloadAssets(list).map((a) => quiet(fetchImpl(a, { priority: 'low', credentials: 'same-origin' })))))
      .catch(() => undefined),
  ]);
}
