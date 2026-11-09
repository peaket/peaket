// 결제 결과 당기기 실행기(ADR-0140 결정 1~4, docs/features/payment.md §2 '결제 결과 반영', BUILD_ORDER PRF-171 설계 4~7).
// TicketIssueRunner(ticket-issue.ts)·OrderSagaRunner(order-saga.ts)와 같은 꼴이다. 사건 길(trade.payments)을 대신하지 않는 보조 길이다.
// 모든 API 파드가 1초 [가정]마다 틱 하나를 돈다(tick, 앞 틱이 끝나지 않았으면 건너뛴다):
//   ① 잡기: PaymentPullTargets.claimDue(100 [가정])를 동시 요청 자리(파드마다 4개 [가정]) 수만큼까지 차례로 부른다. 잡을 때마다 그 묶음의 호출을 곧바로 시작하고,
//      잡은 수가 100보다 적거나 멈췄으면 더 잡지 않는다(잡기는 짧은 트랜잭션이라 잠금을 쥔 채 payment-svc를 부르지 않는다. pull_next_at = 지금 + 5초 [가정]를 이미 썼다).
//      틱의 첫 묶음은 BatchGetPayments 답을 본 뒤에 다음 묶음을 잡고, 어느 묶음이든 payment-svc가 답하지 못하면(②의 OUTAGE) 그 틱의 남은 잡기를 멈춘다
//      (장애 동안 purchase DB를 두드리지 않게, docs/features/payment.md §2 '기록 없음이 길어질 때', 2026-11-06 코드 리뷰 M2).
//   ② 묶음 하나: PaymentResultReader.batchGet(주문 ID들, 데드라인 500ms [가정]) → 지표 batch.
//      PaymentPullCallError면 지표 failure를 세고(로그 없음, 발권 재시도와 같은 꼴), 코드가 PAYMENT_PULL_OUTAGE_CODES(차단기 열림·UNAVAILABLE·시간 초과)면
//      그 묶음을 지금 + 30초 [가정]로 미루고(OUTAGE), 그 밖의 코드는 다음 점검(5초 [가정] 뒤)이다.
//      예상 밖 예외(PaymentPullCallError가 아님)는 log.runError(batch_get) 한 줄 뒤 지표 failure로 센다(실행기는 멈추지 않는다. 다음 점검 5초 뒤).
//   ③ 대상마다(묶음 안에서 차례로, 같은 묶음의 반영은 한 번에 하나):
//      - 답에 없음(기록 없음): 승인 명령을 보낸 지 10분 [가정]이 지났으면(isPaymentResultMissingLong) log.missing(주문마다 파드 메모리 창 10분 [가정] 안에서 한 번)과
//        다음 점검 10분 [가정] 미루기(파드가 많아도 주문마다 10분에 한 줄, 리뷰 고침 M3), 아니면 아무것도 하지 않는다(다음 점검 5초). 주문을 실패로 단정하지 않는다(PRF-180)
//      - paymentStateToResultEvent(답, { eventId, attemptNo, confirmSentAtMs, pulledAtMs: 지금 }):
//        WAIT(승인 중) → 아무것도 하지 않는다 · IGNORE(CANCELED·MALFORMED) → log.ignored 한 줄과 60초 [가정] 미루기
//        · APPLY → ApplyPaymentResult.execute(사건 길과 같은 처리기, 설계 6): APPLIED면 지표 pulled(type), SKIPPED면 지표 없음
//          (이미 반영한 순번 이하. onOrderChanged·onApproved는 execute에 단 것이 그대로 부른다).
//          PaymentResultHeld(보류)면 10분 [가정] 미루기(보류 로그는 execute가 창 안에 한 번 남겼다. 당기기 길에는 Kafka 오프셋이 없어 held_event에 넣지 않는다,
//          사건 길이 같은 사건을 보류로 옮긴다, 리뷰 고침 M3). PaymentResultConflict·purchase DB 오류 등 그 밖의 예외는 log.runError(apply, 주문 ID).
//          보류가 아니면 답의 상태로 다음 점검을 정한다: UNKNOWN이면 30초 [가정], 입금 대기면 60초 [가정](반영 결과가 건너뜀·오류여도, 같은 순번의 답을
//          5초마다 다시 묻지 않게, 리뷰 고침 H1), 최종 결과(승인·실패)는 반영이 작업 행을 지우거나 RELEASE로 바꾸므로 미루지 않는다(오류면 다음 점검 5초)
//   ④ 미루기: 묶음 하나의 미룰 주문을 간격마다 PaymentPullTargets.defer(주문 ID들, 지금 + 간격) 한 번으로 쓴다. 던지면 log.runError(defer) 뒤 다음 점검(5초)에 다시 묻는다.
//   ①~④는 서로 막지 않는다(하나가 던져도 log.runError 뒤 다음으로 간다). 지표·로그는 던져도 실행기를 막지 않는다.
// 틱은 실행기를 만든 때(시작 파일, 요청·소비자 맥락 밖)의 비동기 맥락에서 돈다(TicketIssueRunner #scope와 같은 까닭: 끝난 맥락의 남은 시간 0을 물려받지 않게).
// SIGTERM에서 stop()은 반복을 끄고 돌던 틱(부르던 BatchGetPayments·반영 포함)을 기다린다. 멈춘 뒤의 틱은 잡지 않는다.
// 같은 주문을 사건 길과 당기기가 함께 반영해도 ApplyPaymentResult의 순번 조건(payment_event_seq)이 하나만 효과를 낸다(P-T15, P-T47).
// 반영 트랜잭션은 넘겨받은 ApplyPaymentResult의 저장소가 쓴다(시작 파일이 고른다). 이 실행기의 전용 풀(연결 2개 [가정])은 잡기·미루기만 쓴다.
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
// 구현에서 정한 것(정본·설계에 없다):
// - 한 틱에 잡는 묶음 수는 concurrency(기본 4) 이하다. 틱이 겹치지 않으므로 파드의 동시 BatchGetPayments도 concurrency를 넘지 않는다
//   (첫 묶음의 답을 본 뒤에 나머지를 잡으므로 실제로는 concurrency − 1개까지 겹친다).
// - 뒤 묶음의 OUTAGE는 그 뒤의 잡기만 멈춘다(이미 잡은 묶음은 부른다. 차단기가 열렸으면 부르지 않고 곧바로 CIRCUIT_OPEN으로 30초 미룬다).
// - 보류(HOLD)로 끝난 UNKNOWN·입금 대기 답은 상태 간격(30초·60초)이 아니라 보류 간격(10분)으로 미룬다(같은 답은 다시 보류된다).
// - 답에 같은 주문이 둘 이상이면 eventSeq가 가장 큰 것을 쓴다. 묻지 않은 주문의 답은 버린다.
// - batchSize·concurrency·pollIntervalMs·deadlineMs가 1 이상의 안전한 정수가 아니면 기본값으로 본다(batchSize는 PAYMENT_PULL_BATCH를 넘지 않는다).
// - 기록 없음 로그 창의 기억은 1,000건 [정함]까지다(넘으면 오래된 것부터 잊는다. 잊으면 한 줄이 더 날 뿐이다, ApplyPaymentResult 보류 로그 창과 같은 꼴).
//   창은 주문마다 PAYMENT_PULL_MISSING_LOG_WINDOW_MS(10분 [가정])이고, 창이 끝나는 시각과 같거나 지나면 다시 한 줄이다.
// - 멈추는 중(stop 뒤)에 끝난 잡기의 묶음은 부르지 않는다(잡기가 쓴 pull_next_at 5초 [가정]가 지나면 다른 파드가 다시 잡는다). 이미 부른 묶음은 반영·미루기까지 마친다.
// - 미룬 수(deferred)는 defer에 넘긴 주문 수다(그 defer가 던지면 그 몫은 0).
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import {
  isPaymentResultMissingLong,
  type OrderPaymentState,
  PAYMENT_PULL_AFTER_DEPOSIT_MS,
  PAYMENT_PULL_AFTER_UNKNOWN_MS,
  PAYMENT_PULL_BATCH,
  PAYMENT_PULL_CONCURRENCY,
  PAYMENT_PULL_DEADLINE_MS,
  PAYMENT_PULL_INTERVAL_MS,
  PAYMENT_PULL_LONG_REPEAT_MS,
  PAYMENT_PULL_MISSING_LOG_WINDOW_MS,
  PAYMENT_PULL_OUTAGE_CODES,
  PAYMENT_PULL_OUTAGE_REPEAT_MS,
  PAYMENT_PULL_SLOW_REPEAT_MS,
  type PaymentPullRunStage,
  paymentStateToResultEvent,
} from '../domain/payment-pull.js';
import type { AppliedPaymentEventType } from '../domain/payment-result.js';
import {
  PaymentPullCallError,
  type PaymentPullLog,
  type PaymentPullSignals,
  type PaymentPullTarget,
  type PaymentPullTargets,
  type PaymentResultReader,
} from '../domain/ports.js';
import { type ApplyPaymentResult, PaymentResultHeld } from './apply-payment-result.js';
import type { SagaTimer } from './order-saga.js';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval·clearInterval). Saga·발권 실행기와 같은 모양 */
export type PaymentPullTimer = SagaTimer;

/** 실행기가 쓰는 포트와 설정 */
export interface PaymentResultPullDeps {
  /** 당기기 대상(order_saga_job CONFIRM·AWAIT 행)의 잡기·미루기. 운영은 당기기 전용 일반 풀 */
  targets: PaymentPullTargets;
  /** payment-svc BatchGetPayments(차단기 payment-svc-batch). local·ci는 '기록 없음' 대역 */
  reader: PaymentResultReader;
  /** 사건 길과 같은 반영 쓰임새(ApplyPaymentResult.execute, 설계 6). onOrderChanged·onApproved는 이 쓰임새에 단다 */
  apply: Pick<ApplyPaymentResult, 'execute'>;
  log: PaymentPullLog;
  signals: PaymentPullSignals;
  /** 당긴 시각·기록 없음 10분·미루기 60초·로그 창의 '지금' */
  clock: Clock;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: PaymentPullTimer;
  /** 반복 간격(기본 PAYMENT_PULL_INTERVAL_MS 1초 [가정]) */
  pollIntervalMs?: number;
  /** 잡기 한 번·BatchGetPayments 한 번의 주문 수(기본 PAYMENT_PULL_BATCH 100 [가정], 그보다 크면 100) */
  batchSize?: number;
  /** 파드의 동시 BatchGetPayments 수 = 한 틱에 잡는 묶음 수의 상한(기본 PAYMENT_PULL_CONCURRENCY 4 [가정]) */
  concurrency?: number;
  /** BatchGetPayments 데드라인(기본 PAYMENT_PULL_DEADLINE_MS 500ms [가정]) */
  deadlineMs?: number;
}

/** 틱 하나의 결과(시험·로그용 수) */
export interface PaymentPullTickResult {
  /** 잡은 대상 수(묶음들의 합) */
  readonly claimed: number;
  /** 부른 BatchGetPayments 수 */
  readonly batches: number;
  /** 실패한 BatchGetPayments 수 */
  readonly failedBatches: number;
  /** 반영한 주문 수(execute가 APPLIED) */
  readonly applied: number;
  /**
   * 다음 점검을 미룬 주문 수(UNKNOWN 30초·입금 대기 60초·취소 상태·모양 틀림 60초·보류·오래 기록 없음 10분·payment-svc가 답하지 못한 묶음 30초 [가정].
   * defer가 던졌으면 세지 않는다)
   */
  readonly deferred: number;
}

/**
 * 결제 결과 당기기 실행기. start()로 1초 반복을 켜고 stop()으로 끈다(돌던 틱을 기다린다). tick()은 틱 하나(머리 주석 ①~④)를 돈다.
 * 같은 주문을 두 파드가 함께 물어도(잡기 사이 5초가 지난 경우) 반영의 순번 조건이 하나만 효과를 낸다
 */
export class PaymentResultPuller {
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  #stopped = false;
  /** 돌고 있는 틱(겹치지 않게 하나만) */
  #ticking: Promise<void> | undefined;
  /** 돌고 있는 틱(stop이 기다린다. tick()을 밖에서 바로 부른 것 포함) */
  readonly #inflight = new Set<Promise<void>>();
  /** 기록 없음 로그를 남긴 주문 → 그 창이 끝나는 시각(epoch ms, 앱 시계). 넣은 차례가 곧 시각 차례다 */
  readonly #missingLogged = new Map<string, number>();
  /** 만든 때(시작 파일, 요청 밖)의 비동기 맥락. 틱이 이 맥락에서 돈다(TicketIssueRunner #scope와 같은 까닭) */
  readonly #scope = new AsyncResource('PaymentResultPuller');

  constructor(private readonly deps: PaymentResultPullDeps) {}

  /** 1초 반복을 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다). 틱이 겹치지 않는다(앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다) */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#loopTick(), positiveIntOr(this.deps.pollIntervalMs, PAYMENT_PULL_INTERVAL_MS));
  }

  /** 반복을 끄고 돌던 틱(부르던 BatchGetPayments와 반영·미루기까지)을 기다린다. 멈춘 뒤의 start·tick은 아무것도 하지 않는다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    // 기다리는 동안 끝난 것은 집합에서 빠진다. 지금 도는 것만 기다린다(멈춘 뒤에는 새로 생기지 않는다)
    await Promise.allSettled([...this.#inflight]);
  }

  /**
   * 틱 하나(머리 주석 ①~④). 던지지 않는다: 단계마다 오류는 log.runError(what = claim·batch_get·apply·defer) 뒤 0으로 센다(다음 틱·다음 점검에 다시).
   * 멈춘 뒤에는 아무것도 하지 않고 0을 돌려준다
   */
  async tick(): Promise<PaymentPullTickResult> {
    if (this.#stopped) return NOTHING;
    const p = this.#tickOnce();
    this.#track(p.then(noop, noop));
    return p;
  }

  // ---- 안쪽 ----

  #timer(): PaymentPullTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  /** 반복 타이머의 틱: 앞 틱이 아직 돌면 건너뛴다. 멈춘 뒤에는 돌지 않는다. 만든 때의 비동기 맥락에서 돈다 */
  #loopTick(): void {
    if (this.#stopped || this.#ticking) return;
    const p = this.#scope.runInAsyncScope(() => this.tick()).then(noop, noop);
    this.#ticking = p;
    void p.finally(() => {
      this.#ticking = undefined;
    });
  }

  /** 틱 하나의 본문(①: 잡을 때마다 그 묶음을 곧바로 시작, ②는 #call, ③·④는 #settle). 단계마다 오류를 삼킨다 */
  async #tickOnce(): Promise<PaymentPullTickResult> {
    const batchSize = Math.min(PAYMENT_PULL_BATCH, positiveIntOr(this.deps.batchSize, PAYMENT_PULL_BATCH));
    const concurrency = positiveIntOr(this.deps.concurrency, PAYMENT_PULL_CONCURRENCY);
    const deadlineMs = positiveIntOr(this.deps.deadlineMs, PAYMENT_PULL_DEADLINE_MS);
    const runs: Promise<BatchResult>[] = [];
    let claimed = 0;
    // payment-svc가 답하지 못한 묶음이 나왔다(리뷰 고침 M2): 그 뒤로는 이 틱에서 잡지 않는다(묶음의 호출이 끝날 때 적는다)
    const tick = { outage: false };
    // 한 틱에 잡는 묶음은 concurrency 이하(틱이 겹치지 않으므로 파드의 동시 BatchGetPayments도 그 이하다). 멈추는 중이면 더 잡지 않는다
    for (let i = 0; i < concurrency && !tick.outage && !this.#stopped; i += 1) {
      let targets: PaymentPullTarget[];
      try {
        targets = await this.deps.targets.claimDue(batchSize);
      } catch (err) {
        // purchase DB를 잠시 못 쓴다: 다음 틱에 다시 잡는다(이미 시작한 묶음은 마친다)
        this.#runError('claim', err);
        break;
      }
      if (targets.length === 0) break;
      claimed += targets.length;
      // 멈추는 중이면 부르지 않는다(머리 주석 '구현에서 정한 것': pull_next_at이 지나면 다른 파드가 다시 잡는다)
      if (this.#stopped) break;
      // 잡기는 이미 커밋했다(잠금 밖): 이 묶음의 호출을 곧바로 시작한다. 반영·미루기는 호출이 끝난 뒤 이어 한다
      const call = this.#call(targets, deadlineMs);
      runs.push(
        call.then((c) => {
          if (c.kind === 'OUTAGE') tick.outage = true;
          return this.#settle(targets, c);
        }),
      );
      // 틱의 첫 묶음은 답을 본 뒤에 다음 묶음을 잡는다(payment-svc가 답하지 못하면 남은 잡기를 멈춘다, 리뷰 고침 M2)
      if (i === 0 && (await call).kind === 'OUTAGE') break;
      if (targets.length < batchSize) break;
    }
    const results = await Promise.all(runs);
    return {
      claimed,
      batches: runs.length,
      failedBatches: results.filter((r) => r.failed).length,
      applied: results.reduce((n, r) => n + r.applied, 0),
      deferred: results.reduce((n, r) => n + r.deferred, 0),
    };
  }

  /**
   * 묶음 하나의 BatchGetPayments(머리 주석 ②). 던지지 않는다: 답(ANSWER), payment-svc가 답하지 못함(OUTAGE: PAYMENT_PULL_OUTAGE_CODES),
   * 그 밖의 실패(FAILED). 부른 수는 성패와 상관없이 센다
   */
  async #call(targets: readonly PaymentPullTarget[], deadlineMs: number): Promise<CallResult> {
    try {
      this.#safe(() => this.deps.signals.batch());
      const states = await this.deps.reader.batchGet(
        targets.map((t) => t.orderId),
        { deadlineMs },
      );
      return { kind: 'ANSWER', states };
    } catch (err) {
      // 호출 실패는 지표만(1분 이어지면 SEV2는 경보식 몫). 예상 밖 예외는 오류 한 줄도 남긴다
      if (!(err instanceof PaymentPullCallError)) this.#runError('batch_get', err);
      this.#safe(() => this.deps.signals.failure());
      return err instanceof PaymentPullCallError && PAYMENT_PULL_OUTAGE_CODES.has(err.code) ? OUTAGE_CALL : FAILED_CALL;
    }
  }

  /** 묶음 하나의 반영·미루기(머리 주석 ③·④). 던지지 않는다 */
  async #settle(targets: readonly PaymentPullTarget[], c: CallResult): Promise<BatchResult> {
    // 그 밖의 실패: 다음 점검(잡기가 쓴 5초 뒤)
    if (c.kind === 'FAILED') return FAILED_BATCH;
    // payment-svc가 답하지 못했다: 그 묶음을 30초 뒤로(장애 동안 purchase DB를 5초마다 두드리지 않게, 리뷰 고침 M2)
    if (c.kind === 'OUTAGE') {
      const deferred = await this.#defer(
        targets.map((t) => t.orderId),
        PAYMENT_PULL_OUTAGE_REPEAT_MS,
      );
      return { failed: true, applied: 0, deferred };
    }
    // 주문마다 답 하나(묻지 않은 주문의 답은 버리고, 같은 주문이 둘 이상이면 eventSeq가 가장 큰 것)
    const asked = new Set(targets.map((t) => t.orderId));
    const answers = new Map<string, OrderPaymentState>();
    for (const s of Array.isArray(c.states) ? c.states : []) {
      if (typeof s !== 'object' || s === null || !asked.has(s.orderId)) continue;
      const seen = answers.get(s.orderId);
      if (seen === undefined || s.eventSeq > seen.eventSeq) answers.set(s.orderId, s);
    }
    // ③ 대상마다 차례로(같은 묶음의 반영은 한 번에 하나). 미룰 주문은 간격마다 모은다(넣은 차례 그대로)
    let applied = 0;
    const later = new Map<number, string[]>();
    const putOff = (orderId: string, gapMs: number): void => {
      const ids = later.get(gapMs);
      if (ids) ids.push(orderId);
      else later.set(gapMs, [orderId]);
    };
    for (const t of targets) {
      const now = this.deps.clock.now();
      const state = answers.get(t.orderId);
      if (state === undefined) {
        // 기록 없음: 오래되면 SEV2 한 줄(창 안에서 한 번)과 10분 미루기(파드가 많아도 주문마다 10분에 한 줄, 리뷰 고침 M3). 주문을 실패로 단정하지 않는다(PRF-180)
        if (isPaymentResultMissingLong(t.confirmSentAtMs, now)) {
          this.#missing(t.orderId, now);
          putOff(t.orderId, PAYMENT_PULL_LONG_REPEAT_MS);
        }
        continue;
      }
      const d = paymentStateToResultEvent(state, { eventId: t.eventId, attemptNo: t.attemptNo, confirmSentAtMs: t.confirmSentAtMs, pulledAtMs: now });
      if (d.kind === 'WAIT') continue;
      if (d.kind === 'IGNORE') {
        this.#safe(() => this.deps.log.ignored({ orderId: t.orderId, reason: d.reason, status: state.status }));
        putOff(t.orderId, PAYMENT_PULL_SLOW_REPEAT_MS);
        continue;
      }
      try {
        const out = await this.deps.apply.execute(d.event);
        if (out.status === 'APPLIED') {
          applied += 1;
          this.#safe(() => this.deps.signals.pulled(d.event.type as AppliedPaymentEventType));
        }
      } catch (err) {
        // 보류: 보류 로그는 execute가 창 안에 한 번 남겼다. 당기기 길에는 Kafka 오프셋이 없어 held_event에 넣지 않고 10분 미룬다
        // (같은 답은 다시 보류된다. 사건 길이 보류 표로 옮긴다, 리뷰 고침 M3)
        if (err instanceof PaymentResultHeld) {
          putOff(t.orderId, PAYMENT_PULL_LONG_REPEAT_MS);
          continue;
        }
        // 경합·purchase DB 오류: 오류 한 줄. 같은 묶음의 다른 주문은 이어 반영한다
        this.#runError('apply', err, t.orderId);
      }
      // 중간 결과는 답의 상태로 다음 점검을 정한다(반영 결과가 건너뜀·오류여도: 같은 순번의 답을 5초마다 다시 묻지 않게, 리뷰 고침 H1).
      // 최종 결과는 반영이 작업 행을 지우거나 RELEASE로 바꾼다(오류였으면 다음 점검 5초 뒤)
      if (d.event.type === 'UNKNOWN') putOff(t.orderId, PAYMENT_PULL_AFTER_UNKNOWN_MS);
      else if (d.event.type === 'AWAITING_DEPOSIT') putOff(t.orderId, PAYMENT_PULL_AFTER_DEPOSIT_MS);
    }
    // ④ 간격마다 defer 한 번
    let deferred = 0;
    for (const [gapMs, ids] of later) deferred += await this.#defer(ids, gapMs);
    return { failed: false, applied, deferred };
  }

  /** 그 주문들의 다음 점검을 지금 + gapMs로 미룬다. 미룬 수(넘긴 주문 수)이고, 던지면 log.runError(defer) 뒤 0(다음 점검 = 잡기가 쓴 5초 뒤) */
  async #defer(orderIds: string[], gapMs: number): Promise<number> {
    try {
      await this.deps.targets.defer(orderIds, this.deps.clock.now() + gapMs);
      return orderIds.length;
    } catch (err) {
      this.#runError('defer', err);
      return 0;
    }
  }

  /** 기록 없음 SEV2 한 줄(주문마다 창 안에서 한 번). 창이 지난 기억은 앞에서부터 지우고, 기억은 MISSING_MEMO_MAX건까지다 */
  #missing(orderId: string, now: number): void {
    for (const [id, until] of this.#missingLogged) {
      if (until > now) break;
      this.#missingLogged.delete(id);
    }
    if (this.#missingLogged.has(orderId)) return;
    this.#missingLogged.set(orderId, now + PAYMENT_PULL_MISSING_LOG_WINDOW_MS);
    while (this.#missingLogged.size > MISSING_MEMO_MAX) {
      const oldest = this.#missingLogged.keys().next().value;
      if (oldest === undefined) break;
      this.#missingLogged.delete(oldest);
    }
    this.#safe(() => this.deps.log.missing({ orderId }));
  }

  /** stop이 기다릴 일로 적고, 끝나면 뺀다 */
  #track(p: Promise<void>): void {
    const tracked = p.finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
  }

  #runError(what: PaymentPullRunStage, err: unknown, orderId?: string): void {
    this.#safe(() => this.deps.log.runError(orderId !== undefined ? { what, orderId, err } : { what, err }));
  }

  /** 로그·지표는 던지지 않기로 했지만, 던져도 실행기를 막지 않는다 */
  #safe(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

/** 묶음 하나의 결과 */
interface BatchResult {
  readonly failed: boolean;
  readonly applied: number;
  readonly deferred: number;
}

/** 묶음 하나의 BatchGetPayments 결과(#call): 답, payment-svc가 답하지 못함, 그 밖의 실패 */
type CallResult = { readonly kind: 'ANSWER'; readonly states: OrderPaymentState[] } | { readonly kind: 'OUTAGE' } | { readonly kind: 'FAILED' };

/** 기록 없음 로그 창의 기억 상한 1,000건 [정함](머리 주석 '구현에서 정한 것') */
const MISSING_MEMO_MAX = 1_000;

const noop = (): undefined => undefined;
const NOTHING: PaymentPullTickResult = Object.freeze({ claimed: 0, batches: 0, failedBatches: 0, applied: 0, deferred: 0 });
const FAILED_BATCH: BatchResult = Object.freeze({ failed: true, applied: 0, deferred: 0 });
const OUTAGE_CALL: CallResult = Object.freeze({ kind: 'OUTAGE' });
const FAILED_CALL: CallResult = Object.freeze({ kind: 'FAILED' });

/** 1 이상의 안전한 정수면 그 값, 아니면 기본값 */
const positiveIntOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : fallback);

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: PaymentPullTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
