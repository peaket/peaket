// purchase-svc FraudCancellationService.CancelFraudTickets gRPC 클라이언트. 승인 뒤 표 취소·환급 Saga를 시작한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Fraudcancellation } from '@peaket/contracts/proto';
import {
  createGrpcClient,
  INTERNAL_GRPC_ACTOR_HEADER,
  INTERNAL_GRPC_ACTOR_PROOF_HEADER,
  INTERNAL_GRPC_CALLER_HEADER,
  INTERNAL_GRPC_TOKEN_HEADER,
  internalGrpcActorProof,
  type GrpcLbProfile,
} from '@peaket/platform';
import type { FraudCancellations } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 10_000;
const CALLER = 'ops-svc';
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const OUTCOMES: Readonly<Record<string, 'ACCEPTED' | 'SKIPPED_ALREADY_ENDED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_HOLDER_CHANGED' | 'FAILED'>> = {
  FRAUD_CANCELLATION_OUTCOME_ACCEPTED: 'ACCEPTED',
  FRAUD_CANCELLATION_OUTCOME_SKIPPED_ALREADY_ENDED: 'SKIPPED_ALREADY_ENDED',
  FRAUD_CANCELLATION_OUTCOME_SKIPPED_ENTRY_STARTED: 'SKIPPED_ENTRY_STARTED',
  FRAUD_CANCELLATION_OUTCOME_SKIPPED_HOLDER_CHANGED: 'SKIPPED_HOLDER_CHANGED',
  FRAUD_CANCELLATION_OUTCOME_FAILED: 'FAILED',
};

export class GrpcFraudCancellations implements FraudCancellations {
  readonly #client: grpc.Client & { CancelFraudTickets: Unary };
  readonly #token: string | undefined;

  constructor(o: { address: string; profile?: GrpcLbProfile; token?: string }) {
    const def = protoLoader.fromJSON(purchaseV1Fraudcancellation as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Record<string, unknown> } } }).peaket.purchase.v1;
    const Ctor = pkg.FraudCancellationService as grpc.ServiceClientConstructor;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`PEAKET_PURCHASE_GRPC_ADDR는 host:port여야 한다: ${o.address}`);
    this.#client = createGrpcClient(Ctor, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'purchase-svc',
      timeoutCapMs: DEADLINE_MS,
      caller: CALLER,
    }) as unknown as grpc.Client & { CancelFraudTickets: Unary };
    this.#token = o.token;
  }

  async cancel(i: {
    approvalId: string;
    caseId: string;
    eventId: string;
    targets: readonly { ticketId: string; expectedHolderAccountId: string }[];
    requestedBy: string;
    approvedBy: string;
    approvedAtMs: number;
  }): Promise<readonly { ticketId: string; outcome: 'ACCEPTED' | 'SKIPPED_ALREADY_ENDED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_HOLDER_CHANGED' | 'FAILED'; cancellationId?: string; refundAmount?: number; withdrawnTransferOfferId?: string; failureCode?: string }[]> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_TOKEN_HEADER, this.#token);
      metadata.set(INTERNAL_GRPC_CALLER_HEADER, CALLER);
      metadata.set(INTERNAL_GRPC_ACTOR_HEADER, i.approvedBy);
      metadata.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof(this.#token, i.approvedBy));
    }
    const out = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.CancelFraudTickets(
        {
          approval_id: i.approvalId,
          fraud_case_id: i.caseId,
          event_id: i.eventId,
          targets: i.targets.map((t) => ({ ticket_id: t.ticketId, expected_holder_account_id: t.expectedHolderAccountId })),
          requested_by: i.requestedBy,
          approved_by: i.approvedBy,
          approved_at: { seconds: Math.floor(i.approvedAtMs / 1_000), nanos: (i.approvedAtMs % 1_000) * 1_000_000 },
        },
        metadata,
        { deadline: Date.now() + DEADLINE_MS },
        (e, v) => (e ? reject(e) : resolve(v ?? {})),
      );
    });
    const rows = Array.isArray(out.results) ? (out.results as Record<string, unknown>[]) : [];
    return rows.map((r) => {
      const money = typeof r.refund_amount === 'object' && r.refund_amount !== null ? (r.refund_amount as { krw?: unknown }) : undefined;
      return {
        ticketId: typeof r.ticket_id === 'string' ? r.ticket_id : '',
        outcome: OUTCOMES[String(r.outcome)] ?? 'FAILED',
        ...(typeof r.cancellation_id === 'string' && r.cancellation_id !== '' ? { cancellationId: r.cancellation_id } : {}),
        ...(money && Number.isFinite(Number(money.krw)) ? { refundAmount: Number(money.krw) } : {}),
        ...(typeof r.withdrawn_transfer_offer_id === 'string' && r.withdrawn_transfer_offer_id !== '' ? { withdrawnTransferOfferId: r.withdrawn_transfer_offer_id } : {}),
        ...(typeof r.failure_code === 'string' && r.failure_code !== '' ? { failureCode: r.failure_code } : {}),
      };
    });
  }

  close(): void {
    this.#client.close();
  }
}
