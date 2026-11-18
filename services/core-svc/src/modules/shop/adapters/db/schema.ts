// shop Drizzle 스키마(docs/data.md product·product_stock, BUILD_ORDER BAT-610 서버 잔여).
// 표의 정본은 migrations/0014_shop.sql이다.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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

// 상품 유형 참조 표(ADR-0300 결정 1, docs/data.md product_type). 배포 때 넣는 행이고 처음 행은 MERCH·PARKING(판 1)이다.
// 파트너 상품 만들기·고치기가 core_app으로 읽는다(core_partner는 읽지 않는다)
export const productType = pgTable(
  'product_type',
  {
    code: text('code').primaryKey(),
    latestSchemaVersion: integer('latest_schema_version').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [check('product_type_version_check', sql`${t.latestSchemaVersion} >= 1`)],
);

// 현장 수령 시간대(docs/data.md pickup_slot, ADR-0301 결정 4). 파트너가 만드는 API는 아직 없다(계약에 없음)
export const pickupSlot = pgTable(
  'pickup_slot',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    startsAt: at('starts_at').notNull(),
    endsAt: at('ends_at').notNull(),
    ticketHoldersOnly: boolean('ticket_holders_only').notNull().default(false),
  },
  (t) => [check('pickup_slot_window_check', sql`${t.endsAt} > ${t.startsAt}`), index('pickup_slot_product_idx').on(t.productId, t.eventId, t.endsAt)],
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

// 굿즈·부가 상품 주문(docs/data.md merch_order·merch_order_item, settlement §4.5, ADR-0300 결정 9).
// 팬 주문(POST /v1/shop/orders·/v1/tickets/{ticketId}/addons)이 만들고, 명단·상품 정산서 원천으로도 읽는다.
// account_id·fulfillment·amount·stock_reserved_until은 BAT-610 시험 행에 값이 없어 NULL을 허용한다(새 주문은 늘 채운다).
export const merchOrder = pgTable(
  'merch_order',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id'),
    promoterId: uuid('promoter_id').notNull(),
    eventId: uuid('event_id'),
    fulfillment: text('fulfillment'),
    buyerName: text('buyer_name'),
    buyerPhone: text('buyer_phone'),
    status: text('status').notNull().default('CREATED'),
    amount: integer('amount'),
    stockReservedUntil: at('stock_reserved_until'),
    pg: text('pg'),
    paymentId: uuid('payment_id'),
    pgStore: text('pg_store').notNull(),
    escrow: boolean('escrow').notNull().default(false),
    shippingFee: integer('shipping_fee').notNull().default(0),
    consentVersion: text('consent_version'),
    recipientName: text('recipient_name'),
    recipientPhone: text('recipient_phone'),
    deliveryAddress: text('delivery_address'),
    pickupSlotId: uuid('pickup_slot_id').references(() => pickupSlot.id),
    paidAt: at('paid_at'),
    purchaseConfirmedAt: at('purchase_confirmed_at'),
    orderedAt: at('ordered_at').notNull(),
  },
  (t) => [
    check('merch_order_status_check', sql`${t.status} in ('CREATED', 'AWAITING_DEPOSIT', 'PAID', 'EXPIRED', 'FAILED')`),
    check('merch_order_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('merch_order_pg_store_check', sql`${t.pgStore} in ('STANDARD', 'ESCROW')`),
    check('merch_order_shipping_fee_check', sql`${t.shippingFee} >= 0`),
    check('merch_order_fulfillment_check', sql`${t.fulfillment} in ('DELIVERY', 'PICKUP', 'WALLET')`),
    check('merch_order_amount_check', sql`${t.amount} >= 0`),
    check('merch_order_pickup_slot_check', sql`(${t.fulfillment} = 'PICKUP') = (${t.pickupSlotId} is not null)`),
    index('merch_order_promoter_event_idx').on(t.promoterId, t.eventId, t.orderedAt),
    // 만료 작업의 DB 쓸기(결제 전 주문, ADR-0300 결정 9)와 팬 주문 목록(최근 순)
    index('merch_order_reserved_idx').on(t.stockReservedUntil).where(sql`${t.status} = 'CREATED'`),
    index('merch_order_account_idx').on(t.accountId, t.orderedAt, t.id),
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
    optionSnapshot: jsonb('option_snapshot').$type<Record<string, unknown>>(),
    linkedTicketId: uuid('linked_ticket_id'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    check('merch_order_item_status_check', sql`${t.status} in ('READY', 'SHIPPED', 'DELIVERED', 'PICKED_UP', 'LOCKED', 'RETURN_REQUESTED', 'RETURN_RECEIVED', 'DISPUTED', 'CANCELLED', 'REFUNDED')`),
    check('merch_order_item_fulfillment_check', sql`${t.fulfillment} in ('DELIVERY', 'PICKUP', 'WALLET')`),
    check('merch_order_item_quantity_check', sql`${t.quantity} > 0`),
    check('merch_order_item_amount_check', sql`${t.unitAmount} >= 0 and ${t.refundedAmount} >= 0`),
    check('merch_order_item_commission_check', sql`${t.commissionRateBp} >= 0 and ${t.commissionRateBp} <= 10000`),
    index('merch_order_item_promoter_event_idx').on(t.promoterId, t.eventId),
    index('merch_order_item_order_idx').on(t.orderId),
    index('merch_order_item_linked_ticket_idx').on(t.linkedTicketId),
    check('merch_order_item_cancel_reason_check', sql`${t.cancelReason} in ('UNCLAIMED')`),
  ],
);

// 굿즈 주문의 결제 시도(ADR-0300 결정 5). 주문마다 READY 하나·ACCEPTED 하나(부분 유일 인덱스)
export const merchPaymentAttempt = pgTable(
  'merch_payment_attempt',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull().references(() => merchOrder.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    pg: text('pg').notNull(),
    payMethod: text('pay_method'),
    status: text('status').notNull(),
    createdAt: at('created_at').notNull(),
    acceptedAt: at('accepted_at'),
  },
  (t) => [
    check('merch_payment_attempt_status_check', sql`${t.status} in ('READY', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED', 'FAILED')`),
    check('merch_payment_attempt_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('merch_payment_attempt_no_check', sql`${t.attemptNo} >= 1`),
    uniqueIndex('merch_payment_attempt_order_no_uq').on(t.orderId, t.attemptNo),
    uniqueIndex('merch_payment_attempt_ready_uq').on(t.orderId).where(sql`${t.status} = 'READY'`),
    uniqueIndex('merch_payment_attempt_accepted_uq').on(t.orderId).where(sql`${t.status} = 'ACCEPTED'`),
  ],
);

// 승인 명령 작업(ADR-0300 결정 5·6). 결과를 반영하는 트랜잭션이 지운다. 결제 참조는 행과 함께 사라지고 로그에 싣지 않는다
export const merchConfirmJob = pgTable(
  'merch_confirm_job',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => merchOrder.id, { onDelete: 'cascade' }),
    attemptId: uuid('attempt_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    pg: text('pg').notNull(),
    paymentRef: jsonb('payment_ref').$type<Record<string, string>>().notNull(),
    amount: integer('amount').notNull(),
    authenticatedAt: at('authenticated_at').notNull(),
    sent: boolean('sent').notNull().default(false),
    tries: integer('tries').notNull().default(0),
    nextAt: at('next_at').notNull(),
  },
  (t) => [index('merch_confirm_job_next_idx').on(t.nextAt)],
);

// 굿즈 결제 취소 요청(ADR-0301 결정 5). ID가 결제 취소 ID(결제사 멱등키 cancel-{ID})다
export const merchRefund = pgTable(
  'merch_refund',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull().references(() => merchOrder.id, { onDelete: 'cascade' }),
    itemIds: uuid('item_ids').array().notNull(),
    amount: integer('amount').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull(),
    nextAt: at('next_at'),
    alerted: boolean('alerted').notNull().default(false),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('merch_refund_status_check', sql`${t.status} in ('REQUESTED', 'CANCEL_PENDING', 'CANCELLED', 'REJECTED')`),
    check('merch_refund_amount_check', sql`${t.amount} > 0`),
    index('merch_refund_due_idx').on(t.nextAt).where(sql`${t.status} in ('REQUESTED', 'CANCEL_PENDING')`),
    index('merch_refund_order_idx').on(t.orderId),
  ],
);
