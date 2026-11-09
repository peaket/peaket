// 관리 계정 패스키와 재인증의 통합 시험(실제 PostgreSQL 18·Valkey 8.1, docs/features/identity.md §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, I-T53 ②③④).
// 마이그레이션 0027(admin_passkey·admin_reauth·알림 종류), 계정 행 잠금 안의 10개 상한·자격 ID 고유 색인·서명 횟수 조건부 갱신, 세션·캐시 Redis의 id:wa 키(GETDEL 한 번)를 실제로 돈다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { passkeyChallengeKey, RedisPasskeyChallenges } from '../src/modules/admin/adapters/redis-passkey-challenges.js';
import { kitOf, passkeyCases, type PasskeyStoreUnderTest } from '../test/passkey-cases.js';
import { SoftAuthenticator } from '../test/soft-authenticator.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let pg: PostgresContainer;
let vk: ValkeyContainer;
let database: Database;
let redis: HotRedis;

beforeAll(async () => {
  [pg, vk] = await Promise.all([startPostgres(), startValkey()]);
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-passkey-test', max: 8 });
  await ensureOutboxPartitions(database, fakeClock({ now: Date.now() }));
  redis = await createHotRedis({ url: vk.url });
});

afterAll(async () => {
  await redis?.close();
  await database?.close();
  pg?.stop();
  vk?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

const make = async (): Promise<PasskeyStoreUnderTest> => {
  const clock = fakeClock({ now: Date.now() });
  return {
    store: new DrizzleAdminAccountStore(database, clock),
    clock,
    challenges: new RedisPasskeyChallenges(redis),
    reauthRows: async (id) =>
      (
        await q<{ act: string; factors: string[]; used_at: Date | null; admin_session_id: string }>('select act, factors, used_at, admin_session_id from admin_reauth where admin_account_id = $1 order by issued_at, jti', [id])
      ).map((r) => ({ act: r.act, factors: r.factors, usedAt: r.used_at ? r.used_at.getTime() : null, sessionId: r.admin_session_id })),
    notices: async (id) => (await q<{ kind: string }>('select kind from admin_security_notice where admin_account_id = $1 order by created_at, id', [id])).map((r) => r.kind),
  };
};
passkeyCases('PostgreSQL·Valkey', make);

test('Valkey에서_패스키챌린지는id:wa키에5분수명으로두고_꺼내면지워져두번째는없다 [ASVS v5.0.0-6.7.2]', async () => {
  const challenges = new RedisPasskeyChallenges(redis);
  const handleHash = randomBytes(32).toString('hex');
  const now = Date.now();
  await challenges.put('REAUTH', handleHash, { kind: 'REAUTH', accountId: randomUUID(), sessionId: randomUUID(), aud: 'ops', challenge: randomBytes(32).toString('base64url'), expiresAt: now + 300_000, act: 'OPS_COMMAND', factors: ['password', 'totp'], allow: [] }, 300_000);
  const key = passkeyChallengeKey('REAUTH', handleHash);
  expect(key).toBe(`id:wa:rea:${handleHash}`);
  const ttl = Number(await redis.command(['PTTL', key], { key }));
  expect(ttl).toBeGreaterThan(290_000);
  expect(ttl).toBeLessThanOrEqual(300_000);
  expect((await challenges.take('REAUTH', handleHash, now))?.act).toBe('OPS_COMMAND');
  expect(await challenges.take('REAUTH', handleHash, now)).toBeNull();
  // 다른 종류의 키로는 꺼내지 못한다
  await challenges.put('REG', handleHash, { kind: 'REG', accountId: randomUUID(), sessionId: randomUUID(), aud: 'partner', challenge: 'x', expiresAt: now + 300_000 }, 300_000);
  expect(await challenges.take('REAUTH', handleHash, now)).toBeNull();
  expect((await challenges.take('REG', handleHash, now))?.kind).toBe('REG');
});

test('Valkey에서_등록ID·재인증단계값의원문은키와값에없고_그SHA-256만키이름에있다 [ASVS v5.0.0-6.7.2]', async () => {
  const k = await kitOf(await make());
  const a = await k.account('partner_admin');
  const sid = await k.login(a);
  const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
  const all = async () => {
    const keys = (await redis.command(['KEYS', 'id:wa:*'])) as (string | Buffer)[];
    return Promise.all(keys.map(async (raw) => {
      const key = String(raw);
      return { key, value: String(await redis.command(['GET', key], { key })) };
    }));
  };
  const begin = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY') });
  if (begin.kind !== 'OK') throw new Error(begin.kind);
  const regKeys = await all();
  expect(regKeys.map((x) => x.key)).toContain(`id:wa:reg:${sha(begin.registrationId)}`);
  for (const x of regKeys) expect(`${x.key}${x.value}`).not.toContain(begin.registrationId);
  const authn = new SoftAuthenticator();
  expect((await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: authn.register(begin.publicKey as never) })).kind).toBe('OK');
  // 꺼낸 등록 키는 남지 않는다
  expect((await all()).map((x) => x.key)).not.toContain(`id:wa:reg:${sha(begin.registrationId)}`);
  const p = k.passkeyStep(await k.start(a, sid, 'PAYOUT_ACCOUNT', { withPasskey: true }));
  const reaKeys = await all();
  expect(reaKeys.map((x) => x.key)).toContain(`id:wa:rea:${sha(p.reauthStep)}`);
  for (const x of reaKeys) expect(`${x.key}${x.value}`).not.toContain(p.reauthStep);
});

test('PostgreSQL에서_같은서명횟수의두확인이동시에오면하나만적힌다_자격ID는모든계정사이에서하나다', async () => {
  const clock = fakeClock({ now: Date.now() });
  const store = new DrizzleAdminAccountStore(database, clock);
  const a = randomUUID();
  const b = randomUUID();
  await store.create({ id: a, role: 'operator', email: `race.a.${a.slice(0, 6)}@peaket.example`, status: 'ACTIVE', now: clock.now() });
  await store.create({ id: b, role: 'operator', email: `race.b.${b.slice(0, 6)}@peaket.example`, status: 'ACTIVE', now: clock.now() });
  const credentialId = randomBytes(32);
  const row = { id: randomUUID(), accountId: a, credentialId, publicKey: randomBytes(77), signCount: 3, transports: ['usb'], deviceType: 'singleDevice' as const, backedUp: false, aaguid: '00000000-0000-0000-0000-000000000000', name: '보안 키', createdAt: clock.now(), lastUsedAt: null };
  expect(await store.addPasskey(row, 10, clock.now())).toBe('ADDED');
  expect(await store.addPasskey({ ...row, id: randomUUID(), accountId: b }, 10, clock.now())).toBe('EXISTS');
  const [x, y] = await Promise.all([store.recordPasskeyUse(row.id, 3, 4, false, clock.now()), store.recordPasskeyUse(row.id, 3, 4, false, clock.now())]);
  expect([x, y].filter(Boolean)).toHaveLength(1);
  expect((await q<{ sign_count: string }>('select sign_count from admin_passkey where id = $1', [row.id]))[0]!.sign_count).toBe('4');
  // 동시에 온 등록 둘이 상한 하나를 넘기지 못한다(계정 행 잠금)
  const c = randomUUID();
  await store.create({ id: c, role: 'operator', email: `race.c.${c.slice(0, 6)}@peaket.example`, status: 'ACTIVE', now: clock.now() });
  const results = await Promise.all([1, 2, 3].map(() => store.addPasskey({ ...row, id: randomUUID(), accountId: c, credentialId: randomBytes(32) }, 2, clock.now())));
  expect(results.filter((r) => r === 'ADDED')).toHaveLength(2);
  expect(results.filter((r) => r === 'LIMIT')).toHaveLength(1);
});
