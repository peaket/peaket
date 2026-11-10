// 낮춘 결제사 채널 상한의 유지·전파·회복(BUILD_ORDER PRF-203)을 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp), 실제 저장소·실행기로 돈다.
// 정본: docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복'·P-T34·P-T43 ③, docs/data.md §2 ④ payment_channel_limit·§5, docs/verification.md §4.1.
//
// 약속:
// - Kafka 모듈을 불러오지 않는다. 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 표를 비운다.
// - '파드'는 보호기 등록부·표 맞추기·승인 실행기를 한 벌씩 따로 만든 것이다(같은 DB·같은 시뮬레이터). 시계는 모든 파드가 함께 쓰는 가짜 시계다(멈춰 있고 advance로만 간다).
// - 1초 맞추기 타이머는 손으로 부른다(등록된 간격이 1초 [가정]인지 본다).
// - 장애는 실제 DB에 넣는다: 읽기는 표 이름을 바꾸고, 쓰기는 검증하지 않는 CHECK로 막는다. 시험이 끝나면 되돌린다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePgChannelLimit,
  EntryPauseJudge,
  type EntryPauseJudgeConfig,
  entryPauseLog,
  PaymentConfirmRunner,
  paymentConfirmLog,
  PG_LIMIT_HOLD_MS,
  PG_LIMIT_SYNC_MS,
  PG_LOWER_COOLDOWN_MS,
  PgCallGuards,
  pgCallGuardLog,
  pgChannelLog,
  PgChannelLimitSync,
  PromEntryPauseSignals,
  PromPaymentConfirmSignals,
  PromPgCallGuardSignals,
  PromPgChannelSignals,
  StaticPaymentGateways,
} from '../src/modules/payment/server.js';
import type { PgChannelLimitRow } from '../src/modules/payment/domain/pg-channel-limit.js';
import type { PgChannelLimitStore } from '../src/modules/payment/domain/ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, startGrpcStack, tossConfirm, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-10T01:00:00.000Z');

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
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-limit-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-limit-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-limit-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-limit-it-runner' });
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
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job, payment_channel_limit, payment_entry_pause, payment_entry_trial');
  expect((await control('DELETE', '/sim/faults')).status).toBe(204);
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));

interface Pod {
  readonly name: string;
  readonly logs: string[];
  readonly guards: PgCallGuards;
  readonly sync: PgChannelLimitSync;
  readonly runner: PaymentConfirmRunner;
  /** 등록된 맞추기 간격(ms)과 그 콜백 */
  readonly interval: { ms?: number; fn?: () => void };
  metrics(): Promise<string>;
  limits(): { rps: number; concurrency: number };
}

/** 파드 한 벌. start()는 main.ts처럼 시작 때 한 번 읽은 뒤 1초 맞추기를 켠다 */
async function pod(name: string, o: { bulkhead?: number; writes?: (PgChannelLimitRow | undefined)[] } = {}): Promise<Pod> {
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
  const gateways = new StaticPaymentGateways([new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: simKey, clientKey: 'sim_ck_test_client' })]);
  let sync: PgChannelLimitSync | undefined;
  const guards = new PgCallGuards({
    gateways,
    podCount: 1,
    clock: s.clock,
    signals: new PromPgCallGuardSignals().register(metrics.registry),
    log: pgCallGuardLog(logger),
    share: { lowered: (e) => sync?.lowered(e) },
    ...(o.bulkhead === undefined ? {} : { bulkheads: { SIMULATOR: o.bulkhead } }),
  });
  const interval: { ms?: number; fn?: () => void } = {};
  const real = new DrizzlePgChannelLimit({ database: batch });
  // 쓰기 결과(쓴 행, 0행이면 undefined)를 센다(코드 리뷰 T4)
  const store: PgChannelLimitStore = {
    readAll: (b) => real.readAll(b),
    read: (pg) => real.read(pg),
    write: async (basis, next, nowMs) => {
      const row = await real.write(basis, next, nowMs);
      o.writes?.push(row);
      return row;
    },
  };
  sync = new PgChannelLimitSync({
    store,
    guards,
    clock: s.clock,
    signals: new PromPgChannelSignals().register(metrics.registry),
    log: pgChannelLog(logger, s.clock),
    timer: {
      setInterval: (fn, ms) => {
        interval.fn = fn;
        interval.ms = ms;
        return 1;
      },
      clearInterval: () => undefined,
    },
  });
  await sync.refresh();
  sync.start();
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
  const runner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: s.clock, podId: name, timer: { setInterval: () => 0, clearInterval: () => undefined } });
  return { name, logs, guards, sync, runner, interval, metrics: () => metrics.registry.metrics(), limits: () => guards.of('SIMULATOR')!.limits() };
}

/** 1초 맞추기 한 번(타이머가 부르는 콜백을 손으로 부르고 끝나기를 기다린다) */
async function syncTick(p: Pod): Promise<void> {
  expect(p.interval.ms).toBe(PG_LIMIT_SYNC_MS);
  p.interval.fn!();
  await p.sync.whenIdle();
}

async function accepted(): Promise<{ orderId: string }> {
  const s = await stack();
  const orderId = newId();
  const reply = await control('POST', '/sim/authenticate', { orderId, amount: 39_000, orderName: '공연 티켓' });
  expect(reply.status).toBe(200);
  const paymentKey = ((await reply.json()) as { paymentKey: string }).paymentKey;
  await unary(s.client, 'ConfirmPayment', tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount: 39_000, authenticatedAtMs: s.clock.now() - 1_000 }).request);
  return { orderId };
}

/** 첫 승인 호출에 429를 돌려줄 결제 하나를 그 파드가 부른다 */
async function throttledOn(p: Pod): Promise<{ orderId: string }> {
  const f = await accepted();
  expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'throttle' })).status).toBe(204);
  // 앞에서 429로 미룬 명령이 때가 됐으면 함께 잡힌다(그 명령의 장애는 이미 썼다)
  expect((await p.runner.tick()).claimed).toBeGreaterThanOrEqual(1);
  await p.runner.whenIdle();
  await p.sync.whenIdle();
  expect((await ledgerOf(admin, f.orderId)).payments[0]!.status).toBe('ACCEPTED');
  return f;
}

type LimitRow = { pg: string; channel: string; ratio_percent: number; lowered_at: Date; expires_at: Date; version: string; updated_at: Date };
const rows = async (): Promise<LimitRow[]> => (await admin.pool.query<LimitRow>('select * from payment_channel_limit order by pg')).rows;

function metricLine(text: string, name: string, labels: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(labels));
  return Number(line?.split(' ').at(-1) ?? 0);
}

const FULL = { rps: 300, concurrency: 600 };
const HALF = { rps: 150, concurrency: 300 };
const QUARTER = { rps: 75, concurrency: 150 };

describe('P-T34: 파드 사이 전파', () => {
  test('P-T34 한 파드의 첫 승인 호출 429가 표를 거쳐 1초 맞추기 한 번에 다른 파드의 상한을 낮춘다 [ASVS v5.0.0-13.2.6] [ASVS v5.0.0-15.1.3]', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    expect(b.limits()).toEqual(FULL);

    await throttledOn(a);

    expect(a.limits()).toEqual(HALF);
    expect(await rows()).toEqual([{ pg: 'SIMULATOR', channel: 'ALL', ratio_percent: 50, lowered_at: new Date(s.clock.now()), expires_at: new Date(s.clock.now() + PG_LIMIT_HOLD_MS), version: '1', updated_at: new Date(s.clock.now()) }]);
    expect(b.limits()).toEqual(FULL);

    await syncTick(b);

    expect(b.limits()).toEqual(HALF);
    expect(metricLine(await b.metrics(), 'payment_pg_limit_ratio', 'pg="SIMULATOR"')).toBe(50);
    expect(metricLine(await b.metrics(), 'payment_pg_limit', 'pg="SIMULATOR",kind="rps"')).toBe(150);
    // SEV2는 낮춘 파드 하나의 한 줄이다(표를 읽어 따른 파드는 내지 않는다)
    expect(a.logs.filter((l) => l.includes('pg-throttled-first'))).toHaveLength(1);
    expect(b.logs.filter((l) => l.includes('pg-throttled-first'))).toEqual([]);
  });

  test('P-T34 두 파드가 같은 때 첫 429를 받아도 표는 한 번만(판 1, 50%) 낮아지고 두 파드 모두 50%다(진 쪽 쓰기는 실제로 0행이다)', async () => {
    const writes: (PgChannelLimitRow | undefined)[] = [];
    const a = await pod('pod-a', { bulkhead: 1, writes });
    const b = await pod('pod-b', { bulkhead: 1, writes });
    const fs = [await accepted(), await accepted()];
    for (const f of fs) expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId: f.orderId, kind: 'throttle' })).status).toBe(204);

    const ticks = await Promise.all([a.runner.tick(), b.runner.tick()]);
    expect(ticks.map((t) => t.claimed)).toEqual([1, 1]);
    await Promise.all([a.runner.whenIdle(), b.runner.whenIdle()]);
    await Promise.all([a.sync.whenIdle(), b.sync.whenIdle()]);

    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[50, '1']]);
    // 두 파드가 모두 판 번호 1의 INSERT를 했고, 하나는 행을 썼고 다른 하나는 0행이었다(다시 읽어 이미 담긴 낮춤이라 더 쓰지 않았다)
    expect(writes).toHaveLength(2);
    expect(writes.filter((w) => w === undefined)).toHaveLength(1);
    expect(writes.find((w) => w !== undefined)).toMatchObject({ ratioPercent: 50, version: 1 });
    expect(a.limits().rps).toBe(150);
    expect(b.limits().rps).toBe(150);
    await Promise.all([syncTick(a), syncTick(b)]);
    expect(a.limits().rps).toBe(150);
    expect(b.limits().rps).toBe(150);
    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[50, '1']]);
    for (const p of [a, b]) expect(metricLine(await p.metrics(), 'payment_pg_limit_sync_failures_total', 'step="conflict"')).toBe(0);
  });

  test('P-T34 옛 판 번호를 조건으로 한 쓰기는 0행이고 행은 그대로다(판 번호 조건을 뺀 쓰기가 이기지 못한다)', async () => {
    const a = await pod('pod-a');
    const s = await stack();
    await throttledOn(a);
    const store = new DrizzlePgChannelLimit({ database: batch });
    const before = await rows();
    const stale = { pg: 'SIMULATOR' as const, ratioPercent: 50, loweredAtMs: s.clock.now() - 1, expiresAtMs: s.clock.now() + 1, version: 0 };
    await expect(store.write(stale, { pg: 'SIMULATOR', ratioPercent: 25, loweredAtMs: s.clock.now(), expiresAtMs: s.clock.now() + PG_LIMIT_HOLD_MS }, s.clock.now())).resolves.toBeUndefined();
    await expect(store.write(undefined, { pg: 'SIMULATOR', ratioPercent: 25, loweredAtMs: s.clock.now(), expiresAtMs: s.clock.now() + PG_LIMIT_HOLD_MS }, s.clock.now())).resolves.toBeUndefined();
    expect(await rows()).toEqual(before);
  });

  test('P-T34 다른 파드가 낮춘 뒤 5초 안의 첫 429는 다시 낮추지 않고, 5초가 되면 표를 25%(판 2)로 낮춘다', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    await throttledOn(a);
    const loweredAt = s.clock.now();
    await syncTick(b);

    s.clock.advance(PG_LOWER_COOLDOWN_MS - 1);
    await throttledOn(b);
    expect(b.limits()).toEqual(HALF);
    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[50, '1']]);
    expect(b.logs.filter((l) => l.includes('pg-throttled-first'))).toEqual([]);

    s.clock.advance(1);
    await throttledOn(b);
    expect(b.limits()).toEqual(QUARTER);
    const [r] = await rows();
    expect(r).toMatchObject({ ratio_percent: 25, version: '2', lowered_at: new Date(loweredAt + PG_LOWER_COOLDOWN_MS), expires_at: new Date(loweredAt + PG_LOWER_COOLDOWN_MS + PG_LIMIT_HOLD_MS) });
    await syncTick(a);
    expect(a.limits()).toEqual(QUARTER);
  });

  test('P-T34 다른 파드가 낮추기 전에 시작한 호출의 429는 쿨다운이 지나 와도 표를 낮추지 않는다', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    const startedBefore = s.clock.monotonicMs();
    s.clock.advance(1);
    await throttledOn(a);
    await syncTick(b);
    s.clock.advance(PG_LOWER_COOLDOWN_MS + 1_000);

    expect(b.guards.of('SIMULATOR')!.noteThrottled({ first: true, startedAtMs: startedBefore })).toBe(false);
    await b.sync.whenIdle();

    expect(b.limits()).toEqual(HALF);
    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[50, '1']]);
  });

  test('P-T34 파드를 다시 띄우면 시작 때 표를 읽어 낮춘 상한으로 이어 간다', async () => {
    const a = await pod('pod-a');
    await throttledOn(a);
    const restarted = await pod('pod-a-2');
    expect(restarted.limits()).toEqual(HALF);
    expect(metricLine(await restarted.metrics(), 'payment_pg_limit_ratio', 'pg="SIMULATOR"')).toBe(50);
  });
});

describe('P-T34: 만료와 장애', () => {
  test('P-T34 만료 1ms 전에는 두 파드 모두 낮춘 값이고 만료 시각에 처음 상한으로 돌아가며 회복 로그는 파드마다 한 줄이다', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    await throttledOn(a);
    await syncTick(b);

    s.clock.advance(PG_LIMIT_HOLD_MS - 1);
    await syncTick(b);
    expect(a.limits()).toEqual(HALF);
    expect(b.limits()).toEqual(HALF);

    s.clock.advance(1);
    await syncTick(b);
    expect(a.limits()).toEqual(FULL);
    expect(b.limits()).toEqual(FULL);
    for (const p of [a, b]) {
      const restored = p.logs.filter((l) => l.includes('pg-limit-restored'));
      expect(restored).toHaveLength(1);
      expect(JSON.parse(restored[0]!)).toMatchObject({ level: 'info', pg: 'SIMULATOR', rps: 300, concurrency: 600 });
    }
    // 만료된 행은 지우지 않고 무시한다
    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[50, '1']]);
  });

  test('P-T34 표 읽기가 실패하면 마지막으로 읽은 값을 그 만료까지 유지하고, 만료 시각에 처음 상한으로 돌아간다 [ASVS v5.0.0-16.5.3]', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    await throttledOn(a);
    await syncTick(b);
    await admin.pool.query('alter table payment_channel_limit rename to payment_channel_limit_off');
    try {
      s.clock.advance(60_000);
      await syncTick(b);
      expect(metricLine(await b.metrics(), 'payment_pg_limit_sync_failures_total', 'step="read"')).toBe(1);
      expect(b.logs.filter((l) => l.includes('pg-limit-sync-failed'))).toHaveLength(1);
      expect(b.limits()).toEqual(HALF);

      s.clock.advance(PG_LIMIT_HOLD_MS - 60_000 - 1);
      await syncTick(b);
      expect(metricLine(await b.metrics(), 'payment_pg_limit_sync_failures_total', 'step="read"')).toBe(2);
      expect(b.limits()).toEqual(HALF);
      s.clock.advance(1);
      await syncTick(b);
      expect(b.limits()).toEqual(FULL);
    } finally {
      await admin.pool.query('alter table payment_channel_limit_off rename to payment_channel_limit');
    }
  });

  test('P-T34 표 쓰기가 실패하면 그 파드의 낮춘 값을 그 만료까지 두고, 표는 비고 다른 파드는 처음 상한이다 [ASVS v5.0.0-16.5.3]', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    await admin.pool.query('alter table payment_channel_limit add constraint it_block_writes check (ratio_percent < 0) not valid');
    try {
      await throttledOn(a);
      expect(metricLine(await a.metrics(), 'payment_pg_limit_sync_failures_total', 'step="write"')).toBe(1);
      expect(a.logs.filter((l) => l.includes('pg-limit-sync-failed'))).toHaveLength(1);
      expect(a.logs.filter((l) => l.includes('pg-throttled-first'))).toHaveLength(1);
      expect(await rows()).toEqual([]);
      expect(a.limits()).toEqual(HALF);
      await syncTick(b);
      expect(b.limits()).toEqual(FULL);
      await syncTick(a);
      expect(a.limits()).toEqual(HALF);

      s.clock.advance(PG_LIMIT_HOLD_MS - 1);
      expect(a.limits()).toEqual(HALF);
      s.clock.advance(1);
      expect(a.limits()).toEqual(FULL);
    } finally {
      await admin.pool.query('alter table payment_channel_limit drop constraint it_block_writes');
    }
  });

  test('P-T34 쓰기가 실패했던 파드가 쿨다운 뒤 다시 첫 429를 받으면, 그사이 다른 파드가 쓴 행을 새 판으로 읽어 더 낮춘다', async () => {
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const s = await stack();
    await admin.pool.query('alter table payment_channel_limit add constraint it_block_writes check (ratio_percent < 0) not valid');
    try {
      await throttledOn(a);
    } finally {
      await admin.pool.query('alter table payment_channel_limit drop constraint it_block_writes');
    }
    expect(a.limits()).toEqual(HALF);
    // a는 표를 모른다(판 없음). b가 50%를 판 1로 쓴다
    s.clock.advance(1);
    await throttledOn(b);
    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[50, '1']]);
    s.clock.advance(PG_LOWER_COOLDOWN_MS);
    await throttledOn(a);
    expect(a.limits()).toEqual(QUARTER);
    expect((await rows()).map((r) => [r.ratio_percent, r.version])).toEqual([[25, '2']]);
  });
});

describe('P-T43 ③: 정지 판정자의 예상 대기', () => {
  test('P-T43 ③ 판정자는 다른 파드가 표에 낮춘 비율을 걸어 예상 대기를 잰다(같은 대기 건수에서 비율만큼 정확히 길어진다: 0.01초 → 0.02초, 문턱 0.015초는 넘고 0.025초는 넘지 않는다)', async () => {
    const s = await stack();
    const judgePod = await pod('pod-judge');
    const other = await pod('pod-other');
    const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: s.clock, level: 'fatal' });
    // 대기 셋에 초당 300건이면 0.01초, 50%면 0.02초다. 문턱 둘(0.015초·0.025초)로 0.02초를 묶는다(코드 리뷰 T5)
    const judgeAt = (channelStartWaitSeconds: number) => new EntryPauseJudge({
      store: new DrizzleEntryPause({ database: batch }),
      inputs: { read: async () => ({ openPods: 0, readyPods: 2, sampledAtMs: s.clock.now() }) },
      gateways: new StaticPaymentGateways([new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: simKey, clientKey: 'sim_ck_test_client' })]),
      guards: judgePod.guards,
      leader: { isLeader: () => true },
      podCount: 1,
      clock: s.clock,
      // 판정자마다 지표 등록부를 따로 둔다(같은 이름을 두 번 등록하지 않게)
      signals: new PromEntryPauseSignals().register(new PlatformMetrics('payment-svc').registry, { read: async () => new Map() }),
      log: entryPauseLog(logger),
      timer: { setInterval: () => 0, clearInterval: () => undefined },
      config: { channelStartWaitSeconds } satisfies Partial<EntryPauseJudgeConfig>,
    });
    const low = judgeAt(0.015);
    const high = judgeAt(0.025);
    const tickOf = async (judge: EntryPauseJudge) => {
      await judge.tick();
      await judge.whenIdle();
    };
    const tick = () => tickOf(low);
    const pause = async () => (await admin.pool.query<{ stage: string; reason: string }>(`select stage, reason from payment_entry_pause where pg = 'SIMULATOR'`)).rows[0];

    // 다른 파드가 첫 429로 표를 낮춘다(그 명령은 다시 기다린다)
    const throttled = await throttledOn(other);
    await accepted();
    await accepted();
    s.clock.advance(5_000);

    await tick();
    expect(await pause()).toBeUndefined();

    await syncTick(judgePod);
    expect(judgePod.limits().rps).toBe(150);
    await tickOf(high);
    expect(await pause()).toBeUndefined();
    await tick();
    expect(await pause()).toMatchObject({ stage: 'PROBING', reason: 'CHANNEL_WAIT' });
    expect((await ledgerOf(admin, throttled.orderId)).jobs).toHaveLength(1);
  });
});
