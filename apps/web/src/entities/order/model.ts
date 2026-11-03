// 주문 요약 목업(예매·주문 내역·결제 결과 화면이 읽는다). 상태는 d5 §10.3 '주문 상태 표본' 일곱 가지 이름 그대로다.
export type OrderStatus = '결제 완료' | '결제 완료·티켓 발급 중' | '결과 불명' | '입금 대기' | '일부 취소' | '결제 취소(발권 불가)' | '굿즈 배송 중';

export interface OrderSummary {
  id: string;
  kind: 'ticket' | 'goods';
  /** 티켓 주문이면 공연·회차 */
  productionId?: string;
  performanceId?: string;
  /** 굿즈 주문이면 상품 이름 */
  itemTitle?: string;
  /** '10/14(수) 20:07' */
  orderedText: string;
  status: OrderStatus;
  /** 결제 금액(원) */
  amount: number;
  quantity: number;
  /** 결제 수단 표시 */
  method: string;
  ticketIds: string[];
}

export const ORDERS: readonly OrderSummary[] = [
  { id: 'ord-20261014-0001', kind: 'ticket', productionId: 'prd-lumen', performanceId: 'evt-lumen-1025', orderedText: '10/14(수) 20:07', status: '결제 완료', amount: 308000, quantity: 2, method: '토스페이먼츠 · 카드', ticketIds: ['tkt-lumen-r1-0312', 'tkt-lumen-r1-0313'] },
  { id: 'ord-20261014-0002', kind: 'ticket', productionId: 'prd-lumen', performanceId: 'evt-lumen-1026', orderedText: '10/14(수) 20:21', status: '결제 완료·티켓 발급 중', amount: 110000, quantity: 1, method: '토스페이먼츠 · 카드', ticketIds: ['tkt-lumen-a1-1001'] },
  { id: 'ord-20261016-0003', kind: 'ticket', productionId: 'prd-fest', performanceId: 'evt-fest-1107', orderedText: '10/16(금) 20:03', status: '결과 불명', amount: 99000, quantity: 1, method: '포트원 · 간편결제', ticketIds: ['tkt-fest-std-0042'] },
  { id: 'ord-20261012-0004', kind: 'ticket', productionId: 'prd-musical', performanceId: 'evt-musical-1101', orderedText: '10/12(월) 20:11', status: '일부 취소', amount: 66000, quantity: 1, method: '가상계좌', ticketIds: ['tkt-musical-0207'] },
  { id: 'ord-20261020-0008', kind: 'ticket', productionId: 'prd-comedy', performanceId: 'evt-comedy-1113', orderedText: '10/20(화) 13:40', status: '입금 대기', amount: 88000, quantity: 2, method: '가상계좌', ticketIds: [] },
  { id: 'ord-20261008-0009', kind: 'ticket', productionId: 'prd-jazz-city', performanceId: 'evt-city-1031', orderedText: '10/8(목) 20:01', status: '결제 취소(발권 불가)', amount: 60000, quantity: 1, method: '토스페이먼츠 · 카드', ticketIds: [] },
  { id: 'ord-20261018-0010', kind: 'goods', itemTitle: 'LUMEN 공식 응원봉', orderedText: '10/18(일) 11:02', status: '굿즈 배송 중', amount: 35000, quantity: 1, method: '토스페이먼츠 · 카드', ticketIds: [] },
];

/** 대표 주문 id(예매·주문 내역 상세·결제 결과 경로 예시) */
export const DEMO_ORDER_ID = 'ord-20261014-0001';

export function getOrder(id: string): OrderSummary | undefined {
  return ORDERS.find((o) => o.id === id);
}
