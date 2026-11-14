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
