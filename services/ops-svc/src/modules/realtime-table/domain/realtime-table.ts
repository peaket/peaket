// 관제 실시간 표(조회 시점 집계)의 업무 규칙(docs/streaming.md §4.1·§4.3·§4.5, docs/features/control-tower.md §11, OPS-160, F-04-1).
// 뷰 행(rt.v_cumulative·rt.v_bucket·rt.v_freshness)과 회차 기준 자료(bronze.brz_ref_seat_map)를 회차 스냅숏·신선도·Degraded·
// 거래 사건 끊김·파트너 판매 현황으로 바꾼다. 모두 시각을 인자로 받는 순수 함수다(시계는 부르는 쪽이 주입한다).
// [가정] 값은 정본이 [가정]으로 둔 값이거나 F-04-1 계획의 '추천 적용 2026-11-23'이다.

/** 텔레메트리 셋(심장 박동이 실리는 토픽, docs/streaming.md §3의 2) */
export const TELEMETRY_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'] as const;
export type TelemetryTopic = (typeof TELEMETRY_TOPICS)[number];

/** 회차마다 누적·1초 칸을 읽는 주기(0.5초 [가정], streaming §4.3) */
export const RT_POLL_MS = 500;
/** 관심 회차: 이 시간 안에 한 번이라도 읽힌 회차만 주기마다 읽는다(5분 [가정]) */
export const RT_WATCH_MS = 5 * 60_000;
/** 관심이 끊긴 회차의 분당 기록을 이만큼 들고 있다(파트너 분당 판매 180분과 같다) */
export const RT_KEEP_MS = 180 * 60_000;
/** 1초 칸을 읽는 범위(지금부터 5분 앞까지 [가정], 추천 적용 2026-11-23) */
export const RT_BUCKET_LOOKBACK_MS = 5 * 60_000;
/** 회차 기준 자료(판매 대상 좌석 수)를 다시 읽는 주기(1분 [가정]) */
export const RT_SEAT_MAP_REFRESH_MS = 60_000;
/** 파트너 판매 현황은 회차마다 1분에 한 번 계산한다(control-tower §11) */
export const PARTNER_EVERY_MS = 60_000;
/** 파트너 분당 판매 점 수(최근 180분 [가정], openapi LiveSnapshot.soldPerMinute maxItems) */
export const PARTNER_MINUTES = 180;
/** 예상 매진 시각의 판매 속도 창(최근 5분 [가정], ADR-0062) */
export const PROJECTION_WINDOW_MS = 5 * 60_000;
/** Degraded 판정(streaming §4.5, ADR-0078 결정 2): 1분 창 p95가 5초를 넘는 상태가 3분 넘게면 전환, 5초 미만이 5분 [가정]이면 되돌림 */
export const FRESHNESS_WINDOW_MS = 60_000;
export const DEGRADE_P95_SECONDS = 5;
export const DEGRADE_AFTER_MS = 3 * 60_000;
export const RECOVER_AFTER_MS = 5 * 60_000;
/** 거래 사건 끊김(C-T37): 마지막 거래 원시 행 적재가 60초 [가정]보다 오래되면 끊김, 30분 [가정] 안에 거래가 있었던 회차만(판매 중으로 본다) */
export const TRADE_GAP_MS = 60_000;
export const TRADE_ACTIVE_WINDOW_MS = 30 * 60_000;
/**
 * 신선도를 알 수 없을 때의 값(초). 기대 파티션이 뷰에 없거나(rt.v_freshness는 최근 1시간만 본다) 신선도를 한 번도 읽지 못했을 때다.
 * 히스토그램 합이 무한이 되지 않게 무한 대신 1시간을 쓴다(추천 적용 2026-11-23)
 */
export const FRESHNESS_UNKNOWN_SECONDS = 3_600;

/** 원천(ClickHouse·회차 기준 자료)을 읽지 못했다. 받는 층이 503으로 바꾼다 */
export class RtSourceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtSourceFailure';
  }
}

/**
 * 받는 층이 Problem으로 옮기는 업무 거절. 이름은 계약의 오류 목록(openapi x-peaket-problem-types)에 있는 것만 쓰고 제목도 그 목록과 같다.
 * 다른 파트너 회차(403)는 목록에 이름이 없어 이름 없는 403(about:blank)이다(추천 적용 2026-11-23)
 */
export class RtProblem extends Error {
  constructor(
    readonly type: 'forbidden' | 'not-found' | 'authz-unavailable' | 'dependency-unavailable',
    readonly status: 403 | 404 | 503,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RtProblem';
  }
}

// ---------- 뷰 행 ----------

/** rt.v_cumulative 한 줄 */
export interface CumulativeRow {
  readonly metric: string;
  readonly dim: string;
  readonly value: number;
}
/** rt.v_bucket 한 줄. secondMs는 칸 시작(유닉스 밀리초) */
export interface BucketRow {
  readonly metric: string;
  readonly dim: string;
  readonly secondMs: number;
  readonly value: number;
}
/** rt.v_freshness 한 줄(파티션마다 마지막 심장 박동) */
export interface FreshnessRow {
  readonly topic: string;
  readonly partition: number;
  readonly lastProducedAtMs: number;
  /** 최근 2초 안에 받은 심장 박동 수(엔지니어 화면의 파티션별 박동 수) */
  readonly pulses2s: number;
}
export interface PartitionRef {
  readonly topic: string;
  readonly partition: number;
}
/** bronze.brz_ref_seat_map 한 줄(쓰는 칸만) */
export interface SeatMapRow {
  readonly layoutVersion: number | string;
  readonly sectionId: string;
  readonly tierId: string;
  readonly seatCount: number;
}

// ---------- 누적 ----------

export interface RtFunnel {
  readonly admitted: number;
  readonly firstHold: number;
  readonly paymentAccepted: number;
  readonly approved: number;
  readonly issued: number;
}
export interface RtQueue {
  readonly entries: number;
  readonly admissions: number;
  readonly removed: number;
  /** 지금 대기 인원 = 진입 − 입장 − 빠진 번호(streaming §4.1). 음수면 0 */
  readonly waiting: number;
}
export interface RtCumulative {
  readonly soldSeats: number;
  readonly soldSeatsByTier: Readonly<Record<string, number>>;
  readonly soldSeatsBySection: Readonly<Record<string, number>>;
  readonly salesAmount: number;
  readonly ordersConfirmed: number;
  readonly ticketsIssued: number;
  readonly funnel: RtFunnel;
  readonly firstHoldByTier: Readonly<Record<string, number>>;
  readonly queue: RtQueue;
  /** 그 회차 거래 원시 행의 마지막 적재 시각(유닉스 밀리초). 거래 행이 없으면 0 */
  readonly lastTradeLoadedMs: number;
}

const int = (v: number): number => (Number.isFinite(v) ? Math.trunc(v) : 0);

/** 뷰 행을 누적으로. 모르는 지표 줄은 버리고, 없는 줄은 0이다 */
export function cumulativeOf(rows: readonly CumulativeRow[]): RtCumulative {
  const one = new Map<string, number>();
  const byTier: Record<string, number> = {};
  const bySection: Record<string, number> = {};
  const holdByTier: Record<string, number> = {};
  for (const r of rows) {
    const v = int(r.value);
    switch (r.metric) {
      case 'sold_seats_tier':
        byTier[r.dim] = (byTier[r.dim] ?? 0) + v;
        break;
      case 'sold_seats_section':
        bySection[r.dim] = (bySection[r.dim] ?? 0) + v;
        break;
      case 'funnel_first_hold_tier':
        holdByTier[r.dim] = (holdByTier[r.dim] ?? 0) + v;
        break;
      default:
        one.set(r.metric, (one.get(r.metric) ?? 0) + v);
    }
  }
  const n = (k: string) => one.get(k) ?? 0;
  const entries = n('queue_entries');
  const admissions = n('queue_admissions');
  const removed = n('queue_removed');
  return {
    soldSeats: n('sold_seats'),
    soldSeatsByTier: byTier,
    soldSeatsBySection: bySection,
    salesAmount: n('sales_amount'),
    ordersConfirmed: n('orders_confirmed'),
    ticketsIssued: n('tickets_issued'),
    funnel: {
      admitted: n('funnel_admitted'),
      firstHold: n('funnel_first_hold'),
      paymentAccepted: n('funnel_payment_accepted'),
      approved: n('funnel_approved'),
      issued: n('funnel_issued'),
    },
    firstHoldByTier: holdByTier,
    queue: { entries, admissions, removed, waiting: Math.max(0, entries - admissions - removed) },
    lastTradeLoadedMs: Math.max(0, n('last_trade_loaded_ms')),
  };
}

// ---------- 잔여석 ----------

export interface SeatMap {
  readonly layoutVersion: number | string;
  readonly total: number;
  readonly bySection: Readonly<Record<string, number>>;
  readonly byTier: Readonly<Record<string, number>>;
}

const versionGreater = (a: number | string, b: number | string): boolean => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb;
  return String(a) > String(b);
};

/** 회차 기준 자료 행에서 마지막 배치 판(layout_version이 가장 큰 판)의 판매 대상 좌석 수. 행이 없으면 undefined(모름) */
export function seatMapOf(rows: readonly SeatMapRow[]): SeatMap | undefined {
  let latest: number | string | undefined;
  for (const r of rows) if (latest === undefined || versionGreater(r.layoutVersion, latest)) latest = r.layoutVersion;
  if (latest === undefined) return undefined;
  const bySection: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    if (String(r.layoutVersion) !== String(latest)) continue;
    const c = Math.max(0, int(r.seatCount));
    total += c;
    bySection[r.sectionId] = (bySection[r.sectionId] ?? 0) + c;
    byTier[r.tierId] = (byTier[r.tierId] ?? 0) + c;
  }
  return { layoutVersion: latest, total, bySection, byTier };
}

export interface RtRemaining {
  readonly total: number;
  readonly bySection: Readonly<Record<string, number>>;
  readonly byTier: Readonly<Record<string, number>>;
}

/**
 * 잔여석 = 판매 대상 좌석 수 − 판매 좌석(streaming §4.1. 홀드·결제 중 좌석은 빼지 않는다, ADR-0072·0073).
 * 판매 좌석이 대상보다 많으면(배치 판이 바뀐 회차 등) 0으로 둔다(추천 적용 2026-11-23). 기준 자료가 없으면 null(모름)
 */
export function remainingOf(cum: RtCumulative, seatMap: SeatMap | undefined): RtRemaining | null {
  if (!seatMap) return null;
  const sub = (cap: Readonly<Record<string, number>>, sold: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(cap).map(([k, c]) => [k, Math.max(0, c - (sold[k] ?? 0))]));
  return {
    total: Math.max(0, seatMap.total - cum.soldSeats),
    bySection: sub(seatMap.bySection, cum.soldSeatsBySection),
    byTier: sub(seatMap.byTier, cum.soldSeatsByTier),
  };
}

// ---------- 1초 칸 ----------

export interface RtBucketSeries {
  readonly metric: string;
  readonly dim: string;
  readonly points: readonly { readonly secondMs: number; readonly value: number }[];
}

/** 지금 시각에서 마지막으로 끝난 1초 칸의 시작(그 칸은 [시작, 시작+1초)) */
export const lastFinishedSecondMs = (nowMs: number): number => Math.floor(nowMs / 1_000) * 1_000 - 1_000;

/** 끝난 칸만(칸 끝 ≤ 지금, streaming §4.3 '지금보다 1초 앞까지') 지표·차원마다 시각 차례로 묶는다 */
export function finishedBuckets(rows: readonly BucketRow[], nowMs: number): readonly RtBucketSeries[] {
  const last = lastFinishedSecondMs(nowMs);
  const series = new Map<string, { metric: string; dim: string; points: { secondMs: number; value: number }[] }>();
  for (const r of rows) {
    if (!(r.secondMs <= last)) continue;
    const key = `${r.metric}\u0000${r.dim}`;
    let s = series.get(key);
    if (!s) series.set(key, (s = { metric: r.metric, dim: r.dim, points: [] }));
    s.points.push({ secondMs: r.secondMs, value: int(r.value) });
  }
  return [...series.values()]
    .map((s) => ({ ...s, points: s.points.sort((a, b) => a.secondMs - b.secondMs) }))
    .sort((a, b) => (a.metric === b.metric ? (a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : 0) : a.metric < b.metric ? -1 : 1));
}

// ---------- 신선도(streaming §4.5) ----------

export interface PulseAsOf {
  /** 기대 파티션 전부 가운데 가장 늦은 파티션의 마지막 심장 박동 발행 시각. 빠진 파티션이 있거나 행이 없으면 undefined */
  readonly asOfMs: number | undefined;
  /** 기대 목록에 있는데 뷰에 없는 파티션 */
  readonly missing: readonly PartitionRef[];
  /** 가장 늦은 파티션(빠진 파티션이 있으면 그 첫째) */
  readonly stalest?: PartitionRef;
}

const partKey = (p: PartitionRef) => `${p.topic}#${p.partition}`;

/**
 * 심장 박동 행에서 누적 길의 기준 시각을 고른다. 기대 목록이 비면(설정 없음) 뷰에 보이는 파티션만 본다
 * (그때는 빠진 파티션을 잡지 못한다, 추천 적용 2026-11-23)
 */
export function pulseAsOf(expected: readonly PartitionRef[], rows: readonly FreshnessRow[]): PulseAsOf {
  const seen = new Map(rows.map((r) => [partKey(r), r] as const));
  const want = expected.length > 0 ? expected : rows.map((r) => ({ topic: r.topic, partition: r.partition }));
  const missing = want.filter((p) => !seen.has(partKey(p)));
  if (want.length === 0) return { asOfMs: undefined, missing: [] };
  if (missing.length > 0) return { asOfMs: undefined, missing, stalest: missing[0]! };
  let stalest: FreshnessRow | undefined;
  for (const p of want) {
    const r = seen.get(partKey(p))!;
    if (!stalest || r.lastProducedAtMs < stalest.lastProducedAtMs) stalest = r;
  }
  return { asOfMs: stalest!.lastProducedAtMs, missing: [], stalest: { topic: stalest!.topic, partition: stalest!.partition } };
}

export interface Freshness {
  /** 누적 길: 지금 − 기준 시각(초) */
  readonly cumulativeSeconds: number;
  /** 1초 칸 길: 지금 − 기준 시각을 초 단위로 내린 시각(초, 추천 적용 2026-11-23) */
  readonly bucketSeconds: number;
  /** 화면 머리 값: 둘 중 큰 값 */
  readonly headSeconds: number;
}

const capSeconds = (ms: number) => Math.min(FRESHNESS_UNKNOWN_SECONDS, Math.max(0, ms / 1_000));

/** 기준 시각(유닉스 밀리초)이 없으면 두 길 모두 모름(FRESHNESS_UNKNOWN_SECONDS) */
export function freshnessOf(nowMs: number, asOfMs: number | undefined): Freshness {
  if (asOfMs === undefined || !Number.isFinite(asOfMs)) {
    return { cumulativeSeconds: FRESHNESS_UNKNOWN_SECONDS, bucketSeconds: FRESHNESS_UNKNOWN_SECONDS, headSeconds: FRESHNESS_UNKNOWN_SECONDS };
  }
  const cumulativeSeconds = capSeconds(nowMs - asOfMs);
  const bucketSeconds = capSeconds(nowMs - Math.floor(asOfMs / 1_000) * 1_000);
  return { cumulativeSeconds, bucketSeconds, headSeconds: Math.max(cumulativeSeconds, bucketSeconds) };
}

/** 두 신선도 가운데 길마다 나쁜 쪽 */
export const worseFreshness = (a: Freshness, b: Freshness): Freshness => {
  const cumulativeSeconds = Math.max(a.cumulativeSeconds, b.cumulativeSeconds);
  const bucketSeconds = Math.max(a.bucketSeconds, b.bucketSeconds);
  return { cumulativeSeconds, bucketSeconds, headSeconds: Math.max(cumulativeSeconds, bucketSeconds) };
};

/** 순위 방식 백분위(값 n개를 늘어놓고 ⌈q·n⌉번째). 빈 목록은 undefined */
export function percentile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

// ---------- Degraded(streaming §4.5, ADR-0078 결정 2) ----------

export interface DegradedState {
  readonly degraded: boolean;
  /** p95가 5초를 넘기 시작한 때(전환 전) */
  readonly badSinceMs: number | null;
  /** p95가 5초 미만이 된 때(전환 뒤) */
  readonly goodSinceMs: number | null;
  readonly changedAtMs: number | null;
}

export const initialDegraded: DegradedState = { degraded: false, badSinceMs: null, goodSinceMs: null, changedAtMs: null };

/**
 * 1분 창 p95 하나로 상태를 한 걸음 옮긴다. p95가 5초를 '넘는'(>) 상태가 3분 '넘게'(>) 이어지면 Degraded,
 * Degraded에서 5초 '미만'(<) 상태가 5분 이어지면(≥) 되돌린다. 정확히 5초는 어느 쪽 연속도 끊는다
 */
export function nextDegraded(s: DegradedState, nowMs: number, p95Seconds: number): DegradedState {
  if (!s.degraded) {
    if (!(p95Seconds > DEGRADE_P95_SECONDS)) return s.badSinceMs === null ? s : { ...s, badSinceMs: null };
    const badSinceMs = s.badSinceMs ?? nowMs;
    if (nowMs - badSinceMs > DEGRADE_AFTER_MS) return { degraded: true, badSinceMs: null, goodSinceMs: null, changedAtMs: nowMs };
    return s.badSinceMs === badSinceMs ? s : { ...s, badSinceMs };
  }
  if (!(p95Seconds < DEGRADE_P95_SECONDS)) return s.goodSinceMs === null ? s : { ...s, goodSinceMs: null };
  const goodSinceMs = s.goodSinceMs ?? nowMs;
  if (nowMs - goodSinceMs >= RECOVER_AFTER_MS) return { degraded: false, badSinceMs: null, goodSinceMs: null, changedAtMs: nowMs };
  return s.goodSinceMs === goodSinceMs ? s : { ...s, goodSinceMs };
}

// ---------- 거래 사건 끊김(C-T37) ----------

/**
 * 거래 원시 행의 마지막 적재가 60초 [가정]보다 오래됐고 30분 [가정] 안이면 끊김이다. 30분 안에 거래가 없던 회차(판매 전·끝)는 끊김이 아니다.
 * 심장 박동 신선도와 따로 본다(거래 토픽에는 심장 박동이 없다, streaming §3의 3). 판매 윈도우를 core에서 읽지 않는다(추천 적용 2026-11-23)
 */
export function tradeGapOf(nowMs: number, lastTradeLoadedMs: number): boolean {
  if (!(lastTradeLoadedMs > 0)) return false;
  const age = nowMs - lastTradeLoadedMs;
  return age > TRADE_GAP_MS && age <= TRADE_ACTIVE_WINDOW_MS;
}

// ---------- 파트너 판매 현황(control-tower §11, openapi LiveSnapshot) ----------

/** 분마다 처음 읽은 판매 좌석 누적(분당 판매·판매 속도의 재료) */
export interface MinutePoint {
  /** 그 분의 시작(유닉스 밀리초) */
  readonly minuteMs: number;
  /** 실제로 읽은 시각 */
  readonly atMs: number;
  readonly sold: number;
}

export const minuteOf = (ms: number): number => Math.floor(ms / 60_000) * 60_000;

/** 새 분이면 점을 더하고 오래된 점(181개 넘게)을 버린다. 같은 분이면 그대로 */
export function recordMinute(history: readonly MinutePoint[], atMs: number, sold: number): readonly MinutePoint[] {
  const minuteMs = minuteOf(atMs);
  const last = history.at(-1);
  if (last && last.minuteMs >= minuteMs) return history;
  const next = [...history, { minuteMs, atMs, sold }];
  return next.length > PARTNER_MINUTES + 1 ? next.slice(next.length - (PARTNER_MINUTES + 1)) : next;
}

/** 분당 판매 = 판매 좌석 누적의 1분 차이(ADR-0073). 뒤 점의 분을 이름으로 단다. 1분이 아닌 틈(관심이 끊겼던 동안)은 건너뛴다 */
export function soldPerMinuteOf(history: readonly MinutePoint[]): readonly { readonly minuteMs: number; readonly sold: number }[] {
  const out: { minuteMs: number; sold: number }[] = [];
  for (let i = 1; i < history.length; i += 1) {
    const a = history[i - 1]!;
    const b = history[i]!;
    if (b.minuteMs - a.minuteMs === 60_000) out.push({ minuteMs: b.minuteMs, sold: b.sold - a.sold });
  }
  return out.slice(-PARTNER_MINUTES);
}

/**
 * 예상 매진 시각 = 지금 + 잔여 ÷ 최근 5분 [가정] 판매 속도(ADR-0062, d5 §6.9). 기준 점은 5분 전 또는 그보다 이른 마지막 점이고,
 * 기록이 5분보다 짧으면 가장 이른 점이다. 판매가 없거나(속도 ≤ 0)·이미 매진이거나·기준 점이 없으면 null('—')
 */
export function projectedSoldOutAtOf(asOfMs: number, soldNow: number, remaining: number, history: readonly MinutePoint[]): number | null {
  if (!(remaining > 0)) return null;
  const earlier = history.filter((p) => p.atMs < asOfMs);
  if (earlier.length === 0) return null;
  const from = asOfMs - PROJECTION_WINDOW_MS;
  const base = [...earlier].reverse().find((p) => p.atMs <= from) ?? earlier[0]!;
  const elapsed = asOfMs - base.atMs;
  const rate = (soldNow - base.sold) / elapsed;
  if (!(elapsed > 0) || !(rate > 0)) return null;
  return asOfMs + Math.ceil(remaining / rate);
}

/** 파트너에게 주는 칸만(관람객 개인정보·봇 탐지 값은 원천에 없고 여기에도 싣지 않는다, control-tower §11) */
export interface PartnerLiveSnapshot {
  readonly asOf: string;
  readonly nextUpdateAt: string;
  readonly sold: number;
  readonly remaining: number;
  readonly projectedSoldOutAt: string | null;
  readonly waiting: number;
  readonly queueEntries: number;
  readonly sections: readonly { readonly sectionId: string; readonly remaining: number }[];
  readonly soldPerMinute: readonly { readonly minute: string; readonly sold: number }[];
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 파트너 스냅숏. asOf는 누적을 읽은 시각, nextUpdateAt은 asOf + 1분. 판매 대상 좌석 수를 모르면(기준 자료 없음) 만들지 않는다
 * (LiveSnapshot.remaining이 필수라 지어낸 값을 주지 않는다, 추천 적용 2026-11-23)
 */
export function partnerSnapshotOf(i: {
  readonly asOfMs: number;
  readonly cumulative: RtCumulative;
  readonly seatMap: SeatMap | undefined;
  readonly history: readonly MinutePoint[];
}): PartnerLiveSnapshot | undefined {
  const remaining = remainingOf(i.cumulative, i.seatMap);
  if (!remaining) return undefined;
  const projected = projectedSoldOutAtOf(i.asOfMs, i.cumulative.soldSeats, remaining.total, i.history);
  return {
    asOf: iso(i.asOfMs),
    nextUpdateAt: iso(i.asOfMs + PARTNER_EVERY_MS),
    sold: i.cumulative.soldSeats,
    remaining: remaining.total,
    projectedSoldOutAt: projected === null ? null : iso(projected),
    waiting: i.cumulative.queue.waiting,
    queueEntries: i.cumulative.queue.entries,
    sections: Object.entries(remaining.bySection)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sectionId, r]) => ({ sectionId, remaining: r })),
    soldPerMinute: soldPerMinuteOf(i.history).map((p) => ({ minute: iso(p.minuteMs), sold: p.sold })),
  };
}

// ---------- 회차 스냅숏(관제 위젯 원천이 쓴다) ----------

export interface RtEventSnapshot {
  readonly eventId: string;
  /** 누적을 마지막으로 읽은 시각 */
  readonly readAtMs: number;
  readonly cumulative: RtCumulative;
  /** 판매 대상 좌석 수를 모르면 null */
  readonly remaining: RtRemaining | null;
  /** 끝난 1초 칸만 */
  readonly buckets: readonly RtBucketSeries[];
  readonly lastFinishedSecondMs: number;
  /** 이 회차 값의 신선도(조회가 실패하면 마지막으로 읽은 뒤의 시간만큼 나빠진다) */
  readonly freshness: Freshness;
  readonly degraded: boolean;
  readonly tradeGap: boolean;
}
