// 받는 층: gRPC WithdrawalParticipantService.ProcessAccountWithdrawal·QuoteAccountWithdrawal(docs/api/proto/peaket/purchase/v1/account.proto,
// docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현' '계약' '미사용 티켓 견적', ADR-0284, BUILD_ORDER PRF-169·PRF-174, P-T55 ⑥·I-T26 ①).
// 꼴은 booking-restriction.grpc.ts, 호출자 확인은 refund/inbound/event-refund.grpc.ts와 같다.
// 부르는 쪽은 identity-svc만이다. 내부 토큰이 설정되면 두 RPC 모두 토큰이 없거나 틀린 호출은 UNAUTHENTICATED, 부르는 쪽 이름이 identity-svc가 아니면 PERMISSION_DENIED다
// (서버 가로채기도 토큰을 본다, start.ts internal.services). 계정 ID가 소문자 UUID가 아니면 INVALID_ARGUMENT이고 아무것도 읽지 않는다.
// purchase DB에 닿지 못하면 두 RPC 모두 UNAVAILABLE, 그 밖의 오류는 INTERNAL이다. 마감 시각은 호출의 gRPC 데드라인이다(없으면 마감 없음).
// QuoteAccountWithdrawal을 주지 않은 조립(옛 시험)은 process만 연다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { QuoteAccountWithdrawal } from '../application/quote-account-withdrawal.js';
import type { ProcessAccountWithdrawal, ProcessAccountWithdrawalResult } from '../application/process-account-withdrawal.js';
import { type UnusedTicketsQuote, WithdrawalOrdersUnavailable } from '../domain/ports.js';

export interface WithdrawalParticipantPackage {
  WithdrawalParticipantService: grpc.ServiceClientConstructor;
}
const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
let pkg: WithdrawalParticipantPackage | undefined;
export function withdrawalParticipantPackage(): WithdrawalParticipantPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: WithdrawalParticipantPackage } } }).peaket.purchase.v1;
  }
  return pkg;
}

/** 부르는 쪽 이름(내부 gRPC 호출자 머리) */
export const WITHDRAWAL_PARTICIPANT_CALLER = 'identity-svc';
const ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Req = Record<string, unknown>;

export interface WithdrawalParticipantHandlerOptions {
  /** 내부 gRPC 토큰. 있으면 토큰과 호출자 identity-svc를 본다(local·ci는 없다) */
  internalToken?: string;
  onError: (method: string, err: unknown) => void;
}

/** 결과 → 응답(enum은 이름) */
function responseOf(r: ProcessAccountWithdrawalResult): object {
  return {
    state: r.state === 'DONE' ? 'WITHDRAWAL_PARTICIPANT_STATE_DONE' : 'WITHDRAWAL_PARTICIPANT_STATE_PENDING',
    reasons: r.state === 'DONE' ? [] : r.reasons.map((x) => `WITHDRAWAL_PENDING_REASON_${x}`),
    payment_pending_orders: r.paymentPendingOrders,
    deposit_orders_cancelled: r.depositOrdersCancelled,
    deposit_orders_pending: r.depositOrdersPending,
    unused_tickets_cancelled: r.unusedTicketsCancelled,
    unused_tickets_pending: r.unusedTicketsPending,
  };
}

/** 견적 → 응답(이름은 proto 그대로) */
function quoteResponseOf(q: UnusedTicketsQuote): object {
  return {
    unused_tickets: q.count,
    ticket_amount: q.ticketAmount,
    deduction_amount: q.deductionAmount,
    refund_amount: q.refundAmount,
    transferable_tickets: q.transferableCount,
    refund_deferred_tickets: q.deferredRefundCount,
  };
}

/** gRPC 데드라인 → 마감 시각(ms). 없거나 무한이면 Infinity */
function deadlineAtOf(call: grpc.ServerUnaryCall<Req, object>): number {
  const d = call.getDeadline();
  const ms = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Number.POSITIVE_INFINITY;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** 두 RPC가 함께 쓰는 검사(내부 토큰·호출자, 계정 ID 모양). 통과하면 계정 ID를 돌려준다 */
function accountOf(call: grpc.ServerUnaryCall<Req, object>, o: WithdrawalParticipantHandlerOptions): { accountId: string } | { error: grpc.ServiceError } {
  if (o.internalToken !== undefined) {
    const verified = verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: WITHDRAWAL_PARTICIPANT_CALLER });
    if (!verified.ok) {
      return {
        error:
          verified.reason === 'token'
            ? ({ code: grpc.status.UNAUTHENTICATED, details: '내부 gRPC 토큰이 필요하다' } as grpc.ServiceError)
            : ({ code: grpc.status.PERMISSION_DENIED, details: '내부 호출자만 부를 수 있다' } as grpc.ServiceError),
      };
    }
  }
  const accountId = typeof call.request.account_id === 'string' ? call.request.account_id : '';
  if (!ACCOUNT_UUID.test(accountId)) return { error: { code: grpc.status.INVALID_ARGUMENT, details: '계정 ID는 소문자 UUID여야 한다' } as grpc.ServiceError };
  return { accountId };
}

/** 오류 → gRPC 상태. DB·판매 설정에 닿지 못했으면 UNAVAILABLE, 그 밖은 INTERNAL(로그 한 줄) */
function failWith(method: string, err: unknown, o: WithdrawalParticipantHandlerOptions): grpc.ServiceError {
  if (err instanceof WithdrawalOrdersUnavailable) return { code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' } as grpc.ServiceError;
  o.onError(method, err);
  return { code: grpc.status.INTERNAL, details: '처리하지 못했다' } as grpc.ServiceError;
}

export function withdrawalParticipantHandlers(
  service: Pick<ProcessAccountWithdrawal, 'run'> & { quote?: Pick<QuoteAccountWithdrawal, 'run'> },
  o: WithdrawalParticipantHandlerOptions,
): grpc.UntypedServiceImplementation {
  const ProcessAccountWithdrawal: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const checked = accountOf(call, o);
    if ('error' in checked) {
      cb(checked.error);
      return;
    }
    service.run({ accountId: checked.accountId, deadlineAtMs: deadlineAtOf(call) }).then(
      (r) => cb(null, responseOf(r)),
      (err: unknown) => cb(failWith('ProcessAccountWithdrawal', err, o)),
    );
  };
  const handlers: grpc.UntypedServiceImplementation = { ProcessAccountWithdrawal };
  // 견적 RPC는 그 쓰임새를 준 조립에서만 연다(옛 시험은 Process만 부른다)
  if (service.quote) {
    const quote = service.quote;
    handlers.QuoteAccountWithdrawal = (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const checked = accountOf(call, o);
      if ('error' in checked) {
        cb(checked.error);
        return;
      }
      quote.run({ accountId: checked.accountId, deadlineAtMs: deadlineAtOf(call) }).then(
        (q) => cb(null, quoteResponseOf(q)),
        (err: unknown) => cb(failWith('QuoteAccountWithdrawal', err, o)),
      );
    };
  }
  return handlers;
}
