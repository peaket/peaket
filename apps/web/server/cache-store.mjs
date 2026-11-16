// 소비자 웹 공유 캐시 저장소(docs/frontend.md §5.18 '공유 캐시 처리기 세부', docs/data.md 세션·캐시 클러스터 키 이름, BUILD_ORDER HOT-390).
// 미리 그린 화면 캐시(cache-handler.mjs)와 'use cache' 처리기(use-cache-handler.mjs)가 같은 Redis(Valkey)에 이 저장소로 읽고 쓴다.
// - 키: 미리 그린 화면 `web:isr:<캐시 키>`, 'use cache' 값 `web:data:<캐시 키>`, 태그를 마지막으로 무효화한 시각(ms) `web:{tag}:<태그>`.
//   둘째 칸(isr·data·{tag})이 달라 어떤 캐시 키·태그도 겹치지 않는다. `{tag}`는 글자 그대로 쓰는 클러스터 해시 태그라 모든 태그 키가
//   한 슬롯에 모여 여러 태그를 MGET 한 번으로 읽는다(클러스터 모드의 CROSSSLOT 막기). 값 키는 하나씩만 읽고 쓴다.
// - 모든 키에 TTL: 값은 그 항목의 만료와 상한(30일 [가정]) 가운데 짧은 쪽, 태그 시각은 상한(ADR-0109 '모든 키에 TTL').
// - Redis가 시간 한도(100ms [가정]) 안에 답하지 않거나 끊기면 읽기는 없음(null), 쓰기는 버린다. 던지지 않는다(키 등급 A, docs/data.md).
import { createClient } from 'redis';

// 환경 확인·next.config 설정은 Redis 없이 읽는 cache-env.mjs에 두고 여기서 함께 내보낸다(server/start.mjs·next.config.ts가 가볍게 부른다)
export { assertCacheEnv, cacheConfig, CACHE_URL_ENV } from './cache-env.mjs';

/** 값·태그 시각 TTL 상한: 30일 [가정](docs/frontend.md §5.18) */
export const DEFAULT_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Redis 시간 한도: 100ms [가정](docs/frontend.md §5.18) */
export const DEFAULT_TIMEOUT_MS = 100;
/** 값 하나의 크기 상한: 1MB [가정](docs/data.md 세션·캐시 클러스터 메모리 규칙 'ISR 항목 1MB'). 넘으면 쓰지 않는다 */
export const MAX_ENTRY_BYTES = 1024 * 1024;

const KINDS = new Set(['isr', 'data']);
const valueKey = (kind, key) => {
  if (!KINDS.has(kind)) throw new Error(`공유 캐시 종류가 틀렸다: ${kind}`);
  return `web:${kind}:${key}`;
};
const tagKey = (tag) => `web:{tag}:${tag}`;

/** 약속이 ms 안에 끝나지 않거나 거절되면 fallback으로 끝낸다. 타이머는 프로세스를 붙잡지 않는다 */
function within(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * @param {{ client: { get(k: string): Promise<unknown>, set(k: string, v: string, o: object): Promise<unknown>, mGet(keys: string[]): Promise<unknown[]> },
 *   timeoutMs?: number, now?: () => number, maxTtlSeconds?: number }} o
 */
export function createCacheStore({ client, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS }) {
  /** 값 TTL(초): 항목의 만료와 상한 가운데 짧은 쪽. 만료가 없거나 숫자가 아니면 상한, 1초보다 짧으면 1초 */
  const ttlOf = (expireSeconds) => {
    const e = Number(expireSeconds);
    const ttl = Number.isFinite(e) && e > 0 ? Math.min(Math.ceil(e), maxTtlSeconds) : maxTtlSeconds;
    return Math.max(1, ttl);
  };
  const run = (fn, fallback) => {
    let p;
    try {
      p = fn();
    } catch {
      return Promise.resolve(fallback);
    }
    return within(p, timeoutMs, fallback);
  };
  return {
    /** 값 하나를 읽는다. 없거나 한도 안에 답하지 않으면 null */
    getEntry(kind, key) {
      const k = valueKey(kind, key);
      return run(() => client.get(k), null).then((v) => v ?? null);
    },
    /** 값 하나를 TTL과 함께 쓴다. 한도 안에 답하지 않거나 끊기면 버린다 */
    async setEntry(kind, key, value, expireSeconds) {
      const k = valueKey(kind, key);
      if (typeof value === 'string' && Buffer.byteLength(value) > MAX_ENTRY_BYTES) return;
      await run(() => client.set(k, value, { expiration: { type: 'EX', value: ttlOf(expireSeconds) } }), undefined);
    },
    /** 태그마다 마지막 무효화 시각(ms, 기록 없으면 0)을 MGET 한 번으로 읽는다. 읽지 못하면 null */
    async tagTimes(tags) {
      const list = [...new Set(tags)];
      const out = new Map();
      if (list.length === 0) return out;
      const values = await run(() => client.mGet(list.map(tagKey)), null);
      if (!Array.isArray(values)) return null;
      list.forEach((t, i) => {
        const n = Number(values[i] == null ? 0 : String(values[i]));
        out.set(t, Number.isFinite(n) ? n : 0);
      });
      return out;
    },
    /** 태그 무효화 시각을 쓴다(TTL은 상한). 한도 안에 답하지 않으면 버린다 */
    async markTags(tags, at = now()) {
      const list = [...new Set(tags)];
      await Promise.all(list.map((t) => run(() => client.set(tagKey(t), String(at), { expiration: { type: 'EX', value: maxTtlSeconds } }), undefined)));
    },
  };
}

/**
 * 공유 캐시용 Redis 클라이언트(처리기 모듈마다 하나). 모듈을 불러올 때 바로 붙기 시작하고, 끊기면 다음 명령 때 새로 붙는다.
 * 자동 다시 붙기는 끄고(reconnectStrategy: false) 붙기 전 명령은 쌓지 않는다(disableOfflineQueue). 소켓은 프로세스를 붙잡지 않는다(unref).
 * 끊긴 동안의 명령은 거절되거나 저장소의 시간 한도에 걸려 '없음'·'버림'이 된다.
 * @param {string} url
 */
export function createLazyRedis(url) {
  /** @type {{ client: ReturnType<typeof createClient>, ready: Promise<ReturnType<typeof createClient>> } | undefined} */
  let current;
  const open = () => {
    const client = createClient({ url, disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 1_000 } });
    const entry = { client, ready: Promise.resolve(client) };
    const drop = () => {
      if (current === entry) current = undefined;
    };
    client.on('error', () => drop());
    client.on('end', () => drop());
    client.unref();
    entry.ready = client.connect().then(
      () => client,
      (e) => {
        drop();
        throw e;
      },
    );
    entry.ready.catch(() => {});
    current = entry;
    return entry;
  };
  const ready = () => (current ?? open()).ready;
  open();
  return {
    get: async (k) => (await ready()).get(k),
    set: async (k, v, o) => (await ready()).set(k, v, o),
    mGet: async (keys) => (await ready()).mGet(keys),
  };
}

/**
 * 프로세스 메모리 저장소(BAT-170 리뷰 R170-1, 계획 §12): createCacheStore와 같은 네 메서드, 같은 키 꼴·TTL 규칙, 상한을 넘으면 먼저 넣은 것부터 지운다.
 * 시험 담당이 먼저 둔 빈 뼈대다(ADR-0270 결정 3). 동작은 구현 담당이 쓴다.
 * @param {{ now?: () => number, maxTtlSeconds?: number, maxEntries?: number }} [o]
 */
export function createMemoryStore(o) {
  void o;
  throw new Error('아직 없음');
}
