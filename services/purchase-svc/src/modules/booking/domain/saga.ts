// 주문 Saga 1단계의 값과 규칙(docs/features/payment.md §2 'Saga 1단계의 첫 구현', docs/data.md §5 'Saga 1단계', BUILD_ORDER PRF-165).
// 결제 접수(PRF-162)가 넣은 order_saga_job 행을 실행기가 돈다: RESERVE(좌석 묶기 → 판 번호 대조 → 판매 예약 → T7) → CONFIRM(승인 명령 → 결제 참조·작업 지우기).
// 실패면 T8(ACCEPTED → FAILED)·T11(RESERVED → FAILED)과 실패 해제다. 프레임워크·저장소를 모른다(순수 값과 함수).
// 2026-11-05 리뷰 고침: 승인 명령을 한 번이라도 보냈으면 혼자 T11을 하지 않는다(H1), 실패 해제가 끝날 때까지 작업 행을 RELEASE로 남긴다(M4).
import type { OrderStatus } from './order.js';

/**
 * 작업 단계(order_saga_job.step의 CHECK 값, 0006). 이 차례로 지난다.
 * RELEASE: 실패 기록(T8·T11) 뒤 좌석 Redis 실패 해제가 끝날 때까지 남는 단계(실패 기록 트랜잭션이 바꾸고, 해제가 끝나면 실행기가 작업 행을 지운다, 2026-11-05 리뷰 M4)
 */
export const SAGA_STEPS = ['RESERVE', 'CONFIRM', 'RELEASE'] as const;
export type SagaStep = (typeof SAGA_STEPS)[number];

/**
 * Saga 1단계의 실패 사유(purchase_order.failure_reason, FAILED일 때만, 0006). 결제 쪽 사유는 PRF-163이 더한다.
 * - SEAT_TAKEN: 묶기 TAKEN, 또는 판매 예약이 SEAT_TAKEN(남이 그 좌석을 가졌다)
 * - QUOTA_EXCEEDED: 묶기·판매 예약이 1인 한도를 넘음
 * - STALE_GEN: 묶기 STALE_GEN(빈 좌석이 있는데 주문의 판 번호가 지금 판 번호와 다름. 다시 만든 뒤의 빈 좌석은 잃어버린 남의 홀드일 수 있다)
 * - EXPIRED: 승인 기한(인증 + 10분)을 넘김(RESERVE는 묶기 전에, CONFIRM은 승인 명령을 한 번도 보내지 못한 채. 보냈으면 T11을 하지 않는다, 리뷰 H1)
 * - STORE_GONE: 회차 키 수명(판매 종료 + 1일)이 지나 묶기가 늘 NOT_READY다
 */
export const SAGA_FAILURE_REASONS = ['SEAT_TAKEN', 'QUOTA_EXCEEDED', 'STALE_GEN', 'EXPIRED', 'STORE_GONE'] as const;
export type SagaFailureReason = (typeof SAGA_FAILURE_REASONS)[number];

/** 실패 전이: T8(ACCEPTED → FAILED, 판매 예약 전), T11(RESERVED → FAILED, 판매 예약 뒤. 판매 행 PENDING을 지운다) */
export type SagaFailTransition = 'T8' | 'T11';

/** 폴링 간격 1초 [가정](모든 API 파드가 기한이 된 작업을 줍는다) */
export const SAGA_POLL_INTERVAL_MS = 1000;
/** 한 번에 집는 작업 수 50건 [가정] */
export const SAGA_CLAIM_LIMIT = 50;
/** 임대 30초 [가정](lease_until = 지금 + 이 값. 끝나기 전에는 다른 파드가 집지 않는다) */
export const SAGA_LEASE_MS = 30_000;
/** 다시 하기 첫 간격 1초 [가정] */
export const SAGA_RETRY_BASE_MS = 1000;
/** 다시 하기 간격 상한 10초 [가정] */
export const SAGA_RETRY_MAX_MS = 10_000;
/** 승인 기한 = 결제창 인증(authenticated_at) + 10분(payment §2, ADR-0107) */
export const CONFIRM_WINDOW_MS = 10 * 60_000;
/** 승인 명령 gRPC 데드라인 200ms [가정](architecture 시간 초과 표 '승인 명령 gRPC') */
export const CONFIRM_CALL_DEADLINE_MS = 200;
/** 회차 키 수명 = 판매 종료 + 1일(inventory KEEP_AFTER_SALE_END_MS와 같은 값. booking은 inventory 층을 가져오지 않아 다시 적는다) */
export const SEAT_KEYS_KEEP_AFTER_SALE_END_MS = 24 * 3600_000;
/** 판 번호가 바뀌어(GEN_CHANGED) 같은 실행 안에서 묶기부터 다시 하는 횟수 상한 3번 [가정]. 넘으면 다시 하기로 미룬다 */
export const SAGA_GEN_RESTART_MAX = 3;
/** 승인 명령이 정해진 거절(REJECTED)이면 작업을 멈추는 길이 1시간 [가정](next_attempt_at을 이만큼 미룬다. 결과 당기기 PRF-171이 맞춘다, 리뷰 H1) */
export const SAGA_CONFIRM_PARK_MS = 60 * 60_000;
/** 다음 작업을 시작하기 전에 남아 있어야 하는 임대 5초 [가정](모자라면 그 작업을 놓고 다음 틱으로 넘긴다, 리뷰 낮음) */
export const SAGA_LEASE_MIN_REMAINING_MS = 5_000;
/** Saga 트랜잭션 하나의 문장 시간 한도 5초 [가정](요청 밖이라 요청의 남은 시간이 없다, 리뷰 낮음) */
export const SAGA_STATEMENT_TIMEOUT_MS = 5_000;

/** 그 단계 전(또는 그 단계)의 주문 상태. 이 밖이면 주문이 그 단계를 지난 것이다 */
const NOT_PASSED: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED']);

/**
 * 주문이 작업 단계 step을 지났나(리뷰 M3): 지났으면 그 작업 행과 결제 참조를 지워도 된다.
 * RESERVE·CONFIRM: 주문이 RESERVED까지의 상태가 아니면 지났다(RESERVE 작업인데 RESERVED인 주문은 손질이 필요해 지난 것으로 보지 않는다).
 * RELEASE: 실패 해제는 주문 상태와 상관없이 끝까지 하므로 지난 것으로 보지 않는다
 */
export function sagaStepPassed(step: SagaStep, status: OrderStatus): boolean {
  if (step === 'RELEASE') return false;
  return !NOT_PASSED.has(status);
}

/**
 * 다시 하기 간격(ms): 1초에서 두 배씩, 최대 10초 [가정].
 * @param attempts 이 단계를 이미 해 본 횟수(1 이상의 정수. 1 → 1초, 2 → 2초, 3 → 4초, 4 → 8초, 5 이상 → 10초)
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function sagaRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError(`다시 하기 횟수는 1 이상의 안전한 정수여야 한다: ${String(attempts)}`);
  // 2^(attempts − 1)초. 상한(10초)을 넘는 횟수는 거듭제곱을 하지 않는다(아주 큰 횟수에서 Infinity가 되지 않게)
  const doublings = attempts - 1;
  if (doublings >= 4) return SAGA_RETRY_MAX_MS;
  return Math.min(SAGA_RETRY_MAX_MS, SAGA_RETRY_BASE_MS * 2 ** doublings);
}

/** 승인 기한 시각(epoch ms) = 인증 시각 + CONFIRM_WINDOW_MS */
export function confirmDeadlineAtMs(authenticatedAtMs: number): number {
  return authenticatedAtMs + CONFIRM_WINDOW_MS;
}

/**
 * 승인 기한을 넘겼나: nowMs ≥ 인증 시각 + 10분이면 참(경계 시각은 넘긴 것으로 본다. 결제 시도 40분 판정(accept-payment.ts)과 같은 쪽).
 * 인증 시각이 없으면(접수 전 행, 코드 오류) 참으로 본다(승인을 보내지 않는 쪽이 안전하다)
 */
export function isPastConfirmDeadline(authenticatedAtMs: number | undefined, nowMs: number): boolean {
  if (authenticatedAtMs === undefined) return true;
  return nowMs >= confirmDeadlineAtMs(authenticatedAtMs);
}

/** 회차 키가 수명으로 지워졌나: nowMs ≥ 판매 종료 + 1일(이때의 NOT_READY는 STORE_GONE, 실패 해제의 NOT_READY는 해제가 끝난 것) */
export function isSeatStoreGone(saleEndsAtMs: number, nowMs: number): boolean {
  return nowMs >= saleEndsAtMs + SEAT_KEYS_KEEP_AFTER_SALE_END_MS;
}

/** 다시 하는 까닭(지표·로그 이름표) */
export type SagaRetryReason =
  /** 묶기·실패 해제가 NOT_READY(세대 키 없음, 회차 키 수명 전) */
  | 'not_ready'
  /** 좌석 Redis 일시 장애 */
  | 'seat_store_unavailable'
  /** 판 번호가 같은 실행 안에서 SAGA_GEN_RESTART_MAX번 넘게 바뀜 */
  | 'gen_changed'
  /** 승인 명령이 데드라인 초과·UNAVAILABLE·차단기 열림(기한 안) */
  | 'confirm_retryable'
  /** 승인 명령이 정해진 거절(그 밖의 gRPC 오류·모르는 답)이라 SEV2 로그 뒤 작업을 SAGA_CONFIRM_PARK_MS 멈춤(리뷰 H1) */
  | 'confirm_rejected'
  /** 실패 해제가 좌석 Redis 장애·회차 키 수명 안의 NOT_READY로 끝나지 못함(작업 행은 RELEASE로 남는다, 리뷰 M4) */
  | 'release_failed'
  /** purchase DB 오류·예상 밖 예외 */
  | 'error';

/**
 * 단계 하나를 돈 결과(실행기 안의 값. 저장소에 쓰는 일은 끝났다).
 * - ADVANCED: RESERVE를 마쳐 작업이 CONFIRM이 됐다(T7 커밋). 실행기는 같은 실행에서 CONFIRM을 이어 돈다
 * - DONE: 승인 명령이 접수돼 결제 참조와 작업 행을 지웠다(결과는 trade.payments로 받는다, PRF-163)
 * - FAILED: T8·T11로 끝냈다(과금 없음). 실패 해제를 했거나 시도했다(끝나지 못했으면 작업 행이 RELEASE로 남아 다시 한다)
 * - RELEASED: RELEASE 작업의 실패 해제를 마치고 작업 행을 지웠다
 * - RETRY: 다시 하기로 미뤘다(next_attempt_at = 지금 + sagaRetryDelayMs 또는 SAGA_CONFIRM_PARK_MS, attempts + 1)
 * - SKIPPED: 할 것이 없다(작업 행 없음·임대를 못 잡거나 잃음·주문이 단계의 출발 상태가 아님·이미 실패 해제한 홀드)
 */
export type SagaStepOutcome =
  | { readonly kind: 'ADVANCED'; readonly next: 'CONFIRM' }
  | { readonly kind: 'DONE' }
  | { readonly kind: 'RELEASED' }
  | { readonly kind: 'FAILED'; readonly transition: SagaFailTransition; readonly reason: SagaFailureReason }
  | { readonly kind: 'RETRY'; readonly reason: SagaRetryReason; readonly nextAtMs: number }
  | { readonly kind: 'SKIPPED'; readonly reason: 'NO_JOB' | 'LEASED' | 'ORDER_STATE' | 'FAILED_HOLD' };
