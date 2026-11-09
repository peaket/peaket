// 토스 모양 결제사의 공통 어댑터(docs/features/payment.md §2.1, BUILD_ORDER PRF-184). 토스 어댑터와, 토스와 같은 모양의 시뮬레이터 어댑터가 함께 쓴다.
// - 플랫폼 외부 호출 클라이언트로 부른다: 추적 머리 없음, 리디렉트 안 따름, 남은 시간 안의 시간 초과(docs/observability.md §6).
// - 읽기 시간 초과는 60초 [가정](payment §2.1 '읽기 시간 초과 권장'). 끊김·시간 초과·5xx는 결과 모름(UNKNOWN)이다.
// - 결과 코드는 payment §2.1 '공통 결과 코드 정규화'와 '분석용 실패 범주'로 바꾼다. 대응표는 이 파일과 계약 시험이 정본이다.
// - 승인 답의 읽기(PRF-181 코드 리뷰): 거절로 읽는 것은 JSON code가 있는 4xx뿐이다. 200이 아닌 2xx·3xx·408·JSON code가 없는 4xx와 그 밖은
//   결제사가 무엇을 했는지 모르므로 UNKNOWN이다. 200 답은 주문 ID를 대조해 다르면 UNKNOWN이다. 다만 429는 code와 상관없이 한도 초과다(PRF-183 코드 리뷰, 조회와 같다. 처리되지 않은 요청이라 재전송으로 넘긴다).
//   일시 오류 코드와 대응표에 없는 코드도 UNKNOWN이다. 취소 답도 같은 규칙으로 읽는다(PRF-184 코드 리뷰).
// - 연결 묶음(PRF-183 코드 리뷰): 승인·취소는 fetch, 조회(GET)는 queryFetch로 나간다(승인 호출이 연결을 다 쥐어도 조회가 막히지 않게). queryFetch가 없으면 fetch 하나다.
// - 조회 답의 읽기(PRF-182 코드 리뷰): NOT_FOUND는 JSON code가 NOT_FOUND_PAYMENT인 404뿐이다. 그 밖의 404·JSON이 아닌 답은 UNKNOWN이다.
// - 시크릿 키는 #authorization(비공개 칸)에만 둔다. 객체를 로그로 찍거나 JSON으로 바꿔도 실리지 않는다([ASVS v5.0.0-16.2.5]).
// - 이 파일은 v0 이미지(build:lib)에도 들어간다. 서버 전용 부품(undici, pg-http.ts)을 가져오지 않는다.
import { createExternalHttpClient, systemClock, type Clock, type ExternalHttpClient } from '@peaket/platform';
import {
  CANCEL_IDEM_KEY,
  CONFIRM_CALL_BUDGET_MS,
  confirmIdemKey,
  type CancelResult,
  type CheckoutAttempt,
  type CheckoutOrder,
  type CheckoutValues,
  type ConfirmResult,
  type FailureCategory,
  type HeaderBag,
  type PaymentGatewayPort,
  type PayMethodCategory,
  type PgCapabilities,
  type PgName,
  type QueryOptions,
  type QueryResult,
  type QueryStatus,
  type WebhookTrigger,
} from '../../domain/payment-gateway.js';
import { num, pgRequest, str, type PgReply } from './pg-reply.js';

export interface TossShapedOptions {
  /** 결제사 주소 */
  baseUrl: string;
  /** 시크릿 키. Basic 인증 머리로만 나간다 */
  secretKey: string;
  /** 읽기 시간 초과 상한(ms). 기본 60초 [가정] */
  readTimeoutMs?: number;
  /** 승인 호출 + 뒤따르는 조회의 시간 합 상한(ms). 기본 CONFIRM_CALL_BUDGET_MS 70초 [가정] */
  confirmBudgetMs?: number;
  clock?: Clock;
  fetch?: typeof fetch;
  /** 조회(GET) 전용 연결 묶음의 fetch. 없으면 fetch를 쓴다 */
  queryFetch?: typeof fetch;
}

const TRANSMISSION_ID = 'tosspayments-webhook-transmission-id';
/** 결제사가 준 값을 키로 찾으므로 Map이다(객체면 constructor 같은 내장 이름이 상태로 읽힌다, PRF-184 코드 리뷰) */
const STATUS: ReadonlyMap<string, QueryStatus> = new Map<string, QueryStatus>([
  ['READY', 'READY'],
  ['IN_PROGRESS', 'IN_PROGRESS'],
  ['WAITING_FOR_DEPOSIT', 'WAITING_FOR_DEPOSIT'],
  ['DONE', 'APPROVED'],
  ['PARTIAL_CANCELED', 'PARTIAL_CANCELED'],
  ['CANCELED', 'CANCELED'],
  ['ABORTED', 'FAILED'],
  ['EXPIRED', 'EXPIRED'],
]);
/** 응답 method(토스와 시뮬레이터가 같은 글) → 결제 수단 분류. 표에 없는 값은 비운다 */
const METHOD_CATEGORY: ReadonlyMap<string, PayMethodCategory> = new Map<string, PayMethodCategory>([
  ['카드', 'CARD'],
  ['간편결제', 'EASY_PAY'],
  ['계좌이체', 'TRANSFER'],
  ['가상계좌', 'OTHER'],
  ['휴대폰', 'OTHER'],
  ['문화상품권', 'OTHER'],
  ['도서문화상품권', 'OTHER'],
  ['게임문화상품권', 'OTHER'],
]);
const DEFAULT_READ_TIMEOUT_MS = 60_000;
/** 조회의 404가 '결제 없음'이라고 결제사가 답한 것임을 뜻하는 코드 */
const NOT_FOUND_PAYMENT = 'NOT_FOUND_PAYMENT';
const USER_ABORTED = new Set(['PAY_PROCESS_CANCELED', 'PAY_PROCESS_ABORTED']);
const VALIDATION = new Set(['INVALID_REQUEST', 'NOT_FOUND_PAYMENT', 'DUPLICATED_ORDER_ID', 'IDEMPOTENCY_KEY_REUSED']);
/** 토스 오류 코드 문서가 일시 오류·재시도로 적은 코드(2026-11-09 확인). 처리됐는지 알 수 없어 승인·취소 모두 단독 조회가 정한다(PRF-184 코드 리뷰) */
const TRANSIENT_CODES = new Set([
  'PROVIDER_ERROR',
  'CARD_PROCESSING_ERROR',
  'FAILED_INTERNAL_SYSTEM_PROCESSING',
  'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING',
  'FAILED_CARD_COMPANY_RESPONSE',
  'UNKNOWN_PAYMENT_ERROR',
  'COMMON_ERROR',
  'FORBIDDEN_CONSECUTIVE_REQUEST',
  'FAILED_METHOD_HANDLING_CANCEL',
  'FAILED_REFUND_PROCESS',
]);
/** 웹훅의 결제 키·주문 ID 모양: 공백·제어 문자가 없는 ASCII 1~200자 */
const WEBHOOK_REF = /^[\x21-\x7e]{1,200}$/;

export abstract class TossShapedGateway implements PaymentGatewayPort {
  abstract readonly pg: PgName;
  readonly #http: ExternalHttpClient;
  readonly #queryHttp: ExternalHttpClient;
  readonly #authorization: string;
  readonly #clock: Clock;
  readonly #readTimeoutMs: number;
  readonly #confirmBudgetMs: number;

  /** @param provider 외부 호출 클라이언트의 제공자 이름(span·정규 로그 줄) */
  protected constructor(provider: string, o: TossShapedOptions) {
    this.#clock = o.clock ?? systemClock;
    this.#readTimeoutMs = o.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.#confirmBudgetMs = o.confirmBudgetMs ?? CONFIRM_CALL_BUDGET_MS;
    const client = (f: typeof fetch | undefined) => createExternalHttpClient({ provider, baseUrl: o.baseUrl, timeoutCapMs: this.#readTimeoutMs, clock: o.clock, fetch: f });
    this.#http = client(o.fetch);
    this.#queryHttp = o.queryFetch === undefined ? this.#http : client(o.queryFetch);
    this.#authorization = `Basic ${Buffer.from(`${o.secretKey}:`).toString('base64')}`;
  }

  abstract capabilities(): PgCapabilities;
  abstract checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues;

  /**
   * 결제사가 코드로 거절한 승인의 실패 범주. 결제사마다 다른 코드는 어댑터가 덧붙인다(payment §2.1 '분석용 실패 범주').
   * undefined는 대응표에 없는 코드다. 돈이 잡혔을 수 있어 실패로 쓰지 않고 UNKNOWN으로 둔다(단독 조회가 정한다, PRF-184 코드 리뷰)
   */
  protected failureCategoryOf(status: number, code: string): FailureCategory | undefined {
    if (status === 401 || status === 403) return 'PG_ERROR';
    if (code === 'NOT_FOUND_PAYMENT_SESSION') return 'EXPIRED';
    if (USER_ABORTED.has(code)) return 'USER_ABORTED';
    if (VALIDATION.has(code)) return 'VALIDATION';
    return undefined;
  }

  async confirm(c: { orderId: string; paymentRef: string; amount: number; idemKey: string }): Promise<ConfirmResult> {
    if (c.idemKey !== confirmIdemKey(c.orderId)) throw new TypeError(`승인 멱등키는 confirm-{주문 ID}여야 한다: ${c.idemKey}`);
    const startedMs = this.#clock.monotonicMs();
    const r = await this.#call('POST', '/v1/payments/confirm', {}, { paymentKey: c.paymentRef, orderId: c.orderId, amount: c.amount }, c.idemKey);
    const unknown: ConfirmResult = { outcome: 'UNKNOWN', paymentRef: c.paymentRef };
    if (r === 'NO_ANSWER' || r.status >= 500) return unknown;
    if (r.status === 200) {
      // 다른 주문의 답을 이 주문의 결과로 쓰지 않는다
      if (str(r.json?.orderId) !== c.orderId) return unknown;
      const status = str(r.json?.status);
      if (status === 'WAITING_FOR_DEPOSIT') return { outcome: 'WAITING_FOR_DEPOSIT', paymentRef: c.paymentRef, amount: num(r.json?.totalAmount) };
      if (status !== 'DONE') return unknown;
      return { outcome: 'APPROVED', ...this.#approvedFields(c.paymentRef, r.json!) };
    }
    const code = str(r.json?.code);
    // 429는 어디서 왔든 결제사까지 처리되지 않은 요청이다. 재전송 다음 시도만 늦춘다(조회의 429와 같다)
    if (r.status === 429) return { outcome: 'DECLINED', paymentRef: c.paymentRef, failureCategory: 'THROTTLED', ...(code ? { pgCode: code } : {}) };
    // 결제사가 코드로 답한 4xx만 거절로 읽는다. 나머지(200이 아닌 2xx·3xx·408·JSON code가 없는 4xx)는 중간 장비의 답일 수 있어 결과를 가정하지 않는다
    if (r.status < 400 || r.status === 408 || !code) return unknown;
    if (r.status === 409 || code === 'ALREADY_PROCESSING_REQUEST') return { outcome: 'IN_PROGRESS', paymentRef: c.paymentRef, pgCode: code };
    if (code === 'ALREADY_PROCESSED_PAYMENT') {
      // 승인 + 조회의 합이 임대를 넘지 않게 남은 몫만 기다리고, 몫을 다 썼으면 부르지 않는다
      const leftMs = this.#confirmBudgetMs - (this.#clock.monotonicMs() - startedMs);
      if (leftMs < 1) return unknown;
      const q = await this.#call('GET', '/v1/payments/{paymentKey}', { paymentKey: c.paymentRef }, undefined, undefined, Math.min(leftMs, this.#readTimeoutMs));
      if (q === 'NO_ANSWER' || q.status !== 200) return unknown;
      // 결제사가 이 주문을 승인한 것을 확인했을 때만 ALREADY_APPROVED다. 금액은 조회 값을 그대로 실어, 다르면 실행기가 UNKNOWN + SEV1을 쓴다(승인된 결제를 FAILED로 쓰지 않는다, payment §2.1 ALREADY_APPROVED)
      const s = str(q.json?.status);
      if ((s !== 'DONE' && s !== 'PARTIAL_CANCELED') || str(q.json?.orderId) !== c.orderId) return unknown;
      return { outcome: 'ALREADY_APPROVED', ...this.#approvedFields(c.paymentRef, q.json!) };
    }
    if (TRANSIENT_CODES.has(code)) return unknown;
    const failureCategory = this.failureCategoryOf(r.status, code);
    if (failureCategory === undefined) return unknown;
    return { outcome: 'DECLINED', paymentRef: c.paymentRef, failureCategory, pgCode: code };
  }

  async query(paymentRef: string, options?: QueryOptions): Promise<QueryResult> {
    const timeoutCapMs = options?.timeoutMs === undefined ? undefined : Math.min(options.timeoutMs, this.#readTimeoutMs);
    const r = await this.#call('GET', '/v1/payments/{paymentKey}', { paymentKey: paymentRef }, undefined, undefined, timeoutCapMs);
    if (r === 'NO_ANSWER') return { kind: 'UNKNOWN' };
    // 조회의 429는 다음 시도만 늦춘다. 표시만 실어 지표에 세게 한다(BUILD_ORDER PRF-183)
    if (r.status === 429) return { kind: 'UNKNOWN', throttled: true };
    // 결제사의 정해진 코드일 때만 없음이다. 그 밖의 404는 중간 장비의 답일 수 있다(PRF-182 코드 리뷰)
    if (r.status === 404) return str(r.json?.code) === NOT_FOUND_PAYMENT ? { kind: 'NOT_FOUND' } : { kind: 'UNKNOWN' };
    const status = STATUS.get(str(r.json?.status) ?? '');
    const amount = num(r.json?.totalAmount);
    const balanceAmount = num(r.json?.balanceAmount);
    const orderRef = str(r.json?.orderId);
    if (r.status !== 200 || !status || amount === undefined || balanceAmount === undefined || !orderRef) return { kind: 'UNKNOWN' };
    const approvedAt = str(r.json?.approvedAt);
    const method = METHOD_CATEGORY.get(str(r.json?.method) ?? '');
    return { kind: 'FOUND', paymentRef, orderRef, status, amount, balanceAmount, ...(approvedAt ? { approvedAt } : {}), ...(method ? { method } : {}) };
  }

  async cancel(c: { paymentRef: string; amount: number | 'ALL'; reason: string; idemKey: string }): Promise<CancelResult> {
    if (!CANCEL_IDEM_KEY.test(c.idemKey)) throw new TypeError(`취소 멱등키는 cancel-{취소 ID}여야 한다: ${c.idemKey}`);
    const body = { cancelReason: c.reason, ...(c.amount === 'ALL' ? {} : { cancelAmount: c.amount }) };
    const r = await this.#call('POST', '/v1/payments/{paymentKey}/cancel', { paymentKey: c.paymentRef }, body, c.idemKey);
    if (r === 'NO_ANSWER' || r.status >= 500 || r.status === 429) return { outcome: 'UNKNOWN' };
    if (r.status === 200) {
      const s = str(r.json?.status);
      if (s !== 'CANCELED' && s !== 'PARTIAL_CANCELED') return { outcome: 'UNKNOWN' };
      return { outcome: 'CANCELLED', balanceAmount: num(r.json?.balanceAmount) };
    }
    const code = str(r.json?.code);
    // 승인과 같은 규칙이다(PRF-184 코드 리뷰): 결제사가 코드로 답한 4xx만 거절로 읽고, 일시 오류 코드는 취소가 됐는지 모른다
    if (r.status < 400 || r.status === 408 || !code || TRANSIENT_CODES.has(code)) return { outcome: 'UNKNOWN' };
    if (r.status === 409) return { outcome: 'CANCEL_PENDING', pgCode: code };
    // 이미 전액 취소된 결제를 전액 취소하면 바라는 상태와 같다
    if (code === 'ALREADY_CANCELED_PAYMENT' && c.amount === 'ALL') return { outcome: 'CANCELLED', balanceAmount: 0, pgCode: code };
    return { outcome: 'REJECTED', pgCode: code };
  }

  parseWebhook(headers: HeaderBag, body: string): WebhookTrigger | null {
    let id: string | undefined;
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === TRANSMISSION_ID) id = typeof v === 'string' ? v : undefined;
    if (!id || id.length > 200) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return null;
    }
    const m = msg as { eventType?: unknown; data?: { paymentKey?: unknown; orderId?: unknown } };
    if (m?.eventType !== 'PAYMENT_STATUS_CHANGED') return null;
    const paymentRef = str(m.data?.paymentKey);
    if (paymentRef === undefined || !WEBHOOK_REF.test(paymentRef)) return null;
    const rawOrderRef = m.data?.orderId;
    if (rawOrderRef === undefined) return { dedupKey: `${this.pg}:${id}`, paymentRef };
    const orderRef = str(rawOrderRef);
    if (orderRef === undefined || !WEBHOOK_REF.test(orderRef)) return null;
    return { dedupKey: `${this.pg}:${id}`, paymentRef, orderRef };
  }

  #approvedFields(paymentRef: string, json: Record<string, unknown>): Omit<ConfirmResult, 'outcome'> {
    const card = json.card as Record<string, unknown> | null | undefined;
    const maskedNumber = str(card?.number);
    const method = METHOD_CATEGORY.get(str(json.method) ?? '');
    return {
      paymentRef,
      amount: num(json.totalAmount),
      approvedAt: str(json.approvedAt),
      ...(card && maskedNumber ? { card: { maskedNumber, issuerCode: str(card.issuerCode) ?? '', cardType: str(card.cardType) ?? '' } } : {}),
      ...(method ? { method } : {}),
    };
  }

  #call(method: 'GET' | 'POST', path: string, params: Record<string, string>, body?: unknown, idemKey?: string, timeoutCapMs?: number): Promise<PgReply> {
    return pgRequest(method === 'GET' ? this.#queryHttp : this.#http, {
      method,
      path,
      params,
      headers: {
        authorization: this.#authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idemKey ? { 'idempotency-key': idemKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeoutCapMs === undefined ? {} : { timeoutCapMs }),
    });
  }
}
