// 도메인 층: 소비자 웹(Next.js) 홈 캐시 무효화 포트(HOT-305, ADR-0199). 어댑터가 내부 HTTP로 구현한다.
export const NEXT_CACHE_INVALIDATOR = Symbol('NEXT_CACHE_INVALIDATOR');

export type HomeCacheInvalidationReason =
  | 'SALE_APPROVED'
  | 'SALE_SUSPENDED'
  | 'EVENT_CANCELLED'
  | 'HOME_LAYOUT_SAVED'
  | 'SOLD_OUT';

export interface NextCacheInvalidator {
  revalidate(tag: 'home'): Promise<void>;
}
