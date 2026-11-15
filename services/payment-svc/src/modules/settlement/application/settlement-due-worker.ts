// 회차 정산 스케줄러(A2-06). Lease로 뽑힌 리더 파드 하나가 하루 한 번,
// 회차 종료 5영업일이 지난 회차를 core-svc에서 읽어 결제가 있는 결제사만 정산서를 만든다.
import { type Clock } from '@peaket/platform';
import type { Settlements } from './settlements.js';
import { dateOnly, subtractBusinessDays } from '../domain/settlement.js';

export interface SettlementDueLeadership {
  isLeader(): boolean;
}

export interface SettlementDueTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SettlementDueLog {
  ticked?(o: { through: string; calculated: number }): void;
  failed?(e: unknown): void;
}

export interface SettlementDueWorkerDeps {
  readonly settlements: Settlements;
  readonly leader: SettlementDueLeadership;
  readonly clock: Clock;
  readonly log?: SettlementDueLog;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly timer?: SettlementDueTimer;
}

const systemTimer: SettlementDueTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export class SettlementDueWorker {
  #handle: unknown;
  #running = false;

  constructor(private readonly deps: SettlementDueWorkerDeps) {}

  start(): void {
    if (this.#handle !== undefined) return;
    this.#handle = (this.deps.timer ?? systemTimer).setInterval(() => void this.tick(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#handle === undefined) return;
    (this.deps.timer ?? systemTimer).clearInterval(this.#handle);
    this.#handle = undefined;
  }

  async tick(): Promise<void> {
    if (this.#running || !this.deps.leader.isLeader()) return;
    this.#running = true;
    try {
      const through = dateOnly(subtractBusinessDays(new Date(this.deps.clock.now()), 5));
      const out = await this.deps.settlements.calculateDueEvents(through, this.deps.limit ?? 100);
      const confirmed = await this.deps.settlements.confirmDueStatements(this.deps.limit ?? 100);
      this.deps.log?.ticked?.({ through, calculated: out.calculated + confirmed.confirmed });
    } catch (e) {
      this.deps.log?.failed?.(e);
    } finally {
      this.#running = false;
    }
  }
}
