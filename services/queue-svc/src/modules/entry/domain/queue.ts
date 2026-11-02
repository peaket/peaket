// 진입 컨텍스트의 규칙 값과 토큰 클레임(docs/features/queue-admission.md §3 '첫 구현의 세부', docs/data.md §3).

/** 사전 검증 토큰 수명(15분) */
export const PREVERIFY_TTL_MS = 15 * 60_000;
/** 진입 선점 값 PENDING:{요청 ID}의 수명 10초 [가정](기술 검토 중간-035) */
export const PENDING_TTL_MS = 10_000;
/** 대기 상태 파일 구간의 크기(§4) */
export const SEGMENT_SIZE = 1_000;
/** 오픈 직후 동시 도착 구간 N 2초 [가정](ADR-0041) */
export const OPEN_BATCH_MS = 2_000;
/** 판매 종료는 공연 시작 24시간 전(ADR-0064) */
export const SALE_END_BEFORE_START_MS = 24 * 3600_000;
/** 회차 일정 사본·순번 카운터·빠진 번호 기록이 판매 종료 뒤 남는 시간 1일 [가정](docs/data.md §3 q:{event:E}:cfg) */
export const KEEP_AFTER_SALE_END_MS = 24 * 3600_000;

/** 이용자에게 보이는 추가 검증 사유 범주(trust.proto ReasonCategory에서 접두사를 뺀 값, openapi QueueTicket.verificationReason) */
export const REASONS = ['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK', 'SHARED_PATTERN'] as const;
export type ReasonCategory = (typeof REASONS)[number];

/** 사전 검증 토큰 클레임 */
export interface PreverifyClaims {
  /** 회차 */
  e: string;
  /** 계정 ID */
  a: string;
  /** 기기 식별값(없으면 빈 문자열) */
  d: string;
  /** 최초 발급 시각(갱신해도 그대로) */
  i0: number;
  iat: number;
  exp: number;
  /** 여정 ID(UUIDv7, 갱신해도 그대로) */
  jny: string;
  /** 추가 검증 필요면 사유 범주 */
  vr?: ReasonCategory;
  /** 위험 판정을 받지 못해 사람 확인을 보류함(docs/features/bot-defense.md §11.2) */
  hd?: true;
}

/** 대기표 클레임. 발급 시각을 넣지 않아 같은 요청 ID의 재시도가 같은 문자열(같은 해시)을 받는다 */
export interface TicketClaims {
  e: string;
  a: string;
  d: string;
  /** 번호 */
  s: number;
  /** 세대 */
  g: number;
  /** 구간 */
  seg: number;
  /** 진입 요청 ID */
  rq: string;
  jny: string;
  vr?: ReasonCategory;
}

/** 회차 일정·정렬 설정 사본(q:{event:E}:cfg) */
export interface EventSchedule {
  opensAtMs: number;
  startsAtMs: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
}

/** 대기열 Redis를 잠시 쓸 수 없다(마감 초과·연결 끊김·클러스터 재구성·장애 전환 중). 받는 층이 503과 Retry-After로 답한다 */
export class QueueStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('대기열 Redis를 잠시 쓸 수 없다', { cause });
    this.name = 'QueueStoreUnavailable';
  }
}

/** 구간 번호: 구간 0이 1~1,000번(§4) */
export const segmentOf = (seq: number): number => Math.floor((seq - 1) / SEGMENT_SIZE);
export const saleEndOf = (s: EventSchedule): number => s.startsAtMs - SALE_END_BEFORE_START_MS;
/** 회차 단위 키의 만료 시각 */
export const keepUntilOf = (s: EventSchedule): number => saleEndOf(s) + KEEP_AFTER_SALE_END_MS;
