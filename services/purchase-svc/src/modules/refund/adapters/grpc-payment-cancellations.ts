// payment-svc 일반 취소 gRPC 어댑터(GAT-080). 주문 ID로 결제를 찾고(GetPayment) 그 payment_id로 부분 취소를 부른다.
// payment-svc는 cancel-{cancellationId} 멱등키로 결제사 부분 취소를 하고, 성공한 금액을 원장 cancelled_amount에 더한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { PaymentCancelOutcome } from '../domain/cancellation.js';
import type { PaymentCancellations } from '../domain/ports.js';

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

const RESULTS: ReadonlySet<PaymentCancelOutcome> = new Set(['CANCELLED', 'PENDING', 'REJECTED', 'UNKNOWN']);

export interface GrpcPaymentCancellationsOptions {
  address: string;
  profile?: GrpcLbProfile;
  breaker?: CircuitBreaker;
}

export class GrpcPaymentCancellations implements PaymentCancellations {
  readonly #client: grpc.Client & { GetPayment: Unary; CancelPayment: Unary };

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
  }

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
      });
    } catch {
      return 'UNKNOWN';
    }
    const raw = typeof answer.result === 'string' ? answer.result.replace(/^CANCEL_RESULT_/, '') : '';
    const outcome = raw === 'CANCEL_PENDING' ? 'PENDING' : raw;
    return RESULTS.has(outcome as PaymentCancelOutcome) ? (outcome as PaymentCancelOutcome) : 'UNKNOWN';
  }

  close(): void {
    this.#client.close();
  }
}
