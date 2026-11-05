// 결제 결과 당기기 대상의 purchase DB 쪽(PaymentPullTargets, ADR-0140 결정 1, docs/data.md order_saga_job·§5.1, BUILD_ORDER PRF-171 설계 1·3·4).
// drizzle-ticket-issue.ts(발권 큐 잡기)와 같은 꼴이다.
// - 잡기(claimDue): 짧은 트랜잭션 하나에서 step in ('CONFIRM', 'AWAIT')이고 confirm_sent_at이 있으며 confirm_sent_at ≤ 지금 − 5초 [가정]이고
//   (pull_next_at이 비었거나 ≤ 지금)인 order_saga_job 행을 FOR UPDATE SKIP LOCKED로 limit개(최대 100 [가정])까지 골라 pull_next_at = 지금 + 5초 [가정]을 쓰고 바로 커밋한다
//   (파드 여럿이어도 같은 주문은 5초에 한 번). 그 주문 ACCEPTED 결제 시도의 순번을 같은 문장의 RETURNING 안 하위 질의로 붙인다. 잠금 밖에서 payment-svc를 부른다.
//   CONFIRM 행도 고르는 까닭: 승인 명령을 보냈는데 답을 잃었거나 정해진 거절로 1시간 미뤄진 작업(SAGA_CONFIRM_PARK_MS, PRF-165가 넘긴 것)도
//   payment-svc에 기록이 있으면 결과로 맞추고 반영 트랜잭션이 작업 행을 지운다(설계 3).
//   그 주문의 trade.payments 보류 사건(held_event, topic = PAYMENT_PULL_HELD_TOPIC·business_key = 주문 ID·reprocessed_at 없음)이 있으면 고르지 않는다
//   (키 단위 소비자가 그 주문의 뒤 사건도 함께 보류하므로, 당기기가 앞지르면 보류 사건이 RB-11로 다시 처리될 때 버려진다. 다시 처리한 뒤에는 고른다,
//   docs/features/payment.md §2 'Saga 실행기와 갈림', 2026-11-06 코드 리뷰 M4). 보류 표의 부분 인덱스(held_event_pending_idx)를 탄다.
// - 미루기(defer): pull_next_at = untilMs(한 문장, step이 CONFIRM·AWAIT인 행만). 실행기가 간격(UNKNOWN 30초·입금 대기 60초·취소 상태 60초·보류·오래 기록 없음 10분·
//   payment-svc 장애 30초 [가정])을 정해 넘긴다.
// Saga 실행기의 칸(step·attempts·next_attempt_at·lease_until·confirm_sent_at)은 읽기만 하고 쓰지 않는다. 주문 상태·결제 시도는 바꾸지 않는다(반영은 ApplyPaymentResult).
// 운영은 핫패스 풀이 아니라 당기기 전용 일반 풀(paymentPullDatabaseOptions, 연결 2개 [가정], 이름 purchase-svc-payment-pull)을 넘긴다(설계 4).
// 트랜잭션마다 READ COMMITTED·문장 시간 한도 5초 [가정](SAGA_STATEMENT_TIMEOUT_MS, 요청 밖이다). '지금'은 앱 시계(DrizzlePaymentPullOptions.clock)다.
// 구현에서 정한 것(정본·설계에 없다):
// - claimDue는 pull_next_at(비었으면 confirm_sent_at) 오름차순(같으면 주문 ID 순)으로 고르고 그 차례로 돌려준다. 새 인덱스는 두지 않는다(작업 표는 진행 중 주문만 남아 작다, data.md §5.1).
// - Saga 임대(lease_until)가 걸린 행도 고른다(payment-svc를 읽기만 하는 질의라 겹쳐도 해가 없다. 반영이 작업 행을 지우면 Saga 쪽 쓰기가 0행으로 물러난다).
// - 결제 시도 순번 = 그 주문의 결제 시도 가운데 created_at(같으면 id) 차례로 ACCEPTED 시도가 몇 번째인가(1부터). ACCEPTED 시도가 없으면 0.
// - defer는 pull_next_at을 untilMs로 덮어쓴다(잡기가 쓴 5초보다 늘 늦다). 소문자 UUID가 아닌 ID는 빼고, 남은 것이 없으면 DB에 가지 않는다.
import type { Clock, Database, DatabaseOptions, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { PAYMENT_PULL_AFTER_SENT_MS, PAYMENT_PULL_BATCH, PAYMENT_PULL_DB_MAX, PAYMENT_PULL_HELD_TOPIC, PAYMENT_PULL_REPEAT_MS } from '../../domain/payment-pull.js';
import type { PaymentPullTarget, PaymentPullTargets } from '../../domain/ports.js';
import { SAGA_STATEMENT_TIMEOUT_MS, type SagaStep } from '../../domain/saga.js';

/** 당기기 전용 풀의 이름(pg application_name, 연결을 셀 때 가린다) */
const PAYMENT_PULL_DB_NAME = 'purchase-svc-payment-pull';

/**
 * 결제 결과 당기기의 purchase DB(PEAKET_DATABASE_URL) 풀 설정(main.ts가 createDatabase에 넘기고 종료 때 닫는다, 설계 4).
 * 핫패스 풀과 따로인 일반 풀(연결을 기다린다)·연결 PAYMENT_PULL_DB_MAX(2개 [가정])·이름 PAYMENT_PULL_DB_NAME이다(ticketIssueDatabaseOptions와 같은 꼴):
 * 사건 길이 멈춰 당기기가 몰려도 홀드·주문 요청이 풀 대기 초과(429)를 받지 않게 한다
 */
export function paymentPullDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: PAYMENT_PULL_DB_MAX, applicationName: PAYMENT_PULL_DB_NAME };
}

export interface DrizzlePaymentPullOptions {
  /** 운영은 당기기 전용 일반 풀(paymentPullDatabaseOptions) */
  database: Database;
  /** 잡기 기준(confirm_sent_at ≤ 지금 − 5초, pull_next_at ≤ 지금)과 pull_next_at = 지금 + 5초의 '지금' */
  clock: Clock;
}

/** 모든 트랜잭션의 격리 수준(서버·역할 기본값에 기대지 않는다)과 문장 시간 한도 5초 [가정](요청 밖이라 요청의 남은 시간이 없다) */
const TX = { isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS } as const;

/** 당기기가 고르는 작업 단계(승인 명령을 보낸 뒤의 단계, 설계 3) */
const PULL_STEPS = ['CONFIRM', 'AWAIT'] as const satisfies readonly SagaStep[];
/** 단계 조건 SQL 조각(step in ('CONFIRM', 'AWAIT')). 값은 상수라 글로 넣는다 */
const PULL_STEP_COND = sql.raw(`step in (${PULL_STEPS.map((s) => `'${s}'`).join(', ')})`);

/** 표의 uuid 글(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

type TargetRow = {
  order_id: string;
  event_id: string;
  confirm_sent_at: Date | string;
  /** 고른 차례의 기준(pull_next_at, 비었으면 confirm_sent_at). 바꾸기 전 값이다 */
  due_at: Date | string;
  attempt_no: number | string | null;
};

const msOf = (v: Date | string): number => new Date(v).getTime();

/** 당기기 대상의 purchase DB 구현(위 머리 주석의 차례) */
export class DrizzlePaymentPull implements PaymentPullTargets {
  constructor(private readonly o: DrizzlePaymentPullOptions) {}

  /**
   * 머리 주석 '잡기'. 한 문장(with picked … for update skip locked → update … set pull_next_at → returning 주문 ID·회차·confirm_sent_at·결제 시도 순번)이고
   * RETURNING의 차례는 정해지지 않아 고른 차례로 다시 맞춘다.
   * @throws RangeError limit이 1 ~ PAYMENT_PULL_BATCH의 정수가 아님
   */
  async claimDue(limit: number): Promise<PaymentPullTarget[]> {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > PAYMENT_PULL_BATCH) {
      throw new RangeError(`limit은 1~${PAYMENT_PULL_BATCH}의 정수다: ${String(limit)}`);
    }
    const now = this.o.clock.now();
    const at = new Date(now);
    const sentBefore = new Date(now - PAYMENT_PULL_AFTER_SENT_MS);
    const next = new Date(now + PAYMENT_PULL_REPEAT_MS);
    // 고르기(SKIP LOCKED: 다른 파드가 잡은 행·반영 트랜잭션이 쥔 행은 건너뛴다) → pull_next_at = 지금 + 5초. 고른 차례의 기준(바꾸기 전 값)을 함께 돌려받는다.
    // 그 주문의 보류 사건(trade.payments, 다시 처리 전)이 있으면 고르지 않는다(머리 주석 '잡기', 리뷰 고침 M4. 보류 표는 잠그지 않는다: FOR UPDATE는 FROM의 작업 표만).
    // 결제 시도 순번 = 그 주문 결제 시도의 만든 차례(created_at, 같으면 id)에서 첫 ACCEPTED 시도의 차례(없으면 0)
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        with picked as (
          select s.order_id, coalesce(s.pull_next_at, s.confirm_sent_at) as due_at from order_saga_job s
          where ${PULL_STEP_COND} and s.confirm_sent_at is not null and s.confirm_sent_at <= ${sentBefore}::timestamptz
            and (s.pull_next_at is null or s.pull_next_at <= ${at}::timestamptz)
            and not exists (
              select 1 from held_event h
              where h.topic = ${PAYMENT_PULL_HELD_TOPIC} and h.business_key = s.order_id::text and h.reprocessed_at is null)
          order by coalesce(s.pull_next_at, s.confirm_sent_at), s.order_id
          limit ${limit}::int
          for update of s skip locked)
        update order_saga_job j set pull_next_at = ${next}::timestamptz
        from picked p
        where j.order_id = p.order_id
        returning j.order_id::text as order_id, j.event_id::text as event_id, j.confirm_sent_at, p.due_at,
          (select r.n from (
             select a.status, row_number() over (order by a.created_at, a.id) as n from payment_attempt a where a.order_id = j.order_id
           ) r where r.status = 'ACCEPTED' order by r.n limit 1) as attempt_no`),
    );
    return (r.rows as TargetRow[])
      .map((x) => ({ due: msOf(x.due_at), target: targetOf(x) }))
      .sort((a, b) => a.due - b.due || (a.target.orderId < b.target.orderId ? -1 : a.target.orderId > b.target.orderId ? 1 : 0))
      .map((x) => x.target);
  }

  /**
   * 머리 주석 '미루기'. update order_saga_job set pull_next_at = untilMs where order_id = any(ids) and step in ('CONFIRM', 'AWAIT') returning order_id의 행 수.
   * @throws RangeError untilMs가 날짜(유닉스 밀리초)가 아님
   */
  async defer(orderIds: readonly string[], untilMs: number): Promise<number> {
    const until = new Date(untilMs);
    if (typeof untilMs !== 'number' || Number.isNaN(until.getTime())) throw new RangeError(`untilMs가 날짜(유닉스 밀리초)가 아니다: ${String(untilMs)}`);
    const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).filter(isUuid))];
    if (ids.length === 0) return 0;
    const idList = sql`array[${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    const r = await this.#tx((tx) =>
      tx.execute(sql`
        update order_saga_job set pull_next_at = ${until}::timestamptz
        where order_id = any(${idList}) and ${PULL_STEP_COND}
        returning order_id`),
    );
    return r.rows.length;
  }

  /** 트랜잭션 하나(READ COMMITTED, 문장 시간 한도 5초 [가정]) */
  #tx<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.o.database.transaction(fn, TX);
  }
}

/** 잡은 행 → 당기기 대상(잡기 조건이 confirm_sent_at 있음을 보장한다. ACCEPTED 시도가 없으면 순번 0) */
function targetOf(x: TargetRow): PaymentPullTarget {
  return {
    orderId: x.order_id,
    eventId: x.event_id,
    attemptNo: x.attempt_no === null ? 0 : Number(x.attempt_no),
    confirmSentAtMs: msOf(x.confirm_sent_at),
  };
}
