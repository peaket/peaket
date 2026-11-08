// 진입 컨텍스트의 규칙 값과 토큰 클레임(docs/features/queue-admission.md §3 '첫 구현의 세부', docs/data.md §3).

/** 사전 검증 토큰 수명(15분) */
export const PREVERIFY_TTL_MS = 15 * 60_000;
/** 진입 선점 값 PENDING:{요청 ID}의 수명 10초 [가정](기술 검토 중간-035) */
export const PENDING_TTL_MS = 10_000;
/** 대기 상태 파일 구간의 크기(§4) */
export const SEGMENT_SIZE = 1_000;
/** 오픈 직후 동시 도착 구간 N 2초 [가정](ADR-0041). 회차 일정 사본의 batchWindowMs로 바꿀 수 있다 */
export const OPEN_BATCH_MS = 2_000;
/** 진입 ② 파드별 묶음: 첫 요청부터 모으는 시간과 한 묶음의 최대 건수 [가정](ADR-0179) */
export const NUMBER_BATCH_WINDOW_MS = 2;
export const NUMBER_BATCH_MAX = 500;
/** 장애 전환 뒤 RB-05가 건너뛰는 양의 바탕 값(ADR-0181 결정 4): ⌈회차 하나의 진입 상한 초당 20만 건 [가정, NFR-001] × 복제 지연 p99.9 0.3초 [가정] × 2⌉ */
export const RB05_RATE_MAX_PER_SEC = 200_000;
export const REPLICATION_LAG_P999_MS = 300;
export const RB05_SKIP_BASE = Math.ceil((RB05_RATE_MAX_PER_SEC * REPLICATION_LAG_P999_MS * 2) / 1000);
/** RB-05 복제 확인의 WAIT 한도 [가정](ADR-0186). 붙은 복제본이 이 안에 받지 못하면 다음 RB-05 호출(진입 503의 다시 시도, 리더 1초)이 다시 확인한다 */
export const RB05_CONFIRM_WAIT_MS = 500;
/** RB-05 전 진입의 503 queue-recovering Retry-After(초) [가정] */
export const RECOVERING_RETRY_SEC = 1;
/** 한 회차의 묶음 번호(오픈 직후 하나) */
export const BATCH_NO = 1;
/** 묶음 결과 공개 예정: 구간 끝 + 11초 [가정](비콘 대기 최대 6초 + 게시 5초. drand 일정은 BUILD_ORDER HOT-040) */
export const BATCH_RESULT_DELAY_MS = 11_000;
/** 결과 받기 분산 창(초, ADR-0058) */
export const BATCH_SPREAD_SEC = 8;
/** 묶음 결과 키를 잃어 다시 쓰기를 청한 진입의 Retry-After [가정] */
export const BATCH_REPAIR_RETRY_SEC = 2;
/** 결과 파일을 고르는 토큰 해시 앞자리 수(16진, 파일 4,096개 [가정]) */
export const RESULT_PREFIX_LEN = 3;
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
  /** 오픈 직후 묶음 구간 길이(밀리초, 없으면 OPEN_BATCH_MS) */
  batchWindowMs?: number;
  /** 그 회차의 지금 좌석맵 판 번호(게시한 판, 1 ~ 2^32 − 1). 대기 상태 파일의 seatmapLayoutPath를 만든다. 없으면 그 칸을 뺀다(HOT-011, ADR-0219 결정 7) */
  layoutVersion?: number;
}

/** 그 회차 좌석맵 파일의 경로(docs/frontend.md §4.2.2, 대기 상태 파일과 입장 확정 응답이 같은 값을 쓴다). 판 번호가 없으면 없다 */
export const seatmapLayoutPathOf = (eventId: string, schedule: Pick<EventSchedule, 'layoutVersion'>): string | undefined =>
  schedule.layoutVersion !== undefined ? `/v1/events/${encodeURIComponent(eventId)}/seatmap-layouts/${schedule.layoutVersion}.json` : undefined;

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
/** 묶음 구간 끝 */
export const batchCloseAtOf = (s: EventSchedule): number => s.opensAtMs + (s.batchWindowMs ?? OPEN_BATCH_MS);
/** 회차 단위 키의 만료 시각 */
export const keepUntilOf = (s: EventSchedule): number => saleEndOf(s) + KEEP_AFTER_SALE_END_MS;

/** 전체 범위 제어 상태의 회차 자리(q:{event:PLATFORM}:notice, docs/data.md §3) */
export const PLATFORM_SCOPE = 'PLATFORM';
