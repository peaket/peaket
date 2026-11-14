// 판매 중지 원본(sale_control)과 사본(s:{event:E}:ctl)의 포트(ADR-0103·0123). 도메인은 DB·Redis를 모른다.
import type { SaleControl, SaleSuspensionApplied, SaleSuspensionWrite } from './sale-control.js';

export const SALE_CONTROL_STORE = Symbol('purchase.SaleControlStore');
export interface SaleControlStore {
  /** 회차 범위 행. 없으면 undefined */
  find(eventId: string): Promise<SaleControl | undefined>;
  /**
   * 판매 중지·재개를 조건부로 쓴다. 같은 명령이 같은 상태를 다시 쓰면 아무것도 바꾸지 않고 changed 거짓이다.
   * 그 밖에는 판 번호를 하나 올리고 changed 참이다(같은 범위에서 늘어나기만 한다).
   */
  apply(write: SaleSuspensionWrite): Promise<SaleSuspensionApplied>;
}

/** 좌석 Redis 사본 쓰기. 실패하면 던진다(명령은 FAILED로 남고 재시도가 다시 쓴다) */
export const SALE_CONTROL_COPIES = Symbol('purchase.SaleControlCopies');
export interface SaleControlCopies {
  /**
   * s:{event:E}:ctl에 suspended('1'·'0')·suspRef·rev·cmd를 쓴다. paused·allPaused 같은 다른 칸은 건드리지 않는다.
   * 같은 값으로 여러 번 써도 같다(멱등).
   */
  write(c: Pick<SaleControl, 'eventId' | 'suspended' | 'revision' | 'commandId' | 'suspensionRef'>): Promise<void>;
}
