// purchase-svc gRPC 클라이언트(GAT-135). 정본은 peaket.purchase.v1.PriorityPurchaseService이고,
// 내부 HTTP(HttpPurchasePriorityGrants)는 기존 호환 경로로 남긴다(같은 쓰임새·같은 결과).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { ProblemError } from '@peaket/platform';
import { PriorityDependencyUnavailable, type GrantPriorityInput, type GrantPriorityView, type PurchasePriorityGrants, type WithdrawPriorityView } from '../domain/priority.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Req = Record<string, unknown>;
type Res = Record<string, unknown>;
type Unary = (req: Req, metadata: grpc.Metadata, options: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res?: Res) => void) => grpc.ClientUnaryCall;

interface PriorityClient extends grpc.Client {
  GrantPriorityPurchase: Unary;
  WithdrawPriorityPurchase: Unary;
}

interface Pkg {
  PriorityPurchaseService: new (address: string, credentials: grpc.ChannelCredentials, options?: grpc.ClientOptions) => PriorityClient;
}

let pkg: Pkg | undefined;
const packageOf = (): Pkg => {
  if (!pkg) {
    const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
  }
  return pkg;
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const msOf = (v: unknown): number | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  const t = v as { seconds?: unknown; nanos?: unknown };
  return Number(t.seconds) * 1000 + Math.floor(Number(t.nanos) / 1_000_000);
};
const isoOf = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());
const RESULT: Readonly<Record<string, GrantPriorityView['result']>> = {
  PRIORITY_GRANT_RESULT_SAME_SEAT: 'SAME_SEAT',
  PRIORITY_GRANT_RESULT_SAME_TIER: 'SAME_TIER',
  PRIORITY_GRANT_RESULT_NO_SEAT: 'NO_SEAT',
  PRIORITY_GRANT_RESULT_ENTRY_STARTED: 'ENTRY_STARTED',
};
const STATE: Readonly<Record<string, WithdrawPriorityView['status']>> = {
  PRIORITY_GRANT_STATE_OFFERED: 'OFFERED',
  PRIORITY_GRANT_STATE_USED: 'USED',
  PRIORITY_GRANT_STATE_EXPIRED: 'EXPIRED',
  PRIORITY_GRANT_STATE_WITHDRAWN: 'WITHDRAWN',
};

const failureOf = (err: grpc.ServiceError): Error => {
  if (err.code === grpc.status.NOT_FOUND || err.code === grpc.status.FAILED_PRECONDITION || err.code === grpc.status.INVALID_ARGUMENT) {
    return new ProblemError({
      status: err.code === grpc.status.NOT_FOUND ? 404 : err.code === grpc.status.FAILED_PRECONDITION ? 409 : 422,
      type: err.code === grpc.status.NOT_FOUND ? 'priority-grant-not-found' : 'priority-grant-request-rejected',
      title: err.details || '우선 구매 권리 요청이 거절되었습니다',
    });
  }
  return new PriorityDependencyUnavailable('purchase-svc', 503);
};

export class GrpcPurchasePriorityGrants implements PurchasePriorityGrants {
  readonly #client: PriorityClient;

  constructor(address: string) {
    this.#client = new (packageOf().PriorityPurchaseService)(address, grpc.credentials.createInsecure());
  }

  async grant(i: GrantPriorityInput): Promise<GrantPriorityView> {
    const res = await this.#call('GrantPriorityPurchase', {
      fraud_case_id: i.fraudCaseId,
      event_id: i.eventId,
      account_id: i.accountId,
      cancelled_ticket_id: i.cancelledTicketId,
      acted_by: i.actedBy,
    });
    const expiresAt = isoOf(msOf(res.expires_at));
    return {
      result: RESULT[text(res.result)] ?? 'NO_SEAT',
      ...(text(res.grant_id) !== '' ? { grantId: text(res.grant_id) } : {}),
      ...(text(res.seat_id) !== '' ? { seatId: text(res.seat_id) } : {}),
      ...(typeof res.price === 'number' ? { price: res.price } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(typeof res.version === 'number' ? { version: res.version } : {}),
    };
  }

  async withdraw(grantId: string, actedBy: string): Promise<WithdrawPriorityView> {
    const res = await this.#call('WithdrawPriorityPurchase', { grant_id: grantId, acted_by: actedBy });
    const expiresAt = isoOf(msOf(res.expires_at));
    if (expiresAt === undefined) throw new PriorityDependencyUnavailable('purchase-svc', 503);
    return {
      grantId: text(res.grant_id),
      eventId: text(res.event_id),
      accountId: text(res.account_id),
      status: STATE[text(res.status)] ?? 'WITHDRAWN',
      expiresAt,
      version: Number(res.version),
    };
  }

  close(): void {
    this.#client.close();
  }

  #call(method: 'GrantPriorityPurchase' | 'WithdrawPriorityPurchase', req: Req): Promise<Res> {
    return new Promise((resolve, reject) => {
      this.#client[method](req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (err, res) => {
        if (err) return reject(failureOf(err));
        resolve(res ?? {});
      });
    });
  }
}
