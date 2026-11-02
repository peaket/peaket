// 본인확인 PostgreSQL 저장소(Drizzle). 같은 연계정보 HMAC이 동시에 두 계정으로 들어와도 UNIQUE가 하나만 남긴다
// (늦은 쪽은 CiAlreadyLinked로 끝나 409 DUPLICATE_ACCOUNT이고 건은 처리 중으로 남는다. 다시 보내면 DUPLICATE_ACCOUNT로 확정된다).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import type { VerificationStore, VerificationTx } from '../../domain/ports.js';
import { type Attempt, CiAlreadyLinked, VerificationRaced } from '../../domain/verification.js';
import { identityVerification, verificationAttempt } from './schema.js';

type Row = typeof verificationAttempt.$inferSelect;
const attemptOf = (r: Row): Attempt => ({
  id: r.id,
  accountId: r.accountId,
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
        const [r] = await tx.select({ ciHmac: identityVerification.ciHmac, pid: identityVerification.pid }).from(identityVerification).where(eq(identityVerification.accountId, accountId)).for('update');
        return r ?? null;
      },
      accountByCiHmac: async (h) => {
        const [r] = await tx.select({ a: identityVerification.accountId }).from(identityVerification).where(eq(identityVerification.ciHmac, h));
        return r?.a ?? null;
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

  async claimsOf(accountId: string): Promise<{ pid: string; pidPrev?: string } | null> {
    const [r] = await this.database.db
      .select({ pid: identityVerification.pid, pidPrev: identityVerification.pidPrev })
      .from(identityVerification)
      .where(eq(identityVerification.accountId, accountId));
    if (!r) return null;
    return { pid: r.pid.toString('base64url'), ...(r.pidPrev ? { pidPrev: r.pidPrev.toString('base64url') } : {}) };
  }
}
