// 지연 환급 계좌 다시 받기(BAT-425 GAT-130, ADR-0316 결정 4, openapi POST /v1/cancellations/{cancellationId}/account).
// 결제자 본인·REFUND_PENDING·refund_account_required_at 있음·refund_attempt < 3 [가정]일 때만 받는다. 재인증 op REFUND_ACCOUNT·act FAN_HIGH_RISK.
// 차례: 본인·상태 확인 → 재인증(모든 확인 뒤에만 jti를 잡는다) → 행 잠금 안에서 시도 1 올리고 커밋 → 결제사 취소(새 멱등키 cancel-{id}-a{n}) → 답 반영.
// 계좌는 이 호출 안에서만 쓰고 저장·로그·사건·Outbox·지표 어디에도 남기지 않는다(POL-014).
import { createHash, timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused } from '@peaket/platform';
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
  type RefundAccountAnswer,
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
  /** @Idempotent가 만든 요청 지문(플랫폼 IdempotencyStore). 없으면 계정·취소·키로 만든 값을 쓴다(단위·통합 시험) */
  readonly requestHash?: Uint8Array;
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
  /**
   * 같은 Idempotency-Key의 첫 답(202·422)을 프로세스 안에서도 재생한다(BAT-425 RV-03).
   * 운영 조립은 이 답을 order_cancellation에 함께 저장하므로 재시작·다른 파드에서도 재생한다
   */
  readonly #answers = new Map<string, { readonly cancellationId: string; readonly answer: RefundAccountAnswer; readonly refundAmount: number }>();

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
    // 재인증은 상태 확인 뒤에 본다(계좌 대기가 아닌 건에 토큰을 쓰지 않는다). 막히면 행 쓰기·payment 0이다.
    // 같은 키 재생도 재인증은 다시 확인한다(토큰이 없거나 만료면 403)
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
    // 같은 Idempotency-Key의 다시 부름: 첫 답(202 REFUNDED·REFUND_PENDING, 422 계좌 거절·업무 거절)을 그대로 준다.
    // 상태 확인보다 먼저 본다. 첫 답이 CANCEL_PENDING이면 clearWaiting이 계좌 대기 표시를 지워 다시 202를 줄 수 없기 때문이다.
    // 같은 키에 다른 본문(다른 requestHash)이면 422 idempotency-key-reused다(RV-24)
    const replayed = await this.#replayOf(record, i);
    if (replayed !== undefined) return replayed;
    this.#assertPending(record);
    const oldAttempt = record.refundAttempt ?? 0;
    if (oldAttempt >= REFUND_ACCOUNT_MAX_ATTEMPTS) throw new RefundAccountAttemptsExceeded();
    const nowMs = i.nowMs ?? this.o.nowMs?.() ?? Date.now();
    const requestHash = i.requestHash ?? createHash('sha256').update(`${i.accountId}\n${i.cancellationId}\n${i.idempotencyKey}`).digest();
    // 행 잠금 안에서 시도를 1 올리고 커밋한다(결제사를 트랜잭션 안에서 부르지 않는다, ASVS 2.3.3).
    // 같은 계정·작업·키는 플랫폼 멱등 기록으로 같은 트랜잭션에 잡는다(같은 키는 시도를 올리지 않는다, R-T42 ④)
    const attempt = await this.o.writes.beginAttempt({
      cancellationId: i.cancellationId,
      oldAttempt,
      nowMs,
      idempotency: { accountRef: i.accountId, key: i.idempotencyKey, requestHash, operation: 'REFUND_ACCOUNT' },
    });
    if (!attempt) {
      const again = await this.o.orders.findCancellation(i.cancellationId);
      if (!again) throw new RefundAccountNotFound();
      // 같은 키의 첫 요청이 환급까지 끝냈는데 답을 적기 전에 끊겼으면 같은 202다
      if (again.state === 'REFUNDED' && again.refundAccountIdemKey === i.idempotencyKey) {
        return { cancellationId: i.cancellationId, status: 'REFUNDED', refundAmount: again.refundAmount };
      }
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
      // 상태 전이와 답을 한 문장으로 쓴다(RV-24). 재시작·다른 파드에서도 같은 키가 같은 202를 재생한다
      await this.o.writes.updateStatus({ cancellationId: i.cancellationId, status: 'REFUNDED', nowMs, answer: { idempotencyKey: i.idempotencyKey, answer: 'REFUNDED' } });
      this.#rememberLocal(i, attempt.refundAmount, 'REFUNDED');
      this.o.signals?.inc('refunded');
      return { cancellationId: i.cancellationId, status: 'REFUNDED', refundAmount: attempt.refundAmount };
    }
    if (payment === 'REFUND_ACCOUNT_REQUIRED') {
      // 계좌 대기 유지: 표시를 지우지 않고 다음 재시도 시각도 비운다. 팬은 다른 계좌로 새 시도를 낼 수 있다.
      // 상태 전이가 없으므로 답만 한 번에 쓴다(단일 쓰기). 재생은 상태·계좌 대기로도 가를 수 있다
      await this.o.writes.saveAnswer?.({ cancellationId: i.cancellationId, idempotencyKey: i.idempotencyKey, answer: 'REFUND_ACCOUNT_REQUIRED', nowMs });
      this.#rememberLocal(i, attempt.refundAmount, 'REFUND_ACCOUNT_REQUIRED');
      this.o.signals?.inc('rejected');
      throw new RefundAccountRequiredAgain();
    }
    if (payment === 'REJECTED') {
      // 계좌 대기 지우기·CS '환급 실패' 표시·답을 한 문장으로 쓴다(RV-24)
      await this.o.writes.markFailed({ cancellationId: i.cancellationId, attempts: attempt.retryAttempts + 1, lastError: 'REJECTED', nowMs, answer: { idempotencyKey: i.idempotencyKey, answer: 'REJECTED' } });
      this.#rememberLocal(i, attempt.refundAmount, 'REJECTED');
      this.o.signals?.inc('rejected');
      throw new RefundAccountRejected();
    }
    // PENDING·UNKNOWN: 계좌 대기 표시를 지우고 1분 [가정] 뒤 다시 본다. 같은 시도의 재시도는 같은 멱등키를 쓴다.
    // 답도 같은 문장에서 쓴다(RV-24). payment가 앞 시도 CANCEL_PENDING 때문에 새 시도 행을 만들지 않았으면(UNKNOWN)
    // 시도 번호를 oldAttempt로 되돌려 다음 재시도가 앞 시도(a0)를 계속 조회하게 한다(RV-28)
    const restore = payment === 'UNKNOWN' && !(await this.#attemptCreated(i, attempt)) ? oldAttempt : undefined;
    await this.o.writes.clearWaiting({
      cancellationId: i.cancellationId,
      nextRefundAtMs: nowMs + REFUND_ACCOUNT_RETRY_DELAY_MS,
      lastError: payment,
      nowMs,
      answer: { idempotencyKey: i.idempotencyKey, answer: 'REFUND_PENDING' },
      ...(restore === undefined ? {} : { refundAttempt: restore, onlyIfAttempt: attempt.attempt }),
    });
    this.#rememberLocal(i, attempt.refundAmount, 'REFUND_PENDING');
    this.o.signals?.inc('pending');
    return { cancellationId: i.cancellationId, status: 'REFUND_PENDING', refundAmount: attempt.refundAmount };
  }

  /**
   * payment가 이번에 올린 시도의 payment_cancel 행을 만들었는가(RV-28). 앞 시도가 CANCEL_PENDING이면 만들지 않고 UNKNOWN을 준다.
   * 어댑터가 없으면(단위 대역·옛 조립) 만들지 않은 것으로 본다. 확인 요청이 실패하면 만든 것으로 보아 시도를 되돌리지 않는다(이중 환급 쪽을 피한다)
   */
  async #attemptCreated(i: RequestRefundAccountInput, attempt: { readonly attempt: number; readonly orderId: string }): Promise<boolean> {
    const payments = this.o.payments;
    if (payments.attemptExists === undefined) return false;
    try {
      const answer = await payments.attemptExists({ cancellationId: i.cancellationId, orderId: attempt.orderId, refundAttempt: attempt.attempt, deadlineMs: CANCEL_DEADLINE_MS });
      return answer !== false;
    } catch {
      return true;
    }
  }

  /**
   * 저장한 답(DB 행 우선, 단위·시험 대역은 프로세스 안 표)을 202·422로 되돌린다.
   * 같은 키가 맞으면 저장한 requestHash와 현재 지문을 먼저 견주고, 다르면 422 idempotency-key-reused다(RV-24).
   * 답 칸이 빈 끊긴 창은 상태에서 되돌릴 수 있는 REFUNDED와, 시도를 올린 채 아직 답이 없는 진행 중(REFUND_PENDING)만 재생한다(RV-30)
   */
  async #replayOf(record: CancellationRecord, i: RequestRefundAccountInput): Promise<RequestRefundAccountResult | undefined> {
    const keyed = record.refundAccountIdemKey === i.idempotencyKey;
    const local = this.#answers.get(`${i.accountId}:${i.idempotencyKey}`);
    const localHit = local !== undefined && local.cancellationId === i.cancellationId;
    if (!keyed && !localHit) {
      // 키를 적지 않는 옛 저장소(메모리 대역)에서도 REFUNDED·시도>0은 같은 키의 성공 답으로 재생한다.
      // 실제 저장소는 refund_account_idem_key로 가르므로 새 키는 여기 오지 않는다
      if (record.refundAccountIdemKey === undefined && record.state === 'REFUNDED' && (record.refundAttempt ?? 0) > 0) {
        return { cancellationId: i.cancellationId, status: 'REFUNDED', refundAmount: record.refundAmount };
      }
      return undefined;
    }
    if (i.requestHash !== undefined) {
      const stored = await this.o.writes.requestHashOf?.({ accountRef: i.accountId, key: i.idempotencyKey, operation: 'REFUND_ACCOUNT' });
      if (stored !== undefined && !sameHash(stored, i.requestHash)) throw idempotencyKeyReused();
    }
    if (keyed && record.refundAccountAnswer !== undefined) return this.#answerOf(record.refundAccountAnswer, i.cancellationId, record.refundAmount);
    if (localHit) return this.#answerOf(local.answer, local.cancellationId, local.refundAmount);
    // 답 칸이 빈 끊긴 창(이전 판·주입 시험): REFUNDED는 상태만으로 같은 답임을 알 수 있다
    if (keyed && record.state === 'REFUNDED') return { cancellationId: i.cancellationId, status: 'REFUNDED', refundAmount: record.refundAmount };
    // 같은 키가 이미 시도를 올렸는데 답을 아직 적지 않았다(겹친 요청·답 저장 전 끊김, RV-30). 그 시도는 진행 중이므로
    // 첫 답과 같은 202 REFUND_PENDING을 재생하고 payment를 다시 부르지 않는다. 답을 적은 422는 위에서 그대로 재생한다
    if (keyed && (record.refundAttempt ?? 0) > 0 && record.state === 'REFUND_PENDING') {
      return { cancellationId: i.cancellationId, status: 'REFUND_PENDING', refundAmount: record.refundAmount };
    }
    return undefined;
  }

  #answerOf(answer: RefundAccountAnswer, cancellationId: string, refundAmount: number): RequestRefundAccountResult {
    if (answer === 'REFUNDED' || answer === 'REFUND_PENDING') return { cancellationId, status: answer, refundAmount };
    if (answer === 'REFUND_ACCOUNT_REQUIRED') throw new RefundAccountRequiredAgain();
    throw new RefundAccountRejected();
  }

  /** 이 프로세스 안의 답 재생 표. 운영 재생은 상태 전이와 같은 문장에서 쓴 DB 답이 맡는다 */
  #rememberLocal(i: RequestRefundAccountInput, refundAmount: number, answer: RefundAccountAnswer): void {
    this.#answers.set(`${i.accountId}:${i.idempotencyKey}`, { cancellationId: i.cancellationId, answer, refundAmount });
  }

  #assertPending(record: CancellationRecord): void {
    if (record.state !== 'REFUND_PENDING' || record.refundAccountRequired !== true) throw new RefundAccountNotPending();
  }
}

/** 저장한 지문과 현재 지문이 같은가(길이가 다르면 timingSafeEqual이 던지므로 먼저 본다) */
function sameHash(stored: Uint8Array, current: Uint8Array): boolean {
  return stored.length === current.length && timingSafeEqual(Buffer.from(stored), Buffer.from(current));
}
