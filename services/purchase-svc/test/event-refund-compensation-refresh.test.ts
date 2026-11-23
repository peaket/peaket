// R-T47 ③ purchase 일괄 환불 실행기 틱이 배상 송금 결과 확정을 실제로 부른다(F-07-8 계획 §5.1 (마) `compensationRefresh`, 시험 리뷰 TR-09).
// runDue() 한 번(틱 끝)이 compensationRefresh.run(50)을 한 번 부르고, 그 틱의 환급 처리 뒤에 부르며, run이 던져도 그 틱의 환급 결과는 그대로다.
// 확정 자체(조건부 갱신·CS 건)는 test-int/compensation-refresh.int.test.ts가 실제 DB로 본다. 여기 대역은 진짜 클래스의 run 모양에 묶었다.
// 기준 트리: application/refresh-compensation-transfers.ts와 compensationRefresh 의존이 없어 실패한다.
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { RefreshCompensationTransfers } from '../src/modules/refund/application/refresh-compensation-transfers.js';
import type { EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const REQUEST = '0194f078-0000-7000-8000-0000000000c1';
const EVENT = '0194f078-0000-7000-8000-0000000000c2';
const target = (n: number): EventRefundTarget => ({
  orderId: `0194f078-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`,
  ticketId: `0194f078-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`,
  seatId: `seat-${n}`,
  payerAccountId: '0194f078-0000-7000-8000-000000000007',
  ticketPrice: 47_500,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
});

type Refresh = Pick<RefreshCompensationTransfers, 'run'>;

function world(o: { failRun?: boolean } = {}) {
  const store = new MemoryEventRefundStore();
  const log: string[] = [];
  const runs: (number | undefined)[] = [];
  const world = { targets: [target(1)], open: 1 };
  const compensationRefresh: Refresh = {
    run: async (limit?: number) => {
      runs.push(limit);
      log.push('refresh');
      if (o.failRun) throw new Error('payment-svc GetCompensationTransfer UNAVAILABLE');
      return { paid: 0, failed: 0, pending: 0 };
    },
  };
  const service = new EventRefundService({
    store,
    targets: { list: async () => world.targets },
    canceller: {
      cancel: async (t) => {
        log.push(`cancel:${t.ticketId}`);
        return { status: 'REFUNDED' };
      },
    },
    items: store,
    openOrders: { count: async () => world.open },
    compensationRefresh,
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
  });
  const start = () => service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
  return { store, log, runs, world, service, start };
}

describe('R-T47 ③ 실행기 틱의 배상 송금 결과 확정', () => {
  test('R-T47 ③ runDue() 한 번이 compensationRefresh.run(50)을 한 번 부르고, 그 틱의 환급 처리 뒤에 부른다', async () => {
    const w = world();
    await w.start();
    w.log.length = 0;
    w.runs.length = 0;
    w.world.targets = [target(1), target(2)];
    await w.service.runDue();
    expect(w.runs).toEqual([50]);
    expect(w.log).toEqual([`cancel:${target(2).ticketId}`, 'refresh']);
    await w.service.runDue();
    expect(w.runs).toEqual([50, 50]);
  });

  test('R-T47 ③ run이 던져도 그 틱의 환급 결과는 그대로다', async () => {
    const w = world({ failRun: true });
    await w.start();
    w.world.targets = [target(1), target(3)];
    await w.service.runDue().catch(() => undefined);
    expect(w.runs).toEqual(expect.arrayContaining([50]));
    expect((await w.store.items(REQUEST)).map((i) => [i.ticketId, i.status]).sort()).toEqual(
      [
        [target(1).ticketId, 'REFUNDED'],
        [target(3).ticketId, 'REFUNDED'],
      ].sort(),
    );
  });
});
