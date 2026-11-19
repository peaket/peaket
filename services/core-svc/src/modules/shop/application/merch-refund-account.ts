// 굿즈 지연 환급 계좌 다시 받기(POST /v1/shop/orders/{orderId}/cancellations/{cancellationId}/account,
// BAT-425, ADR-0316 결정 5, openapi createShopCancellationAccount, P-T63 ③·R-T43).
// 결제사 계좌 거절로 끝난 merch_refund(REJECTED·fail_reason REFUND_ACCOUNT_REQUIRED·account_required_at 있음)에만 계좌를 받는다.
// 차례: 멱등 다시 오기 → 계좌 모양(400) → 주문 소유·취소 행(없거나 남의 주문은 같은 404) → 자격·시도 상한(409) →
// 재인증(op SHOP_CANCEL_REFUND_ACCOUNT, act FAN_HIGH_RISK, 403·503) → 행 잠금 안에서 새 merch_refund 행(새 UUIDv7 취소 ID,
// replaces_refund_id = 옛 행, 같은 kind·amount·사유)과 새 merch_refund_item 자리·멱등 기록 커밋 → 새 취소 ID로 CancelPayment → 답 반영.
// 옛 행은 REJECTED 그대로 두고, 계좌는 이 호출 안에서만 쓰며 저장·로그·사건·Outbox·지표 어디에도 남기지 않는다(POL-014).
import { uuidv7, type Clock, type IdempotencyRequest } from '@peaket/platform';
import { refundAccountShape } from '@peaket/validation/refund-account';
import {
  assertRefundAccountRetryable,
  badRequest,
  dependencyUnavailable,
  MerchCancelNotAllowed,
  orderNotFound,
  REFUND_ACCOUNT_RETRY_MS,
  ReauthRequired,
  refundAccountRequired,
  refundRejected,
  refundRetryNextDelayMs,
} from '../domain/merch-order.js';
import { type CancelOutcome, type MerchPayments, ReauthUnavailable, type ShopOrderStore, type ShopReauthGate } from '../domain/merch-ports.js';
import { type CancellationView, RefundResultWriteFailed } from './merch-cancel.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

export interface MerchRefundAccountInput {
  readonly accountId: string;
  /** 재인증 토큰의 sid와 견줄 로그인 세션(단위 대역은 비운다) */
  readonly sessionId?: string | undefined;
  readonly orderId: string;
  /** 경로의 취소 ID. 옛 행이면 `replaces_refund_id` 사슬 끝 행으로 이어진다 */
  readonly cancellationId: string;
  readonly account: { bankCode: string; accountNumber: string; holderName: string };
  readonly reauthToken: string | undefined;
  /** HTTP @Idempotent의 키. 같은 키의 다시 보냄은 새 행을 만들지 않고 처음 답을 준다 */
  readonly idempotencyKey: string;
  /** 받는 층이 넘기는 멱등 요청 값(요청 지문 포함). 없으면 키와 계정으로 채운다(단위 대역) */
  readonly once?: IdempotencyRequest | undefined;
}

/** 받는 층이 멱등 요청 값을 넘기지 않은 단위 대역에서 쓰는 값(지문은 빈 값) */
const syntheticOnce = (i: MerchRefundAccountInput): IdempotencyRequest => ({
  accountRef: i.accountId,
  operation: 'SHOP_CANCEL_REFUND_ACCOUNT',
  key: i.idempotencyKey,
  requestHash: new Uint8Array(32),
});

export interface MerchRefundAccountDeps {
  store: ShopOrderStore;
  payments: MerchPayments;
  reauth: ShopReauthGate;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export class MerchRefundAccount {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchRefundAccountDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  /** @throws ShopProblem 400 invalid-body · 404 not-found · 409 merch-cancel-not-allowed · 422 · 503 */
  async run(i: MerchRefundAccountInput): Promise<CancellationView> {
    const once = i.once ?? syntheticOnce(i);
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#replay(replay);
    // 계좌 모양은 주문 조회·재인증·행 쓰기 앞에서 본다(400 invalid-body, P-T63 ③)
    const shape = refundAccountShape(i.account);
    if (!shape.ok) {
      this.d.signals?.refundAccount('invalid');
      throw badRequest('invalid-body');
    }
    const orderId = i.orderId.toLowerCase();
    const cancellationId = i.cancellationId.toLowerCase();
    // 주문 소유와 취소 행을 함께 본다. 없거나 남의 주문·다른 주문의 취소 ID는 같은 404다(authz-matrix §3.2)
    const target = await this.d.store.findRejectedAccountRequired(orderId, i.accountId, cancellationId);
    if (!target) throw orderNotFound();
    try {
      assertRefundAccountRetryable(target);
    } catch (e) {
      this.d.signals?.refundAccount('rejected');
      throw e;
    }
    // 재인증은 자격 확인 뒤에 본다(계좌 대기가 아닌 취소에 토큰을 쓰지 않는다). 막히면 새 행·payment 0이다(R-T43 ②)
    let passed: boolean;
    try {
      passed = await this.d.reauth.verify(i.reauthToken, { accountId: i.accountId, sessionId: i.sessionId ?? '', act: 'FAN_HIGH_RISK', op: 'SHOP_CANCEL_REFUND_ACCOUNT' });
    } catch (e) {
      if (e instanceof ReauthUnavailable) {
        this.d.signals?.reauth('unavailable', 'store');
        // 확인기·jti 저장소를 쓸 수 없다. 받는 층이 503 reauth-unavailable로 답한다(재시도 토큰은 쓰지 않았다)
        throw e;
      }
      throw e;
    }
    if (!passed) {
      this.d.signals?.reauth('rejected', 'token');
      throw new ReauthRequired();
    }
    this.d.signals?.reauth('accepted', 'ok');
    const refundId = uuidv7(this.d.clock);
    let created;
    try {
      created = await this.d.store.beginAccountRetry(once, { cancellationId, orderId, accountId: i.accountId, refundId, nowMs: this.d.clock.now() });
    } catch (e) {
      if (e instanceof MerchCancelNotAllowed) this.d.signals?.refundAccount('rejected');
      throw e;
    }
    if (created.kind === 'replay') return this.#replay(created.resultRef);
    this.d.signals?.refundAccount('accepted');
    const newId = created.refund.refundId;
    const amount = created.refund.amount;
    if (created.refund.paymentId === null) throw dependencyUnavailable();
    // 새 취소 ID의 멱등키에 계좌 다시 받기 시도 번호를 실어 보낸다(재시도가 같은 키를 쓰게, ADR-0316)
    const outcome = await this.d.payments.cancel({
      paymentId: created.refund.paymentId,
      cancellationId: newId,
      amount,
      reason: created.refund.reason,
      refundAccount: shape.value,
      refundAttempt: created.refund.refundAttempt,
    });
    const settledAt = this.d.clock.now();
    if (outcome === 'CANCELLED') {
      await this.#record(newId, amount, outcome, settledAt, { attempts: 0 });
      this.d.signals?.refundAccount('refunded');
      return { cancellationId: newId, status: 'REFUNDED', refundAmount: amount };
    }
    if (outcome === 'REFUND_ACCOUNT_REQUIRED' || outcome === 'REJECTED') {
      const failReason = outcome === 'REFUND_ACCOUNT_REQUIRED' ? 'REFUND_ACCOUNT_REQUIRED' : 'PG_REJECTED';
      await this.#record(newId, amount, outcome, settledAt, {
        attempts: 0,
        failReason,
        ...(outcome === 'REFUND_ACCOUNT_REQUIRED' ? { accountRequiredAtMs: settledAt } : {}),
      });
      this.d.signals?.refundAccount('rejected');
      throw outcome === 'REFUND_ACCOUNT_REQUIRED' ? refundAccountRequired() : refundRejected();
    }
    // CANCEL_PENDING·UNKNOWN: 취소 효력은 즉시, 환급은 같은 취소 ID·같은 시도 번호로 다시 부른다
    await this.#record(newId, amount, outcome, settledAt, { attempts: 0, nextAtMs: settledAt + (refundRetryNextDelayMs(0) ?? REFUND_ACCOUNT_RETRY_MS) });
    this.d.signals?.refundAccount('pending');
    return { cancellationId: newId, status: 'REFUND_PENDING', refundAmount: amount };
  }

  /**
   * 환급 결과 반영. DB 쓰기가 실패하면 RefundResultWriteFailed를 던져 받는 층이 202 REFUND_PENDING으로 답한다
   * (결제사 취소는 이미 나갔고, 재시도가 같은 취소 ID·같은 시도 번호로 끝낸다)
   */
  async #record(
    refundId: string,
    amount: number,
    outcome: CancelOutcome,
    nowMs: number,
    o: { attempts?: number; nextAtMs?: number | null; failReason?: string; accountRequiredAtMs?: number },
  ): Promise<void> {
    try {
      await this.d.store.refundResult(refundId, outcome, nowMs, o);
    } catch (e) {
      // 결제사 답은 왔고 재시도가 같은 취소 ID로 끝낸다. 결과는 대기와 같게 센다
      this.d.signals?.refundAccount('pending');
      this.#log.error(
        { kind: 'merch-refund-account-write-failed', severity: 'SEV2', cancellationId: refundId, err: e instanceof Error ? e.name : 'unknown' },
        '결제사 취소는 나갔는데 환급 계좌 다시 받기 결과를 적지 못했다(재시도가 같은 취소 ID로 끝낸다)',
      );
      throw new RefundResultWriteFailed(refundId, amount, outcome, e);
    }
  }

  /** 같은 키 다시 오기. 새 행의 지금 상태로 같은 답을 만든다(계좌 거절은 422, 업무 거절도 422) */
  async #replay(ref: string): Promise<CancellationView> {
    if (!ref.startsWith('cancel:')) throw badRequest('invalid-body');
    const row = await this.d.store.cancelView(ref.slice('cancel:'.length));
    if (row === undefined) throw dependencyUnavailable();
    if (row.state === 'REJECTED') {
      this.d.signals?.refundAccount('rejected');
      throw row.refundAccountRequired ? refundAccountRequired() : refundRejected();
    }
    return {
      cancellationId: row.cancellationId,
      status: row.state === 'CANCELLED' ? 'REFUNDED' : 'REFUND_PENDING',
      refundAmount: row.refundAmount,
      ...(row.refundAccountRequired ? { refundAccountRequired: true } : {}),
    };
  }
}
