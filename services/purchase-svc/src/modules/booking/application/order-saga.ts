// 주문 Saga 1단계 실행기(docs/features/payment.md §2 'Saga 1단계의 첫 구현', docs/data.md §5 'Saga 1단계', BUILD_ORDER PRF-165).
// 결제 접수가 커밋된 직후 같은 파드가 그 주문의 작업을 비동기로 한 번 돌리고(kick), 모든 API 파드가 1초 [가정]마다 기한이 된 작업을
// 짧은 트랜잭션으로 20건 [가정]까지 집어(임대 15초 [가정]) 커밋한 뒤 돈다(pollOnce). 잠금을 쥔 채 바깥 호출(좌석 Redis·payment-svc)을 하지 않는다.
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
//
// 단계 RESERVE(reserveStep):
//   ① 승인 기한(인증 + 10분)을 넘겼으면 묶지 않고 T8(EXPIRED)과 실패 해제
//   ② 좌석 묶기 pin(holdId·psid·좌석·1인 한도·주문 seat_gen): OK면 주문 seat_gen(그 판 번호, 명세 pin)과 pinned_at(PRF-167)을 한 UPDATE로 적고 ③,
//      TAKEN·QUOTA_EXCEEDED·STALE_GEN이면 T8(같은 이름의 사유)과 실패 해제, NOT_READY면 다시 하기(회차 키 수명(판매 종료 + 1일)이 지났으면 T8 STORE_GONE),
//      FAILED_HOLD면 이미 실패 해제한 홀드라 SKIPPED
//   ③ 판매 예약 트랜잭션(ReserveTx): RESERVED면 ADVANCED(같은 실행에서 CONFIRM을 이어 돈다), GEN_CHANGED면 주문 판 번호를 고치지 않고 그대로 ②부터 다시
//      (내 홀드가 남았을 때만 OK, 빈 좌석이면 STALE_GEN → T8. 명세 saleStep, 리뷰 M1. SAGA_GEN_RESTART_MAX번 넘으면 다시 하기),
//      SEAT_TAKEN·QUOTA_EXCEEDED면 T8과 실패 해제, ORDER_STATE면 건너뛰기(아래)
// 단계 CONFIRM(confirmStep, 리뷰 H1):
//   승인 기한을 넘겼고 승인 명령을 한 번도 보내지 않았으면(작업 행 confirm_sent_at 비움. 예: 차단기 열림만 계속) T11(EXPIRED, 판매 행 PENDING 지우기)과 실패 해제.
//   그 밖에는 ConfirmPayment(데드라인 min(200ms, 기한까지 남은 시간), 기한이 지났으면 200ms)를 보낸다. 보내기 바로 전에 confirm_sent_at을 적고 커밋한다
//   (어댑터의 beforeSend. 적지 못하면 보내지 않고 SKIPPED LEASED). 한 번이라도 보냈으면 기한이 지나도 혼자 T11을 하지 않고 같은 주문 ID로 계속 다시 보낸다
//   (결과를 모르는 명령이 payment-svc에 적혔을 수 있다. 결과는 trade.payments로 온다, PRF-163).
//   ACCEPTED면 ConfirmSent.done(결제 참조 지우기, 작업 행은 지우지 않고 AWAIT로 남긴다. 결과 당기기가 찾는다, PRF-171) → DONE,
//   RETRYABLE이면 다시 하기(1초에서 두 배, 최대 10초),
//   REJECTED면 SEV2 오류 로그 뒤 작업을 SAGA_CONFIRM_PARK_MS(1시간 [가정]) 멈춘다(결과 당기기 PRF-171이 맞춘다)
// 단계 RELEASE(releaseStep, 리뷰 M4): 실패 기록 뒤 실패 해제가 끝나지 못한 작업. 해제가 OK이거나 회차 키 수명 뒤의 NOT_READY면 작업 행을 지우고, 아니면 다시 한다.
// 실패의 차례: DB 실패 기록(SagaFailures.fail, 커밋. 작업 행 RELEASE) → 실패 해제(OrderSeatPins.releaseFailed) → 끝나면 작업 행 지우기, 못 끝나면 warn 한 줄과 다시 하기.
//   실패 기록이 STALE(작업 행이 그 단계가 아니거나 주문이 그 사이 다른 상태로 감)이면 실패 해제를 하지 않고 그 자리에서 다시 하기로 미뤄 임대를 푼다(리뷰 M3).
// ORDER_STATE로 건너뛸 때(리뷰 M3): SagaJobs.abandon이 주문이 그 단계를 지났으면 작업 행·결제 참조를 지우고, 아니면 다시 하기로 미룬다.
// 다시 하기: SagaJobs.reschedule(지금 + sagaRetryDelayMs(attempts + 1)). 예상 밖 예외도 log.stepError 뒤 다시 하기다(실행기는 멈추지 않는다).
// 작업 행을 바꾸는 포트(reschedule·done·fail·delete·markConfirmSent·abandon·release)에는 늘 집은 작업의 임대 값을 조건으로 넘긴다(리뷰 낮음).
// pollOnce는 다음 작업을 시작하기 전에 남은 임대를 보고 SAGA_LEASE_MIN_REMAINING_MS(5초 [가정]) 미만이면 그 작업을 놓고, 멈춘 뒤(stop)에는 남은 작업의 임대를 놓는다.
// 정함(정본에 없다): kick·틱은 실행기를 만든 때(시작 파일, 요청 밖)의 비동기 맥락에서 돈다. 결제 접수 요청의 맥락(남은 시간·요청 로그)을 물려받으면
//   202를 보낸 뒤 남은 시간이 0이라 차단기·gRPC가 승인 명령을 부르지 않는다. 회차 좌석맵 판이 없으면 설정 오류로 보고 오류 로그 뒤 다시 한다.
import { AsyncResource } from 'node:async_hooks';
import { type Clock, type HotPathMetrics, timeHotPath } from '@peaket/platform';
import {
  type ConfirmRefs,
  type ConfirmSent,
  OrderSeatStoreUnavailable,
  type OrderSeatPins,
  type PaymentConfirms,
  type ReserveTx,
  type SagaEventConfig,
  type SagaEventConfigs,
  type SagaFailInput,
  type SagaFailures,
  type SagaJob,
  type SagaJobs,
  type SagaLog,
  type SagaOrders,
  type SagaOrderView,
} from '../domain/ports.js';
import {
  CONFIRM_CALL_DEADLINE_MS,
  confirmDeadlineAtMs,
  isPastConfirmDeadline,
  isSeatStoreGone,
  SAGA_CLAIM_LIMIT,
  SAGA_CONFIRM_PARK_MS,
  SAGA_GEN_RESTART_MAX,
  SAGA_LEASE_MIN_REMAINING_MS,
  SAGA_LEASE_MS,
  SAGA_POLL_INTERVAL_MS,
  SEAT_KEYS_KEEP_AFTER_SALE_END_MS,
  type SagaFailTransition,
  type SagaFailureReason,
  type SagaRetryReason,
  sagaRetryDelayMs,
  type SagaStep,
  type SagaStepOutcome,
} from '../domain/saga.js';

/** Saga 행위자(order_event.actor, ACTOR_PATTERN의 system:<작업 이름>) */
export const ORDER_SAGA_ACTOR = 'system:order-saga';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 setInterval·clearInterval) */
export interface SagaTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 실행기가 쓰는 포트와 설정 */
export interface OrderSagaDeps {
  jobs: SagaJobs;
  orders: SagaOrders;
  reserve: ReserveTx;
  failures: SagaFailures;
  confirmSent: ConfirmSent;
  pins: OrderSeatPins;
  confirms: PaymentConfirms;
  configs: SagaEventConfigs;
  log: SagaLog;
  clock: Clock;
  /** Saga 예약·승인 명령 구간 진단(BAT-029). 없으면 계측하지 않는다 */
  hotPath?: HotPathMetrics;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: SagaTimer;
  /** 폴링 간격(기본 SAGA_POLL_INTERVAL_MS 1초 [가정]) */
  pollIntervalMs?: number;
  /** 한 번에 집는 수(기본 SAGA_CLAIM_LIMIT 50 [가정]) */
  claimLimit?: number;
  /** 임대 길이(기본 SAGA_LEASE_MS 30초 [가정]) */
  leaseMs?: number;
  /**
   * 주문을 바로 답할 상태로 바꾼 뒤(T8·T11 실패 기록을 커밋하고 실패 해제·작업 행 정리를 마친 뒤) 부를 것(결제 결과 long polling의 기다림 깨우기,
   * PaymentStatusWaiters.notify, BUILD_ORDER PRF-166). T7(RESERVED)은 기다리는 상태라 부르지 않는다(리뷰 고침 L3).
   * 던지지 않는다(던져도 실행기는 삼킨다). 없으면 부르지 않는다
   */
  onOrderChanged?: (orderId: string) => void;
}

/** runOne의 결과: 집지 못했으면 SKIPPED(NO_JOB·LEASED), 아니면 마지막 단계의 결과 */
export type SagaRunResult = SagaStepOutcome;

/** 보낸 시각을 적지 못했다(임대를 잃었거나 작업 행이 그 사이 바뀌었다). 승인 명령을 보내지 않는다(밖으로 새지 않는다) */
class LeaseLost extends Error {
  constructor() {
    super('승인 명령을 보내기 전에 작업 행의 보낸 시각을 적지 못했다(임대를 잃었다)');
    this.name = 'LeaseLost';
  }
}

/**
 * 주문 Saga 실행기. start()로 1초 반복을 켜고 stop()으로 끈다(돌던 틱을 기다린다). kick(orderId)은 결제 접수 커밋 직후 비동기로 한 번 돈다
 * (기다리지 않고 던지지 않는다. 오류는 log.stepError). 같은 작업을 두 파드가 함께 돌아도 주문 전이·작업 행 갱신이 조건부라 하나만 효과가 있다.
 */
export class OrderSagaRunner {
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  #stopped = false;
  /** 돌고 있는 틱(겹치지 않게 하나만) */
  #ticking: Promise<void> | undefined;
  /** 돌고 있는 틱·kick(stop이 기다린다) */
  readonly #inflight = new Set<Promise<void>>();
  /**
   * 만든 때(시작 파일, 요청 밖)의 비동기 맥락. kick은 결제 접수 요청 안에서 불리지만 202를 보낸 뒤에도 돌므로, 요청 맥락(남은 시간·요청 로그)을 물려받지 않게
   * 이 맥락에서 돈다(물려받으면 차단기·gRPC가 끝난 요청의 남은 시간 0으로 승인 명령을 부르지 않는다)
   */
  readonly #scope = new AsyncResource('OrderSagaRunner');

  constructor(private readonly deps: OrderSagaDeps) {}

  /** 1초 반복을 켠다(이미 켰으면 아무것도 하지 않는다). 틱이 겹치지 않는다(앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다) */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    const timer = this.deps.timer ?? DEFAULT_TIMER;
    this.#handle = timer.setInterval(() => this.#tick(), this.deps.pollIntervalMs ?? SAGA_POLL_INTERVAL_MS);
  }

  /** 반복을 끄고 돌던 틱·kick을 기다린다(틱이 집었지만 아직 시작하지 않은 작업은 임대를 놓는다) */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      (this.deps.timer ?? DEFAULT_TIMER).clearInterval(this.#handle);
      this.#handle = undefined;
    }
    // 기다리는 동안 끝난 것은 집합에서 빠진다. 지금 도는 것만 기다린다(멈춘 뒤에는 새로 생기지 않는다)
    await Promise.allSettled([...this.#inflight]);
  }

  /**
   * 기한이 된 작업을 집어(claimDue) 차례로 돈다. 집은 작업 수를 돌려준다. 던지지 않는다(집기 실패는 log.stepError 없이 0, 다음 틱에 다시).
   * 작업마다 시작 전에 멈췄거나 남은 임대가 SAGA_LEASE_MIN_REMAINING_MS 미만이면 돌지 않고 임대를 놓는다(다음 틱에 다시 집힌다)
   */
  async pollOnce(): Promise<number> {
    let jobs: SagaJob[];
    try {
      jobs = await this.deps.jobs.claimDue(this.deps.claimLimit ?? SAGA_CLAIM_LIMIT, this.#leaseMs());
    } catch {
      // purchase DB를 잠시 못 쓴다: 다음 틱에 다시 집는다(작업 하나의 오류가 아니라 stepError를 남기지 않는다)
      return 0;
    }
    // 차례로 돈다(runJob은 던지지 않는다. 한 작업의 오류가 다른 작업을 막지 않는다)
    for (const job of jobs) {
      const left = (job.leaseUntilMs ?? 0) - this.deps.clock.now();
      if (this.#stopped || left < SAGA_LEASE_MIN_REMAINING_MS) {
        await this.#releaseLease(job);
        continue;
      }
      await this.runJob(job);
    }
    return jobs.length;
  }

  /** 그 주문의 작업을 집어(claim) 돈다. 집지 못하면 SKIPPED NO_JOB(행 없음)·LEASED(다른 실행이 임대 중이거나 기한 전) */
  async runOne(orderId: string): Promise<SagaRunResult> {
    const job = await this.deps.jobs.claim(orderId, this.#leaseMs());
    if (!job) {
      // 집지 못한 까닭을 가른다(행이 있으면 다른 실행이 임대 중이거나 다시 하기 기한 전이다)
      const row = await this.deps.jobs.get(orderId);
      return { kind: 'SKIPPED', reason: row ? 'LEASED' : 'NO_JOB' };
    }
    return this.runJob(job);
  }

  /** 결제 접수 커밋 직후 부른다: runOne을 비동기로 한 번(기다리지 않는다, 던지지 않는다). 멈춘 뒤(stop)에는 부르지 않는다 */
  kick(orderId: string): void {
    if (this.#stopped) return;
    this.#track(
      this.#scope.runInAsyncScope(() => this.runOne(orderId)).then(
        () => undefined,
        (err: unknown) => {
          // 집기가 던졌다(purchase DB 장애). 작업 행은 남아 있어 폴링이 다시 줍는다. 접수 직후라 단계는 RESERVE다
          this.#stepError(orderId, 'RESERVE', err);
        },
      ),
    );
  }

  /**
   * 집은 작업 하나를 돈다: 주문을 읽고 step에 따라 reserveStep·confirmStep·releaseStep(RESERVE가 ADVANCED면 CONFIRM을 이어서). 예상 밖 예외는 다시 하기
   */
  async runJob(job: SagaJob): Promise<SagaStepOutcome> {
    const done = this.deps.hotPath?.start('saga.total');
    try {
      return await this.#runJob(job);
    } finally {
      done?.();
    }
  }

  async #runJob(job: SagaJob): Promise<SagaStepOutcome> {
    // 예외가 났을 때 다시 하기의 기준이 되는 지금 단계의 작업(RESERVE를 마치면 CONFIRM, attempts 0)
    let current = job;
    try {
      const order = await this.deps.orders.read(job.orderId);
      if (!order) throw new Error('작업 행은 있는데 주문 행이 없다');
      if (job.step === 'CONFIRM') return await this.confirmStep(job, order);
      if (job.step === 'RELEASE') return await this.releaseStep(job, order);
      const reserved = await this.reserveStep(job, order);
      if (reserved.kind !== 'ADVANCED') return reserved;
      // 판매 예약 트랜잭션이 작업을 CONFIRM(attempts 0, 다음 시각 지금, 보낸 시각 비움, 임대 그대로)으로, 주문을 RESERVED(T7)로 커밋했다. 같은 실행에서 승인 명령을 잇는다
      current = { orderId: job.orderId, eventId: job.eventId, step: 'CONFIRM', attempts: 0, nextAttemptAtMs: this.deps.clock.now(), ...leaseOf(job) };
      return await this.confirmStep(current, { ...order, status: 'RESERVED' });
    } catch (err) {
      this.#stepError(job.orderId, current.step, err);
      return this.#retry(current, 'error', { quiet: true });
    }
  }

  /** 단계 RESERVE(위 머리 주석 ①~③). order.status가 ACCEPTED가 아니면 건너뛴다(SKIPPED ORDER_STATE, 단계를 지났으면 작업 행 정리) */
  async reserveStep(job: SagaJob, order: SagaOrderView): Promise<SagaStepOutcome> {
    if (order.status !== 'ACCEPTED') return this.#skipOrderState(job);
    const config = await this.#configOf(order);
    // ① 승인 기한(인증 + 10분)을 넘겼으면 묶지 않는다(승인을 보내지 않으므로 과금이 없다)
    if (isPastConfirmDeadline(order.attempt?.authenticatedAtMs, this.deps.clock.now())) return this.#fail(job, order, config, 'T8', 'EXPIRED');
    if (order.seatGen === undefined) throw new Error('접수된 주문에 판 번호(seat_gen)가 없다');
    const seatIds = order.seats.map((s) => s.seatId);
    const keepUntilMs = keepUntilOf(config);
    // 주문(시도)의 판 번호. 묶기가 OK면 그 판 번호가 되고, GEN_CHANGED로는 바뀌지 않는다(명세 pin·saleStep)
    let orderGen = order.seatGen;
    for (let restarts = 0; ; restarts += 1) {
      // ② 좌석 묶기
      let pinned;
      try {
        pinned = await timeHotPath(this.deps.hotPath, 'saga.pin', () =>
          this.deps.pins.pin({
            eventId: order.eventId,
            accountId: order.accountId,
            holdId: order.holdId,
            purchaseSessionId: order.purchaseSessionId,
            seatIds,
            limit: config.perAccountLimit,
            orderGen,
            keepUntilMs,
          }),
        );
      } catch (err) {
        // 좌석 Redis 일시 장애는 다시 한다(쓰였는지 몰라도 같은 입력으로 다시 부르면 모두 내 홀드라 OK다). 그 밖(설정 오류·망가진 키)은 runJob이 받는다
        if (err instanceof OrderSeatStoreUnavailable) return this.#retry(job, 'seat_store_unavailable');
        throw err;
      }
      switch (pinned.status) {
        case 'OK':
          break;
        case 'NOT_READY':
          // 회차 키가 수명(판매 종료 + 1일)으로 지워진 뒤면 끝없이 다시 하지 않는다
          if (isSeatStoreGone(config.saleEndsAtMs, this.deps.clock.now())) return this.#fail(job, order, config, 'T8', 'STORE_GONE');
          return this.#retry(job, 'not_ready');
        case 'TAKEN':
          return this.#fail(job, order, config, 'T8', 'SEAT_TAKEN');
        case 'QUOTA_EXCEEDED':
          return this.#fail(job, order, config, 'T8', 'QUOTA_EXCEEDED');
        case 'STALE_GEN':
          return this.#fail(job, order, config, 'T8', 'STALE_GEN');
        case 'FAILED_HOLD':
          // 이미 실패 해제한 홀드다(다른 실행이 실패로 끝냈다. 늦은 묶기). 아무것도 하지 않는다
          return { kind: 'SKIPPED', reason: 'FAILED_HOLD' };
      }
      // 묶었다고 주문에 적는다(한 UPDATE, 리뷰 고침 L5): 모두 내 홀드라 판 번호가 달라도 묶였으니 그 판 번호를 주문 seat_gen에(리뷰 M1), 그리고 pinned_at을
      // (BUILD_ORDER PRF-167 K1: 다시 만들기가 결제 접수했고 묶인 주문의 좌석을 원장 만료 시각과 상관없이 되살리는 근거다). 판 번호가 같아도 부른다.
      // ACCEPTED가 아니거나 seat_gen이 바뀌었으면(다른 실행이 주문을 옮겼다) 건너뛴다
      if (!(await this.deps.orders.recordPinned(order.orderId, orderGen, pinned.gen))) return this.#skipOrderState(job);
      orderGen = pinned.gen;
      // ③ 판매 예약 트랜잭션(판 번호 대조 → 판매 행 PENDING·한도 → 작업 CONFIRM → T7)
      const reserved = await timeHotPath(this.deps.hotPath, 'saga.reserve', () =>
        this.deps.reserve.reserve({
          orderId: order.orderId,
          eventId: order.eventId,
          accountId: order.accountId,
          seatIds,
          limit: config.perAccountLimit,
          orderGen,
          actor: ORDER_SAGA_ACTOR,
          ...leaseOf(job),
        }),
      );
      switch (reserved.status) {
        case 'RESERVED':
          // T7(RESERVED)은 기다리는 상태라 long polling을 깨우지 않는다(PRF-166 리뷰 고침 L3)
          return { kind: 'ADVANCED', next: 'CONFIRM' };
        case 'GEN_CHANGED':
          // 다시 만들기가 판 번호를 올렸다: 주문 판 번호는 그대로 두고 묶기부터 다시 한다(그 판의 좌석 Redis에 내 홀드가 남았는지 본다)
          if (restarts >= SAGA_GEN_RESTART_MAX) return this.#retry(job, 'gen_changed');
          continue;
        case 'SEAT_TAKEN':
          return this.#fail(job, order, config, 'T8', 'SEAT_TAKEN');
        case 'QUOTA_EXCEEDED':
          return this.#fail(job, order, config, 'T8', 'QUOTA_EXCEEDED');
        case 'ORDER_STATE':
          // 다른 실행이 먼저 T7을 했거나 주문이 그 사이 다른 상태로 갔다
          return this.#skipOrderState(job);
      }
    }
  }

  /** 단계 CONFIRM(위 머리 주석, 리뷰 H1). order.status가 RESERVED가 아니면 건너뛴다(SKIPPED ORDER_STATE, 단계를 지났으면 작업 행·결제 참조 정리) */
  async confirmStep(job: SagaJob, order: SagaOrderView): Promise<SagaStepOutcome> {
    if (order.status !== 'RESERVED') return this.#skipOrderState(job);
    const now = this.deps.clock.now();
    const attempt = order.attempt;
    const authenticatedAtMs = attempt?.authenticatedAtMs;
    const past = attempt === undefined || authenticatedAtMs === undefined || isPastConfirmDeadline(authenticatedAtMs, now);
    // 승인 기한을 넘겼고 한 번도 보내지 않았다(차단기 열림만 계속 등): 혼자 T11(판매 행 PENDING 지우기·한도 되돌리기)과 실패 해제
    if (past && job.confirmSentAtMs === undefined) return this.#fail(job, order, await this.#configOf(order), 'T11', 'EXPIRED');
    if (attempt === undefined) throw new Error('승인 명령을 보낸 주문에 ACCEPTED 결제 시도가 없다');
    // 회차의 입장 시각(선택 칸, HOT-152가 넘긴 것, BUILD_ORDER PRF-191). 판을 읽지 못해도 승인 명령은 보낸다(입금 기한 상한이 빠질 뿐이다. 좌석맵 판이 승인을 막지 않게 던져도 삼킨다)
    const sagaConfig = await this.deps.configs.get(order.eventId).catch(() => undefined);
    const entryOpensAtMs = sagaConfig?.entryOpensAtMs;
    // 가상계좌를 끈 회차면 승인 명령에 싣는다(화면 검사를 건너뛴 승인도 payment-svc가 입금 전 취소로 끝낸다, H2)
    const virtualAccountAllowed = sagaConfig?.virtualAccountAllowed;
    let outcome;
    try {
      outcome = await timeHotPath(this.deps.hotPath, 'saga.confirm', () =>
        this.deps.confirms.confirm(
          {
            orderId: order.orderId,
            attemptId: attempt.attemptId,
            eventId: order.eventId,
            attemptNo: attempt.attemptNo,
            ...(authenticatedAtMs !== undefined ? { authenticatedAtMs } : {}),
            pg: attempt.pg,
            refs: confirmRefsOf(attempt),
            amount: order.amount,
            ...(entryOpensAtMs !== undefined ? { entryOpensAtMs } : {}),
            ...(virtualAccountAllowed !== undefined ? { virtualAccountAllowed } : {}),
            // min(500ms, 승인 기한까지 남은 시간). 기한이 지났으면(이미 보낸 명령을 다시 보낸다) 500ms
            deadlineMs: past || authenticatedAtMs === undefined ? CONFIRM_CALL_DEADLINE_MS : Math.min(CONFIRM_CALL_DEADLINE_MS, confirmDeadlineAtMs(authenticatedAtMs) - now),
          },
          {
            // 보내기 바로 전에 보낸 시각을 적고 커밋한다(차단기가 들여보낸 때만 불린다). 적지 못하면 보내지 않는다
            beforeSend: async () => {
              if (!(await this.deps.jobs.markConfirmSent(order.orderId, job.leaseUntilMs))) throw new LeaseLost();
            },
          },
        ),
      );
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: 'SKIPPED', reason: 'LEASED' };
      throw err;
    }
    switch (outcome.status) {
      case 'ACCEPTED':
        // 명령이 접수됐다: 결제 참조를 지우고 작업 행을 AWAIT로 남긴다(결과는 trade.payments로 받고, 늦으면 결과 당기기가 이 행으로 찾는다, PRF-163·PRF-171).
        // CONFIRM 행이 이미 없으면 다른 실행이 먼저 끝냈거나 결과 반영이 먼저 바꿨다. Saga 잡기는 AWAIT 행을 다시 집지 않는다
        await this.deps.confirmSent.done(order.orderId, job.leaseUntilMs);
        return { kind: 'DONE' };
      case 'RETRYABLE':
        return this.#retry(job, 'confirm_retryable');
      case 'REJECTED':
        // 정해진 거절(설정·코드 오류·모르는 답): SEV2 오류 로그 뒤 작업을 멈춘다(멀리 미룬다. 결과 당기기 PRF-171이 맞춘다, 리뷰 H1)
        this.#safeLog(() => this.deps.log.confirmRejected({ orderId: order.orderId, reason: outcome.reason }));
        return this.#retry(job, 'confirm_rejected', { delayMs: SAGA_CONFIRM_PARK_MS });
    }
  }

  /**
   * 단계 RELEASE(리뷰 M4): 실패 해제를 다시 하고, 끝났으면(OK·회차 키 수명 뒤의 NOT_READY) 작업 행을 지워 RELEASED, 못 끝났으면 다시 하기.
   * 입금 오류로 되돌린 주문의 티켓 무효가 끝나지 않았으면(T17로 기한이 지난 경우) 풀지 않고 다시 하기다: 앞 세대 티켓이 살아 있는 동안 좌석이 다시 팔리지 않게 한다(BUILD_ORDER HOT-152 코드 리뷰).
   * 판매 행 지우기·한도 되돌림은 T17 트랜잭션 그대로이고, 새 구매자는 좌석 Redis를 거치므로 이 해제가 다시 파는 문이다
   */
  async releaseStep(job: SagaJob, order: SagaOrderView): Promise<SagaStepOutcome> {
    if (order.ticketVoidPending === true) return this.#retry(job, 'ticket_void_pending');
    const config = await this.#configOf(order);
    if (!(await this.#releaseHold(order, config))) return this.#retry(job, 'release_failed');
    await this.deps.jobs.delete(order.orderId, { step: 'RELEASE', ...leaseOf(job) });
    return { kind: 'RELEASED' };
  }

  // ---- 안쪽 ----

  #leaseMs(): number {
    return this.deps.leaseMs ?? SAGA_LEASE_MS;
  }

  /** 틱 하나: 앞 틱이 아직 돌면 건너뛴다. 멈춘 뒤에는 돌지 않는다 */
  #tick(): void {
    if (this.#stopped || this.#ticking) return;
    const p = this.#scope.runInAsyncScope(() => this.pollOnce()).then(
      () => undefined,
      () => undefined,
    );
    this.#ticking = p;
    this.#track(
      p.finally(() => {
        this.#ticking = undefined;
      }),
    );
  }

  /** stop이 기다릴 일로 적고, 끝나면 뺀다 */
  #track(p: Promise<void>): void {
    const tracked = p.finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
  }

  /** 집은 작업의 임대만 놓는다(던지지 않는다. 놓지 못해도 임대가 끝나면 다시 집힌다) */
  async #releaseLease(job: SagaJob): Promise<void> {
    if (job.leaseUntilMs === undefined) return;
    try {
      await this.deps.jobs.release(job.orderId, job.leaseUntilMs);
    } catch {
      // 삼킨다
    }
  }

  /** 회차 설정(1인 한도·판매 종료). 좌석맵 판이 없으면 설정 오류라 던진다(runJob이 오류 로그 뒤 다시 한다) */
  async #configOf(order: SagaOrderView): Promise<SagaEventConfig> {
    const config = await this.deps.configs.get(order.eventId);
    if (!config) throw new Error('회차의 좌석맵 판(1인 한도·판매 종료)이 없다');
    return config;
  }

  /**
   * ORDER_STATE로 건너뛴다(리뷰 M3): 주문이 그 단계를 지났으면 SagaJobs.abandon이 한 트랜잭션에서 작업 행·결제 참조를 지우고(REMOVED),
   * 지나지 않았으면(KEPT) 다시 하기로 미뤄 임대를 푼다. 작업 행이 이미 없거나 남의 임대면(GONE) 아무것도 하지 않는다
   */
  async #skipOrderState(job: SagaJob): Promise<SagaStepOutcome> {
    const r = await this.deps.jobs.abandon(job.orderId, job.step, job.leaseUntilMs);
    if (r === 'KEPT') await this.#retry(job, 'error', { quiet: true });
    return SKIPPED_ORDER_STATE;
  }

  /**
   * 실패의 차례: DB 실패 기록(SagaFailures.fail, 커밋. 작업 행 RELEASE) → 실패 해제 → 끝났으면 작업 행 지우기, 못 끝났으면 RELEASE 작업으로 다시 하기(리뷰 M4).
   * 실패 기록이 던지면 그대로 던진다(해제하지 않는다. runJob이 다시 한다). STALE이면 해제하지 않고 그 자리에서 다시 하기로 미뤄 임대를 푼다(리뷰 M3)
   */
  async #fail(job: SagaJob, order: SagaOrderView, config: SagaEventConfig, transition: SagaFailTransition, reason: SagaFailureReason): Promise<SagaStepOutcome> {
    const seatIds = order.seats.map((s) => s.seatId);
    const base = { orderId: order.orderId, transition, reason, actor: ORDER_SAGA_ACTOR, ...leaseOf(job) };
    const input: SagaFailInput = transition === 'T11' ? { ...base, release: { eventId: order.eventId, orderId: order.orderId, accountId: order.accountId, seatIds } } : base;
    const recorded = await this.deps.failures.fail(input);
    if (recorded.status === 'STALE') {
      await this.#retry(job, 'error', { quiet: true });
      return SKIPPED_ORDER_STATE;
    }
    // 실패 기록 트랜잭션이 작업 행을 RELEASE(attempts 0, 임대 그대로)로 바꿨다
    const releaseJob: SagaJob = { orderId: job.orderId, eventId: job.eventId, step: 'RELEASE', attempts: 0, nextAttemptAtMs: this.deps.clock.now(), ...leaseOf(job) };
    try {
      if (await this.#releaseHold(order, config)) await this.deps.jobs.delete(order.orderId, { step: 'RELEASE', ...leaseOf(job) });
      else await this.#retry(releaseJob, 'release_failed');
    } catch (err) {
      // 주문은 이미 FAILED다. RELEASE 작업 행이 남아 있으면 임대가 끝난 뒤 다시 한다
      this.#stepError(order.orderId, 'RELEASE', err);
      await this.#retry(releaseJob, 'error', { quiet: true });
    }
    // T8·T11(FAILED, 바로 답할 상태)을 커밋하고 커밋 뒤 일(실패 해제·작업 행 정리)을 마쳤다: 이 주문을 기다리는 long polling을 깨운다(PRF-166 리뷰 고침 L3)
    this.#orderChanged(order.orderId);
    return { kind: 'FAILED', transition, reason };
  }

  /**
   * 실패 해제 한 번. 끝났으면 true: OK, 또는 회차 키 수명이 지난 뒤의 NOT_READY(키가 이미 지워졌다).
   * 못 끝났으면 warn 한 줄 뒤 false: 좌석 Redis 장애·그 밖의 오류, 수명 안의 NOT_READY(정함: 정본은 수명 뒤만 '끝난 것'으로 정한다)
   */
  async #releaseHold(order: SagaOrderView, config: SagaEventConfig): Promise<boolean> {
    const seatIds = order.seats.map((s) => s.seatId);
    try {
      const released = await this.deps.pins.releaseFailed({ eventId: order.eventId, accountId: order.accountId, holdId: order.holdId, seatIds, keepUntilMs: keepUntilOf(config) });
      if (released.status === 'OK' || isSeatStoreGone(config.saleEndsAtMs, this.deps.clock.now())) return true;
      this.#safeLog(() => this.deps.log.releaseFailed({ orderId: order.orderId, eventId: order.eventId, why: 'not_ready' }));
      return false;
    } catch (err) {
      const why = err instanceof OrderSeatStoreUnavailable ? 'seat_store_unavailable' : 'error';
      this.#safeLog(() => this.deps.log.releaseFailed({ orderId: order.orderId, eventId: order.eventId, why }));
      return false;
    }
  }

  /**
   * 다시 하기로 미룬다: 다음 시각 = 지금 + (delayMs 또는 sagaRetryDelayMs(attempts + 1)), 자기 임대 조건. quiet면(예외 뒤) 미루기 자체가 던져도 삼킨다(임대가 끝나면 다시 집힌다)
   * @throws Error quiet가 아니고 미루기가 던짐(runJob이 받는다)
   */
  async #retry(job: SagaJob, reason: SagaRetryReason, o: { quiet?: boolean; delayMs?: number } = {}): Promise<SagaStepOutcome> {
    const nextAtMs = this.deps.clock.now() + (o.delayMs ?? sagaRetryDelayMs(job.attempts + 1));
    try {
      await this.deps.jobs.reschedule(job.orderId, nextAtMs, job.leaseUntilMs);
    } catch (err) {
      if (!o.quiet) throw err;
    }
    return { kind: 'RETRY', reason, nextAtMs };
  }

  #stepError(orderId: string, step: SagaStep, err: unknown): void {
    this.#safeLog(() => this.deps.log.stepError({ orderId, step, err }));
  }

  /** 주문 상태를 바꾼 커밋 뒤 부른다(onOrderChanged가 있을 때만). 던지지 않기로 했지만, 던져도 실행기를 막지 않는다 */
  #orderChanged(orderId: string): void {
    this.#safeLog(() => this.deps.onOrderChanged?.(orderId));
  }

  /** 로그 포트는 던지지 않기로 했지만, 던져도 실행기를 막지 않는다 */
  #safeLog(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

const SKIPPED_ORDER_STATE: SagaStepOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'ORDER_STATE' });

/** 집은 작업의 임대 값(자기 임대 조건으로 넘긴다). 없으면 빈 객체 */
const leaseOf = (job: SagaJob): { leaseUntilMs?: number } => (job.leaseUntilMs !== undefined ? { leaseUntilMs: job.leaseUntilMs } : {});

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: SagaTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** 회차 키 만료 시각 = 판매 종료 + 1일(묶기·실패 해제 입력) */
const keepUntilOf = (config: SagaEventConfig): number => config.saleEndsAtMs + SEAT_KEYS_KEEP_AFTER_SALE_END_MS;

/**
 * 결제 시도의 결제 참조 → 승인 명령의 결제 참조(payment.proto payment_ref). 토스·시뮬레이터는 toss 칸(paymentKey), 포트원은 paymentId = 시도의 pg_order_ref.
 * 결제 참조가 없거나(이미 지웠다) 포트원인데 pg_order_ref가 없으면 Error(값은 오류 글에 싣지 않는다)
 */
function confirmRefsOf(attempt: NonNullable<SagaOrderView['attempt']>): ConfirmRefs {
  const refs = attempt.refs;
  if (!refs) throw new Error('결제 시도에 결제 참조가 없다(이미 지웠다)');
  if (refs.pg === 'PORTONE') {
    if (attempt.pgOrderRef === undefined) throw new Error('포트원 결제 시도에 pg_order_ref(paymentId)가 없다');
    return { pg: 'PORTONE', paymentId: attempt.pgOrderRef, txId: refs.txId, paymentToken: refs.paymentToken };
  }
  return { pg: refs.pg, paymentKey: refs.paymentKey };
}
