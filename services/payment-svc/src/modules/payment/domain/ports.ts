// 승인 명령 접수와 결과 조회의 포트(docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180).
import type { ConfirmPaymentCommand, PaymentRecord, PaymentState } from './confirm-command.js';
import type { ConfirmFinish, ConfirmJob, ConfirmTarget, PaymentConfirmOutcome, PaymentEventMessage } from './confirm-runner.js';
import type { FailureCategory, PaymentGatewayPort, PgName } from './payment-gateway.js';
import type { PgLimitKind, PgSaturationReason } from './pg-call-guard.js';
import type { PaymentUnknownQueryOutcome, ResolvedFinish, UnknownQueryJob } from './unknown-resolver.js';

/** 새 결제를 쓸 때 쓰임새가 만들어 넘기는 값 */
export interface NewPaymentValues {
  /** payment.id(UUIDv7) */
  readonly paymentId: string;
  /** 이력 첫 행의 event_key(UUIDv7) */
  readonly eventKey: string;
  /** 지금(epoch ms). created_at·status_changed_at·occurred_at·next_attempt_at */
  readonly nowMs: number;
}

/** 이 호출에 남은 시간. gRPC 데드라인에서 잰 값이고 데드라인 없는 호출은 Infinity다. 저장소가 연결을 기다린 시간을 빼고 문장 시간 한도를 정한다 */
export interface CallBudget {
  readonly remainingMs: number;
}

/**
 * 승인 명령 저장 결과.
 * - CREATED: 처음 받았다(원장·이력 첫 행·승인 명령을 한 트랜잭션으로 썼다)
 * - EXISTING: 같은 order_id의 행이 이미 있다(다시 왔거나 겹침). 아무것도 쓰지 않았다
 */
export type StoreCommandResult = { readonly kind: 'CREATED'; readonly record: PaymentRecord } | { readonly kind: 'EXISTING'; readonly record: PaymentRecord };

export interface PaymentCommandStore {
  /**
   * `INSERT payment … ON CONFLICT (order_id) DO NOTHING`. 넣었으면 같은 트랜잭션에서 payment_event(순번 1, 종류 ACCEPTED, exported false)와
   * payment_confirm_job(next_attempt_at = nowMs)을 쓴다. 0행이면 있는 행을 읽어 EXISTING으로 돌려준다.
   * 결제 참조는 pg_payment_ref(토스 paymentKey·포트원 paymentId), 포트원 토큰은 pg_confirm_token, 포트원 결제 시도 ID는 pg_tx_id에 적는다. idempotency_key = confirm-{orderId}.
   * 트랜잭션은 READ COMMITTED이고, 문장 시간 한도는 min(200ms [가정], 연결을 받은 뒤 budget에 남은 시간)이다.
   * @throws PaymentDeadlineError 연결을 받고 보니 남은 시간이 MIN_CALL_REMAINING_MS보다 모자람(아무것도 쓰지 않는다)
   */
  store(command: ConfirmPaymentCommand, values: NewPaymentValues, budget?: CallBudget): Promise<StoreCommandResult>;
}

export interface PaymentStateReader {
  /**
   * 주문들의 결제 행과 마지막 수출 사건을 한 문장으로 읽는다(LATERAL, 쓰기 인스턴스, 일반 풀, 문장 시간 한도 min(400ms [가정], 연결을 받은 뒤 budget에 남은 시간)). 없는 주문은 결과에 없다.
   * 결제사는 부르지 않는다(ADR-0140 결정 3).
   * @throws PaymentDeadlineError 연결을 받고 보니 남은 시간이 MIN_CALL_REMAINING_MS보다 모자람(읽지 않는다)
   */
  batchGet(orderIds: readonly string[], budget?: CallBudget): Promise<PaymentState[]>;
}

/** 승인 명령 접수의 로그(주문 ID만 싣는다. 결제 키·토큰·금액은 싣지 않는다). 던지지 않는다 */
export interface PaymentCommandLog {
  /** 이미 있는 결제와 다른 명령을 거절했다(SEV2, kind payment-confirm-mismatch) */
  mismatch(e: { readonly orderId: string }): void;
}

/** payment_confirm_commands_total의 outcome */
export type ConfirmCommandOutcome = 'accepted' | 'replayed' | 'mismatch' | 'invalid' | 'error';
/** payment_batch_get_requests_total의 outcome */
export type BatchGetOutcome = 'ok' | 'invalid' | 'error';

/** 지표. 던지지 않는다 */
export interface PaymentCommandSignals {
  confirmCommand(outcome: ConfirmCommandOutcome): void;
  batchGet(outcome: BatchGetOutcome): void;
}

// ---- 승인 실행기(BUILD_ORDER PRF-181, docs/features/payment.md §2 '승인 실행기의 첫 구현') ----

/** markSent 결과: MARKED 표시를 썼다, ALREADY 이미 있었다(그대로 다시 보낸다), LEASE_LOST 임대를 잃었다(부르지 않는다), STALE 원장이 ACCEPTED가 아니다(부르지 않는다) */
export type MarkConfirmSentResult = 'MARKED' | 'ALREADY' | 'LEASE_LOST' | 'STALE';

/** finish 결과: APPLIED 원장·사건·Outbox·명령 행 지움을 커밋했다, STALE 원장이 ACCEPTED가 아니라 명령 행만 지웠다 */
export type FinishConfirmResult = 'APPLIED' | 'STALE';

/**
 * 승인 명령 저장소(모든 쓰기는 READ COMMITTED, 문장 시간 한도 CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS).
 * 잠금 차례는 payment 행 → payment_confirm_job 행이다(잡기는 명령 행만 잠근다).
 */
export interface PaymentConfirmJobs {
  /**
   * 짧은 트랜잭션 하나에서 그 결제사의 `next_attempt_at <= 지금 AND (lease_until IS NULL OR lease_until < 지금)`인 행을 `payment_confirm_job_claim_idx`로 `FOR UPDATE SKIP LOCKED`(결제 표는 조인하지 않는다)로 limit개 골라
   * lease_owner = owner, lease_until = 지금 + leaseMs를 쓰고 커밋한다(attempts는 올리지 않는다). 고른 차례(next_attempt_at, 같으면 payment_id)로 돌려준다.
   * hadPreviousOwner는 쓰기 전의 lease_owner가 차 있었는가다.
   * @throws RangeError limit·leaseMs가 1 이상의 정수가 아님, owner가 빈 글
   */
  claimDue(pg: PgName, limit: number, owner: string, leaseMs: number): Promise<ConfirmJob[]>;

  /**
   * 승인 기한이 지난 행만 limit개 잡는다(벌크헤드·토큰과 상관없이 부르지 않고 끝내는 길, BUILD_ORDER PRF-183 코드 리뷰). 조건은 claimDue에 `payment.authenticated_at <= 지금 − deadlineMs`를 더한 것이고 명령 행만 잠근다.
   * 표 앞쪽 CONFIRM_EXPIRED_SCAN행만 원장과 대조한다.
   * @throws RangeError limit·leaseMs·deadlineMs가 1 이상의 정수가 아님, owner가 빈 글
   */
  claimExpired(pg: PgName, limit: number, owner: string, leaseMs: number, deadlineMs: number): Promise<ConfirmJob[]>;

  /** 그 채널에 지금 잡을 수 있는 행이 있는가(여유가 0인 틱에서 상한에 막혔는지 가린다) */
  hasDue(pg: PgName): Promise<boolean>;

  /** 원장 행과 CONFIRM_SENT 표시 유무를 한 문장으로 읽는다. 행이 없으면 undefined */
  read(paymentId: string): Promise<ConfirmTarget | undefined>;

  /**
   * 승인 호출 앞의 표시이자 임대 확인(명세 `send`). 처음이든 재전송이든 부르기 전에 한 번 부른다. 한 트랜잭션: payment 행 FOR UPDATE → status가 ACCEPTED가 아니면 STALE → 명령 행을 자기 임대 조건(lease_owner·lease_until)으로 FOR UPDATE, 없으면 LEASE_LOST
   * → CONFIRM_SENT가 있으면 ALREADY → 없으면 payment_event에 다음 순번(max(seq) + 1), 종류 CONFIRM_SENT, exported false, event_key = paymentEventKey를 쓰고 MARKED.
   * MARKED를 돌려줄 때 이미 커밋되어 있다(결제사 호출은 그 뒤에 한다).
   */
  markSent(job: ConfirmJob): Promise<MarkConfirmSentResult>;

  /**
   * 답 반영(명세 `respond`·`timeout`·`restart`·`expireCommand`). 한 트랜잭션: payment 행 FOR UPDATE → status가 ACCEPTED가 아니면 명령 행만 지우고 STALE
   * → 다음 순번(max(seq) + 1)으로 payment_event(type = finish.status, exported true, event_key, occurred_at)
   * → payment(status, status_changed_at = 지금. APPROVED는 approved_at, FAILED는 failure_category. APPROVED·FAILED·AWAITING_DEPOSIT이면 pg_confirm_token을 지운다, UNKNOWN은 남긴다)
   * → 명령 행 지우기 → Outbox `trade.payments`(키 = 회차 ID, 값 = buildPaymentEvent, 트랜잭션의 마지막 문장).
   * 임대를 조건으로 보지 않는다(늦은 답도 원장이 ACCEPTED이면 쓴다. 겹침은 payment 행 잠금이 가른다).
   * @param target read가 돌려준 값. 사건의 칸을 채운다
   */
  finish(target: ConfirmTarget, finish: ConfirmFinish): Promise<FinishConfirmResult>;

  /**
   * 명령 행을 자기 임대 조건으로 미룬다: next_attempt_at = nextAtMs, lease_owner·lease_until 비움. 임대를 잃었으면 false.
   * countRetry가 참이면(결제사 답이 처리 중·한도 초과) attempts를 1 올린다. 어댑터 없음으로 미룰 때는 거짓이다
   */
  reschedule(job: ConfirmJob, nextAtMs: number, o: { readonly countRetry: boolean }): Promise<boolean>;

  /** 자기 임대 조건으로 명령 행을 지운다(원장이 ACCEPTED가 아닐 때). 임대를 잃었으면 false */
  dropJob(job: ConfirmJob): Promise<boolean>;

  /** 임대만 놓는다(lease_owner·lease_until 비움, 자기 임대 조건). 임대를 잃었으면 false */
  release(job: ConfirmJob): Promise<boolean>;
}

/** 결제사 어댑터 등록부. 이 단계는 시뮬레이터 하나다(토스 PRF-184, 포트원 HOT-140) */
export interface PaymentGateways {
  /** 그 결제사의 어댑터. 없으면 undefined(부르지 않고 미룬다) */
  of(pg: PgName): PaymentGatewayPort | undefined;
}

/** trade.payments 값의 바이트를 만든다(지금은 JSON 대역, Avro는 BAS-030) */
export interface PaymentEventCodec {
  encode(message: PaymentEventMessage): Uint8Array;
}

/** 실행기의 로그(주문 ID·결제사만 싣는다. 결제 키·토큰·금액은 싣지 않는다). 던지지 않는다 */
export interface PaymentConfirmLog {
  /** 승인 금액이 원장과 다르거나 답에 없다(SEV1, kind payment-confirm-amount-mismatch). 주문 ID와 금액 차이 여부만 싣는다 */
  amountMismatch(e: { readonly orderId: string }): void;
  /** 결제사 어댑터가 없다(파드당 1분에 경고 한 줄, 실행기가 조절한다) */
  noAdapter(e: { readonly pg: PgName }): void;
  /** 쓰기가 다시 해도 실패했다(행을 그대로 둔다, 임대가 끝나면 UNKNOWN으로 맞춰진다) */
  writeFailed(e: { readonly orderId: string; readonly stage: 'mark' | 'finish' | 'reschedule' | 'drop'; readonly code: string }): void;
  /** 답을 쓰려니 원장이 ACCEPTED가 아니었다(늦은 답, 경고 한 줄) */
  staleAnswer(e: { readonly orderId: string }): void;
  /** 실행기 안의 예상 못 한 오류(what = claim·read·call). 어댑터가 safeErrorCode만 싣는다 */
  runError(e: { readonly what: 'claim' | 'read' | 'call'; readonly orderId?: string; readonly err: unknown }): void;
  /** 결제사가 PG_ERROR로 거절했다(키 폐기·IP 변경 등을 찾는 단서, 채널당 1분에 한 줄, 실행기가 조절한다). 결제사와 결제사 코드만 싣고, 코드는 안전한 글자 모양일 때만 어댑터가 싣는다 */
  pgError(e: { readonly pg: PgName; readonly pgCode?: string }): void;
}

/** 실행기 지표(docs/observability.md, BUILD_ORDER PRF-181). 던지지 않는다 */
export interface PaymentConfirmSignals {
  /** payment_confirm_total{pg, outcome}를 1 올린다 */
  outcome(pg: PgName, outcome: PaymentConfirmOutcome): void;
  /** payment_confirm_declined_total{pg, category}를 1 올린다(결제사가 거절로 답한 호출 수, BUILD_ORDER PRF-184) */
  declined(pg: PgName, category: FailureCategory): void;
  /** payment_confirm_seconds{pg}에 결제사 호출 시간을 더한다(던진 호출도 잰다) */
  callSeconds(pg: PgName, seconds: number): void;
  /** payment_confirm_in_flight를 지금 돌고 있는 승인 호출 수로 둔다 */
  inFlight(count: number): void;
  /** payment_confirm_write_failures_total을 1 올린다(쓰기가 다시 해도 실패했을 때) */
  writeFailure(): void;
}

// ---- UNKNOWN 해소(BUILD_ORDER PRF-182, docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현') ----

/** resolve 결과: APPLIED 원장·사건·Outbox를 커밋했다, STALE 원장이 UNKNOWN이 아니라 아무것도 쓰지 않았다 */
export type ResolveUnknownResult = 'APPLIED' | 'STALE';

/** UNKNOWN 조회 저장소(모든 쓰기는 READ COMMITTED, 문장 시간 한도 CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS) */
export interface PaymentUnknownQueries {
  /**
   * 짧은 트랜잭션 하나에서 그 결제사의 `status = 'UNKNOWN' AND next_query_at <= 지금`인 행을 `FOR UPDATE SKIP LOCKED`로 limit개 고르고(next_query_at 차례),
   * 행마다 next_query_at = 지금 + unknownQueryClaimHoldMs(query_attempts + 1), query_attempts + 1을 쓴 뒤 커밋한다. 고른 차례로 돌려준다.
   * @throws RangeError limit이 1 이상의 정수가 아님
   */
  claimDueQueries(pg: PgName, limit: number): Promise<UnknownQueryJob[]>;

  /** 그 채널에 지금 조회할 행이 있는가(토큰이 없는 틱에서 상한에 막혔는지 가린다) */
  hasDueQueries(pg: PgName): Promise<boolean>;

  /**
   * 답을 본 뒤 그대로 둘 때의 다음 조회 시각을 쓴다. 조건은 `status = 'UNKNOWN' AND next_query_at = 이 잡기가 쓴 값`이다(늦은 답이 다른 파드의 잡기를 덮어쓰지 않는다). 썼으면 true.
   * refundAttempt가 참이면 잡을 때 올린 query_attempts를 1 되돌린다(토큰이 없어 부르지 않은 행의 간격이 늘지 않게, BUILD_ORDER PRF-183)
   */
  rescheduleQuery(job: UnknownQueryJob, nextAtMs: number, o?: { readonly refundAttempt?: boolean }): Promise<boolean>;

  /** `status = 'UNKNOWN' AND anomaly_logged_at IS NULL` 조건으로 anomaly_logged_at = 지금을 쓴다. 이번에 썼으면 true(그때만 SEV1 로그를 낸다) */
  markAnomalyLogged(job: UnknownQueryJob): Promise<boolean>;

  /**
   * 잡기와 별개의 1시간 표시. 한 문장으로 `status = 'UNKNOWN' AND status_changed_at < 지금 − 1시간 AND overdue_at IS NULL`인 행을 `FOR UPDATE SKIP LOCKED`로 limit개까지 골라 overdue_at = 지금을 쓴다.
   * @returns 이번에 표시한 행의 주문 ID(행마다 로그·지표를 낸다)
   * @throws RangeError limit이 1 이상의 정수가 아님
   */
  markOverdueBatch(limit: number): Promise<string[]>;

  /**
   * 답 반영(명세 `query`). 한 트랜잭션: payment 행 FOR UPDATE → status가 UNKNOWN이 아니면 STALE
   * → 다음 순번으로 결과 사건(exported true), 그다음 순번으로 RESOLVED 사건(exported true)
   * → payment(status, status_changed_at = 지금, APPROVED는 approved_at, FAILED는 failure_category, pg_confirm_token 지움, next_query_at 비움)
   * → Outbox `trade.payments`(키 = 회차 ID, 결과 사건, RESOLVED 차례, 트랜잭션의 마지막 문장).
   */
  resolve(job: UnknownQueryJob, finish: ResolvedFinish): Promise<ResolveUnknownResult>;
}

/** UNKNOWN 해소의 로그(주문 ID·결제사·오류 코드만 싣는다. 결제 키·토큰·금액은 싣지 않는다). 던지지 않는다 */
export interface PaymentUnknownLog {
  /** 조회 답의 금액이 원장과 다르다(SEV1, kind payment-unknown-amount-mismatch). 결제마다 한 번이다 */
  amountMismatch(e: { readonly orderId: string }): void;
  /** 조회 답의 주문 ID가 원장과 다르다(SEV1, kind payment-unknown-order-mismatch). 결제마다 한 번이다 */
  orderMismatch(e: { readonly orderId: string }): void;
  /** 승인을 기록한 적 없는 결제를 결제사가 취소했다(SEV1, kind payment-unknown-cancelled-at-pg, csCase PAYMENT_UNKNOWN). 주문 ID만 싣고 결제마다 한 번이다 */
  cancelledAtPg(e: { readonly orderId: string }): void;
  /** UNKNOWN이 1시간 [가정] 넘었다(SEV2, kind payment-unknown-overdue, csCase PAYMENT_UNKNOWN). 주문 ID만 싣는다 */
  overdue(e: { readonly orderId: string }): void;
  /** 결제사 어댑터가 없다(파드당 1분에 경고 한 줄, 실행기가 조절한다) */
  noAdapter(e: { readonly pg: PgName }): void;
  /** 답 반영 쓰기가 실패했다(밀어 둔 간격 뒤 다시 조회한다) */
  writeFailed(e: { readonly orderId: string; readonly code: string }): void;
  /** 답을 쓰려니 원장이 UNKNOWN이 아니었다(경고 한 줄) */
  staleAnswer(e: { readonly orderId: string }): void;
  /** 실행기 안의 예상 못 한 오류(what = claim·gateway·call·anomaly·reschedule·overdue). 어댑터가 safeErrorCode만 싣는다 */
  runError(e: { readonly what: 'claim' | 'gateway' | 'call' | 'anomaly' | 'reschedule' | 'overdue'; readonly orderId?: string; readonly err: unknown }): void;
}

/** UNKNOWN 해소 지표(docs/observability.md, BUILD_ORDER PRF-182). 던지지 않는다 */
export interface PaymentUnknownSignals {
  /** payment_unknown_query_total{pg, outcome}를 1 올린다 */
  outcome(pg: PgName, outcome: PaymentUnknownQueryOutcome): void;
  /** payment_unknown_overdue_total을 1 올린다 */
  overdue(): void;
  /** payment_unknown_in_flight를 지금 돌고 있는 조회 수로 둔다 */
  inFlight(count: number): void;
  /** payment_unknown_write_failures_total을 1 올린다 */
  writeFailure(): void;
}

// ---- 결제사 호출 보호(BUILD_ORDER PRF-183, docs/features/payment.md §2 '결제사 호출 보호의 첫 구현') ----

/** 호출 보호 지표(docs/observability.md 같은 줄). 던지지 않는다 */
export interface PgCallGuardSignals {
  /** pg_throttled_total{pg, first}를 1 올린다 */
  throttled(pg: PgName, first: boolean): void;
  /** payment_pg_limit{pg, kind}를 둔다 */
  limit(pg: PgName, kind: PgLimitKind, value: number): void;
  /** payment_pg_inflight{pg}를 돌고 있는 승인 호출 수로 둔다 */
  inflight(pg: PgName, count: number): void;
  /** payment_pg_saturated_total{pg, reason}를 1 올린다 */
  saturated(pg: PgName, reason: PgSaturationReason): void;
}

/** 호출 보호의 로그(결제사와 낮춘 뒤 상한만 싣는다). 던지지 않는다 */
export interface PgCallGuardLog {
  /** 첫 승인 호출이 429를 받아 상한을 낮췄다(SEV2, kind pg-throttled-first) */
  throttledFirst(e: { readonly pg: PgName; readonly rps: number; readonly concurrency: number }): void;
}
