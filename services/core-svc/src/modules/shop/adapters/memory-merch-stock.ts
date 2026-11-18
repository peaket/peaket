// 굿즈 한정 재고 메모리 어댑터(단위 시험·개발). RedisMerchStock의 Lua와 같은 규칙을 한 번의 동기 처리로 한다(redis-merch-stock.ts 주석 참고).
// 키 수명은 다루지 않는다. 시험은 키를 지워(clearCounter, removeAll) 수명 끝·재시작을 흉내 낸다. failing을 참으로 두면 모든 호출이 StockUnavailable이다.
import { type MerchStock, type RebuildReservation, type ReserveInput, type ReserveResult, StockUnavailable } from '../domain/merch-ports.js';

interface Slot {
  stock: number | undefined;
  resv: Map<string, number>;
  resvQty: Map<string, number>;
  unpaid: Map<string, string>;
}

export class MemoryMerchStock implements MerchStock {
  readonly slots = new Map<string, Slot>();
  failing = false;

  #slot(productId: string): Slot {
    if (this.failing) throw new StockUnavailable();
    let s = this.slots.get(productId);
    if (!s) {
      s = { stock: undefined, resv: new Map(), resvQty: new Map(), unpaid: new Map() };
      this.slots.set(productId, s);
    }
    return s;
  }

  /** 시험용: 카운터를 바로 둔다 */
  setCounter(productId: string, value: number): void {
    this.#slot(productId).stock = value;
  }

  /** 시험용: 상품 슬롯의 키 넷을 모두 지운다(재시작 흉내) */
  removeAll(productId: string): void {
    this.slots.delete(productId);
  }

  async reserve(i: ReserveInput): Promise<ReserveResult> {
    const s = this.#slot(i.productId);
    const prev = s.unpaid.get(i.accountId);
    if (prev !== undefined && prev !== i.orderId && s.resv.has(prev)) return { kind: 'PREV', orderId: prev };
    if (s.stock === undefined) return { kind: 'NO_COUNTER' };
    if (s.resv.has(i.orderId)) return { kind: 'OK', remaining: s.stock };
    if (s.stock < i.quantity) return { kind: 'SOLD_OUT', remaining: s.stock };
    s.stock -= i.quantity;
    s.resv.set(i.orderId, i.untilMs);
    s.resvQty.set(i.orderId, i.quantity);
    s.unpaid.set(i.accountId, i.orderId);
    return { kind: 'OK', remaining: s.stock };
  }

  async release(productId: string, orderId: string, restore: boolean, accountId = ''): Promise<{ removed: boolean; restored: number }> {
    const s = this.#slot(productId);
    const removed = s.resv.delete(orderId);
    let restored = 0;
    if (removed) {
      const q = s.resvQty.get(orderId);
      s.resvQty.delete(orderId);
      if (restore && q !== undefined && s.stock !== undefined) {
        s.stock += q;
        restored = q;
      }
    }
    if (accountId !== '' && s.unpaid.get(accountId) === orderId) s.unpaid.delete(accountId);
    return { removed, restored };
  }

  async extend(productId: string, orderId: string, untilMs: number, accountId = ''): Promise<boolean> {
    const s = this.#slot(productId);
    const cur = s.resv.get(orderId);
    if (cur === undefined) return false;
    if (untilMs > cur) s.resv.set(orderId, untilMs);
    if (accountId !== '' && s.unpaid.get(accountId) === orderId) s.unpaid.delete(accountId);
    return true;
  }

  async clearUnpaid(productId: string, accountId: string, orderId: string): Promise<boolean> {
    const s = this.#slot(productId);
    if (s.unpaid.get(accountId) !== orderId) return false;
    s.unpaid.delete(accountId);
    return true;
  }

  async rebuild(productId: string, stock: number, reservations: readonly RebuildReservation[]): Promise<boolean> {
    const s = this.#slot(productId);
    if (s.stock !== undefined) return false;
    let sum = 0;
    for (const r of reservations) {
      sum += r.quantity;
      if (!s.resv.has(r.orderId)) s.resv.set(r.orderId, r.untilMs);
      if (!s.resvQty.has(r.orderId)) s.resvQty.set(r.orderId, r.quantity);
      if (!s.unpaid.has(r.accountId)) s.unpaid.set(r.accountId, r.orderId);
    }
    s.stock = Math.max(0, stock - sum);
    return true;
  }

  async due(productId: string, nowMs: number, limit: number): Promise<string[]> {
    const s = this.#slot(productId);
    return [...s.resv.entries()]
      .filter(([, at]) => at <= nowMs)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => id);
  }

  async defer(productId: string, orderId: string, untilMs: number): Promise<void> {
    const s = this.#slot(productId);
    if (s.resv.has(orderId)) s.resv.set(orderId, untilMs);
  }

  async clearCounter(productId: string): Promise<void> {
    this.#slot(productId).stock = undefined;
  }
}
