// queue-svc Kafka 구독을 실제 Kafka 3.9(KRaft)와 Valkey 8.1로 돈다(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', ADR-0214).
// 토픽 셋을 그룹 하나로 읽어 판매 상태·구매 세션·탈퇴 사건이 각자 처리되고, 좌석 사건은 건너뛰며, 모양이 틀린 사건은 대기열 Redis에 보류되고,
// 탈퇴 사건은 미루기가 지난 뒤에 처리되는지 본다. 값은 JSON 대역이다(Avro는 BAS-030).
import { randomUUID } from 'node:crypto';
import { createHotRedis, type HotRedis, PlatformMetrics, systemClock } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ACCOUNTS_WITHDRAWN_TOPIC, heldKeys, PURCHASE_SESSIONS_TOPIC, QUEUE_GROUP, QUEUE_TOPICS } from '../src/consumers/index.js';
import { type QueueConsumers, startQueueConsumers } from '../src/consumers/start.js';
import { RedisAdmissionStore } from '../src/modules/admission/adapters/redis-admission-store.js';
import { PurchaseSessionSlots } from '../src/modules/admission/application/purchase-session-slots.js';
import { PurchaseSessionHandler } from '../src/modules/admission/inbound/purchase-session.handler.js';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { EVENTS_KEY, RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { RedisWithdrawnDue } from '../src/modules/entry/adapters/redis-withdrawn-due.js';
import { RedisWithdrawnKeys } from '../src/modules/entry/adapters/redis-withdrawn-keys.js';
import { WithdrawnDueWorker } from '../src/modules/entry/application/withdrawn-due-worker.js';
import { PurgeWithdrawnKeys } from '../src/modules/entry/application/purge-withdrawn-keys.js';
import { AccountWithdrawnHandler } from '../src/modules/entry/inbound/account-withdrawn.handler.js';
import { ApplySaleChange, EventSaleChangedHandler, RedisSaleStates, SEATS_TOPIC } from '../src/modules/sale/index.js';
import { saleEvent } from '../test/sale-state-cases.js';
import { newEvent } from '../test/support.js';
import { type KafkaContainer, startKafka, until } from './kafka.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let kafka: KafkaContainer;
let valkey: ValkeyContainer;
let redis: HotRedis;
let producer: KafkaProducer;
let consumers: QueueConsumers;
let worker: WithdrawnDueWorker;
const metrics = new PlatformMetrics('queue-svc');
/** 탈퇴 사건 미루기를 시험에서 줄인다(운영 15분) */
const DELAY_MS = 8_000;

beforeAll(async () => {
  [kafka, valkey] = await Promise.all([startKafka(), startValkey()]);
  redis = await createHotRedis({ url: valkey.url });
  for (const t of QUEUE_TOPICS) await kafka.createTopic(t, 1);
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'it-producer', kind: 'default' });
  await producer.connect();
  const purge = new PurgeWithdrawnKeys(new RedisWithdrawnKeys(redis), systemClock);
  const due = new RedisWithdrawnDue(redis, systemClock);
  worker = new WithdrawnDueWorker(due, purge, systemClock, { everyMs: 200 });
  worker.start();
  consumers = startQueueConsumers({
    env: 'ci',
    brokers: kafka.brokers,
    clientId: 'queue-svc-ci-it',
    redis,
    handlers: {
      purchaseSessions: new PurchaseSessionHandler(new PurchaseSessionSlots(new RedisAdmissionStore(redis))),
      accountsWithdrawn: new AccountWithdrawnHandler(purge, undefined, { delayMs: DELAY_MS, due }),
      saleChanged: new EventSaleChangedHandler(new ApplySaleChange(new RedisSaleStates(redis), new RedisEventSchedules(redis, systemClock), systemClock)),
    },
    registry: metrics.registry,
    commitEveryMs: 200,
    measureHeldEveryMs: 200,
  });
  await consumers.started;
}, 180_000);

afterAll(async () => {
  await consumers?.stop().catch(() => {});
  await worker?.stop();
  await producer?.disconnect().catch(() => {});
  await redis?.close();
  kafka?.stop();
  valkey?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });
const send = (topic: string, key: string, value: unknown) => producer.send({ topic, messages: [{ key, value: typeof value === 'string' ? value : JSON.stringify(value) }] });

test('Q-T51_trade.seats의EventSaleChanged는_그룹하나로받아notice에쓰고_좌석사건은건너뛰며_판번호차례대로남는다', async () => {
  const eventId = newEvent();
  await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), '42']);
  await send(SEATS_TOPIC, eventId, { type: 'HELD', eventId, seatId: 's-1', fencingToken: 1 });
  await send(SEATS_TOPIC, eventId, saleEvent(eventId, { status: 'SOLD_OUT', version: 2, soldOutTiers: ['R'] }));
  await send(SEATS_TOPIC, eventId, saleEvent(eventId, { status: 'ON_SALE', version: 1 }));
  await until(async () => String(await cmd(keys.notice(eventId), ['HGET', keys.notice(eventId), 'saleVersion'])) === '2', '판매 상태 사건 반영', 30_000);
  // 좌석 사건은 건너뛴다: 처리기가 보류하지 않았고(skip: 키), notice에 좌석 칸이 생기지 않는다
  expect(await cmd(heldKeys.keys(SEATS_TOPIC), ['ZSCORE', heldKeys.keys(SEATS_TOPIC), `skip:${eventId}`])).toBeNull();
  // 늦게 온 옛 판(version 1)이 덮지 않는다
  await new Promise((r) => setTimeout(r, 500));
  const n = keys.notice(eventId);
  expect(String(await cmd(n, ['HGET', n, 'saleState']))).toBe('SOLD_OUT');
  expect(String(await cmd(n, ['HGET', n, 'soldOutLastSeq']))).toBe('42');
  expect(String(await cmd(n, ['HGET', n, 'soldOutTiers']))).toBe('["R"]');
});

test('ST-T19_모양이틀린판매상태사건은_대기열Redis에보류되고_다른회차는그대로처리한다', async () => {
  const bad = newEvent();
  const good = newEvent();
  await send(SEATS_TOPIC, bad, { eventId: bad, status: 'SOLD_OUT', version: 'x' });
  await send(SEATS_TOPIC, good, saleEvent(good, { status: 'ALL_HELD', version: 1 }));
  await until(async () => String(await cmd(keys.notice(good), ['HGET', keys.notice(good), 'saleState'])) === 'ALL_HELD', '다른 회차 처리', 30_000);
  // 같은 결과일 실패를 5회(0.2~1.6초 쉬며) 해 본 뒤 보류한다
  await until(async () => (await cmd(heldKeys.keys(SEATS_TOPIC), ['ZSCORE', heldKeys.keys(SEATS_TOPIC), `bad:${bad}`])) !== null, '보류', 30_000);
  // 회차 키로는 보류하지 않으므로 같은 회차의 뒤 정상 판(매진 포함)이 그대로 반영된다
  expect(await cmd(heldKeys.keys(SEATS_TOPIC), ['ZSCORE', heldKeys.keys(SEATS_TOPIC), bad])).toBeNull();
  await send(SEATS_TOPIC, bad, saleEvent(bad, { status: 'SOLD_OUT', version: 2 }));
  await until(async () => String(await cmd(keys.notice(bad), ['HGET', keys.notice(bad), 'saleState'])) === 'SOLD_OUT', '보류 뒤 같은 회차의 정상 판', 30_000);
  // 보류 수 지표가 그 보류를 센다(재는 주기를 시험에서 줄였다)
  await until(async () => /consumer_held_events\{[^}]*topic="trade\.seats"[^}]*\} [1-9]/.test(await metrics.registry.metrics()), '보류 수 지표', 30_000);
});

test('PRF-136_구매세션종료사건은_그입장자리를뺀다', async () => {
  const eventId = newEvent();
  const jti = randomUUID();
  const slots = `q:{event:${eventId}}:slots`;
  await cmd(slots, ['ZADD', slots, String(Date.now() + 300_000), jti]);
  await send(PURCHASE_SESSIONS_TOPIC, eventId, { eventId, purchaseSessionId: randomUUID(), admissionJti: jti, reason: 'COMPLETED', endedAt: new Date().toISOString(), eventKey: randomUUID() });
  await until(async () => (await cmd(slots, ['ZSCORE', slots, jti])) === null, '자리 빼기', 30_000);
});

test('I-T27_탈퇴사건은_처리할때집합에넣고바로커밋하며_withdrawnAt+미루기가지난뒤작업이q:dup만료를purgeBy로당긴다', async () => {
  const eventId = newEvent();
  const pid = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
  const now = Date.now();
  await cmd(EVENTS_KEY, ['ZADD', EVENTS_KEY, String(now + 86_400_000), eventId]);
  const dup = keys.dup(pid, eventId);
  await cmd(dup, ['SET', dup, '1:1:r:j:', 'PXAT', String(now + 86_400_000)]);
  const purgeBy = now + 3_600_000;
  const accountId = randomUUID();
  await send(ACCOUNTS_WITHDRAWN_TOPIC, accountId, { eventKey: randomUUID(), accountId, pids: [pid], withdrawnAt: new Date(now).toISOString(), purgeBy: new Date(purgeBy).toISOString() });
  // 처리할 때 집합에 넣고 바로 오프셋을 커밋한다(때가 안 된 사건이 파티션을 막지 않는다)
  await until(async () => ((await kafka.groupOffsets(QUEUE_GROUP('ci'), ACCOUNTS_WITHDRAWN_TOPIC)).get(0) ?? 0) >= 1, '탈퇴 사건 오프셋 커밋', DELAY_MS - 1_000, 300);
  expect(Date.now()).toBeLessThan(now + DELAY_MS);
  expect(Number(await cmd(dup, ['PEXPIRETIME', dup]))).toBe(now + 86_400_000);
  await until(async () => Number(await cmd(dup, ['PEXPIRETIME', dup])) === purgeBy, '탈퇴 키 만료 당기기', 30_000);
  expect(Date.now()).toBeGreaterThanOrEqual(now + DELAY_MS);
});
