// 다시 만들기 반복(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 다시 만들기 반복, RB-06, ADR-0121).
// 릴레이 프로세스의 Lease 리더가 5초 [가정]마다 판매 회차 목록(SaleEventCatalog)을 보고, 판매 종료 + 1시간 [가정] 전이고 판매를 연 기록(SeatRebuildMarks,
// purchase DB seat_rebuild 행)이 있는 회차 가운데 세대 키가 없는(isReady 거짓) 회차를 차례로 SeatRebuilder로 다시 만든다. 판매 열기는 부르지 않는다(판매 열기와의 차례, LCH-080).
// 기록이 없는 회차(판매 열기 전·초안·취소 회차의 판 파일)는 다시 만들지 않는다: 판매 열기 전의 NOT_READY 막음을 지우지 않는다(리뷰 고침 M3).
// 세대 키 확인이 던지면 좌석 Redis에 닿지 못한 것이라 그 틱을 끝낸다(회차마다 경고가 쏟아지지 않게, 리뷰 고침 L5). 다시 만들기 실패는 다음 회차로 간다.
// 플랫폼 LeaderLoop 모양(name·start·stop)을 맞춘다(플랫폼 형을 가져오지 않고 모양만): 릴레이 프로세스의 leaderLoops가 그대로 돌린다.
// 구현에서 정한 것: 로그 줄에는 kind 'seat-rebuild-loop'를 단다. 로거가 던져도 반복·보고를 바꾸지 않는다(삼킨다).
// 판매를 연 기록은 창 안 회차를 모아 틱마다 한 번 묻는다(창 안 회차가 없으면 묻지 않는다). 기록이 없어 넘긴 회차는 checked에 세지 않는다.
import type { Clock } from '@peaket/platform';
import { KEEP_AFTER_SALE_END_MS } from '../domain/hold.js';
import { RETIRE_AFTER_SALE_END_MS } from '../domain/pin.js';
import type { SaleEvent, SaleEventCatalog, SeatRebuildMarks, SeatRebuildTarget } from '../domain/ports.js';
import type { RebuildReport } from '../domain/rebuild.js';

/** 다시 만들기 반복의 틱 간격 5초 [가정](정본 '반복이 5초마다 다시 하므로 손으로 부르는 명령은 두지 않는다') */
export const REBUILD_LOOP_TICK_MS = 5_000;
/**
 * 판매 종료 뒤 이만큼 지난 회차는 다시 만들지 않는다: 1시간 [가정](회차 목록 빼기 RETIRE_AFTER_SALE_END_MS와 같은 여유).
 * '지난'은 clock.now() > saleEndsAtMs + 이 값이다(같으면 아직 본다)
 */
export const REBUILD_LOOK_AFTER_SALE_END_MS = RETIRE_AFTER_SALE_END_MS;

export interface SeatRebuildLoopLogger {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
}

export interface SeatRebuildLoopDeps {
  /** 판매 회차 목록(운영은 SeatMapEventCatalog) */
  catalog: SaleEventCatalog;
  /** 판매를 연 기록(운영은 DrizzleSeatRebuildSource, 서비스 역할 DB). 기록이 있는 회차만 다시 만든다(리뷰 고침 M3) */
  marks: Pick<SeatRebuildMarks, 'opened'>;
  /** 세대 키 확인(운영은 RedisSeatStore) */
  store: Pick<SeatRebuildTarget, 'isReady'>;
  /** 회차 하나 다시 만들기(운영은 SeatRebuilder. STALE은 이미 BUSY로 바꿔 준다) */
  rebuilder: { rebuild(eventId: string, o: { keepUntilMs: number }): Promise<RebuildReport> };
  /** 리더 확인(릴레이 프로세스의 LeaderLoopContext.leader) */
  leader: { isLeader(): boolean };
  /** '판매 종료 + 1시간 지남'을 가르는 지금 */
  clock: Clock;
  /** REBUILT은 info 한 줄(있을 때만), 실패는 warn 한 줄. 회차 ID·결과 수·오류 이름만 싣는다 */
  logger?: SeatRebuildLoopLogger;
  /** 틱 간격(기본 REBUILD_LOOP_TICK_MS) */
  tickMs?: number;
  /** 시험이 바꾸는 쉬기(기본 setTimeout, signal이 끊기면 바로 풀린다) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 틱 하나의 보고.
 * - 리더가 아님: { skipped: 'not_leader' }(catalog·marks·store·rebuilder 어느 것도 부르지 않았다)
 * - 회차 목록을 읽지 못함: { skipped: 'catalog_failed' }(경고 한 줄, 그 틱 끝)
 * - 판매를 연 기록을 읽지 못함: { skipped: 'marks_failed' }(경고 한 줄, 그 틱 끝. isReady·rebuild 없음)
 * - 그 밖: checked = isReady를 부른 회차 수(판매 종료 + 1시간이 지났거나 판매를 연 기록이 없어 넘긴 회차는 세지 않는다), rebuilt = REBUILT으로 끝난 회차,
 *   busy = BUSY로 끝난 회차(다음 틱에 다시 본다), failed = rebuild가 던진 회차와 isReady가 던진 회차(그 회차에서 틱이 끝난다).
 *   셋 다 본 차례 그대로이고, READY는 어디에도 넣지 않는다
 */
export type RebuildLoopReport = { checked: number; rebuilt: string[]; busy: string[]; failed: string[] } | { skipped: 'not_leader' | 'catalog_failed' | 'marks_failed' };

const KIND = 'seat-rebuild-loop';

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

export class SeatRebuildLoop {
  /** 리더 반복 이름(LeaderLoop.name) */
  readonly name = 'seat-rebuild-loop';
  readonly #tickMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly deps: SeatRebuildLoopDeps) {
    this.#tickMs = deps.tickMs ?? REBUILD_LOOP_TICK_MS;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * 한 번 본다.
   * 1. leader.isLeader()가 거짓이면 아무것도 부르지 않고 { skipped: 'not_leader' }
   * 2. catalog.list()가 던지면 warn 한 줄(오류 이름만) 뒤 { skipped: 'catalog_failed' }
   * 3. clock.now() > saleEndsAtMs + REBUILD_LOOK_AFTER_SALE_END_MS인 회차는 넘긴다(아무것도 부르지 않는다). 남은 창 안 회차를 모아
   *    marks.opened(창 안 회차 ID들)를 한 번 부른다(창 안 회차가 없으면 부르지 않는다). 던지면 warn 한 줄(오류 이름만) 뒤 { skipped: 'marks_failed' }
   * 4. 판매를 연 기록이 있는 회차마다 목록 차례로 하나씩(동시에 하지 않는다. 기록이 없는 회차는 아무것도 부르지 않는다):
   *    a. store.isReady(eventId)가 참이면 넘긴다
   *    b. 거짓이면 rebuilder.rebuild(eventId, { keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS }).
   *       REBUILT은 info 한 줄(eventId·gen·sold·held·skipped)과 rebuilt, BUSY는 busy, READY는 그대로
   *    c. rebuild가 던지면 warn 한 줄(eventId·오류 이름만) 뒤 failed에 넣고 다음 회차로 간다
   *    d. isReady가 던지면 좌석 Redis에 닿지 못한 것이라 warn 한 줄(eventId·오류 이름만) 뒤 failed에 넣고 그 틱을 끝낸다(남은 회차를 보지 않는다)
   * 5. signal이 끊기면 남은 회차를 보지 않고 그때까지의 보고를 돌려준다(돌던 회차 하나는 마친다)
   * 리더 여부는 틱 처음에 한 번만 본다. 위 오류는 모두 보고에 담고 던지지 않는다(리더 확인 자체가 던지면 그대로 던진다: 반복이 경고 뒤 이어 돈다)
   * @param signal 멈춤 신호(반복이 stop()에서 끊는다. 직접 부를 때는 없어도 된다)
   */
  async tick(signal?: AbortSignal): Promise<RebuildLoopReport> {
    const { catalog, marks, store, rebuilder, leader, clock } = this.deps;
    if (!leader.isLeader()) return { skipped: 'not_leader' };
    let events: SaleEvent[];
    try {
      events = await catalog.list();
    } catch (err) {
      this.#log('warn', { kind: KIND, err: errorName(err) }, '다시 만들기 반복: 회차 목록을 읽지 못해 이 틱을 건너뛴다');
      return { skipped: 'catalog_failed' };
    }
    const report = { checked: 0, rebuilt: [] as string[], busy: [] as string[], failed: [] as string[] };
    const now = clock.now();
    const inWindow = events.filter((e) => now <= e.saleEndsAtMs + REBUILD_LOOK_AFTER_SALE_END_MS);
    if (inWindow.length === 0) return report;
    let opened: ReadonlySet<string>;
    try {
      opened = await marks.opened(inWindow.map((e) => e.eventId));
    } catch (err) {
      this.#log('warn', { kind: KIND, err: errorName(err) }, '다시 만들기 반복: 판매를 연 기록을 읽지 못해 이 틱을 건너뛴다');
      return { skipped: 'marks_failed' };
    }
    for (const { eventId, saleEndsAtMs } of inWindow) {
      if (signal?.aborted) break;
      // 판매를 열기 전(초안·취소 회차의 판 파일 포함)이면 NOT_READY 막음을 지우지 않는다. 세대 키는 판매 열기가 쓴다
      if (!opened.has(eventId)) continue;
      report.checked += 1;
      try {
        if (await store.isReady(eventId)) continue;
      } catch (err) {
        // 오류 글에는 주소·비밀번호가 실릴 수 있어 이름만 남긴다. 좌석 Redis에 닿지 못했으면 남은 회차도 같으므로 경고 한 줄로 그 틱을 끝낸다
        report.failed.push(eventId);
        this.#log('warn', { kind: KIND, eventId, err: errorName(err) }, '다시 만들기 반복: 세대 키를 확인하지 못해(좌석 Redis) 이 틱을 끝낸다(다음 틱에 다시 본다)');
        break;
      }
      let result: RebuildReport;
      try {
        result = await rebuilder.rebuild(eventId, { keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
      } catch (err) {
        report.failed.push(eventId);
        this.#log('warn', { kind: KIND, eventId, err: errorName(err) }, '다시 만들기 반복: 회차 하나를 다시 만들지 못했다(다음 틱에 다시 본다)');
        continue;
      }
      if (result.result === 'REBUILT') {
        report.rebuilt.push(eventId);
        this.#log('info', { kind: KIND, eventId, gen: result.gen, sold: result.sold, held: result.held, skipped: result.skipped }, '다시 만들기 반복: 회차의 좌석 Redis를 다시 만들었다');
      } else if (result.result === 'BUSY') report.busy.push(eventId);
    }
    return report;
  }

  /**
   * 반복을 켠다: tick → tickMs 쉼 → tick …. 이미 켰으면 아무것도 하지 않는다. 틱이 예상 밖 오류로 끝나도 반복은 끝나지 않는다
   * (warn 한 줄 뒤 tickMs 쉬고 이어 돈다, SeatStreamRelay의 반복과 같다). 기다리지 않는다
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
        this.#log('warn', { kind: KIND, err: errorName(err) }, '다시 만들기 반복: 틱이 예상 밖 오류로 끝났다');
      }
      if (signal.aborted) break;
      try {
        await this.#sleep(this.#tickMs, signal);
      } catch {
        // 쉬기가 던져도(바꿔 끼운 쉬기) 반복을 끝내지 않는다. 멈춤 신호는 위 조건이 본다
      }
    }
  }

  /** 로그 한 줄. 로거가 없거나 던져도 반복·보고를 바꾸지 않는다 */
  #log(level: 'warn' | 'info', obj: object, msg: string): void {
    try {
      if (level === 'warn') this.deps.logger?.warn(obj, msg);
      else this.deps.logger?.info?.(obj, msg);
    } catch {
      // 로그 실패는 다시 만들기를 막지 않는다
    }
  }
}

/** 오류의 이름만(메시지·값을 로그에 남기지 않는다) */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
