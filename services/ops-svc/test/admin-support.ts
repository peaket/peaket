// BAT-045 시험 공용 도우미: 관리 계정 identity 대역과 실제 재인증 확인기(JwksApprovalVerifier)에 물릴 ES256 키·토큰.
// 제품 확인기를 그대로 쓰므로 factors(passkey)·act·aud·sid·jti 1회용·확인기 장애(503)를 대역이 아니라 제품 코드로 본다.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { ReauthJtiStore } from '@peaket/platform';
import type { AdminAccountDetail, AdminAccountView, AdminDesignationView, AdminGroup, AdminIdentity, AdminRole, AdminStatus, DesignationKind } from '../src/modules/admin-accounts/index.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { JwksApprovalVerifier } from '../src/modules/payouts/index.js';

export const ISSUER = 'https://identity.peaket.example';

export interface AdminKeys {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): string;
}

/** ES256 시험 키 하나. 공개 JWK는 identity JWKS 대역이 그대로 쓴다 */
export function adminKeys(kid = 'bat045-admin-1'): AdminKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'ES256', use: 'sig' };
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  return {
    kid,
    privateKey,
    jwk,
    sign(claims, header = {}) {
      const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid, ...header });
      const body = b64({ iss: ISSUER, ...claims });
      const data = `${head}.${body}`;
      const sig = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return `${data}.${sig}`;
    },
  };
}

/** jti 1회용 대역(운영은 Redis). failNext면 저장소 장애를 흉내 낸다 */
export class MemoryJti implements ReauthJtiStore {
  readonly seen = new Map<string, number>();
  failNext = false;
  async claim(jti: string, expiresAt: number, now: number): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('jti store down');
    }
    const prev = this.seen.get(jti);
    if (prev !== undefined && prev > now) return false;
    this.seen.set(jti, expiresAt);
    return true;
  }
}

export interface ReauthKit {
  readonly verifier: JwksApprovalVerifier;
  readonly keys: AdminKeys;
  readonly jti: MemoryJti;
  /** 재인증 토큰 하나. 기본은 패스키까지 거친 유효 토큰이다 */
  token(o: { accountId: string; sessionId: string; act?: 'APPROVAL' | 'OPS_COMMAND' | 'PERMISSION_CHANGE'; factors?: readonly string[]; jti?: string; exp?: number; aud?: string; typ?: string; kid?: string }): string;
}

export function reauthKit(clockMs: () => number): ReauthKit {
  const keys = adminKeys();
  const jti = new MemoryJti();
  const issuer = keys;
  const verifier = new JwksApprovalVerifier({
    jwksUrl: `${ISSUER}/internal/jwks/admin.json`,
    issuer: ISSUER,
    clock: { now: clockMs, monotonicMs: () => clockMs() },
    jti,
    fetch: async () => new Response(JSON.stringify({ keys: [keys.jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  let n = 0;
  return {
    verifier,
    keys,
    jti,
    token(o) {
      const now = Math.floor(clockMs() / 1000);
      return issuer.sign(
        {
          aud: o.aud ?? 'ops',
          sub: o.accountId,
          sid: o.sessionId,
          act: o.act ?? 'PERMISSION_CHANGE',
          jti: o.jti ?? `jti-${++n}`,
          iat: now,
          exp: o.exp ?? now + 300,
          factors: o.factors ?? ['password', 'totp', 'passkey'],
        },
        { ...(o.typ ? { typ: o.typ } : {}), ...(o.kid ? { kid: o.kid } : {}) },
      );
    },
  };
}

/** 시험이 읽는 관리 계정 한 건(제품 AdminAccountDetail과 같은 칸) */
export interface FakeAccount extends AdminAccountDetail {
  role: AdminRole;
  status: AdminStatus;
  version: number;
}

const clone = (a: FakeAccount): FakeAccount => ({ ...a, designations: [...a.designations], sessions: a.sessions.map((s) => ({ ...s })) });

/**
 * identity-svc 관리 계정 gRPC 대역. 제품 ops-svc가 부르는 경계만 흉내 낸다.
 * actorRoles에 적힌 계정이 부르면 identity가 하는 역할 거절(운영자·CS 초대)만 invite에서 재현한다.
 * 그 밖의 쓰기는 ops-svc가 먼저 거르는지 보려고 일부러 통과시킨다(틀린 구현 M9가 숨지 않게).
 */
export class FakeAdminIdentity implements AdminIdentity {
  readonly calls: string[] = [];
  readonly accounts = new Map<string, FakeAccount>();
  readonly actorRoles = new Map<string, AdminRole>();
  fail: { method: keyof AdminIdentity; problem: AdminAccountProblem } | undefined;
  #seq = 0;

  seed(o: Partial<FakeAccount> & { adminAccountId: string; role: AdminRole }): FakeAccount {
    const a: FakeAccount = {
      adminAccountId: o.adminAccountId,
      emailMasked: o.emailMasked ?? 'ad***@peaket.example',
      displayName: o.displayName ?? '담당자',
      group: o.group ?? ((o.role === 'partner_admin' || o.role === 'partner_member') ? 'PARTNER' : 'OPS'),
      role: o.role,
      status: o.status ?? 'ACTIVE',
      lockKind: o.lockKind ?? 'NONE',
      totpEnrolled: o.totpEnrolled ?? true,
      passkeyCount: o.passkeyCount ?? 1,
      designations: o.designations ?? [],
      version: o.version ?? 1,
      ...(o.promoterId ? { promoterId: o.promoterId } : {}),
      sessions: o.sessions ?? [{ sessionId: 'sess-1', browser: 'Chrome', os: 'Windows', createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: '2026-11-02T00:00:00.000Z' }],
    };
    this.accounts.set(a.adminAccountId, a);
    return clone(a);
  }

  actor(id: string, role: AdminRole): void {
    this.actorRoles.set(id, role);
  }

  #throwIf(method: keyof AdminIdentity): void {
    if (this.fail?.method === method) {
      const p = this.fail.problem;
      this.fail = undefined;
      throw p;
    }
  }

  async list(q: { group: AdminGroup; promoterId?: string; status?: AdminStatus; cursor?: string; limit: number }): Promise<{ items: AdminAccountView[]; nextCursor: string | null }> {
    this.calls.push(`list:${q.group}`);
    this.#throwIf('list');
    const rows = [...this.accounts.values()]
      .filter((a) => a.group === q.group)
      .filter((a) => (q.status === undefined ? true : a.status === q.status))
      .filter((a) => (q.promoterId === undefined ? true : a.promoterId === q.promoterId))
      .sort((a, b) => a.adminAccountId.localeCompare(b.adminAccountId));
    const after = q.cursor === undefined ? rows : rows.filter((a) => a.adminAccountId > q.cursor!);
    const page = after.slice(0, q.limit);
    return { items: page.map((a) => this.#view(a)), nextCursor: after.length > q.limit ? page[page.length - 1]!.adminAccountId : null };
  }

  async get(id: string): Promise<AdminAccountDetail | null> {
    this.calls.push(`get:${id}`);
    this.#throwIf('get');
    const a = this.accounts.get(id);
    return a ? clone(a) : null;
  }

  async invite(i: { requestId: string; actedBy: string; email: string; displayName: string; role: AdminRole; promoterId?: string }): Promise<AdminAccountView> {
    this.calls.push(`invite:${i.role}`);
    this.#throwIf('invite');
    const actorRole = this.actorRoles.get(i.actedBy);
    if (actorRole === 'operator' && (i.role === 'viewer' || i.role === 'operator' || i.role === 'commander' || i.role === 'cs_agent' || i.role === 'cs_lead')) {
      throw new AdminAccountProblem('admin-role-not-allowed', 403, '그 역할의 계정을 다룰 수 없습니다');
    }
    const id = `0194b045-0000-7000-8000-${String(++this.#seq).padStart(12, '0')}`;
    const local = i.email.split('@')[0] ?? '';
    const a = this.seed({ adminAccountId: id, role: i.role, displayName: i.displayName, emailMasked: `${local.slice(0, 2)}***@${i.email.split('@')[1] ?? 'peaket.example'}`, status: 'INVITED', ...(i.promoterId ? { promoterId: i.promoterId } : {}) });
    return this.#view(a);
  }

  async changeRole(i: { requestId: string; actedBy: string; adminAccountId: string; role: AdminRole; expectedVersion: number; approvalId?: string }): Promise<AdminAccountView> {
    this.calls.push(`changeRole:${i.adminAccountId}:${i.role}${i.approvalId ? `:${i.approvalId}` : ''}`);
    this.#throwIf('changeRole');
    const a = this.accounts.get(i.adminAccountId);
    if (!a) throw new AdminAccountProblem('not-found', 404, '관리 계정을 찾을 수 없습니다');
    if (a.version !== i.expectedVersion) throw new AdminAccountProblem('precondition-failed', 412, '다른 사람이 먼저 바꿨습니다');
    a.role = i.role;
    a.group = i.role === 'partner_admin' || i.role === 'partner_member' ? 'PARTNER' : 'OPS';
    a.version += 1;
    return this.#view(a);
  }

  async reinvite(i: { requestId: string; actedBy: string; adminAccountId: string; reason: 'RESEND' | 'PROTECT_LOCK' | 'CREDENTIAL_LOST' }): Promise<AdminAccountView> {
    this.calls.push(`reinvite:${i.adminAccountId}:${i.reason}`);
    this.#throwIf('reinvite');
    const a = this.accounts.get(i.adminAccountId);
    if (!a) throw new AdminAccountProblem('not-found', 404, '관리 계정을 찾을 수 없습니다');
    a.status = 'INVITED';
    a.version += 1;
    return this.#view(a);
  }

  async remove(i: { requestId: string; actedBy: string; adminAccountId: string }): Promise<AdminAccountView | null> {
    this.calls.push(`remove:${i.adminAccountId}`);
    this.#throwIf('remove');
    const a = this.accounts.get(i.adminAccountId);
    if (!a) throw new AdminAccountProblem('not-found', 404, '관리 계정을 찾을 수 없습니다');
    a.status = 'REMOVED';
    a.emailMasked = '';
    a.displayName = null;
    a.version += 1;
    return this.#view(a);
  }

  async designate(i: { requestId: string; actedBy: string; adminAccountId: string; kind: DesignationKind; basis: string }): Promise<AdminDesignationView> {
    this.calls.push(`designate:${i.adminAccountId}:${i.kind}`);
    this.#throwIf('designate');
    const a = this.accounts.get(i.adminAccountId);
    if (!a) throw new AdminAccountProblem('not-found', 404, '관리 계정을 찾을 수 없습니다');
    const eligible = i.kind === 'FRAUD_INVESTIGATOR' ? a.role === 'commander' || a.role === 'cs_lead' : a.role === 'commander';
    if (!eligible) throw new AdminAccountProblem('designation-target-not-commander', 422, '지정 대상이 될 수 없습니다');
    if (!a.designations.includes(i.kind)) a.designations.push(i.kind);
    return { kind: i.kind, basis: i.basis, designatedBy: i.actedBy, designatedAt: '2026-11-20T00:00:00.000Z' };
  }

  async revokeDesignation(i: { requestId: string; actedBy: string; adminAccountId: string; kind: DesignationKind }): Promise<void> {
    this.calls.push(`revokeDesignation:${i.adminAccountId}:${i.kind}`);
    this.#throwIf('revokeDesignation');
    const a = this.accounts.get(i.adminAccountId);
    if (!a) throw new AdminAccountProblem('not-found', 404, '관리 계정을 찾을 수 없습니다');
    a.designations = a.designations.filter((k) => k !== i.kind);
  }

  async terminateSessions(i: { requestId: string; actedBy: string; adminAccountId: string; sessionId?: string }): Promise<{ endedCount: number; alreadyDone: boolean }> {
    this.calls.push(`terminateSessions:${i.adminAccountId}${i.sessionId ? `:${i.sessionId}` : ''}`);
    this.#throwIf('terminateSessions');
    const a = this.accounts.get(i.adminAccountId);
    if (!a) throw new AdminAccountProblem('not-found', 404, '관리 계정을 찾을 수 없습니다');
    return { endedCount: i.sessionId ? 1 : a.sessions.length, alreadyDone: false };
  }

  async designations(adminAccountId: string): Promise<DesignationKind[]> {
    this.calls.push(`designations:${adminAccountId}`);
    return [...(this.accounts.get(adminAccountId)?.designations ?? [])];
  }

  callsOf(method: string): number {
    return this.calls.filter((c) => c.startsWith(`${method}:`)).length;
  }

  #view(a: FakeAccount): AdminAccountView {
    const { sessions: _sessions, ...view } = clone(a);
    return view;
  }
}
