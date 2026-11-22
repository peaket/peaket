// F-02-1(OPS-300) ops-svc 제어 퍼뜨리기: 판 번호 원장, 받는 파드 찾기, 준비된 모든 파드의 ack, 1초 다시 보내기·10초 실패.
// 정본: ADR-0365 결정 1(새 판 = max(마지막 + 1, 지금 ms), 다시 하기·이어 보내기는 같은 판), 결정 2(명령 → 종류·범위·받는 쪽·바라는 상태),
// 결정 3(주소는 ControlTargets 설정에서만, 명령 값에서 받지 않음, 운영에서 설정 없으면 시작 실패), 결정 4(대상마다 동시에 부르고 applied_version ≥ 판이면 ack,
// 실패·낮은 판은 1초 [가정]마다 같은 명령 ID·판으로 다시, 모두 ack하면 주소를 다시 풀어 새 파드도 부름, 명령 3은 세 받는 쪽 모두, 처음 보낸 때부터 10초면 FAILED
// 'ack-timeout:<서비스>'), ADR-0073 결정 17(ack 10초), ADR-0103 결정 5.
// 쓰는 공개 면(F-02-1 계획 8절과 구현 메모 '시험 담당에게'): commands 모듈의 ControlFanout(대상 찾기·보내기 포트·시계·대기)·ControlDispatcher(resume)·
// ControlTargets·ControlTransport 포트·controlKindOf(명령 유형), src/adapters/control-targets.ts의 controlTargetsFromEnv.
// 짝 가짜: 저장소는 MemoryCommandStore(포트 구현, 같은 원장 규칙을 test-int/f021-control-ledger.int.test.ts가 DrizzleCommandStore에 돌린다),
// 받는 쪽은 ControlTransport 포트(GrpcControlTransport와 같은 꼴)를 구현한 대역, 시계·대기는 주입(가짜 시계를 대기만큼 민다).
// 시험 이름: F021-VER(B1·B2), F021-ACK(B6), ASVS v5.0.0-15.1.3(B7), ASVS v5.0.0-1.3.6(B5), ASVS v5.0.0-15.3.5(원장 판 정수).
import { randomUUID } from 'node:crypto';
import type { Clock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { controlTargetsFromEnv } from '../src/adapters/control-targets.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { type Command, type CommandType, ControlDispatcher, ControlFanout, type ControlTargets, type ControlTransport, MemoryCommandStore, controlKindOf } from '../src/modules/commands/index.js';

type ControlRequest = Parameters<ControlTransport['apply']>[2];

const T = Date.parse('2026-11-23T03:00:00.000Z');
const ACK_TIMEOUT_MS = 10_000;
const RESEND_MS = 1_000;
const REQUESTER = '0193a000-0000-7000-8000-0000000000f1';
type Service = 'admission-ctrl' | 'purchase-svc' | 'queue-svc';

/** 손으로 옮기는 시계(뒤로도 옮길 수 있다: 시계가 되돌아간 경우) */
function movableClock(start: number) {
  let wall = start;
  let mono = 0;
  const clock: Clock = { now: () => wall, monotonicMs: () => mono };
  return {
    clock,
    set: (ms: number) => void (wall = ms),
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
  };
}

interface Sent {
  readonly service: Service;
  readonly address: string;
  readonly at: number;
  readonly req: ControlRequest;
}

/** 대상 주소마다의 답 정책: 받은 요청·시각을 보고 적용 판(또는 던질 오류)과 걸린 시간을 정한다 */
type Policy = (s: { service: Service; address: string; req: ControlRequest; at: number }) => { applied: number; tookMs?: number } | Error;
const acks: Policy = ({ req }) => ({ applied: req.version });
const neverAcks: Policy = ({ req }) => ({ applied: req.version - 1 });

function harness(o: { targets: Partial<Record<Service, readonly string[] | (() => readonly string[])>>; policy?: Partial<Record<string, Policy>>; start?: number }) {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  const time = movableClock(o.start ?? T);
  const sent: Sent[] = [];
  const resolved: Service[] = [];
  const connected: string[] = [];
  const targets: ControlTargets = {
    resolve: async (service: string) => {
      resolved.push(service as Service);
      const t = o.targets[service as Service];
      return typeof t === 'function' ? t() : (t ?? []);
    },
  };
  const transport: ControlTransport = {
    apply: async (svc: string, address: string, req: ControlRequest) => {
      const service = svc as Service;
      connected.push(address);
      const at = time.clock.now();
      sent.push({ service, address, at, req });
      const r = (o.policy?.[address] ?? acks)({ service, address, req, at });
      if (r instanceof Error) throw r;
      if (r.tookMs) time.advance(r.tookMs);
      return { appliedVersion: r.applied, podName: `${service}-${address}` };
    },
  };
  const sleep = async (ms: number) => time.advance(ms);
  /** 보내기를 끝까지 기다리고 끝난 명령을 돌려준다(배경 보내기의 resume) */
  const dispatcher = () => {
    const d = new ControlDispatcher({ store, fanout: new ControlFanout({ targets, transport, clock: time.clock, sleep }), clock: time.clock });
    const finished = async (commandId: string) => (await store.find(commandId))!;
    return {
      dispatch: async (c: Command) => {
        await d.resume(c.commandId);
        return finished(c.commandId);
      },
      resume: async (commandId: string) => {
        await d.resume(commandId);
        return finished(commandId);
      },
    };
  };
  /** 명령을 만들어 APPROVED → DISPATCHED(원장이 판을 매기는 자리)까지 둔다 */
  const dispatched = async (type: CommandType, params: Record<string, unknown>, eventId?: string): Promise<Command> => {
    const c = await store.create({ commandId: randomUUID(), type, reason: '온세일 대응', params, requestedBy: REQUESTER, requestedRole: 'commander', nowMs: time.clock.now(), approvalMode: 'ONE', ...(eventId ? { eventId } : {}) });
    return store.markDispatched(c.commandId, time.clock.now());
  };
  return { store, time, sent, resolved, connected, targets, dispatcher, dispatched };
}

const versionsOf = (sent: readonly Sent[], commandId: string) => [...new Set(sent.filter((s) => s.req.commandId === commandId).map((s) => s.req.version))];

describe('F021-VER 판 번호 원장 (B1·B2)', () => {
  test('F021-VER ① 새 범위·종류의 첫 판은 처음 DISPATCHED의 지금 밀리초이고, 같은 밀리초의 다음 명령은 그보다 1 큰 판이다', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.1.0.1:50061'] } });
    const e = randomUUID();
    const a = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    const b = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect([a.state, b.state]).toEqual(['ACKED', 'ACKED']);
    expect(versionsOf(h.sent, a.commandId)).toEqual([T]);
    expect(versionsOf(h.sent, b.commandId)).toEqual([T + 1]);
  });

  test('F021-VER ② 판은 범위·종류마다다: 같은 회차의 명령 1과 명령 2는 서로의 판에 밀리지 않는다', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.1.0.1:50061'] } });
    const e = randomUUID();
    const pause = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    const target = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_TARGET', { eventId: e, target: 3_200 }, e));
    expect(versionsOf(h.sent, pause.commandId)).toEqual([T]);
    expect(versionsOf(h.sent, target.commandId)).toEqual([T]);
  });

  test('F021-VER ③ 시계가 되돌아가도 판은 줄지 않는다(마지막 + 1)', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.1.0.1:50061'] } });
    const e = randomUUID();
    const first = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    h.time.set(T - 60_000);
    const back = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(versionsOf(h.sent, first.commandId)).toEqual([T]);
    expect(versionsOf(h.sent, back.commandId)).toEqual([T + 1]);
  });

  test('F021-VER ④ 실패한 명령을 다시 하면(FAILED → DISPATCHED) 새 판이 아니라 처음 판으로 다시 보낸다', async () => {
    let up = false;
    const h = harness({ targets: { 'admission-ctrl': ['10.1.0.1:50061'] }, policy: { '10.1.0.1:50061': (s) => (up ? acks(s) : neverAcks(s)) } });
    const e = randomUUID();
    const failed = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(failed).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:admission-ctrl' });
    up = true;
    h.time.advance(30_000);
    const again = await h.store.markDispatched(failed.commandId, h.time.clock.now());
    const acked = await h.dispatcher().dispatch(again);
    expect(acked.state).toBe('ACKED');
    expect(versionsOf(h.sent, failed.commandId)).toEqual([T]);
  });

  test('F021-VER ⑤ 보내는 중 프로세스가 멈춰 DISPATCHED로 남은 명령은 새 프로세스의 resume이 같은 판으로 이어 보낸다(10초 안이면 ACKED)', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.1.0.1:50061'] } });
    const e = randomUUID();
    const c = await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e);
    expect(h.sent).toHaveLength(0);
    h.time.advance(3_000);
    const resumed = await h.dispatcher().resume(c.commandId);
    expect(resumed.state).toBe('ACKED');
    expect(versionsOf(h.sent, c.commandId)).toEqual([T]);
  });

  test('F021-VER ⑤-2 처음 보낸 때부터 10초가 지난 뒤 이어 보내도 같은 판으로 보내고, 10초 규칙대로 FAILED ack-timeout이다(다시 하기가 같은 판으로 잇는다)', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.1.0.1:50061'] } });
    const e = randomUUID();
    const c = await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e);
    h.time.advance(45_000);
    const resumed = await h.dispatcher().resume(c.commandId);
    expect(versionsOf(h.sent, c.commandId)).toEqual([T]);
    expect(resumed).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:admission-ctrl' });
  });
});

describe('F021-ACK 준비된 모든 파드의 ack (B6)', () => {
  test('F021-ACK ① 명령 3은 purchase-svc 모든 파드·admission-ctrl 리더·queue-svc 모든 파드가 판 이상을 답해야 ACKED다. 한 파드라도 낮은 판이면 10초에 FAILED이고 사유에 그 서비스가 있다', async () => {
    const e = randomUUID();
    const ok = harness({ targets: { 'purchase-svc': ['10.2.0.1:50061', '10.2.0.2:50061'], 'admission-ctrl': ['10.3.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] } });
    const acked = await ok.dispatcher().dispatch(await ok.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [e] }));
    expect(acked.state).toBe('ACKED');
    const reached = [...new Set(ok.sent.map((s) => `${s.service}@${s.address}:${s.req.scope}:${s.req.kind}`))].sort();
    expect(reached).toEqual(
      [
        `admission-ctrl@10.3.0.1:50061:${e}:CONTROL_KIND_SALE_PAUSE`,
        `purchase-svc@10.2.0.1:50061:${e}:CONTROL_KIND_SALE_PAUSE`,
        `purchase-svc@10.2.0.2:50061:${e}:CONTROL_KIND_SALE_PAUSE`,
        `queue-svc@10.4.0.1:50061:${e}:CONTROL_KIND_SALE_PAUSE`,
      ].sort(),
    );
    for (const s of ok.sent) expect(JSON.parse(s.req.desiredStateJson)).toEqual({ paused: true });

    const lagging = harness({
      targets: { 'purchase-svc': ['10.2.0.1:50061', '10.2.0.2:50061'], 'admission-ctrl': ['10.3.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] },
      policy: { '10.2.0.2:50061': neverAcks },
    });
    const failed = await lagging.dispatcher().dispatch(await lagging.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [e] }));
    expect(failed).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:purchase-svc' });
  });

  test('F021-ACK ② 응답이 와도 applied_version이 판보다 낮으면 ack가 아니다(받는 쪽이 오류 없이 낮은 판을 답한 경우)', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'] }, policy: { '10.3.0.1:50061': neverAcks } });
    const failed = await h.dispatcher().dispatch(await h.dispatched('AUTOMATION_STOP', {}));
    expect(failed).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:admission-ctrl' });
  });

  test('F021-ACK ③ 모두 ack한 뒤 주소를 다시 풀어 그사이 준비된 새 파드도 부르고, 그 파드도 ack해야 ACKED다', async () => {
    let calls = 0;
    const purchase = () => (++calls === 1 ? ['10.2.0.1:50061'] : ['10.2.0.1:50061', '10.2.0.9:50061']);
    const e = randomUUID();
    const h = harness({ targets: { 'purchase-svc': purchase, 'admission-ctrl': ['10.3.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] } });
    const c = await h.dispatcher().dispatch(await h.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [e] }));
    expect(c.state).toBe('ACKED');
    const toNew = h.sent.filter((s) => s.address === '10.2.0.9:50061');
    expect(toNew.length, '다시 푼 목록의 새 파드를 부르지 않았다').toBeGreaterThanOrEqual(1);
    expect(toNew[0]!.req).toMatchObject({ commandId: c.commandId, scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version: versionsOf(h.sent, c.commandId)[0] });
  });

  test('F021-ACK ④ 다시 푼 목록의 새 파드가 ack하지 않으면 ACKED가 아니라 10초에 FAILED다', async () => {
    let calls = 0;
    const purchase = () => (++calls === 1 ? ['10.2.0.1:50061'] : ['10.2.0.1:50061', '10.2.0.9:50061']);
    const h = harness({ targets: { 'purchase-svc': purchase, 'admission-ctrl': ['10.3.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] }, policy: { '10.2.0.9:50061': neverAcks } });
    const c = await h.dispatcher().dispatch(await h.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [randomUUID()] }));
    expect(c).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:purchase-svc' });
  });

  test('F021-ACK ⑤ 전체 범위 명령 3은 범위 PLATFORM으로 세 받는 쪽에, 명령 11은 admission-ctrl에만 보낸다', async () => {
    const h = harness({ targets: { 'purchase-svc': ['10.2.0.1:50061'], 'admission-ctrl': ['10.3.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] } });
    const all = await h.dispatcher().dispatch(await h.dispatched('KILL_SWITCH', { scope: 'PLATFORM' }));
    expect(all.state).toBe('ACKED');
    expect([...new Set(h.sent.filter((s) => s.req.commandId === all.commandId).map((s) => `${s.service}:${s.req.scope}`))].sort()).toEqual(['admission-ctrl:PLATFORM', 'purchase-svc:PLATFORM', 'queue-svc:PLATFORM']);
    const stop = await h.dispatcher().dispatch(await h.dispatched('AUTOMATION_STOP', {}));
    expect(stop.state).toBe('ACKED');
    const stopSent = h.sent.filter((s) => s.req.commandId === stop.commandId);
    expect(stopSent.map((s) => s.service)).toEqual(stopSent.map(() => 'admission-ctrl'));
    expect(stopSent[0]!.req).toMatchObject({ scope: 'PLATFORM', kind: 'CONTROL_KIND_AUTOMATION_STOP' });
    expect(JSON.parse(stopSent[0]!.req.desiredStateJson)).toEqual({ stopped: true });
  });

  test('F021-ACK ⑥ 명령 1·2는 admission-ctrl에 정본 꼴의 바라는 상태로 보낸다(목표 고정은 지정 시각 + 15분)', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'], 'purchase-svc': ['10.2.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] } });
    const e = randomUUID();
    const target = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_TARGET', { eventId: e, target: 3_200 }, e));
    const pause = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    const t = h.sent.filter((s) => s.req.commandId === target.commandId);
    const p = h.sent.filter((s) => s.req.commandId === pause.commandId);
    expect(new Set([...t, ...p].map((s) => s.service))).toEqual(new Set(['admission-ctrl']));
    expect(t[0]!.req).toMatchObject({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET' });
    expect(JSON.parse(t[0]!.req.desiredStateJson)).toEqual({ target: 3_200, untilMs: T + 15 * 60_000 });
    expect(p[0]!.req).toMatchObject({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE' });
    const pd = JSON.parse(p[0]!.req.desiredStateJson) as Record<string, unknown>;
    expect(Object.keys(pd).sort()).toEqual(['expiresAtMs', 'paused']);
    expect(pd.paused).toBe(true);
  });
});

describe('ASVS v5.0.0-15.1.3 데드라인·다시 보내기·10초 실패 (B7)', () => {
  test('ASVS v5.0.0-15.1.3 ① 답이 낮은 판이면 1초마다 같은 명령 ID·판으로 다시 보내고, 처음 보낸 때부터 10초가 되면 FAILED ack-timeout이며 10초를 넘겨서는 보내지 않는다', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'] }, policy: { '10.3.0.1:50061': neverAcks } });
    const e = randomUUID();
    const c = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(c).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:admission-ctrl' });
    const mine = h.sent.filter((s) => s.req.commandId === c.commandId);
    const first = mine[0]!.at;
    expect(mine.slice(0, ACK_TIMEOUT_MS / RESEND_MS).map((s) => s.at - first)).toEqual(Array.from({ length: ACK_TIMEOUT_MS / RESEND_MS }, (_, i) => i * RESEND_MS));
    expect(mine.every((s) => s.at - first <= ACK_TIMEOUT_MS), '10초를 넘겨 보냈다').toBe(true);
    expect(new Set(mine.map((s) => s.req.version)).size).toBe(1);
    expect(h.time.clock.now() - first).toBeGreaterThanOrEqual(ACK_TIMEOUT_MS);
  });

  test('ASVS v5.0.0-15.1.3 ② 처음 보낸 때부터 10초 − 1ms에 온 ack는 ACKED다', async () => {
    let first: number | undefined;
    const late: Policy = ({ req, at }) => {
      first ??= at;
      return at - first >= ACK_TIMEOUT_MS - RESEND_MS ? { applied: req.version, tookMs: RESEND_MS - 1 } : { applied: req.version - 1 };
    };
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'] }, policy: { '10.3.0.1:50061': late } });
    const e = randomUUID();
    const c = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(c.state).toBe('ACKED');
  });

  test('ASVS v5.0.0-15.1.3 ③ 10초 정각에 온 ack는 늦었다: FAILED ack-timeout', async () => {
    let first: number | undefined;
    const late: Policy = ({ req, at }) => {
      first ??= at;
      return at - first >= ACK_TIMEOUT_MS - RESEND_MS ? { applied: req.version, tookMs: RESEND_MS } : { applied: req.version - 1 };
    };
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'] }, policy: { '10.3.0.1:50061': late } });
    const e = randomUUID();
    const c = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(c).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:admission-ctrl' });
  });

  test('ASVS v5.0.0-15.1.3 ④ 받는 쪽 오류(연결 거절)도 ack가 아니고 1초마다 다시 보낸다. 9초 동안 답하지 않다 돌아온 파드는 ACKED로 끝난다', async () => {
    let first: number | undefined;
    const flaky: Policy = ({ req, at }) => {
      first ??= at;
      return at - first < 9_000 ? Object.assign(new Error('14 UNAVAILABLE: connect ECONNREFUSED'), { code: 14 }) : { applied: req.version };
    };
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'] }, policy: { '10.3.0.1:50061': flaky } });
    const e = randomUUID();
    const c = await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(c.state).toBe('ACKED');
    const mine = h.sent.filter((s) => s.req.commandId === c.commandId);
    // 끊긴 사례 수: 0~8초의 아홉 번이 실패했고 9초의 열째가 ack였다(9절 '받는 쪽 한 파드가 9초 동안 답하지 않다 돌아온 사례')
    expect(mine.slice(0, 10).map((s) => s.at - first!)).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000]);
  });
});

describe('ASVS v5.0.0-1.3.6 받는 파드 주소는 설정에서만 (B5)', () => {
  test('ASVS v5.0.0-1.3.6 ① 명령 값에 주소처럼 보이는 칸이 있어도 ControlTargets가 준 주소만 부른다', async () => {
    const h = harness({ targets: { 'purchase-svc': ['10.2.0.1:50061'], 'admission-ctrl': ['10.3.0.1:50061'], 'queue-svc': ['10.4.0.1:50061'] } });
    const c = await h.dispatcher().dispatch(await h.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [randomUUID()], address: '203.0.113.9:50061', targets: ['198.51.100.7:50061'] }));
    expect(c.state).toBe('ACKED');
    expect(new Set(h.connected)).toEqual(new Set(['10.2.0.1:50061', '10.3.0.1:50061', '10.4.0.1:50061']));
  });

  test('ASVS v5.0.0-1.3.6 ② 보낼 때마다 주소를 다시 푼다(명령 두 개면 두 번 이상)', async () => {
    const h = harness({ targets: { 'admission-ctrl': ['10.3.0.1:50061'] } });
    const e = randomUUID();
    await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    const once = h.resolved.filter((s) => s === 'admission-ctrl').length;
    await h.dispatcher().dispatch(await h.dispatched('ADMISSION_PAUSE', { eventId: e }, e));
    expect(once).toBeGreaterThanOrEqual(1);
    expect(h.resolved.filter((s) => s === 'admission-ctrl').length).toBeGreaterThan(once);
  });

  test('ASVS v5.0.0-1.3.6 ③ local·ci는 PEAKET_<서비스>_CONTROL_GRPC_ADDRS 쉼표 목록(옛 …_ADDR 하나도 받는다)에서 주소를 얻는다', async () => {
    const { targets: t } = controlTargetsFromEnv({
      PEAKET_ENV: 'ci',
      PEAKET_PURCHASE_CONTROL_GRPC_ADDRS: '127.0.0.1:50071, 127.0.0.1:50072',
      PEAKET_QUEUE_CONTROL_GRPC_ADDR: '127.0.0.1:50081',
      PEAKET_ADMISSION_CONTROL_GRPC_ADDRS: '127.0.0.1:50091',
    });
    expect(await t.resolve('purchase-svc')).toEqual(['127.0.0.1:50071', '127.0.0.1:50072']);
    expect(await t.resolve('queue-svc')).toEqual(['127.0.0.1:50081']);
    expect(await t.resolve('admission-ctrl')).toEqual(['127.0.0.1:50091']);
  });

  test('ASVS v5.0.0-1.3.6 ④ 운영(prod)에서 대상 서비스의 주소 설정이 없으면 만들 때 던진다(ops-svc 시작 실패)', () => {
    expect(() => controlTargetsFromEnv({ PEAKET_ENV: 'prod' })).toThrow();
  });
});

describe('controlKindOf 명령 → 제어 종류 (ADR-0365 결정 2)', () => {
  test('F021-VER ⑥ 명령 1·2·3·7·11은 제어 종류가 있고, 설정형 명령(5·8·9·12)은 없다', () => {
    expect(
      (['ADMISSION_TARGET', 'ADMISSION_PAUSE', 'KILL_SWITCH', 'LOBBY_BANNER', 'AUTOMATION_STOP', 'BOT_LEVEL', 'LOG_LEVEL', 'FEATURE_OFF', 'PG_ASSIGN'] as const).map((t) => [t, controlKindOf(t)]),
    ).toEqual([
      ['ADMISSION_TARGET', 'CONTROL_KIND_ADMISSION_TARGET'],
      ['ADMISSION_PAUSE', 'CONTROL_KIND_ADMISSION_PAUSE'],
      ['KILL_SWITCH', 'CONTROL_KIND_SALE_PAUSE'],
      ['LOBBY_BANNER', 'CONTROL_KIND_LOBBY_BANNER'],
      ['AUTOMATION_STOP', 'CONTROL_KIND_AUTOMATION_STOP'],
      ['BOT_LEVEL', undefined],
      ['LOG_LEVEL', undefined],
      ['FEATURE_OFF', undefined],
      ['PG_ASSIGN', undefined],
    ]);
  });
});
