// F-02-2(OPS-310) admission-ctrl 리더의 결제사 상한: 결제사 묶음을 고르는 차례와 낮춘 채널 비율(ADR-0366 결정 4·10, 계획 6절 B9·B17·B18).
// 정본 값:
// - 차례는 회차 ctl(q:{event:E}:ctl의 pgKey·pgTps) > 전체 ctl(q:{admission}:ctl의 같은 칸) > 일정 사본 cfg(ADR-0366 결정 4).
// - 결제사 상한(queue-admission §5 '결제사 상한'): 전진 속도 상한 = pgTps ÷ 결제 비율 1.0, 동시 입장 상한 = pgTps × 평균 체류 180초 ÷ 1.0 × 안전 계수 0.5.
//   주기 0.2초의 전진 수 = 전진 속도 상한 × 0.2. 시험 값은 이 식으로 손으로 셈한다(코드 상수를 가져오지 않는다).
// - 비율(ADR-0366 결정 10): 리더가 제어 입력을 읽는 주기마다 Prometheus `min by (pg) (payment_pg_limit_ratio)`를 함께 읽고, pgKey가 결제사 이름
//   (TOSS·PORTONE·SIMULATOR)이면 승인 상한 = max(1, 내림(pgTps × 비율 ÷ 100)), PG_FALLBACK이면 비율의 최솟값, 비율이 없거나 25~100 밖이면 100,
//   조회가 실패하면 마지막으로 읽은 비율. lt-* 같은 묶음 이름에는 걸지 않는다(B18).
// 짝: 판단 입력은 진짜 PrometheusControlInputs에 가짜 fetch(Prometheus HTTP 응답 꼴)를 물린다. 리더 저장소는 LeaderStore 포트 대역(저장소 Lua의 뜻은
// test-int/f022-pg-switch-control.int.test.ts가 실제 Valkey로 본다). 시계는 가짜다.
// [가정] 전체 ctl의 결제사 칸은 LeaderStore.platformControl()의 답에 회차 ctl과 같은 이름(pgKey·pgTps)으로 실린다(계획 8절에 꼴이 없어 정했다).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AdmissionLeader } from '../src/modules/leader/application/admission-leader.js';
import { CONTROL_QUERIES, PrometheusControlInputs } from '../src/modules/leader/adapters/prometheus-control-inputs.js';
import type { ArrivalCloseResult, Control, EventPlan, LeaderStore, Rb05Result, TickInput, TickResult } from '../src/modules/leader/domain/ports.js';

const T0 = Date.UTC(2026, 10, 23, 3, 0, 0);
const DAY = 86_400_000;
const OK: TickResult = { kind: 'OK', serving: 0, advanced: 0, slots: 0, soon: 0, inFlight: 0, waiting: 10, dropped: 0, lobbyMarked: 1, batchMarked: 1, batchPublished: 1, repair: 0, ratio: 1, saleState: 'ON_SALE' };

/** queue-admission §5 '결제사 상한'의 식을 손으로 옮긴 기대값(평균 체류 180초, 결제 비율 1.0, 안전 계수 0.5, 주기 0.2초) */
const capOf = (tps: number) => Math.floor((tps * 180) / 1.0 * 0.5);
const advanceOf = (tps: number) => Math.floor(tps / 1.0) * 0.2;

type RatioAnswer = { pg: string; value: string }[] | 'fail';

/** Prometheus 즉시 조회 대역: 판단 입력은 모두 정상(표본 시각 = 지금), 비율 질의는 ratio()가 정한 답 */
function prometheus(clock: { now(): number }, ratio: () => RatioAnswer) {
  const seen: string[] = [];
  const healthy = new Map<string, () => { metric: Record<string, string>; value: [number, string] }[]>();
  const now = () => clock.now() / 1000;
  const one = (v: () => number) => () => [{ metric: {}, value: [now(), String(v())] as [number, string] }];
  healthy.set(CONTROL_QUERIES.latency.value, one(() => 0.02));
  healthy.set(CONTROL_QUERIES.latency.time, one(now));
  healthy.set(CONTROL_QUERIES.errors.value, one(() => 0));
  healthy.set(CONTROL_QUERIES.errors.time, one(now));
  const fetchImpl = (async (url: string | URL) => {
    const query = new URL(String(url)).searchParams.get('query') ?? '';
    seen.push(query);
    if (query.includes('payment_pg_limit_ratio')) {
      const a = ratio();
      if (a === 'fail') return new Response('{"status":"error"}', { status: 503 });
      // 표본 시각 질의(timestamp())로 물어도 신선한 시각을 준다
      const timeQuery = query.includes('timestamp(');
      const result = a.map((r) => ({ metric: { pg: r.pg }, value: [now(), timeQuery ? String(now()) : r.value] }));
      return new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }), { status: 200 });
    }
    const result = healthy.get(query)?.() ?? [];
    return new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }), { status: 200 });
  }) as typeof fetch;
  return { reader: new PrometheusControlInputs({ baseUrl: 'http://prom.test', fetchImpl }), seen };
}

interface World {
  plan?: Partial<EventPlan>;
  ctl?: Partial<Control>;
  platform?: { pgKey?: string; pgTps?: number };
  ratio?: () => RatioAnswer;
}

function world(o: World) {
  const clock = fakeClock({ now: T0 });
  const ticks: TickInput[] = [];
  const plan: EventPlan = { opensAtMs: T0 - 10_000, startsAtMs: T0 + 3 * DAY, lobbyShuffle: false, openBatch: false, ...o.plan };
  const store = {
    activeEvents: async () => ['e1'],
    schedule: async () => plan,
    control: async (): Promise<Control> => ({ paused: false, ...o.ctl }),
    platformControl: async () => ({ autoStopped: false, allPaused: false, ...(o.platform ?? {}) }),
    bump: async () => 'OK' as const,
    tick: async (i: TickInput) => {
      ticks.push(i);
      return OK;
    },
    close: async () => 'OK' as const,
    rb05: async () => ({ kind: 'DONE' }) as Rb05Result,
    confirmRb05: async () => 'CONFIRMED' as const,
    closeArrivalSlots: async () => ({ kind: 'NONE', slots: 0, returned: 0 }) as ArrivalCloseResult,
  } satisfies LeaderStore;
  const prom = prometheus(clock, o.ratio ?? (() => []));
  const leader = new AdmissionLeader(store, { run: async () => ({ status: 'PUBLISHED' }) }, { generation: () => 1 }, clock, undefined, undefined, prom.reader);
  /** 주기를 돈다: 판단 입력 읽기가 끝나도록 주기 사이에 이벤트 고리를 한 번 비운다 */
  const run = async (n: number, stepMs = 200) => {
    for (let i = 0; i < n; i += 1) {
      await leader.tick();
      await new Promise((r) => setImmediate(r));
      clock.advance(stepMs);
    }
  };
  return { clock, ticks, run, seen: prom.seen, last: () => ticks.at(-1)! };
}

describe('F022-ADM 리더가 결제사 묶음을 고르는 차례 (B9, ADR-0366 결정 4)', () => {
  test('F022-ADM ① 회차 ctl이 없고 전체 ctl에 결제사 칸이 있으면 cfg보다 전체 ctl의 상한으로 다시 계산한다(동시 입장·전진 속도 둘 다)', async () => {
    const w = world({ plan: { pgKey: 'lt-a', pgTps: 50 }, platform: { pgKey: 'PORTONE', pgTps: 40 } });
    await w.run(3);
    expect({ target: w.last().target, maxAdvance: w.last().maxAdvance }).toEqual({ target: capOf(40), maxAdvance: advanceOf(40) });
  });

  test('F022-ADM ② 회차 ctl·전체 ctl·cfg가 모두 있으면 회차 ctl이 이긴다', async () => {
    const w = world({ plan: { pgKey: 'lt-a', pgTps: 50 }, platform: { pgKey: 'PORTONE', pgTps: 40 }, ctl: { pgKey: 'TOSS', pgTps: 30 } });
    await w.run(3);
    expect({ target: w.last().target, maxAdvance: w.last().maxAdvance }).toEqual({ target: capOf(30), maxAdvance: advanceOf(30) });
  });

  test('F022-ADM ③ 회차 ctl·전체 ctl 모두 결제사 칸이 없으면 cfg의 상한이다', async () => {
    const w = world({ plan: { pgKey: 'lt-a', pgTps: 45 } });
    await w.run(3);
    expect({ target: w.last().target, maxAdvance: w.last().maxAdvance }).toEqual({ target: capOf(45), maxAdvance: advanceOf(45) });
  });

  test('F022-ADM ④ 전체 ctl의 결제사 칸이 하나만 있으면(pgTps 없음) 걸지 않고 cfg로 간다', async () => {
    const w = world({ plan: { pgKey: 'lt-a', pgTps: 45 }, platform: { pgKey: 'PORTONE' } });
    await w.run(3);
    expect(w.last().target).toBe(capOf(45));
  });
});

describe('F022-RATIO 낮춘 채널 비율을 입장 상한에 잇기 (B17·B18, ADR-0366 결정 10)', () => {
  const tossAt = (value: string): RatioAnswer => [{ pg: 'TOSS', value }];

  test('F022-RATIO ① 리더가 판단 입력과 함께 payment_pg_limit_ratio를 결제사별 최솟값으로 묻는다', async () => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 } });
    await w.run(3);
    const ratioQueries = w.seen.filter((q) => q.includes('payment_pg_limit_ratio'));
    expect(ratioQueries.length, `물은 질의: ${JSON.stringify([...new Set(w.seen)])}`).toBeGreaterThanOrEqual(1);
    expect(ratioQueries.some((q) => /min\s*by\s*\(\s*pg\s*\)/.test(q))).toBe(true);
  });

  test.each([
    ['비율 50', '50', Math.floor((50 * 50) / 100)],
    ['비율 25(하한 경계)', '25', Math.floor((50 * 25) / 100)],
    ['비율 99', '99', Math.floor((50 * 99) / 100)],
    ['비율 100(상한 경계)', '100', 50],
    ['비율 24(범위 밖은 100)', '24', 50],
    ['비율 101(범위 밖은 100)', '101', 50],
  ])('F022-RATIO ② %s: 결제사 이름 pgKey(TOSS)의 승인 상한은 내림(pgTps × 비율 ÷ 100)이다', async (_name, ratio, tps) => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 }, ratio: () => tossAt(ratio) });
    await w.run(4);
    expect(w.last().target).toBe(capOf(tps));
  });

  test('F022-RATIO ⑨ 범위 위 비율(150)은 100으로 본다: 높여 들이지 않는다(동시 입장 상한 그대로)', async () => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 }, ratio: () => tossAt('150') });
    await w.run(4);
    expect(w.last().target).toBe(capOf(50));
  });

  test('F022-RATIO ⑩ 범위 위 비율(101)은 100으로 본다: pgTps 200의 전진 속도는 200 그대로다(주기마다 40, 202로 올리면 몇 주기에 41이 섞인다)', async () => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 200 }, ratio: () => tossAt('101') });
    await w.run(12);
    expect(w.ticks.slice(-8).map((t) => t.maxAdvance)).toEqual(Array.from({ length: 8 }, () => advanceOf(200)));
  });

  test('F022-RATIO ③ 비율 줄이 없으면 100으로 본다', async () => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 }, ratio: () => [] });
    await w.run(4);
    expect(w.last().target).toBe(capOf(50));
  });

  test('F022-RATIO ④ 비율 50이면 전진 속도도 함께 낮춘 상한으로 다시 계산한다', async () => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 }, ratio: () => tossAt('50') });
    await w.run(4);
    expect({ target: w.last().target, maxAdvance: w.last().maxAdvance }).toEqual({ target: capOf(25), maxAdvance: advanceOf(25) });
  });

  test('F022-RATIO ⑤ 다른 결제사의 비율은 걸지 않는다(PORTONE 50이어도 TOSS 묶음은 100)', async () => {
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 }, ratio: () => [{ pg: 'PORTONE', value: '50' }] });
    await w.run(4);
    expect(w.last().target).toBe(capOf(50));
  });

  test('F022-RATIO ⑥ PG_FALLBACK 묶음은 결제사 비율의 최솟값을 쓴다', async () => {
    const w = world({ platform: { pgKey: 'PG_FALLBACK', pgTps: 50 }, ratio: () => [{ pg: 'TOSS', value: '80' }, { pg: 'PORTONE', value: '50' }] });
    await w.run(4);
    expect(w.last().target).toBe(capOf(25));
  });

  test('F022-RATIO ⑦ 조회가 실패하면 마지막으로 읽은 비율을 쓴다(100으로 되돌리지 않는다)', async () => {
    let answer: RatioAnswer = tossAt('50');
    const w = world({ ctl: { pgKey: 'TOSS', pgTps: 50 }, ratio: () => answer });
    await w.run(4);
    expect(w.last().target).toBe(capOf(25));
    answer = 'fail';
    // 판단 입력 읽기 주기(1초)를 몇 번 넘겨 실패한 조회가 실제로 돌게 한다
    await w.run(15);
    expect(w.seen.filter((q) => q.includes('payment_pg_limit_ratio')).length).toBeGreaterThanOrEqual(2);
    expect(w.last().target).toBe(capOf(25));
  });

  test('F022-RATIO ⑧ 결제사 이름이 아닌 묶음(lt-*)에는 비율을 걸지 않는다 (B18)', async () => {
    const w = world({ plan: { pgKey: 'lt-a', pgTps: 50 }, ratio: () => [{ pg: 'TOSS', value: '25' }, { pg: 'PORTONE', value: '25' }, { pg: 'lt-a', value: '25' }] });
    await w.run(4);
    expect(w.last().target).toBe(capOf(50));
  });
});
