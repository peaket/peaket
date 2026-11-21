// 명령 사전 모의(dry-run) 시험(BAT-355 OPS-260, C-T6 ②③, docs/features/control-tower.md §4 '센 값·예측 값·예측 오차 기록', ADR-0340 결정 2·3·11, ADR-0339 결정 3·4).
// 센 값 원천은 포트 DryRunSource다(실제 원천 어댑터는 BAT-365). 시험은 그 포트를 구현한 원천 대역으로 값을 넣고,
// 예측 값은 시험이 정본 식으로 따로 계산해 견준다. 미리보기(POST /v1/ops/command-dry-runs)는 저장·감사가 없고, 접수는 같은 계산을 DRY_RUN 사건에 남긴다.
// 실행 뒤 비교는 처음 DISPATCHED + 5분 [가정]이고, 원천을 세지 못하면 unavailable로 남긴다(빈 결과를 '일치'로 적지 않는다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  COMMAND_STORE,
  MaintainCommands,
  MemoryCommandStore,
  type CommandExecutor,
  type CommandType,
  type DryRunCountResult,
  type DryRunSource,
  type DryRunTarget,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-22T04:00:00.000Z');
const MIN = 60_000;
const SYSTEM_REF = '00000000-0000-0000-0000-000000000000';
const iso = (ms: number) => new Date(ms).toISOString();

/** 센 값 원천 대역(포트 DryRunSource 구현). 값·세지 못함·실패를 시험이 고른다 */
class ScriptedSource implements DryRunSource {
  mode: 'values' | 'unavailable' | 'throw' = 'values';
  values: Record<string, number> = {};
  readonly calls: Array<{ readonly type: CommandType; readonly keys: readonly string[]; readonly nowMs: number }> = [];

  async count(target: DryRunTarget, keys: readonly string[], nowMs: number): Promise<DryRunCountResult> {
    this.calls.push({ type: target.type, keys, nowMs });
    if (this.mode === 'throw') throw new Error('admission-ctrl unavailable');
    if (this.mode === 'unavailable') return { counted: [], unavailable: keys.map((key) => ({ key, source: 'admission-ctrl', reason: 'timeout' })) };
    return { counted: keys.filter((k) => k in this.values).map((key) => ({ key, value: this.values[key]!, source: 'admission-ctrl', measuredAt: iso(nowMs) })), unavailable: [] };
  }
}

/** 명령 1을 세는 지금 값(control-tower §4 '센 값': 지금 목표, 예매 단계 인원, 곧 입장 대기, 오는 중, 입장 비율, 평균 체류, 전진 속도 상한, serving 증가 속도) */
const BEFORE = { currentTarget: 3_000, slotsUsed: 2_700, soonAdmitted: 150, inFlight: 90, admitRatio: 0.6, avgDwellSeconds: 480, servingRateCap: 40, servingRate: 5 };
/** 실행 5분 뒤 다시 센 값 */
const AFTER = { ...BEFORE, currentTarget: 4_200, slotsUsed: 3_900, soonAdmitted: 120, inFlight: 60, servingRate: 13.1 };

type Headers = Record<string, string>;
type Res = { readonly statusCode: number; readonly payload: string };
interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly audit: MemoryAuditChain;
  readonly store: MemoryCommandStore;
  readonly maintain: MaintainCommands;
  readonly executed: string[];
  post(url: string, who: Headers, body: unknown): Promise<Res>;
  get(url: string, who: Headers): Promise<Res>;
}
const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
});

async function harness(source?: DryRunSource): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const audit = new MemoryAuditChain();
  const executed: string[] = [];
  const executor: CommandExecutor = { execute: async (c) => (executed.push(c.commandId), { status: 'ACKED', ackedAtMs: clock.now() }) };
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, executor, auditChain: audit, ...(source ? { commandExtras: { dryRunSources: { ADMISSION_TARGET: source } } } : {}) }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const store: unknown = svc.app.get(COMMAND_STORE);
  if (!(store instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
  const h: Harness = {
    svc,
    clock,
    identity,
    audit,
    store,
    maintain: svc.app.get(MaintainCommands),
    executed,
    post: (url, who, body) =>
      svc.http.inject({ method: 'POST', url, headers: { ...who, ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url, who) => svc.http.inject({ method: 'GET', url, headers: who }),
  };
  opened.push(h);
  return h;
}

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
interface Prediction {
  key: string;
  value: number;
  formula: string;
  inputs: Record<string, number>;
  assumptions: string[];
}
const predictions = (d: Record<string, unknown>) => new Map((d.predicted as Prediction[]).map((p) => [p.key, p]));
const body = (eventId: string, target: number) => ({ type: 'ADMISSION_TARGET', reason: '목표 조정', params: { eventId, target } });
/** 식이 넣은 값의 이름을 모두 보이는가(화면에 식과 넣은 값을 함께 보인다, control-tower §4) */
const namesInputs = (p: Prediction) => Object.keys(p.inputs).every((k) => p.formula.includes(k));

describe('C-T6 ② 예측 값은 식·넣은 값·가정을 함께 싣는다', () => {
  test('C-T6 ② 명령 1 목표를 올리면 빈자리·채우는 시간·정상 상태 입장 속도·serving 증가 속도가 정본 식의 값이고 식·넣은 값·가정을 함께 싣는다(미리보기는 저장·감사·실행이 없다)', async () => {
    const source = new ScriptedSource();
    source.values = BEFORE;
    const h = await harness(source);
    const op = h.identity.ops('operator');
    const r = await h.post('/v1/ops/command-dry-runs', op, body(randomUUID(), 4_200));
    expect(r.statusCode, r.payload).toBe(200);
    const d = json(r);
    expect(d).toMatchObject({ version: 1, approvalMode: 'ONE', reauthRequired: false, unavailable: [] });
    // 센 값마다 원천과 센 시각을 함께 보인다
    expect(d.counted).toEqual(Object.entries(BEFORE).map(([key, value]) => ({ key, value, source: 'admission-ctrl', measuredAt: iso(NOW) })));
    // 안전 한계: 목표 8,000·1,000(control-tower §3 명령 1)
    expect(Object.values(d.limits as Record<string, number>).sort((a, b) => a - b)).toEqual([1_000, 8_000]);
    // 정본 식(control-tower §4): T′ = 4,200
    const vacancy = 4_200 - BEFORE.slotsUsed - BEFORE.soonAdmitted - BEFORE.inFlight; // 처음 채울 빈자리 = T′ − 예매 단계 인원 − 곧 입장 대기 − 오는 중
    const fill = vacancy / BEFORE.admitRatio / BEFORE.servingRateCap; // 채우는 시간 ≈ 빈자리 ÷ 입장 비율 ÷ 전진 속도 상한
    const steady = 4_200 / BEFORE.avgDwellSeconds; // 정상 상태 입장 속도 ≈ T′ ÷ 평균 체류
    const serving = steady / BEFORE.admitRatio; // serving 증가 속도 ≈ 입장 속도 ÷ 입장 비율
    const p = predictions(d);
    expect([...p.keys()].sort()).toEqual(['fillSeconds', 'servingRate', 'steadyAdmissionRate', 'vacancy']);
    expect(vacancy).toBe(1_260);
    expect(p.get('vacancy')!.value).toBe(vacancy);
    expect(Object.values(p.get('vacancy')!.inputs).sort((a, b) => a - b)).toEqual([90, 150, 2_700, 4_200]);
    expect(p.get('fillSeconds')!.value).toBeCloseTo(fill, 9);
    expect(Object.values(p.get('fillSeconds')!.inputs).sort((a, b) => a - b)).toEqual([0.6, 40, 1_260]);
    expect(p.get('steadyAdmissionRate')!.value).toBeCloseTo(steady, 9);
    expect(Object.values(p.get('steadyAdmissionRate')!.inputs).sort((a, b) => a - b)).toEqual([480, 4_200]);
    expect(p.get('servingRate')!.value).toBeCloseTo(serving, 9);
    expect(Object.values(p.get('servingRate')!.inputs).sort((a, b) => a - b)).toEqual([0.6, steady]);
    for (const x of p.values()) {
      expect(x.formula, x.key).not.toBe('');
      expect(namesInputs(x), x.key).toBe(true);
      expect(Array.isArray(x.assumptions), x.key).toBe(true);
    }
    // 정상 상태 가정을 적는다(머무는 시간·입장 비율이 지금과 같다)
    expect(p.get('steadyAdmissionRate')!.assumptions.length).toBeGreaterThan(0);
    expect(p.get('servingRate')!.assumptions.length).toBeGreaterThan(0);
    expect(source.calls).toEqual([{ type: 'ADMISSION_TARGET', keys: Object.keys(BEFORE), nowMs: NOW }]);
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    expect(h.audit.entries).toEqual([]);
    expect(h.executed).toEqual([]);
  });

  test('C-T6 ② 목표를 내리면 새 목표에 닿는 시간 = 평균 체류 × ln(예매 단계 인원 ÷ 새 목표)이고 지수 분포 가정을 함께 싣는다', async () => {
    const source = new ScriptedSource();
    source.values = BEFORE;
    const h = await harness(source);
    const d = json(await h.post('/v1/ops/command-dry-runs', h.identity.ops('operator'), body(randomUUID(), 1_800)));
    const p = predictions(d);
    expect([...p.keys()]).toEqual(['reachSeconds']);
    const reach = p.get('reachSeconds')!;
    expect(reach.value).toBeCloseTo(BEFORE.avgDwellSeconds * Math.log(BEFORE.slotsUsed / 1_800), 9);
    expect(Object.values(reach.inputs).sort((a, b) => a - b)).toEqual([480, 1_800, 2_700]);
    expect(namesInputs(reach)).toBe(true);
    expect(reach.assumptions.length).toBeGreaterThan(0);
  });

  test('C-T6 ② 접수는 같은 계산을 다시 해 DRY_RUN 사건에 남기고, 상세의 dryRun이 그 기록이다(미리보기 뒤 원천 값이 바뀌면 기록은 접수 때 값)', async () => {
    const source = new ScriptedSource();
    source.values = BEFORE;
    const h = await harness(source);
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    const preview = json(await h.post('/v1/ops/command-dry-runs', op, body(eventId, 4_200)));
    source.values = { ...BEFORE, slotsUsed: 2_000 };
    h.clock.advance(MIN);
    const created = await h.post('/v1/ops/commands', op, body(eventId, 4_200));
    expect(created.statusCode, created.payload).toBe(201);
    const id = json(created).commandId as string;
    const recorded = h.store.eventsOf(id).find((e) => e.type === 'DRY_RUN')!.dryRun as Record<string, unknown>;
    expect(predictions(recorded).get('vacancy')!.value).toBe(4_200 - 2_000 - BEFORE.soonAdmitted - BEFORE.inFlight);
    expect(predictions(preview).get('vacancy')!.value).toBe(1_260);
    expect((recorded.counted as Array<{ measuredAt: string }>).every((c) => c.measuredAt === iso(NOW + MIN))).toBe(true);
    expect(json(await h.get(`/v1/ops/commands/${id}`, op)).dryRun).toEqual(recorded);
  });

  test('C-T6 ② 원천을 세지 못하면(원천 없음·세지 못함·실패) 센 값·예측은 비고 그 값들이 unavailable에 남으며 0으로 적지 않고, 비교 때도 두지 않는다', async () => {
    const make = async (mode: ScriptedSource['mode'] | 'none') => {
      if (mode === 'none') return harness();
      const s = new ScriptedSource();
      s.mode = mode;
      return harness(s);
    };
    for (const mode of ['none', 'unavailable', 'throw'] as const) {
      const h = await make(mode);
      const op = h.identity.ops('operator');
      const d = json(await h.post('/v1/ops/command-dry-runs', op, body(randomUUID(), 4_200)));
      expect(d.counted, mode).toEqual([]);
      expect(d.predicted, mode).toEqual([]);
      const missing = (d.unavailable as Array<{ key: string; reason: string }>).map((u) => u.key);
      for (const key of Object.keys(BEFORE)) expect(missing, `${mode} ${key}`).toContain(key);
      const created = json(await h.post('/v1/ops/commands', op, body(randomUUID(), 4_200)));
      expect(created.state, mode).toBe('ACKED');
      expect((await h.store.find(created.commandId as string))?.compareDueAtMs, mode).toBeUndefined();
    }
  });

  test('[ASVS v5.0.0-2.2.1] 명령 4 미리보기는 걸린 보호 목록 항목(분류·라벨)과 목록 판(2026-11-21)을 싣고, 2인·재인증 필요를 알리며 재인증·멱등 키 없이 저장하지 않는다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const preview = (params: Record<string, unknown>) => h.post('/v1/ops/command-dry-runs', op, { type: 'BLOCK_ASN_IP', reason: '미리보기', params: { ...params, expiresAt: iso(NOW + 60 * MIN) } });
    // ADR-0339 결정 4의 첫 목록(ASN 11개)
    const listed: Array<[number, string, string]> = [
      [4766, 'KR_CARRIER', 'KT'],
      [9318, 'KR_CARRIER', 'SK브로드밴드'],
      [3786, 'KR_CARRIER', 'LG유플러스'],
      [17858, 'KR_CARRIER', 'LG유플러스'],
      [9644, 'KR_CARRIER', 'SK텔레콤'],
      [16509, 'CLOUD', 'AWS'],
      [14618, 'CLOUD', 'AWS'],
      [15169, 'CLOUD', 'Google'],
      [396982, 'CLOUD', 'Google'],
      [8075, 'CLOUD', 'Microsoft'],
      [13335, 'CLOUD', 'Cloudflare'],
    ];
    const all = await preview({ asns: listed.map(([asn]) => asn) });
    expect(all.statusCode, all.payload).toBe(200);
    expect(json(all)).toMatchObject({ approvalMode: 'TWO', reauthRequired: true, protectedRangesVersion: '2026-11-21' });
    expect((json(all).protectedRangeHits as unknown[]).length).toBe(11);
    expect(json(all).protectedRangeHits).toEqual(expect.arrayContaining(listed.map(([asn, category, label]) => ({ kind: 'ASN', value: String(asn), category, label }))));
    const kt = json(await preview({ asns: [4766] }));
    expect(kt.protectedRangeHits).toEqual([{ kind: 'ASN', value: '4766', category: 'KR_CARRIER', label: 'KT' }]);
    // 목록 밖 ASN도 ASN이라 2인이지만 걸린 항목은 없다
    expect(json(await preview({ asns: [64500] }))).toMatchObject({ approvalMode: 'TWO', reauthRequired: true, protectedRangeHits: [] });
    expect(json(await preview({ cidrs: ['10.20.0.0/16'] }))).toMatchObject({ approvalMode: 'ONE', reauthRequired: false, protectedRangeHits: [] });
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    expect(h.audit.entries).toEqual([]);
    // 접수와 같은 403: operator는 명령 3을 미리 볼 수 없고 viewer는 경로를 못 쓴다
    expect((await h.post('/v1/ops/command-dry-runs', op, { type: 'KILL_SWITCH', reason: '미리보기', params: { scope: 'PLATFORM' } })).statusCode).toBe(403);
    expect((await h.post('/v1/ops/command-dry-runs', h.identity.ops('viewer'), { type: 'LOG_LEVEL', reason: '미리보기', params: {} })).statusCode).toBe(403);
  });
});

describe('C-T6 ③ 실행 5분 뒤 예측과 실제', () => {
  const setup = async () => {
    const source = new ScriptedSource();
    source.values = BEFORE;
    const h = await harness(source);
    const op = h.identity.ops('operator');
    const created = json(await h.post('/v1/ops/commands', op, body(randomUUID(), 4_200)));
    expect(created.state).toBe('ACKED');
    const id = created.commandId as string;
    // 처음 DISPATCHED(접수 때 바로 실행, NOW) + 5분
    expect((await h.store.find(id))?.compareDueAtMs).toBe(NOW + 5 * MIN);
    return { h, source, id };
  };

  test('C-T6 ③ 실행 5분 뒤 예측과 실제(빈자리·serving 증가 속도·예매 단계 인원)가 명령 기록에 남고, 5분 − 1ms에는 아직 아니며 한 번만 남는다', async () => {
    const { h, source, id } = await setup();
    source.values = AFTER;
    expect((await h.maintain.runOnce(NOW + 5 * MIN - 1)).compared).toBe(0);
    expect(h.store.eventsOf(id).map((e) => e.type)).not.toContain('DRY_RUN_COMPARED');
    expect((await h.maintain.runOnce(NOW + 5 * MIN)).compared).toBe(1);
    const ev = h.store.eventsOf(id).at(-1)!;
    expect(ev).toMatchObject({ type: 'DRY_RUN_COMPARED', actorRef: SYSTEM_REF, actorRole: 'system' });
    const detail = ev.detail as { measuredAt: string; pairs: Array<{ key: string; predicted: number; actual: number; diff: number }>; actual: Array<{ key: string; value: number }>; unavailable: Array<{ key: string }> };
    expect(detail.measuredAt).toBe(iso(NOW + 5 * MIN));
    const pair = new Map(detail.pairs.map((x) => [x.key, x]));
    const actualVacancy = 4_200 - AFTER.slotsUsed - AFTER.soonAdmitted - AFTER.inFlight;
    expect(pair.get('vacancy')).toEqual({ key: 'vacancy', predicted: 1_260, actual: actualVacancy, diff: actualVacancy - 1_260 });
    const predictedServing = 4_200 / BEFORE.avgDwellSeconds / BEFORE.admitRatio;
    expect(pair.get('servingRate')!.predicted).toBeCloseTo(predictedServing, 9);
    expect(pair.get('servingRate')!.actual).toBe(13.1);
    expect(pair.get('servingRate')!.diff).toBeCloseTo(13.1 - predictedServing, 9);
    expect(detail.actual).toEqual(expect.arrayContaining([{ key: 'slotsUsed', value: 3_900, source: 'admission-ctrl', measuredAt: iso(NOW + 5 * MIN) }]));
    expect(source.calls.at(-1)).toEqual({ type: 'ADMISSION_TARGET', keys: Object.keys(BEFORE), nowMs: NOW + 5 * MIN });
    expect((await h.store.find(id))?.compareDueAtMs).toBeUndefined();
    expect(h.audit.entries.filter((e) => e.recordId === id).map((e) => e.recordType)).toContain('COMMAND_DRY_RUN_COMPARED');
    expect((await h.maintain.runOnce(NOW + 10 * MIN)).compared).toBe(0);
    expect(h.store.eventsOf(id).filter((e) => e.type === 'DRY_RUN_COMPARED')).toHaveLength(1);
  });

  test("C-T6 ③ 실행 5분 뒤 원천을 세지 못하면(실패·세지 못함) 비교는 unavailable로 남고 '일치'로 적지 않는다", async () => {
    for (const mode of ['throw', 'unavailable'] as const) {
      const { h, source, id } = await setup();
      source.mode = mode;
      expect((await h.maintain.runOnce(NOW + 5 * MIN)).compared, mode).toBe(1);
      const ev = h.store.eventsOf(id).at(-1)!;
      expect(ev.type, mode).toBe('DRY_RUN_COMPARED');
      const detail = ev.detail as { pairs: unknown[]; actual: unknown[]; unavailable: Array<{ key: string }> };
      expect(detail.pairs, mode).toEqual([]);
      expect(detail.actual, mode).toEqual([]);
      const keys = detail.unavailable.map((u) => u.key);
      for (const key of ['vacancy', 'servingRate', 'slotsUsed']) expect(keys, `${mode} ${key}`).toContain(key);
      expect((await h.store.find(id))?.compareDueAtMs, mode).toBeUndefined();
    }
  });
});
