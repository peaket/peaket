// F-07-5 정산서 통지·이의·확정·수기 조정의 실제 PostgreSQL 시험(LCH-100, ADR-0368, docs/features/settlement.md §4.2·§4.3·§6·§13).
// A 등급(돈) 경로를 실제 DB로 본다: 계산·통지·Outbox 한 트랜잭션(J-T35 ①), 이의와 자동 확정 겹침(J-T35 ⑥, 두 연결·두 차례),
// 모두 보류된 묶음의 HELD 저장(J-T35 ⑨), 조정 적용 한 트랜잭션·재적용 한 번(J-T36 ⑤), 조정 적용과 지급 묶음 겹침(J-T36 ⑥),
// 지급 요청 뒤 조정 금지·2인 대조(J-T36 ③·④), 음수 정산서 미수금 한 행(J-T36 ⑦·J-T12), 마이그레이션 0027의 제약.
// 겹침은 세 번째 연결이 정산서 행을 잠근 채 두 전이를 차례로 대기열에 넣고(pg_stat_activity로 대기 확인), 잠금을 풀어 먼저 줄 선 쪽이 이기게 한다.
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import {
  DrizzleSettlementStore,
  ManualPortonePayoutGateway,
  MemoryReauthVerifier,
  MemorySettlementPaymentSource,
  Settlements,
  UnavailableTossPayoutGateway,
  type AdjustmentApprovalVerifier,
  type PaymentFact,
  type SettlementCaseNotice,
  type VerifiedAdjustmentApproval,
} from '../src/modules/settlement/index.js';
import type { SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

/** 2026-11-18(수) 10:00 KST. 정본 §4.2: 이의 기한 = + 2영업일 = 2026-11-20(금) 10:00 KST */
const NOTIFY_AT = Date.parse('2026-11-18T01:00:00.000Z');
const DUE_AT = Date.parse('2026-11-20T01:00:00.000Z');
/** 2026-11-19(목) 15:00 KST, + 1영업일 = 2026-11-20(금) 15:00 KST */
const APPLY_AT = Date.parse('2026-11-19T06:00:00.000Z');
const APPLY_DUE = Date.parse('2026-11-20T06:00:00.000Z');

let pgc: PostgresContainer;
let db1: Database;
let db2: Database;
let locker: pg.Client;

const noApprovals = { verify: async () => undefined };
const noSuspensions: SaleSuspensionSource = { listSuspended: async () => new Set() };

class Approvals implements AdjustmentApprovalVerifier {
  readonly rows = new Map<string, VerifiedAdjustmentApproval>();
  async verify(id: string) {
    return this.rows.get(id);
  }
}
class Cases implements SettlementCaseNotice {
  readonly opened: string[] = [];
  async openDispute(o: { disputeId: string }) {
    this.opened.push(o.disputeId);
  }
}

const fact = (o: Partial<PaymentFact> = {}): PaymentFact => ({ paymentId: randomUUID(), amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED', failureCategory: null, ...o });

/** 같은 DB를 보는 두 '파드'. 시계는 따로라 이의 파드(기한 전)와 확정 파드(기한 뒤)를 겹칠 수 있다 */
function pods() {
  const payments = new MemorySettlementPaymentSource();
  const approvals = new Approvals();
  const cases = new Cases();
  const make = (database: Database, clock: ReturnType<typeof fakeClock>) =>
    new Settlements({
      store: new DrizzleSettlementStore(database, clock),
      payments,
      eventCommission: { rateBp: async () => 1000 },
      approvals: noApprovals,
      saleSuspensions: noSuspensions,
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      clock,
      caseNotice: cases,
      adjustmentApprovals: approvals,
    });
  const c1 = fakeClock({ now: NOTIFY_AT });
  const c2 = fakeClock({ now: NOTIFY_AT });
  return { payments, approvals, cases, c1, c2, a: make(db1, c1), b: make(db2, c2), store: new DrizzleSettlementStore(db1, c1) };
}
type Pods = ReturnType<typeof pods>;
const at = (c: ReturnType<typeof fakeClock>, t: number) => c.advance(t - c.now());

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await db1.pool.query<T>(text, values)).rows;
const statementRow = async (id: string) => (await q<Record<string, unknown>>('select status, hold_reason, gross_amount, refund_amount, commission_amount, commission_vat, offset_amount, adjustment_amount, payout_amount, payout_batch_id, dispute_due_at from settlement_statement where id = $1', [id]))[0];
const outboxOf = async (statementId: string) =>
  (await q<{ topic: string; msg_key: string; payload: Buffer }>('select topic, msg_key, payload from outbox order by seq')).map((r) => ({ topic: r.topic, key: r.msg_key, value: JSON.parse(r.payload.toString('utf8')) as Record<string, unknown> })).filter((r) => r.value.statementId === statementId);
const auditsOf = async (statementId: string) => (await q<{ from_status: string; to_status: string }>('select from_status, to_status from settlement_statement_audit where statement_id = $1 order by created_at, id', [statementId])).map((r) => `${r.from_status}→${r.to_status}`);

/** 지급 묶음을 만드는 시험은 회차 종료일을 달리 줘 지급일이 겹치지 않게 한다(같은 DB를 시험이 나눠 쓴다) */
const notified = async (p: Pods, o: { promoterId?: string; gross?: number; refund?: number; kyc?: 'VERIFIED' | 'PENDING'; eventEndsAt?: string } = {}) => {
  const promoterId = o.promoterId ?? randomUUID();
  const eventId = randomUUID();
  await p.a.recordKyc(promoterId, o.kyc ?? 'VERIFIED');
  p.payments.set(eventId, 'TOSS', [fact({ amount: o.gross ?? 30_000_000, cancelledAmount: o.refund ?? 2_000_000, status: (o.refund ?? 2_000_000) > 0 ? 'PARTIAL_CANCELED' : 'APPROVED' })]);
  return { ...(await p.a.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD', ...(o.eventEndsAt ? { eventEndsAt: o.eventEndsAt } : {}) })), promoterId, eventId };
};

/** 세 번째 연결이 정산서 행을 잠근다. 풀기 전까지 전이는 줄을 선다 */
const lockStatement = async (id: string) => {
  await locker.query('begin');
  await locker.query('select id from settlement_statement where id = $1 for update', [id]);
  return async () => {
    await locker.query('commit');
  };
};
/** 그 응용 이름의 연결이 행 잠금을 기다리는 수 */
const waitingOn = async (app: string): Promise<number> => Number((await q<{ n: string }>("select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [app]))[0]!.n);
const untilWaiting = async (app: string, n = 1) => {
  for (let i = 0; i < 500; i += 1) {
    if ((await waitingOn(app)) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${app} 연결이 잠금을 기다리지 않았다`);
};

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  db1 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f075-pod-a' });
  db2 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f075-pod-b' });
  await ensureOutboxPartitions(db1, fakeClock({ now: NOTIFY_AT }), { daysAhead: 14 });
  locker = new pg.Client({ connectionString: pgc.url, application_name: 'f075-locker' });
  await locker.connect();
  await db1.pool.query(`
    create schema test_hooks;
    create table test_hooks.fail_outbox_key (msg_key text primary key);
    create function test_hooks.fail_outbox() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_outbox_key f where f.msg_key = new.msg_key) then raise exception 'test-forced-outbox-failure'; end if;
      return new;
    end $f$;
    create trigger test_fail_outbox before insert on public.outbox for each row execute function test_hooks.fail_outbox();
  `);
}, 180_000);

afterAll(async () => {
  await locker?.end();
  await db1?.close();
  await db2?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await db1.pool.query('delete from test_hooks.fail_outbox_key');
});

describe('마이그레이션 0027', () => {
  test('J-T36 ⑤ 0027이 조정 합계 칸·이의 처리 칸·조정 표를 만들고 다시 적용해도 같다', async () => {
    const cols = await q<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      "select table_name, column_name, is_nullable, column_default from information_schema.columns where (table_name = 'settlement_statement' and column_name = 'adjustment_amount') or (table_name = 'statement_dispute' and column_name in ('resolved_by','resolution_note','case_requested_at')) order by table_name, column_name",
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`)).toEqual([
      'settlement_statement.adjustment_amount:NO',
      'statement_dispute.case_requested_at:YES',
      'statement_dispute.resolution_note:YES',
      'statement_dispute.resolved_by:YES',
    ]);
    expect(cols[0]!.column_default).toBe('0');
    const table = await q<{ n: string }>("select count(*) as n from information_schema.tables where table_name = 'statement_adjustment'");
    expect(table[0]!.n).toBe('1');
    await expect(migratePayment(pgc.url)).resolves.toBeUndefined();
  });

  test('J-T36 ②·③ 0027 제약: 금액 0·사유 코드 밖·근거 메모 2,001자·적용 시각 없는 APPLIED·한 정산서의 두 PENDING·같은 승인 ID를 막는다', async () => {
    const p = pods();
    const s = await notified(p);
    const row = (o: Record<string, unknown> = {}) => ({ id: randomUUID(), approval: randomUUID(), code: 'LEDGER_ERROR', amount: -1_000, note: '정정', status: 'VOID', applied: null as Date | null, ...o });
    const insert = (r: ReturnType<typeof row>) =>
      db1.pool.query('insert into statement_adjustment (id, statement_id, approval_id, reason_code, amount, evidence_note, status, requested_by, requested_at, applied_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [r.id, s.statementId, r.approval, r.code, r.amount, r.note, r.status, randomUUID(), new Date(NOTIFY_AT), r.applied]);
    await expect(insert(row({ amount: 0 }))).rejects.toThrow(/statement_adjustment_amount_check/);
    await expect(insert(row({ code: 'PAYOUT_FIX' }))).rejects.toThrow(/statement_adjustment_reason_check/);
    await expect(insert(row({ note: '가'.repeat(2_001) }))).rejects.toThrow(/statement_adjustment_note_check/);
    await expect(insert(row({ status: 'APPLIED' }))).rejects.toThrow(/statement_adjustment_applied_check/);
    await expect(insert(row({ note: '가'.repeat(2_000) }))).resolves.toBeDefined();
    await insert(row({ status: 'PENDING' }));
    await expect(insert(row({ status: 'PENDING' }))).rejects.toThrow(/statement_adjustment_pending_uidx/);
    const approval = randomUUID();
    await insert(row({ approval }));
    await expect(insert(row({ approval }))).rejects.toThrow(/statement_adjustment_approval_uidx/);
    await expect(db1.pool.query("update statement_dispute set resolution_note = '' where false")).resolves.toBeDefined();
  });
});

describe('J-T35 ① 계산·통지·Outbox 한 트랜잭션', () => {
  test('[ASVS v5.0.0-2.3.3] J-T35 ① 정산서 NOTIFIED·감사 한 줄·trade.settlements STATEMENT_NOTIFIED 한 행(키 = 파트너 ID)이 함께 남는다', async () => {
    const p = pods();
    const s = await notified(p);
    const r = await statementRow(s.statementId);
    expect(r).toMatchObject({ status: 'NOTIFIED', hold_reason: null, gross_amount: '30000000', refund_amount: '2000000', commission_amount: '2800000', payout_amount: '24920000', adjustment_amount: '0' });
    expect((r!.dispute_due_at as Date).getTime()).toBe(DUE_AT);
    expect(await auditsOf(s.statementId)).toEqual(['CALCULATED→NOTIFIED']);
    const out = await outboxOf(s.statementId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ topic: 'trade.settlements', key: s.promoterId, value: { type: 'STATEMENT_NOTIFIED', kind: 'EVENT', eventId: s.eventId, pg: 'TOSS', pgStore: 'STANDARD', salesAmount: 30_000_000, refundAmount: 2_000_000, feeAmount: 2_800_000, revision: 1, supersedesId: null } });
  });

  test('J-T35 ① Outbox 쓰기가 실패하면 정산서·원본 목록·감사도 남지 않는다(사건을 트랜잭션 밖에 쓰지 않는다)', async () => {
    const p = pods();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await p.a.recordKyc(promoterId, 'VERIFIED');
    p.payments.set(eventId, 'TOSS', [fact()]);
    await db1.pool.query('insert into test_hooks.fail_outbox_key values ($1)', [promoterId]);
    await expect(p.a.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' })).rejects.toThrow();
    expect(await q('select id from settlement_statement where promoter_id = $1', [promoterId])).toEqual([]);
    expect(await q('select s.statement_id from statement_source s join settlement_statement t on t.id = s.statement_id where t.promoter_id = $1', [promoterId])).toEqual([]);
    expect((await q<{ n: string }>('select count(*) as n from outbox where msg_key = $1', [promoterId]))[0]!.n).toBe('0');
    // 장애가 풀리면 같은 회차를 다시 계산해 한 장·사건 한 건이 된다
    await db1.pool.query('delete from test_hooks.fail_outbox_key');
    const s = await p.a.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(await outboxOf(s.statementId)).toHaveLength(1);
  });
});

describe('J-T35 ⑥ 이의와 자동 확정 겹침', () => {
  const overlap = async (first: 'dispute' | 'confirm') => {
    const p = pods();
    const s = await notified(p);
    at(p.c1, DUE_AT - 1); // 이의 파드: 기한 1밀리초 전
    at(p.c2, DUE_AT); // 확정 파드: 기한 시각
    const release = await lockStatement(s.statementId);
    const dispute = () => p.a.dispute(s.promoterId, randomUUID(), s.statementId, { reasonCode: 'GROSS_AMOUNT' });
    const confirm = () => p.b.confirmDue(s.statementId);
    const results: Record<string, Promise<unknown>> = {};
    if (first === 'dispute') {
      results.dispute = dispute();
      await untilWaiting('f075-pod-a');
      results.confirm = confirm();
      await untilWaiting('f075-pod-b');
    } else {
      results.confirm = confirm();
      await untilWaiting('f075-pod-b');
      results.dispute = dispute();
      await untilWaiting('f075-pod-a');
    }
    await release();
    const [d, c] = await Promise.allSettled([results.dispute!, results.confirm!]);
    return { p, s, d, c };
  };

  test('[ASVS v5.0.0-2.3.4] J-T35 ⑥ 이의가 먼저면 DISPUTED이고 확정은 409·확정 0건이다', async () => {
    const { p, s, d, c } = await overlap('dispute');
    expect(d.status).toBe('fulfilled');
    expect(c).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect((await statementRow(s.statementId))!.status).toBe('DISPUTED');
    expect((await outboxOf(s.statementId)).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_DISPUTED']);
    expect(await auditsOf(s.statementId)).toEqual(['CALCULATED→NOTIFIED', 'NOTIFIED→DISPUTED']);
    expect(await q('select result from statement_dispute where statement_id = $1', [s.statementId])).toEqual([{ result: null }]);
    expect(p.cases.opened).toHaveLength(1);
  });

  test('[ASVS v5.0.0-2.3.4] J-T35 ⑥ 확정이 먼저면 CONFIRMED이고 이의는 409이며 이의 행·CS 건이 남지 않는다', async () => {
    const { p, s, d, c } = await overlap('confirm');
    expect(c.status).toBe('fulfilled');
    expect(d).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect((await statementRow(s.statementId))!.status).toBe('CONFIRMED');
    expect((await outboxOf(s.statementId)).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_CONFIRMED']);
    expect(await q('select id from statement_dispute where statement_id = $1', [s.statementId])).toEqual([]);
    expect(p.cases.opened).toEqual([]);
  });
});

describe('J-T35 ⑨ 모두 보류된 묶음', () => {
  test('J-T35 ⑨ KYC 전 파트너의 확정 정산서만 있는 묶음 요청은 409이고 DB에 HELD·KYC·감사가 남으며 묶음 행이 없다', async () => {
    const p = pods();
    const s = await notified(p, { kyc: 'PENDING', eventEndsAt: '2026-09-01T12:00:00.000Z' });
    at(p.c1, DUE_AT);
    await p.a.confirmDueStatements();
    expect((await statementRow(s.statementId))!.status).toBe('CONFIRMED');
    at(p.c1, DUE_AT + 60_000); // 감사 차례(created_at)가 확정 뒤로 오게 1분 뒤 묶음을 만든다
    await expect(p.a.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
    expect(await statementRow(s.statementId)).toMatchObject({ status: 'HELD', hold_reason: 'KYC', payout_batch_id: null });
    expect((await auditsOf(s.statementId)).at(-1)).toBe('CONFIRMED→HELD');
    expect(await q('select id from payout_batch where payout_date = $1', [s.payoutDate])).toEqual([]);
  });
});

describe('J-T36 수기 조정(실제 DB)', () => {
  const register = async (p: Pods, statementId: string, o: { amount: number; reasonCode: string; disputeId?: string; evidenceNote?: string }) => {
    const approvalId = randomUUID();
    const requestedBy = randomUUID();
    await p.a.requestAdjustment(statementId, { approvalId, requestedBy, ...o });
    p.approvals.rows.set(approvalId, { approvalId, kind: 'SETTLEMENT_ADJUSTMENT', targetRef: statementId, amount: o.amount, reasonCode: o.reasonCode, status: 'EXECUTING', requiredApprovals: 2, requestedBy, approvals: [randomUUID()], approvedAt: new Date(NOTIFY_AT).toISOString() });
    return { approvalId, requestedBy };
  };
  const adjustment = async (approvalId: string) => (await q<{ status: string; applied_at: Date | null; amount: string }>('select status, applied_at, amount from statement_adjustment where approval_id = $1', [approvalId]))[0];

  test('[ASVS v5.0.0-2.3.3] J-T36 ⑤ 이의 인정 조정 적용은 조정 행·조정 합계·지급액·이의 ADJUSTED·NOTIFIED·감사·사건을 한 트랜잭션에 쓰고 재적용은 한 번이다', async () => {
    const p = pods();
    const s = await notified(p);
    await p.a.dispute(s.promoterId, randomUUID(), s.statementId, { reasonCode: 'COMMISSION' });
    const [{ id: disputeId }] = await q<{ id: string }>('select id from statement_dispute where statement_id = $1', [s.statementId]);
    const { approvalId } = await register(p, s.statementId, { amount: 500_000, reasonCode: 'COMMISSION', disputeId: disputeId! });
    expect((await adjustment(approvalId))!.status).toBe('PENDING');

    // Outbox가 실패하면 적용 전체가 롤백된다
    await db1.pool.query('insert into test_hooks.fail_outbox_key values ($1)', [s.promoterId]);
    at(p.c1, APPLY_AT);
    await expect(p.a.applyAdjustment(approvalId)).rejects.toThrow();
    expect(await statementRow(s.statementId)).toMatchObject({ status: 'DISPUTED', adjustment_amount: '0', payout_amount: '24920000' });
    expect((await adjustment(approvalId))!.status).toBe('PENDING');
    expect(await q('select result from statement_dispute where id = $1', [disputeId])).toEqual([{ result: null }]);
    await db1.pool.query('delete from test_hooks.fail_outbox_key');

    await p.a.applyAdjustment(approvalId);
    const r = (await statementRow(s.statementId))!;
    expect(r).toMatchObject({ status: 'NOTIFIED', gross_amount: '30000000', refund_amount: '2000000', commission_amount: '2800000', commission_vat: '280000', offset_amount: '0', adjustment_amount: '500000', payout_amount: '25420000' });
    expect((r.dispute_due_at as Date).getTime()).toBe(APPLY_DUE);
    expect(await adjustment(approvalId)).toMatchObject({ status: 'APPLIED', applied_at: new Date(APPLY_AT) });
    expect(await q('select result from statement_dispute where id = $1', [disputeId])).toEqual([{ result: 'ADJUSTED' }]);
    expect((await auditsOf(s.statementId)).at(-1)).toBe('DISPUTED→NOTIFIED');
    expect((await outboxOf(s.statementId)).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_DISPUTED', 'STATEMENT_NOTIFIED']);
    // 다른 파드가 같은 승인을 다시 적용해도 합계는 한 번만 바뀐다
    await p.b.applyAdjustment(approvalId);
    await p.a.applyAdjustment(approvalId);
    expect(await statementRow(s.statementId)).toMatchObject({ adjustment_amount: '500000', payout_amount: '25420000' });
    expect(await outboxOf(s.statementId)).toHaveLength(3);
  });

  test('J-T36 ⑤ 같은 승인을 두 파드가 동시에 적용해도 조정 합계는 한 번만 더해진다', async () => {
    const p = pods();
    const s = await notified(p);
    const { approvalId } = await register(p, s.statementId, { amount: -40_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정' });
    const release = await lockStatement(s.statementId);
    const one = p.a.applyAdjustment(approvalId);
    await untilWaiting('f075-pod-a');
    const two = p.b.applyAdjustment(approvalId);
    await untilWaiting('f075-pod-b');
    await release();
    const results = await Promise.allSettled([one, two]);
    expect(results.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await statementRow(s.statementId)).toMatchObject({ adjustment_amount: '-40000', payout_amount: '24880000' });
    expect((await outboxOf(s.statementId)).filter((e) => e.value.type === 'STATEMENT_NOTIFIED')).toHaveLength(2);
  });

  const overlapBatch = async (first: 'batch' | 'apply') => {
    const p = pods();
    const s = await notified(p, { eventEndsAt: first === 'batch' ? '2026-09-02T12:00:00.000Z' : '2026-09-03T12:00:00.000Z' });
    at(p.c1, DUE_AT);
    at(p.c2, DUE_AT);
    await p.a.confirmDueStatements();
    expect((await statementRow(s.statementId))!.status).toBe('CONFIRMED');
    const { approvalId } = await register(p, s.statementId, { amount: -20_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의 차감' });
    const release = await lockStatement(s.statementId);
    const batch = () => p.b.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() });
    const apply = () => p.a.applyAdjustment(approvalId);
    const out: { batch?: Promise<unknown>; apply?: Promise<unknown> } = {};
    if (first === 'batch') {
      out.batch = batch();
      await untilWaiting('f075-pod-b');
      out.apply = apply();
      await untilWaiting('f075-pod-a');
    } else {
      out.apply = apply();
      await untilWaiting('f075-pod-a');
      out.batch = batch();
      await untilWaiting('f075-pod-b');
    }
    await release();
    const [b, a] = await Promise.allSettled([out.batch!, out.apply!]);
    return { s, approvalId, b, a };
  };

  test('[ASVS v5.0.0-2.3.4] J-T36 ⑥ 묶음이 먼저면 정산서는 SCHEDULED이고 적용은 409·조정 행은 PENDING 그대로다', async () => {
    const { s, approvalId, b, a } = await overlapBatch('batch');
    expect(b.status).toBe('fulfilled');
    expect(a).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await statementRow(s.statementId)).toMatchObject({ status: 'SCHEDULED', adjustment_amount: '0', payout_amount: '24920000' });
    expect((await adjustment(approvalId))!.status).toBe('PENDING');
  });

  test('[ASVS v5.0.0-2.3.4] J-T36 ⑥ 조정이 먼저면 정산서는 NOTIFIED이고 그 묶음에 들지 않는다', async () => {
    const { s, approvalId, a } = await overlapBatch('apply');
    expect(a.status).toBe('fulfilled');
    const r = (await statementRow(s.statementId))!;
    expect(r).toMatchObject({ status: 'NOTIFIED', adjustment_amount: '-20000', payout_amount: '24900000', payout_batch_id: null });
    expect((await adjustment(approvalId))!.status).toBe('APPLIED');
    expect(await q('select b.id from payout_batch b join settlement_statement s on s.payout_batch_id = b.id where s.id = $1', [s.statementId])).toEqual([]);
  });

  test('J-T36 ③·④ 지급을 요청한 정산서는 조정을 받지 않고, 요청자 = 승인자인 승인 기록으로는 적용하지 않는다', async () => {
    const p = pods();
    const s = await notified(p, { eventEndsAt: '2026-09-04T12:00:00.000Z' });
    const { approvalId, requestedBy } = await register(p, s.statementId, { amount: -30_000, reasonCode: 'CONTRACT_CORRECTION', evidenceNote: '수수료율 정정' });
    p.approvals.rows.set(approvalId, { ...p.approvals.rows.get(approvalId)!, approvals: [requestedBy] });
    await expect(p.a.applyAdjustment(approvalId)).rejects.toMatchObject({ status: 409 });
    expect(await statementRow(s.statementId)).toMatchObject({ status: 'NOTIFIED', adjustment_amount: '0', payout_amount: '24920000' });
    expect((await adjustment(approvalId))!.status).toBe('PENDING');
    await p.a.voidAdjustment(approvalId);

    at(p.c1, DUE_AT);
    await p.a.confirmDueStatements();
    await p.a.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() });
    expect((await statementRow(s.statementId))!.status).toBe('SCHEDULED');
    await expect(p.a.requestAdjustment(s.statementId, { approvalId: randomUUID(), requestedBy: randomUUID(), amount: -10_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '지급 뒤' })).rejects.toMatchObject({
      status: 409,
      type: expect.stringContaining('settlement-adjustment-not-allowed'),
    });
    expect(await q("select id from statement_adjustment where statement_id = $1 and status <> 'VOID'", [s.statementId])).toEqual([]);
  });

  test('J-T12 J-T36 ⑦ 70만 원 정산서에 −100만 원 조정 → −30만 원 → 1영업일 뒤 CARRIED_OVER·NEGATIVE_STATEMENT 미수금 30만 원 한 행(두 파드가 겹쳐 확정해도)', async () => {
    const p = pods();
    // 판매 786,516원·10% → 수수료 78,651·부가세 7,865·지급 700,000원
    const s = await notified(p, { gross: 786_516, refund: 0 });
    expect(s.payoutAmount).toBe(700_000);
    const { approvalId } = await register(p, s.statementId, { amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의 차감' });
    at(p.c1, APPLY_AT);
    await p.a.applyAdjustment(approvalId);
    expect(await statementRow(s.statementId)).toMatchObject({ status: 'NOTIFIED', payout_amount: '-300000' });
    at(p.c1, APPLY_DUE);
    at(p.c2, APPLY_DUE);
    const release = await lockStatement(s.statementId);
    const one = p.a.confirmDue(s.statementId);
    await untilWaiting('f075-pod-a');
    const two = p.b.confirmDue(s.statementId);
    await untilWaiting('f075-pod-b');
    await release();
    await Promise.allSettled([one, two]);
    expect((await statementRow(s.statementId))!.status).toBe('CARRIED_OVER');
    const receivables = await q('select promoter_id, pg, cause, amount, remaining, status, source_ref from partner_receivable where source_ref = $1', [`negative-statement:${s.statementId}`]);
    expect(receivables).toEqual([{ promoter_id: s.promoterId, pg: 'TOSS', cause: 'NEGATIVE_STATEMENT', amount: '300000', remaining: '300000', status: 'OPEN', source_ref: `negative-statement:${s.statementId}` }]);
    const types = (await outboxOf(s.statementId)).map((e) => e.value.type);
    expect(types.filter((t) => t === 'STATEMENT_CARRIED_OVER')).toHaveLength(1);
    expect((await outboxOf(s.statementId)).filter((e) => e.value.type === 'RECEIVABLE_OPENED').map((e) => e.value.amount)).toEqual([300_000]);
  });

  test('J-T36 ⑦ 조건부 전이를 지나 같은 근거의 미수금을 다시 넣어도 부분 유일 인덱스가 한 행으로 막는다(겹친 가드 하나씩)', async () => {
    const p = pods();
    const s = await notified(p);
    const insert = () =>
      db1.pool.query("insert into partner_receivable (id, promoter_id, pg, cause, source_ref, amount, remaining, status, created_at, updated_at) values ($1, $2, 'TOSS', 'NEGATIVE_STATEMENT', $3, 1000, 1000, 'OPEN', now(), now())", [randomUUID(), s.promoterId, `negative-statement:${s.statementId}`]);
    await insert();
    await expect(insert()).rejects.toThrow(/partner_receivable_source_ref_uidx/);
  });
});
