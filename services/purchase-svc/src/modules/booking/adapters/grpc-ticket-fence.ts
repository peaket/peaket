// ticket-svc BlockTicketIssuance gRPC 클라이언트(BAT-011 compFence, docs/api/proto/peaket/ticket/v1/ticket.proto).
// grpc-ticket-issue.ts와 같은 꼴이다. 주문 ID로 멱등하고, 이미 만든 티켓을 무효로 한 수(voided)와 입장 기록 수(already_entered)를 받는다.
// 데드라인은 상한 2초 [가정](COMPENSATION_FENCE_DEADLINE_MS). 실패는 TicketFenceCallError(code)로 던진다:
// gRPC 오류는 상태 이름(모르는 번호는 UNKNOWN), 차단기 열림(503 dependency-unavailable)은 CIRCUIT_OPEN, 남은 시간 없음(504)은 DEADLINE_EXCEEDED,
// 동시 호출 상한(429 server-busy)은 RESOURCE_EXHAUSTED, gRPC가 아닌 예외는 UNKNOWN이다.
// 호출자 머리(caller: purchase-svc)와 내부 토큰을 싣는다. ticket-svc는 토큰이 설정된 환경에서 호출자 purchase-svc만 받는다(ASVS 8.2.1, ADR-0354 결정 2).
// 주소가 없으면 local·ci만 '늘 막기' 대역(아무것도 무효로 하지 않고 성공)을 쓰고 경고 한 줄을 남긴다. 그 밖의 환경은 주소 없이 시작하지 않는다
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import { COMPENSATION_FENCE_DEADLINE_MS, compensationGrpcCodeOf, type TicketFencer, TicketFenceCallError } from '../domain/compensation.js';
import { TICKET_DEPENDENCY, TICKET_GRPC_ADDR_ENV } from './grpc-ticket-issue.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type TicketPackage = { TicketService: grpc.ServiceClientConstructor };
/** ticket-svc에 싣는 호출자 머리(내부 gRPC) */
const TICKET_CALLER = 'purchase-svc';

let loaded: TicketPackage | undefined;
function ticketPackage(): TicketPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: TicketPackage } } }).peaket.ticket.v1;
  }
  return loaded;
}

function isServiceError(e: unknown): e is grpc.ServiceError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' && 'metadata' in e;
}

/** 부른 것이 던진 것 → 실패 코드(머리 주석의 규칙) */
function failureCodeOf(e: unknown): string {
  if (e instanceof TicketFenceCallError) return e.code;
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return 'CIRCUIT_OPEN';
    if (e.slug === 'deadline-exceeded') return 'DEADLINE_EXCEEDED';
    if (e.slug === 'server-busy') return 'RESOURCE_EXHAUSTED';
    return 'UNKNOWN';
  }
  return isServiceError(e) ? compensationGrpcCodeOf(e.code) : 'UNKNOWN';
}

export interface GrpcTicketFenceOptions {
  /** host:port */
  readonly address: string;
  readonly profile?: GrpcLbProfile;
  /** 차단기(의존 이름 ticket-svc). 열려 있으면 부르지 않고 CIRCUIT_OPEN */
  readonly breaker?: CircuitBreaker;
  /** 내부 gRPC 토큰. 있으면 호출에 싣는다(운영 필수) */
  readonly internalToken?: string;
}

/** 주문 하나의 발권을 막는 gRPC 클라이언트. 생성자가 주소를 나누고 클라이언트를 만든다(연결은 첫 호출 때) */
export class GrpcTicketFence implements TicketFencer {
  readonly #client: grpc.Client & { BlockTicketIssuance: Unary };

  constructor(readonly o: GrpcTicketFenceOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${TICKET_GRPC_ADDR_ENV}는 host:port여야 한다`);
    this.#client = createGrpcClient(ticketPackage().TicketService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: TICKET_DEPENDENCY,
      timeoutCapMs: COMPENSATION_FENCE_DEADLINE_MS,
      caller: TICKET_CALLER,
      ...(o.internalToken ? { internalToken: o.internalToken } : {}),
    }) as unknown as grpc.Client & { BlockTicketIssuance: Unary };
  }

  async block(input: { readonly orderId: string; readonly reason: string; readonly deadlineMs: number }): Promise<{ readonly voided: number; readonly alreadyEntered: number; readonly blocked: true }> {
    const ms = Math.min(COMPENSATION_FENCE_DEADLINE_MS, Math.max(1, Math.floor(Number.isFinite(input.deadlineMs) ? input.deadlineMs : COMPENSATION_FENCE_DEADLINE_MS)));
    const request = { order_id: input.orderId, reason: input.reason };
    const once = (): Promise<Record<string, unknown>> => {
      const deadline = new Date(Date.now() + ms);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.BlockTicketIssuance(request, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    };
    let v: Record<string, unknown>;
    try {
      v = await (this.o.breaker ? this.o.breaker.run(once) : once());
    } catch (e) {
      throw new TicketFenceCallError(failureCodeOf(e) as TicketFenceCallError['code'], { cause: e });
    }
    const voided = typeof v.voided === 'number' && v.voided > 0 ? v.voided : 0;
    const alreadyEntered = typeof v.already_entered === 'number' && v.already_entered > 0 ? v.already_entered : 0;
    return { blocked: true, voided, alreadyEntered };
  }

  /** 도메인 포트의 옛 이름(ticket.proto의 RPC 이름). block과 같다 */
  blockTicketIssuance(input: { readonly orderId: string; readonly reason: string; readonly deadlineMs: number }): Promise<{ readonly voided: number; readonly alreadyEntered: number; readonly blocked: true }> {
    return this.block(input);
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때(local·ci)의 '늘 막기' 대역: ticket-svc가 없다는 것 말고는 아무것도 알지 못한다 */
export const stubTicketFence: TicketFencer = {
  block: async () => ({ blocked: true, voided: 0, alreadyEntered: 0 }),
};

/** 주소 없이 대역으로 뜰 수 있는 환경(로컬·CI). 그 밖(demo·staging·prod)은 주소가 없으면 시작하지 않는다 */
const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 발권 막기 포트를 만든다. PEAKET_TICKET_GRPC_ADDR가 있으면 gRPC 클라이언트, 없으면 PEAKET_ENV가 local·ci일 때만 대역과 경고 한 줄이다.
 * @throws Error 주소가 host:port 모양이 아님, 또는 local·ci가 아닌데 주소가 없음(시작 실패)
 */
export function ticketFenceFromEnv(
  env: Record<string, string | undefined>,
  o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker; internalToken?: string } = {},
): { fence: TicketFencer; warnings: string[]; close(): void } {
  const address = (env[TICKET_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    if (!STUB_ENVS.has(env.PEAKET_ENV || 'prod')) {
      throw new Error(`${TICKET_GRPC_ADDR_ENV}가 없다(보상의 ticket-svc BlockTicketIssuance. '늘 막기' 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    }
    return { fence: stubTicketFence, warnings: [`${TICKET_GRPC_ADDR_ENV}가 없어 보상의 발권 막기는 아무것도 하지 않는 대역을 쓴다(ticket-svc에 막은 기록이 생기지 않는다)`], close: () => {} };
  }
  const fence = new GrpcTicketFence({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}), ...(o.internalToken ? { internalToken: o.internalToken } : {}) });
  return { fence, warnings: [], close: () => fence.close() };
}
