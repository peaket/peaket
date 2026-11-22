// F-02-2(OPS-310) ops-svc 명령 6 결제 갈래의 보내기를 바깥 HTTP 경계에서 본다: 대체 결제사 전환(PAYMENT_PG_FALLBACK)과 해제만 하는 명령(PAYMENT_ENTRY_RELEASE).
// 정본: ADR-0366 결정 1(범위마다 CONTROL_KIND_PG_SWITCH를 payment-svc 준비된 모든 파드와 admission-ctrl 리더에, 둘 다 판 이상을 답해야 ACKED),
// 결정 2(payment 바라는 상태 {"switched", "toPg": TOSS|PORTONE|null}), 결정 4·5(admission 바라는 상태 {"switched", "pgKey", "pgTps"}: 회차는 pgKey = 갈 결제사,
// pgTps = 내림(승인 상한), 1 미만이면 1. 전체 범위는 toPg가 있으면 그 결제사, 없으면 PG_FALLBACK과 TOSS·PORTONE 상한의 최솟값. 처음 DISPATCHED 전에
// ResolvePgSwitch를 묻고 실패하면 명령을 보내지 않고 503 pg-check-unavailable), 결정 6(ACKED와 같은 쓰기의 DEGRADED_MODE 설정 사건 하나, occurredAt = 판),
// 결정 7(되돌리기는 commander·재인증, 새 판의 끄기 뒤 TOSS·PORTONE 해제, 모두 ack해야 REVERTED, 아니면 502 command-dispatch-failed·ACKED 그대로·REVERT_FAILED), 결정 8(해제 명령: {mode, pg}, commander 1인·승인 대기 없음·재인증,
// CONTROL_KIND_ENTRY_PAUSE_RELEASE 범위 PLATFORM {"pg", "actor": 요청자 관리 계정 ID}를 payment-svc 모든 파드에, 되돌리기 409 command-not-revertible, SIMULATOR는 local·ci만),
// ADR-0365 결정 4(1초 다시 보내기·처음 보낸 때부터 10초면 FAILED ack-timeout:<서비스>), 계획 6절 B1~B4·B11~B13, 9절, 13절.
// 짝: 받는 쪽은 ControlTransport 포트 대역(GrpcControlTransport와 같은 꼴), 대상 찾기는 ControlTargets 대역, 회차 결제사·상한 묻기는 PgSwitchResolver 포트 대역
// (진짜 gRPC 어댑터는 test-int/f022-pg-switch-e2e.int.test.ts가 실제 payment-svc에 돌린다), 재인증은 제품 JwksApprovalVerifier + 시험 키(admin-support.ts).
// 시계는 서비스 가짜 시계 하나이고 퍼뜨리기의 대기가 그 시계를 민다.
// 회차 결제사 묻기 포트는 CommandsModuleExtras.control.pgSwitch(PgSwitchResolver)이고(구현 메모 '시험 담당에게', local·ci 조립은 control.simulatorPg 참)
// resolve({ eventIds, toPg? }) → { routes: [{ eventId, pg, approvalsPerSecond }], approvalLimits: { TOSS?, PORTONE? } }다. 받는 쪽 서비스 이름은 'payment-svc'다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { controlEventCodec, createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { COMMAND_STORE, ControlFanout, type ControlTargets, type ControlTransport, MemoryCommandStore, MemoryControlDeliveries, type PgSwitchResolver } from '../src/modules/commands/index.js';
import { reauthKit, type ReauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T06:00:00.000Z');
const ACK_TIMEOUT_MS = 10_000;
type Headers = Record<string, string>;
type ControlRequest = Parameters<ControlTransport['apply']>[2];
type Resolved = Awaited<ReturnType<PgSwitchResolver['resolve']>>;

const PAYMENT_PODS = ['10.9.0.11:50061', '10.9.0.12:50061'] as const;
const LEADER = '10.9.0.21:50061';

interface Sent {
  readonly service: string;
  readonly address: string;
  readonly at: number;
  readonly req: ControlRequest;
}

/** 회차 결제사 묻기 짝 가짜: 정해 둔 답을 돌려주고 받은 질문을 남긴다 */
class FakePgSwitch implements PgSwitchResolver {
  readonly calls: { eventIds: readonly string[]; toPg?: string }[] = [];
  answer: (q: { eventIds: readonly string[]; toPg?: string }) => Resolved | Error = () => ({ routes: [], approvalLimits: {} });
  async resolve(q: Parameters<PgSwitchResolver['resolve']>[0]): Promise<Resolved> {
    this.calls.push({ eventIds: [...q.eventIds], ...(q.toPg !== undefined ? { toPg: q.toPg } : {}) });
    const a = this.answer(q);
    if (a instanceof Error) throw a;
    return a;
  }
}

interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly kit: ReauthKit;
  readonly audit: MemoryAuditChain;
  readonly store: MemoryCommandStore;
  readonly sent: Sent[];
  readonly resolver: FakePgSwitch;
  /** 주소마다의 답: 적용 판(기본은 받은 판), 또는 던질 오류 */
  readonly answer: Map<string, (req: ControlRequest) => number | Error>;
  post(url: string, who: Headers, body: unknown): Promise<{ statusCode: number; payload: string }>;
  get(url: string, who: Headers): Promise<{ statusCode: number; payload: string }>;
  withToken(who: Headers): Headers;
}

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
});

async function harness(o: { simulatorPg?: boolean } = {}): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const kit = reauthKit(() => clock.now());
  const audit = new MemoryAuditChain();
  const sent: Sent[] = [];
  const answer = new Map<string, (req: ControlRequest) => number | Error>();
  const targets: ControlTargets = {
    resolve: async (service: string) => (service === 'payment-svc' ? [...PAYMENT_PODS] : service === 'admission-ctrl' ? [LEADER] : []),
  };
  const transport: ControlTransport = {
    apply: async (service: string, address: string, req: ControlRequest) => {
      sent.push({ service, address, at: clock.now(), req });
      const r = (answer.get(address) ?? ((x: ControlRequest) => x.version))(req);
      if (r instanceof Error) throw r;
      return { appliedVersion: r, podName: `${service}-${address}` };
    },
  };
  const deliveries = new MemoryControlDeliveries();
  const fanout = new ControlFanout({ targets, transport, deliveries, clock, sleep: async (ms: number) => clock.advance(ms) });
  const resolver = new FakePgSwitch();
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      adminAccounts: { identity: new UnavailableAdminIdentity(), reauth: kit.verifier },
      commandExtras: { control: { fanout, deliveries, clock, pgSwitch: resolver, simulatorPg: o.simulatorPg ?? true } },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const found: unknown = svc.app.get(COMMAND_STORE);
  if (!(found instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
  const h: Harness = {
    svc,
    clock,
    identity,
    kit,
    audit,
    store: found,
    sent,
    resolver,
    answer,
    post: (url, who, body) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url, who) => svc.http.inject({ method: 'GET', url, headers: who }),
    withToken: (who) => ({ ...who, 'x-reauth-token': kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'OPS_COMMAND' }) }),
  };
  opened.push(h);
  return h;
}

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '').split('/').pop();
const fallback = (params: Record<string, unknown>) => ({ type: 'DEGRADED_MODE', reason: '결제사 장애 대응', params: { mode: 'PAYMENT_PG_FALLBACK', ...params } });
const release = (params: Record<string, unknown>) => ({ type: 'DEGRADED_MODE', reason: '자동 정지 잘못 걸림 해제', params: { mode: 'PAYMENT_ENTRY_RELEASE', ...params } });
const stateOf = async (h: Harness, id: string, who: Headers) => json(await h.get(`/v1/ops/commands/${id}`, who)).state as string;
const settle = async (h: Harness, id: string, who: Headers, want: string) => expect.poll(() => stateOf(h, id, who), { timeout: 5_000, interval: 10 }).toBe(want);
const desired = (s: Sent) => JSON.parse(s.req.desiredStateJson) as Record<string, unknown>;
const sentFor = (h: Harness, commandId: string) => h.sent.filter((s) => s.req.commandId === commandId);
/** 같은 (주소, 범위, 종류, 판, 바라는 상태)의 다시 보내기를 하나로 접는다(되돌리기의 TOSS·PORTONE 해제는 같은 판이다) */
const distinct = (xs: readonly Sent[]) => [...new Map(xs.map((s) => [`${s.address}|${s.req.scope}|${s.req.kind}|${s.req.version}|${s.req.desiredStateJson}`, s])).values()];

/** commander가 내고 다른 operator가 승인한 결제 갈래 명령 */
async function approvedFallback(h: Harness, params: Record<string, unknown>): Promise<{ id: string; commander: Headers; approve: { statusCode: number; payload: string } }> {
  const commander = h.identity.ops('commander');
  const op = h.identity.ops('operator');
  const created = await h.post('/v1/ops/commands', h.withToken(commander), fallback(params));
  expect(created.statusCode, created.payload).toBe(201);
  const id = json(created).commandId as string;
  const approve = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(op), {});
  return { id, commander, approve };
}

describe('F022-RES 보내기 전 묻기와 받는 쪽별 바라는 상태 (B2~B4, ADR-0366 결정 4·5)', () => {
  test('F022-RES ① 회차 둘·toPg 없음: 승인 뒤 ResolvePgSwitch를 한 번 묻고, 회차마다 payment 두 파드에 {switched:true,toPg:null}, 리더에 갈 결제사와 내림 상한(1 미만은 1)을 보낸다', async () => {
    const h = await harness();
    const [e1, e2] = [randomUUID(), randomUUID()].sort();
    h.resolver.answer = () => ({ routes: [{ eventId: e1!, pg: 'PORTONE', approvalsPerSecond: 37.9 }, { eventId: e2!, pg: 'TOSS', approvalsPerSecond: 0.4 }], approvalLimits: { PORTONE: 37.9, TOSS: 0.4 } });
    const { id, commander, approve } = await approvedFallback(h, { scope: 'EVENT', eventIds: [e1, e2] });
    expect(approve.statusCode, approve.payload).toBe(200);
    await settle(h, id, commander, 'ACKED');
    expect(h.resolver.calls).toEqual([{ eventIds: [e1, e2] }]);
    const out = distinct(sentFor(h, id)).map((s) => ({ service: s.service, address: s.address, scope: s.req.scope, kind: s.req.kind, state: desired(s) }));
    const byAddr = (a: string, e: string) => out.filter((x) => x.address === a && x.scope === e);
    for (const e of [e1!, e2!]) for (const pod of PAYMENT_PODS) expect(byAddr(pod, e)).toEqual([{ service: 'payment-svc', address: pod, scope: e, kind: 'CONTROL_KIND_PG_SWITCH', state: { switched: true, toPg: null } }]);
    expect(byAddr(LEADER, e1!)).toEqual([{ service: 'admission-ctrl', address: LEADER, scope: e1, kind: 'CONTROL_KIND_PG_SWITCH', state: { switched: true, pgKey: 'PORTONE', pgTps: 37 } }]);
    expect(byAddr(LEADER, e2!)).toEqual([{ service: 'admission-ctrl', address: LEADER, scope: e2, kind: 'CONTROL_KIND_PG_SWITCH', state: { switched: true, pgKey: 'TOSS', pgTps: 1 } }]);
    // 대상은 정확히 회차 둘 × (payment 두 파드 + 리더)
    expect(out).toHaveLength(6);
  });

  test('F022-RES ② 전체 범위·toPg PORTONE: payment에 {switched:true,toPg:PORTONE}, 리더에 PORTONE과 그 상한의 내림을 범위 PLATFORM으로 보낸다', async () => {
    const h = await harness();
    h.resolver.answer = () => ({ routes: [], approvalLimits: { TOSS: 55.5, PORTONE: 23.9 } });
    const { id, commander, approve } = await approvedFallback(h, { scope: 'PLATFORM', toPg: 'PORTONE' });
    expect(approve.statusCode, approve.payload).toBe(200);
    await settle(h, id, commander, 'ACKED');
    expect(h.resolver.calls).toEqual([{ eventIds: [], toPg: 'PORTONE' }]);
    const out = distinct(sentFor(h, id));
    expect(out.map((s) => s.req.scope)).toEqual(['PLATFORM', 'PLATFORM', 'PLATFORM']);
    expect(out.filter((s) => s.service === 'payment-svc').map(desired)).toEqual([
      { switched: true, toPg: 'PORTONE' },
      { switched: true, toPg: 'PORTONE' },
    ]);
    expect(out.filter((s) => s.service === 'admission-ctrl').map(desired)).toEqual([{ switched: true, pgKey: 'PORTONE', pgTps: 23 }]);
  });

  test('F022-RES ③ 전체 범위·toPg 없음: 리더에 PG_FALLBACK과 TOSS·PORTONE 상한의 최솟값(내림)을 보낸다', async () => {
    const h = await harness();
    h.resolver.answer = () => ({ routes: [], approvalLimits: { TOSS: 55.5, PORTONE: 23.9 } });
    const { id, commander } = await approvedFallback(h, { scope: 'PLATFORM' });
    await settle(h, id, commander, 'ACKED');
    const leader = distinct(sentFor(h, id)).filter((s) => s.service === 'admission-ctrl');
    expect(leader.map((s) => [s.req.scope, desired(s)])).toEqual([['PLATFORM', { switched: true, pgKey: 'PG_FALLBACK', pgTps: 23 }]]);
    expect(distinct(sentFor(h, id)).filter((s) => s.service === 'payment-svc').map(desired)).toEqual([
      { switched: true, toPg: null },
      { switched: true, toPg: null },
    ]);
  });

  test('F022-RES ④ (B2) ResolvePgSwitch가 실패하면 승인은 503 pg-check-unavailable이고 아무 받는 쪽도 부르지 않으며 명령은 DISPATCHED가 되지 않는다', async () => {
    const h = await harness();
    h.resolver.answer = () => new Error('UNAVAILABLE');
    const { id, commander, approve } = await approvedFallback(h, { scope: 'EVENT', eventIds: [randomUUID()] });
    expect(approve.statusCode, approve.payload).toBe(503);
    expect(slug(approve)).toBe('pg-check-unavailable');
    expect(h.resolver.calls).toHaveLength(1);
    expect(sentFor(h, id)).toEqual([]);
    expect(await stateOf(h, id, commander)).toBe('PENDING_APPROVAL');
    expect(h.store.eventsOf(id).map((e) => e.type)).not.toContain('DISPATCHED');
  });
});

describe('F022-ACK 두 받는 쪽 모두의 ack (B1, ADR-0366 결정 1, ADR-0365 결정 4)', () => {
  const route = (eventId: string): Resolved => ({ routes: [{ eventId, pg: 'PORTONE', approvalsPerSecond: 30 }], approvalLimits: { PORTONE: 30 } });

  test('F022-ACK ① payment 한 파드가 판보다 낮게 답하면 10초 뒤 FAILED(ack-timeout:payment-svc)이고, 그동안 같은 판으로 다시 보낸다', async () => {
    const h = await harness();
    const e = randomUUID();
    h.resolver.answer = () => route(e);
    h.answer.set(PAYMENT_PODS[1], (req) => req.version - 1);
    const { id, commander } = await approvedFallback(h, { scope: 'EVENT', eventIds: [e] });
    await settle(h, id, commander, 'FAILED');
    const detail = json(await h.get(`/v1/ops/commands/${id}`, commander));
    expect(detail.lastError).toBe('ack-timeout:payment-svc');
    const toBad = sentFor(h, id).filter((s) => s.address === PAYMENT_PODS[1]);
    expect(new Set(toBad.map((s) => s.req.version)).size, '다시 보내기는 같은 판이다').toBe(1);
    expect(toBad.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...toBad.map((s) => s.at)) - toBad[0]!.at).toBeLessThanOrEqual(ACK_TIMEOUT_MS);
  });

  test('F022-ACK ② 리더가 ack하지 않으면 payment 두 파드가 모두 받아도 ACKED가 아니다(FAILED ack-timeout:admission-ctrl)', async () => {
    const h = await harness();
    const e = randomUUID();
    h.resolver.answer = () => route(e);
    h.answer.set(LEADER, () => Object.assign(new Error('not-leader'), { code: 14 }));
    const { id, commander } = await approvedFallback(h, { scope: 'EVENT', eventIds: [e] });
    await settle(h, id, commander, 'FAILED');
    expect(json(await h.get(`/v1/ops/commands/${id}`, commander)).lastError).toBe('ack-timeout:admission-ctrl');
    expect(h.store.outboxSettings(), 'ACKED가 아니면 설정 사건도 없다').toEqual([]);
  });

  test('F022-ACK ③ 9초 동안 답하지 않던 payment 파드가 돌아오면 같은 판의 다시 보내기로 ACKED이고, 전파 상태는 대상 셋 모두 ack다', async () => {
    const h = await harness();
    const e = randomUUID();
    h.resolver.answer = () => route(e);
    let firstAt: number | undefined;
    h.answer.set(PAYMENT_PODS[0], (req) => {
      firstAt ??= h.clock.now();
      return h.clock.now() - firstAt < 9_000 ? new Error('UNAVAILABLE') : req.version;
    });
    const { id, commander } = await approvedFallback(h, { scope: 'EVENT', eventIds: [e] });
    await settle(h, id, commander, 'ACKED');
    const toPod = sentFor(h, id).filter((s) => s.address === PAYMENT_PODS[0]);
    expect(toPod.filter((s) => s.at - firstAt! < 9_000).length, '끊긴 동안 보낸 수').toBeGreaterThanOrEqual(2);
    expect(new Set(toPod.map((s) => s.req.version)).size).toBe(1);
    expect(json(await h.get(`/v1/ops/commands/${id}`, commander)).delivery).toEqual({ kind: 'ACK', ackedCount: 3, targetCount: 3, unackedTargets: [] });
  });
});

describe('F022-SET ACKED와 같은 쓰기의 설정 사건 (B11, ADR-0366 결정 6)', () => {
  test('F022-SET ① 회차 하나 전환이 ACKED면 DEGRADED_MODE 설정 사건 하나(키 <회차>:DEGRADED_MODE:PAYMENT_PG_FALLBACK, 값 enabled 참, occurredAt = 보낸 판)를 남긴다', async () => {
    const h = await harness();
    const e = randomUUID();
    h.resolver.answer = () => ({ routes: [{ eventId: e, pg: 'TOSS', approvalsPerSecond: 40 }], approvalLimits: { TOSS: 40 } });
    h.clock.advance(4_321);
    const { id, commander } = await approvedFallback(h, { scope: 'EVENT', eventIds: [e] });
    await settle(h, id, commander, 'ACKED');
    const versions = [...new Set(sentFor(h, id).map((s) => s.req.version))];
    expect(versions).toHaveLength(1);
    const rows = h.store.outboxSettings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message.key).toBe(`${e}:DEGRADED_MODE:PAYMENT_PG_FALLBACK`);
    expect(controlEventCodec.setting(Buffer.from(rows[0]!.message.payload))).toMatchObject({ commandId: id, key: 'DEGRADED_MODE', scope: e, value: { enabled: true }, occurredAt: versions[0] });
  });
});

describe('F022-REV 결제 갈래 되돌리기 (B12, ADR-0366 결정 7)', () => {
  async function acked(h: Harness, e: string) {
    h.resolver.answer = () => ({ routes: [{ eventId: e, pg: 'PORTONE', approvalsPerSecond: 30 }], approvalLimits: { PORTONE: 30, TOSS: 50 } });
    const r = await approvedFallback(h, { scope: 'EVENT', eventIds: [e] });
    await settle(h, r.id, r.commander, 'ACKED');
    return r;
  }

  test('F022-REV ① operator의 되돌리기는 403, 재인증 없는 commander도 403이고 아무것도 보내지 않는다', async () => {
    const h = await harness();
    const { id, commander } = await acked(h, randomUUID());
    const before = sentFor(h, id).length;
    const byOperator = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(h.identity.ops('operator')), { reason: '정상화' });
    expect(byOperator.statusCode, byOperator.payload).toBe(403);
    const noReauth = await h.post(`/v1/ops/commands/${id}/reversions`, h.identity.ops('commander'), { reason: '정상화' });
    expect(noReauth.statusCode, noReauth.payload).toBe(403);
    expect(slug(noReauth)).toMatch(/reauth-required$/);
    expect(sentFor(h, id).length).toBe(before);
    expect(await stateOf(h, id, commander)).toBe('ACKED');
  });

  test('F022-REV ② commander가 재인증해 되돌리면 새 판의 끄기(payment 두 파드·리더) 뒤 TOSS·PORTONE 해제를 payment 두 파드에 보내고 모두 ack해 REVERTED다', async () => {
    const h = await harness();
    const e = randomUUID();
    const { id, commander } = await acked(h, e);
    const applyVersion = sentFor(h, id)[0]!.req.version;
    const mark = h.sent.length;
    h.clock.advance(1_000);
    const reverter = h.identity.ops('commander');
    const r = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(reverter), { reason: '결제사 회복' });
    expect(r.statusCode, r.payload).toBe(200);
    await settle(h, id, commander, 'REVERTED');
    const after = distinct(h.sent.slice(mark));
    const offs = after.filter((s) => s.req.kind === 'CONTROL_KIND_PG_SWITCH');
    expect(offs.map((s) => [s.address, s.req.scope])).toEqual(expect.arrayContaining([[PAYMENT_PODS[0], e], [PAYMENT_PODS[1], e], [LEADER, e]]));
    expect(offs).toHaveLength(3);
    for (const s of offs) expect(s.req.version, '되돌리기는 새 판이다').toBeGreaterThan(applyVersion);
    for (const s of offs.filter((x) => x.service === 'payment-svc')) expect(desired(s)).toMatchObject({ switched: false });
    expect(offs.filter((x) => x.service === 'admission-ctrl').map(desired)).toEqual([{ switched: false, pgKey: null, pgTps: null }]);
    const releases = after.filter((s) => s.req.kind === 'CONTROL_KIND_ENTRY_PAUSE_RELEASE');
    expect(releases.map((s) => [s.service, s.address, s.req.scope, desired(s).pg]).sort()).toEqual(
      [
        ['payment-svc', PAYMENT_PODS[0], 'PLATFORM', 'PORTONE'],
        ['payment-svc', PAYMENT_PODS[0], 'PLATFORM', 'TOSS'],
        ['payment-svc', PAYMENT_PODS[1], 'PLATFORM', 'PORTONE'],
        ['payment-svc', PAYMENT_PODS[1], 'PLATFORM', 'TOSS'],
      ].sort(),
    );
    // 끄기를 먼저 보내고 이어 해제다
    const firstRelease = h.sent.findIndex((s, i) => i >= mark && s.req.kind === 'CONTROL_KIND_ENTRY_PAUSE_RELEASE');
    const firstOff = h.sent.findIndex((s, i) => i >= mark && s.req.kind === 'CONTROL_KIND_PG_SWITCH');
    expect(firstOff).toBeGreaterThanOrEqual(mark);
    expect(firstOff).toBeLessThan(firstRelease);
    // 바라는 상태는 ADR-0366 결정 8 {"pg", "actor"}: actor는 되돌린 사람의 관리 계정 ID다(가명 참조가 아니다)
    expect(releases.map((s) => [s.address, desired(s)]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual(
      [
        [PAYMENT_PODS[0], { pg: 'PORTONE', actor: reverter['x-user-id'] }],
        [PAYMENT_PODS[0], { pg: 'TOSS', actor: reverter['x-user-id'] }],
        [PAYMENT_PODS[1], { pg: 'PORTONE', actor: reverter['x-user-id'] }],
        [PAYMENT_PODS[1], { pg: 'TOSS', actor: reverter['x-user-id'] }],
      ].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    );
  });

  test('F022-REV ③ 해제 하나가 10초 안에 ack되지 않으면 502 command-dispatch-failed이고 명령은 ACKED 그대로·REVERT_FAILED 사건이며, 다시 하면 REVERTED다', async () => {
    const h = await harness();
    const { id, commander } = await acked(h, randomUUID());
    let down = true;
    h.answer.set(PAYMENT_PODS[1], (req) => (down && req.kind === 'CONTROL_KIND_ENTRY_PAUSE_RELEASE' ? req.version - 1 : req.version));
    const r = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(h.identity.ops('commander')), { reason: '결제사 회복' });
    expect(r.statusCode, r.payload).toBe(502);
    expect(slug(r)).toBe('command-dispatch-failed');
    expect(await stateOf(h, id, commander)).toBe('ACKED');
    expect(h.store.eventsOf(id).map((e) => e.type)).toContain('REVERT_FAILED');
    const resent = h.sent.filter((s) => s.address === PAYMENT_PODS[1] && s.req.kind === 'CONTROL_KIND_ENTRY_PAUSE_RELEASE');
    expect(resent.length, '10초 안에 1초마다 다시 보낸다').toBeGreaterThanOrEqual(2);
    expect(Math.max(...resent.map((s) => s.at)) - Math.min(...resent.map((s) => s.at))).toBeLessThanOrEqual(ACK_TIMEOUT_MS);
    // 다시 해도 된다(ADR-0340 결정 5): 받는 쪽이 돌아오면 REVERTED
    down = false;
    const again = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(h.identity.ops('commander')), { reason: '다시 되돌림' });
    expect(again.statusCode, again.payload).toBe(200);
    await settle(h, id, commander, 'REVERTED');
  });
});

describe('F022-REL 해제만 하는 명령 6 (B13, ADR-0366 결정 8)', () => {
  test('F022-REL ① commander가 재인증해 {mode: PAYMENT_ENTRY_RELEASE, pg: TOSS}를 내면 승인 대기 없이 payment 두 파드에만 ENTRY_PAUSE_RELEASE {"pg":"TOSS","actor":요청자}(범위 PLATFORM)를 보내 ACKED다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const r = await h.post('/v1/ops/commands', h.withToken(commander), release({ pg: 'TOSS' }));
    expect(r.statusCode, r.payload).toBe(201);
    const id = json(r).commandId as string;
    expect(json(r).state).not.toBe('PENDING_APPROVAL');
    await settle(h, id, commander, 'ACKED');
    const out = distinct(sentFor(h, id));
    // 바라는 상태는 ADR-0366 결정 8 {"pg", "actor"}: actor는 요청자 관리 계정 ID
    expect(out.map((s) => [s.service, s.address, s.req.kind, s.req.scope, desired(s)]).sort()).toEqual(
      [
        ['payment-svc', PAYMENT_PODS[0], 'CONTROL_KIND_ENTRY_PAUSE_RELEASE', 'PLATFORM', { pg: 'TOSS', actor: commander['x-user-id'] }],
        ['payment-svc', PAYMENT_PODS[1], 'CONTROL_KIND_ENTRY_PAUSE_RELEASE', 'PLATFORM', { pg: 'TOSS', actor: commander['x-user-id'] }],
      ].sort(),
    );
    expect(h.resolver.calls, '해제는 회차 결제사를 묻지 않는다').toEqual([]);
    expect(h.store.outboxSettings().filter((s) => s.setting.kind === 'DEGRADED_MODE' && s.setting.target === 'PAYMENT_PG_FALLBACK')).toEqual([]);
  });

  test('F022-REL ② 해제 명령의 되돌리기는 409 command-not-revertible이다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const id = json(await h.post('/v1/ops/commands', h.withToken(commander), release({ pg: 'PORTONE' }))).commandId as string;
    await settle(h, id, commander, 'ACKED');
    const r = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(h.identity.ops('commander')), { reason: '되돌림' });
    expect(r.statusCode, r.payload).toBe(409);
    expect(slug(r)).toBe('command-not-revertible');
  });

  test('F022-REL ③ operator는 403 command-role-forbidden, 재인증 없는 commander는 403이고 명령 행이 없다', async () => {
    const h = await harness();
    const byOperator = await h.post('/v1/ops/commands', h.withToken(h.identity.ops('operator')), release({ pg: 'TOSS' }));
    expect(byOperator.statusCode).toBe(403);
    expect(slug(byOperator)).toBe('command-role-forbidden');
    const commander = h.identity.ops('commander');
    const noReauth = await h.post('/v1/ops/commands', commander, release({ pg: 'TOSS' }));
    expect(noReauth.statusCode).toBe(403);
    expect(slug(noReauth)).toMatch(/reauth-required$/);
    expect((json(await h.get('/v1/ops/commands?limit=100', commander)).items as unknown[]).length).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test.each([
    ['모르는 칸', { pg: 'TOSS', scope: 'PLATFORM' }],
    ['pg 없음', {}],
    ['허용 밖 결제사', { pg: 'NAVERPAY' }],
    ['소문자 결제사', { pg: 'toss' }],
  ])('F022-REL ④ %s는 422이고 명령 행·보내기가 없다', async (_name, params) => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const r = await h.post('/v1/ops/commands', h.withToken(commander), release(params));
    expect(r.statusCode, r.payload).toBe(422);
    expect(['invalid-command', 'command-out-of-range']).toContain(slug(r));
    expect((json(await h.get('/v1/ops/commands?limit=100', commander)).items as unknown[]).length).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test('F022-REL ⑤ SIMULATOR는 ci에서 받는다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const r = await h.post('/v1/ops/commands', h.withToken(commander), release({ pg: 'SIMULATOR' }));
    expect(r.statusCode, r.payload).toBe(201);
    await settle(h, json(r).commandId as string, commander, 'ACKED');
  });

  test('F022-REL ⑥ local·ci 밖 조립(control.simulatorPg 거짓)에서 SIMULATOR는 422이고 보내기가 없다', async () => {
    const h = await harness({ simulatorPg: false });
    const commander = h.identity.ops('commander');
    const r = await h.post('/v1/ops/commands', h.withToken(commander), release({ pg: 'SIMULATOR' }));
    expect(r.statusCode, r.payload).toBe(422);
    expect((json(await h.get('/v1/ops/commands?limit=100', commander)).items as unknown[]).length).toBe(0);
    expect(h.sent).toEqual([]);
  });
});

describe('P-T43 ② 해제의 감사 기록 (B16, ADR-0250 결정 5, ADR-0366 결정 11)', () => {
  test('P-T43 ② 해제 명령의 감사 체인에 사유와 요청 역할 commander가 남고, 받는 쪽에 보낸 값에는 사유가 없다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const reason = '확인 호출 경로 고장으로 자동 정지가 풀리지 않음';
    const r = await h.post('/v1/ops/commands', h.withToken(commander), { type: 'DEGRADED_MODE', reason, params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'TOSS' } });
    expect(r.statusCode, r.payload).toBe(201);
    const id = json(r).commandId as string;
    await settle(h, id, commander, 'ACKED');
    const created = h.audit.entries.find((e) => e.recordId === id && e.recordType === 'COMMAND_CREATED');
    expect(created?.record.payload).toMatchObject({ type: 'DEGRADED_MODE', requestedRole: 'commander', reason });
    expect(created?.record.payload.requestedBy).toBe(h.store.requesterRefOf(id));
    for (const s of sentFor(h, id)) expect(s.req.desiredStateJson).not.toContain(reason);
  });
});
