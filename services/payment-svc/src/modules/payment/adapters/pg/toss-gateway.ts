// 토스페이먼츠 어댑터(ADR-0029 결정 1, docs/features/payment.md §2.1 '토스 어댑터의 첫 구현', BUILD_ORDER PRF-184).
// 호출과 답 읽기는 시뮬레이터 어댑터와 함께 쓰는 공통 코드(toss-shaped.ts)다. 이 파일에는 토스만의 능력 플래그, 결제창 값, 대응표 추가분이 있다.
// 서버 쪽 공개 파일(server.ts)로만 내보낸다(v0 이미지에는 시뮬레이터만 들어간다).
// 구현에서 정한 것(정본·설계에 없다):
// - 구매자 키가 넘어오지 않으면 호출마다 CSPRNG 128비트 값을 만든다(§2.2 '구매자 키'. 고정 값을 쓰면 비회원이 모두 한 구매자가 된다).
// - 결제 수단 고르기는 토스 결제창이 하므로 payMethod로 막지 않는다(openapi payMethod는 포트원 채널 선택에 쓴다).
import { randomBytes } from 'node:crypto';
import type { CheckoutAttempt, CheckoutOrder, CheckoutValues, FailureCategory, PgCapabilities } from '../../domain/payment-gateway.js';
import { TossShapedGateway, type TossShapedOptions } from './toss-shaped.js';

export interface TossGatewayOptions extends TossShapedOptions {
  /** live_sk_·live_gsk_·test_sk_·test_gsk_ 또는 시뮬레이터를 가리킬 때의 sim_sk_. 접두사는 설정 층이 환경과 맞춰 본다(config.ts) */
  secretKey: string;
  /** 결제창용 공개 키 */
  clientKey: string;
  /** 호출 상한(초당). 기본 300 [가정](ADR-0036). 시험 키의 기본 1 [가정]은 설정 층이 넘긴다 */
  callsPerSecond?: number;
}

/** 토스 승인 API의 구매자 쪽 거절(카드·계좌의 한도·정지·틀린 값, 공식 오류 코드 문서, 2026-11-09 확인). 이 목록만 CARD_DECLINED다 */
const BUYER_REJECTED = new Set([
  'REJECT_CARD_PAYMENT',
  'REJECT_ACCOUNT_PAYMENT',
  'REJECT_CARD_COMPANY',
  'REJECT_TOSSPAY_INVALID_ACCOUNT',
  'EXCEED_MAX_AUTH_COUNT',
  'EXCEED_MAX_ONE_DAY_AMOUNT',
  'NOT_AVAILABLE_BANK',
  'INVALID_PASSWORD',
  'FDS_ERROR',
  'INVALID_REJECT_CARD',
  'INVALID_STOPPED_CARD',
  'INVALID_CARD_EXPIRATION',
  'INVALID_CARD_LOST_OR_STOLEN',
  'INVALID_CARD_NUMBER',
  'INVALID_CARD_INSTALLMENT_PLAN',
  'EXCEED_MAX_AMOUNT',
  'EXCEED_MAX_CARD_INSTALLMENT_PLAN',
  'EXCEED_MAX_DAILY_PAYMENT_COUNT',
  'EXCEED_MAX_PAYMENT_AMOUNT',
  'EXCEED_MAX_MONTHLY_PAYMENT_AMOUNT',
  'EXCEED_MAX_ONE_DAY_WITHDRAW_AMOUNT',
  'EXCEED_MAX_ONE_TIME_WITHDRAW_AMOUNT',
  'NOT_ALLOWED_POINT_USE',
  'NOT_SUPPORTED_MONTHLY_INSTALLMENT_PLAN',
  'RESTRICTED_TRANSFER_ACCOUNT',
  'INVALID_ACCOUNT_INFO_RE_REGISTER',
]);
/** 우리 쪽 가맹점·키 설정이 틀렸다는 코드. 구매자가 다시 해도 안 되고 처리되지 않은 것이 확실하다 */
const MERCHANT_CONFIG_ERROR = new Set(['INVALID_API_KEY', 'NOT_FOUND_TERMINAL_ID', 'NOT_REGISTERED_BUSINESS', 'INVALID_UNREGISTERED_SUBMALL']);
const CUSTOMER_KEY_BYTES = 16;
/** 토스 구매자 키 형식(영문·숫자와 - _ = . @, 2~50자) */
const CUSTOMER_KEY = /^[A-Za-z0-9\-_=.@]{2,50}$/;
/** 토스가 비회원 결제에 쓰는 고정 값. 비회원을 한 값으로 묶지 않으므로 받지 않는다(§2.2) */
const ANONYMOUS_CUSTOMER_KEY = 'ANONYMOUS';

export class TossPaymentGateway extends TossShapedGateway {
  readonly pg = 'TOSS' as const;
  readonly #clientKey: string;
  readonly #callsPerSecond: number;

  constructor(o: TossGatewayOptions) {
    super('tosspayments', o);
    this.#clientKey = o.clientKey;
    this.#callsPerSecond = o.callsPerSecond ?? 300;
  }

  capabilities(): PgCapabilities {
    return {
      serverConfirm: true,
      confirmDeadlineMs: 10 * 60_000,
      partialCancel: true,
      webhookSignature: false,
      idempotencyRetentionMs: 15 * 24 * 3_600_000,
      callsPerSecond: this.#callsPerSecond,
      redirectCheckout: true,
    };
  }

  checkout(order: CheckoutOrder, attempt: CheckoutAttempt): CheckoutValues {
    if (!(Number.isSafeInteger(order.amount) && order.amount > 0)) throw new RangeError(`결제 금액은 양의 정수(원)여야 한다: ${order.amount}`);
    if (order.customerKey !== undefined && (!CUSTOMER_KEY.test(order.customerKey) || order.customerKey === ANONYMOUS_CUSTOMER_KEY)) throw new RangeError('구매자 키 형식이 틀렸다(영문·숫자와 - _ = . @, 2~50자, 비회원 고정 값 불가)');
    return {
      toss: {
        clientKey: this.#clientKey,
        customerKey: order.customerKey ?? randomBytes(CUSTOMER_KEY_BYTES).toString('base64url'),
        orderId: order.orderId,
        orderName: order.orderName,
        amount: order.amount,
        successUrl: attempt.successUrl,
        failUrl: attempt.failUrl,
      },
    };
  }

  protected override failureCategoryOf(status: number, code: string): FailureCategory | undefined {
    if (BUYER_REJECTED.has(code)) return 'CARD_DECLINED';
    if (MERCHANT_CONFIG_ERROR.has(code)) return 'PG_ERROR';
    return super.failureCategoryOf(status, code);
  }
}
