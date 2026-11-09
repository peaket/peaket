// 결제 결과 long polling의 업무 규칙(openapi GET /v1/orders/{orderId}/payment-status, docs/features/payment.md §2 '결제 결과 long polling의 첫 구현',
// BUILD_ORDER PRF-166). 결제창에서 돌아온 탭이 "결제가 어떻게 됐나"를 묻고, 서버는 결과가 정해졌으면 바로, 아니면 정해질 때까지 잠시 붙잡고 있다가 답한다.
// 여기에는 네 가지만 둔다: 주문 상태 → 응답 결정(바로 답함·기다림·거절), issueDelayed(발권이 늦어지는 중) 판정,
// 기다리던 요청을 깨울지(기다림 시작 때 본문과 견줌), 기다릴 시간 계산.
// 리뷰 고침(2026-11-05): APPROVED는 issueDelayed가 참이어도 기다리는 상태다(바로 답하면 화면의 0.5~1.5초 재요청이 짧은 폴링이 된다).
// 이 층은 바깥(DB·HTTP·플랫폼)을 모른다(architecture §3.1).
import type { OrderStatus } from './order.js';
import type { PaymentPg } from './ports.js';

/** 서버가 붙잡고 기다리는 최대 시간 25초 [가정](openapi 설명, payment §2 '기다리는 상태') */
export const PAYMENT_STATUS_WAIT_MAX_MS = 25_000;
/** 기다림을 요청 남은 시간보다 이만큼 먼저 끝낸다(답을 만들어 보낼 몫 1초, payment §2 '기다리는 상태') */
export const PAYMENT_STATUS_ANSWER_MARGIN_MS = 1_000;
/**
 * 이 경로만의 서비스 남은 시간 상한 27초 [가정](게이트웨이 gw-fan 경로 시간 초과와 같다, architecture 시간 초과 표 'long polling' 행).
 * 다른 경로는 플랫폼 기본 15초(DEFAULT_MAX_DEADLINE_MS) 그대로다. 처리기에 플랫폼 RouteDeadline으로 단다
 */
export const PAYMENT_STATUS_MAX_DEADLINE_MS = 27_000;
/**
 * 발권 재시도 큐 행을 만든 때(created_at = purchase가 승인을 반영한 시각)부터 이 시간이 지나면 issueDelayed가 참이다 60초 [가정].
 * trade.orders ISSUE_DELAYED를 내는 기준과 같다(발권 실행기 TICKET_ISSUE_DELAYED_AFTER_MS가 이 값을 쓴다, BUILD_ORDER PRF-170)
 */
export const ISSUE_DELAYED_AFTER_MS = 60_000;
/** 파드 안 기다림 표의 묶음 조회 간격 200ms [가정](payment §2 '알림 길') */
export const PAYMENT_STATUS_POLL_INTERVAL_MS = 200;
/** 묶음 조회 한 번에 읽는 주문 수 상한 500건 [가정](payment §2 '알림 길', verification §4.1 long polling 행) */
export const PAYMENT_STATUS_BATCH_MAX = 500;
/** 파드 하나가 함께 붙잡는 기다림 수 상한 2,000건 [가정]. 넘으면 기다리지 않고 지금 상태로 200(429보다 오류 소음이 적다) */
export const PAYMENT_STATUS_WAITERS_MAX = 2_000;
/** 기다린 지 이만큼 넘은 주문은 묶음 조회를 느린 간격으로 줄인다 5초 [가정] */
export const PAYMENT_STATUS_SLOW_AFTER_MS = 5_000;
/** 오래 기다린 주문의 묶음 조회 간격 1초 [가정] */
export const PAYMENT_STATUS_SLOW_POLL_INTERVAL_MS = 1_000;

/** 입금 대기 응답의 은행·계좌번호·입금 기한을 읽는 GetPayment 데드라인 300ms [가정](docs/verification.md §4.1, BUILD_ORDER HOT-151) */
export const PAYMENT_DEPOSIT_READ_DEADLINE_MS = 300;

/** 입금 안내 읽기의 일시 실패(시간 초과·차단기·UNAVAILABLE·과부하). 다음 상태 요청이 다시 읽으면 될 수 있다(BUILD_ORDER HOT-151, 코드 리뷰) */
export const PAYMENT_DEPOSIT_READ_TRANSIENT = 'TRANSIENT';
/** 입금 안내 읽기의 결과: 안내, 없음(입금 대기가 아니거나 답할 안내가 없다), 일시 실패 */
export type PaymentDepositRead = PaymentStatusVirtualAccount | undefined | typeof PAYMENT_DEPOSIT_READ_TRANSIENT;

/** 응답 status 값(openapi PaymentStatus.status의 여덟 값과 같은 차례) */
export const PAYMENT_STATUS_VALUES = ['ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'CONFIRMED', 'FAILED', 'UNKNOWN', 'COMPENSATED'] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUS_VALUES)[number];

/** 바로 답하는 상태(payment §2 '바로 답하는 상태'). 환불 둘은 CONFIRMED로 답한다 */
export const PAYMENT_STATUS_IMMEDIATE: ReadonlySet<OrderStatus> = new Set(['CONFIRMED', 'FAILED', 'AWAITING_DEPOSIT', 'UNKNOWN', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
/** 기다리는 상태(payment §2 '기다리는 상태'). APPROVED는 issueDelayed가 참이어도 기다린다(리뷰 고침 M2) */
export const PAYMENT_STATUS_WAITING: ReadonlySet<OrderStatus> = new Set(['ACCEPTED', 'RESERVED', 'APPROVED']);

/** 가상계좌 안내(openapi PaymentStatus.virtualAccount). payment-svc GetPayment에서 읽어 응답에만 싣는다(BUILD_ORDER HOT-151) */
export interface PaymentStatusVirtualAccount {
  readonly bank?: string;
  readonly accountNumber?: string;
  /** 입금 기한(ISO 8601, 시간대 포함) */
  readonly dueAt?: string;
}

/**
 * 200 본문(openapi PaymentStatus). 값이 없는 칸은 싣지 않는다.
 * [정함] issueDelayed는 늘 싣는다(APPROVED이면서 늦어지는 중일 때만 true, 그 밖은 false). pg는 접수한 결제 시도가 있을 때만 싣는다
 */
export interface PaymentStatusBody {
  /** 환불 상태(PARTIALLY_REFUNDED·REFUNDED)는 CONFIRMED로 답한다 */
  readonly status: PaymentStatusValue;
  /** FAILED일 때만: 주문 failure_reason 값 그대로(결제 쪽 사유·Saga 사유. 화면 문구는 소비자 웹이 고른다). 비었으면 싣지 않는다 */
  readonly reason?: string;
  readonly issueDelayed: boolean;
  /** 결제 접수에서 고정된 결제사(ACCEPTED 결제 시도의 pg) */
  readonly pg?: PaymentPg;
  /** 입금 대기이고 읽었을 때만 싣는다. 쓰임새가 응답을 만들 때 붙인다 */
  readonly virtualAccount?: PaymentStatusVirtualAccount;
}

/**
 * long polling이 보는 주문 모습(주문 행 + ACCEPTED 결제 시도의 결제사 + 발권 재시도 큐 행의 created_at·attempts·last_error, 기본 키로 한 질의).
 * 운영은 adapters/db/drizzle-payment-status.ts가 읽는다(PaymentStatusReads.read·readMany)
 */
export interface PaymentStatusView {
  readonly orderId: string;
  /** 주문 계정(purchase_order.account_id). 요청 계정과 다르면 없는 주문과 같은 404다 */
  readonly accountId: string;
  readonly status: OrderStatus;
  /** 주문 failure_reason. 비었으면 undefined */
  readonly failureReason?: string;
  /** ACCEPTED 결제 시도의 결제사. 없으면 undefined */
  readonly pg?: PaymentPg;
  /** ticket_issue_job 행의 created_at(epoch ms). 행이 없으면 undefined(발권했거나 보상했거나 아직 승인 전) */
  readonly issueJobCreatedAtMs?: number;
  /** ticket_issue_job.attempts(발권 시도 수). 행이 없으면 undefined. 행이 있는데 없으면 0으로 본다 */
  readonly issueJobAttempts?: number;
  /** ticket_issue_job.last_error(마지막 gRPC 상태 코드). 행이 없거나 null이면 undefined */
  readonly issueJobLastError?: string;
}

/** issueDelayed 판정에 쓰는 큐 행 칸 */
export type IssueJobView = Pick<PaymentStatusView, 'issueJobCreatedAtMs' | 'issueJobAttempts' | 'issueJobLastError'>;

/** 거절(409). NOT_ACCEPTED: CREATED·AUTHENTICATED(payment-not-accepted), ORDER_EXPIRED: EXPIRED(order-expired) */
export type PaymentStatusProblem = 'NOT_ACCEPTED' | 'ORDER_EXPIRED';

/**
 * 주문 상태 → 응답 결정.
 * - IMMEDIATE: 바로 그 본문으로 답한다
 * - WAIT: 기다린다. body는 기다림이 끝날 때까지 바뀌지 않으면 답할 지금 상태의 본문이다(시간이 다 되면 '그때의 상태로 답한다')
 * - REJECT: 409(problem)
 */
export type PaymentStatusDecision =
  | { readonly kind: 'IMMEDIATE'; readonly body: PaymentStatusBody }
  | { readonly kind: 'WAIT'; readonly body: PaymentStatusBody }
  | { readonly kind: 'REJECT'; readonly problem: PaymentStatusProblem };

/**
 * 발권이 늦어지는 중인가(ADR-0106, 리뷰 고침 M1): 발권 재시도 큐 행이 있고
 * (attempts ≥ 1이고 last_error가 있음: 첫 발권 시도가 실패해 다시 시도하는 중) 또는 (그 행을 만든 때(= 승인)부터 ISSUE_DELAYED_AFTER_MS(60초)가 지남).
 * [정함] 60초 경계는 nowMs − createdAtMs ≥ 60초를 참으로 본다. 행이 없으면 false. 상태는 보지 않는다(큐 행은 APPROVED에만 있다)
 * @param nowMs 지금(epoch ms, 벽시계)
 */
export function isIssueDelayed(job: IssueJobView, nowMs: number): boolean {
  if (job.issueJobCreatedAtMs === undefined) return false;
  if ((job.issueJobAttempts ?? 0) >= 1 && job.issueJobLastError !== undefined) return true;
  // 큐 행이 지금보다 뒤(시계 어긋남)면 흐른 시간이 음수라 거짓이다
  return nowMs - job.issueJobCreatedAtMs >= ISSUE_DELAYED_AFTER_MS;
}

/**
 * 주문 하나의 응답 결정(payment §2 '바로 답하는 상태'·'기다리는 상태').
 * - CONFIRMED·PARTIALLY_REFUNDED·REFUNDED → IMMEDIATE status CONFIRMED
 * - FAILED → IMMEDIATE(reason = failureReason, 비었으면 싣지 않음) · AWAITING_DEPOSIT·UNKNOWN·COMPENSATED → IMMEDIATE 그 값
 * - APPROVED → WAIT(본문 issueDelayed = isIssueDelayed. 참이어도 기다린다, 리뷰 고침 M2)
 * - ACCEPTED·RESERVED → WAIT
 * - CREATED·AUTHENTICATED → REJECT NOT_ACCEPTED · EXPIRED → REJECT ORDER_EXPIRED
 * 본문의 pg는 view.pg, virtualAccount는 싣지 않는다(가상계좌 단계 전). 계정 대조는 하지 않는다(쓰임새가 먼저 본다)
 */
export function decidePaymentStatus(view: PaymentStatusView, nowMs: number): PaymentStatusDecision {
  /** 본문 만들기: 칸 차례는 status → reason → issueDelayed → pg(값 없는 칸은 싣지 않는다) */
  const body = (status: PaymentStatusValue, issueDelayed = false): PaymentStatusBody => ({
    status,
    ...(status === 'FAILED' && view.failureReason ? { reason: view.failureReason } : {}),
    issueDelayed,
    ...(view.pg !== undefined ? { pg: view.pg } : {}),
  });
  switch (view.status) {
    case 'CREATED':
    case 'AUTHENTICATED':
      return { kind: 'REJECT', problem: 'NOT_ACCEPTED' };
    case 'EXPIRED':
      return { kind: 'REJECT', problem: 'ORDER_EXPIRED' };
    case 'CONFIRMED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return { kind: 'IMMEDIATE', body: body('CONFIRMED') };
    case 'FAILED':
    case 'AWAITING_DEPOSIT':
    case 'UNKNOWN':
    case 'COMPENSATED':
      return { kind: 'IMMEDIATE', body: body(view.status) };
    case 'APPROVED':
      return { kind: 'WAIT', body: body('APPROVED', isIssueDelayed(view, nowMs)) };
    case 'ACCEPTED':
    case 'RESERVED':
      return { kind: 'WAIT', body: body(view.status) };
  }
}

/**
 * 기다리던 요청을 깨울까(리뷰 고침 M2): 지금 모습의 결정이 WAIT이 아니면(바로 답할 상태·409) 깨우고,
 * WAIT이면 APPROVED의 issueDelayed가 기다림 시작 때 본문(since)의 거짓에서 참으로 바뀌었을 때만 깨운다.
 * 기다리는 상태 사이를 옮기기만 하면(ACCEPTED → RESERVED → APPROVED) 깨우지 않는다. since를 모르면 issueDelayed 거짓에서 시작한 것으로 본다.
 * 기다림 표(묶음 조회)와 쓰임새(깬 뒤 다시 볼 때)가 같은 규칙을 쓴다
 */
export function paymentStatusWakes(view: PaymentStatusView, since: PaymentStatusBody | undefined, nowMs: number): boolean {
  const d = decidePaymentStatus(view, nowMs);
  if (d.kind !== 'WAIT') return true;
  return d.body.issueDelayed && !(since?.issueDelayed ?? false);
}

/**
 * 이번 요청이 기다릴 시간(ms) = min(PAYMENT_STATUS_WAIT_MAX_MS 25초, 요청 남은 시간 − PAYMENT_STATUS_ANSWER_MARGIN_MS 1초). 0 아래로 가지 않는다.
 * 0이면 기다리지 않고 지금 상태로 바로 답한다. 남은 시간을 모르면(요청 맥락 없음) 쓰임새가 25초로 본다
 * @param remainingMs 요청 남은 시간(Deadline.remainingMs())
 */
export function paymentStatusWaitMs(remainingMs: number): number {
  const ms = Math.min(PAYMENT_STATUS_WAIT_MAX_MS, Math.floor(remainingMs) - PAYMENT_STATUS_ANSWER_MARGIN_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
