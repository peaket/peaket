// 좌석 판매(docs/features/seat-hold.md §14 동작 9). booking 모듈이 이 모듈의 공개 함수로 부른다. HTTP 경로는 없다.

/** 주문에 넣을 좌석(가격을 정할 등급과 함께) */
export interface SaleSeat {
  seatId: string;
  grade: string;
}

/** 주문을 만들 때 읽는 홀드. 좌석은 홀드에 적힌 순서다 */
export interface SaleHold {
  holdId: string;
  eventId: string;
  accountId: string;
  seats: SaleSeat[];
  expiresAtMs: number;
}

/** 홀드 읽기(동작 9 ③). 그 계정의 홀드가 아니거나 없으면 hold-not-found, HELD가 아니거나 만료 시각이 지났으면 hold-expired */
export type SaleHoldResult = { kind: 'ok'; hold: SaleHold } | { kind: 'hold-not-found' } | { kind: 'hold-expired' };

/** 판매로 바꾸기(동작 9 ①) */
export type SellResult = { kind: 'sold'; eventId: string; seatIds: string[] } | { kind: 'hold-not-found' } | { kind: 'hold-expired' } | { kind: 'busy' };

/** 판매 되돌리기(동작 9 ②). 그 주문으로 판 좌석이 없으면(이미 되돌렸거나 판 적 없음) not-sold */
export type UnsellResult = { kind: 'returned'; seatIds: string[] } | { kind: 'not-sold' } | { kind: 'busy' };

export interface SeatSales {
  /** 아무것도 바꾸지 않는다. nowMs는 유닉스 밀리초 */
  holdForOrder(holdId: string, accountId: string, nowMs: number): Promise<SaleHoldResult>;
  /** 그 계정의 살아 있는 홀드만 판다. 좌석 SOLD(order_id), 홀드 SOLD, held → sold, 변경분 SOLD */
  sell(holdId: string, accountId: string, orderId: string, nowMs: number): Promise<SellResult>;
  /** 그 홀드로 그 주문에 판 좌석을 AVAILABLE로, 홀드를 RELEASED로 되돌리고 sold를 줄인다. 변경분 AVAILABLE */
  unsell(holdId: string, orderId: string, nowMs: number): Promise<UnsellResult>;
}
