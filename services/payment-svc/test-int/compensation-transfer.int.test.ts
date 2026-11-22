// 배상 송금 기록·PAID 미수금 실제 PostgreSQL 시험(J-T28 ①~②, BAT-425, ADR-0317).
// 정본: docs/features/settlement.md §7 '배상금 미리 지급의 첫 구현'·§11 J-T28, docs/features/payment.md §6 '배상금 지급의 첫 구현',
// docs/data.md compensation_transfer·partner_receivable, docs/api/proto/peaket/payment/v1/payment.proto CompensationTransferService.
// compensation_id가 멱등 키이고 compensation_transfer 한 행이다. 계좌는 끝 4자리만 저장하고, 송금이 PAID일 때만
// partner_receivable(cause COMPENSATION_ADVANCE·pg NULL·source_ref compensation:{id}·remaining = amount·OPEN) 한 행과 receivable_id를 만든다.
// REQUESTED·FAILED·UNAVAILABLE에는 0행이다. 같은 PAID를 다시 받아도 source_ref 유일로 1행이다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { DrizzleCompensationTransfers } from '../src/modules/compensation/adapters/db/drizzle-compensation-transfers.js';
import { CompensationTransfers } from '../src/modules/compensation/application/compensation-transfers.js';
import type { CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest } from '../src/modules/compensation/domain/ports.js';
import { Settlements } from '../src/modules/settlement/application/settlements.js';
import { DrizzleSettlementStore } from '../src/modules/settlement/adapters/db/drizzle-settlement-store.js';
import { noApprovals, noSaleSuspensions } from '../test/settlement-support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-20T09:30:00.000Z');
const PROMOTER = '0193c425-0000-7000-8000-000000000001';
const EVENT = '0193c425-0000-7000-8000-000000000002';
const ORDER = '0193c425-0000-7000-8000-000000000003';
const ACCOUNT = '0193c425-0000-7000-8000-000000000004';
/** 계획 §5의 계좌 글. 끝 4자리는 4321이다 */
const ACCOUNT_NO = '110-987-654321';
const ACCOUNT_DIGITS = '110987654321';
const HOLDER = '김배상';
/** 47,500원의 10% = 4,750원(원 미만 없음). 코드 상수와 다른 시험 값 */
const AMOUNT = 4_750;
/** 시험 사이에 비울 표. partner_receivable을 가리키는 외래키(receivable_move 0016, guarantee_collection 0026)의 표를 같은 truncate에 넣는다.
 * cascade는 쓰지 않는다: 새 외래키가 생기면 조용히 다른 표까지 비우지 않고 이 시험이 실패해 드러낸다(FIX-payment-int) */
const RESET_SQL = 'truncate compensation_transfer, receivable_move, guarantee_collection, partner_receivable';

type Answer = { transferId: string; status: 'REQUESTED' | 'PAID' | 'FAILED' | 'UNAVAILABLE'; failureReason?: string };
class FakePort implements CompensationTransferPort {
  readonly requests: CompensationTransferRequest[] = [];
  answer: Answer = { transferId: 'tr_bat425_paid', status: 'PAID' };
  /** RV-06: 겹친 두 요청이 포트에 닿는 차례를 실제로 만들기 위해 답을 붙잡는다 */
  delayMs = 0;
  async request(input: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    this.requests.push(input);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { ...this.answer, compensationId: input.compensationId, orderId: input.orderId, accountId: input.accountId, amount: input.amount, accountLast4: input.accountNumber.replace(/-/g, '').slice(-4) };
  }
  async get(): Promise<undefined> {
    return undefined;
  }
}

let pgc: PostgresContainer | undefined;
let database: Database;
let transfers: DrizzleCompensationTransfers;
let port: FakePort;
let service: CompensationTransfers;
let settlements: Settlements;
const clock = fakeClock({ now: NOW });

const input = (o: Partial<CompensationTransferRequest> = {}): CompensationTransferRequest => ({
  compensationId: randomUUID(),
  orderId: ORDER,
  accountId: ACCOUNT,
  amount: AMOUNT,
  bankCode: '88',
  accountNumber: ACCOUNT_NO,
  holderName: HOLDER,
  requestedBy: 'ops-bat425',
  promoterId: PROMOTER,
  eventId: EVENT,
  ...o,
});

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  database = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'compensation-transfer-it' });
  port = new FakePort();
  transfers = new DrizzleCompensationTransfers({ database, clock });
  settlements = new Settlements({
    store: new DrizzleSettlementStore(database),
    payments: { listEventPayments: async () => [] },
    approvals: noApprovals,
    saleSuspensions: noSaleSuspensions,
    gateways: [],
    reauth: { verify: async () => ({ jti: 'jti-test', accountId: 'acct', sessionId: 'sid', act: 'BOOKER_EXPORT', factors: [] }) },
    clock,
  });
  service = new CompensationTransfers(port, transfers, { recordCompensationAdvance: async (i) => ({ receivableId: (await settlements.recordCompensationAdvance(i)).receivableId }) });
}, 180_000);

afterAll(async () => {
  await database?.close();
  pgc?.stop();
});

beforeEach(async () => {
  await database.pool.query(RESET_SQL);
  port.requests.length = 0;
  port.delayMs = 0;
  port.answer = { transferId: 'tr_bat425_paid', status: 'PAID' };
});

const transferRows = async () =>
  (await database.pool.query('select compensation_id, transfer_id, order_id, account_id, promoter_id, event_id, amount::int as amount, account_last4, status, failure_reason, receivable_id from compensation_transfer')).rows as {
    compensation_id: string;
    transfer_id: string;
    order_id: string;
    account_id: string;
    promoter_id: string;
    event_id: string | null;
    amount: number;
    account_last4: string;
    status: string;
    failure_reason: string | null;
    receivable_id: string | null;
  }[];
const receivableRows = async () =>
  (await database.pool.query('select id, promoter_id, pg, cause, event_id, source_ref, amount::int as amount, remaining::int as remaining, status from partner_receivable order by created_at')).rows as {
    id: string;
    promoter_id: string;
    pg: string | null;
    cause: string;
    event_id: string | null;
    source_ref: string;
    amount: number;
    remaining: number;
    status: string;
  }[];

describe('J-T28 ① PAID 미수금·source_ref 유일', () => {
  test('J-T28 ①_PAID면_compensation_transfer_1행과_partner_receivable(COMPENSATION_ADVANCE·pg_NULL·remaining=amount·source_ref)_1행·receivable_id가_생긴다', async () => {
    const i = input();
    const r = await service.request(i);
    expect(r).toMatchObject({ status: 'PAID', transferId: 'tr_bat425_paid', accountLast4: '4321' });
    const rows = await transferRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      compensation_id: i.compensationId,
      transfer_id: 'tr_bat425_paid',
      order_id: ORDER,
      account_id: ACCOUNT,
      promoter_id: PROMOTER,
      event_id: EVENT,
      amount: AMOUNT,
      account_last4: '4321',
      status: 'PAID',
    });
    const rec = await receivableRows();
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      promoter_id: PROMOTER,
      pg: null,
      cause: 'COMPENSATION_ADVANCE',
      event_id: EVENT,
      source_ref: `compensation:${i.compensationId}`,
      amount: AMOUNT,
      remaining: AMOUNT,
      status: 'OPEN',
    });
    expect(rows[0]!.receivable_id).toBe(rec[0]!.id);
  });

  test('J-T28 ①_같은_compensation_id를_다시_불러도_transfer_1행·미수금_1행이고_첫_transfer_id·상태를_그대로_준다(계좌가 달라도)', async () => {
    const i = input();
    const first = await service.request(i);
    port.answer = { transferId: 'tr_second', status: 'PAID' };
    const again = await service.request({ ...i, accountNumber: '220-111-222333' });
    expect(again.transferId).toBe(first.transferId);
    expect(again.receivableId).toBe(first.receivableId);
    expect(await transferRows()).toHaveLength(1);
    expect(await receivableRows()).toHaveLength(1);
    expect(port.requests).toHaveLength(1);
  });

  test('J-T28 ②_REQUESTED·FAILED·UNAVAILABLE은_미수금_0행이고_저장한_상태를_그대로_준다', async () => {
    for (const answer of [
      { transferId: 'tr_req', status: 'REQUESTED' as const },
      { transferId: 'tr_fail', status: 'FAILED' as const, failureReason: 'PG_REJECTED' },
      { transferId: '', status: 'UNAVAILABLE' as const },
    ]) {
      await database.pool.query(RESET_SQL);
      port.requests.length = 0;
      port.answer = answer;
      const r = await service.request(input());
      expect(r.status, answer.status).toBe(answer.status);
      expect(await receivableRows(), answer.status).toHaveLength(0);
      const rows = await transferRows();
      expect(rows, answer.status).toHaveLength(1);
      expect(rows[0]!.status, answer.status).toBe(answer.status);
    }
  });

  test('J-T28 ②_PAID인데_promoter_id가_없으면_미수금을_만들지_않고_UNAVAILABLE이다(옛_gRPC_호출)', async () => {
    const r = service.request(input({ promoterId: undefined }));
    await expect(r).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await transferRows()).toHaveLength(1);
    expect(await receivableRows()).toHaveLength(0);
  });
});

describe('J-T28 ② 계좌 미저장·유일', () => {
  test('J-T28 ②_account_last4만_저장하고_계좌번호_원문·예금주는_DB_어디에도_없다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-16.2.5]', async () => {
    await service.request(input());
    const all = (await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).rows.map((r) => (r as { table_name: string }).table_name);
    const found: string[] = [];
    for (const t of all) {
      const rows = (await database.pool.query(`select t::text as line from "${t}" t`)).rows as { line: string }[];
      for (const row of rows) for (const needle of [ACCOUNT_NO, ACCOUNT_DIGITS, HOLDER]) if (row.line.includes(needle)) found.push(`${t}:${needle}`);
    }
    expect(found).toEqual([]);
  });

  test('J-T28 ②_같은_compensation_id의_겨친_두_요청은_유일_인덱스로_1행이고_결제사_포트도_한_번만_부른다 [ASVS v5.0.0-2.3.4]', async () => {
    const i = input();
    // 두 요청이 행을 읽는 차례를 겹치게 한다(RV-06: 행 1개만 보면 포트 호출 2를 놓친다)
    port.delayMs = 30;
    await Promise.all([service.request(i), service.request(i)]);
    expect(port.requests).toHaveLength(1);
    expect(await transferRows()).toHaveLength(1);
    expect(await receivableRows()).toHaveLength(1);
  });

  // RV-23(높음): #inFlight는 프로세스 안 표다. 같은 DB 저장소를 보는 두 파드(=두 인스턴스)가 겹치면 둘 다 행을 못 보고
  // 포트를 두 번 부른다. 송금 전에 compensation_id를 DB에서 선점해야 두 인스턴스에서도 한 번이다(ADR-0317, B16).
  test('J-T28 ②_RV23_같은_DB_저장소를_쓰는_두_인스턴스가_겹쳐도_포트_1회·행_1이다', async () => {
    const other = new CompensationTransfers(port, transfers, { recordCompensationAdvance: async (i) => ({ receivableId: (await settlements.recordCompensationAdvance(i)).receivableId }) });
    const i = input();
    port.delayMs = 30;
    const [a, b] = await Promise.all([service.request(i), other.request(i)]);
    expect(port.requests).toHaveLength(1);
    expect(await transferRows()).toHaveLength(1);
    expect(await receivableRows()).toHaveLength(1);
    expect(a.compensationId).toBe(i.compensationId);
    expect(a).toEqual(b);
  });

  // RV-05(높음): 계좌번호 원문을 그대로 자르면 '123-456-789'의 끝 4글자가 '-789'가 되어 DB CHECK(^[0-9]{1,4}$)에 걸린다.
  // 지급대행이 PAID를 먼저 돌려준 뒤 저장이 실패하면 돈은 나갔는데 기록이 없다. 숫자만 남긴 끝 4자리를 저장해야 한다.
  test('R-T47 ②_계좌_끝_4자리는_하이픈을_뺀_숫자다: 123-456-789는_6789로_저장되고_DB_CHECK를_지난다', async () => {
    const i = input({ accountNumber: '123-456-789' });
    const r = await service.request(i);
    expect(r.accountLast4).toBe('6789');
    const rows = await transferRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_last4: '6789', status: 'PAID' });
    for (const table of ['compensation_transfer', 'partner_receivable']) {
      const lines = (await database.pool.query(`select t::text as line from "${table}" t`)).rows as { line: string }[];
      expect(lines.some((x) => x.line.includes('123-456-789') || x.line.includes('123456789'))).toBe(false);
    }
  });
});
