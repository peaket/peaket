// C-T54 ①~④·ASVS v5.0.0-2.3.3(F-02-5 OPS-300, 계획 docs/review/plans/F-02-5.md 6절 B1·B3·B5·B8~B13·B16, 9절 C-T54·2.3.3 줄, 13절).
// 설정형 명령 8·9의 설정 사건이 ops Outbox → 실제 릴레이 → 실제 Kafka(control.settings)로 나가고, ops-svc 적용 확인 바퀴(CheckSettingsApply)가
// 가짜 Prometheus(`/api/v1/query` 응답 꼴만 흉내 내는 시험용 HTTP 서버)에 즉시 질의 둘을 보내 명령의 delivery(APPLY_CHECK)를 바꾸는지 실제 PostgreSQL 18로 본다.
// - 받는 쪽 파드: 공용 서버 패키지의 실제 설정 저장(SettingsStore)과 실제 지표(ControlSyncMetrics의 control_settings_applied_version)를 파드마다 하나씩 만들고,
//   실제 Kafka에서 읽은 레코드를 운영 해독기(controlEventCodec.setting)로 읽어 적용한다. 가짜 Prometheus는 그 파드들의 지표 글(registry.metrics())을 읽어
//   Prometheus 즉시 질의 응답 꼴({status:'success', data:{resultType:'vector', result:[{metric:{pod,…}, value:[초, "<값>"]}]}})로 돌려준다(계획 9절 ④, 14절 5).
// - 정본 값(시험 안에 적는다, 코드 상수를 가져오지 않는다): Outbox 지연 5,000ms(이하 CHECKING·5,001ms부터 OUTBOX_WAITING), 나간 시각 + 30,000ms 정각 UNCONFIRMED,
//   그 뒤 1분마다 다시 보기, 경보 SEV3 `settings-apply-unconfirmed`(경보 사건 키 = 명령 ID), 명령 8 만료 30분, unackedTargets 글 '<파드>:<판>'(판 없으면 '<파드>:-')
//   (ADR-0365 결정 10·13·14·15, ADR-0143 결정 4, control-tower §14 C-T54).
// - 시계: 서비스·릴레이·적용 확인이 같은 가짜 시계(벽시계)를 쓴다. 릴레이의 Lease 갱신만 실제 단조 시계다(벽시계를 30분 넘겨도 Lease를 잃지 않게).
//   적용 확인 바퀴는 손으로 돌린다(background: false). 실제 대기는 조건 다시 보기(until)뿐이다.
// - Kafka 막기는 컨테이너 docker pause·unpause(f022-pg-switch-e2e와 같다). Prometheus 막기는 가짜 서버를 닫은 주소(연결 거절)다.
// - 2.3.3: Outbox INSERT에 실패 트리거를 걸어(settings-outbox-relay B27 ②와 같은 방법) 실행·되돌리기·만료 셋마다 상태·사건·감사·적용 확인 행·Outbox가 모두 남지 않는지,
//   트리거를 거둔 뒤에는 같은 일이 실제로 되는지(시험이 비어 통과하지 않게) 본다.
// 공개 이름은 계획 8.2 그대로: CommandsModuleExtras.settingsApply = { probe, store?, alerts?, roundMs? }, CheckSettingsApply({ store, probe, alerts?, clock }).runOnce(),
// PrometheusSettingsProbe({ url }), DrizzleApplyChecks(database), 마이그레이션 0026 command_apply_check 칸 이름.
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import {
  ControlSyncMetrics,
  controlEventCodec,
  createDatabase,
  createService,
  ensureOutboxPartitions,
  fakeClock,
  memoryLeaseApi,
  PlatformMetrics,
  SettingsStore,
  systemClock,
  type Clock,
  type Database,
  type OutboxRelayProcess,
  type SettingChanged,
} from '@peaket/platform';
import { createKafkaProducer, kafkaOutboxPublisher, type KafkaProducer } from '@peaket/platform/stream-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleOpsAlertStore, RecordOpsAlert } from '../src/modules/alerts/index.js';
import { CheckSettingsApply, CommandMaintenanceJob, DrizzleApplyChecks, DrizzleCommandStore, MaintainCommands, PrometheusSettingsProbe, PublishOnsaleLogSampling, type OnsaleScheduleSource } from '../src/modules/commands/index.js';
import { startOpsRelay } from '../src/relay-app.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector, type TopicRecord } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands, reauthFor } from './reauth.js';

const SETTINGS_TOPIC = 'control.settings';
const NOW = Date.parse('2026-11-26T02:00:00.000Z');
const SEC = 1_000;
const MIN = 60_000;
/** 정본: 나간 시각부터 30초(ADR-0365 결정 14, C-T54) */
const WINDOW_MS = 30 * SEC;
/** 정본: Outbox 지연 5초(ADR-0143 결정 4, ADR-0365 결정 14) */
const OUTBOX_WAIT_MS = 5 * SEC;
/** 정본: 명령 8 만료 30분(ADR-0365 결정 13, control-tower §3 명령 8) */
const LOG_LEVEL_TTL_MS = 30 * MIN;
/** 정본: 경보 종류(ADR-0365 결정 14) */
const ALERT_KIND = 'settings-apply-unconfirmed';
const LEASE = { leaseDurationMs: 2_000, renewDeadlineMs: 1_500, retryPeriodMs: 100 } as const;

const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
/** 릴레이 시계: sent_at은 서비스와 같은 가짜 벽시계, Lease 갱신은 실제 단조 시계 */
const relayClock: Clock = { now: () => clock.now(), monotonicMs: () => performance.now() };
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();

// ── 받는 쪽 파드(공용 서버 패키지의 실제 설정 저장과 지표) ────────────────────────────────────────

/** 서비스 파드 하나: 실제 SettingsStore가 적용하면 실제 control_settings_applied_version{service,key}가 그 판이 된다 */
class ReceiverPod {
  readonly #metrics: PlatformMetrics;
  readonly settings: SettingsStore;
  constructor(
    readonly service: string,
    readonly pod: string,
  ) {
    this.#metrics = new PlatformMetrics(service);
    this.settings = new SettingsStore(clock, new ControlSyncMetrics(this.#metrics.registry, service));
  }

  /** Kafka에서 읽은 레코드를 운영 해독기로 읽어 적용한다(받는 쪽 플랫폼 startControlSync가 하는 일의 저장 부분) */
  receive(rec: TopicRecord): boolean {
    return this.settings.apply(rec.key ?? '', controlEventCodec.setting(Buffer.from(rec.value ?? '', 'utf8')));
  }

  /** 다른 사건(같은 키의 다른 판)을 적용한다 */
  applyRaw(key: string, s: SettingChanged): boolean {
    return this.settings.apply(key, s);
  }

  /** 이 파드의 /metrics 글에서 control_settings_applied_version 표본을 키마다 읽는다 */
  async appliedVersions(): Promise<Map<string, number>> {
    const text = await this.#metrics.registry.metrics();
    const out = new Map<string, number>();
    for (const line of text.split('\n')) {
      const m = /^control_settings_applied_version\{([^}]*)\}\s+(\S+)$/.exec(line);
      if (!m) continue;
      const labels = labelsOf(m[1]!);
      if (labels.service === this.service && labels.key !== undefined) out.set(labels.key, Number(m[2]));
    }
    return out;
  }
}

function labelsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

// ── 가짜 Prometheus(즉시 질의 /api/v1/query 응답 꼴만) ─────────────────────────────────────────

/** up{service="<s>"} == 1 → 그 서비스의 '준비된' 파드, control_settings_applied_version{service,key} → 그 파드들의 실제 지표 값 */
class FakePrometheus {
  /** 서비스 → up == 1인 파드들 */
  readonly up = new Map<string, ReceiverPod[]>();
  /** 받은 질의 글(차례대로) */
  readonly queries: string[] = [];
  #server: Server | undefined;
  url = '';

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const a = this.#server.address();
    this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }

  async stop(): Promise<void> {
    const s = this.#server;
    this.#server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://prom.test');
    let query = u.searchParams.get('query');
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      query = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('query') ?? query;
    }
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname !== '/api/v1/query' || query === null) return send(404, { status: 'error', errorType: 'not_found', error: 'not found' });
    this.queries.push(query);
    const m = /^\s*([A-Za-z_:][A-Za-z0-9_:]*)\s*\{([^}]*)\}\s*(==\s*1)?\s*$/.exec(query);
    if (!m) return send(400, { status: 'error', errorType: 'bad_data', error: `parse error: ${query}` });
    const [, name, rawLabels, eqOne] = m;
    const labels = labelsOf(rawLabels!);
    const ts = clock.now() / 1000;
    const pods = this.up.get(labels.service ?? '') ?? [];
    if (name === 'up' && eqOne) {
      return send(200, { status: 'success', data: { resultType: 'vector', result: pods.map((p) => ({ metric: { __name__: 'up', job: 'kubernetes-pods', namespace: 'peaket', service: p.service, pod: p.pod }, value: [ts, '1'] })) } });
    }
    if (name === 'control_settings_applied_version' && !eqOne && labels.key !== undefined) {
      const result: unknown[] = [];
      for (const p of pods) {
        const v = (await p.appliedVersions()).get(labels.key);
        if (v !== undefined) result.push({ metric: { __name__: name, namespace: 'peaket', service: p.service, key: labels.key, pod: p.pod }, value: [ts, String(v)] });
      }
      return send(200, { status: 'success', data: { resultType: 'vector', result } });
    }
    return send(400, { status: 'error', errorType: 'bad_data', error: `unexpected query: ${query}` });
  }
}

// ── 조립 ───────────────────────────────────────────────────────────────────────────

let pgc: PostgresContainer | undefined;
let kafka: KafkaContainer | undefined;
let kafkaId = '';
let paused = false;
let admin: pg.Client;
let superDb: Database;
let appDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
let producer: KafkaProducer | undefined;
let reader: TopicCollector | undefined;
let relay: OutboxRelayProcess | undefined;
const prometheus = new FakePrometheus();

/** 적용 확인 바퀴 하나(같은 DB 역할 ops_app, 같은 가짜 시계). probe만 시험마다 고른다 */
const checkerWith = (probe: PrometheusSettingsProbe) =>
  new CheckSettingsApply({ store: new DrizzleApplyChecks(appDb), probe, alerts: new RecordOpsAlert(new DrizzleOpsAlertStore(appDb), () => clock.now()), clock });
/** 실제 정비 작업의 적용 확인 바퀴(TR-01): 시험은 CheckSettingsApply를 손으로 부르지 않고 이 작업의 tickApplyCheck를 부른다 */
const jobWith = (check: CheckSettingsApply): CommandMaintenanceJob => {
  const maintain = { runOnce: async () => ({ approvalsExpired: 0, revertsExpired: 0, autoExpired: 0, compared: 0, actorsPurged: 0 }) } as unknown as MaintainCommands;
  return new CommandMaintenanceJob(maintain, clock, { enabled: false, intervalMs: 30_000 }, undefined, { settingsApply: check });
};
let checker: CheckSettingsApply;
let job: CommandMaintenanceJob;

beforeAll(async () => {
  const [a, b] = await Promise.allSettled([startPostgres(), startKafka()]);
  if (a.status === 'fulfilled') pgc = a.value;
  if (b.status === 'fulfilled') kafka = b.value;
  const failed = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason as Error;
  kafkaId = docker(['ps', '-q', '--filter', `publish=${kafka!.brokers[0]!.split(':')[1]}`]);
  expect(kafkaId, 'Kafka 컨테이너 ID').toMatch(/^[0-9a-f]{12}/);
  await kafka!.createTopic(SETTINGS_TOPIC, 3);
  await migrateOps(pgc!.url);
  admin = new pg.Client({ connectionString: pgc!.url });
  await admin.connect();
  // API·적용 확인은 운영 역할 ops_app의 로그인 사용자로 붙는다(0026의 command_apply_check 쓰기·outbox(id, sent_at) 읽기 권한을 함께 본다)
  await admin.query("CREATE ROLE f025_app LOGIN PASSWORD 'f025-app' IN ROLE ops_app");
  superDb = createDatabase({ url: pgc!.url, applicationName: 'ops-svc-f025-super' });
  // 일 파티션: Outbox 행 ID(UUIDv7)가 실제 시계로 나든 가짜 시계로 나든 그 날짜가 있어야 한다
  await ensureOutboxPartitions(superDb, systemClock);
  await ensureOutboxPartitions(superDb, clock);
  appDb = createDatabase({ url: pgc!.urlFor('f025_app', 'f025-app'), applicationName: 'ops-svc-f025-app' });
  await prometheus.start();
  const liveProbe = new PrometheusSettingsProbe({ url: prometheus.url });
  checker = checkerWith(liveProbe);
  job = jobWith(checker);
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      database: appDb,
      background: false,
      adminAccounts: adminAccountsForCommands,
      commandExtras: { settingsApply: { probe: liveProbe, store: new DrizzleApplyChecks(appDb), alerts: new DrizzleOpsAlertStore(appDb) } },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  producer = createKafkaProducer({ brokers: kafka!.brokers, clientId: 'ops-f025-relay-producer', kind: 'default' });
  await producer.connect();
  reader = await collectTopics(kafka!.brokers, [SETTINGS_TOPIC], `ops-f025-reader-${randomUUID()}`);
  relay = await startOpsRelay({
    env: {
      PEAKET_ENV: 'local',
      PEAKET_POD: 'ops-f025-relay-0',
      PEAKET_MANAGEMENT_PORT: '0',
      PEAKET_OUTBOX_DATABASE_URL: pgc!.url,
      PEAKET_MAINTENANCE_DATABASE_URL: pgc!.url,
      PEAKET_KAFKA_BROKERS: kafka!.brokers.join(','),
    },
    clock: relayClock,
    database: superDb,
    maintenanceDatabase: superDb,
    outboxPublisher: kafkaOutboxPublisher(producer),
    leaseApi: memoryLeaseApi(),
    lease: LEASE,
    stopTimeoutMs: 3_000,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  await until(() => relay!.isLeader(), '릴레이가 Lease 리더가 됨', 15_000);
}, 240_000);

afterAll(async () => {
  if (paused) docker(['unpause', kafkaId]);
  await relay?.stop().catch(() => undefined);
  await reader?.close().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await svc?.close().catch(() => undefined);
  await prometheus.stop().catch(() => undefined);
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

/** 가짜 시계를 절대 시각 at으로 옮긴다(되돌아가지 않는다) */
function clockTo(at: number): void {
  const d = at - clock.now();
  expect(d, `시계를 되돌릴 수 없다(${new Date(at).toISOString()})`).toBeGreaterThanOrEqual(0);
  clock.advance(d);
}

type Headers = Record<string, string>;
const post = (url: string, headers: Headers, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...reauthFor(url, headers), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

interface Delivery {
  kind: string;
  ackedCount: number;
  targetCount: number;
  unackedTargets: string[];
  applyStatus?: string | null;
}
const commandView = async (id: string) => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/commands/${id}`, headers: identity.ops('operator') });
  expect(r.statusCode, r.payload).toBe(200);
  return JSON.parse(r.payload) as { state: string; delivery?: Delivery | null; lastError?: string | null };
};

/** 명령 하나를 낸다(명령 8·9는 operator 1인 승인 방식이라 접수에서 실행까지 간다) */
async function issue(type: 'LOG_LEVEL' | 'FEATURE_OFF', params: Record<string, unknown>): Promise<{ commandId: string; state: string; status: number }> {
  const r = await post('/v1/ops/commands', identity.ops('operator'), { type, reason: `F-02-5 ${type} 시험`, params });
  expect([201, 200]).toContain(r.statusCode);
  const body = JSON.parse(r.payload) as { commandId: string; state: string };
  return { ...body, status: r.statusCode };
}

interface ApplyRow {
  stage: string;
  version: string;
  message_key: string;
  outbox_id: string;
  service: string | null;
  status: string;
  sent_at: Date | null;
  target_count: number;
  acked_count: number;
  alert_open: boolean;
  reason: string | null;
}
const applyRows = async (commandId: string) =>
  (
    await admin.query<ApplyRow>(
      'select stage, version::text as version, message_key, outbox_id::text as outbox_id, service, status, sent_at, target_count, acked_count, alert_open, reason from command_apply_check where command_id = $1 order by version',
      [commandId],
    )
  ).rows;
/** 그 명령의 설정 사건 Outbox 행(값 JSON의 commandId로 고른다) */
const outboxOf = async (commandId: string) =>
  (
    await admin.query<{ id: string; msg_key: string; payload: Buffer; sent_at: Date | null }>(
      "select id::text as id, msg_key, payload, sent_at from outbox where topic = $1 and convert_from(payload, 'UTF8')::jsonb ->> 'commandId' = $2 order by seq",
      [SETTINGS_TOPIC, commandId],
    )
  ).rows;
const alertsOf = async (commandId: string) =>
  (await admin.query<{ severity: string; source: string; resolved_at: Date | null }>('select severity, source, resolved_at from ops_alert where event_key = $1 and kind = $2', [commandId, ALERT_KIND])).rows;
const eventsOf = async (commandId: string) => (await admin.query<{ type: string }>('select type from command_event where command_id = $1 order by seq', [commandId])).rows.map((r) => r.type);
const auditsOf = async (commandId: string) => (await admin.query<{ record_type: string }>('select record_type from audit_chain where record_id = $1 order by seq', [commandId])).rows.map((r) => r.record_type);
const stateOf = async (commandId: string) => (await admin.query<{ state: string }>('select state from ops_command where id = $1', [commandId])).rows[0]?.state;

/** 그 명령의 Outbox 행이 실제로 나갈 때까지 기다리고 나간 시각(가짜 벽시계 밀리초)을 준다 */
async function sentAtOf(commandId: string, ms = 30_000): Promise<number> {
  let sent: Date | null = null;
  await until(async () => ((sent = (await outboxOf(commandId))[0]?.sent_at ?? null), sent !== null), `${commandId} Outbox sent_at`, ms);
  return sent!.getTime();
}
/** 실제 Kafka에서 그 명령의 레코드를 읽는다 */
async function recordOf(commandId: string, ms = 30_000): Promise<TopicRecord> {
  const [rec] = await reader!.waitFor((r) => r.topic === SETTINGS_TOPIC && r.value !== null && (JSON.parse(r.value) as { commandId?: string }).commandId === commandId, 1, ms);
  return rec!;
}

describe('C-T54 설정형 명령의 적용 확인(실제 PostgreSQL·Kafka·릴레이, 가짜 Prometheus)', () => {
  test('IR-02 DB 조립에서 PublishOnsaleLogSampling.runOnce가 LOG_SAMPLING Outbox를 낸다', async () => {
    const store = new DrizzleCommandStore(appDb);
    const eventId = randomUUID();
    const source: OnsaleScheduleSource = { opensBetween: async () => [{ eventId, opensAtMs: clock.now() + 30 * 60_000, scale: 'LARGE' }] };
    const job = new PublishOnsaleLogSampling({ schedule: source, publisher: store, clock });
    await expect(job.runOnce()).resolves.toMatchObject({ status: 'PUBLISHED' });
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from outbox where msg_key = 'PLATFORM:LOG_SAMPLING:*' and convert_from(payload, 'UTF8') like $1",
      [`%${eventId}%`],
    );
    expect(rows[0]!.n).toBe(1);
  });

  test('C-T54 ① 명령 8을 내고 받는 서비스 파드 하나가 그 판을 내지 않으면 나간 뒤 30초 정각에 UNCONFIRMED·SEV3 하나이고 unackedTargets에 그 파드와 판(없으면 -)이 있다', async () => {
    const podA = new ReceiverPod('purchase-svc', 'purchase-svc-7d9f-a');
    const podB = new ReceiverPod('purchase-svc', 'purchase-svc-7d9f-b');
    prometheus.up.set('purchase-svc', [podA, podB]);
    const { commandId, state } = await issue('LOG_LEVEL', { service: 'purchase-svc', level: 'DEBUG' });
    expect(state).toBe('ACKED');

    // 사건 하나와 적용 확인 행 하나가 같은 실행에서 남는다(B1)
    const [row] = await outboxOf(commandId);
    expect(row?.msg_key).toBe('PLATFORM:LOG_LEVEL:purchase-svc');
    const setting = controlEventCodec.setting(Buffer.from(row!.payload));
    expect(setting).toMatchObject({ commandId, key: 'LOG_LEVEL', scope: 'PLATFORM', value: { level: 'DEBUG' } });
    expect(setting.expiresAt).toBe(setting.occurredAt + LOG_LEVEL_TTL_MS);
    const version = setting.occurredAt;
    expect(await applyRows(commandId)).toEqual([
      expect.objectContaining({ stage: 'ACKED', version: String(version), message_key: 'PLATFORM:LOG_LEVEL:purchase-svc', outbox_id: row!.id, service: 'purchase-svc' }),
    ]);

    const sent = await sentAtOf(commandId);
    // 파드 A만 실제 Kafka 레코드를 받는다. 파드 B는 받지 못한다
    expect(podA.receive(await recordOf(commandId))).toBe(true);
    expect((await podA.appliedVersions()).get('PLATFORM:LOG_LEVEL:purchase-svc')).toBe(version);

    clockTo(sent + WINDOW_MS - 1);
    await job.tickApplyCheck();
    expect((await applyRows(commandId))[0]).toMatchObject({ status: 'CHECKING', alert_open: false });
    expect(await alertsOf(commandId)).toEqual([]);
    expect((await commandView(commandId)).delivery).toMatchObject({ kind: 'APPLY_CHECK', applyStatus: 'CHECKING' });

    clockTo(sent + WINDOW_MS);
    const round = await job.tickApplyCheck();
    expect(round.opened).toBe(1);
    const [after] = await applyRows(commandId);
    expect(after).toMatchObject({ status: 'UNCONFIRMED', alert_open: true, target_count: 2, acked_count: 1 });
    expect(after!.sent_at?.getTime()).toBe(sent);
    expect(await alertsOf(commandId)).toEqual([{ severity: 'SEV3', source: 'ops-svc', resolved_at: null }]);
    // 실제 HTTP 응답의 delivery(B16)
    const view = await commandView(commandId);
    expect(view.state).toBe('ACKED');
    expect(view.delivery).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'UNCONFIRMED', targetCount: 2, ackedCount: 1, unackedTargets: ['purchase-svc-7d9f-b:-'] });
    // 가짜 Prometheus가 받은 질의는 계약 꼴 둘뿐이고 라벨은 목록 값이다(ASVS 1.3.6은 단위 시험이 따로 본다)
    expect(prometheus.queries).toEqual(expect.arrayContaining(['up{service="purchase-svc"} == 1']));
    expect(prometheus.queries.some((q) => /^control_settings_applied_version\{service="purchase-svc",\s*key="PLATFORM:LOG_LEVEL:purchase-svc"\}$/.test(q))).toBe(true);

    // 같은 때 바퀴를 한 번 더 돌려도 경보를 다시 열지 않는다(명령마다 하나)
    expect((await job.tickApplyCheck()).opened).toBe(0);
    expect(await alertsOf(commandId)).toHaveLength(1);

    // ② 뒤 절반: UNCONFIRMED 뒤 1분 다시 보기에 파드 B가 따라잡았으면 CONFIRMED로 바꾸고 경보를 닫는다
    expect(podB.receive(await recordOf(commandId))).toBe(true);
    clockTo(sent + WINDOW_MS + MIN);
    expect((await job.tickApplyCheck()).resolved).toBe(1);
    expect((await applyRows(commandId))[0]).toMatchObject({ status: 'CONFIRMED', alert_open: false, target_count: 2, acked_count: 2 });
    const [alert] = await alertsOf(commandId);
    expect(alert?.resolved_at).not.toBeNull();
    expect((await commandView(commandId)).delivery).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CONFIRMED', targetCount: 2, ackedCount: 2, unackedTargets: [] });
  }, 90_000);

  test('C-T54 ① 판이 낮은 파드는 unackedTargets에 그 파드와 그 파드가 낸 판이 실린다', async () => {
    const p1 = new ReceiverPod('payment-svc', 'payment-svc-0');
    const p2 = new ReceiverPod('payment-svc', 'payment-svc-1');
    prometheus.up.set('payment-svc', [p1, p2]);
    const { commandId } = await issue('LOG_LEVEL', { service: 'payment-svc', level: 'TRACE' });
    const sent = await sentAtOf(commandId);
    const rec = await recordOf(commandId);
    const real = controlEventCodec.setting(Buffer.from(rec.value ?? '', 'utf8'));
    expect(p1.receive(rec)).toBe(true);
    // 파드 2는 같은 키의 한 판 낮은 사건만 가졌다(이번 사건을 받지 못함)
    const older = real.occurredAt - 1;
    expect(p2.applyRaw(rec.key!, { ...real, occurredAt: older, eventKey: randomUUID() })).toBe(true);
    clockTo(sent + WINDOW_MS);
    await job.tickApplyCheck();
    expect((await commandView(commandId)).delivery).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'UNCONFIRMED', targetCount: 2, ackedCount: 1, unackedTargets: [`payment-svc-1:${older}`] });
    expect(await alertsOf(commandId)).toHaveLength(1);
  }, 90_000);

  test('C-T54 ② 받는 서비스의 모든 파드가 판 이상이면 30초 전 첫 확인 바퀴에 CONFIRMED이고 경보가 없다', async () => {
    const x = new ReceiverPod('identity-svc', 'identity-svc-x');
    const y = new ReceiverPod('identity-svc', 'identity-svc-y');
    prometheus.up.set('identity-svc', [x, y]);
    const { commandId } = await issue('LOG_LEVEL', { service: 'identity-svc', level: 'DEBUG' });
    const sent = await sentAtOf(commandId);
    const rec = await recordOf(commandId);
    const real = controlEventCodec.setting(Buffer.from(rec.value ?? '', 'utf8'));
    expect(x.receive(rec)).toBe(true);
    // y는 같은 키의 더 새 판을 이미 받았다('판 이상'으로 맞는다, ADR-0365 결정 14)
    expect(y.applyRaw(rec.key!, { ...real, occurredAt: real.occurredAt + 7, eventKey: randomUUID() })).toBe(true);
    clockTo(sent + OUTBOX_WAIT_MS);
    await job.tickApplyCheck();
    expect((await applyRows(commandId))[0]).toMatchObject({ status: 'CONFIRMED', alert_open: false, target_count: 2, acked_count: 2 });
    expect((await commandView(commandId)).delivery).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CONFIRMED', targetCount: 2, ackedCount: 2, unackedTargets: [] });
    // 30초가 지나도 CONFIRMED 그대로이고 경보가 없다
    clockTo(sent + WINDOW_MS + 5 * SEC);
    await job.tickApplyCheck();
    expect((await applyRows(commandId))[0]!.status).toBe('CONFIRMED');
    expect(await alertsOf(commandId)).toEqual([]);
  }, 90_000);

  test('C-T54 ④ Kafka를 막은 채 명령 9를 내면 5,000ms까지 CHECKING·5,001ms부터 OUTBOX_WAITING이고, 막힌 동안 UNCONFIRMED가 되지 않으며, 풀면 릴레이가 보내 CONFIRMED', async () => {
    const c1 = new ReceiverPod('core-svc', 'core-svc-1');
    const c2 = new ReceiverPod('core-svc', 'core-svc-2');
    prometheus.up.set('core-svc', [c1, c2]);
    docker(['pause', kafkaId]);
    paused = true;
    try {
      const { commandId, state } = await issue('FEATURE_OFF', { flag: 'reviews' });
      const written = clock.now();
      expect(state).toBe('ACKED');
      const [row] = await outboxOf(commandId);
      expect(row).toMatchObject({ msg_key: 'PLATFORM:FEATURE_FLAG:reviews', sent_at: null });
      expect(controlEventCodec.setting(Buffer.from(row!.payload))).toMatchObject({ commandId, key: 'FEATURE_FLAG', scope: 'PLATFORM', value: { enabled: false } });
      expect((await applyRows(commandId))[0]).toMatchObject({ stage: 'ACKED', service: 'core-svc', status: 'CHECKING', sent_at: null });

      clockTo(written + OUTBOX_WAIT_MS);
      await job.tickApplyCheck();
      expect((await applyRows(commandId))[0]!.status).toBe('CHECKING');
      clockTo(written + OUTBOX_WAIT_MS + 1);
      await job.tickApplyCheck();
      expect((await applyRows(commandId))[0]!.status).toBe('OUTBOX_WAITING');
      expect((await commandView(commandId)).delivery).toMatchObject({ kind: 'APPLY_CHECK', applyStatus: 'OUTBOX_WAITING' });

      // 30초는 나간 시각부터다(M5): 쓴 때부터 45초가 지나도 나가지 않았으면 OUTBOX_WAITING이고 경보가 없다
      clockTo(written + WINDOW_MS + 15 * SEC);
      await job.tickApplyCheck();
      expect((await applyRows(commandId))[0]).toMatchObject({ status: 'OUTBOX_WAITING', alert_open: false });
      expect(await alertsOf(commandId)).toEqual([]);
      // 장애가 실제로 있었다: 그 행은 여전히 나가지 않았다
      const unsent = (await admin.query<{ n: number }>("select count(*)::int as n from outbox where sent_at is null and convert_from(payload, 'UTF8')::jsonb ->> 'commandId' = $1", [commandId])).rows[0]!.n;
      expect(unsent).toBe(1);

      docker(['unpause', kafkaId]);
      paused = false;
      const sent = await sentAtOf(commandId, 90_000);
      expect(sent).toBeGreaterThanOrEqual(written + WINDOW_MS + 15 * SEC);
      const rec = await recordOf(commandId, 60_000);
      expect(rec.key).toBe('PLATFORM:FEATURE_FLAG:reviews');

      // 나간 직후: 아직 받은 파드가 없어도 나간 때부터 30초가 안 됐으니 CHECKING이다(쓴 때부터 세면 UNCONFIRMED가 된다)
      clockTo(sent);
      await job.tickApplyCheck();
      expect((await applyRows(commandId))[0]).toMatchObject({ status: 'CHECKING', alert_open: false });
      expect((await applyRows(commandId))[0]!.sent_at?.getTime()).toBe(sent);

      expect(c1.receive(rec)).toBe(true);
      expect(c2.receive(rec)).toBe(true);
      clockTo(sent + OUTBOX_WAIT_MS);
      await job.tickApplyCheck();
      expect((await commandView(commandId)).delivery).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CONFIRMED', targetCount: 2, ackedCount: 2, unackedTargets: [] });
      expect(await alertsOf(commandId)).toEqual([]);
    } finally {
      if (paused) {
        docker(['unpause', kafkaId]);
        paused = false;
      }
    }
  }, 180_000);

  test('C-T54 ③ Prometheus에 닿지 못하면(연결 거절) 바퀴마다 UNKNOWN이고 나간 뒤 30초가 지나도 UNCONFIRMED·경보가 아니다', async () => {
    const t1 = new ReceiverPod('ticket-svc', 'ticket-svc-1');
    prometheus.up.set('ticket-svc', [t1]);
    // 닫은 가짜 서버의 주소: 연결이 거절된다
    const dead = new FakePrometheus();
    await dead.start();
    const deadUrl = dead.url;
    await dead.stop();
    const blind = checkerWith(new PrometheusSettingsProbe({ url: deadUrl }));
    const blindJob = jobWith(blind);

    const { commandId } = await issue('LOG_LEVEL', { service: 'ticket-svc', level: 'TRACE' });
    const sent = await sentAtOf(commandId);
    // 파드는 받지 않았다(닿았다면 UNCONFIRMED가 될 상황이다)
    const statuses: string[] = [];
    for (let at = sent + OUTBOX_WAIT_MS; at <= sent + WINDOW_MS + 10 * SEC; at += OUTBOX_WAIT_MS) {
      clockTo(at);
      await blindJob.tickApplyCheck();
      statuses.push((await applyRows(commandId))[0]!.status);
    }
    // 장애가 실제로 있었다: 30초 앞뒤 바퀴 여덟 번이 모두 UNKNOWN이었다
    expect(statuses).toEqual(Array.from({ length: 8 }, () => 'UNKNOWN'));
    expect((await applyRows(commandId))[0]).toMatchObject({ alert_open: false });
    expect(await alertsOf(commandId)).toEqual([]);
    expect((await commandView(commandId)).delivery).toMatchObject({ kind: 'APPLY_CHECK', applyStatus: 'UNKNOWN' });
  }, 90_000);
});

describe('[ASVS v5.0.0-2.3.3] 설정 사건 Outbox 쓰기가 실패하면 상태·사건·감사·적용 확인 행이 모두 남지 않는다(실제 PostgreSQL)', () => {
  const failOutbox = async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION f025_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'f025 outbox down'; END $$`);
    await admin.query('CREATE TRIGGER f025_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION f025_fail_outbox()');
  };
  const healOutbox = () => admin.query('DROP TRIGGER IF EXISTS f025_fail_outbox ON outbox');

  test('[ASVS v5.0.0-2.3.3] ② 실행: 명령 8의 Outbox 쓰기가 실패하면 ACKED·사건·COMMAND_ACKED 감사·적용 확인 행·Outbox가 모두 없고 명령은 FAILED다', async () => {
    await failOutbox();
    let commandId: string;
    try {
      const r = await post('/v1/ops/commands', identity.ops('operator'), { type: 'LOG_LEVEL', reason: 'F-02-5 2.3.3 실행', params: { service: 'core-svc', level: 'TRACE' } });
      if (r.statusCode === 201) {
        commandId = (JSON.parse(r.payload) as { commandId: string }).commandId;
      } else {
        expect(r.statusCode).toBeGreaterThanOrEqual(500);
        const ids = (await admin.query<{ id: string }>("select id::text as id from ops_command where type = 'LOG_LEVEL' and reason = 'F-02-5 2.3.3 실행'")).rows.map((x) => x.id);
        expect(ids).toHaveLength(1);
        commandId = ids[0]!;
      }
    } finally {
      await healOutbox();
    }
    expect(await stateOf(commandId)).toBe('FAILED');
    expect(await eventsOf(commandId)).not.toContain('ACKED');
    const audits = await auditsOf(commandId);
    expect(audits).not.toContain('COMMAND_ACKED');
    expect(audits).toContain('COMMAND_EXECUTION_FAILED');
    expect(await applyRows(commandId)).toEqual([]);
    expect(await outboxOf(commandId)).toEqual([]);
    const view = await commandView(commandId);
    expect(view.state).toBe('FAILED');
    expect(view.lastError).toEqual(expect.any(String));
    expect(view.lastError).not.toBe('target-not-wired');
  });

  test('[ASVS v5.0.0-2.3.3] ③ 되돌리기: 명령 9 되돌리기의 Outbox 쓰기가 실패하면 REVERTED·사건·감사·새 적용 확인 행·새 Outbox가 없고, 트리거를 거두면 같은 되돌리기가 {enabled: true} 사건과 함께 된다', async () => {
    const { commandId, state } = await issue('FEATURE_OFF', { flag: 'reviews' });
    expect(state).toBe('ACKED');
    expect(await outboxOf(commandId)).toHaveLength(1);
    expect(await applyRows(commandId)).toHaveLength(1);
    clock.advance(2 * SEC);
    await failOutbox();
    const failed = await post(`/v1/ops/commands/${commandId}/reversions`, identity.ops('operator'), { reason: 'F-02-5 2.3.3 되돌리기' }).finally(healOutbox);
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(await stateOf(commandId)).toBe('ACKED');
    expect(await eventsOf(commandId)).not.toContain('REVERTED');
    expect(await auditsOf(commandId)).not.toContain('COMMAND_REVERTED');
    expect(await outboxOf(commandId)).toHaveLength(1);
    expect((await applyRows(commandId)).map((r) => r.stage)).toEqual(['ACKED']);

    // 트리거를 거두면 같은 되돌리기가 된다(시험이 비어 통과하지 않음을 본다)
    clock.advance(SEC);
    const ok = await post(`/v1/ops/commands/${commandId}/reversions`, identity.ops('operator'), { reason: 'F-02-5 2.3.3 되돌리기' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(await stateOf(commandId)).toBe('REVERTED');
    expect(await auditsOf(commandId)).toContain('COMMAND_REVERTED');
    const rows = await outboxOf(commandId);
    expect(rows).toHaveLength(2);
    expect(controlEventCodec.setting(Buffer.from(rows[1]!.payload))).toMatchObject({ commandId, key: 'FEATURE_FLAG', scope: 'PLATFORM', value: { enabled: true }, expiresAt: null });
    expect((await applyRows(commandId)).map((r) => r.stage)).toEqual(['ACKED', 'REVERTED']);
  });

  test('[ASVS v5.0.0-2.3.3] ④ 만료: 명령 8 만료(정비 바퀴)의 Outbox 쓰기가 실패하면 AUTO_EXPIRED·사건·감사·새 적용 확인 행·새 Outbox가 없고, 트리거를 거두면 {level: INFO} 사건과 함께 만료된다', async () => {
    const maintain = svc.app.get(MaintainCommands);
    // 앞 시험들의 명령 8을 모두 먼저 만료시킨다(이 시험의 명령만 정비 바퀴의 대상이 되게)
    clock.advance(LOG_LEVEL_TTL_MS + MIN);
    await maintain.runOnce(clock.now());
    const { commandId, state } = await issue('LOG_LEVEL', { service: 'queue-svc', level: 'TRACE' });
    expect(state).toBe('ACKED');
    const [first] = await outboxOf(commandId);
    const version = controlEventCodec.setting(Buffer.from(first!.payload)).occurredAt;
    const expiresAt = (await admin.query<{ expires_at: Date }>('select expires_at from ops_command where id = $1', [commandId])).rows[0]!.expires_at.getTime();
    expect(expiresAt).toBe(clock.now() + LOG_LEVEL_TTL_MS);

    // 만료 1ms 전에는 만료하지 않는다(B3)
    clockTo(expiresAt - 1);
    await maintain.runOnce(clock.now());
    expect(await stateOf(commandId)).toBe('ACKED');
    expect(await outboxOf(commandId)).toHaveLength(1);

    clockTo(expiresAt);
    await failOutbox();
    try {
      await maintain.runOnce(clock.now());
    } finally {
      await healOutbox();
    }
    expect(await stateOf(commandId)).toBe('ACKED');
    expect(await eventsOf(commandId)).not.toContain('AUTO_EXPIRED');
    expect(await auditsOf(commandId)).not.toContain('COMMAND_AUTO_EXPIRED');
    expect(await outboxOf(commandId)).toHaveLength(1);
    expect((await applyRows(commandId)).map((r) => r.stage)).toEqual(['ACKED']);

    // 트리거를 거두면 다음 바퀴에 만료되고, 새 판의 {level: INFO}(만료 없음) 사건과 적용 확인 행이 함께 남는다
    await maintain.runOnce(clock.now());
    expect(await stateOf(commandId)).toBe('AUTO_EXPIRED');
    expect(await auditsOf(commandId)).toContain('COMMAND_AUTO_EXPIRED');
    const rows = await outboxOf(commandId);
    expect(rows).toHaveLength(2);
    const expired = controlEventCodec.setting(Buffer.from(rows[1]!.payload));
    expect(expired).toMatchObject({ commandId, key: 'LOG_LEVEL', scope: 'PLATFORM', value: { level: 'INFO' }, expiresAt: null });
    expect(rows[1]!.msg_key).toBe('PLATFORM:LOG_LEVEL:queue-svc');
    expect(expired.occurredAt).toBeGreaterThan(version);
    const stages = await applyRows(commandId);
    expect(stages.map((r) => r.stage)).toEqual(['ACKED', 'AUTO_EXPIRED']);
    expect(stages[1]!.version).toBe(String(expired.occurredAt));
  });
});
