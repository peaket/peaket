// 미리 그린 화면 캐시용 Next.js cacheHandler(docs/frontend.md §5.17 '공유 캐시 처리기 세부', BUILD_ORDER HOT-390).
// PEAKET_WEB_CACHE_REDIS_URL의 Redis(Valkey)에 `web:isr:{캐시 키}`로 두고, 태그 무효화 시각은 'use cache' 처리기와 같은 키를 쓴다.
// 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7, ADR-0270 결정 3). 동작은 구현 담당이 쓴다.
export default class CacheHandler {
  constructor(ctx) {
    void ctx;
  }
  async get(cacheKey, ctx) {
    void cacheKey, ctx;
    throw new Error('아직 없음');
  }
  async set(cacheKey, data, ctx) {
    void cacheKey, data, ctx;
    throw new Error('아직 없음');
  }
  async revalidateTag(tags, durations) {
    void tags, durations;
    throw new Error('아직 없음');
  }
  resetRequestCache() {}
}
