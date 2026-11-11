// payment-svc 승인 명령 gRPC 클라이언트(PaymentService.ConfirmPayment, docs/api/proto/peaket/payment/v1/payment.proto, docs/architecture.md 시간 초과 표
// '승인 명령 gRPC' 데드라인 500ms [가정](BAT-029), docs/features/payment.md §2 'Saga 1단계의 첫 구현', BUILD_ORDER PRF-165).
// - 요청: order_id·attempt_id·pg(PgProvider)·payment_ref(toss{payment_key} | portone{payment_id, tx_id, payment_token})·amount(Money{krw})·
//   event_id(주문의 회차)·authenticated_at(결제 시도의 인증 시각, Timestamp)·attempt_no(결제 시도 순번, BUILD_ORDER PRF-180)·entry_opens_at(회차의 입장 시각, 있을 때만, BUILD_ORDER PRF-191).
//   시뮬레이터는 toss 칸을 쓴다 [가정](proto에 시뮬레이터 전용 칸이 없다).
// - 결과: 답을 받으면 ACCEPTED(결과가 UNSPECIFIED·UNKNOWN이면 받아 적었다고 볼 수 없어 REJECTED unexpected, 리뷰 낮음),
//   DEADLINE_EXCEEDED 4·UNAVAILABLE 14·차단기 열림이면 RETRYABLE, 그 밖은 REJECTED. 던지지 않는다.
// - 보내기 전 표시(ConfirmCallOptions.beforeSend, 리뷰 H1): 차단기가 들여보낸 뒤 실제로 보내기 바로 전에 부른다(차단기 열림·남은 시간 없음이면 부르지 않는다).
//   던지면 보내지 않고 그 오류를 그대로 던진다(차단기 실패로 세지 않는다).
// - 클라이언트는 플랫폼 createGrpcClient(부하 분산 프로필·추적·의존 로그·데드라인 상한), 차단기는 플랫폼 CircuitBreaker로 감싼다(grpc-identity.ts와 같은 꼴).
// 주소(PEAKET_PAYMENT_GRPC_ADDR, host:port)가 없으면 local·ci(PEAKET_ENV, 없으면 prod로 본다)만 '늘 접수' 대역을 쓰고 경고 한 줄을 남긴다.
// 그 밖의 환경은 주소 없이 시작하지 않는다(payment-svc의 ConfirmPayment 서버가 생기기 전의 대역, payment §2). 결제 참조·토큰은 로그·오류 글에 싣지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import type { ConfirmCallOptions, ConfirmCommand, ConfirmOutcome, ConfirmResultName, PaymentConfirms, PaymentPg } from '../domain/ports.js';

/** 주소 환경 값(host:port) */
export const PAYMENT_GRPC_ADDR_ENV = 'PEAKET_PAYMENT_GRPC_ADDR';
/**
 * 승인 명령 데드라인 상한 1,000ms [가정](architecture 시간 초과 표. domain/saga.ts CONFIRM_CALL_DEADLINE_MS와 같은 값).
 * BAT-029의 500ms는 100/s에서 3.2%가 넘겨 재시도 꼬리를 만들었다(BAT-031)
 */
export const CONFIRM_CAP_MS = 1_000;

/** 의존성 이름(span·의존 로그·차단기 지표) */
const DEPENDENCY = 'payment-svc';

/** 설명자를 읽는 선택지(grpc-identity.ts와 같다: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type PaymentPackage = { PaymentService: grpc.ServiceClientConstructor };

let loaded: PaymentPackage | undefined;
/** payment/v1 패키지 설명자(처음 한 번 읽는다) */
function paymentPackage(): PaymentPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

/** host:port를 나눈다. 모양이 틀리면 Error(시작 실패) */
function hostPortOf(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${PAYMENT_GRPC_ADDR_ENV}는 host:port여야 한다`);
  return { host: address.slice(0, at), port };
}

/** gRPC 서비스 오류(grpc-js ServiceError: code·details·metadata) */
function isServiceError(e: unknown): e is grpc.ServiceError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' && 'metadata' in e;
}

/** 결제사 → proto PgProvider 이름 */
const PG_PROVIDER: Readonly<Record<PaymentPg, string>> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };

/** proto ConfirmResult 이름에서 앞머리를 뗀 값들(모르는 값은 UNSPECIFIED로 본다) */
const RESULT_NAMES: ReadonlySet<string> = new Set<ConfirmResultName>(['APPROVED', 'ALREADY_APPROVED', 'IN_PROGRESS', 'DECLINED', 'WAITING_FOR_DEPOSIT', 'UNKNOWN', 'UNSPECIFIED']);

/** 답의 result 칸(CONFIRM_RESULT_*) → ConfirmResultName */
function resultNameOf(v: Record<string, unknown>): ConfirmResultName {
  const raw = typeof v.result === 'string' ? v.result.replace(/^CONFIRM_RESULT_/, '') : 'UNSPECIFIED';
  return RESULT_NAMES.has(raw) ? (raw as ConfirmResultName) : 'UNSPECIFIED';
}

/** 명령을 받아 적었다고 볼 수 없는 답(값 없음·결과 모름). ACCEPTED로 보지 않고 REJECTED unexpected다(결제 참조를 지우지 않는다, 리뷰 낮음) */
const UNCLEAR_RESULTS: ReadonlySet<ConfirmResultName> = new Set<ConfirmResultName>(['UNSPECIFIED', 'UNKNOWN']);

/** 받은 답 → 결과 */
export function answerOf(v: Record<string, unknown>): ConfirmOutcome {
  const result = resultNameOf(v);
  return UNCLEAR_RESULTS.has(result) ? { status: 'REJECTED', reason: 'unexpected' } : { status: 'ACCEPTED', result };
}

/** 보내기 전 표시가 던져 보내지 않았다는 표(차단기 안에서만 쓴다) */
const NOT_SENT = Symbol('not-sent');

/** 승인 명령 → ConfirmPaymentRequest(proto 칸 이름 그대로) */
function requestOf(c: ConfirmCommand): Record<string, unknown> {
  const r = c.refs;
  const paymentRef =
    r.pg === 'PORTONE' ? { portone: { payment_id: r.paymentId, tx_id: r.txId, payment_token: r.paymentToken } } : { toss: { payment_key: r.paymentKey } };
  const at = c.authenticatedAtMs;
  const entry = c.entryOpensAtMs;
  return {
    order_id: c.orderId,
    attempt_id: c.attemptId,
    pg: PG_PROVIDER[c.pg],
    ...paymentRef,
    amount: { krw: c.amount },
    event_id: c.eventId,
    attempt_no: c.attemptNo,
    ...(at !== undefined ? { authenticated_at: { seconds: Math.floor(at / 1000), nanos: (at % 1000) * 1_000_000 } } : {}),
    ...(entry !== undefined ? { entry_opens_at: { seconds: Math.floor(entry / 1000), nanos: (entry % 1000) * 1_000_000 } } : {}),
    ...(c.virtualAccountAllowed !== undefined ? { virtual_account_allowed: c.virtualAccountAllowed } : {}),
  };
}

export interface GrpcPaymentConfirmOptions {
  /** host:port */
  address: string;
  /** 설정의 grpcLbProfile(기본 service) */
  profile?: GrpcLbProfile;
  /** 차단기(의존 이름 payment-svc). 열려 있으면 부르지 않고 RETRYABLE circuit_open */
  breaker?: CircuitBreaker;
}

/**
 * 승인 명령 클라이언트. confirm 차례: (차단기) → ConfirmPayment(요청, 데드라인 = 지금 + min(c.deadlineMs, 200)) → 답이면 ACCEPTED(result = ConfirmResult 이름에서 CONFIRM_RESULT_를 뗀 것)
 * → gRPC 오류는 confirmOutcomeOf(코드). 다시 묻지 않는다(다시 보내기는 실행기의 다시 하기다).
 * @throws Error 주소가 host:port 모양이 아님(생성 때, 시작 실패)
 */
export class GrpcPaymentConfirms implements PaymentConfirms {
  readonly #client: grpc.Client & { ConfirmPayment: Unary };

  constructor(readonly o: GrpcPaymentConfirmOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: DEPENDENCY,
      timeoutCapMs: CONFIRM_CAP_MS,
    }) as unknown as grpc.Client & { ConfirmPayment: Unary };
  }

  async confirm(c: ConfirmCommand, o: ConfirmCallOptions = {}): Promise<ConfirmOutcome> {
    const ms = Math.min(CONFIRM_CAP_MS, Math.max(1, Math.floor(c.deadlineMs)));
    const request = requestOf(c);
    // 보내기 전 표시(beforeSend)가 던지면 보내지 않고 그 오류를 밖에서 그대로 던진다(차단기에는 실패로 세지 않는다)
    let hook: { error: unknown } | undefined;
    const once = async (): Promise<Record<string, unknown> | typeof NOT_SENT> => {
      if (o.beforeSend) {
        try {
          await o.beforeSend();
        } catch (error) {
          hook = { error };
          return NOT_SENT;
        }
      }
      // 데드라인은 표시를 적은 뒤부터 잰다(DB 한 번이 승인 명령의 200ms를 먹지 않게)
      const deadline = new Date(Date.now() + ms);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.ConfirmPayment(request, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    };
    let v: Record<string, unknown> | typeof NOT_SENT;
    try {
      v = await (this.o.breaker ? this.o.breaker.run(once) : once());
    } catch (e) {
      if (hook) throw hook.error;
      return outcomeOfError(e);
    }
    if (hook) throw hook.error;
    return answerOf(v as Record<string, unknown>);
  }

  close(): void {
    this.#client.close();
  }
}

/** 부른 것이 던진 것 → 결과. 차단기 열림(503 dependency-unavailable)은 circuit_open, 남은 시간 없음(504)은 deadline, 동시 호출 상한(429)은 unavailable(정함), gRPC 오류는 코드로, 그 밖은 unexpected */
function outcomeOfError(e: unknown): Exclude<ConfirmOutcome, { status: 'ACCEPTED' }> {
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return { status: 'RETRYABLE', reason: 'circuit_open' };
    if (e.slug === 'deadline-exceeded') return { status: 'RETRYABLE', reason: 'deadline' };
    if (e.slug === 'server-busy') return { status: 'RETRYABLE', reason: 'unavailable' };
    return { status: 'REJECTED', reason: 'unexpected' };
  }
  return isServiceError(e) ? confirmOutcomeOf(e.code) : { status: 'REJECTED', reason: 'unexpected' };
}

/** gRPC 상태 코드 → 소문자 이름(DEADLINE_EXCEEDED·UNAVAILABLE은 다시 보내기라 여기 없어도 된다). 결제창 준비 클라이언트도 같은 표를 쓴다 */
export const STATUS_NAMES: Readonly<Record<number, string>> = {
  1: 'cancelled',
  2: 'unknown',
  3: 'invalid_argument',
  5: 'not_found',
  6: 'already_exists',
  7: 'permission_denied',
  8: 'resource_exhausted',
  9: 'failed_precondition',
  10: 'aborted',
  11: 'out_of_range',
  12: 'unimplemented',
  13: 'internal',
  15: 'data_loss',
  16: 'unauthenticated',
};

/**
 * gRPC 상태 코드 → 결과: DEADLINE_EXCEEDED 4 → RETRYABLE deadline, UNAVAILABLE 14 → RETRYABLE unavailable,
 * 그 밖 → REJECTED(상태 이름 소문자, 예 3 invalid_argument·9 failed_precondition·7 permission_denied·12 unimplemented, 모르는 코드는 unexpected)
 */
export function confirmOutcomeOf(grpcCode: number): Exclude<ConfirmOutcome, { status: 'ACCEPTED' }> {
  if (grpcCode === grpc.status.DEADLINE_EXCEEDED) return { status: 'RETRYABLE', reason: 'deadline' };
  if (grpcCode === grpc.status.UNAVAILABLE) return { status: 'RETRYABLE', reason: 'unavailable' };
  return { status: 'REJECTED', reason: STATUS_NAMES[grpcCode] ?? 'unexpected' };
}

/** 주소가 없을 때(local·ci)의 대역: 보내기 전 표시를 부른 뒤 늘 { ACCEPTED, IN_PROGRESS }(payment-svc 서버가 생기기 전, payment §2) */
export const acceptingPaymentConfirms: PaymentConfirms = {
  confirm: async (_c, o) => {
    await o?.beforeSend?.();
    return { status: 'ACCEPTED', result: 'IN_PROGRESS' };
  },
};

/** 주소 없이 대역으로 뜰 수 있는 환경(로컬·CI). 그 밖(demo·staging·prod)은 주소가 없으면 시작하지 않는다 */
const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 승인 명령 포트를 만든다. PEAKET_PAYMENT_GRPC_ADDR가 있으면 gRPC 클라이언트(o.breaker로 감싼다),
 * 없으면(빈 글 포함) PEAKET_ENV가 local·ci일 때만 '늘 접수' 대역과 warnings 한 줄. PEAKET_ENV가 없으면 prod로 본다.
 * @throws Error 주소가 host:port 모양이 아님, 또는 local·ci가 아닌데 주소가 없음(시작 실패). main.ts는 Saga 실행기를 켤 때(purchase DB가 있을 때)만 부른다
 */
export function paymentConfirmsFromEnv(
  env: Record<string, string | undefined>,
  o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker } = {},
): { confirms: PaymentConfirms; warnings: string[]; close(): void } {
  const address = (env[PAYMENT_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    const peaketEnv = env.PEAKET_ENV || 'prod';
    if (!STUB_ENVS.has(peaketEnv)) {
      throw new Error(`${PAYMENT_GRPC_ADDR_ENV}가 없다(Saga 1단계의 승인 명령 payment-svc ConfirmPayment. '늘 접수' 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    }
    return {
      confirms: acceptingPaymentConfirms,
      warnings: [`${PAYMENT_GRPC_ADDR_ENV}가 없어 승인 명령은 늘 접수(IN_PROGRESS)로 답하는 대역을 쓴다(결제사 승인을 보내지 않는다)`],
      close: () => {},
    };
  }
  const confirms = new GrpcPaymentConfirms({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}) });
  return { confirms, warnings: [], close: () => confirms.close() };
}
