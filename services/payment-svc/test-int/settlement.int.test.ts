// 정산·지급·KYC 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-610 잔여, R-574).
// 0015 적용·재적용, 실제 payment 원장 계산, 정산서·이의·KYC·지급 묶음·재시도·정산 계좌를 본다.
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
});
