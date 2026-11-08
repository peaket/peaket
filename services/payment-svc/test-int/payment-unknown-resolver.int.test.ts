// UNKNOWN 조회 실행기(BUILD_ORDER PRF-182)를 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp), 실제 저장소(DrizzleConfirmJobs)로 돈다.
// 정본: docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현'·§4.2 4·5·14번·P-T3, docs/data.md 0002·§5·§5.1, specs/payment.qnt `query`, asyncapi PaymentEvent(RESOLVED, ADR-0073), docs/security/asvs/payment.md.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 세 표를 비운다. 시험 순서는 파일 순서다.
// - UNKNOWN은 실제 길로 만든다: 실제 ConfirmPayment(gRPC) → 승인 실행기 → 시뮬레이터가 응답을 버림(drop). 시계는 스택의 가짜 시계 하나를 함께 쓴다(멈춰 있고 advance로만 간다).
// - 시뮬레이터 시계는 고정이다. 시뮬레이터가 만들 수 없는 조회 답(EXPIRED·금액 어긋남·기록 없음 등)은 어댑터의 fetch에서 실제 응답을 고쳐 어댑터까지 실제로 돈다.
// - 실행기는 손으로 돌린다: tick은 조회를 기다리지 않으므로 drive가 whenIdle까지 기다린다.
// - 트랜잭션 실패는 test_hooks 스키마의 트리거로 만든다. 프로세스 강제 종료(P-T24)는 payment-process.int.test.ts가 본다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { type ConsumedMessage, createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApplyPaymentResult } from '../../purchase-svc/src/modules/booking/application/apply-payment-result.js';
import { PaymentResultHandler } from '../../purchase-svc/src/modules/booking/inbound/payment-result.handler.js';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  DrizzleConfirmJobs,
  PaymentConfirmRunner,
  paymentConfirmLog,
  paymentEventKey,
  PaymentUnknownResolver,
  type PaymentUnknownResolverDeps,
  paymentUnknownLog,
  PromPaymentConfirmSignals,
  PromPaymentUnknownSignals,
  PgCallGuards,
  pgCallGuardLog,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TRADE_PAYMENTS_TOPIC,
  UNKNOWN_OVERDUE_MS,
  UNKNOWN_QUERY_BASE_MS,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { type GrpcStack, ledgerOf, newId, type PaymentRow, startGrpcStack, tossConfirm, type TossFixture, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-09T01:00:00.000Z');
const TOTAL = 'payment_unknown_query_total';

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let otherRunnerDb: Database;
let stacked: Promise<GrpcStack> | undefined;
let sim: Sim;

/** 쓰인 결제 키(로그·값에 실리지 않는지 볼 때) */
const secrets: string[] = [];

interface Sim {
  app: SimulatorApp;
  url: string;
  key: string;
  /** 승인 POST의 주문 ID(어댑터가 실제로 보낸 것) */
  confirms: string[];
  /** 단독 조회 GET의 결제 키 */
  queries: string[];
  /** 결제 키별 조회 응답 고치기 */
  queryHooks: Map<string, (res: Response) => Response | Promise<Response>>;
  fetch: typeof fetch;
  control(method: string, path: string, body?: unknown): Promise<Response>;
  authenticate(orderId: string, amount: number): Promise<string>;
  fault(orderId: string, f: Record<string, unknown>): Promise<void>;
  approvals(orderId: string): Promise<number>;
  gateway(): SimulatorPaymentGateway;
  /** 조회 답의 칸을 고친다 */
  patchQuery(paymentKey: string, patch: Record<string, unknown>): void;
}

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function startSim(): Promise<Sim> {
  // 실행마다 새 시험 키([ASVS v5.0.0-13.3.1])
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const control = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const confirms: string[] = [];
  const queries: string[] = [];
  const queryHooks = new Map<string, (res: Response) => Response | Promise<Response>>();
  const counting: typeof fetch = async (input, init) => {
    const target = String(input);
    if (init?.method === 'POST' && target.endsWith('/v1/payments/confirm')) {
      confirms.push((JSON.parse(String(init.body)) as { orderId: string }).orderId);
      return fetch(input, init);
    }
    if (init?.method === 'GET' && target.includes('/v1/payments/')) {
      const paymentKey = decodeURIComponent(target.slice(target.lastIndexOf('/') + 1));
      queries.push(paymentKey);
      const res = await fetch(input, init);
      const hook = queryHooks.get(paymentKey);
      return hook ? hook(res) : res;
    }
    return fetch(input, init);
  };
  const self: Sim = {
    app,
    url,
    key,
    confirms,
    queries,
    queryHooks,
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
    gateway: () => new SimulatorPaymentGateway({ baseUrl: url, secretKey: key, clientKey: 'sim_ck_test_client', fetch: counting }),
    patchQuery(paymentKey, patch) {
      queryHooks.set(paymentKey, async (res) => json({ ...((await res.json()) as Record<string, unknown>), ...patch }, 200));
    },
  };
  return self;
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-unknown-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-unknown-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-unknown-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-unknown-it-a' });
  otherRunnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-unknown-it-b' });
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
  await admin.pool.query('truncate test_hooks.fail_outbox_key');
  expect((await sim.control('DELETE', '/sim/faults')).status).toBe(204);
  sim.confirms.length = 0;
  sim.queries.length = 0;
  sim.queryHooks.clear();
});

const stack = (): Promise<GrpcStack> => (stacked ??= startGrpcStack({ hot, batch }));
const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query<R>(text, params)).rows;

interface Harness {
  stack: GrpcStack;
  clock: GrpcStack['clock'];
  logs: string[];
  metrics(): Promise<string>;
  /** 승인 실행기(UNKNOWN을 실제 길로 만든다) */
  confirmRunner: PaymentConfirmRunner;
  /** 손으로 돌리는 조회 실행기 */
  resolver(o?: Partial<PaymentUnknownResolverDeps>, db?: 'a' | 'b'): PaymentUnknownResolver;
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
  const confirmSignals = new PromPaymentConfirmSignals().register(metrics.registry);
  const signals = new PromPaymentUnknownSignals().register(metrics.registry);
  const gateways = new StaticPaymentGateways([sim.gateway()]);
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: s.clock });
  const otherJobs = new DrizzleConfirmJobs({ database: otherRunnerDb, clock: s.clock });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  const guards = (): PgCallGuards => new PgCallGuards({ gateways, podCount: 1, clock: s.clock, signals: new PromPgCallGuardSignals(), log: pgCallGuardLog(logger) });
  const confirmRunner = new PaymentConfirmRunner({ jobs, gateways, log: paymentConfirmLog(logger), signals: confirmSignals, clock: s.clock, podId: 'pod-confirm', timer: silent, guards: guards() });
  const log = paymentUnknownLog(logger);
  return {
    stack: s,
    clock: s.clock,
    logs,
    metrics: () => metrics.registry.metrics(),
    confirmRunner,
    resolver: (o = {}, db = 'a') => new PaymentUnknownResolver({ queries: db === 'a' ? jobs : otherJobs, gateways, log, signals, clock: s.clock, timer: silent, guards: guards(), ...o }),
  };
}

const harness = (): Promise<Harness> => (built ??= buildHarness());

async function drive(runner: PaymentUnknownResolver | PaymentConfirmRunner): Promise<number> {
  const { claimed } = await runner.tick();
  await runner.whenIdle();
  return claimed;
}

interface Accepted extends TossFixture {
  paymentId: string;
}

async function accepted(o: { amount?: number } = {}): Promise<Accepted> {
  const s = await stack();
  const orderId = newId();
  const amount = o.amount ?? 39_000;
  const paymentKey = await sim.authenticate(orderId, amount);
  secrets.push(paymentKey);
  const f = tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount, authenticatedAtMs: s.clock.now() - 1_000 });
  const reply = await unary(s.client, 'ConfirmPayment', f.request);
  return { ...f, paymentId: reply.payment_id as string };
}

/** 승인 응답을 버려 UNKNOWN을 만든다(applied: 결제사는 승인함). 돌려줄 때 UNKNOWN이고 첫 조회 시각까지 시계를 민다 */
async function unknownPayment(o: { applied?: boolean; advance?: boolean } = {}): Promise<Accepted> {
  const h = await harness();
  const f = await accepted();
  await sim.fault(f.orderId, { kind: 'drop', applied: o.applied ?? true });
  await drive(h.confirmRunner);
  expect((await ledger(f)).p.status).toBe('UNKNOWN');
  if (o.advance ?? true) h.clock.advance(UNKNOWN_QUERY_BASE_MS);
  return f;
}

type LedgerRow = PaymentRow & { failure_category: string | null; next_query_at: Date | null; query_attempts: number; overdue_at: Date | null };

async function ledger(f: { orderId: string }): Promise<{ p: LedgerRow; events: Awaited<ReturnType<typeof ledgerOf>>['events']; jobs: Awaited<ReturnType<typeof ledgerOf>>['jobs'] }> {
  const l = await ledgerOf(admin, f.orderId);
  expect(l.payments).toHaveLength(1);
  return { p: l.payments[0] as LedgerRow, events: l.events, jobs: l.jobs };
}

interface OutboxRow extends pg.QueryResultRow {
  topic: string;
  msg_key: string;
  payload: Buffer;
  sent_at: Date | null;
}

const outboxOf = (f: { eventId: string }): Promise<OutboxRow[]> => q<OutboxRow>('select topic, msg_key, payload, sent_at from outbox where msg_key = $1 order by seq', [f.eventId]);
const valueOf = (row: OutboxRow): Record<string, unknown> => JSON.parse(row.payload.toString('utf8')) as Record<string, unknown>;
const queriesOf = (f: { paymentKey: string }): string[] => sim.queries.filter((k) => k === f.paymentKey);
const typesOf = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

function queryCount(text: string, outcome: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${TOTAL}{`) && l.includes('pg="SIMULATOR"') && l.includes(`outcome="${outcome}"`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

function metricValue(text: string, name: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

const logLines = (h: Harness, kind: string, orderId: string): string[] => h.logs.filter((l) => l.includes(`"kind":"${kind}"`) && l.includes(orderId));

// ───────────────────────────── P-T3: 응답 유실 → 단독 조회 ─────────────────────────────

describe('응답 유실 뒤 단독 조회', () => {
  test('P-T3_응답을 잃어 UNKNOWN이 된 결제를 단독 조회로 승인 1건에 맞추고 승인 호출은 더 나가지 않으며 결과 사건·RESOLVED가 순번대로 나간다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await unknownPayment({ advance: false });
    const unknownAt = h.clock.now();
    const before = await h.metrics();

    const u = await ledger(f);
    expect(u.p.next_query_at!.getTime()).toBe(unknownAt + UNKNOWN_QUERY_BASE_MS);
    expect(u.p.query_attempts).toBe(0);
    expect(u.p.overdue_at).toBeNull();

    // 첫 조회 시각 전에는 잡히지 않는다
    h.clock.advance(UNKNOWN_QUERY_BASE_MS - 1);
    expect(await drive(h.resolver())).toBe(0);
    expect(queriesOf(f)).toEqual([]);

    h.clock.advance(1);
    const now = h.clock.now();
    expect(await drive(h.resolver())).toBe(1);

    const { p, events, jobs } = await ledger(f);
    expect(p).toMatchObject({ status: 'APPROVED', failure_category: null, next_query_at: null, query_attempts: 1 });
    expect(p.approved_at!.getTime()).toBe(SIM_NOW_MS);
    expect(p.status_changed_at.getTime()).toBe(now);
    expect(jobs).toEqual([]);
    expect(events.map((e) => [e.seq, e.type, e.exported])).toEqual([
      ['1', 'ACCEPTED', false],
      ['2', 'CONFIRM_SENT', false],
      ['3', 'UNKNOWN', true],
      ['4', 'APPROVED', true],
      ['5', 'RESOLVED', true],
    ]);
    expect(events[3]!.event_key).toBe(paymentEventKey(f.paymentId, 4));
    expect(events[3]!.occurred_at.getTime()).toBe(SIM_NOW_MS);
    expect(events[4]!.event_key).toBe(paymentEventKey(f.paymentId, 5));
    expect(events[4]!.occurred_at.getTime()).toBe(now);

    const rows = await outboxOf(f);
    expect(rows.map((r) => [r.topic, r.msg_key])).toEqual([
      [TRADE_PAYMENTS_TOPIC, f.eventId],
      [TRADE_PAYMENTS_TOPIC, f.eventId],
      [TRADE_PAYMENTS_TOPIC, f.eventId],
    ]);
    expect(rows.map((r) => [valueOf(r).type, valueOf(r).eventSeq, valueOf(r).result])).toEqual([
      ['UNKNOWN', 3, 'UNKNOWN'],
      ['APPROVED', 4, 'APPROVED'],
      ['RESOLVED', 5, 'APPROVED'],
    ]);
    for (const r of rows) {
      expect(PaymentEvent.safeParse(valueOf(r)).success, JSON.stringify(valueOf(r))).toBe(true);
      expect(r.payload.toString('utf8')).not.toContain(f.paymentKey);
    }

    expect(sim.confirms.filter((id) => id === f.orderId)).toHaveLength(1);
    expect(await sim.approvals(f.orderId)).toBe(1);
    expect(queriesOf(f)).toEqual([f.paymentKey]);
    const text = await h.metrics();
    expect(queryCount(text, 'approved') - queryCount(before, 'approved')).toBe(1);
    expect(metricValue(text, 'payment_unknown_in_flight')).toBe(0);
  });

  test('P-T3_처리 중 재전송 뒤 응답을 잃어도 같은 멱등키로 승인 1건이고 단독 조회로 확정한다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await accepted();
    await sim.fault(f.orderId, { kind: 'in-progress' });
    await drive(h.confirmRunner);
    expect((await ledger(f)).p.status).toBe('ACCEPTED');

    await sim.fault(f.orderId, { kind: 'drop', applied: true });
    h.clock.advance(1_000);
    await drive(h.confirmRunner);
    expect((await ledger(f)).p.status).toBe('UNKNOWN');

    h.clock.advance(UNKNOWN_QUERY_BASE_MS);
    await drive(h.resolver());

    expect((await ledger(f)).p.status).toBe('APPROVED');
    expect(sim.confirms.filter((id) => id === f.orderId)).toHaveLength(2);
    expect(await sim.approvals(f.orderId)).toBe(1);
  });

  test.each(['READY', 'IN_PROGRESS'] as const)('P-T3_조회 답이 %s이면 UNKNOWN 그대로 두고 조회 횟수로 간격을 늘려 다시 묻고, 뒤에 승인되면 승인 1건이다 [ASVS v5.0.0-16.5.3]', async (status) => {
    const h = await harness();
    const f = await unknownPayment({ applied: false });
    sim.patchQuery(f.paymentKey, { status });
    const before = await h.metrics();

    const first = h.clock.now();
    expect(await drive(h.resolver())).toBe(1);
    let l = await ledger(f);
    expect(l.p).toMatchObject({ status: 'UNKNOWN', query_attempts: 1 });
    expect(l.p.next_query_at!.getTime()).toBe(first + 5_000);

    h.clock.advance(5_000);
    const second = h.clock.now();
    expect(await drive(h.resolver())).toBe(1);
    l = await ledger(f);
    expect(l.p).toMatchObject({ status: 'UNKNOWN', query_attempts: 2 });
    expect(l.p.next_query_at!.getTime()).toBe(second + 10_000);
    expect(typesOf(l.events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    expect((await outboxOf(f)).map((r) => valueOf(r).type)).toEqual(['UNKNOWN']);
    const text = await h.metrics();
    expect(queryCount(text, 'still_processing') - queryCount(before, 'still_processing')).toBe(2);

    sim.patchQuery(f.paymentKey, { status: 'DONE', approvedAt: new Date(SIM_NOW_MS).toISOString() });
    h.clock.advance(10_000);
    expect(await drive(h.resolver())).toBe(1);
    expect((await ledger(f)).p.status).toBe('APPROVED');
    expect(queriesOf(f)).toHaveLength(3);
  });
});

describe('조회가 결과를 정한 때', () => {
  test.each([
    ['EXPIRED', 'FAILED', 'EXPIRED', 'DECLINED'],
    ['ABORTED', 'FAILED', 'PG_ERROR', 'DECLINED'],
    ['WAITING_FOR_DEPOSIT', 'AWAITING_DEPOSIT', null, 'WAITING_FOR_DEPOSIT'],
  ] as const)('P-T3_조회 답 %s → 원장 %s(%s), 사건 result %s이고 포트원 토큰을 지운다 [ASVS v5.0.0-14.2.7]', async (simStatus, ledgerStatus, category, result) => {
    const h = await harness();
    const f = await unknownPayment({ applied: false });
    await q(`update payment set pg_confirm_token = 'token-kept-while-unknown' where order_id = $1`, [f.orderId]);
    sim.patchQuery(f.paymentKey, { status: simStatus });

    await drive(h.resolver());

    const { p, events } = await ledger(f);
    expect(p).toMatchObject({ status: ledgerStatus, failure_category: category, next_query_at: null, pg_confirm_token: null, approved_at: null });
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN', ledgerStatus, 'RESOLVED']);
    const [, event, resolved] = await outboxOf(f);
    expect(valueOf(event!)).toMatchObject({ type: ledgerStatus, result, eventSeq: 4 });
    expect(valueOf(event!).failureCategory).toBe(category ?? undefined);
    expect(valueOf(resolved!)).toMatchObject({ type: 'RESOLVED', result, eventSeq: 5 });
    expect(valueOf(resolved!)).not.toHaveProperty('failureCategory');
    for (const r of [event!, resolved!]) expect(PaymentEvent.safeParse(valueOf(r)).success, JSON.stringify(valueOf(r))).toBe(true);
  });

  test('P-T3_금액이 다르면 UNKNOWN 그대로 두고 SEV1 로그 한 줄과 지표를 내며 다음 간격에 다시 묻는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.4]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    sim.patchQuery(f.paymentKey, { totalAmount: f.amount + 1 });
    const before = await h.metrics();

    const now = h.clock.now();
    await drive(h.resolver());

    const { p, events } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', approved_at: null });
    expect(p.next_query_at!.getTime()).toBe(now + 5_000);
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    const lines = logLines(h, 'payment-unknown-amount-mismatch', f.orderId);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ severity: 'SEV1', orderId: f.orderId });
    expect(lines[0]).not.toContain(f.paymentKey);
    const text = await h.metrics();
    expect(queryCount(text, 'amount_mismatch') - queryCount(before, 'amount_mismatch')).toBe(1);
  });

  test('P-T3_답의 주문 ID가 원장과 다르면 승인으로 쓰지 않는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    sim.patchQuery(f.paymentKey, { orderId: newId() });

    await drive(h.resolver());

    expect((await ledger(f)).p.status).toBe('UNKNOWN');
    expect(logLines(h, 'payment-unknown-order-mismatch', f.orderId)).toHaveLength(1);
  });

  test('P-T3_조회가 실패하면 UNKNOWN 그대로 두고 다시 묻는다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    expect((await sim.control('POST', '/sim/faults', { op: 'query', times: 1, orderId: f.orderId, kind: 'pg-error', applied: false })).status).toBe(204);
    const before = await h.metrics();

    await drive(h.resolver());
    expect((await ledger(f)).p.status).toBe('UNKNOWN');
    expect(queryCount(await h.metrics(), 'query_failed') - queryCount(before, 'query_failed')).toBe(1);

    h.clock.advance(5_000);
    await drive(h.resolver());
    expect((await ledger(f)).p.status).toBe('APPROVED');
  });
});

// ───────────────────────────── 겹침과 쓰기 ─────────────────────────────

describe('겹침과 쓰기', () => {
  test('P-T3_두 실행기가 동시에 돌아도 UNKNOWN마다 한 번만 조회하고 승인 사건이 한 번만 나간다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const list: Accepted[] = [];
    for (let i = 0; i < 20; i++) {
      const f = await accepted();
      await sim.fault(f.orderId, { kind: 'drop', applied: true });
      list.push(f);
    }
    // 토큰 묶음에 맞춰 여러 틱에 나눠 잡는다(끝나지 않는 일이 없게 틱 수에 상한을 둔다)
    for (let i = 0; i < 50 && (await drive(h.confirmRunner)) > 0; i += 1);
    h.clock.advance(UNKNOWN_QUERY_BASE_MS);

    const a = h.resolver();
    const b = h.resolver({}, 'b');
    for (let i = 0; i < 3; i++) await Promise.all([drive(a), drive(b)]);

    for (const f of list) {
      expect(queriesOf(f), f.orderId).toHaveLength(1);
      const { p, events } = await ledger(f);
      expect(p.status).toBe('APPROVED');
      expect(typesOf(events).filter((t) => t === 'APPROVED')).toEqual(['APPROVED']);
      expect((await outboxOf(f)).map((r) => valueOf(r).type)).toEqual(['UNKNOWN', 'APPROVED', 'RESOLVED']);
    }
  }, 60_000);

  test('PRF182_같은 행을 다른 트랜잭션이 잠그고 있으면 건너뛰고(SKIP LOCKED) 다음 틱에 잡는다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    const locker = await admin.pool.connect();
    try {
      await locker.query('begin');
      await locker.query('select id from payment where order_id = $1 for update', [f.orderId]);
      expect(await drive(h.resolver())).toBe(0);
    } finally {
      await locker.query('rollback').catch(() => {});
      locker.release();
    }
    expect(await drive(h.resolver())).toBe(1);
    expect((await ledger(f)).p.status).toBe('APPROVED');
  });

  test('PRF182_조회하는 동안 원장이 바뀌면 답을 쓰지 않고 경고 한 줄이다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    sim.queryHooks.set(f.paymentKey, async (res) => {
      await q(`update payment set status = 'FAILED', next_query_at = null where order_id = $1`, [f.orderId]);
      return res;
    });

    await drive(h.resolver());

    const { p, events } = await ledger(f);
    expect(p.status).toBe('FAILED');
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    expect(logLines(h, 'payment-unknown-stale', f.orderId)).toHaveLength(1);
  });

  test('PRF182_Outbox 쓰기가 실패하면 원장·사건이 함께 되돌아가고 다음 간격에 다시 조회해 쓴다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    await q('insert into test_hooks.fail_outbox_key (msg_key) values ($1)', [f.eventId]);
    const before = metricValue(await h.metrics(), 'payment_unknown_write_failures_total');

    await drive(h.resolver());

    const { p, events } = await ledger(f);
    expect(p.status).toBe('UNKNOWN');
    expect(p.next_query_at).not.toBeNull();
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    expect(metricValue(await h.metrics(), 'payment_unknown_write_failures_total') - before).toBe(1);
    expect(logLines(h, 'payment-unknown-write-failed', f.orderId)).toHaveLength(1);

    await q('truncate test_hooks.fail_outbox_key');
    // 답 반영에 실패한 행은 간격을 다시 쓰지 않아 잡을 때 민 시각에 다시 잡힌다
    h.clock.advance(15_000);
    await drive(h.resolver());
    expect((await ledger(f)).p.status).toBe('APPROVED');
    expect((await outboxOf(f)).map((r) => valueOf(r).type)).toEqual(['UNKNOWN', 'APPROVED', 'RESOLVED']);
  });

  test('PRF182_1시간 표시 뒤에도 조회는 이어 가고 표시는 처음 값 그대로다 [ASVS v5.0.0-16.3.4]', async () => {
    const h = await harness();
    const f = await unknownPayment({ applied: false, advance: false });
    sim.patchQuery(f.paymentKey, { status: 'IN_PROGRESS' });
    const r = h.resolver();

    h.clock.advance(UNKNOWN_OVERDUE_MS + 1);
    const now = h.clock.now();
    await expect(r.sweepOverdue()).resolves.toEqual({ marked: 1 });

    h.clock.advance(60_000);
    expect(await drive(r)).toBe(1);
    await expect(r.sweepOverdue()).resolves.toEqual({ marked: 0 });

    const { p } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN' });
    expect(p.overdue_at!.getTime()).toBe(now);
    expect(queriesOf(f)).toHaveLength(1);
  });
});

// ───────────────────────────── 리뷰 고침(BUILD_ORDER PRF-182, 코드 리뷰) ─────────────────────────────

describe('리뷰 고침', () => {
  const NOT_FOUND_REPLY = () => json({ code: 'NOT_FOUND_PAYMENT', message: '결제를 찾을 수 없습니다' }, 404);
  const anomalyRow = async (f: Accepted): Promise<Date | null> => (await q<{ anomaly_logged_at: Date | null }>('select anomaly_logged_at from payment where order_id = $1', [f.orderId]))[0]!.anomaly_logged_at;
  /** 승인 기한(10분)을 넉넉히 넘긴 시간. 시계를 함께 쓰므로 Outbox 파티션이 있는 범위(며칠) 안에서 민다 */
  const LONG_AFTER_DEADLINE = 2 * 3_600_000;

  test('P-T3_리뷰 고침 H2: 기록 없음은 승인 기한이 한참 지나도 FAILED로 끝내지 않고 UNKNOWN 그대로 다시 묻는다 [ASVS v5.0.0-16.5.3]', async () => {
    const h = await harness();
    const f = await unknownPayment({ applied: false });
    sim.queryHooks.set(f.paymentKey, NOT_FOUND_REPLY);
    const before = await h.metrics();

    await drive(h.resolver());
    h.clock.advance(LONG_AFTER_DEADLINE);
    await drive(h.resolver());

    const { p, events } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', failure_category: null });
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    expect(queryCount(await h.metrics(), 'not_found') - queryCount(before, 'not_found')).toBe(2);
  });

  test.each(['CANCELED', 'PARTIAL_CANCELED'] as const)('P-T3_리뷰 고침 H3·M4: 조회 답이 %s이면 UNKNOWN 그대로 두고 SEV1 로그는 몇 번을 물어도 한 줄이며 지표는 조회마다 오른다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async (status) => {
    const h = await harness();
    const f = await unknownPayment();
    sim.patchQuery(f.paymentKey, { status });
    const before = await h.metrics();

    await drive(h.resolver());
    h.clock.advance(60_000);
    await drive(h.resolver());

    const { p, events } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', approved_at: null });
    expect(typesOf(events)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'UNKNOWN']);
    const lines = logLines(h, 'payment-unknown-cancelled-at-pg', f.orderId);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ severity: 'SEV1', csCase: 'PAYMENT_UNKNOWN', orderId: f.orderId });
    expect(lines[0]).not.toContain(f.paymentKey);
    expect(queryCount(await h.metrics(), 'cancelled_at_pg') - queryCount(before, 'cancelled_at_pg')).toBe(2);
    expect(await anomalyRow(f)).not.toBeNull();
  });

  test('P-T3_리뷰 고침 M4: 금액 어긋남의 SEV1은 두 번 물어도 한 줄이고 지표는 조회마다 오른다 [ASVS v5.0.0-16.3.4]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    sim.patchQuery(f.paymentKey, { totalAmount: f.amount + 1 });
    const before = await h.metrics();

    await drive(h.resolver());
    h.clock.advance(60_000);
    await drive(h.resolver());

    expect(logLines(h, 'payment-unknown-amount-mismatch', f.orderId)).toHaveLength(1);
    expect(queryCount(await h.metrics(), 'amount_mismatch') - queryCount(before, 'amount_mismatch')).toBe(2);
  });

  test('P-T3_리뷰 고침 M4: 표시 쓰기는 조건부라 먼저 쓴 쪽만 true다 [ASVS v5.0.0-16.3.4]', async () => {
    const h = await harness();
    await unknownPayment();
    const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: h.clock });
    const [job] = await jobs.claimDueQueries('SIMULATOR', 1);

    await expect(jobs.markAnomalyLogged(job!)).resolves.toBe(true);
    await expect(jobs.markAnomalyLogged(job!)).resolves.toBe(false);
  });

  test('P-T3_리뷰 고침 L9: 입금 대기 답의 금액이 다르면 쓰지 않고 SEV1 로그 한 줄이다 [ASVS v5.0.0-2.2.3]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    sim.patchQuery(f.paymentKey, { status: 'WAITING_FOR_DEPOSIT', totalAmount: f.amount + 1 });

    await drive(h.resolver());

    expect((await ledger(f)).p.status).toBe('UNKNOWN');
    expect(logLines(h, 'payment-unknown-amount-mismatch', f.orderId)).toHaveLength(1);
  });

  test('P-T3_리뷰 고침 L10: 조회가 준 결제 수단 분류를 해소 사건에 싣는다', async () => {
    const h = await harness();
    const f = await unknownPayment();
    sim.patchQuery(f.paymentKey, { method: '간편결제' });

    await drive(h.resolver());

    const [, event, resolved] = await outboxOf(f);
    expect(valueOf(event!)).toMatchObject({ type: 'APPROVED', payMethodCategory: 'EASY_PAY' });
    expect(valueOf(resolved!)).toMatchObject({ type: 'RESOLVED', payMethodCategory: 'EASY_PAY' });
  });

  test('P-T3_리뷰 고침 M6: 잡을 때는 최소 15초 [가정]를 밀어 두고 답을 본 뒤 실제 간격(5초)으로 다시 쓴다', async () => {
    const h = await harness();
    const f = await unknownPayment();
    let during: number | undefined;
    sim.queryHooks.set(f.paymentKey, async () => {
      during = (await ledger(f)).p.next_query_at!.getTime();
      return json({ status: 'IN_PROGRESS', orderId: f.orderId, totalAmount: f.amount, balanceAmount: f.amount }, 200);
    });

    const now = h.clock.now();
    await drive(h.resolver());

    expect(during).toBe(now + 15_000);
    expect((await ledger(f)).p.next_query_at!.getTime()).toBe(now + 5_000);
  });

  test('P-T3_리뷰 고침 M6: 다른 파드가 다시 잡은 뒤의 늦은 답은 간격을 덮어쓰지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    await unknownPayment();
    const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock: h.clock });
    const [slow] = await jobs.claimDueQueries('SIMULATOR', 1);
    h.clock.advance(15_000);
    const [other] = await jobs.claimDueQueries('SIMULATOR', 1);
    expect(other!.paymentId).toBe(slow!.paymentId);

    await expect(jobs.rescheduleQuery(slow!, h.clock.now() + 5_000)).resolves.toBe(false);
    await expect(jobs.rescheduleQuery(other!, h.clock.now() + 5_000)).resolves.toBe(true);
  });

  test('P-T3_리뷰 고침 M7: 1시간 표시는 잡기와 별개로 돈다: 잡지 않은 행도 한 번만 표시하고 행마다 SEV2 로그와 지표를 낸다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
    const h = await harness();
    const f = await unknownPayment({ applied: false, advance: false });
    const before = metricValue(await h.metrics(), 'payment_unknown_overdue_total');
    const r = h.resolver();

    h.clock.advance(UNKNOWN_OVERDUE_MS);
    await expect(r.sweepOverdue()).resolves.toEqual({ marked: 0 });
    expect((await ledger(f)).p.overdue_at).toBeNull();

    h.clock.advance(1);
    const now = h.clock.now();
    await expect(r.sweepOverdue()).resolves.toEqual({ marked: 1 });
    await expect(r.sweepOverdue()).resolves.toEqual({ marked: 0 });

    const { p } = await ledger(f);
    expect(p).toMatchObject({ status: 'UNKNOWN', query_attempts: 0 });
    expect(p.overdue_at!.getTime()).toBe(now);
    expect(queriesOf(f)).toEqual([]);
    const lines = logLines(h, 'payment-unknown-overdue', f.orderId);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ severity: 'SEV2', csCase: 'PAYMENT_UNKNOWN', orderId: f.orderId });
    expect(metricValue(await h.metrics(), 'payment_unknown_overdue_total') - before).toBe(1);
  });

  test('P-T3_리뷰 고침 M7: 잡기는 1시간 표시를 하지 않는다', async () => {
    const h = await harness();
    const f = await unknownPayment({ applied: false, advance: false });
    sim.patchQuery(f.paymentKey, { status: 'IN_PROGRESS' });
    h.clock.advance(UNKNOWN_OVERDUE_MS + 1);

    await drive(h.resolver());

    expect((await ledger(f)).p.overdue_at).toBeNull();
  });

  test('P-T3_리뷰 고침 M7: 표시는 한 번에 100건까지이고 두 실행기가 겹쳐도 행마다 한 번이다 [ASVS v5.0.0-2.3.4]', async () => {
    const h = await harness();
    await admin.pool.query(
      `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, status_changed_at, next_query_at)
       select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'SIMULATOR', 'r', 1, 'UNKNOWN', 'k', $1, $1, $2 from generate_series(1, 130)`,
      [new Date(h.clock.now() - UNKNOWN_OVERDUE_MS - 1), new Date(h.clock.now() + 3_600_000)],
    );

    const [a, b] = await Promise.all([h.resolver().sweepOverdue(), h.resolver({}, 'b').sweepOverdue()]);
    expect(a.marked).toBeLessThanOrEqual(100);
    expect(b.marked).toBeLessThanOrEqual(100);
    const rest = await h.resolver().sweepOverdue();
    expect(a.marked + b.marked + rest.marked).toBe(130);
    expect(metricValue(await h.metrics(), 'payment_unknown_overdue_total')).toBeGreaterThanOrEqual(130);
    expect(h.logs.filter((l) => l.includes('"kind":"payment-unknown-overdue"')).length).toBeGreaterThanOrEqual(130);
  }, 30_000);

  test('P-T3_리뷰 고침 M7: 표시 문장은 끝난 행이 많은 표에서 status_changed_at 부분 인덱스를 탄다', async () => {
    const h = await harness();
    await unknownPayment({ advance: false });
    const s = await statementsDuring(() => new DrizzleConfirmJobs({ database: runnerDb, clock: h.clock }).markOverdueBatch(100));
    const sweep = s.find((x) => /for update skip locked/i.test(x.text));
    expect(sweep, JSON.stringify(s.map((x) => x.text))).toBeDefined();

    const client = await admin.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, status_changed_at)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'SIMULATOR', 'big', 1, 'APPROVED', 'k', now(), now() from generate_series(1, 20000)`,
      );
      await client.query('analyze payment');
      const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${sweep!.text}`, sweep!.values);
      const nodes = planNodes(r.rows[0]!['QUERY PLAN'][0].Plan);
      expect(nodes.map((n) => n['Index Name']).filter(Boolean)).toContain('payment_unknown_status_changed_idx');
      expect(nodes.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'payment')).toEqual([]);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  }, 60_000);

  test('P-T3_리뷰 고침 M7: UNKNOWN으로 쓰면서 다음 조회 시각을 비울 수 없다(CHECK) [ASVS v5.0.0-2.3.3]', async () => {
    await unknownPayment({ advance: false });
    await expect(q(`update payment set next_query_at = null where status = 'UNKNOWN'`)).rejects.toMatchObject({ code: '23514', constraint: 'payment_unknown_next_query_check' });
  });
});

// ───────────────────────────── 결과 조회와 주문 쪽 ─────────────────────────────

describe('결과 조회와 주문 쪽 처리', () => {
  test('P-T54_P-T3_BatchGetPayments는 RESOLVED를 빼고 최종 결과 사건의 순번·키를 돌려준다', async () => {
    const h = await harness();
    const f = await unknownPayment();
    await drive(h.resolver());

    const { payments } = (await unary(h.stack.client, 'BatchGetPayments', { order_ids: [f.orderId] })) as { payments: Record<string, unknown>[] };

    expect(payments[0]).toMatchObject({ order_id: f.orderId, status: 'PAYMENT_STATUS_APPROVED', event_seq: 4, event_key: paymentEventKey(f.paymentId, 4) });
  });

  test.each([
    ['DONE', 'APPROVED', 'T13', 'APPROVED'],
    ['ABORTED', 'FAILED', 'T15', 'FAILED'],
  ] as const)('P-T3_purchase-svc의 실제 처리기로 UNKNOWN(T12) 뒤 조회 답 %s가 %s(%s)까지 이어지고 RESOLVED는 건너뛴다', async (simStatus, type, transition, finalStatus) => {
    const h = await harness();
    const f = await unknownPayment({ applied: false });
    sim.patchQuery(f.paymentKey, { status: simStatus, ...(simStatus === 'DONE' ? { approvedAt: new Date(SIM_NOW_MS).toISOString() } : {}) });
    await drive(h.resolver());
    const rows = await outboxOf(f);
    expect(rows.map((r) => valueOf(r).type)).toEqual(['UNKNOWN', type, 'RESOLVED']);

    const order = { orderId: f.orderId, status: 'RESERVED' as string, amount: f.amount, paymentEventSeq: 0, acceptedPg: 'SIMULATOR', eventId: f.eventId, accountId: newId(), purchaseSessionId: newId(), seatIds: [newId()] };
    const applied: string[] = [];
    const after = (input: { transition: string; paymentEventSeq: number }, status: string) => {
      order.status = status;
      order.paymentEventSeq = input.paymentEventSeq;
      applied.push(input.transition);
      return { status: 'APPLIED' as const };
    };
    const apply = new ApplyPaymentResult({
      reads: { read: async () => order as never },
      writes: {
        approve: async (i) => after(i, 'APPROVED'),
        fail: async (i) => after(i, 'FAILED'),
        mark: async (i) => after(i, 'UNKNOWN'),
      },
      sessions: { complete: async () => true, unmarkPaying: async () => true },
      saga: { kick: vi.fn() },
      log: { held: vi.fn(), afterCommitFailed: vi.fn() },
      clock: h.clock,
    });
    const handler = new PaymentResultHandler(apply);

    for (const r of rows) {
      const message: ConsumedMessage = { topic: r.topic, partition: 0, offset: 0n, key: r.msg_key, value: r.payload, headers: {}, timestamp: h.clock.now() };
      const record = handler.decode(message);
      expect(record.kind).toBe('event');
      await handler.handle(record);
    }

    expect(applied).toEqual(['T12', transition]);
    expect(order.status).toBe(finalStatus);
    expect(order.paymentEventSeq).toBe(4);
  });
});

// ───────────────────────────── 문장 ─────────────────────────────

function planNodes(n: Record<string, unknown>): Record<string, unknown>[] {
  return [n, ...((n.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(planNodes)];
}

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

describe('문장', () => {
  test('PRF182_잡기 문장은 끝난 행이 많은 표에서 부분 인덱스를 타고 표를 통째로 읽지 않으며 FOR UPDATE SKIP LOCKED다', async () => {
    const h = await harness();
    await unknownPayment();
    const s = await statementsDuring(() => new DrizzleConfirmJobs({ database: runnerDb, clock: h.clock }).claimDueQueries('SIMULATOR', 16));
    const claim = s.find((x) => /for update skip locked/i.test(x.text));
    expect(claim, JSON.stringify(s.map((x) => x.text))).toBeDefined();

    const client = await admin.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, status_changed_at)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'SIMULATOR', 'big', 1, 'APPROVED', 'k', now(), now() from generate_series(1, 20000)`,
      );
      await client.query('analyze payment');
      const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${claim!.text}`, claim!.values);
      const nodes = planNodes(r.rows[0]!['QUERY PLAN'][0].Plan);
      expect(nodes.map((n) => n['Index Name']).filter(Boolean)).toContain('payment_unknown_query_idx');
      expect(nodes.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'payment')).toEqual([]);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  }, 60_000);

  test('PRF182_조회 동안 트랜잭션·행 잠금을 쥐지 않는다(결제사는 트랜잭션 밖) [ASVS v5.0.0-2.3.3]', async () => {
    const h = await harness();
    const f = await unknownPayment();
    let locked = 'not-run';
    sim.queryHooks.set(f.paymentKey, async (res) => {
      const client = await admin.pool.connect();
      try {
        await client.query('begin');
        const r = await client.query(`select id from payment where order_id = $1 for update nowait`, [f.orderId]).catch((e: { code?: string }) => e.code);
        locked = typeof r === 'string' ? r : 'free';
      } finally {
        await client.query('rollback').catch(() => {});
        client.release();
      }
      return res;
    });

    await drive(h.resolver());

    expect(locked).toBe('free');
  });

  test('PRF182_로그 어디에도 결제 키가 없다(이 파일의 모든 실행 뒤에 본다) [ASVS v5.0.0-16.2.5]', async () => {
    const h = await harness();
    expect(secrets.length).toBeGreaterThan(0);
    const text = h.logs.join('\n');
    for (const v of secrets) expect(text).not.toContain(v);
  });
});
