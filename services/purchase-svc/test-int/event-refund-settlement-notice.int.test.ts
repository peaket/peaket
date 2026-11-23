// J-T23 ① purchase-svc 정산 알리기의 보낸 시각 세 칸을 실제 PostgreSQL로 본다(F-07-8 계획 I-04, §5.1 (마) '저장(검사용)', purchase 0038, 시험 리뷰 TR-10).
// event_cancellation_request.settlement_hold_sent_at·settlement_completion_sent_at·settlement_next_at을 Drizzle 저장소가 쓰고 읽어야
// (가) 보류 열기 성공을 잊지 않고 완료를 부르며, (나) 다시 띄운 파드(새 EventRefundService)가 처음부터 다시 부르지 않는다.
// 정산 포트(payment-svc 내부 HTTP)는 대역이다. 기준 트리: 0038 칸과 settlement 의존이 없어 실패한다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleEventOpenOrders, DrizzleEventRefundStore, DrizzleEventRefundTargets, EventRefundService } from '../src/modules/refund/index.js';
import type { SettlementRecalculationPort } from '../src/modules/refund/domain/event-refund-ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const DAY = 86_400_000;
const MINUTE = 60_000;

let pgc: PostgresContainer | undefined;
let db: Database;
const configs = { config: async () => ({ saleEndsAtMs: NOW + 7 * DAY, entryOpensAtMs: NOW + 6 * DAY }) };

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePurchase(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'event-refund-settlement-notice-it' });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await db.pool.query('truncate compensation, event_refund_attempt, event_refund_item, event_cancellation_request, event_refund_hold, order_cancellation, order_item, order_event, purchase_order, payment_attempt cascade');
});

class RecordingSettlement implements SettlementRecalculationPort {
  readonly opens: string[] = [];
  readonly completes: { requestId: string; partial: boolean }[] = [];
  failOpen = false;
  async open(input: { requestId: string }): Promise<void> {
    this.opens.push(input.requestId);
    if (this.failOpen) throw new Error('payment-svc 503');
  }
  async complete(requestId: string, input: { completedAt: Date; partial: boolean }): Promise<void> {
    this.completes.push({ requestId, partial: input.partial });
  }
}

const inTx = async (statements: readonly [string, unknown[]][]): Promise<void> => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    for (const [text, values] of statements) await client.query(text, values);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

/** 결제가 끝난(CONFIRMED) 47,500원 표 하나인 주문 */
const confirmedOrder = (eventId: string) => {
  const orderId = randomUUID();
  return inTx([
    [
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', 47500, 1, $4, 'v1', 'PICK', $5, $6, $7)`,
      [orderId, randomUUID(), eventId, `idem-${orderId}`, new Date(NOW - 12 * DAY), randomUUID(), randomUUID()],
    ],
    ["insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)", [orderId, new Date(NOW - 12 * DAY)]],
    ["insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'R', 'A', 47500, $3)", [orderId, randomUUID(), randomUUID()]],
    ["insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $2, 'TOSS', 'ACCEPTED', $3)", [randomUUID(), orderId, new Date(NOW - 12 * DAY)]],
  ]).then(() => orderId);
};

/** 아직 끝나지 않은(RESERVED) 주문. 있으면 요청이 COMPLETED로 가지 않는다 */
const openOrder = async (eventId: string): Promise<string> => {
  const orderId = randomUUID();
  await inTx([
    [
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'RESERVED', 47500, 1, $4, 'v1', 'PICK', $5, $6, $7)`,
      [orderId, randomUUID(), eventId, `idem-${orderId}`, new Date(NOW - 60_000), randomUUID(), randomUUID()],
    ],
    ["insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'RESERVED', 'T1', 'test', $2)", [orderId, new Date(NOW - 60_000)]],
  ]);
  return orderId;
};
const expireOrder = (orderId: string) =>
  inTx([
    ["update purchase_order set status = 'EXPIRED', event_seq = 2 where id = $1", [orderId]],
    ["insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 2, 'RESERVED', 'EXPIRED', 'T11', 'test', $2)", [orderId, new Date(NOW)]],
  ]);

/** 파드 하나(다시 띄우면 새로 만든다). 시계는 같은 값을 본다 */
const pod = (settlement: RecordingSettlement, clock: { now: number }) => {
  const store = new DrizzleEventRefundStore(db, fakeClock({ now: clock.now }));
  return new EventRefundService({
    store,
    targets: new DrizzleEventRefundTargets(db, configs),
    canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
    items: store,
    openOrders: new DrizzleEventOpenOrders(db),
    settlement,
    nowMs: () => clock.now,
    deadlineMs: () => clock.now + 5_000,
  });
};

const sentColumns = async (requestId: string) =>
  (
    await db.pool.query<{ settlement_hold_sent_at: Date | null; settlement_completion_sent_at: Date | null; settlement_next_at: Date | null }>(
      'select settlement_hold_sent_at, settlement_completion_sent_at, settlement_next_at from event_cancellation_request where id = $1',
      [requestId],
    )
  ).rows[0]!;

const start = (svc: EventRefundService, eventId: string, requestId: string) => svc.start({ eventId, requestId, kind: 'CANCEL', fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });

describe('J-T23 ① 정산 알리기 보낸 시각 칸 [실제 PostgreSQL]', () => {
  test('J-T23 ① 보류 열기 성공은 settlement_hold_sent_at에 남고, 다시 띄운 파드가 COMPLETED 뒤 완료를 한 번만 부르며 settlement_completion_sent_at을 쓴다', async () => {
    const clock = { now: NOW };
    const eventId = randomUUID();
    await confirmedOrder(eventId);
    const pending = await openOrder(eventId);
    const settlement = new RecordingSettlement();
    const requestId = randomUUID();
    expect((await start(pod(settlement, clock), eventId, requestId)).status).toBe('RUNNING');
    expect(settlement.opens).toEqual([requestId]);
    const afterOpen = await sentColumns(requestId);
    expect(afterOpen.settlement_hold_sent_at?.toISOString()).toBe(new Date(NOW).toISOString());
    expect(afterOpen.settlement_completion_sent_at).toBeNull();
    // 다시 띄운 파드: 보류 열기를 다시 부르지 않고, 끝나지 않은 주문이 사라져 COMPLETED가 된 뒤 완료를 한 번 부른다
    await expireOrder(pending);
    clock.now = NOW + 10 * MINUTE;
    const restarted = pod(settlement, clock);
    await restarted.runDue();
    await restarted.runDue();
    expect(settlement.opens).toEqual([requestId]);
    expect(settlement.completes).toEqual([{ requestId, partial: false }]);
    const afterComplete = await sentColumns(requestId);
    expect(afterComplete.settlement_completion_sent_at?.toISOString()).toBe(new Date(NOW + 10 * MINUTE).toISOString());
    // 또 다시 띄워도 더 부르지 않는다
    clock.now = NOW + 40 * MINUTE;
    await pod(settlement, clock).runDue();
    expect(settlement.opens).toHaveLength(1);
    expect(settlement.completes).toHaveLength(1);
  });

  test('J-T23 ① 보류 열기가 실패하면 settlement_hold_sent_at은 비고 settlement_next_at = 지금 + 1분이며, 다시 띄운 파드가 그 시각에 다시 부른다', async () => {
    const clock = { now: NOW };
    const eventId = randomUUID();
    await confirmedOrder(eventId);
    await openOrder(eventId);
    const settlement = new RecordingSettlement();
    settlement.failOpen = true;
    const requestId = randomUUID();
    await start(pod(settlement, clock), eventId, requestId);
    const failed = await sentColumns(requestId);
    expect(failed.settlement_hold_sent_at).toBeNull();
    expect(failed.settlement_next_at?.toISOString()).toBe(new Date(NOW + MINUTE).toISOString());
    settlement.failOpen = false;
    clock.now = NOW + MINUTE - 1;
    await pod(settlement, clock).runDue();
    expect(settlement.opens).toHaveLength(1);
    clock.now = NOW + MINUTE;
    await pod(settlement, clock).runDue();
    expect(settlement.opens).toEqual([requestId, requestId]);
    expect((await sentColumns(requestId)).settlement_hold_sent_at?.toISOString()).toBe(new Date(NOW + MINUTE).toISOString());
  });
});
