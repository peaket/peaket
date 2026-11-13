// 판매 설정 사본의 저장소 포트(판매 승인 LCH-080, docs/data.md `q:{event:E}:cfg`).
// queue-svc는 대기열 Redis를, purchase-svc(BAT-051)는 core DB `event_sale_config`을 읽는다. 한 승인에서 둘을 함께 쓴다.
import type { EventSaleConfig, EventSaleConfigFacts } from './event-sale-config.js';

/** 관제 판매 승인·설정 사본 쓰기의 DB 연결(core_ops). 팬 경로 DATABASE(core_app)와 나눈다 */
export const OPS_DATABASE = Symbol('OPS_DATABASE');

export interface SaleConfigStore {
  /** 회차 설정과 진행 중 회차 목록을 함께 쓴다. 같은 값을 다시 써도 결과가 같다 */
  put(configs: readonly EventSaleConfig[], admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void>;
  /** 시험·읽기용. 없으면 undefined */
  get(eventId: string): Promise<EventSaleConfig | undefined>;
}

export const SALE_CONFIG_STORE = Symbol('SALE_CONFIG_STORE');

/** 회차의 좌석맵 판·결제사 상한을 읽는 포트. 없으면 그 선택 칸을 빼고 쓴다 */
export interface SaleConfigFactsSource {
  of(eventIds: readonly string[]): Promise<Map<string, EventSaleConfigFacts>>;
}

export const SALE_CONFIG_FACTS = Symbol('SALE_CONFIG_FACTS');

/** 판매 승인을 기다리는 공연(정비 일의 입력) */
export interface ApprovedProduction {
  productionId: string;
  promoterId: string;
}

/** 정비 일이 모든 테넌트의 승인 공연을 읽는 포트 */
export interface SaleConfigMaintenanceStore {
  approvedProductions(limit: number): Promise<ApprovedProduction[]>;
}

export const SALE_CONFIG_MAINTENANCE_STORE = Symbol('SALE_CONFIG_MAINTENANCE_STORE');
