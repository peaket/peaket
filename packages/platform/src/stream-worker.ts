// @peaket/platform/stream-worker: Kafka 클라이언트를 직접 쓰는 공용 모듈(openspec 변경 add-maintenance-control-and-consumers 결정 1·3·4·5·7,
// docs/streaming.md §2.1의 공용 소비 모듈 `@peaket/stream-worker`, ADR-0142). 네이티브 모듈(@confluentinc/kafka-javascript)은
// 이 하위 내보내기만 싣는다. 생산자·소비자는 필수 설정 함수(kafka-config.ts)로만 만든다(D-T45가 다른 길을 막는다).
// - Outbox 보내기 어댑터: 받은 순서대로, 키·값·머리 그대로. 생산 span은 사건마다 쓴 요청의 추적에 링크한다(observability §2)
// - 키 단위 소비자 실행기: KeyedPartition에 넘기고 1초 [가정]마다·재조정·종료 때 '앞 사건이 모두 끝난 위치'를 커밋한다. 처리는 소비 span 안
// - 방송형 읽기: 파드마다 그룹, 커밋 없음, 준 위치부터(ADR-0103 결정 3)
// - 서비스의 제어 토픽 소비 도우미 startServiceControlSync: 설정·종료 세션 두 토픽을 방송형으로 읽어 종료 세션 목록을 채운다(ADR-0333 결정 2).
//   신원 처리기가 없는 서비스는 sessions: false로 설정 토픽만 읽는다(ADR-0334 결정 2)
// - 스트림 작업자 묶음 실행기 runBatchWorker와 Avro 읽기(avro-reader·schema-registry-source, ADR-0335): 쓰기 뒤 커밋·파티션별 묶음·다시 시도(OPS-150)
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace, type Link } from '@opentelemetry/api';
import type { Registry } from '@prometheus-io/client';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { PlatformConfigError, controlSyncRequired } from './config.js';
import { startControlSync, type BroadcastRecord, type BroadcastSource, type ControlSync, type ControlSyncOptions } from './control.js';
import { controlEventCodec } from './control-codec.js';
import { kafkaAdminConfig, kafkaConsumerConfig, kafkaProducerConfig, type KafkaClientBase, type KafkaProducerKind } from './kafka-config.js';
import { kafkaAuthFromEnv, type KafkaAuth } from './msk-iam.js';
import type { PlatformService } from './service.js';
import { KEYED_CONSUMER_DEFAULTS, KeyedConsumerMetrics, KeyedPartition, PauseGate, errorSummary, isTransientError, type ConsumedMessage, type HeldEventStore, type KeyedHandler } from './keyed-consumer.js';
import { BATCH_WORKER_DEFAULTS, BatchPartition, BatchWorkerMetrics, retryDelayMs, type BatchRecord, type BatchSink, type ClosedBatch, type RejectedPosition } from './batch-consumer.js';
import type { DecodeOutcome } from './avro-reader.js';

export {
  SchemaUnavailableError,
  UnknownSchemaError,
  UNRECOGNIZED_SYMBOL,
  createAvroReader,
  type AvroReader,
  type AvroReaderOptions,
  type DecodeOutcome,
  type SchemaSource,
} from './avro-reader.js';
export { SCHEMA_REGISTRY_DEFAULTS, schemaRegistrySource, type SchemaRegistrySourceOptions } from './schema-registry-source.js';

/** 받기 처리기 안에서 보류 키 읽기를 기다리는 한도 [가정](max.poll.interval 300초보다 훨씬 짧게) */
const INIT_TIMEOUT_MS = 5_000;
/** 넘기기 때 처리 중인 키를 마치기를 기다리는 한도 [가정](max.poll.interval 300초보다 짧게). 넘으면 그 파티션을 버리고 끝난 위치까지만 커밋한다 */
const REVOKE_DRAIN_MS = 30_000;
/** 기다림 한도(끝나면 false). 타이머가 프로세스 종료를 붙잡지 않게 unref한다 */
const drainLimit = () => new Promise<boolean>((r) => setTimeout(() => r(false), REVOKE_DRAIN_MS).unref());
import type { OutboxPublisher, OutboxRecord } from './outbox-relay.js';

const require = createRequire(import.meta.url);
const { KafkaJS: K } = require('@confluentinc/kafka-javascript') as { KafkaJS: typeof KafkaJS };

export type KafkaProducer = KafkaJS.Producer;
export type KafkaConsumer = KafkaJS.Consumer;
export type KafkaAdmin = KafkaJS.Admin;

/** librdkafka 재조정 콜백의 오류 코드(ERR__ASSIGN_PARTITIONS·ERR__REVOKE_PARTITIONS) */
const ASSIGN = -175;
const REVOKE = -174;

const tracer = trace.getTracer('@peaket/platform/stream-worker');

/** 클라이언트 자체 기록(librdkafka)은 경고부터만 낸다(표준 출력이 정규 로그 줄과 섞이지 않게) */
function quiet<T extends { kafkaJS: object }>(c: T): T {
  return { ...c, kafkaJS: { ...c.kafkaJS, logLevel: K.logLevel.WARN } };
}

export function createKafkaProducer(o: KafkaClientBase & { kind: KafkaProducerKind }): KafkaProducer {
  return new K.Kafka({}).producer(quiet(kafkaProducerConfig(o)) as never);
}

export function createKafkaConsumer(o: KafkaClientBase & { groupId: string }): KafkaConsumer {
  return new K.Kafka({}).consumer(quiet(kafkaConsumerConfig(o)) as never);
}

export function createKafkaAdmin(o: Pick<KafkaClientBase, 'brokers' | 'clientId' | 'auth'> & { warmupTimeoutMs?: number }): KafkaAdmin {
  const admin: KafkaAdmin = new K.Kafka({}).admin(quiet(kafkaAdminConfig(o)) as never);
  if (!o.auth) return admin;
  // OAUTHBEARER 관리 연결은 연결 직후 첫 관리 요청(위치 읽기·토픽 만들기)이 한도와 상관없이 끝나지 않고 시간 초과로 실패했다. 메타데이터
  // 요청(listTopics)을 먼저 하면 그 뒤 요청은 바로 끝난다(@confluentinc/kafka-javascript 1.11.0, 로컬 SASL_SSL 브로커, 2026-11-01
  // openspec 변경 add-foundation-poc). 실패하면 관리 연결을 새로 만드는 방송형 읽기가 영영 시작하지 못하므로 연결에서 데운다
  const connect = admin.connect.bind(admin);
  admin.connect = async () => {
    await connect();
    try {
      // 부르는 쪽 한도보다 짧게 둔다: 끊을 때 진행 중인 요청이 연결 잠금을 쥐어 이벤트 루프가 그만큼 멈춘다(코드 리뷰 2026-11-01)
      await admin.listTopics({ timeout: o.warmupTimeoutMs ?? 5_000 } as never);
    } catch (err) {
      // 관리 클라이언트는 연결 실패에 스스로 끊지 않는다. 닫지 않으면 스레드·소켓·토큰 갱신이 남는다(코드 리뷰 2026-11-01)
      await admin.disconnect().catch(() => {});
      throw err;
    }
  };
  return admin;
}

// ---- 추적(결정 3) ----

const linkOf = (headers: Record<string, string>): Link | undefined => {
  const sc = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, headers));
  return sc && trace.isSpanContextValid(sc) ? { context: sc } : undefined;
};

/** 바로 보내는(Outbox 밖) 메시지의 머리에 지금 추적 문맥을 넣는다 */
export function withTraceHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out = { ...headers };
  propagation.inject(context.active(), out);
  return out;
}

/** 머리의 추적 문맥을 부모로 하는 소비 span 안에서 fn을 부른다 */
export async function withConsumerSpan<R>(m: Pick<ConsumedMessage, 'topic' | 'partition' | 'offset' | 'headers'>, fn: () => Promise<R>): Promise<R> {
  const parent = propagation.extract(ROOT_CONTEXT, m.headers);
  return tracer.startActiveSpan(
    `process ${m.topic}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'kafka',
        'messaging.operation.type': 'process',
        'messaging.destination.name': m.topic,
        'messaging.destination.partition.id': String(m.partition),
        'messaging.kafka.offset': Number(m.offset),
      },
    },
    parent,
    async (span) => {
      try {
        return await fn();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ---- Outbox 보내기 어댑터(결정 4, ADR-0116 결정 3) ----

/**
 * 받은 순서대로 같은 주제끼리 묶어 보내기를 모두 건 뒤 한꺼번에 기다린다(멱등 생산자가 같은 파티션 안 순서를 지킨다).
 * 하나라도 실패하면 던진다(릴레이가 되돌리고 다시 보낸다. 다시 나간 사건은 받는 쪽이 eventKey로 거른다)
 */
export function kafkaOutboxPublisher(producer: KafkaProducer): OutboxPublisher {
  return {
    async publish(records: readonly OutboxRecord[]) {
      if (records.length === 0) return;
      const groups: { topic: string; records: OutboxRecord[] }[] = [];
      for (const r of records) {
        const last = groups[groups.length - 1];
        if (last && last.topic === r.topic) last.records.push(r);
        else groups.push({ topic: r.topic, records: [r] });
      }
      const topics = [...new Set(records.map((r) => r.topic))];
      await tracer.startActiveSpan(
        `send ${topics.length === 1 ? topics[0] : 'outbox'}`,
        {
          kind: SpanKind.PRODUCER,
          links: records.map((r) => linkOf(r.headers)).filter((l): l is Link => l !== undefined),
          attributes: {
            'messaging.system': 'kafka',
            'messaging.operation.type': 'send',
            'messaging.batch.message_count': records.length,
            ...(topics.length === 1 ? { 'messaging.destination.name': topics[0] } : {}),
          },
        },
        async (span) => {
          try {
            await Promise.all(groups.map((g) => producer.send({ topic: g.topic, messages: g.records.map((r) => ({ key: r.key, value: r.payload, headers: r.headers })) })));
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },
  };
}

// ---- 키 단위 소비자 실행기(결정 5·6) ----

const headersOf = (h: Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one !== undefined && one !== null) out[k] = Buffer.isBuffer(one) ? one.toString('utf8') : String(one);
  }
  return out;
};

export interface KeyedConsumerRunOptions<T> extends KafkaClientBase {
  service: string;
  groupId: string;
  topics: string[];
  handler: KeyedHandler<T>;
  held: HeldEventStore;
  registry?: Registry;
  /** 보류 수(consumer_held_events)를 잰다. 보통 heldEventCounts(database) */
  heldCounts?: () => Promise<Map<string, number>>;
  logger?: { warn(o: object, msg?: string): void };
  maxKeys?: number;
  commitEveryMs?: number;
  /** 동시에 받는 파티션 수 [가정] */
  partitionsConcurrently?: number;
  /** 보류 수를 재는 주기(기본 30초 [가정], 시험이 줄인다) */
  measureHeldEveryMs?: number;
  /** 커밋이 없을 때 처음부터(기본) 또는 끝부터 */
  startAt?: 'earliest' | 'latest';
}

export interface KeyedConsumerRun {
  /** 연결되고 구독했다 */
  started: Promise<void>;
  /** 받기를 멈추고 처리 중인 키를 마친 뒤 커밋하고 나간다 */
  stop(): Promise<void>;
}

export function runKeyedConsumer<T>(o: KeyedConsumerRunOptions<T>): KeyedConsumerRun {
  const metrics = o.registry ? KeyedConsumerMetrics.for(o.registry, o.service) : undefined;
  /** 파티션마다: 처리기, 가져오기 멈춤 이유(PauseGate), 늘려 쉬기 타이머와 횟수 */
  interface Slot {
    p: KeyedPartition<T>;
    gate: PauseGate;
    backoff?: NodeJS.Timeout;
    retries: number;
  }
  const slots = new Map<string, Slot>();
  const parts = new Map<string, KeyedPartition<T>>();
  const committed = new Map<string, bigint>();
  const id = (topic: string, partition: number) => `${topic}\u0000${partition}`;
  const stopping = new AbortController();
  let consumer: KafkaConsumer;

  const commitOne = async (topic: string, partition: number): Promise<void> => {
    const p = parts.get(id(topic, partition));
    const at = p?.committable();
    if (at === undefined || committed.get(id(topic, partition)) === at) return;
    await consumer.commitOffsets([{ topic, partition, offset: at.toString() }]);
    committed.set(id(topic, partition), at);
  };
  const commitAll = async () => {
    for (const k of parts.keys()) {
      const [topic, partition] = k.split('\u0000') as [string, string];
      try {
        await commitOne(topic, Number(partition));
      } catch (err) {
        o.logger?.warn({ kind: 'consumer', topic, partition, err: err instanceof Error ? err.message : String(err) }, '커밋 실패(다음에 다시)');
      }
    }
  };
  /** 멈추는 중이거나 끊긴 뒤의 pause·resume은 하지 않는다(ERR__STATE로 던지면 처리 줄이 멈춘다) */
  const guard = (what: string, fn: () => void) => {
    if (stopping.signal.aborted) return;
    try {
      fn();
    } catch (err) {
      o.logger?.warn({ kind: 'consumer', err: err instanceof Error ? err.message : String(err) }, `가져오기 ${what} 실패`);
    }
  };
  const slotOf = (topic: string, partition: number): Slot => {
    const k = id(topic, partition);
    let slot = slots.get(k);
    if (!slot) {
      // 멈춤·다시 시작은 이 문 하나로만 한다(이유가 하나라도 남으면 열지 않고, 열 때 이어 읽을 위치로 맞춘다, 코드 리뷰 2026-11-01)
      const gate: PauseGate = new PauseGate({
        pause: () => guard('pause', () => consumer.pause([{ topic, partitions: [partition] }])),
        resume: (next) =>
          guard('resume', () => {
            consumer.resume([{ topic, partitions: [partition] }]);
            if (next !== undefined) consumer.seek({ topic, partition, offset: next.toString() });
          }),
        next: () => p.nextOffset,
      });
      const p: KeyedPartition<T> = new KeyedPartition<T>({
        topic,
        partition,
        held: o.held,
        maxKeys: o.maxKeys,
        metrics,
        // 처리기는 클래스 인스턴스일 수 있어 펼쳐 복사하지 않고 위임한다(펼치면 메서드가 빠진다, 코드 리뷰 2026-11-01)
        handler: {
          decode: (m) => o.handler.decode(m),
          keyOf: (e, m) => o.handler.keyOf(e, m),
          eventKeyOf: o.handler.eventKeyOf ? (e) => o.handler.eventKeyOf!(e) : undefined,
          handle: (e, m) => withConsumerSpan(m, () => o.handler.handle(e, m)),
        },
        onPause: () => gate.hold('lanes'),
        onResume: () => gate.release('lanes'),
        onError: (err) => o.logger?.warn({ kind: 'consumer', topic, partition, err: errorSummary(err) }, '예상하지 못한 오류(같은 사건을 다시 한다)'),
        onHeld: (h) => o.logger?.warn({ kind: 'consumer-held', topic: h.topic, partition: h.partition, offset: String(h.offset), error: h.error }, '처리 못 한 사건을 보류 표로 옮겼다'),
      });
      slot = { p, gate, retries: 0 };
      slots.set(k, slot);
      parts.set(k, p);
    }
    return slot;
  };
  const dropSlot = (k: string) => {
    const slot = slots.get(k);
    if (slot?.backoff) clearTimeout(slot.backoff);
    slot?.gate.close();
    slots.delete(k);
    parts.delete(k);
    committed.delete(k);
  };
  /**
   * 받기 처리기 안에서 오래 기다리지 않는다: 보류 키 읽기·값 읽기가 일시 실패면 그 파티션을 멈추고 던진다. 클라이언트가 그 사건으로
   * 되돌리고, 늘려 쉰 뒤 다시 시작한다(코드 리뷰 2026-11-01: 오래 막히면 캐시를 비우며 위치를 건너뛸 수 있었다)
   */
  const backOff = (slot: Slot) => {
    const ms = Math.min(KEYED_CONSUMER_DEFAULTS.transientMaxMs, KEYED_CONSUMER_DEFAULTS.transientMinMs * 2 ** slot.retries);
    slot.retries += 1;
    if (slot.backoff) clearTimeout(slot.backoff);
    slot.gate.hold('backoff');
    slot.backoff = setTimeout(() => {
      slot.backoff = undefined;
      slot.gate.release('backoff');
    }, ms);
  };

  consumer = createKafkaConsumer({
    brokers: o.brokers,
    clientId: o.clientId,
    groupId: o.groupId,
    // 인증 묶음을 그대로 넘긴다(코드 리뷰 2026-11-01: 빠져 있어 MSK IAM을 골라도 평문으로 붙었다)
    auth: o.auth,
    extra: {
      ...o.extra,
      'auto.offset.reset': o.startAt ?? 'earliest',
      // 넘기기 전에 처리 중인 키를 마치고 그 위치를 커밋한다(잃은 배정이면 커밋하지 않는다)
      rebalance_cb: async (err: { code: number }, assignment: { topic: string; partition: number }[], fns: { assignmentLost(): boolean }) => {
        if (err.code === ASSIGN) {
          // librdkafka는 파티션을 내놓을 때 앱이 건 멈춤을 지우지 않는다. 멈춘 채 넘긴 파티션이 같은 소비자에게 돌아오면 영영 가져오지
          // 않으므로 받을 때마다 푼다(멈추지 않은 파티션에는 아무 일도 하지 않는다, 코드 리뷰 2026-11-01). 참값을 돌려주지 않는다(배정이 바뀐다)
          guard('resume', () => consumer.resume(assignment.map((tp) => ({ topic: tp.topic, partitions: [tp.partition] }))));
          return;
        }
        if (err.code !== REVOKE) return;
        await Promise.all(
          assignment.map(async (tp) => {
            const k = id(tp.topic, tp.partition);
            const slot = slots.get(k);
            if (!slot) return;
            slot.gate.close();
            // 재조정 콜백 동안은 이 소비자의 어느 파티션도 받지 않으므로 기다림에 한도를 둔다(코드 리뷰 2026-11-01)
            const drained = await Promise.race([slot.p.drain().then(() => true), drainLimit()]);
            if (!drained) {
              slot.p.abandon();
              o.logger?.warn({ kind: 'consumer', topic: tp.topic, partition: tp.partition }, '넘기기 기다림이 한도를 넘어 끝난 위치까지만 커밋한다');
            }
            if (!fns.assignmentLost()) await commitOne(tp.topic, tp.partition).catch(() => {});
            dropSlot(k);
          }),
        );
      },
    },
  });

  const timers: NodeJS.Timeout[] = [];
  const started = (async () => {
    await consumer.connect();
    await consumer.subscribe({ topics: o.topics });
    await consumer.run({
      partitionsConsumedConcurrently: o.partitionsConcurrently ?? 4,
      eachMessage: async ({ topic, partition, message }) => {
        const slot = slotOf(topic, partition);
        const p = slot.p;
        try {
          if (!p.initialized) await withTimeout(p.init(), INIT_TIMEOUT_MS, '보류 키 읽기');
          await p.push({
          topic,
          partition,
          offset: BigInt(message.offset),
          key: message.key ? message.key.toString('utf8') : null,
          value: message.value,
          headers: headersOf(message.headers as Record<string, unknown> | undefined),
          timestamp: Number(message.timestamp),
          });
          slot.retries = 0;
        } catch (err) {
          o.logger?.warn({ kind: 'consumer', topic, partition, err: errorSummary(err) }, '일시 실패로 그 파티션을 멈추고 다시 받는다');
          backOff(slot);
          throw err;
        }
      },
    });
    timers.push(setInterval(() => void commitAll(), o.commitEveryMs ?? KEYED_CONSUMER_DEFAULTS.commitEveryMs));
    if (o.heldCounts && metrics) {
      const measure = async () => {
        try {
          const counts = await o.heldCounts!();
          for (const t of o.topics) metrics.held.set({ service: o.service, topic: t }, counts.get(t) ?? 0);
        } catch {
          // 다음에 다시 잰다
        }
      };
      void measure();
      timers.push(setInterval(() => void measure(), o.measureHeldEveryMs ?? KEYED_CONSUMER_DEFAULTS.measureHeldEveryMs));
    }
  })();

  return {
    started,
    async stop() {
      if (stopping.signal.aborted) return;
      stopping.abort();
      for (const t of timers) clearInterval(t);
      await started.catch(() => {});
      const assigned = consumer.assignment();
      if (assigned.length > 0) consumer.pause(assigned.map((tp) => ({ topic: tp.topic, partitions: [tp.partition] })));
      for (const slot of slots.values()) slot.gate.close();
      // 끝내기도 한도 안에서 기다리고, 넘으면 버린 뒤 끝난 위치까지만 커밋한다(저장소가 멈춘 채 종료할 때 끝없이 매달리지 않게)
      await Promise.all(
        [...parts.values()].map(async (p) => {
          const drained = await Promise.race([p.drain().then(() => true), drainLimit()]);
          if (!drained) p.abandon();
        }),
      );
      await commitAll();
      for (const k of [...slots.keys()]) dropSlot(k);
      await consumer.disconnect();
    },
  };
}

// ---- 스트림 작업자 묶음 실행기(docs/streaming.md §2.4·§2.6·§2.7, OPS-150) ----

/** 배정된 파티션의 소비 밀림을 브로커 높은 물표로 고치는 주기 [가정](docs/streaming.md §2.7). 멈춘 파티션에는 받은 묶음이 오지 않아 이것으로만 는다 */
const LAG_REFRESH_MS = 5_000;

export interface BatchWorkerOptions<T> extends Omit<KafkaClientBase, 'clientId'> {
  /** client.id = `${worker}-${env}-${pod}`(docs/streaming.md §2.6) */
  worker: string;
  env: string;
  pod: string;
  groupId: string;
  topics: string[];
  /** 보통 (m) => reader.decode(m.topic, m.value ?? new Uint8Array()). TransientError(SchemaUnavailableError)를 던지면 그 파티션을 멈추고 다시 시도한다 */
  decode: (m: ConsumedMessage) => Promise<DecodeOutcome>;
  sink: BatchSink<T>;
  maxRecords: number;
  maxWaitMs: number;
  /** 작업자 전체 동시 묶음(기본 BATCH_WORKER_DEFAULTS.maxInFlight) */
  maxInFlight?: number;
  /** 재조정·종료 때 처리 중 묶음을 기다리는 한도(기본 BATCH_WORKER_DEFAULTS.drainTimeoutMs, 시험이 줄인다) */
  drainTimeoutMs?: number;
  registry?: Registry;
  logger?: { warn(o: object, msg?: string): void };
  startAt?: 'earliest' | 'latest';
}

export interface BatchWorkerRun {
  /** 연결되고 구독했다 */
  started: Promise<void>;
  /** 가져오기를 멈추고 처리 중 묶음을 한도 안에서 마쳐 커밋한 뒤 나간다. 열린(닫히지 않은) 묶음은 버린다(커밋하지 않아 다시 받는다) */
  stop(): Promise<void>;
}

/** 위치 로그에 남길 값(원문·값 없음) */
const positionLog = (worker: string, r: RejectedPosition) => ({ kind: 'stream-rejected', worker, topic: r.topic, partition: r.partition, offset: r.offset, kafkaTs: r.kafkaTs, schemaId: r.schemaId, reason: r.reason });

/**
 * 스트림 작업자의 소비 실행기. 파티션마다 BatchPartition으로 묶음을 닫고, 파티션마다 쓰기 하나·작업자 전체 maxInFlight까지 싱크에 쓴다.
 * 쓰기가 성공해야 그 파티션을 '끝 오프셋 + 1'로 커밋한다(자동 커밋은 필수 설정으로 꺼져 있다). 쓰기가 실패하면 같은 묶음을 0.2초부터
 * 두 배씩 30초까지 늘려 쉬며 다시 보내고, 그동안 그 파티션 가져오기를 멈춘다. 처음 보는 스키마 ID를 레지스트리에 닿지 못해 읽지 못하면
 * (TransientError) 그 레코드를 받지 않고 그 파티션을 멈춘 뒤 같은 지연 규칙으로 그 레코드부터 다시 받는다
 */
export function runBatchWorker<T>(o: BatchWorkerOptions<T>): BatchWorkerRun {
  const metrics = o.registry ? BatchWorkerMetrics.for(o.registry, o.worker) : undefined;
  const maxInFlight = o.maxInFlight ?? BATCH_WORKER_DEFAULTS.maxInFlight;
  const drainTimeoutMs = o.drainTimeoutMs ?? BATCH_WORKER_DEFAULTS.drainTimeoutMs;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new RangeError(`maxInFlight는 1 이상의 정수여야 한다: ${maxInFlight}`);
  const clientId = `${o.worker}-${o.env}-${o.pod}`;

  interface Slot {
    topic: string;
    partition: number;
    batch: BatchPartition<T>;
    gate: PauseGate;
    /** 닫힌 묶음. 맨 앞이 쓰는 중이거나 다음에 쓸 것 */
    queue: ClosedBatch<T>[];
    writing: boolean;
    ready: boolean;
    /** 넘기며 버렸다: 다시 보내지 않고 커밋하지 않는다 */
    dropped: boolean;
    /** 넘기는 중(release 시작): 새 레코드를 묶음에 싣지 않고 새 묶음을 닫거나 쓰지 않는다 */
    releasing: boolean;
    abort: AbortController;
    /** 받기로 한 가장 큰 오프셋(다시 배달된 레코드 거르기) */
    maxReceived: bigint | undefined;
    /** 다시 열 때 맞출 위치 */
    nextOffset: bigint | undefined;
    timer?: NodeJS.Timeout;
    decodeTimer?: NodeJS.Timeout;
    decodeRetries: number;
    decodeBlocked: boolean;
    writeRetrying: boolean;
    pausedCounted: boolean;
    toCommit: string | undefined;
    committed: string | undefined;
    idle: (() => void)[];
  }
  const slots = new Map<string, Slot>();
  const ready: Slot[] = [];
  let inflight = 0;
  let globalHeld = false;
  const id = (topic: string, partition: number) => `${topic}\u0000${partition}`;
  const stopping = new AbortController();
  let consumer: KafkaConsumer;

  const guard = (what: string, fn: () => void) => {
    if (stopping.signal.aborted) return;
    try {
      fn();
    } catch (err) {
      o.logger?.warn({ kind: 'stream-worker', worker: o.worker, err: err instanceof Error ? err.message : String(err) }, `가져오기 ${what} 실패`);
    }
  };
  const updatePaused = (slot: Slot) => {
    const paused = !slot.dropped && (slot.decodeBlocked || slot.writeRetrying);
    if (paused === slot.pausedCounted) return;
    slot.pausedCounted = paused;
    if (paused) metrics?.pausedPartitions.inc({ worker: o.worker });
    else metrics?.pausedPartitions.dec({ worker: o.worker });
  };
  const holdGlobal = () => {
    if (globalHeld) return;
    globalHeld = true;
    for (const s of slots.values()) s.gate.hold('global');
  };
  const releaseGlobal = () => {
    if (!globalHeld) return;
    globalHeld = false;
    for (const s of slots.values()) s.gate.release('global');
  };

  const slotOf = (topic: string, partition: number): Slot => {
    const k = id(topic, partition);
    let slot = slots.get(k);
    if (slot) return slot;
    const gate: PauseGate = new PauseGate({
      pause: () => guard('pause', () => consumer.pause([{ topic, partitions: [partition] }])),
      resume: (next) =>
        guard('resume', () => {
          consumer.resume([{ topic, partitions: [partition] }]);
          if (next !== undefined) consumer.seek({ topic, partition, offset: next.toString() });
        }),
      next: () => s.nextOffset,
    });
    const s: Slot = {
      topic,
      partition,
      batch: new BatchPartition<T>({ topic, partition, maxRecords: o.maxRecords, maxWaitMs: o.maxWaitMs }),
      gate,
      queue: [],
      writing: false,
      ready: false,
      dropped: false,
      releasing: false,
      abort: new AbortController(),
      maxReceived: undefined,
      nextOffset: undefined,
      decodeRetries: 0,
      decodeBlocked: false,
      writeRetrying: false,
      pausedCounted: false,
      toCommit: undefined,
      committed: undefined,
      idle: [],
    };
    slots.set(k, s);
    if (globalHeld) gate.hold('global');
    return s;
  };

  const commitSlot = async (slot: Slot) => {
    const at = slot.toCommit;
    if (at === undefined || at === slot.committed) return;
    try {
      await consumer.commitOffsets([{ topic: slot.topic, partition: slot.partition, offset: at }]);
      slot.committed = at;
    } catch (err) {
      o.logger?.warn({ kind: 'stream-worker', worker: o.worker, topic: slot.topic, partition: slot.partition, err: errorSummary(err) }, '커밋 실패(다음 커밋·넘기기·종료 때 다시)');
    }
  };

  const sleepUnlessDropped = (slot: Slot, ms: number) =>
    new Promise<void>((resolve) => {
      if (slot.abort.signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      slot.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });

  const writeOne = async (slot: Slot, b: ClosedBatch<T>) => {
    for (let attempt = 0; ; attempt += 1) {
      if (slot.dropped) return;
      const end = metrics?.insertSeconds.startTimer({ worker: o.worker, table: o.sink.table });
      try {
        await o.sink.write(b);
        end?.();
        break;
      } catch (err) {
        end?.();
        if (slot.dropped) return;
        metrics?.insertRetries.inc({ worker: o.worker });
        o.logger?.warn(
          { kind: 'stream-insert', worker: o.worker, topic: b.topic, partition: b.partition, firstOffset: b.firstOffset, lastOffset: b.lastOffset, attempt, err: errorSummary(err) },
          '묶음 쓰기 실패(같은 묶음을 다시 보낸다)',
        );
        if (!slot.writeRetrying) {
          slot.writeRetrying = true;
          updatePaused(slot);
          slot.gate.hold('retry');
        }
        await sleepUnlessDropped(slot, retryDelayMs(attempt));
      }
    }
    if (slot.writeRetrying) {
      slot.writeRetrying = false;
      updatePaused(slot);
      slot.gate.release('retry');
    }
    // 쓰기 뒤 넘기기 한도를 넘겨 버린 파티션은 커밋하지 않는다(새 주인이 다시 받는다)
    if (slot.dropped) return;
    for (const r of b.rejected) {
      metrics?.rejected.inc({ worker: o.worker, topic: r.topic, reason: r.reason });
      o.logger?.warn(positionLog(o.worker, r), '읽지 못한 레코드(위치만 남긴다)');
    }
    slot.toCommit = BatchPartition.commitOffset(b);
    await commitSlot(slot);
  };

  const pump = () => {
    while (inflight < maxInFlight && ready.length > 0) {
      const slot = ready.shift()!;
      slot.ready = false;
      if (slot.dropped || slot.writing || slot.queue.length === 0) continue;
      slot.writing = true;
      inflight += 1;
      const b = slot.queue[0]!;
      void writeOne(slot, b)
        .catch((err) => o.logger?.warn({ kind: 'stream-worker', worker: o.worker, err: errorSummary(err) }, '예상하지 못한 쓰기 오류'))
        .finally(() => {
          slot.writing = false;
          inflight -= 1;
          if (slot.queue[0] === b) slot.queue.shift();
          if (slot.queue.length < 2) slot.gate.release('queued');
          if (slot.queue.length > 0 && !slot.dropped && !slot.ready) {
            slot.ready = true;
            ready.push(slot);
          }
          if (slot.queue.length === 0 || slot.dropped) for (const w of slot.idle.splice(0)) w();
          if (inflight < maxInFlight) releaseGlobal();
          pump();
        });
    }
    if (inflight >= maxInFlight) holdGlobal();
  };

  const enqueue = (slot: Slot, b: ClosedBatch<T>) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    // 넘기는 중에 닫힌 묶음은 버린 열린 묶음 뒤의 레코드라 쓰거나 커밋하지 않는다(RV220-2)
    if (slot.releasing || slot.dropped) return;
    slot.queue.push(b);
    // 쓰는 중인 묶음 뒤에 또 닫힌 묶음이 기다리면 그 파티션 가져오기를 멈춘다(파티션마다 쓰기 하나, 메모리가 끝없이 늘지 않게)
    if (slot.queue.length >= 2) slot.gate.hold('queued');
    if (!slot.writing && !slot.ready) {
      slot.ready = true;
      ready.push(slot);
    }
    pump();
  };

  const armTimer = (slot: Slot) => {
    if (slot.timer || slot.releasing || slot.dropped) return;
    const ms = slot.batch.msUntilDue();
    if (ms === undefined) return;
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      if (slot.releasing || slot.dropped) return;
      const b = slot.batch.poll();
      if (b) enqueue(slot, b);
      else armTimer(slot);
    }, ms);
    slot.timer.unref();
  };

  const blockDecode = (slot: Slot, offset: bigint) => {
    slot.nextOffset = offset;
    if (slot.decodeBlocked) return;
    slot.decodeBlocked = true;
    updatePaused(slot);
    slot.gate.hold('decode');
    const ms = retryDelayMs(slot.decodeRetries);
    slot.decodeRetries += 1;
    slot.decodeTimer = setTimeout(() => {
      slot.decodeTimer = undefined;
      slot.decodeBlocked = false;
      updatePaused(slot);
      slot.gate.release('decode');
    }, ms);
    slot.decodeTimer.unref();
  };

  /** 쓰는 중·기다리는 닫힌 묶음이 끝날 때까지(한도 안에서) 기다린다. 끝나면 true */
  const drainSlot = async (slot: Slot): Promise<boolean> => {
    const idle = () => !slot.writing && slot.queue.length === 0;
    if (idle()) return true;
    let t: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      new Promise<boolean>((resolve) => {
        const check = () => (idle() ? resolve(true) : slot.idle.push(check));
        slot.idle.push(check);
      }),
      new Promise<boolean>((resolve) => {
        t = setTimeout(() => resolve(false), drainTimeoutMs);
        t.unref();
      }),
    ]);
    clearTimeout(t);
    return done;
  };

  /** 파티션을 내놓는다: 열린 묶음은 버리고, 닫힌 묶음은 한도 안에서 마쳐 커밋한다. 한도를 넘기면 마치지 못한 묶음은 커밋하지 않는다 */
  const release = async (slot: Slot, commit: boolean) => {
    slot.releasing = true;
    slot.gate.close();
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    if (slot.decodeTimer) clearTimeout(slot.decodeTimer);
    slot.decodeTimer = undefined;
    slot.batch.discard();
    // 넘긴 파티션의 밀림은 새 주인이 낸다(옛 주인이 마지막 값을 계속 내지 않게, RV220-4)
    metrics?.consumerLag.remove({ worker: o.worker, topic: slot.topic, partition: String(slot.partition) });
    const drained = await drainSlot(slot);
    if (!drained) o.logger?.warn({ kind: 'stream-worker', worker: o.worker, topic: slot.topic, partition: slot.partition }, '처리 중 묶음 기다림이 한도를 넘어 그 묶음을 커밋하지 않고 넘긴다');
    slot.dropped = true;
    slot.abort.abort();
    updatePaused(slot);
    slot.queue.length = 0;
    if (commit) await commitSlot(slot);
    slots.delete(id(slot.topic, slot.partition));
  };

  const setLag = (slot: Slot, highWatermark: string) => {
    if (!metrics || slot.nextOffset === undefined || !/^\d+$/.test(highWatermark)) return;
    const lag = BigInt(highWatermark) - slot.nextOffset;
    metrics.consumerLag.set({ worker: o.worker, topic: slot.topic, partition: String(slot.partition) }, Number(lag > 0n ? lag : 0n));
  };

  // 멈춘 파티션(쓰기 다시 시도·레지스트리 장애)에는 받은 묶음이 오지 않으므로, 맡은 파티션마다 브로커 높은 물표를 주기마다 물어 밀림을 고친다
  // (docs/streaming.md §2.6 '그동안 소비 밀림이 는다', §2.7 주기, RV220-1). 관리 연결은 같은 client.id·인증으로 처음 쓸 때 하나 만든다
  let lagAdmin: KafkaAdmin | undefined;
  let lagFailing = false;
  let lagRun: Promise<void> | undefined;
  const lagTimeoutMs = Math.min(LAG_REFRESH_MS, 5_000);
  const refreshLag = async () => {
    const topics = new Set([...slots.values()].map((s) => s.topic));
    if (!metrics || topics.size === 0 || stopping.signal.aborted) return;
    try {
      if (!lagAdmin) {
        const a = createKafkaAdmin({ brokers: o.brokers, clientId, auth: o.auth, warmupTimeoutMs: Math.max(200, lagTimeoutMs - 200) });
        try {
          await withTimeout(a.connect(), lagTimeoutMs, 'Kafka 관리 연결');
        } catch (err) {
          await a.disconnect().catch(() => {});
          throw err;
        }
        lagAdmin = a;
      }
      const admin = lagAdmin;
      for (const topic of topics) {
        const rows = await withTimeout(admin.fetchTopicOffsets(topic, { timeout: lagTimeoutMs } as never), lagTimeoutMs + 1_000, '높은 물표 조회');
        for (const r of rows) {
          const slot = slots.get(id(topic, r.partition));
          // 묻는 동안 넘긴 파티션은 고치지 않는다(지운 값을 되살리지 않게)
          if (slot && !slot.releasing && !slot.dropped && !stopping.signal.aborted) setLag(slot, r.high);
        }
      }
      lagFailing = false;
    } catch (err) {
      const a = lagAdmin;
      lagAdmin = undefined;
      await a?.disconnect().catch(() => {});
      // 이어지는 실패는 처음 한 번만 남긴다(다음 주기에 다시 묻는다)
      if (!lagFailing) o.logger?.warn({ kind: 'stream-worker', worker: o.worker, err: errorSummary(err) }, '소비 밀림을 고치려 높은 물표를 묻지 못했다(다음 주기에 다시)');
      lagFailing = true;
    }
  };
  const lagTimer = setInterval(() => {
    lagRun ??= refreshLag().finally(() => (lagRun = undefined));
  }, LAG_REFRESH_MS);
  lagTimer.unref();

  consumer = createKafkaConsumer({
    brokers: o.brokers,
    clientId,
    groupId: o.groupId,
    auth: o.auth,
    extra: {
      ...o.extra,
      'auto.offset.reset': o.startAt ?? 'earliest',
      rebalance_cb: async (err: { code: number }, assignment: { topic: string; partition: number }[], fns: { assignmentLost(): boolean }) => {
        if (err.code === ASSIGN) {
          // 앱이 건 멈춤은 파티션을 내놓아도 남는다. 받을 때마다 푼다(runKeyedConsumer와 같은 까닭)
          guard('resume', () => consumer.resume(assignment.map((tp) => ({ topic: tp.topic, partitions: [tp.partition] }))));
          return;
        }
        if (err.code !== REVOKE) return;
        const lost = fns.assignmentLost();
        await Promise.all(
          assignment.map(async (tp) => {
            const slot = slots.get(id(tp.topic, tp.partition));
            if (slot) await release(slot, !lost);
          }),
        );
      },
    },
  });

  const started = (async () => {
    await consumer.connect();
    await consumer.subscribe({ topics: o.topics });
    await consumer.run({
      // 받은 레코드만 직접 표시한다. 표시하지 않은 나머지는 클라이언트가 그 위치로 되돌린다(받지 않은 레코드를 건너뛰지 않게)
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, isStale }) => {
        const { topic, partition } = batch;
        // 넘긴 뒤 늦게 온 묶음으로 내놓은 파티션의 자리를 다시 만들지 않는다
        if (isStale() || stopping.signal.aborted) return;
        const slot = slotOf(topic, partition);
        const gone = () => isStale() || slot.releasing || slot.dropped || stopping.signal.aborted;
        for (const message of batch.messages) {
          if (gone()) return;
          const offset = BigInt(message.offset);
          if (slot.maxReceived !== undefined && offset <= slot.maxReceived) {
            resolveOffset(message.offset);
            continue;
          }
          // 레지스트리를 기다리며 멈춘 동안 온 것은 받지 않는다(다시 열 때 막힌 레코드부터 다시 온다)
          if (slot.decodeBlocked) return;
          const m: ConsumedMessage = {
            topic,
            partition,
            offset,
            key: message.key ? message.key.toString('utf8') : null,
            value: message.value,
            headers: headersOf(message.headers as Record<string, unknown> | undefined),
            timestamp: Number(message.timestamp),
          };
          let out: DecodeOutcome | undefined;
          let failure: { err: unknown } | undefined;
          try {
            out = await o.decode(m);
          } catch (err) {
            failure = { err };
          }
          // 읽는 동안 넘기거나 멈췄으면 그 레코드를 받지 않는다(버린 열린 묶음 뒤에 싣거나 커밋하지 않아 다시 받는다, RV220-2)
          if (gone()) return;
          if (failure) {
            if (isTransientError(failure.err)) {
              o.logger?.warn({ kind: 'stream-worker', worker: o.worker, topic, partition, offset: message.offset, err: errorSummary(failure.err) }, '스키마를 읽지 못해 그 파티션을 멈추고 다시 받는다');
              blockDecode(slot, offset);
              return;
            }
            // 일시 실패가 아닌 읽기 예외는 그 레코드 탓으로 본다(위치만 남긴다)
            out = { kind: 'rejected', schemaId: null, reason: 'DESERIALIZE' };
          }
          if (!out) return;
          slot.decodeRetries = 0;
          const kafkaTs = message.timestamp || '0';
          let item: BatchRecord<T> | RejectedPosition;
          if (out.kind === 'record') {
            item = { topic, partition, offset: message.offset, timestamp: kafkaTs, value: out.value as T };
            for (const u of out.unrecognized) metrics?.unrecognizedSymbols.inc({ worker: o.worker, topic, record: out.recordName, field: u.field });
          } else {
            item = { topic, partition, offset: message.offset, kafkaTs, schemaId: out.schemaId, reason: out.reason };
          }
          slot.maxReceived = offset;
          slot.nextOffset = offset + 1n;
          resolveOffset(message.offset);
          const closed = slot.batch.push(item);
          if (closed) enqueue(slot, closed);
          else armTimer(slot);
        }
        // 소비 밀림 = 높은 물표 − 다음에 읽을 오프셋(받은 묶음마다 고치고, 멈춘 파티션은 refreshLag가 주기마다 고친다)
        if (!gone()) setLag(slot, batch.highWatermark);
      },
    });
  })();

  return {
    started,
    async stop() {
      if (stopping.signal.aborted) return;
      await started.catch(() => {});
      const assigned = consumer.assignment();
      if (assigned.length > 0) consumer.pause(assigned.map((tp) => ({ topic: tp.topic, partitions: [tp.partition] })));
      stopping.abort();
      clearInterval(lagTimer);
      await Promise.all([...slots.values()].map((s) => release(s, true)));
      await lagRun;
      await lagAdmin?.disconnect().catch(() => {});
      lagAdmin = undefined;
      await consumer.disconnect();
    },
  };
}

// ---- 방송형 읽기(결정 7, ADR-0103 결정 3) ----

export interface KafkaBroadcastOptions {
  brokers: string[];
  service: string;
  /** 파드 이름(PEAKET_POD). 소비자 그룹 `<서비스>-<파드>.<토픽>`(파드마다 따로, 커밋하지 않는다) */
  pod: string;
  env?: string;
  /** 관리 API 시간 한도 [가정] */
  adminTimeoutMs?: number;
  /** 운영은 MSK IAM(kafkaAuthFromEnv). 관리 연결과 소비자 모두에 싣는다 */
  auth?: KafkaAuth;
}

export function kafkaBroadcastSource(o: KafkaBroadcastOptions): BroadcastSource & { close(): Promise<void> } {
  const clientId = `${o.service}-${o.env ?? 'local'}-${o.pod}`;
  const timeout = o.adminTimeoutMs ?? 5_000;
  let admin: KafkaAdmin | undefined;
  let pending: Promise<KafkaAdmin> | undefined;
  // 연결은 하나만 만들고 동시에 부른 쪽이 함께 기다린다. 시간 초과·실패면 만든 연결을 닫는다(데우기가 네트워크 왕복이라 실패할 수 있다,
  // 코드 리뷰 2026-11-01: 닫지 않으면 다시 시도할 때마다 클라이언트가 샜다)
  const connected = (): Promise<KafkaAdmin> => {
    if (admin) return Promise.resolve(admin);
    pending ??= (async () => {
      const a = createKafkaAdmin({ brokers: o.brokers, clientId, auth: o.auth, warmupTimeoutMs: Math.max(200, timeout - 200) });
      try {
        await withTimeout(a.connect(), timeout, 'Kafka 관리 연결');
      } catch (err) {
        await a.disconnect().catch(() => {});
        throw err;
      }
      admin = a;
      return a;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const reset = async () => {
    const a = admin;
    admin = undefined;
    await a?.disconnect().catch(() => {});
  };
  const call = async <R>(fn: (a: KafkaAdmin) => Promise<R>): Promise<R> => {
    try {
      return await fn(await connected());
    } catch (err) {
      await reset();
      throw err;
    }
  };
  return {
    async watermarks(topic) {
      const rows = await call((a) => a.fetchTopicOffsets(topic, { timeout } as never));
      return new Map(rows.map((r) => [r.partition, { low: BigInt(r.low), high: BigInt(r.high) }]));
    },
    async offsetsAt(topic, timestampMs) {
      const [at, marks] = await call(async (a) => [await a.fetchTopicOffsetsByTimestamp(topic, timestampMs, { timeout } as never), await a.fetchTopicOffsets(topic, { timeout } as never)] as const);
      const high = new Map(marks.map((r) => [r.partition, BigInt(r.high)]));
      // 그 시각 뒤 레코드가 없으면 -1이 온다: 끝부터 읽는다
      return new Map(at.map((r) => [r.partition, BigInt(r.offset) < 0n ? (high.get(r.partition) ?? 0n) : BigInt(r.offset)]));
    },
    async read(topic, from, onRecord, signal) {
      if (signal.aborted) return;
      const consumer = createKafkaConsumer({
        brokers: o.brokers,
        clientId,
        auth: o.auth,
        groupId: `${o.service}-${o.pod}.${topic}`,
        extra: {
          'auto.offset.reset': 'earliest',
          // 배정받은 파티션을 준 위치부터 읽는다(커밋한 위치를 쓰지 않는다)
          rebalance_cb: (err: { code: number }, assignment: { topic: string; partition: number }[]) =>
            err.code === ASSIGN ? assignment.map((tp) => ({ ...tp, offset: Number(from.get(tp.partition) ?? 0n) })) : undefined,
        },
      });
      await consumer.connect();
      try {
        await consumer.subscribe({ topics: [topic] });
        await consumer.run({
          eachMessage: async ({ partition, message }) => {
            const r: BroadcastRecord = {
              topic,
              partition,
              offset: BigInt(message.offset),
              key: message.key ? message.key.toString('utf8') : null,
              value: message.value,
              headers: headersOf(message.headers as Record<string, unknown> | undefined),
              timestamp: Number(message.timestamp),
            };
            await onRecord(r);
          },
        });
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        await consumer.disconnect().catch(() => {});
      }
    },
    // 연결 중이면 끝나기를 기다린 뒤 닫는다(닫은 뒤에 연결이 채워져 남지 않게)
    async close() {
      await pending?.catch(() => {});
      await reset();
    },
  };
}

// ---- 서비스의 제어 토픽 소비(ADR-0333 결정 2·3) ----

/** 브로커 주소 모양(loadOutboxRelayProcessConfig·서비스 소비자 설정과 같은 규칙) */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;
/** 파드 이름의 상한(소비자 그룹 `<서비스>-<파드>.<토픽>`와 클라이언트 ID에 들어간다) */
const POD_NAME_MAX = 64;

export type ControlSyncConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth?: KafkaAuth; env: string; pod: string };

/**
 * 제어 토픽 소비 설정을 환경 값에서 읽는다(서비스 소비자 설정 kafkaConsumersFromEnv와 같은 규칙).
 * PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐이면 local·ci만 꺼진 설정이고 그 밖의 환경(값 없음 포함)은 던진다(시작 실패).
 * 있으면 쉼표로 나눈 '호스트:포트'여야 하고, 틀린 조각은 값 대신 몇 번째인지만 알린다(주소에 사용자 이름 등이 섞여 들 수 있다).
 * 파드 이름은 PEAKET_POD → HOSTNAME → 호스트 이름이고 64자까지 쓴다. sessions: false(설정 토픽만 읽는 서비스)는 알림 글만 다르다
 * @throws PlatformConfigError 위의 시작 실패, PEAKET_ENV 없음. kafkaAuthFromEnv의 오류(운영 쪽 환경에 PEAKET_KAFKA_AUTH 없음 등)
 */
export function controlSyncConfigFromEnv(service: string, env: Record<string, string | undefined>, o: { sessions?: boolean } = {}): ControlSyncConfig {
  const raw = env.PEAKET_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  const settingsOnly = o.sessions === false;
  if (!raw) {
    // 브로커 주소 없이 떠도 되는 환경인지는 controlSyncRequired 하나로 판정한다(서비스 시작 파일이 모듈 싣기 실패를 넘길지 고를 때도 쓴다)
    if (!controlSyncRequired(env)) {
      const warning = settingsOnly
        ? `PEAKET_KAFKA_BROKERS가 없어 제어 설정 토픽 소비를 켜지 않았다: 로그 레벨·로그 표본 설정을 이 서비스가 받지 않는다(PEAKET_ENV=${peaketEnv}에서만 허락한다)`
        : `PEAKET_KAFKA_BROKERS가 없어 제어 토픽(설정·종료 세션) 소비를 켜지 않았다: 끝난 세션의 토큰을 이 서비스가 막지 않는다(PEAKET_ENV=${peaketEnv}에서만 허락한다)`;
      return { enabled: false, warning };
    }
    // 조용히 소비 없이 뜨지 않는다: 끝난 세션의 액세스 토큰이 수명(15분)까지 통한다(설정만 읽는 서비스는 온세일 로그 표본·로그 레벨 설정을 놓친다)
    throw new PlatformConfigError(
      settingsOnly
        ? `PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=${peaketEnv || '(없음)'}에서는 제어 설정 토픽 소비가 있어야 한다. local·ci만 없이 뜬다)`
        : `PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=${peaketEnv || '(없음)'}에서는 종료 세션 목록을 채울 제어 토픽 소비가 있어야 한다. local·ci만 없이 뜬다)`,
    );
  }
  const pieces = raw.split(',').map((s) => s.trim());
  const brokers = pieces.filter(Boolean);
  const bad = pieces.findIndex((s) => s !== '' && !BROKER.test(s));
  if (bad >= 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: ${bad + 1}번째 조각이 그 모양이 아니다`);
  if (brokers.length === 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: 빈 조각뿐이다`);
  if (!peaketEnv) throw new PlatformConfigError('PEAKET_ENV가 없어 제어 토픽 소비자의 클라이언트 이름과 인증을 고를 수 없다');
  const auth = kafkaAuthFromEnv(service, env);
  const pod = (env.PEAKET_POD || env.HOSTNAME || hostname()).slice(0, POD_NAME_MAX);
  return { enabled: true, brokers, ...(auth ? { auth } : {}), env: peaketEnv, pod };
}

export interface ServiceControlSync {
  sync: ControlSync;
  /** 시작 작업을 멈추고 읽기 연결을 닫는다. 서비스를 닫은 뒤에 부른다. 두 번 불러도 한 번만 한다 */
  close(): Promise<void>;
}

/**
 * 시간 값(degradeAfterMs 등)은 시험이 시간을 줄일 때만 쓴다(서비스 시작 파일은 넘기지 않는다).
 * sessions: false는 게이트웨이 신원 머리를 받는 처리기가 없는 서비스(trust-svc·realtime-gw·admission-ctrl)의 시작 파일이 넘긴다(ADR-0334 결정 2)
 */
export type ServiceControlSyncOptions = Pick<ControlSyncOptions, 'degradeAfterMs' | 'retryMs' | 'measureMs' | 'reconcileMs' | 'sessions'>;

/**
 * 서비스의 시작 파일이 createService 뒤, listen 전에 부른다(ADR-0333 결정 2). control.settings와
 * control.sessions-terminated를 파드마다 방송형으로 읽어(kafkaBroadcastSource) 종료 세션을 service.auth에 넣고, 두 토픽을 다 읽어야
 * /ready가 200이다(startControlSync). 꺼진 설정(local·ci, 브로커 없음)이면 경고 한 줄을 남기고 undefined를 돌려준다.
 * sessions: false면 control.settings만 읽고(로그 레벨·로그 표본), 종료 세션 소비를 켰다는 표시(service.controlSync.started)는 세우지 않는다
 * (신원 처리기를 더하면 listen의 빠뜨림 막기가 그대로 걸린다, ADR-0333 결정 3·ADR-0334 결정 2)
 * @throws PlatformConfigError controlSyncConfigFromEnv의 시작 실패
 */
export function startServiceControlSync(service: PlatformService, env: Record<string, string | undefined>, o: ServiceControlSyncOptions = {}): ServiceControlSync | undefined {
  const sessions = o.sessions !== false;
  const cfg = controlSyncConfigFromEnv(service.name, env, { sessions });
  if (!cfg.enabled) {
    service.logger.warn({ dep: 'kafka', kind: 'control-sync' }, cfg.warning);
    return undefined;
  }
  const source = kafkaBroadcastSource({ brokers: cfg.brokers, service: service.name, pod: cfg.pod, env: cfg.env, ...(cfg.auth ? { auth: cfg.auth } : {}) });
  const timing: ServiceControlSyncOptions = {};
  for (const k of ['degradeAfterMs', 'retryMs', 'measureMs', 'reconcileMs'] as const) if (o[k] !== undefined) timing[k] = o[k];
  const sync = startControlSync(service, { source, codec: controlEventCodec, ...timing, sessions });
  if (sessions) service.controlSync.started = true;
  let closing: Promise<void> | undefined;
  return {
    sync,
    close() {
      closing ??= sync.stop().finally(() => source.close());
      return closing;
    },
  };
}

async function withTimeout<R>(p: Promise<R>, ms: number, what: string): Promise<R> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_r, reject) => {
        t = setTimeout(() => reject(Object.assign(new Error(`${what}이 ${ms}ms 안에 끝나지 않았다`), { name: 'TimeoutError' })), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

