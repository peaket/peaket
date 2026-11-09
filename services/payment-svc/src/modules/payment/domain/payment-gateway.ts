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
  /** 채널별 호출 상한(초당). 실행기 앞의 채널 토큰 버킷이 쓴다(domain/pg-call-guard.ts, BUILD_ORDER PRF-183) */
  callsPerSecond: number;
  redirectCheckout: boolean;
  /** 승인 한 건이 쓰는 호출 토큰 수. 없으면 1이다. 승인 답에 금액이 없어 승인 뒤 조회를 함께 부르는 포트원은 2다(BUILD_ORDER HOT-140, 코드 리뷰) */
  confirmCallCost?: number;
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
  /** 결제 통화(proto PortoneCheckout.currency) */
  currency: 'KRW';
  redirectUrl: string;
}

/** 결제창 값. 시뮬레이터는 토스와 같은 모양이다(proto README 2026-10-28) */
export type CheckoutValues = { toss: TossCheckoutValues } | { portone: PortoneCheckoutValues } | { simulator: TossCheckoutValues };

/** 승인 표준 결과(payment §2.1 '공통 결과 코드 정규화') */
export type ConfirmOutcome = 'APPROVED' | 'ALREADY_APPROVED' | 'IN_PROGRESS' | 'DECLINED' | 'WAITING_FOR_DEPOSIT' | 'UNKNOWN';

/** 분석용 실패 범주(ADR-0052). UNKNOWN을 조회로 실패라 확정한 것과 결제사 오류는 PG_ERROR */
export const FAILURE_CATEGORIES = ['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED'] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * 결제 수단 연결값 계산용 카드 정보(payment §2.1 '결제 수단 연결값'). 어댑터가 결제사 값을 공통 값으로 맞춰 싣는다.
 * 가린 번호는 계산에만 쓰고 저장하거나 로그에 쓰지 않는다. 발급사·종류를 모르면 빈 글자다(BUILD_ORDER HOT-145)
 */
export interface ConfirmCard {
  /** 결제사가 준 가린 번호. 없을 수 있다 */
  maskedNumber?: string;
  /** BIN(토스는 가린 번호의 앞 6자리, 포트원은 card.bin). 없을 수 있다 */
  bin?: string;
  issuerCode: string;
  cardType: string;
}

/** 결제 수단 분류(asyncapi PaymentEvent.payMethodCategory와 같은 값) */
export type PayMethodCategory = 'CARD' | 'EASY_PAY' | 'TRANSFER' | 'OTHER';

/**
 * 가상계좌 발급 정보(payment §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151). 어댑터가 결제사 공식 칸에서 채우고, 없거나 모양이 틀린 칸만 뺀다(코드 리뷰 M5).
 * 계좌번호와 secret은 저장 앞에서만 쓰고 로그·사건·지표에 싣지 않는다
 */
export interface ConfirmVirtualAccount {
  accountNumber?: string;
  /** 결제사가 준 은행 코드·이름 */
  bank?: string;
  /** 입금 기한(ISO 8601). 결제사가 주지 않았으면 없다 */
  dueAt?: string;
  /** 입금 통보 대조용 값(토스 secret). 포트원은 없다 */
  secret?: string;
}

export interface ConfirmResult {
  outcome: ConfirmOutcome;
  paymentRef: string;
  amount?: number;
  /** 가상계좌 발급 정보(WAITING_FOR_DEPOSIT일 때만, BUILD_ORDER HOT-151) */
  virtualAccount?: ConfirmVirtualAccount;
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
  | {
      kind: 'FOUND';
      paymentRef: string;
      orderRef: string;
      status: QueryStatus;
      amount: number;
      balanceAmount: number;
      approvedAt?: string;
      /** 결제 수단 분류. 어댑터가 결제사 값을 분류해 싣는다. 모르면 비운다(BUILD_ORDER PRF-182, 코드 리뷰) */
      method?: PayMethodCategory;
      /** 결제 수단 연결값 계산용 카드 정보(UNKNOWN을 조회로 승인 확정할 때 쓴다, BUILD_ORDER HOT-145) */
      card?: ConfirmCard;
      /** 가상계좌 발급 정보(UNKNOWN을 조회로 입금 대기로 확정할 때 쓴다, BUILD_ORDER HOT-151) */
      virtualAccount?: ConfirmVirtualAccount;
    }
  | { kind: 'NOT_FOUND' }
  /** throttled는 결제사가 429로 답했을 때만 참이다(pg_throttled_total에 세고 상한은 낮추지 않는다, BUILD_ORDER PRF-183) */
  | { kind: 'UNKNOWN'; throttled?: true };

/** 단독 조회 한 번의 선택(BUILD_ORDER PRF-182, 코드 리뷰) */
export interface QueryOptions {
  /** 이 조회의 시간 한도(ms). 어댑터의 읽기 시간 초과를 넘지 않는 범위에서 쓴다. 없으면 읽기 시간 초과다 */
  timeoutMs?: number;
  /** 원장의 결제 시도 ID(포트원 txId). 있으면 답의 결제 시도와 대조해 다르면 UNKNOWN이다. 토스·시뮬레이터는 넘기지 않는다(BUILD_ORDER HOT-140, 코드 리뷰) */
  expectedTxId?: string;
}

/** 취소 표준 결과(payment §2.1 결제 취소 API) */
export type CancelOutcome = 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN';

export interface CancelResult {
  outcome: CancelOutcome;
  balanceAmount?: number;
  pgCode?: string;
}

/** 웹훅은 확정 데이터가 아니라 조회를 부르는 신호다(ADR-0029 결정 5). 상태를 싣지 않는다 */
export interface WebhookTrigger {
  kind: 'TRIGGER';
  /** 결제사별 중복 제거 키 */
  dedupKey: string;
  /** 토스 입금 통보는 결제 키 없이 주문 ID만 온다(BUILD_ORDER HOT-150) */
  paymentRef?: string;
  orderRef?: string;
  /** 토스 입금 통보의 secret(원장의 해시와 대조한다, BUILD_ORDER HOT-151). 그 밖의 사건에는 없다. 로그에 싣지 않는다 */
  depositSecret?: string;
  /** 결제사가 입금 완료를 알렸다(토스 입금 통보 DONE, 포트원 Transaction.Paid, BUILD_ORDER HOT-151 코드 리뷰). 결과가 아니라 조회 간격을 정하는 신호다 */
  depositDone?: true;
}

/** 웹훅을 거절한 까닭. 닫힌 값만 쓴다(보안 로그·지표에 원문이 실리지 않게, BUILD_ORDER HOT-150) */
export type WebhookInvalidReason = 'NO_SECRET' | 'HEADER' | 'TIMESTAMP' | 'SIGNATURE' | 'BODY';

/**
 * 웹훅 해석 결과(P-T17, BUILD_ORDER HOT-150, HOT-140이 넘긴 것). 거절과 무시를 나눈다.
 * - INVALID: 서명·머리·본문 모양이 틀렸다
 * - IGNORED: 형식은 맞는데 받지 않는 사건이다
 * - TRIGGER: 단독 조회를 부르는 신호다
 */
export type WebhookParseResult = { kind: 'INVALID'; reason: WebhookInvalidReason } | { kind: 'IGNORED' } | WebhookTrigger;

export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PaymentGatewayPort {
  readonly pg: PgName;
  capabilities(): PgCapabilities;
  checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues;
  /**
   * idemKey는 confirm-{orderId}(ADR-0029 결정 4).
   * confirmToken은 포트원 paymentToken이다(원장의 pg_confirm_token에서 실행기가 넘긴다. 답 뒤 원장이 지운다, BUILD_ORDER HOT-140). 그 호출에만 쓰고 담아 두지 않는다.
   * txId는 포트원 결제 시도 ID다(원장의 pg_tx_id). 승인 본문의 검증값과 뒤따르는 조회의 대조값으로 쓴다(BUILD_ORDER HOT-140, 코드 리뷰)
   */
  confirm(c: { orderId: string; paymentRef: string; amount: number; idemKey: string; confirmToken?: string; txId?: string }): Promise<ConfirmResult>;
  /** NOT_FOUND는 결제사가 정해진 코드로 '없다'고 답했을 때만이다. 그 밖의 404·JSON이 아닌 답은 중간 장비의 답일 수 있어 UNKNOWN이다 */
  query(paymentRef: string, options?: QueryOptions): Promise<QueryResult>;
  /**
   * idemKey는 cancel-{cancellationId}. amount 'ALL'은 전액.
   * expectedBalance는 이 취소 앞의 취소 가능 금액(포트원 currentCancellableAmount). 호출자가 첫 전송 전에 저장한 값을 재시도에도 그대로 넘긴다. 같은 멱등키의 본문이 달라지면 안 되기 때문이다(BUILD_ORDER HOT-140, 코드 리뷰)
   */
  cancel(c: { paymentRef: string; amount: number | 'ALL'; reason: string; idemKey: string; expectedBalance?: number }): Promise<CancelResult>;
  /** 본문은 원문 바이트를 UTF-8로 읽은 글이다. 던지지 않는다 */
  parseWebhook(headers: HeaderBag, body: string): WebhookParseResult;
}

/**
 * 승인 한 번(승인 호출 + 뒤따르는 조회)에 어댑터가 쓰는 시간의 합 상한 70초 [가정](읽기 시간 초과 60초 [가정] + 조회 몫).
 * 실행기의 임대 75초 [가정]보다 짧아야 호출 중인 행을 다음 실행기가 잔해로 잡지 않는다(BUILD_ORDER PRF-181, 코드 리뷰)
 */
export const CONFIRM_CALL_BUDGET_MS = 70_000;

/** 멱등키 형식(ADR-0029 결정 4). 두 결제사 규격(토스 300자, 포트원 16~256자 ASCII)을 함께 맞춘다 */
export const CANCEL_IDEM_KEY = /^cancel-[A-Za-z0-9_-]{1,64}$/;
export const confirmIdemKey = (orderId: string) => `confirm-${orderId}`;
