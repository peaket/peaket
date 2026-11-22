// C-T53·C-T44 ②·P-T43 ②(F-02-2 OPS-310, 계획 9절·14절 1·2): ops-svc가 명령 6 결제 갈래를 실제 제어 gRPC로 payment-svc 파드들·admission-ctrl 리더에 보낸다.
// 받는 쪽은 각자의 시작 함수로 실제로 띄운다(payment-svc 파드 둘 + 늘린 파드 하나, admission-ctrl 하나). 저장소는 실제 PostgreSQL 18(ops DB와 payment DB)·Valkey 8.1이고,
// Kafka(apache/kafka:3.9.2)는 시험 동안 컨테이너를 docker pause로 막았다가 unpause로 살린다(14절 2). 결제사는 실제 HTTP 시뮬레이터다.
// 정본: control-tower §14 C-T53(Kafka가 멈춰도 전환이 모든 파드·리더에 퍼지고, 새로 뜬 파드도 pg_switch를 읽은 뒤 받으며, 살리면 같은 판의 설정 사건이 나가고 다시 적용하지 않음),
// C-T44 ②(확인 호출 길을 막은 채 commander가 명령 6 해제를 내면 바로 열림), payment P-T43 ②(감사 기록에 사유와 commander), ADR-0366 결정 1~11, ADR-0365 결정 1·4,
// ASVS v5.0.0-16.5.2(Kafka 몫). payment·admission 파드는 Kafka 브로커 없이 띄운다(local·ci 허용): 한 시험 프로세스 안에서 막힌 브로커에 붙은 Kafka 클라이언트가
// 여럿이면 이벤트 고리가 굶어 DB·gRPC 연결이 시간 초과로 끊겼다(2026-11-23 실행). 전환 효력은 제어 gRPC만 쓰고, 새 파드의 준비는 pg_switch 읽기다(ADR-0366 결정 3). 13절: Kafka 멈춤은 Outbox 행이 실제로 나가지 못하고 남았는지(sent_at 없는 행 수 ≥ 1)로 본다.
// 자리(14절 1, F-02-1 F021-E2E와 같다): ops-svc 통합 시험이 받는 쪽 원본을 상대 경로로 읽는다(의존 선언을 더하지 않는다, devops §4.4). 시작 함수는 계산한 경로의
// 동적 가져오기로 읽는다. 실행 전에 받는 쪽 의존 패키지 dist가 있어야 한다
// (pnpm exec turbo run build --filter=@peaket/payment-svc^... --filter=@peaket/admission-ctrl^... --filter=@peaket/ops-svc^...; pg-simulator dist 포함).
// 공개 이름(구현 메모 '시험 담당에게'): ResolvePgSwitch 어댑터 GrpcPgSwitchResolver({ address })와 CommandsModuleExtras.control.pgSwitch, payment 제어 주소 환경 값
// PEAKET_PAYMENT_CONTROL_GRPC_ADDRS(받는 쪽 서비스 이름 payment-svc), payment 제어 포트 PEAKET_PAYMENT_CONTROL_GRPC_PORT.
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { controlEventCodec, createDatabase, createHotRedis, createService, type Database, ensureOutboxPartitions, type HotRedis, memoryLeaseApi, type OutboxRelayProcess, systemClock } from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher, type KafkaProducer } from '@peaket/platform/stream-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { GrpcControlTransport } from '../src/adapters/grpc-control-sender.js';
import { AppModule } from '../src/app.module.js';
import { ControlFanout, type ControlTargets, DrizzleControlDeliveries, GrpcPgSwitchResolver } from '../src/modules/commands/index.js';
import { startOpsRelay } from '../src/relay-app.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { freePort, until } from '../../queue-svc/test-int/control-client.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands, reauthFor } from './reauth.js';

type Started = { close(): Promise<void>; ports?: { grpcPort: number; managementPort: number } };
type StartFn = (o: { env: Record<string, string | undefined>; logDestination?: Writable }) => Promise<Started>;
type Reply = Record<string, unknown>;
interface PaymentHelpers {
  paymentClient(address: string): { close(): void };
  unary(client: unknown, method: string, request: object, ms?: number): Promise<Reply>;
}
const SERVICES = fileURLToPath(new URL('../../', import.meta.url));
const load = async <T>(...p: string[]): Promise<T> => (await import(pathToFileURL(join(SERVICES, ...p)).href)) as T;
const startOf = async (svc: string): Promise<StartFn> => (await load<{ start: StartFn }>(svc, 'src', 'start.ts')).start;
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();

const SETTINGS_TOPIC = 'control.settings';
const TPS = { TOSS: 37.9, PORTONE: 12.5 } as const;
const identity = new FakeIdentity();
const PROBE_FAULT = { op: 'query', kind: 'pg-error', applied: false };

let pgc: PostgresContainer;
/** payment DB는 따로 띄운다(payment 파드 셋의 연결 풀이 ops DB와 한 서버의 연결 상한을 나눠 쓰지 않게) */
let payPgc: PostgresContainer;
let relayDb: Database;
let kafka: KafkaContainer;
let kafkaId = '';
let paused = false;
let opsDb: Database;
let payAdmin: pg.Client;
let payUrl: string;
let valkeyStop: () => void;
let redis: HotRedis;
let sim: { close(): Promise<void>; listen(o: { host: string; port: number }): Promise<string> };
let simUrl: string;
let simKey: string;
let pay: PaymentHelpers;
let producer: KafkaProducer | undefined;
let reader: TopicCollector | undefined;
let relay: OutboxRelayProcess | undefined;
let ops: Awaited<ReturnType<typeof createService>>;
let paymentStart: StartFn;
const running: Started[] = [];
const paymentLogs: string[] = [];
/** 받는 쪽 주소(대상 찾기 포트가 돌려준다. 늘린 파드는 여기에 더한다) */
const addrs: Record<string, string[]> = { 'payment-svc': [], 'admission-ctrl': [] };
const paymentGrpc: string[] = [];
let batchDir: string | undefined;

const sinkInto = (logs?: string[]) =>
  new Writable({
    write: (chunk, _e, cb) => {
      if (logs) for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });

async function paymentEnv(pod: string) {
  const controlPort = await freePort();
  const managementPort = await freePort();
  const grpcPort = await freePort();
  return {
    controlPort,
    managementPort,
    grpcPort,
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: pod,
      HOSTNAME: pod,
      PEAKET_DATABASE_URL: payUrl,
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_GRPC_PORT: String(grpcPort),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PEAKET_PAYMENT_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'info',
      PEAKET_PG_SIM_URL: simUrl,
      PEAKET_PG_SIM_SECRET_KEY: simKey,
      PEAKET_PG_SIM_CLIENT_KEY: 'sim_ck_f022_e2e',
      PEAKET_PG_TOSS_URL: simUrl,
      PEAKET_PG_TOSS_SECRET_KEY: simKey,
      PEAKET_PG_TOSS_CLIENT_KEY: 'sim_ck_f022_e2e_toss',
      PEAKET_PG_DEFAULT: 'SIMULATOR',
      PEAKET_PG_FALLBACK: 'TOSS',
      PEAKET_PG_APPROVAL_TPS: JSON.stringify(TPS),
    },
  };
}
const readyOf = (managementPort: number) => fetch(`http://127.0.0.1:${managementPort}/ready`).then((r) => r.status, () => 0);

beforeAll(async () => {
  const { startValkey } = await load<{ startValkey: () => Promise<{ url: string; stop(): void }> }>('queue-svc', 'test-int', 'valkey.ts');
  const [p, pp, k, v] = await Promise.all([startPostgres(), startPostgres(), startKafka(), startValkey()]);
  pgc = p;
  payPgc = pp;
  kafka = k;
  valkeyStop = v.stop;
  kafkaId = docker(['ps', '-q', '--filter', `publish=${kafka.brokers[0]!.split(':')[1]}`]);
  expect(kafkaId, 'Kafka 컨테이너 ID').toMatch(/^[0-9a-f]{12}/);
  await kafka.createTopic(SETTINGS_TOPIC, 3);
  await kafka.createTopic('control.sessions-terminated', 3);
  redis = await createHotRedis({ url: v.url });
  await migrateOps(pgc.url);
  opsDb = createDatabase({ url: pgc.url, applicationName: 'ops-svc-f022-e2e' });
  await ensureOutboxPartitions(opsDb, systemClock);
  payUrl = payPgc.url;
  await (await load<{ migratePayment: (url: string) => Promise<unknown> }>('payment-svc', 'scripts', 'migrate.mjs')).migratePayment(payUrl);
  payAdmin = new pg.Client({ connectionString: payUrl });
  await payAdmin.connect();
  pay = await load<PaymentHelpers>('payment-svc', 'test-int', 'support.ts');
  const { buildSimulatorApp } = await load<{ buildSimulatorApp: (o: Record<string, unknown>) => typeof sim }>('pg-simulator', 'dist', 'index.js');
  simKey = `sim_sk_${randomBytes(16).toString('hex')}`;
  sim = buildSimulatorApp({ secretKey: simKey, confirmLatency: { kind: 'none' } });
  simUrl = await sim.listen({ host: '127.0.0.1', port: 0 });

  paymentStart = await startOf('payment-svc');
  for (const pod of ['payment-e2e-1', 'payment-e2e-2']) {
    const e = await paymentEnv(pod);
    const started = await paymentStart({ env: e.env, logDestination: sinkInto(paymentLogs) });
    running.push(started);
    addrs['payment-svc']!.push(`127.0.0.1:${e.controlPort}`);
    paymentGrpc.push(`127.0.0.1:${started.ports!.grpcPort}`);
    await until(() => readyOf(e.managementPort), (s) => s === 200, `${pod} 준비`, { timeoutMs: 60_000 });
  }
  const admissionPort = await freePort();
  batchDir = await mkdtemp(join(tmpdir(), 'peaket-f022-e2e-batch-'));
  running.push(
    await (
      await startOf('admission-ctrl')
    )({
      env: {
        PEAKET_ENV: 'ci',
        PEAKET_POD: 'admission-e2e-1',
        HOSTNAME: 'admission-e2e-1',
        PEAKET_QUEUE_REDIS_URL: v.url,
        PEAKET_BATCH_RESULT_DIR: batchDir,
        PEAKET_TEST_BATCH_RANDOMNESS: Buffer.alloc(32, 5).toString('base64'),
        PEAKET_ADMISSION_CONTROL_GRPC_PORT: String(admissionPort),
        PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
        PORT: String(await freePort()),
        PEAKET_MANAGEMENT_PORT: String(await freePort()),
        PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
        PEAKET_LOG_LEVEL: 'fatal',
      },
      logDestination: sinkInto(),
    }),
  );
  addrs['admission-ctrl']!.push(`127.0.0.1:${admissionPort}`);

  const targets: ControlTargets = { resolve: async (service: string) => [...(addrs[service] ?? [])] };
  const deliveries = new DrizzleControlDeliveries(opsDb);
  const fanout = new ControlFanout({ targets, transport: new GrpcControlTransport(), deliveries, clock: systemClock });
  ops = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: opsDb, adminAccounts: adminAccountsForCommands, commandExtras: { control: { fanout, deliveries, pgSwitch: new GrpcPgSwitchResolver({ address: paymentGrpc[0]! }), simulatorPg: true } } }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
    adminAuthz: identity,
  });
  // 설정 사건 릴레이(Kafka가 살아 있을 때 띄워 두고, 시험 동안 Kafka를 막는다)
  // 릴레이는 따로 둔 작은 풀을 쓴다(Kafka가 막힌 동안 릴레이가 잡은 연결이 ops-svc 요청을 막지 않게)
  relayDb = createDatabase({ url: pgc.url, applicationName: 'ops-relay-f022-e2e', max: 2 });
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'ops-f022-e2e-producer', kind: 'default' });
  await producer.connect();
  relay = await startOpsRelay({
    env: { PEAKET_ENV: 'local', PEAKET_POD: 'ops-relay-f022-0', PEAKET_MANAGEMENT_PORT: '0', PEAKET_OUTBOX_DATABASE_URL: pgc.url, PEAKET_MAINTENANCE_DATABASE_URL: pgc.url, PEAKET_KAFKA_BROKERS: kafka.brokers.join(',') },
    database: relayDb,
    maintenanceDatabase: relayDb,
    outboxPublisher: kafkaOutboxPublisher(producer),
    leaseApi: memoryLeaseApi(),
    lease: { leaseDurationMs: 2_000, renewDeadlineMs: 1_500, retryPeriodMs: 100 },
    stopTimeoutMs: 3_000,
    logDestination: sinkInto(),
  });
  await until(async () => relay!.isLeader(), (x) => x, '릴레이가 Lease 리더가 됨', { timeoutMs: 15_000 });
  // 여기서부터 Kafka를 막는다(지우지 않는다)
  docker(['pause', kafkaId]);
  paused = true;
}, 420_000);

afterAll(async () => {
  if (paused) docker(['unpause', kafkaId]);
  await relay?.stop().catch(() => undefined);
  await reader?.close().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await ops?.close().catch(() => undefined);
  for (const r of running.reverse()) await r.close().catch(() => undefined);
  await sim?.close().catch(() => undefined);
  await payAdmin?.end().catch(() => undefined);
  await relayDb?.close().catch(() => undefined);
  await opsDb?.close().catch(() => undefined);
  await redis?.close();
  valkeyStop?.();
  kafka?.stop();
  pgc?.stop();
  payPgc?.stop();
  if (batchDir) await rm(batchDir, { recursive: true, force: true });
}, 120_000);

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const post = (url: string, who: Record<string, string>, body: unknown) => ops.http.inject({ method: 'POST', url, headers: { ...reauthFor(url, who), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const detail = async (id: string) => {
  const r = await ops.http.inject({ method: 'GET', url: `/v1/ops/commands/${id}`, headers: identity.ops('operator') });
  expect(r.statusCode, r.payload).toBe(200);
  return json(r);
};
async function hash(key: string): Promise<Record<string, string>> {
  const raw = (await redis.command(['HGETALL', key], { key })) as unknown;
  if (Array.isArray(raw)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = String(raw[i + 1]);
    return o;
  }
  return Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}
const switchRow = async (scope: string) =>
  (await payAdmin.query<{ active: boolean; to_pg: string | null; version: string; changed_at: Date }>('select active, to_pg, version::text as version, changed_at from pg_switch where scope = $1', [scope])).rows[0];
const outboxOf = async (key: string) => (await opsDb.pool.query<{ payload: Buffer; sent_at: Date | null }>('select payload, sent_at from outbox where msg_key = $1', [key])).rows;
const settingKey = (scope: string) => `${scope}:DEGRADED_MODE:PAYMENT_PG_FALLBACK`;
const checkout = (eventId: string) => ({ order_kind: 'ORDER_KIND_TICKET', order_id: randomUUID(), attempt_id: randomUUID(), event_id: eventId, amount: { krw: 52_000 }, order_name: 'F022 실제 연결', pay_method: 'CARD' });
const prepareOn = async (grpcAddr: string, eventId: string) => {
  const c = pay.paymentClient(grpcAddr);
  try {
    return await pay.unary(c, 'PrepareCheckout', checkout(eventId));
  } finally {
    c.close();
  }
};

/** commander가 내고 다른 operator가 승인한 결제 갈래 전환. 승인 응답 시각과 ACKED를 본 시각을 돌려준다 */
async function switchEvent(eventId: string): Promise<{ id: string; approvedAt: number; ackedAt: number }> {
  const commander = identity.ops('commander');
  const created = await post('/v1/ops/commands', commander, { type: 'DEGRADED_MODE', reason: '결제사 장애 대응(C-T53)', params: { mode: 'PAYMENT_PG_FALLBACK', scope: 'EVENT', eventIds: [eventId] } });
  expect(created.statusCode, created.payload).toBe(201);
  const id = json(created).commandId as string;
  const approve = await post(`/v1/ops/commands/${id}/approvals`, identity.ops('operator'), {});
  const approvedAt = Date.now();
  expect(approve.statusCode, approve.payload).toBe(200);
  await until(async () => (await detail(id)).state as string, (s) => s === 'ACKED' || s === 'FAILED', `명령 ${id} 끝`, { timeoutMs: 15_000, intervalMs: 20 });
  const ackedAt = Date.now();
  expect((await detail(id)).state, JSON.stringify(await detail(id))).toBe('ACKED');
  return { id, approvedAt, ackedAt };
}

describe('C-T53 Kafka를 막은 채 명령 6 대체 결제사 전환', () => {
  const switched: { eventId: string; id: string }[] = [];

  test('C-T53 ① Kafka를 막은 채 명령 6 전환을 내면 payment 모든 파드와 리더가 ack해 ACKED(스무 번 모두 3초 안) [ASVS v5.0.0-16.5.2]', async () => {
    const took: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const eventId = randomUUID();
      const r = await switchEvent(eventId);
      took.push(r.ackedAt - r.approvedAt);
      switched.push({ eventId, id: r.id });
    }
    expect(took.filter((ms) => ms >= 3_000), `걸린 ms: ${took.join(',')}`).toEqual([]);
    expect(took).toHaveLength(20);
    expect((await detail(switched[0]!.id)).delivery).toEqual({ kind: 'ACK', ackedCount: 3, targetCount: 3, unackedTargets: [] });
    // Kafka가 실제로 막혀 있었다: 설정 사건 Outbox 행이 나가지 못하고 남았다
    const unsent = (await Promise.all(switched.map((s) => outboxOf(settingKey(s.eventId))))).flat().filter((r) => r.sent_at === null);
    expect(unsent.length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  test('C-T53 ② 그 뒤 새 결제 시도는 대체 결제사로 간다(두 파드 모두)', async () => {
    const { eventId } = switched[0]!;
    for (const addr of paymentGrpc) expect(await prepareOn(addr, eventId)).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: true });
    const row = await switchRow(eventId);
    expect({ active: row?.active, to_pg: row?.to_pg }).toEqual({ active: true, to_pg: null });
  });

  test('C-T53 ③ 리더의 회차 ctl에 대체 결제사와 그 상한(내림)이 같은 판·명령 칸으로 서고 리더 루프가 그 결제사로 읽는다', async () => {
    const { eventId, id } = switched[0]!;
    const row = await hash(`q:{event:${eventId}}:ctl`);
    const version = (await switchRow(eventId))!.version;
    expect({ pgKey: row.pgKey, pgTps: row.pgTps, pgRev: row.pgRev, pgCmd: row.pgCmd }).toEqual({ pgKey: 'TOSS', pgTps: String(Math.floor(TPS.TOSS)), pgRev: version, pgCmd: id });
    const { RedisLeaderStore } = await load<{ RedisLeaderStore: new (r: HotRedis) => { control(e: string, now: number): Promise<Record<string, unknown>> } }>('admission-ctrl', 'src', 'modules', 'leader', 'adapters', 'redis-leader-store.ts');
    expect(await new RedisLeaderStore(redis).control(eventId, Date.now())).toMatchObject({ pgKey: 'TOSS', pgTps: Math.floor(TPS.TOSS) });
  });

  test('C-T53 ④ Kafka를 막은 채 늘린 payment 파드(멈춘 브로커 주소를 설정)는 제어 동기화 Degraded(30초) 뒤 준비되고, pg_switch를 읽어 대체 결제사로 보낸다 (RV-01)', async () => {
    const { eventId } = switched[0]!;
    expect(paused, 'Kafka가 멈춰 있어야 한다').toBe(true);
    const e = await paymentEnv('payment-e2e-3');
    // 이 파드만 멈춘 브로커에 붙인다(RV-01): 플랫폼 제어 동기화(settings·sessions 준비 작업)가 브로커를 기다리는 길과 pg_switch 읽기가 함께 돈다
    const startedAt = Date.now();
    const late = await paymentStart({ env: { ...e.env, PEAKET_KAFKA_BROKERS: kafka.brokers.join(',') }, logDestination: sinkInto(paymentLogs) });
    running.push(late);
    await until(() => readyOf(e.managementPort), (s) => s === 200, '늘린 파드 준비', { timeoutMs: 90_000, intervalMs: 500 });
    const readyAfter = Date.now() - startedAt;
    // 브로커가 멈췄으니 제어 동기화는 30초 [가정](플랫폼 degradeAfterMs, ADR-0103) 뒤 Degraded로 준비를 끝낸다. 그보다 이르면 브로커 길을 지나지 않은 것이다
    expect(readyAfter, `준비까지 ${readyAfter}ms`).toBeGreaterThanOrEqual(30_000 - 1_000);
    expect(await prepareOn(`127.0.0.1:${late.ports!.grpcPort}`, eventId)).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: true });
    addrs['payment-svc']!.push(`127.0.0.1:${e.controlPort}`);
    paymentGrpc.push(`127.0.0.1:${late.ports!.grpcPort}`);
  }, 150_000);

  test('C-T53 ⑤ Kafka를 살리면 같은 판의 설정 사건이 나가고 pg_switch·리더 칸은 바뀌지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { eventId, id } = switched[0]!;
    const before = await switchRow(eventId);
    const ctlBefore = await hash(`q:{event:${eventId}}:ctl`);
    expect((await outboxOf(settingKey(eventId))).map((r) => r.sent_at)).toEqual([null]);
    docker(['unpause', kafkaId]);
    paused = false;
    // 읽는 쪽은 살린 뒤에 띄운다(새 소비자 그룹이 처음부터 읽는다)
    reader = await collectTopics(kafka.brokers, [SETTINGS_TOPIC], `ops-f022-e2e-reader-${randomUUID()}`);
    const [rec] = await reader!.waitFor((x) => x.topic === SETTINGS_TOPIC && x.key === settingKey(eventId), 1, 120_000);
    const decoded = controlEventCodec.setting(Buffer.from(rec!.value ?? '', 'utf8'));
    expect(decoded).toMatchObject({ commandId: id, key: 'DEGRADED_MODE', scope: eventId, value: { enabled: true }, occurredAt: Number(before!.version) });
    await until(async () => (await outboxOf(settingKey(eventId)))[0]!.sent_at !== null, (x) => x, 'Outbox 행 sent_at', { timeoutMs: 30_000 });
    // 사건이 나간 뒤에도 pg_switch·리더 칸이 같다: 이 사건으로 다시 적용하지 않는다
    const stable: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      stable.push(await switchRow(eventId));
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const s of stable) expect(s).toEqual(before);
    expect(await hash(`q:{event:${eventId}}:ctl`)).toEqual(ctlBefore);
  }, 180_000);
});

describe('C-T44 ② 확인 호출 길을 막은 채 명령 6 해제', () => {
  test('C-T44 ② 확인 호출 길을 막은 채 commander가 명령 6 해제를 내면 모든 파드가 바로 연다(actor = 요청자 계정)', async () => {
    const eventId = randomUUID();
    await payAdmin.query("insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, 'TOSS', null, now())", [eventId]);
    // 확인 호출(조회) 길을 막는다
    const simCtl = (method: string, path: string, body?: unknown) =>
      fetch(`${simUrl}${path}`, { method, headers: { authorization: `Basic ${Buffer.from(`${simKey}:`).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await simCtl('POST', '/sim/faults', PROBE_FAULT)).status).toBe(204);
    try {
      await payAdmin.query("insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('TOSS', 'ALL', 'PROBING', 'PG_FAILURE', 'SYSTEM', now() - interval '1 minute', 1)");
      // 모든 파드가 정지를 읽어 캐시에 둘 때까지(조건 대기)
      for (const addr of paymentGrpc) await until(() => prepareOn(addr, eventId).then(() => 'open', (e: { details?: string }) => String(e.details)), (d) => d === 'new-payment-paused', `${addr} 정지 읽음`, { timeoutMs: 15_000 });
      const commander = identity.ops('commander');
      const r = await post('/v1/ops/commands', commander, { type: 'DEGRADED_MODE', reason: '확인 호출 길 고장(C-T44)', params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'TOSS' } });
      expect(r.statusCode, r.payload).toBe(201);
      const id = json(r).commandId as string;
      await until(async () => (await detail(id)).state as string, (s) => s === 'ACKED' || s === 'FAILED', '해제 명령 끝', { timeoutMs: 15_000, intervalMs: 20 });
      expect((await detail(id)).state).toBe('ACKED');
      expect((await detail(id)).delivery).toMatchObject({ kind: 'ACK', ackedCount: paymentGrpc.length, targetCount: paymentGrpc.length });
      // 다음 1초 캐시를 기다리지 않고 모든 파드가 통과시킨다
      const t = Date.now();
      for (const addr of paymentGrpc) expect(await prepareOn(addr, eventId)).toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
      expect(Date.now() - t).toBeLessThan(1_000);
      const row = (await payAdmin.query<{ stage: string; actor: string }>("select stage, actor from payment_entry_pause where pg = 'TOSS' and channel = 'ALL'")).rows[0];
      expect(row).toEqual({ stage: 'OPEN', actor: commander['x-user-id'] });
    } finally {
      await simCtl('DELETE', '/sim/faults');
    }
  }, 180_000);
});

describe('P-T43 ② 해제의 감사 기록', () => {
  test('P-T43 ② 해제의 감사 기록에 사유와 commander가 남고 payment-svc 표·로그에는 사유가 없다 [ASVS v5.0.0-16.5.2]', async () => {
    await payAdmin.query("delete from payment_entry_pause where pg = 'PORTONE'");
    await payAdmin.query("insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('PORTONE', 'ALL', 'PROBING', 'PG_FAILURE', 'SYSTEM', now() - interval '1 minute', 1)");
    const reason = `P-T43 감사 사유 ${randomUUID()}`;
    const commander = identity.ops('commander');
    const r = await post('/v1/ops/commands', commander, { type: 'DEGRADED_MODE', reason, params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'PORTONE' } });
    expect(r.statusCode, r.payload).toBe(201);
    const id = json(r).commandId as string;
    await until(async () => (await detail(id)).state as string, (s) => s === 'ACKED' || s === 'FAILED', '해제 명령 끝', { timeoutMs: 15_000, intervalMs: 20 });
    expect((await detail(id)).state).toBe('ACKED');
    const audits = (await opsDb.pool.query<{ record_type: string; record_json: unknown }>('select record_type, record_json from audit_chain where record_id = $1 order by seq', [id])).rows;
    const created = audits.find((a) => a.record_type === 'COMMAND_CREATED');
    const record = (typeof created?.record_json === 'string' ? JSON.parse(created.record_json) : created?.record_json) as { payload?: Record<string, unknown> } | undefined;
    expect(record?.payload).toMatchObject({ type: 'DEGRADED_MODE', reason, requestedRole: 'commander' });
    const paymentRow = (await payAdmin.query<Record<string, unknown>>("select * from payment_entry_pause where pg = 'PORTONE' and channel = 'ALL'")).rows[0];
    expect(paymentRow).toMatchObject({ stage: 'OPEN', actor: commander['x-user-id'] });
    expect(JSON.stringify(paymentRow)).not.toContain(reason);
    // 로그가 실제로 잡혔는지 먼저 본다(RV-05): 그 해제의 released 줄(결제사 PORTONE, actor = 요청자 계정 ID)이 하나 이상이다
    const released = paymentLogs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } }).filter((o) => o?.kind === 'payment-entry-pause-released' && o.pg === 'PORTONE');
    expect(released.length).toBeGreaterThanOrEqual(1);
    expect(released.map((o) => o!.actor)).toContain(commander['x-user-id']);
    expect(paymentLogs.filter((l) => l.includes(reason))).toEqual([]);
  }, 120_000);
});
