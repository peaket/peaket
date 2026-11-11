// 결제 결과 long polling 쓰임새(application/get-payment-status.ts GetPaymentStatus, BUILD_ORDER PRF-166) 단위 시험.
// 정본: docs/features/payment.md §2 '결제 결과 long polling의 첫 구현'('누구의 주문인가'·'바로 답하는 상태'·'기다리는 상태'), openapi GET /v1/orders/{orderId}/payment-status.
// 포트는 메모리 가짜다: 읽기(PaymentStatusReads)는 주문 모습 표를 그대로 돌려주고, 기다림(PaymentStatusWaiters)은 시험이 손으로 깨운다.
// 남은 시간은 가짜 시계 위의 플랫폼 Deadline으로 준다(시계를 당겨 '기다리는 동안 흐른 시간'을 만든다).
//
// 정본 모호(뼈대 주석의 [정함]을 따른다):
// - 깬 뒤 다시 읽어도 기다릴 상태면 '처음 기다림의 끝'까지 남은 몫만 다시 기다린다(전체 기다림이 min(25초, 남은 시간 − 1초)를 넘지 않는다).
//   남은 몫이 0이면 다시 기다리지 않고 그때의 상태로 답한다.
// - TIMEOUT이면 한 번 다시 읽어 그때의 상태로 답하고 다시 기다리지 않는다(그때 주문이 없으면 404).
// - ABORTED면 다시 읽지 않고 마지막 WAIT 본문으로 200을 돌려준다(받을 쪽이 없다).
// - 남은 시간을 모르면(deadline 없음) 기다림은 25초다. 남은 시간이 1초 이하라 기다릴 시간이 0이면 기다리지 않는다.
// 리뷰 고침(2026-11-05, 새 정본):
// - M2 APPROVED는 issueDelayed가 참이어도 기다린다. 깨어 다시 본 상태가 바로 답할 상태이거나 APPROVED의 issueDelayed가 거짓 → 참이면 답하고,
//   아니면 남은 몫을 다시 기다린다(기다림 시작 때 본문과 견준다. 기다림 표에 그 본문을 since로 넘긴다).
// - M3 기다림 표가 가득 차면(FULL) 기다리지 않고 지금 상태로 200(다시 읽지 않는다).
// - M4 묶음 조회가 깨우며 넘긴 주문 모습(CHANGED의 view)이 있으면 다시 읽지 않는다. notify로 깬 경우(모습 없음)만 한 건 다시 읽는다.
//   stop()으로 깬 기다림(STOPPED)은 ABORTED처럼 다시 읽지 않고 마지막 본문으로 답한다.
import { Deadline, fakeClock, HotPathMetrics, PlatformMetrics } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  GetPaymentStatus,
  type GetPaymentStatusCommand,
  type PaymentStatusBody,
  type PaymentStatusReads,
  type PaymentStatusView,
  type PaymentStatusWaitOptions,
  type PaymentStatusWaiters,
  type PaymentStatusWake,
  type PaymentStatusWakeUp,
  paymentStatusWaitTableDatabaseOptions,
} from '../src/modules/booking/index.js';
import { ACCOUNT, NOW } from './order-cases.js';

const ORDER = '0190f3a1-7c2e-7f00-8000-0000000000f2';
const OTHER_ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a2';

/** 메모리 읽기: 주문 모습 표. calls에 부른 차례를 적는다 */
class MemoryReads implements PaymentStatusReads {
  views = new Map<string, PaymentStatusView>();
  calls: string[];
  fail: Error | undefined;
  constructor(calls: string[]) {
    this.calls = calls;
  }
  async read(orderId: string): Promise<PaymentStatusView | undefined> {
    this.calls.push(`read:${orderId}`);
    if (this.fail) throw this.fail;
    return this.views.get(orderId);
  }
  async readMany(orderIds: readonly string[]): Promise<PaymentStatusView[]> {
    this.calls.push(`readMany:${orderIds.join(',')}`);
    return orderIds.flatMap((id) => (this.views.has(id) ? [this.views.get(id)!] : []));
  }
}

/** 손으로 깨우는 기다림. wait를 부르면 pending에 쌓이고, 시험이 wake로 끝낸다 */
class ManualWaiters implements PaymentStatusWaiters {
  calls: string[];
  waits: { orderId: string; deadlineMs: number; signal: AbortSignal | undefined; since: PaymentStatusBody | undefined }[] = [];
  notifies: string[] = [];
  #pending: ((w: PaymentStatusWakeUp) => void)[] = [];
  #arrived: (() => void)[] = [];
  constructor(calls: string[]) {
    this.calls = calls;
  }
  wait(orderId: string, deadlineMs: number, o: PaymentStatusWaitOptions = {}): Promise<PaymentStatusWakeUp> {
    this.calls.push(`wait:${orderId}:${deadlineMs}`);
    this.waits.push({ orderId, deadlineMs, signal: o.signal, since: o.since });
    const p = new Promise<PaymentStatusWakeUp>((r) => this.#pending.push(r));
    for (const a of this.#arrived.splice(0)) a();
    return p;
  }
  notify(orderId: string): void {
    this.notifies.push(orderId);
  }
  /** 기다림이 n개 쌓일 때까지 */
  async arrived(n: number): Promise<void> {
    while (this.waits.length < n) await new Promise<void>((r) => this.#arrived.push(r));
  }
  /** 가장 앞 기다림을 깨운다(까닭만 주면 모습 없이) */
  wake(w: PaymentStatusWake | PaymentStatusWakeUp): void {
    const r = this.#pending.shift();
    if (!r) throw new Error('기다리는 요청이 없다');
    r(typeof w === 'string' ? { wake: w } : w);
  }
  get pendingCount(): number {
    return this.#pending.length;
  }
}

const flush = async () => {
  for (let k = 0; k < 10; k += 1) await new Promise<void>((r) => setImmediate(r));
};

let clock: ReturnType<typeof fakeClock>;
let calls: string[];
let reads: MemoryReads;
let waiters: ManualWaiters;
let useCase: GetPaymentStatus;

const view = (over: Partial<PaymentStatusView> = {}): PaymentStatusView => ({ orderId: ORDER, accountId: ACCOUNT, status: 'ACCEPTED', pg: 'TOSS', ...over });
const put = (over: Partial<PaymentStatusView> = {}) => reads.views.set(ORDER, view(over));
const cmd = (over: Partial<GetPaymentStatusCommand> = {}): GetPaymentStatusCommand => ({ accountId: ACCOUNT, orderId: ORDER, ...over });

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  calls = [];
  reads = new MemoryReads(calls);
  waiters = new ManualWaiters(calls);
  useCase = new GetPaymentStatus({ reads, waiters, clock });
});

describe('누구의 주문인가(같은 404)', () => {
  test('FR011_없는 주문과 남의 주문은 같은 { status: 404 }이고 기다리지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const missing = await useCase.execute(cmd());
    put({ accountId: OTHER_ACCOUNT });
    const others = await useCase.execute(cmd());
    expect(missing).toStrictEqual({ status: 404 });
    expect(others).toStrictEqual({ status: 404 });
    expect(waiters.waits).toEqual([]);
  });

  test('FR011_남의 주문이면 결정 전에 막는다: 기다릴 상태(ACCEPTED)·409 상태(CREATED)·바로 답할 상태(CONFIRMED) 모두 404', async () => {
    for (const status of ['ACCEPTED', 'CREATED', 'EXPIRED', 'CONFIRMED'] as const) {
      put({ accountId: OTHER_ACCOUNT, status });
      expect({ status, r: await useCase.execute(cmd()) }).toStrictEqual({ status, r: { status: 404 } });
    }
    expect(waiters.waits).toEqual([]);
  });

  test('FR011_경로 값은 글 그대로 읽기에 넘긴다(모양을 보지 않는다)', async () => {
    await useCase.execute(cmd({ orderId: 'not-a-uuid' }));
    await useCase.execute(cmd({ orderId: ORDER.toUpperCase() }));
    expect(calls).toEqual(['read:not-a-uuid', `read:${ORDER.toUpperCase()}`]);
  });
});

describe('바로 답함·409', () => {
  test('FR011_바로 답할 상태는 읽기 한 번으로 200이고 기다리지 않는다', async () => {
    put({ status: 'CONFIRMED' });
    expect(await useCase.execute(cmd())).toStrictEqual({ status: 200, body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } });
    put({ status: 'FAILED', failureReason: 'CARD_DECLINED' });
    expect(await useCase.execute(cmd())).toStrictEqual({ status: 200, body: { status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `read:${ORDER}`]);
  });

  test('FR011_409 둘: CREATED·AUTHENTICATED → NOT_ACCEPTED, EXPIRED → ORDER_EXPIRED(기다리지 않는다)', async () => {
    for (const [status, reason] of [
      ['CREATED', 'NOT_ACCEPTED'],
      ['AUTHENTICATED', 'NOT_ACCEPTED'],
      ['EXPIRED', 'ORDER_EXPIRED'],
    ] as const) {
      put({ status });
      expect({ status, r: await useCase.execute(cmd()) }).toStrictEqual({ status, r: { status: 409, reason } });
    }
    expect(waiters.waits).toEqual([]);
  });

  test('M2_ADR0106_issueDelayed 판정의 지금은 쓰임새 시계다: 큐 행이 시계로 60초 전이면 APPROVED도 기다리고(since issueDelayed 참), 시간이 다 되면 issueDelayed 참으로 답한다', async () => {
    put({ status: 'APPROVED', issueJobCreatedAtMs: clock.now() - 60_000, issueJobAttempts: 0 });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    expect(waiters.waits[0]!.since).toStrictEqual({ status: 'APPROVED', issueDelayed: true, pg: 'TOSS' });
    waiters.wake('TIMEOUT');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'APPROVED', issueDelayed: true, pg: 'TOSS' } });
  });

  test('FR011_읽기가 던지면 그대로 던진다(500)', async () => {
    reads.fail = new Error('DB down');
    await expect(useCase.execute(cmd())).rejects.toThrow('DB down');
  });
});

describe('기다림', () => {
  test('FR011_기다릴 상태면 waiters.wait(그 주문, min(25초, 남은 시간 − 1초), signal)을 부르고, 기다리는 동안 다른 포트를 부르지 않는다(DB 연결을 쥐지 않는다)', async () => {
    put({ status: 'ACCEPTED' });
    const signal = new AbortController().signal;
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock), signal }));
    await waiters.arrived(1);
    // 기다림 시작 때 본문(since)을 함께 넘긴다(M2)
    expect(waiters.waits).toEqual([{ orderId: ORDER, deadlineMs: 25_000, signal, since: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } }]);
    // 기다리는 동안: 읽기도, 다른 기다림도 없다
    await flush();
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`]);
    put({ status: 'CONFIRMED' });
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`, `read:${ORDER}`]);
  });

  test.each([
    ['남은 시간 27초', 27_000, 25_000],
    ['남은 시간 15초', 15_000, 14_000],
    ['남은 시간 3.5초', 3_500, 2_500],
  ] as const)('FR011_%s이면 %d ms를 기다린다', async (_n, remaining, want) => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(remaining, clock) }));
    await waiters.arrived(1);
    expect(waiters.waits[0]!.deadlineMs).toBe(want);
    waiters.wake('TIMEOUT');
    await run;
  });

  test('FR011_남은 시간을 모르면(deadline 없음) 25초를 기다린다', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    expect(waiters.waits[0]!.deadlineMs).toBe(25_000);
    waiters.wake('TIMEOUT');
    await run;
  });

  test('FR011_남은 시간이 1초 이하라 기다릴 시간이 0이면 기다리지 않고 지금 상태로 200이다', async () => {
    for (const remaining of [1_000, 400]) {
      put({ status: 'ACCEPTED' });
      const r = await useCase.execute(cmd({ deadline: Deadline.after(remaining, clock) }));
      expect({ remaining, r }).toStrictEqual({ remaining, r: { status: 200, body: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } } });
    }
    expect(waiters.waits).toEqual([]);
  });

  test('FR011_CHANGED로 깨면 다시 읽어 그 상태로 답한다(FAILED reason 포함)', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(3_000);
    put({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' });
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'FAILED', reason: 'INSUFFICIENT_FUNDS', issueDelayed: false, pg: 'TOSS' } });
    expect(waiters.waits).toHaveLength(1);
  });

  test('ADR0106_APPROVED를 기다리는 동안 승인 뒤 60초가 지나 CHANGED로 깨면 issueDelayed true로 답한다', async () => {
    put({ status: 'APPROVED', issueJobCreatedAtMs: clock.now() - 50_000 });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(10_000);
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'APPROVED', issueDelayed: true, pg: 'TOSS' } });
  });

  test('FR011_TIMEOUT이면 다시 읽어 그때의 상태로 답하고 다시 기다리지 않는다(아직 기다릴 상태여도)', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(25_000);
    put({ status: 'RESERVED' });
    waiters.wake('TIMEOUT');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'RESERVED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`, `read:${ORDER}`]);
  });

  test('FR011_TIMEOUT 뒤 다시 읽었더니 바로 답할 상태가 됐으면 그 상태로 답한다', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(25_000);
    put({ status: 'CONFIRMED' });
    waiters.wake('TIMEOUT');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } });
  });

  test('FR011_깬 뒤 다시 읽었더니 주문이 없으면 404다', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    reads.views.clear();
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 404 });
  });

  test('FR011_CHANGED로 깼는데 다시 읽어도 기다릴 상태면 처음 기다림의 끝까지 남은 몫만 다시 기다린다(전체가 25초를 넘지 않는다)', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(5_000);
    waiters.wake('CHANGED');
    await waiters.arrived(2);
    // 정본 모호: 25초 − 흐른 5초 = 20초(남은 시간 22초 − 1초 = 21초가 아니다)
    // 다시 기다릴 때도 처음 기다림 시작 때 본문과 견준다
    expect(waiters.waits[1]).toEqual({ orderId: ORDER, deadlineMs: 20_000, signal: undefined, since: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } });
    clock.advance(20_000);
    waiters.wake('TIMEOUT');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`, `read:${ORDER}`, `wait:${ORDER}:20000`, `read:${ORDER}`]);
  });

  test('FR011_남은 시간이 25초보다 짧으면 다시 기다림도 그 남은 시간 − 1초 안이다', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(10_000, clock) }));
    await waiters.arrived(1);
    expect(waiters.waits[0]!.deadlineMs).toBe(9_000);
    clock.advance(4_000);
    waiters.wake('CHANGED');
    await waiters.arrived(2);
    expect(waiters.waits[1]!.deadlineMs).toBe(5_000);
    clock.advance(5_000);
    waiters.wake('TIMEOUT');
    await run;
  });

  test('FR011_CHANGED로 깼는데 기다릴 상태이고 남은 기다림이 0이면 다시 기다리지 않고 그때의 상태로 답한다', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(25_000);
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } });
    expect(waiters.waits).toHaveLength(1);
  });

  test('FR011_ABORTED(브라우저가 닫음)면 다시 읽지 않고 마지막 기다림 본문으로 200을 돌려준다', async () => {
    put({ status: 'RESERVED' });
    const ac = new AbortController();
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock), signal: ac.signal }));
    await waiters.arrived(1);
    ac.abort();
    put({ status: 'CONFIRMED' });
    waiters.wake('ABORTED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'RESERVED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`]);
  });

  test('FR011_깬 뒤 다시 읽기가 던지면 그대로 던진다(기다리던 요청도 500)', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    reads.fail = new Error('DB down after wait');
    waiters.wake('CHANGED');
    await expect(run).rejects.toThrow('DB down after wait');
  });

  test('M2_기다리는 상태 사이를 옮기기만 하면(RESERVED → APPROVED, issueDelayed 거짓) notify로 깨도 남은 몫을 다시 기다린다', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(2_000);
    put({ status: 'APPROVED', issueJobCreatedAtMs: clock.now(), issueJobAttempts: 0 });
    waiters.wake('CHANGED');
    await waiters.arrived(2);
    expect(waiters.waits[1]).toMatchObject({ deadlineMs: 23_000, since: { status: 'RESERVED', issueDelayed: false } });
    clock.advance(23_000);
    waiters.wake('TIMEOUT');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'APPROVED', issueDelayed: false, pg: 'TOSS' } });
  });

  test('M2_APPROVED를 기다리다가 다시 시도 중(시도 1·마지막 오류)이 되어 깨면 issueDelayed 참으로 곧바로 답한다', async () => {
    put({ status: 'APPROVED', issueJobCreatedAtMs: clock.now(), issueJobAttempts: 0 });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    put({ status: 'APPROVED', issueJobCreatedAtMs: clock.now(), issueJobAttempts: 1, issueJobLastError: 'UNAVAILABLE' });
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'APPROVED', issueDelayed: true, pg: 'TOSS' } });
    expect(waiters.waits).toHaveLength(1);
  });

  test('M2_시작 때 이미 issueDelayed 참이던 APPROVED는 깨도 그대로면 다시 기다린다(짧은 폴링이 되지 않게)', async () => {
    put({ status: 'APPROVED', issueJobCreatedAtMs: clock.now() - 61_000, issueJobAttempts: 2, issueJobLastError: 'UNAVAILABLE' });
    const run = useCase.execute(cmd({ deadline: Deadline.after(27_000, clock) }));
    await waiters.arrived(1);
    clock.advance(1_000);
    waiters.wake('CHANGED');
    await waiters.arrived(2);
    expect(waiters.waits[1]!.deadlineMs).toBe(24_000);
    put({ status: 'CONFIRMED' });
    waiters.wake('CHANGED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } });
  });

  test('M4_묶음 조회가 넘긴 주문 모습(CHANGED의 view)이 있으면 다시 읽지 않고 그 모습으로 답한다', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    // 읽기 표는 그대로(RESERVED) 두고, 넘긴 모습만 FAILED다: 다시 읽었다면 RESERVED였을 것이다
    waiters.wake({ wake: 'CHANGED', view: view({ status: 'FAILED', failureReason: 'CARD_DECLINED' }) });
    expect(await run).toStrictEqual({ status: 200, body: { status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`]);
  });

  test('M4_넘긴 모습이 남의 계정이면 404다(넘긴 모습도 계정을 다시 본다)', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    waiters.wake({ wake: 'CHANGED', view: view({ status: 'CONFIRMED', accountId: OTHER_ACCOUNT }) });
    expect(await run).toStrictEqual({ status: 404 });
  });

  test('M4_notify로 깬 경우(모습 없음)는 한 건 다시 읽는다', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    put({ status: 'UNKNOWN' });
    waiters.wake({ wake: 'CHANGED' });
    expect(await run).toStrictEqual({ status: 200, body: { status: 'UNKNOWN', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`, `read:${ORDER}`]);
  });

  test('M4_STOPPED(파드가 멈춤)면 ABORTED처럼 다시 읽지 않고 마지막 본문으로 200이다', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    put({ status: 'CONFIRMED' });
    waiters.wake('STOPPED');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`]);
  });

  test('M3_기다림 표가 가득 차(FULL) 기다리지 않으면 다시 읽지 않고 지금 상태로 200이다', async () => {
    put({ status: 'RESERVED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    waiters.wake('FULL');
    expect(await run).toStrictEqual({ status: 200, body: { status: 'RESERVED', issueDelayed: false, pg: 'TOSS' } });
    expect(calls).toEqual([`read:${ORDER}`, `wait:${ORDER}:25000`]);
  });

  test('FR011_쓰임새는 notify·readMany를 부르지 않는다(깨우기는 기다림 표·결제 결과 처리기의 몫)', async () => {
    put({ status: 'ACCEPTED' });
    const run = useCase.execute(cmd());
    await waiters.arrived(1);
    put({ status: 'CONFIRMED' });
    waiters.wake('CHANGED');
    await run;
    expect(waiters.notifies).toEqual([]);
    expect(calls.filter((c) => c.startsWith('readMany'))).toEqual([]);
    expect(waiters.pendingCount).toBe(0);
  });
});

describe('GetPaymentStatus: 핫패스 구간 진단(BAT-027, HOT-462)', () => {
  test('BAT027_ 기다린 요청은 read·wait·total 구간과 ok 결과를 남긴다', async () => {
    const registry = new PlatformMetrics('purchase-svc').registry;
    const hotPath = new HotPathMetrics('purchase-svc').register(registry);
    const uc = new GetPaymentStatus({ reads, waiters, clock, hotPath });
    put({ status: 'ACCEPTED' });

    const run = uc.execute(cmd());
    await waiters.arrived(1);
    waiters.wake('TIMEOUT');
    await run;

    const text = await registry.metrics();
    expect(text).toContain('hot_path_outcomes_total{service="purchase-svc",outcome="ok"} 1');
    expect(text).toContain('hot_path_stage_seconds_count{service="purchase-svc",stage="payment.status.total"} 1');
    expect(text).toContain('hot_path_stage_seconds_count{service="purchase-svc",stage="payment.status.wait"} 1');
    expect(text).toContain('hot_path_stage_seconds_count{service="purchase-svc",stage="payment.status.read"} 2');
    expect(text).not.toContain(ORDER);
  });

  test('BAT-029: 기다림 표 묶음 조회 전용 풀은 일반 프로필 2연결이다', () => {
    expect(paymentStatusWaitTableDatabaseOptions('postgres://x')).toMatchObject({ profile: 'general', max: 2, applicationName: 'purchase-svc-payment-status' });
  });
});
