// R-T46 ④ 확정 뒤에 결제가 끝난 주문의 배상 행(F-07-8 계획 I-06, BAT-425 RV-18, transfer-refund §5 '확정 뒤에 결제가 끝난 주문의 배상 행').
// 쓸어 담기가 늦게 끝난 주문을 항목에 더할 때, 요청 판정이 주최 측 귀책(ORGANIZER)·공연 내용 변경(CONTENT_CHANGE)이면 그 주문마다 compensation 한 행
// (확정 때와 같은 함수: 그 주문의 대상 표 권면 합의 10%·원 미만 올림 한 번)을 항목과 같은 트랜잭션에 만든다. 불가항력(FORCE_MAJEURE)은 0행.
// 메모리 저장소 단위 시험이다. 같은 트랜잭션(배상 넣기 실패면 항목도 없음)은 test-int/compensation-records.int.test.ts R-T46 ④가 실제 SQL로 본다.
// 기준 트리: 쓸어 담기가 항목·확정 알림만 더해 실패한다(계획 §7).
import { describe, expect, test } from 'vitest';
import { EventRefundService, MemoryEventRefundStore, type EventRefundFault, type EventRefundTarget } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-23T05:00:00.000Z');
const REQUEST = '0194f078-0000-7000-8000-0000000000a1';
const EVENT = '0194f078-0000-7000-8000-0000000000a2';

const target = (n: number, ticketPrice: number, over: Partial<EventRefundTarget> = {}): EventRefundTarget => ({
  orderId: `0194f078-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  ticketId: `0194f078-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  seatId: `0194f078-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`,
  payerAccountId: `0194f078-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`,
  ticketPrice,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
  ...over,
});

function fixture(fault: EventRefundFault) {
  const store = new MemoryEventRefundStore();
  // 확정 때 대상: 33,333원 표 둘인 주문(배상 6,667원)
  const world = { targets: [target(1, 33_333), target(2, 33_333, { orderId: target(1, 0).orderId })], open: 1 };
  const service = new EventRefundService({
    store,
    targets: { list: async () => world.targets },
    canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
    items: store,
    openOrders: { count: async (eventId) => (eventId === EVENT ? world.open : 0) },
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
  });
  const start = () => service.start({ eventId: EVENT, requestId: REQUEST, fault, ruledBy: 'commander-1', confirmedBy: 'operator-2' });
  const rows = () => store.compensations.map((c) => ({ orderId: c.orderId, accountId: c.accountId, baseAmount: c.baseAmount, amount: c.amount, requestId: c.eventCancellationRequestId, eventId: c.eventId }));
  return { store, world, service, start, rows };
}

describe('R-T46 ④ 쓸어 담기의 배상 행', () => {
  for (const fault of ['ORGANIZER', 'CONTENT_CHANGE'] as const) {
    test(`R-T46 ④ ${fault}: 확정 뒤 결제가 끝난 주문(47,500원 표 하나)을 쓸어 담으면 배상 행 한 행(4,750원)이 생기고, 두 번째 쓸어 담기는 0행이며 확정 때 행은 그대로다`, async () => {
      const f = fixture(fault);
      await f.start();
      const late = target(3, 47_500);
      expect(f.rows()).toEqual([{ orderId: target(1, 0).orderId, accountId: target(1, 0).payerAccountId, baseAmount: 66_666, amount: 6_667, requestId: REQUEST, eventId: EVENT }]);
      const before = structuredClone(f.store.compensations);
      f.world.targets = [...f.world.targets, late];
      await f.service.runDue();
      expect((await f.store.items(REQUEST)).some((i) => i.ticketId === late.ticketId)).toBe(true);
      expect(f.rows()).toEqual([
        { orderId: target(1, 0).orderId, accountId: target(1, 0).payerAccountId, baseAmount: 66_666, amount: 6_667, requestId: REQUEST, eventId: EVENT },
        { orderId: late.orderId, accountId: late.payerAccountId, baseAmount: 47_500, amount: 4_750, requestId: REQUEST, eventId: EVENT },
      ]);
      expect(f.store.compensations.find((c) => c.orderId === target(1, 0).orderId)).toEqual(before[0]);
      // 두 번째 쓸어 담기: 새 주문이 없으면 행이 늘지 않는다
      await f.service.runDue();
      expect(f.store.compensations).toHaveLength(2);
    });
  }

  test('R-T46 ④ 이미 아는 주문에 늦게 끝난 표가 더해지면 그 주문의 배상 행을 새로 만들거나 고치지 않는다(주문마다 한 행, 확정 때 금액 그대로)', async () => {
    const f = fixture('ORGANIZER');
    await f.start();
    f.world.targets = [...f.world.targets, target(4, 47_500, { orderId: target(1, 0).orderId })];
    await f.service.runDue();
    expect(f.rows()).toEqual([{ orderId: target(1, 0).orderId, accountId: target(1, 0).payerAccountId, baseAmount: 66_666, amount: 6_667, requestId: REQUEST, eventId: EVENT }]);
  });

  test('R-T46 ④ FORCE_MAJEURE 요청의 쓸어 담기는 배상 행 0행이다(항목은 더한다)', async () => {
    const f = fixture('FORCE_MAJEURE');
    await f.start();
    const late = target(5, 47_500);
    f.world.targets = [...f.world.targets, late];
    await f.service.runDue();
    expect((await f.store.items(REQUEST)).some((i) => i.ticketId === late.ticketId)).toBe(true);
    expect(f.store.compensations).toEqual([]);
  });

  test('R-T46 ④ 0원 주문을 쓸어 담으면 배상 행이 없다', async () => {
    const f = fixture('ORGANIZER');
    await f.start();
    f.world.targets = [...f.world.targets, target(6, 0)];
    await f.service.runDue();
    expect(f.store.compensations.map((c) => c.orderId)).toEqual([target(1, 0).orderId]);
  });
});
