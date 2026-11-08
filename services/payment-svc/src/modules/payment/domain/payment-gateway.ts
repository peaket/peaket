// 결제 포트(docs/features/payment.md §2.1 'PG 어댑터 계약', ADR-0029). 주문 Saga와 payment-svc는 이 포트에만 기대고 결제사의 세부를 모른다.
// 어댑터는 토스페이먼츠(기본)·포트원 V2·시뮬레이터 셋이다. 결과는 결제사와 상관없이 같은 표준 결과로 돌려준다.

export type PgName = 'TOSS' | 'PORTONE' | 'SIMULATOR';

/** 능력 플래그(ADR-0029 결정 2, ADR-0036·0044). 서버 승인을 지원하지 않는 결제 수단·채널은 입장권 결제에 내놓지 않는다(POL-013) */
export interface PgCapabilities {
  serverConfirm: boolean;
  /** 결제창 인증 뒤 승인 기한 */
  confirmDeadlineMs: number;
  partialCancel: boolean;
  webhookSignature: boolean;
  /** 결제사의 멱등키 보관 시간. 코드에 고정하지 않고 여기서 받는다(기술 검토 낮음-070) */
  idempotencyRetentionMs: number;
  /** 채널별 호출 상한(초당). 어댑터 계층의 토큰 버킷이 쓴다 */
  callsPerSecond: number;
  redirectCheckout: boolean;
}

export interface CheckoutOrder {
  orderId: string;
  orderName: string;
  /** 서버가 계산한 금액(원) */
  amount: number;
  /** 결제사 구매자 키(없으면 비회원 표시) */
  customerKey?: string;
}

export interface CheckoutAttempt {
  attemptId: string;
  successUrl: string;
  failUrl: string;
}

/** 계약 원본 TossCheckout과 같은 칸(docs/api/proto/peaket/payment/v1/payment.proto) */
export interface TossCheckoutValues {
  clientKey: string;
  customerKey: string;
  orderId: string;
  orderName: string;
  amount: number;
  successUrl: string;
  failUrl: string;
}

export interface PortoneCheckoutValues {
  storeId: string;
  channelKey: string;
  /** pay-{orderId} */
  paymentId: string;
  orderName: string;
  totalAmount: number;
  redirectUrl: string;
}

/** 결제창 값. 시뮬레이터는 토스와 같은 모양이다(proto README 2026-10-28) */
export type CheckoutValues = { toss: TossCheckoutValues } | { portone: PortoneCheckoutValues } | { simulator: TossCheckoutValues };

/** 승인 표준 결과(payment §2.1 '공통 결과 코드 정규화') */
export type ConfirmOutcome = 'APPROVED' | 'ALREADY_APPROVED' | 'IN_PROGRESS' | 'DECLINED' | 'WAITING_FOR_DEPOSIT' | 'UNKNOWN';

/** 분석용 실패 범주(ADR-0052). UNKNOWN을 조회로 실패라 확정한 것과 결제사 오류는 PG_ERROR */
export type FailureCategory = 'CARD_DECLINED' | 'USER_ABORTED' | 'VALIDATION' | 'EXPIRED' | 'PG_ERROR' | 'THROTTLED';

/** 결제 수단 연결값 계산용 카드 정보(payment §2.1 '결제 수단 연결값'). 가린 번호는 계산에만 쓰고 저장하지 않는다 */
export interface ConfirmCard {
  maskedNumber: string;
  issuerCode: string;
  cardType: string;
}

/** 결제 수단 분류(asyncapi PaymentEvent.payMethodCategory와 같은 값) */
export type PayMethodCategory = 'CARD' | 'EASY_PAY' | 'TRANSFER' | 'OTHER';

export interface ConfirmResult {
  outcome: ConfirmOutcome;
  paymentRef: string;
  amount?: number;
  /** 결제사가 준 승인 시각(ISO 8601, 결제사 오프셋 그대로) */
  approvedAt?: string;
  failureCategory?: FailureCategory;
  /** 결제사 원래 코드(로그·대응표용) */
  pgCode?: string;
  card?: ConfirmCard;
  /** 결제 수단 분류. 어댑터가 결제사 값을 분류해 싣는다. 모르면 비운다(결제 사건의 payMethodCategory, BUILD_ORDER PRF-181) */
  method?: PayMethodCategory;
}

export type QueryStatus = 'READY' | 'IN_PROGRESS' | 'APPROVED' | 'PARTIAL_CANCELED' | 'CANCELED' | 'FAILED' | 'EXPIRED' | 'WAITING_FOR_DEPOSIT';

export type QueryResult =
  | { kind: 'FOUND'; paymentRef: string; orderRef: string; status: QueryStatus; amount: number; balanceAmount: number; approvedAt?: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNKNOWN' };

/** 취소 표준 결과(payment §2.1 결제 취소 API) */
export type CancelOutcome = 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN';

export interface CancelResult {
  outcome: CancelOutcome;
  balanceAmount?: number;
  pgCode?: string;
}

/** 웹훅은 확정 데이터가 아니라 조회를 부르는 신호다(ADR-0029 결정 5). 상태를 싣지 않는다 */
export interface WebhookTrigger {
  /** 결제사별 중복 제거 키 */
  dedupKey: string;
  paymentRef: string;
  orderRef?: string;
}

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PaymentGatewayPort {
  readonly pg: PgName;
  capabilities(): PgCapabilities;
  checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues;
  /** idemKey는 confirm-{orderId}(ADR-0029 결정 4) */
  confirm(c: { orderId: string; paymentRef: string; amount: number; idemKey: string }): Promise<ConfirmResult>;
  query(paymentRef: string): Promise<QueryResult>;
  /** idemKey는 cancel-{cancellationId}. amount 'ALL'은 전액 */
  cancel(c: { paymentRef: string; amount: number | 'ALL'; reason: string; idemKey: string }): Promise<CancelResult>;
  /** 틀린 웹훅은 null */
  parseWebhook(headers: HeaderBag, body: string): WebhookTrigger | null;
}

/**
 * 승인 한 번(승인 호출 + 뒤따르는 조회)에 어댑터가 쓰는 시간의 합 상한 70초 [가정](읽기 시간 초과 60초 [가정] + 조회 몫).
 * 실행기의 임대 75초 [가정]보다 짧아야 호출 중인 행을 다음 실행기가 잔해로 잡지 않는다(BUILD_ORDER PRF-181, 코드 리뷰)
 */
export const CONFIRM_CALL_BUDGET_MS = 70_000;

/** 멱등키 형식(ADR-0029 결정 4). 두 결제사 규격(토스 300자, 포트원 16~256자 ASCII)을 함께 맞춘다 */
export const CANCEL_IDEM_KEY = /^cancel-[A-Za-z0-9_-]{1,64}$/;
export const confirmIdemKey = (orderId: string) => `confirm-${orderId}`;
