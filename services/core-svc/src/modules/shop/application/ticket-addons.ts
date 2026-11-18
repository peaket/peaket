// 티켓 연동 부가 상품(POST·GET /v1/tickets/{ticketId}/addons, FR-014, ADR-0301 결정 2·3, V-T35).
// 주문은 CreateMerchOrder.addon이 만든다. 목록은 linked_ticket_id가 그 티켓이고 주문이 PAID인 항목을 모은 뒤, 항목이 있으면 그 회차로 ListHeldTickets(세션 계정)를 불러
// 세션 계정이 지금 보유자인지 보고 아니면 404다. 보유자가 주문한 계정이 아니면(양도받은 티켓) 양도 가능 상품의 항목만 보이고 주문 ID는 null이다.
// 항목이 하나도 없으면 물어볼 회차를 모르므로 보유 확인 없이 빈 목록이다.
import type { IdempotencyRequest } from '@peaket/platform';
import { dependencyUnavailable, orderNotFound } from '../domain/merch-order.js';
import { type HeldTicketsPort, HeldTicketsUnavailable, type ShopOrderStore } from '../domain/merch-ports.js';
import type { CreatedOrderView, CreateMerchOrder } from './create-merch-order.js';

export interface TicketAddonItemView {
  orderId: string | null;
  itemId: string;
  productId: string;
  name: string;
  quantity: number;
  status: string;
}

export class TicketAddons {
  constructor(
    private readonly d: { store: ShopOrderStore; held: HeldTicketsPort; orders: CreateMerchOrder },
  ) {}

  create(accountId: string, ticketId: string, body: { productId: string; quantity: number; options?: Record<string, string> | undefined }, once: IdempotencyRequest): Promise<CreatedOrderView> {
    return this.d.orders.addon(accountId, ticketId, body, once);
  }

  async list(accountId: string, ticketId: string, limit: number, cursor?: string): Promise<{ items: TicketAddonItemView[]; nextCursor: string | null }> {
    const id = ticketId.toLowerCase();
    const rows = await this.d.store.addonItems(id);
    if (rows.length === 0) return { items: [], nextCursor: null };
    const eventId = rows.find((r) => r.eventId !== null)?.eventId;
    if (!eventId) return { items: [], nextCursor: null };
    let held: string[];
    try {
      held = await this.d.held.held(accountId, eventId);
    } catch (e) {
      if (e instanceof HeldTicketsUnavailable) throw dependencyUnavailable();
      throw e;
    }
    if (!held.includes(id)) throw orderNotFound();
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    const visible = rows.filter((r) => r.accountId === accountId || r.transferable).filter((r) => after === '' || r.itemId > after);
    const page = visible.slice(0, limit);
    return {
      items: page.map((r) => ({ orderId: r.accountId === accountId ? r.orderId : null, itemId: r.itemId, productId: r.productId, name: r.name, quantity: r.quantity, status: r.status })),
      nextCursor: visible.length > limit && page.length > 0 ? Buffer.from(page[page.length - 1]!.itemId).toString('base64url') : null,
    };
  }
}
