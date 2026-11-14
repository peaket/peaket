// shop Drizzle 스키마(docs/data.md product·product_stock, BUILD_ORDER BAT-610 서버 잔여).
// 표의 정본은 migrations/0014_shop.sql이다.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const product = pgTable(
  'product',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    name: text('name').notNull(),
    status: text('status').notNull().default('DRAFT'),
    price: integer('price').notNull(),
    shippingFee: integer('shipping_fee'),
    returnShippingFee: integer('return_shipping_fee'),
    returnAddress: text('return_address'),
    limitedQty: integer('limited_qty'),
    transferable: boolean('transferable').notNull().default(false),
    ticketLinked: boolean('ticket_linked').notNull().default(false),
    linkedEventId: uuid('linked_event_id'),
    fulfillments: text('fulfillments').array().notNull(),
    saleStartsAt: at('sale_starts_at'),
    saleEndsAt: at('sale_ends_at'),
    commissionRateBp: integer('commission_rate_bp'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    version: integer('version').notNull().default(1),
    publishedAt: at('published_at'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('product_status_check', sql`${t.status} in ('DRAFT', 'PUBLISHED', 'HIDDEN')`),
    check('product_price_check', sql`${t.price} >= 0`),
    check('product_ticket_link_check', sql`${t.ticketLinked} = (${t.linkedEventId} is not null)`),
    check('product_fulfillments_check', sql`cardinality(${t.fulfillments}) > 0`),
    check('product_version_check', sql`${t.version} >= 1`),
    index('product_promoter_updated_idx').on(t.promoterId, t.updatedAt, t.id),
    index('product_linked_event_idx').on(t.linkedEventId),
  ],
);

export const productStock = pgTable(
  'product_stock',
  {
    productId: uuid('product_id')
      .primaryKey()
      .references(() => product.id, { onDelete: 'cascade' }),
    stock: integer('stock').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [check('product_stock_stock_check', sql`${t.stock} >= 0`)],
);

// 굿즈·부가 상품 주문(docs/data.md merch_order·merch_order_item, settlement §4.5).
// 주문을 만드는 경로는 아직 없고, 명단·상품 정산서 원천으로 읽는다.
export const merchOrder = pgTable(
  'merch_order',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    eventId: uuid('event_id'),
    buyerName: text('buyer_name').notNull(),
    buyerPhone: text('buyer_phone').notNull(),
    status: text('status').notNull().default('PAID'),
    pg: text('pg').notNull(),
    pgStore: text('pg_store').notNull(),
    shippingFee: integer('shipping_fee').notNull().default(0),
    purchaseConfirmedAt: at('purchase_confirmed_at'),
    orderedAt: at('ordered_at').notNull(),
  },
  (t) => [
    check('merch_order_status_check', sql`${t.status} in ('PENDING', 'PAID', 'CANCELLED', 'REFUNDED')`),
    check('merch_order_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE')`),
    check('merch_order_pg_store_check', sql`${t.pgStore} in ('STANDARD', 'ESCROW')`),
    check('merch_order_shipping_fee_check', sql`${t.shippingFee} >= 0`),
    index('merch_order_promoter_event_idx').on(t.promoterId, t.eventId, t.orderedAt),
  ],
);

export const merchOrderItem = pgTable(
  'merch_order_item',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull().references(() => merchOrder.id, { onDelete: 'cascade' }),
    promoterId: uuid('promoter_id').notNull(),
    eventId: uuid('event_id'),
    productId: uuid('product_id').notNull(),
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitAmount: integer('unit_amount').notNull(),
    commissionRateBp: integer('commission_rate_bp').notNull(),
    status: text('status').notNull().default('READY'),
    fulfillment: text('fulfillment').notNull(),
    seatLabel: text('seat_label'),
    ticketLinked: boolean('ticket_linked').notNull().default(false),
    shippedAt: at('shipped_at'),
    deliveredAt: at('delivered_at'),
    pickedUpAt: at('picked_up_at'),
    returnRequestedAt: at('return_requested_at'),
    returnResolvedAt: at('return_resolved_at'),
    refundedAmount: integer('refunded_amount').notNull().default(0),
    eventEndsAt: at('event_ends_at'),
  },
  (t) => [
    check('merch_order_item_status_check', sql`${t.status} in ('READY', 'SHIPPED', 'DELIVERED', 'PICKED_UP', 'LOCKED', 'RETURN_REQUESTED', 'RETURN_RECEIVED', 'DISPUTED', 'CANCELLED', 'REFUNDED')`),
    check('merch_order_item_fulfillment_check', sql`${t.fulfillment} in ('DELIVERY', 'PICKUP', 'WALLET')`),
    check('merch_order_item_quantity_check', sql`${t.quantity} > 0`),
    check('merch_order_item_amount_check', sql`${t.unitAmount} >= 0 and ${t.refundedAmount} >= 0`),
    check('merch_order_item_commission_check', sql`${t.commissionRateBp} >= 0 and ${t.commissionRateBp} <= 10000`),
    index('merch_order_item_promoter_event_idx').on(t.promoterId, t.eventId),
    index('merch_order_item_order_idx').on(t.orderId),
  ],
);
