// purchase DB의 주문 표(docs/data.md §2 ERD purchase_order·order_item·order_event·order_idempotency·payment_attempt와 §4 '주문 표 마이그레이션',
// docs/features/payment.md §3 '주문 저장소의 첫 구현', BUILD_ORDER PRF-160, ADR-0113·0114). 마이그레이션은 0003_order_tables.sql이다.
// - 주문 표는 나누지 않는다(ADR-0114). 쓰기가 많은 purchase_order에는 새 인덱스를 두지 않는다(data.md §5.1). 예외는 0004의 hold_id 유일 인덱스
//   (한 홀드에 주문 하나를 DB가 정한다, BUILD_ORDER PRF-161)와 0011의 열린 주문 부분 인덱스(구매 세션이 끝났을 때 그 세션의 열린 주문을 찾는다, BUILD_ORDER PRF-172)다.
// - order_event의 occurred_at BRIN 인덱스(매일 검사가 '전날 이력'을 찾는다, autosummarize = on), 상태 이력 지연 제약 트리거(order_status_has_event)와
//   Outbox 부모 표는 마이그레이션 SQL에만 손으로 적었다(Drizzle 표 정의로 적을 수 없다).
// - 결제 접수(PRF-162)는 0005로 결제 시도의 결제 참조 칸 다섯, 주문의 판 번호 seat_gen, Saga 작업 표 order_saga_job을 더했다(data.md §4 여섯 번째 마이그레이션).
//   Saga 1단계(PRF-165)는 0006으로 주문의 실패 사유 failure_reason, order_saga_job.step CHECK(RESERVE·CONFIRM·RELEASE)와 승인 명령 보낸 시각 confirm_sent_at을 더했다
//   (data.md §4 일곱 번째 마이그레이션, RELEASE·confirm_sent_at은 2026-11-05 리뷰 H1·M4).
//   결제 결과 반영(PRF-163)은 0007로 발권 재시도 큐 ticket_issue_job을 더했다(data.md §4 여덟 번째 마이그레이션).
//   주문 기준 되살리기(PRF-167)는 0008로 주문의 묶은 시각 pinned_at을 더했다(data.md §4 아홉 번째 마이그레이션).
//   발권 호출과 재시도 큐(PRF-170)는 0009로 ticket_issue_job에 임대 lease_until, ISSUE_DELAYED를 낸 시각 delayed_at, 발권 기한 넘김 신호를 낸 시각 overdue_at을
//   더했다(data.md §4 열 번째 마이그레이션). 셋 다 널 허용이고 새 인덱스는 두지 않는다(큐 행은 승인 뒤 발권까지만 남아 적다).
//   결제 결과 당기기(PRF-171, ADR-0140)는 0010으로 order_saga_job.step CHECK에 AWAIT(승인 명령 접수 뒤 결과 기다림)를 더하고 다음 점검 시각 pull_next_at을
//   더했다(널 허용, 새 인덱스 없음. 작업 표는 진행 중 주문만 남아 작다, data.md §5.1).
// - drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다(도메인 → inventory 공개 면 → Nest 모듈까지 끌려 온다).
//   상태 목록은 도메인 상수 ORDER_STATUSES와 같은 차례로 글로 적는다(inventory schema.ts의 seat_sale 상태 목록과 같은 방식).
import { idempotencyRecordTable } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** 주문 상태 열세 값의 CHECK 목록(domain/order.ts ORDER_STATUSES와 같은 값·차례) */
const STATUS_LIST = sql.raw(
  "'CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'",
);

export const purchaseOrder = pgTable(
  'purchase_order',
  {
    // UUIDv7(시간순, 부르는 쪽이 만든다)
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status').notNull(),
    // 서버가 계산한 금액(원)
    amount: integer('amount').notNull(),
    // 상태 이력 order_event의 마지막 번호. 주문 전이 함수가 상태를 바꾸는 UPDATE에서 1 올린다(ADR-0113)
    eventSeq: integer('event_seq').notNull(),
    // 반영한 마지막 결제 사건 순번(ADR-0146 결정 2)
    paymentEventSeq: bigint('payment_event_seq', { mode: 'number' }).notNull().default(0),
    // 예매자 성명·휴대폰 번호. 탈퇴 회원은 보존 스키마로 옮기고 비우므로 널을 허용한다(data.md §6)
    buyerName: text('buyer_name'),
    buyerPhone: text('buyer_phone'),
    // 클라이언트 Idempotency-Key 사본(멱등 확인은 order_idempotency)
    idempotencyKey: text('idempotency_key').notNull(),
    consentVersion: text('consent_version').notNull(),
    seatAssignment: text('seat_assignment').notNull(),
    createdAt: at('created_at').notNull(),
    // 주문을 만든 홀드(한 홀드에 주문 하나, 겹치면 409 hold-already-ordered). 실패 해제·다시 만들기가 주문 기준으로 쓴다(마이그레이션 0004, BUILD_ORDER PRF-161)
    holdId: uuid('hold_id').notNull(),
    // 주문을 만든 구매 세션(입장 토큰 jti). 결제 시도·접수가 '이 구매 세션의 주문'을 가린다(0004, PRF-161. 사건에는 CREATED에만 싣는다)
    purchaseSessionId: text('purchase_session_id').notNull(),
    // 결제 접수 때 적은 좌석 Redis 다시 만들기 판 번호(회차 슬롯 읽기의 gen, 명세 accept). 접수 전에는 비어 있다(0005, PRF-162).
    // 판매 예약은 이 번호가 seat_rebuild의 지금 번호와 같을 때만 커밋한다(PRF-165)
    seatGen: integer('seat_gen'),
    // FAILED일 때만 채우는 실패 사유(0006, PRF-165). Saga 1단계의 SEAT_TAKEN|QUOTA_EXCEEDED|STALE_GEN|EXPIRED|STORE_GONE과 결제 쪽 사유(PRF-163).
    // 값 목록이 PRF-163에서 늘어나므로 CHECK를 두지 않는다. 주문 결과 조회(PRF-163)가 화면 문구를 고르는 데 쓴다
    failureReason: text('failure_reason'),
    // Saga 묶기가 OK인 뒤 적는 시각(0008, BUILD_ORDER PRF-167). 다시 만들기가 결제를 접수했고(ACCEPTED) 묶인 주문의 좌석을
    // 원장 만료 시각과 상관없이 되살리는 근거다(docs/features/seat-hold.md §6 '주문 기준 되살리기', K1). 묶기 전이면 비어 있다
    pinnedAt: at('pinned_at'),
  },
  (t) => [
    // 한 홀드에 주문 하나(docs/data.md §5 '주문 생성'). 뒤 쪽 트랜잭션은 유일 확인에서 앞 쪽 커밋을 기다리고 23505로 끝난다
    uniqueIndex('purchase_order_hold_key').on(t.holdId),
    // 구매 세션이 끝났을 때 그 세션의 열린 주문을 찾는다(0011, ADR-0107 결정 2, BUILD_ORDER PRF-172). 조건을 두지 않는다:
    // status를 조건에 넣으면 상태를 바꾸는 UPDATE가 모두 HOT 갱신에서 빠져 쓰기 비용이 더 크다(data.md §5.1)
    index('purchase_order_session_idx').on(t.purchaseSessionId),
    check('purchase_order_status_check', sql`${t.status} in (${STATUS_LIST})`),
    check('purchase_order_amount_check', sql`${t.amount} >= 0`),
    check('purchase_order_event_seq_check', sql`${t.eventSeq} >= 1`),
    check('purchase_order_payment_event_seq_check', sql`${t.paymentEventSeq} >= 0`),
    check('purchase_order_seat_assignment_check', sql`${t.seatAssignment} in ('PICK', 'AUTO')`),
  ],
);

export const orderItem = pgTable(
  'order_item',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    // 주문 안 줄 번호(1부터)
    lineNo: integer('line_no').notNull(),
    seatId: uuid('seat_id').notNull(),
    // 등급 ID(주문 사건 items의 tierId)
    tier: text('tier').notNull(),
    // 구역 ID(주문 사건 items의 sectionId, ADR-0150)
    sectionId: text('section_id').notNull(),
    // 주문 때 가격 스냅샷(원)
    unitPrice: integer('unit_price').notNull(),
    // 발권 뒤 채운다(ticket DB라 외래 키 없음)
    ticketId: uuid('ticket_id'),
  },
  (t) => [
    primaryKey({ name: 'order_item_pkey', columns: [t.orderId, t.lineNo] }),
    // 한 주문에 같은 좌석은 한 줄(createOrder 입력 검사의 마지막 안전망, 리뷰 2026-11-05)
    uniqueIndex('order_item_seat_key').on(t.orderId, t.seatId),
    check('order_item_unit_price_check', sql`${t.unitPrice} >= 0`),
  ],
);

export const orderEvent = pgTable(
  'order_event',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    // 주문마다 1부터 빈틈 없이 늘어난다(purchase_order.event_seq와 같은 UPDATE에서 매긴다)
    seq: integer('seq').notNull(),
    // 이전 상태(첫 행 T1은 비움)
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    // 전이 번호 T1~T26
    cause: text('cause').notNull(),
    // account:<계정 ID> | admin:<관리 계정 ID> | system:<작업 이름>
    actor: text('actor').notNull(),
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'order_event_pkey', columns: [t.orderId, t.seq] }),
    // 이력 번호는 1부터(빈틈 검사 '행 수 = 마지막 번호'가 0·음수 번호로 속지 않게)
    check('order_event_seq_check', sql`${t.seq} >= 1`),
    // 널(첫 행)은 CHECK를 지난다
    check('order_event_from_status_check', sql`${t.fromStatus} in (${STATUS_LIST})`),
    check('order_event_to_status_check', sql`${t.toStatus} in (${STATUS_LIST})`),
  ],
);

/** 주문 생성·결제 시도 시작·결제 접수의 멱등 기록(계정 × 작업 범위, 기술 검토 중간-046) */
export const orderIdempotency = idempotencyRecordTable(['CREATE_ORDER', 'START_PAYMENT', 'ACCEPT_PAYMENT'], 'order_idempotency');

export const paymentAttempt = pgTable(
  'payment_attempt',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    pg: text('pg').notNull(),
    // 토스 orderId 또는 포트원 paymentId
    pgOrderRef: text('pg_order_ref'),
    status: text('status').notNull(),
    createdAt: at('created_at').notNull(),
    // 결제 참조 칸(0005, PRF-162). 결제 접수(READY → ACCEPTED)에서 채우고, Saga가 승인 명령을 접수시키거나 과금 없이 끝나면 지운다(PRF-165).
    // 5년 보관은 payment-svc 결제 원장이다. 로그·사건·응답에 싣지 않는다(data-classification '결제 참조', ADR-0044·0053)
    // 토스·시뮬레이터 paymentKey
    pgPaymentKey: text('pg_payment_key'),
    // 포트원 txId
    pgTxId: text('pg_tx_id'),
    // 포트원 paymentToken
    pgPaymentToken: text('pg_payment_token'),
    // 결제창 인증 완료 시각(= 접수 시각. 인증만 따로 알리는 API가 없다). 승인 기한(인증 + 10분)의 기준
    authenticatedAt: at('authenticated_at'),
    // 결제 접수 시각
    acceptedAt: at('accepted_at'),
  },
  (t) => [
    // 활성(READY·ACCEPTED) 결제 시도는 주문마다 하나
    uniqueIndex('payment_attempt_active_key')
      .on(t.orderId)
      .where(sql`${t.status} in ('READY', 'ACCEPTED')`),
    // 주문의 모든 시도(끝난 것 포함)를 찾고, 주문 행을 지울 때 외래 키 검사가 표를 다 훑지 않게(리뷰 2026-11-05)
    index('payment_attempt_order_id_idx').on(t.orderId),
    check('payment_attempt_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('payment_attempt_status_check', sql`${t.status} in ('READY', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED')`),
  ],
);

/**
 * 주문 Saga 작업 표(0005, BUILD_ORDER PRF-162, data.md §4 여섯 번째 마이그레이션. ticket_issue_job과 같은 꼴).
 * 결제 접수가 같은 트랜잭션에서 한 행을 넣고(step 'RESERVE'), Saga 실행기(PRF-165)가 next_attempt_at이 지난 행을 임대(lease_until)로 잡아 돈다.
 * 주문 ID가 기본 키라 한 주문에 작업 행은 하나뿐이다(두 탭이 겹쳐도 둘이 될 수 없다, data.md §5 '결제 접수').
 * step 값은 RESERVE(묶기·판 번호 대조·판매 예약)·CONFIRM(승인 명령)·RELEASE(실패 기록 뒤 좌석 Redis 실패 해제) 셋(CHECK, 0006, PRF-165)과
 * AWAIT(승인 명령이 접수돼 결과를 기다림. 결제 결과 당기기가 찾는다, 0010, PRF-171)이다.
 * confirm_sent_at은 승인 명령을 처음 보내기 바로 전에 적고 커밋한 시각이다(있으면 purchase는 혼자 T11을 하지 않는다, 2026-11-05 리뷰 H1).
 * pull_next_at은 결제 결과 당기기의 다음 점검 시각이다(비었으면 아직 묻지 않았다. 당기기가 잡을 때 지금 + 5초 [가정]을 쓴다, 0010, PRF-171)
 */
export const orderSagaJob = pgTable(
  'order_saga_job',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => purchaseOrder.id),
    // 회차(쓸기·Kafka 키를 회차로 묶는다)
    eventId: uuid('event_id').notNull(),
    // Saga 단계(접수는 'RESERVE'로 넣고, 판매 예약 트랜잭션이 'CONFIRM'으로, 실패 기록 트랜잭션이 'RELEASE'로 바꾼다. PRF-165)
    step: text('step').notNull(),
    // 이 단계를 해 본 횟수
    attempts: integer('attempts').notNull().default(0),
    // 다음에 해 볼 시각(쓸기 색인)
    nextAttemptAt: at('next_attempt_at').notNull(),
    // 잡은 실행기의 임대 끝 시각(잡지 않았으면 비움)
    leaseUntil: at('lease_until'),
    createdAt: at('created_at').notNull(),
    // 승인 명령을 처음 보내기 바로 전에 적은 시각(커밋한 뒤 보낸다). 비었으면 한 번도 보내지 않았다(0006, PRF-165 리뷰 H1)
    confirmSentAt: at('confirm_sent_at'),
    // 결제 결과 당기기의 다음 점검 시각(0010, PRF-171, ADR-0140 결정 1). 비었으면 아직 묻지 않았다. 당기기가 잡을 때 지금 + 5초 [가정],
    // 결과가 오래 없거나 보류·취소 상태면 지금 + 60초 [가정]를 쓴다. Saga 실행기는 이 칸을 읽거나 쓰지 않는다
    pullNextAt: at('pull_next_at'),
  },
  (t) => [
    index('order_saga_job_next_attempt_idx').on(t.nextAttemptAt),
    // 단계 값 넷(RESERVE·CONFIRM·RELEASE는 0006, AWAIT는 0010). 도메인 SAGA_STEPS와 같은 값·차례
    check('order_saga_job_step_check', sql`${t.step} in ('RESERVE', 'CONFIRM', 'RELEASE', 'AWAIT')`),
  ],
);

/**
 * 발권 재시도 큐(0007, BUILD_ORDER PRF-163, data.md §2 ERD ticket_issue_job·§4 여덟 번째 마이그레이션, ADR-0106).
 * 결제 승인을 반영하는 트랜잭션(판매 행 SOLD, 주문 APPROVED)이 한 행을 넣고, 발권(CONFIRMED)·보상(COMPENSATED)과 같은 트랜잭션에서 지운다.
 * 발권 호출·다시 하기는 PRF-170이다. 주문 ID가 기본 키라 한 주문에 행은 하나뿐이다(order_saga_job과 같은 꼴).
 * 발권 실행기(PRF-170)는 order_saga_job과 같이 짧은 트랜잭션에서 FOR UPDATE SKIP LOCKED로 골라 임대(lease_until)를 쓰고 커밋한 뒤, 잠금 밖에서 ticket-svc를 부른다(0009).
 */
export const ticketIssueJob = pgTable(
  'ticket_issue_job',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => purchaseOrder.id),
    // 회차(쓸기·Kafka 키를 회차로 묶는다)
    eventId: uuid('event_id').notNull(),
    // 발권 시도 수
    attempts: integer('attempts').notNull().default(0),
    // 다음 시도 시각(1초에서 두 배씩 최대 60초 간격 [가정]). 다시 보내도 결과가 같은 오류면 비워 자동 재시도를 멈춘다(그래서 널 허용)
    nextAttemptAt: at('next_attempt_at'),
    // 발권 기한 = 결제 승인 + 30분 [가정]. 넘기면 SEV1과 CS 처리함 TICKET_NOT_ISSUED
    issueDueAt: at('issue_due_at').notNull(),
    // 마지막 gRPC 상태 코드
    lastError: text('last_error'),
    // 60초 [가정] 넘게 남으면 SEV2와 trade.orders ISSUE_DELAYED
    createdAt: at('created_at').notNull(),
    // 잡은 발권 실행기의 임대 끝 시각(잡지 않았으면 비움). 잡기는 30초 [가정]를 쓰고, 성공·다시 보내기·멈추기가 비운다(0009, PRF-170)
    leaseUntil: at('lease_until'),
    // trade.orders ISSUE_DELAYED를 낸 시각. 비었으면 아직 내지 않았다(주문마다 한 번, 0009, PRF-170)
    delayedAt: at('delayed_at'),
    // 발권 기한(issue_due_at) 넘김 신호(SEV1 오류 로그·지표)를 낸 시각. 비었으면 아직 내지 않았다(주문마다 한 번, 0009, PRF-170)
    overdueAt: at('overdue_at'),
  },
  (t) => [index('ticket_issue_job_next_attempt_idx').on(t.nextAttemptAt)],
);
