// 발권 실행기(booking application/ticket-issue.ts TicketIssueRunner, docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현', ADR-0106 결정 2,
// docs/data.md §5 '발권 재시도 큐를 두 파드가 함께 잡음', 명세 specs/payment.qnt issue·issueAck·issueFailed·overdue, BUILD_ORDER PRF-170)를 메모리 가짜 포트로 본다.
// - runJob: IssueTickets 입력, 성공 → complete·지표 issued·onOrderChanged, STALE → 경고·지표 stale, LEASE_LOST → 아무것도 하지 않음,
//   다시 보낼 실패 → retry(다음 시각 = 지금 + 늘려 쉬기), 다시 보내지 않을 실패·맞지 않는 답 → stop·SEV2 로그, 쓰기 실패 → ERROR·임대 그대로
// - runOne·kick: 그 주문을 곧바로 잡아 돈다(NO_JOB·LEASED 가름), 요청 맥락을 물려받지 않는다
// - tick: ISSUE_DELAYED·기한 넘김을 틱마다, 게이지 10초마다, 50건 잡기, 파드 동시 8개, 남은 임대 5초 미만이면 놓기, 단계끼리 막지 않음
// - start·stop: 1초 반복 하나, 틱이 겹치지 않음, 예상 밖 오류에 반복이 죽지 않음, stop이 돌던 호출을 기다리고 시작하지 않은 행의 임대를 놓음
// 가짜는 DB가 할 일을 흉내 낸다: claim은 임대 중이 아니면 지금 + 임대로 잡고, complete CONFIRMED·STALE이면 큐 행을 지운다.
// 실제 PostgreSQL로 도는 잡기·성공 트랜잭션·ISSUE_DELAYED 한 번은 test-int/ticket-issue.int.test.ts(다른 담당)다.
import { Deadline, fakeClock, type FakeClock, type RequestContext, requestContext, runInRequestContext } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  type IssuedTicketRef,
  TICKET_ISSUE_LEASE_MIN_REMAINING_MS,
  TICKET_ISSUE_RETRY_CODES,
  TICKET_ISSUE_STOP_CODES,
  TicketIssueCallError,
  type TicketIssueAttemptResult,
  type TicketIssueCommand,
  type TicketIssueCompleteInput,
  type TicketIssueCompleteOutcome,
  type TicketIssueDeps,
  type TicketIssueGauges,
  type TicketIssueJob,
  type TicketIssueJobs,
  type TicketIssueLog,
  type TicketIssuer,
  type TicketIssueRetryInput,
  TicketIssueRunner,
  type TicketIssueSignals,
  type TicketIssueStopInput,
  type TicketIssueTimer,
  ticketIssueRetryDelayMs,
} from '../src/modules/booking/index.js';
import { ACCOUNT, EVENT, NOW } from './order-cases.js';

const ORDER_ID = '0190f3a1-7c2e-7f00-8000-0000000000f1';
const ORDER_B = '0190f3a1-7c2e-7f00-8000-0000000000f2';
const ORDER_C = '0190f3a1-7c2e-7f00-8000-0000000000f3';
/** 주문 좌석(줄 번호 차례. 정렬 차례가 아니게 둔다) */
const SEAT_1 = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_2 = '0190f3a1-7c2e-7a00-8000-00000000a002';
const SEAT_IDS: readonly string[] = Object.freeze([SEAT_2, SEAT_1]);
/** 좌석별 티켓 ID(ticket-svc가 만든 소문자 UUID) */
const TICKET_OF: Readonly<Record<string, string>> = Object.freeze({
  [SEAT_1]: '0190f3a1-7c2e-7b00-8000-0000000c0001',
  [SEAT_2]: '0190f3a1-7c2e-7b00-8000-0000000c0002',
});
const MIN = 60_000;
/** 잡은 행의 임대 끝(지금 + 30초) */
const LEASE = NOW + 30_000;

/** i번째 주문 ID(동시 상한 시험용) */
const orderN = (i: number): string => `0190f3a1-7c2e-7f00-8000-${(0x100000 + i).toString(16).padStart(12, '0')}`;

/** 잡은 큐 행(처음 시도, 임대 30초) */
function issueJob(over: Partial<TicketIssueJob> = {}): TicketIssueJob {
  return {
    orderId: ORDER_ID,
    eventId: EVENT,
    payerAccountId: ACCOUNT,
    seatIds: SEAT_IDS,
    issueGeneration: 0,
    attempts: 0,
    nextAttemptAtMs: NOW,
    issueDueAtMs: NOW + 30 * MIN,
    createdAtMs: NOW,
    leaseUntilMs: LEASE,
    ...over,
  };
}

/** 좌석마다 티켓 하나(답 차례는 좌석 차례의 거꾸로: 실행기가 차례를 보지 않는지) */
const ticketsFor = (seatIds: readonly string[]): IssuedTicketRef[] => [...seatIds].reverse().map((seatId) => ({ seatId, ticketId: TICKET_OF[seatId] ?? '0190f3a1-7c2e-7b00-8000-0000000c00ff' }));

type Call =
  | 'jobs.claimDue'
  | 'jobs.claim'
  | 'jobs.get'
  | 'jobs.complete'
  | 'jobs.retry'
  | 'jobs.stop'
  | 'jobs.release'
  | 'jobs.markDelayed'
  | 'jobs.markOverdue'
  | 'jobs.gauges'
  | 'issuer.issue'
  | 'log.stopped'
  | 'log.overdue'
  | 'log.staleAnswer'
  | 'log.runError'
  | 'signals.jobs'
  | 'signals.attempt'
  | 'signals.delayed'
  | 'signals.overdue'
  | 'onOrderChanged';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 기다리지 않고 둔 약속(뒤에서 await한다). 그 전에 시험이 실패해도 처리되지 않은 거절로 남지 않게 빈 처리기를 단다(await하면 거절은 그대로 보인다) */
function later<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

/** 마이크로태스크·즉시 실행 몇 바퀴를 돌린다(kick·틱처럼 기다리지 않는 일이 끝나게) */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** 반복 타이머 대역(손으로 틱을 부른다) */
class FakeTimer implements TicketIssueTimer {
  readonly set: { fn: () => void; ms: number; handle: object }[] = [];
  readonly cleared: unknown[] = [];
  setInterval(fn: () => void, ms: number): unknown {
    const handle = { n: this.set.length };
    this.set.push({ fn, ms, handle });
    return handle;
  }
  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
  }
  tick(): void {
    const last = this.set.at(-1);
    if (!last) throw new Error('setInterval을 부르지 않았다');
    last.fn();
  }
}

/** 던질 값(Error가 아닌 것도 던지게 싼다) */
type Throw = { readonly throws: unknown };
const throws = (v: unknown): Throw => ({ throws: v });
const isThrow = (v: unknown): v is Throw => typeof v === 'object' && v !== null && 'throws' in v;

/** 발권 실행기 포트의 메모리 가짜. calls에 부른 차례를 적고 포트마다 인자를 적는다. 값을 넣어 두면 그대로 답하고 Error면 던진다 */
class IssueFakes {
  calls: Call[] = [];
  /** claim·get이 보는 큐 행 */
  rows = new Map<string, TicketIssueJob>();
  /** 다른 실행이 임대 중이거나 기한 전·멈춘 행이라 claim이 잡지 못하는 주문 */
  leased = new Set<string>();
  due: TicketIssueJob[] | Error = [];
  dueGate: Promise<void> | undefined;
  claimError: Error | undefined;
  /** 차례로 꺼내 답한다. 비면 CONFIRMED */
  completeQueue: (TicketIssueCompleteOutcome | Error)[] = [];
  retryAnswer: boolean | Error = true;
  stopAnswer: boolean | Error = true;
  delayedAnswer: string[] | Error = [];
  overdueAnswer: string[] | Error = [];
  gaugeAnswer: TicketIssueGauges | Error = { pending: 3, stopped: 1, oldestAgeSeconds: 42 };

  /** 차례로 꺼내 답한다. 비면 좌석마다 티켓 하나 */
  issueQueue: (readonly IssuedTicketRef[] | Throw)[] = [];
  /** 참이면 발권 호출이 손으로 풀 때까지 기다린다 */
  holdIssue = false;
  readonly held: { orderId: string; resolve: () => void }[] = [];
  inFlight = 0;
  maxInFlight = 0;

  claimDueArgs: [number, number][] = [];
  claimArgs: [string, number][] = [];
  getArgs: string[] = [];
  completes: TicketIssueCompleteInput[] = [];
  retries: TicketIssueRetryInput[] = [];
  stops: TicketIssueStopInput[] = [];
  releases: [string, number][] = [];
  delayedArgs: number[] = [];
  overdueArgs: number[] = [];
  issueCommands: TicketIssueCommand[] = [];
  /** 발권 호출 때의 요청 맥락 */
  contexts: unknown[] = [];
  stoppedLogs: Parameters<TicketIssueLog['stopped']>[0][] = [];
  overdueLogs: Parameters<TicketIssueLog['overdue']>[0][] = [];
  staleLogs: Parameters<TicketIssueLog['staleAnswer']>[0][] = [];
  runErrors: Parameters<TicketIssueLog['runError']>[0][] = [];
  gaugeSignals: TicketIssueGauges[] = [];
  attempts: TicketIssueAttemptResult[] = [];
  delayedCounts: number[] = [];
  overdueCounts: number[] = [];
  changed: string[] = [];

  constructor(private readonly clock: FakeClock) {}

  /** 큐 행을 둔다(claim·get이 본다) */
  put(job: TicketIssueJob = issueJob()): void {
    this.rows.set(job.orderId, job);
  }

  /** 붙잡힌 발권 호출을 모두 푼다 */
  releaseHeld(): void {
    for (const h of this.held.splice(0)) h.resolve();
  }

  readonly jobs: TicketIssueJobs = {
    claimDue: async (limit, leaseMs) => {
      this.calls.push('jobs.claimDue');
      this.claimDueArgs.push([limit, leaseMs]);
      if (this.dueGate) await this.dueGate;
      if (this.due instanceof Error) throw this.due;
      return this.due.map((j) => ({ ...j }));
    },
    claim: async (orderId, leaseMs) => {
      this.calls.push('jobs.claim');
      this.claimArgs.push([orderId, leaseMs]);
      if (this.claimError) throw this.claimError;
      const j = this.rows.get(orderId);
      if (!j || this.leased.has(orderId)) return undefined;
      this.leased.add(orderId);
      return { ...j, leaseUntilMs: this.clock.now() + leaseMs };
    },
    get: async (orderId) => {
      this.calls.push('jobs.get');
      this.getArgs.push(orderId);
      return this.rows.get(orderId);
    },
    complete: async (input) => {
      this.calls.push('jobs.complete');
      this.completes.push(input);
      const v = this.completeQueue.length > 0 ? this.completeQueue.shift()! : ({ status: 'CONFIRMED' } as const);
      if (v instanceof Error) throw v;
      if (v.status !== 'LEASE_LOST') this.rows.delete(input.orderId);
      return v;
    },
    retry: async (input) => {
      this.calls.push('jobs.retry');
      this.retries.push(input);
      if (this.retryAnswer instanceof Error) throw this.retryAnswer;
      return this.retryAnswer;
    },
    stop: async (input) => {
      this.calls.push('jobs.stop');
      this.stops.push(input);
      if (this.stopAnswer instanceof Error) throw this.stopAnswer;
      return this.stopAnswer;
    },
    release: async (orderId, leaseUntilMs) => {
      this.calls.push('jobs.release');
      this.releases.push([orderId, leaseUntilMs]);
      this.leased.delete(orderId);
      return true;
    },
    markDelayed: async (limit) => {
      this.calls.push('jobs.markDelayed');
      this.delayedArgs.push(limit);
      if (this.delayedAnswer instanceof Error) throw this.delayedAnswer;
      return [...this.delayedAnswer];
    },
    markOverdue: async (limit) => {
      this.calls.push('jobs.markOverdue');
      this.overdueArgs.push(limit);
      if (this.overdueAnswer instanceof Error) throw this.overdueAnswer;
      return [...this.overdueAnswer];
    },
    gauges: async () => {
      this.calls.push('jobs.gauges');
      if (this.gaugeAnswer instanceof Error) throw this.gaugeAnswer;
      return this.gaugeAnswer;
    },
  };

  readonly issuer: TicketIssuer = {
    issue: async (c) => {
      this.calls.push('issuer.issue');
      this.issueCommands.push(c);
      this.contexts.push(requestContext());
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        if (this.holdIssue) await new Promise<void>((resolve) => this.held.push({ orderId: c.orderId, resolve }));
        const v = this.issueQueue.length > 0 ? this.issueQueue.shift()! : ticketsFor(c.seatIds);
        if (isThrow(v)) throw v.throws;
        return v;
      } finally {
        this.inFlight -= 1;
      }
    },
  };

  readonly log: TicketIssueLog = {
    stopped: (e) => {
      this.calls.push('log.stopped');
      this.stoppedLogs.push(e);
    },
    overdue: (e) => {
      this.calls.push('log.overdue');
      this.overdueLogs.push(e);
    },
    staleAnswer: (e) => {
      this.calls.push('log.staleAnswer');
      this.staleLogs.push(e);
    },
    runError: (e) => {
      this.calls.push('log.runError');
      this.runErrors.push(e);
    },
  };

  readonly signals: TicketIssueSignals = {
    jobs: (g) => {
      this.calls.push('signals.jobs');
      this.gaugeSignals.push(g);
    },
    attempt: (r) => {
      this.calls.push('signals.attempt');
      this.attempts.push(r);
    },
    delayed: (n) => {
      this.calls.push('signals.delayed');
      this.delayedCounts.push(n);
    },
    overdue: (n) => {
      this.calls.push('signals.overdue');
      this.overdueCounts.push(n);
    },
  };

  readonly onOrderChanged = (orderId: string): void => {
    this.calls.push('onOrderChanged');
    this.changed.push(orderId);
  };
}

let clock: FakeClock;
let fx: IssueFakes;
let timer: FakeTimer;

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  fx = new IssueFakes(clock);
  timer = new FakeTimer();
});

const deps = (over: Partial<TicketIssueDeps> = {}): TicketIssueDeps => ({
  jobs: fx.jobs,
  issuer: fx.issuer,
  log: fx.log,
  signals: fx.signals,
  clock,
  timer,
  random: () => 0.5,
  onOrderChanged: fx.onOrderChanged,
  ...over,
});
const runner = (over: Partial<TicketIssueDeps> = {}) => new TicketIssueRunner(deps(over));

/** 이 포트들은 부르지 않았다 */
function notCalled(...ports: Call[]): void {
  for (const p of ports) expect(fx.calls, `${p}를 부르면 안 된다`).not.toContain(p);
}
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
/** 좌석 차례를 무시한 티켓 묶음 */
const sortedTickets = (ts: readonly IssuedTicketRef[]) => [...ts].sort((a, b) => a.seatId.localeCompare(b.seatId));

describe('runJob: 맞는 답이면 성공 반영(설계 4)', () => {
  test('IssueTickets 입력은 주문 ID·회차·결제자·좌석(줄 번호 차례)·데드라인 2초이고, 답이 좌석과 맞으면 complete(좌석별 티켓·행위자 system:ticket-issue·자기 임대) 한 번 뒤 ISSUED·지표 issued·onOrderChanged 한 번이다 (P-T15, ADR0106) [ASVS v5.0.0-2.3.3]', async () => {
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'ISSUED' });
    expect(fx.issueCommands).toEqual([{ orderId: ORDER_ID, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_2, SEAT_1], deadlineMs: 2000 }]);
    expect(fx.completes).toHaveLength(1);
    const c = fx.completes[0]!;
    expect({ ...c, tickets: sortedTickets(c.tickets) }).toEqual({
      orderId: ORDER_ID,
      tickets: [
        { seatId: SEAT_1, ticketId: TICKET_OF[SEAT_1] },
        { seatId: SEAT_2, ticketId: TICKET_OF[SEAT_2] },
      ],
      actor: 'system:ticket-issue',
      leaseUntilMs: LEASE,
    });
    expect(fx.attempts).toEqual(['issued']);
    expect(fx.changed).toEqual([ORDER_ID]);
    // 성공은 complete 한 트랜잭션뿐이다(다시 보내기·멈추기·임대 놓기·주문 이력 T19 없음)
    notCalled('jobs.retry', 'jobs.stop', 'jobs.release', 'log.stopped', 'log.staleAnswer', 'log.runError');
  });

  test('onOrderChanged는 complete 커밋 뒤에 부른다(같은 파드의 long polling 기다림을 깨운다) (ADR0106)', async () => {
    await runner().runJob(issueJob());
    expect(fx.calls.indexOf('onOrderChanged')).toBeGreaterThan(fx.calls.indexOf('jobs.complete'));
  });

  test('callDeadlineMs를 주면 그 데드라인으로 부른다', async () => {
    await runner({ callDeadlineMs: 750 }).runJob(issueJob());
    expect(fx.issueCommands.map((c) => c.deadlineMs)).toEqual([750]);
  });

  test.each(['CONFIRMED', 'COMPENSATED', 'REFUNDED'] as const)(
    '늦게 온 발권 답: complete가 STALE(지금 %s)이면 STALE·경고 한 줄(주문 ID·지금 상태)·지표 stale이고 onOrderChanged를 부르지 않는다(명세 issueAck 조건부) [ASVS v5.0.0-2.3.1]',
    async (current) => {
      fx.completeQueue = [{ status: 'STALE', current }];
      expect(await runner().runJob(issueJob())).toEqual({ kind: 'STALE', current });
      expect(fx.staleLogs).toEqual([{ orderId: ORDER_ID, current }]);
      expect(fx.attempts).toEqual(['stale']);
      expect(fx.changed).toEqual([]);
      notCalled('jobs.retry', 'jobs.stop', 'log.stopped');
    },
  );

  test('complete가 LEASE_LOST(다른 실행이 이어 받았거나 보상이 지웠다)면 SKIPPED LEASE_LOST이고 지표·로그·onOrderChanged가 없다 [ASVS v5.0.0-2.3.4]', async () => {
    fx.completeQueue = [{ status: 'LEASE_LOST' }];
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    expect(fx.attempts).toEqual([]);
    expect(fx.changed).toEqual([]);
    notCalled('log.stopped', 'log.staleAnswer', 'log.runError', 'jobs.retry', 'jobs.stop');
  });

  test('onOrderChanged가 던져도 결과는 ISSUED 그대로다', async () => {
    const r = runner({
      onOrderChanged: () => {
        throw new Error('boom');
      },
    });
    expect(await r.runJob(issueJob())).toEqual({ kind: 'ISSUED' });
    expect(fx.attempts).toEqual(['issued']);
  });
});

describe('runJob: 다시 보낼 실패(설계 5)', () => {
  test.each([...TICKET_ISSUE_RETRY_CODES])(
    '%s면 retry(다음 시각 = 지금 + 늘려 쉬기, 코드, 자기 임대)이고 RETRY·지표 retry다. 결제를 취소하지 않고 멈추지 않는다 (P-T39 ①, ADR0106) [ASVS v5.0.0-16.5.2]',
    async (code) => {
      fx.issueQueue = [throws(new TicketIssueCallError(code))];
      const nextAtMs = NOW + ticketIssueRetryDelayMs(1, 0.5);
      expect(await runner().runJob(issueJob())).toEqual({ kind: 'RETRY', code, nextAtMs });
      expect(fx.retries).toEqual([{ orderId: ORDER_ID, nextAtMs, code, leaseUntilMs: LEASE }]);
      expect(fx.attempts).toEqual(['retry']);
      notCalled('jobs.complete', 'jobs.stop', 'log.stopped', 'onOrderChanged');
    },
  );

  test.each([
    [0, 0.5, 1000],
    [1, 0.5, 2000],
    [2, 0.5, 4000],
    [6, 0.5, 60_000],
    [20, 0.5, 60_000],
    [6, 0, 48_000],
    [0, 0, 800],
  ])('지금까지 %i번 시도, 흔들기 난수 %s면 다음 시각은 지금 + %ims다(attempts + 1로 늘려 쉬기, 상한 60초) (P-T39 ①, ADR0106)', async (attempts, unit, delay) => {
    fx.issueQueue = [throws(new TicketIssueCallError('UNAVAILABLE'))];
    expect(await runner({ random: () => unit }).runJob(issueJob({ attempts }))).toEqual({ kind: 'RETRY', code: 'UNAVAILABLE', nextAtMs: NOW + delay });
  });

  test('random을 주지 않으면 Math.random으로 흔든다(첫 실패는 0.8 ~ 1.2초 뒤)', async () => {
    fx.issueQueue = [throws(new TicketIssueCallError('DEADLINE_EXCEEDED'))];
    const out = await runner({ random: undefined }).runJob(issueJob());
    expect(out.kind).toBe('RETRY');
    const at = (out as { nextAtMs: number }).nextAtMs;
    expect(at).toBeGreaterThanOrEqual(NOW + 800);
    expect(at).toBeLessThanOrEqual(NOW + 1200);
  });

  test('다음 시각은 답을 받은 뒤의 지금으로 잰다(호출이 2초 걸렸으면 그만큼 뒤)', async () => {
    const r = runner();
    fx.holdIssue = true;
    fx.issueQueue = [throws(new TicketIssueCallError('UNAVAILABLE'))];
    const p = later(r.runJob(issueJob()));
    await flush();
    clock.advance(2000);
    fx.releaseHeld();
    expect(await p).toEqual({ kind: 'RETRY', code: 'UNAVAILABLE', nextAtMs: NOW + 2000 + 1000 });
  });

  test.each<[string, unknown]>([
    ['TypeError', new TypeError('Cannot read properties of undefined')],
    ['Error가 아닌 값', 'boom'],
  ])('예상 밖 예외(%s, TicketIssueCallError가 아님)는 UNKNOWN으로 보아 다시 보낸다(실행기는 멈추지 않는다) (ADR0106) [ASVS v5.0.0-16.5.2]', async (_name, err) => {
    fx.issueQueue = [throws(err)];
    expect(await runner().runJob(issueJob())).toMatchObject({ kind: 'RETRY', code: 'UNKNOWN' });
    expect(fx.retries.map((x) => x.code)).toEqual(['UNKNOWN']);
  });

  test('자동 재시도는 주문 이력(T19)을 쓰지 않는다: retry 입력은 주문 ID·다음 시각·코드·자기 임대 넷뿐이다 (ADR0106)', async () => {
    fx.issueQueue = [throws(new TicketIssueCallError('RESOURCE_EXHAUSTED'))];
    await runner().runJob(issueJob());
    expect(Object.keys(fx.retries[0]!).sort()).toEqual(['code', 'leaseUntilMs', 'nextAtMs', 'orderId']);
  });
});

describe('runJob: 다시 보내지 않을 실패(설계 6)', () => {
  test.each([...TICKET_ISSUE_STOP_CODES].filter((c) => c !== 'BAD_ANSWER'))(
    '%s면 stop(코드, 자기 임대)이고 STOPPED·SEV2 로그 한 줄(주문 ID·코드만)·지표 stopped다. 결제를 취소하지 않는다 (P-T39 ④, ADR0106) [ASVS v5.0.0-16.3.4]',
    async (code) => {
      fx.issueQueue = [throws(new TicketIssueCallError(code))];
      expect(await runner().runJob(issueJob())).toEqual({ kind: 'STOPPED', code });
      expect(fx.stops).toEqual([{ orderId: ORDER_ID, code, leaseUntilMs: LEASE }]);
      expect(fx.stoppedLogs).toEqual([{ orderId: ORDER_ID, code }]);
      expect(Object.keys(fx.stoppedLogs[0]!).sort()).toEqual(['code', 'orderId']);
      expect(fx.attempts).toEqual(['stopped']);
      notCalled('jobs.complete', 'jobs.retry', 'onOrderChanged');
    },
  );

  test.each<[string, readonly IssuedTicketRef[]]>([
    ['좌석 하나가 빠진 답', [{ seatId: SEAT_1, ticketId: TICKET_OF[SEAT_1]! }]],
    ['빈 티켓 ID', [{ seatId: SEAT_1, ticketId: TICKET_OF[SEAT_1]! }, { seatId: SEAT_2, ticketId: '' }]],
    ['같은 티켓 ID 둘', [{ seatId: SEAT_1, ticketId: TICKET_OF[SEAT_1]! }, { seatId: SEAT_2, ticketId: TICKET_OF[SEAT_1]! }]],
    ['주문에 없는 좌석', [{ seatId: SEAT_1, ticketId: TICKET_OF[SEAT_1]! }, { seatId: '0190f3a1-7c2e-7a00-8000-00000000a009', ticketId: TICKET_OF[SEAT_2]! }]],
  ])('%s은 좌석과 맞지 않아 BAD_ANSWER로 멈추고 주문에 적지 않는다(complete 없음, 이중 발권 0건) (P-T15)', async (_name, answer) => {
    fx.issueQueue = [answer];
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'STOPPED', code: 'BAD_ANSWER' });
    expect(fx.stops.map((s) => s.code)).toEqual(['BAD_ANSWER']);
    expect(fx.stoppedLogs).toEqual([{ orderId: ORDER_ID, code: 'BAD_ANSWER' }]);
    notCalled('jobs.complete');
  });

  test('retry·stop이 false(행이 없거나 자기 임대가 아님)면 SKIPPED LEASE_LOST이고 지표를 세지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    fx.retryAnswer = false;
    fx.issueQueue = [throws(new TicketIssueCallError('UNAVAILABLE'))];
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    fx.stopAnswer = false;
    fx.issueQueue = [throws(new TicketIssueCallError('FAILED_PRECONDITION'))];
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    expect(fx.attempts).toEqual([]);
  });
});

describe('runJob: 쓰기가 던지면 ERROR·임대 그대로(설계 [정함])', () => {
  test.each<[string, () => void, 'complete' | 'retry' | 'stop']>([
    ['complete', () => (fx.completeQueue = [new Error('db down')]), 'complete'],
    ['retry', () => ((fx.retryAnswer = new Error('db down')), (fx.issueQueue = [throws(new TicketIssueCallError('UNAVAILABLE'))])), 'retry'],
    ['stop', () => ((fx.stopAnswer = new Error('db down')), (fx.issueQueue = [throws(new TicketIssueCallError('NOT_FOUND'))])), 'stop'],
  ])(
    '%s가 던지면 runJob은 던지지 않고 ERROR(stage)·log.runError 한 줄(단계·주문 ID·오류)이며 임대를 놓지 않는다(임대가 끝나면 다시 잡혀 같은 주문 ID로 부른다)·지표 없음 (ADR0106) [ASVS v5.0.0-16.5.2]',
    async (_name, arrange, stage) => {
      arrange();
      const out = await runner().runJob(issueJob());
      expect(out).toEqual({ kind: 'ERROR', stage });
      expect(fx.runErrors).toHaveLength(1);
      expect(fx.runErrors[0]).toMatchObject({ what: stage, orderId: ORDER_ID });
      expect(fx.runErrors[0]!.err).toBeInstanceOf(Error);
      notCalled('jobs.release', 'signals.attempt', 'onOrderChanged');
    },
  );
});

describe('로그에 싣는 것', () => {
  test('멈춤·늦은 답·쓰기 오류 로그에 좌석·결제자 계정·티켓 ID가 없다(주문 ID·코드·상태만) [ASVS v5.0.0-16.3.4]', async () => {
    fx.issueQueue = [throws(new TicketIssueCallError('FAILED_PRECONDITION'))];
    await runner().runJob(issueJob());
    fx.completeQueue = [{ status: 'STALE', current: 'CONFIRMED' }];
    await runner().runJob(issueJob({ orderId: ORDER_B }));
    fx.completeQueue = [new Error('db down')];
    await runner().runJob(issueJob({ orderId: ORDER_C }));
    expect(fx.stoppedLogs).toHaveLength(1);
    expect(fx.staleLogs).toHaveLength(1);
    expect(fx.runErrors).toHaveLength(1);
    const logged = JSON.stringify([fx.stoppedLogs, fx.staleLogs, fx.runErrors.map((e) => ({ ...e, err: String(e.err) }))]);
    for (const secret of [SEAT_1, SEAT_2, ACCOUNT, TICKET_OF[SEAT_1]!, TICKET_OF[SEAT_2]!]) expect(logged, secret).not.toContain(secret);
  });
});

describe('runOne·kick(승인 반영 커밋 직후 그 주문을 곧바로 깨운다, 설계 2)', () => {
  test('runOne은 claim(주문, 임대 30초)으로 잡아 돈다. leaseMs를 주면 그 임대다 (ADR0106)', async () => {
    fx.put();
    expect(await runner().runOne(ORDER_ID)).toEqual({ kind: 'ISSUED' });
    expect(fx.claimArgs).toEqual([[ORDER_ID, 30_000]]);
    expect(fx.completes.map((c) => c.leaseUntilMs)).toEqual([NOW + 30_000]);
    fx.put(issueJob({ orderId: ORDER_B }));
    await runner({ leaseMs: 12_000 }).runOne(ORDER_B);
    expect(fx.claimArgs[1]).toEqual([ORDER_B, 12_000]);
  });

  test('runOne: 큐 행이 없으면 SKIPPED NO_JOB, 다른 실행이 임대 중이거나 기한 전·멈춘 행이면 SKIPPED LEASED이고 발권을 부르지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    expect(await runner().runOne(ORDER_ID)).toEqual({ kind: 'SKIPPED', reason: 'NO_JOB' });
    fx.put();
    fx.leased.add(ORDER_ID);
    expect(await runner().runOne(ORDER_ID)).toEqual({ kind: 'SKIPPED', reason: 'LEASED' });
    notCalled('issuer.issue', 'jobs.complete', 'signals.attempt');
  });

  test('kick은 기다리지 않고 바로 돌아오며(던지지 않는다) 뒤에서 그 주문을 잡아 발권한다(1초 틱을 기다리지 않는다) (ADR0106)', async () => {
    fx.put();
    const r = runner();
    expect(r.kick(ORDER_ID)).toBeUndefined();
    await flush();
    expect(fx.claimArgs).toEqual([[ORDER_ID, 30_000]]);
    expect(fx.completes.map((c) => c.orderId)).toEqual([ORDER_ID]);
    expect(fx.changed).toEqual([ORDER_ID]);
    notCalled('jobs.claimDue');
  });

  test('kick은 claim이 던져도 던지지 않고 처리되지 않은 거절을 남기지 않으며 log.runError(claim, 주문 ID) 한 줄이다', async () => {
    fx.claimError = new Error('db down');
    const r = runner();
    expect(() => r.kick(ORDER_ID)).not.toThrow();
    await flush();
    expect(fx.claimArgs).toHaveLength(1);
    expect(fx.runErrors).toHaveLength(1);
    expect(fx.runErrors[0]).toMatchObject({ what: 'claim', orderId: ORDER_ID });
  });

  test('남은 시간이 0인 요청 맥락 안에서 kick을 불러도 요청 맥락을 물려받지 않고 발권 호출이 나간다(실행기를 만든 때의 맥락)', async () => {
    fx.put();
    const r = runner();
    const dl = fakeClock({ now: NOW });
    const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(1, dl), route: '/v1/payments/events', method: 'POST', log: {} as RequestContext['log'] };
    dl.advance(10);
    runInRequestContext(ctx, () => {
      expect(requestContext()?.deadline.remainingMs()).toBe(0);
      r.kick(ORDER_ID);
    });
    await flush();
    expect(fx.contexts).toEqual([undefined]);
    expect(fx.completes.map((c) => c.orderId)).toEqual([ORDER_ID]);
  });
});

describe('tick: 신호·게이지·잡기(설계 1·7·8·9)', () => {
  test('틱 하나가 markDelayed(100)·markOverdue(100)·gauges·claimDue(min(50, 빈자리 8) = 8, 30초)를 부르고, 잡은 행을 모두 돌린 뒤 수를 돌려준다(리뷰 고침 H1) (ADR0106)', async () => {
    fx.due = [issueJob(), issueJob({ orderId: ORDER_B })];
    expect(await runner().tick()).toEqual({ claimed: 2, delayed: 0, overdue: 0, measured: true });
    expect(fx.delayedArgs).toEqual([100]);
    expect(fx.overdueArgs).toEqual([100]);
    expect(fx.claimDueArgs).toEqual([[8, 30_000]]);
    expect(fx.completes.map((c) => c.orderId).sort()).toEqual([ORDER_ID, ORDER_B].sort());
  });

  test('signalBatch·claimLimit·leaseMs 설정을 넘기고, 잡은 것이 없으면 claimed 0이다', async () => {
    expect(await runner({ signalBatch: 7, claimLimit: 5, leaseMs: 9000 }).tick()).toMatchObject({ claimed: 0 });
    expect(fx.delayedArgs).toEqual([7]);
    expect(fx.overdueArgs).toEqual([7]);
    expect(fx.claimDueArgs).toEqual([[5, 9000]]);
    notCalled('issuer.issue');
  });

  test('ISSUE_DELAYED를 낸 주문 수만큼 지표 delayed를 올린다(SEV2. 사건과 delayed_at은 markDelayed 한 트랜잭션이 쓴다) (P-T39 ①, ADR0106)', async () => {
    fx.delayedAnswer = [ORDER_ID, ORDER_B];
    expect(await runner().tick()).toMatchObject({ delayed: 2 });
    expect(sum(fx.delayedCounts)).toBe(2);
    notCalled('log.overdue');
  });

  test('발권 기한을 넘긴 주문마다 SEV1 로그 한 줄(log.overdue, 주문 ID만)과 지표 overdue이고, 재시도는 건드리지 않고 이어 간다 (P-T39 ②, ADR0106) [ASVS v5.0.0-16.3.4]', async () => {
    fx.overdueAnswer = [ORDER_ID, ORDER_B];
    expect(await runner().tick()).toMatchObject({ overdue: 2 });
    expect(fx.overdueLogs).toEqual([{ orderId: ORDER_ID }, { orderId: ORDER_B }]);
    expect(sum(fx.overdueCounts)).toBe(2);
    notCalled('jobs.retry', 'jobs.stop');
  });

  test('게이지는 시작 뒤 첫 틱에 한 번, 그 뒤 10초마다 한 질의로 재어 signals.jobs로 둔다(그 사이 틱은 재지 않는다)', async () => {
    const r = runner();
    expect(await r.tick()).toMatchObject({ measured: true });
    expect(fx.gaugeSignals).toEqual([{ pending: 3, stopped: 1, oldestAgeSeconds: 42 }]);
    clock.advance(9_999);
    expect(await r.tick()).toMatchObject({ measured: false });
    clock.advance(1);
    fx.gaugeAnswer = { pending: 0, stopped: 2, oldestAgeSeconds: 0 };
    expect(await r.tick()).toMatchObject({ measured: true });
    expect(fx.gaugeSignals).toEqual([
      { pending: 3, stopped: 1, oldestAgeSeconds: 42 },
      { pending: 0, stopped: 2, oldestAgeSeconds: 0 },
    ]);
    expect(fx.calls.filter((c) => c === 'jobs.gauges')).toHaveLength(2);
  });

  test('gaugeIntervalMs를 주면 그 간격으로 잰다', async () => {
    const r = runner({ gaugeIntervalMs: 3000 });
    await r.tick();
    clock.advance(3000);
    expect(await r.tick()).toMatchObject({ measured: true });
  });

  test.each<[string, () => void, 'delayed' | 'overdue' | 'gauges' | 'claim']>([
    ['markDelayed', () => (fx.delayedAnswer = new Error('db down')), 'delayed'],
    ['markOverdue', () => (fx.overdueAnswer = new Error('db down')), 'overdue'],
    ['gauges', () => (fx.gaugeAnswer = new Error('db down')), 'gauges'],
    ['claimDue', () => (fx.due = new Error('db down')), 'claim'],
  ])('%s가 던져도 틱은 던지지 않고 log.runError(%s) 뒤 그 단계를 0으로 세며 다른 단계는 그대로 돈다', async (_name, arrange, what) => {
    fx.delayedAnswer = [ORDER_C];
    fx.overdueAnswer = [ORDER_C];
    fx.due = [issueJob()];
    arrange();
    const out = await runner().tick();
    expect(fx.runErrors.map((e) => e.what)).toEqual([what]);
    expect(out).toEqual({
      claimed: what === 'claim' ? 0 : 1,
      delayed: what === 'delayed' ? 0 : 1,
      overdue: what === 'overdue' ? 0 : 1,
      measured: what !== 'gauges',
    });
    expect(fx.completes).toHaveLength(what === 'claim' ? 0 : 1);
  });

  test('게이지를 재지 못했으면 다음 틱(10초 전이라도)에 다시 잰다', async () => {
    fx.gaugeAnswer = new Error('db down');
    const r = runner();
    expect(await r.tick()).toMatchObject({ measured: false });
    fx.gaugeAnswer = { pending: 1, stopped: 0, oldestAgeSeconds: 1 };
    clock.advance(1000);
    expect(await r.tick()).toMatchObject({ measured: true });
    expect(fx.gaugeSignals).toEqual([{ pending: 1, stopped: 0, oldestAgeSeconds: 1 }]);
  });

  test('한 행의 실패(예상 밖 예외·쓰기 오류)가 다른 행을 막지 않는다', async () => {
    fx.due = [issueJob(), issueJob({ orderId: ORDER_B }), issueJob({ orderId: ORDER_C })];
    const issue = fx.issuer.issue;
    const issuer: TicketIssuer = {
      issue: async (c) => {
        if (c.orderId === ORDER_B) throw new TypeError('x');
        return issue(c);
      },
    };
    const complete = fx.jobs.complete;
    const jobs: TicketIssueJobs = {
      ...fx.jobs,
      complete: async (input) => {
        if (input.orderId === ORDER_C) throw new Error('db down');
        return complete(input);
      },
    };
    expect(await runner({ issuer, jobs }).tick()).toMatchObject({ claimed: 3 });
    expect(fx.attempts.sort()).toEqual(['issued', 'retry']);
    expect(fx.retries.map((x) => [x.orderId, x.code])).toEqual([[ORDER_B, 'UNKNOWN']]);
    // 예상 밖 예외는 issue 한 줄(리뷰 고침 L5), 쓰기 오류는 complete 한 줄
    expect(fx.runErrors.map((e) => [e.what, e.orderId]).sort()).toEqual([
      ['complete', ORDER_C],
      ['issue', ORDER_B],
    ]);
  });

  test(`부르기 전에 남은 임대가 ${TICKET_ISSUE_LEASE_MIN_REMAINING_MS / 1000}초 미만이면 부르지 않고 임대를 놓는다(다음 틱에 다시 잡힌다). 정확히 5초면 부른다 [ASVS v5.0.0-2.3.4]`, async () => {
    fx.due = [issueJob({ leaseUntilMs: NOW + TICKET_ISSUE_LEASE_MIN_REMAINING_MS - 1 }), issueJob({ orderId: ORDER_B, leaseUntilMs: NOW + TICKET_ISSUE_LEASE_MIN_REMAINING_MS })];
    expect(await runner().tick()).toMatchObject({ claimed: 2 });
    expect(fx.releases).toEqual([[ORDER_ID, NOW + TICKET_ISSUE_LEASE_MIN_REMAINING_MS - 1]]);
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_B]);
    expect(TICKET_ISSUE_LEASE_MIN_REMAINING_MS).toBe(5000);
  });

  test('파드마다 동시 발권 호출은 8개까지다: 20건을 잡으면 8개만 먼저 부르고 끝나는 대로 이어 부른다 (ADR0106)', async () => {
    fx.due = Array.from({ length: 20 }, (_, i) => issueJob({ orderId: orderN(i) }));
    fx.holdIssue = true;
    const p = later(runner().tick());
    await flush();
    expect(fx.issueCommands).toHaveLength(8);
    fx.held.shift()!.resolve();
    await flush();
    expect(fx.issueCommands).toHaveLength(9);
    while (fx.held.length > 0) {
      fx.releaseHeld();
      await flush();
    }
    expect(await p).toMatchObject({ claimed: 20 });
    expect(fx.maxInFlight).toBe(8);
    expect(new Set(fx.completes.map((c) => c.orderId)).size).toBe(20);
  });

  test('concurrency를 주면 그 수가 상한이다', async () => {
    fx.due = Array.from({ length: 6 }, (_, i) => issueJob({ orderId: orderN(i) }));
    fx.holdIssue = true;
    const p = later(runner({ concurrency: 3 }).tick());
    await flush();
    expect(fx.issueCommands).toHaveLength(3);
    while (fx.held.length > 0) {
      fx.releaseHeld();
      await flush();
    }
    await p;
    expect(fx.maxInFlight).toBe(3);
  });

  test('빈자리를 기다리는 동안 남은 임대가 5초 미만이 되면 그 행은 부르지 않고 놓는다(남은 임대는 부르기 바로 전에 본다)', async () => {
    fx.due = [issueJob(), issueJob({ orderId: ORDER_B })];
    fx.holdIssue = true;
    const p = later(runner({ concurrency: 1 }).tick());
    await flush();
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID]);
    clock.advance(30_000 - TICKET_ISSUE_LEASE_MIN_REMAINING_MS + 1);
    fx.releaseHeld();
    await flush();
    await p;
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID]);
    expect(fx.releases).toEqual([[ORDER_B, LEASE]]);
  });

  test('리뷰 고침 H1_틱과 kick이 빈자리를 함께 센다: 상한 1에서 틱이 부르는 중이면 kick은 그 주문을 잡지 않고(claim 없음) 다음 틱이 잡는다 (ADR0106)', async () => {
    fx.due = [issueJob()];
    fx.put(issueJob({ orderId: ORDER_B }));
    fx.holdIssue = true;
    const r = runner({ concurrency: 1 });
    const p = later(r.tick());
    await flush();
    r.kick(ORDER_B);
    await flush();
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID]);
    expect(fx.claimArgs).toEqual([]);
    fx.releaseHeld();
    await p;
    fx.holdIssue = false;
    fx.due = [issueJob({ orderId: ORDER_B })];
    expect(await r.tick()).toMatchObject({ claimed: 1 });
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID, ORDER_B]);
    expect(fx.maxInFlight).toBe(1);
    expect(fx.completes.map((c) => c.orderId).sort()).toEqual([ORDER_ID, ORDER_B].sort());
  });
});

describe('start·stop', () => {
  test('start는 1초 반복 하나를 켜고(두 번 불러도 하나), 틱은 잡기(claimDue)다. pollIntervalMs를 주면 그 간격이다 (ADR0106)', async () => {
    const r = runner();
    r.start();
    r.start();
    expect(timer.set.map((s) => s.ms)).toEqual([1000]);
    timer.tick();
    await flush();
    expect(fx.claimDueArgs).toHaveLength(1);
    await r.stop();

    const t2 = new FakeTimer();
    const r2 = runner({ timer: t2, pollIntervalMs: 250 });
    r2.start();
    expect(t2.set.map((s) => s.ms)).toEqual([250]);
    await r2.stop();
  });

  test('틱이 겹치지 않는다: 앞 틱이 끝나지 않았으면 이번 틱은 건너뛴다', async () => {
    const gate = deferred();
    fx.dueGate = gate.promise;
    const r = runner();
    r.start();
    timer.tick();
    await flush();
    timer.tick();
    await flush();
    expect(fx.claimDueArgs).toHaveLength(1);
    gate.resolve();
    await flush();
    fx.dueGate = undefined;
    timer.tick();
    await flush();
    expect(fx.claimDueArgs).toHaveLength(2);
    await r.stop();
  });

  test('예상 밖 오류에 반복이 죽지 않는다: 한 틱의 모든 단계가 던져도 처리되지 않은 거절이 없고 다음 틱이 잡은 행을 발권한다 [ASVS v5.0.0-16.5.2]', async () => {
    fx.due = new Error('db down');
    fx.delayedAnswer = new Error('db down');
    fx.overdueAnswer = new Error('db down');
    fx.gaugeAnswer = new Error('db down');
    const r = runner();
    r.start();
    timer.tick();
    await flush();
    expect(fx.runErrors.map((e) => e.what).sort()).toEqual(['claim', 'delayed', 'gauges', 'overdue']);
    fx.due = [issueJob()];
    fx.delayedAnswer = [];
    fx.overdueAnswer = [];
    fx.gaugeAnswer = { pending: 1, stopped: 0, oldestAgeSeconds: 0 };
    timer.tick();
    await flush();
    expect(fx.completes.map((c) => c.orderId)).toEqual([ORDER_ID]);
    await r.stop();
  });

  test('stop은 반복을 끄고(같은 handle로 clearInterval) 돌던 틱의 발권 호출과 그 뒤 쓰기까지 기다린다. 멈춘 뒤의 kick·start·tick은 아무것도 하지 않는다 (ADR0106)', async () => {
    fx.due = [issueJob()];
    fx.holdIssue = true;
    const r = runner();
    r.start();
    timer.tick();
    await flush();
    expect(fx.issueCommands).toHaveLength(1);
    let stopped = false;
    const stopping = later(
      r.stop().then(() => {
        stopped = true;
      }),
    );
    await flush();
    expect(stopped).toBe(false);
    expect(timer.cleared).toEqual([timer.set[0]!.handle]);
    fx.releaseHeld();
    await stopping;
    expect(stopped).toBe(true);
    expect(fx.completes.map((c) => c.orderId)).toEqual([ORDER_ID]);

    const before = fx.calls.length;
    fx.put(issueJob({ orderId: ORDER_B }));
    r.kick(ORDER_B);
    r.start();
    expect(await r.tick()).toEqual({ claimed: 0, delayed: 0, overdue: 0, measured: false });
    await flush();
    expect(fx.calls.slice(before)).toEqual([]);
    expect(timer.set).toHaveLength(1);
  });

  test('stop은 돌던 kick(발권 호출과 성공 반영)도 기다린다', async () => {
    fx.put();
    fx.holdIssue = true;
    const r = runner();
    r.kick(ORDER_ID);
    await flush();
    expect(fx.issueCommands).toHaveLength(1);
    let stopped = false;
    const stopping = later(
      r.stop().then(() => {
        stopped = true;
      }),
    );
    await flush();
    expect(stopped).toBe(false);
    fx.releaseHeld();
    await stopping;
    expect(fx.completes.map((c) => c.orderId)).toEqual([ORDER_ID]);
    expect(fx.changed).toEqual([ORDER_ID]);
  });

  test('stop 때 잡았지만 아직 부르지 않은 행은 부르지 않고 임대를 놓는다(돌던 호출은 끝까지 기다린다) [ASVS v5.0.0-2.3.4]', async () => {
    fx.due = [issueJob(), issueJob({ orderId: ORDER_B }), issueJob({ orderId: ORDER_C })];
    fx.holdIssue = true;
    const r = runner({ concurrency: 1 });
    r.start();
    timer.tick();
    await flush();
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID]);
    const stopping = later(r.stop());
    fx.releaseHeld();
    await stopping;
    expect(fx.completes.map((c) => c.orderId)).toEqual([ORDER_ID]);
    expect([...fx.releases].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      [ORDER_B, LEASE],
      [ORDER_C, LEASE],
    ]);
    expect(fx.issueCommands).toHaveLength(1);
  });
});

describe('리뷰 고침(2026-11-05 코드 리뷰)', () => {
  /** 늘 차단기 열림(CIRCUIT_OPEN)인 ticket-svc: 부르자마자 다시 보낼 실패로 끝난다 */
  const circuitOpen: TicketIssuer = {
    issue: async () => {
      throw new TicketIssueCallError('CIRCUIT_OPEN');
    },
  };

  /** limit을 지키는 잡기(pool 앞에서 limit개를 꺼낸다)와, 쓰기(complete·retry·stop·release)마다 gate를 기다리며 동시 수를 세는 저장소 */
  function countingJobs(pool: TicketIssueJob[], gate: Promise<void>) {
    const writes = { now: 0, max: 0 };
    const counted =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        writes.now += 1;
        writes.max = Math.max(writes.max, writes.now);
        try {
          await gate;
          return await f(...a);
        } finally {
          writes.now -= 1;
        }
      };
    const jobs: TicketIssueJobs = {
      ...fx.jobs,
      claimDue: async (limit, leaseMs) => {
        fx.claimDueArgs.push([limit, leaseMs]);
        return pool.splice(0, limit);
      },
      complete: counted(fx.jobs.complete),
      retry: counted(fx.jobs.retry),
      stop: counted(fx.jobs.stop),
      release: counted(fx.jobs.release),
    };
    return { jobs, writes };
  }

  test('리뷰 고침 H1_늘 CIRCUIT_OPEN인 ticket-svc에서 큐 행 50건이 기한이 돼도 한 틱이 잡는 수는 빈자리(8) 이하이고 동시 쓰기(retry)도 8 이하다(자리는 호출과 그 뒤 쓰기가 끝날 때까지 쥔다) (P-T39 ①, ADR0106) [ASVS v5.0.0-16.5.2]', async () => {
    const pool = Array.from({ length: 50 }, (_, i) => issueJob({ orderId: orderN(i) }));
    const gate = deferred();
    const { jobs, writes } = countingJobs(pool, gate.promise);
    const p = later(runner({ jobs, issuer: circuitOpen }).tick());
    await flush();
    expect(writes.max, '쓰기를 막아 둔 동안의 동시 쓰기').toBeLessThanOrEqual(8);
    gate.resolve();
    const out = await p;
    expect(out.claimed).toBeLessThanOrEqual(8);
    expect(fx.claimDueArgs).toEqual([[8, 30_000]]);
    expect(writes.max).toBeLessThanOrEqual(8);
    expect(fx.retries).toHaveLength(out.claimed);
    expect(new Set(fx.retries.map((x) => x.code))).toEqual(new Set(['CIRCUIT_OPEN']));
    // 잡지 않은 행은 큐에 남아 다음 틱을 기다린다
    expect(pool).toHaveLength(50 - out.claimed);
  });

  test('리뷰 고침 H1_빈자리가 없으면 틱은 큐 행을 잡지 않는다(claimDue를 부르지 않는다). 빈자리가 3이면 claimDue(3)이고, 상한이 50보다 크면 50이다 (ADR0106)', async () => {
    fx.holdIssue = true;
    const r = runner({ concurrency: 1 });
    const busy = later(r.runJob(issueJob()));
    await flush();
    expect(await r.tick()).toMatchObject({ claimed: 0 });
    notCalled('jobs.claimDue');
    fx.releaseHeld();
    await busy;

    const r4 = runner({ concurrency: 4 });
    const busy4 = later(r4.runJob(issueJob({ orderId: ORDER_B })));
    await flush();
    await r4.tick();
    expect(fx.claimDueArgs).toEqual([[3, 30_000]]);
    fx.releaseHeld();
    await busy4;

    fx.holdIssue = false;
    await runner({ concurrency: 100 }).tick();
    expect(fx.claimDueArgs.at(-1)).toEqual([50, 30_000]);
  });

  test('리뷰 고침 H1_자리는 발권 호출과 그 뒤 쓰기가 끝날 때까지 쥔다: 상한 1에서 첫 행의 성공 반영(complete)이 끝나기 전에는 둘째 행의 발권을 부르지 않는다 (ADR0106)', async () => {
    const gate = deferred();
    const complete = fx.jobs.complete;
    const jobs: TicketIssueJobs = {
      ...fx.jobs,
      complete: async (input) => {
        await gate.promise;
        return complete(input);
      },
    };
    const r = runner({ jobs, concurrency: 1 });
    const a = later(r.runJob(issueJob()));
    const b = later(r.runJob(issueJob({ orderId: ORDER_B })));
    await flush();
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID]);
    gate.resolve();
    expect(await a).toEqual({ kind: 'ISSUED' });
    expect(await b).toEqual({ kind: 'ISSUED' });
    expect(fx.issueCommands.map((c) => c.orderId)).toEqual([ORDER_ID, ORDER_B]);
  });

  test('리뷰 고침 H1_runOne·kick은 빈자리가 없으면 큐 행을 잡지 않고(claim 없음) SKIPPED NO_SLOT으로 틱에 맡긴다. 자리가 나면 잡는다 (ADR0106)', async () => {
    fx.put(issueJob({ orderId: ORDER_B }));
    fx.holdIssue = true;
    const r = runner({ concurrency: 1 });
    const busy = later(r.runJob(issueJob()));
    await flush();
    const one = later(r.runOne(ORDER_B));
    r.kick(ORDER_B);
    await flush();
    expect(fx.claimArgs).toEqual([]);
    expect(await one).toEqual({ kind: 'SKIPPED', reason: 'NO_SLOT' });
    notCalled('jobs.claim', 'jobs.get');
    fx.releaseHeld();
    await busy;
    fx.holdIssue = false;
    expect(await r.runOne(ORDER_B)).toEqual({ kind: 'ISSUED' });
    expect(fx.maxInFlight).toBe(1);
  });

  test.each<[string, unknown]>([
    ['TypeError', new TypeError('Cannot read properties of undefined')],
    ['Error가 아닌 값', 'boom'],
  ])('리뷰 고침 L5_발권 호출이 TicketIssueCallError가 아닌 것(%s)을 던지면 log.runError(issue, 주문 ID, 그 오류) 한 줄을 남기고 UNKNOWN으로 다시 보낸다. TicketIssueCallError는 runError를 남기지 않는다 (ADR0106) [ASVS v5.0.0-16.3.4]', async (_name, err) => {
    fx.issueQueue = [throws(err)];
    expect(await runner().runJob(issueJob())).toMatchObject({ kind: 'RETRY', code: 'UNKNOWN' });
    expect(fx.runErrors).toEqual([{ what: 'issue', orderId: ORDER_ID, err }]);
    fx.issueQueue = [throws(new TicketIssueCallError('UNAVAILABLE'))];
    expect(await runner().runJob(issueJob({ orderId: ORDER_B }))).toMatchObject({ kind: 'RETRY', code: 'UNAVAILABLE' });
    expect(fx.runErrors).toHaveLength(1);
  });

  test.each<[string, () => Error]>([
    ['RangeError(좌석 불일치)', () => new RangeError('티켓 묶음이 주문 좌석과 맞지 않는다(빠짐·남는 좌석)')],
    ['SQLSTATE 23505(유일 제약 위반, 원인에 코드)', () => new Error('Failed query: update order_item', { cause: Object.assign(new Error('duplicate key value'), { code: '23505' }) })],
    ['SQLSTATE 23503(외래 키 위반, 오류에 코드)', () => Object.assign(new Error('violates foreign key constraint'), { code: '23503' })],
  ])('리뷰 고침 L6_complete가 %s를 던지면(다시 해도 같은 쓰기 오류) 첫 시도에 stop(BAD_ANSWER)으로 멈추고 SEV2 로그 한 줄이다(임대가 끝날 때마다 같은 호출을 되풀이하지 않는다) (P-T39 ④, ADR0106) [ASVS v5.0.0-16.5.2]', async (_name, make) => {
    const err = make();
    const jobs: TicketIssueJobs = {
      ...fx.jobs,
      complete: async (input) => {
        fx.completes.push(input);
        throw err;
      },
    };
    expect(await runner({ jobs }).runJob(issueJob())).toEqual({ kind: 'STOPPED', code: 'BAD_ANSWER' });
    expect(fx.completes).toHaveLength(1);
    expect(fx.stops).toEqual([{ orderId: ORDER_ID, code: 'BAD_ANSWER', leaseUntilMs: LEASE }]);
    expect(fx.stoppedLogs).toEqual([{ orderId: ORDER_ID, code: 'BAD_ANSWER' }]);
    expect(fx.runErrors).toEqual([{ what: 'complete', orderId: ORDER_ID, err }]);
    expect(fx.attempts).toEqual(['stopped']);
    notCalled('jobs.retry', 'jobs.release', 'onOrderChanged');
  });

  test.each<[string, () => Error]>([
    ['연결 끊김', () => new Error('Connection terminated unexpectedly')],
    ['문장 시간 초과(SQLSTATE 57014)', () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['연결 오류(SQLSTATE 08006)', () => new Error('Failed query: select', { cause: Object.assign(new Error('connection failure'), { code: '08006' }) })],
  ])('리뷰 고침 L6_complete의 일시 오류(%s)는 지금처럼 ERROR이고 임대를 그대로 둔다(멈추지 않는다) (ADR0106) [ASVS v5.0.0-16.5.2]', async (_name, make) => {
    fx.completeQueue = [make()];
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'ERROR', stage: 'complete' });
    notCalled('jobs.stop', 'jobs.release', 'log.stopped', 'signals.attempt');
  });

  test.each(['VOIDED', 'REFUNDED', 'UNSPECIFIED'] as const)('리뷰 고침 L8_답의 티켓 상태가 %s(ISSUED·ACTIVE가 아님)면 BAD_ANSWER로 멈추고 주문에 적지 않는다 (P-T15)', async (status) => {
    fx.issueQueue = [
      [
        { seatId: SEAT_1, ticketId: TICKET_OF[SEAT_1]!, status: 'ISSUED' },
        { seatId: SEAT_2, ticketId: TICKET_OF[SEAT_2]!, status },
      ],
    ];
    expect(await runner().runJob(issueJob())).toEqual({ kind: 'STOPPED', code: 'BAD_ANSWER' });
    notCalled('jobs.complete');
  });
});
