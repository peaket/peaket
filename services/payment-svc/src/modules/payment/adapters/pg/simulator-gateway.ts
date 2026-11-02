// 시뮬레이터 어댑터(ADR-0029 결정 1·6). PG 시뮬레이터(services/pg-simulator)를 토스페이먼츠와 같은 모양의 API로 부른다.
// - 플랫폼 외부 호출 클라이언트로 부른다: 추적 머리 없음, 리디렉트 안 따름, 남은 시간 안의 시간 초과(docs/observability.md §6).
// - 읽기 시간 초과는 60초 [가정](payment §2.1 '읽기 시간 초과 권장'). 끊김·시간 초과·5xx는 결과 모름(UNKNOWN)이다.
// - 결과 코드는 payment §2.1 '공통 결과 코드 정규화'와 '분석용 실패 범주'로 바꾼다. 대응표는 이 파일과 계약 시험이 정본이다.
import { createExternalHttpClient, type Clock, type ExternalHttpClient } from '@peaket/platform';
import {
  CANCEL_IDEM_KEY,
  confirmIdemKey,
  type CancelResult,
  type CheckoutAttempt,
  type CheckoutOrder,
  type CheckoutValues,
  type ConfirmResult,
  type FailureCategory,
  type HeaderBag,
  type PaymentGatewayPort,
  type PgCapabilities,
  type QueryResult,
  type QueryStatus,
  type WebhookTrigger,
} from '../../domain/payment-gateway.js';

export interface SimulatorGatewayOptions {
  /** 시뮬레이터 주소(로컬·CI는 루프백) */
  baseUrl: string;
  /** sim_sk_ 시험 키. Secrets Manager의 시험 키 경로에서 받는다(docs/security/secrets-and-keys.md) */
  secretKey: string;
  /** 결제창용 공개 키 */
  clientKey: string;
  /** 읽기 시간 초과 상한(ms). 기본 60초 [가정] */
  readTimeoutMs?: number;
  /** 시험별로 바꾸는 호출 상한(초당). 기본 300 */
  callsPerSecond?: number;
  clock?: Clock;
  fetch?: typeof fetch;
}

const TRANSMISSION_ID = 'tosspayments-webhook-transmission-id';
const STATUS: Readonly<Record<string, QueryStatus>> = {
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_FOR_DEPOSIT: 'WAITING_FOR_DEPOSIT',
  DONE: 'APPROVED',
  PARTIAL_CANCELED: 'PARTIAL_CANCELED',
  CANCELED: 'CANCELED',
  ABORTED: 'FAILED',
  EXPIRED: 'EXPIRED',
};
const USER_ABORTED = new Set(['PAY_PROCESS_CANCELED', 'PAY_PROCESS_ABORTED']);
const VALIDATION = new Set(['INVALID_REQUEST', 'NOT_FOUND_PAYMENT', 'DUPLICATED_ORDER_ID', 'IDEMPOTENCY_KEY_REUSED']);

type Reply = { status: number; json: Record<string, unknown> | undefined } | 'NO_ANSWER';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export class SimulatorPaymentGateway implements PaymentGatewayPort {
  readonly pg = 'SIMULATOR' as const;
  private readonly http: ExternalHttpClient;
  private readonly authorization: string;

  constructor(private readonly o: SimulatorGatewayOptions) {
    this.http = createExternalHttpClient({ provider: 'pg-simulator', baseUrl: o.baseUrl, timeoutCapMs: o.readTimeoutMs ?? 60_000, clock: o.clock, fetch: o.fetch });
    this.authorization = `Basic ${Buffer.from(`${o.secretKey}:`).toString('base64')}`;
  }

  capabilities(): PgCapabilities {
    return {
      serverConfirm: true,
      confirmDeadlineMs: 10 * 60_000,
      partialCancel: true,
      webhookSignature: false,
      idempotencyRetentionMs: 15 * 24 * 3_600_000,
      callsPerSecond: this.o.callsPerSecond ?? 300,
      redirectCheckout: true,
    };
  }

  checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues {
    if (payMethod !== 'CARD') throw new RangeError(`시뮬레이터는 카드 결제만 흉내 낸다: ${payMethod}`);
    if (!(Number.isSafeInteger(order.amount) && order.amount > 0)) throw new RangeError(`결제 금액은 양의 정수(원)여야 한다: ${order.amount}`);
    return {
      simulator: {
        clientKey: this.o.clientKey,
        customerKey: order.customerKey ?? 'ANONYMOUS',
        orderId: order.orderId,
        orderName: order.orderName,
        amount: order.amount,
        successUrl: attempt.successUrl,
        failUrl: attempt.failUrl,
      },
    };
  }

  async confirm(c: { orderId: string; paymentRef: string; amount: number; idemKey: string }): Promise<ConfirmResult> {
    if (c.idemKey !== confirmIdemKey(c.orderId)) throw new TypeError(`승인 멱등키는 confirm-{주문 ID}여야 한다: ${c.idemKey}`);
    const r = await this.call('POST', '/v1/payments/confirm', {}, { paymentKey: c.paymentRef, orderId: c.orderId, amount: c.amount }, c.idemKey);
    const unknown: ConfirmResult = { outcome: 'UNKNOWN', paymentRef: c.paymentRef };
    if (r === 'NO_ANSWER' || r.status >= 500) return unknown;
    if (r.status === 200) {
      const status = str(r.json?.status);
      if (status === 'WAITING_FOR_DEPOSIT') return { outcome: 'WAITING_FOR_DEPOSIT', paymentRef: c.paymentRef, amount: num(r.json?.totalAmount) };
      if (status !== 'DONE') return unknown;
      return { outcome: 'APPROVED', ...this.approvedFields(c.paymentRef, r.json!) };
    }
    const code = str(r.json?.code) ?? `HTTP_${r.status}`;
    const declined = (failureCategory: FailureCategory): ConfirmResult => ({ outcome: 'DECLINED', paymentRef: c.paymentRef, failureCategory, pgCode: code });
    if (r.status === 429) return declined('THROTTLED');
    if (r.status === 409 || code === 'ALREADY_PROCESSING_REQUEST') return { outcome: 'IN_PROGRESS', paymentRef: c.paymentRef, pgCode: code };
    if (code === 'ALREADY_PROCESSED_PAYMENT') {
      // 조회로 금액이 맞는지 본 뒤에만 승인과 똑같이 처리한다(payment §2.1 ALREADY_APPROVED)
      const q = await this.call('GET', '/v1/payments/{paymentKey}', { paymentKey: c.paymentRef });
      if (q === 'NO_ANSWER' || q.status !== 200) return unknown;
      const s = str(q.json?.status);
      if ((s === 'DONE' || s === 'PARTIAL_CANCELED') && num(q.json?.totalAmount) === c.amount && str(q.json?.orderId) === c.orderId) {
        return { outcome: 'ALREADY_APPROVED', ...this.approvedFields(c.paymentRef, q.json!) };
      }
      return declined('VALIDATION');
    }
    if (r.status === 401 || r.status === 403) return declined('PG_ERROR');
    if (code === 'NOT_FOUND_PAYMENT_SESSION') return declined('EXPIRED');
    if (USER_ABORTED.has(code)) return declined('USER_ABORTED');
    if (VALIDATION.has(code)) return declined('VALIDATION');
    return declined('CARD_DECLINED');
  }

  async query(paymentRef: string): Promise<QueryResult> {
    const r = await this.call('GET', '/v1/payments/{paymentKey}', { paymentKey: paymentRef });
    if (r === 'NO_ANSWER') return { kind: 'UNKNOWN' };
    if (r.status === 404) return { kind: 'NOT_FOUND' };
    const status = STATUS[str(r.json?.status) ?? ''];
    const amount = num(r.json?.totalAmount);
    const balanceAmount = num(r.json?.balanceAmount);
    const orderRef = str(r.json?.orderId);
    if (r.status !== 200 || !status || amount === undefined || balanceAmount === undefined || !orderRef) return { kind: 'UNKNOWN' };
    const approvedAt = str(r.json?.approvedAt);
    return { kind: 'FOUND', paymentRef, orderRef, status, amount, balanceAmount, ...(approvedAt ? { approvedAt } : {}) };
  }

  async cancel(c: { paymentRef: string; amount: number | 'ALL'; reason: string; idemKey: string }): Promise<CancelResult> {
    if (!CANCEL_IDEM_KEY.test(c.idemKey)) throw new TypeError(`취소 멱등키는 cancel-{취소 ID}여야 한다: ${c.idemKey}`);
    const body = { cancelReason: c.reason, ...(c.amount === 'ALL' ? {} : { cancelAmount: c.amount }) };
    const r = await this.call('POST', '/v1/payments/{paymentKey}/cancel', { paymentKey: c.paymentRef }, body, c.idemKey);
    if (r === 'NO_ANSWER' || r.status >= 500 || r.status === 429) return { outcome: 'UNKNOWN' };
    if (r.status === 200) {
      const s = str(r.json?.status);
      if (s !== 'CANCELED' && s !== 'PARTIAL_CANCELED') return { outcome: 'UNKNOWN' };
      return { outcome: 'CANCELLED', balanceAmount: num(r.json?.balanceAmount) };
    }
    const code = str(r.json?.code) ?? `HTTP_${r.status}`;
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
    if (!paymentRef) return null;
    const orderRef = str(m.data?.orderId);
    return { dedupKey: `SIMULATOR:${id}`, paymentRef, ...(orderRef ? { orderRef } : {}) };
  }

  private approvedFields(paymentRef: string, json: Record<string, unknown>): Omit<ConfirmResult, 'outcome'> {
    const card = json.card as Record<string, unknown> | null | undefined;
    const maskedNumber = str(card?.number);
    return {
      paymentRef,
      amount: num(json.totalAmount),
      approvedAt: str(json.approvedAt),
      ...(card && maskedNumber ? { card: { maskedNumber, issuerCode: str(card.issuerCode) ?? '', cardType: str(card.cardType) ?? '' } } : {}),
    };
  }

  private async call(method: 'GET' | 'POST', path: string, params: Record<string, string>, body?: unknown, idemKey?: string): Promise<Reply> {
    try {
      const res = await this.http.request({
        method,
        path,
        params,
        headers: {
          authorization: this.authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idemKey ? { 'idempotency-key': idemKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      try {
        const v: unknown = JSON.parse(text);
        json = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      // 끊김·시간 초과·남은 시간 없음: 보냈는지 처리됐는지 모른다
      return 'NO_ANSWER';
    }
  }
}
