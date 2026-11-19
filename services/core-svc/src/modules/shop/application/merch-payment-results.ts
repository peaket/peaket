// 굿즈 결제 결과 당기기와 승인 명령 다시 보내기(core-svc 릴레이 리더 반복, ADR-0300 결정 5·6, ADR-0299 결정 5).
// 1초 [가정]마다 다음 시각이 된 승인 명령 작업을 100건 [가정]까지 FOR UPDATE SKIP LOCKED로 잡는다(잡은 작업은 30초 동안 다시 잡히지 않는다).
// - 받아짐을 모르는 작업(sent 거짓): 승인 기한(인증 + 10분) 전이면 ConfirmPayment를 다시 보낸다(1초부터 두 배씩 30초까지).
//   기한이 지났으면 다시 보내지 않고 BatchGetPayments로 묻는다. 결제가 없으면(명령이 기록되지 않음) 주문 FAILED(O6 승인 기한 초과)와 두 재고 복구,
//   있으면 받아짐으로 바꾸고 그 결과대로 반영한다(시간 초과로 답을 못 받았어도 payment-svc가 적었을 수 있다). 묻지 못하면 그 작업을 5초 [가정] 미룬다(RV-01, P-T57 ⑨).
// - 받아진 작업: BatchGetPayments로 묻는다. APPROVED(취소 상태 포함) → PAID와 RELEASE(restore=0), FAILED → FAILED·product_stock 복구와 RELEASE(restore=1),
//   ACCEPTED 2초·UNKNOWN 30초·입금 대기 60초 뒤 다시, 답에 없으면 기한 전에는 다시 보내기·기한 뒤에는 FAILED(다시 보내지 않는다),
//   payment-svc가 답하지 못하면 그 묶음을 5초 미룬다.
// Redis 예약은 DB 커밋 뒤 푼다. 풀기 전에 죽으면 만료 작업이 주문 상태를 보고 한 번만 돌린다(원소가 있을 때만 돌린다).
import type { Clock } from '@peaket/platform';
import {
  CONFIRM_DEADLINE_MS,
  CONFIRM_WINDOW_MS,
  confirmRetryDelayMs,
  PULL_BATCH,
  PULL_DEPOSIT_MS,
  PULL_FAILURE_DEFER_MS,
  PULL_PENDING_MS,
  PULL_UNKNOWN_MS,
  type ReleasedOrder,
} from '../domain/merch-order.js';
import type { ConfirmJob, MerchPayments, MerchStock, ShopOrderStore } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

/** 잡은 작업을 다시 잡지 않는 시간 [정함](반복 한 바퀴보다 넉넉히) */
const CLAIM_LEASE_MS = 30_000;

export interface MerchResultsDeps {
  store: ShopOrderStore;
  stock: MerchStock;
  payments: MerchPayments;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
  /** 장애 주입 자리(시험): 결과를 커밋한 뒤 Redis를 풀기 전에 부른다. 던지면 그 주문의 풀기를 건너뛴다 */
  afterResultCommit?: (orderId: string, kind: 'paid' | 'failed') => void | Promise<void>;
}

export interface ResultsTick {
  claimed: number;
  paid: number;
  failed: number;
  resent: number;
  pullFailed: boolean;
}

export class MerchPaymentResults {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchResultsDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  async tick(): Promise<ResultsTick> {
    const now = this.d.clock.now();
    const jobs = await this.d.store.claimDueJobs(now, PULL_BATCH, now + CLAIM_LEASE_MS);
    const out: ResultsTick = { claimed: jobs.length, paid: 0, failed: 0, resent: 0, pullFailed: false };
    const pastDeadline = (j: ConfirmJob) => now >= j.authenticatedAtMs + CONFIRM_WINDOW_MS;
    // 기한 전의 받아짐 모름 작업은 다시 보낸다
    for (const job of jobs.filter((j) => !j.sent && !pastDeadline(j))) {
      await this.#send(job, now);
      out.resent++;
    }
    // 받아진 작업과 기한이 지난 받아짐 모름 작업은 결제 원장에 묻는다(기한 뒤에는 다시 보내지 않는다)
    const ask = jobs.filter((j) => j.sent || pastDeadline(j));
    if (ask.length === 0) return out;
    let states;
    try {
      states = await this.d.payments.batchGet(ask.map((j) => j.orderId));
    } catch {
      out.pullFailed = true;
      this.d.signals?.pullFailures.inc();
      this.#log.warn({ kind: 'merch-payment-pull-failed', count: ask.length }, '굿즈 결제 결과를 당기지 못해 묶음을 미뤘다');
      for (const j of ask) await this.d.store.rescheduleJob(j.orderId, now + PULL_FAILURE_DEFER_MS);
      return out;
    }
    const byOrder = new Map(states.map((s) => [s.orderId, s]));
    for (const job of ask) {
      const s = byOrder.get(job.orderId);
      if (!s) {
        if (pastDeadline(job)) {
          // 결제 원장에 기록이 없다: 결제사가 명령을 받은 적이 없으므로 승인 기한 초과로 끝낸다(O6)
          await this.#fail(job.orderId, now, out);
        } else {
          // 명령이 기록되지 않았다: 다시 보낸다
          await this.d.store.rescheduleJob(job.orderId, now, { sent: false });
        }
        continue;
      }
      // 받아짐을 몰랐던 작업도 원장에 기록이 있으면 받아진 것이다
      const sent = job.sent ? {} : { sent: true };
      if (s.status === 'APPROVED' || s.status === 'PARTIAL_CANCELED' || s.status === 'CANCELED') {
        const released = await this.d.store.applyPaid(job.orderId, { paymentId: s.paymentId, pg: s.pg, approvedAtMs: s.approvedAtMs ?? now });
        if (released) {
          out.paid++;
          this.d.signals?.order('paid');
          await this.#release(released, false, 'paid');
        }
      } else if (s.status === 'FAILED') await this.#fail(job.orderId, now, out);
      else if (s.status === 'UNKNOWN') await this.d.store.rescheduleJob(job.orderId, now + PULL_UNKNOWN_MS, sent);
      else if (s.status === 'AWAITING_DEPOSIT') {
        // 입금 대기: 주문을 AWAITING_DEPOSIT으로 바꾸고 재고 예약을 입금 기한 + 10분 [가정]까지 늘린다(EXTEND 1회, ADR-0314)
        const applied = await this.d.store.applyAwaitingDeposit(job.orderId, { paymentId: s.paymentId, pg: s.pg, depositDueAtMs: s.depositDueAtMs, nowMs: now });
        if (applied) {
          this.d.signals?.deposit('waiting');
          for (const l of applied.limited) {
            try {
              await this.d.stock.extend(l.productId, job.orderId, applied.deadline.getTime(), applied.accountId);
            } catch {
              this.#log.warn({ kind: 'merch-stock-extend-failed', orderId: job.orderId }, '입금 대기로 바꾼 뒤 재고 예약을 늘리지 못했다');
            }
          }
        }
        await this.d.store.rescheduleJob(job.orderId, now + PULL_DEPOSIT_MS, sent);
      } else await this.d.store.rescheduleJob(job.orderId, now + PULL_PENDING_MS, sent);
    }
    return out;
  }

  async #fail(orderId: string, now: number, out: ResultsTick): Promise<void> {
    const released = await this.d.store.applyFailed(orderId, now);
    if (!released) return;
    out.failed++;
    this.d.signals?.order('failed');
    await this.#release(released, true, 'failed');
  }

  async #send(job: ConfirmJob, now: number): Promise<void> {
    const outcome = await this.d.payments.confirm(job, CONFIRM_DEADLINE_MS);
    if (outcome.status === 'ACCEPTED') await this.d.store.markConfirmSent(job.orderId, now + PULL_PENDING_MS);
    else {
      const tries = job.tries + 1;
      if (outcome.status === 'REJECTED') this.#log.warn({ kind: 'merch-confirm-rejected', orderId: job.orderId, reason: outcome.reason }, '굿즈 승인 명령을 payment-svc가 거절했다(기한까지 다시 보낸다)');
      await this.d.store.rescheduleJob(job.orderId, now + confirmRetryDelayMs(tries), { tries });
    }
  }

  async #release(r: ReleasedOrder, restore: boolean, kind: 'paid' | 'failed'): Promise<void> {
    try {
      await this.d.afterResultCommit?.(r.orderId, kind);
    } catch {
      return;
    }
    for (const l of r.limited) {
      try {
        await this.d.stock.release(l.productId, r.orderId, restore, r.accountId);
      } catch {
        this.#log.warn({ kind: 'merch-stock-release-failed', orderId: r.orderId }, '결제 결과를 반영한 뒤 예약을 풀지 못했다(만료 작업이 돌린다)');
      }
    }
  }
}
