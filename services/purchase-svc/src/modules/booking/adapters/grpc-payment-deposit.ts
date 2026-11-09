// payment-svc 입금 안내 gRPC 클라이언트(PaymentService.GetPayment, docs/features/payment.md §6 '결제 상태 응답', docs/verification.md §4.1, BUILD_ORDER HOT-151).
// grpc-payment-results.ts와 같은 꼴이다(같은 payment/v1 설명자, 같은 주소 PEAKET_PAYMENT_GRPC_ADDR). 입금 대기인 주문의 결제 상태 응답이 은행·계좌번호·입금 기한을 읽는다.
// - 요청: order_id. 데드라인 상한 300ms [가정]. 이 호출 안에서는 다시 묻지 않는다.
// - 던지지 않는다. 일시 실패(시간 초과·차단기·UNAVAILABLE·과부하)는 PAYMENT_DEPOSIT_READ_TRANSIENT다. 쓰임새가 처리 중으로 답해 화면이 다시 묻게 한다. 그 밖의 실패(NOT_FOUND 등)는 undefined이고 응답은 계좌 칸 없이 나간다. 실패 코드는 onFailure로만 알린다(지표).
// - 답의 order_id가 요청과 다르면 계좌 칸을 쓰지 않고 undefined다(남의 계좌를 보이지 않는다). onOrderMismatch로 경고한다.
// - 계좌번호는 이 클라이언트의 답으로만 지나간다. 로그·오류 글에 싣지 않고 purchase DB에 저장하지 않는다.
// 주소가 없으면(local·ci의 대역 환경) 늘 undefined다. 그 밖의 환경은 승인 명령 클라이언트가 주소 없이 시작하지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import { PAYMENT_DEPOSIT_READ_TRANSIENT, type PaymentDepositRead, type PaymentStatusVirtualAccount } from '../domain/payment-status.js';
import type { PaymentDepositReader } from '../domain/ports.js';
import { PAYMENT_GRPC_ADDR_ENV } from './grpc-payment-confirm.js';
import { paymentPullCodeOf } from './grpc-payment-results.js';

/** GetPayment 데드라인 상한 300ms [가정](domain PAYMENT_DEPOSIT_READ_DEADLINE_MS와 같은 값) */
export const PAYMENT_DEPOSIT_CAP_MS = 300;
/** 입금 안내 차단기의 의존 이름(차단기 지표·로그. 승인 명령·결과 당기기 차단기와 따로다) */
export const PAYMENT_DEPOSIT_BREAKER = 'payment-svc-get';

const DEPENDENCY = 'payment-svc';
/** 다음 상태 요청이 다시 읽으면 될 수 있는 실패 코드 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['DEADLINE_EXCEEDED', 'CIRCUIT_OPEN', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED']);
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

function failureCodeOf(e: unknown): string {
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return 'CIRCUIT_OPEN';
    if (e.slug === 'deadline-exceeded') return 'DEADLINE_EXCEEDED';
    if (e.slug === 'server-busy') return 'RESOURCE_EXHAUSTED';
    return 'UNKNOWN';
  }
  return isObject(e) && typeof e.code === 'number' ? paymentPullCodeOf(e.code) : 'UNKNOWN';
}

/** 답(GetPaymentResponse, proto 칸 이름) → 입금 안내. 입금 안내 칸이 없으면 undefined. 비어 있는 칸은 싣지 않는다 */
export function depositInfoOf(v: Record<string, unknown>): PaymentStatusVirtualAccount | undefined {
  const va = v.virtual_account;
  if (!isObject(va)) return undefined;
  const bank = typeof va.bank === 'string' && va.bank !== '' ? va.bank : undefined;
  const accountNumber = typeof va.account_number === 'string' && va.account_number !== '' ? va.account_number : undefined;
  const dueAt = isoOf(va.due_at);
  return { ...(bank !== undefined ? { bank } : {}), ...(accountNumber !== undefined ? { accountNumber } : {}), ...(dueAt !== undefined ? { dueAt } : {}) };
}

/** Timestamp{seconds, nanos} → ISO 8601. 칸이 없거나 모양이 틀리면 undefined */
function isoOf(v: unknown): string | undefined {
  if (!isObject(v)) return undefined;
  const seconds = Number(v.seconds);
  const nanos = typeof v.nanos === 'number' ? v.nanos : 0;
  const d = new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface GrpcPaymentDepositReaderOptions {
  /** host:port(PEAKET_PAYMENT_GRPC_ADDR) */
  address: string;
  profile?: GrpcLbProfile;
  /** 차단기(의존 이름 payment-svc-get) */
  breaker?: CircuitBreaker;
  /** 호출이 실패했을 때 코드(지표 purchase_payment_status_deposit_read_failures_total) */
  onFailure?: (code: string) => void;
  /** 답의 order_id가 요청과 달라 계좌 칸을 버렸을 때 요청의 주문 ID(경고 로그) */
  onOrderMismatch?: (orderId: string) => void;
}

/**
 * 입금 안내 클라이언트. 생성자가 주소를 나누고 클라이언트를 만든다(연결은 첫 호출 때).
 * @throws Error 주소가 host:port 모양이 아님(생성 때, 시작 실패)
 */
export class GrpcPaymentDepositReader implements PaymentDepositReader {
  readonly #client: grpc.Client & { GetPayment: Unary };

  constructor(readonly o: GrpcPaymentDepositReaderOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(paymentPackage().PaymentService, { host, port, profile: o.profile ?? 'service', dependency: DEPENDENCY, timeoutCapMs: PAYMENT_DEPOSIT_CAP_MS }) as unknown as grpc.Client & { GetPayment: Unary };
  }

  async read(orderId: string, o: { readonly deadlineMs?: number } = {}): Promise<PaymentDepositRead> {
    const asked = o.deadlineMs;
    const ms = Math.min(PAYMENT_DEPOSIT_CAP_MS, Math.max(1, Math.floor(typeof asked === 'number' && Number.isFinite(asked) ? asked : PAYMENT_DEPOSIT_CAP_MS)));
    const once = (): Promise<Record<string, unknown>> => {
      const deadline = new Date(Date.now() + ms);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.GetPayment({ order_id: orderId }, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    };
    let answer: Record<string, unknown>;
    try {
      answer = await (this.o.breaker ? this.o.breaker.run(once) : once());
    } catch (e) {
      const code = failureCodeOf(e);
      this.o.onFailure?.(code);
      return TRANSIENT_CODES.has(code) ? PAYMENT_DEPOSIT_READ_TRANSIENT : undefined;
    }
    if (answer.order_id !== orderId) {
      this.o.onOrderMismatch?.(orderId);
      return undefined;
    }
    return depositInfoOf(answer);
  }

  /** gRPC 채널을 닫는다(SIGTERM) */
  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때의 대역: 늘 undefined다 */
export const noPaymentDepositReader: PaymentDepositReader = { read: async () => undefined };

/** 환경 값으로 입금 안내 포트를 만든다. PEAKET_PAYMENT_GRPC_ADDR가 없으면 대역이다(그 밖의 환경의 주소 검사는 승인 명령 클라이언트가 한다) */
export function paymentDepositReaderFromEnv(env: Record<string, string | undefined>, o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker; onFailure?: (code: string) => void; onOrderMismatch?: (orderId: string) => void } = {}): { reader: PaymentDepositReader; close(): void } {
  const address = (env[PAYMENT_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') return { reader: noPaymentDepositReader, close: () => {} };
  const reader = new GrpcPaymentDepositReader({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}), ...(o.onFailure ? { onFailure: o.onFailure } : {}), ...(o.onOrderMismatch ? { onOrderMismatch: o.onOrderMismatch } : {}) });
  return { reader, close: () => reader.close() };
}
