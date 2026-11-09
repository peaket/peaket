// UNKNOWN 조회 실행기(application/payment-unknown-resolver.ts PaymentUnknownResolver, docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현'·§4.2 14번,
// docs/data.md §5, 명세 specs/payment.qnt `query`, BUILD_ORDER PRF-182)와 그 어댑터(로그·지표)를 메모리 대역으로 본다.
// - tick: 잡기가 호출보다 먼저 끝난다(먼저 밀기), 빈자리만큼 잡기, 동시 상한 16, 호출을 기다리지 않음
// - runJob: 답 → 쓰기·다시 묻기, 어댑터 없음, SEV1 결제마다 한 번, 실제 간격 다시 쓰기, 시간 한도, 실패 격리
// - sweepOverdue: 잡기와 별개인 1시간 표시
// - start·stop·whenIdle: 1초 반복과 1분 반복, 틱 겹침 없음, 돌던 조회를 기다림, 멈춘 뒤 부르지 않음
// 실제 PostgreSQL·시뮬레이터로 도는 것(한 트랜잭션, SKIP LOCKED, 프로세스 강제 종료)은 test-int가 본다.
import { Writable } from 'node:stream';
import { createPlatformLogger, type Database, Deadline, fakeClock, type FakeClock, PlatformMetrics, type RequestContext, requestContext, runInRequestContext, systemClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { DrizzleConfirmJobs } from '../src/modules/payment/adapters/db/drizzle-confirm-jobs.js';
import { paymentUnknownLog } from '../src/modules/payment/adapters/payment-unknown-log.js';
import { PromPaymentUnknownSignals } from '../src/modules/payment/adapters/prom-payment-unknown-signals.js';
import { PaymentUnknownResolver, type PaymentUnknownResolverDeps, type UnknownResolverTimer } from '../src/modules/payment/application/payment-unknown-resolver.js';
import type { PaymentGatewayPort, PgName, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import { PgCallGuards, type PgLimitKind, type PgSaturationReason } from '../src/modules/payment/domain/pg-call-guard.js';
import type { PaymentGateways, PaymentUnknownLog, PaymentUnknownQueries, PaymentUnknownSignals, PgCallGuardLog, PgCallGuardSignals, ResolveUnknownResult } from '../src/modules/payment/domain/ports.js';
import { PAYMENT_UNKNOWN_QUERY_OUTCOMES, type PaymentUnknownQueryOutcome, type ResolvedFinish, type UnknownQueryJob } from '../src/modules/payment/domain/unknown-resolver.js';
import { EVENT_ID, NOW, ORDER_ID, PAYMENT_ID, SECRET_PAYMENT_KEY, uuidAt } from './confirm-cases.js';

const AMOUNT = 55_000;
const APPROVED_AT = '2026-11-09T03:00:05.000Z';

const job = (over: Partial<UnknownQueryJob> = {}): UnknownQueryJob => ({
  paymentId: PAYMENT_ID,
  orderId: ORDER_ID,
  eventId: EVENT_ID,
  attemptNo: 1,
  pg: 'SIMULATOR',
  paymentRef: SECRET_PAYMENT_KEY,
  amount: AMOUNT,
  queryAttempts: 1,
  claimedNextQueryAtMs: NOW + 15_000,
  anomalyLogged: false,
  ...over,
});
const jobN = (i: number): UnknownQueryJob => job({ paymentId: uuidAt(100 + i), orderId: uuidAt(200 + i), paymentRef: `ref-${i}` });
const approved = (over: Partial<Extract<QueryResult, { kind: 'FOUND' }>> = {}): QueryResult => ({ kind: 'FOUND', paymentRef: SECRET_PAYMENT_KEY, orderRef: ORDER_ID, status: 'APPROVED', amount: AMOUNT, balanceAmount: AMOUNT, approvedAt: APPROVED_AT, ...over });

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

class FakeTimer implements UnknownResolverTimer {
  readonly set: { fn: () => void; ms: number; handle: object }[] = [];
  readonly cleared: unknown[] = [];
  setInterval(fn: () => void, ms: number): unknown {
    const handle = { n: this.set.length };
    this.set.push({ fn, ms, handle });
    return handle;
  }
  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
  }
  /** 잡기 반복(start가 먼저 켠다)을 한 번 돌린다 */
  fire(): void {
    this.set[0]!.fn();
  }
}

type Script<T> = T | { readonly throws: unknown };
const throws = (v: unknown): { readonly throws: unknown } => ({ throws: v });
const isThrow = (v: unknown): v is { readonly throws: unknown } => typeof v === 'object' && v !== null && 'throws' in v;
function play<T>(s: Script<T>): T {
  if (isThrow(s)) throw s.throws;
  return s as T;
}

class FakeQueries implements PaymentUnknownQueries {
  /** SIMULATOR 채널의 잡기 limit */
  readonly limits: number[] = [];
  /** 그 밖의 채널의 잡기 인자 */
  readonly otherLimits: [PgName, number][] = [];
  /** 있으면 그 밖의 채널의 잡기가 이 약속을 기다린다 */
  otherGate: Promise<void> | undefined;
  /** hasDueQueries의 답(채널별, 없으면 true) */
  readonly due = new Map<PgName, boolean>();
  claims: Script<UnknownQueryJob[]>[] = [];
  readonly resolved: { job: UnknownQueryJob; finish: ResolvedFinish }[] = [];
  resolveResults: Script<ResolveUnknownResult>[] = [];
  readonly anomalies: UnknownQueryJob[] = [];
  anomalyResults: Script<boolean>[] = [];
  readonly rescheduled: { job: UnknownQueryJob; nextAtMs: number; o?: unknown }[] = [];
  rescheduleResults: Script<boolean>[] = [];
  readonly sweepLimits: number[] = [];
  sweeps: Script<string[]>[] = [];

  constructor(private readonly order: string[]) {}

  async markAnomalyLogged(j: UnknownQueryJob): Promise<boolean> {
    this.order.push('markAnomaly');
    this.anomalies.push(j);
    const next = this.anomalyResults.shift();
    return next === undefined ? true : play(next);
  }
  async rescheduleQuery(j: UnknownQueryJob, nextAtMs: number, o?: unknown): Promise<boolean> {
    this.order.push('reschedule');
    this.rescheduled.push({ job: j, nextAtMs, ...(o === undefined ? {} : { o }) });
    const next = this.rescheduleResults.shift();
    return next === undefined ? true : play(next);
  }
  async markOverdueBatch(limit: number): Promise<string[]> {
    this.order.push('sweep');
    this.sweepLimits.push(limit);
    const next = this.sweeps.shift();
    return next === undefined ? [] : play(next);
  }

  async claimDueQueries(pg: PgName, limit: number): Promise<UnknownQueryJob[]> {
    if (pg !== 'SIMULATOR') {
      this.otherLimits.push([pg, limit]);
      if (this.otherGate) await this.otherGate;
      return [];
    }
    this.order.push('claim');
    this.limits.push(limit);
    const next = this.claims.shift();
    return next === undefined ? [] : play(next);
  }
  async hasDueQueries(pg: PgName): Promise<boolean> {
    return this.due.get(pg) ?? true;
  }
  async resolve(j: UnknownQueryJob, finish: ResolvedFinish): Promise<ResolveUnknownResult> {
    this.order.push('resolve');
    this.resolved.push({ job: j, finish });
    const next = this.resolveResults.shift();
    return next === undefined ? 'APPLIED' : play(next);
  }
}

class FakeGateway implements Pick<PaymentGatewayPort, 'pg' | 'query' | 'capabilities'> {
  readonly pg: PgName = 'SIMULATOR';
  /** capabilities().callsPerSecond */
  rps = 300;
  capabilities() {
    return { serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 86_400_000, callsPerSecond: this.rps, redirectCheckout: false };
  }
  readonly queried: string[] = [];
  readonly options: unknown[] = [];
  answers = new Map<string, () => Promise<QueryResult> | QueryResult>();
  fallback: () => Promise<QueryResult> | QueryResult = () => approved();

  constructor(private readonly order: string[]) {}

  async query(paymentRef: string, options?: unknown): Promise<QueryResult> {
    this.order.push('query');
    this.queried.push(paymentRef);
    this.options.push(options);
    return (this.answers.get(paymentRef) ?? this.fallback)();
  }
}

class FakeLog implements PaymentUnknownLog {
  readonly lines: [string, unknown][] = [];
  amountMismatch(e: { readonly orderId: string }): void {
    this.lines.push(['amountMismatch', e]);
  }
  orderMismatch(e: { readonly orderId: string }): void {
    this.lines.push(['orderMismatch', e]);
  }
  cancelledAtPg(e: { readonly orderId: string }): void {
    this.lines.push(['cancelledAtPg', e]);
  }
  overdue(e: { readonly orderId: string }): void {
    this.lines.push(['overdue', e]);
  }
  noAdapter(e: { readonly pg: PgName }): void {
    this.lines.push(['noAdapter', e]);
  }
  writeFailed(e: { readonly orderId: string; readonly code: string }): void {
    this.lines.push(['writeFailed', e]);
  }
  staleAnswer(e: { readonly orderId: string }): void {
    this.lines.push(['staleAnswer', e]);
  }
  runError(e: { readonly what: string; readonly orderId?: string; readonly err: unknown }): void {
    this.lines.push(['runError', e]);
  }
  of(name: string): unknown[] {
    return this.lines.filter(([n]) => n === name).map(([, e]) => e);
  }
}

class FakeSignals implements PaymentUnknownSignals {
  readonly outcomes: [PgName, PaymentUnknownQueryOutcome][] = [];
  readonly inFlights: number[] = [];
  overdues = 0;
  writeFailures = 0;
  outcome(pg: PgName, outcome: PaymentUnknownQueryOutcome): void {
    this.outcomes.push([pg, outcome]);
  }
  overdue(): void {
    this.overdues += 1;
  }
  inFlight(count: number): void {
    this.inFlights.push(count);
  }
  writeFailure(): void {
    this.writeFailures += 1;
  }
}

class FakeGuardSignals implements PgCallGuardSignals {
  readonly throttleds: [PgName, boolean][] = [];
  readonly saturateds: [PgName, PgSaturationReason][] = [];
  throttled(pg: PgName, first: boolean): void {
    this.throttleds.push([pg, first]);
  }
  limit(_pg: PgName, _kind: PgLimitKind, _value: number): void {}
  inflight(_pg: PgName, _count: number): void {}
  saturated(pg: PgName, reason: PgSaturationReason): void {
    this.saturateds.push([pg, reason]);
  }
}

function setup(over: Partial<PaymentUnknownResolverDeps> = {}) {
  const order: string[] = [];
  const queries = new FakeQueries(order);
  const gateway = new FakeGateway(order);
  const log = new FakeLog();
  const signals = new FakeSignals();
  const clock: FakeClock = fakeClock({ now: NOW });
  const timer = new FakeTimer();
  const gateways: PaymentGateways = { of: (pg) => (pg === 'SIMULATOR' ? (gateway as unknown as PaymentGatewayPort) : undefined) };
  const guardSignals = new FakeGuardSignals();
  const guardLog: PgCallGuardLog = { throttledFirst: () => undefined };
  const guards = new PgCallGuards({ gateways, podCount: 1, clock, signals: guardSignals, log: guardLog });
  const resolver = new PaymentUnknownResolver({ queries, gateways, log, signals, clock, timer, guards, ...over });
  return { order, queries, gateway, log, signals, clock, timer, guards, guardSignals, resolver };
}

describe('tick', () => {
  test('P-T3_잡기(다음 조회 시각을 먼저 밀기)가 끝난 뒤에야 결제사를 부른다 [ASVS v5.0.0-2.3.4]', async () => {
    const { order, queries, resolver } = setup();
    queries.claims = [[job()]];

    expect(await resolver.tick()).toEqual({ claimed: 1 });
    await resolver.whenIdle();

    expect(order).toEqual(['claim', 'query', 'resolve']);
  });

  test('PRF182_빈자리만큼 잡는다(동시 16 [가정], 묶음 50 [가정]을 넘지 않는다)', async () => {
    const a = setup();
    await a.resolver.tick();
    expect(a.queries.limits).toEqual([16]);

    const b = setup({ concurrency: 100 });
    await b.resolver.tick();
    expect(b.queries.limits).toEqual([50]);
  });

  test('PRF182_동시 조회가 상한이면 잡지 않고, 끝나면 다시 잡는다', async () => {
    const { queries, gateway, resolver } = setup({ concurrency: 2 });
    const first = deferred<QueryResult>();
    gateway.fallback = () => first.promise;
    queries.claims = [[jobN(1), jobN(2)], [jobN(3)]];

    await resolver.tick();
    await flush();
    expect(gateway.queried).toEqual(['ref-1', 'ref-2']);

    expect(await resolver.tick()).toEqual({ claimed: 0 });
    expect(queries.limits).toEqual([2]);

    first.resolve({ kind: 'UNKNOWN' });
    await resolver.whenIdle();
    gateway.fallback = () => ({ kind: 'UNKNOWN' });
    expect(await resolver.tick()).toEqual({ claimed: 1 });
    await resolver.whenIdle();
    expect(queries.limits).toEqual([2, 2]);
  });

  test('PRF182_틱은 조회를 기다리지 않고 돌아온다', async () => {
    const { queries, gateway, resolver } = setup();
    const answer = deferred<QueryResult>();
    gateway.fallback = () => answer.promise;
    queries.claims = [[job()]];

    await expect(resolver.tick()).resolves.toEqual({ claimed: 1 });
    await flush();
    expect(gateway.queried).toHaveLength(1);

    answer.resolve({ kind: 'UNKNOWN' });
    await resolver.whenIdle();
  });

  test('PRF182_겹쳐 부른 틱이 상한을 넘겨 잡지 않는다(잡기 전에 자리를 쥔다)', async () => {
    const { queries, resolver } = setup({ concurrency: 3 });
    const a = resolver.tick();
    const b = resolver.tick();
    await Promise.all([a, b]);
    await resolver.whenIdle();
    expect(queries.limits).toEqual([3]);
  });

  test('PRF182_잡기가 실패하면 던지지 않고 오류를 남긴다 [ASVS v5.0.0-16.3.4]', async () => {
    const { queries, log, resolver } = setup();
    const err = new Error('연결 실패');
    queries.claims = [throws(err)];

    await expect(resolver.tick()).resolves.toEqual({ claimed: 0 });

    expect(log.of('runError')).toEqual([{ what: 'claim', err }]);
  });

  test('PRF182_한 행의 실패가 다른 행을 막지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { queries, gateway, signals, resolver } = setup();
    gateway.answers.set('ref-1', () => {
      throw new Error('호출 실패');
    });
    gateway.answers.set('ref-2', () => approved({ orderRef: uuidAt(202) }));
    queries.claims = [[jobN(1), jobN(2)]];

    await resolver.tick();
    await resolver.whenIdle();

    expect(queries.resolved.map((r) => r.job.paymentRef)).toEqual(['ref-2']);
    expect(signals.outcomes.map(([, o]) => o).sort()).toEqual(['approved', 'query_failed']);
  });
});

describe('runJob', () => {
  test('P-T3_승인 답이면 쓰고 지표 approved다', async () => {
    const { queries, signals, resolver } = setup();

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'RESOLVED', status: 'APPROVED', outcome: 'approved' });

    expect(queries.resolved).toEqual([{ job: job(), finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: Date.parse(APPROVED_AT) } }]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'approved']]);
  });

  test('P-T3_처리 중 답이면 쓰지 않고 다시 묻는다 [ASVS v5.0.0-16.5.3]', async () => {
    const { queries, gateway, signals, resolver } = setup();
    gateway.fallback = () => approved({ status: 'IN_PROGRESS' });

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'still_processing' });

    expect(queries.resolved).toEqual([]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'still_processing']]);
  });

  test('P-T3_금액이 다르면 쓰지 않고 SEV1 로그 한 줄이다(주문 ID만) [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.4]', async () => {
    const { queries, gateway, log, signals, resolver } = setup();
    gateway.fallback = () => approved({ amount: AMOUNT + 1 });

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'amount_mismatch' });

    expect(queries.resolved).toEqual([]);
    expect(log.of('amountMismatch')).toEqual([{ orderId: ORDER_ID }]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'amount_mismatch']]);
  });

  test('P-T3_주문 ID가 다르면 쓰지 않고 SEV1 로그 한 줄이다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.4]', async () => {
    const { queries, gateway, log, resolver } = setup();
    gateway.fallback = () => approved({ orderRef: uuidAt(999) });

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'amount_mismatch' });

    expect(queries.resolved).toEqual([]);
    expect(log.of('orderMismatch')).toEqual([{ orderId: ORDER_ID }]);
  });

  test('P-T3_어댑터가 던지면 결과를 가정하지 않고 다시 묻는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async () => {
    const { queries, gateway, log, signals, resolver } = setup();
    const err = new Error('시간 초과');
    gateway.fallback = () => {
      throw err;
    };

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'query_failed' });

    expect(queries.resolved).toEqual([]);
    expect(log.of('runError')).toEqual([{ what: 'call', orderId: ORDER_ID, err }]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'query_failed']]);
  });

  test('P-T3_조회 실패 답(UNKNOWN)도 다시 묻고 오류 로그는 남기지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { gateway, log, signals, resolver } = setup();
    gateway.fallback = () => ({ kind: 'UNKNOWN' });

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'query_failed' });

    expect(log.lines).toEqual([]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'query_failed']]);
  });

  test('PRF182_어댑터 찾기가 던지면 부르지 않고 다시 묻는다 [ASVS v5.0.0-16.5.2]', async () => {
    const err = new Error('등록부 오류');
    const { gateway, log, signals, resolver } = setup({
      gateways: {
        of: () => {
          throw err;
        },
      },
    });

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'query_failed' });

    expect(gateway.queried).toEqual([]);
    expect(log.of('runError')).toEqual([{ what: 'gateway', orderId: ORDER_ID, err }]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'query_failed']]);
  });

  test('P-T3_어댑터가 없으면 건너뛰고 지표 no_adapter, 파드당 1분에 경고 한 줄이다 [ASVS v5.0.0-16.5.2]', async () => {
    const { queries, log, signals, clock, resolver } = setup();

    await expect(resolver.runJob(job({ pg: 'TOSS' }))).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'no_adapter' });
    await resolver.runJob(job({ pg: 'TOSS' }));
    clock.advance(59_999);
    await resolver.runJob(job({ pg: 'TOSS' }));
    expect(log.of('noAdapter')).toEqual([{ pg: 'TOSS' }]);

    clock.advance(1);
    await resolver.runJob(job({ pg: 'TOSS' }));
    expect(log.of('noAdapter')).toHaveLength(2);
    expect(signals.outcomes).toHaveLength(4);
    expect(signals.outcomes.every(([pg, o]) => pg === 'TOSS' && o === 'no_adapter')).toBe(true);
    expect(queries.resolved).toEqual([]);
  });

  test('PRF182_쓰기가 실패하면 다시 하지 않고 지표·코드 로그만 남긴다(밀어 둔 간격 뒤 다시 조회한다) [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
    const { queries, log, signals, resolver } = setup();
    queries.resolveResults = [throws(Object.assign(new Error(`INSERT ... '${SECRET_PAYMENT_KEY}'`), { code: '40P01' }))];

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'WRITE_FAILED' });

    expect(queries.resolved).toHaveLength(1);
    expect(signals.writeFailures).toBe(1);
    expect(signals.outcomes).toEqual([]);
    expect(log.of('writeFailed')).toEqual([{ orderId: ORDER_ID, code: '40P01' }]);
  });

  test('PRF182_원장이 이미 UNKNOWN이 아니면 STALE, 경고 한 줄이고 지표를 올리지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const { queries, log, signals, resolver } = setup();
    queries.resolveResults = ['STALE'];

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'STALE' });

    expect(log.of('staleAnswer')).toEqual([{ orderId: ORDER_ID }]);
    expect(signals.outcomes).toEqual([]);
  });

  test('PRF182_돌고 있는 조회 수를 알린다', async () => {
    const { signals, resolver } = setup();
    await resolver.runJob(job());
    expect(signals.inFlights).toEqual([1, 0]);
  });
});

describe('결제 수단 연결값 리뷰 고침(BUILD_ORDER HOT-145 코드 리뷰)', () => {
  const BAD_CARD = { maskedNumber: 'not-a-card', bin: 'abcdef', issuerCode: '', cardType: '' };
  const withRefs = () => {
    const missing: string[] = [];
    return { missing, f: setup({ methodRefs: { ref: () => 'k1.value' }, methodRefSignals: { missing: (reason) => missing.push(reason) } }) };
  };

  test.each<[string, Parameters<typeof approved>[0]]>([
    ['금액이 어긋난 답', { amount: AMOUNT + 1 }],
    ['주문이 어긋난 답', { orderRef: uuidAt(999) }],
  ])('P-T50_리뷰 고침 L4: %s은 다시 물을 때마다 연결값을 계산하지 않아 지표가 늘지 않는다', async (_n, over) => {
    const { f, missing } = withRefs();
    f.gateway.fallback = () => approved({ ...over, card: BAD_CARD });
    await f.resolver.runJob(job());
    await f.resolver.runJob(job({ queryAttempts: 2, anomalyLogged: true }));
    expect(missing).toEqual([]);
  });

  test('P-T50_리뷰 고침 L4: 승인으로 확정하는 답은 연결값을 계산해 모양 오류를 한 번 센다', async () => {
    const { f, missing } = withRefs();
    f.gateway.fallback = () => approved({ card: BAD_CARD });
    await expect(f.resolver.runJob(job())).resolves.toMatchObject({ kind: 'RESOLVED', status: 'APPROVED' });
    expect(missing).toEqual(['CARD_SHAPE']);
  });
});

describe('리뷰 고침(BUILD_ORDER PRF-182, 코드 리뷰)', () => {
  const answers: [string, 'amountMismatch' | 'orderMismatch' | 'cancelledAtPg', () => QueryResult][] = [
    ['금액 어긋남', 'amountMismatch', () => approved({ amount: AMOUNT + 1 })],
    ['주문 어긋남', 'orderMismatch', () => approved({ orderRef: uuidAt(999) })],
    ['취소 상태', 'cancelledAtPg', () => approved({ status: 'CANCELED' })],
  ];

  test.each(['CANCELED', 'PARTIAL_CANCELED'] as const)('P-T3_리뷰 고침 H3: 답이 %s이면 승인으로 쓰지 않고 UNKNOWN 그대로 SEV1 로그 한 줄이다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.4]', async (status) => {
    const { queries, gateway, log, signals, resolver } = setup();
    gateway.fallback = () => approved({ status });

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'cancelled_at_pg' });

    expect(queries.resolved).toEqual([]);
    expect(log.of('cancelledAtPg')).toEqual([{ orderId: ORDER_ID }]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'cancelled_at_pg']]);
  });

  test.each(answers)('P-T3_리뷰 고침 M4: %s의 SEV1은 결제마다 한 번이다(조건부로 쓴 행만 로그를 내고 지표는 조회마다 오른다) [ASVS v5.0.0-16.3.4]', async (_name, line, answer) => {
    const { queries, gateway, log, signals, resolver } = setup();
    gateway.fallback = answer;
    queries.anomalyResults = [true, false];

    await resolver.runJob(job());
    await resolver.runJob(job());

    expect(queries.anomalies).toHaveLength(2);
    expect(log.of(line)).toEqual([{ orderId: ORDER_ID }]);
    expect(signals.outcomes).toHaveLength(2);
  });

  test('P-T3_리뷰 고침 M4: 이미 표시한 행은 쓰기를 부르지 않고 로그도 내지 않는다(지표는 오른다)', async () => {
    const { queries, gateway, log, signals, resolver } = setup();
    gateway.fallback = () => approved({ amount: AMOUNT + 1 });

    await resolver.runJob(job({ anomalyLogged: true }));

    expect(queries.anomalies).toEqual([]);
    expect(log.of('amountMismatch')).toEqual([]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'amount_mismatch']]);
  });

  test('P-T3_리뷰 고침 M4: 표시 쓰기가 실패하면 로그를 내지 않고 던지지 않는다(다음 조회가 다시 낸다) [ASVS v5.0.0-16.5.2]', async () => {
    const { queries, gateway, log, resolver } = setup();
    const err = new Error('쓰기 실패');
    gateway.fallback = () => approved({ amount: AMOUNT + 1 });
    queries.anomalyResults = [throws(err)];

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'amount_mismatch' });

    expect(log.of('amountMismatch')).toEqual([]);
    expect(log.of('runError')).toEqual([{ what: 'anomaly', orderId: ORDER_ID, err }]);
  });

  test('P-T3_리뷰 고침 M6: 조회에 전용 시간 한도 10초 [가정]을 넘긴다 [ASVS v5.0.0-16.5.2]', async () => {
    const { gateway, resolver } = setup();
    await resolver.runJob(job());
    expect(gateway.options).toEqual([{ timeoutMs: 10_000 }]);
  });

  test('P-T16_리뷰 고침 H4: 원장의 결제 시도 ID를 조회의 대조값으로 넘긴다 [ASVS v5.0.0-2.2.3]', async () => {
    const { gateway, resolver } = setup();
    await resolver.runJob(job({ txId: 'tx-attempt-1' }));
    expect(gateway.options).toEqual([{ timeoutMs: 10_000, expectedTxId: 'tx-attempt-1' }]);
  });

  test('P-T3_리뷰 고침 M6: 답하지 않는 어댑터도 실행기 한도에서 자리를 돌려주고 결과를 가정하지 않는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async () => {
    const { queries, gateway, log, signals, resolver } = setup({ concurrency: 1, queryGuardMs: 20 });
    gateway.fallback = () => new Promise<QueryResult>(() => {});
    queries.claims = [[jobN(1)], [jobN(2)]];

    await resolver.tick();
    await resolver.whenIdle();

    expect(queries.resolved).toEqual([]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'query_failed']]);
    expect(log.of('runError')).toHaveLength(1);
    expect(signals.inFlights.at(-1)).toBe(0);
    await expect(resolver.tick()).resolves.toEqual({ claimed: 1 });
    await resolver.whenIdle();
  });

  test.each<[string, () => QueryResult, PaymentUnknownQueryOutcome]>([
    ['처리 중', () => approved({ status: 'IN_PROGRESS' }), 'still_processing'],
    ['기록 없음', () => ({ kind: 'NOT_FOUND' }), 'not_found'],
    ['조회 실패', () => ({ kind: 'UNKNOWN' }), 'query_failed'],
  ])('P-T3_리뷰 고침 M6: %s로 그대로 두면 답을 본 시각 + 실제 간격으로 다시 쓴다', async (_name, answer, outcome) => {
    const { order, queries, gateway, signals, resolver } = setup();
    gateway.fallback = answer;
    const claimed = job({ queryAttempts: 2 });

    await resolver.runJob(claimed);

    expect(queries.rescheduled).toEqual([{ job: claimed, nextAtMs: NOW + 10_000 }]);
    expect(order).toEqual(['query', 'reschedule']);
    expect(signals.outcomes).toEqual([['SIMULATOR', outcome]]);
  });

  test('P-T3_리뷰 고침 M6: 결과를 쓴 행과 어댑터가 없는 행은 간격을 다시 쓰지 않는다', async () => {
    const a = setup();
    await a.resolver.runJob(job());
    expect(a.queries.rescheduled).toEqual([]);

    const b = setup();
    await b.resolver.runJob(job({ pg: 'TOSS' }));
    expect(b.queries.rescheduled).toEqual([]);
  });

  test('P-T3_리뷰 고침 M6: 간격 쓰기가 실패해도 던지지 않는다(잡을 때 민 시각에 다시 잡힌다) [ASVS v5.0.0-16.5.2]', async () => {
    const { queries, gateway, log, resolver } = setup();
    const err = new Error('쓰기 실패');
    gateway.fallback = () => ({ kind: 'UNKNOWN' });
    queries.rescheduleResults = [throws(err)];

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'query_failed' });

    expect(log.of('runError')).toEqual([{ what: 'reschedule', orderId: ORDER_ID, err }]);
  });

  test('P-T3_리뷰 고침 M7: 1시간 표시는 잡기와 별개의 1분 반복이고 빈자리가 없어도 돈다 [ASVS v5.0.0-16.3.4]', async () => {
    const { queries, gateway, timer, log, signals, resolver } = setup({ concurrency: 1 });
    gateway.fallback = () => new Promise<QueryResult>(() => {});
    queries.claims = [[job()]];
    await resolver.tick();
    await flush();

    resolver.start();
    expect(timer.set.map((t) => t.ms)).toEqual([1_000, 60_000]);
    queries.sweeps = [[uuidAt(1), uuidAt(2)]];
    timer.set[1]!.fn();
    await flush();

    expect(queries.sweepLimits).toEqual([100]);
    expect(log.of('overdue')).toEqual([{ orderId: uuidAt(1) }, { orderId: uuidAt(2) }]);
    expect(signals.overdues).toBe(2);
  });

  test('P-T3_리뷰 고침 M7: 잡은 행을 돌 때는 1시간 표시를 하지 않는다', async () => {
    const { order, queries, resolver } = setup();
    await resolver.runJob(job());
    expect(queries.sweepLimits).toEqual([]);
    expect(order).toEqual(['query', 'resolve']);
  });

  test('P-T3_리뷰 고침 M7: 표시가 실패하면 던지지 않고 오류를 남긴다, 앞 표시가 돌면 겹치지 않는다, 멈춘 뒤에는 돌지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { queries, timer, log, resolver } = setup();
    const err = new Error('쓰기 실패');
    queries.sweeps = [throws(err)];
    await expect(resolver.sweepOverdue()).resolves.toEqual({ marked: 0 });
    expect(log.of('runError')).toEqual([{ what: 'overdue', err }]);

    const held = deferred<string[]>();
    queries.markOverdueBatch = async (limit: number) => {
      queries.sweepLimits.push(limit);
      return held.promise;
    };
    resolver.start();
    timer.set[1]!.fn();
    timer.set[1]!.fn();
    await flush();
    expect(queries.sweepLimits).toEqual([100, 100]);
    held.resolve([]);
    await resolver.stop();

    await expect(resolver.sweepOverdue()).resolves.toEqual({ marked: 0 });
    expect(queries.sweepLimits).toEqual([100, 100]);
    expect(timer.cleared).toHaveLength(2);
  });

  test('P-T3_리뷰 고침 H3: 취소 상태 로그는 error 한 줄(SEV1), csCase이고 주문 ID만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', () => {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
        done();
      },
    });
    const logger = createPlatformLogger({ service: 'payment-svc', env: 'test', version: 't', pod: 'p', clock: systemClock, level: 'info', destination });

    paymentUnknownLog(logger).cancelledAtPg({ orderId: ORDER_ID });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-unknown-cancelled-at-pg', severity: 'SEV1', csCase: 'PAYMENT_UNKNOWN', orderId: ORDER_ID });
    for (const key of ['amount', 'paymentRef', 'paymentKey']) expect(lines[0]).not.toHaveProperty(key);
  });
});

describe('start·stop', () => {
  test('PRF182_start는 1초 주기로 켜고 앞 틱의 잡기가 끝나지 않았으면 건너뛴다', async () => {
    const { queries, timer, resolver } = setup();
    const held = deferred<UnknownQueryJob[]>();
    queries.claimDueQueries = async (pg: PgName, limit: number) => {
      if (pg !== 'SIMULATOR') return [];
      queries.limits.push(limit);
      return held.promise;
    };

    resolver.start();
    resolver.start();
    expect(timer.set).toHaveLength(2);
    expect(timer.set[0]!.ms).toBe(1_000);

    timer.fire();
    timer.fire();
    await flush();
    expect(queries.limits).toHaveLength(1);

    held.resolve([]);
    await resolver.whenIdle();
    await flush();
    timer.fire();
    await flush();
    expect(queries.limits).toHaveLength(2);
    await resolver.stop();
  });

  test('PRF182_stop은 타이머를 끄고 돌던 조회와 그 뒤 쓰기를 기다린다', async () => {
    const { queries, gateway, timer, resolver } = setup();
    const answer = deferred<QueryResult>();
    gateway.fallback = () => answer.promise;
    queries.claims = [[job()]];
    resolver.start();
    await resolver.tick();
    await flush();

    let stopped = false;
    const stopping = resolver.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
    expect(timer.cleared).toHaveLength(2);

    answer.resolve(approved());
    await stopping;
    expect(queries.resolved).toHaveLength(1);
  });

  test('PRF182_멈춘 뒤에는 잡지 않고 start도 켜지 않는다', async () => {
    const { queries, timer, resolver } = setup();
    await resolver.stop();

    resolver.start();
    expect(timer.set).toEqual([]);
    await expect(resolver.tick()).resolves.toEqual({ claimed: 0 });
    expect(queries.limits).toEqual([]);
  });

  test('PRF182_잡았지만 부르기 전에 멈췄으면 부르지 않는다(밀어 둔 간격 뒤 다시 잡힌다)', async () => {
    const { queries, gateway, resolver } = setup();
    const claim = deferred<UnknownQueryJob[]>();
    queries.claimDueQueries = async () => claim.promise;

    const ticking = resolver.tick();
    await flush();
    const stopping = resolver.stop();
    claim.resolve([job()]);
    await ticking;
    await stopping;

    expect(gateway.queried).toEqual([]);
    expect(queries.resolved).toEqual([]);
  });

  test('PRF182_틱은 만든 때의 비동기 맥락에서 돈다(끝난 요청의 남은 시간을 물려받지 않는다)', async () => {
    const { queries, gateway, resolver } = setup();
    queries.claims = [[job()]];
    const dl = fakeClock({ now: NOW });
    const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(1, dl), route: '/x', method: 'POST', log: {} as RequestContext['log'] };
    dl.advance(10);
    const contexts: unknown[] = [];
    gateway.fallback = () => {
      contexts.push(requestContext());
      return approved();
    };

    await runInRequestContext(ctx, () => resolver.tick());
    await resolver.whenIdle();

    expect(contexts).toEqual([undefined]);
  });
});

describe('결제사 호출 보호(BUILD_ORDER PRF-183)', () => {
  /** 토큰을 모두 쓰고 쓴 수를 돌려준다(시험이 끝나지 않는 일이 없게 반복에 상한을 둔다) */
  const drain = (guards: PgCallGuards): number => {
    let n = 0;
    while (n < 10_000 && guards.of('SIMULATOR')!.tryTakeToken()) n += 1;
    return n;
  };

  test('P-T34_조회 한 번이 토큰 하나를 쓴다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.4.1]', async () => {
    const { guards, resolver } = setup();
    await resolver.runJob(job());
    expect(drain(guards)).toBe(59);
  });

  test('P-T40_토큰이 없으면 부르지 않고 다음 조회 시각만 짧게 쓰며 잡을 때 올린 횟수를 되돌린다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.5.2]', async () => {
    const { queries, gateway, signals, guards, resolver } = setup();
    drain(guards);

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'NO_TOKEN' });

    expect(gateway.queried).toEqual([]);
    expect(queries.rescheduled).toEqual([{ job: job(), nextAtMs: NOW + 1_000, o: { refundAttempt: true } }]);
    expect(signals.outcomes).toEqual([]);
  });

  test('P-T40_간격 쓰기가 던져도 던지지 않고 오류를 남긴다(잡을 때 민 시각에 다시 잡힌다) [ASVS v5.0.0-16.3.4]', async () => {
    const { queries, log, guards, resolver } = setup();
    drain(guards);
    const err = new Error('쓰기 실패');
    queries.rescheduleResults = [throws(err)];

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'NO_TOKEN' });

    expect(log.of('runError')).toEqual([{ what: 'reschedule', orderId: ORDER_ID, err }]);
  });

  test('P-T40_답을 본 뒤의 간격 쓰기는 횟수를 되돌리지 않는다(실제로 물었다)', async () => {
    const { queries, gateway, resolver } = setup();
    gateway.fallback = () => ({ kind: 'UNKNOWN' });
    await resolver.runJob(job());
    expect(queries.rescheduled).toEqual([{ job: job(), nextAtMs: NOW + 5_000 }]);
  });

  test('P-T40_조회의 429는 상한을 낮추지 않고 지표만 센다(first false)이고 다시 묻는다 [ASVS v5.0.0-2.3.2]', async () => {
    const { gateway, signals, guards, guardSignals, resolver } = setup();
    gateway.fallback = () => ({ kind: 'UNKNOWN', throttled: true });
    const before = guards.of('SIMULATOR')!.limits();

    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'query_failed' });

    expect(guards.of('SIMULATOR')!.limits()).toEqual(before);
    expect(guardSignals.throttleds).toEqual([['SIMULATOR', false]]);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'query_failed']]);
  });

  test('P-T40_벌크헤드와 상관없이 돈다(벌크헤드는 승인 호출만 잡는다) [ASVS v5.0.0-15.1.3]', async () => {
    const { queries, guards, resolver } = setup();
    const guard = guards.of('SIMULATOR')!;
    for (let i = 0; i < guard.limits().concurrency; i += 1) guard.holdOne();
    expect(guard.available()).toBe(0);
    queries.claims = [[job()]];
    await expect(resolver.tick()).resolves.toEqual({ claimed: 1 });
    await resolver.whenIdle();
    expect(queries.resolved).toHaveLength(1);
  });

  test('PRF183_어댑터가 없으면 토큰을 찾지 않고 지금처럼 건너뛴다', async () => {
    const { resolver, signals } = setup({ gateways: { of: () => undefined } });
    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'no_adapter' });
    expect(signals.outcomes).toEqual([['SIMULATOR', 'no_adapter']]);
  });

  test('PRF183_보호기를 만들지 못하면 조회 실패로 다시 묻는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { log, signals, resolver } = setup({
      guards: {
        of: () => {
          throw new Error('어댑터 결함');
        },
      } as unknown as PgCallGuards,
    });
    await expect(resolver.runJob(job())).resolves.toEqual({ kind: 'ASKED_AGAIN', outcome: 'query_failed' });
    expect(log.of('runError')).toHaveLength(1);
    expect(signals.outcomes).toEqual([['SIMULATOR', 'query_failed']]);
  });

  describe('리뷰 고침(코드 리뷰)', () => {
    /** 남은 토큰 수(뺀 뒤 돌려준다) */
    const tokensLeft = (guards: PgCallGuards): number => {
      const n = drain(guards);
      guards.of('SIMULATOR')!.refundTokens(n);
      return n;
    };

    test('P-T40_리뷰 고침 M6: 조회 잡기 수는 조회가 쓸 수 있는 토큰 수로 제한한다 [ASVS v5.0.0-2.4.1]', async () => {
      const { queries, gateway, resolver } = setup();
      gateway.rps = 20;
      await resolver.tick();
      expect(queries.limits).toEqual([4]);
    });

    test('P-T40_리뷰 고침 M6: 잡은 수만큼 토큰을 미리 빼고 못 잡은 수는 돌려주며, 조회마다 토큰은 하나다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.4.1]', async () => {
      const { queries, gateway, guards, resolver } = setup();
      queries.claims = [[job()]];
      await resolver.tick();
      await resolver.whenIdle();
      expect(gateway.queried).toHaveLength(1);
      expect(tokensLeft(guards)).toBe(59);
    });

    test('P-T40_리뷰 고침 M6: 틱이 잡은 행은 호출 앞에서 토큰을 다시 찾지 않는다 [ASVS v5.0.0-2.4.1]', async () => {
      const { queries, gateway, guards, resolver } = setup();
      const claim = deferred<UnknownQueryJob[]>();
      const original = queries.claimDueQueries.bind(queries);
      queries.claimDueQueries = async (pg: PgName, limit: number) => (pg === 'SIMULATOR' ? claim.promise : original(pg, limit));
      const ticking = resolver.tick();
      await flush();
      drain(guards);
      claim.resolve([job()]);
      await ticking;
      await resolver.whenIdle();
      expect(gateway.queried).toHaveLength(1);
      expect(queries.rescheduled).toEqual([]);
    });

    test('P-T40_리뷰 고침 M6: 미리 뺐지만 멈춰서 부르지 않은 행의 토큰은 돌려준다 [ASVS v5.0.0-2.4.1]', async () => {
      const { queries, guards, resolver } = setup();
      const claim = deferred<UnknownQueryJob[]>();
      const original = queries.claimDueQueries.bind(queries);
      queries.claimDueQueries = async (pg: PgName, limit: number) => (pg === 'SIMULATOR' ? claim.promise : original(pg, limit));
      const ticking = resolver.tick();
      await flush();
      const stopping = resolver.stop();
      claim.resolve([job()]);
      await ticking;
      await stopping;
      expect(tokensLeft(guards)).toBe(60);
    });

    test('P-T40_리뷰 고침 M6: 잡기가 던지면 미리 뺀 토큰을 모두 돌려준다 [ASVS v5.0.0-16.5.2]', async () => {
      const { queries, guards, resolver } = setup();
      queries.claims = [throws(new Error('연결 실패'))];
      await resolver.tick();
      expect(tokensLeft(guards)).toBe(60);
    });

    test('P-T40_리뷰 고침 M6: 토큰이 없으면 잡지 않고, 기다리는 행이 있을 때만 saturated를 센다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.3.4]', async () => {
      const a = setup();
      drain(a.guards);
      a.guardSignals.saturateds.length = 0;
      await expect(a.resolver.tick()).resolves.toEqual({ claimed: 0 });
      expect(a.queries.limits).toEqual([]);
      expect(a.guardSignals.saturateds).toEqual([['SIMULATOR', 'token']]);

      const b = setup();
      drain(b.guards);
      b.guardSignals.saturateds.length = 0;
      b.queries.due.set('SIMULATOR', false);
      await b.resolver.tick();
      expect(b.guardSignals.saturateds).toEqual([]);
    });

    test('P-T40_리뷰 고침 H1: 조회도 채널마다 따로 잡아 한 채널의 잡기가 늦어도 다른 채널은 돈다 [ASVS v5.0.0-15.1.3]', async () => {
      const adapter = new FakeGateway([]) as unknown as PaymentGatewayPort;
      const gateways: PaymentGateways = { of: (pg) => (pg === 'PORTONE' ? undefined : adapter) };
      const guards = new PgCallGuards({ gateways, podCount: 1, clock: fakeClock({ now: NOW }), signals: new FakeGuardSignals(), log: { throttledFirst: () => undefined } });
      const { queries, timer, resolver } = setup({ gateways, guards });
      const gate = deferred();
      queries.otherGate = gate.promise;
      resolver.start();
      timer.fire();
      await flush();
      timer.fire();
      await flush();
      expect(queries.limits).toHaveLength(2);
      gate.resolve();
      await resolver.stop();
    });

    test('P-T40_리뷰 고침 M6: 어댑터가 없는 채널의 행도 빈자리만큼 잡아 no_adapter로 드러낸다(토큰을 쓰지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
      const { queries, resolver } = setup({ concurrency: 4 });
      await resolver.tick();
      expect(queries.otherLimits).toEqual([
        ['TOSS', 2],
        ['PORTONE', 2],
      ]);
    });

    test('P-T40_리뷰 고침 H1: 어댑터가 있는 채널들은 빈자리를 나눠 잡아 앞 채널이 뒤 채널을 굶기지 않는다 [ASVS v5.0.0-15.1.3]', async () => {
      const seen: [PgName, number][] = [];
      const gateways: PaymentGateways = { of: () => new FakeGateway([]) as unknown as PaymentGatewayPort };
      const guards = new PgCallGuards({ gateways, podCount: 1, clock: fakeClock({ now: NOW }), signals: new FakeGuardSignals(), log: { throttledFirst: () => undefined } });
      const { queries, resolver } = setup({ gateways, guards, concurrency: 16 });
      queries.claimDueQueries = async (pg: PgName, limit: number) => {
        seen.push([pg, limit]);
        return [];
      };
      await resolver.tick();
      expect(seen).toEqual([
        ['TOSS', 6],
        ['PORTONE', 5],
        ['SIMULATOR', 5],
      ]);
    });
  });
});

describe('paymentUnknownLog', () => {
  function realLogger() {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
        done();
      },
    });
    return { lines, logger: createPlatformLogger({ service: 'payment-svc', env: 'test', version: 't', pod: 'p', clock: systemClock, level: 'info', destination }) };
  }
  const leaky = (code?: string): Error => Object.assign(new Error(`UPDATE payment SET pg_payment_ref='${SECRET_PAYMENT_KEY}'`), code ? { code } : {});

  test('P-T3_금액 어긋남은 error 한 줄(SEV1)이고 주문 ID만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    paymentUnknownLog(logger).amountMismatch({ orderId: ORDER_ID });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-unknown-amount-mismatch', severity: 'SEV1', orderId: ORDER_ID });
    for (const key of ['amount', 'expected', 'actual', 'paymentRef', 'paymentKey']) expect(lines[0]).not.toHaveProperty(key);
  });

  test('P-T3_주문 어긋남은 error 한 줄(SEV1)이다 [ASVS v5.0.0-16.3.4]', () => {
    const { lines, logger } = realLogger();
    paymentUnknownLog(logger).orderMismatch({ orderId: ORDER_ID });
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-unknown-order-mismatch', severity: 'SEV1', orderId: ORDER_ID });
  });

  test('PRF182_오래 안 풀림은 SEV2, csCase PAYMENT_UNKNOWN이고 주문 ID만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    paymentUnknownLog(logger).overdue({ orderId: ORDER_ID });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-unknown-overdue', severity: 'SEV2', csCase: 'PAYMENT_UNKNOWN', orderId: ORDER_ID });
    expect(lines[0]).not.toHaveProperty('amount');
  });

  test('PRF182_어댑터 없음은 warn 한 줄이고 결제사만 싣는다', () => {
    const { lines, logger } = realLogger();
    paymentUnknownLog(logger).noAdapter({ pg: 'SIMULATOR' });
    expect(lines[0]).toMatchObject({ level: 'warn', kind: 'payment-unknown-no-adapter', pg: 'SIMULATOR' });
  });

  test('PRF182_쓰기 실패와 실행 오류는 코드만 싣고 드라이버 오류의 글을 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    const log = paymentUnknownLog(logger);
    log.writeFailed({ orderId: ORDER_ID, code: '40P01' });
    log.runError({ what: 'call', orderId: ORDER_ID, err: leaky('ECONNRESET') });
    log.runError({ what: 'claim', err: leaky() });
    expect(lines.map((l) => [l.kind, l.code])).toEqual([
      ['payment-unknown-write-failed', '40P01'],
      ['payment-unknown-run', 'ECONNRESET'],
      ['payment-unknown-run', 'Error'],
    ]);
    expect(JSON.stringify(lines)).not.toContain(SECRET_PAYMENT_KEY);
  });

  test('PRF182_늦은 답은 warn 한 줄이고, 로거가 던져도 삼킨다', () => {
    const { lines, logger } = realLogger();
    paymentUnknownLog(logger).staleAnswer({ orderId: ORDER_ID });
    expect(lines[0]).toMatchObject({ level: 'warn', kind: 'payment-unknown-stale', orderId: ORDER_ID });
    const bad = { warn: () => { throw new Error('x'); }, error: () => { throw new Error('x'); } } as unknown as Parameters<typeof paymentUnknownLog>[0];
    expect(() => paymentUnknownLog(bad).overdue({ orderId: ORDER_ID })).not.toThrow();
  });
});

describe('PromPaymentUnknownSignals', () => {
  const metrics = () => {
    const m = new PlatformMetrics('payment-svc');
    return { m, signals: new PromPaymentUnknownSignals().register(m.registry) };
  };

  test('PRF182_모든 결제사·outcome을 0으로 미리 보이고 지표 이름이 정본과 같다', async () => {
    const { m } = metrics();
    const text = await m.registry.metrics();
    for (const pg of ['TOSS', 'PORTONE', 'SIMULATOR']) for (const outcome of PAYMENT_UNKNOWN_QUERY_OUTCOMES) expect(text).toContain(`payment_unknown_query_total{pg="${pg}",outcome="${outcome}"`);
    expect(text).toMatch(/^payment_unknown_overdue_total/m);
    expect(text).toMatch(/^payment_unknown_write_failures_total/m);
    expect(text).toContain('# TYPE payment_unknown_in_flight gauge');
  });

  test('PRF182_값을 올리고 게이지를 둔다', async () => {
    const { m, signals } = metrics();
    signals.outcome('SIMULATOR', 'approved');
    signals.overdue();
    signals.writeFailure();
    signals.inFlight(3);
    const text = await m.registry.metrics();
    expect(text).toMatch(/payment_unknown_query_total\{pg="SIMULATOR",outcome="approved".*\} 1/);
    expect(text).toMatch(/^payment_unknown_overdue_total.* 1$/m);
    expect(text).toMatch(/^payment_unknown_write_failures_total.* 1$/m);
    expect(text).toMatch(/^payment_unknown_in_flight.* 3$/m);
  });
});

describe('저장소 입력 검사', () => {
  const store = () => new DrizzleConfirmJobs({ database: {} as Database, clock: systemClock });

  test.each([0, -1, 1.5, Number.NaN])('PRF182_claimDueQueries의 limit이 %s이면 RangeError다', async (limit) => {
    await expect(store().claimDueQueries('SIMULATOR', limit)).rejects.toBeInstanceOf(RangeError);
  });
});
