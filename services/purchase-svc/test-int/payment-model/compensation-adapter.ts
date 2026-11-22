// 결제 모델 기반 시험(V-T40)의 보상 세 걸음 어댑터(BUILD_ORDER BAT-011, PRF-173).
// 하네스가 흉내 내던 compStart·compFence·compCancel을 운영 쓰임새(StartCompensation·FenceCompensation·CancelCompensation)로 잇는다.
// 결제사·ticket-svc는 이 시험의 대역을 그대로 쓴다(운영 어댑터 자리는 시험 밖이다). 이 파일은 시험용 얇은 어댑터다.
import type { Clock, Database } from '@peaket/platform';
import { CancelCompensation, DrizzleCompensation, FenceCompensation, StartCompensation } from '../../src/modules/booking/index.js';

/** 발권 막기 대역의 답(운영 grpc-ticket-fence가 BlockTicketIssuance 답을 읽는 자리) */
export interface FenceAnswer {
  readonly blocked: true;
  readonly alreadyEntered: number;
  readonly already_entered: number;
}

/** 결제 취소 대역의 답(payment.proto CancelResult에서 접두어를 뗀 이름) */
export type PaymentCancelAnswer = 'CANCELLED' | 'UNKNOWN' | 'REJECTED';

export interface HarnessCompensationOptions {
  readonly database: Database;
  readonly clock: Clock;
  /** 그 주문의 마지막 APPROVED 결제 ID(ADR-0354 결정 4). 없으면 빈 글 */
  readonly paymentIdOf: (orderId: string) => Promise<string>;
  /** ticket-svc 대역의 주문 단위 발권 막기 */
  readonly fence: (orderId: string) => Promise<FenceAnswer>;
  /** payment-svc 대역의 전액 취소. 같은 cancellation_id면 같은 취소다 */
  readonly cancelPayment: (q: { readonly orderId: string; readonly paymentId: string; readonly cancellationId: string; readonly reason: string; readonly deadlineMs: number }) => Promise<PaymentCancelAnswer>;
  /** 회차 취소 확정일 때의 사유(이 시험의 compStart는 회차 취소 확정으로만 온다) */
  readonly reason?: string;
  /** 회차 취소 요청 ID(감사·로그용, 없으면 빈 글) */
  readonly requestId?: string;
}

/**
 * 운영 쓰임새 세 걸음을 시험 대역과 묶는다. 하네스는 이 어댑터만 부르고, 쓰임새가 저장소·대역을 어떻게 부르는지는 운영 코드가 정한다.
 * 시작 입력의 payment_id는 그 주문의 마지막 APPROVED 결제다(ADR-0354 결정 4).
 */
export class HarnessCompensation {
  readonly #start: StartCompensation;
  readonly #fence: FenceCompensation;
  readonly #cancel: CancelCompensation;
  readonly #paymentIdOf: (orderId: string) => Promise<string>;
  readonly #reason: string;
  readonly #requestId: string;

  constructor(o: HarnessCompensationOptions) {
    const store = new DrizzleCompensation({ database: o.database });
    const clock = o.clock;
    const nowMs = () => clock.now();
    // 운영 쓰임새의 포트에 시험 대역을 꽂는다. ticket-svc fence는 운영 어댑터와 같은 모양({ orderId })으로 부른다
    const fence = { block: (input: { readonly orderId: string }) => o.fence(input.orderId) };
    this.#start = new StartCompensation({ store, clock, nowMs, paymentIdOf: o.paymentIdOf });
    this.#fence = new FenceCompensation({ store, fence, clock, nowMs });
    // 결제 취소 답은 시험 대역의 문자열(CANCELLED·UNKNOWN·REJECTED)을 운영 포트의 객체 답으로 옮긴다
    this.#cancel = new CancelCompensation({
      store,
      payments: {
        cancel: async (q) => {
          const answer = await o.cancelPayment(q);
          if (answer === 'CANCELLED') return { kind: 'CANCELED', paymentId: q.paymentId };
          if (answer === 'REJECTED') return { kind: 'FAILED', code: 'REJECTED', paymentId: q.paymentId };
          return { kind: 'RETRY', code: 'UNKNOWN', paymentId: q.paymentId };
        },
      },
      clock,
      nowMs,
    });
    this.#paymentIdOf = o.paymentIdOf;
    this.#reason = o.reason ?? 'EVENT_CANCELLED';
    this.#requestId = o.requestId ?? '';
  }

  /** compStart: 큐 행을 잠그고 지운 뒤 주문을 보상 중(order_compensation STARTED)으로 표시한다. APPROVED가 아니면 경합에서 진 걸음이다 */
  async start(orderId: string): Promise<void> {
    const paymentId = await this.#paymentIdOf(orderId);
    const result = await this.#start.run({ orderId, paymentId, reason: this.#reason, cause: this.#reason, eventCancellationRequestId: this.#requestId, requestId: this.#requestId });
    if (result.status === 'NOT_APPROVED') throw new Error(`compStart: 주문이 APPROVED가 아니다(${result.current ?? '없음'})`);
  }

  /** compFence: ticket-svc에 그 주문의 발권을 막게 한다 */
  async fence(orderId: string): Promise<void> {
    await this.#fence.run({ orderId });
  }

  /** compCancel: 막은 답을 받은 뒤 결제를 취소하고 주문을 COMPENSATED로 끝낸다 */
  async cancel(orderId: string): Promise<void> {
    await this.#cancel.run({ orderId });
  }
}
