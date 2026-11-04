// 본인확인 PostgreSQL 저장소(Drizzle). 같은 연계정보 HMAC이 동시에 두 계정으로 들어와도 UNIQUE가 하나만 남긴다
// (늦은 쪽은 CiAlreadyLinked로 되돌리고, 유스케이스가 한 번 다시 판정해 DUPLICATE_ACCOUNT와 다른 계정 시도 기록으로 마친다, BUILD_ORDER BOT-020).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction } from '@peaket/platform';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { VerificationStore, VerificationTx } from '../../domain/ports.js';
import { type Attempt, CiAlreadyLinked, VerificationRaced } from '../../domain/verification.js';
import { identityConflictAttempt, identityVerification, verificationAttempt } from './schema.js';

type Row = typeof verificationAttempt.$inferSelect;
const attemptOf = (r: Row): Attempt => ({
  id: r.id,
  accountId: r.accountId,
  sessionId: r.sessionId,
  purpose: r.purpose as Attempt['purpose'],
  next: r.next,
  status: r.status as Attempt['status'],
  expiresAt: r.expiresAt.getTime(),
  createdAt: r.createdAt.getTime(),
  completedAt: r.completedAt === null ? null : r.completedAt.getTime(),
});

@Injectable()
export class DrizzleVerificationStore implements VerificationStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  transaction<T>(fn: (tx: VerificationTx) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(this.#tx(tx)));
  }

  #tx(tx: DbTransaction): VerificationTx {
    return {
      insertAttempt: async (a) => {
        await tx.insert(verificationAttempt).values({
          id: a.id,
          accountId: a.accountId,
          sessionId: a.sessionId,
          purpose: a.purpose,
          next: a.next,
          status: a.status,
          expiresAt: new Date(a.expiresAt),
          createdAt: new Date(a.createdAt),
        });
      },
      attemptForUpdate: async (id) => {
        const [r] = await tx.select().from(verificationAttempt).where(eq(verificationAttempt.id, id)).for('update');
        return r ? attemptOf(r) : null;
      },
      completeAttempt: async (id, status, now) => {
        await tx.update(verificationAttempt).set({ status, completedAt: new Date(now) }).where(eq(verificationAttempt.id, id));
      },
      verificationOf: async (accountId) => {
        const [r] = await tx
          .select({ ciHmac: identityVerification.ciHmac, ciHmacKeyVersion: identityVerification.ciHmacKeyVersion, pid: identityVerification.pid })
          .from(identityVerification)
          .where(eq(identityVerification.accountId, accountId))
          .for('update');
        return r ?? null;
      },
      accountByCiHmac: async (hs, except) => {
        if (hs.length === 0) return null;
        // 다른 계정을 먼저 찾는다(판 설정이 어긋났던 동안 자기 계정과 다른 계정이 같은 사람 값을 함께 가질 수 있다)
        const rows = await tx.select({ a: identityVerification.accountId }).from(identityVerification).where(inArray(identityVerification.ciHmac, [...hs])).limit(hs.length + 1);
        return rows.find((r) => r.a !== except)?.a ?? rows[0]?.a ?? null;
      },
      updateCiHmac: async (accountId, ciHmac, ciHmacKeyVersion) => {
        await tx.update(identityVerification).set({ ciHmac, ciHmacKeyVersion }).where(eq(identityVerification.accountId, accountId));
      },
      insertConflictAttempt: async (c) => {
        await tx.insert(identityConflictAttempt).values({ id: c.id, attemptedAccountId: c.attemptedAccountId, existingAccountId: c.existingAccountId, attemptedAt: new Date(c.attemptedAt) });
      },
      saveVerification: async (v) => {
        // 같은 사람이 두 계정에서 동시에 확정하면 UNIQUE가 늦은 쪽을 막는다(23505)
        const insert = tx.insert(identityVerification).values({
          accountId: v.accountId,
          ciHmac: v.ciHmac,
          ciHmacKeyVersion: v.ciHmacKeyVersion,
          pid: v.pid,
          pidKeyVersion: v.pidKeyVersion,
          verifiedAt: new Date(v.verifiedAt),
          sourceRecord: v.sourceRecord,
        });
        try {
          await insert;
        } catch (e) {
          const err = e as { code?: string; cause?: { code?: string; constraint?: string }; constraint?: string };
          const code = err.code ?? err.cause?.code;
          const constraint = err.constraint ?? err.cause?.constraint ?? '';
          if (code === '23505' && constraint.includes('ci_hmac')) throw new CiAlreadyLinked();
          if (code === '23505' && constraint === 'identity_verification_pkey') throw new VerificationRaced();
          throw e;
        }
      },
    };
  }

  async attempt(id: string): Promise<Attempt | null> {
    const [r] = await this.database.db.select().from(verificationAttempt).where(eq(verificationAttempt.id, id));
    return r ? attemptOf(r) : null;
  }

  async isVerified(accountId: string): Promise<boolean> {
    const [r] = await this.database.db.select({ a: identityVerification.accountId }).from(identityVerification).where(eq(identityVerification.accountId, accountId));
    return Boolean(r);
  }

  async recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean> {
    const [r] = await this.database.db
      .select({ id: verificationAttempt.id })
      .from(verificationAttempt)
      .where(
        and(
          eq(verificationAttempt.accountId, accountId),
          eq(verificationAttempt.sessionId, sessionId),
          eq(verificationAttempt.purpose, 'REVERIFY'),
          eq(verificationAttempt.status, 'VERIFIED'),
          gte(verificationAttempt.completedAt, new Date(since)),
        ),
      )
      .limit(1);
    return Boolean(r);
  }

  async purgeConflictAttempts(before: number): Promise<number> {
    const gone = await this.database.db.delete(identityConflictAttempt).where(lt(identityConflictAttempt.attemptedAt, new Date(before))).returning({ id: identityConflictAttempt.id });
    return gone.length;
  }

  async ciKeyVersionsInUse(): Promise<number[]> {
    // 시작할 때 한 번 부른다. 표를 다 읽지만(판 칸에 인덱스가 없다) 파드가 뜰 때만이다 [가정, 커지면 정비 시간에 인덱스]
    const rows = await this.database.db.selectDistinct({ v: identityVerification.ciHmacKeyVersion }).from(identityVerification);
    return rows.map((r) => r.v).sort((a, b) => a - b);
  }

  async claimsOf(accountId: string): Promise<{ pid: string; pidPrev?: string } | null> {
    const [r] = await this.database.db
      .select({ pid: identityVerification.pid, pidPrev: identityVerification.pidPrev })
      .from(identityVerification)
      .where(eq(identityVerification.accountId, accountId));
    if (!r) return null;
    return { pid: r.pid.toString('base64url'), ...(r.pidPrev ? { pidPrev: r.pidPrev.toString('base64url') } : {}) };
  }
}
