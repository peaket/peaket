// R-T45 ④: purchase GetEventRefundJob의 최근 5분 시도 집계(F-07-15 I-06, AC-12).
// 호출=SUCCESS+FAILURE+UNKNOWN, 실패=FAILURE+UNKNOWN, REJECT=제외, attempted_at > 지금 − 5분만 센다.
// 기준 트리에는 recent 집계와 progress 칸이 없어 실행 중 실패한다.
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundCanceller, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';

const NOW = Date.parse('2026-11-27T03:00:00.000Z');
const REQUEST = '0193a000-0000-7000-8000-000000000001';
const EVENT = '0193a000-0000-7000-8000-000000000002';
const TICKET = '0193a000-0000-7000-8000-000000000004';
const TICKET2 = '0193a000-0000-7000-8000-000000000005';
const target = (ticketId: string, pg: 'TOSS' | 'PORTONE') => ({
  orderId: '0193a000-0000-7000-8000-000000000003',
  ticketId,
  seatId: '0193a000-0000-7000-8000-000000000006',
  payerAccountId: '0193a000-0000-7000-8000-000000000007',
  ticketPrice: 10_000,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg,
});

describe('R-T45 ④ 최근 5분 시도 집계', () => {
  test('R-T45 ④ SUCCESS·FAILURE·UNKNOWN만 세고 REJECT와 5분 경계 밖은 뺀다', async () => {
    const store = new MemoryEventRefundStore();
    const targets: EventRefundTargets = { list: async () => [target(TICKET, 'TOSS'), target(TICKET2, 'PORTONE')] };
    const canceller: EventRefundCanceller = { cancel: async () => ({ status: 'REFUNDED' }) };
    const attempts = {
      record: async () => undefined,
      window: async () => ({ calls: 0, failures: 0, rejects: 0, failedAmount: 0 }),
      windowAll: async () => ({ calls: 0, failures: 0, rejects: 0, failedAmount: 0 }),
      consecutiveFailures: async () => 0,
      recent: async (sinceMs: number) =>
        [
          { pg: 'TOSS' as const, outcome: 'SUCCESS' as const, atMs: NOW - 299_999 },
          { pg: 'TOSS' as const, outcome: 'FAILURE' as const, atMs: NOW - 300_000 },
          { pg: 'TOSS' as const, outcome: 'UNKNOWN' as const, atMs: NOW - 1 },
          { pg: 'TOSS' as const, outcome: 'REJECT' as const, atMs: NOW - 2 },
          { pg: 'TOSS' as const, outcome: 'FAILURE' as const, atMs: NOW - 300_001 },
          { pg: 'PORTONE' as const, outcome: 'SUCCESS' as const, atMs: NOW - 1_000 },
        ].filter((a) => a.atMs > sinceMs),
    };
    const service = new EventRefundService({
      store,
      targets,
      canceller,
      attempts: attempts as never,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
      concurrency: 2,
    });
    await service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });
    const view = (await service.get(REQUEST)) as unknown as { progress: { perPg: Array<{ pg: string; recentCalls?: number; recentFailures?: number }> } };
    const toss = view.progress.perPg.find((p) => p.pg === 'TOSS')!;
    expect(toss).toMatchObject({ recentCalls: 2, recentFailures: 1 });
    const portone = view.progress.perPg.find((p) => p.pg === 'PORTONE')!;
    expect(portone).toMatchObject({ recentCalls: 1, recentFailures: 0 });
  });
});
