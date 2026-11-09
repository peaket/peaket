// payment-svc 결제창 준비 gRPC 클라이언트(PaymentService.PrepareCheckout, docs/features/payment.md §2 '결제 시도 시작의 첫 구현', docs/api/guidelines.md §5, BUILD_ORDER PRF-191).
// grpc-payment-confirm.ts와 같은 꼴이다(같은 payment/v1 설명자, 같은 주소 PEAKET_PAYMENT_GRPC_ADDR). 이 호출은 결제사를 부르지 않는다.
// - 요청: 주문·시도·회차·금액·주문명·수단과 선택 칸(가상계좌 허용, 입장 시각, 재생의 pinned_pg). 구매자 키는 보내지 않는다(payment-svc가 CSPRNG 값을 만든다, ASVS 11.5.1).
// - 데드라인 상한 300ms [가정]. 이 호출 안에서는 다시 묻지 않는다. 던지지 않는다(결과는 CheckoutOutcome).
// - 답의 주문·금액이 요청과 다르거나, 재생으로 고정한 결제사와 다르거나, 결제사와 값 칸이 어긋나면 값을 쓰지 않는다(MISCONFIGURED bad_answer, 리뷰 고침 M3).
// - 차단기는 실제 장애만 센다(결제사를 고르지 못했다는 업무 답은 세지 않는다, 리뷰 고침 H1). 파드당 동시 호출 상한을 둔다(리뷰 고침 L8).
// 주소가 없으면 local·ci만 시뮬레이터 값 대역을 쓰고 경고 한 줄을 남긴다. 그 밖의 환경은 주소 없이 시작하지 않는다. 결제창 값은 로그·오류 글에 싣지 않는다.
import { randomBytes } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, isBreakerFailure, ProblemError } from '@peaket/platform';
import { PREPARE_CHECKOUT_DEADLINE_MS } from '../domain/payment-attempt.js';
import type { CheckoutOutcome, CheckoutValues, PaymentCheckouts, PaymentPg, PrepareCheckoutQuery } from '../domain/ports.js';
import { PAYMENT_GRPC_ADDR_ENV, STATUS_NAMES } from './grpc-payment-confirm.js';

/** 데드라인 상한(ms) */
export const PREPARE_CHECKOUT_CAP_MS = PREPARE_CHECKOUT_DEADLINE_MS;
/** 차단기의 의존 이름(승인 명령·결과 당기기·입금 안내 차단기와 따로다) */
export const PAYMENT_CHECKOUT_BREAKER = 'payment-svc-checkout';
/**
 * PrepareCheckout의 파드당 동시 호출 상한 100건 [가정](차단기의 벌크헤드, 리뷰 고침 L8). 결제 시도 피크는 결제 접수 피크(300 TPS)와 같은 자릿수라 호출이 데드라인 300ms [가정]을
 * 다 써도 서비스 전체 동시 90건이다. 한 파드가 혼자 받아도 넘지 않고, payment-svc가 멈췄을 때 기다리는 호출이 파드 자원을 다 쓰지 못하게 막는다. 넘으면 부르지 않고 503 pg-unavailable이다
 */
export const PREPARE_CHECKOUT_MAX_CONCURRENT = 100;

/** payment-svc가 결제사를 고르지 못했을 때 UNAVAILABLE에 싣는 글(살아서 답한 업무 답이다) */
const PG_UNAVAILABLE_DETAILS = 'pg-unavailable';
/** payment-svc가 새 결제 일시 정지일 때 FAILED_PRECONDITION에 싣는 글(BUILD_ORDER PRF-201) */
const NEW_PAYMENT_PAUSED_DETAILS = 'new-payment-paused';
const DEPENDENCY = 'payment-svc';
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

function hostPortOf(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${PAYMENT_GRPC_ADDR_ENV}는 host:port여야 한다`);
  return { host: address.slice(0, at), port };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isServiceError = (e: unknown): e is grpc.ServiceError => isObject(e) && typeof e.code === 'number' && 'metadata' in e;

const PG_PROVIDER: Readonly<Record<PaymentPg, string>> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };
const PG_OF: ReadonlyMap<unknown, PaymentPg> = new Map([
  ['PG_PROVIDER_TOSS', 'TOSS'],
  ['PG_PROVIDER_PORTONE', 'PORTONE'],
  ['PG_PROVIDER_SIMULATOR', 'SIMULATOR'],
]);

const timestampOf = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

/** 질의 → PrepareCheckoutRequest(proto 칸 이름). 구매자 키는 싣지 않는다 */
export function prepareCheckoutRequestOf(q: PrepareCheckoutQuery): Record<string, unknown> {
  return {
    order_kind: 'ORDER_KIND_TICKET',
    order_id: q.orderId,
    attempt_id: q.attemptId,
    event_id: q.eventId,
    amount: { krw: q.amount },
    order_name: q.orderName,
    pay_method: q.payMethod ?? '',
    ...(q.virtualAccountAllowed !== undefined ? { virtual_account_allowed: q.virtualAccountAllowed } : {}),
    ...(q.entryOpensAtMs !== undefined ? { entry_opens_at: timestampOf(q.entryOpensAtMs) } : {}),
    ...(q.pinnedPg !== undefined ? { pinned_pg: PG_PROVIDER[q.pinnedPg] } : {}),
  };
}

const BAD_ANSWER: CheckoutOutcome = { status: 'MISCONFIGURED', reason: 'bad_answer' };

/** 빈 글이 아닌 글 칸들을 읽는다(하나라도 없거나 비었으면 undefined) */
function textsOf<K extends string>(o: Record<string, unknown>, names: readonly K[]): Record<K, string> | undefined {
  const out = {} as Record<K, string>;
  for (const n of names) {
    const v = o[n];
    if (typeof v !== 'string' || v.length === 0) return undefined;
    out[n] = v;
  }
  return out;
}

/** Money 칸 → 원(양의 안전한 정수가 아니면 undefined) */
function krwOf(m: unknown): number | undefined {
  const v = isObject(m) ? m.krw : undefined;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

function tossValuesOf(m: Record<string, unknown>, orderId: string): CheckoutValues | undefined {
  const t = textsOf(m, ['client_key', 'customer_key', 'order_id', 'order_name', 'success_url', 'fail_url']);
  const amount = krwOf(m.amount);
  if (!t || amount === undefined || t.order_id !== orderId) return undefined;
  return { shape: 'TOSS', clientKey: t.client_key, customerKey: t.customer_key, orderId: t.order_id, orderName: t.order_name, amount, successUrl: t.success_url, failUrl: t.fail_url };
}

function portoneValuesOf(m: Record<string, unknown>, orderId: string): CheckoutValues | undefined {
  const t = textsOf(m, ['store_id', 'channel_key', 'payment_id', 'order_name', 'currency', 'redirect_url']);
  const totalAmount = krwOf(m.total_amount);
  const custom = isObject(m.custom_data) ? m.custom_data.order_id : undefined;
  if (!t || totalAmount === undefined || custom !== orderId) return undefined;
  return { shape: 'PORTONE', storeId: t.store_id, channelKey: t.channel_key, paymentId: t.payment_id, orderName: t.order_name, totalAmount, currency: t.currency, redirectUrl: t.redirect_url, customData: { orderId } };
}

const amountOf = (c: CheckoutValues): number => (c.shape === 'TOSS' ? c.amount : c.totalAmount);

/** 받은 답(proto 칸 이름) → 결과. 결제사와 값 칸이 어긋나거나, 칸이 비었거나, 답의 주문·금액이 요청과 다르거나, 재생으로 고정한 결제사와 다르면 값을 쓰지 않는다 */
export function checkoutAnswerOf(v: Record<string, unknown>, q: Pick<PrepareCheckoutQuery, 'orderId' | 'amount' | 'pinnedPg'>): CheckoutOutcome {
  const pg = PG_OF.get(v.pg);
  if (!pg || (q.pinnedPg !== undefined && pg !== q.pinnedPg)) return BAD_ANSWER;
  const field = pg.toLowerCase();
  const message = v[field];
  if (v.checkout !== field || !isObject(message)) return BAD_ANSWER;
  const checkout = pg === 'PORTONE' ? portoneValuesOf(message, q.orderId) : tossValuesOf(message, q.orderId);
  if (!checkout || amountOf(checkout) !== q.amount) return BAD_ANSWER;
  const allowed = Array.isArray(v.allowed_pay_methods) ? v.allowed_pay_methods.filter((m): m is string => typeof m === 'string') : [];
  const due = isObject(v.deposit_due_at) && typeof v.deposit_due_at.seconds === 'number' ? v.deposit_due_at.seconds * 1000 + Math.floor(Number(v.deposit_due_at.nanos ?? 0) / 1_000_000) : undefined;
  return { status: 'OK', pg, switched: v.switched === true, checkout, allowedPayMethods: allowed, ...(due !== undefined ? { depositDueAtMs: due } : {}) };
}

/**
 * gRPC 상태 코드와 글 → 결과: UNAVAILABLE(글 pg-unavailable이면 결제사를 고르지 못한 것)·DEADLINE_EXCEEDED → PG_UNAVAILABLE,
 * INVALID_ARGUMENT 글이 pay_method로 끝나면 PAY_METHOD_INVALID, FAILED_PRECONDITION 글이 new-payment-paused면 NEW_PAYMENT_PAUSED(BUILD_ORDER PRF-201), 그 밖 → MISCONFIGURED(상태 이름 소문자, 모르는 코드는 unexpected)
 */
export function checkoutFailureOf(grpcCode: number, details: string): Exclude<CheckoutOutcome, { status: 'OK' }> {
  if (grpcCode === grpc.status.FAILED_PRECONDITION && details === NEW_PAYMENT_PAUSED_DETAILS) return { status: 'NEW_PAYMENT_PAUSED' };
  if (grpcCode === grpc.status.DEADLINE_EXCEEDED) return { status: 'PG_UNAVAILABLE', reason: 'deadline' };
  if (grpcCode === grpc.status.UNAVAILABLE) return { status: 'PG_UNAVAILABLE', reason: details === PG_UNAVAILABLE_DETAILS ? 'pg_unavailable' : 'unavailable' };
  if (grpcCode === grpc.status.INVALID_ARGUMENT && details.endsWith('pay_method')) return { status: 'PAY_METHOD_INVALID' };
  return { status: 'MISCONFIGURED', reason: STATUS_NAMES[grpcCode] ?? 'unexpected' };
}

/** 부른 것이 던진 것 → 결과. 차단기 열림(503)은 circuit_open, 남은 시간 없음(504)은 deadline, 동시 호출 상한(429)은 unavailable */
function outcomeOfError(e: unknown): Exclude<CheckoutOutcome, { status: 'OK' }> {
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return { status: 'PG_UNAVAILABLE', reason: 'circuit_open' };
    if (e.slug === 'deadline-exceeded') return { status: 'PG_UNAVAILABLE', reason: 'deadline' };
    if (e.slug === 'server-busy') return { status: 'PG_UNAVAILABLE', reason: 'unavailable' };
    return { status: 'MISCONFIGURED', reason: 'unexpected' };
  }
  return isServiceError(e) ? checkoutFailureOf(e.code, e.details ?? '') : { status: 'MISCONFIGURED', reason: 'unexpected' };
}

/**
 * 결제창 준비 차단기의 실패 분류: UNAVAILABLE 글 pg-unavailable은 payment-svc가 살아서 답한 업무 답(이 회차에 쓸 결제사·채널이 없음)이라 세지 않는다(리뷰 고침 H1).
 * 세면 어느 회차 하나의 설정 때문에 차단기가 열려 다른 회차의 정상 요청까지 막는다. 그 밖은 플랫폼 기본 분류다(데드라인·연결 실패·그 밖의 UNAVAILABLE은 실패).
 * 새 결제 일시 정지(FAILED_PRECONDITION 글 new-payment-paused)도 업무 답이고 기본 분류가 세지 않는다(BUILD_ORDER PRF-201)
 */
export function isCheckoutBreakerFailure(err: unknown): boolean {
  if (isServiceError(err) && err.code === grpc.status.UNAVAILABLE && err.details === PG_UNAVAILABLE_DETAILS) return false;
  return isBreakerFailure(err);
}

/** 결제창 준비 차단기의 설정(main.ts가 service·registry·logger와 합쳐 CircuitBreaker를 만든다) */
export const PAYMENT_CHECKOUT_BREAKER_OPTIONS = Object.freeze({
  dependency: PAYMENT_CHECKOUT_BREAKER,
  isFailure: isCheckoutBreakerFailure,
  maxConcurrent: PREPARE_CHECKOUT_MAX_CONCURRENT,
});

export interface GrpcPaymentCheckoutsOptions {
  address: string;
  profile?: GrpcLbProfile;
  breaker?: CircuitBreaker;
}

/** 결제창 준비 클라이언트. 차단기(있으면) → PrepareCheckout(데드라인 = 지금 + min(q.deadlineMs, 300)). 다시 묻지 않고 던지지 않는다 */
export class GrpcPaymentCheckouts implements PaymentCheckouts {
  readonly #client: grpc.Client & { PrepareCheckout: Unary };

  /** @throws Error 주소가 host:port 모양이 아님(시작 실패) */
  constructor(readonly o: GrpcPaymentCheckoutsOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: DEPENDENCY,
      timeoutCapMs: PREPARE_CHECKOUT_CAP_MS,
    }) as unknown as grpc.Client & { PrepareCheckout: Unary };
  }

  async prepare(q: PrepareCheckoutQuery): Promise<CheckoutOutcome> {
    const ms = Math.min(PREPARE_CHECKOUT_CAP_MS, Math.max(1, Math.floor(q.deadlineMs)));
    const request = prepareCheckoutRequestOf(q);
    const once = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.PrepareCheckout(request, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    try {
      return checkoutAnswerOf(await (this.o.breaker ? this.o.breaker.run(once) : once()), q);
    } catch (e) {
      return outcomeOfError(e);
    }
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때(local·ci)의 대역: 시뮬레이터 값을 돌려준다(payment-svc를 부르지 않고 결제사도 부르지 않는다) */
export const simulatorPaymentCheckouts: PaymentCheckouts = {
  prepare: async (q) => {
    const url = `http://localhost:3000/booking/${encodeURIComponent(q.eventId)}/checkout/return?order=${encodeURIComponent(q.orderId)}&pg=SIMULATOR`;
    return {
      status: 'OK',
      pg: 'SIMULATOR',
      switched: false,
      checkout: { shape: 'TOSS', clientKey: 'test_ck_local_simulator', customerKey: randomBytes(16).toString('base64url'), orderId: q.orderId, orderName: q.orderName, amount: q.amount, successUrl: url, failUrl: url },
      allowedPayMethods: ['CARD'],
    };
  },
};

const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 결제창 준비 포트를 만든다. PEAKET_PAYMENT_GRPC_ADDR가 있으면 gRPC 클라이언트(o.breaker로 감싼다),
 * 없으면 PEAKET_ENV가 local·ci일 때만 시뮬레이터 대역과 warnings 한 줄. PEAKET_ENV가 없으면 prod로 본다.
 * @throws Error 주소 모양이 틀림, 또는 local·ci가 아닌데 주소가 없음(시작 실패)
 */
export function paymentCheckoutsFromEnv(env: Record<string, string | undefined>, o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker } = {}): { checkouts: PaymentCheckouts; warnings: string[]; close(): void } {
  const address = (env[PAYMENT_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    const peaketEnv = env.PEAKET_ENV || 'prod';
    if (!STUB_ENVS.has(peaketEnv)) throw new Error(`${PAYMENT_GRPC_ADDR_ENV}가 없다(결제 시도의 결제창 준비 payment-svc PrepareCheckout. 시뮬레이터 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    return { checkouts: simulatorPaymentCheckouts, warnings: [`${PAYMENT_GRPC_ADDR_ENV}가 없어 결제창 준비는 시뮬레이터 값을 돌려주는 대역을 쓴다`], close: () => {} };
  }
  const checkouts = new GrpcPaymentCheckouts({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}) });
  return { checkouts, warnings: [], close: () => checkouts.close() };
}
