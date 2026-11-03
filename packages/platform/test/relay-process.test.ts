// 서비스별 Outbox 릴레이 프로세스(openspec 변경 add-local-cluster-and-relay-deployment, ADR-0116 결정 1·2, BUILD_ORDER FND-110).
// 서비스와 같은 이미지·다른 시작 명령으로 도는 프로세스 하나가 Lease 리더일 때만 릴레이와 정비를 돌고, 관리 포트로 /metrics·/ready를 낸다.
import { Writable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import {
  PlatformConfigError,
  loadOutboxRelayProcessConfig,
  startOutboxRelayProcess,
  type Database,
  type LeaseApi,
  type LeaseRecord,
  type LeaseSpec,
  type MaintenanceTask,
  type OutboxPublisher,
  type OutboxRelayProcess,
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

async function start(api: LeaseApi, identity: string, tasks: MaintenanceTask[] = [], extra: { stopTimeoutMs?: number } = {}) {
  const p = await startOutboxRelayProcess({
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
  });
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
