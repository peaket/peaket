// 관제 실시간 표가 바깥과 닿는 자리(ClickHouse rt 뷰·회차 기준 자료·지표·core 회차 소속).
import type { BucketRow, CumulativeRow, FreshnessRow, SeatMapRow } from './realtime-table.js';

/** rt 매개변수 뷰 셋 읽기(docs/streaming.md §4.3). 고정 SQL에 값만 매개변수로 넘긴다. 실패는 RtSourceFailure */
export interface RtQuerySource {
  /** rt.v_cumulative(event_id) */
  cumulative(eventId: string): Promise<readonly CumulativeRow[]>;
  /** rt.v_bucket(event_id, from_ts): fromMs(포함) 뒤의 1초 칸 */
  buckets(eventId: string, fromMs: number): Promise<readonly BucketRow[]>;
  /** rt.v_freshness: 텔레메트리 셋 파티션마다 마지막 심장 박동 */
  freshness(): Promise<readonly FreshnessRow[]>;
}

/** 회차 기준 자료 bronze.brz_ref_seat_map 읽기(잔여석 계산용, ADR-0073). 행이 없으면 빈 목록, 읽지 못하면 RtSourceFailure */
export interface SeatMapSource {
  seatMap(eventId: string): Promise<readonly SeatMapRow[]>;
}

/** 조회 종류(rt_query_seconds{view}의 값) */
export type RtView = 'v_cumulative' | 'v_bucket' | 'v_freshness' | 'seat_map';

/** 지표(docs/streaming.md §2.7·§9). 이름표에 회차 ID를 싣지 않는다(카디널리티 규칙, observability §8) */
export interface RtSignals {
  /** 조회 하나의 시간(초)과 성공 여부 */
  query(view: RtView, seconds: number, ok: boolean): void;
  /** 주기마다 두 길의 신선도(초) */
  freshness(path: 'cumulative' | 'bucket', seconds: number): void;
  /** 주기마다 상태: Degraded, 거래 사건이 끊긴 관심 회차 수, 관심 회차 수 */
  state(s: { readonly degraded: boolean; readonly tradeGapEvents: number; readonly watchedEvents: number }): void;
}

/** 회차 판매자(core 판매 설정의 promoterId). 없는 회차·판매 승인 전 회차는 undefined, 확인 실패는 던진다 */
export interface EventOwners {
  find(eventId: string): Promise<{ readonly promoterId: string } | undefined>;
}

/** Degraded 전환·되돌림, 거래 사건 끊김을 남기는 로그(값만, 개인정보 없음) */
export interface RtBoardLog {
  warn(fields: Record<string, unknown>, msg: string): void;
}
