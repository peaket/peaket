// 결제 결과 long polling 쓰임새(openapi GET /v1/orders/{orderId}/payment-status, docs/features/payment.md §2 '결제 결과 long polling의 첫 구현', BUILD_ORDER PRF-166).
// 차례: reads.read → 없거나 계정이 다르면 404(남의 주문을 가리지 않는다) → decidePaymentStatus → IMMEDIATE면 200, REJECT면 409
// → WAIT면 기다릴 시간 = paymentStatusWaitMs(남은 시간)만큼 waiters.wait(기다림 시작 때 본문을 since로 넘긴다. DB 연결을 쥐지 않는다)
// → 깨면 넘겨받은 모습(없으면 reads.read 한 건)으로 정한다 → 시간이 다 되면 그때의 상태로 200(WAIT의 body).
// 구매 세션 서명은 보지 않는다(결제창에서 돌아온 탭이 묻는다).
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
import type { Clock, Deadline } from '@peaket/platform';
import {
  decidePaymentStatus,
  PAYMENT_STATUS_WAIT_MAX_MS,
  type PaymentStatusBody,
  type PaymentStatusProblem,
  type PaymentStatusView,
  paymentStatusWaitMs,
  paymentStatusWakes,
} from '../domain/payment-status.js';
import type { PaymentStatusReads, PaymentStatusWaiters } from '../domain/ports.js';

/** 쓰임새가 쓰는 포트와 설정 */
export interface GetPaymentStatusDeps {
  reads: PaymentStatusReads;
  waiters: PaymentStatusWaiters;
  /** issueDelayed 판정의 '지금'(벽시계 now) */
  clock: Clock;
}

/** 요청 하나 */
export interface GetPaymentStatusCommand {
  /** 팬 쿠키의 계정(플랫폼 인증 가드의 신원) */
  readonly accountId: string;
  /** 경로 값 그대로(모양은 보지 않는다. 소문자 UUID가 아니면 읽기가 undefined라 404) */
  readonly orderId: string;
  /** 이 요청의 남은 시간(이 경로만 상한 27초 [가정], PAYMENT_STATUS_MAX_DEADLINE_MS). 없으면 기다림은 25초 그대로 [정함] */
  readonly deadline?: Deadline;
  /** 브라우저가 연결을 닫으면 끊긴다(기다림을 곧바로 그만둔다). 없으면 끊지 않는다 */
  readonly signal?: AbortSignal;
}

/**
 * 결과(던지지 않은 길).
 * - 200: body(바로 답했거나, 기다린 뒤 다시 읽은 상태)
 * - 404: 없는 주문·남의 주문(같은 404 not-found)
 * - 409: NOT_ACCEPTED(payment-not-accepted)·ORDER_EXPIRED(order-expired)
 */
export type GetPaymentStatusResult =
  | { readonly status: 200; readonly body: PaymentStatusBody }
  | { readonly status: 404 }
  | { readonly status: 409; readonly reason: PaymentStatusProblem };

export class GetPaymentStatus {
  constructor(private readonly deps: GetPaymentStatusDeps) {}

  /**
   * 결제 결과를 묻는다(위 머리 주석의 차례).
   * - 깬 뒤에는 묶음 조회가 넘긴 모습(CHANGED의 view)을 쓰고, 없으면(notify·시간 다 됨) 한 건 다시 읽는다(리뷰 고침 M4)
   * - 깬 뒤 본 상태가 바로 답할 상태·409이거나, APPROVED의 issueDelayed가 기다림 시작 때 본문의 거짓에서 참으로 바뀌었으면 답한다(리뷰 고침 M2)
   * - 그 밖(아직 기다릴 상태)이고 남은 기다림이 있으면 처음 기다림의 끝까지 남은 몫만 다시 기다린다 [정함]
   * - 다시 본 주문이 없거나 남의 주문이면 404 [정함]
   * - ABORTED(받을 쪽이 없다)·STOPPED(파드가 멈춤)·FULL(기다림 상한)이면 다시 읽지 않고 마지막 본문으로 200 [정함]
   * @throws Error purchase DB 오류(읽기 실패는 그대로 던져 500. 기다리던 요청도 같다)
   */
  async execute(c: GetPaymentStatusCommand): Promise<GetPaymentStatusResult> {
    const { reads, waiters, clock } = this.deps;
    const first = this.judge(c, await reads.read(c.orderId), undefined);
    if (first.kind !== 'WAIT') return first.result;
    // 깨울지 견줄 기준: 기다림 시작 때 본문(다시 기다려도 바꾸지 않는다)
    const since = first.body;
    // 기다릴 시간: 남은 시간을 모르면 25초 [정함]. 기다림 전체의 끝(단조 시계)을 잡아 두고, 깨서 다시 기다릴 때도 이 끝을 넘지 않는다 [정함]
    const waitMs = c.deadline ? paymentStatusWaitMs(c.deadline.remainingMs()) : PAYMENT_STATUS_WAIT_MAX_MS;
    const endMono = clock.monotonicMs() + waitMs;
    let last = since;
    let budget = waitMs;
    while (budget > 0) {
      // 기다리는 동안에는 아무 포트도 부르지 않는다(DB 연결을 쥐지 않는다)
      const up = await waiters.wait(c.orderId, budget, { ...(c.signal ? { signal: c.signal } : {}), since });
      // 받을 쪽이 없거나 파드가 멈췄거나 표가 가득 찼다: 다시 읽지 않고 마지막 본문 [정함]
      if (up.wake === 'ABORTED' || up.wake === 'STOPPED' || up.wake === 'FULL') return { status: 200, body: last };
      const again = this.judge(c, up.view ?? (await reads.read(c.orderId)), since);
      if (again.kind !== 'WAIT') return again.result;
      last = again.body;
      // 시간이 다 됐으면 그때의 상태로 답한다(다시 기다리지 않는다)
      if (up.wake === 'TIMEOUT') break;
      // 깨울 것이 아니었다(notify가 아직 기다릴 상태인 주문을 깨웠다): 처음 기다림의 끝까지 남은 몫만 다시 기다린다. 0이면 그때의 상태로 답한다
      budget = Math.max(0, endMono - clock.monotonicMs());
    }
    return { status: 200, body: last };
  }

  /**
   * 주문 모습 하나로 정한다: 없거나 남의 주문이면 404, 바로 답하면 200, 거절이면 409, 기다릴 상태면 WAIT(그때의 본문).
   * since(기다림 시작 때 본문)가 있으면 기다릴 상태라도 깨울 모습(APPROVED의 issueDelayed 거짓 → 참)이면 200으로 답한다
   */
  private judge(
    c: GetPaymentStatusCommand,
    view: PaymentStatusView | undefined,
    since: PaymentStatusBody | undefined,
  ): { kind: 'DONE'; result: GetPaymentStatusResult } | { kind: 'WAIT'; body: PaymentStatusBody } {
    // 남의 주문과 없는 주문은 같은 404다(결정 전에 막는다)
    if (!view || view.accountId !== c.accountId) return { kind: 'DONE', result: { status: 404 } };
    const now = this.deps.clock.now();
    const d = decidePaymentStatus(view, now);
    if (d.kind === 'IMMEDIATE') return { kind: 'DONE', result: { status: 200, body: d.body } };
    if (d.kind === 'REJECT') return { kind: 'DONE', result: { status: 409, reason: d.problem } };
    if (since && paymentStatusWakes(view, since, now)) return { kind: 'DONE', result: { status: 200, body: d.body } };
    return { kind: 'WAIT', body: d.body };
  }
}
