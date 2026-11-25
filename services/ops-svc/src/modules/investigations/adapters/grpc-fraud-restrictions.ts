// identity-svc SetRestrictedCiHold + queue-svc·purchase-svc SetBookingRestriction gRPC 묶음.
// 이용 제한을 identity 보관 → queue 사본 → purchase 사본 순서로 쓴다(IR-13, transfer-refund §7.4).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity, purchaseV1Account, queueV1Queue } from '@peaket/contracts/proto';
import { createGrpcClient, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, type GrpcLbProfile } from '@peaket/platform';
import type { FraudRestrictionRows } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 5_000;
const CALLER = 'ops-svc';
const TS = (ms: number) => ({ seconds: Math.floor(ms / 1_000), nanos: (ms % 1_000) * 1_000_000 });
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

function client<T extends grpc.Client & Record<string, Unary>>(address: string, descriptor: unknown, service: string, dependency: string, profile: GrpcLbProfile = 'service'): T {
  const def = protoLoader.fromJSON(descriptor as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: Record<string, Record<string, Record<string, unknown>>> }).peaket;
  const group = dependency.startsWith('identity') ? pkg.identity.v1 : dependency.startsWith('queue') ? pkg.queue.v1 : pkg.purchase.v1;
  const Ctor = group[service] as grpc.ServiceClientConstructor;
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${dependency} 주소는 host:port여야 한다: ${address}`);
  return createGrpcClient(Ctor, { host: address.slice(0, at), port, profile, dependency, timeoutCapMs: DEADLINE_MS, caller: CALLER }) as unknown as T;
}

export class GrpcFraudRestrictions {
  readonly identity = {
    restrict: async (i: { accountId: string; caseId: string; version: number; untilMs: number }): Promise<void> => {
      const out = await this.#call(this.#identity, 'SetRestrictedCiHold', { account_id: i.accountId, fraud_case_id: i.caseId, until: TS(i.untilMs), state: 'RESTRICTED_CI_HOLD_STATE_RESTRICTED', version: i.version });
      if (out.result !== 'RESTRICTED_CI_HOLD_RESULT_OK') throw new Error(`identity SetRestrictedCiHold 결과가 ${String(out.result)}입니다`);
    },
    lift: async (i: { accountId: string; caseId: string; version: number }): Promise<void> => {
      const out = await this.#call(this.#identity, 'SetRestrictedCiHold', { account_id: i.accountId, fraud_case_id: i.caseId, state: 'RESTRICTED_CI_HOLD_STATE_RELEASED', version: i.version });
      if (out.result !== 'RESTRICTED_CI_HOLD_RESULT_OK') throw new Error(`identity SetRestrictedCiHold 해제 결과가 ${String(out.result)}입니다`);
    },
  };
  readonly queue = {
    set: async (i: { accountId: string; caseId: string; restrictionId: string; state: 'ACTIVE' | 'LIFTED'; version: number; untilMs: number }): Promise<void> => {
      const out = await this.#call(this.#queue, 'SetBookingRestriction', { account_id: i.accountId, restriction_id: i.restrictionId, state: `BOOKING_RESTRICTION_STATE_${i.state}`, ends_at: TS(i.untilMs), version: i.version });
      if (out.changed !== true) throw new Error('queue-svc SetBookingRestriction이 반영되지 않았습니다');
    },
  };
  readonly purchase = {
    set: async (i: { accountId: string; caseId: string; restrictionId: string; state: 'ACTIVE' | 'LIFTED'; version: number; untilMs: number }): Promise<void> => {
      const out = await this.#call(this.#purchase, 'SetBookingRestriction', { account_id: i.accountId, restriction_id: i.restrictionId, state: `BOOKING_RESTRICTION_STATE_${i.state}`, ends_at: TS(i.untilMs), version: i.version });
      if (out.changed !== true) throw new Error('purchase-svc SetBookingRestriction이 반영되지 않았습니다');
    },
  };
  readonly #identity: grpc.Client & Record<string, Unary>;
  readonly #queue: grpc.Client & Record<string, Unary>;
  readonly #purchase: grpc.Client & Record<string, Unary>;
  readonly #token: string | undefined;

  constructor(o: { identityAddress: string; queueAddress: string; purchaseAddress: string; token?: string; rows?: FraudRestrictionRows; profile?: GrpcLbProfile }) {
    this.#identity = client(o.identityAddress, identityV1Identity, 'RestrictedCiHoldService', 'identity-svc', o.profile);
    this.#queue = client(o.queueAddress, queueV1Queue, 'BookingRestrictionService', 'queue-svc', o.profile);
    this.#purchase = client(o.purchaseAddress, purchaseV1Account, 'BookingRestrictionService', 'purchase-svc', o.profile);
    this.#token = o.token;
    this.rows = o.rows;
  }

  readonly rows?: FraudRestrictionRows;

  async activeForCase(caseId: string) {
    return this.rows ? this.rows.activeForCase(caseId) : [];
  }

  async #call(c: grpc.Client & Record<string, Unary>, method: string, req: object): Promise<Record<string, unknown>> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_TOKEN_HEADER, this.#token);
      metadata.set(INTERNAL_GRPC_CALLER_HEADER, CALLER);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => c[method]!(req, metadata, { deadline: Date.now() + DEADLINE_MS }, (e, v) => (e ? reject(e) : resolve(v ?? {}))));
  }

  close(): void {
    this.#identity.close();
    this.#queue.close();
    this.#purchase.close();
  }
}
