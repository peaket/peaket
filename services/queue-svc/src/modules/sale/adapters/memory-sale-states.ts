// 시험용 판매 상태 저장소(Valkey 어댑터 redis-sale-states.ts의 Lua와 같은 규칙).
import type { SaleApplyResult, SaleChange, SaleStates } from '../domain/sale.js';

export class MemorySaleStates implements SaleStates {
  readonly #notice = new Map<string, Map<string, string>>();
  readonly #expireAt = new Map<string, number>();
  readonly #seq = new Map<string, number>();
  /** 다음 쓰기를 실패시킨다(대기열 Redis 일시 장애 흉내) */
  failNext: unknown = null;

  async apply(c: SaleChange): Promise<SaleApplyResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const n = this.#notice.get(c.eventId) ?? new Map<string, string>();
    const cur = Number(n.get('saleVersion') ?? Number.NaN);
    if (Number.isFinite(cur) && cur >= c.version) {
      if (c.extendOnStale) this.#expireAt.set(c.eventId, Math.max(this.#expireAt.get(c.eventId) ?? -1, c.expireAtMs));
      return { kind: 'STALE' };
    }
    n.set('saleState', c.state).set('saleVersion', String(c.version)).set('soldOutTiers', JSON.stringify(c.soldOutTiers));
    let sold: number | undefined;
    if (c.state === 'SOLD_OUT') {
      sold = this.#seq.get(c.eventId) ?? 0;
      n.set('soldOutLastSeq', String(sold));
    }
    this.#notice.set(c.eventId, n);
    this.#expireAt.set(c.eventId, Math.max(this.#expireAt.get(c.eventId) ?? -1, c.expireAtMs));
    return sold === undefined ? { kind: 'APPLIED' } : { kind: 'APPLIED', soldOutLastSeq: sold };
  }

  // 시험 도구
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
