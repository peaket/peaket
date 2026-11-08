// 승인 명령 접수와 결과 조회의 포트(docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180).
import type { ConfirmPaymentCommand, PaymentRecord, PaymentState } from './confirm-command.js';

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
   * 결제 참조는 pg_payment_ref(토스 paymentKey·포트원 paymentId), 포트원 토큰은 pg_confirm_token에 적는다. idempotency_key = confirm-{orderId}.
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
