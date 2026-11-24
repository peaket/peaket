// 주문 내역 목록 쓰임새(openapi GET /v1/orders listOrders, docs/frontend.md §5.29, F-07-2).
// 차례: 커서 풀기(틀리면 400) → reads.list(계정, limit+1, before) → EXPIRED 방어적으로 빼기 → 회차 표시 값 읽기(실패는 무시)
// → orderHistoryPageOf(자르기·다음 커서). 남의 주문은 애초에 읽지 않는다(계정으로 좁힌다).
import type { Clock } from '@peaket/platform';
import {
  decodeOrderHistoryCursor,
  historyVisible,
  type OrderHistoryContext,
  type OrderHistoryPage,
  orderHistoryPageOf,
} from '../domain/order-history.js';
import type { OrderHistoryReads, SaleConfigs } from '../domain/ports.js';

export interface ListOrdersDeps {
  reads: OrderHistoryReads;
  /** 공연명·회차 시작·등급 이름(선택). 없거나 읽지 못하면 그 칸 없이 답한다 */
  configs?: SaleConfigs;
  clock: Clock;
}

export interface ListOrdersCommand {
  readonly accountId: string;
  /** 1~100(계약의 Limit). 받는 층이 이미 검사한다 */
  readonly limit: number;
  readonly cursor?: string;
}

export type ListOrdersResult = { readonly status: 200; readonly body: OrderHistoryPage } | { readonly status: 400 };

export class ListOrders {
  constructor(private readonly deps: ListOrdersDeps) {}

  async execute(c: ListOrdersCommand): Promise<ListOrdersResult> {
    let before: { createdAt: Date; orderId: string } | undefined;
    if (c.cursor !== undefined) {
      before = decodeOrderHistoryCursor(c.cursor);
      if (!before) return { status: 400 };
    }
    const rows = await this.deps.reads.list(c.accountId, {
      limit: c.limit + 1,
      ...(before ? { before } : {}),
    });
    // 어댑터가 EXPIRED를 빼지만, 다른 어댑터(시험 대역)에도 같은 규칙을 지키게 한 번 더 거른다.
    const visible = rows.filter((r) => historyVisible(r.status));
    const contexts = await this.#contextsOf(visible.map((r) => r.eventId));
    return {
      status: 200,
      body: orderHistoryPageOf(visible, {
        limit: c.limit,
        nowMs: this.deps.clock.now(),
        contextOf: (eventId) => contexts.get(eventId),
      }),
    };
  }

  /** 회차마다 한 번만 읽고, 실패는 그 회차 표시 값 없음으로 낮춘다(목록을 500으로 만들지 않는다) */
  async #contextsOf(eventIds: readonly string[]): Promise<Map<string, OrderHistoryContext>> {
    const out = new Map<string, OrderHistoryContext>();
    if (!this.deps.configs) return out;
    const unique = [...new Set(eventIds)];
    const values = await Promise.all(
      unique.map(async (eventId) => {
        try {
          const config = await this.deps.configs!.get(eventId);
          if (!config) return [eventId, undefined] as const;
          const ctx: OrderHistoryContext = {
            ...(config.title !== undefined ? { title: config.title } : {}),
            ...(config.startsAtMs !== undefined ? { startsAtMs: config.startsAtMs } : {}),
            ...(config.entryOpensAtMs !== undefined ? { entryOpensAtMs: config.entryOpensAtMs } : {}),
            ...(config.tierNames !== undefined ? { tierNames: config.tierNames } : {}),
          };
          return [eventId, ctx] as const;
        } catch {
          return [eventId, undefined] as const;
        }
      }),
    );
    for (const [eventId, ctx] of values) if (ctx) out.set(eventId, ctx);
    return out;
  }
}
