// F-02-1(OPS-300) 판 번호 원장과 파드별 ack 기록을 실제 PostgreSQL 18로 본다(마이그레이션 0025 control_version·command_delivery).
// test/f021-control-dispatch.test.ts의 원장 규칙(F021-VER)을 진짜 저장소 DrizzleCommandStore에도 돌려 메모리 저장소와 짝을 맞추고(행동 짝),
// 파드마다의 ack가 REST 상세의 CommandState.delivery(kind ACK, ackedCount, targetCount, unackedTargets)로 보이는지 본다.
// 정본: ADR-0365 결정 1·4, openapi CommandState.delivery. 받는 쪽은 ControlSender 포트를 구현한 대역이다(실제 받는 쪽 연결은 f021-e2e-control.int.test.ts).
// 쓰는 공개 면은 test/f021-control-dispatch.test.ts 머리말과 같고, ack 기록은 DrizzleControlDeliveries(구현 메모 '시험 담당에게')다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, type Clock, type Database, fakeClock } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { type Command, type CommandType, ControlDispatcher, ControlFanout, type ControlTargets, type ControlTransport, DrizzleCommandStore, DrizzleControlDeliveries } from '../src/modules/commands/index.js';

type ControlRequest = Parameters<ControlTransport['apply']>[2];
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands } from './reauth.js';

const T = Date.parse('2026-11-23T04:00:00.000Z');
const REQUESTER = '0193a000-0000-7000-8000-0000000000f2';
type Service = 'admission-ctrl' | 'purchase-svc' | 'queue-svc';
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let store: DrizzleCommandStore;
let deliveries: DrizzleControlDeliveries;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-f021-ledger-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  store = new DrizzleCommandStore(db);
  deliveries = new DrizzleControlDeliveries(db);
  // 상세가 delivery를 싣도록 같은 ack 기록을 모듈에 넘긴다(보내기는 아래 시험마다 만든 ControlFanout이 한다)
  const idleFanout = new ControlFanout({ targets: { resolve: async () => [] }, transport: { apply: async () => ({ appliedVersion: 0, podName: '' }) }, clock: { now: () => T } });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, nowMs: T, adminAccounts: adminAccountsForCommands, commandExtras: { control: { fanout: idleFanout, deliveries } } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: T }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 120_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

function world(o: { targets: Partial<Record<Service, readonly string[]>>; lagging?: readonly string[]; start?: number }) {
  let wall = o.start ?? T;
  let mono = 0;
  const clock: Clock = { now: () => wall, monotonicMs: () => mono };
  const sent: { address: string; req: ControlRequest }[] = [];
  const targets: ControlTargets = { resolve: async (service: string) => o.targets[service as Service] ?? [] };
  const transport: ControlTransport = {
    apply: async (service: string, address: string, req: ControlRequest) => {
      sent.push({ address, req });
      return { appliedVersion: o.lagging?.includes(address) ? req.version - 1 : req.version, podName: `${service}-${address.replace(/[.:]/g, '-')}` };
    },
  };
  const sleep = async (ms: number) => {
    wall += ms;
    mono += ms;
  };
  const d = new ControlDispatcher({ store, fanout: new ControlFanout({ targets, transport, deliveries, clock, sleep }), clock });
  /** 보내기를 끝까지 기다리고 끝난 명령을 돌려준다 */
  const dispatcher = {
    dispatch: async (c: Command) => (await d.resume(c.commandId), (await store.find(c.commandId))!),
    resume: async (commandId: string) => (await d.resume(commandId), (await store.find(commandId))!),
  };
  const dispatched = async (type: CommandType, params: Record<string, unknown>, eventId?: string): Promise<Command> => {
    const c = await store.create({ commandId: randomUUID(), type, reason: '온세일 대응', params, requestedBy: REQUESTER, requestedRole: 'commander', nowMs: wall, approvalMode: 'ONE', ...(eventId ? { eventId } : {}) });
    return store.markDispatched(c.commandId, wall);
  };
  return { sent, dispatcher, dispatched, setNow: (ms: number) => void (wall = ms) };
}
const versionsOf = (sent: readonly { req: ControlRequest }[], commandId: string) => [...new Set(sent.filter((s) => s.req.commandId === commandId).map((s) => s.req.version))];

describe('F021-VER 원장 규칙의 진짜 저장소 짝 (B1·B2, PostgreSQL)', () => {
  test('F021-VER ⑦ 마이그레이션 0025가 control_version·command_delivery 표를 만든다', async () => {
    const { rows } = await admin.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('control_version', 'command_delivery') order by table_name");
    expect(rows.map((r) => r.table_name)).toEqual(['command_delivery', 'control_version']);
  });

  test('F021-VER ⑧ 첫 판은 지금 밀리초, 같은 밀리초 다음 명령은 + 1, 시계가 되돌아가도 + 1, 다른 종류는 따로다(메모리 저장소와 같은 답)', async () => {
    const w = world({ targets: { 'admission-ctrl': ['10.9.0.1:50061'] } });
    const e = randomUUID();
    const a = await w.dispatcher.dispatch(await w.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    const b = await w.dispatcher.dispatch(await w.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    w.setNow(T - 60_000);
    const c = await w.dispatcher.dispatch(await w.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    w.setNow(T);
    const other = await w.dispatcher.dispatch(await w.dispatched('ADMISSION_TARGET', { eventId: e, target: 3_000 }, e));
    expect([a, b, c, other].map((x) => x.state)).toEqual(['ACKED', 'ACKED', 'ACKED', 'ACKED']);
    expect([a, b, c, other].map((x) => versionsOf(w.sent, x.commandId))).toEqual([[T], [T + 1], [T + 2], [T]]);
  });

  test('F021-VER ⑨ 같은 명령의 이어 보내기(resume)는 원장에 남은 판 그대로다', async () => {
    const w = world({ targets: { 'admission-ctrl': ['10.9.0.1:50061'] }, start: T + 3_600_000 });
    const e = randomUUID();
    const c = await w.dispatched('ADMISSION_PAUSE', { eventId: e }, e);
    w.setNow(T + 3_600_000 + 3_000);
    const resumed = await w.dispatcher.resume(c.commandId);
    expect(resumed?.state).toBe('ACKED');
    expect(versionsOf(w.sent, c.commandId)).toEqual([T + 3_600_000]);
  });
});

describe('F021-ACK 파드별 ack 기록과 delivery (B6·B8)', () => {
  const detail = async (commandId: string) => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/commands/${commandId}`, headers: identity.ops('commander') });
    expect(r.statusCode).toBe(200);
    return (JSON.parse(r.payload) as { delivery?: unknown }).delivery;
  };

  test('F021-ACK ⑦ 모두 ack한 명령 3의 상세 delivery는 kind ACK, 대상 수와 ack 수가 같고 남은 대상이 없다', async () => {
    const w = world({ targets: { 'purchase-svc': ['10.9.1.1:50061', '10.9.1.2:50061'], 'admission-ctrl': ['10.9.2.1:50061'], 'queue-svc': ['10.9.3.1:50061'] } });
    const c = await w.dispatcher.dispatch(await w.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [randomUUID()] }));
    expect(c.state).toBe('ACKED');
    expect(await detail(c.commandId)).toEqual({ kind: 'ACK', ackedCount: 4, targetCount: 4, unackedTargets: [] });
  });

  test('F021-ACK ⑧ 한 파드가 낮은 판만 답해 FAILED면 delivery에 그 파드가 남은 대상으로 보인다', async () => {
    const w = world({ targets: { 'purchase-svc': ['10.9.1.1:50061', '10.9.1.2:50061'], 'admission-ctrl': ['10.9.2.1:50061'], 'queue-svc': ['10.9.3.1:50061'] }, lagging: ['10.9.1.2:50061'] });
    const c = await w.dispatcher.dispatch(await w.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [randomUUID()] }));
    expect(c).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:purchase-svc' });
    const d = (await detail(c.commandId)) as { kind: string; ackedCount: number; targetCount: number; unackedTargets: string[] };
    expect({ kind: d.kind, ackedCount: d.ackedCount, targetCount: d.targetCount }).toEqual({ kind: 'ACK', ackedCount: 3, targetCount: 4 });
    expect(d.unackedTargets).toHaveLength(1);
    expect(d.unackedTargets[0]).toMatch(/10-9-1-2|10\.9\.1\.2/);
  });
});
