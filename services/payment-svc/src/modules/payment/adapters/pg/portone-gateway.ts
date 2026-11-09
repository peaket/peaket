// 포트원 V2 어댑터(ADR-0029, docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현', BUILD_ORDER HOT-140). 서버 쪽 공개 파일(server.ts)로만 내보낸다.
// 답의 모양은 포트원 V2 공식 스키마(v2.openapi.json, 2026-11-09 확인)를 따랐다. 실제 서버와의 대조는 HOT-145다.
// 구현에서 정한 것(정본·설계에 없다):
// - 승인 200 답(ConfirmedPaymentSummary)에는 pgTxId·paidAt뿐이고 결제 ID·금액·결제 수단이 없다. 그래서 200 뒤 단독 조회로 결제 ID를 대조하고 금액·수단을 읽는다.
//   조회가 실패하면 승인을 가정하지 않고 UNKNOWN이다(단독 조회 실행기가 확정). 이 조회까지 승인 한 건을 토큰 2개로 센다(confirmCallCost, BUILD_ORDER HOT-140 코드 리뷰).
// - 취소 금액 검증값(currentCancellableAmount)은 호출자가 넘긴 expectedBalance가 있을 때만 보낸다(직전 조회로 읽으면 같은 멱등키의 재시도 본문이 달라진다). 공식 스키마의 취소 답에는 남은 금액 칸이 없어 balanceAmount를 채우지 않는다.
// - 결제 시도 ID(txId)는 승인 본문의 검증값으로 싣고, 조회의 transactionId가 대조값과 다르면 다른 시도의 상태라 UNKNOWN이다.
// - 웹훅 서명은 node:crypto로 Standard Webhooks 규격을 읽는다(공식 서버 SDK는 이번 단계에서 새 의존성으로 더하지 않았다. 바꿀지는 HOT-145에서 정한다).
// - 시크릿·웹훅 시크릿은 비공개 칸에만 둔다. 결제 토큰은 호출에만 쓰고 담아 두지 않는다([ASVS v5.0.0-16.2.5], [ASVS v5.0.0-14.2.7]).
import { createHmac, timingSafeEqual } from 'node:crypto';
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
  type ListTransactionsRequest,
  type ListTransactionsResult,
  type PaymentGatewayPort,
  type PgTransaction,
  type PgUnreadableRow,
  type PayMethodCategory,
  type PgCapabilities,
  type QueryOptions,
  type QueryResult,
  type QueryStatus,
  type WebhookParseResult,
} from '../../domain/payment-gateway.js';
import { portoneCardOfMethod } from './card-fields.js';
import type { PayMethod } from '../../domain/payment-gateway.js';
import { num, pgRequest, str, unreadableRowOf, type PgReply } from './pg-reply.js';
import { portoneVirtualAccountOf } from './virtual-account-fields.js';

export interface PortoneGatewayOptions {
  /** 결제사 주소 */
  baseUrl: string;
  /** API 시크릿. Authorization: PortOne 머리로만 나간다 */
  secret: string;
  storeId: string;
  /** 수동 승인 채널의 채널 키 */
  channelKey: string;
  /** 결제수단별 채널 키(PEAKET_PG_PORTONE_CHANNEL_KEYS). 없으면 channelKey 하나로 모든 수단을 받는다(BUILD_ORDER PRF-190) */
  channelKeys?: Readonly<Partial<Record<PayMethod, string>>>;
  /** 웹훅 시크릿(동시에 최대 2개, whsec_ 접두사 + base64). 비어 있으면 어떤 웹훅도 받지 않는다 */
  webhookSecrets: readonly string[];
  /** 승인 API의 isTest 검증값. 설정 층이 PEAKET_ENV로 정한다 */
  isTest: boolean;
  /** 읽기 시간 초과 상한(ms). 기본 60초 [가정] */
  readTimeoutMs?: number;
  /** 승인 호출 + 뒤따르는 조회의 시간 합 상한(ms). 기본 CONFIRM_CALL_BUDGET_MS 70초 [가정] */
  confirmBudgetMs?: number;
  /** 뒤따르는 조회 한 번의 시간 상한(ms). 기본 PORTONE_FOLLOW_UP_TIMEOUT_MS 10초 [가정] */
  followUpTimeoutMs?: number;
  /** 호출 상한(초당). 기본 50 [가정](ADR-0036) */
  callsPerSecond?: number;
  clock?: Clock;
  fetch?: typeof fetch;
  /** 조회(GET) 전용 연결 묶음의 fetch. 없으면 fetch를 쓴다 */
  queryFetch?: typeof fetch;
}

/** 승인 200·이미 결제됨 뒤따르는 조회의 시간 상한 10초 [가정](단독 조회 한도와 같다) */
export const PORTONE_FOLLOW_UP_TIMEOUT_MS = 10_000;
const PROVIDER = 'portone';
/** 승인 한 건의 토큰 수: 승인 호출 + 뒤따르는 조회 */
const CONFIRM_CALL_COST = 2;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const CONFIRM_DEADLINE_MS = 10 * 60_000;
const IDEMPOTENCY_RETENTION_MS = 3 * 3_600_000;
const DEFAULT_CALLS_PER_SECOND = 50;
const PAYMENT_ID_PREFIX = 'pay-';
const CURRENCY = 'KRW';
const NOT_FOUND_PAYMENT = 'PAYMENT_NOT_FOUND';
const OUTSTANDING = 'IDEMPOTENCY_OUTSTANDING_REQUEST';
const ALREADY_PAID = 'ALREADY_PAID';
const ALREADY_CANCELLED = 'PAYMENT_ALREADY_CANCELLED';
/** 멱등키: 보이는 ASCII(공백 포함) 16~256자(포트원 멱등키 규격) */
const IDEM_KEY = /^[\x20-\x7e]{16,256}$/;
/** 웹훅의 결제 ID 모양: 공백·제어 문자가 없는 ASCII 1~200자 */
const WEBHOOK_REF = /^[\x21-\x7e]{1,200}$/;
const MAX_WEBHOOK_ID = 200;
/** 시각 허용 폭 5분(payment §5) */
const WEBHOOK_TOLERANCE_SECONDS = 300;
const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** whsec_ + 표준 base64(덧붙이기 포함). 느슨하게 읽으면 Buffer.from이 틀린 글자를 조용히 버려 키가 짧아진다 */
const WEBHOOK_SECRET = /^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** 웹훅 시크릿의 최소 길이 24바이트 [가정](Standard Webhooks 시크릿 길이의 아래쪽) */
const MIN_WEBHOOK_KEY_BYTES = 24;

/** 결제사가 준 값을 키로 찾으므로 Map이다(객체면 constructor 같은 내장 이름이 상태로 읽힌다) */
const STATUS: ReadonlyMap<string, QueryStatus> = new Map<string, QueryStatus>([
  ['READY', 'READY'],
  ['PAY_PENDING', 'IN_PROGRESS'],
  ['VIRTUAL_ACCOUNT_ISSUED', 'WAITING_FOR_DEPOSIT'],
  ['PAID', 'APPROVED'],
  ['PARTIAL_CANCELLED', 'PARTIAL_CANCELED'],
  ['CANCELLED', 'CANCELED'],
  ['FAILED', 'FAILED'],
]);
const METHOD_CATEGORY: ReadonlyMap<string, PayMethodCategory> = new Map<string, PayMethodCategory>([
  ['PaymentMethodCard', 'CARD'],
  ['PaymentMethodEasyPay', 'EASY_PAY'],
  ['PaymentMethodTransfer', 'TRANSFER'],
  ['PaymentMethodVirtualAccount', 'OTHER'],
  ['PaymentMethodMobile', 'OTHER'],
  ['PaymentMethodGiftCertificate', 'OTHER'],
  ['PaymentMethodConvenienceStore', 'OTHER'],
  ['PaymentMethodCrypto', 'OTHER'],
]);
/** 승인 거절로 읽는 type의 표(payment §2.1 '포트원 어댑터의 첫 구현'). 표에 없는 type은 UNKNOWN이다 */
const CONFIRM_DECLINE: ReadonlyMap<string, FailureCategory> = new Map<string, FailureCategory>([
  ['INVALID_PAYMENT_TOKEN', 'VALIDATION'],
  ['INVALID_REQUEST', 'VALIDATION'],
  ['INFORMATION_MISMATCH', 'VALIDATION'],
  ['UNAUTHORIZED', 'PG_ERROR'],
  ['FORBIDDEN', 'PG_ERROR'],
]);
/** 공식 스키마의 취소 오류 가운데 거절로 읽는 type(PG_PROVIDER·PAYMENT_NOT_FOUND·CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN은 UNKNOWN이다. 잔액 어긋남은 앞선 취소가 반영됐다는 뜻일 수 있다) */
const CANCEL_REJECTED = new Set([
  'CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT',
  'CANCEL_TAX_AMOUNT_EXCEEDS_CANCELLABLE_TAX_AMOUNT',
  'CANCEL_TAX_FREE_AMOUNT_EXCEEDS_CANCELLABLE_TAX_FREE_AMOUNT',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'MAX_CANCEL_COUNT_REACHED',
  'NEGATIVE_PROMOTION_ADJUSTED_CANCEL_AMOUNT',
  ALREADY_CANCELLED,
  'PAYMENT_NOT_PAID',
  'PROMOTION_DISCOUNT_RETAIN_OPTION_SHOULD_NOT_BE_CHANGED',
  'SUM_OF_PARTS_EXCEEDS_CANCEL_AMOUNT',
  'UNAUTHORIZED',
]);
/** 조회를 부를 결제 사건. 그 밖의 사건은 무시한다(payment §5) */
const PAYMENT_EVENTS = new Set(['Transaction.Paid', 'Transaction.VirtualAccountIssued', 'Transaction.PartialCancelled', 'Transaction.Cancelled', 'Transaction.Failed', 'Transaction.PayPending', 'Transaction.CancelPending']);

type Found = Extract<QueryResult, { kind: 'FOUND' }>;

const unknownQuery: QueryResult = { kind: 'UNKNOWN' };
const unknownPage: ListTransactionsResult = { kind: 'UNKNOWN' };

/** 멱등키를 머리 값으로 바꾼다(구조화 필드 sf-string). 규격에 맞지 않으면 던져 보내지 않는다. 글에 값을 싣지 않는다 */
function idempotencyHeader(key: string): string {
  if (!IDEM_KEY.test(key)) throw new TypeError('포트원 멱등키는 16~256자의 ASCII여야 한다');
  return `"${key.replace(/[\\"]/g, '\\$&')}"`;
}

/** 결제 ID에서 주문 참조를 읽는다(pay- 앞머리를 뗀 값, 앞머리가 없으면 그대로) */
const orderRefOfId = (paymentRef: string): string => (paymentRef.startsWith(PAYMENT_ID_PREFIX) ? paymentRef.slice(PAYMENT_ID_PREFIX.length) : paymentRef);

/**
 * 답의 customData(공식 스키마 PaidPayment의 '사용자 지정 데이터', v2.openapi.json 2026-11-09 확인)에 든 주문 ID. JSON이 아니거나 orderId 글이 없으면 undefined다.
 * 공식 스키마에 주문을 가리키는 칸은 결제 ID 말고 이것뿐이다(BUILD_ORDER HOT-153 코드 리뷰). 결제창이 아직 이 칸을 보내지 않아 지금은 결제 ID에서 읽는 길로 간다(payment §8 '주문 참조').
 */
function customOrderRefOf(customData: unknown): string | undefined {
  const text = str(customData);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    const orderId = typeof value === 'object' && value !== null ? str((value as { orderId?: unknown }).orderId) : undefined;
    return orderId === '' ? undefined : orderId;
  } catch {
    return undefined;
  }
}

/** 시작 때 부른다. 형식이 틀리면 던져 시작하지 않는다. 글에 값을 싣지 않는다 */
function webhookKeyOf(secret: string): Buffer {
  const key = WEBHOOK_SECRET.test(secret) ? Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64') : undefined;
  if (key === undefined || key.length < MIN_WEBHOOK_KEY_BYTES) throw new RangeError(`포트원 웹훅 시크릿(PEAKET_PG_PORTONE_WEBHOOK_SECRET)은 ${WEBHOOK_SECRET_PREFIX} + 표준 base64 ${MIN_WEBHOOK_KEY_BYTES}바이트 이상이어야 한다`);
  return key;
}

export class PortoneGateway implements PaymentGatewayPort {
  readonly pg = 'PORTONE' as const;
  readonly #http: ExternalHttpClient;
  readonly #queryHttp: ExternalHttpClient;
  readonly #authorization: string;
  readonly #storeId: string;
  readonly #channelKey: string;
  readonly #channelKeys: Readonly<Partial<Record<PayMethod, string>>> | undefined;
  readonly #webhookKeys: readonly Buffer[];
  readonly #isTest: boolean;
  readonly #clock: Clock;
  readonly #readTimeoutMs: number;
  readonly #confirmBudgetMs: number;
  readonly #followUpTimeoutMs: number;
  readonly #callsPerSecond: number;

  constructor(o: PortoneGatewayOptions) {
    this.#clock = o.clock ?? systemClock;
    this.#readTimeoutMs = o.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.#confirmBudgetMs = o.confirmBudgetMs ?? CONFIRM_CALL_BUDGET_MS;
    this.#followUpTimeoutMs = o.followUpTimeoutMs ?? PORTONE_FOLLOW_UP_TIMEOUT_MS;
    this.#callsPerSecond = o.callsPerSecond ?? DEFAULT_CALLS_PER_SECOND;
    const client = (f: typeof fetch | undefined) => createExternalHttpClient({ provider: PROVIDER, baseUrl: o.baseUrl, timeoutCapMs: this.#readTimeoutMs, clock: o.clock, fetch: f });
    this.#http = client(o.fetch);
    this.#queryHttp = o.queryFetch === undefined ? this.#http : client(o.queryFetch);
    this.#authorization = `PortOne ${o.secret}`;
    this.#storeId = o.storeId;
    this.#channelKey = o.channelKey;
    this.#channelKeys = o.channelKeys;
    this.#webhookKeys = o.webhookSecrets.map(webhookKeyOf);
    this.#isTest = o.isTest;
  }

  capabilities(): PgCapabilities {
    return {
      serverConfirm: true,
      confirmDeadlineMs: CONFIRM_DEADLINE_MS,
      partialCancel: true,
      webhookSignature: true,
      idempotencyRetentionMs: IDEMPOTENCY_RETENTION_MS,
      callsPerSecond: this.#callsPerSecond,
      redirectCheckout: true,
      confirmCallCost: CONFIRM_CALL_COST,
      ...(this.#channelKeys === undefined ? {} : { payMethods: Object.keys(this.#channelKeys) as PayMethod[] }),
    };
  }

  checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues {
    if (!(Number.isSafeInteger(order.amount) && order.amount > 0)) throw new RangeError(`결제 금액은 양의 정수(원)여야 한다: ${order.amount}`);
    // 표가 있으면 표에 없는 수단을 다른 채널로 받지 않는다(선택기가 먼저 막는다)
    const channelKey = this.#channelKeys === undefined ? this.#channelKey : this.#channelKeys[payMethod as PayMethod];
    if (channelKey === undefined) throw new RangeError(`이 결제수단을 받는 포트원 채널이 없다: ${payMethod}`);
    return {
      portone: {
        storeId: this.#storeId,
        channelKey,
        paymentId: `${PAYMENT_ID_PREFIX}${order.orderId}`,
        orderName: order.orderName,
        totalAmount: order.amount,
        currency: CURRENCY,
        redirectUrl: attempt.successUrl,
        customData: { orderId: order.orderId },
      },
    };
  }

  async confirm(c: { orderId: string; paymentRef: string; amount: number; idemKey: string; confirmToken?: string; txId?: string }): Promise<ConfirmResult> {
    if (c.idemKey !== confirmIdemKey(c.orderId)) throw new TypeError('승인 멱등키는 confirm-{주문 ID}여야 한다');
    const idem = idempotencyHeader(c.idemKey);
    if (!c.confirmToken) throw new TypeError('포트원 승인에는 결제 토큰이 필요하다');
    const startedMs = this.#clock.monotonicMs();
    const body = { storeId: this.#storeId, paymentToken: c.confirmToken, ...(c.txId === undefined ? {} : { txId: c.txId }), totalAmount: c.amount, currency: CURRENCY, isTest: this.#isTest };
    const r = await this.#post('/payments/{paymentId}/confirm', c.paymentRef, body, idem);
    const unknown: ConfirmResult = { outcome: 'UNKNOWN', paymentRef: c.paymentRef };
    if (r === 'NO_ANSWER' || r.status >= 500) return unknown;
    if (r.status === 200) {
      // 승인 답에는 결제 ID·금액이 없다. pgTxId가 없거나 시각이 시각 모양이 아니면 승인 모양이 아니라 조회도 하지 않는다
      const paidAt = str(r.json?.paidAt);
      if (!str(r.json?.pgTxId) || (paidAt !== undefined && Number.isNaN(Date.parse(paidAt)))) return unknown;
      const q = await this.#followUp(c.paymentRef, startedMs, c.txId);
      if (!q || q.orderRef !== c.orderId) return unknown;
      // 입금 전이라 결제 시각이 없어도 입금 대기는 받는다(BUILD_ORDER HOT-151, 코드 리뷰). 승인은 시각이 있어야 한다
      if (q.status === 'WAITING_FOR_DEPOSIT') return { outcome: 'WAITING_FOR_DEPOSIT', paymentRef: c.paymentRef, amount: q.amount, ...(q.virtualAccount ? { virtualAccount: q.virtualAccount } : {}) };
      if (paidAt === undefined || (q.status !== 'APPROVED' && q.status !== 'PARTIAL_CANCELED')) return unknown;
      return { outcome: 'APPROVED', ...this.#approvedFields(c.paymentRef, q) };
    }
    const code = str(r.json?.type);
    // 429는 어디서 왔든 결제사까지 처리되지 않은 요청이다. 재전송 다음 시도만 늦춘다
    if (r.status === 429) return { outcome: 'DECLINED', paymentRef: c.paymentRef, failureCategory: 'THROTTLED', ...(code ? { pgCode: code } : {}) };
    // 결제사가 정해진 type으로 답한 4xx만 거절로 읽는다. 나머지는 중간 장비의 답일 수 있어 결과를 가정하지 않는다
    if (r.status < 400 || r.status === 408 || !code) return unknown;
    if (code === OUTSTANDING) return { outcome: 'IN_PROGRESS', paymentRef: c.paymentRef, pgCode: code };
    if (code === ALREADY_PAID) {
      const q = await this.#followUp(c.paymentRef, startedMs, c.txId);
      // 결제사가 이 결제를 승인한 것을 확인했을 때만 ALREADY_APPROVED다. 금액은 조회 값을 그대로 실어, 다르면 실행기가 UNKNOWN + SEV1을 쓴다
      if (!q || q.orderRef !== c.orderId || (q.status !== 'APPROVED' && q.status !== 'PARTIAL_CANCELED')) return unknown;
      return { outcome: 'ALREADY_APPROVED', ...this.#approvedFields(c.paymentRef, q) };
    }
    const failureCategory = CONFIRM_DECLINE.get(code);
    if (failureCategory === undefined) return unknown;
    return { outcome: 'DECLINED', paymentRef: c.paymentRef, failureCategory, pgCode: code };
  }

  async query(paymentRef: string, options?: QueryOptions): Promise<QueryResult> {
    const timeoutCapMs = options?.timeoutMs === undefined ? undefined : Math.min(options.timeoutMs, this.#readTimeoutMs);
    const r = await this.#get(paymentRef, timeoutCapMs);
    if (r === 'NO_ANSWER') return unknownQuery;
    if (r.status === 429) return { kind: 'UNKNOWN', throttled: true };
    // 결제사의 정해진 코드일 때만 없음이다. 그 밖의 404는 중간 장비의 답일 수 있다
    if (r.status === 404) return str(r.json?.type) === NOT_FOUND_PAYMENT ? { kind: 'NOT_FOUND' } : unknownQuery;
    if (r.status !== 200) return unknownQuery;
    return this.#foundOf(paymentRef, r.json, options?.expectedTxId) ?? unknownQuery;
  }

  /** 거래 조회(포트원 GET /payments-by-cursor, payment §8, BUILD_ORDER HOT-153) */
  async listTransactions(req: ListTransactionsRequest): Promise<ListTransactionsResult> {
    const r = await pgRequest(this.#queryHttp, {
      method: 'GET',
      path: '/payments-by-cursor',
      params: {},
      query: { storeId: this.#storeId, from: new Date(req.fromMs).toISOString(), until: new Date(req.toMs).toISOString(), size: String(req.limit), ...(req.cursor === undefined ? {} : { cursor: req.cursor }) },
      headers: this.#headers(false),
      ...(req.timeoutMs === undefined ? {} : { timeoutCapMs: Math.min(req.timeoutMs, this.#readTimeoutMs) }),
    });
    if (r === 'NO_ANSWER') return unknownPage;
    if (r.status === 429) return { kind: 'UNKNOWN', throttled: true };
    if (r.status !== 200 || !Array.isArray(r.json?.items)) return unknownPage;
    const items: PgTransaction[] = [];
    const unreadable: PgUnreadableRow[] = [];
    for (const raw of r.json.items as unknown[]) {
      const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const paymentRef = str(row.id);
      const status = STATUS.get(str(row.status) ?? '');
      const amount = num((row.amount as Record<string, unknown> | undefined)?.total);
      // 상태가 바뀐 시각이 대상 날짜를 정한다(승인 뒤 취소된 결제는 취소 시각이다)
      const atMs = Date.parse(str(row.statusChangedAt) ?? str(row.paidAt) ?? '');
      // 못 읽는 줄 하나 때문에 묶음 전체를 실패시키지 않는다(BUILD_ORDER HOT-153 코드 리뷰 M13)
      if (!paymentRef || !status || amount === undefined || Number.isNaN(atMs)) unreadable.push(unreadableRowOf(raw, (x) => x.id, (_x, ref) => (ref === undefined ? undefined : orderRefOfId(ref))));
      else items.push({ paymentRef, orderRef: customOrderRefOf(row.customData) ?? orderRefOfId(paymentRef), status, amount, atMs });
    }
    const cursor = str(r.json?.cursor);
    return { kind: 'PAGE', items, ...(cursor === undefined || cursor === '' ? {} : { nextCursor: cursor }), ...(unreadable.length === 0 ? {} : { unreadable }) };
  }

  async cancel(c: { paymentRef: string; amount: number | 'ALL'; reason: string; idemKey: string; expectedBalance?: number }): Promise<CancelResult> {
    if (!CANCEL_IDEM_KEY.test(c.idemKey)) throw new TypeError('취소 멱등키는 cancel-{취소 ID}여야 한다');
    const idem = idempotencyHeader(c.idemKey);
    // 검증값은 호출자가 첫 전송 전에 저장한 값만 보낸다(payment §2.1 결제 취소 API). 직전 조회로 읽으면 재시도마다 값이 달라져 같은 멱등키에 다른 본문을 보내게 된다
    const body = { storeId: this.#storeId, reason: c.reason, ...(c.amount === 'ALL' ? {} : { amount: c.amount }), ...(c.expectedBalance === undefined ? {} : { currentCancellableAmount: c.expectedBalance }) };
    const r = await this.#post('/payments/{paymentId}/cancel', c.paymentRef, body, idem);
    if (r === 'NO_ANSWER' || r.status >= 500 || r.status === 429) return { outcome: 'UNKNOWN' };
    if (r.status === 200) {
      const s = str((r.json?.cancellation as Record<string, unknown> | undefined)?.status);
      // 공식 스키마의 취소 답에는 남은 금액 칸이 없다. 다른 값으로 계산해 만들지 않는다(필요하면 단독 조회로 읽는다)
      if (s === 'SUCCEEDED') return { outcome: 'CANCELLED' };
      if (s === 'REQUESTED') return { outcome: 'CANCEL_PENDING' };
      if (s === 'FAILED') return { outcome: 'REJECTED' };
      return { outcome: 'UNKNOWN' };
    }
    const code = str(r.json?.type);
    if (r.status < 400 || r.status === 408 || !code) return { outcome: 'UNKNOWN' };
    if (code === OUTSTANDING) return { outcome: 'CANCEL_PENDING', pgCode: code };
    // 이미 전액 취소된 결제를 전액 취소하면 바라는 상태와 같다
    if (code === ALREADY_CANCELLED && c.amount === 'ALL') return { outcome: 'CANCELLED', pgCode: code };
    return CANCEL_REJECTED.has(code) ? { outcome: 'REJECTED', pgCode: code } : { outcome: 'UNKNOWN' };
  }

  parseWebhook(headers: HeaderBag, body: string): WebhookParseResult {
    if (this.#webhookKeys.length === 0) return { kind: 'INVALID', reason: 'NO_SECRET' };
    const lower = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), typeof v === 'string' ? v : undefined);
    const id = lower.get('webhook-id');
    const timestamp = lower.get('webhook-timestamp');
    const signature = lower.get('webhook-signature');
    if (!id || id.length > MAX_WEBHOOK_ID || !timestamp || !signature || !/^[0-9]{1,12}$/.test(timestamp)) return { kind: 'INVALID', reason: 'HEADER' };
    if (Math.abs(Math.floor(this.#clock.now() / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return { kind: 'INVALID', reason: 'TIMESTAMP' };
    if (!this.#signatureMatches(id, timestamp, body, signature)) return { kind: 'INVALID', reason: 'SIGNATURE' };
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return { kind: 'INVALID', reason: 'BODY' };
    }
    if (msg === null || typeof msg !== 'object') return { kind: 'INVALID', reason: 'BODY' };
    const m = msg as { type?: unknown; data?: { paymentId?: unknown } };
    // 서명이 맞은 본문의 사건 종류만 모르는 것은 거절이 아니라 무시다(P-T17)
    if (typeof m.type !== 'string' || !PAYMENT_EVENTS.has(m.type)) return { kind: 'IGNORED' };
    const paymentRef = str(m.data?.paymentId);
    if (paymentRef === undefined || !WEBHOOK_REF.test(paymentRef)) return { kind: 'INVALID', reason: 'BODY' };
    return {
      kind: 'TRIGGER',
      dedupKey: `PORTONE:${id}`,
      paymentRef,
      ...(paymentRef.startsWith(PAYMENT_ID_PREFIX) ? { orderRef: paymentRef.slice(PAYMENT_ID_PREFIX.length) } : {}),
      ...(m.type === 'Transaction.Paid' ? { depositDone: true as const } : {}),
      // 입금 오류 동작은 포트원 문서에서 찾지 못해 토스와 같게 둔다(추정, payment §6 '결제사 동작'). 조회가 입금 대기일 때만 원장이 바뀐다(BUILD_ORDER HOT-152)
      ...(m.type === 'Transaction.VirtualAccountIssued' ? { depositReversed: true as const } : {}),
    };
  }

  /** v1 서명 가운데 하나가 시크릿 가운데 하나와 일정 시간 비교로 맞는가 */
  #signatureMatches(id: string, timestamp: string, body: string, header: string): boolean {
    const provided = header
      .split(' ')
      .filter((part) => part.startsWith('v1,'))
      .map((part) => Buffer.from(part.slice(3), 'base64'));
    for (const key of this.#webhookKeys) {
      const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
      for (const candidate of provided) if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
    }
    return false;
  }

  /** 승인·이미 결제됨 뒤의 조회(조회 전용 연결 묶음). 승인 호출에 쓴 시간을 뺀 몫과 조회 상한 10초 [가정] 가운데 짧은 쪽만 기다리고, 몫을 다 썼으면 부르지 않는다 */
  async #followUp(paymentRef: string, startedMs: number, expectedTxId: string | undefined): Promise<Found | undefined> {
    const leftMs = this.#confirmBudgetMs - (this.#clock.monotonicMs() - startedMs);
    if (leftMs < 1) return undefined;
    const r = await this.#get(paymentRef, Math.min(leftMs, this.#followUpTimeoutMs, this.#readTimeoutMs));
    if (r === 'NO_ANSWER' || r.status !== 200) return undefined;
    return this.#foundOf(paymentRef, r.json, expectedTxId);
  }

  /** 200 조회 본문을 읽는다. 다른 결제·다른 결제 시도의 답이거나 필수 칸이 없으면 undefined(UNKNOWN)다 */
  #foundOf(paymentRef: string, json: Record<string, unknown> | undefined, expectedTxId: string | undefined): Found | undefined {
    const id = str(json?.id);
    if (id !== paymentRef || !id.startsWith(PAYMENT_ID_PREFIX)) return undefined;
    if (expectedTxId !== undefined && str(json?.transactionId) !== expectedTxId) return undefined;
    const status = STATUS.get(str(json?.status) ?? '');
    const amount = json?.amount as Record<string, unknown> | undefined;
    const total = num(amount?.total);
    const paid = num(amount?.paid);
    const cancelled = num(amount?.cancelled);
    if (!status || total === undefined || paid === undefined || cancelled === undefined) return undefined;
    const approvedAt = str(json?.paidAt);
    const paymentMethod = json?.method as Record<string, unknown> | undefined;
    const method = METHOD_CATEGORY.get(str(paymentMethod?.type) ?? '');
    const card = portoneCardOfMethod(paymentMethod);
    const virtualAccount = status === 'WAITING_FOR_DEPOSIT' ? portoneVirtualAccountOf(paymentMethod) : undefined;
    return {
      kind: 'FOUND',
      paymentRef,
      orderRef: id.slice(PAYMENT_ID_PREFIX.length),
      status,
      amount: total,
      balanceAmount: paid - cancelled,
      ...(approvedAt ? { approvedAt } : {}),
      ...(method ? { method } : {}),
      ...(card ? { card } : {}),
      ...(virtualAccount ? { virtualAccount } : {}),
    };
  }

  #approvedFields(paymentRef: string, q: Found): Omit<ConfirmResult, 'outcome'> {
    return { paymentRef, amount: q.amount, approvedAt: q.approvedAt, ...(q.card ? { card: q.card } : {}), ...(q.method ? { method: q.method } : {}) };
  }

  #headers(hasBody: boolean, idem?: string): Record<string, string> {
    return { authorization: this.#authorization, ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) };
  }

  #post(path: string, paymentId: string, body: unknown, idem: string): Promise<PgReply> {
    return pgRequest(this.#http, { method: 'POST', path, params: { paymentId }, headers: this.#headers(true, idem), body: JSON.stringify(body) });
  }

  #get(paymentId: string, timeoutCapMs?: number): Promise<PgReply> {
    return pgRequest(this.#queryHttp, { method: 'GET', path: '/payments/{paymentId}', params: { paymentId }, query: { storeId: this.#storeId }, headers: this.#headers(false), ...(timeoutCapMs === undefined ? {} : { timeoutCapMs }) });
  }
}
