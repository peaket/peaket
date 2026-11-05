// 받는 층: gRPC SessionService·IdentityService(docs/api/proto/peaket/identity/v1/identity.proto)를 유스케이스에 잇는다.
// 업무 오류는 상태 코드로, 예상하지 못한 오류는 INTERNAL과 고정 문구로 돌려주고 이유는 서버 쪽 기록에만 남긴다
// (docs/api/proto/README.md §2 'gRPC 상태 코드'). 부르는 쪽 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다(identity §2, I-T50 ③).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import type { CreateSession, CreateSessionResult, LoginOutcome } from '../application/create-session.js';
import type { AddProvider } from '../application/add-provider.js';
import type { GetLinkProposal } from '../application/get-link-proposal.js';
import type { SeparateAccount } from '../application/separate-account.js';
import type { SetAccountHold } from '../application/set-account-hold.js';
import type { EndSession } from '../application/end-session.js';
import type { GetVerificationStatus } from '../application/get-verification-status.js';
import type { IssueReauthToken } from '../application/issue-reauth-token.js';
import { SessionError } from '../application/session-error.js';
import type { ComputeContactRef } from '../application/compute-contact-ref.js';
import type { GetInvestigationRefs } from '../application/get-investigation-refs.js';
import { InvRefError } from '../application/inv-ref-error.js';
import type { Provider, ReauthPurpose, ReauthStrength } from '../domain/session.js';

/** 설명자를 읽는 선택지: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자(밀리초 시각은 2^53 안), oneof 이름 칸을 단다 */
export const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export interface IdentityPackage {
  SessionService: grpc.ServiceClientConstructor;
  IdentityService: grpc.ServiceClientConstructor;
  RestrictedCiHoldService: grpc.ServiceClientConstructor;
  AccountHoldService: grpc.ServiceClientConstructor;
  ContactRefService: grpc.ServiceClientConstructor;
  InvestigationRefService: grpc.ServiceClientConstructor;
  /** 관리 경로의 역할 판정(ADR-0172, BOT-123) */
  AdminAuthzService: grpc.ServiceClientConstructor;
  AdminAccountService: grpc.ServiceClientConstructor;
  AdminDesignationService: grpc.ServiceClientConstructor;
}

let pkg: IdentityPackage | undefined;
/** peaket.identity.v1 패키지(계약 설명자에서 한 번 만든다) */
export function identityPackage(): IdentityPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: IdentityPackage } } };
    pkg = root.peaket.identity.v1;
  }
  return pkg;
}

const PROVIDER: Record<string, Provider> = { PROVIDER_KAKAO: 'kakao', PROVIDER_NAVER: 'naver', PROVIDER_GOOGLE: 'google' };
const STRENGTH: Record<string, ReauthStrength> = { REAUTH_STRENGTH_VERIFIED: 'verified', REAUTH_STRENGTH_REQUESTED: 'requested' };
const PURPOSE: Record<string, ReauthPurpose> = { REAUTH_PURPOSE_SENSITIVE: 'sensitive', REAUTH_PURPOSE_HIGH_RISK: 'high-risk' };

/** 저장소·의존성에 닿지 못한 오류(연결 거부·끊김, PostgreSQL 연결 예외 08xxx·관리자 종료 57P0x, 풀 대기 초과). 부르는 쪽은 서킷 브레이커와 대체 응답으로 간다 */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', '57P01', '57P02', '57P03']);
function unreachable(err: unknown): boolean {
  let e = err as { code?: unknown; status?: unknown; cause?: unknown } | undefined;
  for (let n = 0; e && n < 4; n++) {
    const c = typeof e.code === 'string' ? e.code : '';
    if (UNREACHABLE.has(c) || c.startsWith('08') || e.status === 429 || e.status === 503) return true;
    e = e.cause as typeof e;
  }
  return false;
}

const providerOf = (v: unknown): Provider => {
  const p = PROVIDER[String(v)];
  if (!p) throw new SessionError('INVALID_ARGUMENT', 'provider가 없다');
  return p;
};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

type Req = Record<string, unknown>;
type UseCases = {
  create: Pick<CreateSession, 'outcome'>;
  end: Pick<EndSession, 'run'>;
  reauth: Pick<IssueReauthToken, 'run'>;
  /** 가입 때 연결 제안(identity §2.1, BOT-040). 없으면 두 호출이 UNAVAILABLE이다 */
  linkView?: Pick<GetLinkProposal, 'run'>;
  separate?: Pick<SeparateAccount, 'run'>;
  /** 계정 설정의 로그인 수단 추가(SCR-040 ②, BOT-041). 없으면 UNAVAILABLE */
  addProvider?: Pick<AddProvider, 'add'>;
};

const PROVIDER_ENUM: Record<Provider, string> = { kakao: 'PROVIDER_KAKAO', naver: 'PROVIDER_NAVER', google: 'PROVIDER_GOOGLE' };

const sessionOf = (out: CreateSessionResult) => ({
  account_id: out.accountId,
  session_id: out.sessionId,
  access_token: out.accessToken,
  access_token_expires_at_ms: out.accessTokenExpiresAt,
  refresh_token: out.refreshToken,
  refresh_token_expires_at_ms: out.refreshTokenExpiresAt,
});

/** CreateSessionResponse: 세션, 연결 제안(+ 묶음 값), 연결 불일치 가운데 하나 */
function responseOf(o: LoginOutcome): object {
  if (o.kind === 'link-proposed') return { link_proposal_id: o.proposalId, link_binding: o.binding, new_account: false };
  if (o.kind === 'link-mismatch') return { link_mismatch: { attempts_left: o.attemptsLeft }, new_account: false };
  return { session: sessionOf(o), new_account: o.newAccount, linked_provider: o.linkedProvider ? PROVIDER_ENUM[o.linkedProvider] : 'PROVIDER_UNSPECIFIED' };
}

/**
 * @param onError 예상하지 못한 오류(INTERNAL로 답한 것)를 받는다. 서비스는 로거에 남긴다
 */
/** 유스케이스 호출을 단항 처리기로 감싼다. 업무 오류는 상태 코드, 닿지 못한 의존성은 UNAVAILABLE, 그 밖은 INTERNAL과 고정 문구 */
function unaryOf(onError: (method: string, err: unknown) => void) {
  return (method: string, fn: (r: Req) => Promise<object>): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      fn(call.request).then(
        (v) => cb(null, v),
        (err: unknown) => {
          if (err instanceof SessionError) {
            cb({ code: grpc.status[err.code], details: err.message });
            return;
          }
          onError(method, err);
          if (unreachable(err)) cb({ code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' });
          else cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
        },
      );
    };
}

/**
 * IdentityService: 주문 생성의 본인확인 재확인(purchase-svc). 부르는 쪽 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다(identity §2).
 * 응답이 없으면 부르는 쪽은 게이트웨이가 넘긴 토큰 값으로 판정한다(ADR-0055)
 */
export function identityServiceHandlers(uc: { status: Pick<GetVerificationStatus, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const unary = unaryOf(onError);
  return {
    GetVerificationStatus: unary('GetVerificationStatus', async (r) => {
      const s = await uc.status.run({ accountId: text(r.account_id), sessionId: text(r.session_id) });
      return { verified: s.verified, pid: s.pid, previous_pid: s.previousPid };
    }),
  };
}

export function sessionServiceHandlers(uc: UseCases, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const unary = unaryOf(onError);
  return {
    CreateSession: unary('CreateSession', async (r) => {
      const provider = providerOf(r.provider);
      // 연결 제안을 따라 온 로그인이면 제안 ID와 묶음 값을 함께 받는다(identity §2.1 '가입 때 연결 제안의 첫 구현')
      const proposalId = text(r.link_proposal_id);
      // client_ip·user_agent는 법정 접속기록 줄(FR-045)에만, auth_methods·asn은 로그인 판정(trust-svc)에 쓴다. 그 둘이 생기기 전에는 받기만 한다
      const out = await uc.create.outcome({
        idempotencyKey: text(r.idempotency_key),
        provider,
        providerUserId: text(r.provider_user_id),
        email: text(r.email) || null,
        emailVerified: r.email_verified === true,
        deviceId: text(r.device_id) || null,
        ...(proposalId ? { link: { proposalId, binding: text(r.link_binding) } } : {}),
      });
      return responseOf(out);
    }),
    GetLinkProposal: unary('GetLinkProposal', async (r) => {
      if (!uc.linkView) throw new SessionError('UNAVAILABLE', '연결 제안 저장소가 없다');
      const v = await uc.linkView.run({ proposalId: text(r.link_proposal_id), binding: text(r.link_binding) });
      return { existing_provider: PROVIDER_ENUM[v.existingProvider], new_provider: PROVIDER_ENUM[v.newProvider], expires_at_ms: v.expiresAt, attempts_left: v.attemptsLeft };
    }),
    AddProvider: unary('AddProvider', async (r) => {
      if (!uc.addProvider) throw new SessionError('UNAVAILABLE', '로그인 수단 추가를 받지 않는다');
      const out = await uc.addProvider.add({
        sessionId: text(r.session_id),
        accountId: text(r.account_id),
        reauthToken: text(r.reauth_token),
        provider: providerOf(r.provider),
        providerUserId: text(r.provider_user_id),
      });
      return { result: `ADD_PROVIDER_RESULT_${out.result}`, merge_proposal_id: out.mergeProposalId ?? '' };
    }),
    SeparateAccount: unary('SeparateAccount', async (r) => {
      if (!uc.separate) throw new SessionError('UNAVAILABLE', '연결 제안 저장소가 없다');
      const out = await uc.separate.run({ proposalId: text(r.link_proposal_id), binding: text(r.link_binding), idempotencyKey: text(r.idempotency_key), deviceId: text(r.device_id) || null });
      return { session: sessionOf(out), new_account: out.newAccount, linked_provider: 'PROVIDER_UNSPECIFIED' };
    }),
    EndSession: unary('EndSession', async (r) => uc.end.run({ sessionId: text(r.session_id), accountId: text(r.account_id) })),
    IssueReauthToken: unary('IssueReauthToken', async (r) => {
      const strength = STRENGTH[String(r.strength)];
      if (!strength) throw new SessionError('INVALID_ARGUMENT', 'strength가 없다');
      const purpose = PURPOSE[String(r.purpose)];
      if (!purpose) throw new SessionError('INVALID_ARGUMENT', 'purpose가 없다');
      const out = await uc.reauth.run({
        sessionId: text(r.session_id),
        accountId: text(r.account_id),
        provider: providerOf(r.provider),
        providerUserId: text(r.provider_user_id),
        strength,
        purpose,
      });
      if (out.result === 'ISSUED') return { result: 'REAUTH_RESULT_ISSUED', reauth_token: out.token, reauth_token_expires_at_ms: out.expiresAt };
      return { result: out.result === 'ACCOUNT_MISMATCH' ? 'REAUTH_RESULT_ACCOUNT_MISMATCH' : 'REAUTH_RESULT_REVERIFY_REQUIRED' };
    }),
  };
}

const HOLD_KIND: Record<string, 'VERIFICATION_APPEAL' | 'DISPUTE' | 'APPEAL'> = {
  ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL: 'VERIFICATION_APPEAL',
  ACCOUNT_HOLD_KIND_DISPUTE: 'DISPUTE',
  ACCOUNT_HOLD_KIND_APPEAL: 'APPEAL',
};
const HOLD_STATE: Record<string, 'OPEN' | 'CLOSED'> = { ACCOUNT_HOLD_STATE_OPEN: 'OPEN', ACCOUNT_HOLD_STATE_CLOSED: 'CLOSED' };

/** AccountHoldService: ops-svc가 이의 제기·소명 건의 열림·닫힘을 알린다(identity §2.1 '계정 병합의 첫 구현', BOT-042) */
export function accountHoldHandlers(uc: { hold: Pick<SetAccountHold, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const unary = unaryOf(onError);
  return {
    SetAccountHold: unary('SetAccountHold', async (r) => {
      const kind = HOLD_KIND[String(r.kind)];
      const state = HOLD_STATE[String(r.state)];
      if (!kind || !state) throw new SessionError('INVALID_ARGUMENT', 'kind·state가 없다');
      let out: 'APPLIED' | 'STALE' | 'CONFLICT' | 'NOT_FOUND';
      try {
        out = await uc.hold.run({ sourceRef: text(r.source_ref), accountId: text(r.account_id), kind, state, sourceVersion: Number(r.source_version ?? 0) });
      } catch (e) {
        if (e instanceof Error && !(e instanceof SessionError)) throw new SessionError('INVALID_ARGUMENT', e.message);
        throw e;
      }
      if (out === 'CONFLICT') throw new SessionError('ALREADY_EXISTS', '같은 건에 다른 계정·종류가 왔다');
      if (out === 'NOT_FOUND') throw new SessionError('NOT_FOUND', '그 계정이 없다');
      return { changed: out === 'APPLIED' };
    }),
  };
}

const INV_REF_STATUS = { INVALID: grpc.status.INVALID_ARGUMENT, UNAVAILABLE: grpc.status.UNAVAILABLE, EXHAUSTED: grpc.status.RESOURCE_EXHAUSTED } as const;
const CONTACT_KIND = { PHONE: 'CONTACT_REF_KIND_PHONE', EMAIL: 'CONTACT_REF_KIND_EMAIL' } as const;
const timestamp = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

/** 조사용 값 호출의 응답 틀: InvRefError는 그 상태로, 그 밖은 기록하고 INTERNAL(번호·이메일은 기록에 싣지 않는다) */
function invRefUnary(onError: (method: string, err: unknown) => void) {
  return (method: string, fn: (r: Req) => Promise<object> | object): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      Promise.resolve()
        .then(() => fn(call.request))
        .then(
          (v) => cb(null, v),
          (err: unknown) => {
            if (err instanceof InvRefError) {
              cb({ code: INV_REF_STATUS[err.code], details: err.message });
              return;
            }
            onError(method, err);
            cb({ code: unreachable(err) ? grpc.status.UNAVAILABLE : grpc.status.INTERNAL, details: '처리하지 못했다' });
          },
        );
    };
}

/** ContactRefService: 주문 예매자 번호의 연락처 가명(purchase-svc만, 그 신원 확인은 메시 L7 허용 목록, identity §9.1 '조사용 값의 첫 구현') */
export function contactRefHandlers(uc: { compute: Pick<ComputeContactRef, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const unary = invRefUnary(onError);
  return {
    ComputeContactRef: unary('ComputeContactRef', (r) => ({ contact_ref: uc.compute.run(text(r.phone_e164)) })),
  };
}

/** InvestigationRefService: 조사 적재의 연결 값 조회(inv-ingest만, 그 신원 확인은 메시 L7 허용 목록, I-T67 ②는 HOT-400) */
export function investigationRefHandlers(uc: { refs: Pick<GetInvestigationRefs, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const unary = invRefUnary(onError);
  return {
    BatchGetInvestigationRefs: unary('BatchGetInvestigationRefs', async (r) => {
      const ids = Array.isArray(r.account_ids) ? (r.account_ids as unknown[]).map((x) => String(x)) : [];
      const rows = await uc.refs.run(ids);
      return {
        items: rows.map((x) => ({
          account_id: x.accountId,
          contact_refs: x.contactRefs.map((c) => ({ kind: CONTACT_KIND[c.kind], ref: c.ref })),
          device_refs: x.deviceRefs,
          identity_conflicts: x.identityConflicts.map((c) => ({ other_account_id: c.otherAccountId, attempted_at: timestamp(c.attemptedAt) })),
        })),
      };
    }),
  };
}
