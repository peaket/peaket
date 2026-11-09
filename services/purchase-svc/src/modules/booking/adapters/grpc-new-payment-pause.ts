// payment-svc 새 결제 일시 정지 조회 gRPC 클라이언트(PaymentService.GetNewPaymentPause, ADR-0085, docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현', docs/api/guidelines.md §5, BUILD_ORDER PRF-201).
// grpc-payment-checkout.ts와 같은 꼴이다(같은 payment/v1 설명자, 같은 주소 PEAKET_PAYMENT_GRPC_ADDR). 만료 작업의 조립은 HOT-070이다.
// - 데드라인 상한 500ms [가정]. 이 호출 안에서는 다시 묻지 않고 던지지 않는다(결과는 NewPaymentPauseOutcome).
// - 회차가 200개 [가정]를 넘으면 나눠 부른다. payment-svc가 INVALID_ARGUMENT로 거절하면 REJECTED이고 따로 경보한다(BUILD_ORDER PRF-201 코드 리뷰).
// - 답을 받지 못하면(시간 초과·차단기·장애) UNAVAILABLE이다. 만료 작업은 마지막 답을 10초 [가정] 쓰고 그 뒤 다시 열린 것으로 본다(ADR-0085, docs/features/seat-hold.md §5).
// - 주소가 없으면 local·ci만 '정지 없음' 대역과 경고 한 줄이고 그 밖의 환경은 시작하지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import type { NewPaymentPause, NewPaymentPauseOutcome, NewPaymentPauses } from '../domain/ports.js';
import { PAYMENT_GRPC_ADDR_ENV } from './grpc-payment-confirm.js';
import { paymentPullCodeOf } from './grpc-payment-results.js';

/** GetNewPaymentPause 데드라인 상한 500ms [가정](docs/api/guidelines.md §5) */
export const NEW_PAYMENT_PAUSE_CAP_MS = 500;
/** 한 번에 보내는 회차 수 상한 200개 [가정](payment-svc의 상한과 같다. 넘으면 나눠 부른다, BUILD_ORDER PRF-201 코드 리뷰) */
export const NEW_PAYMENT_PAUSE_MAX_EVENTS = 200;
/** 차단기의 의존 이름(결제창 준비·승인 명령 차단기와 따로다) */
export const PAYMENT_PAUSE_BREAKER = 'payment-svc-pause';
/** 이 호출의 차단기가 판정하는 최소 호출 수 5 [가정]. 만료 작업이 파드마다 1초 [가정]에 한 번 불러 창 10초 안의 호출이 10번쯤이라, 공용 기본 20이면 열리지 않는다(BUILD_ORDER PRF-201 코드 리뷰) */
export const PAYMENT_PAUSE_BREAKER_MIN_CALLS = 5;
/** 일시 정지 조회 차단기의 설정(조립하는 HOT-070이 service·registry·logger와 합쳐 CircuitBreaker를 만든다) */
export const PAYMENT_PAUSE_BREAKER_OPTIONS = Object.freeze({ dependency: PAYMENT_PAUSE_BREAKER, minCalls: PAYMENT_PAUSE_BREAKER_MIN_CALLS });

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

function failureCodeOf(e: unknown): string {
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return 'CIRCUIT_OPEN';
    if (e.slug === 'deadline-exceeded') return 'DEADLINE_EXCEEDED';
    if (e.slug === 'server-busy') return 'RESOURCE_EXHAUSTED';
    return 'UNKNOWN';
  }
  return isObject(e) && typeof e.code === 'number' ? paymentPullCodeOf(e.code) : 'UNKNOWN';
}

/** Timestamp{seconds, nanos} → epoch ms. 칸이 없거나 틀리면 0이다(멈춘 시작 시각을 모르면 홀드는 주문 시각부터 멈춘다) */
function msOf(v: unknown): number {
  if (!isObject(v)) return 0;
  const seconds = Number(v.seconds);
  const nanos = typeof v.nanos === 'number' ? v.nanos : 0;
  return Number.isFinite(seconds) ? seconds * 1000 + Math.floor(nanos / 1_000_000) : 0;
}

/** 답(proto 칸 이름) → 결과. 회차 ID가 빈 칸은 버린다(어느 회차인지 모른다) */
export function newPaymentPausesOf(v: Record<string, unknown>): NewPaymentPauseOutcome {
  const list = Array.isArray(v.pauses) ? v.pauses : [];
  const pauses: NewPaymentPause[] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.event_id !== 'string' || item.event_id === '') continue;
    pauses.push({ eventId: item.event_id, pausedSinceMs: msOf(item.paused_since) });
  }
  return { status: 'OK', pauses };
}

export interface GrpcNewPaymentPausesOptions {
  address: string;
  profile?: GrpcLbProfile;
  breaker?: CircuitBreaker;
  /** payment-svc가 요청을 거절했을 때(INVALID_ARGUMENT) 한 번 불린다. 부르는 쪽의 결함이라 SEV2 경보로 잇는다(조립은 HOT-070). 던지면 안 된다 */
  onRejected?: (reason: string) => void;
}

/** 일시 정지 조회 클라이언트. 200개 [가정]씩 차단기(있으면) → GetNewPaymentPause(데드라인 = 지금 + min(deadlineMs, 500), 묶음이 나눠 쓴다). 다시 묻지 않고 던지지 않는다. 한 묶음이라도 실패하면 전체가 실패다 */
export class GrpcNewPaymentPauses implements NewPaymentPauses {
  readonly #client: grpc.Client & { GetNewPaymentPause: Unary };

  /** @throws Error 주소가 host:port 모양이 아님(시작 실패) */
  constructor(readonly o: GrpcNewPaymentPausesOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(paymentPackage().PaymentService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: DEPENDENCY,
      timeoutCapMs: NEW_PAYMENT_PAUSE_CAP_MS,
    }) as unknown as grpc.Client & { GetNewPaymentPause: Unary };
  }

  async read(eventIds: readonly string[], o: { readonly deadlineMs: number }): Promise<NewPaymentPauseOutcome> {
    if (eventIds.length === 0) return { status: 'OK', pauses: [] };
    const deadline = new Date(Date.now() + Math.min(NEW_PAYMENT_PAUSE_CAP_MS, Math.max(1, Math.floor(o.deadlineMs))));
    const pauses: NewPaymentPause[] = [];
    for (let i = 0; i < eventIds.length; i += NEW_PAYMENT_PAUSE_MAX_EVENTS) {
      const outcome = await this.#readChunk(eventIds.slice(i, i + NEW_PAYMENT_PAUSE_MAX_EVENTS), deadline);
      if (outcome.status !== 'OK') return outcome;
      pauses.push(...outcome.pauses);
    }
    return { status: 'OK', pauses };
  }

  async #readChunk(eventIds: readonly string[], deadline: Date): Promise<NewPaymentPauseOutcome> {
    const once = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.GetNewPaymentPause({ event_ids: [...eventIds] }, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    try {
      return newPaymentPausesOf(await (this.o.breaker ? this.o.breaker.run(once) : once()));
    } catch (e) {
      const reason = failureCodeOf(e);
      if (reason !== 'INVALID_ARGUMENT') return { status: 'UNAVAILABLE', reason };
      this.o.onRejected?.(reason);
      return { status: 'REJECTED', reason };
    }
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때(local·ci)의 대역: 늘 정지 없음이다 */
export const noNewPaymentPauses: NewPaymentPauses = {
  read: async () => ({ status: 'OK', pauses: [] }),
};

const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 일시 정지 조회 포트를 만든다. 주소가 있으면 gRPC 클라이언트, 없으면 PEAKET_ENV가 local·ci일 때만 대역과 warnings 한 줄이다. PEAKET_ENV가 없으면 prod로 본다.
 * @throws Error 주소 모양이 틀림, 또는 local·ci가 아닌데 주소가 없음(시작 실패)
 */
export function newPaymentPausesFromEnv(env: Record<string, string | undefined>, o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker; onRejected?: (reason: string) => void } = {}): { pauses: NewPaymentPauses; warnings: string[]; close(): void } {
  const address = (env[PAYMENT_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    const peaketEnv = env.PEAKET_ENV || 'prod';
    if (!STUB_ENVS.has(peaketEnv)) throw new Error(`${PAYMENT_GRPC_ADDR_ENV}가 없다(새 결제 일시 정지 조회 payment-svc GetNewPaymentPause. 정지 없음 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    return { pauses: noNewPaymentPauses, warnings: [`${PAYMENT_GRPC_ADDR_ENV}가 없어 새 결제 일시 정지 조회는 정지 없음 대역을 쓴다`], close: () => {} };
  }
  const pauses = new GrpcNewPaymentPauses({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}), ...(o.onRejected ? { onRejected: o.onRejected } : {}) });
  return { pauses, warnings: [], close: () => pauses.close() };
}
