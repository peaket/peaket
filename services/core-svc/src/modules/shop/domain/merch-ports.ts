// shop 주문·정산 원천 저장 포트. 주문을 만드는 경로는 아직 없고, 읽기와 시험용 넣기만 둔다.
import type { MerchOrderItemRecord, MerchOrderRecord, ProductSettlementItem } from './merch.js';

// 명단 원천(listAttendees·countAttendees)은 이 포트에 두지 않는다. 운영은 purchase-svc 내부 HTTP(A2-03), 메모리 조립은 MemoryMerchOrderStore를 직접 쓴다(W7-audit A2-17)
export interface MerchOrderStore {
  /** 정산 기준일이 [from, to]에 든 항목(상품 정산서 원천). */
  listSettlementItems(from: string, to: string): Promise<ProductSettlementItem[]>;
  /** 시험·개발용. 운영에서는 주문을 만드는 경로가 다른 서비스다. */
  insertOrder(order: MerchOrderRecord, items: readonly MerchOrderItemRecord[]): Promise<void>;
}

export const MERCH_ORDER_STORE = Symbol.for('peaket.shop.merch-order-store');
