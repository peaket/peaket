// PostgreSQL 저장소 통합 시험(실제 PostgreSQL 18 컨테이너): 단위 시험과 같은 유스케이스 묶음 + 같은 키가 겹쳐 오는 경우.
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { refreshCases } from '../test/refresh-cases.js';
import { sessionCases } from '../test/session-cases.js';
import { kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-svc-test', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const one = async <T>(q: ReturnType<typeof sql>): Promise<T | undefined> => (await database.db.execute(q)).rows[0] as T | undefined;

sessionCases('PostgreSQL', async () => {
  // 시험마다 빈 표에서 시작한다(메모리 저장소처럼)
  await database.db.execute(sql`truncate session_create_key, refresh_token_hash, session, device, account_provider, identity_verification, verification_attempt, account, outbox`);
  return {
  store: new DrizzleSessionStore(database, systemClock),
  refreshHashOf: async (id) => (await one<{ h: Buffer }>(sql`select refresh_hash as h from session where id = ${id}`))?.h ?? null,
  sessionCount: async (a) => Number((await one<{ n: string }>(sql`select count(*) as n from session where account_id = ${a} and terminated_at is null`))!.n),
  deviceRows: async (a) => Number((await one<{ n: string }>(sql`select count(*) as n from device where account_id = ${a}`))!.n),
  loginVerdictOf: async (id) => (await one<{ v: string }>(sql`select login_verdict as v from session where id = ${id}`))?.v ?? null,
  };
});

refreshCases('PostgreSQL', async () => ({
  store: new DrizzleSessionStore(database, systemClock),
  terminations: async (a) =>
    (
      await database.db.execute(
        sql`select convert_from(payload, 'UTF8')::jsonb as p from outbox where topic = 'control.sessions-terminated' and convert_from(payload, 'UTF8')::jsonb ->> 'accountId' = ${a} order by seq`,
      )
    ).rows.map((r) => [(r as { p: { sessionId: string } }).p.sessionId, (r as { p: { reason: string } }).p.reason]),
  isTerminated: async (id) => Boolean((await one<{ t: Date | null }>(sql`select terminated_at as t from session where id = ${id}`))?.t),
}));

test('I-T50_①_같은멱등키가_겹쳐와도_세션과기기행은하나다', async () => {
  const k = await kit(new DrizzleSessionStore(database, systemClock));
  const key = newKey();
  const input = { idempotencyKey: key, provider: 'google' as const, providerUserId: `g-${key.slice(0, 8)}`, email: 'fan@gmail.test', deviceId: 'dev-race' };
  // 앱 서버가 데드라인을 넘겨 같은 요청을 다시 보낸 경우: 둘이 거의 같이 도착한다
  const [a, b, c] = await Promise.all([k.create.run(input), k.create.run(input), k.create.run(input)]);
  expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(1);
  expect([a, b, c].filter((r) => !r.replayed)).toHaveLength(1);
  const n = await one<{ s: string; d: string }>(
    sql`select (select count(*) from session where account_id = ${a.accountId}) as s, (select count(*) from device where account_id = ${a.accountId}) as d`,
  );
  expect(n).toEqual({ s: '1', d: '1' });
});

test('I-T50_②_같은멱등키에다른요청은_지문으로거절하고아무것도남기지않는다', async () => {
  const k = await kit(new DrizzleSessionStore(database, systemClock));
  const key = newKey();
  await k.create.run({ idempotencyKey: key, provider: 'kakao', providerUserId: `k-${key.slice(0, 8)}`, email: null, deviceId: null });
  const before = await one<{ n: string }>(sql`select count(*) as n from account`);
  await expect(k.create.run({ idempotencyKey: key, provider: 'kakao', providerUserId: `other-${key.slice(0, 8)}`, email: null, deviceId: null })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  expect(await one<{ n: string }>(sql`select count(*) as n from account`)).toEqual(before);
});

test('I-T50_처음로그인하는같은제공자계정이_다른멱등키로동시에와도_계정은하나이고둘다성공한다', async () => {
  const k = await kit(new DrizzleSessionStore(database, systemClock));
  const sub = `race-${newKey().slice(0, 10)}`;
  const go = () => k.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: sub, email: null, deviceId: `d-${newKey().slice(0, 6)}` });
  const rs = await Promise.all([go(), go(), go()]);
  expect(new Set(rs.map((r) => r.accountId)).size).toBe(1);
  expect(rs.filter((r) => r.newAccount)).toHaveLength(1);
});

test('POL019_다른멱등키로동시에온로그인도_활성기기는다섯대를넘지않는다', async () => {
  const k = await kit(new DrizzleSessionStore(database, systemClock));
  const sub = `limit-${newKey().slice(0, 10)}`;
  const at = (d: string) => ({ idempotencyKey: newKey(), provider: 'google' as const, providerUserId: sub, email: null, deviceId: d });
  const first = await k.create.run(at('dev-0'));
  for (let d = 1; d <= 3; d++) {
    k.clock.advance(1_000);
    await k.create.run(at(`dev-${d}`));
  }
  k.clock.advance(1_000);
  await Promise.all([k.create.run(at('dev-4')), k.create.run(at('dev-5')), k.create.run(at('dev-6'))]);
  const n = await one<{ d: string }>(
    sql`select count(distinct coalesce(device_id::text, id::text)) as d from session where account_id = ${first.accountId} and terminated_at is null`,
  );
  expect(Number(n!.d)).toBe(5);
});

test('asyncapi_세션종료사건의Kafka키는_계정ID다', async () => {
  const k = await kit(new DrizzleSessionStore(database, systemClock));
  const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `key-${newKey().slice(0, 8)}`, email: null, deviceId: null });
  await k.end.run({ sessionId: s.sessionId, accountId: s.accountId });
  const r = await one<{ k: string }>(sql`select msg_key as k from outbox where topic = 'control.sessions-terminated' and convert_from(payload, 'UTF8')::jsonb ->> 'sessionId' = ${s.sessionId}`);
  expect(r?.k).toBe(s.accountId);
});

test('I-T4_같은토큰으로갱신이동시에와도_하나는회전하고하나는재시도로받아_세션이이어진다', async () => {
  const k = await kit(new DrizzleSessionStore(database, systemClock));
  const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `rr-${newKey().slice(0, 8)}`, email: null, deviceId: null });
  const rs = await Promise.all([k.refresh.run({ refreshToken: s.refreshToken }), k.refresh.run({ refreshToken: s.refreshToken })]);
  expect(rs.map((r) => r.result)).toEqual(['OK', 'OK']);
  expect(k.signals.seen.filter((x) => x.startsWith('refresh:')).sort()).toEqual(['refresh:fan:retried', 'refresh:fan:rotated']);
  expect(Boolean((await one<{ t: Date | null }>(sql`select terminated_at as t from session where id = ${s.sessionId}`))?.t)).toBe(false);
});

