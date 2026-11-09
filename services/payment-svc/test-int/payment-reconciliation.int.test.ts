// 일일 대사(BUILD_ORDER HOT-153, docs/features/payment.md §8 '대사의 첫 구현', P-T32)를 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터(buildSimulatorApp)로 돈다.
// 실제 저장소(DrizzleReconciliation·DrizzleConfirmJobs)와 실제 어댑터(토스·포트원 모양)를 쓴다. Kafka 모듈을 불러오지 않는다(응용 프로그램 제어로 막힌 PC에서도 돈다).
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓰고 시험마다 표를 비운다. 시계는 가짜(2026-11-10 00:10 KST)다.
// - 결제사 쪽 거래는 시뮬레이터의 씨앗으로, 원장 쪽 행은 SQL로 직접 넣는다(불일치를 정확히 주입하려고).
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, fakeClock, type FakeClock, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import { ReconRunLostError } from '../src/modules/payment/domain/reconciliation.js';
import {
  deleteExpiredDepositHashes,
  deleteFinishedReconSeen,
  DEPOSIT_SECRET_HASH_RETENTION_MS,
  DrizzleConfirmJobs,
  DrizzleReconciliation,
  PaymentReconciliation,
  paymentReconciliationLog,
  PaymentUnknownResolver,
  paymentUnknownLog,
  PgCallGuards,
  pgCallGuardLog,
  PortoneGateway,
  PromPaymentReconciliationSignals,
  PromPaymentUnknownSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
  TRADE_PAYMENTS_TOPIC,
} from '../src/modules/payment/server.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { newId } from './support.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const NOW = KST('2026-11-10T00:10:00');
const AT = KST('2026-11-09T12:00:00');
const DATE = '2026-11-09';

let pgc: PostgresContainer | undefined;
let admin: Database;
let database: Database;
let sim: SimulatorApp;
let simUrl: string;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'recon-it-admin' });
  database = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'recon-it' });
  await ensureOutboxPartitions(admin, systemClock);
  sim = buildSimulatorApp({ secretKey: KEY, clock: { now: () => NOW }, seed: 11, confirmLatency: { kind: 'none' } });
  simUrl = await sim.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  await sim?.close();
  await Promise.allSettled([admin?.close(), database?.close()]);
  pgc?.stop();
});

const basic = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
async function control(method: string, path: string, body?: unknown): Promise<void> {
  const r = await fetch(`${simUrl}${path}`, { method, headers: { authorization: basic, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (r.status >= 300) throw new Error(`시뮬레이터 ${method} ${path}: ${r.status} ${await r.text()}`);
}

beforeEach(async () => {
  await admin.pool.query('truncate table payment, payment_event, payment_confirm_job, webhook_receipt, reconciliation_run, reconciliation_seen, reconciliation_diff restart identity cascade');
  await admin.pool.query('truncate table outbox');
  await control('POST', '/sim/reset');
  await markEarlierDaysDone();
});

/** 전날 앞의 엿새를 끝난 날로 둔다(시험마다 전날 하나만 돌게, 리뷰 고침 H4의 시험은 지운다) */
async function markEarlierDaysDone(): Promise<void> {
  await admin.pool.query(
    `insert into reconciliation_run (id, pg, recon_date, status, stage, owner, generation, started_at, finished_at)
     select gen_random_uuid(), p, d::date, 'DONE', 'PULLING', 'seed', 1, $1, $1
     from unnest(array['TOSS', 'PORTONE', 'SIMULATOR']) as p, generate_series('2026-11-03'::date, '2026-11-08'::date, interval '1 day') as d`,
    [new Date(NOW)],
  );
}

interface LedgerSeed {
  ref: string;
  orderId?: string;
  pg?: string;
  status: string;
  amount?: number;
  approvedAtMs?: number;
  hash?: boolean;
}

async function ledgerRow(o: LedgerSeed): Promise<{ id: string; orderId: string }> {
  const id = newId();
  const orderId = o.orderId ?? newId();
  await admin.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, created_at, approved_at, status_changed_at, next_query_at, deposit_secret_hash)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8::text, $9, $10, $10, $11, $10, case when $8::text in ('UNKNOWN', 'AWAITING_DEPOSIT') then to_timestamp($12 / 1000.0) end, $13)`,
    [id, orderId, newId(), newId(), o.pg ?? 'TOSS', o.ref, o.amount ?? 1000, o.status, `confirm-${orderId}`, new Date(AT - 60_000), o.approvedAtMs === undefined ? null : new Date(o.approvedAtMs), NOW + 3_600_000, o.hash ? Buffer.from('abc') : null],
  );
  return { id, orderId };
}

const statusOf = async (id: string) => (await admin.pool.query<{ status: string; next_query_at: Date | null }>('select status, next_query_at from payment where id = $1', [id])).rows[0]!;
const diffs = async () =>
  (await admin.pool.query<{ kind: string; state: string; payment_ref: string; order_ref: string; ledger_status: string | null; pg_status: string | null; ledger_amount: number | null; pg_amount: number | null }>('select * from reconciliation_diff order by payment_ref, kind')).rows;
const runOf = async (pg: string) => (await admin.pool.query('select * from reconciliation_run where pg = $1 and recon_date = $2', [pg, DATE])).rows[0] as { status: string; stage: string; pg_cursor: string | null; listed_count: number; matched_count: number; mismatch_count: number } | undefined;

interface Stack {
  app: PaymentReconciliation;
  clock: FakeClock;
  logs: () => Record<string, unknown>[];
  metrics: () => Promise<string>;
  resolver: PaymentUnknownResolver;
}

function stack(adapters: { pg: 'TOSS' | 'PORTONE'; fetchHook?: (req: { url: string }, real: typeof fetch) => Promise<Response> }[] = [{ pg: 'TOSS' }]): Stack {
  const clock = fakeClock({ now: NOW });
  const lines: string[] = [];
  const destination = new Writable({
    write: (c, _e, cb) => {
      for (const l of String(c).split('\n')) if (l.trim()) lines.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
  const metrics = new PlatformMetrics('payment-svc');
  const signals = new PromPaymentReconciliationSignals().register(metrics.registry);
  const made = adapters.map((a) => {
    const f = a.fetchHook === undefined ? undefined : (((input: Parameters<typeof fetch>[0], init?: RequestInit) => a.fetchHook!({ url: String(input) }, (x, y) => fetch(x, y))) as unknown as typeof fetch);
    const shared = f === undefined ? {} : { queryFetch: f, fetch: f };
    if (a.pg === 'PORTONE') return new PortoneGateway({ baseUrl: simUrl, secret: KEY, storeId: 'store-sim', channelKey: 'c', webhookSecrets: [], isTest: true, ...shared });
    return new TossPaymentGateway({ baseUrl: simUrl, secretKey: KEY, clientKey: 'sim_ck_x', callsPerSecond: 300, ...shared });
  });
  const gateways = new StaticPaymentGateways(made);
  const jobs = new DrizzleConfirmJobs({ database, clock });
  const store = new DrizzleReconciliation({ database, clock });
  const app = new PaymentReconciliation({ store, closer: jobs, gateways, calendar: { active: async () => false }, log: paymentReconciliationLog(logger), signals, clock, sleep: async () => {} });
  const guards = new PgCallGuards({ gateways, podCount: 1, clock, signals: new PromPgCallGuardSignals(), log: pgCallGuardLog(logger) });
  const resolver = new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals(), clock });
  return { app, clock, logs: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>), metrics: () => metrics.registry.metrics(), resolver };
}

const seed = (items: { paymentKey: string; orderId: string; amount: number; status: 'DONE' | 'CANCELED' | 'PARTIAL_CANCELED'; atMs?: number }[]) => control('POST', '/sim/transactions/seed', { items: items.map((i) => ({ atMs: AT, ...i })) });

describe('P-T32 대사(시뮬레이터 + 실제 DB)', () => {
  test('P-T32_불일치를 주입하면(누락·금액 차이·결제사 혼동·취소·늦은 입금) 모두 찾고 건마다 SEV1 한 번, 원장은 그대로다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-16.2.5]', async () => {
    const okOrder = newId();
    const amountOrder = newId();
    const wrongPgOrder = newId();
    const canceledOrder = newId();
    const lateOrder = newId();
    await seed([
      { paymentKey: 'ok-1', orderId: okOrder, amount: 1000, status: 'DONE' },
      { paymentKey: 'missing-1', orderId: newId(), amount: 1000, status: 'DONE' },
      { paymentKey: 'amount-1', orderId: amountOrder, amount: 2000, status: 'DONE' },
      { paymentKey: 'wrongpg-1', orderId: wrongPgOrder, amount: 1000, status: 'DONE' },
      { paymentKey: 'pg-canceled-1', orderId: canceledOrder, amount: 1000, status: 'CANCELED' },
      { paymentKey: 'late-1', orderId: lateOrder, amount: 1000, status: 'DONE' },
    ]);
    const ok = await ledgerRow({ ref: 'ok-1', orderId: okOrder, status: 'APPROVED', approvedAtMs: AT });
    await ledgerRow({ ref: 'amount-1', orderId: amountOrder, status: 'APPROVED', amount: 1000, approvedAtMs: AT });
    await ledgerRow({ ref: 'wrongpg-1', orderId: wrongPgOrder, pg: 'PORTONE', status: 'APPROVED', approvedAtMs: AT });
    const appr = await ledgerRow({ ref: 'pg-canceled-1', orderId: canceledOrder, status: 'APPROVED', approvedAtMs: AT });
    const late = await ledgerRow({ ref: 'late-1', orderId: lateOrder, status: 'FAILED' });
    const unseen = await ledgerRow({ ref: 'ghost-1', status: 'APPROVED', approvedAtMs: AT });

    const s = stack();
    const report = await s.app.runDaily();

    expect(report).toMatchObject({ runs: [{ pg: 'TOSS', date: DATE, status: 'DONE' }] });
    expect(await runOf('TOSS')).toMatchObject({ status: 'DONE', listed_count: 7, matched_count: 1, mismatch_count: 6 });
    const rows = await diffs();
    expect(rows.map((r) => [r.payment_ref, r.kind, r.state])).toEqual([
      ['amount-1', 'AMOUNT_MISMATCH', 'OPEN'],
      ['ghost-1', 'LEDGER_APPROVED_NO_PG_RECORD', 'OPEN'],
      ['late-1', 'LEDGER_FAILED_PG_APPROVED', 'OPEN'],
      ['missing-1', 'PG_APPROVED_NO_LEDGER', 'OPEN'],
      ['pg-canceled-1', 'LEDGER_APPROVED_PG_NOT_PAID', 'OPEN'],
      ['wrongpg-1', 'PG_MISMATCH', 'OPEN'],
    ]);
    expect(rows.find((r) => r.payment_ref === 'amount-1')).toMatchObject({ ledger_amount: 1000, pg_amount: 2000, ledger_status: 'APPROVED', pg_status: 'APPROVED' });
    // 원장을 임의로 바꾸지 않는다
    for (const id of [ok.id, appr.id, late.id, unseen.id]) expect((await statusOf(id)).status).toBe(id === late.id ? 'FAILED' : 'APPROVED');
    const sev1 = s.logs().filter((l) => l.kind === 'payment-reconciliation-mismatch');
    expect(sev1.map((l) => l.diffKind).sort()).toEqual(['AMOUNT_MISMATCH', 'LEDGER_APPROVED_NO_PG_RECORD', 'LEDGER_APPROVED_PG_NOT_PAID', 'LEDGER_FAILED_PG_APPROVED', 'PG_APPROVED_NO_LEDGER', 'PG_MISMATCH']);
    expect(sev1.every((l) => l.severity === 'SEV1')).toBe(true);
    expect(JSON.stringify(s.logs())).not.toContain('ok-1'); // 결제 키는 로그에 싣지 않는다
    expect(s.logs().find((l) => l.diffKind === 'LEDGER_FAILED_PG_APPROVED')).toMatchObject({ csCase: 'PAYMENT_LATE_DEPOSIT' });
    expect(await s.metrics()).toContain('payment_reconciliation_runs_total{pg="TOSS",result="done"} 1');
    expect((await s.metrics()).split('\n').find((l) => l.startsWith('payment_reconciliation_last_mismatches{pg="TOSS"}'))).toMatch(/ 6$/);
    expect((await admin.pool.query('select count(*)::int as n from reconciliation_seen')).rows[0]).toMatchObject({ n: 0 });
  });

  test('P-T32_다시 돌려도 불일치 기록과 SEV1이 하나다(실행은 DONE이라 부르지 않고, 같은 건이 다음 날 잡혀도 한 번) [ASVS v5.0.0-2.3.4]', async () => {
    await seed([{ paymentKey: 'missing-1', orderId: newId(), amount: 1000, status: 'DONE' }]);
    const s = stack();
    await s.app.runDaily();
    await s.app.runDaily();
    expect(await diffs()).toHaveLength(1);
    expect(s.logs().filter((l) => l.kind === 'payment-reconciliation-mismatch')).toHaveLength(1);
  });

  test('P-T32_결제사 승인 + UNKNOWN은 조회로 넘겨(next_query_at = 지금) 단독 조회가 끝낸다 [ASVS v5.0.0-2.3.3]', async () => {
    const orderId = newId();
    await seed([{ paymentKey: 'unknown-1', orderId, amount: 1000, status: 'DONE' }]);
    const row = await ledgerRow({ ref: 'unknown-1', orderId, status: 'UNKNOWN' });
    const s = stack();
    await s.app.runDaily();
    expect(await statusOf(row.id)).toMatchObject({ status: 'UNKNOWN', next_query_at: new Date(NOW) });
    expect(await diffs()).toMatchObject([{ kind: 'UNKNOWN_HANDED_OFF', state: 'HANDED_OFF' }]);

    await s.resolver.tick();
    await s.resolver.whenIdle();
    expect((await statusOf(row.id)).status).toBe('APPROVED');
  });

  test('P-T32_결제사 전액 취소 + UNKNOWN은 원장을 CANCELED로 닫고 CANCELED·RESOLVED 사건과 Outbox를 쓴다 [ASVS v5.0.0-2.3.3]', async () => {
    const orderId = newId();
    await seed([{ paymentKey: 'unknown-c', orderId, amount: 1000, status: 'CANCELED' }]);
    const row = await ledgerRow({ ref: 'unknown-c', orderId, status: 'UNKNOWN' });
    const s = stack();
    await s.app.runDaily();

    expect(await statusOf(row.id)).toMatchObject({ status: 'CANCELED', next_query_at: null });
    const events = (await admin.pool.query('select type, seq from payment_event where payment_id = $1 order by seq', [row.id])).rows;
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['CANCELED', 'RESOLVED']);
    const outbox = (await admin.pool.query('select payload from outbox where topic = $1 order by seq', [TRADE_PAYMENTS_TOPIC])).rows;
    expect(outbox.map((o) => JSON.parse(Buffer.from((o as { payload: Buffer }).payload).toString()).type)).toEqual(['CANCELED', 'RESOLVED']);
    expect(await diffs()).toMatchObject([{ kind: 'UNKNOWN_CANCELED_CLOSED', state: 'CLOSED' }]);
    // 닫힌 건을 다시 돌려도 사건이 늘지 않는다
    await s.app.runDaily();
    expect((await admin.pool.query('select count(*)::int as n from payment_event where payment_id = $1', [row.id])).rows[0]).toMatchObject({ n: 2 });
  });

  test('P-T32_부분 취소 + UNKNOWN은 CS로 두고 닫지 않는다(기록·SEV1) [ASVS v5.0.0-16.3.3]', async () => {
    const orderId = newId();
    await seed([{ paymentKey: 'unknown-p', orderId, amount: 1000, status: 'PARTIAL_CANCELED' }]);
    const row = await ledgerRow({ ref: 'unknown-p', orderId, status: 'UNKNOWN' });
    const s = stack();
    await s.app.runDaily();
    expect((await statusOf(row.id)).status).toBe('UNKNOWN');
    expect(await diffs()).toMatchObject([{ kind: 'PARTIAL_CANCELED_AT_PG', state: 'OPEN' }]);
    expect(s.logs().find((l) => l.diffKind === 'PARTIAL_CANCELED_AT_PG')).toMatchObject({ severity: 'SEV1', orderId });
  });

  test('P-T32_받기 도중 멈춰도 저장한 커서에서 이어 해 같은 결과다(양쪽 다시 부르지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const items = Array.from({ length: 2500 }, (_, i) => ({ paymentKey: `bulk-${String(i).padStart(5, '0')}`, orderId: newId(), amount: 1000, status: 'DONE' as const }));
    await seed(items);
    let calls = 0;
    const stop = new AbortController();
    const s = stack([
      {
        pg: 'TOSS',
        fetchHook: async (req, real) => {
          calls += 1;
          const res = await real(req.url, { headers: { authorization: basic } });
          stop.abort();
          return res;
        },
      },
    ]);
    await s.app.runDaily(stop.signal);
    expect(await runOf('TOSS')).toMatchObject({ status: 'RUNNING', stage: 'LISTING', listed_count: 1000 });
    const firstCursor = (await runOf('TOSS'))!.pg_cursor;
    expect(firstCursor).toBeTruthy();
    expect(calls).toBe(1);

    const s2 = stack();
    await s2.app.runDaily();
    expect(await runOf('TOSS')).toMatchObject({ status: 'DONE', listed_count: 2500, mismatch_count: 2500 });
    expect(await diffs()).toHaveLength(2500);
  }, 60_000);

  test('P-T32_양쪽 어댑터 모양: 포트원 경로로도 같은 비교를 한다(결제 한 건 한 줄)', async () => {
    const orderId = newId();
    await seed([
      { paymentKey: `pay-${orderId}`, orderId, amount: 1000, status: 'DONE' },
      { paymentKey: 'pay-missing', orderId: 'order-missing-1', amount: 1000, status: 'DONE' },
    ]);
    await ledgerRow({ ref: `pay-${orderId}`, orderId, pg: 'PORTONE', status: 'APPROVED', approvedAtMs: AT });
    const s = stack([{ pg: 'PORTONE' }]);
    const report = await s.app.runDaily();
    expect(report).toMatchObject({ runs: [{ pg: 'PORTONE', status: 'DONE', matched: 1, mismatched: 1 }] });
    expect(await diffs()).toMatchObject([{ kind: 'PG_APPROVED_NO_LEDGER', payment_ref: 'pay-missing', order_ref: 'missing' }]);
    expect(await runOf('PORTONE')).toMatchObject({ status: 'DONE' });
  });

  test('P-T32_결제사 조회가 계속 실패하면 FAILED로 끝내고 원장은 그대로다(SEV2, 지표) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.3.4]', async () => {
    const row = await ledgerRow({ ref: 'ok-1', status: 'APPROVED', approvedAtMs: AT });
    const s = stack([{ pg: 'TOSS', fetchHook: async () => new Response('{}', { status: 500 }) }]);
    const report = await s.app.runDaily();
    expect(report).toMatchObject({ runs: [{ status: 'FAILED' }] });
    expect(await runOf('TOSS')).toMatchObject({ status: 'FAILED' });
    expect((await statusOf(row.id)).status).toBe('APPROVED');
    expect(s.logs().find((l) => l.kind === 'payment-reconciliation-failed')).toMatchObject({ severity: 'SEV2', pg: 'TOSS', date: DATE });
    expect(await s.metrics()).toContain('payment_reconciliation_runs_total{pg="TOSS",result="failed"} 1');
  });

  test('P-T32_해시 지우기: 입금 확정 90일 지난 행의 해시만 비운다 [ASVS v5.0.0-14.2.7]', async () => {
    const windowNow = KST('2026-11-10T04:30:00');
    const old = await ledgerRow({ ref: 'old', status: 'APPROVED', approvedAtMs: windowNow - DEPOSIT_SECRET_HASH_RETENTION_MS - 1000, hash: true });
    const fresh = await ledgerRow({ ref: 'fresh', status: 'APPROVED', approvedAtMs: windowNow - DEPOSIT_SECRET_HASH_RETENTION_MS + 60_000, hash: true });
    const clock = fakeClock({ now: windowNow });
    const r = await deleteExpiredDepositHashes(database, { clock });
    expect(r.deleted).toBe(1);
    const hashOf = async (id: string) => (await admin.pool.query<{ h: Buffer | null }>('select deposit_secret_hash as h from payment where id = $1', [id])).rows[0]!.h;
    expect(await hashOf(old.id)).toBeNull();
    expect(await hashOf(fresh.id)).not.toBeNull();
  });
});

describe('P-T32 대사 리뷰 고침(실제 DB)', () => {
  const store = () => new DrizzleReconciliation({ database, clock: fakeClock({ now: NOW }) });
  const seen = (ref: string, atMs: number, status: 'APPROVED' | 'CANCELED' = 'APPROVED') => ({ paymentRef: ref, orderRef: newId(), pgStatus: status, amount: 1000, atMs });

  test('P-T32_리뷰 고침 H1: 다시 시작하면 세대가 올라 옛 실행의 쓰기는 거절되고 작업 표를 읽어도 빈 답이다(오탐 없음) [ASVS v5.0.0-2.3.3]', async () => {
    const s = store();
    const old = (await s.beginRun('TOSS', DATE, NOW, 'pod-a'))!;
    await s.saveListedPage(old, [seen('r1', AT)], undefined, 1);
    const fresh = (await s.beginRun('TOSS', DATE, NOW, 'pod-b'))!;
    expect(fresh.generation).toBe(old.generation + 1);
    expect((await admin.pool.query('select owner, generation from reconciliation_run where id = $1', [old.id])).rows[0]).toMatchObject({ owner: 'pod-b', generation: fresh.generation });
    await expect(s.saveListedPage(old, [seen('r2', AT)], undefined, 1)).rejects.toBeInstanceOf(ReconRunLostError);
    await expect(s.finishCompareBatch(old, undefined, 0, 0)).rejects.toBeInstanceOf(ReconRunLostError);
    await expect(s.finishLedgerBatch(old, undefined, 0)).rejects.toBeInstanceOf(ReconRunLostError);
    await expect(s.finishRun(old, 'DONE', NOW)).rejects.toBeInstanceOf(ReconRunLostError);
    await expect(s.readCompareBatch(old, 10)).resolves.toEqual([]);
    await expect(s.readLedgerBatch(old, 10)).resolves.toEqual([]);
    // 옛 실행의 쓰기는 작업 표를 바꾸지 않았고 지금 실행은 그대로 읽는다
    expect((await s.readCompareBatch(fresh, 10)).map((r) => r.paymentRef)).toEqual(['r1']);
  });

  test('P-T32_리뷰 고침 H4: 기간 앞의 끝내지 못한 날과 빠진 날을 찾는다 [ASVS v5.0.0-16.3.4]', async () => {
    await admin.pool.query(
      `insert into reconciliation_run (id, pg, recon_date, status, stage, owner, generation, started_at) values
       (gen_random_uuid(), 'TOSS', '2026-10-28', 'DONE', 'PULLING', 'x', 1, $1),
       (gen_random_uuid(), 'TOSS', '2026-10-30', 'FAILED', 'LISTING', 'x', 1, $1)`,
      [new Date(NOW)],
    );
    await expect(store().overdueDates('TOSS', '2026-11-03')).resolves.toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    await expect(store().overdueDates('SIMULATOR', '2026-11-03')).resolves.toEqual([]);
  });

  test('P-T32_리뷰 고침 M8: 끝난 실행과 기간을 넘긴 실행의 작업 행만 지운다. 이어 할 실행의 행은 남긴다 [ASVS v5.0.0-14.2.7]', async () => {
    const insertRun = async (date: string, status: string) => {
      const id = newId();
      await admin.pool.query(`insert into reconciliation_run (id, pg, recon_date, status, stage, owner, generation, started_at) values ($1, 'TOSS', $2, $3, 'COMPARING', 'x', 1, $4) on conflict (pg, recon_date) do update set id = excluded.id, status = excluded.status`, [id, date, status, new Date(NOW)]);
      await admin.pool.query(`insert into reconciliation_seen (run_id, payment_ref, order_ref, pg_status, amount, seen_at) values ($1, 'r', 'o', 'APPROVED', 1, $2)`, [id, new Date(AT)]);
      return id;
    };
    const done = await insertRun('2026-11-08', 'DONE');
    const expired = await insertRun('2026-10-20', 'FAILED');
    const resumable = await insertRun('2026-11-07', 'FAILED');
    const running = await insertRun('2026-11-09', 'RUNNING');
    const windowNow = KST('2026-11-10T04:30:00');
    const r = await deleteFinishedReconSeen(database, { clock: fakeClock({ now: windowNow }) });
    expect(r.deleted).toBe(2);
    const left = (await admin.pool.query<{ run_id: string }>('select run_id from reconciliation_seen')).rows.map((x) => x.run_id).sort();
    expect(left).toEqual([resumable, running].sort());
    expect(left).not.toContain(done);
    expect(left).not.toContain(expired);
  });

  test('P-T32_리뷰 고침 M9: 대상 날짜 안의 줄이 여백의 줄보다 앞선다(받는 차례와 상관없이). 여백 줄만 있으면 맞추기에 나오지 않고 존재 확인에만 쓰인다', async () => {
    const s = store();
    const run = (await s.beginRun('TOSS', DATE, NOW, 'a'))!;
    const inDay = KST('2026-11-09T23:59:00');
    const margin = KST('2026-11-10T00:05:00');
    await s.saveListedPage(run, [seen('later-margin', inDay), seen('margin-first', margin, 'CANCELED'), seen('only-margin', margin, 'CANCELED')], 'c', 3);
    await s.saveListedPage(run, [seen('later-margin', margin, 'CANCELED'), seen('margin-first', inDay)], undefined, 2);
    const rows = await s.readCompareBatch(run, 10);
    expect(rows.map((r) => [r.paymentRef, r.pgStatus])).toEqual([['later-margin', 'APPROVED'], ['margin-first', 'APPROVED']]);
    expect(rows.map((r) => r.paymentRef)).not.toContain('only-margin');
  });

  test('P-T32_리뷰 고침 H2: 원장의 상태 바뀐 시각을 맞추기 줄에 싣는다', async () => {
    const s = store();
    const orderId = newId();
    await ledgerRow({ ref: 'r1', orderId, status: 'APPROVED', approvedAtMs: AT });
    const run = (await s.beginRun('TOSS', DATE, NOW, 'a'))!;
    await s.saveListedPage(run, [{ ...seen('r1', AT), orderRef: orderId }], undefined, 1);
    const [row] = await s.readCompareBatch(run, 10);
    expect(row!.ledger!.statusChangedAtMs).toBe(AT - 60_000);
    await expect(s.ledgerStatus(row!.ledger!.paymentId)).resolves.toBe('APPROVED');
  });

  test('P-T32_리뷰 고침 M12: 저장소는 문장 시간 한도가 걸린 트랜잭션으로만 DB를 쓴다', async () => {
    const options: unknown[] = [];
    const guarded = {
      ...database,
      get db(): never {
        throw new Error('한도 없는 db.execute를 썼다');
      },
      transaction: (fn: never, o: unknown) => {
        options.push(o);
        return database.transaction(fn, o as never);
      },
    } as unknown as Database;
    const s = new DrizzleReconciliation({ database: guarded, clock: fakeClock({ now: NOW }) });
    await s.pendingDates('TOSS', '2026-11-03');
    await s.overdueDates('TOSS', '2026-11-03');
    const run = (await s.beginRun('TOSS', DATE, NOW, 'a'))!;
    await s.saveListedPage(run, [seen('r1', AT)], undefined, 1);
    const fresh = { ...run, stage: 'COMPARING' as const };
    await s.readCompareBatch(fresh, 10);
    await s.insertDiffs(fresh, [{ pg: 'TOSS', orderRef: 'o', paymentRef: 'r1', kind: 'UNREADABLE', state: 'OPEN' }]);
    await s.handOff([newId()], NOW);
    await s.markClosed('TOSS', 'r1', 'UNREADABLE');
    await s.ledgerStatus(newId());
    await s.finishCompareBatch(fresh, undefined, 1, 0);
    await s.readLedgerBatch(fresh, 10);
    await s.finishLedgerBatch(fresh, undefined, 0);
    await s.pullUnknowns('TOSS', NOW, NOW, 10);
    await s.finishRun(fresh, 'DONE', NOW);
    await s.clearSeen(fresh);
    expect(options.length).toBeGreaterThanOrEqual(13);
    for (const o of options) expect(o).toMatchObject({ statementTimeoutMs: 5_000 });
  });

  test('P-T32_리뷰 고침 M12: 원장 쪽은 승인 행을 먼저 잘라 읽는다(작업 표에 있는 행도 묶음 크기를 쓰고 표시가 붙는다)', async () => {
    const s = store();
    await ledgerRow({ ref: 'a', status: 'APPROVED', approvedAtMs: AT });
    await ledgerRow({ ref: 'b', status: 'APPROVED', approvedAtMs: AT + 1 });
    await ledgerRow({ ref: 'c', status: 'APPROVED', approvedAtMs: AT + 2 });
    const run = (await s.beginRun('TOSS', DATE, NOW, 'a'))!;
    await s.saveListedPage(run, [seen('a', AT), seen('b', AT)], undefined, 2);
    const rows = await s.readLedgerBatch(run, 2);
    expect(rows.map((r) => [r.paymentRef, r.seen])).toEqual([['a', true], ['b', true]]);
  });

  test('P-T32_리뷰 고침 M10: 결과 모름 당기기는 한 번에 상한까지만 쓰고, 이미 당긴 행은 다시 쓰지 않는다 [ASVS v5.0.0-2.4.1]', async () => {
    const s = store();
    const ids = [] as string[];
    for (let i = 0; i < 3; i += 1) ids.push((await ledgerRow({ ref: `u${i}`, status: 'UNKNOWN' })).id);
    await expect(s.pullUnknowns('TOSS', NOW, NOW, 2)).resolves.toBe(2);
    await expect(s.pullUnknowns('TOSS', NOW, NOW, 2)).resolves.toBe(1);
    await expect(s.pullUnknowns('TOSS', NOW, NOW, 2)).resolves.toBe(0);
    for (const id of ids) expect(await statusOf(id)).toMatchObject({ status: 'UNKNOWN', next_query_at: new Date(NOW) });
  });

  test('P-T32_리뷰 고침 M13: 못 읽는 줄의 종류는 표 제약을 지난다', async () => {
    const s = store();
    const run = (await s.beginRun('TOSS', DATE, NOW, 'a'))!;
    await expect(s.insertDiffs(run, [{ pg: 'TOSS', orderRef: '', paymentRef: 'unreadable-1', kind: 'UNREADABLE', state: 'OPEN' }])).resolves.toHaveLength(1);
  });

  test('P-T32_리뷰 고침 낮음: 원장 쪽을 끝내면 단계가 PULLING이 된다(이어 해도 원장 쪽을 다시 돌지 않는다)', async () => {
    const s = store();
    const run = (await s.beginRun('TOSS', DATE, NOW, 'a'))!;
    await s.finishLedgerBatch(run, undefined, 1);
    expect((await s.beginRun('TOSS', DATE, NOW, 'b'))!.stage).toBe('PULLING');
  });
});

// 처리량 측정(설계 §4): 다른 시험이 돌지 않을 때 PEAKET_RECON_MEASURE=1로 한 번 돌리고 결과를 정본에 적는다. 평소에는 건너뛴다.
const measure = process.env.PEAKET_RECON_MEASURE === '1';
describe.skipIf(!measure)('P-T32 대사 처리량 측정', () => {
  test(
    'P-T32_시뮬레이터 거래 10만 건을 끝까지 맞춘다(측정)',
    async () => {
      const count = 100_000;
      const uuidOf = (i: number) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`;
      const items = Array.from({ length: count }, (_, i) => ({ paymentKey: `bulk-${i}`, orderId: uuidOf(i), amount: 1000, status: 'DONE' as const, atMs: AT + (i % 3_600_000) }));
      await control('POST', '/sim/transactions/seed', { items });
      await admin.pool.query(
        `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, created_at, approved_at, status_changed_at)
         select gen_random_uuid(), ('00000000-0000-7000-8000-' || lpad(g::text, 12, '0'))::uuid, gen_random_uuid(), gen_random_uuid(), 1, 'SIMULATOR', 'bulk-' || g, 1000, 'APPROVED', 'confirm-' || g, $1, $1, $2, $2
         from generate_series(0, $3::int - 1) as g`,
        [new Date(AT - 60_000), new Date(AT), count],
      );
      await admin.pool.query('analyze payment');
      // 측정은 실제 시뮬레이터 어댑터로, 시계·쉬기도 실제로 돈다(토큰 몫이 걸리게)
      const clock = systemClock;
      const lines: string[] = [];
      const destination = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
      const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
      const metrics = new PlatformMetrics('payment-svc');
      const gateways = new StaticPaymentGateways([new SimulatorPaymentGateway({ baseUrl: simUrl, secretKey: KEY, clientKey: 'sim_ck_x', callsPerSecond: 300 })]);
      const app = new PaymentReconciliation({
        store: new DrizzleReconciliation({ database, clock: fakeClock({ now: NOW }) }),
        closer: new DrizzleConfirmJobs({ database, clock: systemClock }),
        gateways,
        calendar: { active: async () => false },
        log: paymentReconciliationLog(logger),
        signals: new PromPaymentReconciliationSignals().register(metrics.registry),
        clock: { now: () => NOW, monotonicMs: () => performance.now() } as never,
      });
      const started = performance.now();
      const report = await app.runDaily();
      const seconds = (performance.now() - started) / 1000;
      expect(report).toMatchObject({ runs: [{ pg: 'SIMULATOR', status: 'DONE', listed: count, matched: count }] });
      // 통과한 시험의 console 출력은 Vitest가 숨긴다(결과를 정본에 옮겨 적으려고 표준 오류로 쓴다)
      process.stderr.write(`[대사 처리량] 거래 ${count}건, ${seconds.toFixed(1)}초, 초당 ${Math.round(count / seconds)}건\n`);
      expect(seconds).toBeGreaterThan(0);
    },
    600_000,
  );
});
