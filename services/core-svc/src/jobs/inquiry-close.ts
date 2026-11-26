// core-svc support 문의 닫기 배경 작업(F-06-5). 답변 뒤 14일 [가정] 지난 문의를 닫는다.
export const INQUIRY_CLOSE_INTERVAL_MS = 60 * 60 * 1_000;

export class InquiryCloseJob {
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: { closeIdle(nowMs: number): Promise<number> },
    private readonly logger?: { warn(obj: object, msg: string): void },
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), INQUIRY_CLOSE_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    try {
      await this.deps.closeIdle(Date.now());
    } catch (err) {
      this.logger?.warn({ event: 'inquiry-close-tick-failed', err: err instanceof Error ? err.name : 'unknown' }, '문의 닫기 한 바퀴가 실패했다(다음 바퀴에 다시)');
    }
  }
}
