// 포트원 결제분 지급 실행 시험(J-T41 ①②③④, J-T9, settlement §5.3, docs/planning/03 §2.12 T9·T10, ADR-0370 결정 7, F-07-7 계획 §5.1(라)(마)).
// 수기 정산건(아이디 = 정산서 ID) → 지급일 09:00 KST 실행 건(보류 셋은 뺌) → 일괄 지급 ID 기록 → 30분 지급 내역 동기화(PAID·FAILED).
// 포트원 플랫폼은 대역 서버(공개 명세 모양 [가정]), ops CS 건 받기는 대역 서버다. 시간 경계는 가짜 시계로 −1ms와 경계를 함께 잰다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SettlementDueWorker } from '../src/modules/settlement/index.js';
import type { StatementRecord } from '../src/modules/settlement/domain/settlement.js';
import { OpsIntakeFake } from './support/ops-intake-fake.js';
import { PortonePlatformFake } from './support/portone-platform-fake.js';
import { batch, harness, kyc, manualGateways, PORTONE_SECRET, portonePartner, statement, SuspendedEvents, type Harness } from './support/settlement-portone-harness.js';

/** 지급일 2026-12-02(수). 그날 09:00 KST = 2026-12-02T00:00:00Z */
const PAYOUT_DATE = '2026-12-02';
const NINE_KST = Date.parse('2026-12-02T00:00:00.000Z');
const BEFORE_NINE = NINE_KST - 1;
/** 묶음을 실행한 때(지급일 전 영업일 오후) */
const EXECUTED_AT = Date.parse('2026-12-01T06:00:00.000Z');

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
let suspended: SuspendedEvents;
beforeEach(() => {
  fake.reset();
  ops.reset();
  suspended = new SuspendedEvents();
  h = harness({ now: EXECUTED_AT, portone: fake, ops, saleSuspensions: suspended });
});

/** 지급 준비가 된 파트너(판매자 확인·계좌·포트원 파트너) */
function partner(o: { holdUntil?: number; agencySyncPending?: boolean } = {}): { P: string; partnerId: string } {
  const P = randomUUID();
  const at = new Date(EXECUTED_AT - 30 * 86_400_000);
  h.store.kycs.set(P, kyc(P, at));
  h.store.accounts.set(P, { promoterId: P, bankCode: '88', accountLast4: '8901', version: 2, changedAt: at, holdUntil: new Date(o.holdUntil ?? at.getTime()), holderVerified: true, agencySyncPending: o.agencySyncPending ?? false });
  const partnerId = portonePartner(h.store, P, at);
  // 포트원 쪽 파트너 계좌도 PEAKET 기록과 같다(08:00·09:00 계좌 대조가 맞음)
  fake.partners.set(partnerId, { id: partnerId, name: '주식회사 피켓엔터', account: { bank: 'SHINHAN', number: '11012345678901', holder: '주식회사 피켓엔터' }, defaultContractId: 'c', scheduled: null });
  return { P, partnerId };
}

/** 실행한 뒤 포트원 정산 내역을 수기 정산건과 같게 둔다(09:00 정산 내역 대조가 맞음) */
async function execute(batchId: string): Promise<void> {
  await h.settlements.executeBatch(batchId);
  fake.partnerSettlements.set(
    PAYOUT_DATE,
    [...fake.transfers.values()].filter((t) => t.settlementDate === PAYOUT_DATE && t.status === 'SCHEDULED').map((t) => ({ partnerId: t.partnerId, transferId: t.id, settlementAmount: t.settlementAmount })),
  );
}

/** 승인된 포트원 묶음과 묶인 CONFIRMED 정산서 */
async function approvedBatch(statements: readonly { P: string; amount: number; eventId?: string }[]): Promise<{ batchId: string; ss: StatementRecord[] }> {
  const at = new Date(EXECUTED_AT - 86_400_000);
  const total = statements.reduce((n, s) => n + s.amount, 0);
  const b = batch({ pg: 'PORTONE', payoutDate: PAYOUT_DATE, totalAmount: total, statementCount: statements.length, status: 'APPROVED', pgBalanceKrw: total, pgBalanceSource: 'OPERATOR_CONSOLE', at });
  await h.store.insertPayoutBatch(b);
  const ss: StatementRecord[] = [];
  for (const x of statements) {
    const s = statement({ promoterId: x.P, pg: 'PORTONE', payoutDate: PAYOUT_DATE, payoutAmount: x.amount, payoutBatchId: b.batchId, at, ...(x.eventId ? { eventId: x.eventId } : {}) });
    await h.store.saveStatement(s);
    ss.push(s);
  }
  return { batchId: b.batchId, ss };
}

const events = (type: string, statementId?: string) => h.store.outbox.filter((e) => e.value.type === type && (statementId === undefined || e.value.statementId === statementId));
const at = (ms: number) => h.clock.advance(ms - h.clock.now());

describe('J-T41 ① 수기 정산건과 SCHEDULED', () => {
  test('J-T41 ①·J-T9 승인된 포트원 묶음을 실행하면 정산서마다 수기 정산건 하나·지급 건 한 행·SCHEDULED·PAYOUT_SCHEDULED가 남는다', async () => {
    const a = partner();
    const b = partner();
    const { batchId, ss } = await approvedBatch([
      { P: a.P, amount: 12_193_000 },
      { P: b.P, amount: 3_456_789 },
    ]);
    const view = await h.settlements.executeBatch(batchId);
    expect(view.status).toBe('SUBMITTED');
    const posts = fake.calls('POST /platform/transfers/manual');
    expect(posts.map((p) => p.body)).toEqual(
      expect.arrayContaining([
        { id: ss[0]!.statementId, partnerId: a.partnerId, settlementAmount: 12_193_000, settlementDate: PAYOUT_DATE },
        { id: ss[1]!.statementId, partnerId: b.partnerId, settlementAmount: 3_456_789, settlementDate: PAYOUT_DATE },
      ]),
    );
    expect(posts).toHaveLength(2);
    const rows = await h.store.listPayouts(batchId);
    expect(rows.map((p) => [p.statementId, p.seq, p.refPayoutId, p.pgPayoutId, p.amount, p.status]).sort()).toEqual(
      [
        [ss[0]!.statementId, 1, `${ss[0]!.statementId}-1`, ss[0]!.statementId, 12_193_000, 'REQUESTED'],
        [ss[1]!.statementId, 1, `${ss[1]!.statementId}-1`, ss[1]!.statementId, 3_456_789, 'REQUESTED'],
      ].sort(),
    );
    for (const s of ss) {
      expect(h.store.statements.get(s.statementId)?.status).toBe('SCHEDULED');
      expect(events('PAYOUT_SCHEDULED', s.statementId).map((e) => e.value.amount)).toEqual([s.payoutAmount]);
    }
  });

  test('J-T41 ① 같은 아이디의 수기 정산건이 이미 있으면(앞선 시도가 만든 뒤 끊김) 조회로 확인만 하고, 다시 실행해도 요청·행·사건이 늘지 않는다', async () => {
    const a = partner();
    const b = partner();
    const { batchId, ss } = await approvedBatch([
      { P: a.P, amount: 12_193_000 },
      { P: b.P, amount: 3_456_789 },
    ]);
    // 앞선 시도가 첫 정산서의 수기 정산건만 만들고 끊겼다
    fake.transfers.set(ss[0]!.statementId, { id: ss[0]!.statementId, partnerId: a.partnerId, settlementAmount: 12_193_000, settlementDate: PAYOUT_DATE, status: 'SCHEDULED' });
    await h.settlements.executeBatch(batchId);
    expect(fake.transfers.size).toBe(2);
    expect(fake.calls('GET /platform/transfers/{id}').map((c) => c.path)).toEqual([`/platform/transfers/${ss[0]!.statementId}`]);
    const posts = fake.calls('POST /platform/transfers/manual').length;
    const rows = (await h.store.listPayouts(batchId)).length;
    const scheduled = events('PAYOUT_SCHEDULED').length;
    expect([rows, scheduled]).toEqual([2, 2]);
    // 같은 묶음을 다시 실행: 409든 그대로든 결제사 요청·행·사건이 늘지 않는다
    await h.settlements.executeBatch(batchId).catch(() => undefined);
    expect(fake.calls('POST /platform/transfers/manual')).toHaveLength(posts);
    expect(await h.store.listPayouts(batchId)).toHaveLength(rows);
    expect(events('PAYOUT_SCHEDULED')).toHaveLength(scheduled);
  });

  test('J-T41 ① 같은 아이디의 수기 정산건이 금액이 다르면 502로 멈추고 그 정산서의 지급 건·SCHEDULED·사건을 쓰지 않는다', async () => {
    const a = partner();
    const { batchId, ss } = await approvedBatch([{ P: a.P, amount: 12_193_000 }]);
    fake.transfers.set(ss[0]!.statementId, { id: ss[0]!.statementId, partnerId: a.partnerId, settlementAmount: 12_193_001, settlementDate: PAYOUT_DATE, status: 'SCHEDULED' });
    await expect(h.settlements.executeBatch(batchId)).rejects.toMatchObject({ status: 502 });
    expect(await h.store.listPayouts(batchId)).toEqual([]);
    expect(h.store.statements.get(ss[0]!.statementId)?.status).toBe('CONFIRMED');
    expect(events('PAYOUT_SCHEDULED')).toEqual([]);
  });
});

describe('J-T41 ② 지급일 09:00 KST 실행 건', () => {
  async function submitted(): Promise<{ batchId: string; ok: StatementRecord; hold: StatementRecord; pending: StatementRecord; stopped: StatementRecord }> {
    const okP = partner();
    // 보류 끝이 지급일 09:00 KST보다 1ms 뒤(아직 보류)
    const holdP = partner({ holdUntil: NINE_KST + 1 });
    const pendingP = partner({ agencySyncPending: true });
    const stoppedP = partner();
    const stoppedEvent = randomUUID();
    const { batchId, ss } = await approvedBatch([
      { P: okP.P, amount: 1_000_001 },
      { P: holdP.P, amount: 2_000_002 },
      { P: pendingP.P, amount: 3_000_003 },
      { P: stoppedP.P, amount: 4_000_004, eventId: stoppedEvent },
    ]);
    await execute(batchId);
    suspended.ids.add(stoppedEvent);
    const by = (P: string) => ss.find((s) => s.promoterId === P)!;
    return { batchId, ok: by(okP.P), hold: by(holdP.P), pending: by(pendingP.P), stopped: by(stoppedP.P) };
  }

  test('J-T41 ② 08:59:59.999 KST에는 실행 건이 없고 09:00 KST에 PORTONE_PAYOUT_EXECUTION 한 건(대상 = 묶음 ID)이 생긴다(정산 일꾼 tick)', async () => {
    const { batchId } = await submitted();
    const worker = new SettlementDueWorker({ settlements: h.settlements, leader: { isLeader: () => true }, clock: h.clock });
    at(BEFORE_NINE);
    await worker.tick(false);
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_PAYOUT_EXECUTION')).toEqual([]);
    at(NINE_KST);
    await worker.tick(false);
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_PAYOUT_EXECUTION')).toEqual([expect.objectContaining({ eventKey: `portone-execution:${batchId}`, sourceId: batchId })]);
    // 같은 날 다시 돌아도 건은 하나다
    at(NINE_KST + 30 * 60_000);
    await worker.tick(false);
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_PAYOUT_EXECUTION')).toHaveLength(1);
  });

  test('J-T41 ② 계좌 변경 보류·결제사 수정 대기·판매 중지 정산서는 수기 정산건을 취소하고 HELD·그 사유이며 실행 건의 뺀 목록에 실린다', async () => {
    const x = await submitted();
    at(NINE_KST);
    await expect(h.settlements.preparePortoneExecution(PAYOUT_DATE)).resolves.toEqual({ cases: 1, held: 3, halted: false });
    expect(h.store.statements.get(x.ok.statementId)).toMatchObject({ status: 'SCHEDULED', holdReason: null });
    expect(h.store.statements.get(x.hold.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_CHANGE' });
    expect(h.store.statements.get(x.pending.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_CHANGE' });
    expect(h.store.statements.get(x.stopped.statementId)).toMatchObject({ status: 'HELD', holdReason: 'SALE_SUSPENDED' });
    expect(fake.calls('DELETE /platform/transfers/{id}').map((c) => c.path).sort()).toEqual([x.hold, x.pending, x.stopped].map((s) => `/platform/transfers/${s.statementId}`).sort());
    expect(fake.transfers.get(x.ok.statementId)?.status).toBe('SCHEDULED');
    for (const s of [x.hold, x.pending, x.stopped]) {
      expect(events('PAYOUT_HELD', s.statementId).map((e) => e.value.amount)).toEqual([s.payoutAmount]);
      expect((await h.store.listPayouts(x.batchId)).filter((p) => p.statementId === s.statementId).map((p) => p.status)).toEqual(['CANCELED']);
    }
    // 묶음 상태는 바꾸지 않는다(부분 유일 인덱스와 부딪치지 않게)
    expect(h.store.batches.get(x.batchId)?.status).toBe('SUBMITTED');
    // 같은 날 두 번 불러도 건·보류·사건이 늘지 않는다
    await expect(h.settlements.preparePortoneExecution(PAYOUT_DATE)).resolves.toMatchObject({ cases: 0, held: 0 });
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_PAYOUT_EXECUTION')).toHaveLength(1);
    expect(events('PAYOUT_HELD')).toHaveLength(3);
    // 실행 건의 detail(계획 §5.1 (타) 결정 2): '뺀 정산서: {정산서 ID}({사유}), …'. 같은 글이 settlement_case_request에 남고 ops 본문 detail 칸으로 간다
    const request = [...h.store.caseRequests.values()].find((c) => c.eventKey === `portone-execution:${x.batchId}`)!;
    expect(request.detail).toMatch(/^뺀 정산서: /);
    for (const [s, reason] of [[x.hold, 'ACCOUNT_CHANGE'], [x.pending, 'ACCOUNT_CHANGE'], [x.stopped, 'SALE_SUSPENDED']] as const) expect(request.detail).toContain(`${s.statementId}(${reason})`);
    expect(request.detail).not.toContain(x.ok.statementId);
    expect(request.detail).not.toContain('commander 확인 필요');
    await h.settlements.retryPayoutCases();
    const sent = ops.cases.filter((c) => c.eventKey === `portone-execution:${x.batchId}`);
    expect(sent.map((c) => [c.kind, c.sourceId, c.detail])).toEqual([['PORTONE_PAYOUT_EXECUTION', x.batchId, request.detail]]);
  });

  test('J-T41 ② 뺀 정산서 45건이면 실행 건 detail은 2,000자 이하·꼬리 외 M건이고 보류 45건은 모두 쓰인다(계획 §5.1 (파) (나), TR-09)', async () => {
    const items = Array.from({ length: 46 }, (_v, i) => ({ P: partner(i === 0 ? {} : { agencySyncPending: true }).P, amount: 100_000 + i }));
    const { batchId, ss } = await approvedBatch(items);
    await execute(batchId);
    at(NINE_KST);
    await expect(h.settlements.preparePortoneExecution(PAYOUT_DATE)).resolves.toEqual({ cases: 1, held: 45, halted: false });
    const held = ss.filter((s) => h.store.statements.get(s.statementId)?.status === 'HELD');
    expect(held).toHaveLength(45);
    expect(events('PAYOUT_HELD')).toHaveLength(45);
    const request = [...h.store.caseRequests.values()].find((c) => c.eventKey === `portone-execution:${batchId}`)!;
    const detail = request.detail ?? '';
    expect([...detail].length).toBeLessThanOrEqual(2_000);
    const m = / 외 (\d+)건\(전체는 SCR-049 묶음 상세\)$/u.exec(detail);
    expect(m).not.toBeNull();
    expect(detail.startsWith('뺀 정산서 45건: ')).toBe(true);
    const shown = detail.slice('뺀 정산서 45건: '.length, m!.index).split(', ');
    expect(shown.length + Number(m![1])).toBe(45);
  });

  test('J-T41 ② 보류 끝이 지급일 09:00 KST와 같으면(이미 끝남) 빼지 않는다', async () => {
    const P = partner({ holdUntil: NINE_KST });
    const { batchId, ss } = await approvedBatch([{ P: P.P, amount: 5_000_000 }]);
    await execute(batchId);
    at(NINE_KST);
    await expect(h.settlements.preparePortoneExecution(PAYOUT_DATE)).resolves.toEqual({ cases: 1, held: 0, halted: false });
    expect(h.store.statements.get(ss[0]!.statementId)?.status).toBe('SCHEDULED');
  });

  test('J-T41 ② 지급일이 아닌 날·토스 묶음에는 실행 건을 만들지 않는다', async () => {
    const P = partner();
    const { batchId } = await approvedBatch([{ P: P.P, amount: 5_000_000 }]);
    await execute(batchId);
    // 시계는 앞으로만 간다: 실행(12-01 15:00 KST) 뒤의 지급일이 아닌 날(12-03) 09:00 KST에 부른다(시험 이의 TO-01)
    at(NINE_KST + 86_400_000);
    await expect(h.settlements.preparePortoneExecution('2026-12-03')).resolves.toEqual({ cases: 0, held: 0, halted: false });
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PORTONE_PAYOUT_EXECUTION')).toEqual([]);
  });
});

describe('J-T41 ③ 30분 지급 내역 동기화', () => {
  async function recorded(n: number): Promise<{ batchId: string; ss: StatementRecord[] }> {
    const items = Array.from({ length: n }, (_v, i) => ({ P: partner().P, amount: 1_000_000 + i * 111 }));
    const out = await approvedBatch(items);
    await execute(out.batchId);
    at(NINE_KST + 3_600_000);
    await h.settlements.recordPortoneExecution(out.batchId, 'bulk-f077-1');
    return out;
  }

  test('J-T41 ③·J-T9 SUCCEEDED는 COMPLETED·PAID·PAYOUT_COMPLETED 한 건, FAILED·STOPPED·CANCELLED는 FAILED·FAILED·PAYOUT_FAILED·CS PAYOUT_FAILED 한 건씩이고 자동 재요청이 0번이다', async () => {
    const { batchId, ss } = await recorded(5);
    const [s1, s2, s3, s4, s5] = ss as [StatementRecord, StatementRecord, StatementRecord, StatementRecord, StatementRecord];
    const done = '2026-12-02T02:10:00.000Z';
    fake.payouts.push(
      { id: 'po-1', bulkPayoutId: 'bulk-f077-1', transferId: s1.statementId, status: 'SUCCEEDED', completedAt: done, failureCode: null },
      { id: 'po-2', bulkPayoutId: 'bulk-f077-1', transferId: s2.statementId, status: 'FAILED', completedAt: null, failureCode: 'INVALID_ACCOUNT' },
      { id: 'po-3', bulkPayoutId: 'bulk-f077-1', transferId: s3.statementId, status: 'STOPPED', completedAt: null, failureCode: null },
      { id: 'po-4', bulkPayoutId: 'bulk-f077-1', transferId: s4.statementId, status: 'CANCELLED', completedAt: null, failureCode: null },
      { id: 'po-5', bulkPayoutId: 'bulk-f077-1', transferId: s5.statementId, status: 'PENDING', completedAt: null, failureCode: null },
    );
    const postsBefore = fake.calls('POST /platform/transfers/manual').length;
    await expect(h.settlements.syncPortonePayouts()).resolves.toEqual({ applied: 4 });
    const rows = await h.store.listPayouts(batchId);
    const statusBy = (s: StatementRecord) => rows.filter((p) => p.statementId === s.statementId).map((p) => p.status);
    expect(statusBy(s1)).toEqual(['COMPLETED']);
    expect(h.store.statements.get(s1.statementId)?.status).toBe('PAID');
    expect(events('PAYOUT_COMPLETED', s1.statementId).map((e) => e.value.amount)).toEqual([s1.payoutAmount]);
    for (const s of [s2, s3, s4]) {
      expect(statusBy(s)).toEqual(['FAILED']);
      expect(h.store.statements.get(s.statementId)?.status).toBe('FAILED');
      expect(events('PAYOUT_FAILED', s.statementId)).toHaveLength(1);
    }
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PAYOUT_FAILED')).toHaveLength(3);
    expect(statusBy(s5)).toEqual(['REQUESTED']);
    expect(h.store.statements.get(s5.statementId)?.status).toBe('SCHEDULED');
    // 자동 재요청 0번: 새 지급 건도 새 수기 정산건도 없다
    expect(rows).toHaveLength(5);
    expect(fake.calls('POST /platform/transfers/manual')).toHaveLength(postsBefore);
    // 같은 지급 내역을 두 번 읽어도 한 번만 바뀐다
    await expect(h.settlements.syncPortonePayouts()).resolves.toEqual({ applied: 0 });
    expect(events('PAYOUT_COMPLETED')).toHaveLength(1);
    expect(events('PAYOUT_FAILED')).toHaveLength(3);
    expect([...h.store.caseRequests.values()].filter((c) => c.kind === 'PAYOUT_FAILED')).toHaveLength(3);
    expect(fake.calls('GET /platform/payouts').every((c) => c.query.bulkPayoutId === 'bulk-f077-1')).toBe(true);
  });

  test('J-T41 ③ 지급 건이 모두 끝나면 묶음이 COMPLETED(모두 성공)·PARTIAL_FAILED(하나라도 실패)가 된다', async () => {
    const ok = await recorded(2);
    fake.payouts.push(...ok.ss.map((s, i) => ({ id: `po-ok-${i}`, bulkPayoutId: 'bulk-f077-1', transferId: s.statementId, status: 'SUCCEEDED' as const, completedAt: '2026-12-02T02:10:00.000Z', failureCode: null })));
    await h.settlements.syncPortonePayouts();
    expect(h.store.batches.get(ok.batchId)?.status).toBe('COMPLETED');
  });

  test('J-T41 ③ 하나라도 실패한 묶음은 PARTIAL_FAILED다', async () => {
    const mixed = await recorded(2);
    fake.payouts.push(
      { id: 'po-a', bulkPayoutId: 'bulk-f077-1', transferId: mixed.ss[0]!.statementId, status: 'SUCCEEDED', completedAt: '2026-12-02T02:10:00.000Z', failureCode: null },
      { id: 'po-b', bulkPayoutId: 'bulk-f077-1', transferId: mixed.ss[1]!.statementId, status: 'FAILED', completedAt: null, failureCode: 'X' },
    );
    await h.settlements.syncPortonePayouts();
    expect(h.store.batches.get(mixed.batchId)?.status).toBe('PARTIAL_FAILED');
  });

  test('J-T41 ③ 30분 tick이 동기화를 부른다(일꾼 tick 한 번에 SUCCEEDED가 PAID)', async () => {
    const { ss } = await recorded(1);
    fake.payouts.push({ id: 'po-1', bulkPayoutId: 'bulk-f077-1', transferId: ss[0]!.statementId, status: 'SUCCEEDED', completedAt: '2026-12-02T02:10:00.000Z', failureCode: null });
    const worker = new SettlementDueWorker({ settlements: h.settlements, leader: { isLeader: () => true }, clock: h.clock });
    await worker.tick(false);
    expect(h.store.statements.get(ss[0]!.statementId)?.status).toBe('PAID');
  });
});

describe('J-T41 ④ 포트원 플랫폼이 꺼진 조립', () => {
  test('J-T41 ④·J-T9 꺼지면 실행은 지금처럼 SUBMITTED·일괄 지급 기록만 받고 수기 정산건·지급 내역 호출이 0번이다', async () => {
    h = harness({ now: EXECUTED_AT, ops, gateways: manualGateways() });
    const P = partner();
    const { batchId, ss } = await approvedBatch([{ P: P.P, amount: 6_000_000 }]);
    expect((await h.settlements.executeBatch(batchId)).status).toBe('SUBMITTED');
    expect(await h.store.listPayouts(batchId)).toEqual([expect.objectContaining({ statementId: ss[0]!.statementId, refPayoutId: `${ss[0]!.statementId}-1`, pgPayoutId: null, amount: 6_000_000 })]);
    expect((await h.settlements.recordPortoneExecution(batchId, 'bulk-manual')).status).toBe('SUBMITTED');
    await expect(h.settlements.syncPortonePayouts()).resolves.toEqual({ applied: 0 });
    at(NINE_KST);
    await h.settlements.preparePortoneExecution(PAYOUT_DATE);
    expect(fake.requests).toEqual([]);
  });
});
