// PostgreSQL 저장소(Drizzle). 같은 멱등 키의 CreateSession은 트랜잭션 잠금(pg_advisory_xact_lock)으로 한 번에 하나만 돈다.
// 그래서 데드라인 뒤 다시 보낸 요청이 먼저 온 요청과 겹쳐도 세션·기기 행은 한 번만 생긴다(I-T50 ①).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, CONTROL_TOPICS, DATABASE, type Database, type DbTransaction, uuidv7, writeOutbox } from '@peaket/platform';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { accountWithdrawnMessage } from '../account-withdrawn-message.js';
import type { AccountStatus, CreateKeyRecord, RefreshRow, SessionRow, SessionStore, SessionTx } from '../../domain/ports.js';
import { CREATE_KEY_TTL_MS, type LoginVerdict, type Provider } from '../../domain/session.js';
import { account, accountProvider, device, reauthTokenUse, refreshTokenHash, session, sessionCreateKey } from './schema.js';

const date = (ms: number) => new Date(ms);
const ms = (d: Date | null) => (d === null ? null : d.getTime());
type SessionRecord = typeof session.$inferSelect;
const rowOf = (r: SessionRecord): SessionRow => ({
  id: r.id,
  accountId: r.accountId,
  deviceId: r.deviceId,
  absoluteExpiresAt: r.absoluteExpiresAt.getTime(),
  idleExpiresAt: r.idleExpiresAt.getTime(),
  terminatedAt: ms(r.terminatedAt),
  loginVerdict: r.loginVerdict as LoginVerdict,
  refreshFamily: r.refreshFamily,
});

@Injectable()
export class DrizzleSessionStore implements SessionStore {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    /** Outbox 행 ID(UUIDv7, 일 파티션)의 시계 */
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(this.#tx(tx)));
  }

  async purgeExpiredRefreshHashes(now: number, signal?: AbortSignal): Promise<number> {
    // 절대 만료가 지났거나, 세션이 끝났거나 유휴 만료가 지난 줄(정비 refresh-hash-expired, R-255). 한 번에 1,000줄 [가정]씩
    let total = 0;
    for (;;) {
      const r = await this.database.db.execute(sql`
        delete from refresh_token_hash where hash in (
          select h.hash from refresh_token_hash h join session s on s.id = h.session_id
          where h.expires_at <= ${date(now)} or s.terminated_at is not null or s.idle_expires_at <= ${date(now)} or s.absolute_expires_at <= ${date(now)}
          limit 1000)`);
      const n = r.rowCount ?? 0;
      total += n;
      if (n < 1000 || signal?.aborted) return total;
    }
  }

  async purgeReauthUses(now: number): Promise<number> {
    const gone = await this.database.db.delete(reauthTokenUse).where(lte(reauthTokenUse.expiresAt, date(now))).returning({ jti: reauthTokenUse.jti });
    return gone.length;
  }

  #tx(tx: DbTransaction): SessionTx {
    return {
      lockCreateKey: async (key, now): Promise<CreateKeyRecord | null> => {
        // 같은 키는 커밋·되돌림까지 기다린다(키 문자열의 64비트 해시로 잠근다. 해시가 겹치면 서로 기다릴 뿐 결과는 같다)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`session_create_key:${key}`}, 0))`);
        const [row] = await tx.select().from(sessionCreateKey).where(eq(sessionCreateKey.key, key));
        if (!row) return null;
        if (now - row.createdAt.getTime() >= CREATE_KEY_TTL_MS) {
          await tx.delete(sessionCreateKey).where(eq(sessionCreateKey.key, key));
          return null;
        }
        return { provider: row.provider as Provider, providerUserId: row.providerUserId, sessionId: row.sessionId, newAccount: row.newAccount };
      },
      saveCreateKey: async (key, rec, now) => {
        // 지난 기록은 넣을 때 조금씩 지운다(이 표는 10분 [가정]만 기억한다)
        await tx.execute(sql`delete from session_create_key where key in (select key from session_create_key where created_at < ${date(now - CREATE_KEY_TTL_MS)} limit 100)`);
        await tx.insert(sessionCreateKey).values({ key, provider: rec.provider, providerUserId: rec.providerUserId, sessionId: rec.sessionId, newAccount: rec.newAccount, createdAt: date(now) });
      },
      lockProvider: async (provider, providerUserId) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account_provider:${provider}:${providerUserId}`}, 0))`);
      },
      lockAccount: async (accountId) => {
        await tx.execute(sql`select 1 from account where id = ${accountId} for update`);
      },
      findAccountByProvider: async (provider, providerUserId) => {
        const [row] = await tx
          .select({ id: account.id, status: account.status })
          .from(accountProvider)
          .innerJoin(account, eq(account.id, accountProvider.accountId))
          .where(and(eq(accountProvider.provider, provider), eq(accountProvider.providerUserId, providerUserId)));
        return row ? { id: row.id, status: row.status as 'ACTIVE' } : null;
      },
      createAccount: async ({ id, email, emailVerified }, now) => {
        await tx.insert(account).values({ id, status: 'ACTIVE', email, emailVerified: emailVerified === true, createdAt: date(now) });
      },
      findLinkTargets: async (email) => {
        // 지금은 계정 표를 훑는다. 활성·검증 계정의 이메일 인덱스는 트랜잭션 밖 인덱스 파일을 돌리는 실행기(BAS-060) 뒤에 더한다(identity §2.1)
        const rows = await tx
          .select({ id: account.id })
          .from(account)
          .where(and(eq(account.status, 'ACTIVE'), eq(account.emailVerified, true), sql`lower(btrim(${account.email})) = ${email}`))
          .orderBy(asc(account.id))
          .limit(2);
        const out: { accountId: string; providers: Provider[] }[] = [];
        for (const r of rows) {
          const ps = await tx
            .select({ provider: accountProvider.provider })
            .from(accountProvider)
            .where(eq(accountProvider.accountId, r.id))
            .orderBy(asc(accountProvider.linkedAt), asc(accountProvider.provider));
          out.push({ accountId: r.id, providers: ps.map((p) => p.provider as Provider) });
        }
        return out;
      },
      linkProvider: async (accountId, provider, providerUserId, now) => {
        await tx.insert(accountProvider).values({ accountId, provider, providerUserId, linkedAt: date(now) });
      },
      isProviderLinked: async (accountId, provider, providerUserId) => {
        const [row] = await tx
          .select({ a: accountProvider.accountId })
          .from(accountProvider)
          .where(and(eq(accountProvider.provider, provider), eq(accountProvider.providerUserId, providerUserId), eq(accountProvider.accountId, accountId)));
        return Boolean(row);
      },
      providersOf: async (accountId) =>
        (
          await tx
            .select({ provider: accountProvider.provider, linkedAt: accountProvider.linkedAt })
            .from(accountProvider)
            .where(eq(accountProvider.accountId, accountId))
            .orderBy(asc(accountProvider.linkedAt))
        ).map((r) => ({ provider: r.provider as Provider, linkedAt: r.linkedAt.getTime() })),
      bindDevice: async (accountId, deviceRef, now) => {
        const [made] = await tx
          .insert(device)
          .values({ id: uuidv7({ now: () => now, monotonicMs: () => 0 }), accountId, deviceRef, boundAt: date(now) })
          .onConflictDoNothing({ target: [device.accountId, device.deviceRef] })
          .returning({ id: device.id });
        if (made) return made.id;
        const [found] = await tx.select({ id: device.id }).from(device).where(and(eq(device.accountId, accountId), eq(device.deviceRef, deviceRef)));
        return found!.id;
      },
      activeSessions: async (accountId, now) => {
        const rows = await tx
          .select({ id: session.id, deviceId: session.deviceId, idle: session.idleExpiresAt })
          .from(session)
          .where(and(eq(session.accountId, accountId), isNull(session.terminatedAt), gt(session.absoluteExpiresAt, date(now)), gt(session.idleExpiresAt, date(now))))
          .for('update');
        return rows.map((r) => ({ sessionId: r.id, deviceId: r.deviceId, idleExpiresAt: r.idle.getTime() }));
      },
      unterminatedSessions: async (accountId) =>
        (await tx.select({ id: session.id }).from(session).where(and(eq(session.accountId, accountId), isNull(session.terminatedAt))).for('update')).map((r) => r.id),
      closureReasonOf: async (accountId) => {
        const [r] = await tx.select({ status: account.status, reason: account.closureReason }).from(account).where(eq(account.id, accountId));
        return r && r.status === 'WITHDRAWAL_PENDING' && r.reason === 'UNDER_14' ? 'UNDER_14' : null;
      },
      markClosure: async (accountId, reason, now) => {
        await tx
          .update(account)
          .set({ status: 'WITHDRAWAL_PENDING', closureReason: reason, closureStartedAt: date(now) })
          .where(and(eq(account.id, accountId), eq(account.status, 'ACTIVE')));
      },
      accountStatusOf: async (accountId) => {
        const [r] = await tx.select({ status: account.status }).from(account).where(eq(account.id, accountId));
        return r ? (r.status as AccountStatus) : null;
      },
      eraseAccount: async (accountId, now) => {
        // 프로필 칸을 비우고 DELETED로. 회원 코드도 비운다(UNIQUE). 계정 행과 ID는 다른 서비스의 법정 기록이 잇는 값이라 남긴다(docs/data.md §6)
        await tx
          .update(account)
          .set({ status: 'DELETED', deletedAt: date(now), nickname: null, email: null, emailVerified: false, phone: null, memberCode: null, savedBookerName: null, savedBookerPhone: null, closureReason: null, closureStartedAt: null })
          .where(eq(account.id, accountId));
        await tx.delete(accountProvider).where(eq(accountProvider.accountId, accountId));
        await tx.delete(device).where(eq(device.accountId, accountId));
        await tx.execute(sql`delete from session_create_key where session_id in (select id from session where account_id = ${accountId})`);
      },
      closuresStartedBefore: async (before, limit) =>
        (
          await tx
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.status, 'WITHDRAWAL_PENDING'), eq(account.closureReason, 'UNDER_14'), lte(account.closureStartedAt, date(before))))
            .orderBy(asc(account.closureStartedAt))
            .limit(limit)
        ).map((r) => r.id),
      deletedSince: async (since, after, limit) =>
        (
          await tx
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.status, 'DELETED'), gt(account.deletedAt, date(since)), after ? gt(account.id, after) : undefined))
            .orderBy(asc(account.id))
            .limit(limit)
        ).map((r) => r.id),
      activeHoldOf: async (accountId, now) => {
        // 대조값 보관 표는 본인확인 컨텍스트의 표다. 같은 트랜잭션에서 상태와 끝만 읽는다(두 번째 연결을 빌리지 않게, 다시 보기 낮음)
        const r = await tx.execute(sql`
          select state, until from restricted_ci_hold
          where until > ${date(now)} and (source_account_id = ${accountId} or carried_account_id = ${accountId})
          order by (state = 'RESTRICTED') desc, until desc limit 1`);
        const row = r.rows[0] as { state?: unknown; until?: unknown } | undefined;
        if (!row || (row.state !== 'CASE_OPEN' && row.state !== 'RESTRICTED')) return null;
        return { state: row.state, until: new Date(row.until as string | Date).getTime() };
      },
      useReauth: async (r) => {
        const made = await tx
          .insert(reauthTokenUse)
          .values({ jti: r.jti, accountId: r.accountId, usedAt: date(r.usedAt), expiresAt: date(r.expiresAt) })
          .onConflictDoNothing({ target: reauthTokenUse.jti })
          .returning({ jti: reauthTokenUse.jti });
        return made.length > 0;
      },
      terminateSessions: async (ids, reason, now) => {
        if (ids.length === 0) return;
        const ended = await tx
          .update(session)
          .set({ terminatedAt: date(now) })
          .where(and(inArray(session.id, [...ids]), isNull(session.terminatedAt)))
          .returning({ id: session.id, accountId: session.accountId });
        // 끝난 세션의 리프레시 토큰 해시는 같은 트랜잭션에서 지운다(R-255, docs/data.md refresh_token_hash)
        await tx.delete(refreshTokenHash).where(inArray(refreshTokenHash.sessionId, [...ids]));
        // 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다(ADR-0143 결정 3). 값은 공용 Avro 인코더(BUILD_ORDER BAS-030) 전까지 JSON이다
        const terminatedAt = date(now).toISOString();
        await writeOutbox(
          tx,
          this.clock,
          ended
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((e) => ({
              topic: CONTROL_TOPICS.sessionsTerminated,
              // asyncapi control.sessions-terminated: 키 = accountId(같은 계정의 사건은 같은 파티션에 순서대로)
              key: e.accountId,
              payload: Buffer.from(JSON.stringify({ accountId: e.accountId, sessionId: e.id, reason, terminatedAt })),
            })),
        );
      },
      recordWithdrawn: async (i) => {
        // 세션 종료 사건 뒤, 트랜잭션의 마지막 쓰기로 탈퇴 사건을 적는다(BOT-037, ADR-0143 결정 3)
        await writeOutbox(tx, this.clock, [accountWithdrawnMessage({ eventKey: uuidv7(this.clock), ...i })]);
      },
      insertSession: async (r) => {
        await tx.insert(session).values({
          id: r.id,
          accountId: r.accountId,
          deviceId: r.deviceId,
          refreshHash: Buffer.from(r.refreshHash),
          refreshFamily: r.refreshFamily,
          absoluteExpiresAt: date(r.absoluteExpiresAt),
          idleExpiresAt: date(r.idleExpiresAt),
          loginVerdict: r.loginVerdict,
          loginVerdictAt: date(r.createdAt),
        });
      },
      getSessionForUpdate: async (id): Promise<SessionRow | null> => {
        const [r] = await tx.select().from(session).where(eq(session.id, id)).for('update');
        return r ? rowOf(r) : null;
      },
      setRefreshHash: async (sessionId, hash) => {
        await tx.update(session).set({ refreshHash: Buffer.from(hash) }).where(eq(session.id, sessionId));
      },
      rotateRefresh: async (sessionId, hash, now, idleExpiresAt) => {
        await tx
          .update(session)
          .set({ prevRefreshHash: sql`${session.refreshHash}`, refreshHash: Buffer.from(hash), rotatedAt: date(now), refreshUsed: false, idleExpiresAt: date(idleExpiresAt) })
          .where(eq(session.id, sessionId));
      },
      recordRefreshHash: async (r) => {
        await tx.insert(refreshTokenHash).values({ hash: Buffer.from(r.hash), sessionId: r.sessionId, refreshFamily: r.refreshFamily, issuedAt: date(r.issuedAt), expiresAt: date(r.expiresAt) });
      },
      findByRefreshHash: async (hash): Promise<RefreshRow | null> => {
        const h = Buffer.from(hash);
        const [cur] = await tx
          .select()
          .from(session)
          .where(or(eq(session.refreshHash, h), eq(session.prevRefreshHash, h)))
          .for('update');
        const past = cur ? undefined : (await tx.select({ sessionId: refreshTokenHash.sessionId }).from(refreshTokenHash).where(eq(refreshTokenHash.hash, h)))[0];
        const r = cur ?? (past ? (await tx.select().from(session).where(eq(session.id, past.sessionId)).for('update'))[0] : undefined);
        if (!r) return null;
        const match = cur ? (Buffer.from(cur.refreshHash).equals(h) ? 'current' : 'previous') : 'history';
        return { ...rowOf(r), match, rotatedAt: ms(r.rotatedAt), refreshUsed: r.refreshUsed };
      },
      familySessions: async (refreshFamily) =>
        (await tx.select({ id: session.id }).from(session).where(and(eq(session.refreshFamily, refreshFamily), isNull(session.terminatedAt)))).map((x) => x.id),
    };
  }
}
