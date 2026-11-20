// RV-09: AdminSessionService.TerminateAdminSessions의 PostgreSQL 통합 시험(I-T61 ①~③, ASVS 7.4.5, ADR-0322·0143).
// 메모리 대역이 아니라 실제 identity DB에서 전체/하나 종료, 다른 계정·없는 세션 404, 이미 끝난 세션 204,
// 같은 request_id 재전송 멱등, 세션마다 control.sessions-terminated(reason ADMIN_FORCE) Outbox, 계정 상태 불변을 본다.
import { createHash } from 'node:crypto';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { AdminAccountInputError, AdminAccountNotFound } from '../src/modules/admin/application/manage-admin-accounts.js';
import { TerminateAdminSessions } from '../src/modules/admin/application/terminate-admin-sessions.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-20T14:00:00.000Z') });
const H = 60 * 60_000;
const CMD = '0190f3a1-7c2e-7a00-8000-00000000d001';
const OTHER = '0190f3a1-7c2e-7a00-8000-00000000d002';
const CMD2 = '0190f3a1-7c2e-7a00-8000-00000000d003';
const OTHER2 = '0190f3a1-7c2e-7a00-8000-00000000d004';
const CMD3 = '0190f3a1-7c2e-7a00-8000-00000000d005';
const OTHER3 = '0190f3a1-7c2e-7a00-8000-00000000d006';
let n = 0;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-session-termination-it', max: 6 });
  await ensureOutboxPartitions(database, clock);
  const store = new DrizzleAdminAccountStore(database, clock);
  for (const [id, role] of [
    [CMD, 'commander'],
    [OTHER, 'operator'],
    [CMD2, 'commander'],
    [OTHER2, 'operator'],
    [CMD3, 'commander'],
    [OTHER3, 'operator'],
  ] as const) {
    await store.create({ id, role, email: `${id.slice(-4)}@peaket.example`, status: 'ACTIVE', now: clock.now() });
  }
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const sid = () => `0190f3a1-7c2e-7a00-8000-${String(800000 + ++n).padStart(12, '0')}`;
const live = async (store: DrizzleAdminAccountStore, accountId: string) => {
  const id = sid();
  await store.createSession({ id, accountId, aud: 'ops', refreshHash: createHash('sha256').update(id).digest(), refreshFamily: id, pairRef: id, createdAt: clock.now(), absoluteExpiresAt: clock.now() + 24 * H, idleExpiresAt: clock.now() + H }, 5);
  return id;
};
const reasons = (ids: readonly string[]) => q<{ id: string; termination_reason: string | null }>('select id, termination_reason from admin_session where id = any($1::uuid[]) order by id', [ids]);
const outboxFor = (accountId: string) => q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1 order by seq", [accountId]);

describe('관리 세션 강제 종료(PostgreSQL, RV-09)', () => {
  test('I-T61 ① [ASVS v5.0.0-7.4.5] 전체 종료는 ended_count·가드 401·세션마다 ADMIN_FORCE Outbox이고 계정 상태는 그대로다', async () => {
    const store = new DrizzleAdminAccountStore(database, clock);
    const terminate = new TerminateAdminSessions(store, clock);
    const guard = new GetAdminAuthz(store, store, clock);
    const sessions = [await live(store, CMD), await live(store, CMD), await live(store, CMD)];
    const keep = await live(store, OTHER);
    const out = await terminate.execute({ requestId: 'rv09-all-1', actedBy: OTHER, adminAccountId: CMD });
    expect(out).toEqual({ endedCount: 3, alreadyDone: false });
    for (const sessionId of sessions) expect(await guard.getAdminAuthz({ adminAccountId: CMD, sessionId })).toMatchObject({ valid: false });
    expect(await guard.getAdminAuthz({ adminAccountId: OTHER, sessionId: keep })).toMatchObject({ valid: true, role: 'operator' });
    expect((await reasons(sessions)).map((r) => r.termination_reason)).toEqual(['ADMIN_FORCE', 'ADMIN_FORCE', 'ADMIN_FORCE']);
    const events = await outboxFor(CMD);
    expect(events.map((e) => JSON.parse(e.payload.toString('utf8')))).toHaveLength(3);
    for (const e of events.map((x) => JSON.parse(x.payload.toString('utf8')))) expect(e).toMatchObject({ accountId: CMD, reason: 'ADMIN_FORCE' });
    expect(await q<{ status: string; role: string }>('select status, role from admin_account where id = $1', [CMD])).toEqual([{ status: 'ACTIVE', role: 'commander' }]);
    expect(await q("select kind from admin_account_request where request_id = 'rv09-all-1' and kind = 'TERMINATE_SESSIONS'")).toHaveLength(1);
  });

  test('I-T61 ② [ASVS v5.0.0-7.4.5] 하나만 끝내면 그 세션만 401이고 다른 세션은 살아 있다', async () => {
    const store = new DrizzleAdminAccountStore(database, clock);
    const terminate = new TerminateAdminSessions(store, clock);
    const guard = new GetAdminAuthz(store, store, clock);
    const a = await live(store, CMD2);
    const b = await live(store, CMD2);
    expect(await terminate.execute({ requestId: 'rv09-one-1', actedBy: OTHER2, adminAccountId: CMD2, sessionId: b })).toEqual({ endedCount: 1, alreadyDone: false });
    expect(await guard.getAdminAuthz({ adminAccountId: CMD2, sessionId: b })).toMatchObject({ valid: false });
    expect(await guard.getAdminAuthz({ adminAccountId: CMD2, sessionId: a })).toMatchObject({ valid: true, role: 'commander' });
    expect(await reasons([a, b])).toEqual([
      { id: a, termination_reason: null },
      { id: b, termination_reason: 'ADMIN_FORCE' },
    ]);
    const events = (await outboxFor(CMD2)).map((e) => JSON.parse(e.payload.toString('utf8')));
    expect(events).toEqual([expect.objectContaining({ accountId: CMD2, sessionId: b, reason: 'ADMIN_FORCE' })]);
  });

  test('I-T61 ③ [ASVS v5.0.0-7.4.5] 다른 계정 세션·없는 세션은 404, 이미 끝난 세션은 ended_count 0, 같은 request_id는 다시 처리하지 않는다', async () => {
    const store = new DrizzleAdminAccountStore(database, clock);
    const terminate = new TerminateAdminSessions(store, clock);
    const mine = await live(store, CMD3);
    const theirs = await live(store, OTHER3);
    await expect(terminate.execute({ requestId: 'rv09-nf-1', actedBy: OTHER3, adminAccountId: CMD3, sessionId: theirs })).rejects.toBeInstanceOf(AdminAccountNotFound);
    await expect(terminate.execute({ requestId: 'rv09-nf-2', actedBy: OTHER3, adminAccountId: CMD3, sessionId: '0190f3a1-7c2e-7a00-8000-00000000d0ff' })).rejects.toBeInstanceOf(AdminAccountNotFound);
    await expect(terminate.execute({ requestId: 'rv09-nf-3', actedBy: OTHER3, adminAccountId: '0190f3a1-7c2e-7a00-8000-00000000d0fe' })).rejects.toBeInstanceOf(AdminAccountNotFound);
    expect(await q<{ termination_reason: string | null }>('select termination_reason from admin_session where id = $1', [theirs])).toEqual([{ termination_reason: null }]);
    // 하나를 끝내고 같은 요청을 다시 보내면 already_done이고 Outbox가 늘지 않는다
    const requestId = 'rv09-idem-1';
    expect(await terminate.execute({ requestId, actedBy: OTHER3, adminAccountId: CMD3, sessionId: mine })).toEqual({ endedCount: 1, alreadyDone: false });
    const events = (await outboxFor(CMD3)).length;
    expect(await terminate.execute({ requestId, actedBy: OTHER3, adminAccountId: CMD3, sessionId: mine })).toEqual({ endedCount: 0, alreadyDone: true });
    expect((await outboxFor(CMD3)).length).toBe(events);
    // 이미 끝난 세션에 새 request_id로 다시 보내면 204(ended_count 0)
    expect(await terminate.execute({ requestId: 'rv09-idem-2', actedBy: OTHER3, adminAccountId: CMD3, sessionId: mine })).toEqual({ endedCount: 0, alreadyDone: false });
    // 같은 request_id를 다른 호출(다른 계정)에 쓰면 INVALID_ARGUMENT
    await expect(terminate.execute({ requestId, actedBy: OTHER3, adminAccountId: OTHER3 })).rejects.toBeInstanceOf(AdminAccountInputError);
  });
});
