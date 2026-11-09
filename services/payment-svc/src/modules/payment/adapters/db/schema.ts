// payment DB의 표(docs/data.md §2 ERD payment·payment_event·payment_confirm_job과 §4 '결제 표 마이그레이션', docs/features/payment.md §2 '승인 명령 접수의 첫 구현',
// BUILD_ORDER PRF-180, ADR-0114). 마이그레이션은 0000_payment.sql이고, Outbox 부모 표는 Drizzle 0.45가 나타내지 못해 그 SQL에 손으로 덧붙였다.
// 다른 표(payment_entry_pause·payment_cancel 등)는 그 표를 쓰는 단계가 더한다.
// drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다. 상태 목록은 도메인 상수와 같은 차례로 글로 적는다.
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, date, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    // 회차의 입장 시작 시각(승인 명령이 싣는다, 선택). 입금 오류 되돌림의 새 기한을 입장 24시간 전으로 자른다(BUILD_ORDER PRF-190, 마이그레이션 0009)
    entryOpensAt: at('entry_opens_at'),
  },
  (t) => [
    uniqueIndex('payment_order_id_key').on(t.orderId),
    // 단독 조회 잡기(UNKNOWN과 입금 대기, 늦은 입금 확인을 건 FAILED, 되돌림 확인을 건 APPROVED, BUILD_ORDER HOT-151·HOT-152, 마이그레이션 0006·0007). 그 밖의 끝난 행은 인덱스에 없다
    index('payment_query_due_idx').on(t.nextQueryAt).where(sql`${t.status} IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR (${t.status} IN ('FAILED', 'APPROVED') AND ${t.nextQueryAt} IS NOT NULL)`),
    // 1시간 표시(docs/data.md §5.1 상태 쓸기 작업)
    index('payment_unknown_status_changed_idx').on(t.statusChangedAt).where(sql`${t.status} = 'UNKNOWN'`),
    // 웹훅의 결제 참조로 원장 찾기(docs/data.md §5.1, BUILD_ORDER HOT-150, 마이그레이션 0005)
    index('payment_pg_ref_idx').on(t.pg, t.pgPaymentRef),
    // 대사의 원장 쪽 단계와 해시 지우기(docs/data.md §5.1, BUILD_ORDER HOT-153, 마이그레이션 0008)
    index('payment_recon_approved_idx').on(t.pg, t.approvedAt, t.id).where(sql`${t.status} = 'APPROVED'`),
    index('payment_deposit_hash_idx').on(t.approvedAt).where(sql`${t.depositSecretHash} IS NOT NULL`),
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
    // 여유 부족으로 처음 미뤄진 시각(잡을 때 때가 된 지 1초 [가정] 넘었거나 서킷으로 미룸). 있으면 경로 지표의 retry_queue다(BUILD_ORDER PRF-200, 마이그레이션 0010)
    queuedAt: at('queued_at'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    // 채널별 잡기(다른 채널의 쌓인 행을 지나가지 않는다)
    index('payment_confirm_job_claim_idx').on(t.pg, t.nextAttemptAt, t.paymentId),
    check('payment_confirm_job_attempts_check', sql`${t.attempts} >= 0`),
    check('payment_confirm_job_pg_check', sql`${t.pg} IN (${PG_LIST})`),
  ],
);

/** 대사 실행(docs/data.md §2, BUILD_ORDER HOT-153, 마이그레이션 0008). 결제사·대상 날짜마다 한 행이고 단계 커서로 이어 한다 */
export const reconciliationRun = pgTable(
  'reconciliation_run',
  {
    id: uuid('id').primaryKey(),
    pg: text('pg').notNull(),
    reconDate: date('recon_date', { mode: 'string' }).notNull(),
    status: text('status').notNull(),
    stage: text('stage').notNull(),
    pgCursor: text('pg_cursor'),
    compareAfter: text('compare_after'),
    ledgerAfterAt: at('ledger_after_at'),
    ledgerAfterId: uuid('ledger_after_id'),
    listedCount: integer('listed_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    mismatchCount: integer('mismatch_count').notNull().default(0),
    // 지금 도는 실행의 소유자(파드)와 세대. 시작마다 세대가 오르고 쓰기의 조건이다(BUILD_ORDER HOT-153 코드 리뷰 H1)
    owner: text('owner').notNull(),
    generation: integer('generation').notNull().default(1),
    startedAt: at('started_at').notNull(),
    finishedAt: at('finished_at'),
  },
  (t) => [
    uniqueIndex('reconciliation_run_pg_date_key').on(t.pg, t.reconDate),
    check('reconciliation_run_pg_check', sql`${t.pg} IN (${PG_LIST})`),
    check('reconciliation_run_status_check', sql`${t.status} IN ('RUNNING', 'DONE', 'FAILED')`),
    check('reconciliation_run_stage_check', sql`${t.stage} IN ('LISTING', 'COMPARING', 'LEDGER', 'PULLING')`),
  ],
);

/** 대사의 작업 표(받기 단계의 결제사 거래, 실행이 끝나면 지운다, BUILD_ORDER HOT-153) */
export const reconciliationSeen = pgTable(
  'reconciliation_seen',
  {
    runId: uuid('run_id').notNull(),
    paymentRef: text('payment_ref').notNull(),
    orderRef: text('order_ref').notNull(),
    pgStatus: text('pg_status').notNull(),
    amount: integer('amount').notNull(),
    seenAt: at('seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.paymentRef] })],
);

/** 대사 불일치 기록(docs/data.md §2, BUILD_ORDER HOT-153, 마이그레이션 0008). 결제사·결제 참조·종류마다 한 행이다 */
export const reconciliationDiff = pgTable(
  'reconciliation_diff',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconciliationRun.id),
    pg: text('pg').notNull(),
    orderRef: text('order_ref').notNull(),
    paymentRef: text('payment_ref').notNull(),
    kind: text('kind').notNull(),
    ledgerStatus: text('ledger_status'),
    pgStatus: text('pg_status'),
    ledgerAmount: integer('ledger_amount'),
    pgAmount: integer('pg_amount'),
    state: text('state').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('reconciliation_diff_pg_ref_kind_key').on(t.pg, t.paymentRef, t.kind),
    index('reconciliation_diff_run_idx').on(t.runId),
    check('reconciliation_diff_pg_check', sql`${t.pg} IN (${PG_LIST})`),
    check(
      'reconciliation_diff_kind_check',
      sql`${t.kind} IN ('PG_APPROVED_NO_LEDGER', 'PG_MISMATCH', 'AMOUNT_MISMATCH', 'ORDER_MISMATCH', 'LEDGER_APPROVED_PG_NOT_PAID', 'LEDGER_APPROVED_NO_PG_RECORD', 'LEDGER_FAILED_PG_APPROVED', 'PARTIAL_CANCELED_AT_PG', 'LEDGER_CANCELED_PG_APPROVED', 'UNKNOWN_HANDED_OFF', 'UNKNOWN_CANCELED_CLOSED', 'UNREADABLE')`,
    ),
    check('reconciliation_diff_state_check', sql`${t.state} IN ('OPEN', 'HANDED_OFF', 'CLOSED')`),
  ],
);

/** 대체 결제사 전환 상태(docs/data.md §4 '결제사 선택 표', ADR-0143, BUILD_ORDER PRF-190, 마이그레이션 0009). 범위마다 한 행이고 판 번호가 지금보다 클 때만 쓴다 */
export const pgSwitch = pgTable(
  'pg_switch',
  {
    // 'PLATFORM' 또는 회차 ID(제어 gRPC의 scope와 같은 값)
    scope: text('scope').primaryKey(),
    active: boolean('active').notNull(),
    // 전환해 떠나는 결제사. 비면 어느 기준 결제사든 전환한다
    fromPg: text('from_pg'),
    // 옮겨 갈 결제사. 비면 미리 지정한 대체 결제사다
    toPg: text('to_pg'),
    version: bigint('version', { mode: 'number' }).notNull(),
    changedAt: at('changed_at').notNull(),
  },
  (t) => [
    check('pg_switch_scope_check', sql`${t.scope} = 'PLATFORM' OR ${t.scope} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`),
    check('pg_switch_from_pg_check', sql`${t.fromPg} IN (${PG_LIST})`),
    check('pg_switch_to_pg_check', sql`${t.toPg} IN (${PG_LIST})`),
    check('pg_switch_version_check', sql`${t.version} >= 1`),
  ],
);

/** 회차 결제사 지정의 사본(core-svc event.pg_primary·pg_fallback, docs/data.md §4 '결제사 선택 표', BUILD_ORDER PRF-190, 마이그레이션 0009). 설정 사건 소비자는 OPS-290이다 */
export const eventPgConfig = pgTable(
  'event_pg_config',
  {
    eventId: uuid('event_id').primaryKey(),
    pgPrimary: text('pg_primary').notNull(),
    pgFallback: text('pg_fallback'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('event_pg_config_primary_check', sql`${t.pgPrimary} IN (${PG_LIST})`),
    check('event_pg_config_fallback_check', sql`${t.pgFallback} IN (${PG_LIST})`),
    check('event_pg_config_distinct_check', sql`${t.pgFallback} IS NULL OR ${t.pgFallback} <> ${t.pgPrimary}`),
  ],
);

/** 새 결제 진입 정지 상태(docs/data.md §2·§4, ADR-0105, BUILD_ORDER PRF-200, 마이그레이션 0010). 결제사·채널마다 한 행이고 판 번호로 옛 판정자의 쓰기를 거절한다. 쓰는 코드는 PRF-201·PRF-202다 */
export const paymentEntryPause = pgTable(
  'payment_entry_pause',
  {
    pg: text('pg').notNull(),
    // 지금은 ALL(결제사 장애)만이다. 채널 상한 정지를 쓰는 단계가 CHECK를 풀어 준다
    channel: text('channel').notNull(),
    stage: text('stage').notNull(),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    since: at('since').notNull(),
    trialStartedAt: at('trial_started_at'),
    // 마지막으로 모두 연 시각(다시 멈추는 p99를 이 시각 뒤의 표본만 본다, ADR-0105 결정 6, 마이그레이션 0011)
    reopenedAt: at('reopened_at'),
    version: bigint('version', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pg, t.channel] }),
    check('payment_entry_pause_pg_check', sql`${t.pg} IN (${PG_LIST})`),
    check('payment_entry_pause_channel_check', sql`${t.channel} = 'ALL'`),
    check('payment_entry_pause_stage_check', sql`${t.stage} IN ('OPEN', 'PROBING', 'TRIAL')`),
    check('payment_entry_pause_reason_check', sql`${t.reason} IN ('PG_FAILURE', 'CHANNEL_WAIT')`),
    check('payment_entry_pause_version_check', sql`${t.version} >= 1`),
  ],
);

/** 시험 재개로 받은 결제와 첫 승인 결과(docs/data.md §2, ADR-0105, BUILD_ORDER PRF-200, 마이그레이션 0010). 쓰는 코드는 PRF-202다 */
export const paymentEntryTrial = pgTable(
  'payment_entry_trial',
  {
    orderId: uuid('order_id').primaryKey(),
    pg: text('pg').notNull(),
    admittedAt: at('admitted_at').notNull(),
    firstResult: text('first_result'),
    firstResultAt: at('first_result_at'),
    // 첫 승인 호출에 걸린 시간(5초 [가정] 안 결론을 잰다)
    firstCallMs: integer('first_call_ms'),
    // 첫 승인 호출을 시작한 시각. 호출 시작 순으로 앞 표본을 센다(느린 호출이 표본에서 빠지지 않게, BUILD_ORDER PRF-202 코드 리뷰, 마이그레이션 0011)
    firstCallAt: at('first_call_at'),
  },
  (t) => [
    index('payment_entry_trial_pg_admitted_idx').on(t.pg, t.admittedAt),
    check('payment_entry_trial_pg_check', sql`${t.pg} IN (${PG_LIST})`),
    check('payment_entry_trial_first_result_check', sql`${t.firstResult} IN ('APPROVED', 'DECLINED', 'FAILED', 'UNKNOWN')`),
    check('payment_entry_trial_first_call_ms_check', sql`${t.firstCallMs} >= 0`),
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
