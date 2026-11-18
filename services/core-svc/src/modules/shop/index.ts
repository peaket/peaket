export { Products } from './application/products.js';
export { MerchSettlements } from './application/merch-settlements.js';
export { FixedCommissionRate, MemoryProductEventDirectory, MemoryProductStore } from './adapters/memory-product-store.js';
export { MemoryMerchOrderStore } from './adapters/memory-merch-store.js';
export { DrizzleMerchOrderStore } from './adapters/db/drizzle-merch-store.js';
export { DrizzlePartnerEventDirectory, MemoryPartnerEventDirectory } from './adapters/partner-event-directory.js';
export { ShopModule, type DatabaseShopWiring, type MemoryShopWiring } from './shop.module.js';
export { productEtag, statusOf, type Fulfillment, type ProductFilter, type ProductInput, type ProductPatch, type ProductRecord, type ProductStatus, type ProductView } from './domain/product.js';
export { maskName, maskPhone, productSettlementItem, productSettlementItems, settlementBasisDate, type AttendeeRecord, type MerchItemStatus, type MerchOrderItemRecord, type MerchOrderRecord, type ProductSettlementItem } from './domain/merch.js';
export type { MerchOrderStore } from './domain/merch-ports.js';
// 굿즈 주문·한정 재고·부가 상품·미수령(BAT-600, ADR-0299~0301)
export { CreateMerchOrder, type CreatedOrderView, type CreateShopOrderInput, type MerchOrderDeps } from './application/create-merch-order.js';
export { MerchPayment, type MerchPaymentDeps, type PaymentAttemptView } from './application/merch-payment.js';
export { MerchPaymentResults, type MerchResultsDeps, type ResultsTick } from './application/merch-payment-results.js';
export { MerchStockExpiry, LIMITED_PRODUCTS_REFRESH_MS, type ExpiryTick, type MerchExpiryDeps } from './application/merch-stock-expiry.js';
export { MerchOrdersRead, type PaymentStatusView } from './application/merch-orders-read.js';
export { TicketAddons } from './application/ticket-addons.js';
export { MerchUnclaimed, MERCH_UNCLAIMED_TASK } from './application/merch-unclaimed.js';
export { ProductAttributesCheck, PRODUCT_ATTRIBUTES_TASK, PRODUCT_ATTRIBUTES_BATCH } from './application/product-attributes-check.js';
export { ShopSignals, silentShopLogger, type ShopLogger } from './application/shop-signals.js';
export { intervalLoop, MERCH_LOOP_INTERVAL_MS, MERCH_REFUND_LOOP_INTERVAL_MS } from './application/shop-loops.js';
export { stockChangeOf } from './application/products.js';
export { MEMORY_MERCH_CONSENT_VERSION, SHOP_SLEEP } from './shop.module.js';
export { RedisMerchStock, merchStockKeys, unavailableMerchStock } from './adapters/redis-merch-stock.js';
export { MemoryMerchStock } from './adapters/memory-merch-stock.js';
export { GrpcMerchPayments, MemoryMerchPayments, unavailableMerchPayments } from './adapters/grpc-payment.js';
export { GrpcHeldTickets, HELD_TICKETS_DEADLINE_MS, MemoryHeldTickets, unavailableHeldTickets } from './adapters/grpc-held-tickets.js';
export { DrizzleProductTypeDirectory, DrizzleShopOrderStore } from './adapters/db/drizzle-merch-orders.js';
export { MemoryProductTypeDirectory, MemoryShopOrderStore } from './adapters/memory-merch-orders.js';
export * from './domain/merch-order.js';
export { isBusinessDay, kstDateOf, kstMinuteOfDay, kstWeekday, nextBusinessDay } from './domain/business-day.js';
export {
  CheckoutFailed,
  HeldTicketsUnavailable,
  StockUnavailable,
  type CancelOutcome,
  type ConfirmJob,
  type HeldTicketsPort,
  type MerchPayments,
  type MerchStock,
  type PaymentState,
  type ProductTypeDirectory,
  type ReserveResult,
  type ShopOrderStore,
} from './domain/merch-ports.js';
export type { StockChange } from './domain/ports.js';
export { shopGuard, toPlatformProblem } from './application/shop-problems.js';
