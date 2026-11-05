// 입장 확정 컨텍스트의 규칙 값(docs/features/queue-admission.md §6 '입장 확정의 첫 구현', docs/data.md §3, ADR-0005·0104·0183).

/** 차례가 온 뒤 입장 확정을 받는 시간 15분(POL-008) */
export const TURN_GRACE_MS = 15 * 60_000;
/** 입장 자리의 첫 사용 기한 5분(ADR-0005). 구매 세션 시작 사건이 오면 최대 체류 시각으로 올린다 */
export const FIRST_USE_MS = 5 * 60_000;
/** 최대 체류 시각 = 입장 + 45분(처음 값, POL-009). 입장 토큰 exp */
export const MAX_STAY_MS = 45 * 60_000;
/** 지금 목표(ctl targetNow)가 없을 때의 동시 입장 목표(리더의 처음 값과 같다, ADR-0182) */
export const DEFAULT_TARGET = 5_000;
/** SOON 다시 시도 1~5초 [가정](ADR-0104) */
export const SOON_RETRY_MIN_SEC = 1;
export const SOON_RETRY_MAX_SEC = 5;
/** NOT_YET 남은 시간 1~60초 [가정](ADR-0183) */
export const NOT_YET_MIN_MS = 1_000;
export const NOT_YET_MAX_MS = 60_000;
/** 입장 속도·serving 속도를 세는 창 10초 [가정](ADR-0183) */
export const RATE_WINDOW_SEC = 10;
/** 예상 대기 오차의 처음 예상 대기 상한(하루)과 그 시각이 이보다 앞서면 버림(이틀) */
export const ETA_MAX_SEC = 86_400;
export const ETA_MAX_AGE_MS = 2 * 24 * 3600_000;

/** 회차 슬롯 확인(읽기만)의 결과 */
export type Precheck =
  | { kind: 'SOLD_OUT' }
  | { kind: 'ENDED' }
  | { kind: 'VERIFYING'; reason?: string }
  | { kind: 'REMOVED' }
  | { kind: 'NOT_YET'; serving: number; retryAfterMs: number }
  | { kind: 'EXPIRED'; turnAtMs: number }
  /** 차례가 왔고 15분 안(또는 곧 입장 대기열에 있음). turnAtMs는 serving_log 칸(없으면 undefined), skipped는 건너뛴 구간 안의 옛 세대 번호 */
  | { kind: 'OK'; serving: number; turnAtMs?: number; inSoon: boolean; skipped: boolean };

/** 사람 슬롯 q:adm: 비어 채움(NEW), 같은 대기표(SAME), 다른 대기표(DUP) */
export type Claim = { kind: 'NEW' } | { kind: 'SAME' } | { kind: 'DUP' };

/** 회차 슬롯 입장 Lua의 결과 */
export type AdmitResult =
  /** again: 이 대기표의 살아 있는 자리를 같은 jti로 다시 준 것(입장 수·처음 요청을 다시 세지 않음). firstSlot: 이 대기표가 처음 잡은 자리(회수 뒤 다시 잡은 것이 아님).
   * serving은 Lua가 본 값 */
  /** issuedAtMs: 이 자리를 처음 잡은 시각(같은 jti를 다시 줄 때 입장 토큰의 만료를 첫 발급과 같게 한다. 모르면 없음) */
  | { kind: 'ADMITTED'; jti: string; again: boolean; firstSlot: boolean; serving: number; arrivalDelayMs?: number; soonWaitMs?: number; issuedAtMs?: number }
  | { kind: 'SOON'; retryAfterSeconds: number; arrivalDelayMs?: number }
  /** 확인 뒤 빠진 번호가 됐거나(REMOVED) serving이 모자라다(NOT_YET, 장애 전환으로 serving이 되돌아감). 확인과 입장 사이의 경합 */
  | { kind: 'REMOVED' }
  | { kind: 'NOT_YET' }
  /** 같은 jti를 다시 줄 자리지만 첫 발급 + 최대 체류가 지났다(다시 주지 않고 만료로 본다, HOT-010 리뷰) */
  | { kind: 'EXPIRED' };
