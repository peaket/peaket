// 가상계좌 입금 확인(BUILD_ORDER HOT-151)을 실제 PostgreSQL 18, 실제 HTTP 시뮬레이터(buildSimulatorApp), 실제 저장소·실행기·gRPC 서버로 돈다.
// 정본: docs/features/payment.md §6 '입금 확인의 첫 구현'·§4.2 15번·P-T9·P-T36, docs/data.md payment·0006·§5·§5.1, docs/api/proto/peaket/payment/v1/payment.proto GetPayment, docs/security/asvs/payment.md.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 표를 비운다. 시계는 스택의 가짜 시계 하나이고 시뮬레이터도 같은 시계를 본다(멈춰 있고 advance로만 간다).
// - 실행기는 손으로 돌린다: tick은 호출을 기다리지 않으므로 drive가 whenIdle까지 기다린다.
// - 입금 통보는 ReceivePaymentWebhook으로 넣는다(HTTP 경로와 본문 상한은 payment-webhook.int.test.ts가 본다).
// - 주문 쪽은 실제 처리기(purchase-svc PaymentResultHandler·ApplyPaymentResult)에 Outbox 값을 넣어 잇는다. 주문 DB 쓰기는 대역이고, 실제 쓰기는 purchase-svc 통합 시험이 본다.
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { type ConsumedMessage, createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, type FakeClock, fakeClock, PlatformMetrics } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApplyPaymentResult } from '../../purchase-svc/src/modules/booking/application/apply-payment-result.js';
import { PaymentResultHandler } from '../../purchase-svc/src/modules/booking/inbound/payment-result.handler.js';
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  CancelDepositPayment,
  DEPOSIT_QUERY_GRACE_MS,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  DrizzleWebhookStore,
  GetPaymentDetail,
  LocalVirtualAccountCipher,
  NoKeyVirtualAccountCipher,
  paymentCommandLog,
  PaymentConfirmRunner,
  paymentConfirmLog,
  paymentDepositLog,
  paymentPackage,
  paymentServiceHandlers,
  PaymentUnknownResolver,
  paymentUnknownLog,
  paymentWebhookLog,
  PgCallGuards,
  pgCallGuardLog,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPaymentDepositSignals,
  PromPaymentUnknownSignals,
  PromPaymentWebhookSignals,
  PromPgCallGuardSignals,
  ReceivePaymentWebhook,
  StaticPaymentGateways,
  TRADE_PAYMENTS_TOPIC,
  UNKNOWN_QUERY_BASE_MS,
  type VirtualAccountCipher,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, msOf, newId, type PaymentClient, paymentClient, tossConfirm, type TossFixture, unary } from './support.js';

const DUE_WINDOW_MS = 3 * 86_400_000;
const KEY = randomBytes(32);

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let batch: Database;
let runnerDb: Database;
let webhookDb: Database;
let app: SimulatorApp | undefined;
let simUrl: string;
let simKey: string;
let auth: string;
const clock: FakeClock = fakeClock({ now: Date.parse('2026-11-20T01:00:00.000Z') });
/** 시험이 켜고 끄는 시뮬레이터 조회 답 고치기(결제 키별) */
const queryHooks = new Map<string, (res: Response) => Response | Promise<Response>>();

interface Harness {
  client: PaymentClient;
  logs: string[];
  metrics(): Promise<string>;
  confirm: PaymentConfirmRunner;
  resolver: PaymentUnknownResolver;
  webhook: ReceivePaymentWebhook;
  close(): Promise<void>;
}

async function harness(cipher: VirtualAccountCipher): Promise<Harness> {
  const logs: string[] = [];
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
  const metrics = new PlatformMetrics('payment-svc');
  const counting: typeof fetch = async (input, init) => {
    const target = String(input);
    if (init?.method === 'GET' && target.includes('/v1/payments/')) {
      const key = decodeURIComponent(target.slice(target.lastIndexOf('/') + 1));
      const res = await fetch(input, init);
      const hook = queryHooks.get(key);
      return hook ? hook(res) : res;
    }
    return fetch(input, init);
  };
  const gateways = new StaticPaymentGateways([new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: simKey, clientKey: 'sim_ck_test_client', fetch: counting })]);
  const jobs = new DrizzleConfirmJobs({ database: runnerDb, clock });
  const silent = { setInterval: () => 0, clearInterval: () => {} };
  const guards = () => new PgCallGuards({ gateways, podCount: 1, clock, signals: new PromPgCallGuardSignals(), log: pgCallGuardLog(logger) });
  const depositLog = paymentDepositLog(logger);
  const depositSignals = new PromPaymentDepositSignals().register(metrics.registry);
  const deposit = { cipher, log: depositLog, signals: depositSignals };
  const confirm = new PaymentConfirmRunner({ jobs, gateways, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock, podId: 'pod-a', timer: silent, guards: guards(), deposit });
  const resolver = new PaymentUnknownResolver({ queries: jobs, gateways, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(metrics.registry), clock, timer: silent, guards: guards(), deposit });
  const webhookSignals = new PromPaymentWebhookSignals();
  webhookSignals.register(metrics.registry);
  const webhook = new ReceivePaymentWebhook({ store: new DrizzleWebhookStore({ database: webhookDb }), gateways, log: paymentWebhookLog(logger, clock), signals: webhookSignals, clock, allowSimulator: true });
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: batch });
  const commandSignals = new PromPaymentCommandSignals();
  const accept = new AcceptPaymentCommand({ store, clock, log: paymentCommandLog(logger), signals: commandSignals });
  const batchGet = new BatchGetPaymentStates({ reader: store, signals: commandSignals });
  const getPayment = new GetPaymentDetail({ reader: store, signals: depositSignals, cipher, depositLog, depositSignals, clock });
  const server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers: paymentServiceHandlers({ accept, batchGet, getPayment, cancelPayment: new CancelDepositPayment({ store: jobs, gateways, guards: guards(), signals: depositSignals, clock }) }, () => {}) }] });
  const client = paymentClient(`127.0.0.1:${server.port}`);
  return {
    client,
    logs,
    metrics: () => metrics.registry.metrics(),
    confirm,
    resolver,
    webhook,
    close: async () => {
      client.close();
      await server.close();
    },
  };
}

let h: Harness;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-deposit-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-deposit-it-hot' });
  batch = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-deposit-it-batch' });
  runnerDb = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'payment-deposit-it-runner' });
  webhookDb = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-deposit-it-webhook' });
  // 기한 경과 시험이 시계를 며칠씩 민다. Outbox 일 파티션을 그만큼 앞서 만든다
  await ensureOutboxPartitions(admin, clock, { daysAhead: 40 });
  simKey = `sim_sk_${randomBytes(16).toString('hex')}`;
  auth = `Basic ${Buffer.from(`${simKey}:`).toString('base64')}`;
  app = buildSimulatorApp({ secretKey: simKey, clock: { now: () => clock.now() }, confirmLatency: { kind: 'none' } });
  simUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  h = await harness(new LocalVirtualAccountCipher(KEY));
}, 180_000);

afterAll(async () => {
  await h?.close();
  await app?.close();
  await Promise.allSettled([admin?.close(), hot?.close(), batch?.close(), runnerDb?.close(), webhookDb?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job, webhook_receipt, outbox');
  queryHooks.clear();
  h.logs.length = 0;
  // 시계를 조금 밀어 시험끼리 토큰·로그 문을 나눈다
  clock.advance(120_000);
});

type Row = {
  id: string;
  status: string;
  deposit_due_at: Date | null;
  deposit_notified_at: Date | null;
  virtual_account_no: string | null;
  virtual_account_bank: string | null;
  deposit_secret_hash: Buffer | null;
  next_query_at: Date | null;
  query_attempts: number;
  approved_at: Date | null;
  failure_category: string | null;
};
const rowOf = async (orderId: string): Promise<Row> => (await admin.pool.query<Row & pg.QueryResultRow>('select * from payment where order_id = $1', [orderId])).rows[0]!;
const receipts = async (): Promise<number> => Number((await admin.pool.query<{ n: string }>('select count(*) as n from webhook_receipt')).rows[0]!.n);
const control = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const r = await fetch(`${simUrl}${path}`, { method, headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
};
const drive = async (runner: PaymentUnknownResolver | PaymentConfirmRunner): Promise<number> => {
  const { claimed } = await runner.tick();
  await runner.whenIdle();
  return claimed;
};

interface Issued extends TossFixture {
  paymentKey: string;
  /** 시뮬레이터가 준 입금 정보 */
  accountNumber: string;
  bank: string;
  dueAtMs: number;
  secret: string;
}

async function accepted(harnessIn: Harness = h): Promise<TossFixture> {
  const orderId = newId();
  const amount = 88_000;
  const a = await control('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓', method: '가상계좌' });
  const f = tossConfirm({ pg: 'SIMULATOR', orderId, paymentKey: a.paymentKey as string, amount, authenticatedAtMs: clock.now() - 1_000 });
  await unary(harnessIn.client, 'ConfirmPayment', f.request);
  return f;
}

async function issued(harnessIn: Harness = h): Promise<Issued> {
  const f = await accepted(harnessIn);
  await drive(harnessIn.confirm);
  const view = await control('GET', `/v1/payments/${f.paymentKey}`);
  const va = view.virtualAccount as { accountNumber: string; bankCode: string; dueDate: string };
  return { ...f, accountNumber: va.accountNumber, bank: va.bankCode, dueAtMs: Date.parse(va.dueDate), secret: view.secret as string };
}

const callbackBody = (i: Issued, over: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({ createdAt: '2026-11-20T10:00:00.000000', secret: i.secret, status: 'DONE', transactionKey: `tx-${i.orderId}`, orderId: i.orderId, ...over }));
/** 시뮬레이터 채널의 이름표 값(지표는 결제사마다 줄이 따로다) */
const metric = async (name: string, outcome: string, target: Harness = h): Promise<number> => {
  const line = (await target.metrics()).split('\n').find((l) => l.startsWith(`${name}{`) && l.includes('pg="SIMULATOR"') && l.includes(`outcome="${outcome}"`));
  return Number(line?.split(' ').at(-1) ?? 0);
};
const WEBHOOK = 'payment_webhook_received_total';
const QUERY = 'payment_unknown_query_total';

/** Outbox 값들을 실제 처리기(purchase-svc)로 넣어 주문 전이를 본다. 주문 쓰기만 대역이다 */
async function applyToOrder(i: Issued, startStatus = 'RESERVED') {
  const rows = (await admin.pool.query<{ msg_key: string; payload: Buffer; topic: string }>(`select msg_key, payload, topic from outbox where msg_key = $1 and topic = $2 order by seq`, [i.eventId, TRADE_PAYMENTS_TOPIC])).rows;
  const order = { orderId: i.orderId, status: startStatus as string, amount: i.amount, paymentEventSeq: 0, acceptedPg: 'SIMULATOR', eventId: i.eventId, accountId: newId(), purchaseSessionId: newId(), seatIds: [newId()] };
  const applied: { transition: string; depositPending?: unknown }[] = [];
  const after = (input: { transition: string; paymentEventSeq: number; depositPending?: unknown }, status: string) => {
    order.status = status;
    order.paymentEventSeq = input.paymentEventSeq;
    applied.push({ transition: input.transition, ...(input.depositPending === undefined ? {} : { depositPending: input.depositPending }) });
    return { status: 'APPLIED' as const };
  };
  const apply = new ApplyPaymentResult({
    reads: { read: async () => order as never },
    writes: { approve: async (x) => after(x, 'APPROVED'), fail: async (x) => after(x, 'FAILED'), mark: async (x) => after(x, x.transition === 'T12' ? 'UNKNOWN' : 'AWAITING_DEPOSIT'), reverse: async (x) => after(x, 'AWAITING_DEPOSIT'), holdIssue: async () => true },
    sessions: { complete: async () => true, unmarkPaying: async () => true },
    saga: { kick: vi.fn() },
    log: { held: vi.fn(), afterCommitFailed: vi.fn() },
    clock,
  });
  const handler = new PaymentResultHandler(apply);
  for (const r of rows) {
    const message: ConsumedMessage = { topic: r.topic, partition: 0, offset: 0n, key: r.msg_key, value: r.payload, headers: {}, timestamp: clock.now() };
    const record = handler.decode(message);
    expect(record.kind).toBe('event');
    await handler.handle(record);
  }
  return { applied, order };
}
const outboxEvents = async (i: Issued) => (await admin.pool.query<{ payload: Buffer }>(`select payload from outbox where msg_key = $1 and topic = $2 order by seq`, [i.eventId, TRADE_PAYMENTS_TOPIC])).rows.map((r) => JSON.parse(r.payload.toString('utf8')) as Record<string, unknown>);

describe('발급 정보 저장', () => {
  test('P-T36 ①_승인 답이 입금 대기면 기한·은행·암호문·해시를 한 트랜잭션에 쓰고 사건에는 기한만 싣는다 [ASVS v5.0.0-11.3.2] [ASVS v5.0.0-11.3.3] [ASVS v5.0.0-14.2.4] [ASVS v5.0.0-16.2.5]', async () => {
    const i = await issued();
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('AWAITING_DEPOSIT');
    expect(row.deposit_due_at!.getTime()).toBe(i.dueAtMs);
    expect(row.virtual_account_bank).toBe(i.bank);
    expect(row.virtual_account_no).not.toBeNull();
    expect(row.virtual_account_no).not.toContain(i.accountNumber);
    await expect(new LocalVirtualAccountCipher(KEY).open(row.id, row.virtual_account_no!)).resolves.toBe(i.accountNumber);
    expect(row.deposit_secret_hash!.equals(createHash('sha256').update(i.secret, 'utf8').digest())).toBe(true);
    expect(row.next_query_at!.getTime()).toBe(i.dueAtMs + DEPOSIT_QUERY_GRACE_MS);
    const events = await outboxEvents(i);
    expect(events).toHaveLength(1);
    expect(PaymentEvent.parse(events[0])).toMatchObject({ type: 'AWAITING_DEPOSIT', depositDueAt: new Date(i.dueAtMs).toISOString() });
    const text = `${JSON.stringify(events)}\n${h.logs.join('\n')}`;
    expect(text).not.toContain(i.accountNumber);
    expect(text).not.toContain(i.secret);
  });

  test('P-T36_UNKNOWN이 조회로 입금 대기면(T14) 같은 칸을 쓰고 해소 기록을 낸다', async () => {
    const f = await accepted();
    await control('POST', '/sim/faults', { op: 'confirm', orderId: f.orderId, times: 1, kind: 'drop', applied: true });
    await drive(h.confirm);
    expect((await rowOf(f.orderId)).status).toBe('UNKNOWN');
    clock.advance(UNKNOWN_QUERY_BASE_MS);
    expect(await drive(h.resolver)).toBe(1);
    const row = await rowOf(f.orderId);
    expect(row.status).toBe('AWAITING_DEPOSIT');
    expect(row.virtual_account_no).not.toBeNull();
    expect(row.deposit_secret_hash).not.toBeNull();
    expect(row.query_attempts).toBe(0);
    expect(row.next_query_at!.getTime()).toBe(row.deposit_due_at!.getTime() + DEPOSIT_QUERY_GRACE_MS);
    const types = (await outboxEvents(f as Issued)).map((e) => e.type);
    expect(types).toEqual(['UNKNOWN', 'AWAITING_DEPOSIT', 'RESOLVED']);
    const { applied } = await applyToOrder(f as Issued);
    expect(applied.map((a) => a.transition)).toEqual(['T12', 'T14']);
  });

  test('P-T36_키가 없는 환경은 계좌번호를 쓰지 않고 지표·SEV2로 드러낸다. 은행·기한·해시는 쓴다 [ASVS v5.0.0-14.2.4]', async () => {
    const noKey = await harness(new NoKeyVirtualAccountCipher());
    try {
      const i = await issued(noKey);
      const row = await rowOf(i.orderId);
      expect(row.status).toBe('AWAITING_DEPOSIT');
      expect(row.virtual_account_no).toBeNull();
      expect(row.virtual_account_bank).toBe(i.bank);
      expect(row.deposit_secret_hash).not.toBeNull();
      expect(await noKey.metrics()).toContain('payment_virtual_account_field_failures_total{op="seal",reason="NO_KEY"} 1');
      expect(noKey.logs.join('\n')).toContain('payment-virtual-account-unsaved');
      expect(noKey.logs.join('\n')).not.toContain(i.accountNumber);
      const d = await unary(noKey.client, 'GetPayment', { order_id: i.orderId });
      expect((d.virtual_account as { bank: string; account_number: string }).account_number).toBe('');
    } finally {
      await noKey.close();
    }
  });

  test('P-T36_마이그레이션 0006: 입금 대기 행도 next_query_at이 필수고 잡기 인덱스에 들어간다', async () => {
    const i = await issued();
    await expect(admin.pool.query('update payment set next_query_at = null where order_id = $1', [i.orderId])).rejects.toMatchObject({ code: '23514', constraint: 'payment_next_query_check' });
    const idx = await admin.pool.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'payment_query_due_idx'`);
    expect(idx.rows[0]!.indexdef).toContain("'AWAITING_DEPOSIT'");
    expect((await admin.pool.query(`select 1 from pg_indexes where indexname = 'payment_unknown_query_idx'`)).rows).toHaveLength(0);
  });
});

describe('P-T9 입금 통보 대조', () => {
  test('P-T9_위조 secret은 수신 기록을 쓰지 못하고 조회도 부르지 못한다. 그 뒤 진짜 통보는 그대로 처리된다 [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-16.2.5]', async () => {
    const i = await issued();
    const before = await rowOf(i.orderId);
    const forged = `forged_${randomBytes(8).toString('hex')}`;
    const count = await metric(WEBHOOK, 'deposit_secret_mismatch');
    await expect(h.webhook.receive('toss', {}, callbackBody(i, { secret: forged }))).resolves.toBe('ACCEPTED');
    expect(await receipts()).toBe(0);
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(before.next_query_at!.getTime());
    expect(await metric(WEBHOOK, 'deposit_secret_mismatch')).toBe(count + 1);
    expect(h.logs.join('\n')).toContain('payment-webhook-deposit-secret-mismatch');
    expect(h.logs.join('\n')).not.toContain(forged);
    expect(await drive(h.resolver)).toBe(0);

    // 같은 거래 키의 진짜 통보는 앞선 위조에 막히지 않는다
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    await expect(h.webhook.receive('toss', {}, callbackBody(i))).resolves.toBe('ACCEPTED');
    expect(await receipts()).toBe(1);
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(clock.now());
  });

  test('P-T9_재전송은 수신 기록 하나·신호 하나다(5초 안의 조회 신호는 합쳐진다) [ASVS v5.0.0-2.3.3]', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    const duplicates = await metric(WEBHOOK, 'duplicate');
    const signals = await metric(WEBHOOK, 'query_signal');
    await h.webhook.receive('toss', {}, callbackBody(i));
    await h.webhook.receive('toss', {}, callbackBody(i));
    expect(await receipts()).toBe(1);
    expect(await metric(WEBHOOK, 'duplicate')).toBe(duplicates + 1);
    expect(await metric(WEBHOOK, 'query_signal')).toBe(signals + 1);
  });

  test('P-T9_입금 확정 뒤의 재전송은 해시가 남아 맞는 secret이면 수신 기록과 지표만이고 보안 로그가 없다', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    await h.webhook.receive('toss', {}, callbackBody(i));
    await drive(h.resolver);
    expect((await rowOf(i.orderId)).status).toBe('APPROVED');
    h.logs.length = 0;
    const ignored = await metric(WEBHOOK, 'state_ignored');
    await h.webhook.receive('toss', {}, callbackBody(i, { transactionKey: 'tx-again' }));
    expect(await metric(WEBHOOK, 'state_ignored')).toBe(ignored + 1);
    expect(h.logs.join('\n')).not.toContain('payment-webhook-deposit-secret-mismatch');
    expect(await receipts()).toBe(2);
  });
});

describe('입금 확인과 기한 조회', () => {
  test('P-T36 ①_입금 통보 → 조회 → APPROVED, 칸을 지우고 사건을 내며 주문은 T16이다 [ASVS v5.0.0-14.2.7]', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    await h.webhook.receive('toss', {}, callbackBody(i));
    expect(await drive(h.resolver)).toBe(1);
    const row = await rowOf(i.orderId);
    // 해시는 입금 오류 통보를 대조하려고 남긴다(BUILD_ORDER HOT-152)
    expect(row).toMatchObject({ status: 'APPROVED', deposit_due_at: null, virtual_account_no: null, virtual_account_bank: null, next_query_at: null });
    expect(row.deposit_secret_hash).not.toBeNull();
    expect(row.approved_at).not.toBeNull();
    const events = await outboxEvents(i);
    expect(events.map((e) => e.type)).toEqual(['AWAITING_DEPOSIT', 'APPROVED']);
    for (const e of events) PaymentEvent.parse(e);
    const { applied, order } = await applyToOrder(i);
    expect(applied.map((a) => a.transition)).toEqual(['T10', 'T16']);
    expect(applied[0]!.depositPending).toEqual({ eventId: i.eventId, seatIds: order.seatIds, pendingUntilMs: i.dueAtMs + DEPOSIT_QUERY_GRACE_MS });
    expect(await metric(QUERY, 'deposit_approved')).toBeGreaterThan(0);
  });

  test('P-T36 ②_입금 없이 기한 + 10분이면 조회로 FAILED(EXPIRED)이고 칸을 지우며 주문은 T17이다(웹훅 없음) [ASVS v5.0.0-14.2.7]', async () => {
    const i = await issued();
    clock.advance(i.dueAtMs + DEPOSIT_QUERY_GRACE_MS - clock.now() - 1);
    expect(await drive(h.resolver)).toBe(0);
    clock.advance(1);
    expect(await drive(h.resolver)).toBe(1);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'EXPIRED', deposit_due_at: null, virtual_account_no: null, virtual_account_bank: null, deposit_secret_hash: null, next_query_at: null });
    const events = await outboxEvents(i);
    expect(events.map((e) => e.type)).toEqual(['AWAITING_DEPOSIT', 'FAILED']);
    expect(events[1]).toMatchObject({ failureCategory: 'EXPIRED' });
    expect((await applyToOrder(i)).applied.map((a) => a.transition)).toEqual(['T10', 'T17']);
    expect(await metric(QUERY, 'deposit_expired')).toBeGreaterThan(0);
  });

  test('P-T36 ③_기한 직전 입금이 늦게 처리돼도 기한 + 10분 조회가 입금 완료면 APPROVED다(좌석 유지) [ASVS v5.0.0-2.3.3]', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    clock.advance(i.dueAtMs + DEPOSIT_QUERY_GRACE_MS - clock.now());
    expect(await drive(h.resolver)).toBe(1);
    expect((await rowOf(i.orderId)).status).toBe('APPROVED');
    expect((await applyToOrder(i)).applied.map((a) => a.transition)).toEqual(['T10', 'T16']);
  });

  test('P-T36_결제사가 만료로 답하면 FAILED(EXPIRED)다', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}/expire`);
    await h.webhook.receive('toss', {}, callbackBody(i, { status: 'CANCELED' }));
    expect(await drive(h.resolver)).toBe(1);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'EXPIRED' });
  });

  test('P-T36_기한 전 조회가 입금 대기면 그대로이고 다음 조회를 기한 + 10분으로 되돌리며 조회 횟수를 비운다', async () => {
    const i = await issued();
    // 입금은 아직 없는데 통보가 먼저 온 경우(WAITING_FOR_DEPOSIT 답)
    await h.webhook.receive('toss', {}, callbackBody(i, { status: 'WAITING_FOR_DEPOSIT' }));
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(clock.now());
    expect(await drive(h.resolver)).toBe(1);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'AWAITING_DEPOSIT', query_attempts: 0 });
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(i.dueAtMs + DEPOSIT_QUERY_GRACE_MS);
    expect((await outboxEvents(i)).map((e) => e.type)).toEqual(['AWAITING_DEPOSIT']);
    expect(await metric(QUERY, 'deposit_waiting')).toBeGreaterThan(0);
  });

  test('P-T36_조회 답의 금액이 원장과 다르면 승인하지 않고 SEV1을 낸다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.3.3]', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    queryHooks.set(i.paymentKey, async (res) => new Response(JSON.stringify({ ...((await res.json()) as Record<string, unknown>), totalAmount: i.amount + 1 }), { status: 200 }));
    await h.webhook.receive('toss', {}, callbackBody(i));
    await drive(h.resolver);
    expect((await rowOf(i.orderId)).status).toBe('AWAITING_DEPOSIT');
    expect(h.logs.join('\n')).toContain('payment-unknown-amount-mismatch');
  });
});

describe('리뷰 고침: 통보 뒤 다시 묻기와 끝난 원장의 통보', () => {
  test('P-T36_리뷰 고침 M3: 입금 완료 통보로 깬 조회가 아직 입금 대기면 5초에서 두 배로 다시 묻고, 입금이 보이면 칸을 지운다 [ASVS v5.0.0-2.3.3]', async () => {
    const i = await issued();
    // 통보는 왔는데 결제사 조회는 아직 입금 대기다(조회 반영이 늦다)
    await h.webhook.receive('toss', {}, callbackBody(i));
    const notifiedAt = clock.now();
    expect((await rowOf(i.orderId)).deposit_notified_at!.getTime()).toBe(notifiedAt);
    expect(await drive(h.resolver)).toBe(1);
    let row = await rowOf(i.orderId);
    expect(row.status).toBe('AWAITING_DEPOSIT');
    expect(row.next_query_at!.getTime()).toBe(clock.now() + 5_000);
    clock.advance(5_000);
    expect(await drive(h.resolver)).toBe(1);
    row = await rowOf(i.orderId);
    expect(row.next_query_at!.getTime()).toBe(clock.now() + 10_000);
    expect(row.deposit_notified_at!.getTime()).toBe(notifiedAt);
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    clock.advance(10_000);
    expect(await drive(h.resolver)).toBe(1);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'APPROVED', deposit_notified_at: null, next_query_at: null });
  });

  test('P-T36_리뷰 고침 M3: 잡은 직후(5초 안)에 온 입금 완료 통보도 잃지 않고 5초 간격을 지켜 다시 묻는다 [ASVS v5.0.0-2.3.3]', async () => {
    const i = await issued();
    await h.webhook.receive('toss', {}, callbackBody(i, { status: 'WAITING_FOR_DEPOSIT' }));
    expect(await drive(h.resolver)).toBe(1);
    const claimedAt = clock.now();
    clock.advance(1_000);
    await h.webhook.receive('toss', {}, callbackBody(i));
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(claimedAt + 5_000);
    expect(await drive(h.resolver)).toBe(0);
    clock.advance(4_000);
    expect(await drive(h.resolver)).toBe(1);
  });

  test('P-T36_리뷰 고침 M3: 통보가 없으면 지금처럼 기한 + 10분이다', async () => {
    const i = await issued();
    const row = await rowOf(i.orderId);
    expect(row.deposit_notified_at).toBeNull();
    expect(row.next_query_at!.getTime()).toBe(i.dueAtMs + DEPOSIT_QUERY_GRACE_MS);
  });

  async function expiredRow(): Promise<Issued> {
    const i = await issued();
    clock.advance(i.dueAtMs + DEPOSIT_QUERY_GRACE_MS - clock.now());
    await drive(h.resolver);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'EXPIRED', deposit_notified_at: null });
    return i;
  }

  test('P-T36_리뷰 고침 M6: FAILED로 끝난 원장에 DONE 통보가 오면 한 번 조회하고 입금 완료면 SEV1·지표를 낸다(원장은 그대로다) [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-16.2.5]', async () => {
    const i = await expiredRow();
    const before = (await outboxEvents(i)).length;
    queryHooks.set(i.paymentKey, async (res) => new Response(JSON.stringify({ ...((await res.json()) as Record<string, unknown>), status: 'DONE', approvedAt: new Date(clock.now()).toISOString() }), { status: 200 }));
    const late = await metric(QUERY, 'late_deposit');
    await h.webhook.receive('toss', {}, callbackBody(i));
    expect(await drive(h.resolver)).toBe(1);
    const lines = h.logs.filter((l) => l.includes('payment-late-deposit'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'payment-late-deposit', severity: 'SEV1', orderId: i.orderId, csCase: 'PAYMENT_LATE_DEPOSIT' });
    expect(lines[0]).not.toContain(i.paymentKey);
    expect(await metric(QUERY, 'late_deposit')).toBe(late + 1);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'FAILED', failure_category: 'EXPIRED', next_query_at: null });
    expect(await outboxEvents(i)).toHaveLength(before);

    // 다시 온 통보는 조회하지 않는다(1회)
    const ignored = await metric(WEBHOOK, 'state_ignored');
    clock.advance(60_000);
    await h.webhook.receive('toss', {}, callbackBody(i, { transactionKey: 'tx-again' }));
    expect(await metric(WEBHOOK, 'state_ignored')).toBe(ignored + 1);
    expect(await drive(h.resolver)).toBe(0);
    expect(h.logs.filter((l) => l.includes('payment-late-deposit'))).toHaveLength(1);
  });

  test('P-T36_리뷰 고침 M6: 조회가 입금 완료가 아니면 로그 없이 끝난다', async () => {
    const i = await expiredRow();
    const late = await metric(QUERY, 'late_deposit');
    await h.webhook.receive('toss', {}, callbackBody(i));
    expect(await drive(h.resolver)).toBe(1);
    expect(h.logs.join('\n')).not.toContain('payment-late-deposit');
    expect(await metric(QUERY, 'late_deposit')).toBe(late);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'FAILED', next_query_at: null });
    clock.advance(60_000);
    expect(await drive(h.resolver)).toBe(0);
  });

  test('P-T36_리뷰 고침 M6: 통보가 DONE이 아니면 끝난 원장을 조회하지 않는다', async () => {
    const i = await expiredRow();
    await h.webhook.receive('toss', {}, callbackBody(i, { status: 'CANCELED' }));
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'FAILED', next_query_at: null, deposit_notified_at: null });
    expect(await drive(h.resolver)).toBe(0);
  });

  test('P-T36_리뷰 고침 M5: secret을 저장하지 못한 입금 대기의 통보는 수신 기록 없이 조회 신호만 낸다 [ASVS v5.0.0-16.3.3]', async () => {
    const i = await issued();
    await admin.pool.query('update payment set deposit_secret_hash = null where order_id = $1', [i.orderId]);
    await expect(h.webhook.receive('toss', {}, callbackBody(i))).resolves.toBe('ACCEPTED');
    expect(await receipts()).toBe(0);
    const row = await rowOf(i.orderId);
    expect(row.next_query_at!.getTime()).toBe(clock.now());
    expect(row.deposit_notified_at).toBeNull();
    expect(h.logs.join('\n')).not.toContain('payment-webhook-deposit-secret-mismatch');
  });

  test('P-T36_리뷰 고침 M5: 기한을 받지 못한 입금 대기는 1시간 조회를 이어 가고 SEV2는 처음 한 번이다', async () => {
    const i = await issued();
    await admin.pool.query('update payment set deposit_due_at = null, next_query_at = $2 where order_id = $1', [i.orderId, new Date(clock.now())]);
    queryHooks.set(i.paymentKey, async (res) => {
      const j = (await res.json()) as { virtualAccount: Record<string, unknown> } & Record<string, unknown>;
      return new Response(JSON.stringify({ ...j, virtualAccount: { ...j.virtualAccount, dueDate: undefined } }), { status: 200 });
    });
    h.logs.length = 0;
    expect(await drive(h.resolver)).toBe(1);
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(clock.now() + 3_600_000);
    expect(h.logs.join('\n')).not.toContain('payment-deposit-info-missing');
  });
});

describe('GetPayment', () => {
  test('P-T36_리뷰 고침 L7: 입금 기한이 지나면 계좌번호를 빼고 원장은 그대로다 [ASVS v5.0.0-14.2.7]', async () => {
    const i = await issued();
    clock.advance(i.dueAtMs - clock.now());
    const d = await unary(h.client, 'GetPayment', { order_id: i.orderId });
    const va = d.virtual_account as { bank: string; account_number: string; due_at: unknown };
    expect(va.account_number).toBe('');
    expect(va.bank).toBe(i.bank);
    expect(msOf(va.due_at)).toBe(i.dueAtMs);
    expect((await rowOf(i.orderId)).virtual_account_no).not.toBeNull();
  });

  test('P-T36 ③_입금 대기 동안 은행·계좌번호·입금 기한을 돌려준다 [ASVS v5.0.0-11.3.3]', async () => {
    const i = await issued();
    const d = await unary(h.client, 'GetPayment', { order_id: i.orderId });
    expect(d).toMatchObject({ order_id: i.orderId, pg: 'PG_PROVIDER_SIMULATOR', status: 'PAYMENT_STATUS_AWAITING_DEPOSIT', amount: { krw: i.amount }, cancelled_amount: { krw: 0 } });
    const va = d.virtual_account as { bank: string; account_number: string; due_at: unknown };
    expect(va.bank).toBe(i.bank);
    expect(va.account_number).toBe(i.accountNumber);
    expect(msOf(va.due_at)).toBe(i.dueAtMs);
  });

  test('P-T36_결제 ID로도 찾고, 입금이 확정되면 가상계좌 칸이 없다', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    await h.webhook.receive('toss', {}, callbackBody(i));
    await drive(h.resolver);
    const row = await rowOf(i.orderId);
    const d = await unary(h.client, 'GetPayment', { payment_id: row.id });
    expect(d.status).toBe('PAYMENT_STATUS_APPROVED');
    expect(d.virtual_account ?? null).toBeNull();
    expect(msOf(d.approved_at)).toBe(row.approved_at!.getTime());
  });

  test('P-T36_다른 행으로 옮긴 암호문은 열리지 않아 계좌번호 칸만 비고 SEV2다 [ASVS v5.0.0-11.3.3] [ASVS v5.0.0-16.3.3]', async () => {
    const a = await issued();
    const b = await issued();
    await admin.pool.query('update payment set virtual_account_no = (select virtual_account_no from payment where order_id = $1) where order_id = $2', [a.orderId, b.orderId]);
    const d = await unary(h.client, 'GetPayment', { order_id: b.orderId });
    expect((d.virtual_account as { bank: string; account_number: string }).account_number).toBe('');
    expect((d.virtual_account as { bank: string }).bank).toBe(b.bank);
    expect(h.logs.join('\n')).toContain('payment-virtual-account-unopened');
  });

  test('P-T36_없는 결제는 NOT_FOUND, 틀린 입력은 INVALID_ARGUMENT다 [ASVS v5.0.0-2.2.1]', async () => {
    expect((await failure(unary(h.client, 'GetPayment', { order_id: newId() }))).code).toBe(grpc.status.NOT_FOUND);
    expect((await failure(unary(h.client, 'GetPayment', { order_id: 'nope' }))).code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await failure(unary(h.client, 'GetPayment', {}))).code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  test('P-T36_결과 당기기 답에 입금 기한을 싣는다', async () => {
    const i = await issued();
    const r = (await unary(h.client, 'BatchGetPayments', { order_ids: [i.orderId] })).payments as Record<string, unknown>[];
    expect(msOf(r[0]!.deposit_due_at)).toBe(i.dueAtMs);
  });
});

describe('입금 전 취소(P-T36 ⑤)', () => {
  const cancelReq = (paymentId: string, cancellationId = `evt_${randomBytes(4).toString('hex')}`) => ({ payment_id: paymentId, cancellation_id: cancellationId, reason: '회차 취소' });

  test('P-T36 ⑤_입금 대기를 취소하면 FAILED(DEPOSIT_CANCELED)·사건·Outbox이고 주문이 T17로 좌석을 푼다 [ASVS v5.0.0-2.3.3]', async () => {
    const i = await issued();
    const paymentId = (await rowOf(i.orderId)).id;
    const r = await unary(h.client, 'CancelPayment', cancelReq(paymentId));
    expect(r).toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 0 } });
    expect(await control('GET', `/v1/payments/${i.paymentKey}`)).toMatchObject({ status: 'CANCELED' });
    const row = await rowOf(i.orderId);
    expect(row).toMatchObject({ status: 'FAILED', failure_category: 'DEPOSIT_CANCELED', virtual_account_no: null, deposit_secret_hash: null, next_query_at: null });
    const types = (await admin.pool.query<{ type: string; exported: boolean }>('select type, exported from payment_event where payment_id = $1 order by seq', [paymentId])).rows;
    expect(types.map((e) => e.type)).toEqual(['ACCEPTED', 'CONFIRM_SENT', 'AWAITING_DEPOSIT', 'DEPOSIT_CANCEL_SENT', 'FAILED']);
    expect(types.find((e) => e.type === 'DEPOSIT_CANCEL_SENT')!.exported).toBe(false);
    expect((await outboxEvents(i)).at(-1)).toMatchObject({ type: 'FAILED', failureCategory: 'DEPOSIT_CANCELED' });
    const { applied, order } = await applyToOrder(i);
    expect(applied.map((x) => x.transition)).toEqual(['T10', 'T17']);
    expect(order.status).toBe('FAILED');
  });

  test('P-T36 ⑤_같은 취소 ID를 다시 보내면 결제사를 다시 부르지 않고 같은 답이다', async () => {
    const i = await issued();
    const paymentId = (await rowOf(i.orderId)).id;
    const req = cancelReq(paymentId);
    await unary(h.client, 'CancelPayment', req);
    expect(await unary(h.client, 'CancelPayment', req)).toMatchObject({ result: 'CANCEL_RESULT_CANCELLED' });
    const n = (await admin.pool.query<{ n: string }>(`select count(*) as n from payment_event where payment_id = $1 and type = 'FAILED'`, [paymentId])).rows[0]!.n;
    expect(Number(n)).toBe(1);
  });

  test('P-T36 ⑤_입금 대기가 아니면 FAILED_PRECONDITION이다 [ASVS v5.0.0-2.3.1]', async () => {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    await h.webhook.receive('toss', {}, callbackBody(i));
    await drive(h.resolver);
    const paymentId = (await rowOf(i.orderId)).id;
    expect((await failure(unary(h.client, 'CancelPayment', cancelReq(paymentId)))).code).toBe(grpc.status.FAILED_PRECONDITION);
    expect((await rowOf(i.orderId)).status).toBe('APPROVED');
  });

  test('P-T36 ⑤_리뷰 고침 M3: 조회 뒤 원장이 먼저 끝나면 답 반영은 STALE이고 다시 읽은 상태로 답한다 [ASVS v5.0.0-15.4.1]', async () => {
    const i = await issued();
    const row = await rowOf(i.orderId);
    const store = new DrizzleConfirmJobs({ database: admin, clock });
    const target = (await store.readCancelTarget(row.id))!;
    await admin.pool.query(`update payment set status = 'FAILED' where id = $1`, [row.id]);
    await expect(store.finishDepositCancel(target, { remainingMs: 1_000 })).resolves.toBe('STALE');
    await expect(store.readCancelStatus(row.id, { remainingMs: 1_000 })).resolves.toBe('FAILED');
    await expect(store.readCancelStatus(newId())).resolves.toBeUndefined();
  });

  test('P-T36 ⑤_입력이 틀리면 INVALID_ARGUMENT, 없는 결제는 NOT_FOUND다 [ASVS v5.0.0-2.2.1]', async () => {
    expect((await failure(unary(h.client, 'CancelPayment', { payment_id: 'x', cancellation_id: 'a', reason: 'r' }))).code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await failure(unary(h.client, 'CancelPayment', cancelReq(newId())))).code).toBe(grpc.status.NOT_FOUND);
  });
});

describe('입금 오류 되돌림(P-T36 ④)', () => {
  const NOTIFIED_MS = 600_000;

  /** 입금을 확정한 원장(T16) */
  async function paid(): Promise<Issued> {
    const i = await issued();
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    await h.webhook.receive('toss', {}, callbackBody(i));
    await drive(h.resolver);
    expect((await rowOf(i.orderId)).status).toBe('APPROVED');
    clock.advance(10_000);
    return i;
  }
  const reversalBody = (i: Issued, over: Record<string, unknown> = {}): Buffer => callbackBody(i, { status: 'WAITING_FOR_DEPOSIT', transactionKey: `rev-${i.orderId}`, ...over });

  test('P-T36 ④_입금 확정 뒤에도 해시는 남고 계좌 칸은 지워진다 [ASVS v5.0.0-14.2.7]', async () => {
    const i = await paid();
    const row = await rowOf(i.orderId);
    expect(row.deposit_secret_hash!.equals(createHash('sha256').update(i.secret, 'utf8').digest())).toBe(true);
    expect(row).toMatchObject({ virtual_account_no: null, virtual_account_bank: null, deposit_due_at: null, next_query_at: null });
  });

  test('P-T36 ④_되돌림 통보 → 조회 확인 → AWAITING_DEPOSIT·DEPOSIT_REVERSED, 칸을 다시 저장하고 새 기한 + 10분에 조회한다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-11.3.3]', async () => {
    const i = await paid();
    const before = await rowOf(i.orderId);
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`);
    await expect(h.webhook.receive('toss', {}, reversalBody(i))).resolves.toBe('ACCEPTED');
    expect((await rowOf(i.orderId)).status).toBe('APPROVED');
    expect(await drive(h.resolver)).toBe(1);
    const row = await rowOf(i.orderId);
    expect(row).toMatchObject({ status: 'AWAITING_DEPOSIT', approved_at: null, deposit_notified_at: null, query_attempts: 0 });
    expect(row.virtual_account_bank).toBe(i.bank);
    expect(row.deposit_secret_hash!.equals(before.deposit_secret_hash!)).toBe(true);
    expect(row.next_query_at!.getTime()).toBe(row.deposit_due_at!.getTime() + DEPOSIT_QUERY_GRACE_MS);
    const d = await unary(h.client, 'GetPayment', { order_id: i.orderId });
    expect((d.virtual_account as { account_number: string }).account_number).toBe(i.accountNumber);
    const m = (await outboxEvents(i)).at(-1)!;
    expect(m).toMatchObject({ type: 'DEPOSIT_REVERSED', depositDueAt: row.deposit_due_at!.toISOString() });
    expect(PaymentEvent.safeParse(m).success).toBe(true);
    expect(await metric(QUERY, 'deposit_reversed')).toBeGreaterThan(0);
    expect(h.logs.join('\n')).not.toContain(i.accountNumber);
    expect(h.logs.join('\n')).not.toContain(i.secret);
  });

  test('P-T36 ④_결제사가 준 기한이 지났으면 되돌림 시점 다음 날 23:59(KST)를 새 기한으로 쓴다', async () => {
    const i = await paid();
    clock.advance(i.dueAtMs - clock.now() + 3_600_000);
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`);
    await h.webhook.receive('toss', {}, reversalBody(i));
    await drive(h.resolver);
    const kst = new Date(clock.now() + 9 * 3_600_000);
    const expected = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 23, 59) - 9 * 3_600_000;
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('AWAITING_DEPOSIT');
    expect(row.deposit_due_at!.getTime()).toBe(expected);
    expect(row.next_query_at!.getTime()).toBe(expected + DEPOSIT_QUERY_GRACE_MS);
    expect((await outboxEvents(i)).at(-1)).toMatchObject({ type: 'DEPOSIT_REVERSED', depositDueAt: new Date(expected).toISOString() });
  });

  test('P-T36 ④_결제사가 준 기한이 남아 있으면 그 기한을 그대로 쓴다', async () => {
    const i = await paid();
    const due = Math.floor((clock.now() + 3 * 86_400_000) / 1_000) * 1_000;
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`, { dueDate: new Date(due).toISOString() });
    await h.webhook.receive('toss', {}, reversalBody(i));
    await drive(h.resolver);
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('AWAITING_DEPOSIT');
    expect(row.deposit_due_at!.getTime()).toBe(due);
  });

  test('P-T36 ④_재입금하면 T16 경로로 승인하고 approved_at을 새로 쓴다', async () => {
    const i = await paid();
    const firstApproved = (await rowOf(i.orderId)).approved_at!.getTime();
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`);
    await h.webhook.receive('toss', {}, reversalBody(i));
    await drive(h.resolver);
    clock.advance(60_000);
    await control('POST', `/sim/deposits/${i.paymentKey}`);
    const cb = (await control('GET', `/sim/deposit-callbacks?orderId=${i.orderId}`)) as unknown as { status: string; transactionKey: string }[];
    expect(cb.map((c) => c.status)).toEqual(['DONE', 'WAITING_FOR_DEPOSIT', 'DONE']);
    await h.webhook.receive('toss', {}, callbackBody(i, { transactionKey: cb[2]!.transactionKey }));
    await drive(h.resolver);
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('APPROVED');
    expect(row.approved_at!.getTime()).toBeGreaterThan(firstApproved);
    expect((await outboxEvents(i)).at(-1)).toMatchObject({ type: 'APPROVED' });
  });

  test('P-T36 ④_위조 통보는 수신 기록·조회 없이 보안 로그다 [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-8.2.2]', async () => {
    const i = await paid();
    const n = await receipts();
    const before = await metric(WEBHOOK, 'deposit_secret_mismatch');
    await expect(h.webhook.receive('toss', {}, reversalBody(i, { secret: 'forged-secret' }))).resolves.toBe('ACCEPTED');
    expect(await receipts()).toBe(n);
    expect(await metric(WEBHOOK, 'deposit_secret_mismatch')).toBe(before + 1);
    expect(h.logs.join('\n')).toContain('payment-webhook-deposit-secret-mismatch');
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'APPROVED', next_query_at: null });
    expect(await drive(h.resolver)).toBe(0);
  });

  test('P-T36 ④_같은 통보를 다시 보내면 중복이고 되돌림은 한 번이다', async () => {
    const i = await paid();
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`);
    await h.webhook.receive('toss', {}, reversalBody(i));
    const dup = await metric(WEBHOOK, 'duplicate');
    await h.webhook.receive('toss', {}, reversalBody(i));
    expect(await metric(WEBHOOK, 'duplicate')).toBe(dup + 1);
    await drive(h.resolver);
    const paymentId = (await rowOf(i.orderId)).id;
    const n = (await admin.pool.query<{ n: string }>(`select count(*) as n from payment_event where payment_id = $1 and type = 'DEPOSIT_REVERSED'`, [paymentId])).rows[0]!.n;
    expect(Number(n)).toBe(1);
  });

  test('P-T36 ④_이미 되돌린 결제에 되돌림을 다시 쓰면 STALE이고 사건 순번·수출 사건이 늘지 않는다(겹친 조회의 재전송) [ASVS v5.0.0-2.3.3]', async () => {
    const i = await paid();
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`);
    await h.webhook.receive('toss', {}, reversalBody(i));
    await drive(h.resolver);
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('AWAITING_DEPOSIT');
    const eventsOf = async () => (await admin.pool.query<{ seq: string; type: string }>('select seq::text as seq, type from payment_event where payment_id = $1 order by seq', [row.id])).rows;
    const before = await eventsOf();
    const outboxBefore = (await outboxEvents(i)).length;
    const job = { paymentId: row.id, orderId: i.orderId, eventId: i.eventId, attemptNo: 1, pg: 'TOSS', paymentRef: i.paymentKey, amount: 10_000, queryAttempts: 1, claimedNextQueryAtMs: clock.now(), anomalyLogged: false, reversalCheck: {} } as unknown as Parameters<DrizzleConfirmJobs['reverseDeposit']>[0];
    const again = await new DrizzleConfirmJobs({ database: admin, clock }).reverseDeposit(job, { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', reversed: true, deposit: { dueAtMs: clock.now() + 86_400_000 } });
    expect(again).toBe('STALE');
    expect(await eventsOf()).toEqual(before);
    expect((await outboxEvents(i)).length).toBe(outboxBefore);
  });

  test('P-T36 ④_결제사 상태가 입금 완료면 원장을 바꾸지 않고, 10분이 지나면 묻기를 끝낸다 [ASVS v5.0.0-16.5.3]', async () => {
    const i = await paid();
    await h.webhook.receive('toss', {}, reversalBody(i));
    expect(await drive(h.resolver)).toBe(1);
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('APPROVED');
    expect(row.next_query_at!.getTime()).toBe(clock.now() + 5_000);
    clock.advance(NOTIFIED_MS + 1);
    expect(await drive(h.resolver)).toBe(1);
    expect(await rowOf(i.orderId)).toMatchObject({ status: 'APPROVED', next_query_at: null, deposit_notified_at: null });
    expect(h.logs.join('\n')).toContain('payment-deposit-reversal-unconfirmed');
    expect(await metric(QUERY, 'reversal_unconfirmed')).toBeGreaterThan(0);
    expect(await drive(h.resolver)).toBe(0);
  });

  test('P-T36 ④_리뷰 고침 H2: 조회가 기록 없음이면 창이 지나도 끝내지 않고 60초마다 묻고, 1시간에 SEV1을 한 번 낸다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const i = await paid();
    await h.webhook.receive('toss', {}, reversalBody(i));
    const paymentId = (await rowOf(i.orderId)).id;
    await admin.pool.query(`update payment set pg_payment_ref = 'tgen_missing_payment' where id = $1`, [paymentId]);
    clock.advance(NOTIFIED_MS + 1);
    expect(await drive(h.resolver)).toBe(1);
    const row = await rowOf(i.orderId);
    expect(row.status).toBe('APPROVED');
    expect(row.next_query_at!.getTime()).toBe(clock.now() + 60_000);
    expect(row.deposit_notified_at).not.toBeNull();
    clock.advance(3_600_000);
    expect(await drive(h.resolver)).toBe(1);
    const count = () => h.logs.join('\n').split('payment-deposit-reversal-overdue').length - 1;
    expect(count()).toBe(1);
    clock.advance(60_000);
    expect(await drive(h.resolver)).toBe(1);
    expect(count()).toBe(1);
    expect((await rowOf(i.orderId)).next_query_at!.getTime()).toBe(clock.now() + 60_000);
  });

  test('P-T36 ④_리뷰 고침 H2: 앞선 UNKNOWN 1시간 표시가 있어도 새 되돌림 통보의 SEV1은 낸다', async () => {
    const i = await paid();
    const paymentId = (await rowOf(i.orderId)).id;
    await admin.pool.query('update payment set overdue_at = $1 where id = $2', [new Date(clock.now() - 86_400_000), paymentId]);
    await h.webhook.receive('toss', {}, reversalBody(i));
    expect((await admin.pool.query<{ overdue_at: Date | null }>('select overdue_at from payment where id = $1', [paymentId])).rows[0]!.overdue_at).toBeNull();
  });

  test('P-T36 ④_리뷰 고침 L7: 되돌린 결제를 잡으면 T21 시각을 함께 읽는다', async () => {
    const i = await paid();
    await control('POST', `/sim/deposits/${i.paymentKey}/reverse`);
    await h.webhook.receive('toss', {}, reversalBody(i));
    await drive(h.resolver);
    const row = await rowOf(i.orderId);
    const reversedAt = (await admin.pool.query<{ occurred_at: Date }>(`select occurred_at from payment_event where payment_id = $1 and type = 'DEPOSIT_REVERSED'`, [row.id])).rows[0]!.occurred_at;
    await admin.pool.query('update payment set next_query_at = $1 where id = $2', [new Date(clock.now() - 1), row.id]);
    const jobs = await new DrizzleConfirmJobs({ database: admin, clock }).claimDueQueries('SIMULATOR', 100);
    expect(jobs.find((j) => j.paymentId === row.id)?.deposit?.reversedAtMs).toBe(reversedAt.getTime());
  });

  test('P-T36 ④_리뷰 고침 L8: createdAt이 다른 같은 거래의 되돌림 통보는 중복이 아니고 같은 통보만 중복이다', async () => {
    const i = await paid();
    const dup = await metric(WEBHOOK, 'duplicate');
    const at = (createdAt: string) => reversalBody(i, { createdAt });
    await h.webhook.receive('toss', {}, at('2026-11-20T10:00:00.000000'));
    clock.advance(10_000);
    await h.webhook.receive('toss', {}, at('2026-11-21T10:00:00.000000'));
    expect(await metric(WEBHOOK, 'duplicate')).toBe(dup);
    await h.webhook.receive('toss', {}, at('2026-11-21T10:00:00.000000'));
    expect(await metric(WEBHOOK, 'duplicate')).toBe(dup + 1);
  });

  test('P-T36 ④_재전송 DONE은 조회를 걸지 않는다', async () => {
    const i = await paid();
    const ignored = await metric(WEBHOOK, 'state_ignored');
    await h.webhook.receive('toss', {}, callbackBody(i, { transactionKey: `again-${i.orderId}` }));
    expect(await metric(WEBHOOK, 'state_ignored')).toBe(ignored + 1);
    expect((await rowOf(i.orderId)).next_query_at).toBeNull();
  });
});
