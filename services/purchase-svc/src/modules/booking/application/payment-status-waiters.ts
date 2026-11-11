// 결제 결과 long polling의 파드 안 기다림 표(docs/features/payment.md §2 '알림 길', BUILD_ORDER PRF-166).
// 파드마다 '기다리는 주문 → 기다리는 요청들' 표를 두고, 200ms [가정]마다 표에 있는 주문들을 한 번에 기본 키로 읽어(readMany, 한 번에 최대 500건 [가정],
// 넘으면 500건씩 나눠 같은 틱에 차례로 읽는다 [정함]) 깨울 모습이 된 요청을 깨운다. 깨울지는 요청마다 기다림 시작 때 본문(since)과 견준다
// (paymentStatusWakes: 바로 답할 상태가 됐거나 APPROVED의 issueDelayed가 거짓 → 참, 리뷰 고침 M2). 깨울 때 그때 읽은 모습을 함께 넘긴다(리뷰 고침 M4).
// 같은 파드의 결제 결과 처리기·Saga가 그 주문을 바로 답할 상태로 바꾸면 notify로 곧바로 깨운다(모습 없음). Redis Pub/Sub은 두지 않는다.
// 기다리는 요청 수는 게이지 purchase_payment_status_waiters로, 묶음 조회 실패는 카운터 purchase_payment_status_poll_failures_total로 낸다.
// 파드당 기다림 상한 2,000건 [가정]: 차면 표에 넣지 않고 곧바로 FULL(쓰임새가 지금 상태로 200, 리뷰 고침 M3).
// 기다린 지 5초 [가정]가 넘은 주문은 1초 [가정]마다만 묻는다(리뷰 고침 M3). 주문의 나이는 그 주문을 가장 늦게 기다리기 시작한 요청부터 잰다
// [정함: 새로 온 탭은 빠른 간격을 받는다]. 나이는 deps.clock의 단조 시계로 잰다.
// 정함(정본에 없다): 반복은 OrderSagaRunner처럼 만든 때(시작 파일, 요청 밖)의 비동기 맥락에서 돈다(요청의 남은 시간·요청 로그를 물려받지 않게).
//   묶음 조회가 던지면(DB 장애) 아무도 깨우지 않고 다음 틱에 다시 읽는다(기다리는 요청은 제 시간이 다 되면 TIMEOUT으로 깬다).
//   표가 비었거나 물을 차례인 주문이 없으면 DB에 가지 않는다. 틱이 겹치지 않는다(앞 틱이 끝나지 않았으면 이번 틱을 건너뛴다).
//   멈춘 뒤의 wait()은 표에 넣지 않고 곧바로 TIMEOUT이다(리뷰 고침 L1).
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
import { AsyncResource } from 'node:async_hooks';
import { type Clock, type HotPathMetrics, timeHotPath } from '@peaket/platform';
import {
  PAYMENT_STATUS_BATCH_MAX,
  PAYMENT_STATUS_POLL_INTERVAL_MS,
  PAYMENT_STATUS_SLOW_AFTER_MS,
  PAYMENT_STATUS_SLOW_POLL_INTERVAL_MS,
  PAYMENT_STATUS_WAITERS_MAX,
  type PaymentStatusBody,
  type PaymentStatusView,
  paymentStatusWakes,
} from '../domain/payment-status.js';
import type { PaymentStatusReads, PaymentStatusSignals, PaymentStatusWaiters, PaymentStatusWaitOptions, PaymentStatusWakeUp } from '../domain/ports.js';

/** 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 전역 setInterval·setTimeout(unref)) */
export interface WaitTableTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 기다림 표가 쓰는 포트와 설정 */
export interface PaymentStatusWaitTableDeps {
  reads: PaymentStatusReads;
  /** 깨울지 정하는 '지금'(issueDelayed 판정, 벽시계 now)과 주문의 나이(단조 시계) */
  clock: Clock;
  /** 기다리는 요청 수 게이지·묶음 조회 실패 카운터. 없으면 내지 않는다 */
  signals?: PaymentStatusSignals;
  /** 없으면 전역 타이머(unref) */
  timer?: WaitTableTimer;
  /** 묶음 조회 간격(기본 PAYMENT_STATUS_POLL_INTERVAL_MS 200ms [가정]) */
  pollIntervalMs?: number;
  /** 묶음 조회 한 번의 주문 수 상한(기본 PAYMENT_STATUS_BATCH_MAX 500건 [가정]) */
  batchMax?: number;
  /** 함께 붙잡는 기다림 수 상한(기본 PAYMENT_STATUS_WAITERS_MAX 2,000건 [가정]) */
  maxWaiters?: number;
  /** 묶음 조회 구간 진단(BAT-029). 없으면 계측하지 않는다 */
  hotPath?: HotPathMetrics;
}

/** 기다리는 요청 하나 */
interface Waiter {
  readonly orderId: string;
  readonly resolve: (w: PaymentStatusWakeUp) => void;
  /** 기다림 시작 때 본문(깨울지 견줄 기준) */
  readonly since: PaymentStatusBody | undefined;
  /** 이미 깼다(다른 길로 다시 깨지 않는다) */
  done: boolean;
  /** 시간 다 됨 타이머 손잡이 */
  timeout: unknown;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/** 표의 주문 한 칸 */
interface OrderEntry {
  readonly waiters: Set<Waiter>;
  /** 이 주문을 가장 늦게 기다리기 시작한 때(단조 시계 ms). 주문의 나이는 여기부터 잰다 */
  newestStartMono: number;
  /** 마지막으로 물은 때(단조 시계 ms). 아직 묻지 않았으면 undefined */
  lastPolledMono: number | undefined;
}

/**
 * 파드 안 기다림 표. start()로 200ms 반복을 켜고 stop()으로 끈다(돌던 틱을 기다리고, 남은 기다림은 모두 STOPPED로 깨운다, 리뷰 고침 M4).
 * 켜지 않았어도 wait·notify는 된다(시간이 다 되거나 notify로만 깬다).
 */
export class PaymentStatusWaitTable implements PaymentStatusWaiters {
  /** 주문 ID → 그 주문 칸(기다리는 요청이 없으면 칸을 지운다) */
  readonly #byOrder = new Map<string, OrderEntry>();
  #count = 0;
  /** 반복 타이머의 손잡이(켜지 않았으면 undefined) */
  #handle: unknown;
  #stopped = false;
  /** 돌고 있는 틱(겹치지 않게 하나만, stop이 기다린다) */
  #ticking: Promise<void> | undefined;
  /** 만든 때(시작 파일, 요청 밖)의 비동기 맥락. 틱이 요청 맥락(남은 시간·요청 로그)을 물려받지 않게 이 맥락에서 돈다 */
  readonly #scope = new AsyncResource('PaymentStatusWaitTable');

  constructor(private readonly deps: PaymentStatusWaitTableDeps) {}

  /** 묶음 조회 반복을 켠다(이미 켰거나 멈춘 뒤면 아무것도 하지 않는다) */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => this.#tick(), this.deps.pollIntervalMs ?? PAYMENT_STATUS_POLL_INTERVAL_MS);
  }

  /** 반복을 끄고 돌던 틱을 기다린 뒤, 남은 기다림을 모두 STOPPED로 깨운다(쓰임새가 다시 읽지 않고 마지막 본문으로 답한다) */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    if (this.#ticking) await this.#ticking;
    for (const entry of [...this.#byOrder.values()]) for (const w of [...entry.waiters]) this.#finish(w, { wake: 'STOPPED' });
  }

  /** PaymentStatusWaiters.wait(포트 설명). 표에 넣을 때·뺄 때 게이지를 고친다 */
  wait(orderId: string, deadlineMs: number, o: PaymentStatusWaitOptions = {}): Promise<PaymentStatusWakeUp> {
    const { signal, since } = o;
    // 이미 끊겼으면 표에 넣지 않는다
    if (signal?.aborted) return Promise.resolve({ wake: 'ABORTED' });
    // 멈춘 뒤에는 표에 넣지 않는다: 쓰임새가 한 번 다시 읽어 그때의 상태로 답한다(리뷰 고침 L1)
    if (this.#stopped) return Promise.resolve({ wake: 'TIMEOUT' });
    // 파드의 기다림 상한에 찼다: 기다리지 않는다(쓰임새가 지금 상태로 200, 리뷰 고침 M3)
    if (this.#count >= (this.deps.maxWaiters ?? PAYMENT_STATUS_WAITERS_MAX)) return Promise.resolve({ wake: 'FULL' });
    return new Promise<PaymentStatusWakeUp>((resolve) => {
      const w: Waiter = { orderId, resolve, since, done: false, timeout: undefined, signal, onAbort: () => this.#finish(w, { wake: 'ABORTED' }) };
      const nowMono = this.deps.clock.monotonicMs();
      let entry = this.#byOrder.get(orderId);
      if (!entry) {
        entry = { waiters: new Set(), newestStartMono: nowMono, lastPolledMono: undefined };
        this.#byOrder.set(orderId, entry);
      }
      // 새 요청이 오면 주문의 나이를 다시 잰다(빠른 간격으로 돌아간다) [정함]
      entry.newestStartMono = nowMono;
      entry.waiters.add(w);
      this.#count += 1;
      w.timeout = this.#timer().setTimeout(() => this.#finish(w, { wake: 'TIMEOUT' }), Math.max(0, deadlineMs));
      signal?.addEventListener('abort', w.onAbort, { once: true });
      this.#gauge();
    });
  }

  /** PaymentStatusWaiters.notify(포트 설명) */
  notify(orderId: string): void {
    const entry = this.#byOrder.get(orderId);
    if (!entry) return;
    for (const w of [...entry.waiters]) this.#finish(w, { wake: 'CHANGED' });
  }

  /**
   * 묶음 조회 한 번(반복의 틱 하나. 시험이 직접 부른다): 물을 차례인 주문(기다린 지 5초 전이면 늘, 넘으면 마지막으로 물은 때부터 1초가 지났을 때)을
   * batchMax건씩 readMany로 읽어, 깨울 모습(paymentStatusWakes, 요청마다 since와 견줌)이 된 요청과 그사이 없어진 주문 [정함]의 요청을
   * CHANGED로 깨운다(읽은 모습을 함께 넘긴다. 없어진 주문은 모습 없음). 깨운 요청 수를 돌려준다. 던지지 않는다(읽기 실패는 0, 실패 카운터 하나)
   */
  async pollOnce(): Promise<number> {
    if (this.#byOrder.size === 0) return 0;
    const done = this.deps.hotPath?.start('payment.status.poll');
    try {
      return await this.#pollDue();
    } finally {
      done?.();
    }
  }

  async #pollDue(): Promise<number> {
    const nowMono = this.deps.clock.monotonicMs();
    const ids: string[] = [];
    for (const [id, entry] of this.#byOrder) {
      if (!this.#due(entry, nowMono)) continue;
      entry.lastPolledMono = nowMono;
      ids.push(id);
    }
    if (ids.length === 0) return 0;
    const max = this.deps.batchMax ?? PAYMENT_STATUS_BATCH_MAX;
    const views = new Map<string, PaymentStatusView>();
    try {
      // 같은 틱에 차례로 읽는다(한 번에 batchMax건 넘게 묻지 않는다)
      await timeHotPath(this.deps.hotPath, 'payment.status.poll.read', async () => {
        for (let i = 0; i < ids.length; i += max) {
          for (const v of await this.deps.reads.readMany(ids.slice(i, i + max))) views.set(v.orderId, v);
        }
      });
    } catch {
      // purchase DB를 잠시 못 쓴다: 아무도 깨우지 않고 다음 틱에 다시 읽는다
      this.#signal((s) => s.paymentStatusPollFailed());
      return 0;
    }
    const now = this.deps.clock.now();
    let woken = 0;
    for (const id of ids) {
      const entry = this.#byOrder.get(id);
      if (!entry) continue;
      const view = views.get(id);
      for (const w of [...entry.waiters]) {
        if (view && !paymentStatusWakes(view, w.since, now)) continue;
        if (this.#finish(w, view ? { wake: 'CHANGED', view } : { wake: 'CHANGED' })) woken += 1;
      }
    }
    return woken;
  }

  /** 지금 기다리는 요청 수(게이지 값과 같다) */
  size(): number {
    return this.#count;
  }

  // ---- 안쪽 ----

  #timer(): WaitTableTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }

  /** 이번 틱에 물을 차례인가: 아직 묻지 않았거나, 기다린 지 5초 전이거나, 마지막으로 물은 때부터 1초가 지났다 */
  #due(entry: OrderEntry, nowMono: number): boolean {
    if (entry.lastPolledMono === undefined) return true;
    if (nowMono - entry.newestStartMono < PAYMENT_STATUS_SLOW_AFTER_MS) return true;
    return nowMono - entry.lastPolledMono >= PAYMENT_STATUS_SLOW_POLL_INTERVAL_MS;
  }

  /** 틱 하나: 앞 틱이 아직 돌면 건너뛴다. 멈춘 뒤에는 돌지 않는다 */
  #tick(): void {
    if (this.#stopped || this.#ticking) return;
    this.#ticking = this.#scope
      .runInAsyncScope(() => this.pollOnce())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#ticking = undefined;
      });
  }

  /** 기다림 하나를 끝낸다(표에서 빼고 타이머·끊김 듣기를 지운다). 이미 끝났으면 false(처음 까닭 그대로) */
  #finish(w: Waiter, up: PaymentStatusWakeUp): boolean {
    if (w.done) return false;
    w.done = true;
    const entry = this.#byOrder.get(w.orderId);
    if (entry?.waiters.delete(w)) {
      this.#count -= 1;
      if (entry.waiters.size === 0) this.#byOrder.delete(w.orderId);
    }
    this.#timer().clearTimeout(w.timeout);
    w.signal?.removeEventListener('abort', w.onAbort);
    this.#gauge();
    w.resolve(up);
    return true;
  }

  /** 게이지를 지금 기다리는 요청 수로 고친다 */
  #gauge(): void {
    const n = this.#count;
    this.#signal((s) => s.paymentStatusWaiters(n));
  }

  /** 지표 포트는 던지지 않기로 했지만, 던져도 기다림을 막지 않는다 */
  #signal(f: (s: PaymentStatusSignals) => void): void {
    if (!this.deps.signals) return;
    try {
      f(this.deps.signals);
    } catch {
      // 삼킨다
    }
  }
}

/** 기본 타이머(프로세스를 붙잡지 않게 unref) */
const DEFAULT_TIMER: WaitTableTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
