// core-svc relay 프로세스의 정비 일(identity-svc relay의 maintenanceTasks와 같은 꼴, ADR-0086·ADR-0261 결정 7·9, BUILD_ORDER HOT-250).
// 판매 자격 명단 파기(sale-eligibility-purge)와 사본 다시 넘기기(sale-eligibility-copy)다. 정비 역할 연결(PEAKET_MAINTENANCE_DATABASE_URL, 모든 테넌트)을 쓴다.
// 그 로그인 사용자는 core_maintenance 역할(마이그레이션 0008)에 들어 있어야 한다(리뷰 S7).
// 사본을 쓰는 쪽은 소유자 결정 대기라 사본 어댑터는 늘 실패하는 어댑터다(지표 sale_eligibility_copy_unwired_total, 일은 실패로 끝나 정비 실패 지표에도 남는다).
import { type Clock, type Database, type MaintenanceTask, createPlatformLogger, loadPlatformConfig } from '@peaket/platform';
import { DrizzleSaleMaintenanceStore, SaleEligibilityMetrics, saleEligibilityMaintenanceTasks, UnwiredSaleEligibilityCopy } from './modules/catalog/index.js';

export const CORE_MAINTENANCE_TASK_NAMES = ['sale-eligibility-purge', 'sale-eligibility-copy'] as const;

export function coreMaintenanceTasks(database: Database, clock: Clock, env: NodeJS.ProcessEnv = process.env): { tasks: MaintenanceTask[]; copy: UnwiredSaleEligibilityCopy; metrics: SaleEligibilityMetrics } {
  const config = loadPlatformConfig(env);
  const logger = createPlatformLogger({ service: 'core-svc', env: config.env, version: config.version, clock, level: config.logLevel });
  const copy = new UnwiredSaleEligibilityCopy();
  // 넘기지 못한 명단 수 sale_eligibility_copy_pending과 사본 넘기기 결과(리뷰 C2). 등록부에 다는 것은 relay.ts
  const metrics = new SaleEligibilityMetrics();
  return { tasks: saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(database), copy, clock, logger, metrics), copy, metrics };
}
