// 결제사 선택과 결제창 준비(BUILD_ORDER PRF-190)를 실제 PostgreSQL 18과 실제 gRPC 서버로 돈다.
// 정본: docs/features/payment.md §2.2 '선택기의 첫 구현'·P-T26·P-T29, docs/data.md §4 '결제사 선택 표'·§5.1, docs/api/proto/peaket/payment/v1/payment.proto, specs/payment.qnt `selected`·`route`, docs/security/asvs/payment.md.
//
// 약속:
// - Kafka 모듈을 불러오지 않는다(릴레이·kafka.ts 없이 저장소와 쓰임새만 묶는다).
// - 전환·지정 행은 SQL로 직접 넣는다(쓰기는 제어 수신 OPS-310이다. applySwitch만 그 판 번호 규칙을 본다).
// - 부르는 쪽은 계약 설명자로 만든 클라이언트다(purchase의 실제 클라이언트가 붙기 전이라 생성된 클라이언트로 계약을 본다).
// - 시계는 멈춘 가짜 시계다. 캐시 1초 [가정]는 clock.advance로 넘긴다.
// - 결제사 호출 고정(P-T29)은 호출을 적는 가짜 어댑터로 본다(실제 결제사를 부르지 않는다).
import 'reflect-metadata';
import { createDatabase, createPlatformLogger, type Database, ensureOutboxPartitions, PlatformMetrics, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  CachedPgSelectionReader,
  CancelDepositPayment,
  channelTableOf,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  DrizzlePgSelection,
  PG_SELECTION_CACHE_TTL_MS,
  PaymentConfirmRunner,
  paymentCheckoutLog,
  paymentCommandLog,
  paymentConfirmLog,
  paymentPackage,
  paymentServiceHandlers,
  PaymentUnknownResolver,
  paymentUnknownLog,
  PgCallGuards,
  pgCallGuardLog,
  PortoneGateway,
  PrepareCheckout,
  PromPaymentCheckoutSignals,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPaymentDepositSignals,
  PromPaymentUnknownSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
} from '../src/modules/payment/server.js';
import { SimulatorPaymentGateway } from '../src/modules/payment/adapters/pg/simulator-gateway.js';
import type { CheckoutValues, ConfirmResult, PaymentGatewayPort, PgCapabilities, PgName, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import type { PaymentGateways } from '../src/modules/payment/domain/ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, ledgerOf, msOf, newId, paymentClient, type PaymentClient, tableCounts, tossConfirm, unary } from './support.js';
import { fakeClock, type FakeClock } from '@peaket/platform';

const WEB_ORIGIN = 'https://www.it.example';
const ENTRY = '2026-12-20T10:00:00.000Z';

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;

interface Stack {
  client: PaymentClient;
  clock: FakeClock;
  selection: DrizzlePgSelection;
  metrics(): Promise<string>;
  close(): Promise<void>;
}

let stacked: Promise<Stack> | undefined;

/** 실제 어댑터(결제창 값 만들기는 HTTP를 부르지 않는다) */
const realGateways = (): PaymentGateways =>
  new StaticPaymentGateways([
    new TossPaymentGateway({ baseUrl: 'https://api.tosspayments.com', secretKey: 'test_sk_integration', clientKey: 'test_ck_integration' }),
    new PortoneGateway({ baseUrl: 'https://api.portone.io', secret: 'test-secret', storeId: 'store-it', channelKey: 'channel-single', channelKeys: { CARD: 'channel-card', VIRTUAL_ACCOUNT: 'channel-va' }, webhookSecrets: [`whsec_${Buffer.alloc(24, 1).toString('base64')}`], isTest: true }),
    new SimulatorPaymentGateway({ baseUrl: 'http://sim.test', secretKey: 'sim_sk_it', clientKey: 'sim_ck_it' }),
  ]);

async function startStack(): Promise<Stack> {
  const clock = fakeClock({ now: Date.now() });
  const metrics = new PlatformMetrics('payment-svc');
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'fatal' });
  const signals = new PromPaymentCommandSignals();
  signals.register(metrics.registry);
  const checkoutSignals = new PromPaymentCheckoutSignals().register(metrics.registry);
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: hot });
  const selection = new DrizzlePgSelection({ database: hot });
  const gateways = realGateways();
  const prepareCheckout = new PrepareCheckout({
    selection: new CachedPgSelectionReader({ reader: selection, clock }),
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
  return {
    client,
    clock,
    selection,
    metrics: () => metrics.registry.metrics(),
    close: async () => {
      client.close();
      await server.close();
    },
  };
}

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'payment-checkout-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 24, applicationName: 'payment-checkout-it-hot' });
  await ensureOutboxPartitions(admin, systemClock);
}, 180_000);

afterAll(async () => {
  const s = await stacked?.catch(() => undefined);
  await s?.close();
  await Promise.allSettled([admin?.close(), hot?.close()]);
  pgc?.stop();
});

const stack = (): Promise<Stack> => (stacked ??= startStack());

const putSwitch = (scope: string, o: { active?: boolean; from?: string | null; to?: string | null; version?: number } = {}) =>
  admin.pool.query(
    `insert into pg_switch (scope, active, from_pg, to_pg, version, changed_at) values ($1, $2, $3, $4, $5, now())
     on conflict (scope) do update set active = excluded.active, from_pg = excluded.from_pg, to_pg = excluded.to_pg, version = excluded.version, changed_at = excluded.changed_at`,
    [scope, o.active ?? true, o.from ?? null, o.to ?? null, o.version ?? 1],
  );
const putConfig = (eventId: string, primary: string, fallback: string | null = null) => admin.pool.query('insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, $2, $3, now())', [eventId, primary, fallback]);
const clearPlatform = () => admin.pool.query("delete from pg_switch where scope = 'PLATFORM'");

const requestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  order_kind: 'ORDER_KIND_TICKET',
  order_id: newId(),
  attempt_id: newId(),
  event_id: newId(),
  amount: { krw: 88_000 },
  order_name: '공연 티켓',
  pay_method: 'CARD',
  ...over,
});
const prepare = async (req: Record<string, unknown>) => unary((await stack()).client, 'PrepareCheckout', req);
/** 캐시 수명만큼 시계를 민다 */
const passCache = async () => (await stack()).clock.advance(PG_SELECTION_CACHE_TTL_MS);

describe('마이그레이션 0009', () => {
  test('P-T26_두 표와 입장 시각 칸이 정본대로다', async () => {
    const r = await admin.pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns where (table_name in ('pg_switch', 'event_pg_config')) or (table_name = 'payment' and column_name = 'entry_opens_at') order by 1, 2`,
    );
    expect(r.rows.map((x) => `${x.table_name}.${x.column_name}:${x.is_nullable}`)).toEqual([
      'event_pg_config.event_id:NO',
      'event_pg_config.pg_fallback:YES',
      'event_pg_config.pg_primary:NO',
      'event_pg_config.updated_at:NO',
      'payment.entry_opens_at:YES',
      'pg_switch.active:NO',
      'pg_switch.changed_at:NO',
      'pg_switch.from_pg:YES',
      'pg_switch.scope:NO',
      'pg_switch.to_pg:YES',
      'pg_switch.version:NO',
    ]);
  });

  test.each([
    ['범위 모양', `insert into pg_switch (scope, active, version, changed_at) values ('EVENT', true, 1, now())`],
    ['결제사 이름', `insert into pg_switch (scope, active, to_pg, version, changed_at) values ('${'a'.repeat(8)}-aaaa-7aaa-8aaa-${'a'.repeat(12)}', true, 'KAKAO', 1, now())`],
    ['기본과 대체가 같음', `insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ('${'b'.repeat(8)}-bbbb-7bbb-8bbb-${'b'.repeat(12)}', 'TOSS', 'TOSS', now())`],
  ])('P-T26_CHECK가 %s을 막는다 [ASVS v5.0.0-2.2.1]', async (_n, sql) => {
    await expect(admin.pool.query(sql)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('P-T26: 전환 켜짐 전후의 선택', () => {
  test('P-T26_지정도 전환도 없으면 플랫폼 기본(TOSS)이고 생성 클라이언트로 토스 값을 받는다 [ASVS v5.0.0-3.7.2] [ASVS v5.0.0-8.2.3]', async () => {
    await clearPlatform();
    await passCache();
    const req = requestOf({ customer_key: 'cust-key-1' });
    const r = await prepare(req);
    expect(r.pg).toBe('PG_PROVIDER_TOSS');
    expect(r.switched).toBe(false);
    expect(r.checkout).toBe('toss');
    const url = `${WEB_ORIGIN}/booking/${String(req.event_id)}/checkout/return?order=${String(req.order_id)}&pg=TOSS`;
    expect(r.toss).toEqual({ client_key: 'test_ck_integration', customer_key: 'cust-key-1', order_id: req.order_id, order_name: '공연 티켓', amount: { krw: 88_000 }, success_url: url, fail_url: url });
    expect(JSON.stringify(r)).not.toContain('test_sk_integration');
  });

  test('P-T26_회차 지정 사본이 플랫폼 기본보다 앞선다', async () => {
    await clearPlatform();
    await passCache();
    const eventId = newId();
    await putConfig(eventId, 'PORTONE', 'TOSS');
    const r = await prepare(requestOf({ event_id: eventId }));
    expect(r.pg).toBe('PG_PROVIDER_PORTONE');
    expect(r.checkout).toBe('portone');
    expect((r.portone as Record<string, unknown>).channel_key).toBe('channel-card');
    expect((r.portone as Record<string, unknown>).currency).toBe('KRW');
  });

  test('P-T26_포트원 값은 customData.orderId를 싣는다', async () => {
    const eventId = newId();
    await putConfig(eventId, 'PORTONE');
    const req = requestOf({ event_id: eventId });
    const r = await prepare(req);
    expect((r.portone as Record<string, unknown>).custom_data).toEqual({ order_id: req.order_id });
    expect((r.portone as Record<string, unknown>).payment_id).toBe(`pay-${String(req.order_id)}`);
  });

  test('P-T26_플랫폼 전환을 켜면 캐시 1초 뒤 새 시도부터 대체로 가고 끄면 돌아온다', async () => {
    const eventId = newId();
    await clearPlatform();
    await passCache();
    expect((await prepare(requestOf({ event_id: eventId }))).pg).toBe('PG_PROVIDER_TOSS');
    await putSwitch('PLATFORM', { to: 'PORTONE' });
    // 1초 안에는 앞의 값이다
    expect((await prepare(requestOf({ event_id: eventId }))).pg).toBe('PG_PROVIDER_TOSS');
    await passCache();
    const on = await prepare(requestOf({ event_id: eventId }));
    expect(on).toMatchObject({ pg: 'PG_PROVIDER_PORTONE', switched: true });
    await putSwitch('PLATFORM', { active: false, version: 2 });
    await passCache();
    expect(await prepare(requestOf({ event_id: eventId }))).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: false });
    await clearPlatform();
  });

  test('P-T26_회차 전환은 그 회차만 옮기고 to_pg가 비면 미리 지정한 대체로 간다', async () => {
    await clearPlatform();
    await passCache();
    const a = newId();
    const b = newId();
    await putConfig(a, 'TOSS', 'PORTONE');
    await putConfig(b, 'TOSS', 'PORTONE');
    await putSwitch(a);
    expect(await prepare(requestOf({ event_id: a }))).toMatchObject({ pg: 'PG_PROVIDER_PORTONE', switched: true });
    expect(await prepare(requestOf({ event_id: b }))).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: false });
  });

  test('P-T26_대체가 없으면 지정한 기본 결제사다', async () => {
    const eventId = newId();
    await putConfig(eventId, 'TOSS');
    await putSwitch(eventId);
    expect(await prepare(requestOf({ event_id: eventId }))).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: false });
  });

  test('P-T26_고른 결제사가 받지 않는 수단이면 UNAVAILABLE이고 다른 결제사로 넘기지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const eventId = newId();
    await putConfig(eventId, 'PORTONE');
    const before = (await stack()).metrics;
    const err = await failure(prepare(requestOf({ event_id: eventId, pay_method: 'MOBILE' })));
    expect(err.code).toBe(14);
    expect(err.details).toBe('pg-unavailable');
    expect(await before()).toMatch(/payment_checkout_prepared_total\{pg="PORTONE",outcome="method_unsupported"\} [1-9]/);
    expect(await before()).toMatch(/payment_checkout_prepared_total\{pg="PORTONE",outcome="pg_unavailable"\} 0/);
  });

  test('P-T26_리뷰 고침 3: 한 문장 읽기가 회차 전환·플랫폼 전환·회차 지정을 실제 표에서 함께 읽는다', async () => {
    const { selection } = await stack();
    const eventId = newId();
    await clearPlatform();
    await putConfig(eventId, 'PORTONE', 'TOSS');
    await putSwitch(eventId, { from: 'PORTONE', to: 'TOSS', version: 7 });
    await putSwitch('PLATFORM', { active: false, version: 4 });
    const state = await selection.read(eventId, { remainingMs: 150 });
    expect(state).toMatchObject({ assignment: { primary: 'PORTONE', fallback: 'TOSS' }, eventSwitch: { scope: eventId, active: true, fromPg: 'PORTONE', toPg: 'TOSS', version: 7 }, platformSwitch: { scope: 'PLATFORM', active: false, version: 4 } });
    expect(Number.isFinite(state.eventSwitch!.changedAtMs)).toBe(true);
    expect(await selection.read(newId())).toMatchObject({ platformSwitch: { active: false } });
    await clearPlatform();
    expect(await selection.read(newId())).toEqual({});
  });

  test('P-T26_리뷰 고침 7: 켜진 회차 행의 from_pg가 어긋나면 플랫폼 전환을 탄다', async () => {
    await clearPlatform();
    await passCache();
    const eventId = newId();
    await putConfig(eventId, 'TOSS', 'PORTONE');
    await putSwitch(eventId, { from: 'PORTONE', to: 'TOSS' });
    await putSwitch('PLATFORM', { to: 'PORTONE', version: 20 });
    expect(await prepare(requestOf({ event_id: eventId }))).toMatchObject({ pg: 'PG_PROVIDER_PORTONE', switched: true });
    await clearPlatform();
  });

  test('P-T29_리뷰 고침 7: ConfirmPayment가 9999년 뒤의 입장 시각을 거절한다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = await stack();
    const f = tossConfirm({ authenticatedAtMs: s.clock.now() });
    const err = await failure(unary(s.client, 'ConfirmPayment', { ...f.request, entry_opens_at: { seconds: 253_402_300_800, nanos: 0 } }));
    expect(err.code).toBe(3);
    expect(err.details).toBe('입력이 틀렸다: entry_opens_at');
  });

  test('P-T26_입력이 틀리면 INVALID_ARGUMENT이고 칸 이름만 싣는다 [ASVS v5.0.0-2.2.1]', async () => {
    const err = await failure(prepare(requestOf({ order_id: 'not-a-uuid' })));
    expect(err.code).toBe(3);
    expect(err.details).toBe('입력이 틀렸다: order_id');
  });

  test('P-T26_데드라인이 모자라면 시작하지 않는다', async () => {
    const err = await failure(unary((await stack()).client, 'PrepareCheckout', requestOf(), 1));
    expect(err.code).toBe(4);
  });
});

describe('P-T26: 허용 수단과 입금 기한', () => {
  test('P-T26_입장 시각이 있으면 입금 기한은 입장 24시간 전을 넘지 않고 답에 실린다', async () => {
    const s = await stack();
    const entryMs = s.clock.now() + 30 * 3_600_000;
    const r = await prepare(requestOf({ entry_opens_at: { seconds: Math.floor(entryMs / 1000), nanos: 0 } }));
    expect(r.allowed_pay_methods).toContain('VIRTUAL_ACCOUNT');
    expect(msOf(r.deposit_due_at)).toBe(Math.floor(entryMs / 1000) * 1000 - 24 * 3_600_000);
  });

  test('P-T26_입금 기한까지 2시간이 남지 않으면 가상계좌를 뺀다', async () => {
    const s = await stack();
    const entryMs = s.clock.now() + 25 * 3_600_000;
    const r = await prepare(requestOf({ entry_opens_at: { seconds: Math.floor(entryMs / 1000), nanos: 0 } }));
    expect(r.allowed_pay_methods).not.toContain('VIRTUAL_ACCOUNT');
    expect(r.deposit_due_at).toBeNull();
  });

  test('PRF-184 넘긴 것: virtual_account_allowed 거짓이면 뺀다. 칸이 없으면 허용이다', async () => {
    expect((await prepare(requestOf({ virtual_account_allowed: false }))).allowed_pay_methods).not.toContain('VIRTUAL_ACCOUNT');
    expect((await prepare(requestOf())).allowed_pay_methods).toContain('VIRTUAL_ACCOUNT');
  });
});

describe('재생과 쓰기 없음', () => {
  test('P-T26_같은 시도를 다시 부르면 그때의 규칙으로 고른다(고정은 부르는 쪽 DB다). 원장에 쓰지 않는다', async () => {
    await clearPlatform();
    await passCache();
    const req = requestOf();
    const before = await tableCounts(admin);
    expect((await prepare(req)).pg).toBe('PG_PROVIDER_TOSS');
    await putSwitch('PLATFORM', { to: 'PORTONE', version: 3 });
    await passCache();
    expect((await prepare(req)).pg).toBe('PG_PROVIDER_PORTONE');
    expect(await tableCounts(admin)).toEqual(before);
    await clearPlatform();
  });

  test('P-T27_pinned_pg면 전환이 켜져도 그 결제사로 값을 만든다(멱등 재생, BUILD_ORDER PRF-191) [ASVS v5.0.0-2.2.3]', async () => {
    await clearPlatform();
    await putSwitch('PLATFORM', { to: 'PORTONE', version: 4 });
    await passCache();
    const req = requestOf();
    expect((await prepare(req)).pg).toBe('PG_PROVIDER_PORTONE');
    const replay = await prepare({ ...req, pinned_pg: 'PG_PROVIDER_TOSS' });
    expect(replay.pg).toBe('PG_PROVIDER_TOSS');
    expect(replay.switched).toBe(false);
    expect(replay).toHaveProperty('toss');
    await clearPlatform();
  });

  test('P-T26_전환 쓰기 함수는 판 번호가 클 때만 쓴다(같은 판을 다시 보내도 그대로다)', async () => {
    const { selection, clock } = await stack();
    const scope = newId();
    const row = { scope, active: true, toPg: 'PORTONE' as PgName, version: 5, changedAtMs: clock.now() };
    expect(await selection.applySwitch(row)).toBe(true);
    expect(await selection.applySwitch(row)).toBe(false);
    expect(await selection.applySwitch({ ...row, active: false, version: 4 })).toBe(false);
    expect((await selection.read(scope)).eventSwitch).toMatchObject({ active: true, toPg: 'PORTONE', version: 5 });
    expect(await selection.applySwitch({ ...row, active: false, version: 6 })).toBe(true);
    expect((await selection.read(scope)).eventSwitch).toMatchObject({ active: false, version: 6 });
  });
});

// ───────────────────────────── 결제사 고정 ─────────────────────────────

class RecordingGateway implements PaymentGatewayPort {
  readonly calls: string[] = [];
  confirmAnswer: (ref: string) => ConfirmResult = (ref) => ({ outcome: 'UNKNOWN', paymentRef: ref });
  queryAnswer: () => QueryResult = () => ({ kind: 'UNKNOWN' });
  constructor(readonly pg: PgName) {}
  capabilities(): PgCapabilities {
    return { serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 86_400_000, callsPerSecond: 1_000, redirectCheckout: true };
  }
  checkout(): CheckoutValues {
    this.calls.push('checkout');
    throw new Error('이 시험은 결제창을 열지 않는다');
  }
  async confirm(c: { paymentRef: string }): Promise<ConfirmResult> {
    this.calls.push('confirm');
    return this.confirmAnswer(c.paymentRef);
  }
  async query(): Promise<QueryResult> {
    this.calls.push('query');
    return this.queryAnswer();
  }
  async listTransactions(): Promise<{ kind: 'UNKNOWN' }> {
    this.calls.push('list');
    return { kind: 'UNKNOWN' };
  }
  async cancel() {
    this.calls.push('cancel');
    return { outcome: 'CANCELLED' as const };
  }
  parseWebhook() {
    return { kind: 'IGNORED' as const };
  }
}

describe('P-T29: 결제사 고정', () => {
  /** 호출을 적는 어댑터 둘과 실제 저장소로 묶은 승인 실행기·조회 실행기·입금 전 취소 */
  async function pinned() {
    const s = await stack();
    const toss = new RecordingGateway('TOSS');
    const portone = new RecordingGateway('PORTONE');
    const gateways = new StaticPaymentGateways([toss, portone]);
    const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock: s.clock, level: 'fatal' });
    const metrics = new PlatformMetrics('payment-svc');
    const jobs = new DrizzleConfirmJobs({ database: hot, clock: s.clock });
    const guards = new PgCallGuards({ gateways, podCount: 1, clock: s.clock, signals: new PromPgCallGuardSignals().register(metrics.registry), log: pgCallGuardLog(logger) });
    const deposit = new PromPaymentDepositSignals().register(metrics.registry);
    const depositDeps = { cipher: { ready: true, seal: async () => 'sealed', open: async () => '562' }, log: { infoMissing: () => undefined, accountUnsaved: () => undefined, accountUnopened: () => undefined }, signals: deposit };
    const runner = new PaymentConfirmRunner({ jobs, gateways, guards, log: paymentConfirmLog(logger), signals: new PromPaymentConfirmSignals().register(metrics.registry), clock: s.clock, podId: 'checkout-it', deposit: depositDeps });
    const resolver = new PaymentUnknownResolver({ queries: jobs, gateways, guards, log: paymentUnknownLog(logger), signals: new PromPaymentUnknownSignals().register(metrics.registry), clock: s.clock, deposit: depositDeps });
    const cancel = new CancelDepositPayment({ store: jobs, gateways, guards, signals: deposit, clock: s.clock });
    const drive = async () => {
      await runner.tick();
      await runner.whenIdle();
    };
    const driveQueries = async () => {
      s.clock.advance(60_000);
      await resolver.tick();
      await resolver.whenIdle();
    };
    return { s, toss, portone, jobs, drive, driveQueries, cancel, metrics };
  }

  const HOUR = 3_600_000;
  const secondsOf = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: 0 });
  /** 입금을 확인한 승인 원장으로 만들고 되돌림 통보를 받은 때처럼 조회를 걸어 둔다 */
  async function approvedThenReversed(entryInMs: number) {
    const p = await pinned();
    const f = tossConfirm({ authenticatedAtMs: p.s.clock.now() });
    p.toss.confirmAnswer = (ref) => ({ outcome: 'APPROVED', paymentRef: ref, amount: f.amount, approvedAt: new Date(p.s.clock.now()).toISOString() });
    await unary(p.s.client, 'ConfirmPayment', { ...f.request, entry_opens_at: secondsOf(p.s.clock.now() + entryInMs) });
    await p.drive();
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ status: 'APPROVED' });
    await admin.pool.query('update payment set next_query_at = $1, deposit_notified_at = $1 where order_id = $2', [new Date(p.s.clock.now()), f.orderId]);
    p.toss.queryAnswer = () => ({ kind: 'FOUND', paymentRef: f.paymentKey, orderRef: f.orderId, status: 'WAITING_FOR_DEPOSIT', amount: f.amount, balanceAmount: f.amount, virtualAccount: { accountNumber: '562', bank: '20', dueAt: new Date(p.s.clock.now() + 72 * HOUR).toISOString() } });
    return { ...p, f };
  }
  const outboxTypesOf = async (eventId: string): Promise<string[]> => {
    const r = await admin.pool.query<{ payload: Buffer }>('select payload from outbox where msg_key = $1 order by seq', [eventId]);
    return r.rows.map((x) => (JSON.parse(x.payload.toString('utf8')) as { type: string }).type);
  };

  test('P-T29_접수 뒤 전환을 켜도 승인·조회는 원장의 결제사로만 간다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.4]', async () => {
    const { s, toss, portone, drive, driveQueries } = await pinned();
    const f = tossConfirm({ authenticatedAtMs: s.clock.now() });
    await unary(s.client, 'ConfirmPayment', f.request);
    await putSwitch('PLATFORM', { to: 'PORTONE', version: 10 });
    await passCache();
    await drive();
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'TOSS', status: 'UNKNOWN' });
    toss.queryAnswer = () => ({ kind: 'FOUND', paymentRef: f.paymentKey, orderRef: f.orderId, status: 'APPROVED', amount: f.amount, balanceAmount: f.amount, approvedAt: '2026-11-09T10:00:00+09:00' });
    await driveQueries();
    expect((await ledgerOf(admin, f.orderId)).payments[0]).toMatchObject({ pg: 'TOSS', status: 'APPROVED' });
    expect(toss.calls).toEqual(['confirm', 'query']);
    expect(portone.calls).toEqual([]);
    await clearPlatform();
  });

  test('P-T29_전환 뒤 입금 전 취소도 원장의 결제사로 간다 [ASVS v5.0.0-2.3.4]', async () => {
    const { s, toss, portone, drive, cancel } = await pinned();
    const f = tossConfirm({ authenticatedAtMs: s.clock.now() });
    toss.confirmAnswer = (ref) => ({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: ref, amount: f.amount });
    await unary(s.client, 'ConfirmPayment', f.request);
    await drive();
    const row = (await ledgerOf(admin, f.orderId)).payments[0]!;
    expect(row.status).toBe('AWAITING_DEPOSIT');
    await putSwitch('PLATFORM', { to: 'PORTONE', version: 11 });
    await passCache();
    toss.queryAnswer = () => ({ kind: 'FOUND', paymentRef: f.paymentKey, orderRef: f.orderId, status: 'CANCELED', amount: f.amount, balanceAmount: 0 });
    await expect(cancel.execute({ paymentId: row.id, cancellationId: newId(), reason: '구매자 취소' })).resolves.toMatchObject({ result: 'CANCELLED' });
    expect(toss.calls).toEqual(['confirm', 'cancel', 'query']);
    expect(portone.calls).toEqual([]);
    await clearPlatform();
  });

  test('P-T29_다른 결제사의 잡기에는 그 결제가 잡히지 않는다', async () => {
    const { s, jobs } = await pinned();
    const f = tossConfirm({ authenticatedAtMs: s.clock.now() });
    await unary(s.client, 'ConfirmPayment', f.request);
    await putSwitch('PLATFORM', { to: 'PORTONE', version: 12 });
    const paymentId = (await ledgerOf(admin, f.orderId)).payments[0]!.id;
    expect((await jobs.claimDue('PORTONE', 10, 'it', 60_000)).map((j) => j.paymentId)).not.toContain(paymentId);
    await clearPlatform();
  });

  test('HOT-152 넘긴 것: 승인 명령의 입장 시각을 원장에 두고 조회 잡기가 읽는다', async () => {
    const { s, toss, jobs, drive } = await pinned();
    const f = tossConfirm({ authenticatedAtMs: s.clock.now() });
    const entrySeconds = Math.floor(Date.parse(ENTRY) / 1000);
    await unary(s.client, 'ConfirmPayment', { ...f.request, entry_opens_at: { seconds: entrySeconds, nanos: 0 } });
    expect((await admin.pool.query<{ entry_opens_at: Date }>('select entry_opens_at from payment where order_id = $1', [f.orderId])).rows[0]!.entry_opens_at.getTime()).toBe(entrySeconds * 1000);
    toss.confirmAnswer = (ref) => ({ outcome: 'UNKNOWN', paymentRef: ref });
    await drive();
    s.clock.advance(60_000);
    expect((await jobs.claimDueQueries('TOSS', 100)).find((j) => j.orderId === f.orderId)?.entryOpensAtMs).toBe(entrySeconds * 1000);
  });

  // 앞 시험이 호출 차례를 정확히 보므로 원장 행을 남기는 시험은 이 뒤에 둔다
  test('P-T26_리뷰 고침 4: 입장이 2시간 안이면 되돌림과 실패가 한 트랜잭션이고 주문 쪽에는 차례대로 간다', async () => {
    const { f, driveQueries } = await approvedThenReversed(HOUR);
    await driveQueries();
    const { payments, events } = await ledgerOf(admin, f.orderId);
    expect(payments[0]).toMatchObject({ status: 'FAILED', failure_category: 'EXPIRED', approved_at: null, deposit_due_at: null, next_query_at: null });
    expect(events.filter((e) => e.exported).map((e) => e.type).slice(-2)).toEqual(['DEPOSIT_REVERSED', 'FAILED']);
    expect((await outboxTypesOf(f.eventId)).slice(-2)).toEqual(['DEPOSIT_REVERSED', 'FAILED']);
  });

  test('P-T26_리뷰 고침 4: 입장이 2시간 뒤보다 멀면 입장 24시간 안이어도 지금 + 2시간으로 되돌린다', async () => {
    const { s, f, driveQueries } = await approvedThenReversed(10 * HOUR);
    await driveQueries();
    const row = (await ledgerOf(admin, f.orderId)).payments[0]!;
    expect(row).toMatchObject({ status: 'AWAITING_DEPOSIT' });
    expect((row as unknown as { deposit_due_at: Date }).deposit_due_at.getTime()).toBe(s.clock.now() + 2 * HOUR);
  });

  test('P-T26_리뷰 고침 5: 승인 답의 기한이 입장 24시간 전을 넘으면 원장·사건에 잘라 쓰고 지표를 낸다', async () => {
    const { s, toss, drive, metrics } = await pinned();
    const f = tossConfirm({ authenticatedAtMs: s.clock.now() });
    const entryMs = Math.floor((s.clock.now() + 30 * HOUR) / 1000) * 1000;
    toss.confirmAnswer = (ref) => ({ outcome: 'WAITING_FOR_DEPOSIT', paymentRef: ref, amount: f.amount, virtualAccount: { accountNumber: '562', bank: '20', dueAt: new Date(s.clock.now() + 72 * HOUR).toISOString() } });
    await unary(s.client, 'ConfirmPayment', { ...f.request, entry_opens_at: secondsOf(entryMs) });
    await drive();
    const row = (await ledgerOf(admin, f.orderId)).payments[0]!;
    expect(row).toMatchObject({ status: 'AWAITING_DEPOSIT' });
    expect((row as unknown as { deposit_due_at: Date }).deposit_due_at.getTime()).toBe(entryMs - 24 * HOUR);
    expect(await metrics.registry.metrics()).toContain('payment_deposit_due_capped_total 1');
  });
});
