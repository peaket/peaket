// 관리 계정 본인 해제 링크와 알림 발송의 통합 시험(실제 PostgreSQL 18과 Valkey 8.1, docs/features/identity.md §6 '관리 계정 본인 해제 링크와 2단계 보호 잠금의 첫 구현', BUILD_ORDER BOT-121).
// 마이그레이션 0019(admin_unlock_link), 새 링크의 옛 링크 무효, 링크 쓰기·잠금 풀기·알림의 한 트랜잭션, 알림 발송의 FOR UPDATE SKIP LOCKED, Redis 다시 받기 셈을 본다.
import { createHash } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { RedisLoginCounters } from '../src/modules/admin/adapters/redis-login-counters.js';
import { onSelfUnlock } from '../src/modules/admin/domain/login-rules.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let pg: PostgresContainer;
let vk: ValkeyContainer;
let database: Database;
let redis: HotRedis;
const clock = fakeClock({ now: Date.parse('2026-11-05T07:00:00.000Z') });
const ID = '0190f3a1-7c2e-7a00-8000-0000000007a1';

beforeAll(async () => {
  [pg, vk] = await Promise.all([startPostgres(), startValkey()]);
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-unlock-test', max: 4 });
  redis = await createHotRedis({ url: vk.url });
}, 120_000);

afterAll(async () => {
  await redis?.close();
  await database?.close();
  pg?.stop();
  vk?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const h = (s: string) => createHash('sha256').update(s).digest();

test('PostgreSQL에서_새해제링크는옛링크를무효로하고_링크쓰기·시간잠금풀기·UNLOCKED알림은한트랜잭션이며_한번만된다 [ASVS v5.0.0-6.5.1]', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: ID, role: 'operator', email: 'unlock@peaket.example', status: 'ACTIVE', now: clock.now() });
  await q("update admin_account set lock_kind = 'TIMED', locked_until = $2, failed_attempts = 0, second_factor_failures = 2 where id = $1", [ID, new Date(clock.now() + 900_000)]);
  await store.createUnlockLink({ id: '0190f3a1-7c2e-7a00-8000-0000000007b1', accountId: ID, tokenHash: h('first'), createdAt: clock.now(), expiresAt: clock.now() + 1_800_000 });
  await store.createUnlockLink({ id: '0190f3a1-7c2e-7a00-8000-0000000007b2', accountId: ID, tokenHash: h('second'), createdAt: clock.now(), expiresAt: clock.now() + 1_800_000 });
  expect((await store.findUnlockLink(h('first')))!.revokedAt).toBe(clock.now());
  expect(await store.failUnlockCode('0190f3a1-7c2e-7a00-8000-0000000007b2')).toBe(1);
  // 옛 링크로는 풀리지 않는다
  expect(await store.useUnlockLink('0190f3a1-7c2e-7a00-8000-0000000007b1', ID, clock.now(), (s) => onSelfUnlock(s, clock.now()), 'UNLOCKED')).toBe(false);
  const both = await Promise.all([1, 2].map(() => store.useUnlockLink('0190f3a1-7c2e-7a00-8000-0000000007b2', ID, clock.now(), (s) => onSelfUnlock(s, clock.now()), 'UNLOCKED')));
  expect(both.filter(Boolean)).toHaveLength(1);
  const [row] = await q<{ lock_kind: string; locked_until: Date; second_factor_failures: number }>('select lock_kind, locked_until, second_factor_failures from admin_account where id = $1', [ID]);
  expect(row).toEqual({ lock_kind: 'NONE', locked_until: new Date(clock.now()), second_factor_failures: 2 });
  expect(await q('select kind from admin_security_notice where admin_account_id = $1', [ID])).toEqual([{ kind: 'UNLOCKED' }]);
  // 확정할 수 없으면(보호 잠금) 링크 쓰기까지 되돌린다
  await store.createUnlockLink({ id: '0190f3a1-7c2e-7a00-8000-0000000007b3', accountId: ID, tokenHash: h('third'), createdAt: clock.now(), expiresAt: clock.now() + 1_800_000 });
  expect(await store.useUnlockLink('0190f3a1-7c2e-7a00-8000-0000000007b3', ID, clock.now(), () => null, 'UNLOCKED')).toBe(false);
  expect((await store.findUnlockLink(h('third')))!.usedAt).toBeNull();
});

test('PostgreSQL에서_알림발송은보내지않은행을잠가두파드가함께돌아도한번씩만보내고_KEEP은남긴다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  for (let i = 0; i < 6; i++) await store.addNotice(ID, 'PASSWORD_FAILURE_NOTICE', clock.now() + i);
  const seen: string[] = [];
  const handle = async (n: { id: string }) => {
    seen.push(n.id);
    await new Promise((r) => setTimeout(r, 30));
    return 'SENT' as const;
  };
  const [a, b] = await Promise.all([store.dispatchNotices(4, clock.now(), handle), store.dispatchNotices(4, clock.now(), handle)]);
  expect(new Set(seen).size).toBe(seen.length);
  expect(a.done + b.done).toBe(7);
  expect((await store.dispatchNotices(10, clock.now(), async () => 'SENT')).done).toBe(0);
  await store.addNotice(ID, 'MULTI_SOURCE_ALERT', clock.now());
  expect(await store.dispatchNotices(10, clock.now(), async () => 'KEEP')).toEqual({ done: 0, failed: 1 });
  expect(await q('select attempts, next_attempt_at from admin_security_notice where sent_at is null')).toEqual([{ attempts: 1, next_attempt_at: new Date(clock.now() + 60_000) }]);
  // 다음 시도 때가 안 된 행은 고르지 않는다(앞을 막지 않는다)
  expect(await store.dispatchNotices(10, clock.now(), async () => 'SENT')).toEqual({ done: 0, failed: 0 });
  // 한 행이 예외를 내도 앞에서 보낸 행은 그대로 보낸 것으로 남고 뒤의 행은 계속 보낸다(새 맥락 리뷰 2026-11-05)
  await q('update admin_security_notice set sent_at = now()');
  for (let i = 0; i < 3; i++) await store.addNotice(ID, 'PASSWORD_FAILURE_NOTICE', clock.now() + 100 + i);
  let n = 0;
  const sent = await store.dispatchNotices(10, clock.now(), async () => {
    n++;
    if (n === 2) throw new Error('DB 일시 오류');
    return 'SENT';
  });
  expect(sent).toEqual({ done: 2, failed: 1 });
  expect(await q('select 1 from admin_security_notice where sent_at is null')).toHaveLength(1);
});

test('Valkey에서_해제링크다시받기는1시간에3번이고_넷째는남은시간을준다', async () => {
  const counters = new RedisLoginCounters(redis);
  const now = clock.now();
  for (let i = 0; i < 3; i++) expect(await counters.countResend('abc', now + i, 3_600_000, 3)).toEqual({ allowed: true, retryAfterMs: 0 });
  expect(await counters.countResend('abc', now + 10, 3_600_000, 3)).toEqual({ allowed: false, retryAfterMs: 3_600_000 - 10 });
  expect((await counters.countResend('abc', now + 3_600_001, 3_600_000, 3)).allowed).toBe(true);
});
