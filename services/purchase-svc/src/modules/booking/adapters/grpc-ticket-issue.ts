// ticket-svc 발권 gRPC 클라이언트(TicketService.IssueTickets, docs/api/proto/peaket/ticket/v1/ticket.proto, ADR-0106 결정 2, BUILD_ORDER PRF-170).
// grpc-payment-confirm.ts(승인 명령)와 같은 꼴이다.
// - 요청: order_id·event_id·payer_account_id·seat_ids(주문 ID로 멱등: 같은 주문을 다시 부르면 ticket-svc가 같은 티켓을 돌려준다).
// - 답: tickets[](ticket_id·seat_id·status) → 좌석별 티켓 ID와 상태(IssuedTicketRef, 상태는 TICKET_STATUS_ 접두어를 뗀 이름). 주문 좌석과 맞는지·
//   상태가 ISSUED·ACTIVE인지는 실행기가 issuedTicketsMatch로 본다(리뷰 고침 L8).
// - 데드라인 2초 [가정](docs/architecture.md 시간 초과 표 '발권 gRPC' 행, domain TICKET_ISSUE_CALL_DEADLINE_MS와 같은 값). 다시 묻지 않는다(다시 보내기는 실행기다).
// - 실패는 모두 TicketIssueCallError(code)로 던진다: gRPC 오류는 상태 이름(ticketIssueCodeOf, 모르는 번호는 UNKNOWN), 차단기 열림(503 dependency-unavailable)은
//   CIRCUIT_OPEN(부르지 않는다), 남은 시간 없음(504)은 DEADLINE_EXCEEDED, 동시 호출 상한(429 server-busy)은 RESOURCE_EXHAUSTED, gRPC가 아닌 예외는 UNKNOWN.
// - 클라이언트는 플랫폼 createGrpcClient(부하 분산 프로필·추적·의존 로그·데드라인 상한, 의존 이름 ticket-svc), 차단기는 플랫폼 CircuitBreaker(의존 이름 ticket-svc)로 감싼다.
// 주소(PEAKET_TICKET_GRPC_ADDR, host:port)가 없으면 local·ci(PEAKET_ENV, 없으면 prod로 본다)만 '늘 발권' 대역을 쓰고 시작 경고 한 줄을 남긴다.
// 그 밖의 환경은 주소 없이 시작하지 않는다(ticket-svc 서버 HOT-160 전의 대역, ConfirmPayment와 같은 규칙). 좌석·계정·티켓 ID는 로그·오류 글에 싣지 않는다.
// 구현에서 정한 것(정본에 없다): 플랫폼 ProblemError 가운데 위 셋이 아닌 것은 UNKNOWN(다시 보낸다)이다. 오류의 원인(cause)에는 받은 오류를 그대로 달아 두되
// 글(message)에는 코드만 싣는다. 데드라인은 1ms 이상, 상한 2초로 자른다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import { uuid8 } from '../domain/order.js';
import { TicketIssueCallError, type TicketIssueCommand, type TicketIssuer } from '../domain/ports.js';
import { GRPC_STATUS_NAMES, ISSUED_TICKET_STATUSES, type IssuedTicketRef, type IssuedTicketStatus, type TicketIssueFailureCode } from '../domain/ticket-issue.js';

/** 주소 환경 값(host:port) */
export const TICKET_GRPC_ADDR_ENV = 'PEAKET_TICKET_GRPC_ADDR';
/** 발권 호출 데드라인 상한 2초 [가정](architecture 시간 초과 표. domain/ticket-issue.ts TICKET_ISSUE_CALL_DEADLINE_MS와 같은 값) */
export const TICKET_ISSUE_CAP_MS = 2000;
/** 의존성 이름(span·의존 로그·차단기 지표) */
export const TICKET_DEPENDENCY = 'ticket-svc';

/** 설명자를 읽는 선택지(grpc-payment-confirm.ts와 같다: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type TicketPackage = { TicketService: grpc.ServiceClientConstructor };

let loaded: TicketPackage | undefined;
/** ticket/v1 패키지 설명자(처음 한 번 읽는다) */
function ticketPackage(): TicketPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: TicketPackage } } }).peaket.ticket.v1;
  }
  return loaded;
}

/** host:port를 나눈다. 모양이 틀리면 Error(시작 실패) */
function hostPortOf(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${TICKET_GRPC_ADDR_ENV}는 host:port여야 한다`);
  return { host: address.slice(0, at), port };
}

/** gRPC 서비스 오류(grpc-js ServiceError: code·details·metadata) */
function isServiceError(e: unknown): e is grpc.ServiceError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' && 'metadata' in e;
}

/** 부른 것이 던진 것 → 실패 코드(머리 주석의 규칙) */
function failureCodeOf(e: unknown): TicketIssueFailureCode {
  if (e instanceof TicketIssueCallError) return e.code;
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return 'CIRCUIT_OPEN';
    if (e.slug === 'deadline-exceeded') return 'DEADLINE_EXCEEDED';
    if (e.slug === 'server-busy') return 'RESOURCE_EXHAUSTED';
    return 'UNKNOWN';
  }
  return isServiceError(e) ? ticketIssueCodeOf(e.code) : 'UNKNOWN';
}

export interface GrpcTicketIssuerOptions {
  /** host:port */
  address: string;
  /** 설정의 grpcLbProfile(기본 service) */
  profile?: GrpcLbProfile;
  /** 차단기(의존 이름 ticket-svc). 열려 있으면 부르지 않고 TicketIssueCallError CIRCUIT_OPEN */
  breaker?: CircuitBreaker;
}

/**
 * 발권 클라이언트. issue 차례: (차단기) → IssueTickets(요청, 데드라인 = 지금 + min(c.deadlineMs, 2초)) → 답의 tickets → IssuedTicketRef[](issuedTicketsOf)
 * → 실패는 TicketIssueCallError(머리 주석의 코드).
 * 생성자가 주소(host:port)를 나누고 클라이언트를 만든다(연결은 첫 호출 때).
 * @throws Error 주소가 host:port 모양이 아님(생성 때, 시작 실패)
 */
export class GrpcTicketIssuer implements TicketIssuer {
  readonly #client: grpc.Client & { IssueTickets: Unary };

  constructor(readonly o: GrpcTicketIssuerOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(ticketPackage().TicketService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: TICKET_DEPENDENCY,
      timeoutCapMs: TICKET_ISSUE_CAP_MS,
    }) as unknown as grpc.Client & { IssueTickets: Unary };
  }

  async issue(c: TicketIssueCommand): Promise<readonly IssuedTicketRef[]> {
    const ms = Math.min(TICKET_ISSUE_CAP_MS, Math.max(1, Math.floor(Number.isFinite(c.deadlineMs) ? c.deadlineMs : TICKET_ISSUE_CAP_MS)));
    const request = { order_id: c.orderId, event_id: c.eventId, payer_account_id: c.payerAccountId, seat_ids: [...c.seatIds] };
    const once = (): Promise<Record<string, unknown>> => {
      // 데드라인은 차단기가 들여보낸 뒤부터 잰다
      const deadline = new Date(Date.now() + ms);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.IssueTickets(request, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    };
    let v: Record<string, unknown>;
    try {
      v = await (this.o.breaker ? this.o.breaker.run(once) : once());
    } catch (e) {
      throw new TicketIssueCallError(failureCodeOf(e), e);
    }
    return issuedTicketsOf(v);
  }

  /** gRPC 채널을 닫는다(SIGTERM, 실행기를 멈춘 뒤) */
  close(): void {
    this.#client.close();
  }
}

/**
 * gRPC 상태 번호 → 실패 코드(GRPC_STATUS_NAMES의 이름). 0(OK)·모르는 번호는 UNKNOWN [정함: 실패로 온 OK는 뜻을 모른다].
 * 예: 4 → DEADLINE_EXCEEDED, 9 → FAILED_PRECONDITION, 14 → UNAVAILABLE
 */
export function ticketIssueCodeOf(grpcCode: number): TicketIssueFailureCode {
  if (!Number.isInteger(grpcCode) || grpcCode < 1 || grpcCode >= GRPC_STATUS_NAMES.length) return 'UNKNOWN';
  return GRPC_STATUS_NAMES[grpcCode] as TicketIssueFailureCode;
}

/** TicketStatus enum 이름(enums: String) → 접두어를 뗀 상태. 칸이 없거나 모르는 값(번호로 온 모르는 enum 포함)이면 UNSPECIFIED */
const STATUS_OF: ReadonlyMap<string, IssuedTicketStatus> = new Map(ISSUED_TICKET_STATUSES.map((s) => [`TICKET_STATUS_${s}`, s]));

/**
 * 받은 답(IssueTicketsResponse, proto 칸 이름 그대로) → 좌석별 티켓 ID와 상태(TICKET_STATUS_ 접두어를 뗀 이름, 모르면 UNSPECIFIED).
 * tickets 칸이 배열이 아니거나 칸의 seat_id·ticket_id가 글이 아니면 TicketIssueCallError BAD_ANSWER를 던진다
 * (좌석과 맞는지·상태가 ISSUED·ACTIVE인지는 보지 않는다: 실행기의 issuedTicketsMatch, 리뷰 고침 L8)
 */
export function issuedTicketsOf(v: Record<string, unknown>): IssuedTicketRef[] {
  const tickets: unknown = v.tickets;
  if (!Array.isArray(tickets)) throw new TicketIssueCallError('BAD_ANSWER');
  return tickets.map((t: unknown) => {
    if (typeof t !== 'object' || t === null) throw new TicketIssueCallError('BAD_ANSWER');
    const { seat_id: seatId, ticket_id: ticketId, status } = t as { seat_id?: unknown; ticket_id?: unknown; status?: unknown };
    if (typeof seatId !== 'string' || typeof ticketId !== 'string') throw new TicketIssueCallError('BAD_ANSWER');
    return { seatId, ticketId, status: (typeof status === 'string' ? STATUS_OF.get(status) : undefined) ?? 'UNSPECIFIED' };
  });
}

/**
 * 주소가 없을 때(local·ci)의 '늘 발권' 대역: 좌석마다 티켓 ID를 만들어 상태 ISSUED로 돌려준다(ticket-svc 서버 HOT-160 전).
 * 티켓 ID는 주문 ID·좌석 ID에서 정해지는 UUID 버전 8(SHA-256('Ticket:' + 주문 ID + ':' + 좌석 ID)의 앞 16바이트) [정함: 정본에 없다]이라
 * 같은 주문을 다시 불러도 같은 티켓이다(ticket-svc의 주문 ID 멱등과 같은 모양)
 */
export const issuingTicketIssuer: TicketIssuer = {
  issue: async (c) => c.seatIds.map((seatId) => ({ seatId, ticketId: uuid8(`Ticket:${c.orderId}:${seatId}`), status: 'ISSUED' as const })),
};

/** 주소 없이 대역으로 뜰 수 있는 환경(로컬·CI). 그 밖(demo·staging·prod)은 주소가 없으면 시작하지 않는다 */
export const TICKET_STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 발권 포트를 만든다. PEAKET_TICKET_GRPC_ADDR가 있으면 gRPC 클라이언트(o.breaker로 감싼다),
 * 없으면(빈 글 포함) PEAKET_ENV가 local·ci일 때만 '늘 발권' 대역과 warnings 한 줄. PEAKET_ENV가 없으면 prod로 본다.
 * @throws Error 주소가 host:port 모양이 아님, 또는 local·ci가 아닌데 주소가 없음(시작 실패). main.ts는 발권 실행기를 켤 때(purchase DB가 있을 때)만 부른다
 */
export function ticketIssuerFromEnv(
  env: Record<string, string | undefined>,
  o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker } = {},
): { issuer: TicketIssuer; warnings: string[]; close(): void } {
  const address = (env[TICKET_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    const peaketEnv = env.PEAKET_ENV || 'prod';
    if (!TICKET_STUB_ENVS.has(peaketEnv)) {
      throw new Error(`${TICKET_GRPC_ADDR_ENV}가 없다(발권 실행기의 ticket-svc IssueTickets. '늘 발권' 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    }
    return {
      issuer: issuingTicketIssuer,
      warnings: [`${TICKET_GRPC_ADDR_ENV}가 없어 발권은 좌석마다 티켓 ID를 만들어 주는 '늘 발권' 대역을 쓴다(ticket-svc에 티켓이 생기지 않는다)`],
      close: () => {},
    };
  }
  const issuer = new GrpcTicketIssuer({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}) });
  return { issuer, warnings: [], close: () => issuer.close() };
}
