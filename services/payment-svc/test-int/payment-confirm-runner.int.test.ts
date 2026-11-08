// 승인 실행기(BUILD_ORDER PRF-181)를 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp), 실제 저장소(DrizzleConfirmJobs)로 돈다.
// 정본: docs/features/payment.md §2 '승인 실행기의 첫 구현'·§4.2·P-T6·P-T24, docs/data.md 0001·§5·§5.1, specs/payment.qnt, asyncapi PaymentEvent(Kafka 키는 회차 ID), docs/security/asvs/payment.md.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 세 표를 비운다(잡기는 표 전체를 보므로 앞 시험의 행이 잡히면 안 된다). 시험 순서는 파일 순서다.
// - 명령은 실제 ConfirmPayment(gRPC, startGrpcStack)로 넣는다. 시계는 그 스택의 가짜 시계 하나를 접수·저장소·실행기가 함께 쓴다(멈춰 있고 advance로만 간다).
// - 시뮬레이터 시계는 고정이라 승인 시각이 SIM_NOW_MS다. 장애는 주문 ID로 고른다(/sim/faults).
// - 승인 호출 수는 어댑터의 fetch에서 센다(confirmCalls). 시뮬레이터가 만들 수 없는 답(입금 대기·금액 어긋남)은 같은 fetch에서 실제 응답을 고쳐 어댑터까지 실제로 돈다.
// - 실행기는 손으로 돌린다: tick은 호출을 기다리지 않으므로 drive가 whenIdle까지 기다린다. 틱 타이머는 start·stop을 보는 시험에서만 진짜다.
// - 프로세스 강제 종료는 임대를 끊는 것으로 만든다(시계를 임대 길이 넘게 민다. 죽은 파드의 답은 끝내 오지 않거나, 다른 실행기보다 늦게 온다).
// - 트랜잭션 실패는 test_hooks 스키마의 트리거로 만든다(운영 표 정의는 건드리지 않고, 표시한 행만 실패시킨다).
// - 조립은 처음 부를 때 한다. 뼈대 단계에서는 시험마다 그 자리에서 실패한다.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { type ConsumedMessage, createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { PaymentResultHandler } from '../../purchase-svc/src/modules/booking/inbound/payment-result.handler.js';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway, type SimulatorGatewayOptions } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  CONFIRM_LEASE_MS,
  CONFIRM_NO_ADAPTER_DELAY_MS,
  CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS,
  type ConfirmJob,
  DrizzleConfirmJobs,
  type PaymentGateways,
  PaymentConfirmRunner,
  type PaymentConfirmRunnerDeps,
  paymentConfirmLog,
  paymentEventKey,
  PgCallGuards,
  pgCallGuardLog,
  PromPaymentConfirmSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TRADE_PAYMENTS_TOPIC,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, msOf, newId, type PaymentRow, startGrpcStack, tossConfirm, type TossFixture, unary, until } from './support.js';

/** 시뮬레이터의 멈춘 시계(승인 시각) */
const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
/** 시뮬레이터 어댑터의 승인 기한(capabilities().confirmDeadlineMs) */
const DEADLINE_MS = 600_000;
const TOTAL = 'payment_confirm_total';
const WRITE_FAILURES = 'payment_confirm_write_failures_total';

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let otherRunnerDb: Database;
let stacked: Promise<GrpcStack> | undefined;
let sim: Sim;

/** 쓰인 결제 키·토큰(로그·값에 실리지 않는지 볼 때) */
const secrets: string[] = [];

// ───────────────────────────── 시뮬레이터 ─────────────────────────────

interface ConfirmCall {
  orderId: string;
  paymentKey: string;
  amount: number;
  idemKey: string | null;
}

/** 어댑터가 받는 승인 응답 고치기(시뮬레이터가 만들 수 없는 답) */
type Rewrite = (json: Record<string, unknown>) => Record<string, unknown>;

interface Sim {
  app: SimulatorApp;
  url: string;
  key: string;
  /** 승인 POST(어댑터가 실제로 보낸 것) */
  calls: ConfirmCall[];
  rewrites: Map<string, Rewrite>;
  /** 승인 POST를 보내기 직전에 돈다(주문 ID) */
  beforeCall: Map<string, () => Promise<void>>;
  fetch: typeof fetch;
  control(method: string, path: string, body?: unknown): Promise<Response>;
  authenticate(orderId: string, amount: number): Promise<string>;
  fault(orderId: string, f: Record<string, unknown>): Promise<void>;
  approvals(orderId: string): Promise<number>;
  gateway(o?: Partial<SimulatorGatewayOptions>): SimulatorPaymentGateway;
}

async function startSim(): Promise<Sim> {
  // 실행마다 새 시험 키([ASVS v5.0.0-13.3.1])
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const control = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const calls: ConfirmCall[] = [];
  const rewrites = new Map<string, Rewrite>();
  const beforeCall = new Map<string, () => Promise<void>>();
  const counting: typeof fetch = async (input, init) => {
    if (init?.method !== 'POST' || !String(input).endsWith('/v1/payments/confirm')) return fetch(input, init);
    const body = JSON.parse(String(init.body)) as { paymentKey: string; orderId: string; amount: number };
    calls.push({ ...body, idemKey: new Headers(init.headers).get('idempotency-key') });
    await beforeCall.get(body.orderId)?.();
    const res = await fetch(input, init);
    const rewrite = rewrites.get(body.orderId);
    if (!rewrite || res.status !== 200) return res;
    return new Response(JSON.stringify(rewrite((await res.json()) as Record<string, unknown>)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    app,
    url,
    key,
    calls,
    rewrites,
    beforeCall,
    fetch: counting,
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
    gateway: (o = {}) => new SimulatorPaymentGateway({ baseUrl: url, secretKey: key, clientKey: 'sim_ck_test_client', fetch: counting, ...o }),
  };
}

// ───────────────────────────── 조립 ─────────────────────────────

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-runner-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-runner-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-runner-it-batch' });
  // 풀 대기로 실패하는 것은 이 시험이 볼 일이 아니어서 운영(8개)보다 넉넉히 잡는다
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-runner-it-a' });
  otherRunnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-runner-it-b' });
  await ensureOutboxPartitions(admin, systemClock);
  await admin.pool.query(`
    create schema test_hooks;
    create table test_hooks.fail_outbox_key (msg_key text primary key);
    create function test_hooks.fail_outbox() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_outbox_key f where f.msg_key = new.msg_key) then
        raise exception 'test-forced-failure';
      end if;
      return new;
    end $f$;
    create trigger test_fail_outbox before insert on public.outbox for each row execute function test_hooks.fail_outbox();
    create table test_hooks.fail_event (payment_id uuid not null, type text not null, primary key (payment_id, type));
    create function test_hooks.fail_event() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_event f where f.payment_id = new.payment_id and f.type = new.type) then
        raise exception 'test-forced-failure';
      end if;
      return new;
    end $f$;
    create trigger test_fail_event before insert on public.payment_event for each row execute function test_hooks.fail_event();
    create table test_hooks.fail_job_delete (payment_id uuid primary key);
    create function test_hooks.fail_job_delete() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_job_delete f where f.payment_id = old.payment_id) then
        raise exception 'test-forced-failure';
      end if;
      return old;
    end $f$;
    create trigger test_fail_job_delete before delete on public.payment_confirm_job for each row execute function test_hooks.fail_job_delete();
  `);
  sim = await startSim();
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await sim?.app.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close(), otherRunnerDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job');
  await admin.pool.query('truncate test_hooks.fail_outbox_key, test_hooks.fail_event, test_hooks.fail_job_delete');
  expect((await sim.control('DELETE', '/sim/faults')).status).toBe(204);
  sim.calls.length = 0;
  sim.rewrites.clear();
  sim.beforeCall.clear();
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));
const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query<R>(text, params)).rows;

interface Harness {
  stack: GrpcStack;
  clock: GrpcStack['clock'];
  jobs: DrizzleConfirmJobs;
  otherJobs: DrizzleConfirmJobs;
  /** 실행기 로그(JSON 글) */
  logs: string[];
  metrics(): Promise<string>;
  gateways: StaticPaymentGateways;
  /** 타이머 없는 실행기의 재료(start를 보는 시험이 타이머를 뺀 채 쓴다) */
  deps(pod: string, o?: Partial<PaymentConfirmRunnerDeps>): PaymentConfirmRunnerDeps;
  /** 손으로 돌리는 실행기(타이머가 울리지 않는다) */
  runner(pod: string, o?: Partial<PaymentConfirmRunnerDeps>): PaymentConfirmRunner;
}

let built: Promise<Harness> | undefined;

async function buildHarness(): Promise<Harness> {
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
  const signals = new PromPaymentConfirmSignals().register(metrics.registry);
  const guardSignals = new PromPgCallGuardSignals().register(metrics.registry);
  const guardLog = pgCallGuardLog(logger);
  const log = paymentConfirmLog(logger);
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
  const otherJobs = new DrizzleConfirmJobs({ database: otherRunnerDb, clock: s.clock });
  const gateways = new StaticPaymentGateways([sim.gateway()]);
  // 실행기마다 새 보호기(시계가 멈춰 있어 토큰이 차지 않고, 앞 시험의 429가 상한을 낮춘 채 남지 않게)
  const guardsFor = (g: PaymentGateways): PgCallGuards => new PgCallGuards({ gateways: g, podCount: 1, clock: s.clock, signals: guardSignals, log: guardLog });
  const deps = (pod: string, o: Partial<PaymentConfirmRunnerDeps> = {}): PaymentConfirmRunnerDeps => ({ jobs, gateways, log, signals, clock: s.clock, podId: pod, guards: guardsFor(o.gateways ?? gateways), ...o });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  return { stack: s, clock: s.clock, jobs, otherJobs, logs, metrics: () => metrics.registry.metrics(), gateways, deps, runner: (pod, o = {}) => new PaymentConfirmRunner({ ...deps(pod), timer: silent, ...o }) };
}

const harness = (): Promise<Harness> => (built ??= buildHarness());

/** 틱 하나를 돌리고 잡은 행이 끝나기를 기다린다. 돌려준 값은 잡은 수 */
async function drive(runner: PaymentConfirmRunner): Promise<number> {
  const { claimed } = await runner.tick();
  await runner.whenIdle();
  return claimed;
}

interface Accepted extends TossFixture {
  paymentId: string;
}

/** 시뮬레이터에서 인증하고 실제 ConfirmPayment로 명령을 넣는다. 기본 인증 시각은 1초 전이다 */
async function accepted(o: { amount?: number; authenticatedAtMs?: number } = {}): Promise<Accepted> {
  const s = await stack();
  const orderId = newId();
  const amount = o.amount ?? 39_000;
  const paymentKey = await sim.authenticate(orderId, amount);
  secrets.push(paymentKey);
  const f = tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount, authenticatedAtMs: o.authenticatedAtMs ?? s.clock.now() - 1_000 });
  const reply = await unary(s.client, 'ConfirmPayment', f.request);
  return { ...f, paymentId: reply.payment_id as string };
}

type LedgerRow = PaymentRow & { failure_category: string | null };

interface OutboxRow extends pg.QueryResultRow {
  topic: string;
  msg_key: string;
  payload: Buffer;
  sent_at: Date | null;
}

const outboxOf = (f: { eventId: string }): Promise<OutboxRow[]> => q<OutboxRow>('select topic, msg_key, payload, sent_at from outbox where msg_key = $1 order by seq', [f.eventId]);
const valueOf = (row: OutboxRow): Record<string, unknown> => JSON.parse(row.payload.toString('utf8')) as Record<string, unknown>;
const callsOf = (f: { orderId: string }): ConfirmCall[] => sim.calls.filter((c) => c.orderId === f.orderId);
const typesOf = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

/** 그 주문의 원장 한 행과 이력·명령 행 */
async function ledger(f: { orderId: string }): Promise<{ p: LedgerRow; events: Awaited<ReturnType<typeof ledgerOf>>['events']; jobs: Awaited<ReturnType<typeof ledgerOf>>['jobs'] }> {
  const l = await ledgerOf(admin, f.orderId);
  expect(l.payments).toHaveLength(1);
  return { p: l.payments[0] as LedgerRow, events: l.events, jobs: l.jobs };
}

/** 결제사 SIMULATOR의 payment_confirm_total 값(칸이 pg마다 있으므로 pg까지 고른다) */
function confirmCount(text: string, outcome: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${TOTAL}{`) && l.includes('pg="SIMULATOR"') && l.includes(`outcome="${outcome}"`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

function metricValue(text: string, name: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

const depositAnswer: Rewrite = (j) => ({ ...j, status: 'WAITING_FOR_DEPOSIT' });

// ───────────────────────────── 1. 승인 끝까지 ─────────────────────────────

describe('승인 끝까지', () => {
  test('PRF181_승인 명령을 잡아 부르면 원장 APPROVED·승인 시각·상태 변경 시각, 내부 표시와 수출 사건, Outbox(trade.payments, 키 회차), 명령 행 지움이 함께 쓰인다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const f = await accepted();
    h.clock.advance(250);
    const now = h.clock.now();
    const before = await h.metrics();

    expect(await drive(h.runner('pod-a'))).toBe(1);

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'APPROVED', failure_category: null });
    expect(p.approved_at!.getTime()).toBe(SIM_NOW_MS);
    expect(p.status_changed_at.getTime()).toBe(now);

    expect(events.map((e) => [e.seq, e.type, e.exported])).toEqual([
      ['1', 'ACCEPTED', false],
      ['2', 'CONFIRM_SENT', false],
      ['3', 'APPROVED', true],
    ]);
    expect(events[1]!.event_key).toBe(paymentEventKey(f.paymentId, 2));
    expect(events[2]!.event_key).toBe(paymentEventKey(f.paymentId, 3));
    expect(events[1]!.occurred_at.getTime()).toBe(now);
    expect(events[2]!.occurred_at.getTime()).toBe(SIM_NOW_MS);
    expect(jobs).toEqual([]);

    const rows = await outboxOf(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: TRADE_PAYMENTS_TOPIC, msg_key: f.eventId, sent_at: null });
    expect(TRADE_PAYMENTS_TOPIC).toBe('trade.payments');
    const v = valueOf(rows[0]!);
    expect(v).toMatchObject({
      eventId: f.eventId,
      orderId: f.orderId,
      pg: 'SIMULATOR',
      type: 'APPROVED',
      amount: f.amount,
      payMethodCategory: 'CARD',
      refMissing: true,
      result: 'APPROVED',
      attemptNo: 1,
      eventSeq: 3,
      eventKey: paymentEventKey(f.paymentId, 3),
    });
    expect(Date.parse(String(v.occurredAt))).toBe(SIM_NOW_MS);
    expect(v.failureCategory).toBeUndefined();
    expect(Number.isInteger(v.latencyMs)).toBe(true);

    expect(callsOf(f)).toEqual([{ orderId: f.orderId, paymentKey: f.paymentKey, amount: f.amount, idemKey: `confirm-${f.orderId}` }]);
    expect(await sim.approvals(f.orderId)).toBe(1);
    const text = await h.metrics();
    expect(confirmCount(text, 'approved') - confirmCount(before, 'approved')).toBe(1);
    expect(metricValue(text, 'payment_confirm_in_flight')).toBe(0);
  });

  test('PRF181_CONFIRM_SENT는 부르기 전에 커밋되어 있고, 호출하는 동안 실행기는 결제 행·명령 행의 잠금을 쥐고 있지 않다(결제사는 트랜잭션 밖) [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const f = await accepted();
    let seen: string[] = [];
    sim.beforeCall.set(f.orderId, async () => {
      seen = typesOf((await ledgerOf(admin, f.orderId)).events);
      // 잠겨 있으면 55P03으로 실패해 응답이 끊기고 UNKNOWN으로 드러난다
      await q('select 1 from payment where id = $1 for update nowait', [f.paymentId]);
      await q('select 1 from payment_confirm_job where payment_id = $1 for update nowait', [f.paymentId]);
    });

    await drive(h.runner('pod-a'));

    expect(seen).toEqual(['ACCEPTED', 'CONFIRM_SENT']);
    expect((await ledger(f)).p.status).toBe('APPROVED');
  });

  test('PRF181_Outbox 쓰기가 실패하면 원장·수출 사건·명령 행 지움까지 함께 되돌아가고, 100·400ms 뒤 다시 해도 안 되면 행을 남겨 임대가 끝난 뒤 다른 실행기가 부르지 않고 UNKNOWN으로 맞춘다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    await q('insert into test_hooks.fail_outbox_key (msg_key) values ($1)', [f.eventId]);
    const before = await h.metrics();
    const slept: number[] = [];

    await drive(h.runner('pod-a', { sleep: async (ms) => void slept.push(ms) }));

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'ACCEPTED', approved_at: null });
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ lease_owner: 'pod-a', attempts: 0 });
    expect(await outboxOf(f)).toEqual([]);
    expect(slept).toEqual([100, 400]);
    expect(callsOf(f)).toHaveLength(1);
    const text = await h.metrics();
    expect(metricValue(text, WRITE_FAILURES) - metricValue(before, WRITE_FAILURES)).toBe(1);
    expect(confirmCount(text, 'approved')).toBe(confirmCount(before, 'approved'));

    const lines = h.logs.filter((l) => l.includes('payment-confirm-write-failed') && l.includes(f.orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('finish');
    expect(lines[0]).not.toContain('test-forced-failure');
    expect(lines[0]).not.toMatch(/insert into/i);

    await q('delete from test_hooks.fail_outbox_key where msg_key = $1', [f.eventId]);
    h.clock.advance(CONFIRM_LEASE_MS + 1);
    expect(await drive(h.runner('pod-b'))).toBe(1);
    expect((await ledger(f)).p.status).toBe('UNKNOWN');
    expect(callsOf(f)).toHaveLength(1);
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
  });

  test('PRF181_명령 행을 지우지 못하면 원장·수출 사건·Outbox도 함께 되돌아간다(나눠 커밋하지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const f = await accepted();
    await q('insert into test_hooks.fail_job_delete (payment_id) values ($1)', [f.paymentId]);

    await drive(h.runner('pod-a', { sleep: async () => {} }));

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'ACCEPTED', approved_at: null });
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT']);
    expect(jobs).toHaveLength(1);
    expect(await outboxOf(f)).toEqual([]);
  });

  test('PRF181_CONFIRM_SENT를 쓰지 못하면 결제사를 부르지 않고 행을 남기며, 원인이 사라지면 표시 없는 잔해로 이어 가 승인한다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const f = await accepted();
    await q(`insert into test_hooks.fail_event (payment_id, type) values ($1, 'CONFIRM_SENT')`, [f.paymentId]);

    await drive(h.runner('pod-a', { sleep: async () => {} }));

    expect(callsOf(f)).toEqual([]);
    expect(await sim.approvals(f.orderId)).toBe(0);
    const held = await ledger(f);
    expect(held.p.status).toBe('ACCEPTED');
    expect(typesOf(held.events)).toEqual(['ACCEPTED']);
    expect(held.jobs).toHaveLength(1);

    await q('delete from test_hooks.fail_event where payment_id = $1', [f.paymentId]);
    h.clock.advance(CONFIRM_LEASE_MS + 1);
    await drive(h.runner('pod-b'));

    expect((await ledger(f)).p.status).toBe('APPROVED');
    expect(callsOf(f)).toHaveLength(1);
  });

  test('PRF181_원장이 이미 ACCEPTED가 아니면 부르지 않고 명령 행만 지운다', async () => {
    const h = await harness();
    const f = await accepted();
    await q('update payment set status = $2 where id = $1', [f.paymentId, 'CANCELED']);

    expect(await drive(h.runner('pod-a'))).toBe(1);

    const { p, events, jobs } = await ledger(f);
    expect(p.status).toBe('CANCELED');
    expect(typesOf(events)).toEqual(['ACCEPTED']);
    expect(jobs).toEqual([]);
    expect(callsOf(f)).toEqual([]);
    expect(await outboxOf(f)).toEqual([]);
  });

  test('PRF181_start는 실제 타이머로 명령을 처리하고 stop 뒤에는 새 명령을 잡지 않는다', async () => {
    const h = await harness();
    const f = await accepted();
    const runner = new PaymentConfirmRunner({ ...h.deps('pod-loop'), pollIntervalMs: 20 });
    runner.start();
    try {
      await until(async () => (await ledger(f)).p.status === 'APPROVED', '승인', 10_000, 20);
    } finally {
      await runner.stop();
    }
    expect(callsOf(f)).toHaveLength(1);

    const g = await accepted();
    expect((await runner.tick()).claimed).toBe(0);
    expect((await ledger(g)).jobs[0]).toMatchObject({ lease_owner: null, attempts: 0 });
    expect(callsOf(g)).toEqual([]);
  });
});

// ───────────────────────────── 2. 결제사의 답 ─────────────────────────────

describe('결제사의 답', () => {
  test.each([
    ['REJECT_CARD_PAYMENT', 'CARD_DECLINED'],
    ['PAY_PROCESS_CANCELED', 'USER_ABORTED'],
  ])('PRF181_거절 %s는 FAILED·실패 범주 %s, 수출 사건 FAILED이고 명령 행을 지운다', async (code, category) => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'decline', code });
    const before = await h.metrics();

    await drive(h.runner('pod-a'));

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'FAILED', failure_category: category, approved_at: null });
    expect(p.status_changed_at.getTime()).toBe(h.clock.now());
    expect(events.map((e) => [e.type, e.exported])).toEqual([
      ['ACCEPTED', false],
      ['CONFIRM_SENT', false],
      ['FAILED', true],
    ]);
    expect(jobs).toEqual([]);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'FAILED', result: 'DECLINED', failureCategory: category, eventSeq: 3, refMissing: true });
    expect(await sim.approvals(f.orderId)).toBe(0);
    expect(confirmCount(await h.metrics(), 'declined') - confirmCount(before, 'declined')).toBe(1);
  });

  test('PRF181_입금 대기 답은 AWAITING_DEPOSIT, 수출 사건 AWAITING_DEPOSIT이고 명령 행을 지운다', async () => {
    const h = await harness();
    const f = await accepted();
    sim.rewrites.set(f.orderId, depositAnswer);
    const before = await h.metrics();

    await drive(h.runner('pod-a'));

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'AWAITING_DEPOSIT', approved_at: null, failure_category: null });
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'AWAITING_DEPOSIT']);
    expect(events[2]!.exported).toBe(true);
    expect(jobs).toEqual([]);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' });
    expect(confirmCount(await h.metrics(), 'waiting') - confirmCount(before, 'waiting')).toBe(1);
  });

  test('PRF181_처리 중이면 원장은 ACCEPTED 그대로 1초·2초 뒤 같은 멱등키로 다시 보내 승인하고, 표시는 1개, 시뮬레이터 승인도 1건이다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'in-progress', times: 2 });
    const before = await h.metrics();
    const runner = h.runner('pod-a');

    await drive(runner);
    let l = await ledger(f);
    expect(l.p.status).toBe('ACCEPTED');
    expect(typesOf(l.events)).toEqual(['ACCEPTED', 'CONFIRM_SENT']);
    expect(await outboxOf(f)).toEqual([]);
    expect(l.jobs[0]).toMatchObject({ lease_owner: null, lease_until: null, attempts: 1 });
    expect(l.jobs[0]!.next_attempt_at.getTime()).toBe(h.clock.now() + 1_000);

    h.clock.advance(999);
    expect(await drive(runner)).toBe(0);
    expect(callsOf(f)).toHaveLength(1);

    h.clock.advance(1);
    expect(await drive(runner)).toBe(1);
    l = await ledger(f);
    expect(l.jobs[0]).toMatchObject({ lease_owner: null, attempts: 2 });
    expect(l.jobs[0]!.next_attempt_at.getTime()).toBe(h.clock.now() + 2_000);

    h.clock.advance(2_000);
    expect(await drive(runner)).toBe(1);

    l = await ledger(f);
    expect(l.p.status).toBe('APPROVED');
    expect(typesOf(l.events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'APPROVED']);
    expect(l.jobs).toEqual([]);
    const calls = callsOf(f);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.idemKey))).toEqual(new Set([`confirm-${f.orderId}`]));
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(await outboxOf(f)).toHaveLength(1);
    const text = await h.metrics();
    expect(confirmCount(text, 'in_progress') - confirmCount(before, 'in_progress')).toBe(2);
    expect(confirmCount(text, 'approved') - confirmCount(before, 'approved')).toBe(1);
  });

  test('PRF181_429(THROTTLED)는 실패로 쓰지 않고 다음 시도만 늦춰 다시 보내 승인한다', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'throttle' });
    const runner = h.runner('pod-a');

    await drive(runner);

    const held = await ledger(f);
    expect(held.p).toMatchObject({ status: 'ACCEPTED', failure_category: null });
    expect(held.jobs[0]).toMatchObject({ lease_owner: null, attempts: 1 });
    expect(held.jobs[0]!.next_attempt_at.getTime()).toBe(h.clock.now() + 1_000);
    expect(await outboxOf(f)).toEqual([]);

    h.clock.advance(1_000);
    await drive(runner);

    expect((await ledger(f)).p.status).toBe('APPROVED');
    expect(callsOf(f)).toHaveLength(2);
    expect(await sim.approvals(f.orderId)).toBe(1);
  });

  test('PRF181_이미 승인된 결제(ALREADY_APPROVED)는 금액이 맞으면 APPROVED로 쓰고 사건의 result가 ALREADY_APPROVED다', async () => {
    const h = await harness();
    const f = await accepted();
    // 다른 호출이 먼저 승인했다(멱등키 없이 보내 멱등 기록이 남지 않는다)
    expect((await sim.control('POST', '/v1/payments/confirm', { paymentKey: f.paymentKey, orderId: f.orderId, amount: f.amount })).status).toBe(200);
    const before = await h.metrics();

    await drive(h.runner('pod-a'));

    const { p } = await ledger(f);
    expect(p.status).toBe('APPROVED');
    expect(p.approved_at!.getTime()).toBe(SIM_NOW_MS);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'APPROVED', result: 'ALREADY_APPROVED' });
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(confirmCount(await h.metrics(), 'already') - confirmCount(before, 'already')).toBe(1);
  });

  test.each<[string, Rewrite]>([
    ['승인 금액이 원장과 다르면', (j) => ({ ...j, totalAmount: (j.totalAmount as number) + 1 })],
    ['승인 금액이 답에 없으면', ({ totalAmount: _dropped, ...rest }) => rest],
  ])('PRF181_%s APPROVED로 쓰지 않고 UNKNOWN과 SEV1 로그 한 줄(주문 ID와 차이 여부만)이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async (_name, rewrite) => {
    const h = await harness();
    const f = await accepted();
    sim.rewrites.set(f.orderId, rewrite);
    const before = await h.metrics();

    await drive(h.runner('pod-a'));

    const { p, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', approved_at: null, failure_category: null });
    expect(jobs).toEqual([]);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
    expect(confirmCount(await h.metrics(), 'unknown') - confirmCount(before, 'unknown')).toBe(1);

    const lines = h.logs.filter((l) => l.includes('payment-confirm-amount-mismatch') && l.includes(f.orderId));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line.level).toBe('error');
    expect(lines[0]).toContain('SEV1');
    expect(Object.keys(line).filter((k) => /amount$|payment_?key|token/i.test(k) && !/mismatch/i.test(k))).toEqual([]);
    expect(lines[0]).not.toContain(f.paymentKey);
    expect(Object.values(line)).not.toContain(f.amount);
  });

  test.each<[string, 'APPROVED' | 'FAILED' | 'AWAITING_DEPOSIT' | 'UNKNOWN', (f: Accepted) => Promise<unknown> | undefined, boolean]>([
    ['승인', 'APPROVED', () => undefined, true],
    ['거절', 'FAILED', (f) => sim.fault(f.orderId, { kind: 'decline', code: 'REJECT_CARD_PAYMENT' }), true],
    ['입금 대기', 'AWAITING_DEPOSIT', (f) => Promise.resolve(sim.rewrites.set(f.orderId, depositAnswer)), true],
    ['결과 모름', 'UNKNOWN', (f) => sim.fault(f.orderId, { kind: 'drop', applied: true }), false],
  ])('PRF181_%s로 끝나면 포트원 토큰 칸은 결과가 정해졌을 때만 지운다(%s) [ASVS v5.0.0-14.2.7]', async (_name, status, arrange, cleared) => {
    const h = await harness();
    const f = await accepted();
    const token = `test_token_${randomUUID()}`;
    secrets.push(token);
    await q('update payment set pg_confirm_token = $2 where id = $1', [f.paymentId, token]);
    await arrange(f);

    await drive(h.runner('pod-a'));

    const { p } = await ledger(f);
    expect(p.status).toBe(status);
    expect(p.pg_confirm_token).toBe(cleared ? null : token);
  });
});

// ───────────────────────────── 2-1. 리뷰 고침 ─────────────────────────────

describe('리뷰 고침(BUILD_ORDER PRF-181, 코드 리뷰)', () => {
  test('PRF181_리뷰 고침 H1: 결제사는 승인했는데 조회 금액이 원장과 다르면 FAILED가 아니라 UNKNOWN과 SEV1 로그다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    expect((await sim.control('POST', '/v1/payments/confirm', { paymentKey: f.paymentKey, orderId: f.orderId, amount: f.amount })).status).toBe(200);
    await q('update payment set amount = $2 where id = $1', [f.paymentId, f.amount + 1]);

    await drive(h.runner('pod-a'));

    const { p, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', approved_at: null, failure_category: null });
    expect(jobs).toEqual([]);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(h.logs.filter((l) => l.includes('payment-confirm-amount-mismatch') && l.includes(f.orderId))).toHaveLength(1);
  });

  test('PRF181_리뷰 고침 M3: 처리 중이라 다시 보낸 호출을 결제사가 401로 거절하면 FAILED가 아니라 UNKNOWN이다(첫 요청이 그 뒤에도 승인될 수 있다) [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'in-progress' });

    await drive(h.runner('pod-a'));
    expect((await ledger(f)).p.status).toBe('ACCEPTED');
    h.clock.advance(1_000);
    await drive(h.runner('pod-a', { gateways: new StaticPaymentGateways([sim.gateway({ secretKey: 'sim_sk_wrong_wrong_wrong_wrong' })]) }));

    const { p, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', failure_category: null });
    expect(jobs).toEqual([]);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
    expect(callsOf(f)).toHaveLength(2);
  });

  test('PRF181_리뷰 고침 M3: 처리 중이라 다시 보낸 호출의 카드 거절은 그대로 FAILED다', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'in-progress' });
    await drive(h.runner('pod-a'));
    h.clock.advance(1_000);
    await sim.fault(f.orderId, { kind: 'decline', code: 'REJECT_CARD_PAYMENT' });

    await drive(h.runner('pod-a'));

    expect((await ledger(f)).p).toMatchObject({ status: 'FAILED', failure_category: 'CARD_DECLINED' });
  });

  test('PRF181_리뷰 고침 L9: 잡아도 attempts는 오르지 않고 어댑터 없음으로 미뤄도 그대로이며, 처리 중으로 미룰 때만 올라 첫 간격이 1초다', async () => {
    const h = await harness();
    const f = await accepted();

    const [claimed] = await h.jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS);
    expect(claimed).toMatchObject({ attempts: 0, hadPreviousOwner: false });
    expect((await ledger(f)).jobs[0]).toMatchObject({ attempts: 0 });
    await h.jobs.release(claimed!);

    const none = h.runner('pod-none', { gateways: new StaticPaymentGateways([]) });
    await drive(none);
    h.clock.advance(CONFIRM_NO_ADAPTER_DELAY_MS);
    await drive(none);
    expect((await ledger(f)).jobs[0]).toMatchObject({ attempts: 0, lease_owner: null });

    h.clock.advance(CONFIRM_NO_ADAPTER_DELAY_MS);
    await sim.fault(f.orderId, { kind: 'in-progress' });
    await drive(h.runner('pod-a'));

    const l = await ledger(f);
    expect(l.jobs[0]).toMatchObject({ attempts: 1, lease_owner: null });
    expect(l.jobs[0]!.next_attempt_at.getTime()).toBe(h.clock.now() + 1_000);
  });

  test('PRF181_리뷰 고침 L6: 재전송 앞의 임대 확인이 실제 저장소에서 ALREADY이고 표시를 더 쓰지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'in-progress' });
    await drive(h.runner('pod-a'));
    h.clock.advance(1_000);
    const seen: string[] = [];
    const jobs = h.jobs;
    const spying = new Proxy(jobs, {
      get(t, name) {
        if (name === 'markSent') {
          return async (job: ConfirmJob) => {
            const r = await t.markSent(job);
            seen.push(r);
            return r;
          };
        }
        const v = Reflect.get(t, name, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });

    await drive(h.runner('pod-a', { jobs: spying }));

    expect(seen).toEqual(['ALREADY']);
    const { p, events } = await ledger(f);
    expect(p.status).toBe('APPROVED');
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'APPROVED']);
  });
});

// ───────────────────────────── 3. 결과 모름 ─────────────────────────────

describe('결과 모름', () => {
  test('PRF181_응답을 잃으면(결제사는 승인함) 결과를 가정하지 않고 UNKNOWN·수출 사건 UNKNOWN이고 시뮬레이터 원장은 승인 1건이다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'drop', applied: true });
    const before = await h.metrics();

    await drive(h.runner('pod-a'));

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', approved_at: null, failure_category: null });
    expect(p.status_changed_at.getTime()).toBe(h.clock.now());
    expect(events.map((e) => [e.type, e.exported])).toEqual([
      ['ACCEPTED', false],
      ['CONFIRM_SENT', false],
      ['UNKNOWN', true],
    ]);
    expect(jobs).toEqual([]);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN', eventSeq: 3 });
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(callsOf(f)).toHaveLength(1);
    expect(confirmCount(await h.metrics(), 'unknown') - confirmCount(before, 'unknown')).toBe(1);
  });

  test.each<[string, Record<string, unknown>]>([
    ['결제사 오류(반영함)', { kind: 'pg-error', applied: true }],
    ['결제사 오류(반영 안 함)', { kind: 'pg-error', applied: false }],
    ['응답 유실(반영 안 함)', { kind: 'drop', applied: false }],
  ])('PRF181_%s도 UNKNOWN이고 다시 부르지 않는다 [ASVS v5.0.0-16.5.2]', async (_name, fault) => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, fault);

    await drive(h.runner('pod-a'));

    const { p, jobs } = await ledger(f);
    expect(p.status).toBe('UNKNOWN');
    expect(jobs).toEqual([]);
    expect(callsOf(f)).toHaveLength(1);
  });

  test('PRF181_읽기 시간 초과는 UNKNOWN이다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'delay', ms: 500 });

    await drive(h.runner('pod-a', { gateways: new StaticPaymentGateways([sim.gateway({ readTimeoutMs: 100 })]) }));

    expect((await ledger(f)).p.status).toBe('UNKNOWN');
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
  });

  test('PRF181_연결 실패는 UNKNOWN이다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = await harness();
    const f = await accepted();
    const closed = sim.gateway({ baseUrl: 'http://127.0.0.1:1', fetch });

    await drive(h.runner('pod-a', { gateways: new StaticPaymentGateways([closed]) }));

    expect((await ledger(f)).p.status).toBe('UNKNOWN');
    expect(await sim.approvals(f.orderId)).toBe(0);
  });

  test('PRF181_어댑터가 없으면 부르지 않고 30초 뒤로 미루며 기한이 지났어도 실패로 쓰지 않고 경고 한 줄과 no_adapter를 남긴다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = await harness();
    const f = await accepted({ authenticatedAtMs: h.clock.now() - DEADLINE_MS - 1 });
    const before = await h.metrics();

    await drive(h.runner('pod-none', { gateways: new StaticPaymentGateways([]) }));

    const { p, events, jobs } = await ledger(f);
    expect(p.status).toBe('ACCEPTED');
    expect(typesOf(events)).toEqual(['ACCEPTED']);
    expect(jobs[0]).toMatchObject({ lease_owner: null, lease_until: null, attempts: 0 });
    expect(jobs[0]!.next_attempt_at.getTime()).toBe(h.clock.now() + CONFIRM_NO_ADAPTER_DELAY_MS);
    expect(await outboxOf(f)).toEqual([]);
    expect(callsOf(f)).toEqual([]);
    expect(confirmCount(await h.metrics(), 'no_adapter') - confirmCount(before, 'no_adapter')).toBe(1);
    expect(h.logs.filter((l) => l.includes('payment-confirm-no-adapter')).length).toBeGreaterThanOrEqual(1);
  });
});

// ───────────────────────────── 4. 승인 기한 ─────────────────────────────

describe('승인 기한', () => {
  test('P-T6_기한이 지난 명령은 시뮬레이터를 부르지 않고 FAILED(EXPIRED), 표시 없이 수출 사건 FAILED로 끝나며 과금 0건이다 [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await accepted({ authenticatedAtMs: h.clock.now() - DEADLINE_MS });
    const before = await h.metrics();

    expect(await drive(h.runner('pod-a'))).toBe(1);

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'FAILED', failure_category: 'EXPIRED', approved_at: null });
    expect(events.map((e) => [e.seq, e.type, e.exported])).toEqual([
      ['1', 'ACCEPTED', false],
      ['2', 'FAILED', true],
    ]);
    expect(jobs).toEqual([]);
    expect(callsOf(f)).toEqual([]);
    expect(await sim.approvals(f.orderId)).toBe(0);
    const v = valueOf((await outboxOf(f))[0]!);
    expect(v).toMatchObject({ type: 'FAILED', failureCategory: 'EXPIRED', eventSeq: 2 });
    expect(v.result).toBeUndefined();
    expect(v.latencyMs).toBeUndefined();
    expect(confirmCount(await h.metrics(), 'expired') - confirmCount(before, 'expired')).toBe(1);
  });

  test('P-T6_기한 1ms 전이면 부른다(경계: 지금 >= 인증 + 기한일 때만 지난 것이다)', async () => {
    const h = await harness();
    const f = await accepted({ authenticatedAtMs: h.clock.now() - DEADLINE_MS + 1 });

    await drive(h.runner('pod-a'));

    expect((await ledger(f)).p.status).toBe('APPROVED');
    expect(callsOf(f)).toHaveLength(1);
  });

  test('P-T6_처리 중이라 다시 보내던 명령이 기한을 넘기면 다시 부르지 않고 UNKNOWN이다(기한 전에 보낸 요청은 기한 뒤에도 승인될 수 있다) [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await accepted({ authenticatedAtMs: h.clock.now() - DEADLINE_MS + 500 });
    await sim.fault(f.orderId, { kind: 'in-progress' });
    const runner = h.runner('pod-a');

    await drive(runner);
    expect((await ledger(f)).p.status).toBe('ACCEPTED');
    h.clock.advance(1_000);
    await drive(runner);

    const { p, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', failure_category: null });
    expect(jobs).toEqual([]);
    expect(callsOf(f)).toHaveLength(1);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
  });
});

// ───────────────────────────── 5. 잡기 ─────────────────────────────

describe('잡기', () => {
  test('PRF181_두 실행기가 동시에 돌아도 명령 50건을 하나씩만 잡아 결제사 호출 수가 건수와 같다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const fs = await Promise.all(Array.from({ length: 50 }, () => accepted()));
    const a = h.runner('pod-a');
    const b = h.runner('pod-b', { jobs: h.otherJobs });

    let claimed = 0;
    for (let round = 0; round < 30; round += 1) {
      const [x, y] = await Promise.all([a.tick(), b.tick()]);
      await Promise.all([a.whenIdle(), b.whenIdle()]);
      if (x.claimed + y.claimed === 0) break;
      claimed += x.claimed + y.claimed;
    }

    expect(claimed).toBe(50);
    expect(sim.calls).toHaveLength(50);
    expect(new Set(sim.calls.map((c) => c.orderId)).size).toBe(50);
    for (const f of fs) {
      const { p, events, jobs } = await ledger(f);
      expect(p.status).toBe('APPROVED');
      expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'APPROVED']);
      expect(jobs).toEqual([]);
    }
    const n = await q<{ n: string }>('select count(*) as n from outbox where msg_key = any($1::text[])', [fs.map((f) => f.eventId)]);
    expect(n[0]!.n).toBe('50');
  }, 90_000);

  test('PRF181_동시 잡기는 서로 겹치지 않고 임대·시도 수를 쓰며, 임대가 끝나기 전에는 다시 잡히지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const fs = await Promise.all(Array.from({ length: 20 }, () => accepted()));

    const [a, b] = await Promise.all([h.jobs.claimDue('SIMULATOR', 20, 'pod-a', CONFIRM_LEASE_MS), h.otherJobs.claimDue('SIMULATOR', 20, 'pod-b', CONFIRM_LEASE_MS)]);

    const ids = [...a, ...b].map((j) => j.paymentId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect([...a, ...b].every((j) => j.attempts === 0 && !j.hadPreviousOwner && j.leaseUntilMs === h.clock.now() + CONFIRM_LEASE_MS)).toBe(true);
    expect(a.every((j) => j.owner === 'pod-a')).toBe(true);
    const rows = await q<{ lease_owner: string; lease_until: Date; attempts: number }>('select lease_owner, lease_until, attempts from payment_confirm_job where payment_id = any($1::uuid[])', [fs.map((f) => f.paymentId)]);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.attempts === 0 && r.lease_until.getTime() === h.clock.now() + CONFIRM_LEASE_MS)).toBe(true);

    expect(await h.jobs.claimDue('SIMULATOR', 20, 'pod-c', CONFIRM_LEASE_MS)).toEqual([]);
  });

  test('PRF181_임대 경계: lease_until과 같은 시각에는 잡히지 않고 1ms 지나면 앞 소유자 표시와 함께 잡힌다', async () => {
    const h = await harness();
    const f = await accepted();
    expect(await h.jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS)).toHaveLength(1);

    h.clock.advance(CONFIRM_LEASE_MS);
    expect(await h.jobs.claimDue('SIMULATOR', 1, 'pod-b', CONFIRM_LEASE_MS)).toEqual([]);

    h.clock.advance(1);
    expect(await h.jobs.claimDue('SIMULATOR', 1, 'pod-b', CONFIRM_LEASE_MS)).toEqual([expect.objectContaining({ paymentId: f.paymentId, owner: 'pod-b', attempts: 0, hadPreviousOwner: true })]);
  });

  test('PRF181_잡기는 기한이 된 행만 limit개, next_attempt_at 차례로 돌려주고 틀린 인자는 RangeError다', async () => {
    const h = await harness();
    const [early, late, future] = await Promise.all([accepted(), accepted(), accepted()]);
    const now = h.clock.now();
    await q('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [early.paymentId, new Date(now - 2_000)]);
    await q('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [late.paymentId, new Date(now - 1_000)]);
    await q('update payment_confirm_job set next_attempt_at = $2 where payment_id = $1', [future.paymentId, new Date(now + 1)]);

    expect((await h.jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS)).map((j) => j.paymentId)).toEqual([early.paymentId]);
    expect((await h.jobs.claimDue('SIMULATOR', 5, 'pod-a', CONFIRM_LEASE_MS)).map((j) => j.paymentId)).toEqual([late.paymentId]);
    await expect(h.jobs.claimDue('SIMULATOR', 0, 'pod-a', CONFIRM_LEASE_MS)).rejects.toBeInstanceOf(RangeError);
    await expect(h.jobs.claimDue('SIMULATOR', 1, '', CONFIRM_LEASE_MS)).rejects.toBeInstanceOf(RangeError);
    await expect(h.jobs.claimDue('SIMULATOR', 1, 'pod-a', 0)).rejects.toBeInstanceOf(RangeError);
  });

  test('PRF181_markSent는 표시를 한 번만 쓰고 임대를 잃었거나 원장이 ACCEPTED가 아니면 쓰지 않으며, 미루기·놓기·지우기도 임대를 잃으면 false다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    expect(await h.jobs.read(newId())).toBeUndefined();
    await expect(h.jobs.read(f.paymentId)).resolves.toMatchObject({ paymentId: f.paymentId, orderId: f.orderId, eventId: f.eventId, attemptNo: 1, pg: 'SIMULATOR', paymentRef: f.paymentKey, amount: f.amount, status: 'ACCEPTED', authenticatedAtMs: f.authenticatedAtMs, confirmSent: false });

    const [mine] = await h.jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS);
    expect(await h.jobs.markSent(mine!)).toBe('MARKED');
    expect(await h.jobs.markSent(mine!)).toBe('ALREADY');
    const { events } = await ledger(f);
    expect(events.map((e) => [e.seq, e.type, e.exported])).toEqual([
      ['1', 'ACCEPTED', false],
      ['2', 'CONFIRM_SENT', false],
    ]);
    expect(events[1]!.event_key).toBe(paymentEventKey(f.paymentId, 2));
    await expect(h.jobs.read(f.paymentId)).resolves.toMatchObject({ confirmSent: true });

    h.clock.advance(CONFIRM_LEASE_MS + 1);
    const [theirs] = await h.jobs.claimDue('SIMULATOR', 1, 'pod-b', CONFIRM_LEASE_MS);
    const lost: ConfirmJob = mine!;
    expect(await h.jobs.markSent(lost)).toBe('LEASE_LOST');
    expect(await h.jobs.reschedule(lost, h.clock.now() + 1_000, { countRetry: true })).toBe(false);
    expect(await h.jobs.release(lost)).toBe(false);
    expect(await h.jobs.dropJob(lost)).toBe(false);
    expect((await ledger(f)).jobs[0]).toMatchObject({ lease_owner: 'pod-b' });

    await q('update payment set status = $2 where id = $1', [f.paymentId, 'CANCELED']);
    expect(await h.jobs.markSent(theirs!)).toBe('STALE');
    expect(await h.jobs.release(theirs!)).toBe(true);
    expect((await ledger(f)).jobs[0]).toMatchObject({ lease_owner: null, lease_until: null });
  });
});

// ───────────────────────────── 6. 임대 잔해 ─────────────────────────────

describe('임대 잔해', () => {
  test('P-T24_호출 중 임대가 끊긴 잔해를 다른 실행기가 부르지 않고 UNKNOWN으로 맞추고, 늦게 온 앞 답은 원장을 덮지 않으며 승인 호출·승인 건수는 1이다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'delay', ms: 3_000 });
    const before = await h.metrics();
    const a = h.runner('pod-a');

    expect((await a.tick()).claimed).toBe(1);
    await until(() => callsOf(f).length === 1, '승인 호출', 10_000, 10);

    // 파드가 강제 종료된 것과 같은 상태: 임대가 끊겼고 답은 아직 없다
    h.clock.advance(CONFIRM_LEASE_MS + 1);
    expect(await drive(h.runner('pod-b', { jobs: h.otherJobs }))).toBe(1);

    let l = await ledger(f);
    expect(l.p).toMatchObject({ status: 'UNKNOWN', approved_at: null });
    expect(l.events.map((e) => [e.type, e.exported])).toEqual([
      ['ACCEPTED', false],
      ['CONFIRM_SENT', false],
      ['UNKNOWN', true],
    ]);
    expect(l.jobs).toEqual([]);
    expect(callsOf(f)).toHaveLength(1);
    expect(valueOf((await outboxOf(f))[0]!)).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
    expect(confirmCount(await h.metrics(), 'restart') - confirmCount(before, 'restart')).toBe(1);

    await a.whenIdle();

    l = await ledger(f);
    expect(l.p).toMatchObject({ status: 'UNKNOWN', approved_at: null });
    expect(typesOf(l.events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    expect(await outboxOf(f)).toHaveLength(1);
    expect(callsOf(f)).toHaveLength(1);
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(h.logs.filter((x) => x.includes('payment-confirm-stale') && x.includes(f.orderId))).toHaveLength(1);
  }, 60_000);

  test('P-T24_CONFIRM_SENT 커밋 직후 죽으면(호출 전일 수 있어도 구분할 수 없다) 다음 실행기는 부르지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await accepted();
    const [job] = await h.jobs.claimDue('SIMULATOR', 1, 'pod-dead', CONFIRM_LEASE_MS);
    expect(await h.jobs.markSent(job!)).toBe('MARKED');

    h.clock.advance(CONFIRM_LEASE_MS + 1);
    await drive(h.runner('pod-b'));

    const { p, jobs } = await ledger(f);
    expect(p.status).toBe('UNKNOWN');
    expect(jobs).toEqual([]);
    expect(callsOf(f)).toEqual([]);
    expect(await sim.approvals(f.orderId)).toBe(0);
    expect(valueOf((await outboxOf(f))[0]!).latencyMs).toBeUndefined();
  });

  test('P-T24_CONFIRM_SENT 없는 잔해는 이어서 표시를 쓰고 승인한다(호출이 나가지 않았음이 확실하다)', async () => {
    const h = await harness();
    const f = await accepted();
    await h.jobs.claimDue('SIMULATOR', 1, 'pod-dead', CONFIRM_LEASE_MS);

    h.clock.advance(CONFIRM_LEASE_MS + 1);
    await drive(h.runner('pod-b'));

    const { p, events } = await ledger(f);
    expect(p.status).toBe('APPROVED');
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'APPROVED']);
    expect(callsOf(f)).toHaveLength(1);
    expect(await sim.approvals(f.orderId)).toBe(1);
  });

  test('P-T24_임대가 살아 있으면 다른 실행기가 잡지 않는다(호출 중인 명령에 끼어들지 않는다)', async () => {
    const h = await harness();
    const f = await accepted();
    await h.jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS);
    await q(`insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, 2, $2, 'CONFIRM_SENT', false, now())`, [f.paymentId, paymentEventKey(f.paymentId, 2)]);

    h.clock.advance(CONFIRM_LEASE_MS - 1);
    expect(await drive(h.runner('pod-b'))).toBe(0);

    expect((await ledger(f)).p.status).toBe('ACCEPTED');
    expect(callsOf(f)).toEqual([]);
  });
});

// ───────────────────────────── 7. 계약 ─────────────────────────────

describe('사건 값과 결과 조회', () => {
  const arrangeBy: Record<string, (f: Accepted) => Promise<unknown>> = {
    APPROVED: async () => {},
    FAILED: (f) => sim.fault(f.orderId, { kind: 'decline', code: 'REJECT_CARD_PAYMENT' }),
    AWAITING_DEPOSIT: async (f) => sim.rewrites.set(f.orderId, depositAnswer),
    UNKNOWN: (f) => sim.fault(f.orderId, { kind: 'drop', applied: true }),
  };

  test.each(['APPROVED', 'FAILED', 'AWAITING_DEPOSIT', 'UNKNOWN'])('PRF181_%s 사건 값이 asyncapi zod와 purchase-svc 결과 소비자 decode를 지나고 결제 참조를 싣지 않는다 [ASVS v5.0.0-16.2.5]', async (type) => {
    const h = await harness();
    const f = await accepted();
    await arrangeBy[type]!(f);

    await drive(h.runner('pod-a'));

    const [row, ...rest] = await outboxOf(f);
    expect(rest).toEqual([]);
    const value = valueOf(row!);
    expect(PaymentEvent.safeParse(value).success, JSON.stringify(value)).toBe(true);
    expect(row!.payload.toString('utf8')).not.toContain(f.paymentKey);

    const execute = vi.fn(async () => undefined);
    const handler = new PaymentResultHandler({ execute } as unknown as ConstructorParameters<typeof PaymentResultHandler>[0]);
    const message: ConsumedMessage = { topic: row!.topic, partition: 0, offset: 0n, key: row!.msg_key, value: row!.payload, headers: {}, timestamp: h.clock.now() };
    const record = handler.decode(message);
    expect(record).toMatchObject({ kind: 'event', event: { eventId: f.eventId, orderId: f.orderId, pg: 'SIMULATOR', type, amount: f.amount, refMissing: true, attemptNo: 1, eventSeq: 3, eventKey: paymentEventKey(f.paymentId, 3) } });
    expect(handler.keyOf(record)).toBe(f.orderId);
    expect(handler.eventKeyOf(record)).toBe(paymentEventKey(f.paymentId, 3));
    await handler.handle(record);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('P-T6_기한 지난 실패 사건(result 없음)도 zod와 소비자 decode를 지난다', async () => {
    const h = await harness();
    const f = await accepted({ authenticatedAtMs: h.clock.now() - DEADLINE_MS });

    await drive(h.runner('pod-a'));

    const [row] = await outboxOf(f);
    expect(PaymentEvent.safeParse(valueOf(row!)).success).toBe(true);
    const handler = new PaymentResultHandler({ execute: vi.fn() } as unknown as ConstructorParameters<typeof PaymentResultHandler>[0]);
    expect(handler.decode({ topic: row!.topic, partition: 0, offset: 0n, key: row!.msg_key, value: row!.payload, headers: {}, timestamp: h.clock.now() })).toMatchObject({ kind: 'event', event: { type: 'FAILED', failureCategory: 'EXPIRED', eventSeq: 2 } });
  });

  test('PRF181_거절된 결제의 ConfirmPayment 재전송 답과 BatchGetPayments에 실패 범주가 실리고, 순번·키는 나간 사건과 같으며 재전송은 아무것도 더 쓰지 않는다', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'decline', code: 'REJECT_CARD_PAYMENT' });
    await drive(h.runner('pod-a'));
    const before = await ledgerOf(admin, f.orderId);

    await expect(unary(h.stack.client, 'ConfirmPayment', f.request)).resolves.toMatchObject({ result: 'CONFIRM_RESULT_DECLINED', payment_id: f.paymentId, failure_category: 'FAILURE_CATEGORY_CARD_DECLINED' });
    expect(await ledgerOf(admin, f.orderId)).toEqual(before);

    const { payments } = (await unary(h.stack.client, 'BatchGetPayments', { order_ids: [f.orderId] })) as { payments: Record<string, unknown>[] };
    expect(payments).toHaveLength(1);
    const v = valueOf((await outboxOf(f))[0]!);
    expect(payments[0]).toMatchObject({ status: 'PAYMENT_STATUS_FAILED', failure_category: 'FAILURE_CATEGORY_CARD_DECLINED', event_key: v.eventKey, event_seq: v.eventSeq });
  });

  test('P-T6_기한 넘김 결제도 BatchGetPayments에 EXPIRED 범주가 실린다', async () => {
    const h = await harness();
    const f = await accepted({ authenticatedAtMs: h.clock.now() - DEADLINE_MS });
    await drive(h.runner('pod-a'));

    const { payments } = (await unary(h.stack.client, 'BatchGetPayments', { order_ids: [f.orderId] })) as { payments: Record<string, unknown>[] };

    expect(payments[0]).toMatchObject({ status: 'PAYMENT_STATUS_FAILED', failure_category: 'FAILURE_CATEGORY_EXPIRED' });
  });

  test('PRF181_승인된 결제의 재전송 답과 BatchGetPayments의 승인 시각은 사건의 occurredAt과 같다(사건 길과 당기기가 같은 값)', async () => {
    const h = await harness();
    const f = await accepted();
    await drive(h.runner('pod-a'));

    const reply = await unary(h.stack.client, 'ConfirmPayment', f.request);
    expect(reply).toMatchObject({ result: 'CONFIRM_RESULT_APPROVED', failure_category: 'FAILURE_CATEGORY_UNSPECIFIED' });
    expect(msOf(reply.approved_at)).toBe(SIM_NOW_MS);

    const { payments } = (await unary(h.stack.client, 'BatchGetPayments', { order_ids: [f.orderId] })) as { payments: Record<string, unknown>[] };
    const v = valueOf((await outboxOf(f))[0]!);
    expect(payments[0]).toMatchObject({ status: 'PAYMENT_STATUS_APPROVED', event_key: v.eventKey, event_seq: v.eventSeq });
    expect(msOf(payments[0]!.approved_at)).toBe(Date.parse(String(v.occurredAt)));
  });

  test('PRF181_마이그레이션 0001: failure_category는 여섯 값과 빈 값만 받고 그 밖은 23514다', async () => {
    const f = await accepted();
    for (const category of ['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED', null]) {
      await expect(q('update payment set failure_category = $2 where id = $1', [f.paymentId, category]), String(category)).resolves.toBeDefined();
    }
    for (const bad of ['card_declined', 'OTHER', '']) {
      await expect(q('update payment set failure_category = $2 where id = $1', [f.paymentId, bad]), bad).rejects.toMatchObject({ code: '23514', constraint: 'payment_failure_category_check' });
    }
  });
});

// ───────────────────────────── 8. 문장 ─────────────────────────────

/** EXPLAIN(FORMAT JSON) 계획의 노드들(평평하게) */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const kids = (plan.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...kids.flatMap(planNodes)];
}

/** fn이 도는 동안 이 프로세스의 pg.Client로 나간 문장을 모은다 */
async function statementsDuring(fn: () => Promise<unknown>): Promise<{ text: string; values: unknown[] }[]> {
  const spy = vi.spyOn(pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown }, 'query');
  try {
    await fn();
    return spy.mock.calls.map(([a, b]) => ({
      text: typeof a === 'string' ? a : String((a as { text?: unknown }).text),
      values: Array.isArray(b) ? (b as unknown[]) : (((a as { values?: unknown[] }).values as unknown[] | undefined) ?? []),
    }));
  } finally {
    spy.mockRestore();
  }
}

/** 운영처럼 명령 표를 크게(2만 건, 대부분 미래의 재시도) 같은 트랜잭션에 넣고 통계를 낸 뒤 문장의 실행 계획을 낸다(되돌려 남기지 않는다) */
async function planOnBigTable(s: { text: string; values: unknown[] }): Promise<Record<string, unknown>[]> {
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, status_changed_at)
       select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'SIMULATOR', 'big', 1, 'ACCEPTED', 'k', now(), now() from generate_series(1, 20000)`,
    );
    await client.query(`insert into payment_confirm_job (payment_id, pg, next_attempt_at) select id, pg, now() + interval '30 days' from payment where pg_payment_ref = 'big'`);
    await client.query('analyze payment');
    await client.query('analyze payment_confirm_job');
    const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${s.text}`, s.values);
    return planNodes(r.rows[0]!['QUERY PLAN'][0].Plan);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

describe('문장과 트랜잭션', () => {
  test('P-T40_리뷰 고침 H1: 잡기 문장은 결제 표를 읽지 않고 (pg, next_attempt_at, payment_id) 색인으로 그 채널의 행만 고른다 [ASVS v5.0.0-15.1.3]', async () => {
    const h = await harness();
    await accepted();
    const statements = await statementsDuring(() => h.jobs.claimDue('SIMULATOR', 1, 'pod-plan', CONFIRM_LEASE_MS));
    const claim = statements.find((s) => /skip locked/i.test(s.text));
    expect(claim, JSON.stringify(statements.map((s) => s.text))).toBeDefined();
    expect(claim!.text).not.toMatch(/\bjoin payment\b/i);

    const nodes = await planOnBigTable(claim!);

    expect(nodes.map((n) => n['Index Name']).filter(Boolean)).toContain('payment_confirm_job_claim_idx');
    expect(nodes.filter((n) => n['Relation Name'] === 'payment')).toEqual([]);
    expect(nodes.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
  }, 60_000);

  test('PRF181_잡기 문장은 큰 표에서 잡기 인덱스를 타고 명령 표를 통째로 읽지 않으며 FOR UPDATE SKIP LOCKED다', async () => {
    const h = await harness();
    await accepted();
    const statements = await statementsDuring(() => h.jobs.claimDue('SIMULATOR', 1, 'pod-plan', CONFIRM_LEASE_MS));
    const claim = statements.find((s) => /for update skip locked/i.test(s.text));
    expect(claim, JSON.stringify(statements.map((s) => s.text))).toBeDefined();

    const nodes = await planOnBigTable(claim!);

    expect(nodes.map((n) => n['Index Name']).filter(Boolean)).toContain('payment_confirm_job_claim_idx');
    expect(nodes.filter((n) => n['Node Type'] === 'Seq Scan' && (n['Relation Name'] === 'payment_confirm_job' || n['Relation Name'] === 'payment'))).toEqual([]);
  }, 60_000);

  test('PRF181_잡기 트랜잭션은 READ COMMITTED이고 문장 시간 한도 5초를 건다', async () => {
    const h = await harness();
    await accepted();
    const statements = await statementsDuring(() => h.jobs.claimDue('SIMULATOR', 1, 'pod-plan', CONFIRM_LEASE_MS));
    expect(statements.some((s) => /isolation level read committed/i.test(s.text)), JSON.stringify(statements.map((s) => s.text))).toBe(true);
    const limit = statements.find((s) => s.text.includes("set_config('statement_timeout'"));
    expect(limit, JSON.stringify(statements.map((s) => s.text))).toBeDefined();
    expect(Number(limit!.values[0])).toBe(CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS);
  });

  test('PRF181_답 반영은 payment 행 잠금을 기다린 뒤 상태를 본다(잠금 없이 읽으면 겹친 쓰기를 덮는다) [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    expect(await h.jobs.claimDue('SIMULATOR', 1, 'pod-a', CONFIRM_LEASE_MS)).toHaveLength(1);
    const target = (await h.jobs.read(f.paymentId))!;
    const holder = await admin.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from payment where id = $1 for update', [f.paymentId]);
      const finishing = h.jobs.finish(target, { status: 'APPROVED', result: 'APPROVED', approvedAtMs: h.clock.now() });
      await until(async () => (await q<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name = 'payment-runner-it-a' and wait_event_type = 'Lock'"))[0]!.n > 0, '답 반영의 잠금 기다림', 10_000, 10);
      await holder.query("update payment set status = 'CANCELED' where id = $1", [f.paymentId]);
      await holder.query('commit');

      await expect(finishing).resolves.toBe('STALE');
    } finally {
      holder.release();
    }
    const { p, events } = await ledger(f);
    expect(p.status).toBe('CANCELED');
    expect(typesOf(events)).toEqual(['ACCEPTED']);
    expect(await outboxOf(f)).toEqual([]);
  });

  test('PRF181_실행기 로그 어디에도 결제 키·토큰이 없다(이 파일의 모든 실행 뒤에 본다) [ASVS v5.0.0-16.2.5]', async () => {
    const h = await harness();
    expect(secrets.length).toBeGreaterThan(5);
    const text = h.logs.join('\n');
    for (const v of secrets) expect(text).not.toContain(v);
  });
});
