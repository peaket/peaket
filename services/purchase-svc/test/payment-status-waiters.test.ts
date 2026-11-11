// 결제 결과 long polling의 파드 안 기다림 표(application/payment-status-waiters.ts PaymentStatusWaitTable, BUILD_ORDER PRF-166) 단위 시험.
// 정본: docs/features/payment.md §2 '결제 결과 long polling의 첫 구현' '알림 길'(200ms [가정] 묶음 조회, 기본 키로 한 번에 최대 500건 [가정],
// 같은 파드의 결제 결과 처리기·Saga가 바꾸면 곧바로 깨움, Redis Pub/Sub 없음), docs/verification.md §4.1 long polling 행(게이지 purchase_payment_status_waiters).
// 타이머는 시험이 손으로 부르는 대역이다: setInterval은 등록만 하고(fireIntervals로 부른다), setTimeout은 가상 시각으로 elapse가 부른다.
//
// 정본 모호(뼈대 주석의 [정함]을 따른다):
// - 넘으면 batchMax건씩 나눠 같은 틱에 차례로 읽는다. 같은 주문을 여러 요청이 기다리면 그 주문 ID는 한 번만 묻는다.
// - 그사이 없어진 주문(readMany 결과에 없음)도 깨운다(CHANGED, 쓰임새가 다시 읽어 404로 답한다).
// - 묶음 조회가 던지면 아무도 깨우지 않고 0을 돌려주며 던지지 않는다. 다음 틱에 다시 읽는다.
// - 표가 비면 DB에 가지 않는다. 틱이 겹치지 않는다(앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다).
// - stop()은 반복을 끄고 돌던 틱을 기다린 뒤 남은 기다림을 모두 TIMEOUT으로 깨운다. 멈춘 뒤 start()는 아무것도 하지 않는다.
// - 게이지는 표에 넣을 때·뺄 때 지금 기다리는 요청 수(size())로 고친다.
// 리뷰 고침(2026-11-05, 새 정본):
// - M2 깨울지는 요청마다 기다림 시작 때 본문(since)과 견준다: 바로 답할 상태가 됐거나 APPROVED의 issueDelayed가 거짓 → 참으로 바뀌었으면 깨운다.
// - M3 파드당 기다림 상한(기본 2,000건 [가정]): 가득 차면 표에 넣지 않고 곧바로 FULL. 기다린 지 5초 [가정]가 넘은 주문은 1초 [가정]마다만 묻는다
//   (주문의 나이 = 그 주문을 가장 늦게 기다리기 시작한 요청부터, [정함]: 새로 온 탭은 빠른 간격을 받는다). 나이는 deps.clock의 단조 시계로 잰다.
// - M4 묶음 조회가 깨울 때 읽은 주문 모습을 CHANGED와 함께 넘긴다(notify·없어진 주문은 모습 없음). stop()은 남은 기다림을 STOPPED로 깨운다.
// - L1 멈춘 뒤의 wait()은 표에 넣지 않고 곧바로 TIMEOUT. L6 묶음 조회 실패는 signals.paymentStatusPollFailed()로 한 번씩 센다.
import { fakeClock, type HotPathMetrics } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  type PaymentStatusBody,
  type PaymentStatusReads,
  type PaymentStatusSignals,
  type PaymentStatusView,
  type PaymentStatusWake,
  PaymentStatusWaitTable,
  type PaymentStatusWaitTableDeps,
  type WaitTableTimer,
} from '../src/modules/booking/index.js';
import { ACCOUNT, NOW } from './order-cases.js';

/** n번째 주문 ID(소문자 UUID) */
const idOf = (n: number) => `0190f3a1-7c2e-7f00-8000-${n.toString(16).padStart(12, '0')}`;
const A = idOf(1);
const B = idOf(2);
const C = idOf(3);

/** 손으로 부르는 타이머: 가상 시각 now 위의 setTimeout과 등록만 하는 setInterval */
class ManualTimer implements WaitTableTimer {
  now = 0;
  #next = 1;
  intervals = new Map<number, { fn: () => void; ms: number }>();
  timeouts = new Map<number, { fn: () => void; due: number }>();
  setInterval(fn: () => void, ms: number): unknown {
    const h = this.#next++;
    this.intervals.set(h, { fn, ms });
    return h;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const h = this.#next++;
    this.timeouts.set(h, { fn, due: this.now + ms });
    return h;
  }
  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }
  /** 가상 시각을 ms만큼 당기고, 그때까지 된 setTimeout을 차례로 부른다 */
  elapse(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.timeouts].filter(([, t]) => t.due <= this.now).sort((x, y) => x[1].due - y[1].due)[0];
      if (!due) return;
      this.timeouts.delete(due[0]);
      due[1].fn();
    }
  }
  /** 등록된 반복을 한 번씩 부른다(틱 하나) */
  fireIntervals(): void {
    for (const i of [...this.intervals.values()]) i.fn();
  }
}

/** 메모리 읽기: 주문 모습 표. readMany는 부른 ID 목록을 적고, gate를 두면 그 약속이 풀릴 때까지 답하지 않는다 */
class MemoryReads implements PaymentStatusReads {
  views = new Map<string, PaymentStatusView>();
  manyCalls: string[][] = [];
  reads: string[] = [];
  fail: Error | undefined;
  gate: Promise<void> | undefined;
  async read(orderId: string): Promise<PaymentStatusView | undefined> {
    this.reads.push(orderId);
    return this.views.get(orderId);
  }
  async readMany(orderIds: readonly string[]): Promise<PaymentStatusView[]> {
    this.manyCalls.push([...orderIds]);
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    if (orderIds.length > 500) throw new RangeError('500건을 넘음');
    return orderIds.flatMap((id) => (this.views.has(id) ? [this.views.get(id)!] : []));
  }
}

const flush = async () => {
  for (let k = 0; k < 10; k += 1) await new Promise<void>((r) => setImmediate(r));
};

let clock: ReturnType<typeof fakeClock>;
let timer: ManualTimer;
let reads: MemoryReads;
let gauge: number[];
let pollFailures: number;
let signals: PaymentStatusSignals;
let table: PaymentStatusWaitTable;

const make = (over: Partial<PaymentStatusWaitTableDeps> = {}) => new PaymentStatusWaitTable({ reads, clock, signals, timer, ...over });
const put = (id: string, over: Partial<PaymentStatusView> = {}) => reads.views.set(id, { orderId: id, accountId: ACCOUNT, status: 'ACCEPTED', pg: 'TOSS', ...over });

/** 기다림 하나와 그 결과(끝나기 전에는 undefined). p는 깬 까닭으로 풀린다 */
function waitOn(id: string, deadlineMs = 25_000, signal?: AbortSignal, since?: PaymentStatusBody) {
  const box: { wake: PaymentStatusWake | undefined; view: PaymentStatusView | undefined } = { wake: undefined, view: undefined };
  const p = table.wait(id, deadlineMs, { ...(signal ? { signal } : {}), ...(since ? { since } : {}) }).then((w) => {
    box.wake = w.wake;
    box.view = w.view;
    return w.wake;
  });
  return Object.assign(box, { p });
}

beforeEach(() => {
  clock = fakeClock({ now: NOW });
  timer = new ManualTimer();
  reads = new MemoryReads();
  gauge = [];
  pollFailures = 0;
  signals = { paymentStatusWaiters: (n) => void gauge.push(n), paymentStatusPollFailed: () => void (pollFailures += 1) };
  table = make();
});

describe('반복(start·stop)', () => {
  test('FR011_start()는 200ms [가정] 반복 하나를 켜고, 두 번 불러도 하나다. pollIntervalMs로 바꿀 수 있다', () => {
    table.start();
    table.start();
    expect([...timer.intervals.values()].map((i) => i.ms)).toEqual([200]);
    const t2 = new ManualTimer();
    make({ timer: t2, pollIntervalMs: 50 }).start();
    expect([...t2.intervals.values()].map((i) => i.ms)).toEqual([50]);
  });

  test('M4_stop()은 반복을 끄고 남은 기다림을 모두 STOPPED로 깨운다(다시 읽지 않고 마지막 본문으로 답하게). 멈춘 뒤 start()는 아무것도 하지 않는다', async () => {
    table.start();
    put(A);
    put(B);
    const a = waitOn(A);
    const b = waitOn(B);
    await table.stop();
    expect(await a.p).toBe('STOPPED');
    expect(await b.p).toBe('STOPPED');
    expect(timer.intervals.size).toBe(0);
    expect(table.size()).toBe(0);
    expect(gauge.at(-1)).toBe(0);
    table.start();
    expect(timer.intervals.size).toBe(0);
  });

  test('FR011_stop()은 돌던 틱(묶음 조회)이 끝나기를 기다린다', async () => {
    let open!: () => void;
    reads.gate = new Promise<void>((r) => (open = r));
    put(A);
    const a = waitOn(A);
    table.start();
    timer.fireIntervals();
    await flush();
    expect(reads.manyCalls).toHaveLength(1);
    let stopped = false;
    const s = table.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
    open();
    await s;
    expect(stopped).toBe(true);
    expect(await a.p).toBe('STOPPED');
  });

  test('L1_멈춘 뒤의 wait()은 표에 넣지 않고 곧바로 TIMEOUT이다(게이지도 그대로)', async () => {
    await table.stop();
    const before = gauge.length;
    expect(await table.wait(A, 25_000)).toEqual({ wake: 'TIMEOUT' });
    expect(table.size()).toBe(0);
    expect(timer.timeouts.size).toBe(0);
    expect(gauge.length).toBe(before);
  });

  test('FR011_틱이 겹치지 않는다: 앞 묶음 조회가 끝나지 않았으면 다음 틱은 DB에 가지 않는다', async () => {
    let open!: () => void;
    reads.gate = new Promise<void>((r) => (open = r));
    put(A);
    const a = waitOn(A);
    table.start();
    timer.fireIntervals();
    await flush();
    timer.fireIntervals();
    timer.fireIntervals();
    await flush();
    expect(reads.manyCalls).toHaveLength(1);
    reads.gate = undefined;
    open();
    await flush();
    timer.fireIntervals();
    await flush();
    expect(reads.manyCalls).toHaveLength(2);
    expect(a.wake).toBeUndefined();
    await table.stop();
  });

  test('FR011_반복의 틱이 바로 답할 상태가 된 주문을 깨운다(시작 파일이 켠 경우)', async () => {
    put(A);
    const a = waitOn(A);
    table.start();
    put(A, { status: 'CONFIRMED' });
    timer.fireIntervals();
    await flush();
    expect(await a.p).toBe('CHANGED');
    await table.stop();
  });
});

describe('묶음 조회(pollOnce)', () => {
  test('FR011_표가 비면 DB에 가지 않고 0이다', async () => {
    expect(await table.pollOnce()).toBe(0);
    expect(reads.manyCalls).toEqual([]);
  });

  test('FR011_기다리는 주문들을 readMany 한 번으로 읽어 바로 답할 상태가 된 것만 CHANGED로 깨우고, 깨운 요청 수를 돌려준다', async () => {
    for (const id of [A, B, C]) put(id);
    const a = waitOn(A);
    const b = waitOn(B);
    const c = waitOn(C);
    put(A, { status: 'CONFIRMED' });
    put(C, { status: 'FAILED', failureReason: 'CARD_DECLINED' });
    expect(await table.pollOnce()).toBe(2);
    expect(reads.manyCalls.map((ids) => [...ids].sort())).toEqual([[A, B, C].sort()]);
    await flush();
    expect([a.wake, b.wake, c.wake]).toEqual(['CHANGED', undefined, 'CHANGED']);
    // M4: 깨운 요청에 그때 읽은 주문 모습을 넘긴다(깨어난 요청이 다시 읽지 않게)
    expect(a.view).toStrictEqual(reads.views.get(A));
    expect(c.view).toStrictEqual(reads.views.get(C));
    expect(table.size()).toBe(1);
    // 읽기 한 건(read)은 부르지 않는다
    expect(reads.reads).toEqual([]);
  });

  test('M2_깨울지는 요청마다 기다림 시작 때 본문(since)과 견준다: issueDelayed 거짓에서 시작한 요청만 거짓 → 참으로 바뀐 APPROVED에 깬다', async () => {
    put(A, { status: 'APPROVED', issueJobCreatedAtMs: clock.now(), issueJobAttempts: 0 });
    const fresh = waitOn(A, 25_000, undefined, { status: 'APPROVED', issueDelayed: false, pg: 'TOSS' });
    const already = waitOn(A, 25_000, undefined, { status: 'APPROVED', issueDelayed: true, pg: 'TOSS' });
    expect(await table.pollOnce()).toBe(0);
    put(A, { status: 'APPROVED', issueJobCreatedAtMs: clock.now(), issueJobAttempts: 1, issueJobLastError: 'UNAVAILABLE' });
    expect(await table.pollOnce()).toBe(1);
    await flush();
    expect([fresh.wake, already.wake]).toEqual(['CHANGED', undefined]);
    expect(fresh.view).toMatchObject({ status: 'APPROVED', issueJobAttempts: 1 });
    expect(table.size()).toBe(1);
    // 바로 답할 상태가 되면 둘째도 깬다
    put(A, { status: 'CONFIRMED' });
    expect(await table.pollOnce()).toBe(1);
    expect(await already.p).toBe('CHANGED');
  });

  test('M2_기다리는 상태 사이를 옮기기만 하면(ACCEPTED → RESERVED → issueDelayed 거짓 APPROVED) 깨우지 않는다', async () => {
    put(A);
    const a = waitOn(A, 25_000, undefined, { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' });
    put(A, { status: 'RESERVED' });
    expect(await table.pollOnce()).toBe(0);
    put(A, { status: 'APPROVED', issueJobCreatedAtMs: clock.now(), issueJobAttempts: 0 });
    expect(await table.pollOnce()).toBe(0);
    await flush();
    expect(a.wake).toBeUndefined();
  });

  test('FR011_기다릴 상태(ACCEPTED·RESERVED·늦지 않은 APPROVED)는 깨우지 않는다', async () => {
    put(A, { status: 'RESERVED' });
    put(B, { status: 'APPROVED', issueJobCreatedAtMs: clock.now() - 59_999 });
    put(C, { status: 'ACCEPTED' });
    const ws = [waitOn(A), waitOn(B), waitOn(C)];
    expect(await table.pollOnce()).toBe(0);
    await flush();
    expect(ws.map((w) => w.wake)).toEqual([undefined, undefined, undefined]);
    expect(table.size()).toBe(3);
  });

  test('ADR0106_APPROVED는 deps.clock으로 승인 뒤 60초가 지나면 깨운다', async () => {
    put(A, { status: 'APPROVED', issueJobCreatedAtMs: clock.now() - 59_000 });
    const a = waitOn(A);
    expect(await table.pollOnce()).toBe(0);
    clock.advance(1_000);
    expect(await table.pollOnce()).toBe(1);
    expect(await a.p).toBe('CHANGED');
  });

  test('FR011_같은 주문을 기다리는 요청 둘(탭 둘)은 주문 ID를 한 번만 묻고 둘 다 깨운다(깨운 수 2)', async () => {
    put(A);
    const a1 = waitOn(A);
    const a2 = waitOn(A);
    expect(table.size()).toBe(2);
    put(A, { status: 'CONFIRMED' });
    expect(await table.pollOnce()).toBe(2);
    expect(reads.manyCalls).toEqual([[A]]);
    expect([await a1.p, await a2.p]).toEqual(['CHANGED', 'CHANGED']);
    expect(table.size()).toBe(0);
  });

  test('FR011_그사이 없어진 주문(readMany 결과에 없음)도 깨운다(넘길 모습이 없어 쓰임새가 다시 읽는다)', async () => {
    put(A);
    const a = waitOn(A);
    reads.views.delete(A);
    expect(await table.pollOnce()).toBe(1);
    expect(await a.p).toBe('CHANGED');
    expect(a.view).toBeUndefined();
  });

  test('FR011_500건 [가정]을 넘으면 500건씩 나눠 같은 틱에 읽는다(1201건 → 500·500·201), 모든 주문을 한 번씩 묻는다', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => idOf(100 + i));
    const ws = ids.map((id) => {
      put(id);
      return waitOn(id);
    });
    put(ids[1200]!, { status: 'CONFIRMED' });
    put(ids[0]!, { status: 'CONFIRMED' });
    expect(await table.pollOnce()).toBe(2);
    expect(reads.manyCalls.map((x) => x.length).sort((x, y) => y - x)).toEqual([500, 500, 201]);
    expect(reads.manyCalls.flat().sort()).toEqual([...ids].sort());
    await flush();
    expect(ws.filter((w) => w.wake === 'CHANGED')).toHaveLength(2);
    await table.stop();
  });

  test('FR011_batchMax로 한 번의 건수를 바꿀 수 있다(5건, 상한 2 → 2·2·1)', async () => {
    table = make({ batchMax: 2 });
    const ids = [A, B, C, idOf(4), idOf(5)];
    for (const id of ids) {
      put(id);
      void waitOn(id);
    }
    await table.pollOnce();
    expect(reads.manyCalls.map((x) => x.length).sort()).toEqual([1, 2, 2]);
    await table.stop();
  });

  test('FR011_L6_묶음 조회가 던지면 아무도 깨우지 않고 0이며 던지지 않는다. 실패를 한 번 센다. 다음 틱에 다시 읽어 깨운다', async () => {
    put(A, { status: 'CONFIRMED' });
    const a = waitOn(A);
    reads.fail = new Error('DB down');
    expect(await table.pollOnce()).toBe(0);
    await flush();
    expect(a.wake).toBeUndefined();
    expect(table.size()).toBe(1);
    expect(pollFailures).toBe(1);
    reads.fail = undefined;
    expect(await table.pollOnce()).toBe(1);
    expect(await a.p).toBe('CHANGED');
    expect(pollFailures).toBe(1);
  });

  test('L6_묶음이 여럿이어도 한 틱의 실패는 한 번 센다. 표가 비어 묻지 않은 틱은 세지 않는다', async () => {
    table = make({ batchMax: 2 });
    for (const id of [A, B, C]) {
      put(id);
      void waitOn(id);
    }
    reads.fail = new Error('DB down');
    expect(await table.pollOnce()).toBe(0);
    expect(pollFailures).toBe(1);
    await table.stop();
    reads.fail = undefined;
    expect(await table.pollOnce()).toBe(0);
    expect(pollFailures).toBe(1);
  });

  test('M3_기다린 지 5초 [가정]가 넘은 주문은 1초 [가정]마다만 묻는다(그 전에는 틱마다). 나이는 deps.clock의 단조 시계다', async () => {
    put(A);
    const a = waitOn(A);
    const asked = () => reads.manyCalls.filter((ids) => ids.includes(A)).length;
    await table.pollOnce();
    expect(asked()).toBe(1);
    clock.advance(4_800);
    await table.pollOnce();
    expect(asked()).toBe(2);
    // 기다린 지 5초: 마지막으로 물은 때(4.8초)부터 1초가 지나야 다시 묻는다
    clock.advance(200);
    await table.pollOnce();
    clock.advance(200);
    await table.pollOnce();
    expect(asked()).toBe(2);
    clock.advance(600);
    await table.pollOnce();
    expect(asked()).toBe(3);
    clock.advance(200);
    await table.pollOnce();
    expect(asked()).toBe(3);
    expect(a.wake).toBeUndefined();
  });

  test('M3_느려진 주문을 새 요청이 기다리기 시작하면 다시 틱마다 묻는다(주문의 나이 = 가장 늦게 온 요청부터) [정함]', async () => {
    put(A);
    void waitOn(A);
    await table.pollOnce();
    clock.advance(6_000);
    await table.pollOnce();
    const asked = () => reads.manyCalls.filter((ids) => ids.includes(A)).length;
    expect(asked()).toBe(2);
    clock.advance(200);
    await table.pollOnce();
    expect(asked()).toBe(2);
    void waitOn(A);
    clock.advance(200);
    await table.pollOnce();
    expect(asked()).toBe(3);
  });

  test('M3_느린 주문이 묻는 차례가 아니면 그 틱에 젊은 주문만 묻는다(모두 차례가 아니면 DB에 가지 않는다)', async () => {
    put(A);
    put(B);
    void waitOn(A);
    await table.pollOnce();
    clock.advance(5_000);
    await table.pollOnce();
    clock.advance(200);
    void waitOn(B);
    const before = reads.manyCalls.length;
    await table.pollOnce();
    expect(reads.manyCalls.slice(before)).toEqual([[B]]);
    clock.advance(200);
    await table.pollOnce();
    expect(reads.manyCalls.slice(before)).toEqual([[B], [B]]);
    // B가 끝나면, A 차례가 아닌 틱에는 DB에 가지 않는다
    table.notify(B);
    const n = reads.manyCalls.length;
    clock.advance(200);
    await table.pollOnce();
    expect(reads.manyCalls.length).toBe(n);
  });

  test('FR011_끝난 기다림(시간 다 됨·notify)의 주문은 다음 묶음 조회에서 묻지 않는다', async () => {
    put(A);
    put(B);
    void waitOn(A, 1_000);
    void waitOn(B);
    timer.elapse(1_000);
    table.notify(B);
    await flush();
    expect(await table.pollOnce()).toBe(0);
    expect(reads.manyCalls).toEqual([]);
  });
});

describe('notify·시간·끊김', () => {
  test('FR011_notify는 그 주문을 기다리는 요청을 모두 곧바로 CHANGED로 깨운다(DB에 가지 않는다, 모습 없음). 다른 주문은 그대로다', async () => {
    put(A);
    put(B);
    const a1 = waitOn(A);
    const a2 = waitOn(A);
    const b = waitOn(B);
    table.notify(A);
    expect([await a1.p, await a2.p]).toEqual(['CHANGED', 'CHANGED']);
    expect([a1.view, a2.view]).toEqual([undefined, undefined]);
    await flush();
    expect(b.wake).toBeUndefined();
    expect(reads.manyCalls).toEqual([]);
    expect(reads.reads).toEqual([]);
    expect(table.size()).toBe(1);
  });

  test('FR011_기다리는 요청이 없는 주문의 notify는 아무것도 하지 않고 던지지 않는다', () => {
    expect(() => table.notify(A)).not.toThrow();
    expect(() => table.notify('not-a-uuid')).not.toThrow();
    expect(table.size()).toBe(0);
  });

  test('FR011_deadlineMs가 지나면 TIMEOUT으로 깨고 표에서 빠진다(그 전에는 기다린다)', async () => {
    put(A);
    const a = waitOn(A, 5_000);
    timer.elapse(4_999);
    await flush();
    expect(a.wake).toBeUndefined();
    timer.elapse(1);
    expect(await a.p).toBe('TIMEOUT');
    expect(table.size()).toBe(0);
  });

  test('FR011_요청마다 제 시간으로 끝난다(같은 주문 1초·3초)', async () => {
    put(A);
    const short = waitOn(A, 1_000);
    const long = waitOn(A, 3_000);
    timer.elapse(1_000);
    expect(await short.p).toBe('TIMEOUT');
    await flush();
    expect(long.wake).toBeUndefined();
    expect(table.size()).toBe(1);
    timer.elapse(2_000);
    expect(await long.p).toBe('TIMEOUT');
  });

  test('FR011_signal이 끊기면 ABORTED로 깨고 표에서 빠진다. 같은 주문의 다른 요청은 그대로다', async () => {
    put(A);
    const ac = new AbortController();
    const a = waitOn(A, 25_000, ac.signal);
    const other = waitOn(A);
    ac.abort();
    expect(await a.p).toBe('ABORTED');
    await flush();
    expect(other.wake).toBeUndefined();
    expect(table.size()).toBe(1);
  });

  test('FR011_이미 끊긴 signal이면 바로 ABORTED이고 표에 남지 않는다', async () => {
    put(A);
    const ac = new AbortController();
    ac.abort();
    expect(await table.wait(A, 25_000, { signal: ac.signal })).toEqual({ wake: 'ABORTED' });
    expect(table.size()).toBe(0);
    expect(await table.pollOnce()).toBe(0);
    expect(reads.manyCalls).toEqual([]);
  });

  test('FR011_한 번 깬 기다림은 다른 길(시간·notify·끊김)로 다시 깨지 않는다(처음 까닭 그대로)', async () => {
    put(A);
    const ac = new AbortController();
    const a = waitOn(A, 1_000, ac.signal);
    table.notify(A);
    timer.elapse(1_000);
    ac.abort();
    expect(await a.p).toBe('CHANGED');
    expect(table.size()).toBe(0);
  });

  test('FR011_켜지 않았어도 wait·notify·시간은 된다', async () => {
    put(A);
    const a = waitOn(A, 2_000);
    const b = waitOn(A);
    table.notify(A);
    expect(await a.p).toBe('CHANGED');
    expect(await b.p).toBe('CHANGED');
    const c = waitOn(A, 2_000);
    timer.elapse(2_000);
    expect(await c.p).toBe('TIMEOUT');
  });
});

describe('size와 게이지(purchase_payment_status_waiters)', () => {
  test('FR011_size()는 지금 기다리는 요청 수이고, 넣을 때·뺄 때 게이지가 그 값으로 고쳐진다', async () => {
    put(A);
    put(B);
    expect(table.size()).toBe(0);
    const a = waitOn(A, 1_000);
    expect(table.size()).toBe(1);
    expect(gauge.at(-1)).toBe(1);
    const b1 = waitOn(B);
    const b2 = waitOn(B);
    expect(table.size()).toBe(3);
    expect(gauge.at(-1)).toBe(3);
    table.notify(B);
    await b1.p;
    await b2.p;
    expect(table.size()).toBe(1);
    expect(gauge.at(-1)).toBe(1);
    timer.elapse(1_000);
    await a.p;
    expect(table.size()).toBe(0);
    expect(gauge.at(-1)).toBe(0);
    // 게이지 값은 늘 0 이상 3 이하였다
    expect(gauge.every((n) => n >= 0 && n <= 3)).toBe(true);
  });

  test('M3_기다림 상한(maxWaiters)에 차면 새 기다림은 표에 넣지 않고 곧바로 FULL이다. 빠지면 다시 받는다', async () => {
    table = make({ maxWaiters: 3 });
    put(A);
    const ws = [waitOn(A), waitOn(A), waitOn(B)];
    expect(table.size()).toBe(3);
    const timeoutsBefore = timer.timeouts.size;
    expect(await table.wait(C, 25_000)).toEqual({ wake: 'FULL' });
    expect(table.size()).toBe(3);
    expect(timer.timeouts.size).toBe(timeoutsBefore);
    expect(gauge.at(-1)).toBe(3);
    table.notify(B);
    expect(await ws[2]!.p).toBe('CHANGED');
    const c = waitOn(C);
    expect(table.size()).toBe(3);
    expect(c.wake).toBeUndefined();
  });

  test('M3_기다림 상한의 기본은 2,000건 [가정]이다', async () => {
    for (let i = 0; i < 2_000; i += 1) void waitOn(idOf(10_000 + i));
    expect(table.size()).toBe(2_000);
    expect(await table.wait(A, 25_000)).toEqual({ wake: 'FULL' });
    await table.stop();
  });

  test('FR011_signals가 없으면 게이지를 내지 않아도 된다(던지지 않는다)', async () => {
    table = make({ signals: undefined });
    put(A);
    const a = waitOn(A);
    expect(table.size()).toBe(1);
    table.notify(A);
    expect(await a.p).toBe('CHANGED');
  });
});

describe('계측(BAT-029)', () => {
  test('pollOnce는 payment.status.poll·payment.status.poll.read 구간을 남긴다', async () => {
    const stages: string[] = [];
    const hotPath = {
      start: (stage: string) => {
        stages.push(stage);
        return () => undefined;
      },
    } as unknown as HotPathMetrics;
    table = make({ hotPath });
    put(A, { status: 'CONFIRMED' });
    const a = waitOn(A);
    await table.pollOnce();
    expect(await a.p).toBe('CHANGED');
    expect(stages).toEqual(['payment.status.poll', 'payment.status.poll.read']);
  });
});
