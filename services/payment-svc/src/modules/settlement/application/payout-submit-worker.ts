// 토스 지급 전송 일꾼(F-07-6 LCH-110, settlement §5.2, ADR-0369 결정 7). 정산 일꾼과 같은 리더 선출(SETTLEMENT_DUE_LEASE_NAME)로 뽑힌 파드 하나가
// 1분 [가정]마다 다음 전송 시각이 지난 토스 묶음을 같은 키로 다시 보내고(응답 없음·처리 중·잔액 모자람·재요청 새 순번), 마감을 넘긴 묶음의 지급일을 미룬다.
// 두 파드가 리더라고 믿어도 묶음 잡기(next_submit_at 조건부 갱신)로 한 번만 보낸다.
import { type Clock } from '@peaket/platform';
import type { Settlements } from './settlements.js';
import type { SettlementDueLeadership, SettlementDueTimer } from './settlement-due-worker.js';

export interface PayoutSubmitWorkerDeps {
  readonly settlements: Settlements;
  readonly leader: SettlementDueLeadership;
  readonly clock: Clock;
  readonly timer?: SettlementDueTimer;
  /** 기본 60,000ms [가정] */
  readonly intervalMs?: number;
  readonly onError?: (e: unknown) => void;
}

const systemTimer: SettlementDueTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const PAYOUT_SUBMIT_INTERVAL_MS = 60_000;

export class PayoutSubmitWorker {
  #handle: unknown;
  #running: Promise<void> | undefined;

  constructor(private readonly deps: PayoutSubmitWorkerDeps) {}

  start(): void {
    if (this.#handle !== undefined) return;
    this.#handle = (this.deps.timer ?? systemTimer).setInterval(() => void this.tick(), this.deps.intervalMs ?? PAYOUT_SUBMIT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.#handle === undefined) return;
    (this.deps.timer ?? systemTimer).clearInterval(this.#handle);
    this.#handle = undefined;
    await this.#running;
  }

  /** 리더가 아니면 아무것도 하지 않는다. 한 파드 안에서 겹친 tick은 하나만 돈다 */
  async tick(): Promise<void> {
    if (!this.deps.leader.isLeader() || this.#running) return;
    this.#running = (async () => {
      try {
        await this.deps.settlements.submitDueBatches();
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
