// 주문 상세 쓰임새(openapi GET /v1/orders/{orderId} getOrder, 예매 확인서, docs/frontend.md §5.29, F-07-2).
// 차례: reads.find → 없거나 accountId가 세션 계정과 다르면 404(남의 주문과 없는 주문을 가리지 않는다)
// → 회차 표시 값 → 좌석 이름(판이 있으면) → orderHistoryDetailOf. 읽기 실패는 500 그대로다(확인서를 반쪽으로 그리지 않는다).
import type { Clock } from '@peaket/platform';
import { type OrderHistoryContext, type OrderHistoryDetail, orderHistoryDetailOf } from '../domain/order-history.js';
import type { MergedAccounts, OrderHistoryReads, OrderSeatLabels, SaleConfigs } from '../domain/ports.js';

export interface GetOrderDeps {
  reads: OrderHistoryReads;
  /** 계정 묶음(IR-02). 없으면 세션 계정 하나만 본다(구판·시험 대역) */
  accounts?: MergedAccounts;
  /** 공연명·회차 시작·등급 이름(선택) */
  configs?: SaleConfigs;
  /** 좌석 이름·등급 이름(선택). 없거나 읽지 못하면 저장 값(좌석 ID·등급 ID)으로 떨어진다 */
  seats?: OrderSeatLabels;
  clock: Clock;
}

export interface GetOrderCommand {
  readonly accountId: string;
  /** 경로 값 그대로(모양은 보지 않는다. UUID가 아니면 읽기가 undefined라 404) */
  readonly orderId: string;
}

export type GetOrderResult = { readonly status: 200; readonly body: OrderHistoryDetail } | { readonly status: 404 };

export class GetOrder {
  constructor(private readonly deps: GetOrderDeps) {}

  async execute(c: GetOrderCommand): Promise<GetOrderResult> {
    // SQL에서 주문 ID와 계정 묶음을 함께 걸러 읽는다(다른 계정의 주문 행을 메모리에 싣지 않는다, IR-02)
    const accountIds = this.deps.accounts ? await this.deps.accounts.accountIdsOf(c.accountId) : [c.accountId];
    const order = await this.deps.reads.find(c.orderId, accountIds);
    if (!order || !accountIds.includes(order.accountId)) return { status: 404 };
    const ctx = await this.#contextOf(order.eventId);
    const labels = this.deps.seats
      ? await this.deps.seats
          .resolve(
            order.eventId,
            order.items.map((i) => i.seatId),
          )
          .catch(() => undefined)
      : undefined;
    return {
      status: 200,
      body: orderHistoryDetailOf(order, {
        nowMs: this.deps.clock.now(),
        contextOf: () => ctx,
        ...(labels ? { seatLabels: labels } : {}),
      }),
    };
  }

  async #contextOf(eventId: string): Promise<OrderHistoryContext | undefined> {
    if (!this.deps.configs) return undefined;
    try {
      const config = await this.deps.configs.get(eventId);
      if (!config) return undefined;
      return {
        ...(config.title !== undefined ? { title: config.title } : {}),
        ...(config.startsAtMs !== undefined ? { startsAtMs: config.startsAtMs } : {}),
        ...(config.entryOpensAtMs !== undefined ? { entryOpensAtMs: config.entryOpensAtMs } : {}),
        ...(config.tierNames !== undefined ? { tierNames: config.tierNames } : {}),
      };
    } catch {
      return undefined;
    }
  }
}
