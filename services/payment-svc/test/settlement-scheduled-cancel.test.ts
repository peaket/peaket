// 이미 만든 토스 예약지급(REQUESTED) 취소 시험(J-T40 ⑤⑥, settlement §5.2·§6·§12, docs/planning/03 §2.12 T10, ADR-0370 결정 6, F-07-7 계획 §5.1(라) 예약 취소).
// 부르는 곳 둘: 정산 계좌 변경(보류 기간 안에 지급일이 오는 두 상점의 예약지급, 사유 ACCOUNT_CHANGE)과
// F-07-6 applyTossSellerFact의 KYC_REQUIRED(그 상점의 예약지급, 사유 KYC). 토스 전송은 F-07-6 포트의 짝 대역이다.
// 경계: 보류 끝 날짜(수요일)의 지급일은 취소하고 그다음 날(목요일)은 그대로, 조각 하나라도 IN_PROGRESS면 취소 0번.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { PayoutStatus, PgStore, StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import { OpsIntakeFake } from './support/ops-intake-fake.js';
import { PortonePlatformFake } from './support/portone-platform-fake.js';
import { batch, harness, kyc, payout, PORTONE_SECRET, portonePartner, statement, tossSeller, type Harness } from './support/settlement-portone-harness.js';

/** 금요일 10:00 KST. 3영업일 보류 끝 = 다음 주 수요일 2026-12-02 10:00 KST */
const FRIDAY_10_KST = Date.parse('2026-11-27T01:00:00.000Z');
const HOLD_END_DATE = '2026-12-02';
const LEGAL = '주식회사 피켓엔터';

const fake = new PortonePlatformFake(PORTONE_SECRET);
const ops = new OpsIntakeFake();
beforeAll(async () => {
  await fake.start();
  await ops.start();
});
afterAll(async () => {
  await fake.close();
  await ops.close();
});

let h: Harness;
let P: string;
beforeEach(() => {
  fake.reset();
  ops.reset();
  h = harness({ now: FRIDAY_10_KST, portone: fake, toss: true, ops });
  P = randomUUID();
  const at = new Date(FRIDAY_10_KST - 30 * 86_400_000);
  h.store.kycs.set(P, kyc(P, at, { legalName: LEGAL }));
  h.store.accounts.set(P, { promoterId: P, bankCode: '06', accountLast4: '1234', version: 3, changedAt: at, holdUntil: at, holderVerified: true, agencySyncPending: false });
  const partnerId = portonePartner(h.store, P, at);
  fake.partners.set(partnerId, { id: partnerId, name: LEGAL, account: { bank: 'KOOKMIN', number: '06400000001234', holder: LEGAL }, defaultContractId: 'c', scheduled: null });
  tossSeller(h.store, P, 'STANDARD', 'PARTIALLY_APPROVED', at);
  tossSeller(h.store, P, 'ESCROW', 'PARTIALLY_APPROVED', at);
  fake.holder('SHINHAN', '11012345678901', LEGAL);
});

/** 토스 SCHEDULED 정산서 하나와 그 묶음·지급 건(조각마다 상태) */
async function scheduled(pgStore: PgStore, payoutDate: string, pieces: readonly { amount: number; status: PayoutStatus }[], pg: 'TOSS' | 'PORTONE' = 'TOSS'): Promise<{ s: StatementRecord; payoutIds: string[]; pgPayoutIds: string[] }> {
  const at = new Date(FRIDAY_10_KST - 3 * 86_400_000);
  const total = pieces.reduce((n, p) => n + p.amount, 0);
  const b = batch({ pg, pgStore, payoutDate, totalAmount: total, statementCount: 1, at });
  await h.store.insertPayoutBatch(b);
  const s = statement({ promoterId: P, pg, pgStore, payoutDate, status: 'SCHEDULED', payoutBatchId: b.batchId, payoutAmount: total, grossAmount: total + 1_000_000, commissionAmount: 909_091, commissionVat: 90_909, at });
  await h.store.saveStatement(s);
  const rows = pieces.map((p, i) => payout({ batchId: b.batchId, statementId: s.statementId, seq: i + 1, amount: p.amount, status: p.status, pgPayoutId: `tp-${s.statementId.slice(0, 8)}-${i + 1}`, payoutDate, at }));
  await h.store.insertPayouts(rows);
  return { s, payoutIds: rows.map((r) => r.payoutId), pgPayoutIds: rows.map((r) => r.pgPayoutId!) };
}

const statusOf = (payoutId: string) => h.store.payouts.get(payoutId)?.status;
const heldEvents = (statementId: string) => h.store.outbox.filter((e) => e.value.statementId === statementId && e.value.type === 'PAYOUT_HELD');
const changeAccount = () => h.settlements.putPayoutAccount(P, 'sid', { bankCode: '88', accountNumber: '11012345678901', holderName: LEGAL }, '"3"', 'test-reauth');

describe('J-T40 ⑤ 정산 계좌 변경의 예약지급 취소', () => {
  test('J-T40 ⑤ 보류 끝 날짜가 지급일인 두 상점의 REQUESTED 예약지급은 취소·CANCELED·HELD ACCOUNT_CHANGE·PAYOUT_HELD 한 건이고, 그다음 날 지급일은 그대로다', async () => {
    const onEnd = await scheduled('STANDARD', HOLD_END_DATE, [
      { amount: 600_000_007, status: 'REQUESTED' },
      { amount: 400_000_003, status: 'REQUESTED' },
    ]);
    const escrow = await scheduled('ESCROW', '2026-11-30', [{ amount: 3_210_000, status: 'REQUESTED' }]);
    const after = await scheduled('STANDARD', '2026-12-03', [{ amount: 5_550_000, status: 'REQUESTED' }]);
    const saved = await changeAccount();
    expect(saved.holdUntil).toBe('2026-12-02T01:00:00.000Z');
    // 취소 요청은 취소 대상 조각마다 한 번, 그 상점 전송으로
    expect(h.toss!.callsOf('cancelPayout').map((c) => [c.pgStore, (c as { pgPayoutId: string }).pgPayoutId]).sort()).toEqual(
      [
        ['ESCROW', escrow.pgPayoutIds[0]],
        ['STANDARD', onEnd.pgPayoutIds[0]],
        ['STANDARD', onEnd.pgPayoutIds[1]],
      ].sort(),
    );
    for (const id of [...onEnd.payoutIds, ...escrow.payoutIds]) expect(statusOf(id)).toBe('CANCELED');
    for (const x of [onEnd, escrow]) {
      expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_CHANGE' });
      expect(heldEvents(x.s.statementId).map((e) => e.value.amount)).toEqual([x.s.payoutAmount]);
      expect(h.store.statementAudits.filter((a) => a.statementId === x.s.statementId)).toEqual([
        expect.objectContaining({ fromStatus: 'SCHEDULED', toStatus: 'HELD', reason: 'scheduled-payout-cancelled:ACCOUNT_CHANGE', actor: 'system' }),
      ]);
    }
    // 보류 끝 다음 날(목요일)이 지급일인 예약지급은 그대로
    expect(statusOf(after.payoutIds[0]!)).toBe('REQUESTED');
    expect(h.store.statements.get(after.s.statementId)).toMatchObject({ status: 'SCHEDULED', holdReason: null });
    expect(heldEvents(after.s.statementId)).toEqual([]);
  });

  test('J-T40 ⑤ 조각 하나가 IN_PROGRESS인 정산서는 취소 요청 0번이고 지급 건·정산서가 그대로이며 waiting으로 센다', async () => {
    const mixed = await scheduled('STANDARD', '2026-12-01', [
      { amount: 700_000_000, status: 'IN_PROGRESS' },
      { amount: 1_000_000, status: 'REQUESTED' },
    ]);
    const done = await scheduled('ESCROW', '2026-12-01', [
      { amount: 2_000_000, status: 'COMPLETED' },
      { amount: 3_000_000, status: 'REQUESTED' },
    ]);
    await expect(h.settlements.cancelScheduledTossPayouts({ promoterId: P, reason: 'ACCOUNT_CHANGE', payoutDateThrough: HOLD_END_DATE })).resolves.toEqual({ cancelled: 0, waiting: 2 });
    expect(h.toss!.callsOf('cancelPayout')).toEqual([]);
    expect([...mixed.payoutIds, ...done.payoutIds].map(statusOf)).toEqual(['IN_PROGRESS', 'REQUESTED', 'COMPLETED', 'REQUESTED']);
    for (const x of [mixed, done]) expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'SCHEDULED' });
    expect(h.store.outbox.filter((e) => e.value.type === 'PAYOUT_HELD')).toEqual([]);
  });

  test('J-T40 ⑤ 포트원 SCHEDULED 정산서는 토스 취소 대상이 아니다(포트원은 09시 실행 건에서 뺀다)', async () => {
    const portone = await scheduled('STANDARD', '2026-12-01', [{ amount: 4_440_000, status: 'REQUESTED' }], 'PORTONE');
    await changeAccount();
    expect(h.toss!.callsOf('cancelPayout')).toEqual([]);
    expect(statusOf(portone.payoutIds[0]!)).toBe('REQUESTED');
    expect(h.store.statements.get(portone.s.statementId)).toMatchObject({ status: 'SCHEDULED' });
  });

  test('J-T40 ⑤ 두 조각 가운데 첫 취소가 실패하면 성공한 조각만 CANCELED이고 정산서는 SCHEDULED 그대로, CS PAYOUT_ERROR 한 건(사건 키 payout-cancel:{정산서 ID})', async () => {
    const two = await scheduled('STANDARD', '2026-12-01', [
      { amount: 900_000_000, status: 'REQUESTED' },
      { amount: 123_456, status: 'REQUESTED' },
    ]);
    h.toss!.fail('cancelPayout', 'STANDARD', 1);
    const out = await h.settlements.cancelScheduledTossPayouts({ promoterId: P, pgStore: 'STANDARD', reason: 'ACCOUNT_CHANGE', payoutDateThrough: HOLD_END_DATE });
    expect(out.cancelled).toBe(0);
    expect(h.toss!.callsOf('cancelPayout')).toHaveLength(2);
    expect(two.payoutIds.map(statusOf).sort()).toEqual(['CANCELED', 'REQUESTED']);
    expect(h.store.statements.get(two.s.statementId)).toMatchObject({ status: 'SCHEDULED', holdReason: null });
    expect(heldEvents(two.s.statementId)).toEqual([]);
    expect([...h.store.caseRequests.values()].filter((c) => c.eventKey === `payout-cancel:${two.s.statementId}`)).toEqual([expect.objectContaining({ kind: 'PAYOUT_ERROR', sourceId: two.s.statementId })]);
  });

  test('J-T40 ⑤ 취소 응답이 모두 실패하면 지급 건·정산서가 그대로다(사건 0)', async () => {
    const one = await scheduled('STANDARD', '2026-12-01', [{ amount: 7_000_000, status: 'REQUESTED' }]);
    h.toss!.fail('cancelPayout', 'STANDARD');
    await h.settlements.cancelScheduledTossPayouts({ promoterId: P, reason: 'ACCOUNT_CHANGE', payoutDateThrough: HOLD_END_DATE });
    expect(statusOf(one.payoutIds[0]!)).toBe('REQUESTED');
    expect(h.store.statements.get(one.s.statementId)).toMatchObject({ status: 'SCHEDULED' });
    expect(h.store.outbox.filter((e) => e.value.type === 'PAYOUT_HELD')).toEqual([]);
  });

  test('J-T40 ⑤ 다른 파트너의 예약지급은 건드리지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const mine = await scheduled('STANDARD', '2026-12-01', [{ amount: 1_100_000, status: 'REQUESTED' }]);
    const other = randomUUID();
    const at = new Date(FRIDAY_10_KST - 86_400_000);
    const b = batch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-12-01', totalAmount: 2_200_000, statementCount: 1, at });
    await h.store.insertPayoutBatch(b);
    const os = statement({ promoterId: other, pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-12-01', status: 'SCHEDULED', payoutBatchId: b.batchId, payoutAmount: 2_200_000, at });
    await h.store.saveStatement(os);
    const op = payout({ batchId: b.batchId, statementId: os.statementId, amount: 2_200_000, pgPayoutId: 'tp-other', payoutDate: '2026-12-01', at });
    await h.store.insertPayouts([op]);
    await changeAccount();
    expect(statusOf(mine.payoutIds[0]!)).toBe('CANCELED');
    expect(statusOf(op.payoutId)).toBe('REQUESTED');
    expect(h.store.statements.get(os.statementId)?.status).toBe('SCHEDULED');
    expect(h.toss!.callsOf('cancelPayout').map((c) => (c as { pgPayoutId: string }).pgPayoutId)).toEqual([mine.pgPayoutIds[0]]);
  });
});

describe('J-T40 ⑥ KYC_REQUIRED의 예약지급 취소', () => {
  test('J-T40 ⑥ 일반 상점 셀러가 KYC_REQUIRED로 조회되면 그 상점의 REQUESTED 예약지급만 취소·HELD KYC이고 에스크로·포트원 정산서는 그대로다', async () => {
    const standard = await scheduled('STANDARD', '2026-12-08', [{ amount: 8_800_000, status: 'REQUESTED' }]);
    const escrow = await scheduled('ESCROW', '2026-12-08', [{ amount: 9_900_000, status: 'REQUESTED' }]);
    const portone = await scheduled('STANDARD', '2026-12-08', [{ amount: 7_700_000, status: 'REQUESTED' }], 'PORTONE');
    const sellerId = h.store.tossSellers.get(`${P}:STANDARD`)!.tossSellerId;
    await h.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellerId, status: 'KYC_REQUIRED', checkedAt: new Date(FRIDAY_10_KST) });
    expect(h.toss!.callsOf('cancelPayout').map((c) => [c.pgStore, (c as { pgPayoutId: string }).pgPayoutId])).toEqual([['STANDARD', standard.pgPayoutIds[0]]]);
    expect(statusOf(standard.payoutIds[0]!)).toBe('CANCELED');
    expect(h.store.statements.get(standard.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
    expect(h.store.statementAudits.filter((a) => a.statementId === standard.s.statementId)).toEqual([expect.objectContaining({ fromStatus: 'SCHEDULED', toStatus: 'HELD', reason: 'scheduled-payout-cancelled:KYC', actor: 'system' })]);
    expect(heldEvents(standard.s.statementId).map((e) => e.value.amount)).toEqual([8_800_000]);
    for (const x of [escrow, portone]) {
      expect(statusOf(x.payoutIds[0]!)).toBe('REQUESTED');
      expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'SCHEDULED' });
    }
  });

  test('J-T40 ⑥ KYC_REQUIRED 뒤 취소 응답이 실패하면 지급 건·정산서가 그대로다', async () => {
    const standard = await scheduled('STANDARD', '2026-12-08', [{ amount: 8_800_000, status: 'REQUESTED' }]);
    h.toss!.fail('cancelPayout', 'STANDARD');
    const sellerId = h.store.tossSellers.get(`${P}:STANDARD`)!.tossSellerId;
    await h.settlements.applyTossSellerFact({ pgStore: 'STANDARD', tossSellerId: sellerId, status: 'KYC_REQUIRED', checkedAt: new Date(FRIDAY_10_KST) });
    expect(statusOf(standard.payoutIds[0]!)).toBe('REQUESTED');
    expect(h.store.statements.get(standard.s.statementId)).toMatchObject({ status: 'SCHEDULED' });
    expect(heldEvents(standard.s.statementId)).toEqual([]);
  });

  test('J-T40 ⑥ cancelScheduledTossPayouts(KYC)는 지급일 상한 없이 그 상점의 REQUESTED 예약지급을 센다', async () => {
    const far = await scheduled('STANDARD', '2027-01-15', [{ amount: 1_234_567, status: 'REQUESTED' }]);
    await expect(h.settlements.cancelScheduledTossPayouts({ promoterId: P, pgStore: 'STANDARD', reason: 'KYC' })).resolves.toEqual({ cancelled: 1, waiting: 0 });
    expect(statusOf(far.payoutIds[0]!)).toBe('CANCELED');
    expect(h.store.statements.get(far.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'KYC' });
  });
});
