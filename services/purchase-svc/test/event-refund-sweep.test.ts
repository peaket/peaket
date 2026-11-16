// 확정 뒤 늦게 끝난 주문 쓸어 담기와 완료 조건(BAT-420 GAT-110 H, R-T37 ⑥, ADR-0280 결정 4·5, docs/features/transfer-refund.md §5 '확정 때 판매 멈춤·좌석·늦게 끝난 주문').
// 일괄 환불 실행기가 RUNNING·PAUSED인 회차 취소 요청마다 대상을 다시 골라 항목이 없는 표를 더하고, 그 회차에 끝나지 않은 주문이 있으면 COMPLETED로 가지 않는지 본다.
// 메모리 저장소 단위 시험이다. 실제 SQL(대상 다시 고르기·끝나지 않은 주문 상태 목록)은 test-int/event-refund.int.test.ts가 본다. 시험 담당이 구현 전에 썼다(ADR-0270).
import { describe, expect, test } from 'vitest';
import { ORDER_STATUSES } from '../src/modules/booking/domain/order.js';
import { EventRefundService, MemoryEventRefundStore, eventRefundCancellationId, isEventOrderOpen, type EventRefundFanNotifier, type EventRefundTarget } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-16T05:00:00.000Z');
const REQUEST = '0194c400-0000-7000-8000-000000000001';
const EVENT = '0194c400-0000-7000-8000-000000000002';

const target = (n: number, over: Partial<EventRefundTarget> = {}): EventRefundTarget => ({
  orderId: `0194c400-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  ticketId: `0194c400-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  seatId: `0194c400-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`,
  payerAccountId: '0194c400-0000-7000-8000-000000000004',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
  ...over,
});

function fixture() {
  const store = new MemoryEventRefundStore();
  const world = { targets: [target(1)], open: 1 };
  const cancels: string[] = [];
  const confirmedOrders: string[][] = [];
  const fanNotifier: EventRefundFanNotifier = {
    confirmed: (request, targets) => {
      const orders = [...new Set(targets.map((t) => t.orderId))];
      confirmedOrders.push(orders);
      return orders.map((orderId) => ({ topic: 'trade.orders', key: EVENT, payload: new TextEncoder().encode(`EVENT_CANCELLATION_CONFIRMED:${request.requestId}:${orderId}`) }));
    },
    refunded: (_request, item) => ({ topic: 'trade.orders', key: EVENT, payload: new TextEncoder().encode(`REFUNDED:${item.ticketId}`) }),
    failed: (_request, item) => ({ topic: 'trade.orders', key: EVENT, payload: new TextEncoder().encode(`REFUND_FAILED:${item.ticketId}`) }),
  };
  const service = new EventRefundService({
    store,
    targets: { list: async () => world.targets },
    canceller: { cancel: async (t, q) => (cancels.push(`${t.ticketId}:${q.cancellationId}`), { status: 'REFUNDED' }) },
    items: store,
    openOrders: { count: async (eventId) => (eventId === EVENT ? world.open : 0) },
    fanNotifier,
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
  });
  const start = () => service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
  return { store, world, cancels, confirmedOrders, service, start };
}

describe('확정 뒤 늦게 끝난 주문 [BAT-420 GAT-110 H]', () => {
  test('R-T37 ⑥ 항목이 다 끝나도 그 회차에 끝나지 않은 주문이 있으면 COMPLETED가 아니다', async () => {
    const f = fixture();
    const started = await f.start();
    expect(started.progress).toMatchObject({ total: 1, done: 1 });
    expect(started.status).toBe('RUNNING');
    f.world.open = 0;
    await f.service.runDue();
    expect((await f.service.get(REQUEST)).status).toBe('COMPLETED');
  });

  test('R-T37 ⑥ 확정 뒤 결제가 끝난 주문을 실행기가 다시 골라 정해진 취소 ID로 더해 환급하고 그 주문에만 확정 알림을 한 번 남긴다', async () => {
    const f = fixture();
    await f.start();
    expect(f.confirmedOrders).toEqual([[target(1).orderId]]);
    const late = target(2);
    f.world.targets = [target(1), late];
    f.world.open = 0;
    await f.service.runDue();
    const items = await f.store.items(REQUEST);
    expect(items.map((i) => i.ticketId).sort()).toEqual([target(1).ticketId, late.ticketId].sort());
    expect(items.find((i) => i.ticketId === late.ticketId)).toMatchObject({ cancellationId: eventRefundCancellationId(REQUEST, late.ticketId), status: 'REFUNDED' });
    expect(f.cancels).toEqual([`${target(1).ticketId}:${eventRefundCancellationId(REQUEST, target(1).ticketId)}`, `${late.ticketId}:${eventRefundCancellationId(REQUEST, late.ticketId)}`]);
    expect(f.confirmedOrders).toEqual([[target(1).orderId], [late.orderId]]);
    expect(f.store.outbox.filter((m) => new TextDecoder().decode(m.payload).startsWith('EVENT_CANCELLATION_CONFIRMED') && new TextDecoder().decode(m.payload).endsWith(late.orderId))).toHaveLength(1);
    expect((await f.service.get(REQUEST)).status).toBe('COMPLETED');

    // 한 번 더 돌려도 같은 표를 다시 더하거나 부르지 않는다
    await f.service.runDue();
    expect(await f.store.items(REQUEST)).toHaveLength(2);
    expect(f.cancels).toHaveLength(2);
    expect(f.confirmedOrders).toHaveLength(2);
  });

  test('R-T37 ⑥ 멈춘(PAUSED) 요청에도 늦게 끝난 주문의 표를 더하되 다시 시작하기 전에는 부르지 않는다', async () => {
    const f = fixture();
    await f.start();
    await f.service.pause({ requestId: REQUEST, reason: '수동 정지' });
    const late = target(3);
    f.world.targets = [target(1), late];
    await f.service.runDue();
    expect((await f.store.items(REQUEST)).find((i) => i.ticketId === late.ticketId)).toMatchObject({ status: 'PENDING', cancellationId: eventRefundCancellationId(REQUEST, late.ticketId) });
    expect(f.cancels).toHaveLength(1);
    f.world.open = 0;
    await f.service.resume({ requestId: REQUEST, reason: '재개' });
    await f.service.runDue();
    expect(f.cancels).toHaveLength(2);
    expect((await f.service.get(REQUEST)).status).toBe('COMPLETED');
  });

  test('R-T37 ⑥ 끝나지 않은 주문 상태는 일곱(CREATED·AUTHENTICATED·ACCEPTED·RESERVED·AWAITING_DEPOSIT·APPROVED·UNKNOWN)이고 나머지 여섯은 막지 않는다', () => {
    const open = ['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN'];
    const ended = ['CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'];
    // 주문 상태 목록 밖 값이 없는지(새 상태가 생기면 이 시험이 먼저 알린다)
    expect([...open, ...ended].sort()).toEqual([...ORDER_STATUSES].sort());
    for (const s of open) expect(isEventOrderOpen(s), s).toBe(true);
    for (const s of ended) expect(isEventOrderOpen(s), s).toBe(false);
    expect(isEventOrderOpen('NOPE')).toBe(false);
  });
});
