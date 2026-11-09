// 결제하지 않은 주문의 만료 규칙(ADR-0107 결정 1·2, docs/features/payment.md §3 T5·T6, docs/data.md §5.1 '주문 만료 안전망', BUILD_ORDER PRF-172 설계 1~5).
// DB·Redis를 모르는 상수와 판정 함수만 둔다. 세 조건을 모아 오는 쪽은 application/order-expiry.ts와 adapters/db/drizzle-order-expiry.ts다.
import type { OrderStatus } from './order.js';

/**
 * READY 결제 시도의 유효 시간 40분 [가정](결제창 인증 유효 30분 + 승인 기한 10분, ADR-0107 결정 1).
 * 결제 접수의 ATTEMPT_ACCEPT_WINDOW_MS(application/accept-payment.ts)와 같은 값이다(도메인은 유스케이스 층을 가져오지 않아 따로 둔다).
 * 만든 지 이 시간 이상 지나면 활성이 아니다(접수의 경계 'nowMs - createdAtMs >= 40분이면 지남'과 같다)
 */
export const ORDER_EXPIRY_ATTEMPT_TTL_MS = 40 * 60_000;
/** 안전망이 끝낼 주문의 나이 90분 [가정](최대 체류 45분 + 결제 시도 40분 + 여유 5분, ADR-0107 결정 2) */
export const ORDER_EXPIRY_SWEEP_AGE_MS = 90 * 60_000;
/** 안전망 반복의 틱 간격 10분 [가정](ADR-0107 결정 2) */
export const ORDER_EXPIRY_SWEEP_INTERVAL_MS = 10 * 60_000;
/** 안전망이 읽는 범위: 만든 지 하루 안(기본 키 UUIDv7 범위, 새 인덱스 없음. docs/data.md §5.1) */
export const ORDER_EXPIRY_LOOKBACK_MS = 24 * 60 * 60_000;
/** 안전망 묶음 하나의 행 수 500건(docs/data.md §5.1). READY 결제 시도 만료 묶음도 같다 */
export const ORDER_EXPIRY_BATCH = 500;
/** 하루 넘은 주문 정비 일이 보는 범위의 끝: 만든 지 30일 [가정](docs/features/payment.md §2 안전망 ③. 회차 키 수명이 끝나 조건이 끝났으므로 그 전에 끝난다) */
export const ORDER_EXPIRY_STALE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** 하루 넘은 주문 정비 일의 묶음 하나의 행 수 1,000건(docs/features/payment.md §2 안전망 ③) */
export const ORDER_EXPIRY_STALE_BATCH = 1_000;
/** 안전망 반복이 리더가 아닐 때 다시 보는 간격 5초 [가정](구현에서 정한 것: 프로세스가 켜진 뒤 Lease를 잡을 때까지 10분을 자지 않게, 2026-11-09 코드 리뷰) */
export const ORDER_EXPIRY_NOT_LEADER_RECHECK_MS = 5_000;
/** 사건 고리(세션 종료·홀드 만료)의 파드마다 동시 처리 수 4개 [가정](BUILD_ORDER PRF-172 설계 2) */
export const ORDER_EXPIRY_CONCURRENCY = 4;
/**
 * 사건 고리의 파드마다 대기 줄 상한 10,000건 [가정](구현에서 정한 것: 정본에 없다).
 * 동시 4개·판정 한 건 수십 ms면 줄을 비우는 데 1분 남짓이고, 그보다 많이 몰리면 새 일을 버린다(안전망이 10분 [가정]마다 받친다. 메모리가 끝없이 늘지 않게).
 * 한 건은 '구매 세션 종료 하나', '홀드 만료 고리 한 번', '주문 판정 하나' 가운데 하나다
 */
export const ORDER_EXPIRY_QUEUE_LIMIT = 10_000;
/** 사건 고리 실패 경고의 최소 간격: 파드마다 1분에 한 줄 [가정](구현에서 정한 것. 지표는 건마다 오른다, 2026-11-09 코드 리뷰) */
export const ORDER_EXPIRY_HOOK_WARN_INTERVAL_MS = 60_000;
/** 만료 전이(T5·T6)의 행위자(order_event.actor, ACTOR_PATTERN의 system:<작업 이름>) */
export const ORDER_EXPIRY_ACTOR = 'system:order-expiry';

/** 만료를 부른 까닭(지표 purchase_order_expired_total의 이름표, 설계 5) */
export const ORDER_EXPIRY_TRIGGERS = ['session', 'hold', 'attempt', 'sweep'] as const;
export type OrderExpiryTrigger = (typeof ORDER_EXPIRY_TRIGGERS)[number];

/** 실패한 단계(지표 purchase_order_expiry_failures_total의 이름표, docs/features/payment.md §2): hook(사건 고리)·check(만료 판정)·attempt(READY 결제 시도 만료 묶음)·sweep(주문 안전망 묶음·하루 넘은 주문의 묶음 읽기) */
export const ORDER_EXPIRY_STAGES = ['hook', 'check', 'attempt', 'sweep'] as const;
export type OrderExpiryStage = (typeof ORDER_EXPIRY_STAGES)[number];

/** 만료 전이: T5(CREATED → EXPIRED)·T6(AUTHENTICATED → EXPIRED) */
export type OrderExpiryTransition = 'T5' | 'T6';
/** 아직 끝나지 않은 조건: SESSION(구매 세션)·HOLD(그 주문의 홀드)·ATTEMPT(활성 결제 시도) */
export type OrderExpiryNotYetReason = 'SESSION' | 'HOLD' | 'ATTEMPT';

/** 판정에 넣는 값(주문 행을 잠근 뒤의 상태·결제 시도와, 트랜잭션을 열기 전에 읽은 세션·홀드) */
export interface OrderExpiryView {
  readonly status: OrderStatus;
  /** 구매 세션이 끝났나(세션 상태가 없거나 최대 체류가 지남) */
  readonly sessionEnded: boolean;
  /** 그 주문의 홀드가 아직 남았나 */
  readonly holdRemains: boolean;
  /** 활성 결제 시도가 있나(status READY이고 만든 지 ORDER_EXPIRY_ATTEMPT_TTL_MS 안) */
  readonly activeAttempt: boolean;
}

/** 판정 결과 */
export type OrderExpiryDecision =
  | { readonly kind: 'EXPIRE'; readonly transition: OrderExpiryTransition }
  | { readonly kind: 'NOT_YET'; readonly reason: OrderExpiryNotYetReason }
  | { readonly kind: 'NOT_OPEN' };

/**
 * 주문을 지금 만료로 끝낼 수 있는지 정한다(순수 함수, ADR-0107 결정 1).
 * CREATED·AUTHENTICATED가 아니면 NOT_OPEN(ACCEPTED부터는 만료 대상이 아니다). 열린 주문이면 세션 → 홀드 → 결제 시도 차례로 보고 처음 걸린 조건을 NOT_YET으로 돌려준다.
 * 셋 다 끝났으면 CREATED는 T5, AUTHENTICATED는 T6이다
 */
export function expiryDecision(view: OrderExpiryView): OrderExpiryDecision {
  if (view.status !== 'CREATED' && view.status !== 'AUTHENTICATED') return { kind: 'NOT_OPEN' };
  if (!view.sessionEnded) return { kind: 'NOT_YET', reason: 'SESSION' };
  if (view.holdRemains) return { kind: 'NOT_YET', reason: 'HOLD' };
  if (view.activeAttempt) return { kind: 'NOT_YET', reason: 'ATTEMPT' };
  return { kind: 'EXPIRE', transition: view.status === 'CREATED' ? 'T5' : 'T6' };
}
