// 관제 실시간 표 보드(docs/streaming.md §4.3·§4.5, docs/features/control-tower.md §11, OPS-160, F-04-1).
// - 관심 회차(최근 5분 [가정] 안에 읽힌 회차)마다 0.5초 [가정]에 한 번 누적·1초 칸을 읽고, 주기마다 신선도를 한 번 읽는다.
//   회차마다 한 번 읽은 값을 여러 화면(관제 위젯·파트너 판매 현황)이 나눠 쓴다. 같은 회차를 동시에 물어도 조회는 하나다.
// - 신선도: 기대 파티션 전부 가운데 가장 늦은 파티션의 마지막 심장 박동이 기준이다. 회차 조회가 실패하면 그 회차 값은 마지막으로 읽은 때의
//   기준 시각에 머물러 신선도가 나빠진다(조회 실패도 신선도 악화로 본다). 주기마다 두 길을 rt_freshness_seconds{path}로 낸다.
// - Degraded: 1분 창 신선도(머리 값) p95가 5초를 넘는 상태가 3분 넘게면 전환, 5초 미만이 5분이면 되돌린다.
// - 파트너 판매 현황은 회차마다 1분에 한 번만 계산한다(그 사이 묻는 화면은 같은 값을 받는다).
import {
  FRESHNESS_WINDOW_MS,
  PARTNER_EVERY_MS,
  RT_BUCKET_LOOKBACK_MS,
  RT_KEEP_MS,
  RT_POLL_MS,
  RT_SEAT_MAP_REFRESH_MS,
  RT_WATCH_MS,
  RtSourceFailure,
  cumulativeOf,
  finishedBuckets,
  freshnessOf,
  initialDegraded,
  lastFinishedSecondMs,
  nextDegraded,
  partnerSnapshotOf,
  percentile,
  pulseAsOf,
  recordMinute,
  remainingOf,
  seatMapOf,
  tradeGapOf,
  worseFreshness,
  type BucketRow,
  type DegradedState,
  type Freshness,
  type FreshnessRow,
  type MinutePoint,
  type PartitionRef,
  type PartnerLiveSnapshot,
  type PulseAsOf,
  type RtCumulative,
  type RtEventSnapshot,
  type SeatMap,
} from '../domain/realtime-table.js';
import type { RtBoardLog, RtQuerySource, RtSignals, RtView, SeatMapSource } from '../domain/ports.js';

export interface RtBoardOptions {
  readonly pollMs: number;
  readonly watchMs: number;
  readonly keepMs: number;
  readonly bucketLookbackMs: number;
  readonly seatMapRefreshMs: number;
}

export interface RtBoardDeps {
  readonly source: RtQuerySource;
  readonly seatMaps: SeatMapSource;
  /** 벽시계(유닉스 밀리초) */
  readonly now: () => number;
  /** 조회 시간 재기용 단조 시계. 없으면 now */
  readonly monotonicMs?: () => number;
  /** 기대 파티션(PEAKET_RT_PULSE_PARTITIONS). 비면 뷰에 보이는 파티션만 본다 */
  readonly expected: readonly PartitionRef[];
  readonly signals?: RtSignals;
  readonly log?: RtBoardLog;
  readonly options?: Partial<RtBoardOptions>;
}

export interface RtBoardHealth {
  readonly freshness: Freshness;
  /** 1분 창 머리 값 p95(표본이 없으면 null) */
  readonly p95Seconds: number | null;
  readonly degraded: boolean;
  readonly degradedChangedAtMs: number | null;
  readonly missingPartitions: readonly PartitionRef[];
  readonly stalestPartition: PartitionRef | null;
  /** 엔지니어 화면의 파티션별 심장 박동(마지막 발행 시각·최근 2초 받은 수) */
  readonly pulses: readonly FreshnessRow[];
  readonly watchedEvents: number;
}

interface EventState {
  readonly eventId: string;
  interestAtMs: number;
  cumulative?: RtCumulative;
  /** 누적을 마지막으로 읽은 시각 */
  readAtMs?: number;
  /** 그 읽기 때의 심장 박동 기준 시각(모르면 undefined) */
  dataAsOfMs?: number | undefined;
  bucketRows: readonly BucketRow[];
  bucketAsOfMs?: number | undefined;
  bucketsReadOnce: boolean;
  seatMap?: SeatMap | undefined;
  seatMapReadAtMs?: number;
  history: readonly MinutePoint[];
  partner?: { readonly nextUpdateAtMs: number; readonly view: PartnerLiveSnapshot };
  reading?: Promise<void> | undefined;
  tradeGap: boolean;
}

const DEFAULTS: RtBoardOptions = {
  pollMs: RT_POLL_MS,
  watchMs: RT_WATCH_MS,
  keepMs: RT_KEEP_MS,
  bucketLookbackMs: RT_BUCKET_LOOKBACK_MS,
  seatMapRefreshMs: RT_SEAT_MAP_REFRESH_MS,
};

export class RtBoard {
  readonly #source: RtQuerySource;
  readonly #seatMaps: SeatMapSource;
  readonly #now: () => number;
  readonly #mono: () => number;
  readonly #expected: readonly PartitionRef[];
  readonly #signals: RtSignals | undefined;
  #log: RtBoardLog | undefined;
  readonly #o: RtBoardOptions;
  readonly #events = new Map<string, EventState>();
  #pulseRows: readonly FreshnessRow[] = [];
  #pulse: PulseAsOf = { asOfMs: undefined, missing: [] };
  /** 심장 박동을 한 번이라도 읽었는가(못 읽었으면 회차를 바로 읽기 전에 먼저 읽는다) */
  #pulseReadOnce = false;
  #samples: { atMs: number; seconds: number }[] = [];
  #degraded: DegradedState = initialDegraded;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #tick: Promise<void> | undefined;

  constructor(d: RtBoardDeps) {
    this.#source = d.source;
    this.#seatMaps = d.seatMaps;
    this.#now = d.now;
    this.#mono = d.monotonicMs ?? d.now;
    this.#expected = d.expected;
    this.#signals = d.signals;
    this.#log = d.log;
    this.#o = { ...DEFAULTS, ...(d.options ?? {}) };
  }

  get pollMs(): number {
    return this.#o.pollMs;
  }

  /** 로그를 나중에 붙인다(서비스 로거는 보드를 넘긴 뒤에 생긴다) */
  setLog(log: RtBoardLog): void {
    this.#log = log;
  }

  /** 0.5초 주기를 켠다(한 바퀴가 길면 겹치지 않고 다음 바퀴를 미룬다) */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = () => {
      const started = this.#mono();
      this.#tick = this.tick()
        .catch((err: unknown) => this.#log?.warn({ event: 'rt-board-tick-failed', err: err instanceof Error ? err.name : 'unknown' }, '실시간 표 한 바퀴가 실패했다(다음 바퀴에 다시)'))
        .finally(() => {
          this.#tick = undefined;
          if (!this.#running) return;
          const wait = Math.max(0, this.#o.pollMs - (this.#mono() - started));
          this.#timer = setTimeout(loop, wait);
          this.#timer.unref?.();
        });
    };
    this.#timer = setTimeout(loop, 0);
    this.#timer.unref?.();
  }

  /** 주기를 끄고 돌던 바퀴가 끝나기를 기다린다 */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#tick;
  }

  /** 한 바퀴: 신선도 한 번, 관심 회차마다 누적·1초 칸, 그다음 신선도·Degraded·끊김 판정과 지표 */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const [id, s] of this.#events) if (now - s.interestAtMs >= this.#o.keepMs) this.#events.delete(id);
    await this.#readFreshness();
    const watched = this.#watched(now);
    await Promise.all(watched.map((s) => this.#read(s).catch(() => undefined)));
    this.#evaluate(this.#now(), watched);
  }

  /**
   * 회차 하나의 지금 값(관제 위젯 원천이 부른다). 관심 회차로 올리고, 이 보드가 아직 읽지 않았거나 주기 두 번보다 오래 못 읽었으면 바로 읽는다.
   * 바로 읽기가 실패하면 마지막 값을 신선도와 함께 돌려주고, 한 번도 못 읽었으면 RtSourceFailure다
   */
  async snapshot(eventId: string, atMs: number = this.#now()): Promise<RtEventSnapshot> {
    const s = this.#touch(eventId, atMs);
    if (!this.#recent(s, atMs)) {
      try {
        await this.#read(s);
      } catch (e) {
        if (s.cumulative === undefined) throw e;
      }
    }
    const cumulative = s.cumulative;
    if (cumulative === undefined || s.readAtMs === undefined) throw new RtSourceFailure('rt cumulative is not read yet');
    return {
      eventId,
      readAtMs: s.readAtMs,
      cumulative,
      remaining: remainingOf(cumulative, s.seatMap),
      buckets: finishedBuckets(s.bucketRows, atMs),
      lastFinishedSecondMs: lastFinishedSecondMs(atMs),
      freshness: this.#eventFreshness(s, atMs),
      degraded: this.#degraded.degraded,
      tradeGap: tradeGapOf(atMs, cumulative.lastTradeLoadedMs),
    };
  }

  /**
   * 파트너 판매 현황(LiveSnapshot). 회차마다 1분에 한 번만 계산하고 그 사이에는 같은 값을 준다.
   * 새로 계산할 때 이 보드가 주기 두 번 안에 읽은 값이 없으면 바로 읽고, 실패하면 RtSourceFailure(503)다.
   * 판매 대상 좌석 수를 모르면(회차 기준 자료 없음) undefined다
   */
  async partner(eventId: string): Promise<PartnerLiveSnapshot | undefined> {
    const now = this.#now();
    const s = this.#touch(eventId, now);
    if (s.partner && now < s.partner.nextUpdateAtMs) return s.partner.view;
    if (!this.#recent(s, now)) {
      await this.#read(s);
      // 같은 읽기를 기다린 다른 화면이 먼저 계산했으면 그 값을 나눠 쓴다(1분에 한 번)
      if (s.partner && this.#now() < s.partner.nextUpdateAtMs) return s.partner.view;
    }
    if (s.cumulative === undefined || s.readAtMs === undefined) throw new RtSourceFailure('rt cumulative is not read yet');
    const view = partnerSnapshotOf({ asOfMs: s.readAtMs, cumulative: s.cumulative, seatMap: s.seatMap, history: s.history });
    if (!view) return undefined;
    s.partner = { nextUpdateAtMs: s.readAtMs + PARTNER_EVERY_MS, view };
    return view;
  }

  /** 신선도·Degraded(콘솔 판매 중 탭 머리, 엔지니어 화면) */
  health(atMs: number = this.#now()): RtBoardHealth {
    const values = this.#samples.filter((x) => x.atMs > atMs - FRESHNESS_WINDOW_MS).map((x) => x.seconds);
    const p95 = percentile(values, 0.95);
    return {
      freshness: this.#boardFreshness(atMs, this.#watched(atMs)),
      p95Seconds: p95 ?? null,
      degraded: this.#degraded.degraded,
      degradedChangedAtMs: this.#degraded.changedAtMs,
      missingPartitions: this.#pulse.missing,
      stalestPartition: this.#pulse.stalest ?? null,
      pulses: this.#pulseRows,
      watchedEvents: this.#watched(atMs).length,
    };
  }

  // ---------- 안쪽 ----------

  #touch(eventId: string, atMs: number): EventState {
    let s = this.#events.get(eventId);
    if (!s) {
      s = { eventId, interestAtMs: atMs, bucketRows: [], bucketsReadOnce: false, history: [], tradeGap: false };
      this.#events.set(eventId, s);
    }
    s.interestAtMs = Math.max(s.interestAtMs, atMs);
    return s;
  }

  #watched(now: number): EventState[] {
    return [...this.#events.values()].filter((s) => now - s.interestAtMs < this.#o.watchMs);
  }

  /** 주기 두 번 안에 읽은 값이 있는가(주기가 도는 동안은 바로 읽지 않는다) */
  #recent(s: EventState, now: number): boolean {
    return s.readAtMs !== undefined && now - s.readAtMs <= this.#o.pollMs * 2;
  }

  async #timed<T>(view: RtView, run: () => Promise<T>): Promise<T> {
    const t0 = this.#mono();
    try {
      const v = await run();
      this.#signals?.query(view, (this.#mono() - t0) / 1_000, true);
      return v;
    } catch (e) {
      this.#signals?.query(view, (this.#mono() - t0) / 1_000, false);
      throw e;
    }
  }

  async #readFreshness(): Promise<void> {
    try {
      const rows = await this.#timed('v_freshness', () => this.#source.freshness());
      this.#pulseRows = rows;
      this.#pulse = pulseAsOf(this.#expected, rows);
      this.#pulseReadOnce = true;
    } catch {
      // 마지막으로 읽은 박동 행을 그대로 둔다: 지금 시각이 흐르므로 신선도가 나빠진다
    }
  }

  /** 회차 하나를 읽는다. 같은 회차를 읽는 중이면 그 읽기를 나눠 기다린다. 누적이 실패하면 던진다(1초 칸·기준 자료 실패는 지난 값을 둔다) */
  #read(s: EventState): Promise<void> {
    if (s.reading) return s.reading;
    const run = async () => {
      // 시작 직후 첫 바퀴 전에 화면이 먼저 물으면 박동부터 읽는다(그 회차 값의 신선도가 '모름'으로 튀지 않게)
      if (!this.#pulseReadOnce) await this.#readFreshness();
      const startedAt = this.#now();
      const asOfAtStart = this.#pulse.asOfMs;
      const seatDue = s.seatMapReadAtMs === undefined || startedAt - s.seatMapReadAtMs >= this.#o.seatMapRefreshMs;
      const fromMs = Math.floor(startedAt / 1_000) * 1_000 - this.#o.bucketLookbackMs;
      const [cum, buckets, seat] = await Promise.allSettled([
        this.#timed('v_cumulative', () => this.#source.cumulative(s.eventId)),
        this.#timed('v_bucket', () => this.#source.buckets(s.eventId, fromMs)),
        seatDue ? this.#timed('seat_map', () => this.#seatMaps.seatMap(s.eventId)) : Promise.resolve(undefined),
      ]);
      if (seatDue) {
        s.seatMapReadAtMs = startedAt;
        // 읽지 못하면 지난 값을 그대로 둔다(처음이면 모름)
        if (seat.status === 'fulfilled' && seat.value !== undefined) s.seatMap = seatMapOf(seat.value);
      }
      if (buckets.status === 'fulfilled') {
        s.bucketRows = buckets.value;
        s.bucketAsOfMs = asOfAtStart;
        s.bucketsReadOnce = true;
      }
      if (cum.status === 'rejected') throw cum.reason instanceof RtSourceFailure ? cum.reason : new RtSourceFailure('rt cumulative read failed');
      const cumulative = cumulativeOf(cum.value);
      s.cumulative = cumulative;
      s.readAtMs = startedAt;
      s.dataAsOfMs = asOfAtStart;
      s.history = recordMinute(s.history, startedAt, cumulative.soldSeats);
    };
    s.reading = run().finally(() => {
      s.reading = undefined;
    });
    return s.reading;
  }

  /** 회차 값의 신선도: 그 회차를 마지막으로 읽었을 때의 박동 기준 시각에서 잰다(한 번도 못 읽었으면 모름) */
  #eventFreshness(s: EventState, now: number): Freshness {
    const cum = freshnessOf(now, s.readAtMs === undefined ? undefined : s.dataAsOfMs);
    const bucket = freshnessOf(now, s.bucketsReadOnce ? s.bucketAsOfMs : undefined);
    const bucketSeconds = bucket.bucketSeconds;
    return { cumulativeSeconds: cum.cumulativeSeconds, bucketSeconds, headSeconds: Math.max(cum.cumulativeSeconds, bucketSeconds) };
  }

  /** 보드 전체의 신선도: 박동 기준과 관심 회차마다의 값 가운데 길마다 나쁜 쪽 */
  #boardFreshness(now: number, watched: readonly EventState[]): Freshness {
    let f = freshnessOf(now, this.#pulse.asOfMs);
    for (const s of watched) f = worseFreshness(f, this.#eventFreshness(s, now));
    return f;
  }

  #evaluate(now: number, watched: readonly EventState[]): void {
    const f = this.#boardFreshness(now, watched);
    this.#signals?.freshness('cumulative', f.cumulativeSeconds);
    this.#signals?.freshness('bucket', f.bucketSeconds);
    this.#samples.push({ atMs: now, seconds: f.headSeconds });
    this.#samples = this.#samples.filter((x) => x.atMs > now - FRESHNESS_WINDOW_MS);
    const p95 = percentile(
      this.#samples.map((x) => x.seconds),
      0.95,
    )!;
    const before = this.#degraded.degraded;
    this.#degraded = nextDegraded(this.#degraded, now, p95);
    if (this.#degraded.degraded !== before) {
      this.#log?.warn(
        { event: this.#degraded.degraded ? 'rt-degraded' : 'rt-recovered', p95Seconds: p95, stalest: this.#pulse.stalest ?? null },
        this.#degraded.degraded ? '실시간 표 신선도 p95가 5초를 3분 넘게 넘어 Degraded로 바꾼다' : '실시간 표 신선도 p95가 5분 동안 5초 미만이라 되돌린다',
      );
    }
    let gaps = 0;
    for (const s of watched) {
      const gap = s.cumulative ? tradeGapOf(now, s.cumulative.lastTradeLoadedMs) : false;
      if (gap !== s.tradeGap) {
        this.#log?.warn({ event: gap ? 'rt-trade-gap' : 'rt-trade-gap-cleared', eventId: s.eventId }, gap ? '판매 중 회차의 거래 사건이 60초 넘게 끊겼다' : '거래 사건이 다시 들어온다');
        s.tradeGap = gap;
      }
      if (gap) gaps += 1;
    }
    this.#signals?.state({ degraded: this.#degraded.degraded, tradeGapEvents: gaps, watchedEvents: watched.length });
  }
}
