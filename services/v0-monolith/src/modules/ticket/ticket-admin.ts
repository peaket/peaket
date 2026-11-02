// 모듈 공개 함수: 검표 스태프 배정. HTTP로 열지 않는다(docs/features/offline-gate.md §13 동작 3). 시험·준비 스크립트가 부른다.
import type { Database } from '@peaket/platform';
import { EVENT_ID_PATTERN } from '../inventory/index.js';
import { DrizzleTicketStore } from './adapters/db/drizzle-ticket-store.js';

export interface TicketAdmin {
  /** 그 회차의 검표 스태프 계정을 더한다(이미 있으면 그대로). 회차 ID 형식이 틀리거나 계정 ID가 1~1024자 글이 아니면 거절한다(RangeError로 거절된 Promise) */
  assignStaff(eventId: string, accountIds: string[]): Promise<void>;
}

export function createTicketAdmin(database: Database): TicketAdmin {
  const store = new DrizzleTicketStore(database);
  return {
    async assignStaff(eventId, accountIds) {
      if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId)) throw new RangeError('회차 ID 형식이 아니다');
      if (!Array.isArray(accountIds)) throw new RangeError('계정 ID 목록이 아니다');
      for (const a of accountIds) {
        if (!(typeof a === 'string' && a.length >= 1 && a.length <= 1024)) throw new RangeError('계정 ID는 1~1024자 글이다');
      }
      await store.assignStaff(eventId, accountIds);
    },
  };
}
