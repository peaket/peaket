// booking 모듈의 포트(바깥 저장소·지표와 닿는 면, BUILD_ORDER PRF-160·PRF-161).
import type { OrderEventMessage, OrderItem, OrderStatus, OrderRow, CreatedExtras, SeatAssignment, TransitionId } from './order.js';
import type {
  PaymentEventType,
  PaymentFailureCategory,
  PaymentResultHoldKind,
  PaymentResultHoldReason,
  PaymentResultHoldSeverity,
  PaymentResultOrderView,
} from './payment-result.js';
import type { PaymentStatusBody, PaymentStatusView } from './payment-status.js';
import type { FallbackReason, MisconfiguredReason, RecheckAnswer } from './recheck.js';
import type { SagaFailTransition, SagaFailureReason, SagaStep } from './saga.js';

/** 주문 사건을 Outbox 값 바이트로 바꾼다. Avro 인코더(BAS-030)가 오기 전까지 JSON 대역이다 */
export interface OrderEventCodec {
  encode(message: OrderEventMessage): Uint8Array;
}

/** 새 주문(T1). id는 부르는 쪽이 만든 UUIDv7이다 */
export interface NewOrder {
  readonly id: string;
  readonly accountId: string;
  readonly eventId: string;
  /** 서버가 계산한 금액(원, 0 이상 정수) */
  readonly amount: number;
  readonly buyerName: string;
  readonly buyerPhone: string;
  /** 클라이언트 Idempotency-Key 사본(소문자 UUID v4) */
  readonly idempotencyKey: string;
  /** 두 동의에 보인 고지 문안의 판(1~32자, ^[0-9A-Za-z._-]+$) */
  readonly consentVersion: string;
  readonly seatAssignment: SeatAssignment;
  /** 줄 번호는 이 차례로 1부터 매긴다. 1~10개 [가정: 주문 하나 10석 이하], 좌석 ID는 겹치지 않는다 */
  readonly items: readonly OrderItem[];
  /** 행위자(ACTOR_PATTERN). 주문 생성은 보통 account:<계정 ID> */
  readonly actor: string;
  readonly created: CreatedExtras;
  /** 주문을 만든 홀드 ID(소문자 UUID, purchase_order.hold_id 유일. 마이그레이션 0004, BUILD_ORDER PRF-161) */
  readonly holdId: string;
  /** 주문을 만든 구매 세션 ID(입장 토큰 jti, purchase_order.purchase_session_id). created.purchaseSessionId와 같은 값을 준다(PRF-161) */
  readonly purchaseSessionId: string;
}

export interface TransitionInput {
  readonly orderId: string;
  readonly transition: TransitionId;
  readonly actor: string;
  /** 결제 결과 반영 전이(T9~T17·T21, PAYMENT_RESULT_TRANSITIONS)에만 준다. 양의 정수(payment_event.seq). T11은 없어도 된다(Saga의 승인 기한 넘김, PRF-165) */
  readonly paymentEventSeq?: number;
}

export type TransitionResult =
  | {
      readonly status: 'APPLIED';
      /** 이번 이력 번호 */
      readonly seq: number;
      /** 전이 뒤의 주문 행 */
      readonly order: OrderRow;
      /** 넣은 Outbox 행 ID(사건이 없는 전이면 undefined) */
      readonly outboxId?: string;
    }
  | {
      /** 전이하지 않았다. NOT_FOUND: 주문 없음, STATUS: 지금 상태가 출발이 아님, PAYMENT_SEQ: 그 순번 이상을 이미 반영함 */
      readonly status: 'STALE';
      readonly reason: 'NOT_FOUND' | 'STATUS' | 'PAYMENT_SEQ';
      readonly current?: OrderStatus;
    };

/** 매일 상태·이력 검사에서 어긋난 주문 하나 */
export interface OrderHistoryMismatch {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly eventSeq: number;
  /** 이력의 마지막 번호 */
  readonly lastSeq: number;
  /** 이력 행 수 */
  readonly rows: number;
  /** 마지막 이력의 도착 상태 */
  readonly lastTo: OrderStatus;
}

export interface OrderHistoryReport {
  /** 본 주문 수 */
  readonly checked: number;
  readonly mismatched: readonly OrderHistoryMismatch[];
}

/** booking 모듈의 지표 */
export interface OrderSignals {
  /** 매일 검사에서 어긋난 주문 수(order_history_mismatch) */
  historyMismatch(count: number): void;
  /**
   * 주문 생성의 본인확인 재확인이 답을 받지 못해 토큰 판정으로 간 수(카운터 purchase_identity_recheck_fallback_total{reason}, 대체 판정마다 1, ADR-0055, PRF-161).
   * 토큰 판정이 통과든 거부든 센다. 선택 메서드다(없는 구현은 버린다. 매일 검사만 쓰는 대역이 갖지 않아도 되게)
   */
  identityFallback?(reason: FallbackReason): void;
  /**
   * 주문을 커밋한 뒤 구매 세션 Paying 표시가 다시 불러도 실패한 수(카운터 purchase_order_paying_mark_failed_total, 이름표 없음, 리뷰 고침 M3 2026-11-05).
   * 선택 메서드다(없는 구현은 버린다)
   */
  payingMarkFailed?(): void;
}

// ---- 주문 생성 POST /v1/orders(docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161) ----
// 검사 차례: (플랫폼 가드) → OrderSessions.get → OrderWrites.findCommitted → SaleConfigs.get·OrderHolds.check → 동의 → 예매자
// → IdentityRecheck.check → BookingRestrictions.read → 금액 → ContactRefs.compute(재확인이 circuit_open·deadline·unavailable이면 건너뜀) → OrderWrites.create(한 트랜잭션)
// → OrderSessions.markPaying(실패면 남은 시간 안에서 한 번 더, 그래도 실패면 경고·지표) → 201.
// 좌석 Redis 장애는 OrderHolds가 STORE_UNAVAILABLE로 답하고, 나머지 좌석 Redis 포트(OrderSessions·BookingRestrictions)는 OrderSeatStoreUnavailable을 던진다(503 seat-store-unavailable).

/**
 * 한 번만 처리할 요청의 범위·키·지문(platform IdempotencyRequest와 같은 모양. 도메인은 플랫폼을 모르므로 여기 다시 적는다).
 * 범위는 계정 × 작업 'CREATE_ORDER'(order_idempotency)다
 */
export interface OrderRequestOnce {
  readonly accountRef: string;
  readonly operation: string;
  /** 소문자 UUID v4 */
  readonly key: string;
  /** 요청 지문(SHA-256, 32바이트) */
  readonly requestHash: Uint8Array;
}

/** 좌석 Redis를 잠시 쓸 수 없다(일시 장애·메모리 부족). 쓰임새가 503 seat-store-unavailable(Retry-After 2초)로 답한다 */
export class OrderSeatStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('좌석 Redis를 잠시 쓸 수 없다', cause === undefined ? undefined : { cause });
    this.name = 'OrderSeatStoreUnavailable';
  }
}

/** 응답 Order와 멱등 재생에 쓰는 주문 모습(주문 행과 항목) */
export interface OrderView {
  readonly orderId: string;
  readonly amount: number;
  readonly status: OrderStatus;
  /** 줄 번호 차례 */
  readonly items: readonly OrderItem[];
}

/** 구매 세션 하나(inventory PurchaseSessionInfo와 같은 모양) */
export interface OrderSessionView {
  /** 구매 세션 ID(= 입장 토큰 jti, @CurrentPurchaseSession()의 참조) */
  readonly sessionId: string;
  readonly accountId: string;
  /** 구매 세션이 묶인 회차 */
  readonly eventId: string;
  /** 여정 ID(UUIDv7, 입장 토큰 jny). CREATED 사건의 journeyId */
  readonly journeyId: string;
}

/** 구매 세션 읽기와 Paying 표시(운영은 inventory의 StoredPurchaseSessions.get·RedisPurchaseSessionStore.setPaying을 잇는다) */
export interface OrderSessions {
  /**
   * 구매 세션 상태. 없거나 최대 체류가 지났으면 undefined(쓰임새가 401 purchase-session-ended).
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애
   */
  get(sessionId: string): Promise<OrderSessionView | undefined>;
  /**
   * 주문을 커밋한 뒤 구매 세션을 Paying으로 표시한다(setPaying(jti, true), 결제가 끝날 때까지 유휴로 끝나지 않게, POL-009).
   * 세션이 있으면 true, 없으면 false.
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(쓰임새는 응답을 바꾸지 않는다)
   */
  markPaying(sessionId: string, o?: { deadlineMs?: number }): Promise<boolean>;
}

/** 홀드 좌석 하나(좌석맵 판의 등급·구역을 붙인 것) */
export interface HeldSeat {
  readonly seatId: string;
  readonly tierId: string;
  readonly sectionId: string;
}

/** 홀드 확인 입력 */
export interface OrderHoldQuery {
  /** 구매 세션의 회차 */
  readonly eventId: string;
  /** 구매 세션 ID(홀드 Hash의 psid와 같아야 한다) */
  readonly purchaseSessionId: string;
  /** 요청한 계정(홀드 Hash의 owner와 같아야 한다) */
  readonly accountId: string;
  /** 본문 holdId(모양은 보지 않은 글 그대로) */
  readonly holdId: string;
}

/** 홀드 확인 결과 */
export type OrderHoldCheck =
  /** heldAtMs: 홀드를 잡은 시각(홀드 Hash heldAt, 좌석마다 같다). seats: 구매 세션에 기록한 좌석 차례(좌석 ID 오름차순) */
  | { readonly status: 'OK'; readonly heldAtMs: number; readonly seats: readonly HeldSeat[] }
  /** 목록에 없음·남의 것·다른 회차·끝난 것을 가리지 않는다(404 not-found, 판매 종료 뒤면 410 sale-ended) */
  | { readonly status: 'NOT_FOUND' }
  /** 좌석 Redis 일시 장애·메모리 부족, 그 회차 좌석 저장소가 준비되지 않음(세대 키 없음), 좌석맵 판 없음(503 seat-store-unavailable) */
  | { readonly status: 'STORE_UNAVAILABLE' };

/**
 * 주문 생성의 홀드 확인(inventory가 구현한다: adapters/redis-order-holds.ts·memory-order-holds.ts, Lua 계약은 adapters/order-hold-lua.ts).
 * 본문의 holdId가 그 구매 세션의 홀드 목록(s:session:{sid}의 h:{holdId})에 있고, 그 좌석들의 홀드 Hash가 모두 같은 holdId·owner(계정)·psid(구매 세션)이며
 * 만료 전(Redis TIME 기준)인지 본다. 읽기만 한다(아무것도 쓰지 않는다)
 */
export interface OrderHolds {
  /** @param o.deadlineMs 좌석 Redis 호출 하나의 마감(ms, 1 이상 정수). 없으면 플랫폼 기본 */
  check(q: OrderHoldQuery, o?: { deadlineMs?: number }): Promise<OrderHoldCheck>;
}

/** 회차의 판매 설정(좌석맵 판 파일의 saleEndsAt·tierPrices) */
export interface SaleConfig {
  /** 판매 종료 시각(epoch ms, 공연 시작 24시간 전, ADR-0064) */
  readonly saleEndsAtMs: number;
  /** 등급 ID → 가격(원, 0 이상 정수). 판 파일에 tierPrices가 없으면 빈 객체다(모든 등급의 가격이 없다) */
  readonly tierPrices: Readonly<Record<string, number>>;
}

/** 회차 판매 설정 읽기(운영은 inventory의 좌석맵 판(LayoutSeatMap.config)을 잇는다, adapters/seat-map-sale-configs.ts) */
export interface SaleConfigs {
  /** 그 회차의 판매 설정. 좌석맵 판이 없으면 undefined(쓰임새가 503 seat-store-unavailable). 던지지 않는다 */
  get(eventId: string): Promise<SaleConfig | undefined>;
}

/** 본인확인 재확인 입력 */
export interface IdentityRecheckQuery {
  readonly accountId: string;
  /** 액세스 토큰의 로그인 세션 ID(sid, Principal.sessionId) */
  readonly sessionId: string;
  /** 이 호출 전체(한 번 다시 묻기 포함)의 데드라인(ms). 쓰임새가 min(150 [가정], 요청의 남은 시간)으로 준다 */
  readonly deadlineMs: number;
}

/**
 * identity-svc IdentityService.GetVerificationStatus(adapters/grpc-identity.ts). 차단기·다시 묻기·gRPC 상태 → RecheckFailure 바꾸기는 어댑터가 한다.
 * 던지지 않는다(모든 실패는 FAILED)
 */
export interface IdentityRecheck {
  check(q: IdentityRecheckQuery): Promise<RecheckAnswer>;
}

/**
 * identity-svc ContactRefService.ComputeContactRef(adapters/grpc-identity.ts). E.164 번호로 한 번 부르고 다시 묻지 않는다.
 * @returns 조사용 연락처 가명(키 판 접두어 + base64url). 어떤 실패·시간 초과·빈 답이든 undefined(쓰임새가 contactRef를 비우고 refMissing을 참으로). 던지지 않는다
 */
export interface ContactRefs {
  compute(phoneE164: string, deadlineMs: number): Promise<string | undefined>;
}

/** 예매 제한 사본 하나(s:rst:{account} Hash의 st·until) */
export interface BookingRestriction {
  readonly st: 'ACTIVE' | 'LIFTED';
  /** 끝 시각(유닉스 밀리초). 없으면 끝 없음 */
  readonly untilMs?: number;
}

/** 예매 제한 사본 읽기(좌석 Redis s:rst:{account}, adapters/redis-booking-restrictions.ts). 쓰는 쪽(SetBookingRestriction)은 GAT-310이다 */
export interface BookingRestrictions {
  /**
   * 사본(st·until·rid·ver 네 칸)이 모두 없으면 undefined(제한 없음). 다른 칸이 있는데 st가 없거나, st가 ACTIVE·LIFTED가 아니거나, until이 0 이상 정수 글이 아니면 망가진 사본이라 Error.
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애
   */
  read(accountId: string): Promise<BookingRestriction | undefined>;
}

/** 커밋된 멱등 기록 읽기 결과(트랜잭션 밖, 검사 차례의 셋째) */
export type CommittedOrderLookup =
  /** 같은 키·같은 지문으로 커밋한 주문이 있다: 처음 201을 그대로 돌려준다(홀드가 그사이 끝나도 같은 답) */
  | { readonly status: 'COMMITTED'; readonly order: OrderView }
  /** 같은 키에 다른 지문(422 idempotency-key-reused) */
  | { readonly status: 'MISMATCH' }
  /** 기록이 없거나, 처리 중(result_ref 비어 있음)이거나, 보관 기간(24시간 [가정])이 지났다: 검사를 이어 간다 */
  | { readonly status: 'NONE' };

/** 한 트랜잭션(멱등 기록 잡기 → 주문 만들기) 결과 */
export type OrderCreateOutcome =
  /** 이번에 만들었다 */
  | { readonly status: 'CREATED'; readonly order: OrderView }
  /** 그사이 같은 키·같은 지문의 요청이 먼저 커밋했다: 그 주문을 그대로 돌려준다 */
  | { readonly status: 'REPLAYED'; readonly order: OrderView }
  /** 같은 홀드로 만든 주문이 이미 있다(purchase_order_hold_key 유일 위반 23505, 409 hold-already-ordered). 트랜잭션째 되돌렸다 */
  | { readonly status: 'HOLD_ALREADY_ORDERED' };

/** 주문 쓰기(운영은 adapters/db/drizzle-order-writes.ts: purchase DB 트랜잭션 하나에 IdempotencyStore.run과 DrizzleOrderStore.createOrder를 묶는다) */
export interface OrderWrites {
  /**
   * 커밋된 멱등 기록(order_idempotency, 범위 계정 × CREATE_ORDER × 키)을 읽는다. 아무것도 쓰지 않는다.
   * 지문은 상수 시간으로 견준다
   */
  findCommitted(once: OrderRequestOnce): Promise<CommittedOrderLookup>;
  /**
   * 한 트랜잭션: 멱등 기록 잡기(첫 쓰기) → createOrder(주문 행·항목·이력 1·Outbox CREATED) → 결과 참조 = 주문 ID.
   * @throws ProblemError 409 idempotency-request-in-progress(같은 키가 1초 [가정] 안에 끝나지 않음), 422 idempotency-key-reused(그사이 다른 지문이 커밋함)
   *   — 플랫폼 IdempotencyStore가 던지는 그대로
   * @throws RangeError 입력이 틀림(코드 오류, DB에 가지 않는다)
   * @throws Error 그 밖의 DB 오류(문장 시간 초과 포함, 트랜잭션째 되돌렸다)
   * @param o.deadlineMs 트랜잭션의 문장 시간 초과(리뷰 고침 L4). 트랜잭션은 read committed다(리뷰 고침 L3)
   */
  create(once: OrderRequestOnce, order: NewOrder, o?: TransactionCallOptions): Promise<OrderCreateOutcome>;
}

/** 주문 생성의 보안·설정 로그(서비스 로그 한 줄씩. 번호 원문·토큰은 싣지 않는다). 던지지 않는다 */
export interface OrderLog {
  /** 재확인 대체 판정 한 줄(계정·까닭, 주문 ID는 아직 없어 멱등 키, ADR-0055) */
  identityFallback(e: { readonly accountId: string; readonly reason: FallbackReason; readonly passed: boolean; readonly idempotencyKey: string }): void;
  /**
   * 설정 오류 한 줄(kind config): 가격 없는 등급(500), 등급 가격 합이 int4를 넘음(500, 리뷰 고침 L5),
   * 재확인 PERMISSION_DENIED·INVALID_ARGUMENT·정본 목록 밖(unexpected)(503, SEV2)
   */
  configError(
    e:
      | { readonly what: 'tier_price_missing'; readonly eventId: string; readonly tierId: string }
      | { readonly what: 'amount_out_of_range'; readonly eventId: string }
      | { readonly what: 'identity_misconfigured'; readonly reason: MisconfiguredReason },
  ): void;
  /** 커밋 뒤 Paying 표시가 다시 불러도 실패했다(warn 한 줄, 구매 세션 ID·주문 ID만. 세션 정리 반복이 결제 중 유휴로 끝낼 수 있어 알린다, POL-009) */
  payingMarkFailed(e: { readonly purchaseSessionId: string; readonly orderId: string }): void;
}

// ---- 결제 접수 POST /v1/orders/{orderId}/payment-acceptance(docs/features/payment.md §2 '결제 접수의 첫 구현', docs/data.md §5 '결제 접수', BUILD_ORDER PRF-162) ----
// 검사 차례: (플랫폼 가드) → OrderSessions.get → OrderAcceptReads.findCommitted → OrderAcceptReads.order → 상태 표 → OrderAcceptReads.activeAttempt 대조
// → SeatSlotReads.read(회차 슬롯 읽기) → OrderAcceptWrites.accept(한 트랜잭션) → 202(본문 없음).
// Saga 1단계(묶기·판 번호 대조·판매 예약·승인 명령)는 PRF-165다. 접수는 order_saga_job 행을 넣는 데서 끝난다.

/** 결제사(payment_attempt.pg의 CHECK 값) */
export type PaymentPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';

/**
 * 결제 접수 본문(openapi PaymentAccept, pg로 갈리는 oneOf). 토스·시뮬레이터는 성공 URL의 paymentKey·amount,
 * 포트원은 결제창 응답의 paymentId·paymentToken·txId다(payment §2.2 '결제사별 접수 계약')
 */
export type PaymentAcceptBody =
  | { readonly pg: 'TOSS' | 'SIMULATOR'; readonly paymentKey: string; readonly amount: number }
  | { readonly pg: 'PORTONE'; readonly paymentId: string; readonly paymentToken: string; readonly txId: string };

/** 결제 접수가 보는 주문 모습(주문 행의 칸 몇 개) */
export interface AcceptOrderView {
  readonly orderId: string;
  readonly accountId: string;
  readonly eventId: string;
  /** 주문을 만든 구매 세션(purchase_order.purchase_session_id, 0004) */
  readonly purchaseSessionId: string;
  readonly status: OrderStatus;
  /** 서버가 계산한 금액(원). 토스·시뮬레이터 본문 amount와 견준다 */
  readonly amount: number;
}

/** 그 주문의 활성 결제 시도(READY·ACCEPTED 가운데 하나, payment_attempt_active_key 부분 유일) */
export interface ActiveAttemptView {
  readonly attemptId: string;
  readonly pg: PaymentPg;
  readonly status: 'READY' | 'ACCEPTED';
  /** 토스 orderId 또는 포트원 paymentId(pay-{orderId}). 칸이 비었으면 undefined */
  readonly pgOrderRef?: string;
  /** 시도를 만든 시각(epoch ms). 40분 [가정](결제창 인증 유효 30분 + 승인 기한 10분)을 넘으면 없는 시도로 본다(ADR-0107) */
  readonly createdAtMs: number;
}

/** 커밋된 결제 접수 멱등 기록 읽기 결과(트랜잭션 밖, 범위 계정 × ACCEPT_PAYMENT × 키) */
export type CommittedAcceptLookup =
  /** 같은 키·같은 지문으로 커밋한 접수가 있다: 처음 202를 그대로 돌려준다(주문이 그 뒤 상태로 갔어도 같은 답). orderId = result_ref */
  | { readonly status: 'COMMITTED'; readonly orderId: string }
  /** 같은 키에 다른 지문(422 idempotency-key-reused) */
  | { readonly status: 'MISMATCH' }
  /** 기록이 없거나, 처리 중(result_ref 비어 있음)이거나, 보관 기간(24시간 [가정])이 지났다: 검사를 이어 간다 */
  | { readonly status: 'NONE' };

/** 결제 접수의 읽기(트랜잭션 밖, 운영은 adapters/db/drizzle-order-accepts.ts). 아무것도 쓰지 않는다 */
export interface OrderAcceptReads {
  /** 커밋된 멱등 기록(order_idempotency, 범위 계정 × ACCEPT_PAYMENT × 키)을 읽는다. 지문은 상수 시간으로 견준다 */
  findCommitted(once: OrderRequestOnce): Promise<CommittedAcceptLookup>;
  /** 주문 하나. 없거나 orderId가 소문자 UUID가 아니면 undefined(쓰임새가 404, 남의 것과 가리지 않는다) */
  order(orderId: string): Promise<AcceptOrderView | undefined>;
  /** 그 주문의 활성 결제 시도(READY·ACCEPTED). 없으면 undefined */
  activeAttempt(orderId: string): Promise<ActiveAttemptView | undefined>;
}

/** 결제 참조(결제 시도에 저장하는 값. 로그·사건·응답에 싣지 않는다, data-classification '결제 참조', ADR-0044·0053) */
export type PaymentRefs =
  /** 토스·시뮬레이터: payment_attempt.pg_payment_key */
  | { readonly pg: 'TOSS' | 'SIMULATOR'; readonly paymentKey: string }
  /** 포트원: pg_tx_id·pg_payment_token(paymentId는 이미 pg_order_ref와 같음을 봤다) */
  | { readonly pg: 'PORTONE'; readonly txId: string; readonly paymentToken: string };

/** 한 트랜잭션의 입력 */
export interface AcceptInput {
  readonly orderId: string;
  /** 대조를 지난 READY 시도 */
  readonly attemptId: string;
  /** 주문의 회차(order_saga_job.event_id) */
  readonly eventId: string;
  readonly refs: PaymentRefs;
  /** 회차 슬롯 읽기의 다시 만들기 판 번호(purchase_order.seat_gen, 1 이상 정수) */
  readonly seatGen: number;
  /** 행위자(ACTOR_PATTERN). 결제 접수는 account:<계정 ID> */
  readonly actor: string;
}

/** 한 트랜잭션 결과 */
export type AcceptOutcome =
  /** 이번에 접수했다(시도 ACCEPTED, 주문 T3·T4, seat_gen, Saga 작업 행 커밋) */
  | { readonly status: 'ACCEPTED' }
  /** 그사이 같은 키·같은 지문의 요청이 먼저 커밋했다: 처음 202를 그대로 */
  | { readonly status: 'REPLAYED' }
  /**
   * 조건부 UPDATE가 0행이라 트랜잭션째 되돌렸다(멱등 키 행도 남지 않는다). 잠금 차례는 주문 행(T3) → 결제 시도 행이다(리뷰 고침 M2 2026-11-05).
   * ORDER_STATE: 주문 T3·T4가 출발 상태가 아님(다른 탭이 먼저 접수했거나 만료와 겹침). current가 EXPIRED면 409 order-expired, 그 밖은 409 payment-already-accepted.
   * ATTEMPT_GONE: 주문은 CREATED였지만 시도가 그사이 READY가 아님(대체·만료). current = 시도의 지금 상태(행이 없으면 없음).
   *   쓰임새가 시도 대조 실패(409 payment-attempt-mismatch, 보안 로그 EXPIRED면 attempt_expired, 그 밖은 no_attempt)로 답한다
   */
  | { readonly status: 'STALE'; readonly reason: 'ORDER_STATE'; readonly current?: OrderStatus }
  | { readonly status: 'STALE'; readonly reason: 'ATTEMPT_GONE'; readonly current?: 'ACCEPTED' | 'SUPERSEDED' | 'EXPIRED' };

/** 트랜잭션 하나의 선택값(리뷰 고침 L4) */
export interface TransactionCallOptions {
  /** 이 트랜잭션의 문장 시간 초과(ms, 1 이상 정수). 요청의 남은 시간이 DB 역할의 문장 상한보다 짧을 때만 준다. 없으면 역할 기본 */
  readonly deadlineMs?: number;
}

/** 결제 접수 쓰기(운영은 adapters/db/drizzle-order-accepts.ts: purchase DB 트랜잭션 하나, read committed) */
export interface OrderAcceptWrites {
  /**
   * 한 트랜잭션: 멱등 기록 잡기(범위 계정 × ACCEPT_PAYMENT, 결과 참조 = 주문 ID) → 주문 T3(주문 행 잠금, DrizzleOrderStore.transition)
   * → 시도 READY → ACCEPTED 조건부 UPDATE(결제 참조·authenticated_at·accepted_at) → seat_gen → order_saga_job INSERT(step 'RESERVE')
   * → 주문 T4(ACCEPTED 사건을 Outbox에 쓴다. 업무 문장의 마지막, ADR-0116 결정 3).
   * @throws ProblemError 409 idempotency-request-in-progress, 422 idempotency-key-reused — 플랫폼 IdempotencyStore가 던지는 그대로
   * @throws RangeError 입력이 틀림(코드 오류, DB에 가지 않는다)
   * @throws Error 그 밖의 DB 오류(문장 시간 초과 포함, 트랜잭션째 되돌렸다)
   */
  accept(once: OrderRequestOnce, input: AcceptInput, o?: TransactionCallOptions): Promise<AcceptOutcome>;
}

/**
 * 회차 슬롯 읽기 결과(inventory SEAT_SLOT_READ_LUA, 세대 키 s:{event:E}:epoch와 판매 정지 사본 s:{event:E}:ctl을 한 번에 읽는다).
 * - OK: 좌석 저장소가 준비됐고 정지가 아니다. gen = 세대 키의 gen 칸(다시 만들기 판 번호, 칸이 없으면 1)
 * - NOT_READY: 세대 키의 epoch 칸이 없다(503 seat-store-unavailable)
 * - PAUSED: ctl의 paused·allPaused·suspended 가운데 하나라도 '1'(423 sale-paused)
 */
export type SeatSlotRead = { readonly status: 'OK'; readonly gen: number } | { readonly status: 'NOT_READY' } | { readonly status: 'PAUSED' };

/** 회차 슬롯 읽기(운영은 inventory RedisSeatSlots를 InventorySeatSlots 다리로 잇는다, adapters/inventory-bridges.ts) */
export interface SeatSlotReads {
  /**
   * @param o.deadlineMs 좌석 Redis 호출 하나의 마감(ms, 1 이상 정수). 없으면 플랫폼 기본
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애
   * @throws Error 망가진 세대 키(gen 칸 형식 틀림, PEAKET_CORRUPT_KEY)·WRONGTYPE
   */
  read(eventId: string, o?: { deadlineMs?: number }): Promise<SeatSlotRead>;
}

/** 결제 시도 대조 실패의 까닭(보안 로그 reason, payment §4.2 18) */
export type AttemptMismatchReason =
  /** 활성 시도가 없거나 READY가 아님 */
  | 'no_attempt'
  /** READY 시도가 만든 지 40분 [가정]을 넘음 */
  | 'attempt_expired'
  /** 본문 pg가 시도의 결제사와 다름 */
  | 'pg_mismatch'
  /** 포트원 본문 paymentId가 시도의 pg_order_ref와 다름 */
  | 'payment_id_mismatch'
  /** 토스·시뮬레이터 본문 amount가 주문 금액과 다름(400, 금액 변조는 보안 사건이다, ASVS 16.3.3. 금액은 싣지 않는다) */
  | 'amount_mismatch';

/** 결제 접수의 보안 로그(서비스 로그 한 줄. 결제 참조·토큰·본문 값·금액은 싣지 않는다). 던지지 않는다 */
export interface AcceptLog {
  /**
   * 결제 시도 대조 실패(409 payment-attempt-mismatch)와 금액 불일치(400) 한 줄: 계정·주문·까닭만(payment §2 '활성 결제 시도 대조', §4.2 18).
   * 금액 불일치는 까닭 amount_mismatch로 같은 줄을 쓴다(2026-11-05 정본 바로잡음)
   */
  attemptMismatch(e: { readonly accountId: string; readonly orderId: string; readonly reason: AttemptMismatchReason }): void;
}

// ---- Saga 1단계(docs/features/payment.md §2 'Saga 1단계의 첫 구현', docs/data.md §5 'Saga 1단계', BUILD_ORDER PRF-165) ----
// 실행기(application/order-saga.ts)가 작업 행을 짧은 트랜잭션으로 집어 임대를 쓰고 커밋한 뒤 돈다(잠금을 쥔 채 바깥 호출을 하지 않는다).
// RESERVE: 승인 기한 → OrderSeatPins.pin → ReserveTx.reserve(한 트랜잭션: seat_rebuild 대조 → 판매 예약 → 작업 CONFIRM → T7)
// CONFIRM: (보내기 바로 전 SagaJobs.markConfirmSent) PaymentConfirms.confirm → ConfirmSent.done. 실패는 SagaFailures.fail(T8·T11, 작업 행 RELEASE)
//   → OrderSeatPins.releaseFailed → 끝나면 작업 행 지우기(RELEASE 단계가 끝날 때까지 다시 한다, 리뷰 M4).
// 주문 상태 SQL은 주문 전이 함수(drizzle-orders.ts의 transition)로만 바꾼다(test/order-status-sql.test.ts).

/** 집은 Saga 작업 하나(order_saga_job 행) */
export interface SagaJob {
  readonly orderId: string;
  readonly eventId: string;
  readonly step: SagaStep;
  /** 이 단계를 해 본 횟수(reschedule이 1 올리고, 단계가 바뀌면 0으로) */
  readonly attempts: number;
  /** 다음에 해 볼 시각(epoch ms) */
  readonly nextAttemptAtMs: number;
  /** 임대 끝 시각(epoch ms). 집은 작업은 늘 있다 */
  readonly leaseUntilMs?: number;
  /** 승인 명령을 처음 보내기 바로 전에 적은 시각(epoch ms, confirm_sent_at). 없으면 한 번도 보내지 않았다(리뷰 H1) */
  readonly confirmSentAtMs?: number;
}

/** 자기 임대 조건: 주면 lease_until이 이 값인 행에만 쓴다(다른 실행이 임대를 이어 받았으면 0행). 없으면 조건을 걸지 않는다(손질·시험) */
export type LeaseGuard = number | undefined;

/** Saga 작업 행 저장소(운영은 adapters/db/drizzle-saga.ts DrizzleSaga) */
export interface SagaJobs {
  /**
   * 짧은 트랜잭션 하나: next_attempt_at ≤ 지금이고 임대가 비었거나 지난 행을 next_attempt_at 차례로 FOR UPDATE SKIP LOCKED로 limit개까지 골라
   * lease_until = 지금 + leaseMs를 쓰고 커밋한다. 집은 행들(임대 뒤 값)을 돌려준다. 없으면 [].
   * @throws RangeError limit·leaseMs가 1 이상의 정수가 아님
   */
  claimDue(limit: number, leaseMs: number): Promise<SagaJob[]>;
  /**
   * 그 주문의 작업 하나를 같은 조건(기한이 됐고 임대가 비었거나 지남)으로 집는다(접수 직후 kick이 쓴다). 집지 못하면 undefined.
   * 소문자 UUID가 아니면 DB에 가지 않고 undefined
   */
  claim(orderId: string, leaseMs: number): Promise<SagaJob | undefined>;
  /** 작업 행 읽기(임대를 쓰지 않는다). 없으면 undefined */
  get(orderId: string): Promise<SagaJob | undefined>;
  /** 다시 하기로 미룬다: attempts + 1, next_attempt_at = nextAtMs, 임대를 비운다. 행이 없거나 자기 임대가 아니면 false */
  reschedule(orderId: string, nextAtMs: number, lease?: LeaseGuard): Promise<boolean>;
  /**
   * 단계를 바꾼다(attempts 0, next_attempt_at = 지금, 임대 비움. 보낸 시각 confirm_sent_at은 그대로: 한 번 보낸 명령은 되돌릴 수 없다).
   * 판매 예약 트랜잭션 밖에서 바꿀 일(손질·시험)에 쓴다. 행이 없거나 자기 임대가 아니면 false
   */
  setStep(orderId: string, step: SagaStep, lease?: LeaseGuard): Promise<boolean>;
  /** 작업 행을 지운다(step을 주면 그 단계일 때만, 자기 임대 조건). 지운 행이 없으면 false */
  delete(orderId: string, o?: { readonly step?: SagaStep; readonly leaseUntilMs?: number }): Promise<boolean>;
  /**
   * 승인 명령을 보내기 바로 전에 부른다(한 트랜잭션, 커밋한 뒤 보낸다, 리뷰 H1): CONFIRM 작업 행의 confirm_sent_at을 처음이면 지금으로 적는다(이미 있으면 그대로).
   * CONFIRM 작업 행이 없거나 자기 임대가 아니면 false(보내지 않는다)
   */
  markConfirmSent(orderId: string, lease?: LeaseGuard): Promise<boolean>;
  /** 임대만 놓는다(lease_until = null, 자기 임대일 때만. 다른 칸은 그대로). 다음 틱에 다시 집힌다. 놓은 행이 없으면 false */
  release(orderId: string, leaseUntilMs: number): Promise<boolean>;
  /**
   * ORDER_STATE로 건너뛸 때(리뷰 M3) 한 트랜잭션: 그 단계의 작업 행(자기 임대)을 잠그고 주문 상태를 읽어, 주문이 그 단계를 지났으면(sagaStepPassed)
   * 그 주문 ACCEPTED 시도의 결제 참조와 작업 행을 지운다(REMOVED). 지나지 않았으면 아무것도 바꾸지 않는다(KEPT, 부르는 쪽이 다시 하기로 미룬다).
   * 그 단계의 행이 없거나 자기 임대가 아니면 GONE
   */
  abandon(orderId: string, step: SagaStep, lease?: LeaseGuard): Promise<'REMOVED' | 'KEPT' | 'GONE'>;
}

/** Saga가 보는 주문 좌석 하나(order_item, 줄 번호 차례) */
export interface SagaSeat {
  readonly seatId: string;
  readonly tierId: string;
  readonly sectionId: string;
}

/** Saga가 보는 결제 시도(그 주문의 ACCEPTED 시도) */
export interface SagaAttemptView {
  readonly attemptId: string;
  readonly pg: PaymentPg;
  /** 토스 orderId 또는 포트원 paymentId(pay-{orderId}). 포트원 승인 명령의 payment_id다 */
  readonly pgOrderRef?: string;
  /** 결제 참조. 승인 명령이 접수됐거나 과금 없이 끝나 지웠으면 undefined */
  readonly refs?: PaymentRefs;
  /** 결제창 인증 시각(epoch ms, 승인 기한의 기준). 비었으면 undefined */
  readonly authenticatedAtMs?: number;
}

/** Saga가 보는 주문(주문 행·항목·ACCEPTED 결제 시도) */
export interface SagaOrderView {
  readonly orderId: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly status: OrderStatus;
  /** 서버 금액(원). 승인 명령의 amount */
  readonly amount: number;
  readonly holdId: string;
  readonly purchaseSessionId: string;
  /** 결제 접수 때 적은 판 번호(purchase_order.seat_gen). 접수 전이면 undefined */
  readonly seatGen?: number;
  /** 줄 번호 차례 */
  readonly seats: readonly SagaSeat[];
  /** ACCEPTED 결제 시도. 없으면 undefined(코드 오류·손질) */
  readonly attempt?: SagaAttemptView;
}

/** Saga 작업에 필요한 주문 읽기(트랜잭션 밖)와 판 번호 적기 */
export interface SagaOrders {
  /** 주문 하나. 없거나 소문자 UUID가 아니면 undefined */
  read(orderId: string): Promise<SagaOrderView | undefined>;
  /**
   * 묶기가 OK인 뒤(판매 예약 전) 주문 seat_gen을 묶기 결과의 판 번호(toGen)로, pinned_at을 지금으로 한 UPDATE에서 적는다(명세 pin·리뷰 M1, 마이그레이션 0008,
   * BUILD_ORDER PRF-167 리뷰 고침 L5: 옛 recordPinnedGen을 합쳤다, docs/features/seat-hold.md §6 '주문 기준 되살리기' K1). 판 번호가 같아도(fromGen = toGen) 부른다.
   * 주문이 ACCEPTED이고 seat_gen = fromGen일 때만 쓰고, pinned_at이 이미 있으면 처음 값을 둔다(상태 칸·이력은 건드리지 않는다). 바꾼 행이 없으면 false.
   * 다시 만들기는 결제 접수했고 묶인 주문의 좌석을 원장 만료 시각과 상관없이 되살린다
   * @throws RangeError 판 번호가 1 ~ int4 최댓값의 정수가 아님
   */
  recordPinned(orderId: string, fromGen: number, toGen: number): Promise<boolean>;
}

/** 다시 만들기가 읽는 판매 주문의 holdId·구매 세션 ID(inventory RebuildSaleOrder와 같은 모양, BUILD_ORDER PRF-167 K3) */
export interface RebuildOrderHold {
  readonly orderId: string;
  readonly holdId: string;
  readonly purchaseSessionId: string;
}

/** 다시 만들기가 읽는 결제 접수했고 묶인 주문(inventory RebuildPinnedOrder와 같은 모양, BUILD_ORDER PRF-167 K1). 좌석은 줄 번호 차례 */
export interface RebuildPinnedOrderView {
  readonly orderId: string;
  readonly accountId: string;
  readonly holdId: string;
  readonly purchaseSessionId: string;
  readonly seatIds: string[];
}

/**
 * 다시 만들기의 주문 근거를 주는 쪽(inventory RebuildOrderSource를 모양으로 채운다. booking은 inventory를 가져오지 않는다, BUILD_ORDER PRF-167).
 * 운영 구현은 DrizzleRebuildOrders이고 시작 파일이 SeatRebuilder의 orders로 넘긴다
 */
export interface RebuildOrderReads {
  /** 주문 ID들 → 그 회차 주문의 holdId·psid(없는 주문은 뺀다, 0개면 DB를 부르지 않고 []) */
  saleOrders(eventId: string, orderIds: readonly string[]): Promise<RebuildOrderHold[]>;
  /**
   * 그 회차의 ACCEPTED이고 pinned_at이 있는 주문들과 그 좌석(주문 항목 전부, 줄 번호 차례). 진행 중 주문만 있는 작업 표 order_saga_job(RESERVE)에서 출발한다
   * (리뷰 고침 H1). 원장(seat_hold)은 읽지 않는다: 원장 대조는 inventory가 한다(리뷰 고침 M2)
   */
  pinnedOrders(eventId: string): Promise<RebuildPinnedOrderView[]>;
}

/** 판매 예약 트랜잭션 입력 */
export interface ReserveTxInput {
  readonly orderId: string;
  readonly eventId: string;
  readonly accountId: string;
  /** 주문 항목의 좌석 ID(소문자 UUID, 1~10개) */
  readonly seatIds: readonly string[];
  /** 그 회차의 1인 한도(좌석맵 판 perAccountLimit) */
  readonly limit: number;
  /** 주문의 판 번호(purchase_order.seat_gen, 1 이상 정수). seat_rebuild의 지금 번호와 견준다 */
  readonly orderGen: number;
  /** 행위자(ACTOR_PATTERN). Saga는 system:order-saga */
  readonly actor: string;
  /** 자기 임대 조건(작업 행을 CONFIRM으로 바꾸는 문장에 건다). 없으면 조건을 걸지 않는다 */
  readonly leaseUntilMs?: number;
}

/**
 * 판매 예약 트랜잭션 결과.
 * - RESERVED: 판매 행 PENDING·한도·작업 CONFIRM·T7(RESERVED 사건 Outbox)을 커밋했다
 * - GEN_CHANGED: seat_rebuild의 판 번호(gen)가 주문의 것과 달라 되돌렸다(아무것도 남지 않는다. 주문 seat_gen도 그대로다).
 *   부르는 쪽은 그 판 번호 그대로 묶기부터 다시 한다(내 홀드가 남았을 때만 OK, OPEN[15], 명세 saleStep, 리뷰 M1)
 * - SEAT_TAKEN·QUOTA_EXCEEDED: 판매 예약이 거절해 트랜잭션째 되돌렸다(아무것도 남지 않는다). 부르는 쪽이 따로 T8과 실패 해제를 한다
 * - ORDER_STATE: T7이 0행(주문이 ACCEPTED가 아님. 다른 실행이 먼저 했거나 손질)이라 트랜잭션째 되돌렸다. current = 지금 상태
 */
export type ReserveTxOutcome =
  | { readonly status: 'RESERVED' }
  | { readonly status: 'GEN_CHANGED'; readonly gen: number }
  | { readonly status: 'SEAT_TAKEN'; readonly seatIds: readonly string[] }
  | { readonly status: 'QUOTA_EXCEEDED' }
  | { readonly status: 'ORDER_STATE'; readonly current?: OrderStatus };

/** 판매 예약 트랜잭션(운영은 DrizzleSaga, inventory DrizzleSeatSales.reserveIn을 같은 트랜잭션으로 부른다) */
export interface ReserveTx {
  /**
   * 한 트랜잭션(READ COMMITTED): seat_rebuild 회차 행을 없으면 넣고(ON CONFLICT DO NOTHING, 판 번호 1) → 그 행의 gen을 FOR SHARE로 읽어 orderGen과 대조
   * → 다르면 GEN_CHANGED(되돌린다) → 같으면 reserveIn(같은 트랜잭션) → 작업 step CONFIRM(attempts 0, next = 지금, 보낸 시각 비움, 임대는 그대로: 같은 실행이 승인 명령을 잇는다)
   * → T7(Outbox가 업무 문장의 마지막).
   * @throws RangeError 입력이 틀림(DB에 가지 않는다) · Error 그 밖의 DB 오류(되돌렸다. 실행기가 다시 한다)
   */
  reserve(input: ReserveTxInput): Promise<ReserveTxOutcome>;
}

/** T11 때 지울 판매 행(inventory SeatSaleRelease와 같은 모양) */
export interface SagaSaleRelease {
  readonly eventId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly seatIds: readonly string[];
}

/** 실패 기록 입력 */
export interface SagaFailInput {
  readonly orderId: string;
  /** T8(ACCEPTED → FAILED) 또는 T11(RESERVED → FAILED) */
  readonly transition: SagaFailTransition;
  readonly reason: SagaFailureReason;
  /** 행위자(ACTOR_PATTERN). Saga는 system:order-saga */
  readonly actor: string;
  /** T11에만 준다: 판매 행 PENDING을 지우고 한도를 되돌린다(releasePendingIn, 같은 트랜잭션) */
  readonly release?: SagaSaleRelease;
  /** 자기 임대 조건(첫 문장인 작업 행 갱신에 건다). 없으면 조건을 걸지 않는다 */
  readonly leaseUntilMs?: number;
}

/**
 * 실패 기록 결과. STALE: 작업 행이 그 단계가 아니거나(다른 실행이 이미 끝냈다) 자기 임대가 아니거나, 주문이 그 전이의 출발 상태가 아니라
 * 트랜잭션째 되돌렸다(아무것도 남지 않는다. 판매 행도 지우지 않는다). current = 주문의 지금 상태
 */
export type SagaFailOutcome = { readonly status: 'FAILED' } | { readonly status: 'STALE'; readonly current?: OrderStatus };

/** 실패 기록(운영은 DrizzleSaga) */
export interface SagaFailures {
  /**
   * 한 트랜잭션(READ COMMITTED, 잠금 차례 작업 행 → 주문 행 → 한도 행 → 좌석 행 → 결제 시도 행. 판매 예약과 같이 작업 행이 먼저다, 리뷰 H1 변형):
   * 작업 행 step = 'RELEASE'(attempts 0, 기대 단계 T8 RESERVE·T11 CONFIRM일 때만, 자기 임대 조건. 0행이면 STALE) → 주문 행에 failure_reason(출발 상태일 때만,
   * 상태 칸은 건드리지 않는다) → (T11이면) releasePendingIn → 결제 시도의 결제 키·거래 ID·토큰 지우기 → 전이 T8·T11(FAILED 사건 Outbox가 업무 문장의 마지막).
   * 작업 행은 지우지 않는다: 실행기가 실패 해제를 마친 뒤 지운다(리뷰 M4). 전이가 0행이면 STALE로 되돌린다.
   * T11인데 release가 없거나 T8인데 release가 있으면 RangeError(코드 오류)
   * @throws Error 그 밖의 DB 오류(되돌렸다)
   */
  fail(input: SagaFailInput): Promise<SagaFailOutcome>;
}

/** 승인 명령 접수 뒤 정리(운영은 DrizzleSaga) */
export interface ConfirmSent {
  /**
   * 한 트랜잭션: 그 주문의 CONFIRM 작업 행을 지우고(자기 임대 조건) 지웠으면 ACCEPTED 시도의 결제 키·거래 ID·토큰을 지운다.
   * 작업 행이 없었으면 false(다른 실행이 먼저 끝냄, 아무것도 바꾸지 않는다)
   */
  done(orderId: string, lease?: LeaseGuard): Promise<boolean>;
}

/** 주문 모습의 좌석 묶기 입력(inventory PinInput에 좌석맵 판으로 좌석 색인을 붙여 넘긴다) */
export interface OrderPinInput {
  readonly eventId: string;
  readonly accountId: string;
  readonly holdId: string;
  readonly purchaseSessionId: string;
  /** 주문 항목의 좌석 ID(차례는 다리가 맞춘다) */
  readonly seatIds: readonly string[];
  /** 그 회차의 1인 한도 */
  readonly limit: number;
  /** 주문의 판 번호(seat_gen) */
  readonly orderGen: number;
  /** 회차 키 만료 시각(epoch ms) = 판매 종료 + 1일 */
  readonly keepUntilMs: number;
}

/**
 * 묶기 결과(inventory PinResult를 주문 모습으로).
 * - OK: gen = 지금 판 번호. NOT_READY: 세대 키 없음(다시 한다. 회차 키 수명이 지났으면 실행기가 STORE_GONE으로 끝낸다)
 * - TAKEN·QUOTA_EXCEEDED·STALE_GEN: 아무것도 쓰지 않았다(T8과 실패 해제)
 * - FAILED_HOLD: 그 홀드의 실패 표시 s:{event:E}:failed:{holdId}가 있어 아무것도 쓰지 않았다(이미 실패 해제함. 늦은 묶기)
 */
export type OrderPinResult =
  | { readonly status: 'OK'; readonly gen: number }
  | { readonly status: 'NOT_READY' }
  | { readonly status: 'TAKEN' }
  | { readonly status: 'QUOTA_EXCEEDED' }
  | { readonly status: 'STALE_GEN'; readonly gen: number }
  | { readonly status: 'FAILED_HOLD' };

/** 주문 모습의 실패 해제 입력 */
export interface OrderReleaseInput {
  readonly eventId: string;
  readonly accountId: string;
  readonly holdId: string;
  readonly seatIds: readonly string[];
  readonly keepUntilMs: number;
}

/** 실패 해제 결과. NOT_READY: 세대 키 없음(회차 키 수명이 지났으면 해제가 끝난 것으로 본다) */
export type OrderReleaseResult = { readonly status: 'OK'; readonly released: number } | { readonly status: 'NOT_READY' };

/**
 * 좌석 묶기·실패 해제의 inventory 다리(운영은 adapters/inventory-bridges.ts InventoryOrderSeatPins: 좌석맵 판 resolve로 SeatRef를 만들어 SeatPins를 부른다).
 * 실패 해제는 실패 표시(수명 10분 [가정])를 같은 Lua에서 남기고, 묶기는 그 표시가 있으면 FAILED_HOLD로 거절한다(구현은 inventory pin-lua.ts).
 */
export interface OrderSeatPins {
  /**
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(쓰였는지 모른다. 같은 입력으로 다시 부르면 모두 내 홀드라 OK)
   * @throws Error 좌석맵 판에 없는 좌석·판 없음(설정 오류)·망가진 키
   */
  pin(input: OrderPinInput, o?: { deadlineMs?: number }): Promise<OrderPinResult>;
  /** @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(다시 부르면 남은 것만 푼다) · Error 좌석맵 판에 없는 좌석·망가진 키 */
  releaseFailed(input: OrderReleaseInput, o?: { deadlineMs?: number }): Promise<OrderReleaseResult>;
}

/** Saga가 쓰는 회차 설정(좌석맵 판의 perAccountLimit·saleEndsAt) */
export interface SagaEventConfig {
  /** 1인 한도(1 이상 정수) */
  readonly perAccountLimit: number;
  /** 판매 종료 시각(epoch ms) */
  readonly saleEndsAtMs: number;
}

/** 회차 설정 읽기(운영은 adapters/inventory-bridges.ts SeatMapSagaConfigs). 판이 없으면 undefined. 던지지 않는다 */
export interface SagaEventConfigs {
  get(eventId: string): Promise<SagaEventConfig | undefined>;
}

/** 승인 명령의 결제 참조(payment.proto ConfirmPaymentRequest.payment_ref oneof) */
export type ConfirmRefs =
  /** toss(TossPaymentRef.payment_key). 시뮬레이터도 이 칸을 쓴다 */
  | { readonly pg: 'TOSS' | 'SIMULATOR'; readonly paymentKey: string }
  /** portone(PortonePaymentRef: payment_id = pg_order_ref, tx_id, payment_token) */
  | { readonly pg: 'PORTONE'; readonly paymentId: string; readonly txId: string; readonly paymentToken: string };

/** 승인 명령 입력 */
export interface ConfirmCommand {
  readonly orderId: string;
  readonly attemptId: string;
  readonly pg: PaymentPg;
  readonly refs: ConfirmRefs;
  /** 서버 금액(원, Money.krw) */
  readonly amount: number;
  /** 이 호출의 데드라인(ms, 1 이상 정수). 실행기가 min(200ms, 승인 기한까지 남은 시간)으로 준다 */
  readonly deadlineMs: number;
}

/** payment-svc가 답한 승인 결과(ConfirmResult 이름에서 CONFIRM_RESULT_를 뗀 것) */
export type ConfirmResultName = 'APPROVED' | 'ALREADY_APPROVED' | 'IN_PROGRESS' | 'DECLINED' | 'WAITING_FOR_DEPOSIT' | 'UNKNOWN' | 'UNSPECIFIED';

/** 다시 보낼 까닭: 데드라인 초과(DEADLINE_EXCEEDED 4)·UNAVAILABLE 14·차단기 열림 */
export type ConfirmRetryReason = 'deadline' | 'unavailable' | 'circuit_open';

/** 거절 까닭: 그 밖의 gRPC 상태(소문자 이름, 예 invalid_argument·failed_precondition·permission_denied·unimplemented)와 gRPC가 아닌 예외(unexpected) */
export type ConfirmRejectReason = string;

/**
 * 승인 명령 결과. 던지지 않는다.
 * - ACCEPTED: payment-svc가 답했다(APPROVED·ALREADY_APPROVED·IN_PROGRESS·DECLINED·WAITING_FOR_DEPOSIT. 명령을 받아 적은 것이다. 결과는 trade.payments로 받는다, PRF-163)
 * - RETRYABLE: 같은 주문 ID로 다시 보낸다(payment-svc가 멱등으로 받는다)
 * - REJECTED: 그 밖의 gRPC 오류(설정·코드 오류)와 답의 결과가 UNSPECIFIED·UNKNOWN(결제 참조를 지우지 않는다, 리뷰 낮음)
 */
export type ConfirmOutcome =
  | { readonly status: 'ACCEPTED'; readonly result: ConfirmResultName }
  | { readonly status: 'RETRYABLE'; readonly reason: ConfirmRetryReason }
  | { readonly status: 'REJECTED'; readonly reason: ConfirmRejectReason };

/** 승인 명령 호출 하나의 선택값 */
export interface ConfirmCallOptions {
  /**
   * 차단기가 들여보낸 뒤, 명령을 실제로 보내기 바로 전에 한 번 부른다(실행기가 작업 행 confirm_sent_at을 적고 커밋한다, 리뷰 H1).
   * 차단기 열림·남은 시간 없음처럼 보내지 않는 길에서는 부르지 않는다. 던지면 보내지 않고 그 오류를 그대로 던진다
   */
  readonly beforeSend?: () => Promise<void>;
}

/** 승인 명령 포트(운영은 adapters/grpc-payment-confirm.ts GrpcPaymentConfirms, local·ci는 늘 접수 대역) */
export interface PaymentConfirms {
  /** 던지지 않는다(beforeSend가 던진 것만 그대로 던진다) */
  confirm(c: ConfirmCommand, o?: ConfirmCallOptions): Promise<ConfirmOutcome>;
}

/** Saga 로그(서비스 로그 한 줄. 결제 참조·토큰·금액은 싣지 않는다). 던지지 않는다 */
export interface SagaLog {
  /** 실패 해제가 좌석 Redis 장애 등으로 끝나지 못했다(warn. 주문은 이미 FAILED라 좌석 해제 사건 소비자가 뒤를 받는다) */
  releaseFailed(e: { readonly orderId: string; readonly eventId: string; readonly why: string }): void;
  /** 승인 명령이 REJECTED(error, SEV2 설정 오류) */
  confirmRejected(e: { readonly orderId: string; readonly reason: ConfirmRejectReason }): void;
  /** 단계가 예상 밖 오류로 끝나 다시 하기로 미뤘다(error. 오류 이름·글만) */
  stepError(e: { readonly orderId: string; readonly step: SagaStep; readonly err: unknown }): void;
}

// ---- 결제 결과 반영(docs/features/payment.md §2 '결제 결과 반영의 첫 구현', docs/data.md §5 '결제 결과 반영', BUILD_ORDER PRF-163) ----
// 쓰임새(application/apply-payment-result.ts): PaymentResultReads.read → decidePaymentResult(domain/payment-result.ts) → PaymentResultWrites.approve·fail·mark(한 트랜잭션)
// → 커밋 뒤 일(PaymentResultSessions.complete·unmarkPaying, SagaWake.kick). 보류는 쓰임새가 PaymentResultHeld를 던져 키 단위 처리기의 보류 규칙에 맡긴다.
// 잠금 차례는 Saga와 같다: 작업 행(order_saga_job) → 주문 행 → 한도 행 → 좌석 행 → 결제 시도 행. 주문 상태는 주문 전이 함수(DrizzleOrderStore.transition)로만 바꾼다.

/** 반영이 보는 주문(결정에 쓰는 칸 + 쓰기에 넘길 회차·계정·좌석·구매 세션) */
export interface PaymentResultOrder extends PaymentResultOrderView {
  readonly eventId: string;
  readonly accountId: string;
  /** 주문을 만든 구매 세션(purchase_order.purchase_session_id = 입장 토큰 jti). 커밋 뒤 구매 세션 끝내기·Paying 풀기에 쓴다 */
  readonly purchaseSessionId: string;
  /** 주문 항목의 좌석 ID(줄 번호 차례, 1~10개). 판매 행 SOLD·PENDING 지우기에 쓴다 */
  readonly seatIds: readonly string[];
}

/** 결제 결과 반영의 읽기(트랜잭션 밖, 운영은 adapters/db/drizzle-payment-results.ts). 아무것도 쓰지 않는다 */
export interface PaymentResultReads {
  /**
   * 주문 행(status·amount·payment_event_seq·event_id·account_id·purchase_session_id) + 항목의 좌석 ID + ACCEPTED 결제 시도의 결제사.
   * 없거나 orderId가 소문자 UUID가 아니면 undefined
   */
  read(orderId: string): Promise<PaymentResultOrder | undefined>;
}

/** 쓰기 공통 입력 */
export interface PaymentResultWriteBase {
  readonly orderId: string;
  /** 사건의 eventSeq(양의 정수). 전이 UPDATE에 payment_event_seq < 이 값 조건을 걸고 이 값으로 바꾼다(ADR-0146 결정 2) */
  readonly paymentEventSeq: number;
  /** 행위자(ACTOR_PATTERN). 결제 결과 반영은 system:payment-result(PAYMENT_RESULT_ACTOR) */
  readonly actor: string;
}

/** 승인 쓰기 입력(T9·T13·T16) */
export interface PaymentApproveInput extends PaymentResultWriteBase {
  readonly transition: 'T9' | 'T13' | 'T16';
  /** 회차(판매 행·ticket_issue_job.event_id) */
  readonly eventId: string;
  /** 판매 행 PENDING → SOLD로 바꿀 좌석(주문 항목) */
  readonly seatIds: readonly string[];
  /** 발권 기한(epoch ms, ticket_issue_job.issue_due_at = 승인 + 30분 [가정]) */
  readonly issueDueAtMs: number;
}

/** 실패 쓰기 입력(T11·T15·T17) */
export interface PaymentFailInput extends PaymentResultWriteBase {
  readonly transition: 'T11' | 'T15' | 'T17';
  /** 주문 failure_reason에 적을 값(사건의 failureCategory, 없으면 PAYMENT_FAILURE_FALLBACK) */
  readonly failureReason: PaymentFailureCategory;
  /** 작업 행이 없을 때 넣는 RELEASE 행의 event_id */
  readonly eventId: string;
  /** 판매 행 PENDING을 지우고 한도를 되돌린다(releasePendingIn, 같은 트랜잭션) */
  readonly release: SagaSaleRelease;
}

/** 상태만 바꾸는 쓰기 입력(T10·T12·T14) */
export interface PaymentMarkInput extends PaymentResultWriteBase {
  readonly transition: 'T10' | 'T12' | 'T14';
}

/**
 * 쓰기 결과. STALE이면 트랜잭션째 되돌렸다(아무것도 남지 않는다): 주문이 출발 상태가 아니었다.
 * reason은 주문 전이 함수의 까닭과 같은 규칙이다(NOT_FOUND: 주문 없음, STATUS: 지금 상태가 출발이 아님, PAYMENT_SEQ: 그 순번 이상을 이미 반영함). current = 지금 상태(STATUS일 때만).
 * SOLD_MISMATCH(승인만)면 SOLD로 바꾼 판매 행 수가 좌석 수와 달라 트랜잭션째 되돌렸다(리뷰 M4)
 */
export type PaymentResultWriteOutcome =
  | { readonly status: 'APPLIED' }
  | { readonly status: 'STALE'; readonly reason: 'NOT_FOUND' | 'STATUS' | 'PAYMENT_SEQ'; readonly current?: OrderStatus }
  | { readonly status: 'SOLD_MISMATCH' };

/** 결제 결과 반영 쓰기(운영은 adapters/db/drizzle-payment-results.ts. 트랜잭션은 모두 READ COMMITTED·문장 시간 한도 5초 [가정]를 직접 고른다) */
export interface PaymentResultWrites {
  /**
   * 승인 한 트랜잭션: 작업 행 정리(그 주문의 order_saga_job이 있으면 지운다) → 주문 행 잠금(상태·순번이 출발이 아니면 바로 STALE, 권고1)
   * → 남은 결제 참조 지우기 → 판매 행 PENDING → SOLD(inventory markSoldIn, 같은 트랜잭션. 바꾼 수가 좌석 수와 다르면 되돌리고 SOLD_MISMATCH, 리뷰 M4)
   * → ticket_issue_job 한 행(attempts 0, next_attempt_at = 지금, issue_due_at, created_at = 지금)
   * → 주문 T9·T13·T16(APPROVED 사건 Outbox가 업무 문장의 마지막). 좌석 Redis의 묶인 홀드는 그대로 둔다.
   * 겹친 Saga CONFIRM 실행은 작업 행이 없어져 0행이 되고 물러난다.
   * @throws RangeError 입력이 틀림(DB에 가지 않는다) · Error 그 밖의 DB 오류(되돌렸다)
   */
  approve(input: PaymentApproveInput): Promise<PaymentResultWriteOutcome>;
  /**
   * 실패 한 트랜잭션: 작업 행을 RELEASE로(없으면 넣는다. attempts 0, next_attempt_at = 지금, 임대 비움 [정함: 커밋 뒤 kick이 곧바로 집게]. 잠금 차례 작업 행 → 주문 행)
   * → 주문 failure_reason(출발 상태일 때만, 상태 칸은 건드리지 않는다) → 판매 행 PENDING 지우기(inventory releasePendingIn, 한도 되돌림)
   * → 남은 결제 참조 지우기 → 주문 T11·T15·T17(FAILED 사건 Outbox가 마지막). 좌석 Redis의 실패 해제는 Saga RELEASE 단계가 한다.
   * @throws RangeError 입력이 틀림(release.orderId가 주문과 다름 포함, DB에 가지 않는다) · Error 그 밖의 DB 오류(되돌렸다)
   */
  fail(input: PaymentFailInput): Promise<PaymentResultWriteOutcome>;
  /**
   * 상태만 바꾸는 한 트랜잭션(T12 UNKNOWN, T10·T14 입금 대기): 작업 행 지우기(있으면. 결과는 payment-svc 조회·가상계좌 단계가 정한다)
   * → 주문 행 잠금(상태·순번이 출발이 아니면 바로 STALE) → 남은 결제 참조 지우기(이 사건이 왔다는 것은 승인 명령이 접수됐다는 뜻, 리뷰 M1)
   * → 주문 T10·T12·T14(T12는 사건 없이 이력만, T10·T14는 AWAITING_DEPOSIT 사건). 판매 행 PENDING은 그대로 둔다.
   * @throws RangeError 입력이 틀림 · Error 그 밖의 DB 오류(되돌렸다)
   */
  mark(input: PaymentMarkInput): Promise<PaymentResultWriteOutcome>;
}

/**
 * 커밋 뒤 구매 세션 일(운영은 adapters/inventory-bridges.ts InventoryPaymentResultSessions: inventory EndPurchaseSession·PurchaseSessionStore.setPaying을 잇는다).
 * 최선을 다할 뿐이다: 쓰임새는 실패해도 반영 결과를 바꾸지 않고 로그만 남긴다
 */
export interface PaymentResultSessions {
  /**
   * 승인·입금 대기 뒤 구매 세션을 끝낸다(사유 COMPLETED). 끝냈으면 true, 이미 없었으면 false.
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애
   */
  complete(purchaseSessionId: string): Promise<boolean>;
  /**
   * 실패 뒤 Paying 표시를 푼다(setPaying(jti, false). 좌석맵으로 돌아가 다시 고를 수 있다). 세션이 있으면 true, 없으면 false.
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애
   */
  unmarkPaying(purchaseSessionId: string): Promise<boolean>;
}

/** 커밋 뒤 Saga 실행기 깨우기(운영은 OrderSagaRunner.kick. 실패 반영 뒤 RELEASE 작업을 곧바로 돌린다). 던지지 않는다 */
export interface SagaWake {
  kick(orderId: string): void;
}

/** 결제 결과 반영 로그(서비스 로그 한 줄. 결제 참조·금액은 싣지 않는다). 던지지 않는다. 건너뛴 사건(DUPLICATE·ALREADY_THERE·RECORD_ONLY)은 남기지 않는다 [정함] */
export interface PaymentResultLog {
  /**
   * 보류(error. RB-11로 원인을 본다). 주문 ID·사건 종류·결제사와 까닭·수준·표시만 싣는다(domain PAYMENT_RESULT_HOLD_LOG:
   * CHARGED_ON_CLOSED_ORDER는 SEV1·payment-charged-closed, SOLD_MISMATCH는 SEV1, AMOUNT_MISMATCH·PG_MISMATCH는 SEV2·security(ASVS v5.0.0-16.3.3), 그 밖 SEV2).
   * 같은 사건(eventKey)·같은 까닭은 시간 창(PAYMENT_RESULT_HELD_LOG_WINDOW_MS) 안에서 한 번만 부른다: 키 단위 소비자가 5회 해 보는 동안 한 줄이고,
   * 보류 확정은 플랫폼 키 단위 소비자의 onHeld(consumer-held 로그)·consumer_held_total 지표가 한 번 남긴다(리뷰 L5)
   */
  held(e: {
    readonly orderId: string;
    readonly type: PaymentEventType;
    readonly pg: PaymentPg;
    readonly reason: PaymentResultHoldReason;
    readonly severity: PaymentResultHoldSeverity;
    readonly kind?: PaymentResultHoldKind;
  }): void;
  /** 커밋 뒤 구매 세션 일이 실패했다(warn, 오류 이름만) */
  afterCommitFailed(e: { readonly orderId: string; readonly what: 'complete_session' | 'unmark_paying'; readonly errorName: string }): void;
}

// ---- 결제 결과 long polling GET /v1/orders/{orderId}/payment-status(docs/features/payment.md §2 '결제 결과 long polling의 첫 구현', BUILD_ORDER PRF-166) ----
// 쓰임새(application/get-payment-status.ts): PaymentStatusReads.read → 계정 대조(다르면 없는 주문과 같은 404) → decidePaymentStatus(domain/payment-status.ts)
// → WAIT면 PaymentStatusWaiters.wait(기다리는 동안 DB 연결을 쥐지 않는다) → 깨면 넘겨받은 모습이나 read로 다시 읽어 정한다 → 200 본문.
// 깨우는 길은 둘이다: 파드 안 기다림 표의 200ms [가정] 묶음 조회(readMany, 쓰기 인스턴스, 한 번에 최대 500건 [가정], 기다린 지 5초가 넘은 주문은 1초마다)와
// 같은 파드의 결제 결과 처리기·Saga가 그 주문을 바로 답할 상태로 바꾼 뒤 부르는 notify. Redis Pub/Sub은 두지 않는다.

/** long polling의 주문 읽기(트랜잭션 밖 한 질의, 운영은 adapters/db/drizzle-payment-status.ts). 아무것도 쓰지 않는다 */
export interface PaymentStatusReads {
  /** 주문 하나(기본 키). 없거나 orderId가 소문자 UUID가 아니면 undefined(DB에 가지 않는다) */
  read(orderId: string): Promise<PaymentStatusView | undefined>;
  /**
   * 여러 주문을 한 질의로(기본 키 = any(배열)). 없는 주문·소문자 UUID가 아닌 ID는 결과에서 빠진다(차례는 보장하지 않는다).
   * 빈 배열이면 DB에 가지 않고 [].
   * @throws RangeError PAYMENT_STATUS_BATCH_MAX(500)건을 넘음(부르는 쪽이 나눠 부른다)
   */
  readMany(orderIds: readonly string[]): Promise<PaymentStatusView[]>;
}

/**
 * 기다림이 끝난 까닭.
 * - CHANGED: 묶음 조회가 깨울 모습을 봤거나(paymentStatusWakes, 그때 읽은 모습을 함께 준다) notify가 불렸다(모습 없음: 쓰임새가 한 건 다시 읽는다)
 * - TIMEOUT: 기다릴 시간이 다 됐다(다시 읽어 그때의 상태로 답한다). 표가 멈춘 뒤의 wait()도 곧바로 TIMEOUT이다(리뷰 고침 L1)
 * - ABORTED: 부른 쪽이 끊었다(signal. 브라우저가 연결을 닫았다. 다시 읽지 않는다)
 * - STOPPED: 파드가 멈추며 표를 껐다(stop(). 다시 읽지 않고 마지막 본문으로 답한다, 리뷰 고침 M4)
 * - FULL: 파드의 기다림 상한(PAYMENT_STATUS_WAITERS_MAX 2,000건 [가정])에 차서 기다리지 않았다(다시 읽지 않고 지금 상태로 200, 리뷰 고침 M3)
 */
export type PaymentStatusWake = 'CHANGED' | 'TIMEOUT' | 'ABORTED' | 'STOPPED' | 'FULL';

/** 기다림의 결과. view는 묶음 조회가 깨웠을 때(CHANGED)만 있다: 그때 읽은 주문 모습(깨어난 요청이 다시 읽지 않게, 리뷰 고침 M4) */
export interface PaymentStatusWakeUp {
  readonly wake: PaymentStatusWake;
  readonly view?: PaymentStatusView;
}

/** wait()의 선택 칸 */
export interface PaymentStatusWaitOptions {
  /** 이미 끊겼으면 바로 ABORTED */
  readonly signal?: AbortSignal;
  /** 기다림 시작 때 본문(깨울지 견줄 기준, paymentStatusWakes). 없으면 issueDelayed 거짓에서 시작한 것으로 본다 */
  readonly since?: PaymentStatusBody;
}

/** 파드 안 기다리는 주문 표(운영은 application/payment-status-waiters.ts PaymentStatusWaitTable) */
export interface PaymentStatusWaiters {
  /**
   * 그 주문이 깨울 모습이 되거나(CHANGED) 시간이 다 되거나(TIMEOUT) 끊기거나(ABORTED) 표가 멈출 때(STOPPED)까지 기다린다.
   * 표가 가득 찼으면 곧바로 FULL. 던지지 않는다. 같은 주문을 여러 요청이 함께 기다릴 수 있다(탭 둘). 끝나면 표에서 빠진다.
   * @param deadlineMs 기다릴 최대 시간(ms, 1 이상 정수. 쓰임새가 paymentStatusWaitMs로 준다)
   */
  wait(orderId: string, deadlineMs: number, o?: PaymentStatusWaitOptions): Promise<PaymentStatusWakeUp>;
  /** 그 주문을 기다리는 요청을 모두 곧바로 깨운다(CHANGED, 모습 없음). 기다리는 요청이 없으면 아무것도 하지 않는다. 던지지 않는다 */
  notify(orderId: string): void;
}

/** long polling 지표(운영은 PromOrderSignals). 던지지 않는다 */
export interface PaymentStatusSignals {
  /** 지금 이 파드에서 기다리는 요청 수(게이지 purchase_payment_status_waiters, 이름표 없음, verification §4.1 long polling 행) */
  paymentStatusWaiters(count: number): void;
  /** 묶음 조회 한 번(틱 하나)이 읽기 실패로 아무도 깨우지 못했다(카운터 purchase_payment_status_poll_failures_total, 이름표 없음, 리뷰 고침 L6) */
  paymentStatusPollFailed(): void;
}
