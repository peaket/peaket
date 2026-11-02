// 모듈 공개 함수: 좌석 판매(docs/features/seat-hold.md §14 동작 9). booking 모듈이 부른다(HTTP 경로 없음).
import type { Database } from '@peaket/platform';
import { DrizzleSeatSales } from './adapters/db/drizzle-seat-sales.js';
import { isEpochMs } from './domain/inventory.js';
import type { SeatSales } from './domain/sales.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function check(holdId: unknown, nowMs: unknown, more: { accountId?: unknown; orderId?: unknown }): void {
  if (typeof holdId !== 'string' || !UUID.test(holdId)) throw new RangeError('홀드 ID는 UUID다');
  if ('accountId' in more && !(typeof more.accountId === 'string' && more.accountId.length >= 1 && more.accountId.length <= 1024)) {
    throw new RangeError('계정 ID는 1~1024자 글이다');
  }
  if ('orderId' in more && !(typeof more.orderId === 'string' && UUID.test(more.orderId))) throw new RangeError('주문 ID는 UUID다');
  if (typeof nowMs !== 'number' || !isEpochMs(nowMs)) throw new RangeError(`시각은 유닉스 밀리초 정수다: ${String(nowMs)}`);
}

/** 판매 함수 묶음. 홀드 ID·주문 ID가 UUID가 아니거나 계정 ID가 1~1024자 글이 아니거나 시각이 유닉스 밀리초 정수가 아니면 거절한다(RangeError로 거절된 Promise) */
export function createSeatSales(database: Database): SeatSales {
  const store = new DrizzleSeatSales(database);
  return {
    async holdForOrder(holdId, accountId, nowMs) {
      check(holdId, nowMs, { accountId });
      return store.holdForOrder(holdId, accountId, nowMs);
    },
    async sell(holdId, accountId, orderId, nowMs) {
      check(holdId, nowMs, { accountId, orderId });
      return store.sell(holdId, accountId, orderId, nowMs);
    },
    async unsell(holdId, orderId, nowMs) {
      check(holdId, nowMs, { orderId });
      return store.unsell(holdId, orderId, nowMs);
    },
  };
}
