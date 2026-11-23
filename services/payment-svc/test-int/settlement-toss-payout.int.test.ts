// F-07-6(LCH-110, ADR-0369) 토스 지급대행의 실제 PostgreSQL 통합 시험. 결제사는 시험 안 대역 서버(test/support/toss-payout-fake.ts)다.
// J-T37 ② 0029 옮기기(seller_kyc 토스 칸 → toss_seller 일반 상점)·유일·계좌 칸 없음
// J-T38 ① 접수 반영(지급 건·정산서·Outbox)이 한 트랜잭션: Outbox 쓰기를 실패시키면 지급 ID·정산서·사건이 모두 남지 않고, 같은 키로 다시 실행해 회복한다
// J-T38 ② 같은 지급 결과를 두 연결이 겹쳐 반영해도 사건 하나, J-T38 ⑤ 묶음 때 PAYOUT_HELD·RECEIVABLE_CLOSED가 묶음과 한 트랜잭션
// J-T38 ⑨ operator 요청 둘이 같은 PREPARED를 겹쳐 바꿔도 승인 대기 하나·상계 한 번, 부분 유일 인덱스
// J-T5 두 연결의 묶음 잡기가 겹쳐도 전송 한 번, J-T15 ② 같은 실패를 두 연결이 반영해도 새 순번 하나(재요청 행·감사·T13 한 트랜잭션)
// J-T25 장부 원천(DrizzlePgLedgerSource)이 실제 원장을 읽고, 같은 달 대사는 부분 유일로 한 행·CS 건 하나
// Outbox 실패는 Outbox 파티션이 없는 먼 날짜 시계를 쓴 저장소로 만든다(트랜잭션 끝 문장이 실패한다).
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { HttpTossPayoutTransport } from '../src/modules/settlement/adapters/http-toss-payout-transport.js';
import { DrizzlePgLedgerSource } from '../src/modules/settlement/adapters/db/drizzle-pg-ledger-source.js';
import {
  DrizzleSettlementPaymentSource,
  DrizzleSettlementStore,
  HttpPgBalanceSource,
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  Settlements,
  TossPayoutGateway,
  type PayoutApprovalVerifier,
  type StatementRecord,
  type VerifiedPayoutApproval,
} from '../src/modules/settlement/index.js';
import { RecordingCaseNotice } from '../test/settlement-flow-support.js';
import { noSaleSuspensions, seedTossSellers } from '../test/settlement-support.js';
import { startTossPayoutFake, type TossPayoutFake } from '../test/support/toss-payout-fake.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const kst = (local: string): number => Date.parse(`${local}+09:00`);
const BASE = kst('2026-12-04T10:00:00.000');
const FAR = Date.parse('2031-01-01T00:00:00.000Z');
const TERMS = { feeMonthlyKrw: 250_000, feeFreeCount: 7, feePerItemKrw: 130 };

let pgc: PostgresContainer;
let db1: Database;
let db2: Database;
let locker: pg.Client;
let fake: TossPayoutFake;
let transport: HttpTossPayoutTransport;
const keys = { STANDARD: { secretKey: `it_sk_std_${randomBytes(4).toString('hex')}`, key: randomBytes(32) }, ESCROW: { secretKey: `it_sk_esc_${randomBytes(4).toString('hex')}`, key: randomBytes(32) } };
const approvalRows = new Map<string, VerifiedPayoutApproval>();
const approvals: PayoutApprovalVerifier = { verify: async (id) => approvalRows.get(id) };
const cases = new RecordingCaseNotice();

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await db1.pool.query<T>(text, values)).rows;
const waitingOn = async (app: string): Promise<number> => Number((await q<{ n: string }>("select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [app]))[0]!.n);
const untilWaiting = async (app: string) => {
  for (let i = 0; i < 500; i += 1) {
    if ((await waitingOn(app)) >= 1) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${app} 연결이 잠금을 기다리지 않았다`);
};
/** 세 번째 연결이 행 하나를 잠근다. 풀기 전까지 두 파드의 쓰기가 줄을 선다 */
const lockRow = async (table: 'payout' | 'payout_batch', id: string) => {
  await locker.query('begin');
  await locker.query(`select id from ${table} where id = $1 for update`, [id]);
  return async () => {
    await locker.query('commit');
  };
};

/** 같은 DB를 보는 두 파드(연결 풀이 다르다)와 Outbox를 쓰지 못하는 파드 */
function pods(now = BASE) {
  const clock = fakeClock({ now });
  const make = (database: Database, storeClock = clock) =>
    new Settlements({
      store: new DrizzleSettlementStore(database, storeClock),
      payments: new DrizzleSettlementPaymentSource(database),
      approvals,
      saleSuspensions: noSaleSuspensions,
      pgBalance: new HttpPgBalanceSource(transport),
      gateways: [new ManualPortonePayoutGateway(), new TossPayoutGateway(transport)],
      reauth: new MemoryReauthVerifier(),
      clock,
      caseNotice: cases,
      tossTransport: transport,
      pgLedger: new DrizzlePgLedgerSource(database),
      tossTerms: TERMS,
    });
  return { clock, a: make(db1), b: make(db2), broken: make(db1, fakeClock({ now: FAR })), store: new DrizzleSettlementStore(db1, clock) };
}
type Pods = ReturnType<typeof pods>;

const statement = async (p: Pods, o: { promoterId: string; amount: number; payoutDate: string; pgStore?: 'STANDARD' | 'ESCROW' }): Promise<StatementRecord> => {
  const at = new Date(p.clock.now());
  const record: StatementRecord = {
    statementId: randomUUID(),
    promoterId: o.promoterId,
    kind: 'EVENT',
    eventId: randomUUID(),
    pg: 'TOSS',
    pgStore: o.pgStore ?? 'STANDARD',
    periodStart: null,
    periodEnd: null,
    grossAmount: o.amount,
    refundAmount: 0,
    commissionAmount: 0,
    commissionVat: 0,
    offsetAmount: 0,
    payoutAmount: o.amount,
    revision: 1,
    supersedesId: null,
    excludedPayments: [],
    status: 'CONFIRMED',
    holdReason: null,
    disputeDueAt: null,
    payoutDate: o.payoutDate,
    payoutBankCode: '004',
    payoutAccountLast4: '1234',
    payoutBatchId: null,
    adjustmentAmount: 0,
    createdAt: at,
    updatedAt: at,
  };
  expect(await p.store.insertStatement(record, [])).toBe(true);
  return record;
};
const partner = async (p: Pods, status: 'APPROVED' | null = 'APPROVED') => {
  const promoterId = randomUUID();
  await p.a.recordKyc(promoterId, 'VERIFIED');
  if (status) await seedTossSellers(p.store, promoterId, status);
  return promoterId;
};
const approved = async (p: Pods, payoutDate: string, pgStore: 'STANDARD' | 'ESCROW' = 'STANDARD') => {
  const batch = await p.a.createPayoutBatch({ pg: 'TOSS', pgStore, payoutDate, actor: randomUUID() });
  const approvalId = randomUUID();
  approvalRows.set(approvalId, {
    approvalId,
    kind: 'PAYOUT_BATCH',
    targetRef: batch.batchId,
    batchId: batch.batchId,
    pg: 'TOSS',
    pgStore,
    payoutDate,
    currency: 'KRW',
    amount: batch.totalAmount,
    statementCount: batch.statementCount,
    status: 'EXECUTING',
    requiredApprovals: 2,
    requestedBy: randomUUID(),
    approvals: [randomUUID()],
    approvedAt: new Date(p.clock.now()).toISOString(),
  });
  await p.a.approveBatch(batch.batchId, approvalId);
  return batch.batchId;
};
const outboxOf = async (statementId: string, type: string) =>
  (await q<{ payload: Buffer }>('select payload from outbox order by seq')).map((r) => JSON.parse(r.payload.toString('utf8')) as Record<string, unknown>).filter((v) => v.statementId === statementId && v.type === type);
const payoutRows = async (statementId: string) =>
  q<{ id: string; seq: number; amount: string; pg_payout_id: string | null; status: string; retry_of_payout_id: string | null; auto_retry_count: number }>('select id, seq, amount, pg_payout_id, status, retry_of_payout_id, auto_retry_count from payout where statement_id = $1 order by seq', [statementId]);
const statusOf = async (statementId: string) => (await q<{ status: string }>('select status from settlement_statement where id = $1', [statementId]))[0]?.status;
const payoutPosts = () => fake.calls('POST', /^\/v2\/payouts$/);

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  db1 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f076-pod-a' });
  db2 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f076-pod-b' });
  // 시험 시계는 BASE(2026-12-04)부터 2027-01-08까지 쓴다(J-T38 ⑨ 2027-01-06, J-T15 ② 2027-01-08, J-T25 2026-12-31). 그 날들의 Outbox 파티션을 덮는다(시험 이의 TO-05)
  await ensureOutboxPartitions(db1, fakeClock({ now: BASE }), { daysAhead: 60 });
  locker = new pg.Client({ connectionString: pgc.url, application_name: 'f076-locker' });
  await locker.connect();
  fake = await startTossPayoutFake({ STANDARD: { secretKey: keys.STANDARD.secretKey, securityKey: keys.STANDARD.key }, ESCROW: { secretKey: keys.ESCROW.secretKey, securityKey: keys.ESCROW.key } });
  transport = new HttpTossPayoutTransport(
    { stores: { STANDARD: { secretKey: keys.STANDARD.secretKey, securityKeys: [keys.STANDARD.key] }, ESCROW: { secretKey: keys.ESCROW.secretKey, securityKeys: [keys.ESCROW.key] } } },
    { baseUrl: fake.url, clock: fakeClock({ now: BASE }) },
  );
}, 180_000);

afterAll(async () => {
  await locker?.end().catch(() => undefined);
  await db1?.close();
  await db2?.close();
  await fake?.close();
  pgc?.stop();
});

describe('J-T37 ② payment 0029', () => {
  test('J-T37 ② 0029가 seller_kyc의 토스 셀러 칸을 toss_seller 일반 상점 행으로 옮기고(옛 칸은 남김), 셀러 ID·참조 ID 유일·상태 CHECK가 있으며 계좌 칸이 없다', async () => {
    // 0028까지만 적용한 새 DB에 옛 칸을 쓴 파트너 둘(셀러 있음·없음)을 심고 나머지 마이그레이션을 적용한다
    const admin = new pg.Client({ connectionString: pgc.url });
    await admin.connect();
    await admin.query('create database pre0029');
    await admin.end();
    const url = pgc.url.replace(/\/peaket$/, '/pre0029');
    const source = fileURLToPath(new URL('../migrations', import.meta.url));
    const dir = await mkdtemp(join(tmpdir(), 'peaket-payment-0029-'));
    try {
      const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const kept = journal.entries.filter((e) => e.tag < '0029');
      expect(kept.at(-1)?.tag).toBe('0028_receivable_movement_rename');
      await mkdir(join(dir, 'meta'), { recursive: true });
      for (const e of kept) await copyFile(join(source, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
      await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await migrate(drizzle({ client: c }), { migrationsFolder: dir });
        const withSeller = randomUUID();
        const without = randomUUID();
        const at = new Date('2026-11-20T00:00:00.000Z');
        await c.query(
          `insert into seller_kyc (promoter_id, status, business_verified, representative_verified, verified_at, source, updated_at, toss_seller_id, toss_seller_status)
           values ($1, 'VERIFIED', true, true, $3, 'TOSS', $3, 'old-seller-1', 'KYC_REQUIRED'), ($2, 'PENDING', false, false, null, 'MANUAL', $3, null, 'PENDING')`,
          [withSeller, without, at],
        );
        // 옛 묶음·지급 건 한 쌍(0029 전 칸만): 0029가 payout.payout_date를 그 묶음의 지급일로 채워야 한다(시험 리뷰 TR-09)
        const oldStatement = randomUUID();
        const oldBatch = randomUUID();
        const oldPayout = randomUUID();
        await c.query(
          `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, payout_amount, status, payout_date, created_at, updated_at)
           values ($1, $2, 'EVENT', $3, 'TOSS', 'STANDARD', 500000, 0, 0, 0, 500000, 'SCHEDULED', '2026-11-27', $4, $4)`,
          [oldStatement, withSeller, randomUUID(), at],
        );
        await c.query(`insert into payout_batch (id, pg, pg_store, payout_date, total_amount, statement_count, status, created_at, updated_at) values ($1, 'TOSS', 'STANDARD', '2026-11-27', 500000, 1, 'SUBMITTED', $2, $2)`, [oldBatch, at]);
        await c.query(`insert into payout (id, batch_id, statement_id, seq, amount, ref_payout_id, status, created_at, updated_at) values ($1, $2, $3, 1, 500000, $4, 'REQUESTED', $5, $5)`, [oldPayout, oldBatch, oldStatement, `${oldStatement}-1`, at]);
        await c.end().catch(() => undefined);
        await migratePayment(url);
        const moved = new pg.Client({ connectionString: url });
        await moved.connect();
        try {
          const [payoutRow] = (await moved.query("select to_char(payout_date, 'YYYY-MM-DD') as payout_date, failure_class, retry_of_payout_id, auto_retry_count from payout where id = $1", [oldPayout])).rows;
          expect(payoutRow).toEqual({ payout_date: '2026-11-27', failure_class: null, retry_of_payout_id: null, auto_retry_count: 0 });
          const [batchRow] = (await moved.query('select submit_attempts, next_submit_at, submit_deadline_at, last_submit_error, date_retry_used from payout_batch where id = $1', [oldBatch])).rows;
          expect(batchRow).toEqual({ submit_attempts: 0, next_submit_at: null, submit_deadline_at: null, last_submit_error: null, date_retry_used: false });
        } finally {
          await moved.end();
        }
        const d = new pg.Client({ connectionString: url });
        await d.connect();
        try {
          const rows = (await d.query('select promoter_id, pg_store, toss_seller_id, ref_seller_id, status, business_type from toss_seller order by promoter_id')).rows;
          expect(rows).toEqual([{ promoter_id: withSeller, pg_store: 'STANDARD', toss_seller_id: 'old-seller-1', ref_seller_id: `${withSeller}-STANDARD`, status: 'KYC_REQUIRED', business_type: 'CORPORATE' }]);
          // 옛 칸은 지우지 않는다(정리 목록 C-02)
          expect((await d.query('select toss_seller_id, toss_seller_status from seller_kyc where promoter_id = $1', [withSeller])).rows).toEqual([{ toss_seller_id: 'old-seller-1', toss_seller_status: 'KYC_REQUIRED' }]);
          const columns = (await d.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'toss_seller' order by column_name")).rows.map((r) => r.column_name);
          expect(columns.filter((n) => /account|bank|holder/.test(n))).toEqual([]);
          const fails = async (sql: string, params: unknown[]) => d.query(sql, params).then(() => 'ok', (e: { code?: string }) => e.code);
          const ins = `insert into toss_seller (promoter_id, pg_store, toss_seller_id, ref_seller_id, status, business_type, registered_at, status_checked_at, updated_at) values ($1, $2, $3, $4, $5, 'CORPORATE', now(), now(), now())`;
          expect(await fails(ins, [withSeller, 'STANDARD', 'new-1', 'ref-new-1', 'APPROVED'])).toBe('23505');
          expect(await fails(ins, [randomUUID(), 'ESCROW', 'old-seller-1', 'ref-new-2', 'APPROVED'])).toBe('23505');
          expect(await fails(ins, [randomUUID(), 'ESCROW', 'new-3', `${withSeller}-STANDARD`, 'APPROVED'])).toBe('23505');
          expect(await fails(ins, [randomUUID(), 'ESCROW', 'new-4', 'ref-new-4', 'SOMETHING'])).toBe('23514');
          expect(await fails(ins, [randomUUID(), 'OTHER', 'new-5', 'ref-new-5', 'APPROVED'])).toBe('23514');
          expect(await fails(ins, [withSeller, 'ESCROW', 'new-6', `${withSeller}-ESCROW`, 'APPROVAL_REQUIRED'])).toBe('ok');
        } finally {
          await d.end();
        }
      } finally {
        await c.end().catch(() => undefined);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('J-T37 ② 저장소가 상점별 셀러를 쓰고 읽으며(파트너·상점 키), CS 건 요청 종류는 다섯만 받는다', async () => {
    const p = pods();
    const promoterId = randomUUID();
    await seedTossSellers(p.store, promoterId, 'PARTIALLY_APPROVED');
    expect(await p.store.findTossSeller(promoterId, 'ESCROW')).toMatchObject({ promoterId, pgStore: 'ESCROW', status: 'PARTIALLY_APPROVED', refSellerId: `${promoterId}-ESCROW` });
    expect(await p.store.findTossSellerById(`seller-${promoterId}-STANDARD`)).toMatchObject({ promoterId, pgStore: 'STANDARD' });
    const kind = async (k: string) =>
      db1.pool.query('insert into settlement_case_request (event_key, kind, source_id, created_at) values ($1, $2, $3, now())', [randomUUID(), k, 'x']).then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    for (const k of ['PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'SELLER_KYC_REQUIRED', 'PG_BALANCE_MISMATCH']) expect([k, await kind(k)]).toEqual([k, 'ok']);
    for (const k of ['STATEMENT_DISPUTE', 'PORTONE_LEDGER_MISMATCH']) expect([k, await kind(k)]).toEqual([k, '23514']);
  });
});

describe('J-T38 ① 접수 반영의 한 트랜잭션', () => {
  test('J-T38 ① Outbox 쓰기가 실패하면 지급 ID·정산서 SCHEDULED·PAYOUT_SCHEDULED가 모두 남지 않고, 같은 키로 다시 실행하면 결제사는 처음 접수를 돌려주고 반영된다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = pods();
    const promoterId = await partner(p);
    const s = await statement(p, { promoterId, amount: 1_234_567, payoutDate: '2027-01-04' });
    const batchId = await approved(p, '2027-01-04');
    const before = payoutPosts().length;
    await expect(p.broken.executeBatch(batchId)).rejects.toThrow();
    expect(payoutPosts().length - before).toBe(1);
    // 접수 반영이 되돌아가 결제사 지급 ID가 남은 지급 건이 없다(지급 건 행을 전송 전에 따로 넣었는지는 묻지 않는다)
    expect((await payoutRows(s.statementId)).filter((r) => r.pg_payout_id !== null)).toEqual([]);
    expect(await statusOf(s.statementId)).not.toBe('PAID');
    expect(await outboxOf(s.statementId, 'PAYOUT_SCHEDULED')).toEqual([]);
    const firstKey = payoutPosts().at(-1)!.headers['idempotency-key'];
    await p.a.executeBatch(batchId);
    expect(payoutPosts().at(-1)!.headers['idempotency-key']).toBe(firstKey);
    const rows = await payoutRows(s.statementId);
    expect(rows.map((r) => r.pg_payout_id)).toEqual([fake.payoutByRef(`${s.statementId}-1`)!.id]);
    expect(await statusOf(s.statementId)).toBe('SCHEDULED');
    expect((await outboxOf(s.statementId, 'PAYOUT_SCHEDULED')).map((v) => v.amount)).toEqual([1_234_567]);
  });

  test('J-T38 ①·⑥ 결과 반영에서 Outbox 쓰기가 실패하면 지급 건 상태·정산서 FAILED·CS 건 요청이 모두 남지 않는다', async () => {
    const p = pods();
    const promoterId = await partner(p);
    const s = await statement(p, { promoterId, amount: 2_000_000, payoutDate: '2027-01-12' });
    await p.a.executeBatch(await approved(p, '2027-01-12'));
    const [row] = await payoutRows(s.statementId);
    const fact = { pgPayoutId: row!.pg_payout_id!, status: 'FAILED' as const, errorCode: 'ACCOUNT_CLOSED', observedAt: new Date(BASE) };
    await expect(p.broken.applyPayoutFact(fact)).rejects.toThrow();
    expect((await payoutRows(s.statementId)).map((r) => r.status)).toEqual(['REQUESTED']);
    expect(await statusOf(s.statementId)).toBe('SCHEDULED');
    expect(await q('select event_key from settlement_case_request where source_id = $1', [row!.id])).toEqual([]);
    expect(await p.a.applyPayoutFact(fact)).toEqual({ applied: true });
    expect(await statusOf(s.statementId)).toBe('FAILED');
    expect((await q<{ kind: string }>('select kind from settlement_case_request where source_id = $1', [row!.id])).map((r) => r.kind)).toEqual(['PAYOUT_FAILED']);
    expect((await outboxOf(s.statementId, 'PAYOUT_FAILED')).map((v) => v.amount)).toEqual([2_000_000]);
  });
});

describe('J-T38 ② 겹친 반영', () => {
  test('J-T38 ② 같은 COMPLETED를 두 연결이 겹쳐 반영해도(웹훅·미완료 점검) 정산서 PAID·PAYOUT_COMPLETED는 한 번이다', async () => {
    const p = pods();
    const promoterId = await partner(p);
    const s = await statement(p, { promoterId, amount: 3_300_000, payoutDate: '2027-01-05' });
    await p.a.executeBatch(await approved(p, '2027-01-05'));
    const [row] = await payoutRows(s.statementId);
    const fact = { pgPayoutId: row!.pg_payout_id!, status: 'COMPLETED' as const, observedAt: new Date(BASE) };
    const release = await lockRow('payout', row!.id);
    const racing = Promise.all([p.a.applyPayoutFact(fact), p.b.applyPayoutFact(fact)]);
    await untilWaiting('f076-pod-a');
    await untilWaiting('f076-pod-b');
    await release();
    const results = await racing;
    expect(results.map((r) => r.applied).sort()).toEqual([false, true]);
    expect(await statusOf(s.statementId)).toBe('PAID');
    expect(await outboxOf(s.statementId, 'PAYOUT_COMPLETED')).toHaveLength(1);
  });
});

describe('J-T38 ⑤ 묶음 때의 사건', () => {
  test('J-T38 ⑤ PAYOUT_HELD·RECEIVABLE_CLOSED는 묶음과 같은 트랜잭션이라, Outbox 쓰기가 실패하면 묶음·보류·상계가 모두 남지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = pods();
    const ok = await partner(p);
    const held = await partner(p, null);
    const sOk = await statement(p, { promoterId: ok, amount: 1_000_000, payoutDate: '2027-01-06' });
    const sHeld = await statement(p, { promoterId: held, amount: 700_000, payoutDate: '2027-01-06' });
    const receivable = await p.a.recordReceivable({ promoterId: ok, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 250_000 });
    const input = { pg: 'TOSS' as const, pgStore: 'STANDARD' as const, payoutDate: '2027-01-06', actor: randomUUID() };
    await expect(p.broken.createPayoutBatch(input)).rejects.toThrow();
    expect(await q("select id from payout_batch where payout_date = '2027-01-06'")).toEqual([]);
    expect(await statusOf(sHeld.statementId)).toBe('CONFIRMED');
    expect((await q<{ remaining: string; status: string }>('select remaining, status from partner_receivable where id = $1', [receivable.receivableId]))[0]).toEqual({ remaining: '250000', status: 'OPEN' });
    expect(await q('select id from receivable_movement where receivable_id = $1', [receivable.receivableId])).toEqual([]);
    const batch = await p.a.createPayoutBatch(input);
    expect([batch.statementCount, batch.totalAmount]).toEqual([1, 750_000]);
    expect((await outboxOf(sHeld.statementId, 'PAYOUT_HELD')).map((v) => v.amount)).toEqual([700_000]);
    expect((await outboxOf(sOk.statementId, 'RECEIVABLE_CLOSED')).map((v) => v.amount)).toEqual([250_000]);
  });
});

describe('J-T38 ⑨ PREPARED 묶음', () => {
  test('J-T38 ⑨ operator 요청 둘이 같은 PREPARED를 겹쳐 바꿔도 승인 대기 묶음 하나·상계 한 번이고, 부분 유일 인덱스가 같은 결제사·상점·지급일의 둘째 살아 있는 묶음을 막는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = pods(kst('2027-01-06T09:00:00.000'));
    const promoterId = await partner(p);
    await statement(p, { promoterId, amount: 1_000_000, payoutDate: '2027-01-07' });
    await statement(p, { promoterId, amount: 2_000_000, payoutDate: '2027-01-07' });
    const receivable = await p.a.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 100_000 });
    expect(await p.a.prepareTossBatches('2027-01-07')).toEqual({ prepared: 1 });
    const [prepared] = await q<{ id: string; status: string; total_amount: string; statement_count: number }>("select id, status, total_amount, statement_count from payout_batch where payout_date = '2027-01-07'");
    expect([prepared!.status, prepared!.total_amount, prepared!.statement_count]).toEqual(['PREPARED', '2900000', 2]);
    expect(await q('select id from settlement_statement where payout_batch_id = $1', [prepared!.id])).toEqual([]);
    const input = { pg: 'TOSS' as const, pgStore: 'STANDARD' as const, payoutDate: '2027-01-07', actor: randomUUID() };
    const release = await lockRow('payout_batch', prepared!.id);
    const racing = Promise.allSettled([p.a.createPayoutBatch(input), p.b.createPayoutBatch(input)]);
    await untilWaiting('f076-pod-a');
    await untilWaiting('f076-pod-b');
    await release();
    const results = await racing;
    expect(results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ batchId: string; status: string }>).value)).toEqual([expect.objectContaining({ batchId: prepared!.id, status: 'PENDING_APPROVAL' })]);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, type: expect.stringContaining('payout-batch-exists') } });
    expect((await q<{ status: string }>("select status from payout_batch where payout_date = '2027-01-07'")).map((r) => r.status)).toEqual(['PENDING_APPROVAL']);
    expect((await q<{ amount: string }>('select amount from receivable_movement where receivable_id = $1', [receivable.receivableId])).map((r) => r.amount)).toEqual(['100000']);
    expect((await q<{ n: number }>('select count(*)::int as n from settlement_statement where payout_batch_id = $1', [prepared!.id]))[0]!.n).toBe(2);
    // 마지막 가드: 같은 결제사·상점·지급일의 PREPARED·PENDING_APPROVAL·APPROVED·SUBMITTED는 하나
    const insert = (status: string) =>
      db1.pool
        .query(`insert into payout_batch (id, pg, pg_store, payout_date, total_amount, statement_count, status, created_at, updated_at) values ($1, 'TOSS', 'STANDARD', '2027-01-07', 0, 0, $2, now(), now())`, [randomUUID(), status])
        .then(
          () => 'ok',
          (e: { code?: string }) => e.code,
        );
    for (const status of ['PREPARED', 'APPROVED', 'SUBMITTED']) expect([status, await insert(status)]).toEqual([status, '23505']);
    expect(await insert('COMPLETED')).toBe('ok');
  });
});

describe('J-T5 두 연결의 묶음 잡기', () => {
  test('J-T5 응답 없음 뒤 두 파드가 같은 묶음을 함께 다시 보내도 결제사 요청은 한 번이다(next_submit_at 조건부 잡기) [ASVS v5.0.0-16.5.2]', async () => {
    const p = pods();
    const promoterId = await partner(p);
    await statement(p, { promoterId, amount: 4_400_000, payoutDate: '2027-01-08' });
    const batchId = await approved(p, '2027-01-08');
    fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'NO_RESPONSE');
    await p.a.executeBatch(batchId);
    const [b] = await q<{ next_submit_at: Date; submit_attempts: number }>('select next_submit_at, submit_attempts from payout_batch where id = $1', [batchId]);
    expect([b!.next_submit_at.getTime(), b!.submit_attempts]).toEqual([BASE + 60_000, 1]);
    p.clock.advance(60_000);
    const before = payoutPosts().length;
    const release = await lockRow('payout_batch', batchId);
    const racing = Promise.all([p.a.submitDueBatches(), p.b.submitDueBatches()]);
    await untilWaiting('f076-pod-a');
    await untilWaiting('f076-pod-b');
    await release();
    await racing;
    expect(payoutPosts().length - before).toBe(1);
    expect((await q<{ status: string }>('select status from payout_batch where id = $1', [batchId]))[0]!.status).toBe('SUBMITTED');
    // 저장소 잡기 자체도 같은 읽은 값으로는 한 번만 이긴다
    const store = new DrizzleSettlementStore(db1, p.clock);
    const t = new Date(BASE + 10 * 60_000);
    await db1.pool.query('update payout_batch set next_submit_at = $2 where id = $1', [batchId, t]);
    expect(await Promise.all([store.claimBatchSubmit(batchId, t, new Date(t.getTime() + 60_000)), new DrizzleSettlementStore(db2, p.clock).claimBatchSubmit(batchId, t, new Date(t.getTime() + 60_000))]).then((r) => r.sort())).toEqual([false, true]);
  });
});

describe('J-T15 ② 겹친 실패 반영', () => {
  test('J-T15 ② 같은 점검 실패를 두 연결이 겹쳐 반영해도 새 순번 하나·감사 하나이고, Outbox 쓰기가 실패하면 새 순번·감사·실패 반영이 모두 남지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = pods(kst('2027-01-08T15:00:00.000'));
    const promoterId = await partner(p);
    const s = await statement(p, { promoterId, amount: 600_000, payoutDate: '2027-01-11' });
    await p.a.executeBatch(await approved(p, '2027-01-11'));
    const [row] = await payoutRows(s.statementId);
    const fact = { pgPayoutId: row!.pg_payout_id!, status: 'FAILED' as const, errorCode: 'BANK_MAINTENANCE', observedAt: new Date(p.clock.now()) };
    await expect(p.broken.applyPayoutFact(fact)).rejects.toThrow();
    expect((await payoutRows(s.statementId)).map((r) => [r.seq, r.status])).toEqual([[1, 'REQUESTED']]);
    expect(await q('select id from payout_retry_audit where payout_id = $1', [row!.id])).toEqual([]);
    const release = await lockRow('payout', row!.id);
    const racing = Promise.all([p.a.applyPayoutFact(fact), p.b.applyPayoutFact(fact)]);
    await untilWaiting('f076-pod-a');
    await untilWaiting('f076-pod-b');
    await release();
    expect((await racing).map((r) => r.applied).sort()).toEqual([false, true]);
    const rows = await payoutRows(s.statementId);
    expect(rows.map((r) => [r.seq, r.status, r.retry_of_payout_id, r.auto_retry_count])).toEqual([
      [1, 'FAILED', null, 0],
      [2, 'REQUESTED', row!.id, 1],
    ]);
    expect((await q<{ old_seq: number; new_seq: number; actor: string; reason: string }>('select old_seq, new_seq, actor, reason from payout_retry_audit where payout_id = $1', [row!.id]))).toEqual([{ old_seq: 1, new_seq: 2, actor: 'system', reason: 'TRANSIENT' }]);
    // 마지막 가드: 같은 정산서의 같은 순번은 하나
    const dup = await db1.pool
      .query(
        `insert into payout (id, batch_id, statement_id, seq, amount, ref_payout_id, status, payout_date, auto_retry_count, created_at, updated_at)
         select gen_random_uuid(), batch_id, statement_id, 2, amount, ref_payout_id || '-dup', 'REQUESTED', payout_date, 0, now(), now() from payout where id = $1`,
        [row!.id],
      )
      .then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      );
    expect(dup).toBe('23505');
  });
});

describe('J-T25 결제사 잔액 대사(실제 원장)', () => {
  test('J-T25 장부 원천이 대사 끝난 승인·취소·완료 지급 합·달별 지급 건 수를 실제 표에서 읽고(끝나지 않은 건·다른 상점·포트원·DEPOSIT_CANCELED 뺌), 같은 달 대사가 겹쳐도 한 행·CS 건 하나다', async () => {
    const cutoff = kst('2026-12-31T22:00:00.000');
    const p = pods(cutoff);
    const approvedAt = new Date(kst('2026-11-03T12:00:00.000'));
    const pay = async (o: { amount: number; cancelled: number; status: string; pgStore?: 'STANDARD' | 'ESCROW'; pg?: 'TOSS' | 'PORTONE'; approvedAt?: Date | null; failure?: string }) => {
      const id = randomUUID();
      await db1.pool.query(
        `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_store, pg_payment_ref, amount, cancelled_amount, status, failure_category, idempotency_key, authenticated_at, status_changed_at, approved_at)
         values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)`,
        [id, randomUUID(), randomUUID(), randomUUID(), o.pg ?? 'TOSS', o.pgStore ?? 'ESCROW', `ref-${id}`, o.amount, o.cancelled, o.status, o.failure ?? null, `idem-${id}`, approvedAt, o.approvedAt === undefined ? approvedAt : o.approvedAt],
      );
    };
    await pay({ amount: 30_000_000, cancelled: 0, status: 'APPROVED' });
    await pay({ amount: 10_000_000, cancelled: 2_000_000, status: 'PARTIAL_CANCELED' });
    await pay({ amount: 5_000_000, cancelled: 5_000_000, status: 'CANCELED' });
    // 대사에 들지 않는 것: 승인된 적 없는 취소, 입금 오류 되돌림(DEPOSIT_CANCELED), 일반 상점, 포트원, 대사 시각 뒤 승인
    await pay({ amount: 900_000, cancelled: 900_000, status: 'CANCELED', approvedAt: null });
    await pay({ amount: 800_000, cancelled: 800_000, status: 'CANCELED', failure: 'DEPOSIT_CANCELED' });
    await pay({ amount: 7_000_000, cancelled: 0, status: 'APPROVED', pgStore: 'STANDARD' });
    await pay({ amount: 8_000_000, cancelled: 0, status: 'APPROVED', pg: 'PORTONE' });
    await pay({ amount: 6_000_000, cancelled: 0, status: 'APPROVED', approvedAt: new Date(kst('2027-01-02T09:00:00.000')) });
    // 지급 건: 에스크로 토스 COMPLETED 11월·12월 하나씩(셈), REQUESTED·FAILED(안 셈), 일반 상점 COMPLETED·포트원 COMPLETED(안 셈)
    const payout = async (o: { pg: 'TOSS' | 'PORTONE'; pgStore: 'STANDARD' | 'ESCROW'; date: string; amount: number; status: string }) => {
      const statementId = randomUUID();
      const batchId = randomUUID();
      const at = new Date(cutoff - 86_400_000);
      await db1.pool.query(
        `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, payout_amount, status, payout_date, created_at, updated_at)
         values ($1, $2, 'EVENT', $3, $4, $5, $6, 0, 0, 0, $6, 'PAID', $7, $8, $8)`,
        [statementId, randomUUID(), randomUUID(), o.pg, o.pgStore, o.amount, o.date, at],
      );
      await db1.pool.query(`insert into payout_batch (id, pg, pg_store, payout_date, total_amount, statement_count, status, created_at, updated_at) values ($1, $2, $3, $4, $5, 1, 'COMPLETED', $6, $6)`, [batchId, o.pg, o.pgStore, o.date, o.amount, at]);
      await db1.pool.query(
        `insert into payout (id, batch_id, statement_id, seq, amount, ref_payout_id, status, payout_date, auto_retry_count, created_at, updated_at) values ($1, $2, $3, 1, $4, $5, $6, $7, 0, $8, $8)`,
        [randomUUID(), batchId, statementId, o.amount, `${statementId}-1`, o.status, o.date, at],
      );
    };
    await payout({ pg: 'TOSS', pgStore: 'ESCROW', date: '2026-11-20', amount: 300_000, status: 'COMPLETED' });
    await payout({ pg: 'TOSS', pgStore: 'ESCROW', date: '2026-12-10', amount: 200_000, status: 'COMPLETED' });
    await payout({ pg: 'TOSS', pgStore: 'ESCROW', date: '2026-12-11', amount: 50_000, status: 'REQUESTED' });
    await payout({ pg: 'TOSS', pgStore: 'ESCROW', date: '2026-12-11', amount: 40_000, status: 'FAILED' });
    await payout({ pg: 'TOSS', pgStore: 'STANDARD', date: '2026-12-10', amount: 70_000, status: 'COMPLETED' });
    await payout({ pg: 'PORTONE', pgStore: 'ESCROW', date: '2026-12-10', amount: 60_000, status: 'COMPLETED' });
    const ledger = await new DrizzlePgLedgerSource(db1).ledger({ pg: 'TOSS', pgStore: 'ESCROW', cutoffAt: new Date(cutoff) });
    expect(ledger).toEqual({ approvedAmount: 45_000_000, refundedAmount: 7_000_000, paidOutAmount: 500_000, payoutCountByMonth: { '2026-11': 1, '2026-12': 1 }, firstPaymentAt: approvedAt });

    fake.settlementRows.ESCROW = [{ paymentKey: 'pk-e', amount: 45_000_000, fee: 1_000_000, date: '2026-11-04' }];
    // 있어야 할 잔액 = 45,000,000 − 7,000,000 − (1,000,000 + 이용료 11월·12월 250,000씩(무료 7건 안)) − 500,000 = 36,000,000. 보이는 잔액은 1원 적다
    fake.balances.ESCROW = { available: 35_999_999, pending: 0 };
    // 셋째 연결이 같은 달 대사 행을 먼저 넣고 쥔 채 두 파드의 넣기가 줄을 서게 한 뒤 되돌린다(시험 리뷰 TR-17)
    await locker.query('begin');
    await locker.query(
      `insert into pg_balance_reconciliation (id, pg, pg_store, kind, period_month, batch_id, cutoff_at, approved_amount, refunded_amount, pg_fee_amount, paid_out_amount, peaket_withdrawn_amount, expected_amount, observed_amount, diff_amount, severity, created_at)
       values ($1, 'TOSS', 'ESCROW', 'MONTHLY', '2026-12-01', null, now(), 0, 0, 0, 0, 0, 0, 0, 0, 'NONE', now())`,
      [randomUUID()],
    );
    const racing = Promise.all([p.a.reconcileTossBalance({ pgStore: 'ESCROW', kind: 'MONTHLY', periodMonth: '2026-12-01' }), p.b.reconcileTossBalance({ pgStore: 'ESCROW', kind: 'MONTHLY', periodMonth: '2026-12-01' })]);
    await untilWaiting('f076-pod-a');
    await untilWaiting('f076-pod-b');
    await locker.query('rollback');
    const results = await racing;
    expect(results.filter((r) => r !== undefined)).toEqual([expect.objectContaining({ expectedAmount: 36_000_000, observedAmount: 35_999_999, diffAmount: -1, severity: 'CASE', paidOutAmount: 500_000 })]);
    expect(await q("select id from pg_balance_reconciliation where pg_store = 'ESCROW' and kind = 'MONTHLY'")).toHaveLength(1);
    expect((await q<{ source_id: string }>("select source_id from settlement_case_request where kind = 'PG_BALANCE_MISMATCH' and source_id like 'TOSS:%'")).map((r) => r.source_id)).toEqual(['TOSS:ESCROW']);
  });
});
