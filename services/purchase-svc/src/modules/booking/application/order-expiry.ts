// 결제하지 않은 주문의 만료 판정(ADR-0107 결정 1·2, docs/features/payment.md §3 T5·T6, BUILD_ORDER PRF-172 설계 1·2·4).
// check(주문 ID, 까닭)의 차례:
//   ① OrderExpiryStore.order로 주문과 그 좌석을 읽는다(잠그지 않는다). 없거나 열린 주문이 아니면 NOT_OPEN
//   ② 트랜잭션을 열기 전에 OrderExpiryInventory로 세션 끝남·홀드 남음을 읽는다(DB 잠금을 쥔 채 좌석 Redis를 부르지 않는다)
//   ③ 세션이 아직이거나 홀드가 남았으면 트랜잭션을 열지 않고 NOT_YET(SESSION·HOLD)이다(판정 한 건마다 쓰기 연결을 쥐지 않게, 2026-11-09 코드 리뷰)
//   ④ OrderExpiryStore.expireIfDue: 주문 행을 잠그고 상태와 결제 시도를 다시 보며 T5·T6과 이력·Outbox EXPIRED를 같은 트랜잭션에 쓴다. EXPIRED면 지표 expired(까닭)
// 세 사건을 받는 자리(설계 2):
//   - onSessionEnded: 그 세션의 열린 주문을 찾아(인덱스 purchase_order_session_idx) 주문마다 check(session)
//   - onHoldsExpired: 고리 한 번에 한 문장으로 열린 주문을 찾아(hold_id 유일 인덱스) 찾은 주문마다 check(hold)
//   - 결제 시도 만료: 안전망 반복(order-expiry-sweep.ts)이 바뀐 시도의 주문마다 check(attempt)
// 고리는 기다리지 않고 던지지 않는다(요청·만료 반복을 막지 않게). 파드마다 동시 ORDER_EXPIRY_CONCURRENCY(4개 [가정])까지 돌고, 실패는 지표와 경고다(지표는 건마다, 경고는 파드마다 1분에 한 줄 [가정]. 안전망이 받친다).
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1).
// 구현에서 정한 것(정본에 없다):
// - 고리의 일은 파드마다 줄 하나에 먼저 온 차례로 선다. 주문 찾기와 주문 판정이 각각 한 건이다(찾기가 끝나면 판정을 줄 뒤에 넣는다. 그래서 한 사건에 주문이 많아도 동시 수는 상한 안이다).
// - 대기 줄 상한은 ORDER_EXPIRY_QUEUE_LIMIT(10,000건 [가정])이고, 넘치면 새 일을 버린다(건마다 failure('hook'), 경고는 넘친 동안 한 줄. 줄이 상한의 절반으로 줄면 다시 경고할 수 있다). 버린 주문은 안전망이 받친다.
// - stop은 아직 시작하지 않은 일을 버리고 돌던 일만 기다린다(SIGTERM 유예 안에 끝나게. 버린 주문은 안전망이 받친다).
// - check의 실패는 어느 단계(주문 읽기·좌석 Redis·트랜잭션)에서 났든 failure('check')를 한 번 올린다. 고리에서 났으면 failure('hook')도 함께 오른다.
import { LogGate, type WallClock } from '../domain/log-gate.js';
import { ORDER_EXPIRY_ACTOR, ORDER_EXPIRY_CONCURRENCY, ORDER_EXPIRY_HOOK_WARN_INTERVAL_MS, ORDER_EXPIRY_QUEUE_LIMIT, type OrderExpiryTrigger } from '../domain/order-expiry.js';
import type {
  OrderExpiryHoldsExpired,
  OrderExpiryInventory,
  OrderExpiryLogger,
  OrderExpiryOutcome,
  OrderExpirySessionEnded,
  OrderExpirySignals,
  OrderExpiryStore,
} from '../domain/ports.js';

/** 만료 판정이 쓰는 포트와 설정 */
export interface OrderExpiryDeps {
  store: Pick<OrderExpiryStore, 'order' | 'openOrdersOfSession' | 'openOrdersOfHolds' | 'expireIfDue'>;
  inventory: OrderExpiryInventory;
  signals: OrderExpirySignals;
  /** 고리 실패 경고의 문이 보는 시계 */
  clock: WallClock;
  logger?: OrderExpiryLogger;
  /** 고리의 파드마다 동시 처리 수(기본 ORDER_EXPIRY_CONCURRENCY 4개 [가정]) */
  concurrency?: number;
  /** 고리의 대기 줄 상한(기본 ORDER_EXPIRY_QUEUE_LIMIT 10,000건 [가정]) */
  queueLimit?: number;
}

type HookJob = () => Promise<void>;

/** 오류의 이름만(오류 글에 키 이름·계정 ID가 들어 있을 수 있어 싣지 않는다, ASVS 16.2.5) */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** 만료 판정. onSessionEnded·onHoldsExpired는 this에 묶어 inventory 고리로 넘긴다(시작 파일이 잇는다) */
export class OrderExpiry {
  readonly #concurrency: number;
  readonly #queueLimit: number;
  readonly #queue: HookJob[] = [];
  readonly #running = new Set<Promise<void>>();
  readonly #hookWarnGate: LogGate;
  #stopped = false;
  /** 대기 줄이 넘쳤다는 경고를 이미 남겼나 */
  #overflowWarned = false;

  constructor(private readonly deps: OrderExpiryDeps) {
    this.#concurrency = deps.concurrency ?? ORDER_EXPIRY_CONCURRENCY;
    this.#queueLimit = deps.queueLimit ?? ORDER_EXPIRY_QUEUE_LIMIT;
    this.#hookWarnGate = new LogGate(deps.clock, ORDER_EXPIRY_HOOK_WARN_INTERVAL_MS);
  }

  /**
   * 주문 하나의 세 조건을 보고, 모두 끝났으면 EXPIRED로 끝낸다(머리 주석 ①~④).
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(부르는 쪽이 경고 뒤 안전망에 맡긴다)
   */
  async check(orderId: string, trigger: OrderExpiryTrigger): Promise<OrderExpiryOutcome> {
    const { store, inventory, signals } = this.deps;
    try {
      const o = await store.order(orderId);
      if (!o) return { status: 'NOT_OPEN' };
      if (o.status !== 'CREATED' && o.status !== 'AUTHENTICATED') return { status: 'NOT_OPEN', current: o.status };
      const [sessionEnded, holdRemains] = await Promise.all([
        inventory.sessionEnded(o.purchaseSessionId),
        inventory.holdRemains({ eventId: o.eventId, purchaseSessionId: o.purchaseSessionId, accountId: o.accountId, holdId: o.holdId, ...(o.seatIds ? { seatIds: o.seatIds } : {}) }),
      ]);
      if (!sessionEnded) return { status: 'NOT_YET', reason: 'SESSION' };
      if (holdRemains) return { status: 'NOT_YET', reason: 'HOLD' };
      const outcome = await store.expireIfDue({ orderId, sessionEnded, holdRemains, actor: ORDER_EXPIRY_ACTOR });
      if (outcome.status === 'EXPIRED') signals.expired(trigger);
      return outcome;
    } catch (err) {
      signals.failure('check');
      throw err;
    }
  }

  /** 구매 세션 종료 고리(기다리지 않고 던지지 않는다) */
  onSessionEnded(e: OrderExpirySessionEnded): void {
    this.#enqueue(async () => {
      const orders = await this.deps.store.openOrdersOfSession(e.purchaseSessionId);
      for (const o of orders) this.#enqueueCheck(o.orderId, 'session');
    });
  }

  /** 홀드 만료 고리(기다리지 않고 던지지 않는다) */
  onHoldsExpired(e: OrderExpiryHoldsExpired): void {
    const holdIds = [...new Set(e.holdIds)];
    if (holdIds.length === 0) return;
    this.#enqueue(async () => {
      const orders = await this.deps.store.openOrdersOfHolds(holdIds);
      for (const o of orders) this.#enqueueCheck(o.orderId, 'hold');
    });
  }

  /** 새 고리 일을 받지 않고(줄에서 기다리던 일도 버린다) 돌던 일을 기다린다(SIGTERM). 두 번 불러도 된다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#queue.length = 0;
    while (this.#running.size > 0) await Promise.all(this.#running);
  }

  #enqueueCheck(orderId: string, trigger: OrderExpiryTrigger): void {
    this.#enqueue(async () => {
      await this.check(orderId, trigger);
    }, orderId);
  }

  #enqueue(job: HookJob, orderId?: string): void {
    if (this.#stopped) return;
    if (this.#queue.length >= this.#queueLimit) {
      this.deps.signals.failure('hook');
      if (!this.#overflowWarned) {
        this.#overflowWarned = true;
        this.deps.logger?.warn({ queueLimit: this.#queueLimit }, '주문 만료 고리의 대기 줄이 넘쳐 새 일을 버린다(안전망이 받친다)');
      }
      return;
    }
    this.#queue.push(() => job().catch((err: unknown) => this.#hookFailed(err, orderId)));
    this.#pump();
  }

  #pump(): void {
    while (this.#running.size < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift()!;
      if (this.#overflowWarned && this.#queue.length <= this.#queueLimit / 2) this.#overflowWarned = false;
      // 다음 차례에 돌린다(고리를 부른 쪽을 막지 않고, 일이 곧바로 던져도 부른 쪽에 나가지 않는다)
      const running: Promise<void> = Promise.resolve()
        .then(job)
        .catch(() => undefined) // 지표·로거가 던져도 처리되지 않은 거부로 파드가 죽지 않게 한다
        .finally(() => {
          this.#running.delete(running);
          this.#pump();
        });
      this.#running.add(running);
    }
  }

  #hookFailed(err: unknown, orderId?: string): void {
    this.deps.signals.failure('hook');
    if (this.#hookWarnGate.allow()) this.deps.logger?.warn({ errorName: errorName(err), ...(orderId ? { orderId } : {}) }, '주문 만료 고리 실패(안전망이 받친다)');
  }
}
