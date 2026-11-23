// 대상마다 수집 간격(docs/observability.md §5 '진단 증거' 수집하는 경보, 시험 D-T51 ②).
// 마지막 수집을 시작한 뒤 간격 안의 경보는 다시 뜨지 않고(throttled), 같은 대상의 수집이 도는 중이면 겹쳐 돌리지 않는다.
// 간격은 메모리에만 두므로 수집기가 다시 뜨면 처음부터 센다. 시각은 단조 시계(ms)로 받는다.

export class TargetSchedule {
  readonly #intervalMs: number;
  readonly #lastStart = new Map<string, number>();
  readonly #running = new Set<string>();

  constructor(intervalMs: number) {
    this.#intervalMs = intervalMs;
  }

  /** 지금 뜰 수 있으면 시작을 적고 true. 도는 중이거나 간격 안이면 false(throttled) */
  tryStart(target: string, nowMonotonicMs: number): boolean {
    if (this.#running.has(target)) return false;
    const last = this.#lastStart.get(target);
    if (last !== undefined && nowMonotonicMs - last < this.#intervalMs) return false;
    this.#lastStart.set(target, nowMonotonicMs);
    this.#running.add(target);
    return true;
  }

  finish(target: string): void {
    this.#running.delete(target);
  }
}
