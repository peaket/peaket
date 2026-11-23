// R-T47 ③ purchase-svc 배상 송금 결과 확정의 실제 PostgreSQL 시험(F-07-8 계획 I-06, transfer-refund §6 '송금 결과 확정', §11 R-T47 ③).
// 일괄 환불 실행기 틱 끝의 RefreshCompensationTransfers.run이 REQUESTED인 compensation마다 payment-svc GetCompensationTransfer를 불러
// PAID면 상태·receivable_id를 조건부 갱신(status = 'REQUESTED')으로, FAILED면 상태와 CS '배상 대기'(COMPENSATION_PENDING) 한 건을 남긴다.
// 여전히 REQUESTED·조회 실패는 그대로다. 두 파드가 겹쳐도, 계좌 입력 답이 늦게 다시 와도 상태 쓰기·CS 건이 하나씩이다.
// 계획 §6은 단위 시험(test/compensation-refresh.test.ts)으로 적었지만, purchase에는 배상 저장소의 메모리 짝(CompensationStore)이 없어
// 진짜 DrizzleCompensations의 조건부 갱신을 이 통합 시험이 본다(계획 §7 '인터페이스 빈칸'). payment-svc 송금 조회·ops CS는 포트 대역이다.
// 기준 트리: application/refresh-compensation-transfers.ts가 없어 가져오기부터 실패한다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { compensationCaseEventKey, DrizzleCompensations, RequestCompensationAccount } from '../src/modules/refund/index.js';
import { RefreshCompensationTransfers } from '../src/modules/refund/application/refresh-compensation-transfers.js';
import { CompensationNotAccountPending } from '../src/modules/refund/domain/compensation.js';
import type { CompensationCaseNotice } from '../src/modules/refund/domain/ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const ACCOUNT_NO = '110987654321';

type RefreshDeps = ConstructorParameters<typeof RefreshCompensationTransfers>[0];
type TransferPort = RefreshDeps['transfer'];
type GetAnswer = Awaited<ReturnType<TransferPort['get']>>;

/** payment-svc 배상 송금 포트 대역(RequestCompensationTransfer·GetCompensationTransfer). 조회 결과를 시험이 정한다 */
class TransferDouble implements TransferPort {
  readonly results = new Map<string, { status: 'REQUESTED' | 'PAID' | 'FAILED'; receivableId?: string }>();
  readonly gets: string[] = [];
  readonly requests: unknown[] = [];
  failGet = false;
  requestAnswer: { status: 'REQUESTED' | 'PAID' | 'FAILED'; transferId: string; receivableId?: string } = { status: 'REQUESTED', transferId: 'tr-f078-entry' };
  async request(q: Parameters<TransferPort['request']>[0]) {
    this.requests.push(q);
    return { ...this.requestAnswer, accountLast4: q.account.accountNumber.slice(-4) };
  }
  async get(transferId: string): Promise<GetAnswer> {
    this.gets.push(transferId);
    if (this.failGet) throw Object.assign(new Error('payment-svc UNAVAILABLE'), { code: 14 });
    const r = this.results.get(transferId) ?? { status: 'REQUESTED' as const };
    return { transferId, status: r.status, ...(r.receivableId ? { receivableId: r.receivableId } : {}), ...(r.status === 'FAILED' ? { failureReason: 'bank-rejected' } : {}) };
  }
}

class RecordingCases implements CompensationCaseNotice {
  readonly opened: { compensationId: string; orderId: string; nowMs: number }[] = [];
  async open(q: { compensationId: string; orderId: string; nowMs: number }): Promise<void> {
    this.opened.push({ ...q });
  }
}

let pgc: PostgresContainer | undefined;
let db1: Database;
let db2: Database;
const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePurchase(pgc.url);
  db1 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'compensation-refresh-it-1' });
  db2 = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'compensation-refresh-it-2' });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([db1?.close(), db2?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  await db1.pool.query('truncate compensation');
});

/** compensation 한 행. 계좌 입력 뒤 REQUESTED(송금 ID 있음)이거나 계좌 대기다 */
async function seed(o: { status: 'REQUESTED' | 'ACCOUNT_PENDING'; transferId?: string }) {
  const id = randomUUID();
  const orderId = randomUUID();
  const accountId = randomUUID();
  await db1.pool.query(
    `insert into compensation (id, event_cancellation_request_id, order_id, event_id, account_id, promoter_id, base_amount, amount, status, account_last4, transfer_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 47500, 4750, $7, $8, $9, $10, $10)`,
    [id, randomUUID(), orderId, randomUUID(), accountId, randomUUID(), o.status, o.status === 'REQUESTED' ? '4321' : null, o.transferId ?? null, new Date(NOW - 3_600_000)],
  );
  return { id, orderId, accountId };
}

const row = async (id: string) =>
  (await db1.pool.query<{ status: string; transfer_id: string | null; receivable_id: string | null; account_last4: string | null }>('select status, transfer_id, receivable_id, account_last4 from compensation where id = $1', [id])).rows[0]!;

const refresher = (database: Database, transfer: TransferDouble, cases: RecordingCases) => new RefreshCompensationTransfers({ store: new DrizzleCompensations(database), transfer, cases, clock });

describe('R-T47 ③ 배상 송금 결과 확정(purchase) [실제 PostgreSQL]', () => {
  test('R-T47 ③ REQUESTED → 조회 PAID면 PAID·receivable_id를 저장하고, 다시 돌려도 쓰기·조회가 늘지 않는다', async () => {
    const c = await seed({ status: 'REQUESTED', transferId: 'tr-f078-1' });
    const transfer = new TransferDouble();
    const cases = new RecordingCases();
    const receivableId = randomUUID();
    transfer.results.set('tr-f078-1', { status: 'PAID', receivableId });
    await expect(refresher(db1, transfer, cases).run()).resolves.toEqual({ paid: 1, failed: 0, pending: 0 });
    expect(await row(c.id)).toEqual({ status: 'PAID', transfer_id: 'tr-f078-1', receivable_id: receivableId, account_last4: '4321' });
    expect(cases.opened).toEqual([]);
    await expect(refresher(db1, transfer, cases).run()).resolves.toEqual({ paid: 0, failed: 0, pending: 0 });
    expect(transfer.gets).toEqual(['tr-f078-1']);
  });

  test('R-T47 ③ 조회 FAILED면 FAILED와 CS COMPENSATION_PENDING 한 건(계좌 입력 실패와 같은 사건 키)이다', async () => {
    const c = await seed({ status: 'REQUESTED', transferId: 'tr-f078-2' });
    const transfer = new TransferDouble();
    const cases = new RecordingCases();
    transfer.results.set('tr-f078-2', { status: 'FAILED' });
    await expect(refresher(db1, transfer, cases).run()).resolves.toEqual({ paid: 0, failed: 1, pending: 0 });
    expect(await row(c.id)).toMatchObject({ status: 'FAILED', receivable_id: null });
    expect(cases.opened).toEqual([{ compensationId: c.id, orderId: c.orderId, nowMs: NOW }]);
    // 같은 배상의 CS 건은 계좌 입력 실패와 같은 사건 키(compensation:{id})라 ops가 한 건으로 모은다(TR-14 (라): 계좌 입력 실패 건의 키와 대조)
    const entryFailCases = new RecordingCases();
    const failing = new TransferDouble();
    failing.requestAnswer = { status: 'FAILED', transferId: 'tr-f078-entry-failed' };
    const other = await seed({ status: 'ACCOUNT_PENDING' });
    await new RequestCompensationAccount({ store: new DrizzleCompensations(db1), transfer: failing, notice: entryFailCases, nowMs: () => NOW })
      .run({ accountId: other.accountId, compensationId: other.id, account: { bankCode: '088', accountNumber: ACCOUNT_NO, holderName: '김배상' }, reauthToken: undefined, idempotencyKey: randomUUID() })
      .catch(() => undefined);
    expect(entryFailCases.opened.map((o) => compensationCaseEventKey(o.compensationId))).toEqual([compensationCaseEventKey(other.id)]);
    expect(compensationCaseEventKey(cases.opened[0]!.compensationId)).toBe(compensationCaseEventKey(c.id));
    expect(compensationCaseEventKey(c.id)).not.toBe(compensationCaseEventKey(other.id));
    await refresher(db1, transfer, cases).run();
    expect(cases.opened).toHaveLength(1);
  });

  // F-16: 조회 실패·여전히 REQUESTED → 두 쪽 그대로, 다음 바퀴에 다시 본다
  test('R-T47 ③ 여전히 REQUESTED·조회 실패면 그대로이고 다음 바퀴에 다시 본다. 계좌 대기 행은 보지 않는다', async () => {
    const c = await seed({ status: 'REQUESTED', transferId: 'tr-f078-3' });
    const pending = await seed({ status: 'ACCOUNT_PENDING' });
    const transfer = new TransferDouble();
    const cases = new RecordingCases();
    await expect(refresher(db1, transfer, cases).run()).resolves.toEqual({ paid: 0, failed: 0, pending: 1 });
    transfer.failGet = true;
    await expect(refresher(db1, transfer, cases).run()).resolves.toMatchObject({ paid: 0, failed: 0 });
    expect(await row(c.id)).toMatchObject({ status: 'REQUESTED', receivable_id: null });
    expect(await row(pending.id)).toMatchObject({ status: 'ACCOUNT_PENDING', transfer_id: null });
    expect(transfer.gets.every((g) => g === 'tr-f078-3')).toBe(true);
    transfer.failGet = false;
    transfer.results.set('tr-f078-3', { status: 'PAID', receivableId: randomUUID() });
    await expect(refresher(db1, transfer, cases).run()).resolves.toMatchObject({ paid: 1 });
    expect((await row(c.id)).status).toBe('PAID');
  });

  // F-21: 두 파드의 틱이 겹쳐도 상태 쓰기·CS 건이 하나씩
  test('R-T47 ③ 두 파드(연결 둘)의 틱이 겹쳐도 PAID 쓰기와 FAILED CS 건이 하나씩이다 [ASVS v5.0.0-2.3.4]', async () => {
    const paid = await seed({ status: 'REQUESTED', transferId: 'tr-f078-4' });
    const failed = await seed({ status: 'REQUESTED', transferId: 'tr-f078-5' });
    const transfer = new TransferDouble();
    const cases = new RecordingCases();
    const receivableId = randomUUID();
    transfer.results.set('tr-f078-4', { status: 'PAID', receivableId });
    transfer.results.set('tr-f078-5', { status: 'FAILED' });
    const [a, b] = await Promise.all([refresher(db1, transfer, cases).run(), refresher(db2, transfer, cases).run()]);
    expect(a.paid + b.paid).toBe(1);
    expect(a.failed + b.failed).toBe(1);
    expect(cases.opened.map((o) => o.compensationId)).toEqual([failed.id]);
    expect(await row(paid.id)).toMatchObject({ status: 'PAID', receivable_id: receivableId });
  });

  test('R-T47 ③ 계좌 입력 답(REQUESTED) 뒤 틱이 PAID로 확정하고, 같은 계좌 입력이 다시 와도 PAID·receivable_id가 그대로다. 계좌 원문은 DB·CS 건에 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const c = await seed({ status: 'ACCOUNT_PENDING' });
    const transfer = new TransferDouble();
    const cases = new RecordingCases();
    const store = new DrizzleCompensations(db1);
    const entry = new RequestCompensationAccount({ store, transfer, notice: cases, nowMs: () => NOW });
    const account = { bankCode: '088', accountNumber: ACCOUNT_NO, holderName: '김배상' };
    await entry.run({ accountId: c.accountId, compensationId: c.id, account, reauthToken: undefined, idempotencyKey: randomUUID() });
    expect(await row(c.id)).toMatchObject({ status: 'REQUESTED', transfer_id: 'tr-f078-entry', account_last4: '4321' });
    const receivableId = randomUUID();
    transfer.results.set('tr-f078-entry', { status: 'PAID', receivableId });
    await expect(refresher(db1, transfer, cases).run()).resolves.toMatchObject({ paid: 1 });
    // 늦게 다시 온 계좌 입력은 ACCOUNT_PENDING이 아니라 409이고 행을 바꾸지 않는다
    await expect(entry.run({ accountId: c.accountId, compensationId: c.id, account, reauthToken: undefined, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(CompensationNotAccountPending);
    expect(await row(c.id)).toMatchObject({ status: 'PAID', receivable_id: receivableId, transfer_id: 'tr-f078-entry' });
    const dump = JSON.stringify((await db1.pool.query('select * from compensation')).rows) + JSON.stringify(cases.opened);
    expect(dump).not.toContain(ACCOUNT_NO);
    expect(dump).not.toContain('김배상');
  });
});
