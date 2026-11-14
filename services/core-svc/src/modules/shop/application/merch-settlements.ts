// 상품 정산서 원천(settlement §4.5 'shop에서 넘겨받는 값'). payment-svc가 주 단위로 읽어 간다.
import type { MerchOrderStore } from '../domain/merch-ports.js';
import { MerchProblem, kstDayStart, type ProductSettlementItem } from '../domain/merch.js';

export interface ProductSettlementQuery {
  from: string;
  to: string;
}

export class MerchSettlements {
  constructor(private readonly store: MerchOrderStore) {}

  async list(q: ProductSettlementQuery): Promise<{ items: ProductSettlementItem[]; from: string; to: string }> {
    const from = kstDayStart(q.from);
    const to = kstDayStart(q.to);
    if (to.getTime() < from.getTime()) throw new MerchProblem('invalid-query', 400, '시작일이 끝일보다 늦습니다');
    if (to.getTime() - from.getTime() > 92 * 24 * 60 * 60 * 1000) throw new MerchProblem('invalid-query', 400, '한 번에 92일까지만 읽을 수 있습니다');
    return { items: await this.store.listSettlementItems(q.from, q.to), from: q.from, to: q.to };
  }
}
