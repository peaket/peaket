// 설정의 로그인 수단 연결·해제의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34).
// 마이그레이션 0012(account_provider.last_login_at)와 연결·해제 사건 Outbox를 실제 SQL로 돈다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { ListProviders } from '../src/modules/session/application/list-providers.js';
import { UnlinkProvider } from '../src/modules/session/application/unlink-provider.js';
import { ISSUER, kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-login-methods-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('I-T33·I-T34_PostgreSQL에서_로그인때last_login_at을적고_추가·해제는연결사건을Outbox에적으며_마지막하나는409로되돌린다', async () => {
  const sessions = new DrizzleSessionStore(database, clock);
  const k = await kit(sessions, { clock });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, clock);
  const add = new AddProvider(sessions, reauth, clock);
  const unlink = new UnlinkProvider(sessions, reauth, clock);
  const token = async (s: { accountId: string; sessionId: string }) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  const a = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-lm-k', email: null, deviceId: null });
  expect(await q('select last_login_at from account_provider where provider_user_id = $1', ['pg-lm-k'])).toEqual([{ last_login_at: new Date(clock.now()) }]);
  // 마지막 하나는 409이고 지우지 않는다
  const last = await unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await token(a), provider: 'kakao' }).catch((e: unknown) => e);
  expect(last instanceof AccountError && last.code).toBe('LAST_LOGIN_METHOD');
  expect(await q('select 1 from account_provider where account_id = $1', [a.accountId])).toHaveLength(1);
  clock.advance(1_000);
  expect(await add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await token(a), provider: 'google', providerUserId: 'pg-lm-g' })).toBe('LINKED');
  expect((await new ListProviders(sessions).run(a.accountId)).map((p) => [p.provider, p.lastLoginAt === null])).toEqual([
    ['kakao', false],
    ['google', true],
  ]);
  await unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await token(a), provider: 'google' });
  const events = await q<{ payload: Buffer }>("select payload from outbox where topic = 'identity.login-methods-changed' and msg_key = $1 order by seq", [a.accountId]);
  expect(events.map((e) => JSON.parse(e.payload.toString()))).toEqual([
    { eventKey: expect.any(String), accountId: a.accountId, change: 'LINKED', provider: 'google', occurredAt: new Date(clock.now()).toISOString() },
    { eventKey: expect.any(String), accountId: a.accountId, change: 'UNLINKED', provider: 'google', occurredAt: new Date(clock.now()).toISOString() },
  ]);
  expect(await q("select 1 from account_provider where provider = 'google' and provider_user_id = 'pg-lm-g'")).toHaveLength(0);
});
