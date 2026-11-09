// 승인 명령 접수와 결과 조회의 포트(docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180).
import type { ConfirmPaymentCommand, GetPaymentKey, PaymentDetailRow, PaymentLedgerStatus, PaymentRecord, PaymentState } from './confirm-command.js';
import type { ConfirmFinish, ConfirmJob, ConfirmTarget, PaymentConfirmOutcome, PaymentEventMessage } from './confirm-runner.js';
import type { FailureCategory, PayMethod, PaymentGatewayPort, PgName, WebhookInvalidReason } from './payment-gateway.js';
import type { PaymentMethodRefMissingReason } from './payment-method-ref.js';
import type { PgSelectionState, PgSwitchRow, PgUnavailableReason } from './pg-selection.js';
import type { PgLimitKind, PgSaturationReason } from './pg-call-guard.js';
import type { DepositCancelBegin, DepositCancelTarget, DepositCancelOutcome } from './deposit-cancel.js';
import type { QueryStatus } from './payment-gateway.js';
import type { ReconDiffKind, ReconDiffState, ReconLedger, ReconRunRef, ReconRunStatus, ReconSeen, ReconStage } from './reconciliation.js';
import type { PaymentUnknownQueryOutcome, ResolvedFinish, UnknownQueryJob } from './unknown-resolver.js';
import type { VirtualAccountFieldReason } from './virtual-account.js';
import type { PaymentWebhookOutcome, WebhookDecision, WebhookRoute } from './webhook-receipt.js';

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

/** 결제사 선택 재료 읽기(BUILD_ORDER PRF-190) */
export interface PgSelectionReader {
  /**
   * 그 회차의 전환 행·플랫폼 전환 행·회차 지정 사본을 읽는다. 결제사는 부르지 않는다.
   * @throws PaymentDeadlineError 연결을 받고 보니 남은 시간이 MIN_CALL_REMAINING_MS보다 모자람(읽지 않는다)
   */
  read(eventId: string, budget?: CallBudget): Promise<PgSelectionState>;
}

/** 전환 쓰기(제어 수신 OPS-310과 재생 시험 PRF-210이 쓴다, BUILD_ORDER PRF-190) */
export interface PgSwitchStore {
  /** 판 번호가 지금보다 클 때만 쓴다. 썼으면 참, 옛 판이면 거짓이다 */
  applySwitch(row: PgSwitchRow): Promise<boolean>;
}

/** payment_checkout_prepared_total의 outcome */
export type PrepareCheckoutOutcome = 'ok' | 'switched' | 'invalid' | 'pg_unavailable' | 'method_unsupported' | 'error';

/** 결제창 준비 지표. 던지지 않는다 */
export interface PrepareCheckoutSignals {
  prepared(pg: PgName | 'none', outcome: PrepareCheckoutOutcome): void;
}

/** 결제창 준비 로그. 던지지 않는다 */
export interface PrepareCheckoutLog {
  /** 고른 결제사를 쓸 수 없다(SEV2, kind payment-pg-unavailable). 결제사·까닭마다 1분 [가정]에 한 번 불린다 */
  pgUnavailable(e: { readonly pg: PgName; readonly reason: Exclude<PgUnavailableReason, 'METHOD_UNSUPPORTED'>; readonly eventId: string }): void;
  /** 고른 결제사가 그 수단을 받지 않는다(결제사 장애가 아니라 경고 한 줄, kind payment-pg-method-unsupported). 결제사·수단마다 1분 [가정]에 한 번 불린다(BUILD_ORDER PRF-190 코드 리뷰) */
  methodUnsupported(e: { readonly pg: PgName; readonly payMethod: PayMethod; readonly eventId: string }): void;
}

/** GetPayment의 저장소(BUILD_ORDER HOT-151) */
export interface PaymentDetailReader {
  /**
   * 결제 ID나 주문 ID로 한 행을 읽는다(쓰기 인스턴스, 일반 풀, 문장 시간 한도 min(400ms [가정], 연결을 받은 뒤 budget에 남은 시간)). 없으면 undefined. 결제사는 부르지 않는다.
   * @throws PaymentDeadlineError 연결을 받고 보니 남은 시간이 MIN_CALL_REMAINING_MS보다 모자람(읽지 않는다)
   */
  getDetail(key: GetPaymentKey, budget?: CallBudget): Promise<PaymentDetailRow | undefined>;
}

/** payment_get_requests_total의 outcome */
export type GetPaymentOutcome = 'ok' | 'not_found' | 'invalid' | 'error';

/** GetPayment 지표. 던지지 않는다 */
export interface PaymentGetSignals {
  getPayment(outcome: GetPaymentOutcome): void;
}

/** 입금 대기 쓰기의 로그(주문 ID와 닫힌 까닭만 싣는다. 계좌번호·secret은 싣지 않는다). 던지지 않는다 */
export interface PaymentDepositLog {
  /** 입금 대기 답에 발급 정보나 기한이 없다(SEV2, kind payment-deposit-info-missing) */
  infoMissing(e: { readonly orderId: string }): void;
  /** 계좌번호를 저장하지 못했다(SEV2, kind payment-virtual-account-unsaved) */
  accountUnsaved(e: { readonly orderId: string; readonly reason: VirtualAccountFieldReason }): void;
  /** 저장한 계좌번호를 열지 못했다(SEV2, kind payment-virtual-account-unopened) */
  accountUnopened(e: { readonly orderId: string; readonly reason: VirtualAccountFieldReason }): void;
}

/** 입금 대기 쓰기의 지표. 던지지 않는다 */
export interface PaymentDepositSignals {
  /** payment_virtual_account_field_failures_total{op, reason}를 1 올린다 */
  fieldFailure(op: 'seal' | 'open', reason: VirtualAccountFieldReason): void;
  /** payment_deposit_cancel_total{outcome}를 1 올린다(BUILD_ORDER HOT-152) */
  cancel?(outcome: DepositCancelOutcome): void;
  /** 결제사가 준 입금 기한이 입장 시작 24시간 전을 넘어 잘랐다. payment_deposit_due_capped_total을 1 올린다(BUILD_ORDER PRF-190 코드 리뷰) */
  dueCapped?(): void;
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
   * countRetry가 참이면(결제사 답이 처리 중·한도 초과) attempts를 1 올린다. 어댑터 없음·서킷으로 미룰 때는 거짓이다.
   * queued가 참이면(서킷이 열려 미룸, BUILD_ORDER PRF-200) queued_at을 처음 한 번 지금으로 적는다.
   * clearSent가 참이면 같은 트랜잭션에서 CONFIRM_SENT 표시를 지운다(이번에 쓴 표시 뒤 서킷이 끊어 부르지 않았을 때, 코드 리뷰)
   */
  reschedule(job: ConfirmJob, nextAtMs: number, o: { readonly countRetry: boolean; readonly queued?: boolean; readonly clearSent?: boolean }): Promise<boolean>;

  /** 자기 임대 조건으로 명령 행을 지운다(원장이 ACCEPTED가 아닐 때). 임대를 잃었으면 false */
  dropJob(job: ConfirmJob): Promise<boolean>;

  /** 임대만 놓는다(lease_owner·lease_until 비움, 자기 임대 조건). 임대를 잃었으면 false */
  release(job: ConfirmJob): Promise<boolean>;
}

/** 승인의 경로(BUILD_ORDER PRF-200): direct 재시도 큐를 거치지 않음, retry_queue 여유 부족으로 미뤄진 적이 있음 */
export type ConfirmPath = 'direct' | 'retry_queue';

/** 결제 확정 소요(접수부터 승인 결과가 정해질 때까지, payment_confirm_resolution_seconds{pg, path}, docs/observability.md). 던지지 않는다 */
export interface PaymentResolutionSignals {
  resolutionSeconds(pg: PgName, path: ConfirmPath, seconds: number): void;
}

/** 결제 수단 연결값의 invRef 계산(라벨 키 pay, BUILD_ORDER HOT-145). 값은 로그에 싣지 않는다. 던지지 않는다 */
export interface PaymentMethodRefs {
  /** invRef("pay", 값). 라벨 키가 없으면 undefined */
  ref(value: string): string | undefined;
}

/** 결제 수단 연결값 지표(inv_ref_missing_total{service, label, reason}). 던지지 않는다 */
export interface PaymentMethodRefSignals {
  /** 계산하지 못한 까닭을 1 올린다 */
  missing(reason: PaymentMethodRefMissingReason): void;
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

/** resolve 결과: APPLIED 원장·사건·Outbox를 커밋했다, STALE 원장이 잡을 때의 상태(UNKNOWN·입금 대기)가 아니라 아무것도 쓰지 않았다 */
export type ResolveUnknownResult = 'APPLIED' | 'STALE';

/** 단독 조회 저장소(UNKNOWN과 입금 대기 행, BUILD_ORDER PRF-182·HOT-151. 모든 쓰기는 READ COMMITTED, 문장 시간 한도 CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS) */
export interface PaymentUnknownQueries {
  /**
   * 짧은 트랜잭션 하나에서 그 결제사의 `(status IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR (status IN ('FAILED', 'APPROVED') AND next_query_at IS NOT NULL)) AND next_query_at <= 지금`인 행을 `FOR UPDATE SKIP LOCKED`로 limit개 고르고(next_query_at 차례. FAILED 행은 늦은 입금 확인 한 번이다),
   * 행마다 next_query_at = 지금 + unknownQueryClaimHoldMs(query_attempts + 1), query_attempts + 1, query_touched_at = 지금을 쓴 뒤 커밋한다. 고른 차례로 돌려준다.
   * @throws RangeError limit이 1 이상의 정수가 아님
   */
  claimDueQueries(pg: PgName, limit: number): Promise<UnknownQueryJob[]>;

  /** 그 채널에 지금 조회할 행이 있는가(토큰이 없는 틱에서 상한에 막혔는지 가린다) */
  hasDueQueries(pg: PgName): Promise<boolean>;

  /**
   * 답을 본 뒤 그대로 둘 때의 다음 조회 시각을 쓴다. 조건은 `status = 잡을 때의 상태 AND next_query_at = 이 잡기가 쓴 값`이다(늦은 답이 다른 파드의 잡기를 덮어쓰지 않는다). 썼으면 true.
   * refundAttempt가 참이면 잡을 때 올린 query_attempts를 1 되돌린다(토큰이 없어 부르지 않은 행의 간격이 늘지 않게, BUILD_ORDER PRF-183).
   * resetAttempts가 참이면 query_attempts를 0으로 둔다(입금 대기가 그대로라는 답, BUILD_ORDER HOT-151).
   */
  rescheduleQuery(job: UnknownQueryJob, nextAtMs: number, o?: { readonly refundAttempt?: boolean; readonly resetAttempts?: boolean }): Promise<boolean>;

  /** `status = 잡을 때의 상태 AND anomaly_logged_at IS NULL` 조건으로 anomaly_logged_at = 지금을 쓴다. 이번에 썼으면 true(그때만 SEV1 로그를 낸다) */
  markAnomalyLogged(job: UnknownQueryJob): Promise<boolean>;

  /** 입금 오류 확인이 1시간 [가정]을 넘겼다: `status = 'APPROVED' AND overdue_at IS NULL` 조건으로 overdue_at = 지금을 쓴다. 이번에 썼으면 true(그때만 SEV1 로그를 낸다, BUILD_ORDER HOT-152 코드 리뷰) */
  markReversalOverdue(job: UnknownQueryJob): Promise<boolean>;

  /** 입금 오류 확인을 끝낸다: `status = 'APPROVED' AND next_query_at = 이 잡기가 쓴 값` 조건으로 next_query_at·deposit_notified_at을 비운다. 이번에 썼으면 true(BUILD_ORDER HOT-152) */
  finishReversalCheck(job: UnknownQueryJob): Promise<boolean>;

  /**
   * 입금 오류 되돌림 한 트랜잭션: payment 행 FOR UPDATE → 'APPROVED'가 아니면 STALE → 다음 순번으로 DEPOSIT_REVERSED 수출 사건 → 원장 AWAITING_DEPOSIT(approved_at 비움, 가상계좌 칸, next_query_at = 새 기한 + 10분) → Outbox `trade.payments`(마지막 문장, BUILD_ORDER HOT-152).
   */
  reverseDeposit(job: UnknownQueryJob, finish: Extract<ConfirmFinish, { status: 'AWAITING_DEPOSIT' }>): Promise<ResolveUnknownResult>;

  /**
   * 입금을 되돌렸는데 입장이 2시간 [가정] 안이라 다시 입금할 수 없다(BUILD_ORDER PRF-190 코드 리뷰). 한 트랜잭션: payment 행 FOR UPDATE → 'APPROVED'가 아니면 STALE → DEPOSIT_REVERSED 사건(T21) → 다음 순번으로 FAILED 사건(T17) → 원장 FAILED(가상계좌 칸·next_query_at 비움) → Outbox `trade.payments` 두 행을 그 차례로(마지막 문장).
   */
  closeReversedDeposit(job: UnknownQueryJob, reversed: Extract<ConfirmFinish, { status: 'AWAITING_DEPOSIT' }>, failed: Extract<ConfirmFinish, { status: 'FAILED' }>): Promise<ResolveUnknownResult>;

  /** 늦은 입금 확인을 끝낸다: `status = 'FAILED' AND next_query_at = 이 잡기가 쓴 값` 조건으로 next_query_at을 비운다. 이번에 썼으면 true(그때만 SEV1 로그를 낸다, 원장의 다른 칸은 바꾸지 않는다) */
  finishLateDepositCheck(job: UnknownQueryJob): Promise<boolean>;

  /**
   * 잡기와 별개의 1시간 표시. 한 문장으로 `status = 'UNKNOWN' AND status_changed_at < 지금 − 1시간 AND overdue_at IS NULL`인 행을 `FOR UPDATE SKIP LOCKED`로 limit개까지 골라 overdue_at = 지금을 쓴다.
   * @returns 이번에 표시한 행의 주문 ID(행마다 로그·지표를 낸다)
   * @throws RangeError limit이 1 이상의 정수가 아님
   */
  markOverdueBatch(limit: number): Promise<string[]>;

  /**
   * 답 반영(명세 `query`). 한 트랜잭션: payment 행 FOR UPDATE → status가 잡을 때의 상태가 아니면 STALE
   * → 다음 순번으로 결과 사건(exported true), UNKNOWN을 떠날 때만 그다음 순번으로 RESOLVED 사건(exported true. 입금 대기의 T16·T17은 내지 않는다)
   * → payment(status, status_changed_at = 지금, APPROVED는 approved_at, FAILED는 failure_category, pg_confirm_token 지움, next_query_at 비움. 입금 대기를 쓰면 가상계좌 칸과 입금 기한 + 10분의 next_query_at, 그 밖은 가상계좌 칸을 지운다)
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
  /** FAILED로 끝난 결제에 입금이 확인됐다(SEV1, kind payment-late-deposit, csCase PAYMENT_LATE_DEPOSIT). 주문 ID만 싣고 결제마다 한 번이다 */
  lateDeposit(e: { readonly orderId: string }): void;
  /** UNKNOWN이 1시간 [가정] 넘었다(SEV2, kind payment-unknown-overdue, csCase PAYMENT_UNKNOWN). 주문 ID만 싣는다 */
  overdue(e: { readonly orderId: string }): void;
  /** 결제사 어댑터가 없다(파드당 1분에 경고 한 줄, 실행기가 조절한다) */
  noAdapter(e: { readonly pg: PgName }): void;
  /** 답 반영 쓰기가 실패했다(밀어 둔 간격 뒤 다시 조회한다) */
  writeFailed(e: { readonly orderId: string; readonly code: string }): void;
  /** 답을 쓰려니 원장이 UNKNOWN이 아니었다(경고 한 줄) */
  staleAnswer(e: { readonly orderId: string }): void;
  /** 결제사 입금 오류를 확인해 입금 대기로 되돌렸다(kind payment-deposit-reversed, 주문 ID만, BUILD_ORDER HOT-152) */
  depositReversed(e: { readonly orderId: string }): void;
  /** 통보 뒤 10분 [가정]이 지나도 결제사가 입금 완료라고 답했다(지연된 통보로 끝낸다. kind payment-deposit-reversal-unconfirmed, 주문 ID만) */
  reversalUnconfirmed(e: { readonly orderId: string }): void;
  /** 통보 뒤 1시간 [가정]이 지나도 조회로 되돌림을 확인하지 못했다(SEV1, kind payment-deposit-reversal-overdue, 주문 ID만, BUILD_ORDER HOT-152 코드 리뷰) */
  reversalOverdue(e: { readonly orderId: string }): void;
  /** 입금을 되돌렸는데 입장이 2시간 [가정] 안이라 재입금 없이 실패로 끝냈다(SEV2, kind payment-deposit-reversal-no-time, csCase PAYMENT_DEPOSIT_REVERSED, 주문 ID만, BUILD_ORDER PRF-190 코드 리뷰) */
  reversalNoTime(e: { readonly orderId: string }): void;
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

// ---- 일일 대사(BUILD_ORDER HOT-153, docs/features/payment.md §8 '대사의 첫 구현') ----

/** 대사 실행 표 한 행(시작·이어 하기) */
export interface ReconRun {
  readonly id: string;
  readonly pg: PgName;
  /** 대상 날짜(KST) */
  readonly date: string;
  /** 이 실행의 세대. 시작(beginRun)마다 1 오르고 쓰기·작업 표 읽기의 조건이다(BUILD_ORDER HOT-153 코드 리뷰 H1) */
  readonly generation: number;
  readonly stage: ReconStage;
  readonly pgCursor?: string;
  readonly compareAfter?: string;
  readonly ledgerAfter?: { readonly atMs: number; readonly id: string };
  readonly listedCount: number;
  readonly matchedCount: number;
  readonly mismatchCount: number;
}

/** 맞추기 묶음 한 줄 */
export interface ReconCompareRow extends ReconSeen {
  readonly ledger?: ReconLedger;
}

/** 원장 쪽 묶음 한 줄 */
export interface ReconLedgerRow extends ReconLedger {
  readonly approvedAtMs: number;
  /** 작업 표에 결제사 기록이 있다(불일치가 아니다). 승인 행을 먼저 잘라 읽으므로 묶음에 함께 온다(BUILD_ORDER HOT-153 코드 리뷰 M12) */
  readonly seen?: boolean;
}

/** reconciliation_diff 한 행의 입력 */
export interface ReconDiffInput {
  readonly pg: PgName;
  readonly orderRef: string;
  readonly paymentRef: string;
  readonly kind: ReconDiffKind;
  readonly state: ReconDiffState;
  readonly ledgerStatus?: PaymentLedgerStatus;
  readonly pgStatus?: QueryStatus;
  readonly ledgerAmount?: number;
  readonly pgAmount?: number;
}

/**
 * 대사 저장소(모든 문장이 READ COMMITTED 트랜잭션이고 문장 시간 한도 CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS, BUILD_ORDER HOT-153 코드 리뷰 M12).
 * 실행의 쓰기는 세대를 조건으로 한다(H1): 세대가 다르면 ReconRunLostError를 던지고, 작업 표 읽기는 빈 답이다(지운 작업 표로 판단하지 않게).
 */
export interface PaymentReconciliationStore {
  /** 되돌아보는 기간 안의 실행 행을 읽는다(DONE 포함) */
  pendingDates(pg: PgName, fromDate: string): Promise<ReconRunRef[]>;
  /** fromDate 앞의 날짜 가운데 DONE이 아닌 날과 행이 없는 날(그 결제사의 첫 실행 뒤)을 오래된 차례로 31개까지 돌려준다(H4) */
  overdueDates(pg: PgName, fromDate: string): Promise<string[]>;
  /**
   * 그 날짜의 실행을 시작하거나 이어 간다(`status <> 'DONE'`이면 RUNNING으로 되돌리고 소유자를 쓰고 세대를 1 올린다). 이미 DONE이면 undefined.
   * @returns 저장된 단계·커서와 새 세대
   */
  beginRun(pg: PgName, date: string, nowMs: number, owner: string): Promise<ReconRun | undefined>;
  /**
   * 받기 묶음 한 트랜잭션: 세대 조건으로 커서·건수 쓰기(nextCursor가 없으면 단계 COMPARING, mismatched는 못 읽는 줄 수) → 작업 표 쓰기(결제 참조마다 대상 날짜 안의 줄을 앞세우고 같은 쪽이면 더 늦은 거래를 남긴다, M9).
   * @throws ReconRunLostError 세대가 다르다(아무것도 쓰지 않는다)
   */
  saveListedPage(run: ReconRun, items: readonly ReconSeenInput[], nextCursor: string | undefined, listed: number, mismatched?: number): Promise<void>;
  /** 맞추기 묶음을 읽는다(결제 참조 차례, 대상 날짜 범위 안의 거래만). 결제 참조가 같은 원장은 결제사가 같은 행을 먼저 고른다. 세대가 다르면 빈 답이다 */
  readCompareBatch(run: ReconRun, limit: number): Promise<ReconCompareRow[]>;
  /** 원장의 지금 상태를 읽는다(닫기가 STALE일 때 다시 본다, M7). 없으면 undefined */
  ledgerStatus(paymentId: string): Promise<PaymentLedgerStatus | undefined>;
  /** 불일치 기록 쓰기(UNIQUE 충돌은 건너뛴다). 이번에 쓴 행을 돌려준다(그 건만 SEV1을 낸다) */
  insertDiffs(run: ReconRun, diffs: readonly ReconDiffInput[]): Promise<ReconDiffInput[]>;
  /** next_query_at = 지금(UNKNOWN·AWAITING_DEPOSIT 행, 더 이른 시각은 건드리지 않는다). 쓴 행 수 */
  handOff(paymentIds: readonly string[], nowMs: number): Promise<number>;
  /** 닫은 전액 취소 건의 처리 상태를 CLOSED로 쓴다 */
  markClosed(pg: PgName, paymentRef: string, kind: ReconDiffKind): Promise<void>;
  /**
   * 맞추기 묶음 끝내기: 건수와 커서 쓰기(afterRef가 없으면 단계 LEDGER).
   * @throws ReconRunLostError 세대가 다르다
   */
  finishCompareBatch(run: ReconRun, afterRef: string | undefined, matched: number, mismatched: number): Promise<void>;
  /** 원장 쪽 묶음을 읽는다: 대상 날짜의 승인 행을 승인 시각·ID 차례로 limit개 잘라 읽고(M12) 행마다 작업 표에 있는지(seen)를 싣는다. 세대가 다르면 빈 답이다 */
  readLedgerBatch(run: ReconRun, limit: number): Promise<ReconLedgerRow[]>;
  /**
   * 원장 쪽 묶음 끝내기: 건수와 커서 쓰기(after가 없으면 단계 PULLING).
   * @throws ReconRunLostError 세대가 다르다
   */
  finishLedgerBatch(run: ReconRun, after: { readonly atMs: number; readonly id: string } | undefined, mismatched: number): Promise<void>;
  /** 그 결제사의 UNKNOWN 행 가운데 nowMs 앞에 건드리지 않은 행을 limit개까지 골라 다음 조회를 nowMs로 당긴다(§4.2 14번, M10. nowMs를 묶음마다 같은 값으로 주면 한 행을 두 번 당기지 않는다). 쓴 행 수 */
  pullUnknowns(pg: PgName, beforeMs: number, nowMs: number, limit: number): Promise<number>;
  /**
   * 실행을 끝낸다.
   * @throws ReconRunLostError 세대가 다르다
   */
  finishRun(run: ReconRun, status: Exclude<ReconRunStatus, 'RUNNING'>, nowMs: number): Promise<void>;
  /** 작업 표의 그 실행 행을 나눠 지운다 */
  clearSeen(run: ReconRun): Promise<number>;
}

/** 작업 표 reconciliation_seen의 입력(받기 단계) */
export interface ReconSeenInput {
  readonly paymentRef: string;
  readonly orderRef: string;
  readonly pgStatus: QueryStatus;
  readonly amount: number;
  readonly atMs: number;
}

/** 대사 로그(주문 ID·결제사·종류만 싣는다. 금액·결제 키는 싣지 않는다). 던지지 않는다 */
export interface PaymentReconciliationLog {
  /** 불일치(SEV1, 건마다 한 줄, kind payment-reconciliation-mismatch). csCase는 늦은 입금에만 있다 */
  mismatch(e: { readonly pg: PgName; readonly diffKind: ReconDiffKind; readonly orderId?: string; readonly csCase?: 'PAYMENT_LATE_DEPOSIT' }): void;
  /** 실행 실패(SEV2, kind payment-reconciliation-failed) */
  failed(e: { readonly pg: PgName; readonly date: string; readonly code: string }): void;
  /** 실행 끝(kind payment-reconciliation-done) */
  done(e: { readonly pg: PgName; readonly date: string; readonly listed: number; readonly matched: number; readonly mismatched: number; readonly seconds: number; readonly perSecond: number }): void;
  /** 온세일 일정을 읽지 못했다(일정 없음으로 본다, kind payment-reconciliation-calendar) */
  calendarUnavailable(e: { readonly code: string }): void;
  /** 되돌아보는 기간 앞에 끝내지 못한 날이 있다(SEV2, 결제사마다 실행에 한 줄, kind payment-reconciliation-overdue) */
  overdue(e: { readonly pg: PgName; readonly count: number; readonly oldest: string }): void;
  /** 다른 실행이 세대를 올려 이 실행을 멈췄다(kind payment-reconciliation-run-lost) */
  runLost(e: { readonly pg: PgName; readonly date: string }): void;
  /** 다시 확인 조회가 '없음'이라고 답해 그 줄을 판단하지 않았다(kind payment-reconciliation-recheck-missing, 주문 ID만) */
  recheckMissing(e: { readonly pg: PgName; readonly orderId: string }): void;
  /** SEV1 상한을 넘겨 건마다 내지 못한 수(SEV1, 실행에 한 줄, kind payment-reconciliation-mismatch-suppressed) */
  mismatchSuppressed(e: { readonly pg: PgName; readonly date: string; readonly suppressed: number }): void;
}

/** 대사 지표. 던지지 않는다 */
export interface PaymentReconciliationSignals {
  /** payment_reconciliation_runs_total{pg, result} */
  run(pg: PgName, result: 'done' | 'failed'): void;
  /** payment_reconciliation_last_transactions·last_mismatches·last_duration_seconds·last_throughput_per_second{pg} */
  lastRun(pg: PgName, v: { readonly transactions: number; readonly mismatches: number; readonly seconds: number; readonly perSecond: number }): void;
  /** payment_reconciliation_mismatches_total{pg, kind} */
  mismatch(pg: PgName, kind: ReconDiffKind): void;
  /** payment_reconciliation_overdue_dates{pg}를 그 수로 둔다 */
  overdueDates(pg: PgName, count: number): void;
}

/** 대형·중형 온세일 윈도우(T-10분~T+60분) 안인가. 일정을 읽지 못하면 던진다(부르는 쪽이 일정 없음으로 본다) */
export interface OnSaleCalendar {
  active(nowMs: number): Promise<boolean>;
}

// ---- 입금 전 취소(BUILD_ORDER HOT-152, docs/features/payment.md §6 '입금 전 취소와 입금 오류 되돌림의 첫 구현') ----

/** 입금 전 취소의 저장소(READ COMMITTED, 문장 시간 한도 min(CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS, budget의 남은 시간)) */
export interface PaymentDepositCancels {
  /** 원장 행을 읽는다. 없으면 undefined */
  readCancelTarget(paymentId: string, budget?: CallBudget): Promise<DepositCancelTarget | undefined>;
  /** 답 반영이 STALE일 때 원장의 지금 상태를 다시 읽는다. 없으면 undefined(BUILD_ORDER HOT-152 코드 리뷰) */
  readCancelStatus(paymentId: string, budget?: CallBudget): Promise<PaymentLedgerStatus | undefined>;
  /**
   * 한 트랜잭션: payment 행 FOR UPDATE → 상태 확인 → 이 취소 ID의 내부 표시(DEPOSIT_CANCEL_SENT)가 없으면 쓴다.
   * BEGUN 처음이거나 이어서 부른다, DONE 그 취소 ID로 이미 FAILED로 끝났다, NOT_WAITING 그 밖의 상태다
   */
  beginDepositCancel(target: DepositCancelTarget, cancellationId: string, budget?: CallBudget): Promise<DepositCancelBegin>;
  /** 답 반영 한 트랜잭션: payment 행 FOR UPDATE → AWAITING_DEPOSIT이 아니면 STALE → 수출 사건 FAILED(DEPOSIT_CANCELED) → 원장 FAILED → Outbox(마지막 문장) */
  finishDepositCancel(target: DepositCancelTarget, budget?: CallBudget): Promise<ResolveUnknownResult>;
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

// ---- 웹훅 받기(BUILD_ORDER HOT-150, docs/features/payment.md §5 '웹훅 받기의 첫 구현') ----

/** 수신 기록과 조회 신호의 입력. 본문의 상태·금액은 받지 않는다 */
export interface WebhookReceiveRequest {
  /** 수신 기록의 결제사(본문을 읽은 어댑터) */
  readonly pg: PgName;
  readonly dedupKey: string;
  readonly paymentRef?: string;
  readonly orderRef?: string;
  /** 그 경로로 받는 결제사 */
  readonly allowedPgs: readonly PgName[];
  /** 서명으로 보낸 쪽을 확인한 경로인가. 거짓이면 원장을 못 찾은 웹훅의 수신 기록을 쓰지 않는다 */
  readonly signed: boolean;
  /** 토스 입금 통보의 secret을 해시한 값(BUILD_ORDER HOT-151). 있으면 대조를 지난 뒤에만 수신 기록을 쓴다 */
  readonly depositSecretHash?: Uint8Array;
  /** 결제사가 입금 완료를 알렸다(토스 입금 통보 DONE, 포트원 Transaction.Paid). 조회 간격과 끝난 원장의 늦은 입금 확인에만 쓴다 */
  readonly depositDone?: boolean;
  /** 결제사가 입금 완료를 되돌렸다고 알렸다(토스 입금 통보 WAITING_FOR_DEPOSIT, 포트원 Transaction.VirtualAccountIssued, BUILD_ORDER HOT-152). 승인 원장의 되돌림 확인에만 쓴다 */
  readonly depositReversed?: boolean;
  /** 지금(epoch ms). received_at과 next_query_at */
  readonly nowMs: number;
}

/** DUPLICATE: 같은 키의 수신 기록이 이미 있어 아무것도 쓰지 않았다. QUERY_SIGNAL_SKIPPED: 수신 기록은 썼지만 조회 시각을 당긴 행이 없다(최소 간격 안, 이미 더 이름, UNKNOWN을 떠남). 그 밖은 원장을 본 판단이다 */
export type WebhookReceiveResult = { readonly kind: 'DUPLICATE' } | { readonly kind: 'QUERY_SIGNAL_SKIPPED' } | WebhookDecision;

export interface PaymentWebhookStore {
  /**
   * 한 트랜잭션(READ COMMITTED, 문장 시간 한도 WEBHOOK_STATEMENT_TIMEOUT_MS, 문장 셋): 원장 찾기 한 문장(주문 참조가 UUID 모양이면 order_id를 먼저, 다음 결제 참조로 결제사 셋 모두, 경로가 받는 결제사의 행을 먼저)
   * 입금 통보(depositSecretHash가 있음)는 decideDepositCallback이고 secret 대조를 지난 뒤에만 수신 기록을 쓴다.
   * → decideWebhookLedger → 수신 기록 `INSERT … ON CONFLICT (pg, dedup_key) DO NOTHING`(0행이면 DUPLICATE. 서명 없는 경로에서 원장을 못 찾으면 쓰지 않고 LEDGER_NOT_FOUND)
   * → QUERY_SIGNAL이면 `next_query_at = 지금`(status IN ('UNKNOWN', 'AWAITING_DEPOSIT') AND next_query_at > 지금 AND 직전 신호·잡기로부터 WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS가 지남 조건, 0행이면 QUERY_SIGNAL_SKIPPED).
   * 보낸 쪽을 확인한(수신 기록을 쓴) 입금 대기의 입금 완료 통보는 deposit_notified_at을 처음 한 번 쓰고 next_query_at = least(지금 값, greatest(지금, 직전 신호·잡기 + 5초))다(지금으로 못 당겼으면 QUERY_SIGNAL_SKIPPED).
   * LATE_DEPOSIT_CHECK면 status = 'FAILED' AND deposit_notified_at IS NULL 조건으로 next_query_at·deposit_notified_at = 지금을 쓴다(0행이면 STATE_IGNORED).
   * REVERSAL_CHECK면 status = 'APPROVED' 조건으로 deposit_notified_at을 처음 한 번 쓰고 next_query_at = least(지금 값, greatest(지금, 직전 신호·잡기 + 5초))다(지금으로 못 당겼으면 QUERY_SIGNAL_SKIPPED, BUILD_ORDER HOT-152).
   * 원장을 찾지 못했거나 PG_MISMATCH면 수신 기록의 payment_id는 비운다.
   */
  receive(request: WebhookReceiveRequest): Promise<WebhookReceiveResult>;
}

/** 웹훅 거절의 까닭(어댑터의 까닭과 받는 쪽의 까닭) */
export type WebhookRejectReason = WebhookInvalidReason | 'NO_ADAPTER';

/** 웹훅 받기의 로그(경로·결제사·닫힌 까닭·코드와 어긋남의 주문 ID만 싣는다. 본문·머리 값·입금 secret은 싣지 않는다). 던지지 않는다 */
export interface PaymentWebhookLog {
  /** 거절했다(kind payment-webhook-invalid) */
  invalid(e: { readonly route: WebhookRoute; readonly pg: PgName; readonly reason: WebhookRejectReason }): void;
  /** 경로의 결제사와 원장의 결제사가 다르다(SEV2, kind payment-webhook-pg-mismatch) */
  pgMismatch(e: { readonly route: WebhookRoute; readonly pg: PgName; readonly ledgerPg: PgName; readonly orderId: string }): void;
  /** 수신 기록을 쓰지 못했다(kind payment-webhook-store-failed, 코드만) */
  storeFailed(e: { readonly route: WebhookRoute; readonly pg: PgName; readonly code: string }): void;
  /** 토스 입금 통보의 secret이 원장과 다르다(SEV3, kind payment-webhook-deposit-secret-mismatch, 경로·결제사·주문 ID만, BUILD_ORDER HOT-151) */
  depositSecretMismatch(e: { readonly route: WebhookRoute; readonly pg: PgName; readonly orderId: string }): void;
}

/** 웹훅 받기 지표(docs/observability.md). 던지지 않는다 */
export interface PaymentWebhookSignals {
  /** payment_webhook_received_total{pg, outcome}를 1 올린다 */
  outcome(pg: PgName, outcome: PaymentWebhookOutcome): void;
}
