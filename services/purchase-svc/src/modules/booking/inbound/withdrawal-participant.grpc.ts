// 받는 층: gRPC WithdrawalParticipantService.ProcessAccountWithdrawal(docs/api/proto/peaket/purchase/v1/account.proto, docs/features/payment.md §4.1
// '탈퇴 참여자의 첫 구현' '계약', ADR-0284, BUILD_ORDER PRF-169, P-T55 ⑥). 꼴은 booking-restriction.grpc.ts, 호출자 확인은 refund/inbound/event-refund.grpc.ts와 같다.
// 부르는 쪽은 identity-svc만이다. 내부 토큰이 설정되면 토큰이 없거나 틀린 호출은 UNAUTHENTICATED, 부르는 쪽 이름이 identity-svc가 아니면 PERMISSION_DENIED다
// (서버 가로채기도 토큰을 본다, start.ts internal.services). 계정 ID가 소문자 UUID가 아니면 INVALID_ARGUMENT이고 아무것도 읽지 않는다.
// purchase DB에 닿지 못하면 UNAVAILABLE, 그 밖의 오류는 INTERNAL이다. 마감 시각은 호출의 gRPC 데드라인이다(없으면 마감 없음).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { ProcessAccountWithdrawal, ProcessAccountWithdrawalResult } from '../application/process-account-withdrawal.js';
import { WithdrawalOrdersUnavailable } from '../domain/ports.js';

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
  };
}

/** gRPC 데드라인 → 마감 시각(ms). 없거나 무한이면 Infinity */
function deadlineAtOf(call: grpc.ServerUnaryCall<Req, object>): number {
  const d = call.getDeadline();
  const ms = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Number.POSITIVE_INFINITY;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function withdrawalParticipantHandlers(service: Pick<ProcessAccountWithdrawal, 'run'>, o: WithdrawalParticipantHandlerOptions): grpc.UntypedServiceImplementation {
  const ProcessAccountWithdrawal: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    if (o.internalToken !== undefined) {
      const verified = verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: WITHDRAWAL_PARTICIPANT_CALLER });
      if (!verified.ok) {
        cb(
          verified.reason === 'token'
            ? ({ code: grpc.status.UNAUTHENTICATED, details: '내부 gRPC 토큰이 필요하다' } as grpc.ServiceError)
            : ({ code: grpc.status.PERMISSION_DENIED, details: '내부 호출자만 부를 수 있다' } as grpc.ServiceError),
        );
        return;
      }
    }
    const accountId = typeof call.request.account_id === 'string' ? call.request.account_id : '';
    if (!ACCOUNT_UUID.test(accountId)) {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: '계정 ID는 소문자 UUID여야 한다' } as grpc.ServiceError);
      return;
    }
    service.run({ accountId, deadlineAtMs: deadlineAtOf(call) }).then(
      (r) => cb(null, responseOf(r)),
      (err: unknown) => {
        if (err instanceof WithdrawalOrdersUnavailable) return cb({ code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' } as grpc.ServiceError);
        o.onError('ProcessAccountWithdrawal', err);
        cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' } as grpc.ServiceError);
      },
    );
  };
  return { ProcessAccountWithdrawal };
}
