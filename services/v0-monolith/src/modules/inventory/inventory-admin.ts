// 모듈 공개 함수: 좌석 열기와 만료 한 번. HTTP로 열지 않는다(관리 API 없음, docs/features/seat-hold.md §14 동작 8).
// 시험·부하 시험 준비 스크립트가 부른다.
import type { Database } from '@peaket/platform';
import { DrizzleSeatStore } from './adapters/db/drizzle-seat-store.js';
import { EVENT_ID_PATTERN, EXPIRE_BATCH, isEpochMs, normalizeSeatConfig, validateSeats, type SeatDefinition, type SeatEventConfig } from './domain/inventory.js';

export interface SeatAdmin {
  /**
   * 좌석을 연다. 다시 부르면 설정을 바꾸고 새 좌석만 더한다(이미 있는 좌석의 상태는 그대로).
   * 회차 ID·좌석 칸·설정 범위가 틀리면 던진다
   */
  open(eventId: string, config: SeatEventConfig, seats: SeatDefinition[]): Promise<void>;
  /** 만료 시각이 지난 홀드를 푼다(nowMs는 유닉스 밀리초). 푼 홀드 수 */
  expire(nowMs: number): Promise<number>;
}

export function createSeatAdmin(database: Database): SeatAdmin {
  const store = new DrizzleSeatStore(database);
  return {
    async open(eventId, config, seats) {
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) throw new RangeError('회차 ID 형식이 아니다');
      const normalized = normalizeSeatConfig(config);
      validateSeats(seats);
      await store.open(eventId, normalized, seats);
    },
    async expire(nowMs) {
      if (!isEpochMs(nowMs)) throw new RangeError(`시각은 유닉스 밀리초 정수다: ${String(nowMs)}`);
      return store.expireDue(nowMs, EXPIRE_BATCH);
    },
  };
}
