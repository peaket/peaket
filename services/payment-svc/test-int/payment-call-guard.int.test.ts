// 결제사 호출 보호(BUILD_ORDER PRF-183)를 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp), 실제 저장소·실행기·undici 연결 묶음으로 돈다.
// 정본: docs/features/payment.md §2 '결제사 호출 보호의 첫 구현'·§4.2 22번·P-T34·P-T40, docs/data.md §5.1 '승인 명령 잡기', docs/verification.md §4.1, docs/security/asvs/payment.md.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 세 표를 비운다. 시계는 접수·저장소·실행기·보호기가 함께 쓰는 가짜 시계다(멈춰 있고 advance로만 간다. 토큰도 advance로만 찬다).
// - 시뮬레이터 시계는 고정이다. 지연은 짧게 줄인다(정본 P-T40의 10초·70초는 측정 단계가 잰다, 여기서는 2초 예산을 넘는 지연과 짧은 읽기 시간 초과로 같은 갈래를 본다).
// - 동시 호출 수는 어댑터의 fetch에서 잰다. 닿지 않는 주소는 답하지 않는 TCP 서버(TLS 인사가 끝나지 않는다)로 네트워크 환경과 상관없이 만든다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Socket } from 'node:net';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway, type SimulatorGatewayOptions } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  CONFIRM_LEASE_MS,
  createPgHttp,
  DrizzleConfirmJobs,
  PaymentConfirmRunner,
  paymentConfirmLog,
  PaymentUnknownResolver,
  paymentUnknownLog,
  PgCallGuards,
  pgCallGuardLog,
  PromPaymentConfirmSignals,
  PromPaymentUnknownSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  UNKNOWN_QUERY_BASE_MS,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, startGrpcStack, tossConfirm, type TossFixture, unary, until } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let sim: Sim;
let stacked: Promise<GrpcStack> | undefined;

interface Sim {
  app: SimulatorApp;
  url: string;
  key: string;
  /** 승인 POST의 주문 ID */
  calls: string[];
  /** 지금 돌고 있는 승인 POST 수와 그 최댓값 */
  active: number;
  peak: number;
  /** 단독 조회 GET 수 */
  queries: number;
  control(method: string, path: string, body?: unknown): Promise<Response>;
  authenticate(orderId: string, amount: number): Promise<string>;
  fault(orderId: string, f: Record<string, unknown>): Promise<void>;
  approvals(orderId: string): Promise<number>;
  counting(inner: typeof fetch): typeof fetch;
  gateway(o?: Partial<SimulatorGatewayOptions>): SimulatorPaymentGateway;
}

async function startSim(): Promise<Sim> {
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const control = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const s: Sim = {
    app,
    url,
    key,
    calls: [],
    active: 0,
    peak: 0,
    queries: 0,
    control,
    async authenticate(orderId, amount) {
      const r = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓' });
      expect(r.status).toBe(200);
      return ((await r.json()) as { paymentKey: string }).paymentKey;
    },
    async fault(orderId, f) {
      expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId, ...f })).status).toBe(204);
    },
    async approvals(orderId) {
      const text = await (await control('GET', '/sim/ledger')).text();
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { order_ref: string })
        .filter((r) => r.order_ref === orderId).length;
    },
    counting: (inner) => async (input, init) => {
      if (init?.method === 'GET') s.queries += 1;
      if (init?.method !== 'POST' || !String(input).endsWith('/v1/payments/confirm')) return inner(input, init);
      s.calls.push((JSON.parse(String(init.body)) as { orderId: string }).orderId);
      s.active += 1;
      s.peak = Math.max(s.peak, s.active);
      try {
        return await inner(input, init);
      } finally {
        s.active -= 1;
      }
    },
    gateway: (o = {}) => new SimulatorPaymentGateway({ baseUrl: url, secretKey: key, clientKey: 'sim_ck_test_client', fetch: s.counting(fetch), ...o }),
  };
  return s;
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-guard-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 16, applicationName: 'payment-guard-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'payment-guard-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 16, applicationName: 'payment-guard-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);
  sim = await startSim();
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await sim?.app.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job');
  expect((await sim.control('DELETE', '/sim/faults')).status).toBe(204);
  sim.calls.length = 0;
  sim.active = 0;
  sim.peak = 0;
  sim.queries = 0;
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));

interface Rig {
  s: GrpcStack;
  logs: string[];
  metrics(): Promise<string>;
  guards: PgCallGuards;
  runner: PaymentConfirmRunner;
  resolver: PaymentUnknownResolver;
}

/** 어댑터 등록부·보호기·두 실행기를 시험마다 새로 만든다(보호기의 토큰과 낮춘 상한이 다음 시험으로 넘어가지 않게) */
async function rig(gateway: SimulatorPaymentGateway = sim.gateway(), bulkheads: Partial<Record<'SIMULATOR', number>> = {}): Promise<Rig> {
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
  const gateways = new StaticPaymentGateways([gateway]);
  const guards = new PgCallGuards({ gateways, podCount: 1, clock: s.clock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger), bulkheads });
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  const runner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: s.clock, podId: 'pod-guard', timer: silent });
  const resolver = new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(metrics.registry), clock: s.clock, timer: silent });
  return { s, logs, metrics: () => metrics.registry.metrics(), guards, runner, resolver };
}

interface Accepted extends TossFixture {
  paymentId: string;
}

async function accepted(o: { pg?: 'SIMULATOR' | 'TOSS' } = {}): Promise<Accepted> {
  const s = await stack();
  const orderId = newId();
  const amount = 39_000;
  const paymentKey = o.pg === 'TOSS' ? `toss_${randomBytes(8).toString('hex')}` : await sim.authenticate(orderId, amount);
  const f = tossConfirm({ pg: o.pg ?? 'SIMULATOR', orderId, paymentKey, amount, authenticatedAtMs: s.clock.now() - 1_000 });
  const reply = await unary(s.client, 'ConfirmPayment', f.request);
  return { ...f, paymentId: reply.payment_id as string };
}

const statusOf = async (f: { orderId: string }): Promise<string> => (await ledgerOf(admin, f.orderId)).payments[0]!.status;
const jobOf = async (f: { orderId: string }) => (await ledgerOf(admin, f.orderId)).jobs[0];
const callsOf = (f: { orderId: string }): number => sim.calls.filter((c) => c === f.orderId).length;

async function drive(runner: PaymentConfirmRunner | PaymentUnknownResolver): Promise<number> {
  const { claimed } = await runner.tick();
  await runner.whenIdle();
  return claimed;
}

function metricLine(text: string, name: string, labels: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(labels));
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('P-T34: 첫 승인 호출의 429', () => {
  test('P-T34_첫 승인 호출이 429를 받으면 SEV2 로그 한 줄과 지표가 나오고 상한이 절반이 되며, 그 명령은 실패로 쓰지 않고 다음 시도에 승인된다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
    const r = await rig();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'throttle' });

    expect(await drive(r.runner)).toBe(1);

    expect(await statusOf(f)).toBe('ACCEPTED');
    expect(await jobOf(f)).toMatchObject({ attempts: 1, lease_owner: null });
    expect(r.guards.of('SIMULATOR')!.limits()).toEqual({ rps: 150, concurrency: 300 });

    const text = await r.metrics();
    expect(metricLine(text, 'pg_throttled_total', 'pg="SIMULATOR",first="true"')).toBe(1);
    expect(metricLine(text, 'payment_pg_limit', 'pg="SIMULATOR",kind="rps"')).toBe(150);
    expect(metricLine(text, 'payment_pg_limit', 'pg="SIMULATOR",kind="concurrency"')).toBe(300);

    const lines = r.logs.filter((l) => l.includes('pg-throttled-first'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', severity: 'SEV2', pg: 'SIMULATOR', rps: 150, concurrency: 300 });
    expect(lines[0]).not.toContain(f.orderId);
    expect(lines[0]).not.toContain(f.paymentKey);

    r.s.clock.advance(1_000);
    expect(await drive(r.runner)).toBe(1);
    expect(await statusOf(f)).toBe('APPROVED');
    expect(callsOf(f)).toBe(2);
    expect(await sim.approvals(f.orderId)).toBe(1);
  });

  test('P-T34_토큰이 찰 때만큼만 명령을 내보낸다(초당 20건이면 묶음 4개에서 조회 몫을 뺀 3건씩 나가고, 나머지는 표에서 차례를 기다려 모두 승인되며 attempts는 오르지 않는다) [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.4.1]', async () => {
    const r = await rig(sim.gateway({ callsPerSecond: 20 }));
    const fs = await Promise.all(Array.from({ length: 5 }, () => accepted()));

    expect(await drive(r.runner)).toBe(3);
    expect(sim.calls).toHaveLength(3);
    expect(await drive(r.runner)).toBe(0);

    const waiting = (await admin.pool.query<{ n: number }>('select count(*)::int as n from payment_confirm_job where lease_owner is null and attempts = 0')).rows[0]!.n;
    expect(waiting).toBe(2);

    for (let i = 0; i < 2; i += 1) {
      r.s.clock.advance(1_000);
      await drive(r.runner);
    }
    expect(sim.calls).toHaveLength(5);
    for (const f of fs) expect(await statusOf(f)).toBe('APPROVED');
    expect(metricLine(await r.metrics(), 'payment_pg_saturated_total', 'pg="SIMULATOR",reason="token"')).toBeGreaterThanOrEqual(1);
  });
});

describe('P-T40: 지연과 시간 초과', () => {
  test('P-T40_① 2초를 넘는 지연을 끊지 않고 확정하며 다시 보낸 호출은 0건이다 [ASVS v5.0.0-13.2.6] [ASVS v5.0.0-15.1.3]', async () => {
    const http = createPgHttp({ connections: 4 });
    const r = await rig(sim.gateway({ fetch: sim.counting(http.fetch) }));
    try {
      const f = await accepted();
      await sim.fault(f.orderId, { kind: 'delay', ms: 2_200 });

      await drive(r.runner);

      expect(await statusOf(f)).toBe('APPROVED');
      expect(callsOf(f)).toBe(1);
      expect(await sim.approvals(f.orderId)).toBe(1);
    } finally {
      await http.close();
    }
  }, 30_000);

  test('P-T40_② 읽기 시간 초과 뒤 결과를 가정하지 않고 UNKNOWN으로 쓰고, 같은 멱등키로 다시 보내지 않으며 단독 조회로 승인 1건을 확정한다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.3.4]', async () => {
    const r = await rig(sim.gateway({ readTimeoutMs: 100 }));
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'delay', ms: 400 });

    await drive(r.runner);

    expect(await statusOf(f)).toBe('UNKNOWN');
    expect(callsOf(f)).toBe(1);

    // 결제사는 끊긴 뒤에도 처리해 승인이 남는다
    await until(async () => (await sim.approvals(f.orderId)) === 1, '시뮬레이터의 승인', 10_000, 20);
    r.s.clock.advance(UNKNOWN_QUERY_BASE_MS);
    expect(await drive(r.resolver)).toBe(1);

    expect(await statusOf(f)).toBe('APPROVED');
    expect(callsOf(f)).toBe(1);
    expect(await sim.approvals(f.orderId)).toBe(1);
  }, 30_000);

  test('P-T40_③ 상한을 넘는 명령은 표에서 기다렸다가 기한 안에 처리되고 동시 호출 수가 상한을 넘지 않는다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-13.2.6] [ASVS v5.0.0-15.1.3]', async () => {
    const http = createPgHttp({ connections: 2 });
    const r = await rig(sim.gateway({ fetch: sim.counting(http.fetch) }), { SIMULATOR: 2 });
    try {
      const fs = await Promise.all(Array.from({ length: 6 }, () => accepted()));
      for (const f of fs) await sim.fault(f.orderId, { kind: 'delay', ms: 150 });

      const first = await r.runner.tick();
      expect(first.claimed).toBe(2);
      expect((await admin.pool.query<{ n: number }>('select count(*)::int as n from payment_confirm_job where lease_owner is null')).rows[0]!.n).toBe(4);

      await until(
        async () => {
          await r.runner.tick();
          return (await admin.pool.query<{ n: number }>('select count(*)::int as n from payment_confirm_job')).rows[0]!.n === 0;
        },
        '모든 명령의 처리',
        20_000,
        20,
      );
      await r.runner.whenIdle();

      expect(sim.peak).toBe(2);
      expect(sim.calls).toHaveLength(6);
      for (const f of fs) expect(await statusOf(f)).toBe('APPROVED');
      expect(metricLine(await r.metrics(), 'payment_pg_saturated_total', 'pg="SIMULATOR",reason="bulkhead"')).toBeGreaterThanOrEqual(1);
      expect(metricLine(await r.metrics(), 'payment_pg_inflight', 'pg="SIMULATOR"')).toBe(0);
    } finally {
      await http.close();
    }
  }, 30_000);

  test('P-T40_④ 같은 멱등키로 다시 보낸 호출에만 429면 상한이 그대로이고 그 호출만 다음 시도가 늦춰진다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-16.3.4]', async () => {
    const r = await rig();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'in-progress' });
    await drive(r.runner);
    expect(await jobOf(f)).toMatchObject({ attempts: 1 });

    r.s.clock.advance(1_000);
    await sim.fault(f.orderId, { kind: 'throttle' });
    await drive(r.runner);

    expect(await statusOf(f)).toBe('ACCEPTED');
    const job = await jobOf(f);
    expect(job).toMatchObject({ attempts: 2, lease_owner: null });
    expect(job!.next_attempt_at.getTime()).toBe(r.s.clock.now() + 2_000);
    expect(r.guards.of('SIMULATOR')!.limits()).toEqual({ rps: 300, concurrency: 600 });
    const text = await r.metrics();
    expect(metricLine(text, 'pg_throttled_total', 'pg="SIMULATOR",first="false"')).toBe(1);
    expect(metricLine(text, 'pg_throttled_total', 'pg="SIMULATOR",first="true"')).toBe(0);
    expect(r.logs.filter((l) => l.includes('pg-throttled-first'))).toEqual([]);

    r.s.clock.advance(2_000);
    await drive(r.runner);
    expect(await statusOf(f)).toBe('APPROVED');
    expect(await sim.approvals(f.orderId)).toBe(1);
  });

  test('P-T40_답하지 않는 주소는 연결 시간 초과로 끝나 읽기 시간 초과를 기다리지 않고 UNKNOWN이며 승인은 0건이다 [ASVS v5.0.0-13.2.6] [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((s) => {
      sockets.add(s);
      s.on('error', () => undefined);
      s.once('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const http = createPgHttp({ connections: 1, connectTimeoutMs: 200 });
    const r = await rig(sim.gateway({ baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, fetch: http.fetch }));
    try {
      const f = await accepted();
      const started = performance.now();

      await drive(r.runner);

      expect(performance.now() - started).toBeLessThan(3_000);
      expect(await statusOf(f)).toBe('UNKNOWN');
      expect(await sim.approvals(f.orderId)).toBe(0);
    } finally {
      await http.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  test('P-T40_토큰이 없으면 단독 조회를 잡지 않아 다음 조회 시각과 조회 횟수가 그대로이고 막힌 것으로 세며, 토큰이 차면 조회로 확정한다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.5.2]', async () => {
    const r = await rig();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'drop', applied: true });
    await drive(r.runner);
    expect(await statusOf(f)).toBe('UNKNOWN');
    r.s.clock.advance(UNKNOWN_QUERY_BASE_MS);

    const guard = r.guards.of('SIMULATOR')!;
    for (let i = 0; i < 10_000 && guard.tryTakeToken(); i += 1);
    sim.queries = 0;
    const rowOf = async () => (await admin.pool.query<{ next_query_at: Date; query_attempts: number }>('select next_query_at, query_attempts from payment where id = $1', [f.paymentId])).rows[0]!;
    const before = await rowOf();

    expect(await drive(r.resolver)).toBe(0);

    expect(sim.queries).toBe(0);
    const row = await rowOf();
    expect(row.next_query_at.getTime()).toBe(before.next_query_at.getTime());
    expect(row.query_attempts).toBe(0);
    expect(metricLine(await r.metrics(), 'payment_pg_saturated_total', 'pg="SIMULATOR",reason="token"')).toBeGreaterThanOrEqual(1);

    r.s.clock.advance(1_000);
    expect(await drive(r.resolver)).toBe(1);
    expect(await statusOf(f)).toBe('APPROVED');
  });
});

describe('리뷰 고침(BUILD_ORDER PRF-183, 코드 리뷰)', () => {
  const lateAuthenticated = (paymentId: string, ms: number) => admin.pool.query('update payment set authenticated_at = $2 where id = $1', [paymentId, new Date(ms)]);

  test('P-T40_리뷰 고침 H1: ConfirmPayment가 원장의 결제사를 명령 행에 적고 다른 채널의 쌓인 명령이 잡기를 막지 않는다 [ASVS v5.0.0-15.1.3]', async () => {
    const s = await stack();
    const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
    const toss = await Promise.all(Array.from({ length: 5 }, () => accepted({ pg: 'TOSS' })));
    s.clock.advance(1);
    const sim1 = await accepted();

    expect(await jobOf(sim1)).toMatchObject({ pg: 'SIMULATOR' });
    expect(await jobOf(toss[0]!)).toMatchObject({ pg: 'TOSS' });
    expect((await jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS)).map((j) => j.paymentId)).toEqual([sim1.paymentId]);
  });

  test('P-T40_리뷰 고침 M5: 기한 지난 행만 잡는다(다른 채널·임대 중·기한 전은 잡지 않는다) [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const s = await stack();
    const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
    const deadlineMs = 600_000;
    const expired = await accepted();
    const fresh = await accepted();
    const leased = await accepted();
    const other = await accepted({ pg: 'TOSS' });
    await lateAuthenticated(expired.paymentId, s.clock.now() - deadlineMs);
    await lateAuthenticated(leased.paymentId, s.clock.now() - deadlineMs);
    await lateAuthenticated(other.paymentId, s.clock.now() - deadlineMs);
    await admin.pool.query(`update payment_confirm_job set lease_owner = 'pod-z', lease_until = $2 where payment_id = $1`, [leased.paymentId, new Date(s.clock.now() + 60_000)]);

    const claimed = await jobs.claimExpired('SIMULATOR', 50, 'pod-a', CONFIRM_LEASE_MS, deadlineMs);

    expect(claimed.map((j) => j.paymentId)).toEqual([expired.paymentId]);
    expect(claimed[0]).toMatchObject({ pg: 'SIMULATOR', owner: 'pod-a', attempts: 0, hadPreviousOwner: false });
    expect(await jobOf(expired)).toMatchObject({ lease_owner: 'pod-a' });
    expect(await jobOf(fresh)).toMatchObject({ lease_owner: null });
    expect(await jobOf(other)).toMatchObject({ lease_owner: null });
  });

  test('P-T40_리뷰 고침 M5: 벌크헤드가 다 차도 기한 지난 명령은 결제사를 부르지 않고 FAILED(EXPIRED)로 끝난다 [ASVS v5.0.0-15.1.3] [ASVS v5.0.0-16.5.3]', async () => {
    const http = createPgHttp({ connections: 1 });
    const r = await rig(sim.gateway({ fetch: sim.counting(http.fetch) }), { SIMULATOR: 1 });
    try {
      const busy = await accepted();
      await sim.fault(busy.orderId, { kind: 'delay', ms: 400 });
      expect(await r.runner.tick()).toEqual({ claimed: 1 });
      await until(() => sim.active === 1, '돌고 있는 승인 호출', 5_000, 5);

      const late = await accepted();
      await lateAuthenticated(late.paymentId, r.s.clock.now() - 600_000);
      expect(await r.runner.tick()).toEqual({ claimed: 1 });
      await until(async () => (await statusOf(late)) === 'FAILED', '기한 지난 명령의 끝', 5_000, 10);

      expect((await ledgerOf(admin, late.orderId)).payments[0]).toMatchObject({ failure_category: 'EXPIRED' });
      expect(callsOf(late)).toBe(0);
      await r.runner.whenIdle();
      expect(await statusOf(busy)).toBe('APPROVED');
    } finally {
      await http.close();
    }
  }, 30_000);

  test('P-T40_리뷰 고침 M4: 승인 호출이 연결을 다 쥐어도 조회 전용 연결 묶음으로 단독 조회가 나간다 [ASVS v5.0.0-13.2.6]', async () => {
    const confirmHttp = createPgHttp({ connections: 1 });
    const queryHttp = createPgHttp({ connections: 1 });
    const r = await rig(sim.gateway({ fetch: sim.counting(confirmHttp.fetch), queryFetch: queryHttp.fetch }));
    try {
      const known = await accepted();
      await sim.fault(known.orderId, { kind: 'drop', applied: true });
      await drive(r.runner);
      expect(await statusOf(known)).toBe('UNKNOWN');

      const slow = await accepted();
      await sim.fault(slow.orderId, { kind: 'delay', ms: 1_500 });
      await r.runner.tick();
      await until(() => sim.active === 1, '돌고 있는 승인 호출', 5_000, 5);

      r.s.clock.advance(UNKNOWN_QUERY_BASE_MS);
      const started = performance.now();
      expect(await drive(r.resolver)).toBe(1);

      expect(await statusOf(known)).toBe('APPROVED');
      expect(sim.active).toBe(1);
      expect(performance.now() - started).toBeLessThan(1_400);
      await r.runner.whenIdle();
    } finally {
      await confirmHttp.close();
      await queryHttp.close();
    }
  }, 30_000);
});

describe('잡기', () => {
  test('P-T40_채널을 나눠 잡는다(다른 결제사의 명령은 잡히지 않고 명령 행만 잠근다) [ASVS v5.0.0-2.3.4]', async () => {
    const s = await stack();
    const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
    const simF = await accepted();
    const tossF = await accepted({ pg: 'TOSS' });

    const claimed = await jobs.claimDue('SIMULATOR', 10, 'pod-a', CONFIRM_LEASE_MS);

    expect(claimed.map((j) => j.paymentId)).toEqual([simF.paymentId]);
    expect(claimed[0]).toMatchObject({ pg: 'SIMULATOR', attempts: 0, owner: 'pod-a' });
    expect(await jobOf(tossF)).toMatchObject({ lease_owner: null });

    const client = await admin.pool.connect();
    try {
      await client.query('begin');
      // 잡기가 payment 행을 잠그면 이 잠금과 부딪힌다
      await client.query('select 1 from payment where id = $1 for update', [tossF.paymentId]);
      await expect(jobs.claimDue('TOSS', 10, 'pod-a', CONFIRM_LEASE_MS)).resolves.toMatchObject([{ paymentId: tossF.paymentId, pg: 'TOSS' }]);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });
});
