// 본인확인 재통과 확인 통합 시험(실제 PostgreSQL 18 + 실제 gRPC 서버): ReverificationCheckService.CheckReverification
// (docs/api/proto identity.proto, docs/features/bot-defense.md §5.2 3단계, docs/features/identity.md I-T56, BUILD_ORDER BOT-090, ADR-0259).
// 재확인 기록은 본인확인 시작·결과 확정 유스케이스로 만든다(결과 경로의 사람 대조와 '다른 사람' 표시를 그대로 지난다).
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { startGrpcServer } from '../src/grpc-server.js';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { identityPackage } from '../src/modules/session/inbound/session.grpc.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import type { TestAgencyOutcome } from '../src/modules/verification/adapters/test-agency.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { CheckReverification } from '../src/modules/verification/application/check-reverification.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import { reverificationCheckHandlers } from '../src/modules/verification/inbound/reverification.grpc.js';
import { agencyResult, kit, newKey, noClosure, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

type Cb<T> = (e: grpc.ServiceError | null, v?: T) => void;
type Client = grpc.Client & { CheckReverification(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb<Record<string, unknown>>): void };

const PASSED = 'REVERIFICATION_RESULT_PASSED';
const NOT_FOUND = 'REVERIFICATION_RESULT_NOT_FOUND';
const PERSON_MISMATCH = 'REVERIFICATION_RESULT_PERSON_MISMATCH';
const STRANGER_PID = Buffer.alloc(32, 9).toString('base64url');

let pg: PostgresContainer;
let database: Database;
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-reverification-test', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

async function serve(store: DrizzleVerificationStore) {
  const errors: { method: string; err: unknown }[] = [];
  const server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: identityPackage().ReverificationCheckService.service, handlers: reverificationCheckHandlers({ check: new CheckReverification(store) }, (method, err) => errors.push({ method, err })) }],
  });
  const client = new (identityPackage().ReverificationCheckService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  closers.push(async () => {
    client.close();
    await server.close();
  });
  const call = (req: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((res, rej) => client.CheckReverification(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  return { call, errors };
}

async function setup() {
  // 계정마다 시각을 달리한다(같은 DB를 여러 시험이 쓴다)
  const clock = fakeClock({ now: Date.parse('2026-11-10T03:00:00.000Z') + Math.floor(Math.random() * 1e9) });
  const store = new DrizzleVerificationStore(database);
  const k = await kit(new DrizzleSessionStore(database, systemClock), { claims: new VerificationClaims(store), clock });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const start = new StartVerification(store, provider, noClosure, clock);
  const confirm = new ConfirmVerification(store, provider, hashers, noClosure, clock);
  const { call, errors } = await serve(store);
  const settle = async (accountId: string, verificationId: string, r: { person?: string; outcome?: TestAgencyOutcome }): Promise<string> => {
    try {
      return (await confirm.run({ accountId, verificationId, providerResult: agencyResult(clock, verificationId, r) })).status;
    } catch (e) {
      if (e instanceof VerificationError) return e.code;
      throw e;
    }
  };
  const verifiedAccount = async (person: string) => {
    const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `rvi-${newKey().slice(0, 10)}`, email: null, deviceId: null });
    const st = await start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
    expect(await settle(s.accountId, st.verificationId, { person })).toBe('VERIFIED');
    return { accountId: s.accountId, sessionId: s.sessionId, pid: (await store.claimsOf(s.accountId))!.pid };
  };
  const reverify = async (a: { accountId: string; sessionId: string }, r: { person?: string; outcome?: TestAgencyOutcome }) => {
    const st = await start.run({ accountId: a.accountId, sessionId: a.sessionId, purpose: 'REVERIFY', next: '/queue/verify' });
    return { status: await settle(a.accountId, st.verificationId, r), id: st.verificationId };
  };
  const check = (accountId: string, pid: string, notBeforeMs: number) => call({ account_id: accountId, pid, not_before_ms: notBeforeMs });
  return { clock, start, verifiedAccount, reverify, check, errors };
}

const unique = (name: string) => `${name}-${newKey().slice(0, 10)}`;
const row = async (id: string) => (await database.db.execute(`select status, person_mismatch from verification_attempt where id = '${id}'`)).rows[0] as { status: string; person_mismatch: boolean };

describe('ReverificationCheckService(gRPC, PostgreSQL)', () => {
  test('I-T56 ① PostgreSQL에서 추가 검증 시작 뒤 같은 사람으로 확정된 재확인은 PASSED와 확정 시각이다', async () => {
    const t = await setup();
    const person = unique('han');
    const a = await t.verifiedAccount(person);
    t.clock.advance(60_000);
    const notBefore = t.clock.now();
    t.clock.advance(45_000);
    const first = await t.reverify(a, { person });
    expect(first.status).toBe('VERIFIED');
    expect(await row(first.id)).toEqual({ status: 'VERIFIED', person_mismatch: false });
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
    // 다른 사람 시도 뒤 같은 사람으로 다시 마치면 가장 늦은 확정 시각이다
    t.clock.advance(3_000);
    expect((await t.reverify(a, { person: unique('other') })).status).toBe('FAILED');
    t.clock.advance(4_000);
    expect((await t.reverify(a, { person })).status).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
    expect(t.errors).toEqual([]);
  });

  test('I-T56 ② PostgreSQL에서 시작 전에만 있는 재확인은 NOT_FOUND다(경계: not_before_ms와 같은 시각·1ms 앞)', async () => {
    const t = await setup();
    const person = unique('yoon');
    const a = await t.verifiedAccount(person);
    t.clock.advance(30_000);
    expect((await t.reverify(a, { person })).status).toBe('VERIFIED');
    const at = t.clock.now();
    expect(await t.check(a.accountId, a.pid, at + 1)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, a.pid, at + 9 * 60_000)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, a.pid, at)).toEqual({ result: PASSED, verified_at_ms: at });
    expect(await t.check(a.accountId, a.pid, at - 1)).toEqual({ result: PASSED, verified_at_ms: at });
    // 시작 전의 다른 사람 결과도 세지 않는다
    t.clock.advance(10_000);
    expect((await t.reverify(a, { person: unique('not-yoon') })).status).toBe('FAILED');
    const late = t.clock.now();
    expect(await t.check(a.accountId, a.pid, late + 1)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, a.pid, late)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
  });

  test('I-T56 ③ PostgreSQL에서 다른 사람의 재확인은 PERSON_MISMATCH이고 건에는 다른 사람 표시만 남는다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount(unique('ko'));
    const otherPerson = unique('nam');
    const b = await t.verifiedAccount(otherPerson);
    const notBefore = t.clock.now();
    t.clock.advance(1_000);
    // 계정이 없는 다른 사람(기록과 다른 연계정보 → FAILED)
    const stranger = await t.reverify(a, { person: unique('oh') });
    expect(stranger.status).toBe('FAILED');
    expect(await row(stranger.id)).toEqual({ status: 'FAILED', person_mismatch: true });
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
    // 다른 계정에서 본인확인한 사람(DUPLICATE_ACCOUNT)
    const dup = await t.reverify(a, { person: otherPerson });
    expect(dup.status).toBe('DUPLICATE_ACCOUNT');
    expect(await row(dup.id)).toEqual({ status: 'DUPLICATE_ACCOUNT', person_mismatch: true });
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
    expect(await t.check(b.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
  });

  test('I-T56 ① PostgreSQL에서도 그 계정과 그 pid의 REVERIFY 확정만 센다(다른 계정·남의 pid·FIRST·진행 중·실패는 NOT_FOUND)', async () => {
    const t = await setup();
    const person = unique('kang');
    const a = await t.verifiedAccount(person);
    const notBefore = t.clock.now();
    t.clock.advance(2_000);
    const b = await t.verifiedAccount(unique('park'));
    expect(await t.check(b.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    await t.start.run({ accountId: a.accountId, sessionId: a.sessionId, purpose: 'REVERIFY', next: '/queue/verify' });
    expect((await t.reverify(a, { outcome: 'FAILED' })).status).toBe('FAILED');
    expect((await t.reverify(a, { outcome: 'CANCELLED' })).status).toBe('CANCELLED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    t.clock.advance(2_000);
    expect((await t.reverify(a, { person })).status).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
    expect(await t.check(b.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(b.accountId, a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, STRANGER_PID, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
  });

  test('CheckReverification은 PostgreSQL에 닿지 못하면 UNAVAILABLE이고 PASSED로 답하지 않으며 기록에 받은 값을 남기지 않는다', async () => {
    // 아무도 듣지 않는 포트를 고른다(연결 거부)
    const port = await new Promise<number>((res, rej) => {
      const s = createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        s.close(() => res(typeof addr === 'object' && addr ? addr.port : 0));
      });
    });
    const down = createDatabase({ url: pg.urlFor('postgres', 'peaket-test').replace(`:${pg.port}/`, `:${port}/`), applicationName: 'identity-reverification-down', max: 1 });
    closers.push(() => down.close());
    const { call, errors } = await serve(new DrizzleVerificationStore(down));
    const account = '0190f3a1-7c2e-7a00-8000-0000000000cc';
    let code = 'OK';
    try {
      await call({ account_id: account, pid: STRANGER_PID, not_before_ms: Date.now() });
    } catch (e) {
      code = grpc.status[(e as grpc.ServiceError).code];
    }
    expect(code).toBe('UNAVAILABLE');
    // 실제로 연결이 끊긴 것을 기록했다(받은 계정·pid는 기록에 없다)
    expect(errors.map((e) => e.method)).toEqual(['CheckReverification']);
    const logged = `${String(errors[0]?.err)} ${(errors[0]?.err as Error | undefined)?.stack ?? ''}`;
    expect(logged).not.toContain(account);
    expect(logged).not.toContain(STRANGER_PID);
  });
});
