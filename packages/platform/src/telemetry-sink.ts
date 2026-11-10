// 텔레메트리 보내기(docs/streaming.md §2.6 '생산자(텔레메트리)', docs/architecture.md §5, ADR-0141 결정 6, ADR-0249 결정 4).
// 요청 처리를 막지 않는다: offer는 기다리지 않고 던지지 않는다. 버퍼가 차면 새 기록을 버리고 센다(telemetry_dropped_total{record}).
// 이 파일은 Kafka 네이티브 모듈을 싣지 않는다(생산자는 @peaket/platform/stream-worker에서 만들어 넘긴다).
import { Counter, type Registry } from '@prometheus-io/client';
import { kafkaAuthFromEnv, type KafkaAuth } from './msk-iam.js';

/** 파드마다 버퍼 상한 1만 건 [가정](wbs 3.7.1에서 잰다) */
export const TELEMETRY_BUFFER_CAPACITY = 10_000;
/** 한 번에 보내는 건수 500건 [가정] */
export const TELEMETRY_BATCH_SIZE = 500;
/** 첫 기록을 받고 묶어 보낼 때까지 머무는 시간 50ms [가정] */
export const TELEMETRY_LINGER_MS = 50;
/** 연결 상한 3초 [가정]. 실제 클라이언트는 닫힌 포트에 81초를 끈다(ADR-0249 결정 4) */
export const TELEMETRY_CONNECT_TIMEOUT_MS = 3_000;
/** 보내기 상한: 생산자 전달 상한 5초(KAFKA_REQUIRED default)에 1초 [가정]를 더한 값 */
export const TELEMETRY_SEND_TIMEOUT_MS = 6_000;
/** 연결·보내기가 실패한 뒤 다시 시도까지 부르지 않는 시간 5초 [가정]. 그동안 묶음은 바로 실패로 세어 버퍼 비우기가 멈추지 않는다 */
export const TELEMETRY_RETRY_AFTER_MS = 5_000;

export interface TelemetryMessage {
  /** 파티션 키. 없으면 null(asyncapi의 '키 없음') */
  key: string | null;
  value: Buffer;
}

export type TelemetrySend = (topic: string, messages: TelemetryMessage[]) => Promise<void>;

/** 기록 종류별 버린 수를 받는다(지표나 시험 대역) */
export type TelemetryDropped = (record: string, count: number) => void;

export interface TelemetrySinkOptions {
  send: TelemetrySend;
  capacity?: number;
  batchSize?: number;
  lingerMs?: number;
  onDropped?: TelemetryDropped;
}

interface Entry extends TelemetryMessage {
  record: string;
  topic: string;
}

/** 묶어 보내고, 버퍼가 차면 새 기록을 버리는 버퍼. 요청 처리와 떼어 두려고 파드마다 하나만 만든다 */
export class TelemetrySink {
  readonly #send: TelemetrySend;
  readonly #capacity: number;
  readonly #batchSize: number;
  readonly #lingerMs: number;
  readonly #onDropped: TelemetryDropped;
  #queue: Entry[] = [];
  /** 지금 묶음에서 아직 끝나지 않은 토픽별 조각(맨 앞이 보내는 중이다) */
  #inFlight: Entry[][] = [];
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  /** 닫을 시간이 지나 남은 기록을 이미 버린 것으로 셌다(늦게 끝난 보내기를 다시 세지 않는다) */
  #abandoned = false;

  constructor(o: TelemetrySinkOptions) {
    this.#send = o.send;
    this.#capacity = o.capacity ?? TELEMETRY_BUFFER_CAPACITY;
    this.#batchSize = o.batchSize ?? TELEMETRY_BATCH_SIZE;
    this.#lingerMs = o.lingerMs ?? TELEMETRY_LINGER_MS;
    this.#onDropped = o.onDropped ?? (() => undefined);
  }

  /** 기록 하나를 맡긴다. 기다리지 않고 던지지 않는다. 버퍼가 찼거나 닫혔으면 버리고 센다 */
  offer(record: string, topic: string, message: TelemetryMessage): void {
    if (this.#closed || this.#queue.length >= this.#capacity) {
      this.#onDropped(record, 1);
      return;
    }
    this.#queue.push({ record, topic, ...message });
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#running !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#lingerMs);
    this.#timer.unref();
  }

  /** 버퍼를 비운다. 보내는 중이면 그 일을 기다린다 */
  flush(): Promise<void> {
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#queue.length > 0 && !this.#closed) this.#schedule();
    });
    return this.#running;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0 && !this.#abandoned) {
      // 토픽이 번갈아 와도 한 묶음 안에서 토픽별로 모은다(토픽 안의 차례는 그대로다)
      const byTopic = new Map<string, Entry[]>();
      for (const e of this.#queue.splice(0, this.#batchSize)) {
        const group = byTopic.get(e.topic);
        if (group) group.push(e);
        else byTopic.set(e.topic, [e]);
      }
      this.#inFlight = [...byTopic.values()];
      while (this.#inFlight.length > 0) {
        const group = this.#inFlight[0]!;
        try {
          await this.#send(
            group[0]!.topic,
            group.map((e) => ({ key: e.key, value: e.value })),
          );
        } catch {
          if (!this.#abandoned) this.#drop(group);
        }
        if (this.#abandoned) return;
        this.#inFlight.shift();
      }
    }
  }

  #drop(entries: readonly Entry[]): void {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.record, (counts.get(e.record) ?? 0) + 1);
    for (const [record, n] of counts) this.#onDropped(record, n);
  }

  /** 닫는다. deadlineMs 안에 보내지 못한 기록은 보내는 중인 묶음까지 버리고 센다(종료를 붙들지 않는다) */
  async close(deadlineMs: number): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((res) => {
      timer = setTimeout(res, deadlineMs);
    });
    await Promise.race([this.flush(), timedOut]);
    clearTimeout(timer);
    this.#abandoned = true;
    for (const group of this.#inFlight) this.#drop(group);
    this.#inFlight = [];
    this.#drop(this.#queue.splice(0));
  }
}

/**
 * telemetry_dropped_total{record}를 레지스트리에 붙이고 버린 수를 받는 함수를 돌려준다. 같은 레지스트리에 이미 그 이름이 붙어 있으면(purchase-svc는
 * 결제 시도 지표 묶음이 행동 신호 몫으로 먼저 붙인다) 새로 붙이지 않고 그 묶음에 더한다(두 번 붙이면 던져 시작 파일이 뜨지 못했다, BUILD_ORDER PRF-215)
 */
export function telemetryDroppedCounter(registry: Registry): TelemetryDropped {
  const existing = registry.getSingleMetric('telemetry_dropped_total') as Counter<'record'> | undefined;
  const counter = existing ?? new Counter({ name: 'telemetry_dropped_total', help: '버퍼가 차거나 보내기에 실패해 버린 텔레메트리 기록 수', labelNames: ['record'] as const, registers: [registry] });
  return (record, count) => counter.inc({ record }, count);
}

export interface TelemetryProducer {
  connect(): Promise<unknown>;
  send(r: { topic: string; messages: { key: string | null; value: Buffer }[] }): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface KafkaTelemetrySendOptions {
  connectTimeoutMs?: number;
  sendTimeoutMs?: number;
  retryAfterMs?: number;
  /** 시험이 시각을 바꾼다 */
  now?: () => number;
}

export interface KafkaTelemetrySender extends TelemetrySend {
  /** 지금 생산자를 시간 안에서 끊는다. 실패해도 던지지 않는다 */
  disconnect(deadlineMs: number): Promise<void>;
}

/** 시간 상한을 건다. 넘으면 message로 실패한다(늦게 끝난 일의 결과는 버린다) */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

/** 끊기는 부가 일이다: 어떤 실패도 부른 쪽으로 넘기지 않는다 */
const quietDisconnect = (p: TelemetryProducer): Promise<void> =>
  Promise.resolve()
    .then(() => p.disconnect())
    .then(
      () => undefined,
      () => undefined,
    );

/**
 * 연결이 실패해도 파드를 멈추지 않는 Kafka 보내기. 실제 클라이언트는 연결에 실패한 객체로 다시 연결하지 못하므로 make로 새 생산자를 만든다.
 * 연결과 보내기에 시간 상한을 두고, 실패하면 retryAfterMs 동안 부르지 않고 바로 실패해 버퍼 비우기가 수십 초 멈추지 않게 한다. 실패는 던져 버퍼가 세게 한다
 */
export function kafkaTelemetrySend(make: () => TelemetryProducer, o: KafkaTelemetrySendOptions = {}): KafkaTelemetrySender {
  const connectTimeoutMs = o.connectTimeoutMs ?? TELEMETRY_CONNECT_TIMEOUT_MS;
  const sendTimeoutMs = o.sendTimeoutMs ?? TELEMETRY_SEND_TIMEOUT_MS;
  const retryAfterMs = o.retryAfterMs ?? TELEMETRY_RETRY_AFTER_MS;
  const now = o.now ?? Date.now;
  let current: { producer: TelemetryProducer; ready: Promise<void> } | undefined;
  let blockedUntil = 0;

  const connected = (): { producer: TelemetryProducer; ready: Promise<void> } => {
    if (current) return current;
    const producer = make();
    const entry = {
      producer,
      ready: withTimeout(
        Promise.resolve().then(() => producer.connect()),
        connectTimeoutMs,
        '텔레메트리 브로커 연결 시간 상한을 넘었다',
      ).then(
        () => undefined,
        (err: unknown) => {
          // 이 객체로는 다시 연결하지 못한다: 버리고 다음 시도는 새 객체로 한다
          if (current === entry) current = undefined;
          void quietDisconnect(producer);
          throw err;
        },
      ),
    };
    current = entry;
    return entry;
  };

  const send = async (topic: string, messages: TelemetryMessage[]): Promise<void> => {
    if (now() < blockedUntil) throw new Error('텔레메트리 브로커 다시 시도를 기다리는 중이다');
    try {
      const entry = connected();
      await entry.ready;
      await withTimeout(entry.producer.send({ topic, messages }), sendTimeoutMs, '텔레메트리 보내기 시간 상한을 넘었다');
    } catch (err) {
      blockedUntil = now() + retryAfterMs;
      throw err;
    }
  };

  return Object.assign(send, {
    disconnect: async (deadlineMs: number): Promise<void> => {
      const entry = current;
      current = undefined;
      if (!entry) return;
      await withTimeout(quietDisconnect(entry.producer), deadlineMs, '텔레메트리 생산자 끊기 시간 상한을 넘었다').catch(() => undefined);
    },
  });
}

const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;

export type TelemetryKafkaConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };

/**
 * 텔레메트리 클러스터 설정(PEAKET_TELEMETRY_KAFKA_BROKERS, 쉼표로 나눈 '호스트:포트').
 * 없거나 틀려도 시작을 막지 않는다: 경고 글과 함께 꺼진 설정을 돌려준다(버린 기록은 telemetry_dropped_total로 드러난다). 값이 있는지는 배포 검사가 막는다(ADR-0249).
 * 틀린 조각은 값 대신 몇 번째인지만 알린다
 */
export function telemetryKafkaFromEnv(service: string, env: Record<string, string | undefined>): TelemetryKafkaConfig {
  const off = (reason: string): TelemetryKafkaConfig => ({ enabled: false, warning: `${reason}: 판정 기록·행동 신호를 Kafka로 보내지 않는다` });
  const raw = env.PEAKET_TELEMETRY_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  if (!raw) return off('PEAKET_TELEMETRY_KAFKA_BROKERS가 없다');
  const pieces = raw.split(',').map((s) => s.trim());
  const bad = pieces.findIndex((s) => s !== '' && !BROKER.test(s));
  if (bad >= 0) return off(`PEAKET_TELEMETRY_KAFKA_BROKERS의 ${bad + 1}번째 값이 '호스트:포트'가 아니다`);
  const brokers = pieces.filter(Boolean);
  if (brokers.length === 0) return off('PEAKET_TELEMETRY_KAFKA_BROKERS가 비었다');
  if (!peaketEnv) return off('PEAKET_ENV가 없어 Kafka 인증을 고를 수 없다');
  let auth: KafkaAuth | undefined;
  try {
    auth = kafkaAuthFromEnv(service, env);
  } catch {
    return off('Kafka 인증 설정이 틀렸다');
  }
  return { enabled: true, brokers, auth, env: peaketEnv };
}
