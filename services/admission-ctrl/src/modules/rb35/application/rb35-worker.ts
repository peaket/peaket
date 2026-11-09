// RB-35 일꾼(ADR-0239 결정 8): 리더만 돌고, 전달된 묶음을 1초 [가정]마다 본다. 게시는 평소처럼 리더 주기가 이어서 한다.
import type { Clock, PlatformLogger } from '@peaket/platform';
import type { ApplyRb35 } from './apply-rb35.js';
import type { Rb35Store } from '../domain/ports.js';

export const RB35_POLL_MS = 1_000;

export interface Rb35WorkerDeps {
  store: Rb35Store;
  apply: ApplyRb35;
  /** 지금 리더인가(Lease) */
  isLeader: () => boolean;
  listEvents: (nowMs: number) => Promise<string[]>;
  clock: Clock;
  logger?: PlatformLogger;
}

export class Rb35Worker {
  #timer?: NodeJS.Timeout;
  #busy = false;

  constructor(private readonly d: Rb35WorkerDeps) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tickOnce(), RB35_POLL_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tickOnce(): Promise<void> {
    if (this.#busy || !this.d.isLeader()) return;
    this.#busy = true;
    try {
      for (const eventId of await this.d.listEvents(this.d.clock.now())) {
        for (const { group, raw } of await this.d.store.pending(eventId)) {
          const r = await this.d.apply.run(eventId, group, raw);
          if (r.status === 'rejected') this.d.logger?.warn({ eventId, group, commandId: r.commandId, reason: r.reason }, 'RB-35 묶음을 거절했다');
        }
      }
    } catch (err) {
      this.d.logger?.error({ err }, 'RB-35 일꾼 주기 실패(다음 주기에 다시)');
    } finally {
      this.#busy = false;
    }
  }
}
