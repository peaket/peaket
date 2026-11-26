// 예매 제한 정비·다시 보내기 작업(F-06-4 IR-02). 1분마다 실패한 사본·끝난 제한을 보고,
// 같은 판 재전송은 엔진이 10분 간격으로 가둔다. 종료 때 타이머를 멈춘다.
import type { PlatformLogger } from '@peaket/platform';

export const RESTRICTION_MAINTENANCE_INTERVAL_MS = 60_000;

export interface RestrictionMaintainer {
  maintain(nowMs?: number): Promise<unknown>;
}

export class RestrictionMaintenanceJob {
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly kit: RestrictionMaintainer,
    private readonly logger: Pick<PlatformLogger, 'warn'>,
    private readonly intervalMs = RESTRICTION_MAINTENANCE_INTERVAL_MS,
  ) {}

  async tick(nowMs = Date.now()): Promise<void> {
    await this.kit.maintain(nowMs);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.logger.warn({ err }, '예매 제한 정비 작업 한 바퀴가 실패했다'));
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
