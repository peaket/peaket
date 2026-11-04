// 본인확인 PostgreSQL 저장소(Drizzle). 같은 연계정보 HMAC이 동시에 두 계정으로 들어와도 UNIQUE가 하나만 남긴다
// (늦은 쪽은 CiAlreadyLinked로 되돌리고, 유스케이스가 한 번 다시 판정해 DUPLICATE_ACCOUNT와 다른 계정 시도 기록으로 마친다, BUILD_ORDER BOT-020).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction } from '@peaket/platform';
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { HoldRow, PidRotationRecord, PidRotationStore, VerificationStore, VerificationTx } from '../../domain/ports.js';
import { type Attempt, CiAlreadyLinked, plusOneYear, VerificationRaced } from '../../domain/verification.js';
import { identityConflictAttempt, identityVerification, pidKeyRotation, restrictedCiHold, verificationAttempt, verificationRecord } from './schema.js';

type Row = typeof verificationAttempt.$inferSelect;
const holdOf = (r: typeof restrictedCiHold.$inferSelect): HoldRow => ({
  ciHmac: r.ciHmac,
  ciHmacKeyVersion: r.ciHmacKeyVersion,
  fraudCaseId: r.fraudCaseId,
  state: r.state as HoldRow['state'],
  until: r.until.getTime(),
  sourceAccountId: r.sourceAccountId,
  carriedAccountId: r.carriedAccountId,
  version: r.version,
});
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
export class DrizzleVerificationStore implements VerificationStore, PidRotationStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  transaction<T>(fn: (tx: VerificationTx) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(this.#tx(tx)));
  }

  #tx(tx: DbTransaction): VerificationTx {
    return {
      setPhoneRef: async (i) => {
        // 조사용 연락처 가명 표는 세션 컨텍스트의 표다(같은 DB, 같은 트랜잭션). 원문 번호는 두지 않는다(BOT-045)
        await tx.execute(sql`
          insert into account_contact_ref (account_id, kind, ref, ref_prev, updated_at) values (${i.accountId}, 'PHONE', ${i.ref}, ${i.refPrev ?? null}, ${new Date(i.now)})
          on conflict (account_id, kind) do update set ref = excluded.ref, updated_at = excluded.updated_at,
            ref_prev = ${typeof i.refPrev === 'string' ? sql`excluded.ref_prev` : i.refPrev === null ? sql`account_contact_ref.ref_prev` : sql`case when split_part(account_contact_ref.ref, '.', 1) <> split_part(excluded.ref, '.', 1) then account_contact_ref.ref else account_contact_ref.ref_prev end`}`);
      },
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
      holdBySource: async (accountId, caseId) => {
        const [r] = await tx.select().from(restrictedCiHold).where(and(eq(restrictedCiHold.sourceAccountId, accountId), eq(restrictedCiHold.fraudCaseId, caseId))).for('update');
        return r ? holdOf(r) : null;
      },
      upsertHold: async (h) => {
        const v = { ciHmac: h.ciHmac, ciHmacKeyVersion: h.ciHmacKeyVersion, fraudCaseId: h.fraudCaseId, state: h.state, until: new Date(h.until), sourceAccountId: h.sourceAccountId, carriedAccountId: h.carriedAccountId, version: h.version };
        await tx
          .insert(restrictedCiHold)
          .values(v)
          .onConflictDoUpdate({ target: [restrictedCiHold.sourceAccountId, restrictedCiHold.fraudCaseId], set: { ciHmac: v.ciHmac, ciHmacKeyVersion: v.ciHmacKeyVersion, state: v.state, until: v.until, version: v.version } });
      },
      deleteHold: async (sourceAccountId, caseId) => {
        await tx.delete(restrictedCiHold).where(and(eq(restrictedCiHold.sourceAccountId, sourceAccountId), eq(restrictedCiHold.fraudCaseId, caseId)));
      },
      carryHolds: async (hmacs, accountId, now) => {
        if (hmacs.length === 0) return;
        await tx
          .update(restrictedCiHold)
          .set({ carriedAccountId: accountId })
          // 처음 계정의 다시 본인확인은 잇지 않는다(새 맥락 리뷰 M1)
          .where(and(inArray(restrictedCiHold.ciHmac, [...hmacs]), gt(restrictedCiHold.until, new Date(now)), ne(restrictedCiHold.sourceAccountId, accountId)));
      },
      lockAccountForShare: async (accountId) => {
        // 계정 표는 세션 컨텍스트의 표다. 같은 DB의 같은 트랜잭션에서 상태만 읽고 공유 잠금을 건다(탈퇴의 FOR UPDATE와 순서를 맞춘다)
        const r = await tx.execute(sql`select status from account where id = ${accountId} for share`);
        const row = r.rows[0] as { status?: unknown } | undefined;
        return typeof row?.status === 'string' ? row.status : null;
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
    // 보관 행이 쓰는 판도 센다(새 맥락 리뷰 L3)
    const held = await this.database.db.selectDistinct({ v: restrictedCiHold.ciHmacKeyVersion }).from(restrictedCiHold);
    return [...new Set([...rows, ...held].map((r) => r.v))].sort((a, b) => a - b);
  }

  async claimsOf(accountId: string): Promise<{ pid: string; pidPrev?: string } | null> {
    const [r] = await this.database.db
      .select({ pid: identityVerification.pid, pidPrev: identityVerification.pidPrev })
      .from(identityVerification)
      .where(eq(identityVerification.accountId, accountId));
    if (!r) return null;
    return { pid: r.pid.toString('base64url'), ...(r.pidPrev ? { pidPrev: r.pidPrev.toString('base64url') } : {}) };
  }

  async eraseAccount(accountId: string, now: number): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [v] = await tx
        .select({ sourceRecord: identityVerification.sourceRecord, verifiedAt: identityVerification.verifiedAt })
        .from(identityVerification)
        .where(eq(identityVerification.accountId, accountId))
        .for('update');
      if (v && plusOneYear(v.verifiedAt.getTime()) > now) {
        await tx
          .insert(verificationRecord)
          .values({ accountId, sourceRecord: v.sourceRecord, verifiedAt: v.verifiedAt, movedAt: new Date(now), deleteAt: new Date(plusOneYear(v.verifiedAt.getTime())) })
          .onConflictDoNothing({ target: verificationRecord.accountId });
      }
      const gone = await tx.delete(identityVerification).where(eq(identityVerification.accountId, accountId)).returning({ id: identityVerification.accountId });
      const attempts = await tx
        .delete(verificationAttempt)
        .where(and(eq(verificationAttempt.accountId, accountId), ne(verificationAttempt.status, 'UNDER_14')))
        .returning({ id: verificationAttempt.id });
      return gone.length + attempts.length > 0;
    });
  }

  async activeHoldsOf(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number }[]> {
    const rows = await this.database.db
      .select({ state: restrictedCiHold.state, until: restrictedCiHold.until })
      .from(restrictedCiHold)
      .where(and(gt(restrictedCiHold.until, new Date(now)), or(eq(restrictedCiHold.sourceAccountId, accountId), eq(restrictedCiHold.carriedAccountId, accountId))));
    return rows.map((r) => ({ state: r.state as 'CASE_OPEN' | 'RESTRICTED', until: r.until.getTime() }));
  }

  async restrictedUntilOf(accountId: string, now: number): Promise<number | null> {
    const [r] = await this.database.db
      .select({ until: sql<Date | null>`max(${restrictedCiHold.until})` })
      .from(restrictedCiHold)
      .where(and(eq(restrictedCiHold.carriedAccountId, accountId), eq(restrictedCiHold.state, 'RESTRICTED'), gt(restrictedCiHold.until, new Date(now))));
    return r?.until ? new Date(r.until).getTime() : null;
  }

  async purgeExpiredHolds(now: number): Promise<number> {
    const gone = await this.database.db.delete(restrictedCiHold).where(lte(restrictedCiHold.until, new Date(now))).returning({ id: restrictedCiHold.fraudCaseId });
    return gone.length;
  }

  async purgeVerificationRecords(now: number): Promise<number> {
    const gone = await this.database.db.delete(verificationRecord).where(lte(verificationRecord.deleteAt, new Date(now))).returning({ id: verificationRecord.accountId });
    return gone.length;
  }

  // pid 키 전환(identity §5 'pid 키 전환의 첫 구현'). 운영자가 한 번 띄우는 작업만 부른다. 표를 다 읽는 질의는 그 작업에서만이다 [가정]
  async pidKeyVersionsInUse(): Promise<number[]> {
    const rows = await this.database.db.selectDistinct({ v: identityVerification.pidKeyVersion }).from(identityVerification);
    return rows.map((r) => r.v).sort((a, b) => a - b);
  }

  async openPidRotation(): Promise<PidRotationRecord | null> {
    const [r] = await this.database.db.select().from(pidKeyRotation).where(isNull(pidKeyRotation.finishedAt));
    if (!r) return null;
    return {
      toVersion: r.toVersion,
      startedAt: r.startedAt.getTime(),
      transitionEndsAt: r.transitionEndsAt.getTime(),
      movedAt: r.movedAt === null ? null : r.movedAt.getTime(),
      finishedAt: null,
    };
  }

  async beginPidRotation(r: { toVersion: number; startedAt: number; transitionEndsAt: number }): Promise<void> {
    await this.database.db.insert(pidKeyRotation).values({ toVersion: r.toVersion, startedAt: new Date(r.startedAt), transitionEndsAt: new Date(r.transitionEndsAt) });
  }

  async pidRowsToMove(version: number, after: string, limit: number): Promise<{ accountId: string; ciHmac: Buffer }[]> {
    const below = and(lt(identityVerification.pidKeyVersion, version), isNull(identityVerification.pidPrev));
    return this.database.db
      .select({ accountId: identityVerification.accountId, ciHmac: identityVerification.ciHmac })
      .from(identityVerification)
      .where(after ? and(below, gt(identityVerification.accountId, after)) : below)
      .orderBy(asc(identityVerification.accountId))
      .limit(limit);
  }

  async movePid(accountId: string, pid: Buffer, version: number): Promise<boolean> {
    const rows = await this.database.db
      .update(identityVerification)
      .set({ pidPrev: sql`${identityVerification.pid}`, pid, pidKeyVersion: version })
      .where(and(eq(identityVerification.accountId, accountId), lt(identityVerification.pidKeyVersion, version), isNull(identityVerification.pidPrev)))
      .returning({ id: identityVerification.accountId });
    return rows.length > 0;
  }

  async pidRowsBelow(version: number): Promise<number> {
    const [r] = await this.database.db.select({ n: count() }).from(identityVerification).where(lt(identityVerification.pidKeyVersion, version));
    return r?.n ?? 0;
  }

  async markPidMoved(version: number, at: number): Promise<void> {
    await this.database.db.update(pidKeyRotation).set({ movedAt: new Date(at) }).where(and(eq(pidKeyRotation.toVersion, version), isNull(pidKeyRotation.finishedAt)));
  }

  async clearPidPrev(limit: number): Promise<number> {
    const some = this.database.db.select({ id: identityVerification.accountId }).from(identityVerification).where(isNotNull(identityVerification.pidPrev)).limit(limit);
    const rows = await this.database.db.update(identityVerification).set({ pidPrev: null }).where(inArray(identityVerification.accountId, some)).returning({ id: identityVerification.accountId });
    return rows.length;
  }

  async finishPidRotation(version: number, at: number): Promise<void> {
    await this.database.db.update(pidKeyRotation).set({ finishedAt: new Date(at) }).where(and(eq(pidKeyRotation.toVersion, version), isNull(pidKeyRotation.finishedAt)));
  }
}
