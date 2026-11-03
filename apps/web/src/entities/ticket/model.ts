// 티켓 요약 목업(마이 티켓·양도·취소 화면이 읽는다). 상태는 d5 §10.3 '티켓 상태 표본' 여덟 가지 이름 그대로다.
export type TicketStatus = '사용 가능' | '키 없음' | '양도 요청 중' | '받은 티켓' | '취소 접수' | '입장함' | '공연 취소됨' | '지난 공연';

export interface TicketSummary {
  id: string;
  performanceId: string;
  productionId: string;
  orderId: string;
  /** 'R석 · R구역 12열 7번'(보드 표기) */
  seatLabel: string;
  grade: string;
  price: number;
  status: TicketStatus;
  /** 지금 가진 사람 표시 이름 */
  holderName: string;
}

export const TICKETS: readonly TicketSummary[] = [
  { id: 'tkt-lumen-r1-0312', performanceId: 'evt-lumen-1025', productionId: 'prd-lumen', orderId: 'ord-20261014-0001', seatLabel: 'R석 · R구역 12열 7번', grade: 'R석', price: 154000, status: '사용 가능', holderName: '지민' },
  { id: 'tkt-lumen-r1-0313', performanceId: 'evt-lumen-1025', productionId: 'prd-lumen', orderId: 'ord-20261014-0001', seatLabel: 'R석 · R구역 12열 8번', grade: 'R석', price: 154000, status: '양도 요청 중', holderName: '지민' },
  { id: 'tkt-lumen-a1-1001', performanceId: 'evt-lumen-1026', productionId: 'prd-lumen', orderId: 'ord-20261014-0002', seatLabel: 'A석 · A1구역 10열 1번', grade: 'A석', price: 110000, status: '키 없음', holderName: '지민' },
  { id: 'tkt-fest-std-0042', performanceId: 'evt-fest-1107', productionId: 'prd-fest', orderId: 'ord-20261016-0003', seatLabel: '스탠딩 · 입장 순번 42', grade: '스탠딩', price: 99000, status: '받은 티켓', holderName: '지민' },
  { id: 'tkt-musical-0207', performanceId: 'evt-musical-1101', productionId: 'prd-musical', orderId: 'ord-20261012-0004', seatLabel: '전석 · 2열 7번', grade: '전석', price: 66000, status: '취소 접수', holderName: '지민' },
  { id: 'tkt-city-0105', performanceId: 'evt-city-1031', productionId: 'prd-jazz-city', orderId: 'ord-20261008-0005', seatLabel: '전석 · 1열 5번', grade: '전석', price: 60000, status: '입장함', holderName: '지민' },
  { id: 'tkt-garden-0310', performanceId: 'evt-garden-1101', productionId: 'prd-classic-garden', orderId: 'ord-20261010-0006', seatLabel: 'S석 · 3열 10번', grade: 'S석', price: 55000, status: '공연 취소됨', holderName: '지민' },
  { id: 'tkt-old-0001', performanceId: 'evt-city-1031', productionId: 'prd-jazz-city', orderId: 'ord-20260901-0007', seatLabel: '전석 · 4열 1번', grade: '전석', price: 60000, status: '지난 공연', holderName: '지민' },
];

/** 대표 티켓 id(마이 티켓 상세·양도·취소 경로 예시) */
export const DEMO_TICKET_ID = 'tkt-lumen-r1-0312';

export function getTicket(id: string): TicketSummary | undefined {
  return TICKETS.find((t) => t.id === id);
}
