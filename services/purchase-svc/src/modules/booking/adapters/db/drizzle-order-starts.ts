// 결제 시도 시작의 purchase DB 읽기·쓰기(StartPaymentReads·StartPaymentWrites, docs/features/payment.md §2 '결제 시도 시작의 첫 구현', docs/data.md §5 '결제 시도 시작', BUILD_ORDER PRF-191).
// - 읽기(트랜잭션 밖): 커밋된 멱등 기록(order_idempotency, 범위 계정 × START_PAYMENT × 키), 주문 행과 항목 좌석, 그 주문의 시도 행 수, 시도 하나(재생).
// - start(트랜잭션 하나, read committed, 이 차례. 잠금 차례는 주문 행 → 결제 시도 행이다):
//   ① 멱등 기록 잡기: 플랫폼 IdempotencyStore.run(첫 쓰기 = 키 행, 결과 참조 = 시도 ID, 재생은 REPLAYED)
//   ② 주문 T2(CREATED → CREATED, DrizzleOrderStore.transition, 주문 행 잠금. 이력 한 행, Outbox 없음). 0행이면 STALE ORDER_STATE(current = 지금 상태)
//   ③ 그 주문의 시도 행 수를 센다(주문 행을 잡은 뒤라 정답이다). 상한 이상이면 ATTEMPTS_EXCEEDED
//   ④ 그 주문의 READY 시도를 SUPERSEDED로
//   ⑤ 새 시도 INSERT(READY, 부르는 쪽이 만든 UUIDv7, 결제사, 결제사 참조, 지금 시각)
//   거절은 트랜잭션째 되돌린다(멱등 키 행도 남지 않는다). 활성 시도 부분 유일 인덱스 위반(23505)은 마지막 안전망이라 ACTIVE_CONFLICT다.
// 주문 상태를 바꾸는 SQL은 쓰지 않는다(상태 SQL은 drizzle-orders.ts의 전이 함수에만, test/order-status-sql.test.ts).
import { timingSafeEqual } from 'node:crypto';
import { type Clock, type Database, type DbTransaction, IDEMPOTENCY_RETENTION_MS, IdempotencyStore } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { ACTOR_PATTERN, type OrderStatus } from '../../domain/order.js';
import { PAYMENT_ATTEMPTS_MAX } from '../../domain/payment-attempt.js';
import type { CommittedStartLookup, OrderRequestOnce, PaymentPg, StartedAttemptView, StartInput, StartOrderView, StartOutcome, StartPaymentReads, StartPaymentWrites, TransactionCallOptions } from '../../domain/ports.js';
import { transactionOptionsOf } from './drizzle-order-accepts.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

export interface DrizzleOrderStartsOptions {
  database: Database;
  /** 주문 전이 함수(T2) */
  store: DrizzleOrderStore;
  clock: Clock;
  /** 멱등 보관 기간(기본 24시간 [가정], platform IDEMPOTENCY_RETENTION_MS) */
  retentionMs?: number;
  /** 같은 키를 기다리는 시간(기본 1초 [가정], platform IDEMPOTENCY_WAIT_MS) */
  waitMs?: number;
}

/** 주문 세 작업이 같이 쓰는 멱등 기록 표 */
const ORDER_IDEMPOTENCY_TABLE = 'order_idempotency';
/** 활성 시도 부분 유일 인덱스 이름(마이그레이션 0003) */
const ACTIVE_ATTEMPT_KEY = 'payment_attempt_active_key';
const PGS: ReadonlySet<string> = new Set<PaymentPg>(['TOSS', 'PORTONE', 'SIMULATOR']);
/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** 입력 검사(DB에 가기 전, 코드 오류는 RangeError) */
function assertStartInput(input: StartInput): void {
  if (!isUuid(input.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
  if (!isUuid(input.attemptId)) throw new RangeError('attemptId가 소문자 UUID가 아니다');
  if (!PGS.has(input.pg)) throw new RangeError('결제사(pg)가 TOSS·PORTONE·SIMULATOR가 아니다');
  if (typeof input.pgOrderRef !== 'string' || input.pgOrderRef.length === 0) throw new RangeError('결제사 참조(pgOrderRef)가 비었다');
  if (typeof input.actor !== 'string' || !ACTOR_PATTERN.test(input.actor)) throw new RangeError('행위자(actor)가 account:<UUID>·admin:<UUID>·system:<작업 이름> 모양이 아니다');
}

/** 트랜잭션 안에서 거절을 만나 되돌릴 때 던지는 표지(밖에서 결과로 바꾼다. 밖으로 새지 않는다) */
class RejectedStart extends Error {
  constructor(readonly outcome: Extract<StartOutcome, { status: 'STALE' | 'ATTEMPTS_EXCEEDED' }>) {
    super('결제 시도 시작을 트랜잭션째 되돌린다');
    this.name = 'RejectedStart';
  }
}

/** 활성 시도 부분 유일 인덱스 위반인가(Drizzle은 pg 오류를 cause에 싸서 던진다) */
function isActiveAttemptViolation(err: unknown): boolean {
  let e = err as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined;
  for (let n = 0; e && n < 8; n += 1) {
    if (e.code === '23505' && e.constraint === ACTIVE_ATTEMPT_KEY) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** StartPaymentReads·StartPaymentWrites의 purchase DB 구현(위 머리 주석의 차례) */
export class DrizzleOrderStarts implements StartPaymentReads, StartPaymentWrites {
  readonly #idempotency: IdempotencyStore;
  readonly #retentionMs: number;

  constructor(private readonly o: DrizzleOrderStartsOptions) {
    this.#retentionMs = o.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
    this.#idempotency = new IdempotencyStore({
      clock: o.clock,
      table: ORDER_IDEMPOTENCY_TABLE,
      retentionMs: this.#retentionMs,
      ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}),
    });
  }

  async findCommitted(once: OrderRequestOnce): Promise<CommittedStartLookup> {
    const r = await this.o.database.db.execute(sql`
      select request_hash, result_ref, created_at from order_idempotency
      where account_ref = ${once.accountRef} and operation = ${once.operation} and idempotency_key = ${once.key}`);
    const row = r.rows[0] as { request_hash: Buffer | Uint8Array; result_ref: string | null; created_at: Date | string } | undefined;
    if (!row || row.result_ref === null) return { status: 'NONE' };
    // 보관 기간이 지난 행은 새 요청으로 본다(IdempotencyStore.run이 다시 잡는 경계와 같다)
    const createdAtMs = new Date(row.created_at).getTime();
    if (!(createdAtMs > this.o.clock.now() - this.#retentionMs)) return { status: 'NONE' };
    const stored = Buffer.from(row.request_hash);
    const hash = Buffer.from(once.requestHash);
    if (stored.length !== hash.length || !timingSafeEqual(stored, hash)) return { status: 'MISMATCH' };
    return { status: 'COMMITTED', attemptId: row.result_ref };
  }

  async order(orderId: string): Promise<StartOrderView | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`
      select o.id, o.account_id, o.event_id, o.purchase_session_id, o.status, o.amount, o.hold_id,
             array(select i.seat_id::text from order_item i where i.order_id = o.id order by i.line_no) as seat_ids
      from purchase_order o where o.id = ${orderId}::uuid`);
    const row = r.rows[0] as
      | { id: string; account_id: string; event_id: string; purchase_session_id: string; status: string; amount: number | string; hold_id: string; seat_ids: string[] }
      | undefined;
    if (!row) return undefined;
    return {
      orderId: row.id,
      accountId: row.account_id,
      eventId: row.event_id,
      purchaseSessionId: row.purchase_session_id,
      status: row.status as OrderStatus,
      amount: Number(row.amount),
      holdId: row.hold_id,
      seatIds: row.seat_ids,
    };
  }

  async attemptCount(orderId: string): Promise<number> {
    if (!isUuid(orderId)) return 0;
    return countAttempts(this.o.database.db, orderId);
  }

  async attempt(attemptId: string): Promise<StartedAttemptView | undefined> {
    if (!isUuid(attemptId)) return undefined;
    const r = await this.o.database.db.execute(sql`select id, order_id, pg from payment_attempt where id = ${attemptId}::uuid`);
    const row = r.rows[0] as { id: string; order_id: string; pg: string } | undefined;
    return row ? { attemptId: row.id, orderId: row.order_id, pg: row.pg as PaymentPg } : undefined;
  }

  /**
   * @throws ProblemError 409 idempotency-request-in-progress·422 idempotency-key-reused(플랫폼 IdempotencyStore 그대로)
   * @throws RangeError 입력이 틀림(DB에 가지 않는다)
   */
  async start(once: OrderRequestOnce, input: StartInput, o?: TransactionCallOptions): Promise<StartOutcome> {
    assertStartInput(input);
    const options = transactionOptionsOf(o);
    try {
      return await this.o.database.transaction(
        (tx) =>
          this.#idempotency.run<StartOutcome>(tx, once, {
            execute: async () => {
              // ② T2: 주문 행을 먼저 잠근다(같은 주문의 시작·접수·만료가 여기서 줄을 선다)
              const t = await this.o.store.transition(tx, { orderId: input.orderId, transition: 'T2', actor: input.actor });
              if (t.status !== 'APPLIED') throw new RejectedStart({ status: 'STALE', reason: 'ORDER_STATE', ...(t.current !== undefined ? { current: t.current } : {}) });
              // ③ 이전 READY 시도를 대체한다(주문 행을 잡은 뒤라 같은 주문의 시작이 줄을 선다)
              await tx.execute(sql`update payment_attempt set status = 'SUPERSEDED' where order_id = ${input.orderId}::uuid and status = 'READY'`);
              // ④⑤ 시도 수를 세고 새 시도를 한 문장(CTE)으로 쓴다(BAT-035). count는 대체 뒤에도 전체 시도 수라 old와 같고,
              //    상한을 넘으면 INSERT가 0행이다. 활성 시도 유일 인덱스가 마지막 안전망이다
              const at = new Date(this.o.clock.now());
              const r = await tx.execute(sql`
                with counted as (
                  select count(*)::int as n from payment_attempt where order_id = ${input.orderId}::uuid
                ), inserted as (
                  insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at)
                  select ${input.attemptId}::uuid, ${input.orderId}::uuid, ${input.pg}, ${input.pgOrderRef}, 'READY', ${at}::timestamptz
                   where (select n from counted) < ${PAYMENT_ATTEMPTS_MAX}
                  returning id
                )
                select (select n from counted) as n, (select id from inserted) as id`);
              const row = r.rows[0] as { n: number | string; id: string | null } | undefined;
              const count = Number(row?.n);
              if (!row || row.id === null) throw new RejectedStart({ status: 'ATTEMPTS_EXCEEDED' });
              return { resultRef: input.attemptId, value: { status: 'STARTED', attemptNo: count + 1 } };
            },
            replay: async (ref) => ({ status: 'REPLAYED', attemptId: ref }),
          }),
        options,
      );
    } catch (e) {
      // 트랜잭션째 되돌렸다(주문·시도·멱등 키 행 모두)
      if (e instanceof RejectedStart) return e.outcome;
      if (isActiveAttemptViolation(e)) return { status: 'ACTIVE_CONFLICT' };
      throw e;
    }
  }
}

/** 그 주문의 시도 행 수(끝난 시도 포함, 트랜잭션 안이면 그 트랜잭션으로) */
async function countAttempts(exec: Pick<DbTransaction, 'execute'>, orderId: string): Promise<number> {
  const r = await exec.execute(sql`select count(*)::int as n from payment_attempt where order_id = ${orderId}::uuid`);
  return Number((r.rows[0] as { n: number | string }).n);
}
