// 지연 환급 계좌 다시 받기의 실제 PostgreSQL 재생·재시작 시험(BAT-425 RV-24·RV-25, ADR-0316 결정 4, openapi createCancellationAccount).
// 정본: docs/features/payment.md §6 '계좌 대기', docs/features/transfer-refund.md §3.1 '지연 환급 계좌를 다시 받는 작업',
// docs/api/openapi.yaml /v1/cancellations/{cancellationId}/account, docs/data.md order_cancellation·order_idempotency.
//
// - 상태 전이(REFUNDED) 커밋과 답 저장(refund_account_answer)은 다른 쓰기다. 그 사이 프로세스가 끊긴 모양(답만 비어 있음)에서
//   새 RequestRefundAccount 인스턴스(새 프로세스)가 같은 키를 다시 보내도 202·같은 답이어야 한다(RV-24).
// - 같은 키의 답 재생은 저장한 requestHash와 현재 지문을 견줘 다르면 422 idempotency-key-reused다(RV-24).
// - order_idempotency·refund_account_idem_key·saveAnswer를 지나는 실제 PostgreSQL 경로를 본다(RV-25).
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DrizzleOrderStore } from '../src/modules/booking/index.js';
import { MemorySeatMap } from '../src/modules/inventory/index.js';
import { DrizzleCancellationOrders, DrizzleCancellationWrites, RequestRefundAccount, type PaymentCancellations } from '../src/modules/refund/index.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
const EVENT = '0193d425-0000-7000-8000-0000000000e1';
const ORDER = '0193d425-0000-7000-8000-0000000000a1';
const ACCOUNT = '0193d425-0000-7000-8000-000000000011';
const TICKET = '0193d425-0000-7000-8000-0000000000d1';
const SEAT = '0193d425-0000-7000-8000-0000000000f1';
const REFUND_ACCOUNT = { bankCode: '88', accountNumber: '110-987-654321', holderName: '김환불' };
const REFUND_AMOUNT = 30_000;

let pgc: PostgresContainer | undefined;
let db: Database;
let seatMap: MemorySeatMap;
const clock = fakeClock({ now: NOW });
const paymentCalls: { cancellationId: string; refundAttempt: number; hasAccount: boolean }[] = [];
const payments: PaymentCancellations = {
  cancel: async (q) => {
    paymentCalls.push({ cancellationId: q.cancellationId, refundAttempt: q.refundAttempt ?? 0, hasAccount: q.refundAccount !== undefined });
    return 'CANCELLED';
  },
};

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePurchase(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'refund-account-reentry-it' });
  await ensureOutboxPartitions(db, clock);
  seatMap = new MemorySeatMap();
  seatMap.put(
    {
      eventId: EVENT,
      layoutVersion: 'v1',
      seatCount: 1,
      perAccountLimit: 1,
      saleEndsAtMs: NOW + 7 * DAY,
      entryOpensAtMs: NOW + 6 * DAY,
      tierPrices: { R: 33_333 },
    },
    [{ seatId: SEAT, index: 0, sectionId: 'A', sectionIndex: 0, seatOffset: 0, tierId: 'R' }],
  );
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await db.pool.query('truncate order_idempotency, order_cancellation, order_item, order_event, purchase_order cascade');
  paymentCalls.length = 0;
});

/** 주문·표·이력(T1)을 심는다. 지연 제약 order_status_has_event 때문에 주문과 이력을 한 트랜잭션에 쓴다 */
async function seedOrder(): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'CONFIRMED', 33333, 1, $4, 'v1', 'PICK', $5, $6, $7)`,
      [ORDER, ACCOUNT, EVENT, `idem-${ORDER}`, new Date(NOW - 12 * DAY), randomUUID(), randomUUID()],
    );
    await client.query("insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'CONFIRMED', 'T1', 'test', $2)", [ORDER, new Date(NOW - 12 * DAY)]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await db.pool.query(
    `insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price, ticket_id)
     values ($1, 1, $2, 'R', 'A', 33333, $3)`,
    [ORDER, SEAT, TICKET],
  );
}

/** 계좌 대기(REFUND_PENDING·refund_account_required_at 있음) 취소 하나를 심는다 */
async function seedCancellation(cancellationId = randomUUID()): Promise<string> {
  await db.pool.query(
    `insert into order_cancellation (id, order_id, ticket_id, reason, days_before, within_24h, deduction_bp, deduction_amount, refund_amount, status, created_at, status_changed_at, refund_account_required_at, refund_attempts, refund_attempt)
     values ($1, $2, $3, 'USER', 7, false, 1000, 3333, $4, 'REFUND_PENDING', $5, $5, $5, 0, 0)`,
    [cancellationId, ORDER, TICKET, REFUND_AMOUNT, new Date(NOW)],
  );
  return cancellationId;
}

const service = (): RequestRefundAccount =>
  new RequestRefundAccount({
    orders: new DrizzleCancellationOrders(db, seatMap),
    writes: new DrizzleCancellationWrites(db, new DrizzleOrderStore({ clock })),
    payments,
    nowMs: () => NOW,
  });

const hashOf = (body: string): Uint8Array => createHash('sha256').update(body).digest();

const rowOf = async (cancellationId: string) =>
  (
    await db.pool.query<{ status: string; refund_attempt: number; refund_account_idem_key: string | null; refund_account_answer: string | null; next_refund_at: Date | null }>(
      'select status, refund_attempt, refund_account_idem_key, refund_account_answer, next_refund_at from order_cancellation where id = $1',
      [cancellationId],
    )
  ).rows[0]!;

const idempotencyRows = async () =>
  (await db.pool.query<{ operation: string; idempotency_key: string; request_hash: Buffer; result_ref: string }>('select operation, idempotency_key, request_hash, result_ref from order_idempotency')).rows;

describe('R-T42 ④·RV-24 계좌 다시 받기의 재시작 재생 [실제 PostgreSQL]', () => {
  test('R-T42 ④_RV24_상태_전이_뒤_답_저장_전에_끊긴_모양에서도_새_인스턴스의_같은_키는_202·같은_답이고_시도·payment는_그대로다', async () => {
    await seedOrder();
    const cancellationId = await seedCancellation();
    const key = randomUUID();
    const requestHash = hashOf('{"bankCode":"88","accountNumber":"110-987-654321","holderName":"김환불"}');

    const first = await service().run({ accountId: ACCOUNT, cancellationId, account: REFUND_ACCOUNT, reauthToken: undefined, idempotencyKey: key, requestHash });
    expect(first).toEqual({ cancellationId, status: 'REFUNDED', refundAmount: REFUND_AMOUNT });
    expect(paymentCalls).toEqual([{ cancellationId, refundAttempt: 1, hasAccount: true }]);

    // 상태 전이 커밋 직후 프로세스가 끊겨 답 저장(saveAnswer)만 빠진 모양을 만든다. 시도 올리기·order_idempotency·payment_cancel은 이미 커밋됐다
    await db.pool.query('update order_cancellation set refund_account_answer = null where id = $1', [cancellationId]);
    expect(await rowOf(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempt: 1, refund_account_idem_key: key, refund_account_answer: null });
    expect(await idempotencyRows()).toHaveLength(1);

    // 새 프로세스(새 인스턴스)의 같은 키·같은 지문: 첫 202와 같은 답이어야 한다
    const restarted = await service().run({ accountId: ACCOUNT, cancellationId, account: REFUND_ACCOUNT, reauthToken: undefined, idempotencyKey: key, requestHash });
    expect(restarted).toEqual(first);
    expect(paymentCalls).toHaveLength(1);
    expect(await rowOf(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempt: 1, refund_account_idem_key: key });
  });

  // RV-24(중간): #replayOf가 저장한 requestHash를 보지 않으면 같은 키에 다른 본문을 보내도 422가 아니라 첫 답을 재생한다.
  // 플랫폼 멱등 규칙(같은 키·다른 지문 = 422 idempotency-key-reused)을 실제 order_idempotency 행으로 고정한다.
  test('R-T42 ④_RV24_같은_키에_다른_본문(다른_requestHash)은_422_idempotency-key-reused이고_새_시도·payment가_0이다', async () => {
    await seedOrder();
    const cancellationId = await seedCancellation();
    const key = randomUUID();
    const firstHash = hashOf('{"bankCode":"88","accountNumber":"110-987-654321","holderName":"김환불"}');
    await service().run({ accountId: ACCOUNT, cancellationId, account: REFUND_ACCOUNT, reauthToken: undefined, idempotencyKey: key, requestHash: firstHash });
    expect(paymentCalls).toHaveLength(1);
    expect(await rowOf(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempt: 1 });

    const otherHash = hashOf('{"bankCode":"88","accountNumber":"110-987-654322","holderName":"김환불"}');
    await expect(service().run({ accountId: ACCOUNT, cancellationId, account: { ...REFUND_ACCOUNT, accountNumber: '110-987-654322' }, reauthToken: undefined, idempotencyKey: key, requestHash: otherHash })).rejects.toMatchObject({
      status: 422,
      slug: 'idempotency-key-reused',
    });
    expect(paymentCalls).toHaveLength(1);
    expect(await rowOf(cancellationId)).toMatchObject({ status: 'REFUNDED', refund_attempt: 1 });
  });
});
