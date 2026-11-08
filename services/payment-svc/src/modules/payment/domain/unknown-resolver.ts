// UNKNOWN 해소의 값과 규칙(docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현'·§4.2 14번, docs/data.md §2 payment, BUILD_ORDER PRF-182, 명세 specs/payment.qnt `query`).
// 실행기(application/payment-unknown-resolver.ts)와 저장소가 쓴다. 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수).
// 구현에서 정한 것(정본·설계에 없다):
// - 답의 주문 ID가 원장과 다르면 상태를 보기 전에 다시 묻는다(SEV1 로그, 지표 amount_mismatch). 다른 주문의 답을 이 주문의 결과로 쓰지 않는다.
// - 취소 상태 답은 금액을 보지 않는다(승인을 기록한 적 없는 결제가 취소됐다는 사실만으로 사람이 본다).
// - 형 밖의 답(모르는 kind·status)은 결과를 가정하지 않고 query_failed로 다시 묻는다.
// - 승인 시각의 값이 없거나 읽지 못하면 지금이다(승인 실행기와 같다).
import type { ConfirmFinish, ConfirmTarget, PaymentEventMessage } from './confirm-runner.js';
import { paymentEventKey } from './confirm-runner.js';
import type { QueryResult } from './payment-gateway.js';

/** 잡기 주기 1초 [가정] */
export const UNKNOWN_QUERY_POLL_INTERVAL_MS = 1_000;
/** 파드당 동시 조회 16건 [가정] */
export const UNKNOWN_QUERY_CONCURRENCY = 16;
/** 한 번에 잡는 행 50건 [가정] */
export const UNKNOWN_QUERY_BATCH = 50;
/** UNKNOWN을 쓴 뒤 첫 조회까지, 그리고 조회 간격의 시작 5초 [가정] */
export const UNKNOWN_QUERY_BASE_MS = 5_000;
/** 조회 간격을 늘리는 배수 2배 [가정] */
export const UNKNOWN_QUERY_FACTOR = 2;
/** 조회 간격 상한 60초 [가정] */
export const UNKNOWN_QUERY_MAX_MS = 60_000;
/** 단독 조회 한 번의 시간 한도 10초 [가정](어댑터가 쓴다) */
export const UNKNOWN_QUERY_TIMEOUT_MS = 10_000;
/** 실행기가 조회를 감싸는 한도 12초 [가정](어댑터 한도가 먼저 끝나게 길고, 시간 한도가 없는 어댑터가 자리를 영구히 쥐지 않게 한다) */
export const UNKNOWN_QUERY_GUARD_MS = 12_000;
/** 잡을 때 다음 조회 시각을 미는 최소 15초 [가정](조회가 도는 동안 다른 파드가 다시 잡지 않게 실행기 한도보다 길다) */
export const UNKNOWN_QUERY_CLAIM_HOLD_MS = 15_000;
/** 오래 안 풀림으로 알리는 기준 1시간 [가정](payment §4.2 14번) */
export const UNKNOWN_OVERDUE_MS = 60 * 60_000;
/** 1시간 표시 반복 주기 1분 [가정] */
export const UNKNOWN_OVERDUE_SWEEP_INTERVAL_MS = 60_000;
/** 1시간 표시 한 번에 쓰는 행 100건 [가정] */
export const UNKNOWN_OVERDUE_BATCH = 100;
/** 어댑터 없음 경고 간격(파드당 1분에 한 줄) [가정] */
export const UNKNOWN_NO_ADAPTER_WARN_INTERVAL_MS = 60_000;

/** payment_event·trade.payments의 UNKNOWN 해소 기록(ADR-0073). 결과는 결과 사건이 따로 나간다 */
export const RESOLVED_EVENT_TYPE = 'RESOLVED';

/** payment_unknown_query_total{outcome}의 값 */
export const PAYMENT_UNKNOWN_QUERY_OUTCOMES = ['approved', 'failed', 'waiting', 'still_processing', 'not_found', 'amount_mismatch', 'cancelled_at_pg', 'query_failed', 'no_adapter'] as const;
export type PaymentUnknownQueryOutcome = (typeof PAYMENT_UNKNOWN_QUERY_OUTCOMES)[number];

/** 잡은 UNKNOWN 한 행(claimDueQueries의 결과). 답 반영에 필요한 원장 값을 함께 싣는다 */
export interface UnknownQueryJob extends Pick<ConfirmTarget, 'paymentId' | 'orderId' | 'eventId' | 'attemptNo' | 'pg' | 'paymentRef' | 'amount'> {
  /** 이번 잡기를 더한 조회 횟수(1부터) */
  readonly queryAttempts: number;
  /** 이 잡기가 쓴 next_query_at(epoch ms). 답을 본 뒤 간격을 다시 쓸 때의 조건이다 */
  readonly claimedNextQueryAtMs: number;
  /** anomaly_logged_at이 이미 있는가(SEV1을 이미 냈다) */
  readonly anomalyLogged: boolean;
}

/** UNKNOWN을 떠나는 결과(UNKNOWN으로 끝나는 갈래는 없다) */
export type ResolvedFinish = Exclude<ConfirmFinish, { readonly status: 'UNKNOWN' }>;

/** 결제마다 한 번 SEV1을 내는 답: 금액 어긋남·주문 어긋남·결제사 쪽 취소 상태 */
export type QueryAnomaly = 'amount' | 'order' | 'cancelled';

/**
 * 조회 답 → 할 일.
 * - RESOLVE: 결제사가 결과를 정했다. 원장에 finish를 쓴다
 * - ASK_AGAIN: 그대로 두고 다시 묻는다. anomaly가 있으면 결제마다 한 번 SEV1 로그를 남긴다
 */
export type QueryDecision =
  | { readonly kind: 'RESOLVE'; readonly finish: ResolvedFinish; readonly outcome: 'approved' | 'failed' | 'waiting' }
  | { readonly kind: 'ASK_AGAIN'; readonly outcome: 'still_processing' | 'not_found' | 'amount_mismatch' | 'cancelled_at_pg' | 'query_failed'; readonly anomaly?: QueryAnomaly };

/** decideQueryAnswer가 보는 원장 값 */
export type QueryLedger = Pick<UnknownQueryJob, 'orderId' | 'amount'>;

/** 실행기가 행 하나를 돈 결과(시험·로그용) */
export type UnknownRunOutcome =
  | { readonly kind: 'RESOLVED'; readonly status: ResolvedFinish['status']; readonly outcome: 'approved' | 'failed' | 'waiting' }
  | { readonly kind: 'ASKED_AGAIN'; readonly outcome: PaymentUnknownQueryOutcome }
  | { readonly kind: 'STALE' }
  | { readonly kind: 'SKIPPED'; readonly reason: 'STOPPED' }
  | { readonly kind: 'WRITE_FAILED' };

const STILL_PROCESSING: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'still_processing' };
const NOT_FOUND: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'not_found' };
const QUERY_FAILED: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'query_failed' };
const AMOUNT_MISMATCH: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' };
const ORDER_MISMATCH: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'order' };
const CANCELLED_AT_PG: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'cancelled_at_pg', anomaly: 'cancelled' };
/** 거듭제곱의 지수 상한(5초 × 2^5 = 160초가 상한 60초보다 크다) */
const DELAY_EXPONENT_CAP = 5;

/**
 * 조회 답 → 할 일(명세 `query`: 결제사가 결과를 정했을 때만 바꾼다). 던지지 않는다.
 * NOT_FOUND는 결과가 아니다: 결제 키는 결제사가 인증 때 준 값이라 '없다'는 답을 실패로 단정할 수 없고 명세에도 그 갈래가 없다. 기한이 지나도 다시 묻고 1시간 표시로 넘긴다.
 * @param answer 어댑터 query의 답
 * @param ledger 원장의 주문 ID·금액
 * @param nowMs 지금(epoch ms). 답의 승인 시각이 없거나 읽지 못하면 이 값이다
 */
export function decideQueryAnswer(answer: QueryResult, ledger: QueryLedger, nowMs: number): QueryDecision {
  switch (answer.kind) {
    case 'FOUND':
      return decideFound(answer, ledger, nowMs);
    case 'NOT_FOUND':
      return NOT_FOUND;
    default:
      return QUERY_FAILED;
  }
}

function decideFound(answer: Extract<QueryResult, { kind: 'FOUND' }>, ledger: QueryLedger, nowMs: number): QueryDecision {
  // 다른 주문의 답을 이 주문의 결과로 쓰지 않는다(상태를 보기 전에 본다)
  if (answer.orderRef !== ledger.orderId) return ORDER_MISMATCH;
  const method = answer.method === undefined ? {} : { payMethodCategory: answer.method };
  switch (answer.status) {
    case 'APPROVED': {
      if (answer.amount !== ledger.amount) return AMOUNT_MISMATCH;
      const parsed = answer.approvedAt === undefined ? Number.NaN : Date.parse(answer.approvedAt);
      return { kind: 'RESOLVE', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: Number.isNaN(parsed) ? nowMs : parsed, ...method }, outcome: 'approved' };
    }
    case 'PARTIAL_CANCELED':
    case 'CANCELED':
      // 승인을 기록한 적 없는 결제를 결제사가 취소한 드문 경우다. APPROVED로 쓰면 승인 전이가 표를 내주므로 사람이 본다(취소·대사 단계가 잇는다)
      return CANCELLED_AT_PG;
    case 'FAILED':
      return { kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'PG_ERROR', ...method }, outcome: 'failed' };
    case 'EXPIRED':
      return { kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'EXPIRED', ...method }, outcome: 'failed' };
    case 'WAITING_FOR_DEPOSIT':
      if (answer.amount !== ledger.amount) return AMOUNT_MISMATCH;
      return { kind: 'RESOLVE', finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', ...method }, outcome: 'waiting' };
    case 'READY':
    case 'IN_PROGRESS':
      return STILL_PROCESSING;
    default:
      return QUERY_FAILED;
  }
}

/**
 * 다음 조회까지의 간격(ms) = min(5초 × 2^(attempts − 1), 60초).
 * @param attempts 이번 잡기를 더한 조회 횟수(1 → 5초, 2 → 10초, 3 → 20초, 4 → 40초, 5 이상 → 60초). 아주 큰 수에서도 거듭제곱하지 않는다
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function unknownQueryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError(`조회 횟수는 1 이상의 안전한 정수다: ${String(attempts)}`);
  // 지수를 잘라 아주 큰 횟수에서도 거듭제곱이 넘치지 않게 한다(2^DELAY_EXPONENT_CAP × 5초는 이미 상한보다 크다)
  return Math.min(UNKNOWN_QUERY_MAX_MS, UNKNOWN_QUERY_BASE_MS * UNKNOWN_QUERY_FACTOR ** Math.min(attempts - 1, DELAY_EXPONENT_CAP));
}

/**
 * 잡을 때 밀어 둘 시간(ms) = max(unknownQueryDelayMs(attempts), 15초). 조회가 도는 동안 다른 파드가 같은 행을 다시 잡지 않게 하는 임대 노릇이다.
 * 답을 본 뒤 그대로 둘 때는 실제 간격(unknownQueryDelayMs)으로 다시 쓴다.
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function unknownQueryClaimHoldMs(attempts: number): number {
  return Math.max(unknownQueryDelayMs(attempts), UNKNOWN_QUERY_CLAIM_HOLD_MS);
}

/**
 * 결과 사건 → RESOLVED 사건(ADR-0073). 해소 결과는 result에 그대로 실린다.
 * type = RESOLVED, eventSeq = seq, eventKey = paymentEventKey(paymentId, seq), occurredAt = nowMs이고, 실패 범주·지연 시간은 싣지 않는다.
 * @throws RangeError 시각이 날짜 범위 밖, seq가 틀림
 */
export function buildResolvedEvent(paymentId: string, result: PaymentEventMessage, seq: number, nowMs: number): PaymentEventMessage {
  const eventKey = paymentEventKey(paymentId, seq);
  // 칸 차례는 asyncapi PaymentEvent와 같다
  return {
    eventId: result.eventId,
    orderId: result.orderId,
    pg: result.pg,
    type: RESOLVED_EVENT_TYPE,
    amount: result.amount,
    ...(result.payMethodCategory === undefined ? {} : { payMethodCategory: result.payMethodCategory }),
    refMissing: result.refMissing,
    ...(result.result === undefined ? {} : { result: result.result }),
    attemptNo: result.attemptNo,
    occurredAt: new Date(nowMs).toISOString(),
    eventSeq: seq,
    eventKey,
  };
}
