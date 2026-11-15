// 회차 정산 스케줄러(A2-06). Lease로 뽑힌 리더 파드 하나가
// 회차가 끝난 다음 영업일 06시(KST)에 core-svc에서 끝난 회차를 읽어 결제가 있는 결제사·상점만 정산서를 만든다.
// 지급일은 계산일이 아니라 회차 종료일 +5영업일이다(정본 §4.1·§5.1, A1V-02).
import { type Clock } from '@peaket/platform';
import type { Settlements } from './settlements.js';
import { dateOnly } from '../domain/settlement.js';

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

const DEFAULT_INTERVAL_MS = 30 * 60 * 1_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export class SettlementDueWorker {
  #handle: unknown;
  #running = false;
  #tickPromise: Promise<void> | undefined;
  #lastRegularRunDay: string | undefined;

  constructor(private readonly deps: SettlementDueWorkerDeps) {}

  start(): void {
    if (this.#handle !== undefined) return;
    // 첫 실행은 리더가 된 뒤 onChange가 force로 부른다(A1V-07). 정기 실행은 06시(KST)에만 한다.
    this.#handle = (this.deps.timer ?? systemTimer).setInterval(() => this.#schedule(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.#handle === undefined) return;
    (this.deps.timer ?? systemTimer).clearInterval(this.#handle);
    this.#handle = undefined;
    await this.#tickPromise;
  }

  /** 수동·리더 전환 시에는 force로 바로 돌고, 정기 타이머는 평일 06시(KST)에만 돈다. */
  async tick(force = true): Promise<void> {
    if (this.#running || !this.deps.leader.isLeader()) return;
    const now = new Date(this.deps.clock.now());
    const kst = new Date(now.getTime() + KST_OFFSET_MS);
    const today = dateOnly(kst);
    const weekday = kst.getUTCDay() >= 1 && kst.getUTCDay() <= 5;
    if (!force && (kst.getUTCHours() !== 6 || !weekday || this.#lastRegularRunDay === today)) return;
    this.#running = true;
    let ok = true;
    try {
      // 회차 종료 다음 영업일 06시에 계산하므로, 오늘 이전(KST)에 끝난 회차까지가 대상이다.
      const through = dateOnly(new Date(kst.getTime() - DAY_MS));
      let calculated = 0;
      try {
        const out = await this.deps.settlements.calculateDueEvents(through, this.deps.limit ?? 100);
        calculated += out.calculated;
      } catch (e) {
        ok = false;
        this.deps.log?.failed?.(e);
      }
      // 자동 확정은 core-svc 원천 장애와 독립적으로 돈다(A1V-08).
      try {
        const confirmed = await this.deps.settlements.confirmDueStatements(this.deps.limit ?? 100);
        calculated += confirmed.confirmed;
      } catch (e) {
        ok = false;
        this.deps.log?.failed?.(e);
      }
      // 정기 06시 tick이 둘 다 성공했을 때만 그날 실행을 소비한다. force tick은 정기 실행을 막지 않는다(A1V-07).
      if (!force && ok) this.#lastRegularRunDay = today;
      this.deps.log?.ticked?.({ through, calculated });
    } finally {
      this.#running = false;
    }
  }

  #schedule(): void {
    if (this.#tickPromise) return;
    this.#tickPromise = this.tick(false).finally(() => {
      this.#tickPromise = undefined;
    });
  }
}
