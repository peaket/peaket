// purchase-svc 릴레이 프로세스 조립(startPurchaseRelay)의 통합 시험(BUILD_ORDER PRF-164): 실제 PostgreSQL 18(마이그레이션한 purchase DB)·Valkey 8.1·
// Kafka(apache/kafka:3.9.2) 한 대씩, Lease는 메모리 API(memoryLeaseApi). Kafka 생산자 하나를 Outbox 보내기(kafkaOutboxPublisher)와
// 거래 토픽 보내기(KafkaTradeEventPublisher)가 함께 쓴다(relay.ts와 같은 조립).
// 정본: docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현'(리더 반복·다시 만들기 반복·정비 일), '주문 기준 되살리기'(K1·K3),
// docs/data.md §5 '릴레이 리더 넘김', 플랫폼 packages/platform/test-int/relay-process.int.test.ts(FND110, V-T28 로컬 부분).
//
// 약속:
// - 시험 시간을 줄인다: Lease 2초·갱신 한도 1.5초·다시 시도 0.1초, 다시 만들기 반복 틱 0.2초, 세대 올리기 감시 틱 0.1초(PRF-168),
//   좌석 Stream 릴레이 쉬기는 0.05초 위를 자른다, 끝낼 때 한도 3초. 기다림은 조건이 될 때까지 다시 보는 until이다(고정 쉬기는 쓰지 않는다).
// - 세대 키 node는 Lua가 구한 노드 표지다(단일 노드 Valkey는 'standalone', 파드 이름이 아니다, PRF-168). 장애 조치(복제본 승격)는
//   세대 키 node를 HSET으로 옛 주 노드 표지로 바꿔 흉내 낸다(클러스터 승격은 S-T26 측정의 몫).
// - 좌석맵 판은 MemorySeatMap(+ refresh 대역), 회차 목록은 시험이 고치는 배열 대역이다. 목록을 읽은 수(calls)가 '다시 만들기 반복이 일했다'는 대역 신호다.
// - 앞 describe(프로세스 하나)는 시험 다섯이 같은 프로세스를 나눠 쓰고 차례대로 돈다(/metrics 시험은 앞 시험이 보낸 수·다시 만든 수를 본다).
// - 다시 만들기 반복은 판매를 연 기록(seat_rebuild 행)이 있는 회차만 다시 만든다(리뷰 고침 M3). saleWorld가 판매 열기 전에 그 기록을 넣는다(판매 열기를 부르는 쪽의 차례).
//   뒤 describe(두 프로세스 다툼)는 앞 프로세스를 멈춘 뒤 돈다(같은 s:ctl:events·Outbox 표를 함께 보므로).
// - DB 역할 셋(릴레이·정비·서비스)은 같은 슈퍼유저 주소의 풀 셋이다(역할 권한은 마이그레이션 시험과 kind e2e가 본다).
// - 씨앗(판매 행·주문 행·원장 행)은 직접 SQL로 넣는다. 씨앗을 넣은 뒤에 프로세스를 띄운다(뼈대 단계에서도 씨앗 SQL이 맞는지 드러나게).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createDatabase,
  createHotRedis,
  type Database,
  ensureOutboxPartitions,
  fakeClock,
  type HotRedis,
  type LeaseApi,
  memoryLeaseApi,
  type OutboxPublisher,
  type OutboxRecord,
  type OutboxRelayProcess,
  systemClock,
  uuidv7,
  writeOutbox,
} from '@peaket/platform';
import { createKafkaProducer, type KafkaProducer, kafkaOutboxPublisher } from '@peaket/platform/stream-worker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import {
  DrizzleSeatRebuildSource,
  type EventSeatConfig,
  KafkaTradeEventPublisher,
  KEEP_AFTER_SALE_END_MS,
  MemorySeatMap,
  PURCHASE_SESSION_TOPIC,
  RedisSeatStore,
  type SaleEvent,
  SEAT_TOPIC,
  type SeatRef,
  seatKeys,
  type TradeEventPublisher,
} from '../src/modules/inventory/index.js';
import { startPurchaseRelay } from '../src/relay-app.js';
import { collectTopics, type KafkaContainer, startKafka, type TopicCollector, type TopicRecord, until } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { cmd, hash, holdSeats, iso, openSale, seatEventKeyOf, seatRefs, xlen } from './seat-stream.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** trade.orders(asyncapi). Outbox 행 하나를 실어 볼 토픽. 운영 상수를 가져오지 않고 따로 적는다 */
const TRADE_ORDERS = 'trade.orders';
/** 시험 Lease: 기간 2초·갱신 한도 1.5초·다시 시도 0.1초(기본 12·8·2초를 줄인다) */
const LEASE = { leaseDurationMs: 2_000, renewDeadlineMs: 1_500, retryPeriodMs: 100 } as const;
/** 다시 만들기 반복 틱(기본 5초를 줄인다) */
const REBUILD_TICK_MS = 200;
/** 세대 올리기 감시 틱(기본 1초를 줄인다, PRF-168) */
const EPOCH_WATCH_TICK_MS = 100;
/** 주문 만료 안전망 반복 틱(기본 10분을 줄인다, PRF-172) */
const ORDER_EXPIRY_TICK_MS = 300;
/** 단일 노드 Valkey의 주 노드 표지(hold-lua.ts NODE_ID) */
const STANDALONE = 'standalone';
/** 승격 전 주 노드의 표지 흉내(클러스터 모양 '{CLUSTER MYID}:{cluster_my_epoch}') */
const OLD_PRIMARY = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d:3';
/** 좌석 Stream 릴레이 쉬기의 상한(기본 1초 틱·늘려 쉬기를 이 값으로 자른다) */
const STREAM_SLEEP_CAP_MS = 50;
/** 끝낼 때 정비 일·반복을 기다리는 한도 */
const STOP_TIMEOUT_MS = 3_000;
/** 주문 기준 되살리기(K1)의 살아 있는 홀드 만료 = 지금 + 7분(정본 홀드 시간) */
const HOLD_TTL_MS = 7 * MIN;

let valkey: ValkeyContainer | undefined;
let kafka: KafkaContainer | undefined;
let pgc: PostgresContainer | undefined;
let redis: HotRedis;
let store: RedisSeatStore;
/** 릴레이 역할·정비 역할·서비스 역할 자리의 풀(같은 주소)과 씨앗·읽기 풀 */
let relayDb: Database;
let maintenanceDb: Database;
let serviceDb: Database;
let admin: Database;
let producer: KafkaProducer;
let reader: TopicCollector;
/** 시험이 띄운 프로세스(afterAll이 남은 것을 멈춘다) */
const started: OutboxRelayProcess[] = [];

beforeAll(async () => {
  const [a, b, c] = await Promise.allSettled([startValkey(), startKafka(), startPostgres()]);
  if (a.status === 'fulfilled') valkey = a.value;
  if (b.status === 'fulfilled') kafka = b.value;
  if (c.status === 'fulfilled') pgc = c.value;
  const failed = [a, b, c].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason as Error;
  for (const t of [SEAT_TOPIC, PURCHASE_SESSION_TOPIC, TRADE_ORDERS]) await kafka!.createTopic(t, 3);
  await migratePurchase(pgc!.url);
  await ensureSeatHoldPartitions(pgc!.url);
  relayDb = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'relay-app-it-relay' });
  maintenanceDb = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'relay-app-it-maintenance' });
  serviceDb = createDatabase({ url: pgc!.url, profile: 'general', max: 2, applicationName: 'relay-app-it-service' });
  admin = createDatabase({ url: pgc!.url, profile: 'general', max: 4, applicationName: 'relay-app-it-admin' });
  await ensureOutboxPartitions(admin, systemClock);
  redis = await createHotRedis({ url: valkey!.url });
  store = new RedisSeatStore(redis);
  producer = createKafkaProducer({ brokers: kafka!.brokers, clientId: 'relay-app-it-producer', kind: 'default' });
  await producer.connect();
  reader = await collectTopics(kafka!.brokers, [SEAT_TOPIC, TRADE_ORDERS], `relay-app-it-reader-${randomUUID()}`);
}, 240_000);

afterAll(async () => {
  for (const p of started.splice(0)) await p.stop().catch(() => {});
  await reader?.close();
  await producer?.disconnect().catch(() => {});
  await redis?.close();
  await Promise.allSettled([relayDb?.close(), maintenanceDb?.close(), serviceDb?.close(), admin?.close()]);
  valkey?.stop();
  kafka?.stop();
  pgc?.stop();
});

// ───────────────────────────── 조립 ─────────────────────────────

/** 운영 판(LayoutSeatMap)의 refresh 자리를 센다(파일을 읽지 않는다) */
class RefreshingSeatMap extends MemorySeatMap {
  refreshes = 0;
  async refresh(): Promise<void> {
    this.refreshes += 1;
  }
}
const seatMap = new RefreshingSeatMap();

/** 시험이 고치는 회차 목록 대역. list를 부른 수(calls)가 다시 만들기 반복이 그 틱에 일했다는 신호다(리더가 아니면 부르지 않는다) */
function catalogOf(events: SaleEvent[]) {
  const c = {
    calls: 0,
    events,
    async list(): Promise<SaleEvent[]> {
      c.calls += 1;
      return c.events.map((e) => ({ ...e }));
    },
  };
  return c;
}

/** 실제 Kafka로 보내며 부른 수를 세는 거래 토픽 보내기 */
function countingTrade(): TradeEventPublisher & { calls: number } {
  const inner = new KafkaTradeEventPublisher(producer);
  const p = {
    calls: 0,
    async publish(records: Parameters<TradeEventPublisher['publish']>[0]): Promise<void> {
      p.calls += 1;
      await inner.publish(records);
    },
  };
  return p;
}

/** 실제 Kafka로 보내며 부른 수를 세는 Outbox 보내기 */
function countingOutbox(): OutboxPublisher & { calls: number } {
  const inner = kafkaOutboxPublisher(producer);
  const p = {
    calls: 0,
    async publish(records: readonly OutboxRecord[], o: { signal: AbortSignal }): Promise<void> {
      p.calls += 1;
      await inner.publish(records, o);
    },
  };
  return p;
}

/** 프로세스 로그 줄을 모은다(실패 메시지에 싣는다) */
function logSink(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(l);
      cb();
    },
  });
  return { stream, lines };
}

/** 쉬기를 STREAM_SLEEP_CAP_MS 위로 자른다. 멈춤 신호면 바로 풀린다 */
function shortSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, Math.min(ms, STREAM_SLEEP_CAP_MS));
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** 프로세스 하나를 띄운다(파드 이름 = Lease 보유자 = 다시 만들기 holder. 세대 키 node는 아니다). 관리 포트는 0(빈 포트) */
async function startRelay(o: {
  pod: string;
  lease: LeaseApi;
  catalog: ReturnType<typeof catalogOf>;
  trade?: TradeEventPublisher;
  outbox?: OutboxPublisher;
  logs?: Writable;
}): Promise<OutboxRelayProcess> {
  const p = await startPurchaseRelay({
    env: {
      PEAKET_ENV: 'local',
      PEAKET_POD: o.pod,
      PEAKET_MANAGEMENT_PORT: '0',
      PEAKET_OUTBOX_DATABASE_URL: pgc!.url,
      PEAKET_MAINTENANCE_DATABASE_URL: pgc!.url,
      PEAKET_KAFKA_BROKERS: kafka!.brokers.join(','),
    },
    database: relayDb,
    maintenanceDatabase: maintenanceDb,
    serviceDatabase: serviceDb,
    redis,
    seatMap,
    catalog: o.catalog,
    outboxPublisher: o.outbox ?? kafkaOutboxPublisher(producer),
    tradePublisher: o.trade ?? new KafkaTradeEventPublisher(producer),
    leaseApi: o.lease,
    lease: LEASE,
    holder: o.pod,
    rebuildTickMs: REBUILD_TICK_MS,
    epochWatchTickMs: EPOCH_WATCH_TICK_MS,
    orderExpirySweepTickMs: ORDER_EXPIRY_TICK_MS,
    streamSleep: shortSleep,
    seatMapRefreshMs: 60_000,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    logDestination: o.logs ?? logSink().stream,
  });
  started.push(p);
  return p;
}

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];

const on = (topic: string, key: string) => (r: TopicRecord) => r.topic === topic && r.key === key;
const valueOf = (r: TopicRecord) => JSON.parse(r.value ?? 'null') as Record<string, unknown>;

const bit = async (e: string, i: number) => Number(await cmd(redis, seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(i)]));
const holdHash = async (e: string, i: number) => {
  const h = hash(await cmd(redis, seatKeys.hold(e, i), ['HGETALL', seatKeys.hold(e, i)]));
  return Object.keys(h).length ? h : null;
};
const epochHash = async (e: string) => {
  const h = hash(await cmd(redis, seatKeys.epoch(e), ['HGETALL', seatKeys.epoch(e)]));
  return Object.keys(h).length ? h : null;
};
const expiryScore = async (e: string, i: number) => {
  const v = await cmd(redis, seatKeys.expiry(e), ['ZSCORE', seatKeys.expiry(e), String(i)]);
  return v === null || v === undefined ? null : Number(v);
};
const quota = async (e: string, a: string) => {
  const v = await cmd(redis, seatKeys.quota(e, a), ['GET', seatKeys.quota(e, a)]);
  return v === null || v === undefined ? null : Number(v);
};
const inCtlEvents = async (e: string) => Number(await cmd(redis, seatKeys.ctlEvents(), ['SISMEMBER', seatKeys.ctlEvents(), e])) === 1;
const expireAtOf = async (key: string) => Number(await cmd(redis, key, ['PEXPIRETIME', key]));
const rebuildRow = async (e: string) => (await q<{ gen: number }>('select gen from seat_rebuild where event_id = $1', [e]))[0];

/** 전체 유실 흉내: 그 회차의 좌석 Redis 키를 모두 지우고 s:ctl:events에서도 뺀다(saga-e2e.int.test.ts와 같은 방식) */
async function loseAll(eventId: string): Promise<void> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, items] = (await cmd(redis, seatKeys.epoch(eventId), ['SCAN', cursor, 'MATCH', `s:{event:${eventId}}:*`, 'COUNT', '1000'])) as [unknown, unknown[]];
    for (const x of items) keys.push(String(x));
    cursor = String(next);
  } while (cursor !== '0');
  for (const k of keys) await cmd(redis, k, ['DEL', k]);
  await cmd(redis, seatKeys.ctlEvents(), ['SREM', seatKeys.ctlEvents(), eventId]);
  expect(await epochHash(eventId)).toBeNull();
}

/** Outbox 행 하나(trade.orders, 키·값은 시험이 고른 글). 넣은 행 ID */
async function putOutbox(key: string, value: string): Promise<string> {
  const [id] = await admin.transaction((tx) => writeOutbox(tx, systemClock, [{ topic: TRADE_ORDERS, key, payload: Buffer.from(value, 'utf8') }]));
  return id!;
}

interface SaleWorld {
  eventId: string;
  refs: SeatRef[];
  saleEndsAtMs: number;
  keepUntilMs: number;
}
/**
 * 판매 중인 회차 하나(이번 달 UUIDv7, 좌석 4개 구역 A 등급 R): 좌석맵 판에 넣고 좌석 Redis 판매를 연다(세대 키 gen 1).
 * 판매를 연 기록(seat_rebuild 행, 판 번호 1)은 판매 열기 전에 넣는다(판매 열기를 부르는 쪽의 차례, BUILD_ORDER LCH-080, SeatRebuildMarks.markOpened, 리뷰 고침 M3).
 * o.opened가 거짓이면 기록을 넣지 않는다(기록 없이 연 회차: 이 단계 전에 연 회차·초안 판 파일 흉내)
 */
async function saleWorld(o: { opened?: boolean } = {}): Promise<SaleWorld> {
  const eventId = uuidv7(systemClock);
  const refs: SeatRef[] = Array.from({ length: 4 }, () => randomUUID())
    .sort()
    .map((seatId, i) => ({ seatId, index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' }));
  const saleEndsAtMs = Date.now() + DAY;
  const config: EventSeatConfig = { eventId, layoutVersion: 'v1', seatCount: refs.length, perAccountLimit: 4, saleEndsAtMs, tierPrices: { R: 99_000 } };
  seatMap.put(config, refs);
  const keepUntilMs = saleEndsAtMs + KEEP_AFTER_SALE_END_MS;
  if (o.opened ?? true) await new DrizzleSeatRebuildSource(admin).markOpened(eventId);
  await store.openSale({ eventId, seatCount: refs.length, keepUntilMs });
  return { eventId, refs, saleEndsAtMs, keepUntilMs };
}
const saleEventOf = (w: SaleWorld): SaleEvent => ({ eventId: w.eventId, saleEndsAtMs: w.saleEndsAtMs });

interface SeededOrder {
  orderId: string;
  accountId: string;
  holdId: string;
  psid: string;
}
/** 판매가 끝난 주문(CONFIRMED, 이력 한 줄)과 그 좌석의 활성 판매 행 SOLD(K3: 다시 만들기가 그 주문의 holdId·psid로 묶음을 만든다) */
async function putSoldOrder(w: SaleWorld, seat: SeatRef): Promise<SeededOrder> {
  const o: SeededOrder = { orderId: uuidv7(systemClock), accountId: randomUUID(), holdId: uuidv7(systemClock), psid: randomUUID() };
  await q(
    `with o as (insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
                values ($1, $2, $3, 'CONFIRMED', 99000, 1, $4, 'consent-2026.11_v1', 'PICK', now(), $5, $6) returning id)
     insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) select id, 1, null, 'CONFIRMED', 'TEST', 'test', now() from o`,
    [o.orderId, o.accountId, w.eventId, randomUUID(), o.holdId, o.psid],
  );
  await q('insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, $5)', [w.eventId, seat.seatId, o.orderId, o.accountId, 'SOLD']);
  return o;
}

/**
 * 결제를 접수하고 묶은 주문(ACCEPTED·pinned_at·seat_gen 1, 작업 행 RESERVE, 항목 한 줄)과 그 홀드의 원장 HELD 행(만료 시각은 이미 지남).
 * 원장 홀드 길(만료 전 원장 홀드)로는 되살아나지 않아 주문 기준 되살리기(K1)로만 돌아온다. 넣은 원장 펜싱 토큰
 */
async function putPinnedOrder(w: SaleWorld, seat: SeatRef): Promise<SeededOrder & { token: number }> {
  const o: SeededOrder = { orderId: uuidv7(systemClock), accountId: randomUUID(), holdId: uuidv7(systemClock), psid: randomUUID() };
  await q(
    `with o as (insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id, seat_gen, pinned_at)
                values ($1, $2, $3, 'ACCEPTED', 99000, 1, $4, 'consent-2026.11_v1', 'PICK', now(), $5, $6, 1, now()) returning id),
          e as (insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) select id, 1, null, 'ACCEPTED', 'TEST', 'test', now() from o),
          i as (insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) select id, 1, $7, 'R', 'SEC-A', 99000 from o)
     insert into order_saga_job (order_id, event_id, step, attempts, next_attempt_at, created_at) select id, $3, 'RESERVE', 0, now() + interval '1 hour', now() from o`,
    [o.orderId, o.accountId, w.eventId, randomUUID(), o.holdId, o.psid, seat.seatId],
  );
  const token = 1_762_250_000_000_201 + seat.index;
  const now = Date.now();
  await q(
    `insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, held_at, expires_at, hold_id, purchase_session_id)
     values ($1, $2, $3, $4, 'HELD', 'FAN', $5, $6, $7, $8)`,
    [w.eventId, seat.seatId, o.accountId, token, new Date(now - 2 * MIN), new Date(now - MIN), o.holdId, o.psid],
  );
  return { ...o, token };
}

/** 만든 지 2시간 된 결제하지 않은 주문(CREATED, 항목 한 줄). 구매 세션 상태도 홀드도 없어 만료 조건이 모두 끝났다(안전망만 끝낼 수 있다: 고리는 API 파드의 몫) */
async function putAbandonedOrder(w: SaleWorld, seat: SeatRef): Promise<SeededOrder> {
  const createdAt = Date.now() - 2 * 60 * MIN;
  const clock = fakeClock({ now: createdAt });
  const o: SeededOrder = { orderId: uuidv7(clock), accountId: randomUUID(), holdId: uuidv7(clock), psid: randomUUID() };
  await q(
    `with o as (insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
                values ($1, $2, $3, 'CREATED', 99000, 1, $4, 'consent-2026.11_v1', 'PICK', $5, $6, $7) returning id),
          e as (insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) select id, 1, null, 'CREATED', 'T1', 'system:test', $5::timestamptz from o)
     insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) select id, 1, $8, 'R', 'SEC-A', 99000 from o`,
    [o.orderId, o.accountId, w.eventId, randomUUID(), new Date(createdAt), o.holdId, o.psid, seat.seatId],
  );
  return o;
}

/** 지표 글에서 이름이 name인 표본 줄(HELP·TYPE 줄 빼고) */
const samples = (text: string, name: string) => text.split('\n').filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));
/** 이름표 없는 카운터 name의 값(표본이 없으면 0) */
const counterOf = (text: string, name: string) => Number(samples(text, name).find((l) => l.startsWith(`${name} `))?.split(' ').at(-1) ?? 0);

/** 승격 흉내: 세대 키 node를 옛 주 노드 표지로 바꾼다(epoch·gen·수명은 그대로) */
const pretendFailover = (e: string) => cmd(redis, seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'node', OLD_PRIMARY]);

// ───────────────────────────── 프로세스 하나 ─────────────────────────────

const sharedCatalog = catalogOf([]);
const sharedLogs = logSink();
let shared: Promise<OutboxRelayProcess> | undefined;
/** 앞 describe가 나눠 쓰는 프로세스(처음 부를 때 띄운다). 리더가 될 때까지 기다린다 */
async function sharedRelay(): Promise<OutboxRelayProcess> {
  shared ??= startRelay({ pod: 'relay-it-0', lease: memoryLeaseApi(), catalog: sharedCatalog, logs: sharedLogs.stream });
  const p = await shared;
  await until(() => p.isLeader(), '프로세스 하나가 Lease 리더가 됨', 10_000, 25);
  return p;
}

describe('릴레이 프로세스 하나(리더)', () => {
  test('FND110_Outbox 행 하나가 리더의 Outbox 릴레이로 trade.orders에 키·값 그대로 실리고 sent_at이 적힌다', async () => {
    const key = `relay-it-${randomUUID()}`;
    const id = await putOutbox(key, '{"n":1}');
    await sharedRelay();

    const [r] = await reader.waitFor(on(TRADE_ORDERS, key), 1, 30_000);
    expect(r!.value).toBe('{"n":1}');
    await until(async () => (await q<{ sent_at: Date | null }>('select sent_at from outbox where id = $1', [id]))[0]?.sent_at != null, 'Outbox 행 sent_at', 10_000);
  }, 60_000);

  test('ST35_좌석 Stream HELD 항목(홀드 Lua로 실제 홀드 하나)이 리더의 좌석 Stream 릴레이로 trade.seats에 키 = 회차 ID, 값 = SeatEvent JSON으로 나가고 Stream에서 지워진다 [ASVS v5.0.0-16.5.2]', async () => {
    const eventId = uuidv7(systemClock);
    await openSale(store, eventId);
    const h = await holdSeats(store, eventId, seatRefs(1));
    const seat = h.seats[0]!;
    await sharedRelay();

    const [r] = await reader.waitFor(on(SEAT_TOPIC, eventId), 1, 30_000);
    expect(valueOf(r!)).toMatchObject({
      eventId,
      seatId: seat.seatId,
      type: 'HELD',
      holdId: h.holdId,
      fencingToken: h.fencingToken,
      accountId: h.accountId,
      purchaseSessionId: h.purchaseSessionId,
      occurredAt: iso(h.heldAtMs),
      expiresAt: iso(h.expiresAtMs),
      eventKey: seatEventKeyOf('HELD', eventId, h.holdId, seat.seatId, h.fencingToken),
    });
    // 보낸 뒤 확인(XACK)·자르기(XTRIM)로 Stream이 빈다
    await until(async () => (await xlen(redis, eventId)) === 0, 'Stream 항목 지움', 10_000);
  }, 60_000);

  test('ST26_판매 중 회차의 좌석 Redis 키를 모두 지우면(전체 유실) 다시 만들기 반복이 몇 틱 안에 세대 키(gen 2, node = 노드 표지 standalone, 파드 이름 아님)를 되살리고, 판매 좌석은 그 주문의 holdId로 묶음(K3), 묶인 주문 좌석은 holdId·psid 그대로 살아 있는 홀드(만료 = 지금 + 7분, K1)로 돌아오며 빈 좌석은 비어 있다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-15.4.1]', async () => {
    const w = await saleWorld();
    const [soldSeat, pinnedSeat, emptySeat] = [w.refs[0]!, w.refs[1]!, w.refs[2]!];
    const sold = await putSoldOrder(w, soldSeat);
    const pinned = await putPinnedOrder(w, pinnedSeat);
    sharedCatalog.events.push(saleEventOf(w));
    await sharedRelay();

    // 세대 키가 있는 동안은 반복이 회차를 보기만 하고 다시 만들지 않는다(판매를 연 기록은 판 번호 1 그대로)
    const before = sharedCatalog.calls;
    await until(() => sharedCatalog.calls >= before + 3, '다시 만들기 반복 세 틱', 10_000, 20);
    expect(await rebuildRow(w.eventId)).toEqual({ gen: 1 });
    expect(await epochHash(w.eventId)).toMatchObject({ gen: '1' });

    const lostAt = Date.now();
    await loseAll(w.eventId);
    await until(async () => (await epochHash(w.eventId)) !== null, '다시 만든 세대 키', 20_000, 50);
    const doneAt = Date.now();

    expect(await epochHash(w.eventId)).toMatchObject({ node: STANDALONE, gen: '2' });
    expect((await rebuildRow(w.eventId))?.gen).toBe(2);
    expect(await inCtlEvents(w.eventId)).toBe(true);
    // 판매 좌석: 묶음, 판매 계정, 그 주문의 holdId·psid(K3)
    expect(await bit(w.eventId, soldSeat.index)).toBe(1);
    expect(await holdHash(w.eventId, soldSeat.index)).toMatchObject({ holdId: sold.holdId, owner: sold.accountId, psid: sold.psid, pin: '1' });
    // 묶인 주문 좌석: 묶음이 아닌 살아 있는 홀드, 원장의 토큰, 만료 = 다시 만든 때 + 7분, 만료 인덱스에 있음(K1)
    expect(await bit(w.eventId, pinnedSeat.index)).toBe(1);
    const h = await holdHash(w.eventId, pinnedSeat.index);
    expect(h).toMatchObject({ holdId: pinned.holdId, owner: pinned.accountId, psid: pinned.psid, kind: 'FAN', fence: String(pinned.token) });
    expect(h!.pin === '1').toBe(false);
    expect(Number(h!.exp)).toBeGreaterThanOrEqual(lostAt + HOLD_TTL_MS);
    expect(Number(h!.exp)).toBeLessThanOrEqual(doneAt + HOLD_TTL_MS);
    expect(await expiryScore(w.eventId, pinnedSeat.index)).toBe(Number(h!.exp));
    // 빈 좌석
    expect(await bit(w.eventId, emptySeat.index)).toBe(0);
    expect(await holdHash(w.eventId, emptySeat.index)).toBeNull();
    expect([await quota(w.eventId, sold.accountId), await quota(w.eventId, pinned.accountId)]).toEqual([1, 1]);

    // 다시 만든 뒤에는 세대 키가 있어 다시 하지 않는다(gen 2 그대로)
    const after = sharedCatalog.calls;
    await until(() => sharedCatalog.calls >= after + 3, '다시 만들기 반복 세 틱 더', 10_000, 20);
    expect((await rebuildRow(w.eventId))?.gen).toBe(2);
  }, 60_000);

  test('ST26_리뷰 고침 M3_판매를 연 기록(seat_rebuild 행)이 없는 회차는 좌석 Redis 키를 모두 지워도 다시 만들지 않는다: 여러 틱 뒤에도 세대 키가 없고(판매 열기 전의 NOT_READY 막음 그대로) seat_rebuild 행도 생기지 않으며 회차 목록에도 넣지 않는다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = await saleWorld({ opened: false });
    const marked = await saleWorld();
    sharedCatalog.events.push(saleEventOf(w), saleEventOf(marked));
    await sharedRelay();
    expect(await rebuildRow(w.eventId)).toBeUndefined();

    await loseAll(w.eventId);
    await loseAll(marked.eventId);
    // 같은 틱에 본 기록 있는 회차는 다시 만든다(반복이 그 틱에 일했다는 증거)
    await until(async () => (await epochHash(marked.eventId)) !== null, '기록 있는 회차의 다시 만든 세대 키', 20_000, 50);
    const before = sharedCatalog.calls;
    await until(() => sharedCatalog.calls >= before + 5, '다시 만들기 반복 다섯 틱', 10_000, 20);

    expect(await epochHash(w.eventId)).toBeNull();
    expect(await rebuildRow(w.eventId)).toBeUndefined();
    expect(await inCtlEvents(w.eventId)).toBe(false);
    expect((await rebuildRow(marked.eventId))?.gen).toBe(2);
  }, 60_000);

  test('ST26_세대 올리기 감시가 리더에서 돌아, 세대 키 node를 옛 주 노드 표지로 바꿔 둔(승격 흉내) 판매 회차를 몇 틱 안에 BUMPED로 올린다(epoch ≥ 이전 + 1, node = standalone, gen 그대로). 그 뒤로 다시 오르지 않고, 표지가 같은 회차(판매 열기·다시 만든 회차)는 오르지 않아 seat_epoch_bumps_total은 1이다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-15.4.1] [ASVS v5.0.0-15.4.2]', async () => {
    const w = await saleWorld();
    const other = await saleWorld();
    const relay = await sharedRelay();
    const e0 = Number((await epochHash(w.eventId))!.epoch);
    const otherBefore = await epochHash(other.eventId);
    expect(otherBefore).toMatchObject({ node: STANDALONE, gen: '1' });

    await pretendFailover(w.eventId);
    await until(async () => (await epochHash(w.eventId))?.node === STANDALONE, '감시가 올린 세대(node = standalone)', 10_000, 25);
    const bumped = (await epochHash(w.eventId))!;
    expect(Number(bumped.epoch)).toBeGreaterThanOrEqual(e0 + 1);
    expect(bumped.gen).toBe('1');
    // 올린 누적 수(리뷰 고침 중간 1)
    expect(bumped.bumps).toBe('1');
    expect(await expireAtOf(seatKeys.epoch(w.eventId))).toBe(w.keepUntilMs);

    // 다시 만들기 반복 세 틱(0.6초, 감시는 그사이 여러 틱) 뒤에도 다시 오르지 않고, 표지가 같은 회차는 그대로다.
    // chk(표지를 견준 초)는 그사이 초가 바뀌면 감시가 그 초로 고쳐 쓰므로 견주지 않는다(ADR-0210 결정 2)
    const noChk = (h: Record<string, string> | null) => {
      const { chk: _chk, ...rest } = h ?? {};
      return rest;
    };
    const before = sharedCatalog.calls;
    await until(() => sharedCatalog.calls >= before + 3, '다시 만들기 반복 세 틱', 10_000, 20);
    expect(noChk(await epochHash(w.eventId))).toEqual(noChk(bumped));
    expect(noChk(await epochHash(other.eventId))).toEqual(noChk(otherBefore));
    // 이 프로세스가 본 회차 가운데 표지를 바꾼 회차는 이것뿐이다(앞 시험이 다시 만든 회차도 표지가 standalone이라 오르지 않는다)
    expect(counterOf(await relay.registry.metrics(), 'seat_epoch_bumps_total')).toBe(1);
  }, 60_000);

  test('PT41_ADR0107_리뷰 고침 M4: 주문 만료 안전망 반복이 리더에서 돈다: 만든 지 2시간 된 버려진 주문을 까닭 sweep으로 EXPIRED로 끝내고 이력·Outbox EXPIRED를 쓴다(서비스 역할 DB·좌석 Redis·좌석맵 판 배선) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-16.5.2]', async () => {
    const w = await saleWorld();
    const o = await putAbandonedOrder(w, w.refs[3]!);
    const relay = await sharedRelay();

    await until(async () => (await q<{ status: string }>('select status from purchase_order where id = $1', [o.orderId]))[0]?.status === 'EXPIRED', '안전망이 끝낸 주문', 15_000, 50);

    const history = await q<{ seq: number; to_status: string; cause: string; actor: string }>('select seq, to_status, cause, actor from order_event where order_id = $1 order by seq desc limit 1', [o.orderId]);
    expect(history).toEqual([{ seq: 2, to_status: 'EXPIRED', cause: 'T5', actor: 'system:order-expiry' }]);
    expect(samples(await relay.registry.metrics(), 'purchase_order_expired_total').find((l) => l.includes('trigger="sweep"'))).toMatch(/ [1-9]\d*$/);
  }, 60_000);

  test('FND110_관리 포트 /metrics에 좌석 Stream 릴레이(seat_stream_relay_sent_total{topic="trade.seats"})·다시 만들기(seat_rebuild_total{result="rebuilt"})·세대 올리기 감시(seat_epoch_bumps_total, PRF-168)·주문 만료(purchase_order_expired_total·purchase_order_open_stale, PRF-172)·Outbox 릴레이·정비 지표(retire-seat-events 마지막 성공, 주문 이력 검사)가 보인다', async () => {
    const relay = await sharedRelay();
    const { managementPort } = await relay.listen('127.0.0.1');
    expect(managementPort).toBeGreaterThan(0);
    const scrape = async () => {
      const res = await fetch(`http://127.0.0.1:${managementPort}/metrics`);
      expect(res.status).toBe(200);
      return res.text();
    };
    // 정비 실행기는 리더가 된 뒤 첫 깨어남에 '매일' 일을 한다
    let text = '';
    await until(
      async () => {
        text = await scrape();
        return samples(text, 'maintenance_task_last_success_timestamp_seconds').some((l) => l.includes('task="retire-seat-events"'));
      },
      '정비 일 retire-seat-events의 마지막 성공 표본',
      15_000,
      100,
    );
    // 앞 시험이 보낸 HELD 하나·다시 만든 회차 하나·올린 세대 하나·보낸 Outbox 행 하나
    expect(samples(text, 'seat_stream_relay_sent_total').find((l) => l.includes('topic="trade.seats"'))).toMatch(/ [1-9]\d*$/);
    expect(samples(text, 'seat_rebuild_total').find((l) => l.includes('result="rebuilt"'))).toMatch(/ [1-9]\d*$/);
    expect(text).toMatch(/^# TYPE seat_epoch_bumps_total counter$/m);
    expect(counterOf(text, 'seat_epoch_bumps_total')).toBeGreaterThanOrEqual(1);
    expect(samples(text, 'outbox_relay_published_total').find((l) => l.includes('service="purchase-svc"'))).toMatch(/ [1-9]\d*$/);
    expect(samples(text, 'outbox_relay_is_leader').find((l) => l.includes('service="purchase-svc"'))).toMatch(/ 1$/);
    // 주문 이력 검사(정비 시간 창 일)의 지표는 돌기 전에도 레지스트리에 붙어 있다
    expect(text).toMatch(/^# TYPE order_history_mismatch gauge$/m);
    // 주문 만료(PRF-172): 앞 시험의 안전망이 끝낸 주문 하나가 보이고, 게이지는 정비 일이 돌기 전 0이다
    expect(samples(text, 'purchase_order_expired_total').find((l) => l.includes('trigger="sweep"'))).toMatch(/ [1-9]\d*$/);
    expect(samples(text, 'purchase_order_open_stale')).toEqual(['purchase_order_open_stale 0']);
    // 지표 이름표에 회차 ID를 달지 않는다
    for (const e of sharedCatalog.events) expect(text).not.toContain(e.eventId);
  }, 60_000);
});

// ───────────────────────────── 두 프로세스 다툼 ─────────────────────────────

describe('두 프로세스가 같은 Lease를 다툰다(리더 넘김)', () => {
  beforeAll(async () => {
    // 앞 describe의 프로세스를 멈춘다(같은 s:ctl:events·Outbox 표를 함께 보므로)
    const p = await shared?.catch(() => undefined);
    await p?.stop();
  });

  test('FND110_리더가 아닌 쪽은 다시 만들기 반복·세대 올리기 감시·좌석 Stream 릴레이·Outbox 릴레이를 돌지 않고(회차 목록·보내기를 부르지 않고 보낸 수·올린 수 지표가 없다), 리더를 멈추면 다른 쪽이 이어받아 다시 만들기(node = 노드 표지 standalone)·좌석 Stream 릴레이·Outbox 릴레이를 하며 멈춘 쪽은 더 일하지 않는다 [ASVS v5.0.0-15.4.1] [ASVS v5.0.0-16.5.2]', async () => {
    const w = await saleWorld();
    const beforeEvent = uuidv7(systemClock);
    const afterEvent = uuidv7(systemClock);
    await openSale(store, beforeEvent);
    await openSale(store, afterEvent);
    const lease = memoryLeaseApi();
    const side = (pod: string) => ({ pod, catalog: catalogOf([saleEventOf(w)]), trade: countingTrade(), outbox: countingOutbox(), logs: logSink() });
    const a = side('relay-it-a');
    const b = side('relay-it-b');
    const pa = await startRelay({ pod: a.pod, lease, catalog: a.catalog, trade: a.trade, outbox: a.outbox, logs: a.logs.stream });
    const pb = await startRelay({ pod: b.pod, lease, catalog: b.catalog, trade: b.trade, outbox: b.outbox, logs: b.logs.stream });
    await until(() => pa.isLeader() || pb.isLeader(), '둘 가운데 하나가 리더', 10_000, 25);
    const aLeads = pa.isLeader();
    const [leader, follower] = aLeads ? ([pa, pb] as const) : ([pb, pa] as const);
    const [L, F] = aLeads ? ([a, b] as const) : ([b, a] as const);

    // 리더가 일하는 동안: HELD 하나와 Outbox 행 하나가 나가고, 다시 만들기 반복이 여러 틱 돈다
    await holdSeats(store, beforeEvent, seatRefs(1));
    await reader.waitFor(on(SEAT_TOPIC, beforeEvent), 1, 30_000);
    await until(async () => (await xlen(redis, beforeEvent)) === 0, '리더가 보낸 항목을 확인해 지움', 10_000);
    const k1 = `relay-it-${randomUUID()}`;
    await putOutbox(k1, '{"n":"before"}');
    await reader.waitFor(on(TRADE_ORDERS, k1), 1, 30_000);
    await until(() => L.catalog.calls >= 5, '리더의 다시 만들기 반복 다섯 틱', 10_000, 20);
    expect(follower.isLeader()).toBe(false);
    expect(F.catalog.calls).toBe(0);
    expect(F.trade.calls).toBe(0);
    expect(F.outbox.calls).toBe(0);
    expect(L.trade.calls).toBeGreaterThan(0);
    expect(L.outbox.calls).toBeGreaterThan(0);
    const followerText = await follower.registry.metrics();
    expect(samples(followerText, 'seat_stream_relay_sent_total')).toEqual([]);
    expect(samples(followerText, 'seat_rebuild_total')).toEqual([]);
    expect(samples(followerText, 'outbox_relay_is_leader').find((l) => l.includes('service="purchase-svc"'))).toMatch(/ 0$/);
    expect(samples(await leader.registry.metrics(), 'seat_stream_relay_sent_total').find((l) => l.includes('topic="trade.seats"'))).toMatch(/ [1-9]\d*$/);

    // 세대 올리기 감시도 리더에서만 돈다(PRF-168): 승격 흉내 회차를 리더가 올리고, 대기 쪽의 올린 수는 0이다
    await pretendFailover(w.eventId);
    await until(async () => (await epochHash(w.eventId))?.node === STANDALONE, '리더의 감시가 올린 세대', 10_000, 25);
    expect(counterOf(await leader.registry.metrics(), 'seat_epoch_bumps_total')).toBe(1);
    expect(counterOf(await follower.registry.metrics(), 'seat_epoch_bumps_total')).toBe(0);

    // 리더를 멈춘다: 반복을 멈춘 뒤 Lease를 놓아 다른 쪽이 Lease 기간을 기다리지 않고 잡는다
    await leader.stop();
    const stopped = { catalog: L.catalog.calls, trade: L.trade.calls, outbox: L.outbox.calls };
    await until(() => follower.isLeader(), '대기 프로세스가 Lease를 이어받음', 10_000, 25);

    // 이어받은 쪽이 다시 만든다(세대 키 node = 노드 표지, 파드 이름이 아니다)
    await loseAll(w.eventId);
    await until(async () => (await epochHash(w.eventId)) !== null, '이어받은 쪽이 다시 만든 세대 키', 20_000, 50);
    expect(await epochHash(w.eventId)).toMatchObject({ node: STANDALONE, gen: '2' });
    expect(F.catalog.calls).toBeGreaterThan(0);

    // 이어받은 쪽이 좌석 Stream 릴레이·Outbox 릴레이를 한다
    const h2 = await holdSeats(store, afterEvent, seatRefs(1));
    const [r2] = await reader.waitFor(on(SEAT_TOPIC, afterEvent), 1, 30_000);
    expect(valueOf(r2!)).toMatchObject({ eventId: afterEvent, type: 'HELD', holdId: h2.holdId, fencingToken: h2.fencingToken });
    const k2 = `relay-it-${randomUUID()}`;
    await putOutbox(k2, '{"n":"after"}');
    await reader.waitFor(on(TRADE_ORDERS, k2), 1, 30_000);
    expect(F.trade.calls).toBeGreaterThan(0);
    expect(F.outbox.calls).toBeGreaterThan(0);

    // 멈춘 쪽은 그 뒤 아무것도 하지 않았다
    expect({ catalog: L.catalog.calls, trade: L.trade.calls, outbox: L.outbox.calls }).toEqual(stopped);
    // 같은 레코드가 두 쪽에서 두 번 나가지 않았다(넘김 전후 각 하나)
    expect(reader.records.filter(on(SEAT_TOPIC, beforeEvent))).toHaveLength(1);
    expect(reader.records.filter(on(TRADE_ORDERS, k1))).toHaveLength(1);
  }, 120_000);
});
