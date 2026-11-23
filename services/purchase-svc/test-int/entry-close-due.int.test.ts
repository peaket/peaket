// F-05-6 환급 잇기 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-180, O-T29 ③).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 '환급 잇기'(마감을 기다리는 보류 취소의 refund_due_at을 core-svc 판매 설정의 entryClosedAtMs로
// 조건부로 당기고, 환급 자체는 지금의 환급 실행기가 한다. core-svc를 읽지 못하면 아무것도 바꾸지 않는다), §7.4(purchase_entry_close_due_total{result}),
// docs/features/transfer-refund.md §3.1 ①~⑥(입장 기록이 없으면 환급, 있으면 결제사를 부르지 않고 CS '이상 표시'), docs/data.md order_cancellation,
// 계획 docs/review/plans/F-05-6.md §4(DrizzleCancellationWrites의 waitingEvents·pullDue, HttpCoreEntryCloseTimes가 core sale-config를 직접 읽음).
// 조립: purchase DB만 실제 PostgreSQL 18(마이그레이션 그대로). core-svc 자리는 실제 HTTP 대역(GET /internal/v1/events/{id}/sale-config, 답을 시험이 고른다),
// ops-svc CS 처리함은 기존 대역(ops-cs-double.ts, 실제 HTTP), 결제사 취소·ticket-svc 입장 기록 대조는 포트를 satisfies로 묶은 기록 대역이다.
// 판정은 바깥에서 본다: order_cancellation 행(상태·refund_due_at·entry_recorded_at), 결제 대역 호출, ops 대역이 받은 본문.
// 파일이 DB를 나눠 쓰므로 하네스를 만들 때마다 앞 시험의 진행 중 취소 행을 VOIDED로 닫는다(기다리는 회차 목록이 이 시험의 행만 보이게).
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createDatabase, createExternalHttpClient, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DrizzleOrderStore } from '../src/modules/booking/index.js';
import { DrizzleCancellationWrites, HttpEntryFlagNotice, RefundAfterEntry, type EntryRecords, type PaymentCancellations } from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { CAP, CLOSED_AT, entryCloseDueStoreContract, NOW, STARTS_AT, type DueRowSeed } from '../test/entry-close-due-store-contract.js';
import { startOpsCsDouble } from './ops-cs-double.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const load = async () => {
  const [tick, times] = await Promise.all([import('../src/modules/refund/application/entry-close-due.js'), import('../src/modules/refund/adapters/http-core-entry-close-times.js')]);
  return { ...tick, ...times };
};

const PRICE = 30_000;
let pgc: PostgresContainer | undefined;
let admin: Database;
let purchaseDb: Database;
let writes: DrizzleCancellationWrites;
const clock = fakeClock({ now: NOW });

// ---- core-svc 자리: 판매 설정 내부 경로 대역 ----
type CoreAnswer = { status: number; entryClosedAtMs?: number | null; raw?: string };
const core = { answers: new Map<string, CoreAnswer>(), asked: [] as { eventId: string; token: string | undefined }[], server: undefined as Server | undefined, url: '' };
const TOKEN = 'f056-purchase-internal-token';

function coreBody(eventId: string, entryClosedAtMs: number | null | undefined): string {
  return JSON.stringify({
    eventId,
    productionId: randomUUID(),
    promoterId: randomUUID(),
    rev: 4,
    opensAtMs: STARTS_AT - 30 * 86_400_000,
    startsAtMs: STARTS_AT,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: true,
    perPersonLimit: 4,
    saleEndsAtMs: STARTS_AT - 86_400_000,
    reentryAllowed: false,
    entryOpensAtMs: STARTS_AT - 3_600_000,
    endsAtMs: STARTS_AT + 2 * 3_600_000 + 13 * 60_000 + 7_411,
    ...(entryClosedAtMs !== undefined ? { entryClosedAtMs } : {}),
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  });
}

async function startCoreStandIn(): Promise<void> {
  const server = createServer((req, res) => {
    const m = /^\/internal\/v1\/events\/([0-9a-f-]{36})\/sale-config$/.exec(req.url ?? '');
    const token = req.headers['x-peaket-internal-token'];
    if (!m || req.method !== 'GET') return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    const eventId = m[1]!;
    core.asked.push({ eventId, token: typeof token === 'string' ? token : undefined });
    const a = core.answers.get(eventId) ?? { status: 404 };
    if (a.status !== 200) return void res.writeHead(a.status, { 'content-type': 'application/json' }).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(a.raw ?? coreBody(eventId, a.entryClosedAtMs));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  core.server = server;
  core.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const coreClient = () => createExternalHttpClient({ provider: 'core-svc', baseUrl: core.url, timeoutCapMs: 2_000 });

/** 주문(CONFIRMED, 항목 하나)과 그 첫 이력을 한 트랜잭션에 쓴다(지연 제약 order_status_has_event) */
async function orderOf(eventId: string, ticketId: string, createdAtMs: number): Promise<string> {
  const orderId = randomUUID();
  const client = await admin.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', $6, $7, 'ps-f056')`,
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

/** 취소 행 하나를 칸 값 그대로 넣는다(주문은 행마다 새로). 티켓 ID를 돌려준다 */
async function putRow(r: DueRowSeed): Promise<{ orderId: string; ticketId: string }> {
  const ticketId = randomUUID();
  const orderId = await orderOf(r.eventId, ticketId, r.createdAtMs);
  await admin.pool.query(
    `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at,
                                     refund_due_at, entry_recorded_at, event_cancellation_request_id)
     values ($1, $2, $3, $4, 0, false, 0, 0, $5, $6, $7, $7, $8, $9, $10)`,
    [
      r.cancellationId,
      orderId,
      ticketId,
      r.eventCancellationRequestId ? 'EVENT_CANCELLED' : 'USER',
      PRICE,
      r.status,
      new Date(r.createdAtMs),
      r.refundDueAtMs === null ? null : new Date(r.refundDueAtMs),
      r.entryRecordedAtMs === undefined ? null : new Date(r.entryRecordedAtMs),
      r.eventCancellationRequestId ?? null,
    ],
  );
  return { orderId, ticketId };
}

async function rowOf(cancellationId: string): Promise<{ refundDueAtMs: number | null; status: string; entryRecordedAtMs: number | null }> {
  const r = await admin.pool.query<{ refund_due_at: Date | null; status: string; entry_recorded_at: Date | null }>('select refund_due_at, status, entry_recorded_at from order_cancellation where id = $1', [cancellationId]);
  expect(r.rows, cancellationId).toHaveLength(1);
  const x = r.rows[0]!;
  return { refundDueAtMs: x.refund_due_at ? x.refund_due_at.getTime() : null, status: x.status, entryRecordedAtMs: x.entry_recorded_at ? x.entry_recorded_at.getTime() : null };
}

/** 앞 시험이 남긴 진행 중 취소를 닫는다(기다리는 회차 목록을 이 시험의 행으로 좁힌다) */
const reset = async () => void (await admin.pool.query(`update order_cancellation set status = 'VOIDED' where status <> 'VOIDED'`));

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePurchase(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f056-entry-close-due-admin' });
  purchaseDb = createDatabase({ url: pgc.url, profile: 'general', max: 6, applicationName: 'f056-entry-close-due' });
  await ensureOutboxPartitions(admin, clock);
  writes = new DrizzleCancellationWrites(purchaseDb, new DrizzleOrderStore({ clock }));
  await startCoreStandIn();
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (core.server ? core.server.close(() => resolve()) : resolve()));
  await purchaseDb?.close().catch(() => {});
  await admin?.close().catch(() => {});
  pgc?.stop();
});

entryCloseDueStoreContract('실제 PostgreSQL DrizzleCancellationWrites', async () => {
  await reset();
  return {
    store: writes,
    seed: async (rows) => {
      for (const r of rows) await putRow(r);
    },
    rowOf: async (id) => {
      const r = await rowOf(id);
      return { refundDueAtMs: r.refundDueAtMs, status: r.status };
    },
  };
});

describe('core 판매 설정 읽기 HttpCoreEntryCloseTimes(실제 HTTP 대역, O-T29 ③)', () => {
  test('O-T29 ③ 200의 entryClosedAtMs 값·null을 그대로 주고, 내부 토큰을 싣는다', async () => {
    const { HttpCoreEntryCloseTimes } = await load();
    const closed = randomUUID();
    const open = randomUUID();
    core.answers.set(closed, { status: 200, entryClosedAtMs: CLOSED_AT });
    core.answers.set(open, { status: 200, entryClosedAtMs: null });
    const times = new HttpCoreEntryCloseTimes({ client: coreClient(), internalToken: TOKEN });
    const before = core.asked.length;
    expect(await times.closedAtMs(closed)).toBe(CLOSED_AT);
    expect(await times.closedAtMs(open)).toBeNull();
    expect(core.asked.slice(before)).toEqual([
      { eventId: closed, token: TOKEN },
      { eventId: open, token: TOKEN },
    ]);
  });

  test('O-T29 ③ 404·503·모양이 틀린 본문은 모름(undefined)이고 던지지 않는다', async () => {
    const { HttpCoreEntryCloseTimes } = await load();
    const missing = randomUUID();
    const down = randomUUID();
    const broken = randomUUID();
    const badValue = randomUUID();
    core.answers.set(missing, { status: 404 });
    core.answers.set(down, { status: 503 });
    core.answers.set(broken, { status: 200, raw: '{"eventId":' });
    core.answers.set(badValue, { status: 200, raw: JSON.stringify({ eventId: badValue, entryClosedAtMs: '2026-12-24T14:00:00Z' }) });
    const times = new HttpCoreEntryCloseTimes({ client: coreClient(), internalToken: TOKEN });
    for (const id of [missing, down, broken, badValue]) await expect(times.closedAtMs(id), id).resolves.toBeUndefined();
  });
});

describe('환급 잇기 → 지금의 환급 실행기(실제 PostgreSQL, O-T29 ③)', () => {
  let ops: Awaited<ReturnType<typeof startOpsCsDouble>>;
  beforeAll(async () => {
    ops = await startOpsCsDouble();
  });
  afterAll(async () => {
    await ops?.close();
  });

  test('O-T29 ③ 마감 시각으로 당긴 뒤 환급 실행기 한 틱: 입장 기록 없는 행은 REFUNDED·결제 한 번, 기록 있는 행은 결제 0·CS 이상 표시, 마감 없는 회차 행은 그대로', async () => {
    const { EntryCloseDueTick, HttpCoreEntryCloseTimes } = await load();
    await reset();
    const closedEvent = randomUUID();
    const openEvent = randomUUID();
    core.answers.set(closedEvent, { status: 200, entryClosedAtMs: CLOSED_AT });
    core.answers.set(openEvent, { status: 200, entryClosedAtMs: null });
    const noEntry: DueRowSeed = { cancellationId: randomUUID(), eventId: closedEvent, status: 'REQUESTED', refundDueAtMs: CAP, createdAtMs: STARTS_AT + 60_000 };
    const entered: DueRowSeed = { cancellationId: randomUUID(), eventId: closedEvent, status: 'REQUESTED', refundDueAtMs: CAP, createdAtMs: STARTS_AT + 120_000 };
    const waiting: DueRowSeed = { cancellationId: randomUUID(), eventId: openEvent, status: 'REQUESTED', refundDueAtMs: CAP, createdAtMs: STARTS_AT + 180_000 };
    await putRow(noEntry);
    const enteredRow = await putRow(entered);
    await putRow(waiting);
    const results: string[] = [];
    const tick = new EntryCloseDueTick({
      store: writes,
      closes: new HttpCoreEntryCloseTimes({ client: coreClient(), internalToken: TOKEN }),
      nowMs: () => NOW,
      metrics: { inc: (labels: { result: string }) => void results.push(labels.result) },
    });
    await expect(tick.run()).resolves.toEqual({ moved: 2 });
    expect(results.sort()).toEqual(['moved', 'not_closed']);
    expect((await rowOf(noEntry.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    expect((await rowOf(entered.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    expect((await rowOf(waiting.cancellationId)).refundDueAtMs).toBe(CAP);

    // 지금의 환급 실행기 한 틱(마감 뒤 1분 안, 상한 CAP 훨씬 전)
    const firstEnteredAtMs = STARTS_AT + 7 * 60_000;
    const payCalls: string[] = [];
    const payments = { cancel: async (q) => (payCalls.push(q.cancellationId), 'CANCELLED' as const) } satisfies Pick<PaymentCancellations, 'cancel'>;
    const entries = {
      lookup: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === enteredRow.ticketId ? { found: true, entered: true, firstEnteredAtMs } : { found: true, entered: false }])),
    } satisfies EntryRecords;
    const opsBefore = ops.state.requests.length;
    const runner = new RefundAfterEntry({
      writes,
      payments,
      entries,
      claims: writes,
      flags: new HttpEntryFlagNotice(createExternalHttpClient({ provider: 'ops-svc', baseUrl: ops.url, timeoutCapMs: 5_000 }), 'it-token'),
      log: { warn: () => undefined, error: () => undefined },
      nowMs: () => NOW + 1,
    });
    await expect(runner.run()).resolves.toMatchObject({ refunded: 1, entryRecorded: 1 });
    expect(payCalls).toEqual([noEntry.cancellationId]);
    expect(await rowOf(noEntry.cancellationId)).toMatchObject({ status: 'REFUNDED' });
    expect(await rowOf(entered.cancellationId)).toEqual({ status: 'REQUESTED', refundDueAtMs: null, entryRecordedAtMs: firstEnteredAtMs });
    expect(await rowOf(waiting.cancellationId)).toEqual({ status: 'REQUESTED', refundDueAtMs: CAP, entryRecordedAtMs: null });
    const flagged = ops.state.requests.slice(opsBefore).map((r) => r.body);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ kind: 'FLAGGED', category: 'ENTRY_AFTER_CANCEL', sourceId: entered.cancellationId });
  });

  test('O-T29 ③ core-svc가 503이면 아무 행도 바꾸지 않고(unavailable) 상한이 그대로 남아 환급 실행기도 부르지 않는다', async () => {
    const { EntryCloseDueTick, HttpCoreEntryCloseTimes } = await load();
    await reset();
    const eventId = randomUUID();
    core.answers.set(eventId, { status: 503 });
    const r: DueRowSeed = { cancellationId: randomUUID(), eventId, status: 'REQUESTED', refundDueAtMs: CAP, createdAtMs: STARTS_AT + 60_000 };
    await putRow(r);
    const results: string[] = [];
    const asked = core.asked.length;
    const tick = new EntryCloseDueTick({ store: writes, closes: new HttpCoreEntryCloseTimes({ client: coreClient(), internalToken: TOKEN }), nowMs: () => NOW, metrics: { inc: (labels: { result: string }) => void results.push(labels.result) } });
    await expect(tick.run()).resolves.toEqual({ moved: 0 });
    // 실제로 core에 물었고(장애가 실제로 났다) 결과는 unavailable이다
    expect(core.asked.slice(asked).map((a) => a.eventId)).toEqual([eventId]);
    expect(results).toEqual(['unavailable']);
    expect(await rowOf(r.cancellationId)).toEqual({ status: 'REQUESTED', refundDueAtMs: CAP, entryRecordedAtMs: null });
    const payCalls: string[] = [];
    await new RefundAfterEntry({
      writes,
      payments: { cancel: async (q) => (payCalls.push(q.cancellationId), 'CANCELLED' as const) } satisfies Pick<PaymentCancellations, 'cancel'>,
      entries: { lookup: async (ids: readonly string[]) => new Map(ids.map((id) => [id, { found: true, entered: false }])) } satisfies EntryRecords,
      claims: writes,
      nowMs: () => NOW + 1,
    }).run();
    expect(payCalls).toEqual([]);
    // 상한(공연 시작 + 50시간)에 닿으면 지금처럼 환급된다
    await new RefundAfterEntry({
      writes,
      payments: { cancel: async (q) => (payCalls.push(q.cancellationId), 'CANCELLED' as const) } satisfies Pick<PaymentCancellations, 'cancel'>,
      entries: { lookup: async (ids: readonly string[]) => new Map(ids.map((id) => [id, { found: true, entered: false }])) } satisfies EntryRecords,
      claims: writes,
      nowMs: () => CAP,
    }).run();
    expect(payCalls).toEqual([r.cancellationId]);
  });
});
