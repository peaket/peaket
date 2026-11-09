// 핫패스 Redis(Valkey) 연결(ADR-0176 결정 2, OPEN[11] 추천 적용(소유자 결정 2026-11-02): node-redis 확정, BUILD_ORDER FND-120이 넘긴 것).
// services/v0-monolith/src/redis.ts의 규칙을 클러스터까지 넓혀 서비스가 함께 쓴다(docs/architecture.md §5 시간 초과 표 Redis 행).
// - 연결이 끊긴 동안 명령을 쌓지 않는다(disableOfflineQueue). 소켓에 쓰지 못한 명령(ClientOfflineError)만 잠깐 뒤 한 번 다시 보낸다.
//   쓴 뒤의 실패는 결과를 모르므로 다시 보내지 않는다
// - 명령 시간 초과(commandOptions.timeout 100ms)는 소켓에 쓰기 전까지만 든다. 클러스터는 createCluster 맨 위에 둔다(defaults 안이면
//   클러스터가 명령마다 넘기는 기본 5초에 덮인다, @redis/client 6.3.0 cluster/index.js)
// - 응답 없이 사라진 노드는 호출 쪽 마감(100ms)이 끊는다. 마감에 걸린 명령도 나중에 서버에 닿으면 실행될 수 있다(ADR-0176 결정 2)
// - 시작은 정한 시간 안에 붙지 못하면 실패한다(연결 뒤 첫 인사에는 시간 초과가 없어 시작 전체에 마감을 건다). 오류 문구에 주소를 싣지 않는다
// - 닫기는 남은 응답을 잠깐 기다린 뒤 끊는다
// - 클러스터는 찾아낸 노드에 defaults와 주소만으로 붙는다. 그래서 시작 주소의 사용자·비밀번호·TLS(rediss)를 defaults에 넣는다
//   (ElastiCache는 RBAC 사용자와 전송 암호화가 필수, docs/infra.md. 2026-11-03 새 맥락 리뷰)
import { createHash } from 'node:crypto';
import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  createClient,
  createCluster,
  DisconnectsClientError,
  MaxCommandRedirectionsError,
  ReconnectStrategyError,
  RESP_TYPES,
  RootNodesUnavailableError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutError,
  type RedisClusterOptions,
} from 'redis';
import type { RedisCommander } from './redis-stream.js';

/** 핫패스 명령 시간 초과(밀리초, 소켓에 쓰기 전까지) */
export const REDIS_COMMAND_TIMEOUT_MS = 100;
/** 핫패스 호출 쪽 마감(밀리초) */
export const REDIS_CALL_DEADLINE_MS = 100;
/** 시작할 때 붙기까지 기다리는 시간 [가정] */
export const REDIS_STARTUP_TIMEOUT_MS = 5_000;
/** 연결 시도 하나의 시간 초과 [가정] */
const CONNECT_TIMEOUT_MS = 1_000;
/** 소켓에 쓰지 못한 명령을 다시 보내기 전 기다리는 시간 [가정] */
const RESEND_DELAY_MS = 50;
/** 닫을 때 남은 응답을 기다리는 시간 [가정] */
const CLOSE_GRACE_MS = 1_000;
/** 다시 연결 간격의 상한 [가정] */
const RECONNECT_MAX_DELAY_MS = 1_000;

export class RedisConnectError extends Error {
  constructor() {
    // 주소(비밀번호가 들 수 있다)를 싣지 않는다
    super('Redis에 연결하지 못했다');
    this.name = 'RedisConnectError';
  }
}

export class RedisDeadlineError extends Error {
  constructor(ms: number) {
    super(`Redis 호출이 마감 ${ms}ms를 넘겼다`);
    this.name = 'RedisDeadlineError';
  }
}

/** Lua 스크립트와 그 SHA-1(EVALSHA 이름) */
export interface RedisScript {
  readonly source: string;
  readonly sha: string;
}

export function redisScript(source: string): RedisScript {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

/** 클라이언트 하나(단일 노드나 클러스터)를 감싼 최소 면. key는 클러스터가 노드를 고르는 데 쓴다. binary면 문자열 응답을 Buffer로 받는다 */
export interface RawRedis {
  send(key: string | undefined, args: string[], binary?: boolean, pin?: boolean): Promise<unknown>;
  close(): Promise<void>;
  destroy(): void;
}

export interface CallOptions {
  /** 클러스터에서 노드를 고를 키(스크립트는 첫 키) */
  key?: string;
  /** 호출 쪽 마감(밀리초, 기본 100) */
  deadlineMs?: number;
  /** 문자열 응답을 글자로 풀지 않고 Buffer로 받는다(비트맵처럼 바이트 값을 읽을 때. 글자로 풀면 0x80 같은 바이트가 깨진다) */
  binary?: boolean;
  /**
   * 클러스터에서 key 슬롯의 주 노드 한 곳으로만 보낸다(그 노드와 스크립트가 쓰는 같은 연결). node-redis 6.3은 WAIT·INFO·CLIENT 같은 명령을 Redis 명령 팁(명령 정책)에 따라
   * 모든 샤드(WAIT는 샤드별 답의 최솟값)나 아무 노드(INFO·CLIENT INFO)로 보내 key를 무시한다(2026-11-04 ADR-0186 클러스터 실측). 한 노드의 같은 연결로 이어 가야 하는 호출
   * (쓰기 뒤 WAIT, 그 노드의 INFO replication)이 쓴다. 키 명령과 스크립트는 늘 key 슬롯의 주 노드로 가므로 필요 없다. 단일 노드에서는 아무 일도 하지 않는다
   */
  pin?: boolean;
}

export interface HotRedis extends RedisCommander {
  command(args: string[], o?: CallOptions): Promise<unknown>;
  /** EVALSHA로 보내고 서버에 스크립트가 없으면(NOSCRIPT) 같은 마감 안에서 EVAL한다. keys는 한 해시 슬롯이어야 한다 */
  evalScript(script: RedisScript, keys: string[], args: string[], o?: Omit<CallOptions, 'key'>): Promise<unknown>;
  close(): Promise<void>;
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 문자열 응답을 Buffer로 받는 명령 옵션(node-redis typeMapping) */
const BINARY = { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } };

/** 호출 규칙(다시 보내기·마감·스크립트)을 RawRedis 위에 얹는다. 시험은 RawRedis를 바꿔 끼운다 */
export function hotRedisOver(raw: RawRedis, o: { sleep?: (ms: number) => Promise<void> } = {}): HotRedis {
  const sleep = o.sleep ?? sleepFor;

  /** 한 번 보내고, 연결이 끊겨 소켓에 쓰지 못했으면 잠깐 뒤 한 번 더. 마감이 지났으면 다시 보내지 않는다(부른 쪽은 이미 실패를 받았다) */
  const once = async (key: string | undefined, args: string[], expired: () => boolean, binary?: boolean, pin?: boolean): Promise<unknown> => {
    try {
      return await raw.send(key, args, binary, pin);
    } catch (err) {
      if (!(err instanceof ClientOfflineError) || expired()) throw err;
      await sleep(RESEND_DELAY_MS);
      if (expired()) throw err;
      return raw.send(key, args, binary, pin);
    }
  };

  const withDeadline = async <T>(ms: number, run: (expired: () => boolean) => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    const deadline = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new RedisDeadlineError(ms));
      }, ms);
    });
    const work = run(() => expired);
    work.catch(() => {}); // 마감으로 끊은 뒤에 오는 거부를 처리된 것으로 둔다
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  const command = (args: string[], c: CallOptions = {}) => withDeadline(c.deadlineMs ?? REDIS_CALL_DEADLINE_MS, (expired) => once(c.key, args, expired, c.binary, c.pin));

  return {
    command,
    // RedisCommander 호출(키를 따로 주지 않음)은 둘째 인자를 키로 본다. 키 명령은 '명령 키 …' 모양이라 클러스터가 노드를 고를 수 있다
    sendCommand: (args) => command(args, { key: args[1] }),
    evalScript: (s, keys, args, c = {}) =>
      withDeadline(c.deadlineMs ?? REDIS_CALL_DEADLINE_MS, async (expired) => {
        const tail = [String(keys.length), ...keys, ...args];
        try {
          return await once(keys[0], ['EVALSHA', s.sha, ...tail], expired, c.binary);
        } catch (err) {
          // 마감이 지난 뒤에는 EVAL을 새로 보내지 않는다(부른 쪽은 이미 실패를 받았다)
          if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT') || expired()) throw err;
          return once(keys[0], ['EVAL', s.source, ...tail], expired, c.binary);
        }
      }),
    async close() {
      const closed = raw.close().then(
        () => 'closed' as const,
        () => 'closed' as const,
      );
      await Promise.race([closed, sleepFor(CLOSE_GRACE_MS)]);
      raw.destroy(); // 이미 닫혔으면 아무 일도 하지 않는다
    },
  };
}

const reconnect = (state: { started: boolean; gaveUp: boolean }) => (retries: number) => {
  if (!state.started && state.gaveUp) return new RedisConnectError();
  return Math.min(50 * 2 ** Math.min(retries, 5), RECONNECT_MAX_DELAY_MS);
};

/** 시작 주소의 인증·TLS. 주소끼리 다르면 던진다(오류 문구에 비밀번호를 싣지 않는다) */
function clusterAuth(urls: readonly string[]): { username?: string; password?: string; tls: boolean } {
  const seen = urls.map((u) => {
    const url = new URL(u);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') throw new Error('클러스터 시작 노드 주소는 redis:// 또는 rediss://다');
    return { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), tls: url.protocol === 'rediss:' };
  });
  const first = seen[0];
  if (!first) throw new Error('클러스터 시작 노드 주소가 없다');
  if (seen.some((x) => x.username !== first.username || x.password !== first.password || x.tls !== first.tls)) {
    throw new Error('클러스터 시작 노드 주소끼리 사용자·비밀번호·TLS가 다르다');
  }
  return { ...(first.username ? { username: first.username } : {}), ...(first.password ? { password: first.password } : {}), tls: first.tls };
}

/**
 * 클러스터 연결 설정(시험이 명령 시간 초과·인증·TLS의 자리를 본다).
 * nodeAddressMap: 클러스터가 알려 주는 노드 주소('호스트:포트')를 붙을 주소로 바꾼다. 이 PC의 측정처럼 노드가 컨테이너 망 이름을 알려 줄 때만 쓴다(운영은 쓰지 않는다)
 */
export function redisClusterOptions(urls: readonly string[], state = { started: false, gaveUp: false }, nodeAddressMap?: Readonly<Record<string, { host: string; port: number }>>): RedisClusterOptions {
  const { tls, ...auth } = clusterAuth(urls);
  const socket = { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: reconnect(state) };
  return {
    rootNodes: urls.map((url) => ({ url })),
    ...(nodeAddressMap ? { nodeAddressMap: { ...nodeAddressMap } } : {}),
    defaults: {
      ...auth,
      disableOfflineQueue: true,
      socket: tls ? { ...socket, tls: true as const } : socket,
    },
    commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
  };
}

/** node-redis가 연결이 끊기거나 다시 붙는 동안 던지는 오류(명령이 서버에 닿지 않았거나 결과를 모름). 클러스터 넘겨주기 상한(장애 전환 중 MOVED가 이어짐)도 넣는다 */
const NODE_REDIS_CONNECTION_ERRORS = [ClientClosedError, SocketClosedUnexpectedlyError, ConnectionTimeoutError, SocketTimeoutError, ReconnectStrategyError, DisconnectsClientError, RootNodesUnavailableError, MaxCommandRedirectionsError];
/** 연결이 오류로 끊기면 node-redis는 처리 중이던 명령을 그 소켓 오류 그대로 거부한다(ECONNRESET 등). 망·이름 찾기 오류만 일시 장애로 본다 */
const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

/** 핫패스가 503과 Retry-After로 답할 일시 장애인가(마감 초과, 연결 실패·끊김, 클러스터 재구성·장애 전환 중, 늦은 복제본으로 쓰기 거절). 스크립트 오류 같은 버그는 아니다 */
export function isRedisUnavailable(err: unknown): boolean {
  if (err instanceof RedisDeadlineError || err instanceof RedisConnectError || err instanceof ClientOfflineError) return true;
  if (!(err instanceof Error)) return false;
  // node-redis 6.3 연결 오류는 name을 정하지 않아 모두 'Error'다. 이름이 아니라 클래스로 가른다(장애 전환 중 'Socket closed unexpectedly'가 500으로 나가던 것, PRF-085 Q-T13에서 찾음)
  if (NODE_REDIS_CONNECTION_ERRORS.some((C) => err instanceof C)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  // NOREPLICAS: 복제본이 늦어 주 노드가 쓰기를 거절했다(min-replicas-to-write, ADR-0181 '전제')
  return /^(CLUSTERDOWN|TRYAGAIN|LOADING|MASTERDOWN|READONLY|NOREPLICAS)\b/.test(err.message);
}

/**
 * 서버 메모리 부족으로 거절된 명령인가(maxmemory에 닿았고 정책이 noeviction이라 메모리를 더 쓰는 명령·`#!lua` 스크립트를 받지 않음,
 * Valkey 답 'OOM command not allowed when used memory > 'maxmemory'.', docs/data.md §3 ADR-0109, BUILD_ORDER PRF-135).
 *
 * 판정: err가 Error이고 err.message가 /^OOM\b/에 맞을 때만 true다(앞 빈칸·소문자 'oom'·'ERR … OOM …'처럼 가운데 든 것은 false).
 * Error가 아닌 값(글·null·undefined·객체)은 false다. 던지지 않는다.
 *
 * isRedisUnavailable과 섞지 않는다(OOM은 isRedisUnavailable이 false다): 메모리 부족은 잠깐 기다려 다시 보낸다고 풀리지 않으므로,
 * 일시 장애로 다시 시도하는 루프(admission-ctrl 등)가 OOM에 돌지 않게 따로 가른다. 받는 쪽이 무엇으로 답할지는 그 서비스가 정한다
 * (purchase-svc는 503 seat-store-unavailable + Retry-After, 까닭 oom은 지표·로그에만).
 * `allow-oom` 스크립트 표시는 쓰지 않는다(메모리 부족이면 만료도 거절되고 RB-06을 따른다).
 */
export function isRedisOutOfMemory(err: unknown): boolean {
  return err instanceof Error && /^OOM\b/.test(err.message);
}

export interface HotRedisOptions {
  /** 단일 노드 주소(redis:// 또는 rediss://) */
  url?: string;
  /** 클러스터 시작 노드 주소들. 주면 클러스터로 붙는다 */
  clusterUrls?: readonly string[];
  /** 클러스터가 알려 주는 노드 주소('호스트:포트') → 붙을 주소. 측정·시험에서 컨테이너 망 이름을 이 PC 포트로 바꿀 때만 쓴다 */
  nodeAddressMap?: Readonly<Record<string, { host: string; port: number }>>;
  startupTimeoutMs?: number;
}

/** 시작 마감 안에 붙은 핫패스 Redis. 못 붙으면 RedisConnectError */
export async function createHotRedis(o: HotRedisOptions): Promise<HotRedis> {
  const state = { started: false, gaveUp: false };
  let raw: RawRedis;
  let connect: () => Promise<unknown>;
  if (o.clusterUrls?.length) {
    const cluster = createCluster(redisClusterOptions(o.clusterUrls, state, o.nodeAddressMap));
    cluster.on('error', () => {});
    raw = {
      send: async (key, args, binary, pin) => {
        if (!pin) return cluster.sendCommand(key, false, args, binary ? BINARY : undefined);
        if (key === undefined) throw new Error('pin에는 key가 필요하다');
        // 명령 정책을 건너뛰고 key 슬롯의 주 노드 클라이언트로 바로 보낸다(키 명령·스크립트가 가는 같은 클라이언트라 같은 연결이다)
        const node = await cluster.getNodeClientForKey(key);
        return node.sendCommand(args, { ...(binary ? BINARY : {}), timeout: REDIS_COMMAND_TIMEOUT_MS });
      },
      close: () => cluster.close(),
      destroy: () => cluster.destroy(),
    };
    connect = () => cluster.connect();
  } else {
    if (!o.url) throw new Error('Redis 주소(url)나 클러스터 주소(clusterUrls)가 없다');
    const client = createClient({
      url: o.url,
      disableOfflineQueue: true,
      commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: reconnect(state) },
    });
    // 연결 오류는 명령 실패로 드러난다. 주소가 든 오류 문구를 따로 찍지 않는다
    client.on('error', () => {});
    raw = {
      send: (_key, args, binary) => client.sendCommand(args, binary ? BINARY : undefined),
      close: () => client.close(),
      destroy: () => client.destroy(),
    };
    connect = () => client.connect();
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((r) => (timer = setTimeout(() => r('deadline'), o.startupTimeoutMs ?? REDIS_STARTUP_TIMEOUT_MS)));
  try {
    const connecting = connect().then(() => 'connected' as const);
    connecting.catch(() => {}); // 마감으로 포기한 뒤에 오는 거부를 처리된 것으로 둔다
    const first = await Promise.race([connecting, deadline]);
    if (first === 'deadline') throw new RedisConnectError();
  } catch {
    state.gaveUp = true;
    raw.destroy();
    throw new RedisConnectError();
  } finally {
    clearTimeout(timer);
  }
  state.started = true;
  return hotRedisOver(raw);
}
