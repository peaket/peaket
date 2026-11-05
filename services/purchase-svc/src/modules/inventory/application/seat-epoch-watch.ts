// 세대 올리기 감시(BUILD_ORDER PRF-168, docs/features/seat-hold.md §6 '세대 올리기 감시의 첫 구현'·'세대 올리기(장애 조치 뒤)', ADR-0121 결정 5, ADR-0210 결정 3, S-T26 ①②).
// 좌석을 쓰는 Lua(홀드·만료·묶기·실패 해제)가 세대 키를 읽는 그 자리에서 세대를 올리므로(ADR-0210 결정 1), 이 감시는 쓰기가 없는 조용한 회차를 받친다.
// 릴레이 프로세스의 Lease 리더가 1초 [가정]마다 회차 목록 s:ctl:events(SeatExpiries.saleEvents)의 회차마다 세대 올리기(bumpEpoch, BUMP_EPOCH_LUA)를 부른다.
// 앱은 토폴로지를 읽지 않는다: Lua가 지금 도는 노드의 표지(CLUSTER MYID:cluster_my_epoch, 단일 노드는 standalone)를 구해 세대 키의 node와 견주고,
// 다를 때만(장애 조치로 복제본이 승격됨) 세대를 올린다. Redis 클라이언트가 MOVED·연결 끊김으로 슬롯 표를 새로 읽은 뒤 새 주 노드에서 돈다.
// 회차 목록 빼기가 뺀 회차는 목록에 없어 보지 않는다. NOT_READY(전체 유실 뒤 다시 만들기 전)는 넘긴다(다시 만들기 반복의 몫).
// 한 회차가 실패해도 남은 회차를 본다(샤드 하나가 내려가도 다른 샤드의 회차는 올린다). 실패는 틱마다 경고 한 줄(실패 수, 첫 회차 ID, 오류 이름·좌석 Lua 오류 코드)로 묶는다.
// 회차 목록을 읽지 못하면 그 틱을 끝낸다.
// 지표(리뷰 고침 중간 1, docs/observability.md seat_epoch_bumps_total): 쓰는 Lua와 세대 올리기 Lua가 올릴 때 세대 키 bumps 칸을 1씩 더하고, 세대 올리기가 그 값을 돌려준다.
// 감시는 회차마다 지난번에 본 bumps를 메모리에 두고, 커진 만큼 지표·info 로그를 낸다(쓰는 Lua가 올린 회차도 센다). 리더가 바뀐 뒤 첫 확인은 기준만 잡는다.
// 플랫폼 LeaderLoop 모양(name·start·stop)을 맞춘다(플랫폼 형을 가져오지 않고 모양만): 릴레이 프로세스의 leaderLoops가 그대로 돌린다.
// 구현에서 정한 것: 로그 줄에는 kind 'seat-epoch-watch'를 단다. 로거·지표가 던져도 반복·보고를 바꾸지 않는다(삼킨다).
// 리더 확인이 던지면 그 틱은 리더가 아닌 것으로 보고(경고 한 줄) 아무것도 부르지 않는다.
import { seatLuaErrorOf } from '../domain/lua-errors.js';
import type { SeatExpiries, SeatRebuildTarget } from '../domain/ports.js';

/** 세대 올리기 감시의 틱 간격 1초 [가정](S-T26 ①의 '1초 안 다시 맞춤', docs/features/seat-hold.md §6 '세대 올리기 감시의 첫 구현') */
export const EPOCH_WATCH_TICK_MS = 1_000;

export interface SeatEpochWatchLogger {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
}

/** seat_epoch_bumps_total(PromSeatSignals.epochBumped, docs/observability.md). n = 이번에 센 올린 수(1 이상) */
export interface SeatEpochWatchSignals {
  epochBumped(n: number): void;
}

export interface SeatEpochWatchDeps {
  /** 회차 목록(s:ctl:events)과 세대 올리기(운영은 RedisSeatStore, 시험 대역은 MemorySeatStore) */
  store: Pick<SeatExpiries, 'saleEvents'> & Pick<SeatRebuildTarget, 'bumpEpoch'>;
  /** 리더 확인(릴레이 프로세스의 LeaderLoopContext.leader) */
  leader: { isLeader(): boolean };
  /** 올린 것을 센 회차는 회차마다 info 한 줄(있을 때만), 실패는 틱마다 warn 한 줄. 회차 ID·새 세대·올린 수·실패 수·오류 이름·좌석 Lua 오류 코드만 싣는다 */
  logger?: SeatEpochWatchLogger;
  /** 센 회차마다 epochBumped(올린 수) 한 번 */
  signals?: SeatEpochWatchSignals;
  /** 틱 간격(기본 EPOCH_WATCH_TICK_MS) */
  tickMs?: number;
  /** 시험이 바꾸는 쉬기(기본 setTimeout, signal이 끊기면 바로 풀린다) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 틱 하나의 보고.
 * - 리더가 아님(리더 확인이 던짐 포함): { skipped: 'not_leader' }(saleEvents·bumpEpoch 어느 것도 부르지 않았다)
 * - 회차 목록을 읽지 못함: { skipped: 'store_failed' }(경고 한 줄, 그 틱 끝)
 * - 그 밖: checked = bumpEpoch를 부른 회차 수(던진 회차 포함), bumped = BUMPED로 끝난 회차(감시가 올린 회차), notReady = NOT_READY로 끝난 회차,
 *   failed = bumpEpoch가 던진 회차(셋 다 본 차례 그대로). SAME은 어디에도 넣지 않는다(쓰는 Lua가 올려 bumps가 커진 SAME도 지표·로그만 낸다)
 */
export type EpochWatchReport = { checked: number; bumped: string[]; notReady: string[]; failed: string[] } | { skipped: 'not_leader' | 'store_failed' };

const KIND = 'seat-epoch-watch';

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class SeatEpochWatch {
  /** 리더 반복 이름(LeaderLoop.name) */
  readonly name = 'seat-epoch-watch';
  readonly #tickMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 회차 → 지난번에 본 세대 키 bumps(이 프로세스가 리더인 동안만. 리더가 아닌 틱에 비운다) */
  readonly #seenBumps = new Map<string, number>();
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly deps: SeatEpochWatchDeps) {
    this.#tickMs = deps.tickMs ?? EPOCH_WATCH_TICK_MS;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * 한 번 본다.
   * 1. leader.isLeader()가 거짓이면 아무것도 부르지 않고 { skipped: 'not_leader' }. 던지면 warn 한 줄(오류 이름만) 뒤 같은 보고(리더가 아닌 것으로 본다).
   *    둘 다 회차마다 기억한 bumps를 비운다(다시 리더가 되면 그사이 다른 리더가 센 것을 다시 세지 않게 기준부터 잡는다)
   * 2. store.saleEvents()가 던지면 warn 한 줄(오류 이름만) 뒤 { skipped: 'store_failed' }(기억은 그대로)
   * 3. 기억한 회차 가운데 이번 목록에 없는 회차는 지운다
   * 4. 회차마다 목록 차례로 하나씩(동시에 하지 않는다) store.bumpEpoch(eventId):
   *    a. BUMPED면 bumped에 넣는다. NOT_READY면 notReady에 넣고 그 회차의 기억을 지운다(세대 키가 다시 서면 bumps가 0부터다). SAME은 넣지 않는다
   *    b. BUMPED·SAME의 bumps(세대 키의 올린 누적 수)를 지난번에 본 값 p와 견준다(리뷰 고침 중간 1, 쓰는 Lua가 올린 것도 센다):
   *       - p가 있고 bumps > p면 n = bumps − p
   *       - p가 없거나(처음 보는 회차, 리더가 바뀐 뒤 첫 확인) bumps < p면(세대 키를 다시 씀) 기준만 잡는다: BUMPED면 n = 1(이번에 감시가 올린 것), SAME이면 n = 0
   *       n > 0이면 info 한 줄(kind 'seat-epoch-watch'·eventId·새 세대 epoch·올린 수 bumps = n)과 signals.epochBumped(n) 한 번. 기억은 bumps로 바꾼다
   *    c. bumpEpoch가 던지면 failed에 넣고(기억은 그대로) 남은 회차를 이어 본다(한 회차의 실패로 틱을 끝내지 않는다: 샤드 하나가 내려가도 다른 샤드의 회차는 올린다, ADR-0210 결정 3)
   * 5. 실패한 회차가 있으면 틱 끝에 warn 한 줄로 묶는다: 실패 수(failed), 첫 회차 ID(eventId), 첫 오류의 이름(err), 좌석 Lua 오류 코드(code, seatLuaErrorOf가 주는 것이 있을 때만)
   * 6. signal이 끊기면 남은 회차를 보지 않고 그때까지의 보고를 돌려준다(돌던 회차 하나는 마친다)
   * 리더 여부는 틱 처음에 한 번만 본다. 위 오류는 모두 보고에 담고 던지지 않는다
   * @param signal 멈춤 신호(반복이 stop()에서 끊는다. 직접 부를 때는 없어도 된다)
   */
  async tick(signal?: AbortSignal): Promise<EpochWatchReport> {
    const { store, leader } = this.deps;
    let leading: boolean;
    try {
      leading = leader.isLeader();
    } catch (err) {
      // 리더인지 모르면 리더가 아닌 것으로 본다(두 리더가 함께 올려도 Lua가 한 번만 올리지만, 모르는 동안 일하지 않는 쪽이 리더 하나 약속에 맞다)
      this.#seenBumps.clear();
      this.#log('warn', { kind: KIND, err: errorName(err) }, '세대 올리기 감시: 리더 확인이 실패해 이 틱을 건너뛴다');
      return { skipped: 'not_leader' };
    }
    if (!leading) {
      this.#seenBumps.clear();
      return { skipped: 'not_leader' };
    }
    let events: string[];
    try {
      events = await store.saleEvents();
    } catch (err) {
      // 오류 글에는 주소·비밀번호가 실릴 수 있어 이름만 남긴다
      this.#log('warn', { kind: KIND, err: errorName(err) }, '세대 올리기 감시: 회차 목록(좌석 Redis)을 읽지 못해 이 틱을 건너뛴다');
      return { skipped: 'store_failed' };
    }
    // 목록에서 빠진 회차(회차 목록 빼기)는 기억에서 지운다(기억이 회차 수 이상으로 늘지 않게)
    const listed = new Set(events);
    for (const id of this.#seenBumps.keys()) if (!listed.has(id)) this.#seenBumps.delete(id);
    const report = { checked: 0, bumped: [] as string[], notReady: [] as string[], failed: [] as string[] };
    let firstError: unknown;
    for (const eventId of events) {
      if (signal?.aborted) break;
      report.checked += 1;
      let r: Awaited<ReturnType<SeatEpochWatchDeps['store']['bumpEpoch']>>;
      try {
        r = await store.bumpEpoch(eventId);
      } catch (err) {
        // 회차마다 슬롯(샤드)이 달라 한 샤드가 내려가도 다른 샤드의 회차는 올린다(ADR-0210 결정 3). 경고는 틱 끝에 한 줄로 묶는다
        if (report.failed.length === 0) firstError = err;
        report.failed.push(eventId);
        continue;
      }
      if (r.result === 'NOT_READY') {
        report.notReady.push(eventId);
        this.#seenBumps.delete(eventId);
        continue;
      }
      if (r.result === 'BUMPED') report.bumped.push(eventId);
      const n = this.#countBumps(eventId, r.result === 'BUMPED', r.bumps);
      if (n > 0) {
        this.#log('info', { kind: KIND, eventId, epoch: r.epoch, bumps: n }, '세대 올리기 감시: 주 노드가 바뀐 회차의 세대가 올랐다(쓰는 Lua 또는 감시가 올림)');
        this.#bumpedSignal(n);
      }
    }
    if (report.failed.length > 0) {
      // 오류 글에는 주소·비밀번호·키 이름(계정 ID)이 실릴 수 있어 이름과 좌석 Lua 오류 코드만 남긴다(ASVS 16.2.5)
      const code = seatLuaErrorOf(firstError)?.code;
      this.#log(
        'warn',
        { kind: KIND, failed: report.failed.length, eventId: report.failed[0], err: errorName(firstError), ...(code ? { code } : {}) },
        '세대 올리기 감시: 이 틱에 세대 올리기가 실패한 회차가 있다(다음 틱에 다시 본다)',
      );
    }
    return report;
  }

  /**
   * 반복을 켠다: tick → tickMs 쉼 → tick …. 이미 켰으면 아무것도 하지 않는다. 틱이 예상 밖 오류로 끝나도 반복은 끝나지 않는다
   * (warn 한 줄 뒤 tickMs 쉬고 이어 돈다, SeatRebuildLoop와 같다). 쉬기가 던져도 끝나지 않는다. 기다리지 않는다
   */
  start(): void {
    if (this.#abort) return;
    const ac = new AbortController();
    this.#abort = ac;
    this.#loop = this.#run(ac.signal);
  }

  /** 멈춤 신호를 보내고 돌던 틱을 기다린다(틱 안의 남은 회차는 보지 않는다). 켜지 않았거나 두 번 불러도 된다 */
  async stop(): Promise<void> {
    const ac = this.#abort;
    if (!ac) return;
    ac.abort();
    await this.#loop;
    this.#abort = undefined;
    this.#loop = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (err) {
        // 예상 밖 오류도 반복을 끝내지 않는다(처리되지 않은 거부로 프로세스가 죽지 않게)
        this.#log('warn', { kind: KIND, err: errorName(err) }, '세대 올리기 감시: 틱이 예상 밖 오류로 끝났다');
      }
      if (signal.aborted) break;
      try {
        await this.#sleep(this.#tickMs, signal);
      } catch {
        // 쉬기가 던져도(바꿔 끼운 쉬기) 반복을 끝내지 않는다. 멈춤 신호는 위 조건이 본다
      }
    }
  }

  /**
   * 이번에 셀 올린 수(tick의 4b): 지난번 값 p가 있고 bumps > p면 bumps − p, p가 없거나 bumps < p면 기준만 잡아 BUMPED면 1·SAME이면 0. 기억은 bumps로 바꾼다
   */
  #countBumps(eventId: string, bumped: boolean, bumps: number): number {
    const prev = this.#seenBumps.get(eventId);
    this.#seenBumps.set(eventId, bumps);
    if (prev !== undefined && bumps >= prev) return bumps - prev;
    return bumped ? 1 : 0;
  }

  /** seat_epoch_bumps_total을 n 올린다. 지표가 없거나 던져도 반복·보고를 바꾸지 않는다 */
  #bumpedSignal(n: number): void {
    try {
      this.deps.signals?.epochBumped(n);
    } catch {
      // 지표 실패는 세대 올리기를 막지 않는다
    }
  }

  /** 로그 한 줄. 로거가 없거나 던져도 반복·보고를 바꾸지 않는다 */
  #log(level: 'warn' | 'info', obj: object, msg: string): void {
    try {
      if (level === 'warn') this.deps.logger?.warn(obj, msg);
      else this.deps.logger?.info?.(obj, msg);
    } catch {
      // 로그 실패는 감시를 막지 않는다
    }
  }
}

/** 오류의 이름만(메시지·값을 로그에 남기지 않는다) */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
