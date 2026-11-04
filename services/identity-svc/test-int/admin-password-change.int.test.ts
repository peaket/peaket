// 관리 계정 비밀번호만 맞은 로그인·익숙한 출발지·세션 판정의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123).
// 마이그레이션 0020(admin_known_source, admin_login_step 칸 둘), 비밀번호만 맞은 로그인 찾기·알리기의 한 트랜잭션, 다른 세션 끝내기와 Outbox, GetAdminAuthz를 본다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { CheckPasswordOnlyLogins } from '../src/modules/admin/application/check-password-only-logins.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T09:00:00.000Z') });
const ID = '0190f3a1-7c2e-7a00-8000-0000000009a1';
const M = 60_000;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-pwchange-test', max: 4 });
  await ensureOutboxPartitions(database, clock);
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('PostgreSQL에서_익숙한출발지는30일안의성공만이고_비밀번호만맞은로그인은10분뒤한번알리며_비밀번호바꾸기필요를켠다(AC-T4)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: ID, role: 'partner_admin', email: 'pwc@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  await store.touchKnownSource(ID, 'a'.repeat(32), clock.now());
  await store.touchKnownSource(ID, 'a'.repeat(32), clock.now() + 1);
  expect(await store.isKnownSource(ID, 'a'.repeat(32), clock.now() - 30 * 24 * 60 * M)).toBe(true);
  expect(await store.isKnownSource(ID, 'b'.repeat(32), 0)).toBe(false);
  await store.createLoginStep({ id: '0190f3a1-7c2e-7a00-8000-0000000009b1', accountId: ID, tokenHash: Buffer.alloc(32, 1), aud: 'partner', pairRef: 'a'.repeat(32), createdAt: clock.now(), expiresAt: clock.now() + 5 * M, knownSource: true });
  await store.createLoginStep({ id: '0190f3a1-7c2e-7a00-8000-0000000009b2', accountId: ID, tokenHash: Buffer.alloc(32, 2), aud: 'partner', pairRef: 'b'.repeat(32), createdAt: clock.now(), expiresAt: clock.now() + 5 * M, knownSource: false });
  const check = new CheckPasswordOnlyLogins(store, DEFAULT_ADMIN_AUTH_CONFIG, clock);
  expect(await check.run()).toBe(0);
  clock.advance(10 * M);
  const both = await Promise.all([check.run(), check.run()]);
  expect(both[0]! + both[1]!).toBe(1);
  const [row] = await q<{ password_change_required: boolean }>('select password_change_required from admin_account where id = $1', [ID]);
  expect(row!.password_change_required).toBe(true);
  expect(await q("select kind from admin_security_notice where admin_account_id = $1 and kind = 'PASSWORD_ONLY_LOGIN'", [ID])).toHaveLength(1);
  // 30일 지난 익숙한 출발지는 정비가 지운다
  expect(await store.purgeKnownSources(clock.now() + 31 * 24 * 60 * M)).toBe(1);
});

test('PostgreSQL에서_단계를만든뒤같은묶음에서2단계까지끝냈으면본시각만적고알리지않는다(AC-T4, 새 맥락 리뷰 2026-11-05)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const id = '0190f3a1-7c2e-7a00-8000-0000000009d1';
  await store.create({ id, role: 'operator', email: 'retry@peaket.example', status: 'ACTIVE', now: clock.now() });
  await store.createLoginStep({ id: '0190f3a1-7c2e-7a00-8000-0000000009d2', accountId: id, tokenHash: Buffer.alloc(32, 7), aud: 'ops', pairRef: 'c'.repeat(32), createdAt: clock.now(), expiresAt: clock.now() + 5 * M, knownSource: false });
  await store.touchKnownSource(id, 'c'.repeat(32), clock.now() + M);
  clock.advance(10 * M);
  expect(await new CheckPasswordOnlyLogins(store, DEFAULT_ADMIN_AUTH_CONFIG, clock).run()).toBe(0);
  const [step] = await q<{ password_only_noticed_at: Date | null }>('select password_only_noticed_at from admin_login_step where id = $1', ['0190f3a1-7c2e-7a00-8000-0000000009d2']);
  expect(step!.password_only_noticed_at).not.toBeNull();
  expect(await q("select 1 from admin_security_notice where admin_account_id = $1 and kind = 'PASSWORD_ONLY_LOGIN'", [id])).toHaveLength(0);
  const [acc] = await q<{ password_change_required: boolean }>('select password_change_required from admin_account where id = $1', [id]);
  expect(acc!.password_change_required).toBe(false);
});

test('PostgreSQL에서_다른관리세션을모두끝내고같은트랜잭션에PASSWORD_CHANGED사건을적으며_GetAdminAuthz는살아있는그계정의세션만valid다 [ASVS v5.0.0-8.2.1]', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const now = clock.now();
  const ids = ['0190f3a1-7c2e-7a00-8000-0000000009c1', '0190f3a1-7c2e-7a00-8000-0000000009c2'];
  for (const [k, id] of ids.entries()) {
    await store.createSession({ id, accountId: ID, aud: 'partner', refreshHash: Buffer.alloc(32, 20 + k), refreshFamily: id, pairRef: 'a'.repeat(32), createdAt: now + k, absoluteExpiresAt: now + 86_400_000, idleExpiresAt: now + 3_600_000 }, 2);
  }
  // 세션은 로그인한 묶음 값을 돌려준다(비밀번호 바꾸기의 실패를 그 묶음에 센다)
  expect(await store.findSession(ids[0]!)).toMatchObject({ pairRef: 'a'.repeat(32), aud: 'partner', terminatedAt: null });
  const authz = new GetAdminAuthz(store, store, clock);
  expect(await authz.getAdminAuthz({ adminAccountId: ID, sessionId: ids[0]! })).toEqual({ valid: true, role: 'partner_admin', tenantId: '0190f3a1-7c2e-7a00-8000-000000000001' });
  expect(await store.terminateOtherSessions(ID, ids[1]!, 'PASSWORD_CHANGED', now + 10)).toEqual([ids[0]]);
  expect((await authz.getAdminAuthz({ adminAccountId: ID, sessionId: ids[0]! })).valid).toBe(false);
  expect((await authz.getAdminAuthz({ adminAccountId: ID, sessionId: ids[1]! })).valid).toBe(true);
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [ID]);
  expect(events.map((e) => JSON.parse(e.payload.toString('utf8')))).toEqual([{ accountId: ID, sessionId: ids[0], reason: 'PASSWORD_CHANGED', terminatedAt: new Date(now + 10).toISOString() }]);
  clock.advance(61 * M);
  expect((await authz.getAdminAuthz({ adminAccountId: ID, sessionId: ids[1]! })).valid).toBe(false);
});
