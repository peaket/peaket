// 서비스별 Outbox 릴레이 프로세스(openspec 변경 add-local-cluster-and-relay-deployment, ADR-0116 결정 1·2, BUILD_ORDER FND-110).
// 서비스와 같은 이미지·다른 시작 명령으로 도는 프로세스 하나가 Lease 리더일 때만 릴레이와 정비를 돌고, 관리 포트로 /metrics·/ready를 낸다.
import { Writable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import {
  PlatformConfigError,
  loadOutboxRelayProcessConfig,
  memoryLeaseApi,
  startOutboxRelayProcess,
  type Clock,
  type Database,
  type LeaderLoop,
  type LeaderLoopContext,
  type LeaseApi,
  type LeaseRecord,
  type LeaseSpec,
  type MaintenanceTask,
  type OutboxPublisher,
  type OutboxRelayProcess,
  type OutboxRelayProcessOptions,
} from '../src/index.js';

const SERVICE = 'example-svc';
const ENV = {
  PEAKET_ENV: 'local',
  PEAKET_POD: 'example-svc-outbox-relay-0',
  PEAKET_OUTBOX_DATABASE_URL: 'postgres://relay:x@db:5432/example',
  PEAKET_MAINTENANCE_DATABASE_URL: 'postgres://maint:x@db-direct:5432/example',
  PEAKET_KAFKA_BROKERS: 'kafka-0:9092, kafka-1:9092',
};

function memoryLease() {
  let rec: LeaseRecord | undefined;
  let version = 0;
  const api: LeaseApi = {
    async get() {
      return rec ? { ...rec } : undefined;
    },
    async create(spec: LeaseSpec) {
      if (rec) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
    async update(spec: LeaseSpec, resourceVersion: string) {
      if (!rec || rec.resourceVersion !== resourceVersion) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
  };
  return { api, record: () => rec };
}

/** 보낼 행이 없는 DB(릴레이·지표가 부르는 질의에 빈 결과) */
const emptyDb = (): Database =>
  ({
    db: { execute: async () => ({ rows: [] }) },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => ({ rows: [] }) }),
    close: async () => {},
  }) as unknown as Database;

const publisher = (): OutboxPublisher & { calls: number } => {
  const p = { calls: 0, async publish() {
    p.calls += 1;
  } };
  return p;
};

const lines: string[] = [];
const sink = () =>
  new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });

const FAST = { leaseDurationMs: 600, renewDeadlineMs: 400, retryPeriodMs: 50 };
const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('기다림 한도');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const started: OutboxRelayProcess[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((p) => p.stop()));
  lines.length = 0;
});

type Extra = Partial<Pick<OutboxRelayProcessOptions, 'stopTimeoutMs' | 'leaderLoops' | 'clock'>>;

/** startOutboxRelayProcess의 시험 인자(관리 포트 0, 짧은 Lease, 로그는 lines로) */
function options(api: LeaseApi, identity: string, tasks: MaintenanceTask[] = [], extra: Extra = {}): OutboxRelayProcessOptions {
  return {
    ...extra,
    service: SERVICE,
    env: { ...ENV, PEAKET_POD: identity, PEAKET_MANAGEMENT_PORT: '0' },
    database: emptyDb(),
    maintenanceDatabase: emptyDb(),
    publisher: publisher(),
    leaseApi: api,
    maintenanceTasks: tasks,
    lease: FAST,
    logDestination: sink(),
  };
}

async function start(api: LeaseApi, identity: string, tasks: MaintenanceTask[] = [], extra: Extra = {}) {
  const p = await startOutboxRelayProcess(options(api, identity, tasks, extra));
  started.push(p);
  return p;
}

describe('릴레이 프로세스 설정', () => {
  test('FND110_설정_파드이름·두DB주소·브로커를읽고_Lease이름은_서비스-outbox-relay다', () => {
    expect(loadOutboxRelayProcessConfig(SERVICE, ENV)).toEqual({
      pod: 'example-svc-outbox-relay-0',
      outboxDatabaseUrl: ENV.PEAKET_OUTBOX_DATABASE_URL,
      maintenanceDatabaseUrl: ENV.PEAKET_MAINTENANCE_DATABASE_URL,
      kafkaBrokers: ['kafka-0:9092', 'kafka-1:9092'],
      leaseName: 'example-svc-outbox-relay',
    });
  });

  test('FND110_설정_빠진값은_이름을모두적고_시작하지않는다', () => {
    const { PEAKET_POD: _p, PEAKET_KAFKA_BROKERS: _k, ...rest } = ENV;
    expect(() => loadOutboxRelayProcessConfig(SERVICE, rest)).toThrow(PlatformConfigError);
    expect(() => loadOutboxRelayProcessConfig(SERVICE, rest)).toThrow(/PEAKET_POD.*PEAKET_KAFKA_BROKERS/);
  });

  test('FND110_설정_브로커는_호스트:포트꼴만받는다', () => {
    expect(() => loadOutboxRelayProcessConfig(SERVICE, { ...ENV, PEAKET_KAFKA_BROKERS: 'kafka-0' })).toThrow(/PEAKET_KAFKA_BROKERS/);
    expect(() => loadOutboxRelayProcessConfig(SERVICE, { ...ENV, PEAKET_KAFKA_BROKERS: ' , ' })).toThrow(/PEAKET_KAFKA_BROKERS/);
  });
});

describe('릴레이 프로세스', () => {
  test('FND110_두복제가함께뜨면_하나만리더이고_리더지표는그복제만1이다', async () => {
    const m = memoryLease();
    const a = await start(m.api, 'relay-a');
    const b = await start(m.api, 'relay-b');
    await until(() => a.isLeader() || b.isLeader());
    await new Promise((r) => setTimeout(r, 200));
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
    const leader = a.isLeader() ? a : b;
    const other = leader === a ? b : a;
    const metric = async (p: OutboxRelayProcess) => {
      const { managementPort } = await p.listen('127.0.0.1');
      return (await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text()).match(/^outbox_relay_is_leader\{service="example-svc"\} (\d)$/m)?.[1];
    };
    expect(await metric(leader)).toBe('1');
    expect(await metric(other)).toBe('0');
    expect(m.record()?.holderIdentity).toBe(leader === a ? 'relay-a' : 'relay-b');
  });

  test('FND110_관리포트_ready와livez는_의존성을부르지않고200이다', async () => {
    const p = await start(memoryLease().api, 'relay-a');
    const { managementPort } = await p.listen('127.0.0.1');
    const r = await fetch(`http://127.0.0.1:${managementPort}/ready`);
    expect(r.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${managementPort}/livez`)).status).toBe(200);
  });

  test('FND110_정비는_리더만돈다', async () => {
    const m = memoryLease();
    const ran: string[] = [];
    const task = (who: string): MaintenanceTask => ({ name: 'probe', when: 'daily', run: async () => void ran.push(who) });
    const a = await start(m.api, 'relay-a', [task('a')]);
    await until(() => a.isLeader());
    const b = await start(m.api, 'relay-b', [task('b')]);
    await until(() => ran.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(ran).toEqual(['a']);
    expect(b.isLeader()).toBe(false);
  });

  test('FND110_끝내면_Lease를놓아_다른복제가바로이어받고_리더바뀜을로그에남긴다', async () => {
    const m = memoryLease();
    const a = await start(m.api, 'relay-a');
    await until(() => a.isLeader());
    const b = await start(m.api, 'relay-b');
    await a.stop();
    await a.stop(); // 두 번 불러도 된다
    expect(m.record()?.holderIdentity === null || m.record()?.holderIdentity === 'relay-b').toBe(true);
    // Lease 기간(600ms)을 기다리지 않고 다음 시도(50ms)에 잡는다
    await until(() => b.isLeader(), 300);
    await until(() => lines.some((l) => l.includes('"leader":true') && l.includes('"pod":"relay-b"')));
    const changes = lines.map((l) => JSON.parse(l)).filter((l) => l.kind === 'outbox-relay' && 'leader' in l);
    expect(changes.map((l) => [l.pod, l.leader])).toEqual(expect.arrayContaining([['relay-a', true], ['relay-a', false], ['relay-b', true]]));
  });

  test('FND110_끝낼때_정비일이끝나지않아도_한도안에Lease를놓아_대기복제가이어받는다', async () => {
    // 재현(코드 리뷰): 정비 시간에 SIGTERM을 받으면 정비 일이 끝날 때까지 Lease를 쥐고 갱신해, 아무도 보내지 않은 채 SIGKILL을 맞았다
    const m = memoryLease();
    let gotSignal = false;
    const hung: MaintenanceTask = {
      name: 'idempotency-records-delete',
      when: 'daily',
      run: (signal) =>
        new Promise<void>(() => {
          signal?.addEventListener('abort', () => (gotSignal = true));
        }),
    };
    const a = await start(m.api, 'relay-a', [hung], { stopTimeoutMs: 300 });
    await until(() => a.isLeader());
    const b = await start(m.api, 'relay-b');
    const t0 = Date.now();
    await a.stop();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(gotSignal).toBe(true);
    expect(m.record()?.holderIdentity === null || m.record()?.holderIdentity === 'relay-b').toBe(true);
    await until(() => b.isLeader(), 300);
  });
});

// ── 리더 반복(leaderLoops, BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 리더 반복, docs/data.md §5 '릴레이 리더 넘김') ──
// 반복은 시험 안의 대역이다. 프로세스는 시작할 때 start() 한 번, 끝낼 때 stop() 한 번만 부르고, 리더 여부는 반복이 ctx.leader로 스스로 본다.

/** 미뤄 둔 약속 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

/** start·stop 호출을 세는 반복 대역. order가 있으면 '<이름>.start'·'<이름>.stop'을 차례로 적는다 */
function probeLoop(name: string, o: { order?: string[]; stop?: () => Promise<void> } = {}) {
  const loop = {
    name,
    starts: 0,
    stops: 0,
    start() {
      loop.starts += 1;
      o.order?.push(`${name}.start`);
    },
    stop(): Promise<void> {
      loop.stops += 1;
      o.order?.push(`${name}.stop`);
      return o.stop ? o.stop() : Promise.resolve();
    },
  };
  return loop satisfies LeaderLoop;
}

/** 20ms마다 ctx.leader.isLeader()를 보고 리더일 때만 '일'(worked에 who)을 적는 반복(운영 반복과 같은 방식) */
function workingLoop(ctx: LeaderLoopContext, worked: string[], who: string): LeaderLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    name: 'probe-work',
    start() {
      timer ??= setInterval(() => {
        if (ctx.leader.isLeader()) worked.push(who);
      }, 20);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('FND110 리더 반복(leaderLoops, PRF-164)', () => {
  test('FND110_leaderLoops는_시작할때한번불리고_돌려받은반복을차례로start한번씩켠다. ctx는_리더확인·프로세스레지스트리·프로세스로거·시계다', async () => {
    const m = memoryLease();
    const order: string[] = [];
    const a = probeLoop('loop-a', { order });
    const b = probeLoop('loop-b', { order });
    const ctxs: LeaderLoopContext[] = [];
    const clock: Clock = { now: () => Date.now(), monotonicMs: () => performance.now() };
    const p = await start(m.api, 'relay-a', [], {
      clock,
      leaderLoops: (ctx) => {
        ctxs.push(ctx);
        return [a, b];
      },
    });
    expect(ctxs).toHaveLength(1);
    expect(order).toEqual(['loop-a.start', 'loop-b.start']);
    const ctx = ctxs[0]!;
    expect(ctx.registry).toBe(p.registry);
    expect(ctx.clock).toBe(clock);
    await until(() => p.isLeader());
    expect(ctx.leader.isLeader()).toBe(true);
    // 프로세스 로거(service·pod가 붙은 것)라 반복 로그가 같은 출력에 pod와 함께 나간다
    ctx.logger.info({ kind: 'probe-loop' }, '반복 로그');
    expect(parsed().some((l) => l.kind === 'probe-loop' && l.pod === 'relay-a' && l.service === SERVICE)).toBe(true);
    // 프로세스는 리더 여부로 반복을 켜고 끄지 않는다(리더가 된 뒤에도 start는 한 번)
    await new Promise((r) => setTimeout(r, 150));
    expect([a.starts, b.starts]).toEqual([1, 1]);
    expect([a.stops, b.stops]).toEqual([0, 0]);
    await p.stop();
    await p.stop(); // 두 번 불러도 반복 stop은 한 번
    expect([a.stops, b.stops]).toEqual([1, 1]);
    expect(ctx.leader.isLeader()).toBe(false);
  });

  test('FND110_끝낼때_모든반복의stop을기다린뒤에_Lease를놓는다(그전까지는Lease를쥔다) [ASVS v5.0.0-16.5.2]', async () => {
    const m = memoryLease();
    const events: string[] = [];
    const api: LeaseApi = {
      ...m.api,
      update: async (spec, resourceVersion) => {
        if (spec.holderIdentity === null) events.push('lease-release');
        return m.api.update(spec, resourceVersion);
      },
    };
    const gate = deferred();
    const a = probeLoop('loop-a', {
      stop: async () => {
        events.push('a-stop-begin');
        await gate.promise;
        events.push('a-stop-end');
      },
    });
    const b = probeLoop('loop-b', { stop: async () => void events.push('b-stop') });
    const p = await start(api, 'relay-a', [], { leaderLoops: () => [a, b] });
    await until(() => p.isLeader());
    const stopping = p.stop();
    // 반복 stop은 함께 부른다(앞 반복이 끝나기를 기다리지 않고 뒤 반복도 멈춘다)
    await until(() => events.includes('a-stop-begin') && events.includes('b-stop'), 1_000);
    await new Promise((r) => setTimeout(r, 150));
    expect(events).not.toContain('lease-release');
    expect(m.record()?.holderIdentity).toBe('relay-a');
    gate.resolve();
    await stopping;
    expect(events.indexOf('a-stop-end')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('lease-release')).toBeGreaterThan(events.indexOf('a-stop-end'));
    expect(m.record()?.holderIdentity).toBeNull();
    expect([a.stops, b.stops]).toEqual([1, 1]);
  });

  test('FND110_반복stop이던져도(거부·바로던짐)_나머지반복을멈추고_stop은던지지않으며_Lease를놓아다른복제가이어받고_경고로그에그반복이름을남긴다 [ASVS v5.0.0-16.5.2]', async () => {
    const m = memoryLease();
    const boom = () => Object.assign(new Error('loop stop failed'), { name: 'LoopStopError' });
    const rejecting = probeLoop('loop-reject', { stop: async () => Promise.reject(boom()) });
    const throwing = probeLoop('loop-throw', {
      stop: () => {
        throw boom();
      },
    });
    const ok = probeLoop('loop-ok');
    const p = await start(m.api, 'relay-a', [], { leaderLoops: () => [rejecting, throwing, ok] });
    await until(() => p.isLeader());
    const other = await start(m.api, 'relay-b');
    await expect(p.stop()).resolves.toBeUndefined();
    expect([rejecting.stops, throwing.stops, ok.stops]).toEqual([1, 1, 1]);
    expect(m.record()?.holderIdentity === null || m.record()?.holderIdentity === 'relay-b').toBe(true);
    await until(() => other.isLeader(), 300);
    const warns = parsed().filter((l) => l.level === 'warn' && l.pod === 'relay-a');
    for (const name of ['loop-reject', 'loop-throw']) expect(warns.some((l) => JSON.stringify(l).includes(name)), name).toBe(true);
  });

  test('FND110_반복stop이한도(stopTimeoutMs)를넘기면_기다리지않고Lease를놓아_대기복제가이어받는다', async () => {
    const m = memoryLease();
    const hung = probeLoop('loop-hung', { stop: () => new Promise<void>(() => {}) });
    const p = await start(m.api, 'relay-a', [], { stopTimeoutMs: 300, leaderLoops: () => [hung] });
    await until(() => p.isLeader());
    const other = await start(m.api, 'relay-b');
    const t0 = Date.now();
    await p.stop();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(hung.stops).toBe(1);
    expect(m.record()?.holderIdentity === null || m.record()?.holderIdentity === 'relay-b').toBe(true);
    await until(() => other.isLeader(), 300);
  });

  test('FND110_반복이름이겹치면_시작하지않고던진다(설정실수): 어느반복도start하지않고_Lease도잡지않는다', async () => {
    const m = memoryLease();
    const x = probeLoop('dup-loop');
    const y = probeLoop('dup-loop');
    const starting = startOutboxRelayProcess(options(m.api, 'relay-a', [], { leaderLoops: () => [x, y] })).then((p) => {
      started.push(p); // 던지지 않았으면 afterEach가 멈추게 둔다
      return p;
    });
    await expect(starting).rejects.toThrow(/dup-loop/);
    await new Promise((r) => setTimeout(r, 200));
    expect([x.starts, y.starts]).toEqual([0, 0]);
    expect(m.record()).toBeUndefined();
  });

  test('FND110_반복start가던지면(약속위반)_켠반복을멈추고_Lease를놓은뒤_그오류로시작이거부된다: 그반복없이리더로돌지않고_다른복제가이어받는다 [ASVS v5.0.0-16.5.2]', async () => {
    // 변이 검토(PRF-164): start가 던졌을 때 정리(stop) 없이 던지기만 하면 Lease 반복이 남아 Lease를 쥔 채 반복 없는 리더로 돈다(조용한 멈춤)
    const m = memoryLease();
    const order: string[] = [];
    const first = probeLoop('loop-first', { order });
    const boom = Object.assign(new Error('loop start failed'), { name: 'LoopStartError' });
    const broken = {
      name: 'loop-broken',
      start() {
        throw boom;
      },
      stop: async () => void order.push('loop-broken.stop'),
    } satisfies LeaderLoop;
    const starting = startOutboxRelayProcess(options(m.api, 'relay-a', [], { leaderLoops: () => [first, broken] })).then((p) => {
      started.push(p); // 던지지 않았으면 afterEach가 멈추게 둔다
      return p;
    });
    await expect(starting).rejects.toBe(boom);
    // 켠 반복(과 던진 반복)을 멈췄다
    expect(first.starts).toBe(1);
    expect(first.stops).toBe(1);
    expect(order).toContain('loop-broken.stop');
    // Lease 다시 시도(50ms)를 여러 번 넘겨도 relay-a가 Lease를 쥐지 않는다
    await new Promise((r) => setTimeout(r, 300));
    expect(m.record()?.holderIdentity ?? null).toBeNull();
    const other = await start(m.api, 'relay-b');
    await until(() => other.isLeader(), 300);
    expect(parsed().some((l) => l.level === 'error' && l.kind === 'outbox-relay' && l.pod === 'relay-a')).toBe(true);
  });

  test('FND110_같은Lease(memoryLeaseApi)를다투는두복제에서_리더가아닌쪽의반복은일하지않고_리더를멈추면다른쪽반복이이어서일한다 [ASVS v5.0.0-15.4.1]', async () => {
    const api = memoryLeaseApi();
    const worked: string[] = [];
    const a = await start(api, 'relay-a', [], { leaderLoops: (ctx) => [workingLoop(ctx, worked, 'a')] });
    await until(() => a.isLeader());
    const b = await start(api, 'relay-b', [], { leaderLoops: (ctx) => [workingLoop(ctx, worked, 'b')] });
    await until(() => worked.includes('a'));
    await new Promise((r) => setTimeout(r, 200));
    expect(b.isLeader()).toBe(false);
    expect(worked.filter((w) => w === 'b')).toEqual([]);
    await a.stop();
    const byA = worked.filter((w) => w === 'a').length;
    await until(() => worked.includes('b'), 1_000);
    await new Promise((r) => setTimeout(r, 100));
    // 멈춘 복제의 반복은 더 일하지 않는다
    expect(worked.filter((w) => w === 'a')).toHaveLength(byA);
    expect(b.isLeader()).toBe(true);
  });
});
