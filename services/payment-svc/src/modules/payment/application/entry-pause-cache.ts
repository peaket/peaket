// 새 결제 일시 정지 행의 파드 메모리 캐시(docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현', ADR-0105, BUILD_ORDER PRF-201).
// 결제사 선택 캐시와 같은 꼴이고(겹친 호출은 읽기 하나를 함께 기다린다, 저장소 읽기는 고정 150ms [가정]) 다른 점은 읽기 실패다: 마지막 값을 쓰고 지표를 올린다.
// 정지 행이 없으면 '열림'이므로, 한 번도 읽지 못했거나 마지막 값이 10초 [가정]를 넘은 파드는 값을 지어내지 않고 실패한다(ASVS v5.0.0-16.5.3, BUILD_ORDER PRF-201 코드 리뷰).
// 이 파일의 EntryPauseReleaseWatcher는 캐시가 읽은 행에서 사람이 푼 해제를 보고 파드의 서킷을 닫는다(ADR-0105 결정 7 보완, BUILD_ORDER PRF-202 코드 리뷰).
import type { Clock } from '@peaket/platform';
import { PaymentDeadlineError } from '../domain/confirm-command.js';
import type { EntryPauses } from '../domain/entry-pause.js';
import { ENTRY_PAUSE_ACTOR_SYSTEM } from '../domain/entry-pause-judge.js';
import type { PgName } from '../domain/payment-gateway.js';
import type { CallBudget, EntryPauseReader, EntryPauseReadSignals } from '../domain/ports.js';

/** 정지 행을 다시 읽는 간격 1초 [가정](ADR-0105) */
export const ENTRY_PAUSE_CACHE_TTL_MS = 1_000;
/** 저장소 읽기 하나에 주는 시간 150ms [가정](결제사 선택 캐시와 같다) */
export const ENTRY_PAUSE_CACHE_READ_BUDGET_MS = 150;
/** 읽기가 실패해도 마지막 값을 쓸 수 있는 나이 10초 [가정](읽기를 시작한 때부터 잰다. 만료 작업이 답 없이 마지막 답을 쓰는 시간과 같다, ADR-0085) */
export const ENTRY_PAUSE_MAX_STALE_MS = 10_000;
/** setTimeout이 받는 가장 긴 시간(넘기면 곧바로 불린다) */
const MAX_TIMER_MS = 2_147_483_647;

export interface CachedEntryPauseReaderOptions {
  readonly reader: EntryPauseReader;
  /** 수명은 단조 시계로 잰다 */
  readonly clock: Pick<Clock, 'monotonicMs'>;
  readonly signals: EntryPauseReadSignals;
  readonly ttlMs?: number;
  /** 저장소에서 새로 읽은 행을 받는다(캐시로 답한 호출과 실패한 읽기에는 불리지 않는다). 던져도 읽기를 막지 않는다 */
  readonly onLoaded?: (pauses: EntryPauses) => void;
}

export interface EntryPauseReleaseWatcherDeps {
  /** 그 결제사의 이 파드 서킷을 닫는다. 던져도 읽기를 막지 않는다 */
  readonly closeCircuit: (pg: PgName) => void;
}

/**
 * 조회 경로만 고장이면 서킷이 스스로 닫히지 못해 사람이 풀어도 승인이 미뤄지고 곧바로 다시 멈춘다(ADR-0105 결정 7의 쓰는 때). 그래서 파드마다 사람이 푼 새 reopened_at을 보면 자기 서킷을 한 번 닫는다.
 * 같은 값에는 두 번 하지 않고, 파드가 새로 떴을 때 오래된 해제로 닫지 않게 첫 읽기는 기록만 한다.
 */
export class EntryPauseReleaseWatcher {
  #first = true;
  readonly #seen = new Map<PgName, number>();

  constructor(private readonly deps: EntryPauseReleaseWatcherDeps) {}

  observe(pauses: EntryPauses): void {
    const first = this.#first;
    this.#first = false;
    for (const [pg, row] of pauses) {
      if (row.reopenedAtMs === undefined || row.actor === undefined || row.actor === ENTRY_PAUSE_ACTOR_SYSTEM || this.#seen.get(pg) === row.reopenedAtMs) continue;
      this.#seen.set(pg, row.reopenedAtMs);
      if (!first) this.#close(pg);
    }
  }

  #close(pg: PgName): void {
    try {
      this.deps.closeCircuit(pg);
    } catch {
      // 삼킨다(서킷은 자기 시험 호출로도 닫힌다)
    }
  }
}

export class CachedEntryPauseReader implements EntryPauseReader {
  /** 단조 시계 기준의 끝 시각(ms). 읽기를 시작할 때 정한다(실패해도 1초 [가정] 뒤에 다시 읽게) */
  #expiresAtMs = Number.NEGATIVE_INFINITY;
  #last: EntryPauses | undefined;
  /** 마지막 값을 읽기 시작한 단조 시계 시각(ms) */
  #lastAtMs = Number.NEGATIVE_INFINITY;
  /** 돌고 있는 읽기. 무효화하면 비워 뒤에 오는 호출이 새로 읽게 한다 */
  #inFlight: Promise<EntryPauses> | undefined;

  constructor(private readonly o: CachedEntryPauseReaderOptions) {}

  /**
   * @param budget 이 호출에 남은 시간. 저장소 읽기의 시한이 아니라 이 호출이 기다릴 시한이다
   * @throws PaymentDeadlineError 쓸 수 있는 마지막 값이 없는데 이 호출의 시한 안에 읽기가 끝나지 않음
   * @throws Error 쓸 수 있는 마지막 값이 없고(한 번도 읽지 못했거나 10초 [가정]를 넘음) 읽기가 실패함(값을 지어내지 않는다)
   */
  read(budget?: CallBudget): Promise<EntryPauses> {
    const nowMs = this.o.clock.monotonicMs();
    const last = this.#usable(nowMs);
    if (last !== undefined && nowMs < this.#expiresAtMs) return Promise.resolve(last);
    return this.#within(this.#inFlight ?? this.#load(nowMs), budget);
  }

  /** 수명을 끝낸다. 제어 수신의 적용 확인(OPS-310)이 쓴다. 돌고 있는 읽기를 기다리던 호출은 그 값을 받고, 마지막 값은 남긴다 */
  invalidate(): void {
    this.#expiresAtMs = Number.NEGATIVE_INFINITY;
    this.#inFlight = undefined;
  }

  #load(nowMs: number): Promise<EntryPauses> {
    this.#expiresAtMs = nowMs + (this.o.ttlMs ?? ENTRY_PAUSE_CACHE_TTL_MS);
    const value: Promise<EntryPauses> = this.o.reader.read({ remainingMs: ENTRY_PAUSE_CACHE_READ_BUDGET_MS }).then(
      (pauses) => {
        if (this.#inFlight === value) {
          this.#last = pauses;
          this.#lastAtMs = nowMs;
          this.#inFlight = undefined;
          this.#notify(pauses);
        }
        return pauses;
      },
      (err: unknown) => {
        this.o.signals.entryPauseReadFailed();
        if (this.#inFlight === value) this.#inFlight = undefined;
        const last = this.#usable(this.o.clock.monotonicMs());
        if (last === undefined) {
          // 쓸 값이 없다: 다음 호출이 곧바로 다시 읽는다
          this.#expiresAtMs = Number.NEGATIVE_INFINITY;
          throw err;
        }
        return last;
      },
    );
    this.#inFlight = value;
    return value;
  }

  #notify(pauses: EntryPauses): void {
    try {
      this.o.onLoaded?.(pauses);
    } catch {
      // 삼킨다(알림이 읽기를 막지 않는다)
    }
  }

  /** 쓸 수 있는 마지막 값. 한 번도 읽지 못했거나 나이가 10초 [가정]를 넘으면 없다 */
  #usable(nowMs: number): EntryPauses | undefined {
    return nowMs - this.#lastAtMs <= ENTRY_PAUSE_MAX_STALE_MS ? this.#last : undefined;
  }

  /** 읽기가 끝나기를 이 호출의 시한만큼만 기다린다. 시한이 끝나면 쓸 수 있는 마지막 값을 쓴다 */
  #within(value: Promise<EntryPauses>, budget: CallBudget | undefined): Promise<EntryPauses> {
    if (budget === undefined || budget.remainingMs === Number.POSITIVE_INFINITY) return value;
    return new Promise<EntryPauses>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const last = this.#usable(this.o.clock.monotonicMs());
          if (last === undefined) reject(new PaymentDeadlineError());
          else resolve(last);
        },
        Math.min(Math.max(0, budget.remainingMs), MAX_TIMER_MS),
      );
      void value.finally(() => clearTimeout(timer)).then(resolve, reject);
    });
  }
}
