// 소비자 웹 공유 캐시 저장소(docs/frontend.md §5.18 '공유 캐시 처리기 세부', docs/data.md 세션·캐시 클러스터 키 이름, BUILD_ORDER HOT-390).
// 미리 그린 화면 캐시(cache-handler.mjs)와 'use cache' 처리기(use-cache-handler.mjs)가 같은 Redis(Valkey)에 이 저장소로 읽고 쓴다.
// - 키: 미리 그린 화면 `web:isr:<빌드 칸>:<캐시 키>`, 'use cache' 값 `web:data:<캐시 키>`, 태그를 마지막으로 무효화한 시각(ms) `web:{tag}:<태그>`.
//   둘째 칸(isr·data·{tag})이 달라 어떤 캐시 키·태그도 겹치지 않는다. `{tag}`는 글자 그대로 쓰는 클러스터 해시 태그라 모든 태그 키가
//   한 슬롯에 모여 여러 태그를 MGET 한 번으로 읽는다(클러스터 모드의 CROSSSLOT 막기). 값 키는 하나씩만 읽고 쓴다.
// - 모든 키에 TTL: 값은 그 항목의 만료, 다시 만들기 간격의 12배 [가정], 상한(30일 [가정]) 가운데 가장 짧은 쪽, 태그 시각은 상한(ADR-0109 '모든 키에 TTL').
// - 세션·캐시 클러스터는 클러스터 모드라 createCluster로 붙고, 끊김·장애 조치에서 스스로 회복한다(docs/frontend.md §5.18 '클러스터 연결과 회복').
// - 없는·중지 결과(태그 web-transient)와 200이 아닌 미리 그린 화면은 공유하지 않고 파드 메모리에만 둔다(처리기가 고른다, '키 수 막기').
// - Redis가 시간 한도(100ms [가정]) 안에 답하지 않거나 끊기면 읽기는 없음(null), 쓰기는 버린다. 던지지 않는다(키 등급 A, docs/data.md).
import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  createCluster,
  DisconnectsClientError,
  ReconnectStrategyError,
  RootNodesUnavailableError,
  SocketClosedUnexpectedlyError,
  TimeoutError,
} from 'redis';

// 환경 확인·next.config 설정은 Redis 없이 읽는 cache-env.mjs에 두고 여기서 함께 내보낸다(server/start.mjs·next.config.ts가 가볍게 부른다)
export { assertCacheEnv, cacheConfig, CACHE_URL_ENV } from './cache-env.mjs';
import { assertBuildTag, assertCacheEnv, CACHE_BUILD_ENV, CACHE_URL_ENV } from './cache-env.mjs';

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

/** 쓰기 몫 기본값: 파드마다 초당 50개 [가정], 모아 둘 수 있는 몫 100개 [가정](docs/frontend.md §5.18 '키 수 막기' ③) */
export const DEFAULT_WRITE_RATE = Object.freeze({ perSecond: 50, burst: 100 });
/** 값 TTL에 쓰는 다시 만들기 간격의 배수: 12배 [가정](docs/frontend.md §5.18 TTL 문장) */
export const REVALIDATE_TTL_FACTOR = 12;
/** 연결 시간 한도: 1초 [가정](docs/frontend.md §5.18 '클러스터 연결과 회복' ⓒ) */
export const CONNECT_TIMEOUT_MS = 1_000;
/** 다시 붙기 간격: 50ms에서 두 배씩, 1초에서 멈춘다(ⓓ) */
export const RECONNECT_BASE_MS = 50;
export const RECONNECT_MAX_MS = 1_000;
/** 연속 시간 초과 이만큼이면 연결을 버린다: 5번 [가정](ⓔ) */
export const MAX_CONSECUTIVE_TIMEOUTS = 5;
/** 회복 로그 간격: 1분에 한 번 [가정](ⓕ) */
export const RECOVERY_LOG_INTERVAL_MS = 60_000;
/** 이 응답이 오면 연결을 버리고 슬롯 지도를 다시 받는다(ⓔ). MOVED·ASK는 클러스터 연결이 스스로 따라간다 */
const RESET_REPLY = /^(READONLY|CLUSTERDOWN|TRYAGAIN|LOADING)\b/;
/** 연결이 끊긴 것으로 보는 node-redis 오류(이 연결로는 더 보낼 수 없다) */
const CONNECTION_ERRORS = [ClientClosedError, ClientOfflineError, SocketClosedUnexpectedlyError, ConnectionTimeoutError, DisconnectsClientError, RootNodesUnavailableError, ReconnectStrategyError];
const NETWORK_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

const TIMED_OUT = Symbol('timeout');
/** 약속의 결과를 ms 안에: { ok, value } | { ok: false, error } | TIMED_OUT. 타이머는 프로세스를 붙잡지 않는다 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      },
    );
  });
}

/** 시작 주소의 인증·TLS(찾아낸 노드에도 같은 값으로 붙는다). 주소끼리 다르면 던진다(오류 글에 비밀번호를 싣지 않는다) */
function clusterAuth(urls) {
  const seen = urls.map((u) => {
    const url = new URL(u);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') throw new Error('공유 캐시 시작 주소는 redis:// 또는 rediss://다');
    return { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), tls: url.protocol === 'rediss:' };
  });
  const first = seen[0];
  if (!first) throw new Error('공유 캐시 시작 주소가 없다');
  if (seen.some((x) => x.username !== first.username || x.password !== first.password || x.tls !== first.tls)) throw new Error('공유 캐시 시작 주소끼리 사용자·비밀번호·TLS가 다르다');
  return first;
}

/** 클러스터 연결 설정(packages/platform/src/redis.ts의 클러스터 쪽과 같은 규칙. 다시 붙기는 이 저장소가 한다) */
export function cacheClusterOptions(urls, { nodeAddressMap, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { username, password, tls } = clusterAuth(urls);
  const socket = { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false, ...(tls ? { tls: true } : {}) };
  return {
    rootNodes: urls.map((url) => ({ url })),
    ...(nodeAddressMap ? { nodeAddressMap: { ...nodeAddressMap } } : {}),
    defaults: { ...(username ? { username } : {}), ...(password ? { password } : {}), disableOfflineQueue: true, socket },
    commandOptions: { timeout: timeoutMs },
  };
}

/** 기본 연결: createCluster로 붙는다. 붙지 못하면 버리고 던진다 */
async function connectCluster(urls, nodeAddressMap, timeoutMs) {
  const cluster = createCluster(cacheClusterOptions(urls, { nodeAddressMap, timeoutMs }));
  // 연결 오류는 명령 실패로 드러난다. 주소가 든 오류 글을 따로 찍지 않는다
  cluster.on('error', () => {});
  try {
    await cluster.connect();
  } catch (e) {
    try {
      cluster.destroy();
    } catch {
      // 이미 닫혔다
    }
    throw e;
  }
  return cluster;
}

/** 로거 꼴: 함수이거나 warn·log 등을 가진 객체 */
function emit(logger, line) {
  if (!logger) return;
  if (typeof logger === 'function') logger(line);
  else (logger.warn ?? logger.log ?? logger.info)?.call(logger, line);
}

/** 이 응답·오류에 연결을 버려야 하는지. 버린다면 로그에 쓸 까닭(주소가 든 글은 싣지 않는다) */
function resetReason(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const reply = RESET_REPLY.exec(message);
  if (reply) return reply[1];
  if (CONNECTION_ERRORS.some((C) => error instanceof C)) return 'connection';
  const code = error?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return 'connection';
  return null;
}

/**
 * 공유 캐시 저장소. client를 주면 그 연결을 그대로 쓰고(시험의 가짜 Redis, 메모리 저장소), urls·connect를 주면 클러스터 연결을 스스로 맺고 회복한다
 * (docs/frontend.md §5.18 '클러스터 연결과 회복' ⓐ~ⓕ, BAT-170 웨이브 끝 리뷰 W7L2-K1·K2).
 * - 붙는 동안의 요청은 기다리지 않고 없음·버림이다(ⓓ). 다시 붙기는 실패마다 50ms에서 두 배씩 1초까지 기다리고, 한 번에 하나만 한다.
 *   처음 연결은 만들 때 바로 시작한다. 처리기 모듈은 불러올 때 ready()로 처음 연결을 연결 시간 한도까지 기다린다.
 * - 연속 시간 초과 5번이나 READONLY·CLUSTERDOWN·TRYAGAIN·LOADING(그리고 끊긴 연결 오류)이면 그 연결을 버리고 다시 붙는다(ⓔ).
 * - 쓰기 몫(writeRate, 기본 초당 50·몫 100)을 넘는 값 쓰기는 버리고 센다(키 수 막기 ③). writeRate가 false면 몫을 두지 않는다(메모리 저장소).
 * @param {{ client?: { get(k: string): Promise<unknown>, set(k: string, v: string, o: object): Promise<unknown>, mGet(keys: string[]): Promise<unknown[]> },
 *   urls?: string[], nodeAddressMap?: Record<string, { host: string, port: number }>, connect?: () => Promise<any>,
 *   writeRate?: { perSecond: number, burst: number } | false, logger?: any,
 *   timeoutMs?: number, now?: () => number, maxTtlSeconds?: number }} o
 */
export function createCacheStore({
  client,
  urls,
  nodeAddressMap,
  connect,
  writeRate = DEFAULT_WRITE_RATE,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS,
}) {
  const managed = urls !== undefined || connect !== undefined;
  if (!managed && !client) throw new Error('공유 캐시 저장소에 연결(client)이나 시작 주소(urls)가 없다');
  if (managed && connect === undefined && (!Array.isArray(urls) || urls.length === 0)) throw new Error('공유 캐시 시작 주소(urls)가 비었다');
  const stats = { consecutiveTimeouts: 0, resets: 0, connectAttempts: 0, pending: 0, droppedWrites: 0 };
  const lastLog = { reset: -Infinity, dropped: -Infinity };
  const log = (kind, line) => {
    const t = now();
    if (t - lastLog[kind] < RECOVERY_LOG_INTERVAL_MS) return;
    lastLog[kind] = t;
    emit(logger, line);
  };

  // ---- 연결(ⓓⓔ) ----
  const open = connect ?? (() => connectCluster(urls, nodeAddressMap, timeoutMs));
  let current = managed ? null : client;
  let connecting = null;
  let failures = 0;
  let nextAttemptAt = 0;
  let closed = false;
  const discard = (c) => {
    try {
      c?.destroy?.();
    } catch {
      // 이미 닫혔다
    }
  };
  const attempt = () => {
    stats.connectAttempts += 1;
    let p;
    try {
      p = Promise.resolve(open());
    } catch (e) {
      p = Promise.reject(e);
    }
    const run = settleWithin(p, CONNECT_TIMEOUT_MS).then((r) => {
      connecting = null;
      if (r !== TIMED_OUT && r.ok && r.value && !closed) {
        current = r.value;
        failures = 0;
        current.on?.('error', () => {});
        return current;
      }
      // 한도를 넘겨 늦게 붙은 연결은 버린다
      if (r === TIMED_OUT) p.then(discard, () => {});
      else if (r.ok) discard(r.value);
      failures += 1;
      nextAttemptAt = now() + Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS);
      return null;
    });
    connecting = run;
    return run;
  };
  const reset = (c, reason) => {
    if (!managed || c !== current) return;
    stats.resets += 1;
    stats.consecutiveTimeouts = 0;
    current = null;
    discard(c);
    // 버린 뒤 첫 다시 붙기는 바로 한다(실패가 이어지면 ⓓ 간격)
    nextAttemptAt = now();
    log('reset', `공유 캐시 연결을 버리고 다시 붙는다: 까닭 ${reason}, 버린 연결 ${stats.resets}, 연결 시도 ${stats.connectAttempts}, 버린 쓰기 ${stats.droppedWrites}`);
  };
  /** 지금 쓸 연결. 없으면 (간격이 지났을 때) 한 번만 붙기 시작하고 기다리지 않는다 */
  const acquire = async () => {
    if (current || closed) return current;
    if (!connecting && now() >= nextAttemptAt) attempt();
    // 이미 끝난 연결 결과가 반영되도록 잠깐만 양보한다(붙는 동안은 기다리지 않는다, ⓓ)
    for (let i = 0; i < 3 && !current; i += 1) await null;
    return current;
  };
  if (managed) attempt();

  /** 명령 하나: 시간 한도 안의 결과, 아니면 fallback. 시간 초과·연결 버릴 응답을 센다 */
  const exec = async (fn, fallback) => {
    const c = await acquire();
    if (!c) return fallback;
    let p;
    try {
      p = Promise.resolve(fn(c));
    } catch {
      return fallback;
    }
    stats.pending += 1;
    const done = () => {
      stats.pending -= 1;
    };
    p.then(done, done);
    const r = await settleWithin(p, timeoutMs);
    if (r !== TIMED_OUT && r.ok) {
      stats.consecutiveTimeouts = 0;
      return r.value;
    }
    if (r === TIMED_OUT || r.error instanceof TimeoutError) {
      stats.consecutiveTimeouts += 1;
      if (stats.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) reset(c, 'timeout');
      return fallback;
    }
    const reason = resetReason(r.error);
    if (reason) reset(c, reason);
    return fallback;
  };

  // ---- 쓰기 몫(키 수 막기 ③): 천분의 일 단위 토큰 ----
  const bucket = writeRate ? { tokens: writeRate.burst * 1000, at: now() } : null;
  const takeWrite = () => {
    if (!bucket) return true;
    const t = now();
    if (t > bucket.at) {
      bucket.tokens = Math.min(writeRate.burst * 1000, bucket.tokens + (t - bucket.at) * writeRate.perSecond);
      bucket.at = t;
    }
    if (bucket.tokens >= 1000) {
      bucket.tokens -= 1000;
      return true;
    }
    stats.droppedWrites += 1;
    log('dropped', `공유 캐시 쓰기 몫(초당 ${writeRate.perSecond}·몫 ${writeRate.burst})을 넘어 쓰기를 버렸다: 버린 쓰기 ${stats.droppedWrites}`);
    return false;
  };

  /** 값 TTL(초): 만료, 다시 만들기 간격의 12배, 상한 가운데 가장 짧은 쪽. 1초보다 짧으면 1초 */
  const ttlOf = (expireSeconds, revalidateSeconds) => {
    const candidates = [maxTtlSeconds];
    const e = Number(expireSeconds);
    if (Number.isFinite(e) && e > 0) candidates.push(e);
    const r = Number(revalidateSeconds);
    if (Number.isFinite(r) && r > 0) candidates.push(r * REVALIDATE_TTL_FACTOR);
    return Math.max(1, Math.ceil(Math.min(...candidates)));
  };

  return {
    /** 값 하나를 읽는다. 없거나 한도 안에 답하지 않으면 null */
    async getEntry(kind, key) {
      const k = valueKey(kind, key);
      return (await exec((c) => c.get(k), null)) ?? null;
    },
    /** 값 하나를 TTL과 함께 쓴다. 쓰기 몫을 넘거나 한도 안에 답하지 않거나 끊기면 버린다 */
    async setEntry(kind, key, value, expireSeconds, revalidateSeconds) {
      const k = valueKey(kind, key);
      if (typeof value === 'string' && Buffer.byteLength(value) > MAX_ENTRY_BYTES) return;
      if (!takeWrite()) return;
      await exec((c) => c.set(k, value, { expiration: { type: 'EX', value: ttlOf(expireSeconds, revalidateSeconds) } }), undefined);
    },
    /** 태그마다 마지막 무효화 시각(ms, 기록 없으면 0)을 MGET 한 번으로 읽는다. 읽지 못하면 null */
    async tagTimes(tags) {
      const list = [...new Set(tags)];
      const out = new Map();
      if (list.length === 0) return out;
      const values = await exec((c) => c.mGet(list.map(tagKey)), null);
      if (!Array.isArray(values)) return null;
      list.forEach((t, i) => {
        const n = Number(values[i] == null ? 0 : String(values[i]));
        out.set(t, Number.isFinite(n) ? n : 0);
      });
      return out;
    },
    /** 태그 무효화 시각을 쓴다(TTL은 상한). 쓰기 몫에 넣지 않는다(무효화를 버리면 옛 값이 남는다) */
    async markTags(tags, at = now()) {
      const list = [...new Set(tags)];
      await Promise.all(list.map((t) => exec((c) => c.set(tagKey(t), String(at), { expiration: { type: 'EX', value: maxTtlSeconds } }), undefined)));
    },
    /** 회복 상태(ⓕ): { consecutiveTimeouts, resets, connectAttempts, pending, droppedWrites } */
    stats() {
      return { ...stats };
    },
    /** 처음 연결을 연결 시간 한도까지 기다린다(붙었으면 true). 던지지 않는다 */
    async ready() {
      if (current) return true;
      if (!managed || closed) return Boolean(current);
      await (connecting ?? attempt());
      return Boolean(current);
    },
    /** 연결을 닫는다(시험·종료) */
    async close() {
      closed = true;
      const c = current;
      current = null;
      discard(c);
      connecting?.then((x) => discard(x));
    },
  };
}

/** 메모리 저장소 항목 수 상한: 1,000개 [가정](docs/frontend.md §5.18). 넘으면 먼저 넣은 것부터 지운다 */
export const DEFAULT_MEMORY_MAX_ENTRIES = 1_000;

/**
 * 프로세스 메모리 저장소(BAT-170 리뷰 R170-1, docs/frontend.md §5.18): 주소가 없는 local·ci·demo에서 두 처리기가 쓴다.
 * createCacheStore와 같은 네 메서드·같은 키 꼴·TTL 규칙이다. 안쪽은 Redis 대신 Map이고, 만료는 읽을 때 now()로 본다.
 * 항목(값·태그 시각 모두)이 상한을 넘으면 먼저 넣은 것부터 지운다(같은 키를 다시 쓰면 맨 뒤로 간다)
 * @param {{ now?: () => number, maxTtlSeconds?: number, maxEntries?: number }} [o]
 */
export function createMemoryStore({ now = () => Date.now(), maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS, maxEntries = DEFAULT_MEMORY_MAX_ENTRIES } = {}) {
  /** @type {Map<string, { value: string, expiresAt: number }>} */
  const data = new Map();
  const read = (k) => {
    const e = data.get(k);
    if (!e) return null;
    if (now() >= e.expiresAt) {
      data.delete(k);
      return null;
    }
    return e.value;
  };
  const client = {
    get: async (k) => read(k),
    mGet: async (keys) => keys.map(read),
    set: async (k, v, o) => {
      const seconds = Number(o?.expiration?.value ?? maxTtlSeconds);
      data.delete(k);
      data.set(k, { value: String(v), expiresAt: now() + seconds * 1000 });
      while (data.size > maxEntries) data.delete(data.keys().next().value);
      return 'OK';
    },
  };
  return createCacheStore({ client, now, maxTtlSeconds, writeRate: false, logger: null });
}

/**
 * 처리기 모듈이 불러올 때 저장소와 빌드 칸을 고른다(파드마다 하나, BAT-170 리뷰 R170-1·R170-2, docs/frontend.md §5.18).
 * 주소가 있으면 Redis이고 빌드 칸(PEAKET_WEB_CACHE_BUILD)이 꼴 밖이거나 없으면 던진다(조용히 빌드 칸 없이 쓰지 않는다).
 * 주소가 없으면 메모리 저장소이고 빌드 칸이 없으면 `dev`다(`next dev`는 start.mjs를 거치지 않는다).
 * 메모리 저장소는 local·ci·demo 전용이다(닫힌 규칙, BAT-170 리뷰 R170-8): 주소가 없는데 PEAKET_ENV가 그 밖이면(없음·빈 값·오타 포함)
 * start.mjs를 거치지 않고 떴어도(standalone `node server.js`, `next start`) 처리기의 첫 읽기·쓰기부터 늘 던진다(저장소가 거절한다).
 * 불러올 때 던지지 않는 까닭: 같은 모듈의 함수(createCacheHandler 등)를 가져다 쓰는 곳까지 막지 않게 한다. start.mjs의 assertCacheEnv와 같은 규칙을 겹쳐 지킨다.
 * 운영 요청을 받지 않는 Next.js의 빌드(정적 화면 만들기, NEXT_PHASE=phase-production-build)와 개발 서버(__NEXT_DEV_SERVER)만 이 확인에서 뺀다
 */
export function selectRuntime(env = process.env) {
  const urls = parseCacheUrls(env);
  const given = env[CACHE_BUILD_ENV];
  if (urls.length > 0) {
    const build = assertBuildTag(given, `${CACHE_BUILD_ENV}(공유 캐시 주소가 있을 때 빌드 칸)`);
    return { store: createCacheStore({ urls }), build };
  }
  const notServing = env.NEXT_PHASE === 'phase-production-build' || Boolean(env.__NEXT_DEV_SERVER);
  if (!notServing) {
    try {
      assertCacheEnv(env);
    } catch (e) {
      return { store: refusingStore(e), build: 'dev' };
    }
  }
  return { store: createMemoryStore(), build: given === undefined ? 'dev' : assertBuildTag(given, CACHE_BUILD_ENV) };
}

/** 모든 읽기·쓰기를 거절하는 저장소(주소 없는 운영, R170-8). 처리기가 조용히 메모리로 돌지 않고 요청마다 오류가 보인다 */
function refusingStore(error) {
  const refuse = async () => {
    throw new Error(`공유 캐시를 쓰지 않는다: ${error instanceof Error ? error.message : String(error)}`);
  };
  return { getEntry: refuse, setEntry: refuse, tagTimes: refuse, markTags: refuse };
}

/** 공유하지 않을 결과(없는·중지 회차)에 다는 태그(docs/frontend.md §5.18 '키 수 막기' ②) */
export const TRANSIENT_TAG = 'web-transient';
/** 파드 메모리 저장소(공유하지 않을 항목): 1,000개 [가정], 60초 [가정](같은 자리) */
export const POD_MEMORY_MAX_ENTRIES = 1_000;
export const POD_MEMORY_TTL_SECONDS = 60;

/** 시작 주소 배열: PEAKET_WEB_CACHE_REDIS_URL을 쉼표로 나누고 빈칸은 뺀다(docs/frontend.md §5.18 '클러스터 연결과 회복') */
export function parseCacheUrls(env = process.env) {
  const raw = env[CACHE_URL_ENV];
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u !== '');
}
