// payment DB의 표(docs/data.md §2 ERD payment·payment_event·payment_confirm_job과 §4 '결제 표 마이그레이션', docs/features/payment.md §2 '승인 명령 접수의 첫 구현',
// BUILD_ORDER PRF-180, ADR-0114). 마이그레이션은 0000_payment.sql이고, Outbox 부모 표는 Drizzle 0.45가 나타내지 못해 그 SQL에 손으로 덧붙였다.
// 다른 표(webhook_receipt·payment_entry_pause·payment_cancel 등)는 그 표를 쓰는 단계가 더한다.
// drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다. 상태 목록은 도메인 상수와 같은 차례로 글로 적는다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** 결제 원장 상태 일곱 값의 CHECK 목록(domain/confirm-command.ts PAYMENT_LEDGER_STATUSES와 같은 값·차례) */
const STATUS_LIST = sql.raw("'ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'");
/** 결제사 셋의 CHECK 목록 */
const PG_LIST = sql.raw("'TOSS', 'PORTONE', 'SIMULATOR'");
/** 분석용 실패 범주 여섯 값의 CHECK 목록(domain/payment-gateway.ts FailureCategory와 같은 값) */
const FAILURE_CATEGORY_LIST = sql.raw("'CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED'");

export const payment = pgTable(
  'payment',
  {
    // UUIDv7(시간순, 앱이 만든다). 표는 나누지 않는다(ADR-0114)
    id: uuid('id').primaryKey(),
    // 승인 요청은 주문당 한 번(유일 인덱스 payment_order_id_key)
    orderId: uuid('order_id').notNull(),
    // 회차. 승인 명령의 event_id. 결제 사건의 eventId
    eventId: uuid('event_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    // 같은 주문의 결제 시도 순번(1부터). 결제 사건의 attemptNo
    attemptNo: integer('attempt_no').notNull(),
    pg: text('pg').notNull(),
    // 토스 paymentKey 또는 포트원 paymentId
    pgPaymentRef: text('pg_payment_ref').notNull(),
    // 포트원 paymentToken. 결과가 확정되면 지운다
    pgConfirmToken: text('pg_confirm_token'),
    depositSecretHash: bytea('deposit_secret_hash'),
    amount: integer('amount').notNull(),
    status: text('status').notNull(),
    depositDueAt: at('deposit_due_at'),
    virtualAccountNo: text('virtual_account_no'),
    virtualAccountBank: text('virtual_account_bank'),
    // confirm-{orderId}
    idempotencyKey: text('idempotency_key').notNull(),
    paymentMethodRef: text('payment_method_ref'),
    cardBin: text('card_bin'),
    // 승인 기한(인증 + 10분)의 기준
    authenticatedAt: at('authenticated_at').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    approvedAt: at('approved_at'),
    statusChangedAt: at('status_changed_at').notNull(),
    // 실패 범주. FAILED일 때만 채운다. ConfirmPayment 재전송의 답과 BatchGetPayments가 읽는다(BUILD_ORDER PRF-181, 마이그레이션 0001)
    failureCategory: text('failure_category'),
  },
  (t) => [
    uniqueIndex('payment_order_id_key').on(t.orderId),
    check('payment_status_check', sql`${t.status} IN (${STATUS_LIST})`),
    check('payment_pg_check', sql`${t.pg} IN (${PG_LIST})`),
    check('payment_amount_check', sql`${t.amount} > 0`),
    check('payment_attempt_no_check', sql`${t.attemptNo} >= 1`),
    check('payment_method_ref_card_bin_check', sql`(${t.paymentMethodRef} IS NULL) = (${t.cardBin} IS NULL)`),
    check('payment_failure_category_check', sql`${t.failureCategory} IN (${FAILURE_CATEGORY_LIST})`),
  ],
);

export const paymentEvent = pgTable(
  'payment_event',
  {
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payment.id),
    // 결제마다 늘어나기만 하는 순번. trade.payments eventSeq와 BatchGetPayments의 event_seq가 이 값이다(ADR-0140)
    seq: bigint('seq', { mode: 'number' }).notNull(),
    // 중복 제거 키(같은 사건을 다시 보내면 같은 값)
    eventKey: uuid('event_key').notNull(),
    // 결제 상태 전이 사건의 종류(trade.payments type과 같은 값)와 내부 표시(ACCEPTED·CONFIRM_SENT 등)
    type: text('type').notNull(),
    // 밖으로 내보내는 사건인지. 내부 표시는 false
    exported: boolean('exported').notNull(),
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.paymentId, t.seq] }), check('payment_event_seq_check', sql`${t.seq} >= 1`)],
);

/** 승인 명령(실행기 PRF-181이 잡는다). order_saga_job과 같은 꼴이고 끝난 명령은 행을 지운다 */
export const paymentConfirmJob = pgTable(
  'payment_confirm_job',
  {
    paymentId: uuid('payment_id')
      .primaryKey()
      .references(() => payment.id),
    nextAttemptAt: at('next_attempt_at').notNull(),
    leaseOwner: text('lease_owner'),
    leaseUntil: at('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [index('payment_confirm_job_next_idx').on(t.nextAttemptAt), check('payment_confirm_job_attempts_check', sql`${t.attempts} >= 0`)],
);
