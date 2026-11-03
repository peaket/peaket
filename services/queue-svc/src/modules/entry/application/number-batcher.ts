// 진입 ② 파드별 묶음(ADR-0179, docs/features/queue-admission.md §3 '② 파드별 묶음'). 같은 회차의 ②를 첫 요청부터 windowMs 동안,
// 또는 max건이 찰 때까지 모아 묶음 Lua 한 번으로 보낸다. 묶음 안 번호는 받은 순서대로다. 실패하면 그 묶음의 모든 요청이 같은 오류를 받는다.
import type { EntryStore, NumberBatchInput, NumberItem, NumberResult } from '../domain/ports.js';

type Common = Omit<NumberBatchInput, 'items'>;

interface Pending {
  common: Common;
  items: NumberItem[];
  waiters: { resolve: (r: NumberResult) => void; reject: (e: unknown) => void }[];
  timer: NodeJS.Timeout;
}

/** 공통 값의 모든 칸이 같은가(칸이 늘어도 빠뜨리지 않게 이름을 나열하지 않는다) */
const same = (a: Common, b: Common) => {
  const ka = Object.keys(a) as (keyof Common)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export class NumberBatcher {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly store: EntryStore,
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  take(common: Common, item: NumberItem): Promise<NumberResult> {
    let p = this.#pending.get(common.eventId);
    // 회차 일정 사본이 바뀌어 공통 값이 다르면(드묾) 모은 묶음을 먼저 보낸다
    if (p && !same(p.common, common)) {
      this.#flush(common.eventId);
      p = undefined;
    }
    if (!p) {
      const timer = setTimeout(() => this.#flush(common.eventId), this.windowMs);
      timer.unref();
      p = { common, items: [], waiters: [], timer };
      this.#pending.set(common.eventId, p);
    }
    const mine = p;
    return new Promise<NumberResult>((resolve, reject) => {
      mine.items.push(item);
      mine.waiters.push({ resolve, reject });
      if (mine.items.length >= this.max) this.#flush(common.eventId);
    });
  }

  #flush(eventId: string): void {
    const p = this.#pending.get(eventId);
    if (!p) return;
    this.#pending.delete(eventId);
    clearTimeout(p.timer);
    // 저장소가 동기로 던져도 대기 요청 모두가 같은 오류를 받게 Promise 안에서 부른다
    Promise.resolve()
      .then(() => this.store.numberBatch({ ...p.common, items: p.items }))
      .then(
        (rs) => p.waiters.forEach((w, k) => (rs[k] ? w.resolve(rs[k]) : w.reject(new Error('묶음 Lua가 요청 수보다 적게 돌려줬다')))),
        (err: unknown) => p.waiters.forEach((w) => w.reject(err)),
      );
  }
}
