// 모듈 공개 함수: 가격 넣기. HTTP로 하지 않는다(docs/features/payment.md §13 동작 4). 시험·부하 시험 준비 스크립트가 부른다.
import type { Database } from '@peaket/platform';
import { EVENT_ID_PATTERN } from '../inventory/index.js';
import { DrizzleOrderStore } from './adapters/db/drizzle-order-store.js';
import { GRADE_PATTERN, MAX_PRICE, MIN_PRICE } from './domain/booking.js';

export interface BookingAdmin {
  /**
   * 회차의 좌석 등급별 가격(원)을 넣는다. 이미 있는 등급은 값을 바꾼다.
   * 회차 ID 형식, 등급 이름(제어 문자 없는 1~30자), 가격(1~100,000,000 정수)이 틀리거나 등급이 하나도 없으면 거절한다(RangeError로 거절된 Promise)
   */
  setPrices(eventId: string, prices: Record<string, number>): Promise<void>;
}

export function createBookingAdmin(database: Database): BookingAdmin {
  const store = new DrizzleOrderStore(database);
  return {
    async setPrices(eventId, prices) {
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) throw new RangeError('회차 ID 형식이 아니다');
      if (typeof prices !== 'object' || prices === null || Array.isArray(prices)) throw new RangeError('가격은 {등급: 원} 객체다');
      const entries = Object.entries(prices);
      if (entries.length === 0) throw new RangeError('등급이 하나도 없다');
      for (const [grade, price] of entries) {
        if (!GRADE_PATTERN.test(grade)) throw new RangeError('등급 이름은 제어 문자 없는 1~30자다');
        if (!(Number.isInteger(price) && price >= MIN_PRICE && price <= MAX_PRICE)) throw new RangeError(`가격은 ${MIN_PRICE}~${MAX_PRICE} 정수다: ${String(price)}`);
      }
      await store.setPrices(eventId, new Map(entries));
    },
  };
}
