// 1초 만료 반복(docs/features/seat-hold.md §5 '운영 만료 Lua와 1초 반복'·'1초 반복과 회차별 임대', BUILD_ORDER PRF-135, FR-042, POL-012, NFR-025).
// 모든 파드가 1초마다 좌석 비트맵이 있는 회차 목록(s:ctl:events)을 읽고, 회차마다 만료 임대 s:{event:E}:sweep을 잡은 파드만 그 회차의 만료를 돌린다.
// 한 회차는 만료 인덱스 앞줄 100석씩(1단계 읽기 → 좌석맵 판 → 2단계 만료 Lua) 한 틱에 20묶음 [가정]까지 돌고, 회차는 4개 [가정]까지 동시에 돈다.
// 시각은 주입 Clock, 반복은 주입 타이머다(시험은 tick()을 손으로 부른다). 운영 조립은 InventoryModule(redis)·main.ts가 한다(시작 때 start, SIGTERM 때 stop).
import type { Clock, PlatformLogger } from '@peaket/platform';
import {
  EXPIRY_BACKOFF_MS,
  EXPIRY_BATCH_SIZE,
  EXPIRY_CONCURRENCY,
  EXPIRY_MAX_BATCHES_PER_TICK,
  EXPIRY_TICK_MS,
  type ExpireResult,
  type ExpireSeat,
  SWEEP_LEASE_TTL_MS,
  type SweepOutcome,
} from '../domain/expiry.js';
import { type EventPauseState, EXPIRY_MAX_OFFSET_PER_TICK, FREEZE_BATCH_SIZE, FREEZE_MAX_BATCHES_PER_TICK, type HoldFreezeResult, type HoldLifecycle } from '../domain/hold-lifecycle.js';
import { KEEP_AFTER_SALE_END_MS, SeatStoreUnavailable } from '../domain/hold.js';
import { type SeatKeyKind, type SeatLuaErrorCode, seatLuaErrorOf } from '../domain/lua-errors.js';
import { noSeatSignals, type SeatExpiries, type SeatMap, type SeatMapIndex, type SeatSignals, type SweepLeases } from '../domain/ports.js';
import type { HoldPauseView } from './hold-pause-view.js';
import { LogGate } from './log-gate.js';

export type { SweepOutcome } from '../domain/expiry.js';

/** 반복 타이머(주입. 시험은 손으로 틱하고 이것을 쓰지 않거나 가짜를 넣는다) */
export interface SweepTimer {
  /**
   * everyMs마다 run을 부른다(첫 부름은 everyMs 뒤). run이 돌려준 약속은 기다리지 않는다(겹침은 ExpirySweeper.tick이 막는다).
   * @returns 멈추기(부른 뒤로는 run을 더 부르지 않는다. 두 번 불러도 된다)
   */
  every(everyMs: number, run: () => void): { cancel(): void };
}

/** 시스템 타이머(setInterval, 프로세스 종료를 막지 않게 unref). 운영 조립의 기본값 */
export const systemSweepTimer: SweepTimer = {
  every(everyMs, run) {
    const t = setInterval(run, everyMs);
    t.unref();
    return { cancel: () => clearInterval(t) };
  },
};

/** 회차 하나의 틱 결과 */
export interface SweepEventReport {
  eventId: string;
  outcome: SweepOutcome;
  /** 끝까지 돌아 결과를 받은 만료 Lua(SeatExpiries.expire) 수(0 ~ 20) */
  batches: number;
  /** 이번 틱에 그 회차에서 푼 좌석·건너뛴 좌석·고아 수(만료 Lua 결과의 합) */
  released: number;
  skipped: number;
  orphans: number;
  /** 좌석맵 판에 없는 색인이라 좌석 칸 없이(빈 글로) 넘긴 홀드 수(합) */
  unknownSeats: number;
  /**
   * 망가진 좌석 수(합, 추천 적용 2026-11-04 M2): 1단계의 corrupt: true와 색인 ≥ 회차 좌석 수(L7, 만료 Lua에 넘기지 않음),
   * 만료 Lua 결과의 corrupt(좌석·계정·구역 몫의 망가짐). 건드리지 않아 만료 인덱스에 남는다
   */
  corrupt: number;
}

/** tick()의 결과 */
export interface SweepTickReport {
  /** 앞 틱이 아직 돌고 있어 이번 틱을 건너뛰었다(아무것도 부르지 않았다) */
  overlapped: boolean;
  /** 회차 목록(saleEvents)을 읽지 못했다(그 까닭. 읽었으면 없다) */
  listFailed?: 'UNAVAILABLE' | 'ERROR';
  /** 이번 틱에 손댄 회차마다(회차 ID 문자 코드 순). stop()으로 시작하지 않은 회차는 싣지 않는다 */
  events: SweepEventReport[];
}

export interface ExpirySweeperDeps {
  /** 만료 저장소(RedisSeatStore·MemorySeatStore) */
  expiries: SeatExpiries;
  /** 좌석맵 판(config로 판매 종료 시각·좌석 수, byIndex로 좌석 정보) */
  seatMap: SeatMap & SeatMapIndex;
  /** 회차별 만료 임대 */
  leases: SweepLeases;
  clock: Clock;
  /** 이 파드의 ID(임대 값, KEY_PART 모양. 운영은 podIdFrom(process.env, randomBytes)) */
  podId: string;
  /** 반복 타이머(기본 systemSweepTimer) */
  timer?: SweepTimer;
  /** 좌석 Lua·만료 반복 지표(기본 noSeatSignals) */
  signals?: SeatSignals;
  /** 오류·경고 기록. 키 이름·오류 글·err 객체를 싣지 않는다(계정 ID가 든 키 이름이 있을 수 있다, ASVS 16.2.5) */
  logger?: PlatformLogger;
  /** 메모리 부족 경고 문(파드마다 1초에 한 줄, L6). 기본은 clock으로 만든 이 반복만의 문이다(운영은 받는 층과 나눈다) */
  oomWarnGate?: LogGate;
  /**
   * 만료로 푼 홀드를 알리는 고리(BUILD_ORDER PRF-172 설계 2, booking OrderExpiry.onHoldsExpired를 잇는다, docs/features/seat-hold.md §5). 만료 Lua 묶음마다 푼 좌석이 있을 때 한 번 부른다. 던져도 만료 반복은 그대로다(경고 한 줄). 없으면 부르지 않는다.
   * holdIds는 같은 holdId를 한 번만 싣는다. 만료 Lua 답(ExpiredHold)에는 holdId가 없어, 푼 좌석의 색인으로 넘긴 ExpireSeat.expected.holdId에서 얻는다
   */
  onHoldsExpired?: (e: { readonly eventId: string; readonly holdIds: readonly string[] }) => void;
  /** 새 결제 일시 정지 판단(BUILD_ORDER HOT-070). lifecycle과 함께 있을 때만 멈추고 되돌린다 */
  pauseView?: Pick<HoldPauseView, 'refresh'>;
  /** 옮기기·되돌리기 저장소(BUILD_ORDER HOT-070) */
  lifecycle?: Pick<HoldLifecycle, 'orderedPage' | 'frozenPage' | 'frozenCount' | 'freeze' | 'thaw'>;
}

/** 로그 한 줄의 첫 인자(계정 ID가 든 키 이름·오류 글은 싣지 않는다) */
export interface SweepLogFields {
  /** 회차 목록 읽기에서 났으면 없다 */
  eventId?: string;
  /** 어디서 났는가: 회차 목록·임대·좌석맵 판(config·byIndex)·1단계 읽기·만료 Lua, 'loop'는 타이머가 부른 반복이 틱 밖에서 거부된 것(C2), 'hook'은 주문 만료 고리가 던진 것 */
  step: SweepStep;
  /** 오류의 갈래(seatLuaErrorOf(err)?.code). 판에 없는 색인 기록에는 없다 */
  code?: SeatLuaErrorCode;
  /** CORRUPT_KEY일 때 키 종류 */
  keyKind?: SeatKeyKind;
  /** 판에 없는 색인이라 좌석 칸 없이 넘긴 홀드 수(step 'seatmap'일 때만) */
  unknownSeats?: number;
  /** 그 묶음의 망가진 좌석 수(warn, M2) */
  corrupt?: number;
  /** 메모리 부족 경고(warn, L6) */
  seatStoreReason?: 'oom';
}

type SweepStep = 'list' | 'lease' | 'seatmap' | 'due' | 'expire' | 'loop' | 'hook' | 'freeze';

/** 회차 ID 문자 코드 순(Array.prototype.sort 기본과 같다) */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 1초 만료 반복. 생성자는 deps를 받기만 한다(아무것도 부르지 않는다).
 */
export class ExpirySweeper {
  #running: Promise<SweepTickReport> | undefined;
  #timer: { cancel(): void } | undefined;
  /** stop()이 불린 수(멈춤 표시). 틱·반복은 시작할 때의 값과 달라지면 멈춘다(L4) */
  #stops = 0;
  /** 직전 틱에서 UNAVAILABLE·ERROR였던 회차 → 그 시각(M5) */
  readonly #failedAt = new Map<string, number>();
  readonly #oomGate: LogGate;

  constructor(private readonly deps: ExpirySweeperDeps) {
    this.#oomGate = deps.oomWarnGate ?? new LogGate(deps.clock);
  }

  /**
   * 한 틱을 돈다. 던지지 않는다(모든 오류는 회차별 outcome·지표·로그로 남긴다).
   *
   * 차례:
   * 1. 앞 tick()이 아직 끝나지 않았으면 아무것도 부르지 않고 { overlapped: true, events: [] }.
   * 2. expiries.saleEvents()로 회차 목록을 읽는다(KEY_PART 모양만 온다, L8). 실패하면 { overlapped: false, listFailed: SeatStoreUnavailable이면
   *    'UNAVAILABLE' 아니면 'ERROR', events: [] }('ERROR'면 logger.error({ step: 'list', code }) 한 번).
   * 3. 회차를 회차 ID 문자 코드 순으로 꺼내 EXPIRY_CONCURRENCY(4) [가정]개까지 동시에 돈다(M5). 한 회차의 실패는 다른 회차를 막지 않는다.
   *    stop()이 불렸으면 아직 시작하지 않은 회차는 꺼내지 않는다(임대도 잡지 않는다, L4).
   *    a. 직전 틱에서 UNAVAILABLE·ERROR였고(1단계 읽기 실패 포함) 그때부터 EXPIRY_BACKOFF_MS(5초) [가정]가 지나지 않았으면 BACKOFF(아무것도 부르지 않는다).
   *       NO_CONFIG·NOT_LEASED·NOT_READY는 쉬지 않는다. 다른 결과로 끝나면 쉬는 표시를 지운다.
   *    b. seatMap.config(eventId)가 없으면 NO_CONFIG(임대 키를 쓰지 않는다, L3). keepUntilMs = saleEndsAtMs + KEEP_AFTER_SALE_END_MS.
   *    c. leases.acquire(eventId, podId, SWEEP_LEASE_TTL_MS(3000)). false면 NOT_LEASED(만료 저장소를 부르지 않는다).
   *       잡은 파드는 틱마다 다시 불러 수명을 늘린다(내 것이면 PEXPIRE).
   *    d. 묶음을 최대 EXPIRY_MAX_BATCHES_PER_TICK(20)번 되풀이한다. 묶음을 시작하기 전마다 stop()을 보고, 불렸으면 STOPPED(돌던 묶음은 마친다, L4):
   *       - due = expiries.dueExpiries({ eventId, nowMs: clock.now()(묶음마다 새로 읽음), limit: EXPIRY_BATCH_SIZE(100) }). 비었으면 DRAINED(batches 그대로).
   *         첫 읽기의 맨 앞 점수로 그 회차의 밀림(nowMs − due[0].expiresAtMs, 초, 비었으면 0)을 잰다(M1).
   *       - due 가운데 corrupt: true와 색인 ≥ config.seatCount(L7)는 만료 Lua에 넘기지 않고 corrupt로 센다(M2).
   *       - 남은 것 가운데 hold가 null(고아)이 아닌 좌석의 색인으로 seatMap.byIndex를 한 번 부른다(그런 좌석이 없으면 부르지 않는다). undefined인 좌석
   *         (좌석 수 안의 판에 없는 색인)은 멈추지 않고 seat 없이 기대값만 넘겨 그대로 푼다(EXPIRED의 좌석 칸은 빈 글, 그 좌석 몫의 secver·샤드 Pub/Sub 없음).
   *         그런 좌석 수를 unknownSeats에 더하고, 그 묶음에 하나라도 있으면 logger.error({ eventId, step: 'seatmap', unknownSeats: 그 수 }) 한 번
   *         (Lua 오류가 아니라 seat_lua_errors_total에는 세지 않는다). 고아는 seat 없이 expected = null로 넘긴다.
   *       - 넘길 좌석이 있으면 r = expiries.expire({ eventId, keepUntilMs, seats: due 차례 그대로 }). batches += 1.
   *         NOT_READY면 signals.luaError('expire', 'NOT_READY') 한 번 뒤 NOT_READY. OK면 released·skipped·orphans를 더하고 r.corrupt를 그 묶음의 corrupt에 더한다.
   *       - 그 묶음의 corrupt(1단계·L7 몫 포함)가 1 이상이면 signals.luaError('expire', 'CORRUPT_KEY') 한 번(묶음마다, 좌석마다가 아니다)과
   *         logger.warn({ eventId, step: 'expire', code: 'CORRUPT_KEY', corrupt }) 한 번. 망가진 좌석은 ERROR가 아니다.
   *       - 그 묶음에서 푼 것·고아가 0이면(넘길 좌석이 없었던 것 포함) NO_PROGRESS. due.length < 100이면 DRAINED. 20번째 묶음까지 돌았으면 BATCH_LIMIT.
   *    e. a~d의 오류: SeatStoreUnavailable이면 UNAVAILABLE(expire에서 났고 reason 'oom'이면 signals.luaError('expire', 'OOM') 한 번. 임대·1단계 읽기의
   *       오류는 Lua 오류가 아니라 세지 않는다). reason 'oom'이면 어디서 났든 경고 로그 { eventId, step, seatStoreReason: 'oom' }를 남기되
   *       oomWarnGate로 파드마다 1초에 한 줄까지다(L6). 그 밖의 오류는 ERROR이고, logger.error({ eventId, step, code: seatLuaErrorOf(err)?.code, keyKind }) 한 번,
   *       expire에서 났으면 signals.luaError('expire', 그 code)도 한 번(키 전체가 망가진 묶음 전체 오류가 여기다). 오류 뒤에는 그 회차를 이번 틱에서 멈춘다
   *       (앞서 푼 수는 보고에 남는다).
   * 4. 지표(M1): 회차 보고마다 signals.expiryTick(outcome) 한 번, signals.expiryLag(이번 틱에 1단계를 읽은 회차들의 밀림 최댓값, 없으면 0) 한 번.
   * 5. { overlapped: false, events }를 돌려준다.
   *
   * 한 틱이 임대 수명(3초)보다 오래 걸려 다른 파드가 같은 회차를 돌아도 만료 Lua의 펜싱 확인이 같은 홀드를 두 번 풀지 않는다(뒤 파드는 건너뜀으로 센다).
   */
  tick(): Promise<SweepTickReport> {
    if (this.#running) return Promise.resolve({ overlapped: true, events: [] });
    const p: Promise<SweepTickReport> = this.#tick(this.#stops).finally(() => {
      if (this.#running === p) this.#running = undefined;
    });
    this.#running = p;
    return p;
  }

  /**
   * 반복을 켠다: deps.timer(기본 systemSweepTimer).every(EXPIRY_TICK_MS(1000), …). 이미 켰으면 아무것도 하지 않는다(타이머를 하나만 건다).
   * tick()을 바로 부르지 않는다(첫 틱은 1초 뒤). 타이머가 부른 틱에서 어떤 회차든 BATCH_LIMIT에 닿으면 1초를 기다리지 않고 다음 틱을 바로 연다
   * (묶음 상한은 틱마다 그대로 20, 추천 적용 2026-11-04 M1). stop()이 불렸으면 새 틱을 열지 않는다
   */
  start(): void {
    if (this.#timer) return;
    this.#timer = (this.deps.timer ?? systemSweepTimer).every(EXPIRY_TICK_MS, () => void this.#loop());
  }

  /**
   * 반복을 끈다: 멈춤 표시를 세우고 타이머를 멈추고, 돌고 있는 틱이 있으면 끝날 때까지 기다린다. 돌던 틱은 묶음·회차 사이에서 멈춤 표시를 보고
   * 돌던 묶음만 마친 뒤 멈춘다(L4). 켜지 않았으면 바로 끝난다. 두 번 불러도 된다. 임대는 놓지 않는다(SWEEP_LEASE_TTL_MS 뒤 저절로 풀린다).
   * 끈 뒤 start()로 다시 켤 수 있다(그 뒤의 틱은 멈추지 않는다)
   */
  async stop(): Promise<void> {
    this.#stops += 1;
    const t = this.#timer;
    this.#timer = undefined;
    t?.cancel();
    await this.#running?.catch(() => undefined);
  }

  /**
   * 타이머가 부르는 반복: BATCH_LIMIT이 있으면 멈춤 표시가 서기 전까지 다음 틱을 바로 잇는다(M1).
   * tick()은 던지지 않게 만들었지만, 타이머는 이 약속을 기다리지 않아 거부되면 처리되지 않은 거부가 된다. 그래서 여기서 한 번 더 막는다(C2, 추천 적용 2026-11-04):
   * 오류는 code·키 종류만 로그에 남기고(계정 ID가 든 키 이름·오류 글·오류 객체는 싣지 않는다, ASVS 16.2.5) 이번 반복만 멈춘다. 다음 타이머 부름이 다음 틱을 연다
   */
  async #loop(): Promise<void> {
    const stops = this.#stops;
    try {
      for (;;) {
        const r = await this.tick();
        if (r.overlapped || stops !== this.#stops) return;
        if (!r.events.some((e) => e.outcome === 'BATCH_LIMIT')) return;
      }
    } catch (err) {
      this.#log('error', { step: 'loop', ...this.#codeOf(err) }, '만료 반복이 틱 밖에서 오류를 만나 이번 반복을 멈췄다');
    }
  }

  async #tick(stops: number): Promise<SweepTickReport> {
    const stopped = () => stops !== this.#stops;
    let list: string[];
    try {
      list = await this.deps.expiries.saleEvents();
    } catch (err) {
      if (err instanceof SeatStoreUnavailable) return { overlapped: false, listFailed: 'UNAVAILABLE', events: [] };
      this.#log('error', { step: 'list', ...this.#codeOf(err) }, '만료 반복이 회차 목록을 읽지 못했다');
      return { overlapped: false, listFailed: 'ERROR', events: [] };
    }
    const ids = [...new Set(list)].sort(byCodeUnit);
    const reports = new Map<string, SweepEventReport>();
    const lags: number[] = [];
    const frozen: number[] = [];
    // 정지 판단은 틱마다 한 번이다(던지지 않는다). 조회 실패는 HoldPauseView가 마지막 답·10초 규칙으로 흡수한다
    const pauses = this.deps.pauseView ? await this.deps.pauseView.refresh(ids) : undefined;
    let next = 0;
    const lane = async () => {
      while (next < ids.length && !stopped()) {
        const eventId = ids[next++]!;
        reports.set(eventId, await this.#sweepEvent(eventId, stopped, lags, frozen, pauses?.get(eventId)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXPIRY_CONCURRENCY, ids.length) }, lane));
    const events = ids.filter((id) => reports.has(id)).map((id) => reports.get(id)!);
    const signals = this.deps.signals ?? noSeatSignals;
    for (const e of events) signals.expiryTick?.(e.outcome);
    signals.expiryLag?.(lags.length > 0 ? Math.max(...lags) : 0);
    if (this.deps.lifecycle && pauses) signals.frozenHolds?.(frozen.reduce((n, x) => n + x, 0));
    return { overlapped: false, events };
  }

  /** 회차 하나를 이번 틱에 돈다(던지지 않는다). 첫 1단계 읽기의 밀림(초)을 lags에 더한다 */
  async #sweepEvent(eventId: string, stopped: () => boolean, lags: number[], frozen: number[], pause?: EventPauseState): Promise<SweepEventReport> {
    const { expiries, seatMap, leases, clock, podId } = this.deps;
    const signals = this.deps.signals ?? noSeatSignals;
    const report: SweepEventReport = { eventId, outcome: 'DRAINED', batches: 0, released: 0, skipped: 0, orphans: 0, unknownSeats: 0, corrupt: 0 };
    const failedAt = this.#failedAt.get(eventId);
    if (failedAt !== undefined && clock.now() < failedAt + EXPIRY_BACKOFF_MS) return { ...report, outcome: 'BACKOFF' };
    const done = (outcome: SweepOutcome): SweepEventReport => {
      if (outcome === 'UNAVAILABLE' || outcome === 'ERROR') this.#failedAt.set(eventId, clock.now());
      else this.#failedAt.delete(eventId);
      return { ...report, outcome };
    };
    let step: SweepStep = 'seatmap';
    try {
      // 회차 설정을 임대보다 먼저 본다(설정이 없는 회차의 임대 키를 쓰지 않는다, L3)
      const config = await seatMap.config(eventId);
      if (!config) return done('NO_CONFIG');
      step = 'lease';
      if (!(await leases.acquire(eventId, podId, SWEEP_LEASE_TTL_MS))) return done('NOT_LEASED');
      const keepUntilMs = config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS;
      // 결제 정지 옮기기·되돌리기(BUILD_ORDER HOT-070). 만료보다 먼저 해 이번 틱의 회수에 반영한다
      let pausedSinceMs: number | undefined;
      if (pause && this.deps.lifecycle) {
        // 옮기기·되돌리기의 실패가 이 회차의 만료 회수까지 멈추지 않게 따로 받는다(L5). 다음 틱이 다시 한다
        try {
          await this.#settleFrozen(eventId, pause, keepUntilMs);
        } catch (err) {
          this.#log('warn', { eventId, step: 'freeze', ...this.#codeOf(err) }, '결제 정지 옮기기·되돌리기가 이번 틱에 실패했다');
        }
        // 정지 중이거나 아직 판단하지 못한 틱은 주문 뒤 홀드를 건너뛴다(UNSETTLED는 정지 시작을 모르므로 0이다. 조회가 멈춘 동안 풀어 버리지 않게, L8)
        if (pause.kind === 'PAUSED') pausedSinceMs = pause.sinceMs;
        else if (pause.kind === 'UNSETTLED') pausedSinceMs = 0;
        // 이 파드가 임대를 잡은 회차만 센다(§5 지표 뜻, L9)
        try {
          frozen.push(await this.deps.lifecycle.frozenCount(eventId));
        } catch {
          // 게이지만 비는다
        }
      }
      let first = true;
      /** 이번 틱에서 풀지 못하고 앞줄에 남긴 좌석 수(ADR-0254 결정 6) */
      let offset = 0;
      while (report.batches < EXPIRY_MAX_BATCHES_PER_TICK) {
        if (stopped()) return done('STOPPED');
        step = 'due';
        const nowMs = clock.now();
        const due = await expiries.dueExpiries({ eventId, nowMs, limit: EXPIRY_BATCH_SIZE, ...(offset > 0 ? { offset } : {}) });
        if (first) {
          first = false;
          lags.push(due.length > 0 ? Math.max(0, nowMs - due[0]!.expiresAtMs) / 1000 : 0);
        }
        if (due.length === 0) return done('DRAINED');

        // 1단계의 망가진 좌석(corrupt: true)과 회차 좌석 수 밖의 색인(L7)은 넘기지 않는다(M2)
        let corrupt = 0;
        const usable = due.filter((d) => {
          if (d.corrupt || d.index >= config.seatCount) {
            corrupt += 1;
            return false;
          }
          return true;
        });

        // 좌석맵 판의 '색인 → 좌석'(고아는 묻지 않는다)
        step = 'seatmap';
        const held = usable.filter((d) => d.hold !== null);
        const refs = held.length > 0 ? await seatMap.byIndex(eventId, held.map((d) => d.index)) : [];
        const seatOf = new Map(held.map((d, k) => [d.index, refs[k]]));
        let unknown = 0;
        const seats: ExpireSeat[] = usable.map((d) => {
          if (!d.hold) return { index: d.index, expected: null };
          const seat = seatOf.get(d.index);
          if (!seat) {
            unknown += 1;
            return { index: d.index, expected: d.hold };
          }
          return { index: d.index, expected: d.hold, seat };
        });
        if (unknown > 0) {
          report.unknownSeats += unknown;
          this.#log('error', { eventId, step: 'seatmap', unknownSeats: unknown }, '좌석맵 판에 없는 색인의 홀드를 좌석 칸 없이 풀었다');
        }

        let r: Extract<ExpireResult, { kind: 'OK' }> | undefined;
        if (seats.length > 0) {
          step = 'expire';
          const out = await expiries.expire({ eventId, keepUntilMs, seats, ...(pausedSinceMs !== undefined ? { pausedSinceMs } : {}) });
          report.batches += 1;
          if (out.kind === 'NOT_READY') {
            signals.luaError('expire', 'NOT_READY');
            this.#countCorrupt(report, eventId, corrupt, signals);
            return done('NOT_READY');
          }
          r = out;
          report.released += r.released;
          report.skipped += r.skipped;
          report.orphans += r.orphans;
          corrupt += r.corrupt;
          this.#notifyHoldsExpired(eventId, seats, r);
        }
        this.#countCorrupt(report, eventId, corrupt, signals);
        if (!r || r.released + r.orphans === 0) {
          // 묶음이 꽉 찼는데 하나도 풀지 못했으면 다음 쪽을 읽는다(앞줄의 망가진 좌석이 뒤를 막지 않게, ADR-0254 결정 6)
          if (due.length === EXPIRY_BATCH_SIZE && offset + due.length <= EXPIRY_MAX_OFFSET_PER_TICK) {
            offset += due.length;
            continue;
          }
          return done('NO_PROGRESS');
        }
        offset = Math.min(EXPIRY_MAX_OFFSET_PER_TICK, offset + corrupt + r.skipped);
        if (due.length < EXPIRY_BATCH_SIZE) return done('DRAINED');
      }
      return done('BATCH_LIMIT');
    } catch (err) {
      if (err instanceof SeatStoreUnavailable) {
        if (err.reason === 'oom') {
          if (step === 'expire') signals.luaError('expire', 'OOM');
          if (this.#oomGate.allow()) this.#log('warn', { eventId, step, seatStoreReason: 'oom' }, '좌석 Redis 메모리 부족으로 만료를 이번 틱에 멈췄다');
        }
        return done('UNAVAILABLE');
      }
      const info = this.#codeOf(err);
      this.#log('error', { eventId, step, ...info }, '만료 반복이 그 회차를 이번 틱에서 멈췄다');
      if (step === 'expire') signals.luaError('expire', info.code);
      return done('ERROR');
    }
  }

  /** 정지면 ordered를 옮기고 최대 체류에 닿은 것을 돌려놓고, 열렸으면 paused를 되돌린다. 오류는 부른 쪽(회차 하나의 ERROR·UNAVAILABLE)로 간다 */
  async #settleFrozen(eventId: string, pause: EventPauseState, keepUntilMs: number): Promise<void> {
    const life = this.deps.lifecycle!;
    const run = async (op: 'freeze' | 'thaw', page: () => Promise<{ indexes: number[] }>, apply: (indexes: number[]) => Promise<HoldFreezeResult>): Promise<void> => {
      for (let b = 0; b < FREEZE_MAX_BATCHES_PER_TICK; b++) {
        const { indexes } = await page();
        if (indexes.length === 0) return;
        const started = this.deps.clock.monotonicMs();
        const r = await apply(indexes);
        if (r.kind !== 'OK') return;
        (this.deps.signals ?? noSeatSignals).holdFreezeBatch?.(op, r, Math.max(0, this.deps.clock.monotonicMs() - started) / 1000);
        if (indexes.length < FREEZE_BATCH_SIZE) return;
      }
    };
    if (pause.kind === 'PAUSED') {
      await run('freeze', () => life.orderedPage(eventId, FREEZE_BATCH_SIZE), (i) => life.freeze(eventId, pause.sinceMs, keepUntilMs, i));
      await run('thaw', () => life.frozenPage(eventId, FREEZE_BATCH_SIZE, this.deps.clock.now()), (i) => life.thaw(eventId, keepUntilMs, i));
    } else if (pause.kind === 'OPEN') {
      await run('thaw', () => life.frozenPage(eventId, FREEZE_BATCH_SIZE), (i) => life.thaw(eventId, keepUntilMs, i));
    }
  }

  /**
   * 그 묶음에서 푼 좌석의 holdId(같은 holdId는 한 번)를 주문 만료 고리로 넘긴다. 고리가 던져도 반복은 그대로다(경고 한 줄).
   * 구현에서 정한 것: 만료 Lua 묶음마다 부른다(틱 끝까지 모으지 않는다. 한 홀드의 좌석이 두 묶음에 나뉘면 두 번 불리지만 판정은 멱등이고 뒤의 부름이 만료를 끝낸다)
   */
  #notifyHoldsExpired(eventId: string, seats: readonly ExpireSeat[], r: Extract<ExpireResult, { kind: 'OK' }>): void {
    const hook = this.deps.onHoldsExpired;
    if (!hook || r.expired.length === 0) return;
    const released = new Set(r.expired.map((x) => x.index));
    const holdIds = new Set<string>();
    for (const s of seats) if (s.expected && released.has(s.index)) holdIds.add(s.expected.holdId);
    if (holdIds.size === 0) return;
    try {
      hook({ eventId, holdIds: [...holdIds] });
    } catch (err) {
      this.#log('warn', { eventId, step: 'hook', ...this.#codeOf(err) }, '주문 만료 고리 실패(안전망이 받친다)');
    }
  }

  /** 그 묶음의 망가진 좌석 수를 보고에 더하고, 1 이상이면 지표 {expire, CORRUPT_KEY} 한 번과 경고 한 줄(M2) */
  #countCorrupt(report: SweepEventReport, eventId: string, corrupt: number, signals: SeatSignals): void {
    if (corrupt === 0) return;
    report.corrupt += corrupt;
    signals.luaError('expire', 'CORRUPT_KEY');
    this.#log('warn', { eventId, step: 'expire', code: 'CORRUPT_KEY', corrupt }, '망가진 좌석을 건너뛰고 나머지를 풀었다');
  }

  /** 오류의 갈래(code와 CORRUPT_KEY일 때 키 종류만. 오류 글은 싣지 않는다) */
  #codeOf(err: unknown): { code: SeatLuaErrorCode; keyKind?: SeatKeyKind } {
    const info = seatLuaErrorOf(err) ?? { code: 'OTHER' as const };
    return info.keyKind ? { code: info.code, keyKind: info.keyKind } : { code: info.code };
  }

  #log(level: 'error' | 'warn', fields: SweepLogFields, message: string): void {
    this.deps.logger?.[level](fields, message);
  }
}
