// 정산·지급·KYC 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-610 잔여, R-574·R-588).
// 0015·0016 적용·재적용, 실제 payment 원장 계산, 정산서·이의·KYC·지급 묶음·재시도·정산 계좌·상품 정산·미수금 상계를 본다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import {
  DrizzleSettlementPaymentSource,
  DrizzleSettlementStore,
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  Settlements,
  UnavailableTossPayoutGateway,
  type ProductSettlementItem,
} from '../src/modules/settlement/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const A = randomUUID();
const B = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();

let pgc: PostgresContainer;
let db: Database;
let clock: ReturnType<typeof fakeClock>;
let store: DrizzleSettlementStore;
let settlements: Settlements;
const productRows: ProductSettlementItem[] = [];

const statementRow = async (o: { promoterId: string; eventId: string; pg?: 'TOSS' | 'PORTONE'; pgStore?: 'STANDARD' | 'ESCROW'; payoutDate: string; payoutAmount: number; status?: string }) => {
  const id = randomUUID();
  await db.pool.query(
    `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, payout_amount, status, payout_date, created_at, updated_at)
     values ($1, $2, 'EVENT', $3, $4, $5, $6, 0, 0, 0, $6, $7, $8, $9, $9)`,
    [id, o.promoterId, o.eventId, o.pg ?? 'TOSS', o.pgStore ?? 'STANDARD', o.payoutAmount, o.status ?? 'CONFIRMED', o.payoutDate, NOW],
  );
  return id;
};

const productStatementRow = async (promoterId: string, status = 'NOTIFIED') => {
  const id = randomUUID();
  await db.pool.query(
    `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, period_start, period_end, gross_amount, refund_amount, commission_amount, commission_vat, payout_amount, status, created_at, updated_at)
     values ($1, $2, 'PRODUCT', null, 'TOSS', 'STANDARD', '2026-11-09', '2026-11-15', 10000, 0, 1000, 100, 8900, $3, $4, $4)`,
    [id, promoterId, status, NOW],
  );
  return id;
};

const paymentRow = async (o: { id: string; amount: number; cancelled: number; status: string; failure?: string | null; pg?: 'TOSS' | 'PORTONE' }) => {
  await db.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, cancelled_amount, status, failure_category, idempotency_key, authenticated_at, status_changed_at)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [o.id, randomUUID(), EVENT, randomUUID(), o.pg ?? 'TOSS', `ref-${o.id}`, o.amount, o.cancelled, o.status, o.failure ?? null, `idem-${o.id}`, NOW],
  );
};

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  await migratePayment(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-settlement-it' });
  clock = fakeClock({ now: NOW.getTime() });
  store = new DrizzleSettlementStore(db);
  settlements = new Settlements({
    store,
    payments: new DrizzleSettlementPaymentSource(db),
    products: { listProductItems: async (from: string, to: string) => productRows.filter((r) => r.basisDate >= from && r.basisDate <= to) },
    gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
    reauth: new MemoryReauthVerifier(),
    clock,
  });
  await settlements.recordKyc(A, 'VERIFIED');
  await paymentRow({ id: randomUUID(), amount: 30_000_000, cancelled: 0, status: 'APPROVED' });
  await paymentRow({ id: randomUUID(), amount: 10_000_000, cancelled: 2_000_000, status: 'PARTIAL_CANCELED' });
  await paymentRow({ id: randomUUID(), amount: 5_000_000, cancelled: 5_000_000, status: 'CANCELED' });
  await paymentRow({ id: randomUUID(), amount: 1_000_000, cancelled: 1_000_000, status: 'CANCELED', failure: 'DEPOSIT_CANCELED' });
  await paymentRow({ id: randomUUID(), amount: 10_000_000, cancelled: 0, status: 'APPROVED', pg: 'PORTONE' });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

describe('정산·지급·KYC PostgreSQL [R-574]', () => {
  test('0015가 표를 만들고 재적용해도 같다', async () => {
    const tables = await db.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('settlement_statement','statement_source','statement_dispute','payout_batch','payout','seller_kyc','payout_account') order by table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual(['payout', 'payout_account', 'payout_batch', 'seller_kyc', 'settlement_statement', 'statement_dispute', 'statement_source']);
    await expect(migratePayment(pgc.url)).resolves.toBeUndefined();
  });

  test('실제 payment 원장으로 판매 대금·환급·수수료·부가세·지급액을 계산한다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({
      grossAmount: 45_000_000,
      refundAmount: 7_000_000,
      commissionAmount: 3_800_000,
      commissionVat: 380_000,
      payoutAmount: 33_820_000,
      status: 'NOTIFIED',
    });
    const sources = await db.pool.query('select kind, count(*)::int as n from statement_source where statement_id = $1 group by kind order by kind', [s.statementId]);
    expect(sources.rows).toEqual([
      { kind: 'GROSS', n: 3 },
      { kind: 'REFUND', n: 2 },
    ]);
    const again = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(again.statementId).toBe(s.statementId);
    const count = await db.pool.query('select count(*)::int as n from settlement_statement where promoter_id = $1 and event_id = $2', [A, EVENT]);
    expect(count.rows[0].n).toBe(1);
  });

  test('이의는 OTHER 설명을 요구하고, 기간이 지나면 409다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await expect(settlements.dispute(A, ACCOUNT, s.statementId, { reasonCode: 'OTHER' })).rejects.toMatchObject({ status: 422 });
    await settlements.dispute(A, ACCOUNT, s.statementId, { reasonCode: 'OTHER', detail: '금액 근거를 확인해 주세요' });
    expect((await store.findStatementById(s.statementId))?.status).toBe('DISPUTED');
    const other = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(other.statementId))!, status: 'NOTIFIED', disputeDueAt: new Date(NOW.getTime() - 1) });
    await expect(settlements.dispute(A, ACCOUNT, other.statementId, { reasonCode: 'GROSS_AMOUNT' })).rejects.toMatchObject({ status: 409 });
  });

  test('KYC 전에는 HELD/KYC이고 지급 묶음은 409 payout-kyc-required다', async () => {
    const s = await settlements.calculateEvent({ promoterId: B, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: ACCOUNT })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
  });

  test('지급 묶음 승인→수기 포트원 제출, 실패 건은 새 refPayoutId로 재시도한다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: s.payoutDate!, portoneBalance: { amount: s.payoutAmount, observedAt: NOW.toISOString() }, actor: ACCOUNT });
    expect(batch.status).toBe('PENDING_APPROVAL');
    expect((await settlements.approveBatch(batch.batchId, randomUUID())).status).toBe('APPROVED');
    expect((await settlements.executeBatch(batch.batchId)).status).toBe('SUBMITTED');
    const payouts = await store.listPayouts(batch.batchId);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.refPayoutId).toBe(`${s.statementId}-1`);
    await store.savePayout({ ...payouts[0]!, status: 'FAILED', errorCode: 'PG_ERROR' });
    const retried = await settlements.retryPayout(payouts[0]!.payoutId);
    expect(retried).toMatchObject({ seq: 2, refPayoutId: `${s.statementId}-2`, status: 'REQUESTED' });
    expect((await store.listPayouts(batch.batchId)).map((p) => p.refPayoutId)).toEqual([`${s.statementId}-1`, `${s.statementId}-2`]);
  });

  test('정산 계좌는 끝 4자리만 저장하고 3영업일 보류·If-Match·재인증을 건다', async () => {
    const body = { bankCode: '004', accountNumber: '98765432101234', holderName: '주식회사 에이' };
    await expect(settlements.putPayoutAccount(A, 'sid', body, '"0"', undefined)).rejects.toMatchObject({ status: 403 });
    const saved = await settlements.putPayoutAccount(A, 'sid', body, '"0"', 'test-reauth');
    expect(saved).toMatchObject({ bankCode: '004', payoutAccountLast4: '1234', version: 1 });
    expect(saved.holdUntil).toBe('2026-11-18T00:00:00.000Z');
    const row = await db.pool.query('select bank_code, account_last4, holder_verified from payout_account where promoter_id = $1', [A]);
    expect(row.rows[0]).toEqual({ bank_code: '004', account_last4: '1234', holder_verified: false });
    const all = await db.pool.query('select * from payout_account where promoter_id = $1', [A]);
    expect(JSON.stringify(all.rows[0])).not.toContain('98765432101234');
    await expect(settlements.putPayoutAccount(A, 'sid', body, '"0"', 'test-reauth')).rejects.toMatchObject({ status: 412 });
  });

  test('0016이 partner_receivable·receivable_move를 만들고 재적용해도 같다', async () => {
    const tables = await db.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('partner_receivable','receivable_move') order by table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual(['partner_receivable', 'receivable_move']);
    await expect(migratePayment(pgc.url)).resolves.toBeUndefined();
  });

  test('상품 정산서는 주문 항목 원천으로 계산되고 상품 목록에 나온다', async () => {
    productRows.push(
      { itemId: randomUUID(), orderId: randomUUID(), promoterId: A, eventId: null, pg: 'TOSS', pgStore: 'STANDARD', productId: randomUUID(), productName: '응원봉', quantity: 2, grossAmount: 30_000, refundedAmount: 0, commissionRateBp: 1000, basisDate: '2026-11-09', returnStatus: 'DELIVERED', eventEndsAt: null },
      { itemId: randomUUID(), orderId: randomUUID(), promoterId: A, eventId: null, pg: 'TOSS', pgStore: 'STANDARD', productId: randomUUID(), productName: '포스터', quantity: 1, grossAmount: 20_000, refundedAmount: 2_000, commissionRateBp: 500, basisDate: '2026-11-10', returnStatus: 'DELIVERED', eventEndsAt: null },
    );
    const out = await settlements.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    expect(out.created).toBe(1);
    expect(out.items[0]).toMatchObject({ kind: 'PRODUCT', grossAmount: 50_000, refundAmount: 2_000, commissionAmount: 3_900, commissionVat: 390, payoutAmount: 43_710, status: 'NOTIFIED', periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    expect((await settlements.listProduct(A, { limit: 10 })).items.some((s) => s.kind === 'PRODUCT')).toBe(true);
    expect((await settlements.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' })).created).toBe(0);
  });

  test('0017 부분 유일 인덱스가 같은 회차·상품 정산서 중복을 23505로 막고 SUPERSEDED는 허용한다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await statementRow({ promoterId, eventId, payoutDate: '2026-11-24', payoutAmount: 1_000 });
    await expect(statementRow({ promoterId, eventId, payoutDate: '2026-11-24', payoutAmount: 1_000 })).rejects.toMatchObject({ code: '23505' });
    await statementRow({ promoterId, eventId, payoutDate: '2026-11-24', payoutAmount: 1_000, status: 'SUPERSEDED' });
    const active = await db.pool.query("select count(*)::int as n from settlement_statement where promoter_id = $1 and event_id = $2 and status <> 'SUPERSEDED'", [promoterId, eventId]);
    expect(active.rows[0].n).toBe(1);

    const productPromoter = randomUUID();
    await productStatementRow(productPromoter);
    await expect(productStatementRow(productPromoter)).rejects.toMatchObject({ code: '23505' });
    await productStatementRow(productPromoter, 'SUPERSEDED');
    const products = await db.pool.query("select count(*)::int as n from settlement_statement where promoter_id = $1 and kind = 'PRODUCT' and status <> 'SUPERSEDED'", [productPromoter]);
    expect(products.rows[0].n).toBe(1);

    const indexes = await db.pool.query("select indexname from pg_indexes where tablename = 'settlement_statement' and indexname in ('settlement_statement_event_key','settlement_statement_product_key','settlement_statement_batch_idx') order by indexname");
    expect(indexes.rows.map((r) => r.indexname)).toEqual(['settlement_statement_batch_idx', 'settlement_statement_event_key', 'settlement_statement_product_key']);
    const column = await db.pool.query("select column_name from information_schema.columns where table_name = 'settlement_statement' and column_name = 'payout_batch_id'");
    expect(column.rows).toHaveLength(1);
  });

  test('CONS-02 지급 묶음은 승인 시점 정산서를 붙이고 실행은 그 정산서만 지급한다', async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();
    await settlements.recordKyc(p1, 'VERIFIED');
    await settlements.recordKyc(p2, 'VERIFIED');
    const s1 = await statementRow({ promoterId: p1, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-24', payoutAmount: 100_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: '2026-11-24', portoneBalance: { amount: 100_000, observedAt: NOW.toISOString() }, actor: ACCOUNT });
    expect(batch).toMatchObject({ totalAmount: 100_000, statementCount: 1 });
    const bound = await db.pool.query('select status, payout_batch_id from settlement_statement where id = $1', [s1]);
    expect(bound.rows[0]).toEqual({ status: 'SCHEDULED', payout_batch_id: batch.batchId });
    expect(await store.listConfirmed('PORTONE', 'STANDARD', '2026-11-24')).toHaveLength(0);

    const s2 = await statementRow({ promoterId: p2, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-24', payoutAmount: 200_000 });
    await settlements.approveBatch(batch.batchId, randomUUID());
    expect((await settlements.executeBatch(batch.batchId)).status).toBe('SUBMITTED');
    expect((await store.listPayouts(batch.batchId)).map((p) => p.statementId)).toEqual([s1]);
    const after = await db.pool.query('select status, payout_batch_id from settlement_statement where id = $1', [s2]);
    expect(after.rows[0]).toEqual({ status: 'CONFIRMED', payout_batch_id: null });
  });

  test('CONS-02 묶인 정산서 합계가 승인 금액과 다르면 실행을 409 payout-batch-amount-mismatch로 멈춘다', async () => {
    const promoterId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    const statementId = await statementRow({ promoterId, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-25', payoutAmount: 200_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: '2026-11-25', portoneBalance: { amount: 200_000, observedAt: NOW.toISOString() }, actor: ACCOUNT });
    await settlements.approveBatch(batch.batchId, randomUUID());
    await db.pool.query('update settlement_statement set payout_amount = 199000 where id = $1', [statementId]);
    await expect(settlements.executeBatch(batch.batchId)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-amount-mismatch') });
    expect(await store.listPayouts(batch.batchId)).toHaveLength(0);
  });

  test('CONS-02 두 요청이 동시에 배치를 만들면 한쪽만 성공한다', async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();
    await settlements.recordKyc(p1, 'VERIFIED');
    await settlements.recordKyc(p2, 'VERIFIED');
    await statementRow({ promoterId: p1, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-26', payoutAmount: 100_000 });
    await statementRow({ promoterId: p2, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-26', payoutAmount: 200_000 });
    const input = { pg: 'PORTONE' as const, pgStore: 'STANDARD' as const, payoutDate: '2026-11-26', portoneBalance: { amount: 300_000, observedAt: NOW.toISOString() }, actor: ACCOUNT };
    const results = await Promise.allSettled([settlements.createPayoutBatch(input), settlements.createPayoutBatch(input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const batches = await db.pool.query("select id from payout_batch where pg = 'PORTONE' and pg_store = 'STANDARD' and payout_date = '2026-11-26'");
    expect(batches.rows).toHaveLength(1);
    const bound = await db.pool.query('select count(*)::int as n from settlement_statement where payout_batch_id = $1', [batches.rows[0].id]);
    expect(bound.rows[0].n).toBe(2);
  });

  test('M1-F1 배치 저장이 실패하면 상계·보류·정산서 갱신이 모두 롤백된다', async () => {
    const promoterId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    const statementId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-11-27', payoutAmount: 100_000 });
    const receivable = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 50_000 });
    const batchId = randomUUID();
    await db.pool.query(
      `insert into payout_batch (id, pg, pg_store, payout_date, total_amount, statement_count, status, created_at, updated_at)
       values ($1, 'TOSS', 'STANDARD', '2026-11-27', 0, 0, 'COMPLETED', $2, $2)`,
      [batchId, NOW],
    );
    await expect(
      store.createPayoutBatchAtomically({
        batch: { batchId, pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-27', totalAmount: 50_000, statementCount: 1, approvalId: null, portoneBulkPayoutId: null, pgBalanceKrw: null, pgBalanceSource: null, pgBalanceObservedAt: null, pgBalanceObservedBy: null, pgBalanceLedgerKrw: null, status: 'PENDING_APPROVAL', createdAt: NOW, updatedAt: NOW },
        statementIds: [statementId],
        statementUpdates: [{ statementId, status: 'CONFIRMED', holdReason: null, offsetAmount: 50_000, payoutAmount: 50_000, updatedAt: NOW }],
        receivableUpdates: [{ receivableId: receivable.receivableId, remaining: 0, status: 'CLOSED', updatedAt: NOW }],
        receivableMoves: [{ receivableId: receivable.receivableId, statementId, amount: 50_000, movedAt: NOW }],
      }),
    ).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-batch-exists') });
    const afterStatement = await db.pool.query('select offset_amount, payout_amount, payout_batch_id, status from settlement_statement where id = $1', [statementId]);
    expect(afterStatement.rows[0]).toEqual({ offset_amount: '0', payout_amount: '100000', payout_batch_id: null, status: 'CONFIRMED' });
    const afterReceivable = await db.pool.query('select remaining, status from partner_receivable where id = $1', [receivable.receivableId]);
    expect(afterReceivable.rows[0]).toEqual({ remaining: '50000', status: 'OPEN' });
    const moves = await db.pool.query('select count(*)::int as n from receivable_move where statement_id = $1', [statementId]);
    expect(moves.rows[0].n).toBe(0);
  });

  test('M1-F2 TOSS 배상금 미리 지급 미수금은 PORTONE 묶음에서도 상계되고 다른 결제사 환불 미수금은 남는다', async () => {
    const promoterId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await statementRow({ promoterId, eventId: randomUUID(), pg: 'PORTONE', payoutDate: '2026-11-28', payoutAmount: 100_000 });
    const compensation = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'COMPENSATION_ADVANCE', amount: 40_000 });
    const refund = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 30_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: '2026-11-28', portoneBalance: { amount: 100_000, observedAt: NOW.toISOString() }, actor: ACCOUNT });
    expect(batch.totalAmount).toBe(60_000);
    const comp = await db.pool.query('select remaining, status from partner_receivable where id = $1', [compensation.receivableId]);
    expect(comp.rows[0]).toEqual({ remaining: '0', status: 'CLOSED' });
    const other = await db.pool.query('select remaining, status from partner_receivable where id = $1', [refund.receivableId]);
    expect(other.rows[0]).toEqual({ remaining: '30000', status: 'OPEN' });
  });

  test('M1-F3 이의 기간이 끝난 NOTIFIED는 자동 확정하고 DISPUTED는 그대로 둔다', async () => {
    const promoterId = randomUUID();
    const dueId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-11-29', payoutAmount: 100_000 });
    const disputedId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-11-29', payoutAmount: 100_000 });
    await db.pool.query("update settlement_statement set status = 'NOTIFIED', dispute_due_at = '2026-11-13T00:00:00Z' where id = $1", [dueId]);
    await db.pool.query("update settlement_statement set status = 'DISPUTED', dispute_due_at = '2026-11-13T00:00:00Z' where id = $1", [disputedId]);
    await settlements.confirmDueStatements();
    const due = await db.pool.query('select status from settlement_statement where id = $1', [dueId]);
    expect(due.rows[0].status).toBe('CONFIRMED');
    const disputed = await db.pool.query('select status from settlement_statement where id = $1', [disputedId]);
    expect(disputed.rows[0].status).toBe('DISPUTED');
  });

  test('미수금은 같은 결제사의 지급 묶음에서 상계되고 이동 기록이 남는다', async () => {
    await db.pool.query("update payout_account set hold_until = '2026-11-01T00:00:00Z' where promoter_id = $1", [A]);
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED', payoutDate: '2026-11-20' });
    const r = await settlements.recordReceivable({ promoterId: A, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 445_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-20', actor: ACCOUNT });
    const after = await store.findStatementById(s.statementId);
    expect(after).toMatchObject({ offsetAmount: 445_000, payoutAmount: s.payoutAmount - 445_000 });
    expect(batch.totalAmount).toBe(s.payoutAmount - 445_000);
    const moves = await db.pool.query('select receivable_id, statement_id, amount from receivable_move where statement_id = $1', [s.statementId]);
    expect(moves.rows).toEqual([{ receivable_id: r.receivableId, statement_id: s.statementId, amount: '445000' }]);
    const left = await db.pool.query('select remaining, status from partner_receivable where id = $1', [r.receivableId]);
    expect(left.rows[0]).toEqual({ remaining: '0', status: 'CLOSED' });
  });
});
