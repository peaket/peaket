// FRAUD_CASE 소명 보내기 작업(F-06-4 IR-03). 1분마다 SUBMITTED·RETRY 소명을 ops F-04-13 입구로 보낸다.
import type { PlatformLogger } from '@peaket/platform';

export const APPEAL_DISPATCH_INTERVAL_MS = 60_000;

export interface AppealDispatcher {
  dispatchOnce(nowMs?: number): Promise<unknown>;
}

export class AppealDispatchJob {
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly appeals: AppealDispatcher,
    private readonly logger: Pick<PlatformLogger, 'warn'>,
    private readonly intervalMs = APPEAL_DISPATCH_INTERVAL_MS,
  ) {}

  async tick(nowMs = Date.now()): Promise<void> {
    await this.appeals.dispatchOnce(nowMs);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.logger.warn({ err }, 'FRAUD_CASE 소명 보내기 한 바퀴가 실패했다'));
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
