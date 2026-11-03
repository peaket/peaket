// 대기열 v0의 규칙 값과 사람 하나의 대기 상태(docs/features/queue-admission.md §13).

/** 차례가 온 뒤 입장을 기다려 주는 시간(POL-008, 15분). 정확히 15분까지는 유효하고 넘으면 만료다 */
export const ADMISSION_GRACE_MS = 15 * 60 * 1000;

/** 회차 ID 형식: 영숫자·-·_ 1~64자(Redis 해시 태그를 깨는 문자를 막는다) */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 입장 루프에 넘기는 시각(유닉스 밀리초)의 범위: 0 ~ 9999-12-31T23:59:59.999Z. 마이크로초·NaN을 막는다 */
export const MAX_EPOCH_MS = 253_402_300_799_999;

/** 시각이 유닉스 밀리초 정수인지 */
export function isEpochMs(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_EPOCH_MS;
}

/** 1초에 부를 사람 수의 범위 */
export const ADMIT_PER_SECOND_MIN = 1;
export const ADMIT_PER_SECOND_MAX = 100_000;

/** 회차 설정(모듈 공개 함수로만 연다) */
export interface QueueConfig {
  admitPerSecond: number;
  /** 판매 종료(유닉스 밀리초). 없으면 끝나지 않는다 */
  saleEndsAtMs?: number;
}

/** 회차 전체 값(대기 상태 조회 때 함께 읽는다) */
export interface QueueSnapshot {
  serving: number;
  servingRate: number;
  saleEndsAtMs?: number;
}

/** 저장소가 본 사람 하나의 자리 */
export type PersonPlace =
  | { kind: 'waiting'; seq: number; ahead: number }
  | { kind: 'called'; seq: number; calledAtMs: number }
  | { kind: 'admitted'; seq: number; admittedAtMs: number }
  | { kind: 'none' };

export type EnterResult =
  | { kind: 'entered'; seq: number }
  | { kind: 'already-in-queue' }
  | { kind: 'already-admitted' }
  | { kind: 'sale-ended' }
  | { kind: 'queue-not-found' };

export type AdmitResult =
  | { kind: 'admitted'; seq: number }
  | { kind: 'not-yet'; seq: number }
  | { kind: 'expired'; seq: number }
  | { kind: 'sale-ended' }
  | { kind: 'not-in-queue' }
  | { kind: 'queue-not-found' };

/** 입장 루프 1초 칸 하나의 결과 */
export interface TickResult {
  eventId: string;
  /** 이 호출이 그 1초 칸을 맡았는지(다른 복제본이 이미 했거나 판매 종료면 false) */
  ticked: boolean;
  /** 이번 칸에 부른 사람 수 */
  called: number;
  /** 지금 serving */
  serving: number;
}

/** serving_log 한 줄(시험 기록 queue_serving의 원천) */
export interface ServingLogEntry {
  serving: number;
  called: number;
  atMs: number;
}
