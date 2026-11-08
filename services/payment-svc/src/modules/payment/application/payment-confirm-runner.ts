// 승인 실행기(docs/features/payment.md §2 '승인 실행기의 첫 구현', docs/data.md §5 '승인 실행기', BUILD_ORDER PRF-181,
// 명세 specs/payment.qnt `send`·`expireCommand`·`respond`·`timeout`·`restart`). purchase-svc OrderSagaRunner·TicketIssueRunner와 같은 꼴이다.
// 모든 API 파드가 100ms [가정]마다 빈자리만큼 승인 명령을 짧은 트랜잭션으로 잡고(claimDue, 임대 75초 [가정]) 커밋한 뒤 잠금 밖에서 결제사를 부른다.
// 틱은 잡기까지만 기다리고 호출을 기다리지 않는다(승인 호출은 60초 [가정]까지 걸려, 기다리면 빈자리가 있어도 다음 틱이 돌지 못한다).
// 행 하나의 차례(confirmGateOf):
//   ① 원장 읽기. ACCEPTED가 아니면 명령 행만 지운다
//   ② 앞 소유자가 있었고 CONFIRM_SENT가 있으면 임대가 끊긴 잔해: 결제사를 부르지 않고 UNKNOWN(조회로 확정, PRF-182)
//   ③ 그 결제사의 어댑터가 없으면 부르지 않고 30초 [가정] 뒤로 미룬다(지표 no_adapter, 파드당 1분에 경고 한 줄)
//   ④ 승인 기한(인증 + capabilities().confirmDeadlineMs)이 지났으면, CONFIRM_SENT가 없으면 부르지 않고 FAILED(EXPIRED), 있으면 UNKNOWN
//   ⑤ markSent로 임대를 확인한다. CONFIRM_SENT가 없으면 표시를 쓰고 커밋한 뒤에 부르고, 있으면(ALREADY) 표시를 더하지 않고 같은 멱등키로 다시 보낸다
//   ⑥ gateway.confirm(주문 ID·결제 참조·원장 금액·confirm-{주문 ID}). 어댑터가 던지면 UNKNOWN(결과를 가정하지 않는다)
//   ⑦ 답 → decideConfirmAnswer(재전송 여부 포함) → 끝난 답은 finish(한 트랜잭션), IN_PROGRESS·THROTTLED는 reschedule(지금 + confirmRetryDelayMs(attempts + 1), 재전송 횟수를 올린다)
//   ⑧ finish가 던지면 100ms·400ms [가정] 뒤 두 번 다시 하고, 그래도 안 되면 행을 그대로 둔다(임대가 끝나면 ②가 UNKNOWN으로 맞춘다)
// 틱·호출은 실행기를 만든 때(시작 파일, 요청 밖)의 비동기 맥락에서 돈다(OrderSagaRunner와 같은 까닭). 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
// 구현에서 정한 것(정본·설계에 없다):
// - 어댑터 없음을 승인 기한보다 먼저 본다(기한은 어댑터 capabilities에서 받는다).
// - 멈춘 뒤에는 새로 잡지 않고, 잡았지만 부르지 않은 행은 임대를 놓는다. stop은 돌던 호출과 그 뒤 쓰기를 기다린다. 종료 유예를 넘겨 프로세스가 끝나면 임대가 끝난 뒤 ②가 UNKNOWN으로 맞춘다.
// - 앞 소유자가 있던 행은 멈출 때 임대를 놓지 않는다(놓으면 lease_owner가 비어 다음 잡기가 잔해로 알아보지 못하고 결제사를 다시 부른다). 임대가 끝나면 다음 잡기가 ②로 본다.
// - 표시를 쓴 뒤 호출 바로 앞에서도 멈췄는지 본다(아직 보내지 않았으므로 임대를 놓아도 다음 실행기가 같은 멱등키로 보낸다).
// - 어댑터가 THROTTLED로 거절해도 지표는 in_progress다(설계의 outcome 값에 throttled가 없고, 상한 조정은 PRF-183이다).
// - 원장을 읽지 못하거나 어댑터의 능력을 받지 못하면(capabilities가 던짐) 부르지 않고 SKIPPED READ_FAILED다. 앞 소유자가 없던 행은 임대를 놓고(남기면 다음 잡기가 잔해로 본다), 앞 소유자가 있던 행은 그대로 둔다. 원장 행이 없으면(외래 키가 있어 나오지 않는다) 오류 한 줄 뒤 명령 행을 지운다.
// - 금액 어긋남의 SEV1 로그는 답을 판단한 때 남긴다(쓰기가 실패해도 어긋남 자체는 알려야 한다).
// - 다시 하기는 finish만 한다. 표시·미루기·지우기는 한 번만 하고, 실패하면 행을 그대로 둔다(임대가 끝나면 다시 잡힌다).
// - 틱은 잡기 전에 빈자리를 먼저 쥔다(겹쳐 부른 틱이 상한을 넘겨 잡지 않게, TicketIssueRunner와 같다). 잡은 수만큼 남기고 나머지는 놓는다.
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import {
  CONFIRM_FINISH_RETRY_DELAYS_MS,
  CONFIRM_LEASE_MS,
  CONFIRM_NO_ADAPTER_DELAY_MS,
  CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS,
  CONFIRM_RUNNER_CONCURRENCY,
  CONFIRM_RUNNER_POLL_INTERVAL_MS,
  type ConfirmFinish,
  confirmGateOf,
  type ConfirmJob,
  confirmRetryDelayMs,
  type ConfirmRunOutcome,
  type ConfirmTarget,
  decideConfirmAnswer,
  type PaymentConfirmOutcome,
} from '../domain/confirm-runner.js';
import { confirmIdemKey, type ConfirmResult, type PaymentGatewayPort } from '../domain/payment-gateway.js';
import type { MarkConfirmSentResult, PaymentConfirmJobs, PaymentConfirmLog, PaymentConfirmSignals, PaymentGateways } from '../domain/ports.js';
import { safeErrorCode } from '../../../safe-error-code.js';

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval·clearInterval) */
export interface ConfirmRunnerTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 실행기가 쓰는 포트와 설정 */
export interface PaymentConfirmRunnerDeps {
  jobs: PaymentConfirmJobs;
  gateways: PaymentGateways;
  log: PaymentConfirmLog;
  signals: PaymentConfirmSignals;
  clock: Clock;
  /** lease_owner에 적는 값(파드 이름) */
  podId: string;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: ConfirmRunnerTimer;
  /** 잡기 주기(기본 CONFIRM_RUNNER_POLL_INTERVAL_MS 100ms [가정]) */
  pollIntervalMs?: number;
  /** 파드의 동시 자리 수(기본 CONFIRM_RUNNER_CONCURRENCY 32 [가정]). 1 이상의 안전한 정수가 아니면 기본값으로 본다 */
  concurrency?: number;
  /** 임대 길이(기본 CONFIRM_LEASE_MS 75초 [가정]) */
  leaseMs?: number;
  /** ms만큼 쉰다(답 반영 다시 하기 사이). 없으면 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

/** 틱 하나의 결과 */
export interface ConfirmTickResult {
  /** 잡은 행 수(부르기 시작한 수이고, 끝난 수가 아니다) */
  readonly claimed: number;
}

/**
 * 승인 실행기. start()로 100ms 반복을 켜고 stop()으로 끈다(돌던 호출과 그 뒤 쓰기를 기다린다).
 * 같은 행을 두 파드가 잡지 않는다(SKIP LOCKED·임대). 겹치면 payment 행 잠금과 status = 'ACCEPTED' 조건이 하나만 쓰게 한다.
 */
export class PaymentConfirmRunner {
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  #stopped = false;
  /** 타이머가 시작한 틱이 도는 중인가(겹치지 않게 하나만) */
  #ticking = false;
  /** 돌고 있는 틱의 잡기와 행(stop·whenIdle이 기다린다) */
  readonly #inflight = new Set<Promise<void>>();
  /** 쥔 자리 수(호출과 그 뒤 쓰기, 잡기 전에 미리 쥔 것 포함) */
  #held = 0;
  /** 지금 돌고 있는 결제사 호출 수(지표) */
  #calls = 0;
  /** 마지막으로 어댑터 없음 경고를 낸 시각(epoch ms) */
  #lastNoAdapterWarnMs: number | undefined;
  /** 만든 때(시작 파일, 요청 밖)의 비동기 맥락. 틱·호출이 이 맥락에서 돈다(끝난 요청의 남은 시간을 물려받지 않게) */
  readonly #scope = new AsyncResource('PaymentConfirmRunner');

  constructor(readonly deps: PaymentConfirmRunnerDeps) {}

  /** 반복을 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다). 앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다 */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#loopTick(), this.deps.pollIntervalMs ?? CONFIRM_RUNNER_POLL_INTERVAL_MS);
  }

  /** 반복을 끄고 돌던 행(호출과 그 뒤 쓰기)을 기다린다. 멈춘 뒤의 틱·start는 아무것도 하지 않는다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.whenIdle();
  }

  /**
   * 틱 하나: 빈자리가 있으면 그만큼 claimDue로 잡고, 잡은 행을 시작만 시키고 돌아온다(호출을 기다리지 않는다). 돌던 행은 whenIdle·stop이 기다린다.
   * 빈자리가 0이거나 멈춘 뒤면 잡지 않고 claimed 0이다. 던지지 않는다(잡기 실패는 log.runError(what claim) 뒤 0)
   */
  async tick(): Promise<ConfirmTickResult> {
    if (this.#stopped) return NOTHING;
    const p = this.#scope.runInAsyncScope(() => this.#tickOnce());
    this.#track(p);
    return p;
  }

  /** 지금 돌고 있는 행이 모두 끝나면 풀린다(시험과 stop이 쓴다) */
  async whenIdle(): Promise<void> {
    // 틱이 끝나며 행을 더 시작할 수 있어 비어 있을 때까지 다시 본다
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /**
   * 잡은 행 하나를 돈다(머리 주석의 차례). 던지지 않는다. 호출·쓰기가 실패하면 해당 ConfirmRunOutcome을 돌려준다.
   * 빈자리를 쥐고 돌며(동시 상한), 멈춘 뒤면 부르지 않고 임대를 놓아 SKIPPED RELEASED다.
   * 지표: 끝난 행마다 outcome 하나(FINISHED·RETRY 갈래). STALE·SKIPPED·DROPPED·WRITE_FAILED는 outcome을 세지 않는다(WRITE_FAILED는 writeFailure를 센다)
   */
  async runJob(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    this.#held += 1;
    return this.#startHeld(job);
  }

  // ---- 안쪽 ----

  #timer(): ConfirmRunnerTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  #concurrency(): number {
    const c = this.deps.concurrency ?? CONFIRM_RUNNER_CONCURRENCY;
    return Number.isSafeInteger(c) && c >= 1 ? c : CONFIRM_RUNNER_CONCURRENCY;
  }

  /** 반복 타이머의 틱: 앞 틱의 잡기가 아직 돌면 건너뛴다. 멈춘 뒤에는 돌지 않는다 */
  #loopTick(): void {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = true;
    void this.tick().finally(() => {
      this.#ticking = false;
    });
  }

  async #tickOnce(): Promise<ConfirmTickResult> {
    // 잡기 전에 빈자리를 쥔다(머리 주석 '구현에서 정한 것')
    const reserved = Math.max(0, this.#concurrency() - this.#held);
    if (reserved === 0) return NOTHING;
    this.#held += reserved;
    let jobs: ConfirmJob[] = [];
    try {
      jobs = await this.deps.jobs.claimDue(reserved, this.deps.podId, this.deps.leaseMs ?? CONFIRM_LEASE_MS);
    } catch (err) {
      this.#runError('claim', err);
    }
    // 잡은 행마다 쥔 자리 하나를 넘기고 남은 자리는 놓는다. 호출을 기다리지 않는다
    this.#held -= Math.max(0, reserved - jobs.length);
    for (const job of jobs) void this.#startHeld(job);
    return { claimed: jobs.length };
  }

  /** 자리를 이미 쥔 행을 시작한다(stop·whenIdle이 기다리게 적는다) */
  #startHeld(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    const p = this.#scope.runInAsyncScope(() => this.#runHeld(job));
    this.#track(p);
    return p;
  }

  /** 자리를 쥔 채 행 하나를 돈다. 끝나면(어느 갈래든) 자리를 놓는다 */
  async #runHeld(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    try {
      return await this.#run(job);
    } finally {
      this.#held -= 1;
    }
  }

  async #run(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    if (this.#stopped) return this.#letGo(job);
    let target: ConfirmTarget | undefined;
    let gateway: PaymentGatewayPort | undefined;
    let deadlineMs: number | undefined;
    try {
      target = await this.deps.jobs.read(job.paymentId);
      if (target !== undefined) {
        gateway = this.deps.gateways.of(target.pg);
        deadlineMs = gateway?.capabilities().confirmDeadlineMs;
      }
    } catch (err) {
      this.#runError('read', err);
      await this.#letGo(job);
      return READ_FAILED;
    }
    if (target === undefined) {
      this.#runError('read', new Error('승인 명령의 원장 행이 없다'));
      return this.#drop(job, undefined);
    }
    if (this.#stopped) return this.#letGo(job);

    const gate = confirmGateOf(target, job, deadlineMs, this.deps.clock.now());
    switch (gate.kind) {
      case 'DROP_JOB':
        return this.#drop(job, target);
      case 'UNKNOWN':
        return this.#finish(target, { status: 'UNKNOWN', result: 'UNKNOWN' }, gate.cause === 'restart' ? 'restart' : 'unknown');
      case 'NO_ADAPTER':
        return this.#noAdapter(job, target);
      case 'EXPIRE':
        return this.#finish(target, { status: 'FAILED', failureCategory: 'EXPIRED' }, 'expired');
      case 'SEND':
        return this.#send(job, target, gateway!, gate.markFirst);
    }
  }

  /** 표시·임대 확인 → 호출 → 답 반영 */
  async #send(job: ConfirmJob, target: ConfirmTarget, gateway: PaymentGatewayPort, markFirst: boolean): Promise<ConfirmRunOutcome> {
    let mark: MarkConfirmSentResult;
    try {
      mark = await this.deps.jobs.markSent(job);
    } catch (err) {
      // 표시 없이 보낸 호출은 재시작 때 가려낼 수 없고, 재전송은 임대를 확인하지 못했으므로 부르지 않는다
      return this.#writeFailed(target, 'mark', err);
    }
    if (mark === 'LEASE_LOST') return LEASE_LOST;
    if (mark === 'STALE') return this.#drop(job, target);
    if (this.#stopped) return this.#letGo(job);
    // 읽은 뒤 다른 실행이 표시를 썼으면(ALREADY) 앞선 요청이 있는 것이라 재전송으로 본다
    const resend = !markFirst || mark === 'ALREADY';

    const startedMs = this.deps.clock.monotonicMs();
    this.#calls += 1;
    this.#safe(() => this.deps.signals.inFlight(this.#calls));
    let answer: ConfirmResult | undefined;
    let failure: { err: unknown } | undefined;
    try {
      answer = await gateway.confirm({ orderId: target.orderId, paymentRef: target.paymentRef, amount: target.amount, idemKey: confirmIdemKey(target.orderId) });
    } catch (err) {
      failure = { err };
    } finally {
      this.#calls -= 1;
      this.#safe(() => this.deps.signals.inFlight(this.#calls));
    }
    const latencyMs = Math.max(0, Math.round(this.deps.clock.monotonicMs() - startedMs));
    this.#safe(() => this.deps.signals.callSeconds(target.pg, latencyMs / 1000));

    if (failure !== undefined || answer === undefined) {
      // 읽기 시간 초과·연결 실패 등: 결과를 가정하지 않는다
      this.#runError('call', failure?.err, target.orderId);
      return this.#finish(target, { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs }, 'unknown');
    }
    const decision = decideConfirmAnswer(answer, target.amount, this.deps.clock.now(), latencyMs, resend);
    if (decision.kind === 'RETRY') return this.#reschedule(job, target, decision.outcome, this.deps.clock.now() + confirmRetryDelayMs(job.attempts + 1));
    if (decision.amountMismatch) this.#safe(() => this.deps.log.amountMismatch({ orderId: target.orderId }));
    return this.#finish(target, decision.finish, decision.outcome);
  }

  /** 어댑터가 없다: 미루고 지표를 세며 파드당 1분에 경고 한 줄 */
  #noAdapter(job: ConfirmJob, target: ConfirmTarget): Promise<ConfirmRunOutcome> {
    const now = this.deps.clock.now();
    if (this.#lastNoAdapterWarnMs === undefined || now - this.#lastNoAdapterWarnMs >= CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS) {
      this.#lastNoAdapterWarnMs = now;
      this.#safe(() => this.deps.log.noAdapter({ pg: target.pg }));
    }
    return this.#reschedule(job, target, 'no_adapter', now + CONFIRM_NO_ADAPTER_DELAY_MS);
  }

  async #reschedule(job: ConfirmJob, target: ConfirmTarget, outcome: 'in_progress' | 'no_adapter', nextAtMs: number): Promise<ConfirmRunOutcome> {
    let ok: boolean;
    try {
      ok = await this.deps.jobs.reschedule(job, nextAtMs, { countRetry: outcome === 'in_progress' });
    } catch (err) {
      return this.#writeFailed(target, 'reschedule', err);
    }
    if (!ok) return LEASE_LOST;
    this.#outcome(target, outcome);
    return { kind: 'RETRY', outcome, nextAtMs };
  }

  /** 명령 행만 지운다. target이 없으면(원장 행 없음) 쓰기 실패를 로그에 남길 주문 ID가 없다 */
  async #drop(job: ConfirmJob, target: ConfirmTarget | undefined): Promise<ConfirmRunOutcome> {
    let ok: boolean;
    try {
      ok = await this.deps.jobs.dropJob(job);
    } catch (err) {
      if (target !== undefined) return this.#writeFailed(target, 'drop', err);
      this.#runError('read', err);
      this.#safe(() => this.deps.signals.writeFailure());
      return { kind: 'WRITE_FAILED', stage: 'drop' };
    }
    return ok ? DROPPED : LEASE_LOST;
  }

  /** 답 반영(원장·사건·Outbox·명령 행 지움 한 트랜잭션). 던지면 100ms·400ms 뒤 두 번 다시 한다 */
  async #finish(target: ConfirmTarget, finish: ConfirmFinish, outcome: PaymentConfirmOutcome): Promise<ConfirmRunOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.deps.jobs.finish(target, finish);
        if (result === 'STALE') {
          this.#safe(() => this.deps.log.staleAnswer({ orderId: target.orderId }));
          return STALE;
        }
        this.#outcome(target, outcome);
        return { kind: 'FINISHED', status: finish.status, outcome };
      } catch (err) {
        const delayMs = CONFIRM_FINISH_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) return this.#writeFailed(target, 'finish', err);
        await (this.deps.sleep ?? defaultSleep)(delayMs);
      }
    }
  }

  /**
   * 멈춘 뒤라 부르지 않는다. 앞 소유자가 없던 행만 임대를 놓는다(앞 소유자가 있던 행은 다음 잡기가 잔해로 보게 그대로 둔다).
   * 놓기가 실패해도 임대가 끝나면 다시 잡힌다
   */
  async #letGo(job: ConfirmJob): Promise<ConfirmRunOutcome> {
    if (!job.hadPreviousOwner) {
      try {
        await this.deps.jobs.release(job);
      } catch {
        // 삼킨다
      }
    }
    return RELEASED;
  }

  #writeFailed(target: ConfirmTarget, stage: 'mark' | 'finish' | 'reschedule' | 'drop', err: unknown): ConfirmRunOutcome {
    this.#safe(() => this.deps.signals.writeFailure());
    this.#safe(() => this.deps.log.writeFailed({ orderId: target.orderId, stage, code: safeErrorCode(err) }));
    return { kind: 'WRITE_FAILED', stage };
  }

  #outcome(target: ConfirmTarget, outcome: PaymentConfirmOutcome): void {
    this.#safe(() => this.deps.signals.outcome(target.pg, outcome));
  }

  #runError(what: 'claim' | 'read' | 'call', err: unknown, orderId?: string): void {
    this.#safe(() => this.deps.log.runError(orderId === undefined ? { what, err } : { what, orderId, err }));
  }

  /** stop·whenIdle이 기다릴 일로 적고, 끝나면 뺀다 */
  #track(p: Promise<unknown>): void {
    const tracked: Promise<void> = p.then(noop, noop).finally(() => {
      this.#inflight.delete(tracked);
    });
    this.#inflight.add(tracked);
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

const noop = (): undefined => undefined;
const NOTHING: ConfirmTickResult = Object.freeze({ claimed: 0 });
const DROPPED: ConfirmRunOutcome = Object.freeze({ kind: 'DROPPED' });
const STALE: ConfirmRunOutcome = Object.freeze({ kind: 'STALE' });
const LEASE_LOST: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
const RELEASED: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'RELEASED' });
const READ_FAILED: ConfirmRunOutcome = Object.freeze({ kind: 'SKIPPED', reason: 'READ_FAILED' });

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: ConfirmRunnerTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
