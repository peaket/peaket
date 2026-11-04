// 관리 계정 저장소의 메모리 구현(시험·로컬, BUILD_ORDER BOT-110·BOT-111). 계정을 만드는 길(초대)은 BOT-150이라 시험은 create로 바로 만든다.
import { FRESH_LOGIN_STATE, type AccountLoginState, type NoticeKind } from '../domain/login-rules.js';
import { randomUUID } from 'node:crypto';
import type { AdminAccountRow, AdminAccountStore, AdminAud, AdminLoginAccount, AdminLoginStore, AdminRefreshRow, AdminRefreshStore, AdminRefreshTx, AdminRole, AdminSecondStepStore, AdminSessionEndReason, AdminSessionRow, AdminSessionStore, AdminStatus, AdminTotpState, AdminUnlockStore, LoginStepRow, PendingNotice, UnlockLinkRow } from '../domain/ports.js';

type Row = AdminAccountRow &
  AccountLoginState & { updatedAt: number; passwordChangeRequired: boolean; secondFactorFailures: number; lastLoginAt: number | null; totpSeedEnc: Buffer | null; totpPendingEnc: Buffer | null; totpLastStep: number | null };
type SessionRow = { id: string; accountId: string; aud: AdminAud; refreshHash: string; prevRefreshHash: string | null; rotatedAt: number | null; refreshUsed: boolean; refreshFamily: string; pairRef: string; createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number; terminatedAt: number | null; terminationReason: string | null };
type Step = { id: string; accountId: string; tokenHash: string; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number; usedAt: number | null; knownSource: boolean; passwordOnlyNoticedAt: number | null };

export class MemoryAdminAccountStore implements AdminAccountStore, AdminLoginStore, AdminSecondStepStore, AdminUnlockStore, AdminSessionStore, AdminRefreshStore {
  readonly #rows = new Map<string, Row>();
  readonly #notices: { id: string; accountId: string; kind: NoticeKind; at: number; sentAt: number | null; attempts?: number; nextAttemptAt?: number }[] = [];
  readonly #links: (UnlockLinkRow & { tokenHash: string })[] = [];
  readonly #known = new Map<string, number>();
  readonly #steps: Step[] = [];
  readonly #recovery: { id: string; accountId: string; phc: string }[] = [];
  readonly #sessions: SessionRow[] = [];
  readonly #terminated: { accountId: string; sessionId: string; reason: string }[] = [];
  /** 발급한 리프레시 토큰 해시(16진수) → 세션·패밀리·절대 만료(BOT-130) */
  readonly #issued = new Map<string, { sessionId: string; refreshFamily: string; expiresAt: number }>();

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
      lastLoginAt: null,
      totpSeedEnc: null,
      totpPendingEnc: null,
      totpLastStep: null,
      ...structuredClone(FRESH_LOGIN_STATE),
    });
  }

  /** 시험용: 삭제 상태로 바꾼다(삭제 경로는 BOT-150) */
  remove(id: string): void {
    const r = this.#rows.get(id);
    if (r) this.#rows.set(id, { ...r, status: 'REMOVED' });
  }

  /** 시험용: 역할을 바로 바꾼다(바꾸는 길은 BOT-150) */
  setRole(id: string, role: AdminRole): void {
    const r = this.#rows.get(id);
    if (r) r.role = role;
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

  allNotices(): { id: string; accountId: string; kind: NoticeKind; at: number; sentAt: number | null }[] {
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
    const state: AccountLoginState = { failedAttempts: r.failedAttempts, passwordFailureTotal: r.passwordFailureTotal, secondFactorFailures: r.secondFactorFailures, lockKind: r.lockKind, lockedUntil: r.lockedUntil, recentLockAt: [...r.recentLockAt], lockReason: r.lockReason, lockedAt: r.lockedAt };
    return { id: r.id, role: r.role, status: r.status, passwordPhc: r.passwordPhc, breachCheckedAt: r.breachCheckedAt, passwordChangeRequired: r.passwordChangeRequired, state };
  }

  async updateLoginState(id: string, now: number, fn: (cur: AccountLoginState) => { next: AccountLoginState; notices: NoticeKind[] } | null): Promise<AccountLoginState | null> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return null;
    const cur = this.#loginView(r).state;
    const d = fn(cur);
    if (!d) return cur;
    Object.assign(r, structuredClone(d.next), { updatedAt: now });
    for (const kind of d.notices) this.#notices.push({ id: randomUUID(), accountId: id, kind, at: now, sentAt: null });
    return structuredClone(d.next);
  }

  async addNotice(id: string, kind: NoticeKind, at: number): Promise<void> {
    this.#notices.push({ id: randomUUID(), accountId: id, kind, at, sentAt: null });
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

  async createLoginStep(i: { id: string; accountId: string; tokenHash: Buffer; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number; knownSource?: boolean }): Promise<void> {
    this.#steps.push({ id: i.id, accountId: i.accountId, tokenHash: i.tokenHash.toString('hex'), aud: i.aud, pairRef: i.pairRef, createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: null, knownSource: i.knownSource === true, passwordOnlyNoticedAt: null });
  }

  async isKnownSource(accountId: string, pairRef: string, since: number): Promise<boolean> {
    const at = this.#known.get(`${accountId}|${pairRef}`);
    return at !== undefined && at >= since;
  }

  async recordLoginSuccess(id: string, at: number): Promise<void> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return;
    Object.assign(r, { failedAttempts: 0, secondFactorFailures: 0, passwordFailureTotal: 0, lastLoginAt: at, updatedAt: at });
  }

  // ── TOTP와 2단계(BOT-120) ──
  /** 시험용: 시드 암호문을 바로 바꾼다(I-T41) */
  setTotpSeedEnc(id: string, blob: Buffer): void {
    const r = this.#rows.get(id);
    if (r) r.totpSeedEnc = Buffer.from(blob);
  }

  /** 시험용: 그 계정의 복구 코드 행 */
  recoveryCodes(id: string): { id: string; phc: string }[] {
    return this.#recovery.filter((c) => c.accountId === id).map((c) => ({ id: c.id, phc: c.phc }));
  }

  /** 시험용: 그 계정의 관리 세션 행 */
  sessions(id: string): SessionRow[] {
    return this.#sessions.filter((s) => s.accountId === id).map((s) => ({ ...s }));
  }

  /** 시험용: 적은 세션 종료 사건 */
  terminatedEvents(): { accountId: string; sessionId: string; reason: string }[] {
    return this.#terminated.map((e) => ({ ...e }));
  }

  async findLoginById(id: string): Promise<(AdminLoginAccount & { email: string; promoterId: string | null }) | null> {
    const r = this.#rows.get(id);
    return r && r.status !== 'REMOVED' ? { ...this.#loginView(r), email: r.email, promoterId: r.promoterId } : null;
  }

  async getTotp(id: string): Promise<AdminTotpState | null> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return null;
    return { email: r.email, seedEnc: r.totpSeedEnc && Buffer.from(r.totpSeedEnc), pendingEnc: r.totpPendingEnc && Buffer.from(r.totpPendingEnc), lastStep: r.totpLastStep };
  }

  async setTotpPending(id: string, enc: Buffer, now: number): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED') return false;
    Object.assign(r, { totpPendingEnc: Buffer.from(enc), updatedAt: now });
    return true;
  }

  async confirmTotp(id: string, i: { seedEnc: Buffer; step: number; recoveryPhcs: string[]; now: number }): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || r.status === 'REMOVED' || !r.totpPendingEnc || !r.totpPendingEnc.equals(i.seedEnc)) return false;
    Object.assign(r, { totpSeedEnc: Buffer.from(i.seedEnc), totpPendingEnc: null, totpLastStep: i.step, updatedAt: i.now });
    for (let k = this.#recovery.length - 1; k >= 0; k--) if (this.#recovery[k]!.accountId === id) this.#recovery.splice(k, 1);
    for (const phc of i.recoveryPhcs) this.#recovery.push({ id: randomUUID(), accountId: id, phc });
    return true;
  }

  async recordTotpStep(id: string, step: number, now: number): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || (r.totpLastStep !== null && r.totpLastStep >= step)) return false;
    Object.assign(r, { totpLastStep: step, updatedAt: now });
    return true;
  }

  async listRecoveryCodes(id: string): Promise<{ id: string; phc: string }[]> {
    return this.recoveryCodes(id);
  }

  async useRecoveryCode(rowId: string): Promise<boolean> {
    const k = this.#recovery.findIndex((c) => c.id === rowId);
    if (k < 0) return false;
    this.#recovery.splice(k, 1);
    return true;
  }

  async findLoginStep(tokenHash: Buffer): Promise<LoginStepRow | null> {
    const h = tokenHash.toString('hex');
    const s = this.#steps.find((x) => x.tokenHash === h);
    return s ? { id: s.id, accountId: s.accountId, aud: s.aud, pairRef: s.pairRef, createdAt: s.createdAt, expiresAt: s.expiresAt, usedAt: s.usedAt } : null;
  }

  async useLoginStep(id: string, at: number): Promise<boolean> {
    const s = this.#steps.find((x) => x.id === id);
    if (!s || s.usedAt !== null || s.passwordOnlyNoticedAt !== null || s.expiresAt <= at) return false;
    s.usedAt = at;
    return true;
  }

  async createSession(
    i: { id: string; accountId: string; aud: AdminAud; refreshHash: Buffer; refreshFamily: string; pairRef: string; createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number },
    limit: number,
  ): Promise<{ evicted: string[] }> {
    const now = i.createdAt;
    const live = this.#sessions.filter((s) => s.accountId === i.accountId && s.terminatedAt === null && s.idleExpiresAt > now && s.absoluteExpiresAt > now).sort((a, b) => a.idleExpiresAt - b.idleExpiresAt);
    const evicted: string[] = [];
    while (live.length >= limit) {
      const s = live.shift()!;
      Object.assign(s, { terminatedAt: now, terminationReason: 'DEVICE_LIMIT' });
      this.#terminated.push({ accountId: s.accountId, sessionId: s.id, reason: 'DEVICE_LIMIT' });
      evicted.push(s.id);
    }
    if (evicted.length > 0) this.#notices.push({ id: randomUUID(), accountId: i.accountId, kind: 'SESSION_LIMIT', at: now, sentAt: null });
    this.#issued.set(i.refreshHash.toString('hex'), { sessionId: i.id, refreshFamily: i.refreshFamily, expiresAt: i.absoluteExpiresAt });
    this.#sessions.push({ id: i.id, accountId: i.accountId, aud: i.aud, refreshHash: i.refreshHash.toString('hex'), prevRefreshHash: null, rotatedAt: null, refreshUsed: false, refreshFamily: i.refreshFamily, pairRef: i.pairRef, createdAt: i.createdAt, absoluteExpiresAt: i.absoluteExpiresAt, idleExpiresAt: i.idleExpiresAt, terminatedAt: null, terminationReason: null });
    return { evicted };
  }

  // ── 본인 해제 링크와 알림 발송(BOT-121) ──
  /** 시험용: 그 계정의 해제 링크 행(토큰 해시는 16진수) */
  unlockLinks(id: string): (UnlockLinkRow & { tokenHash: string })[] {
    return this.#links.filter((l) => l.accountId === id).map((l) => ({ ...l }));
  }

  async createUnlockLink(i: { id: string; accountId: string; tokenHash: Buffer; createdAt: number; expiresAt: number }): Promise<void> {
    for (const l of this.#links) if (l.accountId === i.accountId && l.usedAt === null && l.revokedAt === null) l.revokedAt = i.createdAt;
    this.#links.push({ id: i.id, accountId: i.accountId, tokenHash: i.tokenHash.toString('hex'), codeFailures: 0, createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: null, revokedAt: null });
  }

  async findUnlockLink(tokenHash: Buffer): Promise<UnlockLinkRow | null> {
    const h = tokenHash.toString('hex');
    const l = this.#links.find((x) => x.tokenHash === h);
    if (!l) return null;
    const { tokenHash: _t, ...row } = l;
    return { ...row };
  }

  async failUnlockCode(linkId: string): Promise<number> {
    const l = this.#links.find((x) => x.id === linkId);
    if (!l) return 0;
    l.codeFailures += 1;
    return l.codeFailures;
  }

  async useUnlockLink(linkId: string, accountId: string, now: number, fn: (cur: AccountLoginState) => AccountLoginState | null, notice: NoticeKind): Promise<boolean> {
    const l = this.#links.find((x) => x.id === linkId);
    const r = this.#rows.get(accountId);
    if (!l || !r || l.accountId !== accountId || l.usedAt !== null || l.revokedAt !== null || r.status === 'REMOVED') return false;
    const next = fn(this.#loginView(r).state);
    if (!next) return false;
    l.usedAt = now;
    Object.assign(r, structuredClone(next), { updatedAt: now });
    this.#notices.push({ id: randomUUID(), accountId, kind: notice, at: now, sentAt: null });
    return true;
  }

  async dispatchNotices(limit: number, now: number, handle: (n: PendingNotice) => Promise<'SENT' | 'CLOSE' | 'KEEP'>): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;
    for (const n of this.#notices.filter((x) => x.sentAt === null && (x.nextAttemptAt === undefined || x.nextAttemptAt <= now)).slice(0, limit)) {
      let r: 'SENT' | 'CLOSE' | 'KEEP';
      try {
        r = await handle({ id: n.id, accountId: n.accountId, kind: n.kind, createdAt: n.at });
      } catch {
        r = 'KEEP';
      }
      if (r === 'KEEP') {
        failed++;
        n.attempts = (n.attempts ?? 0) + 1;
        n.nextAttemptAt = now + Math.min(60 * 60_000, 60_000 * 2 ** (n.attempts - 1));
        continue;
      }
      n.sentAt = now;
      done++;
    }
    return { done, failed };
  }

  // ── 비밀번호만 맞은 로그인·세션(BOT-123) ──
  async findSession(sessionId: string): Promise<AdminSessionRow | null> {
    const s = this.#sessions.find((x) => x.id === sessionId);
    return s ? { id: s.id, accountId: s.accountId, aud: s.aud, pairRef: s.pairRef, absoluteExpiresAt: s.absoluteExpiresAt, idleExpiresAt: s.idleExpiresAt, terminatedAt: s.terminatedAt } : null;
  }

  async terminateOtherSessions(accountId: string, keepSessionId: string, reason: 'PASSWORD_CHANGED', now: number): Promise<string[]> {
    const ended: string[] = [];
    for (const s of this.#sessions) {
      if (s.accountId !== accountId || s.id === keepSessionId || s.terminatedAt !== null) continue;
      Object.assign(s, { terminatedAt: now, terminationReason: reason });
      this.#terminated.push({ accountId, sessionId: s.id, reason });
      ended.push(s.id);
    }
    return ended;
  }

  // ── 토큰 갱신과 로그아웃(BOT-130) ──
  /** 갱신 트랜잭션을 차례로 세운다(Drizzle의 세션 행 잠금과 같은 효과). 던지면 그 트랜잭션이 바꾼 세션 칸·발급 해시·사건만 거꾸로 되돌린다(재검토 2026-11-05) */
  #refreshQueue: Promise<unknown> = Promise.resolve();

  async refreshTransaction<T>(fn: (tx: AdminRefreshTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const undo: (() => void)[] = [];
      try {
        return await fn(this.#refreshTx(undo));
      } catch (e) {
        for (const u of undo.reverse()) u();
        throw e;
      }
    };
    const p = this.#refreshQueue.then(run, run);
    this.#refreshQueue = p.catch(() => undefined);
    return p;
  }

  #refreshTx(undo: (() => void)[]): AdminRefreshTx {
    /** 세션 행의 칸을 바꾸고, 되돌릴 때 그 칸만 앞 값으로 */
    const patch = (s: SessionRow, change: Partial<SessionRow>) => {
      const prev = Object.fromEntries(Object.keys(change).map((k) => [k, s[k as keyof SessionRow]])) as Partial<SessionRow>;
      Object.assign(s, change);
      undo.push(() => Object.assign(s, prev));
    };
    return {
      findByRefreshHash: async (hash): Promise<AdminRefreshRow | null> => {
        const h = hash.toString('hex');
        const cur = this.#sessions.find((x) => x.refreshHash === h || x.prevRefreshHash === h);
        const past = cur ? undefined : this.#issued.get(h);
        const s = cur ?? (past ? this.#sessions.find((x) => x.id === past.sessionId) : undefined);
        if (!s) return null;
        const match = cur ? (cur.refreshHash === h ? 'current' : 'previous') : 'history';
        return { id: s.id, accountId: s.accountId, aud: s.aud, refreshFamily: s.refreshFamily, absoluteExpiresAt: s.absoluteExpiresAt, idleExpiresAt: s.idleExpiresAt, terminatedAt: s.terminatedAt, match, rotatedAt: s.rotatedAt, refreshUsed: s.refreshUsed };
      },
      accountOf: async (id) => {
        const r = this.#rows.get(id);
        return r ? { status: r.status, role: r.role, passwordChangeRequired: r.passwordChangeRequired } : null;
      },
      familySessions: async (family) => this.#sessions.filter((x) => x.refreshFamily === family && x.terminatedAt === null).map((x) => x.id),
      terminateSessions: async (ids, reason, now) => {
        for (const id of [...ids].sort()) {
          const s = this.#sessions.find((x) => x.id === id);
          if (!s || s.terminatedAt !== null) continue;
          patch(s, { terminatedAt: now, terminationReason: reason });
          const ev = { accountId: s.accountId, sessionId: s.id, reason };
          this.#terminated.push(ev);
          undo.push(() => this.#terminated.splice(this.#terminated.indexOf(ev), 1));
        }
      },
      rotateRefresh: async (id, hash, now, idleExpiresAt) => {
        const s = this.#sessions.find((x) => x.id === id)!;
        patch(s, { prevRefreshHash: s.refreshHash, refreshHash: hash.toString('hex'), rotatedAt: now, refreshUsed: false, idleExpiresAt });
      },
      setRefreshHash: async (id, hash) => {
        patch(this.#sessions.find((x) => x.id === id)!, { refreshHash: hash.toString('hex') });
      },
      recordRefreshHash: async (r) => {
        const h = r.hash.toString('hex');
        const had = this.#issued.get(h);
        this.#issued.set(h, { sessionId: r.sessionId, refreshFamily: r.refreshFamily, expiresAt: r.expiresAt });
        undo.push(() => (had ? this.#issued.set(h, had) : this.#issued.delete(h)));
      },
    };
  }

  async endSession(accountId: string, sessionId: string, reason: 'LOGOUT', now: number): Promise<boolean> {
    const s = this.#sessions.find((x) => x.id === sessionId && x.accountId === accountId && x.terminatedAt === null);
    if (!s) return false;
    this.#end([s.id], reason, now);
    return true;
  }

  async purgeRefreshHashes(before: number): Promise<number> {
    let n = 0;
    for (const [h, v] of this.#issued) if (v.expiresAt < before) (this.#issued.delete(h), n++);
    return n;
  }

  #end(ids: string[], reason: AdminSessionEndReason, now: number): void {
    for (const id of [...ids].sort()) {
      const s = this.#sessions.find((x) => x.id === id);
      if (!s || s.terminatedAt !== null) continue;
      Object.assign(s, { terminatedAt: now, terminationReason: reason });
      this.#terminated.push({ accountId: s.accountId, sessionId: s.id, reason });
    }
  }

  async touchKnownSource(accountId: string, pairRef: string, at: number): Promise<void> {
    this.#known.set(`${accountId}|${pairRef}`, at);
  }

  async purgeKnownSources(before: number): Promise<number> {
    let n = 0;
    for (const [k, at] of this.#known) if (at < before) (this.#known.delete(k), n++);
    return n;
  }

  async findPasswordOnlySteps(createdBefore: number, limit: number): Promise<{ id: string; accountId: string }[]> {
    return this.#steps
      .filter((s) => s.createdAt <= createdBefore && s.usedAt === null && !s.knownSource && s.passwordOnlyNoticedAt === null)
      .slice(0, limit)
      .map((s) => ({ id: s.id, accountId: s.accountId }));
  }

  async markPasswordOnly(stepId: string, accountId: string, now: number): Promise<boolean> {
    const s = this.#steps.find((x) => x.id === stepId);
    const r = this.#rows.get(accountId);
    if (!s || s.passwordOnlyNoticedAt !== null || s.usedAt !== null) return false;
    s.passwordOnlyNoticedAt = now;
    // 지운 계정은 본 것으로만 적고 알리지 않는다(Drizzle 저장소와 같다)
    if (!r || r.status === 'REMOVED') return false;
    // 그 단계 뒤에 같은 묶음에서 2단계까지 끝냈으면 알리지 않는다(Drizzle 저장소와 같다)
    const later = this.#known.get(`${accountId}|${s.pairRef}`);
    if (later !== undefined && later >= s.createdAt) return false;
    r.passwordChangeRequired = true;
    this.#notices.push({ id: randomUUID(), accountId, kind: 'PASSWORD_ONLY_LOGIN', at: now, sentAt: null });
    return true;
  }
}
