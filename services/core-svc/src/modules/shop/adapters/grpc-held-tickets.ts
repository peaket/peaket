// ticket-svc TicketService.ListHeldTickets 클라이언트(docs/api/proto/peaket/ticket/v1/ticket.proto, ADR-0301 결정 1).
// 그 계정이 지금 가진 그 회차의 유효한 티켓(ISSUED·ACTIVE) ID를 읽는다. 데드라인 300ms [가정]. 실패(UNAVAILABLE·시간 초과 등)는 HeldTicketsUnavailable(→ 503)이다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { hostPort } from '../../catalog/index.js';
import { type HeldTicketsPort, HeldTicketsUnavailable } from '../domain/merch-ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** 부르는 쪽 데드라인 300ms [가정](ADR-0301 결정 1) */
export const HELD_TICKETS_DEADLINE_MS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID = new Set(['TICKET_STATUS_ISSUED', 'TICKET_STATUS_ACTIVE']);

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcHeldTickets implements HeldTicketsPort {
  readonly #client: grpc.Client & { ListHeldTickets: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: Record<string, unknown> } } }).peaket.ticket.v1;
    const { host, port } = hostPort(address, 'PEAKET_TICKET_GRPC_URL');
    this.#client = createGrpcClient(pkg.TicketService as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'ticket-svc', timeoutCapMs: HELD_TICKETS_DEADLINE_MS }) as unknown as grpc.Client & {
      ListHeldTickets: Unary;
    };
  }

  async held(accountId: string, eventId: string): Promise<string[]> {
    const v = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.ListHeldTickets({ account_id: accountId, event_id: eventId }, new grpc.Metadata(), { deadline: Date.now() + HELD_TICKETS_DEADLINE_MS }, (e, res) =>
        e ? reject(new HeldTicketsUnavailable(grpc.status[e.code] ?? String(e.code))) : resolve(res ?? {}),
      );
    });
    if (!Array.isArray(v.tickets)) throw new HeldTicketsUnavailable('INVALID_RESPONSE');
    const out: string[] = [];
    for (const t of v.tickets as Record<string, unknown>[]) {
      const id = typeof t.ticket_id === 'string' ? t.ticket_id.toLowerCase() : '';
      if (!UUID.test(id)) throw new HeldTicketsUnavailable('INVALID_RESPONSE');
      // 서버가 ISSUED·ACTIVE만 주지만 다른 상태가 섞여 와도 보유로 세지 않는다
      if (typeof t.status === 'string' && VALID.has(t.status)) out.push(id);
    }
    return out;
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소(PEAKET_TICKET_GRPC_URL)가 없을 때: 늘 확인 못 함(→ 503) */
export const unavailableHeldTickets: HeldTicketsPort = {
  held: async () => {
    throw new HeldTicketsUnavailable('UNWIRED');
  },
};

/** 시험·개발용: (계정, 회차) → 티켓 ID 목록. failing이면 확인 못 함 */
export class MemoryHeldTickets implements HeldTicketsPort {
  readonly rows = new Map<string, string[]>();
  failing = false;
  readonly calls: { accountId: string; eventId: string }[] = [];

  set(accountId: string, eventId: string, ticketIds: string[]): void {
    this.rows.set(`${accountId}:${eventId}`, ticketIds);
  }

  async held(accountId: string, eventId: string): Promise<string[]> {
    this.calls.push({ accountId, eventId });
    if (this.failing) throw new HeldTicketsUnavailable('UNAVAILABLE');
    return this.rows.get(`${accountId}:${eventId}`) ?? [];
  }
}
