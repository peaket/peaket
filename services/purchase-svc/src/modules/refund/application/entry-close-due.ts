// 환급 잇기 배경 작업(offline-gate §7.3 '환급 잇기', BUILD_ORDER GAT-180, O-T29 ③).
// 1분 [가정]마다 마감을 기다리는 보류 취소의 회차를 (그 회차 기다리는 행의 가장 이른 refund_due_at, 회차 ID) 차례로 20개 [가정]까지 고른다.
// core-svc 판매 설정의 entryClosedAtMs가 있으면 그 회차의 그런 행에 refund_due_at을 그 값으로 조건부 갱신한다. 환급 자체는 지금의 환급 실행기가 한다.
// 돌아가며 보기(RV-06·RV-17): 앞 틱이 상한을 꽉 채웠으면 마지막으로 본 회차의 (dueAtMs, 회차 ID) 쌍 다음부터, 덜 채웠으면 다음 틱은 처음부터다.
// 지표 결과는 회차마다 하나다(마감 시각을 읽었으면 바꾼 행이 0이어도 moved).
import type { LeaderLoop } from '@peaket/platform';
import type { EntryCloseDueMetrics, EntryCloseDueResult, EntryCloseDueStore, EntryCloseTimes } from '../domain/entry-close-due.js';

/** 환급 잇기 틱 1분 [가정](offline-gate §7.3 '환급 잇기') */
export const ENTRY_CLOSE_DUE_EVERY_MS = 60_000;
/** 한 틱이 보는 회차 수 20개 [가정] */
export const ENTRY_CLOSE_DUE_LIMIT = 20;

export type { EntryCloseDueMetrics, EntryCloseDueResult, EntryCloseDueStore, EntryCloseTimes } from '../domain/entry-close-due.js';

export interface EntryCloseDueTickDeps {
  store: EntryCloseDueStore;
  closes: EntryCloseTimes;
  nowMs: () => number;
  metrics?: EntryCloseDueMetrics;
}

export class EntryCloseDueTick {
  /** 앞 틱이 마지막으로 본 (dueAtMs, 회차 ID) 쌍. 상한을 꽉 채웠을 때만 남긴다 */
  #after: { dueAtMs: number; eventId: string } | undefined;

  constructor(private readonly d: EntryCloseDueTickDeps) {}

  async run(): Promise<{ moved: number }> {
    const nowMs = this.d.nowMs();
    const waiting = await this.d.store.waitingEvents(nowMs, ENTRY_CLOSE_DUE_LIMIT, this.#after);
    let moved = 0;
    for (const w of waiting) {
      let closedAtMs: number | null | undefined;
      try {
        closedAtMs = await this.d.closes.closedAtMs(w.eventId);
      } catch {
        closedAtMs = undefined;
      }
      if (closedAtMs === undefined) {
        this.d.metrics?.inc({ result: 'unavailable' });
        continue;
      }
      if (closedAtMs === null) {
        this.d.metrics?.inc({ result: 'not_closed' });
        continue;
      }
      moved += await this.d.store.pullDue(w.eventId, closedAtMs);
      // 마감 시각을 읽었으면 바꾼 행이 0이어도 그 회차 결과는 moved다(정본 §7.3)
      this.d.metrics?.inc({ result: 'moved' });
    }
    this.#after = waiting.length === ENTRY_CLOSE_DUE_LIMIT ? waiting.at(-1) : undefined;
    return { moved };
  }
}

export interface EntryCloseDueLoopDeps {
  tick: { run(): Promise<{ moved: number }> };
  leader: { isLeader(): boolean };
  logger?: { warn(o: object, msg: string): void };
  tickMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

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

/** 릴레이 리더만 도는 반복(대기 복제본은 아무것도 부르지 않는다) */
export class EntryCloseDueLoop implements LeaderLoop {
  readonly name = 'entry-close-due';
  readonly #tickMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly d: EntryCloseDueLoopDeps) {
    this.#tickMs = d.tickMs ?? ENTRY_CLOSE_DUE_EVERY_MS;
    this.#sleep = d.sleep ?? defaultSleep;
  }

  async tick(): Promise<{ moved: number } | { skipped: 'not_leader' }> {
    if (!this.d.leader.isLeader()) return { skipped: 'not_leader' };
    return this.d.tick.run();
  }

  start(): void {
    if (this.#abort) return;
    const ac = new AbortController();
    this.#abort = ac;
    this.#loop = this.#run(ac.signal);
  }

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
        await this.tick();
      } catch (err) {
        this.d.logger?.warn({ kind: 'entry-close-due', err: (err as Error).name }, '환급 잇기 틱이 실패했다(다음 틱이 다시 한다)');
      }
      try {
        await this.#sleep(this.#tickMs, signal);
      } catch {
        // 바꿔 끼운 쉬기가 던져도 반복을 끝내지 않는다
      }
    }
  }
}
