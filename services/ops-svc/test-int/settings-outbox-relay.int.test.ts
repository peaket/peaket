// 리뷰 RV-03(BAT-360 OPS-290, 계획 '15. 리뷰' RV-03·12절 'Outbox 릴레이' 줄, ADR-0349 결정 5·6절 B17·B27, ADR-0143 결정 3).
// 실제 PostgreSQL 18과 Kafka(apache/kafka:3.9.2)로 본다.
// - B27 ①: 명령 12 실행의 ACKED 상태 쓰기와 설정 사건 Outbox 행이 한 트랜잭션에 든다. API는 역할 ops_app의 로그인 사용자로 붙는다(권한·시퀀스·일 파티션).
//   Outbox 행: 토픽 control.settings, 키 '<회차>:PG_ASSIGNMENT:', 값은 받는 쪽 플랫폼 해독기(controlEventCodec.setting)가 그대로 읽는 SettingChanged JSON.
// - B27 ②: Outbox 쓰기가 실패하면(트리거로 실패를 넣는다) ACKED 사건도 Outbox 행도 남지 않는다.
// - B27 ③: Kafka가 멈춰 있어도(릴레이를 띄우지 않음) 행은 sent_at 없이 남고, 릴레이(startOpsRelay)를 띄우면 control.settings에 키·값 그대로 나가고 sent_at이 적힌다.
// 판매 시작 원천·하위 결제사 판정은 다른 서비스 경계라 포트를 구현한 짝 가짜다. Lease는 메모리 API, 릴레이·정비 DB 자리는 슈퍼유저 풀이다(역할 권한은 운영 실행기 몫).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { controlEventCodec, createDatabase, createService, ensureOutboxPartitions, fakeClock, memoryLeaseApi, systemClock, type Database, type OutboxRelayProcess } from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher, type KafkaProducer } from '@peaket/platform/stream-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { pgAssignmentVerdictOf, type OnsaleStartSource, type PgAssignmentCheck, type PgAssignmentVerdict, type PgName } from '../src/modules/commands/index.js';
import { startOpsRelay } from '../src/relay-app.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands } from './reauth.js';

const SETTINGS_TOPIC = 'control.settings';
const NOW = Date.parse('2026-11-26T02:00:00.000Z');
const LEASE = { leaseDurationMs: 2_000, renewDeadlineMs: 1_500, retryPeriodMs: 100 } as const;
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });

/** 판매 시작 원천 짝 가짜: 판매 시작이 하루 뒤(온세일 윈도우 밖)다 */
const onsale: OnsaleStartSource = { saleStartMs: async () => NOW + 24 * 60 * 60_000 };
/** 하위 결제사 판정 짝 가짜: 허용(payment.proto 응답 꼴을 제품 해독 함수로 읽는다) */
const pgCheck: PgAssignmentCheck = {
  check: async (_q: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }): Promise<PgAssignmentVerdict> =>
    pgAssignmentVerdictOf({ allowed: true, current_primary_pg: 'PG_PROVIDER_TOSS', approval_limits: [{ pg: 'PG_PROVIDER_TOSS', approvals_per_second: 30 }, { pg: 'PG_PROVIDER_PORTONE', approvals_per_second: 20 }] }),
};

let pgc: PostgresContainer | undefined;
let kafka: KafkaContainer | undefined;
let admin: pg.Client;
let superDb: Database;
let appDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
let producer: KafkaProducer | undefined;
let reader: TopicCollector | undefined;
let relay: OutboxRelayProcess | undefined;

beforeAll(async () => {
  const [a, b] = await Promise.allSettled([startPostgres(), startKafka()]);
  if (a.status === 'fulfilled') pgc = a.value;
  if (b.status === 'fulfilled') kafka = b.value;
  const failed = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason as Error;
  await kafka!.createTopic(SETTINGS_TOPIC, 3);
  await migrateOps(pgc!.url);
  admin = new pg.Client({ connectionString: pgc!.url });
  await admin.connect();
  await admin.query("CREATE ROLE rv03_app LOGIN PASSWORD 'rv03-app' IN ROLE ops_app");
  superDb = createDatabase({ url: pgc!.url, applicationName: 'ops-svc-rv03-super' });
  // 일 파티션은 운영에서 릴레이 정비가 미리 만든다(Outbox 행 ID는 실제 시계의 UUIDv7)
  await ensureOutboxPartitions(superDb, systemClock);
  appDb = createDatabase({ url: pgc!.urlFor('rv03_app', 'rv03-app'), applicationName: 'ops-svc-rv03-app' });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: appDb, background: false, adminAccounts: adminAccountsForCommands, commandExtras: { pgAssignment: { onsale, pgCheck } } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 240_000);

afterAll(async () => {
  await relay?.stop().catch(() => undefined);
  await reader?.close().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await svc?.close().catch(() => undefined);
  await Promise.allSettled([appDb?.close(), superDb?.close()]);
  await admin?.end().catch(() => undefined);
  kafka?.stop();
  pgc?.stop();
});

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`기다림 초과: ${what}`);
    // 조건이 될 때까지 다시 본다(고정 대기가 아니라 다시 보기 간격)
    await new Promise((r) => setTimeout(r, 50));
  }
}

const assign = async (eventId: string, primaryPg: PgName, fallbackPg?: PgName, who: Record<string, string> = identity.ops('operator')) =>
  svc.http.inject({
    method: 'POST',
    url: '/v1/ops/commands',
    headers: { ...who, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
    payload: JSON.stringify({ type: 'PG_ASSIGN', reason: '회차 결제사 지정', params: { eventId, primaryPg, ...(fallbackPg ? { fallbackPg } : {}) } }),
  });
const outboxOf = async (key: string) =>
  (await admin.query<{ id: string; topic: string; msg_key: string; payload: Buffer; sent_at: Date | null }>('select id::text as id, topic, msg_key, payload, sent_at from outbox where msg_key = $1 order by seq', [key])).rows;
const eventsOf = async (commandId: string) => (await admin.query<{ type: string }>('select type from command_event where command_id = $1 order by seq', [commandId])).rows.map((r) => r.type);

describe('B27 설정 사건 Outbox와 릴레이(PostgreSQL·Kafka)', () => {
  let committed: { eventId: string; commandId: string; key: string } | undefined;

  test('B27 ① 명령 12 실행의 ACKED와 control.settings Outbox 행이 한 트랜잭션에 들고(ops_app 역할), 값은 받는 쪽 해독기가 그대로 읽는다', async () => {
    const eventId = randomUUID();
    const op = identity.ops('operator');
    const r = await assign(eventId, 'PORTONE', 'TOSS', op);
    expect(r.statusCode, r.payload).toBe(201);
    const { commandId, state } = JSON.parse(r.payload) as { commandId: string; state: string };
    expect(state).toBe('ACKED');
    expect(await eventsOf(commandId)).toContain('ACKED');
    const key = `${eventId}:PG_ASSIGNMENT:`;
    const rows = await outboxOf(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: SETTINGS_TOPIC, msg_key: key, sent_at: null });
    expect(controlEventCodec.setting(Buffer.from(rows[0]!.payload))).toMatchObject({ commandId, key: 'PG_ASSIGNMENT', scope: eventId, value: { primaryPg: 'PORTONE', fallbackPg: 'TOSS' }, occurredAt: clock.now() });
    // 행위자는 가명 참조이고 관리 계정 ID가 아니다
    expect(Buffer.from(rows[0]!.payload).toString('utf8')).not.toContain(op['x-user-id']!);
    committed = { eventId, commandId, key };
  });

  test('B27 ② Outbox 쓰기가 실패하면 ACKED 사건도 Outbox 행도 남지 않는다(같은 트랜잭션)', async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION rv03_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rv03 outbox down'; END $$`);
    await admin.query('CREATE TRIGGER rv03_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION rv03_fail_outbox()');
    try {
      const eventId = randomUUID();
      const r = await assign(eventId, 'TOSS');
      const key = `${eventId}:PG_ASSIGNMENT:`;
      expect(await outboxOf(key)).toEqual([]);
      if (r.statusCode === 201) {
        const { commandId, state } = JSON.parse(r.payload) as { commandId: string; state: string };
        expect(state).not.toBe('ACKED');
        expect(await eventsOf(commandId)).not.toContain('ACKED');
      } else {
        expect(r.statusCode).toBeGreaterThanOrEqual(500);
        const ids = (await admin.query<{ id: string }>("select id::text as id from ops_command where type = 'PG_ASSIGN' and params ->> 'eventId' = $1", [eventId])).rows.map((x) => x.id);
        for (const id of ids) expect(await eventsOf(id)).not.toContain('ACKED');
      }
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS rv03_fail_outbox ON outbox');
    }
  });

  test('B27 ③ Kafka에 내기 전에는 행이 sent_at 없이 남고, 릴레이(startOpsRelay)를 띄우면 control.settings에 키·값 그대로 나가며 sent_at이 적힌다', async () => {
    expect(committed).toBeDefined();
    const { key, commandId } = committed!;
    expect((await outboxOf(key))[0]!.sent_at).toBeNull();
    producer = createKafkaProducer({ brokers: kafka!.brokers, clientId: 'ops-relay-it-producer', kind: 'default' });
    await producer.connect();
    reader = await collectTopics(kafka!.brokers, [SETTINGS_TOPIC], `ops-relay-it-reader-${randomUUID()}`);
    relay = await startOpsRelay({
      env: {
        PEAKET_ENV: 'local',
        PEAKET_POD: 'ops-relay-it-0',
        PEAKET_MANAGEMENT_PORT: '0',
        PEAKET_OUTBOX_DATABASE_URL: pgc!.url,
        PEAKET_MAINTENANCE_DATABASE_URL: pgc!.url,
        PEAKET_KAFKA_BROKERS: kafka!.brokers.join(','),
      },
      database: superDb,
      maintenanceDatabase: superDb,
      outboxPublisher: kafkaOutboxPublisher(producer),
      leaseApi: memoryLeaseApi(),
      lease: LEASE,
      stopTimeoutMs: 3_000,
      logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    await until(() => relay!.isLeader(), '릴레이가 Lease 리더가 됨', 10_000);
    const [rec] = await reader.waitFor((x) => x.topic === SETTINGS_TOPIC && x.key === key, 1, 30_000);
    expect(rec!.value).not.toBeNull();
    expect(controlEventCodec.setting(Buffer.from(rec!.value ?? '', 'utf8'))).toMatchObject({ commandId, key: 'PG_ASSIGNMENT', value: { primaryPg: 'PORTONE', fallbackPg: 'TOSS' } });
    expect(rec!.value).toBe(Buffer.from((await outboxOf(key))[0]!.payload).toString('utf8'));
    await until(async () => (await outboxOf(key))[0]!.sent_at !== null, 'Outbox 행 sent_at', 10_000);
  }, 90_000);
});
