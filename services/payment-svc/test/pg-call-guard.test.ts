// 결제사 호출 보호(domain/pg-call-guard.ts PgCallGuard·PgCallGuards, adapters prom-pg-call-guard-signals·pg-call-guard-log·pg/pg-http, config loadPgCallGuardConfig).
// 정본: docs/features/payment.md §2 '결제사 호출 보호의 첫 구현'·§4.2 22번·P-T34·P-T40, docs/verification.md §4.1 '결제사 채널 호출 상한과 연결 수', BUILD_ORDER PRF-183, docs/security/asvs/payment.md.
// 실행기가 보호기를 쓰는 방식은 payment-confirm-runner.test.ts·payment-unknown-resolver.test.ts, 실제 시뮬레이터·PostgreSQL은 test-int/payment-call-guard.int.test.ts가 본다.
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { loadPgCallGuardConfig } from '../src/config.js';
import { createPgHttp } from '../src/modules/payment/adapters/pg/pg-http.js';
import { pgCallGuardLog } from '../src/modules/payment/adapters/pg-call-guard-log.js';
import { PromPgCallGuardSignals } from '../src/modules/payment/adapters/prom-pg-call-guard-signals.js';
import type { PaymentGatewayPort, PgName } from '../src/modules/payment/domain/payment-gateway.js';
import {
  PG_CHANNEL_BULKHEAD,
  PG_CONNECT_TIMEOUT_MS,
  PG_LIMIT_FLOOR_PERCENT,
  PG_LIMIT_KINDS,
  PG_LOWER_COOLDOWN_MS,
  PG_NAMES,
  PG_QUERY_TOKEN_SHARE_PERCENT,
  PG_SATURATION_REASONS,
  PG_TOKEN_BURST_MS,
  PgCallGuard,
  type PgCallGuardOptions,
  PgCallGuards,
  type PgLimitKind,
  type PgSaturationReason,
  perPodBulkhead,
  perPodRate,
} from '../src/modules/payment/domain/pg-call-guard.js';
import type { PaymentGateways, PgCallGuardLog, PgCallGuardSignals } from '../src/modules/payment/domain/ports.js';

class FakeSignals implements PgCallGuardSignals {
  readonly throttleds: [PgName, boolean][] = [];
  readonly limits: [PgName, PgLimitKind, number][] = [];
  readonly inflights: [PgName, number][] = [];
  readonly saturateds: [PgName, PgSaturationReason][] = [];
  throttled(pg: PgName, first: boolean): void {
    this.throttleds.push([pg, first]);
  }
  limit(pg: PgName, kind: PgLimitKind, value: number): void {
    this.limits.push([pg, kind, value]);
  }
  inflight(pg: PgName, count: number): void {
    this.inflights.push([pg, count]);
  }
  saturated(pg: PgName, reason: PgSaturationReason): void {
    this.saturateds.push([pg, reason]);
  }
}

class FakeLog implements PgCallGuardLog {
  readonly lines: { pg: PgName; rps: number; concurrency: number }[] = [];
  throttledFirst(e: { pg: PgName; rps: number; concurrency: number }): void {
    this.lines.push(e);
  }
}

function make(over: Partial<PgCallGuardOptions> = {}) {
  const clock = fakeClock();
  const signals = new FakeSignals();
  const log = new FakeLog();
  const g = new PgCallGuard({ pg: 'TOSS', callsPerSecond: 300, channelBulkhead: 600, podCount: 1, clock, signals, log, ...over });
  return { clock, signals, log, g };
}

/** 토큰을 모두 쓴다(쓴 수를 돌려준다). 끝나지 않는 일이 없게 반복에 상한을 둔다 */
function drain(g: PgCallGuard): number {
  let n = 0;
  while (n < 10_000 && g.tryTakeToken()) n += 1;
  return n;
}

describe('값과 나누기', () => {
  test('PRF183_정해 둔 값이 정본과 같다', () => {
    expect(PG_NAMES).toEqual(['TOSS', 'PORTONE', 'SIMULATOR']);
    expect(PG_CHANNEL_BULKHEAD).toEqual({ TOSS: 600, PORTONE: 100, SIMULATOR: 600 });
    expect(PG_LOWER_COOLDOWN_MS).toBe(5_000);
    expect(PG_CONNECT_TIMEOUT_MS).toBe(3_000);
    expect(PG_TOKEN_BURST_MS).toBe(200);
    expect(PG_QUERY_TOKEN_SHARE_PERCENT).toBe(10);
    expect(PG_LIMIT_FLOOR_PERCENT).toBe(25);
    expect(PG_SATURATION_REASONS).toEqual(['token', 'bulkhead']);
    expect(PG_LIMIT_KINDS).toEqual(['rps', 'concurrency']);
  });

  test.each([
    [300, 12, 25],
    [300, 1, 300],
    [1, 4, 0.25],
  ])('P-T34_초당 상한 %d ÷ 파드 %d = 파드당 %d이고 올리지 않는다(올리면 파드 합이 결제사 상한을 넘는다) [ASVS v5.0.0-2.3.2]', (rps, pods, want) => {
    expect(perPodRate(rps, pods)).toBe(want);
  });

  test.each([
    [600, 12, 50],
    [100, 12, 9],
    [600, 7, 86],
    [1, 5, 1],
  ])('P-T40_벌크헤드 %d ÷ 파드 %d는 올림해 %d다(최소 1) [ASVS v5.0.0-13.2.6]', (limit, pods, want) => {
    expect(perPodBulkhead(limit, pods)).toBe(want);
  });

  test.each([
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [300, 0],
    [300, 1.5],
    [300, -2],
  ])('PRF183_perPodRate(%d, %d)는 RangeError다', (rps, pods) => {
    expect(() => perPodRate(rps, pods)).toThrow(RangeError);
  });

  test.each([
    [0, 1],
    [1.5, 1],
    [100, 0],
    [100, 2.5],
  ])('PRF183_perPodBulkhead(%d, %d)는 RangeError다', (limit, pods) => {
    expect(() => perPodBulkhead(limit, pods)).toThrow(RangeError);
  });
});

describe('토큰 버킷', () => {
  test('P-T34_처음에는 200ms치가 있고 파드 수로 나눈 값이다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.4.1]', () => {
    const { g } = make({ callsPerSecond: 300, podCount: 12 });
    expect(g.limits()).toEqual({ rps: 25, concurrency: 50 });
    expect(drain(g)).toBe(5);
  });

  test('P-T34_초당 상한만큼 다시 찬다 [ASVS v5.0.0-2.3.2]', () => {
    const { g, clock } = make({ callsPerSecond: 100 });
    drain(g);
    clock.advance(10);
    expect(drain(g)).toBe(1);
    clock.advance(100);
    expect(drain(g)).toBe(10);
  });

  test('P-T34_묶음은 200ms치를 넘게 쌓이지 않는다 [ASVS v5.0.0-2.4.1]', () => {
    const { g, clock } = make({ callsPerSecond: 100 });
    drain(g);
    clock.advance(10_000);
    expect(drain(g)).toBe(20);
  });

  test('P-T34_묶음이 작아도 토큰은 하나까지 모인다(나눈 속도로 찬다)', () => {
    const { g, clock } = make({ callsPerSecond: 2, podCount: 8 });
    expect(g.limits().rps).toBe(0.25);
    expect(g.tryTakeToken()).toBe(true);
    expect(g.tryTakeToken()).toBe(false);
    clock.advance(3_199);
    expect(g.tryTakeToken()).toBe(false);
    clock.advance(2);
    expect(g.tryTakeToken()).toBe(true);
  });

  test('P-T34_토큰이 없으면 false이고 까닭 token을 센다 [ASVS v5.0.0-2.4.1]', () => {
    const { g, signals } = make({ callsPerSecond: 1 });
    expect(g.tryTakeToken()).toBe(true);
    expect(g.tryTakeToken()).toBe(false);
    expect(signals.saturateds).toEqual([['TOSS', 'token']]);
  });

  test('P-T40_토큰은 벌크헤드 자리를 쓰지 않는다(단독 조회는 동시 승인 호출을 차지하지 않는다)', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 2 });
    drain(g);
    expect(g.limits().concurrency).toBe(2);
    g.holdOne();
    g.release();
  });
});

describe('벌크헤드와 여유', () => {
  test('P-T40_빈자리만큼 쥐고 다 쥐면 0이며 까닭 bulkhead를 센다 [ASVS v5.0.0-13.2.6] [ASVS v5.0.0-15.1.3]', () => {
    const { g, signals } = make({ callsPerSecond: 100, channelBulkhead: 4 });
    expect(g.reserve()).toBe(4);
    expect(g.available()).toBe(0);
    expect(g.reserve()).toBe(0);
    g.noteBlocked();
    expect(signals.saturateds).toEqual([['TOSS', 'bulkhead']]);
  });

  test('P-T40_놓은 만큼만 다시 쥔다', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 4 });
    g.reserve();
    g.release(3);
    expect(g.reserve()).toBe(3);
  });

  test('P-T40_여유는 min(벌크헤드 빈자리, 승인이 쓸 수 있는 토큰 수)다 [ASVS v5.0.0-15.1.3]', () => {
    const tokensFewer = make({ callsPerSecond: 50, channelBulkhead: 100 });
    expect(tokensFewer.g.available()).toBe(9);
    const slotsFewer = make({ callsPerSecond: 100, channelBulkhead: 3 });
    expect(slotsFewer.g.available()).toBe(3);
  });

  test('P-T40_토큰이 없어 막히면 까닭이 token이다', () => {
    const { g, signals } = make({ callsPerSecond: 1, channelBulkhead: 10 });
    drain(g);
    signals.saturateds.length = 0;
    expect(g.reserve()).toBe(0);
    g.noteBlocked();
    expect(signals.saturateds).toEqual([['TOSS', 'token']]);
  });

  test('P-T40_이미 잡은 행은 상한을 넘겨도 쥔다(holdOne), 놓기 전까지 여유는 0이다', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 1 });
    g.holdOne();
    g.holdOne();
    expect(g.available()).toBe(0);
    g.release();
    expect(g.available()).toBe(0);
    g.release();
    expect(g.available()).toBe(1);
  });

  test('PRF183_더 놓아도 쥔 수가 음수가 되지 않는다', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 2 });
    g.release(5);
    expect(g.available()).toBe(2);
  });

  test('P-T40_돌고 있는 호출 수를 지표로 둔다', () => {
    const { g, signals } = make();
    g.callStarted();
    g.callStarted();
    g.callFinished();
    expect(signals.inflights).toEqual([
      ['TOSS', 1],
      ['TOSS', 2],
      ['TOSS', 1],
    ]);
  });
});

describe('상한 낮추기(첫 호출 429)', () => {
  test('P-T34_첫 승인 호출의 429는 초당 상한과 벌크헤드를 절반으로 낮추고 SEV2 로그 한 줄과 지표를 낸다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-16.3.4]', () => {
    const { g, signals, log } = make({ callsPerSecond: 300, channelBulkhead: 600 });
    expect(g.noteThrottled({ first: true })).toBe(true);
    expect(g.limits()).toEqual({ rps: 150, concurrency: 300 });
    expect(signals.throttleds).toEqual([['TOSS', true]]);
    expect(log.lines).toEqual([{ pg: 'TOSS', rps: 150, concurrency: 300 }]);
    expect(signals.limits.slice(-2).sort()).toEqual(
      [
        ['TOSS', 'concurrency', 300],
        ['TOSS', 'rps', 150],
      ].sort(),
    );
  });

  test('P-T40_다시 보낸 호출과 단독 조회의 429는 상한을 낮추지 않고 지표만 센다(first false) [ASVS v5.0.0-2.3.2]', () => {
    const { g, signals, log } = make({ callsPerSecond: 300, channelBulkhead: 600 });
    expect(g.noteThrottled({ first: false })).toBe(false);
    expect(g.limits()).toEqual({ rps: 300, concurrency: 600 });
    expect(signals.throttleds).toEqual([['TOSS', false]]);
    expect(log.lines).toEqual([]);
  });

  test('P-T34_한 번 낮춘 뒤 5초 안의 429는 다시 낮추지 않고 지표만 센다(5초가 지나면 다시 낮춘다)', () => {
    const { g, clock, signals, log } = make({ callsPerSecond: 300, channelBulkhead: 600 });
    expect(g.noteThrottled({ first: true })).toBe(true);
    clock.advance(4_999);
    expect(g.noteThrottled({ first: true })).toBe(false);
    expect(g.limits().rps).toBe(150);
    expect(log.lines).toHaveLength(1);
    expect(signals.throttleds).toHaveLength(2);
    clock.advance(1);
    expect(g.noteThrottled({ first: true })).toBe(true);
    expect(g.limits()).toEqual({ rps: 75, concurrency: 150 });
  });

  test('P-T34_상한은 1 아래로 내려가지 않는다', () => {
    const { g, clock } = make({ callsPerSecond: 2, channelBulkhead: 2 });
    g.noteThrottled({ first: true });
    expect(g.limits()).toEqual({ rps: 1, concurrency: 1 });
    clock.advance(5_000);
    g.noteThrottled({ first: true });
    expect(g.limits()).toEqual({ rps: 1, concurrency: 1 });
  });

  test('P-T34_벌크헤드가 홀수이면 절반을 내림한다(올리면 절반보다 많이 보낸다) [ASVS v5.0.0-2.3.2]', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 5 });
    g.noteThrottled({ first: true });
    expect(g.limits().concurrency).toBe(2);
  });

  test('P-T34_나눠서 이미 1보다 작은 초당 상한을 1로 올리지 않는다', () => {
    const { g } = make({ callsPerSecond: 1, podCount: 4 });
    g.noteThrottled({ first: true });
    expect(g.limits().rps).toBe(0.25);
  });

  test('P-T34_낮추면 남은 토큰도 새 묶음 크기로 줄어든다 [ASVS v5.0.0-2.4.1]', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 200 });
    g.noteThrottled({ first: true });
    expect(g.available()).toBe(9);
  });

  test('P-T34_낮춘 뒤에는 그 속도로만 찬다', () => {
    const { g, clock } = make({ callsPerSecond: 100, channelBulkhead: 200 });
    g.noteThrottled({ first: true });
    drain(g);
    clock.advance(100);
    expect(drain(g)).toBe(5);
  });

  test('P-T40_돌고 있는 호출이 새 상한보다 많으면 줄어들 때까지 여유가 없다 [ASVS v5.0.0-13.2.6]', () => {
    const { g } = make({ callsPerSecond: 100, channelBulkhead: 10 });
    expect(g.reserve()).toBe(10);
    g.noteThrottled({ first: true });
    expect(g.limits().concurrency).toBe(5);
    expect(g.available()).toBe(0);
    g.release(5);
    expect(g.available()).toBe(0);
    g.release(1);
    expect(g.available()).toBe(1);
  });

  test('PRF183_만들 때 두 상한을 지표로 낸다', () => {
    const { signals } = make({ callsPerSecond: 300, channelBulkhead: 600, podCount: 12 });
    expect(signals.limits.slice().sort()).toEqual(
      [
        ['TOSS', 'concurrency', 50],
        ['TOSS', 'rps', 25],
      ].sort(),
    );
  });

  test('PRF183_지표·로그가 던져도 보호기는 던지지 않는다 [ASVS v5.0.0-16.5.2]', () => {
    const boom = (): never => {
      throw new Error('지표 실패');
    };
    const signals: PgCallGuardSignals = { throttled: boom, limit: boom, inflight: boom, saturated: boom };
    const { g } = make({ signals, log: { throttledFirst: boom }, callsPerSecond: 1 });
    expect(g.noteThrottled({ first: true })).toBe(true);
    g.callStarted();
    g.callFinished();
    g.tryTakeToken();
    expect(g.tryTakeToken()).toBe(false);
    expect(g.reserve()).toBe(0);
  });
});

describe('PgCallGuards', () => {
  const caps = (callsPerSecond: number) => ({ serverConfirm: true, confirmDeadlineMs: 600_000, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 1, callsPerSecond, redirectCheckout: false });
  const adapter = (pg: PgName, callsPerSecond = 300): PaymentGatewayPort => ({ pg, capabilities: () => caps(callsPerSecond) }) as unknown as PaymentGatewayPort;
  const build = (gateways: PaymentGateways, o: { podCount?: number; bulkheads?: Partial<Record<PgName, number>> } = {}) =>
    new PgCallGuards({ gateways, podCount: o.podCount ?? 1, clock: fakeClock(), signals: new FakeSignals(), log: new FakeLog(), ...(o.bulkheads === undefined ? {} : { bulkheads: o.bulkheads }) });

  test('PRF183_어댑터가 없으면 undefined다', () => {
    expect(build({ of: () => undefined }).of('TOSS')).toBeUndefined();
  });

  test('P-T34_채널마다 하나이고 같은 것을 돌려준다(승인과 조회가 같은 버킷을 쓴다) [ASVS v5.0.0-2.3.2]', () => {
    const toss = adapter('TOSS');
    const portone = adapter('PORTONE', 50);
    const guards = build({ of: (pg) => (pg === 'TOSS' ? toss : pg === 'PORTONE' ? portone : undefined) });
    expect(guards.of('TOSS')).toBe(guards.of('TOSS'));
    expect(guards.of('TOSS')).not.toBe(guards.of('PORTONE'));
    expect(guards.of('TOSS')!.pg).toBe('TOSS');
  });

  test.each([
    ['TOSS', 300, 1, { rps: 300, concurrency: 600 }],
    ['PORTONE', 50, 1, { rps: 50, concurrency: 100 }],
    ['SIMULATOR', 300, 1, { rps: 300, concurrency: 600 }],
    ['TOSS', 300, 12, { rps: 25, concurrency: 50 }],
  ] as const)('P-T40_%s 채널의 상한은 callsPerSecond %d·파드 %d에서 나온다 [ASVS v5.0.0-13.2.6]', (pg, rps, pods, want) => {
    const guards = build({ of: (p) => (p === pg ? adapter(pg, rps) : undefined) }, { podCount: pods });
    expect(guards.of(pg)!.limits()).toEqual(want);
  });

  test('PRF183_시험용 벌크헤드로 바꿀 수 있다', () => {
    const guards = build({ of: () => adapter('TOSS') }, { bulkheads: { TOSS: 3 } });
    expect(guards.of('TOSS')!.limits().concurrency).toBe(3);
  });

  test.each([0, -1, 1.5, Number.NaN])('PRF183_벌크헤드 %d는 RangeError다', (bulkhead) => {
    const guards = build({ of: () => adapter('TOSS') }, { bulkheads: { TOSS: bulkhead } });
    expect(() => guards.of('TOSS')).toThrow(RangeError);
  });

  test('PRF183_capabilities가 던지면 그대로 던지고 다음에 다시 만든다(실패를 캐시하지 않는다) [ASVS v5.0.0-16.5.2]', () => {
    let fail = true;
    const flaky = {
      pg: 'TOSS',
      capabilities: () => {
        if (fail) throw new Error('어댑터 결함');
        return caps(300);
      },
    } as unknown as PaymentGatewayPort;
    const guards = build({ of: () => flaky });
    expect(() => guards.of('TOSS')).toThrow('어댑터 결함');
    fail = false;
    expect(guards.of('TOSS')).toBeInstanceOf(PgCallGuard);
  });
});

describe('PromPgCallGuardSignals', () => {
  const values = async (signals: PromPgCallGuardSignals): Promise<string> => {
    const metrics = new PlatformMetrics('payment-svc');
    signals.register(metrics.registry);
    return metrics.registry.metrics();
  };

  test('P-T34_처음 일어나기 전에도 모든 이름표가 0으로 보인다 [ASVS v5.0.0-16.3.4]', async () => {
    const text = await values(new PromPgCallGuardSignals());
    for (const pg of PG_NAMES) {
      for (const first of ['true', 'false']) expect(text).toContain(`pg_throttled_total{pg="${pg}",first="${first}"} 0`);
      for (const reason of PG_SATURATION_REASONS) expect(text).toContain(`payment_pg_saturated_total{pg="${pg}",reason="${reason}"} 0`);
    }
  });

  test('P-T34_지표 넷이 이름표대로 오른다', async () => {
    const s = new PromPgCallGuardSignals();
    s.throttled('TOSS', true);
    s.throttled('TOSS', false);
    s.throttled('TOSS', false);
    s.limit('TOSS', 'rps', 150);
    s.limit('TOSS', 'concurrency', 300);
    s.inflight('TOSS', 7);
    s.saturated('TOSS', 'bulkhead');
    const text = await values(s);
    expect(text).toContain('pg_throttled_total{pg="TOSS",first="true"} 1');
    expect(text).toContain('pg_throttled_total{pg="TOSS",first="false"} 2');
    expect(text).toContain('payment_pg_limit{pg="TOSS",kind="rps"} 150');
    expect(text).toContain('payment_pg_limit{pg="TOSS",kind="concurrency"} 300');
    expect(text).toContain('payment_pg_inflight{pg="TOSS"} 7');
    expect(text).toContain('payment_pg_saturated_total{pg="TOSS",reason="bulkhead"} 1');
  });
});

describe('pgCallGuardLog', () => {
  test('P-T34_SEV2 줄(kind pg-throttled-first)에 결제사와 낮춘 뒤 상한만 싣는다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.3.4]', () => {
    const error = vi.fn();
    pgCallGuardLog({ error } as never).throttledFirst({ pg: 'TOSS', rps: 150, concurrency: 300 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toEqual({ kind: 'pg-throttled-first', severity: 'SEV2', pg: 'TOSS', rps: 150, concurrency: 300 });
    expect(typeof error.mock.calls[0]![1]).toBe('string');
  });

  test('PRF183_로거가 던져도 삼킨다 [ASVS v5.0.0-16.5.2]', () => {
    const error = vi.fn(() => {
      throw new Error('로거 실패');
    });
    expect(() => pgCallGuardLog({ error } as never).throttledFirst({ pg: 'TOSS', rps: 1, concurrency: 1 })).not.toThrow();
  });
});

describe('loadPgCallGuardConfig', () => {
  test.each(['local', 'ci'])('PRF183_PEAKET_ENV=%s에서 비어 있으면 파드 1개다', (env) => {
    expect(loadPgCallGuardConfig({ PEAKET_ENV: env })).toEqual({ podCount: 1 });
  });

  test.each([
    ['12', 12],
    ['1', 1],
    [' 6 ', 6],
  ])('PRF183_PEAKET_PAYMENT_POD_COUNT=%j는 %d개다', (raw, want) => {
    expect(loadPgCallGuardConfig({ PEAKET_ENV: 'prod', PEAKET_PAYMENT_POD_COUNT: raw })).toEqual({ podCount: want });
  });

  test.each(['', '   '])('PRF183_빈 값 %j는 없는 것으로 본다(local이면 파드 1개)', (raw) => {
    expect(loadPgCallGuardConfig({ PEAKET_ENV: 'local', PEAKET_PAYMENT_POD_COUNT: raw })).toEqual({ podCount: 1 });
  });

  test.each(['0', '-1', '1.5', 'abc', '2x', '1e3', '99999999999999999'])('PRF183_PEAKET_PAYMENT_POD_COUNT=%j이면 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (raw) => {
    expect(() => loadPgCallGuardConfig({ PEAKET_PAYMENT_POD_COUNT: raw })).toThrow(/PEAKET_PAYMENT_POD_COUNT/);
  });
});

describe('createPgHttp', () => {
  /** 요청마다 ms만큼 늦게 답하는 서버. 열린 연결 수를 센다 */
  async function slowServer(ms: number) {
    let connections = 0;
    const sockets = new Set<Socket>();
    const server = createHttpServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, ms);
    });
    server.on('connection', (s) => {
      connections += 1;
      sockets.add(s);
      s.once('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      connections: () => connections,
      close: async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  /** 받기만 하고 답하지 않는 TCP 서버(TLS 인사가 끝나지 않아 연결이 맺어지지 않는다). 닿지 않는 주소를 네트워크 환경과 상관없이 만든다 */
  async function silentServer() {
    const sockets = new Set<Socket>();
    const server = createTcpServer((s) => {
      sockets.add(s);
      s.on('error', () => undefined);
      s.once('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      close: async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  test('P-T40_열린 연결 수가 상한을 넘지 않고 넘는 요청은 차례를 기다린다 [ASVS v5.0.0-13.2.6]', async () => {
    const s = await slowServer(30);
    const pg = createPgHttp({ connections: 2 });
    try {
      const replies = await Promise.all(Array.from({ length: 6 }, () => pg.fetch(s.url).then((r) => r.text())));
      expect(replies).toEqual(Array.from({ length: 6 }, () => 'ok'));
      expect(s.connections()).toBe(2);
    } finally {
      await pg.close();
      await s.close();
    }
  });

  test('P-T40_연결을 다시 쓴다(keep-alive) [ASVS v5.0.0-13.2.6]', async () => {
    const s = await slowServer(0);
    const pg = createPgHttp({ connections: 4 });
    try {
      await (await pg.fetch(s.url)).text();
      // 답을 다 읽은 직후에는 연결이 아직 비었다고 표시되지 않아 잠깐 기다린다
      await new Promise((r) => setTimeout(r, 20));
      await (await pg.fetch(s.url)).text();
      expect(s.connections()).toBe(1);
    } finally {
      await pg.close();
      await s.close();
    }
  });

  test('P-T40_연결 시간 초과를 넘기면 UND_ERR_CONNECT_TIMEOUT으로 끝난다 [ASVS v5.0.0-13.2.6] [ASVS v5.0.0-16.5.2]', async () => {
    const s = await silentServer();
    const pg = createPgHttp({ connections: 1, connectTimeoutMs: 150 });
    try {
      const started = performance.now();
      const err = (await pg.fetch(s.url).catch((e: unknown) => e)) as { cause?: { code?: string } };
      expect(err.cause?.code).toBe('UND_ERR_CONNECT_TIMEOUT');
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await pg.close();
      await s.close();
    }
  });

  test('P-T40_연결 시간 초과의 기본값은 3초다 [ASVS v5.0.0-13.2.6]', async () => {
    const s = await silentServer();
    const pg = createPgHttp({ connections: 1 });
    try {
      const started = performance.now();
      const err = (await pg.fetch(s.url).catch((e: unknown) => e)) as { cause?: { code?: string } };
      const took = performance.now() - started;
      expect(err.cause?.code).toBe('UND_ERR_CONNECT_TIMEOUT');
      expect(took).toBeGreaterThanOrEqual(2_500);
      expect(took).toBeLessThan(8_000);
    } finally {
      await pg.close();
      await s.close();
    }
  }, 15_000);

  test('P-T40_요청의 시간 초과(signal)를 그대로 따른다', async () => {
    const s = await slowServer(1_000);
    const pg = createPgHttp({ connections: 1 });
    try {
      await expect(pg.fetch(s.url, { signal: AbortSignal.timeout(50) })).rejects.toBeDefined();
    } finally {
      await pg.close();
      await s.close();
    }
  });

  test.each([0, -1, 1.5, Number.NaN])('PRF183_connections %d는 RangeError다', (connections) => {
    expect(() => createPgHttp({ connections })).toThrow(RangeError);
  });
});

describe('리뷰 고침(BUILD_ORDER PRF-183, 코드 리뷰)', () => {
  describe('H2: 파드 수', () => {
    test.each(['demo', 'staging', 'prod', undefined])('P-T40_리뷰 고침 H2: PEAKET_ENV=%s에서 파드 수가 비어 있으면 시작하지 않는다(1로 두면 결제사 상한을 파드 수 배로 넘긴다) [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-2.3.2]', (env) => {
      expect(() => loadPgCallGuardConfig(env === undefined ? {} : { PEAKET_ENV: env })).toThrow(/PEAKET_PAYMENT_POD_COUNT/);
      expect(() => loadPgCallGuardConfig({ ...(env === undefined ? {} : { PEAKET_ENV: env }), PEAKET_PAYMENT_POD_COUNT: '   ' })).toThrow(/PEAKET_PAYMENT_POD_COUNT/);
    });

    test.each(['1001', '100000'])('P-T40_리뷰 고침 H2: PEAKET_PAYMENT_POD_COUNT=%s는 범위 1~1000 밖이라 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (raw) => {
      expect(() => loadPgCallGuardConfig({ PEAKET_ENV: 'prod', PEAKET_PAYMENT_POD_COUNT: raw })).toThrow(/PEAKET_PAYMENT_POD_COUNT/);
    });

    test('P-T40_리뷰 고침 H2: 범위의 끝 1000은 받는다', () => {
      expect(loadPgCallGuardConfig({ PEAKET_ENV: 'prod', PEAKET_PAYMENT_POD_COUNT: '1000' })).toEqual({ podCount: 1000 });
    });
  });

  describe('H3: 묶음과 낮추기', () => {
    test('P-T34_리뷰 고침 H3: 묶음은 200ms치라 오래 쉬었다가도 1초 창의 호출이 초당 상한의 1.2배를 넘지 않는다 [ASVS v5.0.0-2.4.1]', () => {
      const { g, clock } = make({ callsPerSecond: 100, channelBulkhead: 200 });
      clock.advance(10_000);
      let sent = drain(g);
      expect(sent).toBe(20);
      for (let i = 0; i < 100; i += 1) {
        clock.advance(10);
        sent += drain(g);
      }
      expect(sent).toBeLessThanOrEqual(120);
    });

    test('P-T34_리뷰 고침 H3: 낮추기 하한은 처음 상한의 25%다(절반씩 낮춰도 그 아래로 가지 않는다) [ASVS v5.0.0-2.3.2]', () => {
      const { g, clock } = make({ callsPerSecond: 300, channelBulkhead: 600 });
      for (let i = 0; i < 6; i += 1) {
        g.noteThrottled({ first: true });
        clock.advance(PG_LOWER_COOLDOWN_MS);
      }
      expect(g.limits()).toEqual({ rps: 75, concurrency: 150 });
    });

    test('P-T34_리뷰 고침 H3: 낮추기 전에 보낸 호출의 429는 쿨다운이 지나도 다시 낮추지 않는다(낮춘 뒤에 보낸 호출의 429만 낮춘다) [ASVS v5.0.0-2.3.2]', () => {
      const { g, clock, log, signals } = make({ callsPerSecond: 300, channelBulkhead: 600 });
      const sentBefore = clock.monotonicMs();
      clock.advance(100);
      expect(g.noteThrottled({ first: true })).toBe(true);
      clock.advance(PG_LOWER_COOLDOWN_MS);

      expect(g.noteThrottled({ first: true, startedAtMs: sentBefore })).toBe(false);
      expect(g.limits()).toEqual({ rps: 150, concurrency: 300 });
      expect(log.lines).toHaveLength(1);
      expect(signals.throttleds).toHaveLength(2);

      expect(g.noteThrottled({ first: true, startedAtMs: clock.monotonicMs() })).toBe(true);
      expect(g.limits()).toEqual({ rps: 75, concurrency: 150 });
    });

    test('P-T34_리뷰 고침 낮음: 이미 하한이면 SEV2 로그와 상한 지표를 내지 않는다(429 수는 센다) [ASVS v5.0.0-16.3.4]', () => {
      const { g, clock, log, signals } = make({ callsPerSecond: 300, channelBulkhead: 600 });
      g.noteThrottled({ first: true });
      clock.advance(PG_LOWER_COOLDOWN_MS);
      g.noteThrottled({ first: true });
      clock.advance(PG_LOWER_COOLDOWN_MS);
      const published = signals.limits.length;

      expect(g.noteThrottled({ first: true })).toBe(false);

      expect(log.lines).toHaveLength(2);
      expect(signals.limits).toHaveLength(published);
      expect(signals.throttleds).toHaveLength(3);
    });
  });

  describe('M6: 토큰 예약', () => {
    test('P-T40_리뷰 고침 M6: 쥐기는 잡는 수만큼 토큰을 미리 빼고, 돌려주면 다시 쓴다 [ASVS v5.0.0-2.4.1]', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200 });
      expect(g.reserve()).toBe(18);
      expect(g.available()).toBe(0);
      g.release(18);
      g.refundTokens(18);
      expect(g.available()).toBe(18);
    });

    test('P-T40_리뷰 고침 M6: 돌려준 토큰은 묶음 크기를 넘지 않는다', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200 });
      g.refundTokens(1_000);
      expect(drain(g)).toBe(20);
    });

    test('P-T40_리뷰 고침 M6: 승인은 버킷의 마지막 10%를 쓰지 못하고, 조회는 그 몫까지 쓴다 [ASVS v5.0.0-2.4.1]', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200 });
      expect(g.available()).toBe(18);
      expect(g.reserve()).toBe(18);
      expect(g.available()).toBe(0);
      expect(g.takeQueryTokens(10)).toBe(2);
      expect(g.takeQueryTokens(10)).toBe(0);
    });

    test('P-T40_리뷰 고침 M6: 조회는 달라는 수까지만 토큰을 뺀다', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200 });
      expect(g.takeQueryTokens(3)).toBe(3);
      expect(drain(g)).toBe(17);
    });

    test.each([
      [1, 1],
      [4, 1],
      [10, 1],
      [25, 4],
    ])('P-T40_리뷰 고침 M6: 초당 상한이 %d인 작은 채널에서도 승인이 토큰을 얻는다(%d건)', (rps, want) => {
      const { g } = make({ callsPerSecond: rps, channelBulkhead: 100 });
      expect(g.available()).toBe(want);
    });

    test('P-T40_리뷰 고침 M6: 여유가 0이어도 쥐기는 까닭을 세지 않고, 부르는 쪽이 대기 행을 확인한 뒤 센다 [ASVS v5.0.0-16.3.4]', () => {
      const { g, signals } = make({ callsPerSecond: 100, channelBulkhead: 2 });
      expect(g.reserve()).toBe(2);
      expect(g.reserve()).toBe(0);
      expect(signals.saturateds).toEqual([]);
      g.noteBlocked();
      expect(signals.saturateds).toEqual([['TOSS', 'bulkhead']]);
      g.noteBlocked('token');
      expect(signals.saturateds.at(-1)).toEqual(['TOSS', 'token']);
    });
  });

  describe('승인 호출 비용(BUILD_ORDER HOT-140 코드 리뷰 M6)', () => {
    test('P-T16_리뷰 고침 M6: 비용이 2면 승인이 잡을 수 있는 수는 토큰 수의 절반이다 [ASVS v5.0.0-2.3.2]', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200, confirmCallCost: 2 });
      expect(g.available()).toBe(9);
    });

    test('P-T16_리뷰 고침 M6: 쥐기는 잡는 수의 두 배로 토큰을 빼고, 돌려주기는 비용만큼 돌려준다 [ASVS v5.0.0-2.3.2]', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200, confirmCallCost: 2 });
      expect(g.reserve()).toBe(9);
      expect(g.available()).toBe(0);
      g.release(4);
      g.refundConfirmTokens(4);
      expect(g.available()).toBe(4);
    });

    test('P-T16_리뷰 고침 M6: 바로 돌리는 행은 비용만큼 토큰을 쓰고, 모자라면 쓰지 않는다 [ASVS v5.0.0-2.3.2]', () => {
      const { g } = make({ callsPerSecond: 15, channelBulkhead: 200, confirmCallCost: 2 });
      expect(g.tryTakeConfirmTokens()).toBe(true);
      expect(g.tryTakeToken()).toBe(true);
      expect(g.tryTakeConfirmTokens()).toBe(false);
      expect(g.tryTakeToken()).toBe(false);
    });

    test('P-T16_리뷰 고침 M6: 단독 조회는 비용과 상관없이 하나씩 쓴다 [ASVS v5.0.0-2.3.2]', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200, confirmCallCost: 2 });
      expect(g.takeQueryTokens(3)).toBe(3);
      expect(drain(g)).toBe(17);
    });

    test.each([
      [1, 4],
      [4, 12],
      [50, 12],
    ])('P-T16_리뷰 고침 M6: 비용이 2여도 작은 채널(초당 %d, 파드 %d)에서 승인이 굶지 않는다 [ASVS v5.0.0-2.3.2]', (rps, podCount) => {
      const { g } = make({ callsPerSecond: rps, channelBulkhead: 100, podCount, confirmCallCost: 2 });
      expect(g.available()).toBeGreaterThanOrEqual(1);
    });

    test('P-T16_리뷰 고침 M6: 비용을 주지 않으면 1이다(토스·시뮬레이터 동작 불변)', () => {
      const { g } = make({ callsPerSecond: 100, channelBulkhead: 200 });
      expect(g.available()).toBe(18);
      expect(g.tryTakeConfirmTokens()).toBe(true);
      expect(g.available()).toBe(17);
    });

    test.each([0, -1, 1.5, Number.NaN])('P-T16_리뷰 고침 M6: 비용이 %d이면 만들지 않는다 [ASVS v5.0.0-2.2.1]', (confirmCallCost) => {
      expect(() => make({ confirmCallCost })).toThrow(RangeError);
    });

    test('P-T16_리뷰 고침 M6: 등록부는 어댑터 능력의 비용을 보호기에 넘긴다 [ASVS v5.0.0-2.3.2]', () => {
      const gateway = { pg: 'PORTONE', capabilities: () => ({ serverConfirm: true, confirmDeadlineMs: 1, partialCancel: true, webhookSignature: true, idempotencyRetentionMs: 1, callsPerSecond: 100, redirectCheckout: true, confirmCallCost: 2 }) } as unknown as PaymentGatewayPort;
      const guards = new PgCallGuards({ gateways: { of: () => gateway }, podCount: 1, clock: fakeClock(), signals: new FakeSignals(), log: new FakeLog(), bulkheads: { PORTONE: 200 } });
      expect(guards.of('PORTONE')!.available()).toBe(9);
    });
  });

  test('P-T34_리뷰 고침 낮음: payment_pg_inflight를 채널별 0으로 미리 낸다 [ASVS v5.0.0-16.3.4]', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    new PromPgCallGuardSignals().register(metrics.registry);
    const text = await metrics.registry.metrics();
    for (const pg of PG_NAMES) expect(text).toContain(`payment_pg_inflight{pg="${pg}"} 0`);
  });
});
