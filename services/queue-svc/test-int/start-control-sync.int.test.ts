// queue-svc 시작 함수(src/start.ts)를 실제 Kafka 3.9·Valkey 8.1로 띄워, 시작 파일의 조립이 종료 세션 목록을 채우고 탈퇴 사건을 받자마자 처리하는지 본다
// (docs/features/identity.md §12 I-T3 ②·④, docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', ADR-0333 결정 2·5, BUILD_ORDER HOT-401 묶음 BAT-059).
// 시험 조립이 아니라 시작 파일의 조립을 본다. 판정은 앱 포트의 진입·입장 확정 응답(401)과 Valkey의 두 키 만료 값이다.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { CONTROL_TOPICS, createHotRedis, type HotRedis } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer } from '@peaket/platform/stream-worker';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ACCOUNTS_WITHDRAWN_TOPIC, QUEUE_TOPICS } from '../src/consumers/index.js';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { EVENTS_KEY } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { start, type StartedService } from '../src/start.js';
import { newEvent } from '../test/support.js';
import { type KafkaContainer, startKafka, until } from './kafka.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

/** 정본 I-T3 ① '수 초'의 시험 값(docs/features/identity.md §12, 5초 [가정]) */
const PROPAGATION_MS = 5_000;
const HOUR = 3_600_000;

let kafka: KafkaContainer;
let valkey: ValkeyContainer;
let redis: HotRedis;
let producer: KafkaProducer;

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

const admissionKey = { ...(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'it-t3' };

async function envFor(brokers: string, pod: string) {
  const appPort = await freePort();
  const managementPort = await freePort();
  const env: Record<string, string> = {
    PEAKET_ENV: 'ci',
    PEAKET_KAFKA_BROKERS: brokers,
    PEAKET_POD: pod,
    PEAKET_QUEUE_REDIS_URL: valkey.url,
    PEAKET_QUEUE_TOKEN_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
    PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(admissionKey),
    PEAKET_ADMISSION_TOKEN_ISSUER: 'https://queue.peaket.example',
    PEAKET_GRPC_PORT: String(await freePort()),
    PEAKET_GRPC_HOST: '127.0.0.1',
    PORT: String(appPort),
    PEAKET_MANAGEMENT_PORT: String(managementPort),
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
    PEAKET_LOG_LEVEL: 'fatal',
  };
  return { env, app: `http://127.0.0.1:${appPort}`, management: `http://127.0.0.1:${managementPort}` };
}

const sink = () => new Writable({ write: (_c, _e, cb) => cb() });

beforeAll(async () => {
  [kafka, valkey] = await Promise.all([startKafka(), startValkey()]);
  redis = await createHotRedis({ url: valkey.url });
  for (const t of QUEUE_TOPICS) await kafka.createTopic(t, 1);
  await kafka.createTopic(CONTROL_TOPICS.settings, 1);
  await kafka.createTopic(CONTROL_TOPICS.sessionsTerminated, 2);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-t3-producer', kind: 'default' });
  await producer.connect();
}, 180_000);

afterAll(async () => {
  await producer?.disconnect().catch(() => {});
  await redis?.close();
  kafka?.stop();
  valkey?.stop();
});

const services: StartedService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.close();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const fan = (sid: string, pid: string) => ({
  'content-type': 'application/json',
  'x-user-id': 'acc-t3',
  'x-session-id': sid,
  'x-user-aud': 'fan',
  'x-user-scope': 'ticket:buy openid',
  'x-user-pid': pid,
});
const post = async (base: string, path: string, headers: Record<string, string>) => (await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}' })).status;
const readyOf = async (management: string) => {
  const r = await fetch(`${management}/ready`);
  const body = (await r.json()) as { pending?: string[] };
  return { status: r.status, pending: [...(body.pending ?? [])].sort() };
};

async function scanAll(pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = (await cmd('q:{wdr}:due', ['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000'])) as [string, string[]];
    found.push(...batch.map(String));
    cursor = String(next);
  } while (cursor !== '0');
  return found;
}

describe('queue-svc 시작 파일의 종료 세션 목록과 탈퇴 사건(I-T3 ②·④)', () => {
  test('I-T3 ②-10 queue-svc 시작 함수는 브로커가 닿지 않으면 종료 세션 창을 다 읽기 전이라 /ready가 503이고 남은 작업에 sessions가 있다', async () => {
    const closed = await freePort();
    const w = await envFor(`127.0.0.1:${closed}`, 'pod-unreachable');
    services.push(await start({ env: w.env, logDestination: sink(), onFatal: () => {} }));
    const r = await readyOf(w.management);
    expect(r.status).toBe(503);
    expect(r.pending).toEqual(expect.arrayContaining(['sessions', 'settings']));
  }, 60_000);

  test(`I-T3 ④-6 탈퇴(이유 DELETE)로 끝난 세션의 토큰으로 온 진입·입장 확정은 ${PROPAGATION_MS}ms 안에 401이 되고, 탈퇴 사건은 받자마자 q:dup·q:adm 만료를 purgeBy로 당기며 처리할 때 집합(q:{wdr}:…)을 쓰지 않는다 [ASVS v5.0.0-7.4.1]`, async () => {
    const w = await envFor(kafka.brokers.join(','), 'pod-t3');
    services.push(await start({ env: w.env, logDestination: sink(), onFatal: () => {} }));
    await until(async () => (await readyOf(w.management)).status === 200, 'queue-svc 준비', 60_000, 100);

    const eventId = newEvent();
    const pid = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
    const sid = `s-del-${randomUUID()}`;
    const live = `s-live-${randomUUID()}`;
    const now = Date.now();
    await cmd(EVENTS_KEY, ['ZADD', EVENTS_KEY, String(now + 24 * HOUR), eventId]);
    const dup = keys.dup(pid, eventId);
    const adm = keys.adm(pid, eventId);
    await cmd(dup, ['SET', dup, '1:1:r:j:', 'PXAT', String(now + 20 * HOUR)]);
    await cmd(adm, ['SET', adm, 'hash:mark', 'PXAT', String(now + 20 * HOUR)]);
    const entries = `/v1/queues/${eventId}/entries`;
    const admission = `/v1/queues/${eventId}/admission`;
    // 끝나기 전에는 가드를 지난다(401이 아니다)
    expect(await post(w.app, entries, fan(sid, pid))).not.toBe(401);

    const accountId = randomUUID();
    const purgeBy = now + 2 * HOUR;
    // identity의 회원 탈퇴는 같은 트랜잭션에 탈퇴 사건과 세션 종료 사건(DELETE)을 남긴다. 탈퇴 사건이 먼저 닿는 경우로 넣는다
    await producer.send({
      topic: ACCOUNTS_WITHDRAWN_TOPIC,
      messages: [{ key: accountId, value: JSON.stringify({ eventKey: randomUUID(), accountId, pids: [pid], withdrawnAt: new Date(now).toISOString(), purgeBy: new Date(purgeBy).toISOString() }) }],
    });
    const sent = Date.now();
    await producer.send({
      topic: CONTROL_TOPICS.sessionsTerminated,
      messages: [{ key: accountId, value: JSON.stringify({ accountId, sessionId: sid, reason: 'DELETE', terminatedAt: new Date(now).toISOString() }), timestamp: String(now) }],
    });
    await until(async () => (await post(w.app, entries, fan(sid, pid))) === 401, '끝난 세션의 진입 401', PROPAGATION_MS - (Date.now() - sent), 50);
    expect(await post(w.app, admission, fan(sid, pid))).toBe(401);
    expect(await post(w.app, entries, fan(live, pid))).not.toBe(401);

    await until(async () => Number(await cmd(dup, ['PEXPIRETIME', dup])) === purgeBy, '탈퇴 키 만료 당기기', 30_000, 100);
    expect(Number(await cmd(adm, ['PEXPIRETIME', adm]))).toBe(purgeBy);
    // 끝난 세션의 요청이 그 뒤에 와도 만료를 판매 종료로 다시 늘리지 않는다
    expect(await post(w.app, entries, fan(sid, pid))).toBe(401);
    expect(Number(await cmd(dup, ['PEXPIRETIME', dup]))).toBe(purgeBy);
    expect(Number(await cmd(adm, ['PEXPIRETIME', adm]))).toBe(purgeBy);
    expect(Date.now() - now).toBeLessThan(15 * 60_000);
    expect(await scanAll('q:{wdr}:*')).toEqual([]);
  }, 180_000);
});
