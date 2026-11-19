// payment-svc PaymentService 클라이언트(docs/api/proto/peaket/payment/v1/payment.proto, ADR-0299). 굿즈 주문은 order_kind ORDER_KIND_MERCH로 부르고
// event_id·entry_opens_at을 보내지 않는다(ConfirmPayment, 결정 2). PrepareCheckout의 event_id는 부가 상품·현장 수령의 회차가 있을 때만 싣는다(결정 3).
// 데드라인: PrepareCheckout 300ms [가정], ConfirmPayment 200ms(ADR-0300 결정 5), BatchGetPayments 500ms [가정](docs/verification.md §4.1), CancelPayment 1초 [가정].
// 결제 참조·토큰은 로그·오류 글에 싣지 않는다. 주소(PEAKET_PAYMENT_GRPC_ADDR)가 없으면 unavailableMerchPayments로 결제 경로만 503이다.
import { randomBytes } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { hostPort } from '../../catalog/index.js';
import {
  type CancelInput,
  type CancelOutcome,
  type CheckoutAnswer,
  CheckoutFailed,
  type CheckoutQuery,
  type CheckoutValues,
  type ConfirmCommand,
  type ConfirmOutcome,
  type MerchPayments,
  type PaymentDetail,
  type PaymentState,
} from '../domain/merch-ports.js';
import { nextDay2359KstMs, type ShopPg } from '../domain/merch-order.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE = { checkout: 300, confirm: 200, batch: 500, getPayment: 300, cancel: 1_000 } as const;
const CAP_MS = 1_000;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type Client = grpc.Client & { PrepareCheckout: Unary; ConfirmPayment: Unary; BatchGetPayments: Unary; GetPayment: Unary; CancelPayment: Unary };

const PG_PROVIDER: Readonly<Record<ShopPg, string>> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };
const pgOf = (v: unknown): ShopPg | undefined => {
  const s = typeof v === 'string' ? v.replace(/^PG_PROVIDER_/, '') : '';
  return s === 'TOSS' || s === 'PORTONE' || s === 'SIMULATOR' ? s : undefined;
};
const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const msOf = (v: unknown): number | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  const t = v as { seconds?: unknown; nanos?: unknown };
  const s = Number(t.seconds ?? 0);
  const n = Number(t.nanos ?? 0);
  return s === 0 && n === 0 ? undefined : s * 1000 + Math.floor(n / 1_000_000);
};
const krw = (v: unknown): number => Number((v as { krw?: unknown } | undefined)?.krw ?? 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isServiceError = (e: unknown): e is grpc.ServiceError => typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number';

/** PrepareCheckout 답의 결제창 값 → openapi checkout 모양 */
function checkoutOf(v: Record<string, unknown>): CheckoutValues | undefined {
  const field = v.checkout;
  const m = field === 'toss' || field === 'portone' || field === 'simulator' ? (v[field] as Record<string, unknown> | undefined) : undefined;
  if (!m) return undefined;
  if (field === 'portone') {
    const customData = m.custom_data as { order_id?: unknown } | undefined;
    return {
      storeId: str(m.store_id),
      channelKey: str(m.channel_key),
      paymentId: str(m.payment_id),
      orderName: str(m.order_name),
      totalAmount: krw(m.total_amount),
      currency: str(m.currency),
      redirectUrl: str(m.redirect_url),
      ...(customData && typeof customData.order_id === 'string' && customData.order_id !== '' ? { customData: { orderId: customData.order_id } } : {}),
    };
  }
  const escrow = Array.isArray(m.escrow_products) ? (m.escrow_products as Record<string, unknown>[]) : [];
  return {
    clientKey: str(m.client_key),
    customerKey: str(m.customer_key),
    orderId: str(m.order_id),
    orderName: str(m.order_name),
    amount: krw(m.amount),
    successUrl: str(m.success_url),
    failUrl: str(m.fail_url),
    ...(escrow.length === 0
      ? {}
      : { escrowProducts: escrow.map((p) => ({ id: str(p.id), name: str(p.name), code: str(p.code), unitPrice: Number(p.unit_price ?? 0), quantity: Number(p.quantity ?? 0) })) }),
  };
}

const PAYMENT_STATUSES = new Set(['ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED']);

export class GrpcMerchPayments implements MerchPayments {
  readonly #client: Client;

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: Record<string, unknown> } } }).peaket.payment.v1;
    const { host, port } = hostPort(address, 'PEAKET_PAYMENT_GRPC_ADDR');
    this.#client = createGrpcClient(pkg.PaymentService as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'payment-svc', timeoutCapMs: CAP_MS }) as unknown as Client;
  }

  #call(method: 'PrepareCheckout' | 'ConfirmPayment' | 'BatchGetPayments' | 'GetPayment' | 'CancelPayment', req: object, ms: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.#client[method](req, new grpc.Metadata(), { deadline: Date.now() + ms }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
    });
  }

  async prepareCheckout(q: CheckoutQuery): Promise<CheckoutAnswer> {
    let v: Record<string, unknown>;
    try {
      v = await this.#call(
        'PrepareCheckout',
        {
          order_kind: 'ORDER_KIND_MERCH',
          order_id: q.orderId,
          event_id: q.eventId ?? '',
          amount: { krw: q.amount },
          pay_method: q.payMethod ?? '',
          order_name: q.orderName,
          attempt_id: q.attemptId,
          // 토스 구매자 키는 계정 ID를 쓰지 않는다(proto 주석). 비우면 payment-svc가 만든다
          customer_key: '',
          virtual_account_allowed: q.virtualAccountAllowed,
          payment_store: q.pgStore === 'ESCROW' ? 'PAYMENT_STORE_ESCROW' : 'PAYMENT_STORE_STANDARD',
          ...(q.escrowProducts === undefined ? {} : { escrow_products: q.escrowProducts.map((p) => ({ id: p.id, name: p.name, code: p.code, unit_price: p.unitPrice, quantity: p.quantity })) }),
        },
        DEADLINE.checkout,
      );
    } catch (e) {
      if (!isServiceError(e)) throw new CheckoutFailed('error');
      if (e.code === grpc.status.UNAVAILABLE || e.code === grpc.status.DEADLINE_EXCEEDED) throw new CheckoutFailed('unavailable');
      if (e.code === grpc.status.INVALID_ARGUMENT) throw new CheckoutFailed('invalid');
      if (e.code === grpc.status.FAILED_PRECONDITION) throw new CheckoutFailed('paused');
      throw new CheckoutFailed('error');
    }
    const pg = pgOf(v.pg);
    const checkout = checkoutOf(v);
    if (!pg || !checkout) throw new CheckoutFailed('error');
    const allowed = Array.isArray(v.allowed_pay_methods) ? v.allowed_pay_methods.map(String) : [];
    const depositDueAtMs = msOf(v.deposit_due_at);
    return { pg, switched: v.switched === true, checkout, allowedPayMethods: allowed, ...(depositDueAtMs === undefined ? {} : { depositDueAtMs }) };
  }

  async confirm(c: ConfirmCommand, deadlineMs: number): Promise<ConfirmOutcome> {
    const ref = c.ref.kind === 'portone' ? { portone: { payment_id: c.ref.paymentId, tx_id: c.ref.txId, payment_token: c.ref.paymentToken } } : { toss: { payment_key: c.ref.paymentKey } };
    try {
      await this.#call(
        'ConfirmPayment',
        {
          order_id: c.orderId,
          attempt_id: c.attemptId,
          pg: PG_PROVIDER[c.pg],
          ...ref,
          amount: { krw: c.amount },
          authenticated_at: ts(c.authenticatedAtMs),
          attempt_no: c.attemptNo,
          // 굿즈는 가상계좌를 받는다(입금 대기 O2~O4, ADR-0314)
          virtual_account_allowed: true,
          order_kind: 'ORDER_KIND_MERCH',
          payment_store: c.pgStore === 'ESCROW' ? 'PAYMENT_STORE_ESCROW' : 'PAYMENT_STORE_STANDARD',
        },
        Math.min(deadlineMs, DEADLINE.confirm),
      );
      return { status: 'ACCEPTED' };
    } catch (e) {
      if (!isServiceError(e)) return { status: 'RETRYABLE', reason: 'unexpected' };
      if (e.code === grpc.status.UNAVAILABLE) return { status: 'RETRYABLE', reason: 'unavailable' };
      if (e.code === grpc.status.DEADLINE_EXCEEDED) return { status: 'RETRYABLE', reason: 'deadline' };
      return { status: 'REJECTED', reason: (grpc.status[e.code] ?? 'unexpected').toLowerCase() };
    }
  }

  async batchGet(orderIds: readonly string[]): Promise<PaymentState[]> {
    const v = await this.#call('BatchGetPayments', { order_ids: [...orderIds] }, DEADLINE.batch);
    const rows = Array.isArray(v.payments) ? (v.payments as Record<string, unknown>[]) : [];
    return rows.map((r) => {
      const status = str(r.status).replace(/^PAYMENT_STATUS_/, '');
      const failure = str(r.failure_category).replace(/^FAILURE_CATEGORY_/, '');
      return {
        orderId: str(r.order_id).toLowerCase(),
        paymentId: str(r.payment_id).toLowerCase(),
        pg: pgOf(r.pg),
        status: (PAYMENT_STATUSES.has(status) ? status : 'UNSPECIFIED') as PaymentState['status'],
        approvedAtMs: msOf(r.approved_at),
        failureCategory: failure === '' || failure === 'UNSPECIFIED' ? undefined : failure,
        ...(msOf(r.deposit_due_at) === undefined ? {} : { depositDueAtMs: msOf(r.deposit_due_at) }),
      };
    });
  }

  async getPayment(orderId: string, deadlineMs: number): Promise<PaymentDetail | undefined> {
    let v: Record<string, unknown>;
    try {
      v = await this.#call('GetPayment', { order_id: orderId }, Math.min(deadlineMs, DEADLINE.getPayment));
    } catch (e) {
      if (isServiceError(e) && e.code === grpc.status.NOT_FOUND) return undefined;
      throw e;
    }
    const status = str(v.status).replace(/^PAYMENT_STATUS_/, '');
    const account = v.virtual_account as Record<string, unknown> | undefined;
    const bank = account === undefined ? undefined : str(account.bank);
    const accountNumber = account === undefined ? undefined : str(account.account_number);
    const dueAtMs = account === undefined ? undefined : msOf(account.due_at);
    return {
      status: (PAYMENT_STATUSES.has(status) ? status : 'UNSPECIFIED') as PaymentDetail['status'],
      pg: pgOf(v.pg),
      depositDueAtMs: msOf(v.deposit_due_at),
      ...(account === undefined
        ? {}
        : { virtualAccount: { ...(bank === '' ? {} : { bank }), ...(accountNumber === '' ? {} : { accountNumber }), ...(dueAtMs === undefined ? {} : { dueAtMs }) } }),
      virtualAccountPaid: v.virtual_account_paid === true,
    };
  }

  async cancel(c: CancelInput): Promise<CancelOutcome> {
    try {
      const v = await this.#call(
        'CancelPayment',
        {
          payment_id: c.paymentId,
          cancellation_id: c.cancellationId,
          amount: { krw: c.amount },
          reason: c.reason,
          ...(c.scope === undefined ? {} : { scope: 'CANCEL_SCOPE_DEPOSIT_ONLY' }),
          ...(c.refundAccount === undefined
            ? {}
            : { refund_account: { bank_code: c.refundAccount.bankCode, account_number: c.refundAccount.accountNumber, holder_name: c.refundAccount.holderName } }),
        },
        DEADLINE.cancel,
      );
      const r = str(v.result).replace(/^CANCEL_RESULT_/, '');
      return r === 'CANCELLED' || r === 'CANCEL_PENDING' || r === 'REFUND_ACCOUNT_REQUIRED' || r === 'REJECTED' ? r : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때: 결제창 준비는 pg-unavailable, 승인 명령은 다시 보내기, 당기기·원장 읽기는 실패, 취소는 결과 모름(다시 부른다) */
export const unavailableMerchPayments: MerchPayments = {
  prepareCheckout: async () => {
    throw new CheckoutFailed('unavailable');
  },
  confirm: async () => ({ status: 'RETRYABLE', reason: 'unwired' }),
  batchGet: async () => {
    throw new Error('payment-svc 주소(PEAKET_PAYMENT_GRPC_ADDR)가 없다');
  },
  getPayment: async () => {
    throw new Error('payment-svc 주소(PEAKET_PAYMENT_GRPC_ADDR)가 없다');
  },
  cancel: async () => 'UNKNOWN',
};

/**
 * 시험·개발용 결제 대역. 결제창은 시뮬레이터 값을, 승인 명령은 받아 적었다고 답하고 states에 둔 결과를 당기기로 돌려준다.
 * 부른 기록(calls)을 남긴다. 결과·실패는 시험이 바꾼다
 */
export class MemoryMerchPayments implements MerchPayments {
  readonly calls = {
    checkout: [] as CheckoutQuery[],
    confirm: [] as ConfirmCommand[],
    batch: [] as string[][],
    getPayment: [] as string[],
    cancel: [] as CancelInput[],
  };
  readonly states = new Map<string, PaymentState>();
  /** GetPayment 답. 넣지 않은 주문은 상태에서 만든 답을 쓴다(없으면 undefined) */
  readonly details = new Map<string, PaymentDetail>();
  checkoutFailure: CheckoutFailed | undefined;
  confirmOutcome: ConfirmOutcome = { status: 'ACCEPTED' };
  batchFails = false;
  getPaymentFails = false;
  cancelOutcomes: CancelOutcome[] = [];

  /** 입금 기한 계산에 쓸 시계(시험은 가짜 시계를 넣는다) */
  constructor(private readonly now: () => number = () => Date.now()) {}

  async prepareCheckout(q: CheckoutQuery): Promise<CheckoutAnswer> {
    this.calls.checkout.push(q);
    if (this.checkoutFailure) throw this.checkoutFailure;
    const url = `http://localhost:3000/shop/checkout/return?order=${encodeURIComponent(q.orderId)}&pg=SIMULATOR`;
    return {
      pg: 'SIMULATOR',
      switched: false,
      checkout: {
        clientKey: 'test_ck_local_simulator',
        customerKey: randomBytes(16).toString('base64url'),
        orderId: q.orderId,
        orderName: q.orderName,
        amount: q.amount,
        successUrl: url,
        failUrl: url,
        ...(q.escrowProducts === undefined ? {} : { escrowProducts: q.escrowProducts }),
      },
      // 상점마다 허용 수단이 다르다. 입금 기한은 가상계좌를 낼 수 있으면 늘 싣는다(openapi PaymentAttempt.depositDueAt)
      allowedPayMethods: q.pgStore === 'ESCROW' ? ['CARD', 'TRANSFER', 'VIRTUAL_ACCOUNT'] : ['CARD', 'EASY_PAY', 'TRANSFER', 'MOBILE', 'VIRTUAL_ACCOUNT'],
      depositDueAtMs: nextDay2359KstMs(this.now()),
    };
  }

  async confirm(c: ConfirmCommand): Promise<ConfirmOutcome> {
    this.calls.confirm.push(c);
    return this.confirmOutcome;
  }

  async batchGet(orderIds: readonly string[]): Promise<PaymentState[]> {
    this.calls.batch.push([...orderIds]);
    if (this.batchFails) throw new Error('payment-svc 멈춤(시험)');
    return orderIds.flatMap((id) => (this.states.has(id) ? [this.states.get(id)!] : []));
  }

  async getPayment(orderId: string, _deadlineMs: number): Promise<PaymentDetail | undefined> {
    this.calls.getPayment.push(orderId);
    if (this.getPaymentFails) throw new Error('payment-svc 멈춤(시험)');
    const detail = this.details.get(orderId);
    if (detail !== undefined) return detail;
    const s = this.states.get(orderId);
    return s === undefined ? undefined : { status: s.status, pg: s.pg, depositDueAtMs: s.depositDueAtMs, virtualAccountPaid: false };
  }

  async cancel(c: CancelInput): Promise<CancelOutcome> {
    this.calls.cancel.push(c);
    return this.cancelOutcomes.shift() ?? 'CANCELLED';
  }
}
