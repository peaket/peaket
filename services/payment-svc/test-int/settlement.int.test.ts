// 정산·지급·KYC 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-610 잔여, R-574·R-588).
// 0015·0016 적용·재적용, 실제 payment 원장 계산, 정산서·이의·KYC·지급 묶음·재시도·정산 계좌·상품 정산·미수금 상계를 본다.
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import {
  calculateEventStatement,
  DrizzleSettlementPaymentSource,
  DrizzleSettlementStore,
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  payoutBatchView,
  Settlements,
  UnavailableTossPayoutGateway,
  type ProductSettlementItem,
} from '../src/modules/settlement/index.js';
import type { PayoutApprovalVerifier, SaleSuspensionSource, VerifiedPayoutApproval } from '../src/modules/settlement/domain/ports.js';
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
const approvalRows = new Map<string, VerifiedPayoutApproval>();
const approvals: PayoutApprovalVerifier = { verify: async (id) => approvalRows.get(id) };
const saleSuspensions: SaleSuspensionSource = { listSuspended: async () => new Set() };
const approveFor = (batch: ReturnType<typeof payoutBatchView>) => {
  const approvalId = randomUUID();
  approvalRows.set(approvalId, {
    approvalId,
    kind: 'PAYOUT_BATCH',
    targetRef: batch.batchId,
    batchId: batch.batchId,
    pg: batch.pg,
    pgStore: batch.pgStore,
    payoutDate: batch.payoutDate,
    currency: 'KRW',
    amount: batch.totalAmount,
    statementCount: batch.statementCount,
    status: 'EXECUTING',
    requiredApprovals: 2,
    requestedBy: randomUUID(),
    approvals: [randomUUID()],
    approvedAt: NOW.toISOString(),
  });
  return approvalId;
};

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

/** 결제 원장 한 행. 승인 시각(approved_at)은 기본으로 채운다. null이면 승인된 적 없는 결제다(정본 §4.1 '전액 취소된 결제', F-07-5 리뷰 RV-01) */
const paymentRow = async (o: { id: string; amount: number; cancelled: number; status: string; failure?: string | null; pg?: 'TOSS' | 'PORTONE'; pgStore?: 'STANDARD' | 'ESCROW'; eventId?: string; approvedAt?: Date | null }) => {
  await db.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_store, pg_payment_ref, amount, cancelled_amount, status, failure_category, idempotency_key, authenticated_at, status_changed_at, approved_at)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)`,
    [o.id, randomUUID(), o.eventId ?? EVENT, randomUUID(), o.pg ?? 'TOSS', o.pgStore ?? 'STANDARD', `ref-${o.id}`, o.amount, o.cancelled, o.status, o.failure ?? null, `idem-${o.id}`, NOW, o.approvedAt === undefined ? NOW : o.approvedAt],
  );
};

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  await migratePayment(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-settlement-it' });
  // F-07-5(ADR-0368 결정 1·2): 계산·전이가 같은 트랜잭션에 trade.settlements Outbox를 쓴다. 운영 migrate 스크립트처럼 파티션을 만든다
  await ensureOutboxPartitions(db, systemClock);
  clock = fakeClock({ now: NOW.getTime() });
  store = new DrizzleSettlementStore(db);
  settlements = new Settlements({
    store,
    payments: new DrizzleSettlementPaymentSource(db),
    products: { listProductItems: async (from: string, to: string) => productRows.filter((r) => r.basisDate >= from && r.basisDate <= to) },
    eventCommission: { rateBp: async () => 1000 },
    approvals,
    saleSuspensions,
    promoterContracts: { current: async () => ({ commissionRateBp: 1000, guaranteeRateBp: 1000, guaranteeKind: 'DEPOSIT' as const }) },
    gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
    reauth: new MemoryReauthVerifier(),
    clock,
  });
  await settlements.recordKyc(A, 'VERIFIED', { legalName: '주식회사 에이', representative: '김대표' });
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

  // F-07-5 리뷰 RV-01(시험 담당 2026-11-23): 승인 뒤 전액 취소(5,000,000원)도 판매 대금에 원금을 넣는다(정본 §4.1 '전액 취소된 결제').
  // 옛 기대(판매 4,000만·지급 2,937만)는 그 결제를 판매 대금에서 빼고 환급에도 넣어 두 번 뺐다. 입금 되돌림(DEPOSIT_CANCELED)은 그대로 뺀다.
  test('J-T1 실제 payment 원장으로 판매 대금·환급·수수료·부가세·지급액을 계산한다(승인 뒤 전액 취소는 판매 대금·환급 모두 원금)', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    // 판매 3,000만 + 1,000만 + 500만 = 4,500만, 환급 200만 + 500만 = 700만 → 수수료 380만·부가세 38만·지급 3,382만
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

  // F-07-5 시험 담당(2026-11-23): 정본 §4.2(ADR-0368 결정 1·11)로 계산 때는 KYC로 보류하지 않고 통지하며, 지급 묶음 때 HELD/KYC로 저장한 뒤 409다(J-T35 ⑨)
  test('KYC 전에도 계산 때는 NOTIFIED이고, 지급 묶음은 409 payout-kyc-required이며 정산서를 HELD/KYC로 저장한다', async () => {
    const s = await settlements.calculateEvent({ promoterId: B, eventId: EVENT, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({ status: 'NOTIFIED', holdReason: null });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    await expect(settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: ACCOUNT })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
    expect(await store.findStatementById(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC', payoutBatchId: null });
  });

  test('지급 묶음 승인→수기 포트원 제출, 실패 건은 새 refPayoutId로 재시도한다', async () => {
    const s = await settlements.calculateEvent({ promoterId: A, eventId: EVENT, pg: 'PORTONE', pgStore: 'STANDARD' });
    await store.saveStatement({ ...(await store.findStatementById(s.statementId))!, status: 'CONFIRMED' });
    const batch = await settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: s.payoutDate!, portoneBalance: { amount: s.payoutAmount, observedAt: NOW.toISOString() }, actor: ACCOUNT });
    expect(batch.status).toBe('PENDING_APPROVAL');
    expect((await settlements.approveBatch(batch.batchId, approveFor(batch))).status).toBe('APPROVED');
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
    expect(row.rows[0]).toEqual({ bank_code: '004', account_last4: '1234', holder_verified: true });
    const all = await db.pool.query('select * from payout_account where promoter_id = $1', [A]);
    expect(JSON.stringify(all.rows[0])).not.toContain('98765432101234');
    await expect(settlements.putPayoutAccount(A, 'sid', body, '"0"', 'test-reauth')).rejects.toMatchObject({ status: 412 });
  });

  // FIX-invariant-m3: 0028이 이동 기록 표를 정본 이름 receivable_movement로 바꾸고 옛 이름은 뷰로 남긴다(docs/data.md §4 '미수금 이동 기록 표 이름 맞추기').
  // information_schema.tables에는 뷰도 나오므로 종류(table_type)까지 본다
  test('0016이 partner_receivable·receivable_move를 만들고 재적용해도 같다', async () => {
    const tables = await db.pool.query(
      "select table_name, table_type from information_schema.tables where table_schema = 'public' and table_name in ('partner_receivable','receivable_move','receivable_movement') order by table_name",
    );
    expect(tables.rows).toEqual([
      { table_name: 'partner_receivable', table_type: 'BASE TABLE' },
      { table_name: 'receivable_move', table_type: 'VIEW' },
      { table_name: 'receivable_movement', table_type: 'BASE TABLE' },
    ]);
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
    await settlements.approveBatch(batch.batchId, approveFor(batch));
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
    await settlements.approveBatch(batch.batchId, approveFor(batch));
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

  test('J-T28 ① TOSS 배상금 미리 지급 미수금은 PORTONE 묶음에서도 상계되고 다른 결제사 환불 미수금은 남는다', async () => {
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

  test('A1-H2 STANDARD와 ESCROW 결제는 각 상점 정산서에 한 번씩만 잡힌다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await paymentRow({ id: randomUUID(), amount: 10_000_000, cancelled: 0, status: 'APPROVED', eventId, pgStore: 'STANDARD' });
    await paymentRow({ id: randomUUID(), amount: 7_000_000, cancelled: 0, status: 'APPROVED', eventId, pgStore: 'ESCROW' });
    const standard = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    const escrow = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'ESCROW' });
    expect(standard.grossAmount).toBe(10_000_000);
    expect(escrow.grossAmount).toBe(7_000_000);
  });

  // F-07-5 리뷰 RV-01: 승인 시각 있음·없음 두 행으로 나눈다(정본 §4.1 '전액 취소된 결제'). 0원도 계산 때는 통지한다(T6)
  test('J-T1 A1-H3 승인 뒤 전액 취소 10,000원은 판매 대금·환급 모두 10,000원(지급 0)이다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await paymentRow({ id: randomUUID(), amount: 10_000, cancelled: 0, status: 'CANCELED', eventId });
    const s = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({ grossAmount: 10_000, refundAmount: 10_000, commissionAmount: 0, commissionVat: 0, payoutAmount: 0, status: 'NOTIFIED' });
  });

  test('J-T1 A1-H3 승인된 적 없이 대사가 취소로 닫은 결제(approved_at 없음)는 판매 대금·환급·원본 목록 어디에도 없다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const neverApproved = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await paymentRow({ id: randomUUID(), amount: 2_000_000, cancelled: 0, status: 'APPROVED', eventId });
    await paymentRow({ id: neverApproved, amount: 10_000, cancelled: 0, status: 'CANCELED', eventId, approvedAt: null });
    const s = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({ grossAmount: 2_000_000, refundAmount: 0, commissionAmount: 200_000, commissionVat: 20_000, payoutAmount: 1_780_000 });
    expect((await db.pool.query('select payment_id from statement_source where statement_id = $1 and payment_id = $2', [s.statementId, neverApproved])).rows).toEqual([]);
  });

  test('J-T1 승인 2,800만 + 승인 뒤 전액 취소 200만(FRAUD 포함)은 실제 원장에서도 판매 대금 3,000만·환급 200만·지급 2,492만이고 원본 목록 합도 같다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await paymentRow({ id: randomUUID(), amount: 20_000_000, cancelled: 0, status: 'APPROVED', eventId });
    await paymentRow({ id: randomUUID(), amount: 8_000_000, cancelled: 0, status: 'APPROVED', eventId });
    await paymentRow({ id: randomUUID(), amount: 1_200_000, cancelled: 1_200_000, status: 'CANCELED', eventId });
    await paymentRow({ id: randomUUID(), amount: 800_000, cancelled: 800_000, status: 'CANCELED', eventId });
    await paymentRow({ id: randomUUID(), amount: 500_000, cancelled: 0, status: 'CANCELED', eventId, approvedAt: null });
    const s = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_000_000, commissionAmount: 2_800_000, commissionVat: 280_000, payoutAmount: 24_920_000 });
    const sums = await db.pool.query('select kind, sum(amount)::bigint::text as total from statement_source where statement_id = $1 group by kind order by kind', [s.statementId]);
    expect(sums.rows).toEqual([
      { kind: 'GROSS', total: '30000000' },
      { kind: 'REFUND', total: '2000000' },
    ]);
  });

  test('A1-H8 대사가 끝나지 않은 결제는 정산서에서 빠지고 이유가 excludedPayments에 남는다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const paymentId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await paymentRow({ id: paymentId, amount: 10_000, cancelled: 0, status: 'APPROVED', eventId });
    const runId = randomUUID();
    await db.pool.query(
      `insert into reconciliation_run (id, pg, recon_date, status, stage, owner, started_at)
       values ($1, 'TOSS', '2026-11-14', 'RUNNING', 'LISTING', 'test', $2)`,
      [runId, NOW],
    );
    await db.pool.query(
      `insert into reconciliation_diff (id, run_id, pg, order_ref, payment_ref, kind, state, created_at)
       values ($1, $2, 'TOSS', 'order', $3, 'LEDGER_APPROVED_NO_PG_RECORD', 'OPEN', $4)`,
      [randomUUID(), runId, `ref-${paymentId}`, NOW],
    );
    const s = await settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s.grossAmount).toBe(0);
    expect(s.excludedPayments).toEqual([`${paymentId}:RECONCILIATION_OPEN`]);
  });

  test('CONS-V01 동시에 같은 회차 정산서를 넣으면 하나만 남고 나머지는 false다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const recordOf = (statementId: string) =>
      calculateEventStatement({
        promoterId,
        eventId,
        pg: 'TOSS',
        pgStore: 'STANDARD',
        commissionRateBp: 1000,
        payments: [],
        kyc: undefined,
        account: undefined,
        now: NOW,
        statementId,
      }).record;
    const first = recordOf(randomUUID());
    const second = recordOf(randomUUID());
    const results = await Promise.all([store.insertStatement(first, []), store.insertStatement(second, [])]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const count = await db.pool.query("select count(*)::int as n from settlement_statement where promoter_id = $1 and event_id = $2 and status <> 'SUPERSEDED'", [promoterId, eventId]);
    expect(count.rows[0].n).toBe(1);
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

  test('J-T31 승인 감사 행과 payout_batch.approval_id 부분 유일 인덱스가 재사용을 막는다', async () => {
    const promoterId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    const statementId = await statementRow({ promoterId, eventId: randomUUID(), pg: 'TOSS', payoutDate: '2026-11-30', payoutAmount: 100_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-11-30', actor: ACCOUNT });
    const approvalId = approveFor(batch);
    await settlements.approveBatch(batch.batchId, approvalId);
    const audit = await db.pool.query('select batch_id, approval_id, event, requester_id, approver_id, amount, currency from payout_batch_audit where batch_id = $1', [batch.batchId]);
    expect(audit.rows).toEqual([
      {
        batch_id: batch.batchId,
        approval_id: approvalId,
        event: 'APPROVED',
        requester_id: approvalRows.get(approvalId)!.requestedBy,
        approver_id: approvalRows.get(approvalId)!.approvals[0],
        amount: '100000',
        currency: 'KRW',
      },
    ]);
    expect(statementId).toBeTruthy();
    await expect(
      db.pool.query(
        `insert into payout_batch (id, pg, pg_store, payout_date, total_amount, statement_count, approval_id, status, created_at, updated_at)
         values ($1, 'TOSS', 'ESCROW', '2026-11-30', 0, 0, $2, 'PENDING_APPROVAL', $3, $3)`,
        [randomUUID(), approvalId, NOW],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  test('J-T33 ④ 보증 충당은 미수금 이동·남은 금액·상태를 한 트랜잭션에 쓴다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-2.3.4]', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    const statementId = randomUUID();
    await db.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, payout_amount, status, payout_date, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'TOSS', 'STANDARD', 100000000, 0, 0, 0, 100000000, 'PAID', '2026-10-01', $4, $4)`,
      [statementId, promoterId, eventId, NOW],
    );
    const receivableId = randomUUID();
    await db.pool.query(
      `insert into partner_receivable (id, promoter_id, pg, cause, event_id, amount, remaining, status, created_at, updated_at)
       values ($1, $2, 'TOSS', 'REFUND_AFTER_PAYOUT', $3, 7000000, 7000000, 'OPEN', $4, $4)`,
      [receivableId, promoterId, eventId, new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000)],
    );
    const out = await settlements.collectGuarantee(receivableId, {
      actor: 'commander-1',
      sessionId: 'session-1',
      reauthToken: 'test-reauth',
      idempotencyKey: 'guarantee-it-1',
      reason: '30일 지나 보증금에서 충당',
    });
    expect(out.collection.amount).toBe(7_000_000);
    const guarantee = await db.pool.query('select guarantee_kind, amount, basis_amount, guarantee_rate_bp from guarantee_collection where id = $1', [out.collection.collectionId]);
    expect(guarantee.rows[0]).toEqual({ guarantee_kind: 'DEPOSIT', amount: '7000000', basis_amount: '100000000', guarantee_rate_bp: 1000 });
    const move = await db.pool.query('select kind, amount from receivable_move where receivable_id = $1', [receivableId]);
    expect(move.rows).toEqual([{ kind: 'GUARANTEE', amount: '7000000' }]);
    const left = await db.pool.query('select remaining, status from partner_receivable where id = $1', [receivableId]);
    expect(left.rows[0]).toEqual({ remaining: '0', status: 'CLOSED' });
    // 같은 멱등 키는 한 번만 움직인다.
    const again = await settlements.collectGuarantee(receivableId, {
      actor: 'commander-1',
      sessionId: 'session-1',
      reauthToken: 'test-reauth',
      idempotencyKey: 'guarantee-it-1',
      reason: '30일 지나 보증금에서 충당',
    });
    expect(again.collection.collectionId).toBe(out.collection.collectionId);
    const moves = await db.pool.query('select count(*)::int as n from receivable_move where receivable_id = $1', [receivableId]);
    expect(moves.rows[0].n).toBe(1);
  });
});

// FIX-invariant-m3: 미수금 이동 기록 표 이름 맞추기 ① 확장(docs/data.md §4, docs/devops.md §7.1). 표·제약·인덱스는 정본 이름(receivable_movement_…)이고
// 옛 이름 receivable_move는 자동 갱신 뷰라 이번 판(N)·이전 판(N-1) 앱이 옛 이름으로 읽고 써도 같은 표에 닿는다
describe('미수금 이동 기록 표 이름 바꾸기(payment 0028, PRF180)', () => {
  const MOVEMENT_CONSTRAINTS = [
    { conname: 'receivable_movement_amount_check', contype: 'c' },
    { conname: 'receivable_movement_kind_check', contype: 'c' },
    { conname: 'receivable_movement_pkey', contype: 'p' },
    { conname: 'receivable_movement_receivable_id_partner_receivable_id_fk', contype: 'f' },
    { conname: 'receivable_movement_statement_id_settlement_statement_id_fk', contype: 'f' },
  ];

  test('PRF180 M3 ⑦ 마이그레이션 뒤 receivable_movement의 제약 다섯·인덱스 둘이 새 머리 이름이고 옛 머리(receivable_move_) 이름은 어디에도 없으며 receivable_move는 security_invoker를 켠 뷰다', async () => {
    const cons = await db.pool.query(
      "select conname, contype from pg_constraint where conrelid = 'public.receivable_movement'::regclass and contype in ('p', 'c', 'f', 'u', 'x') order by conname",
    );
    expect(cons.rows).toEqual(MOVEMENT_CONSTRAINTS);
    const idx = await db.pool.query("select indexname from pg_indexes where schemaname = 'public' and tablename = 'receivable_movement' order by indexname");
    expect(idx.rows.map((r) => r.indexname)).toEqual(['receivable_movement_pkey', 'receivable_movement_receivable_idx']);
    // 옛 머리 이름이 남은 제약·관계(표·인덱스·뷰 밖 무엇이든)가 없다. 밑줄은 LIKE의 한 글자 표시라 글자로 막는다.
    // 정본(docs/data.md §4 '미수금 이동 기록 표 이름 맞추기' ①)이 바꾸라는 것은 기본 키·CHECK 둘·외래 키 둘·인덱스 하나다.
    // PostgreSQL 18은 NOT NULL도 이름 있는 제약(contype n, 표_칸_not_null)으로 적는데 표 이름을 바꿔도 따라 바뀌지 않아 옛 머리로 남는다.
    // 정본 범위 밖이라 여기서 빼고, 남는 사실은 계획 '시험 결과'에 적어 감독 결정으로 넘긴다(FIX-invariant-m3 시험 담당)
    const oldCons = await db.pool.query("select conname, contype from pg_constraint where conname like 'receivable\\_move\\_%' and contype <> 'n' order by conname");
    expect(oldCons.rows).toEqual([]);
    const oldRel = await db.pool.query("select relname, relkind from pg_class where relname like 'receivable\\_move\\_%' order by relname");
    expect(oldRel.rows).toEqual([]);
    const view = await db.pool.query("select relkind, reloptions from pg_class where oid = 'public.receivable_move'::regclass");
    expect(view.rows).toEqual([{ relkind: 'v', reloptions: ['security_invoker=true'] }]);
    // 뷰는 표의 칸 여섯을 같은 이름·종류로 빠짐없이 보인다(표의 칸 차례는 0026이 id·kind를 뒤에 더해 뷰와 다르다. 앱은 칸 이름으로 읽고 쓴다)
    const columns = async (rel: string) =>
      (await db.pool.query('select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position', ['public', rel])).rows;
    const byName = (rows: { column_name: string; data_type: string }[]) => [...rows].sort((a, b) => a.column_name.localeCompare(b.column_name));
    expect(byName(await columns('receivable_move'))).toEqual(byName(await columns('receivable_movement')));
    expect((await columns('receivable_move')).map((c) => c.column_name)).toEqual(['id', 'receivable_id', 'statement_id', 'amount', 'kind', 'moved_at']);
  });

  test('PRF180 M3 ⑧ 이전 판 앱처럼 옛 이름 뷰에 id·kind 없이 넣으면 밑 표 기본값(새 UUID·OFFSET)으로 receivable_movement에 들어가 옛 이름으로도 읽히고, 뷰로 넣어도 표의 CHECK·외래 키가 막는다', async () => {
    const promoterId = randomUUID();
    const statementId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-12-09', payoutAmount: 100_000 });
    const receivable = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 50_000 });
    await db.pool.query('insert into receivable_move (receivable_id, statement_id, amount, moved_at) values ($1, $2, $3, $4)', [receivable.receivableId, statementId, 12_345, NOW]);
    const base = await db.pool.query('select id, receivable_id, statement_id, kind, amount from receivable_movement where receivable_id = $1', [receivable.receivableId]);
    expect(base.rows).toHaveLength(1);
    expect(base.rows[0]).toMatchObject({ receivable_id: receivable.receivableId, statement_id: statementId, kind: 'OFFSET', amount: '12345' });
    expect(base.rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const viaOld = await db.pool.query('select id, receivable_id, statement_id, kind, amount from receivable_move where receivable_id = $1', [receivable.receivableId]);
    expect(viaOld.rows).toEqual(base.rows);
    await expect(
      db.pool.query('insert into receivable_move (receivable_id, statement_id, amount, moved_at) values ($1, $2, 0, $3)', [receivable.receivableId, statementId, NOW]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'receivable_movement_amount_check' });
    await expect(
      db.pool.query('insert into receivable_move (receivable_id, statement_id, amount, moved_at) values ($1, $2, 1, $3)', [randomUUID(), statementId, NOW]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'receivable_movement_receivable_id_partner_receivable_id_fk' });
    // 막힌 넣기는 아무 행도 남기지 않는다
    expect((await db.pool.query('select count(*)::int as n from receivable_movement where statement_id = $1', [statementId])).rows[0].n).toBe(1);
  });

  test('PRF180 M3 ⑨ 저장소의 상계(지급 묶음)·보증 충당·이동 기록 넣기가 옛 이름 뷰를 거쳐 정본 이름 표에 쓰이고, 저장소의 이동 기록 읽기가 그 표의 행 그대로다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    // 보증 한도의 근거 정산서(판매 대금 1억 원 × 계약 보증 비율 10% = 1,000만 원)
    const basisId = randomUUID();
    await db.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, payout_amount, status, payout_date, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'TOSS', 'STANDARD', 100000000, 0, 0, 0, 100000000, 'PAID', '2026-10-01', $4, $4)`,
      [basisId, promoterId, eventId, NOW],
    );
    // ① 상계: 지급 100만 원 정산서와 미수금 30만 원 → 지급 묶음이 30만 원을 상계한다(트랜잭션 안의 이동 기록 넣기)
    const statementId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-12-08', payoutAmount: 1_000_000 });
    const offset = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 300_000 });
    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-12-08', actor: ACCOUNT });
    expect(batch.totalAmount).toBe(700_000);
    // ② 보증 충당: 31일 지난 미수금 20만 원(묶음을 만든 뒤에 넣어 상계되지 않게 한다)
    const guarantee = randomUUID();
    await db.pool.query(
      `insert into partner_receivable (id, promoter_id, pg, cause, event_id, amount, remaining, status, created_at, updated_at)
       values ($1, $2, 'TOSS', 'REFUND_AFTER_PAYOUT', $3, 200000, 200000, 'OPEN', $4, $4)`,
      [guarantee, promoterId, eventId, new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000)],
    );
    const out = await settlements.collectGuarantee(guarantee, { actor: 'commander-1', sessionId: 'session-1', reauthToken: 'test-reauth', idempotencyKey: 'guarantee-it-m3', reason: '30일 지나 보증금에서 충당' });
    expect(out.collection.amount).toBe(200_000);
    // ③ 저장소의 이동 기록 넣기(이동 ID를 정해 넣는 길): 상계를 되돌린 기록
    const reversalId = randomUUID();
    await store.insertReceivableMove({ moveId: reversalId, receivableId: offset.receivableId, statementId, amount: 300_000, kind: 'REVERSAL', movedAt: NOW });

    // 정본 이름 표에 세 길의 행이 모두 있다
    const base = await db.pool.query<{ id: string; receivable_id: string; statement_id: string; kind: string; amount: string }>(
      'select id, receivable_id, statement_id, kind, amount from receivable_movement where receivable_id = any($1::uuid[]) order by kind',
      [[offset.receivableId, guarantee]],
    );
    expect(base.rows.map((r) => [r.receivable_id, r.statement_id, r.kind, r.amount])).toEqual([
      [guarantee, basisId, 'GUARANTEE', '200000'],
      [offset.receivableId, statementId, 'OFFSET', '300000'],
      [offset.receivableId, statementId, 'REVERSAL', '300000'],
    ]);
    expect(base.rows.find((r) => r.kind === 'REVERSAL')!.id).toBe(reversalId);
    // 저장소 읽기(옛 이름 뷰)가 표의 행과 이동 ID까지 같다
    const asRecords = (rows: typeof base.rows) =>
      rows.map((r) => ({ moveId: r.id, receivableId: r.receivable_id, statementId: r.statement_id, amount: Number(r.amount), kind: r.kind })).sort((a, b) => a.kind.localeCompare(b.kind));
    const strip = (rows: Awaited<ReturnType<typeof store.listReceivableMoves>>) =>
      rows.map((m) => ({ moveId: m.moveId, receivableId: m.receivableId, statementId: m.statementId, amount: m.amount, kind: m.kind })).sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
    expect(strip(await store.listReceivableMoves(statementId))).toEqual(asRecords(base.rows.filter((r) => r.statement_id === statementId)));
    expect(strip(await store.listReceivableMovesForReceivable(guarantee))).toEqual(asRecords(base.rows.filter((r) => r.receivable_id === guarantee)));
    expect(strip(await store.listReceivableMovesForReceivable(offset.receivableId))).toEqual(asRecords(base.rows.filter((r) => r.receivable_id === offset.receivableId)));
    // 상계·보증 충당이 같은 트랜잭션에 쓴 미수금·정산서 값
    const left = await db.pool.query('select id, remaining, status from partner_receivable where id = any($1::uuid[]) order by remaining, id', [[offset.receivableId, guarantee]]);
    expect(left.rows.map((r) => [r.id, r.remaining, r.status]).sort()).toEqual([[offset.receivableId, '0', 'CLOSED'], [guarantee, '0', 'CLOSED']].sort());
    expect(await store.findStatementById(statementId)).toMatchObject({ offsetAmount: 300_000, payoutAmount: 700_000 });
  });
});
