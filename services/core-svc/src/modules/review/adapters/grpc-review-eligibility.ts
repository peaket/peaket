// ticket-svc TicketService.CheckReviewEligibility 클라이언트(docs/api/proto/peaket/ticket/v1/ticket.proto, BAT-585).
// core-svc가 카탈로그의 event.ends_at을 실어 보내고, ticket-svc가 결제자·유효 티켓·종료 시각을 함께 본다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { ReviewEligibilityUnavailable, type ReviewEligibility } from '../domain/ports.js';
import { hostPort } from '../../catalog/index.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcReviewEligibility implements ReviewEligibility {
  readonly #client: grpc.Client & { CheckReviewEligibility: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: Record<string, unknown> } } }).peaket.ticket.v1;
    const { host, port } = hostPort(address, 'PEAKET_TICKET_GRPC_URL');
    this.#client = createGrpcClient(pkg.TicketService as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'ticket-svc', timeoutCapMs: DEADLINE_MS }) as unknown as grpc.Client & { CheckReviewEligibility: Unary };
  }

  async check(input: { accountId: string; eventId: string; eventEndsAtMs: number }): Promise<{ eligible: boolean; basisOrderId?: string; reason?: 'NOT_ENDED' | 'NOT_PURCHASER' | 'NO_VALID_TICKET' }> {
    const v = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.CheckReviewEligibility(
        {
          account_id: input.accountId,
          event_id: input.eventId,
          event_ends_at: { seconds: Math.floor(input.eventEndsAtMs / 1000), nanos: (input.eventEndsAtMs % 1000) * 1_000_000 },
        },
        new grpc.Metadata(),
        { deadline: Date.now() + DEADLINE_MS },
        (e, res) => (e ? reject(new ReviewEligibilityUnavailable(grpc.status[e.code] ?? String(e.code))) : resolve(res ?? {})),
      );
    });
    const eligible = v.eligible;
    if (typeof eligible !== 'boolean') throw new ReviewEligibilityUnavailable('INVALID_RESPONSE');
    if (eligible) {
      const basis = v.basis_order_id;
      if (typeof basis !== 'string' || !UUID.test(basis)) throw new ReviewEligibilityUnavailable('INVALID_RESPONSE');
      return { eligible: true, basisOrderId: basis.toLowerCase() };
    }
    const reason = typeof v.reason === 'string' ? v.reason : '';
    const mapped = reason === 'REVIEW_INELIGIBLE_REASON_NOT_ENDED' ? 'NOT_ENDED' : reason === 'REVIEW_INELIGIBLE_REASON_NOT_PAYER' ? 'NOT_PURCHASER' : reason === 'REVIEW_INELIGIBLE_REASON_NO_VALID_TICKET' ? 'NO_VALID_TICKET' : undefined;
    return { eligible: false, ...(mapped ? { reason: mapped } : {}) };
  }

  close(): void {
    this.#client.close();
  }
}
