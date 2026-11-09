// 결제사 선택 재료의 파드 메모리 캐시(docs/features/payment.md §2.2 '선택기의 첫 구현', BUILD_ORDER PRF-190).
// 회차마다 1초 [가정] 두고, 같은 회차의 겹친 호출은 읽기 하나를 함께 기다린다. 읽기 실패는 캐시하지 않고 오래된 값을 쓰지 않는다.
// 함께 쓰는 읽기라 저장소 읽기는 어느 호출의 남은 시간에도 묶지 않고 고정 150ms [가정]로 하고, 호출마다 자기 시한을 따로 잰다(코드 리뷰).
import type { Clock } from '@peaket/platform';
import { PaymentDeadlineError } from '../domain/confirm-command.js';
import type { PgSelectionState } from '../domain/pg-selection.js';
import type { CallBudget, PgSelectionReader } from '../domain/ports.js';

/** 캐시 수명 1초 [가정] */
export const PG_SELECTION_CACHE_TTL_MS = 1_000;
/** 파드마다 두는 회차 수 상한 10,000 [가정] */
export const PG_SELECTION_CACHE_MAX_EVENTS = 10_000;
/** 저장소 읽기 하나에 주는 시간 150ms [가정](PrepareCheckout 데드라인 300ms 안, docs/data.md §5.1) */
export const PG_SELECTION_CACHE_READ_BUDGET_MS = 150;
/** setTimeout이 받는 가장 긴 시간(넘기면 곧바로 불린다) */
const MAX_TIMER_MS = 2_147_483_647;

export interface CachedPgSelectionReaderOptions {
  readonly reader: PgSelectionReader;
  /** 수명은 단조 시계로 잰다(벽시계를 고쳐도 늘거나 줄지 않게) */
  readonly clock: Pick<Clock, 'monotonicMs'>;
  readonly ttlMs?: number;
  readonly maxEvents?: number;
}

interface Entry {
  /** 단조 시계 기준의 끝 시각(ms) */
  readonly expiresAtMs: number;
  readonly value: Promise<PgSelectionState>;
  /** 읽기가 끝나면 차는 값(이미 끝난 호출에 타이머를 걸지 않으려고 둔다) */
  state?: PgSelectionState;
}

export class CachedPgSelectionReader implements PgSelectionReader {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly o: CachedPgSelectionReaderOptions) {}

  /**
   * @param budget 이 호출에 남은 시간. 저장소 읽기의 시한이 아니라 이 호출이 기다릴 시한이다
   * @throws PaymentDeadlineError 이 호출의 시한 안에 읽기가 끝나지 않음(읽기는 뒤따라온 호출을 위해 이어 간다)
   */
  read(eventId: string, budget?: CallBudget): Promise<PgSelectionState> {
    const nowMs = this.o.clock.monotonicMs();
    const hit = this.#entries.get(eventId);
    return this.#within(hit !== undefined && nowMs < hit.expiresAtMs ? hit : this.#load(eventId, nowMs), budget);
  }

  /**
   * 캐시를 비운다. eventId가 없으면 모든 회차다(플랫폼 전환). 제어 수신의 적용 확인(OPS-310)이 쓴다.
   * 돌고 있는 읽기를 이미 기다리던 호출은 그 값을 받고, 뒤에 오는 호출은 다시 읽는다.
   */
  invalidate(eventId?: string): void {
    if (eventId === undefined) this.#entries.clear();
    else this.#entries.delete(eventId);
  }

  #load(eventId: string, nowMs: number): Entry {
    const value = this.o.reader.read(eventId, { remainingMs: PG_SELECTION_CACHE_READ_BUDGET_MS });
    const entry: Entry = { expiresAtMs: nowMs + (this.o.ttlMs ?? PG_SELECTION_CACHE_TTL_MS), value };
    // 지우고 다시 넣어 Map의 차례가 넣은 차례가 되게 한다(가장 먼저 넣은 회차를 버린다)
    this.#entries.delete(eventId);
    this.#entries.set(eventId, entry);
    if (this.#entries.size > (this.o.maxEvents ?? PG_SELECTION_CACHE_MAX_EVENTS)) this.#entries.delete(this.#entries.keys().next().value!);
    void value.then(
      (state) => {
        entry.state = state;
      },
      () => {
        if (this.#entries.get(eventId) === entry) this.#entries.delete(eventId);
      },
    );
    return entry;
  }

  /** 읽기가 끝나기를 이 호출의 시한만큼만 기다린다 */
  #within(entry: Entry, budget: CallBudget | undefined): Promise<PgSelectionState> {
    if (entry.state !== undefined || budget === undefined || budget.remainingMs === Number.POSITIVE_INFINITY) return entry.value;
    return new Promise<PgSelectionState>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PaymentDeadlineError()), Math.min(Math.max(0, budget.remainingMs), MAX_TIMER_MS));
      void entry.value.finally(() => clearTimeout(timer)).then(resolve, reject);
    });
  }
}
