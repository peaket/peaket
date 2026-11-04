// 가입 때 계정 연결 제안의 통합 시험(실제 PostgreSQL 18·Valkey 8.1, docs/features/identity.md §2.1 '가입 때 연결 제안의 첫 구현', BUILD_ORDER BOT-040, I-T29·I-T30).
// 마이그레이션 0011(account.email_verified)과 세션·캐시 Redis의 id:link 키(Hash, 10분, 실패 횟수 Lua)를 실제로 돈다.
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { linkKey, RedisLinkProposals } from '../src/modules/session/adapters/redis-link-proposals.js';
import { GetLinkProposal } from '../src/modules/session/application/get-link-proposal.js';
import { SeparateAccount } from '../src/modules/session/application/separate-account.js';
import { LINK_PROPOSAL_TTL_MS } from '../src/modules/session/domain/session.js';
import { kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let pg: PostgresContainer;
let vk: ValkeyContainer;
let database: Database;
let redis: HotRedis;
// Redis 수명은 서버 시계로 센다: 시험 시계는 지금 시각에서 시작한다
const clock = fakeClock({ now: Date.now() });

beforeAll(async () => {
  [pg, vk] = await Promise.all([startPostgres(), startValkey()]);
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-link-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
  redis = await createHotRedis({ url: vk.url });
});

afterAll(async () => {
  await redis?.close();
  await database?.close();
  pg?.stop();
  vk?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const cmd = (key: string, args: string[]) => redis.command(args, { key });

async function setup() {
  const sessions = new DrizzleSessionStore(database, clock);
  const links = new RedisLinkProposals(redis, () => clock.now());
  const k = await kit(sessions, { clock, links });
  const login = (provider: 'kakao' | 'naver' | 'google', sub: string, email: string | null, emailVerified: boolean, link?: { proposalId: string; binding: string }) =>
    k.create.outcome({ idempotencyKey: newKey(), provider, providerUserId: sub, email, emailVerified, deviceId: 'dev-1', ...(link ? { link } : {}) });
  return { sessions, links, k, login, view: new GetLinkProposal(links, clock), separate: new SeparateAccount(k.create, links) };
}

test('I-T29_PostgreSQL·Valkey에서_검증이메일이같은활성계정하나면_계정없이id:link제안을10분수명으로두고_묶음값원문은저장하지않는다', async () => {
  const t = await setup();
  const a = await t.login('kakao', 'pg-k-1', 'PgFan@peaket.test', true);
  expect(a.kind).toBe('session');
  expect(await q('select email_verified from account where email = $1', ['PgFan@peaket.test'])).toEqual([{ email_verified: true }]);
  const before = (await q<{ n: string }>('select count(*)::text as n from account'))[0]!.n;
  const p = await t.login('google', 'pg-g-1', ' pgfan@PEAKET.test', true);
  if (p.kind !== 'link-proposed') throw new Error(p.kind);
  expect((await q<{ n: string }>('select count(*)::text as n from account'))[0]!.n).toBe(before);
  // 수명은 만든 시각 + 10분의 절대 시각이다(시험 시계는 멈춰 있다)
  expect(Number(await cmd(linkKey(p.proposalId), ['PEXPIRETIME', linkKey(p.proposalId)]))).toBe(clock.now() + LINK_PROPOSAL_TTL_MS);
  const raw = JSON.stringify(await cmd(linkKey(p.proposalId), ['HGETALL', linkKey(p.proposalId)]));
  expect(raw).not.toContain(p.binding);
  expect(await t.view.run({ proposalId: p.proposalId, binding: p.binding })).toMatchObject({ existingProvider: 'kakao', newProvider: 'google', attemptsLeft: 3 });
  // 네이버(검증 없음)로 온 계정은 대상이 아니다
  await t.login('naver', 'pg-n-1', 'naver-only@peaket.test', false);
  expect((await t.login('google', 'pg-g-2', 'naver-only@peaket.test', true)).kind).toBe('session');
});

test('I-T30_PostgreSQL·Valkey에서_다른계정은세번까지만받고키를지우며_대상계정로그인은새제공자를그계정에잇는다', async () => {
  const t = await setup();
  const a = await t.login('kakao', 'pg-k-2', 'pg2@peaket.test', true);
  if (a.kind !== 'session') throw new Error(a.kind);
  const p1 = await t.login('google', 'pg-g-3', 'pg2@peaket.test', true);
  if (p1.kind !== 'link-proposed') throw new Error(p1.kind);
  const link1 = { proposalId: p1.proposalId, binding: p1.binding };
  for (const left of [2, 1, 0]) expect(await t.login('kakao', `pg-none-${left}`, null, false, link1)).toEqual({ kind: 'link-mismatch', attemptsLeft: left });
  expect(Number(await cmd(linkKey(p1.proposalId), ['EXISTS', linkKey(p1.proposalId)]))).toBe(0);
  // 불일치로는 계정을 만들지 않았다
  expect(await q("select 1 from account_provider where provider = 'kakao' and provider_user_id like 'pg-none-%'")).toHaveLength(0);
  // 새 제안으로 다시 하면 연결된다
  const p2 = await t.login('google', 'pg-g-3', 'pg2@peaket.test', true);
  if (p2.kind !== 'link-proposed') throw new Error(p2.kind);
  const ok = await t.login('kakao', 'pg-k-2', null, false, { proposalId: p2.proposalId, binding: p2.binding });
  if (ok.kind !== 'session') throw new Error(ok.kind);
  expect(ok).toMatchObject({ accountId: a.accountId, linkedProvider: 'google', newAccount: false });
  expect(await q("select account_id from account_provider where provider = 'google' and provider_user_id = 'pg-g-3'")).toEqual([{ account_id: a.accountId }]);
  expect(Number(await cmd(linkKey(p2.proposalId), ['EXISTS', linkKey(p2.proposalId)]))).toBe(0);
});

test('PostgreSQL·Valkey에서_새계정만들기는_제안의새제공자로검증이메일계정을만들고제안을지운다', async () => {
  const t = await setup();
  await t.login('kakao', 'pg-k-3', 'pg3@peaket.test', true);
  const p = await t.login('google', 'pg-g-4', 'pg3@peaket.test', true);
  if (p.kind !== 'link-proposed') throw new Error(p.kind);
  const s = await t.separate.run({ proposalId: p.proposalId, binding: p.binding, idempotencyKey: newKey(), deviceId: null });
  expect(s.newAccount).toBe(true);
  expect(await q('select email, email_verified from account where id = $1', [s.accountId])).toEqual([{ email: 'pg3@peaket.test', email_verified: true }]);
  expect(Number(await cmd(linkKey(p.proposalId), ['EXISTS', linkKey(p.proposalId)]))).toBe(0);
});

test('I-T30_리뷰재현_PostgreSQL에서_대상계정의탈퇴가끝나기전에연결로그인이오면_계정을잠근뒤상태를보고_탈퇴한계정에새제공자를잇지않는다', async () => {
  const t = await setup();
  const a = await t.login('kakao', 'pg-k-9', 'pg9@peaket.test', true);
  if (a.kind !== 'session') throw new Error(a.kind);
  const p = await t.login('google', 'pg-g-9', 'pg9@peaket.test', true);
  if (p.kind !== 'link-proposed') throw new Error(p.kind);
  // 탈퇴 트랜잭션처럼 계정을 먼저 잠그고(FOR UPDATE), 연결 로그인이 들어온 뒤 로그인 수단을 지우고 DELETED로 끝낸다
  const c = await database.pool.connect();
  await c.query('begin');
  await c.query('select 1 from account where id = $1 for update', [a.accountId]);
  const linking = t.login('kakao', 'pg-k-9', null, false, { proposalId: p.proposalId, binding: p.binding }).then(
    (v) => ({ ok: v }),
    (e: unknown) => ({ err: e }),
  );
  // 연결 로그인이 계정 잠금을 기다리기 시작할 때까지 본다(정해진 시간만 기다리면 붐빌 때 깨진다, 재검토 낮음)
  for (let n = 0; n < 100; n++) {
    const w = await q<{ n: string }>("select count(*)::text as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");
    if (w[0]!.n !== '0') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await c.query('delete from account_provider where account_id = $1', [a.accountId]);
  await c.query("update account set status = 'DELETED', email = null, email_verified = false, deleted_at = now() where id = $1", [a.accountId]);
  await c.query('commit');
  c.release();
  const r = await linking;
  expect('err' in r ? (r.err as { code?: string }).code : 'OK').toBe('NOT_FOUND');
  // 탈퇴한 계정에 구글이 붙지 않았고, 아무 계정에도 붙지 않았다
  expect(await q("select account_id from account_provider where provider = 'google' and provider_user_id = 'pg-g-9'")).toEqual([]);
});
