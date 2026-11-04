// identity AdminAuthzService.GetAdminAuthz 클라이언트(docs/api/proto/peaket/identity/v1/identity.proto, ADR-0172, BUILD_ORDER HOT-171).
// 파트너 경로마다 플랫폼 인증 가드가 이 포트로 그 세션의 지금 역할·테넌트를 묻는다(캐시·시간 한도·503은 가드가 한다, authz-matrix §3.1).
// 주소(PEAKET_IDENTITY_GRPC_URL)가 없으면 서비스가 시작하지 않는다(관리 역할 처리기가 있는데 포트가 없으면 가드가 시작을 막는다). 대역으로 통과시키지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { type AdminAuthz, type AdminAuthzPort, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';

/** 호출 기한 상한. 플랫폼 가드의 identity 조회 한도(ADMIN_AUTHZ_TIMEOUT_MS 1초 [가정])와 같고, 가드가 남은 시간을 opts.timeoutMs로 넘긴다 */
const AUTHZ_DEADLINE_CAP_MS = 1_000;

/** 설명자를 읽는 선택지(받는 쪽 identity와 같은 값: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

/** 응답을 플랫폼 AdminAuthz로. valid가 true가 아닌 답은 모두 닫는 쪽(valid false)이다 */
export function toAdminAuthz(r: Record<string, unknown>): AdminAuthz {
  const tenant = typeof r.tenant_id === 'string' && r.tenant_id !== '' ? r.tenant_id : undefined;
  return { valid: r.valid === true, role: typeof r.role === 'string' ? r.role : '', ...(tenant ? { tenantId: tenant } : {}) };
}

export class GrpcAdminAuthz implements AdminAuthzPort {
  readonly #client: grpc.Client & { GetAdminAuthz: Unary };

  /** address: host:port. 클라이언트는 플랫폼 함수로 만든다(부하 분산 프로필·추적·의존 로그·데드라인 상한) */
  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const Ctor = pkg.AdminAuthzService as grpc.ServiceClientConstructor;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL은 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(Ctor, { host: address.slice(0, at), port, profile, dependency: 'identity-svc', timeoutCapMs: AUTHZ_DEADLINE_CAP_MS }) as unknown as grpc.Client & {
      GetAdminAuthz: Unary;
    };
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
