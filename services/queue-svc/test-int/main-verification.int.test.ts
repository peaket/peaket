// 시작 파일(src/main.ts)을 실제로 띄운다: 업무 gRPC 포트에 VerificationAppealService가 열리고, 추가 검증 제출이 identity-svc(CheckReverification)와
// trust-svc(ScoreRisk VERIFICATION) 클라이언트를 거쳐 실제 Valkey의 verify 칸을 바꾸며, 지표가 관리 포트에 나온다(BUILD_ORDER BOT-090, ADR-0259).
// identity·trust는 이 시험이 띄운 흉내 gRPC 서버다. Kafka 브로커를 주지 않은 ci라 이의 접수는 503이고 시작은 막지 않는다.
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity, queueV1Queue, trustV1Trust } from '@peaket/contracts/proto';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { ACCOUNT, DEVICE, newEvent, openSchedule, PID } from '../test/support.js';
import { hashOf, numberDup } from '../test/verification-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const load = <T>(d: unknown) => grpc.loadPackageDefinition(protoLoader.fromJSON(d as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS)) as unknown as T;
const trustPkg = load<{ peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } }>(trustV1Trust);
const identityPkg = load<{ peaket: { identity: { v1: { ReverificationCheckService: grpc.ServiceClientConstructor } } } }>(identityV1Identity);
const queuePkg = load<{ peaket: { queue: { v1: { VerificationAppealService: grpc.ServiceClientConstructor } } } }>(queueV1Queue);
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;

let valkey: ValkeyContainer;
let redis: HotRedis;
let fakes: grpc.Server;
let appPort = 0;
let managementPort = 0;
let grpcPort = 0;
const trustSeen: Record<string, unknown>[] = [];
const identitySeen: Record<string, unknown>[] = [];

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
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  fakes = new grpc.Server();
  fakes.addService(trustPkg.peaket.trust.v1.TrustService.service, {
    ScoreRisk: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      trustSeen.push(call.request);
      cb(null, { verdict: 'VERDICT_ALLOW', degraded: false });
    },
  });
  fakes.addService(identityPkg.peaket.identity.v1.ReverificationCheckService.service, {
    CheckReverification: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      identitySeen.push(call.request);
      cb(null, { result: 'REVERIFICATION_RESULT_PASSED', verified_at_ms: Date.now() });
    },
  });
  const fakePort = await new Promise<number>((res, rej) => fakes.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  appPort = await freePort();
  managementPort = await freePort();
  grpcPort = await freePort();
  const jwk = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'it-1' };
  delete process.env.PEAKET_KAFKA_BROKERS;
  delete process.env.PEAKET_CASE_REQUESTS_STUB;
  Object.assign(process.env, {
    PEAKET_ENV: 'ci',
    PEAKET_QUEUE_REDIS_URL: valkey.url,
    PEAKET_QUEUE_TOKEN_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
    PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(jwk),
    PEAKET_ADMISSION_TOKEN_ISSUER: 'https://queue.test.invalid',
    PEAKET_TRUST_GRPC_URL: `127.0.0.1:${fakePort}`,
    PEAKET_IDENTITY_GRPC_URL: `127.0.0.1:${fakePort}`,
    PEAKET_GRPC_PORT: String(grpcPort),
    PEAKET_GRPC_HOST: '127.0.0.1',
    PORT: String(appPort),
    PEAKET_MANAGEMENT_PORT: String(managementPort),
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
    PEAKET_LOG_LEVEL: 'fatal',
  });
  await import('../src/main.js');
}, 120_000);

afterAll(async () => {
  fakes?.forceShutdown();
  await redis?.close();
  valkey?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key, deadlineMs: 5_000 });
const fan = { 'x-user-id': ACCOUNT, 'x-session-id': 's-1', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': PID, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9' };

async function verifying() {
  const eventId = newEvent();
  const s = openSchedule(Date.now(), { lobbyShuffle: false, openBatch: true });
  await cmd(keys.cfg(eventId), ['HSET', keys.cfg(eventId), 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1']);
  const ticket = hashOf(`main-${eventId}`);
  await cmd(keys.dup(PID, eventId), ['SET', keys.dup(PID, eventId), numberDup(4, ticket)]);
  await cmd(keys.verify(eventId), ['HSET', keys.verify(eventId), ticket, `VERIFYING:${Date.now() - 5_000}:DEVICE_HISTORY`]);
  return { eventId, ticket };
}

test('queue-svc 시작 파일이 gRPC 포트·identity·trust 클라이언트를 조립해 추가 검증 제출이 실제 Valkey의 verify 칸을 PASSED로 바꾼다', async () => {
  const { eventId, ticket } = await verifying();
  const r = await fetch(`http://127.0.0.1:${appPort}/v1/queues/${eventId}/verification`, { method: 'POST', headers: fan, body: JSON.stringify({ challengeToken: 'verify-token', deviceId: DEVICE }) });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ result: 'PASSED', queueNumber: 4, graceUntil: null });
  expect(String(await cmd(keys.verify(eventId), ['HGET', keys.verify(eventId), ticket]))).toMatch(/^PASSED:\d+:DEVICE_HISTORY$/);
  // identity를 먼저 묻고 trust는 VERIFICATION 맥락으로 부른다(같은 trust 클라이언트)
  expect(identitySeen.at(-1)).toMatchObject({ account_id: ACCOUNT, pid: PID });
  expect(trustSeen.at(-1)).toMatchObject({ context: 'SCORE_CONTEXT_VERIFICATION', human_check_token: 'verify-token', device_id: DEVICE, client: expect.objectContaining({ ip: '198.51.100.9' }) });
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toContain('queue_verification_submissions_total{result="passed"} 1');
});

test('queue-svc 시작 파일은 Kafka 브로커가 없는 ci에서도 뜨고 이의 접수만 503·Retry-After이며 publish_failed를 센다', async () => {
  const { eventId } = await verifying();
  const r = await fetch(`http://127.0.0.1:${appPort}/v1/queues/${eventId}/verification`, { method: 'POST', headers: fan, body: JSON.stringify({ appeal: '사람입니다' }) });
  expect(r.status).toBe(503);
  expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  // 이의는 대기열 Redis에 먼저 둔다(다시 보내면 같은 이의 ID·eventKey로 낸다)
  expect(await cmd(`q:appeal:{${PID}}:${eventId}`, ['HGET', `q:appeal:{${PID}}:${eventId}`, 'txt'])).toBe('사람입니다');
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toContain('queue_verification_appeals_total{result="publish_failed"} 1');
});

test('queue-svc 시작 파일이 업무 gRPC 포트에 VerificationAppealService를 열고 없는 이의는 NOT_FOUND다', async () => {
  const client = new queuePkg.peaket.queue.v1.VerificationAppealService(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { GetVerificationAppeal: Unary };
  try {
    const code = await new Promise<number>((res) => client.GetVerificationAppeal({ appeal_id: '0190f3a1-7c2e-7a00-8000-0000000000ff' }, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e) => res(e ? e.code : grpc.status.OK)));
    expect(code).toBe(grpc.status.NOT_FOUND);
  } finally {
    client.close();
  }
  // identity-svc 차단기 지표가 서비스 지표 저장소에 있다
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toMatch(/dependency="identity-svc"/);
});
