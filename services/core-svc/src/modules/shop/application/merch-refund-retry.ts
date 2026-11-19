// 구매자 취소·반품 환급 다시 부르기(core-svc 릴레이 리더 반복, ADR-0315, P-T64 ①②).
// 60초 [정함]마다 다음 시각이 된 USER_CANCEL·RETURN 환급을 100건 [가정]까지 읽어 같은 취소 ID로 CancelPayment를 다시 부른다(결제사 멱등키 cancel-{id}).
// 간격은 1분 → 5분 → 15분 → 1시간 → 6시간, 5회 [가정]다. CANCELLED면 항목 REFUNDED, CANCEL_PENDING·UNKNOWN이면 항목 CANCELLED를 유지하고 다음 시각,
// REFUND_ACCOUNT_REQUIRED면 계좌를 기다리며 자동 재시도를 멈추고, REJECTED면 SEV2 한 줄. 5회를 넘기면 SEV2 한 줄로 CS에 넘긴다.
import type { Clock } from '@peaket/platform';
import { refundRetryNextDelayMs } from '../domain/merch-order.js';
import type { CancelOutcome, MerchPayments, RefundRow, ShopOrderStore } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

/** 한 바퀴에 보는 환급 100건 [가정] */
export const REFUND_RETRY_BATCH = 100;

export interface MerchRefundRetryDeps {
  store: ShopOrderStore;
  payments: MerchPayments;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export interface RefundRetryTick {
  picked: number;
  cancelled: number;
  pending: number;
  rejected: number;
}

export class MerchRefundRetry {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchRefundRetryDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  async tick(): Promise<RefundRetryTick> {
    const now = this.d.clock.now();
    const due = await this.d.store.dueUserRefunds(now, REFUND_RETRY_BATCH);
    const out: RefundRetryTick = { picked: due.length, cancelled: 0, pending: 0, rejected: 0 };
    for (const r of due) await this.#one(r, now, out);
    return out;
  }

  async #one(r: RefundRow, now: number, out: RefundRetryTick): Promise<void> {
    const outcome: CancelOutcome = r.paymentId === null ? 'UNKNOWN' : await this.d.payments.cancel({ paymentId: r.paymentId, cancellationId: r.refundId, amount: r.amount, reason: r.reason });
    const attempts = r.attempts + 1;
    if (outcome === 'CANCELLED') {
      await this.d.store.refundResult(r.refundId, outcome, now, { attempts });
      this.d.signals?.userRefund('cancelled');
      out.cancelled++;
      return;
    }
    if (outcome === 'REFUND_ACCOUNT_REQUIRED' || outcome === 'REJECTED') {
      const failReason = outcome === 'REFUND_ACCOUNT_REQUIRED' ? 'REFUND_ACCOUNT_REQUIRED' : 'PG_REJECTED';
      await this.d.store.refundResult(r.refundId, outcome, now, { attempts, failReason, ...(outcome === 'REFUND_ACCOUNT_REQUIRED' ? { accountRequiredAtMs: now } : {}) });
      this.d.signals?.userRefund(outcome === 'REFUND_ACCOUNT_REQUIRED' ? 'pending' : 'rejected');
      if (outcome === 'REFUND_ACCOUNT_REQUIRED') this.d.signals?.cancellation('pending');
      else {
        this.d.signals?.cancellation('rejected');
        this.#log.error({ kind: 'merch-refund-rejected', severity: 'SEV2', orderId: r.orderId }, '굿즈 환급을 결제사가 거절했다');
      }
      out.rejected++;
      return;
    }
    const next = refundRetryNextDelayMs(attempts);
    if (next === null) {
      // 5회를 넘겼다. 자동 재시도를 멈추고 CS가 이어 본다(merch_refund.fail_reason은 값 없는 이름표)
      await this.d.store.refundResult(r.refundId, 'REJECTED', now, { attempts, failReason: 'RETRY_EXHAUSTED', alerted: true });
      this.d.signals?.userRefund('error');
      this.d.signals?.cancellation('rejected');
      this.#log.error({ kind: 'merch-refund-retry-exhausted', severity: 'SEV2', orderId: r.orderId }, '굿즈 환급이 5회 다시 불러도 끝나지 않아 CS로 넘겼다');
      out.rejected++;
      return;
    }
    await this.d.store.refundResult(r.refundId, outcome, now, { attempts, nextAtMs: now + next });
    this.d.signals?.userRefund('pending');
    out.pending++;
  }
}
