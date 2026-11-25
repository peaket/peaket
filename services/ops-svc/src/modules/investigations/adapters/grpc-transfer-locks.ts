// ticket-svc TransferLockService gRPC 클라이언트. 사건 판·최대 기한·계정 목록을 그대로 넘긴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { TransferLocks } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 5_000;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcTransferLocks implements TransferLocks {
  readonly #client: grpc.Client & { SetTransferLock: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: Record<string, unknown> } } }).peaket.ticket.v1;
    const Ctor = pkg.TransferLockService as grpc.ServiceClientConstructor;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_TICKET_GRPC_URL은 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(Ctor, { host: address.slice(0, at), port, profile, dependency: 'ticket-svc', timeoutCapMs: DEADLINE_MS }) as unknown as grpc.Client & { SetTransferLock: Unary };
  }

  #call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      this.#client.SetTransferLock(req, new grpc.Metadata(), { deadline: Date.now() + DEADLINE_MS }, (e, v) => (e ? rej(e) : res(v ?? {})));
    });
  }

  async set(i: { caseId: string; eventId: string; accountIds: readonly string[]; version: number; expiresAtMs: number; actedBy: string }) {
    const out = await this.#call({
      case_id: i.caseId,
      version: i.version,
      locked: true,
      acted_by: i.actedBy,
      event_id: i.eventId,
      account_ids: [...i.accountIds],
      expires_at: { seconds: Math.floor(i.expiresAtMs / 1_000), nanos: (i.expiresAtMs % 1_000) * 1_000_000 },
    });
    const outcomes = Array.isArray(out.outcomes) ? (out.outcomes as Record<string, unknown>[]) : [];
    const holders = new Map<string, string[]>();
    let lockedTicketCount = 0;
    let withdrawnOfferCount = 0;
    for (const o of outcomes) {
      if (o.result === 'TRANSFER_LOCK_RESULT_LOCKED') lockedTicketCount += 1;
      if (typeof o.withdrawn_offer_id === 'string' && o.withdrawn_offer_id !== '') withdrawnOfferCount += 1;
      const holder = typeof o.holder_account_id === 'string' && o.holder_account_id !== '' ? o.holder_account_id : undefined;
      const ticket = typeof o.ticket_id === 'string' ? o.ticket_id : undefined;
      if (holder && ticket) {
        const list = holders.get(holder) ?? [];
        list.push(ticket);
        holders.set(holder, list);
      }
    }
    return { lockedTicketCount, withdrawnOfferCount, holders: [...holders].map(([accountId, ticketIds]) => ({ accountId, ticketIds })) };
  }

  async release(i: { caseId: string; eventId: string; accountIds: readonly string[]; version: number; actedBy: string }): Promise<void> {
    await this.#call({
      case_id: i.caseId,
      version: i.version,
      locked: false,
      acted_by: i.actedBy,
      event_id: i.eventId,
      account_ids: [...i.accountIds],
    });
  }

  close(): void {
    this.#client.close();
  }
}

export class UnavailableTransferLocks implements TransferLocks {
  async set(): Promise<never> {
    throw new Error('ticket-svc TransferLockService 주소가 없다');
  }
  async release(): Promise<never> {
    throw new Error('ticket-svc TransferLockService 주소가 없다');
  }
}
