// 정비 일 `sale-config-publish`(판매 승인 LCH-080): 승인된 공연의 회차 판매 설정 사본을 다시 쓴다.
// 판매 승인은 같은 일을 승인 직후에 부르고, 이 일은 승인 때 쓰지 못한 사본(장애·재시작)을 하루 한 번 복구한다.
import type { MaintenanceTask } from '@peaket/platform';
import type { SaleConfigMaintenanceStore } from '../domain/sale-config-ports.js';
import type { PublishSaleConfigs } from './publish-sale-configs.js';

type Log = { info?(o: object, msg?: string): void; warn(o: object, msg?: string): void };

/** 한 번에 훑는 승인 공연 수 [가정] */
const PRODUCTION_BATCH = 500;

export function saleConfigMaintenanceTasks(store: SaleConfigMaintenanceStore, publish: Pick<PublishSaleConfigs, 'run'>, logger?: Log): MaintenanceTask[] {
  const warn = (o: object, msg: string) => {
    try {
      logger?.warn(o, msg);
    } catch {
      // 기록 실패는 정비를 바꾸지 않는다
    }
  };
  return [
    {
      name: 'sale-config-publish',
      when: 'daily',
      run: async (signal) => {
        const rows = await store.approvedProductions(PRODUCTION_BATCH);
        let published = 0;
        let failed = 0;
        for (const r of rows) {
          if (signal?.aborted) break;
          try {
            await publish.run({ productionId: r.productionId, tenantId: r.promoterId });
            published++;
          } catch (e) {
            failed++;
            warn({ event: 'sale_config_publish_failed', productionId: r.productionId, err: (e as Error).name }, '회차 판매 설정 사본을 다시 쓰지 못했다(다음 정비가 다시 쓴다)');
          }
        }
        if (failed > 0) throw new Error(`회차 판매 설정 사본 ${published}개를 썼고 ${failed}개를 쓰지 못했다`);
        return { published, failed };
      },
    },
  ];
}
