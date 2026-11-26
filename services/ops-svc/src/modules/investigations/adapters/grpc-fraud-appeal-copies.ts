// core-svc FraudAppealViewService.SetFraudAppealView gRPC 클라이언트. 팬 소명 화면 사본을 바꾼다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import { createGrpcClient, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, type GrpcLbProfile } from '@peaket/platform';
import type { FraudAppealCopies } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 5_000;
const CALLER = 'ops-svc';
const TS = (ms: number) => ({ seconds: Math.floor(ms / 1_000), nanos: (ms % 1_000) * 1_000_000 });
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcFraudAppealCopies implements FraudAppealCopies {
  readonly #client: grpc.Client & { SetFraudAppealView: Unary };
  readonly #token: string | undefined;

  constructor(o: { address: string; profile?: GrpcLbProfile; token?: string }) {
    const def = protoLoader.fromJSON(coreV1Core as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { core: { v1: Record<string, unknown> } } }).peaket.core.v1;
    const Ctor = pkg.FraudAppealViewService as grpc.ServiceClientConstructor;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`PEAKET_CORE_GRPC_URL은 host:port여야 한다: ${o.address}`);
    this.#client = createGrpcClient(Ctor, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'core-svc',
      timeoutCapMs: DEADLINE_MS,
      caller: CALLER,
    }) as unknown as grpc.Client & { SetFraudAppealView: Unary };
    this.#token = o.token;
  }

  async set(i: { caseId: string; eventId: string; accountId: string; version: number; lockActive: boolean; objectionDueAtMs: number | null; actionResult: Record<string, unknown> | null; party?: 'PAYER' | 'HOLDER'; state?: 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'; reasonCategories?: readonly string[]; dueAtMs?: number; lockedTicketIds?: readonly string[]; heldTicketIds?: readonly string[]; excludedTicketIds?: readonly string[]; lockExpiresAtMs?: number | null; objectionState?: 'NONE' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED'; objectionNote?: string | null; priorityPurchases?: readonly Record<string, unknown>[]; restrictedUntilMs?: number | null; cancelledTicketIds?: readonly string[] }): Promise<void> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_TOKEN_HEADER, this.#token);
      metadata.set(INTERNAL_GRPC_CALLER_HEADER, CALLER);
    }
    const result = i.actionResult ?? {};
    const cancelled = Array.isArray(i.cancelledTicketIds) ? i.cancelledTicketIds.map(String) : Array.isArray(result.cancelledTicketIds) ? result.cancelledTicketIds.map(String) : [];
    const state = i.state ?? 'OPEN';
    const stateName = state === 'OPEN' ? 'FRAUD_APPEAL_VIEW_STATE_OPEN' : state === 'SUBMITTED' ? 'FRAUD_APPEAL_VIEW_STATE_SUBMITTED' : state === 'ACCEPTED' ? 'FRAUD_APPEAL_VIEW_STATE_ACCEPTED' : state === 'REJECTED' ? 'FRAUD_APPEAL_VIEW_STATE_REJECTED' : 'FRAUD_APPEAL_VIEW_STATE_EXPIRED';
    await new Promise<void>((resolve, reject) => {
      this.#client.SetFraudAppealView(
        {
          account_id: i.accountId,
          case_id: i.caseId,
          event_id: i.eventId,
          reason_categories: [...(i.reasonCategories ?? [])],
          ...(i.dueAtMs === undefined ? {} : { due_at: TS(i.dueAtMs) }),
          locked_ticket_ids: [...(i.lockedTicketIds ?? (Array.isArray(result.lockedTicketIds) ? result.lockedTicketIds.map(String) : []))],
          lock_active: i.lockActive,
          ...(i.lockExpiresAtMs === undefined || i.lockExpiresAtMs === null ? {} : { lock_expires_at: TS(i.lockExpiresAtMs) }),
          state: stateName,
          version: i.version,
          ...(i.objectionDueAtMs === null ? {} : { objection_due_at: TS(i.objectionDueAtMs) }),
          ...(i.objectionState ? { objection_state: i.objectionState } : {}),
          ...(i.objectionNote ? { objection_note: i.objectionNote } : {}),
          ...(i.restrictedUntilMs === undefined || i.restrictedUntilMs === null ? {} : { restricted_until: TS(i.restrictedUntilMs) }),
          ...(cancelled.length > 0 ? { cancelled_ticket_ids: cancelled } : {}),
          party: i.party ?? 'PAYER',
          held_ticket_ids: [...(i.heldTicketIds ?? [])],
          excluded_ticket_ids: [...(i.excludedTicketIds ?? [])],
        },
        metadata,
        { deadline: Date.now() + DEADLINE_MS },
        (e) => (e ? reject(e) : resolve()),
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}
