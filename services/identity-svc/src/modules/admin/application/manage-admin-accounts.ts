// 관리 계정 관리(gRPC AdminAccountService의 읽기·초대·재초대·삭제·역할 변경, docs/features/identity.md §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150).
// 부르는 쪽은 ops-svc 하나다. 요청자의 지금 역할을 DB로 다시 보고 대상 규칙(자기 자신, 마지막 partner_admin, 역할 묶음, 판, commander의 승인 ID)을 지킨다.
// 바꾸는 호출은 request_id로 멱등이고, 대상 행(과 그 파트너사의 partner_admin 행)을 잠근 한 트랜잭션에서 한다. 거절은 결과 값으로 돌려준다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ADMIN_MANAGEMENT_STORE, type AdminAccountRequestKind, type AdminManagementStore, type AdminManagementTx, type AdminRole, type AdminStatus, DESIGNATION_KINDS, type DesignationKind, type LockedAccount, type ManagedAccount, ROLES_OF_AUD } from '../domain/ports.js';

export type AdminAccountResultName =
  | 'OK'
  | 'ROLE_NOT_ALLOWED'
  | 'SELF_TARGET'
  | 'LAST_PARTNER_ADMIN'
  | 'STATE_CONFLICT'
  | 'EMAIL_IN_USE'
  | 'ROLE_GROUP_MISMATCH'
  | 'PROMOTER_MISMATCH'
  | 'FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN'
  | 'VERSION_MISMATCH'
  | 'APPROVAL_REQUIRED'
  | 'COMMANDER_REMOVAL_NEEDS_ROLE_CHANGE'
  | 'DESIGNATION_TARGET_NOT_COMMANDER'
  | 'DESIGNATION_EXISTS'
  | 'DESIGNATION_TARGET_NOT_ELIGIBLE'
  | 'DESIGNATION_CONFLICT';

export type AdminAccountGroupName = 'OPS' | 'PARTNER';

/** 밖으로 내보내는 계정 한 줄(가린 이메일, 보이는 상태) */
export interface AdminAccountView {
  adminAccountId: string;
  emailMasked: string;
  group: AdminAccountGroupName;
  role: AdminRole;
  promoterId: string | null;
  status: AdminStatus;
  lockKind: ManagedAccount['lockKind'];
  lockReason: ManagedAccount['lockReason'];
  lockedUntil: number | null;
  totpEnrolled: boolean;
  passkeyCount: number;
  designations: DesignationKind[];
  inviteExpiresAt: number | null;
  lastLoginAt: number | null;
  removedAt: number | null;
  displayName: string | null;
  version: number;
}

export interface AdminAccountChange {
  result: AdminAccountResultName;
  account?: AdminAccountView;
  alreadyDone: boolean;
}

/** 한 호출의 결과와, OK일 때 마지막에 끝낼 세션(이유) */
type Step = AdminAccountResultName | { result: 'OK'; end?: { id: string; reason: 'ADMIN_FORCE' | 'DELETE' | 'ROLE_CHANGED' } };

/** 대상 계정이 없다(gRPC NOT_FOUND, identity.proto). 멱등 기록에 남기지 않는다(재검토 2026-11-05) */
export class AdminAccountNotFound extends Error {
  constructor() {
    super('관리 계정이 없다');
    this.name = 'AdminAccountNotFound';
  }
}

/** 입력 꼴이 틀렸다(gRPC INVALID_ARGUMENT) */
export class AdminAccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminAccountInputError';
  }
}

const PARTNER_ROLES = ROLES_OF_AUD.partner;
const OPS_ROLES = ROLES_OF_AUD.ops;
const ALL_ROLES: readonly AdminRole[] = [...PARTNER_ROLES, ...OPS_ROLES];
const isPartnerRole = (r: AdminRole) => PARTNER_ROLES.includes(r);
const DEFAULT_PAGE = 50;
/** 지정을 받을 수 있는 역할(identity §6 '관리 계정 지정', ADR-0171 결정 7) */
const ELIGIBLE: Record<DesignationKind, readonly AdminRole[]> = { ACCESS_REVIEWER: ['commander'], PSEUDONYM_HANDLER: ['commander'], FRAUD_INVESTIGATOR: ['commander', 'cs_lead'] };
/** 한 계정에 함께 두지 않는 지정(조사·연구 갈래를 잇지 않는다) */
const CONFLICTS: Partial<Record<DesignationKind, DesignationKind>> = { FRAUD_INVESTIGATOR: 'PSEUDONYM_HANDLER', PSEUDONYM_HANDLER: 'FRAUD_INVESTIGATOR' };
/** 함께 둘 수 없는 지정을 거둔 뒤 다른 쪽을 주지 않는 기간 [가정] */
const COOLING_MS = 90 * 24 * 60 * 60_000;
/** 그 역할이 받을 수 없는 지정 종류 */
const notEligible = (role: AdminRole): DesignationKind[] => DESIGNATION_KINDS.filter((k) => !ELIGIBLE[k].includes(role));
const MAX_PAGE = 100;
/** 제어 문자(C0·C1)와 양방향 제어 문자 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/gu;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 가린 업무 이메일: 앞 2자 + *** + @ 뒤 그대로(앞부분이 2자 이하면 첫 자만). 예: op***@stella.example */
export function maskAdminEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = [...email.slice(0, at)];
  return `${local.slice(0, local.length <= 2 ? 1 : 2).join('')}***${email.slice(at)}`;
}

/** 보이는 상태: 만료가 지난 INVITED는 INVITE_EXPIRED */
export const effectiveStatus = (a: Pick<ManagedAccount, 'status' | 'inviteExpiresAt'>, now: number): AdminStatus =>
  a.status === 'INVITED' && a.inviteExpiresAt !== null && a.inviteExpiresAt <= now ? 'INVITE_EXPIRED' : a.status;

export function viewOf(a: ManagedAccount, now: number): AdminAccountView {
  const status = effectiveStatus(a, now);
  const removed = a.status === 'REMOVED';
  // 지금 걸린 잠금만 싣는다: 끝난 시간 잠금은 DB에 TIMED로 남아도 잠김이 아니다(auth-controls §3.2, 재검토 2026-11-05)
  const lock = removed ? 'NONE' : a.lockKind === 'PROTECT' ? 'PROTECT' : a.lockKind === 'TIMED' && a.lockedUntil !== null && a.lockedUntil > now ? 'TIMED' : 'NONE';
  return {
    adminAccountId: a.id,
    emailMasked: removed || !a.email ? '' : maskAdminEmail(a.email),
    group: isPartnerRole(a.role) ? 'PARTNER' : 'OPS',
    role: a.role,
    promoterId: a.promoterId,
    status,
    lockKind: lock,
    lockReason: lock === 'NONE' ? null : a.lockReason,
    lockedUntil: lock === 'TIMED' ? a.lockedUntil : null,
    totpEnrolled: !removed && a.totpEnrolled,
    passkeyCount: removed ? 0 : a.passkeyCount,
    designations: removed ? [] : a.designations,
    inviteExpiresAt: status === 'INVITED' ? a.inviteExpiresAt : null,
    lastLoginAt: removed ? null : a.lastLoginAt,
    removedAt: a.removedAt,
    displayName: removed ? null : a.displayName,
    version: a.version,
  };
}

function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > 254 || !EMAIL.test(e)) throw new AdminAccountInputError('업무 이메일 꼴이 아니다');
  return e;
}

/** 표시 이름: NFC, 제어·양방향 제어 문자를 지우고 앞뒤 빈칸을 지운 뒤 1~30 글자(grapheme) [가정] */
export function normalizeDisplayName(raw: string): string {
  const s = raw.normalize('NFC').replace(CONTROL, '').trim();
  const graphemes = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)].length;
  if (graphemes < 1 || graphemes > 30) throw new AdminAccountInputError('표시 이름은 1~30자다');
  return s;
}

const requireId = (v: string, what: string) => {
  if (!UUID.test(v)) throw new AdminAccountInputError(`${what}가 UUID가 아니다`);
};
const requireRequestId = (v: string) => {
  if (!v || v.length > 128) throw new AdminAccountInputError('request_id가 없거나 길다');
};

/** 요청자가 그 역할의 계정을 다룰 수 있는가: 파트너 역할은 operator·commander, 관제 역할은 commander */
const actorMay = (actor: LockedAccount | null, target: AdminRole): boolean => {
  if (!actor || actor.status !== 'ACTIVE' || !OPS_ROLES.includes(actor.role)) return false;
  return isPartnerRole(target) ? actor.role === 'operator' || actor.role === 'commander' : actor.role === 'commander';
};

/** 페이지 토큰: base64url(JSON [마지막 접속 ms 또는 null, ID]) */
const encodeToken = (a: ManagedAccount) => Buffer.from(JSON.stringify([a.lastLoginAt, a.id])).toString('base64url');
function decodeToken(t: string): { lastLoginAt: number | null; id: string } {
  try {
    const v = JSON.parse(Buffer.from(t, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && (v[0] === null || Number.isInteger(v[0])) && typeof v[1] === 'string' && UUID.test(v[1])) return { lastLoginAt: v[0] as number | null, id: v[1] };
  } catch {
    // 아래에서 거절
  }
  throw new AdminAccountInputError('page_token이 틀렸다');
}

@Injectable()
export class ManageAdminAccounts {
  constructor(
    @Inject(ADMIN_MANAGEMENT_STORE) private readonly store: AdminManagementStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** pageToken은 키셋 커서(계정 ID를 담는다, ops-svc만 본다). offset은 밖에 내는 불투명 커서용(파트너 팀 계정 REST, 계정 ID를 싣지 않는다) */
  async list(q: { group: AdminAccountGroupName; promoterId?: string; status?: AdminStatus; pageToken?: string; offset?: number; pageSize?: number; excludeRemoved?: boolean }): Promise<{ accounts: AdminAccountView[]; nextPageToken: string | null; nextOffset: number | null }> {
    if (q.promoterId) requireId(q.promoterId, 'promoter_id');
    const limit = Math.min(MAX_PAGE, Math.max(1, q.pageSize || DEFAULT_PAGE));
    const now = this.clock.now();
    const rows = await this.store.listManaged({
      roles: q.group === 'PARTNER' ? PARTNER_ROLES : OPS_ROLES,
      ...(q.group === 'PARTNER' && q.promoterId ? { promoterId: q.promoterId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.excludeRemoved ? { excludeRemoved: true } : {}),
      ...(q.pageToken ? { after: decodeToken(q.pageToken) } : {}),
      ...(q.offset ? { offset: q.offset } : {}),
      limit: limit + 1,
      now,
    });
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    return { accounts: page.map((a) => viewOf(a, now)), nextPageToken: more ? encodeToken(page[page.length - 1]!) : null, nextOffset: more ? (q.offset ?? 0) + limit : null };
  }

  async get(id: string): Promise<{ account: AdminAccountView; sessions: { sessionId: string; createdAt: number; lastActiveAt: number }[] } | null> {
    requireId(id, 'admin_account_id');
    const now = this.clock.now();
    const a = await this.store.getManaged(id);
    if (!a) return null;
    const sessions = a.status === 'REMOVED' ? [] : await this.store.liveSessions(id, now);
    // 마지막 활동 = 유휴 만료 − 1시간(유휴 만료는 활동마다 1시간 뒤로 간다, POL-019). 브라우저·OS는 세션에 적지 않는다
    return { account: viewOf(a, now), sessions: sessions.map((s) => ({ sessionId: s.id, createdAt: s.createdAt, lastActiveAt: Math.max(s.createdAt, s.idleExpiresAt - 60 * 60_000) })) };
  }

  async invite(i: { requestId: string; actedBy: string; email: string; role: AdminRole; displayName: string; promoterId?: string }): Promise<AdminAccountChange> {
    requireRequestId(i.requestId);
    requireId(i.actedBy, 'acted_by');
    if (!ALL_ROLES.includes(i.role)) throw new AdminAccountInputError('모르는 역할이다');
    if (i.promoterId) requireId(i.promoterId, 'promoter_id');
    const email = normalizeEmail(i.email);
    const displayName = normalizeDisplayName(i.displayName);
    const id = randomUUID();
    return this.#change(i.requestId, 'INVITE', id, async (tx, now) => {
      const actor = await tx.readAccount(i.actedBy);
      // commander는 초대하지 않는다(역할 변경의 2인 승인으로만 준다, POL-038 ⑨)
      if (i.role === 'commander' || !actorMay(actor, i.role)) return 'ROLE_NOT_ALLOWED';
      if (isPartnerRole(i.role) !== Boolean(i.promoterId)) return 'PROMOTER_MISMATCH';
      if (i.role === 'partner_member') {
        const admins = await tx.lockPartnerAdmins(i.promoterId!);
        if (!admins.some((a) => effectiveStatus(a, now) === 'ACTIVE' || effectiveStatus(a, now) === 'INVITED')) return 'FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN';
      }
      // 같은 이메일은 넣을 때 고유 색인으로 가린다(동시에 와도 하나만 들어가고 나머지는 EMAIL_IN_USE, 재검토 2026-11-05)
      if (!(await tx.insertInvited({ id, role: i.role, promoterId: i.promoterId ?? null, email, displayName, now }))) return 'EMAIL_IN_USE';
      await tx.addNotice(id, 'INVITATION', now);
      return 'OK';
    });
  }

  async changeRole(i: { requestId: string; actedBy: string; accountId: string; role: AdminRole; expectedVersion: number; approvalId?: string }): Promise<AdminAccountChange> {
    requireRequestId(i.requestId);
    requireId(i.actedBy, 'acted_by');
    requireId(i.accountId, 'admin_account_id');
    if (!ALL_ROLES.includes(i.role)) throw new AdminAccountInputError('모르는 역할이다');
    return this.#change(i.requestId, 'CHANGE_ROLE', i.accountId, async (tx, now) => {
      if (i.accountId === i.actedBy) return 'SELF_TARGET';
      const actor = await tx.readAccount(i.actedBy);
      const target = await this.#lockTarget(tx, i.accountId);
      if (!target) throw new AdminAccountNotFound();
      if (target.status === 'REMOVED') return 'STATE_CONFLICT';
      if (isPartnerRole(target.role) !== isPartnerRole(i.role)) return 'ROLE_GROUP_MISMATCH';
      if (!actorMay(actor, target.role) || !actorMay(actor, i.role)) return 'ROLE_NOT_ALLOWED';
      if (target.version !== i.expectedVersion) return 'VERSION_MISMATCH';
      if (target.role === i.role) return 'OK';
      // commander가 되거나 commander에서 바뀌는 변경은 승인된 승인 업무(COMMANDER_ROLE_CHANGE)의 ID가 있어야 한다(승인 여부는 ops-svc가 본다)
      if ((target.role === 'commander' || i.role === 'commander') && !i.approvalId) return 'APPROVAL_REQUIRED';
      if (target.role === 'partner_admin' && i.role === 'partner_member' && (await this.#lastActivePartnerAdmin(tx, target, now))) return 'LAST_PARTNER_ADMIN';
      await tx.setRole(target.id, i.role, now);
      // 새 역할이 받을 수 없는 지정을 같은 트랜잭션에서 거둔다(BOT-151)
      await tx.revokeDesignations(target.id, notEligible(i.role), now);
      return { result: 'OK', end: { id: target.id, reason: 'ROLE_CHANGED' } };
    });
  }

  async reinvite(i: { requestId: string; actedBy: string; accountId: string; reason: 'RESEND' | 'PROTECT_LOCK' | 'CREDENTIAL_LOST' }): Promise<AdminAccountChange> {
    requireRequestId(i.requestId);
    requireId(i.actedBy, 'acted_by');
    requireId(i.accountId, 'admin_account_id');
    if (!['RESEND', 'PROTECT_LOCK', 'CREDENTIAL_LOST'].includes(i.reason)) throw new AdminAccountInputError('모르는 재초대 까닭이다');
    return this.#change(i.requestId, 'REINVITE', i.accountId, async (tx, now) => {
      if (i.accountId === i.actedBy) return 'SELF_TARGET';
      const actor = await tx.readAccount(i.actedBy);
      const target = await this.#lockTarget(tx, i.accountId);
      if (!target) throw new AdminAccountNotFound();
      if (target.status === 'REMOVED') return 'STATE_CONFLICT';
      if (!actorMay(actor, target.role)) return 'ROLE_NOT_ALLOWED';
      if (i.reason === 'RESEND') {
        if (target.status !== 'INVITED' && target.status !== 'INVITE_EXPIRED') return 'STATE_CONFLICT';
        await tx.resetInvite(target.id, now);
      } else {
        if (target.status !== 'ACTIVE') return 'STATE_CONFLICT';
        // 보호 잠금 해제는 보호 잠금인 계정만(시간 잠금만이면 409, 본인 해제 링크로 푼다)
        if (i.reason === 'PROTECT_LOCK' && target.lockKind !== 'PROTECT') return 'STATE_CONFLICT';
        await tx.wipeCredentials(target.id, now);
      }
      await tx.addNotice(target.id, 'INVITATION', now);
      return i.reason === 'RESEND' ? 'OK' : { result: 'OK', end: { id: target.id, reason: 'ADMIN_FORCE' } };
    });
  }

  async remove(i: { requestId: string; actedBy: string; accountId: string }): Promise<AdminAccountChange> {
    requireRequestId(i.requestId);
    requireId(i.actedBy, 'acted_by');
    requireId(i.accountId, 'admin_account_id');
    return this.#change(i.requestId, 'REMOVE', i.accountId, async (tx, now) => {
      if (i.accountId === i.actedBy) return 'SELF_TARGET';
      const actor = await tx.readAccount(i.actedBy);
      const target = await this.#lockTarget(tx, i.accountId);
      if (!target) throw new AdminAccountNotFound();
      if (target.status === 'REMOVED') return 'STATE_CONFLICT';
      if (!actorMay(actor, target.role)) return 'ROLE_NOT_ALLOWED';
      if (target.role === 'commander') return 'COMMANDER_REMOVAL_NEEDS_ROLE_CHANGE';
      if (target.role === 'partner_admin' && (await this.#lastActivePartnerAdmin(tx, target, now))) return 'LAST_PARTNER_ADMIN';
      await tx.markRemoved(target.id, now);
      await tx.revokeDesignations(target.id, DESIGNATION_KINDS, now);
      return { result: 'OK', end: { id: target.id, reason: 'DELETE' } };
    });
  }

  /** 지정(BOT-151): 요청자는 활성 commander, 대상 행을 잠근 뒤 대상 역할·같은 종류·함께 둘 수 없는 지정·90일 냉각을 본다 */
  async designate(i: { requestId: string; actedBy: string; accountId: string; kind: DesignationKind; basis: string }): Promise<AdminAccountChange> {
    requireRequestId(i.requestId);
    requireId(i.actedBy, 'acted_by');
    requireId(i.accountId, 'admin_account_id');
    if (!DESIGNATION_KINDS.includes(i.kind)) throw new AdminAccountInputError('모르는 지정 종류다');
    const basis = i.basis.normalize('NFC').replace(CONTROL, '').trim();
    // 코드포인트로 센다(openapi maxLength와 같은 단위, 재검토 2026-11-05)
    const chars = [...basis].length;
    if (chars < 1 || chars > 200) throw new AdminAccountInputError('지정 근거는 1~200자다');
    return this.#change(i.requestId, 'DESIGNATE', i.accountId, async (tx, now) => {
      if (i.accountId === i.actedBy) return 'SELF_TARGET';
      const actor = await tx.readAccount(i.actedBy);
      const target = await tx.lockAccount(i.accountId);
      if (!target) throw new AdminAccountNotFound();
      if (!actorMay(actor, 'commander')) return 'ROLE_NOT_ALLOWED';
      // 활성이 아니거나 받을 역할이 아니면 종류에 맞는 422 결과(proto 13·15, openapi: '활성 commander가 아닌 계정', 재검토 2026-11-05)
      if (target.status !== 'ACTIVE' || !ELIGIBLE[i.kind].includes(target.role)) return i.kind === 'FRAUD_INVESTIGATOR' ? 'DESIGNATION_TARGET_NOT_ELIGIBLE' : 'DESIGNATION_TARGET_NOT_COMMANDER';
      const d = await tx.designationsFor(target.id, now - COOLING_MS);
      if (d.live.includes(i.kind)) return 'DESIGNATION_EXISTS';
      const other = CONFLICTS[i.kind];
      if (other && (d.live.includes(other) || d.revoked.some((r) => r.kind === other))) return 'DESIGNATION_CONFLICT';
      await tx.insertDesignation({ id: randomUUID(), accountId: target.id, kind: i.kind, basis, by: i.actedBy, now });
      return 'OK';
    });
  }

  /** 지정 거두기: 이미 거둔(없는) 지정이면 OK. 자기 지정도 거둘 수 있다(openapi DELETE …/designations/{kind}, 재검토 2026-11-05) */
  async revokeDesignation(i: { requestId: string; actedBy: string; accountId: string; kind: DesignationKind }): Promise<AdminAccountChange> {
    requireRequestId(i.requestId);
    requireId(i.actedBy, 'acted_by');
    requireId(i.accountId, 'admin_account_id');
    if (!DESIGNATION_KINDS.includes(i.kind)) throw new AdminAccountInputError('모르는 지정 종류다');
    return this.#change(i.requestId, 'REVOKE_DESIGNATION', i.accountId, async (tx, now) => {
      const actor = await tx.readAccount(i.actedBy);
      const target = await tx.lockAccount(i.accountId);
      if (!target) throw new AdminAccountNotFound();
      if (!actorMay(actor, 'commander')) return 'ROLE_NOT_ALLOWED';
      await tx.revokeDesignations(target.id, [i.kind], now);
      return 'OK';
    });
  }

  /** 조회(gRPC GetAdminDesignations): 활성 계정의 살아 있는 지정과 90일 [가정] 안에 거둔 지정. 없거나 활성이 아닌 계정은 살아 있는 지정이 비어 있다 */
  async designationsOf(accountId: string): Promise<{ kinds: DesignationKind[]; recentlyRevoked: { kind: DesignationKind; revokedAt: number }[] }> {
    requireId(accountId, 'admin_account_id');
    const now = this.clock.now();
    // 조사 경로 요청마다 불리므로 계정 상태 한 번과 지정 한 번만 읽는다(재검토 2026-11-05)
    const d = await this.store.designationsOf(accountId, now - COOLING_MS);
    if (d.status === null) return { kinds: [], recentlyRevoked: [] };
    return { kinds: d.status === 'ACTIVE' ? d.live : [], recentlyRevoked: d.revoked };
  }

  /**
   * 대상 행을 잠근다. 대상이 파트너 계정이면(역할과 상관없이: 읽은 뒤 partner_admin으로 바뀌었을 수 있다) 그 파트너사의 partner_admin 행을 ID 순으로 먼저 잠근다.
   * 두 관리자를 동시에 낮추거나 지우는 요청이 서로의 행을 기다리는 교착을 막는다. promoter_id는 바뀌지 않는다. 요청자 행은 잠그지 않는다(같은 까닭)
   */
  async #lockTarget(tx: AdminManagementTx, id: string): Promise<LockedAccount | null> {
    const peek = await tx.readAccount(id);
    if (peek && isPartnerRole(peek.role) && peek.promoterId) await tx.lockPartnerAdmins(peek.promoterId);
    return tx.lockAccount(id);
  }

  /** 대상이 그 파트너사의 마지막 활성 partner_admin인가(그 파트너사의 partner_admin 행을 모두 잠근 뒤 센다) */
  async #lastActivePartnerAdmin(tx: AdminManagementTx, target: LockedAccount, now: number): Promise<boolean> {
    if (target.status !== 'ACTIVE' || !target.promoterId) return false;
    const admins = await tx.lockPartnerAdmins(target.promoterId);
    return !admins.some((a) => a.id !== target.id && effectiveStatus(a, now) === 'ACTIVE');
  }

  /**
   * 멱등 한 트랜잭션: 같은 request_id면 적은 결과, 아니면 처리하고 결과를 적는다(거절도 적는다).
   * 세션 끝내기는 Outbox(세션 종료 사건)를 쓰므로 결과를 적은 뒤 트랜잭션의 마지막 쓰기로 한다(ADR-0143 결정 3)
   */
  async #change(requestId: string, kind: AdminAccountRequestKind, accountId: string, fn: (tx: AdminManagementTx, now: number) => Promise<Step>): Promise<AdminAccountChange> {
    const now = this.clock.now();
    const done = await this.store.manageTransaction(async (tx) => {
      const prev = await tx.findRequest(requestId);
      if (prev) {
        // 같은 request_id로 다른 종류·다른 대상을 부르면 엉뚱한 결과를 주지 않는다(초대는 만든 계정 ID라 종류만 본다, 재검토 2026-11-05)
        if (prev.kind !== kind || (kind !== 'INVITE' && prev.accountId !== accountId)) throw new AdminAccountInputError('같은 request_id로 다른 호출이 왔다');
        return { result: prev.result as AdminAccountResultName, accountId: prev.accountId, alreadyDone: true };
      }
      const step = await fn(tx, now);
      const result = typeof step === 'string' ? step : step.result;
      await tx.recordRequest({ requestId, kind, accountId, result, at: now });
      if (typeof step !== 'string' && step.end) await tx.endAllSessions(step.end.id, step.end.reason, now);
      return { result, accountId, alreadyDone: false };
    });
    if (done.result !== 'OK') return { result: done.result, alreadyDone: done.alreadyDone };
    const a = await this.store.getManaged(done.accountId);
    return { result: 'OK', alreadyDone: done.alreadyDone, ...(a ? { account: viewOf(a, this.clock.now()) } : {}) };
  }
}
