// shop 모듈 조립. 메모리(단위 시험)와 Drizzle(운영) 저장소를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, DATABASE } from '@peaket/platform';
import { Products } from './application/products.js';
import { COMMISSION_RATE_SOURCE, PRODUCT_EVENT_DIRECTORY, PRODUCT_STORE, type CommissionRateSource, type ProductEventDirectory, type ProductStore } from './domain/ports.js';
import { DrizzleProductEventDirectory, DrizzleProductStore } from './adapters/db/drizzle-product-store.js';
import { FixedCommissionRate, MemoryProductEventDirectory, MemoryProductStore } from './adapters/memory-product-store.js';
import { PartnerProductController } from './inbound/partner-product.controller.js';

export const SHOP_PARTNER_DATABASE = Symbol.for('peaket.shop.partner-database');

export interface MemoryShopWiring {
  store?: ProductStore;
  directory?: ProductEventDirectory;
  commission?: CommissionRateSource;
}

export interface DatabaseShopWiring {
  database: Database;
  partnerDatabase: Database;
  commission?: CommissionRateSource;
}

@Module({})
export class ShopModule {
  static register(o: { storage: 'memory'; wiring?: MemoryShopWiring } | ({ storage: 'database' } & DatabaseShopWiring)): DynamicModule {
    const providers: Provider[] = [
      {
        provide: Products,
        useFactory: (store: ProductStore, directory: ProductEventDirectory, commission: CommissionRateSource, clock: Clock) => new Products({ store, directory, commission, clock }),
        inject: [PRODUCT_STORE, PRODUCT_EVENT_DIRECTORY, COMMISSION_RATE_SOURCE, CLOCK],
      },
      { provide: COMMISSION_RATE_SOURCE, useValue: (o.storage === 'memory' ? o.wiring?.commission : o.commission) ?? new FixedCommissionRate() },
    ];
    if (o.storage === 'database') {
      return {
        module: ShopModule,
        controllers: [PartnerProductController],
        providers: [
          ...providers,
          { provide: SHOP_PARTNER_DATABASE, useValue: o.partnerDatabase },
          { provide: PRODUCT_STORE, useFactory: (db: Database) => new DrizzleProductStore(db), inject: [SHOP_PARTNER_DATABASE] },
          { provide: PRODUCT_EVENT_DIRECTORY, useFactory: (db: Database) => new DrizzleProductEventDirectory(db), inject: [DATABASE] },
        ],
      };
    }
    return {
      module: ShopModule,
      controllers: [PartnerProductController],
      providers: [
        ...providers,
        { provide: PRODUCT_STORE, useValue: o.wiring?.store ?? new MemoryProductStore() },
        { provide: PRODUCT_EVENT_DIRECTORY, useValue: o.wiring?.directory ?? new MemoryProductEventDirectory() },
      ],
    };
  }
}
