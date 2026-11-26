// F-07-15 I-02 purchase 계좌 입력 요청의 실제 PostgreSQL 시험.
// 0039의 칸·색인, Drizzle 원천의 count+1·next_at·Outbox 한 트랜잭션, RefundRetryLoop 조립,
// event_refund_attempt 최근 5분 집계를 실제 DB로 본다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  AccountRequestNotices,
  DrizzleAccountNoticeSource,
  DrizzleEventRefundAttempts,
  RefundRetryLoop,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

/** 2026-11-27(금) 12:00 KST */
const NOW = Date.parse('2026-11-27T03:00:00.000Z');
const NEXT_BUSINESS_10 = Date.parse('2026-11-30T01:00:00.000Z');

let pgc: PostgresContainer;
let db: Database;
const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePurchase(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f0715-refund-account' });
  await ensureOutboxPartitions(db, clock, { daysAhead: 7 });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await db.pool.query<T>(text, values)).rows;

async function seedOrder(o: { eventId?: string; refundAmount?: number; noticeNextAt?: Date } = {}): Promise<{ orderId: string; eventId: string; cancellationId: string; accountId: string }> {
  const orderId = randomUUID();
  const eventId = o.eventId ?? randomUUID();
  const accountId = randomUUID();
  const cancellationId = randomUUID();
  const at = new Date(NOW);
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', 66000, 1, $4, 'v1', 'PICK', $5, $6, 'f0715-refund-account')`,
      [orderId, accountId, eventId, `idem-${orderId}`, at, randomUUID()],
    );
    await client.query("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)", [orderId, at]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await db.pool.query(
    `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at, refund_account_required_at, refund_account_notice_next_at)
     values ($1, $2, $3, 'USER', 0, false, 0, 0, $4, 'REFUND_PENDING', $5, $5, $5, $6)`,
    [cancellationId, orderId, randomUUID(), o.refundAmount ?? 6600, at, o.noticeNextAt ?? at],
  );
  return { orderId, eventId, cancellationId, accountId };
}

const notices = (c = fakeClock({ now: NOW })) =>
  new AccountRequestNotices({
    refunds: new DrizzleAccountNoticeSource(db, c, 'REFUND'),
    compensations: new DrizzleAccountNoticeSource(db, c, 'COMPENSATION'),
    calendar: new WeekendBusinessCalendar(),
    clock: c,
  });

const outboxOf = async (eventId: string) =>
  (await q<{ topic: string; payload: Buffer }>('select topic, payload from outbox where msg_key = $1 order by outbox.seq', [eventId])).map((r) => ({
    topic: r.topic,
    event: JSON.parse(Buffer.from(r.payload).toString('utf8')) as Record<string, unknown>,
  }));

describe('R-T20 ② 계좌 입력 요청 [실제 PostgreSQL]', () => {
  test('R-T20 ② 0039는 요청 횟수·다음 시각 칸과 두 부분 색인을 만든다', async () => {
    const cols = await q<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'order_cancellation' and column_name like 'refund_account_notice%' order by column_name",
    );
    expect(cols).toEqual([
      { column_name: 'refund_account_notice_count', is_nullable: 'NO' },
      { column_name: 'refund_account_notice_next_at', is_nullable: 'YES' },
    ]);
    const comp = await q<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'compensation' and column_name like 'account_notice%' order by column_name",
    );
    expect(comp.map((c) => c.column_name)).toEqual(['account_notice_count', 'account_notice_next_at']);
    const indexes = await q<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in ('order_cancellation_account_notice_due_idx', 'compensation_account_notice_due_idx') order by indexname",
    );
    expect(indexes).toHaveLength(2);
    expect(indexes.map((i) => i.indexdef).join('\n')).toContain("WHERE ((status = 'REFUND_PENDING'::text)");
    expect(indexes.map((i) => i.indexdef).join('\n')).toContain("WHERE (status = 'ACCOUNT_PENDING'::text)");
  });

  test('R-T20 ② 취소·배상 첫 요청은 count+1·다음 영업일 10:00·Outbox를 한 트랜잭션에 쓴다', async () => {
    const r = await seedOrder();
    const compensationId = randomUUID();
    await db.pool.query(
      `insert into compensation (id, event_cancellation_request_id, order_id, event_id, account_id, promoter_id, base_amount, amount, status, account_last4, transfer_id, receivable_id, failure_reason, account_notice_count, account_notice_next_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, 47500, 4750, 'ACCOUNT_PENDING', null, null, null, null, 0, $6, $6, $6)`,
      [compensationId, randomUUID(), r.orderId, r.eventId, r.accountId, new Date(NOW)],
    );

    const noticeClock = fakeClock({ now: NOW });
    const notifier = notices(noticeClock);
    const result = await notifier.run(50);
    expect(result).toEqual({ sent: 2, skipped: 0 });

    const refund = await q<{ refund_account_notice_count: number; refund_account_notice_next_at: Date }>(
      'select refund_account_notice_count, refund_account_notice_next_at from order_cancellation where id = $1',
      [r.cancellationId],
    );
    expect(refund[0]?.refund_account_notice_count).toBe(1);
    expect(new Date(refund[0]!.refund_account_notice_next_at).getTime()).toBe(NEXT_BUSINESS_10);
    const comp = await q<{ account_notice_count: number; account_notice_next_at: Date }>(
      'select account_notice_count, account_notice_next_at from compensation where id = $1',
      [compensationId],
    );
    expect(comp[0]?.account_notice_count).toBe(1);
    expect(new Date(comp[0]!.account_notice_next_at).getTime()).toBe(NEXT_BUSINESS_10);

    const outbox = await outboxOf(r.eventId);
    expect(outbox.map((x) => x.topic)).toEqual(['trade.orders', 'trade.orders']);
    expect(outbox.map((x) => x.event.type).sort()).toEqual(['COMPENSATION_ACCOUNT_REQUESTED', 'REFUND_ACCOUNT_REQUESTED']);
    const refundEvent = outbox.find((x) => x.event.type === 'REFUND_ACCOUNT_REQUESTED')!.event;
    expect(refundEvent).toMatchObject({ cancellationId: r.cancellationId, orderId: r.orderId, eventId: r.eventId, accountId: r.accountId, refundAmount: 6600 });
    expect(refundEvent.eventKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(JSON.stringify(refundEvent)).not.toMatch(/123-456|계좌번호/);

    // 같은 시각에는 다시 보내지 않는다. 다음 영업일 10:00에만 다시 본다
    expect(await notifier.run(50)).toEqual({ sent: 0, skipped: 0 });
    noticeClock.advance(NEXT_BUSINESS_10 - noticeClock.now());
    expect(await notifier.run(50)).toEqual({ sent: 2, skipped: 0 });
    expect((await q<{ n: number }>('select count(*)::int as n from outbox where msg_key = $1', [r.eventId]))[0]?.n).toBe(4);
  });

  test('R-T20 ② RefundRetryLoop는 환급 뒤 계좌 요청을 한 번 부르고 그 실패는 환급 결과를 바꾸지 않는다', async () => {
    const r = await seedOrder();
    const loop = new RefundRetryLoop({
      refund: { run: async () => ({ refunded: 2, pending: 1, failed: 0 }) },
      accountRequests: notices(),
      leader: { isLeader: () => true },
    });
    expect(await loop.tick()).toEqual({ refunded: 2, pending: 1, failed: 0, notified: 1 });
    expect((await q<{ refund_account_notice_count: number }>('select refund_account_notice_count from order_cancellation where id = $1', [r.cancellationId]))[0]?.refund_account_notice_count).toBe(1);

    const failing = new RefundRetryLoop({
      refund: { run: async () => ({ refunded: 3, pending: 0, failed: 1 }) },
      accountRequests: { run: async () => { throw new Error('notice down'); } },
      leader: { isLeader: () => true },
    });
    expect(await failing.tick()).toEqual({ refunded: 3, pending: 0, failed: 1 });
  });

  test('R-T45 ④ event_refund_attempt의 최근 5분 집계는 경계와 REJECT를 가른다', async () => {
    const attempts = new DrizzleEventRefundAttempts(db);
    const base = { requestId: randomUUID(), ticketId: randomUUID(), amount: 1000 };
    await attempts.record({ ...base, pg: 'TOSS', outcome: 'SUCCESS', atMs: NOW - 60_000 });
    await attempts.record({ ...base, pg: 'TOSS', outcome: 'FAILURE', atMs: NOW - 50_000 });
    await attempts.record({ ...base, pg: 'PORTONE', outcome: 'UNKNOWN', atMs: NOW - 40_000 });
    await attempts.record({ ...base, pg: 'PORTONE', outcome: 'REJECT', atMs: NOW - 30_000 });
    await attempts.record({ ...base, pg: 'TOSS', outcome: 'SUCCESS', atMs: NOW - 300_000 });

    const recent = await attempts.recent(NOW - 300_000);
    expect(recent.map((a) => [a.pg, a.outcome, a.atMs])).toEqual([
      ['TOSS', 'SUCCESS', NOW - 60_000],
      ['TOSS', 'FAILURE', NOW - 50_000],
      ['PORTONE', 'UNKNOWN', NOW - 40_000],
      ['PORTONE', 'REJECT', NOW - 30_000],
    ]);
  });
});
