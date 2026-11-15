// 'use cache'용 Next.js 16 cacheHandlers.default 처리기(docs/frontend.md §5.17 '공유 캐시 처리기 세부', BUILD_ORDER HOT-390).
// 기본 내보내기는 PEAKET_WEB_CACHE_REDIS_URL로 붙는 처리기 객체(get·set·refreshTags·getExpiration·updateTags)다.
// createUseCacheHandler는 저장소와 시계를 받아 같은 처리기를 만든다(단위 시험이 가짜 Redis·가짜 시계로 부른다).
// 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7, ADR-0270 결정 3). 동작은 구현 담당이 쓴다.

/**
 * @param {{ store: ReturnType<typeof import('./cache-store.mjs').createCacheStore>, now?: () => number }} o
 * @returns {import('next/dist/server/lib/cache-handlers/types').CacheHandler}
 */
export function createUseCacheHandler(o) {
  void o;
  throw new Error('아직 없음');
}

const notYet = async () => {
  throw new Error('아직 없음');
};

/** @type {import('next/dist/server/lib/cache-handlers/types').CacheHandler} */
const handler = { get: notYet, set: notYet, refreshTags: notYet, getExpiration: notYet, updateTags: notYet };
export default handler;
