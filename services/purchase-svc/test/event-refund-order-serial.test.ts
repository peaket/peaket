// 회차 취소 일괄 환불의 작업자 나누기(BUILD_ORDER GAT-080, BAT-415 몫 E, docs/data.md §5 '같은 주문의 표 둘을 동시에 취소', docs/features/payment.md §4.1).
// payment-svc가 같은 결제의 일반 취소를 한 번에 하나씩 보내므로(10분 안의 진행 중 건이 있으면 결과 모름), 일괄 환불은 같은 주문의 표를 한 작업자가 차례로 처리한다.
// 취소기 가짜가 주문별·전체 동시 진행 수를 잰다. 다 차례로 바꾼 틀린 구현(동시 1)도 잡도록 다른 주문은 동시에 도는지 본다.
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';
import type { EventRefundCanceller, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';

const NOW = Date.parse('2026-11-16T05:00:00.000Z');
const REQUEST = '0193a000-0000-7000-8000-0000000000e1';
const EVENT = '0193a000-0000-7000-8000-0000000000e2';
const ORDERS = ['0193a000-0000-7000-8000-0000000000a1', '0193a000-0000-7000-8000-0000000000a2', '0193a000-0000-7000-8000-0000000000a3'] as const;
const ticketOf = (order: number, n: number): string => `0193a000-0000-7000-8000-0000000001${order}${n}`;

const targetOf = (order: number, n: number): EventRefundTarget => ({
  orderId: ORDERS[order]!,
  ticketId: ticketOf(order, n),
  seatId: `0193a000-0000-7000-8000-0000000002${order}${n}`,
  payerAccountId: '0193a000-0000-7000-8000-0000000000f1',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
});

describe('GAT-080 몫 E 일괄 환불의 주문 단위 작업자', () => {
  test('GAT-080 E1 일괄 환불은 같은 주문의 표를 동시에 취소하지 않고(주문마다 최대 1) 다른 주문은 동시에 하며(전체 최대 2 이상), 같은 주문 안 차례는 큐 차례다', async () => {
    // 큐 차례: 주문을 섞어 둔다(주문0-표0, 주문1-표0, 주문2-표0, 주문0-표1, 주문1-표1, 주문2-표1)
    const targets = [targetOf(0, 0), targetOf(1, 0), targetOf(2, 0), targetOf(0, 1), targetOf(1, 1), targetOf(2, 1)];
    const inFlight = new Map<string, number>();
    const maxPerOrder = new Map<string, number>();
    let inFlightAll = 0;
    let maxAll = 0;
    const orderSeen = new Map<string, string[]>();
    const canceller: EventRefundCanceller = {
      cancel: async (t) => {
        const now = (inFlight.get(t.orderId) ?? 0) + 1;
        inFlight.set(t.orderId, now);
        maxPerOrder.set(t.orderId, Math.max(maxPerOrder.get(t.orderId) ?? 0, now));
        inFlightAll += 1;
        maxAll = Math.max(maxAll, inFlightAll);
        orderSeen.set(t.orderId, [...(orderSeen.get(t.orderId) ?? []), t.ticketId]);
        // 결제사 호출처럼 잠깐 기다려 겹칠 틈을 준다
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight.set(t.orderId, (inFlight.get(t.orderId) ?? 1) - 1);
        inFlightAll -= 1;
        return { status: 'REFUNDED' };
      },
    };
    const list: EventRefundTargets = { list: async () => targets };
    const service = new EventRefundService({
      store: new MemoryEventRefundStore(),
      targets: list,
      canceller,
      notice: { open: async () => {} },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
      concurrency: 8,
    });

    await service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });

    // 모든 표를 한 번씩 처리했다(빈 결과가 통과로 새지 않게)
    expect([...orderSeen.values()].flat().sort()).toEqual(targets.map((t) => t.ticketId).sort());
    for (const order of ORDERS) expect(maxPerOrder.get(order), `주문 ${order}의 동시 진행`).toBe(1);
    expect(maxAll, '다른 주문은 동시에 돈다').toBeGreaterThanOrEqual(2);
    for (let o = 0; o < ORDERS.length; o++) expect(orderSeen.get(ORDERS[o]!), `주문 ${o} 안 차례`).toEqual([ticketOf(o, 0), ticketOf(o, 1)]);
  });
});
