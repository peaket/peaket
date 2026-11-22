// payment-svc 일반 취소(CancelPayment) gRPC 클라이언트(BAT-011 compCancel, docs/api/proto/peaket/payment/v1/payment.proto).
// refund 모듈의 grpc-payment-cancellations.ts와 같은 차례다: 주문 ID로 결제 원장을 찾고(GetPayment) 그 payment_id로 전액 취소를 부른다.
// cancellation_id는 compensation:{주문 ID}의 UUID(ADR-0354 결정 4)라 보상이 다시 돌아도 같은 취소로 본다(payment-svc의 cancel-{id} 멱등키).
// 사유는 order_cancellation.reason과 같은 EVENT_CANCELLED를 그대로 싣는다. 금액을 비우면 전액 취소다(docs/features/payment.md §3 T20).
// 답: CANCELLED → 끝(T20), CANCEL_PENDING·UNKNOWN → 같은 취소 ID로 다시, REJECTED·REFUND_ACCOUNT_REQUIRED → 영구 실패(SEV2, CS는 PRF-175).
// 실패 분류는 compensationFailureKind가 정한다. gRPC 오류는 상태 이름, 차단기 열림은 CIRCUIT_OPEN, 그 밖은 UNKNOWN이다.
// 주소가 없으면 local·ci만 '다시 보내기' 대역(늘 UNAVAILABLE)을 쓰고 경고 한 줄을 남긴다. 그 밖의 환경은 시작하지 않는다
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import {
  COMPENSATION_CANCEL_DEADLINE_MS,
  compensationFailureKind,
  compensationGrpcCodeOf,
  type CompensationPaymentAnswer,
  type PaymentCompensator,
} from '../domain/compensation.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type PaymentPackage = { PaymentService: grpc.ServiceClientConstructor };
/** 결제 주소 환경 값(host:port) */
export const PAYMENT_COMPENSATION_GRPC_ADDR_ENV = 'PEAKET_PAYMENT_GRPC_ADDR';
/** 의존성 이름(span·의존 로그·차단기 지표) */
export const PAYMENT_COMPENSATION_DEPENDENCY = 'payment-svc-compensation';

let loaded: PaymentPackage | undefined;
function paymentPackage(): PaymentPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

function isServiceError(e: unknown): e is grpc.ServiceError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' && 'metadata' in e;
}

/** 호출이 던진 것 → 보상 답. NOT_FOUND는 결제 원장이 없다는 뜻이라 영구 실패다(NO_PAYMENT) */
function answerOfError(e: unknown): { readonly kind: 'RETRY' | 'FAILED'; readonly code: string } {
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return { kind: 'RETRY', code: 'CIRCUIT_OPEN' };
    if (e.slug === 'deadline-exceeded') return { kind: 'RETRY', code: 'DEADLINE_EXCEEDED' };
    if (e.slug === 'server-busy') return { kind: 'RETRY', code: 'RESOURCE_EXHAUSTED' };
    return { kind: 'RETRY', code: 'UNKNOWN' };
  }
  const code = isServiceError(e) ? compensationGrpcCodeOf(e.code) : 'UNKNOWN';
  if (code === 'NOT_FOUND') return { kind: 'FAILED', code: 'NO_PAYMENT' };
  return { kind: compensationFailureKind(code), code };
}

export interface GrpcPaymentCompensatorOptions {
  readonly address: string;
  readonly profile?: GrpcLbProfile;
  /** 차단기(의존 이름 payment-svc-compensation). 열려 있으면 부르지 않고 CIRCUIT_OPEN */
  readonly breaker?: CircuitBreaker;
}

/** 결제 원장을 주문 ID로 찾아 전액 취소하는 클라이언트 */
export class GrpcPaymentCompensator implements PaymentCompensator {
  readonly #client: grpc.Client & { GetPayment: Unary; CancelPayment: Unary };

  constructor(readonly o: GrpcPaymentCompensatorOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${PAYMENT_COMPENSATION_GRPC_ADDR_ENV}는 host:port여야 한다`);
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: PAYMENT_COMPENSATION_DEPENDENCY,
      timeoutCapMs: COMPENSATION_CANCEL_DEADLINE_MS,
    }) as unknown as grpc.Client & { GetPayment: Unary; CancelPayment: Unary };
  }

  async cancel(input: { readonly orderId: string; readonly paymentId: string; readonly cancellationId: string; readonly reason: string; readonly deadlineMs: number }): Promise<CompensationPaymentAnswer> {
    const ms = Math.min(COMPENSATION_CANCEL_DEADLINE_MS, Math.max(1, Math.floor(Number.isFinite(input.deadlineMs) ? input.deadlineMs : COMPENSATION_CANCEL_DEADLINE_MS)));
    const call = (method: 'GetPayment' | 'CancelPayment', req: object): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        this.#client[method](req, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    const once = async (): Promise<CompensationPaymentAnswer> => {
      // start가 마지막 APPROVED 결제 ID를 알고 있으면 그대로 쓴다. 모르는 조립(발권 대기 주문을 쓸어 담는 실행기)은 주문 ID로 원장을 찾는다
      let paymentId = input.paymentId;
      if (paymentId === '') {
        try {
          const found = await call('GetPayment', { order_id: input.orderId });
          paymentId = typeof found.payment_id === 'string' ? found.payment_id : '';
        } catch (e) {
          const a = answerOfError(e);
          return a.kind === 'FAILED' ? { kind: 'FAILED', code: a.code } : { kind: 'RETRY', code: a.code };
        }
      }
      // 결제 원장이 없으면 payment-svc를 더 부르지 않는다(주문은 APPROVED인데 원장이 없는 어긋남)
      if (paymentId === '') return { kind: 'FAILED', code: 'NO_PAYMENT' };
      let answer: Record<string, unknown>;
      try {
        answer = await call('CancelPayment', {
          payment_id: paymentId,
          cancellation_id: input.cancellationId,
          reason: input.reason,
          // 금액을 비우면 전액 취소다. scope를 비우면 payment-svc가 원장 상태로 갈래를 고른다(APPROVED → 결제 후 일반 취소)
        });
      } catch (e) {
        const a = answerOfError(e);
        return a.kind === 'FAILED' ? { kind: 'FAILED', code: a.code, paymentId } : { kind: 'RETRY', code: a.code, paymentId };
      }
      const raw = typeof answer.result === 'string' ? answer.result.replace(/^CANCEL_RESULT_/, '') : '';
      if (raw === 'CANCELLED') return { kind: 'CANCELED', paymentId };
      if (raw === 'CANCEL_PENDING') return { kind: 'RETRY', code: 'CANCEL_PENDING', paymentId };
      if (raw === 'REJECTED') return { kind: 'FAILED', code: 'REJECTED', paymentId };
      if (raw === 'REFUND_ACCOUNT_REQUIRED') return { kind: 'FAILED', code: 'REFUND_ACCOUNT_REQUIRED', paymentId };
      return { kind: 'RETRY', code: 'UNKNOWN', paymentId };
    };
    try {
      return await (this.o.breaker ? this.o.breaker.run(once) : once());
    } catch (e) {
      const a = answerOfError(e);
      return a.kind === 'FAILED' ? { kind: 'FAILED', code: a.code } : { kind: 'RETRY', code: a.code };
    }
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때(local·ci)의 대역: 지금은 취소할 수 없다(늘 다시 보낸다). 보상 행은 지워지지 않는다 */
export const stubPaymentCompensator: PaymentCompensator = {
  cancel: async () => ({ kind: 'RETRY', code: 'UNAVAILABLE' }),
};

const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 결제 취소 포트를 만든다. PEAKET_PAYMENT_GRPC_ADDR가 있으면 gRPC 클라이언트, 없으면 local·ci만 대역과 경고 한 줄이다.
 * @throws Error 주소가 host:port 모양이 아님, 또는 local·ci가 아닌데 주소가 없음(시작 실패)
 */
export function paymentCompensatorFromEnv(
  env: Record<string, string | undefined>,
  o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker } = {},
): { compensator: PaymentCompensator; warnings: string[]; close(): void } {
  const address = (env[PAYMENT_COMPENSATION_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    if (!STUB_ENVS.has(env.PEAKET_ENV || 'prod')) {
      throw new Error(`${PAYMENT_COMPENSATION_GRPC_ADDR_ENV}가 없다(보상의 payment-svc CancelPayment. '다시 보내기' 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    }
    return { compensator: stubPaymentCompensator, warnings: [`${PAYMENT_COMPENSATION_GRPC_ADDR_ENV}가 없어 보상의 결제 취소는 늘 다시 보내는 대역을 쓴다(payment-svc에 취소가 생기지 않는다)`], close: () => {} };
  }
  const compensator = new GrpcPaymentCompensator({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}) });
  return { compensator, warnings: [], close: () => compensator.close() };
}
