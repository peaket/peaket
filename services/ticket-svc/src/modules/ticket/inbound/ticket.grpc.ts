// 받는 쪽: gRPC TicketService(docs/api/proto/peaket/ticket/v1/ticket.proto)의 최소 처리기(BUILD_ORDER HOT-160).
// IssueTickets·BlockTicketIssuance·CancelTickets·OperatorCancelTickets·EventCancelTickets·GetEntryRecords·CheckReviewEligibility·ListHeldTickets(ADR-0301 결정 1)·ListTickets를 채운다. 나머지 RPC는 grpc-js가 UNIMPLEMENTED로 답한다.
// 오류: TicketInputError → INVALID_ARGUMENT, TicketConflictError·TicketIssueBlockedError → FAILED_PRECONDITION, 그 밖 → INTERNAL.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { TicketService } from '../application/ticket-service.js';
import { TransferError } from '../application/transfers.js';
import { TicketConflictError, TicketInputError, TicketIssueBlockedError, TicketReclaimError } from '../domain/ticket.js';

export interface TicketPackage {
  TicketService: grpc.ServiceClientConstructor;
  ScannerDeviceLookupService: grpc.ServiceClientConstructor;
  ScannerDeviceService: grpc.ServiceClientConstructor;
  TransferLockService: grpc.ServiceClientConstructor;
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
/**
 * 운영자 취소·회차 취소 표 끝내기·입장 기록 대조를 부를 수 있는 호출자(내부 gRPC 호출자 머리, docs/features/transfer-refund.md §7.4 '호출자'·§5 ⑴·§3.1 ①)
 */
const OPERATOR_CANCEL_CALLER = 'purchase-svc';

/**
 * o.internalToken: 있으면 OperatorCancelTickets·EventCancelTickets·GetEntryRecords·BlockTicketIssuance는 내부 토큰과 호출자 purchase-svc를 요구한다.
 * 틀리면(토큰 없음·틀림·다른 호출자) PERMISSION_DENIED이고 쓰임새를 부르지 않는다(리뷰 B6, BAT-420 리뷰 D4, BAT-011 ASVS v5.0.0-8.2.1).
 * 다른 메서드의 부르는 쪽 검사는 바꾸지 않는다. 토큰이 없는 local·ci 조립은 지금처럼 받는다
 */
export function ticketServiceHandlers(useCases: TicketGrpcUseCases, onError: TicketGrpcErrorLog, o?: { readonly internalToken?: string }): grpc.UntypedServiceImplementation {
  /** 내부 토큰이 있으면 호출자 purchase-svc만 받는다. 거절했으면 cb로 PERMISSION_DENIED를 보내고 false */
  const purchaseOnly = (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>): boolean => {
    if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: OPERATOR_CANCEL_CALLER }).ok) {
      cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
      return false;
    }
    return true;
  };
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

    // 주문 단위 발권 막기(BAT-011 HOT-161, PRF-173의 compFence). 주문 ID로 멱등하고, 이미 만든 티켓을 무효로 한다.
    // 부르는 쪽은 purchase-svc만 받는다(내부 토큰·호출자 머리, ASVS v5.0.0-8.2.1)
    BlockTicketIssuance: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (!purchaseOnly(call, cb)) return;
      const req = call.request;
      const orderId = text(req.order_id);
      useCases.ticket
        .blockIssue({
          orderId,
          ...(text(req.reason) !== '' ? { reason: text(req.reason) } : {}),
          nowMs: useCases.nowMs?.() ?? Date.now(),
        })
        .then((r) => {
          cb(null, { voided: r.voided, already_entered: r.alreadyEntered });
        })
        .catch((err: unknown) => fail('BlockTicketIssuance', err, orderId, cb, onError));
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
          // 취소 사유(다시 보기 R1). 비우면 사유 없는 기록이다
          ...(text(req.reason) !== '' ? { reason: text(req.reason) } : {}),
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
      if (!purchaseOnly(call, cb)) return;
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

    // 회차 취소 일괄 환불의 티켓 단계(BAT-420 GAT-110 E, R-T24). 오류는 TicketInputError → INVALID_ARGUMENT. 답은 요청 차례다.
    // 결제자·보유자 검사를 건너뛰는 호출이라 호출자 purchase-svc만 받는다(BAT-420 리뷰 D4)
    EventCancelTickets: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (!purchaseOnly(call, cb)) return;
      const req = call.request;
      const targets = Array.isArray(req.targets) ? (req.targets as Req[]) : [];
      useCases.ticket
        .eventCancel({
          cancellationRequestId: text(req.cancellation_request_id),
          eventId: text(req.event_id),
          targets: targets.map((t) => ({ ticketId: text(t.ticket_id), cancellationId: text(t.cancellation_id) })),
          nowMs: useCases.nowMs?.() ?? Date.now(),
        })
        .then((outcomes) => {
          cb(null, {
            outcomes: outcomes.map((x) => ({
              ticket_id: x.ticketId,
              result: `EVENT_CANCEL_RESULT_${x.result}`,
              order_id: x.orderId,
              holder_account_id: x.holderAccountId,
              transfer_withdrawn: x.transferWithdrawn,
            })),
          });
        })
        .catch((err: unknown) => fail('EventCancelTickets', err, undefined, cb, onError));
    },

    // 입장 기록 대조(BAT-420 GAT-090 A, P-T19). 읽기만 한다. 답은 요청 차례이고 입장이 없으면 first_entered_at을 비운다. 호출자 purchase-svc만 받는다(BAT-420 리뷰 D4)
    GetEntryRecords: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (!purchaseOnly(call, cb)) return;
      const req = call.request;
      useCases.ticket
        .entryRecords(Array.isArray(req.ticket_ids) ? req.ticket_ids.map(text) : [])
        .then((records) => {
          cb(null, {
            records: records.map((x) => ({
              ticket_id: x.ticketId,
              found: x.found,
              entered: x.entered,
              ...(x.firstEnteredAtMs !== undefined ? { first_entered_at: timestampOf(x.firstEnteredAtMs) } : {}),
            })),
          });
        })
        .catch((err: unknown) => fail('GetEntryRecords', err, undefined, cb, onError));
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

    // 보유 티켓 확인(ADR-0301 결정 1, 부르는 쪽 core-svc shop). 읽기만 한다. 소문자 UUID가 아니면 INVALID_ARGUMENT. 티켓 키·좌석은 싣지 않는다
    ListHeldTickets: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const req = call.request;
      useCases.ticket
        .heldTickets({ accountId: text(req.account_id), eventId: text(req.event_id) })
        .then((tickets) => {
          cb(null, { tickets: tickets.map((t) => ({ ticket_id: t.ticketId, status: statusOf(t.status) })) });
        })
        .catch((err: unknown) => fail('ListHeldTickets', err, undefined, cb, onError));
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

    // 양도 회수 승인 전 대상 확인(F-06-3 IR-01·IR-08). 부르는 쪽은 ops-svc뿐이다.
    GetReclaimBasis: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: 'ops-svc' }).ok) {
        cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
        return;
      }
      useCases.ticket
        .reclaimBasis(text(call.request.ticket_id))
        .then((b) => {
          if (!b) {
            cb({ code: grpc.status.NOT_FOUND, details: '티켓을 찾지 못했습니다' });
            return;
          }
          cb(null, {
            ticket_id: b.ticketId,
            payer_account_id: b.payerAccountId,
            holder_account_id: b.holderAccountId,
            ...(b.entryStartsAtMs !== undefined ? { entry_starts_at: timestampOf(b.entryStartsAtMs) } : {}),
            entry_recorded: b.entryRecorded,
            status: b.status,
          });
        })
        .catch((err: unknown) => fail('GetReclaimBasis', err, undefined, cb, onError));
    },

    // 양도 회수(F-06-3). 부르는 쪽은 ops-svc뿐이다. 티켓 행 잠금 안에서 조건을 다시 보고, 승인 ID로 멱등하다.
    ReclaimTransfer: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: 'ops-svc' }).ok) {
        cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
        return;
      }
      const req = call.request;
      useCases.ticket
        .reclaimTransfer({
          approvalId: text(req.approval_id),
          ticketId: text(req.ticket_id),
          expectedPayerAccountId: text(req.expected_payer_account_id),
          expectedHolderAccountId: text(req.expected_holder_account_id),
          deadlineMs: typeof req.deadline_ms === 'number' ? req.deadline_ms : Number.NaN,
        })
        .then((r) => {
          cb(null, {
            result: r.result,
            ticket_id: r.ticketId,
            ...(r.previousHolderAccountId ? { previous_holder_account_id: r.previousHolderAccountId } : {}),
          });
        })
        .catch((err: unknown) => fail('ReclaimTransfer', err, undefined, cb, onError));
    },
  };
}

function fail(method: string, err: unknown, orderId: string | undefined, cb: grpc.sendUnaryData<Req>, onError: TicketGrpcErrorLog): void {
  if (err instanceof TicketReclaimError) {
    const code =
      err.code === 'ALREADY_EXISTS'
        ? grpc.status.ALREADY_EXISTS
        : err.code === 'FAILED_PRECONDITION'
          ? grpc.status.FAILED_PRECONDITION
          : err.code === 'INVALID_ARGUMENT'
            ? grpc.status.INVALID_ARGUMENT
            : grpc.status.NOT_FOUND;
    onError(method, err, orderId);
    cb({ code, details: err.message });
    return;
  }
  const invalid = err instanceof TicketInputError || (err instanceof TransferError && err.code === 'INVALID_INPUT');
  const code = invalid
    ? grpc.status.INVALID_ARGUMENT
    : err instanceof TicketConflictError || err instanceof TicketIssueBlockedError
      ? grpc.status.FAILED_PRECONDITION
      : grpc.status.INTERNAL;
  onError(method, err, orderId);
  cb({
    code,
    details: invalid || err instanceof TicketConflictError ? err.message : err instanceof TicketIssueBlockedError ? '이 주문의 발권은 막혔습니다' : 'ticket 처리 실패',
  });
}

// ---- 부정 예매 양도 잠금 TransferLockService(BUILD_ORDER GAT-055, ticket.proto, docs/features/transfer-refund.md §4.1) ----

/** TransferLockService의 잠금 판정 유스케이스(Transfers.setTransferLock). 시험은 가짜를 넣는다 */
export interface TransferLockUseCases {
  setTransferLock(input: {
    readonly caseId: string;
    readonly version: number;
    readonly locked: boolean;
    readonly eventId: string;
    readonly accountIds: readonly string[];
    readonly expiresAtMs?: number;
    readonly nowMs: number;
  }): Promise<readonly { readonly ticketId: string; readonly result: string; readonly withdrawnOfferId?: string; readonly holderAccountId?: string }[]>;
}

/** 부르는 쪽은 ops-svc뿐이다(§4.1, authz-matrix). 내부 토큰이 설정된 조립은 토큰과 호출자 머리 ops-svc를 요구한다 */
const TRANSFER_LOCK_CALLER = 'ops-svc';

export function transferLockHandlers(useCases: TransferLockUseCases, onError: TicketGrpcErrorLog, o?: { readonly internalToken?: string }): grpc.UntypedServiceImplementation {
  return {
    SetTransferLock: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: TRANSFER_LOCK_CALLER }).ok) {
        cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
        return;
      }
      const req = call.request;
      const expiresAtMs = msOf(req.expires_at);
      useCases
        .setTransferLock({
          caseId: text(req.case_id),
          version: typeof req.version === 'number' ? req.version : 0,
          locked: req.locked === true,
          eventId: text(req.event_id),
          accountIds: Array.isArray(req.account_ids) ? req.account_ids.map(text) : [],
          ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
          nowMs: Date.now(),
        })
        .then((outcomes) => {
          cb(null, {
            outcomes: outcomes.map((x) => ({
              ticket_id: x.ticketId,
              result: `TRANSFER_LOCK_RESULT_${x.result}`,
              withdrawn_offer_id: x.withdrawnOfferId ?? '',
              holder_account_id: x.holderAccountId ?? '',
            })),
          });
        })
        .catch((err: unknown) => fail('SetTransferLock', err, undefined, cb, onError));
    },
  };
}
