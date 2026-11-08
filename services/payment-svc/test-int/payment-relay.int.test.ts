// payment-svc 릴레이 프로세스 조립(startPaymentRelay, BUILD_ORDER PRF-180, ADR-0116)을 실제 PostgreSQL 18·Kafka(apache/kafka:3.9.2)로 돈다. Lease는 메모리 API다.
// 본보기: services/purchase-svc/test-int/relay-app.int.test.ts. 정본: docs/features/payment.md §2 '승인 명령 접수의 첫 구현' 프로세스, docs/data.md §4의 7번.
// 약속:
// - 이 단계에 나가는 사건은 없다(승인 실행기 PRF-181이 낸다). 시험이 Outbox 행을 직접 넣는다.
// - DB 역할 자리(릴레이·정비)는 같은 슈퍼유저 주소의 풀 둘이다(역할 권한은 운영 실행기의 몫).
// - Lease 2초·갱신 한도 1.5초·다시 시도 0.1초로 줄이고, 기다림은 조건이 될 때까지 다시 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDatabase, type Database, ensureOutboxPartitions, memoryLeaseApi, type OutboxRelayProcess, PlatformConfigError, systemClock, writeOutbox } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { startPaymentRelay } from '../src/relay-app.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { until } from './support.js';

const TRADE_PAYMENTS = 'trade.payments';
const LEASE = { leaseDurationMs: 2_000, renewDeadlineMs: 1_500, retryPeriodMs: 100 } as const;

let pgc: PostgresContainer | undefined;
let kafka: KafkaContainer | undefined;
let relayDb: Database;
let maintenanceDb: Database;
let admin: Database;
let producer: KafkaProducer;
let reader: TopicCollector;
let relay: Promise<OutboxRelayProcess> | undefined;

beforeAll(async () => {
  const [a, b] = await Promise.allSettled([startPostgres(), startKafka()]);
  if (a.status === 'fulfilled') pgc = a.value;
  if (b.status === 'fulfilled') kafka = b.value;
  const failed = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason as Error;
  await kafka!.createTopic(TRADE_PAYMENTS, 3);
  await migratePayment(pgc!.url);
  relayDb = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'payment-relay-it-relay' });
  maintenanceDb = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'payment-relay-it-maintenance' });
  admin = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'payment-relay-it-admin' });
  await ensureOutboxPartitions(admin, systemClock);
  producer = createKafkaProducer({ brokers: kafka!.brokers, clientId: 'payment-relay-it-producer', kind: 'default' });
  await producer.connect();
  reader = await collectTopics(kafka!.brokers, [TRADE_PAYMENTS], `payment-relay-it-reader-${randomUUID()}`);
}, 240_000);

afterAll(async () => {
  const p = await relay?.catch(() => undefined);
  await p?.stop().catch(() => {});
  await reader?.close();
  await producer?.disconnect().catch(() => {});
  await Promise.allSettled([relayDb?.close(), maintenanceDb?.close(), admin?.close()]);
  kafka?.stop();
  pgc?.stop();
});

const envOf = (): Record<string, string> => ({
  PEAKET_ENV: 'local',
  PEAKET_POD: 'payment-relay-it-0',
  PEAKET_MANAGEMENT_PORT: '0',
  PEAKET_OUTBOX_DATABASE_URL: pgc!.url,
  PEAKET_MAINTENANCE_DATABASE_URL: pgc!.url,
  PEAKET_KAFKA_BROKERS: kafka!.brokers.join(','),
});

const quietLogs = new Writable({ write: (_c, _e, cb) => cb() });

/** 프로세스 하나(처음 부를 때 띄운다). 리더가 될 때까지 기다린다 */
async function sharedRelay(): Promise<OutboxRelayProcess> {
  relay ??= startPaymentRelay({
    env: envOf(),
    database: relayDb,
    maintenanceDatabase: maintenanceDb,
    outboxPublisher: kafkaOutboxPublisher(producer),
    leaseApi: memoryLeaseApi(),
    lease: LEASE,
    stopTimeoutMs: 3_000,
    logDestination: quietLogs,
  });
  const p = await relay;
  await until(() => p.isLeader(), '릴레이가 Lease 리더가 됨', 10_000, 25);
  return p;
}

async function putOutbox(key: string, value: string, headers?: Record<string, string>): Promise<string> {
  const [id] = await admin.transaction((tx) => writeOutbox(tx, systemClock, [{ topic: TRADE_PAYMENTS, key, payload: Buffer.from(value, 'utf8'), ...(headers ? { headers } : {}) }]));
  return id!;
}

const sentAtOf = async (id: string) => (await admin.pool.query<{ sent_at: Date | null }>('select sent_at from outbox where id = $1', [id])).rows[0]?.sent_at ?? null;
const samples = (text: string, name: string) => text.split('\n').filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));

describe('payment-svc 릴레이 프로세스', () => {
  test('PRF180_Outbox 행 하나가 리더의 릴레이로 trade.payments에 키·값·머리 그대로 실리고 sent_at이 적힌다', async () => {
    const key = randomUUID();
    const id = await putOutbox(key, '{"n":1}', { 'x-test': 'yes' });
    await sharedRelay();

    const [r] = await reader.waitFor((x) => x.topic === TRADE_PAYMENTS && x.key === key, 1, 30_000);
    expect(r!.value).toBe('{"n":1}');
    expect(r!.headers['x-test']).toBe('yes');
    await until(async () => (await sentAtOf(id)) !== null, 'Outbox 행 sent_at', 10_000);
  }, 60_000);

  test('PRF180_같은 키의 Outbox 행 여럿은 넣은 차례대로 나간다', async () => {
    const key = randomUUID();
    await sharedRelay();
    for (const n of [1, 2, 3]) await putOutbox(key, `{"n":${n}}`);

    const got = await reader.waitFor((x) => x.topic === TRADE_PAYMENTS && x.key === key, 3, 30_000);
    expect(got.map((r) => r.value)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  }, 60_000);

  test('PRF180_관리 포트 /metrics에 이 서비스 이름표의 릴레이 지표(리더 1, 보낸 수)가 보이고 /livez가 답한다', async () => {
    const key = randomUUID();
    await putOutbox(key, '{"n":"metrics"}');
    const p = await sharedRelay();
    await reader.waitFor((x) => x.topic === TRADE_PAYMENTS && x.key === key, 1, 30_000);
    const { managementPort } = await p.listen('127.0.0.1');

    expect((await fetch(`http://127.0.0.1:${managementPort}/livez`)).status).toBe(200);
    let text = '';
    await until(
      async () => {
        text = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
        return samples(text, 'outbox_relay_published_total').some((l) => l.includes('service="payment-svc"'));
      },
      '보낸 수 지표',
      15_000,
    );
    expect(samples(text, 'outbox_relay_published_total').find((l) => l.includes('service="payment-svc"'))).toMatch(/ [1-9]\d*$/);
    expect(samples(text, 'outbox_relay_is_leader').find((l) => l.includes('service="payment-svc"'))).toMatch(/ 1$/);
  }, 60_000);

  test('PRF180_릴레이 설정이 빠지면 시작하지 않고 PlatformConfigError로 빠진 이름을 알린다', async () => {
    const { PEAKET_POD: _pod, ...rest } = envOf();
    await expect(
      startPaymentRelay({ env: rest, database: relayDb, maintenanceDatabase: maintenanceDb, outboxPublisher: kafkaOutboxPublisher(producer), leaseApi: memoryLeaseApi(), logDestination: quietLogs }),
    ).rejects.toThrow(PlatformConfigError);
    await expect(
      startPaymentRelay({ env: rest, database: relayDb, maintenanceDatabase: maintenanceDb, outboxPublisher: kafkaOutboxPublisher(producer), leaseApi: memoryLeaseApi(), logDestination: quietLogs }),
    ).rejects.toThrow(/PEAKET_POD/);
  });
});
