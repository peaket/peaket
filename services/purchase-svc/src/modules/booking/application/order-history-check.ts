// 매일 주문 상태·이력 검사의 정비 일(ADR-0113 결정 2, docs/features/payment.md §3, BUILD_ORDER PRF-160).
// 릴레이 프로세스의 리더 하나가 platform MaintenanceRunner로 하루 한 번 돌린다(붙이는 일은 PRF-164).
// 유스케이스 층은 어댑터(checkOrderHistory)를 가져오지 않는다(architecture §3.1 층 규칙). 기본 검사 함수는 모듈 공개 면(index.ts)의
// orderHistoryCheckTask가 채워 넘긴다. 이 파일을 바로 부르면 check를 줘야 한다.
import { type Clock, type Database, kstDayStart, type MaintenanceTask } from '@peaket/platform';
import { ORDER_HISTORY_BATCH } from '../domain/order.js';
import type { OrderHistoryReport, OrderSignals } from '../domain/ports.js';

export const ORDER_HISTORY_TASK = 'order-history-check';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrderHistoryTaskDeps {
  database: Database;
  clock: Clock;
  signals: OrderSignals;
  logger: { warn(o: object, msg?: string): void };
  /** 기본 1,000 [가정] */
  batchSize?: number;
  /** 시험에서 바꿔 끼운다. 기본은 checkOrderHistory(모듈 공개 면 index.ts의 orderHistoryCheckTask가 채운다) */
  check?: (database: Database, o: { fromMs: number; toMs: number; batchSize?: number; signal?: AbortSignal }) => Promise<OrderHistoryReport>;
}

/**
 * 정비 일 하나: 어제(한국 시각 0시~0시)의 이력이 있는 주문을 검사하고, 어긋난 주문 수를 지표로 내며 주문마다 경고 로그 한 줄(kind order-history)을 남긴다.
 * 정비 시간(04:00~06:00 KST, when 'window') 안에서 하루 한 번 돈다(하루치 이력을 훑는 큰 읽기라 판매가 몰리는 낮을 피한다, 리뷰 2026-11-05)
 * @throws Error check가 없음(이 파일을 바로 불렀다. 모듈 공개 면의 orderHistoryCheckTask는 기본값을 채운다)
 */
export function orderHistoryCheckTask(deps: OrderHistoryTaskDeps): MaintenanceTask {
  const check = deps.check;
  if (!check) throw new Error('order-history-check: check 함수가 없다(booking index.ts의 orderHistoryCheckTask로 만들면 checkOrderHistory가 기본이다)');
  return {
    name: ORDER_HISTORY_TASK,
    when: 'window',
    async run(signal?: AbortSignal): Promise<OrderHistoryReport> {
      // 어제 = [오늘 한국 시각 0시 − 1일, 오늘 한국 시각 0시)
      const toMs = kstDayStart(deps.clock.now());
      const fromMs = toMs - DAY_MS;
      // check가 던지면 그대로 던진다(정비 반복이 실패로 센다). 지표·로그는 건드리지 않는다
      const report = await check(deps.database, { fromMs, toMs, batchSize: deps.batchSize ?? ORDER_HISTORY_BATCH, signal });
      // 멈춤 신호로 도중에 끝났으면 일부만 본 보고다. 지표(지난 값)와 로그를 건드리지 않는다(정비 실행기는 성공으로 적지 않고 다시 돌린다)
      if (signal?.aborted) return report;
      deps.signals.historyMismatch(report.mismatched.length);
      for (const m of report.mismatched) {
        deps.logger.warn(
          { kind: 'order-history', orderId: m.orderId, status: m.status, eventSeq: m.eventSeq, lastSeq: m.lastSeq, rows: m.rows, lastTo: m.lastTo },
          '주문 상태와 상태 이력이 어긋났다',
        );
      }
      return report;
    },
  };
}
