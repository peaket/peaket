// 승인 실행기의 어댑터 중 DB 없이 볼 수 있는 것(BUILD_ORDER PRF-181, docs/features/payment.md §2 '승인 실행기의 첫 구현', docs/observability.md 승인 실행기 줄):
// paymentConfirmLog(로그 줄의 모양과 뺀 값), PromPaymentConfirmSignals(지표 이름·이름표), jsonPaymentEventCodec, StaticPaymentGateways,
// confirmRunnerDatabaseOptions, DrizzleConfirmJobs의 입력 검사와 트랜잭션 선택값. 실제 PostgreSQL로 도는 것은 test-int가 본다.
import { Writable } from 'node:stream';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { createPlatformLogger, type Database, LATENCY_BUCKETS_SECONDS, PlatformMetrics, systemClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CONFIRM_RUNNER_DB_MAX, confirmRunnerDatabaseOptions, DrizzleConfirmJobs } from '../src/modules/payment/adapters/db/drizzle-confirm-jobs.js';
import { paymentConfirmLog } from '../src/modules/payment/adapters/payment-confirm-log.js';
import { jsonPaymentEventCodec, TRADE_PAYMENTS_TOPIC } from '../src/modules/payment/adapters/payment-events.js';
import { StaticPaymentGateways } from '../src/modules/payment/adapters/pg/payment-gateways.js';
import { PromPaymentConfirmSignals } from '../src/modules/payment/adapters/prom-payment-confirm-signals.js';
import { type ConfirmJob, type ConfirmTarget, CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS, PAYMENT_CONFIRM_OUTCOMES, type PaymentEventMessage } from '../src/modules/payment/domain/confirm-runner.js';
import type { PaymentGatewayPort, PgName } from '../src/modules/payment/domain/payment-gateway.js';
import { EVENT_ID, NOW, ORDER_ID, PAYMENT_ID, rejectedBy, SECRET_PAYMENT_KEY, SECRET_PAYMENT_TOKEN } from './confirm-cases.js';

const PGS: readonly PgName[] = ['TOSS', 'PORTONE', 'SIMULATOR'];

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

/** 글에 비밀이 실린 드라이버 오류 */
const leakyError = (code?: string): Error => Object.assign(new Error(`UPDATE payment SET pg_payment_ref='${SECRET_PAYMENT_KEY}', pg_confirm_token='${SECRET_PAYMENT_TOKEN}'`), code ? { code } : {});

describe('paymentConfirmLog', () => {
  test('PRF181_금액 어긋남은 error 한 줄(SEV1, kind payment-confirm-amount-mismatch)이고 주문 ID만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    paymentConfirmLog(logger).amountMismatch({ orderId: ORDER_ID });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-confirm-amount-mismatch', severity: 'SEV1', orderId: ORDER_ID });
    for (const key of ['amount', 'expected', 'actual', 'paymentRef', 'paymentKey']) expect(lines[0]).not.toHaveProperty(key);
  });

  test('PRF181_어댑터 없음은 warn 한 줄이고 결제사만 싣는다', () => {
    const { lines, logger } = realLogger();
    paymentConfirmLog(logger).noAdapter({ pg: 'SIMULATOR' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', kind: 'payment-confirm-no-adapter', pg: 'SIMULATOR' });
  });

  test('PRF181_쓰기 실패는 error 한 줄이고 주문 ID·단계·코드만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    paymentConfirmLog(logger).writeFailed({ orderId: ORDER_ID, stage: 'finish', code: '40P01' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-confirm-write-failed', orderId: ORDER_ID, stage: 'finish', code: '40P01' });
    expect(lines[0]).not.toHaveProperty('err');
  });

  test('PRF181_늦은 답은 warn 한 줄이다', () => {
    const { lines, logger } = realLogger();
    paymentConfirmLog(logger).staleAnswer({ orderId: ORDER_ID });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', kind: 'payment-confirm-stale', orderId: ORDER_ID });
  });

  test.each<['claim' | 'read' | 'call', unknown, string]>([
    ['claim', leakyError('40001'), '40001'],
    ['read', leakyError(), 'Error'],
    ['call', 'boom', 'UNKNOWN'],
  ])('PRF181_실행기 오류(%s)는 error 한 줄이고 오류 코드만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', (what, err, code) => {
    const { lines, logger } = realLogger();
    paymentConfirmLog(logger).runError({ what, orderId: ORDER_ID, err });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-confirm-run', what, code, orderId: ORDER_ID });
    expect(lines[0]).not.toHaveProperty('err');
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain(SECRET_PAYMENT_KEY);
    expect(text).not.toContain(SECRET_PAYMENT_TOKEN);
  });

  test('PRF181_잡기 오류처럼 주문이 없으면 orderId 칸이 없다', () => {
    const { lines, logger } = realLogger();
    paymentConfirmLog(logger).runError({ what: 'claim', err: leakyError('40001') });
    expect(lines[0]).not.toHaveProperty('orderId');
  });

  test('PRF181_로거가 던져도 삼킨다(로그 때문에 실행기가 멈추지 않는다) [ASVS v5.0.0-16.5.2]', () => {
    const boom = (): never => {
      throw new Error('로거 고장');
    };
    const log = paymentConfirmLog({ warn: boom, error: boom } as unknown as Parameters<typeof paymentConfirmLog>[0]);
    expect(() => log.amountMismatch({ orderId: ORDER_ID })).not.toThrow();
    expect(() => log.noAdapter({ pg: 'TOSS' })).not.toThrow();
    expect(() => log.writeFailed({ orderId: ORDER_ID, stage: 'mark', code: 'X' })).not.toThrow();
    expect(() => log.staleAnswer({ orderId: ORDER_ID })).not.toThrow();
    expect(() => log.runError({ what: 'call', orderId: ORDER_ID, err: new Error('x') })).not.toThrow();
  });
});

describe('PromPaymentConfirmSignals', () => {
  async function metricsOf(signals: PromPaymentConfirmSignals) {
    const metrics = new PlatformMetrics('payment-svc');
    expect(signals.register(metrics.registry)).toBe(signals);
    const json = () => metrics.registry.getMetricsAsJSON();
    const named = async (name: string) => (await json()).find((m) => m.name === name);
    return { metrics, named };
  }

  test('PRF181_payment_confirm_total은 결제사 셋 × outcome 아홉을 0으로 미리 보인다', async () => {
    const { named } = await metricsOf(new PromPaymentConfirmSignals());
    const total = (await named('payment_confirm_total'))!;
    expect(String(total.type)).toBe('counter');
    const got = total.values.map((v) => `${v.labels.pg}/${v.labels.outcome}=${v.value}`).sort();
    expect(got).toEqual(PGS.flatMap((pg) => PAYMENT_CONFIRM_OUTCOMES.map((o) => `${pg}/${o}=0`)).sort());
  });

  test('PRF181_payment_confirm_total의 이름표는 pg·outcome 둘뿐이고 건마다 하나 오른다', async () => {
    const signals = new PromPaymentConfirmSignals();
    const { named } = await metricsOf(signals);
    signals.outcome('SIMULATOR', 'approved');
    signals.outcome('SIMULATOR', 'approved');
    signals.outcome('TOSS', 'restart');
    const values = (await named('payment_confirm_total'))!.values;
    for (const v of values) expect(Object.keys(v.labels).sort()).toEqual(['outcome', 'pg']);
    expect(values.find((v) => v.labels.pg === 'SIMULATOR' && v.labels.outcome === 'approved')!.value).toBe(2);
    expect(values.find((v) => v.labels.pg === 'TOSS' && v.labels.outcome === 'restart')!.value).toBe(1);
    expect(values.find((v) => v.labels.pg === 'TOSS' && v.labels.outcome === 'approved')!.value).toBe(0);
  });

  test('PRF181_payment_confirm_seconds는 pg 이름표의 히스토그램이고 칸은 표준 목록(60초 포함)이다', async () => {
    const signals = new PromPaymentConfirmSignals();
    const { named } = await metricsOf(signals);
    signals.callSeconds('SIMULATOR', 0.25);
    signals.callSeconds('SIMULATOR', 60);
    const m = (await named('payment_confirm_seconds'))!;
    expect(String(m.type)).toBe('histogram');
    const nameOf = (v: object): string | undefined => (v as { metricName?: string }).metricName;
    const buckets = m.values.filter((v) => nameOf(v) === 'payment_confirm_seconds_bucket' && v.labels.pg === 'SIMULATOR');
    expect(LATENCY_BUCKETS_SECONDS).toContain(60);
    expect(buckets.map((b) => b.labels.le)).toEqual([...LATENCY_BUCKETS_SECONDS, '+Inf']);
    for (const v of m.values) expect(Object.keys(v.labels).filter((k) => k !== 'le')).toEqual(['pg']);
    expect(m.values.find((v) => nameOf(v) === 'payment_confirm_seconds_count' && v.labels.pg === 'SIMULATOR')!.value).toBe(2);
    expect(m.values.find((v) => nameOf(v) === 'payment_confirm_seconds_sum' && v.labels.pg === 'SIMULATOR')!.value).toBe(60.25);
  });

  test('PRF181_payment_confirm_in_flight는 이름표 없는 게이지이고 마지막 값을 둔다', async () => {
    const signals = new PromPaymentConfirmSignals();
    const { named } = await metricsOf(signals);
    signals.inFlight(5);
    signals.inFlight(3);
    const m = (await named('payment_confirm_in_flight'))!;
    expect(String(m.type)).toBe('gauge');
    expect(m.values).toEqual([{ labels: {}, value: 3 }]);
  });

  test('PRF181_payment_confirm_write_failures_total은 이름표 없는 카운터이고 처음부터 0을 보인다', async () => {
    const signals = new PromPaymentConfirmSignals();
    const { named } = await metricsOf(signals);
    expect((await named('payment_confirm_write_failures_total'))!.values).toEqual([{ labels: {}, value: 0 }]);
    signals.writeFailure();
    signals.writeFailure();
    const m = (await named('payment_confirm_write_failures_total'))!;
    expect(String(m.type)).toBe('counter');
    expect(m.values).toEqual([{ labels: {}, value: 2 }]);
  });

  test('PRF181_register 앞에 올린 값도 보이고, 다른 레지스트리에 새지 않는다(registers: [])', async () => {
    const signals = new PromPaymentConfirmSignals();
    signals.outcome('TOSS', 'declined');
    const a = new PlatformMetrics('payment-svc');
    signals.register(a.registry);
    expect(await a.registry.metrics()).toMatch(/payment_confirm_total\{[^}]*outcome="declined"[^}]*\} 1/);
    const b = new PlatformMetrics('payment-svc');
    expect(await b.registry.metrics()).not.toContain('payment_confirm_total');
  });
});

describe('jsonPaymentEventCodec', () => {
  const message: PaymentEventMessage = {
    eventId: EVENT_ID,
    orderId: ORDER_ID,
    pg: 'SIMULATOR',
    type: 'APPROVED',
    amount: 55_000,
    refMissing: true,
    result: 'APPROVED',
    attemptNo: 1,
    occurredAt: new Date(NOW).toISOString(),
    eventSeq: 3,
    eventKey: '0193a1b2-c3d4-8e5f-8a6b-1234567890ff',
  };

  test('PRF181_값은 UTF-8 JSON 바이트이고 모양 그대로다', () => {
    const bytes = jsonPaymentEventCodec.encode(message);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual(message);
  });

  test('PRF181_바이트를 되읽으면 asyncapi zod를 통과한다', () => {
    expect(() => PaymentEvent.parse(JSON.parse(Buffer.from(jsonPaymentEventCodec.encode(message)).toString('utf8')))).not.toThrow();
  });

  test('PRF181_주제 이름은 trade.payments다', () => {
    expect(TRADE_PAYMENTS_TOPIC).toBe('trade.payments');
  });
});

describe('StaticPaymentGateways', () => {
  const adapter = (pg: PgName): PaymentGatewayPort => ({ pg }) as PaymentGatewayPort;

  test('PRF181_pg로 어댑터를 찾고 없으면 undefined다 [ASVS v5.0.0-16.5.2]', () => {
    const sim = adapter('SIMULATOR');
    const gateways = new StaticPaymentGateways([sim]);
    expect(gateways.of('SIMULATOR')).toBe(sim);
    expect(gateways.of('TOSS')).toBeUndefined();
  });

  test('PRF181_빈 목록이면 모두 undefined다(local·ci의 어댑터 없음)', () => {
    expect(new StaticPaymentGateways([]).of('SIMULATOR')).toBeUndefined();
  });

  test('PRF181_같은 pg가 둘이면 만들 때 던진다', () => {
    expect(() => new StaticPaymentGateways([adapter('TOSS'), adapter('TOSS')])).toThrow();
  });
});

describe('confirmRunnerDatabaseOptions', () => {
  test('PRF181_일반 풀 8개, 이름 payment-svc-confirm이다(결제사가 느려도 접수 풀이 막히지 않게)', () => {
    const url = 'postgres://u:p@h:6432/payment';
    expect(CONFIRM_RUNNER_DB_MAX).toBe(8);
    expect(confirmRunnerDatabaseOptions(url)).toEqual({ url, profile: 'general', max: 8, applicationName: 'payment-svc-confirm' });
  });
});

describe('DrizzleConfirmJobs(DB에 가기 전)', () => {
  /** 트랜잭션을 열면 선택값을 적고 멈춘다 */
  class Stop extends Error {}
  function fakeDatabase() {
    const options: unknown[] = [];
    const database = {
      transaction: async (_fn: unknown, o?: unknown) => {
        options.push(o);
        throw new Stop();
      },
    } as unknown as Database;
    return { database, options };
  }
  const clock = { now: () => NOW, monotonicMs: () => 0 };
  const job: ConfirmJob = { paymentId: PAYMENT_ID, pg: 'SIMULATOR', attempts: 1, owner: 'p', leaseUntilMs: NOW + 1, hadPreviousOwner: false };
  const target: ConfirmTarget = {
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    eventId: EVENT_ID,
    attemptNo: 1,
    pg: 'SIMULATOR',
    paymentRef: SECRET_PAYMENT_KEY,
    amount: 1,
    status: 'ACCEPTED',
    authenticatedAtMs: NOW,
    confirmSent: false,
  };

  test.each([
    ['limit 0', 0, 'p', 1],
    ['limit 음수', -1, 'p', 1],
    ['limit 소수', 1.5, 'p', 1],
    ['limit NaN', Number.NaN, 'p', 1],
    ['leaseMs 0', 1, 'p', 0],
    ['leaseMs 소수', 1, 'p', 0.5],
    ['owner 빈 글', 1, '', 1],
  ])('PRF181_claimDue %s는 DB에 가기 전에 RangeError다', async (_name, limit, owner, leaseMs) => {
    const d = fakeDatabase();
    const err = await rejectedBy(new DrizzleConfirmJobs({ database: d.database, clock }).claimDue('SIMULATOR', limit, owner, leaseMs));
    expect(err).toBeInstanceOf(RangeError);
    expect(d.options).toEqual([]);
  });

  test.each([
    ['limit 0', 0, 'p', 1, 1],
    ['leaseMs 0', 1, 'p', 0, 1],
    ['deadlineMs 0', 1, 'p', 1, 0],
    ['deadlineMs 소수', 1, 'p', 1, 0.5],
    ['owner 빈 글', 1, '', 1, 1],
  ])('P-T40_리뷰 고침 M5: claimExpired %s는 DB에 가기 전에 RangeError다', async (_name, limit, owner, leaseMs, deadlineMs) => {
    const d = fakeDatabase();
    const err = await rejectedBy(new DrizzleConfirmJobs({ database: d.database, clock }).claimExpired('SIMULATOR', limit, owner, leaseMs, deadlineMs));
    expect(err).toBeInstanceOf(RangeError);
    expect(d.options).toEqual([]);
  });

  test.each<[string, (j: DrizzleConfirmJobs) => Promise<unknown>]>([
    ['claimDue', (j) => j.claimDue('SIMULATOR', 1, 'p', 1)],
    ['claimExpired', (j) => j.claimExpired('SIMULATOR', 1, 'p', 1, 1)],
    ['markSent', (j) => j.markSent(job)],
    ['finish', (j) => j.finish(target, { status: 'UNKNOWN', result: 'UNKNOWN' })],
    ['reschedule', (j) => j.reschedule(job, NOW, { countRetry: false })],
    ['dropJob', (j) => j.dropJob(job)],
    ['release', (j) => j.release(job)],
  ])('PRF181_%s는 READ COMMITTED 트랜잭션이고 문장 시간 한도 5초를 건다', async (_name, call) => {
    const d = fakeDatabase();
    expect(await rejectedBy(call(new DrizzleConfirmJobs({ database: d.database, clock })))).toBeInstanceOf(Stop);
    expect(d.options).toEqual([{ isolationLevel: 'read committed', statementTimeoutMs: CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS }]);
  });
});
