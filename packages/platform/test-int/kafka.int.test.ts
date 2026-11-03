// 실제 Kafka(컨테이너 한 대)와 PostgreSQL로 공용 Kafka 모듈을 본다(openspec 변경 add-maintenance-control-and-consumers 결정 3·4·5·7,
// ADR-0116 결정 3, ADR-0103 결정 2·3, ADR-0142, V-T28 ②). OTel SDK는 맨 위에서 띄워 쓴 요청 → 소비 span의 추적 잇기를 본다.
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { startTelemetry } from '../src/telemetry.js';

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ serviceName: 'kafka-it', version: 't', env: 'ci', spanProcessors: [new SimpleSpanProcessor({ exporter })] });

import { readFileSync } from 'node:fs';
import { trace } from '@opentelemetry/api';
import { Registry } from '@prometheus-io/client';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  CONTROL_TOPICS,
  OutboxRelay,
  OutboxRelayMetrics,
  createDatabase,
  drizzleHeldEventStore,
  ensureOutboxPartitions,
  heldEventCounts,
  startControlSync,
  systemClock,
  writeOutbox,
  type ConsumedMessage,
  type Database,
  type KeyedHandler,
} from '../src/index.js';
import { createKafkaAdmin, createKafkaProducer, kafkaBroadcastSource, kafkaOutboxPublisher, runKeyedConsumer, type KafkaProducer } from '../src/stream-worker.js';
import { jsonControlCodec } from '../src/testing.js';
import { sample, start } from '../test/fixture.js';
import { startKafka, type KafkaContainer } from './containers.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let kafka: KafkaContainer;
let pgc: PostgresContainer;
let database: Database;
let producer: KafkaProducer;

const migration = (f: string) => readFileSync(new URL(`../template/migrations/${f}`, import.meta.url), 'utf8');
const until = async (cond: () => boolean | Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('기다린 조건이 오지 않았다');
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  [kafka, pgc] = await Promise.all([startKafka(), startPostgres()]);
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  for (const f of ['0002_outbox.sql', '0003_held_event_and_stat_snapshot.sql']) await admin.query(migration(f));
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'kafka-it' });
  await ensureOutboxPartitions(database, systemClock);
  for (const [t, n] of [
    ['example.notes', 3],
    ['trade.payments', 1],
    [CONTROL_TOPICS.settings, 2],
    [CONTROL_TOPICS.sessionsTerminated, 2],
  ] as const)
    await kafka.createTopic(t, n);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-producer', kind: 'outbox-relay' });
  await producer.connect();
}, 180_000);

afterAll(async () => {
  await producer?.disconnect().catch(() => {});
  await database?.close();
  kafka?.stop();
  pgc?.stop();
  await telemetry.shutdown();
});

interface Note {
  n: number;
}

test('ADR0116_결정3_V_T28_②_Outbox사건은키값머리그대로나가고_브로커를멈추면행이남았다가_되살리면빠짐없이나간다 [ASVS v5.0.0-16.5.2]', async () => {
  const registry = new Registry();
  const metrics = new OutboxRelayMetrics(registry, 'kafka-it');
  const relay = new OutboxRelay({ database, publisher: kafkaOutboxPublisher(producer), leader: { isLeader: () => true }, clock: systemClock, metrics });
  const write = async (keys: string[]) => {
    let traceId = '';
    await trace.getTracer('it').startActiveSpan('POST /v1/example/notes', async (span) => {
      traceId = span.spanContext().traceId;
      await database.transaction((tx) => writeOutbox(tx, systemClock, keys.map((k, i) => ({ topic: 'example.notes', key: k, payload: Buffer.from(JSON.stringify({ n: i })), headers: { 'x-peaket-kind': 'note' } }))));
      span.end();
    });
    return traceId;
  };
  const got: { key: string; value: string; headers: Record<string, string>; traceId: string }[] = [];
  const consumer = runKeyedConsumer<Note>({
    brokers: kafka.brokers,
    clientId: 'it-notes',
    service: 'kafka-it',
    groupId: 'it-notes',
    topics: ['example.notes'],
    held: drizzleHeldEventStore(database, systemClock),
    handler: {
      decode: (m) => JSON.parse(m.value!.toString('utf8')) as Note,
      keyOf: (_e, m) => m.key ?? '',
      handle: async (_e, m) => {
        got.push({ key: m.key ?? '', value: m.value!.toString('utf8'), headers: m.headers, traceId: trace.getActiveSpan()?.spanContext().traceId ?? '' });
      },
    },
  });
  await consumer.started;
  try {
    const writer = await write(['note-1', 'note-2', 'note-3']);
    expect(await relay.relayOnce()).toBe(3);
    await until(() => got.length >= 3);
    const one = got.find((g) => g.key === 'note-2')!;
    expect(one.value).toBe('{"n":1}');
    expect(one.headers['x-peaket-kind']).toBe('note');
    expect(one.headers.traceparent).toContain(writer);
    // 소비 span이 쓴 요청의 trace를 잇는다. 생산 span은 그 요청에 링크한다
    expect(one.traceId).toBe(writer);
    const send = exporter.getFinishedSpans().find((s) => s.name === 'send example.notes')!;
    expect(send.links.map((l) => l.context.traceId)).toContain(writer);

    // 브로커 정지: 행은 남고 릴레이는 늘려 쉬며 다시 한다
    kafka.pause();
    await write(['note-4', 'note-5', 'note-6']);
    relay.start();
    await new Promise((r) => setTimeout(r, 12_000));
    const unsent = async () => ((await database.db.execute(sql`select count(*)::int as n from outbox where sent_at is null`)).rows[0] as { n: number }).n;
    expect(await unsent()).toBe(3);
    expect(sample(await registry.metrics(), 'outbox_relay_errors_total', { service: 'kafka-it' }) ?? 0).toBeGreaterThan(0);
    await kafka.resume();
    await until(async () => (await unsent()) === 0, 90_000);
    await until(() => ['note-4', 'note-5', 'note-6'].every((k) => got.some((g) => g.key === k)), 60_000);
  } finally {
    await relay.stop();
    await consumer.stop();
  }
}, 240_000);

interface Pay {
  order: string;
  seq: number;
  eventKey: string;
}

/** 서비스가 흔히 쓰는 꼴: 처리기를 클래스로 넘긴다(펼쳐 복사하면 메서드가 빠졌다, 코드 리뷰 2026-11-01) */
class PayHandler implements KeyedHandler<Pay> {
  constructor(private readonly seen: Map<string, number[]>) {}
  decode(m: ConsumedMessage): Pay {
    return JSON.parse(m.value!.toString('utf8')) as Pay;
  }
  keyOf(e: Pay): string {
    return e.order;
  }
  eventKeyOf(e: Pay): string {
    return e.eventKey;
  }
  async handle(e: Pay): Promise<void> {
    if (e.order === 'P') throw new Error('상태 전이 불가');
    if (e.order === 'B') await new Promise((r) => setTimeout(r, 20));
    this.seen.set(e.order, [...(this.seen.get(e.order) ?? []), e.seq]);
  }
}

test('ST_T18_ST_T19_키단위소비자는같은주문을순서대로처리하고_독사건은보류표로옮기며_앞사건이모두끝난위치까지커밋한다', async () => {
  const msgs: Pay[] = [];
  for (let seq = 1; seq <= 5; seq += 1) for (const order of ['A', 'B', 'C', 'P']) msgs.push({ order, seq, eventKey: `${order}-${seq}` });
  await producer.send({ topic: 'trade.payments', messages: msgs.map((m) => ({ key: 'E1', value: Buffer.from(JSON.stringify(m)) })) });
  const seen = new Map<string, number[]>();
  const registry = new Registry();
  const consumer = runKeyedConsumer<Pay>({
    brokers: kafka.brokers,
    clientId: 'it-saga',
    service: 'kafka-it',
    groupId: 'it-saga',
    topics: ['trade.payments'],
    held: drizzleHeldEventStore(database, systemClock),
    heldCounts: () => heldEventCounts(database),
    registry,
    handler: new PayHandler(seen),
  });
  await consumer.started;
  await until(() => ['A', 'B', 'C'].every((o) => seen.get(o)?.length === 5), 60_000);
  const held = async () => (await database.db.execute(sql`select business_key, kafka_offset::int as off from held_event where topic = 'trade.payments' and reprocessed_at is null order by kafka_offset`)).rows as { business_key: string; off: number }[];
  await until(async () => (await held()).length === 5, 60_000);
  await consumer.stop();
  for (const o of ['A', 'B', 'C']) expect(seen.get(o)).toEqual([1, 2, 3, 4, 5]);
  expect((await held()).every((h) => h.business_key === 'P')).toBe(true);
  const admin = createKafkaAdmin({ brokers: kafka.brokers, clientId: 'it-offsets' });
  await admin.connect();
  try {
    const offsets = await admin.fetchOffsets({ groupId: 'it-saga', topics: ['trade.payments'] });
    expect(offsets[0]!.partitions[0]!.offset).toBe('20');
  } finally {
    await admin.disconnect();
  }
}, 180_000);

test('ADR0103_결정2_3_D_T29_방송형읽기로_설정은처음부터_종료세션은15분전부터읽어야준비상태가된다', async () => {
  const s = await start();
  const now = s.clock.now();
  const setting = (enabled: boolean, occurredAt: number) =>
    Buffer.from(JSON.stringify({ commandId: 'c', key: 'FEATURE_FLAG', scope: 'PLATFORM', value: { enabled }, expiresAt: null, actor: 'a', occurredAt, eventKey: `e-${occurredAt}` }));
  await producer.send({
    topic: CONTROL_TOPICS.settings,
    messages: [
      { key: 'PLATFORM:FEATURE_FLAG:reviews', value: setting(true, now - 9 * 86_400_000), timestamp: String(now - 60_000) },
      { key: 'PLATFORM:FEATURE_FLAG:reviews', value: setting(false, now - 8 * 86_400_000), timestamp: String(now - 60_000) },
    ],
  });
  const session = (sessionId: string, at: number) => ({ key: 'acc-1', value: Buffer.from(JSON.stringify({ accountId: 'acc-1', sessionId, reason: 'LOGOUT', terminatedAt: at })), timestamp: String(at) });
  await producer.send({ topic: CONTROL_TOPICS.sessionsTerminated, messages: [session('s-old', now - 20 * 60_000), session('s-new', now - 60_000)] });
  const source = kafkaBroadcastSource({ brokers: kafka.brokers, service: 'demo-svc', pod: 'pod-1', env: 'ci' });
  const sync = startControlSync(s.svc, { source, codec: jsonControlCodec });
  try {
    expect((await s.svc.management.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    await until(async () => (await s.svc.management.inject({ method: 'GET', url: '/ready' })).statusCode === 200, 60_000);
    expect(sync.settings.get('PLATFORM:FEATURE_FLAG:reviews')?.value).toEqual({ enabled: false });
    expect(s.svc.auth.isTerminated('s-new')).toBe(true);
    expect(s.svc.auth.isTerminated('s-old')).toBe(false);
    expect(sample(await s.metrics(), 'control_sync_lagging', { service: 'demo-svc', kind: 'sessions' })).toBe(0);
    // 준비 뒤에 나온 종료도 받는다
    await producer.send({ topic: CONTROL_TOPICS.sessionsTerminated, messages: [session('s-later', now)] });
    await until(() => s.svc.auth.isTerminated('s-later'), 30_000);
  } finally {
    await sync.stop();
    await source.close();
    await s.svc.close();
  }
}, 180_000);
