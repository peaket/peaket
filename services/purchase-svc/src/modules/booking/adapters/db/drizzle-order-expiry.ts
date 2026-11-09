// 결제하지 않은 주문의 만료 저장소(OrderExpiryStore, ADR-0107 결정 1·2, docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현', docs/data.md §5.1 '주문 만료 안전망', BUILD_ORDER PRF-172 설계 1·3·4).
// - expireIfDue(트랜잭션 하나, read committed, 잠금 차례는 결제 접수와 같은 주문 행 → 결제 시도 행): 주문 행을 FOR UPDATE로 잠그고 → 활성 결제 시도(READY이고 만든 지 40분 [가정] 안)를 보고 →
//   expiryDecision이 EXPIRE면 DrizzleOrderStore.transition으로 T5·T6(이력·Outbox EXPIRED)을 쓴다. 결제 접수(T3·T4)도 주문 행을 먼저 잠그므로 둘 가운데 하나만 이긴다.
//   세션·홀드는 입력으로 받는다(트랜잭션 안에서 좌석 Redis를 부르지 않는다).
// - expireReadyAttempts: 결제 시도 행만 바꾸는 한 문장이다(주문 행을 잡지 않으므로 잠금 차례를 거스르지 않는다). 그 주문의 만료는 부르는 쪽이 check로 다시 본다.
//   ID 범위로 고르면서 created_at도 경계와 견준다(ID의 시각과 created_at이 어긋난 행을 접수가 받아 주는 동안 만료시키지 않게, 2026-11-09 코드 리뷰).
// - openOrderBatch·staleOrderBatch: 기본 키(UUIDv7) 범위로 읽고 상태는 Filter다. 새 인덱스를 쓰지 않는다(docs/data.md §5.1).
// - openOrdersOfHolds: 고리 한 번에 한 문장이다(holdId마다 쓰기 DB를 부르지 않는다, docs/data.md §5.1 '만료 고리의 열린 주문 찾기').
// 주문 상태를 바꾸는 SQL은 쓰지 않는다(상태 SQL은 drizzle-orders.ts의 전이 함수에만, test/order-status-sql.test.ts).
// 구현에서 정한 것(정본에 없다):
// - 트랜잭션은 다른 실행기와 같이 READ COMMITTED·문장 시간 한도 5초 [가정]이다(요청 밖이다). 활성 결제 시도는 주문 행 잠금 아래에서 읽기만 한다(시도 행을 잠그지 않는다. 바꾸는 쪽인 결제 접수는 주문 행에서 줄을 선다).
// - 묶음 읽기의 범위는 createdFromMs ≤ createdBeforeMs여야 한다(같으면 빈 범위라 아무것도 없다).
// - 운영 API 파드는 핫패스 풀이 아니라 고리 전용 일반 풀(orderExpiryDatabaseOptions, 연결 4개 [가정] = 고리 동시 수)을 넘긴다(만료가 몰려도 홀드·주문 요청이 풀 대기 초과를 받지 않게). 릴레이 프로세스는 서비스 역할 풀을 넘긴다.
import { type Clock, type Database, type DatabaseOptions, type DbTransaction, uuidLowerBound } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { expiryDecision, ORDER_EXPIRY_ATTEMPT_TTL_MS, ORDER_EXPIRY_BATCH, ORDER_EXPIRY_CONCURRENCY, ORDER_EXPIRY_STALE_BATCH } from '../../domain/order-expiry.js';
import type { OrderStatus } from '../../domain/order.js';
import type { OrderExpiredAttempt, OrderExpiryInput, OrderExpiryOrder, OrderExpiryOutcome, OrderExpiryRange, OrderExpiryStore } from '../../domain/ports.js';
import { SAGA_STATEMENT_TIMEOUT_MS } from '../../domain/saga.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

/**
 * 사건 고리(API 파드)의 purchase DB(PEAKET_DATABASE_URL) 풀 설정(main.ts가 createDatabase에 넘기고 종료 때 닫는다. 구현에서 정한 것).
 * 핫패스 풀과 따로인 일반 풀(연결을 기다린다)·연결은 고리 동시 수만큼(4개 [가정])·이름 purchase-svc-order-expiry다(ticketIssueDatabaseOptions와 같은 꼴)
 */
export function orderExpiryDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: ORDER_EXPIRY_CONCURRENCY, applicationName: 'purchase-svc-order-expiry' };
}

export interface DrizzleOrderExpiryOptions {
  database: Database;
  /** 주문 전이 함수(T5·T6) */
  store: DrizzleOrderStore;
  /** 활성 결제 시도 40분 판정의 '지금' */
  clock: Clock;
}

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;

/** 주문 표에서 읽는 칸 */
const ORDER_COLUMNS = sql`id, account_id, event_id, purchase_session_id, hold_id, status`;
/** 열린 주문의 상태 조건 */
const IS_OPEN = sql.raw(`status in ('CREATED', 'AUTHENTICATED')`);

type OrderExpiryDbRow = {
  id: string;
  account_id: string;
  event_id: string;
  purchase_session_id: string;
  hold_id: string;
  status: string;
  seat_ids?: string[];
};

function orderOf(row: OrderExpiryDbRow): OrderExpiryOrder {
  return {
    orderId: row.id,
    accountId: row.account_id,
    eventId: row.event_id,
    purchaseSessionId: row.purchase_session_id,
    holdId: row.hold_id,
    status: row.status as OrderStatus,
    ...(row.seat_ids ? { seatIds: row.seat_ids } : {}),
  };
}

/** 시각(ms)이 UUIDv7 경계로 바꿀 수 있는 값인가 */
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function assertRange(r: OrderExpiryRange, maxLimit = ORDER_EXPIRY_BATCH): void {
  if (!isMs(r.createdFromMs) || !isMs(r.createdBeforeMs) || r.createdFromMs > r.createdBeforeMs) throw new RangeError('만료 묶음의 범위는 0 이상 정수이고 시작이 끝보다 뒤일 수 없다');
  if (!Number.isInteger(r.limit) || r.limit < 1 || r.limit > maxLimit) throw new RangeError(`만료 묶음의 limit은 1~${maxLimit}의 정수다`);
}

/** OrderExpiryStore의 purchase DB 구현(위 머리 주석의 차례) */
export class DrizzleOrderExpiry implements OrderExpiryStore {
  constructor(private readonly o: DrizzleOrderExpiryOptions) {}

  async order(orderId: string): Promise<OrderExpiryOrder | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`
      select ${ORDER_COLUMNS},
             array(select i.seat_id::text from order_item i where i.order_id = purchase_order.id order by i.line_no) as seat_ids
        from purchase_order
       where id = ${orderId}::uuid`);
    const row = r.rows[0] as OrderExpiryDbRow | undefined;
    return row ? orderOf(row) : undefined;
  }

  async openOrdersOfSession(purchaseSessionId: string): Promise<OrderExpiryOrder[]> {
    const r = await this.o.database.db.execute(sql`
      select ${ORDER_COLUMNS} from purchase_order where purchase_session_id = ${purchaseSessionId} and ${IS_OPEN}`);
    return (r.rows as unknown as OrderExpiryDbRow[]).map(orderOf);
  }

  async openOrdersOfHolds(holdIds: readonly string[]): Promise<OrderExpiryOrder[]> {
    const ids = holdIds.filter(isUuid);
    if (ids.length === 0) return [];
    const r = await this.o.database.db.execute(sql`
      select ${ORDER_COLUMNS} from purchase_order where hold_id = any(${`{${ids.join(',')}}`}::uuid[]) and ${IS_OPEN}`);
    return (r.rows as unknown as OrderExpiryDbRow[]).map(orderOf);
  }

  async expireIfDue(input: OrderExpiryInput): Promise<OrderExpiryOutcome> {
    if (!isUuid(input.orderId)) return { status: 'NOT_OPEN' };
    return this.o.database.transaction((tx) => this.#expire(tx, input), TX);
  }

  async #expire(tx: DbTransaction, input: OrderExpiryInput): Promise<OrderExpiryOutcome> {
    // ① 주문 행을 먼저 잠근다(결제 접수와 같은 차례, 둘 가운데 하나만 이긴다)
    const locked = await tx.execute(sql`select status from purchase_order where id = ${input.orderId}::uuid for update`);
    const row = locked.rows[0] as { status: string } | undefined;
    if (!row) return { status: 'NOT_OPEN' };
    const status = row.status as OrderStatus;
    // ② 활성 결제 시도: 만든 지 40분 [가정] 안의 READY(지금 − 만든 시각 ≥ 40분이면 지남, 결제 접수의 경계와 같다)
    const activeFrom = new Date(this.o.clock.now() - ORDER_EXPIRY_ATTEMPT_TTL_MS);
    const attempt = await tx.execute(sql`
      select 1 from payment_attempt where order_id = ${input.orderId}::uuid and status = 'READY' and created_at > ${activeFrom}::timestamptz limit 1`);
    const decision = expiryDecision({ status, sessionEnded: input.sessionEnded, holdRemains: input.holdRemains, activeAttempt: attempt.rows.length > 0 });
    if (decision.kind === 'NOT_OPEN') return { status: 'NOT_OPEN', current: status };
    if (decision.kind === 'NOT_YET') return { status: 'NOT_YET', reason: decision.reason };
    // ③ T5·T6과 이력·Outbox EXPIRED(전이 함수 한 번)
    const r = await this.o.store.transition(tx, { orderId: input.orderId, transition: decision.transition, actor: input.actor });
    if (r.status === 'APPLIED') return { status: 'EXPIRED', transition: decision.transition, seq: r.seq };
    return r.reason === 'STATUS' ? { status: 'NOT_OPEN', current: r.current } : { status: 'NOT_OPEN' };
  }

  async expireReadyAttempts(range: OrderExpiryRange): Promise<OrderExpiredAttempt[]> {
    assertRange(range);
    const r = await this.o.database.db.execute(sql`
      with picked as (
        select id from payment_attempt
         where id >= ${uuidLowerBound(range.createdFromMs)}::uuid and id < ${uuidLowerBound(range.createdBeforeMs)}::uuid and status = 'READY'
           and created_at <= ${new Date(range.createdBeforeMs)}::timestamptz
         order by id limit ${range.limit}::int
           for update skip locked
      )
      update payment_attempt a set status = 'EXPIRED'
        from picked
       where a.id = picked.id and a.status = 'READY'
      returning a.id as attempt_id, a.order_id`);
    return (r.rows as unknown as { attempt_id: string; order_id: string }[]).map((x) => ({ attemptId: x.attempt_id, orderId: x.order_id }));
  }

  openOrderBatch(range: OrderExpiryRange & { readonly afterId?: string }): Promise<OrderExpiryOrder[]> {
    return this.#openBatch(range, ORDER_EXPIRY_BATCH);
  }

  staleOrderBatch(range: OrderExpiryRange & { readonly afterId?: string }): Promise<OrderExpiryOrder[]> {
    return this.#openBatch(range, ORDER_EXPIRY_STALE_BATCH);
  }

  async #openBatch(range: OrderExpiryRange & { readonly afterId?: string }, maxLimit: number): Promise<OrderExpiryOrder[]> {
    assertRange(range, maxLimit);
    if (range.afterId !== undefined && !isUuid(range.afterId)) throw new RangeError('afterId가 소문자 UUID가 아니다');
    const after: SQL = range.afterId === undefined ? sql`` : sql` and id > ${range.afterId}::uuid`;
    const r = await this.o.database.db.execute(sql`
      select ${ORDER_COLUMNS} from purchase_order
       where id >= ${uuidLowerBound(range.createdFromMs)}::uuid and id < ${uuidLowerBound(range.createdBeforeMs)}::uuid and ${IS_OPEN}${after}
       order by id limit ${range.limit}::int`);
    return (r.rows as unknown as OrderExpiryDbRow[]).map(orderOf);
  }
}
