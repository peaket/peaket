// purchase-svc 회차 취소 일괄 환불(BAT-425 GAT-120·GAT-130) 실제 PostgreSQL 18 통합 시험.
// 0016 마이그레이션 적용·재적용, event_cancellation_request·event_refund_item, 미리보기·시작·진행률·일시정지·재개,
// 결정적 취소 ID, 같은 요청·티켓 멱등, 부분 실패 CS 통지를 본다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleEventRefundAttempts, DrizzleEventRefundStore, DrizzleEventRefundTargets, EventRefundService } from '../src/modules/refund/index.js';
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
    expect(await count('select count(*) as n from drizzle.__drizzle_migrations')).toBe(20);
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
    expect(await count('select count(*) as n from drizzle.__drizzle_migrations')).toBe(20);
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
