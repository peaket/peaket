// 관제 실시간 표 ops-svc 읽기 쪽 단위 시험(OPS-160, F-04-1). docs/streaming.md §4.1·§4.3·§4.5, docs/features/control-tower.md §11·§14.
// - 도메인 순수 함수: 누적·잔여석·1초 칸·신선도·Degraded·거래 사건 끊김·파트너 스냅숏
// - RtBoard: 원천은 짝 가짜 MemoryRtSource(RtQuerySource·SeatMapSource 구현, 진짜 쪽은 test-int/realtime-table.int.test.ts), 시계는 주입한 변수,
//   지표는 진짜 PromRtSignals를 읽는다. 0.5초 주기는 tick()을 직접 부르고, start/stop만 가짜 타이머로 본다.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GetPartnerEventLiveSnapshotResponse } from '@peaket/contracts/openapi/partner';
import {
  ClickHouseRtSource,
  FRESHNESS_UNKNOWN_SECONDS,
  MemoryRtSource,
  PromRtSignals,
  RtBoard,
  RtSourceFailure,
  cumulativeOf,
  finishedBuckets,
  freshnessOf,
  initialDegraded,
  nextDegraded,
  partnerSnapshotOf,
  percentile,
  pulseAsOf,
  recordMinute,
  remainingOf,
  seatMapOf,
  soldPerMinuteOf,
  tradeGapOf,
  type CumulativeRow,
  type DegradedState,
  type FreshnessRow,
  type MinutePoint,
  type PartitionRef,
  type RtBoardOptions,
  type SeatMapRow,
} from '../src/modules/realtime-table/index.js';
import { pulsePartitionsOf, realtimeTableFromEnv } from '../src/rt-wiring.js';

/** 분 경계에 맞춘 시각(2026-11-23T10:00:00Z) */
const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const MIN = 60_000;
const E = '0194f041-0000-7000-8000-0000000000e1';
const iso = (ms: number) => new Date(ms).toISOString();

/** 텔레메트리 셋 × 파티션 2(설정 예시의 3과 다르게 골랐다) */
const EXPECTED: readonly PartitionRef[] = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'].flatMap((topic) => [0, 1].map((partition) => ({ topic, partition })));
const PURCHASE_1: PartitionRef = { topic: 'telemetry.purchase', partition: 1 };

/** rt.v_cumulative가 내는 모양의 행(docs/streaming.md §4.1 지표 코드, 계획 '정본 빈칸' 2의 등급·구역 줄 이름) */
const cumulativeRows = (o: { sold?: number; soldA?: number; soldB?: number; lastTradeMs?: number; entries?: number } = {}): CumulativeRow[] => [
  { metric: 'sold_seats', dim: '', value: o.sold ?? 12 },
  { metric: 'sold_seats_tier', dim: 'R', value: o.soldA ?? 7 },
  { metric: 'sold_seats_tier', dim: 'S', value: o.soldB ?? 5 },
  { metric: 'sold_seats_section', dim: 'A', value: o.soldA ?? 7 },
  { metric: 'sold_seats_section', dim: 'B', value: o.soldB ?? 5 },
  { metric: 'sales_amount', dim: '', value: 1_234_000 },
  { metric: 'orders_confirmed', dim: '', value: 9 },
  { metric: 'tickets_issued', dim: '', value: 11 },
  { metric: 'funnel_payment_accepted', dim: '', value: 15 },
  { metric: 'funnel_approved', dim: '', value: 13 },
  { metric: 'funnel_issued', dim: '', value: 10 },
  { metric: 'funnel_first_hold', dim: '', value: 20 },
  { metric: 'funnel_first_hold_tier', dim: 'R', value: 12 },
  { metric: 'funnel_first_hold_tier', dim: 'S', value: 8 },
  { metric: 'queue_entries', dim: '', value: o.entries ?? 1_000 },
  { metric: 'queue_admissions', dim: '', value: 300 },
  { metric: 'queue_removed', dim: '', value: 50 },
  { metric: 'funnel_admitted', dim: '', value: 300 },
  { metric: 'last_trade_loaded_ms', dim: '', value: o.lastTradeMs ?? T0 - 2_000 },
  // 모르는 줄은 버린다(뷰에 줄이 더해져도 숫자가 흔들리지 않는다)
  { metric: 'future_metric', dim: '', value: 99 },
];

/** 회차 기준 자료: 옛 배치 판 1(A 50석)과 마지막 판 2(A 25+15석, B 60석) */
const SEAT_MAP: SeatMapRow[] = [
  { layoutVersion: 1, sectionId: 'A', tierId: 'R', seatCount: 50 },
  { layoutVersion: 2, sectionId: 'A', tierId: 'R', seatCount: 25 },
  { layoutVersion: 2, sectionId: 'A', tierId: 'R', seatCount: 15 },
  { layoutVersion: 2, sectionId: 'B', tierId: 'S', seatCount: 60 },
];

describe('F-04-1 도메인: 누적·잔여석·1초 칸', () => {
  test('F-04-1 C-T20 ① 누적 뷰 행 → 판매 좌석(전체·등급·구역)·금액·확정 주문·발권·퍼널 다섯·대기 셋과 지금 대기 인원, 잔여석은 마지막 배치 판 기준', () => {
    const cum = cumulativeOf(cumulativeRows());
    expect(cum).toEqual({
      soldSeats: 12,
      soldSeatsByTier: { R: 7, S: 5 },
      soldSeatsBySection: { A: 7, B: 5 },
      salesAmount: 1_234_000,
      ordersConfirmed: 9,
      ticketsIssued: 11,
      funnel: { admitted: 300, firstHold: 20, paymentAccepted: 15, approved: 13, issued: 10 },
      firstHoldByTier: { R: 12, S: 8 },
      // 지금 대기 = 진입 − 입장 − 빠진 번호(streaming §4.1)
      queue: { entries: 1_000, admissions: 300, removed: 50, waiting: 650 },
      lastTradeLoadedMs: T0 - 2_000,
    });
    const map = seatMapOf(SEAT_MAP);
    expect(map).toEqual({ layoutVersion: 2, total: 100, bySection: { A: 40, B: 60 }, byTier: { R: 40, S: 60 } });
    // 잔여석 = 판매 대상 − 판매 좌석(홀드·결제 중은 빼지 않는다, ADR-0072)
    expect(remainingOf(cum, map)).toEqual({ total: 88, bySection: { A: 33, B: 55 }, byTier: { R: 33, S: 55 } });
  });

  test('F-04-1 C-T20 ② 기준 자료가 없으면 잔여석은 모름(null), 대기 인원·잔여석은 음수가 되지 않는다', () => {
    const cum = cumulativeOf([
      { metric: 'sold_seats', dim: '', value: 5 },
      { metric: 'sold_seats_section', dim: 'A', value: 5 },
      { metric: 'sold_seats_tier', dim: 'R', value: 5 },
      { metric: 'queue_entries', dim: '', value: 10 },
      { metric: 'queue_admissions', dim: '', value: 9 },
      { metric: 'queue_removed', dim: '', value: 3 },
    ]);
    expect(seatMapOf([])).toBeUndefined();
    expect(remainingOf(cum, undefined)).toBeNull();
    expect(cum.queue.waiting).toBe(0);
    expect(remainingOf(cum, seatMapOf([{ layoutVersion: 'v1', sectionId: 'A', tierId: 'R', seatCount: 3 }]))).toEqual({ total: 0, bySection: { A: 0 }, byTier: { R: 0 } });
    // 거래 행이 없는 회차는 마지막 적재 시각 0
    expect(cum.lastTradeLoadedMs).toBe(0);
  });

  test('F-04-1 ST-T3 ① ops-svc 1초 칸은 끝난 칸(칸 끝 ≤ 지금)만 지표·차원마다 시각 차례로 준다', () => {
    const now = T0 + 12_400; // 마지막으로 끝난 칸은 T0+11초 칸
    const rows = [
      { metric: 'hold_result', dim: 'HELD', secondMs: T0 + 11_000, value: 2 },
      { metric: 'hold_result', dim: 'HELD', secondMs: T0 + 10_000, value: 3 },
      { metric: 'hold_result', dim: 'HELD', secondMs: T0 + 12_000, value: 9 },
      { metric: 'hold_result', dim: 'CONFLICT', secondMs: T0 + 10_000, value: 1 },
      { metric: 'queue_entries', dim: '', secondMs: T0 + 11_000, value: 40 },
    ];
    expect(finishedBuckets(rows, now)).toEqual([
      { metric: 'hold_result', dim: 'CONFLICT', points: [{ secondMs: T0 + 10_000, value: 1 }] },
      { metric: 'hold_result', dim: 'HELD', points: [{ secondMs: T0 + 10_000, value: 3 }, { secondMs: T0 + 11_000, value: 2 }] },
      { metric: 'queue_entries', dim: '', points: [{ secondMs: T0 + 11_000, value: 40 }] },
    ]);
  });
});

describe('F-04-1 도메인: 신선도·Degraded·거래 사건 끊김', () => {
  const rowsAt = (ms: (p: PartitionRef) => number): FreshnessRow[] => EXPECTED.map((p) => ({ ...p, lastProducedAtMs: ms(p), pulses2s: 2 }));

  test('F-04-1 ST-T2 ① ops-svc 누적 길은 가장 늦은 파티션 기준, 1초 칸 길은 그 시각을 초로 내린 기준, 머리는 큰 쪽', () => {
    const now = T0 + 10_000;
    const rows = rowsAt((p) => (p.topic === PURCHASE_1.topic && p.partition === PURCHASE_1.partition ? T0 + 7_700 : T0 + 9_900));
    const asOf = pulseAsOf(EXPECTED, rows);
    expect(asOf).toEqual({ asOfMs: T0 + 7_700, missing: [], stalest: PURCHASE_1 });
    expect(freshnessOf(now, asOf.asOfMs)).toEqual({ cumulativeSeconds: 2.3, bucketSeconds: 3, headSeconds: 3 });
  });

  test('F-04-1 ST-T2 ② ops-svc 기대 파티션 하나가 뷰에 없으면 신선도는 모름(1시간)이고 그 파티션을 가리킨다', () => {
    const rows = rowsAt(() => T0).filter((r) => !(r.topic === PURCHASE_1.topic && r.partition === PURCHASE_1.partition));
    const asOf = pulseAsOf(EXPECTED, rows);
    expect(asOf).toEqual({ asOfMs: undefined, missing: [PURCHASE_1], stalest: PURCHASE_1 });
    expect(freshnessOf(T0 + 1_000, asOf.asOfMs)).toEqual({ cumulativeSeconds: FRESHNESS_UNKNOWN_SECONDS, bucketSeconds: FRESHNESS_UNKNOWN_SECONDS, headSeconds: FRESHNESS_UNKNOWN_SECONDS });
    expect(FRESHNESS_UNKNOWN_SECONDS).toBe(3_600);
    // 기대 목록이 비면 뷰에 보이는 파티션만 본다
    expect(pulseAsOf([], rows).asOfMs).toBe(T0);
    expect(pulseAsOf([], []).asOfMs).toBeUndefined();
  });

  test('F-04-1 C-T36 ① 1분 창 p95는 순위 방식이다(값 100개면 95번째, 20개면 19번째)', () => {
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
    expect(percentile(Array.from({ length: 20 }, (_, i) => 20 - i), 0.95)).toBe(19);
    expect(percentile([], 0.95)).toBeUndefined();
  });

  test('F-04-1 C-T36 ② Degraded: p95가 5초를 넘는 상태가 정확히 3분이면 그대로, 3분을 넘으면 전환하고, 정확히 5초는 연속을 끊는다', () => {
    let s: DegradedState = initialDegraded;
    s = nextDegraded(s, T0, 5.1);
    s = nextDegraded(s, T0 + 3 * MIN, 9);
    expect(s).toEqual({ degraded: false, badSinceMs: T0, goodSinceMs: null, changedAtMs: null });
    s = nextDegraded(s, T0 + 3 * MIN + 1, 9);
    expect(s).toEqual({ degraded: true, badSinceMs: null, goodSinceMs: null, changedAtMs: T0 + 3 * MIN + 1 });
    // 5초 정확히는 '넘는'이 아니라 연속을 끊는다
    let t: DegradedState = nextDegraded(initialDegraded, T0, 6);
    t = nextDegraded(t, T0 + 2 * MIN, 5);
    t = nextDegraded(t, T0 + 2 * MIN + 500, 6);
    t = nextDegraded(t, T0 + 5 * MIN, 6);
    expect(t.degraded).toBe(false);
    expect(t.badSinceMs).toBe(T0 + 2 * MIN + 500);
  });

  test('F-04-1 C-T44 ① 되돌림: Degraded에서 p95 5초 미만이 5분 이어지면 되돌리고, 그사이 5초 이상이면 처음부터 센다', () => {
    const degraded: DegradedState = { degraded: true, badSinceMs: null, goodSinceMs: null, changedAtMs: T0 };
    let s = nextDegraded(degraded, T0 + MIN, 4.9);
    s = nextDegraded(s, T0 + 5 * MIN, 1);
    expect(s.degraded).toBe(true);
    s = nextDegraded(s, T0 + 5 * MIN + 500, 5);
    expect(s).toEqual({ degraded: true, badSinceMs: null, goodSinceMs: null, changedAtMs: T0 });
    s = nextDegraded(s, T0 + 6 * MIN, 1);
    s = nextDegraded(s, T0 + 11 * MIN - 1, 1);
    expect(s.degraded).toBe(true);
    s = nextDegraded(s, T0 + 11 * MIN, 1);
    expect(s).toEqual({ degraded: false, badSinceMs: null, goodSinceMs: null, changedAtMs: T0 + 11 * MIN });
  });

  test('F-04-1 C-T37 ① 거래 사건 끊김: 마지막 거래 행 적재가 60초를 넘고 30분 안이면 끊김, 거래가 없던 회차는 아니다', () => {
    const last = T0;
    expect(tradeGapOf(last + 60_000, last)).toBe(false);
    expect(tradeGapOf(last + 60_001, last)).toBe(true);
    expect(tradeGapOf(last + 30 * MIN, last)).toBe(true);
    expect(tradeGapOf(last + 30 * MIN + 1, last)).toBe(false);
    expect(tradeGapOf(T0, 0)).toBe(false);
  });
});

describe('F-04-1 도메인: 파트너 판매 현황', () => {
  /** 분마다 처음 읽은 판매 좌석 누적(각 분 + 0.2초에 읽었다) */
  const historyOf = (solds: readonly (number | undefined)[]): MinutePoint[] =>
    solds.flatMap((sold, i) => (sold === undefined ? [] : [{ minuteMs: T0 + i * MIN, atMs: T0 + i * MIN + 200, sold }]));

  test('F-04-1 C-T20 ③ 분당 판매는 판매 좌석 누적의 1분 차이(뒤 분 이름), 1분이 아닌 틈은 건너뛰고, 예상 매진은 잔여 ÷ 최근 5분 판매 속도', () => {
    const history = historyOf([0, 10, 25, 30, 30, 50, 70]);
    const asOfMs = T0 + 6 * MIN + 200;
    const cumulative = cumulativeOf([
      { metric: 'sold_seats', dim: '', value: 70 },
      { metric: 'sold_seats_section', dim: 'A', value: 30 },
      { metric: 'sold_seats_section', dim: 'B', value: 40 },
      { metric: 'queue_entries', dim: '', value: 500 },
      { metric: 'queue_admissions', dim: '', value: 120 },
      { metric: 'queue_removed', dim: '', value: 30 },
    ]);
    const snap = partnerSnapshotOf({ asOfMs, cumulative, seatMap: seatMapOf(SEAT_MAP), history });
    // 5분 전 점(T0+1분, 판매 10) 기준: 300초에 60석 → 남은 30석은 150초 뒤
    expect(snap).toEqual({
      asOf: iso(asOfMs),
      nextUpdateAt: iso(asOfMs + 60_000),
      sold: 70,
      remaining: 30,
      projectedSoldOutAt: iso(asOfMs + 150_000),
      waiting: 350,
      queueEntries: 500,
      sections: [
        { sectionId: 'A', remaining: 10 },
        { sectionId: 'B', remaining: 20 },
      ],
      soldPerMinute: [
        { minute: iso(T0 + 1 * MIN), sold: 10 },
        { minute: iso(T0 + 2 * MIN), sold: 15 },
        { minute: iso(T0 + 3 * MIN), sold: 5 },
        { minute: iso(T0 + 4 * MIN), sold: 0 },
        { minute: iso(T0 + 5 * MIN), sold: 20 },
        { minute: iso(T0 + 6 * MIN), sold: 20 },
      ],
    });
    expect(GetPartnerEventLiveSnapshotResponse.safeParse(snap).success).toBe(true);
    expect(soldPerMinuteOf(historyOf([0, 5, undefined, undefined, 20, 26]))).toEqual([
      { minuteMs: T0 + MIN, sold: 5 },
      { minuteMs: T0 + 5 * MIN, sold: 6 },
    ]);
  });

  test('F-04-1 C-T20 ④ 예상 매진은 판매가 없거나·매진이거나·기준 점이 없으면 null, 분당 판매는 최근 180개까지', () => {
    const seatMap = seatMapOf(SEAT_MAP);
    const flat = partnerSnapshotOf({ asOfMs: T0 + 6 * MIN, cumulative: cumulativeOf([{ metric: 'sold_seats', dim: '', value: 30 }]), seatMap, history: historyOf([30, 30, 30, 30, 30, 30]) });
    expect(flat?.projectedSoldOutAt).toBeNull();
    const soldOut = partnerSnapshotOf({ asOfMs: T0 + 6 * MIN, cumulative: cumulativeOf([{ metric: 'sold_seats', dim: '', value: 100 }]), seatMap, history: historyOf([0, 20, 40, 60, 80, 100]) });
    expect(soldOut?.remaining).toBe(0);
    expect(soldOut?.projectedSoldOutAt).toBeNull();
    expect(partnerSnapshotOf({ asOfMs: T0, cumulative: cumulativeOf([]), seatMap, history: [] })?.projectedSoldOutAt).toBeNull();
    // 기준 자료가 없으면 만들지 않는다(remaining 필수)
    expect(partnerSnapshotOf({ asOfMs: T0, cumulative: cumulativeOf([]), seatMap: undefined, history: [] })).toBeUndefined();
    let h: readonly MinutePoint[] = [];
    for (let i = 0; i < 200; i += 1) {
      h = recordMinute(h, T0 + i * MIN + 100, i);
      h = recordMinute(h, T0 + i * MIN + 30_000, i + 1_000); // 같은 분의 둘째 읽기는 기록하지 않는다
    }
    expect(h).toHaveLength(181);
    expect(h[0]).toEqual({ minuteMs: T0 + 19 * MIN, atMs: T0 + 19 * MIN + 100, sold: 19 });
    const spm = soldPerMinuteOf(h);
    expect(spm).toHaveLength(180);
    expect(spm.every((p) => p.sold === 1)).toBe(true);
  });
});

/** 보드 시험 묶음 하나(시험마다 새로 만든다) */
function harness(o: { expected?: readonly PartitionRef[]; options?: Partial<RtBoardOptions> } = {}) {
  let now = T0;
  const source = new MemoryRtSource();
  const signals = new PromRtSignals();
  const logs: string[] = [];
  const board = new RtBoard({
    source,
    seatMaps: source,
    now: () => now,
    expected: o.expected ?? EXPECTED,
    signals,
    log: { warn: (fields) => void logs.push(String(fields.event)) },
    ...(o.options ? { options: o.options } : {}),
  });
  /** 모든 기대 파티션의 마지막 박동을 지금 − lagMs로(frozen 파티션은 그 시각에 멈춤, gone은 행이 없음) */
  const pulse = (lagMs: number, x: { frozen?: { p: PartitionRef; atMs: number }; gone?: PartitionRef } = {}) => {
    source.freshnessRows = EXPECTED.filter((p) => !(x.gone && x.gone.topic === p.topic && x.gone.partition === p.partition)).map((p) => ({
      ...p,
      lastProducedAtMs: x.frozen && x.frozen.p.topic === p.topic && x.frozen.p.partition === p.partition ? x.frozen.atMs : now - lagMs,
      pulses2s: 2,
    }));
  };
  const h = {
    board,
    source,
    signals,
    logs,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
    pulse,
    /** ms 동안 0.5초마다: 시계를 밀고, 박동을 고치고(lag), 한 바퀴 */
    async run(ms: number, lagMs: number, x: Parameters<typeof pulse>[1] = {}, each?: () => void) {
      for (let t = 0; t < ms; t += 500) {
        now += 500;
        pulse(lagMs, x);
        await board.tick();
        each?.();
      }
    },
    gauge: async (m: { get(): Promise<{ values: { value: number; labels?: Record<string, string | number> }[] }> }, labels?: Record<string, string>) =>
      (await m.get()).values.find((v) => !labels || Object.entries(labels).every(([k, val]) => v.labels?.[k] === val))?.value,
  };
  return h;
}

/** 파트너 응답에 있어도 되는 칸(openapi LiveSnapshot). 관람객 개인정보·봇 칸은 없다 */
const PARTNER_KEYS = ['asOf', 'nextUpdateAt', 'projectedSoldOutAt', 'queueEntries', 'remaining', 'sections', 'sold', 'soldPerMinute', 'waiting'];

describe('F-04-1 RtBoard(0.5초 조회 보드)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('F-04-1 C-T20 ⑤ 탭 300개가 같은 회차를 동시에 물어도 누적 조회는 한 번이고 같은 값, 1분 안에는 다시 계산하지 않고 1분 뒤 새로 계산한다', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    h.source.seatMapRows.set(E, SEAT_MAP);
    const views = await Promise.all(Array.from({ length: 300 }, () => h.board.partner(E)));
    expect(h.source.reads.cumulative).toBe(1);
    expect(h.source.reads.seatMap).toBe(1);
    const first = views[0]!;
    expect(views.every((v) => v === first)).toBe(true);
    expect(first).toEqual({
      asOf: iso(T0),
      nextUpdateAt: iso(T0 + 60_000),
      sold: 12,
      remaining: 88,
      projectedSoldOutAt: null,
      waiting: 650,
      queueEntries: 1_000,
      sections: [
        { sectionId: 'A', remaining: 33 },
        { sectionId: 'B', remaining: 55 },
      ],
      soldPerMinute: [],
    });
    expect(Object.keys(first).sort()).toEqual(PARTNER_KEYS);
    // 1분 안: 원천이 바뀌어도 같은 값
    h.source.cumulativeRows.set(E, cumulativeRows({ sold: 13, soldB: 6 }));
    h.now = T0 + 59_999;
    expect(await h.board.partner(E)).toBe(first);
    expect(h.source.reads.cumulative).toBe(1);
    // 다음 집계 시각: 새로 읽고 분당 판매 한 점(12 → 13)
    h.now = T0 + 60_000;
    const next = await h.board.partner(E);
    expect(h.source.reads.cumulative).toBe(2);
    expect(next).toMatchObject({ asOf: iso(T0 + 60_000), nextUpdateAt: iso(T0 + 120_000), sold: 13, remaining: 87, soldPerMinute: [{ minute: iso(T0 + 60_000), sold: 1 }] });
  });

  test('F-04-1 C-T20 ⑥ 보드가 0.5초마다 읽는 동안 화면 조회는 원천을 더 부르지 않고 보드 값을 나눠 쓴다(관심 회차만 읽고, 5분 안 읽히면 멈춘다)', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    h.source.seatMapRows.set(E, SEAT_MAP);
    await h.run(1_000, 300);
    expect(h.source.reads.cumulative).toBe(0); // 아무도 묻지 않은 회차는 읽지 않는다
    await h.board.snapshot(E);
    expect(h.source.reads.cumulative).toBe(1);
    await h.run(500, 300);
    expect(h.source.reads.cumulative).toBe(2);
    for (let i = 0; i < 10; i += 1) await h.board.snapshot(E);
    await h.board.partner(E);
    expect(h.source.reads.cumulative).toBe(2);
    expect(await h.gauge(h.signals.watchedEvents)).toBe(1);
    // 마지막 관심(T0+1.5초)에서 5분이 지나면 주기에서 빠진다
    const lastInterest = h.now;
    await h.run(5 * MIN - 500, 300);
    const reads = h.source.reads.cumulative;
    expect(h.now - lastInterest).toBe(5 * MIN - 500);
    await h.run(500, 300);
    expect(h.source.reads.cumulative).toBe(reads);
    expect(await h.gauge(h.signals.watchedEvents)).toBe(0);
  });

  test('F-04-1 C-T36 ③ 심장 박동 반영이 8초 늦으면 머리 신선도가 5초를 넘어 보이고, 3분 넘게 이어지면 Degraded(rt_degraded 1)와 콘솔 스냅숏 degraded', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    await h.board.snapshot(E);
    await h.run(500, 8_000);
    // 지금 T0+0.5초, 가장 늦은 박동 T0−7.5초: 누적 8초, 1초 칸 8.5초
    expect(h.board.health().freshness).toEqual({ cumulativeSeconds: 8, bucketSeconds: 8.5, headSeconds: 8.5 });
    expect(h.board.health().degraded).toBe(false);
    await h.run(3 * MIN, 8_000); // 나쁨이 시작된 지 정확히 3분
    expect(h.board.health().degraded).toBe(false);
    expect(await h.gauge(h.signals.degraded)).toBe(0);
    await h.run(500, 8_000);
    expect(h.board.health().degraded).toBe(true);
    expect(await h.gauge(h.signals.degraded)).toBe(1);
    expect((await h.board.snapshot(E)).degraded).toBe(true);
    expect(h.logs).toContain('rt-degraded');
    // 주기마다 두 길을 rt_freshness_seconds{path}로 냈다(3분 0.5초 + 0.5초 = 362바퀴)
    const counts = (await h.signals.freshnessSeconds.get()).values.filter((v) => (v as { metricName?: string }).metricName === 'rt_freshness_seconds_count');
    expect(counts.map((v) => [v.labels.path, v.value]).sort()).toEqual([
      ['bucket', 362],
      ['cumulative', 362],
    ]);
  });

  test('F-04-1 C-T44 ① 신선도를 5초 넘게 3분 늦췄다 되돌리면, 1분 창 p95가 5초 아래로 내려온 때부터 5분 뒤 실시간 표로 돌아온다', async () => {
    const h = harness();
    await h.run(3 * MIN + 1_000, 8_000);
    expect(h.board.health().degraded).toBe(true);
    const restoredAt = h.now;
    // 되돌림: p95가 처음 5초 아래로 내려온 때를 찾는다(1분 창이라 되돌린 뒤 1분 안)
    let goodAt: number | undefined;
    while (goodAt === undefined) {
      await h.run(500, 300);
      if ((h.board.health().p95Seconds ?? Infinity) < 5) goodAt = h.now;
    }
    expect(goodAt - restoredAt).toBeLessThanOrEqual(60_000);
    expect(goodAt - restoredAt).toBeGreaterThan(50_000);
    await h.run(5 * MIN - 500, 300);
    expect(h.board.health().degraded).toBe(true);
    await h.run(500, 300);
    expect(h.board.health()).toMatchObject({ degraded: false, degradedChangedAtMs: goodAt + 5 * MIN });
    expect(await h.gauge(h.signals.degraded)).toBe(0);
    expect(h.logs).toEqual(['rt-degraded', 'rt-recovered']);
  });

  test('F-04-1 ST-T2 ③ ops-svc 한 파티션의 심장 박동이 멈추면 1초 칸은 그대로 나오지만 신선도가 나빠져 그 파티션을 가리키고, 3분 뒤 Degraded다', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    h.source.bucketRows.set(E, [{ metric: 'queue_entries', dim: '', secondMs: T0 + 5_000, value: 40 }]);
    await h.board.snapshot(E);
    const frozen = { p: PURCHASE_1, atMs: T0 };
    await h.run(10_000, 300, { frozen });
    expect(h.board.health()).toMatchObject({ freshness: { cumulativeSeconds: 10, bucketSeconds: 10, headSeconds: 10 }, stalestPartition: PURCHASE_1, missingPartitions: [] });
    const snap = await h.board.snapshot(E);
    expect(snap.buckets).toEqual([{ metric: 'queue_entries', dim: '', points: [{ secondMs: T0 + 5_000, value: 40 }] }]);
    expect(snap.freshness.headSeconds).toBe(10);
    await h.run(3 * MIN, 300, { frozen });
    expect(h.board.health().degraded).toBe(true);
    // 1시간이 넘어 뷰에서 그 파티션 행이 사라지면 '빠진 파티션'으로 보이고 신선도는 모름
    h.pulse(300, { gone: PURCHASE_1 });
    await h.board.tick();
    expect(h.board.health()).toMatchObject({ missingPartitions: [PURCHASE_1], freshness: { headSeconds: FRESHNESS_UNKNOWN_SECONDS } });
  });

  test('F-04-1 ST-T2 ⑤ ops-svc 첫 바퀴 전에 화면이 회차를 먼저 물으면 박동부터 읽어 그 회차 값의 신선도가 모름으로 튀지 않는다', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    h.pulse(400);
    const snap = await h.board.snapshot(E);
    expect(snap.freshness).toEqual({ cumulativeSeconds: 0.4, bucketSeconds: 1, headSeconds: 1 });
    expect(h.source.reads.freshness).toBe(1);
    // 한 번 읽은 뒤에는 회차 읽기가 박동을 다시 읽지 않는다(바퀴마다 한 번)
    h.now = T0 + 2_000;
    await h.board.snapshot(E);
    expect(h.source.reads.freshness).toBe(1);
  });

  test('F-04-1 ST-T4 ② ops-svc ClickHouse 조회가 30초 실패하면 마지막 값을 두고 신선도가 그만큼 나빠지며 실패를 세고, 돌아오면 바로 정상이다', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    await h.board.snapshot(E);
    await h.run(500, 300); // T0+0.5초에 읽음, 가장 늦은 박동 T0+0.2초
    for (const part of ['cumulative', 'buckets', 'freshness'] as const) h.source.failing.add(part);
    h.source.cumulativeRows.set(E, cumulativeRows({ sold: 99 }));
    await h.run(30_000, 300);
    expect(h.board.health().freshness).toEqual({ cumulativeSeconds: 30.3, bucketSeconds: 30.5, headSeconds: 30.5 });
    for (const view of ['v_cumulative', 'v_bucket', 'v_freshness']) expect(await h.gauge(h.signals.queryFailures, { view }), view).toBe(60);
    const stale = await h.board.snapshot(E);
    expect(stale.cumulative.soldSeats).toBe(12);
    expect(stale.freshness.headSeconds).toBe(30.5);
    h.source.failing.clear();
    await h.run(500, 300);
    expect(h.board.health().freshness.headSeconds).toBeLessThan(1.5);
    expect((await h.board.snapshot(E)).cumulative.soldSeats).toBe(99);
  });

  test('F-04-1 C-T37 ② 심장 박동 신선도는 정상인 채 거래 원시 행 적재가 60초 넘게 멈추면 끊김(rt_trade_gap_events 1), 다시 들어오면 사라진다', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows({ lastTradeMs: T0 }));
    await h.board.snapshot(E);
    await h.run(60_000, 300);
    expect((await h.board.snapshot(E)).tradeGap).toBe(false);
    expect(await h.gauge(h.signals.tradeGapEvents)).toBe(0);
    await h.run(500, 300);
    expect(h.board.health().freshness.headSeconds).toBeLessThan(5);
    expect((await h.board.snapshot(E)).tradeGap).toBe(true);
    expect(await h.gauge(h.signals.tradeGapEvents)).toBe(1);
    h.source.cumulativeRows.set(E, cumulativeRows({ lastTradeMs: h.now + 400 }));
    await h.run(500, 300);
    expect((await h.board.snapshot(E)).tradeGap).toBe(false);
    expect(await h.gauge(h.signals.tradeGapEvents)).toBe(0);
    expect(h.logs).toEqual(['rt-trade-gap', 'rt-trade-gap-cleared']);
  });

  test('F-04-1 ST-T3 ② ops-svc 이미 그린 칸에 늦은 사건이 들어오면 다음 조회에서 고쳐지고, 1초 칸은 최근 5분만 읽는다', async () => {
    const h = harness();
    h.source.cumulativeRows.set(E, cumulativeRows());
    h.source.bucketRows.set(E, [
      { metric: 'hold_result', dim: 'HELD', secondMs: T0, value: 3 },
      { metric: 'hold_result', dim: 'HELD', secondMs: T0 + 1_000, value: 2 },
    ]);
    await h.run(1_500, 300); // 지금 T0+1.5초: T0 칸만 끝났다
    expect((await h.board.snapshot(E)).buckets).toEqual([{ metric: 'hold_result', dim: 'HELD', points: [{ secondMs: T0, value: 3 }] }]);
    expect(h.source.lastBucketFromMs).toBe(T0 + 1_000 - 5 * MIN);
    h.source.bucketRows.set(E, [
      { metric: 'hold_result', dim: 'HELD', secondMs: T0, value: 4 },
      { metric: 'hold_result', dim: 'HELD', secondMs: T0 + 1_000, value: 2 },
    ]);
    await h.run(500, 300);
    expect((await h.board.snapshot(E)).buckets).toEqual([{ metric: 'hold_result', dim: 'HELD', points: [{ secondMs: T0, value: 4 }, { secondMs: T0 + 1_000, value: 2 }] }]);
  });

  test('F-04-1 C-T20 ⑦ 원천을 한 번도 읽지 못한 회차는 RtSourceFailure, 기준 자료가 없으면 파트너 값을 만들지 않는다', async () => {
    const h = harness();
    h.source.failing.add('cumulative');
    await expect(h.board.snapshot(E)).rejects.toBeInstanceOf(RtSourceFailure);
    await expect(h.board.partner(E)).rejects.toBeInstanceOf(RtSourceFailure);
    h.source.failing.clear();
    h.source.cumulativeRows.set(E, cumulativeRows());
    h.now = T0 + 1_000;
    expect(await h.board.partner(E)).toBeUndefined();
    expect((await h.board.snapshot(E)).remaining).toBeNull();
  });

  test('F-04-1 C-T36 ④ start는 0.5초마다 한 바퀴를 돌고(바퀴마다 신선도 한 번), stop 뒤에는 더 읽지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    h.pulse(300);
    h.board.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.source.reads.freshness).toBe(5); // 0·0.5·1·1.5·2초
    await h.board.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.source.reads.freshness).toBe(5);
  });
});

describe('F-04-1 시작 조립과 ClickHouse 어댑터', () => {
  test('F-04-1 C-T36 ⑤ 기대 파티션 설정은 텔레메트리 셋만 받고 파티션마다 편다. 틀린 꼴·다른 토픽·같은 토픽 두 번은 시작 실패다', () => {
    expect(pulsePartitionsOf('telemetry.queue:2, telemetry.trust-verdicts:1')).toEqual([
      { topic: 'telemetry.queue', partition: 0 },
      { topic: 'telemetry.queue', partition: 1 },
      { topic: 'telemetry.trust-verdicts', partition: 0 },
    ]);
    for (const bad of ['trade.seats:3', 'telemetry.queue', 'telemetry.queue:0', 'telemetry.queue:2,telemetry.queue:3']) expect(() => pulsePartitionsOf(bad), bad).toThrow(/PEAKET_RT_PULSE_PARTITIONS/);
  });

  test('F-04-1 C-T36 ⑥ ClickHouse 주소가 없으면 닫힌 원천으로 시작해 파트너 값은 RtSourceFailure, 신선도는 모름이고 경고를 남긴다', async () => {
    const w = realtimeTableFromEnv({}, { now: () => T0 });
    expect(w.warnings).toHaveLength(2);
    expect(w.warnings.join('\n')).toMatch(/PEAKET_RT_CLICKHOUSE_URL/);
    expect(w.warnings.join('\n')).toMatch(/authz-unavailable/);
    await expect(w.deps.board.partner(E)).rejects.toBeInstanceOf(RtSourceFailure);
    await w.deps.board.tick();
    expect(w.deps.board.health().freshness.headSeconds).toBe(FRESHNESS_UNKNOWN_SECONDS);
    const configured = realtimeTableFromEnv(
      { PEAKET_RT_CLICKHOUSE_URL: 'http://clickhouse.rt:8123', PEAKET_RT_PULSE_PARTITIONS: 'telemetry.queue:3,telemetry.purchase:3,telemetry.trust-verdicts:3' },
      { owners: { find: async () => undefined } },
    );
    expect(configured.warnings).toEqual([]);
    expect(configured.deps.owners).toBeDefined();
  });

  test('F-04-1 C-T20 ⑧ ClickHouse 어댑터는 고정 SQL에 회차 ID를 매개변수로만 넘기고 an_rt_reader·max_execution_time=1로 묻고, 64비트 글자 숫자를 숫자로 바꾼다', async () => {
    const calls: { url: URL; body: string; auth: string | null }[] = [];
    const responses: Record<string, unknown> = {
      v_cumulative: { data: [{ metric: 'sold_seats', dim: '', value: '12' }, { metric: 'sold_seats_section', dim: 'A', value: '7' }] },
      v_bucket: { data: [{ metric: 'hold_result', dim: 'HELD', second_s: 1_795_428_000, value: '3' }] },
      v_freshness: { data: [{ topic: 'telemetry.queue', kafka_partition: 0, last_ms: '1795428000123', pulses_2s: '2' }] },
      brz_ref_seat_map: { data: [{ layout_version: 2, section_id: 'A', tier_id: 'R', seat_count: 40 }] },
    };
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const body = String(init?.body ?? '');
      calls.push({ url, body, auth: new Headers(init?.headers).get('authorization') });
      const key = Object.keys(responses).find((k) => body.includes(k))!;
      return new Response(JSON.stringify(responses[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const src = new ClickHouseRtSource({ baseUrl: 'http://clickhouse.rt:8123', password: 'pw', fetch: fakeFetch as typeof fetch });
    const evil = "e1') OR 1=1 --";
    expect(await src.cumulative(evil)).toEqual([
      { metric: 'sold_seats', dim: '', value: 12 },
      { metric: 'sold_seats_section', dim: 'A', value: 7 },
    ]);
    expect(await src.buckets(E, Date.parse('2026-11-23T09:55:00.000Z'))).toEqual([{ metric: 'hold_result', dim: 'HELD', secondMs: 1_795_428_000_000, value: 3 }]);
    expect(await src.freshness()).toEqual([{ topic: 'telemetry.queue', partition: 0, lastProducedAtMs: 1_795_428_000_123, pulses2s: 2 }]);
    expect(await src.seatMap(E)).toEqual([{ layoutVersion: 2, sectionId: 'A', tierId: 'R', seatCount: 40 }]);
    expect(calls[0]!.body).toBe('SELECT metric, dim, value FROM rt.v_cumulative(event_id = {event_id:String}) FORMAT JSON');
    expect(calls[0]!.body).not.toContain(evil);
    expect(calls[0]!.url.searchParams.get('param_event_id')).toBe(evil);
    expect(calls[1]!.url.searchParams.get('param_from_ts')).toBe(String(Date.parse('2026-11-23T09:55:00.000Z') / 1_000) + '.000');
    for (const c of calls) {
      expect(c.url.searchParams.get('max_execution_time')).toBe('1');
      expect(c.auth).toBe(`Basic ${Buffer.from('an_rt_reader:pw').toString('base64')}`);
    }
    const failing = new ClickHouseRtSource({ baseUrl: 'http://clickhouse.rt:8123', fetch: (async () => new Response('Code: 60. UNKNOWN_TABLE', { status: 404 })) as typeof fetch });
    await expect(failing.seatMap(E)).rejects.toBeInstanceOf(RtSourceFailure);
  });
});
