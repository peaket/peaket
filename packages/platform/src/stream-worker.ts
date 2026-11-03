// @peaket/platform/stream-worker: Kafka 클라이언트를 직접 쓰는 공용 모듈(openspec 변경 add-maintenance-control-and-consumers 결정 1·3·4·5·7,
// docs/streaming.md §2.1의 공용 소비 모듈 `@peaket/stream-worker`, ADR-0142). 네이티브 모듈(@confluentinc/kafka-javascript)은
// 이 하위 내보내기만 싣는다. 생산자·소비자는 필수 설정 함수(kafka-config.ts)로만 만든다(D-T45가 다른 길을 막는다).
// - Outbox 보내기 어댑터: 받은 순서대로, 키·값·머리 그대로. 생산 span은 사건마다 쓴 요청의 추적에 링크한다(observability §2)
// - 키 단위 소비자 실행기: KeyedPartition에 넘기고 1초 [가정]마다·재조정·종료 때 '앞 사건이 모두 끝난 위치'를 커밋한다. 처리는 소비 span 안
// - 방송형 읽기: 파드마다 그룹, 커밋 없음, 준 위치부터(ADR-0103 결정 3)
import { createRequire } from 'node:module';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace, type Link } from '@opentelemetry/api';
import type { Registry } from '@prometheus-io/client';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { BroadcastRecord, BroadcastSource } from './control.js';
import { kafkaAdminConfig, kafkaConsumerConfig, kafkaProducerConfig, type KafkaClientBase, type KafkaProducerKind } from './kafka-config.js';
import type { KafkaAuth } from './msk-iam.js';
import { KEYED_CONSUMER_DEFAULTS, KeyedConsumerMetrics, KeyedPartition, PauseGate, errorSummary, type ConsumedMessage, type HeldEventStore, type KeyedHandler } from './keyed-consumer.js';

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
      timers.push(setInterval(() => void measure(), KEYED_CONSUMER_DEFAULTS.measureHeldEveryMs));
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

