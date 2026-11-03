// MSK IAM 인증 묶음이 공용 Kafka 모듈 전부에 실리는지 본다(openspec 변경 add-foundation-poc, docs/streaming.md §2.6, 코드 리뷰 2026-11-01).
// 실제 MSK 대신 TLS + OAUTHBEARER 리스너를 둔 Kafka 3.9.2 컨테이너를 쓴다. 브로커는 서명 없는 JWT를 믿는 시험 검증기로 토큰을 받고,
// 클라이언트는 시험 CA를 믿는다. 토큰 함수는 MSK 서명 토큰 대신 서명 없는 JWT를 돌려준다(ST-T14 ②의 실제 MSK 재인증은 소유자 몫).
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { KafkaAuth, OAuthBearerToken } from '../src/index.js';
import { createKafkaAdmin, createKafkaProducer, kafkaBroadcastSource, runKeyedConsumer } from '../src/stream-worker.js';
import { startKafka, type KafkaContainer } from './containers.js';

let kafka: KafkaContainer;
beforeAll(async () => {
  kafka = await startKafka({ oauth: true });
}, 180_000);

test('인증 관리 연결의 데우기가 실패하면_그 연결을 닫고 던진다(코드 리뷰 2026-11-01: 닫지 않으면 실패마다 클라이언트가 샌다)', async () => {
  // 평문 포트에 TLS로 붙으면 메타데이터 요청(데우기)이 실패한다
  const a = createKafkaAdmin({ brokers: kafka.brokers, clientId: 'auth-fail', auth: auth('fail') });
  const disconnect = vi.spyOn(a, 'disconnect');
  await expect(a.connect()).rejects.toThrow();
  expect(disconnect).toHaveBeenCalled();
}, 60_000);

test('방송형 읽기는 관리 연결이 실패하면_매달리지 않고 던지고_다음 부름에서 다시 시도하며_닫기가 끝난다', async () => {
  const b = kafkaBroadcastSource({ brokers: kafka.brokers, service: 'auth-it', pod: 'p2', auth: auth('fail-broadcast'), adminTimeoutMs: 2_000 });
  for (let i = 0; i < 2; i += 1) await expect(b.watermarks('auth.t')).rejects.toThrow();
  await b.close();
}, 60_000);
afterAll(() => kafka?.stop());

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const calls: string[] = [];
const auth = (who: string): KafkaAuth => ({
  mechanism: 'msk-iam',
  caLocation: kafka.auth!.caFile,
  tokenProvider: async (): Promise<OAuthBearerToken> => {
    calls.push(who);
    const now = Math.floor(Date.now() / 1000);
    return { value: `${b64({ alg: 'none' })}.${b64({ sub: 'st14-it', iat: now, exp: now + 3600 })}.`, lifetime: (now + 3600) * 1000, principal: 'st14-it' };
  },
});

test('ST_T14_MSK_IAM을고르면_생산자·관리연결·키단위소비자·방송형읽기가모두_TLS와OAUTHBEARER로붙는다', async () => {
  const brokers = kafka.auth!.brokers;
  const admin = createKafkaAdmin({ brokers, clientId: 'auth-admin', auth: auth('admin') });
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: 'auth.t', numPartitions: 1, replicationFactor: 1 }] }).catch((e) => { throw new Error(JSON.stringify(e.errors ?? e.message)); });
  await admin.disconnect();

  const producer = createKafkaProducer({ brokers, clientId: 'auth-producer', kind: 'default', auth: auth('producer') });
  await producer.connect();
  await producer.send({ topic: 'auth.t', messages: [1, 2, 3].map((n) => ({ key: 'k', value: Buffer.from(String(n)) })) });
  await producer.disconnect();

  const got: string[] = [];
  const consumer = runKeyedConsumer<string>({
    brokers,
    clientId: 'auth-consumer',
    service: 'auth-it',
    groupId: 'auth-it',
    topics: ['auth.t'],
    auth: auth('consumer'),
    held: { heldKeys: async () => new Set(), isHeld: async () => false, hold: async () => {}, holdIfHeld: async () => false },
    handler: { decode: (m) => m.value!.toString('utf8'), keyOf: () => 'k', handle: async (e) => void got.push(e) },
  });
  await consumer.started;
  for (let i = 0; i < 300 && got.length < 3; i += 1) await sleep(100);
  await consumer.stop();
  expect(got).toEqual(['1', '2', '3']);

  const broadcast = kafkaBroadcastSource({ brokers, service: 'auth-it', pod: 'p1', auth: auth('broadcast') });
  const marks = await broadcast.watermarks('auth.t');
  expect(marks.get(0)?.high).toBe(3n);
  const read: string[] = [];
  const stop = new AbortController();
  const reading = broadcast.read('auth.t', new Map([[0, 0n]]), async (r) => {
    read.push(r.value!.toString('utf8'));
    if (read.length === 3) stop.abort();
  }, stop.signal);
  await Promise.race([reading, sleep(30_000)]);
  stop.abort();
  await broadcast.close();
  expect(read).toEqual(['1', '2', '3']);
  // 모든 연결이 토큰 함수를 불렀다(인증 묶음이 빠진 연결은 평문으로 붙으려다 실패한다)
  expect(['admin', 'producer', 'consumer', 'broadcast'].filter((w) => !calls.includes(w))).toEqual([]);
}, 180_000);
