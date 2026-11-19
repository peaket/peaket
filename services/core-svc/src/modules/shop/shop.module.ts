// shop 모듈 조립. 메모리(단위 시험)와 Drizzle(운영) 저장소를 고른다.
// 굿즈 주문(BAT-600)은 재고 Redis(MERCH_STOCK)·payment-svc(MERCH_PAYMENTS)·ticket-svc(HELD_TICKETS)를 포트로 받는다. 운영에서 주소가 없으면 main.ts가 '늘 실패' 어댑터를 넣어
// 그 경로만 503이고 나머지는 뜬다(후기 자격과 같은 꼴).
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, DATABASE, INTERNAL_TOKEN } from '@peaket/platform';
import { Products } from './application/products.js';
import { MerchSettlements } from './application/merch-settlements.js';
import { CreateMerchOrder } from './application/create-merch-order.js';
import { MerchCancel } from './application/merch-cancel.js';
import { MerchOrdersRead } from './application/merch-orders-read.js';
import { MerchPayment } from './application/merch-payment.js';
import { MerchRefundRetry } from './application/merch-refund-retry.js';
import { MerchReturn } from './application/merch-return.js';
import { TicketAddons } from './application/ticket-addons.js';
import { type ShopLogger, ShopSignals, silentShopLogger } from './application/shop-signals.js';
import { COMMISSION_RATE_SOURCE, PRODUCT_EVENT_DIRECTORY, PRODUCT_STORE, type CommissionRateSource, type ProductEventDirectory, type ProductStore } from './domain/ports.js';
import {
  HELD_TICKETS,
  MERCH_CONSENT_VERSION,
  MERCH_ORDER_STORE,
  MERCH_PAYMENTS,
  MERCH_STOCK,
  PRODUCT_TYPE_DIRECTORY,
  SHOP_ORDER_STORE,
  SHOP_REAUTH_GATE,
  type HeldTicketsPort,
  type MerchOrderStore,
  type MerchPayments,
  type MerchStock,
  type ProductTypeDirectory,
  type ShopOrderStore,
  type ShopReauthGate,
  closedShopReauthGate,
} from './domain/merch-ports.js';
import { DrizzleProductEventDirectory, DrizzleProductStore } from './adapters/db/drizzle-product-store.js';
import { DrizzleMerchOrderStore } from './adapters/db/drizzle-merch-store.js';
import { DrizzleProductTypeDirectory, DrizzleShopOrderStore } from './adapters/db/drizzle-merch-orders.js';
import { FixedCommissionRate, MemoryProductEventDirectory, MemoryProductStore } from './adapters/memory-product-store.js';
import { MemoryMerchOrderStore } from './adapters/memory-merch-store.js';
import { MemoryProductTypeDirectory, MemoryShopOrderStore } from './adapters/memory-merch-orders.js';
import { MemoryMerchStock } from './adapters/memory-merch-stock.js';
import { MemoryMerchPayments } from './adapters/grpc-payment.js';
import { MemoryHeldTickets } from './adapters/grpc-held-tickets.js';
import { PartnerProductController } from './inbound/partner-product.controller.js';
import { InternalMerchSettlementController } from './inbound/internal-merch-settlement.controller.js';
import { ShopOrderController } from './inbound/shop-order.controller.js';
import { TicketAddonController } from './inbound/ticket-addon.controller.js';

export const SHOP_PARTNER_DATABASE = Symbol.for('peaket.shop.partner-database');
const SHOP_LOGGER = Symbol.for('peaket.shop.logger');
/** 결제 상태 long polling의 기다리기(시험은 바꿔 끼운다) */
export const SHOP_SLEEP = Symbol.for('peaket.shop.sleep');

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface MemoryShopWiring {
  store?: ProductStore;
  directory?: ProductEventDirectory;
  commission?: CommissionRateSource;
  merch?: MerchOrderStore;
  /** 굿즈 주문 저장소(기본: store가 MemoryProductStore면 그것을 쓰는 MemoryShopOrderStore) */
  orders?: ShopOrderStore;
  stock?: MerchStock;
  payments?: MerchPayments;
  held?: HeldTicketsPort;
  /** 굿즈 취소 재인증 확인기(기본: 닫힌 대역, 늘 403) */
  reauth?: ShopReauthGate;
  types?: ProductTypeDirectory;
  /** 택배 주문 동의 문안 판(기본 MEMORY_MERCH_CONSENT_VERSION) */
  consentVersion?: string;
  sleep?: Sleep;
  signals?: ShopSignals;
}

export interface DatabaseShopWiring {
  database: Database;
  partnerDatabase: Database;
  commission?: CommissionRateSource;
  /** 재고 Redis(PEAKET_SHOP_REDIS_URL). main.ts가 없으면 unavailableMerchStock을 넣는다 */
  stock: MerchStock;
  /** payment-svc(PEAKET_PAYMENT_GRPC_ADDR). 없으면 unavailableMerchPayments */
  payments: MerchPayments;
  /** ticket-svc ListHeldTickets(PEAKET_TICKET_GRPC_URL). 없으면 unavailableHeldTickets */
  held: HeldTicketsPort;
  /** 굿즈 취소 재인증 확인기(PEAKET_IDENTITY_FAN_JWKS_URL). 없으면 닫힌 대역 */
  reauth?: ShopReauthGate;
  /** PEAKET_MERCH_CONSENT_VERSION. 없으면 택배 주문만 503 */
  consentVersion?: string;
  logger?: ShopLogger;
  signals?: ShopSignals;
}

/** 메모리 조립의 기본 동의 문안 판 [시험값] */
export const MEMORY_MERCH_CONSENT_VERSION = '2026-10-30';

@Module({})
export class ShopModule {
  static register(o: { storage: 'memory'; wiring?: MemoryShopWiring } | ({ storage: 'database' } & DatabaseShopWiring)): DynamicModule {
    const signals = (o.storage === 'memory' ? o.wiring?.signals : o.signals) ?? new ShopSignals();
    const providers: Provider[] = [
      {
        provide: Products,
        useFactory: (store: ProductStore, directory: ProductEventDirectory, commission: CommissionRateSource, clock: Clock, types: ProductTypeDirectory, stock: MerchStock, logger: ShopLogger) =>
          new Products({ store, directory, commission, clock, types, stock, logger }),
        inject: [PRODUCT_STORE, PRODUCT_EVENT_DIRECTORY, COMMISSION_RATE_SOURCE, CLOCK, PRODUCT_TYPE_DIRECTORY, MERCH_STOCK, SHOP_LOGGER],
      },
      { provide: COMMISSION_RATE_SOURCE, useValue: (o.storage === 'memory' ? o.wiring?.commission : o.commission) ?? new FixedCommissionRate() },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      { provide: ShopSignals, useValue: signals },
      { provide: SHOP_LOGGER, useValue: (o.storage === 'database' ? o.logger : undefined) ?? silentShopLogger },
      {
        provide: MerchSettlements,
        useFactory: (store: MerchOrderStore) => new MerchSettlements(store),
        inject: [MERCH_ORDER_STORE],
      },
      {
        provide: CreateMerchOrder,
        useFactory: (store: ShopOrderStore, stock: MerchStock, held: HeldTicketsPort, clock: Clock, consentVersion: string | undefined, logger: ShopLogger) =>
          new CreateMerchOrder({ store, stock, held, clock, consentVersion, signals, logger }),
        inject: [SHOP_ORDER_STORE, MERCH_STOCK, HELD_TICKETS, CLOCK, MERCH_CONSENT_VERSION, SHOP_LOGGER],
      },
      {
        provide: MerchPayment,
        useFactory: (store: ShopOrderStore, stock: MerchStock, payments: MerchPayments, clock: Clock, logger: ShopLogger) => new MerchPayment({ store, stock, payments, clock, signals, logger }),
        inject: [SHOP_ORDER_STORE, MERCH_STOCK, MERCH_PAYMENTS, CLOCK, SHOP_LOGGER],
      },
      {
        provide: MerchOrdersRead,
        useFactory: (store: ShopOrderStore, payments: MerchPayments, clock: Clock, sleep: Sleep | undefined) => new MerchOrdersRead({ store, payments, clock, ...(sleep ? { sleep } : {}) }),
        inject: [SHOP_ORDER_STORE, MERCH_PAYMENTS, CLOCK, SHOP_SLEEP],
      },
      {
        provide: MerchCancel,
        useFactory: (store: ShopOrderStore, payments: MerchPayments, reauth: ShopReauthGate, clock: Clock, logger: ShopLogger) => new MerchCancel({ store, payments, reauth, clock, signals, logger }),
        inject: [SHOP_ORDER_STORE, MERCH_PAYMENTS, SHOP_REAUTH_GATE, CLOCK, SHOP_LOGGER],
      },
      {
        provide: MerchReturn,
        useFactory: (store: ShopOrderStore, read: MerchOrdersRead, clock: Clock, logger: ShopLogger) => new MerchReturn({ store, read, clock, signals, logger }),
        inject: [SHOP_ORDER_STORE, MerchOrdersRead, CLOCK, SHOP_LOGGER],
      },
      {
        provide: MerchRefundRetry,
        useFactory: (store: ShopOrderStore, payments: MerchPayments, clock: Clock, logger: ShopLogger) => new MerchRefundRetry({ store, payments, clock, signals, logger }),
        inject: [SHOP_ORDER_STORE, MERCH_PAYMENTS, CLOCK, SHOP_LOGGER],
      },
      {
        provide: TicketAddons,
        useFactory: (store: ShopOrderStore, held: HeldTicketsPort, orders: CreateMerchOrder) => new TicketAddons({ store, held, orders }),
        inject: [SHOP_ORDER_STORE, HELD_TICKETS, CreateMerchOrder],
      },
    ];
    const controllers = [PartnerProductController, InternalMerchSettlementController, ShopOrderController, TicketAddonController];
    if (o.storage === 'database') {
      return {
        module: ShopModule,
        controllers,
        providers: [
          ...providers,
          { provide: SHOP_PARTNER_DATABASE, useValue: o.partnerDatabase },
          { provide: PRODUCT_STORE, useFactory: (db: Database) => new DrizzleProductStore(db), inject: [SHOP_PARTNER_DATABASE] },
          { provide: PRODUCT_EVENT_DIRECTORY, useFactory: (db: Database) => new DrizzleProductEventDirectory(db), inject: [DATABASE] },
          { provide: MERCH_ORDER_STORE, useFactory: (app: Database) => new DrizzleMerchOrderStore(app), inject: [DATABASE] },
          { provide: SHOP_ORDER_STORE, useFactory: (app: Database, clock: Clock) => new DrizzleShopOrderStore(app, clock), inject: [DATABASE, CLOCK] },
          { provide: PRODUCT_TYPE_DIRECTORY, useFactory: (app: Database) => new DrizzleProductTypeDirectory(app), inject: [DATABASE] },
          { provide: MERCH_STOCK, useValue: o.stock },
          { provide: MERCH_PAYMENTS, useValue: o.payments },
          { provide: HELD_TICKETS, useValue: o.held },
          { provide: SHOP_REAUTH_GATE, useValue: o.reauth ?? closedShopReauthGate },
          { provide: MERCH_CONSENT_VERSION, useFactory: () => o.consentVersion },
          { provide: SHOP_SLEEP, useFactory: () => undefined },
        ],
      };
    }
    const w = o.wiring ?? {};
    const store = w.store ?? new MemoryProductStore();
    const orders = w.orders ?? new MemoryShopOrderStore(store instanceof MemoryProductStore ? store : new MemoryProductStore());
    return {
      module: ShopModule,
      controllers,
      providers: [
        ...providers,
        { provide: PRODUCT_STORE, useValue: store },
        { provide: PRODUCT_EVENT_DIRECTORY, useValue: w.directory ?? new MemoryProductEventDirectory() },
        { provide: MERCH_ORDER_STORE, useValue: w.merch ?? new MemoryMerchOrderStore() },
        { provide: SHOP_ORDER_STORE, useValue: orders },
        { provide: PRODUCT_TYPE_DIRECTORY, useValue: w.types ?? new MemoryProductTypeDirectory() },
        { provide: MERCH_STOCK, useValue: w.stock ?? new MemoryMerchStock() },
        { provide: MERCH_PAYMENTS, useValue: w.payments ?? new MemoryMerchPayments() },
        { provide: HELD_TICKETS, useValue: w.held ?? new MemoryHeldTickets() },
        { provide: SHOP_REAUTH_GATE, useValue: w.reauth ?? closedShopReauthGate },
        { provide: MERCH_CONSENT_VERSION, useValue: w.consentVersion ?? MEMORY_MERCH_CONSENT_VERSION },
        { provide: SHOP_SLEEP, useFactory: () => w.sleep },
      ],
    };
  }
}
