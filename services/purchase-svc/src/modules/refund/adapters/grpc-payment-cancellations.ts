// payment-svc 일반 취소 gRPC 어댑터(GAT-080). 주문 ID로 결제를 찾고(GetPayment) 그 payment_id로 부분 취소를 부른다.
// payment-svc는 cancel-{cancellationId} 멱등키로 결제사 부분 취소를 하고, 성공한 금액을 원장 cancelled_amount에 더한다.
// 선택 인자 scope(DEPOSIT_ONLY)가 있으면 요청에 CANCEL_SCOPE_DEPOSIT_ONLY를 싣는다(탈퇴 참여자의 입금 전 취소만, payment §6 '입금 전 취소만 부르기', BAT-010).
// 환불 계좌가 있으면 요청의 refund_account에 싣는다(이 호출에만, 로그·오류 글에 싣지 않는다). 결과 REFUND_ACCOUNT_REQUIRED는 계좌 대기다(BUILD_ORDER GAT-090).
// 결제 수단 읽기(PaymentMethodLookup): GetPayment의 virtual_account_paid를 300ms [가정] 안에 읽고, 차단기(payment-svc-get)가 꽂혔으면 그 안에서 부른다.
// 실패·결제 없음·다른 주문의 답은 던진다(모르는 것을 '계좌 필요 없음'으로 보지 않는다, docs/features/payment.md §6 'purchase-svc 견적').
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { PaymentCancelOutcome } from '../domain/cancellation.js';
import type { PaymentCancellations, PaymentMethodLookup } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type PaymentPackage = { PaymentService: grpc.ServiceClientConstructor };

let loaded: PaymentPackage | undefined;
function paymentPackage(): PaymentPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

const RESULTS: ReadonlySet<PaymentCancelOutcome> = new Set(['CANCELLED', 'PENDING', 'REJECTED', 'UNKNOWN', 'REFUND_ACCOUNT_REQUIRED']);
/** 결제 수단 읽기의 시간 상한(부르는 쪽 값이 더 커도 이 값을 넘지 않는다) */
const METHOD_LOOKUP_CAP_MS = 300;

export interface GrpcPaymentCancellationsOptions {
  address: string;
  profile?: GrpcLbProfile;
  /** 결제 수단 읽기(GetPayment)의 차단기(payment-svc-get). 취소 호출에는 쓰지 않는다 */
  breaker?: CircuitBreaker;
}

export class GrpcPaymentCancellations implements PaymentCancellations, PaymentMethodLookup {
  readonly #client: grpc.Client & { GetPayment: Unary; CancelPayment: Unary };
  /** 결제 수단 읽기의 차단기(payment-svc-get). 서비스 지표를 만든 뒤 묶는다(useMethodBreaker) */
  #methodBreaker: CircuitBreaker | undefined;

  constructor(o: GrpcPaymentCancellationsOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_PAYMENT_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'payment-svc',
      timeoutCapMs: 5_000,
    }) as unknown as grpc.Client & { GetPayment: Unary; CancelPayment: Unary };
    this.#methodBreaker = o.breaker;
  }

  /** 결제 수단 읽기에 차단기를 묶는다(시작 조립이 서비스 지표를 만든 뒤 부른다) */
  useMethodBreaker(breaker: CircuitBreaker): void {
    this.#methodBreaker = breaker;
  }

  /** @throws Error 읽지 못함(시간 초과·연결 실패·차단기 열림·결제 없음·다른 주문의 답) */
  async virtualAccountPaid(q: Parameters<PaymentMethodLookup['virtualAccountPaid']>[0]): Promise<boolean> {
    const ms = Math.min(METHOD_LOOKUP_CAP_MS, Math.max(1, Math.floor(Number.isFinite(q.deadlineMs) ? q.deadlineMs : METHOD_LOOKUP_CAP_MS)));
    const once = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        this.#client.GetPayment({ order_id: q.orderId }, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    const answer = await (this.#methodBreaker ? this.#methodBreaker.run(once) : once());
    if (answer.order_id !== q.orderId) throw new Error('GetPayment 답의 주문이 요청과 다르다');
    return answer.virtual_account_paid === true;
  }

  /** 입금 전 취소만(DEPOSIT_ONLY)은 계좌를 쓰지 않아 REFUND_ACCOUNT_REQUIRED가 없다(탈퇴 참여자 포트의 결과 이름과 같다). 받으면 REJECTED로 읽는다 */
  cancel(q: Parameters<PaymentCancellations['cancel']>[0] & { readonly scope: 'DEPOSIT_ONLY' }): Promise<Exclude<PaymentCancelOutcome, 'REFUND_ACCOUNT_REQUIRED'>>;
  cancel(q: Parameters<PaymentCancellations['cancel']>[0]): Promise<PaymentCancelOutcome>;
  async cancel(q: Parameters<PaymentCancellations['cancel']>[0]): Promise<PaymentCancelOutcome> {
    const ms = Math.min(5_000, Math.max(1, Math.floor(Number.isFinite(q.deadlineMs) ? q.deadlineMs : 5_000)));
    const call = (method: 'GetPayment' | 'CancelPayment', req: object): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        this.#client[method](req, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    let paymentId: string;
    try {
      const found = await call('GetPayment', { order_id: q.orderId });
      paymentId = typeof found.payment_id === 'string' ? found.payment_id : '';
    } catch {
      return 'UNKNOWN';
    }
    if (paymentId === '') return 'REJECTED';
    let answer: Record<string, unknown>;
    try {
      answer = await call('CancelPayment', {
        payment_id: paymentId,
        cancellation_id: q.cancellationId,
        amount: { krw: q.amount },
        reason: q.reason,
        ...(q.scope === 'DEPOSIT_ONLY' ? { scope: 'CANCEL_SCOPE_DEPOSIT_ONLY' } : {}),
        ...(q.refundAccount !== undefined
          ? { refund_account: { bank_code: q.refundAccount.bankCode, account_number: q.refundAccount.accountNumber, holder_name: q.refundAccount.holderName } }
          : {}),
      });
    } catch {
      return 'UNKNOWN';
    }
    const raw = typeof answer.result === 'string' ? answer.result.replace(/^CANCEL_RESULT_/, '') : '';
    const outcome = raw === 'CANCEL_PENDING' ? 'PENDING' : raw;
    if (outcome === 'REFUND_ACCOUNT_REQUIRED' && q.scope === 'DEPOSIT_ONLY') return 'REJECTED';
    return RESULTS.has(outcome as PaymentCancelOutcome) ? (outcome as PaymentCancelOutcome) : 'UNKNOWN';
  }

  close(): void {
    this.#client.close();
  }
}
