// A1V·CONS-V 정산 회귀 시험(실제 PostgreSQL 18). 단위 시험이 보지 못하는 Drizzle 저장소 의미를 고정한다.
// 대상: A1V-01(한 배치 미수금 이중 상계), A1V-12(settlement_statement_audit), CONS-V01(insertStatement 0행).
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, fakeClock, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import {
  calculateEventStatement,
  DrizzleSettlementStore,
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  Settlements,
  UnavailableTossPayoutGateway,
} from '../src/modules/settlement/index.js';
import { noApprovals, noSaleSuspensions, seedTossSellers } from '../test/settlement-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');

let pgc: PostgresContainer;
let db: Database;
let store: DrizzleSettlementStore;
let settlements: Settlements;

const statementRow = async (o: {
  promoterId: string;
  eventId: string;
  payoutDate: string;
  payoutAmount: number;
  status?: string;
  holdReason?: string | null;
  disputeDueAt?: Date | null;
}): Promise<string> => {
  const id = randomUUID();
  await db.pool.query(
    `insert into settlement_statement
       (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, payout_amount, status, hold_reason, dispute_due_at, payout_date, created_at, updated_at)
     values ($1, $2, 'EVENT', $3, 'TOSS', 'STANDARD', $4, 0, 0, 0, 0, $4, $5, $6, $7, $8, $9, $9)`,
    [id, o.promoterId, o.eventId, o.payoutAmount, o.status ?? 'CONFIRMED', o.holdReason ?? null, o.disputeDueAt ?? null, o.payoutDate, NOW],
  );
  return id;
};

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  await migratePayment(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'payment-settlement-a1v' });
  // F-07-5(ADR-0368 결정 2·3): 정산서 전이가 같은 트랜잭션에 trade.settlements Outbox를 쓴다. 운영 migrate 스크립트처럼 파티션을 만든다
  await ensureOutboxPartitions(db, systemClock);
  store = new DrizzleSettlementStore(db);
  settlements = new Settlements({
    store,
    payments: { listEventPayments: async () => [] },
    eventCommission: { rateBp: async () => 1000 },
    approvals: noApprovals,
    saleSuspensions: noSaleSuspensions,
    gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
    reauth: new MemoryReauthVerifier(),
    clock: fakeClock({ now: NOW.getTime() }),
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

describe('A1V-01 PostgreSQL 지급 묶음 미수금 상계', () => {
  test('J-T28 ② A1V-01 정산서 2개(각 89,000)와 미수금 50,000이면 총액 128,000·이동 기록 한 줄이다', async () => {
    const promoterId = randomUUID();
    const payoutDate = '2026-11-20';
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await seedTossSellers(store, promoterId); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
    const first = await statementRow({ promoterId, eventId: randomUUID(), payoutDate, payoutAmount: 89_000 });
    const second = await statementRow({ promoterId, eventId: randomUUID(), payoutDate, payoutAmount: 89_000 });
    const receivable = await settlements.recordReceivable({ promoterId, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 50_000 });

    const batch = await settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate, actor: randomUUID() });

    expect(batch.totalAmount).toBe(128_000);
    expect(batch.statementCount).toBe(2);
    const moves = await db.pool.query('select receivable_id, statement_id, amount from receivable_move where receivable_id = $1', [receivable.receivableId]);
    expect(moves.rows).toEqual([{ receivable_id: receivable.receivableId, statement_id: expect.any(String), amount: '50000' }]);
    const left = await db.pool.query('select remaining, status from partner_receivable where id = $1', [receivable.receivableId]);
    expect(left.rows[0]).toEqual({ remaining: '0', status: 'CLOSED' });
    const after = await db.pool.query('select id, offset_amount, payout_amount, status from settlement_statement where id = any($1::uuid[])', [[first, second]]);
    expect(after.rows.reduce((sum: number, row: { offset_amount: string }) => sum + Number(row.offset_amount), 0)).toBe(50_000);
    expect(after.rows.reduce((sum: number, row: { payout_amount: string }) => sum + Number(row.payout_amount), 0)).toBe(128_000);
    // F-07-6 시험 리뷰 E-01(ADR-0369 결정 14): 묶을 때 상태는 CONFIRMED 그대로다
    expect(after.rows.map((row: { status: string }) => row.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });
});

describe('A1V-12 PostgreSQL 정산서 상태 전이 감사', () => {
  test('재확정·이의 해소·자동 확정이 settlement_statement_audit에 이전/이후 상태·사유·행위자를 남긴다', async () => {
    const promoterId = randomUUID();
    await settlements.recordKyc(promoterId, 'VERIFIED');
    await seedTossSellers(store, promoterId); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)

    const heldId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-11-20', payoutAmount: 89_000, status: 'HELD', holdReason: 'KYC' });
    await settlements.reconfirmStatement(heldId, { actor: 'ops-a1v', reason: 'kyc-cleared' });

    const disputedId = await statementRow({ promoterId, eventId: randomUUID(), payoutDate: '2026-11-20', payoutAmount: 89_000, status: 'DISPUTED' });
    const disputeId = randomUUID();
    await db.pool.query("insert into statement_dispute (id, statement_id, reason_code, detail, submitted_by, submitted_at) values ($1, $2, 'COMMISSION', '', $3, $4)", [disputeId, disputedId, randomUUID(), NOW]);
    // F-07-5(정본 §4.2, ADR-0368 결정 6): 이의는 기각 경로로만 푼다(사유·처리자 필수)
    const csLead = randomUUID();
    await settlements.dismissDispute(disputedId, { reason: '수수료율은 계약과 같다', actorId: csLead });

    const autoId = await statementRow({
      promoterId,
      eventId: randomUUID(),
      payoutDate: '2026-11-20',
      payoutAmount: 89_000,
      status: 'NOTIFIED',
      disputeDueAt: new Date(NOW.getTime() - 1),
    });
    expect((await settlements.confirmDueStatements()).confirmed).toBe(1);

    const audits = await db.pool.query('select statement_id, from_status, to_status, reason, actor from settlement_statement_audit order by created_at, id');
    expect(audits.rows).toEqual(
      expect.arrayContaining([
        { statement_id: heldId, from_status: 'HELD', to_status: 'CONFIRMED', reason: 'kyc-cleared', actor: 'ops-a1v' },
        { statement_id: disputedId, from_status: 'DISPUTED', to_status: 'NOTIFIED', reason: 'dispute-dismissed', actor: csLead },
        { statement_id: autoId, from_status: 'NOTIFIED', to_status: 'CONFIRMED', reason: 'dispute-window-ended', actor: 'system' },
      ]),
    );
  });
});

describe('CONS-V01 Drizzle insertStatement 충돌 경로', () => {
  test('같은 회차 정산서의 두 번째 insert는 0행을 돌려주고 원본 목록도 쓰지 않는다', async () => {
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
    expect(await store.insertStatement(first, [])).toBe(true);
    const secondSource = { statementId: second.statementId, sourceId: randomUUID(), kind: 'GROSS' as const, paymentId: randomUUID(), amount: 1000 };
    expect(await store.insertStatement(second, [secondSource])).toBe(false);

    const count = await db.pool.query('select count(*)::int as n from settlement_statement where promoter_id = $1 and event_id = $2 and status <> $3', [promoterId, eventId, 'SUPERSEDED']);
    expect(count.rows[0].n).toBe(1);
    const sources = await db.pool.query('select count(*)::int as n from statement_source where statement_id = $1', [second.statementId]);
    expect(sources.rows[0].n).toBe(0);
  });
});
