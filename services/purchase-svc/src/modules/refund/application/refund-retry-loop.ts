// 환급 재시도 반복(GAT-090). 릴레이 리더가 1분 [가정]마다 `RefundAfterEntry.run`을 불러
// `next_refund_at`(1분→5분→15분→1시간→6시간)이 지난 REFUND_PENDING과 입장 기록 마감 뒤 REQUESTED를 처리한다.
// 정비 일(하루 한 번)로 돌리면 간격이 하루로 늘어나므로 리더 반복으로 돈다. 리더가 아닌 틱은 아무것도 부르지 않는다.
import type { LeaderLoop } from '@peaket/platform';
import type { RefundAfterEntry } from './refund-after-entry.js';

/** 반복 틱 1분 [가정]. 재시도 간격의 가장 짧은 값과 같다 */
export const REFUND_RETRY_TICK_MS = 60_000;

export interface RefundRetryLoopDeps {
  refund: Pick<RefundAfterEntry, 'run'>;
  leader: { isLeader(): boolean };
  logger?: { warn(o: object, msg: string): void; info?(o: object, msg: string): void };
  tickMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type RefundRetryTick = { skipped: 'not_leader' } | { refunded: number; pending: number; failed: number };

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class RefundRetryLoop implements LeaderLoop {
  readonly name = 'cancellation-refund-retry';
  readonly #tickMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly deps: RefundRetryLoopDeps) {
    this.#tickMs = deps.tickMs ?? REFUND_RETRY_TICK_MS;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /** 한 번 본다. 리더가 아니면 아무것도 부르지 않는다 */
  async tick(): Promise<RefundRetryTick> {
    if (!this.deps.leader.isLeader()) return { skipped: 'not_leader' };
    return this.deps.refund.run();
  }

  start(): void {
    if (this.#abort) return;
    const ac = new AbortController();
    this.#abort = ac;
    this.#loop = this.#run(ac.signal);
  }

  async stop(): Promise<void> {
    const ac = this.#abort;
    if (!ac) return;
    ac.abort();
    await this.#loop;
    this.#abort = undefined;
    this.#loop = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const r = await this.tick();
        if ('refunded' in r && (r.refunded > 0 || r.pending > 0 || r.failed > 0)) {
          this.deps.logger?.info?.({ kind: 'cancellation-refund-retry', ...r }, '환급 재시도 한 바퀴를 마쳤다');
        }
      } catch (err) {
        this.deps.logger?.warn({ kind: 'cancellation-refund-retry', err: (err as Error).name }, '환급 재시도 틱이 실패했다(다음 틱이 다시 한다)');
      }
      try {
        await this.#sleep(this.#tickMs, signal);
      } catch {
        // 바꿔 끼운 쉬기가 던져도 반복을 끝내지 않는다
      }
    }
  }
}
