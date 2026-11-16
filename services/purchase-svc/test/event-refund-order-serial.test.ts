// 회차 취소 일괄 환불의 작업자 나누기(BUILD_ORDER GAT-080, BAT-415 몫 E, docs/data.md §5 '같은 주문의 표 둘을 동시에 취소', docs/features/payment.md §4.1).
// payment-svc가 같은 결제의 일반 취소를 한 번에 하나씩 보내므로(10분 안의 진행 중 건이 있으면 결과 모름), 일괄 환불은 같은 주문의 표를 한 작업자가 차례로 처리한다.
// 취소기 가짜가 주문별·전체 동시 진행 수를 잰다. 다 차례로 바꾼 틀린 구현(동시 1)도 잡도록 다른 주문은 동시에 도는지 본다.
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundAttemptStore, MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
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

// ---- BAT-415 리뷰 반영 B4(계획 §11 E2, docs/data.md §5 '같은 주문', docs/features/payment.md §4.1 '한 번에 하나씩') ----
describe('GAT-080 E2 같은 주문의 앞 표가 끝나지 않으면 나머지를 미룬다', () => {
  const A0 = ticketOf(0, 0);
  const A1 = ticketOf(0, 1);
  const B0 = ticketOf(1, 0);
  const B1 = ticketOf(1, 1);
  const REQUEST2 = '0193a000-0000-7000-8000-0000000000e3';

  /** 주문 A(표 둘)·B(표 둘). A0의 답을 시험마다 차례로 정한다(나머지는 REFUNDED) */
  const fixture = (a0Answers: Array<'REFUNDED' | 'REFUND_PENDING' | 'FAILED'>) => {
    let now = NOW;
    const calls: string[] = [];
    let a0 = 0;
    const canceller: EventRefundCanceller = {
      cancel: async (t) => {
        calls.push(t.ticketId);
        if (t.ticketId !== A0) return { status: 'REFUNDED' };
        const status = a0Answers[a0++] ?? 'REFUNDED';
        return status === 'FAILED' ? { status, error: 'REJECTED' } : { status };
      },
    };
    const store = new MemoryEventRefundStore();
    const attempts = new MemoryEventRefundAttemptStore();
    const service = new EventRefundService({
      store,
      targets: { list: async () => [targetOf(0, 0), targetOf(0, 1), targetOf(1, 0), targetOf(1, 1)] },
      canceller,
      attempts,
      notice: { open: async () => {} },
      nowMs: () => now,
      deadlineMs: () => now + 5_000,
      concurrency: 8,
    });
    return { service, store, attempts, calls, setNow: (ms: number) => (now = ms) };
  };
  const start = (service: EventRefundService) => service.start({ eventId: EVENT, requestId: REQUEST2, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });

  test('GAT-080 E2 같은 주문의 앞 표가 결과 모름이면 나머지 표는 이번 실행에서 부르지도 시도로 세지도 않고, 재시도 시각 전 다음 실행에서도 그렇다', async () => {
    const f = fixture(['REFUND_PENDING', 'REFUNDED']);
    await start(f.service);
    expect(f.calls.filter((c) => c === A1)).toHaveLength(0);
    expect(f.calls.filter((c) => c === A0)).toHaveLength(1);
    expect([...f.calls].filter((c) => c === B0 || c === B1).sort()).toEqual([B0, B1].sort());
    // 시도 기록(자동 정지 창의 calls·failures)에 A1이 없다
    expect(f.attempts.attempts.map((a) => a.ticketId).sort()).toEqual([A0, B0, B1].sort());
    const a0Item = (await f.store.items(REQUEST2)).find((i) => i.ticketId === A0)!;
    const a1Item = (await f.store.items(REQUEST2)).find((i) => i.ticketId === A1)!;
    expect(a0Item.status).toBe('UNKNOWN');
    expect(a1Item).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(a0Item.nextAttemptAtMs).toBeGreaterThan(NOW);

    // 다음 실행(A0의 다음 시도 시각 1ms 전): A1은 여전히 부르지 않는다
    f.setNow(a0Item.nextAttemptAtMs! - 1);
    await f.service.runDue();
    expect(f.calls.filter((c) => c === A1)).toHaveLength(0);
    expect(f.attempts.attempts.filter((a) => a.ticketId === A1)).toHaveLength(0);

    // A0의 다음 시도 시각: A0이 REFUNDED가 되면 그 실행에서 A1을 잇는다(A0 다음 A1)
    f.setNow(a0Item.nextAttemptAtMs!);
    await f.service.runDue();
    expect(f.calls.filter((c) => c === A0 || c === A1)).toEqual([A0, A0, A1]);
    expect((await f.store.items(REQUEST2)).filter((i) => i.orderId === ORDERS[0]).map((i) => i.status)).toEqual(['REFUNDED', 'REFUNDED']);
  });

  test('GAT-080 E2 대조: 앞 표가 업무 거절(FAILED)로 끝나면 같은 주문의 나머지는 같은 실행에서 처리한다', async () => {
    const f = fixture(['FAILED']);
    await start(f.service);
    expect(f.calls.filter((c) => c === A0 || c === A1)).toEqual([A0, A1]);
    expect((await f.store.items(REQUEST2)).find((i) => i.ticketId === A0)!.status).toBe('FAILED');
    expect((await f.store.items(REQUEST2)).find((i) => i.ticketId === A1)!.status).toBe('REFUNDED');
  });
});
