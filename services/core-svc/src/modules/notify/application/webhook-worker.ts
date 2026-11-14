// 웹훅 발송 워커. 5초 [가정]마다 보낼 때가 된 행을 처리한다. 리더 한 대만 돌리는 것은 배포 단계의 Lease 몫이다.
import type { Clock } from '@peaket/platform';
import { WebhookDispatcher } from './dispatcher.js';

export class WebhookWorker {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly clock: Clock,
    private readonly intervalMs = 5_000,
    private readonly log: (line: Record<string, unknown>) => void = (line) => console.log(JSON.stringify(line)),
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const result = await this.dispatcher.processDue(new Date(this.clock.now()));
      if (result.attempted > 0) this.log({ kind: 'webhook-worker', ...result });
    } catch (e) {
      this.log({ kind: 'webhook-worker', error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.#running = false;
    }
  }
}
