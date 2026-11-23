// 배상 송금 결과 확정 바퀴(F-07-8 계획 I-06, §5.1 (라), transfer-refund §6 '송금 결과 확정', R-T47 ③).
// 리더 파드 하나가 1분 [가정]마다 REQUESTED 송금을 지급대행 포트로 다시 보고 PAID·FAILED로 확정한다(CompensationTransfers.refreshRequested).
// 두 파드가 리더라고 믿어도 상태 쓰기는 조건부 갱신, 미수금은 근거 부분 유일이라 한 번씩이다. 한 파드 안에서 겹친 tick은 하나만 돈다.
import type { CompensationTransfers } from './compensation-transfers.js';

export interface CompensationRefreshLeadership {
  isLeader(): boolean;
}

export interface CompensationRefreshTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CompensationRefreshLoopDeps {
  readonly transfers: Pick<CompensationTransfers, 'refreshRequested'>;
  readonly leader: CompensationRefreshLeadership;
  readonly timer?: CompensationRefreshTimer;
  /** 기본 60,000ms [가정] */
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly onError?: (e: unknown) => void;
}

export const COMPENSATION_REFRESH_INTERVAL_MS = 60_000;

const systemTimer: CompensationRefreshTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class CompensationRefreshLoop {
  #handle: unknown;
  #running: Promise<void> | undefined;

  constructor(private readonly deps: CompensationRefreshLoopDeps) {}

  start(): void {
    if (this.#handle !== undefined) return;
    this.#handle = (this.deps.timer ?? systemTimer).setInterval(() => void this.tick(), this.deps.intervalMs ?? COMPENSATION_REFRESH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.#handle === undefined) return;
    (this.deps.timer ?? systemTimer).clearInterval(this.#handle);
    this.#handle = undefined;
    await this.#running;
  }

  /** 리더가 아니면 아무것도 하지 않는다 */
  async tick(): Promise<void> {
    if (!this.deps.leader.isLeader() || this.#running) return;
    this.#running = (async () => {
      try {
        await this.deps.transfers.refreshRequested(this.deps.limit);
      } catch (e) {
        this.deps.onError?.(e);
      }
    })();
    try {
      await this.#running;
    } finally {
      this.#running = undefined;
    }
  }
}
