// 결제 접수의 purchase DB 읽기·쓰기(OrderAcceptReads·OrderAcceptWrites, docs/features/payment.md §2 '결제 접수의 첫 구현', docs/data.md §5 '결제 접수', BUILD_ORDER PRF-162).
// - 읽기(트랜잭션 밖): 커밋된 멱등 기록(order_idempotency, 범위 계정 × ACCEPT_PAYMENT × 키), 주문 행, 그 주문의 활성 결제 시도(READY·ACCEPTED).
// - accept(트랜잭션 하나, read committed, 이 차례. 잠금 차례는 주문 행 → 결제 시도 행이다, 리뷰 고침 M2·L3 2026-11-05):
//   ① 멱등 기록 잡기: 플랫폼 IdempotencyStore.run(첫 쓰기 = 키 행, table order_idempotency, 결과 참조 = 주문 ID, 재생은 REPLAYED)
//   ② 주문 T3(CREATED → AUTHENTICATED, DrizzleOrderStore.transition, 주문 행 잠금). 0행이면 STALE ORDER_STATE(current = 지금 상태:
//      ACCEPTED면 다른 탭이 먼저 접수 → 409 payment-already-accepted, EXPIRED면 만료와 겹침 → 409 order-expired). 두 탭은 여기서 줄을 선다
//   ③ 결제 시도 READY → ACCEPTED 조건부 UPDATE(id·order_id·status READY일 때만): 결제 참조 칸(토스·시뮬레이터 pg_payment_key, 포트원 pg_tx_id·pg_payment_token)과
//      authenticated_at·accepted_at(같은 시각). 0행이면 STALE ATTEMPT_GONE(current = 시도의 지금 상태. 대체·만료 → 409 payment-attempt-mismatch)
//   ④ 주문의 판 번호 seat_gen(회차 슬롯 읽기의 gen. 상태 칸은 건드리지 않는다)
//   ⑤ order_saga_job INSERT(order_id, event_id, step 'RESERVE', attempts 0, next_attempt_at = 지금, created_at = 지금. 실행은 PRF-165)
//   ⑥ 주문 T4(AUTHENTICATED → ACCEPTED, ACCEPTED 사건을 Outbox에 쓴다): Outbox 행이 업무 문장의 마지막이다(ADR-0116 결정 3)
//   STALE은 트랜잭션째 되돌린다(멱등 키 행도 남지 않는다. 플랫폼 run 안에서 던진 표지 오류를 밖에서 결과로 바꾼다).
//   남은 시간을 받으면 트랜잭션의 문장 시간 초과로 건다(리뷰 고침 L4).
// 주문 상태를 바꾸는 SQL은 쓰지 않는다(상태 SQL은 drizzle-orders.ts의 전이 함수에만, test/order-status-sql.test.ts). 결제 참조·토큰은 로그·오류 글에 싣지 않는다.
import { timingSafeEqual } from 'node:crypto';
import { type Clock, type Database, type DbTransaction, IDEMPOTENCY_RETENTION_MS, IdempotencyStore, type TransactionOptions, writeOutbox } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { ACTOR_PATTERN, type OrderStatus } from '../../domain/order.js';
import type {
  AcceptInput,
  AcceptOrderView,
  AcceptOutcome,
  ActiveAttemptView,
  CommittedAcceptLookup,
  OrderAcceptReads,
  OrderAcceptWrites,
  OrderRequestOnce,
  PaymentPg,
  TransactionCallOptions,
} from '../../domain/ports.js';
import type { DrizzleOrderStore } from './drizzle-orders.js';

export interface DrizzleOrderAcceptsOptions {
  database: Database;
  /** 주문 전이 함수(T3·T4) */
  store: DrizzleOrderStore;
  clock: Clock;
  /** 멱등 보관 기간(기본 24시간 [가정], platform IDEMPOTENCY_RETENTION_MS) */
  retentionMs?: number;
  /** 같은 키를 기다리는 시간(기본 1초 [가정], platform IDEMPOTENCY_WAIT_MS) */
  waitMs?: number;
}

/** 주문 세 작업이 같이 쓰는 멱등 기록 표(data.md '서비스마다 둔 멱등 기록 표') */
const ORDER_IDEMPOTENCY_TABLE = 'order_idempotency';
/** Saga 작업 행의 첫 단계. 쓰임새의 SAGA_FIRST_STEP과 같은 값이다(어댑터는 유스케이스 층을 가져오지 않는다, architecture §3.1. 값 목록은 PRF-165) */
const SAGA_FIRST_STEP = 'RESERVE';
/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** PostgreSQL int4 최댓값(seat_gen 칸) */
const INT4_MAX = 2_147_483_647;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 칸 이름이 정확히 이 묶음인가(빠진 칸·남는 칸이 없다) */
function hasExactly(o: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(o);
  return keys.length === names.length && names.every((n) => Object.hasOwn(o, n));
}

/** 결제 시도에 쓸 결제 참조 칸 셋(결제사에 맞지 않는 칸은 널) */
interface RefColumns {
  paymentKey: string | null;
  txId: string | null;
  paymentToken: string | null;
}

/**
 * accept 입력 검사(DB에 가기 전, 코드 오류는 RangeError). 오류 글에 결제 참조·토큰 값을 싣지 않는다.
 * @returns 결제 시도에 쓸 결제 참조 칸
 */
function assertAcceptInput(input: AcceptInput): RefColumns {
  if (!isObject(input)) throw new RangeError('결제 접수 입력이 객체가 아니다');
  if (!isUuid(input.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
  if (!isUuid(input.attemptId)) throw new RangeError('attemptId가 소문자 UUID가 아니다');
  if (!isUuid(input.eventId)) throw new RangeError('eventId가 소문자 UUID가 아니다');
  const gen = input.seatGen as unknown;
  if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 1 || gen > INT4_MAX) throw new RangeError(`seatGen은 1~${INT4_MAX}의 정수여야 한다: ${String(gen)}`);
  if (typeof input.actor !== 'string' || !ACTOR_PATTERN.test(input.actor)) throw new RangeError('행위자(actor)가 account:<UUID>·admin:<UUID>·system:<작업 이름> 모양이 아니다');
  const refs = input.refs as unknown;
  if (!isObject(refs)) throw new RangeError('결제 참조(refs)가 객체가 아니다');
  const pg = refs.pg;
  if (pg === 'TOSS' || pg === 'SIMULATOR') {
    if (!hasExactly(refs, ['pg', 'paymentKey']) || !nonEmpty(refs.paymentKey)) throw new RangeError('토스·시뮬레이터 결제 참조는 빈 글이 아닌 paymentKey 하나다');
    return { paymentKey: refs.paymentKey, txId: null, paymentToken: null };
  }
  if (pg === 'PORTONE') {
    if (!hasExactly(refs, ['pg', 'txId', 'paymentToken']) || !nonEmpty(refs.txId) || !nonEmpty(refs.paymentToken)) {
      throw new RangeError('포트원 결제 참조는 빈 글이 아닌 txId·paymentToken 둘이다');
    }
    return { paymentKey: null, txId: refs.txId, paymentToken: refs.paymentToken };
  }
  throw new RangeError('결제 참조의 결제사(pg)가 TOSS·PORTONE·SIMULATOR가 아니다');
}

/** 트랜잭션 안에서 0행을 만나 되돌릴 때 던지는 표지(밖에서 STALE 결과로 바꾼다. 밖으로 새지 않는다) */
class StaleAccept extends Error {
  constructor(readonly outcome: Extract<AcceptOutcome, { status: 'STALE' }>) {
    super('결제 접수의 조건부 UPDATE가 0행이라 트랜잭션째 되돌린다');
    this.name = 'StaleAccept';
  }
}

/**
 * OrderAcceptReads·OrderAcceptWrites의 purchase DB 구현(위 머리 주석의 차례).
 * - findCommitted: DrizzleOrderWrites.findCommitted와 같은 규칙(보관 기간 안이고 result_ref가 있을 때만, 지문 상수 시간 비교). COMMITTED의 orderId = result_ref
 * - order: 소문자 UUID가 아니면 DB에 가지 않고 undefined
 * - activeAttempt: status in ('READY', 'ACCEPTED')인 행 하나(부분 유일이라 많아야 하나). pg_order_ref가 널이면 pgOrderRef 없음
 * - accept: 입력 검사(RangeError) → database.transaction 안에서 ①~⑥
 */
export class DrizzleOrderAccepts implements OrderAcceptReads, OrderAcceptWrites {
  readonly #idempotency: IdempotencyStore;
  readonly #retentionMs: number;

  constructor(private readonly o: DrizzleOrderAcceptsOptions) {
    this.#retentionMs = o.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
    this.#idempotency = new IdempotencyStore({
      clock: o.clock,
      table: ORDER_IDEMPOTENCY_TABLE,
      retentionMs: this.#retentionMs,
      ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}),
    });
  }

  async findCommitted(once: OrderRequestOnce): Promise<CommittedAcceptLookup> {
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
    return { status: 'COMMITTED', orderId: row.result_ref };
  }

  async order(orderId: string): Promise<AcceptOrderView | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`
      select id, account_id, event_id, purchase_session_id, status, amount from purchase_order where id = ${orderId}::uuid`);
    const row = r.rows[0] as
      | { id: string; account_id: string; event_id: string; purchase_session_id: string; status: string; amount: number | string }
      | undefined;
    if (!row) return undefined;
    return {
      orderId: row.id,
      accountId: row.account_id,
      eventId: row.event_id,
      purchaseSessionId: row.purchase_session_id,
      status: row.status as OrderStatus,
      amount: Number(row.amount),
    };
  }

  async activeAttempt(orderId: string): Promise<ActiveAttemptView | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`
      select id, pg, status, pg_order_ref, created_at, (select count(*)::int from payment_attempt a where a.order_id = ${orderId}::uuid) as attempt_count from payment_attempt
      where order_id = ${orderId}::uuid and status in ('READY', 'ACCEPTED')
      limit 1`);
    const row = r.rows[0] as { id: string; pg: string; status: string; pg_order_ref: string | null; created_at: Date | string; attempt_count: number } | undefined;
    if (!row) return undefined;
    return {
      attemptId: row.id,
      pg: row.pg as PaymentPg,
      status: row.status as 'READY' | 'ACCEPTED',
      attemptCount: Number(row.attempt_count),
      ...(row.pg_order_ref !== null ? { pgOrderRef: row.pg_order_ref } : {}),
      createdAtMs: new Date(row.created_at).getTime(),
    };
  }

  /**
   * @throws ProblemError 409 idempotency-request-in-progress·422 idempotency-key-reused(플랫폼 IdempotencyStore 그대로)
   * @throws RangeError orderId·attemptId·eventId가 소문자 UUID가 아님, seatGen이 1 이상 int4 정수가 아님, refs의 결제사·칸이 틀림(빈 글 포함), actor 모양 틀림
   */
  async accept(once: OrderRequestOnce, input: AcceptInput, o?: TransactionCallOptions): Promise<AcceptOutcome> {
    const refs = assertAcceptInput(input);
    const options = transactionOptionsOf(o);
    try {
      return await this.o.database.transaction(
        (tx) =>
          this.#idempotency.run<AcceptOutcome>(tx, once, {
            execute: async () => {
              const at = new Date(this.o.clock.now());
              // ② T3·T4: 주문 행을 한 번만 잠그고 두 전이와 seat_gen을 한 UPDATE로 쓴다(BAT-035).
              //    다른 탭이 먼저 접수했거나 만료와 겹치면 0행이라 STALE ORDER_STATE다
              const applied = await this.o.store.acceptTransitions(tx, { orderId: input.orderId, actor: input.actor, seatGen: input.seatGen, at });
              if (applied.status !== 'APPLIED') {
                throw new StaleAccept({ status: 'STALE', reason: 'ORDER_STATE', ...(applied.current !== undefined ? { current: applied.current } : {}) });
              }
              // ③ 결제 시도 READY → ACCEPTED(그 주문의 시도일 때만). 주문 행을 잡은 뒤라 0행은 시도가 대체·만료된 것이다
              const taken = await tx.execute(sql`
                update payment_attempt
                   set status = 'ACCEPTED', pg_payment_key = ${refs.paymentKey}, pg_tx_id = ${refs.txId}, pg_payment_token = ${refs.paymentToken},
                       authenticated_at = ${at}::timestamptz, accepted_at = ${at}::timestamptz
                 where id = ${input.attemptId}::uuid and order_id = ${input.orderId}::uuid and status = 'READY'
                returning id`);
              if (taken.rows.length !== 1) throw new StaleAccept(await attemptGoneOf(tx, input.attemptId));
              // ④ Saga 작업 행(주문 ID 기본 키라 한 주문에 하나). 바로 돌 수 있게 다음 시각 = 지금, 임대는 비운다
              await tx.execute(sql`
                insert into order_saga_job (order_id, event_id, step, attempts, next_attempt_at, lease_until, created_at)
                values (${input.orderId}::uuid, ${input.eventId}::uuid, ${SAGA_FIRST_STEP}, 0, ${at}::timestamptz, null, ${at}::timestamptz)`);
              // ⑤ Outbox 행이 업무 문장의 마지막이다(ADR-0116 결정 3)
              await writeOutbox(tx, this.o.clock, [applied.outbox]);
              return { resultRef: input.orderId, value: { status: 'ACCEPTED' } };
            },
            // 같은 키·같은 지문이 먼저 커밋했다: 처음 202 그대로(입력이 달라도 지문만 본다)
            replay: async () => ({ status: 'REPLAYED' }),
          }),
        options,
      );
    } catch (e) {
      // 트랜잭션째 되돌렸다(시도 칸·주문·멱등 키 행 모두). 조건부 UPDATE 0행만 이름 붙은 결과다
      if (e instanceof StaleAccept) return e.outcome;
      throw e;
    }
  }
}

/** 시도 UPDATE가 0행일 때 그 시도의 지금 상태(같은 트랜잭션, READ COMMITTED라 막 커밋된 값). 행이 없으면 current 없음 */
async function attemptGoneOf(tx: DbTransaction, attemptId: string): Promise<Extract<AcceptOutcome, { reason: 'ATTEMPT_GONE' }>> {
  const r = await tx.execute(sql`select status from payment_attempt where id = ${attemptId}::uuid`);
  const status = (r.rows[0] as { status: string } | undefined)?.status;
  return status === 'ACCEPTED' || status === 'SUPERSEDED' || status === 'EXPIRED' ? { status: 'STALE', reason: 'ATTEMPT_GONE', current: status } : { status: 'STALE', reason: 'ATTEMPT_GONE' };
}

/**
 * 결제 접수·주문 생성 트랜잭션의 선택값: 격리 수준은 늘 read committed(서버·역할 기본이 바뀌어도 조건부 UPDATE가 0행으로 끝나게, 리뷰 고침 L3),
 * 남은 시간을 받았으면 그것을 문장 시간 초과로(리뷰 고침 L4)
 * @throws RangeError deadlineMs가 1 이상 정수가 아님
 */
export function transactionOptionsOf(o: TransactionCallOptions | undefined): TransactionOptions {
  const ms = o?.deadlineMs;
  if (ms === undefined) return { isolationLevel: 'read committed' };
  if (!Number.isSafeInteger(ms) || ms < 1) throw new RangeError(`트랜잭션 문장 시간 초과(deadlineMs)는 1 이상 정수여야 한다: ${String(ms)}`);
  return { isolationLevel: 'read committed', statementTimeoutMs: ms };
}
