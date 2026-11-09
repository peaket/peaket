// 하루 넘은 열린 주문의 정비 일(ADR-0107 '뒤에 정한 것', docs/features/payment.md §2 안전망 ③, docs/data.md §5.1, BUILD_ORDER PRF-172, 2026-11-09 코드 리뷰).
// 안전망 반복(order-expiry-sweep.ts)은 하루 안의 주문만 읽으므로, 하루 안에 끝나지 못한 주문(망가진 좌석, 좌석맵 파일 없음, 릴레이가 오래 멈춤)은 이 일이 맡는다.
// 릴레이 프로세스의 리더 하나가 platform MaintenanceRunner로 정비 시간(04:00~06:00 KST, when 'window')에 하루 한 번 돌린다:
//   기본 키 범위로 만든 지 1~30일 [가정]인 열린 주문을 1,000건씩(afterId) 읽어 주문마다 check(sweep)를 부르고, 끝에 그래도 열린 수를 게이지 openStale로 둔다(1 이상이면 경고 한 줄).
// 30일이 지난 주문은 보지 않는다(회차 키 수명이 끝나 조건이 끝났으므로 그 전에 끝난다). 이 층은 어댑터를 가져오지 않는다(architecture §3.1).
// 구현에서 정한 것(정본에 없다):
// - 판정이 던진 주문은 끝났는지 모르므로 열린 수에 넣는다(지표는 check가 failure('check')로 이미 올렸다). 경고는 주문마다 남기지 않고 끝에 한 줄이다(좌석 Redis 장애 때 줄 수가 묶음 크기만큼 늘지 않게).
// - 멈춤 신호로 도중에 끝나면 일부만 본 수이므로 게이지·경고를 건드리지 않는다(정비 실행기는 성공으로 적지 않고 다시 돌린다, order-history-check.ts와 같다).
// - 묶음 읽기가 던지면 failure('sweep') 뒤 그대로 던진다(정비 실행기가 실패로 세고 다음에 다시 한다). 게이지는 지난 값 그대로다.
import type { Clock, MaintenanceTask } from '@peaket/platform';
import { ORDER_EXPIRY_LOOKBACK_MS, ORDER_EXPIRY_STALE_BATCH, ORDER_EXPIRY_STALE_MAX_AGE_MS } from '../domain/order-expiry.js';
import type { OrderExpiryLogger, OrderExpiryOrder, OrderExpiryRange, OrderExpirySignals, OrderExpiryStore } from '../domain/ports.js';
import type { OrderExpiry } from './order-expiry.js';

export const ORDER_EXPIRY_STALE_TASK = 'order-expiry-stale';

export interface OrderExpiryStaleTaskDeps {
  store: Pick<OrderExpiryStore, 'staleOrderBatch'>;
  expiry: Pick<OrderExpiry, 'check'>;
  clock: Clock;
  signals: OrderExpirySignals;
  logger: OrderExpiryLogger;
  /** 묶음 하나의 행 수(기본 ORDER_EXPIRY_STALE_BATCH 1,000건) */
  batchSize?: number;
}

/** 정비 일 하나의 보고 */
export interface OrderExpiryStaleReport {
  /** check를 부른 주문 수 */
  readonly checked: number;
  /** 만료로 끝낸 주문 수 */
  readonly expired: number;
  /** 그래도 열린 주문 수(아직 NOT_YET이거나 판정이 던진 주문) */
  readonly stillOpen: number;
  /** check가 던진 주문 수 */
  readonly failed: number;
}

/**
 * 정비 일 하나(머리 주석).
 * @throws 저장소 오류(묶음 읽기, 정비 실행기가 실패로 센다)
 */
export function orderExpiryStaleTask(deps: OrderExpiryStaleTaskDeps): MaintenanceTask {
  const limit = deps.batchSize ?? ORDER_EXPIRY_STALE_BATCH;
  return {
    name: ORDER_EXPIRY_STALE_TASK,
    when: 'window',
    async run(signal?: AbortSignal): Promise<OrderExpiryStaleReport> {
      const nowMs = deps.clock.now();
      const range: OrderExpiryRange = { createdFromMs: nowMs - ORDER_EXPIRY_STALE_MAX_AGE_MS, createdBeforeMs: nowMs - ORDER_EXPIRY_LOOKBACK_MS, limit };
      const report = { checked: 0, expired: 0, stillOpen: 0, failed: 0 };
      let afterId: string | undefined;
      for (;;) {
        if (signal?.aborted) return report;
        const orders = await readBatch(deps, afterId === undefined ? range : { ...range, afterId });
        await checkAll(deps, orders, report, signal);
        if (orders.length < limit) break;
        // NOT_YET으로 남는 주문이 있어 상태가 아니라 커서로 앞으로 간다
        afterId = orders.at(-1)!.orderId;
      }
      if (signal?.aborted) return report;
      deps.signals.openStale(report.stillOpen);
      if (report.stillOpen >= 1) deps.logger.warn({ kind: 'order-expiry-stale', stillOpen: report.stillOpen, failed: report.failed, checked: report.checked }, '만든 지 하루 넘게 열린 주문이 있다(다음 날 다시 본다)');
      return report;
    },
  };
}

async function readBatch(deps: OrderExpiryStaleTaskDeps, range: OrderExpiryRange & { readonly afterId?: string }): Promise<OrderExpiryOrder[]> {
  try {
    return await deps.store.staleOrderBatch(range);
  } catch (err) {
    deps.signals.failure('sweep');
    throw err;
  }
}

/** 주문마다 차례로 check. 한 주문의 실패는 다음 주문을 막지 않는다. 멈춤 신호가 끊기면 남은 주문을 보지 않는다 */
async function checkAll(deps: OrderExpiryStaleTaskDeps, orders: readonly OrderExpiryOrder[], report: { checked: number; expired: number; stillOpen: number; failed: number }, signal: AbortSignal | undefined): Promise<void> {
  for (const { orderId } of orders) {
    if (signal?.aborted) return;
    report.checked += 1;
    try {
      const outcome = await deps.expiry.check(orderId, 'sweep');
      if (outcome.status === 'EXPIRED') report.expired += 1;
      else if (outcome.status === 'NOT_YET') report.stillOpen += 1;
    } catch {
      report.failed += 1;
      report.stillOpen += 1;
    }
  }
}
