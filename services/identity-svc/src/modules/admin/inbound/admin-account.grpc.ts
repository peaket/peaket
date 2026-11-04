// 받는 층: gRPC AdminAccountService(identity.proto, docs/api/proto/README.md §3 'ops-svc → identity-svc', BUILD_ORDER BOT-150).
// 부르는 쪽은 ops-svc 하나다(메시 L7 허용 목록). 거절은 결과 값 AdminAccountResult로, 입력 꼴 오류는 INVALID_ARGUMENT로 돌려준다.
// 지정(SetAdminDesignation·RevokeAdminDesignation)은 BOT-151이라 아직 UNIMPLEMENTED다.
import * as grpc from '@grpc/grpc-js';
import { type AdminAccountChange, AdminAccountInputError, AdminAccountNotFound, type AdminAccountView, type ManageAdminAccounts } from '../application/manage-admin-accounts.js';
import type { AdminRole, AdminStatus } from '../domain/ports.js';

type Req = Record<string, unknown>;

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
const STATUS_TO = Object.fromEntries(Object.entries(STATUS_FROM).map(([k, v]) => [v, k])) as Record<AdminStatus, string>;
const REASON_FROM: Record<string, 'RESEND' | 'PROTECT_LOCK' | 'CREDENTIAL_LOST'> = { REINVITE_REASON_RESEND: 'RESEND', REINVITE_REASON_PROTECT_LOCK: 'PROTECT_LOCK', REINVITE_REASON_CREDENTIAL_LOST: 'CREDENTIAL_LOST' };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const role = (v: unknown): AdminRole => {
  const r = ROLE_FROM[str(v)];
  if (!r) throw new AdminAccountInputError('role이 없거나 모른다');
  return r;
};

export function accountMessage(a: AdminAccountView): object {
  return {
    admin_account_id: a.adminAccountId,
    email_masked: a.emailMasked,
    group: a.group === 'PARTNER' ? 'ADMIN_ACCOUNT_GROUP_PARTNER' : 'ADMIN_ACCOUNT_GROUP_OPS',
    role: ROLE_TO[a.role],
    promoter_id: a.promoterId ?? '',
    status: STATUS_TO[a.status],
    lock_kind: `ADMIN_LOCK_KIND_${a.lockKind}`,
    lock_reason: a.lockReason ? `ADMIN_LOCK_REASON_${a.lockReason}` : 'ADMIN_LOCK_REASON_UNSPECIFIED',
    locked_until_ms: a.lockedUntil ?? 0,
    totp_enrolled: a.totpEnrolled,
    passkey_count: a.passkeyCount,
    designations: a.designations.map((d) => `DESIGNATION_KIND_${d}`),
    invite_expires_at_ms: a.inviteExpiresAt ?? 0,
    last_login_at_ms: a.lastLoginAt ?? 0,
    removed_at_ms: a.removedAt ?? 0,
    display_name: a.displayName ?? '',
    version: a.version,
  };
}

const changeMessage = (c: AdminAccountChange): object => ({ result: `ADMIN_ACCOUNT_RESULT_${c.result}`, ...(c.account ? { account: accountMessage(c.account) } : {}), already_done: c.alreadyDone });

export function adminAccountHandlers(uc: { manage: Pick<ManageAdminAccounts, 'list' | 'get' | 'invite' | 'changeRole' | 'reinvite' | 'remove'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const unary =
    (method: string, run: (r: Req) => Promise<object>): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      run(call.request).then(
        (out) => cb(null, out),
        (err: unknown) => {
          if (err instanceof AdminAccountInputError) {
            cb({ code: grpc.status.INVALID_ARGUMENT, details: err.message });
            return;
          }
          if (err instanceof NotFound || err instanceof AdminAccountNotFound) {
            cb({ code: grpc.status.NOT_FOUND, details: '관리 계정이 없다' });
            return;
          }
          onError(method, err instanceof Error ? err.name : 'Error');
          cb({ code: grpc.status.UNAVAILABLE, details: '처리하지 못했다' });
        },
      );
    };
  return {
    ListAdminAccounts: unary('ListAdminAccounts', async (r) => {
      const group = str(r.group);
      if (group !== 'ADMIN_ACCOUNT_GROUP_OPS' && group !== 'ADMIN_ACCOUNT_GROUP_PARTNER') throw new AdminAccountInputError('group이 없다');
      const status = STATUS_FROM[str(r.status)];
      const page = await uc.manage.list({
        group: group === 'ADMIN_ACCOUNT_GROUP_PARTNER' ? 'PARTNER' : 'OPS',
        ...(str(r.promoter_id) ? { promoterId: str(r.promoter_id) } : {}),
        ...(status ? { status } : {}),
        ...(str(r.page_token) ? { pageToken: str(r.page_token) } : {}),
        ...(num(r.page_size) ? { pageSize: num(r.page_size) } : {}),
      });
      return { accounts: page.accounts.map(accountMessage), next_page_token: page.nextPageToken ?? '' };
    }),
    GetAdminAccount: unary('GetAdminAccount', async (r) => {
      const got = await uc.manage.get(str(r.admin_account_id));
      if (!got) throw new NotFound();
      return { account: accountMessage(got.account), sessions: got.sessions.map((s) => ({ session_id: s.sessionId, browser: '', os: '', created_at_ms: s.createdAt, last_active_at_ms: s.lastActiveAt })) };
    }),
    InviteAdminAccount: unary('InviteAdminAccount', async (r) =>
      changeMessage(await uc.manage.invite({ requestId: str(r.request_id), actedBy: str(r.acted_by), email: str(r.email), role: role(r.role), displayName: str(r.display_name), ...(str(r.promoter_id) ? { promoterId: str(r.promoter_id) } : {}) })),
    ),
    ChangeAdminRole: unary('ChangeAdminRole', async (r) =>
      changeMessage(
        await uc.manage.changeRole({ requestId: str(r.request_id), actedBy: str(r.acted_by), accountId: str(r.admin_account_id), role: role(r.role), expectedVersion: num(r.expected_version), ...(str(r.approval_id) ? { approvalId: str(r.approval_id) } : {}) }),
      ),
    ),
    ReinviteAdminAccount: unary('ReinviteAdminAccount', async (r) => {
      const reason = REASON_FROM[str(r.reason)];
      if (!reason) throw new AdminAccountInputError('reason이 없거나 모른다');
      return changeMessage(await uc.manage.reinvite({ requestId: str(r.request_id), actedBy: str(r.acted_by), accountId: str(r.admin_account_id), reason }));
    }),
    RemoveAdminAccount: unary('RemoveAdminAccount', async (r) => changeMessage(await uc.manage.remove({ requestId: str(r.request_id), actedBy: str(r.acted_by), accountId: str(r.admin_account_id) }))),
    // 지정은 BOT-151
    SetAdminDesignation: (_call: unknown, cb: grpc.sendUnaryData<object>) => cb({ code: grpc.status.UNIMPLEMENTED, details: '지정은 아직이다(BUILD_ORDER BOT-151)' }),
    RevokeAdminDesignation: (_call: unknown, cb: grpc.sendUnaryData<object>) => cb({ code: grpc.status.UNIMPLEMENTED, details: '지정은 아직이다(BUILD_ORDER BOT-151)' }),
  };
}

class NotFound extends Error {}
