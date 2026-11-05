// 발권 실행기(ADR-0106 결정 2, docs/features/payment.md §3 T18, docs/data.md §5, BUILD_ORDER PRF-170). OrderSagaRunner(order-saga.ts)와 같은 꼴이다.
// 모든 API 파드가 1초 [가정]마다 틱 하나를 돈다(tick, 앞 틱이 끝나지 않았으면 건너뛴다):
//   ① ISSUE_DELAYED 내기(TicketIssueJobs.markDelayed, 승인 반영 뒤 60초 [가정] 넘게 남은 행에 한 번, 100건 [가정]까지) → 지표 delayed
//   ② 발권 기한 넘김 표시(markOverdue, issue_due_at을 넘긴 행에 한 번, 100건까지) → 행마다 SEV1 오류 로그 한 줄(csCase TICKET_NOT_ISSUED)과 지표 overdue
//   ③ 큐 게이지(gauges, 10초 [가정]마다 한 번) → 지표 jobs
//   ④ 파드의 동시 자리 8개 [가정] 가운데 빈자리만큼(min(50 [가정], 빈자리)) 자리를 먼저 쥐고, 기한이 된 행을 짧은 트랜잭션으로 그만큼 잡아(claimDue, 임대 30초 [가정])
//      커밋한 뒤 돈다(빈자리가 0이면 잡지 않는다. 잡은 수만큼 남기고 나머지 자리는 놓는다, 리뷰 고침 H1). 잠금을 쥔 채 ticket-svc를 부르지 않는다.
//      행을 시작하기 전에 멈췄거나 남은 임대가 TICKET_ISSUE_LEASE_MIN_REMAINING_MS(5초 [정함]) 미만이면 부르지 않고 임대를 놓는다.
//   ①~④는 서로 막지 않는다(하나가 던져도 log.runError 뒤 다음으로 간다).
// 자리 하나는 발권 호출과 그 뒤 쓰기(complete·retry·stop·release)가 끝날 때까지 쥔다(리뷰 고침 H1: ticket-svc가 멈춰 실패가 한꺼번에 몰려도
//   파드의 동시 쓰기가 8을 넘지 않게. 쓰기는 main.ts가 넘긴 실행기 전용 일반 풀을 쓴다).
// 큐 행 하나(runJob): TicketIssuer.issue(주문 ID·회차·결제자·좌석, 데드라인 2초 [가정])
//   → 답이 issuedTicketsMatch면 TicketIssueJobs.complete(한 트랜잭션: T18 조건부·티켓 ID·큐 행 지우기·Outbox CONFIRMED). CONFIRMED면 지표 issued와 onOrderChanged,
//     STALE(주문이 APPROVED가 아님, 늦게 온 답)이면 지표 stale과 경고 한 줄, LEASE_LOST면 아무것도 하지 않는다.
//     complete가 다시 해도 같은 오류(RangeError·SQLSTATE 23, isFinalTicketIssueWriteError)로 던지면 log.runError 뒤 BAD_ANSWER로 멈춘다(리뷰 고침 L6)
//   → 답이 맞지 않으면(좌석·티켓 ID·상태 ISSUED·ACTIVE가 아님) BAD_ANSWER, TicketIssueCallError면 그 코드: ticketIssueFailureKind가 RETRY면
//     retry(지금 + ticketIssueRetryDelayMs(attempts + 1, random())), STOP이면 stop과 SEV2 오류 로그 한 줄(kind ticket-issue, csCase TICKET_NOT_ISSUED).
//     자동 재시도마다 주문 이력(T19)을 쓰지 않는다 [정함].
//   예상 밖 예외(TicketIssueCallError가 아님)는 log.runError(issue, 주문 ID) 한 줄 뒤 UNKNOWN으로 보아 다시 보낸다(실행기는 멈추지 않는다, 리뷰 고침 L5).
// 결제 결과 반영이 승인(T9·T13·T16)을 커밋한 뒤 kick(orderId)으로 그 주문을 곧바로 한 번 돈다(ApplyPaymentResultDeps.onApproved로 잇는다. 기다리지 않고 던지지 않는다).
// kick도 빈자리가 있을 때만 자리를 쥐고 잡는다. 빈자리가 없으면 잡지 않고(SKIPPED NO_SLOT) 틱에 맡긴다(리뷰 고침 H1).
// kick·틱은 실행기를 만든 때(시작 파일, 요청·소비자 맥락 밖)의 비동기 맥락에서 돈다(OrderSagaRunner와 같은 까닭: 끝난 맥락의 남은 시간 0을 물려받지 않게).
// SIGTERM에서 stop()은 반복을 끄고 돌던 틱·kick(부르던 발권 호출 포함)을 기다린다. 잡았지만 시작하지 않은 행은 임대를 놓는다.
// 같은 행을 두 파드가 함께 돌아도 큐 행 갱신이 자기 임대 조건이고 T18이 조건부라 하나만 효과가 있다(늦게 온 답은 LEASE_LOST·STALE).
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
// 구현에서 정한 것(정본에 없다):
// - 틱·kick은 잡기 전에 자리를 쥔다(잡은 행이 빈자리를 기다리며 임대를 깎지 않게). 밖에서 runJob을 바로 부르면 빈자리를 기다리고, 빈자리는 기다린 차례로 넘긴다.
//   잡기가 약속보다 많은 행을 돌려주면(포트 약속 밖) 넘친 행은 runJob처럼 빈자리를 기다린다.
//   자리를 얻은 바로 그때 남은 임대를 본다(빈자리를 기다리는 사이 임대가 줄 수 있다). 모자라거나 멈춘 뒤면 부르지 않고 임대를 놓아 SKIPPED RELEASED다.
// - stop()은 빈자리를 기다리던 행을 곧바로 놓게 한다(부르던 호출이 끝나기를 기다리지 않고 임대를 놓는다). 멈춘 뒤의 틱·runOne은 잡기(claimDue·claim)를 하지 않는다.
// - claimLimit·concurrency가 1 이상의 안전한 정수가 아니면 기본값(50·8)으로 본다.
// - 틱의 단계 ①~④는 차례로 돈다. 지표 delayed·overdue는 낸 수가 1 이상일 때만 올린다. 게이지는 잰 때를 적고, 재지 못했으면 다음 틱에 다시 잰다.
// - TicketIssueCallError의 코드가 실패 코드 묶음 밖이면 UNKNOWN으로 본다. 흔들기 난수가 [0, 1) 밖이면 0.5(흔들기 없음)로 본다(실행기는 던지지 않는다).
// - 성공 반영이 STALE이면 경고 한 줄의 current는 있을 때만 싣는다. 쓰기 오류(ERROR)·LEASE_LOST·RELEASED는 지표를 세지 않는다.
// - kick의 잡기(claim·get)가 던지면 log.runError(what claim, 주문 ID)다. 틱의 잡기 실패는 log.runError(what claim, 주문 ID 없음)다.
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import {
  TicketIssueCallError,
  type TicketIssueCompleteOutcome,
  type TicketIssueJob,
  type TicketIssueJobs,
  type TicketIssueLog,
  type TicketIssuer,
  type TicketIssueSignals,
} from '../domain/ports.js';
import {
  type IssuedTicketRef,
  isFinalTicketIssueWriteError,
  issuedTicketsMatch,
  TICKET_ISSUE_ACTOR,
  TICKET_ISSUE_CALL_DEADLINE_MS,
  TICKET_ISSUE_CLAIM_LIMIT,
  TICKET_ISSUE_CONCURRENCY,
  TICKET_ISSUE_GAUGE_INTERVAL_MS,
  TICKET_ISSUE_LEASE_MIN_REMAINING_MS,
  TICKET_ISSUE_LEASE_MS,
  TICKET_ISSUE_POLL_INTERVAL_MS,
  TICKET_ISSUE_RETRY_CODES,
  TICKET_ISSUE_SIGNAL_BATCH,
  TICKET_ISSUE_STOP_CODES,
  type TicketIssueAttemptResult,
  type TicketIssueFailureCode,
  ticketIssueFailureKind,
  type TicketIssueOutcome,
  ticketIssueRetryDelayMs,
  type TicketIssueRunStage,
} from '../domain/ticket-issue.js';
import type { SagaTimer } from './order-saga.js';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval·clearInterval). Saga 실행기와 같은 모양 */
export type TicketIssueTimer = SagaTimer;

/** 실행기가 쓰는 포트와 설정 */
export interface TicketIssueDeps {
  jobs: TicketIssueJobs;
  issuer: TicketIssuer;
  log: TicketIssueLog;
  signals: TicketIssueSignals;
  clock: Clock;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: TicketIssueTimer;
  /** 흔들기 난수([0, 1)). 없으면 Math.random */
  random?: () => number;
  /** 반복 간격(기본 TICKET_ISSUE_POLL_INTERVAL_MS 1초 [가정]) */
  pollIntervalMs?: number;
  /** 한 번에 잡는 수의 상한(기본 TICKET_ISSUE_CLAIM_LIMIT 50 [가정]). 틱은 min(이 값, 빈자리)만큼 잡는다 */
  claimLimit?: number;
  /** 임대 길이(기본 TICKET_ISSUE_LEASE_MS 30초 [가정]) */
  leaseMs?: number;
  /** 파드의 동시 자리 수(발권 호출과 그 뒤 쓰기, 기본 TICKET_ISSUE_CONCURRENCY 8 [가정]). 틱과 kick이 함께 센다 */
  concurrency?: number;
  /** 발권 호출 데드라인(기본 TICKET_ISSUE_CALL_DEADLINE_MS 2초 [가정]) */
  callDeadlineMs?: number;
  /** 한 틱에 ISSUE_DELAYED·기한 넘김을 내는 수(기본 TICKET_ISSUE_SIGNAL_BATCH 100 [가정]) */
  signalBatch?: number;
  /** 게이지 간격(기본 TICKET_ISSUE_GAUGE_INTERVAL_MS 10초 [가정]). 시작 뒤 첫 틱에 한 번 잰다 */
  gaugeIntervalMs?: number;
  /**
   * 주문을 CONFIRMED로 바꾼 커밋 뒤 부를 것(결제 결과 long polling의 기다림 깨우기, PaymentStatusWaiters.notify).
   * STALE·RETRY·STOPPED에는 부르지 않는다(주문 상태가 그대로다). 던지지 않는다(던져도 실행기는 삼킨다). 없으면 부르지 않는다
   */
  onOrderChanged?: (orderId: string) => void;
}

/** 틱 하나의 결과(시험·로그용 수) */
export interface TicketIssueTickResult {
  /** 잡은 큐 행 수(임대를 놓은 것 포함) */
  readonly claimed: number;
  /** ISSUE_DELAYED를 낸 주문 수 */
  readonly delayed: number;
  /** 발권 기한 넘김을 표시한 주문 수 */
  readonly overdue: number;
  /** 이번 틱에 게이지를 쟀나 */
  readonly measured: boolean;
}

/**
 * 발권 실행기. start()로 1초 반복을 켜고 stop()으로 끈다(돌던 틱·kick을 기다린다). kick(orderId)은 승인 반영 커밋 직후 비동기로 한 번 돈다
 * (기다리지 않고 던지지 않는다. 오류는 log.runError). 같은 행을 두 파드가 함께 돌아도 큐 행 갱신이 자기 임대 조건이고 T18이 조건부라 하나만 효과가 있다.
 */
export class TicketIssueRunner {
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  #stopped = false;
  /** 돌고 있는 틱(겹치지 않게 하나만) */
  #ticking: Promise<void> | undefined;
  /** 돌고 있는 틱·kick(stop이 기다린다) */
  readonly #inflight = new Set<Promise<void>>();
  /** 쥔 자리 수(발권 호출과 그 뒤 쓰기, 잡기 전에 미리 쥔 것 포함. 틱과 kick이 함께 센다. concurrency를 넘지 않는다) */
  #calling = 0;
  /** 빈자리를 기다리는 행들(기다린 차례). true면 자리를 넘겨받았고, false면 멈춰서 부르지 않는다 */
  readonly #slotWaiters: ((granted: boolean) => void)[] = [];
  /** 마지막으로 게이지를 잰 시각(epoch ms, 앱 시계). 아직 재지 않았으면 undefined */
  #measuredAtMs: number | undefined;
  /** 만든 때(시작 파일, 요청 밖)의 비동기 맥락. kick·틱이 이 맥락에서 돈다(OrderSagaRunner #scope와 같은 까닭) */
  readonly #scope = new AsyncResource('TicketIssueRunner');

  constructor(private readonly deps: TicketIssueDeps) {}

  /** 1초 반복을 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다). 틱이 겹치지 않는다(앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다) */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#loopTick(), this.deps.pollIntervalMs ?? TICKET_ISSUE_POLL_INTERVAL_MS);
  }

  /** 반복을 끄고 돌던 틱·kick(부르던 발권 호출과 그 뒤 쓰기까지)을 기다린다. 잡았지만 시작하지 않은 행은 임대를 놓는다. 멈춘 뒤의 kick·start는 아무것도 하지 않는다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    // 빈자리를 기다리던 행은 부르지 않고 곧바로 임대를 놓게 한다(머리 주석 '구현에서 정한 것')
    for (const wake of this.#slotWaiters.splice(0)) wake(false);
    // 기다리는 동안 끝난 것은 집합에서 빠진다. 지금 도는 것만 기다린다(멈춘 뒤에는 새로 생기지 않는다)
    await Promise.allSettled([...this.#inflight]);
  }

  /**
   * 승인 반영 커밋 직후 부른다: runOne을 비동기로 한 번(기다리지 않는다, 던지지 않는다). 멈춘 뒤(stop)에는 부르지 않는다.
   * 빈자리가 없으면 잡지 않는다(그 행은 틱이 잡는다, 리뷰 고침 H1)
   */
  kick(orderId: string): void {
    if (this.#stopped) return;
    this.#track(
      this.#scope
        .runInAsyncScope(() => this.runOne(orderId))
        .then(
          () => undefined,
          (err: unknown) => {
            // 잡기(claim·get)가 던졌다(purchase DB 장애). 큐 행은 남아 있어 틱이 다시 잡는다
            this.#runError('claim', err, orderId);
          },
        ),
    );
  }

  /**
   * 틱 하나(머리 주석 ①~④). 던지지 않는다: 단계마다 오류는 log.runError(what = delayed·overdue·gauges·claim) 뒤 0으로 센다(다음 틱에 다시).
   * 멈춘 뒤에는 아무것도 하지 않고 0을 돌려준다
   */
  async tick(): Promise<TicketIssueTickResult> {
    if (this.#stopped) return NOTHING;
    const p = this.#tickOnce();
    this.#track(p.then(noop, noop));
    return p;
  }

  /**
   * 그 주문의 큐 행을 잡아(claim) 돈다. 빈자리가 없거나 멈춘 뒤면 잡지 않고 SKIPPED NO_SLOT(틱에 맡긴다, 리뷰 고침 H1).
   * 잡지 못하면 SKIPPED NO_JOB(행 없음)·LEASED(다른 실행이 임대 중, 기한 전, 멈춘 행)
   * @throws claim·get이 던진 것(purchase DB 장애. 쥔 자리는 놓았다. kick은 log.runError(claim)로 삼킨다)
   */
  async runOne(orderId: string): Promise<TicketIssueOutcome> {
    // 잡기 전에 자리를 쥔다(잡은 행이 빈자리를 기다리며 임대를 깎지 않게)
    if (this.#reserve(1) === 0) return SKIPPED_NO_SLOT;
    let job: TicketIssueJob | undefined;
    try {
      job = await this.deps.jobs.claim(orderId, this.#leaseMs());
    } catch (err) {
      this.#releaseSlot();
      throw err;
    }
    if (!job) {
      this.#releaseSlot();
      // 잡지 못한 까닭을 가른다(행이 있으면 다른 실행이 임대 중이거나 다시 보내기 기한 전이거나 멈춘 행이다)
      const row = await this.deps.jobs.get(orderId);
      return { kind: 'SKIPPED', reason: row ? 'LEASED' : 'NO_JOB' };
    }
    return this.#runHeld(job);
  }

  /**
   * 잡은 큐 행 하나를 돈다(머리 주석 '큐 행 하나'). 동시 자리(concurrency)가 찼으면 빈자리를 기다리고, 자리는 호출과 그 뒤 쓰기가 끝날 때까지 쥔다. 던지지 않는다:
   * 쓰기(complete·retry·stop)가 일시 오류로 던지면 log.runError 뒤 임대를 그대로 두고 ERROR(임대가 끝나면 다시 잡힌다. 주문 ID로 멱등이라 다시 불러도 같은 티켓이다).
   * 끝난 결과마다 지표 attempt 하나(ISSUED issued·STALE stale·RETRY retry·STOPPED stopped. SKIPPED·ERROR는 세지 않는다)
   */
  async runJob(job: TicketIssueJob): Promise<TicketIssueOutcome> {
    const granted = await this.#acquire();
    if (!granted) {
      // 멈췄다: 부르지 않고 임대를 놓는다(다음 틱에 다시 잡힌다)
      await this.#releaseLease(job);
      return SKIPPED_RELEASED;
    }
    return this.#runHeld(job);
  }

  // ---- 안쪽 ----

  #timer(): TicketIssueTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  #leaseMs(): number {
    return this.deps.leaseMs ?? TICKET_ISSUE_LEASE_MS;
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

  /** 틱 하나의 본문(①~④, 단계마다 오류를 삼킨다) */
  async #tickOnce(): Promise<TicketIssueTickResult> {
    const batch = this.deps.signalBatch ?? TICKET_ISSUE_SIGNAL_BATCH;
    // ① ISSUE_DELAYED(사건과 delayed_at은 markDelayed 한 트랜잭션이 쓴다)
    let delayed = 0;
    try {
      delayed = (await this.deps.jobs.markDelayed(batch)).length;
      if (delayed > 0) this.#safe(() => this.deps.signals.delayed(delayed));
    } catch (err) {
      this.#runError('delayed', err);
    }
    // ② 발권 기한 넘김(주문마다 SEV1 한 줄. 재시도는 건드리지 않는다)
    let overdue = 0;
    try {
      const ids = await this.deps.jobs.markOverdue(batch);
      overdue = ids.length;
      for (const orderId of ids) this.#safe(() => this.deps.log.overdue({ orderId }));
      if (overdue > 0) this.#safe(() => this.deps.signals.overdue(overdue));
    } catch (err) {
      this.#runError('overdue', err);
    }
    // ③ 큐 게이지(시작 뒤 첫 틱, 그 뒤 간격마다. 재지 못했으면 다음 틱에 다시)
    let measured = false;
    const now = this.deps.clock.now();
    if (this.#measuredAtMs === undefined || now - this.#measuredAtMs >= (this.deps.gaugeIntervalMs ?? TICKET_ISSUE_GAUGE_INTERVAL_MS)) {
      try {
        const g = await this.deps.jobs.gauges();
        this.#safe(() => this.deps.signals.jobs(g));
        this.#measuredAtMs = now;
        measured = true;
      } catch (err) {
        this.#runError('gauges', err);
      }
    }
    // ④ 빈자리만큼 자리를 먼저 쥐고 그만큼만 기한이 된 행을 잡는다(짧은 트랜잭션, 커밋 뒤 잠금 밖에서 부른다, 리뷰 고침 H1).
    //    빈자리가 0이거나 멈춘 뒤면 잡지 않는다(남은 행은 다음 틱에)
    let jobs: TicketIssueJob[] = [];
    const reserved = this.#reserve(this.#claimLimit());
    if (reserved > 0) {
      try {
        jobs = await this.deps.jobs.claimDue(reserved, this.#leaseMs());
      } catch (err) {
        this.#runError('claim', err);
      }
    }
    // 잡은 행마다 쥔 자리 하나를 넘기고 남은 자리는 놓는다. 약속보다 많이 돌려준 행(포트 약속 밖)은 빈자리를 기다린다(runJob)
    const held = jobs.slice(0, reserved);
    for (let i = held.length; i < reserved; i += 1) this.#releaseSlot();
    // 잡은 행을 함께 돈다(#runHeld·runJob은 던지지 않는다)
    await Promise.all([...held.map((job) => this.#runHeld(job)), ...jobs.slice(reserved).map((job) => this.runJob(job))]);
    return { claimed: jobs.length, delayed, overdue, measured };
  }

  /**
   * 자리를 쥔 채 큐 행 하나를 돈다(부르기 → 쓰기). 끝나면(어느 갈래든) 자리를 놓는다. 던지지 않는다.
   * 부르기 바로 전에 멈춘 뒤이거나 남은 임대가 모자라면 부르지 않고 임대를 놓는다(SKIPPED RELEASED, 다음 틱에 다시 잡힌다)
   */
  async #runHeld(job: TicketIssueJob): Promise<TicketIssueOutcome> {
    try {
      if (this.#stopped || job.leaseUntilMs - this.deps.clock.now() < TICKET_ISSUE_LEASE_MIN_REMAINING_MS) {
        await this.#releaseLease(job);
        return SKIPPED_RELEASED;
      }
      return await this.#issueAndWrite(job);
    } finally {
      this.#releaseSlot();
    }
  }

  /** 발권 호출 뒤 답에 맞는 쓰기 하나(complete·retry·stop). 자리는 부른 쪽(#runHeld)이 쥐고 있다 */
  async #issueAndWrite(job: TicketIssueJob): Promise<TicketIssueOutcome> {
    let tickets: readonly IssuedTicketRef[] | undefined;
    let code: TicketIssueFailureCode | undefined;
    try {
      tickets = await this.deps.issuer.issue({
        orderId: job.orderId,
        eventId: job.eventId,
        payerAccountId: job.payerAccountId,
        seatIds: job.seatIds,
        deadlineMs: this.deps.callDeadlineMs ?? TICKET_ISSUE_CALL_DEADLINE_MS,
      });
    } catch (err) {
      if (err instanceof TicketIssueCallError) {
        code = KNOWN_CODES.has(err.code) ? err.code : 'UNKNOWN';
      } else {
        // 예상 밖 예외(어댑터 버그 등): 오류 한 줄을 남기고 UNKNOWN으로 보아 다시 보낸다(실행기는 멈추지 않는다, 리뷰 고침 L5)
        this.#runError('issue', err, job.orderId);
        code = 'UNKNOWN';
      }
    }
    // 답이 주문 좌석과 맞지 않으면(빠짐·남는 좌석·같은 티켓 ID·빈 ID·상태가 ISSUED·ACTIVE가 아님) 다시 보내지 않을 실패다(주문에 적지 않는다)
    if (code === undefined && tickets !== undefined && !issuedTicketsMatch(job.seatIds, tickets)) code = 'BAD_ANSWER';
    if (code === undefined && tickets !== undefined) return this.#complete(job, tickets);
    const failure = code ?? 'UNKNOWN';
    return ticketIssueFailureKind(failure) === 'RETRY' ? this.#retry(job, failure) : this.#stop(job, failure);
  }

  /**
   * 빈자리에서 n개까지 자리를 곧바로 쥐고 쥔 수를 돌려준다(기다리지 않는다). 멈춘 뒤면 0.
   * 기다리는 행이 있으면 빈자리가 없을 때다(#releaseSlot이 곧바로 넘긴다)
   */
  #reserve(n: number): number {
    if (this.#stopped) return 0;
    const k = Math.max(0, Math.min(n, this.#concurrency() - this.#calling));
    this.#calling += k;
    return k;
  }

  /** 빈자리 하나를 얻는다. 멈췄거나 기다리는 사이 멈추면 false(자리를 쥐지 않는다) */
  #acquire(): Promise<boolean> {
    if (this.#stopped) return Promise.resolve(false);
    if (this.#calling < this.#concurrency()) {
      this.#calling += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => this.#slotWaiters.push(resolve));
  }

  /** 쥔 자리를 놓는다. 기다리는 행이 있으면 그 행에 곧바로 넘긴다(쥔 수는 그대로) */
  #releaseSlot(): void {
    const next = this.#slotWaiters.shift();
    if (next) next(true);
    else this.#calling -= 1;
  }

  #concurrency(): number {
    const c = this.deps.concurrency ?? TICKET_ISSUE_CONCURRENCY;
    return Number.isSafeInteger(c) && c >= 1 ? c : TICKET_ISSUE_CONCURRENCY;
  }

  #claimLimit(): number {
    const c = this.deps.claimLimit ?? TICKET_ISSUE_CLAIM_LIMIT;
    return Number.isSafeInteger(c) && c >= 1 ? c : TICKET_ISSUE_CLAIM_LIMIT;
  }

  /**
   * 성공 반영(complete 한 트랜잭션). CONFIRMED면 지표 issued와 onOrderChanged, STALE이면 경고 한 줄과 지표 stale, LEASE_LOST면 아무것도 하지 않는다.
   * complete가 던지면 log.runError(complete) 한 줄 뒤, 다시 해도 같은 오류(RangeError·SQLSTATE 23)면 BAD_ANSWER로 멈추고(리뷰 고침 L6) 아니면 ERROR(임대 그대로)
   */
  async #complete(job: TicketIssueJob, tickets: readonly IssuedTicketRef[]): Promise<TicketIssueOutcome> {
    let out: TicketIssueCompleteOutcome;
    try {
      out = await this.deps.jobs.complete({ orderId: job.orderId, tickets, actor: TICKET_ISSUE_ACTOR, leaseUntilMs: job.leaseUntilMs });
    } catch (err) {
      this.#runError('complete', err, job.orderId);
      // 좌석 불일치·제약 위반은 임대가 끝날 때마다 같은 호출·같은 쓰기를 되풀이할 뿐이라 멈춘다(SEV2 로그는 #stop이 남긴다)
      if (isFinalTicketIssueWriteError(err)) return this.#stop(job, 'BAD_ANSWER');
      return { kind: 'ERROR', stage: 'complete' };
    }
    switch (out.status) {
      case 'CONFIRMED':
        this.#attempt('issued');
        // T18을 커밋했다: 이 주문을 기다리는 같은 파드의 long polling을 깨운다
        this.#safe(() => this.deps.onOrderChanged?.(job.orderId));
        return ISSUED;
      case 'STALE': {
        const current = out.current;
        this.#safe(() => this.deps.log.staleAnswer(current !== undefined ? { orderId: job.orderId, current } : { orderId: job.orderId }));
        this.#attempt('stale');
        return current !== undefined ? { kind: 'STALE', current } : { kind: 'STALE' };
      }
      case 'LEASE_LOST':
        return SKIPPED_LEASE_LOST;
    }
  }

  /** 다시 보낼 실패: retry(다음 시각 = 지금 + 늘려 쉬기(attempts + 1, 흔들기)). 주문 이력(T19)은 쓰지 않는다 */
  async #retry(job: TicketIssueJob, code: TicketIssueFailureCode): Promise<TicketIssueOutcome> {
    const nextAtMs = this.deps.clock.now() + this.#retryDelayMs(job.attempts + 1);
    let ok: boolean;
    try {
      ok = await this.deps.jobs.retry({ orderId: job.orderId, nextAtMs, code, leaseUntilMs: job.leaseUntilMs });
    } catch (err) {
      this.#runError('retry', err, job.orderId);
      return { kind: 'ERROR', stage: 'retry' };
    }
    if (!ok) return SKIPPED_LEASE_LOST;
    this.#attempt('retry');
    return { kind: 'RETRY', code, nextAtMs };
  }

  /** 다시 보내지 않을 실패: stop(next_attempt_at 비움) 뒤 SEV2 오류 로그 한 줄(주문 ID·코드만, csCase는 로그 어댑터가 싣는다) */
  async #stop(job: TicketIssueJob, code: TicketIssueFailureCode): Promise<TicketIssueOutcome> {
    let ok: boolean;
    try {
      ok = await this.deps.jobs.stop({ orderId: job.orderId, code, leaseUntilMs: job.leaseUntilMs });
    } catch (err) {
      this.#runError('stop', err, job.orderId);
      return { kind: 'ERROR', stage: 'stop' };
    }
    if (!ok) return SKIPPED_LEASE_LOST;
    this.#safe(() => this.deps.log.stopped({ orderId: job.orderId, code }));
    this.#attempt('stopped');
    return { kind: 'STOPPED', code };
  }

  /** 늘려 쉬기 간격(흔들기 난수가 [0, 1) 밖이면 0.5. 시도 수가 범위 밖이면 상한 간격) */
  #retryDelayMs(attempts: number): number {
    const raw = (this.deps.random ?? Math.random)();
    const unit = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.5;
    try {
      return ticketIssueRetryDelayMs(attempts, unit);
    } catch {
      return ticketIssueRetryDelayMs(Number.MAX_SAFE_INTEGER, unit);
    }
  }

  /** 잡은 행의 임대만 놓는다(던지지 않는다. 놓지 못해도 임대가 끝나면 다시 잡힌다) */
  async #releaseLease(job: TicketIssueJob): Promise<void> {
    try {
      await this.deps.jobs.release(job.orderId, job.leaseUntilMs);
    } catch {
      // 삼킨다
    }
  }

  /** stop이 기다릴 일로 적고, 끝나면 뺀다 */
  #track(p: Promise<void>): void {
    const tracked = p.finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
  }

  #attempt(result: TicketIssueAttemptResult): void {
    this.#safe(() => this.deps.signals.attempt(result));
  }

  #runError(what: TicketIssueRunStage, err: unknown, orderId?: string): void {
    this.#safe(() => this.deps.log.runError(orderId !== undefined ? { what, orderId, err } : { what, err }));
  }

  /** 로그·지표·onOrderChanged는 던지지 않기로 했지만, 던져도 실행기를 막지 않는다 */
  #safe(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

const noop = (): undefined => undefined;
const NOTHING: TicketIssueTickResult = Object.freeze({ claimed: 0, delayed: 0, overdue: 0, measured: false });
const ISSUED: TicketIssueOutcome = Object.freeze({ kind: 'ISSUED' });
const SKIPPED_LEASE_LOST: TicketIssueOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
const SKIPPED_RELEASED: TicketIssueOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'RELEASED' });
const SKIPPED_NO_SLOT: TicketIssueOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'NO_SLOT' });
/** 실행기가 받는 실패 코드(밖의 값은 UNKNOWN으로 접는다) */
const KNOWN_CODES: ReadonlySet<TicketIssueFailureCode> = new Set<TicketIssueFailureCode>([...TICKET_ISSUE_RETRY_CODES, ...TICKET_ISSUE_STOP_CODES]);

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: TicketIssueTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
