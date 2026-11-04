// 관리 계정 저장소의 메모리 구현(시험·로컬, BUILD_ORDER BOT-110·BOT-111). 계정을 만드는 길(초대)은 BOT-150이라 시험은 create로 바로 만든다.
import { FRESH_LOGIN_STATE, type AccountLoginState, type NoticeKind } from '../domain/login-rules.js';
import type { AdminAccountRow, AdminAccountStore, AdminAud, AdminLoginAccount, AdminLoginStore, AdminRole, AdminStatus } from '../domain/ports.js';

type Row = AdminAccountRow & AccountLoginState & { updatedAt: number; passwordChangeRequired: boolean; secondFactorFailures: number; lastLoginAt: number | null };
type Step = { id: string; accountId: string; tokenHash: string; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number; usedAt: number | null };

export class MemoryAdminAccountStore implements AdminAccountStore, AdminLoginStore {
  readonly #rows = new Map<string, Row>();
  readonly #notices: { accountId: string; kind: NoticeKind; at: number }[] = [];
  readonly #steps: Step[] = [];

  /** 시험용: 계정을 만든다(이메일은 소문자·앞뒤 빈칸 제거, 삭제하지 않은 계정 사이에서 하나) */
  create(i: { id: string; role: AdminRole; email: string; status?: AdminStatus; promoterId?: string | null; displayName?: string | null; now: number }): void {
    const email = i.email.trim().toLowerCase();
    if ([...this.#rows.values()].some((r) => r.status !== 'REMOVED' && r.email === email)) throw new Error('같은 업무 이메일의 계정이 있다');
    this.#rows.set(i.id, {
      id: i.id,
      role: i.role,
      promoterId: i.promoterId ?? null,
      status: i.status ?? 'INVITED',
      email,
      displayName: i.displayName ?? null,
      passwordPhc: null,
      breachCheckedAt: null,
      updatedAt: i.now,
      passwordChangeRequired: false,
      secondFactorFailures: 0,
      lastLoginAt: null,
      ...structuredClone(FRESH_LOGIN_STATE),
    });
  }

  /** 시험용: 삭제 상태로 바꾼다(삭제 경로는 BOT-150) */
  remove(id: string): void {
    const r = this.#rows.get(id);
    if (r) this.#rows.set(id, { ...r, status: 'REMOVED' });
  }

  /** 시험용: 비밀번호 바꾸기 필요 표시를 바로 켜거나 끈다(켜는 길은 BOT-121) */
  setPasswordChangeRequired(id: string, v: boolean): void {
    const r = this.#rows.get(id);
    if (r) r.passwordChangeRequired = v;
  }

  /** 시험용: 한 행을 그대로 본다 */
  peek(id: string): Row | undefined {
    const r = this.#rows.get(id);
    return r && structuredClone(r);
  }

  /** 시험용: 그 계정에 적은 알림 종류(적은 차례) */
  notices(id: string): NoticeKind[] {
    return this.#notices.filter((n) => n.accountId === id).map((n) => n.kind);
  }

  allNotices(): { accountId: string; kind: NoticeKind; at: number }[] {
    return this.#notices.map((n) => ({ ...n }));
  }

  /** 시험용: 그 계정의 로그인 단계 행(토큰 해시는 16진수) */
  loginSteps(id: string): Step[] {
    return this.#steps.filter((s) => s.accountId === id).map((s) => ({ ...s }));
  }

  async get(id: string): Promise<AdminAccountRow | null> {
    const r = this.#rows.get(id);
    if (!r) return null;
    return { id: r.id, role: r.role, promoterId: r.promoterId, status: r.status, email: r.email, displayName: r.displayName, passwordPhc: r.passwordPhc, breachCheckedAt: r.breachCheckedAt };
  }

  async setPassword(i: { id: string; phc: string; breachCheckedAt: number; now: number }): Promise<boolean> {
    const r = this.#rows.get(i.id);
    if (!r || r.status === 'REMOVED') return false;
    this.#rows.set(i.id, { ...r, passwordPhc: i.phc, breachCheckedAt: i.breachCheckedAt, passwordChangeRequired: false, updatedAt: i.now });
    return true;
  }

  async findForLogin(email: string): Promise<AdminLoginAccount | null> {
    const e = email.trim().toLowerCase();
    const r = [...this.#rows.values()].find((x) => x.status !== 'REMOVED' && x.email === e);
    return r ? this.#loginView(r) : null;
  }

  #loginView(r: Row): AdminLoginAccount {
    const state: AccountLoginState = { failedAttempts: r.failedAttempts, passwordFailureTotal: r.passwordFailureTotal, lockKind: r.lockKind, lockedUntil: r.lockedUntil, recentLockAt: [...r.recentLockAt], lockReason: r.lockReason, lockedAt: r.lockedAt };
    return { id: r.id, role: r.role, status: r.status, passwordPhc: r.passwordPhc, breachCheckedAt: r.breachCheckedAt, passwordChangeRequired: r.passwordChangeRequired, state };
  }

  async updateLoginState(id: string, now: number, fn: (cur: AccountLoginState) => { next: AccountLoginState; notices: NoticeKind[] } | null): Promise<AccountLoginState | null> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return null;
    const cur = this.#loginView(r).state;
    const d = fn(cur);
    if (!d) return cur;
    Object.assign(r, structuredClone(d.next), { updatedAt: now });
    for (const kind of d.notices) this.#notices.push({ accountId: id, kind, at: now });
    return structuredClone(d.next);
  }

  async addNotice(id: string, kind: NoticeKind, at: number): Promise<void> {
    this.#notices.push({ accountId: id, kind, at });
  }

  async rehash(id: string, phc: string, now: number): Promise<void> {
    const r = this.#rows.get(id);
    if (r && r.status !== 'REMOVED') Object.assign(r, { passwordPhc: phc, updatedAt: now });
  }

  async markBreachChecked(id: string, at: number, breached: boolean): Promise<void> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return;
    r.breachCheckedAt = at;
    if (breached) r.passwordChangeRequired = true;
    r.updatedAt = at;
  }

  async createLoginStep(i: { id: string; accountId: string; tokenHash: Buffer; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number }): Promise<void> {
    this.#steps.push({ id: i.id, accountId: i.accountId, tokenHash: i.tokenHash.toString('hex'), aud: i.aud, pairRef: i.pairRef, createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: null });
  }

  async recordLoginSuccess(id: string, at: number): Promise<void> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return;
    Object.assign(r, { failedAttempts: 0, secondFactorFailures: 0, passwordFailureTotal: 0, lastLoginAt: at, updatedAt: at });
  }
}
