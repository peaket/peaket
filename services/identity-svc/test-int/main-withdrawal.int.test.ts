// 시작 파일을 실제로 띄운다(main-reverification.int.test.ts와 같은 방식): main.ts가 PEAKET_PURCHASE_GRPC_URL의 탈퇴 참여자를 SessionModule에 넣어
// 탈퇴 요청(DELETE /v1/identity/account)이 그 참여자를 부르고 답으로 202·204를 고르는지 본다(docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현',
// ADR-0284, BUILD_ORDER PRF-169, I-T84 ①②, docs/architecture.md §8.6 '자주 놓친 결함'의 '시작 파일 조립은 시험 조립과 따로 띄워서 본다', BAT-010 시험 담당).
// 참여자는 루프백의 가짜 purchase-svc WithdrawalParticipantService다. 고리(60초 간격)는 이 파일이 기다리지 않는다.
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey, ISSUER, newKey, noClaims, recordingSignals, testDeviceRefs } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const TOKEN = 'bat010-main-internal-token';
const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { WithdrawalParticipantService: grpc.ServiceClientConstructor };
const pkg = (() => {
  const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
})();

let pg: PostgresContainer;
let database: Database;
let double: grpc.Server;
let httpPort = 0;
let answer: 'DONE' | 'PENDING' = 'PENDING';
const seen: { accountId: string; token: unknown; caller: unknown; deadlineLeftMs: number }[] = [];
let signer: JoseTokenSigner;

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
  database = createDatabase({ url: pg.url, applicationName: 'identity-main-withdrawal-test', max: 4 });
  await ensureOutboxPartitions(database, systemClock);
  double = new grpc.Server();
  double.addService(pkg.WithdrawalParticipantService.service, {
    ProcessAccountWithdrawal: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const d = call.getDeadline();
      seen.push({ accountId: String(call.request.account_id), token: call.metadata.get('x-peaket-internal-grpc-token')[0], caller: call.metadata.get('x-peaket-internal-grpc-caller')[0], deadlineLeftMs: (d instanceof Date ? d.getTime() : Number(d)) - Date.now() });
      cb(null, answer === 'DONE' ? { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' } : { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING'], deposit_orders_pending: 1 });
    },
  });
  const doublePort = await new Promise<number>((res, rej) => double.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  const fan = await fanKey();
  httpPort = await freePort();
  for (const k of ['PEAKET_VERIFICATION_PROVIDER', 'PEAKET_IDENTITY_REDIS_URL', 'PEAKET_TRUST_GRPC_URL', 'PEAKET_TELEMETRY_KAFKA_BROKERS', 'PEAKET_ADMIN_PEPPER_KMS_KEYS', 'PEAKET_ADMIN_PEPPER']) delete process.env[k];
  Object.assign(process.env, {
    PEAKET_ENV: 'ci',
    PEAKET_DATABASE_URL: pg.url,
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(await freePort()),
    PORT: String(httpPort),
    PEAKET_MANAGEMENT_PORT: String(await freePort()),
    PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk),
    PEAKET_TOKEN_ISSUER: ISSUER,
    PEAKET_LOG_LEVEL: 'fatal',
    PEAKET_PURCHASE_GRPC_URL: `127.0.0.1:${doublePort}`,
    PEAKET_INTERNAL_GRPC_TOKEN: TOKEN,
  });
  signer = new JoseTokenSigner(await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) }), ISSUER);
  await import('../src/main.js');
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => (double ? double.tryShutdown(() => r()) : r()));
  await database?.close();
  pg?.stop();
});

test('I-T84①②_시작파일(main.ts)은PEAKET_PURCHASE_GRPC_URL의탈퇴참여자를넣어_PENDING이면본문없는202·DONE이면204이고_참여자는내부토큰·부르는쪽identity-svc·요청경로3초로불린다 [ASVS v5.0.0-7.4.2]', async () => {
  const create = new CreateSession(new DrizzleSessionStore(database, systemClock), signer, testDeviceRefs(), recordingSignals(), noClaims, systemClock);
  const s = await create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `main-w-${newKey().slice(0, 8)}`, email: null, deviceId: null });
  const del = async () => {
    const token = (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, Date.now())).token;
    return fetch(`http://127.0.0.1:${httpPort}/v1/identity/account`, {
      method: 'DELETE',
      headers: { 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '', 'content-type': 'application/json', 'x-reauth-token': token },
      body: '{}',
    });
  };
  answer = 'PENDING';
  const first = await del();
  expect(first.status).toBe(202);
  expect(await first.text()).toBe('');
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(seen.map((x) => [x.accountId, x.token, x.caller])).toEqual([[s.accountId, TOKEN, 'identity-svc']]);
  expect(seen[0]!.deadlineLeftMs).toBeLessThanOrEqual(3_000);
  expect(seen[0]!.deadlineLeftMs).toBeGreaterThan(2_000);
  expect((await database.pool.query('select status, closure_reason from account where id = $1', [s.accountId])).rows).toEqual([{ status: 'WITHDRAWAL_PENDING', closure_reason: 'WITHDRAWAL' }]);
  answer = 'DONE';
  const second = await del();
  expect(second.status).toBe(204);
  expect(seen).toHaveLength(2);
  expect((await database.pool.query('select status from account where id = $1', [s.accountId])).rows).toEqual([{ status: 'DELETED' }]);
});
