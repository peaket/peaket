// 시험용 판매 상태 저장소(Valkey 어댑터 redis-sale-states.ts의 Lua와 같은 규칙).
import type { SaleApplyOutcome, SaleChange, SaleStates } from '../domain/sale.js';

export class MemorySaleStates implements SaleStates {
  readonly #notice = new Map<string, Map<string, string>>();
  readonly #expireAt = new Map<string, number>();
  readonly #seq = new Map<string, number>();
  /** 다음 쓰기를 실패시킨다(대기열 Redis 일시 장애 흉내) */
  failNext: unknown = null;

  async apply(c: SaleChange): Promise<SaleApplyOutcome> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const n = this.#notice.get(c.eventId) ?? new Map<string, string>();
    const cur = Number(n.get('saleVersion') ?? Number.NaN);
    if (Number.isFinite(cur) && cur >= c.version) {
      if (cur === c.version) this.#counts(n, c);
      if (c.extendOnStale) this.#expireAt.set(c.eventId, Math.max(this.#expireAt.get(c.eventId) ?? -1, c.expireAtMs));
      return { kind: 'STALE', current: { state: n.get('saleState') ?? '', version: cur } };
    }
    n.set('saleState', c.state).set('saleVersion', String(c.version)).set('soldOutTiers', JSON.stringify(c.soldOutTiers));
    let sold: number | undefined;
    if (c.state === 'SOLD_OUT') {
      sold = this.#seq.get(c.eventId) ?? 0;
      n.set('soldOutLastSeq', String(sold));
    }
    this.#counts(n, c);
    this.#notice.set(c.eventId, n);
    this.#expireAt.set(c.eventId, Math.max(this.#expireAt.get(c.eventId) ?? -1, c.expireAtMs));
    const current = { state: c.state, version: c.version };
    return sold === undefined ? { kind: 'APPLIED', current } : { kind: 'APPLIED', soldOutLastSeq: sold, current };
  }

  /** 셈 칸: 셈 시각이 둔 것보다 늦을 때만 쓰고, 평균이 없으면 칸을 지운다 */
  #counts(n: Map<string, string>, c: SaleChange): void {
    const k = c.counts;
    if (!k) return;
    const at = Number(n.get('seatsAtMs') ?? Number.NaN);
    if (Number.isFinite(at) && at >= k.countedAtMs) return;
    n.set('remainingSeats', String(k.remaining)).set('seatsAtMs', String(k.countedAtMs));
    if (k.avgTicketsPerOrder === undefined) n.delete('avgTicketsPerOrder');
    else n.set('avgTicketsPerOrder', String(k.avgTicketsPerOrder));
  }

  async current(eventId: string): Promise<{ state: string; version: number } | null> {
    const n = this.#notice.get(eventId);
    const v = Number(n?.get('saleVersion') ?? Number.NaN);
    const state = n?.get('saleState');
    return state && Number.isFinite(v) ? { state, version: v } : null;
  }

  // 시험 도구
  dropNoticeForTest(eventId: string): void {
    this.#notice.delete(eventId);
  }

  setSeqForTest(eventId: string, seq: number): void {
    this.#seq.set(eventId, seq);
  }

  setNoticeForTest(eventId: string, fields: Record<string, string>): void {
    const n = this.#notice.get(eventId) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) n.set(k, v);
    this.#notice.set(eventId, n);
  }

  noticeOf(eventId: string): Record<string, string> {
    return Object.fromEntries(this.#notice.get(eventId) ?? []);
  }

  expireAtOf(eventId: string): number | null {
    return this.#expireAt.get(eventId) ?? null;
  }
}
