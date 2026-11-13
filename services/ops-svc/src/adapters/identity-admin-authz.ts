// identity AdminAuthzService.GetAdminAuthz 클라이언트(ops-svc용). 관제 역할은 토큰에 없어 요청마다 identity에 묻는다(ADR-0172).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { type AdminAuthz, type AdminAuthzPort, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';

const AUTHZ_DEADLINE_CAP_MS = 1_000;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export function toAdminAuthz(r: Record<string, unknown>): AdminAuthz {
  const tenant = typeof r.tenant_id === 'string' && r.tenant_id !== '' ? r.tenant_id : undefined;
  return { valid: r.valid === true, role: typeof r.role === 'string' ? r.role : '', ...(tenant ? { tenantId: tenant } : {}) };
}

export class GrpcAdminAuthz implements AdminAuthzPort {
  readonly #client: grpc.Client & { GetAdminAuthz: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const Ctor = pkg.AdminAuthzService as grpc.ServiceClientConstructor;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL은 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(Ctor, { host: address.slice(0, at), port, profile, dependency: 'identity-svc', timeoutCapMs: AUTHZ_DEADLINE_CAP_MS }) as unknown as grpc.Client & { GetAdminAuthz: Unary };
  }

  getAdminAuthz(q: { adminAccountId: string; sessionId: string }, opts?: { timeoutMs: number; signal: AbortSignal }): Promise<AdminAuthz> {
    return new Promise((res, rej) => {
      const call = this.#client.GetAdminAuthz(
        { admin_account_id: q.adminAccountId, session_id: q.sessionId },
        new grpc.Metadata(),
        { deadline: Date.now() + (opts?.timeoutMs ?? AUTHZ_DEADLINE_CAP_MS) },
        (e, v) => (e ? rej(e) : res(toAdminAuthz(v ?? {}))),
      );
      opts?.signal.addEventListener('abort', () => call.cancel(), { once: true });
    });
  }

  close(): void {
    this.#client.close();
  }
}
