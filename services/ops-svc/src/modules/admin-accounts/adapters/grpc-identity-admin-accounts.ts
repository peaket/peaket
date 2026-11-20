// identity 관리 계정 gRPC 클라이언트(ops-svc용). identity.proto AdminAccountService·AdminDesignationService·AdminSessionService.
// 결과 값(AdminAccountResult)을 openapi Problem type으로 바꾼다(ADR-0322). 데드라인 5초 [가정].
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { AdminAccountProblem, type AdminAccountDetail, type AdminAccountView, type AdminDesignationView, type AdminGroup, type AdminRole, type AdminStatus, type DesignationKind, iso } from '../domain/admin-account.js';
import type { AdminIdentity } from '../domain/ports.js';

const DEADLINE_CAP_MS = 5_000;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const ROLE_FROM: Record<string, AdminRole> = {
  ADMIN_ROLE_VIEWER: 'viewer',
  ADMIN_ROLE_OPERATOR: 'operator',
  ADMIN_ROLE_COMMANDER: 'commander',
  ADMIN_ROLE_CS_AGENT: 'cs_agent',
  ADMIN_ROLE_CS_LEAD: 'cs_lead',
  ADMIN_ROLE_PARTNER_ADMIN: 'partner_admin',
  ADMIN_ROLE_PARTNER_MEMBER: 'partner_member',
};
const ROLE_TO = Object.fromEntries(Object.entries(ROLE_FROM).map(([k, v]) => [v, k])) as Record<AdminRole, string>;
const STATUS_FROM: Record<string, AdminStatus> = { ADMIN_ACCOUNT_STATUS_INVITED: 'INVITED', ADMIN_ACCOUNT_STATUS_ACTIVE: 'ACTIVE', ADMIN_ACCOUNT_STATUS_INVITE_EXPIRED: 'INVITE_EXPIRED', ADMIN_ACCOUNT_STATUS_REMOVED: 'REMOVED' };
const LOCK_FROM: Record<string, AdminAccountView['lockKind']> = { ADMIN_LOCK_KIND_NONE: 'NONE', ADMIN_LOCK_KIND_TIMED: 'TIMED', ADMIN_LOCK_KIND_PROTECT: 'PROTECT' };
const LOCK_REASON_FROM: Record<string, NonNullable<AdminAccountView['lockReason']>> = {
  ADMIN_LOCK_REASON_FAILED_ATTEMPTS: 'FAILED_ATTEMPTS',
  ADMIN_LOCK_REASON_SECOND_FACTOR_FAILURES: 'SECOND_FACTOR_FAILURES',
  ADMIN_LOCK_REASON_PASSWORD_FAILURE_TOTAL: 'PASSWORD_FAILURE_TOTAL',
};
const DESIGNATION_FROM: Record<string, DesignationKind> = {
  DESIGNATION_KIND_ACCESS_REVIEWER: 'ACCESS_REVIEWER',
  DESIGNATION_KIND_PSEUDONYM_HANDLER: 'PSEUDONYM_HANDLER',
  DESIGNATION_KIND_FRAUD_INVESTIGATOR: 'FRAUD_INVESTIGATOR',
};
const DESIGNATION_TO = Object.fromEntries(Object.entries(DESIGNATION_FROM).map(([k, v]) => [v, k])) as Record<DesignationKind, string>;
const REINVITE_TO: Record<'RESEND' | 'PROTECT_LOCK' | 'CREDENTIAL_LOST', string> = {
  RESEND: 'REINVITE_REASON_RESEND',
  PROTECT_LOCK: 'REINVITE_REASON_PROTECT_LOCK',
  CREDENTIAL_LOST: 'REINVITE_REASON_CREDENTIAL_LOST',
};

/** AdminAccountResult → openapi Problem. OK·모르는 값은 null */
function problemOf(result: unknown, action: string): AdminAccountProblem | null {
  const r = String(result ?? '').replace(/^ADMIN_ACCOUNT_RESULT_/, '');
  switch (r) {
    case 'OK':
      return null;
    case 'ROLE_NOT_ALLOWED':
      return new AdminAccountProblem('admin-role-not-allowed', 403, '그 역할의 계정을 다룰 수 없습니다');
    case 'SELF_TARGET':
      return new AdminAccountProblem('self-target-forbidden', 403, '자기 계정은 바꿀 수 없습니다');
    case 'LAST_PARTNER_ADMIN':
      return new AdminAccountProblem('last-partner-admin', 409, '그 파트너사의 마지막 관리자입니다');
    case 'STATE_CONFLICT':
      return new AdminAccountProblem('admin-account-state-conflict', 409, '지금 상태에서는 할 수 없습니다');
    case 'EMAIL_IN_USE':
      return new AdminAccountProblem('admin-email-in-use', 409, '이미 쓰는 업무 이메일입니다');
    case 'ROLE_GROUP_MISMATCH':
      return new AdminAccountProblem('role-group-mismatch', 422, '파트너 역할과 관제 역할 사이는 바꿀 수 없습니다');
    case 'PROMOTER_MISMATCH':
      return new AdminAccountProblem('promoter-mismatch', 422, '파트너사 조건이 맞지 않습니다');
    case 'FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN':
      return new AdminAccountProblem('first-partner-account-must-be-admin', 422, '파트너사의 첫 계정은 partner_admin이어야 합니다');
    case 'VERSION_MISMATCH':
      return new AdminAccountProblem('precondition-failed', 412, '다른 사람이 먼저 바꿨습니다');
    case 'APPROVAL_REQUIRED':
      return new AdminAccountProblem('admin-account-state-conflict', 409, 'commander 역할 변경은 승인 업무가 필요합니다');
    case 'COMMANDER_REMOVAL_NEEDS_ROLE_CHANGE':
      return new AdminAccountProblem('commander-removal-needs-role-change', 409, 'commander 계정은 먼저 역할을 내려야 합니다');
    case 'DESIGNATION_TARGET_NOT_COMMANDER':
      return new AdminAccountProblem('designation-target-not-commander', 422, '활성 commander가 아닙니다');
    case 'DESIGNATION_EXISTS':
      return new AdminAccountProblem('designation-exists', 409, '같은 종류의 지정이 이미 있습니다');
    case 'DESIGNATION_TARGET_NOT_ELIGIBLE':
      return new AdminAccountProblem('designation-target-not-eligible', 422, '그 역할은 이 지정을 받을 수 없습니다');
    case 'DESIGNATION_CONFLICT':
      return new AdminAccountProblem('designation-conflict', 409, '함께 둘 수 없는 지정이 있습니다');
    default:
      return new AdminAccountProblem('admin-account-state-conflict', 409, `${action} 결과를 알 수 없습니다`);
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function accountOf(raw: unknown): AdminAccountView {
  const a = (raw ?? {}) as Record<string, unknown>;
  const group: AdminGroup = str(a.group) === 'ADMIN_ACCOUNT_GROUP_PARTNER' ? 'PARTNER' : 'OPS';
  const lockKind = LOCK_FROM[str(a.lock_kind)] ?? 'NONE';
  const lockReason = LOCK_REASON_FROM[str(a.lock_reason)];
  return {
    adminAccountId: str(a.admin_account_id),
    emailMasked: str(a.email_masked),
    displayName: str(a.display_name) || null,
    group,
    role: ROLE_FROM[str(a.role)] ?? 'viewer',
    ...(str(a.promoter_id) ? { promoterId: str(a.promoter_id) } : {}),
    status: STATUS_FROM[str(a.status)] ?? 'REMOVED',
    lockKind,
    ...(lockKind !== 'NONE' && lockReason ? { lockReason } : {}),
    ...(num(a.locked_until_ms) > 0 ? { lockedUntil: iso(num(a.locked_until_ms))! } : {}),
    totpEnrolled: a.totp_enrolled === true,
    passkeyCount: num(a.passkey_count),
    designations: (Array.isArray(a.designations) ? a.designations : []).map((d) => DESIGNATION_FROM[String(d)]).filter((d): d is DesignationKind => d !== undefined),
    ...(num(a.invite_expires_at_ms) > 0 ? { inviteExpiresAt: iso(num(a.invite_expires_at_ms))! } : {}),
    ...(num(a.last_login_at_ms) > 0 ? { lastLoginAt: iso(num(a.last_login_at_ms))! } : {}),
    ...(num(a.removed_at_ms) > 0 ? { removedAt: iso(num(a.removed_at_ms))! } : {}),
    version: num(a.version),
  };
}

const changeOf = (v: Record<string, unknown> | undefined, action: string): AdminAccountView | null => {
  const problem = problemOf(v?.result, action);
  if (problem) throw problem;
  return v?.account ? accountOf(v.account) : null;
};

type AccountsClient = grpc.Client & { ListAdminAccounts: Unary; GetAdminAccount: Unary; InviteAdminAccount: Unary; ChangeAdminRole: Unary; ReinviteAdminAccount: Unary; RemoveAdminAccount: Unary };
type DesignationsClient = grpc.Client & { SetAdminDesignation: Unary; RevokeAdminDesignation: Unary; GetAdminDesignations: Unary };
type SessionsClient = grpc.Client & { TerminateAdminSessions: Unary };

export class GrpcIdentityAdminAccounts implements AdminIdentity {
  readonly #accounts: AccountsClient;
  readonly #designations: DesignationsClient;
  readonly #sessions: SessionsClient;

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PEAKET_IDENTITY_GRPC_URL은 host:port여야 한다: ${address}`);
    const host = address.slice(0, at);
    const client = (name: string) => createGrpcClient(pkg[name] as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'identity-svc', timeoutCapMs: DEADLINE_CAP_MS }) as unknown as grpc.Client & Record<string, Unary>;
    this.#accounts = client('AdminAccountService') as unknown as AccountsClient;
    this.#designations = client('AdminDesignationService') as unknown as DesignationsClient;
    this.#sessions = client('AdminSessionService') as unknown as SessionsClient;
  }

  #call(client: grpc.Client, method: string, req: object): Promise<Record<string, unknown>> {
    const fn = (client as unknown as Record<string, Unary>)[method];
    return new Promise((res, rej) => {
      fn(req, new grpc.Metadata(), { deadline: Date.now() + DEADLINE_CAP_MS }, (e, v) => {
        if (e) return rej(e);
        res(v ?? {});
      });
    });
  }

  async list(q: Parameters<AdminIdentity['list']>[0]) {
    const out = await this.#call(this.#accounts, 'ListAdminAccounts', {
      group: q.group === 'PARTNER' ? 'ADMIN_ACCOUNT_GROUP_PARTNER' : 'ADMIN_ACCOUNT_GROUP_OPS',
      ...(q.promoterId ? { promoter_id: q.promoterId } : {}),
      ...(q.status ? { status: `ADMIN_ACCOUNT_STATUS_${q.status}` } : {}),
      ...(q.cursor ? { page_token: q.cursor } : {}),
      page_size: q.limit,
    });
    return {
      items: (Array.isArray(out.accounts) ? out.accounts : []).map(accountOf),
      nextCursor: str(out.next_page_token) || null,
    };
  }

  async get(adminAccountId: string): Promise<AdminAccountDetail | null> {
    try {
      const out = await this.#call(this.#accounts, 'GetAdminAccount', { admin_account_id: adminAccountId });
      return {
        ...accountOf(out.account),
        sessions: (Array.isArray(out.sessions) ? out.sessions : []).map((s) => {
          const x = (s ?? {}) as Record<string, unknown>;
          return { sessionId: str(x.session_id), browser: str(x.browser), os: str(x.os), createdAt: iso(num(x.created_at_ms)) ?? new Date(0).toISOString(), lastActiveAt: iso(num(x.last_active_at_ms)) ?? new Date(0).toISOString() };
        }),
      };
    } catch (e) {
      if (grpcCode(e) === grpc.status.NOT_FOUND) return null;
      throw e;
    }
  }

  async invite(i: Parameters<AdminIdentity['invite']>[0]) {
    const out = await this.#call(this.#accounts, 'InviteAdminAccount', {
      request_id: i.requestId,
      acted_by: i.actedBy,
      email: i.email,
      display_name: i.displayName,
      role: ROLE_TO[i.role],
      ...(i.promoterId ? { promoter_id: i.promoterId } : {}),
    });
    const account = changeOf(out, '초대');
    if (!account) throw new AdminAccountProblem('admin-account-state-conflict', 409, '초대한 계정을 받지 못했습니다');
    return account;
  }

  async changeRole(i: Parameters<AdminIdentity['changeRole']>[0]) {
    const out = await this.#call(this.#accounts, 'ChangeAdminRole', {
      request_id: i.requestId,
      acted_by: i.actedBy,
      admin_account_id: i.adminAccountId,
      role: ROLE_TO[i.role],
      expected_version: i.expectedVersion,
      ...(i.approvalId ? { approval_id: i.approvalId } : {}),
    });
    const account = changeOf(out, '역할 변경');
    if (!account) throw new AdminAccountProblem('admin-account-state-conflict', 409, '바뀐 계정을 받지 못했습니다');
    return account;
  }

  async reinvite(i: Parameters<AdminIdentity['reinvite']>[0]) {
    const out = await this.#call(this.#accounts, 'ReinviteAdminAccount', {
      request_id: i.requestId,
      acted_by: i.actedBy,
      admin_account_id: i.adminAccountId,
      reason: REINVITE_TO[i.reason],
    });
    const account = changeOf(out, '재초대');
    if (!account) throw new AdminAccountProblem('admin-account-state-conflict', 409, '재초대한 계정을 받지 못했습니다');
    return account;
  }

  async remove(i: Parameters<AdminIdentity['remove']>[0]) {
    const out = await this.#call(this.#accounts, 'RemoveAdminAccount', { request_id: i.requestId, acted_by: i.actedBy, admin_account_id: i.adminAccountId });
    return changeOf(out, '삭제');
  }

  async designate(i: Parameters<AdminIdentity['designate']>[0]): Promise<AdminDesignationView> {
    const out = await this.#call(this.#designations, 'SetAdminDesignation', {
      request_id: i.requestId,
      acted_by: i.actedBy,
      admin_account_id: i.adminAccountId,
      kind: DESIGNATION_TO[i.kind],
      basis: i.basis,
    });
    const problem = problemOf(out.result, '지정');
    if (problem) throw problem;
    return { kind: i.kind, basis: i.basis, designatedBy: i.actedBy, designatedAt: new Date().toISOString() };
  }

  async revokeDesignation(i: Parameters<AdminIdentity['revokeDesignation']>[0]): Promise<void> {
    const out = await this.#call(this.#designations, 'RevokeAdminDesignation', {
      request_id: i.requestId,
      acted_by: i.actedBy,
      admin_account_id: i.adminAccountId,
      kind: DESIGNATION_TO[i.kind],
    });
    const problem = problemOf(out.result, '지정 거두기');
    if (problem) throw problem;
  }

  async terminateSessions(i: Parameters<AdminIdentity['terminateSessions']>[0]) {
    const out = await this.#call(this.#sessions, 'TerminateAdminSessions', {
      request_id: i.requestId,
      acted_by: i.actedBy,
      admin_account_id: i.adminAccountId,
      ...(i.sessionId ? { session_id: i.sessionId } : {}),
    });
    return { endedCount: num(out.ended_count), alreadyDone: out.already_done === true };
  }

  async designations(adminAccountId: string): Promise<DesignationKind[]> {
    const out = await this.#call(this.#designations, 'GetAdminDesignations', { admin_account_id: adminAccountId });
    return (Array.isArray(out.kinds) ? out.kinds : []).map((k) => DESIGNATION_FROM[String(k)]).filter((k): k is DesignationKind => k !== undefined);
  }

  close(): void {
    this.#accounts.close();
    this.#designations.close();
    this.#sessions.close();
  }
}

const grpcCode = (e: unknown): number | undefined => (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : undefined);

/** identity 주소가 없을 때(시작 조립 실패) 닫힌 대역: 모든 호출이 503 */
export class UnavailableAdminIdentity implements AdminIdentity {
  #down(): never {
    throw new AdminAccountProblem('admin-account-unavailable', 503, '관리 계정 서비스에 닿지 못했습니다', 1);
  }
  async list(): Promise<never> {
    return this.#down();
  }
  async get(): Promise<never> {
    return this.#down();
  }
  async invite(): Promise<never> {
    return this.#down();
  }
  async changeRole(): Promise<never> {
    return this.#down();
  }
  async reinvite(): Promise<never> {
    return this.#down();
  }
  async remove(): Promise<never> {
    return this.#down();
  }
  async designate(): Promise<never> {
    return this.#down();
  }
  async revokeDesignation(): Promise<never> {
    return this.#down();
  }
  async terminateSessions(): Promise<never> {
    return this.#down();
  }
  async designations(): Promise<never> {
    return this.#down();
  }
}
