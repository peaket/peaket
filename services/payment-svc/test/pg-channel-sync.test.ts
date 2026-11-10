// 낮춘 상한의 표 맞추기(PgChannelLimitSync)·관측 표 캐시(CachedPgChannelObservations)·관측기(PgChannelObserver)·종료 차례(BUILD_ORDER PRF-203 코드 리뷰).
// 정본: docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복'·§2.2 '하위 결제사 검사의 첫 구현'. 실제 PostgreSQL로 잇는 것은 test-int/payment-channel-limit·payment-sub-provider다.
// 저장소는 대역이다(걸린 연결·실패·판 번호 겨룸을 만든다). 시계는 가짜 시계다.
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { pgChannelLog } from '../src/modules/payment/adapters/pg-channel-log.js';
import { PromPgChannelSignals } from '../src/modules/payment/adapters/prom-pg-channel-signals.js';
import { PgChannelObserver } from '../src/modules/payment/application/pg-channel-observer.js';
import { CachedPgChannelObservations } from '../src/modules/payment/application/pg-channel-observations.js';
import { PgChannelLimitSync } from '../src/modules/payment/application/pg-channel-limit-sync.js';
import type { PgName } from '../src/modules/payment/domain/payment-gateway.js';
import type { PgChannelLimitRow, PgLimitLowering } from '../src/modules/payment/domain/pg-channel-limit.js';
import { PG_LIMIT_WRITE_RETRIES } from '../src/modules/payment/domain/pg-channel-limit.js';
import { type PortoneChannelMap, portoneChannelMapOf } from '../src/modules/payment/domain/pg-sub-provider.js';
import type { PgChannelLimitStore, PgChannelLimitSyncStep, PgChannelObservedOutcome } from '../src/modules/payment/domain/ports.js';
import { shutdownInOrder } from '../src/shutdown.js';

const NOW = Date.parse('2026-11-10T01:00:00.000Z');
const HUNG = Symbol('hung');
const never = <T>() => new Promise<T>(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ms 안에 끝나지 않으면 HUNG */
const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof HUNG> => Promise.race<T | typeof HUNG>([p, sleep(ms).then((): typeof HUNG => HUNG)]);

const lowering = (o: Partial<PgLimitLowering> = {}): PgLimitLowering => ({ pg: 'SIMULATOR', ratioPercent: 50, loweredAtMs: NOW, expiresAtMs: NOW + 70 * 60_000, ...o });
const rowOf = (o: Partial<PgChannelLimitRow> = {}): PgChannelLimitRow => ({ pg: 'SIMULATOR', ratioPercent: 50, loweredAtMs: NOW, expiresAtMs: NOW + 70 * 60_000, version: 1, ...o });

/** 저장소 대역. 부른 차례를 남긴다 */
function store(o: Partial<PgChannelLimitStore> = {}) {
  const calls: string[] = [];
  const value: PgChannelLimitStore = {
    readAll: (b) => {
      calls.push('readAll');
      return o.readAll ? o.readAll(b) : Promise.resolve(new Map());
    },
    read: (pg) => {
      calls.push('read');
      return o.read ? o.read(pg) : Promise.resolve(undefined);
    },
    write: (basis, next, nowMs) => {
      calls.push('write');
      return o.write ? o.write(basis, next, nowMs) : Promise.resolve(rowOf({ ratioPercent: next.ratioPercent }));
    },
  };
  return { value, calls };
}

function syncWith(s: PgChannelLimitStore) {
  const failures: PgChannelLimitSyncStep[] = [];
  const logs: { step: PgChannelLimitSyncStep; pg?: PgName; code: string }[] = [];
  const sync = new PgChannelLimitSync({
    store: s,
    guards: { of: () => undefined } as never,
    clock: fakeClock({ now: NOW }),
    signals: { limitSyncFailed: (step) => failures.push(step) },
    log: { limitSyncFailed: (e) => logs.push(e) },
    timer: { setInterval: () => 1, clearInterval: () => undefined },
  });
  return { sync, failures, logs };
}

describe('표 맞추기의 걸린 연결(코드 리뷰 F4)', () => {
  test('P-T34 표 읽기가 끝나지 않으면 시간 한도 뒤 read 실패로 세고, 다음 맞추기는 새 읽기를 시작하며, stop()은 걸린 읽기를 기다리지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const s = store({ readAll: never });
    const { sync, failures, logs } = syncWith(s.value);
    await expect(within(sync.refresh(), 2_000)).resolves.toBe(false);
    expect(failures).toEqual(['read']);
    expect(logs).toEqual([{ step: 'read', code: 'CLIENT_TIMEOUT' }]);
    void sync.refresh();
    expect(s.calls).toEqual(['readAll', 'readAll']);
    await expect(within(sync.stop(), 2_000)).resolves.toBeUndefined();
  });

  test('P-T34 낮춤의 표 쓰기가 끝나지 않아도 시간 한도 뒤 write 실패로 세고 stop()이 끝난다', async () => {
    const s = store({ write: never });
    const { sync, failures } = syncWith(s.value);
    sync.lowered(lowering());
    await expect(within(sync.stop(), 2_000)).resolves.toBeUndefined();
    expect(failures).toEqual(['write']);
  });
});

describe('표 맞추기의 클라이언트 시간 한도 값(전파 최악 약 1.9초의 몫, 틀린 구현 검사로 더함)', () => {
  // 정본: docs/features/payment.md §2 '걸린 연결'·'파드 사이 전파'(쓰기 600ms + 읽기 간격 1초 + 읽기 300ms ≈ 1.9초 [가정]). 상수를 가져오지 않고 정본의 값으로 잰다(한도를 늘리면 전파 최악이 늘어난다)
  test('P-T34 표 읽기는 299ms에는 기다리고 300ms에 read 실패로 끝난다 [ASVS v5.0.0-15.1.3]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { sync, failures } = syncWith(store({ readAll: never }).value);
      let settled: boolean | undefined;
      void sync.refresh().then((ok) => {
        settled = ok;
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBeUndefined();
      expect(failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(failures).toEqual(['read']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('P-T34 낮춤의 표 쓰기와 진 뒤 다시 읽기는 599ms에는 기다리고 600ms에 실패로 끝난다 [ASVS v5.0.0-15.1.3]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hungWrite = syncWith(store({ write: never }).value);
      hungWrite.sync.lowered(lowering());
      await vi.advanceTimersByTimeAsync(599);
      expect(hungWrite.failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(hungWrite.failures).toEqual(['write']);

      const hungRead = syncWith(store({ write: async () => undefined, read: never }).value);
      hungRead.sync.lowered(lowering());
      await vi.advanceTimersByTimeAsync(599);
      expect(hungRead.failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(hungRead.failures).toEqual(['read']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('관측 표 캐시의 걸린 연결(코드 리뷰 F4)', () => {
  test('P-T46 ④ 관측 표 읽기가 끝나지 않으면 시간 한도 뒤 read 실패로 세고(마지막 값이 없으면 실패), 다음 호출은 새 읽기를 시작한다 [ASVS v5.0.0-16.5.3]', async () => {
    let reads = 0;
    const failures: string[] = [];
    const cache = new CachedPgChannelObservations({
      reader: {
        readAll: () => {
          reads += 1;
          return never();
        },
      },
      clock: fakeClock({ now: NOW }),
      signals: { channelObservedFailed: (step) => failures.push(step) },
    });
    const first = await within(
      cache.readAll().catch((e: unknown) => e),
      2_000,
    );
    expect(first).toBeInstanceOf(Error);
    expect(failures).toEqual(['read']);
    void cache.readAll().catch(() => undefined);
    expect(reads).toBe(2);
  });
});

describe('관측 표 캐시의 클라이언트 시간 한도 값(틀린 구현 검사로 더함)', () => {
  // 정본: docs/features/payment.md §2.2 '하위 결제사 검사의 첫 구현'(저장소 읽기 클라이언트 한도 300ms [가정]). 상수를 가져오지 않고 정본의 값으로 잰다
  test('P-T46 ④ 관측 표 읽기는 299ms에는 기다리고 300ms에 read 실패로 끝나 마지막 값이 없으면 실패한다 [ASVS v5.0.0-16.5.3]', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const failures: string[] = [];
      const cache = new CachedPgChannelObservations({ reader: { readAll: never }, clock: fakeClock({ now: NOW }), signals: { channelObservedFailed: (step) => failures.push(step) } });
      let outcome: unknown = 'pending';
      void cache.readAll().then(
        () => {
          outcome = 'resolved';
        },
        (e: unknown) => {
          outcome = e;
        },
      );
      await vi.advanceTimersByTimeAsync(299);
      expect(outcome).toBe('pending');
      expect(failures).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(Error);
      expect(failures).toEqual(['read']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('종료 차례(코드 리뷰 F5)', () => {
  // main.ts의 SIGTERM과 같은 꼴(실행기는 stop, 표 맞추기는 drain). main.ts가 그렇게 적는지는 test/process-config.test.ts의 글 검사가 본다
  test('P-T34 승인 실행기를 멈추는 동안(돌던 호출이 끝나며) 받은 첫 429의 낮춤도 표에 쓴 뒤에 표 맞추기가 멈춘다', async () => {
    const s = store();
    const { sync, failures } = syncWith(s.value);
    const runner = {
      stop: async () => {
        await sleep(20);
        sync.lowered(lowering());
      },
    };
    await shutdownInOrder({
      stop: () => [runner.stop()],
      drain: () => [sync.stop()],
      closeService: async () => undefined,
      closeConnections: () => [],
      onError: () => undefined,
    });
    expect(s.calls).toEqual(['write']);
    expect(failures).toEqual([]);
  });

  test('P-T34 멈춘 뒤에 온 낮춤은 쓰지 않고 write 실패로 센다', async () => {
    const s = store();
    const { sync, failures } = syncWith(s.value);
    await sync.stop();
    sync.lowered(lowering());
    expect(s.calls).toEqual([]);
    expect(failures).toEqual(['write']);
  });
});

describe('판 번호 겨룸(코드 리뷰 T3)', () => {
  test('P-T34 판 번호에 세 번 지면(다시 해 보기 2번) 그만두고 conflict 1이며, 쓰기는 정확히 세 번이다', async () => {
    let version = 1;
    // 다시 읽은 행은 이번 낮춤을 담지 않는다(비율 75 > 50, 60초 앞에 낮춤, 호출 시작 시각 모름)
    const s = store({ write: async () => undefined, read: async () => rowOf({ ratioPercent: 75, loweredAtMs: NOW - 60_000, version: (version += 1) }) });
    const { sync, failures, logs } = syncWith(s.value);
    sync.lowered(lowering());
    await sync.whenIdle();
    expect(PG_LIMIT_WRITE_RETRIES).toBe(2);
    expect(s.calls).toEqual(['write', 'read', 'write', 'read', 'write', 'read']);
    expect(failures).toEqual(['conflict']);
    expect(logs).toEqual([{ step: 'conflict', pg: 'SIMULATOR', code: 'conflict' }]);
  });
});

/** 관측기 한 벌(실제 캐시·지표·로그 어댑터, 저장소는 대역) */
function observerWith(portone: PortoneChannelMap, o: { readAll?: () => Promise<ReadonlyMap<string, string>>; upsert?: () => Promise<boolean> } = {}) {
  const clock = fakeClock({ now: NOW });
  const metrics = new PlatformMetrics('payment-svc');
  const signals = new PromPgChannelSignals().register(metrics.registry);
  const warns: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const log = pgChannelLog({ warn: ((x: Record<string, unknown>) => warns.push(x)) as never, error: ((x: Record<string, unknown>) => errors.push(x)) as never }, clock);
  let reads = 0;
  const writes: [string, string][] = [];
  const observations = new CachedPgChannelObservations({
    reader: {
      readAll: () => {
        reads += 1;
        return o.readAll ? o.readAll() : Promise.resolve(new Map());
      },
    },
    clock,
    signals,
  });
  const observer = new PgChannelObserver({
    portone,
    observations,
    store: {
      upsert: async (key, provider) => {
        writes.push([key, provider]);
        return o.upsert ? o.upsert() : true;
      },
    },
    clock,
    signals,
    log,
  });
  const count = async (name: string, label: string) => {
    const line = (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(label));
    return Number(line?.split(' ').at(-1) ?? 0);
  };
  return { observer, observations, clock, warns, errors, writes, reads: () => reads, count };
}
const outcome = (o: PgChannelObservedOutcome) => `outcome="${o}"`;
const coded = (code: string) => Object.assign(new Error('저장소 오류'), { code });

describe('관측 표 캐시(코드 리뷰 T1)', () => {
  test('P-T46 ④ 겹친 호출은 저장소 읽기 하나를 함께 기다리고, 관측 값을 쓴 뒤에는 수명 안이어도 다시 읽는다', async () => {
    const r = observerWith(portoneChannelMapOf({ channelKey: 'ch-one' }, { 'ch-one': 'KCP_V2' }));
    const both = await Promise.all([r.observations.readAll(), r.observations.readAll()]);
    expect(both).toEqual([new Map(), new Map()]);
    expect(r.reads()).toBe(1);
    r.observer.observe({ key: 'ch-one', pgProvider: 'TOSSPAYMENTS' });
    await r.observer.whenIdle();
    expect(r.writes).toEqual([['ch-one', 'TOSSPAYMENTS']]);
    const before = r.reads();
    await r.observations.readAll();
    expect(r.reads()).toBe(before + 1);
  });

  test('P-T46 ④ 관측기의 표 읽기·쓰기가 실패하면 실패 지표(step)와 경고 로그 한 줄을 내고 결제는 막지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const readFails = observerWith(portoneChannelMapOf({ channelKey: 'ch-one' }, { 'ch-one': 'KCP_V2' }), { readAll: () => Promise.reject(coded('57014')) });
    expect(() => readFails.observer.observe({ key: 'ch-one', pgProvider: 'TOSSPAYMENTS' })).not.toThrow();
    await readFails.observer.whenIdle();
    expect(await readFails.count('payment_pg_channel_observed_failures_total', 'step="read"')).toBe(1);
    expect(readFails.writes).toEqual([]);
    expect(readFails.warns).toEqual([{ kind: 'pg-channel-observed-failed', step: 'read', code: '57014' }]);

    const writeFails = observerWith(portoneChannelMapOf({ channelKey: 'ch-one' }, { 'ch-one': 'KCP_V2' }), { upsert: () => Promise.reject(coded('40001')) });
    writeFails.observer.observe({ key: 'ch-one', pgProvider: 'TOSSPAYMENTS' });
    await writeFails.observer.whenIdle();
    expect(await writeFails.count('payment_pg_channel_observed_failures_total', 'step="write"')).toBe(1);
    expect(writeFails.warns).toEqual([{ kind: 'pg-channel-observed-failed', step: 'write', code: '40001' }]);
  });
});

describe('관측기 분류(코드 리뷰 T2)', () => {
  const two = portoneChannelMapOf({ channelKey: 'ch-card', channelKeys: { CARD: 'ch-card', EASY_PAY: 'ch-easy' } }, { 'ch-card': 'KCP_V2', 'ch-easy': 'NICE_V2' });

  test('P-T46 ④ 채널 키가 없는 답에 쓰는 채널이 둘이면 unattributed 1이고 표를 쓰지 않으며 SEV2도 없다', async () => {
    const r = observerWith(two);
    r.observer.observe({ pgProvider: 'TOSSPAYMENTS' });
    await r.observer.whenIdle();
    expect(await r.count('payment_pg_channel_observed_total', outcome('unattributed'))).toBe(1);
    expect(await r.count('payment_pg_channel_observed_total', outcome('mismatch'))).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test('P-T46 ④ 쓰지 않는 채널 키의 답은 unattributed이고 표를 쓰지 않는다', async () => {
    const r = observerWith(two);
    r.observer.observe({ key: 'ch-other', pgProvider: 'TOSSPAYMENTS' });
    await r.observer.whenIdle();
    expect(await r.count('payment_pg_channel_observed_total', outcome('unattributed'))).toBe(1);
    expect(r.writes).toEqual([]);
  });

  test('P-T46 ④ 설정 값이 없는 채널(local·ci)의 답은 unconfigured이고 표를 쓰지 않는다', async () => {
    const r = observerWith(portoneChannelMapOf({ channelKey: 'ch-one' }, undefined));
    r.observer.observe({ key: 'ch-one', pgProvider: 'TOSSPAYMENTS' });
    await r.observer.whenIdle();
    expect(await r.count('payment_pg_channel_observed_total', outcome('unconfigured'))).toBe(1);
    expect(r.writes).toEqual([]);
  });

  test('P-T46 ④ 설정과 같은 답은 match 1이고 남은 다른 관측 행을 덮지 않는다(코드 리뷰 F3)', async () => {
    const r = observerWith(portoneChannelMapOf({ channelKey: 'ch-one' }, { 'ch-one': 'KCP_V2' }), { readAll: async () => new Map([['ch-one', 'TOSSPAYMENTS']]) });
    r.observer.observe({ key: 'ch-one', pgProvider: 'KCP_V2' });
    await r.observer.whenIdle();
    expect(await r.count('payment_pg_channel_observed_total', outcome('match'))).toBe(1);
    expect(r.writes).toEqual([]);
  });
});
