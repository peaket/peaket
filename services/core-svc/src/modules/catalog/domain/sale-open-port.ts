// 판매 열기의 바깥 잇기 포트(BAT-616 LCH-080, ADR-0327). 판매 열기의 소유자는 purchase-svc이고 core-svc는 내부 HTTP로 부른다.
// 결과 이름: opened(이번에 열었다)·exists(이미 열려 있다)·no-layout(좌석맵 판이 없어 닫혔다)·unwired(주소를 잇지 않았다).
// 실패를 '열었다'로 바꾸지 않는다. 열기가 끝난 뒤에만 회차 판매 설정 사본을 쓴다(seat-hold §6 '판매 열기와의 차례').

export type SaleOpenResult = 'opened' | 'exists' | 'no-layout' | 'unwired';

export interface SaleOpenInput {
  eventId: string;
  productionId: string;
  /** 회차 오픈 시각(epoch ms) */
  openAtMs: number;
  /** 공연 시작 시각(epoch ms). 좌석 키 수명(판매 종료 + 1일)의 기준이다 */
  startsAtMs: number;
}

export interface SaleOpen {
  open(i: SaleOpenInput): Promise<SaleOpenResult>;
}

export const SALE_OPEN = Symbol('SALE_OPEN');
