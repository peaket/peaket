// 관제 관리 계정 REST의 응용 층(openapi /v1/ops/admin-accounts*, BUILD_ORDER BOT-152, ADR-0322).
// 쓰기는 재인증(act=PERMISSION_CHANGE, 패스키)을 먼저 보고, identity 호출 전 REQUESTED · 성공 뒤 SUCCEEDED · 실패 뒤 FAILED를
// 감사 체인에 남긴다. commander 역할의 부여·회수는 COMMANDER_ROLE_CHANGE 승인 업무를 만들고 202로 답한다.
import { createHash } from 'node:crypto';
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { AuditChain, AuditChainReader } from '../../audit/index.js';
import { ReauthUnavailable } from '../../payouts/index.js';
import { type AdminAccountDetail, type AdminAccountView, type AdminPermissionChangeView, type AdminRole, type AdminStatus, type DesignationKind, isPartnerRole, parseIfMatch } from '../domain/admin-account.js';
import type { AdminIdentity, AdminReauth } from '../domain/ports.js';
import { roleChangeApprovalView, type RoleChangeApprovalView } from '../domain/role-change-approval.js';
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

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다', detail: '관리 계정을 찾을 수 없습니다' });
const reauthRequired = () => new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
const reauthUnavailable = () => new ProblemError({ type: 'reauth-unavailable', status: 503, title: '재인증 검증기를 쓸 수 없습니다', retryAfterSeconds: 5 });

/** 멱등 키에서 정해진 request_id(UUID 꼴)를 만든다. 같은 키·작업·대상·본문이면 같은 값이라 identity 멱등 기록이 두 번째를 알아본다 */
export function requestIdOf(operation: string, accountRef: string, idempotencyKey: string, bodyHash: string): string {
  const h = createHash('sha256').update(`BAT-045|${operation}|${accountRef}|${idempotencyKey.toLowerCase()}|${bodyHash}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Idempotency-Key는 필수 UUID v4다(guidelines §4). 없거나 틀리면 400이고 쓰지 않는다 */
export function idempotencyKeyOf(raw: string | undefined): string {
  if (!raw || !IDEMPOTENCY_KEY.test(raw)) throw new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다', detail: 'Idempotency-Key는 UUID v4여야 합니다' });
  return raw.toLowerCase();
}

const stableJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
};

/** 같은 키에 다른 본문이 오면 422다. 본문 칸의 순서에 기대지 않도록 정렬해 SHA-256을 낸다 */
export function bodyHashOf(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

const reasonOf = (raw: string): string => {
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim();
  if (s.length < 1 || [...s].length > 500) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다', detail: '사유는 1~500자입니다' });
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
    // operator는 파트너 계정만 초대한다(authz-matrix §6.1, RV-07). identity를 부르기 전에 거른다
    if (actor.role !== 'commander' && !isPartnerRole(body.role)) {
      throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '이 역할로는 초대할 수 없습니다', detail: '그 역할의 계정을 다룰 수 없습니다' });
    }
    const key = idempotencyKeyOf(idempotencyKey);
    const bodyHash = bodyHashOf({ email: body.email, displayName: body.displayName, role: body.role, ...(body.promoterId ? { promoterId: body.promoterId } : {}) });
    await this.#reauth(reauthToken, actor);
    const requestId = requestIdOf('admin-invite', actor.accountId, key, bodyHash);
    const prior = await this.#prior(actor.accountId, 'admin-invite', key, bodyHash);
    if (typeof prior?.createdAccountId === 'string') {
      const a = await this.d.identity.get(prior.createdAccountId);
      if (a) return a;
    }
    const payload = { action: 'INVITED', role: body.role, ...(body.promoterId ? { promoterId: body.promoterId } : {}), idempotencyKey: key, bodyHash, operation: 'admin-invite' };
    await this.#audit('ADMIN_ACCOUNT_INVITED', actor.accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      const account = await this.d.identity.invite({ requestId, actedBy: actor.accountId, email: body.email, displayName: body.displayName, role: body.role, ...(body.promoterId ? { promoterId: body.promoterId } : {}) });
      await this.#audit('ADMIN_ACCOUNT_INVITED', account.adminAccountId, actor, { ...payload, accountId: account.adminAccountId, createdAccountId: account.adminAccountId, requestId, status: 'SUCCEEDED' });
      // 재전송은 대상 계정 ID를 알아야 하므로 요청자 기록에 성공 표지를 남긴다(권한 변경 내역에는 action이 없어 뜨지 않는다)
      await this.#audit('ADMIN_ACCOUNT_IDEMPOTENT', actor.accountId, actor, { ...payload, createdAccountId: account.adminAccountId, requestId, status: 'SUCCEEDED' });
      return account;
    } catch (e) {
      await this.#audit('ADMIN_ACCOUNT_INVITED', actor.accountId, actor, { ...payload, requestId, status: 'FAILED', error: typeOf(e) });
      throw e;
    }
  }

  async changeRole(actor: OpsActor, accountId: string, body: { role: AdminRole; reason: string }, ifMatch: string | undefined, reauthToken: string | undefined, idempotencyKey: string | undefined): Promise<{ kind: 'changed'; account: AdminAccountView } | { kind: 'approval'; approval: RoleChangeApprovalView }> {
    const target = await this.get(accountId);
    if (target.adminAccountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 계정에는 할 수 없습니다', detail: '자기 역할은 바꿀 수 없습니다' });
    if (isPartnerRole(target.role) !== isPartnerRole(body.role)) throw new ProblemError({ type: 'role-group-mismatch', status: 422, title: '파트너 역할과 관제 역할 사이는 바꿀 수 없습니다' });
    if (actor.role !== 'commander' && (!isPartnerRole(target.role) || !isPartnerRole(body.role))) throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '이 역할로는 초대할 수 없습니다', detail: '그 역할의 계정을 다룰 수 없습니다' });
    const version = parseIfMatch(ifMatch);
    if (version === null) throw new ProblemError({ type: 'precondition-required', status: 428, title: '고칠 판(If-Match)을 보내 주세요' });
    if (version !== target.version) throw new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
    if (target.status === 'REMOVED') throw new ProblemError({ type: 'admin-account-state-conflict', status: 409, title: '지금 계정 상태에서는 할 수 없습니다', detail: '삭제한 계정입니다' });
    const reason = reasonOf(body.reason);
    await this.#reauth(reauthToken, actor);
    const key = idempotencyKey === undefined ? undefined : idempotencyKeyOf(idempotencyKey);
    const bodyHash = bodyHashOf({ role: body.role, reason });
    const requestId = key ? requestIdOf('admin-role', accountId, key, bodyHash) : uuidv7(this.d.clock);
    const commanderChange = target.role === 'commander' || body.role === 'commander';
    if (commanderChange) {
      const prior = key ? await this.#prior(accountId, 'admin-role', key, bodyHash) : null;
      if (typeof prior?.approvalId === 'string') {
        const approval = await this.d.approvals.get(prior.approvalId, actor);
        return { kind: 'approval', approval };
      }
      const r = await this.d.approvals.create({ targetRef: accountId, targetVersion: target.version, fromRole: target.role, requestedRole: body.role, reason, requestedBy: actor.accountId });
      await this.#audit('ADMIN_ACCOUNT_ROLE_CHANGED', accountId, actor, { action: 'ROLE_CHANGED', fromRole: target.role, toRole: body.role, reason, ...(key ? { idempotencyKey: key, bodyHash, operation: 'admin-role' } : {}), requestId, approvalId: r.approvalId, status: 'REQUESTED' });
      return { kind: 'approval', approval: roleChangeApprovalView(r, actor) };
    }
    await this.#audit('ADMIN_ACCOUNT_ROLE_CHANGED', accountId, actor, { action: 'ROLE_CHANGED', fromRole: target.role, toRole: body.role, reason, ...(key ? { idempotencyKey: key, bodyHash, operation: 'admin-role' } : {}), requestId, status: 'REQUESTED' });
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
    if (target.adminAccountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 계정에는 할 수 없습니다', detail: '자기 계정은 재초대할 수 없습니다' });
    if (actor.role !== 'commander' && !isPartnerRole(target.role)) throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '이 역할로는 초대할 수 없습니다', detail: '그 역할의 계정을 다룰 수 없습니다' });
    const reason = reasonOf(body.reason);
    const key = idempotencyKeyOf(idempotencyKey);
    const bodyHash = bodyHashOf({ reasonCode: body.reasonCode, reason });
    await this.#reauth(reauthToken, actor);
    const requestId = requestIdOf('admin-reinvite', accountId, key, bodyHash);
    if (await this.#prior(accountId, 'admin-reinvite', key, bodyHash)) return this.get(accountId);
    const payload = { action: 'REINVITED', reasonCode: body.reasonCode, reason, idempotencyKey: key, bodyHash, operation: 'admin-reinvite' };
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
    if (target.adminAccountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 계정에는 할 수 없습니다', detail: '자기 계정은 지울 수 없습니다' });
    // 이미 지운 계정은 같은 200 계정 뷰다(openapi POST .../removal, RV-05). 삭제된 commander도 이 갈래가 먼저다
    if (target.status === 'REMOVED') return target;
    if (target.role === 'commander') throw new ProblemError({ type: 'commander-removal-needs-role-change', status: 409, title: 'commander 역할을 먼저 바꿔 주세요', detail: 'commander 계정은 먼저 역할을 내려야 합니다' });
    if (actor.role !== 'commander' && !isPartnerRole(target.role)) throw new ProblemError({ type: 'admin-role-not-allowed', status: 403, title: '이 역할로는 초대할 수 없습니다', detail: '그 역할의 계정을 지울 수 없습니다' });
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
    if (accountId === actor.accountId) throw new ProblemError({ type: 'self-target-forbidden', status: 403, title: '자기 계정에는 할 수 없습니다', detail: '자기에게 지정할 수 없습니다' });
    const key = idempotencyKeyOf(idempotencyKey);
    const bodyHash = bodyHashOf({ kind: body.kind, basis: body.basis });
    await this.#reauth(reauthToken, actor);
    const requestId = requestIdOf('admin-designate', accountId, key, bodyHash);
    const prior = await this.#prior(accountId, 'admin-designate', key, bodyHash);
    if (prior) return { kind: body.kind, basis: String(prior.basis ?? body.basis), designatedBy: String(prior.actorAdminAccountId ?? actor.accountId), designatedAt: String(prior.designatedAt ?? new Date(this.d.clock.now()).toISOString()) };
    const payload = { action: 'DESIGNATED', designationKind: body.kind, basis: body.basis, idempotencyKey: key, bodyHash, operation: 'admin-designate' };
    await this.#audit('ADMIN_ACCOUNT_DESIGNATED', accountId, actor, { ...payload, requestId, status: 'REQUESTED' });
    try {
      const d = await this.d.identity.designate({ requestId, actedBy: actor.accountId, adminAccountId: accountId, kind: body.kind, basis: body.basis });
      await this.#audit('ADMIN_ACCOUNT_DESIGNATED', accountId, actor, { ...payload, designatedAt: d.designatedAt, requestId, status: 'SUCCEEDED' });
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

  /** 같은 키·작업으로 이미 성공한 기록(멱등). 본문 해시가 다르면 422 idempotency-key-reused다 */
  async #prior(accountId: string, operation: string, idempotencyKey: string, bodyHash: string): Promise<Record<string, unknown> | null> {
    if (!this.d.reader?.entriesOfRecord) return null;
    const page = await this.d.reader.entriesOfRecord(accountId, { limit: 100 });
    for (const e of page.entries) {
      const p = e.record.payload as Record<string, unknown>;
      if (p.operation !== operation || p.idempotencyKey !== idempotencyKey || p.status !== 'SUCCEEDED') continue;
      if (p.bodyHash !== bodyHash) throw new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다', detail: '같은 Idempotency-Key로 다른 본문을 보냈습니다' });
      return p;
    }
    return null;
  }
}

const typeOf = (e: unknown): string => (e instanceof Error ? e.name : 'Error');
