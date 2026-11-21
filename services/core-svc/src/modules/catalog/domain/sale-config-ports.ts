// 판매 설정 사본의 저장소 포트(판매 승인 LCH-080, docs/data.md `q:{event:E}:cfg`).
// queue-svc는 대기열 Redis를, purchase-svc(BAT-051)는 core DB `event_sale_config`을 읽는다. 한 승인에서 둘을 함께 쓴다.
import type { EventSaleConfig, EventSaleConfigFacts } from './event-sale-config.js';

/** 관제 판매 승인·설정 사본 쓰기의 DB 연결(core_ops). 팬 경로 DATABASE(core_app)와 나눈다 */
export const OPS_DATABASE = Symbol('OPS_DATABASE');

export interface DueEventConfig {
  eventId: string;
  promoterId: string;
  endsAt: Date;
}

/** 온세일 윈도우가 끝난 회차(감사 공개 체크포인트의 회차 마감, ADR-0348 결정 9). 회차 ID와 마감 시각(판매 시작 + 60분)만 담는다 */
export interface OnsaleClosedEvent {
  eventId: string;
  closedAt: Date;
}

/** 온세일 윈도우 끝 = 판매 시작 + 60분(ADR-0075 결정 3, docs/features/queue-admission.md) */
export const ONSALE_WINDOW_END_MS = 60 * 60_000;

export interface SaleConfigStore {
  /** 회차 설정과 진행 중 회차 목록을 함께 쓴다. 같은 값을 다시 써도 결과가 같다 */
  put(configs: readonly EventSaleConfig[], admission: readonly { eventId: string; startsAtMs: number }[]): Promise<void>;
  /** 시험·읽기용. 없으면 undefined */
  get(eventId: string): Promise<EventSaleConfig | undefined>;
  /** endsAt이 through 이하인 회차(회차 정산 스케줄러 원천). */
  listEndedBefore(through: Date, limit: number): Promise<DueEventConfig[]>;
  /** 공연 설정·계약의 회차 수수료율(bp). 없으면 undefined(A1-H10). */
  commissionRateBp(eventId: string): Promise<number | undefined>;
  /** 판매 시작 + 60분이 [from, to)에 든 회차(마감 시각·회차 ID 차례, limit개까지). 대기열 사본처럼 원천이 아니면 없다 */
  listOnsaleClosed?(from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]>;
}

export const SALE_CONFIG_STORE = Symbol('SALE_CONFIG_STORE');

/** 읽기 전용 사본 읽기(core_app). 내부 HTTP 경로가 쓰는 최소 권한 포트다 */
export interface SaleConfigReader {
  get(eventId: string): Promise<EventSaleConfig | undefined>;
  /** endsAt이 through 이하인 회차(회차 정산 스케줄러 원천). */
  listEndedBefore(through: Date, limit: number): Promise<DueEventConfig[]>;
  /** 공연 설정·계약의 회차 수수료율(bp). 없으면 undefined(A1-H10). */
  commissionRateBp(eventId: string): Promise<number | undefined>;
  /** 판매 시작 + 60분이 [from, to)에 든 회차(ops-svc 게시 작업, ADR-0348 결정 9). 없으면 내부 경로가 503이다 */
  listOnsaleClosed?(from: Date, to: Date, limit: number): Promise<OnsaleClosedEvent[]>;
}

export const SALE_CONFIG_READER = Symbol('SALE_CONFIG_READER');

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
