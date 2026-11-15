// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다. catalog·review·shop·notify·export를 싣는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { CatalogModule, type MediaWiring, type MemoryCatalogRepository, type SaleConfigStore } from './modules/catalog/index.js';
import { ReviewModule, type DatabaseReviewWiring, type MemoryReviewWiring } from './modules/review/index.js';
import { ShopModule, type DatabaseShopWiring, type MemoryShopWiring } from './modules/shop/index.js';
import { NotifyModule } from './modules/notify/index.js';
import type { NotificationTransport } from './modules/notify/index.js';
import type { WebhookStore } from './modules/notify/domain/ports.js';
import { ExportModule, type MemoryExportWiring } from './modules/export/index.js';

@Module({})
export class AppModule {
  /** 운영은 database, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(
    o:
      | {
          database: Database;
          partnerDatabase: Database;
          opsDatabase?: Database;
          media: MediaWiring;
          review?: Omit<DatabaseReviewWiring, 'database'>;
          shop?: Omit<DatabaseShopWiring, 'database' | 'partnerDatabase'>;
          notify?: { notificationTransport?: NotificationTransport; env?: Record<string, string | undefined> };
          exportJwks?: { url: string; issuer: string };
          identityGrpc?: string;
          /** purchase-svc 예매자 명단 내부 HTTP(A2-03). 없으면 굿즈 주문 대역을 쓴다 */
          purchaseHttp?: { url: string; token?: string };
        }
      | {
          memory: true;
          catalog?: MemoryCatalogRepository;
          media?: Partial<MediaWiring>;
          saleConfigs?: SaleConfigStore;
          review?: MemoryReviewWiring;
          shop?: MemoryShopWiring;
          notify?: { store?: WebhookStore; notificationTransport?: NotificationTransport; env?: Record<string, string | undefined> };
          export?: MemoryExportWiring;
        },
  ): DynamicModule {
    if ('database' in o)
      return {
        module: AppModule,
        imports: [
          databaseModule(o.database),
          CatalogModule.register({ storage: 'database', partnerDatabase: o.partnerDatabase, ...(o.opsDatabase ? { opsDatabase: o.opsDatabase } : {}), media: o.media }),
          ReviewModule.register({ storage: 'database', database: o.database, ...(o.review ? o.review : {}) }),
          ShopModule.register({ storage: 'database', database: o.database, partnerDatabase: o.partnerDatabase, ...(o.shop?.commission ? { commission: o.shop.commission } : {}) }),
          NotifyModule.register({ storage: 'database', database: o.database, partnerDatabase: o.partnerDatabase, ...(o.notify?.notificationTransport ? { notificationTransport: o.notify.notificationTransport } : {}), ...(o.notify?.env ? { env: o.notify.env } : {}) }),
          ExportModule.register({
            storage: 'database',
            database: o.database,
            partnerDatabase: o.partnerDatabase,
            ...(o.exportJwks ? { jwks: o.exportJwks } : {}),
            ...(o.identityGrpc ? { identityGrpc: o.identityGrpc } : {}),
            ...(o.purchaseHttp ? { purchaseHttp: o.purchaseHttp } : {}),
          }),
        ],
      };
    return {
      module: AppModule,
      imports: [
        CatalogModule.register({ storage: 'memory', ...(o.catalog ? { repository: o.catalog } : {}), ...(o.media ? { media: o.media } : {}), ...(o.saleConfigs ? { saleConfigs: o.saleConfigs } : {}) }),
        ReviewModule.register({ storage: 'memory', wiring: { ...(o.catalog ? { catalogRepository: o.catalog } : {}), ...(o.review ?? {}) } }),
        ShopModule.register({ storage: 'memory', ...(o.shop ? { wiring: o.shop } : {}) }),
        NotifyModule.register({ storage: 'memory', ...(o.notify?.store ? { store: o.notify.store } : {}), ...(o.notify?.notificationTransport ? { notificationTransport: o.notify.notificationTransport } : {}), ...(o.notify?.env ? { env: o.notify.env } : {}) }),
        ExportModule.register({ storage: 'memory', ...(o.export ? { wiring: o.export } : {}) }),
      ],
    };
  }
}
