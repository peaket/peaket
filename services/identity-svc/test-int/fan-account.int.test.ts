// 팬 계정 요약·세션 종료 사유·가입 마무리의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현',
// BUILD_ORDER BOT-047, ADR-0235, I-T77~I-T82). 마이그레이션 0029와 실제 SQL(동시 가입 마무리, 닉네임 키 UNIQUE, 끝난 까닭 칸, 정비)을 돈다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { MemoryNicknameCheckLimits } from '../src/modules/session/adapters/memory-nickname-check-limits.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CancelSignup } from '../src/modules/session/application/cancel-signup.js';
import { CheckNickname } from '../src/modules/session/application/check-nickname.js';
import { CompleteSignup, SignupError } from '../src/modules/session/application/complete-signup.js';
import { GetAccountSummary } from '../src/modules/session/application/get-account-summary.js';
import { PurgeIncompleteSignups } from '../src/modules/session/application/purge-incomplete-signups.js';
import type { AccountClaims } from '../src/modules/session/domain/ports.js';
import { CONSENT_NOTICE_VERSIONS, INCOMPLETE_SIGNUP_PURGE_MS } from '../src/modules/session/domain/signup.js';
import { SESSION_IDLE_MS } from '../src/modules/session/domain/session.js';
import { kit, newKey } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T03:00:00.000Z') });

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-fan-account-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const FORM = { ageOver14: true as const, consents: { terms: true as const, privacy: true as const, marketing: true, phone: true }, nickname: 'Peaket', phone: '01012345678' };
let n = 0;

async function setup() {
  const sessions = new DrizzleSessionStore(database, clock);
  const claims: AccountClaims = { of: async () => ({ scopes: [] }) };
  const k = await kit(sessions, { clock, claims });
  const summary = new GetAccountSummary(sessions, claims, { hasAssigned: async () => false }, clock);
  const complete = new CompleteSignup(sessions, summary, clock, k.signals);
  const login = (sub = `sub-${n++}`) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: `${sub}@example.test`, emailVerified: true, deviceId: `dev-${sub}` });
  return { sessions, k, summary, complete, login, claims, check: new CheckNickname(sessions, new MemoryNicknameCheckLimits(clock), clock, k.signals), cancel: new CancelSignup(sessions, clock, k.signals) };
}

const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof SignupError || e instanceof AccountError) return e.code;
    throw e;
  }
};
const unique = () => `닉${Date.now().toString(36).slice(-4)}${n++}`;

test('I-T77 가입을 마치면 계정 요약이 바뀌고 동의·회원 코드가 저장되며 휴대폰 번호는 동의했을 때만 남는다 [ASVS v5.0.0-14.3.2]', async () => {
  const t = await setup();
  const s = await t.login();
  expect(await t.summary.run({ accountId: s.accountId, sessionId: s.sessionId })).toMatchObject({ nickname: null, signupCompleted: false });
  const nickname = unique();
  await t.complete.run({ accountId: s.accountId, sessionId: s.sessionId, input: { ...FORM, nickname } });
  expect(await t.summary.run({ accountId: s.accountId, sessionId: s.sessionId })).toMatchObject({ nickname, signupCompleted: true });
  const [a] = await q<{ age_verified: boolean; phone: string; member_code: string; nickname_key: string }>('select age_verified, phone, member_code, nickname_key from account where id = $1', [s.accountId]);
  expect(a?.age_verified).toBe(true);
  expect(a?.phone).toBe('01012345678');
  expect(a?.member_code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(a?.nickname_key).toBe(nickname.toLowerCase());
  const rows = await q<{ kind: string; notice_version: string; channels: string | null }>('select kind, notice_version, channels from consent where account_id = $1 order by kind', [s.accountId]);
  expect(rows.map((r) => r.kind)).toEqual(['MARKETING', 'PRIVACY_PHONE', 'PRIVACY_REQUIRED', 'TERMS']);
  expect(rows.find((r) => r.kind === 'MARKETING')?.channels).toBe('EMAIL,PUSH');
});

test('I-T78 세션을 끝내면 끝난 까닭이 세션 행에 남고 갱신 401에 실린다 [ASVS v5.0.0-7.4.1]', async () => {
  const t = await setup();
  const s = await t.login();
  await t.sessions.transaction((tx) => tx.terminateSessions([s.sessionId], 'LOGIN_METHOD_CHANGED', clock.now()));
  const [row] = await q<{ terminated_reason: string }>('select terminated_reason from session where id = $1', [s.sessionId]);
  expect(row?.terminated_reason).toBe('LOGIN_METHOD_CHANGED');
  expect(await t.k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'INVALID', ended: 'LOGIN_METHOD_CHANGED' });
  const unknownToken = 'x'.repeat(43);
  expect(await t.k.refresh.run({ refreshToken: unknownToken })).toEqual({ result: 'INVALID' });
});

test('I-T79_⑤ 같은 계정의 가입 마무리가 동시에 두 번 와도 하나만 성공한다', async () => {
  const t = await setup();
  const s = await t.login();
  const input = { ...FORM, nickname: unique(), phone: undefined, consents: { ...FORM.consents, phone: false, marketing: false } };
  const results = await Promise.all([t.complete.run({ accountId: s.accountId, sessionId: s.sessionId, input }), t.complete.run({ accountId: s.accountId, sessionId: s.sessionId, input })].map(outcome));
  expect(results.sort()).toEqual(['ALREADY_COMPLETED', 'OK']);
  const [{ c }] = await q<{ c: string }>('select count(*)::text as c from consent where account_id = $1', [s.accountId]) as [{ c: string }];
  expect(c).toBe('2');
});

test('I-T80_④ 두 계정이 같은 닉네임을 동시에 고르면 한쪽만 성공하고 뒤쪽은 NICKNAME_TAKEN이다', async () => {
  const t = await setup();
  const a = await t.login();
  const b = await t.login();
  const nickname = unique();
  const input = { ...FORM, nickname, phone: undefined, consents: { ...FORM.consents, phone: false, marketing: false } };
  const results = await Promise.all([t.complete.run({ accountId: a.accountId, sessionId: a.sessionId, input }), t.complete.run({ accountId: b.accountId, sessionId: b.sessionId, input })].map(outcome));
  expect(results.sort()).toEqual(['NICKNAME_TAKEN', 'OK']);
  const c = await t.login();
  expect(await t.check.run({ accountId: c.accountId, sessionId: c.sessionId, nickname: nickname.toUpperCase() })).toEqual({ available: false, reason: 'taken' });
});

test('I-T80_⑥ 계정을 지우면 닉네임 키·동의 행이 사라져 그 닉네임을 다시 쓸 수 있다', async () => {
  const t = await setup();
  const a = await t.login();
  const nickname = unique();
  await t.complete.run({ accountId: a.accountId, sessionId: a.sessionId, input: { ...FORM, nickname, phone: undefined, consents: { ...FORM.consents, phone: false, marketing: false } } });
  await t.sessions.transaction(async (tx) => {
    await tx.lockAccount(a.accountId);
    await tx.eraseAccount(a.accountId, clock.now());
  });
  expect(await q('select 1 from consent where account_id = $1', [a.accountId])).toEqual([]);
  const b = await t.login();
  expect(await t.check.run({ accountId: b.accountId, sessionId: b.sessionId, nickname })).toEqual({ available: true });
});

test('I-T81 가입 취소는 정리 중 표시와 세션 끝내기를 한 트랜잭션에 쓴다', async () => {
  const t = await setup();
  const s = await t.login();
  await t.cancel.run({ accountId: s.accountId, sessionId: s.sessionId });
  const [a] = await q<{ status: string; closure_reason: string }>('select status, closure_reason from account where id = $1', [s.accountId]);
  expect(a).toMatchObject({ status: 'WITHDRAWAL_PENDING', closure_reason: 'UNDER_14' });
  const rows = await q<{ terminated_reason: string }>('select terminated_reason from session where account_id = $1', [s.accountId]);
  expect(rows.map((r) => r.terminated_reason)).toEqual(['DELETE']);
});

test('I-T79_⑧ 동의 행의 고지 문안 판은 동의마다 문서의 시행일이다', async () => {
  const t = await setup();
  const s = await t.login();
  await t.complete.run({ accountId: s.accountId, sessionId: s.sessionId, input: { ...FORM, nickname: unique() } });
  const rows = await q<{ kind: string; notice_version: string }>('select kind, notice_version from consent where account_id = $1', [s.accountId]);
  expect(Object.fromEntries(rows.map((r) => [r.kind, r.notice_version]))).toEqual(CONSENT_NOTICE_VERSIONS);
});

test('I-T78_⑦ 이미 끝난 세션을 다른 까닭으로 또 끝내도 첫 까닭이 남는다', async () => {
  const t = await setup();
  const s = await t.login();
  await t.sessions.transaction((tx) => tx.terminateSessions([s.sessionId], 'LOGIN_METHOD_CHANGED', clock.now()));
  await t.sessions.transaction((tx) => tx.terminateSessions([s.sessionId], 'DELETE', clock.now()));
  expect(await q('select terminated_reason from session where id = $1', [s.sessionId])).toEqual([{ terminated_reason: 'LOGIN_METHOD_CHANGED' }]);
});

test('I-T80_⑥ 흡수로 닉네임이 지워지면 키·동의 행이 사라져 그 닉네임을 다시 쓸 수 있다', async () => {
  const t = await setup();
  const absorbed = await t.login();
  const primary = await t.login();
  const nickname = unique();
  await t.complete.run({ accountId: absorbed.accountId, sessionId: absorbed.sessionId, input: { ...FORM, nickname } });
  await t.sessions.transaction((tx) => tx.mergeAccounts({ mergeId: uuidv7(clock), primaryAccountId: primary.accountId, absorbedAccountId: absorbed.accountId, mergedProvider: 'kakao', moved: {}, requestedAt: clock.now(), now: clock.now() }));
  expect(await q('select nickname_key from account where id = $1', [absorbed.accountId])).toEqual([{ nickname_key: null }]);
  expect(await q('select 1 from consent where account_id = $1', [absorbed.accountId])).toEqual([]);
  const other = await t.login();
  expect(await t.check.run({ accountId: other.accountId, sessionId: other.sessionId, nickname })).toEqual({ available: true });
});

test('I-T82 정비는 30일이 지나고 세션이 없는 가입 전 계정만 지운다', async () => {
  const t = await setup();
  const old = await t.login();
  // 가입을 끝내지 못하고 동의 행만 남은 계정도 함께 지운다(I-T82 ③)
  await q("insert into consent (id, account_id, kind, notice_version, agreed_at) values ($1, $2, 'TERMS', '2026-11-01', now())", [uuidv7(clock), old.accountId]);
  // 본인확인을 마친 계정은 지우지 않는다(I-T82 ④)
  const verified = await t.login();
  await q("insert into identity_verification (account_id, ci_hmac, ci_hmac_key_version, pid, pid_key_version, verified_at, source_record) values ($1, $2, 1, $3, 1, now(), 'test')", [verified.accountId, Buffer.alloc(32, 9), Buffer.alloc(32, 8)]);
  clock.advance(SESSION_IDLE_MS + 1);
  const fresh = await t.login();
  clock.advance(INCOMPLETE_SIGNUP_PURGE_MS - SESSION_IDLE_MS);
  await ensureOutboxPartitions(database, clock);
  const r = await new PurgeIncompleteSignups(t.sessions, clock).run();
  expect(r.purged).toBeGreaterThanOrEqual(1);
  const [a] = await q<{ status: string; email: string | null }>('select status, email from account where id = $1', [old.accountId]);
  expect(a).toMatchObject({ status: 'DELETED', email: null });
  expect(await q('select 1 from consent where account_id = $1', [old.accountId])).toEqual([]);
  expect(await q('select 1 from account_provider where account_id = $1', [old.accountId])).toEqual([]);
  expect(await q('select status from account where id = $1', [verified.accountId])).toEqual([{ status: 'ACTIVE' }]);
  const [b] = await q<{ status: string }>('select status from account where id = $1', [fresh.accountId]);
  expect(b?.status).toBe('ACTIVE');
});
