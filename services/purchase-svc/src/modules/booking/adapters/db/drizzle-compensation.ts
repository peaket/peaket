// 보상 상태 표의 purchase DB 구현(BAT-011, PRF-173, ADR-0354, docs/data.md §2 order_compensation·§5.1).
// drizzle-ticket-issue.ts(발권 재시도 큐)와 같은 꼴이다.
// - start: 짧은 트랜잭션 하나. ① ticket_issue_job 행을 FOR UPDATE로 잠근다(발권 성공 반영·발권 실행기와 같은 차례) ② 이미 보상 행이 있으면 EXISTS
//   ③ 큐 행을 지운다 ④ purchase_order 행을 FOR UPDATE로 잠그고 APPROVED가 아니면 트랜잭션째 되돌려 NOT_APPROVED ⑤ order_compensation STARTED를 넣는다.
//   주문 T20은 여기서 쓰지 않는다: 결제 취소가 끝난 뒤 compensated가 한 번 쓴다(정본 compCancel, ADR-0354 결정 3).
// - claimDue: next_attempt_at이 지나고 임대가 없는 STARTED·FENCED 행을 FOR UPDATE SKIP LOCKED로 골라 lease_until = 지금 + 임대를 쓰고 바로 커밋한다.
//   잠금을 쥔 채 gRPC를 부르지 않는다.
// - fenced: STARTED → FENCED(임대를 주면 자기 임대 조건). 임대는 그대로 두어 같은 실행이 이어서 결제 취소를 부른다.
// - compensated: 보상 행을 잠그고(임대를 주면 자기 임대 조건) → 주문 전이 함수로 T20(APPROVED → COMPENSATED, Outbox가 업무 문장의 마지막)
//   → 행 COMPENSATED(취소 시각·payment_id). 이미 COMPENSATED인 행은 T20을 다시 쓰지 않고 payment_id만 채운다(다시 부름, 이중 환급 0).
//   잠금 차례는 보상 행 → 주문 행이다. 0행·STALE이면 트랜잭션째 되돌린다.
// - retry·failed: 자기 임대 조건(있을 때)의 UPDATE 한 문장.
// 문장 시간 한도는 5초 [가정](SAGA_STATEMENT_TIMEOUT_MS, 요청 밖이다).
// 구현에서 정한 것(정본에 없다): T20을 쓰는 주문 전이 함수를 주지 않으면 이 클래스가 만든다(occurred_at은 넘어온 nowMs).
import type { Clock, Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import {
  COMPENSATION_ACTOR,
  type CompensationCompleteWriteResult,
  type CompensationJobs,
  type CompensationStatus,
  type OrderCompensation,
  type StartCompensationWriteResult,
} from '../../domain/compensation.js';
import type { OrderStatus } from '../../domain/order.js';
import { SAGA_STATEMENT_TIMEOUT_MS } from '../../domain/saga.js';
import { DrizzleOrderStore } from './drizzle-orders.js';

export interface DrizzleCompensationOptions {
  readonly database: Database;
  /** 주문 전이 함수(T20). 없으면 이 클래스가 만든다(occurred_at은 호출이 넘긴 nowMs) */
  readonly store?: DrizzleOrderStore;
  readonly clock?: Clock;
}

/** 트랜잭션의 격리 수준(서버·역할 기본값에 기대지 않는다)과 문장 시간 한도 5초 [가정] */
const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;
/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

type Row = {
  order_id: string;
  status: string;
  reason: string;
  payment_id: string | null;
  started_at: Date | string;
  fenced_at: Date | string | null;
  canceled_at: Date | string | null;
  attempts: number | string;
  next_attempt_at: Date | string | null;
  lease_until: Date | string | null;
  last_error: string | null;
  updated_at: Date | string;
};

const msOf = (v: Date | string): number => new Date(v).getTime();
const statusOf = (v: string): CompensationStatus => {
  if (v === 'STARTED' || v === 'FENCED' || v === 'COMPENSATED' || v === 'FAILED') return v;
  throw new Error(`알 수 없는 보상 상태: ${v}`);
};

/** 읽은 행 → OrderCompensation(널 칸은 뺀다). canceled_at이 COMPENSATED의 완료 시각이다 */
function recordOf(r: Row): OrderCompensation {
  return {
    orderId: r.order_id,
    status: statusOf(r.status),
    reason: r.reason,
    ...(r.payment_id !== null ? { paymentId: r.payment_id } : {}),
    startedAtMs: msOf(r.started_at),
    ...(r.fenced_at !== null ? { fencedAtMs: msOf(r.fenced_at) } : {}),
    ...(r.canceled_at !== null ? { compensatedAtMs: msOf(r.canceled_at) } : {}),
    attempts: Number(r.attempts),
    ...(r.next_attempt_at !== null ? { nextAttemptAtMs: msOf(r.next_attempt_at) } : {}),
    ...(r.lease_until !== null ? { leaseUntilMs: msOf(r.lease_until) } : {}),
    ...(r.last_error !== null ? { lastError: r.last_error } : {}),
    updatedAtMs: msOf(r.updated_at),
  };
}

const COLUMNS = sql.raw(
  'order_id, status, reason, payment_id, started_at, fenced_at, canceled_at, attempts, next_attempt_at, lease_until, last_error, updated_at',
);
const RETURNING_COLUMNS = sql.raw(
  'c.order_id, c.status, c.reason, c.payment_id, c.started_at, c.fenced_at, c.canceled_at, c.attempts, c.next_attempt_at, c.lease_until, c.last_error, c.updated_at',
);

/** 자기 임대 조건 SQL 조각(값이 없으면 빈 조각) */
const leaseCond = (lease: number | undefined) => (lease === undefined ? sql`` : sql` and lease_until = ${new Date(lease)}::timestamptz`);

/** 트랜잭션 안에서 되돌릴 때 던지는 표지(밖에서 결과로 바꾼다. 밖으로 새지 않는다) */
class StartRollback extends Error {
  constructor(readonly result: StartCompensationWriteResult) {
    super('보상 시작 트랜잭션을 되돌린다');
    this.name = 'StartRollback';
  }
}

class CompleteRollback extends Error {
  constructor(readonly result: CompensationCompleteWriteResult) {
    super('보상 끝내기 트랜잭션을 되돌린다');
    this.name = 'CompleteRollback';
  }
}

/** 보상 상태 표의 purchase DB 구현(머리 주석의 차례) */
export class DrizzleCompensation implements CompensationJobs {
  constructor(private readonly o: DrizzleCompensationOptions) {}

  async candidates(eventId: string, limit: number): Promise<readonly string[]> {
    if (!isUuid(eventId)) return [];
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    const r = await this.o.database.db.execute(sql`
      select j.order_id::text as order_id
      from ticket_issue_job j
      join purchase_order o on o.id = j.order_id
      where j.event_id = ${eventId}::uuid
        and o.status = 'APPROVED'
        and not exists (select 1 from order_compensation c where c.order_id = j.order_id)
      order by j.created_at, j.order_id
      limit ${limit}::int`);
    return (r.rows as { order_id: string }[]).map((x) => x.order_id);
  }

  async start(input: { readonly orderId: string; readonly reason: string; readonly paymentId?: string; readonly nowMs: number }): Promise<StartCompensationWriteResult> {
    if (!isUuid(input.orderId)) throw new RangeError('orderId가 소문자 UUID가 아니다');
    if (typeof input.reason !== 'string' || input.reason.length === 0) throw new RangeError('보상 사유가 비었다');
    const at = new Date(input.nowMs);
    const paymentId = input.paymentId !== undefined && input.paymentId !== '' ? input.paymentId : null;
    try {
      return await this.o.database.transaction(async (tx) => {
        // ① 발권 큐 행을 먼저 잠근다(발권 성공 반영·발권 실행기와 같은 '큐 행 → 주문 행' 차례)
        await tx.execute(sql`select order_id from ticket_issue_job where order_id = ${input.orderId}::uuid for update`);
        // ② 이미 보상 행이 있으면 아무것도 바꾸지 않는다(멱등). 행이 없을 때만 주문을 잠근다(끝내기와 교착하지 않게)
        const existing = await tx.execute(sql`select status from order_compensation where order_id = ${input.orderId}::uuid`);
        if (existing.rows.length > 0) return { status: 'EXISTS' } as const;
        // ③ 큐 행을 지운다: 발권 실행기의 성공 반영은 큐 행이 없으면 T18을 쓰지 않는다(늦게 온 발권 답이 보상을 덮지 않는다)
        await tx.execute(sql`delete from ticket_issue_job where order_id = ${input.orderId}::uuid`);
        // ④ 주문이 APPROVED일 때만 보상한다. 아니면 큐 행 삭제까지 되돌린다(멱등 no-op)
        const order = await tx.execute(sql`select status from purchase_order where id = ${input.orderId}::uuid for update`);
        const current = (order.rows[0] as { status: string } | undefined)?.status as OrderStatus | undefined;
        if (current !== 'APPROVED') throw new StartRollback(current !== undefined ? { status: 'NOT_APPROVED', current } : { status: 'NOT_APPROVED' });
        // ⑤ STARTED 행. started_at·next_attempt_at = 지금(다음 틱이 곧바로 집는다). payment_id는 마지막 APPROVED 결제(없으면 빈 값)
        const inserted = await tx.execute(sql`
          insert into order_compensation (order_id, status, reason, payment_id, started_at, attempts, next_attempt_at, updated_at)
          values (${input.orderId}::uuid, 'STARTED', ${input.reason}, ${paymentId}, ${at}::timestamptz, 0, ${at}::timestamptz, ${at}::timestamptz)
          on conflict (order_id) do nothing
          returning order_id`);
        return inserted.rows.length > 0 ? ({ status: 'CREATED' } as const) : ({ status: 'EXISTS' } as const);
      }, TX);
    } catch (e) {
      if (e instanceof StartRollback) return e.result;
      throw e;
    }
  }

  async claimDue(limit: number, leaseMs: number, nowMs: number): Promise<readonly OrderCompensation[]> {
    if (!isPositiveInt(limit)) throw new RangeError(`limit은 1 이상의 정수다: ${String(limit)}`);
    if (!isPositiveInt(leaseMs)) throw new RangeError(`leaseMs는 1 이상의 정수다: ${String(leaseMs)}`);
    const at = new Date(nowMs);
    const until = new Date(nowMs + leaseMs);
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select order_id from order_compensation
          where status in ('STARTED', 'FENCED')
            and next_attempt_at is not null and next_attempt_at <= ${at}::timestamptz
            and (lease_until is null or lease_until < ${at}::timestamptz)
          order by next_attempt_at, order_id
          limit ${limit}::int
          for update skip locked)
        update order_compensation c set lease_until = ${until}::timestamptz, updated_at = ${at}::timestamptz
        from picked p
        where c.order_id = p.order_id
        returning ${RETURNING_COLUMNS}`),
    );
    // RETURNING의 차례는 정해지지 않아 next_attempt_at·주문 ID 차례로 다시 맞춘다
    return (r.rows as Row[]).map(recordOf).sort((a, b) => (a.nextAttemptAtMs ?? 0) - (b.nextAttemptAtMs ?? 0) || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
  }

  async get(orderId: string): Promise<OrderCompensation | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(sql`select ${COLUMNS} from order_compensation where order_id = ${orderId}::uuid`);
    const row = r.rows[0] as Row | undefined;
    return row ? recordOf(row) : undefined;
  }

  async fenced(input: { readonly orderId: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean> {
    if (!isUuid(input.orderId)) return false;
    const at = new Date(input.nowMs);
    // 임대는 그대로 둔다(같은 실행이 이어서 결제 취소를 부른다). 실행기가 죽으면 임대가 끝난 뒤 다시 잡힌다
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_compensation
        set status = 'FENCED', fenced_at = ${at}::timestamptz, attempts = attempts + 1, next_attempt_at = ${at}::timestamptz,
            last_error = null, updated_at = ${at}::timestamptz
        where order_id = ${input.orderId}::uuid and status = 'STARTED'${leaseCond(input.leaseUntilMs)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async compensated(input: { readonly orderId: string; readonly nowMs: number; readonly paymentId?: string; readonly leaseUntilMs?: number }): Promise<CompensationCompleteWriteResult> {
    if (!isUuid(input.orderId)) return { status: 'LEASE_LOST' };
    const at = new Date(input.nowMs);
    const paymentId = input.paymentId !== undefined && input.paymentId !== '' ? input.paymentId : null;
    try {
      return await this.#tx(async (tx) => {
        // ① 보상 행을 잠근다(임대를 주면 자기 임대 조건). 잠금 차례는 보상 행 → 주문 행이다. 낡은 임대면 아무것도 쓰지 않는다(RV-02)
        const held = await tx.execute(sql`select status from order_compensation where order_id = ${input.orderId}::uuid${leaseCond(input.leaseUntilMs)} for update`);
        const row = held.rows[0] as { status: string } | undefined;
        if (!row) return { status: 'LEASE_LOST' } as const;
        const status = statusOf(row.status);
        // 이미 끝났다: T20을 다시 쓰지 않고 payment_id만 채운다(다시 부름, 이중 환급 0)
        if (status === 'COMPENSATED') {
          if (paymentId !== null) await tx.execute(sql`update order_compensation set payment_id = ${paymentId}, updated_at = ${at}::timestamptz where order_id = ${input.orderId}::uuid`);
          return { status: 'COMPENSATED' } as const;
        }
        if (status !== 'FENCED') throw new CompleteRollback({ status: 'STALE' });
        // ② 주문 T20(APPROVED → COMPENSATED, 조건부). 이미 COMPENSATED면 그대로 성공(같은 결과), 그 밖이면 되돌린다
        const store = this.#storeAt(input.nowMs);
        const t = await store.transition(tx, { orderId: input.orderId, transition: 'T20', actor: COMPENSATION_ACTOR });
        if (t.status !== 'APPLIED' && t.current !== 'COMPENSATED') throw new CompleteRollback(t.current !== undefined ? { status: 'STALE', current: t.current } : { status: 'STALE' });
        // ③ 행 COMPENSATED(보상 완료 시각·payment_id·시도 수). 자기 임대 조건을 UPDATE에도 다시 건다
        await tx.execute(sql`
          update order_compensation
          set status = 'COMPENSATED', canceled_at = ${at}::timestamptz, attempts = attempts + 1,
              payment_id = coalesce(${paymentId}, payment_id), last_error = null, next_attempt_at = null, lease_until = null, updated_at = ${at}::timestamptz
          where order_id = ${input.orderId}::uuid${leaseCond(input.leaseUntilMs)}`);
        return { status: 'COMPENSATED' } as const;
      });
    } catch (e) {
      if (e instanceof CompleteRollback) return e.result;
      throw e;
    }
  }

  async retry(input: { readonly orderId: string; readonly code: string; readonly nextAtMs: number; readonly nowMs: number; readonly paymentId?: string; readonly leaseUntilMs?: number }): Promise<boolean> {
    if (!isUuid(input.orderId)) return false;
    if (typeof input.nextAtMs !== 'number' || Number.isNaN(new Date(input.nextAtMs).getTime())) throw new RangeError(`nextAtMs가 날짜가 아니다: ${String(input.nextAtMs)}`);
    const at = new Date(input.nowMs);
    const next = new Date(input.nextAtMs);
    const payment = input.paymentId !== undefined && input.paymentId !== '' ? input.paymentId : null;
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_compensation
        set attempts = attempts + 1, last_error = ${input.code}, next_attempt_at = ${next}::timestamptz, lease_until = null,
            payment_id = coalesce(${payment}, payment_id), updated_at = ${at}::timestamptz
        where order_id = ${input.orderId}::uuid and status in ('STARTED', 'FENCED')${leaseCond(input.leaseUntilMs)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async failed(input: { readonly orderId: string; readonly code: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean> {
    if (!isUuid(input.orderId)) return false;
    const at = new Date(input.nowMs);
    // next_attempt_at을 비워 집기 대상에서 뺀다(FAILED는 다시 보내지 않는다)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_compensation
        set status = 'FAILED', attempts = attempts + 1, last_error = ${input.code}, next_attempt_at = null, lease_until = null, updated_at = ${at}::timestamptz
        where order_id = ${input.orderId}::uuid and status in ('STARTED', 'FENCED')${leaseCond(input.leaseUntilMs)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async release(orderId: string, leaseUntilMs: number): Promise<boolean> {
    if (!isUuid(orderId)) return false;
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_compensation set lease_until = null
        where order_id = ${orderId}::uuid and status in ('STARTED', 'FENCED')${leaseCond(leaseUntilMs)}
        returning order_id`),
    );
    return r.rows.length > 0;
  }

  async gauges(): Promise<{ readonly pending: number; readonly failed: number }> {
    const r = await this.o.database.db.execute(sql`
      select count(*) filter (where status in ('STARTED', 'FENCED'))::int as pending,
             count(*) filter (where status = 'FAILED')::int as failed
      from order_compensation`);
    const row = r.rows[0] as { pending: number | string; failed: number | string } | undefined;
    return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0) };
  }

  /** 주문 전이 함수. 주입한 것이 없으면 nowMs로 시각을 고정한 것을 만든다(시험·단독 조립) */
  #storeAt(nowMs: number): DrizzleOrderStore {
    return this.o.store ?? new DrizzleOrderStore({ clock: { now: () => nowMs, monotonicMs: () => nowMs } });
  }

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]) */
  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }
}
