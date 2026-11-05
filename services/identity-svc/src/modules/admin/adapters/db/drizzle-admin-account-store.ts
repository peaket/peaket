// 관리 계정 저장소의 PostgreSQL 구현(docs/data.md admin_account·admin_login_step·admin_security_notice, BUILD_ORDER BOT-110·BOT-111).
// 로그인 실패 셈은 행을 잠근 트랜잭션에서 고치고 알림 행을 같은 트랜잭션에 적는다(auth-controls §3.1).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, CONTROL_TOPICS, DATABASE, type Database, type DbTransaction, writeOutbox } from '@peaket/platform';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, notInArray, or } from 'drizzle-orm';
import { type AccountLoginState, FRESH_LOGIN_STATE, type LockKind, type LockReason, type NoticeKind } from '../../domain/login-rules.js';
import { sql as rawSql } from 'drizzle-orm';
import type { AdminAccountRequestKind, AdminAccountRow, AdminAccountStore, AdminAud, AdminLoginAccount, AdminLoginStore, AdminManagementStore, AdminManagementTx, AdminRefreshRow, AdminRefreshStore, AdminRefreshTx, AdminRole, ManagedAccount, AdminSecondStepStore, AdminSessionEndReason, AdminSessionRow, AdminSessionStore, AdminStatus, AdminTotpState, AdminUnlockStore, DesignationKind, LoginStepRow, PendingNotice, UnlockLinkRow } from '../../domain/ports.js';
import { DESIGNATION_KINDS, type SecondStepUse } from '../../domain/ports.js';

/** finishSecondStep의 되돌리기(코드나 단계를 그 사이 다른 요청이 썼다) */
class SecondStepAbort extends Error {
  constructor(readonly kind: 'CODE_USED' | 'STEP_USED') {
    super(kind);
  }
}
import { adminAccount, adminAccountRequest, adminDesignation, adminKnownSource, adminLoginStep, adminRecoveryCode, adminRefreshTokenHash, adminSecurityNotice, adminSession, adminUnlockLink } from './schema.js';

type AccountRow = typeof adminAccount.$inferSelect;
/** 알림을 보내지 못했을 때 다음 시도까지(1분부터 두 배씩, 최대 1시간 [가정]) */
const retryDelayMs = (attempts: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
/** 트랜잭션을 되돌리라는 안쪽 신호(바깥에서 false로 바꾼다) */
class AbortTx extends Error {}
const ms = (d: Date | null) => (d ? d.getTime() : null);

function stateOf(r: AccountRow): AccountLoginState {
  return {
    failedAttempts: r.failedAttempts,
    passwordFailureTotal: r.passwordFailureTotal,
    secondFactorFailures: r.secondFactorFailures,
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
    secondFactorFailures: s.secondFactorFailures,
    lockKind: s.lockKind,
    lockedUntil: s.lockedUntil === null ? null : new Date(s.lockedUntil),
    recentLockAt: s.recentLockAt.map((t) => new Date(t).toISOString()),
    lockReason: s.lockReason,
    lockedAt: s.lockedAt === null ? null : new Date(s.lockedAt),
  };
}

@Injectable()
export class DrizzleAdminAccountStore implements AdminManagementStore, AdminAccountStore, AdminLoginStore, AdminSecondStepStore, AdminUnlockStore, AdminSessionStore {
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

  async createLoginStep(i: { id: string; accountId: string; tokenHash: Buffer; aud: AdminAud; pairRef: string; createdAt: number; expiresAt: number; knownSource?: boolean }): Promise<void> {
    await this.database.db.insert(adminLoginStep).values({ id: i.id, adminAccountId: i.accountId, tokenHash: i.tokenHash, aud: i.aud, pairRef: i.pairRef, createdAt: new Date(i.createdAt), expiresAt: new Date(i.expiresAt), knownSource: i.knownSource === true });
  }

  async isKnownSource(accountId: string, pairRef: string, since: number): Promise<boolean> {
    const [r] = await this.database.db
      .select({ at: adminKnownSource.lastSuccessAt })
      .from(adminKnownSource)
      .where(and(eq(adminKnownSource.adminAccountId, accountId), eq(adminKnownSource.pairRef, pairRef)));
    return !!r && r.at.getTime() >= since;
  }

  async recordLoginSuccess(id: string, at: number): Promise<void> {
    await this.database.db
      .update(adminAccount)
      .set({ failedAttempts: 0, secondFactorFailures: 0, passwordFailureTotal: 0, lastLoginAt: new Date(at), updatedAt: new Date(at) })
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
  }

  // ── TOTP와 2단계(BOT-120) ──
  async findLoginById(id: string): Promise<(AdminLoginAccount & { email: string; promoterId: string | null }) | null> {
    const [r] = await this.database.db
      .select()
      .from(adminAccount)
      .where(and(eq(adminAccount.id, id), ne(adminAccount.status, 'REMOVED')));
    if (!r) return null;
    return { id: r.id, role: r.role as AdminRole, status: r.status as AdminStatus, passwordPhc: r.passwordPhc, breachCheckedAt: ms(r.breachCheckedAt), passwordChangeRequired: r.passwordChangeRequired, state: stateOf(r), email: r.email ?? '', promoterId: r.promoterId };
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
      // 수명 안이고, 비밀번호만 맞은 로그인으로 본 단계가 아니어야 쓴다(정비와 2단계가 같은 행을 두고 겹쳐도 둘 중 하나만, 재검토 2026-11-05)
      .where(and(eq(adminLoginStep.id, id), isNull(adminLoginStep.usedAt), isNull(adminLoginStep.passwordOnlyNoticedAt), gt(adminLoginStep.expiresAt, new Date(at))))
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
      return this.#openSession(tx, i, limit);
    });
  }

  async finishSecondStep(i: { id: string; accountId: string; aud: AdminAud; refreshHash: Buffer; refreshFamily: string; pairRef: string; createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number }, limit: number, use: SecondStepUse): Promise<{ kind: 'DONE'; evicted: string[] } | { kind: 'CODE_USED' } | { kind: 'STEP_USED' }> {
    try {
      return await this.database.transaction(async (tx) => {
        const [acc] = await tx.select({ status: adminAccount.status }).from(adminAccount).where(eq(adminAccount.id, i.accountId)).for('update');
        // 잠근 뒤 계정이 활성이 아니면(그 사이 재초대 정리·삭제) 처음부터다(재검토 2026-11-05)
        if (acc?.status !== 'ACTIVE') throw new SecondStepAbort('STEP_USED');
        const now = new Date(i.createdAt);
        // 코드 먼저(다른 요청이 같은 코드를 썼으면 틀린 코드로 센다), 그다음 단계, 세션. 하나라도 안 되면 모두 되돌린다
        const code =
          use.code.kind === 'totp'
            ? await tx
                .update(adminAccount)
                .set({ totpLastStep: use.code.step, updatedAt: now })
                .where(and(eq(adminAccount.id, i.accountId), or(isNull(adminAccount.totpLastStep), lt(adminAccount.totpLastStep, use.code.step))))
                .returning({ id: adminAccount.id })
            : await tx
                .delete(adminRecoveryCode)
                .where(and(eq(adminRecoveryCode.id, use.code.rowId), eq(adminRecoveryCode.adminAccountId, i.accountId)))
                .returning({ id: adminRecoveryCode.id });
        if (code.length === 0) throw new SecondStepAbort('CODE_USED');
        const step = await tx
          .update(adminLoginStep)
          .set({ usedAt: now })
          .where(and(eq(adminLoginStep.id, use.stepId), isNull(adminLoginStep.usedAt), isNull(adminLoginStep.passwordOnlyNoticedAt), gt(adminLoginStep.expiresAt, now)))
          .returning({ id: adminLoginStep.id });
        if (step.length === 0) throw new SecondStepAbort('STEP_USED');
        return { kind: 'DONE' as const, ...(await this.#openSession(tx, i, limit)) };
      });
    } catch (e) {
      if (e instanceof SecondStepAbort) return { kind: e.kind };
      throw e;
    }
  }

  /** 계정 행을 잠근 트랜잭션에서 세션을 만든다(createSession·finishSecondStep) */
  async #openSession(tx: DbTransaction, i: { id: string; accountId: string; aud: AdminAud; refreshHash: Buffer; refreshFamily: string; pairRef: string; createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number }, limit: number): Promise<{ evicted: string[] }> {
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
      // 로그인 때 준 첫 리프레시 토큰도 발급 해시 기록에 남긴다(회전 뒤 다시 오면 재사용, BOT-130)
      await tx.insert(adminRefreshTokenHash).values({ hash: i.refreshHash, adminSessionId: i.id, refreshFamily: i.refreshFamily, issuedAt: now, expiresAt: new Date(i.absoluteExpiresAt) });
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
  }

  // ── 본인 해제 링크와 알림 발송(BOT-121) ──
  async createUnlockLink(i: { id: string; accountId: string; tokenHash: Buffer; createdAt: number; expiresAt: number }): Promise<void> {
    await this.database.transaction(async (tx) => {
      // 계정 행을 잠가 같은 계정의 링크 만들기를 차례로 한다(살아 있는 링크가 하나만 남게)
      await tx.select({ id: adminAccount.id }).from(adminAccount).where(eq(adminAccount.id, i.accountId)).for('update');
      await tx
        .update(adminUnlockLink)
        .set({ revokedAt: new Date(i.createdAt) })
        .where(and(eq(adminUnlockLink.adminAccountId, i.accountId), isNull(adminUnlockLink.usedAt), isNull(adminUnlockLink.revokedAt)));
      await tx.insert(adminUnlockLink).values({ id: i.id, adminAccountId: i.accountId, tokenHash: i.tokenHash, createdAt: new Date(i.createdAt), expiresAt: new Date(i.expiresAt) });
    });
  }

  async findUnlockLink(tokenHash: Buffer): Promise<UnlockLinkRow | null> {
    const [r] = await this.database.db.select().from(adminUnlockLink).where(eq(adminUnlockLink.tokenHash, tokenHash));
    return r ? { id: r.id, accountId: r.adminAccountId, codeFailures: r.codeFailures, createdAt: r.createdAt.getTime(), expiresAt: r.expiresAt.getTime(), usedAt: ms(r.usedAt), revokedAt: ms(r.revokedAt) } : null;
  }

  async failUnlockCode(linkId: string): Promise<number> {
    const [r] = await this.database.db
      .update(adminUnlockLink)
      .set({ codeFailures: rawSql`${adminUnlockLink.codeFailures} + 1` })
      .where(eq(adminUnlockLink.id, linkId))
      .returning({ n: adminUnlockLink.codeFailures });
    return r?.n ?? 0;
  }

  async useUnlockLink(linkId: string, accountId: string, now: number, fn: (cur: AccountLoginState) => AccountLoginState | null, notice: NoticeKind): Promise<boolean> {
    return this.database
      .transaction(async (tx) => {
      // 계정 행을 먼저 잠근다: 링크 만들기(createUnlockLink)와 같은 순서라 교착하지 않는다(새 맥락 리뷰 2026-11-05)
      const [r] = await tx
        .select()
        .from(adminAccount)
        .where(and(eq(adminAccount.id, accountId), ne(adminAccount.status, 'REMOVED')))
        .for('update');
      if (!r) return false;
      const used = await tx
        .update(adminUnlockLink)
        .set({ usedAt: new Date(now) })
        .where(and(eq(adminUnlockLink.id, linkId), eq(adminUnlockLink.adminAccountId, accountId), isNull(adminUnlockLink.usedAt), isNull(adminUnlockLink.revokedAt)))
        .returning({ id: adminUnlockLink.id });
      if (used.length === 0) return false;
      const next = fn(stateOf(r));
      // 확정할 수 없으면(보호 잠금 등) 링크 쓰기까지 되돌린다
      if (!next) throw new AbortTx();
      await tx
        .update(adminAccount)
        .set({ ...stateColumns(next), updatedAt: new Date(now) })
        .where(eq(adminAccount.id, accountId));
      await tx.insert(adminSecurityNotice).values({ id: randomUUID(), adminAccountId: accountId, kind: notice, createdAt: new Date(now) });
      return true;
    })
      .catch((e: unknown) => {
        if (e instanceof AbortTx) return false;
        throw e;
      });
  }

  async dispatchNotices(limit: number, now: number, handle: (n: PendingNotice) => Promise<'SENT' | 'CLOSE' | 'KEEP'>): Promise<{ done: number; failed: number }> {
    // 한 행에 트랜잭션 하나: 한 행의 예외가 앞에서 보낸 행의 sent_at을 되돌리지 않는다. 보내지 못한 행은 다음 시도를 미뤄 뒤의 알림을 막지 않는다(새 맥락 리뷰 2026-11-05)
    let done = 0;
    let failed = 0;
    const skip: string[] = [];
    const due = or(isNull(adminSecurityNotice.nextAttemptAt), lte(adminSecurityNotice.nextAttemptAt, new Date(now)));
    for (let k = 0; k < limit; k++) {
      let row: { id: string; attempts: number } | null = null;
      try {
        await this.database.transaction(async (tx) => {
          const [r] = await tx
            .select({ id: adminSecurityNotice.id, accountId: adminSecurityNotice.adminAccountId, kind: adminSecurityNotice.kind, createdAt: adminSecurityNotice.createdAt, attempts: adminSecurityNotice.attempts })
            .from(adminSecurityNotice)
            .where(and(isNull(adminSecurityNotice.sentAt), due, skip.length > 0 ? notInArray(adminSecurityNotice.id, skip) : undefined))
            .orderBy(asc(adminSecurityNotice.createdAt))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!r) return;
          row = { id: r.id, attempts: r.attempts };
          skip.push(r.id);
          const result = await handle({ id: r.id, accountId: r.accountId, kind: r.kind as NoticeKind, createdAt: r.createdAt.getTime() });
          if (result === 'KEEP') {
            failed++;
            await tx
              .update(adminSecurityNotice)
              .set({ attempts: r.attempts + 1, nextAttemptAt: new Date(now + retryDelayMs(r.attempts + 1)) })
              .where(eq(adminSecurityNotice.id, r.id));
            return;
          }
          await tx.update(adminSecurityNotice).set({ sentAt: new Date(now) }).where(eq(adminSecurityNotice.id, r.id));
          done++;
        });
      } catch {
        // 그 행만 되돌렸다: 다음 시도를 따로 미룬다(같은 행이 앞을 막지 않게)
        if (!row) break;
        failed++;
        const failedRow: { id: string; attempts: number } = row;
        await this.database.db
          .update(adminSecurityNotice)
          .set({ attempts: failedRow.attempts + 1, nextAttemptAt: new Date(now + retryDelayMs(failedRow.attempts + 1)) })
          .where(eq(adminSecurityNotice.id, failedRow.id))
          .catch(() => undefined);
      }
      if (!row) break;
    }
    return { done, failed };
  }


  // ── 비밀번호만 맞은 로그인·세션(BOT-123) ──
  async findSession(sessionId: string): Promise<AdminSessionRow | null> {
    const [r] = await this.database.db.select().from(adminSession).where(eq(adminSession.id, sessionId));
    return r ? { id: r.id, accountId: r.adminAccountId, aud: r.aud as AdminAud, pairRef: r.pairRef, absoluteExpiresAt: r.absoluteExpiresAt.getTime(), idleExpiresAt: r.idleExpiresAt.getTime(), terminatedAt: ms(r.terminatedAt) } : null;
  }

  async terminateOtherSessions(accountId: string, keepSessionId: string, reason: 'PASSWORD_CHANGED', now: number): Promise<string[]> {
    return this.database.transaction(async (tx) => {
      const ended = await tx
        .update(adminSession)
        .set({ terminatedAt: new Date(now), terminationReason: reason })
        .where(and(eq(adminSession.adminAccountId, accountId), ne(adminSession.id, keepSessionId), isNull(adminSession.terminatedAt)))
        .returning({ id: adminSession.id });
      const ids = ended.map((e) => e.id).sort();
      if (ids.length > 0) {
        // 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다(asyncapi control.sessions-terminated, ADR-0143 결정 3)
        const terminatedAt = new Date(now).toISOString();
        await writeOutbox(
          tx,
          this.clock,
          ids.map((sessionId) => ({ topic: CONTROL_TOPICS.sessionsTerminated, key: accountId, payload: Buffer.from(JSON.stringify({ accountId, sessionId, reason, terminatedAt })) })),
        );
      }
      return ids;
    });
  }

  // ── 관리 계정 관리(BOT-150) ──
  #managed(r: AccountRow, designations: DesignationKind[]): ManagedAccount {
    return {
      id: r.id,
      role: r.role as AdminRole,
      promoterId: r.promoterId,
      status: r.status as AdminStatus,
      email: r.email,
      displayName: r.displayName,
      inviteExpiresAt: ms(r.inviteExpiresAt),
      lastLoginAt: ms(r.lastLoginAt),
      removedAt: ms(r.removedAt),
      version: r.version,
      totpEnrolled: r.totpSeedEnc !== null,
      lockKind: r.lockKind as LockKind,
      lockReason: (r.lockReason as LockReason | null) ?? null,
      lockedUntil: ms(r.lockedUntil),
      designations,
    };
  }

  /** 계정들의 살아 있는 지정(종류 차례) */
  async #liveDesignations(db: Pick<DbTransaction, 'select'>, ids: string[]): Promise<Map<string, DesignationKind[]>> {
    const out = new Map<string, DesignationKind[]>();
    if (ids.length === 0) return out;
    const rows = await db.select({ id: adminDesignation.adminAccountId, kind: adminDesignation.kind }).from(adminDesignation).where(and(inArray(adminDesignation.adminAccountId, ids), isNull(adminDesignation.revokedAt)));
    for (const id of ids) {
      const kinds = new Set(rows.filter((r) => r.id === id).map((r) => r.kind));
      out.set(id, DESIGNATION_KINDS.filter((k) => kinds.has(k)));
    }
    return out;
  }

  async #withDesignations(db: Pick<DbTransaction, 'select'>, rows: AccountRow[]): Promise<ManagedAccount[]> {
    const d = await this.#liveDesignations(db, rows.map((r) => r.id));
    return rows.map((r) => this.#managed(r, d.get(r.id) ?? []));
  }

  /** 살아 있는 지정과 since 뒤에 거둔 지정을 쿼리 한 번으로 */
  async #designationsIn(db: Pick<DbTransaction, 'select'>, id: string, since: number): Promise<{ live: DesignationKind[]; revoked: { kind: DesignationKind; revokedAt: number }[] }> {
    const rows = await db
      .select({ kind: adminDesignation.kind, revokedAt: adminDesignation.revokedAt })
      .from(adminDesignation)
      .where(and(eq(adminDesignation.adminAccountId, id), or(isNull(adminDesignation.revokedAt), gt(adminDesignation.revokedAt, new Date(since)))))
      .orderBy(asc(adminDesignation.revokedAt), asc(adminDesignation.kind));
    const live = new Set(rows.filter((r) => r.revokedAt === null).map((r) => r.kind));
    return {
      live: DESIGNATION_KINDS.filter((k) => live.has(k)),
      revoked: rows.filter((r) => r.revokedAt !== null).map((r) => ({ kind: r.kind as DesignationKind, revokedAt: r.revokedAt!.getTime() })),
    };
  }

  async designationsOf(accountId: string, since: number): Promise<{ status: AdminStatus | null; live: DesignationKind[]; revoked: { kind: DesignationKind; revokedAt: number }[] }> {
    const db = this.database.db;
    const [a] = await db.select({ status: adminAccount.status }).from(adminAccount).where(eq(adminAccount.id, accountId));
    if (!a) return { status: null, live: [], revoked: [] };
    return { status: a.status as AdminStatus, ...(await this.#designationsIn(db as unknown as DbTransaction, accountId, since)) };
  }

  async manageTransaction<T>(fn: (tx: AdminManagementTx) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => {
      const bump = { version: rawSql`${adminAccount.version} + 1` };
      const api: AdminManagementTx = {
        findRequest: async (requestId) => {
          // 같은 request_id가 동시에 와도 차례로(트랜잭션 끝까지 쥐는 권고 잠금)
          await tx.execute(rawSql`select pg_advisory_xact_lock(hashtextextended(${`admin-request:${requestId}`}, 0))`);
          const [r] = await tx.select().from(adminAccountRequest).where(eq(adminAccountRequest.requestId, requestId));
          return r ? { kind: r.kind as AdminAccountRequestKind, accountId: r.adminAccountId, result: r.result } : null;
        },
        recordRequest: async (r) => {
          await tx.insert(adminAccountRequest).values({ requestId: r.requestId, kind: r.kind, adminAccountId: r.accountId, result: r.result, createdAt: new Date(r.at) });
        },
        readAccount: async (id) => {
          const [r] = await tx.select().from(adminAccount).where(eq(adminAccount.id, id));
          return r ? this.#managed(r, []) : null;
        },
        lockAccount: async (id) => {
          const [r] = await tx.select().from(adminAccount).where(eq(adminAccount.id, id)).for('update');
          return r ? this.#managed(r, []) : null;
        },
        lockPartnerAdmins: async (promoterId) =>
          (
            await tx
              .select()
              .from(adminAccount)
              .where(and(eq(adminAccount.role, 'partner_admin'), eq(adminAccount.promoterId, promoterId), ne(adminAccount.status, 'REMOVED')))
              .orderBy(asc(adminAccount.id))
              .for('update')
          ).map((r) => this.#managed(r, [])),
        insertInvited: async (i) => {
          // 지우지 않은 계정 사이의 이메일 고유 색인(admin_account_email_live_key)으로 가린다: 동시에 와도 하나만 들어간다
          const done = await tx
            .insert(adminAccount)
            .values({ id: i.id, role: i.role, promoterId: i.promoterId, status: 'INVITED', email: i.email, displayName: i.displayName, createdAt: new Date(i.now), updatedAt: new Date(i.now) })
            .onConflictDoNothing({ target: adminAccount.email, where: rawSql`${adminAccount.status} <> 'REMOVED'` })
            .returning({ id: adminAccount.id });
          return done.length > 0;
        },
        setRole: async (id, role, now) => {
          await tx.update(adminAccount).set({ role, ...bump, updatedAt: new Date(now) }).where(eq(adminAccount.id, id));
        },
        resetInvite: async (id, now) => {
          await tx.update(adminAccount).set({ status: 'INVITED', inviteTokenHash: null, inviteExpiresAt: null, ...bump, updatedAt: new Date(now) }).where(eq(adminAccount.id, id));
        },
        wipeCredentials: async (id, now) => {
          await tx
            .update(adminAccount)
            .set({ status: 'INVITED', passwordPhc: null, totpSeedEnc: null, totpPendingEnc: null, totpLastStep: null, passwordChangeRequired: false, breachCheckedAt: null, inviteTokenHash: null, inviteExpiresAt: null, ...stateColumns(FRESH_LOGIN_STATE), ...bump, updatedAt: new Date(now) })
            .where(eq(adminAccount.id, id));
          await tx.delete(adminRecoveryCode).where(eq(adminRecoveryCode.adminAccountId, id));
        },
        markRemoved: async (id, now) => {
          await tx
            .update(adminAccount)
            .set({
              status: 'REMOVED',
              removedAt: new Date(now),
              email: null,
              displayName: null,
              passwordPhc: null,
              totpSeedEnc: null,
              totpPendingEnc: null,
              totpLastStep: null,
              inviteTokenHash: null,
              inviteExpiresAt: null,
              // ID·역할·삭제 시각만 남긴다(docs/data.md admin_account, 재검토 2026-11-05)
              lastLoginAt: null,
              breachCheckedAt: null,
              passwordChangeRequired: false,
              ...stateColumns(FRESH_LOGIN_STATE),
              ...bump,
              updatedAt: new Date(now),
            })
            .where(eq(adminAccount.id, id));
          await tx.delete(adminRecoveryCode).where(eq(adminRecoveryCode.adminAccountId, id));
          await tx.delete(adminKnownSource).where(eq(adminKnownSource.adminAccountId, id));
          await tx.delete(adminUnlockLink).where(eq(adminUnlockLink.adminAccountId, id));
          await tx.delete(adminLoginStep).where(eq(adminLoginStep.adminAccountId, id));
        },
        endAllSessions: async (id, reason, now) => {
          const live = await tx.select({ id: adminSession.id }).from(adminSession).where(and(eq(adminSession.adminAccountId, id), isNull(adminSession.terminatedAt)));
          return this.#endIn(tx, live.map((x) => x.id), reason, now);
        },
        addNotice: async (id, kind, now) => {
          await tx.insert(adminSecurityNotice).values({ id: randomUUID(), adminAccountId: id, kind, createdAt: new Date(now) });
        },
        designationsFor: (id, since) => this.#designationsIn(tx, id, since),
        insertDesignation: async (i) => {
          await tx.insert(adminDesignation).values({ id: i.id, adminAccountId: i.accountId, kind: i.kind, basis: i.basis, designatedBy: i.by, designatedAt: new Date(i.now) });
        },
        revokeDesignations: async (id, kinds, now) => {
          if (kinds.length === 0) return [];
          const done = await tx
            .update(adminDesignation)
            .set({ revokedAt: new Date(now) })
            .where(and(eq(adminDesignation.adminAccountId, id), isNull(adminDesignation.revokedAt), inArray(adminDesignation.kind, [...kinds])))
            .returning({ kind: adminDesignation.kind });
          return done.map((d) => d.kind as DesignationKind);
        },
      };
      return fn(api);
    });
  }

  async getManaged(id: string): Promise<ManagedAccount | null> {
    const [r] = await this.database.db.select().from(adminAccount).where(eq(adminAccount.id, id));
    return r ? (await this.#withDesignations(this.database.db as unknown as DbTransaction, [r]))[0]! : null;
  }

  async listManaged(q: { roles: readonly AdminRole[]; promoterId?: string; status?: AdminStatus; excludeRemoved?: boolean; after?: { lastLoginAt: number | null; id: string }; offset?: number; limit: number; now: number }): Promise<ManagedAccount[]> {
    const now = new Date(q.now);
    const conds = [inArray(adminAccount.role, [...q.roles])];
    if (q.promoterId) conds.push(eq(adminAccount.promoterId, q.promoterId));
    if (q.excludeRemoved) conds.push(ne(adminAccount.status, 'REMOVED'));
    // 보이는 상태: 만료가 지난 INVITED는 INVITE_EXPIRED
    if (q.status === 'INVITE_EXPIRED') conds.push(or(eq(adminAccount.status, 'INVITE_EXPIRED'), and(eq(adminAccount.status, 'INVITED'), lte(adminAccount.inviteExpiresAt, now)))!);
    else if (q.status === 'INVITED') conds.push(and(eq(adminAccount.status, 'INVITED'), or(isNull(adminAccount.inviteExpiresAt), gt(adminAccount.inviteExpiresAt, now)))!);
    else if (q.status) conds.push(eq(adminAccount.status, q.status));
    // 커서: 마지막 접속이 늦은 순(없으면 뒤)·ID 순의 다음 줄부터
    if (q.after) {
      const a = q.after;
      conds.push(
        a.lastLoginAt === null
          ? and(isNull(adminAccount.lastLoginAt), gt(adminAccount.id, a.id))!
          : or(lt(adminAccount.lastLoginAt, new Date(a.lastLoginAt)), and(eq(adminAccount.lastLoginAt, new Date(a.lastLoginAt)), gt(adminAccount.id, a.id)), isNull(adminAccount.lastLoginAt))!,
      );
    }
    const rows = await this.database.db
      .select()
      .from(adminAccount)
      .where(and(...conds))
      .orderBy(rawSql`${adminAccount.lastLoginAt} desc nulls last`, asc(adminAccount.id))
      .limit(q.limit)
      .offset(q.offset ?? 0);
    // 지정은 관제 역할에만 붙는다: 파트너 목록이면 읽지 않는다
    if (q.roles.every((r) => r === 'partner_admin' || r === 'partner_member')) return rows.map((r) => this.#managed(r, []));
    return this.#withDesignations(this.database.db as unknown as DbTransaction, rows);
  }

  async liveSessions(id: string, now: number): Promise<{ id: string; createdAt: number; idleExpiresAt: number }[]> {
    const t = new Date(now);
    const rows = await this.database.db
      .select({ id: adminSession.id, createdAt: adminSession.createdAt, idleExpiresAt: adminSession.idleExpiresAt })
      .from(adminSession)
      .where(and(eq(adminSession.adminAccountId, id), isNull(adminSession.terminatedAt), gt(adminSession.idleExpiresAt, t), gt(adminSession.absoluteExpiresAt, t)))
      .orderBy(asc(adminSession.createdAt));
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.getTime(), idleExpiresAt: r.idleExpiresAt.getTime() }));
  }

  async setInviteToken(id: string, tokenHash: Buffer, expiresAt: number, now: number): Promise<boolean> {
    const done = await this.database.db
      .update(adminAccount)
      .set({ inviteTokenHash: tokenHash, inviteExpiresAt: new Date(expiresAt), updatedAt: new Date(now) })
      .where(and(eq(adminAccount.id, id), eq(adminAccount.status, 'INVITED')))
      .returning({ id: adminAccount.id });
    return done.length > 0;
  }

  async expireInvites(now: number): Promise<number> {
    const done = await this.database.db
      .update(adminAccount)
      .set({ status: 'INVITE_EXPIRED', inviteTokenHash: null, updatedAt: new Date(now) })
      .where(and(eq(adminAccount.status, 'INVITED'), lte(adminAccount.inviteExpiresAt, new Date(now))))
      .returning({ id: adminAccount.id });
    return done.length;
  }

  async purgeRequests(before: number): Promise<number> {
    const gone = await this.database.db.delete(adminAccountRequest).where(lt(adminAccountRequest.createdAt, new Date(before))).returning({ id: adminAccountRequest.requestId });
    return gone.length;
  }

  // ── 토큰 갱신과 로그아웃(BOT-130) ──
  async refreshTransaction<T>(fn: (tx: AdminRefreshTx) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => {
      const api: AdminRefreshTx = {
        findByRefreshHash: async (hash): Promise<AdminRefreshRow | null> => {
          // 지금·바로 앞 토큰이면 그 세션 행을 잠근다. 동시 갱신은 앞 갱신이 끝난 뒤 바뀐 행으로 다시 판정한다(READ COMMITTED의 FOR UPDATE)
          const [cur] = await tx
            .select()
            .from(adminSession)
            .where(or(eq(adminSession.refreshHash, hash), eq(adminSession.prevRefreshHash, hash)))
            .for('update');
          const past = cur ? undefined : (await tx.select({ sessionId: adminRefreshTokenHash.adminSessionId }).from(adminRefreshTokenHash).where(eq(adminRefreshTokenHash.hash, hash)))[0];
          const r = cur ?? (past ? (await tx.select().from(adminSession).where(eq(adminSession.id, past.sessionId)).for('update'))[0] : undefined);
          if (!r) return null;
          const match = cur ? (Buffer.from(cur.refreshHash).equals(hash) ? 'current' : 'previous') : 'history';
          return {
            id: r.id,
            accountId: r.adminAccountId,
            aud: r.aud as AdminAud,
            refreshFamily: r.refreshFamily,
            absoluteExpiresAt: r.absoluteExpiresAt.getTime(),
            idleExpiresAt: r.idleExpiresAt.getTime(),
            terminatedAt: ms(r.terminatedAt),
            match,
            rotatedAt: ms(r.rotatedAt),
            refreshUsed: r.refreshUsed,
          };
        },
        accountOf: async (id) => {
          const [a] = await tx.select({ status: adminAccount.status, role: adminAccount.role, passwordChangeRequired: adminAccount.passwordChangeRequired }).from(adminAccount).where(eq(adminAccount.id, id));
          return a ? { status: a.status as AdminStatus, role: a.role as AdminRole, passwordChangeRequired: a.passwordChangeRequired } : null;
        },
        familySessions: async (family) => (await tx.select({ id: adminSession.id }).from(adminSession).where(and(eq(adminSession.refreshFamily, family), isNull(adminSession.terminatedAt)))).map((x) => x.id),
        terminateSessions: (ids, reason, now) => this.#endIn(tx, ids, reason, now).then(() => undefined),
        rotateRefresh: async (id, hash, now, idleExpiresAt) => {
          await tx
            .update(adminSession)
            .set({ prevRefreshHash: rawSql`${adminSession.refreshHash}`, refreshHash: hash, rotatedAt: new Date(now), refreshUsed: false, idleExpiresAt: new Date(idleExpiresAt) })
            .where(eq(adminSession.id, id));
        },
        setRefreshHash: async (id, hash) => {
          await tx.update(adminSession).set({ refreshHash: hash }).where(eq(adminSession.id, id));
        },
        recordRefreshHash: async (r) => {
          await tx.insert(adminRefreshTokenHash).values({ hash: r.hash, adminSessionId: r.sessionId, refreshFamily: r.refreshFamily, issuedAt: new Date(r.issuedAt), expiresAt: new Date(r.expiresAt) });
        },
      };
      return fn(api);
    });
  }

  async endSession(accountId: string, sessionId: string, reason: 'LOGOUT', now: number): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [s] = await tx
        .select({ id: adminSession.id })
        .from(adminSession)
        .where(and(eq(adminSession.id, sessionId), eq(adminSession.adminAccountId, accountId), isNull(adminSession.terminatedAt)))
        .for('update');
      if (!s) return false;
      return (await this.#endIn(tx, [s.id], reason, now)).length > 0;
    });
  }

  async purgeRefreshHashes(before: number): Promise<number> {
    const gone = await this.database.db.delete(adminRefreshTokenHash).where(lt(adminRefreshTokenHash.expiresAt, new Date(before))).returning({ hash: adminRefreshTokenHash.hash });
    return gone.length;
  }

  /** 끝나지 않은 세션들을 끝내고 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다(asyncapi control.sessions-terminated, ADR-0143 결정 3). 끝낸 세션 ID */
  async #endIn(tx: DbTransaction, ids: string[], reason: AdminSessionEndReason, now: number): Promise<string[]> {
    if (ids.length === 0) return [];
    const ended = await tx
      .update(adminSession)
      .set({ terminatedAt: new Date(now), terminationReason: reason })
      .where(and(inArray(adminSession.id, ids), isNull(adminSession.terminatedAt)))
      .returning({ id: adminSession.id, accountId: adminSession.adminAccountId });
    const sorted = ended.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (sorted.length > 0) {
      const terminatedAt = new Date(now).toISOString();
      await writeOutbox(
        tx,
        this.clock,
        sorted.map((e) => ({ topic: CONTROL_TOPICS.sessionsTerminated, key: e.accountId, payload: Buffer.from(JSON.stringify({ accountId: e.accountId, sessionId: e.id, reason, terminatedAt })) })),
      );
    }
    return sorted.map((e) => e.id);
  }

  async touchKnownSource(accountId: string, pairRef: string, at: number): Promise<void> {
    await this.database.db
      .insert(adminKnownSource)
      .values({ adminAccountId: accountId, pairRef, lastSuccessAt: new Date(at) })
      .onConflictDoUpdate({ target: [adminKnownSource.adminAccountId, adminKnownSource.pairRef], set: { lastSuccessAt: new Date(at) } });
  }

  async purgeKnownSources(before: number): Promise<number> {
    const done = await this.database.db.delete(adminKnownSource).where(lt(adminKnownSource.lastSuccessAt, new Date(before))).returning({ id: adminKnownSource.adminAccountId });
    return done.length;
  }

  async purgeLoginSteps(before: number): Promise<number> {
    const done = await this.database.db.delete(adminLoginStep).where(lt(adminLoginStep.createdAt, new Date(before))).returning({ id: adminLoginStep.id });
    return done.length;
  }

  async findPasswordOnlySteps(createdBefore: number, createdAfter: number, limit: number): Promise<{ id: string; accountId: string }[]> {
    // 부분 색인 admin_login_step_password_only_idx(쓰이지 않은 익숙하지 않은 알리지 않은 행의 만든 때)로 찾는다
    return this.database.db
      .select({ id: adminLoginStep.id, accountId: adminLoginStep.adminAccountId })
      .from(adminLoginStep)
      .where(and(lte(adminLoginStep.createdAt, new Date(createdBefore)), gt(adminLoginStep.createdAt, new Date(createdAfter)), isNull(adminLoginStep.usedAt), eq(adminLoginStep.knownSource, false), isNull(adminLoginStep.passwordOnlyNoticedAt)))
      .orderBy(asc(adminLoginStep.createdAt))
      .limit(limit);
  }

  async markPasswordOnly(stepId: string, accountId: string, now: number): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const marked = await tx
        .update(adminLoginStep)
        .set({ passwordOnlyNoticedAt: new Date(now) })
        .where(and(eq(adminLoginStep.id, stepId), eq(adminLoginStep.adminAccountId, accountId), isNull(adminLoginStep.passwordOnlyNoticedAt), isNull(adminLoginStep.usedAt)))
        .returning({ pairRef: adminLoginStep.pairRef, createdAt: adminLoginStep.createdAt });
      const step = marked[0];
      if (!step) return false;
      // 그 단계 뒤에 같은 묶음에서 2단계까지 끝냈으면 주인이 다시 시도해 들어온 것이다: 본 것으로 적고 알리지 않는다(새 맥락 리뷰 2026-11-05)
      const later = await tx
        .select({ id: adminKnownSource.adminAccountId })
        .from(adminKnownSource)
        .where(and(eq(adminKnownSource.adminAccountId, accountId), eq(adminKnownSource.pairRef, step.pairRef), gte(adminKnownSource.lastSuccessAt, step.createdAt)));
      if (later.length > 0) return false;
      const updated = await tx
        .update(adminAccount)
        .set({ passwordChangeRequired: true, updatedAt: new Date(now) })
        .where(and(eq(adminAccount.id, accountId), ne(adminAccount.status, 'REMOVED')))
        .returning({ id: adminAccount.id });
      // 지운 계정은 본 것으로만 적고 알리지 않는다
      if (updated.length === 0) return false;
      await tx.insert(adminSecurityNotice).values({ id: randomUUID(), adminAccountId: accountId, kind: 'PASSWORD_ONLY_LOGIN', createdAt: new Date(now) });
      return true;
    });
  }
}
