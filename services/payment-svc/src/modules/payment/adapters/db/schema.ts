// payment DB의 표(docs/data.md §2 ERD payment·payment_event·payment_confirm_job과 §4 '결제 표 마이그레이션', docs/features/payment.md §2 '승인 명령 접수의 첫 구현',
// BUILD_ORDER PRF-180, ADR-0114). 마이그레이션은 0000_payment.sql이고, Outbox 부모 표는 Drizzle 0.45가 나타내지 못해 그 SQL에 손으로 덧붙였다.
// 다른 표(payment_entry_pause·payment_cancel 등)는 그 표를 쓰는 단계가 더한다.
// drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다. 상태 목록은 도메인 상수와 같은 차례로 글로 적는다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** 결제 원장 상태 일곱 값의 CHECK 목록(domain/confirm-command.ts PAYMENT_LEDGER_STATUSES와 같은 값·차례) */
const STATUS_LIST = sql.raw("'ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'");
/** 결제사 셋의 CHECK 목록 */
const PG_LIST = sql.raw("'TOSS', 'PORTONE', 'SIMULATOR'");
/** 분석용 실패 범주 일곱 값의 CHECK 목록(domain/payment-gateway.ts FailureCategory와 같은 값) */
const FAILURE_CATEGORY_LIST = sql.raw("'CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED', 'DEPOSIT_CANCELED'");

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
    // 입금 완료·되돌림 통보를 처음 받은 시각(입금 대기·되돌림 확인 행은 짧은 간격 조회의 기준, FAILED 행은 늦은 입금 확인을 걸었다는 표시. BUILD_ORDER HOT-151·HOT-152, 마이그레이션 0006)
    depositNotifiedAt: at('deposit_notified_at'),
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
    // 다음 단독 조회 시각. UNKNOWN과 입금 대기일 때만 채운다(BUILD_ORDER PRF-182·HOT-151, 마이그레이션 0002·0006)
    nextQueryAt: at('next_query_at'),
    // UNKNOWN 조회 실행기가 잡은 횟수. 다음 간격을 정한다
    queryAttempts: integer('query_attempts').notNull().default(0),
    // UNKNOWN이 1시간 [가정] 넘었다고 처음 알린 시각(두 번 알리지 않는다)
    overdueAt: at('overdue_at'),
    // 금액·주문 어긋남·결제사 쪽 취소의 SEV1을 낸 시각(결제마다 한 번, BUILD_ORDER PRF-182 코드 리뷰)
    anomalyLoggedAt: at('anomaly_logged_at'),
    // 포트원 결제 시도 ID(txId). 승인 본문의 검증값이고 조회 답이 이 시도의 것인지 대조한다. 비밀이 아니라 결과가 정해져도 지우지 않는다(BUILD_ORDER HOT-140 코드 리뷰, 마이그레이션 0004)
    pgTxId: text('pg_tx_id'),
    // 웹훅 조회 신호를 쓰거나 실행기가 잡은 마지막 시각. 결제별 최소 간격의 기준이다(BUILD_ORDER HOT-150 코드 리뷰, 마이그레이션 0005)
    queryTouchedAt: at('query_touched_at'),
  },
  (t) => [
    uniqueIndex('payment_order_id_key').on(t.orderId),
    // 단독 조회 잡기(UNKNOWN과 입금 대기, 늦은 입금 확인을 건 FAILED, 되돌림 확인을 건 APPROVED, BUILD_ORDER HOT-151·HOT-152, 마이그레이션 0006·0007). 그 밖의 끝난 행은 인덱스에 없다
    index('payment_query_due_idx').on(t.nextQueryAt).where(sql`${t.status} IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR (${t.status} IN ('FAILED', 'APPROVED') AND ${t.nextQueryAt} IS NOT NULL)`),
    // 1시간 표시(docs/data.md §5.1 상태 쓸기 작업)
    index('payment_unknown_status_changed_idx').on(t.statusChangedAt).where(sql`${t.status} = 'UNKNOWN'`),
    // 웹훅의 결제 참조로 원장 찾기(docs/data.md §5.1, BUILD_ORDER HOT-150, 마이그레이션 0005)
    index('payment_pg_ref_idx').on(t.pg, t.pgPaymentRef),
    // UNKNOWN과 입금 대기 행은 다음 조회 시각이 있어야 실행기가 잡는다(잡히지 않은 채 남는 행을 막는다, BUILD_ORDER HOT-151)
    check('payment_next_query_check', sql`${t.status} NOT IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR ${t.nextQueryAt} IS NOT NULL`),
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
    // 결제사 채널. 접수 때 원장의 pg를 그대로 쓴다. 잡기가 payment를 조인하지 않고 채널의 행만 본다(BUILD_ORDER PRF-183 코드 리뷰, 마이그레이션 0003)
    pg: text('pg').notNull(),
    nextAttemptAt: at('next_attempt_at').notNull(),
    leaseOwner: text('lease_owner'),
    leaseUntil: at('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    // 채널별 잡기(다른 채널의 쌓인 행을 지나가지 않는다)
    index('payment_confirm_job_claim_idx').on(t.pg, t.nextAttemptAt, t.paymentId),
    check('payment_confirm_job_attempts_check', sql`${t.attempts} >= 0`),
    check('payment_confirm_job_pg_check', sql`${t.pg} IN (${PG_LIST})`),
  ],
);

/** 웹훅 수신 기록(docs/data.md §2·§4 '웹훅 수신 기록', BUILD_ORDER HOT-150, 마이그레이션 0005). 중복만 거른다. 본문·상태를 두지 않는다 */
export const webhookReceipt = pgTable(
  'webhook_receipt',
  {
    pg: text('pg').notNull(),
    // 결제사별 중복 제거 키
    dedupKey: text('dedup_key').notNull(),
    // 찾은 원장 행. 승인 명령보다 먼저 온 웹훅을 받아야 해서 외래 키를 걸지 않는다
    paymentId: uuid('payment_id'),
    receivedAt: at('received_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pg, t.dedupKey] }),
    // 받은 지 7일 [가정] 지난 행 지우기(docs/data.md §5.1)
    index('webhook_receipt_received_at_idx').on(t.receivedAt),
    check('webhook_receipt_pg_check', sql`${t.pg} IN (${PG_LIST})`),
  ],
);
