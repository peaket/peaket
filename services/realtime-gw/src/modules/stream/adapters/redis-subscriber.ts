// 좌석 Redis 샤드 Pub/Sub 구독(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '좌석 Redis 구독', docs/api/guidelines.md §8·§8.1 이 행,
// docs/data.md §5, ADR-0296, BUILD_ORDER HOT-090). node-redis 6.3.0의 sSubscribe·sUnsubscribe(단일 노드, 클러스터면 샤드마다 연결)를 쓴다.
// 쓰는 명령은 SSUBSCRIBE·SUNSUBSCRIBE와 연결 명령(HELLO·AUTH·PING·CLIENT)뿐이다(ASVS v5.0.0-13.3.2). 데이터 키에는 닿지 않는다(ADR-0007).
// - 채널마다 원하는 상태(구독할 함수가 있음)와 실제(마지막으로 끝난 명령의 결과)를 두고, 같은 채널의 명령은 한 번에 하나씩 하며 끝난 뒤 다르면 한 번 더 한다.
// - 연결이 끊긴 동안 온 구독·해제는 원하는 상태만 적고 성공으로 돌려준다. 다시 붙으면(ready) 원하는 채널을 모두 다시 맞춘다
//   (node-redis도 실제로 구독했던 채널을 다시 구독한다. 끊긴 동안 받은 구독은 node-redis가 모르므로 여기서 한다).
// - 붙어 있는데 명령이 실패하면 던진다(허브가 다음 박자에 다시 맞춘다).
// - realtime_gw_redis_up: 붙어 있으면 1(클러스터는 아는 노드가 모두 붙어 있을 때 1), 끊기면 0.
// 유스케이스 층의 형을 가져오지 않는다(층 의존 방향). 허브의 ChannelSubscriber와 같은 모양이라 조립(start.ts)에서 그대로 넘긴다.
import { createClient, createCluster } from 'redis';
import { redisClusterOptions } from '@peaket/platform';

/** 시작 때 붙는 마감(ms). 넘으면 시작하지 않는다 */
export const SUBSCRIBER_STARTUP_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 1_000;
/** 다시 붙기 간격 상한(ms) */
const RECONNECT_MAX_DELAY_MS = 2_000;

type Listener = (message: string) => void;

interface ChannelEntry {
  /** 원하는 상태: 있으면 구독, 없으면 해제 */
  listener: Listener | undefined;
  /** 실제(마지막으로 끝난 명령의 결과) */
  have: boolean;
  /** 맞추는 중이면 그 약속 */
  running: Promise<void> | undefined;
}

/** sSubscribe·sUnsubscribe만 쓰는 최소 모양(단일·클러스터 공통) */
interface PubSubClient {
  sSubscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  sUnsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
  destroy(): void;
}

export interface RedisChannelSubscriberOptions {
  /** 단일 노드 주소(로컬·CI) */
  url?: string;
  /** 클러스터 시작 노드 주소들(운영) */
  clusterUrls?: readonly string[];
  /** 붙음 상태가 바뀔 때(realtime_gw_redis_up) */
  onUp?(up: boolean): void;
  /** 다시 맞추다 실패했을 때(채널 이름과 오류 이름만) */
  onError?(e: { channel: string; error: string }): void;
  startupTimeoutMs?: number;
}

export class RedisChannelSubscriberStartError extends Error {
  constructor() {
    super('좌석 Redis에 시작 마감 안에 붙지 못했다');
    this.name = 'RedisChannelSubscriberStartError';
  }
}

export class RedisChannelSubscriber {
  readonly #channels = new Map<string, ChannelEntry>();
  #up = false;
  #closed = false;

  private constructor(
    private readonly client: PubSubClient,
    private readonly o: RedisChannelSubscriberOptions,
  ) {}

  /** 붙은 구독기를 돌려준다. 시작 마감 안에 붙지 못하면 RedisChannelSubscriberStartError(오류 글에 주소를 싣지 않는다) */
  static async connect(o: RedisChannelSubscriberOptions): Promise<RedisChannelSubscriber> {
    const state = { started: false, gaveUp: false };
    const reconnectStrategy = (retries: number): number | Error => {
      if (!state.started && state.gaveUp) return new RedisChannelSubscriberStartError();
      return Math.min(50 * 2 ** Math.min(retries, 5), RECONNECT_MAX_DELAY_MS);
    };
    let sub: RedisChannelSubscriber;
    let connect: () => Promise<unknown>;
    if (o.clusterUrls?.length) {
      // 플랫폼의 클러스터 설정(인증·TLS·다시 붙기)을 쓰되, 구독 명령에 핫패스 명령 시한(100ms)을 걸지 않는다
      const { commandOptions: _hot, ...options } = redisClusterOptions(o.clusterUrls, state);
      const cluster = createCluster(options);
      const nodes = new Map<string, boolean>();
      sub = new RedisChannelSubscriber(cluster as unknown as PubSubClient, o);
      const mark = (address: string, up: boolean): void => {
        nodes.set(address, up);
        sub.#setUp([...nodes.values()].every(Boolean));
        if (up) sub.#resyncAll();
      };
      const addr = (info: unknown): string => String((info as { host?: unknown; port?: unknown } | undefined)?.host ?? '?') + ':' + String((info as { port?: unknown } | undefined)?.port ?? '?');
      cluster.on('error', () => {});
      cluster.on('node-ready', (info: unknown) => mark(addr(info), true));
      cluster.on('node-error', (_e: unknown, info: unknown) => mark(addr(info), false));
      cluster.on('node-reconnecting', (info: unknown) => mark(addr(info), false));
      cluster.on('node-disconnect', (info: unknown) => mark(addr(info), false));
      connect = () => cluster.connect();
    } else {
      if (!o.url) throw new Error('좌석 Redis 주소(url)나 클러스터 주소(clusterUrls)가 없다');
      const client = createClient({
        url: o.url,
        disableOfflineQueue: true,
        socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy },
      });
      sub = new RedisChannelSubscriber(client as unknown as PubSubClient, o);
      // 연결 오류는 붙음 상태로 드러난다. 주소가 든 오류 글을 따로 찍지 않는다
      client.on('error', () => sub.#setUp(false));
      client.on('reconnecting', () => sub.#setUp(false));
      client.on('end', () => sub.#setUp(false));
      client.on('ready', () => {
        sub.#setUp(true);
        sub.#resyncAll();
      });
      connect = () => client.connect();
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((r) => (timer = setTimeout(() => r('deadline'), o.startupTimeoutMs ?? SUBSCRIBER_STARTUP_TIMEOUT_MS)));
    try {
      const connecting = connect().then(() => 'connected' as const);
      connecting.catch(() => {});
      if ((await Promise.race([connecting, deadline])) === 'deadline') throw new RedisChannelSubscriberStartError();
    } catch {
      state.gaveUp = true;
      sub.client.destroy();
      throw new RedisChannelSubscriberStartError();
    } finally {
      clearTimeout(timer);
    }
    state.started = true;
    sub.#setUp(true);
    return sub;
  }

  /** 지금 붙어 있는가 */
  get up(): boolean {
    return this.#up;
  }

  /** 채널을 구독한다. 끊긴 동안이면 원하는 상태만 적고 돌아온다(다시 붙으면 구독한다). 붙어 있는데 실패하면 던진다 */
  subscribe(channel: string, onMessage: Listener): Promise<void> {
    const e = this.#entry(channel);
    e.listener = onMessage;
    return this.#sync(channel, e);
  }

  /** 채널 구독을 푼다. 끊긴 동안이면 원하는 상태만 적고 돌아온다. 붙어 있는데 실패하면 던진다 */
  unsubscribe(channel: string): Promise<void> {
    const e = this.#channels.get(channel);
    if (!e) return Promise.resolve();
    e.listener = undefined;
    return this.#sync(channel, e);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.client.close().catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, 1_000)))]);
    clearTimeout(timer);
    this.client.destroy();
    this.#setUp(false);
  }

  #setUp(up: boolean): void {
    if (this.#closed && up) return;
    if (this.#up === up) return;
    this.#up = up;
    this.o.onUp?.(up);
  }

  #entry(channel: string): ChannelEntry {
    let e = this.#channels.get(channel);
    if (!e) {
      e = { listener: undefined, have: false, running: undefined };
      this.#channels.set(channel, e);
    }
    return e;
  }

  /** 다시 붙었을 때: 원하는 상태와 실제가 다른 채널을 모두 맞춘다 */
  #resyncAll(): void {
    for (const [channel, e] of this.#channels) {
      if ((e.listener !== undefined) !== e.have) {
        this.#sync(channel, e).catch((err: unknown) => this.o.onError?.({ channel, error: err instanceof Error ? err.name : 'unknown' }));
      }
    }
  }

  /** 같은 채널은 한 번에 하나씩: 진행 중이면 그것이 끝난 뒤 한 번 더 맞춘다 */
  #sync(channel: string, e: ChannelEntry): Promise<void> {
    const prev = e.running ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.#apply(channel, e))
      .finally(() => {
        if (e.running === run) e.running = undefined;
        if (e.listener === undefined && !e.have && e.running === undefined) this.#channels.delete(channel);
      });
    e.running = run;
    return run;
  }

  async #apply(channel: string, e: ChannelEntry): Promise<void> {
    // 끝난 뒤 원하는 상태가 또 바뀌었으면 한 번 더 한다
    for (let round = 0; round < 3; round++) {
      const target = e.listener !== undefined;
      if (target === e.have || this.#closed) return;
      try {
        if (target) {
          // 채널마다 함수 하나: 원하는 함수가 바뀌어도 지금 것을 부른다
          await this.client.sSubscribe(channel, (message) => e.listener?.(message));
          e.have = true;
        } else {
          await this.client.sUnsubscribe(channel);
          e.have = false;
        }
      } catch (err) {
        // 끊긴 동안의 실패는 다시 붙을 때 맞춘다(원하는 상태는 이미 적었다). 붙어 있는데 실패하면 부른 쪽에 알린다
        if (!this.#up) return;
        throw err;
      }
    }
  }
}
