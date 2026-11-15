// export 어댑터: BOOKER_EXPORT 재인증·표시 이름. 회차 찾기는 shop의 PartnerEventDirectory를 쓴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createExternalHttpClient, createGrpcClient, type ReauthJtiStore, systemClock, TokenRejected, TokenVerifier, type Clock, type GrpcLbProfile, type TokenVerifierOptions } from '@peaket/platform';
import { ExportProblem } from '../domain/export.js';
import type { ActorNameResolver, BookersReauth } from '../domain/ports.js';

/** identity GET /internal/jwks/admin.json의 관리 키로 재인증 토큰을 확인한다(act BOOKER_EXPORT, passkey 필수). */
export class JwksBookersReauth implements BookersReauth {
  readonly #verifier: TokenVerifier;
  readonly #jti?: ReauthJtiStore;
  readonly #clock: Clock;

  constructor(o: { jwksUrl: string; issuer: string; clock?: Clock; fetch?: typeof fetch; jti?: ReauthJtiStore }) {
    this.#jti = o.jti;
    this.#clock = o.clock ?? systemClock;
    const u = new URL(o.jwksUrl);
    const client = createExternalHttpClient({
      provider: 'identity-jwks',
      baseUrl: u.origin,
      timeoutCapMs: 5_000,
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    this.#verifier = new TokenVerifier({
      issuer: o.issuer,
      ...(o.clock ? { clock: o.clock } : {}),
      jwks: async () => (await (await client.request({ method: 'GET', path: u.pathname })).json()) as unknown as Awaited<ReturnType<TokenVerifierOptions['jwks']>>,
    });
  }

  async verify(token: string | undefined, o: { sessionId: string; promoterId: string }) {
    if (!token) throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
    try {
      const v = await this.#verifier.verifyReauth(token, { keySet: 'admin', audience: 'partner', sessionId: o.sessionId, act: 'BOOKER_EXPORT' });
      const factors = v.factors ?? [];
      if (!factors.includes('passkey')) throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
      // 같은 재인증 토큰의 jti를 두 번 쓰지 못한다(SEC-03). 저장소를 쓸 수 없으면 닫는다.
      if (this.#jti && !(await this.#jti.claim(v.jti, v.expiresAt, this.#clock.now()))) throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
      return { accountId: v.accountId, factors };
    } catch (e) {
      if (e instanceof ExportProblem) throw e;
      if (e instanceof TokenRejected) throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
      throw e;
    }
  }
}

/** JWKS 주소가 없는 개발·시험 조립. 재인증이 필요한 경로는 항상 403이다. */
export class UnavailableBookersReauth implements BookersReauth {
  async verify(): Promise<{ accountId: string; factors: string[] }> {
    throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
  }
}

type GetAdminAccount = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

/** identity AdminAccountService.GetAdminAccount의 display_name. 실패하면 이름 없이 역할만 남긴다. */
export class GrpcAdminAccountNames implements ActorNameResolver {
  readonly #client: grpc.Client & { GetAdminAccount: GetAdminAccount };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const Ctor = pkg.AdminAccountService as grpc.ServiceClientConstructor;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL은 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(Ctor, { host: address.slice(0, at), port, profile, dependency: 'identity-svc', timeoutCapMs: 1_000 }) as unknown as grpc.Client & { GetAdminAccount: GetAdminAccount };
  }

  displayName(accountId: string): Promise<string | undefined> {
    return new Promise((res) => {
      this.#client.GetAdminAccount({ admin_account_id: accountId }, new grpc.Metadata(), { deadline: Date.now() + 1_000 }, (e, v) => {
        if (e) return res(undefined);
        const account = v?.account as Record<string, unknown> | undefined;
        const name = typeof account?.display_name === 'string' ? account.display_name : undefined;
        res(name);
      });
    });
  }
}

export class MemoryActorNames implements ActorNameResolver {
  readonly names = new Map<string, string>();
  set(accountId: string, name: string): void {
    this.names.set(accountId, name);
  }
  async displayName(accountId: string): Promise<string | undefined> {
    return this.names.get(accountId);
  }
}
