// 이용 제한 중 탈퇴의 대조값 보관(docs/features/identity.md §8 '대조값 보관의 첫 구현', BUILD_ORDER BOT-035, I-T68, ADR-0171 결정 5, ADR-0173 결정 7).
// 메모리 저장소로 SetRestrictedCiHold, 탈퇴 409 fraudHold, 다시 가입한 계정에 잇기·restrictedUntil·ticket:buy 빼기, 정비 지우기를 본다. PostgreSQL은 test-int/fraud-hold.int.test.ts.
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import { identityPackage } from '../src/modules/session/inbound/session.grpc.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { VerificationHolds } from '../src/modules/verification/adapters/verification-holds.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { GetVerificationResult } from '../src/modules/verification/application/get-verification-result.js';
import { SetRestrictedCiHold, RestrictedCiHoldError } from '../src/modules/verification/application/set-restricted-ci-hold.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { restrictedCiHoldHandlers } from '../src/modules/verification/inbound/restricted-ci-hold.grpc.js';
import { assertKeyVersions } from '../src/modules/verification/application/key-versions.js';
import { DrizzleQueryError } from 'drizzle-orm';
import { agencyResult, ISSUER, kit, newKey, testAgency } from './support.js';

const DAY = 86_400_000;
const CASE_A = '0190f3a1-7c2e-7a00-8000-00000000ca5a';
const CASE_B = '0190f3a1-7c2e-7a00-8000-00000000ca5b';
const payload = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

async function setup(o: { hashers?: () => HmacIdentityHashers } = {}) {
  const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
  const sessions = new MemorySessionStore();
  const verifications = new MemoryVerificationStore();
  const closure = new CloseAccount(sessions, clock);
  const claims = new VerificationClaims(verifications, closure, clock);
  const k = await kit(sessions, { claims, clock, reverifications: claims });
  const provider = testAgency(clock);
  const fixed = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const hashers = () => o.hashers?.() ?? fixed;
  const withdraw = new WithdrawAccount(sessions, new JoseReauthVerifier(k.keys, ISSUER, clock), new VerificationEraser(verifications), clock, new VerificationHolds(verifications));
  const hold = new SetRestrictedCiHold(verifications, clock);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: null, deviceId: null });
  const verify = async (accountId: string, person: string, purpose: 'FIRST' | 'REVERIFY' = 'FIRST') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose, next: '/' });
    await new ConfirmVerification(verifications, provider, hashers(), closure, clock).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person }) });
    return new GetVerificationResult(verifications, clock).run({ accountId, verificationId: st.verificationId });
  };
  const reauth = async (s: { accountId: string; sessionId: string }) => (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  const scope = async (id: string) => payload((await login(id)).accessToken).scope;
  return { clock, sessions, verifications, k, withdraw, hold, login, verify, reauth, scope, hashers, status: new GetVerificationStatus(sessions, claims, clock) };
}

const err = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

describe('이용 제한 중 탈퇴의 대조값 보관(I-T68)', () => {
  test('I-T68①_RESTRICTED·CASE_OPEN을부르면행이생기고until이있다_본인확인전계정은NO_VERIFICATION_옛판은STALE_until이틀리면INVALID_ARGUMENT', async () => {
    const t = await setup();
    const a = await t.login('h-a');
    const b = await t.login('h-b');
    const c = await t.login('h-c');
    await t.verify(a.accountId, 'restricted-person');
    await t.verify(b.accountId, 'appeal-person');
    const until = t.clock.now() + 180 * DAY;
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until, version: 2 })).toBe('OK');
    expect(await t.hold.run({ accountId: b.accountId, fraudCaseId: CASE_B, state: 'CASE_OPEN', until: t.clock.now() + 40 * DAY, version: 1 })).toBe('OK');
    expect(await t.hold.run({ accountId: c.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until, version: 1 })).toBe('NO_VERIFICATION');
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: until + DAY, version: 2 })).toBe('STALE');
    expect(t.verifications.holdsOf(a.accountId)).toMatchObject([{ state: 'RESTRICTED', until, version: 2, sourceAccountId: a.accountId, carriedAccountId: null }]);
    expect(t.verifications.holdsOf(b.accountId)).toMatchObject([{ state: 'CASE_OPEN' }]);
    for (const bad of [{ until: null }, { until: t.clock.now() - 1 }, { until: t.clock.now() + 367 * DAY }]) {
      expect(await err(t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', version: 9, ...bad }))).toBeInstanceOf(RestrictedCiHoldError);
    }
    // 제한을 받은 처음 계정의 토큰은 바꾸지 않는다(제한은 ops-svc가 queue·purchase에 건다)
    expect(await t.scope('h-a')).toBe('ticket:buy');
  });

  test('I-T68②⑨_보관행이있는계정의첫탈퇴는409와fraudHold이고_같은재인증토큰으로acknowledgeFraudHold를실어다시보내면탈퇴하며_identity_verification은지우고보관행은남는다', async () => {
    const t = await setup();
    const a = await t.login('w-a');
    await t.verify(a.accountId, 'w-restricted');
    const until = t.clock.now() + 90 * DAY;
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'CASE_OPEN', until: t.clock.now() + 30 * DAY, version: 1 });
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_B, state: 'RESTRICTED', until, version: 1 });
    const token = await t.reauth(a);
    const e = await err(t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} }));
    expect(e).toBeInstanceOf(AccountError);
    // 둘이면 RESTRICTED가 먼저다
    expect(e).toMatchObject({ code: 'CONFIRMATION_REQUIRED', fraudHold: { state: 'RESTRICTED', until } });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('ACTIVE');
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: { acknowledgeFraudHold: true } });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    expect(await t.verifications.recordOf(a.accountId)).toBeNull();
    expect(t.verifications.holdsOf(a.accountId).map((h) => h.state).sort()).toEqual(['CASE_OPEN', 'RESTRICTED']);
  });

  test('I-T68③_같은연계정보로다시가입해본인확인하면_RESTRICTED쪽은VERIFIED와restrictedUntil이고ticket:buy가없으며_CASE_OPEN쪽은ticket:buy가있되새계정이적힌다', async () => {
    const t = await setup();
    const r = await t.login('re-r');
    const o = await t.login('re-o');
    await t.verify(r.accountId, 'carry-restricted');
    await t.verify(o.accountId, 'carry-open');
    const until = t.clock.now() + 60 * DAY;
    await t.hold.run({ accountId: r.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until, version: 1 });
    await t.hold.run({ accountId: o.accountId, fraudCaseId: CASE_B, state: 'CASE_OPEN', until: t.clock.now() + 30 * DAY, version: 1 });
    for (const s of [r, o]) await t.withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await t.reauth(s), body: { acknowledgeFraudHold: true } });
    const r2 = await t.login('re-r');
    const o2 = await t.login('re-o');
    const vr = await t.verify(r2.accountId, 'carry-restricted');
    expect(vr).toMatchObject({ status: 'VERIFIED', restrictedUntil: new Date(until).toISOString() });
    expect(await t.scope('re-r')).toBeUndefined();
    expect((await t.status.run({ accountId: r2.accountId, sessionId: r2.sessionId })).verified).toBe(false);
    const vo = await t.verify(o2.accountId, 'carry-open');
    expect(vo).toMatchObject({ status: 'VERIFIED', restrictedUntil: null });
    expect(await t.scope('re-o')).toBe('ticket:buy');
    expect(t.verifications.holdsOf(o.accountId)).toMatchObject([{ carriedAccountId: o2.accountId }]);
    expect(t.verifications.holdsOf(r.accountId)).toMatchObject([{ carriedAccountId: r2.accountId }]);
    // 나중에 CASE_OPEN이 RESTRICTED가 되면 그때부터 새 계정에도 ticket:buy를 싣지 않는다
    await t.hold.run({ accountId: o.accountId, fraudCaseId: CASE_B, state: 'RESTRICTED', until: t.clock.now() + 20 * DAY, version: 2 });
    expect(await t.scope('re-o')).toBeUndefined();
  });

  test('I-T68④⑤⑧_제한끝이지나거나RELEASED가오면행이지워지고다음토큰부터ticket:buy가실린다_CASE_OPEN은until이지나면정비가지운다', async () => {
    const t = await setup();
    const a = await t.login('x-a');
    const b = await t.login('x-b');
    await t.verify(a.accountId, 'expire-person');
    await t.verify(b.accountId, 'release-person');
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: t.clock.now() + 10 * DAY, version: 1 });
    await t.hold.run({ accountId: b.accountId, fraudCaseId: CASE_B, state: 'RESTRICTED', until: t.clock.now() + 100 * DAY, version: 1 });
    for (const s of [a, b]) await t.withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await t.reauth(s), body: { acknowledgeFraudHold: true } });
    const a2 = await t.login('x-a');
    const b2 = await t.login('x-b');
    await t.verify(a2.accountId, 'expire-person');
    await t.verify(b2.accountId, 'release-person');
    expect([await t.scope('x-a'), await t.scope('x-b')]).toEqual([undefined, undefined]);
    // ⑤ 끝 전에 RELEASED(더 큰 판). 탈퇴한 처음 계정 ID로 부른다
    expect(await t.hold.run({ accountId: b.accountId, fraudCaseId: CASE_B, state: 'RELEASED', until: null, version: 2 })).toBe('OK');
    expect(t.verifications.holdsOf(b.accountId)).toEqual([]);
    expect(await t.scope('x-b')).toBe('ticket:buy');
    // ④⑧ 끝이 지나면 다음 토큰부터 실리고, 정비가 행을 지운다
    t.clock.advance(11 * DAY);
    expect(await t.scope('x-a')).toBe('ticket:buy');
    expect(await t.verifications.purgeExpiredHolds(t.clock.now())).toBe(1);
    expect(t.verifications.holdsOf(a.accountId)).toEqual([]);
  });

  test('I-T68⑥_보관행이없는계정의탈퇴는409없이바로연계정보HMAC까지지운다', async () => {
    const t = await setup();
    const a = await t.login('n-a');
    await t.verify(a.accountId, 'plain-person');
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauth(a), body: {} });
    expect(await t.verifications.recordOf(a.accountId)).toBeNull();
    expect(t.verifications.holdsOf(a.accountId)).toEqual([]);
  });
});

describe('대조값 보관의 다시 보기(새 맥락 리뷰 M1·M2·M3·L1·L3·L5)', () => {
  test('I-T68_M1_보관행이있는처음계정이다시본인확인해도_자기행을이은것으로적지않아토큰·결과가바뀌지않는다', async () => {
    const t = await setup();
    const a = await t.login('m1-a');
    await t.verify(a.accountId, 'm1-person');
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: t.clock.now() + 30 * DAY, version: 1 });
    expect(await t.verify(a.accountId, 'm1-person', 'REVERIFY')).toMatchObject({ status: 'VERIFIED', restrictedUntil: null });
    expect(t.verifications.holdsOf(a.accountId)).toMatchObject([{ carriedAccountId: null }]);
    expect(await t.scope('m1-a')).toBe('ticket:buy');
  });

  test('I-T68_M2_처음계정의연계정보가새키판으로바뀌어도_보관행은하나로이어지고RELEASED가그행을지운다', async () => {
    let current = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
    const t = await setup({ hashers: () => current });
    const a = await t.login('m2-a');
    await t.verify(a.accountId, 'm2-person');
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'CASE_OPEN', until: t.clock.now() + 30 * DAY, version: 1 });
    // 연계정보 키 판 2를 쓰기 판으로 올리고 다시 본인확인: 기록이 판 2로 바뀐다
    current = new HmacIdentityHashers({ ciKeys: new Map([[1, Buffer.alloc(32, 4)], [2, Buffer.alloc(32, 6)]]), writeVersion: 2, pidKey: Buffer.alloc(32, 5), pidVersion: 1 });
    await t.verify(a.accountId, 'm2-person', 'REVERIFY');
    expect((await t.verifications.recordOf(a.accountId))!.ciHmacKeyVersion).toBe(2);
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: t.clock.now() + 60 * DAY, version: 2 })).toBe('OK');
    const rows = t.verifications.holdsOf(a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'RESTRICTED', ciHmacKeyVersion: 2, version: 2 });
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RELEASED', until: null, version: 3 })).toBe('OK');
    expect(t.verifications.holdsOf(a.accountId)).toEqual([]);
  });

  test('I-T68_M3_같은판·같은내용의재전송은OK이고(응답을잃은재시도가Done에닿게)_같은판의다른내용과옛판은STALE이다', async () => {
    const t = await setup();
    const a = await t.login('m3-a');
    await t.verify(a.accountId, 'm3-person');
    const until = t.clock.now() + 30 * DAY;
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until, version: 4 })).toBe('OK');
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until, version: 4 })).toBe('OK');
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: until + DAY, version: 4 })).toBe('STALE');
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'CASE_OPEN', until, version: 3 })).toBe('STALE');
  });

  test('I-T68⑧_L1_CASE_OPEN으로탈퇴한계정의끝이지나면_정비전에도없는것으로보아RESTRICTED가되살리지않고그행을지운다', async () => {
    const t = await setup();
    const a = await t.login('l1-a');
    await t.verify(a.accountId, 'l1-person');
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'CASE_OPEN', until: t.clock.now() + 5 * DAY, version: 1 });
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauth(a), body: { acknowledgeFraudHold: true } });
    t.clock.advance(6 * DAY);
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: t.clock.now() + 100 * DAY, version: 2 })).toBe('NO_VERIFICATION');
    expect(t.verifications.holdsOf(a.accountId)).toEqual([]);
  });

  test('I-T68_L3_보관행이쓰는연계정보키판을설정이갖지않으면_서비스가시작하지않는다', async () => {
    const t = await setup();
    const a = await t.login('l3-a');
    await t.verify(a.accountId, 'l3-person');
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until: t.clock.now() + 30 * DAY, version: 1 });
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauth(a), body: { acknowledgeFraudHold: true } });
    // 본인확인 기록은 지워졌지만 보관 행이 판 1을 쓴다
    const v2only = new HmacIdentityHashers({ ciKeys: new Map([[2, Buffer.alloc(32, 6)]]), pidKey: Buffer.alloc(32, 5), pidVersion: 1 });
    await expect(assertKeyVersions(t.verifications, v2only)).rejects.toThrow(/판 1/);
  });

  test('I-T68_다시보기_다시가입한계정에같은사건의호출이와도_처음계정의RESTRICTED행을덮지않아이어진제한이그대로다', async () => {
    const t = await setup();
    const a = await t.login('pk-a');
    await t.verify(a.accountId, 'pk-person');
    const until = t.clock.now() + 60 * DAY;
    await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RESTRICTED', until, version: 3 });
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauth(a), body: { acknowledgeFraudHold: true } });
    const b = await t.login('pk-a');
    await t.verify(b.accountId, 'pk-person');
    // ops-svc가 다시 가입한 계정도 같은 사건에 넣고 CASE_OPEN v1을 보낸다
    expect(await t.hold.run({ accountId: b.accountId, fraudCaseId: CASE_A, state: 'CASE_OPEN', until: t.clock.now() + 30 * DAY, version: 1 })).toBe('OK');
    expect(t.verifications.holdsOf(a.accountId)).toMatchObject([{ state: 'RESTRICTED', until, version: 3, carriedAccountId: b.accountId }]);
    expect(t.verifications.holdsOf(b.accountId)).toMatchObject([{ state: 'CASE_OPEN', version: 1 }]);
    expect(await t.scope('pk-a')).toBeUndefined();
    // 처음 계정의 RELEASED는 그 계정의 행만 지운다
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: CASE_A, state: 'RELEASED', until: null, version: 4 })).toBe('OK');
    expect(t.verifications.holdsOf(a.accountId)).toEqual([]);
    expect(t.verifications.holdsOf(b.accountId)).toHaveLength(1);
    expect(await t.scope('pk-a')).toBe('ticket:buy');
  });

  test('L5_gRPC처리실패를기록할때_DB쿼리값(연계정보HMAC·계정ID)을남기지않는다', async () => {
    const seen: unknown[] = [];
    const failing = { run: async () => Promise.reject(new DrizzleQueryError('select * from restricted_ci_hold where ci_hmac = $1', ['secret-hmac-bytes', 'acct-1'], new Error('boom'))) };
    const handlers = restrictedCiHoldHandlers({ hold: failing }, (_m, e) => seen.push(e));
    await new Promise<void>((done) =>
      (handlers.SetRestrictedCiHold as grpc.handleUnaryCall<Record<string, unknown>, object>)(
        { request: { account_id: CASE_A, fraud_case_id: CASE_B, state: 'RESTRICTED_CI_HOLD_STATE_RELEASED', version: 1 } } as never,
        () => done(),
      ),
    );
    expect(seen).toHaveLength(1);
    expect(JSON.stringify({ m: (seen[0] as Error).message, s: (seen[0] as Error).stack })).not.toMatch(/secret-hmac-bytes|acct-1/);
  });
});

describe('RestrictedCiHoldService(gRPC)', () => {
  let server: Awaited<ReturnType<typeof startGrpcServer>> | undefined;
  let client: (grpc.Client & { SetRestrictedCiHold(r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void): void }) | undefined;
  afterAll(async () => {
    client?.close();
    await server?.close();
  });

  test('I-T68①_SetRestrictedCiHold는상태·until(Timestamp)·판을받아결과를enum으로주고_모양이틀리면INVALID_ARGUMENT다', async () => {
    const t = await setup();
    const a = await t.login('g-a');
    await t.verify(a.accountId, 'grpc-hold-person');
    const errors: string[] = [];
    server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: identityPackage().RestrictedCiHoldService.service, handlers: restrictedCiHoldHandlers({ hold: t.hold }, (m) => errors.push(m)) }] });
    client = new (identityPackage().RestrictedCiHoldService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as typeof client;
    const call = (r: object) => new Promise<Record<string, unknown>>((res, rej) => client!.SetRestrictedCiHold(r, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
    const until = { seconds: Math.floor((t.clock.now() + 30 * DAY) / 1000), nanos: 0 };
    expect(await call({ account_id: a.accountId, fraud_case_id: CASE_A, until, state: 'RESTRICTED_CI_HOLD_STATE_RESTRICTED', version: 1 })).toEqual({ result: 'RESTRICTED_CI_HOLD_RESULT_OK' });
    expect(await call({ account_id: a.accountId, fraud_case_id: CASE_A, until, state: 'RESTRICTED_CI_HOLD_STATE_RESTRICTED', version: 1 })).toEqual({ result: 'RESTRICTED_CI_HOLD_RESULT_OK' });
    expect(await call({ account_id: a.accountId, fraud_case_id: CASE_A, until: { seconds: until.seconds + 60, nanos: 0 }, state: 'RESTRICTED_CI_HOLD_STATE_RESTRICTED', version: 1 })).toEqual({ result: 'RESTRICTED_CI_HOLD_RESULT_STALE' });
    const code = async (r: object) => call(r).then(() => 'OK', (e: grpc.ServiceError) => grpc.status[e.code]);
    expect(await code({ account_id: 'x', fraud_case_id: CASE_A, until, state: 'RESTRICTED_CI_HOLD_STATE_RESTRICTED', version: 2 })).toBe('INVALID_ARGUMENT');
    expect(await code({ account_id: a.accountId, fraud_case_id: CASE_A, until, state: 'RESTRICTED_CI_HOLD_STATE_UNSPECIFIED', version: 2 })).toBe('INVALID_ARGUMENT');
    expect(await code({ account_id: a.accountId, fraud_case_id: CASE_A, state: 'RESTRICTED_CI_HOLD_STATE_CASE_OPEN', version: 2 })).toBe('INVALID_ARGUMENT');
    expect(await call({ account_id: a.accountId, fraud_case_id: CASE_A, state: 'RESTRICTED_CI_HOLD_STATE_RELEASED', version: 3 })).toEqual({ result: 'RESTRICTED_CI_HOLD_RESULT_OK' });
    expect(errors).toEqual([]);
  });
});
