// ticket-svc IssueTickets gRPC 클라이언트 어댑터(BUILD_ORDER HOT-160, BAT-050). 실제 Saga 연결은 후속이다.
// 계약 설명은 @peaket/contracts/proto의 ticketV1Ticket에서 읽고, 실패는 재시도 분류로 바꾼다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { type TicketIssueRequest, type TicketIssueResult, ticketIssueFailureOf, type TicketIssuer } from '../domain/ticket-issuer.js';

interface TicketClient {
  issueTickets(req: Record<string, unknown>, options: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void): void;
}

interface TicketPackage {
  TicketService: grpc.ServiceClientConstructor;
}

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
let pkg: TicketPackage | undefined;
function ticketPackage(): TicketPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: TicketPackage } } }).peaket.ticket.v1;
  }
  return pkg;
}

export interface TicketGrpcIssuerOptions {
  /** PEAKET_TICKET_GRPC_ADDR(예: ticket-svc:50052) */
  readonly address: string;
  /** 시험에서 가짜 클라이언트를 넣는다 */
  readonly client?: TicketClient;
  /** 데드라인 상한(기본 2000ms [가정]) */
  readonly deadlineMs?: number;
}

const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export class TicketGrpcIssuer implements TicketIssuer {
  readonly #client: TicketClient;
  readonly #deadlineMs: number;

  constructor(o: TicketGrpcIssuerOptions) {
    this.#client = o.client ?? (new (ticketPackage().TicketService)(o.address, grpc.credentials.createInsecure()) as unknown as TicketClient);
    this.#deadlineMs = o.deadlineMs ?? 2_000;
  }

  issue(i: TicketIssueRequest, budget?: { readonly remainingMs: number }): Promise<TicketIssueResult> {
    const left = Math.min(this.#deadlineMs, budget?.remainingMs ?? this.#deadlineMs);
    if (!(left > 0)) return Promise.resolve({ kind: 'failed', failure: 'deadline', message: '남은 시간이 없다' });
    return new Promise((resolve) => {
      this.#client.issueTickets(
        {
          order_id: i.orderId,
          event_id: i.eventId,
          payer_account_id: i.payerAccountId,
          seat_ids: i.seatIds,
          issue_generation: i.issueGeneration,
          ...(i.eventStartsAtMs === undefined ? {} : { event_starts_at: timestampOf(i.eventStartsAtMs) }),
        },
        { deadline: Date.now() + left },
        (err, res) => {
          if (err) {
            resolve({ kind: 'failed', failure: ticketIssueFailureOf(err.code), code: err.code, message: err.details });
            return;
          }
          const rows = Array.isArray(res.tickets) ? (res.tickets as Array<Record<string, unknown>>) : [];
          const tickets = rows
            .map((t) => {
              const status = t.status === 'TICKET_STATUS_ACTIVE' ? ('ACTIVE' as const) : t.status === 'TICKET_STATUS_ISSUED' ? ('ISSUED' as const) : undefined;
              return status ? { ticketId: text(t.ticket_id), seatId: text(t.seat_id), status } : undefined;
            })
            .filter((t): t is { ticketId: string; seatId: string; status: 'ISSUED' | 'ACTIVE' } => t !== undefined && t.ticketId !== '');
          const requested = new Set(i.seatIds);
          const uniqueSeats = new Set(tickets.map((t) => t.seatId));
          if (tickets.length !== i.seatIds.length || uniqueSeats.size !== tickets.length || tickets.some((t) => !requested.has(t.seatId))) {
            resolve({ kind: 'failed', failure: 'unknown', message: '발권 응답의 좌석이 요청과 맞지 않다' });
            return;
          }
          resolve(tickets.length === 0 ? { kind: 'failed', failure: 'unknown', message: '빈 발권 응답' } : { kind: 'issued', tickets });
        },
      );
    });
  }
}
