// 받는 층: gRPC FraudCancellationService(docs/api/proto/peaket/purchase/v1/fraud_cancellation.proto, BUILD_ORDER GAT-080, ADR-0197).
// 부르는 쪽은 ops-svc뿐이다(내부 토큰 + 호출자 ops-svc + 처리자 approved_by 증명, docs/features/transfer-refund.md §7.4).
// 내부 토큰 자체는 서버 인터셉터가 먼저 본다(없거나 틀리면 UNAUTHENTICATED). 처리기는 토큰이 있을 때 호출자·처리자를 다시 보고, 틀리면 쓰임새를 부르지 않고 PERMISSION_DENIED다.
// 토큰을 두지 않은 local·ci 조립은 지금처럼 받는다. 알 수 없는 오류는 원문 없이 INTERNAL로 답하고 onError로만 남긴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Fraudcancellation } from '@peaket/contracts/proto';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { CancelFraudTickets } from '../application/cancel-fraud-tickets.js';
import type { GetFraudCancellation } from '../application/get-fraud-cancellation.js';
import { FraudCancellationError, type FraudRefundProgress, type FraudTicketResult } from '../domain/fraud-cancellation.js';

export interface FraudCancellationPackage {
  FraudCancellationService: grpc.ServiceClientConstructor;
}

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** 부르는 쪽 서비스 이름(내부 gRPC 호출자 머리) */
const OPS_CALLER = 'ops-svc';
/** ticket-svc OperatorCancelTickets 한 번의 데드라인 5초 [가정](docs/api/guidelines.md §8.1) */
const TICKET_STEP_DEADLINE_MS = 5_000;

let pkg: FraudCancellationPackage | undefined;

/** peaket.purchase.v1 패키지(계약 설명자에서 한 번 만든다) */
export function fraudCancellationPackage(): FraudCancellationPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(purchaseV1Fraudcancellation as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: FraudCancellationPackage } } }).peaket.purchase.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const childOf = (v: unknown): Req | undefined => (typeof v === 'object' && v !== null ? (v as Req) : undefined);
const msOf = (v: unknown): number | undefined => {
  const t = childOf(v);
  return t ? Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000) : undefined;
};
const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

const resultView = (r: FraudTicketResult): Req => ({
  ticket_id: r.ticketId,
  outcome: `FRAUD_CANCELLATION_OUTCOME_${r.outcome}`,
  ...(r.cancellationId !== undefined ? { cancellation_id: r.cancellationId } : {}),
  ...(r.refundAmount !== undefined ? { refund_amount: { krw: r.refundAmount } } : {}),
  ...(r.withdrawnTransferOfferId !== undefined ? { withdrawn_transfer_offer_id: r.withdrawnTransferOfferId } : {}),
  ...(r.failureCode !== undefined ? { failure_code: r.failureCode } : {}),
});
const refundView = (r: FraudRefundProgress): Req => ({
  ticket_id: r.ticketId,
  cancellation_id: r.cancellationId,
  state: `FRAUD_REFUND_STATE_${r.state}`,
  ...(r.refundedAtMs !== undefined ? { refunded_at: timestampOf(r.refundedAtMs) } : {}),
});

const CODE_OF: Readonly<Record<FraudCancellationError['code'], grpc.status>> = {
  INVALID: grpc.status.INVALID_ARGUMENT,
  ALREADY_EXISTS: grpc.status.ALREADY_EXISTS,
  DEADLINE_PASSED: grpc.status.FAILED_PRECONDITION,
  NOT_FOUND: grpc.status.NOT_FOUND,
};

export function fraudCancellationHandlers(
  u: { cancel: Pick<CancelFraudTickets, 'execute'>; get: Pick<GetFraudCancellation, 'execute'>; nowMs?: () => number },
  o?: { internalToken?: string; onError?: (method: string, err: unknown) => void },
): grpc.UntypedServiceImplementation {
  const token = o?.internalToken;
  /** 토큰이 있으면 호출자(와 처리자)를 본다. 통과면 undefined, 아니면 돌려줄 오류 */
  const denied = (metadata: grpc.Metadata, actor?: string): grpc.ServiceError | undefined => {
    if (!token) return undefined;
    const r = verifyInternalGrpcActor(metadata, token, { caller: OPS_CALLER, ...(actor !== undefined ? { actor } : {}) });
    if (r.ok) return undefined;
    return { code: r.reason === 'token' ? grpc.status.UNAUTHENTICATED : grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' } as grpc.ServiceError;
  };
  const fail = (method: string, err: unknown): grpc.ServiceError => {
    if (err instanceof FraudCancellationError) return { code: CODE_OF[err.code], details: err.message } as grpc.ServiceError;
    o?.onError?.(method, err);
    return { code: grpc.status.INTERNAL, details: '처리하지 못했다' } as grpc.ServiceError;
  };

  const cancel: grpc.handleUnaryCall<Req, Req> = (call, cb) => {
    const r = call.request;
    const approvedBy = text(r.approved_by);
    const refused = denied(call.metadata, approvedBy);
    if (refused) {
      cb(refused);
      return;
    }
    const approvedAtMs = msOf(r.approved_at);
    const targets = Array.isArray(r.targets) ? (r.targets as unknown[]).map((t) => childOf(t) ?? {}) : [];
    u.cancel
      .execute({
        approvalId: text(r.approval_id),
        fraudCaseId: text(r.fraud_case_id),
        eventId: text(r.event_id),
        targets: targets.map((t) => ({ ticketId: text(t.ticket_id), expectedHolderAccountId: text(t.expected_holder_account_id) })),
        requestedBy: text(r.requested_by),
        approvedBy,
        ...(approvedAtMs !== undefined ? { approvedAtMs } : {}),
        nowMs: u.nowMs?.() ?? Date.now(),
        deadlineMs: TICKET_STEP_DEADLINE_MS,
      })
      .then(
        (results) => cb(null, { results: results.map(resultView) }),
        (err: unknown) => cb(fail('CancelFraudTickets', err)),
      );
  };

  const get: grpc.handleUnaryCall<Req, Req> = (call, cb) => {
    const refused = denied(call.metadata);
    if (refused) {
      cb(refused);
      return;
    }
    u.get.execute(text(call.request.approval_id)).then(
      (v) => cb(null, { results: v.results.map(resultView), refunds: v.refunds.map(refundView) }),
      (err: unknown) => cb(fail('GetFraudCancellation', err)),
    );
  };

  return { CancelFraudTickets: cancel, GetFraudCancellation: get };
}
