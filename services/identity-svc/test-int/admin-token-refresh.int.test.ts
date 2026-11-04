// 관리 계정 토큰 갱신·로그아웃의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130).
// 마이그레이션 0021(admin_session 칸 셋, admin_refresh_token_hash), 행 잠금 안의 회전·재시도·탈취 판정, 같은 트랜잭션의 세션 종료 사건(Outbox), 정비를 본다.
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { EndAdminSession } from '../src/modules/admin/application/end-admin-session.js';
import { RefreshAdminSession } from '../src/modules/admin/application/refresh-admin-session.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T10:00:00.000Z') });
const M = 60_000;
const ACC = '0190f3a1-7c2e-7a00-8000-000000000ba1';
const signer = { access: async (c: { sessionId: string; scopes?: readonly string[] }, now: number) => ({ token: `at.${c.sessionId}.${(c.scopes ?? []).join(',')}`, expiresAt: now + 15 * M }) };
const signals = { failure: () => {}, alert: () => {} };

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-refresh-test', max: 6 });
  await ensureOutboxPartitions(database, clock);
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const sha = (t: string) => createHash('sha256').update(t).digest();

async function newSession(store: DrizzleAdminAccountStore, id: string): Promise<string> {
  const rt = randomBytes(32).toString('base64url');
  const now = clock.now();
  await store.createSession({ id, accountId: ACC, aud: 'ops', refreshHash: sha(rt), refreshFamily: id, pairRef: 'f'.repeat(32), createdAt: now, absoluteExpiresAt: now + 24 * 60 * M, idleExpiresAt: now + 60 * M }, 2);
  return rt;
}

test('PostgreSQL에서_회전하면유휴만료가늘고_동시에같은토큰이오면하나는회전·하나는재시도이며_예전토큰은패밀리를끝내고REFRESH_REUSE사건을같은트랜잭션에적는다(I-T46②⑥) [ASVS v5.0.0-7.2.4]', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: ACC, role: 'operator', email: 'rt.int@peaket.example', status: 'ACTIVE', now: clock.now() });
  const sid = '0190f3a1-7c2e-7a00-8000-000000000bb1';
  const rt0 = await newSession(store, sid);
  // 로그인 때 준 첫 토큰도 발급 해시 기록에 있다
  expect(await q('select 1 from admin_refresh_token_hash where admin_session_id = $1', [sid])).toHaveLength(1);
  const uc = new RefreshAdminSession(store, signer, signals, clock);
  clock.advance(30 * M);
  const both = await Promise.all([uc.run({ aud: 'ops', refreshToken: rt0 }), uc.run({ aud: 'ops', refreshToken: rt0 })]);
  expect(both.map((r) => r.result).sort()).toEqual(['OK', 'OK']);
  const [row] = await q<{ idle_expires_at: Date; rotated_at: Date; prev_refresh_hash: Buffer }>('select idle_expires_at, rotated_at, prev_refresh_hash from admin_session where id = $1', [sid]);
  expect(row!.idle_expires_at.getTime()).toBe(clock.now() + 60 * M);
  expect(Buffer.from(row!.prev_refresh_hash).equals(sha(rt0))).toBe(true);
  // 마지막에 준 토큰만 지금 토큰이다(먼저 준 것은 재시도가 바꿨다)
  const rts = both.map((r) => (r.result === 'OK' ? r.refreshToken : ''));
  const [cur] = await q<{ refresh_hash: Buffer }>('select refresh_hash from admin_session where id = $1', [sid]);
  const live = rts.find((t) => sha(t).equals(Buffer.from(cur!.refresh_hash)))!;
  const lost = rts.find((t) => t !== live)!;
  expect(live).toBeDefined();
  expect((await uc.run({ aud: 'ops', refreshToken: live })).result).toBe('OK');
  // 받지 못했어야 할 토큰이 30초 뒤에 오면 탈취로 보아 패밀리를 끝낸다
  clock.advance(31_000);
  expect((await uc.run({ aud: 'ops', refreshToken: lost })).result).toBe('REUSED');
  const [ended] = await q<{ termination_reason: string }>('select termination_reason from admin_session where id = $1', [sid]);
  expect(ended!.termination_reason).toBe('REFRESH_REUSE');
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [ACC]);
  expect(events.map((e) => JSON.parse(e.payload.toString('utf8')))).toContainEqual(expect.objectContaining({ sessionId: sid, reason: 'REFRESH_REUSE' }));
});

test('PostgreSQL에서_비밀번호바꾸기필요계정은스코프를다시붙이고_다른콘솔이면무효이며_로그아웃은LOGOUT사건이고_정비가지난발급해시를지운다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const uc = new RefreshAdminSession(store, signer, signals, clock);
  const sid = '0190f3a1-7c2e-7a00-8000-000000000bb2';
  const rt = await newSession(store, sid);
  await q('update admin_account set password_change_required = true where id = $1', [ACC]);
  expect(await uc.run({ aud: 'partner', refreshToken: rt })).toEqual({ result: 'INVALID' });
  const ok = await uc.run({ aud: 'ops', refreshToken: rt });
  expect(ok).toMatchObject({ result: 'OK', accessToken: `at.${sid}.password:change` });
  await q('update admin_account set password_change_required = false where id = $1', [ACC]);
  expect(await new EndAdminSession(store, clock).run({ accountId: ACC, sessionId: sid })).toBe(true);
  expect(await new EndAdminSession(store, clock).run({ accountId: ACC, sessionId: sid })).toBe(false);
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [ACC]);
  expect(events.map((e) => JSON.parse(e.payload.toString('utf8')))).toContainEqual(expect.objectContaining({ sessionId: sid, reason: 'LOGOUT' }));
  expect(await uc.run({ aud: 'ops', refreshToken: ok.result === 'OK' ? ok.refreshToken : '' })).toEqual({ result: 'INVALID' });
  const before = (await q<{ n: string }>('select count(*) as n from admin_refresh_token_hash'))[0]!.n;
  expect(Number(before)).toBeGreaterThan(0);
  expect(await store.purgeRefreshHashes(clock.now() + 25 * 60 * M)).toBe(Number(before));
});

test('PostgreSQL에서_세션행을쥔동안온같은토큰의갱신둘은잠금을기다렸다가바뀐행으로다시판정한다(하나는회전·하나는재시도)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const uc = new RefreshAdminSession(store, signer, signals, clock);
  const sid = '0190f3a1-7c2e-7a00-8000-000000000bb3';
  const rt = await newSession(store, sid);
  // 다른 연결이 그 세션 행을 쥐고 있는 동안 두 갱신을 보낸다: 둘 다 잠금에서 기다리다 차례로 판정한다
  const holder = await database.pool.connect();
  await holder.query('begin');
  await holder.query('select id from admin_session where id = $1 for update', [sid]);
  const both = Promise.all([uc.run({ aud: 'ops', refreshToken: rt }), uc.run({ aud: 'ops', refreshToken: rt })]);
  await new Promise((r) => setTimeout(r, 300));
  await holder.query('commit');
  holder.release();
  expect((await both).map((r) => r.result)).toEqual(['OK', 'OK']);
  // 회전 한 번(앞 토큰 = 처음 토큰)과 재시도 한 번: 회전이 두 번이면 앞 토큰이 첫 회전의 토큰이 된다
  const [row] = await q<{ prev_refresh_hash: Buffer }>('select prev_refresh_hash from admin_session where id = $1', [sid]);
  expect(Buffer.from(row!.prev_refresh_hash).equals(sha(rt))).toBe(true);
  expect(await q('select 1 from admin_refresh_token_hash where admin_session_id = $1', [sid])).toHaveLength(3);
});

test('PostgreSQL에서_마이그레이션0021의채우기는열린세션의지금토큰해시만발급해시기록에넣는다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const open = '0190f3a1-7c2e-7a00-8000-000000000bb4';
  const ended = '0190f3a1-7c2e-7a00-8000-000000000bb5';
  await newSession(store, open);
  await newSession(store, ended);
  await new EndAdminSession(store, clock).run({ accountId: ACC, sessionId: ended });
  // 0021 앞에 만든 세션처럼 기록을 비운 뒤 그 채우기 문장만 다시 돌린다
  await q('delete from admin_refresh_token_hash where admin_session_id in ($1, $2)', [open, ended]);
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../migrations/0021_admin_token_refresh.sql', import.meta.url), 'utf8');
  const backfill = sql.split('--> statement-breakpoint').map((x) => x.trim()).find((x) => x.startsWith('INSERT INTO "admin_refresh_token_hash"'))!;
  await q(backfill);
  expect((await q<{ admin_session_id: string }>('select admin_session_id from admin_refresh_token_hash where admin_session_id in ($1, $2)', [open, ended])).map((r) => r.admin_session_id)).toEqual([open]);
});
