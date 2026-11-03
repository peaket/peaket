// 서비스 소비자의 키 단위 동시 처리와 보류(openspec 변경 add-maintenance-control-and-consumers 결정 5·6, ADR-0142 결정 1·2,
// docs/streaming.md §2.4 '서비스 소비자의 규칙', docs/data.md §4의 15번). Kafka 클라이언트와 상관없는 파티션 하나의 규칙이다.
// - 같은 업무 키는 받은 순서대로, 다른 키는 동시에(파티션마다 32개 [가정]). 커밋할 위치는 '끝나지 않은 가장 작은 오프셋'
// - 같은 결과일 실패는 5회 [가정] 해 본 뒤 보류 표로, 같은 키의 뒤 사건도 보류. 저장소 연결 실패·시간 초과는 파티션을 멈추고 기다린다
// - 다시 받은 사건 거르기(eventKey)는 처리기가 자기 트랜잭션에서 한다
import { Counter, Gauge, type Registry } from '@prometheus-io/client';
import { DrizzleQueryError } from 'drizzle-orm';

export const KEYED_CONSUMER_DEFAULTS = {
  maxKeysPerPartition: 32,
  /** 같은 결과일 실패를 몇 번 해 보고 보류하나 */
  attempts: 5,
  /** 같은 결과일 실패 사이 쉬기: 0.2·0.4·0.8·1.6초 [가정] */
  retryBaseMs: 200,
  /** 일시 실패(저장소 연결·시간 초과) 늘려 쉬기 0.2~30초 [가정](스트림 작업자와 같다, streaming §2.4) */
  transientMinMs: 200,
  transientMaxMs: 30_000,
  /** 받고 끝나지 않은 사건 상한(같은 키가 몰려도 메모리가 끝없이 늘지 않게) [가정] */
  maxBuffered: 1_000,
  /** 실행기가 커밋하는 주기 [가정] */
  commitEveryMs: 1_000,
  /** 보류 수를 재는 주기 [가정] */
  measureHeldEveryMs: 30_000,
} as const;

export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: bigint;
  key: string | null;
  value: Buffer | null;
  headers: Record<string, string>;
  /** Kafka 레코드 시각(밀리초). 업무 시각은 메시지 안의 시각을 쓴다(streaming §2.6) */
  timestamp: number;
}

export interface HeldEventInput {
  topic: string;
  partition: number;
  offset: bigint;
  eventKey: string | null;
  businessKey: string;
  /** 오류 요약(이름과 메시지, 사건 값은 넣지 않는다) */
  error: string;
  /** Kafka 키(다시 처리 때 그대로 넘긴다) */
  key: string | null;
  value: Buffer | null;
  headers: Record<string, string>;
  /** Kafka 레코드 시각(밀리초) */
  timestamp: number;
}

/** 보류 표 포트(Drizzle 구현은 held-events.ts) */
export interface HeldEventStore {
  /** 그 파티션에서 아직 보류 중인 업무 키 */
  heldKeys(topic: string, partition: number): Promise<Set<string>>;
  isHeld(topic: string, businessKey: string): Promise<boolean>;
  /** 넣는다. 같은 (토픽, 파티션, 오프셋)이나 같은 eventKey는 두 번 넣지 않는다 */
  hold(e: HeldEventInput): Promise<void>;
  /**
   * 그 업무 키가 아직 보류 중일 때만 넣고 넣었는지 돌려준다. 확인과 넣기를 한 번에 해, 다시 처리(RB-11)가 마지막 행을 끝낸 직후에
   * 뒤 사건을 넣어 키가 다시 보류되는 겨룸을 막는다(코드 리뷰 2026-11-01)
   */
  holdIfHeld(e: HeldEventInput): Promise<boolean>;
}

export interface KeyedHandler<T> {
  /** 값을 읽는다(Avro는 BAS-030). 레지스트리에 닿지 못하면 TransientError를 던진다 */
  decode(m: ConsumedMessage): T | Promise<T>;
  /** 업무 키(주문 ID 등) */
  keyOf(event: T, m: ConsumedMessage): string;
  eventKeyOf?(event: T): string | undefined;
  handle(event: T, m: ConsumedMessage): Promise<void>;
}

/** 저장소 연결 실패·시간 초과처럼 다시 하면 될 실패. 이 표시가 없어도 아래 코드는 일시 실패로 본다 */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // PostgreSQL: 연결 끊김(57P01~03), 문장 시간 초과·취소(57014), 잠금 기다림 초과(55P03), 연결 수 초과(53300), 직렬화 실패·교착(40001·40P01)
  '57P01',
  '57P02',
  '57P03',
  '57014',
  '55P03',
  '53300',
  '40001',
  '40P01',
]);
const TRANSIENT_NAMES = new Set(['TransientError', 'TimeoutError', 'AbortError']);
/** node-postgres·pg-pool이 코드 없이 던지는 연결 오류 글(코드 리뷰 2026-11-01) */
const TRANSIENT_MESSAGES = /Connection terminated|connection error|Query read timeout|timeout exceeded when trying to connect|Connection timed out|socket hang up/i;

export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (TRANSIENT_NAMES.has(err.name)) return true;
  // 풀 대기 초과(429 server-busy)·판정 못 함(503) 같은 자기 과부하·의존성 거절
  if (err.name === 'ProblemError' && [429, 503].includes((err as { status?: number }).status ?? 0)) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code))) return true;
  if (code === undefined && !(err instanceof DrizzleQueryError) && TRANSIENT_MESSAGES.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err && isTransientError(cause);
}

/**
 * 오류 요약(보류 행·로그). Drizzle 쿼리 오류의 메시지는 매개변수 값(params: …)을 싣고 값은 개인정보일 수 있어,
 * 쿼리 틀과 DB 오류 코드만 남긴다(request-log의 queryErrorInfo와 같은 규칙, ASVS v5.0.0-16.2.5, 코드 리뷰 2026-11-01)
 */
export const errorSummary = (err: unknown): string => {
  if (err instanceof DrizzleQueryError) {
    const code = (err.cause as { code?: unknown } | undefined)?.code;
    return `DrizzleQueryError: Failed query: ${err.query}${typeof code === 'string' ? ` (${code})` : ''}`.slice(0, 500);
  }
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : `throw: ${String(err)}`.slice(0, 500);
};

const metricsByRegistry = new WeakMap<Registry, KeyedConsumerMetrics>();

export class KeyedConsumerMetrics {
  /** 지표 저장소마다 하나(같은 저장소로 두 번 만들면 이름이 겹쳐 실패한다, 코드 리뷰 2026-11-01) */
  static for(registry: Registry, service: string): KeyedConsumerMetrics {
    let m = metricsByRegistry.get(registry);
    if (!m) {
      m = new KeyedConsumerMetrics(registry, service);
      metricsByRegistry.set(registry, m);
    }
    return m;
  }

  readonly inflightKeys: Gauge<'service' | 'topic'>;
  readonly pausedPartitions: Gauge<'service' | 'topic'>;
  readonly held: Gauge<'service' | 'topic'>;
  readonly processed: Counter<'service' | 'topic'>;
  readonly retries: Counter<'service' | 'topic' | 'kind'>;
  readonly heldTotal: Counter<'service' | 'topic'>;
  constructor(
    registry: Registry,
    readonly service: string,
  ) {
    const registers = [registry];
    this.inflightKeys = new Gauge({ name: 'consumer_inflight_keys', help: '처리 중인 업무 키 수', labelNames: ['service', 'topic'], registers });
    this.pausedPartitions = new Gauge({ name: 'consumer_paused_partitions', help: '일시 실패로 가져오기를 멈춘 파티션 수', labelNames: ['service', 'topic'], registers });
    this.held = new Gauge({ name: 'consumer_held_events', help: '보류 표에 남은(다시 처리하지 않은) 사건 수', labelNames: ['service', 'topic'], registers });
    this.processed = new Counter({ name: 'consumer_processed_total', help: '처리를 마친 사건 수', labelNames: ['service', 'topic'], registers });
    this.retries = new Counter({ name: 'consumer_retries_total', help: '다시 한 수(kind: transient·failed)', labelNames: ['service', 'topic', 'kind'], registers });
    this.heldTotal = new Counter({ name: 'consumer_held_total', help: '보류 표로 옮긴 사건 수', labelNames: ['service', 'topic'], registers });
  }
}

/**
 * 파티션 하나의 가져오기 멈춤 이유를 센다(코드 리뷰 2026-11-01). 쓰는 클라이언트의 pause·resume은 횟수를 세지 않아 resume 한 번이
 * 앞선 멈춤을 모두 푼다. 그래서 이유(키 줄의 일시 실패, 실행기의 늘려 쉬기)가 하나라도 남으면 열지 않고, 모두 풀릴 때 한 번 열며
 * 그때 이어 읽을 위치(받기로 한 가장 큰 오프셋 + 1)로 맞춘다(멈춘 동안 클라이언트가 버린 캐시를 건너뛰지 않게)
 */
export class PauseGate {
  readonly #reasons = new Set<string>();
  #closed = false;

  constructor(private readonly o: { pause(): void; resume(next: bigint | undefined): void; next(): bigint | undefined }) {}

  hold(reason: string): void {
    if (this.#closed || this.#reasons.has(reason)) return;
    this.#reasons.add(reason);
    if (this.#reasons.size === 1) this.o.pause();
  }

  release(reason: string): void {
    if (this.#closed || !this.#reasons.delete(reason)) return;
    if (this.#reasons.size === 0) this.o.resume(this.o.next());
  }

  get held(): boolean {
    return this.#reasons.size > 0;
  }

  /** 넘긴 파티션: 더는 멈추거나 열지 않는다 */
  close(): void {
    this.#closed = true;
    this.#reasons.clear();
  }
}

/** 넘기며 버린 파티션의 처리 줄을 끝내는 표시 */
class Abandoned extends Error {}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface KeyedPartitionOptions<T> {
  topic: string;
  partition: number;
  handler: KeyedHandler<T>;
  held: HeldEventStore;
  maxKeys?: number;
  maxBuffered?: number;
  sleep?: Sleep;
  /** 일시 실패로 파티션 가져오기를 멈춘다/다시 한다(실행기가 consumer.pause·resume을 부른다) */
  onPause?: () => void;
  /** next: 이어 읽을 위치(받은 가장 큰 오프셋 + 1). 멈춘 동안 버려진 캐시를 건너뛰지 않게 실행기가 그 위치로 맞춘다 */
  onResume?: (next: bigint | undefined) => void;
  /** 예상하지 못한 오류(처리를 다시 한다) */
  onError?: (err: unknown) => void;
  metrics?: KeyedConsumerMetrics;
  /** 보류 때 로그(사건 값은 넘기지 않는다) */
  onHeld?: (e: Omit<HeldEventInput, 'value' | 'headers' | 'key' | 'timestamp'>) => void;
}

interface Job<T> {
  m: ConsumedMessage;
  key: string;
  event?: T;
  /** 읽기에 실패한 사건(같은 결과일 실패로 다룬다) */
  decodeError?: unknown;
}

/** 파티션 하나의 키 단위 처리기. 실행기가 파티션을 받을 때 만들고 init()을 부른 뒤 push한다 */
export class KeyedPartition<T> {
  readonly #lanes = new Map<string, Job<T>[]>();
  readonly #order: bigint[] = [];
  #head = 0;
  readonly #done = new Set<bigint>();
  #maxSeen: bigint | undefined;
  #heldKeys = new Set<string>();
  #initialized = false;
  #abandoned = false;
  /** 받기로 한 가장 큰 오프셋(다시 시작 위치와 다시 배달된 사건 거르기) */
  #maxReceived: bigint | undefined;
  /** 받고 아직 끝나지 않은 사건 수(받은 사건 상한) */
  #outstanding = 0;
  #transientLanes = 0;
  #waiters: (() => void)[] = [];
  #idle: (() => void)[] = [];
  readonly #sleep: Sleep;

  constructor(private readonly o: KeyedPartitionOptions<T>) {
    this.#sleep = o.sleep ?? defaultSleep;
  }

  /**
   * 보류 중인 키를 읽어 둔다(파티션을 받을 때). 한 번만 해 보고 실패하면 던진다: 실행기가 받기 처리기 안에서 오래 기다리지 않고
   * 그 파티션을 멈춘 뒤 다시 한다(받기 처리기가 오래 막히면 클라이언트가 캐시를 비우며 위치를 건너뛸 수 있다, 코드 리뷰 2026-11-01)
   */
  async init(): Promise<void> {
    if (this.#initialized) return;
    const keys = await this.o.held.heldKeys(this.o.topic, this.o.partition);
    // 시간 한도로 겹쳐 부른 읽기는 먼저 끝난 결과만 쓴다. 늦게 끝난 옛 목록이 그사이 보류한 키를 지우면 같은 키 순서가 깨진다(코드 리뷰 2026-11-01)
    if (this.#initialized) return;
    this.#heldKeys = keys;
    this.#initialized = true;
  }

  /** 이어 읽을 위치(받기로 한 가장 큰 오프셋 + 1). 받은 것이 없으면 없음 */
  get nextOffset(): bigint | undefined {
    return this.#maxReceived === undefined ? undefined : this.#maxReceived + 1n;
  }

  /**
   * 넘기기 기다림이 한도를 넘었다: 처리 줄은 지금 시도를 마친 뒤 더 하지 않고 멈춤·다시 시작도 부르지 않는다. 끝나지 않은 사건은
   * 끝난 것으로 치지 않으므로 커밋할 위치가 그 앞에 머문다(새 주인이 다시 처리하고 처리기가 eventKey로 거른다)
   */
  abandon(): void {
    this.#abandoned = true;
    // 자리를 기다리던 받기도 깨워 돌려보낸다(받기 처리기가 돌아와야 클라이언트가 끊을 수 있다, 코드 리뷰 2026-11-01)
    for (const w of this.#waiters.splice(0)) w();
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get inflightKeys(): number {
    return this.#lanes.size;
  }

  get paused(): boolean {
    return this.#transientLanes > 0;
  }

  /**
   * 받은 순서대로 부른다. 새 키인데 자리가 없거나 받은 사건이 상한이면 자리가 날 때까지 기다린다.
   * 일시 실패로 멈춘 동안에는 기다리지 않고 받는다: 실행기가 가져오기 멈춤을 거는 동안 받기가 막히면 멈춤이 걸리지 않는다
   * (쓰는 클라이언트는 받기 처리기가 모두 돌아와야 멈춤을 적용한다, 코드 리뷰 2026-11-01). 멈춘 뒤에는 이미 가져온 것만 온다
   */
  async push(m: ConsumedMessage): Promise<void> {
    if (this.#abandoned) return;
    // 다시 시작하며 이미 받은 사건이 다시 오면 버린다(같은 오프셋이 두 번 들어가면 커밋 위치가 멈춘다, 코드 리뷰 2026-11-01)
    if (this.#maxReceived !== undefined && m.offset <= this.#maxReceived) return;
    const job = await this.#prepare(m);
    this.#maxReceived = m.offset;
    const max = this.o.maxKeys ?? KEYED_CONSUMER_DEFAULTS.maxKeysPerPartition;
    const maxBuffered = this.o.maxBuffered ?? KEYED_CONSUMER_DEFAULTS.maxBuffered;
    while (!this.#abandoned && !this.paused && ((!this.#lanes.has(job.key) && this.#lanes.size >= max) || this.#outstanding >= maxBuffered)) {
      await new Promise<void>((r) => this.#waiters.push(r));
    }
    if (this.#abandoned) return;
    this.#outstanding += 1;
    // 받은 순서가 곧 오프셋 순서지만(실행기는 push를 차례로 기다린다), 겹쳐 부르면 자리를 찾아 넣는다
    let at = this.#order.length;
    while (at > this.#head && this.#order[at - 1]! > m.offset) at -= 1;
    this.#order.splice(at, 0, m.offset);
    if (this.#maxSeen === undefined || m.offset > this.#maxSeen) this.#maxSeen = m.offset;
    const lane = this.#lanes.get(job.key);
    if (lane) {
      lane.push(job);
      return;
    }
    this.#lanes.set(job.key, [job]);
    this.o.metrics?.inflightKeys.inc(this.#labels);
    void this.#run(job.key);
  }

  /** 커밋할 위치: 끝나지 않은 가장 작은 오프셋, 없으면 받은 가장 큰 오프셋 + 1. 받은 것이 없으면 없음 */
  committable(): bigint | undefined {
    while (this.#head < this.#order.length && this.#done.has(this.#order[this.#head]!)) {
      this.#done.delete(this.#order[this.#head]!);
      this.#head += 1;
    }
    if (this.#head > 1024 && this.#head * 2 > this.#order.length) {
      this.#order.splice(0, this.#head);
      this.#head = 0;
    }
    if (this.#head < this.#order.length) return this.#order[this.#head];
    return this.#maxSeen === undefined ? undefined : this.#maxSeen + 1n;
  }

  /** 받은 사건이 모두 끝날 때까지 기다린다(넘기기·종료 전) */
  async drain(): Promise<void> {
    while (this.#lanes.size > 0) await new Promise<void>((r) => this.#idle.push(r));
  }

  get #labels() {
    return { service: this.o.metrics?.service ?? '', topic: this.o.topic };
  }

  async #prepare(m: ConsumedMessage): Promise<Job<T>> {
    // 업무 키를 모르면 Kafka 키 그대로(같은 Kafka 키를 업무 키로 쓰는 소비자에서는 뒤 사건도 함께 보류된다, 코드 리뷰 2026-11-01)
    const fallback = m.key ?? '';
    try {
      const event = await this.o.handler.decode(m);
      return { m, key: this.o.handler.keyOf(event, m), event };
    } catch (err) {
      // 레지스트리에 닿지 못했다: 받지 않고 던진다. 실행기가 그 파티션을 멈추고 이 사건부터 다시 받는다(streaming §2.6)
      if (isTransientError(err)) {
        this.o.metrics?.retries.inc({ ...this.#labels, kind: 'transient' });
        throw err;
      }
      return { m, key: fallback, decodeError: err };
    }
  }

  async #run(key: string): Promise<void> {
    const lane = this.#lanes.get(key)!;
    let crashes = 0;
    while (lane.length > 0) {
      const job = lane[0]!;
      try {
        if (this.#abandoned) throw new Abandoned();
        await this.#process(job);
      } catch (err) {
        if (err instanceof Abandoned) break;
        // 예상하지 못한 오류(처리기 밖 코드의 예외): 버리지 않고 같은 사건을 다시 한다. 처리되지 않은 거부로 프로세스가 죽지 않게 한다
        this.o.onError?.(err);
        await this.#sleep(this.#backoff(crashes));
        crashes += 1;
        continue;
      }
      crashes = 0;
      lane.shift();
      this.#done.add(job.m.offset);
      this.#outstanding -= 1;
      for (const w of this.#waiters.splice(0)) w();
    }
    this.#lanes.delete(key);
    this.o.metrics?.inflightKeys.dec(this.#labels);
    for (const w of this.#waiters.splice(0)) w();
    if (this.#lanes.size === 0) for (const w of this.#idle.splice(0)) w();
  }

  async #process(job: Job<T>): Promise<void> {
    if (this.#heldKeys.has(job.key)) {
      // 다시 처리(RB-11)로 풀렸을 수 있어, 아직 보류 중일 때만 넣는다(확인과 넣기를 한 번에)
      const e = this.#heldInput(job, '같은 업무 키의 앞 사건이 보류 중이다');
      if (await this.#untilStored(() => this.o.held.holdIfHeld(e))) return this.#afterHold(e);
      this.#heldKeys.delete(job.key);
    }
    const attempts = KEYED_CONSUMER_DEFAULTS.attempts;
    let failures = 0;
    let transient = 0;
    for (;;) {
      try {
        if (job.decodeError !== undefined) throw job.decodeError;
        await this.o.handler.handle(job.event as T, job.m);
        if (transient > 0) this.#endTransient();
        this.o.metrics?.processed.inc(this.#labels);
        return;
      } catch (err) {
        if (this.#abandoned) {
          if (transient > 0) this.#endTransient();
          throw new Abandoned();
        }
        if (isTransientError(err)) {
          if (transient === 0) this.#beginTransient();
          this.o.metrics?.retries.inc({ ...this.#labels, kind: 'transient' });
          await this.#sleep(this.#backoff(transient));
          transient += 1;
          continue;
        }
        failures += 1;
        if (failures >= attempts) {
          if (transient > 0) this.#endTransient();
          this.#heldKeys.add(job.key);
          return this.#hold(job, errorSummary(err));
        }
        this.o.metrics?.retries.inc({ ...this.#labels, kind: 'failed' });
        await this.#sleep(KEYED_CONSUMER_DEFAULTS.retryBaseMs * 2 ** (failures - 1));
      }
    }
  }

  #heldInput(job: Job<T>, error: string): HeldEventInput {
    let eventKey: string | null = null;
    try {
      eventKey = job.event !== undefined ? (this.o.handler.eventKeyOf?.(job.event) ?? null) : null;
    } catch {
      // 깨진 사건에서 eventKey를 꺼내지 못하면 비워 둔다(위치로 두 번 넣지 않는다)
    }
    return {
      topic: job.m.topic,
      partition: job.m.partition,
      offset: job.m.offset,
      eventKey,
      businessKey: job.key,
      error,
      key: job.m.key,
      value: job.m.value,
      headers: job.m.headers,
      timestamp: job.m.timestamp,
    };
  }

  async #hold(job: Job<T>, error: string): Promise<void> {
    const e = this.#heldInput(job, error);
    await this.#untilStored(() => this.o.held.hold(e));
    this.#afterHold(e);
  }

  #afterHold(e: HeldEventInput): void {
    this.o.metrics?.heldTotal.inc(this.#labels);
    this.o.onHeld?.({ topic: e.topic, partition: e.partition, offset: e.offset, eventKey: e.eventKey, businessKey: e.businessKey, error: e.error });
  }

  /**
   * 보류 표 일을 될 때까지 한다. 실패하면 파티션을 멈추고 늘려 쉰다. 일시 실패가 아니어도(표 없음 등) 사건을 잃지 않으려고
   * 계속 기다린다(운영자가 고칠 때까지 그 파티션이 멈추고 consumer_paused_partitions로 보인다)
   */
  async #untilStored<R>(fn: () => Promise<R>): Promise<R> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const r = await fn();
        if (attempt > 0) this.#endTransient();
        return r;
      } catch {
        if (this.#abandoned) {
          if (attempt > 0) this.#endTransient();
          throw new Abandoned();
        }
        if (attempt === 0) this.#beginTransient();
        this.o.metrics?.retries.inc({ ...this.#labels, kind: 'transient' });
        await this.#sleep(this.#backoff(attempt));
      }
    }
  }

  #backoff(attempt: number): number {
    return Math.min(KEYED_CONSUMER_DEFAULTS.transientMaxMs, KEYED_CONSUMER_DEFAULTS.transientMinMs * 2 ** attempt);
  }

  #beginTransient(): void {
    this.#transientLanes += 1;
    if (this.#transientLanes === 1) {
      this.o.metrics?.pausedPartitions.inc(this.#labels);
      if (!this.#abandoned) this.o.onPause?.();
      // 자리를 기다리던 push는 멈춘 동안 기다리지 않는다
      for (const w of this.#waiters.splice(0)) w();
    }
  }

  #endTransient(): void {
    if (this.#transientLanes === 0) return;
    this.#transientLanes -= 1;
    if (this.#transientLanes === 0) {
      this.o.metrics?.pausedPartitions.dec(this.#labels);
      if (!this.#abandoned) this.o.onResume?.(this.nextOffset);
    }
  }
}
