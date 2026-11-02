// PostgreSQL 저장소(Drizzle). 같은 멱등 키의 CreateSession은 트랜잭션 잠금(pg_advisory_xact_lock)으로 한 번에 하나만 돈다.
// 그래서 데드라인 뒤 다시 보낸 요청이 먼저 온 요청과 겹쳐도 세션·기기 행은 한 번만 생긴다(I-T50 ①).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction, uuidv7 } from '@peaket/platform';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { CreateKeyRecord, SessionRow, SessionStore, SessionTx } from '../../domain/ports.js';
import { CREATE_KEY_TTL_MS, type Provider } from '../../domain/session.js';
import { account, accountProvider, device, session, sessionCreateKey } from './schema.js';

const date = (ms: number) => new Date(ms);
const ms = (d: Date | null) => (d === null ? null : d.getTime());

@Injectable()
export class DrizzleSessionStore implements SessionStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(this.#tx(tx)));
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
      createAccount: async ({ id, email }, now) => {
        await tx.insert(account).values({ id, status: 'ACTIVE', email, createdAt: date(now) });
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
      terminateSessions: async (ids, now) => {
        for (const id of ids) await tx.update(session).set({ terminatedAt: date(now) }).where(and(eq(session.id, id), isNull(session.terminatedAt)));
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
        return r
          ? {
              id: r.id,
              accountId: r.accountId,
              deviceId: r.deviceId,
              absoluteExpiresAt: r.absoluteExpiresAt.getTime(),
              idleExpiresAt: r.idleExpiresAt.getTime(),
              terminatedAt: ms(r.terminatedAt),
              loginVerdict: r.loginVerdict as SessionRow['loginVerdict'],
            }
          : null;
      },
      setRefreshHash: async (sessionId, hash) => {
        await tx.update(session).set({ refreshHash: Buffer.from(hash) }).where(eq(session.id, sessionId));
      },
    };
  }
}
