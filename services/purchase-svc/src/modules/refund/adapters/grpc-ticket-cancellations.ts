// ticket-svc CancelTickets gRPC 어댑터(GAT-080, docs/api/proto/peaket/ticket/v1/ticket.proto).
// ticket-svc가 티켓 행 잠금 안에서 결제자·보유자·진행 중 양도·공연 시작을 다시 보고 키를 폐기한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { TicketCancelOutcome } from '../domain/cancellation.js';
import type { TicketCancellations } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type TicketPackage = { TicketService: grpc.ServiceClientConstructor };

let loaded: TicketPackage | undefined;
function ticketPackage(): TicketPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: TicketPackage } } }).peaket.ticket.v1;
  }
  return loaded;
}

const OUTCOMES: ReadonlySet<TicketCancelOutcome> = new Set(['REFUND_NOW', 'REFUND_AFTER_CLOSE', 'NOT_PAYER_HOLDER', 'TRANSFER_PENDING', 'EVENT_STARTED', 'ALREADY_CANCELLED']);

export interface GrpcTicketCancellationsOptions {
  address: string;
  profile?: GrpcLbProfile;
  breaker?: CircuitBreaker;
}

export class GrpcTicketCancellations implements TicketCancellations {
  readonly #client: grpc.Client & { CancelTickets: Unary };

  constructor(o: GrpcTicketCancellationsOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_TICKET_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(ticketPackage().TicketService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'ticket-svc',
      timeoutCapMs: 2_000,
    }) as unknown as grpc.Client & { CancelTickets: Unary };
  }

  async cancel(q: Parameters<TicketCancellations['cancel']>[0]): Promise<TicketCancelOutcome> {
    const ms = Math.min(2_000, Math.max(1, Math.floor(Number.isFinite(q.deadlineMs) ? q.deadlineMs : 2_000)));
    const once = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        this.#client.CancelTickets(
          { order_id: q.orderId, ticket_ids: [...q.ticketIds], requested_by_account_id: q.requestedByAccountId, cancellation_id: q.cancellationId },
          new grpc.Metadata(),
          { deadline: new Date(Date.now() + ms) },
          (e, v) => (e ? reject(e) : resolve(v ?? {})),
        );
      });
    const v = await once();
    const first = Array.isArray(v.outcomes) ? (v.outcomes[0] as { result?: unknown } | undefined) : undefined;
    const raw = typeof first?.result === 'string' ? first.result.replace(/^CANCEL_TICKET_RESULT_/, '') : '';
    if (!OUTCOMES.has(raw as TicketCancelOutcome)) throw new Error('ticket-svc CancelTickets 답의 결과를 알 수 없다');
    return raw as TicketCancelOutcome;
  }

  close(): void {
    this.#client.close();
  }
}
