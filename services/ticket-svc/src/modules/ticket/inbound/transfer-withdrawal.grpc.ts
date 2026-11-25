// ticket-svc 탈퇴 참여자·연기 철회 gRPC(peaket/ticket/v1/ticket.proto, docs/features/identity.md §8, docs/features/transfer-refund.md §5).
// 부르는 쪽은 identity-svc(탈퇴)·purchase-svc(연기)뿐이다. 내부 토큰이 설정된 조립은 호출자 머리를 확인한다.
import * as grpc from '@grpc/grpc-js';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { TransferWithdrawalResult } from '../application/account-withdrawal.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

export interface TransferWithdrawalUseCases {
  readonly process: (i: { readonly accountId: string; readonly deadlineAtMs: number }) => Promise<TransferWithdrawalResult>;
}

export interface TransferEventWithdrawalUseCases {
  readonly withdrawForEvent: (i: { readonly eventId: string; readonly nowMs?: number }) => Promise<{ readonly withdrawn: readonly string[] }>;
}

const WITHDRAWAL_CALLER = 'identity-svc';
const TRANSFER_CALLER = 'purchase-svc';

export function transferWithdrawalHandlers(uc: TransferWithdrawalUseCases, onError: (method: string, err: unknown) => void, o?: { readonly internalToken?: string }): grpc.UntypedServiceImplementation {
  return {
    ProcessAccountWithdrawal: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: WITHDRAWAL_CALLER }).ok) {
        cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
        return;
      }
      const accountId = text(call.request.account_id);
      const deadlineAtMs = int(call.request.deadline_at_ms);
      uc.process({ accountId, deadlineAtMs })
        .then((r) => {
          cb(null, {
            state: r.state === 'DONE' ? 'WITHDRAWAL_PARTICIPANT_STATE_DONE' : 'WITHDRAWAL_PARTICIPANT_STATE_PENDING',
            returned_tickets: r.returnedTickets,
            withdrawn_offers: r.withdrawnOffers,
            rejected_offers: r.rejectedOffers,
            pending_received_tickets: r.pendingReceivedTickets,
            pending_sent_offers: r.pendingSentOffers,
            pending_received_offers: r.pendingReceivedOffers,
            reasons: r.state === 'PENDING' ? ['WITHDRAWAL_PENDING_REASON_TICKET_TRANSFER_PENDING'] : [],
          });
        })
        .catch((err: unknown) => {
          onError('ProcessAccountWithdrawal', err);
          cb({ code: grpc.status.INTERNAL, details: '탈퇴 참여자 처리를 마치지 못했다' });
        });
    },
  };
}

export function transferEventWithdrawalHandlers(uc: TransferEventWithdrawalUseCases, onError: (method: string, err: unknown) => void, o?: { readonly internalToken?: string }): grpc.UntypedServiceImplementation {
  return {
    WithdrawTransfersForEvent: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (o?.internalToken && !verifyInternalGrpcActor(call.metadata, o.internalToken, { caller: TRANSFER_CALLER }).ok) {
        cb({ code: grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
        return;
      }
      const req = call.request;
      if (text(req.reason) !== 'EVENT_POSTPONED') {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: 'reason은 EVENT_POSTPONED여야 한다' });
        return;
      }
      const nowMs = int(req.now_ms);
      uc.withdrawForEvent({ eventId: text(req.event_id), ...(nowMs > 0 ? { nowMs } : {}) })
        .then((r) => cb(null, { withdrawn: [...r.withdrawn] }))
        .catch((err: unknown) => {
          onError('WithdrawTransfersForEvent', err);
          cb({ code: grpc.status.INTERNAL, details: '양도 요청을 철회하지 못했다' });
        });
    },
  };
}
