// 좌석 Redis Stream → Kafka 릴레이(SeatStreamRelay + RedisSeatStreamSource + KafkaTradeEventPublisher + jsonTradeEventCodec)의 통합 시험:
// 실제 Valkey 8.1과 실제 Kafka(apache/kafka:3.9.2) 한 대씩을 파일 전체가 나눠 쓴다(BUILD_ORDER PRF-141).
// 규칙의 정본은 docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현'의 '릴레이가 읽는 법'·'보내는 법'·'보낼 수 없는 항목',
// 저장소 요점은 docs/data.md §4 '홀드 원장 적재와 Stream 릴레이', HELD·SESSION_STARTED 칸은 docs/data.md §3 s:{event:E}:stream이다.
//
// 약속:
// - 시험마다 새 회차 ID를 쓴다. Kafka 레코드는 처음부터 끝없이 읽는 시험 쪽 읽기(collectTopics)로 모아 키(회차 ID)로 걸러 본다.
// - Stream 상태(XLEN·XPENDING·XINFO·EXISTS)는 릴레이를 거치지 않고 Valkey 명령으로 직접 읽는다.
// - 시험은 차례대로 돈다(같은 s:ctl:events를 나눠 쓴다). Kafka를 멈추는 시험은 맨 끝이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createHotRedis, type HotRedis, systemClock, uuidv7 } from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  jsonTradeEventCodec,
  KafkaTradeEventPublisher,
  PURCHASE_SESSION_TOPIC,
  RedisSeatStore,
  RedisSeatStreamSource,
  RedisSessionEndedLog,
  RedisSessionStartedLog,
  type RelayTickReport,
  SEAT_TOPIC,
  SeatStreamRelay,
  type SeatStreamRelayDeps,
  type SeatStreamRelaySignals,
  seatKeys,
  STREAM_RELAY_CONSUMER,
  STREAM_RELAY_GROUP,
  type StreamDropReason,
  type TradeEventPublisher,
  type TradeTopic,
  toPurchaseSessionEnded,
  toPurchaseSessionStarted,
} from '../src/modules/inventory/index.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector, type TopicRecord, until } from './kafka.js';
import { cmd, exists, expectedSeatEvent, holdSeats, openSale, seatEventKeyOf, seatRefs, streamItems, xinfo, xlen, xpending } from './seat-stream.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let kafka: KafkaContainer | undefined;
let redis: HotRedis;
let store: RedisSeatStore;
let producer: KafkaProducer;
let reader: TopicCollector;

beforeAll(async () => {
  // 하나가 실패해도 이미 뜬 컨테이너는 afterAll이 지우게, 둘을 따로 받는다
  const [a, b] = await Promise.allSettled([startValkey(), startKafka()]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') kafka = b.value;
  if (!valkey || !kafka) throw (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as Error;
  // trade.* 토픽은 키(회차 ID)로 파티션을 고른다. 파티션이 여럿이어야 '같은 파티션에 그 차례로'가 뜻이 있다
  await kafka.createTopic(SEAT_TOPIC, 3);
  await kafka.createTopic(PURCHASE_SESSION_TOPIC, 3);
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisSeatStore(redis);
  // 보내기 상한 5초(kind default)라 Kafka를 멈춘 시험의 실패가 빨리 온다
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'seat-relay-it', kind: 'default' });
  await producer.connect();
  reader = await collectTopics(kafka.brokers, [SEAT_TOPIC, PURCHASE_SESSION_TOPIC], `seat-relay-it-reader-${randomUUID()}`);
}, 180_000);

afterAll(async () => {
  await reader?.close();
  await producer?.disconnect().catch(() => {});
  await redis?.close();
  valkey?.stop();
  kafka?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const newEventId = () => uuidv7(systemClock);

/** 운영과 같은 조립의 릴레이(시험이 바꾸는 것만 덮는다) */
function relayOf(extra: Partial<SeatStreamRelayDeps> = {}): SeatStreamRelay {
  return new SeatStreamRelay({ source: new RedisSeatStreamSource(redis), publisher: new KafkaTradeEventPublisher(producer), codec: jsonTradeEventCodec, ...extra });
}

/** 틱 결과에서 그 회차의 것 */
function reportOf(r: RelayTickReport, eventId: string) {
  const e = r.events.find((x) => x.eventId === eventId);
  if (!e) throw new Error(`틱 결과에 회차 ${eventId}가 없다: ${JSON.stringify(r)}`);
  return e;
}

const on = (topic: TradeTopic, eventId: string) => (r: TopicRecord) => r.topic === topic && r.key === eventId;
const valueOf = (r: TopicRecord) => JSON.parse(r.value ?? 'null') as Record<string, unknown>;

/** 토픽 전체의 끝 위치 합(이 파일의 시험이 차례로 돌아 다른 쪽이 쓰지 않는다: 늘어난 만큼이 이번에 나간 레코드다) */
async function totalEnd(topic: TradeTopic): Promise<number> {
  return [...(await kafka!.endOffsets(topic)).values()].reduce((a, b) => a + b, 0);
}

interface RecordingSignals extends SeatStreamRelaySignals {
  sentLog: [TradeTopic, number][];
  droppedLog: StreamDropReason[];
  failedLog: string[];
}
function recordingSignals(): RecordingSignals {
  const s: RecordingSignals = {
    sentLog: [],
    droppedLog: [],
    failedLog: [],
    sent: (topic, n) => void s.sentLog.push([topic, n]),
    dropped: (reason) => void s.droppedLog.push(reason),
    failed: (stage) => void s.failedLog.push(stage),
  };
  return s;
}

// ───────────────────────────── 시험 ─────────────────────────────

describe('SeatStreamRelay: 읽기·보내기·지우기', () => {
  test('ST35_HELD 항목 하나가 trade.seats에 키 = 회차 ID, 값 = SeatEvent JSON(occurredAt = Stream의 occurredAtMs = 홀드 Lua의 heldAt)으로 나가고, XACK·XTRIM으로 Stream에서 지워진다', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    const h = await holdSeats(store, eventId, seatRefs(1));
    const [item] = await streamItems(redis, eventId);
    expect(item!.fields.type).toBe('HELD');
    expect(Number(item!.fields.occurredAtMs)).toBe(h.heldAtMs);

    const report = await relayOf().tick();
    expect(reportOf(report, eventId)).toMatchObject({ sent: 1, dropped: 0, acked: 1 });
    expect(reportOf(report, eventId).failed).toBeUndefined();

    const [rec] = await reader.waitFor(on(SEAT_TOPIC, eventId));
    expect(valueOf(rec!)).toEqual(expectedSeatEvent(eventId, item!.fields));
    expect(valueOf(rec!)).toMatchObject({
      type: 'HELD',
      seatId: h.seats[0]!.seatId,
      accountId: h.accountId,
      purchaseSessionId: h.purchaseSessionId,
      holdId: h.holdId,
      fencingToken: h.fencingToken,
      occurredAt: new Date(h.heldAtMs).toISOString(),
      expiresAt: new Date(h.expiresAtMs).toISOString(),
      eventKey: seatEventKeyOf('HELD', eventId, h.holdId, h.seats[0]!.seatId, h.fencingToken),
    });
    // 확인받은 항목은 확인(XACK)되고 지워졌다(XTRIM MINID)
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await xpending(redis, eventId)).toBe(0);
  });

  test('소비자 그룹은 Stream마다 stream-relay 하나, 소비자 이름은 relay 하나다. Stream이 없는 회차(s:ctl:events에만 있음)는 틱 뒤에도 키가 생기지 않는다(MKSTREAM 없음)', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    await holdSeats(store, eventId, seatRefs(2));
    const bare = newEventId();
    const list = seatKeys.ctlEvents();
    await cmd(redis, list, ['SADD', list, bare]);

    const report = await relayOf().tick();
    expect(reportOf(report, eventId)).toMatchObject({ sent: 2, acked: 2 });
    const groups = await xinfo(redis, eventId, 'GROUPS');
    expect(groups.map((g) => g.name)).toEqual([STREAM_RELAY_GROUP]);
    expect(STREAM_RELAY_GROUP).toBe('stream-relay');
    const consumers = await xinfo(redis, eventId, 'CONSUMERS');
    expect(consumers.map((c) => c.name)).toEqual([STREAM_RELAY_CONSUMER]);
    expect(STREAM_RELAY_CONSUMER).toBe('relay');

    expect(await exists(redis, seatKeys.stream(bare))).toBe(0);
    const bareReport = report.events.find((e) => e.eventId === bare);
    if (bareReport) expect(bareReport).toMatchObject({ sent: 0, acked: 0 });
    if (bareReport) expect(bareReport.failed).toBeUndefined();
    // 한 번 더 돌아도 그대로
    await relayOf().tick();
    expect(await exists(redis, seatKeys.stream(bare))).toBe(0);
  });

  test('구매 세션 시작·종료 항목(SESSION_STARTED·SESSION_ENDED)은 trade.purchase-sessions로 그 차례대로 나가고 trade.seats에는 아무것도 가지 않는다', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    const jti = randomUUID();
    const now = Date.now();
    await new RedisSessionStartedLog(redis).appendStarted({ eventId, purchaseSessionId: jti, admissionJti: jti, journeyId: uuidv7(systemClock), startedAtMs: now, maxStayUntilMs: now + 45 * 60_000 });
    await new RedisSessionEndedLog(redis).appendEnded({ eventId, purchaseSessionId: jti, admissionJti: jti, reason: 'LEFT', endedAtMs: now + 1_000 });
    const items = await streamItems(redis, eventId);
    expect(items.map((i) => i.fields.type)).toEqual(['SESSION_STARTED', 'SESSION_ENDED']);
    const seatsBefore = await totalEnd(SEAT_TOPIC);

    const report = await relayOf().tick();
    expect(reportOf(report, eventId)).toMatchObject({ sent: 2, dropped: 0, acked: 2 });

    const recs = await reader.waitFor(on(PURCHASE_SESSION_TOPIC, eventId), 2);
    expect(recs).toHaveLength(2);
    expect(recs.map(valueOf)).toEqual([toPurchaseSessionStarted(eventId, items[0]!.fields), toPurchaseSessionEnded(eventId, items[1]!.fields)]);
    expect(recs[0]!.partition).toBe(recs[1]!.partition);
    expect(recs[0]!.offset).toBeLessThan(recs[1]!.offset);
    expect(await totalEnd(SEAT_TOPIC)).toBe(seatsBefore);
    expect(reader.records.filter(on(SEAT_TOPIC, eventId))).toEqual([]);
    expect(await xlen(redis, eventId)).toBe(0);
  });

  test('여러 항목(좌석 5개, 홀드 셋)은 Stream ID 순으로 한 번에 같은 파티션에 그 차례대로 나간다', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    await holdSeats(store, eventId, seatRefs(2));
    await holdSeats(store, eventId, seatRefs(1));
    await holdSeats(store, eventId, seatRefs(2));
    const items = await streamItems(redis, eventId);
    expect(items).toHaveLength(5);
    const signals = recordingSignals();

    const report = await relayOf({ signals }).tick();
    expect(reportOf(report, eventId)).toMatchObject({ sent: 5, dropped: 0, acked: 5 });
    expect(signals.sentLog.filter(([t]) => t === SEAT_TOPIC).reduce((a, [, n]) => a + n, 0)).toBeGreaterThanOrEqual(5);

    const recs = await reader.waitFor(on(SEAT_TOPIC, eventId), 5);
    expect(recs).toHaveLength(5);
    expect(new Set(recs.map((r) => r.partition)).size).toBe(1);
    const sorted = [...recs].sort((a, b) => a.offset - b.offset);
    expect(sorted.map(valueOf)).toEqual(items.map((i) => expectedSeatEvent(eventId, i.fields)));
    expect(await xlen(redis, eventId)).toBe(0);
  });

  test('묶음이 꽉 차면 한 틱 안에서 이어 읽는다(코드 리뷰: 회차마다 초당 한 묶음에 묶이지 않게): batch 2면 5개가 2·2·1 묶음으로 한 틱에 모두 나가고 차례가 그대로다 [ASVS v5.0.0-15.2.2]', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    for (let i = 0; i < 5; i++) await holdSeats(store, eventId, seatRefs(1));
    const items = await streamItems(redis, eventId);
    const relay = relayOf({ batch: 2 });

    expect(reportOf(await relay.tick(), eventId)).toMatchObject({ sent: 5, acked: 5 });
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await xpending(redis, eventId)).toBe(0);

    const recs = (await reader.waitFor(on(SEAT_TOPIC, eventId), 5)).sort((a, b) => a.offset - b.offset);
    expect(recs.map((r) => valueOf(r).seatId)).toEqual(items.map((i) => i.fields.seatId));
  });

  test('보낼 수 없는 항목(모르는 type, 모양이 틀린 HELD, 좌석맵 판에 없는 좌석의 빈 seatId EXPIRED)은 보내지 않고 확인해 넘기며 Stream을 막지 않는다. 경고 로그에는 항목 ID와 type만 남는다', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    const key = seatKeys.stream(eventId);
    const secret = randomUUID();
    const bogus = String(await cmd(redis, key, ['XADD', key, '*', 'type', 'BOGUS', 'accountId', secret]));
    const h = await holdSeats(store, eventId, seatRefs(1));
    const good = (await streamItems(redis, eventId)).find((i) => i.fields.holdId === h.holdId)!;
    // 모양이 틀림: 좌석 칸은 다 있고 펜싱 토큰이 10진 글이 아니다
    const malformedFields = { ...good.fields, seatId: randomUUID(), fencingToken: 'not-a-number', accountId: secret };
    const malformed = String(await cmd(redis, key, ['XADD', key, '*', ...Object.entries(malformedFields).flat()]));
    const unmappedFields = { ...good.fields, type: 'EXPIRED', seatId: '', tierId: '', sectionId: '', accountId: secret };
    const unmapped = String(await cmd(redis, key, ['XADD', key, '*', ...Object.entries(unmappedFields).flat()]));
    const seatsBefore = await totalEnd(SEAT_TOPIC);
    const signals = recordingSignals();
    const warnings: { obj: object; msg: string }[] = [];

    const report = await relayOf({ signals, logger: { warn: (obj, msg) => void warnings.push({ obj, msg }) } }).tick();
    expect(reportOf(report, eventId)).toMatchObject({ sent: 1, dropped: 3, acked: 4 });
    expect(reportOf(report, eventId).failed).toBeUndefined();
    expect([...signals.droppedLog].sort()).toEqual(['malformed', 'unknown_type', 'unmapped_seat']);

    const [rec] = await reader.waitFor(on(SEAT_TOPIC, eventId));
    expect(valueOf(rec!)).toEqual(expectedSeatEvent(eventId, good.fields));
    expect(await totalEnd(SEAT_TOPIC)).toBe(seatsBefore + 1);
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await xpending(redis, eventId)).toBe(0);

    // 넘긴 항목마다 경고가 있고, 그 경고에는 항목 ID가 실리며 칸 값(계정 ID)은 실리지 않는다
    const logged = JSON.stringify(warnings);
    for (const id of [bogus, malformed, unmapped]) expect(logged).toContain(id);
    expect(logged).not.toContain(secret);
  });
});

describe('SeatStreamRelay: 실패와 다시 보내기(적어도 한 번)', () => {
  test('보내기가 확인 전에 실패하면 확인하지 않고(XPENDING에 남음), 리더가 바뀌어 새 RedisSeatStreamSource가 같은 이름으로 이어 받아 다시 보낸다. 두 번 나간 항목의 값·eventKey가 같다 [ASVS v5.0.0-16.5.2]', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    const h = await holdSeats(store, eventId, seatRefs(1));
    const [item] = await streamItems(redis, eventId);
    const real = new KafkaTradeEventPublisher(producer);
    // 실제로 보내고 나서 확인을 못 받은 것처럼 던진다(보내기 시간 초과로 일부만 나간 경우)
    const lost: TradeEventPublisher = {
      publish: async (records) => {
        await real.publish(records);
        throw Object.assign(new Error('확인 시간 초과(시험)'), { name: 'TimeoutError' });
      },
    };
    const signals = recordingSignals();
    const first = await relayOf({ publisher: lost, signals }).tick();
    expect(reportOf(first, eventId)).toMatchObject({ sent: 0, acked: 0, failed: 'publish' });
    expect(signals.failedLog).toContain('publish');
    expect(await xpending(redis, eventId)).toBe(1);
    expect(await xlen(redis, eventId)).toBe(1);

    // 새 리더: 새 소스(이미 있는 소비자 그룹을 다시 만들려다 멈추지 않는다)와 새 릴레이
    const second = await relayOf().tick();
    expect(reportOf(second, eventId)).toMatchObject({ sent: 1, acked: 1 });
    expect(reportOf(second, eventId).failed).toBeUndefined();

    const recs = await reader.waitFor(on(SEAT_TOPIC, eventId), 2);
    expect(recs).toHaveLength(2);
    expect(valueOf(recs[0]!)).toEqual(valueOf(recs[1]!));
    expect(valueOf(recs[0]!).eventKey).toBe(seatEventKeyOf('HELD', eventId, h.holdId, h.seats[0]!.seatId, h.fencingToken));
    expect(valueOf(recs[0]!)).toEqual(expectedSeatEvent(eventId, item!.fields));
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await xpending(redis, eventId)).toBe(0);
    expect((await xinfo(redis, eventId, 'CONSUMERS')).map((c) => c.name)).toEqual([STREAM_RELAY_CONSUMER]);
  });

  test('Kafka를 멈춘 채 틱 → 보내기 실패로 확인하지 않는다(XPENDING·XLEN 1). 다시 띄우고 틱 → 같은 항목이 나가고 지워진다', async () => {
    const eventId = newEventId();
    await openSale(store, eventId);
    const h = await holdSeats(store, eventId, seatRefs(1));
    const [item] = await streamItems(redis, eventId);
    const relay = relayOf();

    kafka!.pause();
    try {
      const down = await relay.tick();
      expect(reportOf(down, eventId)).toMatchObject({ acked: 0, failed: 'publish' });
      expect(await xpending(redis, eventId)).toBe(1);
      expect(await xlen(redis, eventId)).toBe(1);
    } finally {
      await kafka!.resume();
    }

    // 브로커가 다시 받기까지 릴레이는 틱마다 다시 보낸다
    await until(async () => (await relay.tick()).events.some((e) => e.eventId === eventId && e.acked === 1), 'Kafka가 돌아온 뒤 보내기', 90_000, 500);
    expect(await xlen(redis, eventId)).toBe(0);
    expect(await xpending(redis, eventId)).toBe(0);
    const recs = await reader.waitFor(on(SEAT_TOPIC, eventId), 1, 60_000);
    for (const r of recs) expect(valueOf(r)).toEqual(expectedSeatEvent(eventId, item!.fields));
    expect(new Set(recs.map((r) => valueOf(r).eventKey))).toEqual(new Set([seatEventKeyOf('HELD', eventId, h.holdId, h.seats[0]!.seatId, h.fencingToken)]));
  }, 240_000);
});
