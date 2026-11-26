// 승인 수명주기 5분 tick(F-06-3 IR-02). 1영업일 상위 알림·기한/대상 변경 만료·15시 지급 만료를 저절로 돌린다.
import type { PlatformLogger } from '@peaket/platform';
import type { ApprovalLifecycle } from '../modules/approvals/application/approval-lifecycle.js';

export const APPROVAL_TICK_INTERVAL_MS = 300_000;

export class ApprovalTickJob {
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly lifecycle: ApprovalLifecycle,
    private readonly logger: PlatformLogger,
    private readonly intervalMs = APPROVAL_TICK_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.lifecycle.tick().catch((err: unknown) => this.logger.warn({ err }, '승인 수명주기 tick 실패'));
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
