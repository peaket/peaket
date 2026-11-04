// 주문 생성의 purchase DB 쓰기(OrderWrites, docs/features/payment.md §2 '주문 생성의 첫 구현', docs/data.md §5 '주문 생성', BUILD_ORDER PRF-161).
// - findCommitted: 트랜잭션 밖에서 order_idempotency의 커밋된 기록 하나를 읽는다(검사 차례의 셋째. 홀드가 그사이 끝나도 같은 201을 돌려주려는 것)
// - create: 트랜잭션 하나에 플랫폼 IdempotencyStore.run(첫 쓰기 = 키 행, table order_idempotency)과 DrizzleOrderStore.createOrder를 묶는다.
//   같은 홀드의 두 주문은 purchase_order_hold_key 유일 위반(23505)으로 HOLD_ALREADY_ORDERED다(트랜잭션째 되돌려 키 행도 남지 않는다).
// 주문 상태를 바꾸는 SQL은 쓰지 않는다(상태 SQL은 drizzle-orders.ts에만, test/order-status-sql.test.ts). 여기는 읽기(select)뿐이다.
import { timingSafeEqual } from 'node:crypto';
import { type Clock, type Database, type DbTransaction, IDEMPOTENCY_RETENTION_MS, IdempotencyStore } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { OrderItem, OrderStatus } from '../../domain/order.js';
import type { CommittedOrderLookup, NewOrder, OrderCreateOutcome, OrderRequestOnce, OrderView, OrderWrites } from '../../domain/ports.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

/** 유일 인덱스 이름(마이그레이션 0004). 23505의 constraint가 이 이름일 때만 HOLD_ALREADY_ORDERED로 본다 */
export const ORDER_HOLD_KEY = 'purchase_order_hold_key';

/** 주문 생성의 멱등 기록 표(purchase의 주문 세 작업이 같이 쓴다, data.md '서비스마다 둔 멱등 기록 표') */
const ORDER_IDEMPOTENCY_TABLE = 'order_idempotency';
/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DrizzleOrderWritesOptions {
  database: Database;
  store: DrizzleOrderStore;
  clock: Clock;
  /** 멱등 보관 기간(기본 24시간 [가정], platform IDEMPOTENCY_RETENTION_MS) */
  retentionMs?: number;
  /** 같은 키를 기다리는 시간(기본 1초 [가정], platform IDEMPOTENCY_WAIT_MS) */
  waitMs?: number;
}

type Executor = Pick<DbTransaction, 'execute'>;

/** 오류와 그 원인 사슬(Drizzle은 pg 오류를 cause에 싸서 던진다). 고리가 있어도 끝난다 */
function chainOf(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e = err; e !== undefined && e !== null && out.length < 8 && !out.includes(e); e = (e as { cause?: unknown }).cause) out.push(e);
  return out;
}

/** 같은 홀드로 만든 주문이 이미 있다는 유일 위반인가(23505이고 제약 이름이 ORDER_HOLD_KEY) */
function isHoldKeyViolation(err: unknown): boolean {
  return chainOf(err).some((e) => (e as { code?: unknown }).code === '23505' && (e as { constraint?: unknown }).constraint === ORDER_HOLD_KEY);
}

/**
 * OrderWrites의 purchase DB 구현.
 * - findCommitted: (account_ref, operation, idempotency_key) 행을 읽어 created_at이 보관 기간 안이고 result_ref가 있을 때만 본다.
 *   지문이 같으면(상수 시간 비교) 그 주문 ID로 읽은 처음 201 모습(status CREATED) → COMMITTED, 다르면 MISMATCH, 행 없음·처리 중·보관 지남이면 NONE.
 *   result_ref가 가리키는 주문이 없으면 Error(멱등 기록과 주문이 어긋났다)
 * - create: database.transaction 안에서 IdempotencyStore.run(tx, once, { execute: createOrder → { resultRef: 주문 ID, value: CREATED(입력으로 만든 모습) },
 *   replay: 읽은 처음 201 모습 → REPLAYED }).
 *   23505이고 constraint가 ORDER_HOLD_KEY면 HOLD_ALREADY_ORDERED. 그 밖은 그대로 던진다
 */
export class DrizzleOrderWrites implements OrderWrites {
  readonly #idempotency: IdempotencyStore;
  readonly #retentionMs: number;

  constructor(private readonly o: DrizzleOrderWritesOptions) {
    this.#retentionMs = o.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
    this.#idempotency = new IdempotencyStore({
      clock: o.clock,
      table: ORDER_IDEMPOTENCY_TABLE,
      retentionMs: this.#retentionMs,
      ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}),
    });
  }

  async findCommitted(once: OrderRequestOnce): Promise<CommittedOrderLookup> {
    const r = await this.o.database.db.execute(sql`
      select request_hash, result_ref, created_at from order_idempotency
      where account_ref = ${once.accountRef} and operation = ${once.operation} and idempotency_key = ${once.key}`);
    const row = r.rows[0] as { request_hash: Buffer | Uint8Array; result_ref: string | null; created_at: Date | string } | undefined;
    if (!row || row.result_ref === null) return { status: 'NONE' };
    // 보관 기간이 지난 행은 새 요청으로 본다(IdempotencyStore.run이 다시 잡는 경계와 같다: created_at ≤ 지금 − 보관 기간이면 지났다)
    const createdAtMs = new Date(row.created_at).getTime();
    if (!(createdAtMs > this.o.clock.now() - this.#retentionMs)) return { status: 'NONE' };
    const stored = Buffer.from(row.request_hash);
    const hash = Buffer.from(once.requestHash);
    if (stored.length !== hash.length || !timingSafeEqual(stored, hash)) return { status: 'MISMATCH' };
    const order = await readOrderWith(this.o.database.db, row.result_ref);
    if (!order) throw new Error('멱등 기록의 결과 참조가 가리키는 주문이 없다(멱등 기록과 주문이 어긋났다)');
    return { status: 'COMMITTED', order: firstResponseOf(order) };
  }

  async create(once: OrderRequestOnce, order: NewOrder): Promise<OrderCreateOutcome> {
    try {
      return await this.o.database.transaction((tx) =>
        this.#idempotency.run<OrderCreateOutcome>(tx, once, {
          execute: async () => {
            await this.o.store.createOrder(tx, order);
            // 방금 넣은 행을 다시 읽지 않고 입력으로 응답 모습을 만든다(줄 번호 = items 차례, 상태 CREATED. 트랜잭션 안 왕복 둘을 줄인다, 리뷰 고침 L7)
            return { resultRef: order.id, value: { status: 'CREATED', order: newOrderViewOf(order) } };
          },
          replay: async (ref) => {
            const view = await readOrderWith(tx, ref);
            if (!view) throw new Error('멱등 기록의 결과 참조가 가리키는 주문이 없다(멱등 기록과 주문이 어긋났다)');
            return { status: 'REPLAYED', order: firstResponseOf(view) };
          },
        }),
      );
    } catch (e) {
      // 트랜잭션째 되돌렸다(키 행도 남지 않는다). 같은 홀드의 주문이 먼저 커밋됐을 때만 이름 붙은 결과다
      if (isHoldKeyViolation(e)) return { status: 'HOLD_ALREADY_ORDERED' };
      throw e;
    }
  }

  /** 주문 행과 항목(줄 번호 차례)으로 OrderView를 만든다. 없으면 undefined */
  async readOrder(orderId: string): Promise<OrderView | undefined> {
    return readOrderWith(this.o.database.db, orderId);
  }
}

/** 새 주문의 응답 모습(createOrder가 넣은 값 그대로: 상태 CREATED, 항목은 준 차례 = 줄 번호 차례) */
const newOrderViewOf = (o: NewOrder): OrderView => ({
  orderId: o.id,
  amount: o.amount,
  status: 'CREATED',
  items: o.items.map((i) => ({ seatId: i.seatId, tierId: i.tierId, sectionId: i.sectionId, unitPrice: i.unitPrice })),
});

/**
 * 멱등 재생의 모습 = 처음 201 본문(리뷰 고침 L2): 주문이 그 뒤 상태(AUTHENTICATED·ACCEPTED …)로 갔어도 status는 CREATED다.
 * 금액·항목은 주문 생성 뒤 바뀌지 않으므로 읽은 값 그대로다
 */
const firstResponseOf = (v: OrderView): OrderView => ({ ...v, status: 'CREATED' });

/** 주문 모습 읽기(트랜잭션 안이면 그 트랜잭션으로, 지금 상태 그대로). 주문 ID가 소문자 UUID가 아니면 없는 것으로 본다 */
async function readOrderWith(exec: Executor, orderId: string): Promise<OrderView | undefined> {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) return undefined;
  const head = await exec.execute(sql`select id, amount, status from purchase_order where id = ${orderId}::uuid`);
  const row = head.rows[0] as { id: string; amount: number | string; status: string } | undefined;
  if (!row) return undefined;
  const lines = await exec.execute(sql`select seat_id, tier, section_id, unit_price from order_item where order_id = ${orderId}::uuid order by line_no`);
  const items: OrderItem[] = (lines.rows as { seat_id: string; tier: string; section_id: string; unit_price: number | string }[]).map((x) => ({
    seatId: x.seat_id,
    tierId: x.tier,
    sectionId: x.section_id,
    unitPrice: Number(x.unit_price),
  }));
  return { orderId: row.id, amount: Number(row.amount), status: row.status as OrderStatus, items };
}
