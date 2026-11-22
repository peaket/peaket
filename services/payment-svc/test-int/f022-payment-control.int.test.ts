// F-02-2(OPS-310) payment-svc 받는 쪽: 제어 포트(PEAKET_PAYMENT_CONTROL_GRPC_PORT)의 CONTROL_KIND_PG_SWITCH·CONTROL_KIND_ENTRY_PAUSE_RELEASE,
// 시작 때 pg_switch 읽기를 준비 조건으로, 읽기 전용 ResolvePgSwitch. 실제 PostgreSQL 18과 실제 HTTP 시뮬레이터(buildSimulatorApp)로 시작 함수(src/start.ts)를 띄운다.
// 정본: ADR-0366 결정 2(바라는 상태 {"switched", "toPg": TOSS|PORTONE|null}. pg_switch(범위 = 요청)에 active·from_pg = null·to_pg·version·changed_at을 판이 클 때만 쓰고
// 그 파드의 선택 캐시를 바로 비움, applied_version = 쓴 뒤 다시 읽은 판, 모르는 칸·틀린 꼴은 INVALID_ARGUMENT·쓰기 0), 결정 3(시작 때 pg_switch를 한 번 읽어야 준비),
// 결정 5(ResolvePgSwitch: 선택기와 같은 규칙으로 전환이 켜졌을 때 갈 결제사와 그 승인 상한, 쓰기 없음), 결정 9(해제: actor = 요청자 계정 ID라 SYSTEM이 아님,
// 정지 since > 판이면 열지 않음, 정지 캐시를 바로 비움, 파드마다 받은 가장 큰 판, 같거나 작은 판은 쓰기 없이 그 값), ADR-0365 결정 1(판 1~2^53−1), 계획 6절 B5~B8·B14·B15, 9절, 13절.
// 시뮬레이터는 플랫폼 기본(SIMULATOR)이고, 대체 TOSS 어댑터도 시뮬레이터 주소·시뮬레이터 키로 띄운다(결제창 값만 만들고 부르지 않는다).
// 결제사 승인 상한은 PEAKET_PG_APPROVAL_TPS {"TOSS": 37.9, "PORTONE": 12.5}(코드 기본값과 다른 시험 값).
// [가정] 제어 포트 환경 값 PEAKET_PAYMENT_CONTROL_GRPC_PORT(계획 3.1)와 듣는 주소 PEAKET_CONTROL_GRPC_HOST(F-02-1 받는 쪽과 같다). 해제의 바라는 상태는 정본(ADR-0366 결정 8) {"pg", "actor"}다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { start, type StartedService } from '../src/start.js';
import { type ApplyRequest, controlClient, type ControlClient, freePort, status, until } from '../../queue-svc/test-int/control-client.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, newId, paymentClient, type PaymentClient, unary } from './support.js';

const SIM_NOW_MS = Date.parse('2026-11-23T01:00:00.000Z');
const TPS = { TOSS: 37.9, PORTONE: 12.5 } as const;
/** 선택 캐시·정지 캐시의 수명 1초 [가정](payment.md §2.2 '선택기의 첫 구현', §2 '정지 행 읽기'). 비우기가 없으면 이 안에서는 옛 값이다 */
const CACHE_MS = 1_000;

let pgc: PostgresContainer | undefined;
let admin: Database;
let sim: SimulatorApp;
let simUrl: string;
let simKey: string;

interface Pod {
  readonly name: string;
  readonly control: ControlClient;
  readonly grpc: PaymentClient;
  readonly managementPort: number;
  readonly logs: string[];
  readonly svc: StartedService;
}
const pods: Pod[] = [];

async function envOf(name: string): Promise<{ env: Record<string, string>; controlPort: number; managementPort: number }> {
  const controlPort = await freePort();
  const managementPort = await freePort();
  return {
    controlPort,
    managementPort,
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: name,
      HOSTNAME: name,
      PEAKET_DATABASE_URL: pgc!.url,
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PEAKET_PAYMENT_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'info',
      PEAKET_PG_SIM_URL: simUrl,
      PEAKET_PG_SIM_SECRET_KEY: simKey,
      PEAKET_PG_SIM_CLIENT_KEY: 'sim_ck_f022_client',
      PEAKET_PG_TOSS_URL: simUrl,
      PEAKET_PG_TOSS_SECRET_KEY: simKey,
      PEAKET_PG_TOSS_CLIENT_KEY: 'sim_ck_f022_toss',
      PEAKET_PG_DEFAULT: 'SIMULATOR',
      PEAKET_PG_FALLBACK: 'TOSS',
      PEAKET_PG_APPROVAL_TPS: JSON.stringify(TPS),
    },
  };
}

function sinkInto(logs: string[]): Writable {
  return new Writable({
    write: (chunk, _e, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
}

async function startPod(name: string): Promise<Pod> {
  const { env, controlPort, managementPort } = await envOf(name);
  const logs: string[] = [];
  const svc = await start({ env, logDestination: sinkInto(logs) });
  const pod: Pod = { name, control: controlClient(`127.0.0.1:${controlPort}`), grpc: paymentClient(`127.0.0.1:${svc.ports.grpcPort}`), managementPort, logs, svc };
  pods.push(pod);
  return pod;
}
async function stopPod(p: Pod): Promise<void> {
  p.control.close();
  p.grpc.close();
  await p.svc.close();
  pods.splice(pods.indexOf(p), 1);
}

let podA: Pod;
let podB: Pod;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-f022-it-admin' });
  await ensureOutboxPartitions(admin, systemClock);
  simKey = `sim_sk_${randomBytes(16).toString('hex')}`;
  sim = buildSimulatorApp({ secretKey: simKey, clock: { now: () => SIM_NOW_MS }, confirmLatency: { kind: 'none' } });
  simUrl = await sim.listen({ host: '127.0.0.1', port: 0 });
  podA = await startPod('payment-f022-a');
  podB = await startPod('payment-f022-b');
}, 240_000);

afterAll(async () => {
  for (const p of [...pods]) await stopPod(p).catch(() => undefined);
  await sim?.close();
  await admin?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await admin.pool.query('truncate pg_switch, event_pg_config, payment_entry_pause, payment_entry_trial');
});

const KIND = 'CONTROL_KIND_PG_SWITCH';
const RELEASE = 'CONTROL_KIND_ENTRY_PAUSE_RELEASE';
/** 해제를 낸 commander의 관리 계정 ID(ADR-0366 결정 8 {"pg", "actor"}, actor 1~128자) */
const ACTOR = '0193a000-0000-7000-8000-00000000c0de';
const rel = (pgName: string, actor: string = ACTOR) => JSON.stringify({ pg: pgName, actor });
const sw = (switched: boolean, toPg: 'TOSS' | 'PORTONE' | null) => JSON.stringify({ switched, toPg });
const req = (o: Partial<ApplyRequest> & Pick<ApplyRequest, 'scope' | 'desiredStateJson'>): ApplyRequest => ({ commandId: newId(), version: 1_000, kind: KIND, ...o });
interface SwitchRow {
  scope: string;
  active: boolean;
  from_pg: string | null;
  to_pg: string | null;
  version: string;
  changed_at: Date;
}
const switchOf = async (scope: string): Promise<SwitchRow | undefined> =>
  (await admin.pool.query<SwitchRow>('select scope, active, from_pg, to_pg, version::text as version, changed_at from pg_switch where scope = $1', [scope])).rows[0];
const switchCount = async () => Number((await admin.pool.query<{ n: string }>('select count(*)::text as n from pg_switch')).rows[0]!.n);
interface PauseRow {
  stage: string;
  actor: string;
  since: Date;
  reopened_at: Date | null;
  version: string;
}
const pauseOf = async (pgName: string): Promise<PauseRow | undefined> =>
  (await admin.pool.query<PauseRow>(`select stage, actor, since, reopened_at, version::text as version from payment_entry_pause where pg = $1 and channel = 'ALL'`, [pgName])).rows[0];
const putPause = (pgName: string, sinceMs: number, version: number) =>
  admin.pool.query(`insert into payment_entry_pause (pg, channel, stage, reason, actor, since, version) values ($1, 'ALL', 'PROBING', 'PG_FAILURE', 'SYSTEM', $2, $3)`, [pgName, new Date(sinceMs), version]);
const assignTo = (eventId: string, primary: string, fallback: string | null) =>
  admin.pool.query('insert into event_pg_config (event_id, pg_primary, pg_fallback, updated_at) values ($1, $2, $3, now())', [eventId, primary, fallback]);
const checkoutReq = (eventId: string) => ({ order_kind: 'ORDER_KIND_TICKET', order_id: newId(), attempt_id: newId(), event_id: eventId, amount: { krw: 41_000 }, order_name: 'F022 공연 티켓', pay_method: 'CARD' });
const prepare = (p: Pod, eventId: string) => unary(p.grpc, 'PrepareCheckout', checkoutReq(eventId));
const ready = (p: { managementPort: number }) => fetch(`http://127.0.0.1:${p.managementPort}/ready`).then((r) => r.status, () => 0);

describe('F022-PAY payment-svc PG_SWITCH 받기 (B5·B6, ADR-0366 결정 2)', () => {
  test('F022-PAY ① 회차 범위 판 9 → 10: pg_switch에 active·from_pg null·to_pg·version·changed_at을 쓰고 다시 읽은 판을 답한다. 늦은 9·같은 10은 쓰지 않고 10을 답한다', async () => {
    const e = newId();
    const before = Date.now();
    const nine = await podA.control.apply(req({ scope: e, version: 9, desiredStateJson: sw(true, 'TOSS') }));
    expect(nine.appliedVersion).toBe(9);
    expect(nine.podName.startsWith(podA.name), nine.podName).toBe(true);
    const first = await switchOf(e);
    expect({ ...first, changed_at: undefined }).toEqual({ scope: e, active: true, from_pg: null, to_pg: 'TOSS', version: '9', changed_at: undefined });
    expect(first!.changed_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(first!.changed_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect((await podB.control.apply(req({ scope: e, version: 10, desiredStateJson: sw(true, 'PORTONE') }))).appliedVersion).toBe(10);
    const ten = await switchOf(e);
    expect({ active: ten!.active, to_pg: ten!.to_pg, version: ten!.version }).toEqual({ active: true, to_pg: 'PORTONE', version: '10' });
    // 늦게 온 9와 다시 온 10은 쓰지 않는다(다른 파드가 받아도 같다)
    expect((await podA.control.apply(req({ scope: e, version: 9, desiredStateJson: sw(false, null) }))).appliedVersion).toBe(10);
    expect((await podA.control.apply(req({ scope: e, version: 10, desiredStateJson: sw(false, null) }))).appliedVersion).toBe(10);
    expect(await switchOf(e)).toEqual(ten);
  });

  test('F022-PAY ② 전체 범위는 PLATFORM 행이고 끄기는 active 거짓으로 쓴다', async () => {
    const v = 1_763_870_000_000;
    expect((await podA.control.apply(req({ scope: 'PLATFORM', version: v, desiredStateJson: sw(true, null) }))).appliedVersion).toBe(v);
    expect(await switchOf('PLATFORM')).toMatchObject({ scope: 'PLATFORM', active: true, from_pg: null, to_pg: null, version: String(v) });
    expect((await podA.control.apply(req({ scope: 'PLATFORM', version: v + 1, desiredStateJson: sw(false, null) }))).appliedVersion).toBe(v + 1);
    expect(await switchOf('PLATFORM')).toMatchObject({ active: false, version: String(v + 1) });
  });

  const LOWER = '0193a000-0000-7000-8000-00000000a0b1';
  test.each([
    ['모르는 칸', LOWER, 7, '{"switched":true,"toPg":"TOSS","pgKey":"TOSS"}'],
    ['switched 없음', LOWER, 7, '{"toPg":"TOSS"}'],
    ['switched가 글', LOWER, 7, '{"switched":"true","toPg":"TOSS"}'],
    ['허용 밖 결제사', LOWER, 7, '{"switched":true,"toPg":"NAVERPAY"}'],
    ['대상이 시뮬레이터', LOWER, 7, '{"switched":true,"toPg":"SIMULATOR"}'],
    ['소문자 결제사', LOWER, 7, '{"switched":true,"toPg":"toss"}'],
    ['빈 글', LOWER, 7, ''],
    ['배열', LOWER, 7, '[true]'],
    ['회차 아닌 범위 글', 'REGION-1', 7, '{"switched":true,"toPg":"TOSS"}'],
    ['대문자 UUID 범위', LOWER.toUpperCase(), 7, '{"switched":true,"toPg":"TOSS"}'],
    ['빈 범위', '', 7, '{"switched":true,"toPg":"TOSS"}'],
    ['판 0', LOWER, 0, '{"switched":true,"toPg":"TOSS"}'],
    ['판 음수', LOWER, -1, '{"switched":true,"toPg":"TOSS"}'],
    ['판 2^53', LOWER, '9007199254740992', '{"switched":true,"toPg":"TOSS"}'],
  ])('F022-PAY ③ %s는 INVALID_ARGUMENT이고 pg_switch 쓰기 0', async (_name, scope, version, json) => {
    await expect(podA.control.apply(req({ scope, version, desiredStateJson: json }))).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await switchCount()).toBe(0);
  });

  test('F022-PAY ④ payment-svc가 받지 않는 종류(판매 일시정지)는 UNIMPLEMENTED이고 쓰기 0', async () => {
    await expect(podA.control.apply(req({ scope: newId(), kind: 'CONTROL_KIND_SALE_PAUSE', desiredStateJson: '{"paused":true}' }))).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
    expect(await switchCount()).toBe(0);
  });
});

describe('F022-SEL 받은 파드의 선택 캐시 비우기 (B7, ADR-0366 결정 2)', () => {
  test('F022-SEL ① 받은 파드는 1초 캐시를 기다리지 않고 바로 다음 결제 시도를 대체 결제사(switched 참)로 보낸다', async () => {
    const e = newId();
    const cached = Date.now();
    expect(await prepare(podA, e)).toMatchObject({ pg: 'PG_PROVIDER_SIMULATOR', switched: false });
    await podA.control.apply(req({ scope: e, version: 21, desiredStateJson: sw(true, null) }));
    const after = await prepare(podA, e);
    const elapsed = Date.now() - cached;
    expect(elapsed, '캐시 수명 안에서 본 값이어야 비우기를 본 것이다').toBeLessThan(CACHE_MS);
    expect(after).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: true });
  });

  test('F022-SEL ② 전체 범위 전환을 받으면 그 파드의 모든 회차 캐시를 비운다', async () => {
    const [e1, e2] = [newId(), newId()];
    const cached = Date.now();
    expect((await prepare(podA, e1)).pg).toBe('PG_PROVIDER_SIMULATOR');
    expect((await prepare(podA, e2)).pg).toBe('PG_PROVIDER_SIMULATOR');
    await podA.control.apply(req({ scope: 'PLATFORM', version: 31, desiredStateJson: sw(true, null) }));
    const got = [await prepare(podA, e1), await prepare(podA, e2)].map((r) => [r.pg, r.switched]);
    expect(Date.now() - cached).toBeLessThan(CACHE_MS);
    expect(got).toEqual([
      ['PG_PROVIDER_TOSS', true],
      ['PG_PROVIDER_TOSS', true],
    ]);
  });
});

describe('F022-READY 새 파드의 준비 조건 (B8, ADR-0366 결정 3)', () => {
  test('F022-READY ① pg_switch를 읽지 못하는 동안 새 파드는 준비가 아니고, 읽은 뒤 준비가 되어 대체 결제사로 보낸다', async () => {
    const e = newId();
    await podA.control.apply(req({ scope: e, version: 41, desiredStateJson: sw(true, null) }));
    const lock = new pg.Client({ connectionString: pgc!.url });
    await lock.connect();
    let late: Promise<StartedService> | undefined;
    let lateEnv: Awaited<ReturnType<typeof envOf>> | undefined;
    const lateLogs: string[] = [];
    try {
      await lock.query('begin');
      await lock.query('lock table pg_switch in access exclusive mode');
      lateEnv = await envOf('payment-f022-late');
      late = start({ env: lateEnv.env, logDestination: sinkInto(lateLogs) });
      late.catch(() => undefined);
      // 읽기가 막혀 있는 동안의 준비 상태를 여러 번 본다(조건이 아니라 '되지 않음'을 보는 자리라 표본 간격을 둔다)
      const seen: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        seen.push(await ready(lateEnv));
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(seen.filter((s) => s === 200), `막힌 동안 본 /ready 답: ${seen.join(',')}`).toEqual([]);
    } finally {
      await lock.query('commit').catch(() => undefined);
      await lock.end();
    }
    const svc = await late!;
    await until(() => ready(lateEnv!), (s) => s === 200, '늘린 파드 준비', { timeoutMs: 30_000 });
    const pod: Pod = { name: 'payment-f022-late', control: controlClient(`127.0.0.1:${lateEnv!.controlPort}`), grpc: paymentClient(`127.0.0.1:${svc.ports.grpcPort}`), managementPort: lateEnv!.managementPort, logs: lateLogs, svc };
    pods.push(pod);
    try {
      expect(await prepare(pod, e)).toMatchObject({ pg: 'PG_PROVIDER_TOSS', switched: true });
    } finally {
      await stopPod(pod);
    }
  }, 90_000);
});

describe('F022-REL payment-svc 해제 받기 (B14·B15, ADR-0366 결정 9)', () => {
  test('F022-REL ⑦ 정지 since = 판 − 1ms와 판 정각은 열고(actor는 받은 요청자 계정 ID), 판 + 1ms(명령 뒤 새로 걸린 정지)는 열지 않고 그 판을 답한다', async () => {
    // 경우마다 더 큰 판을 같은 파드에 보낸다(파드 메모리의 '받은 가장 큰 판'이 since 조건을 가리지 않게)
    const base = 1_763_870_400_000;
    const cases: [string, number, number, string][] = [
      ['판 − 1ms', base, base - 1, 'OPEN'],
      ['판 정각', base + 10_000, base + 10_000, 'OPEN'],
      ['판 + 1ms', base + 20_000, base + 20_001, 'PROBING'],
    ];
    const got: Record<string, unknown>[] = [];
    for (const [label, v, since] of cases) {
      await admin.pool.query('truncate payment_entry_pause');
      await putPause('TOSS', since, 3);
      const ack = await podA.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: v, desiredStateJson: rel('TOSS') }));
      const row = await pauseOf('TOSS');
      got.push({ label, applied: ack.appliedVersion - v, stage: row?.stage, actor: row?.actor, reopened: row?.reopened_at !== null });
    }
    expect(got).toEqual([
      { label: '판 − 1ms', applied: 0, stage: 'OPEN', actor: ACTOR, reopened: true },
      { label: '판 정각', applied: 0, stage: 'OPEN', actor: ACTOR, reopened: true },
      { label: '판 + 1ms', applied: 0, stage: 'PROBING', actor: 'SYSTEM', reopened: false },
    ]);
  });

  test('F022-REL ⑧ 같은 판을 다시 받으면 쓰지 않고, 파드를 다시 띄운 뒤 같은 판을 받아도 그 뒤 새로 걸린 정지를 열지 않는다', async () => {
    const v = 1_763_870_500_000;
    await putPause('PORTONE', v - 60_000, 5);
    expect((await podA.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: v, desiredStateJson: rel('PORTONE') }))).appliedVersion).toBe(v);
    const opened = await pauseOf('PORTONE');
    expect(opened?.stage).toBe('OPEN');
    expect((await podA.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: v, desiredStateJson: rel('PORTONE') }))).appliedVersion).toBe(v);
    expect(await pauseOf('PORTONE')).toEqual(opened);
    // 명령 뒤에 자동 정지가 새로 걸린다(since > 판)
    await admin.pool.query(`update payment_entry_pause set stage = 'PROBING', actor = 'SYSTEM', since = $1, version = version + 1 where pg = 'PORTONE'`, [new Date(v + 5_000)]);
    const repaused = await pauseOf('PORTONE');
    // 파드를 다시 띄워 메모리의 판을 잃게 한다
    await stopPod(podA);
    podA = await startPod('payment-f022-a');
    await until(() => ready(podA), (s) => s === 200, '다시 띄운 파드 준비', { timeoutMs: 30_000 });
    expect((await podA.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: v, desiredStateJson: rel('PORTONE') }))).appliedVersion).toBe(v);
    expect(await pauseOf('PORTONE')).toEqual(repaused);
  }, 90_000);

  test('F022-REL ⑨ 해제를 받은 파드는 정지 캐시를 바로 비워 1초를 기다리지 않고 그 결제사 새 결제 시도를 통과시킨다', async () => {
    const e = newId();
    await assignTo(e, 'TOSS', null);
    const v = Date.now();
    await putPause('TOSS', v - 30_000, 2);
    // 이 파드가 정지를 읽어 캐시에 둘 때까지(조건 대기)
    await expect.poll(async () => (await failure(prepare(podB, e))).details, { timeout: 10_000, interval: 100 }).toBe('new-payment-paused');
    const cached = Date.now();
    await podB.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: v, desiredStateJson: rel('TOSS') }));
    const r = await prepare(podB, e);
    expect(Date.now() - cached, '캐시 수명 안에서 본 값이어야 비우기를 본 것이다').toBeLessThan(CACHE_MS);
    expect(r).toMatchObject({ pg: 'PG_PROVIDER_TOSS' });
    expect(await pauseOf('TOSS')).toMatchObject({ stage: 'OPEN' });
  });

  test.each([
    ['모르는 칸', JSON.stringify({ pg: 'TOSS', actor: ACTOR, reason: 'x' })],
    ['pg 없음', JSON.stringify({ actor: ACTOR })],
    ['허용 밖 결제사', rel('NAVERPAY')],
    ['actor 없음', '{"pg":"TOSS"}'],
    ['빈 actor', rel('TOSS', '')],
    ['129자 actor', rel('TOSS', 'a'.repeat(129))],
    ['actor가 수', '{"pg":"TOSS","actor":7}'],
  ])('F022-REL ⑩ 해제의 %s는 INVALID_ARGUMENT이고 정지 행이 그대로다', async (_name, json) => {
    await putPause('TOSS', Date.now() - 30_000, 4);
    const before = await pauseOf('TOSS');
    await expect(podA.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: Date.now(), desiredStateJson: json }))).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await pauseOf('TOSS')).toEqual(before);
  });

  test('F022-REL ⑫ actor 128자(상한 경계)는 받고 그 값으로 연다', async () => {
    await putPause('TOSS', Date.now() - 30_000, 4);
    const actor = 'b'.repeat(128);
    const v = Date.now();
    expect((await podA.control.apply(req({ kind: RELEASE, scope: 'PLATFORM', version: v, desiredStateJson: rel('TOSS', actor) }))).appliedVersion).toBe(v);
    expect(await pauseOf('TOSS')).toMatchObject({ stage: 'OPEN', actor });
  });

  test('F022-REL ⑪ 해제는 전체 범위만 받는다(회차 범위는 INVALID_ARGUMENT)', async () => {
    await putPause('TOSS', Date.now() - 30_000, 4);
    await expect(podA.control.apply(req({ kind: RELEASE, scope: newId(), version: Date.now(), desiredStateJson: rel('TOSS') }))).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect((await pauseOf('TOSS'))?.stage).toBe('PROBING');
  });
});

describe('F022-RES payment-svc ResolvePgSwitch (B2~B4, ADR-0366 결정 5, 계획 14절 3)', () => {
  type Route = { event_id: string; pg: string; approvals_per_second: number };
  const resolve = (p: Pod, body: Record<string, unknown>) => unary(p.grpc, 'ResolvePgSwitch', body);
  const routesOf = (r: Record<string, unknown>) => [...((r.routes ?? []) as Route[])].sort((a, b) => a.event_id.localeCompare(b.event_id)).map((x) => [x.event_id, x.pg, Number(x.approvals_per_second)]);
  const limitsOf = (r: Record<string, unknown>) => Object.fromEntries(((r.approval_limits ?? []) as { pg: string; approvals_per_second: number }[]).map((l) => [l.pg, Number(l.approvals_per_second)]));

  test('F022-RES ⑤ 대체를 지정한 회차는 그 대체, 지정 없는 회차는 플랫폼 대체로 가고 승인 상한을 싣는다. 아무것도 쓰지 않는다', async () => {
    const [e1, e2] = [newId(), newId()].sort();
    await assignTo(e1!, 'TOSS', 'PORTONE');
    const r = await resolve(podA, { event_ids: [e1, e2], to_pg: 'PG_PROVIDER_UNSPECIFIED' });
    expect(routesOf(r)).toEqual([
      [e1, 'PG_PROVIDER_PORTONE', TPS.PORTONE],
      [e2, 'PG_PROVIDER_TOSS', TPS.TOSS],
    ]);
    expect(limitsOf(r)).toEqual({ PG_PROVIDER_TOSS: TPS.TOSS, PG_PROVIDER_PORTONE: TPS.PORTONE });
    expect(await switchCount()).toBe(0);
  });

  test('F022-RES ⑥ to_pg가 있으면 회차마다 그 결제사로 간다', async () => {
    const e = newId();
    await assignTo(e, 'TOSS', null);
    const r = await resolve(podA, { event_ids: [e], to_pg: 'PG_PROVIDER_PORTONE' });
    expect(routesOf(r)).toEqual([[e, 'PG_PROVIDER_PORTONE', TPS.PORTONE]]);
  });

  test('F022-RES ⑦ 회차 0개는 받고(전체 범위용) 상한만 준다', async () => {
    const r = await resolve(podA, { event_ids: [], to_pg: 'PG_PROVIDER_UNSPECIFIED' });
    expect(routesOf(r)).toEqual([]);
    expect(limitsOf(r)).toEqual({ PG_PROVIDER_TOSS: TPS.TOSS, PG_PROVIDER_PORTONE: TPS.PORTONE });
  });

  test.each([
    ['대문자 회차', () => ({ event_ids: [newId().toUpperCase()] })],
    ['회차 101개', () => ({ event_ids: Array.from({ length: 101 }, () => newId()) })],
    ['UUID 아닌 회차', () => ({ event_ids: ['not-an-event'] })],
  ])('F022-RES ⑧ %s는 INVALID_ARGUMENT다', async (_name, body) => {
    const err = await failure(resolve(podA, body()));
    expect(err.code).toBe(status.INVALID_ARGUMENT);
  });

  test('F022-RES ⑨ 회차 100개는 받는다(상한 경계)', async () => {
    const ids = Array.from({ length: 100 }, () => newId());
    const r = await resolve(podA, { event_ids: ids });
    expect(routesOf(r)).toHaveLength(100);
  });
});
