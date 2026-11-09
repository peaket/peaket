// 서비스 안 2차 차단기(ADR-0009 결정 2·5, docs/features/bot-defense.md §11의 수치, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 1~5).
// 열림 → 반 열림은 opossum 타이머라 가짜 타이머로, 창(10초)은 주입한 시계로 민다.
import { Writable } from 'node:stream';
import { Registry } from '@prometheus-io/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CIRCUIT_BREAKER_DEFAULTS,
  Deadline,
  ProblemError,
  createCircuitBreaker,
  createPlatformLogger,
  fakeClock,
  isBreakerFailure,
  runInRequestContext,
  type CircuitBreaker,
  type FakeClock,
  type RequestContext,
} from '../src/index.js';

const made: CircuitBreaker[] = [];
let clock: FakeClock;
let registry: Registry;
let logLines: Record<string, unknown>[];

beforeEach(() => {
  vi.useFakeTimers();
  clock = fakeClock();
  registry = new Registry();
  logLines = [];
});
afterEach(() => {
  while (made.length) made.pop()!.shutdown();
  vi.useRealTimers();
});

function breaker(extra: Partial<Parameters<typeof createCircuitBreaker>[0]> = {}) {
  const destination = new Writable({
    write(chunk, _e, cb) {
      for (const l of String(chunk).split('\n')) if (l) logLines.push(JSON.parse(l) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'cb-svc', env: 'ci', version: 't', clock, level: 'info', destination });
  const b = createCircuitBreaker({ service: 'cb-svc', dependency: 'trust-svc', registry, logger, clock, ...extra });
  made.push(b);
  return b;
}

describe('acceptsCalls: 지금 run이 의존성을 부를 수 있는가', () => {
  const failed = async (b: CircuitBreaker) => {
    for (let i = 0; i < CIRCUIT_BREAKER_DEFAULTS.minCalls; i += 1) await expect(b.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
  };

  test('P-T43_리뷰 고침 H2: 닫힘은 참, 열림은 거짓이고 반 열림은 시험 호출이 나가기 전까지만 참이다', async () => {
    const b = breaker();
    expect(b.acceptsCalls).toBe(true);
    await failed(b);
    expect(b.state).toBe('open');
    expect(b.acceptsCalls).toBe(false);
    await vi.advanceTimersByTimeAsync(CIRCUIT_BREAKER_DEFAULTS.openMs);
    expect(b.state).toBe('half_open');
    expect(b.acceptsCalls).toBe(true);
    let release!: (v: string) => void;
    const trial = b.run(() => new Promise<string>((r) => (release = r)));
    expect(b.acceptsCalls).toBe(false);
    release('ok');
    await trial;
    expect(b.state).toBe('closed');
    expect(b.acceptsCalls).toBe(true);
  });

  test('P-T43_리뷰 고침 H2: 시험 호출이 판정 한도를 넘겨 다시 열린 뒤 반 열림이 되면 앞 호출이 끝나지 않아도 참이다', async () => {
    const b = breaker();
    await failed(b);
    await vi.advanceTimersByTimeAsync(CIRCUIT_BREAKER_DEFAULTS.openMs);
    let release!: (v: string) => void;
    const hanging = b.run(() => new Promise<string>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(CIRCUIT_BREAKER_DEFAULTS.trialTimeoutMs);
    expect(b.state).toBe('open');
    expect(b.acceptsCalls).toBe(false);
    await vi.advanceTimersByTimeAsync(CIRCUIT_BREAKER_DEFAULTS.openMs);
    expect(b.state).toBe('half_open');
    expect(b.acceptsCalls).toBe(true);
    release('late');
    await hanging;
  });

  test('P-T43_리뷰 고침 H2: 끈 뒤에는 거짓이다', () => {
    const b = breaker();
    b.shutdown();
    expect(b.acceptsCalls).toBe(false);
  });
});

const ok = () => Promise.resolve('ok');
const down = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:50051'), { code: 'ECONNREFUSED' }));
const grpcError = (code: number) => Object.assign(new Error(`${code} grpc`), { code, details: 'x', metadata: {} });

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

async function metric(name: string, labels: Record<string, string>): Promise<number | undefined> {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name);
  const v = m?.values.find((x) => Object.entries(labels).every(([k, val]) => x.labels[k] === val));
  return v?.value;
}

/** n번 부르고 뒤의 fail번은 실패(끝난 호출마다 문턱을 보므로 순서는 판정 때만 바꾼다. 실패를 뒤에 두어 n건째에 처음 판정하게 한다) */
async function calls(b: CircuitBreaker, n: number, fail: number, failure: () => Promise<string> = down) {
  for (let i = 0; i < n; i += 1) await settle(b.run(i >= n - fail ? failure : ok));
}

describe('열림 판정(ADR-0009 결정 2)', () => {
  test('FND100_기본값은_10초창_20건_50퍼센트_5초다', () => {
    expect(CIRCUIT_BREAKER_DEFAULTS).toMatchObject({ windowMs: 10_000, minCalls: 20, failureRatePercent: 50, openMs: 5_000 });
  });

  test('[ASVS v5.0.0-16.5.2] FND100_20건중_절반이_실패하면_열리고_의존성을부르지않고_503과RetryAfter다', async () => {
    const b = breaker();
    await calls(b, 20, 10);
    expect(b.state).toBe('open');
    const action = vi.fn(ok);
    const r = await settle(b.run(action));
    expect(action).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    const e = (r as { error: ProblemError }).error;
    expect(e).toBeInstanceOf(ProblemError);
    expect(e).toMatchObject({ slug: 'dependency-unavailable', status: 503, retryAfterSeconds: 5 });
    // 본문에 의존성 이름을 싣지 않는다
    expect(JSON.stringify(e.extensions)).not.toContain('trust');
    expect(await metric('circuit_breaker_state', { service: 'cb-svc', dependency: 'trust-svc' })).toBe(2);
    expect(await metric('circuit_breaker_rejected_total', { dependency: 'trust-svc', reason: 'open' })).toBe(1);
  });

  test('FND100_19건이면_모두실패해도_열리지않는다', async () => {
    const b = breaker();
    await calls(b, 19, 19);
    expect(b.state).toBe('closed');
  });

  test('FND100_실패가_50퍼센트에못미치면_열리지않는다', async () => {
    const b = breaker();
    await calls(b, 20, 9);
    expect(b.state).toBe('closed');
  });

  test('FND100_업무거절은_실패로세지않는다(4xx_Problem과_gRPC업무코드)', async () => {
    const b = breaker();
    const notFound = () => Promise.reject(new ProblemError({ type: 'hold-not-found', status: 404, title: '없음' }));
    const grpcNotFound = () => Promise.reject(grpcError(5));
    await calls(b, 15, 15, notFound);
    await calls(b, 15, 15, grpcNotFound);
    expect(b.state).toBe('closed');
  });

  test('FND100_실패분류_서버오류_시간초과_연결실패는_실패고_업무거절은아니다', () => {
    for (const code of [2, 4, 8, 13, 14, 15]) expect(isBreakerFailure(grpcError(code))).toBe(true);
    for (const code of [1, 3, 5, 6, 7, 9, 10, 11, 12, 16]) expect(isBreakerFailure(grpcError(code))).toBe(false);
    expect(isBreakerFailure(new ProblemError({ type: 'server-busy', status: 429, title: 'x' }))).toBe(true);
    expect(isBreakerFailure(new ProblemError({ type: 'upstream', status: 502, title: 'x' }))).toBe(true);
    expect(isBreakerFailure(new ProblemError({ type: 'not-mine', status: 409, title: 'x' }))).toBe(false);
    expect(isBreakerFailure(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isBreakerFailure(new Error('socket hang up'))).toBe(true);
  });

  test('FND100_서비스가_실패분류를_바꿀수있다', async () => {
    const b = breaker({ isFailure: () => false });
    await calls(b, 25, 25);
    expect(b.state).toBe('closed');
  });

  test('FND100_10초가지난_실패는_세지않는다(주입한시계)', async () => {
    const b = breaker();
    await calls(b, 15, 15);
    clock.advance(10_000);
    // 앞의 15건은 창 밖이다. 새로 10건 중 5건 실패면 20건 미만이라 열리지 않는다
    await calls(b, 10, 5);
    expect(b.state).toBe('closed');
  });
});

describe('반 열림과 닫힘', () => {
  test('[ASVS v5.0.0-16.5.2] FND100_5초뒤_시험호출하나만보내고_그동안다른호출은503이며_성공하면닫힌다', async () => {
    const b = breaker();
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    expect(b.state).toBe('half_open');
    expect(await metric('circuit_breaker_state', { dependency: 'trust-svc' })).toBe(1);

    let release!: (v: string) => void;
    const trial = vi.fn(() => new Promise<string>((r) => (release = r)));
    const first = b.run(trial);
    const other = vi.fn(ok);
    const second = await settle(b.run(other));
    expect(other).not.toHaveBeenCalled();
    expect((second as { error: ProblemError }).error).toMatchObject({ slug: 'dependency-unavailable', retryAfterSeconds: 1 });
    release('ok');
    await expect(first).resolves.toBe('ok');
    expect(trial).toHaveBeenCalledOnce();
    expect(b.state).toBe('closed');
    expect(await metric('circuit_breaker_state', { dependency: 'trust-svc' })).toBe(0);
  });

  test('[ASVS v5.0.0-16.5.3] P-T43_리뷰고침_close는_열린차단기를_시험호출없이닫고_창을비운다_닫혀있거나_끈뒤에는_아무것도하지않는다', async () => {
    const b = breaker();
    b.close();
    expect(b.state).toBe('closed');
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
    b.close();
    expect(b.state).toBe('closed');
    expect(await metric('circuit_breaker_state', { dependency: 'trust-svc' })).toBe(0);
    await expect(b.run(ok)).resolves.toBeDefined();
    await calls(b, 1, 1);
    expect(b.state).toBe('closed');
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
    b.shutdown();
    b.close();
    expect(b.acceptsCalls).toBe(false);
  });

  test('FND100_닫힌뒤에는_창을비워_실패한번에_다시열리지않는다', async () => {
    const b = breaker();
    await calls(b, 20, 20);
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    await b.run(ok);
    expect(b.state).toBe('closed');
    await settle(b.run(down));
    expect(b.state).toBe('closed');
  });

  test('FND100_시험호출이실패하면_다시열리고_5초를다시기다린다', async () => {
    const b = breaker();
    await calls(b, 20, 20);
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    await settle(b.run(down));
    expect(b.state).toBe('open');
    clock.advance(4_000);
    vi.advanceTimersByTime(4_000);
    expect(b.state).toBe('open');
    const r = await settle(b.run(ok));
    expect((r as { error: ProblemError }).error.retryAfterSeconds).toBe(1);
    clock.advance(1_000);
    vi.advanceTimersByTime(1_000);
    expect(b.state).toBe('half_open');
  });

  test('FND100_상태가바뀌면_서비스로그에_의존성과상태만남긴다', async () => {
    const b = breaker();
    await calls(b, 20, 20);
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    await b.run(ok);
    const states = logLines.filter((l) => l.kind === 'breaker').map((l) => l.state);
    expect(states).toEqual(['open', 'half_open', 'closed']);
    expect(JSON.stringify(logLines)).not.toContain('10.0.0.1');
  });
});

describe('벌크헤드와 남은 시간', () => {
  test('[ASVS v5.0.0-15.2.2] FND100_동시호출상한을넘으면_부르지않고_429이며_차단기실패로세지않는다', async () => {
    const b = breaker({ maxConcurrent: 2 });
    const gates: Array<() => void> = [];
    const slow = () => new Promise<string>((r) => gates.push(() => r('ok')));
    const a1 = b.run(slow);
    const a2 = b.run(slow);
    const third = vi.fn(ok);
    for (let i = 0; i < 25; i += 1) {
      const r = await settle(b.run(third));
      expect((r as { error: ProblemError }).error).toMatchObject({ slug: 'server-busy', status: 429 });
    }
    expect(third).not.toHaveBeenCalled();
    expect(b.state).toBe('closed');
    expect(await metric('circuit_breaker_rejected_total', { dependency: 'trust-svc', reason: 'bulkhead' })).toBe(25);
    for (const g of gates) g();
    await Promise.all([a1, a2]);
    expect(b.inFlight).toBe(0);
    await expect(b.run(ok)).resolves.toBe('ok');
  });

  test('FND100_남은시간이0이면_부르지않고_504이며_차단기실패로세지않는다', async () => {
    const b = breaker();
    const deadline = Deadline.after(10, clock);
    clock.advance(10);
    const ctx = { traceId: '0'.repeat(32), deadline, route: '/x', method: 'GET', log: { dependency() {} } } as unknown as RequestContext;
    const action = vi.fn(ok);
    for (let i = 0; i < 25; i += 1) {
      const r = await runInRequestContext(ctx, () => settle(b.run(action)));
      expect((r as { error: ProblemError }).error).toMatchObject({ slug: 'deadline-exceeded', status: 504 });
    }
    expect(action).not.toHaveBeenCalled();
    expect(b.state).toBe('closed');
  });

  test('FND100_의존성이름은_소문자이름이어야하고_지표저장소가같아도_차단기여럿을만든다', () => {
    expect(() => breaker({ dependency: 'Trust Svc' })).toThrow(/dependency/);
    breaker({ dependency: 'toss' });
    breaker({ dependency: 'portone' });
  });
});

describe('코드 리뷰 2026-11-01(시험 호출 하나·10초 창)', () => {
  /** 밖에서 끝내는 호출 */
  function pending() {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { action: () => p, resolve, reject };
  }
  const openThenHalfOpen = async (b: CircuitBreaker) => {
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    expect(b.state).toBe('half_open');
  };

  test('FND100_리뷰_시험호출이끝나지않으면_시험한도5초뒤다시열리고_다음시험으로닫힌다', async () => {
    const b = breaker();
    expect(CIRCUIT_BREAKER_DEFAULTS.trialTimeoutMs).toBe(5_000);
    await openThenHalfOpen(b);
    const hung = pending();
    const trial = b.run(hung.action);
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.state).toBe('open');
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.state).toBe('half_open');
    await expect(b.run(ok)).resolves.toBe('ok');
    expect(b.state).toBe('closed');
    // 늦게 끝난 시험 호출의 부른 쪽은 진짜 결과를 받고, 상태는 바뀌지 않는다
    hung.reject(new Error('late'));
    await expect(trial).rejects.toThrow('late');
    expect(b.state).toBe('closed');
  });

  test('FND100_리뷰_열리기전부터진행중이던호출의_실패는_반열림을다시열지않는다', async () => {
    const b = breaker();
    const slow = pending();
    const before = b.run(slow.action);
    await openThenHalfOpen(b);
    slow.reject(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:50051'), { code: 'ECONNREFUSED' }));
    await expect(before).rejects.toThrow(/ECONNREFUSED/);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.state).toBe('half_open');
    await expect(b.run(ok)).resolves.toBe('ok');
    expect(b.state).toBe('closed');
  });

  test('FND100_리뷰_열리기전부터진행중이던호출의_성공은_시험호출없이닫지않는다', async () => {
    const b = breaker();
    const slow = pending();
    const before = b.run(slow.action);
    await openThenHalfOpen(b);
    slow.resolve('late-ok');
    await expect(before).resolves.toBe('late-ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.state).toBe('half_open');
  });

  test('FND100_리뷰_호출이끝날때창을밀어_10초지난호출로판정하지않는다', async () => {
    const b = breaker();
    await calls(b, 19, 9);
    expect(b.state).toBe('closed');
    clock.advance(9_500);
    const slow = pending();
    const late = b.run(slow.action);
    clock.advance(1_500);
    slow.reject(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:50051'), { code: 'ECONNREFUSED' }));
    await expect(late).rejects.toThrow(/ECONNREFUSED/);
    // 지난 10초 안의 호출은 이 하나뿐이다
    expect(b.state).toBe('closed');
  });
});

describe('다시 본 코드 리뷰 2026-11-01(가장자리)', () => {
  test('FND100_리뷰2_실패분류함수가던져도_부른쪽은진짜오류를받고_실패로세며_자리를돌려준다', async () => {
    const b = breaker({ maxConcurrent: 1, isFailure: (e) => (e as { code: string }).code === 'X' });
    const real = new Error('real');
    for (let i = 0; i < 20; i += 1) {
      await expect(b.run(() => Promise.reject(undefined))).rejects.toBeUndefined();
    }
    expect(b.inFlight).toBe(0);
    expect(b.state).toBe('open');
    const c = breaker({ dependency: 'sync-svc', isFailure: () => { throw new TypeError('classifier'); } });
    await expect(c.run(() => { throw real; })).rejects.toBe(real);
    expect(c.inFlight).toBe(0);
  });

  test('FND100_리뷰2_정수설정은_양의정수만받는다', () => {
    for (const k of ['windowMs', 'buckets', 'minCalls', 'openMs', 'trialTimeoutMs', 'maxConcurrent'] as const) {
      expect(() => breaker({ dependency: 'cfg-svc', [k]: 0.5 })).toThrow(k);
    }
    expect(() => breaker({ dependency: 'cfg-svc', failureRatePercent: 150 })).toThrow(/failureRatePercent/);
  });

  test('FND100_리뷰2_열린상태에서_한꺼번에낸호출은_모두503이고_벌크헤드로세지않는다', async () => {
    const b = breaker({ maxConcurrent: 5 });
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
    const results = await Promise.all(Array.from({ length: 10 }, () => settle(b.run(ok))));
    expect(results.map((r) => (r as { error: ProblemError }).error.status)).toEqual(Array(10).fill(503));
    expect(await metric('circuit_breaker_rejected_total', { dependency: 'trust-svc', reason: 'bulkhead' })).toBeUndefined();
  });

  test('FND100_리뷰2_끈뒤에부르면_503_dependency_unavailable이다', async () => {
    const b = breaker();
    b.shutdown();
    const r = await settle(b.run(ok));
    expect((r as { error: ProblemError }).error).toMatchObject({ slug: 'dependency-unavailable', status: 503 });
  });
});

describe('세 번째 코드 리뷰 2026-11-01(순서·끄기)', () => {
  function pending() {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { action: vi.fn(() => p), resolve, reject };
  }
  const toHalfOpen = async () => {
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
  };

  test('FND100_리뷰3_반열림에서시험호출이도는동안_다른호출은_상한이차도429가아니라503이다', async () => {
    const b = breaker({ maxConcurrent: 1 });
    await calls(b, 20, 20);
    await toHalfOpen();
    const hung = pending();
    const trial = b.run(hung.action);
    const r = await settle(b.run(ok));
    expect((r as { error: ProblemError }).error.status).toBe(503);
    expect(await metric('circuit_breaker_rejected_total', { dependency: 'trust-svc', reason: 'bulkhead' })).toBeUndefined();
    hung.resolve('ok');
    await trial;
  });

  test('FND100_리뷰3_멈춘호출이자리를다잡아도_열린동안은503이고_시험호출하나는보낸다', async () => {
    const b = breaker({ maxConcurrent: 2 });
    const stuck = pending();
    void b.run(stuck.action).catch(() => {});
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
    await toHalfOpen();
    const stuckTrial = pending();
    void b.run(stuckTrial.action).catch(() => {});
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.state).toBe('open');
    expect(b.inFlight).toBe(2);
    expect(((await settle(b.run(ok))) as { error: ProblemError }).error.status).toBe(503);
    await toHalfOpen();
    await expect(b.run(ok)).resolves.toBe('ok');
    expect(b.state).toBe('closed');
  });

  test('FND100_리뷰3_끈뒤에남은호출이실패해도_의존성을부르지않는다', async () => {
    const b = breaker();
    await calls(b, 20, 20);
    await toHalfOpen();
    const hung = pending();
    void b.run(hung.action).catch(() => {});
    b.shutdown();
    clock.advance(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const after = vi.fn(ok);
    const r = await settle(b.run(after));
    expect(after).not.toHaveBeenCalled();
    expect((r as { error: ProblemError }).error).toMatchObject({ slug: 'dependency-unavailable', status: 503 });

    const c = breaker({ dependency: 'drain-svc' });
    await calls(c, 15, 10);
    const slow = Array.from({ length: 5 }, () => pending());
    for (const s of slow) void c.run(s.action).catch(() => {});
    c.shutdown();
    slow[0]!.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await vi.advanceTimersByTimeAsync(0);
    const later = vi.fn(ok);
    await settle(c.run(later));
    expect(later).not.toHaveBeenCalled();
  });

  test('FND100_리뷰3_의존성오류의code가_EOPENBREAKER여도_그대로돌려준다', async () => {
    const b = breaker();
    const foreign = Object.assign(new Error('downstream breaker'), { code: 'EOPENBREAKER' });
    await expect(b.run(() => Promise.reject(foreign))).rejects.toBe(foreign);
  });
});

describe('네 번째 코드 리뷰 2026-11-01(판정 창·상한)', () => {
  function pending() {
    let resolve!: (v: string) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { action: vi.fn(() => p), resolve, reject };
  }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  test('FND100_리뷰4_끝난시각으로센다_10초넘게전에끝난실패는세지않는다', async () => {
    const b = breaker();
    const slow = Array.from({ length: 10 }, () => pending());
    const runs = slow.map((s) => b.run(s.action).catch(() => 'failed'));
    clock.advance(3_000);
    for (const s of slow) s.reject(refused());
    await Promise.all(runs);
    clock.advance(11_000);
    await calls(b, 20, 1);
    expect(b.state).toBe('closed');
  });

  test('FND100_리뷰4_끝난시각으로센다_시작이창밖이어도창안에서끝난실패는센다', async () => {
    const b = breaker();
    const slow = Array.from({ length: 10 }, () => pending());
    const runs = slow.map((s) => b.run(s.action).catch(() => 'failed'));
    clock.advance(9_900);
    for (const s of slow) s.reject(refused());
    await Promise.all(runs);
    clock.advance(600);
    await calls(b, 10, 0);
    // 지난 10초 안에 끝난 호출 20건 가운데 실패 10건(50%)
    expect(b.state).toBe('open');
  });

  test('FND100_리뷰4_아직끝나지않은호출은_분모에넣지않는다', async () => {
    const b = breaker();
    const stuck = Array.from({ length: 30 }, () => pending());
    for (const s of stuck) void b.run(s.action).catch(() => {});
    await calls(b, 20, 20);
    expect(b.state).toBe('open');
  });

  test('FND100_리뷰4_시험호출의상한예외는_상한더하기1까지다', async () => {
    const b = breaker({ maxConcurrent: 2 });
    void b.run(pending().action).catch(() => {});
    await calls(b, 20, 20);
    let max = b.inFlight;
    const statuses: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      clock.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(b.state).toBe('half_open');
      const r = b.run(pending().action).then(
        () => 0,
        (e: ProblemError) => e.status ?? -1,
      );
      max = Math.max(max, b.inFlight);
      clock.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      if (b.state === 'half_open') statuses.push(await r);
    }
    expect(max).toBeLessThanOrEqual(3);
    expect(statuses).toContain(429);
  });

  test('FND100_리뷰4_의존성이바로던진오류의code가_opossum것과같아도_그대로돌려준다', async () => {
    const b = breaker();
    for (const code of ['EOPENBREAKER', 'ESHUTDOWN']) {
      const e = Object.assign(new Error(code), { code });
      await expect(
        b.run(() => {
          throw e;
        }),
      ).rejects.toBe(e);
    }
  });
});

describe('다섯 번째 코드 리뷰 2026-11-01(메모리·타이머 한도)', () => {
  test('FND100_리뷰5_opossum의_지연값배열이_창보다커지지않는다', async () => {
    const b = breaker();
    for (let sec = 0; sec < 15; sec += 1) {
      for (let i = 0; i < 1000; i += 1) await b.run(ok);
      clock.advance(1_000);
    }
    const impl = (b as unknown as Record<symbol, { status: { window: Array<{ latencyTimes: number[] }> } }>)[Symbol.for('peaket.breaker.implForTest')]!;
    const kept = impl.status.window.reduce((n, w) => n + w.latencyTimes.length, 0);
    // 창은 1초 칸 10개다. 15초 동안 낸 15,000건을 다 쥐고 있지 않다
    expect(kept).toBeLessThanOrEqual(11_000);
  });

  test('FND100_리뷰5_타이머값은_2의31승빼기1ms까지다', () => {
    expect(() => breaker({ dependency: 'big-svc', openMs: 2 ** 31 })).toThrow(/openMs/);
    expect(() => breaker({ dependency: 'big-svc', trialTimeoutMs: 2 ** 31 })).toThrow(/trialTimeoutMs/);
    breaker({ dependency: 'big-svc', openMs: 2 ** 31 - 1, trialTimeoutMs: 2 ** 31 - 1 });
  });
});

describe('여섯 번째 코드 리뷰 2026-11-01(판정 때·창 돌리기)', () => {
  test('FND100_리뷰6_성공으로문턱에닿아도_연다', async () => {
    const b = breaker();
    for (let i = 0; i < 10; i += 1) await settle(b.run(down));
    for (let i = 0; i < 10; i += 1) await settle(b.run(ok));
    expect(b.state).toBe('open');
  });

  test('FND100_리뷰6_시험한도초과가이어져도_opossum의지연값배열이커지지않는다', async () => {
    const b = breaker();
    await calls(b, 20, 20);
    const never = () => new Promise<string>(() => {});
    for (let cycle = 0; cycle < 50; cycle += 1) {
      clock.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      void b.run(never).catch(() => {});
      clock.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const impl = (b as unknown as Record<symbol, { status: { window: Array<{ latencyTimes: number[] }> } }>)[Symbol.for('peaket.breaker.implForTest')]!;
    const kept = impl.status.window.reduce((n, w) => n + w.latencyTimes.length, 0);
    expect(kept).toBeLessThanOrEqual(30);
  });
});
