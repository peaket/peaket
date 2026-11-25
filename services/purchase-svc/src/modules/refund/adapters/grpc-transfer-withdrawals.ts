// ticket-svc TicketTransferService.WithdrawTransfersForEvent 클라이언트(F-05-11 R-T25 ③, docs/features/transfer-refund.md §5).
// 연기(POSTPONE) 확정 시작 때 한 번 부르고, 실패·모르는 답은 던져 확정이 503으로 끝나게 한다(아무것도 쓰지 않는다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import type { EventTransferWithdrawals } from '../domain/event-refund-ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** 확정 시작을 기다리는 한도 5초 [가정](정본 §5의 503 경계) */
const WITHDRAW_DEADLINE_MS = 5_000;
const CALLER = 'purchase-svc';
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export interface GrpcTransferWithdrawalsOptions {
  readonly address: string;
  readonly profile?: GrpcLbProfile;
  readonly internalToken?: string;
}

export class GrpcTransferWithdrawals implements EventTransferWithdrawals {
  readonly #client: grpc.Client & { WithdrawTransfersForEvent: Unary };

  constructor(o: GrpcTransferWithdrawalsOptions) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: { TicketTransferService: grpc.ServiceClientConstructor } } } }).peaket.ticket.v1;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`PEAKET_TICKET_GRPC_ADDR는 host:port여야 한다: ${o.address}`);
    this.#client = createGrpcClient(pkg.TicketTransferService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'ticket-svc',
      timeoutCapMs: WITHDRAW_DEADLINE_MS,
      caller: CALLER,
      ...(o.internalToken ? { internalToken: o.internalToken } : {}),
    }) as unknown as grpc.Client & { WithdrawTransfersForEvent: Unary };
  }

  async withdrawForEvent(q: { eventId: string; nowMs: number }): Promise<{ withdrawn: readonly string[] }> {
    const v = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.WithdrawTransfersForEvent(
        { event_id: q.eventId, reason: 'EVENT_POSTPONED', now_ms: q.nowMs },
        new grpc.Metadata(),
        { deadline: new Date(Date.now() + WITHDRAW_DEADLINE_MS) },
        (e, r) => (e ? reject(e) : resolve(r ?? {})),
      );
    });
    const rows = Array.isArray(v.withdrawn) ? (v.withdrawn as unknown[]) : [];
    if (!rows.every((x) => typeof x === 'string')) throw new Error('철회 답의 모양이 틀렸다');
    return { withdrawn: rows as string[] };
  }

  close(): void {
    this.#client.close();
  }
}
