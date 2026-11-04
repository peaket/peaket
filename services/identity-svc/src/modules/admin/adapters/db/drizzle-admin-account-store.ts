// 관리 계정 저장소의 PostgreSQL 구현(docs/data.md admin_account·admin_login_step·admin_security_notice, BUILD_ORDER BOT-110·BOT-111).
// 로그인 실패 셈은 행을 잠근 트랜잭션에서 고치고 알림 행을 같은 트랜잭션에 적는다(auth-controls §3.1).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, CONTROL_TOPICS, DATABASE, type Database, writeOutbox } from '@peaket/platform';
import { and, asc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import type { AccountLoginState, LockKind, LockReason, NoticeKind } from '../../domain/login-rules.js';
import type { AdminAccountRow, AdminAccountStore, AdminAud, AdminLoginAccount, AdminLoginStore, AdminRole, AdminSecondStepStore, AdminStatus, AdminTotpState, LoginStepRow } from '../../domain/ports.js';
import { adminAccount, adminLoginStep, adminRecoveryCode, adminSecurityNotice, adminSession } from './schema.js';

type AccountRow = typeof adminAccount.$inferSelect;
const ms = (d: Date | null) => (d ? d.getTime() : null);

function stateOf(r: AccountRow): AccountLoginState {
  return {
    failedAttempts: r.failedAttempts,
    passwordFailureTotal: r.passwordFailureTotal,
    lockKind: r.lockKind as LockKind,
    lockedUntil: ms(r.lockedUntil),
    recentLockAt: (r.recentLockAt ?? []).map((t) => Date.parse(t)).filter((t) => Number.isFinite(t)),
    lockReason: (r.lockReason as LockReason | null) ?? null,
    lockedAt: ms(r.lockedAt),
  };
}

function stateColumns(s: AccountLoginState) {
  return {
    failedAttempts: s.failedAttempts,
    passwordFailureTotal: s.passwordFailureTotal,
    lockKind: s.lockKind,
    lockedUntil: s.lockedUntil === null ? null : new Date(s.lockedUntil),
    recentLockAt: s.recentLockAt.map((t) => new Date(t).toISOString()),
    lockReason: s.lockReason,
    lockedAt: s.lockedAt === null ? null : new Date(s.lockedAt),
  };
}

@Injectable()
export class DrizzleAdminAccountStore implements AdminAccountStore, AdminLoginStore, AdminSecondStepStore {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    /** Outbox 행 ID(UUIDv7)의 시계 */
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 시험용: 계정을 바로 만든다(초대는 BOT-150) */
  async create(i: { id: string; role: AdminRole; email: string; status?: AdminStatus; promoterId?: string | null; displayName?: string | null; now: number }): Promise<void> {
    await this.database.db.insert(adminAccount).values({
      id: i.id,
      role: i.role,
      promoterId: i.promoterId ?? null,
      status: i.status ?? 'INVITED',
      email: i.email.trim().toLowerCase(),
      displayName: i.displayName ?? null,
      createdAt: new Date(i.now),
      updatedAt: new Date(i.now),
    });
  }

  async get(id: string): Promise<AdminAccountRow | null> {
    const [r] = await this.database.db.select().from(adminAccount).where(eq(adminAccount.id, id));
    if (!r) return null;
    return {
      id: r.id,
      role: r.role as AdminRole,
      promoterId: r.promoterId,
      status: r.status as AdminStatus,
      email: r.email ?? '',
      displayName: r.displayName,
      passwordPhc: r.passwordPhc,
      breachCheckedAt: r.breachCheckedAt ? r.breachCheckedAt.getTime() : null,
    };
  }

  async setPassword(i: { id: string; phc: string; breachCheckedAt: number; now: number }): Promise<boolean> {
    const done = await this.database.db
      .update(adminAccount)
      .set({ passwordPhc: i.phc, breachCheckedAt: new Date(i.breachCheckedAt), passwordChangeRequired: false, updatedAt: new Date(i.now) })
      .where(and(eq(adminAccount.id, i.id), ne(adminAccount.status, 'REMOVED')))
      .returning({ id: adminAccount.id });
    return done.length > 0;
  }

  async findForLogin(email: string): Promise<AdminLoginAccount | null> {
    const [r] = await this.database.db
      .select()
      .from(adminAccount)
      .where(and(eq(adminAccount.email, email.trim().toLowerCase()), ne(adminAccount.status, 'REMOVED')));
    if (!r) return null;
    return { id: r.id, role: r.role as AdminRole, status: r.status as AdminStatus, passwordPhc: r.passwordPhc, breachCheckedAt: ms(r.breachCheckedAt), passwordChangeRequired: r.passwordChangeRequired, state: stateOf(r) };
  }

  async updateLoginState(id: string, now: number, fn: (cur: AccountLoginState) => { next: AccountLoginState; notices: NoticeKind[] } | null): Promise<AccountLoginState | null> {
    return this.database.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(adminAccount)
        .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')))
        .for('update');
      if (!r) return null;
      const cur = stateOf(r);
      const d = fn(cur);
      if (!d) return cur;
      await tx
        .update(adminAccount)
        .set({ ...stateColumns(d.next), updatedAt: new Date(now) })
        .where(eq(adminAccount.id, id));
      if (d.notices.length > 0) await tx.insert(adminSecurityNotice).values(d.notices.map((kind) => ({ id: randomUUID(), adminAccountId: id, kind, createdAt: new Date(now) })));
      return d.next;
    });
  }

  async addNotice(id: string, kind: NoticeKind, at: number): Promise<void> {
    await this.database.db.insert(adminSecurityNotice).values({ id: randomUUID(), adminAccountId: id, kind, createdAt: new Date(at) });
  }

  async rehash(id: string, phc: string, now: number): Promise<void> {
    await this.database.db
      .update(adminAccount)
      .set({ passwordPhc: phc, updatedAt: new Date(now) })
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
  }

  async markBreachChecked(id: string, at: number, breached: boolean): Promise<void> {
    await this.database.db
      .update(adminAccount)
      .set({ breachCheckedAt: new Date(at), updatedAt: new Date(at), ...(breached ? { passwordChangeRequired: true } : {}) })
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
  }

  async createLoginStep(i: { id: string; accountId: string; tokenHash: Buffer; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number }): Promise<void> {
    await this.database.db.insert(adminLoginStep).values({ id: i.id, adminAccountId: i.accountId, tokenHash: i.tokenHash, aud: i.aud, pairRef: i.pairRef, createdAt: new Date(i.createdAt), expiresAt: new Date(i.expiresAt) });
  }

  async recordLoginSuccess(id: string, at: number): Promise<void> {
    await this.database.db
      .update(adminAccount)
      .set({ failedAttempts: 0, secondFactorFailures: 0, passwordFailureTotal: 0, lastLoginAt: new Date(at), updatedAt: new Date(at) })
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
  }

  // ── TOTP와 2단계(BOT-120) ──
  async findLoginById(id: string): Promise<(AdminLoginAccount & { email: string }) | null> {
    const [r] = await this.database.db
      .select()
      .from(adminAccount)
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
    if (!r) return null;
    return { id: r.id, role: r.role as AdminRole, status: r.status as AdminStatus, passwordPhc: r.passwordPhc, breachCheckedAt: ms(r.breachCheckedAt), passwordChangeRequired: r.passwordChangeRequired, state: stateOf(r), email: r.email ?? '' };
  }

  async getTotp(id: string): Promise<AdminTotpState | null> {
    const [r] = await this.database.db
      .select({ email: adminAccount.email, seedEnc: adminAccount.totpSeedEnc, pendingEnc: adminAccount.totpPendingEnc, lastStep: adminAccount.totpLastStep })
      .from(adminAccount)
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
    return r ? { email: r.email ?? '', seedEnc: r.seedEnc, pendingEnc: r.pendingEnc, lastStep: r.lastStep } : null;
  }

  async setTotpPending(id: string, enc: Buffer, now: number): Promise<boolean> {
    const done = await this.database.db
      .update(adminAccount)
      .set({ totpPendingEnc: enc, updatedAt: new Date(now) })
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')))
      .returning({ id: adminAccount.id });
    return done.length > 0;
  }

  async confirmTotp(id: string, i: { seedEnc: Buffer; step: number; recoveryPhcs: string[]; now: number }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [r] = await tx
        .select({ pending: adminAccount.totpPendingEnc })
        .from(adminAccount)
        .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')))
        .for('update');
      if (!r?.pending || !Buffer.from(r.pending).equals(i.seedEnc)) return false;
      await tx
        .update(adminAccount)
        .set({ totpSeedEnc: i.seedEnc, totpPendingEnc: null, totpLastStep: i.step, updatedAt: new Date(i.now) })
        .where(eq(adminAccount.id, id));
      await tx.delete(adminRecoveryCode).where(eq(adminRecoveryCode.adminAccountId, id));
      if (i.recoveryPhcs.length > 0) await tx.insert(adminRecoveryCode).values(i.recoveryPhcs.map((codePhc) => ({ id: randomUUID(), adminAccountId: id, codePhc, createdAt: new Date(i.now) })));
      return true;
    });
  }

  async recordTotpStep(id: string, step: number, now: number): Promise<boolean> {
    const done = await this.database.db
      .update(adminAccount)
      .set({ totpLastStep: step, updatedAt: new Date(now) })
      .where(and(eq(adminAccount.id, id), or(isNull(adminAccount.totpLastStep), lt(adminAccount.totpLastStep, step))))
      .returning({ id: adminAccount.id });
    return done.length > 0;
  }

  async listRecoveryCodes(id: string): Promise<{ id: string; phc: string }[]> {
    return this.database.db.select({ id: adminRecoveryCode.id, phc: adminRecoveryCode.codePhc }).from(adminRecoveryCode).where(eq(adminRecoveryCode.adminAccountId, id));
  }

  async useRecoveryCode(rowId: string): Promise<boolean> {
    const done = await this.database.db.delete(adminRecoveryCode).where(eq(adminRecoveryCode.id, rowId)).returning({ id: adminRecoveryCode.id });
    return done.length > 0;
  }

  async findLoginStep(tokenHash: Buffer): Promise<LoginStepRow | null> {
    const [r] = await this.database.db.select().from(adminLoginStep).where(eq(adminLoginStep.tokenHash, tokenHash));
    return r ? { id: r.id, accountId: r.adminAccountId, aud: r.aud as AdminAud, pairRef: r.pairRef, createdAt: r.createdAt.getTime(), expiresAt: r.expiresAt.getTime(), usedAt: ms(r.usedAt) } : null;
  }

  async useLoginStep(id: string, at: number): Promise<boolean> {
    const done = await this.database.db
      .update(adminLoginStep)
      .set({ usedAt: new Date(at) })
      .where(and(eq(adminLoginStep.id, id), isNull(adminLoginStep.usedAt)))
      .returning({ id: adminLoginStep.id });
    return done.length > 0;
  }

  async createSession(
    i: { id: string; accountId: string; aud: AdminAud; refreshHash: Buffer; refreshFamily: string; pairRef: string; createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number },
    limit: number,
  ): Promise<{ evicted: string[] }> {
    return this.database.transaction(async (tx) => {
      // 계정 행을 잠가 같은 계정의 세션 만들기를 차례로 한다(동시 로그인이 한도를 넘지 않게)
      await tx.select({ id: adminAccount.id }).from(adminAccount).where(eq(adminAccount.id, i.accountId)).for('update');
      const now = new Date(i.createdAt);
      const live = await tx
        .select({ id: adminSession.id })
        .from(adminSession)
        .where(and(eq(adminSession.adminAccountId, i.accountId), isNull(adminSession.terminatedAt), gt(adminSession.idleExpiresAt, now), gt(adminSession.absoluteExpiresAt, now)))
        .orderBy(asc(adminSession.idleExpiresAt));
      const evicted = live.slice(0, Math.max(0, live.length - limit + 1)).map((r) => r.id);
      for (const sid of evicted) {
        await tx.update(adminSession).set({ terminatedAt: now, terminationReason: 'DEVICE_LIMIT' }).where(eq(adminSession.id, sid));
      }
      await tx.insert(adminSession).values({
        id: i.id,
        adminAccountId: i.accountId,
        aud: i.aud,
        refreshHash: i.refreshHash,
        refreshFamily: i.refreshFamily,
        pairRef: i.pairRef,
        createdAt: now,
        absoluteExpiresAt: new Date(i.absoluteExpiresAt),
        idleExpiresAt: new Date(i.idleExpiresAt),
      });
      if (evicted.length > 0) {
        await tx.insert(adminSecurityNotice).values({ id: randomUUID(), adminAccountId: i.accountId, kind: 'SESSION_LIMIT', createdAt: now });
        // 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다(asyncapi control.sessions-terminated, 이유 DEVICE_LIMIT, ADR-0143 결정 3)
        const terminatedAt = now.toISOString();
        await writeOutbox(
          tx,
          this.clock,
          [...evicted].sort().map((sessionId) => ({
            topic: CONTROL_TOPICS.sessionsTerminated,
            key: i.accountId,
            payload: Buffer.from(JSON.stringify({ accountId: i.accountId, sessionId, reason: 'DEVICE_LIMIT', terminatedAt })),
          })),
        );
      }
      return { evicted };
    });
  }
}
