// 결제 결과 반영 쓰임새(docs/features/payment.md §2 '결제 결과 반영의 첫 구현', §3 T9~T17, docs/data.md §5 '결제 결과 반영', BUILD_ORDER PRF-163).
// trade.payments PaymentEvent 하나를 주문에 반영하는 함수 하나다. 키 단위 처리기(inbound/payment-result.handler.ts, 주문 ID, ADR-0142)와
// 결과 당기기(PRF-171)가 같은 execute를 부른다. 처리기를 서비스에 붙이는 일은 PRF-164다.
// 차례: PaymentResultReads.read → decidePaymentResult → (APPLY) PaymentResultWrites.approve·fail·mark(한 트랜잭션) → 커밋 뒤 일
//   (승인·입금 대기면 구매 세션 끝내기, 실패면 Paying 풀기와 Saga 깨우기. 최선을 다할 뿐 실패해도 반영은 그대로다)
//   → 승인이면 발권 실행기 깨우기(onApproved → TicketIssueRunner.kick, BUILD_ORDER PRF-170).
// 보류(HOLD)는 PaymentResultHeld를 던진다: 같은 결과일 실패라 키 단위 소비자가 5회 [가정] 해 본 뒤 held_event로 옮기고 같은 주문의 뒤 사건도 보류한다.
// purchase DB 연결 실패·시간 초과는 그대로 던진다: 플랫폼 isTransientError가 일시 실패로 보고 파티션을 멈춰 기다린다(packages/platform keyed-consumer.ts).
// 이 층은 어댑터·계약 패키지를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
import type { Clock } from '@peaket/platform';
import { transitionById } from '../domain/order.js';
import { PAYMENT_STATUS_IMMEDIATE } from '../domain/payment-status.js';
import {
  decidePaymentResult,
  PAYMENT_RESULT_ACTOR,
  PAYMENT_RESULT_HOLD_LOG,
  PAYMENT_RESULT_SESSION_DONE_STATUSES,
  approvalIssueDueAtMs,
  type PaymentEventType,
  type PaymentResultDecision,
  type PaymentResultEvent,
  type PaymentResultHoldReason,
  type PaymentResultSkipReason,
  type PaymentResultTransition,
  type PaymentResultWrite,
} from '../domain/payment-result.js';
import type {
  PaymentResultLog,
  PaymentResultOrder,
  PaymentResultReads,
  PaymentResultSessions,
  PaymentResultWriteOutcome,
  PaymentResultWrites,
  SagaWake,
} from '../domain/ports.js';

/**
 * 쓰기가 STALE(지금 상태가 출발이 아님)일 때 주문을 다시 읽어 한 번 더 정하는 횟수 1번 [정함: 정본에 없다].
 * 다시 정해도 STALE이면 PaymentResultConflict를 던져 처리기가 다시 해 보게 한다(같은 주문의 사건은 처리기가 하나씩 하므로 거의 일어나지 않는다)
 */
export const PAYMENT_RESULT_STALE_RETRIES = 1;

/**
 * 같은 사건(eventKey)·같은 까닭의 보류 로그를 다시 남기지 않는 시간 창 60초 [정함: 정본에 없다](리뷰 L5).
 * 키 단위 소비자가 같은 결과일 실패를 5회 [가정] 해 보는 쉬기의 합(0.2 + 0.4 + 0.8 + 1.6초)보다 넉넉히 길다. 보류 확정은 플랫폼 onHeld가 한 번 남긴다
 */
export const PAYMENT_RESULT_HELD_LOG_WINDOW_MS = 60_000;
/** 그 창 안에 기억하는 사건 수 상한 [정함](넘으면 오래된 것부터 잊는다. 잊으면 한 줄이 더 날 뿐이다) */
const HELD_LOG_MEMO_MAX = 1_000;

/** 쓰임새가 쓰는 포트와 설정 */
export interface ApplyPaymentResultDeps {
  reads: PaymentResultReads;
  writes: PaymentResultWrites;
  /** 커밋 뒤 구매 세션 끝내기·Paying 풀기 */
  sessions: PaymentResultSessions;
  /** 커밋 뒤 Saga 실행기 깨우기(실패 반영 뒤 RELEASE 작업) */
  saga: SagaWake;
  log: PaymentResultLog;
  /** 보류 로그를 다시 남기지 않는 시간 창의 '지금'과 T13 발권 기한의 반영 시각. T9·T16의 발권 기한에는 쓰지 않는다(사건의 occurredAt을 쓴다) */
  clock: Clock;
  /**
   * 전이를 커밋한 뒤 부를 것(결제 결과 long polling의 기다림 깨우기, PaymentStatusWaiters.notify, BUILD_ORDER PRF-166). 던지지 않는다.
   * APPLIED이고 바로 답할 상태로 간 전이(T10·T11·T12·T14·T15·T17)일 때만, 커밋 뒤 일(구매 세션 끝내기·Paying 풀기)을 마치고 부른다.
   * APPROVED로 가는 전이(T9·T13·T16)는 기다리는 상태라 부르지 않는다(리뷰 고침 L3). 없으면 부르지 않는다
   */
  onOrderChanged?: (orderId: string) => void;
  /**
   * 승인 전이(T9·T13·T16, ticket_issue_job 한 행을 넣는다)를 커밋한 뒤 부를 것(발권 실행기 깨우기, TicketIssueRunner.kick, BUILD_ORDER PRF-170).
   * APPLIED이고 쓰기 갈래가 APPROVE일 때만, 커밋 뒤 일(구매 세션 끝내기)을 마치고 부른다. 던지지 않는다(던져도 반영 결과는 그대로다). 없으면 부르지 않는다.
   * 건너뛴 사건(DUPLICATE·ALREADY_THERE 등)에는 부르지 않는다(큐 행을 넣은 커밋이 아니다. 남은 큐 행은 실행기의 틱이 줍는다)
   */
  onApproved?: (orderId: string) => void;
}

/**
 * 반영 결과(던지지 않은 길).
 * - APPLIED: 전이를 커밋했다(write = 쓰기 갈래)
 * - SKIPPED: 건너뛰었다(결정의 SKIP, 또는 쓰기가 STALE PAYMENT_SEQ라 다시 온 사건으로 본 DUPLICATE)
 */
export type ApplyPaymentResultOutcome =
  | { readonly status: 'APPLIED'; readonly transition: PaymentResultTransition; readonly write: PaymentResultWrite }
  | { readonly status: 'SKIPPED'; readonly reason: PaymentResultSkipReason };

/**
 * 보류 표지: 처리하지 않고 보류한다(held_event, 같은 주문의 뒤 사건도 함께. 경보 수준은 까닭마다 PAYMENT_RESULT_HOLD_LOG). 같은 결과일 실패라 키 단위 소비자가 일시 실패로 보지 않는다
 * (이름이 TransientError·TimeoutError·AbortError가 아니고 code·cause를 싣지 않는다). 글에는 까닭만 싣는다(금액·결제 참조를 싣지 않는다: 보류 행 error 칸에 남는다)
 */
export class PaymentResultHeld extends Error {
  constructor(
    readonly reason: PaymentResultHoldReason,
    readonly orderId: string,
    readonly eventType: PaymentEventType,
  ) {
    super(`결제 결과를 반영하지 않고 보류한다: ${reason}`);
    this.name = 'PaymentResultHeld';
  }
}

/**
 * 다시 정해도 쓰기가 STALE(지금 상태가 출발이 아님)로 끝났다. 같은 결과일 실패로 보아(일시 실패 아님) 처리기가 다시 해 보고, 5회 뒤 보류한다 [정함]
 */
export class PaymentResultConflict extends Error {
  constructor(readonly orderId: string) {
    super('결제 결과 반영이 주문 상태 경합으로 끝나지 못했다');
    this.name = 'PaymentResultConflict';
  }
}

export class ApplyPaymentResult {
  /** 보류 로그를 남긴 사건(eventKey + 까닭) → 그 창이 끝나는 시각(epoch ms). 넣은 차례가 곧 시각 차례다 */
  readonly #heldLogged = new Map<string, number>();

  constructor(private readonly deps: ApplyPaymentResultDeps) {}

  /**
   * 결제 사건 하나를 주문에 반영한다.
   * - 결정이 SKIP이면 SKIPPED(로그 없음). 승인된 주문(PAYMENT_RESULT_SESSION_DONE_STATUSES)의 DUPLICATE·ALREADY_THERE면 구매 세션 끝내기만 다시 부른다(리뷰 L1)
   * - 결정이 HOLD이면 로그 한 줄(held, 같은 사건·까닭은 창 안에서 한 번) 뒤 PaymentResultHeld를 던진다
   * - APPLY면 쓰기 갈래(approve: issueDueAtMs = approvalIssueDueAtMs(전이, event.occurredAt, 지금), fail: release = 주문의 회차·계정·좌석, mark)로 한 트랜잭션.
   *   STALE PAYMENT_SEQ → SKIPPED DUPLICATE, STALE NOT_FOUND → HOLD IMPOSSIBLE, SOLD_MISMATCH → HOLD SOLD_MISMATCH(리뷰 M4),
   *   STALE STATUS → 다시 읽고 PAYMENT_RESULT_STALE_RETRIES번 더 정한다(그래도면 PaymentResultConflict)
   * - 커밋 뒤: APPROVE·MARK의 T10·T14(입금 대기)면 sessions.complete, FAIL이면 saga.kick과 sessions.unmarkPaying. T12(UNKNOWN)는 아무것도 하지 않는다 [정함: 결과가 정해지지 않았다].
   *   구매 세션 일이 던지면 log.afterCommitFailed 한 줄만 남기고 결과는 그대로다. 그 뒤 APPROVE(T9·T13·T16)면 onApproved(발권 실행기 깨우기, PRF-170)를 한 번 부른다
   * @throws PaymentResultHeld 보류(같은 결과일 실패) · PaymentResultConflict 경합이 풀리지 않음
   * @throws Error purchase DB 오류(연결 실패·시간 초과는 처리기가 일시 실패로 본다)
   */
  async execute(event: PaymentResultEvent): Promise<ApplyPaymentResultOutcome> {
    let order = await this.deps.reads.read(event.orderId);
    for (let retry = 0; ; retry += 1) {
      const d = decidePaymentResult(event, order);
      if (d.kind === 'SKIP') {
        // 승인된 주문에 다시 온 사건: 커밋 뒤 구매 세션 끝내기가 한 번 실패했을 수 있어 그것만 다시 한다(Paying 풀기는 하지 않는다)
        if (order && (d.reason === 'DUPLICATE' || d.reason === 'ALREADY_THERE') && PAYMENT_RESULT_SESSION_DONE_STATUSES.has(order.status)) {
          const o = order;
          await this.#bestEffort(o.orderId, 'complete_session', () => this.deps.sessions.complete(o.purchaseSessionId));
        }
        return { status: 'SKIPPED', reason: d.reason };
      }
      if (d.kind === 'HOLD') throw this.#held(event, d.reason);
      // APPLY는 주문이 있을 때만 나온다(결정 ①)
      const o = order;
      if (o === undefined) throw new Error('주문 없이 반영 결정이 나왔다(코드 오류)');
      const out = await this.#write(d, event, o);
      if (out.status === 'APPLIED') {
        await this.#afterCommit(d, o);
        // 바로 답할 상태로 갔으면(실패·입금 대기·UNKNOWN) 구매 세션 일(끝내기·Paying 풀기)을 마친 뒤 이 주문을 기다리는 long polling을 깨운다
        // (브라우저가 결과를 받고 움직일 때 세션이 정리돼 있게). APPROVED(T9·T13·T16)는 기다리는 상태라 깨우지 않는다(PRF-166 리뷰 고침 L3)
        const to = transitionById(d.transition)?.to;
        if (to !== undefined && PAYMENT_STATUS_IMMEDIATE.has(to)) this.#orderChanged(o.orderId);
        // 승인(T9·T13·T16)은 같은 트랜잭션에서 발권 재시도 큐 행을 넣었다: 커밋 뒤 일을 마친 뒤 발권 실행기를 곧바로 한 번 깨운다(1초 틱을 기다리지 않는다, PRF-170)
        if (d.write === 'APPROVE') this.#approved(o.orderId);
        return { status: 'APPLIED', transition: d.transition, write: d.write };
      }
      // 판매 행이 좌석 수만큼 SOLD가 되지 않았다(되돌렸다): 과금됐는데 좌석을 줄 수 없다
      if (out.status === 'SOLD_MISMATCH') throw this.#held(event, 'SOLD_MISMATCH');
      // 커밋하지 않았다(트랜잭션째 되돌림). 그 순번 이상을 이미 반영했으면 다시 온 사건이다
      if (out.reason === 'PAYMENT_SEQ') return { status: 'SKIPPED', reason: 'DUPLICATE' };
      // 그사이 주문이 없어졌다: 없는 주문과 같은 까닭으로 보류한다
      if (out.reason === 'NOT_FOUND') throw this.#held(event, 'IMPOSSIBLE');
      // 지금 상태가 출발이 아니다: 다시 읽어 한 번 더 정한다. 그래도면 경합으로 끝낸다
      if (retry >= PAYMENT_RESULT_STALE_RETRIES) throw new PaymentResultConflict(event.orderId);
      order = await this.deps.reads.read(event.orderId);
    }
  }

  /** 결정의 쓰기 갈래 하나(한 트랜잭션). 회차·좌석·계정은 사건이 아니라 주문의 것이다(사건 eventId는 Kafka 키로 쓰는 회차다) */
  #write(d: ApplyDecision, event: PaymentResultEvent, o: PaymentResultOrder): Promise<PaymentResultWriteOutcome> {
    const base = { orderId: o.orderId, paymentEventSeq: event.eventSeq, actor: PAYMENT_RESULT_ACTOR };
    switch (d.write) {
      case 'APPROVE':
        return this.deps.writes.approve({ ...base, transition: d.transition, eventId: o.eventId, seatIds: o.seatIds, issueDueAtMs: approvalIssueDueAtMs(d.transition, event.occurredAt, this.deps.clock.now()) });
      case 'FAIL':
        return this.deps.writes.fail({
          ...base,
          transition: d.transition,
          failureReason: d.failureReason,
          eventId: o.eventId,
          release: { eventId: o.eventId, orderId: o.orderId, accountId: o.accountId, seatIds: o.seatIds },
        });
      case 'MARK':
        return this.deps.writes.mark({ ...base, transition: d.transition });
    }
  }

  /**
   * 커밋 뒤 일(최선을 다할 뿐, 던지지 않는다). 승인·입금 대기(T10·T14)는 구매 세션 끝내기, 실패는 Saga 깨우기(RELEASE 작업)와 Paying 풀기,
   * UNKNOWN(T12)은 결과가 정해지지 않아 아무것도 하지 않는다
   */
  async #afterCommit(d: ApplyDecision, o: PaymentResultOrder): Promise<void> {
    if (d.write === 'FAIL') {
      // 좌석 실패 해제가 늦지 않게 Paying 풀기의 성패와 상관없이 깨운다
      this.deps.saga.kick(o.orderId);
      await this.#bestEffort(o.orderId, 'unmark_paying', () => this.deps.sessions.unmarkPaying(o.purchaseSessionId));
      return;
    }
    if (d.write === 'APPROVE' || d.transition === 'T10' || d.transition === 'T14') {
      await this.#bestEffort(o.orderId, 'complete_session', () => this.deps.sessions.complete(o.purchaseSessionId));
    }
  }

  /** 전이를 커밋한 뒤 부른다(onOrderChanged가 있을 때만). 던지지 않기로 했지만, 던져도 반영 결과는 그대로다 */
  #orderChanged(orderId: string): void {
    try {
      this.deps.onOrderChanged?.(orderId);
    } catch {
      // 삼킨다(기다리는 요청은 묶음 조회·시간으로 깬다)
    }
  }

  /** 승인 전이를 커밋한 뒤 부른다(onApproved가 있을 때만). 던지지 않기로 했지만, 던져도 반영 결과는 그대로다(큐 행은 틱이 줍는다) */
  #approved(orderId: string): void {
    try {
      this.deps.onApproved?.(orderId);
    } catch {
      // 삼킨다(발권 실행기의 1초 틱이 큐 행을 잡는다)
    }
  }

  async #bestEffort(orderId: string, what: 'complete_session' | 'unmark_paying', fn: () => Promise<boolean>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.log.afterCommitFailed({ orderId, what, errorName: err instanceof Error ? err.name : typeof err });
    }
  }

  /**
   * 보류 로그 한 줄과 보류 표지. 로그는 주문 ID·사건 종류·결제사·까닭과 까닭의 수준·표시만 싣는다(금액·결제 참조는 싣지 않는다).
   * 같은 사건·까닭은 PAYMENT_RESULT_HELD_LOG_WINDOW_MS 안에서 한 번만 남긴다(리뷰 L5)
   */
  #held(event: PaymentResultEvent, reason: PaymentResultHoldReason): PaymentResultHeld {
    if (this.#firstHeldLog(`${event.eventKey}:${reason}`)) {
      const { severity, kind } = PAYMENT_RESULT_HOLD_LOG[reason];
      this.deps.log.held({ orderId: event.orderId, type: event.type, pg: event.pg, reason, severity, ...(kind !== undefined ? { kind } : {}) });
    }
    return new PaymentResultHeld(reason, event.orderId, event.type);
  }

  /** 이 사건·까닭의 보류 로그를 창 안에서 처음 남기면 true(기억한다). 창이 지난 것은 앞에서부터 지운다 */
  #firstHeldLog(key: string): boolean {
    const now = this.deps.clock.now();
    for (const [k, until] of this.#heldLogged) {
      if (until > now) break;
      this.#heldLogged.delete(k);
    }
    const until = this.#heldLogged.get(key);
    if (until !== undefined && until > now) return false;
    this.#heldLogged.delete(key);
    this.#heldLogged.set(key, now + PAYMENT_RESULT_HELD_LOG_WINDOW_MS);
    if (this.#heldLogged.size > HELD_LOG_MEMO_MAX) {
      const oldest = this.#heldLogged.keys().next().value;
      if (oldest !== undefined) this.#heldLogged.delete(oldest);
    }
    return true;
  }
}

/** 결정 가운데 APPLY 갈래 */
type ApplyDecision = Extract<PaymentResultDecision, { kind: 'APPLY' }>;
