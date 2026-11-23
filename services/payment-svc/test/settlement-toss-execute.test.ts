// J-T38 ①~⑨·J-T5 토스 지급 실행·결과 반영·지급 사건·전송 장애·09시 묶음(F-07-6 LCH-110, settlement §5.1·§5.2·§11·§12, ADR-0369 결정 6·7·10·12·13).
// 진짜 Settlements·TossPayoutGateway·HttpTossPayoutTransport·MemorySettlementStore·SettlementDueWorker·PayoutSubmitWorker를 쓰고,
// 결제사는 시험 안 대역 서버(공개 안내 모양 [가정]), 시간은 가짜 시계다. 단언 값은 정본 값(10억 원 미만, 20건, 1분·30분, 22:00, 12:00, 09:00)이다.
// 날짜: 2026-12-04(금)은 지급일 2026-12-07(월)의 전 영업일이고, 다음 은행 영업일은 2026-12-08(화)이다(은행 영업일은 지금 주말만 뺀다, F-07-5 C-04).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { PayoutSubmitWorker } from '../src/modules/settlement/application/payout-submit-worker.js';
import { HttpSettlementCaseNotice, SettlementDueWorker, SettlementProblem, tossIdempotencyKey, type SaleSuspensionSource, type StatementRecord } from '../src/modules/settlement/index.js';
import { seedTossSeller } from './settlement-support.js';
import { kst, tossHarness, type TossHarness, type TossHarnessOptions } from './support/toss-harness.js';
import { refsOf } from './support/toss-payout-fake.js';

const MIN = 60_000;
const FRI_10 = kst('2026-12-04T10:00:00.000');
const DEADLINE = kst('2026-12-04T22:00:00.000');
const MON = '2026-12-07';
const TUE = '2026-12-08';
const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const iso = (t: number) => new Date(t).toISOString();
const noTimer = { setInterval: () => 0, clearInterval: () => undefined };

let h: TossHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const open = async (o: Partial<TossHarnessOptions> = {}) => (h = await tossHarness({ now: FRI_10, ...o }));
const posts = (x: TossHarness) => x.payoutPosts();

describe('J-T38 ① 실행 접수', () => {
  test('J-T38 ① 25억 원 정산서는 10억 원 미만 3건으로 나가고, 접수되면 지급 건마다 결제사 지급 ID·SCHEDULED·PAYOUT_SCHEDULED(금액 = 지급액) 한 건이다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.partner(promoterId);
    const s = await x.confirmed({ promoterId, amount: 2_500_000_000, payoutDate: MON });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    expect(x.store.statements.get(s.statementId)).toMatchObject({ status: 'CONFIRMED', payoutBatchId: batchId });
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ batchId, status: 'SUBMITTED', lastSubmitError: null, nextSubmitAt: null });
    const payouts = x.payoutsOf(s.statementId);
    expect(payouts.map((p) => [p.seq, p.amount, p.refPayoutId, p.payoutDate, p.status])).toEqual([
      [1, 999_999_999, `${s.statementId}-1`, MON, 'REQUESTED'],
      [2, 999_999_999, `${s.statementId}-2`, MON, 'REQUESTED'],
      [3, 500_000_002, `${s.statementId}-3`, MON, 'REQUESTED'],
    ]);
    expect(payouts.map((p) => p.pgPayoutId)).toEqual(payouts.map((p) => x.fake.payoutByRef(p.refPayoutId)!.id));
    expect(posts(x)).toHaveLength(1);
    expect(x.store.statements.get(s.statementId)?.status).toBe('SCHEDULED');
    const scheduled = x.events('PAYOUT_SCHEDULED');
    expect(scheduled).toEqual([expect.objectContaining({ statementId: s.statementId, promoterId, pg: 'TOSS', pgStore: 'STANDARD', amount: 2_500_000_000, type: 'PAYOUT_SCHEDULED' })]);
    expect(x.store.outbox.filter((e) => e.value.type === 'PAYOUT_SCHEDULED').map((e) => [e.topic, e.key])).toEqual([['trade.settlements', promoterId]]);
  });

  test('J-T38 ① 지급 건 21개 묶음에서 둘째 요청만 응답이 없으면 첫째 20건 정산서만 SCHEDULED·사건이고, 다음 전송은 둘째 요청 하나(같은 키)뿐이다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.partner(promoterId);
    for (let i = 1; i <= 21; i += 1) await x.confirmed({ promoterId, amount: 100_000 + i, payoutDate: MON, statementId: sid(i) });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    // E-01(ADR-0369 결정 14): 묶은 정산서는 CONFIRMED 그대로이고 payoutBatchId만 채워진다(시험 리뷰 TR-13)
    expect(Array.from({ length: 21 }, (_, i) => x.store.statements.get(sid(i + 1))).map((st) => [st?.status, st?.payoutBatchId])).toEqual(Array.from({ length: 21 }, () => ['CONFIRMED', batchId]));
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, when: (r) => refsOf(r).includes(`${sid(21)}-1`) }, 'NO_RESPONSE');
    const view = await x.settlements.executeBatch(batchId);
    const sent = [...posts(x)].sort((a, b) => refsOf(a)[0]!.localeCompare(refsOf(b)[0]!));
    expect(sent.map(refsOf)).toEqual([Array.from({ length: 20 }, (_, i) => `${sid(i + 1)}-1`), [`${sid(21)}-1`]]);
    expect(view).toMatchObject({ status: 'APPROVED', lastSubmitError: 'NO_RESPONSE', nextSubmitAt: iso(FRI_10 + MIN), submitDeadlineAt: iso(DEADLINE) });
    expect(x.store.batches.get(batchId)).toMatchObject({ status: 'APPROVED', submitAttempts: 1, nextSubmitAt: new Date(FRI_10 + MIN), submitDeadlineAt: new Date(DEADLINE), lastSubmitError: 'NO_RESPONSE' });
    for (let i = 1; i <= 20; i += 1) {
      expect(x.payoutsOf(sid(i))[0]?.pgPayoutId).toBe(x.fake.payoutByRef(`${sid(i)}-1`)!.id);
      expect(x.store.statements.get(sid(i))?.status).toBe('SCHEDULED');
    }
    const last = x.payoutsOf(sid(21))[0]!;
    expect(last.pgPayoutId).toBeNull();
    // 접수되지 않은 정산서는 SCHEDULED가 아니다(조각이 모두 접수된 정산서만 SCHEDULED)
    expect(x.store.statements.get(sid(21))).toMatchObject({ status: 'CONFIRMED', payoutBatchId: batchId });
    expect(x.events('PAYOUT_SCHEDULED').map((e) => [e.statementId, e.amount])).toEqual(Array.from({ length: 20 }, (_, i) => [sid(i + 1), 100_000 + i + 1]));
    const failedKey = sent[1]!.headers['idempotency-key'];
    expect(failedKey).toBe(tossIdempotencyKey([last], MON));
    expect(failedKey).not.toBe(sent[0]!.headers['idempotency-key']);

    x.at(FRI_10 + MIN - 1);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(2);
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(3);
    expect([refsOf(posts(x)[2]!), posts(x)[2]!.headers['idempotency-key']]).toEqual([[`${sid(21)}-1`], failedKey]);
    expect(x.store.statements.get(sid(21))?.status).toBe('SCHEDULED');
    expect(x.events('PAYOUT_SCHEDULED')).toHaveLength(21);
    expect(x.store.batches.get(batchId)).toMatchObject({ status: 'SUBMITTED', nextSubmitAt: null });
  });
});

/** 25억 원 정산서 하나를 실행까지 마친다 */
async function executed25() {
  const x = await open();
  const promoterId = randomUUID();
  await x.partner(promoterId);
  const s = await x.confirmed({ promoterId, amount: 2_500_000_000, payoutDate: MON });
  const batchId = await x.approvedBatch({ payoutDate: MON });
  await x.settlements.executeBatch(batchId);
  const payouts = x.payoutsOf(s.statementId);
  return { x, s, batchId, payouts, ids: payouts.map((p) => p.pgPayoutId!) };
}

describe('J-T38 ② 지급 결과 반영', () => {
  test('J-T38 ② 조각 3건 가운데 2건만 COMPLETED면 SCHEDULED 그대로, 3건이 끝나면 PAID·PAYOUT_COMPLETED 한 건·묶음 COMPLETED, 같은 사실을 다시 반영해도 한 번이다', async () => {
    const { x, s, batchId, ids } = await executed25();
    const at = new Date(x.clock.now());
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[0]!, status: 'COMPLETED', observedAt: at })).toEqual({ applied: true });
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[1]!, status: 'COMPLETED', observedAt: at })).toEqual({ applied: true });
    expect(x.store.statements.get(s.statementId)?.status).toBe('SCHEDULED');
    expect(x.events('PAYOUT_COMPLETED')).toEqual([]);
    expect(x.store.batches.get(batchId)?.status).toBe('SUBMITTED');
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[2]!, status: 'COMPLETED', observedAt: at })).toEqual({ applied: true });
    expect(x.store.statements.get(s.statementId)?.status).toBe('PAID');
    expect(x.events('PAYOUT_COMPLETED')).toEqual([expect.objectContaining({ statementId: s.statementId, amount: 2_500_000_000 })]);
    expect(x.store.batches.get(batchId)?.status).toBe('COMPLETED');
    // 같은 결과를 두 번 반영해도 상태와 사건은 한 번이다
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[2]!, status: 'COMPLETED', observedAt: at })).toEqual({ applied: false });
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[0]!, status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', observedAt: at })).toEqual({ applied: false });
    expect(x.events('PAYOUT_COMPLETED')).toHaveLength(1);
    expect(x.events('PAYOUT_FAILED')).toEqual([]);
    expect(x.store.statements.get(s.statementId)?.status).toBe('PAID');
    // 모르는 결제사 지급 ID는 아무것도 바꾸지 않는다
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: 'FPAY-UNKNOWN', status: 'COMPLETED', observedAt: at })).toEqual({ applied: false });
  });

  test('J-T38 ② 한 건이 FAILED면 정산서 FAILED·PAYOUT_FAILED(금액 = 그 지급 건)·실패 갈래 기록이고 묶음은 PARTIAL_FAILED다', async () => {
    const { x, s, batchId, payouts, ids } = await executed25();
    const at = new Date(x.clock.now());
    await x.settlements.applyPayoutFact({ pgPayoutId: ids[0]!, status: 'COMPLETED', observedAt: at });
    await x.settlements.applyPayoutFact({ pgPayoutId: ids[1]!, status: 'IN_PROGRESS', observedAt: at });
    await x.settlements.applyPayoutFact({ pgPayoutId: ids[1]!, status: 'COMPLETED', observedAt: at });
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[2]!, status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', observedAt: at })).toEqual({ applied: true });
    expect(x.store.statements.get(s.statementId)?.status).toBe('FAILED');
    expect(x.store.payouts.get(payouts[2]!.payoutId)).toMatchObject({ status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', failureClass: 'ACCOUNT' });
    expect(x.events('PAYOUT_FAILED')).toEqual([expect.objectContaining({ statementId: s.statementId, amount: 500_000_002 })]);
    expect(x.store.batches.get(batchId)?.status).toBe('PARTIAL_FAILED');
    expect(await x.settlements.applyPayoutFact({ pgPayoutId: ids[2]!, status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', observedAt: at })).toEqual({ applied: false });
    expect(x.events('PAYOUT_FAILED')).toHaveLength(1);
    expect(x.events('PAYOUT_COMPLETED')).toEqual([]);
  });
});

describe('J-T38 ③ 오류 응답과 예약 날짜 오류', () => {
  async function oneStatementBatch() {
    const x = await open();
    const promoterId = randomUUID();
    await x.partner(promoterId);
    const s = await x.confirmed({ promoterId, amount: 3_000_000, payoutDate: MON });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    return { x, s, batchId };
  }

  test('J-T38 ③ 오류 응답이면 키를 바꾸지 않고 CS PAYOUT_ERROR 한 건(대상 = 묶음)·묶음 APPROVED·자동 재전송 없음이고, 다시 실행하면 같은 키다', async () => {
    const { x, s, batchId } = await oneStatementBatch();
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, { code: 'INVALID_DESTINATION', status: 400 });
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ status: 'APPROVED', lastSubmitError: 'INVALID_DESTINATION', nextSubmitAt: null });
    expect(x.cases('PAYOUT_ERROR')).toEqual([expect.objectContaining({ eventKey: `payout-error:${batchId}:1`, kind: 'PAYOUT_ERROR', sourceId: batchId, requestedAt: null })]);
    expect(x.payoutsOf(s.statementId)[0]?.pgPayoutId).toBeNull();
    x.at(FRI_10 + 2 * 60 * MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(1);
    const again = await x.settlements.executeBatch(batchId);
    expect(again.status).toBe('SUBMITTED');
    expect(posts(x).map((r) => r.headers['idempotency-key'])).toEqual([posts(x)[0]!.headers['idempotency-key'], posts(x)[0]!.headers['idempotency-key']]);
    expect(posts(x)[1]!.headers['idempotency-key']).toBe(tossIdempotencyKey(x.payoutsOf(s.statementId), MON));
    expect(x.cases('PAYOUT_ERROR')).toHaveLength(1);
  });

  test('J-T38 ③ 예약 날짜 오류면 지급일을 다음 은행 영업일로 바꿔 새 키로 곧바로 한 번 다시 보낸다', async () => {
    const { x, s, batchId } = await oneStatementBatch();
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, { code: 'INVALID_PAYOUT_DATE', status: 400 });
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ status: 'SUBMITTED', payoutDate: TUE });
    const [first, second] = posts(x);
    expect([posts(x).length, (first!.body as { payoutDate: string }[])[0]!.payoutDate, (second!.body as { payoutDate: string }[])[0]!.payoutDate]).toEqual([2, MON, TUE]);
    expect(second!.headers['idempotency-key']).not.toBe(first!.headers['idempotency-key']);
    expect(second!.headers['idempotency-key']).toBe(tossIdempotencyKey(x.payoutsOf(s.statementId), TUE));
    expect(x.store.batches.get(batchId)).toMatchObject({ payoutDate: TUE, dateRetryUsed: true });
    expect(x.payoutsOf(s.statementId).map((p) => p.payoutDate)).toEqual([TUE]);
    expect(x.cases('PAYOUT_ERROR')).toEqual([]);
  });

  test('J-T38 ③ 바꾼 지급일로도 날짜 오류면 더 보내지 않고 PAYOUT_ERROR다', async () => {
    const { x, batchId } = await oneStatementBatch();
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, times: 2 }, { code: 'INVALID_PAYOUT_DATE', status: 400 });
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ status: 'APPROVED', lastSubmitError: 'INVALID_PAYOUT_DATE' });
    expect(posts(x)).toHaveLength(2);
    expect(x.cases('PAYOUT_ERROR').map((c) => c.sourceId)).toEqual([batchId]);
    await x.settlements.executeBatch(batchId);
    // 날짜 오류 한 번 재요청은 이미 썼으므로 사람이 다시 실행하면 바꾼 지급일 그대로 같은 키다
    expect(posts(x)).toHaveLength(3);
    expect(posts(x)[2]!.headers['idempotency-key']).toBe(posts(x)[1]!.headers['idempotency-key']);
  });
});

describe('J-T38 ④ 잔액 확인', () => {
  /** 화요일 지급분 30만 원이 결제사에 예약된 채(끝나지 않음) 있는 상점 */
  async function withUnfinishedOther() {
    const x = await open();
    const other = randomUUID();
    await x.partner(other);
    await x.confirmed({ promoterId: other, amount: 300_000, payoutDate: TUE });
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: TUE }));
    expect(posts(x)).toHaveLength(1);
    const promoterId = randomUUID();
    await x.partner(promoterId);
    return { x, promoterId };
  }

  test('J-T38 ④ 요청 직전 지급 가능 잔액 − 이 묶음 밖의 끝나지 않은 예약지급이 보낼 금액보다 1원 적으면 보내지 않고 PAYOUT_DELAYED 한 건, 같아지면 보낸다', async () => {
    const { x, promoterId } = await withUnfinishedOther();
    await x.confirmed({ promoterId, amount: 1_000_000, payoutDate: MON });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    x.fake.balances.STANDARD = { available: 1_299_999, pending: 5_000_000 };
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ status: 'APPROVED', lastSubmitError: 'BALANCE_SHORT', nextSubmitAt: iso(FRI_10 + MIN) });
    expect(posts(x)).toHaveLength(1);
    expect(x.cases('PAYOUT_DELAYED')).toEqual([expect.objectContaining({ eventKey: `payout-balance:${batchId}`, sourceId: batchId })]);
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(1);
    expect(x.cases('PAYOUT_DELAYED')).toHaveLength(1);
    x.fake.balances.STANDARD = { available: 1_300_000, pending: 0 };
    x.at(FRI_10 + 3 * MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(2);
    expect(x.store.batches.get(batchId)?.status).toBe('SUBMITTED');
  });

  /**
   * 같은 상점(일반) 화요일 묶음의 지급 건 넷: COMPLETED 100,000·FAILED 200,000·IN_PROGRESS 300,000·REQUESTED 400,000,
   * 에스크로 상점의 REQUESTED 900,000. 끝나지 않은 일반 상점 예약지급 = 300,000 + 400,000 = 700,000이다(시험 리뷰 TR-10)
   */
  async function withMixedOthers() {
    const x = await open();
    const other = randomUUID();
    await x.partner(other);
    const ss: StatementRecord[] = [];
    for (const amount of [100_000, 200_000, 300_000, 400_000]) ss.push(await x.confirmed({ promoterId: other, amount, payoutDate: TUE }));
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: TUE }));
    const at = new Date(x.clock.now());
    const pg = (i: number) => x.payoutsOf(ss[i]!.statementId)[0]!.pgPayoutId!;
    await x.settlements.applyPayoutFact({ pgPayoutId: pg(0), status: 'COMPLETED', observedAt: at });
    await x.settlements.applyPayoutFact({ pgPayoutId: pg(1), status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', observedAt: at });
    await x.settlements.applyPayoutFact({ pgPayoutId: pg(2), status: 'IN_PROGRESS', observedAt: at });
    await x.confirmed({ promoterId: other, amount: 900_000, payoutDate: TUE, pgStore: 'ESCROW' });
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: TUE, pgStore: 'ESCROW' }));
    const promoterId = randomUUID();
    await x.partner(promoterId);
    return { x, promoterId };
  }

  test('J-T38 ④ 요청 직전에 빼는 것은 같은 상점의 끝나지 않은(REQUESTED·IN_PROGRESS) 예약지급뿐이다: COMPLETED·FAILED·다른 상점은 빼지 않는다', async () => {
    const { x, promoterId } = await withMixedOthers();
    await x.confirmed({ promoterId, amount: 1_000_000, payoutDate: MON });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    const before = posts(x).length;
    x.fake.balances.STANDARD = { available: 1_699_999, pending: 0 };
    await x.settlements.executeBatch(batchId);
    expect(posts(x).length - before).toBe(0);
    expect(x.cases('PAYOUT_DELAYED').map((c) => c.eventKey)).toEqual([`payout-balance:${batchId}`]);
    x.fake.balances.STANDARD = { available: 1_700_000, pending: 0 };
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x).length - before).toBe(1);
    expect(x.store.batches.get(batchId)?.status).toBe('SUBMITTED');
  });

  test('J-T38 ④ 묶음을 만들 때의 비교도 같은 상점의 REQUESTED·IN_PROGRESS만 더한다(1원 적으면 HELD·BALANCE, 같으면 묶음)', async () => {
    const a = await withMixedOthers();
    const s = await a.x.confirmed({ promoterId: a.promoterId, amount: 1_000_000, payoutDate: MON });
    a.x.fake.balances.STANDARD = { available: 1_699_999, pending: 0 };
    await expect(a.x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-balance-insufficient') });
    expect(a.x.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'BALANCE' });
    await h?.close();
    const b = await withMixedOthers();
    await b.x.confirmed({ promoterId: b.promoterId, amount: 1_000_000, payoutDate: MON });
    b.x.fake.balances.STANDARD = { available: 1_700_000, pending: 0 };
    expect((await b.x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() })).totalAmount).toBe(1_000_000);
  });

  test('J-T38 ④ 이 묶음 안에서 이미 접수된 지급 건은 빼지 않는다(남은 둘째 요청 금액과 같은 잔액이면 보낸다)', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.partner(promoterId);
    for (let i = 1; i <= 21; i += 1) await x.confirmed({ promoterId, amount: 10_000, payoutDate: MON, statementId: sid(i) });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, when: (r) => refsOf(r).includes(`${sid(21)}-1`) }, 'NO_RESPONSE');
    await x.settlements.executeBatch(batchId);
    expect(posts(x)).toHaveLength(2);
    x.fake.balances.STANDARD = { available: 9_999, pending: 0 };
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(2);
    expect(x.cases('PAYOUT_DELAYED').map((c) => c.eventKey)).toEqual([`payout-balance:${batchId}`]);
    x.fake.balances.STANDARD = { available: 10_000, pending: 0 };
    x.at(FRI_10 + 3 * MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(3);
    expect(refsOf(posts(x)[2]!)).toEqual([`${sid(21)}-1`]);
  });

  test('J-T38 ④ 잔액 원천이 답하지 않으면 보내지 않고 응답 없음과 같은 간격으로 다시 본다', async () => {
    const { x, promoterId } = await withUnfinishedOther();
    await x.confirmed({ promoterId, amount: 1_000_000, payoutDate: MON });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    x.fake.inject({ method: 'GET', path: /^\/v2\/balances$/ }, 'NO_RESPONSE');
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ status: 'APPROVED', nextSubmitAt: iso(FRI_10 + MIN) });
    expect(posts(x)).toHaveLength(1);
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(2);
  });

  test('J-T38 ④ 묶음을 만들 때도 끝나지 않은 토스 예약지급 합을 더해 견준다(1원 적으면 HELD·BALANCE, 같으면 묶음)', async () => {
    const a = await withUnfinishedOther();
    const s = await a.x.confirmed({ promoterId: a.promoterId, amount: 1_000_000, payoutDate: MON });
    a.x.fake.balances.STANDARD = { available: 1_299_999, pending: 0 };
    await expect(a.x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-balance-insufficient') });
    expect(a.x.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'BALANCE' });
    await h?.close();
    const b = await withUnfinishedOther();
    await b.x.confirmed({ promoterId: b.promoterId, amount: 1_000_000, payoutDate: MON });
    b.x.fake.balances.STANDARD = { available: 1_300_000, pending: 0 };
    const batch = await b.x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() });
    expect(batch.totalAmount).toBe(1_000_000);
  });
});

describe('J-T38 ⑤ 묶음 때의 사건', () => {
  test('J-T38 ⑤ 보류된 정산서마다 PAYOUT_HELD(금액 = 지급액), 상계로 남은 금액이 0이 된 미수금마다 RECEIVABLE_CLOSED(금액 = 미수금 금액)이고, 남은 미수금은 사건이 없다', async () => {
    const x = await open({ noBalance: true });
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    await x.partner(a, { STANDARD: 'APPROVED' });
    await x.partner(b, {});
    await x.partner(c, { STANDARD: 'APPROVED' });
    const sa = await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    const sb = await x.confirmed({ promoterId: b, amount: 700_000, payoutDate: MON });
    const sc = await x.confirmed({ promoterId: c, amount: 500_000, payoutDate: MON });
    const closed = await x.settlements.recordReceivable({ promoterId: a, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 250_000 });
    const partial = await x.settlements.recordReceivable({ promoterId: c, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 2_000_000 });
    const batch = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() });
    expect([batch.statementCount, batch.totalAmount]).toEqual([1, 750_000]);
    expect(x.events('PAYOUT_HELD')).toEqual([expect.objectContaining({ statementId: sb.statementId, promoterId: b, amount: 700_000 })]);
    expect(x.events('RECEIVABLE_CLOSED')).toEqual([expect.objectContaining({ promoterId: a, statementId: sa.statementId, amount: 250_000 })]);
    expect(x.store.receivables.get(closed.receivableId)).toMatchObject({ remaining: 0, status: 'CLOSED' });
    expect(x.store.receivables.get(partial.receivableId)).toMatchObject({ remaining: 1_500_000, status: 'OPEN' });
    expect(x.store.statements.get(sc.statementId)?.status).toBe('CARRIED_OVER');
  });

  test('J-T38 ⑤ 모두 보류된 묶음 요청(409)과 잔액 부족 보류도 보류한 정산서마다 PAYOUT_HELD를 남긴다', async () => {
    const x = await open();
    const b = randomUUID();
    const a = randomUUID();
    await x.partner(b, {});
    const sb = await x.confirmed({ promoterId: b, amount: 700_000, payoutDate: MON });
    await expect(x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
    expect(x.events('PAYOUT_HELD').map((e) => [e.statementId, e.amount])).toEqual([[sb.statementId, 700_000]]);
    await x.partner(a, { STANDARD: 'APPROVED' });
    const s1 = await x.confirmed({ promoterId: a, amount: 600_000, payoutDate: TUE });
    const s2 = await x.confirmed({ promoterId: a, amount: 400_001, payoutDate: TUE });
    x.fake.balances.STANDARD = { available: 1_000_000, pending: 0 };
    await expect(x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: TUE, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-balance-insufficient') });
    expect(x.events('PAYOUT_HELD').slice(1).map((e) => [e.statementId, e.amount]).sort()).toEqual([
      [s1.statementId, 600_000],
      [s2.statementId, 400_001],
    ].sort());
  });
});

describe('J-T38 ⑥ CS 건 요청', () => {
  test('J-T38 ⑥ CS 건 요청은 원인과 함께 settlement_case_request에 남고, ops가 503이면 남은 채로, 다음 점검이 보내 보낸 시각을 채우며 다시 보내지 않는다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    await x.partner(promoterId);
    await x.confirmed({ promoterId, amount: 3_000_000, payoutDate: MON });
    const batchId = await x.approvedBatch({ payoutDate: MON });
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, { code: 'INVALID_DESTINATION', status: 400 });
    await x.settlements.executeBatch(batchId);
    x.caseNotice.failing = true;
    expect(await x.settlements.retryPayoutCases()).toEqual({ sent: 0, pending: 1 });
    expect(x.cases('PAYOUT_ERROR')[0]?.requestedAt).toBeNull();
    x.caseNotice.failing = false;
    x.clock.advance(30 * MIN);
    expect(await x.settlements.retryPayoutCases()).toEqual({ sent: 1, pending: 0 });
    expect(x.caseNotice.cases).toEqual([{ eventKey: `payout-error:${batchId}:1`, kind: 'PAYOUT_ERROR', sourceId: batchId, createdAt: new Date(FRI_10) }]);
    expect(x.cases('PAYOUT_ERROR')[0]?.requestedAt).toEqual(new Date(FRI_10 + 30 * MIN));
    expect(await x.settlements.retryPayoutCases()).toEqual({ sent: 0, pending: 0 });
    expect(x.caseNotice.cases).toHaveLength(1);
  });

  test('J-T38 ⑥ 정산 일꾼의 30분 tick이 보내지 못한 지급 쪽 CS 건을 보낸다', async () => {
    const x = await open();
    const promoterId = randomUUID();
    const sellers = await x.partner(promoterId);
    x.caseNotice.failing = true;
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellers.STANDARD!, status: 'KYC_REQUIRED', checkedAt: new Date(FRI_10) });
    x.caseNotice.failing = false;
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });
    x.at(kst('2026-12-04T10:30:00.000'));
    await worker.tick(false);
    expect(x.caseNotice.cases.map((c) => [c.kind, c.sourceId])).toEqual([['SELLER_KYC_REQUIRED', sellers.STANDARD]]);
    expect(x.cases('SELLER_KYC_REQUIRED')[0]?.requestedAt).toEqual(new Date(kst('2026-12-04T10:30:00.000')));
  });

  test('J-T38 ⑥ HttpSettlementCaseNotice.openCase는 ops POST /internal/v1/cs-cases에 사건 키·종류·대상·SETTLEMENT를 보내고, 받지 않으면(accepted false·5xx) 던진다', async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    let answer: { status: number; body: unknown } = { status: 202, body: { accepted: true, caseId: 'c-1' } };
    const notice = new HttpSettlementCaseNotice('http://ops-svc:8080', 'internal-token', async (input, init) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    });
    const createdAt = new Date(FRI_10);
    await notice.openCase({ eventKey: 'payout-overdue:p-1', kind: 'PAYOUT_DELAYED', sourceId: 'p-1', createdAt });
    expect(calls).toEqual([
      {
        url: 'http://ops-svc:8080/internal/v1/cs-cases',
        headers: expect.objectContaining({ 'x-peaket-internal-token': 'internal-token', 'content-type': 'application/json' }),
        body: { eventKey: 'payout-overdue:p-1', kind: 'PAYOUT_DELAYED', sourceId: 'p-1', category: 'SETTLEMENT', createdAt: createdAt.toISOString() },
      },
    ]);
    answer = { status: 202, body: { accepted: false } };
    await expect(notice.openCase({ eventKey: 'k', kind: 'PG_BALANCE_MISMATCH', sourceId: 'TOSS:STANDARD', createdAt })).rejects.toMatchObject({ status: 503 });
    answer = { status: 503, body: {} };
    await expect(notice.openCase({ eventKey: 'k', kind: 'PAYOUT_ERROR', sourceId: 'b', createdAt })).rejects.toMatchObject({ status: 503 });
  });
});

describe('J-T38 ⑦ 지표', () => {
  test('J-T38 ⑦ settlement_payout_failed_total{pg,reason}은 실패 반영마다(같은 사실 두 번은 한 번), settlement_seller_kyc_required{pg}는 KYC_REQUIRED 셀러 수로 바뀐다', async () => {
    const x = await open();
    const a = randomUUID();
    const b = randomUUID();
    const sa = await x.partner(a);
    const sb = await x.partner(b);
    const s1 = await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    const s2 = await x.confirmed({ promoterId: b, amount: 2_000_000, payoutDate: MON });
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: MON }));
    const at = new Date(x.clock.now());
    await x.settlements.applyPayoutFact({ pgPayoutId: x.payoutsOf(s1.statementId)[0]!.pgPayoutId!, status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', observedAt: at });
    await x.settlements.applyPayoutFact({ pgPayoutId: x.payoutsOf(s1.statementId)[0]!.pgPayoutId!, status: 'FAILED', errorCode: 'ACCOUNT_CLOSED', observedAt: at });
    await x.settlements.applyPayoutFact({ pgPayoutId: x.payoutsOf(s2.statementId)[0]!.pgPayoutId!, status: 'FAILED', errorCode: 'BANK_MAINTENANCE', observedAt: at });
    expect(await x.metricValue('settlement_payout_failed_total', { pg: 'TOSS', reason: 'ACCOUNT' })).toBe(1);
    expect(await x.metricValue('settlement_payout_failed_total', { pg: 'TOSS', reason: 'TRANSIENT' })).toBe(1);

    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sa.STANDARD!, status: 'KYC_REQUIRED', checkedAt: at });
    await x.settlements.applyTossSellerFact({ pgStore: 'ESCROW', tossSellerId: sb.ESCROW!, status: 'KYC_REQUIRED', checkedAt: at });
    expect(await x.metricValue('settlement_seller_kyc_required', { pg: 'TOSS' })).toBe(2);
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sa.STANDARD!, status: 'APPROVED', checkedAt: new Date(at.getTime() + 1) });
    expect(await x.metricValue('settlement_seller_kyc_required', { pg: 'TOSS' })).toBe(1);
  });
});

describe('J-T38 ⑧ 지급일 다음 영업일 12시 미완료 점검', () => {
  test('J-T38 ⑧ 금요일 지급분은 월요일 12:00 KST부터 단건 조회하고(11:59:59.999·토요일 12시는 조회 없음), 끝난 건은 반영, 여전히 미완료면 PAYOUT_DELAYED 한 건과 overdue 지표 1이다', async () => {
    const x = await open({ now: kst('2026-12-10T10:00:00.000') });
    const promoterId = randomUUID();
    await x.partner(promoterId);
    const done = await x.confirmed({ promoterId, amount: 1_100_000, payoutDate: '2026-12-11' });
    const late = await x.confirmed({ promoterId, amount: 2_200_000, payoutDate: '2026-12-11' });
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: '2026-12-11' }));
    const pDone = x.payoutsOf(done.statementId)[0]!;
    const pLate = x.payoutsOf(late.statementId)[0]!;
    x.fake.setPayout(pDone.pgPayoutId!, 'COMPLETED');
    x.fake.setPayout(pLate.pgPayoutId!, 'IN_PROGRESS');
    const gets = () => x.fake.calls('GET', /^\/v2\/payouts\//).length;

    x.at(kst('2026-12-12T12:00:00.000'));
    expect(await x.settlements.checkOverduePayouts()).toEqual({ checked: 0, delayed: 0 });
    x.at(kst('2026-12-14T11:59:59.999'));
    expect(await x.settlements.checkOverduePayouts()).toEqual({ checked: 0, delayed: 0 });
    expect(gets()).toBe(0);
    x.at(kst('2026-12-14T12:00:00.000'));
    expect(await x.settlements.checkOverduePayouts()).toEqual({ checked: 2, delayed: 1 });
    expect(x.fake.calls('GET', /^\/v2\/payouts\//).map((r) => r.path).sort()).toEqual([`/v2/payouts/${pDone.pgPayoutId}`, `/v2/payouts/${pLate.pgPayoutId}`].sort());
    expect(x.store.statements.get(done.statementId)?.status).toBe('PAID');
    expect(x.store.payouts.get(pLate.payoutId)?.status).toBe('IN_PROGRESS');
    expect(x.cases('PAYOUT_DELAYED')).toEqual([expect.objectContaining({ eventKey: `payout-overdue:${pLate.payoutId}`, sourceId: pLate.payoutId })]);
    expect(await x.metricValue('settlement_payout_overdue_total', { pg: 'TOSS' })).toBe(1);
    // 다음 30분 점검이 같은 미완료 건을 다시 봐도 CS 건·카운터는 그대로 한 번이다(시험 리뷰 TR-05 (가))
    x.at(kst('2026-12-14T12:30:00.000'));
    await x.settlements.checkOverduePayouts();
    expect(x.cases('PAYOUT_DELAYED')).toHaveLength(1);
    expect(await x.metricValue('settlement_payout_overdue_total', { pg: 'TOSS' })).toBe(1);
  });

  test('J-T38 ⑧ 정산 일꾼의 30분 tick이 미완료 점검을 부른다: 월요일 11:30 tick은 조회 없음, 12:00 tick에 단건 조회와 PAYOUT_DELAYED(시험 리뷰 TR-05 (나))', async () => {
    const x = await open({ now: kst('2026-12-10T10:00:00.000') });
    const promoterId = randomUUID();
    await x.partner(promoterId);
    const s = await x.confirmed({ promoterId, amount: 3_300_000, payoutDate: '2026-12-11' });
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: '2026-12-11' }));
    const p = x.payoutsOf(s.statementId)[0]!;
    x.fake.setPayout(p.pgPayoutId!, 'IN_PROGRESS');
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });
    x.at(kst('2026-12-14T11:30:00.000'));
    await worker.tick(false);
    expect(x.fake.calls('GET', /^\/v2\/payouts\//)).toHaveLength(0);
    expect(x.cases('PAYOUT_DELAYED')).toEqual([]);
    x.at(kst('2026-12-14T12:00:00.000'));
    await worker.tick(false);
    expect(x.fake.calls('GET', /^\/v2\/payouts\//).map((r) => r.path)).toEqual([`/v2/payouts/${p.pgPayoutId}`]);
    expect(x.cases('PAYOUT_DELAYED').map((c) => c.eventKey)).toEqual([`payout-overdue:${p.payoutId}`]);
  });
});

describe('J-T38 ⑨ 09시 토스 지급 묶음 자동 만들기', () => {
  test('J-T38 ⑨ 지급일 전 영업일 09:00 KST 첫 tick에 상점마다 PREPARED 하나(08:59:59.999에는 없음), 보류는 저장·PAYOUT_HELD, 정산서 결속·상계는 0이고 같은 날 다시 돌아도 하나다', async () => {
    const x = await open({ now: kst('2026-12-04T08:59:59.999'), noBalance: true });
    const a = randomUUID();
    const b = randomUUID();
    await x.partner(a);
    await x.partner(b, {});
    const s1 = await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    const s2 = await x.confirmed({ promoterId: a, amount: 2_000_000, payoutDate: MON });
    const held = await x.confirmed({ promoterId: b, amount: 700_000, payoutDate: MON });
    await x.confirmed({ promoterId: a, amount: 3_000_000, payoutDate: MON, pg: 'PORTONE' });
    const receivable = await x.settlements.recordReceivable({ promoterId: a, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 100_000 });
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });

    await worker.tick(false);
    expect([...x.store.batches.values()]).toEqual([]);
    x.at(kst('2026-12-04T09:00:00.000'));
    await worker.tick(false);
    const prepared = [...x.store.batches.values()];
    expect(prepared.map((p) => [p.pg, p.pgStore, p.payoutDate, p.status, p.totalAmount, p.statementCount])).toEqual([['TOSS', 'STANDARD', MON, 'PREPARED', 2_900_000, 2]]);
    expect([s1, s2].map((s) => x.store.statements.get(s.statementId)?.payoutBatchId)).toEqual([null, null]);
    expect([s1, s2].map((s) => x.store.statements.get(s.statementId)?.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(x.store.receivableMoves).toEqual([]);
    expect(x.store.receivables.get(receivable.receivableId)).toMatchObject({ remaining: 100_000, status: 'OPEN' });
    expect(x.store.statements.get(held.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
    expect(x.events('PAYOUT_HELD').map((e) => [e.statementId, e.amount])).toEqual([[held.statementId, 700_000]]);
    expect(x.events('RECEIVABLE_CLOSED')).toEqual([]);
    x.at(kst('2026-12-04T09:30:00.000'));
    await worker.tick(false);
    expect(await x.settlements.prepareTossBatches(MON)).toEqual({ prepared: 0 });
    expect(x.store.batches.size).toBe(1);
  });

  test('J-T38 ⑨ operator 확인 요청은 같은 묶음 ID로 그때의 확정 정산서(09시 뒤 확정 포함)를 묶고 상계를 한 번 쓴 뒤 PENDING_APPROVAL이며, 겹친 요청 둘 가운데 하나만 이긴다', async () => {
    const x = await open({ now: kst('2026-12-04T09:00:00.000'), noBalance: true });
    const a = randomUUID();
    await x.partner(a);
    await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    await x.confirmed({ promoterId: a, amount: 2_000_000, payoutDate: MON });
    const receivable = await x.settlements.recordReceivable({ promoterId: a, pg: 'TOSS', cause: 'REFUND_AFTER_PAYOUT', amount: 100_000 });
    expect(await x.settlements.prepareTossBatches(MON)).toEqual({ prepared: 1 });
    const [prepared] = [...x.store.batches.values()];
    x.at(kst('2026-12-04T11:00:00.000'));
    const after = await x.confirmed({ promoterId: a, amount: 500_000, payoutDate: MON });
    const input = { pg: 'TOSS' as const, pgStore: 'STANDARD' as const, payoutDate: MON, actor: randomUUID() };
    const results = await Promise.allSettled([x.settlements.createPayoutBatch(input), x.settlements.createPayoutBatch(input)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, type: expect.stringContaining('payout-batch-exists') } });
    expect((won[0] as PromiseFulfilledResult<{ batchId: string; status: string; totalAmount: number; statementCount: number }>).value).toMatchObject({ batchId: prepared!.batchId, status: 'PENDING_APPROVAL', totalAmount: 3_400_000, statementCount: 3 });
    expect(x.store.batches.size).toBe(1);
    expect(x.store.statements.get(after.statementId)?.payoutBatchId).toBe(prepared!.batchId);
    expect(x.store.receivableMoves.map((m) => [m.receivableId, m.amount])).toEqual([[receivable.receivableId, 100_000]]);
    expect(x.events('RECEIVABLE_CLOSED')).toHaveLength(1);
  });

  test('J-T38 ⑨ 확정이 그대로면 PREPARED의 합계·건수는 요청 때 계산과 같고, 확정 정산서가 없는 상점과 포트원은 묶음이 없다', async () => {
    const x = await open({ now: kst('2026-12-04T09:00:00.000'), noBalance: true });
    const c = randomUUID();
    await x.partner(c);
    await x.confirmed({ promoterId: c, amount: 800_000, payoutDate: MON, pgStore: 'ESCROW' });
    await x.confirmed({ promoterId: c, amount: 1, payoutDate: MON, pgStore: 'ESCROW' });
    await x.confirmed({ promoterId: c, amount: 9_000, payoutDate: MON, pg: 'PORTONE' });
    expect(await x.settlements.prepareTossBatches(MON)).toEqual({ prepared: 1 });
    const [prepared] = [...x.store.batches.values()];
    expect(prepared).toMatchObject({ pg: 'TOSS', pgStore: 'ESCROW', status: 'PREPARED', totalAmount: 800_001, statementCount: 2 });
    const requested = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'ESCROW', payoutDate: MON, actor: randomUUID() });
    expect([requested.batchId, requested.totalAmount, requested.statementCount]).toEqual([prepared!.batchId, 800_001, 2]);
    expect([...x.store.batches.values()].filter((b) => b.pg === 'PORTONE' || b.pgStore === 'STANDARD')).toEqual([]);
  });

  test('J-T38 ⑨ 판매 중지 원천이 503이면 다음 30분 tick에 다시 하고, 세 번째 실패에 PAYOUT_DELAYED(대상 TOSS:{상점}:{지급일}) 한 건이다', async () => {
    let failing = true;
    const suspensions: SaleSuspensionSource = {
      listSuspended: async () => {
        if (failing) throw new SettlementProblem('dependency-unavailable', 503, 'core-svc가 답하지 않는다');
        return new Set();
      },
    };
    const x = await open({ now: kst('2026-12-04T09:00:00.000'), noBalance: true, saleSuspensions: suspensions });
    const a = randomUUID();
    await x.partner(a);
    await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });
    await worker.tick(false);
    x.at(kst('2026-12-04T09:30:00.000'));
    await worker.tick(false);
    expect(x.cases('PAYOUT_DELAYED')).toEqual([]);
    expect(x.store.batches.size).toBe(0);
    x.at(kst('2026-12-04T10:00:00.000'));
    await worker.tick(false);
    expect(x.cases('PAYOUT_DELAYED')).toEqual([expect.objectContaining({ eventKey: `TOSS:STANDARD:${MON}`, sourceId: `TOSS:STANDARD:${MON}` })]);
    failing = false;
    x.at(kst('2026-12-04T10:30:00.000'));
    await worker.tick(false);
    expect([...x.store.batches.values()].map((b) => b.status)).toEqual(['PREPARED']);
    expect(x.cases('PAYOUT_DELAYED')).toHaveLength(1);
  });
});

describe('J-T38 ⑨ 09시 묶음의 잔액 확인(시험 리뷰 TR-11)', () => {
  test('J-T38 ⑨ 09시 묶음도 잔액을 견주어 1원 모자라면 그 상점 확정 정산서를 HELD·BALANCE·PAYOUT_HELD로 두고 묶음을 만들지 않는다', async () => {
    const x = await open({ now: kst('2026-12-04T09:00:00.000') });
    const a = randomUUID();
    await x.partner(a);
    const s1 = await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    const s2 = await x.confirmed({ promoterId: a, amount: 2_000_000, payoutDate: MON });
    x.fake.balances.STANDARD = { available: 2_999_999, pending: 0 };
    expect(await x.settlements.prepareTossBatches(MON)).toEqual({ prepared: 0 });
    expect(x.store.batches.size).toBe(0);
    expect([s1, s2].map((s) => [x.store.statements.get(s.statementId)?.status, x.store.statements.get(s.statementId)?.holdReason])).toEqual([
      ['HELD', 'BALANCE'],
      ['HELD', 'BALANCE'],
    ]);
    expect(x.events('PAYOUT_HELD').map((e) => [e.statementId, e.amount]).sort()).toEqual([
      [s1.statementId, 1_000_000],
      [s2.statementId, 2_000_000],
    ].sort());
  });

  test('J-T38 ⑨ 잔액 원천이 세 번(09:00·09:30·10:00) 답하지 않으면 셋째 실패에 PAYOUT_DELAYED(대상 TOSS:{상점}:{지급일}) 한 건이고 그때까지 묶음은 없다', async () => {
    const x = await open({ now: kst('2026-12-04T09:00:00.000') });
    const a = randomUUID();
    await x.partner(a);
    await x.confirmed({ promoterId: a, amount: 1_000_000, payoutDate: MON });
    x.fake.inject({ method: 'GET', path: /^\/v2\/balances$/, times: 3 }, 'NO_RESPONSE');
    const worker = new SettlementDueWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });
    await worker.tick(false);
    x.at(kst('2026-12-04T09:30:00.000'));
    await worker.tick(false);
    expect(x.cases('PAYOUT_DELAYED')).toEqual([]);
    x.at(kst('2026-12-04T10:00:00.000'));
    await worker.tick(false);
    expect(x.cases('PAYOUT_DELAYED')).toEqual([expect.objectContaining({ eventKey: `TOSS:STANDARD:${MON}`, sourceId: `TOSS:STANDARD:${MON}` })]);
    expect(x.store.batches.size).toBe(0);
    expect(x.fake.calls('GET', /^\/v2\/balances$/).filter((r) => r.fault === 'NO_RESPONSE')).toHaveLength(3);
  });
});

describe('J-T5 응답 없음·처리 중·마감·두 파드', () => {
  async function batchAt(now: number, statements = 1) {
    const x = await open({ now });
    const promoterId = randomUUID();
    await x.partner(promoterId);
    const ss = [];
    for (let i = 0; i < statements; i += 1) ss.push(await x.confirmed({ promoterId, amount: 1_000_000 + i, payoutDate: MON }));
    const batchId = await x.approvedBatch({ payoutDate: MON });
    return { x, batchId, ss };
  }

  test('J-T5 응답 없음이면 같은 키로 1·2·4·8·16·30·30분 간격(각 간격 1ms 전에는 보내지 않음)으로 다시 보내고, 접수되면 멈춘다 [ASVS v5.0.0-16.5.2]', async () => {
    const { x, batchId } = await batchAt(FRI_10);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, times: 8 }, 'NO_RESPONSE');
    await x.settlements.executeBatch(batchId);
    const key = posts(x)[0]!.headers['idempotency-key'];
    let next = FRI_10 + MIN;
    expect(x.store.batches.get(batchId)?.nextSubmitAt).toEqual(new Date(next));
    // 첫 시도 뒤 1분, 그 뒤 시도마다 2·4·8·16분, 30분 상한(32·64·128분 대신 30분)
    for (const gap of [2, 4, 8, 16, 30, 30, 30]) {
      const count = posts(x).length;
      x.at(next - 1);
      await x.settlements.submitDueBatches();
      expect([gap, posts(x).length]).toEqual([gap, count]);
      x.at(next);
      await x.settlements.submitDueBatches();
      expect([gap, posts(x).length]).toEqual([gap, count + 1]);
      next += gap * MIN;
      expect([gap, x.store.batches.get(batchId)?.nextSubmitAt]).toEqual([gap, new Date(next)]);
    }
    expect(posts(x)).toHaveLength(8);
    x.at(next);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(9);
    expect(new Set(posts(x).map((r) => r.headers['idempotency-key']))).toEqual(new Set([key]));
    expect(x.store.batches.get(batchId)).toMatchObject({ status: 'SUBMITTED', nextSubmitAt: null, submitAttempts: 9 });
    expect(x.fake.payouts.size).toBe(1);
  });

  test('J-T5 409 IDEMPOTENT_REQUEST_PROCESSING이면 기다렸다가 같은 키로 다시 보내고, 결제사에는 지급이 한 번만 생긴다', async () => {
    const { x, batchId } = await batchAt(FRI_10);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'PROCESSING');
    const view = await x.settlements.executeBatch(batchId);
    expect(view).toMatchObject({ status: 'APPROVED', lastSubmitError: 'PROCESSING', nextSubmitAt: iso(FRI_10 + MIN) });
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x).map((r) => r.headers['idempotency-key'])).toEqual([posts(x)[0]!.headers['idempotency-key'], posts(x)[0]!.headers['idempotency-key']]);
    expect(x.fake.payouts.size).toBe(1);
    expect(x.store.batches.get(batchId)?.status).toBe('SUBMITTED');
  });

  test('J-T5 응답을 잃은 뒤(결제사는 접수함) 같은 키로 다시 보내면 결제사가 처음 결과를 돌려주고 지급 건은 늘지 않는다', async () => {
    const { x, batchId, ss } = await batchAt(FRI_10);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'BAD_JWE');
    await x.settlements.executeBatch(batchId);
    expect(x.fake.payouts.size).toBe(1);
    x.at(FRI_10 + MIN);
    await x.settlements.submitDueBatches();
    expect(x.fake.payouts.size).toBe(1);
    expect(x.payoutsOf(ss[0]!.statementId)[0]?.pgPayoutId).toBe([...x.fake.payouts.values()][0]!.id);
  });

  test('J-T5 마감: 21:28:59.999에 시작한 묶음은 21:59:59.999에 같은 키로 보낸다', async () => {
    const start = kst('2026-12-04T21:28:59.999');
    const { x, batchId } = await batchAt(start);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, times: 5 }, 'NO_RESPONSE');
    await x.settlements.executeBatch(batchId);
    let next = start + MIN;
    for (const gap of [2, 4, 8, 16]) {
      x.at(next);
      await x.settlements.submitDueBatches();
      next += gap * MIN;
    }
    expect(next).toBe(kst('2026-12-04T21:59:59.999'));
    x.at(next);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(6);
    expect(x.store.batches.get(batchId)).toMatchObject({ status: 'SUBMITTED', payoutDate: MON });
  });

  test('J-T5 마감: 22:00:00.000이 된 묶음은 보내지 않고 지급일을 다음 은행 영업일로 미루며 PAYOUT_DELAYED·정산서마다 PAYOUT_HELD이고, 사람이 다시 실행하면 새 키로 나간다', async () => {
    const start = kst('2026-12-04T21:29:00.000');
    const { x, batchId, ss } = await batchAt(start, 2);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, times: 5 }, 'NO_RESPONSE');
    await x.settlements.executeBatch(batchId);
    let next = start + MIN;
    for (const gap of [2, 4, 8, 16]) {
      x.at(next);
      await x.settlements.submitDueBatches();
      next += gap * MIN;
    }
    expect(next).toBe(DEADLINE);
    const oldKey = posts(x)[0]!.headers['idempotency-key'];
    expect(posts(x)).toHaveLength(5);
    x.at(DEADLINE);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(5);
    expect(x.store.batches.get(batchId)).toMatchObject({ status: 'APPROVED', payoutDate: TUE, nextSubmitAt: null });
    expect(x.cases('PAYOUT_DELAYED')).toEqual([expect.objectContaining({ kind: 'PAYOUT_DELAYED', sourceId: batchId })]);
    expect(x.events('PAYOUT_HELD').map((e) => [e.statementId, e.amount]).sort()).toEqual(ss.map((s) => [s.statementId, s.payoutAmount]).sort());
    // E-01(ADR-0369 결정 14): 정산서는 상태 그대로(CONFIRMED·묶음에 붙음) 지급일만 바뀌고, 같은 상태의 감사 한 줄(payout-postponed·system)이 남는다
    for (const s of ss) expect(x.store.statements.get(s.statementId)).toMatchObject({ status: 'CONFIRMED', payoutBatchId: batchId, payoutDate: TUE });
    expect(x.store.statementAudits.filter((a) => a.reason === 'payout-postponed').map((a) => [a.statementId, a.fromStatus, a.toStatus, a.actor]).sort()).toEqual(ss.map((s) => [s.statementId, 'CONFIRMED', 'CONFIRMED', 'system']).sort());
    // 마감 뒤에는 자동으로 다시 보내지 않는다
    x.at(DEADLINE + 2 * 60 * MIN);
    await x.settlements.submitDueBatches();
    expect(posts(x)).toHaveLength(5);
    // operator가 처음 요청이 들어가지 않았음을 확인하고 다시 실행하면 바뀐 지급일·새 키다
    const view = await x.settlements.executeBatch(batchId);
    expect(view.status).toBe('SUBMITTED');
    const last = posts(x)[5]!;
    expect((last.body as { payoutDate: string }[]).map((i) => i.payoutDate)).toEqual([TUE, TUE]);
    expect(last.headers['idempotency-key']).not.toBe(oldKey);
    expect(x.cases('PAYOUT_DELAYED')).toHaveLength(1);
  });

  for (const cause of ['BALANCE_SHORT', 'PROCESSING'] as const) {
    test(`J-T5 마감: ${cause === 'BALANCE_SHORT' ? '요청 직전 잔액 부족' : '409 처리 중'}이 22:00까지 이어져도 22:00 점검에서 보내지 않고 지급일을 미루며 PAYOUT_DELAYED(대상 묶음)·정산서마다 PAYOUT_HELD이고 그 뒤 자동 전송 0이다(시험 리뷰 TR-12)`, async () => {
      const start = kst('2026-12-04T21:29:00.000');
      const { x, batchId, ss } = await batchAt(start, 2);
      if (cause === 'BALANCE_SHORT') x.fake.balances.STANDARD = { available: 2_000_000, pending: 0 };
      else x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/, times: 5 }, 'PROCESSING');
      await x.settlements.executeBatch(batchId);
      let next = start + MIN;
      for (const gap of [2, 4, 8, 16]) {
        x.at(next);
        await x.settlements.submitDueBatches();
        next += gap * MIN;
      }
      expect(next).toBe(DEADLINE);
      const sentBefore = posts(x).length;
      expect(sentBefore).toBe(cause === 'BALANCE_SHORT' ? 0 : 5);
      x.at(DEADLINE);
      await x.settlements.submitDueBatches();
      expect(posts(x)).toHaveLength(sentBefore);
      expect(x.store.batches.get(batchId)).toMatchObject({ status: 'APPROVED', payoutDate: TUE, nextSubmitAt: null });
      const deadlineCases = x.cases('PAYOUT_DELAYED').filter((c) => c.eventKey !== `payout-balance:${batchId}`);
      expect(deadlineCases).toEqual([expect.objectContaining({ kind: 'PAYOUT_DELAYED', sourceId: batchId })]);
      expect(x.events('PAYOUT_HELD').map((e) => [e.statementId, e.amount]).sort()).toEqual(ss.map((s) => [s.statementId, s.payoutAmount]).sort());
      x.fake.balances.STANDARD = { available: 900_000_000_000, pending: 0 };
      x.at(DEADLINE + 2 * 60 * MIN);
      await x.settlements.submitDueBatches();
      expect(posts(x)).toHaveLength(sentBefore);
    });
  }

  test('J-T5 두 파드가 같은 묶음을 함께 다시 보내도 전송은 한 번이다(묶음 잡기)', async () => {
    const { x, batchId } = await batchAt(FRI_10);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'NO_RESPONSE');
    await x.settlements.executeBatch(batchId);
    const other = x.make();
    x.at(FRI_10 + MIN);
    await Promise.all([x.settlements.submitDueBatches(), other.submitDueBatches()]);
    expect(posts(x)).toHaveLength(2);
    expect(x.store.batches.get(batchId)?.status).toBe('SUBMITTED');
  });

  test('J-T5 전송 일꾼: 리더만 돌고, 리더라고 믿는 두 일꾼이 겹쳐도 전송은 한 번이다', async () => {
    const { x, batchId } = await batchAt(FRI_10);
    x.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'NO_RESPONSE');
    await x.settlements.executeBatch(batchId);
    x.at(FRI_10 + MIN);
    const follower = new PayoutSubmitWorker({ settlements: x.settlements, leader: { isLeader: () => false }, clock: x.clock, timer: noTimer });
    await follower.tick();
    expect(posts(x)).toHaveLength(1);
    const a = new PayoutSubmitWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });
    const b = new PayoutSubmitWorker({ settlements: x.make(), leader: { isLeader: () => true }, clock: x.clock, timer: noTimer });
    await Promise.all([a.tick(), b.tick()]);
    expect(posts(x)).toHaveLength(2);
  });
});

describe('J-T5 전송 일꾼의 타이머(시험 리뷰 TR-05 (다))', () => {
  test('J-T5 전송 일꾼 start()는 60,000ms 간격을 걸고 stop()은 그 손잡이를 푼다', async () => {
    const x = await open();
    const intervals: number[] = [];
    const cleared: unknown[] = [];
    const handle = { name: 'submit-timer' };
    const timer = {
      setInterval: (_fn: () => void, ms: number) => {
        intervals.push(ms);
        return handle;
      },
      clearInterval: (hd: unknown) => void cleared.push(hd),
    };
    const worker = new PayoutSubmitWorker({ settlements: x.settlements, leader: { isLeader: () => true }, clock: x.clock, timer });
    worker.start();
    expect(intervals).toEqual([60_000]);
    await worker.stop();
    expect(cleared).toEqual([handle]);
  });
});

// 시험 자료 짝 확인: seedTossSeller가 메모리 저장소의 검사용 칸(tossSellers)에 '{파트너}:{상점}' 키로 들어간다(시험들이 이 키로 읽는다)
test('J-T37 ④ 시험 자료: toss_seller 행은 파트너·상점 키 하나다', async () => {
  const x = await open({ noBalance: true });
  const promoterId = randomUUID();
  await seedTossSeller(x.store, promoterId, { pgStore: 'ESCROW', status: 'APPROVED' });
  expect([...x.store.tossSellers.keys()]).toEqual([`${promoterId}:ESCROW`]);
  expect(await x.store.findTossSeller(promoterId, 'ESCROW')).toMatchObject({ promoterId, pgStore: 'ESCROW', status: 'APPROVED' });
});
