// F-07-8 정산 다시 계산·계산 뒤 환급 미수금의 실제 PostgreSQL 시험(GAT-120·GAT-130, ADR-0380, docs/features/settlement.md §4.1·§7·§13 J-T11·J-T23).
// A 등급(돈) 경로를 실제 DB로 본다:
// - J-T11: 실제 payment·payment_cancel 원장에서 계산 뒤 환급 미수금 한 행(칸 다섯·근거 부분 유일), 두 연결 겹친 tick에도 한 행(F-18), PEAKET 부담 0행.
// - J-T23 ①: 새 판·옛 판 SUPERSEDED·원본 목록·사건이 한 트랜잭션(원본 넣기를 실패시키면 모두 없음, F-10), 완료 두 번 겹침에 새 판 하나(F-22),
//   음수 옛 판 미수금 닫기와 상계 묶음이 겹쳐도 이동 합이 미수금을 넘지 않음(F-25).
// - J-T23 ②: 묶음 빼기·되돌림·보류·사건이 한 트랜잭션(되돌림 쓰기를 실패시키면 모두 없음, F-11), 보류 열기와 묶음 만들기 겹침(F-19),
//   같은 배상 미수금을 결제사가 다른 두 새 판이 겹쳐 상계(F-20).
// 겹침은 두 연결(두 '파드')로 같은 DB에 동시에 부른다. 실패 주입은 시험 안 트리거다(실행 뒤 지운다). 결제사·은행은 부르지 않는다.
// 기준 트리: 0033 마이그레이션(새 칸·표)과 새 메서드가 없어 실패한다(계획 §7).
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { DrizzleSettlementPaymentSource, DrizzleSettlementStore, ManualPortonePayoutGateway, MemoryReauthVerifier, Settlements, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { noApprovals, noSaleSuspensions } from '../test/settlement-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

/** 2026-11-23(월) 10:00 KST */
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
/** 2026-11-27(금) 10:00 KST */
const FRIDAY = Date.parse('2026-11-27T01:00:00.000Z');
const DAY = 86_400_000;

let pgc: PostgresContainer;
let db1: Database;
let db2: Database;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  db1 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f078-pod-a' });
  db2 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f078-pod-b' });
  await ensureOutboxPartitions(db1, fakeClock({ now: NOW - 2 * DAY }), { daysAhead: 21 });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([db1?.close(), db2?.close()]);
  pgc?.stop();
});

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await db1.pool.query<T>(text, values)).rows;

/** 같은 DB를 보는 두 파드. 시계는 같이 민다 */
function pods(now = NOW) {
  const clock: FakeClock = fakeClock({ now });
  const make = (database: Database) =>
    new Settlements({
      store: new DrizzleSettlementStore(database, clock),
      payments: new DrizzleSettlementPaymentSource(database),
      eventCommission: { rateBp: async () => 850 },
      approvals: noApprovals,
      saleSuspensions: noSaleSuspensions,
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      clock,
    });
  return { clock, a: make(db1), b: make(db2), at: (t: number) => clock.advance(t - clock.now()) };
}

/** 결제 원장 한 행(승인됨). 누적 취소는 cancelled로 */
async function paymentRow(o: { eventId: string; amount: number; cancelled?: number; pg?: 'TOSS' | 'PORTONE'; pgStore?: 'STANDARD' | 'ESCROW' }): Promise<string> {
  const id = randomUUID();
  const cancelled = o.cancelled ?? 0;
  await db1.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_store, pg_payment_ref, amount, cancelled_amount, status, failure_category, idempotency_key, authenticated_at, status_changed_at, approved_at)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, null, $11, $12, $12, $12)`,
    [id, randomUUID(), o.eventId, randomUUID(), o.pg ?? 'TOSS', o.pgStore ?? 'STANDARD', `ref-${id}`, o.amount, cancelled, cancelled === 0 ? 'APPROVED' : 'PARTIAL_CANCELED', `idem-${id}`, new Date(NOW - 10 * DAY)],
  );
  return id;
}

/** 끝난 결제 취소 한 행과 결제의 누적 취소액. burden을 주면 settlement_burden 칸을 쓴다(0033) */
async function cancelRow(paymentId: string, o: { amount: number; canceledAt: number; burden?: 'PARTNER' | 'PEAKET' }): Promise<void> {
  const before = (await q<{ amount: number; cancelled_amount: number }>('select amount, cancelled_amount from payment where id = $1', [paymentId]))[0]!;
  const id = randomUUID();
  await db1.pool.query(
    `insert into payment_cancel (id, payment_id, idempotency_key, attempt, amount, reason, full_cancel, expected_balance, status, created_at, canceled_at${o.burden ? ', settlement_burden' : ''})
     values ($1, $2, $3, 0, $4, 'EVENT_CANCELLED', false, $5, 'CANCELED', $6, $6${o.burden ? ', $7' : ''})`,
    [id, paymentId, `cancel-${id}`, o.amount, before.amount - before.cancelled_amount, new Date(o.canceledAt), ...(o.burden ? [o.burden] : [])],
  );
  await db1.pool.query("update payment set cancelled_amount = cancelled_amount + $2, status = 'PARTIAL_CANCELED' where id = $1", [paymentId, o.amount]);
}

const refundReceivables = (statementId: string) =>
  q<{ id: string; pg: string | null; cause: string; statement_id: string; commission_rate_bp: number; refund_amount: number; commission_share: number; commission_vat_share: number; amount: number; remaining: number; source_ref: string }>(
    "select id, pg, cause, statement_id, commission_rate_bp, refund_amount, commission_share, commission_vat_share, amount, remaining, source_ref from partner_receivable where cause = 'REFUND_AFTER_PAYOUT' and statement_id = $1",
    [statementId],
  );

describe('J-T11 계산 뒤 환급 미수금 [실제 PostgreSQL]', () => {
  test('J-T11 ② 지급한 정산서의 토스 결제분 50만 원 환불 → 미수금 1행(칸 다섯·근거), 두 연결이 겹쳐 tick해도 1행이다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = pods();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const pay = await paymentRow({ eventId, amount: 30_000_000 });
    await cancelRow(pay, { amount: 2_000_000, canceledAt: NOW - 5 * DAY });
    const s = await p.a.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(s).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_000_000 });
    expect((await q<{ commission_rate_bp: number }>('select commission_rate_bp from settlement_statement where id = $1', [s.statementId]))[0]!.commission_rate_bp).toBe(850);
    await db1.pool.query("update settlement_statement set status = 'PAID' where id = $1", [s.statementId]);
    p.at(NOW + 60_000);
    await cancelRow(pay, { amount: 500_000, canceledAt: NOW + 30_000 });
    const [ra, rb] = await Promise.all([p.a.recordRefundsAfterCalculation(), p.b.recordRefundsAfterCalculation()]);
    expect(ra.created + rb.created).toBe(1);
    expect(await refundReceivables(s.statementId)).toEqual([
      expect.objectContaining({ pg: 'TOSS', commission_rate_bp: 850, refund_amount: 500_000, commission_share: 42_500, commission_vat_share: 4_250, amount: 453_250, remaining: 453_250, source_ref: `refund:${s.statementId}:${pay}:2500000` }),
    ]);
    p.at(NOW + 31 * 60_000);
    await p.a.recordRefundsAfterCalculation();
    expect(await refundReceivables(s.statementId)).toHaveLength(1);
  });

  test('J-T11 ② 부분 유일 인덱스가 같은 근거의 두 번째 미수금을 막는다(합 가드와 겹친 가드 중 하나)', async () => {
    const idx = (await q<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'partner_receivable' and indexdef ilike '%source_ref%'"))[0];
    expect(idx?.indexdef).toContain('UNIQUE');
    const promoterId = randomUUID();
    const ref = `refund:${randomUUID()}:${randomUUID()}:500000`;
    const insert = () =>
      db1.pool.query("insert into partner_receivable (id, promoter_id, pg, cause, source_ref, amount, remaining, status, created_at, updated_at) values ($1, $2, 'TOSS', 'REFUND_AFTER_PAYOUT', $3, 1, 1, 'OPEN', now(), now())", [randomUUID(), promoterId, ref]);
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test('J-T11 ② PEAKET 부담 결제 취소(settlement_burden = PEAKET)는 미수금 0행이다', async () => {
    const p = pods();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const pay = await paymentRow({ eventId, amount: 30_000_000 });
    const s = await p.a.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    await db1.pool.query("update settlement_statement set status = 'PAID' where id = $1", [s.statementId]);
    p.at(NOW + 60_000);
    await cancelRow(pay, { amount: 500_000, canceledAt: NOW + 30_000, burden: 'PEAKET' });
    await p.a.recordRefundsAfterCalculation();
    expect(await refundReceivables(s.statementId)).toEqual([]);
  });
});

/** 세 회차 정산서를 계산하고(토스 일반·포트원) 다시 계산 보류를 연다 */
async function recalcWorld(p: ReturnType<typeof pods>) {
  const promoterId = randomUUID();
  const eventId = randomUUID();
  const payT = await paymentRow({ eventId, amount: 10_000_000 });
  const payP = await paymentRow({ eventId, amount: 10_000_000, pg: 'PORTONE' });
  const sT = await p.a.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
  const sP = await p.a.calculateEvent({ promoterId, eventId, pg: 'PORTONE', pgStore: 'STANDARD' });
  const requestId = randomUUID();
  await p.a.openEventRecalculation({ requestId, eventId, kind: 'CANCEL', confirmedAt: new Date(p.clock.now()) });
  return { promoterId, eventId, payT, payP, sT, sP, requestId };
}

const statementsOf = (eventId: string) => q<{ id: string; status: string; revision: number; supersedes_id: string | null }>('select id, status, revision, supersedes_id from settlement_statement where event_id = $1 order by revision, id', [eventId]);

describe('J-T23 ① 새 판·옛 판·원본 목록이 한 트랜잭션 [실제 PostgreSQL]', () => {
  test('J-T23 ① 새 판의 원본 목록 넣기를 실패시키면 새 판·옛 판 SUPERSEDED·사건이 모두 없고, 걷은 뒤 다시 부르면 판 2가 생긴다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = pods();
    const w = await recalcWorld(p);
    await cancelRow(w.payT, { amount: 4_000_000, canceledAt: NOW + 60_000 });
    p.at(FRIDAY);
    const olds = [w.sT.statementId, w.sP.statementId];
    await db1.pool.query(
      `create or replace function f078_fail_new_source() returns trigger language plpgsql as $f$ begin if not (new.statement_id = any (array['${olds.join("','")}']::uuid[])) then raise exception 'f078 statement_source insert failed'; end if; return new; end $f$`,
    );
    await db1.pool.query('create trigger f078_fail_new_source before insert on statement_source for each row execute function f078_fail_new_source()');
    try {
      await p.a.completeEventRecalculation(w.requestId, { completedAt: new Date(FRIDAY) }).catch(() => undefined);
      expect((await statementsOf(w.eventId)).map((r) => [r.status, r.revision])).toEqual([
        ['NOTIFIED', 1],
        ['NOTIFIED', 1],
      ]);
      const notified = await q<{ n: string }>("select count(*) as n from outbox where convert_from(payload, 'UTF8') like '%\"revision\":2%' and convert_from(payload, 'UTF8') like $1", [`%${w.eventId}%`]);
      expect(Number(notified[0]!.n)).toBe(0);
      expect((await q<{ state: string }>('select state from settlement_recalculation where request_id = $1', [w.requestId]))[0]!.state).toBe('PENDING');
    } finally {
      await db1.pool.query('drop trigger if exists f078_fail_new_source on statement_source');
      await db1.pool.query('drop function if exists f078_fail_new_source()');
    }
    const done = await p.a.completeEventRecalculation(w.requestId, { completedAt: new Date(FRIDAY) });
    expect(done.state).toBe('DONE');
    const rows = await statementsOf(w.eventId);
    expect(rows.filter((r) => r.status === 'SUPERSEDED').map((r) => r.id).sort()).toEqual([...olds].sort());
    expect(rows.filter((r) => r.revision === 2).map((r) => r.supersedes_id).sort()).toEqual([...olds].sort());
    const newToss = rows.find((r) => r.revision === 2 && r.supersedes_id === w.sT.statementId)!;
    expect((await q<{ kind: string; amount: number }>('select kind, amount from statement_source where statement_id = $1 order by kind', [newToss.id])).map((r) => [r.kind, r.amount])).toEqual([
      ['GROSS', 10_000_000],
      ['REFUND', 4_000_000],
    ]);
  });

  test('J-T23 ① 두 파드가 완료를 겹쳐 불러도 옛 판마다 새 판은 하나다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = pods();
    const w = await recalcWorld(p);
    p.at(FRIDAY);
    const [a, b] = await Promise.allSettled([p.a.completeEventRecalculation(w.requestId, { completedAt: new Date(FRIDAY) }), p.b.completeEventRecalculation(w.requestId, { completedAt: new Date(FRIDAY) })]);
    expect([a.status, b.status]).toContain('fulfilled');
    const rows = await statementsOf(w.eventId);
    expect(rows.filter((r) => r.revision === 2)).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'SUPERSEDED')).toHaveLength(2);
  });
});

describe('J-T23 ② 묶음 빼기·되돌림·보류가 한 트랜잭션 [실제 PostgreSQL]', () => {
  /** 묶음(승인 대기)에 묶인 접수 전 CONFIRMED 정산서와 상계 10만 원 */
  async function batched(eventId: string) {
    const promoterId = randomUUID();
    const batchId = randomUUID();
    const statementId = randomUUID();
    const receivableId = randomUUID();
    const at = new Date(NOW - DAY);
    await db1.pool.query("insert into payout_batch (id, pg, pg_store, payout_date, total_amount, statement_count, status, created_at, updated_at) values ($1, 'TOSS', 'STANDARD', '2026-12-10', 18030000, 2, 'PENDING_APPROVAL', $2, $2)", [batchId, at]);
    // 같은 묶음의 다른 회차 정산서(그대로 남아야 한다)
    await db1.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, payout_amount, commission_rate_bp, status, payout_date, payout_batch_id, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'TOSS', 'STANDARD', 10000000, 0, 850000, 85000, 0, 9065000, 850, 'CONFIRMED', '2026-12-10', $4, $5, $5)`,
      [randomUUID(), randomUUID(), randomUUID(), batchId, at],
    );
    await db1.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, payout_amount, commission_rate_bp, status, payout_date, payout_batch_id, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'TOSS', 'STANDARD', 10000000, 0, 850000, 85000, 100000, 8965000, 850, 'CONFIRMED', '2026-12-10', $4, $5, $5)`,
      [statementId, promoterId, eventId, batchId, at],
    );
    await db1.pool.query("insert into partner_receivable (id, promoter_id, pg, cause, amount, remaining, status, created_at, updated_at) values ($1, $2, 'TOSS', 'REFUND_AFTER_PAYOUT', 100000, 0, 'CLOSED', $3, $3)", [receivableId, promoterId, at]);
    const moveId = randomUUID();
    await db1.pool.query("insert into receivable_movement (id, receivable_id, statement_id, amount, kind, moved_at) values ($1, $2, $3, 100000, 'OFFSET', $4)", [moveId, receivableId, statementId, at]);
    return { promoterId, batchId, statementId, receivableId, moveId };
  }
  const snapshot = async (x: { batchId: string; statementId: string; receivableId: string }) => ({
    statement: (await q('select status, hold_reason, payout_batch_id, offset_amount, payout_amount from settlement_statement where id = $1', [x.statementId]))[0],
    batch: (await q('select total_amount, statement_count from payout_batch where id = $1', [x.batchId]))[0],
    receivable: (await q('select remaining, status from partner_receivable where id = $1', [x.receivableId]))[0],
    moves: await q('select kind, amount from receivable_movement where receivable_id = $1 order by moved_at, kind', [x.receivableId]),
    held: Number((await q<{ n: string }>(`select count(*) as n from outbox where convert_from(payload, 'UTF8') like '%PAYOUT_HELD%' and convert_from(payload, 'UTF8') like '%${x.statementId}%'`))[0]!.n),
  });

  test('J-T23 ② 되돌림 쓰기를 실패시키면 묶음·정산서·미수금·이동·사건이 모두 그대로이고, 걷은 뒤 같은 요청으로 다시 열면 한 번에 된다 [ASVS v5.0.0-2.3.3]', async () => {
    const p = pods();
    const eventId = randomUUID();
    await paymentRow({ eventId, amount: 10_000_000 });
    const x = await batched(eventId);
    const before = await snapshot(x);
    await db1.pool.query(`create or replace function f078_fail_reversal() returns trigger language plpgsql as $f$ begin if new.kind = 'REVERSAL' then raise exception 'f078 reversal insert failed'; end if; return new; end $f$`);
    await db1.pool.query('create trigger f078_fail_reversal before insert on receivable_movement for each row execute function f078_fail_reversal()');
    const requestId = randomUUID();
    try {
      await p.a.openEventRecalculation({ requestId, eventId, kind: 'CANCEL', confirmedAt: new Date(NOW) }).catch(() => undefined);
      expect(await snapshot(x)).toEqual(before);
    } finally {
      await db1.pool.query('drop trigger if exists f078_fail_reversal on receivable_movement');
      await db1.pool.query('drop function if exists f078_fail_reversal()');
    }
    await p.a.openEventRecalculation({ requestId, eventId, kind: 'CANCEL', confirmedAt: new Date(NOW) });
    await p.a.retryEventRecalculations();
    const after = await snapshot(x);
    expect(after.statement).toMatchObject({ status: 'HELD', hold_reason: 'RECALCULATION', payout_batch_id: null, offset_amount: 0, payout_amount: 9_065_000 });
    expect(after.batch).toMatchObject({ total_amount: 9_065_000, statement_count: 1 });
    expect(after.receivable).toMatchObject({ remaining: 100_000, status: 'OPEN' });
    expect(after.moves.map((m) => [m.kind, Number(m.amount)])).toEqual([
      ['OFFSET', 100_000],
      ['REVERSAL', 100_000],
    ]);
    expect(after.held).toBe(1);
    const reversal = (await q<{ reverses_id: string }>("select reverses_id from receivable_movement where receivable_id = $1 and kind = 'REVERSAL'", [x.receivableId]))[0]!;
    expect(reversal.reverses_id).toBe(x.moveId);
  });

  // F-19: 보류 열기와 지급 묶음 만들기가 같은 정산서에 겹침 → 묶이거나 보류되거나 하나, 묶였으면 되돌림
  test('J-T23 ② 보류 열기와 지급 묶음 만들기를 두 파드가 겹쳐 불러도 그 회차 정산서는 끝에 HELD(RECALCULATION)·묶음 없음이고 이동 합 불변식이 지켜진다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = pods();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const statementId = randomUUID();
    const receivableId = randomUUID();
    const at = new Date(NOW - DAY);
    await paymentRow({ eventId, amount: 10_000_000 });
    await db1.pool.query("insert into seller_kyc (promoter_id, status, business_verified, representative_verified, verified_at, source, updated_at) values ($1, 'VERIFIED', true, true, $2, 'MANUAL', $2)", [promoterId, at]);
    await db1.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, payout_amount, commission_rate_bp, status, payout_date, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'PORTONE', 'STANDARD', 10000000, 0, 850000, 85000, 0, 9065000, 850, 'CONFIRMED', '2026-12-11', $4, $4)`,
      [statementId, promoterId, eventId, at],
    );
    await db1.pool.query("insert into partner_receivable (id, promoter_id, pg, cause, source_ref, amount, remaining, status, created_at, updated_at) values ($1, $2, null, 'COMPENSATION_ADVANCE', $3, 200000, 200000, 'OPEN', $4, $4)", [receivableId, promoterId, `compensation:${randomUUID()}`, at]);
    await Promise.allSettled([
      p.a.openEventRecalculation({ requestId: randomUUID(), eventId, kind: 'CANCEL', confirmedAt: new Date(NOW) }),
      p.b.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: '2026-12-11', portoneBalance: { amount: 100_000_000_000, observedAt: new Date(NOW).toISOString() }, actor: randomUUID() }),
    ]);
    await p.a.retryEventRecalculations();
    expect((await q('select status, hold_reason, payout_batch_id from settlement_statement where id = $1', [statementId]))[0]).toEqual({ status: 'HELD', hold_reason: 'RECALCULATION', payout_batch_id: null });
    const r = (await q<{ amount: number; remaining: number }>('select amount, remaining from partner_receivable where id = $1', [receivableId]))[0]!;
    const moves = await q<{ kind: string; amount: number }>('select kind, amount from receivable_movement where receivable_id = $1', [receivableId]);
    const out = moves.filter((m) => m.kind !== 'REVERSAL').reduce((n, m) => n + m.amount, 0);
    const back = moves.filter((m) => m.kind === 'REVERSAL').reduce((n, m) => n + m.amount, 0);
    expect(r.remaining).toBe(r.amount - out + back);
    expect(r.remaining).toBe(200_000);
  });
});

describe('J-T23 ① 음수 옛 판 미수금 닫기와 상계 겹침 [실제 PostgreSQL] (F-25)', () => {
  test('J-T23 ① 음수 미수금을 다른 정산서 묶음이 상계하는 동안 다시 계산이 닫아도, 상계 + 닫기 = 30만 원이고 새 판 조정 합에 돌려받은 금액이 더해진다 [ASVS v5.0.0-2.3.4]', async () => {
    const p = pods();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const at = new Date(NOW - 10 * DAY);
    const pay = await paymentRow({ eventId, amount: 1_000_000, pg: 'PORTONE' });
    await db1.pool.query("insert into seller_kyc (promoter_id, status, business_verified, representative_verified, verified_at, source, updated_at) values ($1, 'VERIFIED', true, true, $2, 'MANUAL', $2)", [promoterId, at]);
    // 옛 판: 판매 100만·수수료율 0bp·조정 −130만 → 지급액 −30만, CARRIED_OVER
    const oldId = randomUUID();
    await db1.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, adjustment_amount, payout_amount, commission_rate_bp, status, payout_date, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'PORTONE', 'STANDARD', 1000000, 0, 0, 0, 0, -1300000, -300000, 0, 'CARRIED_OVER', '2026-11-20', $4, $4)`,
      [oldId, promoterId, eventId, at],
    );
    await db1.pool.query("insert into statement_source (statement_id, source_id, kind, payment_id, amount) values ($1, $2, 'GROSS', $2, 1000000)", [oldId, pay]);
    const negativeId = randomUUID();
    await db1.pool.query("insert into partner_receivable (id, promoter_id, pg, cause, event_id, source_ref, amount, remaining, status, created_at, updated_at) values ($1, $2, 'PORTONE', 'NEGATIVE_STATEMENT', $3, $4, 300000, 300000, 'OPEN', $5, $5)", [negativeId, promoterId, eventId, `negative-statement:${oldId}`, at]);
    // 같은 파트너의 다른 포트원 정산서(지급액 100만 원) — 먼저 묶이면 음수 미수금 30만 원을 상계한다
    const otherId = randomUUID();
    await db1.pool.query(
      `insert into settlement_statement (id, promoter_id, kind, event_id, pg, pg_store, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, payout_amount, commission_rate_bp, status, payout_date, created_at, updated_at)
       values ($1, $2, 'EVENT', $3, 'PORTONE', 'STANDARD', 1000000, 0, 0, 0, 0, 1000000, 0, 'CONFIRMED', '2026-12-14', $4, $4)`,
      [otherId, promoterId, randomUUID(), at],
    );
    const requestId = randomUUID();
    await p.a.openEventRecalculation({ requestId, eventId, kind: 'CANCEL', confirmedAt: new Date(NOW) });
    p.at(FRIDAY);
    const [batch, done] = await Promise.allSettled([
      p.b.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: '2026-12-14', portoneBalance: { amount: 100_000_000_000, observedAt: new Date(FRIDAY).toISOString() }, actor: randomUUID() }),
      p.a.completeEventRecalculation(requestId, { completedAt: new Date(FRIDAY) }),
    ]);
    expect(done.status).toBe('fulfilled');
    expect(['fulfilled', 'rejected']).toContain(batch.status);
    const moves = await q<{ kind: string; amount: number }>('select kind, amount from receivable_movement where receivable_id = $1', [negativeId]);
    const offset = moves.filter((m) => m.kind === 'OFFSET').reduce((n, m) => n + m.amount, 0);
    const closed = moves.filter((m) => m.kind === 'SUPERSEDED').reduce((n, m) => n + m.amount, 0);
    expect(offset + closed).toBe(300_000);
    expect((await q('select remaining, status from partner_receivable where id = $1', [negativeId]))[0]).toEqual({ remaining: 0, status: 'CLOSED' });
    const fresh = (await q<{ adjustment_amount: number; payout_amount: number }>("select adjustment_amount, payout_amount from settlement_statement where supersedes_id = $1 and status <> 'SUPERSEDED'", [oldId]))[0]!;
    expect(fresh.adjustment_amount).toBe(-1_300_000 + offset);
    expect(fresh.payout_amount).toBe(-300_000 + offset);
    // 열린 음수 미수금은 옛 판 것이 없다(새 판 확정 전)
    expect(await q("select id from partner_receivable where promoter_id = $1 and cause = 'NEGATIVE_STATEMENT' and status <> 'CLOSED'", [promoterId])).toEqual([]);
  });
});
