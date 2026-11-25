// F-05-11 연기 확정의 양도 요청 철회 시험(계획 docs/review/plans/F-05-11.md §4·§5 T4).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). EventRefundService의 transfers 포트는 아직 없다(기준 트리에서 호출 0).
// 정본: docs/features/transfer-refund.md §5 '진행 중인 양도 요청'·'연기 철회의 첫 구현'·§11 R-T25 ③.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundCanceller, EventRefundStartInput, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
import type { EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const NOW = Date.parse('2026-12-01T05:00:00.000Z');
const REQUEST = '0193a000-0000-7000-8000-000000511001';
const EVENT = '0193a000-0000-7000-8000-000000511002';
const ORDER = '0193a000-0000-7000-8000-000000511003';
const TICKET = '0193a000-0000-7000-8000-000000511004';

const target = (): EventRefundTarget => ({
  orderId: ORDER,
  ticketId: TICKET,
  seatId: '0193a000-0000-7000-8000-000000511005',
  payerAccountId: '0193a000-0000-7000-8000-000000511006',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
});

type TransferWithdrawals = { withdrawForEvent(i: { eventId: string; nowMs: number }): Promise<{ withdrawn: readonly string[] }> };

const fixture = (transfers: TransferWithdrawals | undefined, events: string[] = []) => {
  const store = new MemoryEventRefundStore();
  const originalCreate = store.create.bind(store);
  store.create = async (request, items) => {
    events.push('create');
    return originalCreate(request, items);
  };
  const targets: EventRefundTargets = { list: async () => [target()] };
  const canceller: EventRefundCanceller = { cancel: async () => ({ status: 'REFUNDED' }) };
  const service = new EventRefundService({
    store,
    targets,
    canceller,
    notice: { open: async () => undefined },
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
    ...(transfers === undefined ? {} : { transfers }),
  } as unknown as ConstructorParameters<typeof EventRefundService>[0]);
  return { store, service, events };
};

const start = (service: EventRefundService, over: Partial<EventRefundStartInput> = {}) =>
  service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '일정 변경', ...over });

describe('F-05-11 T4 R-T25 ③ 연기 확정의 양도 철회', () => {
  test('F-05-11 T4 R-T25 ③ ① POSTPONE이면 WithdrawTransfersForEvent를 한 번, 요청·항목 쓰기 전에 부른다', async () => {
    const calls: Array<{ eventId: string; nowMs: number }> = [];
    const events: string[] = [];
    const f = fixture({ withdrawForEvent: async (i) => { calls.push(i); events.push('withdraw'); return { withdrawn: ['offer-1'] }; } }, events);
    const r = await start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 10 * 86_400_000, refundWindowClosesAtMs: NOW + 5 * 86_400_000 });
    expect(r.status).toBe('REFUND_WINDOW');
    expect(calls).toEqual([{ eventId: EVENT, nowMs: NOW }]);
    expect(events.slice(0, 2)).toEqual(['withdraw', 'create']);
  });

  test('F-05-11 T4 R-T25 ③ ② 철회 호출이 실패하면 UNAVAILABLE(503)로 끝나고 요청·항목이 0이다', async () => {
    const f = fixture({ withdrawForEvent: async () => { throw new Error('ticket-svc 연결 실패'); } });
    await expect(start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 10 * 86_400_000, refundWindowClosesAtMs: NOW + 5 * 86_400_000 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.store.requests.size).toBe(0);
    expect(await f.store.items(REQUEST)).toEqual([]);
  });

  test('F-05-11 T4 R-T25 ③ ③ CANCEL이면 철회를 부르지 않고, 두 번 확정해도 철회는 요청마다 한 번이다', async () => {
    let n = 0;
    const f = fixture({ withdrawForEvent: async () => { n += 1; return { withdrawn: [] }; } });
    await start(f.service);
    expect(n).toBe(0);
    const g = fixture({ withdrawForEvent: async () => { n += 1; return { withdrawn: [] }; } });
    const input = { kind: 'POSTPONE' as const, postponedToMs: NOW + 10 * 86_400_000, refundWindowClosesAtMs: NOW + 5 * 86_400_000 };
    await start(g.service, input);
    const again = await start(g.service, input);
    expect(again.requestId).toBe(REQUEST);
    expect(n).toBe(1);
  });
});
