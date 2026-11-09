// 이용 제한 중 탈퇴의 대조값 보관 PostgreSQL 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §8 '대조값 보관의 첫 구현', BUILD_ORDER BOT-035, I-T68).
// 마이그레이션 0010(restricted_ci_hold, 기본 키 (ci_hmac, fraud_case_id), 상태 CHECK)과 저장소의 잇기·끝 조회·지우기를 실제 SQL로 본다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { identityMaintenanceTasks } from '../src/maintenance-tasks.js';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { VerificationHolds } from '../src/modules/verification/adapters/verification-holds.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { GetVerificationResult } from '../src/modules/verification/application/get-verification-result.js';
import { SetRestrictedCiHold } from '../src/modules/verification/application/set-restricted-ci-hold.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, ISSUER, kit, newKey, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
const DAY = 86_400_000;
const CASE = '0190f3a1-7c2e-7a00-8000-00000000ca5d';

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-fraud-hold-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];
const payload = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

test('I-T68_PostgreSQL에서_RESTRICTED보관행은탈퇴뒤에도남고_다시가입한계정에이어restrictedUntil과ticket:buy빼기를주며_RELEASED·끝지남·정비로지워진다', async () => {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const closure = new CloseAccount(sessions, clock);
  const claims = new VerificationClaims(verifications, closure, clock);
  const k = await kit(sessions, { claims, clock, reverifications: claims });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const hold = new SetRestrictedCiHold(verifications, clock);
  const withdraw = new WithdrawAccount(sessions, new JoseReauthVerifier(k.keys, ISSUER, clock), new VerificationEraser(verifications), clock, new VerificationHolds(verifications));
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: null, deviceId: null });
  const verify = async (accountId: string) => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    await new ConfirmVerification(verifications, provider, hashers, closure, clock).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: 'pg-hold-person' }) });
    return new GetVerificationResult(verifications, clock).run({ accountId, verificationId: st.verificationId });
  };

  const a = await login('pg-hold-1');
  await verify(a.accountId);
  const until = clock.now() + 60 * DAY;
  expect(await hold.run({ accountId: a.accountId, fraudCaseId: CASE, state: 'RESTRICTED', until, version: 5 })).toBe('OK');
  // 같은 판·같은 내용의 재전송은 OK, 같은 판의 다른 내용은 STALE
  expect(await hold.run({ accountId: a.accountId, fraudCaseId: CASE, state: 'RESTRICTED', until, version: 5 })).toBe('OK');
  expect(await hold.run({ accountId: a.accountId, fraudCaseId: CASE, state: 'RESTRICTED', until: until + DAY, version: 5 })).toBe('STALE');
  // 멱등 키 (계정, 사건)은 한 행이다(DB 기본 키)
  await expect(q("insert into restricted_ci_hold select decode('00', 'hex'), 1, fraud_case_id, state, until, source_account_id, null, 1 from restricted_ci_hold")).rejects.toThrow(/restricted_ci_hold_source_account_id_fraud_case_id_pk/);
  // 상태 CHECK: RELEASED는 행으로 두지 않는다
  await expect(q("update restricted_ci_hold set state = 'RELEASED'")).rejects.toThrow(/restricted_ci_hold_state_check/);
  const token = (await k.signer.reauth({ accountId: a.accountId, sessionId: a.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  await withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: { acknowledgeFraudHold: true } });
  expect(await q('select 1 from identity_verification where account_id = $1', [a.accountId])).toHaveLength(0);
  expect(await q('select state, version::int as version from restricted_ci_hold where source_account_id = $1', [a.accountId])).toEqual([{ state: 'RESTRICTED', version: 5 }]);

  const b = await login('pg-hold-1');
  expect(await verify(b.accountId)).toMatchObject({ status: 'VERIFIED', restrictedUntil: new Date(until).toISOString() });
  expect(await q('select carried_account_id from restricted_ci_hold where source_account_id = $1', [a.accountId])).toEqual([{ carried_account_id: b.accountId }]);
  expect(payload((await login('pg-hold-1')).accessToken).scope).toBeUndefined();
  // 탈퇴한 처음 계정 ID로 RELEASED(더 큰 판)를 부르면 행이 지워지고 ticket:buy가 다시 실린다
  expect(await hold.run({ accountId: a.accountId, fraudCaseId: CASE, state: 'RELEASED', until: null, version: 6 })).toBe('OK');
  expect(await q('select 1 from restricted_ci_hold')).toHaveLength(0);
  expect(payload((await login('pg-hold-1')).accessToken).scope).toBe('ticket:buy');

  // 끝이 지난 행은 정비(restricted-hold-expired)가 지운다
  expect(await hold.run({ accountId: b.accountId, fraudCaseId: CASE, state: 'CASE_OPEN', until: clock.now() + 5 * DAY, version: 1 })).toBe('OK');
  clock.advance(6 * DAY);
  await ensureOutboxPartitions(database, clock);
  const task = identityMaintenanceTasks(database, clock).find((x) => x.name === 'restricted-hold-expired')!;
  await task.run();
  expect(await q('select 1 from restricted_ci_hold')).toHaveLength(0);
});
