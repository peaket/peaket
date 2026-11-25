// ticket-svc TicketService.ListFraudTickets gRPC 클라이언트. 사건 조사용 표를 회차·결제자로 나열한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, type GrpcLbProfile } from '@peaket/platform';
import type { FraudTicketDirectory } from '../domain/ports.js';
import type { FraudTicketRef } from '../domain/fraud-action.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 5_000;
const CALLER = 'ops-svc';
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const statusOf = (v: unknown): string => (typeof v === 'string' ? v.replace(/^TICKET_STATUS_/, '') : 'UNKNOWN');

export class GrpcFraudTickets implements FraudTicketDirectory {
  readonly #client: grpc.Client & { ListFraudTickets: Unary };
  readonly #token: string | undefined;

  constructor(o: { address: string; profile?: GrpcLbProfile; token?: string }) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: Record<string, unknown> } } }).peaket.ticket.v1;
    const Ctor = pkg.TicketService as grpc.ServiceClientConstructor;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`PEAKET_TICKET_GRPC_URL은 host:port여야 한다: ${o.address}`);
    this.#client = createGrpcClient(Ctor, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'ticket-svc',
      timeoutCapMs: DEADLINE_MS,
      caller: CALLER,
    }) as unknown as grpc.Client & { ListFraudTickets: Unary };
    this.#token = o.token;
  }

  async listForAction(i: { eventId: string; payerAccountIds: readonly string[] }): Promise<readonly FraudTicketRef[]> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_TOKEN_HEADER, this.#token);
      metadata.set(INTERNAL_GRPC_CALLER_HEADER, CALLER);
    }
    const out = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.ListFraudTickets(
        { event_id: i.eventId, payer_account_ids: [...i.payerAccountIds] },
        metadata,
        { deadline: Date.now() + DEADLINE_MS },
        (e, v) => (e ? reject(e) : resolve(v ?? {})),
      );
    });
    const rows = Array.isArray(out.tickets) ? (out.tickets as Record<string, unknown>[]) : [];
    return rows.map((t) => ({
      ticketId: typeof t.ticket_id === 'string' ? t.ticket_id : '',
      payerAccountId: typeof t.payer_account_id === 'string' ? t.payer_account_id : '',
      holderAccountId: typeof t.holder_account_id === 'string' ? t.holder_account_id : '',
      status: statusOf(t.status),
      entryRecorded: t.entry_recorded === true,
    }));
  }

  close(): void {
    this.#client.close();
  }
}
