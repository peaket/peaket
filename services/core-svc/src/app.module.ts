// 뿌리 모듈: 컨텍스트 모듈과 공용 설정(DB)을 모은다. catalog·review·shop·notify·export를 싣는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { CatalogModule, type MediaWiring, type MemoryCatalogRepository, type OpsApprovalClient, type PayoutRegistrationPort, type SaleConfigMetrics, type SaleConfigStore, type SaleOpen } from './modules/catalog/index.js';
import { ReviewModule, type DatabaseReviewWiring, type MemoryReviewWiring } from './modules/review/index.js';
import { ShopModule, unavailableHeldTickets, unavailableMerchPayments, unavailableMerchStock, type DatabaseShopWiring, type MemoryShopWiring } from './modules/shop/index.js';
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
          /** 웹훅 발송기 전용 core_notify 연결(ADR-0351 결정 2). 빠뜨린 조립은 컴파일되지 않는다 */
          notifyDatabase: Database;
          partnerDatabase: Database;
          opsDatabase?: Database;
          /** 검색 전용 연결 묶음(ADR-0271 결정 5, 운영은 읽기 전용 복제본). 없으면 database */
          searchDatabase?: Database;
          media: MediaWiring;
          review?: Omit<DatabaseReviewWiring, 'database'>;
          /** 굿즈 주문의 재고 Redis·payment-svc·ticket-svc. 빠진 것은 '늘 실패' 어댑터(그 경로만 503)다 */
          shop?: Partial<Omit<DatabaseShopWiring, 'database' | 'partnerDatabase'>>;
          notify?: { notificationTransport?: NotificationTransport; env?: Record<string, string | undefined>; fanNotify?: import('./modules/notify/notify.module.js').FanNotifyWiring };
          exportJwks?: { url: string; issuer: string };
          identityGrpc?: string;
          /** purchase-svc 예매자 명단 내부 HTTP(A2-03). 없으면 굿즈 주문 대역을 쓴다 */
          purchaseHttp?: { url: string; token?: string };
          /** 재인증 jti 1회용 저장소(Redis). 없으면 local·ci는 메모리 */
          reauthJti?: import('@peaket/platform').ReauthJtiStore;
          /** 계약 변경 요청이 부르는 ops-svc 내부 승인 생성 클라이언트(BAT-615). 없으면 그 경로만 503 */
          opsApprovals?: OpsApprovalClient;
          /** 판매 승인 사본을 DB와 대기열에 함께 쓰는 합성 저장소(BAT-616) */
          saleConfigStore?: SaleConfigStore;
          /** 판매 열기 클라이언트(BAT-616). 없으면 열기가 끝난 것으로 보는 메모리 어댑터 */
          saleOpen?: SaleOpen;
          /** 판매 승인 부수 효과 지표(BAT-616) */
          saleConfigMetrics?: SaleConfigMetrics;
          /** payment-svc 지급대행 등록(F-07-7, ADR-0370). main.ts가 assemblePayoutRegistration으로 넘긴다 */
          payoutRegistration?: PayoutRegistrationPort;
        }
      | {
          memory: true;
          catalog?: MemoryCatalogRepository;
          media?: Partial<MediaWiring>;
          saleConfigs?: SaleConfigStore;
          review?: MemoryReviewWiring;
          shop?: MemoryShopWiring;
          notify?: { store?: WebhookStore; notificationTransport?: NotificationTransport; env?: Record<string, string | undefined>; fanNotify?: import('./modules/notify/notify.module.js').FanNotifyWiring };
          export?: MemoryExportWiring;
          /** 시험이 넘기는 ops 승인 대역. 없으면 메모리 대역(기록만) */
          opsApprovals?: OpsApprovalClient;
          /** 시험이 넘기는 판매 열기 대역(BAT-616). 없으면 부른 값을 모으는 메모리 대역 */
          saleOpen?: SaleOpen;
          saleConfigMetrics?: SaleConfigMetrics;
          /** 시험이 넘기는 지급대행 등록 대역(F-07-7). 없으면 둘 다 꺼짐 */
          payoutRegistration?: PayoutRegistrationPort;
        },
  ): DynamicModule {
    if ('database' in o)
      return {
        module: AppModule,
        imports: [
          databaseModule(o.database),
          CatalogModule.register({ storage: 'database', partnerDatabase: o.partnerDatabase, ...(o.opsDatabase ? { opsDatabase: o.opsDatabase } : {}), ...(o.searchDatabase ? { searchDatabase: o.searchDatabase } : {}), media: o.media, ...(o.opsApprovals ? { opsApprovals: o.opsApprovals } : {}), ...(o.saleConfigStore ? { saleConfigStore: o.saleConfigStore } : {}), ...(o.saleOpen ? { saleOpen: o.saleOpen } : {}), ...(o.saleConfigMetrics ? { saleConfigMetrics: o.saleConfigMetrics } : {}), ...(o.payoutRegistration ? { payoutRegistration: o.payoutRegistration } : {}) }),
          ReviewModule.register({ storage: 'database', database: o.database, ...(o.review ? o.review : {}), ...(o.media ? { images: { origin: o.media.imageOrigin, objects: o.media.store, processing: o.media.processing } } : {}) }),
          ShopModule.register({
            storage: 'database',
            database: o.database,
            partnerDatabase: o.partnerDatabase,
            ...(o.shop ?? {}),
            stock: o.shop?.stock ?? unavailableMerchStock,
            payments: o.shop?.payments ?? unavailableMerchPayments,
            held: o.shop?.held ?? unavailableHeldTickets,
          }),
          NotifyModule.register({ storage: 'database', database: o.database, notifyDatabase: o.notifyDatabase, partnerDatabase: o.partnerDatabase, ...(o.notify?.notificationTransport ? { notificationTransport: o.notify.notificationTransport } : {}), ...(o.notify?.env ? { env: o.notify.env } : {}), ...(o.notify?.fanNotify ? { fanNotify: o.notify.fanNotify } : {}) }),
          ExportModule.register({
            storage: 'database',
            database: o.database,
            partnerDatabase: o.partnerDatabase,
            ...(o.exportJwks ? { jwks: o.exportJwks } : {}),
            ...(o.identityGrpc ? { identityGrpc: o.identityGrpc } : {}),
            ...(o.purchaseHttp ? { purchaseHttp: o.purchaseHttp } : {}),
            ...(o.reauthJti ? { reauthJti: o.reauthJti } : {}),
          }),
        ],
      };
    return {
      module: AppModule,
      imports: [
        CatalogModule.register({ storage: 'memory', ...(o.catalog ? { repository: o.catalog } : {}), ...(o.media ? { media: o.media } : {}), ...(o.saleConfigs ? { saleConfigs: o.saleConfigs } : {}), ...(o.opsApprovals ? { opsApprovals: o.opsApprovals } : {}), ...(o.saleOpen ? { saleOpen: o.saleOpen } : {}), ...(o.saleConfigMetrics ? { saleConfigMetrics: o.saleConfigMetrics } : {}), ...(o.payoutRegistration ? { payoutRegistration: o.payoutRegistration } : {}) }),
        ReviewModule.register({ storage: 'memory', wiring: { ...(o.catalog ? { catalogRepository: o.catalog } : {}), ...(o.review ?? {}), ...(o.media?.store && o.media.processing && o.media.imageOrigin ? { images: { origin: o.media.imageOrigin, objects: o.media.store, processing: o.media.processing } } : {}) } }),
        ShopModule.register({ storage: 'memory', ...(o.shop ? { wiring: o.shop } : {}) }),
        NotifyModule.register({ storage: 'memory', ...(o.notify?.store ? { store: o.notify.store } : {}), ...(o.notify?.notificationTransport ? { notificationTransport: o.notify.notificationTransport } : {}), ...(o.notify?.env ? { env: o.notify.env } : {}), ...(o.notify?.fanNotify ? { fanNotify: o.notify.fanNotify } : {}), ...(o.catalog ? { catalog: o.catalog } : {}) }),
        ExportModule.register({ storage: 'memory', ...(o.export ? { wiring: o.export } : {}) }),
      ],
    };
  }
}
