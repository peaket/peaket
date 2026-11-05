// payment-svc 결제 결과 당기기 gRPC 클라이언트(PaymentService.BatchGetPayments, docs/api/proto/peaket/payment/v1/payment.proto, ADR-0140 결정 2·3,
// BUILD_ORDER PRF-171 설계 4). grpc-ticket-issue.ts·grpc-payment-confirm.ts와 같은 꼴이다(같은 payment/v1 설명자, 같은 주소 PEAKET_PAYMENT_GRPC_ADDR).
// - 요청: order_ids(1~100건 [가정]. 넘으면 payment-svc가 INVALID_ARGUMENT라 부르기 전에 RangeError). 읽기만 하므로 멱등 키가 없다. 결제사는 부르지 않는다(payment-svc 몫).
// - 답: payments[](OrderPaymentState) → 도메인 OrderPaymentState(orderPaymentStatesOf: 칸 이름을 바꾸고 enum 앞머리 PAYMENT_STATUS_·PG_PROVIDER_·FAILURE_CATEGORY_를 떼며,
//   Money.krw → amount, Timestamp approved_at → approvedAtMs, int64 event_seq → eventSeq). 기록 없는 주문은 답에 없다(부르는 쪽이 다음 점검에서 다시 묻는다).
// - 데드라인 500ms [가정](ADR-0140 결정 3, domain PAYMENT_PULL_DEADLINE_MS와 같은 값). 다시 묻지 않는다(다시 묻기는 실행기의 다음 점검, 5초 [가정]).
// - 실패는 모두 PaymentPullCallError(code)로 던진다: gRPC 오류는 상태 이름(paymentPullCodeOf, 모르는 번호는 UNKNOWN), 차단기 열림(503 dependency-unavailable)은
//   CIRCUIT_OPEN(부르지 않는다), 남은 시간 없음(504 deadline-exceeded)은 DEADLINE_EXCEEDED, 동시 호출 상한(429 server-busy)은 RESOURCE_EXHAUSTED,
//   답 모양이 틀림은 BAD_ANSWER, 그 밖의 예외는 UNKNOWN.
// - 클라이언트는 플랫폼 createGrpcClient(부하 분산 프로필·추적·의존 로그·데드라인 상한 500ms, 의존 이름 payment-svc), 차단기는 플랫폼 CircuitBreaker(의존 이름
//   payment-svc-batch: ConfirmPayment 차단기 payment-svc와 따로 둬 당기기 실패가 승인 명령 길을 열지 않게, 설계 4)로 감싼다.
// 주소(PEAKET_PAYMENT_GRPC_ADDR, host:port)가 없으면 local·ci(PEAKET_ENV, 없으면 prod로 본다)만 '기록 없음' 대역(늘 빈 답)을 쓰고 시작 경고 한 줄을 남긴다.
// 그 밖의 환경은 주소 없이 시작하지 않는다(payment-svc BatchGetPayments 서버는 PRF-180 무렵. ConfirmPayment와 같은 규칙). 주문 ID·금액은 로그·오류 글에 싣지 않는다.
// 구현에서 정한 것(정본에 없다):
// - 답의 payments가 배열이 아니거나, 항목이 객체가 아니거나 order_id가 글이 아니면 BAD_ANSWER로 묶음 전체를 실패로 본다(어느 주문의 답인지 모른다).
//   그 밖의 칸은 검사하지 않고 옮긴다(모르는 상태는 UNSPECIFIED, 모르는 결제사·실패 범주는 칸 없음, 금액·순번이 수가 아니면 NaN, event_key가 글이 아니면 빈 글.
//   반영할 수 있는 모양인지는 도메인 paymentStateToResultEvent가 보고 그 주문만 IGNORE MALFORMED다).
// - 오류의 원인(cause)에는 받은 오류를 그대로 달아 두되 글(message)에는 코드만 싣는다. 데드라인은 1ms 이상, 상한 500ms로 자른다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import { PAYMENT_LEDGER_STATUSES, PAYMENT_PULL_BATCH, type OrderPaymentState, type PaymentLedgerStatus, type PaymentPullFailureCode } from '../domain/payment-pull.js';
import { PAYMENT_FAILURE_CATEGORIES, type PaymentFailureCategory } from '../domain/payment-result.js';
import { PaymentPullCallError, type PaymentPg, type PaymentResultReader } from '../domain/ports.js';
import { GRPC_STATUS_NAMES } from '../domain/ticket-issue.js';
import { PAYMENT_GRPC_ADDR_ENV } from './grpc-payment-confirm.js';

/** BatchGetPayments 데드라인 상한 500ms [가정](ADR-0140 결정 3. domain/payment-pull.ts PAYMENT_PULL_DEADLINE_MS와 같은 값) */
export const PAYMENT_PULL_CAP_MS = 500;
/** 당기기 차단기의 의존 이름(차단기 지표·로그. ConfirmPayment의 payment-svc 차단기와 따로, 설계 4). main.ts가 CircuitBreaker({ dependency })로 만든다 */
export const PAYMENT_PULL_BREAKER = 'payment-svc-batch';

/** 클라이언트의 의존 이름(span·의존 로그. 승인 명령 클라이언트와 같은 payment-svc) */
const DEPENDENCY = 'payment-svc';

/** 설명자를 읽는 선택지(grpc-payment-confirm.ts와 같다: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type PaymentPackage = { PaymentService: grpc.ServiceClientConstructor };

let loaded: PaymentPackage | undefined;
/** payment/v1 패키지 설명자(처음 한 번 읽는다. grpc-payment-confirm.ts와 같은 것) */
function paymentPackage(): PaymentPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: PaymentPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

/** host:port를 나눈다. 모양이 틀리면 Error(시작 실패. grpc-payment-confirm.ts와 같다) */
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

/** 부른 것이 던진 것 → 실패 코드(머리 주석의 규칙. 플랫폼 ProblemError 가운데 셋이 아닌 것과 gRPC가 아닌 예외는 UNKNOWN) */
function failureCodeOf(e: unknown): PaymentPullFailureCode {
  if (e instanceof PaymentPullCallError) return e.code;
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return 'CIRCUIT_OPEN';
    if (e.slug === 'deadline-exceeded') return 'DEADLINE_EXCEEDED';
    if (e.slug === 'server-busy') return 'RESOURCE_EXHAUSTED';
    return 'UNKNOWN';
  }
  return isServiceError(e) ? paymentPullCodeOf(e.code) : 'UNKNOWN';
}

export interface GrpcPaymentResultReaderOptions {
  /** host:port(PEAKET_PAYMENT_GRPC_ADDR, 승인 명령과 같은 주소) */
  address: string;
  /** 설정의 grpcLbProfile(기본 service) */
  profile?: GrpcLbProfile;
  /** 차단기(의존 이름 payment-svc-batch). 열려 있으면 부르지 않고 PaymentPullCallError CIRCUIT_OPEN */
  breaker?: CircuitBreaker;
}

/**
 * 당기기 클라이언트. batchGet 차례: (빈 배열이면 []) → (차단기) → BatchGetPayments(order_ids, 데드라인 = 지금 + min(o.deadlineMs, 500ms))
 * → 답의 payments → OrderPaymentState[](orderPaymentStatesOf) → 실패는 PaymentPullCallError(머리 주석의 코드).
 * 생성자가 주소(host:port)를 나누고 클라이언트를 만든다(연결은 첫 호출 때).
 * @throws Error 주소가 host:port 모양이 아님(생성 때, 시작 실패)
 */
export class GrpcPaymentResultReader implements PaymentResultReader {
  readonly #client: grpc.Client & { BatchGetPayments: Unary };

  constructor(readonly o: GrpcPaymentResultReaderOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: DEPENDENCY,
      timeoutCapMs: PAYMENT_PULL_CAP_MS,
    }) as unknown as grpc.Client & { BatchGetPayments: Unary };
  }

  /**
   * @throws RangeError orderIds가 PAYMENT_PULL_BATCH(100)건을 넘음(부르지 않는다)
   * @throws PaymentPullCallError 호출 실패(머리 주석의 코드)
   */
  async batchGet(orderIds: readonly string[], o: { readonly deadlineMs?: number } = {}): Promise<OrderPaymentState[]> {
    if (orderIds.length === 0) return [];
    if (orderIds.length > PAYMENT_PULL_BATCH) throw new RangeError(`BatchGetPayments 한 번에 묻는 주문은 ${PAYMENT_PULL_BATCH}건까지다: ${orderIds.length}건`);
    const asked = o.deadlineMs;
    const ms = Math.min(PAYMENT_PULL_CAP_MS, Math.max(1, Math.floor(typeof asked === 'number' && Number.isFinite(asked) ? asked : PAYMENT_PULL_CAP_MS)));
    const request = { order_ids: [...orderIds] };
    const once = (): Promise<Record<string, unknown>> => {
      // 데드라인은 차단기가 들여보낸 뒤부터 잰다
      const deadline = new Date(Date.now() + ms);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.BatchGetPayments(request, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    };
    let v: Record<string, unknown>;
    try {
      v = await (this.o.breaker ? this.o.breaker.run(once) : once());
    } catch (e) {
      throw new PaymentPullCallError(failureCodeOf(e), e);
    }
    return orderPaymentStatesOf(v);
  }

  /** gRPC 채널을 닫는다(SIGTERM, 당기기 실행기를 멈춘 뒤) */
  close(): void {
    this.#client.close();
  }
}

/**
 * gRPC 상태 번호 → 실패 코드(GRPC_STATUS_NAMES의 이름). 0(OK)·모르는 번호는 UNKNOWN [정함: 실패로 온 OK는 뜻을 모른다. ticketIssueCodeOf와 같은 규칙].
 * 예: 3 → INVALID_ARGUMENT, 4 → DEADLINE_EXCEEDED, 14 → UNAVAILABLE
 */
export function paymentPullCodeOf(grpcCode: number): PaymentPullFailureCode {
  if (!Number.isInteger(grpcCode) || grpcCode < 1 || grpcCode >= GRPC_STATUS_NAMES.length) return 'UNKNOWN';
  return GRPC_STATUS_NAMES[grpcCode] as PaymentPullFailureCode;
}

/** enum 이름(enums: String) → 앞머리를 뗀 값. 모르는 이름(번호로 온 모르는 enum 포함)은 지도에 없다 */
const STATUS_OF: ReadonlyMap<string, PaymentLedgerStatus> = new Map(PAYMENT_LEDGER_STATUSES.map((s) => [`PAYMENT_STATUS_${s}`, s]));
const PG_OF: ReadonlyMap<string, PaymentPg> = new Map((['TOSS', 'PORTONE', 'SIMULATOR'] as const).map((p) => [`PG_PROVIDER_${p}`, p]));
const FAILURE_OF: ReadonlyMap<string, PaymentFailureCategory> = new Map(PAYMENT_FAILURE_CATEGORIES.map((f) => [`FAILURE_CATEGORY_${f}`, f]));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** int64 칸(longs: Number면 수, 다른 선택지면 글일 수 있다) → 수. 그 밖은 NaN */
function int64Of(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

/** Timestamp{seconds, nanos} → epoch ms. 칸이 없으면(null·undefined) undefined, 모양이 틀리면 NaN(도메인이 MALFORMED로 본다) */
function timestampMsOf(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (!isObject(v)) return Number.NaN;
  const seconds = int64Of(v.seconds ?? 0);
  const nanos = typeof v.nanos === 'number' ? v.nanos : 0;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

/**
 * 받은 답(BatchGetPaymentsResponse, proto 칸 이름 그대로) → 주문별 결제 원장 상태(머리 주석 '구현에서 정한 것'의 옮기기 규칙).
 * @throws PaymentPullCallError BAD_ANSWER: payments가 배열이 아님, 항목이 객체가 아니거나 order_id가 글이 아님
 */
export function orderPaymentStatesOf(v: Record<string, unknown>): OrderPaymentState[] {
  const payments: unknown = isObject(v) ? v.payments : undefined;
  if (!Array.isArray(payments)) throw new PaymentPullCallError('BAD_ANSWER');
  return payments.map((p: unknown): OrderPaymentState => {
    if (!isObject(p) || typeof p.order_id !== 'string') throw new PaymentPullCallError('BAD_ANSWER');
    const pg = typeof p.pg === 'string' ? PG_OF.get(p.pg) : undefined;
    const approvedAtMs = timestampMsOf(p.approved_at);
    const failureCategory = typeof p.failure_category === 'string' ? FAILURE_OF.get(p.failure_category) : undefined;
    // 칸을 하나씩 골라 옮긴다(받은 객체를 펼치지 않는다). 칸이 없는 값은 싣지 않는다
    return {
      orderId: p.order_id,
      paymentId: typeof p.payment_id === 'string' ? p.payment_id : '',
      ...(pg !== undefined ? { pg } : {}),
      status: (typeof p.status === 'string' ? STATUS_OF.get(p.status) : undefined) ?? 'UNSPECIFIED',
      amount: isObject(p.amount) ? int64Of(p.amount.krw) : Number.NaN,
      ...(approvedAtMs !== undefined ? { approvedAtMs } : {}),
      ...(failureCategory !== undefined ? { failureCategory } : {}),
      eventKey: typeof p.event_key === 'string' ? p.event_key : '',
      eventSeq: int64Of(p.event_seq),
    };
  });
}

/**
 * 주소가 없을 때(local·ci)의 '기록 없음' 대역: 늘 빈 답이다(payment-svc BatchGetPayments 서버가 생기기 전, PRF-180 무렵).
 * 당기기는 아무것도 반영하지 않고 다음 점검을 이어 가며, 승인 명령을 보낸 지 10분 [가정]이 지나면 기록 없음 SEV2 한 줄을 남긴다(결과는 사건 길로만 온다)
 */
export const emptyPaymentResultReader: PaymentResultReader = {
  batchGet: async () => [],
};

/** 주소 없이 대역으로 뜰 수 있는 환경(로컬·CI). 그 밖(demo·staging·prod)은 주소가 없으면 시작하지 않는다 */
export const PAYMENT_PULL_STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 당기기 포트를 만든다. PEAKET_PAYMENT_GRPC_ADDR가 있으면 gRPC 클라이언트(o.breaker로 감싼다. 의존 이름 PAYMENT_PULL_BREAKER의 차단기를 준다),
 * 없으면(빈 글 포함) PEAKET_ENV가 local·ci일 때만 '기록 없음' 대역과 warnings 한 줄. PEAKET_ENV가 없으면 prod로 본다.
 * @throws Error 주소가 host:port 모양이 아님, 또는 local·ci가 아닌데 주소가 없음(시작 실패). main.ts는 당기기 실행기를 켤 때(purchase DB가 있을 때)만 부른다
 */
export function paymentResultReaderFromEnv(
  env: Record<string, string | undefined>,
  o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker } = {},
): { reader: PaymentResultReader; warnings: string[]; close(): void } {
  const address = (env[PAYMENT_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    const peaketEnv = env.PEAKET_ENV || 'prod';
    if (!PAYMENT_PULL_STUB_ENVS.has(peaketEnv)) {
      throw new Error(`${PAYMENT_GRPC_ADDR_ENV}가 없다(결제 결과 당기기의 payment-svc BatchGetPayments. '기록 없음' 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    }
    return {
      reader: emptyPaymentResultReader,
      warnings: [`${PAYMENT_GRPC_ADDR_ENV}가 없어 결제 결과 당기기는 늘 빈 답('기록 없음')으로 답하는 대역을 쓴다(결과는 trade.payments 사건으로만 반영된다)`],
      close: () => {},
    };
  }
  const reader = new GrpcPaymentResultReader({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}) });
  return { reader, warnings: [], close: () => reader.close() };
}
