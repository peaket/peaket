// 미리 그린 화면 캐시용 Next.js cacheHandler(docs/frontend.md §5.18 '공유 캐시 처리기 세부', BUILD_ORDER HOT-390).
// PEAKET_WEB_CACHE_REDIS_URL의 Redis(Valkey)에 `web:isr:<캐시 키>`로 두고, 태그 무효화 시각은 'use cache' 처리기와 같은 키
// (`web:{tag}:<태그>`)를 쓴다. 그래서 어느 파드가 revalidateTag를 불러도 다른 파드가 그 시각보다 먼저 만든 화면을 없는 것으로 본다.
// - 값: { lastModified, cacheControl, tags, value } JSON. Buffer·Uint8Array·Map(RSC 조각)은 글자로 바꿔 담고 읽을 때 되돌린다.
// - TTL: cacheControl.expire와 30일 [가정] 가운데 짧은 쪽(만료가 없으면 30일). 1MB [가정]가 넘는 화면은 쓰지 않는다.
// - Redis가 늦거나 끊기면 get은 null(원본으로 그린다), set·revalidateTag는 버린다. 던지지 않는다.
import { createCacheStore, createLazyRedis, CACHE_URL_ENV } from './cache-store.mjs';

/** Next.js 캐시 태그 머리(next/dist/lib/constants NEXT_CACHE_TAGS_HEADER) */
const TAGS_HEADER = 'x-next-cache-tags';

/** JSON에 담을 수 없는 값(Buffer·Uint8Array·Map)을 표시한 객체로 바꾼다 */
function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Uint8Array) return { __peaketB64: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') };
  if (raw instanceof Map) return { __peaketMap: [...raw.entries()] };
  return value;
}
function reviver(_key, value) {
  if (value && typeof value === 'object') {
    if (typeof value.__peaketB64 === 'string') return Buffer.from(value.__peaketB64, 'base64');
    if (Array.isArray(value.__peaketMap)) return new Map(value.__peaketMap);
  }
  return value;
}

/** 저장한 값이 가진 태그: 화면·경로는 태그 머리, fetch 값은 그 태그 */
function tagsOfValue(data) {
  if (!data || typeof data !== 'object') return [];
  const header = data.headers?.[TAGS_HEADER];
  if (typeof header === 'string') return header.split(',').map((t) => t.trim()).filter(Boolean);
  if (Array.isArray(data.tags)) return data.tags.filter((t) => typeof t === 'string');
  return [];
}

/** 모듈마다 저장소 하나(파드 하나). 주소가 없으면 null(캐시 없이 원본) */
const url = process.env[CACHE_URL_ENV]?.trim();
const store = url ? createCacheStore({ client: createLazyRedis(url) }) : null;

export default class CacheHandler {
  /** @param {{ revalidatedTags?: string[] }} ctx */
  constructor(ctx) {
    /** 이 요청 안에서 무효화한 태그(Next.js가 넘긴다). 읽을 때 바로 없는 것으로 본다 */
    this.revalidatedTags = Array.isArray(ctx?.revalidatedTags) ? ctx.revalidatedTags : [];
  }

  async get(cacheKey, ctx) {
    if (!store) return null;
    const raw = await store.getEntry('isr', cacheKey);
    if (raw == null) return null;
    let entry;
    try {
      entry = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw), reviver);
    } catch {
      return null;
    }
    const tags = [...new Set([...(entry.tags ?? []), ...(Array.isArray(ctx?.tags) ? ctx.tags : []), ...(Array.isArray(ctx?.softTags) ? ctx.softTags : [])])];
    if (tags.length > 0) {
      if (tags.some((t) => this.revalidatedTags.includes(t))) return null;
      const times = await store.tagTimes(tags);
      if (times === null) return null;
      for (const t of tags) if ((times.get(t) ?? 0) > entry.lastModified) return null;
    }
    return { lastModified: entry.lastModified, value: entry.value ?? null, ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}) };
  }

  async set(cacheKey, data, ctx) {
    if (!store) return;
    try {
      const cacheControl = ctx?.fetchCache ? undefined : ctx?.cacheControl;
      const tags = [...new Set([...tagsOfValue(data), ...(Array.isArray(ctx?.tags) ? ctx.tags : [])])];
      const entry = { lastModified: Date.now(), cacheControl, tags, value: data ?? null };
      const expire = cacheControl?.expire ?? (typeof ctx?.revalidate === 'number' ? ctx.revalidate : undefined);
      await store.setEntry('isr', cacheKey, JSON.stringify(entry, replacer), expire);
    } catch {
      // 담을 수 없는 값이면 버린다(원본으로 다시 그린다)
    }
  }

  async revalidateTag(tags, _durations) {
    if (!store) return;
    const list = (typeof tags === 'string' ? [tags] : (tags ?? [])).filter((t) => typeof t === 'string' && t !== '');
    if (list.length === 0) return;
    // durations(stale-while-revalidate)는 쓰지 않고 바로 만료로 본다('use cache' 처리기와 같다)
    await store.markTags(list, Date.now());
  }

  resetRequestCache() {}
}
