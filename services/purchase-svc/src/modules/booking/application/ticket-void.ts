// 티켓 무효 실행기(입금 오류 되돌림 T21 뒤, docs/features/payment.md §6, BUILD_ORDER HOT-152). TicketIssueRunner(ticket-issue.ts)를 줄인 꼴이다.
// T21 트랜잭션이 넣은 ticket_void_job 행을 커밋 뒤 kick으로 곧바로, 놓친 행은 1초 [가정] 틱으로 돈다. 일시 실패는 발권과 같은 간격으로 다시 보내고, 다시 보내도 같은 실패면 멈추고 SEV1이다
// (이 행이 남아 있는 동안 재발권 잡기와 좌석 해제가 기다린다). 무효로 한 세대에 입장 기록이 있으면 행을 끝낸 뒤 SEV1을 낸다(BUILD_ORDER HOT-152 코드 리뷰).
import { AsyncResource } from 'node:async_hooks';
import type { Clock } from '@peaket/platform';
import { TicketIssueCallError, type TicketVoider, type TicketVoidJob, type TicketVoidJobs, type TicketVoidLog, type TicketVoidSignals } from '../domain/ports.js';
import { TICKET_ISSUE_CALL_DEADLINE_MS, TICKET_ISSUE_LEASE_MS, TICKET_ISSUE_POLL_INTERVAL_MS, type TicketIssueFailureCode, ticketIssueFailureKind, ticketIssueRetryDelayMs } from '../domain/ticket-issue.js';
import type { TicketIssueTimer } from './ticket-issue.js';

/** 한 틱에 잡는 행 수 20건 [가정](되돌림은 드물다) */
const TICKET_VOID_CLAIM_LIMIT = 20;

export interface TicketVoidDeps {
  jobs: TicketVoidJobs;
  voider: TicketVoider;
  log: TicketVoidLog;
  signals: TicketVoidSignals;
  clock: Clock;
  /** 없으면 전역 setInterval·clearInterval(unref) */
  timer?: TicketIssueTimer;
  /** 흔들기 난수([0, 1)). 없으면 Math.random */
  random?: () => number;
}

/** 실행기. start()로 1초 반복을 켜고 stop()으로 끈다. kick(orderId)은 T21 커밋 직후 기다리지 않고 한 번 돈다 */
export class TicketVoidRunner {
  #handle: unknown;
  #stopped = false;
  readonly #inflight = new Set<Promise<unknown>>();
  /** 만든 때(시작 파일)의 비동기 맥락. kick·틱이 요청 맥락의 남은 시간을 물려받지 않게 한다 */
  readonly #scope = new AsyncResource('TicketVoidRunner');

  constructor(readonly deps: TicketVoidDeps) {}

  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => void this.#track(this.#scope.runInAsyncScope(() => this.tick())), TICKET_ISSUE_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await Promise.allSettled([...this.#inflight]);
  }

  kick(orderId: string): void {
    if (this.#stopped) return;
    void this.#track(this.#scope.runInAsyncScope(() => this.runOne(orderId)));
  }

  /** 틱 하나. 잡은 행을 다 돌고 잡은 수를 돌려준다. 던지지 않는다 */
  async tick(): Promise<number> {
    if (this.#stopped) return 0;
    let jobs: TicketVoidJob[] = [];
    try {
      jobs = await this.deps.jobs.claimDue(TICKET_VOID_CLAIM_LIMIT, TICKET_ISSUE_LEASE_MS);
    } catch (err) {
      this.#runError('claim', err);
    }
    await Promise.all(jobs.map((job) => this.#run(job)));
    return jobs.length;
  }

  /** kick과 같은 일을 기다리며 한다(시험·kick이 쓴다). 던지지 않는다 */
  async runOne(orderId: string): Promise<void> {
    if (this.#stopped) return;
    let job: TicketVoidJob | undefined;
    try {
      job = await this.deps.jobs.claim(orderId, TICKET_ISSUE_LEASE_MS);
    } catch (err) {
      this.#runError('claim', err, orderId);
    }
    if (job !== undefined) await this.#run(job);
  }

  #timer(): TicketIssueTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
    return p;
  }

  /** 행 하나: 부르고, 답에 맞는 쓰기 하나. 쓰기가 던지면 임대가 끝난 뒤 다시 잡힌다(세대로 멱등이다). 던지지 않는다 */
  async #run(job: TicketVoidJob): Promise<void> {
    let code: TicketIssueFailureCode | undefined;
    let alreadyEntered = 0;
    try {
      ({ alreadyEntered } = await this.deps.voider.voidTickets({ orderId: job.orderId, eventId: job.eventId, issueGeneration: job.issueGeneration, deadlineMs: TICKET_ISSUE_CALL_DEADLINE_MS }));
    } catch (err) {
      if (err instanceof TicketIssueCallError) code = err.code;
      else {
        this.#runError('call', err, job.orderId);
        code = 'UNKNOWN';
      }
    }
    try {
      if (code === undefined) {
        if (await this.deps.jobs.done(job.orderId, job.leaseUntilMs)) {
          this.#attempt('voided');
          // 행을 끝낸 파드만 낸다(임대를 잃었으면 이어 받은 실행이 같은 값을 받아 낸다)
          if (alreadyEntered > 0) this.#safe(() => this.deps.log.alreadyEntered({ orderId: job.orderId, count: alreadyEntered }));
        }
      } else if (ticketIssueFailureKind(code) === 'RETRY') {
        const nextAtMs = this.deps.clock.now() + ticketIssueRetryDelayMs(job.attempts + 1, this.#unit());
        if (await this.deps.jobs.retry({ orderId: job.orderId, nextAtMs, code, leaseUntilMs: job.leaseUntilMs })) this.#attempt('retry');
      } else if (await this.deps.jobs.stop({ orderId: job.orderId, code, leaseUntilMs: job.leaseUntilMs })) {
        const stopped = code;
        this.#safe(() => this.deps.log.stopped({ orderId: job.orderId, code: stopped }));
        this.#attempt('stopped');
      }
    } catch (err) {
      this.#runError('write', err, job.orderId);
    }
  }

  /** 흔들기 난수([0, 1) 밖이면 0.5) */
  #unit(): number {
    const raw = (this.deps.random ?? Math.random)();
    return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.5;
  }

  #attempt(result: 'voided' | 'retry' | 'stopped'): void {
    this.#safe(() => this.deps.signals.attempt(result));
  }

  #runError(what: 'claim' | 'call' | 'write', err: unknown, orderId?: string): void {
    this.#safe(() => this.deps.log.runError(orderId === undefined ? { what, err } : { what, orderId, err }));
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

/** 기본 반복 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: TicketIssueTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
