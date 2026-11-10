// 시작 파일을 실제로 띄운다(trust-svc test-int/main-boot.ts와 같은 방식, ADR-0249 결정 4): main.ts가 업무 gRPC 포트에
// ReverificationCheckService를 싣고 PostgreSQL 저장소의 재확인 기록으로 답하는지 본다(BUILD_ORDER BOT-090, BAT-200 계획 §3.8 '시작 파일 조립').
// 재확인 기록은 같은 DB에 본인확인 시작·결과 확정 유스케이스로 만든다(시작 파일은 본인확인기관 설정 없이 띄워도 이 읽기는 한다).
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { identityPackage } from '../src/modules/session/inbound/session.grpc.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, fanKey, kit, newKey, noClosure, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

type Cb<T> = (e: grpc.ServiceError | null, v?: T) => void;
type Client = grpc.Client & { CheckReverification(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb<Record<string, unknown>>): void };

let pg: PostgresContainer;
let database: Database;
let grpcPort = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-main-test', max: 4 });
  await ensureOutboxPartitions(database, systemClock);
  grpcPort = await freePort();
  for (const k of ['PEAKET_VERIFICATION_PROVIDER', 'PEAKET_IDENTITY_REDIS_URL', 'PEAKET_TRUST_GRPC_URL', 'PEAKET_TELEMETRY_KAFKA_BROKERS', 'PEAKET_ADMIN_PEPPER_KMS_KEYS', 'PEAKET_ADMIN_PEPPER']) delete process.env[k];
  Object.assign(process.env, {
    PEAKET_ENV: 'ci',
    PEAKET_DATABASE_URL: pg.url,
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(grpcPort),
    PORT: String(await freePort()),
    PEAKET_MANAGEMENT_PORT: String(await freePort()),
    PEAKET_FAN_TOKEN_KEY: JSON.stringify((await fanKey()).privateJwk),
    PEAKET_TOKEN_ISSUER: 'https://identity.peaket.test',
    PEAKET_LOG_LEVEL: 'fatal',
  });
  await import('../src/main.js');
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

test('I-T56 ① 시작 파일(main.ts)을 띄우면 업무 gRPC 포트의 CheckReverification이 시작 뒤 같은 사람의 재확인에 PASSED로 답한다', async () => {
  const clock = fakeClock({ now: Date.parse('2026-11-10T05:00:00.000Z') });
  const store = new DrizzleVerificationStore(database);
  const k = await kit(new DrizzleSessionStore(database, systemClock), { claims: new VerificationClaims(store), clock });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const start = new StartVerification(store, provider, noClosure, clock);
  const confirm = new ConfirmVerification(store, provider, hashers, noClosure, clock);
  const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `main-${newKey().slice(0, 8)}`, email: null, deviceId: null });
  const first = await start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
  await confirm.run({ accountId: s.accountId, verificationId: first.verificationId, providerResult: agencyResult(clock, first.verificationId, { person: 'main-person' }) });
  const pid = (await store.claimsOf(s.accountId))!.pid;
  clock.advance(60_000);
  const notBefore = clock.now();
  clock.advance(20_000);
  const re = await start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'REVERIFY', next: '/queue/verify' });
  expect((await confirm.run({ accountId: s.accountId, verificationId: re.verificationId, providerResult: agencyResult(clock, re.verificationId, { person: 'main-person' }) })).status).toBe('VERIFIED');

  const client = new (identityPackage().ReverificationCheckService)(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure()) as unknown as Client;
  const call = (req: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((res, rej) => client.CheckReverification(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  try {
    expect(await call({ account_id: s.accountId, pid, not_before_ms: notBefore })).toEqual({ result: 'REVERIFICATION_RESULT_PASSED', verified_at_ms: clock.now() });
    expect(await call({ account_id: s.accountId, pid, not_before_ms: clock.now() + 1 })).toEqual({ result: 'REVERIFICATION_RESULT_NOT_FOUND', verified_at_ms: 0 });
    await expect(call({ account_id: s.accountId, pid, not_before_ms: 0 })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  } finally {
    client.close();
  }
});
