// purchase-svc 회차 취소 일괄 환불(BAT-425 GAT-120·GAT-130) 실제 PostgreSQL 18 통합 시험.
// 0016 마이그레이션 적용·재적용, event_cancellation_request·event_refund_item, 미리보기·시작·진행률·일시정지·재개,
// 결정적 취소 ID, 같은 요청·티켓 멱등, 부분 실패 CS 통지를 본다.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleEventCancellationLookup, DrizzleEventOpenOrders, DrizzleEventRefundAttempts, DrizzleEventRefundHolds, DrizzleEventRefundStore, DrizzleEventRefundTargets, EventRefundService, OutboxEventRefundFanNotifier } from '../src/modules/refund/index.js';
import { eventRefundCancellationId, type EventCancellationRequest, type EventRefundItem, type EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';
import type { EventRefundAlert, EventRefundAttemptStore, EventRefundCanceller, EventRefundFailureNotice, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const DAY = 86_400_000;

let container: PostgresContainer | undefined;
let url = '';
let db: Database;
let admin: pg.Client;

beforeAll(async () => {
  container = await startPostgres();
  url = container.url;
  await migratePurchase(url);
  db = createDatabase({ url, applicationName: 'purchase-event-refund-it' });
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => admin.query<R>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
/** 마이그레이션 기록(migrations/meta/_journal.json). 적용 건수와 마지막 적용을 이 기록과 견준다(새 마이그레이션마다 숫자를 고치지 않게) */
const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url)), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
const lastApplied = async (): Promise<number> => Number((await q<{ n: string }>('select max(created_at)::bigint as n from drizzle.__drizzle_migrations')).rows[0]!.n);

async function seedOrder(o: { eventId: string; accountId: string; amount: number; pg: 'TOSS' | 'PORTONE'; cancelled?: boolean }): Promise<{ orderId: string; ticketId: string }> {
  const orderId = randomUUID();
  const ticketId = randomUUID();
  await q('begin');
  try {
    await q(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', now(), $6, $7)`,
      [orderId, o.accountId, o.eventId, o.amount, `idem-${orderId}`, randomUUID(), randomUUID()],
    );
    // 주문 상태와 마지막 이력의 to_status가 같아야 한다는 지연 제약을 같은 트랜잭션에서 채운다.
    await q("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T8', 'system:test', now())", [orderId]);
    await q("insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'VIP', 'A', $3, $4)", [
      orderId,
      randomUUID(),
      o.amount,
      ticketId,
    ]);
    await q("insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $1, $2, 'ACCEPTED', now())", [orderId, o.pg]);
    if (o.cancelled) {
      await q(
        `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
         values ($1, $2, $3, 'USER', 0, false, 0, 0, 0, 'REFUND_PENDING', now(), now())`,
        [randomUUID(), orderId, ticketId],
      );
    }
    await q('commit');
  } catch (err) {
    await q('rollback').catch(() => undefined);
    throw err;
  }
  return { orderId, ticketId };
}

const configs = { config: async () => ({ saleEndsAtMs: NOW + 7 * DAY, entryOpensAtMs: NOW + 6 * DAY }) };
const fixture = (
  outcomeFor: (target: EventRefundTarget, index: number) => 'REFUNDED' | 'REFUND_PENDING' | 'FAILED' = () => 'REFUNDED',
  opts: { attempts?: EventRefundAttemptStore; alert?: EventRefundAlert } = {},
) => {
  const calls: Parameters<EventRefundCanceller['cancel']>[] = [];
  const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
  let index = 0;
  const canceller: EventRefundCanceller = {
    cancel: async (t, q) => {
      calls.push([t, q]);
      const status = outcomeFor(t, index++);
      return status === 'FAILED' ? { status: 'FAILED', error: 'REJECTED' } : { status };
    },
  };
  const service = new EventRefundService({
    store: new DrizzleEventRefundStore(db),
    targets: new DrizzleEventRefundTargets(db, configs),
    canceller,
    notice: { open: async (q) => void notices.push(q) },
    ...(opts.attempts ? { attempts: opts.attempts } : {}),
    ...(opts.alert ? { alert: opts.alert } : {}),
    nowMs: () => NOW,
    deadlineMs: () => NOW + 30_000,
    concurrency: 2,
  });
  return { service, calls, notices };
};

describe('0016 회차 취소 일괄 환불', () => {
  test('BAT425_0016은_재적용해도_같고_요청·항목_표와_제약을_만든다', async () => {
    const tables = async () =>
      (await q<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname")).rows.map((r) => r.relname);
    const before = await tables();
    expect(before).toEqual(expect.arrayContaining(['event_cancellation_request', 'event_refund_item']));
    await migratePurchase(url);
    await migratePurchase(url);
    expect(await tables()).toEqual(before);
    expect(await count('select count(*) as n from drizzle.__drizzle_migrations')).toBe(journal.entries.length);
    expect(await lastApplied()).toBe(journal.entries.at(-1)!.when);
    const idx = await q<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'event_refund_item' and indexname = 'event_refund_item_cancellation_key'");
    expect(idx.rows[0]?.indexdef).toContain('UNIQUE INDEX');
  });

  test('BAT425_저장소는_같은_요청을_다시_만들어도_한_행이다', async () => {
    const store = new DrizzleEventRefundStore(db);
    const requestId = randomUUID();
    const eventId = randomUUID();
    const seeded = await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'TOSS' });
    const ticketId = seeded.ticketId;
    const request = {
      requestId,
      eventId,
      kind: 'CANCEL',
      status: 'RUNNING',
      targetOrders: 1,
      refundTotal: 10_000,
      compensationTargets: 1,
      compensationTotal: 1_000,
      progress: { total: 1, done: 0, failed: 0, notApplied: 0, perPg: [] },
      ruledBy: 'commander-1',
      confirmedBy: 'operator-2',
      createdAtMs: NOW,
      updatedAtMs: NOW,
    } satisfies EventCancellationRequest;
    const item = {
      requestId,
      orderId: seeded.orderId,
      ticketId,
      cancellationId: eventRefundCancellationId(requestId, ticketId),
      pg: 'TOSS',
      status: 'PENDING',
      attempts: 0,
    } satisfies EventRefundItem;
    await store.create(request, [item]);
    expect((await store.create(request, [item])).requestId).toBe(requestId);
    expect(await count('select count(*) as n from event_cancellation_request where id = $1', [requestId])).toBe(1);
    expect(await count('select count(*) as n from event_refund_item where request_id = $1', [requestId])).toBe(1);
    // 신청과 창 닫기가 겹치면 먼저 온 쪽만 남는다(조건부 UPDATE).
    expect(await store.markApplied(requestId, ticketId, NOW + 10)).toBe(true);
    expect(await store.markApplied(requestId, ticketId, NOW + 20)).toBe(false);
    expect(await store.markNotApplied(requestId, ticketId)).toBe(false);
    expect((await store.items(requestId))[0]?.appliedAtMs).toBe(NOW + 10);
    // 환급 재시도 실행기가 order_cancellation을 REFUNDED로 바꾸면 event_refund_item 진행률도 따라간다.
    await q(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at)
       values ($1, $2, $3, 'EVENT_CANCELLED', 0, false, 0, 0, 10000, 'REFUNDED', now(), now())`,
      [item.cancellationId, item.orderId, item.ticketId],
    );
    expect((await store.items(requestId))[0]?.status).toBe('REFUNDED');
  });

  test('BAT425_대상_조회는_결제_완료_티켓만_고르고_진행_중_취소는_뺀다', async () => {
    const eventId = randomUUID();
    const live = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'PORTONE', cancelled: true });
    const targets = await new DrizzleEventRefundTargets(db, configs).list(eventId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ orderId: live.orderId, ticketId: live.ticketId, ticketPrice: 33_333, pg: 'TOSS' });
  });

  test('BAT425_시작은_대상마다_결정적_취소_ID로_환불하고_부분_실패를_CS로_보낸다', async () => {
    const eventId = randomUUID();
    const a = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    const b = await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'PORTONE' });
    const requestId = randomUUID();
    const f = fixture((_target, i) => (i === 1 ? 'FAILED' : 'REFUNDED'));

    const r = await f.service.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });
    expect(r).toMatchObject({ requestId, status: 'COMPLETED', targetOrders: 2, refundTotal: 43_333, compensationTargets: 2, compensationTotal: 4_334 });
    expect(r.progress).toMatchObject({ total: 2, done: 1, failed: 1 });
    expect(f.notices).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    const rows = await q<{ ticket_id: string; cancellation_id: string; status: string }>('select ticket_id, cancellation_id, status from event_refund_item where request_id = $1 order by ticket_id', [requestId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((x) => x.cancellation_id)).toEqual(
      [a, b].sort((x, y) => x.ticketId.localeCompare(y.ticketId)).map((x) => eventRefundCancellationId(requestId, x.ticketId)),
    );
    expect(await count("select count(*) as n from event_cancellation_request where id = $1 and status = 'COMPLETED'", [requestId])).toBe(1);
  });

  test('BAT425_같은_요청은_다시_시작하지_않고_진행률을_그대로_준다', async () => {
    const eventId = randomUUID();
    await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'TOSS' });
    const requestId = randomUUID();
    const f = fixture();
    const first = await f.service.start({ eventId, requestId, fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    const calls = f.calls.length;
    const second = await f.service.start({ eventId, requestId, fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(second.requestId).toBe(first.requestId);
    expect(second.progress).toEqual(first.progress);
    expect(f.calls).toHaveLength(calls);
  });

  test('BAT425_0018은_환불_시도_표와_신청·재시도_칸을_더하고_재적용해도_같다', async () => {
    const cols = async (table: string) =>
      (await q<{ column_name: string }>('select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position', ['public', table])).rows.map((r) => r.column_name);
    expect(await cols('event_cancellation_request')).toEqual(expect.arrayContaining(['postponed_to', 'refund_window_closes_at']));
    expect(await cols('event_refund_item')).toEqual(expect.arrayContaining(['applied_at', 'next_attempt_at']));
    expect(await cols('event_refund_attempt')).toEqual(expect.arrayContaining(['request_id', 'ticket_id', 'pg', 'amount', 'outcome', 'attempted_at']));
    await migratePurchase(url);
    expect(await count('select count(*) as n from drizzle.__drizzle_migrations')).toBe(journal.entries.length);
    expect(await lastApplied()).toBe(journal.entries.at(-1)!.when);
  });

  test('BAT425_자동_정지는_1분_창_실패율로_멈추고_경보를_남긴다', async () => {
    const eventId = randomUUID();
    await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'TOSS' });
    const requestId = randomUUID();
    const attempts = new DrizzleEventRefundAttempts(db);
    for (let i = 0; i < 20; i++) {
      await attempts.record({ requestId, ticketId: randomUUID(), pg: 'TOSS', amount: 10_000, outcome: i === 19 ? 'FAILURE' : 'SUCCESS', atMs: NOW - 1_000 });
    }
    expect(await attempts.window('TOSS', NOW - 60_000)).toMatchObject({ calls: 20, failures: 1, failedAmount: 10_000 });
    expect(await attempts.consecutiveFailures('TOSS')).toBe(1);
    const raises: Parameters<EventRefundAlert['raise']>[0][] = [];
    const f = fixture(() => 'REFUNDED', { attempts, alert: { raise: async (q) => void raises.push(q) } });
    const r = await f.service.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(f.calls).toHaveLength(0);
    expect(r.status).toBe('PAUSED');
    expect(r.progress.perPg[0]).toMatchObject({ pg: 'TOSS', state: 'PAUSED', pauseReason: 'AUTO_FAILURE_RATE' });
    expect(raises[0]).toMatchObject({ severity: 'SEV2', reason: 'AUTO_FAILURE_RATE' });
  });

  test('BAT425_연기_신청_창은_신청한_티켓만_환급하고_닫히면_미신청을_NOT_APPLIED로_끝낸다', async () => {
    const eventId = randomUUID();
    const a = await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'TOSS' });
    const b = await seedOrder({ eventId, accountId: randomUUID(), amount: 20_000, pg: 'PORTONE' });
    const requestId = randomUUID();
    const f = fixture();
    const started = await f.service.start({ eventId, requestId, fault: 'CONTENT_CHANGE', ruledBy: 'commander-1', confirmedBy: 'operator-2', kind: 'POSTPONE', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
    expect(started.status).toBe('REFUND_WINDOW');
    const applied = await f.service.apply({ requestId, ticketId: a.ticketId });
    expect(applied.progress).toMatchObject({ total: 2, done: 1, notApplied: 0 });
    const closed = await f.service.closeWindow({ requestId, closedBy: 'commander-1', reason: '신청 기한 종료' });
    expect(closed.status).toBe('COMPLETED');
    expect(closed.progress).toMatchObject({ total: 2, done: 1, notApplied: 1 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]![1].reason).toBe('EVENT_POSTPONED');
    const rows = await q<{ ticket_id: string; status: string }>('select ticket_id, status from event_refund_item where request_id = $1 order by ticket_id', [requestId]);
    expect(rows.rows.find((x) => x.ticket_id === b.ticketId)?.status).toBe('NOT_APPLIED');
  });

  test('BAT425_결과_모름은_일시정지_뒤_재개에서_같은_취소_ID로_다시_시도한다', async () => {
    const eventId = randomUUID();
    const target = await seedOrder({ eventId, accountId: randomUUID(), amount: 10_000, pg: 'TOSS' });
    const requestId = randomUUID();
    let outcome: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED' = 'REFUND_PENDING';
    const f = fixture(() => outcome);
    const a = await f.service.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(a.status).toBe('RUNNING');
    const paused = await f.service.pause({ requestId, pg: 'TOSS', reason: '결제사 장애' });
    expect(paused.status).toBe('PAUSED');
    expect(paused.progress.perPg.find((p) => p.pg === 'TOSS')).toMatchObject({ state: 'PAUSED', pauseReason: 'MANUAL', unknown: 1 });
    outcome = 'REFUNDED';
    const resumed = await f.service.resume({ requestId, pg: 'TOSS' });
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.progress).toMatchObject({ done: 1, failed: 0 });
    expect(f.calls.at(-1)![1].cancellationId).toBe(eventRefundCancellationId(requestId, target.ticketId));
  });
});

// ---- BAT-420(시험 담당, 구현 전에 씀): 회차 취소 대상 고르기(GAT-110 E5)·확정 뒤 끝난 주문 쓸어 담기(R-T37 ⑥)·끝나지 않은 주문 상태 목록 ----
describe('BAT-420 대상 고르기·쓸어 담기 [PostgreSQL]', () => {
  beforeAll(async () => {
    await ensureOutboxPartitions(db, fakeClock({ now: NOW }));
  });

  const addCancellation = (o: { orderId: string; ticketId: string; status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED'; reason?: 'USER' | 'FRAUD' }) => {
    const id = randomUUID();
    return q(
      `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, refund_due_at, created_at, status_changed_at)
       values ($1, $2, $3, $4, 0, false, 9000, 29999, 3334, $5, $6, now(), now())`,
      [id, o.orderId, o.ticketId, o.reason ?? 'USER', o.status, o.status === 'REQUESTED' ? new Date(NOW + 2 * DAY) : null],
    ).then(() => id);
  };
  /** 끝나지 않은(또는 원하는) 상태의 주문 하나. 표는 아직 발권되지 않았다(order_item.ticket_id 빔) */
  const seedRawOrder = async (eventId: string, status: string): Promise<{ orderId: string }> => {
    const orderId = randomUUID();
    await q('begin');
    try {
      await q(
        `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
         values ($1, $2, $3, $4, 33333, 1, $5, 'v1', 'PICK', now(), $6, $7)`,
        [orderId, randomUUID(), eventId, status, `idem-${orderId}`, randomUUID(), randomUUID()],
      );
      await q("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, $2, 'T1', 'system:test', now())", [orderId, status]);
      await q("insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'VIP', 'A', 33333, null)", [orderId, randomUUID()]);
      await q('commit');
    } catch (err) {
      await q('rollback').catch(() => undefined);
      throw err;
    }
    return { orderId };
  };
  /** 확정 직전에 결제를 접수한 주문이 확정 뒤 결제를 마치고 발권된 것처럼 바꾼다 */
  const confirmLate = async (orderId: string, from: string): Promise<{ ticketId: string }> => {
    const ticketId = randomUUID();
    await q('begin');
    try {
      await q("update purchase_order set status = 'CONFIRMED', event_seq = 2 where id = $1", [orderId]);
      await q("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 2, $2, 'CONFIRMED', 'T18', 'system:test', now())", [orderId, from]);
      await q('update order_item set ticket_id = $2 where order_id = $1', [orderId, ticketId]);
      await q("insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $1, 'TOSS', 'ACCEPTED', now())", [orderId]);
      await q('commit');
    } catch (err) {
      await q('rollback').catch(() => undefined);
      throw err;
    }
    return { ticketId };
  };
  const service = (calls: string[]) =>
    new EventRefundService({
      store: new DrizzleEventRefundStore(db, fakeClock({ now: NOW })),
      targets: new DrizzleEventRefundTargets(db, configs),
      canceller: { cancel: async (t, x) => (calls.push(`${t.ticketId}:${x.cancellationId}`), { status: 'REFUNDED' }) },
      items: new DrizzleEventRefundStore(db, fakeClock({ now: NOW })),
      openOrders: new DrizzleEventOpenOrders(db),
      fanNotifier: new OutboxEventRefundFanNotifier(),
      nowMs: () => NOW,
      deadlineMs: () => NOW + 30_000,
      concurrency: 2,
    });

  test('GAT-110 E5 회차 취소 대상은 진행 중 취소 없음·보류(REQUESTED)·무효만 있는 표이고 REFUND_PENDING(USER·FRAUD)·REFUNDED 표는 뺀다', async () => {
    const eventId = randomUUID();
    const none = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    const held = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    const userPending = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    const fraudPending = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'PORTONE' });
    const refunded = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'PORTONE' });
    const voidedOnly = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'PORTONE' });
    const heldId = await addCancellation({ ...held, status: 'REQUESTED' });
    await addCancellation({ ...userPending, status: 'REFUND_PENDING' });
    await addCancellation({ ...fraudPending, status: 'REFUND_PENDING', reason: 'FRAUD' });
    await addCancellation({ ...refunded, status: 'REFUNDED' });
    await addCancellation({ ...voidedOnly, status: 'VOIDED' });
    const targets = await new DrizzleEventRefundTargets(db, configs).list(eventId);
    expect(targets.map((t) => t.ticketId).sort()).toEqual([none.ticketId, held.ticketId, voidedOnly.ticketId].sort());
    const byTicket = new Map(targets.map((t) => [t.ticketId, t]));
    expect(byTicket.get(held.ticketId)!.pendingCancellationId).toBe(heldId);
    expect(byTicket.get(none.ticketId)!.pendingCancellationId).toBeUndefined();
    expect(byTicket.get(voidedOnly.ticketId)!.pendingCancellationId).toBeUndefined();
  });

  test('GAT-110 E5 연기(POSTPONE) 대상에는 보류(REQUESTED) 표가 없다', async () => {
    const eventId = randomUUID();
    const none = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    const held = await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    await addCancellation({ ...held, status: 'REQUESTED' });
    const requestId = randomUUID();
    await service([]).start({ eventId, requestId, fault: 'CONTENT_CHANGE', ruledBy: 'commander-1', confirmedBy: 'operator-2', kind: 'POSTPONE', postponedToMs: NOW + 10 * DAY });
    const items = await q<{ ticket_id: string }>('select ticket_id from event_refund_item where request_id = $1', [requestId]);
    expect(items.rows.map((r) => r.ticket_id)).toEqual([none.ticketId]);
  });

  test('R-T37 ⑥ 확정 뒤 결제가 끝난 주문도 환급하고 그 주문이 끝나기 전에는 COMPLETED가 아니며 다시 돌려도 항목이 늘지 않는다', async () => {
    const eventId = randomUUID();
    await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    await seedOrder({ eventId, accountId: randomUUID(), amount: 33_333, pg: 'TOSS' });
    const late = await seedRawOrder(eventId, 'RESERVED');
    const calls: string[] = [];
    const s = service(calls);
    const requestId = randomUUID();
    const started = await s.start({ eventId, requestId, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
    expect(started.progress).toMatchObject({ total: 2, done: 2 });
    expect(started.status).toBe('RUNNING');
    expect(await count("select count(*) as n from event_cancellation_request where id = $1 and status = 'RUNNING'", [requestId])).toBe(1);

    const { ticketId } = await confirmLate(late.orderId, 'RESERVED');
    await s.runDue();
    const items = await q<{ ticket_id: string; cancellation_id: string; status: string }>('select ticket_id, cancellation_id, status from event_refund_item where request_id = $1', [requestId]);
    expect(items.rows).toHaveLength(3);
    expect(items.rows.find((r) => r.ticket_id === ticketId)).toMatchObject({ cancellation_id: eventRefundCancellationId(requestId, ticketId), status: 'REFUNDED' });
    expect(calls.filter((c) => c.startsWith(ticketId))).toEqual([`${ticketId}:${eventRefundCancellationId(requestId, ticketId)}`]);
    const confirmed = await q<{ payload: Buffer }>('select payload from outbox where msg_key = $1', [eventId]);
    const lateConfirmed = confirmed.rows.map((r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as { type: string; orderId: string }).filter((p) => p.type === 'EVENT_CANCELLATION_CONFIRMED' && p.orderId === late.orderId);
    expect(lateConfirmed).toHaveLength(1);
    expect(await count("select count(*) as n from event_cancellation_request where id = $1 and status = 'COMPLETED'", [requestId])).toBe(1);

    await s.runDue();
    expect(await count('select count(*) as n from event_refund_item where request_id = $1', [requestId])).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test('R-T37 ⑥ 끝나지 않은 주문 수는 일곱 상태만 세고 여섯 끝난 상태는 세지 않는다(실제 SQL 목록)', async () => {
    const open = ['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN'];
    const ended = ['CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'];
    const counter = new DrizzleEventOpenOrders(db);
    for (const status of [...open, ...ended]) {
      const eventId = randomUUID();
      await seedRawOrder(eventId, status);
      expect(await counter.count(eventId), status).toBe(open.includes(status) ? 1 : 0);
    }
    const mixed = randomUUID();
    for (const status of [...open, ...ended]) await seedRawOrder(mixed, status);
    expect(await counter.count(mixed)).toBe(7);
  });
});

// ---- BAT-420 몫 D(시험 담당, 구현 전에 씀): 환급 미룸 저장소 DrizzleEventRefundHolds(OPEN[45], GAT-110 D3, R-T38 ⑤, docs/data.md event_refund_hold) ----
describe('환급 미룸 저장소 [BAT-420 몫 D]', () => {
  const EXPIRES = NOW + 259_200_000;
  const holdOf = async (eventId: string) =>
    (await q<{ cancellation_request_id: string; held_at: Date; expires_at: Date; released_at: Date | null }>('select cancellation_request_id, held_at, expires_at, released_at from event_refund_hold where event_id = $1', [eventId])).rows;

  test('GAT-110 D3 걸기는 회차마다 한 줄이고, 같은 요청 ID로 다시 걸면 기한만 바뀌며(늘리기·같은 값 멱등), 다른 요청 ID는 ALREADY_EXISTS이고 줄이 그대로다', async () => {
    const holds = new DrizzleEventRefundHolds(db);
    const eventId = randomUUID();
    const requestId = randomUUID();
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES, nowMs: NOW })).resolves.toEqual({ held: true, expiresAtMs: EXPIRES });
    expect(await holdOf(eventId)).toEqual([{ cancellation_request_id: requestId, held_at: new Date(NOW), expires_at: new Date(EXPIRES), released_at: null }]);
    // 같은 값 다시 걸기는 그대로, 늘리기는 기한만 바뀐다(건 시각은 처음 값)
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES, nowMs: NOW + 1_000 })).resolves.toEqual({ held: true, expiresAtMs: EXPIRES });
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES + DAY, nowMs: NOW + DAY })).resolves.toEqual({ held: true, expiresAtMs: EXPIRES + DAY });
    expect(await holdOf(eventId)).toEqual([{ cancellation_request_id: requestId, held_at: new Date(NOW), expires_at: new Date(EXPIRES + DAY), released_at: null }]);
    // 같은 회차에 다른 요청의 열린 미룸이 있으면 ALREADY_EXISTS
    await expect(holds.set({ eventId, cancellationRequestId: randomUUID(), held: true, expiresAtMs: EXPIRES, nowMs: NOW + DAY })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await holdOf(eventId)).toEqual([{ cancellation_request_id: requestId, held_at: new Date(NOW), expires_at: new Date(EXPIRES + DAY), released_at: null }]);
  });

  test('GAT-110 D3 풀기는 같은 요청 ID일 때만 released_at을 쓰고(다른 요청 ID는 그대로 걸림), 두 번 풀어도 오류 없이 처음 푼 시각이며, 풀린 회차는 새 요청이 다시 걸 수 있다', async () => {
    const holds = new DrizzleEventRefundHolds(db);
    const eventId = randomUUID();
    const requestId = randomUUID();
    await holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES, nowMs: NOW });
    await expect(holds.set({ eventId, cancellationRequestId: randomUUID(), held: false, nowMs: NOW + 1_000 })).resolves.toMatchObject({ held: true });
    expect((await holdOf(eventId))[0]!.released_at).toBeNull();
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: false, nowMs: NOW + 2_000 })).resolves.toMatchObject({ held: false });
    expect((await holdOf(eventId))[0]!.released_at).toEqual(new Date(NOW + 2_000));
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: false, nowMs: NOW + 3_000 })).resolves.toMatchObject({ held: false });
    expect((await holdOf(eventId))[0]!.released_at).toEqual(new Date(NOW + 2_000));
    // 없는 회차 풀기도 오류가 아니다(ops 반려가 늦게 와도)
    await expect(holds.set({ eventId: randomUUID(), cancellationRequestId: requestId, held: false, nowMs: NOW })).resolves.toMatchObject({ held: false });
    // 풀린 회차에 새 요청이 걸면 그 요청의 줄이 된다(회차 하나에 한 줄)
    const next = randomUUID();
    await expect(holds.set({ eventId, cancellationRequestId: next, held: true, expiresAtMs: EXPIRES + DAY, nowMs: NOW + DAY })).resolves.toEqual({ held: true, expiresAtMs: EXPIRES + DAY });
    expect(await holdOf(eventId)).toEqual([{ cancellation_request_id: next, held_at: new Date(NOW + DAY), expires_at: new Date(EXPIRES + DAY), released_at: null }]);
  });

  test('R-T38 ⑤ 기한 지난 미룸 풀기는 기한 = 지금인 줄부터 풀고(1ms 앞은 아님) 한 번만 돌려주며, 기한이 지난 미룸은 다른 요청이 걸 수 있다', async () => {
    const holds = new DrizzleEventRefundHolds(db);
    const eventId = randomUUID();
    const requestId = randomUUID();
    await holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES, nowMs: NOW });
    const mine = (rows: readonly { eventId: string; cancellationRequestId: string }[]) => rows.filter((r) => r.eventId === eventId);
    expect(mine(await holds.releaseExpired(EXPIRES - 1, 100))).toEqual([]);
    expect((await holdOf(eventId))[0]!.released_at).toBeNull();
    expect(mine(await holds.releaseExpired(EXPIRES, 100))).toEqual([{ eventId, cancellationRequestId: requestId }]);
    expect((await holdOf(eventId))[0]!.released_at).toEqual(new Date(EXPIRES));
    expect(mine(await holds.releaseExpired(EXPIRES + 1, 100))).toEqual([]);
    // 둘이 같이 돌아도 한 번만 돌려준다(조건부 갱신)
    const other = randomUUID();
    await holds.set({ eventId: other, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES, nowMs: NOW });
    const [a, b] = await Promise.all([holds.releaseExpired(EXPIRES, 100), holds.releaseExpired(EXPIRES, 100)]);
    expect([...a, ...b].filter((r) => r.eventId === other)).toHaveLength(1);
    // 기한이 지나 풀리지 않은 미룸(아직 releaseExpired 전)도 걸린 것이 아니다: 새 요청이 걸 수 있다
    const stale = randomUUID();
    await holds.set({ eventId: stale, cancellationRequestId: randomUUID(), held: true, expiresAtMs: NOW + 1_000, nowMs: NOW });
    const fresh = randomUUID();
    await expect(holds.set({ eventId: stale, cancellationRequestId: fresh, held: true, expiresAtMs: EXPIRES, nowMs: NOW + 1_000 })).resolves.toEqual({ held: true, expiresAtMs: EXPIRES });
    expect((await holdOf(stale))[0]).toMatchObject({ cancellation_request_id: fresh, released_at: null });
  });
});

// ---- BAT-420 리뷰 D3(시험 담당, 구현 전에 씀, 계획 §11 보충 3, transfer-refund §5 '미룸 풀기', refund.proto SetEventRefundHold 주석) ----
describe('확정이 커밋된 요청의 다시 걸기 [BAT-420 리뷰 D3]', () => {
  const EXPIRES = NOW + 259_200_000;
  const putRequest = (id: string, eventId: string, status: string) =>
    q(
      `insert into event_cancellation_request (id, event_id, kind, status, fault, ruled_by, confirmed_by, created_at, updated_at)
       values ($1, $2, 'CANCEL', $3, 'ORGANIZER', 'commander-1', 'operator-2', $4, $4)`,
      [id, eventId, status, new Date(NOW)],
    );
  const holdOf = async (eventId: string) =>
    (await q<{ cancellation_request_id: string; expires_at: Date; released_at: Date | null }>('select cancellation_request_id, expires_at, released_at from event_refund_hold where event_id = $1', [eventId])).rows[0];

  test('GAT-110 R3 그 요청 ID의 일괄 환불 요청이 이미 있으면(확정 커밋 뒤 다시 확정) 걸기·늘리기가 미룸을 다시 열지 않고 held 거짓이며 released_at 그대로, 기한이 지나도 풀 미룸이 없다', async () => {
    const holds = new DrizzleEventRefundHolds(db);
    const eventId = randomUUID();
    const requestId = randomUUID();
    await holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES, nowMs: NOW });
    // StartEventRefund가 요청 행을 만들고 같은 트랜잭션에서 미룸을 풀었다(ops는 답을 잃어 PENDING_APPROVAL로 되돌림)
    await putRequest(requestId, eventId, 'RUNNING');
    await holds.set({ eventId, cancellationRequestId: requestId, held: false, nowMs: NOW + 1_000 });
    const released = await holdOf(eventId);
    expect(released?.released_at).toEqual(new Date(NOW + 1_000));
    // 다시 확정: ops가 같은 요청 ID로 늘리기를 부른다
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES + 60_000, nowMs: NOW + 60_000 })).resolves.toMatchObject({ held: false });
    expect(await holdOf(eventId)).toEqual(released);
    // 72시간 뒤에도 풀 미룸이 없다(거짓 SEV2 event-refund-hold-expired가 나지 않는다)
    const expired = await holds.releaseExpired(EXPIRES + 60_000 + 1, 500);
    expect(expired.filter((r) => r.eventId === eventId)).toEqual([]);
    // 요청 상태가 끝났어도(COMPLETED) 같은 요청 ID면 열지 않는다
    await q("update event_cancellation_request set status = 'COMPLETED' where id = $1", [requestId]);
    await expect(holds.set({ eventId, cancellationRequestId: requestId, held: true, expiresAtMs: EXPIRES + 120_000, nowMs: NOW + 120_000 })).resolves.toMatchObject({ held: false });
    expect(await holdOf(eventId)).toEqual(released);
  });

  test('GAT-110 R3 대조: 같은 회차에 끝난(COMPLETED) 다른 요청 ID가 있어도 새 요청 ID의 걸기는 열린다(회차가 아니라 요청 ID로 본다)', async () => {
    const holds = new DrizzleEventRefundHolds(db);
    const eventId = randomUUID();
    const old = randomUUID();
    await putRequest(old, eventId, 'COMPLETED');
    const fresh = randomUUID();
    await expect(holds.set({ eventId, cancellationRequestId: fresh, held: true, expiresAtMs: EXPIRES, nowMs: NOW })).resolves.toEqual({ held: true, expiresAtMs: EXPIRES });
    expect(await holdOf(eventId)).toMatchObject({ cancellation_request_id: fresh, released_at: null });
  });
});

// ---- BAT-420 리뷰 D5(시험 담당, 구현 전에 씀, 계획 §11 보충 3, transfer-refund §5 '확정 뒤 팬 취소') ----
describe('확정된 회차 취소 찾기 [BAT-420 리뷰 D5]', () => {
  const put = (eventId: string, kind: 'CANCEL' | 'POSTPONE', status: string) =>
    q(
      `insert into event_cancellation_request (id, event_id, kind, status, fault, ruled_by, confirmed_by, postponed_to, refund_window_closes_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'ORGANIZER', 'commander-1', 'operator-2', $5, $6, $7, $7)`,
      [randomUUID(), eventId, kind, status, kind === 'POSTPONE' ? new Date(NOW + 7 * DAY) : null, kind === 'POSTPONE' ? new Date(NOW + 3 * DAY) : null, new Date(NOW)],
    );

  test.each(['RUNNING', 'PAUSED', 'COMPLETED'])('GAT-110 R5 회차 취소(CANCEL)가 %s인 회차는 확정됐다(참)', async (status) => {
    const eventId = randomUUID();
    await put(eventId, 'CANCEL', status);
    await expect(new DrizzleEventCancellationLookup(db).confirmed(eventId)).resolves.toBe(true);
    // 다른 회차는 거짓(회차로 거른다)
    await expect(new DrizzleEventCancellationLookup(db).confirmed(randomUUID())).resolves.toBe(false);
  });

  test.each([
    ['CANCEL', 'REQUESTED'],
    ['CANCEL', 'JUDGED'],
    ['CANCEL', 'PENDING_APPROVAL'],
    ['CANCEL', 'APPROVED'],
    ['CANCEL', 'REJECTED'],
    ['POSTPONE', 'RUNNING'],
    ['POSTPONE', 'REFUND_WINDOW'],
    ['POSTPONE', 'COMPLETED'],
  ] as const)('GAT-110 R5 %s %s뿐인 회차는 확정되지 않았다(거짓, 판정 중 보류 취소는 지금처럼 남고 연기는 막지 않는다)', async (kind, status) => {
    const eventId = randomUUID();
    await put(eventId, kind, status);
    await expect(new DrizzleEventCancellationLookup(db).confirmed(eventId)).resolves.toBe(false);
  });

  test('GAT-110 R5 반려된 옛 요청 뒤에 새 요청이 확정되면 참이다(요청이 여럿이어도 하나라도 확정이면)', async () => {
    const eventId = randomUUID();
    await put(eventId, 'CANCEL', 'REJECTED');
    await expect(new DrizzleEventCancellationLookup(db).confirmed(eventId)).resolves.toBe(false);
    await put(eventId, 'CANCEL', 'RUNNING');
    await expect(new DrizzleEventCancellationLookup(db).confirmed(eventId)).resolves.toBe(true);
  });
});
