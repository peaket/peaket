// 보상 세 걸음의 값과 규칙(BAT-011, PRF-173, ADR-0354 결정 3·4, docs/features/payment.md §3 '보상 세 걸음의 첫 구현', specs/payment.qnt compStart·compFence·compCancel).
// 회차 취소가 확정됐는데 발권이 아직 끝나지 않은(APPROVED) 주문을 세 걸음으로 보상한다:
//   ① start — 발권 큐 행을 잠그고 지운 뒤 주문이 APPROVED인지 보고 order_compensation STARTED를 만든다(specs compStart).
//   ② fence — ticket-svc BlockTicketIssuance로 그 주문의 발권을 막고 이미 만든 티켓을 무효로 한다(specs compFence).
//   ③ cancel — payment-svc CancelPayment로 결제를 취소하고, 성공한 뒤에만 주문 T20(APPROVED → COMPENSATED)을 쓴다(specs compCancel).
// 보상 중은 주문 상태가 아니라 order_compensation의 STARTED·FENCED다. 주문은 결제 취소가 끝난 뒤 T20으로 한 번만 COMPENSATED가 되고,
// 그때 보상 행도 COMPENSATED가 된다(공개 Order.status에 COMPENSATING을 더하지 않는다).
// 프레임워크·저장소를 모른다(순수 값과 함수, 포트).
// 구현에서 정한 것(정본에 없다):
// - payment_id는 start가 받은 값(마지막 APPROVED 결제)을 쓴다. 그 값이 없는 조립(발권 대기 주문을 쓸어 담는 실행기)은 빈 값으로 시작하고,
//   payment-svc 어댑터가 GetPayment(주문 ID)로 결제 원장을 찾아 취소한다. 그마저 없으면 FAILED(NO_PAYMENT)다.
// - cancel의 다시 보내기 간격은 값이 [가정]이라 흔들기를 빼고 같은 값으로 둔다(시험이 단조 증가와 상한만 본다).
import type { OrderStatus } from './order.js';
import { uuid8 } from './order.js';
import { GRPC_STATUS_NAMES, type TicketIssueFailureCode } from './ticket-issue.js';

/** order_compensation.status. STARTED·FENCED가 보상 중(명세 COMPENSATING)이고 COMPENSATED·FAILED가 끝이다 */
export const COMPENSATION_STATUSES = ['STARTED', 'FENCED', 'COMPENSATED', 'FAILED'] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUSES)[number];

/** 아직 끝나지 않아 실행기가 집는 상태 */
export const COMPENSATION_OPEN_STATUSES: ReadonlySet<CompensationStatus> = new Set(['STARTED', 'FENCED']);

/** 다시 보내는 시도 상한 [가정](이만큼 쉬면 60초 상한에 닿는다. 그 뒤에도 같은 간격으로 이어 간다) */
export const COMPENSATION_MAX_ATTEMPTS = 8;

/** 회차 취소 보상의 사유(order_cancellation.reason과 ticket-svc BlockTicketIssuance.reason에 그대로 쓴다) */
export const COMPENSATION_REASON = 'EVENT_CANCELLED';
/** order_event.actor(ACTOR_PATTERN의 system:<작업 이름>). T20 이력에 쓴다 */
export const COMPENSATION_ACTOR = 'system:compensation';

/** 반복 간격 1초 [가정](API 파드마다 도는 실행기) */
export const COMPENSATION_POLL_INTERVAL_MS = 1000;
/** 한 번에 잡는 행 수 50건 [가정] */
export const COMPENSATION_CLAIM_LIMIT = 50;
/** 임대 30초 [가정](ticket_issue_job·order_saga_job과 같은 값) */
export const COMPENSATION_LEASE_MS = 30_000;
/** 한 회차 취소가 한 번에 큐에 넣는 보상 후보 수 100건 [가정](다음 틱이 나머지를 넣는다) */
export const COMPENSATION_CANDIDATE_BATCH = 100;

/** 다시 보내기 첫 간격 1초 [가정] */
export const COMPENSATION_RETRY_BASE_MS = 1000;
/** 다시 보내기 간격 배수 2배 [가정] */
export const COMPENSATION_RETRY_FACTOR = 2;
/** 다시 보내기 간격 상한 60초 [가정] */
export const COMPENSATION_RETRY_MAX_MS = 60_000;
/** 흔들기 폭 ±20% [가정](같은 때 실패한 행이 다시 몰리지 않게) */
export const COMPENSATION_JITTER_RATIO = 0.2;

/** 발권 막기 gRPC 데드라인 2초 [가정](architecture 시간 초과 표 '발권 gRPC'와 같은 값) */
export const COMPENSATION_FENCE_DEADLINE_MS = 2_000;
/** 결제 취소 gRPC 데드라인 5초 [가정](예매 취소 어댑터와 같은 값) */
export const COMPENSATION_CANCEL_DEADLINE_MS = 5_000;
/** 게이지를 재는 간격 10초 [가정](파드마다 같은 값이라 경보는 최댓값으로 본다) */
export const COMPENSATION_GAUGE_INTERVAL_MS = 10_000;

/**
 * 다시 보낼 실패 코드. gRPC 이름(OK 빼고)과 실행기·어댑터가 정한 이름이다.
 * CIRCUIT_OPEN(차단기 열림), CANCEL_PENDING·PENDING(결제사·payment-svc가 아직 처리 중), UNKNOWN(답을 가를 수 없음)
 */
export const COMPENSATION_RETRY_CODES: ReadonlySet<string> = new Set<string>([
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'ABORTED',
  'INTERNAL',
  'UNKNOWN',
  'CANCELLED',
  'CIRCUIT_OPEN',
  'CANCEL_PENDING',
  'PENDING',
]);

/**
 * 다시 보내지 않을 실패 코드. 다시 해도 같은 답이거나(INVALID_ARGUMENT·NOT_FOUND·PERMISSION_DENIED·UNAUTHENTICATED·
 * ALREADY_EXISTS·OUT_OF_RANGE·UNIMPLEMENTED·DATA_LOSS·FAILED_PRECONDITION·BAD_ANSWER), 업무 거절(REJECTED),
 * 가상계좌 환불 계좌가 없음(REFUND_ACCOUNT_REQUIRED), 결제 원장·결제 시도가 없음(NO_PAYMENT·NO_ATTEMPT),
 * 주문이 이미 COMPENSATED가 아님(ORDER_STALE)이다. FAILED로 끝내고 SEV2 로그·지표로 사람에게 넘긴다(CS 처리함은 PRF-175)
 */
export const COMPENSATION_FAILED_CODES: ReadonlySet<string> = new Set<string>([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'ALREADY_EXISTS',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'DATA_LOSS',
  'FAILED_PRECONDITION',
  'BAD_ANSWER',
  'REJECTED',
  'REFUND_ACCOUNT_REQUIRED',
  'NO_ATTEMPT',
  'NO_PAYMENT',
  'ORDER_STALE',
]);

/** 실패 코드 → 보상의 갈래. 묶음 밖의 값은 다시 보낸다(모르는 것을 영영 실패로 끝내지 않는다) */
export function compensationFailureKind(code: string): 'RETRY' | 'FAILED' {
  return COMPENSATION_FAILED_CODES.has(code) ? 'FAILED' : 'RETRY';
}

/** order_compensation 행 하나(저장소·유스케이스가 쓰는 값) */
export interface OrderCompensation {
  readonly orderId: string;
  readonly status: CompensationStatus;
  readonly reason: string;
  /** 그 주문의 마지막 APPROVED 결제 ID. 알게 된 뒤에 채운다 */
  readonly paymentId?: string;
  readonly startedAtMs: number;
  readonly fencedAtMs?: number;
  /** 결제 취소와 T20이 끝난 시각(status COMPENSATED) */
  readonly compensatedAtMs?: number;
  readonly attempts: number;
  readonly nextAttemptAtMs?: number;
  readonly leaseUntilMs?: number;
  readonly lastError?: string;
  readonly updatedAtMs: number;
}

/** start의 결과. NOT_APPROVED면 그 주문은 이미 발권됐거나 끝나 보상하지 않았다(큐 행도 그대로다) */
export type StartCompensationWriteResult = { readonly status: 'CREATED' } | { readonly status: 'EXISTS' } | { readonly status: 'NOT_APPROVED'; readonly current?: OrderStatus };

/** compensated(T20 + 행 끝내기)의 결과. STALE이면 주문이 APPROVED가 아니어서 되돌렸다 */
export type CompensationCompleteWriteResult = { readonly status: 'COMPENSATED' } | { readonly status: 'LEASE_LOST' } | { readonly status: 'STALE'; readonly current?: OrderStatus };

/**
 * 보상 상태 표의 저장소(BAT-011). 운영은 adapters/db/drizzle-compensation.ts, 시험은 대역이 구현한다.
 * 잠금 차례: start는 ticket_issue_job 행 → purchase_order 행, compensated는 order_compensation 행 → purchase_order 행이다
 */
export interface CompensationJobs {
  /** 그 회차에서 발권이 끝나지 않은(APPROVED) 주문이면서 ticket_issue_job 행이 있는 주문(오래된 큐 행 차례) */
  candidates(eventId: string, limit: number): Promise<readonly string[]>;
  /** 발권 큐 행을 잠그고 지운 뒤, 주문이 APPROVED일 때만 STARTED 행을 만든다. 주문 ID로 멱등하다 */
  start(input: { readonly orderId: string; readonly reason: string; readonly paymentId?: string; readonly nowMs: number }): Promise<StartCompensationWriteResult>;
  /** 기한이 된 STARTED·FENCED 행을 SKIP LOCKED로 잡아 임대를 쓰고 돌려준다(짧은 트랜잭션) */
  claimDue(limit: number, leaseMs: number, nowMs: number): Promise<readonly OrderCompensation[]>;
  /** 주문 하나의 보상 행(없으면 undefined) */
  get(orderId: string): Promise<OrderCompensation | undefined>;
  /** 발권 막기가 끝났다: FENCED·fenced_at. 임대를 주면 자기 임대 조건이다 */
  fenced(input: { readonly orderId: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean>;
  /** 결제 취소가 끝났다: 한 트랜잭션에서 주문 T20(APPROVED → COMPENSATED)과 행 COMPENSATED를 쓴다. 이미 COMPENSATED면 T20을 다시 쓰지 않는다 */
  compensated(input: { readonly orderId: string; readonly nowMs: number; readonly paymentId?: string; readonly leaseUntilMs?: number }): Promise<CompensationCompleteWriteResult>;
  /** 다시 보낸다: attempts + 1, last_error = code, next_attempt_at = nextAtMs, 임대를 놓는다 */
  retry(input: { readonly orderId: string; readonly code: string; readonly nextAtMs: number; readonly nowMs: number; readonly paymentId?: string; readonly leaseUntilMs?: number }): Promise<boolean>;
  /** 끝낸다: FAILED·last_error = code, next_attempt_at 빔, 임대를 놓는다 */
  failed(input: { readonly orderId: string; readonly code: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean>;
  /** 처리하지 않고 임대를 놓는다(다음 틱·다른 파드가 잡는다) */
  release(orderId: string, leaseUntilMs: number): Promise<boolean>;
  /** 게이지: 다시 보낼 행 수와 FAILED 행 수 */
  gauges(): Promise<{ readonly pending: number; readonly failed: number }>;
}

/** ticket-svc BlockTicketIssuance 어댑터(BAT-011 compFence). 실패는 TicketFenceCallError로 던진다 */
export interface TicketFencer {
  block(input: { readonly orderId: string; readonly reason: string; readonly deadlineMs: number }): Promise<{ readonly voided?: number; readonly alreadyEntered?: number; readonly already_entered?: number; readonly blocked?: true }>;
}

/** 발권 막기 호출의 실패. code는 COMPENSATION_RETRY_CODES·COMPENSATION_FAILED_CODES의 이름이다 */
export class TicketFenceCallError extends Error {
  constructor(
    readonly code: TicketIssueFailureCode | 'CIRCUIT_OPEN' | 'BAD_ANSWER',
    options?: { cause?: unknown },
  ) {
    super(`발권 막기 호출이 실패했다: ${code}`, options);
    this.name = 'TicketFenceCallError';
  }
}

/** payment-svc CancelPayment 어댑터(BAT-011 compCancel). paymentId가 비면 주문 ID로 결제 원장을 찾는다 */
export interface PaymentCompensator {
  cancel(input: { readonly orderId: string; readonly paymentId: string; readonly cancellationId: string; readonly reason: string; readonly deadlineMs: number }): Promise<CompensationPaymentAnswer>;
}

/** 결제 취소 답. payment.proto CancelResult의 접두어를 뗀 이름 또는 이 객체다(시험 대역은 PENDING도 준다) */
export type PaymentCancelAnswerName = 'CANCELLED' | 'CANCEL_PENDING' | 'PENDING' | 'UNKNOWN' | 'REJECTED' | 'REFUND_ACCOUNT_REQUIRED';

/** 결제 취소 답. CANCELED만 다음 걸음(주문 T20)으로 간다 */
export type CompensationPaymentAnswer =
  | { readonly kind: 'CANCELED'; readonly paymentId: string }
  | { readonly kind: 'RETRY'; readonly code: string; readonly paymentId?: string }
  | { readonly kind: 'FAILED'; readonly code: string; readonly paymentId?: string };

/** 보상 실행기·유스케이스의 로그(주문 ID·단계·코드만 싣는다) */
export interface CompensationLog {
  /** 영구 실패: SEV2 오류 한 줄 */
  failed(q: { readonly orderId: string; readonly stage: string; readonly code: string }): void;
  /** 발권을 막았는데 이미 입장한 티켓이 있었다: SEV1(사람이 확인한다) */
  entered(q: { readonly orderId: string; readonly alreadyEntered: number }): void;
  /** 늦게 왔거나 어긋난 답: 경고 한 줄 */
  stale(q: { readonly orderId: string; readonly stage: string; readonly current?: string }): void;
  /** 그 밖의 실행 오류(저장소 장애 등) */
  runError(q: { readonly stage: string; readonly orderId?: string; readonly err: unknown }): void;
}

/** 보상 지표: purchase_order_compensation_total{result}와 order_compensation_jobs{state} */
export interface CompensationSignals {
  result(result: 'started' | 'fenced' | 'compensated' | 'retry' | 'failed'): void;
  jobs(state: 'pending' | 'failed', count: number): void;
}

/** 아무것도 하지 않는 로그·지표(옛 조립·단위 시험). 유스케이스는 이것을 기본값으로 쓴다 */
export const noopCompensationLog: CompensationLog = { failed: () => undefined, entered: () => undefined, stale: () => undefined, runError: () => undefined };
export const noopCompensationSignals: CompensationSignals = { result: () => undefined, jobs: () => undefined };

/**
 * 보상의 결제 취소 ID. compensation:{주문 ID}의 UUID 버전 8(SHA-256의 앞 16바이트)이다(ADR-0354 결정 4).
 * 보상이 다시 돌아도 payment-svc가 같은 취소로 보므로 이중 취소가 나지 않는다
 */
export function compensationCancellationId(orderId: string): string {
  return uuid8(`compensation:${orderId}`);
}

/** 1 이상의 안전한 정수(시도 수)인지 보고 아니면 RangeError */
function assertAttempts(attempts: number): void {
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError(`보상 시도 수(attempts)는 1 이상의 안전한 정수다: ${String(attempts)}`);
}

/**
 * 흔들기 전 다시 보내기 간격(ms) = min(1초 × 2^(attempts − 1), 60초). ticket_issue_job과 같은 꼴이다.
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function compensationBackoffMs(attempts: number): number {
  assertAttempts(attempts);
  let ms = COMPENSATION_RETRY_BASE_MS;
  for (let i = 1; i < attempts; i += 1) {
    ms *= COMPENSATION_RETRY_FACTOR;
    if (ms >= COMPENSATION_RETRY_MAX_MS) return COMPENSATION_RETRY_MAX_MS;
  }
  return Math.min(ms, COMPENSATION_RETRY_MAX_MS);
}

/**
 * 흔들기를 곱한 다시 보내기 간격(ms) = compensationBackoffMs(attempts) × (0.8 ~ 1.2)를 정수로 내린 값.
 * @param unit [0, 1)의 난수(없으면 0.5라 흔들기가 없다)
 * @throws RangeError attempts·unit이 범위 밖
 */
export function compensationRetryDelayMs(attempts: number, unit = 0.5): number {
  const base = compensationBackoffMs(attempts);
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit < 0 || unit >= 1) throw new RangeError(`흔들기 난수(unit)는 [0, 1)의 수다: ${String(unit)}`);
  return Math.floor(base * (1 - COMPENSATION_JITTER_RATIO + 2 * COMPENSATION_JITTER_RATIO * unit));
}

/** gRPC 상태 번호 → 실패 코드 이름(모르는 번호는 UNKNOWN). 어댑터가 쓴다 */
export function compensationGrpcCodeOf(grpcCode: number): string {
  if (!Number.isInteger(grpcCode) || grpcCode < 1 || grpcCode >= GRPC_STATUS_NAMES.length) return 'UNKNOWN';
  return GRPC_STATUS_NAMES[grpcCode]!;
}
