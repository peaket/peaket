// UNKNOWN 해소의 값과 규칙(docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현'·§4.2 14번, docs/data.md §2 payment, BUILD_ORDER PRF-182, 명세 specs/payment.qnt `query`).
// 실행기(application/payment-unknown-resolver.ts)와 저장소가 쓴다. 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수). 입금 대기 행의 답도 여기서 정한다(§6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151).
// 구현에서 정한 것(정본·설계에 없다):
// - 답의 주문 ID가 원장과 다르면 상태를 보기 전에 다시 묻는다(SEV1 로그, 지표 amount_mismatch). 다른 주문의 답을 이 주문의 결과로 쓰지 않는다.
// - 취소 상태 답은 금액을 보지 않는다(승인을 기록한 적 없는 결제가 취소됐다는 사실만으로 사람이 본다).
// - 형 밖의 답(모르는 kind·status)은 결과를 가정하지 않고 query_failed로 다시 묻는다.
// - 승인 시각의 값이 없거나 읽지 못하면 지금이다(승인 실행기와 같다).
import type { ConfirmFinish, ConfirmTarget, PaymentEventMessage } from './confirm-runner.js';
import { paymentEventKey } from './confirm-runner.js';
import type { PayMethodCategory, QueryResult } from './payment-gateway.js';
import { linkFinishFields, type PaymentMethodLink } from './payment-method-ref.js';
import { depositExpired, depositNextQueryAtMs, depositNotifiedRecently } from './virtual-account.js';

/** 잡기 주기 1초 [가정] */
export const UNKNOWN_QUERY_POLL_INTERVAL_MS = 1_000;
/** 파드당 동시 조회 16건 [가정] */
export const UNKNOWN_QUERY_CONCURRENCY = 16;
/** 한 번에 잡는 행 50건 [가정] */
export const UNKNOWN_QUERY_BATCH = 50;
/** UNKNOWN을 쓴 뒤 첫 조회까지, 그리고 조회 간격의 시작 1초 [가정](BAT-029: 결제 확정 p99 3초 안에 결과 모름을 풀기 위해 5초에서 줄였다) */
export const UNKNOWN_QUERY_BASE_MS = 1_000;
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
/** 입금 오류를 조회로 확인하지 못한 채 SEV1을 내는 기준: 되돌림 통보 뒤 1시간 [가정](BUILD_ORDER HOT-152 코드 리뷰) */
export const REVERSAL_OVERDUE_MS = 60 * 60_000;
/** 1시간 표시 반복 주기 1분 [가정] */
export const UNKNOWN_OVERDUE_SWEEP_INTERVAL_MS = 60_000;
/** 1시간 표시 한 번에 쓰는 행 100건 [가정] */
export const UNKNOWN_OVERDUE_BATCH = 100;
/** 어댑터 없음 경고 간격(파드당 1분에 한 줄) [가정] */
export const UNKNOWN_NO_ADAPTER_WARN_INTERVAL_MS = 60_000;
/** 토큰이 없어 부르지 못한 행의 다음 조회까지 1초 [가정](잡기 주기와 같다, BUILD_ORDER PRF-183) */
export const UNKNOWN_QUERY_NO_TOKEN_DELAY_MS = 1_000;

/** payment_event·trade.payments의 UNKNOWN 해소 기록(ADR-0073). 결과는 결과 사건이 따로 나간다 */
export const RESOLVED_EVENT_TYPE = 'RESOLVED';

/** payment_unknown_query_total{outcome}의 값 */
export const PAYMENT_UNKNOWN_QUERY_OUTCOMES = ['approved', 'failed', 'waiting', 'still_processing', 'not_found', 'amount_mismatch', 'cancelled_at_pg', 'query_failed', 'no_adapter', 'deposit_approved', 'deposit_expired', 'deposit_waiting', 'late_deposit', 'deposit_reversed', 'reversal_waiting', 'reversal_unconfirmed', 'reversal_no_time'] as const;
export type PaymentUnknownQueryOutcome = (typeof PAYMENT_UNKNOWN_QUERY_OUTCOMES)[number];

/** 잡은 UNKNOWN 한 행(claimDueQueries의 결과). 답 반영에 필요한 원장 값을 함께 싣는다 */
export interface UnknownQueryJob extends Pick<ConfirmTarget, 'virtualAccountAllowed' | 'paymentId' | 'orderId' | 'eventId' | 'attemptNo' | 'pg' | 'paymentRef' | 'txId' | 'amount'> {
  /** 이번 잡기를 더한 조회 횟수(1부터) */
  readonly queryAttempts: number;
  /** 이 잡기가 쓴 next_query_at(epoch ms). 답을 본 뒤 간격을 다시 쓸 때의 조건이다 */
  readonly claimedNextQueryAtMs: number;
  /** anomaly_logged_at이 이미 있는가(SEV1을 이미 냈다) */
  readonly anomalyLogged: boolean;
  /** 입금 대기(AWAITING_DEPOSIT) 행일 때만 있다. notifiedAtMs는 입금 완료 통보를 처음 받은 시각이고, reversedAtMs는 이 결제의 마지막 입금 되돌림(T21) 시각이다(BUILD_ORDER HOT-151·HOT-152) */
  readonly deposit?: { readonly dueAtMs?: number; readonly notifiedAtMs?: number; readonly reversedAtMs?: number };
  /** FAILED로 끝난 행의 늦은 입금 확인 한 번일 때만 참이다(결과를 쓰지 않는다, BUILD_ORDER HOT-151 코드 리뷰) */
  readonly lateDepositCheck?: true;
  /** 승인 원장의 입금 오류 확인일 때만 있다. notifiedAtMs는 되돌림 통보를 처음 받은 시각이다(BUILD_ORDER HOT-152) */
  readonly reversalCheck?: { readonly notifiedAtMs?: number };
  /** 회차의 입장 시작 시각(epoch ms). 되돌림의 새 입금 기한을 자른다. 승인 명령에 없었으면 없다(BUILD_ORDER PRF-190) */
  readonly entryOpensAtMs?: number;
  /** 승인 접수 시각(epoch ms, payment_event 첫 행). UNKNOWN 행의 결제 확정 소요 시작점이다(BUILD_ORDER PRF-200) */
  readonly acceptedAtMs?: number;
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
  | { readonly kind: 'RESOLVE'; readonly finish: ResolvedFinish; readonly outcome: ResolveOutcome }
  | { readonly kind: 'ASK_AGAIN'; readonly outcome: 'still_processing' | 'not_found' | 'amount_mismatch' | 'cancelled_at_pg' | 'query_failed' | 'deposit_waiting'; readonly anomaly?: QueryAnomaly; readonly nextAtMs?: number; readonly keepAttempts?: true };

/** 원장을 바꾸는 결과의 지표 값 */
export type ResolveOutcome = 'approved' | 'failed' | 'waiting' | 'deposit_approved' | 'deposit_expired';

/** decideQueryAnswer가 보는 원장 값. deposit이 있으면 입금 대기 행이다 */
export type QueryLedger = Pick<UnknownQueryJob, 'orderId' | 'amount' | 'deposit'> & Partial<Pick<UnknownQueryJob, 'queryAttempts'>>;

/**
 * 입금 오류 확인의 조회 답 → 할 일(payment §6 '확정', BUILD_ORDER HOT-152).
 * - REVERSE: 결제사 상태가 입금 대기로 돌아왔다. 원장을 되돌린다
 * - ASK_AGAIN: 그대로 두고 nextAtMs에 다시 묻는다. anomaly가 있으면 결제마다 한 번 SEV1 로그, overdue가 있으면 통보 뒤 1시간 [가정]을 넘겨 SEV1을 한 번 낸다
 * - END: 묻기를 끝낸다(원장은 그대로). 입금 완료라는 정상 답이 창을 지났거나(지연된 통보) 취소·실패·만료 답일 때다
 */
export type ReversalDecision =
  | { readonly kind: 'REVERSE'; readonly virtualAccount?: QueryVirtualAccount }
  | { readonly kind: 'ASK_AGAIN'; readonly outcome: 'reversal_waiting' | 'amount_mismatch' | 'query_failed' | 'not_found'; readonly nextAtMs: number; readonly anomaly?: QueryAnomaly; readonly overdue?: true }
  | { readonly kind: 'END' };

/** 조회 답의 가상계좌 칸 */
export type QueryVirtualAccount = NonNullable<Extract<QueryResult, { kind: 'FOUND' }>['virtualAccount']>;

/** 실행기가 행 하나를 돈 결과(시험·로그용) */
export type UnknownRunOutcome =
  | { readonly kind: 'RESOLVED'; readonly status: ResolvedFinish['status']; readonly outcome: ResolveOutcome }
  | { readonly kind: 'ASKED_AGAIN'; readonly outcome: PaymentUnknownQueryOutcome }
  | { readonly kind: 'STALE' }
  | { readonly kind: 'LATE_DEPOSIT'; readonly paid: boolean }
  | { readonly kind: 'REVERSED' }
  /** 되돌렸지만 입장이 2시간 [가정] 안이라 재입금 없이 실패로 끝냈다(BUILD_ORDER PRF-190 코드 리뷰) */
  | { readonly kind: 'REVERSAL_CLOSED' }
  | { readonly kind: 'REVERSAL_ENDED' }
  | { readonly kind: 'SKIPPED'; readonly reason: 'STOPPED' | 'NO_TOKEN' | 'CIRCUIT_OPEN' }
  | { readonly kind: 'WRITE_FAILED' };

const STILL_PROCESSING: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'still_processing' };
const NOT_FOUND: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'not_found' };
const QUERY_FAILED: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'query_failed' };
const AMOUNT_MISMATCH: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' };
const ORDER_MISMATCH: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'order' };
const CANCELLED_AT_PG: QueryDecision = { kind: 'ASK_AGAIN', outcome: 'cancelled_at_pg', anomaly: 'cancelled' };
/** 거듭제곱의 지수 상한(5초 × 2^5 = 160초가 상한 60초보다 크다) */
const DELAY_EXPONENT_CAP = 6;

/**
 * 조회 답 → 할 일(명세 `query`: 결제사가 결과를 정했을 때만 바꾼다). 던지지 않는다.
 * NOT_FOUND는 결과가 아니다: 결제 키는 결제사가 인증 때 준 값이라 '없다'는 답을 실패로 단정할 수 없고 명세에도 그 갈래가 없다. 기한이 지나도 다시 묻고 1시간 표시로 넘긴다.
 * @param answer 어댑터 query의 답
 * @param ledger 원장의 주문 ID·금액
 * @param nowMs 지금(epoch ms). 답의 승인 시각이 없거나 읽지 못하면 이 값이다
 * @param linkOf 답의 카드 칸으로 결제 수단 연결값을 계산한다. 주문·금액 대조를 통과해 승인으로 끝날 때만 부른다(어긋난 답은 다시 물을 때마다 계산하지 않는다, BUILD_ORDER HOT-145 코드 리뷰)
 */
export function decideQueryAnswer(answer: QueryResult, ledger: QueryLedger, nowMs: number, linkOf?: () => PaymentMethodLink): QueryDecision {
  switch (answer.kind) {
    case 'FOUND':
      return decideFound(answer, ledger, nowMs, linkOf);
    case 'NOT_FOUND':
      return NOT_FOUND;
    default:
      return QUERY_FAILED;
  }
}

function decideFound(answer: Extract<QueryResult, { kind: 'FOUND' }>, ledger: QueryLedger, nowMs: number, linkOf: (() => PaymentMethodLink) | undefined): QueryDecision {
  // 다른 주문의 답을 이 주문의 결과로 쓰지 않는다(상태를 보기 전에 본다)
  if (answer.orderRef !== ledger.orderId) return ORDER_MISMATCH;
  const method = answer.method === undefined ? {} : { payMethodCategory: answer.method };
  if (ledger.deposit !== undefined) return decideDepositFound(answer, ledger, ledger.deposit, nowMs, method);
  switch (answer.status) {
    case 'APPROVED': {
      if (answer.amount !== ledger.amount) return AMOUNT_MISMATCH;
      const parsed = answer.approvedAt === undefined ? Number.NaN : Date.parse(answer.approvedAt);
      return { kind: 'RESOLVE', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: Number.isNaN(parsed) ? nowMs : parsed, ...method, ...linkFinishFields(linkOf?.()) }, outcome: 'approved' };
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
 * 입금 대기 행의 조회 답(payment §6 '조회와 전이'). 주문 대조는 부른 쪽이 먼저 했다.
 * 입금 완료는 T16, 기한 + 10분 전의 입금 대기는 그대로, 기한 + 10분이 지난 입금 대기와 FAILED·EXPIRED·CANCELED는 T17(FAILED, EXPIRED)이다.
 * 입금 완료 통보를 받은 지 10분 [가정] 안의 입금 대기는 결제사 조회 반영이 늦는 것으로 보고 만료로 쓰지 않으며 5초에서 두 배로(최대 60초 [가정]) 다시 묻는다(코드 리뷰 M3).
 * @param deposit 원장의 입금 기한(없으면 답의 기한을 쓴다)과 입금 완료 통보 시각
 */
function decideDepositFound(answer: Extract<QueryResult, { kind: 'FOUND' }>, ledger: QueryLedger, deposit: NonNullable<QueryLedger['deposit']>, nowMs: number, method: { payMethodCategory?: PayMethodCategory }): QueryDecision {
  const ledgerAmount = ledger.amount;
  const dueAtMs = deposit.dueAtMs;
  const expired: QueryDecision = { kind: 'RESOLVE', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'EXPIRED', ...method }, outcome: 'deposit_expired' };
  switch (answer.status) {
    case 'APPROVED': {
      if (answer.amount !== ledgerAmount) return AMOUNT_MISMATCH;
      const parsed = answer.approvedAt === undefined ? Number.NaN : Date.parse(answer.approvedAt);
      // 되돌리기 전의 입금 시각이 그대로 오면 정산 기준으로 쓰지 않는다(T21보다 이르면 지금, BUILD_ORDER HOT-152 코드 리뷰)
      const beforeReversal = deposit.reversedAtMs !== undefined && parsed < deposit.reversedAtMs;
      return { kind: 'RESOLVE', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: Number.isNaN(parsed) || beforeReversal ? nowMs : parsed, ...method }, outcome: 'deposit_approved' };
    }
    case 'WAITING_FOR_DEPOSIT': {
      if (answer.amount !== ledgerAmount) return AMOUNT_MISMATCH;
      if (depositNotifiedRecently(deposit.notifiedAtMs, nowMs)) return { kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: nowMs + unknownQueryDelayMs(ledger.queryAttempts ?? 1), keepAttempts: true };
      const due = dueAtMs ?? dueAtOf(answer.virtualAccount?.dueAt);
      if (depositExpired(due, nowMs)) return expired;
      return { kind: 'ASK_AGAIN', outcome: 'deposit_waiting', nextAtMs: depositNextQueryAtMs(due, nowMs) };
    }
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELED':
      return expired;
    case 'PARTIAL_CANCELED':
      return CANCELLED_AT_PG;
    case 'READY':
    case 'IN_PROGRESS':
      return STILL_PROCESSING;
    default:
      return QUERY_FAILED;
  }
}

/**
 * 입금 오류 확인의 조회 답 → 할 일. 던지지 않는다.
 * 답을 믿을 수 없는 동안(조회 실패·기록 없음·주문이나 금액 어긋남·처리 중)은 끝내지 않는다: 창 안은 5초에서 두 배로, 창이 지나면 60초 [가정] 간격으로 묻고 통보 뒤 1시간 [가정]을 넘으면 SEV1을 한 번 낸다(입금 되돌림을 잃지 않게, BUILD_ORDER HOT-152 코드 리뷰).
 * 정상 조회가 입금 완료라고 답하면 창 안에서만 다시 묻고 창이 지나면 끝낸다(되돌림이 아니라 지연된 통보다).
 * @param ledger 원장의 주문 ID·금액과 이번 잡기까지의 조회 횟수
 * @param notifiedAtMs 되돌림 통보를 처음 받은 시각. 없으면 1시간이 지난 것으로 본다
 * @param nowMs 지금(epoch ms)
 */
export function decideReversalAnswer(answer: QueryResult, ledger: Pick<UnknownQueryJob, 'orderId' | 'amount' | 'queryAttempts'>, notifiedAtMs: number | undefined, nowMs: number): ReversalDecision {
  const within = depositNotifiedRecently(notifiedAtMs, nowMs);
  const overdue = notifiedAtMs === undefined || nowMs >= notifiedAtMs + REVERSAL_OVERDUE_MS;
  const again = (outcome: 'reversal_waiting' | 'amount_mismatch' | 'query_failed' | 'not_found', anomaly?: QueryAnomaly): ReversalDecision => ({
    kind: 'ASK_AGAIN',
    outcome,
    nextAtMs: nowMs + (within ? unknownQueryDelayMs(ledger.queryAttempts) : UNKNOWN_QUERY_MAX_MS),
    ...(anomaly === undefined ? {} : { anomaly }),
    ...(overdue ? { overdue: true as const } : {}),
  });
  if (answer.kind === 'NOT_FOUND') return again('not_found');
  if (answer.kind !== 'FOUND') return again('query_failed');
  // 다른 주문의 답을 이 주문의 결과로 쓰지 않는다(상태를 보기 전에 본다)
  if (answer.orderRef !== ledger.orderId) return again('amount_mismatch', 'order');
  switch (answer.status) {
    case 'WAITING_FOR_DEPOSIT':
      if (answer.amount !== ledger.amount) return again('amount_mismatch', 'amount');
      return { kind: 'REVERSE', ...(answer.virtualAccount === undefined ? {} : { virtualAccount: answer.virtualAccount }) };
    case 'APPROVED':
      // 결제사 조회 반영이 통보보다 늦을 수 있어 창 안에서 다시 묻는다
      return within ? again('reversal_waiting') : REVERSAL_END;
    case 'READY':
    case 'IN_PROGRESS':
      return again('reversal_waiting');
    default:
      // 취소·실패·만료는 되돌림이 아니다(취소 흐름과 대사가 맡는다)
      return REVERSAL_END;
  }
}

const REVERSAL_END: ReversalDecision = { kind: 'END' };

/** ISO 8601 → epoch ms. 없거나 읽지 못하면 undefined */
function dueAtOf(raw: string | undefined): number | undefined {
  const ms = raw === undefined ? Number.NaN : Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 다음 조회까지의 간격(ms) = min(5초 × 2^(attempts − 1), 60초).
 * @param attempts 이번 잡기를 더한 조회 횟수(1 → 5초, 2 → 10초, 3 → 20초, 4 → 40초, 5 이상 → 60초). 아주 큰 수에서도 거듭제곱하지 않는다
 * @throws RangeError attempts가 1 이상의 안전한 정수가 아님
 */
export function unknownQueryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError(`조회 횟수는 1 이상의 안전한 정수다: ${String(attempts)}`);
  // 지수를 잘라 아주 큰 횟수에서도 거듭제곱이 넘치지 않게 한다(2^DELAY_EXPONENT_CAP × 1초는 상한 60초보다 크다, BAT-029)
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
 * type = RESOLVED, eventSeq = seq, eventKey = paymentEventKey(paymentId, seq), occurredAt = nowMs이고, 실패 범주·지연 시간은 싣지 않는다. 결제 수단 연결값은 결과 사건과 같다(BUILD_ORDER HOT-145).
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
    ...(result.paymentMethodRef === undefined ? {} : { paymentMethodRef: result.paymentMethodRef, cardBin: result.cardBin }),
    refMissing: result.refMissing,
    ...(result.result === undefined ? {} : { result: result.result }),
    attemptNo: result.attemptNo,
    occurredAt: new Date(nowMs).toISOString(),
    eventSeq: seq,
    eventKey,
  };
}
