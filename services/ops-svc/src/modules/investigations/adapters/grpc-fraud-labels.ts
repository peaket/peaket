// trust-svc TrustLabelService.ApplyLabel gRPC 클라이언트. FRAUD_ACTIONED·FRAUD_APPEAL_ACCEPTED 정답 라벨을 남긴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import {
  createGrpcClient,
  INTERNAL_GRPC_ACTOR_HEADER,
  INTERNAL_GRPC_ACTOR_PROOF_HEADER,
  INTERNAL_GRPC_CALLER_HEADER,
  INTERNAL_GRPC_TOKEN_HEADER,
  internalGrpcActorProof,
  type GrpcLbProfile,
} from '@peaket/platform';
import type { FraudLabels } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 5_000;
const CALLER = 'ops-svc';
const SOURCE = { FRAUD_ACTIONED: 'LABEL_SOURCE_FRAUD_ACTIONED', FRAUD_APPEAL_ACCEPTED: 'LABEL_SOURCE_FRAUD_APPEAL_ACCEPTED' } as const;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcFraudLabels implements FraudLabels {
  readonly #client: grpc.Client & { ApplyLabel: Unary };
  readonly #token: string | undefined;

  constructor(o: { address: string; profile?: GrpcLbProfile; token?: string }) {
    const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: Record<string, unknown> } } }).peaket.trust.v1;
    const Ctor = pkg.TrustLabelService as grpc.ServiceClientConstructor;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`PEAKET_TRUST_GRPC_URL은 host:port여야 한다: ${o.address}`);
    this.#client = createGrpcClient(Ctor, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'trust-svc',
      timeoutCapMs: DEADLINE_MS,
      caller: CALLER,
    }) as unknown as grpc.Client & { ApplyLabel: Unary };
    this.#token = o.token;
  }

  async apply(i: { eventId: string; caseId: string; accountIds: readonly string[]; label: 'HUMAN' | 'BOT'; source?: 'FRAUD_ACTIONED' | 'FRAUD_APPEAL_ACCEPTED'; version?: number; actedBy?: string }): Promise<void> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_TOKEN_HEADER, this.#token);
      metadata.set(INTERNAL_GRPC_CALLER_HEADER, CALLER);
      if (i.actedBy) {
        metadata.set(INTERNAL_GRPC_ACTOR_HEADER, i.actedBy);
        metadata.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof(this.#token, i.actedBy));
      }
    }
    for (const accountId of i.accountIds) {
      await new Promise<void>((resolve, reject) => {
        this.#client.ApplyLabel(
          {
            source_ref: i.caseId,
            source_version: i.version ?? 1,
            source: SOURCE[i.source ?? 'FRAUD_ACTIONED'],
            label: i.label === 'BOT' ? 'LABEL_BOT' : 'LABEL_HUMAN',
            event_id: i.eventId,
            pid: accountId,
            acted_by: i.actedBy ?? '',
          },
          metadata,
          { deadline: Date.now() + DEADLINE_MS },
          (e) => (e ? reject(e) : resolve()),
        );
      });
    }
  }

  close(): void {
    this.#client.close();
  }
}
