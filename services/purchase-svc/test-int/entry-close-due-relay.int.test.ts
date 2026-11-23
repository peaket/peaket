// F-05-6 환급 잇기 시작 파일 조립 통합 시험(BUILD_ORDER GAT-180, O-T29 ③, 시험 리뷰 RV-03).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 '환급 잇기'(1분마다), §7.4 운영 확인(purchase_entry_close_due_total{result}),
// 계획 docs/review/plans/F-05-6.md §4 'purchase 시작 파일 조립'(릴레이 리더일 때만 EntryCloseDueTick을 등록, 시작 옵션 entryCloseDueEveryMs로 시험이 주기를 줄인다,
// 지표는 관리 포트 /metrics의 계수기, 리더가 아닌 복제본은 돌지 않는다).
// 조립: purchase 릴레이 프로세스(startPurchaseRelay)를 두 번 띄운다(같은 메모리 Lease, 파드 둘). DB는 실제 PostgreSQL 18, 좌석 Redis는 실제 Valkey 8.1,
// core-svc 판매 설정은 내부 경로 모양 HTTP 대역이다. Kafka 보내기 둘(Outbox·거래 토픽)은 포트를 satisfies로 묶은 기록 대역이다(이 시험이 보는 것은 보내기가 아니다).
// 시계는 실제 시계다. 판정은 바깥에서 본다: order_cancellation.refund_due_at, 리더 관리 포트 /metrics, 대기 프로세스의 레지스트리, core 대역이 받은 요청.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, type HotRedis, memoryLeaseApi, type OutboxPublisher, type OutboxRelayProcess, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { MemorySeatMap, type SaleEventCatalog, type TradeEventPublisher } from '../src/modules/inventory/index.js';
import { startPurchaseRelay, type PurchaseRelayOptions } from '../src/relay-app.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const PRICE = 30_000;
const TOKEN = 'f056-relay-internal-token';
const LEASE = { leaseDurationMs: 2_000, renewDeadlineMs: 1_500, retryPeriodMs: 100 } as const;
const POLL = { timeout: 20_000, interval: 100 };

let pgc: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let admin: Database;
let relayDb: Database;
let maintenanceDb: Database;
let serviceDb: Database;
let redis: HotRedis;
const started: OutboxRelayProcess[] = [];

// ---- core-svc 자리: 판매 설정 내부 경로 대역 ----
const core = { closed: new Map<string, number | null>(), asked: [] as { eventId: string; token: string | undefined }[], server: undefined as Server | undefined, url: '' };

async function startCoreStandIn(): Promise<void> {
  const server = createServer((req, res) => {
    const m = /^\/internal\/v1\/events\/([0-9a-f-]{36})\/sale-config$/.exec(req.url ?? '');
    if (!m || req.method !== 'GET') return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    const eventId = m[1]!;
    const token = req.headers['x-peaket-internal-token'];
    core.asked.push({ eventId, token: typeof token === 'string' ? token : undefined });
    if (!core.closed.has(eventId)) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(saleConfigBody(eventId, core.closed.get(eventId) ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  core.server = server;
  core.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * 진짜 core 판매 설정 응답과 같은 칸(core EventSaleConfig, internal-sale-config 경로, entry-close-due.int.test.ts의 coreBody와 같은 모양).
 * 엄격하게 읽는 구현이 모양 틀림으로 보지 않게 칸을 모두 싣는다(시험 리뷰 RV-18)
 */
function saleConfigBody(eventId: string, entryClosedAtMs: number | null): string {
  const startsAtMs = Date.now() - 5 * 3_600_000;
  return JSON.stringify({
    eventId,
    productionId: randomUUID(),
    promoterId: randomUUID(),
    rev: 4,
    opensAtMs: startsAtMs - 30 * 86_400_000,
    startsAtMs,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    perPersonLimit: 4,
    saleEndsAtMs: startsAtMs - 86_400_000,
    reentryAllowed: false,
    entryOpensAtMs: startsAtMs - 3_600_000,
    endsAtMs: startsAtMs + 2 * 3_600_000 + 13 * 60_000 + 7_411,
    entryClosedAtMs,
    layoutVersion: 3,
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  });
}

/** 주문(CONFIRMED, 항목 하나)과 그 첫 이력을 한 트랜잭션에 쓴다(지연 제약 order_status_has_event) */
async function orderOf(eventId: string, ticketId: string, createdAtMs: number): Promise<string> {
  const orderId = randomUUID();
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', $6, $7, 'ps-f056-relay')`,
      [orderId, randomUUID(), eventId, PRICE, randomUUID(), new Date(createdAtMs - 86_400_000), randomUUID()],
    );
    await client.query(`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)`, [orderId, new Date(createdAtMs - 86_400_000)]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await admin.pool.query(`insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'R', 'A', $3, $4)`, [orderId, randomUUID(), PRICE, ticketId]);
  return orderId;
}

/** 마감을 기다리는 보류 취소(REQUESTED, refund_due_at = 상한) 한 행 */
async function waitingCancellation(eventId: string, refundDueAtMs: number): Promise<string> {
  const cancellationId = randomUUID();
  const ticketId = randomUUID();
  const createdAtMs = Date.now() - 3_600_000;
  const orderId = await orderOf(eventId, ticketId, createdAtMs);
  await admin.pool.query(
    `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at, refund_due_at)
     values ($1, $2, $3, 'USER', 0, false, 0, 0, $4, 'REQUESTED', $5, $5, $6)`,
    [cancellationId, orderId, ticketId, PRICE, new Date(createdAtMs), new Date(refundDueAtMs)],
  );
  return cancellationId;
}

const dueOf = async (cancellationId: string): Promise<number | null> => {
  const r = await admin.pool.query<{ refund_due_at: Date | null }>('select refund_due_at from order_cancellation where id = $1', [cancellationId]);
  return r.rows[0]?.refund_due_at ? r.rows[0].refund_due_at.getTime() : null;
};

/** 지표 글에서 이름과 이름표 조각이 모두 맞는 줄의 합(없으면 0) */
function metricOf(text: string, name: string, labels: string[]): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (!labels.every((l) => line.includes(l))) continue;
    sum += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return sum;
}

class RefreshingSeatMap extends MemorySeatMap {
  async refresh(): Promise<void> {}
}

async function startRelay(pod: string, lease: ReturnType<typeof memoryLeaseApi>): Promise<OutboxRelayProcess> {
  const outbox = { publish: async () => undefined } satisfies OutboxPublisher;
  const trade = { publish: async () => undefined } satisfies TradeEventPublisher;
  const catalog = { list: async () => [] } satisfies SaleEventCatalog;
  const options: PurchaseRelayOptions & { entryCloseDueEveryMs: number } = {
    env: {
      PEAKET_ENV: 'local',
      PEAKET_POD: pod,
      PEAKET_MANAGEMENT_PORT: '0',
      PEAKET_OUTBOX_DATABASE_URL: pgc!.url,
      PEAKET_MAINTENANCE_DATABASE_URL: pgc!.url,
      // 보내기는 대역이라 브로커에 닿지 않는다(설정 검사용 주소)
      PEAKET_KAFKA_BROKERS: '127.0.0.1:9',
      PEAKET_CORE_HTTP_URL: core.url,
      PEAKET_INTERNAL_TOKEN: TOKEN,
    },
    clock: systemClock,
    database: relayDb,
    maintenanceDatabase: maintenanceDb,
    serviceDatabase: serviceDb,
    redis,
    seatMap: new RefreshingSeatMap(),
    catalog,
    outboxPublisher: outbox,
    tradePublisher: trade,
    leaseApi: lease,
    lease: LEASE,
    holder: pod,
    seatMapRefreshMs: 60_000,
    stopTimeoutMs: 3_000,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
    entryCloseDueEveryMs: 200,
  };
  const p = await startPurchaseRelay(options);
  started.push(p);
  return p;
}

beforeAll(async () => {
  [pgc, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migratePurchase(pgc.url);
  await ensureSeatHoldPartitions(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f056-relay-admin' });
  relayDb = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'f056-relay-relay' });
  maintenanceDb = createDatabase({ url: pgc.url, profile: 'general', max: 2, applicationName: 'f056-relay-maintenance' });
  serviceDb = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f056-relay-service' });
  await ensureOutboxPartitions(admin, systemClock);
  redis = await createHotRedis({ url: valkey.url });
  await startCoreStandIn();
}, 240_000);

afterAll(async () => {
  for (const p of started.splice(0)) await p.stop().catch(() => {});
  await new Promise<void>((resolve) => (core.server ? core.server.close(() => resolve()) : resolve()));
  await redis?.close().catch(() => {});
  await Promise.allSettled([relayDb?.close(), maintenanceDb?.close(), serviceDb?.close(), admin?.close()]);
  valkey?.stop();
  pgc?.stop();
});

describe('purchase 릴레이 시작 파일의 환급 잇기(O-T29 ③, 시험 리뷰 RV-03)', () => {
  test('O-T29 ③ 릴레이 리더가 시작 파일이 등록한 배경 작업으로 마감된 회차의 보류 취소 refund_due_at을 마감 시각으로 당기고, 관리 포트 /metrics의 purchase_entry_close_due_total{result="moved"}가 1이며, 대기 복제본은 돌지 않는다', async () => {
    const lease = memoryLeaseApi();
    const a = await startRelay('relay-f056-a', lease);
    const b = await startRelay('relay-f056-b', lease);
    await expect.poll(() => a.isLeader() || b.isLeader(), POLL).toBe(true);
    const [leader, follower] = a.isLeader() ? [a, b] : [b, a];
    const eventId = randomUUID();
    const closedAt = Date.now() - 60_000;
    core.closed.set(eventId, closedAt);
    const cap = Date.now() + 50 * 3_600_000;
    const cancellationId = await waitingCancellation(eventId, cap);
    await expect.poll(() => dueOf(cancellationId), POLL).toBe(closedAt);
    expect(core.asked.filter((x) => x.eventId === eventId).every((x) => x.token === TOKEN)).toBe(true);
    const { managementPort } = await leader.listen('127.0.0.1');
    const text = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
    expect(metricOf(text, 'purchase_entry_close_due_total', ['result="moved"'])).toBe(1);
    expect(follower.isLeader()).toBe(false);
    expect(metricOf(await follower.registry.metrics(), 'purchase_entry_close_due_total', [])).toBe(0);
  }, 60_000);
});
