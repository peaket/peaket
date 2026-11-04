// 관리 계정 저장소의 PostgreSQL 구현(docs/data.md admin_account·admin_login_step·admin_security_notice, BUILD_ORDER BOT-110·BOT-111).
// 로그인 실패 셈은 행을 잠근 트랜잭션에서 고치고 알림 행을 같은 트랜잭션에 적는다(auth-controls §3.1).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, eq, ne } from 'drizzle-orm';
import type { AccountLoginState, LockKind, LockReason, NoticeKind } from '../../domain/login-rules.js';
import type { AdminAccountRow, AdminAccountStore, AdminAud, AdminLoginAccount, AdminLoginStore, AdminRole, AdminStatus } from '../../domain/ports.js';
import { adminAccount, adminLoginStep, adminSecurityNotice } from './schema.js';

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
export class DrizzleAdminAccountStore implements AdminAccountStore, AdminLoginStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

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
}
