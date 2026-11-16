// 'use cache'용 Next.js 16 cacheHandlers.default 처리기(docs/frontend.md §5.18 '공유 캐시 처리기 세부', BUILD_ORDER HOT-390).
// 기본 내보내기는 PEAKET_WEB_CACHE_REDIS_URL로 붙는 처리기 객체(get·set·refreshTags·getExpiration·updateTags)다.
// createUseCacheHandler는 저장소와 시계를 받아 같은 처리기를 만든다(단위 시험이 가짜 Redis·가짜 시계로 부른다).
// - 값은 `web:data:<캐시 키>`에 JSON(메타 + base64 본문)으로, TTL은 항목의 만료와 30일 [가정] 가운데 짧은 쪽이다.
// - 태그를 무효화하면(updateTags) 그 시각을 `web:{tag}:<태그>`에 쓴다. 읽을 때(get) 항목의 태그 시각을 한 번에 읽어 그보다 먼저 만든
//   값은 없는 것으로 본다. 다른 파드도 같은 키를 읽으므로 refreshTags는 할 일이 없고 getExpiration은 Redis의 시각을 그대로 준다.
// - Redis가 늦거나 끊기면 읽기는 없음, 쓰기는 버림이다(저장소가 정한다). 개인 값을 읽는 함수에는 'use cache'를 쓰지 않는다(ASVS 14.2.2).
import { createCacheStore, createLazyRedis, CACHE_URL_ENV } from './cache-store.mjs';

/** 받은 흐름을 끝까지 읽어 한 덩어리로 */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** 바이트로 새 흐름을 만든다(get마다 새 흐름) */
function streamFrom(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/**
 * @param {{ store: ReturnType<typeof import('./cache-store.mjs').createCacheStore>, now?: () => number }} o
 * @returns {import('next/dist/server/lib/cache-handlers/types').CacheHandler}
 */
export function createUseCacheHandler({ store, now = Date.now }) {
  /** 같은 키를 쓰는 중이면 get이 그 쓰기를 기다린다(Next.js 처리기 규칙). 요청이 끝나면 지운다 */
  const pending = new Map();
  return {
    async get(cacheKey) {
      const writing = pending.get(cacheKey);
      if (writing) await writing;
      const raw = await store.getEntry('data', cacheKey);
      if (raw == null) return undefined;
      let meta;
      try {
        meta = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      } catch {
        return undefined;
      }
      const tags = Array.isArray(meta.tags) ? meta.tags : [];
      if (tags.length > 0) {
        const times = await store.tagTimes(tags);
        // 태그 시각을 읽지 못하면 값을 믿을 수 없어 없는 것으로 본다
        if (times === null) return undefined;
        for (const t of tags) if ((times.get(t) ?? 0) > meta.timestamp) return undefined;
      }
      return {
        value: streamFrom(Buffer.from(meta.value, 'base64')),
        tags,
        stale: meta.stale,
        timestamp: meta.timestamp,
        expire: meta.expire,
        revalidate: meta.revalidate,
      };
    },

    async set(cacheKey, pendingEntry) {
      let done = () => {};
      pending.set(
        cacheKey,
        new Promise((r) => {
          done = r;
        }),
      );
      try {
        const entry = await pendingEntry;
        // 운영에서 expire 0은 읽을 때마다 새로 만드는 값이라 저장하지 않는다(Next.js 기본 처리기와 같다)
        if (!process.env.__NEXT_DEV_SERVER && entry.expire === 0) return;
        const body = await streamToBuffer(entry.value);
        const meta = { tags: entry.tags, stale: entry.stale, timestamp: entry.timestamp, expire: entry.expire, revalidate: entry.revalidate, value: body.toString('base64') };
        await store.setEntry('data', cacheKey, JSON.stringify(meta), entry.expire);
      } catch {
        // 흐름이 깨지면 그 항목은 버린다
      } finally {
        done();
        pending.delete(cacheKey);
      }
    },

    async refreshTags() {
      // 태그 시각은 get·getExpiration이 Redis에서 바로 읽는다(파드마다 들고 있는 목록이 없다)
    },

    async getExpiration(tags) {
      if (tags.length === 0) return 0;
      const times = await store.tagTimes(tags);
      if (times === null) return 0;
      return Math.max(0, ...tags.map((t) => times.get(t) ?? 0));
    },

    async updateTags(tags) {
      // durations(stale-while-revalidate)는 쓰지 않고 바로 만료로 본다(공유 캐시에서 옛 값을 다시 내지 않는 쪽)
      if (tags.length === 0) return;
      await store.markTags(tags, now());
    },
  };
}

const url = process.env[CACHE_URL_ENV]?.trim();

/** @type {import('next/dist/server/lib/cache-handlers/types').CacheHandler} */
const handler = url
  ? createUseCacheHandler({ store: createCacheStore({ client: createLazyRedis(url) }) })
  : {
      // 주소 없이 이 모듈을 불렀다(설정 실수). 캐시 없이 원본으로 그린다
      get: async () => undefined,
      set: async () => {},
      refreshTags: async () => {},
      getExpiration: async () => 0,
      updateTags: async () => {},
    };
export default handler;
