// 사전 모의(dry-run) 센 값을 받는 쪽의 읽기 전용 PreviewControl로 채우는 ops-svc 어댑터 시험(F-02-5 OPS-300, docs/features/control-tower.md §14 C-T6 ①,
// ADR-0365 결정 11·16, ADR-0340 결정 2·11, docs/security/asvs/control-tower.md 1.3.6, 계획 docs/review/plans/F-02-5.md 6절 B20~B23·8.1·8.2).
// - 실제 응용(ComputeDryRun·미리보기 HTTP 경로)과 실제 어댑터(ControlPreviewDryRunSource)를 돌리고, 바꾸는 것은 경계 두 포트뿐이다:
//   대상 찾기(ControlTargets)와 제어 gRPC 전송(ControlTransport.preview). 둘 다 포트를 implements한 짝 가짜이고, 진짜 짝은 받는 쪽 셋의 통합 시험
//   (admission-ctrl·purchase-svc·queue-svc test-int의 C-T6 ①)이 같은 응답 꼴(PreviewControlResponse)로 본다.
// - 정본 값: 받는 쪽은 명령 1 키 여덟 → admission-ctrl 리더, 명령 3 키 → purchase-svc(넷)·queue-svc(waiting), 데드라인 1초 [가정],
//   회차 여럿이면 회차마다 불러 더하고 한 회차라도 실패하면 그 키는 unavailable(일부 합을 적지 않는다), PLATFORM은 모두 platform-scope-not-counted,
//   받은 key가 요청한 키가 아니거나 value가 유한한 0 이상이 아니면 invalid-count, 부르기 실패는 receiver-unavailable:<서비스>·receiver-timeout:<서비스>,
//   명령 4 키는 source-not-wired 그대로(ADR-0365 결정 11·16, 계획 8.1 사유 글 목록).
// - 시간 초과 경계는 setTimeout만 가짜로 돌려(가짜 시계) 999ms에는 아직 기다리고 1,000ms 정각에 receiver-timeout이 되는지 본다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  ComputeDryRun,
  ControlPreviewDryRunSource,
  DRY_RUN_KEYS,
  PREVIEW_TIMEOUT_MS,
  type CommandExecutor,
  type ControlTargets,
  type ControlTransport,
  type DryRunTarget,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-12-05T10:40:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** 정본 키(ADR-0365 결정 11 표, ADR-0340 DRY_RUN_KEYS). 코드 상수를 가져오지 않고 정본에서 적는다 */
const ADMISSION_KEYS = ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio', 'avgDwellSeconds', 'servingRateCap', 'servingRate'];
const PURCHASE_KEYS = ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m', 'paymentAcceptsPerSecond5m'];
const QUEUE_KEYS = ['waiting'];
const KILL_KEYS = [...PURCHASE_KEYS, ...QUEUE_KEYS];

const E1 = '0b9a3c4e-5d6f-4a1b-8c2d-3e4f5a6b7c01';
const E2 = '0b9a3c4e-5d6f-4a1b-8c2d-3e4f5a6b7c02';
const E3 = '0b9a3c4e-5d6f-4a1b-8c2d-3e4f5a6b7c03';

type PreviewReq = { readonly scope: string; readonly kind: string; readonly keys: readonly string[] };
type PreviewRes = Awaited<ReturnType<NonNullable<ControlTransport['preview']>>>;

/** 대상 찾기 짝 가짜(ControlTargets 포트). 서비스마다 준비된 주소 목록을 준다 */
class FakeTargets implements ControlTargets {
  readonly asked: string[] = [];
  constructor(readonly addresses: Record<string, readonly string[]>) {}
  async resolve(service: string): Promise<readonly string[]> {
    this.asked.push(service);
    return this.addresses[service] ?? [];
  }
}

/**
 * 제어 gRPC 전송 짝 가짜(ControlTransport 포트, preview는 계획 8.2 꼴). 받는 쪽(서비스, 회차)마다 답·실패·멈춤을 시험이 고른다.
 * 응답 꼴은 PreviewControlResponse(counts[{key, value, source, measuredAtMs}], unavailable[{key, reason}], podName)를 그대로 따른다
 */
class FakeTransport implements ControlTransport {
  readonly calls: Array<{ service: string; address: string; req: PreviewReq }> = [];
  /** (서비스|회차) → 답 만들기. 없으면 연결 실패(ECONNREFUSED)로 던진다 */
  readonly answers = new Map<string, (req: PreviewReq) => Promise<PreviewRes>>();

  async apply(): Promise<{ appliedVersion: number; podName: string }> {
    throw new Error('이 시험은 ApplyControl을 부르지 않는다');
  }

  async preview(service: string, address: string, req: PreviewReq): Promise<PreviewRes> {
    this.calls.push({ service, address, req: { scope: req.scope, kind: req.kind, keys: [...req.keys] } });
    const answer = this.answers.get(`${service}|${req.scope}`);
    if (!answer) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return answer(req);
  }

  /** 요청한 키마다 values의 값을 세어 준다(없는 키는 unknown-key) */
  answer(service: string, scope: string, values: Record<string, number>, o: { measuredAtMs: number; podName: string; source?: string }): void {
    this.answers.set(`${service}|${scope}`, async (req) => ({
      counts: req.keys.filter((k) => k in values).map((key) => ({ key, value: values[key]!, source: o.source ?? `${service}:${key}`, measuredAtMs: o.measuredAtMs })),
      unavailable: req.keys.filter((k) => !(k in values)).map((key) => ({ key, reason: 'unknown-key' })),
      podName: o.podName,
    }));
  }

  raw(service: string, scope: string, res: PreviewRes): void {
    this.answers.set(`${service}|${scope}`, async () => res);
  }

  hang(service: string, scope: string): void {
    this.answers.set(`${service}|${scope}`, () => new Promise<PreviewRes>(() => undefined));
  }

  after(service: string, scope: string, ms: number, res: PreviewRes): void {
    this.answers.set(`${service}|${scope}`, () => new Promise<PreviewRes>((r) => setTimeout(() => r(res), ms)));
  }
}

const TARGETS = {
  // admission-ctrl은 리더 전용 Service의 이름 하나다(ADR-0365 결정 3)
  'admission-ctrl': ['admission-ctrl-leader.peaket.svc:50061'],
  'purchase-svc': ['10.1.0.11:50061', '10.1.0.12:50061'],
  'queue-svc': ['10.1.1.21:50061', '10.1.1.22:50061', '10.1.1.23:50061'],
};

function wire(o: { timeoutMs?: number } = {}) {
  const targets = new FakeTargets(TARGETS);
  const transport = new FakeTransport();
  const source = new ControlPreviewDryRunSource({ targets, transport, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) });
  const compute = new ComputeDryRun({ sources: { ADMISSION_TARGET: source, KILL_SWITCH: source } });
  return { targets, transport, source, compute };
}

const admission = (eventId: string, extra: Record<string, unknown> = {}): DryRunTarget => ({ type: 'ADMISSION_TARGET', params: { eventId, target: 4_200, ...extra }, eventId });
const killEvents = (eventIds: string[]): DryRunTarget => ({ type: 'KILL_SWITCH', params: { scope: 'EVENT', eventIds }, eventId: eventIds[0]! });
const reasons = (u: readonly { key: string; reason: string }[]) => Object.fromEntries(u.map((x) => [x.key, x.reason]));
const valuesOf = (c: readonly { key: string; value: number }[]) => Object.fromEntries(c.map((x) => [x.key, x.value]));

/** 리더 주기 값(ADR-0365 결정 11 표의 여덟). 코드 상수와 무관한 시험 값 */
const LEADER = { currentTarget: 3_100, slotsUsed: 2_850, soonAdmitted: 140, inFlight: 77, admitRatio: 0.55, avgDwellSeconds: 455, servingRateCap: 38, servingRate: 6.5 };
const CYCLE_AT = NOW - 1_300;

afterEach(() => {
  vi.useRealTimers();
});

describe('C-T6 ① 센 값은 같은 시각 원천에서 받는 쪽이 직접 센 값이다', () => {
  test('C-T6 ① 명령 1 키 여덟은 admission-ctrl 리더 한 곳에 ADMISSION_TARGET 종류로 묻고, 리더가 준 값·센 시각이 그대로 센 값이다', async () => {
    const { transport, compute, targets } = wire();
    transport.answer('admission-ctrl', E1, LEADER, { measuredAtMs: CYCLE_AT, podName: 'admission-ctrl-0', source: 'leader-cycle' });
    const r = await compute.count(admission(E1), NOW);
    expect(r.unavailable).toEqual([]);
    expect(r.counted).toEqual(ADMISSION_KEYS.map((key) => ({ key, value: LEADER[key as keyof typeof LEADER], source: 'leader-cycle', measuredAt: iso(CYCLE_AT) })));
    // 정본 키가 DRY_RUN_KEYS와 같다(ops가 묻는 키 = 리더가 세는 키)
    expect([...DRY_RUN_KEYS.ADMISSION_TARGET!]).toEqual(ADMISSION_KEYS);
    expect(transport.calls).toEqual([{ service: 'admission-ctrl', address: TARGETS['admission-ctrl'][0], req: { scope: E1, kind: 'CONTROL_KIND_ADMISSION_TARGET', keys: ADMISSION_KEYS } }]);
    expect(targets.asked).toEqual(['admission-ctrl']);
  });

  test('C-T6 ① 명령 3 키는 purchase-svc(세션·Paying·5분 홀드·접수)와 queue-svc(대기 인원)에 SALE_PAUSE 종류로 묻고, 서비스마다 아무 파드 하나만 부른다', async () => {
    const { transport, compute } = wire();
    transport.answer('purchase-svc', E1, { purchaseSessions: 912, paymentSessions: 37, holdsPerSecond5m: 4.25, paymentAcceptsPerSecond5m: 1.5 }, { measuredAtMs: NOW - 40, podName: 'purchase-svc-7c9' });
    transport.answer('queue-svc', E1, { waiting: 48_213 }, { measuredAtMs: NOW - 25, podName: 'queue-svc-1ab' });
    const r = await compute.count(killEvents([E1]), NOW);
    expect(r.unavailable).toEqual([]);
    expect(valuesOf(r.counted)).toEqual({ purchaseSessions: 912, paymentSessions: 37, holdsPerSecond5m: 4.25, paymentAcceptsPerSecond5m: 1.5, waiting: 48_213 });
    expect(Object.fromEntries(r.counted.map((c) => [c.key, c.measuredAt]))).toEqual({
      purchaseSessions: iso(NOW - 40),
      paymentSessions: iso(NOW - 40),
      holdsPerSecond5m: iso(NOW - 40),
      paymentAcceptsPerSecond5m: iso(NOW - 40),
      waiting: iso(NOW - 25),
    });
    const byService = new Map(transport.calls.map((c) => [c.service, c]));
    expect(transport.calls).toHaveLength(2);
    expect(byService.get('purchase-svc')!.req.kind).toBe('CONTROL_KIND_SALE_PAUSE');
    expect([...byService.get('purchase-svc')!.req.keys].sort()).toEqual([...PURCHASE_KEYS].sort());
    expect(byService.get('queue-svc')!.req).toEqual({ scope: E1, kind: 'CONTROL_KIND_SALE_PAUSE', keys: QUEUE_KEYS });
    expect(TARGETS['purchase-svc']).toContain(byService.get('purchase-svc')!.address);
    expect(TARGETS['queue-svc']).toContain(byService.get('queue-svc')!.address);
  });

  test('C-T6 ① 명령 3 범위가 회차 둘이면 회차마다 부르고 키마다 더한다(소문자 회차 범위)', async () => {
    const { transport, compute } = wire();
    transport.answer('purchase-svc', E1, { purchaseSessions: 900, paymentSessions: 30, holdsPerSecond5m: 4, paymentAcceptsPerSecond5m: 1.25 }, { measuredAtMs: NOW - 10, podName: 'p-a' });
    transport.answer('purchase-svc', E2, { purchaseSessions: 101, paymentSessions: 9, holdsPerSecond5m: 0.5, paymentAcceptsPerSecond5m: 0.25 }, { measuredAtMs: NOW - 20, podName: 'p-b' });
    transport.answer('queue-svc', E1, { waiting: 10_000 }, { measuredAtMs: NOW - 5, podName: 'q-a' });
    transport.answer('queue-svc', E2, { waiting: 2_345 }, { measuredAtMs: NOW - 6, podName: 'q-b' });
    const r = await compute.count(killEvents([E2.toUpperCase(), E1]), NOW);
    expect(r.unavailable).toEqual([]);
    expect(valuesOf(r.counted)).toEqual({ purchaseSessions: 1_001, paymentSessions: 39, holdsPerSecond5m: 4.5, paymentAcceptsPerSecond5m: 1.5, waiting: 12_345 });
    expect(transport.calls.map((c) => `${c.service}|${c.req.scope}`).sort()).toEqual(['purchase-svc|' + E1, 'purchase-svc|' + E2, 'queue-svc|' + E1, 'queue-svc|' + E2].sort());
  });

  test('C-T6 ① 받는 쪽이 실패하면(연결 실패·리더 아님) 그 키는 unavailable이고 0으로 적지 않는다', async () => {
    const { transport, compute } = wire();
    // admission-ctrl 비리더는 UNAVAILABLE not-leader로 답한다(ADR-0365 결정 16)
    transport.answers.set(`admission-ctrl|${E1}`, async () => {
      throw Object.assign(new Error('not-leader'), { code: 14, details: 'not-leader' });
    });
    const a = await compute.count(admission(E1), NOW);
    expect(a.counted).toEqual([]);
    expect(reasons(a.unavailable)).toEqual(Object.fromEntries(ADMISSION_KEYS.map((k) => [k, 'receiver-unavailable:admission-ctrl'])));

    // purchase-svc는 답이 없고(연결 실패) queue-svc는 답한다: purchase 키만 unavailable
    transport.answer('queue-svc', E1, { waiting: 777 }, { measuredAtMs: NOW, podName: 'q' });
    const k = await compute.count(killEvents([E1]), NOW);
    expect(valuesOf(k.counted)).toEqual({ waiting: 777 });
    expect(reasons(k.unavailable)).toEqual(Object.fromEntries(PURCHASE_KEYS.map((key) => [key, 'receiver-unavailable:purchase-svc'])));
    for (const c of k.counted) expect(PURCHASE_KEYS).not.toContain(c.key);
  });

  test('C-T6 ① 받는 쪽이 세지 못한 키(no-cycle·no-source)는 그 사유 그대로 unavailable이고, 다른 키는 센 값이다', async () => {
    const { transport, compute } = wire();
    transport.raw('admission-ctrl', E1, {
      counts: [{ key: 'currentTarget', value: 3_000, source: 'leader-cycle', measuredAtMs: CYCLE_AT }],
      unavailable: ADMISSION_KEYS.filter((k) => k !== 'currentTarget').map((key) => ({ key, reason: key === 'servingRate' ? 'no-source' : 'no-cycle' })),
      podName: 'admission-ctrl-1',
    });
    const r = await compute.count(admission(E1), NOW);
    expect(r.counted).toEqual([{ key: 'currentTarget', value: 3_000, source: 'leader-cycle', measuredAt: iso(CYCLE_AT) }]);
    expect(reasons(r.unavailable)).toEqual({ ...Object.fromEntries(ADMISSION_KEYS.filter((k) => k !== 'currentTarget').map((k) => [k, 'no-cycle'])), servingRate: 'no-source' });
  });

  test('C-T6 ① 시간 초과: 받는 쪽이 999ms에 답하면 센 값이고, 답하지 않으면 1,000ms 정각에 receiver-timeout:<서비스>다(가짜 시계)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // 999ms에 답한다(1초 − 1ms)
    const fast = wire();
    fast.transport.after('admission-ctrl', E1, PREVIEW_TIMEOUT_MS - 1, {
      counts: ADMISSION_KEYS.map((key) => ({ key, value: 1, source: 'leader-cycle', measuredAtMs: NOW })),
      unavailable: [],
      podName: 'admission-ctrl-0',
    });
    const ok = fast.compute.count(admission(E1), NOW);
    await vi.advanceTimersByTimeAsync(999);
    const okResult = await ok;
    expect(okResult.unavailable).toEqual([]);
    expect(okResult.counted).toHaveLength(8);

    // 답하지 않는다: 999ms에는 아직 기다리고, 1,000ms(정본 데드라인 1초)에 시간 초과다
    const slow = wire();
    slow.transport.hang('queue-svc', E1);
    slow.transport.answer('purchase-svc', E1, { purchaseSessions: 5, paymentSessions: 1, holdsPerSecond5m: 0, paymentAcceptsPerSecond5m: 0 }, { measuredAtMs: NOW, podName: 'p' });
    let settled = false;
    const pending = slow.compute.count(killEvents([E1]), NOW).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(settled).toBe(true);
    expect(reasons(r.unavailable)).toEqual({ waiting: 'receiver-timeout:queue-svc' });
    // 0은 늘 적을 수 있는 값이라 센 값으로 남는다(실패와 다르다)
    expect(valuesOf(r.counted)).toEqual({ purchaseSessions: 5, paymentSessions: 1, holdsPerSecond5m: 0, paymentAcceptsPerSecond5m: 0 });
  });

  test('C-T6 ① 기본 데드라인은 정본 1초이고, 선택값 timeoutMs(시험 값 250ms)를 주면 그 시각에 시간 초과다', async () => {
    expect(PREVIEW_TIMEOUT_MS).toBe(1_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { transport, compute } = wire({ timeoutMs: 250 });
    transport.hang('admission-ctrl', E1);
    let settled = false;
    const pending = compute.count(admission(E1), NOW).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasons((await pending).unavailable)).toEqual(Object.fromEntries(ADMISSION_KEYS.map((k) => [k, 'receiver-timeout:admission-ctrl'])));
  });

  test('C-T6 ① 미리보기 HTTP 경로(POST /v1/ops/command-dry-runs)의 counted가 받는 쪽이 센 값이고, 실패한 키는 unavailable에 사유와 함께 남는다', async () => {
    const { transport, source } = wire();
    transport.answer('admission-ctrl', E1, LEADER, { measuredAtMs: CYCLE_AT, podName: 'admission-ctrl-0', source: 'leader-cycle' });
    const clock = fakeClock({ now: NOW });
    const identity = new FakeIdentity();
    const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };
    const svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, executor, auditChain: new MemoryAuditChain(), commandExtras: { dryRunSources: { ADMISSION_TARGET: source, KILL_SWITCH: source } } }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    try {
      const post = (body: unknown, who = identity.ops('operator')) =>
        svc.http.inject({ method: 'POST', url: '/v1/ops/command-dry-runs', headers: { ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      const r = await post({ type: 'ADMISSION_TARGET', reason: '목표 조정', params: { eventId: E1, target: 4_200 } });
      expect(r.statusCode, r.payload).toBe(200);
      const d = JSON.parse(r.payload) as { counted: unknown[]; unavailable: Array<{ key: string; reason: string }> };
      expect(d.counted).toEqual(ADMISSION_KEYS.map((key) => ({ key, value: LEADER[key as keyof typeof LEADER], source: 'leader-cycle', measuredAt: iso(CYCLE_AT) })));
      expect(d.unavailable.filter((u) => ADMISSION_KEYS.includes(u.key))).toEqual([]);

      // 명령 3(commander): 받는 쪽이 없으면 키마다 사유가 남고 counted는 비어 있다(0이 아니다)
      const k = await post({ type: 'KILL_SWITCH', reason: '정지 검토', params: { scope: 'EVENT', eventIds: [E1] } }, identity.ops('commander'));
      expect(k.statusCode, k.payload).toBe(200);
      const kd = JSON.parse(k.payload) as { counted: unknown[]; unavailable: Array<{ key: string; reason: string }> };
      expect(kd.counted).toEqual([]);
      expect(reasons(kd.unavailable.filter((u) => KILL_KEYS.includes(u.key)))).toEqual({
        ...Object.fromEntries(PURCHASE_KEYS.map((key) => [key, 'receiver-unavailable:purchase-svc'])),
        waiting: 'receiver-unavailable:queue-svc',
      });
    } finally {
      await svc.close();
    }
  });
});

describe('F025-PREVIEW 받은 값 검사·범위·키 수(B21~B23)', () => {
  test('F025-PREVIEW ① 요청 밖 키·NaN·Infinity·음수 값은 invalid-count이고 센 값에 들지 않는다. 0과 소수는 센 값이다', async () => {
    const { transport, compute } = wire();
    transport.raw('admission-ctrl', E1, {
      counts: [
        { key: 'currentTarget', value: 0, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'slotsUsed', value: Number.NaN, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'soonAdmitted', value: -1, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'inFlight', value: Number.POSITIVE_INFINITY, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'admitRatio', value: 0.42, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'avgDwellSeconds', value: -0.001, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'servingRateCap', value: 41, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        { key: 'servingRate', value: 7, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
        // 요청하지 않은 키(다른 명령의 키)
        { key: 'waiting', value: 12, source: 'leader-cycle', measuredAtMs: CYCLE_AT },
      ],
      unavailable: [],
      podName: 'admission-ctrl-0',
    });
    const r = await compute.count(admission(E1), NOW);
    expect(valuesOf(r.counted)).toEqual({ currentTarget: 0, admitRatio: 0.42, servingRateCap: 41, servingRate: 7 });
    expect(reasons(r.unavailable)).toEqual({ slotsUsed: 'invalid-count', soonAdmitted: 'invalid-count', inFlight: 'invalid-count', avgDwellSeconds: 'invalid-count' });
    expect(r.unavailable.map((u) => u.key)).not.toContain('waiting');
  });

  test('F025-PREVIEW ② 어댑터가 직접 받은 요청 밖 키는 센 값으로 돌려주지 않는다(ComputeDryRun의 거르기에 기대지 않는다)', async () => {
    const { transport, source } = wire();
    transport.raw('queue-svc', E1, { counts: [{ key: 'waiting', value: 5, source: 'q', measuredAtMs: NOW }, { key: 'paymentSessions', value: 9, source: 'q', measuredAtMs: NOW }], unavailable: [], podName: 'q' });
    const r = await source.count(killEvents([E1]), ['waiting'], NOW);
    expect(valuesOf(r.counted)).toEqual({ waiting: 5 });
    expect(transport.calls.map((c) => c.service)).toEqual(['queue-svc']);
  });

  test('F025-PREVIEW ③ 회차 셋 가운데 하나라도 purchase-svc가 실패하면 purchase 키는 합 없이 unavailable이고 queue 키는 세 회차의 합이다', async () => {
    const { transport, compute } = wire();
    transport.answer('purchase-svc', E1, { purchaseSessions: 10, paymentSessions: 1, holdsPerSecond5m: 1, paymentAcceptsPerSecond5m: 1 }, { measuredAtMs: NOW, podName: 'p1' });
    transport.answer('purchase-svc', E3, { purchaseSessions: 30, paymentSessions: 3, holdsPerSecond5m: 3, paymentAcceptsPerSecond5m: 3 }, { measuredAtMs: NOW, podName: 'p3' });
    // E2의 purchase-svc는 답이 없다
    for (const [e, w] of [[E1, 100], [E2, 200], [E3, 300]] as const) transport.answer('queue-svc', e, { waiting: w }, { measuredAtMs: NOW, podName: 'q' });
    const r = await compute.count(killEvents([E1, E2, E3]), NOW);
    expect(valuesOf(r.counted)).toEqual({ waiting: 600 });
    expect(reasons(r.unavailable)).toEqual(Object.fromEntries(PURCHASE_KEYS.map((k) => [k, 'receiver-unavailable:purchase-svc'])));
  });

  test('F025-PREVIEW ④ 회차 둘 가운데 한 회차가 그 키만 세지 못하면(no-source) 그 키는 합 없이 그 사유로 unavailable이다', async () => {
    const { transport, compute } = wire();
    transport.answer('purchase-svc', E1, { purchaseSessions: 10, paymentSessions: 1, holdsPerSecond5m: 2, paymentAcceptsPerSecond5m: 1 }, { measuredAtMs: NOW, podName: 'p1' });
    transport.raw('purchase-svc', E2, {
      counts: [
        { key: 'purchaseSessions', value: 20, source: 'p', measuredAtMs: NOW },
        { key: 'paymentSessions', value: 2, source: 'p', measuredAtMs: NOW },
        { key: 'paymentAcceptsPerSecond5m', value: 2, source: 'p', measuredAtMs: NOW },
      ],
      unavailable: [{ key: 'holdsPerSecond5m', reason: 'no-source' }],
      podName: 'p2',
    });
    transport.answer('queue-svc', E1, { waiting: 1 }, { measuredAtMs: NOW, podName: 'q' });
    transport.answer('queue-svc', E2, { waiting: 2 }, { measuredAtMs: NOW, podName: 'q' });
    const r = await compute.count(killEvents([E1, E2]), NOW);
    expect(valuesOf(r.counted)).toEqual({ purchaseSessions: 30, paymentSessions: 3, paymentAcceptsPerSecond5m: 3, waiting: 3 });
    expect(reasons(r.unavailable)).toEqual({ holdsPerSecond5m: 'no-source' });
  });

  test('F025-PREVIEW ⑤ 명령 3 PLATFORM 범위는 모든 키가 platform-scope-not-counted이고 받는 쪽을 부르지 않는다', async () => {
    const { transport, compute, targets } = wire();
    const r = await compute.count({ type: 'KILL_SWITCH', params: { scope: 'PLATFORM' } }, NOW);
    expect(r.counted).toEqual([]);
    expect(reasons(r.unavailable)).toEqual(Object.fromEntries(KILL_KEYS.map((k) => [k, 'platform-scope-not-counted'])));
    expect(transport.calls).toEqual([]);
    expect(targets.asked).toEqual([]);
  });

  test('F025-PREVIEW ⑥ 키가 17개면(상한 16) 받는 쪽을 부르지 않고 모두 too-many다. 16개는 부른다', async () => {
    const { transport, source } = wire();
    const many = Array.from({ length: 17 }, (_, i) => `k${i}`);
    const r = await source.count(admission(E1), many, NOW);
    expect(r.counted).toEqual([]);
    expect(reasons(r.unavailable)).toEqual(Object.fromEntries(many.map((k) => [k, 'too-many'])));
    expect(transport.calls).toEqual([]);

    transport.answer('admission-ctrl', E1, {}, { measuredAtMs: NOW, podName: 'a' });
    const sixteen = many.slice(0, 16);
    const s = await source.count(admission(E1), sixteen, NOW);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.req.keys).toEqual(sixteen);
    expect(reasons(s.unavailable)).toEqual(Object.fromEntries(sixteen.map((k) => [k, 'unknown-key'])));
  });

  test('F025-PREVIEW ⑦ 명령 4 키는 원천이 정해지는 F-02-6까지 source-not-wired 그대로다', async () => {
    const { transport, compute } = wire();
    const r = await compute.count({ type: 'BLOCK_ASN_IP', params: { cidrs: ['10.20.0.0/16'], expiresAt: iso(NOW + 3_600_000) } }, NOW);
    expect(r.counted).toEqual([]);
    expect(reasons(r.unavailable)).toEqual({ requests5m: 'source-not-wired', entryAttempts5m: 'source-not-wired' });
    expect(transport.calls).toEqual([]);
  });

  test('F025-PREVIEW ⑧ 대상 찾기가 주소를 하나도 주지 않으면 그 서비스 키는 receiver-unavailable:<서비스>다', async () => {
    const targets = new FakeTargets({ 'admission-ctrl': [] });
    const transport = new FakeTransport();
    const compute = new ComputeDryRun({ sources: { ADMISSION_TARGET: new ControlPreviewDryRunSource({ targets, transport }) } });
    const r = await compute.count(admission(E1), NOW);
    expect(r.counted).toEqual([]);
    expect(reasons(r.unavailable)).toEqual(Object.fromEntries(ADMISSION_KEYS.map((k) => [k, 'receiver-unavailable:admission-ctrl'])));
    expect(transport.calls).toEqual([]);
  });

  test('F025-PREVIEW ⑨ 시작 파일(main.ts)은 명령 1·3의 dryRunSources에 ControlPreviewDryRunSource를 F-02-1의 대상 찾기·전송으로 넘긴다', () => {
    const code = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const made = [...code.matchAll(/new ControlPreviewDryRunSource\(\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(made.length).toBeGreaterThan(0);
    expect(made.some((args) => /targets:\s*controlTargets\.targets/.test(args) && /transport:\s*controlTransport/.test(args))).toBe(true);
    const sources = /dryRunSources\s*:\s*\{([^}]*)\}/.exec(code);
    expect(sources, 'dryRunSources 조립').not.toBeNull();
    expect(sources![1]).toMatch(/ADMISSION_TARGET\s*:/);
    expect(sources![1]).toMatch(/KILL_SWITCH\s*:/);
  });
});

describe('[ASVS v5.0.0-1.3.6] PreviewControl 대상은 ControlTargets에서만 온다', () => {
  test('[ASVS v5.0.0-1.3.6] ③ 명령 params에 주소·호스트 같은 값을 넣어도 전송이 받은 주소는 대상 찾기가 준 것뿐이다', async () => {
    const { transport, compute } = wire();
    transport.answer('admission-ctrl', E1, LEADER, { measuredAtMs: CYCLE_AT, podName: 'admission-ctrl-0' });
    transport.answer('purchase-svc', E1, { purchaseSessions: 1, paymentSessions: 1, holdsPerSecond5m: 1, paymentAcceptsPerSecond5m: 1 }, { measuredAtMs: NOW, podName: 'p' });
    transport.answer('queue-svc', E1, { waiting: 1 }, { measuredAtMs: NOW, podName: 'q' });
    const evil = { address: '169.254.169.254:80', host: 'evil.example', target: 'http://evil.example:50061', service: 'evil-svc' };
    await compute.count(admission(E1, evil), NOW);
    await compute.count({ type: 'KILL_SWITCH', params: { scope: 'EVENT', eventIds: [E1], ...evil }, eventId: E1 }, NOW);
    const allowed = new Set(Object.values(TARGETS).flat());
    expect(transport.calls.length).toBe(3);
    for (const c of transport.calls) {
      expect(allowed.has(c.address), c.address).toBe(true);
      expect(['admission-ctrl', 'purchase-svc', 'queue-svc']).toContain(c.service);
      expect(TARGETS[c.service as keyof typeof TARGETS]).toContain(c.address);
    }
  });

  test('[ASVS v5.0.0-1.3.6] ③ 범위가 소문자 UUID 꼴이 아닌 회차는 받는 쪽에 보내지 않는다', async () => {
    const { transport, source } = wire();
    const r = await source.count({ type: 'ADMISSION_TARGET', params: { eventId: '../../admin', target: 4_200 }, eventId: '../../admin' }, ADMISSION_KEYS, NOW);
    expect(transport.calls).toEqual([]);
    expect(r.counted).toEqual([]);
    expect(r.unavailable.map((u) => u.key).sort()).toEqual([...ADMISSION_KEYS].sort());
  });
});
