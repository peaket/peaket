// 이의 건 요청을 실제 Kafka(apache/kafka 3.9.2)와 실제 Valkey로 낸다(asyncapi support.cases-requested, B-T10 ①②, ADR-0259 결정 6).
// queue-svc의 첫 Kafka 생산자(KafkaCaseRequests, @peaket/platform/stream-worker)를 쓴다. 네이티브 모듈이 막힌 PC에서는 돌지 못하고 CI가 돈다.
// 브로커를 멈추면(docker pause) 요청은 2초 [가정]에 끊고 503이며, 되살린 뒤 다시 보내면 같은 eventKey로 나간다(늦게 간 첫 사건도 같은 eventKey).
import { CaseRequested } from '@peaket/contracts/asyncapi';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { createKafkaProducer, withTraceHeaders } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { CASES_REQUESTED_TOPIC, KafkaCaseRequests } from '../src/modules/verification/adapters/kafka-case-requests.js';
import { RedisVerificationStore, verificationKeys as vk } from '../src/modules/verification/adapters/redis-verification-store.js';
import { SubmitAppeal } from '../src/modules/verification/application/submit-appeal.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import { DEFAULT_VERIFICATION_OPTIONS } from '../src/modules/verification/domain/verification.js';
import { ACCOUNT, newEvent, openSchedule, PID } from '../test/support.js';
import { hashOf, numberDup, recordingSignals } from '../test/verification-cases.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector } from './kafka.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let kafka: KafkaContainer;
let valkey: ValkeyContainer;
let redis: HotRedis;
let cases: KafkaCaseRequests;
let reader: TopicCollector;

beforeAll(async () => {
  [kafka, valkey] = await Promise.all([startKafka(), startValkey()]);
  redis = await createHotRedis({ url: valkey.url });
  await kafka.createTopic(CASES_REQUESTED_TOPIC, 4);
  cases = new KafkaCaseRequests(() => createKafkaProducer({ kind: 'default', brokers: kafka.brokers, clientId: 'queue-svc-ci-it' }), () => withTraceHeaders());
  reader = await collectTopics(kafka.brokers, [CASES_REQUESTED_TOPIC], `it-cases-${Date.now()}`);
}, 180_000);

afterAll(async () => {
  await reader?.close();
  await cases?.close();
  await redis?.close();
  kafka?.stop();
  valkey?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key, deadlineMs: 5_000 });

async function verifying() {
  const eventId = newEvent();
  const s: EventSchedule = openSchedule(Date.now());
  await cmd(keys.cfg(eventId), ['HSET', keys.cfg(eventId), 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1']);
  const ticket = hashOf(`kafka-${eventId}`);
  await cmd(keys.dup(PID, eventId), ['SET', keys.dup(PID, eventId), numberDup(8, ticket)]);
  await cmd(keys.verify(eventId), ['HSET', keys.verify(eventId), ticket, `VERIFYING:${Date.now() - 1_000}:DEVICE_HISTORY`]);
  const appeal = new SubmitAppeal(new RedisVerificationStore(redis), new RedisEventSchedules(redis, systemClock), cases, DEFAULT_VERIFICATION_OPTIONS, systemClock, recordingSignals());
  return { eventId, run: (text: string) => appeal.run({ eventId, accountId: ACCOUNT, pid: PID, text }) };
}

test('B-T10 ① 이의는 202이고 건 요청이 한 건 나가며 같은 요청을 다시 보내도 같은 eventKey 하나다', async () => {
  const x = await verifying();
  const first = await x.run('실제 Kafka로 보낸 이의 글');
  if (first.kind !== 'RECEIVED') throw new Error('접수되지 않았다');
  expect(await x.run('다시')).toEqual(first);
  const got = await reader.waitFor((r) => r.key === first.appealId, 1);
  // 다시 보낸 요청은 이미 보낸 표시가 있어 새로 내지 않는다
  await new Promise((r) => setTimeout(r, 1_000));
  expect(reader.records.filter((r) => r.key === first.appealId)).toHaveLength(1);
  const value = JSON.parse(got[0]!.value!) as Record<string, unknown>;
  expect(CaseRequested.safeParse(value).success).toBe(true);
  const ek = String(await cmd(vk.appeal(PID, x.eventId), ['HGET', vk.appeal(PID, x.eventId), 'ek']));
  expect(value).toMatchObject({ eventKey: ek, kind: 'VERIFICATION_APPEAL', sourceId: first.appealId, category: 'REASON_CATEGORY_DEVICE_HISTORY', createdAt: first.receivedAt });
  expect(got[0]!.value).not.toContain('실제 Kafka로 보낸 이의 글');
  expect(got[0]!.value).not.toContain(PID);
});

test('B-T10 ② 발행이 실패하면 503·Retry-After이고 다시 보내면 같은 eventKey로 나간다', async () => {
  const x = await verifying();
  kafka.pause();
  let err: unknown;
  let elapsed = 0;
  let raw = { id: '', ek: '' };
  let sentWhilePaused: unknown = 'unread';
  try {
    const started = Date.now();
    err = await x.run('브로커가 멈춘 동안').catch((e: unknown) => e);
    elapsed = Date.now() - started;
    // 브로커가 멈춘 동안: 이의는 이미 있고(HSETNX 뒤) 보낸 표시는 없다
    const key = vk.appeal(PID, x.eventId);
    raw = { id: String(await cmd(key, ['HGET', key, 'id'])), ek: String(await cmd(key, ['HGET', key, 'ek'])) };
    sentWhilePaused = await cmd(key, ['HGET', key, 'sent']);
  } finally {
    await kafka.resume();
  }
  expect(err).toBeInstanceOf(VerificationError);
  expect((err as VerificationError).code).toBe('PUBLISH_FAILED');
  // 2초 [가정]에 끊는다(생산자 전달 상한 5초까지 묶지 않는다)
  expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_VERIFICATION_OPTIONS.publishTimeoutMs - 50);
  expect(elapsed).toBeLessThan(DEFAULT_VERIFICATION_OPTIONS.publishTimeoutMs + 1_500);
  expect(raw.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(sentWhilePaused).toBeNull();
  // 되살린 브로커가 받기까지 몇 초 걸릴 수 있다: 화면처럼 Retry-After를 지켜 다시 보낸다(첫 발행이 늦게 성공해 보낸 표시를 남겼으면 바로 202다)
  let again: Awaited<ReturnType<typeof x.run>> | undefined;
  const until = Date.now() + 20_000;
  while (!again) {
    const r = await x.run('되살린 뒤').catch((e: unknown) => e);
    if (!(r instanceof VerificationError)) again = r as Awaited<ReturnType<typeof x.run>>;
    else if (r.code !== 'PUBLISH_FAILED' || Date.now() > until) throw r;
    else await new Promise((res) => setTimeout(res, 500));
  }
  expect(again).toMatchObject({ kind: 'RECEIVED', appealId: raw.id });
  const got = await reader.waitFor((r) => r.key === raw.id, 1);
  await new Promise((r) => setTimeout(r, 6_000));
  const all = reader.records.filter((r) => r.key === raw.id);
  expect(all.length).toBeGreaterThanOrEqual(got.length);
  expect(new Set(all.map((r) => (JSON.parse(r.value!) as { eventKey: string }).eventKey))).toEqual(new Set([raw.ek]));
}, 60_000);
