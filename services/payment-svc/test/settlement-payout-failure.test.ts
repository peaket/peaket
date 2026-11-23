// J-T15 ①②③·J-T7 지급 건 FAILED의 세 갈래와 재요청(F-07-6 LCH-110, settlement §5.2 '다시 요청할 때'·§12 세 갈래 표, ADR-0369 결정 8·9).
// 진짜 Settlements·전송 어댑터·메모리 저장소를 시험 안 대역 서버에 붙인다. 시각: 지급일 2026-12-04(금)분을 12-03(목)에 실행하고 12-04(금) 15:00 KST에 실패를 받는다.
// 점검(일시) 갈래의 자동 재요청 지급일은 '내일 09시 뒤 첫 은행 영업일' = 2026-12-07(월)이다. 같은 지급 건 줄기의 자동 재요청은 2번까지, 셋째 실패는 사람이다.
// 새 순번은 '그 정산서의 가장 큰 순번 + 1'이다(같은 묶음의 다른 정산서 순번과 무관, 9 → 10처럼 두 자리를 넣어 글자 비교 결함을 잡는다).
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { ManualPortonePayoutGateway, MemoryReauthVerifier, SettlementModule, TossPayoutGateway, tossIdempotencyKey, type PayoutRecord } from '../src/modules/settlement/index.js';
import { quiet } from './settlement-flow-support.js';
import { noSaleSuspensions } from './settlement-support.js';
import { kst, tossHarness, type TossHarness } from './support/toss-harness.js';
import { refsOf } from './support/toss-payout-fake.js';

const THU = kst('2026-12-03T10:00:00.000');
const FAIL_AT = kst('2026-12-04T15:00:00.000');
const FRI = '2026-12-04';
const MON = '2026-12-07';

let h: TossHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** 금액마다 정산서 하나씩을 한 묶음으로 실행까지 마친다 */
async function executed(amounts: readonly number[]) {
  const x = (h = await tossHarness({ now: THU }));
  const promoterId = randomUUID();
  const sellers = await x.partner(promoterId);
  const ss = [];
  for (const amount of amounts) ss.push(await x.confirmed({ promoterId, amount, payoutDate: FRI }));
  const batchId = await x.approvedBatch({ payoutDate: FRI });
  await x.settlements.executeBatch(batchId);
  x.at(FAIL_AT);
  const fact = (p: PayoutRecord, status: 'COMPLETED' | 'FAILED', errorCode?: string) =>
    x.settlements.applyPayoutFact({ pgPayoutId: p.pgPayoutId!, status, ...(errorCode ? { errorCode } : {}), observedAt: new Date(x.clock.now()) });
  return { x, promoterId, sellers, ss, batchId, fact };
}

describe('J-T15 ① 계좌 문제', () => {
  test('J-T15 ① 계좌 해지면 정산서 FAILED·PAYOUT_FAILED·CS PAYOUT_FAILED(대상 = 지급 건)이고 자동 재요청이 없다', async () => {
    const { x, ss, batchId, fact } = await executed([3_000_000]);
    const [p] = x.payoutsOf(ss[0]!.statementId);
    await fact(p!, 'FAILED', 'ACCOUNT_CLOSED');
    expect(x.store.statements.get(ss[0]!.statementId)?.status).toBe('FAILED');
    expect(x.store.payouts.get(p!.payoutId)).toMatchObject({ status: 'FAILED', failureClass: 'ACCOUNT', errorCode: 'ACCOUNT_CLOSED' });
    expect(x.events('PAYOUT_FAILED')).toEqual([expect.objectContaining({ statementId: ss[0]!.statementId, amount: 3_000_000 })]);
    expect(x.cases('PAYOUT_FAILED')).toEqual([expect.objectContaining({ kind: 'PAYOUT_FAILED', sourceId: p!.payoutId })]);
    expect(x.payoutsOf(ss[0]!.statementId)).toHaveLength(1);
    expect(x.store.retryAudits).toEqual([]);
    expect(x.store.batches.get(batchId)?.nextSubmitAt).toBeNull();
  });

  test('J-T15 ① 표에 없는 실패 코드(모름)도 사람이 보는 PAYOUT_FAILED이고 자동 재요청이 없다', async () => {
    const { x, ss, fact } = await executed([1_000_000]);
    const [p] = x.payoutsOf(ss[0]!.statementId);
    await fact(p!, 'FAILED', 'SOMETHING_NEW');
    expect(x.store.payouts.get(p!.payoutId)?.failureClass).toBe('UNKNOWN');
    expect(x.cases('PAYOUT_FAILED').map((c) => c.sourceId)).toEqual([p!.payoutId]);
    expect(x.payoutsOf(ss[0]!.statementId)).toHaveLength(1);
  });
});

describe('J-T15 ② 점검·일시 오류', () => {
  test('J-T15 ② 새 순번은 그 정산서의 가장 큰 순번 + 1이고(순번 3 실패 → 11, 순번 9 실패 → 10), 지급일은 다음 은행 영업일·감사 옛/새 순번·system이다 [ASVS v5.0.0-2.3.4]', async () => {
    // 95억 원 → 10조각(순번 1~10), 85억 원 → 9조각(순번 1~9), 한 묶음 19건
    const { x, ss, batchId, fact } = await executed([9_500_000_000, 8_500_000_000]);
    const a = x.payoutsOf(ss[0]!.statementId);
    const b = x.payoutsOf(ss[1]!.statementId);
    expect([a.map((p) => p.seq), b.map((p) => p.seq)]).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ]);
    await fact(a[2]!, 'FAILED', 'BANK_MAINTENANCE');
    await fact(b[8]!, 'FAILED', 'TEMPORARY_ERROR');
    const ra = x.payoutsOf(ss[0]!.statementId).at(-1)!;
    const rb = x.payoutsOf(ss[1]!.statementId).at(-1)!;
    expect(ra).toMatchObject({ seq: 11, refPayoutId: `${ss[0]!.statementId}-11`, amount: 999_999_999, payoutDate: MON, status: 'REQUESTED', pgPayoutId: null, retryOfPayoutId: a[2]!.payoutId, autoRetryCount: 1, batchId });
    expect(rb).toMatchObject({ seq: 10, refPayoutId: `${ss[1]!.statementId}-10`, amount: 500_000_008, payoutDate: MON, status: 'REQUESTED', retryOfPayoutId: b[8]!.payoutId, autoRetryCount: 1 });
    expect(x.store.retryAudits.map((r) => [r.payoutId, r.newPayoutId, r.oldSeq, r.newSeq, r.actor, r.reason])).toEqual([
      [a[2]!.payoutId, ra.payoutId, 3, 11, 'system', 'TRANSIENT'],
      [b[8]!.payoutId, rb.payoutId, 9, 10, 'system', 'TRANSIENT'],
    ]);
    expect(x.cases('PAYOUT_FAILED')).toEqual([]);
    // 재요청의 자동 전송 마감은 새 지급일(월)의 전 영업일(금) 22:00 KST다(처음 지급일 기준 마감 목 22:00은 이미 지났다)
    expect(x.store.batches.get(batchId)).toMatchObject({ nextSubmitAt: new Date(FAIL_AT), submitDeadlineAt: new Date(kst('2026-12-04T22:00:00.000')) });
    // 전송 일꾼이 새 순번만 다음 은행 영업일로 보낸다(새 키), 접수되면 T13 FAILED → SCHEDULED·PAYOUT_SCHEDULED
    const before = x.payoutPosts().length;
    await x.settlements.submitDueBatches();
    const sent = x.payoutPosts().slice(before);
    // 같은 묶음·같은 지급일의 새 순번 둘은 요청 하나(20건 이하)이고, 키는 새 refPayoutId 목록과 새 지급일로 정한다
    expect(sent).toHaveLength(1);
    expect(refsOf(sent[0]!).sort()).toEqual([ra.refPayoutId, rb.refPayoutId].sort());
    expect((sent[0]!.body as { payoutDate: string }[]).map((i) => i.payoutDate)).toEqual([MON, MON]);
    expect(sent[0]!.headers['idempotency-key']).toBe(tossIdempotencyKey([x.store.payouts.get(ra.payoutId)!, x.store.payouts.get(rb.payoutId)!], MON));
    expect(sent[0]!.headers['idempotency-key']).not.toBe(x.payoutPosts()[0]!.headers['idempotency-key']);
    expect(x.store.statements.get(ss[0]!.statementId)?.status).toBe('SCHEDULED');
    expect(x.events('PAYOUT_SCHEDULED').filter((e) => e.statementId === ss[0]!.statementId)).toHaveLength(2);
    // 대신된 옛 순번(3)은 빼고 살아 있는 지급 건이 모두 끝나면 PAID·PAYOUT_COMPLETED(금액 = 정산서 지급액)
    for (const p of a.filter((q) => q.seq !== 3)) await fact(p, 'COMPLETED');
    expect(x.store.statements.get(ss[0]!.statementId)?.status).toBe('SCHEDULED');
    await fact(x.store.payouts.get(ra.payoutId)!, 'COMPLETED');
    expect(x.store.statements.get(ss[0]!.statementId)?.status).toBe('PAID');
    expect(x.events('PAYOUT_COMPLETED')).toEqual([expect.objectContaining({ statementId: ss[0]!.statementId, amount: 9_500_000_000 })]);
  });

  test('J-T15 ② 같은 줄기의 자동 재요청은 2번까지이고 셋째 실패는 CS PAYOUT_FAILED로 사람에게 간다', async () => {
    const { x, ss, fact } = await executed([2_000_000]);
    const sid = ss[0]!.statementId;
    await fact(x.payoutsOf(sid)[0]!, 'FAILED', 'BANK_MAINTENANCE');
    await x.settlements.submitDueBatches();
    const second = x.payoutsOf(sid)[1]!;
    expect([second.seq, second.autoRetryCount, second.pgPayoutId === null]).toEqual([2, 1, false]);
    await fact(second, 'FAILED', 'BANK_MAINTENANCE');
    await x.settlements.submitDueBatches();
    const third = x.payoutsOf(sid)[2]!;
    expect([third.seq, third.autoRetryCount, third.retryOfPayoutId]).toEqual([3, 2, second.payoutId]);
    expect(x.cases('PAYOUT_FAILED')).toEqual([]);
    await fact(third, 'FAILED', 'BANK_MAINTENANCE');
    expect(x.payoutsOf(sid)).toHaveLength(3);
    expect(x.cases('PAYOUT_FAILED')).toEqual([expect.objectContaining({ sourceId: third.payoutId })]);
    expect(x.store.statements.get(sid)?.status).toBe('FAILED');
    expect(x.store.retryAudits.map((r) => [r.oldSeq, r.newSeq])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });
});

describe('J-T15 ③ 한도·KYC와 사람의 재요청', () => {
  test('J-T15 ③·J-T7 KYC_REQUIRED 실패면 재요청 없이 CS SELLER_KYC_REQUIRED(대상 = 그 상점 토스 셀러)이고, 셀러 APPROVED 확인 뒤 새 순번으로 한 번 다시 보낸다', async () => {
    const { x, ss, sellers, batchId, fact } = await executed([4_000_000]);
    const sid = ss[0]!.statementId;
    const [p] = x.payoutsOf(sid);
    await fact(p!, 'FAILED', 'KYC_REQUIRED');
    expect(x.store.payouts.get(p!.payoutId)).toMatchObject({ status: 'FAILED', failureClass: 'LIMIT_KYC' });
    expect(x.payoutsOf(sid)).toHaveLength(1);
    expect(x.cases('SELLER_KYC_REQUIRED')).toEqual([expect.objectContaining({ sourceId: sellers.STANDARD })]);
    x.clock.advance(60_000);
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellers.STANDARD!, status: 'APPROVED', checkedAt: new Date(x.clock.now()) });
    const retried = x.payoutsOf(sid);
    expect(retried.map((q) => [q.seq, q.status])).toEqual([
      [1, 'FAILED'],
      [2, 'REQUESTED'],
    ]);
    expect(retried[1]).toMatchObject({ amount: 4_000_000, retryOfPayoutId: p!.payoutId });
    expect(x.store.retryAudits.map((r) => [r.oldSeq, r.newSeq, r.actor, r.reason])).toEqual([[1, 2, 'system', 'LIMIT_KYC']]);
    expect(x.store.batches.get(batchId)?.nextSubmitAt).toEqual(new Date(x.clock.now()));
    // 다시 APPROVED가 와도 한 번뿐이다
    x.clock.advance(60_000);
    await x.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellers.STANDARD!, status: 'APPROVED', checkedAt: new Date(x.clock.now()) });
    expect(x.payoutsOf(sid)).toHaveLength(2);
  });

  test('J-T15 ③ KYC_REQUIRED 실패 뒤에는 그 셀러(같은 파트너·같은 상점)의 다른 토스 정산서가 다음 묶음에서 HELD·KYC·PAYOUT_HELD이고, 다른 상점·포트원 정산서는 묶인다(시험 리뷰 TR-02)', async () => {
    const { x, promoterId, ss, sellers, fact } = await executed([4_000_000]);
    // 결제사 쪽 그 셀러는 KYC_REQUIRED다(셀러 상태는 단건 조회로 알게 된다, 어떻게 알게 되는지는 구현이 정한다)
    x.fake.sellers.set(sellers.STANDARD!, { id: sellers.STANDARD!, store: 'STANDARD', refSellerId: `${promoterId}-STANDARD`, businessType: 'CORPORATE', status: 'KYC_REQUIRED' });
    await fact(x.payoutsOf(ss[0]!.statementId)[0]!, 'FAILED', 'KYC_REQUIRED');
    const same = await x.confirmed({ promoterId, amount: 1_500_000, payoutDate: MON });
    const escrow = await x.confirmed({ promoterId, amount: 600_000, payoutDate: MON, pgStore: 'ESCROW' });
    const portone = await x.confirmed({ promoterId, amount: 700_000, payoutDate: MON, pg: 'PORTONE' });
    await expect(x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: MON, actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-kyc-required') });
    expect(x.store.statements.get(same.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC', payoutBatchId: null });
    expect(x.events('PAYOUT_HELD').map((e) => [e.statementId, e.amount])).toEqual([[same.statementId, 1_500_000]]);
    const e = await x.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'ESCROW', payoutDate: MON, actor: randomUUID() });
    expect([e.statementCount, x.store.statements.get(escrow.statementId)?.payoutBatchId]).toEqual([1, e.batchId]);
    const po = await x.settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: MON, portoneBalance: { amount: 10_000_000, observedAt: new Date(x.clock.now()).toISOString() }, actor: randomUUID() });
    expect([po.statementCount, x.store.statements.get(portone.statementId)?.payoutBatchId]).toEqual([1, po.batchId]);
  });

  test('J-T15 ③ 같은 금액 사람 재요청은 새 2인 승인 없이 새 순번·감사(행위자 = 계정)이고, 금액·상점을 바꾸면 409 payout-retry-approval-required·지급 건 0이다', async () => {
    const { x, ss, fact } = await executed([5_000_000]);
    const sid = ss[0]!.statementId;
    const [p] = x.payoutsOf(sid);
    await fact(p!, 'FAILED', 'ACCOUNT_CLOSED');
    const actorId = randomUUID();
    for (const input of [{ actorId, amount: 4_999_999 }, { actorId, amount: 5_000_001 }, { actorId, pgStore: 'ESCROW' as const }]) {
      await expect(x.settlements.retryPayout(p!.payoutId, input), JSON.stringify(input)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-retry-approval-required') });
    }
    expect(x.payoutsOf(sid)).toHaveLength(1);
    expect(x.store.retryAudits).toEqual([]);
    const next = await x.settlements.retryPayout(p!.payoutId, { actorId, amount: 5_000_000, pgStore: 'STANDARD' });
    expect(next).toMatchObject({ seq: 2, amount: 5_000_000, refPayoutId: `${sid}-2`, status: 'REQUESTED', retryOfPayoutId: p!.payoutId });
    expect(x.store.retryAudits.map((r) => [r.payoutId, r.newPayoutId, r.oldSeq, r.newSeq, r.actor, r.reason])).toEqual([[p!.payoutId, next.payoutId, 1, 2, actorId, 'ACCOUNT']]);
    // 실패가 아닌 지급 건(방금 만든 REQUESTED)은 다시 보낼 수 없다
    await expect(x.settlements.retryPayout(next.payoutId, { actorId })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-not-retryable') });
  });

  test('J-T15 ③ 정산 계좌 변경 보류 중(hold_until > 지금)이면 409 payout-account-change-hold, 예금주 미확인이면 409 payout-account-mismatch이고 보류가 끝난 시각부터 받는다', async () => {
    const { x, promoterId, ss, fact } = await executed([1_200_000]);
    const [p] = x.payoutsOf(ss[0]!.statementId);
    await fact(p!, 'FAILED', 'ACCOUNT_CLOSED');
    const account = (await x.store.findPayoutAccount(promoterId))!;
    const actorId = randomUUID();
    await x.store.savePayoutAccount({ ...account, holdUntil: new Date(x.clock.now() + 1) });
    await expect(x.settlements.retryPayout(p!.payoutId, { actorId })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-change-hold') });
    await x.store.savePayoutAccount({ ...account, holdUntil: new Date(x.clock.now() - 1), holderVerified: false });
    await expect(x.settlements.retryPayout(p!.payoutId, { actorId })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-mismatch') });
    expect(x.payoutsOf(ss[0]!.statementId)).toHaveLength(1);
    await x.store.savePayoutAccount({ ...account, holdUntil: new Date(x.clock.now()), holderVerified: true });
    expect((await x.settlements.retryPayout(p!.payoutId, { actorId })).seq).toBe(2);
  });

  test('J-T15 ③ 내부 경로 POST /internal/v1/settlements/payouts/{payoutId}/retries가 행위자를 받고 금액을 바꾸면 409다', async () => {
    const { x, ss, fact } = await executed([800_000]);
    const [p] = x.payoutsOf(ss[0]!.statementId);
    await fact(p!, 'FAILED', 'ACCOUNT_CLOSED');
    const svc = await createService({
      name: 'payment-svc',
      module: SettlementModule.register({ store: x.store, payments: x.payments, approvals: x.approvals, saleSuspensions: noSaleSuspensions, gateways: [new ManualPortonePayoutGateway(), new TossPayoutGateway(x.transport)], reauth: new MemoryReauthVerifier(), tossTransport: x.transport }),
      env: { PEAKET_ENV: 'ci' },
      clock: x.clock,
      logDestination: quiet(),
    });
    try {
      const post = (body: unknown) => svc.http.inject({ method: 'POST', url: `/internal/v1/settlements/payouts/${p!.payoutId}/retries`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      const actorId = randomUUID();
      const changed = await post({ actorId, amount: 799_999 });
      expect([changed.statusCode, JSON.parse(changed.payload).type]).toEqual([409, expect.stringContaining('payout-retry-approval-required')]);
      const ok = await post({ actorId });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.payload)).toMatchObject({ seq: 2, amount: 800_000 });
      expect(x.store.retryAudits.map((r) => r.actor)).toEqual([actorId]);
    } finally {
      await svc.close();
    }
  });
});
