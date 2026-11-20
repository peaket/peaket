// 관제 관리 계정 REST의 응용 층(openapi /v1/ops/admin-accounts*, BUILD_ORDER BOT-152, ADR-0322).
// 쓰기는 재인증(act=PERMISSION_CHANGE, 패스키)을 먼저 보고, identity 호출 전 REQUESTED · 성공 뒤 SUCCEEDED · 실패 뒤 FAILED를
// 감사 체인에 남긴다. commander 역할의 부여·회수는 COMMANDER_ROLE_CHANGE 승인 업무를 만들고 202로 답한다.
import { createHash } from 'node:crypto';
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { AuditChain, AuditChainReader } from '../../audit/index.js';
import { ReauthUnavailable } from '../../payouts/index.js';
import { type AdminAccountDetail, type AdminAccountView, type AdminPermissionChangeView, type AdminRole, type AdminStatus, type DesignationKind, isPartnerRole, parseIfMatch } from '../domain/admin-account.js';
import type { AdminIdentity, AdminReauth } from '../domain/ports.js';
import { roleChangeApprovalView, type RoleChangeApprovalView } from '../../approvals/domain/approval.js';
import type { RoleChangeApprovals } from './role-change-approvals.js';

export interface OpsActor {
  accountId: string;
  sessionId: string;
  role: string;
}

export interface AdminAccountsDeps {
  readonly identity: AdminIdentity;
  readonly reauth: AdminReauth | undefined;
  readonly approvals: RoleChangeApprovals;
  readonly audit: AuditChain;
  readonly reader?: AuditChainReader;
  readonly clock: Clock;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '관리 계정을 찾을 수 없습니다' });
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
const reauthUnavailable = () => new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 확인기를 쓸 수 없습니다', retryAfterSeconds: 5 });

/** 멱등 키에서 정해진 request_id(UUID 꼴)를 만든다. 같은 키·작업·대상이면 같은 값이라 identity 멱등 기록이 두 번째를 알아본다 */
export function requestIdOf(operation: string, accountRef: string, idempotencyKey: string): string {
  const h = createHash('sha256').update(`BAT-045|${operation}|${accountRef}|${idempotencyKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const reasonOf = (raw: string): string => {
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim();
  if (s.length < 1 || [...s].length > 500) throw new ProblemError({ type: 'invalid-query', status: 400, title: '사유는 1~500자입니다' });
  return s;
};

const actionOf: Record<string, AdminPermissionChangeView['action']> = {
  INVITED: 'INVITED',
  REINVITED: 'REINVITED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  DESIGNATED: 'DESIGNATED',
  DESIGNATION_REVOKED: 'DESIGNATION_REVOKED',
  REMOVED: 'REMOVED',
};

export class AdminAccounts {
  constructor(private readonly d: AdminAccountsDeps) {}

  async list(q: { group: 'OPS' | 'PARTNER'; promoterId?: string; status?: AdminStatus; cursor?: string; limit: number }) {
    return this.d.identity.list(q);
  }

  async get(id: string): Promise<AdminAccountDetail> {
    const a = await this.d.identity.get(id);
    if (!a) throw notFound();
    return a;
  }

  async invite(actor: OpsActor, body: { email: string; displayName: string; role: AdminRole; promoterId?: string }, reauthToken: string | undefined, idempotencyKey: string | undefined): Promise<AdminAccountView> {
    await this.#reauth(reauthToken, actor);
    const requestId = idempotencyKey ? requestIdOf('admin-invite', actor.accountId, idempotencyKey) : uuidv7(this.d.clock);
    const prior = await this.#prior(actor.accountId, requestId);
    if (typeof prior?.createdAccountId === 'string') {
      const a = await this.d.identity.get(prior.createdAccountId);
      if (a) return a;
    }
    const payload = { action: 'INVITED', role: body.role, ...(body.promoterId ? { promoterId: body.promoterId } : {}) };
    await this.#audit('ADMIN_ACCOUNT_INVITED', actor.accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      const account = await this.d.identity.invite({ requestId, actedBy: actor.accountId, email: body.email, displayName: body.displayName, role: body.role, ...(body.promoterId ? { promoterId: body.promoterId } : {}) });
      await this.#audit('ADMIN_ACCOUNT_INVITED', account.adminAccountId, actor, { ...payload, accountId: account.adminAccountId, createdAccountId: account.adminAccountId, requestId, status: 'SUCCEEDED' });
      return account;
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_INVITED', actor.accountId, actor, { ...payload, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async changeRole(actor: OpsActor, accountId: string, body: { role: AdminRole; reason: string }, ifMatch: string | undefined, reauthToken: string | undefined, idempotencyKey: string | undefined): Promise<{ kind: 'changed'; account: AdminAccountView } | { kind: 'approval'; approval: RoleChangeApprovalView }> {
    const target = await this.get(accountId);
    if (target.adminAccountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 역할은 바꿀 수 없습니다' });
    if (isPartnerRole(target.role) !== isPartnerRole(body.role)) throw new ProblemError({ type: 'role-group-mismatch', status: 422, title: '파트너 역할과 관제 역할 사이는 바꿀 수 없습니다' });
    if (actor.role !== 'commander' && (!isPartnerRole(target.role) || !isPartnerRole(body.role))) throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '그 역할의 계정을 다룰 수 없습니다' });
    const version = parseIfMatch(ifMatch);
    if (version === null) throw new ProblemError({ type: 'precondition-required', status: 428, title: 'If-Match 판이 필요합니다' });
    if (version !== target.version) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 바꿨습니다' });
    if (target.status === 'REMOVED') throw new ProblemError({ type: 'admin-account-state-conflict', status: 409, title: '삭제한 계정입니다' });
    const reason = reasonOf(body.reason);
    await this.#reauth(reauthToken, actor);
    const requestId = idempotencyKey ? requestIdOf('admin-role', accountId, idempotencyKey) : uuidv7(this.d.clock);
    const commanderChange = target.role === 'commander' || body.role === 'commander';
    if (commanderChange) {
      const prior = await this.#prior(accountId, requestId);
      if (typeof prior?.approvalId === 'string') {
        const approval = await this.d.approvals.get(prior.approvalId, actor);
        return { kind: 'approval', approval };
      }
      const r = await this.d.approvals.create({ targetRef: accountId, targetVersion: target.version, fromRole: target.role, requestedRole: body.role, reason, requestedBy: actor.accountId });
      await this.#audit('ADMIN_ACCOUNT_ROLE_CHANGED', accountId, actor, { action: 'ROLE_CHANGED', fromRole: target.role, toRole: body.role, reason, requestId, approvalId: r.approvalId, status: 'REQUESTED' });
      return { kind: 'approval', approval: roleChangeApprovalView(r, actor) };
    }
    await this.#audit('ADMIN_ACCOUNT_ROLE_CHANGED', accountId, actor, { action: 'ROLE_CHANGED', fromRole: target.role, toRole: body.role, reason, requestId, status: 'REQUESTED' });
    try {
      const account = await this.d.identity.changeRole({ requestId, actedBy: actor.accountId, adminAccountId: accountId, role: body.role, expectedVersion: version });
      await this.#audit('ADMIN_ACCOUNT_ROLE_CHANGED', accountId, actor, { action: 'ROLE_CHANGED', fromRole: target.role, toRole: body.role, reason, requestId, accountVersion: account.version, status: 'SUCCEEDED' });
      return { kind: 'changed', account };
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_ROLE_CHANGED', accountId, actor, { action: 'ROLE_CHANGED', fromRole: target.role, toRole: body.role, reason, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async reinvite(actor: OpsActor, accountId: string, body: { reasonCode: 'RESEND' | 'PROTECT_LOCK' | 'CREDENTIAL_LOST'; reason: string }, reauthToken: string | undefined, idempotencyKey: string | undefined): Promise<AdminAccountView> {
    const target = await this.get(accountId);
    if (target.adminAccountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 계정은 재초대할 수 없습니다' });
    if (actor.role !== 'commander' && !isPartnerRole(target.role)) throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '그 역할의 계정을 다룰 수 없습니다' });
    const reason = reasonOf(body.reason);
    await this.#reauth(reauthToken, actor);
    const requestId = idempotencyKey ? requestIdOf('admin-reinvite', accountId, idempotencyKey) : uuidv7(this.d.clock);
    const payload = { action: 'REINVITED', reasonCode: body.reasonCode, reason };
    await this.#audit('ADMIN_ACCOUNT_REINVITED', accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      const account = await this.d.identity.reinvite({ requestId, actedBy: actor.accountId, adminAccountId: accountId, reason: body.reasonCode });
      await this.#audit('ADMIN_ACCOUNT_REINVITED', accountId, actor, { ...payload, requestId, status: 'SUCCEEDED' });
      return account;
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_REINVITED', accountId, actor, { ...payload, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async remove(actor: OpsActor, accountId: string, body: { reason: string }, reauthToken: string | undefined): Promise<AdminAccountView | null> {
    const target = await this.get(accountId);
    if (target.adminAccountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 계정은 지울 수 없습니다' });
    if (target.role === 'commander') throw new ProblemError({ type: 'commander-removal-needs-role-change', status: 409, title: 'commander 계정은 먼저 역할을 내려야 합니다' });
    if (actor.role !== 'commander' && !isPartnerRole(target.role)) throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '그 역할의 계정을 지울 수 없습니다' });
    const reason = reasonOf(body.reason);
    await this.#reauth(reauthToken, actor);
    const requestId = uuidv7(this.d.clock);
    const payload = { action: 'REMOVED', reason };
    await this.#audit('ADMIN_ACCOUNT_REMOVED', accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      const account = await this.d.identity.remove({ requestId, actedBy: actor.accountId, adminAccountId: accountId });
      await this.#audit('ADMIN_ACCOUNT_REMOVED', accountId, actor, { ...payload, requestId, status: 'SUCCEEDED' });
      return account;
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_REMOVED', accountId, actor, { ...payload, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async designate(actor: OpsActor, accountId: string, body: { kind: DesignationKind; basis: string }, reauthToken: string | undefined, idempotencyKey: string | undefined) {
    if (accountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기에게 지정할 수 없습니다' });
    await this.#reauth(reauthToken, actor);
    const requestId = idempotencyKey ? requestIdOf('admin-designate', accountId, idempotencyKey) : uuidv7(this.d.clock);
    const payload = { action: 'DESIGNATED', designationKind: body.kind, basis: body.basis };
    await this.#audit('ADMIN_ACCOUNT_DESIGNATED', accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      const d = await this.d.identity.designate({ requestId, actedBy: actor.accountId, adminAccountId: accountId, kind: body.kind, basis: body.basis });
      await this.#audit('ADMIN_ACCOUNT_DESIGNATED', accountId, actor, { ...payload, requestId, status: 'SUCCEEDED' });
      return d;
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_DESIGNATED', accountId, actor, { ...payload, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async revokeDesignation(actor: OpsActor, accountId: string, kind: DesignationKind, reauthToken: string | undefined): Promise<void> {
    await this.#reauth(reauthToken, actor);
    const requestId = uuidv7(this.d.clock);
    const payload = { action: 'DESIGNATION_REVOKED', designationKind: kind };
    await this.#audit('ADMIN_ACCOUNT_DESIGNATION_REVOKED', accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      await this.d.identity.revokeDesignation({ requestId, actedBy: actor.accountId, adminAccountId: accountId, kind });
      await this.#audit('ADMIN_ACCOUNT_DESIGNATION_REVOKED', accountId, actor, { ...payload, requestId, status: 'SUCCEEDED' });
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_DESIGNATION_REVOKED', accountId, actor, { ...payload, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async terminateSessions(actor: OpsActor, accountId: string, sessionId: string | undefined): Promise<{ endedCount: number; alreadyDone: boolean }> {
    const requestId = uuidv7(this.d.clock);
    const base = { action: 'SESSIONS_TERMINATED', ...(sessionId ? { sessionId } : {}), requestId };
    await this.#audit('ADMIN_ACCOUNT_SESSIONS_TERMINATED', accountId, actor, { ...base, status: 'REQUESTED' });
    try {
      const r = await this.d.identity.terminateSessions({ requestId, actedBy: actor.accountId, adminAccountId: accountId, ...(sessionId ? { sessionId } : {}) });
      await this.#audit('ADMIN_ACCOUNT_SESSIONS_TERMINATED', accountId, actor, { ...base, endedCount: r.endedCount, status: 'SUCCEEDED' });
      return r;
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_SESSIONS_TERMINATED', accountId, actor, { ...base, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async permissionChanges(accountId: string, cursor: string | undefined, limit: number): Promise<{ items: AdminPermissionChangeView[]; nextCursor: string | null }> {
    if (!this.d.reader?.entriesOfRecord) return { items: [], nextCursor: null };
    const page = await this.d.reader.entriesOfRecord(accountId, { ...(cursor ? { cursor } : {}), limit });
    const items: AdminPermissionChangeView[] = [];
    for (const e of page.entries) {
      const p = e.record.payload as Record<string, unknown>;
      const action = actionOf[String(p.action ?? '')];
      if (!action || p.status !== 'SUCCEEDED') continue;
      items.push({
        changedAt: new Date(e.createdAtMs).toISOString(),
        action,
        ...(typeof p.fromRole === 'string' ? { fromRole: p.fromRole as AdminRole } : {}),
        ...(typeof p.toRole === 'string' ? { toRole: p.toRole as AdminRole } : {}),
        ...(typeof p.designationKind === 'string' ? { designationKind: p.designationKind as DesignationKind } : {}),
        actorAdminAccountId: String(p.actorAdminAccountId ?? ''),
        actorRole: String(p.actorRole ?? 'viewer') as AdminRole,
        ...(typeof p.approvalId === 'string' ? { approvalId: p.approvalId } : {}),
        ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  async mySession(actor: OpsActor): Promise<{ adminAccountId: string; role: AdminRole; displayName: string | null; designations: DesignationKind[] }> {
    const a = await this.get(actor.accountId);
    return { adminAccountId: a.adminAccountId, role: a.role, displayName: a.displayName, designations: a.designations };
  }

  async #reauth(token: string | undefined, actor: OpsActor): Promise<void> {
    if (!this.d.reauth) throw reauthUnavailable();
    try {
      const v = await this.d.reauth.verify(token, { sessionId: actor.sessionId, act: 'PERMISSION_CHANGE' });
      if (v.accountId !== actor.accountId) throw reauthRequired();
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      if (e instanceof ReauthUnavailable) throw reauthUnavailable();
      throw reauthRequired();
    }
  }

  async #audit(recordType: string, recordId: string, actor: OpsActor, payload: Record<string, unknown>): Promise<void> {
    await this.d.audit.append({ recordType, recordId, payload: { ...payload, actorAdminAccountId: actor.accountId, actorRole: actor.role }, nowMs: this.d.clock.now() });
  }

  /** 같은 request_id로 이미 성공한 기록(멱등). 감사 기록 원문에서 찾는다 */
  async #prior(accountId: string, requestId: string): Promise<Record<string, unknown> | null> {
    if (!this.d.reader?.entriesOfRecord) return null;
    const page = await this.d.reader.entriesOfRecord(accountId, { limit: 100 });
    for (const e of page.entries) {
      const p = e.record.payload as Record<string, unknown>;
      if (p.requestId === requestId && p.status === 'SUCCEEDED') return p;
    }
    return null;
  }
}

const typeOf = (e: unknown): string => (e instanceof Error ? e.name : 'Error');
