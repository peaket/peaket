// booking 모듈의 포트(바깥 저장소·지표와 닿는 면, BUILD_ORDER PRF-160·PRF-161).
import type { OrderEventMessage, OrderItem, OrderStatus, OrderRow, CreatedExtras, SeatAssignment, TransitionId } from './order.js';
import type { OrderExpiryNotYetReason, OrderExpiryStage, OrderExpiryTransition, OrderExpiryTrigger } from './order-expiry.js';
import type { OrderPaymentState, PaymentLedgerStatus, PaymentPullFailureCode, PaymentPullIgnoreReason, PaymentPullRunStage } from './payment-pull.js';
import type {
  AppliedPaymentEventType,
  PaymentEventType,
  PaymentFailureCategory,
  PaymentResultHoldKind,
  PaymentResultHoldReason,
  PaymentResultHoldSeverity,
  PaymentResultOrderView,
} from './payment-result.js';
import type { PaymentDepositRead, PaymentStatusBody, PaymentStatusView } from './payment-status.js';
import type { FallbackReason, MisconfiguredReason, RecheckAnswer } from './recheck.js';
import type { SagaFailTransition, SagaFailureReason, SagaStep } from './saga.js';
import type { IssuedTicketRef, TicketIssueAttemptResult, TicketIssueFailureCode, TicketIssueRunStage } from './ticket-issue.js';

/** 주문 사건을 Outbox 값 바이트로 바꾼다. Avro 인코더(BAS-030)가 오기 전까지 JSON 대역이다 */
/** 호출 시간 한도(도메인은 플랫폼을 모른다. 플랫폼 Deadline이 이 모양을 만족한다) */
export interface HoldMarkDeadline {
  remainingMs(): number;
  budgetFor(capMs: number): number;
}

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
  /** 우선 구매 보류에서 만든 주문이면 그 권리 ID. 같은 트랜잭션에서 priority_grant.active_order_id를 적는다(GAT-135) */
  readonly priorityGrantId?: string;
}

/** 우선 구매 권리 읽기(주문 생성이 권리 가격·상태를 본다). 우선 모듈의 저장소가 구현한다 */
export interface PriorityGrantView {
  readonly grantId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly seatId: string;
  readonly price: number;
  readonly status: 'OFFERED' | 'USED' | 'EXPIRED' | 'WITHDRAWN';
  readonly expiresAtMs: number;
  readonly activeOrderId?: string;
}

export interface PriorityGrants {
  find(grantId: string): Promise<PriorityGrantView | undefined>;
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
  /** purchase_order_hold_mark_failed_total을 1 올린다(주문 뒤 표시 실패, BUILD_ORDER HOT-070). 던지지 않는다 */
  holdMarkFailed?(): void;
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
  /** 우선 구매 입장의 권리 ID(입장 토큰 prio). 일반 입장이면 없다 */
  readonly priorityGrantId?: string;
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
  /** 우선 구매 입장의 권리 ID. 있으면 구매 세션 홀드 목록 대신 그 권리의 보류 좌석을 본다(GAT-135) */
  readonly priorityGrantId?: string;
  /** 우선 구매 보류 좌석 ID(priority_grant.seat_id). priorityGrantId가 있을 때만 */
  readonly prioritySeatId?: string;
  /** 주문 항목의 좌석 ID(만료 판정의 '홀드 남음' 확인 OrderExpiryInventory.holdRemains만 쓴다. 주문 생성의 check는 세션의 홀드 목록에서 읽으므로 쓰지 않는다, BUILD_ORDER PRF-172) */
  readonly seatIds?: readonly string[];
}

/** 홀드 확인 결과 */
export type OrderHoldCheck =
  /**
   * heldAtMs: 홀드를 잡은 시각(홀드 Hash heldAt, 좌석마다 같다). seats: 구매 세션에 기록한 좌석 차례(좌석 ID 오름차순).
   * limit: 홀드 때 쓴 1인 한도(판매 정책 규칙 결과, BAT-051). 옛 홀드처럼 칸이 없으면 undefined다
   */
  | { readonly status: 'OK'; readonly heldAtMs: number; readonly seats: readonly HeldSeat[]; readonly limit?: number; readonly kind?: 'FAN' | 'PRIORITY'; readonly priorityGrantId?: string }
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
  /**
   * 홀드 Hash의 `lim`(홀드 때 쓴 1인 한도, BAT-051). 구매 세션의 홀드 목록을 보지 않고 좌석 Hash만 읽는다
   * (세션이 끝난 뒤 예약해도 규칙 한도를 잃지 않게). 홀드가 없거나 `lim` 칸이 없으면 undefined. 읽기만 한다
   */
  limit(q: OrderHoldLimitQuery, o?: { deadlineMs?: number }): Promise<number | undefined>;
}

/** 홀드 Hash의 lim을 읽는 질의(주문 항목의 좌석 ID가 필요하다) */
export interface OrderHoldLimitQuery {
  readonly eventId: string;
  readonly accountId: string;
  readonly purchaseSessionId: string;
  readonly holdId: string;
  /** 주문 항목의 좌석 ID(차례는 다리가 맞춘다) */
  readonly seatIds: readonly string[];
}

/** 회차의 판매 설정(좌석맵 판 파일의 saleEndsAt·tierPrices) */
export interface SaleConfig {
  /** 판매 종료 시각(epoch ms, 공연 시작 24시간 전, ADR-0064) */
  readonly saleEndsAtMs: number;
  /** 등급 ID → 가격(원, 0 이상 정수). 판 파일에 tierPrices가 없으면 빈 객체다(모든 등급의 가격이 없다) */
  readonly tierPrices: Readonly<Record<string, number>>;
  /** 주문명(판 파일의 선택 칸 orderName, 결제 시도가 쓴다, BUILD_ORDER PRF-191). 없으면 칸이 없다 */
  readonly orderName?: string;
  /** 입장 시작 시각(epoch ms, 판 파일의 선택 칸 entryOpensAt). 없으면 칸이 없다 */
  readonly entryOpensAtMs?: number;
  /** 가상계좌를 내도 되는가(판 파일의 선택 칸 virtualAccountAllowed). 없으면 칸이 없다(참으로 본다) */
  readonly virtualAccountAllowed?: boolean;
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
/** 주문 뒤 표시와 예매 제한 해제(BUILD_ORDER HOT-070, 운영은 inventory ManageHolds). 던지지 않는다 */
export interface OrderHoldMarks {
  /**
   * 주문 뒤 표시. 우선 구매 보류는 구매 세션이 없으므로 sessionId ''과 maxStayMs(권리 만료)로 부른다(GAT-135).
   * maxStayMs가 있으면 세션 읽기 없이 그 값을 쓴다.
   */
  markOrdered(q: { eventId: string; accountId: string; sessionId: string; holdId: string; seatIds: readonly string[]; maxStayMs?: number; deadline?: HoldMarkDeadline }): Promise<boolean>;
  releaseSession(q: { eventId: string; accountId: string; sessionId: string }): Promise<void>;
}

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
  /** 그 홀드의 주문이 같은 계정·같은 구매 세션의 것이면 주문 ID(ADR-0255, purchase_order.hold_id 유일 인덱스 한 번). 없으면 undefined */
  findOwnOrderId?(q: { holdId: string; accountId: string; purchaseSessionId: string }): Promise<string | undefined>;
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
  | { readonly pg: 'TOSS' | 'SIMULATOR'; readonly paymentKey: string; readonly amount: number; readonly attemptId?: string | undefined }
  | { readonly pg: 'PORTONE'; readonly paymentId: string; readonly paymentToken: string; readonly txId: string; readonly attemptId?: string | undefined };

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
  /** 그 주문의 시도 행 수(끝난 시도 포함). 2 이상이면 접수 본문의 attemptId가 필요하다(대체된 시도의 늦은 접수를 가른다, L1) */
  readonly attemptCount?: number;
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
  /** 본문 attemptId(선택 칸)가 지금 READY 시도와 다름: 대체된 시도의 늦은 접수(리뷰 고침 M2) */
  | 'attempt_id_mismatch'
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

// ---- 결제 시도 시작 POST /v1/orders/{orderId}/payments(docs/features/payment.md §2 '결제 시도 시작의 첫 구현', docs/data.md §5 '결제 시도 시작', BUILD_ORDER PRF-191) ----
// 검사 차례: (플랫폼 가드) → OrderSessions.get → StartPaymentReads.findCommitted → StartPaymentReads.order → 상태 표 → StartPaymentReads.attemptCount
// → SeatSlotReads.read → SaleConfigs.get → OrderHoldExpiries.expiresAt → PaymentCheckouts.prepare(트랜잭션 밖) → StartPaymentWrites.start(한 트랜잭션) → 201.

/** 결제 시도 시작이 보는 주문 모습 */
export interface StartOrderView extends AcceptOrderView {
  /** 주문을 만든 홀드(purchase_order.hold_id) */
  readonly holdId: string;
  /** 주문 항목의 좌석 ID(줄 번호 차례) */
  readonly seatIds: readonly string[];
}

/** 멱등 재생에 쓰는 결제 시도 모습 */
export interface StartedAttemptView {
  readonly attemptId: string;
  readonly orderId: string;
  readonly pg: PaymentPg;
}

/** 커밋된 결제 시도 시작 멱등 기록 읽기 결과(트랜잭션 밖, 범위 계정 × START_PAYMENT × 키) */
export type CommittedStartLookup =
  /** 같은 키·같은 지문으로 커밋한 시도가 있다: 그 시도로 결제창 값을 다시 만든다. attemptId = result_ref */
  | { readonly status: 'COMMITTED'; readonly attemptId: string }
  /** 같은 키에 다른 지문(422 idempotency-key-reused) */
  | { readonly status: 'MISMATCH' }
  /** 기록이 없거나, 처리 중(result_ref 비어 있음)이거나, 보관 기간이 지났다 */
  | { readonly status: 'NONE' };

/** 결제 시도 시작의 읽기(트랜잭션 밖). 아무것도 쓰지 않는다 */
export interface StartPaymentReads {
  /** 커밋된 멱등 기록. 지문은 상수 시간으로 견준다 */
  findCommitted(once: OrderRequestOnce): Promise<CommittedStartLookup>;
  /** 주문 하나. 없거나 orderId가 소문자 UUID가 아니면 undefined */
  order(orderId: string): Promise<StartOrderView | undefined>;
  /** 그 주문의 결제 시도 행 수(끝난 시도 포함). 3회 상한의 미리 보기다(정답은 트랜잭션 안에서 다시 센다) */
  attemptCount(orderId: string): Promise<number>;
  /** 결제 시도 하나(재생). 없으면 undefined */
  attempt(attemptId: string): Promise<StartedAttemptView | undefined>;
}

/** 한 트랜잭션의 입력 */
export interface StartInput {
  readonly orderId: string;
  /** 쓰임새가 만든 UUIDv7(READY 시도 만료 쓸기가 기본 키 범위로 찾는다, PRF-172가 넘긴 것) */
  readonly attemptId: string;
  readonly pg: PaymentPg;
  /** 토스 orderId 또는 포트원 paymentId */
  readonly pgOrderRef: string;
  /** 행위자(ACTOR_PATTERN). 결제 시도 시작은 account:<계정 ID> */
  readonly actor: string;
}

/** 한 트랜잭션 결과 */
export type StartOutcome =
  /** 이번에 만들었다. attemptNo = 그 주문의 시도 순번(1부터. 1이면 첫 시도) */
  | { readonly status: 'STARTED'; readonly attemptNo: number }
  /** 그사이 같은 키·같은 지문의 요청이 먼저 커밋했다: 그 시도로 값을 다시 만든다 */
  | { readonly status: 'REPLAYED'; readonly attemptId: string }
  /** T2가 0행이라 트랜잭션째 되돌렸다. current = 주문의 지금 상태 */
  | { readonly status: 'STALE'; readonly reason: 'ORDER_STATE'; readonly current?: OrderStatus }
  /** 주문 행을 잡은 뒤 센 시도 행이 상한 이상이라 트랜잭션째 되돌렸다 */
  | { readonly status: 'ATTEMPTS_EXCEEDED' }
  /** 활성 시도 부분 유일 인덱스 위반(23505, 마지막 안전망)이라 트랜잭션째 되돌렸다 */
  | { readonly status: 'ACTIVE_CONFLICT' };

/** 결제 시도 시작 쓰기(운영은 adapters/db/drizzle-order-starts.ts: purchase DB 트랜잭션 하나, read committed) */
export interface StartPaymentWrites {
  /**
   * 한 트랜잭션: 멱등 기록 잡기(범위 계정 × START_PAYMENT, 결과 참조 = 시도 ID) → 주문 T2(주문 행 잠금, 이력 한 행, Outbox 없음)
   * → 시도 행 수 세기 → 이전 READY 시도 SUPERSEDED → 새 READY 시도 INSERT.
   * @throws ProblemError 409 idempotency-request-in-progress, 422 idempotency-key-reused — 플랫폼 IdempotencyStore가 던지는 그대로
   * @throws RangeError 입력이 틀림(코드 오류, DB에 가지 않는다)
   * @throws Error 그 밖의 DB 오류(트랜잭션째 되돌렸다)
   */
  start(once: OrderRequestOnce, input: StartInput, o?: TransactionCallOptions): Promise<StartOutcome>;
}

/** 결제창 값. 'TOSS'는 토스·시뮬레이터 모양(TossCheckout), 'PORTONE'은 포트원 모양(PortoneCheckout)이다 */
export type CheckoutValues =
  | {
      readonly shape: 'TOSS';
      readonly clientKey: string;
      readonly customerKey: string;
      readonly orderId: string;
      readonly orderName: string;
      readonly amount: number;
      readonly successUrl: string;
      readonly failUrl: string;
    }
  | {
      readonly shape: 'PORTONE';
      readonly storeId: string;
      readonly channelKey: string;
      readonly paymentId: string;
      readonly orderName: string;
      readonly totalAmount: number;
      readonly currency: string;
      readonly redirectUrl: string;
      readonly customData: { readonly orderId: string };
    };

/** 결제창 준비 질의(PrepareCheckoutRequest) */
export interface PrepareCheckoutQuery {
  readonly orderId: string;
  readonly attemptId: string;
  readonly eventId: string;
  /** 서버가 계산한 금액(원) */
  readonly amount: number;
  readonly orderName: string;
  /** 비우면 payment-svc가 CARD로 본다 */
  readonly payMethod?: string;
  /** 이 회차에 가상계좌를 내도 되는가. 없으면 칸을 싣지 않는다(참으로 본다) */
  readonly virtualAccountAllowed?: boolean;
  /** 회차의 입장 시작 시각(epoch ms) */
  readonly entryOpensAtMs?: number;
  /** 멱등 재생에서 그 시도의 결제사로 고정한다 */
  readonly pinnedPg?: PaymentPg;
  /** 이 호출의 데드라인(ms, 1 이상 정수) */
  readonly deadlineMs: number;
}

/** 결제창 준비 성공 값(PrepareCheckoutResponse) */
export interface PreparedCheckout {
  readonly pg: PaymentPg;
  readonly switched: boolean;
  readonly checkout: CheckoutValues;
  readonly allowedPayMethods: readonly string[];
  /** 가상계좌를 낼 수 있을 때만 있다 */
  readonly depositDueAtMs?: number;
}

/** 결제사를 못 쓴 까닭: 결제사를 고르지 못함·UNAVAILABLE·데드라인·차단기 열림 */
export type PgUnavailableReason = 'pg_unavailable' | 'unavailable' | 'deadline' | 'circuit_open';

/**
 * 결제창 준비 결과. 던지지 않는다.
 * - OK: 값을 받았다
 * - PG_UNAVAILABLE: 503 pg-unavailable(gRPC UNAVAILABLE·DEADLINE_EXCEEDED·차단기 열림·과부하)
 * - PAY_METHOD_INVALID: payment-svc가 수단 값을 거절했다(가상계좌를 끈 회차 포함, 400)
 * - MISCONFIGURED: 그 밖의 gRPC 코드·gRPC가 아닌 예외·모양이 틀린 답(503 dependency-unavailable, SEV2)
 * - NEW_PAYMENT_PAUSED: 새 결제 일시 정지거나 채널이 없거나 비활성(FAILED_PRECONDITION 글 new-payment-paused, 503, BUILD_ORDER PRF-201)
 */
export type CheckoutOutcome =
  | ({ readonly status: 'OK' } & PreparedCheckout)
  | { readonly status: 'PG_UNAVAILABLE'; readonly reason: PgUnavailableReason }
  | { readonly status: 'PAY_METHOD_INVALID' }
  | { readonly status: 'NEW_PAYMENT_PAUSED' }
  | { readonly status: 'MISCONFIGURED'; readonly reason: string };

/** payment-svc PaymentService.PrepareCheckout(adapters/grpc-payment-checkout.ts). 결제사를 부르지 않는다. 차단기·gRPC 상태 바꾸기는 어댑터가 한다 */
export interface PaymentCheckouts {
  prepare(q: PrepareCheckoutQuery): Promise<CheckoutOutcome>;
}

/** 일시 정지 중인 회차 하나 */
export interface NewPaymentPause {
  readonly eventId: string;
  /** 정지 시작 시각(epoch ms). 채널이 없거나 비활성이면 0 */
  readonly pausedSinceMs: number;
}

/**
 * 일시 정지 조회 결과. 던지지 않는다.
 * - OK: 일시 정지 중인 회차만 담는다
 * - UNAVAILABLE: 답을 받지 못했다(시간 초과·차단기·장애). 만료 작업(HOT-070)은 마지막 답을 10초 [가정] 쓰고 그 뒤 다시 열린 것으로 본다(ADR-0085, docs/features/seat-hold.md §5)
 * - REJECTED: payment-svc가 요청을 거절했다(INVALID_ARGUMENT, 부르는 쪽의 결함이라 다시 물어도 낫지 않는다). 답을 받지 못한 것과 같이 다루되 UNAVAILABLE에 뭉개지 않고 따로 경보한다(BUILD_ORDER PRF-201 코드 리뷰)
 */
export type NewPaymentPauseOutcome = { readonly status: 'OK'; readonly pauses: readonly NewPaymentPause[] } | { readonly status: 'UNAVAILABLE'; readonly reason: string } | { readonly status: 'REJECTED'; readonly reason: string };

/** payment-svc PaymentService.GetNewPaymentPause(adapters/grpc-new-payment-pause.ts). 만료 작업의 조립은 HOT-070이다(BUILD_ORDER PRF-201) */
export interface NewPaymentPauses {
  read(eventIds: readonly string[], o: { readonly deadlineMs: number }): Promise<NewPaymentPauseOutcome>;
}

/** 주문 좌석의 홀드 만료 시각 읽기(운영은 adapters/inventory-bridges.ts InventoryOrderHoldExpiries) */
export interface OrderHoldExpiries {
  /**
   * 그 holdId가 남은 좌석의 홀드 Hash exp 가운데 가장 이른 값(epoch ms). 남은 좌석이 없으면 undefined.
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(쓰임새는 칸을 빼고 응답을 막지 않는다)
   */
  expiresAt(q: { readonly eventId: string; readonly holdId: string; readonly seatIds: readonly string[] }, o?: { deadlineMs?: number }): Promise<number | undefined>;
}

/** 브라우저가 잰 행동 요약(openapi BehaviorSummary, 요약값만. 원시 좌표·키 값은 없다) */
export interface BehaviorSummary {
  readonly v: 1;
  readonly windowMs: number;
  readonly pointerMoves?: number;
  readonly pointerEntropy?: number;
  readonly inputIntervalMeanMs?: number;
  readonly inputIntervalStdMs?: number;
  readonly scrollEvents?: number;
  readonly scrollDistancePx?: number;
}

/** telemetry.behavior BehaviorSignal(asyncapi, screen PAYMENT). 망 정보·기기 가명은 싣지 않는다 */
export interface BehaviorSignalMessage {
  readonly pid: string;
  readonly refMissing: false;
  readonly eventId: string;
  readonly journeyId: string;
  readonly screen: 'PAYMENT';
  readonly features: BehaviorSummary;
  /** ISO 8601(UTC, 밀리초) */
  readonly ts: string;
  readonly eventKey: string;
}

/** 행동 신호 보내기(운영은 adapters/behavior-signals.ts). 실패는 던지고, 쓰임새가 세고 삼킨다 */
export interface BehaviorSignalPublisher {
  publish(message: BehaviorSignalMessage): Promise<void>;
}

/** purchase_payment_attempts_total의 outcome 값 */
export type StartPaymentMetricOutcome = 'started' | 'replayed' | 'exceeded' | 'pg_unavailable' | 'new_payment_paused' | 'deadline' | 'misconfigured' | 'pay_method_invalid';

/** 결제 시도 시작의 지표. 던지지 않는다 */
export interface StartPaymentSignals {
  /** purchase_payment_attempts_total{pg, outcome}(pg는 고르기 전이면 'none') */
  paymentAttempt(pg: PaymentPg | 'none', outcome: StartPaymentMetricOutcome): void;
  /** telemetry_dropped_total{record}(텔레메트리 전송 실패로 버린 수) */
  telemetryDropped(record: 'behavior_signal'): void;
}

/** 결제 시도 시작의 보안·설정 로그(서비스 로그 한 줄씩. 결제창 값·구매자 키·요약은 싣지 않는다). 던지지 않는다 */
export interface StartPaymentLog {
  /** 시도 상한 초과(payment §4.2 7, ASVS 16.3.3): 계정·주문만 */
  attemptsExceeded(e: { readonly accountId: string; readonly orderId: string }): void;
  /** PrepareCheckout의 예상 밖 답(SEV2): 까닭만 */
  checkoutMisconfigured(e: { readonly reason: string }): void;
  /** 홀드 만료를 읽지 못했다(망가진 키. 응답은 칸만 뺀다, 리뷰 고침 L7): SEV2, 회차만 */
  holdExpiryUnreadable(e: { readonly eventId: string }): void;
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
  /** 다음에 해 볼 시각(epoch ms). AWAIT 행은 Infinity다(next_attempt_at = 'infinity', Saga 쓸기 색인의 차례 앞을 막지 않게, 2026-11-06 코드 리뷰 M1) */
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
   * 짧은 트랜잭션 하나: 단계가 AWAIT가 아니고(AWAIT 행은 결제 결과 당기기가 고른다, PRF-171 설계 2) next_attempt_at ≤ 지금이고 임대가 비었거나 지난 행을
   * next_attempt_at 차례로 FOR UPDATE SKIP LOCKED로 limit개까지 골라 lease_until = 지금 + leaseMs를 쓰고 커밋한다. 집은 행들(임대 뒤 값)을 돌려준다. 없으면 [].
   * @throws RangeError limit·leaseMs가 1 이상의 정수가 아님
   */
  claimDue(limit: number, leaseMs: number): Promise<SagaJob[]>;
  /**
   * 그 주문의 작업 하나를 같은 조건(AWAIT가 아니고 기한이 됐고 임대가 비었거나 지남)으로 집는다(접수 직후 kick이 쓴다). 집지 못하면 undefined.
   * 소문자 UUID가 아니면 DB에 가지 않고 undefined
   */
  claim(orderId: string, leaseMs: number): Promise<SagaJob | undefined>;
  /** 작업 행 읽기(임대를 쓰지 않는다). 없으면 undefined */
  get(orderId: string): Promise<SagaJob | undefined>;
  /**
   * 다시 하기로 미룬다: attempts + 1, next_attempt_at = nextAtMs, 임대를 비운다. 행이 없거나 자기 임대가 아니거나 AWAIT 행이면 false
   * (AWAIT는 Saga가 모르는 단계로 다루고 바꾸지 않는다. 쥔 CONFIRM 행을 그사이 결과 반영이 AWAIT로 바꿨어도 무한대 next_attempt_at을 되돌리지 않는다, 리뷰 고침 M1)
   */
  reschedule(orderId: string, nextAtMs: number, lease?: LeaseGuard): Promise<boolean>;
  /**
   * 단계를 바꾼다(attempts 0, next_attempt_at = 지금, 임대 비움. 보낸 시각 confirm_sent_at은 그대로: 한 번 보낸 명령은 되돌릴 수 없다).
   * 판매 예약 트랜잭션 밖에서 바꿀 일(손질·시험)에 쓴다. 행이 없거나 자기 임대가 아니거나 AWAIT 행이면 false
   * (AWAIT는 Saga가 모르는 단계로 다루고 바꾸지 않는다, PRF-171 설계 2)
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
  /** 그 주문의 결제 시도를 만든 차례로 몇 번째인가(1부터, PaymentPullTarget.attemptNo와 같은 셈). 승인 명령의 attempt_no(BUILD_ORDER PRF-180) */
  readonly attemptNo: number;
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
  /** 그 주문의 티켓 무효 작업(ticket_void_job)이 남아 있으면 true. 무효가 끝날 때까지 RELEASE 단계가 좌석을 풀지 않는다(BUILD_ORDER HOT-152 코드 리뷰) */
  readonly ticketVoidPending?: boolean;
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
   * 한 트랜잭션: 그 주문의 CONFIRM 작업 행을 지우지 않고 step = AWAIT(결과 기다림)로 바꾸고(자기 임대 조건. confirm_sent_at은 그대로, pull_next_at은 비우고,
   * next_attempt_at은 무한대로 둔다: Saga 쓸기 색인의 차례 앞을 막지 않게, 리뷰 고침 M1)
   * 바꿨으면 ACCEPTED 시도의 결제 키·거래 ID·토큰을 지운다. AWAIT 행은 결제 결과 당기기가 찾고 결과 반영이 끝낸다(BUILD_ORDER PRF-171 설계 1, ADR-0140).
   * CONFIRM 행이 없었으면 false(다른 실행이 먼저 끝냈거나 결과 반영이 먼저 바꿨다, 아무것도 바꾸지 않는다)
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
  /** 입장 시작 시각(epoch ms, 판 파일의 선택 칸 entryOpensAt). 승인 명령의 entry_opens_at이다(HOT-152가 넘긴 것, BUILD_ORDER PRF-191) */
  readonly entryOpensAtMs?: number;
  /** 가상계좌를 내도 되는가(판 파일 virtualAccountAllowed). 없으면 칸이 없다(승인 명령 virtual_account_allowed, H2) */
  readonly virtualAccountAllowed?: boolean;
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
  /** 회차(ConfirmPaymentRequest.event_id, BUILD_ORDER PRF-180). 주문의 event_id */
  readonly eventId: string;
  /** 결제 시도 순번(1부터, attempt_no. 결제 사건의 필수 칸 attemptNo) */
  readonly attemptNo: number;
  /** 결제창 인증 시각(epoch ms, authenticated_at). 결제 접수가 늘 적으므로 비는 일은 없고, 비면 칸을 빼고 보내 payment-svc가 INVALID_ARGUMENT로 거절한다 */
  readonly authenticatedAtMs?: number;
  readonly pg: PaymentPg;
  readonly refs: ConfirmRefs;
  /** 서버 금액(원, Money.krw) */
  readonly amount: number;
  /** 회차의 입장 시작 시각(epoch ms, entry_opens_at). 판 파일에 없으면 칸을 싣지 않는다(HOT-152가 넘긴 것, BUILD_ORDER PRF-191) */
  readonly entryOpensAtMs?: number;
  /** 가상계좌를 내도 되는가(판 파일 virtualAccountAllowed). 없으면 칸이 없다(승인 명령 virtual_account_allowed, H2) */
  readonly virtualAccountAllowed?: boolean;
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
  /** 입금 대기 전이(T10·T14)이고 입금 기한을 알 때만: 판매 행 pending_until을 함께 쓴다(BUILD_ORDER HOT-151) */
  readonly depositPending?: { readonly eventId: string; readonly seatIds: readonly string[]; readonly pendingUntilMs: number };
}

/** 입금 오류 되돌림 쓰기 입력(T21, BUILD_ORDER HOT-152) */
export interface PaymentReverseInput extends PaymentResultWriteBase {
  readonly transition: 'T21';
  readonly eventId: string;
  readonly seatIds: readonly string[];
  /** 판매 행 pending_until(epoch ms) = 새 입금 기한 + 10분 [가정]. 사건에 기한이 없으면 없다 */
  readonly pendingUntilMs?: number;
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
   * 승인 한 트랜잭션: 작업 행 정리(그 주문의 order_saga_job이 있으면 단계와 상관없이 지운다. 결과를 기다리던 AWAIT 행도 같다, PRF-171) → 주문 행 잠금(상태·순번이 출발이 아니면 바로 STALE, 권고1)
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
   * 상태만 바꾸는 한 트랜잭션(T12 UNKNOWN, T10·T14 입금 대기, 중간 결과): 작업 행을 지우지 않고 AWAIT로 남긴다(있으면. 단계와 상관없이 step = AWAIT,
   * pull_next_at = 지금 + 30초 [가정](T12)·60초 [가정](T10·T14), next_attempt_at = 무한대(리뷰 고침 M1), confirm_sent_at은 그대로.
   * 뒤따르는 최종 결과를 결과 당기기가 받는다, PRF-171.
   * 행이 없으면 넣지 않는다 [정함: 손질·옛 행의 길이다])
   * → 주문 행 잠금(상태·순번이 출발이 아니면 바로 STALE. 되돌리므로 작업 행도 그대로다) → 남은 결제 참조 지우기(이 사건이 왔다는 것은 승인 명령이 접수됐다는 뜻, 리뷰 M1)
   * → 주문 T10·T12·T14(T12는 사건 없이 이력만, T10·T14는 AWAITING_DEPOSIT 사건). 판매 행 PENDING은 그대로 둔다.
   * @throws RangeError 입력이 틀림 · Error 그 밖의 DB 오류(되돌렸다)
   */
  mark(input: PaymentMarkInput): Promise<PaymentResultWriteOutcome>;
  /**
   * 입금 오류 되돌림 한 트랜잭션(T21, BUILD_ORDER HOT-152): 작업 행 AWAIT(없으면 넣는다) → 주문 행 잠금(상태·순번) → 판매 행 SOLD → PENDING(바뀐 수가 좌석 수가 아니면 되돌리고 SOLD_MISMATCH)
   * → 주문 항목 ticket_id 비우기 → ticket_void_job 한 행(무효로 할 세대 = 되돌림 직전의 payment_event_seq) → T21(trade.orders DEPOSIT_REVERSED, Outbox 마지막).
   * @throws RangeError 입력이 틀림 · Error 그 밖의 DB 오류(되돌렸다)
   */
  reverse(input: PaymentReverseInput): Promise<PaymentResultWriteOutcome>;
  /**
   * APPROVED 주문에 입금 되돌림이 와서 보류할 때 그 주문의 발권 작업을 멈춘다(미납 티켓이 새로 나가지 않게, BUILD_ORDER HOT-152 코드 리뷰): 멈추지 않은 ticket_issue_job 행의 next_attempt_at·lease_until을 비우고 last_error = DEPOSIT_REVERSED.
   * 임대도 비워 돌던 발권의 늦은 답이 쓰지 못한다(같은 세대라 다시 켠 뒤의 발권은 멱등이다). 이번에 멈췄으면 true. 소문자 UUID가 아니면 DB에 가지 않고 false
   * @throws Error DB 오류(보류하지 않고 처리기가 일시 실패로 다시 한다)
   */
  holdIssue(orderId: string): Promise<boolean>;
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
  /** 입금 대기 사건에 입금 기한이 없어 판매 행 pending_until을 비워 둔다(warn, kind payment-result-deposit-due-missing, 주문 ID만, BUILD_ORDER HOT-151). 없으면 부르지 않는다 */
  depositDueMissing?(e: { readonly orderId: string }): void;
}

/**
 * 입금 안내 읽기(payment-svc GetPayment, docs/features/payment.md §6 '결제 상태 응답', BUILD_ORDER HOT-151). 계좌번호는 응답에만 싣고 저장하지 않는다.
 * 던지지 않는다(실패는 값으로 돌려준다).
 */
export interface PaymentDepositReader {
  /**
   * @param orderId 주문 ID
   * @param o.deadlineMs 이 호출의 데드라인(ms). 어댑터가 상한 300ms [가정]로 자른다
   * @returns 입금 안내. 안내가 없으면(입금 대기가 아님, 없는 결제, 답의 주문이 요청과 다름) undefined, 일시 실패면 PAYMENT_DEPOSIT_READ_TRANSIENT
   */
  read(orderId: string, o?: { readonly deadlineMs?: number }): Promise<PaymentDepositRead>;
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

// ---- 발권 호출과 재시도 큐(ADR-0106 결정 2, docs/features/payment.md §3 T18, docs/data.md §5, BUILD_ORDER PRF-170) ----
// 실행기(application/ticket-issue.ts): 틱마다 TicketIssueJobs.markDelayed(ISSUE_DELAYED 한 번)·markOverdue(기한 넘김 한 번) → claimDue(빈자리만큼, 짧은 트랜잭션에서
// FOR UPDATE SKIP LOCKED로 골라 임대를 쓰고 커밋) → 잠금 밖에서 TicketIssuer.issue(파드 동시 자리 8개 [가정], 자리는 그 뒤 쓰기까지 쥔다) → 성공 complete(한 트랜잭션:
// T18·티켓 ID·큐 행 지우기·Outbox CONFIRMED) / 다시 보낼 실패 retry / 다시 보내지 않을 실패 stop. 10초 [가정]마다 gauges로 큐 게이지를 잰다.
// 승인 반영 커밋 뒤에는 kick으로 그 주문을 곧바로 한 번 돈다(빈자리가 없으면 틱에 맡긴다). 운영 저장소는 실행기 전용 일반 풀을 쓴다(리뷰 고침 H1).
// 잠금 차례는 Saga와 같이 작업 행(ticket_issue_job) → 주문 행 → 주문 항목이다. 주문 상태는 주문 전이 함수(DrizzleOrderStore.transition)로만 바꾼다.

/** 잡은 발권 큐 행 하나(ticket_issue_job 행 + 발권 호출에 넘길 주문의 칸) */
export interface TicketIssueJob {
  readonly orderId: string;
  /** 회차(ticket_issue_job.event_id, IssueTickets event_id) */
  readonly eventId: string;
  /** 결제자 계정(purchase_order.account_id, IssueTickets payer_account_id. 처음에는 결제자가 보유자다) */
  readonly payerAccountId: string;
  /** 주문 항목의 좌석 ID(줄 번호 차례, 1~10개. IssueTickets seat_ids) */
  readonly seatIds: readonly string[];
  /** 이 발권을 낳은 승인 사건의 순번(ticket_issue_job.issue_generation, IssueTickets issue_generation, BUILD_ORDER HOT-152) */
  readonly issueGeneration: number;
  /** 지금까지의 발권 시도 수(retry·stop이 1 올린다. 잡기는 바꾸지 않는다) */
  readonly attempts: number;
  /** 다음 시도 시각(epoch ms). 잡은 행은 늘 있다(멈춘 행은 잡히지 않는다) */
  readonly nextAttemptAtMs: number;
  /** 발권 기한(epoch ms, issue_due_at = 승인 + 30분 [가정]) */
  readonly issueDueAtMs: number;
  /** 큐 행을 넣은 시각(epoch ms, created_at = purchase가 승인을 반영한 시각) */
  readonly createdAtMs: number;
  /** 임대 끝 시각(epoch ms, 잡을 때 쓴 값). 자기 임대 조건으로 넘긴다 */
  readonly leaseUntilMs: number;
  /** 마지막 실패 코드(last_error). 없으면 아직 실패한 적이 없다 */
  readonly lastError?: string;
}

/**
 * 임대를 쓰지 않고 읽은 큐 행(TicketIssueJobs.get). 잡은 행(TicketIssueJob)과 칸이 같고, 잡지 않은 행·멈춘 행이면 두 칸이 비어 null이다:
 * nextAttemptAtMs(멈춘 행), leaseUntilMs(잡지 않았거나 임대를 놓은 행).
 * 구현에서 정한 것(뼈대는 get도 TicketIssueJob을 돌려줘 두 칸을 채울 값이 없었다): 두 칸을 number | null로 둔다.
 * TicketIssueJob 자체를 바꾸지 않은 까닭은 잡은 행에서는 두 칸이 늘 있어 자기 임대 조건·늘려 쉬기에 그대로 쓰기 때문이다
 */
export type TicketIssueJobView = Omit<TicketIssueJob, 'nextAttemptAtMs' | 'leaseUntilMs'> & {
  readonly nextAttemptAtMs: number | null;
  readonly leaseUntilMs: number | null;
};

/** 발권 호출 입력(ticket.proto IssueTicketsRequest) */
export interface TicketIssueCommand {
  readonly orderId: string;
  readonly eventId: string;
  readonly payerAccountId: string;
  /** 판매 확정(SOLD)된 좌석(주문 항목, 1~10개) */
  readonly seatIds: readonly string[];
  /** 이 호출의 데드라인(ms, 1 이상 정수). 실행기가 TICKET_ISSUE_CALL_DEADLINE_MS(2초 [가정])로 준다 */
  readonly deadlineMs: number;
  /** 이 발권을 낳은 승인 사건의 순번(재발권이 앞 세대와 멱등 충돌하지 않게, BUILD_ORDER HOT-152). 없으면 칸을 비운다(0) */
  readonly issueGeneration?: number;
}

/** 티켓 무효 호출 입력(ticket.proto VoidTicketsRequest, BUILD_ORDER HOT-152) */
export interface TicketVoidCommand {
  readonly orderId: string;
  readonly eventId: string;
  /** 무효로 할 발권 세대(되돌림 직전의 payment_event_seq) */
  readonly issueGeneration: number;
  readonly deadlineMs: number;
}

/** ticket-svc 티켓 무효 호출(운영은 GrpcTicketIssuer, 주소가 없으면 local·ci만 대역) */
export interface TicketVoider {
  /** @throws TicketIssueCallError 모든 실패(코드 규칙은 발권 호출과 같다) */
  voidTickets(c: TicketVoidCommand): Promise<TicketVoidResult>;
}

/** 티켓 무효 호출의 답 */
export interface TicketVoidResult {
  /** 그 세대의 티켓 가운데 입장 기록이 있는 수(ticket.proto VoidTicketsResponse.already_entered, BUILD_ORDER HOT-152 코드 리뷰) */
  readonly alreadyEntered: number;
}

/** 잡은 티켓 무효 큐 행 */
export interface TicketVoidJob {
  readonly orderId: string;
  readonly eventId: string;
  readonly issueGeneration: number;
  readonly attempts: number;
  readonly leaseUntilMs: number;
}

/** 티켓 무효 큐(운영은 adapters/db/drizzle-ticket-void.ts, 잡기·다시 보내기는 발권 큐와 같은 꼴이다) */
export interface TicketVoidJobs {
  claimDue(limit: number, leaseMs: number): Promise<TicketVoidJob[]>;
  claim(orderId: string, leaseMs: number): Promise<TicketVoidJob | undefined>;
  /** 무효 호출이 끝났다: 자기 임대 조건으로 행을 지운다. 임대를 잃었으면 false */
  done(orderId: string, leaseUntilMs: number): Promise<boolean>;
  retry(i: { readonly orderId: string; readonly nextAtMs: number; readonly code: TicketIssueFailureCode; readonly leaseUntilMs: number }): Promise<boolean>;
  stop(i: { readonly orderId: string; readonly code: TicketIssueFailureCode; readonly leaseUntilMs: number }): Promise<boolean>;
}

/** 티켓 무효 로그(주문 ID·코드만). 던지지 않는다 */
export interface TicketVoidLog {
  /** 다시 보내도 같은 결과일 실패로 멈췄다(SEV1, kind ticket-void-stopped. 재발권과 좌석 반환이 그 무효를 기다린다, BUILD_ORDER HOT-152 코드 리뷰) */
  stopped(e: { readonly orderId: string; readonly code: TicketIssueFailureCode }): void;
  /** 무효로 한 세대에 입장 기록이 있는 표가 있었다(SEV1, kind ticket-void-already-entered, 주문 ID·수만, BUILD_ORDER HOT-152 코드 리뷰) */
  alreadyEntered(e: { readonly orderId: string; readonly count: number }): void;
  runError(e: { readonly what: 'claim' | 'call' | 'write'; readonly orderId?: string; readonly err: unknown }): void;
}

/** 티켓 무효 지표(ticket_void_attempts_total{result}). 던지지 않는다 */
export interface TicketVoidSignals {
  attempt(result: 'voided' | 'retry' | 'stopped'): void;
}

/**
 * 발권 호출이 실패했다(TicketIssuer.issue가 던지는 하나뿐인 오류 형). code는 gRPC 상태 이름·CIRCUIT_OPEN·BAD_ANSWER이고
 * ticket_issue_job.last_error에 그대로 적는다. 다시 보낼지는 ticketIssueFailureKind(code)가 정한다. 글에는 코드만 싣는다(좌석·계정은 싣지 않는다)
 */
export class TicketIssueCallError extends Error {
  constructor(
    readonly code: TicketIssueFailureCode,
    cause?: unknown,
  ) {
    super(`발권 호출이 실패했다: ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'TicketIssueCallError';
  }
}

/**
 * 발권 호출 포트(ticket-svc TicketService.IssueTickets, 주문 ID로 멱등. 운영은 adapters/grpc-ticket-issue.ts GrpcTicketIssuer, local·ci는 '늘 발권' 대역).
 * 차단기·데드라인·gRPC 상태 → 코드 바꾸기는 어댑터가 한다. 다시 묻지 않는다(다시 보내기는 실행기의 retry다)
 */
export interface TicketIssuer {
  /**
   * @returns 좌석별 티켓 ID와 상태(답의 tickets 그대로, 차례는 보장하지 않는다. 주문 좌석과 맞는지·상태가 ISSUED·ACTIVE인지는 실행기가 issuedTicketsMatch로 본다)
   * @throws TicketIssueCallError 모든 실패(gRPC 오류는 상태 이름, 차단기 열림 CIRCUIT_OPEN, 남은 시간 없음 DEADLINE_EXCEEDED, 동시 호출 상한 RESOURCE_EXHAUSTED,
   *   gRPC가 아닌 예외 UNKNOWN)
   */
  issue(c: TicketIssueCommand): Promise<readonly IssuedTicketRef[]>;
}

/** 성공 반영 입력 */
export interface TicketIssueCompleteInput {
  readonly orderId: string;
  /** 좌석별 티켓 ID(issuedTicketsMatch를 지난 것: 주문 좌석마다 하나) */
  readonly tickets: readonly IssuedTicketRef[];
  /** 행위자(ACTOR_PATTERN). 발권 실행기는 system:ticket-issue(TICKET_ISSUE_ACTOR) */
  readonly actor: string;
  /** 자기 임대 조건(첫 문장인 큐 행 잠금에 건다). 없으면 조건을 걸지 않는다(손질·시험) */
  readonly leaseUntilMs?: number;
}

/**
 * 성공 반영 결과.
 * - CONFIRMED: 한 트랜잭션에서 T18(APPROVED → CONFIRMED)·order_item.ticket_id·큐 행 지우기·Outbox CONFIRMED를 커밋했다
 * - STALE: 주문이 APPROVED가 아니라(이미 CONFIRMED·보상 등, 늦게 온 발권 답) 상태·티켓 ID는 그대로 두고 큐 행만 지웠다(커밋). current = 지금 상태
 * - LEASE_LOST: 큐 행이 없거나 자기 임대가 아니라 아무것도 바꾸지 않았다(되돌렸다)
 */
export type TicketIssueCompleteOutcome =
  | { readonly status: 'CONFIRMED' }
  | { readonly status: 'STALE'; readonly current?: OrderStatus }
  | { readonly status: 'LEASE_LOST' };

/** 다시 보내기 입력 */
export interface TicketIssueRetryInput {
  readonly orderId: string;
  /** 다음 시도 시각(epoch ms) = 지금 + ticketIssueRetryDelayMs(attempts + 1, random()) */
  readonly nextAtMs: number;
  /** last_error에 적을 코드 */
  readonly code: TicketIssueFailureCode;
  /** 자기 임대 조건. 없으면 조건을 걸지 않는다 */
  readonly leaseUntilMs?: number;
}

/** 멈추기 입력 */
export interface TicketIssueStopInput {
  readonly orderId: string;
  /** last_error에 적을 코드(다시 보내지 않을 실패) */
  readonly code: TicketIssueFailureCode;
  /** 자기 임대 조건. 없으면 조건을 걸지 않는다 */
  readonly leaseUntilMs?: number;
}

/** 큐 게이지(한 질의로 잰 값) */
export interface TicketIssueGauges {
  /** next_attempt_at이 있는 행 수(처음·다시 보낼 행, ticket_issue_jobs{state="pending"}) */
  readonly pending: number;
  /** next_attempt_at을 비운 행 수(다시 보내지 않을 실패로 멈춘 행, ticket_issue_jobs{state="stopped"}) */
  readonly stopped: number;
  /** 다시 보낼 행(next_attempt_at 있음) 가운데 가장 오래된 행의 나이(초, 지금 − created_at, 0 이상. 멈춘 행은 빼고, 그런 행이 없으면 0. ticket_issue_oldest_seconds, 리뷰 고침 M3) */
  readonly oldestAgeSeconds: number;
}

/** 발권 큐 저장소(운영은 adapters/db/drizzle-ticket-issue.ts DrizzleTicketIssue). '지금'은 앱 시계다(Saga와 같다) */
export interface TicketIssueJobs {
  /**
   * 짧은 트랜잭션 하나: next_attempt_at ≤ 지금이고 임대가 비었거나 지난(lease_until < 지금, docs/data.md §5.1 행과 같다. Saga 잡기의 ≤와 다르다) 행을 next_attempt_at 차례(같으면 주문 ID)로
   * FOR UPDATE SKIP LOCKED로 limit개까지 골라 lease_until = 지금 + leaseMs를 쓰고 커밋한다. 주문의 결제자·좌석을 붙여 고른 차례로 돌려준다. 없으면 [].
   * 멈춘 행(next_attempt_at 비움)은 잡지 않는다. attempts는 바꾸지 않는다.
   * @throws RangeError limit·leaseMs가 1 이상의 정수가 아님
   */
  claimDue(limit: number, leaseMs: number): Promise<TicketIssueJob[]>;
  /** 그 주문의 행 하나를 같은 조건으로 잡는다(승인 반영 직후 kick이 쓴다). 잡지 못하면 undefined. 소문자 UUID가 아니면 DB에 가지 않고 undefined */
  claim(orderId: string, leaseMs: number): Promise<TicketIssueJob | undefined>;
  /** 큐 행 읽기(임대를 쓰지 않는다. 잡지 않은 행·멈춘 행도 읽는다). 없거나 소문자 UUID가 아니면 undefined(kick의 NO_JOB·LEASED 가르기) */
  get(orderId: string): Promise<TicketIssueJobView | undefined>;
  /**
   * 성공 반영 한 트랜잭션(READ COMMITTED, 잠금 차례 큐 행 → 주문 행 → 주문 항목): 큐 행 잠금(자기 임대. 0행이면 LEASE_LOST)
   * → 주문 행 잠금·상태 확인(APPROVED가 아니면 상태·티켓 ID는 그대로 두고 큐 행만 지워 STALE) → order_item.ticket_id = 좌석별 티켓 ID → 큐 행 지우기
   * → 주문 전이 T18(조건부: 출발 상태 APPROVED일 때만. Outbox CONFIRMED가 업무 문장의 마지막).
   * @throws RangeError 입력이 틀림(티켓 묶음 모양·행위자·임대 값은 DB에 가기 전에 본다. 티켓이 주문 좌석과 맞지 않음은 주문 행을 잠근 뒤 항목과 견주어 보고 되돌린다
   *   [구현에서 정한 것: 수가 같고 주문에 없는 좌석이 섞인 묶음은 주문 항목을 읽어야 가려진다]) · Error 그 밖의 DB 오류(되돌렸다)
   */
  complete(input: TicketIssueCompleteInput): Promise<TicketIssueCompleteOutcome>;
  /**
   * 다시 보내기: attempts + 1, last_error = code, next_attempt_at = nextAtMs, lease_until 비움(자기 임대일 때만). 주문 이력(T19)은 쓰지 않는다.
   * 행이 없거나 자기 임대가 아니면 false
   */
  retry(input: TicketIssueRetryInput): Promise<boolean>;
  /** 멈추기: attempts + 1, last_error = code, next_attempt_at 비움, lease_until 비움(자기 임대일 때만). 행이 없거나 자기 임대가 아니면 false */
  stop(input: TicketIssueStopInput): Promise<boolean>;
  /** 임대만 놓는다(lease_until = null, 자기 임대일 때만. 다른 칸은 그대로). 다음 틱에 다시 잡힌다. 놓은 행이 없으면 false */
  release(orderId: string, leaseUntilMs: number): Promise<boolean>;
  /**
   * ISSUE_DELAYED 내기 한 트랜잭션: created_at ≤ 지금 − 60초 [가정]이고 delayed_at이 빈 행을 limit개까지(created_at 차례, SKIP LOCKED) 골라
   * delayed_at = 지금을 쓰고 행마다 Outbox ISSUE_DELAYED(상태 전이·이력 없음, eventKey = issueDelayedEventKey)를 트랜잭션의 마지막에 한 번에 쓴다. 낸 주문 ID들(없으면 []).
   * 멈춘 행·임대 중인 행도 대상이다(발권이 늦어지는 중인 것은 같다)
   * @throws RangeError limit이 1 이상의 정수가 아님
   */
  markDelayed(limit: number): Promise<string[]>;
  /**
   * 발권 기한 넘김 표시 한 트랜잭션: issue_due_at ≤ 지금이고 overdue_at이 빈 행을 limit개까지(issue_due_at 차례, SKIP LOCKED) 골라 overdue_at = 지금을 쓴다.
   * 표시한 주문 ID들(실행기가 SEV1 오류 로그를 행마다 한 줄 남긴다). 재시도는 그대로 이어 간다(next_attempt_at을 건드리지 않는다)
   * @throws RangeError limit이 1 이상의 정수가 아님
   */
  markOverdue(limit: number): Promise<string[]>;
  /** 큐 게이지 한 질의(잠그지 않는다) */
  gauges(): Promise<TicketIssueGauges>;
}

/** 발권 실행기 로그(서비스 로그 한 줄. 좌석·계정·티켓 ID는 싣지 않는다). 던지지 않는다 */
export interface TicketIssueLog {
  /** 다시 보내지 않을 실패로 멈췄다(error 한 줄 { kind: 'ticket-issue', severity: 'SEV2', orderId, code, csCase: 'TICKET_NOT_ISSUED' }) */
  stopped(e: { readonly orderId: string; readonly code: TicketIssueFailureCode }): void;
  /** 발권 기한을 넘겼다(error 한 줄 { kind: 'ticket-issue-overdue', severity: 'SEV1', orderId, csCase: 'TICKET_NOT_ISSUED' }). 주문마다 한 번 */
  overdue(e: { readonly orderId: string }): void;
  /** 늦게 온 발권 답(warn 한 줄 { kind: 'ticket-issue', event: 'stale_answer', orderId, current? }): 주문이 APPROVED가 아니라 큐 행만 지웠다 */
  staleAnswer(e: { readonly orderId: string; readonly current?: OrderStatus }): void;
  /** 예상 밖 오류(error 한 줄, 플랫폼 errorSummary로 줄인 오류. 쿼리 매개변수 값은 싣지 않는다). orderId는 큐 행 하나의 오류일 때만 */
  runError(e: { readonly what: TicketIssueRunStage; readonly orderId?: string; readonly err: unknown }): void;
}

/** 발권 실행기 지표(운영은 adapters/prom-ticket-issue-signals.ts PromTicketIssueSignals). 던지지 않는다 */
export interface TicketIssueSignals {
  /** 게이지 ticket_issue_jobs{state}(pending·stopped)와 ticket_issue_oldest_seconds를 둔다(10초 [가정]마다) */
  jobs(g: TicketIssueGauges): void;
  /** 카운터 ticket_issue_attempts_total{result}(issued·retry·stopped·stale)를 1 올린다(발권 호출을 마친 큐 행마다) */
  attempt(result: TicketIssueAttemptResult): void;
  /** 카운터 ticket_issue_delayed_total을 count만큼 올린다(ISSUE_DELAYED를 낸 주문 수, SEV2) */
  delayed(count: number): void;
  /** 카운터 ticket_issue_overdue_total을 count만큼 올린다(발권 기한을 넘긴 주문 수, SEV1) */
  overdue(count: number): void;
}

// ---- 결제 결과 당기기(ADR-0140 결정 1~4, docs/features/payment.md §2, docs/data.md order_saga_job·§5.1, BUILD_ORDER PRF-171) ----
// 실행기(application/payment-result-pull.ts): 틱마다 PaymentPullTargets.claimDue(짧은 트랜잭션에서 FOR UPDATE SKIP LOCKED로 골라 pull_next_at = 지금 + 5초 [가정]을 쓰고 커밋)
// → 잠금 밖에서 PaymentResultReader.batchGet(100건 [가정]씩, 파드마다 동시 4개 [가정], 데드라인 500ms [가정]) → 답마다 paymentStateToResultEvent(domain/payment-pull.ts)
// → 사건 길과 같은 ApplyPaymentResult.execute → 다음 점검을 PaymentPullTargets.defer로 미룬다(답이 UNKNOWN 30초·입금 대기 60초·취소 상태·모양 틀림 60초·
// 보류·오래 기록 없음 10분·payment-svc가 답하지 못한 묶음 30초 [가정], docs/features/payment.md §2 '기록 없음이 길어질 때').
// 대상은 승인 명령을 보낸 작업 행(order_saga_job step CONFIRM·AWAIT, confirm_sent_at 있음)이고 trade.payments 보류 사건이 있는 주문은 뺀다(설계 1·3,
// 2026-11-06 코드 리뷰 M4). 운영 저장소는 당기기 전용 일반 풀(연결 2개 [가정])을 쓴다.

/** 당기기 대상 하나(order_saga_job의 CONFIRM·AWAIT 행 + 그 주문 ACCEPTED 결제 시도의 순번) */
export interface PaymentPullTarget {
  readonly orderId: string;
  /** 회차(order_saga_job.event_id). 만든 결제 사건의 eventId */
  readonly eventId: string;
  /**
   * 그 주문 ACCEPTED 결제 시도의 순번(그 주문의 결제 시도를 만든 차례로 몇 번째인가, 1부터). 만든 사건의 attemptNo 칸을 채울 뿐 반영에는 쓰지 않는다
   * (결정 함수·쓰기가 보지 않는다. 사건 길의 값과 같다는 보장이 없다, docs/features/payment.md §2 '기록 없음이 길어질 때').
   * ACCEPTED 시도가 없으면 0(코드 오류·손질. 이때 반영의 결정은 이 값이 아니라 주문의 접수한 결제 시도가 없음을 보고 PG_MISMATCH로 보류한다)
   * [정함: payment_attempt에 순번 칸이 없어 저장소가 센다]
   */
  readonly attemptNo: number;
  /** 승인 명령을 처음 보내기 바로 전에 적은 시각(epoch ms, confirm_sent_at). 대상은 늘 있다. 기록 없음이 길어졌는지(10분 [가정]) 본다 */
  readonly confirmSentAtMs: number;
}

/** 당기기 대상 저장소(운영은 adapters/db/drizzle-payment-pull.ts DrizzlePaymentPull). '지금'은 앱 시계다. Saga 실행기의 칸은 쓰지 않는다 */
export interface PaymentPullTargets {
  /**
   * 짧은 트랜잭션 하나: step이 CONFIRM·AWAIT이고 confirm_sent_at ≤ 지금 − 5초 [가정]이며 pull_next_at이 비었거나 ≤ 지금인 order_saga_job 행을
   * FOR UPDATE SKIP LOCKED로 limit개까지 골라 pull_next_at = 지금 + 5초 [가정]을 쓰고 커밋한다(파드 여럿이어도 같은 주문은 5초에 한 번, ADR-0140 결정 1).
   * 그 주문의 trade.payments 보류 사건(held_event, 다시 처리 전)이 있으면 고르지 않는다(당기기가 앞지르면 보류 사건이 다시 처리될 때 버려진다, 리뷰 고침 M4).
   * 고른 차례로 돌려준다. 없으면 [].
   * @throws RangeError limit이 1 ~ PAYMENT_PULL_BATCH(100)의 정수가 아님
   */
  claimDue(limit: number): Promise<PaymentPullTarget[]>;
  /**
   * 그 주문들의 다음 점검을 untilMs로 미룬다(pull_next_at = untilMs, step이 CONFIRM·AWAIT인 행만, 한 문장). 미룬 행 수(행이 없어진 주문은 세지 않는다).
   * 소문자 UUID가 아닌 ID는 빼고, 남은 것이 없으면 DB에 가지 않고 0
   * @throws RangeError untilMs가 날짜(유닉스 밀리초)가 아님
   */
  defer(orderIds: readonly string[], untilMs: number): Promise<number>;
}

/**
 * BatchGetPayments가 실패했다(PaymentResultReader.batchGet이 던지는 하나뿐인 오류 형). code는 gRPC 상태 이름·CIRCUIT_OPEN·BAD_ANSWER다.
 * 글에는 코드만 싣는다(주문 ID·금액은 싣지 않는다). 원인(cause)에는 받은 오류를 그대로 단다
 */
export class PaymentPullCallError extends Error {
  constructor(
    readonly code: PaymentPullFailureCode,
    cause?: unknown,
  ) {
    super(`결제 결과 당기기 호출이 실패했다: ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'PaymentPullCallError';
  }
}

/**
 * 결제 결과 당기기 클라이언트(payment-svc PaymentService.BatchGetPayments, 읽기만 하고 결제사는 부르지 않는다, ADR-0140 결정 3).
 * 운영은 adapters/grpc-payment-results.ts GrpcPaymentResultReader(차단기 payment-svc-batch), local·ci는 '기록 없음' 대역이다.
 * 다시 묻지 않는다(다시 묻기는 실행기의 다음 점검이다)
 */
export interface PaymentResultReader {
  /**
   * @param orderIds 묻는 주문 ID(1 ~ PAYMENT_PULL_BATCH(100)건). 빈 배열이면 부르지 않고 []
   * @param o.deadlineMs 이 호출의 데드라인(ms, 1 이상 정수). 실행기가 PAYMENT_PULL_DEADLINE_MS(500ms [가정])로 주고, 어댑터가 상한 500ms로 자른다
   * @returns 결제 기록이 있는 주문의 상태(답의 payments 그대로, 차례는 보장하지 않는다). 기록 없는 주문(승인 명령이 아직 적히지 않음)은 빠진다
   * @throws PaymentPullCallError 모든 호출 실패(gRPC 오류는 상태 이름, 차단기 열림 CIRCUIT_OPEN, 남은 시간 없음 DEADLINE_EXCEEDED, 동시 호출 상한 RESOURCE_EXHAUSTED,
   *   답 모양이 틀림 BAD_ANSWER, gRPC가 아닌 예외 UNKNOWN)
   * @throws RangeError orderIds가 100건을 넘음(부르는 쪽이 나눠 부른다, 코드 오류. 부르지 않는다)
   */
  batchGet(orderIds: readonly string[], o?: { readonly deadlineMs?: number }): Promise<OrderPaymentState[]>;
}

/**
 * 결제 결과 당기기 로그(서비스 로그 한 줄. 금액·결제 참조는 싣지 않는다). 던지지 않는다.
 * 반영이 보류(HOLD)로 끝난 줄은 ApplyPaymentResult가 PaymentResultLog.held로 남긴다(같은 사건·까닭은 창 안에서 한 번, 설계 6). 호출 실패는 지표만 센다(발권 재시도와 같다)
 */
export interface PaymentPullLog {
  /**
   * 승인 명령을 보낸 지 10분 [가정]이 지나도 답에 없다(error 한 줄 { kind: 'payment-result-missing', severity: 'SEV2', orderId }, 설계 7).
   * 실행기가 그 주문의 다음 점검을 10분 [가정] 미루고(파드가 많아도 주문마다 10분에 한 줄, 리뷰 고침 M3) 파드 메모리 창 10분 [가정](PAYMENT_PULL_MISSING_LOG_WINDOW_MS)
   * 안에서 한 번만 부른다. 주문을 실패로 단정하지 않는다(명령 기한 넘김 처리는 PRF-180)
   */
  missing(e: { readonly orderId: string }): void;
  /**
   * 반영하지 않는 답(warn 한 줄 { kind: 'payment-result-pull', event: 'ignored', orderId, reason, status }). CANCELED(부분 취소)는 취소 흐름(PRF-173·환불 단계) 몫,
   * MALFORMED는 반영할 수 없는 모양의 답이다 [정함]. 실행기가 그 주문의 다음 점검을 60초 [가정] 미룬다
   */
  ignored(e: { readonly orderId: string; readonly reason: PaymentPullIgnoreReason; readonly status: PaymentLedgerStatus }): void;
  /** 예상 밖 오류(error 한 줄, 플랫폼 errorSummary로 줄인 오류. 쿼리 매개변수 값은 싣지 않는다). orderId는 주문 하나의 오류일 때만 */
  runError(e: { readonly what: PaymentPullRunStage; readonly orderId?: string; readonly err: unknown }): void;
}

/** 결제 결과 당기기 지표(운영은 adapters/prom-payment-pull-signals.ts PromPaymentPullSignals, 이름은 설계 8). 던지지 않는다 */
export interface PaymentPullSignals {
  /** 카운터 payment_result_pulled_total{type}을 1 올린다(당기기로 반영한 주문: execute가 APPLIED. 1분 동안 0보다 크면 SEV3, ADR-0140 결정 4) */
  pulled(type: AppliedPaymentEventType): void;
  /** 카운터 payment_result_pull_batches_total을 1 올린다(BatchGetPayments를 부른 수, 성패와 상관없이) */
  batch(): void;
  /** 카운터 payment_result_pull_failures_total을 1 올린다(BatchGetPayments 실패. 1분 이어지면 SEV2, ADR-0140 결정 4) */
  failure(): void;
}

// ---- 결제하지 않은 주문의 만료와 안전망(ADR-0107 결정 1·2, BUILD_ORDER PRF-172 설계 1~5) ----

/** 만료를 판정하고 다리를 부를 때 쓰는 주문 칸 */
export interface OrderExpiryOrder {
  readonly orderId: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly purchaseSessionId: string;
  readonly holdId: string;
  readonly status: OrderStatus;
  /**
   * 주문 항목의 좌석 ID(줄 번호 차례). OrderExpiryStore.order만 채운다(구현에서 정한 것: 목록 읽기는 찾은 주문을 check가 order로 다시 읽으므로 항목 표까지 읽지 않는다.
   * 묶음 읽기의 실행 계획을 data.md §5.1 그대로 둔다)
   */
  readonly seatIds?: readonly string[];
}

/** 잠그고 다시 보며 전이하기의 입력. sessionEnded·holdRemains는 트랜잭션을 열기 전에 읽은 값이다(DB 잠금을 쥔 채 Redis를 부르지 않는다) */
export interface OrderExpiryInput {
  readonly orderId: string;
  readonly sessionEnded: boolean;
  readonly holdRemains: boolean;
  /** order_event.actor(ORDER_EXPIRY_ACTOR) */
  readonly actor: string;
}

/** 만료 판정의 결과. NOT_OPEN의 current는 지금 상태(주문이 없으면 없다) */
export type OrderExpiryOutcome =
  | { readonly status: 'EXPIRED'; readonly transition: OrderExpiryTransition; readonly seq: number }
  | { readonly status: 'NOT_YET'; readonly reason: OrderExpiryNotYetReason }
  | { readonly status: 'NOT_OPEN'; readonly current?: OrderStatus };

/** READY에서 EXPIRED로 바꾼 결제 시도 하나 */
export interface OrderExpiredAttempt {
  readonly attemptId: string;
  readonly orderId: string;
}

/** 묶음 읽기의 범위. 만든 시각을 UUIDv7 경계(플랫폼 uuidLowerBound)로 바꿔 기본 키 범위 [createdFromMs, createdBeforeMs)로 읽는다 */
export interface OrderExpiryRange {
  readonly createdFromMs: number;
  readonly createdBeforeMs: number;
  /** 1 ~ ORDER_EXPIRY_BATCH(500) */
  readonly limit: number;
}

/** 만료 저장소(운영은 adapters/db/drizzle-order-expiry.ts DrizzleOrderExpiry). 주문 상태는 주문 전이 함수로만 바꾼다 */
export interface OrderExpiryStore {
  /** 주문 하나와 그 항목의 좌석 ID(잠그지 않는다). 없거나 소문자 UUID가 아니면 undefined */
  order(orderId: string): Promise<OrderExpiryOrder | undefined>;
  /** 그 구매 세션의 열린 주문(CREATED·AUTHENTICATED, 인덱스 purchase_order_session_idx). 없으면 [] */
  openOrdersOfSession(purchaseSessionId: string): Promise<OrderExpiryOrder[]>;
  /**
   * 그 홀드들로 만든 열린 주문(CREATED·AUTHENTICATED) 한 문장(hold_id = any, hold_id 유일 인덱스. docs/data.md §5.1 '만료 고리의 열린 주문 찾기').
   * 소문자 UUID가 아닌 holdId는 빼고 묻고, 남은 것이 없으면 DB에 가지 않고 []다
   */
  openOrdersOfHolds(holdIds: readonly string[]): Promise<OrderExpiryOrder[]>;
  /**
   * 트랜잭션 하나(read committed, 잠금 차례 주문 행 → 결제 시도 행): 주문 행을 FOR UPDATE로 잠그고, 활성 결제 시도(READY이고 만든 지 40분 [가정] 안)를 보고,
   * expiryDecision이 EXPIRE면 전이 함수로 T5·T6(이력·Outbox EXPIRED)을 쓴다. 전이가 STALE이면 NOT_OPEN(current)이다.
   * @throws RangeError 행위자 모양 틀림(전이 함수 그대로)
   */
  expireIfDue(input: OrderExpiryInput): Promise<OrderExpiryOutcome>;
  /**
   * READY 결제 시도 만료 묶음: 범위 안의 READY 행을 limit개까지 EXPIRED로 바꾼다(조건부 UPDATE 한 문장, FOR UPDATE SKIP LOCKED로 고른다. 결제 시도 행만 잠그고 주문 행은 건드리지 않는다).
   * 바뀐 시도들을 돌려준다. 주문의 만료는 부르는 쪽이 그 주문마다 check로 다시 본다
   * @throws RangeError 범위·limit이 틀림
   */
  expireReadyAttempts(range: OrderExpiryRange): Promise<OrderExpiredAttempt[]>;
  /**
   * 안전망 묶음 읽기(docs/data.md §5.1): 기본 키 범위 안의 CREATED·AUTHENTICATED 주문을 ID 차례로 limit개까지 읽는다. afterId를 주면 그 ID 뒤부터다
   * (NOT_YET으로 남는 주문이 있어 커서로 넘어간다). 잠그지 않는다.
   * @throws RangeError 범위·limit·afterId가 틀림
   */
  openOrderBatch(range: OrderExpiryRange & { readonly afterId?: string }): Promise<OrderExpiryOrder[]>;
  /**
   * 하루 넘은 주문 정비 일의 묶음 읽기(docs/features/payment.md §2 안전망 ③): openOrderBatch와 같은 문장이고 limit만 1 ~ ORDER_EXPIRY_STALE_BATCH(1,000)다.
   * @throws RangeError 범위·limit·afterId가 틀림
   */
  staleOrderBatch(range: OrderExpiryRange & { readonly afterId?: string }): Promise<OrderExpiryOrder[]>;
}

/** inventory로 가는 만료 다리(운영은 adapters/inventory-bridges.ts InventoryOrderExpiry). 좌석 Redis를 읽으므로 트랜잭션 밖에서만 부른다 */
export interface OrderExpiryInventory {
  /**
   * 구매 세션이 끝났나(세션 상태가 없거나 최대 체류 시각이 지났으면 true).
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(끝났다고 보지 않는다)
   */
  sessionEnded(purchaseSessionId: string): Promise<boolean>;
  /**
   * 그 주문의 홀드가 아직 남았나(q.seatIds의 좌석 가운데 한 좌석이라도 홀드 Hash의 holdId가 q.holdId면 true). 구매 세션의 홀드 목록은 보지 않는다(세션을 끝내면 목록이 지워져도 홀드는 살아 있다).
   * 좌석맵 판에 없는 좌석이 있거나 좌석을 모르면 true(아직, 안전망이 다시 본다).
   * @throws OrderSeatStoreUnavailable 좌석 Redis 일시 장애(풀렸다고 보지 않는다)
   */
  holdRemains(q: OrderHoldQuery): Promise<boolean>;
}

/** 구매 세션 종료 고리의 값(inventory EndPurchaseSessionDeps.onEnded와 같은 모양) */
export interface OrderExpirySessionEnded {
  readonly purchaseSessionId: string;
}

/** 홀드 만료 고리의 값(inventory ExpirySweeperDeps.onHoldsExpired와 같은 모양) */
export interface OrderExpiryHoldsExpired {
  readonly eventId: string;
  /** 같은 holdId는 한 번 */
  readonly holdIds: readonly string[];
}

/** 주문 만료 지표(운영은 adapters/prom-order-expiry-signals.ts PromOrderExpirySignals, 이름은 설계 5). 던지지 않는다 */
export interface OrderExpirySignals {
  /** 카운터 purchase_order_expired_total{trigger}를 1 올린다 */
  expired(trigger: OrderExpiryTrigger): void;
  /** 카운터 purchase_order_expiry_failures_total{stage}를 1 올린다 */
  failure(stage: OrderExpiryStage): void;
  /** 게이지 purchase_order_open_stale을 count로 둔다(만든 지 1~30일 [가정]인데 아직 열린 주문 수. 1 이상이면 SEV3. 파드 사이 최댓값으로 본다) */
  openStale(count: number): void;
}

/** 주문 만료 경고 로그(주문 ID·오류 이름만 싣는다. 오류 글·개인정보는 싣지 않는다) */
export interface OrderExpiryLogger {
  warn(obj: object, msg: string): void;
}
