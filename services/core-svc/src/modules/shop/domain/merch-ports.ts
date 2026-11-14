// shop 주문·정산 원천 저장 포트. 주문을 만드는 경로는 아직 없고, 읽기와 시험용 넣기만 둔다.
import type { AttendeeRecord, MerchOrderItemRecord, MerchOrderRecord, ProductSettlementItem } from './merch.js';

export interface MerchOrderStore {
  /** 그 회차의 주문 항목(명단 원천). 환불·취소된 주문/항목은 뺀다. */
  listAttendees(promoterId: string, eventId: string, limit: number, cursor?: string): Promise<AttendeeRecord[]>;
  countAttendees(promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }>;
  /** 정산 기준일이 [from, to]에 든 항목(상품 정산서 원천). */
  listSettlementItems(from: string, to: string): Promise<ProductSettlementItem[]>;
  /** 시험·개발용. 운영에서는 주문을 만드는 경로가 다른 서비스다. */
  insertOrder(order: MerchOrderRecord, items: readonly MerchOrderItemRecord[]): Promise<void>;
}

export const MERCH_ORDER_STORE = Symbol.for('peaket.shop.merch-order-store');
