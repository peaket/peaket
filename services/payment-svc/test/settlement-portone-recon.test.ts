// 포트원 사후 대사 시험(J-T20 ①~⑤, J-T21, J-T22 ①②③, settlement §5.3·§5.5·§6·§11, ADR-0108, ADR-0370 결정 8, F-07-7 계획 §5.1(라)(마)).
// 콘솔 우회를 잡는 주 통제다: 출금 대사(30분), 파트너 계좌 대조(08:00 KST·09:00 실행 건), 잔액 대조, 대사 멈춤 경보(3,600초), 15:00 KST 실행 기록 없음 경보.
// 포트원 플랫폼은 대역 서버(공개 명세 모양 [가정]), ops 경보·CS 받기는 대역 서버다. 시간 경계는 가짜 시계로 −1ms와 경계를 함께 잰다.
// 계좌번호 전체·예금주명은 메모리 비교만 하고 저장·로그·건·경보에 0건이다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SettlementDueWorker } from '../src/modules/settlement/index.js';
import type { PgLedgerSource } from '../src/modules/settlement/domain/ports.js';
import type { Pg, PgStore, StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import { OpsIntakeFake } from './support/ops-intake-fake.js';
import { PortonePlatformFake, type FakeAccountTransfer } from './support/portone-platform-fake.js';
import { batch, dumpStore, harness, kyc, leaks, payout, PORTONE_SECRET, portonePartner, statement, tossSeller, type Harness } from './support/settlement-portone-harness.js';

const LEGAL = '주식회사 피켓엔터';
const ACCOUNT = '11012345678901';
/** 지급일 2026-12-02(수) */
const PAYOUT_DATE = '2026-12-02';
/** 지급 완료(포트원 SUCCEEDED) 시각 = 지급일 11:10 KST */
const COMPLETED_AT = Date.parse('2026-12-02T02:10:00.000Z');

/** 장부 원천의 짝 가짜(F-07-6 포트 PgLedgerSource, settlement-pg-balance-recon.test.ts의 FakeLedger와 같은 모양). 키는 `${pg}:${pgStore}` */
class FakeLedger implements PgLedgerSource {
  readonly calls: { pg: Pg; pgStore: PgStore; cutoffAt: Date }[] = [];
  readonly rows = new Map<string, { approvedAmount: number; refundedAmount: number; paidOutAmount: number; payoutCountByMonth: Record<string, number>; firstPaymentAt: Date | null }>();
  async ledger(input: { pg: Pg; pgStore: PgStore; cutoffAt: Date }) {
    this.calls.push(input);
    return this.rows.get(`${input.pg}:${input.pgStore}`) ?? { approvedAmount: 0, refundedAmount: 0, paidOutAmount: 0, payoutCountByMonth: {}, firstPaymentAt: null };
  }
}

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
beforeEach(() => {
  fake.reset();
  ops.reset();
  h = harness({ now: COMPLETED_AT, portone: fake, toss: true, ops });
});

const at = (ms: number) => h.clock.advance(ms - h.clock.now());
const ledgerCases = () => [...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_LEDGER_MISMATCH');
const alerts = () => [...h.store.alertRequests.values()];

function partner(o: { accountNumber?: string; holder?: string } = {}): { P: string; partnerId: string } {
  const P = randomUUID();
  const since = new Date(COMPLETED_AT - 30 * 86_400_000);
  h.store.kycs.set(P, kyc(P, since, { legalName: LEGAL, representative: '김대표' }));
  h.store.accounts.set(P, { promoterId: P, bankCode: '88', accountLast4: ACCOUNT.slice(-4), version: 4, changedAt: since, holdUntil: since, holderVerified: true, agencySyncPending: false });
  const partnerId = portonePartner(h.store, P, since);
  fake.partners.set(partnerId, { id: partnerId, name: LEGAL, account: { bank: 'SHINHAN', number: o.accountNumber ?? ACCOUNT, holder: o.holder ?? LEGAL }, defaultContractId: 'c', scheduled: null });
  return { P, partnerId };
}

/** 지급 완료된 포트원 지급 건 하나(포트원 지급 ID po-N ↔ 수기 정산건 = 정산서 ID) */
async function paid(P: string, amount: number, n: number): Promise<{ s: StatementRecord; payoutId: string; portonePayoutId: string }> {
  const since = new Date(COMPLETED_AT - 2 * 86_400_000);
  const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: amount, statementCount: 1, status: 'SUBMITTED', portoneBulkPayoutId: 'bulk-f077', at: since });
  await h.store.insertPayoutBatch(b);
  const s = statement({ promoterId: P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, status: 'SCHEDULED', payoutAmount: amount, payoutBatchId: b.batchId, at: since });
  await h.store.saveStatement(s);
  const p = payout({ batchId: b.batchId, statementId: s.statementId, amount, pgPayoutId: s.statementId, payoutDate: PAYOUT_DATE, at: since });
  await h.store.insertPayouts([p]);
  const portonePayoutId = `po-${n}`;
  fake.transfers.set(s.statementId, { id: s.statementId, partnerId: `peaket-${P}`, settlementAmount: amount, settlementDate: PAYOUT_DATE, status: 'SCHEDULED' });
  fake.payouts.push({ id: portonePayoutId, bulkPayoutId: 'bulk-f077', transferId: s.statementId, status: 'SUCCEEDED', completedAt: new Date(COMPLETED_AT).toISOString(), failureCode: null });
  // 30분 동기화가 SUCCEEDED를 반영한다(완료 시각 = COMPLETED_AT)
  await h.settlements.syncPortonePayouts();
  return { s, payoutId: p.payoutId, portonePayoutId };
}

const withdrawal = (o: Partial<FakeAccountTransfer> & { id: string; amount: number }): FakeAccountTransfer => ({
  type: 'WITHDRAWAL',
  withdrawalType: 'PAYOUT',
  payoutId: null,
  bank: 'SHINHAN',
  accountNumber: ACCOUNT,
  holderName: '(주)피켓엔터',
  balance: 500_000_000,
  tradedAt: new Date(COMPLETED_AT + 60_000).toISOString(),
  ...o,
});

describe('J-T20 포트원 출금 대사', () => {
  test('J-T20 ① 정상 일괄 지급의 출금은 MATCHED이고 이체 ID가 지급 건에 남으며 경보·건이 없다', async () => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    fake.accountTransfers.push(withdrawal({ id: 'at-1', payoutId: x.portonePayoutId, amount: 12_193_000 }));
    at(COMPLETED_AT + 30 * 60_000);
    await expect(h.settlements.reconcilePortoneTransfers()).resolves.toEqual({ checked: 1, mismatched: 0, unlinked: 0, missing: 0 });
    expect(h.store.payouts.get(x.payoutId)).toMatchObject({ pgTransferId: 'at-1', transferCheck: 'MATCHED', transferCheckedAt: new Date(h.clock.now()) });
    expect(h.store.portoneTransfers.get('at-1')).toMatchObject({ transferId: 'at-1', payoutId: x.payoutId, amount: 12_193_000, bankCode: '88', accountLast4: '8901', holderMatched: true, checkResult: 'MATCHED' });
    expect(ledgerCases()).toEqual([]);
    expect(alerts()).toEqual([]);
    expect(h.store.ledgerSyncs.get('WITHDRAWAL')).toMatchObject({ lastSuccessAt: new Date(h.clock.now()), readThrough: new Date(h.clock.now() - 30 * 60_000) });
  });

  test.each([
    ['② 금액이 다른 출금', (id: string) => withdrawal({ id: 'at-x', payoutId: id, amount: 12_192_999 })],
    ['③ 다른 계좌로 간 지급', (id: string) => withdrawal({ id: 'at-x', payoutId: id, amount: 12_193_000, bank: 'KOOKMIN', accountNumber: '06499999999999' })],
    ['③ 예금주가 다른 지급', (id: string) => withdrawal({ id: 'at-x', payoutId: id, amount: 12_193_000, holderName: '다른회사' })],
  ])('J-T20 ②③ %s는 다음 30분 동기화에서 SEV2와 CS 건이 하나씩이고, 그다음 동기화에서 다시 생기지 않는다 [ASVS v5.0.0-2.2.3]', async (_name, make) => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    fake.accountTransfers.push(make(x.portonePayoutId));
    at(COMPLETED_AT + 30 * 60_000);
    await expect(h.settlements.reconcilePortoneTransfers()).resolves.toMatchObject({ mismatched: 1, unlinked: 0 });
    expect(h.store.payouts.get(x.payoutId)?.transferCheck).toBe('MISMATCH');
    expect(ledgerCases()).toEqual([expect.objectContaining({ eventKey: 'portone-transfer:at-x', sourceId: 'at-x' })]);
    expect(alerts()).toEqual([expect.objectContaining({ kind: 'settlement_portone_withdrawal_unmatched', severity: 'SEV2', sourceId: 'at-x' })]);
    // 다음 tick: 겹쳐 읽은 같은 이체는 건·경보를 다시 만들지 않는다
    at(COMPLETED_AT + 60 * 60_000);
    await h.settlements.reconcilePortoneTransfers();
    expect(ledgerCases()).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    // 경보 요청은 ops 운영 경보로 한 번 간다
    await expect(h.settlements.retrySettlementAlerts()).resolves.toEqual({ sent: 1, pending: 0 });
    await expect(h.settlements.retrySettlementAlerts()).resolves.toEqual({ sent: 0, pending: 0 });
    expect(ops.alerts.map((a) => [a.kind, a.severity])).toEqual([['settlement_portone_withdrawal_unmatched', 'SEV2']]);
    expect(leaks(JSON.stringify(ops.alerts) + JSON.stringify(alerts()) + JSON.stringify(ledgerCases()), ACCOUNT, '다른회사')).toEqual([]);
    expect(leaks(JSON.stringify(ops.alerts), '06499999999999')).toEqual([]);
    expect(await h.registry.metrics()).toContain('settlement_portone_withdrawal_unmatched_total 1');
  });

  test('J-T20 ④ 지급 건과 이어지지 않는 출금은 SEV2·CS 건이고 그날(KST) 남은 포트원 실행 건을 만들지 않는다', async () => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    fake.accountTransfers.push(withdrawal({ id: 'at-1', payoutId: x.portonePayoutId, amount: 12_193_000 }));
    fake.accountTransfers.push(withdrawal({ id: 'at-rogue', payoutId: null, withdrawalType: 'TRANSFER', amount: 77_000_000, bank: 'WOORI', accountNumber: '10055555555555', holderName: '모르는사람' }));
    at(COMPLETED_AT + 30 * 60_000);
    await expect(h.settlements.reconcilePortoneTransfers()).resolves.toMatchObject({ mismatched: 0, unlinked: 1, missing: 0 });
    expect(h.store.portoneTransfers.get('at-rogue')).toMatchObject({ payoutId: null, checkResult: 'UNLINKED', accountLast4: '5555' });
    expect(ledgerCases()).toEqual([expect.objectContaining({ eventKey: 'portone-transfer:at-rogue', sourceId: 'at-rogue' })]);
    expect(alerts()).toEqual([expect.objectContaining({ severity: 'SEV2', sourceId: 'at-rogue' })]);
    expect(h.store.ledgerSyncs.get('WITHDRAWAL')?.haltedOn).toBe(PAYOUT_DATE);
    // 같은 날 다른 포트원 묶음이 있어도 실행 건을 만들지 않는다
    const B = partner();
    const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: 1_000_000, statementCount: 1, status: 'SUBMITTED', at: new Date(COMPLETED_AT) });
    await h.store.insertPayoutBatch(b);
    await h.store.saveStatement(statement({ promoterId: B.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, status: 'SCHEDULED', payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(COMPLETED_AT) }));
    await expect(h.settlements.preparePortoneExecution(PAYOUT_DATE)).resolves.toMatchObject({ cases: 0, halted: true });
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_PAYOUT_EXECUTION')).toEqual([]);
    // 저장소·건·경보·로그에 그 계좌번호·예금주명이 없다
    expect(leaks(dumpStore(h.store) + h.log.text(), '10055555555555', '모르는사람')).toEqual([]);
  });

  test('J-T20 ④ 이어지지 않는 출금이 나오기 전에 이미 연 실행 건이 있으면 그 묶음에 실행 멈춤 건이 새 사건 키로 하나 더 생기고 detail에 실행 멈춤이 적힌다(계획 §5.1 (타) 결정 2)', async () => {
    const A = partner();
    const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: 1_000_000, statementCount: 1, status: 'SUBMITTED', at: new Date(COMPLETED_AT - 86_400_000) });
    await h.store.insertPayoutBatch(b);
    const s = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, status: 'SCHEDULED', payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(COMPLETED_AT - 86_400_000) });
    await h.store.saveStatement(s);
    fake.partnerSettlements.set(PAYOUT_DATE, [{ partnerId: A.partnerId, transferId: s.statementId, settlementAmount: 1_000_000 }]);
    await h.settlements.preparePortoneExecution(PAYOUT_DATE);
    const opened = [...h.store.caseRequests.values()].find((c) => c.eventKey === `portone-execution:${b.batchId}`)!;
    expect(opened.detail ?? '').not.toContain('실행 멈춤');
    fake.accountTransfers.push(withdrawal({ id: 'at-rogue-2', payoutId: null, withdrawalType: 'TRANSFER', amount: 5_000_000, bank: 'WOORI', accountNumber: '10055555555555', holderName: '모르는사람' }));
    at(COMPLETED_AT + 30 * 60_000);
    await h.settlements.reconcilePortoneTransfers();
    // 실행 멈춤 건: 종류 PORTONE_PAYOUT_EXECUTION, 사건 키 portone-execution-halt:{묶음 ID}:{날짜}, detail에 '실행 멈춤'과 그 이체 ID(계획 I-13, TR-08)
    const haltKey = `portone-execution-halt:${b.batchId}:${PAYOUT_DATE}`;
    const halt = h.store.caseRequests.get(haltKey);
    expect(halt).toMatchObject({ eventKey: haltKey, kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: b.batchId });
    expect(halt!.detail).toContain('실행 멈춤');
    expect(halt!.detail).toContain('at-rogue-2');
    const halted = [...h.store.caseRequests.values()].filter((c) => (c.detail ?? '').includes('실행 멈춤'));
    expect(halted.map((c) => c.eventKey)).toEqual([haltKey]);
    await h.settlements.retryPayoutCases();
    expect(ops.cases.filter((c) => c.eventKey === haltKey).map((c) => [c.kind, c.sourceId, c.detail])).toEqual([['PORTONE_PAYOUT_EXECUTION', b.batchId, halt!.detail]]);
    // 처음 연 건의 글은 바뀌지 않는다
    expect(h.store.caseRequests.get(opened.eventKey)?.detail).toBe(opened.detail);
    expect(leaks(halt!.detail ?? '', '10055555555555', '모르는사람')).toEqual([]);
    // 다음 tick에 다시 만들지 않는다
    at(COMPLETED_AT + 60 * 60_000);
    await h.settlements.reconcilePortoneTransfers();
    expect([...h.store.caseRequests.values()].filter((c) => (c.detail ?? '').includes('실행 멈춤'))).toHaveLength(1);
  });

  test('J-T20 ② 운영 경보 받기가 503이면 경보 요청이 보낸 시각 없이 남고 다음 tick에 보낸다(F-19, TR-10)', async () => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    fake.accountTransfers.push(withdrawal({ id: 'at-x', payoutId: x.portonePayoutId, amount: 1 }));
    at(COMPLETED_AT + 30 * 60_000);
    await h.settlements.reconcilePortoneTransfers();
    ops.mode = '503';
    await expect(h.settlements.retrySettlementAlerts()).resolves.toEqual({ sent: 0, pending: 1 });
    expect(alerts()).toEqual([expect.objectContaining({ sourceId: 'at-x', requestedAt: null })]);
    expect(ops.refused.get('/internal/v1/ops-alerts')).toBe(1);
    expect(ops.alerts).toEqual([]);
    ops.mode = 'up';
    at(COMPLETED_AT + 60 * 60_000);
    await expect(h.settlements.retrySettlementAlerts()).resolves.toEqual({ sent: 1, pending: 0 });
    expect(alerts()).toEqual([expect.objectContaining({ sourceId: 'at-x', requestedAt: new Date(COMPLETED_AT + 60 * 60_000) })]);
    expect(ops.alerts.map((a) => [a.kind, a.severity])).toEqual([['settlement_portone_withdrawal_unmatched', 'SEV2']]);
  });

  test('J-T20 ⑤ SUCCEEDED 뒤 59분 59.999초에는 MISSING이 없고 1시간에 MISSING과 건이 생기며, 로그·저장소·건·경보에 계좌번호 전체·예금주명이 0건이다 [ASVS v5.0.0-16.2.5]', async () => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    at(COMPLETED_AT + 3_600_000 - 1);
    await expect(h.settlements.reconcilePortoneTransfers()).resolves.toMatchObject({ missing: 0 });
    expect(h.store.payouts.get(x.payoutId)?.transferCheck).toBeNull();
    expect(ledgerCases()).toEqual([]);
    at(COMPLETED_AT + 3_600_000);
    await expect(h.settlements.reconcilePortoneTransfers()).resolves.toMatchObject({ missing: 1 });
    expect(h.store.payouts.get(x.payoutId)?.transferCheck).toBe('MISSING');
    expect(ledgerCases()).toHaveLength(1);
    expect(alerts()).toEqual([expect.objectContaining({ severity: 'SEV2' })]);
    // 다음 tick에 다시 만들지 않는다
    at(COMPLETED_AT + 3_600_000 + 30 * 60_000);
    await h.settlements.reconcilePortoneTransfers();
    expect(ledgerCases()).toHaveLength(1);
    // 판매자 상호는 seller_kyc에 저장하는 값이라(시험이 심음) 그 표를 빼고, 예금주명·계좌번호가 다른 곳에 없는지 본다(시험 이의 TO-03)
    expect(leaks(dumpStore(h.store, { except: ['kycs'] }) + h.log.text() + JSON.stringify(ops.alerts), ACCOUNT, LEGAL)).toEqual([]);
  });

  test('J-T20 ② 30분 tick이 출금 대사와 경보 보내기를 부른다(일꾼 tick)', async () => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    fake.accountTransfers.push(withdrawal({ id: 'at-x', payoutId: x.portonePayoutId, amount: 1 }));
    at(COMPLETED_AT + 30 * 60_000);
    const worker = new SettlementDueWorker({ settlements: h.settlements, leader: { isLeader: () => true }, clock: h.clock });
    await worker.tick(false);
    expect(ledgerCases()).toHaveLength(1);
    // 같은 tick이나 다음 tick의 경보 다시 보내기가 ops에 보낸다
    at(COMPLETED_AT + 60 * 60_000);
    await worker.tick(false);
    expect(ops.alerts.filter((a) => a.kind === 'settlement_portone_withdrawal_unmatched')).toHaveLength(1);
  });
});

describe('J-T21 포트원 계좌 대조와 보류', () => {
  /** 08:00 KST(2026-12-01) = 2026-11-30T23:00:00Z */
  const EIGHT_KST = Date.parse('2026-11-30T23:00:00.000Z');

  async function confirmed(P: string, pg: 'PORTONE' | 'TOSS', amount: number): Promise<StatementRecord> {
    const s = statement({ promoterId: P, pg, payoutDate: PAYOUT_DATE, payoutAmount: amount, at: new Date(EIGHT_KST - 86_400_000) });
    await h.store.saveStatement(s);
    return s;
  }

  test('J-T21 07:59:59.999 KST에는 대조하지 않고 08:00 KST에 대조해, 계좌가 바뀐 A만 SEV2·CS 건과 포트원 정산서 HELD ACCOUNT_MISMATCH이고 A의 토스 정산서는 그대로다', async () => {
    h = harness({ now: EIGHT_KST - 1, portone: fake, toss: true, ops });
    const A = partner({ accountNumber: '11098765432100' });
    const B = partner();
    tossSeller(h.store, A.P, 'STANDARD', 'APPROVED', new Date(EIGHT_KST - 86_400_000));
    const aPortone = await confirmed(A.P, 'PORTONE', 3_000_000);
    const aToss = await confirmed(A.P, 'TOSS', 4_000_000);
    const bPortone = await confirmed(B.P, 'PORTONE', 5_000_000);
    const worker = new SettlementDueWorker({ settlements: h.settlements, leader: { isLeader: () => true }, clock: h.clock });
    await worker.tick(false);
    expect(fake.calls('GET /platform/partners/{id}')).toEqual([]);
    at(EIGHT_KST);
    await worker.tick(false);
    expect(fake.calls('GET /platform/partners/{id}').map((c) => c.path).sort()).toEqual([`/platform/partners/${A.partnerId}`, `/platform/partners/${B.partnerId}`].sort());
    expect(h.store.statements.get(aPortone.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_MISMATCH' });
    expect(h.store.statements.get(aToss.statementId)).toMatchObject({ status: 'CONFIRMED', holdReason: null });
    expect(h.store.statements.get(bPortone.statementId)).toMatchObject({ status: 'CONFIRMED' });
    expect(ledgerCases()).toEqual([expect.objectContaining({ eventKey: `portone-account:${A.P}:2026-12-01`, sourceId: A.P })]);
    expect(alerts()).toEqual([expect.objectContaining({ kind: 'settlement_portone_partner_account_mismatch', severity: 'SEV2', sourceId: A.P })]);
    expect(h.store.portonePartners.get(A.P)).toMatchObject({ lastAccountCheck: 'MISMATCH', lastAccountCheckedAt: new Date(EIGHT_KST) });
    expect(h.store.portonePartners.get(B.P)).toMatchObject({ lastAccountCheck: 'MATCHED' });
    expect(await h.registry.metrics()).toContain('settlement_portone_partner_account_mismatch 1');
    // 같은 날 다시 돌아도(08:30) 하루 한 번이다
    at(EIGHT_KST + 30 * 60_000);
    await worker.tick(false);
    expect(fake.calls('GET /platform/partners/{id}')).toHaveLength(2);
    expect(leaks(dumpStore(h.store) + h.log.text(), '11098765432100')).toEqual([]);
  });

  test('J-T21 계좌가 바뀐 파트너의 SCHEDULED 포트원 정산서는 수기 정산건 취소·T10 HELD ACCOUNT_MISMATCH·PAYOUT_HELD이고, 예금주만 바뀐 것도 불일치다', async () => {
    const A = partner({ holder: '다른회사' });
    const x = await paid(A.P, 9_000_000, 7);
    // 지급 완료 전 상태로 되돌린 정산서(SCHEDULED, 지급 건 REQUESTED)
    await h.store.saveStatement({ ...h.store.statements.get(x.s.statementId)!, status: 'SCHEDULED' });
    await h.store.savePayout({ ...h.store.payouts.get(x.payoutId)!, status: 'REQUESTED' });
    await expect(h.settlements.checkPortonePartnerAccounts({ promoterIds: [A.P] })).resolves.toMatchObject({ checked: 1, mismatched: 1 });
    expect(fake.calls('DELETE /platform/transfers/{id}').map((c) => c.path)).toEqual([`/platform/transfers/${x.s.statementId}`]);
    expect(h.store.statements.get(x.s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_MISMATCH' });
    expect(h.store.outbox.filter((e) => e.value.type === 'PAYOUT_HELD' && e.value.statementId === x.s.statementId).map((e) => e.value.amount)).toEqual([9_000_000]);
    expect(leaks(dumpStore(h.store) + h.log.text(), ACCOUNT, '다른회사')).toEqual([]);
  });

  /** A·B가 든 포트원 묶음을 지급일 전날 실행하고, 콘솔에서 A의 계좌를 바꾸고 B의 정산 내역 금액을 고친 상태 */
  async function consoleTampered(): Promise<{ A: { P: string; partnerId: string }; B: { P: string; partnerId: string }; batchId: string; sa: StatementRecord; sb: StatementRecord; nine: number }> {
    const nine = Date.parse('2026-12-02T00:00:00.000Z');
    h = harness({ now: nine - 86_400_000, portone: fake, toss: true, ops });
    const A = partner();
    const B = partner();
    const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: 2_000_000, statementCount: 2, status: 'APPROVED', at: new Date(nine - 2 * 86_400_000) });
    await h.store.insertPayoutBatch(b);
    const sa = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(nine - 2 * 86_400_000) });
    const sb = statement({ promoterId: B.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(nine - 2 * 86_400_000) });
    await h.store.saveStatement(sa);
    await h.store.saveStatement(sb);
    await h.settlements.executeBatch(b.batchId);
    fake.partners.get(A.partnerId)!.account = { bank: 'WOORI', number: '10012121212121', holder: LEGAL };
    fake.partnerSettlements.set(PAYOUT_DATE, [
      { partnerId: A.partnerId, transferId: sa.statementId, settlementAmount: 1_000_000 },
      { partnerId: B.partnerId, transferId: sb.statementId, settlementAmount: 1_500_000 },
    ]);
    at(nine);
    return { A, B, batchId: b.batchId, sa, sb, nine };
  }

  test('J-T21 실행 직전 대조(정산일 지정): 계좌가 다른 A의 정산서는 HELD ACCOUNT_MISMATCH, 정산 내역 금액이 다른 B의 정산서는 SCHEDULED 그대로이고 둘 다 뺀 목록이다', async () => {
    const x = await consoleTampered();
    const check = await h.settlements.checkPortonePartnerAccounts({ promoterIds: [x.A.P, x.B.P], settlementDate: PAYOUT_DATE });
    expect(check).toMatchObject({ checked: 2, mismatched: 1 });
    expect([...check.excludedStatements].sort()).toEqual([x.sa.statementId, x.sb.statementId].sort());
    expect(h.store.statements.get(x.sa.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_MISMATCH' });
    expect(h.store.statements.get(x.sb.statementId)).toMatchObject({ status: 'SCHEDULED', holdReason: null });
    expect(ledgerCases().map((c) => c.sourceId)).toEqual(expect.arrayContaining([x.A.P, x.sb.statementId]));
    expect(alerts().every((a) => a.severity === 'SEV2')).toBe(true);
    expect(alerts().length).toBeGreaterThanOrEqual(2);
  });

  test('J-T21 09:00 실행 건은 그 묶음의 파트너를 다시 대조해 A·B 정산서를 뺀 목록과 함께 열린다', async () => {
    const x = await consoleTampered();
    await expect(h.settlements.preparePortoneExecution(PAYOUT_DATE)).resolves.toMatchObject({ cases: 1 });
    expect(fake.calls('GET /platform/partner-settlements').map((c) => c.query)).toEqual([{ settlementDate: PAYOUT_DATE }]);
    expect(h.store.statements.get(x.sa.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_MISMATCH' });
    expect(h.store.statements.get(x.sb.statementId)).toMatchObject({ status: 'SCHEDULED' });
    const request = [...h.store.caseRequests.values()].find((c) => c.eventKey === `portone-execution:${x.batchId}`)!;
    expect(request.detail).toMatch(/^뺀 정산서: /);
    expect(request.detail).toContain(`${x.sa.statementId}(ACCOUNT_MISMATCH)`);
    expect(request.detail).toContain(x.sb.statementId);
    expect(leaks(request.detail ?? '', ACCOUNT, LEGAL)).toEqual([]);
    await h.settlements.retryPayoutCases();
    expect(ops.cases.filter((c) => c.eventKey === `portone-execution:${x.batchId}`).map((c) => c.detail)).toEqual([request.detail]);
  });

  test('J-T21 A가 계좌를 다시 내 대조가 맞아도 3영업일 전에는 재확정 409이고, 증빙(accountReconciled)만으로는 풀리지 않으며, 보류가 끝난 뒤에만 CONFIRMED다', async () => {
    // 금요일 10:00 KST에 대조 불일치로 보류
    const friday = Date.parse('2026-11-27T01:00:00.000Z');
    h = harness({ now: friday, portone: fake, toss: true, ops });
    const A = partner({ accountNumber: '11098765432100' });
    tossSeller(h.store, A.P, 'STANDARD', 'PARTIALLY_APPROVED', new Date(friday - 86_400_000));
    tossSeller(h.store, A.P, 'ESCROW', 'PARTIALLY_APPROVED', new Date(friday - 86_400_000));
    const s = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: '2026-12-04', payoutAmount: 2_500_000, at: new Date(friday - 86_400_000) });
    await h.store.saveStatement(s);
    await h.settlements.checkPortonePartnerAccounts({ promoterIds: [A.P] });
    expect(h.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_MISMATCH' });
    // 증빙만으로는 풀리지 않는다(마지막 대조가 MISMATCH)
    await expect(h.settlements.reconfirmStatement(s.statementId, { actor: randomUUID(), evidence: { accountReconciled: true } })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-change-hold') });
    // A가 SCR-020으로 계좌를 다시 낸다(포트원 파트너 수정 → 포트원 계좌가 PEAKET 기록과 같아짐)
    fake.holder('SHINHAN', '11011112222333', LEGAL);
    await h.settlements.putPayoutAccount(A.P, 'sid', { bankCode: '88', accountNumber: '11011112222333', holderName: LEGAL }, '"4"', 'test-reauth');
    at(friday + 3_600_000);
    await h.settlements.checkPortonePartnerAccounts({ promoterIds: [A.P] });
    expect(h.store.portonePartners.get(A.P)).toMatchObject({ lastAccountCheck: 'MATCHED' });
    // 대조는 맞지만 3영업일(다음 주 수요일 10:00 KST) 전이다
    at(Date.parse('2026-12-02T01:00:00.000Z') - 1);
    await expect(h.settlements.reconfirmStatement(s.statementId, { actor: randomUUID(), evidence: { accountReconciled: true } })).rejects.toMatchObject({ status: 409 });
    at(Date.parse('2026-12-02T01:00:00.000Z'));
    await expect(h.settlements.reconfirmStatement(s.statementId, { actor: randomUUID(), evidence: { accountReconciled: true } })).resolves.toMatchObject({ status: 'CONFIRMED' });
  });

  test('J-T21 계좌 대조가 그 계좌 변경보다 앞선 것이면(변경 뒤 대조 없음) 보류가 끝나도 재확정 409다', async () => {
    const friday = Date.parse('2026-11-27T01:00:00.000Z');
    h = harness({ now: friday, portone: fake, toss: true, ops });
    const A = partner();
    tossSeller(h.store, A.P, 'STANDARD', 'PARTIALLY_APPROVED', new Date(friday - 86_400_000));
    tossSeller(h.store, A.P, 'ESCROW', 'PARTIALLY_APPROVED', new Date(friday - 86_400_000));
    const s = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: '2026-12-04', status: 'HELD', holdReason: 'ACCOUNT_MISMATCH', payoutAmount: 2_500_000, at: new Date(friday - 86_400_000) });
    await h.store.saveStatement(s);
    // 대조 MATCHED는 변경 전(1시간 앞)
    h.store.portonePartners.set(A.P, { ...h.store.portonePartners.get(A.P)!, lastAccountCheck: 'MATCHED', lastAccountCheckedAt: new Date(friday - 3_600_000) });
    fake.holder('SHINHAN', '11011112222333', LEGAL);
    await h.settlements.putPayoutAccount(A.P, 'sid', { bankCode: '88', accountNumber: '11011112222333', holderName: LEGAL }, '"4"', 'test-reauth');
    at(Date.parse('2026-12-02T01:00:00.000Z') + 60_000);
    await expect(h.settlements.reconfirmStatement(s.statementId, { actor: randomUUID(), evidence: { accountReconciled: true } })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-change-hold') });
  });
});

describe('J-T22 포트원 잔액 대조와 대사 멈춤', () => {
  /** 지급대행 계좌 원장: 마지막 출금 뒤 잔액 30,000,000 + 그 뒤 입금 10,000,000 = 계산값 40,000,000 */
  function ledger40m(): void {
    fake.accountTransfers.push(
      withdrawal({ id: 'at-w', amount: 1_000_000, balance: 30_000_000, tradedAt: '2026-11-30T01:00:00.000Z' }),
      { id: 'at-d', type: 'DEPOSIT', withdrawalType: null, payoutId: null, amount: 10_000_000, bank: null, accountNumber: null, holderName: null, balance: 40_000_000, tradedAt: '2026-11-30T03:00:00.000Z' },
    );
  }
  async function confirmedPortone(amount: number): Promise<{ P: string; s: StatementRecord }> {
    const A = partner();
    const s = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, payoutAmount: amount, at: new Date(COMPLETED_AT - 86_400_000) });
    await h.store.saveStatement(s);
    return { P: A.P, s };
  }
  const create = (operator: number) => h.settlements.createPayoutBatch({ pg: 'PORTONE', pgStore: 'STANDARD', payoutDate: PAYOUT_DATE, portoneBalance: { amount: operator, observedAt: new Date(COMPLETED_AT).toISOString() }, actor: randomUUID() });

  test('J-T22 ① operator가 원장 계산값보다 큰 잔액을 적으면 원장 계산값으로 판정해 모자라면 HELD BALANCE·409이고 묶음이 없다', async () => {
    ledger40m();
    const { s } = await confirmedPortone(45_000_000);
    await expect(create(50_000_000)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-balance-insufficient') });
    expect(h.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'BALANCE' });
    expect(h.store.batches.size).toBe(0);
  });

  test('J-T22 ① 원장 계산값이 지급 합계와 같으면(operator가 1원 큼) 묶음을 만들고 pg_balance_ledger_krw에 계산값을, 차이로 CS 건 하나(대상 = 묶음 ID)와 차이 게이지를 남긴다', async () => {
    ledger40m();
    await confirmedPortone(40_000_000);
    const view = await create(40_000_001);
    const b = h.store.batches.get(view.batchId)!;
    expect(b).toMatchObject({ pgBalanceKrw: 40_000_001, pgBalanceLedgerKrw: 40_000_000, pgBalanceSource: 'OPERATOR_CONSOLE' });
    expect(ledgerCases()).toEqual([expect.objectContaining({ sourceId: view.batchId })]);
    expect(await h.registry.metrics()).toContain('settlement_portone_balance_diff_krw 1');
  });

  test('J-T22 ① operator 입력값과 원장 계산값이 같으면 CS 건이 없다', async () => {
    ledger40m();
    await confirmedPortone(39_000_000);
    const view = await create(40_000_000);
    expect(h.store.batches.get(view.batchId)).toMatchObject({ pgBalanceKrw: 40_000_000, pgBalanceLedgerKrw: 40_000_000 });
    expect(ledgerCases()).toEqual([]);
  });

  test('J-T22 ① 원장 조회가 실패하면 묶음을 만들지 않고 503 pg-balance-unavailable이며 정산서가 그대로다', async () => {
    const { s } = await confirmedPortone(1_000_000);
    fake.fault('GET /platform/account-transfers', '5xx');
    await expect(create(9_000_000)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('pg-balance-unavailable') });
    expect(h.store.batches.size).toBe(0);
    expect(h.store.statements.get(s.statementId)).toMatchObject({ status: 'CONFIRMED', holdReason: null });
  });

  test('J-T22 ① operator 입력값이 원장 계산값보다 1원 작고 지급 합계가 원장 계산값과 같으면 작은 쪽(operator)으로 판정해 HELD BALANCE·409이고 묶음이 없다(TR-02)', async () => {
    ledger40m();
    const { s } = await confirmedPortone(40_000_000);
    await expect(create(39_999_999)).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-balance-insufficient') });
    expect(h.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'BALANCE' });
    expect(h.store.batches.size).toBe(0);
  });

  test('J-T22 ① operator 입력값이 원장 계산값보다 1원 작아도 지급 합계 이상이면 묶음을 만들고 두 값과 차이 CS 건 하나(대상 = 묶음 ID)를 남긴다(TR-02)', async () => {
    ledger40m();
    await confirmedPortone(39_999_999);
    const view = await create(39_999_999);
    expect(h.store.batches.get(view.batchId)).toMatchObject({ pgBalanceKrw: 39_999_999, pgBalanceLedgerKrw: 40_000_000, pgBalanceSource: 'OPERATOR_CONSOLE' });
    expect(ledgerCases()).toEqual([expect.objectContaining({ sourceId: view.batchId })]);
  });

  /** 그날 08:00 KST 계좌 대조 성공(2026-12-02 08:00 KST = 2026-12-01T23:00Z) */
  const EIGHT_TODAY = Date.parse('2026-12-01T23:00:00.000Z');
  const sync = (name: 'WITHDRAWAL' | 'PARTNER_ACCOUNT', lastSuccess: number) =>
    h.store.ledgerSyncs.set(name, { name, lastSuccessAt: new Date(lastSuccess), readThrough: new Date(lastSuccess - 30 * 60_000), haltedOn: null, updatedAt: new Date(lastSuccess) });

  test('J-T22 ② 출금 대사(WITHDRAWAL) 성공 없이 3,599.999초에는 경보가 없고 3,600초에 SEV2 한 번이며, 그날 08:00 계좌 대조 성공은 멈춤이 아니다(계획 §5.1 (파) (다))', async () => {
    const T = COMPLETED_AT;
    sync('WITHDRAWAL', T);
    sync('PARTNER_ACCOUNT', EIGHT_TODAY);
    fake.fault('GET /platform/account-transfers', '5xx');
    at(T + 3_600_000 - 1);
    // 원장 조회 실패: 끝까지 성공하지 못했으므로 성공 시각을 옮기지 않는다(던지든 실패 결과로 끝나든)
    await h.settlements.reconcilePortoneTransfers().catch(() => undefined);
    expect(h.store.ledgerSyncs.get('WITHDRAWAL')?.lastSuccessAt).toEqual(new Date(T));
    await expect(h.settlements.checkPortoneLedgerStale()).resolves.toEqual({ stale: [] });
    expect(alerts()).toEqual([]);
    at(T + 3_600_000);
    await expect(h.settlements.checkPortoneLedgerStale()).resolves.toEqual({ stale: ['WITHDRAWAL'] });
    expect(alerts()).toEqual([expect.objectContaining({ kind: 'settlement_portone_ledger_sync_stale', severity: 'SEV2', sourceId: 'WITHDRAWAL' })]);
    const text = await h.registry.metrics();
    expect(text).toMatch(/^settlement_portone_ledger_sync_age_seconds\{sync="WITHDRAWAL"\} 3600$/m);
    // 계좌 대조는 그날 08:00 성공 뒤 4시간 10분(15,000초) — 지표는 그 값이고 경보는 없다
    expect(text).toMatch(/^settlement_portone_ledger_sync_age_seconds\{sync="PARTNER_ACCOUNT"\} 15000$/m);
    // 같은 멈춤 동안은 한 번
    at(T + 3_600_000 + 30 * 60_000);
    await h.settlements.checkPortoneLedgerStale();
    expect(alerts()).toHaveLength(1);
    // 멈춤 동안 연 실행 건에는 'commander 확인 필요'가 붙는다
    const A = partner();
    const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: 1_000_000, statementCount: 1, status: 'SUBMITTED', at: new Date(T) });
    await h.store.insertPayoutBatch(b);
    const s = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, status: 'SCHEDULED', payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(T) });
    await h.store.saveStatement(s);
    fake.clearFaults();
    fake.partnerSettlements.set(PAYOUT_DATE, [{ partnerId: A.partnerId, transferId: s.statementId, settlementAmount: 1_000_000 }]);
    await h.settlements.preparePortoneExecution(PAYOUT_DATE);
    const request = [...h.store.caseRequests.values()].find((c) => c.eventKey === `portone-execution:${b.batchId}`)!;
    expect(request.detail).toContain('commander 확인 필요');
    await h.settlements.retryPayoutCases();
    expect(ops.cases.filter((c) => c.eventKey === `portone-execution:${b.batchId}`).map((c) => c.detail)).toEqual([request.detail]);
  });

  test('J-T22 ② 계좌 대조(PARTNER_ACCOUNT)는 마지막 성공 뒤 89,999.999초에는 경보가 없고 90,000초(25시간)에 SEV2 한 번이다(계획 §5.1 (파) (다), TR-11)', async () => {
    const P0 = EIGHT_TODAY - 86_400_000; // 어제 08:00 KST
    // 시계는 앞으로만 간다: 경계 1분 앞에서 시작하는 조립을 따로 만든다(시험 이의 TO-02)
    h = harness({ now: P0 + 90_000_000 - 60_000, portone: fake, toss: true, ops });
    sync('PARTNER_ACCOUNT', P0);
    at(P0 + 90_000_000 - 1);
    sync('WITHDRAWAL', h.clock.now() - 60_000);
    await expect(h.settlements.checkPortoneLedgerStale()).resolves.toEqual({ stale: [] });
    expect(alerts()).toEqual([]);
    at(P0 + 90_000_000);
    await expect(h.settlements.checkPortoneLedgerStale()).resolves.toEqual({ stale: ['PARTNER_ACCOUNT'] });
    expect(alerts()).toEqual([expect.objectContaining({ kind: 'settlement_portone_ledger_sync_stale', severity: 'SEV2', sourceId: 'PARTNER_ACCOUNT' })]);
    expect(await h.registry.metrics()).toMatch(/^settlement_portone_ledger_sync_age_seconds\{sync="PARTNER_ACCOUNT"\} 90000$/m);
    at(P0 + 90_000_000 + 30 * 60_000);
    await h.settlements.checkPortoneLedgerStale();
    expect(alerts()).toHaveLength(1);
  });

  test.each([
    ['그날 08:00 계좌 대조가 성공하지 못함(마지막 성공이 어제 08:00 KST)', Date.parse('2026-11-30T23:00:00.000Z'), true],
    ['그날 08:00 계좌 대조가 성공함', Date.parse('2026-12-01T23:00:00.000Z'), false],
  ])('J-T22 ② 09:00 실행 건: %s → detail의 commander 확인 필요 %s(계획 §5.1 (파) (다))', async (_name, lastPartnerCheck, commander) => {
    const nine = Date.parse('2026-12-02T00:00:00.000Z');
    h = harness({ now: nine, portone: fake, toss: true, ops });
    sync('PARTNER_ACCOUNT', lastPartnerCheck);
    sync('WITHDRAWAL', nine - 60_000);
    const A = partner();
    const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: 1_000_000, statementCount: 1, status: 'SUBMITTED', at: new Date(nine - 86_400_000) });
    await h.store.insertPayoutBatch(b);
    const s = statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, status: 'SCHEDULED', payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(nine - 86_400_000) });
    await h.store.saveStatement(s);
    fake.partnerSettlements.set(PAYOUT_DATE, [{ partnerId: A.partnerId, transferId: s.statementId, settlementAmount: 1_000_000 }]);
    await h.settlements.preparePortoneExecution(PAYOUT_DATE);
    const request = [...h.store.caseRequests.values()].find((c) => c.eventKey === `portone-execution:${b.batchId}`)!;
    expect((request.detail ?? '').includes('commander 확인 필요')).toBe(commander);
  });

  test('J-T22 ② 지급일 15:00 KST: 14:59:59.999에는 내지 않고 15:00에 일괄 지급 ID 없는 묶음 수 게이지 1·SEV3 한 번이다(정산 일꾼 tick)', async () => {
    const fifteen = Date.parse('2026-12-02T06:00:00.000Z');
    h = harness({ now: fifteen - 1, portone: fake, toss: true, ops });
    const A = partner();
    const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: 1_000_000, statementCount: 1, status: 'SUBMITTED', portoneBulkPayoutId: null, at: new Date(fifteen - 86_400_000) });
    await h.store.insertPayoutBatch(b);
    await h.store.saveStatement(statement({ promoterId: A.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, status: 'SCHEDULED', payoutAmount: 1_000_000, payoutBatchId: b.batchId, at: new Date(fifteen - 86_400_000) }));
    const recorded = batch({ pg: 'PORTONE', pgStore: 'ESCROW', payoutDate: PAYOUT_DATE, totalAmount: 1, statementCount: 1, status: 'SUBMITTED', portoneBulkPayoutId: 'bulk-done', at: new Date(fifteen - 86_400_000) });
    await h.store.insertPayoutBatch(recorded);
    const worker = new SettlementDueWorker({ settlements: h.settlements, leader: { isLeader: () => true }, clock: h.clock });
    await worker.tick(false);
    expect(alerts().filter((a) => a.kind === 'settlement_portone_execution_pending')).toEqual([]);
    at(fifteen);
    await worker.tick(false);
    expect(alerts().filter((a) => a.kind === 'settlement_portone_execution_pending')).toEqual([expect.objectContaining({ eventKey: `portone-execution-pending:${PAYOUT_DATE}`, severity: 'SEV3' })]);
    expect(await h.registry.metrics()).toContain('settlement_portone_execution_pending 1');
    at(fifteen + 30 * 60_000);
    await worker.tick(false);
    expect(alerts().filter((a) => a.kind === 'settlement_portone_execution_pending')).toHaveLength(1);
    await expect(h.settlements.checkPortoneExecutionPending(PAYOUT_DATE)).resolves.toEqual({ pending: 1 });
  });

  test('J-T22 ③ 이체 원장 응답의 칸 이름이 바뀌면 그 tick은 실패로 끝나고 성공 시각·읽은 시각을 옮기지 않으며 아무것도 쓰지 않는다', async () => {
    const A = partner();
    const x = await paid(A.P, 12_193_000, 1);
    fake.accountTransfers.push(withdrawal({ id: 'at-1', payoutId: x.portonePayoutId, amount: 12_193_000 }));
    const before = new Date(COMPLETED_AT - 3_600_000);
    h.store.ledgerSyncs.set('WITHDRAWAL', { name: 'WITHDRAWAL', lastSuccessAt: before, readThrough: before, haltedOn: null, updatedAt: before });
    fake.fault('GET /platform/account-transfers', 'shape');
    at(COMPLETED_AT + 30 * 60_000);
    await h.settlements.reconcilePortoneTransfers().catch(() => undefined);
    expect(h.store.ledgerSyncs.get('WITHDRAWAL')).toMatchObject({ lastSuccessAt: before, readThrough: before });
    expect(h.store.portoneTransfers.size).toBe(0);
    expect(h.store.payouts.get(x.payoutId)?.transferCheck).toBeNull();
    expect(ledgerCases()).toEqual([]);
    expect(h.log.lines.some((l) => l.includes('portone_reconciliation_failed') || l.includes('portoneReconciliationFailed'))).toBe(true);
  });

  test('J-T22 ③ 포트원 결제분 월말 잔액 대사가 pg_balance_reconciliation에 PORTONE·STANDARD·MONTHLY 한 행이고 보이는 잔액은 이체 원장 계산값이며, 같은 달 두 번째는 undefined·행 그대로다', async () => {
    const ledger = new FakeLedger();
    h = harness({ now: Date.parse('2026-11-30T13:00:00.000Z'), portone: fake, toss: true, ops, pgLedger: ledger });
    ledger.rows.set('PORTONE:STANDARD', { approvedAmount: 90_000_000, refundedAmount: 0, paidOutAmount: 50_000_000, payoutCountByMonth: {}, firstPaymentAt: new Date('2026-11-02T03:00:00.000Z') });
    ledger40m();
    // 월 표기는 F-07-6 reconcileTossBalance와 같은 꼴('YYYY-MM-01')
    const first = await h.settlements.reconcilePortoneBalance({ kind: 'MONTHLY', periodMonth: '2026-11-01' });
    expect(first).toMatchObject({ pg: 'PORTONE', pgStore: 'STANDARD', kind: 'MONTHLY', periodMonth: '2026-11-01', observedAmount: 40_000_000, approvedAmount: 90_000_000, paidOutAmount: 50_000_000 });
    expect(ledger.calls.map((c) => [c.pg, c.pgStore])).toEqual([['PORTONE', 'STANDARD']]);
    expect(h.store.pgBalanceReconciliations.filter((r) => r.pg === 'PORTONE')).toHaveLength(1);
    expect(h.store.pgBalanceReconciliations.filter((r) => r.pg === 'TOSS')).toEqual([]);
    await expect(h.settlements.reconcilePortoneBalance({ kind: 'MONTHLY', periodMonth: '2026-11-01' })).resolves.toBeUndefined();
    expect(h.store.pgBalanceReconciliations.filter((r) => r.pg === 'PORTONE')).toHaveLength(1);
  });
});
