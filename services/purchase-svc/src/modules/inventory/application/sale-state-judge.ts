// 회차 판매 상태 판정 반복(docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122, ADR-0214 결정 2·3, ADR-0219 결정 5·6, BUILD_ORDER PRF-144, S-T25).
// 모든 파드가 1초 [가정]마다 좌석 비트맵이 있는 회차 목록(s:ctl:events)을 읽고, 회차마다 임대 s:{event:E}:salesweep을 잡은 파드만 그 회차를 판정한다(ExpirySweeper와 같은 꼴).
// 시각은 주입 Clock, 반복은 주입 타이머다(시험은 tick()을 손으로 부른다). 운영 조립(전용 일반 풀 purchase-svc-sale-state, 시작 때 start, SIGTERM 때 stop)은 main.ts가 한다.
// 구현에서 정한 것(정본에 없다):
// - 임대를 다른 파드가 잡고 있으면 이 파드의 그 회차 메모를 지운다(나중에 임대를 되찾았을 때 오래된 시각·이어짐으로 판정하지 않게).
// - 파드 메모리의 메모·평균 캐시는 회차 목록에서 사라진 회차를 틱마다 지운다.
// - 이미 SOLD_OUT인 행은 활성 판매 행을 읽지 않는다(비었는지가 판정에 쓰이지 않는다. 매진 회차에서 1초마다 큰 셈을 하지 않게).
// - 등급 홀드를 볼 후보에서 이미 soldOutTiers에 든 등급은 뺀다(다시 보지 않으므로 만료 인덱스를 끝까지 읽지 않는다).
// - 세대 키가 없거나 좌석맵 판이 없는 틱은 메모를 통째로 지운다(코드 리뷰 L7, 2026-11-09). 셈을 못 본 동안은 '이어짐'을 모르기 때문이다. 그래서 가용 0이 시작된 시각도 지운다(그만큼 ALL_HELD가 늦을 뿐이다).
//   좌석 Redis·DB 오류로 실패한 틱은 다르다: 두 번 이어짐만 끊고 가용 0 시각은 둔다(한 번의 일시 장애로 5초를 처음부터 다시 재지 않게).
import type { Clock, PlatformLogger } from '@peaket/platform';
import { SWEEP_LEASE_TTL_MS } from '../domain/expiry.js';
import { SeatStoreUnavailable } from '../domain/hold.js';
import { seatLuaErrorOf } from '../domain/lua-errors.js';
import { type EventSaleStore, noSaleStateSignals, type SaleCountsReader, type SalePayingSeats, type SaleStateSignals, type SaleTickStage, type SeatExpiries, type SeatMap, type SeatMapTiers, type SweepLeases } from '../domain/ports.js';
import {
  AVG_CACHE_MS,
  decideSale,
  type EventSaleRow,
  NEW_SALE_MEMO,
  SALE_JUDGE_CONCURRENCY,
  SALE_REPUBLISH_MS,
  SALE_TICK_MS,
  SALE_TIER_SCAN_PAGE,
  SALE_WARN_INTERVAL_MS,
  type SaleDecision,
  type SaleLayout,
  type SaleMemo,
  type SaleSeatCounts,
  type SaleStatus,
  type SaleTierCounts,
  tierAvailability,
} from '../domain/sale-state.js';
import { type SweepTimer, systemSweepTimer } from './expiry-sweeper.js';
import { LogGate } from './log-gate.js';

/** 회차 하나의 틱 결과 */
export type SaleTickOutcome =
  /** 임대를 다른 파드가 잡았다(판정하지 않음) */
  | 'NOT_LEASED'
  /** 좌석맵 판이 없다(쉼, skipped no_config) */
  | 'NO_CONFIG'
  /** 행이 이미 ENDED다(좌석 Redis를 부르지 않음) */
  | 'ALREADY_ENDED'
  /** 행이 없고 판매 종료가 이미 지났다(행도 사건도 만들지 않고 좌석 Redis를 부르지 않음) */
  | 'ENDED'
  /** 세대 키가 없다(쉼, skipped not_ready) */
  | 'NOT_READY'
  /** 판정이 바뀌지 않았고 다시 낼 때도 아니다(쓰지 않음) */
  | 'UNCHANGED'
  /** 행을 새로 만들어 첫 사건을 냈다 */
  | 'CREATED'
  /** 상태나 매진 등급이 바뀌어 판 번호를 올렸다 */
  | 'CHANGED'
  /** 같은 판을 다시 냈다 */
  | 'REPUBLISHED'
  /** 조건부 쓰기가 0행이다(다른 파드에 짐, 메모를 지웠다) */
  | 'LOST'
  /** 이번 틱을 쉬었다(좌석 Redis·DB 오류, 판정을 바꾸지 않음. failedStage에 단계) */
  | 'FAILED';

/** 회차 하나의 틱 보고 */
export interface SaleEventReport {
  eventId: string;
  outcome: SaleTickOutcome;
  /** 이번 틱이 끝난 뒤 행의 상태(읽었거나 쓴 때만) */
  status?: SaleStatus;
  /** 쓴 판 번호(CREATED·CHANGED·REPUBLISHED) */
  version?: number;
  /** outcome이 FAILED일 때 실패한 단계 */
  failedStage?: SaleTickStage;
  /** 활성 판매 행 수가 맞지 않아 매진 후보나 매진 풀림을 막았는가(거짓 매진 막기·매진 풀림 대조) */
  guardBlocked: boolean;
}

/** tick()의 결과 */
export interface SaleTickReport {
  /** 앞 틱이 아직 돌고 있어 이번 틱을 건너뛰었다(아무것도 부르지 않았다) */
  overlapped: boolean;
  /** 회차 목록을 읽지 못했다(그 까닭. 읽었으면 없다) */
  listFailed?: 'UNAVAILABLE' | 'ERROR';
  /** 이번 틱에 손댄 회차마다(회차 ID 문자 코드 순). stop()으로 시작하지 않은 회차는 싣지 않는다 */
  events: SaleEventReport[];
}

export interface SaleStateJudgeDeps {
  /** 회차 목록(s:ctl:events, RedisSeatStore·MemorySeatStore). 거른 값을 경고하는 일까지 그 구현을 다시 쓴다 */
  events: Pick<SeatExpiries, 'saleEvents'>;
  /** 좌석 Redis 셈 읽기 */
  counts: SaleCountsReader;
  /** 결제 중 셈(운영은 booking 모듈의 DrizzleSalePaying, main.ts가 잇는다) */
  paying: SalePayingSeats;
  /** event_sale 저장소 */
  store: EventSaleStore;
  /** 좌석맵 판(config로 판매 종료 시각, saleLayout으로 판매 대상 색인) */
  seatMap: Pick<SeatMap, 'config'> & SeatMapTiers;
  /** 회차별 임대(줄 'sale') */
  leases: SweepLeases;
  /** 지표(기본 noSaleStateSignals) */
  signals?: SaleStateSignals;
  clock: Clock;
  /** 이 파드의 ID(임대 값, KEY_PART 모양. 운영은 podIdFrom) */
  podId: string;
  /** 경고 기록. 회차 ID·실패 단계·오류 코드만 싣고 키 이름·오류 글·err 객체를 싣지 않는다(ASVS 16.2.5) */
  logger?: PlatformLogger;
  /** 반복 타이머(기본 systemSweepTimer) */
  timer?: SweepTimer;
  /** 실패 경고 문(파드마다 1분에 한 줄). 기본은 clock과 SALE_WARN_INTERVAL_MS로 만든 이 반복만의 문이다 */
  warnGate?: LogGate;
}

/** 회차 ID 문자 코드 순(Array.prototype.sort 기본과 같다) */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 로그에 실어도 되는 코드 모양(오류의 code 칸이 뜻밖의 글이어도 로그로 새지 않게) */
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** cause를 따라 내려가는 깊이 상한 */
const MAX_CAUSE_DEPTH = 5;

/**
 * 경고 줄의 코드(오류 글은 싣지 않는다, ASVS 16.2.5): 좌석 Lua의 지킴 오류·메모리 부족이면 그 갈래, 아니면 오류 또는 그 cause의 code 칸(드라이버 오류를 Drizzle이 감싼다).
 * 코드가 없으면 'UNKNOWN'
 */
function errorCodeOf(err: unknown): string {
  const lua = seatLuaErrorOf(err)?.code;
  if (lua !== undefined && lua !== 'OTHER') return lua;
  let e: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof e === 'object' && e !== null; depth += 1) {
    const { code, cause } = e as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
    e = cause;
  }
  return 'UNKNOWN';
}

/** 이번 틱에 읽은 셈 */
interface TickCounts extends SaleSeatCounts {
  tiers: SaleTierCounts[];
}

/** 틱 하나가 회차를 돌며 모으는 값 */
interface TickTally {
  /** 이 파드가 맡은 회차 가운데 ALL_HELD가 가장 오래 이어진 시간(ms, 없으면 0) */
  allHeldMs: number;
}

/**
 * 회차 판매 상태 판정. 생성자는 deps를 받기만 한다(아무것도 부르지 않는다).
 */
export class SaleStateJudge {
  #running: Promise<SaleTickReport> | undefined;
  #timer: { cancel(): void } | undefined;
  /** stop()이 불린 수(멈춤 표시). 틱은 시작할 때의 값과 달라지면 새 회차를 꺼내지 않는다 */
  #stops = 0;
  /** 회차 → 틱 사이의 메모 */
  readonly #memos = new Map<string, SaleMemo>();
  /** 회차 → 평균 구매 매수와 읽은 시각('없다'는 답도 둔다) */
  readonly #avg = new Map<string, { value: number | undefined; readAtMs: number }>();
  readonly #warnGate: LogGate;
  /** 회차 → 막힘 경고 문(회차마다 1분에 한 줄. 실패 경고 문과 따로라 다른 경고에 묻히지 않는다) */
  readonly #guardGates = new Map<string, LogGate>();

  constructor(private readonly deps: SaleStateJudgeDeps) {
    this.#warnGate = deps.warnGate ?? new LogGate(deps.clock, SALE_WARN_INTERVAL_MS);
  }

  /**
   * 한 틱을 돈다. 던지지 않는다(모든 오류는 회차별 outcome·지표·로그로 남긴다).
   *
   * 차례:
   * 1. 앞 tick()이 아직 끝나지 않았으면 signals.skipped('overlapped') 말고는 아무것도 부르지 않고 { overlapped: true, events: [] }.
   * 2. events.saleEvents()로 회차 목록을 읽는다. 실패하면 listFailed(SeatStoreUnavailable이면 'UNAVAILABLE', 아니면 'ERROR')와 빈 events이고,
   *    지표 tickFailure('lease') 한 번과 경고 문이 열릴 때 경고 한 줄을 남긴다.
   * 3. 회차를 회차 ID 문자 코드 순으로 꺼내 SALE_JUDGE_CONCURRENCY(4) [가정]개까지 동시에 돈다. 한 회차의 실패는 다른 회차를 막지 않는다.
   *    stop()이 불렸으면 아직 시작하지 않은 회차는 꺼내지 않는다(임대도 잡지 않는다).
   *    회차 하나의 차례(앞 단계가 끝내면 뒤는 부르지 않는다):
   *    a. seatMap.config와 seatMap.saleLayout. 둘 중 하나라도 없으면 NO_CONFIG(signals.skipped('no_config'), 메모를 지운다). 판이 없는 회차에 임대 키를 쓰지 않는다.
   *    b. leases.acquire(eventId, podId, SWEEP_LEASE_TTL_MS(3000), 'sale'). 거짓이면 NOT_LEASED(그 회차 메모를 지운다).
   *    c. store.read(eventId). 행이 ENDED면 ALREADY_ENDED(좌석 Redis를 부르지 않는다). 행이 없고 clock.now() ≥ 판매 종료면 ENDED(행도 사건도 만들지 않고 좌석 Redis를 부르지 않는다).
   *       행이 있고 clock.now() ≥ 판매 종료면 좌석 Redis·결제 중을 읽지 않고 행의 마지막 셈으로 ENDED를 쓴다(i의 판 올리기와 같다). 판매 종료가 셈에 묶이지 않아 세대 키가 없거나 좌석 Redis 읽기가 실패해도 끝난다.
   *    d. counts.read(eventId). NOT_READY면 NOT_READY(signals.skipped('not_ready'), 판정을 바꾸지 않는다, 메모를 지운다).
   *    e. paying.payingByTier(eventId, clock.now()). 등급별 가용은 tierAvailability(bitmap, layout.tiers)이고 회차 available은 그 합, paying은 모든 값의 합이다.
   *    f. 가용·결제 중이 0이고 행의 soldOutTiers에 들지 않은 후보 등급이 있고 held > 0이면 counts.holdIndexes(eventId, start, SALE_TIER_SCAN_PAGE)를 start 0부터 쪽마다 읽어
   *       색인을 판매 대상표로 등급에 잇고(표에 없는 색인은 무시) 본 등급을 후보에서 뺀다. 정수가 아니라 건너뛴 멤버는 signals.skipped('bad_member', 그 수)로 낸다.
   *       후보가 없어지거나 쪽이(건너뛴 멤버까지 세어) SALE_TIER_SCAN_PAGE보다 짧으면 멈춘다.
   *    g. available·held·paying이 모두 0이고 행이 SOLD_OUT이 아니면 store.activeSaleCount(eventId)를 읽어 layout.sellableSeats − available과 같을 때만 counts.empty를 참으로 한다.
   *       다르면 거짓이고 막힘 처리(signals.guardBlocked() 한 번, 보고의 guardBlocked 참, 회차마다 1분에 경고 한 줄: 회차 ID·활성 행 수·켜진 비트 수).
   *       행이 SOLD_OUT이고 available ≥ 1이면 store.activeSaleCount(eventId)를 읽어 layout.sellableSeats보다 적을 때만 풀리게 하고, 아니면 reopenBlocked와 같은 막힘 처리다.
   *    h. decideSale(지금 행, 셈, 파드 메모리의 그 회차 메모, clock.now(), config.saleEndsAtMs). 결과의 메모를 저장한다.
   *    i. 쓰기:
   *       - 행이 없으면 store.create(status ON_SALE, version 1). undefined면 LOST(메모를 지운다), 아니면 CREATED.
   *       - decision.changed면 store.applyChange(지금 판 번호 조건). undefined면 LOST(메모를 지운다), 아니면 CHANGED와 signals.transition(status)(상태가 바뀐 때만).
   *       - changed가 아니고 상태가 ON_SALE·ALL_HELD·SOLD_OUT이고 clock.now() − row.countedAtMs ≥ SALE_REPUBLISH_MS면 store.republish. undefined면 UNCHANGED, 아니면 REPUBLISHED와 signals.republished().
   *       - 그 밖은 UNCHANGED(쓰지 않는다).
   *       사건에 싣는 평균은 store.avgTicketsPerOrder(eventId)를 회차마다 AVG_CACHE_MS(1분) [가정] 파드 메모리에 두고 쓴다.
   *       평균 읽기가 실패하면 그 칸만 빼고 쓴다(FAILED가 아니고 메모도 그대로다, 지표 단계 avg). 실패도 1분 두어 다음 틱에 다시 읽지 않는다.
   *    j. a~i의 오류: 그 회차의 이번 틱만 쉰다(FAILED). 판정을 바꾸지 않고 메모의 두 번 이어짐(emptyStreak·firstEmptyAtMs·tierEmptyStreak)만 끊는다(availableZeroSinceMs는 둔다).
   *       signals.tickFailure(단계) 한 번과 경고 문이 열릴 때 logger.warn({ eventId, stage, code }) 한 줄(code는 오류 코드, 없으면 'UNKNOWN'). 단계는 lease(임대·회차 목록), counts(좌석맵 판·좌석 Redis 읽기·활성 판매 대조), paying(결제 중 읽기), write(event_sale 읽기·쓰기)다.
   * 4. 회차 목록을 읽은 틱이면 signals.allHeldSeconds(맡은 회차 가운데 ALL_HELD가 가장 오래 이어진 시간)를 낸다. 맡았지만 셈을 못 본 틱(NOT_READY·FAILED)의 회차도 든다. 임대를 다른 파드가 잡은 회차는 들지 않는다.
   *    겹치지 않은 틱은 모두 signals.tickSeconds(걸린 시간, 단조 시계)를 낸다.
   * 5. { overlapped: false, events }를 돌려준다.
   */
  tick(): Promise<SaleTickReport> {
    if (this.#running) {
      this.#signals.skipped('overlapped');
      return Promise.resolve({ overlapped: true, events: [] });
    }
    const p: Promise<SaleTickReport> = this.#tick(this.#stops).finally(() => {
      if (this.#running === p) this.#running = undefined;
    });
    this.#running = p;
    return p;
  }

  /**
   * 반복을 켠다: deps.timer(기본 systemSweepTimer).every(SALE_TICK_MS(1000), …). 이미 켰으면 아무것도 하지 않는다(타이머를 하나만 건다).
   * tick()을 바로 부르지 않는다(첫 틱은 1초 뒤). 타이머가 부른 틱의 거부는 여기서 막아 로그 한 줄로 남긴다
   */
  start(): void {
    if (this.#timer) return;
    this.#timer = (this.deps.timer ?? systemSweepTimer).every(SALE_TICK_MS, () => {
      void this.tick().catch((err: unknown) => this.deps.logger?.error({ stage: 'loop', code: errorCodeOf(err) }, '판매 상태 판정 반복이 틱 밖에서 오류를 만나 이번 틱을 멈췄다'));
    });
  }

  /**
   * 반복을 끈다: 멈춤 표시를 세우고 타이머를 멈추고, 돌고 있는 틱이 있으면 끝날 때까지 기다린다. 돌던 회차만 마친다. 켜지 않았으면 바로 끝난다. 두 번 불러도 된다.
   * 임대는 놓지 않는다(SWEEP_LEASE_TTL_MS 뒤 저절로 풀린다). 끈 뒤 start()로 다시 켤 수 있다
   */
  async stop(): Promise<void> {
    this.#stops += 1;
    const t = this.#timer;
    this.#timer = undefined;
    t?.cancel();
    await this.#running?.catch(() => undefined);
  }

  get #signals(): SaleStateSignals {
    return this.deps.signals ?? noSaleStateSignals;
  }

  async #tick(stops: number): Promise<SaleTickReport> {
    const startedMs = this.deps.clock.monotonicMs();
    try {
      return await this.#sweep(stops);
    } finally {
      this.#signals.tickSeconds((this.deps.clock.monotonicMs() - startedMs) / 1000);
    }
  }

  async #sweep(stops: number): Promise<SaleTickReport> {
    let list: string[];
    try {
      list = await this.deps.events.saleEvents();
    } catch (err) {
      this.#fail({ stage: 'lease', code: errorCodeOf(err) });
      return { overlapped: false, listFailed: err instanceof SeatStoreUnavailable ? 'UNAVAILABLE' : 'ERROR', events: [] };
    }
    const ids = [...new Set(list)].sort(byCodeUnit);
    this.#forgetExcept(ids);
    const reports = new Map<string, SaleEventReport>();
    const tally: TickTally = { allHeldMs: 0 };
    let next = 0;
    const lane = async () => {
      while (next < ids.length && stops === this.#stops) {
        const eventId = ids[next++]!;
        reports.set(eventId, await this.#judgeEvent(eventId, tally));
      }
    };
    await Promise.all(Array.from({ length: Math.min(SALE_JUDGE_CONCURRENCY, ids.length) }, lane));
    this.#signals.allHeldSeconds(tally.allHeldMs / 1000);
    return { overlapped: false, events: ids.filter((id) => reports.has(id)).map((id) => reports.get(id)!) };
  }

  /** 회차 하나를 이번 틱에 판정한다(던지지 않는다, 위 tick 차례의 a~j) */
  async #judgeEvent(eventId: string, tally: TickTally): Promise<SaleEventReport> {
    const { counts, paying, seatMap, store, leases, clock, podId } = this.deps;
    const signals = this.#signals;
    let stage: SaleTickStage = 'counts';
    let guardBlocked = false;
    /** 이번 틱이 끝난 뒤의 행(읽었거나 쓴 때만). 틱 끝에 ALL_HELD 시간을 잰다 */
    let current: EventSaleRow | undefined;
    const report = (outcome: SaleTickOutcome, rest: Pick<SaleEventReport, 'status' | 'version' | 'failedStage'> = {}): SaleEventReport => ({ eventId, outcome, ...rest, guardBlocked });
    try {
      const config = await seatMap.config(eventId);
      const layout = config && (await seatMap.saleLayout(eventId));
      if (!config || !layout) {
        signals.skipped('no_config');
        this.#memos.delete(eventId);
        return report('NO_CONFIG');
      }
      stage = 'lease';
      if (!(await leases.acquire(eventId, podId, SWEEP_LEASE_TTL_MS, 'sale'))) {
        this.#memos.delete(eventId);
        return report('NOT_LEASED');
      }
      stage = 'write';
      const row = await store.read(eventId);
      current = row;
      if (row?.status === 'ENDED') return report('ALREADY_ENDED', { status: 'ENDED' });
      const nowMs = clock.now();
      if (!row && nowMs >= config.saleEndsAtMs) return report('ENDED');
      const writeChange = async (from: EventSaleRow, decision: SaleDecision, seatCounts: SaleSeatCounts): Promise<SaleEventReport> => {
        const changed = await this.#applyChange(from, decision, seatCounts, nowMs);
        if (!changed) return this.#lost(eventId, report);
        current = changed;
        return report('CHANGED', { status: changed.status, version: changed.version });
      };
      if (row && nowMs >= config.saleEndsAtMs) {
        const lastCounts: SaleSeatCounts = { available: row.available, held: row.held, paying: row.paying };
        this.#memos.delete(eventId);
        return await writeChange(row, decideSale({ row, counts: { ...lastCounts, empty: false, tiers: [] }, memo: NEW_SALE_MEMO, nowMs, saleEndsAtMs: config.saleEndsAtMs }), lastCounts);
      }

      stage = 'counts';
      const read = await counts.read(eventId);
      if (read.kind === 'NOT_READY') {
        signals.skipped('not_ready');
        this.#memos.delete(eventId);
        return report('NOT_READY', row ? { status: row.status } : {});
      }
      stage = 'paying';
      const payingByTier = await paying.payingByTier(eventId, nowMs);
      stage = 'counts';
      const seen = await this.#tierCounts(eventId, layout, read.bitmap, read.held, payingByTier, row);
      const takenSeats = layout.sellableSeats - seen.available;
      let empty = false;
      let reopenBlocked = false;
      if (seen.available === 0 && seen.held === 0 && seen.paying === 0 && row?.status !== 'SOLD_OUT') {
        const activeSales = await store.activeSaleCount(eventId);
        empty = activeSales === takenSeats;
        if (!empty) {
          guardBlocked = true;
          this.#guardBlocked(eventId, activeSales, takenSeats, '활성 판매 행 수가 켜진 비트 수와 달라 매진 후보를 막았다');
        }
      } else if (row?.status === 'SOLD_OUT' && seen.available >= 1) {
        const activeSales = await store.activeSaleCount(eventId);
        reopenBlocked = activeSales >= layout.sellableSeats;
        if (reopenBlocked) {
          guardBlocked = true;
          this.#guardBlocked(eventId, activeSales, takenSeats, '모든 좌석에 활성 판매 행이 있는데 비트가 꺼져 있어 매진 풀림을 막았다');
        }
      }

      const decision = decideSale({ row, counts: { ...seen, empty, reopenBlocked }, memo: this.#memos.get(eventId) ?? NEW_SALE_MEMO, nowMs, saleEndsAtMs: config.saleEndsAtMs });
      this.#memos.set(eventId, decision.memo);

      stage = 'write';
      const seatCounts: SaleSeatCounts = { available: seen.available, held: seen.held, paying: seen.paying };
      if (!row) {
        const created = await store.create({ eventId, sellableSeats: layout.sellableSeats, ...seatCounts, nowMs, ...(await this.#avgOf(eventId, nowMs)) });
        return created ? report('CREATED', { status: created.status, version: created.version }) : this.#lost(eventId, report);
      }
      if (decision.changed) return await writeChange(row, decision, seatCounts);
      if (row.status !== 'UPCOMING' && nowMs - row.countedAtMs >= SALE_REPUBLISH_MS) {
        const again = await store.republish({ eventId, expectedVersion: row.version, ...seatCounts, nowMs, ...(await this.#avgOf(eventId, nowMs)) });
        if (again) {
          signals.republished();
          return report('REPUBLISHED', { status: again.status, version: again.version });
        }
      }
      return report('UNCHANGED', { status: row.status });
    } catch (err) {
      const memo = this.#memos.get(eventId);
      if (memo) this.#memos.set(eventId, { ...(memo.availableZeroSinceMs !== undefined ? { availableZeroSinceMs: memo.availableZeroSinceMs } : {}), emptyStreak: 0, tierEmptyStreak: new Map() });
      this.#fail({ eventId, stage, code: errorCodeOf(err) });
      return report('FAILED', { failedStage: stage });
    } finally {
      // changed_at은 등급 매진만 바뀌어도 새로 쓰이므로, 그런 판이 끼면 이 값은 짧게 재진다(새는 비트는 등급이 한 번 든 뒤로 바뀌지 않아 경보에는 지장이 없다)
      if (current?.status === 'ALL_HELD') tally.allHeldMs = Math.max(tally.allHeldMs, clock.now() - current.changedAtMs);
    }
  }

  /** 판 번호를 올려 쓰고(상태가 바뀌었으면 지표) 쓴 행을 돌려준다. 다른 파드에 지면 undefined */
  async #applyChange(row: EventSaleRow, decision: SaleDecision, seatCounts: SaleSeatCounts, nowMs: number): Promise<EventSaleRow | undefined> {
    const statusChanged = decision.status !== row.status;
    const previousStatus = statusChanged ? row.status : row.previousStatus;
    const changed = await this.deps.store.applyChange({
      eventId: row.eventId,
      expectedVersion: row.version,
      status: decision.status,
      ...(previousStatus !== undefined ? { previousStatus } : {}),
      soldOutTiers: decision.soldOutTiers,
      reopenCount: decision.reopenCount,
      ...seatCounts,
      nowMs,
      ...(await this.#avgOf(row.eventId, nowMs)),
    });
    if (changed && statusChanged) this.#signals.transition(decision.status);
    return changed;
  }

  /** 거짓 매진 막기·매진 풀림 대조가 막았다: 지표 한 번과, 그 회차의 문이 열릴 때 경고 한 줄(회차 ID와 수만) */
  #guardBlocked(eventId: string, activeSales: number, takenSeats: number, message: string): void {
    this.#signals.guardBlocked();
    let gate = this.#guardGates.get(eventId);
    if (!gate) {
      gate = new LogGate(this.deps.clock, SALE_WARN_INTERVAL_MS);
      this.#guardGates.set(eventId, gate);
    }
    if (gate.allow()) this.deps.logger?.warn({ eventId, activeSales, takenSeats }, message);
  }

  /** 비트맵·만료 인덱스·결제 중으로 회차와 등급의 셈을 만든다 */
  async #tierCounts(eventId: string, layout: SaleLayout, bitmap: Buffer, held: number, payingByTier: ReadonlyMap<string, number>, row: EventSaleRow | undefined): Promise<TickCounts> {
    const availability = tierAvailability(bitmap, layout.tiers);
    const payingOf = (tierId: string): number => payingByTier.get(tierId) ?? 0;
    const listed = new Set(row?.soldOutTiers ?? []);
    const candidates = availability.filter((t) => t.available === 0 && payingOf(t.tierId) === 0 && !listed.has(t.tierId)).map((t) => t.tierId);
    const heldTiers = held > 0 && candidates.length > 0 ? await this.#tiersWithHolds(eventId, layout, candidates) : new Set<string>();
    return {
      available: availability.reduce((sum, t) => sum + t.available, 0),
      held,
      paying: [...payingByTier.values()].reduce((sum, n) => sum + n, 0),
      tiers: availability.map((t) => ({ tierId: t.tierId, available: t.available, paying: payingOf(t.tierId), held: heldTiers.has(t.tierId) })),
    };
  }

  /** 만료 인덱스를 순위로 쪽마다 읽어 홀드가 보인 후보 등급을 돌려준다(후보를 다 찾거나 쪽이 짧으면 멈춘다. 판에 없는 색인은 무시한다) */
  async #tiersWithHolds(eventId: string, layout: SaleLayout, candidates: readonly string[]): Promise<Set<string>> {
    const left = new Set(candidates);
    const tierOf = new Map<number, string>();
    for (const t of layout.tiers) if (left.has(t.tierId)) for (const i of t.indexes) tierOf.set(i, t.tierId);
    const found = new Set<string>();
    for (let start = 0; left.size > 0; start += SALE_TIER_SCAN_PAGE) {
      const { indexes, badMembers } = await this.deps.counts.holdIndexes(eventId, start, SALE_TIER_SCAN_PAGE);
      if (badMembers > 0) this.#signals.skipped('bad_member', badMembers);
      for (const index of indexes) {
        const tierId = tierOf.get(index);
        if (tierId !== undefined && left.delete(tierId)) found.add(tierId);
      }
      if (indexes.length + badMembers < SALE_TIER_SCAN_PAGE) break;
    }
    return found;
  }

  /** 사건에 실을 평균 구매 매수(AVG_CACHE_MS 동안 다시 읽지 않는다). 없거나 읽지 못했으면 빈 객체다(평균은 덧붙이는 값이라 실패가 전이를 막지 않는다. 실패도 AVG_CACHE_MS 둔다) */
  async #avgOf(eventId: string, nowMs: number): Promise<{ avgTicketsPerOrder?: number }> {
    let cached = this.#avg.get(eventId);
    if (!cached || nowMs - cached.readAtMs >= AVG_CACHE_MS) {
      let value: number | undefined;
      try {
        value = await this.deps.store.avgTicketsPerOrder(eventId);
      } catch (err) {
        this.#fail({ eventId, stage: 'avg', code: errorCodeOf(err) });
      }
      cached = { value, readAtMs: nowMs };
      this.#avg.set(eventId, cached);
    }
    return cached.value !== undefined ? { avgTicketsPerOrder: cached.value } : {};
  }

  /** 조건부 쓰기에 졌다: 그 회차의 메모를 지우고 LOST */
  #lost(eventId: string, report: (outcome: SaleTickOutcome) => SaleEventReport): SaleEventReport {
    this.#memos.delete(eventId);
    return report('LOST');
  }

  /** 실패 지표 한 번과, 경고 문이 열릴 때 경고 한 줄(회차 ID·단계·코드만) */
  #fail(fields: { eventId?: string; stage: SaleTickStage; code: string }): void {
    this.#signals.tickFailure(fields.stage);
    if (this.#warnGate.allow()) this.deps.logger?.warn(fields, '판매 상태 판정이 이번 틱을 쉬었다');
  }

  /** 회차 목록에서 사라진 회차의 파드 메모리를 지운다 */
  #forgetExcept(ids: readonly string[]): void {
    const keep = new Set(ids);
    for (const map of [this.#memos, this.#avg, this.#guardGates]) for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
  }
}
