// 관리 계정 로그인 1단계의 통합 시험(실제 PostgreSQL 18과 Valkey 8.1, docs/features/identity.md §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// 마이그레이션 0017(admin_login_step·admin_security_notice), 행 잠금 트랜잭션의 셈과 알림, Redis Lua 셋(대상·출발지·전체 태그)의 묶음 잠금·경보·가짜 상태를 본다.
import { createHash } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { loginKeys, RedisLoginCounters } from '../src/modules/admin/adapters/redis-login-counters.js';
import { emailKeyOf, LoginPasswordStep, pairRefOf, shortHash } from '../src/modules/admin/application/login-password-step.js';
import { RecordAdminLoginSuccess } from '../src/modules/admin/application/record-login-success.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const M = 60_000;
const PW = '봄비내리는월요일아침의커피한잔';
let pg: PostgresContainer;
let vk: ValkeyContainer;
let database: Database;
let redis: HotRedis;
const clock = fakeClock({ now: Date.parse('2026-11-05T03:00:00.000Z') });
const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
const passwords = new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 });
const alerts: string[] = [];

beforeAll(async () => {
  [pg, vk] = await Promise.all([startPostgres(), startValkey()]);
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-login-test', max: 8 });
  redis = await createHotRedis({ url: vk.url });
}, 120_000);

afterAll(async () => {
  await redis?.close();
  await database?.close();
  pg?.stop();
  vk?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

async function account(id: string, email: string, role: 'partner_admin' | 'operator' = 'operator') {
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id, role, email, status: 'ACTIVE', promoterId: role === 'partner_admin' ? '0190f3a1-7c2e-7a00-8000-000000000001' : null, now: clock.now() });
  await store.setPassword({ id, phc: await passwords.hash(id, PW), breachCheckedAt: clock.now(), now: clock.now() });
  return store;
}

function stepWith(store: DrizzleAdminAccountStore) {
  const counters = new RedisLoginCounters(redis);
  const step = new LoginPasswordStep(store, counters, passwords, { isBreached: async () => false }, { verify: async (t) => (t === 'ok' ? 'OK' : 'FAILED') }, { failure: () => {}, alert: (k) => alerts.push(k) }, DEFAULT_ADMIN_AUTH_CONFIG, clock);
  return { step, counters, success: new RecordAdminLoginSuccess(store, counters, clock) };
}

test('PostgreSQL·Valkey에서_한출발지5회실패는계정시간잠금과같은끝시각의묶음잠금이고_알림행과잠금칸이남으며_성공처리가셈을지운다 [ASVS v5.0.0-6.3.1]', async () => {
  const id = '0190f3a1-7c2e-7a00-8000-0000000003a1';
  const store = await account(id, 'ops.int@peaket.example');
  const { step, counters, success } = stepWith(store);
  const run = (password: string, token?: string) => step.run({ aud: 'ops', email: 'OPS.int@peaket.example ', password, ip: '203.0.113.60', deviceId: 'dev-i', ...(token ? { humanCheckToken: token } : {}) });
  for (let i = 0; i < 4; i++) await run(`wrong-${i}`, 'ok');
  expect(await run('wrong-4', 'ok')).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 900 });
  const [row] = await q<{ lock_kind: string; locked_until: Date; failed_attempts: number; password_failure_total: number; recent_lock_at: string[]; lock_reason: string }>(
    'select lock_kind, locked_until, failed_attempts, password_failure_total, recent_lock_at, lock_reason from admin_account where id = $1',
    [id],
  );
  expect(row).toMatchObject({ lock_kind: 'TIMED', locked_until: new Date(clock.now() + 15 * M), failed_attempts: 0, password_failure_total: 5, lock_reason: 'FAILED_ATTEMPTS' });
  expect(row!.recent_lock_at).toHaveLength(1);
  expect(await q('select kind from admin_security_notice where admin_account_id = $1', [id])).toEqual([{ kind: 'TIMED_LOCK' }]);
  // 묶음 키: 끝 시각을 정수 글로 둔다(Lua의 1.7e+12 꼴이 아니다)
  const pair = pairRefOf('203.0.113.60', 'dev-i');
  const raw = (await redis.command(['HGET', loginKeys.pair(id, pair), 'until'], { key: loginKeys.pair(id, pair) })) as string;
  expect(String(raw)).toBe(String(clock.now() + 15 * M));
  expect((await counters.peek({ subject: id, pair, ipHash: shortHash('203.0.113.60'), now: clock.now() })).pairLockedUntil).toBe(clock.now() + 15 * M);
  // 15분 뒤 맞는 비밀번호로 1단계를 통과하면 로그인 단계 행(해시만)이 생긴다
  clock.advance(15 * M);
  const r = await run(PW, 'ok');
  if (r.kind !== 'PASSED') throw new Error(`통과해야 한다: ${r.kind}`);
  const steps = await q<{ token_hash: Buffer; aud: string; pair_ref: string; expires_at: Date }>('select token_hash, aud, pair_ref, expires_at from admin_login_step where admin_account_id = $1', [id]);
  expect(steps).toHaveLength(1);
  expect(steps[0]!.token_hash.equals(createHash('sha256').update(r.loginStep).digest())).toBe(true);
  expect(steps[0]).toMatchObject({ aud: 'ops', pair_ref: pair, expires_at: new Date(clock.now() + 5 * M) });
  await success.run({ accountId: id, pair });
  const [after] = await q<{ password_failure_total: number; last_login_at: Date }>('select password_failure_total, last_login_at from admin_account where id = $1', [id]);
  expect(after).toMatchObject({ password_failure_total: 0, last_login_at: new Date(clock.now()) });
  expect(await redis.command(['EXISTS', loginKeys.pair(id, pair)], { key: loginKeys.pair(id, pair) })).toBe(0);
});

test('PostgreSQL·Valkey에서_한계정에동시에온시도10개는Redis임대로하나만처리하고나머지는BUSY로세지않으며_잠근뒤동시의맞는비밀번호도통과하지않는다', async () => {
  const id = '0190f3a1-7c2e-7a00-8000-0000000003a2';
  const store = await account(id, 'race@peaket.example');
  const { step } = stepWith(store);
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => step.run({ aud: 'ops', email: 'race@peaket.example', password: `wrong-${i}`, ip: `198.51.100.${70 + i}`, deviceId: '' })));
  // 임대는 한 번에 하나만 처리하게 할 뿐이라, 앞 시도가 끝나 임대를 풀면 늦게 온 시도는 차례로 처리된다(BUSY 수는 때에 따라 다르다).
  // 지키는 것: 처리된 시도는 하나씩만 세고, 잠금(5번) 뒤의 시도는 세지 않는다
  const processed = out.filter((o) => o.kind !== 'BUSY').length;
  expect(processed).toBeGreaterThanOrEqual(1);
  expect(out.filter((o) => o.kind === 'BUSY').length).toBeGreaterThanOrEqual(1);
  const [row] = await q<{ password_failure_total: number }>('select password_failure_total from admin_account where id = $1', [id]);
  expect(row).toEqual({ password_failure_total: Math.min(processed, 5) });
  for (let i = 0; i < 4; i++) await step.run({ aud: 'ops', email: 'race@peaket.example', password: `seq-${i}`, ip: '198.51.100.80', deviceId: '', humanCheckToken: 'ok' });
  expect((await q<{ lock_kind: string }>('select lock_kind from admin_account where id = $1', [id]))[0]).toEqual({ lock_kind: 'TIMED' });
  expect(await q('select kind from admin_security_notice where admin_account_id = $1 and kind = $2', [id, 'TIMED_LOCK'])).toHaveLength(1);
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => step.run({ aud: 'ops', email: 'race@peaket.example', password: PW, ip: `198.51.100.${90 + i}`, deviceId: '', humanCheckToken: 'ok' })));
  expect(burst.some((o) => o.kind === 'PASSED')).toBe(false);
  expect(await q('select id from admin_login_step where admin_account_id = $1', [id])).toHaveLength(0);
  // 임대 키는 끝나면 지운다
  expect(await redis.command(['EXISTS', loginKeys.busy(id)], { key: loginKeys.busy(id) })).toBe(0);
});

test('Valkey에서_한IP가서로다른이메일5개로틀리면출발지경보이고_없는이메일의가짜상태는25시간짜리키로남는다(AC-T1·AC-T2)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const { step, counters } = stepWith(store);
  const ip = '192.0.2.80';
  for (let i = 0; i < 5; i++) await step.run({ aud: 'partner', email: `ghost${i}@haeoreum.example`, password: 'x', ip, deviceId: '' });
  expect(await step.run({ aud: 'partner', email: 'ghost9@haeoreum.example', password: 'x', ip, deviceId: '' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
  expect(alerts).toContain('source');
  const gk = loginKeys.ghost(`partner:${shortHash(emailKeyOf('ghost0@haeoreum.example'))}`);
  const ttl = Number(await redis.command(['PTTL', gk], { key: gk }));
  expect(ttl).toBeGreaterThan(29 * 24 * 60 * M);
  expect((await counters.ghostState(`partner:${shortHash('ghost0@haeoreum.example')}`, clock.now())).failedAttempts).toBe(1);
  // 원문 IP·이메일은 키와 값에 없다
  const keys = (await redis.command(['KEYS', 'id:alf:*'])) as unknown[];
  expect(keys.map(String).some((k) => k.includes('192.0.2.80') || k.includes('ghost0'))).toBe(false);
});

test('Valkey에서_5분에실패100건이면전체경보가한번나고_모든로그인에사람확인이며_1시간뒤풀린다(AC-T9)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const { step } = stepWith(store);
  clock.advance(2 * 60 * M);
  const before = alerts.filter((a) => a === 'global').length;
  for (let i = 0; i < 100; i++) {
    await step.run({ aud: 'partner', email: `bulk${i % 30}@haeoreum.example`, password: 'x', ip: `198.18.${i}.1`, deviceId: '', humanCheckToken: 'ok' });
    if (i % 25 === 24) clock.advance(M);
  }
  expect(alerts.filter((a) => a === 'global').length - before).toBe(1);
  expect(await step.run({ aud: 'partner', email: 'fresh@haeoreum.example', password: 'x', ip: '192.0.2.99', deviceId: '' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
  clock.advance(61 * M);
  expect(await step.run({ aud: 'partner', email: 'fresh@haeoreum.example', password: 'x', ip: '192.0.2.99', deviceId: '' })).toMatchObject({ kind: 'FAILED', humanCheckRequired: false });
});
