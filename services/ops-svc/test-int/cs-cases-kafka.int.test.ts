// CS 처리함 건 요청 Kafka 소비(F-06-2 GAT-280, R-T48 ④). 실제 PostgreSQL 18·Kafka(KRaft) 위에서 startOpsConsumers(main.ts와 같은 조립)를 띄운다.
// 시험 담당 lane3-f062-test. 정본: ADR-0364 결정 4(support.cases-requested를 지금 소비자 그룹 peaket.ops-svc.<환경>에서 읽고 내부 HTTP와 같은 처리기,
// 받지 않는 종류는 보류하지 않고 넘김), docs/features/transfer-refund.md §11 R-T48 ④(HTTP로 보낸 것과 합쳐 건 하나, 받지 않는 종류도 보류 행 0).
// 이 PC에서는 Kafka 네이티브 모듈이 응용 프로그램 제어에 막힐 수 있다(계획 §5 2). 컨테이너는 afterAll에서 지운다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer } from '@peaket/platform/stream-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { CS_CASES_REQUESTED_TOPIC, OPS_COMMAND_EVENTS_TOPIC, startOpsConsumers, type OpsConsumers } from '../src/consumers/index.js';
import { ReceiveCaseRequested } from '../src/modules/cases/index.js';
import type { HandleCommandEvent } from '../src/modules/commands/index.js';
import { BD10, BD3, caseRequest, testCalendar } from '../test/cs-support.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type KafkaContainer, startKafka } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pgc: PostgresContainer | undefined;
let kafka: KafkaContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let producer: KafkaProducer | undefined;
let consumers: OpsConsumers | undefined;
let commandEvents: HandleCommandEvent | undefined;
const clock = fakeClock({ now: Date.parse('2026-11-20T14:30:00.000Z') });

beforeAll(async () => {
  [pgc, kafka] = await Promise.all([startPostgres(), startKafka()]);
  await migrateOps(pgc.url);
  await kafka.createTopic(CS_CASES_REQUESTED_TOPIC, 1);
  await kafka.createTopic(OPS_COMMAND_EVENTS_TOPIC, 1);
  admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  db = createDatabase({ url: pgc.url, applicationName: 'ops-svc-cs-kafka-it' });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, calendar: testCalendar(), background: false, onCommandEvent: (h) => (commandEvents = h) }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  consumers = startOpsConsumers({
    env: 'ci',
    brokers: kafka.brokers,
    clientId: 'ops-svc-ci-it-0',
    database: db,
    handler: commandEvents!,
    cases: svc.app.get(ReceiveCaseRequested),
    clock,
    startAt: 'earliest',
    commitEveryMs: 100,
  });
  await consumers.started;
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'ops-cs-it-producer', kind: 'default' });
  await producer.connect();
}, 240_000);

afterAll(async () => {
  await consumers?.stop().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await svc?.close();
  await db?.close();
  await admin?.end().catch(() => undefined);
  kafka?.stop();
  pgc?.stop();
});

const send = (value: unknown) =>
  producer!.send({ topic: CS_CASES_REQUESTED_TOPIC, messages: [{ key: randomUUID(), value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'), headers: {} }] });
const casesOf = (sourceId: string) => admin.query<{ id: string; kind: string; progress_due_at: Date | null; result_due_at: Date | null }>('select id, kind, progress_due_at, result_due_at from cs_case where target_ref = $1', [sourceId]).then((r) => r.rows);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

describe('R-T48 ④ support.cases-requested', () => {
  test('R-T48 ④ HTTP로 보낸 본문과 같은 본문을 Kafka로 보내면 건 하나이고, Kafka로만 온 추가 검증 이의도 건이 된다', async () => {
    const body = caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' });
    const http = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const caseId = (JSON.parse(http.payload) as { caseId: string }).caseId;
    const appeal = caseRequest('VERIFICATION_APPEAL', { category: 'EXPLANATION' });
    await send(body);
    await send(appeal);
    await expect.poll(async () => (await casesOf(appeal.sourceId)).map((c) => [c.kind, iso(c.result_due_at)]), { timeout: 30_000, interval: 200 }).toEqual([['VERIFICATION_APPEAL', BD10]]);
    expect((await casesOf(body.sourceId)).map((c) => [c.id, iso(c.progress_due_at), iso(c.result_due_at)])).toEqual([[caseId, BD3, BD10]]);
    expect((await admin.query<{ case_id: string }>('select case_id from cs_case_request where event_key = $1', [body.eventKey])).rows).toEqual([{ case_id: caseId }]);
  }, 60_000);

  test('R-T48 ④ 받지 않는 종류·계약 모양이 아닌 메시지는 보류 행 0으로 넘어가고 뒤 메시지가 막히지 않는다', async () => {
    const heldBefore = Number((await admin.query<{ n: string }>('select count(*)::text as n from held_event')).rows[0]!.n);
    const inquiry = caseRequest('INQUIRY');
    await send(inquiry);
    await send(caseRequest('CONTENT_REPORT'));
    await send('{not json');
    const sentinel = caseRequest('SCANNER_UNREPORTED', { category: 'QUEUE_NOT_FLUSHED' });
    await send(sentinel);
    // 한 분할 토픽이라 뒤 메시지가 처리됐으면 앞 메시지도 지나갔다
    await expect.poll(async () => (await casesOf(sentinel.sourceId)).length, { timeout: 30_000, interval: 200 }).toBe(1);
    expect(await casesOf(inquiry.sourceId)).toEqual([]);
    expect(Number((await admin.query<{ n: string }>('select count(*)::text as n from held_event')).rows[0]!.n)).toBe(heldBefore);
  }, 60_000);
});
