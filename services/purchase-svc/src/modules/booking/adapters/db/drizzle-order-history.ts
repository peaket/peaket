// 주문 ?�역 ?�기(OrderHistoryReads, openapi GET /v1/orders·GET /v1/orders/{orderId}, docs/frontend.md §5.29, F-07-2).
// purchase_order·order_item·order_cancellation???�기�??�다(주문 ?�태 SQL ?�음). 계정?�로 좁히�?EXPIRED�?뺀??
// 목록?� (created_at, id) ?�림차순 ?�셋?�고, ?�댑?�는 부르는 쪽이 준 limit(보통 limit+1)만큼 준??
// ?�문??UUID가 ?�닌 주문 ID??DB??가지 ?�는??drizzle-payment-status?� 같�? 규칙).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { OrderStatus } from '../../domain/order.js';
import type { OrderHistoryCancellationRow, OrderHistoryItemRow, OrderHistoryOrder } from '../../domain/order-history.js';
import type { OrderHistoryReads } from '../../domain/ports.js';

export interface DrizzleOrderHistoryOptions {
  database: Database;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** ?�면??보이??취소 ?�태 ??DB CHECK?� 같다) */
const CANCELLATION_STATUSES = new Set(['REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED']);

interface OrderRow {
  id: string;
  account_id: string;
  event_id: string;
  status: string;
  amount: number;
  created_at: Date | string;
  failure_reason: string | null;
}
interface ItemRow {
  order_id: string;
  line_no: number;
  seat_id: string;
  tier: string;
  unit_price: number;
  ticket_id: string | null;
}
interface CancellationRow {
  id: string;
  order_id: string;
  ticket_id: string | null;
  created_at: Date | string;
  deduction_amount: number;
  refund_amount: number;
  refund_due_at: Date | string | null;
  status: string;
  refund_account_required_at: Date | string | null;
}

const ORDER_COLUMNS = sql`o.id, o.account_id, o.event_id, o.status, o.amount, o.created_at, o.failure_reason`;
const ITEM_COLUMNS = sql`order_id, line_no, seat_id, tier, unit_price, ticket_id`;
const CANCELLATION_COLUMNS = sql`id, order_id, ticket_id, created_at, deduction_amount, refund_amount, refund_due_at, status, refund_account_required_at`;

const idsSql = (ids: readonly string[]) => sql.join(
  ids.map((id) => sql`${id}::uuid`),
  sql`, `,
);

const itemOf = (r: ItemRow): OrderHistoryItemRow => ({
  lineNo: Number(r.line_no),
  seatId: r.seat_id,
  tierId: r.tier,
  unitPrice: Number(r.unit_price),
  ticketId: r.ticket_id,
});

const cancellationOf = (r: CancellationRow): OrderHistoryCancellationRow => ({
  cancellationId: r.id,
  ticketId: r.ticket_id,
  requestedAt: new Date(r.created_at),
  deductionAmount: Number(r.deduction_amount),
  refundAmount: Number(r.refund_amount),
  refundDueAt: r.refund_due_at === null ? null : new Date(r.refund_due_at),
  status: CANCELLATION_STATUSES.has(r.status) ? (r.status as OrderHistoryCancellationRow['status']) : 'REQUESTED',
  refundAccountRequired: r.refund_account_required_at !== null,
});

export class DrizzleOrderHistory implements OrderHistoryReads {
  constructor(private readonly o: DrizzleOrderHistoryOptions) {}

  async list(accountId: string, o: { limit: number; before?: { createdAt: Date; orderId: string } }): Promise<readonly OrderHistoryOrder[]> {
    const before = o.before ? sql` and (o.created_at, o.id) < (${o.before.createdAt.toISOString()}::timestamptz, ${o.before.orderId}::uuid)` : sql``;
    const result = await this.o.database.db.execute(sql`
      select ${ORDER_COLUMNS}
      from purchase_order o
      where o.account_id = ${accountId}::uuid and o.status <> 'EXPIRED'${before}
      order by o.created_at desc, o.id desc
      limit ${o.limit}`);
    const rows = result.rows as unknown as OrderRow[];
    return this.#withLines(rows);
  }

  async find(orderId: string): Promise<OrderHistoryOrder | undefined> {
    if (!UUID.test(orderId)) return undefined;
    const result = await this.o.database.db.execute(sql`
      select ${ORDER_COLUMNS}
      from purchase_order o
      where o.id = ${orderId}::uuid`);
    const rows = result.rows as unknown as OrderRow[];
    const [order] = await this.#withLines(rows);
    return order;
  }

  /** 주문 ?�들????��·취소 ?�력????질의�?붙인????주문??묻�? ?�는?? N+1 금�?) */
  async #withLines(rows: readonly OrderRow[]): Promise<OrderHistoryOrder[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [items, cancellations] = await Promise.all([
      this.o.database.db.execute(sql`select ${ITEM_COLUMNS} from order_item where order_id in (${idsSql(ids)}) order by order_id, line_no`),
      this.o.database.db.execute(sql`select ${CANCELLATION_COLUMNS} from order_cancellation where order_id in (${idsSql(ids)}) order by created_at`),
    ]);
    const itemsByOrder = new Map<string, OrderHistoryItemRow[]>();
    for (const r of items.rows as unknown as ItemRow[]) {
      const list = itemsByOrder.get(r.order_id) ?? [];
      list.push(itemOf(r));
      itemsByOrder.set(r.order_id, list);
    }
    const cancellationsByOrder = new Map<string, OrderHistoryCancellationRow[]>();
    for (const r of cancellations.rows as unknown as CancellationRow[]) {
      const list = cancellationsByOrder.get(r.order_id) ?? [];
      list.push(cancellationOf(r));
      cancellationsByOrder.set(r.order_id, list);
    }
    return rows.map((r) => ({
      orderId: r.id,
      accountId: r.account_id,
      eventId: r.event_id,
      status: r.status as OrderStatus,
      amount: Number(r.amount),
      createdAt: new Date(r.created_at),
      failureReason: r.failure_reason,
      items: itemsByOrder.get(r.id) ?? [],
      cancellations: cancellationsByOrder.get(r.id) ?? [],
    }));
  }
}
