// 좌석 Redis 샤드 Pub/Sub 구독(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '좌석 Redis 구독', docs/api/guidelines.md §8·§8.1 이 행,
// docs/data.md §5, ADR-0296, ADR-0297 결정 1·4·6, BUILD_ORDER HOT-090). node-redis 6.3.0의 sSubscribe·sUnsubscribe(단일 노드, 클러스터면 샤드마다 연결)를 쓴다.
// 쓰는 명령은 SSUBSCRIBE·SUNSUBSCRIBE·PING과 연결 명령(HELLO·AUTH·CLIENT SETINFO), 클러스터면 노드 찾기 CLUSTER SLOTS뿐이다. 정본 접근 문자열
// `resetchannels &s:{event:*}:sec:* -@all +ssubscribe +sunsubscribe +ping +hello +auth +client|setinfo +cluster|slots`와 같다(ASVS v5.0.0-13.2.2·13.3.2).
// 데이터 키에는 닿지 않는다(ADR-0007).
// - 원하는 구독 상태의 주인은 이 구독기 하나다(ADR-0297 결정 1). subscribe·unsubscribe는 원하는 상태를 적고 곧 돌려주며 거절하지 않는다.
// - 채널마다 명령은 한 번에 하나다. 끝난 뒤 원하는 상태와 다르면 또 보낸다. 실패한 뒤의 실제 상태는 '모름'으로 보아 원하는 쪽 명령을 꼭 다시 보내고,
//   다시 보내는 간격은 0.2초에서 두 배씩 상한 5초 [가정]다. 경고 줄(onError)은 채널마다 물러서기 단계가 바뀔 때만 낸다.
// - node-redis 6.3의 Pub/Sub 명령은 오프라인 거절(disableOfflineQueue)을 거치지 않고 줄에 들어간다. 그래서 끊긴 동안에는 명령을 보내지 않고 원하는 상태만 적으며,
//   다시 붙으면(ready) 원하는 채널을 모두 '모름'으로 보고 같은 고리로 다시 맞춘다(다시 맞추기가 실패해도 물러서며 잇는다).
// - 구독 연결 살핌(ADR-0297 결정 4): 5초 [가정]마다 PING을 보내고 2초 [가정] 안에 답이 없으면 붙음 0으로 두고 연결을 버린 뒤 새로 붙는다.
//   RESP2 구독 모드에서도 node-redis는 PING을 보내고 ["pong", ""] 답을 받는다(구현 메모: RESP3·명령 시한은 쓰지 않았다).
// - realtime_gw_redis_up(onUp), 어긋난 채널 수 realtime_gw_subscribe_mismatch(onMismatch).
// 유스케이스 층의 형을 가져오지 않는다(층 의존 방향). 허브의 ChannelSubscriber와 같은 모양이라 조립(start.ts)에서 그대로 넘긴다.
import { EventEmitter } from 'node:events';
import { createClient, createCluster } from 'redis';
import { redisClusterOptions } from '@peaket/platform';

/** 시작 때 붙는 마감(ms). 넘으면 시작하지 않는다 */
export const SUBSCRIBER_STARTUP_TIMEOUT_MS = 5_000;
/** 처음 다시 보내는 간격과 상한(ms, [가정], ADR-0297 결정 1) */
export const SUBSCRIBE_RETRY_FIRST_MS = 200;
export const SUBSCRIBE_RETRY_MAX_MS = 5_000;
/** 구독 연결 PING 간격과 답 시한(ms, [가정], ADR-0297 결정 4) */
export const SUBSCRIBER_PING_EVERY_MS = 5_000;
export const SUBSCRIBER_PING_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 1_000;
/** 다시 붙기 간격 상한(ms) */
const RECONNECT_MAX_DELAY_MS = 2_000;
/** 닫을 때 기다리는 상한(ms) */
const CLOSE_GRACE_MS = 1_000;

type Listener = (message: string) => void;

/** 구독기가 쓰는 Pub/Sub 클라이언트 모양(node-redis 클라이언트와 같다. 시험은 가짜를 넘긴다) */
export interface PubSubClient {
  sSubscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  sUnsubscribe(channel: string): Promise<void>;
  ping(): Promise<unknown>;
  on(event: 'ready' | 'error' | 'end' | 'reconnecting', listener: (...args: unknown[]) => void): unknown;
  destroy(): void;
  close?(): Promise<unknown>;
}

export interface RedisSubscriberOptions {
  /** 붙음 상태가 바뀔 때(realtime_gw_redis_up) */
  onUp?(up: boolean): void;
  /** 명령이 실패해 물러서기 단계가 바뀔 때(채널 이름과 오류 이름만) */
  onError?(e: { channel: string; error: string }): void;
  /** 어긋난 채널 수가 바뀔 때(realtime_gw_subscribe_mismatch) */
  onMismatch?(n: number): void;
  /** PING 답이 없을 때 새 연결을 만드는 함수(connect가 넣는다). 없으면 붙음 0으로만 두고 다음 PING 답을 기다린다 */
  reconnect?: () => Promise<PubSubClient>;
}

export interface RedisChannelSubscriberOptions extends Omit<RedisSubscriberOptions, 'reconnect'> {
  /** 단일 노드 주소(로컬·CI) */
  url?: string;
  /** 클러스터 시작 노드 주소들(운영) */
  clusterUrls?: readonly string[];
  startupTimeoutMs?: number;
}

export class RedisChannelSubscriberStartError extends Error {
  constructor() {
    super('좌석 Redis에 시작 마감 안에 붙지 못했다');
    this.name = 'RedisChannelSubscriberStartError';
  }
}

interface ChannelEntry {
  /** 원하는 상태: 있으면 구독, 없으면 해제 */
  want: Listener | undefined;
  /** 실제: 마지막으로 끝난 명령의 결과. 실패한 뒤와 다시 붙은 뒤는 모름 */
  have: 'yes' | 'no' | 'unknown';
  /** 명령을 보낸 채 답을 기다린다 */
  busy: boolean;
  /** 물러선 뒤 다시 보낼 때 */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 지금 물러서기 간격(ms). 0이면 물러서지 않는다 */
  backoffMs: number;
  /** node-redis에 넘기는 함수(채널마다 하나라 다시 보내도 두 번 받지 않는다) */
  readonly deliver: (message: string) => void;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

export class RedisChannelSubscriber {
  readonly #channels = new Map<string, ChannelEntry>();
  #client: PubSubClient;
  /** 연결 세대(연결을 갈면 오른다. 옛 연결의 답은 버린다) */
  #gen = 0;
  #up = false;
  #closed = false;
  #pinging = false;
  #replacing = false;
  #lastMismatch = 0;
  readonly #pingTimer: ReturnType<typeof setInterval>;

  private constructor(
    client: PubSubClient,
    private readonly o: RedisSubscriberOptions,
  ) {
    this.#client = client;
    this.#attach(client, this.#gen);
    this.#setUp(true);
    this.#pingTimer = setInterval(() => this.#ping(), SUBSCRIBER_PING_EVERY_MS);
    this.#pingTimer.unref?.();
  }

  /** 붙은 Pub/Sub 클라이언트로 구독기를 만든다(시험의 이음새, connect도 이것을 쓴다) */
  static async forClient(client: PubSubClient, o: RedisSubscriberOptions = {}): Promise<RedisChannelSubscriber> {
    return new RedisChannelSubscriber(client, o);
  }

  /** 붙은 구독기를 돌려준다. 시작 마감 안에 붙지 못하면 RedisChannelSubscriberStartError(오류 글에 주소를 싣지 않는다) */
  static async connect(o: RedisChannelSubscriberOptions): Promise<RedisChannelSubscriber> {
    const state = { started: false, gaveUp: false };
    const make = (): { client: PubSubClient; connect: () => Promise<unknown> } => (o.clusterUrls?.length ? clusterClient(o.clusterUrls, state) : singleClient(o.url, state));
    const first = make();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((r) => (timer = setTimeout(() => r('deadline'), o.startupTimeoutMs ?? SUBSCRIBER_STARTUP_TIMEOUT_MS)));
    try {
      const connecting = first.connect().then(() => 'connected' as const);
      connecting.catch(() => {});
      if ((await Promise.race([connecting, deadline])) === 'deadline') throw new RedisChannelSubscriberStartError();
    } catch {
      state.gaveUp = true;
      first.client.destroy();
      throw new RedisChannelSubscriberStartError();
    } finally {
      clearTimeout(timer);
    }
    state.started = true;
    // PING 답이 없으면 새 연결을 만든다(시작 뒤라 붙을 때까지 다시 시도한다)
    const reconnect = async (): Promise<PubSubClient> => {
      const next = make();
      await next.connect();
      return next.client;
    };
    const { url: _u, clusterUrls: _c, startupTimeoutMs: _s, ...rest } = o;
    return RedisChannelSubscriber.forClient(first.client, { ...rest, reconnect });
  }

  /** 지금 붙어 있는가 */
  get up(): boolean {
    return this.#up;
  }

  /** 채널을 원한다고 적고 곧 돌아온다(거절하지 않는다) */
  subscribe(channel: string, onMessage: Listener): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const e = this.#entry(channel);
    e.want = onMessage;
    this.#kick(channel, e);
    return Promise.resolve();
  }

  /** 채널을 원하지 않는다고 적고 곧 돌아온다(거절하지 않는다) */
  unsubscribe(channel: string): Promise<void> {
    const e = this.#channels.get(channel);
    if (!e || this.#closed) return Promise.resolve();
    e.want = undefined;
    this.#kick(channel, e);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#pingTimer);
    for (const e of this.#channels.values()) if (e.timer) clearTimeout(e.timer);
    this.#gen++;
    const client = this.#client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.resolve(client.close?.()).catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, CLOSE_GRACE_MS)))]);
    clearTimeout(timer);
    client.destroy();
    this.#up = false;
    this.o.onUp?.(false);
  }

  #attach(client: PubSubClient, gen: number): void {
    const mine = (): boolean => gen === this.#gen && !this.#closed;
    client.on('ready', () => {
      if (mine()) this.#ready();
    });
    const down = (): void => {
      if (mine()) this.#setUp(false);
    };
    client.on('error', down);
    client.on('end', down);
    client.on('reconnecting', down);
  }

  #setUp(up: boolean): void {
    if (this.#closed && up) return;
    if (this.#up === up) return;
    this.#up = up;
    this.o.onUp?.(up);
  }

  /** 붙었다(처음 또는 다시). 끊겼다 붙었으면 원하는 채널을 모두 모름으로 보고 다시 맞춘다 */
  #ready(): void {
    const wasUp = this.#up;
    this.#setUp(true);
    for (const [channel, e] of this.#channels) {
      if (!wasUp) {
        if (!e.busy && e.have === 'yes') e.have = 'unknown';
        if (e.timer) clearTimeout(e.timer);
        e.timer = undefined;
        e.backoffMs = 0;
      }
      this.#kick(channel, e);
    }
    this.#report();
  }

  #entry(channel: string): ChannelEntry {
    let e = this.#channels.get(channel);
    if (!e) {
      const entry: ChannelEntry = { want: undefined, have: 'no', busy: false, timer: undefined, backoffMs: 0, deliver: (message) => entry.want?.(message) };
      e = entry;
      this.#channels.set(channel, e);
    }
    return e;
  }

  #matched(e: ChannelEntry): boolean {
    return e.want !== undefined ? e.have === 'yes' : e.have === 'no';
  }

  #report(): void {
    let n = 0;
    for (const e of this.#channels.values()) if (!this.#matched(e)) n++;
    if (n === this.#lastMismatch) return;
    this.#lastMismatch = n;
    this.o.onMismatch?.(n);
  }

  /** 원하는 상태와 실제가 다르면 명령 하나를 보낸다(진행 중·물러서는 중·끊긴 동안은 기다린다) */
  #kick(channel: string, e: ChannelEntry): void {
    if (this.#closed) return;
    if (this.#matched(e)) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = undefined;
      e.backoffMs = 0;
      if (e.want === undefined && !e.busy) this.#channels.delete(channel);
      this.#report();
      return;
    }
    this.#report();
    if (e.busy || e.timer || !this.#up) return;
    const target = e.want !== undefined;
    const gen = this.#gen;
    const client = this.#client;
    e.busy = true;
    let op: Promise<void>;
    try {
      op = target ? client.sSubscribe(channel, e.deliver) : client.sUnsubscribe(channel);
    } catch (err) {
      op = Promise.reject(err);
    }
    Promise.resolve(op).then(
      () => {
        if (gen !== this.#gen) return;
        e.busy = false;
        e.have = target ? 'yes' : 'no';
        e.backoffMs = 0;
        this.#kick(channel, e);
      },
      (err: unknown) => {
        if (gen !== this.#gen) return;
        e.busy = false;
        e.have = 'unknown';
        this.#retryLater(channel, e, err);
      },
    );
  }

  #retryLater(channel: string, e: ChannelEntry, err: unknown): void {
    const prev = e.backoffMs;
    e.backoffMs = prev === 0 ? SUBSCRIBE_RETRY_FIRST_MS : Math.min(prev * 2, SUBSCRIBE_RETRY_MAX_MS);
    if (e.backoffMs !== prev) this.o.onError?.({ channel, error: errorName(err) });
    e.timer = setTimeout(() => {
      e.timer = undefined;
      this.#kick(channel, e);
    }, e.backoffMs);
    e.timer.unref?.();
    this.#report();
  }

  /** PING 한 번. 2초 안에 답이 없으면 붙음 0으로 두고 연결을 간다 */
  #ping(): void {
    if (this.#closed || this.#pinging || this.#replacing) return;
    this.#pinging = true;
    const gen = this.#gen;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), SUBSCRIBER_PING_TIMEOUT_MS)));
    const answered = Promise.resolve()
      .then(() => this.#client.ping())
      .then(
        () => 'pong' as const,
        () => 'error' as const,
      );
    void Promise.race([answered, timedOut]).then((r) => {
      clearTimeout(timer);
      this.#pinging = false;
      if (gen !== this.#gen || this.#closed) return;
      // 끊긴 뒤 ready 없이 답이 돌아왔으면 다시 붙은 것으로 본다
      if (r === 'pong' && !this.#up) this.#ready();
      if (r === 'timeout') this.#stalled();
    });
  }

  /** 답 없는 연결: 붙음 0, 연결을 버리고 새로 붙는다(새 연결에는 구독이 없다) */
  #stalled(): void {
    this.#setUp(false);
    const reconnect = this.o.reconnect;
    if (!reconnect) return;
    this.#replacing = true;
    this.#gen++;
    const old = this.#client;
    try {
      old.destroy();
    } catch {
      // 이미 끊긴 연결
    }
    for (const e of this.#channels.values()) {
      e.busy = false;
      e.have = 'no';
      if (e.timer) clearTimeout(e.timer);
      e.timer = undefined;
      e.backoffMs = 0;
    }
    const attempt = (): void => {
      if (this.#closed) return;
      reconnect().then(
        (client) => {
          if (this.#closed) {
            client.destroy();
            return;
          }
          this.#client = client;
          this.#attach(client, this.#gen);
          this.#replacing = false;
          this.#ready();
        },
        () => {
          const t = setTimeout(attempt, RECONNECT_MAX_DELAY_MS);
          t.unref?.();
        },
      );
    };
    attempt();
  }
}

const reconnectStrategy =
  (state: { started: boolean; gaveUp: boolean }) =>
  (retries: number): number | Error => {
    if (!state.started && state.gaveUp) return new RedisChannelSubscriberStartError();
    return Math.min(50 * 2 ** Math.min(retries, 5), RECONNECT_MAX_DELAY_MS);
  };

function singleClient(url: string | undefined, state: { started: boolean; gaveUp: boolean }): { client: PubSubClient; connect: () => Promise<unknown> } {
  if (!url) throw new Error('좌석 Redis 주소(url)나 클러스터 주소(clusterUrls)가 없다');
  const client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: reconnectStrategy(state) } });
  // 연결 오류는 붙음 상태로 드러난다. 주소가 든 오류 글을 따로 찍지 않는다
  client.on('error', () => {});
  return { client: client as unknown as PubSubClient, connect: () => client.connect() };
}

/**
 * 클러스터: 노드(샤드 구독 연결 포함)마다 붙음을 모아 하나의 ready·end로 낸다. PING은 클러스터의 아무 노드로 간다
 * (샤드 구독 연결 자체의 PING은 node-redis가 내주지 않는다. 구현 메모: 클러스터의 구독 연결 살핌은 노드 사건과 이 PING에 기댄다)
 */
function clusterClient(urls: readonly string[], state: { started: boolean; gaveUp: boolean }): { client: PubSubClient; connect: () => Promise<unknown> } {
  // 플랫폼의 클러스터 설정(인증·TLS·다시 붙기)을 쓰되, 구독 명령에 핫패스 명령 시한(100ms)을 걸지 않는다
  const { commandOptions: _hot, ...options } = redisClusterOptions(urls, state);
  const cluster = createCluster(options);
  const events = new EventEmitter();
  const nodes = new Map<string, boolean>();
  let allUp = false;
  const addr = (info: unknown): string => {
    const i = info as { host?: unknown; port?: unknown } | undefined;
    return `${String(i?.host ?? '?')}:${String(i?.port ?? '?')}`;
  };
  const mark = (info: unknown, up: boolean): void => {
    nodes.set(addr(info), up);
    const now = [...nodes.values()].every(Boolean);
    if (now === allUp) return;
    allUp = now;
    events.emit(now ? 'ready' : 'end');
  };
  cluster.on('error', () => {});
  cluster.on('node-ready', (info: unknown) => mark(info, true));
  cluster.on('node-error', (_e: unknown, info: unknown) => mark(info, false));
  cluster.on('node-reconnecting', (info: unknown) => mark(info, false));
  cluster.on('node-disconnect', (info: unknown) => mark(info, false));
  const client: PubSubClient = {
    sSubscribe: (channel, listener) => cluster.sSubscribe(channel, listener),
    sUnsubscribe: (channel) => cluster.sUnsubscribe(channel),
    ping: () => cluster.sendCommand(undefined, true, ['PING']),
    on: (event, listener) => events.on(event, listener),
    destroy: () => cluster.destroy(),
    close: () => cluster.close(),
  };
  return { client, connect: () => cluster.connect() };
}
