// 관제 관리 계정 REST의 값·Problem(openapi /v1/ops/admin-accounts*, BUILD_ORDER BOT-152, ADR-0322).
// 역할·상태·지정·Problem type은 openapi와 authz-matrix §6.1, identity.proto AdminAccountResult가 정본이다.
export type AdminRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' | 'partner_admin' | 'partner_member';
export type AdminGroup = 'OPS' | 'PARTNER';
export type AdminStatus = 'INVITED' | 'ACTIVE' | 'INVITE_EXPIRED' | 'REMOVED';
export type DesignationKind = 'ACCESS_REVIEWER' | 'PSEUDONYM_HANDLER' | 'FRAUD_INVESTIGATOR';
export type LockKind = 'NONE' | 'TIMED' | 'PROTECT';

export const PARTNER_ROLES: readonly AdminRole[] = ['partner_admin', 'partner_member'];
export const OPS_ROLES: readonly AdminRole[] = ['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'];
export const DESIGNATION_KINDS: readonly DesignationKind[] = ['ACCESS_REVIEWER', 'PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR'];
export const isPartnerRole = (r: AdminRole): boolean => PARTNER_ROLES.includes(r);
export const groupOf = (r: AdminRole): AdminGroup => (isPartnerRole(r) ? 'PARTNER' : 'OPS');

/** REST가 내보내는 관리 계정 한 줄(openapi AdminAccount) */
export interface AdminAccountView {
  adminAccountId: string;
  emailMasked: string;
  displayName: string | null;
  group: AdminGroup;
  role: AdminRole;
  promoterId?: string;
  status: AdminStatus;
  lockKind: LockKind;
  lockReason?: 'FAILED_ATTEMPTS' | 'SECOND_FACTOR_FAILURES' | 'PASSWORD_FAILURE_TOTAL';
  lockedUntil?: string;
  totpEnrolled: boolean;
  passkeyCount: number;
  designations: DesignationKind[];
  inviteExpiresAt?: string;
  lastLoginAt?: string;
  removedAt?: string;
  version: number;
}

export interface AdminSessionSummary {
  sessionId: string;
  browser: string;
  os: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface AdminAccountDetail extends AdminAccountView {
  sessions: AdminSessionSummary[];
}

export interface AdminDesignationView {
  kind: DesignationKind;
  basis: string;
  designatedBy: string;
  designatedAt: string;
}

export interface AdminPermissionChangeView {
  changedAt: string;
  action: 'INVITED' | 'REINVITED' | 'ROLE_CHANGED' | 'DESIGNATED' | 'DESIGNATION_REVOKED' | 'REMOVED';
  fromRole?: AdminRole;
  toRole?: AdminRole;
  designationKind?: DesignationKind;
  actorAdminAccountId: string;
  actorRole: AdminRole;
  approvalId?: string;
  reason?: string;
}

/** openapi의 Problem type 가운데 이 기능이 내는 것. 새 type을 만들지 않는다 */
export class AdminAccountProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = 'AdminAccountProblem';
  }
}

export const iso = (ms: number | null | undefined): string | undefined => (ms === null || ms === undefined || ms === 0 ? undefined : new Date(ms).toISOString());

/** ETag 판: `"3"`(약한 태그 W/도 받는다). 없거나 틀리면 null */
export function parseIfMatch(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(?:W\/)?"(\d{1,15})"$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const etagOf = (version: number): string => `"${version}"`;
