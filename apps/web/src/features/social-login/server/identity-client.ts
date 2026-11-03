// identity-svc SessionService gRPC 클라이언트(docs/api/proto/peaket/identity/v1/identity.proto, identity §2 '세션 생성 내부 계약').
// 앱 코드는 다시 보내지 않는다(남는 다시 보내기는 grpc-js 투명 재시도와 메시 재시도 예산, docs/api/proto/README.md §2 '재시도').
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { PROTO_PROVIDER, type Provider } from './providers.ts';

/** 한 번 부를 때의 데드라인 [가정](정본에 값이 없다. 로그인 1건의 서버 쪽 시간 예산 안에서 wbs 2.12.1 성능 장부로 확정) */
export const IDENTITY_DEADLINE_MS = 2_000;
const OPTS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, any>) => void) => grpc.ClientUnaryCall;
type SessionClient = grpc.Client & { CreateSession: Unary; EndSession: Unary; IssueReauthToken: Unary };

export interface CreatedSession {
  accountId: string;
  sessionId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  newAccount: boolean;
}

export type ReauthIssue = { result: 'ISSUED'; token: string; expiresAt: number } | { result: 'ACCOUNT_MISMATCH' } | { result: 'REVERIFY_REQUIRED' };

export class IdentityClient {
  readonly #client: SessionClient;

  constructor(address: string) {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], OPTS);
    const pkg = grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: { SessionService: grpc.ServiceClientConstructor } } } };
    this.#client = new pkg.peaket.identity.v1.SessionService(address, grpc.credentials.createInsecure()) as unknown as SessionClient;
  }

  #call(method: 'CreateSession' | 'EndSession' | 'IssueReauthToken', req: object): Promise<Record<string, any>> {
    return new Promise((res, rej) => {
      this.#client[method](req, new grpc.Metadata(), { deadline: Date.now() + IDENTITY_DEADLINE_MS }, (e, v) => (e ? rej(e) : res(v ?? {})));
    });
  }

  async createSession(i: { idempotencyKey: string; provider: Provider; providerUserId: string; email: string | null; emailVerified: boolean; deviceId: string | null; userAgent: string; authMethods: string[] }): Promise<CreatedSession> {
    const r = await this.#call('CreateSession', {
      idempotency_key: i.idempotencyKey,
      provider: PROTO_PROVIDER[i.provider],
      provider_user_id: i.providerUserId,
      email: i.email ?? '',
      email_verified: i.emailVerified,
      device_id: i.deviceId ?? '',
      // 원문 IP는 신뢰할 수 있는 끝단 머리가 정해진 뒤(wbs 2.11.1) 싣는다. 지금은 비운다
      client_ip: '',
      user_agent: i.userAgent,
      auth_methods: i.authMethods,
    });
    if (r.outcome !== 'session' || !r.session) throw new Error(`CreateSession 결과가 세션이 아니다(${String(r.outcome)})`);
    const s = r.session;
    return {
      accountId: s.account_id,
      sessionId: s.session_id,
      accessToken: s.access_token,
      accessExpiresAt: Number(s.access_token_expires_at_ms),
      refreshToken: s.refresh_token,
      refreshExpiresAt: Number(s.refresh_token_expires_at_ms),
      newAccount: Boolean(r.new_account),
    };
  }

  async endSession(i: { sessionId: string; accountId: string }): Promise<{ ended: boolean }> {
    const r = await this.#call('EndSession', { session_id: i.sessionId, account_id: i.accountId });
    return { ended: Boolean(r.ended) };
  }

  async issueReauthToken(i: { sessionId: string; accountId: string; provider: Provider; providerUserId: string; strength: 'verified' | 'requested'; purpose: 'sensitive' | 'high-risk'; userAgent: string }): Promise<ReauthIssue> {
    const r = await this.#call('IssueReauthToken', {
      session_id: i.sessionId,
      account_id: i.accountId,
      provider: PROTO_PROVIDER[i.provider],
      provider_user_id: i.providerUserId,
      strength: i.strength === 'verified' ? 'REAUTH_STRENGTH_VERIFIED' : 'REAUTH_STRENGTH_REQUESTED',
      client_ip: '',
      user_agent: i.userAgent,
      purpose: i.purpose === 'high-risk' ? 'REAUTH_PURPOSE_HIGH_RISK' : 'REAUTH_PURPOSE_SENSITIVE',
    });
    if (r.result === 'REAUTH_RESULT_ISSUED') return { result: 'ISSUED', token: r.reauth_token, expiresAt: Number(r.reauth_token_expires_at_ms) };
    if (r.result === 'REAUTH_RESULT_ACCOUNT_MISMATCH') return { result: 'ACCOUNT_MISMATCH' };
    if (r.result === 'REAUTH_RESULT_REVERIFY_REQUIRED') return { result: 'REVERIFY_REQUIRED' };
    throw new Error(`IssueReauthToken 결과를 모른다(${String(r.result)})`);
  }

  close(): void {
    this.#client.close();
  }
}
