// 홀드 원장 적재의 끝에서 끝 시험(BUILD_ORDER PRF-141, S-T35): 실제 Valkey 8.1 홀드 → 좌석 Stream 릴레이 틱 → 실제 Kafka trade.seats →
// 키 단위 소비자(platform runKeyedConsumer, ADR-0142)의 SeatHoldLedgerHandler(DrizzleSeatHoldLedger) → 실제 PostgreSQL 18 seat_hold.
// 규칙의 정본은 docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현'의 '적재 소비자', 보류 규칙은 docs/data.md §4의 15번(held_event)이다.
//
// 약속:
// - 회차 ID는 이번 달 UUIDv7(파티션 키), 좌석·계정은 소문자 UUID다(원장 적재의 UUID 검사).
// - DB 상태는 직접 SQL로, Kafka 소비 진행은 브로커의 소비자 그룹 커밋 위치로 본다(처리기가 끝낸 위치까지만 커밋된다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, drizzleHeldEventStore, KEYED_CONSUMER_DEFAULTS, createHotRedis, type HotRedis, systemClock, uuidv7 } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer, type KeyedConsumerRun, runKeyedConsumer } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import {
  DrizzleSeatHoldLedger,
  jsonTradeEventCodec,
  KafkaTradeEventPublisher,
  RedisSeatStore,
  RedisSeatStreamSource,
  SEAT_TOPIC,
  SeatHoldLedgerHandler,
  SeatStreamRelay,
} from '../src/modules/inventory/index.js';
import { type KafkaContainer, startKafka, until } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { holdSeats, iso, openSale, seatEventKeyOf, seatRefs, streamItems, uuid8 } from './seat-stream.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const GROUP = 'peaket.purchase-svc-hold-ledger.it';

let valkey: ValkeyContainer | undefined;
let kafka: KafkaContainer | undefined;
let pgc: PostgresContainer | undefined;
let redis: HotRedis;
let store: RedisSeatStore;
let database: Database;
let admin: Database;
let producer: KafkaProducer;
let consumer: KeyedConsumerRun | undefined;
const warnings: string[] = [];

beforeAll(async () => {
  const [a, b, c] = await Promise.allSettled([startValkey(), startKafka(), startPostgres()]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') kafka = b.value;
  if (c.status === 'fulfilled') pgc = c.value;
  const failed = [a, b, c].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason as Error;
  await kafka!.createTopic(SEAT_TOPIC, 3);
  await migratePurchase(pgc!.url);
  await ensureSeatHoldPartitions(pgc!.url);
  redis = await createHotRedis({ url: valkey!.url });
  store = new RedisSeatStore(redis);
  database = createDatabase({ url: pgc!.url, profile: 'general', max: 10, applicationName: 'hold-ledger-e2e' });
  admin = createDatabase({ url: pgc!.url, profile: 'general', max: 4, applicationName: 'hold-ledger-e2e-admin' });
  producer = createKafkaProducer({ brokers: kafka!.brokers, clientId: 'hold-ledger-e2e-producer', kind: 'default' });
  await producer.connect();
  consumer = runKeyedConsumer({
    brokers: kafka!.brokers,
    clientId: 'hold-ledger-e2e-consumer',
    service: 'purchase-svc',
    groupId: GROUP,
    topics: [SEAT_TOPIC],
    held: drizzleHeldEventStore(database, systemClock),
    handler: new SeatHoldLedgerHandler(new DrizzleSeatHoldLedger(database)),
    commitEveryMs: 200,
    logger: { warn: (_o, msg) => void warnings.push(String(msg)) },
  });
  await consumer.started;
}, 240_000);

afterAll(async () => {
  await consumer?.stop().catch(() => {});
  await producer?.disconnect().catch(() => {});
  await redis?.close();
  await Promise.allSettled([database?.close(), admin?.close()]);
  valkey?.stop();
  kafka?.stop();
  pgc?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async (text: string, args: unknown[]) => (await admin.pool.query(text, args)).rows as Record<string, unknown>[];
const seatHoldRows = (eventId: string) => q('select seat_id, account_id, fencing_token::text as fencing_token, status, kind, held_at, expires_at from seat_hold where event_id = $1 order by seat_id', [eventId]);
const heldEvents = (eventId: string) => q('select business_key, event_key, error, held_at, record_at from held_event where msg_key = $1 order by kafka_offset', [eventId]);

/** 소비자 그룹이 토픽의 끝까지 처리하고 커밋했다(레코드가 있는 모든 파티션의 커밋 위치 = 끝 위치) */
async function drained(): Promise<boolean> {
  const [ends, committed] = await Promise.all([kafka!.endOffsets(SEAT_TOPIC), kafka!.groupOffsets(GROUP, SEAT_TOPIC)]);
  return [...ends].every(([p, end]) => end === 0 || committed.get(p) === end);
}

const send = (eventId: string, value: object) => producer.send({ topic: SEAT_TOPIC, messages: [{ key: eventId, value: Buffer.from(JSON.stringify(value)) }] });

/** 직접 만든 HELD SeatEvent(릴레이를 거치지 않는 레코드) */
function directHeld(eventId: string, seatId: string, heldAtMs: number): Record<string, unknown> {
  const holdId = uuidv7(systemClock);
  return {
    eventId,
    seatId,
    tierId: 'R',
    sectionId: 'SEC-A',
    type: 'HELD',
    fencingToken: 1_762_250_000_000_101,
    sectionVersion: 1,
    seatEpoch: 1,
    holdId,
    holdKind: 'FAN',
    purchaseSessionId: randomUUID(),
    accountId: randomUUID(),
    expiresAt: iso(heldAtMs + 7 * 60_000),
    occurredAt: iso(heldAtMs),
    eventKey: seatEventKeyOf('HELD', eventId, holdId, seatId),
  };
}

// ───────────────────────────── 시험 ─────────────────────────────

test('ST35_Valkey 홀드 → 릴레이 틱 → Kafka trade.seats → 적재 소비자 → seat_hold HELD 행(held_at = Stream의 occurredAtMs = 홀드 Lua의 heldAt). 같은 토픽의 판매 사건(SOLD)·EventSaleChanged는 건너뛴다(행·보류 없음)', async () => {
  const eventId = uuidv7(systemClock);
  await openSale(store, eventId);
  // 판매 사건과 회차 판매 상태(seat_sale·event_sale Outbox가 같은 토픽·같은 키로 내는 것)를 먼저 넣는다
  const soldSeat = randomUUID();
  await send(eventId, { eventId, seatId: soldSeat, tierId: 'R', sectionId: 'SEC-A', type: 'SOLD', holdId: uuidv7(systemClock), occurredAt: iso(Date.now()), eventKey: uuid8(`it-sold:${eventId}:${soldSeat}`) });
  await send(eventId, { eventId, status: 'SOLD_OUT', previousStatus: 'ON_SALE', available: 0, held: 0, paying: 0, version: 3, changedAt: iso(Date.now()), eventKey: uuid8(`it-esc:${eventId}`) });

  const h = await holdSeats(store, eventId, seatRefs(1));
  const [item] = await streamItems(redis, eventId);
  expect(Number(item!.fields.occurredAtMs)).toBe(h.heldAtMs);
  const relay = new SeatStreamRelay({ source: new RedisSeatStreamSource(redis), publisher: new KafkaTradeEventPublisher(producer), codec: jsonTradeEventCodec });
  const report = await relay.tick();
  expect(report.events.find((e) => e.eventId === eventId)).toMatchObject({ sent: 1, acked: 1 });

  await until(async () => (await seatHoldRows(eventId)).length > 0, 'seat_hold 행');
  await until(drained, '소비자 그룹이 끝까지 처리', 60_000, 500);
  const rows = await seatHoldRows(eventId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ seat_id: h.seats[0]!.seatId, account_id: h.accountId, fencing_token: String(h.fencingToken), status: 'HELD', kind: 'FAN' });
  expect((rows[0]!.held_at as Date).getTime()).toBe(h.heldAtMs);
  expect((rows[0]!.expires_at as Date).getTime()).toBe(h.expiresAtMs);
  expect(await heldEvents(eventId)).toEqual([]);
}, 120_000);

test('모양이 틀린 HELD(accountId 빠짐)는 5회 [가정] 해 본 뒤 held_event에 1행 보류되고 seat_hold에는 아무것도 없다. 같은 회차의 바른 HELD(다른 좌석)는 막히지 않고 들어간다', async () => {
  const eventId = uuidv7(systemClock);
  const badSeat = randomUUID();
  const goodSeat = randomUUID();
  const { accountId: _drop, ...bad } = directHeld(eventId, badSeat, Date.now());
  const good = directHeld(eventId, goodSeat, Date.now());
  await send(eventId, bad);
  await send(eventId, good);

  await until(async () => (await heldEvents(eventId)).length > 0 && (await seatHoldRows(eventId)).length > 0, '보류 행과 바른 HELD 행', 30_000, 200);
  await until(drained, '소비자 그룹이 끝까지 처리', 60_000, 500);
  const held = await heldEvents(eventId);
  expect(held).toHaveLength(1);
  // 업무 키는 '회차 ID:좌석 ID'다. 모양이 틀려도 회차·좌석을 읽을 수 있으면 그 좌석의 키로 보류한다(회차 키로 보류하면 그 회차의 다른 사건까지 막힌다, 코드 리뷰)
  expect(String(held[0]!.business_key)).toBe(`${eventId}:${badSeat}`);
  // 같은 결과일 실패의 다시 하기 쉬기(0.2·0.4·0.8·1.6초 [가정])를 모두 거친 뒤 보류했다
  const waits = Array.from({ length: KEYED_CONSUMER_DEFAULTS.attempts - 1 }, (_, i) => KEYED_CONSUMER_DEFAULTS.retryBaseMs * 2 ** i).reduce((x, y) => x + y, 0);
  expect((held[0]!.held_at as Date).getTime() - (held[0]!.record_at as Date).getTime()).toBeGreaterThanOrEqual(waits - 300);

  const rows = await seatHoldRows(eventId);
  expect(rows.map((r) => r.seat_id)).toEqual([goodSeat]);
  expect(rows[0]).toMatchObject({ account_id: good.accountId, status: 'HELD' });
  expect((rows[0]!.held_at as Date).getTime()).toBe(Date.parse(String(good.occurredAt)));
}, 120_000);
