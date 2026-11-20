// core-svc relay 프로세스의 정비 일(identity-svc relay의 maintenanceTasks와 같은 꼴, ADR-0086·ADR-0261 결정 7·9, BUILD_ORDER HOT-250).
// 판매 자격 명단 파기(sale-eligibility-purge)와 사본 다시 넘기기(sale-eligibility-copy)다. 정비 역할 연결(PEAKET_MAINTENANCE_DATABASE_URL, 모든 테넌트)을 쓴다.
// 그 로그인 사용자는 core_maintenance 역할(마이그레이션 0008)에 들어 있어야 한다(리뷰 S7).
// 사본을 쓰는 쪽은 소유자 결정 대기라 사본 어댑터는 늘 실패하는 어댑터다(지표 sale_eligibility_copy_unwired_total, 일은 실패로 끝나 정비 실패 지표에도 남는다).
import { type Clock, type Database, type MaintenanceTask, createPlatformLogger, loadPlatformConfig } from '@peaket/platform';
import {
  DrizzleSaleConfigMaintenanceStore,
  DrizzleSaleConfigStore,
  DrizzleSaleMaintenanceStore,
  DrizzleSaleStore,
  NoopSaleConfigFacts,
  PublishSaleConfigs,
  SaleConfigMetrics,
  SaleEligibilityMetrics,
  saleConfigMaintenanceTasks,
  saleEligibilityMaintenanceTasks,
  UnwiredSaleEligibilityCopy,
  type SaleConfigStore,
  type SaleOpen,
} from './modules/catalog/index.js';
import { DrizzleReviewStore, reviewMaintenanceTasks } from './modules/review/index.js';
import { DrizzleShopOrderStore, type MerchPayments, MerchUnclaimed, MERCH_UNCLAIMED_TASK, PRODUCT_ATTRIBUTES_TASK, ProductAttributesCheck, type ShopSignals } from './modules/shop/index.js';

/**
 * 후기 정비 일은 임시조치 끝내기(review-temp-block-expire, 매일)와 이전 판이 남긴 후기 행 고치기(review-purge-legacy, 정비 시간, ADR-0278·W8-audit2a 리뷰 A2)다.
 * shop 정비 일은 상품 속성 검증(product-attributes-check, 정비 시간 안 04:40 KST [가정], ADR-0300 결정 2)과 미수령 자동 취소(merch-unclaimed-cancel, 매일 10:00 KST [가정] 뒤 영업일,
 * ADR-0301 결정 5)다. 둘은 서비스 역할 연결(core_app, PEAKET_DATABASE_URL)이 있을 때만 돈다(BAT-600)
 */
export const CORE_MAINTENANCE_TASK_NAMES = ['sale-eligibility-purge', 'sale-eligibility-copy', 'sale-config-publish', 'review-temp-block-expire', 'review-purge-legacy', PRODUCT_ATTRIBUTES_TASK, MERCH_UNCLAIMED_TASK] as const;

export function coreMaintenanceTasks(
  database: Database,
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
  o: { saleConfigStore?: SaleConfigStore; opsDatabase?: Database; saleOpen?: SaleOpen; saleConfigMetrics?: SaleConfigMetrics; shop?: { database: Database; payments: MerchPayments; signals: ShopSignals } } = {},
): { tasks: MaintenanceTask[]; copy: UnwiredSaleEligibilityCopy; metrics: SaleEligibilityMetrics } {
  const config = loadPlatformConfig(env);
  const logger = createPlatformLogger({ service: 'core-svc', env: config.env, version: config.version, clock, level: config.logLevel });
  const copy = new UnwiredSaleEligibilityCopy();
  // 넘기지 못한 명단 수 sale_eligibility_copy_pending과 사본 넘기기 결과(리뷰 C2). 등록부에 다는 것은 relay.ts
  const metrics = new SaleEligibilityMetrics();
  const tasks = saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(database), copy, clock, logger, metrics);
  if (o.opsDatabase) {
    const store = o.saleConfigStore ?? new DrizzleSaleConfigStore(o.opsDatabase);
    const publish = new PublishSaleConfigs(new DrizzleSaleStore(o.opsDatabase), store, new NoopSaleConfigFacts(), clock, o.saleOpen, o.saleConfigMetrics);
    tasks.push(...saleConfigMaintenanceTasks(new DrizzleSaleConfigMaintenanceStore(o.opsDatabase), publish, logger));
  }
  tasks.push(...reviewMaintenanceTasks(new DrizzleReviewStore(database), clock));
  if (o.shop) {
    const store = new DrizzleShopOrderStore(o.shop.database, clock);
    const attributes = new ProductAttributesCheck({ store, clock, signals: o.shop.signals, logger });
    const unclaimed = new MerchUnclaimed({ store, payments: o.shop.payments, clock, signals: o.shop.signals, logger });
    tasks.push({ name: PRODUCT_ATTRIBUTES_TASK, when: 'window', run: (signal) => attributes.run(signal) }, { name: MERCH_UNCLAIMED_TASK, when: 'daily', run: (signal) => unclaimed.run(signal) });
  }
  return { tasks, copy, metrics };
}
