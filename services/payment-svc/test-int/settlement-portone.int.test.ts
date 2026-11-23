// F-07-7 실제 PostgreSQL 통합 시험(payment 0030·0032, Drizzle 저장소, 두 연결 경합, 한 트랜잭션 되돌림).
// J-T39 ①(표·칸, 계좌 원문 0건), J-T40 ①③⑤⑦(판 경합·변경 행과 계좌 저장의 한 트랜잭션·예약 취소와 웹훅 겹침), J-T41 ①(수기 정산건 실행의 한 트랜잭션),
// J-T20 ②(같은 이체를 두 연결이 겹쳐 대사해도 건 하나, 이체 행·건·경보의 한 트랜잭션), J-T21(계좌 대조 보류와 계좌 변경 겹침).
// 결제사는 대역 서버(test/support), 실패 주입은 시험 전용 트리거(test_hooks, settlement-flow.int.test.ts와 같은 꼴)다.
import 'reflect-metadata';
import { createDatabase, ensureOutboxPartitions, fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { DrizzleSettlementPaymentSource, DrizzleSettlementStore } from '../src/modules/settlement/index.js';
import type { ReauthVerifier, VerifiedReauth } from '../src/modules/settlement/domain/ports.js';
import { SettlementProblem } from '../src/modules/settlement/domain/settlement.js';
import { OpsIntakeFake } from '../test/support/ops-intake-fake.js';
import { PortonePlatformFake } from '../test/support/portone-platform-fake.js';
import { RecordingTossPayout } from '../test/support/settlement-payout-toss-double.js';
import { batch, buildSettlements, kyc, leaks, payout, PORTONE_SECRET, portonePartnerRecord, statement, tossSellerRecord, type BuiltSettlements } from '../test/support/settlement-portone-harness.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

/** 금요일 10:00 KST. 3영업일 보류 끝 = 2026-12-02 10:00 KST */
const FRIDAY_10_KST = Date.parse('2026-11-27T01:00:00.000Z');
const LEGAL = '주식회사 피켓엔터';
const ACCOUNT = '11012345678901';

/** 재인증 토큰 글을 jti로 쓰는 시험용 확인기(변경 행의 reauth_jti 유일 인덱스를 경합마다 다르게) */
class TokenAsJti implements ReauthVerifier {
  async verify(token: string | undefined, o: { sessionId: string; act: string }): Promise<VerifiedReauth> {
    if (!token) throw new SettlementProblem('reauth-required', 403, '다시 인증해 주세요');
    return { jti: token, accountId: '00000000-0000-4000-8000-0000000000aa', sessionId: o.sessionId, act: o.act, factors: ['password', 'totp', 'passkey'] };
  }
}

let pgc: PostgresContainer;
let db1: Database;
let db2: Database;
let locker: pg.Client;
const fake = new PortonePlatformFake(PORTONE_SECRET);
const ops = new OpsIntakeFake();
const toss = new RecordingTossPayout();
let clock: ReturnType<typeof fakeClock>;
let a: BuiltSettlements<DrizzleSettlementStore>;
let b: BuiltSettlements<DrizzleSettlementStore>;

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => (await db1.pool.query(text, values)).rows as T[];
const outboxOf = async (statementId: string) =>
  (await q<{ payload: Buffer }>('select payload from outbox order by seq')).map((r) => JSON.parse(r.payload.toString('utf8')) as Record<string, unknown>).filter((v) => v.statementId === statementId);
const waitingOn = async (app: string): Promise<number> => Number((await q<{ n: string }>("select count(*) as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [app]))[0]!.n);
const untilWaiting = async (app: string, n = 1) => {
  // 잠금 대기를 조건으로 기다린다(고정 대기 아님, settlement-flow.int.test.ts와 같다)
  for (let i = 0; i < 500; i += 1) {
    if ((await waitingOn(app)) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${app} 연결이 잠금을 기다리지 않았다`);
};

beforeAll(async () => {
  await fake.start();
  await ops.start();
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  db1 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f077-pod-a' });
  db2 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f077-pod-b' });
  await ensureOutboxPartitions(db1, fakeClock({ now: FRIDAY_10_KST }), { daysAhead: 14 });
  locker = new pg.Client({ connectionString: pgc.url, application_name: 'f077-locker' });
  await locker.connect();
  await db1.pool.query(`
    create schema test_hooks;
    create table test_hooks.fail_key (k text primary key);
    create function test_hooks.fail_outbox() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_key f where f.k = 'outbox:' || new.msg_key) then raise exception 'test-forced-outbox-failure'; end if;
      return new;
    end $f$;
    create trigger test_fail_outbox before insert on public.outbox for each row execute function test_hooks.fail_outbox();
    create function test_hooks.fail_change() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_key f where f.k = 'change:' || new.promoter_id::text) then raise exception 'test-forced-change-failure'; end if;
      return new;
    end $f$;
    create trigger test_fail_change before insert on public.payout_account_change for each row execute function test_hooks.fail_change();
    create function test_hooks.fail_alert() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_key f where f.k = 'alert:' || new.source_id) then raise exception 'test-forced-alert-failure'; end if;
      return new;
    end $f$;
    create trigger test_fail_alert before insert on public.settlement_alert_request for each row execute function test_hooks.fail_alert();
  `);
}, 180_000);

afterAll(async () => {
  await locker?.end();
  await db1?.close();
  await db2?.close();
  pgc?.stop();
  await fake.close();
  await ops.close();
});

beforeEach(async () => {
  fake.reset();
  ops.reset();
  toss.calls.length = 0;
  toss.clearFailures();
  await db1.pool.query('delete from test_hooks.fail_key');
  clock = fakeClock({ now: FRIDAY_10_KST });
  // 저장소에 같은 가짜 시계를 넘겨 Outbox 행 ID·시각이 미리 만든 파티션(가짜 시계 기준) 안에 들게 한다(settlement-toss-payout.int와 같음, 시험 이의 TO-11)
  a = buildSettlements(new DrizzleSettlementStore(db1, clock), new DrizzleSettlementPaymentSource(db1), { now: FRIDAY_10_KST, clock, portone: fake, toss, ops, reauth: new TokenAsJti() });
  b = buildSettlements(new DrizzleSettlementStore(db2, clock), new DrizzleSettlementPaymentSource(db2), { now: FRIDAY_10_KST, clock, portone: fake, toss, ops, reauth: new TokenAsJti() });
});

/** 지급 준비가 된 파트너(판매자 확인·옛 계좌 판 9·포트원 파트너·토스 두 상점 셀러), 포트원 쪽 파트너 계좌도 같다 */
async function partner(o: { accountNumber?: string } = {}): Promise<{ P: string; partnerId: string }> {
  const P = randomUUID();
  const since = new Date(FRIDAY_10_KST - 30 * 86_400_000);
  await a.store.saveKyc(kyc(P, since, { legalName: LEGAL, representative: '김대표' }));
  await a.store.savePayoutAccount({ promoterId: P, bankCode: '88', accountLast4: (o.accountNumber ?? ACCOUNT).slice(-4), version: 9, changedAt: since, holdUntil: since, holderVerified: true, agencySyncPending: false });
  const pp = portonePartnerRecord(P, since);
  await a.store.savePortonePartner(pp);
  for (const store of ['STANDARD', 'ESCROW'] as const) await a.store.saveTossSeller(tossSellerRecord(P, store, 'PARTIALLY_APPROVED', since));
  fake.partners.set(pp.portonePartnerId, { id: pp.portonePartnerId, name: LEGAL, account: { bank: 'SHINHAN', number: o.accountNumber ?? ACCOUNT, holder: LEGAL }, defaultContractId: 'c', scheduled: null });
  return { P, partnerId: pp.portonePartnerId };
}

describe('payment 0030·0032 표와 칸', () => {
  test('J-T39 ① 0030·0032가 새 표와 칸을 만들고 다시 적용해도 같으며, 어느 새 표에도 계좌번호·예금주명 칸이 없다 [ASVS v5.0.0-14.2.6]', async () => {
    const tables = await q<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('portone_partner','payout_account_change','portone_transfer','portone_ledger_sync','settlement_alert_request') order by table_name",
    );
    expect(tables.map((t) => t.table_name)).toEqual(['payout_account_change', 'portone_ledger_sync', 'portone_partner', 'portone_transfer', 'settlement_alert_request']);
    const pending = await q<{ data_type: string; is_nullable: string; column_default: string | null }>("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'payout_account' and column_name = 'agency_sync_pending'");
    expect(pending).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);
    const sensitive = await q<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('portone_partner','payout_account_change','portone_transfer','portone_ledger_sync','settlement_alert_request','payout_account','toss_seller') and (column_name like '%account_number%' or column_name like '%holder_name%' or column_name = 'account_no')",
    );
    expect(sensitive).toEqual([]);
    await expect(migratePayment(pgc.url)).resolves.toBeUndefined();
  });

  test('J-T39 ① 칸 제약: 끝 4자리는 숫자 4자리, 변경 결과 셋·대사 결과 셋·경보 심각도 둘만, reauth_jti 유일, CS 종류에 포트원 둘·잔액 대사 결제사에 PORTONE', async () => {
    const P = randomUUID();
    const change = (o: { last4?: string; result?: string; jti?: string } = {}) =>
      db1.pool.query("insert into payout_account_change (id, promoter_id, actor_account_id, reauth_jti, result, bank_code, account_last4, agency_results, created_at) values ($1, $2, $3, $4, $5, '88', $6, '{}', now())", [randomUUID(), P, randomUUID(), o.jti ?? randomUUID(), o.result ?? 'ACCEPTED', o.last4 ?? '8901']);
    await expect(change()).resolves.toBeDefined();
    await expect(change({ last4: '890' })).rejects.toThrow();
    await expect(change({ last4: '89a1' })).rejects.toThrow();
    await expect(change({ result: 'MAYBE' })).rejects.toThrow();
    await change({ jti: 'same-jti' });
    await expect(change({ jti: 'same-jti' })).rejects.toThrow();
    const transfer = (result: string, last4 = '8901') => db1.pool.query("insert into portone_transfer (transfer_id, withdrawal_type, payout_id, amount, bank_code, account_last4, holder_matched, check_result, transferred_at, checked_at) values ($1, 'PAYOUT', null, 1, '88', $2, true, $3, now(), now())", [randomUUID(), last4, result]);
    for (const r of ['MATCHED', 'MISMATCH', 'UNLINKED']) await expect(transfer(r)).resolves.toBeDefined();
    await expect(transfer('MISSING')).rejects.toThrow();
    await expect(transfer('MATCHED', '12345')).rejects.toThrow();
    const alert = (severity: string) => db1.pool.query("insert into settlement_alert_request (event_key, kind, severity, source_id, created_at) values ($1, 'settlement_portone_withdrawal_unmatched', $2, 'x', now())", [randomUUID(), severity]);
    for (const s of ['SEV2', 'SEV3']) await expect(alert(s)).resolves.toBeDefined();
    await expect(alert('SEV1')).rejects.toThrow();
    const caseKind = (kind: string) => db1.pool.query('insert into settlement_case_request (event_key, kind, source_id, created_at) values ($1, $2, $3, now())', [randomUUID(), kind, randomUUID()]);
    for (const k of ['PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH', 'PAYOUT_FAILED']) await expect(caseKind(k)).resolves.toBeDefined();
    await expect(caseKind('PORTONE_SOMETHING')).rejects.toThrow();
    await expect(db1.pool.query("insert into portone_ledger_sync (name, last_success_at, read_through, updated_at) values ('WITHDRAWAL', now(), now(), now()), ('PARTNER_ACCOUNT', now(), now(), now())")).resolves.toBeDefined();
    await expect(db1.pool.query("insert into portone_ledger_sync (name, last_success_at, read_through, updated_at) values ('OTHER', now(), now(), now())")).rejects.toThrow();
  });
});

describe('J-T39 ① 등록 한 길(Drizzle 저장소)', () => {
  test('J-T39 ① 등록이 portone_partner 한 행·toss_seller 두 행·payout_account 은행·끝 4자리만 남기고 DB 어디에도 계좌번호 원문이 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const P = randomUUID();
    fake.holder('SHINHAN', ACCOUNT, '㈜피켓엔터');
    await a.settlements.registerPayoutAgencies({
      promoterId: P,
      businessType: 'CORPORATE',
      company: { name: LEGAL, representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'pay@peaket.test', phone: '0212345678' },
      account: { bankCode: '88', accountNumber: ACCOUNT, holderName: '(주)피켓엔터' },
    });
    expect(await q('select promoter_id, contract_id from portone_partner where promoter_id = $1', [P])).toHaveLength(1);
    expect((await q<{ pg_store: string }>('select pg_store from toss_seller where promoter_id = $1 order by pg_store', [P])).map((r) => r.pg_store)).toEqual(['ESCROW', 'STANDARD']);
    expect(await q('select bank_code, account_last4, holder_verified, agency_sync_pending from payout_account where promoter_id = $1', [P])).toEqual([{ bank_code: '88', account_last4: '8901', holder_verified: true, agency_sync_pending: false }]);
    const dump = JSON.stringify(
      await Promise.all(['portone_partner', 'toss_seller', 'payout_account', 'seller_kyc', 'payout_account_change', 'outbox'].map((t) => q(`select * from ${t}`))),
      (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : v),
    );
    expect(leaks(dump, ACCOUNT)).toEqual([]);
  });
});

describe('J-T40 계좌 변경의 경합과 한 트랜잭션', () => {
  test('J-T40 ① 같은 파트너의 계좌 변경 둘이 같은 판(9)으로 겹치면 하나만 200이고 다른 하나는 412이며 판은 10 하나다', async () => {
    const { P } = await partner();
    fake.holder('SHINHAN', '11000000000001', LEGAL);
    fake.holder('SHINHAN', '11000000000002', LEGAL);
    const out = await Promise.allSettled([
      a.settlements.putPayoutAccount(P, 'sid', { bankCode: '88', accountNumber: '11000000000001', holderName: LEGAL }, '"9"', 'jti-race-1'),
      b.settlements.putPayoutAccount(P, 'sid', { bankCode: '88', accountNumber: '11000000000002', holderName: LEGAL }, '"9"', 'jti-race-2'),
    ]);
    expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = out.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as { status?: number }).status)).toEqual([412]);
    expect(await q('select version from payout_account where promoter_id = $1', [P])).toEqual([{ version: 10 }]);
    expect(await q("select result from payout_account_change where promoter_id = $1 and result = 'ACCEPTED'", [P])).toHaveLength(1);
  });

  test('J-T40 ③⑦ 변경 기록 행 넣기가 실패하면 계좌 저장·보류도 남지 않는다(한 트랜잭션) [ASVS v5.0.0-16.3.1]', async () => {
    const { P } = await partner();
    fake.holder('SHINHAN', ACCOUNT, LEGAL);
    await db1.pool.query('insert into test_hooks.fail_key values ($1)', [`change:${P}`]);
    await expect(a.settlements.putPayoutAccount(P, 'sid', { bankCode: '88', accountNumber: ACCOUNT, holderName: LEGAL }, '"9"', 'jti-fail-change')).rejects.toBeInstanceOf(Error);
    expect(await q('select version, account_last4, hold_until <= changed_at as no_hold from payout_account where promoter_id = $1', [P])).toEqual([{ version: 9, account_last4: '8901', no_hold: true }]);
    expect(await q('select id from payout_account_change where promoter_id = $1', [P])).toEqual([]);
    // 막힌 것을 풀면 같은 요청(새 재인증)이 처음처럼 된다
    await db1.pool.query('delete from test_hooks.fail_key');
    await a.settlements.putPayoutAccount(P, 'sid', { bankCode: '88', accountNumber: ACCOUNT, holderName: LEGAL }, '"9"', 'jti-after');
    expect(await q('select version from payout_account where promoter_id = $1', [P])).toEqual([{ version: 10 }]);
    expect(await q<{ result: string; reauth_jti: string }>('select result, reauth_jti from payout_account_change where promoter_id = $1', [P])).toEqual([{ result: 'ACCEPTED', reauth_jti: 'jti-after' }]);
  });

  async function scheduledToss(P: string, payoutDate: string): Promise<{ statementId: string; payoutId: string; pgPayoutId: string }> {
    const at = new Date(FRIDAY_10_KST - 2 * 86_400_000);
    const bt = batch({ pg: 'TOSS', payoutDate, totalAmount: 8_800_000, statementCount: 1, at });
    await a.store.insertPayoutBatch(bt);
    const s = statement({ promoterId: P, pg: 'TOSS', payoutDate, status: 'SCHEDULED', payoutAmount: 8_800_000, payoutBatchId: bt.batchId, at });
    await a.store.saveStatement(s);
    const p = payout({ batchId: bt.batchId, statementId: s.statementId, amount: 8_800_000, pgPayoutId: `tp-${s.statementId.slice(0, 8)}`, payoutDate, at });
    await a.store.insertPayouts([p]);
    return { statementId: s.statementId, payoutId: p.payoutId, pgPayoutId: p.pgPayoutId! };
  }

  test('J-T40 ⑤ 예약 취소의 지급 건 CANCELED·정산서 HELD·PAYOUT_HELD는 한 트랜잭션이다(Outbox 쓰기를 실패시키면 셋 다 그대로)', async () => {
    const { P } = await partner();
    const x = await scheduledToss(P, '2026-12-01');
    await db1.pool.query('insert into test_hooks.fail_key values ($1)', [`outbox:${P}`]);
    await a.settlements.cancelScheduledTossPayouts({ promoterId: P, reason: 'ACCOUNT_CHANGE', payoutDateThrough: '2026-12-02' }).catch(() => undefined);
    expect(await q('select status from payout where id = $1', [x.payoutId])).toEqual([{ status: 'REQUESTED' }]);
    expect(await q('select status, hold_reason from settlement_statement where id = $1', [x.statementId])).toEqual([{ status: 'SCHEDULED', hold_reason: null }]);
    expect((await outboxOf(x.statementId)).filter((e) => e.type === 'PAYOUT_HELD')).toEqual([]);
    await db1.pool.query('delete from test_hooks.fail_key');
    await a.settlements.cancelScheduledTossPayouts({ promoterId: P, reason: 'ACCOUNT_CHANGE', payoutDateThrough: '2026-12-02' });
    expect(await q('select status from payout where id = $1', [x.payoutId])).toEqual([{ status: 'CANCELED' }]);
    expect(await q('select status, hold_reason from settlement_statement where id = $1', [x.statementId])).toEqual([{ status: 'HELD', hold_reason: 'ACCOUNT_CHANGE' }]);
    expect((await outboxOf(x.statementId)).filter((e) => e.type === 'PAYOUT_HELD').map((e) => e.amount)).toEqual([8_800_000]);
  });

  test('J-T40 ⑤ 예약 취소 반영과 웹훅 결과 반영(COMPLETED)이 같은 지급 건에 겹치면 사건은 하나만 남고 상태가 서로 맞는다', async () => {
    const { P } = await partner();
    // 앞 시험의 묶음(TOSS·STANDARD·12-01)과 부분 유일이 겹치지 않게 보류 기간 안의 다른 지급일(시험 이의 TO-12)
    const x = await scheduledToss(P, '2026-11-30');
    await locker.query('begin');
    await locker.query('select id from payout where id = $1 for update', [x.payoutId]);
    const cancel = a.settlements.cancelScheduledTossPayouts({ promoterId: P, reason: 'ACCOUNT_CHANGE', payoutDateThrough: '2026-12-02' }).catch((e: unknown) => e);
    const webhook = b.settlements.applyPayoutFact({ pgPayoutId: x.pgPayoutId, status: 'COMPLETED', observedAt: new Date(FRIDAY_10_KST) }).catch((e: unknown) => e);
    await untilWaiting('f077-pod-a');
    await untilWaiting('f077-pod-b');
    await locker.query('commit');
    await Promise.all([cancel, webhook]);
    const status = (await q<{ status: string }>('select status from payout where id = $1', [x.payoutId]))[0]!.status;
    const st = (await q<{ status: string; hold_reason: string | null }>('select status, hold_reason from settlement_statement where id = $1', [x.statementId]))[0]!;
    const types = (await outboxOf(x.statementId)).map((e) => e.type).filter((t) => t === 'PAYOUT_HELD' || t === 'PAYOUT_COMPLETED');
    expect(types).toHaveLength(1);
    if (types[0] === 'PAYOUT_HELD') expect([status, st.status, st.hold_reason]).toEqual(['CANCELED', 'HELD', 'ACCOUNT_CHANGE']);
    else expect([status, st.status]).toEqual(['COMPLETED', 'PAID']);
  });
});

describe('J-T41 ① 포트원 실행의 한 트랜잭션', () => {
  test('J-T41 ① 지급 건·SCHEDULED·PAYOUT_SCHEDULED가 한 트랜잭션이고(Outbox 실패면 셋 다 없음), 다시 실행하면 수기 정산건은 조회로만 확인한다', async () => {
    const { P } = await partner();
    const at = new Date(FRIDAY_10_KST - 86_400_000);
    const bt = batch({ pg: 'PORTONE', payoutDate: '2026-12-02', totalAmount: 6_543_210, statementCount: 1, status: 'APPROVED', at });
    await a.store.insertPayoutBatch(bt);
    const s = statement({ promoterId: P, pg: 'PORTONE', payoutDate: '2026-12-02', payoutAmount: 6_543_210, payoutBatchId: bt.batchId, at });
    await a.store.saveStatement(s);
    await db1.pool.query('insert into test_hooks.fail_key values ($1)', [`outbox:${P}`]);
    await a.settlements.executeBatch(bt.batchId).catch(() => undefined);
    expect(await q('select id from payout where statement_id = $1', [s.statementId])).toEqual([]);
    expect(await q('select status from settlement_statement where id = $1', [s.statementId])).toEqual([{ status: 'CONFIRMED' }]);
    expect(await outboxOf(s.statementId)).toEqual([]);
    expect(fake.transfers.size).toBe(1);
    await db1.pool.query('delete from test_hooks.fail_key');
    await a.settlements.executeBatch(bt.batchId);
    expect(fake.calls('POST /platform/transfers/manual')).toHaveLength(2);
    expect(fake.calls('GET /platform/transfers/{id}')).toHaveLength(1);
    expect(fake.transfers.size).toBe(1);
    expect(await q('select ref_payout_id, pg_payout_id, amount::int as amount, status from payout where statement_id = $1', [s.statementId])).toEqual([{ ref_payout_id: `${s.statementId}-1`, pg_payout_id: s.statementId, amount: 6_543_210, status: 'REQUESTED' }]);
    expect((await outboxOf(s.statementId)).map((e) => e.type)).toEqual(['PAYOUT_SCHEDULED']);
  });
});

describe('J-T20 ②·J-T21 대사의 겹침과 한 트랜잭션', () => {
  /** 시험마다 다른 포트원 지급일(11-20부터 하루씩, 시험 이의 TO-12) */
  let payoutDay = 19;
  async function paid(P: string, partnerId: string, amount: number): Promise<{ statementId: string; payoutId: string }> {
    const at = new Date(FRIDAY_10_KST - 2 * 86_400_000);
    // 같은 지급일의 SUBMITTED 묶음은 부분 유일이라 시험마다 다른 지급일을 쓴다(시험 이의 TO-12)
    payoutDay += 1;
    const payoutDate = `2026-11-${String(payoutDay).padStart(2, '0')}`;
    const bt = batch({ pg: 'PORTONE', payoutDate, totalAmount: amount, statementCount: 1, status: 'SUBMITTED', portoneBulkPayoutId: `bulk-int-${payoutDay}`, at });
    await a.store.insertPayoutBatch(bt);
    const s = statement({ promoterId: P, pg: 'PORTONE', payoutDate, status: 'SCHEDULED', payoutAmount: amount, payoutBatchId: bt.batchId, at });
    await a.store.saveStatement(s);
    const p = payout({ batchId: bt.batchId, statementId: s.statementId, amount, pgPayoutId: s.statementId, payoutDate, at });
    await a.store.insertPayouts([p]);
    fake.transfers.set(s.statementId, { id: s.statementId, partnerId, settlementAmount: amount, settlementDate: payoutDate, status: 'SCHEDULED' });
    fake.payouts.push({ id: `po-${s.statementId.slice(0, 8)}`, bulkPayoutId: `bulk-int-${payoutDay}`, transferId: s.statementId, status: 'SUCCEEDED', completedAt: new Date(FRIDAY_10_KST - 3_600_000).toISOString(), failureCode: null });
    await a.settlements.syncPortonePayouts();
    return { statementId: s.statementId, payoutId: p.payoutId };
  }

  test('J-T20 ② 두 연결이 같은 이체(금액 다름)를 겹쳐 대사해도 portone_transfer 한 행·CS 건 하나·경보 요청 하나다', async () => {
    const { P, partnerId } = await partner();
    const x = await paid(P, partnerId, 4_000_000);
    fake.accountTransfers.push({ id: 'at-race', type: 'WITHDRAWAL', withdrawalType: 'PAYOUT', payoutId: `po-${x.statementId.slice(0, 8)}`, amount: 3_999_999, bank: 'SHINHAN', accountNumber: ACCOUNT, holderName: LEGAL, balance: 1, tradedAt: new Date(FRIDAY_10_KST - 1_800_000).toISOString() });
    await Promise.allSettled([a.settlements.reconcilePortoneTransfers(), b.settlements.reconcilePortoneTransfers()]);
    expect(await q("select check_result from portone_transfer where transfer_id = 'at-race'")).toEqual([{ check_result: 'MISMATCH' }]);
    expect(await q("select kind from settlement_case_request where event_key = 'portone-transfer:at-race'")).toEqual([{ kind: 'PORTONE_LEDGER_MISMATCH' }]);
    expect(await q("select severity from settlement_alert_request where source_id = 'at-race'")).toEqual([{ severity: 'SEV2' }]);
    // 다음 tick도 다시 만들지 않는다
    clock.advance(30 * 60_000);
    await a.settlements.reconcilePortoneTransfers();
    expect(await q("select event_key from settlement_case_request where event_key = 'portone-transfer:at-race'")).toHaveLength(1);
    const dump = JSON.stringify(await Promise.all(['portone_transfer', 'settlement_case_request', 'settlement_alert_request', 'payout'].map((t) => q(`select * from ${t}`))));
    expect(leaks(dump, ACCOUNT, LEGAL)).toEqual([]);
  });

  test('J-T20 ② 이체 행·CS 건·경보 요청은 한 트랜잭션이다(경보 요청 넣기를 실패시키면 이체 행·건도 없고, 다음 대사가 다시 본다)', async () => {
    const { P, partnerId } = await partner();
    await paid(P, partnerId, 4_000_000);
    fake.accountTransfers.push({ id: 'at-rogue', type: 'WITHDRAWAL', withdrawalType: 'TRANSFER', payoutId: null, amount: 9_000_000, bank: 'WOORI', accountNumber: '10055555555555', holderName: '모르는사람', balance: 1, tradedAt: new Date(FRIDAY_10_KST - 1_800_000).toISOString() });
    await db1.pool.query('insert into test_hooks.fail_key values ($1)', ['alert:at-rogue']);
    await a.settlements.reconcilePortoneTransfers().catch(() => undefined);
    expect(await q("select transfer_id from portone_transfer where transfer_id = 'at-rogue'")).toEqual([]);
    expect(await q("select event_key from settlement_case_request where event_key = 'portone-transfer:at-rogue'")).toEqual([]);
    await db1.pool.query('delete from test_hooks.fail_key');
    clock.advance(30 * 60_000);
    await a.settlements.reconcilePortoneTransfers();
    expect(await q("select check_result, payout_id from portone_transfer where transfer_id = 'at-rogue'")).toEqual([{ check_result: 'UNLINKED', payout_id: null }]);
    expect(await q("select kind from settlement_case_request where event_key = 'portone-transfer:at-rogue'")).toEqual([{ kind: 'PORTONE_LEDGER_MISMATCH' }]);
    expect(await q("select severity from settlement_alert_request where source_id = 'at-rogue'")).toEqual([{ severity: 'SEV2' }]);
  });

  test('J-T21 계좌 대조의 보류 전이와 계좌 변경이 겹쳐도 ACCOUNT_MISMATCH 보류가 지워지지 않는다', async () => {
    const { P } = await partner({ accountNumber: '11098765432100' });
    const s = statement({ promoterId: P, pg: 'PORTONE', payoutDate: '2026-12-04', payoutAmount: 2_500_000, at: new Date(FRIDAY_10_KST - 86_400_000) });
    await a.store.saveStatement(s);
    // PEAKET 기록 끝 4자리와 포트원 파트너 계좌가 다르다(콘솔에서 바꿈)
    fake.partners.get(`peaket-${P}`)!.account = { bank: 'WOORI', number: '10012121212121', holder: LEGAL };
    fake.holder('SHINHAN', '11011112222333', LEGAL);
    await locker.query('begin');
    await locker.query('select id from settlement_statement where id = $1 for update', [s.statementId]);
    const check = a.settlements.checkPortonePartnerAccounts({ promoterIds: [P] }).catch((e: unknown) => e);
    const change = b.settlements.putPayoutAccount(P, 'sid', { bankCode: '88', accountNumber: '11011112222333', holderName: LEGAL }, '"9"', 'jti-overlap').catch((e: unknown) => e);
    await untilWaiting('f077-pod-a');
    await locker.query('commit');
    await Promise.all([check, change]);
    expect(await q('select status, hold_reason from settlement_statement where id = $1', [s.statementId])).toEqual([{ status: 'HELD', hold_reason: 'ACCOUNT_MISMATCH' }]);
  });
});
