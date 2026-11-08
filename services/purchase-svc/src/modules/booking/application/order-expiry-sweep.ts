// 주문 만료 안전망 반복(ADR-0107 결정 2, docs/data.md §5.1 '주문 만료 안전망', BUILD_ORDER PRF-172 설계 3). 사건이 빠졌을 때를 받친다.
// purchase 릴레이 프로세스의 Lease 리더가 10분 [가정]마다 틱 하나를 돈다(SeatRebuildLoop와 같은 모양. 플랫폼 LeaderLoop의 name·start·stop을 맞춘다):
//   ① READY 결제 시도 만료: 만든 지 하루 안이고 40분 [가정] 지난 READY 행을 500건씩 EXPIRED로 바꾸고(OrderExpiryStore.expireReadyAttempts) 바뀐 시도의 주문마다 check(attempt)
//   ② 주문 안전망: 만든 지 하루 안이고 90분 [가정] 지난 열린 주문을 500건씩 ID 차례로 읽어(openOrderBatch) 주문마다 check(sweep). 세 조건을 그대로 본다
// 하루 넘은 열린 주문은 이 반복이 보지 않는다(매일 정비 일 order-expiry-stale이 다시 판정하고 게이지 openStale을 낸다, order-expiry-stale.ts).
// 한 단계의 실패는 다음 단계를 막지 않는다(경고 한 줄과 지표). DB는 서비스 역할(다시 만들기와 같은 풀), Redis는 좌석 Redis다. 이 층은 어댑터를 가져오지 않는다(architecture §3.1).
// 구현에서 정한 것(정본에 없다):
// - 첫 틱은 켠 뒤 바로 돈다. 리더면 틱 사이에 10분 [가정] 쉬고, 리더가 아니면 5초 [가정] 뒤 다시 본다(켠 직후에는 아직 Lease를 잡지 못해 첫 틱이 not_leader로 끝나므로 10분을 자면 첫 일이 그만큼 늦는다, 2026-11-09 코드 리뷰). 한 틱의 범위는 틱을 시작할 때의 시각으로 고정한다.
// - 리더가 아닌 틱은 게이지 openStale을 0으로 둔다(전 리더 파드가 옛 값을 계속 내지 않게. 게이지는 파드 사이 최댓값으로 본다, 2026-11-09 코드 리뷰).
// - 주문 판정은 묶음 안에서 하나씩 차례로 돈다(주문 판정이 시도·주문 행을 잠그므로 한 파드의 안전망이 DB를 몰아치지 않게).
// - check가 던진 실패는 경고 한 줄과 보고의 failed다(지표는 check가 failure('check')로 이미 올렸다). 경고에는 주문 ID·오류 이름만 싣는다.
import type { Clock } from '@peaket/platform';
import { ORDER_EXPIRY_ATTEMPT_TTL_MS, ORDER_EXPIRY_BATCH, ORDER_EXPIRY_LOOKBACK_MS, ORDER_EXPIRY_NOT_LEADER_RECHECK_MS, ORDER_EXPIRY_SWEEP_AGE_MS, ORDER_EXPIRY_SWEEP_INTERVAL_MS, type OrderExpiryTrigger } from '../domain/order-expiry.js';
import type { OrderExpiryLogger, OrderExpirySignals, OrderExpiryStore } from '../domain/ports.js';
import type { OrderExpiry } from './order-expiry.js';

/** 안전망 반복이 쓰는 포트와 설정 */
export interface OrderExpirySweepDeps {
  store: Pick<OrderExpiryStore, 'expireReadyAttempts' | 'openOrderBatch'>;
  expiry: Pick<OrderExpiry, 'check'>;
  /** 리더 확인(릴레이 프로세스의 LeaderLoopContext.leader) */
  leader: { isLeader(): boolean };
  clock: Clock;
  signals: OrderExpirySignals;
  logger?: OrderExpiryLogger;
  /** 틱 간격(기본 ORDER_EXPIRY_SWEEP_INTERVAL_MS 10분 [가정]) */
  tickMs?: number;
  /** 묶음 하나의 행 수(기본 ORDER_EXPIRY_BATCH 500건, 그보다 크면 500) */
  batchSize?: number;
  /** 시험이 바꾸는 쉬기(기본 setTimeout, signal이 끊기면 바로 풀린다) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** 틱 하나의 보고. 리더가 아니면 { skipped: 'not_leader' }(아무것도 부르지 않았다) */
export type OrderExpirySweepReport =
  | {
      /** EXPIRED로 바꾼 READY 결제 시도 수 */
      readonly attemptsExpired: number;
      /** check를 부른 주문 수(①·② 합) */
      readonly checked: number;
      /** 만료로 끝낸 주문 수 */
      readonly expired: number;
      /** check가 던졌거나 단계가 실패한 수 */
      readonly failed: number;
    }
  | { readonly skipped: 'not_leader' };

/** 틱 도중 쌓아 가는 보고 */
interface TickTally {
  attemptsExpired: number;
  checked: number;
  expired: number;
  failed: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** 오류의 이름만(오류 글에 키 이름·계정 ID가 들어 있을 수 있어 싣지 않는다, ASVS 16.2.5) */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

export class OrderExpirySweep {
  /** 리더 반복 이름(LeaderLoop.name) */
  readonly name = 'order-expiry-sweep';
  readonly #tickMs: number;
  readonly #limit: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly deps: OrderExpirySweepDeps) {
    this.#tickMs = deps.tickMs ?? ORDER_EXPIRY_SWEEP_INTERVAL_MS;
    this.#limit = Math.min(deps.batchSize ?? ORDER_EXPIRY_BATCH, ORDER_EXPIRY_BATCH);
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * 한 번 돈다(머리 주석 ①·②). 위 오류는 보고에 담고 던지지 않는다(리더 확인 자체가 던지면 그대로 던진다: 반복이 경고 뒤 이어 돈다).
   * @param signal 멈춤 신호(반복이 stop()에서 끊는다. 직접 부를 때는 없어도 된다). 끊기면 남은 묶음을 보지 않고 그때까지의 보고를 돌려준다
   */
  async tick(signal?: AbortSignal): Promise<OrderExpirySweepReport> {
    if (!this.deps.leader.isLeader()) {
      this.deps.signals.openStale(0);
      return { skipped: 'not_leader' };
    }
    const nowMs = this.deps.clock.now();
    const tally: TickTally = { attemptsExpired: 0, checked: 0, expired: 0, failed: 0 };
    await this.#expireAttempts(nowMs, tally, signal);
    if (!signal?.aborted) await this.#sweepOrders(nowMs, tally, signal);
    return tally;
  }

  /** 반복을 켠다(기다리지 않는다, 이미 켰으면 아무것도 하지 않는다). 틱이 예상 밖 오류로 끝나도 반복은 끝나지 않는다 */
  start(): void {
    if (this.#loop) return;
    this.#abort = new AbortController();
    this.#loop = this.#run(this.#abort.signal);
  }

  /** 멈춤 신호를 보내고 돌던 틱을 기다린다. 켜지 않았거나 두 번 불러도 된다 */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
  }

  async #expireAttempts(nowMs: number, tally: TickTally, signal: AbortSignal | undefined): Promise<void> {
    const { store, signals } = this.deps;
    const range = { createdFromMs: nowMs - ORDER_EXPIRY_LOOKBACK_MS, createdBeforeMs: nowMs - ORDER_EXPIRY_ATTEMPT_TTL_MS, limit: this.#limit };
    try {
      for (;;) {
        const attempts = await store.expireReadyAttempts(range);
        tally.attemptsExpired += attempts.length;
        await this.#checkAll(
          attempts.map((a) => a.orderId),
          'attempt',
          tally,
          signal,
        );
        if (attempts.length < this.#limit || signal?.aborted) return;
      }
    } catch (err) {
      tally.failed += 1;
      signals.failure('attempt');
      this.#warn({ errorName: errorName(err) }, '주문 만료 안전망: READY 결제 시도 만료 실패');
    }
  }

  async #sweepOrders(nowMs: number, tally: TickTally, signal: AbortSignal | undefined): Promise<void> {
    const { store, signals } = this.deps;
    const range = { createdFromMs: nowMs - ORDER_EXPIRY_LOOKBACK_MS, createdBeforeMs: nowMs - ORDER_EXPIRY_SWEEP_AGE_MS, limit: this.#limit };
    try {
      let afterId: string | undefined;
      for (;;) {
        const orders = await store.openOrderBatch(afterId === undefined ? range : { ...range, afterId });
        await this.#checkAll(
          orders.map((o) => o.orderId),
          'sweep',
          tally,
          signal,
        );
        if (orders.length < this.#limit || signal?.aborted) return;
        // NOT_YET으로 남는 주문이 있어 상태가 아니라 커서로 앞으로 간다
        afterId = orders.at(-1)!.orderId;
      }
    } catch (err) {
      tally.failed += 1;
      signals.failure('sweep');
      this.#warn({ errorName: errorName(err) }, '주문 만료 안전망: 주문 묶음 읽기 실패');
    }
  }

  /** 주문마다 차례로 check. 한 주문의 실패는 다음 주문을 막지 않는다. 멈춤 신호가 끊기면 남은 주문을 보지 않는다 */
  async #checkAll(orderIds: readonly string[], trigger: OrderExpiryTrigger, tally: TickTally, signal: AbortSignal | undefined): Promise<void> {
    for (const orderId of orderIds) {
      if (signal?.aborted) return;
      tally.checked += 1;
      try {
        const outcome = await this.deps.expiry.check(orderId, trigger);
        if (outcome.status === 'EXPIRED') tally.expired += 1;
      } catch (err) {
        tally.failed += 1;
        // 다음 틱이 이 주문을 다시 볼지는 길마다 다르다: 주문 안전망은 다음 틱에 다시 읽지만, 시도 만료 길은 시도가 이미 EXPIRED라 다시 잡히지 않고 만든 지 90분 [가정] 뒤 주문 안전망이 본다
        this.#warn({ orderId, errorName: errorName(err) }, '주문 만료 안전망: 주문 판정 실패(주문 안전망이 다시 본다)');
      }
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let report: OrderExpirySweepReport | undefined;
      try {
        report = await this.tick(signal);
      } catch (err) {
        // 예상 밖 오류도 반복을 끝내지 않는다(처리되지 않은 거부로 프로세스가 죽지 않게)
        this.deps.signals.failure('sweep');
        this.#warn({ errorName: errorName(err) }, '주문 만료 안전망: 틱이 예상 밖 오류로 끝났다');
      }
      if (signal.aborted) break;
      const restMs = report !== undefined && 'skipped' in report ? Math.min(this.#tickMs, ORDER_EXPIRY_NOT_LEADER_RECHECK_MS) : this.#tickMs;
      try {
        await this.#sleep(restMs, signal);
      } catch {
        // 쉬기가 던져도(바꿔 끼운 쉬기) 반복을 끝내지 않는다. 멈춤 신호는 위 조건이 본다
      }
    }
  }

  /** 로그 한 줄. 로거가 없거나 던져도 반복·보고를 바꾸지 않는다 */
  #warn(obj: object, msg: string): void {
    try {
      this.deps.logger?.warn(obj, msg);
    } catch {
      // 로그 실패는 안전망을 막지 않는다
    }
  }
}
