// 회차 취소 일괄 환불의 백그라운드 실행기(BAT-425 GAT-130). 릴레이 리더가 10초 [가정]마다
// event_refund_item의 PENDING/UNKNOWN을 조금씩 처리하고, 연기 신청 창이 닫힌 요청을 닫는다.
// 시작(START)은 첫 묶음만 바로 처리하고 나머지는 이 반복이 이어 간다. 멈춘 몫은 재개로만 다시 시작한다.
import type { LeaderLoop } from '@peaket/platform';
import type { EventRefundService } from './event-refund-service.js';

/** 반복 틱 10초 [가정]. 결제사 한도 안에서 나눠 처리하는 데 충분한 주기다 */
export const EVENT_REFUND_TICK_MS = 10_000;

export interface EventRefundLoopDeps {
  readonly refund: Pick<EventRefundService, 'runDue'>;
  readonly leader: { isLeader(): boolean };
  readonly logger?: { warn(o: object, msg: string): void; info?(o: object, msg: string): void };
  readonly tickMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type EventRefundTick = { skipped: 'not_leader' } | { closedWindows: number; processed: number };

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

export class EventRefundLoop implements LeaderLoop {
  readonly name = 'event-refund-runner';
  readonly #tickMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly deps: EventRefundLoopDeps) {
    this.#tickMs = deps.tickMs ?? EVENT_REFUND_TICK_MS;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  async tick(): Promise<EventRefundTick> {
    if (!this.deps.leader.isLeader()) return { skipped: 'not_leader' };
    return this.deps.refund.runDue();
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
        if ('processed' in r && (r.processed > 0 || r.closedWindows > 0)) {
          this.deps.logger?.info?.({ kind: 'event-refund-runner', ...r }, '회차 취소 환불 한 바퀴를 마쳤다');
        }
      } catch (err) {
        this.deps.logger?.warn({ kind: 'event-refund-runner', err: (err as Error).name }, '회차 취소 환불 틱이 실패했다(다음 틱이 다시 한다)');
      }
      try {
        await this.#sleep(this.#tickMs, signal);
      } catch {
        // 바꿔 끼운 쉬기가 던져도 반복을 끝내지 않는다
      }
    }
  }
}
