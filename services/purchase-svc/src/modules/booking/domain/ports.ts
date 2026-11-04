// booking 모듈의 포트(바깥 저장소·지표와 닿는 면, BUILD_ORDER PRF-160·PRF-161).
import type { OrderEventMessage, OrderItem, OrderStatus, OrderRow, CreatedExtras, SeatAssignment, TransitionId } from './order.js';
import type { FallbackReason, MisconfiguredReason, RecheckAnswer } from './recheck.js';

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
  /** 결제 결과 반영 전이(T9~T17·T21, PAYMENT_RESULT_TRANSITIONS)에만 준다. 양의 정수(payment_event.seq) */
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
