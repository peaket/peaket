// 회차 취소 확정의 배상 행·유일·트랜잭션(BAT-425 R-T46 ②, FR-056, ADR-0046 결정 5, ADR-0317).
// 정본: docs/features/transfer-refund.md §6 '배상금 지급의 첫 구현', §11 R-T46 ②, docs/data.md compensation.
// - 미리보기에서 주문 단위로 계산한 금액이 확정 때 다시 계산해 달라지지 않는다(RV-02, 계획 B13).
// - 다시 확정해도 (request_id, order_id) 유일로 한 행이고, 확정 트랜잭션이 실패하면 요청·항목·배상 행이 모두 0이다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleEventOpenOrders, DrizzleEventRefundStore, DrizzleEventRefundTargets, EventRefundService } from '../src/modules/refund/index.js';
import type { EventRefundCanceller } from '../src/modules/refund/domain/event-refund-ports.js';
import type { EventCancellationRequest } from '../src/modules/refund/domain/event-refund.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0193c425-0000-7000-8000-0000000000e1';
const ORDER_A = '0193c425-0000-7000-8000-0000000000a1';
const ORDER_B = '0193c425-0000-7000-8000-0000000000b1';
const ACCOUNT_A = '0193c425-0000-7000-8000-000000000011';
const ACCOUNT_B = '0193c425-0000-7000-8000-000000000012';

let pgc: PostgresContainer | undefined;
let db: Database;
const clock = fakeClock({ now: NOW });
const configs = { config: async () => ({ saleEndsAtMs: NOW + 7 * DAY, entryOpensAtMs: NOW + 6 * DAY }) };

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePurchase(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'compensation-records-it' });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await db.pool.query('truncate compensation, event_refund_attempt, event_refund_item, event_cancellation_request, event_refund_hold, order_cancellation, order_item, order_event, purchase_order, payment_attempt cascade');
});

const count = async (table: string, where = ''): Promise<number> => Number((await db.pool.query(`select count(*)::int as n from ${table} ${where}`)).rows[0]!.n);

/** 주문 하나와 그 표들(권면 가격)을 심는다. purchase_order의 지연 제약(order_status_has_event) 때문에 주문·이력을 한 트랜잭션에 쓴다 */
async function seedOrder(orderId: string, accountId: string, prices: readonly number[]): Promise<void> {
  const amount = prices.reduce((a, b) => a + b, 0);
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', $4, 1, $5, 'v1', 'PICK', $6, $7, $8)`,
      [orderId, accountId, EVENT, amount, `idem-${orderId}`, new Date(NOW - 12 * DAY), randomUUID(), randomUUID()],
    );
    await client.query("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)", [orderId, new Date(NOW - 12 * DAY)]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  let line = 0;
  for (const price of prices) {
    await db.pool.query(
      `insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id)
       values ($1, $2, $3, 'R', 'A', $4, $5)`,
      [orderId, ++line, randomUUID(), price, randomUUID()],
    );
  }
  await db.pool.query("insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $2, 'TOSS', 'ACCEPTED', $3)", [randomUUID(), orderId, new Date(NOW - 12 * DAY)]);
}

const service = (): { svc: EventRefundService; calls: number[] } => {
  const calls: number[] = [];
  const canceller: EventRefundCanceller = {
    cancel: async () => {
      calls.push(1);
      return { status: 'REFUNDED' };
    },
  };
  const svc = new EventRefundService({
    store: new DrizzleEventRefundStore(db, clock),
    targets: new DrizzleEventRefundTargets(db, configs),
    canceller,
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
    concurrency: 2,
  });
  return { svc, calls };
};
const start = (svc: EventRefundService, requestId = randomUUID()) =>
  svc.start({ eventId: EVENT, requestId, kind: 'CANCEL', fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });
const compensationRows = async () =>
  (
    await db.pool.query<{ order_id: string; base_amount: number; amount: number; status: string; account_last4: string | null; receivable_id: string | null }>(
      'select order_id, base_amount, amount, status, account_last4, receivable_id from compensation order by order_id',
    )
  ).rows;

describe('R-T46 ② 확정 배상 행 [실제 PostgreSQL]', () => {
  test('R-T46 ②_미리보기_뒤_주문_표가_바뀌어도_확정_배상_행_금액과_합계는_미리보기_값_그대로다', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [10_001, 10_001]);
    await seedOrder(ORDER_B, ACCOUNT_B, [33_333]);
    const { svc } = service();
    const preview = await svc.preview({ eventId: EVENT, fault: 'ORGANIZER' });
    expect(preview.compensationOrders).toEqual([
      { orderId: ORDER_A, baseAmount: 20_002, amount: 2_001 },
      { orderId: ORDER_B, baseAmount: 33_333, amount: 3_334 },
    ]);
    expect(preview.compensationTotal).toBe(5_335);

    // 미리보기 뒤에 표 하나가 더 팔렸다(같은 주문에 10,000원 표 추가). 확정이 다시 계산하면 A가 3,002원이 된다
    await db.pool.query("insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 3, $2, 'R', 'A', 10000, $3)", [ORDER_A, randomUUID(), randomUUID()]);
    const requestId = randomUUID();
    const started = await start(svc, requestId);

    const rows = await compensationRows();
    expect(rows.map((r) => ({ orderId: r.order_id, baseAmount: r.base_amount, amount: r.amount }))).toEqual([
      { orderId: ORDER_A, baseAmount: 20_002, amount: 2_001 },
      { orderId: ORDER_B, baseAmount: 33_333, amount: 3_334 },
    ]);
    expect(rows.every((r) => r.status === 'ACCOUNT_PENDING' && r.account_last4 === null && r.receivable_id === null)).toBe(true);
    const saved = (await db.pool.query<{ compensation_targets: number; compensation_total: number }>('select compensation_targets, compensation_total from event_cancellation_request where id = $1', [requestId])).rows[0]!;
    expect(saved).toEqual({ compensation_targets: preview.compensationTargets, compensation_total: preview.compensationTotal });
    expect(started.compensationTotal).toBe(preview.compensationTotal);
  });

  // RV-22(중간): 미리보기 목록에는 남아 있지만 확정 때 대상에서 빠진 주문은 compensation 행에서 빠지는데
  // 요청 행의 compensation_targets/Total은 저장한 목록을 그대로 세어 2건 5,335원으로 남는다. 합계도 실제 행과 같아야 한다.
  test('R-T46 ②_RV22_미리보기_뒤_대상에서_빠진_주문은_배상_합계와_행에서_함께_빠진다', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [10_001, 10_001]);
    await seedOrder(ORDER_B, ACCOUNT_B, [33_333]);
    const { svc } = service();
    const preview = await svc.preview({ eventId: EVENT, fault: 'ORGANIZER' });
    expect(preview.compensationOrders).toHaveLength(2);
    expect(preview.compensationTotal).toBe(5_335);

    // 미리보기 뒤 주문 B의 표가 사라졌다(환불·무효 등). 확정 대상은 주문 A 하나다
    await db.pool.query('delete from order_item where order_id = $1', [ORDER_B]);
    const requestId = randomUUID();
    const started = await start(svc, requestId);

    const rows = await compensationRows();
    expect(rows.map((r) => ({ orderId: r.order_id, baseAmount: r.base_amount, amount: r.amount }))).toEqual([{ orderId: ORDER_A, baseAmount: 20_002, amount: 2_001 }]);
    const saved = (await db.pool.query<{ compensation_targets: number; compensation_total: number }>('select compensation_targets, compensation_total from event_cancellation_request where id = $1', [requestId])).rows[0]!;
    expect(saved).toEqual({ compensation_targets: 1, compensation_total: 2_001 });
    expect(started.compensationTargets).toBe(1);
    expect(started.compensationTotal).toBe(2_001);
  });

  test('R-T46 ②_같은_요청을_다시_확정해도_배상_행이_늘지_않고_저장한_금액_그대로다', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [33_333]);
    await seedOrder(ORDER_B, ACCOUNT_B, [47_500]);
    const { svc } = service();
    const requestId = randomUUID();
    await start(svc, requestId);
    const before = await compensationRows();
    await start(svc, requestId);
    expect(await compensationRows()).toEqual(before);
    expect(await count('compensation')).toBe(2);
  });

  test('R-T46 ②_확정_트랜잭션에서_배상_행_쓰기가_실패하면_요청과_항목도_0행이다 [ASVS v5.0.0-2.3.3]', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [33_333]);
    const store = new DrizzleEventRefundStore(db, clock);
    const requestId = randomUUID();
    const request: EventCancellationRequest = {
      requestId,
      eventId: EVENT,
      kind: 'CANCEL',
      status: 'RUNNING',
      fault: 'ORGANIZER',
      targetOrders: 1,
      refundTotal: 33_333,
      compensationTargets: 1,
      compensationTotal: 3_334,
      progress: { total: 0, done: 0, failed: 0, notApplied: 0, perPg: [] },
      ruledBy: 'commander-1',
      confirmedBy: 'operator-2',
      createdAtMs: NOW,
      updatedAtMs: NOW,
    };
    // 배상 행의 account_id가 UUID가 아니라 마지막 INSERT가 실패한다. 요청·항목은 이미 같은 트랜잭션에 들어갔으므로 함께 되돌아가야 한다
    await expect(
      store.create(request, [], [], {
        compensations: [
          {
            id: randomUUID(),
            eventCancellationRequestId: requestId,
            orderId: ORDER_A,
            eventId: EVENT,
            accountId: 'not-a-uuid',
            baseAmount: 33_333,
            amount: 3_334,
            createdAtMs: NOW,
            updatedAtMs: NOW,
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await count('event_cancellation_request')).toBe(0);
    expect(await count('event_refund_item')).toBe(0);
    expect(await count('compensation')).toBe(0);
  });

  test('R-T46 ②_(request_id, order_id)_유일_인덱스가_있다 [ASVS v5.0.0-2.3.4]', async () => {
    const idx = (await db.pool.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'compensation' and indexname = 'compensation_request_order_key'")).rows[0];
    expect(idx?.indexdef).toContain('UNIQUE INDEX');
    expect(idx?.indexdef).toContain('event_cancellation_request_id');
    expect(idx?.indexdef).toContain('order_id');
  });
});

// ---- F-07-8 시험 담당(2026-11-23): R-T46 ④ 확정 뒤에 결제가 끝난 주문의 배상 행(BAT-425 RV-18, transfer-refund §5 '확정 뒤에 결제가 끝난 주문의 배상 행') ----
// 쓸어 담기가 늦게 끝난 주문을 항목에 더할 때 그 주문의 compensation 한 행(ACCOUNT_PENDING·4,750원)을 항목과 같은 트랜잭션에 쓴다.
// 같은 트랜잭션은 배상 행 INSERT를 실패시키는 트리거로 본다: 실패하면 그 주문의 항목도 0행이어야 한다(배상 행만 따로 빠지지 않는다).
describe('R-T46 ④ 쓸어 담기의 배상 행 [실제 PostgreSQL]', () => {
  const ORDER_LATE = '0193c425-0000-7000-8000-0000000000f1';
  const ACCOUNT_LATE = '0193c425-0000-7000-8000-000000000013';
  /** 한 트랜잭션에서 SQL 몇 줄(주문 상태 이력 지연 제약 때문에 주문·이력을 함께 쓴다) */
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
  /** 확정 때 아직 끝나지 않은(RESERVED) 47,500원 표 하나인 주문. 표는 발권 전이다 */
  const seedOpenLate = () =>
    inTx([
      [
        `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
         values ($1, $2, $3, 'RESERVED', 47500, 1, $4, 'v1', 'PICK', $5, $6, $7)`,
        [ORDER_LATE, ACCOUNT_LATE, EVENT, `idem-${ORDER_LATE}`, new Date(NOW - 60_000), randomUUID(), randomUUID()],
      ],
      ["insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'RESERVED', 'T1', 'test', $2)", [ORDER_LATE, new Date(NOW - 60_000)]],
      ["insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id) values ($1, 1, $2, 'R', 'A', 47500, null)", [ORDER_LATE, randomUUID()]],
    ]);
  /** 확정 뒤에 결제를 마치고 발권된 것처럼 바꾼다 */
  const confirmLate = () =>
    inTx([
      ["update purchase_order set status = 'CONFIRMED', event_seq = 2 where id = $1", [ORDER_LATE]],
      ["insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 2, 'RESERVED', 'CONFIRMED', 'T18', 'test', $2)", [ORDER_LATE, new Date(NOW - 30_000)]],
      ['update order_item set ticket_id = $2 where order_id = $1', [ORDER_LATE, randomUUID()]],
      ["insert into payment_attempt (id, order_id, pg, status, created_at) values ($1, $2, 'TOSS', 'ACCEPTED', $3)", [randomUUID(), ORDER_LATE, new Date(NOW - 30_000)]],
    ]);
  const sweeping = () => {
    const store = new DrizzleEventRefundStore(db, clock);
    return new EventRefundService({
      store,
      targets: new DrizzleEventRefundTargets(db, configs),
      canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
      items: store,
      openOrders: new DrizzleEventOpenOrders(db),
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
      concurrency: 2,
    });
  };
  const lateItems = async (requestId: string) => count('event_refund_item', `where request_id = '${requestId}' and order_id = '${ORDER_LATE}'`);

  test('R-T46 ④_확정_뒤_결제가_끝난_47,500원_주문을_쓸어_담으면_배상_행_한_행(ACCOUNT_PENDING·4,750원)이고_두_번째_쓸어_담기는_0행이다', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [33_333, 33_333]);
    await seedOpenLate();
    const svc = sweeping();
    const requestId = randomUUID();
    expect((await start(svc, requestId)).status).toBe('RUNNING');
    expect((await compensationRows()).map((r) => [r.order_id, r.amount])).toEqual([[ORDER_A, 6_667]]);
    await confirmLate();
    await svc.runDue();
    expect(await lateItems(requestId)).toBe(1);
    const rows = await compensationRows();
    expect(rows.map((r) => ({ orderId: r.order_id, baseAmount: r.base_amount, amount: r.amount, status: r.status, accountLast4: r.account_last4, receivableId: r.receivable_id }))).toEqual([
      { orderId: ORDER_A, baseAmount: 66_666, amount: 6_667, status: 'ACCOUNT_PENDING', accountLast4: null, receivableId: null },
      { orderId: ORDER_LATE, baseAmount: 47_500, amount: 4_750, status: 'ACCOUNT_PENDING', accountLast4: null, receivableId: null },
    ]);
    await svc.runDue();
    expect(await count('compensation')).toBe(2);
  });

  test('R-T46 ④_FORCE_MAJEURE_요청의_쓸어_담기는_배상_행_0행이다', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [33_333]);
    await seedOpenLate();
    const svc = sweeping();
    const requestId = randomUUID();
    await svc.start({ eventId: EVENT, requestId, kind: 'CANCEL', fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });
    await confirmLate();
    await svc.runDue();
    expect(await lateItems(requestId)).toBe(1);
    expect(await count('compensation')).toBe(0);
  });

  test('R-T46 ④_쓸어_담기에서_배상_행_쓰기가_실패하면_그_주문의_항목도_0행이다 [ASVS v5.0.0-2.3.3]', async () => {
    await seedOrder(ORDER_A, ACCOUNT_A, [33_333]);
    await seedOpenLate();
    const svc = sweeping();
    const requestId = randomUUID();
    await start(svc, requestId);
    await confirmLate();
    // 시퀀스는 트랜잭션과 무관하게 늘어나므로, 되돌려진 뒤에도 트리거가 실제로 불렸는지(끊는 자리에 닿았는지) 남는다
    await db.pool.query('create sequence if not exists f078_late_compensation_hits');
    await db.pool.query(
      `create or replace function f078_fail_late_compensation() returns trigger language plpgsql as $f$ begin if new.order_id = '${ORDER_LATE}'::uuid then perform nextval('f078_late_compensation_hits'); raise exception 'f078 compensation insert failed'; end if; return new; end $f$`,
    );
    await db.pool.query('create trigger f078_fail_late_compensation before insert on compensation for each row execute function f078_fail_late_compensation()');
    try {
      await svc.runDue().catch(() => undefined);
      expect(await lateItems(requestId)).toBe(0);
      expect(await count('compensation', `where order_id = '${ORDER_LATE}'`)).toBe(0);
    } finally {
      await db.pool.query('drop trigger if exists f078_fail_late_compensation on compensation');
      await db.pool.query('drop function if exists f078_fail_late_compensation()');
    }
    // 끊는 자리가 실제로 닿았다(쓸어 담기가 그 주문의 배상 행 쓰기를 시도했다)
    expect((await db.pool.query<{ is_called: boolean }>('select is_called from f078_late_compensation_hits')).rows[0]!.is_called).toBe(true);
    // 트리거를 걷은 뒤 다음 쓸어 담기가 항목·배상 행을 함께 만든다
    await svc.runDue();
    expect(await lateItems(requestId)).toBe(1);
    expect(await count('compensation', `where order_id = '${ORDER_LATE}'`)).toBe(1);
  });
});
