// 받는 쪽: gRPC TicketService(docs/api/proto/peaket/ticket/v1/ticket.proto)의 최소 처리기(BUILD_ORDER HOT-160).
// IssueTickets·CancelTickets·ListTickets만 채운다. 나머지 RPC는 grpc-js가 UNIMPLEMENTED로 답한다.
// 오류: TicketInputError → INVALID_ARGUMENT, TicketConflictError → FAILED_PRECONDITION, 그 밖 → INTERNAL.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { TicketService } from '../application/ticket-service.js';
import { TicketConflictError, TicketInputError } from '../domain/ticket.js';

export interface TicketPackage {
  TicketService: grpc.ServiceClientConstructor;
  ScannerDeviceLookupService: grpc.ServiceClientConstructor;
  ScannerDeviceService: grpc.ServiceClientConstructor;
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
/** 운영자 취소를 부를 수 있는 호출자(내부 gRPC 호출자 머리, docs/features/transfer-refund.md §7.4 '호출자') */
const OPERATOR_CANCEL_CALLER = 'purchase-svc';

/**
 * o.internalToken: 있으면 OperatorCancelTickets는 내부 토큰과 호출자 purchase-svc를 요구한다. 틀리면(토큰 없음·틀림·다른 호출자) PERMISSION_DENIED이고
 * 쓰임새를 부르지 않는다(리뷰 B6, ASVS v5.0.0-8.2.1). 다른 메서드의 부르는 쪽 검사는 이번에 바꾸지 않는다. 토큰이 없는 local·ci 조립은 지금처럼 받는다
 */
export function ticketServiceHandlers(useCases: TicketGrpcUseCases, onError: TicketGrpcErrorLog, o?: { readonly internalToken?: string }): grpc.UntypedServiceImplementation {
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
          // 공연 시작 뒤 다시 누른 팬 취소의 확인(행을 바꾸지 않는다, 리뷰 B2 보충)
          ...(req.replay_only === true ? { replayOnly: true } : {}),
        })
        .then((outcomes) => {
          cb(null, {
            outcomes: outcomes.map((x) => ({
              ticket_id: x.ticketId,
              result: `CANCEL_TICKET_RESULT_${x.result}`,
              // ALREADY_CANCELLED에 먼저 키를 폐기한 팬 취소(리뷰 B2). 없으면 세 칸을 비운다
              ...(x.first
                ? { first_cancellation_id: x.first.cancellationId, first_result: `CANCEL_TICKET_RESULT_${x.first.result}`, first_cancelled_at: timestampOf(x.first.cancelledAtMs) }
                : {}),
            })),
          });
        })
        .catch((err: unknown) => fail('CancelTickets', err, orderId, cb, onError));
    },

    // 부정 예매 운영자 취소(BAT-415 몫 F, docs/features/transfer-refund.md §7.4). 오류는 TicketInputError → INVALID_ARGUMENT. 답은 요청 차례다
    OperatorCancelTickets: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: OPERATOR_CANCEL_CALLER }).ok) {
        cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
        return;
      }
      const req = call.request;
      const targets = Array.isArray(req.targets) ? (req.targets as Req[]) : [];
      useCases.ticket
        .operatorCancel({
          approvalId: text(req.approval_id),
          fraudCaseId: text(req.fraud_case_id),
          eventId: text(req.event_id),
          targets: targets.map((t) => ({ ticketId: text(t.ticket_id), expectedHolderAccountId: text(t.expected_holder_account_id) })),
          nowMs: useCases.nowMs?.() ?? Date.now(),
        })
        .then((outcomes) => {
          cb(null, {
            outcomes: outcomes.map((o) => ({
              ticket_id: o.ticketId,
              result: `OPERATOR_CANCEL_RESULT_${o.result}`,
              order_id: o.orderId,
              withdrawn_transfer_offer_id: o.withdrawnTransferOfferId ?? '',
            })),
          });
        })
        .catch((err: unknown) => fail('OperatorCancelTickets', err, undefined, cb, onError));
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
