// 지연 환급 계좌 다시 받기(BAT-425 GAT-130, ADR-0316 결정 4, openapi POST /v1/cancellations/{cancellationId}/account).
// 결제자 본인·REFUND_PENDING·refund_account_required_at 있음·refund_attempt < 3 [가정]일 때만 받는다. 재인증 op REFUND_ACCOUNT·act FAN_HIGH_RISK.
// 차례: 본인·상태 확인 → 재인증(모든 확인 뒤에만 jti를 잡는다) → 행 잠금 안에서 시도 1 올리고 커밋 → 결제사 취소(새 멱등키 cancel-{id}-a{n}) → 답 반영.
// 계좌는 이 호출 안에서만 쓰고 저장·로그·사건·Outbox·지표 어디에도 남기지 않는다(POL-014).
import { refundAccountShape } from '@peaket/validation/refund-account';
import {
  RefundAccountAttemptsExceeded,
  RefundAccountNotPending,
  RefundAccountNotFound,
  RefundAccountRejected,
  RefundAccountRequiredAgain,
  ReauthRequired,
  REFUND_ACCOUNT_MAX_ATTEMPTS,
  type CancellationRecord,
  type RefundAccount,
  type RequestRefundAccountResult,
} from '../domain/cancellation.js';
import { ReauthUnavailable, type CancellationOrders, type PaymentCancellations, type ReauthGate, type RefundAccountWrites } from '../domain/ports.js';

/** 결제사 취소 한 번의 기한 5초 [가정](기존 CancellationWrites·payment 호출과 같은 값) */
const CANCEL_DEADLINE_MS = 5_000;
/** 결과 모름 뒤 다시 볼 시각 1분 [가정](openapi createCancellationAccount 202 설명) */
export const REFUND_ACCOUNT_RETRY_DELAY_MS = 60_000;

/** 계좌 모양이 틀렸다(400 invalid-body). 재인증 확인·행 쓰기·payment 호출 0 */
export class InvalidRefundAccount extends Error {
  constructor(message = '환불 계좌 모양이 올바르지 않습니다') {
    super(message);
    this.name = 'InvalidRefundAccount';
  }
}

export interface RequestRefundAccountInput {
  readonly accountId: string;
  readonly cancellationId: string;
  readonly account: RefundAccount;
  readonly reauthToken: string | undefined;
  /** HTTP @Idempotent의 키. 같은 키의 다시 보냄은 시도를 올리지 않고 처음 답을 준다(플랫폼 멱등 모듈) */
  readonly idempotencyKey: string;
  /** 재인증 토큰의 sid와 견줄 로그인 세션. HTTP 처리기가 넘긴다 */
  readonly sessionId?: string;
  readonly nowMs?: number;
}

export interface RequestRefundAccountDeps {
  readonly orders: CancellationOrders;
  readonly writes: RefundAccountWrites;
  readonly payments: PaymentCancellations;
  /** 없으면 재인증을 확인하지 않는다(단위 대역). 운영 조립은 늘 꽂는다 */
  readonly reauth?: ReauthGate;
  readonly nowMs?: () => number;
  /** purchase_refund_account_total{result}: accepted·refunded·pending·rejected·invalid */
  readonly signals?: { readonly inc: (result: 'accepted' | 'refunded' | 'pending' | 'rejected' | 'invalid') => void };
}

export class RequestRefundAccount {
  constructor(private readonly o: RequestRefundAccountDeps) {}

  async run(i: RequestRefundAccountInput): Promise<RequestRefundAccountResult> {
    if (!refundAccountShape(i.account).ok) {
      this.o.signals?.inc('invalid');
      throw new InvalidRefundAccount();
    }
    const record = await this.o.orders.findCancellation(i.cancellationId);
    if (!record) throw new RefundAccountNotFound();
    // 주문·결제자를 읽는다. 남의 취소와 없는 취소는 같은 404다(authz-matrix §3.2)
    const order = await this.o.orders.findByTicket(record.ticketId);
    if (!order || order.payerAccountId !== i.accountId) throw new RefundAccountNotFound();
    this.#assertPending(record);
    const oldAttempt = record.refundAttempt ?? 0;
    if (oldAttempt >= REFUND_ACCOUNT_MAX_ATTEMPTS) throw new RefundAccountAttemptsExceeded();
    // 재인증은 상태 확인 뒤에 본다(계좌 대기가 아닌 건에 토큰을 쓰지 않는다). 막히면 행 쓰기·payment 0이다
    if (this.o.reauth) {
      let passed: boolean;
      try {
        passed = await this.o.reauth.verify(i.reauthToken, {
          accountId: i.accountId,
          sessionId: i.sessionId ?? '',
          act: 'FAN_HIGH_RISK',
          op: 'REFUND_ACCOUNT',
        });
      } catch (e) {
        if (e instanceof ReauthUnavailable) throw e;
        throw e;
      }
      if (!passed) throw new ReauthRequired();
    }
    const nowMs = i.nowMs ?? this.o.nowMs?.() ?? Date.now();
    // 행 잠금 안에서 시도를 1 올리고 커밋한다(결제사를 트랜잭션 안에서 부르지 않는다, ASVS 2.3.3).
    // 그사이 다른 요청이 시도를 올렸으면 0행이라 둘 다 올리지 않는다(R-T42 ④)
    const attempt = await this.o.writes.beginAttempt({ cancellationId: i.cancellationId, oldAttempt, nowMs });
    if (!attempt) {
      const again = await this.o.orders.findCancellation(i.cancellationId);
      if (!again) throw new RefundAccountNotFound();
      this.#assertPending(again);
      if ((again.refundAttempt ?? 0) >= REFUND_ACCOUNT_MAX_ATTEMPTS) throw new RefundAccountAttemptsExceeded();
      throw new RefundAccountNotPending('다른 요청이 먼저 환급 계좌를 받았습니다');
    }
    this.o.signals?.inc('accepted');
    const payment = await this.o.payments.cancel({
      cancellationId: i.cancellationId,
      orderId: attempt.orderId,
      amount: attempt.refundAmount,
      reason: attempt.reason,
      refundAccount: i.account,
      refundAttempt: attempt.attempt,
      deadlineMs: CANCEL_DEADLINE_MS,
    });
    if (payment === 'CANCELLED') {
      await this.o.writes.updateStatus({ cancellationId: i.cancellationId, status: 'REFUNDED', nowMs });
      this.o.signals?.inc('refunded');
      return { cancellationId: i.cancellationId, status: 'REFUNDED', refundAmount: attempt.refundAmount };
    }
    if (payment === 'REFUND_ACCOUNT_REQUIRED') {
      // 계좌 대기 유지: 표시를 지우지 않고 다음 재시도 시각도 비운다. 팬은 다른 계좌로 새 시도를 낼 수 있다
      this.o.signals?.inc('rejected');
      throw new RefundAccountRequiredAgain();
    }
    if (payment === 'REJECTED') {
      await this.o.writes.clearWaiting({ cancellationId: i.cancellationId, nowMs, lastError: 'REJECTED' });
      await this.o.writes.markFailed({ cancellationId: i.cancellationId, attempts: attempt.retryAttempts + 1, lastError: 'REJECTED', nowMs });
      this.o.signals?.inc('rejected');
      throw new RefundAccountRejected();
    }
    // PENDING·UNKNOWN: 계좌 대기 표시를 지우고 1분 [가정] 뒤 다시 본다. 같은 시도의 재시도는 같은 멱등키를 쓴다
    await this.o.writes.clearWaiting({ cancellationId: i.cancellationId, nextRefundAtMs: nowMs + REFUND_ACCOUNT_RETRY_DELAY_MS, lastError: payment, nowMs });
    this.o.signals?.inc('pending');
    return { cancellationId: i.cancellationId, status: 'REFUND_PENDING', refundAmount: attempt.refundAmount };
  }

  #assertPending(record: CancellationRecord): void {
    if (record.state !== 'REFUND_PENDING' || record.refundAccountRequired !== true) throw new RefundAccountNotPending();
  }
}
