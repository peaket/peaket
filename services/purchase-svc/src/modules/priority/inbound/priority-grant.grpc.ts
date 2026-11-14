// 받는 층: gRPC PriorityPurchaseService(docs/api/proto/peaket/purchase/v1/account.proto, GAT-135, ADR-0171).
// 정본은 gRPC이고, 같은 쓰임새를 내부 HTTP(PriorityGrantController)도 열어 두었다(기존 호환).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { ProblemError } from '@peaket/platform';
import { PriorityGrantNotFound, PriorityStoreUnavailable, type GrantPriorityPurchase } from '../application/grant-priority-purchase.js';
import type { WithdrawPriorityGrant } from '../application/withdraw-priority-grant.js';
import type { PriorityGrant, PriorityGrantStatus } from '../domain/priority-grant.js';

export interface PriorityPurchasePackage {
  PriorityPurchaseService: grpc.ServiceClientConstructor;
}

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
let pkg: PriorityPurchasePackage | undefined;

/** peaket.purchase.v1 패키지(계약 설명자에서 한 번 만든다) */
export function priorityPurchasePackage(): PriorityPurchasePackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: PriorityPurchasePackage } } }).peaket.purchase.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const timestampOf = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const RESULT: Readonly<Record<string, string>> = {
  SAME_SEAT: 'PRIORITY_GRANT_RESULT_SAME_SEAT',
  SAME_TIER: 'PRIORITY_GRANT_RESULT_SAME_TIER',
  NO_SEAT: 'PRIORITY_GRANT_RESULT_NO_SEAT',
  ENTRY_STARTED: 'PRIORITY_GRANT_RESULT_ENTRY_STARTED',
};
const STATE: Readonly<Record<PriorityGrantStatus, string>> = {
  OFFERED: 'PRIORITY_GRANT_STATE_OFFERED',
  USED: 'PRIORITY_GRANT_STATE_USED',
  EXPIRED: 'PRIORITY_GRANT_STATE_EXPIRED',
  WITHDRAWN: 'PRIORITY_GRANT_STATE_WITHDRAWN',
};

const statusOf = (err: unknown): grpc.ServiceError => {
  if (err instanceof PriorityGrantNotFound) return { code: grpc.status.NOT_FOUND, details: '쓸 수 있는 우선 구매 권리가 없습니다' } as grpc.ServiceError;
  if (err instanceof PriorityStoreUnavailable) return { code: grpc.status.UNAVAILABLE, details: '좌석 정보를 잠시 쓸 수 없습니다' } as grpc.ServiceError;
  if (err instanceof ProblemError) {
    const code = err.status === 404 ? grpc.status.NOT_FOUND : err.status === 409 ? grpc.status.FAILED_PRECONDITION : grpc.status.INVALID_ARGUMENT;
    return { code, details: err.title } as grpc.ServiceError;
  }
  return { code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' } as grpc.ServiceError;
};

const viewOf = (g: PriorityGrant): Record<string, unknown> => ({
  grant_id: g.grantId,
  event_id: g.eventId,
  account_id: g.accountId,
  status: STATE[g.status],
  expires_at: timestampOf(g.expiresAtMs),
  version: g.version,
});

export type PriorityPurchaseUseCases = { readonly grant: Pick<GrantPriorityPurchase, 'run'>; readonly withdraw: Pick<WithdrawPriorityGrant, 'run'> };

/** start.ts가 gRPC 서버에 직접 붙이는 처리기 묶음. 시험도 같은 함수를 쓴다 */
export function priorityPurchaseHandlers(useCases: PriorityPurchaseUseCases): grpc.UntypedServiceImplementation {
  const unary =
    (fn: (r: Req) => Promise<object>): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      fn(call.request).then(
        (v) => cb(null, v),
        (err: unknown) => cb(statusOf(err)),
      );
    };
  return {
    GrantPriorityPurchase: unary(async (r) => {
      const out = await useCases.grant.run({
        fraudCaseId: text(r.fraud_case_id),
        eventId: text(r.event_id),
        accountId: text(r.account_id),
        cancelledTicketId: text(r.cancelled_ticket_id),
        actedBy: text(r.acted_by),
      });
      return {
        result: RESULT[out.result],
        ...(out.grant
          ? {
              grant_id: out.grant.grantId,
              seat_id: out.grant.seatId,
              price: out.grant.price,
              expires_at: timestampOf(out.grant.expiresAtMs),
              version: out.grant.version,
            }
          : {}),
      };
    }),
    WithdrawPriorityPurchase: unary(async (r) => viewOf(await useCases.withdraw.run(text(r.grant_id)))),
  };
}
