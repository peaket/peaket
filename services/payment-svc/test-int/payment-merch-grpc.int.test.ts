// 굿즈 결제의 결제창 준비와 승인 명령(ADR-0299 결정 1~4, docs/features/payment.md §11 P-T56, BAT-600)을 실제 PostgreSQL 18, 실제 gRPC 서버,
// 실제 HTTP 시뮬레이터 결제사(@peaket/pg-simulator)와 승인 실행기로 돈다.
// 정본 값: 원장 payment.order_kind(TICKET·MERCH, 기본 TICKET)와 CHECK (order_kind = 'TICKET') = (event_id IS NOT NULL)(결정 1),
// ConfirmPaymentRequest.order_kind = 12, UNSPECIFIED = TICKET, MERCH는 event_id·entry_opens_at이 비어야 함, 다시 부를 때 order_kind 대조와 SEV2 한 줄(kind payment-confirm-mismatch)(결정 2),
// PrepareCheckout MERCH: 복귀 주소 {PEAKET_WEB_ORIGIN}/shop/checkout/return?order={orderId}&pg={결제사}, 회차 없으면 플랫폼 행·기본만, 가상계좌 뺌(결정 3),
// 결제 사건 orderKind MERCH·eventId null·Kafka 키 = 주문 ID(결정 4), 회차 정산서 결제 읽기(event_id = $1)에 굿즈가 걸리지 않음(결정 1).
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓴다. 시험마다 새 주문 ID다(행 수는 앞뒤 차이로 본다). 승인 실행기를 돌리는 묶음만 시작 전에 명령 표를 비운다.
// - Kafka는 쓰지 않는다(이 PC에서 네이티브 모듈이 막힘). 사건은 Outbox 행의 값으로 본다(purchase-path-e2e와 같은 방식).
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, fakeClock, type FakeClock, PlatformMetrics, systemClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  channelTableOf,
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePaymentStore,
  DrizzlePgSelection,
  PaymentConfirmRunner,
  paymentCheckoutLog,
  paymentCommandLog,
  paymentConfirmLog,
  paymentPackage,
  paymentServiceHandlers,
  PgCallGuards,
  pgCallGuardLog,
  PortoneGateway,
  PrepareCheckout,
  PromPaymentCheckoutSignals,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
} from '../src/modules/payment/server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { DrizzleSettlementPaymentSource } from '../src/modules/settlement/adapters/db/drizzle-payment-source.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, ledgerOf, newId, paymentClient, type PaymentClient, tableCounts, tossConfirm, unary } from './support.js';

const WEB_ORIGIN = 'https://www.merch-it.example';
const SIM_NOW_MS = Date.parse('2026-11-18T01:00:00.000Z');
const IN_PROGRESS = 'CONFIRM_RESULT_IN_PROGRESS';
const MERCH = 'ORDER_KIND_MERCH';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let runnerDb: Database;
let sim: Sim;
let stacked: Promise<Stack> | undefined;

// ───────────────────────────── 시뮬레이터 ─────────────────────────────

interface Sim {
  app: SimulatorApp;
  url: string;
  key: string;
  confirmCalls: string[];
  fetch: typeof fetch;
  authenticate(orderId: string, amount: number): Promise<string>;
  fault(orderId: string, f: Record<string, unknown>): Promise<void>;
}

async function startSim(): Promise<Sim> {
  const key = `sim_sk_${randomBytes(16).toString('hex')}`;
  const app = buildSimulatorApp({ secretKey: key, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const control = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const confirmCalls: string[] = [];
  const counting: typeof fetch = async (input, init) => {
    if (init?.method === 'POST' && String(input).endsWith('/v1/payments/confirm')) confirmCalls.push((JSON.parse(String(init.body)) as { orderId: string }).orderId);
    return fetch(input, init);
  };
  return {
    app,
    url,
    key,
    confirmCalls,
    fetch: counting,
    async authenticate(orderId, amount) {
      const r = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공식 응원봉' });
      expect(r.status).toBe(200);
      return ((await r.json()) as { paymentKey: string }).paymentKey;
    },
    async fault(orderId, f) {
      expect((await control('POST', '/sim/faults', { op: 'confirm', times: 1, orderId, ...f })).status).toBe(204);
    },
  };
}

// ───────────────────────────── 조립 ─────────────────────────────

interface Stack {
  client: PaymentClient;
  clock: FakeClock;
  logs: string[];
  runner(): PaymentConfirmRunner;
  close(): Promise<void>;
}

async function startStack(): Promise<Stack> {
  const clock = fakeClock({ now: Date.now() });
  const logs: string[] = [];
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
  const metrics = new PlatformMetrics('payment-svc');
  const signals = new PromPaymentCommandSignals();
  signals.register(metrics.registry);
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: hot });
  const entry = new DrizzleEntryPause({ database: hot });
  // 결제창 값 만들기는 HTTP를 부르지 않는 실제 어댑터. 시뮬레이터 어댑터는 승인 실행기와 같은 실제 시뮬레이터를 가리킨다
  const simGateway = new SimulatorPaymentGateway({ baseUrl: sim.url, secretKey: sim.key, clientKey: 'sim_ck_merch_it', fetch: sim.fetch });
  const gateways = new StaticPaymentGateways([
    new TossPaymentGateway({ baseUrl: 'https://api.tosspayments.com', secretKey: 'test_sk_merch_it', clientKey: 'test_ck_merch_it' }),
    new PortoneGateway({ baseUrl: 'https://api.portone.io', secret: 'test-secret', storeId: 'store-it', channelKey: 'channel-single', webhookSecrets: [`whsec_${Buffer.alloc(24, 1).toString('base64')}`], isTest: true }),
    simGateway,
  ]);
  const prepareCheckout = new PrepareCheckout({
    // 캐시 없이 표를 바로 읽는다(행을 넣은 바로 뒤의 선택을 본다)
    selection: new DrizzlePgSelection({ database: hot }),
    pauses: { read: async () => new Map() },
    trials: entry,
    gateways,
    channels: channelTableOf(gateways),
    defaults: { primary: 'TOSS', fallback: 'PORTONE' },
    webOrigin: WEB_ORIGIN,
    virtualAccountReady: true,
    clock,
    log: paymentCheckoutLog(logger),
    signals: checkoutSignals,
  });
  const handlers = paymentServiceHandlers(
    {
      accept: new AcceptPaymentCommand({ store, clock, log: paymentCommandLog(logger), signals }),
      batchGet: new BatchGetPaymentStates({ reader: store, signals }),
      prepareCheckout,
    },
    () => undefined,
  );
  const server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
  const client = paymentClient(`127.0.0.1:${server.port}`);
  const confirmSignals = new PromPaymentConfirmSignals().register(metrics.registry);
  const guardSignals = new PromPgCallGuardSignals().register(metrics.registry);
  const runnerGateways = new StaticPaymentGateways([simGateway]);
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  return {
    client,
    clock,
    logs,
    runner: () =>
      new PaymentConfirmRunner({
        jobs,
        gateways: runnerGateways,
        log: paymentConfirmLog(logger),
        signals: confirmSignals,
        clock,
        podId: 'pod-merch',
        guards: new PgCallGuards({ gateways: runnerGateways, podCount: 1, clock, signals: guardSignals, log: pgCallGuardLog(logger) }),
        timer: silent,
      }),
    close: async () => {
      client.close();
      await server.close();
    },
  };
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-merch-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-merch-it-hot' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-merch-it-runner' });
  await ensureOutboxPartitions(admin, systemClock);
  sim = await startSim();
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await sim?.app.close();
  await Promise.allSettled([admin?.close(), hot?.close(), runnerDb?.close()]);
  pgc?.stop();
});

const stack = (): Promise<Stack> => (stacked ??= startStack());
const q = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query<R>(text, params)).rows;
const confirm = async (request: object) => unary((await stack()).client, 'ConfirmPayment', request);
const prepare = async (request: object) => unary((await stack()).client, 'PrepareCheckout', request);
const tsOf = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

/** 굿즈 승인 명령: 회차 칸이 비어 있다(proto 기본값 빈 글) */
function merchConfirm(o: Parameters<typeof tossConfirm>[0] = {}) {
  const f = tossConfirm(o);
  return { ...f, request: { ...f.request, event_id: '', order_kind: MERCH } };
}

/** 그 주문을 가리키는 Outbox 줄 */
interface OutboxRow extends pg.QueryResultRow {
  topic: string;
  msg_key: string;
  payload: Buffer;
}
const outboxMentioning = (orderId: string) => q<OutboxRow>(`select topic, msg_key, payload from outbox where convert_from(payload, 'UTF8') like $1 order by seq`, [`%${orderId}%`]);

// ───────────────────────────── 마이그레이션 0022 ─────────────────────────────

/** 제약을 시험할 원장 행(칸을 덮어 쓴다) */
const insertPayment = (over: Record<string, unknown> = {}) => {
  const v: Record<string, unknown> = {
    id: newId(),
    order_id: newId(),
    event_id: newId(),
    attempt_id: newId(),
    attempt_no: 1,
    pg: 'TOSS',
    pg_payment_ref: 'ref',
    amount: 1,
    status: 'ACCEPTED',
    idempotency_key: 'k',
    authenticated_at: new Date(),
    status_changed_at: new Date(),
    ...over,
  };
  const cols = Object.keys(v);
  return q(`insert into payment (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(v));
};

describe('마이그레이션 0022(payment.order_kind)', () => {
  test('P-T56 ① 칸을 주지 않은 행은 TICKET이고, MERCH는 회차가 비어야만 들어간다 [ASVS v5.0.0-2.3.4]', async () => {
    const ticket = newId();
    await insertPayment({ id: ticket });
    expect((await q<{ order_kind: string }>('select order_kind from payment where id = $1', [ticket]))[0]!.order_kind).toBe('TICKET');
    const merch = newId();
    await insertPayment({ id: merch, order_kind: 'MERCH', event_id: null });
    expect(await q('select order_kind, event_id from payment where id = $1', [merch])).toEqual([{ order_kind: 'MERCH', event_id: null }]);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['MERCH에 회차가 있음', { order_kind: 'MERCH' }, 'payment_order_kind_event_check'],
    ['TICKET에 회차가 없음', { order_kind: 'TICKET', event_id: null }, 'payment_order_kind_event_check'],
    ['칸 없음(기본 TICKET)에 회차가 없음', { event_id: null }, 'payment_order_kind_event_check'],
    ['목록 밖 주문 종류', { order_kind: 'GIFT' }, 'payment_order_kind_check'],
    ['소문자 merch', { order_kind: 'merch', event_id: null }, 'payment_order_kind_check'],
  ])('P-T56 ① CHECK가 %s을 23514로 막는다 [ASVS v5.0.0-2.2.1]', async (_n, over, constraint) => {
    await expect(insertPayment(over)).rejects.toMatchObject({ code: '23514', constraint });
  });

  test('P-T56 ① order_kind는 NOT NULL이다', async () => {
    await expect(insertPayment({ order_kind: null, event_id: null })).rejects.toMatchObject({ code: '23502' });
  });
});

// ───────────────────────────── 승인 명령(①~④) ─────────────────────────────

describe('굿즈 승인 명령 접수(ConfirmPayment)', () => {
  test('P-T56 ① MERCH에 회차 칸이 빈 명령은 IN_PROGRESS이고 원장 1행(order_kind MERCH, event_id NULL)·이력 첫 행 1행·승인 명령 1행이다 [ASVS v5.0.0-2.3.3]', async () => {
    const f = merchConfirm({ pg: 'SIMULATOR' });
    const before = await tableCounts(admin);
    const reply = await confirm(f.request);
    expect(reply.result).toBe(IN_PROGRESS);
    expect(reply.payment_id).toMatch(UUID);
    expect(await tableCounts(admin)).toEqual({ payment: before.payment + 1, payment_event: before.payment_event + 1, payment_confirm_job: before.payment_confirm_job + 1 });
    const l = await ledgerOf(admin, f.orderId);
    expect(l.payments).toHaveLength(1);
    const row = l.payments[0] as unknown as Record<string, unknown>;
    expect(row).toMatchObject({ id: reply.payment_id, order_id: f.orderId, order_kind: 'MERCH', event_id: null, pg: 'SIMULATOR', amount: f.amount, status: 'ACCEPTED', entry_opens_at: null });
    expect(l.events.map((e) => [e.seq, e.type])).toEqual([['1', 'ACCEPTED']]);
    expect(l.jobs).toHaveLength(1);
    expect(l.jobs[0]!.payment_id).toBe(reply.payment_id);
  });

  test('P-T56 ② 같은 MERCH 명령을 다시 부르면 같은 답이고 행이 그대로다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = merchConfirm();
    const first = await confirm(f.request);
    const ledger = await ledgerOf(admin, f.orderId);
    const counts = await tableCounts(admin);
    const again = await confirm(f.request);
    expect(again).toEqual(first);
    expect(await ledgerOf(admin, f.orderId)).toEqual(ledger);
    expect(await tableCounts(admin)).toEqual(counts);
  });

  test.each<[string, (f: ReturnType<typeof merchConfirm>) => object]>([
    ['TICKET(회차 넣음)', (f) => ({ ...f.request, order_kind: 'ORDER_KIND_TICKET', event_id: newId() })],
    ['주문 종류 없음(UNSPECIFIED = TICKET, 회차 넣음)', (f) => ({ ...f.request, order_kind: 'ORDER_KIND_UNSPECIFIED', event_id: newId() })],
  ])(
    'P-T56 ② MERCH로 받은 주문을 %s로 다시 부르면 FAILED_PRECONDITION·SEV2 로그 한 줄(payment-confirm-mismatch)이고 행이 그대로다 [ASVS v5.0.0-2.3.4] [ASVS v5.0.0-16.2.5]',
    async (_n, build) => {
      const s = await stack();
      const f = merchConfirm();
      await confirm(f.request);
      const ledger = await ledgerOf(admin, f.orderId);
      const counts = await tableCounts(admin);

      const err = await failure(confirm(build(f)));

      expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);
      expect(await ledgerOf(admin, f.orderId)).toEqual(ledger);
      expect(await tableCounts(admin)).toEqual(counts);
      const lines = s.logs.filter((l) => l.includes(f.orderId));
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(line).toMatchObject({ level: 'error', kind: 'payment-confirm-mismatch', orderId: f.orderId });
      expect(lines[0]).not.toContain(f.paymentKey);
    },
  );

  test('P-T56 ② 티켓으로 받은 주문을 MERCH(회차 비움)로 다시 부르면 FAILED_PRECONDITION·SEV2 한 줄이고 행이 그대로다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = await stack();
    const f = tossConfirm();
    await confirm(f.request);
    const ledger = await ledgerOf(admin, f.orderId);
    expect((ledger.payments[0] as unknown as Record<string, unknown>).order_kind).toBe('TICKET');

    const err = await failure(confirm({ ...f.request, order_kind: MERCH, event_id: '' }));

    expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(await ledgerOf(admin, f.orderId)).toEqual(ledger);
    const lines = s.logs.filter((l) => l.includes(f.orderId) && l.includes('payment-confirm-mismatch'));
    expect(lines).toHaveLength(1);
  });

  test.each<[string, (f: ReturnType<typeof merchConfirm>) => object]>([
    ['회차를 실음', (f) => ({ ...f.request, event_id: newId() })],
    ['입장 시각을 실음', (f) => ({ ...f.request, entry_opens_at: tsOf(Date.parse('2026-12-20T10:00:00.000Z')) })],
    ['회차와 입장 시각을 둘 다 실음', (f) => ({ ...f.request, event_id: newId(), entry_opens_at: tsOf(Date.parse('2026-12-20T10:00:00.000Z')) })],
  ])('P-T56 ③ MERCH에 %s면 INVALID_ARGUMENT이고 세 표에 쓴 행이 없다 [ASVS v5.0.0-2.2.1]', async (_n, build) => {
    const f = merchConfirm();
    const counts = await tableCounts(admin);
    const err = await failure(confirm(build(f)));
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await tableCounts(admin)).toEqual(counts);
    expect((await ledgerOf(admin, f.orderId)).payments).toEqual([]);
    // 거절은 아무것도 남기지 않았으므로 같은 주문을 바른 명령으로 부르면 처음 받는다
    expect((await confirm(f.request)).result).toBe(IN_PROGRESS);
  });

  test.each<[string, Record<string, unknown>]>([
    ['주문 종류 칸 없음', {}],
    ['ORDER_KIND_UNSPECIFIED', { order_kind: 'ORDER_KIND_UNSPECIFIED' }],
    ['ORDER_KIND_TICKET', { order_kind: 'ORDER_KIND_TICKET' }],
  ])('P-T56 ④ %s에 회차 칸이 빈 명령은 티켓 규칙대로 INVALID_ARGUMENT이고 쓴 행이 없다 [ASVS v5.0.0-2.2.1]', async (_n, kind) => {
    const f = tossConfirm();
    const counts = await tableCounts(admin);
    const err = await failure(confirm({ ...f.request, ...kind, event_id: '' }));
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await tableCounts(admin)).toEqual(counts);
  });

  test('P-T56 ④ 주문 종류 없이 회차를 실은 명령은 지금처럼 티켓으로 적힌다', async () => {
    const f = tossConfirm();
    expect((await confirm(f.request)).result).toBe(IN_PROGRESS);
    const row = (await ledgerOf(admin, f.orderId)).payments[0] as unknown as Record<string, unknown>;
    expect(row).toMatchObject({ order_kind: 'TICKET', event_id: f.eventId });
  });
});

// ───────────────────────────── 결제창 준비(⑤) ─────────────────────────────

const putConfig = (eventId: string, primary: string, fallback: string | null = null) => q('insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, $2, $3, now())', [eventId, primary, fallback]);
const putEventSwitch = (eventId: string, to: string) => q('insert into pg_switch (scope, active, from_pg, to_pg, version, changed_at) values ($1, true, null, $2, 1, now())', [eventId, to]);
const setPlatformSwitch = (active: boolean, to: string | null = null) =>
  q(
    `insert into pg_switch (scope, active, from_pg, to_pg, version, changed_at) values ('PLATFORM', $1, null, $2, 1, now())
     on conflict (scope) do update set active = excluded.active, to_pg = excluded.to_pg, changed_at = excluded.changed_at`,
    [active, to],
  );

const merchCheckout = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  order_kind: MERCH,
  order_id: newId(),
  attempt_id: newId(),
  amount: { krw: 39_000 },
  order_name: '공식 응원봉',
  pay_method: 'CARD',
  ...over,
});

describe('굿즈 결제창 준비(PrepareCheckout)', () => {
  test('P-T56 ⑤ 회차가 없으면 플랫폼 기본 결제사(TOSS)이고 복귀 주소는 /shop/checkout/return?order=…&pg=…이며 허용 수단에 가상계좌가 없다 [ASVS v5.0.0-3.7.2]', async () => {
    await setPlatformSwitch(false);
    const req = merchCheckout();
    const r = await prepare(req);
    expect(r.pg).toBe('PG_PROVIDER_TOSS');
    expect(r.switched).toBe(false);
    const url = `https://www.merch-it.example/shop/checkout/return?order=${String(req.order_id)}&pg=TOSS`;
    expect((r.toss as Record<string, unknown>).success_url).toBe(url);
    expect((r.toss as Record<string, unknown>).fail_url).toBe(url);
    expect(r.allowed_pay_methods).not.toContain('VIRTUAL_ACCOUNT');
    expect((r.allowed_pay_methods as string[]).length).toBeGreaterThan(0);
    expect(r.deposit_due_at ?? null).toBeNull();
  });

  test('P-T56 ⑤ 가상계좌 허용을 참으로 보내도 굿즈 허용 수단에는 가상계좌가 없다(같은 요청을 티켓으로 보내면 있다)', async () => {
    await setPlatformSwitch(false);
    const merch = await prepare(merchCheckout({ virtual_account_allowed: true }));
    expect(merch.allowed_pay_methods).not.toContain('VIRTUAL_ACCOUNT');
    // 짝: 가상계좌가 이 조립에서 실제로 열려 있음을 티켓으로 확인한다(가상계좌가 아예 없는 조립이면 위 단언이 빈 단언이 된다)
    const ticket = await prepare(merchCheckout({ order_kind: 'ORDER_KIND_TICKET', event_id: newId(), virtual_account_allowed: true }));
    expect(ticket.allowed_pay_methods).toContain('VIRTUAL_ACCOUNT');
  });

  test('P-T56 ⑤ 회차가 있는 굿즈(부가 상품)는 그 회차의 지정 행을 따르고 복귀 주소는 굿즈 주소다', async () => {
    await setPlatformSwitch(false);
    const eventId = newId();
    await putConfig(eventId, 'SIMULATOR', 'TOSS');
    const req = merchCheckout({ event_id: eventId });
    const r = await prepare(req);
    expect(r.pg).toBe('PG_PROVIDER_SIMULATOR');
    const url = `https://www.merch-it.example/shop/checkout/return?order=${String(req.order_id)}&pg=SIMULATOR`;
    // 시뮬레이터 결제창 값은 simulator 칸(TossCheckout 모양)이다
    expect(r.checkout).toBe('simulator');
    expect((r.simulator as Record<string, unknown>).success_url).toBe(url);
    expect((r.simulator as Record<string, unknown>).fail_url).toBe(url);
    expect(JSON.stringify(r)).not.toContain('/booking/');
  });

  test('P-T56 ⑤ 회차가 없으면 회차 행(지정·전환)을 보지 않고, 플랫폼 전환은 따른다', async () => {
    await setPlatformSwitch(false);
    expect((await prepare(merchCheckout())).pg).toBe('PG_PROVIDER_TOSS');
    // 빈 UUID 같은 값으로 회차 행을 넣어 두어도 굿즈(회차 없음)는 따르지 않는다
    const nil = '00000000-0000-0000-0000-000000000000';
    await putConfig(nil, 'SIMULATOR');
    await putEventSwitch(nil, 'PORTONE').catch(() => undefined);
    expect((await prepare(merchCheckout())).pg).toBe('PG_PROVIDER_TOSS');
    await setPlatformSwitch(true, 'PORTONE');
    expect(await prepare(merchCheckout())).toMatchObject({ pg: 'PG_PROVIDER_PORTONE', switched: true });
    await setPlatformSwitch(false);
  });

  test('P-T56 ⑤ 굿즈의 VIRTUAL_ACCOUNT 요청은 INVALID_ARGUMENT다(회차 있음·없음) [ASVS v5.0.0-2.2.1]', async () => {
    expect((await failure(prepare(merchCheckout({ pay_method: 'VIRTUAL_ACCOUNT' })))).code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await failure(prepare(merchCheckout({ pay_method: 'VIRTUAL_ACCOUNT', event_id: newId() })))).code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  test('P-T56 ⑤ 주문 종류 UNSPECIFIED의 결제창 준비는 INVALID_ARGUMENT다', async () => {
    expect((await failure(prepare(merchCheckout({ order_kind: 'ORDER_KIND_UNSPECIFIED', event_id: newId() })))).code).toBe(grpc.status.INVALID_ARGUMENT);
  });
});

// ───────────────────────────── 시뮬레이터 승인까지(⑥) ─────────────────────────────

describe('굿즈 결제를 시뮬레이터로 승인까지', () => {
  /** 시뮬레이터에서 인증하고 실제 ConfirmPayment로 명령을 넣는다 */
  async function acceptedVia(kind: 'MERCH' | 'TICKET', o: { eventId?: string; amount?: number } = {}) {
    const s = await stack();
    const orderId = newId();
    const amount = o.amount ?? 39_000;
    const paymentKey = await sim.authenticate(orderId, amount);
    const base = tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount, authenticatedAtMs: s.clock.now() - 1_000, ...(o.eventId ? { eventId: o.eventId } : {}) });
    const request = kind === 'MERCH' ? { ...base.request, event_id: '', order_kind: MERCH } : base.request;
    const reply = await unary(s.client, 'ConfirmPayment', request);
    expect(reply.result).toBe(IN_PROGRESS);
    return { ...base, paymentId: reply.payment_id as string };
  }

  async function drive(): Promise<void> {
    const r = (await stack()).runner();
    await r.tick();
    await r.whenIdle();
  }

  test('P-T56 ⑥ 승인 사건의 orderKind가 MERCH, eventId가 null(칸 없음)이고 Kafka 키(Outbox msg_key)가 주문 ID다 [ASVS v5.0.0-2.3.3]', async () => {
    await q('delete from payment_confirm_job');
    const f = await acceptedVia('MERCH');
    await drive();

    const l = await ledgerOf(admin, f.orderId);
    expect(l.payments[0]).toMatchObject({ status: 'APPROVED', event_id: null });
    expect(l.jobs).toEqual([]);
    expect(sim.confirmCalls.filter((o) => o === f.orderId)).toHaveLength(1);

    const rows = await outboxMentioning(f.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: 'trade.payments', msg_key: f.orderId });
    const value = JSON.parse(rows[0]!.payload.toString('utf8')) as Record<string, unknown>;
    expect(value).toMatchObject({ orderId: f.orderId, type: 'APPROVED', orderKind: 'MERCH', pg: 'SIMULATOR', amount: f.amount });
    expect(value.eventId ?? null).toBeNull();
    // 계약(asyncapi PaymentEvent) 모양에 맞고, 읽는 쪽에서도 MERCH다
    const parsed = PaymentEvent.parse(value);
    expect(parsed.orderKind).toBe('MERCH');
    expect(parsed.eventId ?? null).toBeNull();
  });

  test('P-T56 ⑥ 같은 때 승인한 티켓 결제의 키는 여전히 회차 ID이고 사건의 orderKind는 TICKET이다(짝)', async () => {
    await q('delete from payment_confirm_job');
    const eventId = newId();
    const t = await acceptedVia('TICKET', { eventId });
    await drive();
    const rows = await outboxMentioning(t.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.msg_key).toBe(eventId);
    expect(JSON.parse(rows[0]!.payload.toString('utf8'))).toMatchObject({ eventId, orderKind: 'TICKET', type: 'APPROVED' });
  });

  test('P-T56 ⑥ 결제사가 거절한 굿즈 결제의 FAILED 사건도 orderKind MERCH·키 주문 ID다', async () => {
    await q('delete from payment_confirm_job');
    const s = await stack();
    const orderId = newId();
    const paymentKey = await sim.authenticate(orderId, 39_000);
    await sim.fault(orderId, { kind: 'decline', code: 'REJECT_CARD_PAYMENT' });
    const base = tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey, amount: 39_000, authenticatedAtMs: s.clock.now() - 1_000 });
    await unary(s.client, 'ConfirmPayment', { ...base.request, event_id: '', order_kind: MERCH });
    await drive();
    const rows = await outboxMentioning(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.msg_key).toBe(orderId);
    const value = JSON.parse(rows[0]!.payload.toString('utf8')) as Record<string, unknown>;
    expect(value).toMatchObject({ type: 'FAILED', orderKind: 'MERCH', orderId });
    expect(value.eventId ?? null).toBeNull();
  });

  test('P-T56 ⑥ 회차 정산서의 결제 읽기(listEventPayments)에 굿즈 결제가 0건이고 같은 회차의 티켓 결제만 나온다', async () => {
    // 정산서 읽기는 실제 결제사(TOSS·PORTONE)만 받으므로 승인된 행을 SQL로 넣는다. 굿즈는 접수 경로가 실제로 적은 모양(MERCH, 회차 NULL)과 같다
    const eventId = newId();
    const ticketId = newId();
    const merchId = newId();
    await insertPayment({ id: ticketId, event_id: eventId, status: 'APPROVED', approved_at: new Date() });
    await insertPayment({ id: merchId, order_kind: 'MERCH', event_id: null, status: 'APPROVED', approved_at: new Date() });
    const source = new DrizzleSettlementPaymentSource(admin);
    expect((await source.listEventPayments(eventId, 'TOSS', 'STANDARD')).map((p) => p.paymentId)).toEqual([ticketId]);
    // 접수 경로(ConfirmPayment MERCH)가 적은 굿즈 행도 회차 칸이 비어 어떤 회차로도 읽히지 않는다
    const f = merchConfirm();
    await confirm(f.request);
    expect(await q('select order_kind, event_id from payment where order_id = $1', [f.orderId])).toEqual([{ order_kind: 'MERCH', event_id: null }]);
  });

  test('P-T56 ⑥ 결과 당기기(BatchGetPayments)가 굿즈 결제의 승인을 돌려준다(core-svc는 당기기로만 받는다, ADR-0299 결정 5)', async () => {
    await q('delete from payment_confirm_job');
    const f = await acceptedVia('MERCH');
    await drive();
    const r = await unary((await stack()).client, 'BatchGetPayments', { order_ids: [f.orderId] });
    const payments = r.payments as Record<string, unknown>[];
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ order_id: f.orderId, payment_id: f.paymentId });
    expect(String(payments[0]!.status)).toContain('APPROVED');
  });
});
