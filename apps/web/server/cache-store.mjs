// 소비자 웹 공유 캐시 저장소(docs/frontend.md §5.17 '공유 캐시 처리기 세부', docs/data.md 세션·캐시 클러스터 키 이름, BUILD_ORDER HOT-390).
// 미리 그린 화면 캐시(cache-handler.mjs)와 'use cache' 처리기(use-cache-handler.mjs)가 같은 Redis(Valkey)에 이 저장소로 읽고 쓴다.
// 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7, ADR-0270 결정 3). 동작은 구현 담당이 쓴다.

/**
 * @param {{ client: unknown, timeoutMs?: number, now?: () => number, maxTtlSeconds?: number }} o
 * @returns {{
 *   getEntry(kind: 'isr' | 'data', key: string): Promise<unknown>,
 *   setEntry(kind: 'isr' | 'data', key: string, value: unknown, expireSeconds: number): Promise<void>,
 *   tagTimes(tags: string[]): Promise<unknown>,
 *   markTags(tags: string[], at: number): Promise<void>,
 * }}
 */
export function createCacheStore(o) {
  void o;
  throw new Error('아직 없음');
}

/** next.config.ts에 펼칠 캐시 설정. 주소가 없으면 빈 객체 */
export function cacheConfig(env = process.env) {
  void env;
  throw new Error('아직 없음');
}

/** PEAKET_ENV가 staging·prod인데 주소가 없으면 던진다(server/start.mjs가 처음에 부른다) */
export function assertCacheEnv(env = process.env) {
  void env;
  throw new Error('아직 없음');
}
