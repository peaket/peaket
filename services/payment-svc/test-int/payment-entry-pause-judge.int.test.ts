// 새 결제 진입 정지 판정자(BUILD_ORDER PRF-202, P-T43)를 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터(buildSimulatorApp)로 돈다. Kafka 모듈은 불러오지 않는다.
// 정본: docs/features/payment.md §2 '정지 판정자의 첫 구현'·§9·P-T43, ADR-0105·0250, docs/data.md `payment_entry_pause`, docs/security/asvs/payment.md.
// 약속: 시계는 가짜(멈춰 있다)이고 값은 줄였다(창 3초, 표본 3건, 10분 예외 10초). 틱은 손으로 돈다. 클러스터 입력은 대역(재시도 큐 시험만 실제 어댑터에 가짜 HTTP).
// 실제 11분 멈춤은 Game Day G-05의 몫이다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  BreakerPgCircuits,
  CachedEntryPauseReader,
  CachedPgSelectionReader,
  channelTableOf,
  type ClusterPauseReading,
  deleteExpiredEntryTrials,
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePgSelection,
  DrizzlePgSelectionBatch,
  ENTRY_PAUSE_CACHE_TTL_MS,
  ENTRY_PAUSE_JUDGE_DEFAULTS,
  ENTRY_TRIAL_RETENTION_MS,
  EntryPauseJudge,
  type EntryPauseClusterInputs,
  type EntryPauseJudgeConfig,
  type EntryPauseStore,
  entryPauseLog,
  EntryPauseReleaseWatcher,
  GetNewPaymentPause,
  PaymentConfirmRunner,
  paymentCheckoutLog,
  paymentConfirmLog,
  PgCallGuards,
  pgCallGuardLog,
  PrepareCheckout,
  PrometheusEntryPauseInputs,
  PromEntryPauseSignals,
  PromPaymentCheckoutSignals,
  PromPaymentConfirmSignals,
  PromPgCallGuardSignals,
  ReleaseEntryPause,
  StaticPaymentGateways,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, newId, startGrpcStack, tossConfirm, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const SHORT: Partial<EntryPauseJudgeConfig> = { probeWindowMs: 3_000, probeIntervalMs: 1_000, trialSampleSize: 3, trialFailureLimit: 2, trialMaxMs: 10_000, channelOpenHoldMs: 5_000, channelStartWaitSeconds: 0.001, channelOpenWaitSeconds: 0.001 };
const CONFIG: EntryPauseJudgeConfig = { ...ENTRY_PAUSE_JUDGE_DEFAULTS, ...SHORT };

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let app: SimulatorApp;
let simUrl: string;
let simKey: string;
let stacked: Promise<GrpcStack> | undefined;

const control = (method: string, path: string, body?: unknown) =>
  fetch(`${simUrl}${path}`, { method, headers: { authorization: `Basic ${Buffer.from(`${simKey}:`).toString('base64')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-judge-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 16, applicationName: 'payment-judge-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-judge-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 16, applicationName: 'payment-judge-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);
  simKey = `sim_sk_${randomBytes(16).toString('hex')}`;
  app = buildSimulatorApp({ secretKey: simKey, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  simUrl = await app.listen({ host: '127.0.0.1', port: 0 });
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job, payment_entry_pause, payment_entry_trial');
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));

interface FakeInputs extends EntryPauseClusterInputs {
  reading: ClusterPauseReading | undefined;
  p99: number | undefined;
  p99Samples: number;
  readonly windows: (number | undefined)[];
}

async function rig(o: { inputs?: EntryPauseClusterInputs; store?: EntryPauseStore } = {}) {
  const s = await stack();
  const logs: string[] = [];
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: s.clock, level: 'info', destination });
  const metrics = new PlatformMetrics('payment-svc');
  const gateway = new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: simKey, clientKey: 'sim_ck_test_client' });
  const gateways = new StaticPaymentGateways([gateway]);
  const circuits = new BreakerPgCircuits({ service: 'payment-svc', registry: metrics.registry, logger, clock: s.clock, overrides: { minCalls: 10, failureRatePercent: 50, openMs: 200 } }).register(metrics.registry);
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: s.clock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger), circuits });
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
  const store = new DrizzleEntryPause({ database: hot });
  const judgeStore = o.store ?? new DrizzleEntryPause({ database: batch });
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const releaseWatcher = new EntryPauseReleaseWatcher({ closeCircuit: (pg) => guards.of(pg)?.closeCircuit() });
  const pauses = new CachedEntryPauseReader({ reader: store, clock: s.clock, signals: checkoutSignals, onLoaded: (rows) => releaseWatcher.observe(rows) });
  const signals = new PromEntryPauseSignals().register(metrics.registry, pauses);
  const silent = { setInterval: () => 0, clearInterval: () => undefined };
  const runner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: s.clock, podId: 'pod-judge', timer: silent, trialResults: new DrizzleEntryPause({ database: runnerDb }), pauses, trialSignals: signals });
  const fake: FakeInputs = {
    reading: { openPods: 0, readyPods: 4, sampledAtMs: 0 },
    p99: undefined,
    p99Samples: 1_000,
    windows: [],
    async read(_pg, q) {
      fake.windows.push(q.p99WindowMs);
      if (fake.reading === undefined) return undefined;
      return { ...fake.reading, sampledAtMs: s.clock.now(), ...(q.p99WindowMs !== undefined && fake.p99 !== undefined ? { p99Seconds: fake.p99, p99Samples: fake.p99Samples } : {}) };
    },
  };
  const log = entryPauseLog(logger);
  const judge = new EntryPauseJudge({ store: judgeStore, inputs: o.inputs ?? fake, gateways, guards, leader: { isLeader: () => true }, podCount: 1, clock: s.clock, signals, log, timer: silent, config: SHORT });
  const defaults = { primary: 'SIMULATOR' } as const;
  const channels = channelTableOf(gateways);
  const prepare = new PrepareCheckout({ selection: new CachedPgSelectionReader({ reader: new DrizzlePgSelection({ database: hot }), clock: s.clock }), pauses, trials: store, drawEntryTrial: () => 0, trialSignals: signals, gateways, channels, defaults, webOrigin: 'https://www.it.example', virtualAccountReady: true, clock: s.clock, log: paymentCheckoutLog(logger), signals: checkoutSignals });
  const release = new ReleaseEntryPause({ store: judgeStore, clock: s.clock, log, signals });
  const getPause = new GetNewPaymentPause({ selection: new DrizzlePgSelectionBatch({ database: batch }), pauses, channels, defaults });
  const tick = async (): Promise<void> => {
    await judge.tick();
    await judge.whenIdle();
  };
  return { s, logs, circuits, runner, jobs, judge, tick, prepare, release, getPause, fake, store, pauses, metrics: () => metrics.registry.metrics() };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const stateOf = async (pg = 'SIMULATOR') => {
  const { rows } = await admin.pool.query<{ stage: string; reason: string; actor: string; since: Date; trial_started_at: Date | null; reopened_at: Date | null; version: string }>(`select stage, reason, actor, since, trial_started_at, reopened_at, version from payment_entry_pause where pg = $1 and channel = 'ALL'`, [pg]);
  return rows[0];
};
const trialOf = async (orderId: string) => (await admin.pool.query<{ first_result: string | null; first_call_ms: number | null; first_call_at: Date | null; admitted_at: Date }>(`select first_result, first_call_ms, first_call_at, admitted_at from payment_entry_trial where order_id = $1`, [orderId])).rows[0];
const approvals = async (orderId: string): Promise<number> =>
  (await (await control('GET', '/sim/ledger')).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { order_ref: string })
    .filter((r) => r.order_ref === orderId).length;
const counter = (text: string, line: string): number => Number(text.split('\n').find((l) => l.startsWith(line))?.split(' ').at(-1) ?? 0);

/** 판정 틱 n번, 틱마다 clock을 1초 민다 */
async function ticks(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await r.tick();
    r.s.clock.advance(CONFIG.probeIntervalMs);
  }
}

/** 파드 절반 이상의 서킷 열림으로 정지시킨 뒤 입력을 돌려 놓고 창을 채워 시험 재개로 보낸다 */
async function toTrial(r: Rig): Promise<void> {
  r.fake.reading = { openPods: 4, readyPods: 4, sampledAtMs: 0 };
  await r.tick();
  expect((await stateOf())?.stage).toBe('PROBING');
  r.fake.reading = { openPods: 0, readyPods: 4, sampledAtMs: 0 };
  await ticks(r, 5);
  expect((await stateOf())?.stage).toBe('TRIAL');
  r.s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
}

const checkoutOf = (orderId = newId(), eventId = newId()) => ({ orderKind: 'TICKET', orderId, attemptId: newId(), eventId, amount: 39_000, orderName: '통합 공연 티켓', payMethod: 'CARD' });

/** 시뮬레이터 인증 뒤 승인 명령을 접수한다 */
async function acceptOrder(r: Rig, orderId = newId()): Promise<string> {
  const reply = await control('POST', '/sim/authenticate', { orderId, amount: 39_000, orderName: '공연 티켓' });
  expect(reply.status).toBe(200);
  const paymentKey = ((await reply.json()) as { paymentKey: string }).paymentKey;
  await unary(r.s.client, 'ConfirmPayment', tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount: 39_000, authenticatedAtMs: r.s.clock.now() - 1_000 }).request);
  return orderId;
}

/** 시험 재개로 받고 승인 명령을 접수한다 */
async function admitted(r: Rig): Promise<{ orderId: string }> {
  const orderId = newId();
  await r.prepare.execute(checkoutOf(orderId));
  await acceptOrder(r, orderId);
  return { orderId };
}

async function drive(r: Rig): Promise<void> {
  await r.runner.tick();
  await r.runner.whenIdle();
}

/** 이 파드의 서킷을 연다(승인 실패 10건, 최소 호출 수와 같다) */
async function openCircuit(r: Rig): Promise<void> {
  const circuit = r.circuits.of('SIMULATOR');
  for (let i = 0; i < 10; i += 1) await circuit.run(async () => Promise.reject(new Error('장애')), () => false, 'confirm').catch(() => undefined);
  expect(circuit.state()).toBe('open');
}

/** 정지시킨 뒤 서킷이 열린 채로 사람이 푼다(파드는 푼 값을 아직 읽지 않았다) */
async function releasedWithOpenCircuit(r: Rig): Promise<void> {
  await r.pauses.read();
  r.fake.reading = { openPods: 4, readyPods: 4, sampledAtMs: 0 };
  await r.tick();
  expect((await stateOf())?.stage).toBe('PROBING');
  await openCircuit(r);
  await expect(r.release.execute({ pg: 'SIMULATOR', actor: 'commander-1', reason: '조회 경로만 고장' })).resolves.toEqual({ kind: 'RELEASED' });
}

describe('P-T43: 확인 호출과 시험 재개로 다시 열기', () => {
  test('P-T43_재시도 큐가 빈 뒤에도 확인 호출로 시험 재개에 가고, 첫 승인이 기준을 넘으면 모두 열리며, 시험 재개 동안 GetNewPaymentPause가 회차를 돌려준다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    r.fake.reading = { openPods: 2, readyPods: 4, sampledAtMs: 0 };
    await r.tick();
    const paused = await stateOf();
    expect(paused).toMatchObject({ stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM', version: '1' });
    expect(paused?.trial_started_at).toBeNull();
    const eventId = newId();
    r.s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    expect(await r.getPause.execute([eventId])).toEqual([{ eventId, pausedSinceMs: paused!.since.getTime() }]);

    // 재시도 큐에 아무것도 없다(큐가 빈 뒤의 상태). 입력이 회복되어도 창이 차기 전에는 시험 재개로 가지 않는다
    expect((await admin.pool.query('select 1 from payment_confirm_job')).rows).toEqual([]);
    r.fake.reading = { openPods: 0, readyPods: 4, sampledAtMs: 0 };
    await ticks(r, 3);
    expect((await stateOf())?.stage).toBe('PROBING');
    await ticks(r, 2);
    expect((await stateOf())?.stage).toBe('TRIAL');
    expect((await stateOf())?.trial_started_at).not.toBeNull();
    expect(counter(await r.metrics(), 'payment_pg_probe_total{pg="SIMULATOR",outcome="ok"}')).toBeGreaterThanOrEqual(3);
    expect(await r.metrics()).toMatch(/payment_new_entry_pause_stage\{pg="SIMULATOR"\} 2/);

    // 시험 재개 동안 그 회차를 계속 돌려준다
    r.s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    expect((await r.getPause.execute([eventId])).map((p) => p.eventId)).toEqual([eventId]);

    const first = await admitted(r);
    await drive(r);
    expect(await trialOf(first.orderId)).toMatchObject({ first_result: 'APPROVED' });
    await admitted(r);
    await drive(r);
    await r.tick();
    expect((await stateOf())?.stage).toBe('TRIAL');
    await admitted(r);
    await drive(r);
    await r.tick();

    const opened = await stateOf();
    expect(opened).toMatchObject({ stage: 'OPEN', actor: 'SYSTEM' });
    expect(opened?.reopened_at?.getTime()).toBe(r.s.clock.now());
    expect(opened?.since.getTime()).toBe(paused!.since.getTime());
    expect(opened?.trial_started_at).toBeNull();
    r.s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    expect(await r.getPause.execute([eventId])).toEqual([]);
    const text = await r.metrics();
    expect(counter(text, 'payment_entry_trial_total{pg="SIMULATOR",outcome="admitted"}')).toBe(3);
    expect(counter(text, 'payment_entry_trial_total{pg="SIMULATOR",outcome="success"}')).toBe(3);
    expect(text).toMatch(/payment_new_entry_pause_stage\{pg="SIMULATOR"\} 0/);
    expect(r.logs.join('\n')).toContain('payment-entry-pause-transition');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_① 조회만 살고 승인이 실패하면 시험 재개에서 정지로 돌아가고 시험 결제의 과금은 0원이다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    await toTrial(r);
    expect((await control('POST', '/sim/faults', { op: 'confirm', kind: 'pg-error', applied: false })).status).toBe(204);
    const a = await admitted(r);
    const b = await admitted(r);
    await drive(r);
    expect(await trialOf(a.orderId)).toMatchObject({ first_result: 'FAILED' });
    expect(await trialOf(b.orderId)).toMatchObject({ first_result: 'FAILED' });
    await r.tick();
    const row = await stateOf();
    expect(row?.stage).toBe('PROBING');
    expect(row?.trial_started_at).toBeNull();
    expect(await approvals(a.orderId)).toBe(0);
    expect(await approvals(b.orderId)).toBe(0);
    expect(counter(await r.metrics(), 'payment_entry_trial_total{pg="SIMULATOR",outcome="failure"}')).toBe(2);
    // 돌아간 뒤에는 창을 다시 채운다(같은 틱에 다시 시험 재개로 가지 않는다)
    r.s.clock.advance(1_000);
    await r.tick();
    expect((await stateOf())?.stage).toBe('PROBING');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_재시도 큐 건의 결과는 시험 재개에 세지 않는다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = await rig();
    await toTrial(r);
    const a = await admitted(r);
    // 때를 넘겨 잡히면 queued_at이 남아 재시도 큐 건이다(BUILD_ORDER PRF-200)
    r.s.clock.advance(2_000);
    await drive(r);
    expect(await trialOf(a.orderId)).toMatchObject({ first_result: null });
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_캐시가 열림으로 보는 동안에는 시험 행을 쓰지 않는다(핫패스에 문장을 더하지 않는다) [ASVS v5.0.0-2.3.2]', async () => {
    const r = await rig();
    const orderId = newId();
    await admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at) values ($1, 'SIMULATOR', $2)`, [orderId, new Date(r.s.clock.now())]);
    await acceptOrder(r, orderId);
    await drive(r);
    expect(await trialOf(orderId)).toMatchObject({ first_result: null, first_call_at: null });
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 H4: 승인 실행기가 첫 호출을 시작할 때 first_call_at을 쓴다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    await toTrial(r);
    const a = await admitted(r);
    await drive(r);
    const row = await trialOf(a.orderId);
    expect(row?.first_result).toBe('APPROVED');
    expect(row?.first_call_at?.getTime()).toBe(r.s.clock.now());
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 H4: ①의 변형: 먼저 시작한 느린 호출이 표본에서 빠지지 않아 뒤의 빠른 결과만으로 열리지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    await toTrial(r);
    const startedAt = (await stateOf())!.trial_started_at!.getTime();
    const put = (callAt: number, resultAt: number | null) =>
      admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at, first_call_at, first_result, first_result_at, first_call_ms) values ($1, 'SIMULATOR', $2, $3, $4, $5, $6)`, [newId(), new Date(startedAt), new Date(callAt), resultAt === null ? null : 'APPROVED', resultAt === null ? null : new Date(resultAt), resultAt === null ? null : 10]);
    // 다섯 건 가운데 한 건(20%)이 먼저 시작했고 답이 없다. 뒤의 네 건은 바로 끝났다
    await put(startedAt + 1, null);
    for (let i = 2; i <= 5; i += 1) await put(startedAt + i, startedAt + i + 1);
    // 5초가 지나기 전에는 판정을 미룬다(결과가 먼저 난 순서로 세면 여기서 열린다)
    await r.tick();
    expect((await stateOf())?.stage).toBe('TRIAL');
    r.s.clock.advance(5_000);
    await r.tick();
    expect((await stateOf())?.stage).toBe('PROBING');
    r.circuits.shutdown();
  }, 30_000);
});

describe('P-T43: commander 해제', () => {
  test('P-T43_② 확인 호출이 막힌 채 해제하면 바로 열리고 actor가 남으며, 이어지는 실패에는 연 뒤 표본으로 다시 멈춘다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    expect((await control('POST', '/sim/faults', { op: 'query', kind: 'pg-error', applied: false })).status).toBe(204);
    r.fake.reading = { openPods: 4, readyPods: 4, sampledAtMs: 0 };
    await r.tick();
    r.fake.reading = { openPods: 0, readyPods: 4, sampledAtMs: 0 };
    await ticks(r, 6);
    expect((await stateOf())?.stage).toBe('PROBING');
    expect(counter(await r.metrics(), 'payment_pg_probe_total{pg="SIMULATOR",outcome="fail"}')).toBeGreaterThanOrEqual(5);

    await expect(r.release.execute({ pg: 'SIMULATOR', actor: 'commander-1', reason: '확인 호출 경로 고장' })).resolves.toEqual({ kind: 'RELEASED' });
    const opened = await stateOf();
    expect(opened).toMatchObject({ stage: 'OPEN', actor: 'commander-1' });
    expect(opened?.reopened_at?.getTime()).toBe(r.s.clock.now());
    expect(r.logs.join('\n')).not.toContain('확인 호출 경로 고장');
    expect(await r.release.execute({ pg: 'SIMULATOR', actor: 'commander-1', reason: '다시 보냄' })).toEqual({ kind: 'ALREADY_OPEN' });

    // 연 직후의 p99는 표본 없음이다(연 시각 뒤의 표본만 본다)
    r.fake.p99 = 9;
    r.fake.windows.length = 0;
    await r.tick();
    expect(r.fake.windows).toEqual([undefined]);
    expect((await stateOf())?.stage).toBe('OPEN');
    // 표본이 쌓이면 연 시각 뒤의 창으로 보고 다시 멈춘다
    r.s.clock.advance(15_000);
    await r.tick();
    expect(r.fake.windows.at(-1)).toBe(15_000);
    const repaused = await stateOf();
    expect(repaused).toMatchObject({ stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM' });
    expect(repaused?.since.getTime()).toBe(r.s.clock.now());
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 M5: 조회 경로만 고장이면 사람이 풀 때 서킷을 닫아 승인이 나가고, 늦은 지표로 곧바로 되돌려지지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    expect((await control('POST', '/sim/faults', { op: 'query', kind: 'pg-error', applied: false })).status).toBe(204);
    await releasedWithOpenCircuit(r);
    // 서킷 지표는 아직 열림이지만(긁기 지연) 15초 동안 시작 조건으로 보지 않는다
    await r.tick();
    expect(await stateOf()).toMatchObject({ stage: 'OPEN', actor: 'commander-1' });
    r.s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    await r.pauses.read();
    expect(r.circuits.of('SIMULATOR').state()).toBe('closed');
    const orderId = await acceptOrder(r);
    await drive(r);
    expect(await approvals(orderId)).toBe(1);
    // 지표가 따라잡으면 조회만 고장인 채로도 열린 채 남는다
    r.fake.reading = { openPods: 0, readyPods: 4, sampledAtMs: 0 };
    r.s.clock.advance(15_000);
    await r.tick();
    expect(await stateOf()).toMatchObject({ stage: 'OPEN', actor: 'commander-1' });
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 M5: 해제 뒤 승인이 계속 실패하면 서킷이 다시 열려 15초가 지난 뒤 다시 멈춘다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    await releasedWithOpenCircuit(r);
    r.s.clock.advance(ENTRY_PAUSE_CACHE_TTL_MS);
    await r.pauses.read();
    expect(r.circuits.of('SIMULATOR').state()).toBe('closed');
    await openCircuit(r);
    r.s.clock.advance(13_000);
    await r.tick();
    expect((await stateOf())?.stage).toBe('OPEN');
    r.s.clock.advance(1_000);
    await r.tick();
    expect(await stateOf()).toMatchObject({ stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM' });
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 M5: 파드가 새로 떴을 때는 오래된 해제로 서킷을 닫지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    await admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, reopened_at, version) values ('SIMULATOR', 'ALL', 'OPEN', 'PG_FAILURE', 'commander-1', now(), now(), 5)`);
    await openCircuit(r);
    await r.pauses.read();
    expect(r.circuits.of('SIMULATOR').state()).toBe('open');
    r.circuits.shutdown();
  }, 30_000);
});

describe('P-T43: 채널 상한 대기', () => {
  test('P-T43_③ 예상 대기가 넘으면 멈추고, 대기가 줄어 1분(줄인 값) 이어지면 열리며 확인 호출은 나가지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    await acceptOrder(r);
    await r.tick();
    expect(await stateOf()).toMatchObject({ stage: 'PROBING', reason: 'CHANNEL_WAIT' });

    await drive(r);
    await r.tick();
    expect((await stateOf())?.stage).toBe('PROBING');
    r.s.clock.advance(5_000);
    await r.tick();
    expect(await stateOf()).toMatchObject({ stage: 'OPEN', actor: 'SYSTEM' });
    const text = await r.metrics();
    for (const outcome of ['ok', 'fail']) expect(counter(text, `payment_pg_probe_total{pg="SIMULATOR",outcome="${outcome}"}`)).toBe(0);
    r.circuits.shutdown();
  }, 30_000);
});

describe('P-T43: 옛 판정자와 입력', () => {
  test('P-T43_④ 옛 판정자의 늦은 쓰기는 판 번호로 거절된다 [ASVS v5.0.0-16.5.3]', async () => {
    const real = new DrizzleEntryPause({ database: hot });
    await admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('SIMULATOR', 'ALL', 'OPEN', 'PG_FAILURE', 'SYSTEM', now(), 5)`);
    // 판정자가 읽은 뒤 다른 쪽(새 판정자·commander)이 먼저 쓴다
    const racing: EntryPauseStore = {
      readRecord: async (pg) => {
        const row = await real.readRecord(pg);
        await admin.pool.query(`update payment_entry_pause set version = version + 1 where pg = 'SIMULATOR'`);
        return row;
      },
      write: (previous, next) => real.write(previous, next),
      readTrialResults: (pg, startedAt, limit) => real.readTrialResults(pg, startedAt, limit),
      countWaitingConfirms: (pg, nowMs, cap) => real.countWaitingConfirms(pg, nowMs, cap),
    };
    const r = await rig({ store: racing });
    r.fake.reading = { openPods: 4, readyPods: 4, sampledAtMs: 0 };
    await r.tick();
    expect(await stateOf()).toMatchObject({ stage: 'OPEN', version: '6' });
    expect(counter(await r.metrics(), 'payment_entry_pause_write_conflicts_total{pg="SIMULATOR"}')).toBe(1);
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_틀린 구현: 정지 행 쓰기는 그 결제사 행만 바꾼다(한 결제사의 장애가 다른 결제사를 멈추지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    await admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ('SIMULATOR', 'ALL', 'OPEN', 'PG_FAILURE', 'SYSTEM', now(), 5), ('TOSS', 'ALL', 'OPEN', 'PG_FAILURE', 'SYSTEM', now(), 5)`);
    const previous = await r.store.readRecord('SIMULATOR');
    await expect(r.store.write(previous, { pg: 'SIMULATOR', stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM', sinceMs: r.s.clock.now() })).resolves.toBe(true);
    expect(await stateOf('SIMULATOR')).toMatchObject({ stage: 'PROBING', version: '6' });
    expect(await stateOf('TOSS')).toMatchObject({ stage: 'OPEN', version: '5' });
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_첫 정지를 둘이 겨루면 하나만 판 번호 1로 쓴다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    const next = { pg: 'SIMULATOR', stage: 'PROBING', reason: 'PG_FAILURE', actor: 'SYSTEM', sinceMs: r.s.clock.now() } as const;
    const results = await Promise.all([r.store.write(undefined, next), r.store.write(undefined, next)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await stateOf()).toMatchObject({ version: '1', stage: 'PROBING' });
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_재시도 큐 건의 긴 확정 소요는 시작 입력에 들어가지 않는다(PromQL이 direct만 묻는다) [ASVS v5.0.0-16.5.3]', async () => {
    const queries: string[] = [];
    const s = await stack();
    const ok = (value: string) => new Response(JSON.stringify({ status: 'success', data: { result: [{ metric: {}, value: [1, value] }] } }), { status: 200 });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const expr = url.searchParams.get('query') ?? '';
      queries.push(expr);
      if (expr.includes('histogram_quantile')) return expr.includes('path="direct"') ? new Response(JSON.stringify({ status: 'success', data: { result: [] } }), { status: 200 }) : ok('60');
      if (expr.startsWith('sum(')) return ok('0');
      if (expr.startsWith('count(')) return ok('4');
      return ok(String(s.clock.now() / 1000));
    }) as typeof fetch;
    const r = await rig({ inputs: new PrometheusEntryPauseInputs({ baseUrl: 'http://prometheus.test:9090', fetchImpl }) });
    await r.tick();
    expect((await stateOf())?.stage ?? 'OPEN').toBe('OPEN');
    expect(queries.filter((q) => q.includes('histogram_quantile'))).toHaveLength(1);
    expect(queries.find((q) => q.includes('histogram_quantile'))).toContain('path="direct"');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_입력이 낡으면 앞으로 가지 않고 뒤로는 간다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    await toTrial(r);
    r.fake.reading = undefined;
    await ticks(r, 5);
    expect((await stateOf())?.stage).toBe('TRIAL');
    expect((await control('POST', '/sim/faults', { op: 'confirm', kind: 'pg-error', applied: false })).status).toBe(204);
    await admitted(r);
    await admitted(r);
    await drive(r);
    await r.tick();
    expect((await stateOf())?.stage).toBe('PROBING');
    r.circuits.shutdown();
  }, 30_000);
});

describe('P-T43: 시험 행과 표', () => {
  test('P-T43_마이그레이션 0011: reopened_at 칸', async () => {
    const { rows } = await admin.pool.query<{ column_name: string; is_nullable: string }>(`select column_name, is_nullable from information_schema.columns where table_name = 'payment_entry_pause' and column_name = 'reopened_at'`);
    expect(rows).toEqual([{ column_name: 'reopened_at', is_nullable: 'YES' }]);
  });

  test('P-T43_리뷰 고침 H4: 마이그레이션 0011: first_call_at 칸', async () => {
    const { rows } = await admin.pool.query<{ data_type: string; is_nullable: string }>(`select data_type, is_nullable from information_schema.columns where table_name = 'payment_entry_trial' and column_name = 'first_call_at'`);
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
  });

  test('P-T43_받은 주문은 한 번만 적고, 앞 시험의 행은 이번 시험 값으로 덮어쓴다 [ASVS v5.0.0-2.3.2]', async () => {
    const r = await rig();
    await toTrial(r);
    const startedAt = (await stateOf())!.trial_started_at!;
    const stale = newId();
    await admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at, first_call_at, first_result, first_result_at, first_call_ms) values ($1, 'SIMULATOR', $2, $2, 'APPROVED', $2, 10)`, [stale, new Date(startedAt.getTime() - 60_000)]);
    await r.store.admit(stale, 'SIMULATOR', r.s.clock.now());
    const replaced = await trialOf(stale);
    expect(replaced?.first_result).toBeNull();
    expect(replaced?.first_call_at).toBeNull();
    expect(replaced?.admitted_at.getTime()).toBe(r.s.clock.now());
    await expect(r.store.isAdmitted(stale, 'SIMULATOR')).resolves.toBe(true);

    await admin.pool.query(`update payment_entry_trial set first_result = 'APPROVED', first_result_at = now(), first_call_ms = 1 where order_id = $1`, [stale]);
    await r.store.admit(stale, 'SIMULATOR', r.s.clock.now() + 1);
    expect((await trialOf(stale))?.first_result).toBe('APPROVED');
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_첫 결과는 한 번만 쓰이고 시험 행이 없으면 거짓이다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await rig();
    const orderId = newId();
    await r.store.admit(orderId, 'SIMULATOR', r.s.clock.now());
    await expect(r.store.recordFirstResult(orderId, { firstResult: 'APPROVED', atMs: r.s.clock.now(), callMs: 77 })).resolves.toBe(true);
    await expect(r.store.recordFirstResult(orderId, { firstResult: 'FAILED', atMs: r.s.clock.now(), callMs: 1 })).resolves.toBe(false);
    expect(await trialOf(orderId)).toMatchObject({ first_result: 'APPROVED', first_call_ms: 77 });
    await expect(r.store.recordFirstResult(newId(), { firstResult: 'FAILED', atMs: r.s.clock.now(), callMs: 1 })).resolves.toBe(false);
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_시험 행 읽기는 이번 시험에 호출을 시작한 행만 시작 순으로 표본 수까지다(결과가 없는 행도 읽는다)', async () => {
    const r = await rig();
    const base = r.s.clock.now();
    const put = (orderId: string, callAt: number | null, resultAt: number | null) =>
      admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at, first_call_at, first_result, first_result_at, first_call_ms) values ($1, 'SIMULATOR', $2, $3, $4, $5, $6)`, [orderId, new Date(base), callAt === null ? null : new Date(callAt), resultAt === null ? null : 'APPROVED', resultAt === null ? null : new Date(resultAt), resultAt === null ? null : 5]);
    await put(newId(), base - 1, base + 1);
    await put(newId(), null, null);
    await put(newId(), base + 3, base + 4);
    await put(newId(), base + 2, null);
    await put(newId(), base + 9, base + 10);
    await expect(r.store.readTrialResults('SIMULATOR', base, 2)).resolves.toEqual([{ firstCallAtMs: base + 2 }, { firstResult: 'APPROVED', firstCallMs: 5, firstCallAtMs: base + 3 }]);
    await expect(r.store.readTrialResults('SIMULATOR', base, 99)).resolves.toHaveLength(3);
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_리뷰 고침 H4: 시험 행은 호출을 시작한 순서로 앞 표본만 읽고(결과가 먼저 난 순서가 아니다) 다른 결제사의 행은 섞지 않는다', async () => {
    const r = await rig();
    const base = r.s.clock.now();
    const put = (pg: string, callAt: number, resultAt: number, callMs: number) =>
      admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at, first_call_at, first_result, first_result_at, first_call_ms) values ($1, $2, $3, $4, 'APPROVED', $5, $6)`, [newId(), pg, new Date(base), new Date(callAt), new Date(resultAt), callMs]);
    await put('SIMULATOR', base + 3, base + 4, 3);
    await put('SIMULATOR', base + 1, base + 30, 1);
    await put('SIMULATOR', base + 2, base + 20, 2);
    await put('TOSS', base, base, 99);
    await expect(r.store.readTrialResults('SIMULATOR', base, 2)).resolves.toEqual([{ firstResult: 'APPROVED', firstCallMs: 1, firstCallAtMs: base + 1 }, { firstResult: 'APPROVED', firstCallMs: 2, firstCallAtMs: base + 2 }]);
    await expect(r.store.readTrialResults('SIMULATOR', base, 99)).resolves.toHaveLength(3);
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_대기 건수는 때가 되고 임대되지 않은 명령만 세고 상한에서 멈춘다', async () => {
    const r = await rig();
    const before = r.s.clock.now();
    await acceptOrder(r);
    await acceptOrder(r);
    await acceptOrder(r);
    await expect(r.store.countWaitingConfirms('SIMULATOR', before, 100)).resolves.toBe(3);
    await expect(r.store.countWaitingConfirms('SIMULATOR', before, 2)).resolves.toBe(2);
    await expect(r.store.countWaitingConfirms('SIMULATOR', before - 1_000, 100)).resolves.toBe(0);
    await expect(r.store.countWaitingConfirms('TOSS', before, 100)).resolves.toBe(0);
    const claimed = await r.jobs.claimDue('SIMULATOR', 1, 'pod-a', 60_000);
    expect(claimed).toHaveLength(1);
    await expect(r.store.countWaitingConfirms('SIMULATOR', before, 100)).resolves.toBe(2);
    r.circuits.shutdown();
  }, 30_000);

  test('P-T43_7일이 지난 시험 행은 정비 일이 지우고 그 안의 행은 남긴다 [ASVS v5.0.0-14.2.7]', async () => {
    const s = await stack();
    const now = s.clock.now();
    const old = newId();
    const fresh = newId();
    await admin.pool.query(`insert into payment_entry_trial (order_id, pg, admitted_at) values ($1, 'TOSS', $2), ($3, 'TOSS', $4)`, [old, new Date(now - ENTRY_TRIAL_RETENTION_MS), fresh, new Date(now - ENTRY_TRIAL_RETENTION_MS + 1_000)]);
    const result = await deleteExpiredEntryTrials(admin, { clock: s.clock, ignoreWindow: true });
    expect(result.deleted).toBe(1);
    expect(await trialOf(old)).toBeUndefined();
    expect(await trialOf(fresh)).toBeDefined();
  }, 30_000);
});
