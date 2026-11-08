// 승인 실행기(application/payment-confirm-runner.ts PaymentConfirmRunner, docs/features/payment.md §2 '승인 실행기의 첫 구현', docs/data.md §5 '승인 실행기',
// 명세 specs/payment.qnt `send`·`expireCommand`·`respond`·`timeout`·`restart`, BUILD_ORDER PRF-181)를 메모리 대역 포트로 본다.
// - runJob: 행 하나의 차례 전부(원장 아님 → 지우기, 임대 잔해, 어댑터 없음, 승인 기한, 표시 → 호출, 답 반영, 다시 보내기, 쓰기 실패)
// - tick: 빈자리만큼 잡기, 호출을 기다리지 않음, 동시 상한 32
// - start·stop·whenIdle: 100ms 반복, 틱 겹침 없음, stop이 돌던 호출과 그 뒤 쓰기를 기다림, 멈춘 뒤 임대 놓기
// 실제 PostgreSQL·시뮬레이터로 도는 것(한 트랜잭션, SKIP LOCKED, 임대 잔해)은 test-int가 본다.
import { Deadline, fakeClock, type FakeClock, type RequestContext, requestContext, runInRequestContext } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { type ConfirmRunnerTimer, PaymentConfirmRunner, type PaymentConfirmRunnerDeps } from '../src/modules/payment/application/payment-confirm-runner.js';
import type { PaymentLedgerStatus } from '../src/modules/payment/domain/confirm-command.js';
import { type ConfirmFinish, type ConfirmJob, type ConfirmTarget, confirmRetryDelayMs, type PaymentConfirmOutcome } from '../src/modules/payment/domain/confirm-runner.js';
import type { ConfirmResult, PaymentGatewayPort, PgCapabilities, PgName } from '../src/modules/payment/domain/payment-gateway.js';
import type { FinishConfirmResult, MarkConfirmSentResult, PaymentConfirmJobs, PaymentConfirmLog, PaymentConfirmSignals, PaymentGateways } from '../src/modules/payment/domain/ports.js';
import { EVENT_ID, NOW, ORDER_ID, PAYMENT_ID, SECRET_PAYMENT_KEY, uuidAt } from './confirm-cases.js';

const POD = 'payment-svc-pod-1';
const AMOUNT = 55_000;
const DEADLINE_MS = 600_000;
const AUTH = NOW - 60_000;
const DUE = AUTH + DEADLINE_MS;
const OTHER_PAYMENT = uuidAt(77);
const APPROVED_AT = '2026-11-09T03:00:05.000Z';
const APPROVED_AT_MS = Date.parse(APPROVED_AT);

const target = (over: Partial<ConfirmTarget> = {}): ConfirmTarget => ({
  paymentId: PAYMENT_ID,
  orderId: ORDER_ID,
  eventId: EVENT_ID,
  attemptNo: 1,
  pg: 'SIMULATOR',
  paymentRef: SECRET_PAYMENT_KEY,
  amount: AMOUNT,
  status: 'ACCEPTED',
  authenticatedAtMs: AUTH,
  confirmSent: false,
  ...over,
});

const job = (over: Partial<ConfirmJob> = {}): ConfirmJob => ({ paymentId: PAYMENT_ID, attempts: 0, owner: POD, leaseUntilMs: NOW + 75_000, hadPreviousOwner: false, ...over });
const jobN = (i: number): ConfirmJob => job({ paymentId: uuidAt(100 + i) });
const answer = (over: Partial<ConfirmResult> & Pick<ConfirmResult, 'outcome'>): ConfirmResult => ({ paymentRef: SECRET_PAYMENT_KEY, ...over });

/** 던질 값(Error가 아닌 것도 던지게 싼다) */
type Throw = { readonly throws: unknown };
const throws = (v: unknown): Throw => ({ throws: v });
const isThrow = (v: unknown): v is Throw => typeof v === 'object' && v !== null && 'throws' in v;
type Script<T> = T | Throw | Promise<T>;
async function play<T>(s: Script<T>): Promise<T> {
  const v = await s;
  if (isThrow(v)) throw v.throws;
  return v as T;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 마이크로태스크·즉시 실행 몇 바퀴를 돌린다(기다리지 않는 일이 끝나게) */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** 기다리지 않고 둔 약속. 그 전에 시험이 실패해도 처리되지 않은 거절로 남지 않게 빈 처리기를 단다 */
function later<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

/** SQL 값이 글에 실린 드라이버 오류 */
const dbError = (code = '40P01'): Error => Object.assign(new Error(`INSERT INTO payment_event VALUES ('${SECRET_PAYMENT_KEY}')`), { code });

class FakeTimer implements ConfirmRunnerTimer {
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
  fire(): void {
    const last = this.set.at(-1);
    if (!last) throw new Error('setInterval을 부르지 않았다');
    last.fn();
  }
}

class FakeJobs implements PaymentConfirmJobs {
  readonly claimArgs: [number, string, number][] = [];
  /** 차례대로 답한다. 없으면 claimFn, 그것도 없으면 빈 목록 */
  claims: Script<ConfirmJob[]>[] = [];
  claimFn: ((limit: number) => ConfirmJob[]) | undefined;
  readonly targets = new Map<string, Script<ConfirmTarget | undefined>>();
  readonly reads: string[] = [];
  markResults: Script<MarkConfirmSentResult>[] = [];
  readonly marked: ConfirmJob[] = [];
  finishResults: Script<FinishConfirmResult>[] = [];
  readonly finished: { target: ConfirmTarget; finish: ConfirmFinish }[] = [];
  rescheduleResults: Script<boolean>[] = [];
  readonly rescheduled: { job: ConfirmJob; nextAtMs: number; countRetry: boolean }[] = [];
  dropResults: Script<boolean>[] = [];
  readonly dropped: ConfirmJob[] = [];
  releaseResults: Script<boolean>[] = [];
  readonly released: ConfirmJob[] = [];

  constructor(private readonly order: string[]) {}

  put(t: ConfirmTarget): void {
    this.targets.set(t.paymentId, t);
  }

  async claimDue(limit: number, owner: string, leaseMs: number): Promise<ConfirmJob[]> {
    this.order.push('jobs.claimDue');
    this.claimArgs.push([limit, owner, leaseMs]);
    const next = this.claims.shift();
    if (next !== undefined) return play(next);
    return this.claimFn?.(limit) ?? [];
  }
  async read(paymentId: string): Promise<ConfirmTarget | undefined> {
    this.order.push('jobs.read');
    this.reads.push(paymentId);
    return play(this.targets.has(paymentId) ? this.targets.get(paymentId)! : target({ paymentId }));
  }
  async markSent(j: ConfirmJob): Promise<MarkConfirmSentResult> {
    this.order.push('jobs.markSent');
    this.marked.push(j);
    const next = this.markResults.shift();
    if (next !== undefined) return play(next);
    // 실제 저장소처럼 표시가 이미 있으면 ALREADY다
    const known = this.targets.get(j.paymentId);
    return typeof known === 'object' && known !== null && 'confirmSent' in known && known.confirmSent ? 'ALREADY' : 'MARKED';
  }
  async finish(t: ConfirmTarget, finish: ConfirmFinish): Promise<FinishConfirmResult> {
    this.order.push('jobs.finish');
    this.finished.push({ target: t, finish });
    return play(this.finishResults.shift() ?? 'APPLIED');
  }
  async reschedule(j: ConfirmJob, nextAtMs: number, o: { countRetry: boolean }): Promise<boolean> {
    this.order.push('jobs.reschedule');
    this.rescheduled.push({ job: j, nextAtMs, countRetry: o?.countRetry });
    return play(this.rescheduleResults.shift() ?? true);
  }
  async dropJob(j: ConfirmJob): Promise<boolean> {
    this.order.push('jobs.dropJob');
    this.dropped.push(j);
    return play(this.dropResults.shift() ?? true);
  }
  async release(j: ConfirmJob): Promise<boolean> {
    this.order.push('jobs.release');
    this.released.push(j);
    return play(this.releaseResults.shift() ?? true);
  }
}

class FakeGateway implements PaymentGatewayPort {
  readonly calls: { orderId: string; paymentRef: string; amount: number; idemKey: string }[] = [];
  readonly contexts: unknown[] = [];
  answers: Script<ConfirmResult>[] = [];
  /** 있으면 호출이 이 약속을 기다린다 */
  gate: Promise<void> | undefined;
  /** 호출마다 시계를 민 시간(결제사 호출 시간) */
  latencyMs = 0;
  deadlineMs = DEADLINE_MS;
  active = 0;
  peak = 0;
  /** 있으면 capabilities()가 던진다 */
  capabilitiesFailure: unknown;

  constructor(
    readonly pg: PgName,
    private readonly order: string[],
    private readonly clock: FakeClock,
  ) {}

  capabilities(): PgCapabilities {
    if (this.capabilitiesFailure !== undefined) throw this.capabilitiesFailure;
    return { serverConfirm: true, confirmDeadlineMs: this.deadlineMs, partialCancel: true, webhookSignature: false, idempotencyRetentionMs: 86_400_000, callsPerSecond: 300, redirectCheckout: false };
  }
  async confirm(c: { orderId: string; paymentRef: string; amount: number; idemKey: string }): Promise<ConfirmResult> {
    this.order.push('gateway.confirm');
    this.calls.push(c);
    this.contexts.push(requestContext());
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      this.clock.advance(this.latencyMs);
      if (this.gate) await this.gate;
      return await play(this.answers.shift() ?? answer({ outcome: 'APPROVED', amount: c.amount, approvedAt: APPROVED_AT }));
    } finally {
      this.active -= 1;
    }
  }
  checkout(): never {
    throw new Error('승인 실행기는 결제창 값을 만들지 않는다');
  }
  query(): never {
    throw new Error('조회는 PRF-182다');
  }
  cancel(): never {
    throw new Error('승인 실행기는 취소하지 않는다');
  }
  parseWebhook(): never {
    throw new Error('승인 실행기는 웹훅을 읽지 않는다');
  }
}

class FakeGateways implements PaymentGateways {
  readonly adapters = new Map<PgName, FakeGateway>();
  of(pg: PgName): PaymentGatewayPort | undefined {
    return this.adapters.get(pg);
  }
}

class FakeLog implements PaymentConfirmLog {
  readonly amountMismatches: unknown[] = [];
  readonly noAdapters: unknown[] = [];
  readonly writeFaileds: unknown[] = [];
  readonly staleAnswers: unknown[] = [];
  readonly runErrors: { what: string; orderId?: string; err: unknown }[] = [];
  amountMismatch(e: { orderId: string }): void {
    this.amountMismatches.push(e);
  }
  noAdapter(e: { pg: PgName }): void {
    this.noAdapters.push(e);
  }
  writeFailed(e: { orderId: string; stage: 'mark' | 'finish' | 'reschedule' | 'drop'; code: string }): void {
    this.writeFaileds.push(e);
  }
  staleAnswer(e: { orderId: string }): void {
    this.staleAnswers.push(e);
  }
  runError(e: { what: 'claim' | 'read' | 'call'; orderId?: string; err: unknown }): void {
    this.runErrors.push(e);
  }
}

class FakeSignals implements PaymentConfirmSignals {
  readonly outcomes: [PgName, PaymentConfirmOutcome][] = [];
  readonly seconds: [PgName, number][] = [];
  readonly inFlights: number[] = [];
  writeFailures = 0;
  outcome(pg: PgName, outcome: PaymentConfirmOutcome): void {
    this.outcomes.push([pg, outcome]);
  }
  callSeconds(pg: PgName, seconds: number): void {
    this.seconds.push([pg, seconds]);
  }
  inFlight(count: number): void {
    this.inFlights.push(count);
  }
  writeFailure(): void {
    this.writeFailures += 1;
  }
}

function setup(over: Partial<PaymentConfirmRunnerDeps> = {}) {
  const order: string[] = [];
  const clock = fakeClock({ now: NOW });
  const jobs = new FakeJobs(order);
  const gateway = new FakeGateway('SIMULATOR', order, clock);
  const gateways = new FakeGateways();
  gateways.adapters.set('SIMULATOR', gateway);
  const log = new FakeLog();
  const signals = new FakeSignals();
  const timer = new FakeTimer();
  const sleeps: number[] = [];
  const deps: PaymentConfirmRunnerDeps = {
    jobs,
    gateways,
    log,
    signals,
    clock,
    podId: POD,
    timer,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...over,
  };
  return { order, clock, jobs, gateway, gateways, log, signals, timer, sleeps, deps, runner: new PaymentConfirmRunner(deps) };
}
type Fixture = ReturnType<typeof setup>;

const expectNoGatewayCall = (f: Fixture): void => {
  expect(f.gateway.calls).toEqual([]);
  expect(f.signals.seconds).toEqual([]);
};

describe('runJob ①: 원장 읽기', () => {
  test.each(['AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'] as const satisfies readonly PaymentLedgerStatus[])('PRF181_원장이 %s이면 부르지 않고 명령 행만 지운다', async (status) => {
    const f = setup();
    f.jobs.put(target({ status }));
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'DROPPED' });
    expect(f.order).toEqual(['jobs.read', 'jobs.dropJob']);
    expectNoGatewayCall(f);
    expect(f.jobs.finished).toEqual([]);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_지우려니 임대를 잃었으면 SKIPPED LEASE_LOST다', async () => {
    const f = setup();
    f.jobs.put(target({ status: 'APPROVED' }));
    f.jobs.dropResults = [false];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
  });

  test('PRF181_명령 행 지우기가 던지면 WRITE_FAILED drop이고 던지지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const f = setup();
    f.jobs.put(target({ status: 'FAILED' }));
    f.jobs.dropResults = [throws(dbError()), throws(dbError()), throws(dbError())];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'drop' });
    expect(f.signals.writeFailures).toBe(1);
    expect(f.log.writeFaileds).toEqual([{ orderId: ORDER_ID, stage: 'drop', code: '40P01' }]);
  });

  test('PRF181_원장 행이 없으면 부르지 않고 던지지 않는다', async () => {
    const f = setup();
    f.jobs.targets.set(PAYMENT_ID, undefined);
    await expect(f.runner.runJob(job())).resolves.toBeDefined();
    expectNoGatewayCall(f);
    expect(f.jobs.finished).toEqual([]);
  });

  test('PRF181_읽기가 던지면 부르지 않고 runError(read) 뒤 던지지 않는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    f.jobs.targets.set(PAYMENT_ID, throws(dbError()));
    await expect(f.runner.runJob(job())).resolves.toBeDefined();
    expectNoGatewayCall(f);
    expect(f.jobs.marked).toEqual([]);
    expect(f.log.runErrors.map((e) => e.what)).toEqual(['read']);
  });
});

describe('runJob ②: 임대가 끊긴 잔해(restart)', () => {
  test('P-T24_앞 소유자가 있었고 CONFIRM_SENT가 있으면 결제사를 다시 부르지 않고 UNKNOWN으로 쓴다 [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    f.jobs.put(target({ confirmSent: true }));
    await expect(f.runner.runJob(job({ hadPreviousOwner: true, attempts: 2 }))).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'restart' });
    expect(f.order).toEqual(['jobs.read', 'jobs.finish']);
    expect(f.jobs.finished).toEqual([{ target: target({ confirmSent: true }), finish: { status: 'UNKNOWN', result: 'UNKNOWN' } }]);
    expectNoGatewayCall(f);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'restart']]);
  });

  test('P-T24_앞 소유자가 있었어도 CONFIRM_SENT가 없으면 그대로 이어 간다(앞 파드는 부르기 전에 끊겼다)', async () => {
    const f = setup();
    await expect(f.runner.runJob(job({ hadPreviousOwner: true, attempts: 2 }))).resolves.toEqual({ kind: 'FINISHED', status: 'APPROVED', outcome: 'approved' });
    expect(f.order).toEqual(['jobs.read', 'jobs.markSent', 'gateway.confirm', 'jobs.finish']);
    expect(f.gateway.calls).toHaveLength(1);
  });

  test('P-T24_임대 잔해는 어댑터가 없어도 UNKNOWN으로 맞춘다', async () => {
    const f = setup();
    f.gateways.adapters.clear();
    f.jobs.put(target({ confirmSent: true }));
    await expect(f.runner.runJob(job({ hadPreviousOwner: true }))).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'restart' });
    expect(f.jobs.rescheduled).toEqual([]);
  });

  test('P-T24_기한이 지난 잔해도 실패로 끝내지 않고 UNKNOWN이다(앞 요청이 승인됐을 수 있다) [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    f.clock.advance(DEADLINE_MS * 2);
    f.jobs.put(target({ confirmSent: true }));
    await expect(f.runner.runJob(job({ hadPreviousOwner: true }))).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'restart' });
    expect(f.jobs.finished[0]!.finish).toEqual({ status: 'UNKNOWN', result: 'UNKNOWN' });
  });
});

describe('runJob ③: 어댑터 없음', () => {
  test('PRF181_부르지 않고 30초 뒤로 미룬다(지표 no_adapter) [ASVS v5.0.0-16.5.2]', async () => {
    const f = setup();
    f.gateways.adapters.clear();
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'RETRY', outcome: 'no_adapter', nextAtMs: NOW + 30_000 });
    expect(f.order).toEqual(['jobs.read', 'jobs.reschedule']);
    expect(f.jobs.rescheduled).toEqual([{ job: job(), nextAtMs: NOW + 30_000, countRetry: false }]);
    expect(f.jobs.marked).toEqual([]);
    expect(f.jobs.finished).toEqual([]);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'no_adapter']]);
  });

  test('PRF181_기한이 지나 보여도 실패로 끝내지 않고 미룬다(기한은 어댑터가 알려 준다) [ASVS v5.0.0-16.5.2]', async () => {
    const f = setup();
    f.gateways.adapters.clear();
    f.clock.advance(DEADLINE_MS * 2);
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'RETRY', outcome: 'no_adapter' });
    expect(f.jobs.finished).toEqual([]);
  });

  test('PRF181_경고는 파드당 1분에 한 줄이고 지표는 건마다 센다 [ASVS v5.0.0-16.3.4]', async () => {
    const f = setup();
    f.gateways.adapters.clear();
    await f.runner.runJob(job());
    f.clock.advance(59_999);
    await f.runner.runJob(job());
    expect(f.log.noAdapters).toEqual([{ pg: 'SIMULATOR' }]);
    f.clock.advance(1);
    await f.runner.runJob(job());
    expect(f.log.noAdapters).toHaveLength(2);
    expect(f.signals.outcomes).toEqual([
      ['SIMULATOR', 'no_adapter'],
      ['SIMULATOR', 'no_adapter'],
      ['SIMULATOR', 'no_adapter'],
    ]);
  });

  test('PRF181_미루려니 임대를 잃었으면 SKIPPED LEASE_LOST이고 outcome을 세지 않는다', async () => {
    const f = setup();
    f.gateways.adapters.clear();
    f.jobs.rescheduleResults = [false];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_미루기가 던지면 WRITE_FAILED reschedule이다', async () => {
    const f = setup();
    f.gateways.adapters.clear();
    f.jobs.rescheduleResults = [throws(dbError())];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'reschedule' });
    expect(f.signals.writeFailures).toBe(1);
    expect(f.signals.outcomes).toEqual([]);
  });
});

describe('runJob ④: 승인 기한(expireCommand)', () => {
  test('P-T6_기한이 지났고 CONFIRM_SENT가 없으면 부르지 않고 FAILED(EXPIRED)로 끝낸다 [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    f.clock.advance(DUE - NOW);
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'FINISHED', status: 'FAILED', outcome: 'expired' });
    expect(f.order).toEqual(['jobs.read', 'jobs.finish']);
    expect(f.jobs.finished[0]!.finish).toEqual({ status: 'FAILED', failureCategory: 'EXPIRED' });
    expect(f.jobs.marked).toEqual([]);
    expectNoGatewayCall(f);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'expired']]);
  });

  test('P-T6_기한 1ms 전이면 부른다', async () => {
    const f = setup();
    f.clock.advance(DUE - NOW - 1);
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED', status: 'APPROVED' });
    expect(f.gateway.calls).toHaveLength(1);
  });

  test('P-T6_기한은 그 어댑터의 capabilities에서 받는다', async () => {
    const f = setup();
    f.gateway.deadlineMs = 60_000;
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED', status: 'FAILED', outcome: 'expired' });
    expectNoGatewayCall(f);
  });

  test('PRF181_기한이 지났는데 CONFIRM_SENT가 있으면(재전송 중) 부르지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    f.clock.advance(DUE - NOW);
    f.jobs.put(target({ confirmSent: true }));
    await expect(f.runner.runJob(job({ attempts: 4 }))).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'unknown' });
    expect(f.jobs.finished[0]!.finish).toEqual({ status: 'UNKNOWN', result: 'UNKNOWN' });
    expectNoGatewayCall(f);
  });
});

describe('runJob ⑤⑥: 표시와 호출(send)', () => {
  test('P-T24_처음 보낼 때 차례는 읽기 → CONFIRM_SENT → 결제사 → 답 반영이다', async () => {
    const f = setup();
    await f.runner.runJob(job());
    expect(f.order).toEqual(['jobs.read', 'jobs.markSent', 'gateway.confirm', 'jobs.finish']);
    expect(f.jobs.marked).toEqual([job()]);
  });

  test('P-T24_표시 커밋이 끝나기 전에는 결제사를 부르지 않는다', async () => {
    const f = setup();
    const mark = deferred<MarkConfirmSentResult>();
    f.jobs.markResults = [mark.promise];
    const run = later(f.runner.runJob(job()));
    await flush();
    expectNoGatewayCall(f);
    mark.resolve('MARKED');
    await run;
    expect(f.gateway.calls).toHaveLength(1);
  });

  test('PRF181_결제사에는 주문 ID·결제 참조·원장 금액·confirm-{orderId}만 넘긴다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = setup();
    await f.runner.runJob(job());
    expect(f.gateway.calls).toEqual([{ orderId: ORDER_ID, paymentRef: SECRET_PAYMENT_KEY, amount: AMOUNT, idemKey: `confirm-${ORDER_ID}` }]);
  });

  test('PRF181_CONFIRM_SENT가 있으면(재전송) 임대를 확인한 뒤 같은 멱등키로 다시 보낸다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = setup();
    f.jobs.put(target({ confirmSent: true }));
    await f.runner.runJob(job({ attempts: 2 }));
    expect(f.order).toEqual(['jobs.read', 'jobs.markSent', 'gateway.confirm', 'jobs.finish']);
    expect(f.gateway.calls[0]!.idemKey).toBe(`confirm-${ORDER_ID}`);
  });

  test('PRF181_처음과 재전송의 멱등키가 글자까지 같다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = setup();
    f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
    await f.runner.runJob(job());
    f.jobs.put(target({ confirmSent: true }));
    await f.runner.runJob(job({ attempts: 2 }));
    expect(f.gateway.calls).toHaveLength(2);
    expect(f.gateway.calls[1]).toEqual(f.gateway.calls[0]);
  });

  test('PRF181_markSent가 ALREADY면(겹침) 표시를 더하지 않고 그대로 보낸다', async () => {
    const f = setup();
    f.jobs.markResults = ['ALREADY'];
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED' });
    expect(f.gateway.calls).toHaveLength(1);
  });

  test('PRF181_markSent가 LEASE_LOST면 부르지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = setup();
    f.jobs.markResults = ['LEASE_LOST'];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    expectNoGatewayCall(f);
    expect(f.jobs.finished).toEqual([]);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_markSent가 STALE이면(그 사이 원장이 바뀜) 부르지 않고 원장을 쓰지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const f = setup();
    f.jobs.markResults = ['STALE'];
    await expect(f.runner.runJob(job())).resolves.toBeDefined();
    expectNoGatewayCall(f);
    expect(f.jobs.finished).toEqual([]);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('P-T24_표시 쓰기가 던지면 부르지 않는다(표시 없이 보낸 호출은 재시작 때 가려낼 수 없다) [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    f.jobs.markResults = [throws(dbError())];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'mark' });
    expectNoGatewayCall(f);
    expect(f.jobs.finished).toEqual([]);
    expect(f.signals.writeFailures).toBe(1);
    expect(f.log.writeFaileds).toEqual([{ orderId: ORDER_ID, stage: 'mark', code: '40P01' }]);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_target의 pg로 어댑터를 고르고 지표에 그 pg를 적는다', async () => {
    const f = setup();
    const toss = new FakeGateway('TOSS', f.order, f.clock);
    f.gateways.adapters.set('TOSS', toss);
    f.jobs.put(target({ pg: 'TOSS' }));
    toss.latencyMs = 40;
    await f.runner.runJob(job());
    expect(toss.calls).toHaveLength(1);
    expect(f.gateway.calls).toEqual([]);
    expect(f.signals.outcomes).toEqual([['TOSS', 'approved']]);
    expect(f.signals.seconds).toEqual([['TOSS', 0.04]]);
  });
});

describe('runJob ⑦: 답 반영(respond·timeout)', () => {
  test.each<[string, ConfirmResult, ConfirmFinish, ConfirmFinish['status'], PaymentConfirmOutcome]>([
    ['APPROVED', answer({ outcome: 'APPROVED', amount: AMOUNT, approvedAt: APPROVED_AT }), { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, latencyMs: 250 }, 'APPROVED', 'approved'],
    ['ALREADY_APPROVED', answer({ outcome: 'ALREADY_APPROVED', amount: AMOUNT, approvedAt: APPROVED_AT }), { status: 'APPROVED', result: 'ALREADY_APPROVED', approvedAtMs: APPROVED_AT_MS, latencyMs: 250 }, 'APPROVED', 'already'],
    ['DECLINED', answer({ outcome: 'DECLINED', failureCategory: 'CARD_DECLINED' }), { status: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED', latencyMs: 250 }, 'FAILED', 'declined'],
    ['WAITING_FOR_DEPOSIT', answer({ outcome: 'WAITING_FOR_DEPOSIT' }), { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', latencyMs: 250 }, 'AWAITING_DEPOSIT', 'waiting'],
    ['UNKNOWN', answer({ outcome: 'UNKNOWN' }), { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 250 }, 'UNKNOWN', 'unknown'],
  ])('PRF181_%s 답은 finish 한 번으로 쓰고 지표를 하나 올린다 [ASVS v5.0.0-2.3.3]', async (_name, a, finish, status, outcome) => {
    const f = setup();
    f.gateway.latencyMs = 250;
    f.gateway.answers = [a];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'FINISHED', status, outcome });
    expect(f.jobs.finished).toEqual([{ target: target(), finish }]);
    expect(f.jobs.rescheduled).toEqual([]);
    expect(f.jobs.dropped).toEqual([]);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', outcome]]);
    expect(f.signals.seconds).toEqual([['SIMULATOR', 0.25]]);
    expect(f.log.amountMismatches).toEqual([]);
  });

  test.each([
    ['다름', { outcome: 'APPROVED', amount: AMOUNT + 1, approvedAt: APPROVED_AT }],
    ['없음', { outcome: 'APPROVED', approvedAt: APPROVED_AT }],
    ['이미 승인인데 다름', { outcome: 'ALREADY_APPROVED', amount: 1, approvedAt: APPROVED_AT }],
  ] as const)('PRF181_승인 금액 %s: UNKNOWN으로 쓰고 SEV1 로그 한 줄에는 주문 ID만 싣는다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async (_name, a) => {
    const f = setup();
    f.gateway.answers = [answer(a)];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'unknown' });
    expect(f.jobs.finished[0]!.finish).toMatchObject({ status: 'UNKNOWN', result: 'UNKNOWN' });
    expect(f.log.amountMismatches).toEqual([{ orderId: ORDER_ID }]);
  });

  test.each([
    ['던진 오류', dbError('ETIMEDOUT')],
    ['Error가 아닌 값', 'boom'],
  ])('PRF181_어댑터가 던지면(%s) 결과를 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.4]', async (_name, err) => {
    const f = setup();
    f.gateway.latencyMs = 60_000;
    f.gateway.answers = [throws(err)];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'unknown' });
    expect(f.jobs.finished[0]!.finish).toEqual({ status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 60_000 });
    expect(f.log.runErrors.map((e) => [e.what, e.orderId])).toEqual([['call', ORDER_ID]]);
    expect(f.signals.seconds).toEqual([['SIMULATOR', 60]]);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'unknown']]);
  });

  test('PRF181_어댑터가 던져도 다시 부르지 않는다(같은 호출이 두 번 나가지 않는다) [ASVS v5.0.0-2.3.4]', async () => {
    const f = setup();
    f.gateway.answers = [throws(new Error('연결 끊김'))];
    await f.runner.runJob(job());
    expect(f.gateway.calls).toHaveLength(1);
  });

  test('PRF181_늦은 답(원장이 이미 ACCEPTED가 아님): STALE이고 경고 한 줄, outcome을 세지 않는다', async () => {
    const f = setup();
    f.jobs.finishResults = ['STALE'];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'STALE' });
    expect(f.log.staleAnswers).toEqual([{ orderId: ORDER_ID }]);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_돌고 있는 호출 수를 지표로 둔다(호출 중 1, 끝나면 0)', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    const run = later(f.runner.runJob(job()));
    await flush();
    expect(f.signals.inFlights.at(-1)).toBe(1);
    gate.resolve();
    await run;
    expect(f.signals.inFlights.at(-1)).toBe(0);
  });
});

describe('runJob: 다시 보내기(IN_PROGRESS·THROTTLED)', () => {
  test.each([
    ['IN_PROGRESS', answer({ outcome: 'IN_PROGRESS' })],
    ['DECLINED + THROTTLED', answer({ outcome: 'DECLINED', failureCategory: 'THROTTLED' })],
  ])('PRF181_%s: 명령 행을 미루고 원장은 그대로, 수출 사건 없음', async (_name, a) => {
    const f = setup();
    f.gateway.answers = [a];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'RETRY', outcome: 'in_progress', nextAtMs: NOW + 1000 });
    expect(f.jobs.rescheduled).toEqual([{ job: job(), nextAtMs: NOW + 1000, countRetry: true }]);
    expect(f.jobs.finished).toEqual([]);
    expect(f.jobs.dropped).toEqual([]);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'in_progress']]);
  });

  test.each([0, 1, 2, 3, 5, 6, 40])('PRF181_앞서 %i번 미룬 행의 다음 시각은 지금 + confirmRetryDelayMs(attempts + 1)다', async (attempts) => {
    const f = setup();
    f.jobs.put(target({ confirmSent: attempts > 0 }));
    f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
    await f.runner.runJob(job({ attempts }));
    expect(f.jobs.rescheduled[0]!.nextAtMs).toBe(NOW + confirmRetryDelayMs(attempts + 1));
  });

  test('PRF181_다음 시각은 답을 받은 뒤의 지금에서 잰다', async () => {
    const f = setup();
    f.gateway.latencyMs = 5000;
    f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ nextAtMs: NOW + 5000 + 1000 });
  });

  test('PRF181_미루려니 임대를 잃었으면 SKIPPED LEASE_LOST이고 outcome을 세지 않는다', async () => {
    const f = setup();
    f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
    f.jobs.rescheduleResults = [false];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_미루기가 던지면 WRITE_FAILED reschedule이고 행을 그대로 둔다', async () => {
    const f = setup();
    f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
    f.jobs.rescheduleResults = [throws(dbError())];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'reschedule' });
    expect(f.jobs.finished).toEqual([]);
    expect(f.signals.writeFailures).toBe(1);
    expect(f.log.writeFaileds).toEqual([{ orderId: ORDER_ID, stage: 'reschedule', code: '40P01' }]);
  });
});

describe('runJob ⑧: 답 반영 쓰기가 실패할 때', () => {
  test('PRF181_한 번 실패하면 100ms 뒤 다시 해서 끝낸다(같은 값, 결제사는 다시 부르지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const f = setup();
    f.jobs.finishResults = [throws(dbError()), 'APPLIED'];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'FINISHED', status: 'APPROVED', outcome: 'approved' });
    expect(f.sleeps).toEqual([100]);
    expect(f.jobs.finished).toHaveLength(2);
    expect(f.jobs.finished[1]).toEqual(f.jobs.finished[0]);
    expect(f.gateway.calls).toHaveLength(1);
    expect(f.signals.writeFailures).toBe(0);
    expect(f.log.writeFaileds).toEqual([]);
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'approved']]);
  });

  test('PRF181_두 번 실패하면 100ms·400ms 뒤 세 번째로 끝낸다', async () => {
    const f = setup();
    f.jobs.finishResults = [throws(dbError()), throws(dbError()), 'APPLIED'];
    await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED' });
    expect(f.sleeps).toEqual([100, 400]);
    expect(f.jobs.finished).toHaveLength(3);
  });

  test('P-T24_세 번 다 실패하면 행을 그대로 둔다(임대가 끝나면 UNKNOWN으로 맞춰진다) [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.3.4]', async () => {
    const f = setup();
    f.jobs.finishResults = [throws(dbError()), throws(dbError()), throws(dbError())];
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'finish' });
    expect(f.sleeps).toEqual([100, 400]);
    expect(f.jobs.finished).toHaveLength(3);
    expect(f.jobs.rescheduled).toEqual([]);
    expect(f.jobs.dropped).toEqual([]);
    expect(f.jobs.released).toEqual([]);
    expect(f.gateway.calls).toHaveLength(1);
    expect(f.signals.writeFailures).toBe(1);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('PRF181_쓰기 실패 로그에는 오류 코드만 싣고 드라이버 오류의 글을 싣지 않는다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.3.4]', async () => {
    const f = setup();
    f.jobs.finishResults = [throws(dbError('23505')), throws(dbError('23505')), throws(dbError('23505'))];
    await f.runner.runJob(job());
    expect(f.log.writeFaileds).toEqual([{ orderId: ORDER_ID, stage: 'finish', code: '23505' }]);
    expect(JSON.stringify(f.log.writeFaileds)).not.toContain(SECRET_PAYMENT_KEY);
  });

  test.each<[string, Partial<ConfirmTarget>, Partial<ConfirmJob>, number]>([
    ['임대 잔해', { confirmSent: true }, { hadPreviousOwner: true }, 0],
    ['기한 넘김', {}, {}, DEADLINE_MS],
  ])('PRF181_%s의 답 반영도 같은 규칙으로 다시 한다', async (_name, t, j, advance) => {
    const f = setup();
    f.clock.advance(advance);
    f.jobs.put(target(t));
    f.jobs.finishResults = [throws(dbError()), throws(dbError()), throws(dbError())];
    await expect(f.runner.runJob(job(j))).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'finish' });
    expect(f.sleeps).toEqual([100, 400]);
    expect(f.jobs.finished).toHaveLength(3);
    expectNoGatewayCall(f);
  });

  test('PRF181_sleep을 주지 않으면 실제로 쉬고 다시 한다', async () => {
    const f = setup();
    const { sleep: _sleep, ...deps } = f.deps;
    f.jobs.finishResults = [throws(dbError()), 'APPLIED'];
    await expect(new PaymentConfirmRunner(deps).runJob(job())).resolves.toMatchObject({ kind: 'FINISHED' });
  });
});

describe('로그에 결제 값을 싣지 않는다', () => {
  test('PRF181_여러 갈래를 돌아도 실행기가 로그에 넘긴 값에 결제 키·금액이 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const f = setup();
    f.jobs.finishResults = ['STALE'];
    await f.runner.runJob(job());
    f.gateway.answers = [answer({ outcome: 'APPROVED', amount: AMOUNT + 1 })];
    await f.runner.runJob(job());
    f.jobs.finishResults = [throws(dbError()), throws(dbError()), throws(dbError())];
    await f.runner.runJob(job());
    f.jobs.markResults = [throws(dbError())];
    await f.runner.runJob(job());
    f.gateways.adapters.clear();
    await f.runner.runJob(job());
    const { amountMismatches, noAdapters, writeFaileds, staleAnswers } = f.log;
    const text = JSON.stringify({ amountMismatches, noAdapters, writeFaileds, staleAnswers, outcomes: f.signals.outcomes });
    expect(amountMismatches.length * noAdapters.length * writeFaileds.length * staleAnswers.length).toBeGreaterThan(0);
    expect(text).not.toContain(SECRET_PAYMENT_KEY);
    expect(text).not.toContain(String(AMOUNT));
    expect(text).not.toContain('INSERT INTO');
  });
});

describe('tick: 빈자리만큼 잡기', () => {
  test('PRF181_빈자리 32건·파드 이름·임대 75초로 잡고 잡은 수를 돌려준다', async () => {
    const f = setup();
    f.jobs.claims = [[job(), job({ paymentId: OTHER_PAYMENT })]];
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 2 });
    expect(f.jobs.claimArgs).toEqual([[32, POD, 75_000]]);
    await f.runner.whenIdle();
    expect(f.gateway.calls).toHaveLength(2);
    expect(f.jobs.finished).toHaveLength(2);
  });

  test('PRF181_잡을 것이 없으면 claimed 0이다', async () => {
    const f = setup();
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 0 });
    expect(f.order).toEqual(['jobs.claimDue']);
  });

  test('PRF181_틱은 호출을 기다리지 않는다(잡기까지만)', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    f.jobs.claims = [[job()]];
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 1 });
    await flush();
    expect(f.gateway.calls).toHaveLength(1);
    expect(f.jobs.finished).toEqual([]);
    gate.resolve();
    await f.runner.whenIdle();
    expect(f.jobs.finished).toHaveLength(1);
  });

  test('PRF181_concurrency·leaseMs 설정을 넘긴다', async () => {
    const f = setup({ concurrency: 2, leaseMs: 9000 });
    await f.runner.tick();
    expect(f.jobs.claimArgs).toEqual([[2, POD, 9000]]);
  });

  test.each([0, -1, 1.5, Number.NaN])('PRF181_concurrency %d는 기본값 32로 본다', async (concurrency) => {
    const f = setup({ concurrency });
    await f.runner.tick();
    expect(f.jobs.claimArgs[0]![0]).toBe(32);
  });

  test('PRF181_잡기가 던지면 runError(claim) 뒤 claimed 0이고 던지지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const f = setup();
    f.jobs.claims = [throws(dbError())];
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 0 });
    expect(f.log.runErrors.map((e) => e.what)).toEqual(['claim']);
  });

  test('PRF181_빈자리만큼만 잡는다(5건이 돌면 27건)', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    f.jobs.claims = [Array.from({ length: 5 }, (_, i) => jobN(i))];
    await f.runner.tick();
    await flush();
    await f.runner.tick();
    expect(f.jobs.claimArgs.map((a) => a[0])).toEqual([32, 27]);
    gate.resolve();
    await f.runner.whenIdle();
  });

  test('PRF181_동시 상한 32: 빈자리가 없으면 잡지 않고 claimed 0이다', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    f.jobs.claims = [Array.from({ length: 32 }, (_, i) => jobN(i))];
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 32 });
    await flush();
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 0 });
    expect(f.jobs.claimArgs).toHaveLength(1);
    gate.resolve();
    await f.runner.whenIdle();
  });

  test('PRF181_밀린 일이 많아도 동시 호출은 32를 넘지 않고, 하나가 끝나면 그만큼만 더 잡는다', async () => {
    const f = setup();
    const backlog = Array.from({ length: 100 }, (_, i) => jobN(i));
    f.jobs.claimFn = (limit) => backlog.splice(0, limit);
    const gates = Array.from({ length: 100 }, () => deferred<ConfirmResult>());
    f.gateway.answers = gates.map((g) => g.promise);
    for (let i = 0; i < 3; i++) {
      await f.runner.tick();
      await flush();
    }
    expect(f.gateway.peak).toBe(32);
    expect(f.gateway.calls).toHaveLength(32);
    gates[0]!.resolve(answer({ outcome: 'APPROVED', amount: AMOUNT, approvedAt: APPROVED_AT }));
    await flush();
    await f.runner.tick();
    await flush();
    expect(f.jobs.claimArgs.at(-1)![0]).toBe(1);
    expect(f.gateway.calls).toHaveLength(33);
    expect(f.gateway.peak).toBe(32);
    for (const g of gates) g.resolve(answer({ outcome: 'APPROVED', amount: AMOUNT, approvedAt: APPROVED_AT }));
    await f.runner.whenIdle();
  });

  test('PRF181_빈자리는 답 반영이 끝날 때까지 쥐고 있다', async () => {
    const f = setup();
    const finish = deferred<FinishConfirmResult>();
    f.jobs.finishResults = [finish.promise];
    f.jobs.claims = [[job()]];
    await f.runner.tick();
    await flush();
    await f.runner.tick();
    expect(f.jobs.claimArgs.map((a) => a[0])).toEqual([32, 31]);
    finish.resolve('APPLIED');
    await f.runner.whenIdle();
    await f.runner.tick();
    expect(f.jobs.claimArgs.at(-1)![0]).toBe(32);
  });

  test('PRF181_runJob으로 직접 돌린 행도 빈자리를 쥔다', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    const run = later(f.runner.runJob(job()));
    await flush();
    await f.runner.tick();
    expect(f.jobs.claimArgs[0]![0]).toBe(31);
    gate.resolve();
    await run;
  });

  test('PRF181_요청 맥락 안에서 틱을 불러도 호출은 요청 맥락을 물려받지 않는다(실행기를 만든 때의 맥락)', async () => {
    const f = setup();
    const dl = fakeClock({ now: NOW });
    const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(1, dl), route: '/x', method: 'POST', log: {} as RequestContext['log'] };
    dl.advance(10);
    f.jobs.claims = [[job()]];
    await runInRequestContext(ctx, () => f.runner.tick());
    await f.runner.whenIdle();
    expect(f.gateway.contexts).toEqual([undefined]);
  });
});

describe('리뷰 고침(BUILD_ORDER PRF-181, 코드 리뷰)', () => {
  describe('M3: 재전송 중 거절', () => {
    test.each(['PG_ERROR', 'VALIDATION', undefined] as const)('PRF181_리뷰 고침 M3: 재전송의 DECLINED(%s)는 FAILED가 아니라 UNKNOWN이다(첫 요청이 그 뒤에도 승인될 수 있다) [ASVS v5.0.0-16.5.3]', async (failureCategory) => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.gateway.latencyMs = 40;
      f.gateway.answers = [answer({ outcome: 'DECLINED', ...(failureCategory === undefined ? {} : { failureCategory }) })];
      await expect(f.runner.runJob(job({ attempts: 1 }))).resolves.toEqual({ kind: 'FINISHED', status: 'UNKNOWN', outcome: 'unknown' });
      expect(f.jobs.finished[0]!.finish).toEqual({ status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 40 });
      expect(f.signals.outcomes).toEqual([['SIMULATOR', 'unknown']]);
    });

    test('PRF181_리뷰 고침 M3: 표시를 먼저 쓰려다 ALREADY를 받은 호출(겹침)도 재전송이다 [ASVS v5.0.0-16.5.3]', async () => {
      const f = setup();
      f.jobs.markResults = ['ALREADY'];
      f.gateway.answers = [answer({ outcome: 'DECLINED', failureCategory: 'PG_ERROR' })];
      await expect(f.runner.runJob(job())).resolves.toMatchObject({ kind: 'FINISHED', status: 'UNKNOWN' });
    });

    test.each(['CARD_DECLINED', 'USER_ABORTED', 'EXPIRED'] as const)('PRF181_리뷰 고침 M3: 재전송의 DECLINED(%s)는 결제사가 그 결제에 내린 판정이라 그대로 FAILED다', async (failureCategory) => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.gateway.answers = [answer({ outcome: 'DECLINED', failureCategory })];
      await expect(f.runner.runJob(job({ attempts: 1 }))).resolves.toEqual({ kind: 'FINISHED', status: 'FAILED', outcome: 'declined' });
      expect(f.jobs.finished[0]!.finish).toMatchObject({ status: 'FAILED', result: 'DECLINED', failureCategory });
    });

    test('PRF181_리뷰 고침 M3: 재전송의 THROTTLED는 그대로 미룬다', async () => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.gateway.answers = [answer({ outcome: 'DECLINED', failureCategory: 'THROTTLED' })];
      await expect(f.runner.runJob(job({ attempts: 1 }))).resolves.toMatchObject({ kind: 'RETRY', outcome: 'in_progress' });
    });

    test.each(['PG_ERROR', 'VALIDATION'] as const)('PRF181_리뷰 고침 M3: 처음 보낸 호출의 DECLINED(%s)는 그대로 FAILED다(앞선 요청이 없다)', async (failureCategory) => {
      const f = setup();
      f.gateway.answers = [answer({ outcome: 'DECLINED', failureCategory })];
      await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'FINISHED', status: 'FAILED', outcome: 'declined' });
    });
  });

  describe('L6: 재전송도 호출 전에 임대를 확인한다', () => {
    test('PRF181_리뷰 고침 L6: 재전송도 markSent를 거쳐 ALREADY로 진행한다 [ASVS v5.0.0-2.3.4]', async () => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.jobs.markResults = ['ALREADY'];
      await f.runner.runJob(job({ attempts: 1 }));
      expect(f.order).toEqual(['jobs.read', 'jobs.markSent', 'gateway.confirm', 'jobs.finish']);
    });

    test('PRF181_리뷰 고침 L6: 재전송인데 임대를 잃었으면 부르지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.jobs.markResults = ['LEASE_LOST'];
      await expect(f.runner.runJob(job({ attempts: 1 }))).resolves.toEqual({ kind: 'SKIPPED', reason: 'LEASE_LOST' });
      expectNoGatewayCall(f);
      expect(f.jobs.finished).toEqual([]);
    });

    test('PRF181_리뷰 고침 L6: 재전송인데 원장이 바뀌었으면 부르지 않고 명령 행만 지운다 [ASVS v5.0.0-2.3.4]', async () => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.jobs.markResults = ['STALE'];
      await expect(f.runner.runJob(job({ attempts: 1 }))).resolves.toEqual({ kind: 'DROPPED' });
      expectNoGatewayCall(f);
    });

    test('PRF181_리뷰 고침 L6: 재전송의 임대 확인이 던지면 부르지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
      const f = setup();
      f.jobs.put(target({ confirmSent: true }));
      f.jobs.markResults = [throws(dbError())];
      await expect(f.runner.runJob(job({ attempts: 1 }))).resolves.toEqual({ kind: 'WRITE_FAILED', stage: 'mark' });
      expectNoGatewayCall(f);
    });
  });

  describe('L8: 원장 읽기 실패', () => {
    test('PRF181_리뷰 고침 L8: 앞 소유자가 없던 행은 임대를 놓는다(남기면 다음 잡기가 잔해로 본다) [ASVS v5.0.0-16.5.3]', async () => {
      const f = setup();
      f.jobs.targets.set(PAYMENT_ID, throws(dbError()));
      await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'READ_FAILED' });
      expect(f.jobs.released).toEqual([job()]);
      expectNoGatewayCall(f);
    });

    test('P-T24_리뷰 고침 L8: 앞 소유자가 있던 행은 임대를 놓지 않는다(놓으면 잔해 표시를 잃는다) [ASVS v5.0.0-16.5.3]', async () => {
      const f = setup();
      f.jobs.targets.set(PAYMENT_ID, throws(dbError()));
      await expect(f.runner.runJob(job({ hadPreviousOwner: true }))).resolves.toEqual({ kind: 'SKIPPED', reason: 'READ_FAILED' });
      expect(f.jobs.released).toEqual([]);
    });

    test('PRF181_리뷰 고침 L8: 임대 놓기가 던져도 던지지 않는다', async () => {
      const f = setup();
      f.jobs.targets.set(PAYMENT_ID, throws(dbError()));
      f.jobs.releaseResults = [throws(dbError())];
      await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'READ_FAILED' });
    });
  });

  describe('L9: 재전송 간격은 재전송 횟수로 잰다', () => {
    test('PRF181_리뷰 고침 L9: 아직 미룬 적이 없으면(attempts 0) 첫 간격은 1초다', async () => {
      const f = setup();
      f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
      await expect(f.runner.runJob(job({ attempts: 0 }))).resolves.toEqual({ kind: 'RETRY', outcome: 'in_progress', nextAtMs: NOW + 1000 });
    });

    test.each([
      [0, 1000],
      [1, 2000],
      [2, 4000],
      [5, 30_000],
    ])('PRF181_리뷰 고침 L9: 앞서 %i번 미룬 행의 다음 간격은 %i ms다', async (attempts, delay) => {
      const f = setup();
      f.jobs.put(target({ confirmSent: attempts > 0 }));
      f.gateway.answers = [answer({ outcome: 'IN_PROGRESS' })];
      await f.runner.runJob(job({ attempts }));
      expect(f.jobs.rescheduled[0]!.nextAtMs).toBe(NOW + delay);
    });

    test.each([
      ['IN_PROGRESS', answer({ outcome: 'IN_PROGRESS' })],
      ['THROTTLED', answer({ outcome: 'DECLINED', failureCategory: 'THROTTLED' })],
    ])('PRF181_리뷰 고침 L9: %s로 미룰 때 재전송 횟수를 올린다', async (_name, a) => {
      const f = setup();
      f.gateway.answers = [a];
      await f.runner.runJob(job({ attempts: 0 }));
      expect(f.jobs.rescheduled[0]!.countRetry).toBe(true);
    });

    test('PRF181_리뷰 고침 L9: 어댑터 없음으로 미룰 때는 재전송 횟수를 올리지 않는다', async () => {
      const f = setup();
      f.gateways.adapters.clear();
      await f.runner.runJob(job({ attempts: 0 }));
      expect(f.jobs.rescheduled[0]!.countRetry).toBe(false);
    });
  });

  describe('capabilities()가 던질 때', () => {
    test('PRF181_리뷰 고침: capabilities()가 던져도 runJob은 던지지 않고 부르지 않으며 임대를 놓는다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.4]', async () => {
      const f = setup();
      f.gateway.capabilitiesFailure = new Error('어댑터 결함');
      await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'READ_FAILED' });
      expectNoGatewayCall(f);
      expect(f.jobs.finished).toEqual([]);
      expect(f.jobs.marked).toEqual([]);
      expect(f.jobs.released).toEqual([job()]);
      expect(f.log.runErrors.map((e) => e.what)).toEqual(['read']);
    });

    test('P-T24_리뷰 고침: capabilities()가 던져도 앞 소유자가 있던 행의 임대는 놓지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
      const f = setup();
      f.gateway.capabilitiesFailure = new Error('어댑터 결함');
      await expect(f.runner.runJob(job({ hadPreviousOwner: true }))).resolves.toEqual({ kind: 'SKIPPED', reason: 'READ_FAILED' });
      expect(f.jobs.released).toEqual([]);
    });

    test('PRF181_리뷰 고침: 어댑터 등록부가 던져도 runJob은 던지지 않는다', async () => {
      const f = setup();
      f.gateways.of = () => {
        throw new Error('등록부 결함');
      };
      await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'READ_FAILED' });
      expectNoGatewayCall(f);
    });
  });
});

describe('start·stop·whenIdle', () => {
  test('PRF181_start는 100ms 반복 하나를 켠다(두 번 불러도 하나)', () => {
    const f = setup();
    f.runner.start();
    f.runner.start();
    expect(f.timer.set.map((s) => s.ms)).toEqual([100]);
  });

  test('PRF181_pollIntervalMs 설정을 쓴다', () => {
    const f = setup({ pollIntervalMs: 7 });
    f.runner.start();
    expect(f.timer.set.map((s) => s.ms)).toEqual([7]);
  });

  test('PRF181_타이머가 불리면 틱이 돈다', async () => {
    const f = setup();
    f.jobs.claims = [[job()]];
    f.runner.start();
    f.timer.fire();
    await flush();
    await f.runner.whenIdle();
    expect(f.jobs.claimArgs).toHaveLength(1);
    expect(f.jobs.finished).toHaveLength(1);
  });

  test('PRF181_앞 틱의 잡기가 끝나지 않았으면 이번 틱을 건너뛴다(겹침 없음)', async () => {
    const f = setup();
    const claim = deferred<ConfirmJob[]>();
    f.jobs.claims = [claim.promise, []];
    f.runner.start();
    f.timer.fire();
    await flush();
    f.timer.fire();
    f.timer.fire();
    await flush();
    expect(f.jobs.claimArgs).toHaveLength(1);
    claim.resolve([]);
    await flush();
    f.timer.fire();
    await flush();
    expect(f.jobs.claimArgs).toHaveLength(2);
  });

  test('PRF181_앞 틱의 호출이 돌고 있어도 다음 틱은 돈다(잡기만 겹치지 않는다)', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    f.jobs.claims = [[job()], []];
    f.runner.start();
    f.timer.fire();
    await flush();
    f.timer.fire();
    await flush();
    expect(f.jobs.claimArgs.map((a) => a[0])).toEqual([32, 31]);
    gate.resolve();
    await f.runner.whenIdle();
  });

  test('PRF181_잡기가 던져도 반복이 죽지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const f = setup();
    f.jobs.claims = [throws(dbError()), [job()]];
    f.runner.start();
    f.timer.fire();
    await flush();
    f.timer.fire();
    await flush();
    await f.runner.whenIdle();
    expect(f.jobs.finished).toHaveLength(1);
  });

  test('PRF181_타이머를 주지 않으면 실제 반복이 돈다', async () => {
    const f = setup({ pollIntervalMs: 2 });
    const { timer: _timer, ...deps } = f.deps;
    const runner = new PaymentConfirmRunner(deps);
    runner.start();
    for (let i = 0; i < 200 && f.jobs.claimArgs.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await runner.stop();
    expect(f.jobs.claimArgs.length).toBeGreaterThan(0);
    const seen = f.jobs.claimArgs.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(f.jobs.claimArgs).toHaveLength(seen);
  });

  test('PRF181_stop은 반복을 끄고, 멈춘 뒤의 틱·start는 아무것도 하지 않는다', async () => {
    const f = setup();
    f.runner.start();
    await f.runner.stop();
    expect(f.timer.cleared).toEqual([f.timer.set[0]!.handle]);
    await expect(f.runner.tick()).resolves.toEqual({ claimed: 0 });
    expect(f.jobs.claimArgs).toEqual([]);
    f.runner.start();
    expect(f.timer.set).toHaveLength(1);
  });

  test('PRF181_stop을 두 번 불러도 괜찮다, start 없이 불러도 끝난다', async () => {
    const f = setup();
    await expect(f.runner.stop()).resolves.toBeUndefined();
    await expect(f.runner.stop()).resolves.toBeUndefined();
    const g = setup();
    g.runner.start();
    await g.runner.stop();
    await g.runner.stop();
    expect(g.timer.cleared).toHaveLength(1);
  });

  test('PRF181_stop은 돌던 호출과 그 뒤 쓰기를 기다린다 [ASVS v5.0.0-2.3.3]', async () => {
    const f = setup();
    const gate = deferred();
    const finish = deferred<FinishConfirmResult>();
    f.gateway.gate = gate.promise;
    f.jobs.finishResults = [finish.promise];
    f.jobs.claims = [[job()]];
    await f.runner.tick();
    await flush();
    let stopped = false;
    const stopping = later(f.runner.stop().then(() => void (stopped = true)));
    await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await flush();
    expect(f.jobs.finished).toHaveLength(1);
    expect(stopped).toBe(false);
    finish.resolve('APPLIED');
    await stopping;
    expect(stopped).toBe(true);
  });

  test('PRF181_stop은 답 반영 다시 하기까지 기다린다', async () => {
    const f = setup();
    const second = deferred<FinishConfirmResult>();
    f.jobs.finishResults = [throws(dbError()), second.promise];
    f.jobs.claims = [[job()]];
    await f.runner.tick();
    await flush();
    let stopped = false;
    const stopping = later(f.runner.stop().then(() => void (stopped = true)));
    await flush();
    expect(f.jobs.finished).toHaveLength(2);
    expect(stopped).toBe(false);
    second.resolve('APPLIED');
    await stopping;
    expect(f.signals.outcomes).toEqual([['SIMULATOR', 'approved']]);
  });

  test('PRF181_멈춘 뒤의 runJob은 부르지 않고 임대를 놓는다(SKIPPED RELEASED)', async () => {
    const f = setup();
    await f.runner.stop();
    await expect(f.runner.runJob(job())).resolves.toEqual({ kind: 'SKIPPED', reason: 'RELEASED' });
    expect(f.jobs.released).toEqual([job()]);
    expectNoGatewayCall(f);
    expect(f.jobs.marked).toEqual([]);
    expect(f.signals.outcomes).toEqual([]);
  });

  test('P-T24_앞 소유자가 있던 행은 멈춘 뒤에 임대를 놓지 않는다(놓으면 다음 잡기가 잔해로 알아보지 못하고 결제사를 다시 부른다) [ASVS v5.0.0-16.5.3]', async () => {
    const f = setup();
    await f.runner.stop();
    await expect(f.runner.runJob(job({ hadPreviousOwner: true, attempts: 2 }))).resolves.toEqual({ kind: 'SKIPPED', reason: 'RELEASED' });
    expect(f.jobs.released).toEqual([]);
    expectNoGatewayCall(f);
  });

  test('PRF181_표시를 쓴 뒤 호출 전에 멈추면 부르지 않고 임대를 놓는다(아직 보내지 않았다)', async () => {
    const f = setup();
    const mark = deferred<MarkConfirmSentResult>();
    f.jobs.markResults = [mark.promise];
    const run = later(f.runner.runJob(job()));
    await flush();
    const stopping = later(f.runner.stop());
    await flush();
    mark.resolve('MARKED');
    await expect(run).resolves.toEqual({ kind: 'SKIPPED', reason: 'RELEASED' });
    await stopping;
    expect(f.jobs.released).toEqual([job()]);
    expectNoGatewayCall(f);
  });

  test('PRF181_stop 중에 잡기가 끝나면 잡은 행의 임대를 놓고 부르지 않는다, stop은 그것까지 기다린다', async () => {
    const f = setup();
    const claim = deferred<ConfirmJob[]>();
    f.jobs.claims = [claim.promise];
    f.runner.start();
    f.timer.fire();
    await flush();
    const stopping = later(f.runner.stop());
    await flush();
    claim.resolve([job(), job({ paymentId: OTHER_PAYMENT })]);
    await stopping;
    expect(f.jobs.released.map((j) => j.paymentId).sort()).toEqual([PAYMENT_ID, OTHER_PAYMENT].sort());
    expectNoGatewayCall(f);
  });

  test('PRF181_읽는 사이에 멈추면 표시를 쓰지 않고 부르지 않으며 임대를 놓는다', async () => {
    const f = setup();
    const read = deferred<ConfirmTarget | undefined>();
    f.jobs.targets.set(PAYMENT_ID, read.promise);
    const run = later(f.runner.runJob(job()));
    await flush();
    const stopping = later(f.runner.stop());
    await flush();
    read.resolve(target());
    await expect(run).resolves.toEqual({ kind: 'SKIPPED', reason: 'RELEASED' });
    await stopping;
    expect(f.jobs.released).toEqual([job()]);
    expect(f.jobs.marked).toEqual([]);
    expectNoGatewayCall(f);
  });

  test('PRF181_임대 놓기가 실패해도 던지지 않는다', async () => {
    const f = setup();
    await f.runner.stop();
    f.jobs.releaseResults = [throws(dbError())];
    await expect(f.runner.runJob(job())).resolves.toBeDefined();
    f.jobs.releaseResults = [false];
    await expect(f.runner.runJob(job())).resolves.toBeDefined();
  });

  test('PRF181_whenIdle은 돌고 있는 행이 없으면 바로 풀린다', async () => {
    await expect(setup().runner.whenIdle()).resolves.toBeUndefined();
  });

  test('PRF181_whenIdle은 돌던 행이 끝나면 풀린다', async () => {
    const f = setup();
    const gate = deferred();
    f.gateway.gate = gate.promise;
    f.jobs.claims = [[job()]];
    await f.runner.tick();
    await flush();
    let idle = false;
    const waiting = later(f.runner.whenIdle().then(() => void (idle = true)));
    await flush();
    expect(idle).toBe(false);
    gate.resolve();
    await waiting;
    expect(idle).toBe(true);
    expect(f.jobs.finished).toHaveLength(1);
  });
});
