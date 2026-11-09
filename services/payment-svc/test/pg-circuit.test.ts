// 결제사 서킷(domain/pg-circuit.ts·domain/pg-call-guard.ts, adapters/pg-circuit.ts, 승인·조회 실행기, 입금 전 취소, 어댑터의 일시 장애 표시).
// 정본: docs/features/payment.md §2 '결제사 서킷의 첫 구현'·P-T43·P-T40, docs/verification.md §4.1 '결제사 서킷과 미루기', BUILD_ORDER PRF-200, docs/security/asvs/payment.md.
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';
import { BreakerPgCircuit, BreakerPgCircuits } from '../src/modules/payment/adapters/pg-circuit.js';
import { PromPaymentResolutionSignals } from '../src/modules/payment/adapters/prom-payment-resolution-signals.js';
import { PaymentConfirmRunner } from '../src/modules/payment/application/payment-confirm-runner.js';
import { PaymentUnknownResolver } from '../src/modules/payment/application/payment-unknown-resolver.js';
import { CancelDepositPayment } from '../src/modules/payment/application/cancel-deposit-payment.js';
import { type ConfirmFinish, type ConfirmJob, type ConfirmTarget } from '../src/modules/payment/domain/confirm-runner.js';
import type { ConfirmResult, PaymentGatewayPort, PgName, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import { isConfirmOutage, isProbeFailure, isQueryOutage, PG_CIRCUIT_DEFER_MS, PG_CIRCUIT_PROBE_PAYMENT_REF, PG_CIRCUIT_PROBE_TIMEOUT_MS, type PgCallKind, type PgCircuit, PgCircuitOpenError, type PgCircuitState } from '../src/modules/payment/domain/pg-circuit.js';
import { PgCallGuard, PgCallGuards } from '../src/modules/payment/domain/pg-call-guard.js';
import type { ConfirmPath, PgCallGuardLog, PgCallGuardSignals } from '../src/modules/payment/domain/ports.js';
import type { UnknownQueryJob } from '../src/modules/payment/domain/unknown-resolver.js';

const NOW = Date.parse('2026-11-09T01:00:00.000Z');

class FakeCircuit implements PgCircuit {
  current: PgCircuitState = 'closed';
  /** 반 열림의 시험 호출이 남았는가 */
  trialLeft = true;
  /** true면 부르기 직전에 끊는다(판단과 호출 사이에 열린 틈) */
  rejectNext = false;
  outages = 0;
  /** action이 던져 실패로 센 수 */
  thrown = 0;
  calls = 0;
  /** run이 받은 호출 종류 */
  readonly kinds: (PgCallKind | undefined)[] = [];
  state(): PgCircuitState {
    return this.current;
  }
  admits(): boolean {
    return this.current === 'closed' || (this.current === 'half_open' && this.trialLeft);
  }
  async run<T>(action: () => Promise<T>, isOutage: (answer: T) => boolean, kind: PgCallKind): Promise<T> {
    if (this.rejectNext || !this.admits() || (kind === 'confirm' && this.current !== 'closed')) {
      this.rejectNext = false;
      throw new PgCircuitOpenError();
    }
    if (this.current === 'half_open') this.trialLeft = false;
    this.calls += 1;
    this.kinds.push(kind);
    try {
      const answer = await action();
      if (isOutage(answer)) this.outages += 1;
      return answer;
    } catch (err) {
      this.thrown += 1;
      throw err;
    }
  }
}

const noSignals: PgCallGuardSignals = { throttled: () => undefined, limit: () => undefined, inflight: () => undefined, saturated: () => undefined };
const noLog: PgCallGuardLog = { throttledFirst: () => undefined };

function gatewayStub(pg: PgName = 'SIMULATOR'): PaymentGatewayPort {
  return {
    pg,
    capabilities: () => ({ serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 86_400_000, callsPerSecond: 300, redirectCheckout: false }),
    checkout: () => {
      throw new Error('쓰지 않는다');
    },
    confirm: () => {
      throw new Error('부르면 안 된다');
    },
    query: () => {
      throw new Error('부르면 안 된다');
    },
    listTransactions: () => {
      throw new Error('쓰지 않는다');
    },
    cancel: () => {
      throw new Error('부르면 안 된다');
    },
    parseWebhook: () => {
      throw new Error('쓰지 않는다');
    },
  };
}

const CONFIRM_UNKNOWN: ConfirmResult = { outcome: 'UNKNOWN', paymentRef: 'ref' };

describe('P-T43: 무엇을 일시 장애로 세는가', () => {
  test.each([
    ['UNKNOWN + 일시 장애 표시', { outcome: 'UNKNOWN', paymentRef: 'r', outage: true }, true],
    ['표시 없는 UNKNOWN(어긋난 답)', CONFIRM_UNKNOWN, false],
    ['업무 거절', { outcome: 'DECLINED', paymentRef: 'r', failureCategory: 'CARD_DECLINED' }, false],
    ['429', { outcome: 'DECLINED', paymentRef: 'r', failureCategory: 'THROTTLED' }, false],
    ['처리 중', { outcome: 'IN_PROGRESS', paymentRef: 'r' }, false],
  ] as [string, ConfirmResult, boolean][])('P-T43_승인 답 %s의 일시 장애 판정은 %s다 [ASVS v5.0.0-16.5.2]', (_n, answer, want) => {
    expect(isConfirmOutage(answer)).toBe(want);
  });

  test.each([
    ['일시 장애 표시', { kind: 'UNKNOWN', outage: true }, true],
    ['표시 없는 UNKNOWN', { kind: 'UNKNOWN' }, false],
    ['429', { kind: 'UNKNOWN', throttled: true }, false],
    ['결제 없음', { kind: 'NOT_FOUND' }, false],
  ] as [string, QueryResult, boolean][])('P-T43_조회 답 %s의 일시 장애 판정은 %s다 [ASVS v5.0.0-16.5.2]', (_n, answer, want) => {
    expect(isQueryOutage(answer)).toBe(want);
  });

  test.each([
    ['결제 없음', { kind: 'NOT_FOUND' }, false],
    ['일시 장애 표시', { kind: 'UNKNOWN', outage: true }, true],
    ['429', { kind: 'UNKNOWN', throttled: true }, true],
    ['표시 없는 UNKNOWN(인증 오류 등)', { kind: 'UNKNOWN' }, true],
  ] as [string, QueryResult, boolean][])('P-T43_리뷰 고침 M4: 없는 결제 조회의 답 %s의 실패 판정은 %s다(ADR-0105 결정 2) [ASVS v5.0.0-16.5.2]', (_n, answer, want) => {
    expect(isProbeFailure(answer)).toBe(want);
  });
});

describe('P-T43: 어댑터의 일시 장애 표시', () => {
  type Reply = { status: number; body?: unknown } | Error;
  const stub = (replies: Reply[]): typeof fetch => async () => {
    const next = replies.shift();
    if (!next) throw new Error('답을 더 정하지 않았다');
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
  const toss = (replies: Reply[]) => new TossPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_x', clientKey: 'c', fetch: stub(replies) });
  const portone = (replies: Reply[]) => new PortoneGateway({ baseUrl: 'http://pg.test', secret: 's', storeId: 'store', channelKey: 'ch', webhookSecrets: [], isTest: true, fetch: stub(replies) });
  const C = { orderId: 'order-1234567890ab', paymentRef: 'key-1', amount: 1_000, idemKey: 'confirm-order-1234567890ab', confirmToken: 'tok' };
  const CANCEL = { paymentRef: 'key-1', amount: 'ALL' as const, reason: '고객 요청', idemKey: 'cancel-1' };

  test.each([
    ['토스 5xx', () => toss([{ status: 503 }]).confirm(C)],
    ['토스 연결 실패', () => toss([new Error('연결 끊김')]).confirm(C)],
    ['포트원 5xx', () => portone([{ status: 502 }]).confirm(C)],
    ['포트원 연결 실패', () => portone([new Error('연결 끊김')]).confirm(C)],
  ] as [string, () => Promise<ConfirmResult>][])('P-T43_승인의 %s는 일시 장애 표시를 단 UNKNOWN이다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async (_n, run) => {
    await expect(run()).resolves.toMatchObject({ outcome: 'UNKNOWN', outage: true });
  });

  test('P-T43_토스 승인의 429와 업무 거절에는 일시 장애 표시가 없다 [ASVS v5.0.0-16.5.2]', async () => {
    await expect(toss([{ status: 429 }]).confirm(C)).resolves.not.toHaveProperty('outage');
    await expect(toss([{ status: 400, body: { code: 'REJECT_CARD_COMPANY', message: 'x' } }]).confirm(C)).resolves.not.toHaveProperty('outage');
  });

  test('P-T43_조회의 5xx·연결 실패는 일시 장애이고 429·결제 없음은 아니다 [ASVS v5.0.0-16.5.2]', async () => {
    await expect(toss([{ status: 500 }]).query('key-1')).resolves.toEqual({ kind: 'UNKNOWN', outage: true });
    await expect(toss([new Error('끊김')]).query('key-1')).resolves.toEqual({ kind: 'UNKNOWN', outage: true });
    await expect(toss([{ status: 429 }]).query('key-1')).resolves.toEqual({ kind: 'UNKNOWN', throttled: true });
    await expect(toss([{ status: 404, body: { code: 'NOT_FOUND_PAYMENT' } }]).query('key-1')).resolves.toEqual({ kind: 'NOT_FOUND' });
    await expect(portone([{ status: 500 }]).query('pay-order-1')).resolves.toEqual({ kind: 'UNKNOWN', outage: true });
  });

  test('P-T43_리뷰 고침 M3: 취소의 5xx·연결 실패는 표시 없는 결과 모름이다(취소는 서킷 판정에 세지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    await expect(toss([{ status: 500 }]).cancel(CANCEL)).resolves.toEqual({ outcome: 'UNKNOWN' });
    await expect(toss([new Error('끊김')]).cancel(CANCEL)).resolves.toEqual({ outcome: 'UNKNOWN' });
    await expect(portone([{ status: 503 }]).cancel({ ...CANCEL, idemKey: 'cancel-12345678901234' })).resolves.toEqual({ outcome: 'UNKNOWN' });
  });
});

describe('P-T43: 서킷 판정(BreakerPgCircuit)', () => {
  const make = (openMs = 20) => {
    const clock = fakeClock({ now: NOW });
    const circuit = new BreakerPgCircuit('SIMULATOR', { service: 'payment-svc', clock, overrides: { minCalls: 3, failureRatePercent: 50, openMs } });
    return { clock, circuit };
  };

  test('P-T43_일시 장애가 문턱을 넘으면 열리고 답은 그대로 돌려주며, 열리면 부르지 않고 PgCircuitOpenError다 [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make();
    for (let i = 0; i < 3; i += 1) await expect(circuit.run(async () => 'outage', () => true, 'confirm')).resolves.toBe('outage');
    expect(circuit.state()).toBe('open');
    expect(circuit.admits()).toBe(false);
    let called = false;
    await expect(circuit.run(async () => ((called = true), 'x'), () => false, 'confirm')).rejects.toBeInstanceOf(PgCircuitOpenError);
    expect(called).toBe(false);
    circuit.shutdown();
  });

  test('P-T43_업무 거절·429처럼 일시 장애가 아닌 답은 세지 않아 열리지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make();
    for (let i = 0; i < 25; i += 1) await circuit.run(async () => 'declined', () => false, 'confirm');
    expect(circuit.state()).toBe('closed');
    circuit.shutdown();
  });

  test('P-T43_던진 호출(실행기 한도 초과 등)은 실패로 세고 오류는 그대로 다시 던진다 [ASVS v5.0.0-16.5.3]', async () => {
    const { circuit } = make();
    const boom = new Error('한도 초과');
    for (let i = 0; i < 3; i += 1)
      await expect(
        circuit.run(async () => {
          throw boom;
        }, () => false, 'confirm'),
      ).rejects.toBe(boom);
    expect(circuit.state()).toBe('open');
    circuit.shutdown();
  });

  test('P-T43_반 열림은 시험 호출 하나만 받고, 성공하면 닫힌다 [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make(10);
    for (let i = 0; i < 3; i += 1) await circuit.run(async () => 'outage', () => true, 'confirm');
    await expect.poll(() => circuit.state(), { timeout: 2_000, interval: 5 }).toBe('half_open');
    expect(circuit.admits()).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const trial = circuit.run(async () => {
      await gate;
      return 'ok';
    }, () => false, 'query');
    expect(circuit.admits()).toBe(false);
    await expect(circuit.run(async () => 'second', () => false, 'query')).rejects.toBeInstanceOf(PgCircuitOpenError);
    release();
    await trial;
    expect(circuit.state()).toBe('closed');
    expect(circuit.admits()).toBe(true);
    circuit.shutdown();
  });

  test('P-T43_리뷰 고침 H2: 시험 호출이 판정 한도를 넘겨 다시 열린 뒤 반 열림이 되면 앞 호출이 끝나지 않아도 다음 시험 호출을 받는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new BreakerPgCircuit('SIMULATOR', { service: 'payment-svc', clock: fakeClock({ now: NOW }), overrides: { minCalls: 3, failureRatePercent: 50, openMs: 10, trialTimeoutMs: 20 } });
    for (let i = 0; i < 3; i += 1) await circuit.run(async () => 'outage', () => true, 'confirm');
    await expect.poll(() => circuit.state(), { timeout: 2_000, interval: 5 }).toBe('half_open');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hanging = circuit.run(async () => {
      await gate;
      return 'late';
    }, () => false, 'query');
    expect(circuit.admits()).toBe(false);
    await expect.poll(() => circuit.admits(), { timeout: 2_000, interval: 5 }).toBe(true);
    expect(circuit.state()).toBe('half_open');
    release();
    await hanging;
    circuit.shutdown();
  });

  test('P-T43_리뷰 고침 M3: 닫힌 서킷의 조회 실패는 열림 판정에 세지 않는다(조회 실패가 승인을 막지 않게) [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make();
    for (let i = 0; i < 25; i += 1) await expect(circuit.run(async () => 'outage', () => true, 'query')).resolves.toBe('outage');
    expect(circuit.state()).toBe('closed');
    circuit.shutdown();
  });

  test('P-T43_리뷰 고침 M3: 조회 성공은 승인 실패를 희석하지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make();
    for (let i = 0; i < 10; i += 1) await circuit.run(async () => 'found', () => false, 'query');
    for (let i = 0; i < 3; i += 1) await circuit.run(async () => 'outage', () => true, 'confirm');
    expect(circuit.state()).toBe('open');
    circuit.shutdown();
  });

  test('P-T43_리뷰 고침 M3: 판정에 세지 않는 조회가 던진 오류는 그대로 돌려준다 [ASVS v5.0.0-16.5.3]', async () => {
    const { circuit } = make();
    const boom = new Error('한도 초과');
    await expect(
      circuit.run(async () => {
        throw boom;
      }, () => false, 'query'),
    ).rejects.toBe(boom);
    expect(circuit.state()).toBe('closed');
    circuit.shutdown();
  });

  test('P-T43_리뷰 고침 M4: 반 열림의 승인 호출은 부르지 않고 시험 호출 자리를 남긴다 [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make(10);
    for (let i = 0; i < 3; i += 1) await circuit.run(async () => 'outage', () => true, 'confirm');
    await expect.poll(() => circuit.state(), { timeout: 2_000, interval: 5 }).toBe('half_open');
    let called = false;
    await expect(circuit.run(async () => ((called = true), 'x'), () => false, 'confirm')).rejects.toBeInstanceOf(PgCircuitOpenError);
    expect(called).toBe(false);
    expect(circuit.state()).toBe('half_open');
    expect(circuit.admits()).toBe(true);
    circuit.shutdown();
  });

  test('P-T43_리뷰 고침 M4: 반 열림의 단독 조회가 실패하면 다시 열린다 [ASVS v5.0.0-16.5.2]', async () => {
    const { circuit } = make(50);
    for (let i = 0; i < 3; i += 1) await circuit.run(async () => 'outage', () => true, 'confirm');
    await expect.poll(() => circuit.state(), { timeout: 2_000, interval: 5 }).toBe('half_open');
    await expect(circuit.run(async () => 'outage', () => true, 'query')).resolves.toBe('outage');
    expect(circuit.state()).toBe('open');
    circuit.shutdown();
  });
});

describe('BreakerPgCircuits', () => {
  test('P-T43_채널마다 하나를 돌려주고 지표 payment_pg_circuit_open{pg}가 열림을 낸다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-13.2.6]', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const circuits = new BreakerPgCircuits({ service: 'payment-svc', registry: metrics.registry, clock: fakeClock({ now: NOW }), overrides: { minCalls: 3, failureRatePercent: 50, openMs: 60_000 } }).register(metrics.registry);
    expect(circuits.of('TOSS')).toBe(circuits.of('TOSS'));
    expect(circuits.of('TOSS')).not.toBe(circuits.of('PORTONE'));
    for (let i = 0; i < 3; i += 1) await circuits.of('TOSS').run(async () => 'x', () => true, 'confirm');
    const text = await metrics.registry.metrics();
    expect(text).toContain('payment_pg_circuit_open{pg="TOSS"} 1');
    expect(text).toContain('payment_pg_circuit_open{pg="PORTONE"} 0');
    circuits.shutdown();
  });
});

describe('P-T43: 보호기의 여유에 서킷을 넣는다', () => {
  const make = (circuit?: PgCircuit) => {
    const clock = fakeClock({ now: NOW });
    const guard = new PgCallGuard({ pg: 'SIMULATOR', callsPerSecond: 300, channelBulkhead: 32, podCount: 1, clock, signals: noSignals, log: noLog, ...(circuit === undefined ? {} : { circuit }) });
    return { clock, guard };
  };

  test('P-T43_열리면 여유 0이고 토큰·자리를 뺏지 않으며 포화로 세지 않는다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    const saturated: string[] = [];
    const clock = fakeClock({ now: NOW });
    const guard = new PgCallGuard({ pg: 'SIMULATOR', callsPerSecond: 300, channelBulkhead: 32, podCount: 1, clock, signals: { ...noSignals, saturated: (_p, r) => void saturated.push(r) }, log: noLog, circuit });
    const before = guard.available();
    expect(before).toBeGreaterThan(0);
    circuit.current = 'open';
    expect(guard.available()).toBe(0);
    expect(guard.reserve()).toBe(0);
    expect(guard.takeQueryTokens(10)).toBe(0);
    guard.noteBlocked();
    expect(saturated).toEqual([]);
    circuit.current = 'closed';
    expect(guard.available()).toBe(before);
  });

  test('P-T43_리뷰 고침 H1: 시험 호출로 행을 실제로 잡으면 1초 [가정]는 다음 틱이 또 잡지 않는다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const { clock, guard } = make(circuit);
    expect(guard.takeQueryTokens(5)).toBe(1);
    guard.noteTrialClaimed(1);
    expect(guard.takeQueryTokens(5)).toBe(0);
    clock.advance(999);
    expect(guard.takeQueryTokens(5)).toBe(0);
    clock.advance(1);
    expect(guard.takeQueryTokens(5)).toBe(1);
  });

  test('P-T43_리뷰 고침 H1: 잡을 행이 없어 돌려준 시험 호출은 막지 않아 다음 틱이 다시 잡는다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const { guard } = make(circuit);
    expect(guard.takeQueryTokens(5)).toBe(1);
    guard.refundTokens(1);
    guard.noteTrialClaimed(0);
    expect(guard.takeQueryTokens(5)).toBe(1);
  });

  test('P-T43_리뷰 고침 H1: 승인 틱의 잡기가 조회 틱의 시험 호출을 굶기지 않는다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const { guard } = make(circuit);
    guard.release(guard.reserve());
    expect(guard.takeQueryTokens(5)).toBe(1);
  });

  test('P-T43_리뷰 고침 M4: 반 열림에서 승인은 잡지 않고(여유 0) 단독 조회만 시험 호출을 잡는다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const { guard } = make(circuit);
    expect(guard.available()).toBe(0);
    expect(guard.reserve()).toBe(0);
    expect(guard.circuitClosed()).toBe(false);
    expect(guard.admitsQuery()).toBe(true);
    expect(guard.takeQueryTokens(5)).toBe(1);
  });

  test('P-T43_시험 호출을 받지 않는 반 열림은 조회도 여유 0이다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    circuit.trialLeft = false;
    const { guard } = make(circuit);
    expect(guard.available()).toBe(0);
    expect(guard.admitsQuery()).toBe(false);
    expect(guard.takeQueryTokens(5)).toBe(0);
  });

  test('P-T43_서킷이 없으면 닫힘과 같고 run은 그대로 부른다 [ASVS v5.0.0-16.5.3]', async () => {
    const { guard } = make();
    expect(guard.circuitClosed()).toBe(true);
    expect(guard.admitsQuery()).toBe(true);
    await expect(guard.run(async () => 7, () => true, 'confirm')).resolves.toBe(7);
  });

  test('P-T43_등록부는 채널의 서킷을 보호기에 넣는다 [ASVS v5.0.0-16.5.2]', () => {
    const circuit = new FakeCircuit();
    const guards = new PgCallGuards({ gateways: { of: () => gatewayStub() }, podCount: 1, clock: fakeClock({ now: NOW }), signals: noSignals, log: noLog, circuits: { of: () => circuit } });
    circuit.current = 'open';
    expect(guards.of('SIMULATOR')!.circuitClosed()).toBe(false);
  });

  test('P-T43_등록부는 채널마다 그 채널의 서킷을 넣어 한 채널이 열려도 다른 채널은 받는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-15.1.3]', () => {
    const toss = new FakeCircuit();
    const portone = new FakeCircuit();
    toss.current = 'open';
    const guards = new PgCallGuards({ gateways: { of: (pg: PgName) => gatewayStub(pg) }, podCount: 1, clock: fakeClock({ now: NOW }), signals: noSignals, log: noLog, circuits: { of: (pg: PgName) => (pg === 'TOSS' ? toss : portone) } });
    expect(guards.of('TOSS')!.circuitClosed()).toBe(false);
    expect(guards.of('PORTONE')!.circuitClosed()).toBe(true);
  });
});

const ORDER = 'b7a7a7a7-7a7a-47a7-87a7-7a7a7a7a7a7a';
const PAYMENT = 'c8c8c8c8-8c8c-48c8-88c8-8c8c8c8c8c8c';

const job = (over: Partial<ConfirmJob> = {}): ConfirmJob => ({ paymentId: PAYMENT, pg: 'SIMULATOR', attempts: 0, owner: 'pod-1', leaseUntilMs: NOW + 75_000, hadPreviousOwner: false, ...over });
const target = (over: Partial<ConfirmTarget> = {}): ConfirmTarget => ({
  paymentId: PAYMENT,
  orderId: ORDER,
  eventId: 'e1e1e1e1-1e1e-41e1-81e1-1e1e1e1e1e1e',
  attemptNo: 1,
  pg: 'SIMULATOR',
  paymentRef: 'ref',
  amount: 1_000,
  status: 'ACCEPTED',
  authenticatedAtMs: NOW - 5_000,
  confirmSent: false,
  acceptedAtMs: NOW - 2_000,
  ...over,
});

function runnerRig(circuit: FakeCircuit, confirmed: () => Promise<ConfirmResult>) {
  const clock = fakeClock({ now: NOW });
  const calls = { confirm: 0, mark: 0, hasDue: 0, finish: [] as ConfirmFinish[], rescheduled: [] as { nextAtMs: number; countRetry: boolean; queued?: boolean; clearSent?: boolean }[], claimed: [] as ConfirmJob[][], outcomes: [] as string[] };
  const resolved: [PgName, ConfirmPath, number][] = [];
  const gateway = { ...gatewayStub(), confirm: () => ((calls.confirm += 1), confirmed()) };
  const gateways = { of: () => gateway };
  const guards = new PgCallGuards({ gateways, podCount: 1, clock, signals: noSignals, log: noLog, bulkheads: { SIMULATOR: 32 }, circuits: { of: () => circuit } });
  let pending: ConfirmJob[] = [];
  const jobs = {
    claimDue: async () => {
      const got = pending;
      pending = [];
      calls.claimed.push(got);
      return got;
    },
    claimExpired: async () => [],
    hasDue: async () => ((calls.hasDue += 1), true),
    read: async () => target(),
    markSent: async (): Promise<'MARKED' | 'ALREADY'> => ((calls.mark += 1), 'MARKED'),
    finish: async (_t: ConfirmTarget, f: ConfirmFinish) => (calls.finish.push(f), 'APPLIED' as const),
    reschedule: async (_j: ConfirmJob, nextAtMs: number, o: { countRetry: boolean; queued?: boolean; clearSent?: boolean }) => (calls.rescheduled.push({ nextAtMs, ...o }), true),
    dropJob: async () => true,
    release: async () => true,
  };
  const runner = new PaymentConfirmRunner({
    jobs: jobs as never,
    gateways,
    guards,
    log: { amountMismatch: () => undefined, noAdapter: () => undefined, writeFailed: () => undefined, staleAnswer: () => undefined, runError: () => undefined, pgError: () => undefined },
    signals: { outcome: (_p, o) => void calls.outcomes.push(o), declined: () => undefined, callSeconds: () => undefined, inFlight: () => undefined, writeFailure: () => undefined },
    clock,
    podId: 'pod-1',
    timer: { setInterval: () => 0, clearInterval: () => undefined },
    resolution: { resolutionSeconds: (p, path, s) => void resolved.push([p, path, s]) },
  });
  return { clock, calls, resolved, guards, runner, setPending: (j: ConfirmJob[]) => (pending = j), jobs };
}

describe('P-T43: 승인 실행기와 서킷', () => {
  const answerOk = async (): Promise<ConfirmResult> => ({ outcome: 'APPROVED', paymentRef: 'ref', amount: 1_000, approvedAt: '2026-11-09T01:00:00.000Z' });

  test('P-T43_서킷이 열려 있으면 틱이 명령을 잡지 않고 결제사를 부르지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const f = runnerRig(circuit, answerOk);
    f.setPending([job()]);
    await f.runner.tick();
    await f.runner.whenIdle();
    expect(f.calls.claimed).toEqual([]);
    expect(f.calls.confirm).toBe(0);
  });

  test('P-T43_잡은 뒤 열린 것을 알면 부르지 않고 UNKNOWN도 쓰지 않으며 1초 뒤로 미룬다(attempts 안 오름, 토큰·자리 돌려줌) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const f = runnerRig(circuit, answerOk);
    const before = f.guards.of('SIMULATOR')!.limits();
    const outcome = await f.runner.runJob(job());

    expect(outcome).toEqual({ kind: 'RETRY', outcome: 'circuit_open', nextAtMs: NOW + PG_CIRCUIT_DEFER_MS });
    expect(f.calls.confirm).toBe(0);
    expect(f.calls.mark).toBe(0);
    expect(f.calls.finish).toEqual([]);
    expect(f.calls.rescheduled).toEqual([{ nextAtMs: NOW + PG_CIRCUIT_DEFER_MS, countRetry: false, queued: true }]);
    expect(f.calls.outcomes).toEqual(['circuit_open']);
    circuit.current = 'closed';
    expect(f.guards.of('SIMULATOR')!.limits()).toEqual(before);
    expect(f.guards.of('SIMULATOR')!.available()).toBe(32);
  });

  test('P-T43_이미 CONFIRM_SENT가 있는 재전송도 부르지 않고 미룬다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const f = runnerRig(circuit, answerOk);
    f.jobs.read = async () => target({ confirmSent: true });
    await expect(f.runner.runJob(job({ attempts: 2 }))).resolves.toMatchObject({ kind: 'RETRY', outcome: 'circuit_open' });
    expect(f.calls.mark).toBe(0);
    expect(f.calls.confirm).toBe(0);
    expect(f.calls.finish).toEqual([]);
  });

  test('P-T43_표시를 쓴 뒤 호출 직전 서킷이 끊으면 UNKNOWN을 쓰지 않고 미루며 부른 것으로 세지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    circuit.rejectNext = true;
    const f = runnerRig(circuit, answerOk);
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'RETRY', outcome: 'circuit_open' });
    expect(f.calls.mark).toBe(1);
    expect(f.calls.confirm).toBe(0);
    expect(f.calls.finish).toEqual([]);
    expect(f.calls.outcomes).toEqual(['circuit_open']);
  });

  test('P-T40_리뷰 고침 L7: 이번에 쓴 표시 뒤 서킷이 끊으면 미루면서 표시를 지운다(다음 호출이 재전송으로 잘못 판정되지 않게) [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    circuit.rejectNext = true;
    const f = runnerRig(circuit, answerOk);
    await f.runner.runJob(job());
    expect(f.calls.rescheduled).toEqual([{ nextAtMs: NOW + PG_CIRCUIT_DEFER_MS, countRetry: false, queued: true, clearSent: true }]);
  });

  test('P-T40_리뷰 고침 L7: 앞서 쓰인 표시(ALREADY)는 서킷이 끊어도 지우지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    circuit.rejectNext = true;
    const f = runnerRig(circuit, answerOk);
    f.jobs.read = async () => target({ confirmSent: true });
    f.jobs.markSent = async () => ((f.calls.mark += 1), 'ALREADY');
    await f.runner.runJob(job({ attempts: 1 }));
    expect(f.calls.rescheduled).toEqual([{ nextAtMs: NOW + PG_CIRCUIT_DEFER_MS, countRetry: false, queued: true }]);
  });

  test('P-T43_리뷰 고침 M4: 반 열림에서 승인 틱은 잡지 않고, 잡힌 행도 표시 없이 미룬다(고객 승인을 시험으로 내보내지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const f = runnerRig(circuit, answerOk);
    f.setPending([job()]);
    await f.runner.tick();
    await f.runner.whenIdle();
    expect(f.calls.claimed).toEqual([]);

    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'RETRY', outcome: 'circuit_open' });
    expect(f.calls.mark).toBe(0);
    expect(f.calls.confirm).toBe(0);
    expect(circuit.trialLeft).toBe(true);
  });

  test('P-T43_리뷰 고침 L8: 서킷이 닫혀 있지 않으면 승인 틱은 대기 행을 묻지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const f = runnerRig(circuit, answerOk);
    await f.runner.tick();
    await f.runner.whenIdle();
    expect(f.calls.hasDue).toBe(0);
  });

  test('P-T43_리뷰 고침 L8: 닫혀 있는데 상한에 막히면 대기 행을 묻는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const f = runnerRig(circuit, answerOk);
    f.guards.of('SIMULATOR')!.takeQueryTokens(1_000_000);
    await f.runner.tick();
    await f.runner.whenIdle();
    expect(f.calls.hasDue).toBe(1);
  });

  test('P-T43_호출 직전 서킷이 끊으면 쓰지 않은 토큰을 돌려준다(마지막 토큰으로 확인) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-2.4.1]', async () => {
    const circuit = new FakeCircuit();
    circuit.rejectNext = true;
    const f = runnerRig(circuit, answerOk);
    const guard = f.guards.of('SIMULATOR')!;
    guard.takeQueryTokens(1_000_000);
    guard.refundTokens(1);

    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'RETRY', outcome: 'circuit_open' });

    expect(guard.tryTakeToken()).toBe(true);
    expect(guard.tryTakeToken()).toBe(false);
  });

  test.each([
    ['업무 거절', { outcome: 'DECLINED', paymentRef: 'ref', failureCategory: 'CARD_DECLINED' }],
    ['429', { outcome: 'DECLINED', paymentRef: 'ref', failureCategory: 'THROTTLED' }],
  ] as [string, ConfirmResult][])('P-T43_승인 답이 %s이면 부르기는 하되 서킷의 실패로 세지 않는다 [ASVS v5.0.0-16.5.2]', async (_n, answer) => {
    const circuit = new FakeCircuit();
    const f = runnerRig(circuit, async () => answer);
    await f.runner.runJob(job());
    expect(circuit.calls).toBe(1);
    expect(circuit.outages).toBe(0);
  });

  test('P-T43_닫혀 있으면 서킷을 거쳐 부르고, 일시 장애 답은 세면서 UNKNOWN으로 쓴다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const f = runnerRig(circuit, async () => ({ outcome: 'UNKNOWN', paymentRef: 'ref', outage: true }));
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'unknown' });
    expect(circuit.calls).toBe(1);
    expect(circuit.outages).toBe(1);
  });

  test('P-T40_보강: 일시 장애 표시가 사건으로 새지 않고 finish는 그대로다 [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    const f = runnerRig(circuit, async () => ({ outcome: 'UNKNOWN', paymentRef: 'ref', outage: true }));
    await f.runner.runJob(job());
    expect(f.calls.finish[0]).toEqual({ status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 0 });
  });

  test('P-T43_경로 지표: 큐를 거치지 않은 승인은 direct, 미뤄진 적이 있으면 retry_queue다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const f = runnerRig(circuit, answerOk);
    await f.runner.runJob(job());
    await f.runner.runJob(job({ queued: true }));
    expect(f.resolved).toEqual([
      ['SIMULATOR', 'direct', 2],
      ['SIMULATOR', 'retry_queue', 2],
    ]);
  });

  test('P-T43_경로 지표: UNKNOWN으로 끝나면 아직 결과가 아니라 재지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const f = runnerRig(circuit, async () => ({ outcome: 'UNKNOWN', paymentRef: 'ref', outage: true }));
    await f.runner.runJob(job({ queued: true }));
    expect(f.resolved).toEqual([]);
  });
});

function resolverRig(circuit: FakeCircuit, queried: () => Promise<QueryResult>) {
  const clock = fakeClock({ now: NOW });
  const calls = { query: 0, hasDue: 0, refs: [] as string[], timeouts: [] as (number | undefined)[], rescheduled: [] as { nextAtMs: number; o: unknown }[], resolved: 0, outcomes: [] as string[] };
  const resolved: [PgName, ConfirmPath, number][] = [];
  const gateway = { ...gatewayStub(), query: (ref: string, o?: { timeoutMs?: number }) => ((calls.query += 1), calls.refs.push(ref), calls.timeouts.push(o?.timeoutMs), queried()) };
  // 어댑터는 시뮬레이터 채널 하나뿐이다(틱이 채널마다 같은 서킷을 시험하지 않게)
  const gateways = { of: (pg: PgName) => (pg === 'SIMULATOR' ? gateway : undefined) };
  const guards = new PgCallGuards({ gateways, podCount: 1, clock, signals: noSignals, log: noLog, circuits: { of: () => circuit } });
  let pending: UnknownQueryJob[] = [];
  const queries = {
    claimDueQueries: async (pg: PgName) => {
      if (pg !== 'SIMULATOR') return [];
      const got = pending;
      pending = [];
      return got;
    },
    hasDueQueries: async () => ((calls.hasDue += 1), true),
    rescheduleQuery: async (_j: UnknownQueryJob, nextAtMs: number, o: unknown) => (calls.rescheduled.push({ nextAtMs, o }), true),
    resolve: async () => ((calls.resolved += 1), 'APPLIED' as const),
    markAnomalyLogged: async () => false,
    markOverdueBatch: async () => [],
  };
  const resolver = new PaymentUnknownResolver({
    queries: queries as never,
    gateways,
    guards,
    log: { amountMismatch: () => undefined, orderMismatch: () => undefined, cancelledAtPg: () => undefined, lateDeposit: () => undefined, overdue: () => undefined, noAdapter: () => undefined, writeFailed: () => undefined, staleAnswer: () => undefined, depositReversed: () => undefined, reversalUnconfirmed: () => undefined, reversalOverdue: () => undefined, reversalNoTime: () => undefined, runError: () => undefined },
    signals: { outcome: (_p, o) => void calls.outcomes.push(o), overdue: () => undefined, inFlight: () => undefined, writeFailure: () => undefined },
    clock,
    timer: { setInterval: () => 0, clearInterval: () => undefined },
    resolution: { resolutionSeconds: (p, path, s) => void resolved.push([p, path, s]) },
  });
  return { clock, calls, resolved, guards, resolver, setPending: (j: UnknownQueryJob[]) => (pending = j) };
}

const queryJob = (over: Partial<UnknownQueryJob> = {}): UnknownQueryJob => ({
  paymentId: PAYMENT,
  orderId: ORDER,
  eventId: 'e1e1e1e1-1e1e-41e1-81e1-1e1e1e1e1e1e',
  attemptNo: 1,
  pg: 'SIMULATOR',
  paymentRef: 'ref',
  amount: 1_000,
  queryAttempts: 1,
  claimedNextQueryAtMs: NOW + 15_000,
  anomalyLogged: false,
  acceptedAtMs: NOW - 4_000,
  ...over,
});

describe('P-T43: UNKNOWN 조회와 서킷', () => {
  const approved = async (): Promise<QueryResult> => ({ kind: 'FOUND', paymentRef: 'ref', orderRef: ORDER, status: 'APPROVED', amount: 1_000, balanceAmount: 1_000, approvedAt: '2026-11-09T01:00:00.000Z' });

  test('P-T43_서킷이 열리면 조회를 건너뛰고 다음 조회 시각만 민다(잡을 때 올린 횟수 되돌림, 토큰 돌려줌) [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const f = resolverRig(circuit, approved);
    await expect(f.resolver.runJob(queryJob())).resolves.toEqual({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
    expect(f.calls.query).toBe(0);
    expect(f.calls.rescheduled).toEqual([{ nextAtMs: NOW + PG_CIRCUIT_DEFER_MS, o: { refundAttempt: true } }]);
    expect(f.calls.resolved).toBe(0);
    circuit.current = 'closed';
    expect(f.guards.of('SIMULATOR')!.tryTakeToken()).toBe(true);
  });

  test('P-T43_호출 직전 끊겨도 조회 실패로 세지 않고 다음 시각만 민다 [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    circuit.rejectNext = true;
    const f = resolverRig(circuit, approved);
    await expect(f.resolver.runJob(queryJob())).resolves.toEqual({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
    expect(f.calls.query).toBe(0);
    expect(f.calls.outcomes).toEqual([]);
    expect(f.calls.rescheduled).toEqual([{ nextAtMs: NOW + PG_CIRCUIT_DEFER_MS, o: { refundAttempt: true } }]);
  });

  test('P-T43_토큰이 없어도 열려 있으면 토큰을 찾지 않고 서킷 건너뜀으로 끝낸다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const f = resolverRig(circuit, approved);
    f.guards.of('SIMULATOR')!.takeQueryTokens(1_000_000);
    circuit.current = 'open';
    await expect(f.resolver.runJob(queryJob())).resolves.toEqual({ kind: 'SKIPPED', reason: 'CIRCUIT_OPEN' });
    expect(f.calls.query).toBe(0);
    expect(f.calls.rescheduled).toEqual([{ nextAtMs: NOW + PG_CIRCUIT_DEFER_MS, o: { refundAttempt: true } }]);
  });

  test.each([
    ['429', { kind: 'UNKNOWN', throttled: true }],
    ['표시 없는 UNKNOWN', { kind: 'UNKNOWN' }],
    ['결제 없음', { kind: 'NOT_FOUND' }],
  ] as [string, QueryResult][])('P-T43_조회 답이 %s이면 부르기는 하되 서킷의 실패로 세지 않는다 [ASVS v5.0.0-16.5.2]', async (_n, answer) => {
    const circuit = new FakeCircuit();
    const f = resolverRig(circuit, async () => answer);
    await f.resolver.runJob(queryJob());
    expect(circuit.calls).toBe(1);
    expect(circuit.outages).toBe(0);
  });

  test('P-T43_닫히면 조회가 서킷을 거치고 일시 장애를 센다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const f = resolverRig(circuit, async () => ({ kind: 'UNKNOWN', outage: true }));
    await f.resolver.runJob(queryJob());
    expect(circuit.calls).toBe(1);
    expect(circuit.outages).toBe(1);
  });

  test('P-T43_리뷰 고침 M5: UNKNOWN을 거쳐 해소된 건은 접수부터의 시간을 retry_queue로 잰다(다시 연 직후 재정지 방지, ADR-0105 결정 5·6) [ASVS v5.0.0-16.5.2]', async () => {
    const f = resolverRig(new FakeCircuit(), approved);
    await f.resolver.runJob(queryJob());
    expect(f.resolved).toEqual([['SIMULATOR', 'retry_queue', 4]]);
  });

  test('P-T43_리뷰 고침 M4: 조회할 UNKNOWN이 없으면 반 열림에서 없는 결제 조회로 시험한다(결제사 답 404가 성공) [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const f = resolverRig(circuit, async () => ({ kind: 'NOT_FOUND' }));
    await f.resolver.tick();
    await f.resolver.whenIdle();
    expect(f.calls.refs).toEqual([PG_CIRCUIT_PROBE_PAYMENT_REF]);
    expect(f.calls.timeouts).toEqual([PG_CIRCUIT_PROBE_TIMEOUT_MS]);
    expect(circuit.kinds).toEqual(['query']);
    expect(circuit.outages).toBe(0);
    expect(f.calls.rescheduled).toEqual([]);
    expect(f.calls.resolved).toBe(0);
    expect(f.calls.outcomes).toEqual([]);
  });

  test('P-T43_리뷰 고침 M4: 없는 결제 조회는 429도 시험 실패다(ADR-0105 결정 2) [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const f = resolverRig(circuit, async () => ({ kind: 'UNKNOWN', throttled: true }));
    await f.resolver.tick();
    await f.resolver.whenIdle();
    expect(circuit.outages).toBe(1);
  });

  test('P-T43_리뷰 고침 M4: 없는 결제 조회가 던져도 틱은 멈추지 않고 실패로 센다 [ASVS v5.0.0-16.5.3]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const f = resolverRig(circuit, async () => {
      throw new Error('끊김');
    });
    await expect(f.resolver.tick()).resolves.toEqual({ claimed: 0 });
    await f.resolver.whenIdle();
    expect(circuit.thrown).toBe(1);
  });

  test('P-T43_리뷰 고침 M4: 조회할 UNKNOWN이 있으면 그 조회가 시험 호출이고 없는 결제 조회는 보내지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const f = resolverRig(circuit, approved);
    f.setPending([queryJob()]);
    await f.resolver.tick();
    await f.resolver.whenIdle();
    expect(f.calls.refs).toEqual(['ref']);
    expect(f.calls.resolved).toBe(1);
  });

  test.each(['closed', 'open'] as PgCircuitState[])('P-T43_리뷰 고침 M4: 서킷이 %s이면 없는 결제 조회를 보내지 않는다 [ASVS v5.0.0-16.5.2]', async (state) => {
    const circuit = new FakeCircuit();
    circuit.current = state;
    const f = resolverRig(circuit, async () => ({ kind: 'NOT_FOUND' }));
    await f.resolver.tick();
    await f.resolver.whenIdle();
    expect(f.calls.query).toBe(0);
  });

  test('P-T43_리뷰 고침 L8: 서킷이 닫혀 있지 않으면 조회 틱은 대기 행을 묻지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const f = resolverRig(circuit, approved);
    await f.resolver.tick();
    await f.resolver.whenIdle();
    expect(f.calls.hasDue).toBe(0);
  });

  test('P-T43_경로 지표: 입금 대기를 푼 답은 승인 확정 소요가 아니라 재지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const f = resolverRig(new FakeCircuit(), approved);
    await f.resolver.runJob(queryJob({ deposit: { dueAtMs: NOW + 60_000 } }));
    expect(f.resolved).toEqual([]);
  });
});

describe('P-T43: 입금 전 취소와 서킷', () => {
  const setup = (circuit: FakeCircuit, query?: (clock: ReturnType<typeof fakeClock>) => Promise<QueryResult>) => {
    const calls = { cancel: 0, query: 0 };
    const clock = fakeClock({ now: NOW });
    const gateway = {
      ...gatewayStub(),
      cancel: async () => ((calls.cancel += 1), { outcome: 'CANCELLED' as const }),
      query: (): Promise<QueryResult> => {
        calls.query += 1;
        return query === undefined ? Promise.resolve({ kind: 'FOUND', paymentRef: 'ref', orderRef: ORDER, status: 'CANCELED', amount: 1_000, balanceAmount: 0 }) : query(clock);
      },
    };
    const uc = new CancelDepositPayment({
      store: {
        readCancelTarget: async () => ({ paymentId: PAYMENT, orderId: ORDER, eventId: 'e1e1e1e1-1e1e-41e1-81e1-1e1e1e1e1e1e', attemptNo: 1, pg: 'SIMULATOR', paymentRef: 'ref', amount: 1_000 }),
        readCancelStatus: async () => 'AWAITING_DEPOSIT',
        beginDepositCancel: async () => 'BEGUN',
        finishDepositCancel: async () => 'APPLIED',
      } as never,
      gateways: { of: () => gateway },
      guards: new PgCallGuards({ gateways: { of: () => gateway }, podCount: 1, clock, signals: noSignals, log: noLog, circuits: { of: () => circuit } }),
      signals: { cancel: () => undefined },
      clock,
    });
    return { uc, calls };
  };
  const input = { paymentId: PAYMENT, cancellationId: 'cancel1', reason: '고객 요청' };

  test('P-T43_서킷이 열리면 취소를 부르지 않고 결과 모름으로 답한다(부른 쪽이 같은 취소 ID로 다시 보낸다) [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'open';
    const { uc, calls } = setup(circuit);
    await expect(uc.execute(input)).resolves.toEqual({ result: 'UNKNOWN' });
    expect(calls.cancel).toBe(0);
    expect(calls.query).toBe(0);
  });

  test('P-T43_리뷰 고침 M4: 반 열림이면 취소를 시험 호출로 내보내지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    circuit.current = 'half_open';
    const { uc, calls } = setup(circuit);
    await expect(uc.execute(input)).resolves.toEqual({ result: 'UNKNOWN' });
    expect(calls.cancel).toBe(0);
    expect(circuit.trialLeft).toBe(true);
  });

  test('P-T43_리뷰 고침 M3: 닫혀 있으면 취소는 부르되 서킷에 세지 않고, 뒤따르는 조회만 서킷을 거친다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const { uc, calls } = setup(circuit);
    await uc.execute(input);
    expect(calls.cancel).toBe(1);
    expect(circuit.kinds).toEqual(['query']);
  });

  test('P-T43_리뷰 고침 M6: 부른 쪽의 남은 시간이 다해 끊긴 조회의 일시 장애 답은 서킷 실패로 세지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const { uc } = setup(circuit, async (clock) => {
      clock.advance(1_000);
      return { kind: 'UNKNOWN', outage: true };
    });
    await uc.execute(input, { remainingMs: 1_000 });
    expect(circuit.calls).toBe(1);
    expect(circuit.outages).toBe(0);
  });

  test('P-T43_리뷰 고침 M6: 부른 쪽의 남은 시간으로 끊긴 조회는 던지지 않고 일시 장애 표시 없는 결과 모름이다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const { uc } = setup(circuit, (clock) => {
      clock.advance(60);
      return new Promise<QueryResult>(() => undefined);
    });
    await expect(uc.execute(input, { remainingMs: 60 })).resolves.toEqual({ result: 'UNKNOWN' });
    expect(circuit.calls).toBe(1);
    expect(circuit.thrown).toBe(0);
    expect(circuit.outages).toBe(0);
  });

  test('P-T43_리뷰 고침 M6: 남은 시간이 넉넉한데 온 일시 장애는 그대로 서킷 실패다 [ASVS v5.0.0-16.5.2]', async () => {
    const circuit = new FakeCircuit();
    const { uc } = setup(circuit, async () => ({ kind: 'UNKNOWN', outage: true }));
    await uc.execute(input, { remainingMs: 5_000 });
    expect(circuit.outages).toBe(1);
  });
});

describe('P-T43: 경로 지표 어댑터', () => {
  test('P-T43_payment_confirm_resolution_seconds{pg, path}를 낸다 [ASVS v5.0.0-16.5.2]', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromPaymentResolutionSignals().register(metrics.registry);
    signals.resolutionSeconds('TOSS', 'retry_queue', 12);
    const text = await metrics.registry.metrics();
    expect(text).toContain('payment_confirm_resolution_seconds_count{pg="TOSS",path="retry_queue"} 1');
  });
});
