// 팬의 로그인한 기기와 다른 세션 끝내기의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현',
// BUILD_ORDER BOT-044, ADR-0209, I-T74·I-T75·I-T76). 마이그레이션 0028(session.device_label·last_active_at, 기기 이름 부분 인덱스)과
// 목록·원격 로그아웃·로그인 수단을 바꾼 뒤 세션 끝내기·정비의 실제 SQL을 돈다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { EndDeviceSession } from '../src/modules/session/application/end-device-session.js';
import { ListSessions } from '../src/modules/session/application/list-sessions.js';
import { UnlinkProvider } from '../src/modules/session/application/unlink-provider.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/modules/session/domain/session.js';
import { ISSUER, kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T03:00:00.000Z') });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-device-sessions-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';

async function setup() {
  const sessions = new DrizzleSessionStore(database, clock);
  const k = await kit(sessions, { clock });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, clock);
  const login = (sub: string, deviceId: string | null, userAgent?: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: null, deviceId, userAgent });
  const token = async (s: { accountId: string; sessionId: string }) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  return {
    sessions,
    k,
    login,
    token,
    list: new ListSessions(sessions, clock),
    end: new EndDeviceSession(sessions, reauth, clock, k.signals),
    add: new AddProvider(sessions, reauth, clock, undefined, k.signals),
    unlink: new UnlinkProvider(sessions, reauth, clock, k.signals),
  };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError) return e.code;
    throw e;
  }
};
/** 그 계정의 세션 종료 사건과 연결·해제 사건(적힌 차례) */
const events = async (accountId: string) =>
  (await q<{ topic: string; payload: Buffer }>("select topic, payload from outbox where msg_key = $1 and topic in ('control.sessions-terminated', 'identity.login-methods-changed') order by seq", [accountId])).map((r) => {
    const v = JSON.parse(r.payload.toString()) as { sessionId?: string; reason?: string; change?: string };
    return r.topic === 'control.sessions-terminated' ? [v.sessionId, v.reason] : [r.topic, v.change];
  });
const alive = async (id: string) => (await q<{ t: Date | null }>('select terminated_at as t from session where id = $1', [id]))[0]?.t === null;

test('I-T74·I-T76_PostgreSQL에서_로그인때기기이름·마지막활동을적고_목록은기기마다한줄이며_원격로그아웃은그기기의세션을끝내고LOGOUT사건을Outbox에적는다 [ASVS v5.0.0-7.5.2] [ASVS v5.0.0-7.4.1]', async () => {
  const t = await setup();
  const p1 = await t.login('pg-ds-1', 'dev-phone', SAMSUNG);
  clock.advance(1_000);
  const p2 = await t.login('pg-ds-1', 'dev-phone', SAMSUNG);
  clock.advance(1_000);
  const bare = await t.login('pg-ds-1', null, 'curl/8.9.1');
  clock.advance(1_000);
  const me = await t.login('pg-ds-1', 'dev-pc', CHROME_WIN);
  expect(await q('select device_label, last_active_at from session where id = $1', [p1.sessionId])).toEqual([{ device_label: 'Samsung Internet · Android', last_active_at: new Date(clock.now() - 3_000) }]);
  // User-Agent 원문과 판 번호는 어느 칸에도 없다
  expect(await q("select 1 from session s where to_jsonb(s)::text like '%SM-S928N%' or to_jsonb(s)::text like '%28.0%' or to_jsonb(s)::text like '%curl%'")).toHaveLength(0);
  expect(await t.list.run({ accountId: me.accountId, sessionId: me.sessionId })).toEqual([
    { sessionId: me.sessionId, deviceName: 'Chrome · Windows', lastActiveAt: new Date(clock.now()).toISOString(), current: true, otherSessions: 0 },
    { sessionId: bare.sessionId, deviceName: null, lastActiveAt: new Date(clock.now() - 1_000).toISOString(), current: false, otherSessions: 0 },
    { sessionId: p2.sessionId, deviceName: 'Samsung Internet · Android', lastActiveAt: new Date(clock.now() - 2_000).toISOString(), current: false, otherSessions: 1 },
  ]);
  expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: p1.sessionId })).toEqual({ ended: 2 });
  expect([await alive(p1.sessionId), await alive(p2.sessionId), await alive(bare.sessionId), await alive(me.sessionId)]).toEqual([false, false, true, true]);
  expect((await events(me.accountId)).sort()).toEqual([
    [p1.sessionId, 'LOGOUT'],
    [p2.sessionId, 'LOGOUT'],
  ].sort());
  // 끝난 세션의 리프레시 토큰 해시와 기기 이름은 같은 트랜잭션에서 지운다
  expect(await q('select 1 from refresh_token_hash where session_id = any($1::uuid[])', [[p1.sessionId, p2.sessionId]])).toHaveLength(0);
  expect(await q('select device_label from session where id = any($1::uuid[])', [[p1.sessionId, p2.sessionId]])).toEqual([{ device_label: null }, { device_label: null }]);
  // 갱신하면 마지막 활동이 지금이다
  clock.advance(60_000);
  expect((await t.k.refresh.run({ refreshToken: me.refreshToken })).result).toBe('OK');
  expect(await q('select last_active_at from session where id = $1', [me.sessionId])).toEqual([{ last_active_at: new Date(clock.now()) }]);
});

test('I-T74_PostgreSQL에서_남의세션·끝난세션·없는ID는같은404이고되돌려재인증토큰을쓰지않으며_지금기기줄은지금세션만남긴다 [ASVS v5.0.0-8.2.2]', async () => {
  const t = await setup();
  const stranger = await t.login('pg-ds-x', 'dev-x');
  const gone = await t.login('pg-ds-2', 'dev-gone');
  await t.k.end.run({ sessionId: gone.sessionId, accountId: gone.accountId });
  const other = await t.login('pg-ds-2', 'dev-other');
  const sibling = await t.login('pg-ds-2', 'dev-me');
  const me = await t.login('pg-ds-2', 'dev-me');
  const tok = await t.token(me);
  for (const target of [stranger.sessionId, gone.sessionId, '0190f3a1-7c2e-7a00-8000-0000000000fd']) {
    expect(await code(t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, targetSessionId: target }))).toBe('SESSION_NOT_FOUND');
  }
  expect(await q('select 1 from reauth_token_use where account_id = $1', [me.accountId])).toHaveLength(0);
  expect(await alive(stranger.sessionId)).toBe(true);
  expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, targetSessionId: other.sessionId })).toEqual({ ended: 1 });
  expect(await q('select 1 from reauth_token_use where account_id = $1', [me.accountId])).toHaveLength(1);
  // 지금 기기 줄을 끄면 지금 세션만 남기고 같은 기기의 다른 세션(sibling)을 끝낸다(새 맥락 리뷰 중간 1)
  expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: me.sessionId })).toEqual({ ended: 1 });
  expect([await alive(sibling.sessionId), await alive(me.sessionId)]).toEqual([false, true]);
  // 두 탭이 같은 기기를 끄면 뒤 쪽은 404다(사건은 한 번)
  expect(await code(t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: other.sessionId }))).toBe('SESSION_NOT_FOUND');
  expect((await events(me.accountId)).filter(([id]) => id === other.sessionId)).toHaveLength(1);
});

test('새맥락리뷰낮음4_PostgreSQL에서_남의세션행은잠그지않는다(다른트랜잭션이그행을잡고있어도404가바로나온다)', async () => {
  const t = await setup();
  const stranger = await t.login('pg-ds-lock-x', 'dev-lx');
  const me = await t.login('pg-ds-lock', 'dev-lm');
  const holder = await database.pool.connect();
  try {
    await holder.query('begin');
    await holder.query('select 1 from session where id = $1 for update', [stranger.sessionId]);
    const started = Date.now();
    const out = await Promise.race([
      code(t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: stranger.sessionId })),
      new Promise((r) => setTimeout(() => r('WAITED'), 3_000)),
    ]);
    expect(out).toBe('SESSION_NOT_FOUND');
    expect(Date.now() - started).toBeLessThan(3_000);
  } finally {
    await holder.query('rollback');
    holder.release();
  }
});

test('I-T75_PostgreSQL에서_로그인수단추가·해제는이세션말고다른세션을끝내고_LOGIN_METHOD_CHANGED사건을연결·해제사건보다먼저Outbox에적는다 [ASVS v5.0.0-7.4.3]', async () => {
  const t = await setup();
  const phone = await t.login('pg-ds-3', 'dev-phone');
  const me = await t.login('pg-ds-3', 'dev-pc');
  expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'kakao', providerUserId: 'pg-ds-3' })).toBe('ALREADY_LINKED');
  expect(await alive(phone.sessionId)).toBe(true);
  expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'google', providerUserId: 'pg-ds-3-g' })).toBe('LINKED');
  const again = await t.login('pg-ds-3', 'dev-phone');
  await t.unlink.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'google' });
  expect([await alive(phone.sessionId), await alive(again.sessionId), await alive(me.sessionId)]).toEqual([false, false, true]);
  expect(await events(me.accountId)).toEqual([
    [phone.sessionId, 'LOGIN_METHOD_CHANGED'],
    ['identity.login-methods-changed', 'LINKED'],
    [again.sessionId, 'LOGIN_METHOD_CHANGED'],
    ['identity.login-methods-changed', 'UNLINKED'],
  ]);
});

test('I-T76_PostgreSQL에서_유휴만료로끝난세션의기기이름은절대만료뒤정비가지운다', async () => {
  const t = await setup();
  const s = await t.login('pg-ds-4', 'dev-idle', CHROME_WIN);
  clock.advance(SESSION_IDLE_MS + 1);
  await t.sessions.clearEndedDeviceLabels(clock.now());
  expect(await q('select device_label from session where id = $1', [s.sessionId])).toEqual([{ device_label: 'Chrome · Windows' }]);
  clock.advance(SESSION_ABSOLUTE_MS - SESSION_IDLE_MS);
  expect(await t.sessions.clearEndedDeviceLabels(clock.now())).toBeGreaterThanOrEqual(1);
  expect(await q('select device_label from session where id = $1', [s.sessionId])).toEqual([{ device_label: null }]);
  expect(await q('select 1 from session where device_label is not null and absolute_expires_at <= $1', [new Date(clock.now())])).toHaveLength(0);
});
