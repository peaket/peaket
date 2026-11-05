// 때가 된 탈퇴 사건을 처리하는 반복(ADR-0214 결정 7, docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현').
// 모든 파드가 돈다. 꺼내기가 빌리기라 같은 항목을 한 파드만 처리하고, 처리를 마치지 못하면(대기열 Redis 일시 장애, 파드가 멈춤) 빌림이 끝난 뒤 다시 한다.
// 만료 당기기(PurgeWithdrawnKeys)는 다시 해도 결과가 같다. 가장 이른 처리할 때의 지난 초(lag), 꺼내기·처리 실패(failed), 값이 사라져 버린 항목(expired)을
// signals로 알려 경보(때가 지난 지 5분 [가정], 실패가 이어짐)에 쓴다. 값(pid)은 로그에 싣지 않는다.
import type { Clock } from '@peaket/platform';
import type { PurgeWithdrawnKeys } from './purge-withdrawn-keys.js';
import type { WithdrawnDue } from '../domain/ports.js';
import { QueueStoreUnavailable } from '../domain/queue.js';

/** 반복 주기·빌림·한 번에 꺼내는 수 [가정] */
export const WITHDRAWN_DUE_DEFAULTS = { everyMs: 5_000, leaseMs: 60_000, limit: 100 };

/** 반복의 지표(docs/observability.md §5) */
export interface WithdrawnDueSignals {
  /** 가장 이른 처리할 때가 지금보다 지난 초(없거나 아직이면 0). 꺼내기가 실패한 주기에는 부르지 않는다(failed가 센다) */
  lag(seconds: number): void;
  /** claim: 집합을 읽지 못함, process: 꺼낸 항목의 만료 당기기·지우기를 마치지 못함 */
  failed(stage: 'claim' | 'process'): void;
  /** 값이 수명(purgeBy)으로 사라져 처리하지 못하고 지운 항목 수 */
  expired(n: number): void;
}

export interface WithdrawnDueWorkerOptions {
  everyMs?: number;
  leaseMs?: number;
  limit?: number;
  logger?: { warn(o: object, msg?: string): void; error(o: object, msg?: string): void };
  signals?: WithdrawnDueSignals;
}

export class WithdrawnDueWorker {
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly due: WithdrawnDue,
    private readonly purge: PurgeWithdrawnKeys,
    private readonly clock: Clock,
    private readonly o: WithdrawnDueWorkerOptions = {},
  ) {}

  start(): void {
    this.#stopped = false;
    const loop = () => {
      if (this.#stopped) return;
      this.#running = this.tick().finally(() => {
        this.#running = undefined;
        if (!this.#stopped) {
          this.#timer = setTimeout(loop, this.o.everyMs ?? WITHDRAWN_DUE_DEFAULTS.everyMs);
          this.#timer.unref();
        }
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running?.catch(() => undefined);
  }

  /** 한 번: 때가 된 것을 빌려 처리한다. 던지지 않는다(다음 주기에 다시) */
  async tick(): Promise<void> {
    const sig = this.o.signals;
    let claimed;
    try {
      claimed = await this.due.claim({ leaseMs: this.o.leaseMs ?? WITHDRAWN_DUE_DEFAULTS.leaseMs, limit: this.o.limit ?? WITHDRAWN_DUE_DEFAULTS.limit });
    } catch (err) {
      sig?.failed('claim');
      if (!(err instanceof QueueStoreUnavailable)) this.o.logger?.error({ err }, '탈퇴 사건 처리할 때 집합을 읽지 못했다');
      return;
    }
    if (claimed.expired > 0) {
      sig?.expired(claimed.expired);
      this.o.logger?.warn({ expired: claimed.expired }, '처리하기 전에 값이 수명(purgeBy)으로 사라져 지운 탈퇴 사건이 있다(그 사람 키는 판매 종료 TTL로 지워진다)');
    }
    for (const it of claimed.items) {
      try {
        // purgeBy가 이미 지났어도 만료 당기기가 키를 바로 지운다
        await this.purge.run({ pids: it.pids, purgeBy: it.purgeBy });
        await this.due.done(it.eventKey);
      } catch (err) {
        // 빌림이 끝나면 다시 나온다(빌림은 두 배씩 는다). 일시 장애가 아닌 오류(버그)는 남긴다
        sig?.failed('process');
        if (!(err instanceof QueueStoreUnavailable)) this.o.logger?.error({ err, eventKey: it.eventKey }, '때가 된 탈퇴 사건을 처리하지 못했다');
      }
    }
    if (sig) {
      try {
        const oldest = await this.due.oldestDue();
        sig.lag(oldest === null ? 0 : Math.max(0, (this.clock.now() - oldest) / 1000));
      } catch {
        sig.failed('claim');
      }
    }
  }
}
