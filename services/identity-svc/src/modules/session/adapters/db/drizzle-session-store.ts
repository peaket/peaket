// PostgreSQL 저장소(Drizzle). 같은 멱등 키의 CreateSession은 트랜잭션 잠금(pg_advisory_xact_lock)으로 한 번에 하나만 돈다.
// 그래서 데드라인 뒤 다시 보낸 요청이 먼저 온 요청과 겹쳐도 세션·기기 행은 한 번만 생긴다(I-T50 ①).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, CONTROL_TOPICS, DATABASE, type Database, type DbTransaction, uuidv7, writeOutbox } from '@peaket/platform';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { accountWithdrawnMessage } from '../account-withdrawn-message.js';
import { loginMethodChangedMessage } from '../login-method-message.js';
import { accountMergedMessage } from '../account-merged-message.js';
import type { AccountStatus, ContactKind, CreateKeyRecord, InvestigationRefsRow, RefreshRow, SessionRow, SessionStore, SessionTx } from '../../domain/ports.js';
import { CREATE_KEY_TTL_MS, type LiveSession, type LoginVerdict, type Provider, type TerminationReason } from '../../domain/session.js';
import { account, accountContactRef, accountHold, accountMerge, accountProvider, device, reauthTokenUse, refreshTokenHash, session, sessionCreateKey } from './schema.js';

/** 연락처 행을 다시 쓸 때의 옛 판 값(domain/inv-ref.ts nextRefPrev와 같은 규칙, BOT-046) */
const refPrevSql = (given: string | null | undefined) =>
  typeof given === 'string'
    ? sql`${given}`
    : given === null
      ? sql`account_contact_ref.ref_prev`
      : sql`case when split_part(account_contact_ref.ref, '.', 1) <> split_part(excluded.ref, '.', 1) then account_contact_ref.ref else account_contact_ref.ref_prev end`;
const date = (ms: number) => new Date(ms);

/**
 * 조사용 연락처 가명 행(account_contact_ref, 세션 컨텍스트의 표)을 그 트랜잭션에서 쓴다. 본인확인 저장소도 번호 가명을 이것으로 쓴다
 * (같은 DB·같은 트랜잭션. 표가 바뀌면 형 검사가 잡는다, BOT-045가 넘긴 것). refPrev: 문자면 그 값, null이면 그대로, 없으면 판이 바뀔 때 옛 값
 */
export async function writeContactRef(tx: DbTransaction, i: { accountId: string; kind: ContactKind; ref: string; refPrev?: string | null; now: number }): Promise<void> {
  await tx
    .insert(accountContactRef)
    .values({ accountId: i.accountId, kind: i.kind, ref: i.ref, refPrev: i.refPrev ?? null, updatedAt: date(i.now) })
    .onConflictDoUpdate({ target: [accountContactRef.accountId, accountContactRef.kind], set: { ref: i.ref, refPrev: refPrevSql(i.refPrev), updatedAt: date(i.now) } });
}
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

  async refreshOwner(hash: Uint8Array): Promise<string | null> {
    const h = Buffer.from(hash);
    const [r] = await this.database.db
      .select({ accountId: session.accountId })
      .from(session)
      .where(or(eq(session.refreshHash, h), eq(session.prevRefreshHash, h)))
      .limit(1);
    return r?.accountId ?? null;
  }

  async sessionOf(id: string): Promise<SessionRow | null> {
    const [r] = await this.database.db.select().from(session).where(eq(session.id, id));
    return r ? rowOf(r) : null;
  }

  async liveSessionsOf(accountId: string, now: number): Promise<LiveSession[]> {
    // 끝나지 않은 그 계정의 세션 부분 인덱스(session_account_active_idx)로 찾는다. 마지막 활동이 비었으면(마이그레이션 0028 전) 회전 시각, 없으면 로그인 시각(ADR-0209 결정 2)
    const rows = await this.database.db
      .select({ id: session.id, deviceId: session.deviceId, label: session.deviceLabel, active: sql<Date>`coalesce(${session.lastActiveAt}, ${session.rotatedAt}, ${session.loginVerdictAt})` })
      .from(session)
      .where(and(eq(session.accountId, accountId), isNull(session.terminatedAt), gt(session.absoluteExpiresAt, date(now)), gt(session.idleExpiresAt, date(now))));
    return rows.map((r) => ({ sessionId: r.id, deviceId: r.deviceId, deviceLabel: r.label, lastActiveAt: r.active === null ? 0 : new Date(r.active).getTime() }));
  }

  async clearEndedDeviceLabels(now: number, signal?: AbortSignal): Promise<number> {
    // 절대 만료가 지난 세션의 기기 이름을 1,000줄 [가정]씩 비운다(부분 인덱스 session_device_label_expiry_idx를 앞에서부터 읽는다, ADR-0209 결정 1)
    let total = 0;
    for (;;) {
      const r = await this.database.db.execute(sql`
        update session set device_label = null where id in (
          select id from session where device_label is not null and absolute_expires_at <= ${date(now)} order by absolute_expires_at limit 1000)`);
      const n = r.rowCount ?? 0;
      total += n;
      if (n < 1000 || signal?.aborted) return total;
    }
  }

  async purgeReauthUses(now: number): Promise<number> {
    const gone = await this.database.db.delete(reauthTokenUse).where(lte(reauthTokenUse.expiresAt, date(now))).returning({ jti: reauthTokenUse.jti });
    return gone.length;
  }

  async investigationRefsOf(accountIds: readonly string[], since: number): Promise<InvestigationRefsRow[]> {
    if (accountIds.length === 0) return [];
    const db = this.database.db;
    const ids = [...accountIds];
    const found = await db.select({ id: account.id, status: account.status }).from(account).where(inArray(account.id, ids));
    const live = new Set(found.filter((a) => a.status !== 'DELETED').map((a) => a.id));
    const present = new Set(found.map((a) => a.id));
    const list = sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `);
    const [contacts, devices, conflicts] = await Promise.all([
      db.select({ accountId: accountContactRef.accountId, kind: accountContactRef.kind, ref: accountContactRef.ref, refPrev: accountContactRef.refPrev }).from(accountContactRef).where(inArray(accountContactRef.accountId, ids)),
      db.select({ accountId: device.accountId, ref: device.deviceRef, prev: device.deviceRefPrev }).from(device).where(inArray(device.accountId, ids)).orderBy(asc(device.boundAt), asc(device.id)),
      // 같은 본인확인 시도 기록은 본인확인 컨텍스트의 표다(같은 DB, 읽기만). 이 계정이 시도했으면 원래 계정, 원래 계정이면 시도한 계정을 상대로 준다
      db.execute(sql`
        select attempted_account_id as a, existing_account_id as e, attempted_at as t from identity_conflict_attempt
        where attempted_at > ${date(since)} and (attempted_account_id in (${list}) or existing_account_id in (${list}))
        order by attempted_at asc`),
    ]);
    const order: readonly ContactKind[] = ['PHONE', 'EMAIL'];
    return ids
      .filter((id) => present.has(id))
      .map((id) => {
        // 탈퇴한 계정은 연결 값을 지웠다(남은 행이 있어도 싣지 않는다)
        if (!live.has(id)) return { accountId: id, contactRefs: [], deviceRefs: [], identityConflicts: [] };
        return {
          accountId: id,
          // 키 회전의 이음 동안 남은 옛 판 값도 함께 싣는다(값마다 판 접두어가 있어 조사 적재가 가른다, BOT-046)
          contactRefs: contacts
            .filter((c) => c.accountId === id)
            .sort((x, y) => order.indexOf(x.kind as ContactKind) - order.indexOf(y.kind as ContactKind))
            .flatMap((c) => [{ kind: c.kind as ContactKind, ref: c.ref }, ...(c.refPrev ? [{ kind: c.kind as ContactKind, ref: c.refPrev }] : [])]),
          deviceRefs: [...devices.filter((d) => d.accountId === id).map((d) => d.ref), ...devices.filter((d) => d.accountId === id && d.prev).map((d) => d.prev!)],
          identityConflicts: (conflicts.rows as { a: string; e: string; t: string | Date }[])
            .filter((r) => r.a === id || r.e === id)
            .map((r) => ({ otherAccountId: r.a === id ? r.e : r.a, attemptedAt: new Date(r.t).getTime() })),
        };
      });
  }

  async contactRefsToRotate(after: string, writePrefix: string, limit: number): Promise<{ accountId: string; email: string; ref: string }[]> {
    const rows = await this.database.db.execute(sql`
      select c.account_id, a.email, c.ref from account_contact_ref c join account a on a.id = c.account_id
      where c.kind = 'EMAIL' and left(c.ref, ${writePrefix.length}) <> ${writePrefix} and a.status = 'ACTIVE' and a.email is not null
        ${after ? sql`and c.account_id > ${after}::uuid` : sql``}
      order by c.account_id limit ${limit}`);
    return (rows.rows as { account_id: string; email: string; ref: string }[]).map((r) => ({ accountId: r.account_id, email: r.email, ref: r.ref }));
  }

  async closeInvRefBridge(label: 'device' | 'contact', prevPrefix: string, chunk = 1_000): Promise<{ cleared: number; removed: number }> {
    // 묶음씩 끝까지(한 트랜잭션에 몇백만 행을 쥐지 않게, 다른 정비처럼)
    const db = this.database.db;
    const loop = async (q: () => Promise<number>) => {
      let n = 0;
      for (;;) {
        const k = await q();
        n += k;
        if (k < chunk) return n;
      }
    };
    if (label === 'contact') {
      const cleared = await loop(async () => (await db.execute(sql`update account_contact_ref set ref_prev = null where (account_id, kind) in (select account_id, kind from account_contact_ref where ref_prev is not null limit ${chunk}) returning account_id`)).rows.length);
      return { cleared, removed: 0 };
    }
    const cleared = await loop(async () => (await db.execute(sql`update device set device_ref_prev = null where id in (select id from device where device_ref_prev is not null limit ${chunk}) returning id`)).rows.length);
    // 옛 판으로 남은 기기 행: 이음 기간에 다시 로그인하지 않은 기기(나중에 로그인하면 새 기기 알림이 한 번 간다)
    const removed = await loop(async () => (await db.execute(sql`delete from device where id in (select id from device where left(device_ref, ${prevPrefix.length}) = ${prevPrefix} limit ${chunk}) returning id`)).rows.length);
    return { cleared, removed };
  }

  async accountsMissingEmailRef(after: string, limit: number): Promise<{ accountId: string; email: string }[]> {
    const rows = await this.database.db.execute(sql`
      select a.id, a.email from account a
      where a.status = 'ACTIVE' and a.email is not null ${after ? sql`and a.id > ${after}::uuid` : sql``}
        and not exists (select 1 from account_contact_ref c where c.account_id = a.id and c.kind = 'EMAIL')
      order by a.id limit ${limit}`);
    return (rows.rows as { id: string; email: string }[]).map((r) => ({ accountId: r.id, email: r.email }));
  }

  #tx(tx: DbTransaction): SessionTx {
    /**
     * 세션 끝내기(사유가 섞여도 한 번): 끝난 시각과 기기 이름을 고치고 리프레시 토큰 해시를 지운 뒤, 마지막 쓰기로 세션 종료 사건을 적는다
     * (ADR-0143 결정 3, ADR-0116 결정 3, R-255, ADR-0209)
     */
    const endIn = async (items: ReadonlyArray<{ id: string; reason: TerminationReason }>, now: number): Promise<void> => {
      if (items.length === 0) return;
      const at = date(now);
      const ids = [...new Set(items.map((x) => x.id))];
      const reasonOf = new Map(items.map((x) => [x.id, x.reason]));
      const ended = await tx
        .update(session)
        // 끝난 세션의 화면용 기기 이름은 같은 트랜잭션에서 지운다(ADR-0209 결정 1)
        .set({ terminatedAt: at, deviceLabel: null })
        .where(and(inArray(session.id, ids), isNull(session.terminatedAt)))
        .returning({ id: session.id, accountId: session.accountId });
      // 끝난 세션의 리프레시 토큰 해시는 같은 트랜잭션에서 지운다(R-255, docs/data.md refresh_token_hash)
      await tx.delete(refreshTokenHash).where(inArray(refreshTokenHash.sessionId, ids));
      // 같은 트랜잭션의 마지막 쓰기로 세션 종료 사건을 적는다(ADR-0143 결정 3). 값은 공용 Avro 인코더(BUILD_ORDER BAS-030) 전까지 JSON이다
      const terminatedAt = at.toISOString();
      await writeOutbox(
        tx,
        this.clock,
        ended
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((e) => ({
            topic: CONTROL_TOPICS.sessionsTerminated,
            // asyncapi control.sessions-terminated: 키 = accountId(같은 계정의 사건은 같은 파티션에 순서대로)
            key: e.accountId,
            payload: Buffer.from(JSON.stringify({ accountId: e.accountId, sessionId: e.id, reason: reasonOf.get(e.id), terminatedAt })),
          })),
      );
    };
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
            .select({ provider: accountProvider.provider, linkedAt: accountProvider.linkedAt, lastLoginAt: accountProvider.lastLoginAt })
            .from(accountProvider)
            .where(eq(accountProvider.accountId, accountId))
            .orderBy(asc(accountProvider.linkedAt), asc(accountProvider.provider))
        ).map((r) => ({ provider: r.provider as Provider, linkedAt: r.linkedAt.getTime(), lastLoginAt: r.lastLoginAt ? r.lastLoginAt.getTime() : null })),
      touchProviderLogin: async (provider, providerUserId, now) => {
        await tx
          .update(accountProvider)
          .set({ lastLoginAt: date(now) })
          .where(and(eq(accountProvider.provider, provider), eq(accountProvider.providerUserId, providerUserId)));
      },
      unlinkProvider: async (accountId, provider) =>
        (await tx.delete(accountProvider).where(and(eq(accountProvider.accountId, accountId), eq(accountProvider.provider, provider))).returning({ a: accountProvider.accountId })).length,
      openHoldsOf: async (accountId) => {
        const [r] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(accountHold)
          .where(and(eq(accountHold.accountId, accountId), eq(accountHold.state, 'OPEN')));
        return r?.n ?? 0;
      },
      setAccountHold: async (i) => {
        // 없는 계정의 건은 외래키가 막는다. 쓰기 전에 보고 NOT_FOUND로 답한다(계정 행은 지우지 않으므로 본 뒤 사라지지 않는다, BOT-042가 넘긴 것)
        const [owner] = await tx.select({ id: account.id }).from(account).where(eq(account.id, i.accountId));
        if (!owner) return 'NOT_FOUND';
        const [h] = await tx.select().from(accountHold).where(eq(accountHold.sourceRef, i.sourceRef)).for('update');
        if (h && (h.accountId !== i.accountId || h.kind !== i.kind)) return 'CONFLICT';
        if (h && i.sourceVersion <= h.sourceVersion) return 'STALE';
        const row = { sourceRef: i.sourceRef, accountId: i.accountId, kind: i.kind, state: i.state, sourceVersion: i.sourceVersion, updatedAt: date(i.now) };
        // 같은 건의 처음 쓰기가 겹치면 기본 키가 한쪽을 막고, 늦은 쪽은 충돌 갱신으로 온다: 계정·종류가 같고 판이 클 때만 바꾸고(새 맥락 리뷰 낮음 11),
        // 바꾸지 않았으면 지금 행으로 STALE·CONFLICT를 가린다
        const done = await tx
          .insert(accountHold)
          .values(row)
          .onConflictDoUpdate({
            target: accountHold.sourceRef,
            set: { state: row.state, sourceVersion: row.sourceVersion, updatedAt: row.updatedAt },
            where: sql`${accountHold.sourceVersion} < ${i.sourceVersion} and ${accountHold.accountId} = ${i.accountId} and ${accountHold.kind} = ${i.kind}`,
          })
          .returning({ r: accountHold.sourceRef });
        if (done.length > 0) return 'APPLIED';
        const [cur] = await tx.select({ accountId: accountHold.accountId, kind: accountHold.kind }).from(accountHold).where(eq(accountHold.sourceRef, i.sourceRef));
        return cur && (cur.accountId !== i.accountId || cur.kind !== i.kind) ? 'CONFLICT' : 'STALE';
      },
      purgeClosedHolds: async (before) =>
        (await tx.delete(accountHold).where(and(eq(accountHold.state, 'CLOSED'), lte(accountHold.updatedAt, date(before)))).returning({ r: accountHold.sourceRef })).length,
      mergeAccounts: async (i) => {
        await tx.update(accountProvider).set({ accountId: i.primaryAccountId }).where(eq(accountProvider.accountId, i.absorbedAccountId));
        // 기기 행을 대표 계정으로 옮긴다(identity §9.1 '병합 때 기기 행', 소유자 결정 2026-11-05, OPEN[22] 추천 적용).
        // ① 키 회전의 이음 기간에 흡수 계정만 그 기기로 다시 로그인했으면 흡수 행이 새 판이다(흡수 행의 device_ref_prev가 대표 행의 device_ref). 대표 행이 그 새 판 짝을
        //    이어받는다(행 ID 그대로라 대표 계정 세션의 device_id가 이어진다). 대표 계정에 그 새 판 값의 행이 따로 있으면 바꾸지 않는다(UNIQUE (account_id, device_ref))
        await tx.execute(sql`
          update device p set device_ref = a.device_ref, device_ref_prev = a.device_ref_prev
          from device a
          where p.account_id = ${i.primaryAccountId} and a.account_id = ${i.absorbedAccountId} and a.device_ref_prev = p.device_ref
            and not exists (select 1 from device q where q.account_id = ${i.primaryAccountId} and q.device_ref = a.device_ref)`);
        // ② 대표 계정에 같은 기기가 있으면(옛 판 값까지 견준다. NULL은 IN에서 맞지 않는다) 흡수 쪽 행을 지운다: UNIQUE (account_id, device_ref)를 지키고 한 기기를 두 줄로 세지 않는다.
        //    대표 행이 같은 판이거나 더 새 판이면 대표 행 그대로다. 지운 행을 가리키던 흡수 계정 세션의 device_id는 외래키 ON DELETE SET NULL로 빈다(그 세션들은 이 트랜잭션에서 MERGED로 끝난다)
        await tx.execute(sql`
          delete from device a where a.account_id = ${i.absorbedAccountId} and exists (
            select 1 from device p where p.account_id = ${i.primaryAccountId}
              and (p.device_ref in (a.device_ref, a.device_ref_prev) or p.device_ref_prev in (a.device_ref, a.device_ref_prev)))`);
        // ③ 남은(대표 계정에 없는) 기기 행을 옮긴다
        await tx.update(device).set({ accountId: i.primaryAccountId }).where(eq(device.accountId, i.absorbedAccountId));
        await tx
          .update(account)
          // 흡수 계정의 프로필은 병합 즉시 파기한다(POL-034, data-classification, 새 맥락 리뷰 중간 2). 회원 코드도 비운다(UNIQUE)
          .set({ status: 'MERGED', mergedIntoAccountId: i.primaryAccountId, email: null, emailVerified: false, nickname: null, phone: null, memberCode: null, savedBookerName: null, savedBookerPhone: null })
          .where(eq(account.id, i.absorbedAccountId));
        // 흡수 계정의 연락처 가명도 지운다(프로필 파기, BOT-045)
        await tx.delete(accountContactRef).where(eq(accountContactRef.accountId, i.absorbedAccountId));
        // 병합 사슬을 한 단계로(흡수 계정을 가리키던 계정도 대표 계정으로, docs/data.md §4)
        await tx.update(account).set({ mergedIntoAccountId: i.primaryAccountId }).where(eq(account.mergedIntoAccountId, i.absorbedAccountId));
        await tx.insert(accountMerge).values({
          id: i.mergeId,
          primaryAccountId: i.primaryAccountId,
          mergedAccountId: i.absorbedAccountId,
          mergedProvider: i.mergedProvider,
          movedSummary: i.moved,
          requestedAt: date(i.requestedAt),
          confirmedAt: date(i.now),
        });
      },
      recordAccountMerged: async (i) => {
        // 병합 확정 트랜잭션의 마지막 쓰기(ADR-0143 결정 3, docs/data.md §4의 9번)
        await writeOutbox(tx, this.clock, [accountMergedMessage(i)]);
      },
      recordLoginMethodChanged: async (i) => {
        // 로그인 수단을 잇거나 지운 트랜잭션의 마지막 쓰기(BOT-041, ADR-0143 결정 3)
        await writeOutbox(tx, this.clock, [loginMethodChangedMessage({ eventKey: uuidv7(this.clock), ...i })]);
      },
      bindDevice: async (accountId, deviceRef, now, prevRef) => {
        // 키 회전의 이음: 새 판 값의 행이 없고 옛 판 값의 행이 있으면 그 행을 새 판 값으로 바꾼다(새 기기로 세지 않는다, BOT-046)
        if (prevRef) {
          const [has] = await tx.select({ id: device.id }).from(device).where(and(eq(device.accountId, accountId), eq(device.deviceRef, deviceRef)));
          if (has) return has.id;
          const [moved] = await tx
            .update(device)
            .set({ deviceRef, deviceRefPrev: prevRef })
            .where(and(eq(device.accountId, accountId), eq(device.deviceRef, prevRef)))
            .returning({ id: device.id });
          if (moved) return moved.id;
        }
        const [made] = await tx
          .insert(device)
          .values({ id: uuidv7({ now: () => now, monotonicMs: () => 0 }), accountId, deviceRef, deviceRefPrev: prevRef ?? null, boundAt: date(now) })
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
        // 조사용 연락처 가명도 지운다(docs/data.md account_contact_ref '탈퇴 때 지운다', BOT-045)
        await tx.delete(accountContactRef).where(eq(accountContactRef.accountId, accountId));
        // 대표 계정이 탈퇴하면 그 계정의 병합 이력도 함께 파기한다(data-classification '계정 연결 및 병합 감사 원장', 새 맥락 리뷰 중간 6)
        // 사슬 앞단(이 계정에 흡수된 계정이 대표였던 병합)도 함께 지운다. 사슬은 한 단계로 고쳐 두어 그 계정들은 이 계정을 바로 가리킨다(다시 검토 낮음 1)
        await tx
          .delete(accountMerge)
          .where(or(eq(accountMerge.primaryAccountId, accountId), inArray(accountMerge.primaryAccountId, tx.select({ id: account.id }).from(account).where(eq(account.mergedIntoAccountId, accountId)))));
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
      setContactRef: (i) => writeContactRef(tx, i),
      verifiedOf: async (accountId) => {
        // 본인확인 기록 표는 본인확인 컨텍스트의 표다. 같은 트랜잭션에서 있는지만 본다(activeHoldOf와 같은 방식)
        const r = await tx.execute(sql`select 1 from identity_verification where account_id = ${accountId}`);
        return r.rows.length > 0;
      },
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
      terminateSessions: (ids, reason, now) => endIn(ids.map((id) => ({ id, reason })), now),
      endSessions: (items, now) => endIn(items, now),
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
          deviceLabel: r.deviceLabel,
          lastActiveAt: date(r.createdAt),
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
          .set({ prevRefreshHash: sql`${session.refreshHash}`, refreshHash: Buffer.from(hash), rotatedAt: date(now), lastActiveAt: date(now), refreshUsed: false, idleExpiresAt: date(idleExpiresAt) })
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
