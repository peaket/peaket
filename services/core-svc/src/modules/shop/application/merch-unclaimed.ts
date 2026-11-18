// 현장 수령 미수령 자동 취소와 환급 다시 부르기(ADR-0301 결정 5, P-T57, docs/planning/03 용어 '미수령'·§2.13 I2·I16).
// - 정비 일 merch-unclaimed-cancel: 매일 10:00 KST [가정] 뒤(그 전이면 미룸), 은행 영업일(주말 건너뜀)에만 일한다. PAID 현장 수령 주문의 READY 항목 가운데
//   그 상품·그 회차의 마지막 시간대가 끝난 날 D의 다음 영업일이 오늘이거나 지났으면 주문마다 한 트랜잭션에서 READY → CANCELLED(cancel_reason UNCLAIMED, 조건부)와
//   환급 행(REQUESTED, ID가 결제 취소 ID)을 넣고, 커밋 뒤 CancelPayment(그 금액, 사유 UNCLAIMED)를 부른다. 재고는 돌리지 않는다.
// - 결과: CANCELLED → 항목 REFUNDED와 환급 금액. CANCEL_PENDING·UNKNOWN·호출 실패 → 리더 반복이 10분 [가정]마다 같은 취소 ID로 다시(결제사 멱등키 cancel-{취소 ID}),
//   3일 [가정] 넘게 끝나지 않으면 SEV2 한 줄. REJECTED → SEV2 한 줄(kind merch-refund-rejected, 주문 ID만)과 환급 행은 그대로(REJECTED).
import { uuidv7, type Clock } from '@peaket/platform';
import { isBusinessDay, kstDateOf, kstMinuteOfDay } from '../domain/business-day.js';
import { REFUND_OVERDUE_MS, UNCLAIMED_REASON, UNCLAIMED_RUN_MINUTE_KST, unclaimedDue } from '../domain/merch-order.js';
import type { CancelOutcome, MerchPayments, RefundRow, ShopOrderStore } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

/** 정비 일 이름 */
export const MERCH_UNCLAIMED_TASK = 'merch-unclaimed-cancel';
/** 한 번에 보는 항목 1,000건 [가정] */
const UNCLAIMED_BATCH = 1_000;
/** 환급 다시 부르기 한 바퀴 100건 [가정] */
const REFUND_BATCH = 100;

export interface MerchUnclaimedDeps {
  store: ShopOrderStore;
  payments: MerchPayments;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export class MerchUnclaimed {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchUnclaimedDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  /** 정비 일 본체. 10:00 KST 전이면 { deferred: true }, 영업일이 아니면 { skipped: 'not-business-day' } */
  async run(signal?: AbortSignal): Promise<{ deferred: true } | { skipped: 'not-business-day' } | { cancelled: number; refunds: number }> {
    const now = this.d.clock.now();
    if (kstMinuteOfDay(now) < UNCLAIMED_RUN_MINUTE_KST) return { deferred: true };
    if (!isBusinessDay(kstDateOf(now))) return { skipped: 'not-business-day' };
    let cancelled = 0;
    let refunds = 0;
    for (const c of await this.d.store.unclaimedCandidates(now, UNCLAIMED_BATCH)) {
      if (signal?.aborted) break;
      const due = c.items.filter((i) => unclaimedDue(i.lastSlotEndsAtMs, now));
      if (due.length === 0) continue;
      const refund = await this.d.store.cancelUnclaimed(c.orderId, due.map((i) => i.itemId), uuidv7(this.d.clock), now);
      if (!refund) continue;
      cancelled += due.length;
      refunds++;
      await this.#call(refund, this.d.clock.now());
    }
    return { cancelled, refunds };
  }

  /** 리더 반복 한 바퀴: 다음 시각이 된 환급을 같은 취소 ID로 다시 부른다 */
  async retry(): Promise<{ retried: number }> {
    const now = this.d.clock.now();
    const due = await this.d.store.dueRefunds(now, REFUND_BATCH);
    for (const r of due) await this.#call(r, now);
    return { retried: due.length };
  }

  async #call(r: RefundRow, now: number): Promise<void> {
    let alerted: boolean | undefined;
    if (!r.alerted && now - r.createdAtMs > REFUND_OVERDUE_MS) {
      this.#log.error({ kind: 'merch-refund-overdue', severity: 'SEV2', orderId: r.orderId }, '미수령 환급이 3일 넘게 끝나지 않았다');
      alerted = true;
    }
    const outcome: CancelOutcome = r.paymentId ? await this.d.payments.cancel({ paymentId: r.paymentId, cancellationId: r.refundId, amount: r.amount, reason: UNCLAIMED_REASON }) : 'UNKNOWN';
    if (outcome === 'REJECTED') this.#log.error({ kind: 'merch-refund-rejected', severity: 'SEV2', orderId: r.orderId }, '미수령 환급을 결제사가 거절했다');
    this.d.signals?.refund(outcome === 'CANCELLED' ? 'cancelled' : outcome === 'REJECTED' ? 'rejected' : 'pending');
    await this.d.store.refundResult(r.refundId, outcome, now, alerted === undefined ? {} : { alerted });
  }
}
