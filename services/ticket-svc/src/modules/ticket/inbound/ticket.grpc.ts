// 받는 쪽: gRPC TicketService(docs/api/proto/peaket/ticket/v1/ticket.proto)의 최소 처리기(BUILD_ORDER HOT-160).
// IssueTickets·CancelTickets·ListTickets만 채운다. 나머지 RPC는 grpc-js가 UNIMPLEMENTED로 답한다.
// 오류: TicketInputError → INVALID_ARGUMENT, TicketConflictError → FAILED_PRECONDITION, 그 밖 → INTERNAL.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import type { TicketService } from '../application/ticket-service.js';
import { TicketConflictError, TicketInputError } from '../domain/ticket.js';

export interface TicketPackage {
  TicketService: grpc.ServiceClientConstructor;
  ScannerDeviceLookupService: grpc.ServiceClientConstructor;
}

/** 이름은 proto 그대로, enum은 이름, int64는 숫자로 읽는다. */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

let pkg: TicketPackage | undefined;
/** peaket.ticket.v1 패키지(계약 설명에서 만든다). */
export function ticketPackage(): TicketPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: TicketPackage } } }).peaket.ticket.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const childOf = (v: unknown): Req | undefined => (typeof v === 'object' && v !== null ? (v as Req) : undefined);
const msOf = (v: unknown): number | undefined => {
  const t = childOf(v);
  return t && Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000);
};
const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const statusOf = (s: string): string => `TICKET_STATUS_${s}`;

export interface TicketGrpcUseCases {
  readonly ticket: TicketService;
  /** 취소 시각. 없으면 Date.now(). 시험은 고정 시계를 넣는다. */
  readonly nowMs?: () => number;
}

export interface TicketGrpcErrorLog {
  (method: string, err: unknown, orderId?: string): void;
}

/** gRPC 처리기 묶음. 테스트는 startGrpcServer에 그대로 넘긴다. */
export function ticketServiceHandlers(useCases: TicketGrpcUseCases, onError: TicketGrpcErrorLog): grpc.UntypedServiceImplementation {
  return {
    IssueTickets: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const req = call.request;
      const orderId = text(req.order_id);
      useCases.ticket
        .issue({
          orderId,
          eventId: text(req.event_id),
          payerAccountId: text(req.payer_account_id),
          seatIds: Array.isArray(req.seat_ids) ? req.seat_ids.map(text) : [],
          issueGeneration: typeof req.issue_generation === 'number' ? req.issue_generation : 0,
          ...(msOf(req.event_starts_at) === undefined ? {} : { eventStartsAtMs: msOf(req.event_starts_at)! }),
        })
        .then((r) => {
          cb(null, {
            tickets: r.tickets.map((t) => ({
              ticket_id: t.ticketId,
              seat_id: t.seatId,
              status: statusOf(t.status),
              order_id: t.orderId,
              event_id: t.eventId,
              qr_payload: t.qrPayload,
              ...(t.ticketKey ? { ticket_key: t.ticketKey } : {}),
            })),
          });
        })
        .catch((err: unknown) => fail('IssueTickets', err, orderId, cb, onError));
    },

    CancelTickets: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const req = call.request;
      const orderId = text(req.order_id);
      useCases.ticket
        .cancel({
          orderId,
          ticketIds: Array.isArray(req.ticket_ids) ? req.ticket_ids.map(text) : [],
          requestedByAccountId: text(req.requested_by_account_id),
          cancellationId: text(req.cancellation_id),
          nowMs: useCases.nowMs?.() ?? Date.now(),
        })
        .then((outcomes) => {
          cb(null, { outcomes: outcomes.map((o) => ({ ticket_id: o.ticketId, result: `CANCEL_TICKET_RESULT_${o.result}` })) });
        })
        .catch((err: unknown) => fail('CancelTickets', err, orderId, cb, onError));
    },

    CheckReviewEligibility: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const req = call.request;
      const endsAtMs = msOf(req.event_ends_at);
      if (endsAtMs === undefined) {
        cb({ code: grpc.status.INVALID_ARGUMENT, message: 'event_ends_at이 없다' });
        return;
      }
      useCases.ticket
        .reviewEligibility({
          accountId: text(req.account_id),
          eventId: text(req.event_id),
          nowMs: useCases.nowMs?.() ?? Date.now(),
          eventEndsAtMs: endsAtMs,
        })
        .then((r) => {
          cb(null, {
            eligible: r.eligible,
            ...(r.basisOrderId ? { basis_order_id: r.basisOrderId } : {}),
            reason: r.reason ? `REVIEW_INELIGIBLE_REASON_${r.reason}` : 'REVIEW_INELIGIBLE_REASON_UNSPECIFIED',
          });
        })
        .catch((err: unknown) => fail('CheckReviewEligibility', err, text(req.event_id), cb, onError));
    },

    ListTickets: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const req = call.request;
      useCases.ticket
        .list({
          accountId: text(req.account_id),
          ...(text(req.cursor) ? { cursor: text(req.cursor) } : {}),
          limit: typeof req.limit === 'number' ? req.limit : 0,
        })
        .then((r) => {
          cb(null, {
            tickets: r.tickets.map((t) => ({
              ticket_id: t.ticketId,
              order_id: t.orderId,
              event_id: t.eventId,
              seat_id: t.seatId,
              status: statusOf(t.status),
              issued_at: timestampOf(t.issuedAtMs),
              qr_payload: t.qrPayload,
            })),
            ...(r.nextCursor ? { next_cursor: r.nextCursor } : {}),
          });
        })
        .catch((err: unknown) => fail('ListTickets', err, undefined, cb, onError));
    },
  };
}

function fail(method: string, err: unknown, orderId: string | undefined, cb: grpc.sendUnaryData<Req>, onError: TicketGrpcErrorLog): void {
  const code = err instanceof TicketInputError ? grpc.status.INVALID_ARGUMENT : err instanceof TicketConflictError ? grpc.status.FAILED_PRECONDITION : grpc.status.INTERNAL;
  onError(method, err, orderId);
  cb({ code, details: err instanceof TicketInputError || err instanceof TicketConflictError ? err.message : 'ticket 처리 실패' });
}
