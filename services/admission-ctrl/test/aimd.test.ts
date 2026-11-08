// 자동 제어의 순수 판단(docs/features/queue-admission.md §5 '자동 제어의 첫 구현', ADR-0226). 정본 시험 표의 Q-T42·Q-T43·Q-T49·Q-T67.
import { describe, expect, test } from 'vitest';
import { ALL_JOURNEYS, type AimdContext, type AimdMemory, type BudgetKind, boundsOf, changedFields, decideAimd, demandOf, type EventInputs, initialMemory, isManualFixed, type Journey, LINKED_JOURNEYS, memoryFromFields, memoryToFields, openGapViolationsOf, pgRateCapOf, pgTargetCapOf, type Reading, shareRate, shareTargets } from '../src/modules/leader/domain/aimd.js';

const T0 = 1_000_000_000;
const FREEZE = 15 * 60_000;
const ok = (value: number, atMs: number): Reading => ({ ok: true, value, atMs });
const MISSING: Reading = { ok: false, why: 'missing' };

function budget(atMs: number, on: Partial<Record<`${Journey}:${BudgetKind}`, number>> = {}): Map<string, Reading> {
  const m = new Map<string, Reading>();
  for (const j of ALL_JOURNEYS) for (const k of ['alert', 'burn50'] as const) m.set(`${j}:${k}`, ok(on[`${j}:${k}`] ?? 0, atMs));
  return m;
}
function inputs(atMs: number, o: { p99?: number; err?: number; seat?: number; budget?: Map<string, Reading>; pgCause?: boolean; latency?: Reading; errors?: Reading; seatStore?: Reading } = {}): EventInputs {
  return { latency: o.latency ?? ok(o.p99 ?? 0.02, atMs), errors: o.errors ?? ok(o.err ?? 0, atMs), seatStore: o.seatStore ?? ok(o.seat ?? 0, atMs), budget: o.budget ?? budget(atMs), pgCause: o.pgCause ?? false };
}

type Over = Partial<Omit<AimdContext, 'memory' | 'nowMs' | 'inputs'>>;
function run(memory: AimdMemory, nowMs: number, inp: EventInputs, o: Over = {}) {
  return decideAimd({ nowMs, memory, inputs: inp, slotsUsed: undefined, paused: false, autoStopped: false, operator: { value: null, untilMs: null, resumeAtMs: null }, upper: 8_000, lower: 1_000, pgLimited: false, ...o });
}

describe('제어 입력 없음', () => {
  test.each([
    ['빈결과', MISSING],
    ['쿼리실패', { ok: false, why: 'failed' } as Reading],
    ['31초전표본', ok(0.02, T0 - 31_000)],
    ['기록규칙이건너뛰어4분전값', ok(0.02, T0 - 240_000)],
  ])('[Q-T42] [ASVS v5.0.0-16.5.2] %s는_입력없음이고_증가도감소도없다', (_n, latency) => {
    const m = initialMemory(5_000, T0 - 120_000);
    const r = run(m, T0, inputs(T0, { latency, p99: 9 }));
    expect(r.target).toBe(5_000);
    expect(r.decreases).toEqual([]);
    expect(r.staleKinds).toEqual(['downstream_latency']);
    expect(r.memory.staleSince).toBe(T0);
  });

  test('[Q-T42] 입력없음동안_명령1은반영되고_결제사상한으로는줄어든다', () => {
    const m = initialMemory(5_000, T0 - 120_000);
    const a = run(m, T0, inputs(T0, { latency: MISSING }), { operator: { value: 6_000, untilMs: T0 + FREEZE, resumeAtMs: null } });
    expect(a.target).toBe(6_000);
    const b = run(a.memory, T0 + 200, inputs(T0, { latency: MISSING }), { upper: 4_500, lower: 1_000, pgLimited: true });
    expect(b.target).toBe(4_500);
    expect(b.decreases).toEqual([expect.objectContaining({ reason: 'pg_cap', from: 6_000, to: 4_500 })]);
  });

  test('[Q-T42] 입력이10초이어서들어오면_감축은바로다시하고_증액은복귀확인전까지없다', () => {
    let m = run(initialMemory(5_000, T0 - 120_000), T0, inputs(T0, { latency: MISSING })).memory;
    expect(m.staleSince).toBe(T0);
    // 9초까지는 아직 입력 없음
    m = run(m, T0 + 1_000, inputs(T0 + 1_000)).memory;
    expect(run(m, T0 + 9_000, inputs(T0 + 9_000, { p99: 9 })).decreases).toEqual([]);
    const back = run(m, T0 + 11_000, inputs(T0 + 11_000, { p99: 9 }));
    expect(back.memory.staleSince).toBeNull();
    expect(back.decreases).toEqual([expect.objectContaining({ reason: 'aimd', to: 2_500 })]);
    // 정상 표본이 계속 와도 복귀 확인 전에는 늘지 않는다
    let last = run(back.memory, T0 + 50_000, inputs(T0 + 50_000));
    last = run(last.memory, T0 + 90_000, inputs(T0 + 90_000));
    expect(last.target).toBe(2_500);
    // 복귀 확인 뒤에는 는다
    const resumed = run(last.memory, T0 + 130_000, inputs(T0 + 130_000), { operator: { value: null, untilMs: null, resumeAtMs: T0 + 100_000 } });
    expect(resumed.target).toBe(2_600);
  });

  test('[Q-T42] 리더가바뀌어도_입력없음상태와감축확인이이어진다', () => {
    const m = run(initialMemory(5_000, T0 - 120_000), T0, inputs(T0, { latency: MISSING })).memory;
    const fields = memoryToFields({ ...m, decAt: T0 - 1_000, decTo: 2_500 });
    expect(fields.inputStale).toBe('1');
    const next = memoryFromFields(fields, 5_000, T0 + 500);
    expect(next.staleSince).toBe(T0);
    expect(next.decAt).toBe(T0 - 1_000);
    expect(next.decTo).toBe(2_500);
    expect(run(next, T0 + 500, inputs(T0 + 500, { latency: MISSING })).memory.staleSince).toBe(T0);
  });

  test('[Q-T42] 바뀐칸만_다시쓴다', () => {
    const before = memoryToFields(initialMemory(5_000, T0));
    const after = memoryToFields({ ...initialMemory(5_000, T0), staleSince: T0 });
    expect(changedFields(before, after)).toEqual({ inputStale: '1', inputStaleAt: String(T0) });
    expect(changedFields(after, after)).toEqual({});
  });
});

describe('증액 주기', () => {
  test('[Q-T42] 운영과같은5초간격정상입력3분에_증액은창마다한번모두6번이고_표본이바뀌기전증액은0건이다', () => {
    let m = initialMemory(5_000, T0);
    let inc = 0;
    for (let t = 0; t <= 180_000; t += 200) {
      const at = T0 + Math.floor(t / 5_000) * 5_000;
      const r = run(m, T0 + t, inputs(at));
      if (r.memory.target > m.target) {
        inc += 1;
        expect(r.memory.target - m.target).toBe(100);
        expect(t % 5_000).toBeLessThan(200);
      }
      m = r.memory;
    }
    expect(inc).toBe(6);
    expect(m.target).toBe(5_600);
  });

  test('[Q-T42] 입장일시정지와판매일시정지동안_증액은없고_감축은있다', () => {
    const m = initialMemory(5_000, T0 - 60_000);
    expect(run(m, T0, inputs(T0), { paused: true }).target).toBe(5_000);
    expect(run(m, T0, inputs(T0, { p99: 9 }), { paused: true }).target).toBe(2_500);
  });

  test('[Q-T67] 증액은안전상한을넘지않고_명령11로멈춘동안은판단하지않는다', () => {
    const m = initialMemory(7_950, T0 - 60_000);
    expect(run(m, T0, inputs(T0)).target).toBe(8_000);
    const stopped = run(m, T0, inputs(T0, { p99: 9, budget: budget(T0, { 'hold:alert': 1 }) }), { autoStopped: true });
    expect(stopped.target).toBe(7_950);
    expect(stopped.decreases).toEqual([]);
  });
});

describe('감축 확인 시간', () => {
  const hot = (at: number) => inputs(at, { p99: 9 });

  test('[Q-T43] AIMD감축은한번만하고_35초전에는인원이내려와도다음감축이없다', () => {
    const first = run(initialMemory(5_000, T0 - 60_000), T0, hot(T0));
    expect(first.decreases).toEqual([expect.objectContaining({ reason: 'aimd', from: 5_000, to: 2_500 })]);
    let suppressed = 0;
    let m = first.memory;
    for (let t = 5_000; t <= 20_000; t += 5_000) {
      const r = run(m, T0 + t, hot(T0 + t), { slotsUsed: t >= 20_000 ? 2_400 : 4_800 });
      expect(r.decreases).toEqual([]);
      suppressed += r.suppressed;
      m = r.memory;
    }
    expect(suppressed).toBe(4);
    // 35초가 지났고 인원이 새 목표 아래면 다시 줄인다
    expect(run(m, T0 + 36_000, hot(T0 + 36_000), { slotsUsed: 2_400 }).decreases).toEqual([expect.objectContaining({ reason: 'aimd', to: 1_250 })]);
    // 인원이 내려오지 않으면 2분까지 막는다
    expect(run(m, T0 + 100_000, hot(T0 + 100_000), { slotsUsed: 4_000 }).decreases).toEqual([]);
    expect(run(m, T0 + 121_000, hot(T0 + 121_000), { slotsUsed: 4_000 }).decreases).toEqual([expect.objectContaining({ reason: 'aimd', to: 1_250 })]);
  });

  test('[Q-T43] 같은표본은_막은감축으로_두번세지않는다', () => {
    const first = run(initialMemory(5_000, T0 - 60_000), T0, hot(T0));
    const at = T0 + 5_000;
    const a = run(first.memory, at, hot(at), { slotsUsed: 3_000 });
    expect(a.suppressed).toBe(1);
    expect(run(a.memory, at + 200, hot(at), { slotsUsed: 3_000 }).suppressed).toBe(0);
  });

  test('[Q-T43] 에러버짓연동감축은새경보에한번만이고_AIMD확인시간에막히지않으며_하한아래로내려가지않는다', () => {
    const first = run(initialMemory(5_000, T0 - 60_000), T0, hot(T0));
    const on = budget(T0 + 5_000, { 'hold:alert': 1 });
    const cut = run(first.memory, T0 + 5_000, inputs(T0 + 5_000, { p99: 9, budget: on }), { slotsUsed: 4_000 });
    expect(cut.decreases).toEqual([expect.objectContaining({ reason: 'budget_alert', journey: 'hold', to: 1_250 })]);
    // 계속 울려도 다시 줄이지 않는다
    expect(run(cut.memory, T0 + 10_000, inputs(T0 + 10_000, { p99: 9, budget: on }), { slotsUsed: 4_000 }).decreases).toEqual([]);
    // 하한
    const low = run({ ...cut.memory, budgetSeen: [] }, T0 + 15_000, inputs(T0 + 15_000, { budget: budget(T0 + 15_000, { 'seat_status:alert': 1 }) }));
    expect(low.target).toBe(1_000);
    const lower = run(low.memory, T0 + 20_000, inputs(T0 + 20_000, { budget: budget(T0 + 20_000, { 'seat_status:burn50': 1 }) }));
    expect(lower.target).toBe(1_000);
  });
});

describe('에러 버짓 연동 감축의 여정', () => {
  test.each(LINKED_JOURNEYS.flatMap((j) => (['alert', 'burn50'] as const).map((k) => [j, k] as const)))('[Q-T49] 연동여정 %s의 %s는_목표를한번2500으로줄이고_자동증액을멈춘다', (journey, kind) => {
    const key = `${journey}:${kind}` as const;
    const r = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { budget: budget(T0, { [key]: 1 }) }));
    expect(r.target).toBe(2_500);
    expect(r.decreases).toEqual([expect.objectContaining({ reason: kind === 'alert' ? 'budget_alert' : 'budget_50', journey })]);
    expect(r.ignored).toEqual([]);
    const next = run(r.memory, T0 + 40_000, inputs(T0 + 40_000, { budget: budget(T0 + 40_000, { [key]: 1 }) }));
    expect(next.target).toBe(2_500);
    expect(next.decreases).toEqual([]);
  });

  test.each((['detail', 'queue_entry', 'queue_state'] as const).flatMap((j) => (['alert', 'burn50'] as const).map((k) => [j, k] as const)))('[Q-T49] 연동이아닌여정 %s의 %s는_목표변화0이고_세기만한다', (journey, kind) => {
    const key = `${journey}:${kind}` as const;
    const r = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { budget: budget(T0, { [key]: 1 }) }));
    expect(r.target).toBe(5_100);
    expect(r.ignored).toEqual([journey]);
    expect(run(r.memory, T0 + 200, inputs(T0, { budget: budget(T0, { [key]: 1 }) })).ignored).toEqual([]);
  });

  test('[Q-T49] 결제사원인신호와함께결제여정으로줄이면_노출줄이기로남는다', () => {
    const r = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { pgCause: true, budget: budget(T0, { 'payment_confirm:alert': 1 }) }));
    expect(r.decreases[0]).toMatchObject({ exposure: true, reason: 'budget_alert' });
    expect(JSON.parse(r.memory.lastDecrease!)).toMatchObject({ reason: 'budget_alert', journey: 'payment_confirm', exposure: true });
    const hold = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { pgCause: true, budget: budget(T0, { 'hold:alert': 1 }) }));
    expect(hold.decreases[0]?.exposure).toBeUndefined();
  });

  test('[Q-T49] 입력없음동안에는_예산감축도하지않고_돌아온뒤아직울리면그때줄인다', () => {
    const on = { 'hold:alert': 1 } as const;
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { latency: MISSING, budget: budget(T0, on) }));
    expect(a.target).toBe(5_000);
    expect(a.memory.budgetSeen).toEqual([]);
    let m = run(a.memory, T0 + 1_000, inputs(T0 + 1_000, { budget: budget(T0 + 1_000, on) })).memory;
    const b = run(m, T0 + 11_500, inputs(T0 + 11_500, { budget: budget(T0 + 11_500, on) }));
    expect(b.target).toBe(2_500);
    m = b.memory;
    expect(m.budgetSeen).toContain('hold:alert');
  });

  test('[Q-T49] 경보가꺼졌다가다시울리면_새경보로줄인다_소진선은한번뿐이다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { budget: budget(T0, { 'hold:alert': 1, 'hold:burn50': 1 }) }));
    // 신호 둘은 각각 한 번씩이다(경보 하나·소진선 하나에 한 번)
    expect(a.decreases.map((d) => d.reason)).toEqual(['budget_alert', 'budget_50']);
    expect(a.target).toBe(1_250);
    expect(a.memory.budgetSeen.sort()).toEqual(['hold:alert', 'hold:burn50']);
    const off = run(a.memory, T0 + 5_000, inputs(T0 + 5_000));
    expect(off.memory.budgetSeen).toEqual(['hold:burn50']);
    const again = run(off.memory, T0 + 10_000, inputs(T0 + 10_000, { budget: budget(T0 + 10_000, { 'hold:alert': 1 }) }));
    expect(again.decreases).toEqual([expect.objectContaining({ reason: 'budget_alert', from: 1_250, to: 1_000 })]);
    expect(again.target).toBe(1_000);
  });
});

describe('좌석 저장소 감축', () => {
  test('[Q-T67] 좌석저장소신호가켜질때_한번50퍼센트줄이고_회복뒤AIMD로올린다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { seat: 1 }));
    expect(a.decreases).toEqual([expect.objectContaining({ reason: 'seat_store', to: 2_500 })]);
    const b = run(a.memory, T0 + 5_000, inputs(T0 + 5_000, { seat: 1 }));
    expect(b.decreases).toEqual([]);
    const c = run(b.memory, T0 + 35_000, inputs(T0 + 35_000));
    expect(c.memory.seatStoreDown).toBe(false);
    expect(c.target).toBe(2_600);
  });

  test('[Q-T67] 좌석저장소가안되는동안켜진홀드여정예산신호는_더줄이지않고증액만멈춘다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { seat: 1 }));
    const b = run(a.memory, T0 + 5_000, inputs(T0 + 5_000, { seat: 1, budget: budget(T0 + 5_000, { 'hold:alert': 1 }) }));
    expect(b.target).toBe(2_500);
    expect(b.memory.budgetHoldAt).toBe(T0 + 5_000);
    const c = run(b.memory, T0 + 40_000, inputs(T0 + 40_000));
    expect(c.target).toBe(2_500);
  });

  test('[Q-T67] 홀드여정예산감축뒤60초안에켜진좌석저장소신호는_다시줄이지않는다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { budget: budget(T0, { 'hold:alert': 1 }) }));
    expect(a.target).toBe(2_500);
    expect(run(a.memory, T0 + 30_000, inputs(T0 + 30_000, { seat: 1 })).target).toBe(2_500);
    expect(run(a.memory, T0 + 61_000, inputs(T0 + 61_000, { seat: 1 })).target).toBe(1_250);
  });
});

describe('운영자 고정과 복귀 확인', () => {
  const op = (value: number, setAt: number, resumeAtMs: number | null = null) => ({ value, untilMs: setAt + FREEZE, resumeAtMs });

  test('[Q-T42] 운영자고정중_AIMD는멈추고값은안전범위로깎인다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { p99: 9 }), { operator: op(9_000, T0 - 1_000) });
    expect(a.target).toBe(8_000);
    expect(a.decreases).toEqual([]);
    expect(run(a.memory, T0 + 40_000, inputs(T0 + 40_000), { operator: op(9_000, T0 - 1_000) }).target).toBe(8_000);
  });

  test('[Q-T42] 고정만료뒤복귀확인전에는_마지막값을지키고_확인뒤자동으로돌아간다', () => {
    const setAt = T0 - FREEZE - 1_000;
    const a = run(initialMemory(6_000, T0 - 60_000), T0, inputs(T0, { p99: 9 }), { operator: op(6_000, setAt) });
    expect(a.target).toBe(6_000);
    expect(a.decreases).toEqual([]);
    const resumed = run(a.memory, T0 + 1_000, inputs(T0 + 1_000, { p99: 9 }), { operator: op(6_000, setAt, T0 + 500) });
    expect(resumed.target).toBe(3_000);
  });

  test('[Q-T42] 고정중_지정뒤새로울린경보는줄이고멈춤을끝낸다_지정전부터울리던경보로는줄이지않는다', () => {
    const on = budget(T0, { 'hold:alert': 1 });
    const setAt = T0 - 1_000;
    const seen = { ...initialMemory(6_000, T0 - 60_000), budgetSeen: ['hold:alert'] };
    const quiet = run(seen, T0, inputs(T0, { budget: on }), { operator: op(6_000, setAt) });
    expect(quiet.target).toBe(6_000);
    expect(quiet.memory.manualEndedAt).toBeNull();
    const fresh = run(initialMemory(6_000, T0 - 60_000), T0, inputs(T0, { budget: on }), { operator: op(6_000, setAt) });
    expect(fresh.target).toBe(3_000);
    expect(fresh.memory.manualEndedAt).toBe(T0);
    expect(isManualFixed(op(6_000, setAt), fresh.memory.manualEndedAt, T0 + 1_000)).toBe(false);
  });

  test('[Q-T49] 예산감축뒤증액멈춤은_운영자가목표를정한뒤에풀린다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { budget: budget(T0, { 'hold:alert': 1 }) }));
    expect(run(a.memory, T0 + 40_000, inputs(T0 + 40_000)).target).toBe(2_500);
    // 운영자가 지정(고정)하면 그 값이고 고정 뒤 복귀 확인을 받으면 돌아온다
    const setAt = T0 + 50_000;
    const fixed = run(a.memory, setAt + 1_000, inputs(setAt + 1_000), { operator: op(3_000, setAt) });
    expect(fixed.target).toBe(3_000);
    const until = setAt + FREEZE;
    const back = run(fixed.memory, until + 40_000, inputs(until + 40_000), { operator: { value: 3_000, untilMs: until, resumeAtMs: until + 1_000 } });
    expect(back.target).toBe(3_100);
  });
});

describe('안전 한계와 나누기', () => {
  test('[Q-T67] [ASVS v5.0.0-2.3.2] 결제사상한은_토스300이면8000명초당300번호_포트원50이면4500명초당50번호다', () => {
    expect(boundsOf(300)).toEqual({ upper: 8_000, lower: 1_000 });
    expect(pgRateCapOf(300)).toBe(300);
    expect(boundsOf(50)).toEqual({ upper: 4_500, lower: 1_000 });
    expect(pgRateCapOf(50)).toBe(50);
    expect(pgTargetCapOf(50)).toBe(4_500);
    expect(boundsOf(undefined)).toEqual({ upper: 8_000, lower: 1_000 });
    // 작은 상한이면 하한은 그 절반이다
    expect(boundsOf(10)).toEqual({ upper: 900, lower: 450 });
  });

  test('[Q-T67] [ASVS v5.0.0-2.3.2] 운영자값과저장된값도_안전범위로깎인다', () => {
    const a = run(initialMemory(20_000, T0 - 60_000), T0, inputs(T0, { latency: MISSING }));
    expect(a.target).toBe(8_000);
    const b = run(initialMemory(10, T0 - 60_000), T0, inputs(T0, { latency: MISSING }));
    expect(b.target).toBe(1_000);
  });

  test('[Q-T67] 결제사상한을낮추면다음주기에바로줄고_되돌려도표본이쌓일때까지늘지않는다', () => {
    const a = run(initialMemory(8_000, T0 - 60_000), T0, inputs(T0), { upper: 4_500, pgLimited: true });
    expect(a.target).toBe(4_500);
    expect(a.decreases[0]).toMatchObject({ reason: 'pg_cap', from: 8_000, to: 4_500 });
    const b = run(a.memory, T0 + 1_000, inputs(T0 + 1_000), { upper: 8_000 });
    expect(b.target).toBe(4_500);
    // 증액은 다음 30초 창
    expect(run(b.memory, T0 + 31_000, inputs(T0 + 31_000), { upper: 8_000 }).target).toBe(4_600);
  });

  test('[Q-T67] 합산상한을넘으면_수요에비례해나누고_줄선사람이없는회차는큰회차의몫을줄이지않는다', () => {
    const shared = shareTargets([{ id: 'a', want: 5_000, demand: 5_000 }, { id: 'b', want: 5_000, demand: 5_000 }], 5_000);
    expect([shared.get('a'), shared.get('b')]).toEqual([2_500, 2_500]);
    expect(shared.get('a')! + shared.get('b')!).toBeLessThanOrEqual(5_000);
    // 수요 합이 상한 안이면 수요를 먼저 주고, 남는 자리만 더 준다(목표 합도 상한 안이다)
    const quiet = shareTargets([{ id: 'a', want: 5_000, demand: 5_000 }, { id: 'b', want: 5_000, demand: 10 }], 5_100);
    expect([quiet.get('a'), quiet.get('b')]).toEqual([5_000, 100]);
    const under = shareTargets([{ id: 'a', want: 3_000, demand: 3_000 }, { id: 'b', want: 2_000, demand: 2_000 }], 5_000);
    expect([under.get('a'), under.get('b')]).toEqual([3_000, 2_000]);
    expect(demandOf(5_000, undefined)).toBe(5_000);
    expect(demandOf(5_000, { waiting: 3, slots: 0, soon: 0, inFlight: 0 })).toBe(5_000);
    expect(demandOf(5_000, { waiting: 0, slots: 7, soon: 2, inFlight: 1 })).toBe(10);
  });

  test('[Q-T67] 같은결제사회차끼리_전진속도합이상한안이다', () => {
    const r = shareRate([{ id: 'a', want: 0, demand: 300 }, { id: 'b', want: 0, demand: 100 }, { id: 'c', want: 0, demand: 0 }], 200);
    expect(r.get('a')).toBe(150);
    expect(r.get('b')).toBe(50);
    expect(r.get('c')).toBe(0);
    const single = shareRate([{ id: 'a', want: 0, demand: 300 }], 200);
    expect(single.get('a')).toBe(200);
    // 수요가 없어도 합은 상한 안이다
    const empty = shareRate([{ id: 'a', want: 0, demand: 0 }, { id: 'b', want: 0, demand: 0 }], 200);
    expect([empty.get('a'), empty.get('b')]).toEqual([100, 100]);
    // 승인 상한 20에 회차 다섯이면 합이 20이다(반올림으로 넘지 않는다)
    const five = shareRate(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, want: 0, demand: 10 })), 20);
    expect([...five.values()].reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(20);
    expect(five.get('a')).toBe(4);
  });

  test('[Q-T67] 수요합이상한안이어도_목표합은합산상한을넘지않는다', () => {
    const r = shareTargets([{ id: 'a', want: 4_900, demand: 4_900 }, { id: 'b', want: 5_000, demand: 100 }], 5_000);
    expect([r.get('a'), r.get('b')]).toEqual([4_900, 100]);
    const left = shareTargets([{ id: 'a', want: 3_000, demand: 1_000 }, { id: 'b', want: 3_000, demand: 1_000 }], 5_000);
    expect(left.get('a')! + left.get('b')!).toBeLessThanOrEqual(5_000);
    expect(left.get('a')).toBe(2_500);
  });

  test('[Q-T67] 기다리는사람이있으면_몫은1이상이고_합은상한안이다', () => {
    const r = shareTargets([{ id: 'big', want: 5_000, demand: 5_000 }, { id: 'small', want: 5_000, demand: 1 }], 5_000);
    expect(r.get('small')).toBeGreaterThanOrEqual(1);
    expect(r.get('big')! + r.get('small')!).toBeLessThanOrEqual(5_000);
    // 수요가 없는 회차에는 억지로 주지 않는다
    expect(shareTargets([{ id: 'big', want: 5_000, demand: 6_000 }, { id: 'none', want: 5_000, demand: 0 }], 5_000).get('none')).toBe(0);
  });

  test('[Q-T67] 매진·판매종료회차의수요는0이고_일시매진은지금쓰는인원이다', () => {
    const last = { waiting: 100_000, slots: 30, soon: 2, inFlight: 1 };
    expect(demandOf(5_000, { ...last, saleState: 'SOLD_OUT' })).toBe(0);
    expect(demandOf(5_000, { ...last, saleState: 'ENDED' })).toBe(0);
    expect(demandOf(5_000, { ...last, saleState: 'ALL_HELD' })).toBe(33);
    expect(demandOf(5_000, { ...last, saleState: 'ON_SALE' })).toBe(5_000);
  });

  test('[Q-T67] 진행중인회차의오픈간격이5분보다가까우면_위반을센다', () => {
    expect(openGapViolationsOf([T0, T0 + 240_000], 300_000)).toBe(1);
    expect(openGapViolationsOf([T0, T0 + 300_000], 300_000)).toBe(0);
    expect(openGapViolationsOf([T0, T0 + 1_000, T0 + 2_000], 300_000)).toBe(3);
  });
});

describe('리뷰에서 찾은 판단 결함의 재현', () => {
  const op = (value: number, setAt: number) => ({ value, untilMs: setAt + FREEZE, resumeAtMs: null });

  test('[Q-T42] 기억을칸으로왕복시켜도_처음칸이없는회차에서5초간격정상입력3분에6번증액한다', () => {
    let fields: Record<string, string> = {};
    let inc = 0;
    for (let t = 0; t <= 180_000; t += 200) {
      const now = T0 + t;
      const memory = memoryFromFields(fields, 5_000, now);
      const r = run(memory, now, inputs(T0 + Math.floor(t / 5_000) * 5_000));
      if (r.memory.target > memory.target) inc += 1;
      fields = { ...fields, ...changedFields(fields, memoryToFields(r.memory)) };
    }
    expect(inc).toBe(6);
    expect(fields.aimdTarget).toBe('5600');
    expect(fields.aimdChangeAt).toBe(String(T0 + 180_000));
  });

  test('[Q-T42] 처음칸이없으면_증액창은첫표본시각부터센다', () => {
    const r = run(memoryFromFields({}, 5_000, T0 + 300), T0 + 300, inputs(T0));
    expect(r.memory.changeAt).toBe(T0);
  });

  test('[Q-T42] 허용치를넘는미래표본은_입력없음이다', () => {
    const m = initialMemory(5_000, T0 - 60_000);
    expect(run(m, T0, inputs(T0, { latency: ok(0.02, T0 + 6_000) })).staleKinds).toEqual(['downstream_latency']);
    expect(run(m, T0, inputs(T0, { latency: ok(0.02, T0 + 3_000) })).staleKinds).toEqual([]);
  });

  test('[Q-T67] 좌석저장소신호가켜져있는동안_증액하지않는다', () => {
    const a = run(initialMemory(5_000, T0 - 60_000), T0, inputs(T0, { seat: 1 }));
    const b = run(a.memory, T0 + 40_000, inputs(T0 + 40_000, { seat: 1 }));
    expect(b.target).toBe(2_500);
  });

  test('[Q-T67] 운영자고정중좌석저장소감축은_고정을끝내고_다음주기에도감축값을지킨다', () => {
    const o = op(6_000, T0 - 1_000);
    const a = run(initialMemory(6_000, T0 - 60_000), T0, inputs(T0, { seat: 1 }), { operator: o });
    expect(a.target).toBe(3_000);
    expect(a.memory.manualEndedAt).toBe(T0);
    expect(run(a.memory, T0 + 200, inputs(T0, { seat: 1 }), { operator: o }).target).toBe(3_000);
  });

  test('[Q-T49] 겹침으로줄이지않으면_운영자고정은끝나지않는다', () => {
    const memory = { ...initialMemory(6_000, T0 - 60_000), seatStoreDown: true };
    const r = run(memory, T0, inputs(T0, { seat: 1, budget: budget(T0, { 'hold:alert': 1 }) }), { operator: op(6_000, T0 - 1_000) });
    expect(r.target).toBe(6_000);
    expect(r.decreases).toEqual([]);
    expect(r.memory.manualEndedAt).toBeNull();
    expect(r.memory.budgetHoldAt).toBe(T0);
  });
});

describe('운영 값 읽기', () => {
  test('[Q-T42] 틀린칸은_없는것으로본다', () => {
    const m = memoryFromFields({ aimdTarget: 'NaN', aimdChangeAt: '', budgetSeen: 'not-json', inputStale: '1' }, 5_000, T0);
    expect(m.target).toBe(5_000);
    expect(m.changeAt).toBe(T0);
    expect(m.budgetSeen).toEqual([]);
    expect(m.staleSince).toBe(T0);
  });
});
