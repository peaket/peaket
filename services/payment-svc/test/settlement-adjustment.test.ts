// J-T36 정산서 수기 조정(payment 쪽)과 J-T12 0 이하 정산서(F-07-5 LCH-100, ADR-0368 결정 7~10, docs/features/settlement.md §4.3·§13).
// ops-svc가 부르는 내부 경로(등록·적용·반려)를 HTTP로 부르고, ops 승인 기록은 포트 AdjustmentApprovalVerifier의 짝 가짜로 준다.
// 기대값은 정본: 사유 코드 8종, 근거 메모 2,000자, 조정 가능 상태 NOTIFIED·DISPUTED·CONFIRMED, 다시 알림 1영업일, J-T12 70만 − 100만 = −30만.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { HttpAdjustmentApprovalVerifier, type StatementRecord, type StatementStatus, type VerifiedAdjustmentApproval } from '../src/modules/settlement/index.js';
import { approvedFacts, fact, settlementFlow, UUID_RE, type SettlementFlow } from './settlement-flow-support.js';

/** 2026-11-18(수) 10:00 KST */
const NOTIFY_AT = Date.parse('2026-11-18T01:00:00.000Z');
/** 통지 + 2영업일 */
const DUE_AT = Date.parse('2026-11-20T01:00:00.000Z');
/** 2026-11-19(목) 15:00 KST. + 1영업일 = 2026-11-20(금) 15:00 KST */
const APPLY_AT = Date.parse('2026-11-19T06:00:00.000Z');
const APPLY_DUE = '2026-11-20T06:00:00.000Z';

let flow: SettlementFlow | undefined;
afterEach(async () => {
  await flow?.close();
  flow = undefined;
});
const open = async () => (flow = await settlementFlow({ now: NOTIFY_AT }));

/** 판매 3,000만·환급 200만·10% → 지급 2,492만(J-T1) */
const notified = async (f: SettlementFlow, gross = 30_000_000, refund = 2_000_000) => {
  const promoterId = randomUUID();
  const eventId = randomUUID();
  await f.settlements.recordKyc(promoterId, 'VERIFIED');
  f.payments.set(eventId, 'TOSS', [fact({ amount: gross, cancelledAmount: refund, status: refund > 0 ? 'PARTIAL_CANCELED' : 'APPROVED' })]);
  return { ...(await f.settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' })), promoterId, eventId };
};
const force = async (f: SettlementFlow, statementId: string, patch: Partial<StatementRecord>) => {
  const s = await f.store.findStatementById(statementId);
  await f.store.saveStatement({ ...s!, ...patch });
};
const disputed = async (f: SettlementFlow, reasonCode: string) => {
  const s = await notified(f);
  const res = await f.dispute(s.promoterId, s.statementId, { reasonCode, ...(reasonCode === 'OTHER' ? { detail: '설명' } : {}) });
  expect(res.statusCode, res.payload).toBe(202);
  const [d] = await f.store.listDisputes(s.statementId);
  return { ...s, disputeId: d!.disputeId };
};

interface RegisterBody {
  approvalId?: string;
  amount: number;
  reasonCode: string;
  disputeId?: string;
  evidenceNote?: string;
  requestedBy?: string;
}
const register = (f: SettlementFlow, statementId: string, b: RegisterBody) =>
  f.internal(`/internal/v1/settlements/statements/${statementId}/adjustments`, { approvalId: b.approvalId ?? randomUUID(), requestedBy: b.requestedBy ?? randomUUID(), amount: b.amount, reasonCode: b.reasonCode, ...(b.disputeId !== undefined ? { disputeId: b.disputeId } : {}), ...(b.evidenceNote !== undefined ? { evidenceNote: b.evidenceNote } : {}) });
const apply = (f: SettlementFlow, approvalId: string) => f.internal(`/internal/v1/settlements/adjustments/${approvalId}/application`);
const voidIt = (f: SettlementFlow, approvalId: string) => f.internal(`/internal/v1/settlements/adjustments/${approvalId}/void`);

/** 등록하고 그 요청과 같은 ops 승인 기록을 둔다 */
const registered = async (f: SettlementFlow, statementId: string, b: RegisterBody) => {
  const approvalId = b.approvalId ?? randomUUID();
  const requestedBy = b.requestedBy ?? randomUUID();
  const res = await register(f, statementId, { ...b, approvalId, requestedBy });
  expect(res.statusCode, res.payload).toBe(201);
  f.adjustmentApprovals.rows.set(approvalId, approvedFacts({ approvalId, statementId, amount: b.amount, reasonCode: b.reasonCode, requestedBy, at: f.clock.now() }));
  return { approvalId, requestedBy };
};

const snapshot = async (f: SettlementFlow, statementId: string) => {
  const s = (await f.store.findStatementById(statementId))!;
  return { status: s.status, adjustmentAmount: s.adjustmentAmount ?? 0, payoutAmount: s.payoutAmount, events: f.store.outbox.filter((m) => m.value.statementId === statementId).length };
};

describe('J-T36 ② 요청 검사', () => {
  test('J-T36 ② 사유 코드 8종 밖은 400이고 조정 행이 생기지 않는다', async () => {
    const f = await open();
    const s = await notified(f);
    for (const reasonCode of ['PAYOUT_DATE', 'agreed_deduction', 'REFUND', '']) {
      const res = await register(f, s.statementId, { amount: -1_000, reasonCode, evidenceNote: '근거' });
      expect({ reasonCode, code: res.statusCode }).toEqual({ reasonCode, code: 400 });
    }
    expect(f.store.adjustments.size).toBe(0);
  });

  test('J-T36 ② 이의 코드는 그 정산서의 같은 코드 열린 이의가 있을 때만 받고, 없거나 코드·ID가 다르면 422다', async () => {
    const f = await open();
    const plain = await notified(f);
    expect((await register(f, plain.statementId, { amount: 10_000, reasonCode: 'GROSS_AMOUNT', disputeId: randomUUID() })).statusCode).toBe(422);
    const d = await disputed(f, 'COMMISSION');
    expect((await register(f, d.statementId, { amount: 10_000, reasonCode: 'GROSS_AMOUNT', disputeId: d.disputeId })).statusCode).toBe(422);
    expect((await register(f, d.statementId, { amount: 10_000, reasonCode: 'COMMISSION', disputeId: randomUUID() })).statusCode).toBe(422);
    expect((await register(f, d.statementId, { amount: 10_000, reasonCode: 'COMMISSION' })).statusCode).toBe(422);
    expect(f.store.adjustments.size).toBe(0);
    const ok = await register(f, d.statementId, { amount: 10_000, reasonCode: 'COMMISSION', disputeId: d.disputeId });
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(JSON.parse(ok.payload)).toMatchObject({ statementId: d.statementId, reasonCode: 'COMMISSION', disputeId: d.disputeId, amount: 10_000, status: 'PENDING', appliedAt: null });
  });

  test('J-T36 ② OTHER와 이의 없는 세 코드는 근거 메모가 없거나 2,001자면 422이고 2,000자는 받는다', async () => {
    const f = await open();
    const other = await disputed(f, 'OTHER');
    for (const evidenceNote of [undefined, '', '  ', '가'.repeat(2_001)]) {
      const res = await register(f, other.statementId, { amount: 1_000, reasonCode: 'OTHER', disputeId: other.disputeId, ...(evidenceNote === undefined ? {} : { evidenceNote }) });
      expect({ code: 'OTHER', len: evidenceNote?.length, status: res.statusCode }).toEqual({ code: 'OTHER', len: evidenceNote?.length, status: 422 });
    }
    for (const reasonCode of ['LEDGER_ERROR', 'CONTRACT_CORRECTION', 'AGREED_DEDUCTION']) {
      const s = await notified(f);
      for (const evidenceNote of [undefined, '', '가'.repeat(2_001)]) {
        const res = await register(f, s.statementId, { amount: -1_000, reasonCode, ...(evidenceNote === undefined ? {} : { evidenceNote }) });
        expect({ reasonCode, len: evidenceNote?.length, status: res.statusCode }).toEqual({ reasonCode, len: evidenceNote?.length, status: 422 });
      }
      expect((await register(f, s.statementId, { amount: -1_000, reasonCode, evidenceNote: '가'.repeat(2_000) })).statusCode).toBe(201);
    }
    expect([...f.store.adjustments.values()].map((a) => a.reasonCode).sort()).toEqual(['AGREED_DEDUCTION', 'CONTRACT_CORRECTION', 'LEDGER_ERROR']);
  });

  test('J-T36 ② 이의 없는 코드에 이의 ID를 붙이거나 금액이 0이면 422다', async () => {
    const f = await open();
    const d = await disputed(f, 'GROSS_AMOUNT');
    const s = await notified(f);
    expect((await register(f, s.statementId, { amount: -1_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정', disputeId: d.disputeId })).statusCode).toBe(422);
    expect((await register(f, s.statementId, { amount: 0, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정' })).statusCode).toBe(422);
    expect((await register(f, d.statementId, { amount: 0, reasonCode: 'GROSS_AMOUNT', disputeId: d.disputeId })).statusCode).toBe(422);
    expect(f.store.adjustments.size).toBe(0);
  });
});

describe('J-T36 ③ 조정할 수 없는 상태', () => {
  const blocked = ['SCHEDULED', 'PAID', 'FAILED', 'CARRIED_OVER', 'SUPERSEDED', 'HELD'] as const satisfies readonly StatementStatus[];

  test('[ASVS v5.0.0-2.3.4] J-T36 ③ SCHEDULED·PAID·FAILED·CARRIED_OVER·SUPERSEDED·HELD 정산서의 요청은 409 settlement-adjustment-not-allowed다', async () => {
    const f = await open();
    for (const status of blocked) {
      const s = await notified(f);
      await force(f, s.statementId, { status, holdReason: status === 'HELD' ? 'BALANCE' : null });
      const res = await register(f, s.statementId, { amount: -10_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의서 2026-11-18' });
      expect({ status, code: res.statusCode }).toEqual({ status, code: 409 });
      expect(JSON.parse(res.payload).type).toContain('settlement-adjustment-not-allowed');
    }
    expect(f.store.adjustments.size).toBe(0);
  });

  test('J-T36 ③ 등록 뒤 지급 요청 등으로 상태가 바뀌면 적용도 409이고 정산서·조정 행이 그대로다', async () => {
    const f = await open();
    for (const status of blocked) {
      const s = await notified(f);
      const { approvalId } = await registered(f, s.statementId, { amount: -10_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의서' });
      await force(f, s.statementId, { status, holdReason: status === 'HELD' ? 'BALANCE' : null });
      const before = await snapshot(f, s.statementId);
      const res = await apply(f, approvalId);
      expect({ status, code: res.statusCode }).toEqual({ status, code: 409 });
      expect(JSON.parse(res.payload).type).toContain('settlement-adjustment-not-allowed');
      expect(await snapshot(f, s.statementId)).toEqual(before);
      expect((await f.store.findAdjustmentByApproval(approvalId))?.status).toBe('PENDING');
    }
  });

  test('J-T36 ③ 적용 전 조정이 있는 정산서의 두 번째 요청은 409 settlement-adjustment-pending이다', async () => {
    const f = await open();
    const s = await notified(f);
    await registered(f, s.statementId, { amount: -10_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정' });
    const second = await register(f, s.statementId, { amount: -20_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의' });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.payload).type).toContain('settlement-adjustment-pending');
    expect([...f.store.adjustments.values()].filter((a) => a.statementId === s.statementId)).toHaveLength(1);
  });

  test('J-T36 ① 같은 승인 ID의 등록 재요청은 같은 행 하나다', async () => {
    const f = await open();
    const s = await notified(f);
    const approvalId = randomUUID();
    const requestedBy = randomUUID();
    const first = await register(f, s.statementId, { approvalId, requestedBy, amount: -10_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정' });
    const again = await register(f, s.statementId, { approvalId, requestedBy, amount: -10_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정' });
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(JSON.parse(again.payload).adjustmentId).toBe(JSON.parse(first.payload).adjustmentId);
    expect(f.store.adjustments.size).toBe(1);
  });
});

describe('J-T36 ④ ops 승인 기록 대조', () => {
  test('[ASVS v5.0.0-2.3.3] J-T36 ④ 승인 기록의 대상·금액·사유 코드·요청자·정족수·승인 시각·상태가 하나라도 어긋나면 409이고 아무것도 바뀌지 않는다', async () => {
    const f = await open();
    const s = await notified(f);
    const { approvalId, requestedBy } = await registered(f, s.statementId, { amount: -30_000, reasonCode: 'CONTRACT_CORRECTION', evidenceNote: '계약 수수료율 9%' });
    const good = f.adjustmentApprovals.rows.get(approvalId)!;
    const bad: [string, Partial<VerifiedAdjustmentApproval>][] = [
      ['다른 정산서', { targetRef: randomUUID() }],
      ['금액', { amount: -30_001 }],
      ['금액 부호', { amount: 30_000 }],
      ['사유 코드', { reasonCode: 'LEDGER_ERROR' }],
      ['요청자 다름', { requestedBy: randomUUID() }],
      ['요청자 = 승인자', { approvals: [requestedBy] }],
      ['승인자 없음', { approvals: [] }],
      ['정족수 1', { requiredApprovals: 1 }],
      ['정족수 3', { requiredApprovals: 3 }],
      ['승인 시각 없음', { approvedAt: null }],
      ['승인 대기', { status: 'PENDING_APPROVAL' }],
      ['반려', { status: 'REJECTED' }],
      ['철회', { status: 'WITHDRAWN' }],
      ['만료', { status: 'EXPIRED' }],
    ];
    const before = await snapshot(f, s.statementId);
    for (const [name, patch] of bad) {
      f.adjustmentApprovals.rows.set(approvalId, { ...good, ...patch });
      const res = await apply(f, approvalId);
      expect({ name, code: res.statusCode }).toEqual({ name, code: 409 });
      expect(await snapshot(f, s.statementId)).toEqual(before);
      expect((await f.store.findAdjustmentByApproval(approvalId))?.status).toBe('PENDING');
    }
    // ops에 승인 기록이 없으면(승인 ID만 있는 위조) 409
    f.adjustmentApprovals.rows.delete(approvalId);
    expect((await apply(f, approvalId)).statusCode).toBe(409);
    expect(await snapshot(f, s.statementId)).toEqual(before);
    // 승인 상태 APPROVED·EXECUTING은 받는다
    f.adjustmentApprovals.rows.set(approvalId, { ...good, status: 'APPROVED' });
    expect((await apply(f, approvalId)).statusCode).toBe(200);
  });

  test('J-T36 ④ ops가 답하지 않으면 503이고 정산서·조정 행이 그대로이며, ops가 돌아오면 같은 승인으로 적용된다', async () => {
    const f = await open();
    const s = await notified(f);
    const { approvalId } = await registered(f, s.statementId, { amount: -30_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정' });
    const before = await snapshot(f, s.statementId);
    f.adjustmentApprovals.failing = true;
    const res = await apply(f, approvalId);
    expect(res.statusCode).toBe(503);
    expect(await snapshot(f, s.statementId)).toEqual(before);
    expect((await f.store.findAdjustmentByApproval(approvalId))?.status).toBe('PENDING');
    f.adjustmentApprovals.failing = false;
    expect((await apply(f, approvalId)).statusCode).toBe(200);
    expect((await f.store.findAdjustmentByApproval(approvalId))?.status).toBe('APPLIED');
  });

  test('J-T36 ④(어댑터) ops 내부 GET으로 승인 기록을 읽고 404는 없음, 5xx·연결 실패·모양 위반은 503이다', async () => {
    const approvalId = randomUUID();
    const facts = { approvalId, kind: 'SETTLEMENT_ADJUSTMENT', targetRef: randomUUID(), amount: -30_000, reasonCode: 'LEDGER_ERROR', status: 'EXECUTING', requiredApprovals: 2, requestedBy: randomUUID(), approvals: [randomUUID()], approvedAt: new Date(NOTIFY_AT).toISOString() };
    const seen: { url: string; method: string; token: string | null }[] = [];
    const verifier = (reply: () => Response | Promise<Response>) =>
      new HttpAdjustmentApprovalVerifier('http://ops-svc:8080', 'internal-token', async (input, init) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, method: req.method, token: req.headers.get('x-peaket-internal-token') });
        return reply();
      });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    await expect(verifier(() => json(200, facts)).verify(approvalId)).resolves.toEqual(facts);
    expect(seen).toEqual([{ url: `http://ops-svc:8080/internal/v1/approval-requests/${approvalId}`, method: 'GET', token: 'internal-token' }]);
    await expect(verifier(() => json(404, { type: 'not-found' })).verify(approvalId)).resolves.toBeUndefined();
    await expect(verifier(() => json(500, {})).verify(approvalId)).rejects.toMatchObject({ status: 503 });
    await expect(verifier(() => json(200, { ...facts, kind: 'PAYOUT_BATCH' })).verify(approvalId)).rejects.toMatchObject({ status: 503 });
    await expect(verifier(() => json(200, { ...facts, amount: '-30000' })).verify(approvalId)).rejects.toMatchObject({ status: 503 });
    await expect(verifier(() => Promise.reject(new TypeError('fetch failed'))).verify(approvalId)).rejects.toMatchObject({ status: 503 });
  });
});

describe('J-T36 ⑤ 적용·반려', () => {
  test('[ASVS v5.0.0-2.3.3] J-T36 ⑤ 이의 인정 조정은 조정 행 APPLIED·조정 합계·지급액·이의 ADJUSTED·NOTIFIED(+1영업일)·감사·STATEMENT_NOTIFIED를 쓰고 계산 칸은 그대로다', async () => {
    const f = await open();
    const d = await disputed(f, 'COMMISSION');
    const { approvalId } = await registered(f, d.statementId, { amount: 500_000, reasonCode: 'COMMISSION', disputeId: d.disputeId });
    f.at(APPLY_AT);
    const res = await apply(f, approvalId);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const s = (await f.store.findStatementById(d.statementId))!;
    expect(s).toMatchObject({ status: 'NOTIFIED', grossAmount: 30_000_000, refundAmount: 2_000_000, commissionAmount: 2_800_000, commissionVat: 280_000, offsetAmount: 0, adjustmentAmount: 500_000, payoutAmount: 25_420_000 });
    expect(s.disputeDueAt?.toISOString()).toBe(APPLY_DUE);
    const a = (await f.store.findAdjustmentByApproval(approvalId))!;
    expect(a).toMatchObject({ status: 'APPLIED', amount: 500_000 });
    expect(a.appliedAt?.getTime()).toBe(APPLY_AT);
    const [dispute] = await f.store.listDisputes(d.statementId);
    expect(dispute).toMatchObject({ result: 'ADJUSTED' });
    expect(dispute!.resolvedAt?.getTime()).toBe(APPLY_AT);
    expect(f.store.statementAudits.filter((x) => x.statementId === d.statementId).at(-1)).toMatchObject({ fromStatus: 'DISPUTED', toStatus: 'NOTIFIED' });
    const events = f.store.outbox.filter((m) => m.value.statementId === d.statementId).map((m) => m.value);
    expect(events.map((e) => e.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_DISPUTED', 'STATEMENT_NOTIFIED']);
    expect(events[2]).toMatchObject({ salesAmount: 30_000_000, refundAmount: 2_000_000, feeAmount: 2_800_000, revision: 1, occurredAt: new Date(APPLY_AT).toISOString(), eventKey: expect.stringMatching(UUID_RE) });
    // 검증 보강 X-10(asyncapi SettlementEvent.eventKey, ADR-0052): 조정 적용 뒤 다시 알림은 처음 통지와 다른 사건이라 키가 다르다
    expect(events[2]!.eventKey).not.toBe(events[0]!.eventKey);
    expect(new Set(events.map((e) => e.eventKey)).size).toBe(events.length);

    // 같은 승인 ID를 다시 적용해도 조정 합계는 한 번만 바뀐다
    const callsBefore = f.adjustmentApprovals.calls;
    const again = await apply(f, approvalId);
    expect(again.statusCode).toBe(200);
    expect(await f.store.findStatementById(d.statementId)).toMatchObject({ adjustmentAmount: 500_000, payoutAmount: 25_420_000 });
    expect(f.store.outbox.filter((m) => m.value.statementId === d.statementId)).toHaveLength(3);
    expect(f.adjustmentApprovals.calls).toBe(callsBefore);
  });

  test('J-T36 ⑤ 이의 없는 조정은 CONFIRMED를 NOTIFIED(+1영업일)로 되돌리고(T18) 두 번째 조정은 합계에 더한다', async () => {
    const f = await open();
    const s = await notified(f);
    f.at(DUE_AT);
    await f.settlements.confirmDueStatements();
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('CONFIRMED');
    const first = await registered(f, s.statementId, { amount: -20_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 오류 정정' });
    // 2026-11-20(금) 10:00 KST + 1영업일 = 2026-11-23(월) 10:00 KST
    expect((await apply(f, first.approvalId)).statusCode).toBe(200);
    const after = (await f.store.findStatementById(s.statementId))!;
    expect(after).toMatchObject({ status: 'NOTIFIED', adjustmentAmount: -20_000, payoutAmount: 24_900_000 });
    expect(after.disputeDueAt?.toISOString()).toBe('2026-11-23T01:00:00.000Z');
    expect(f.store.statementAudits.filter((x) => x.statementId === s.statementId).at(-1)).toMatchObject({ fromStatus: 'CONFIRMED', toStatus: 'NOTIFIED' });
    const second = await registered(f, s.statementId, { amount: 5_000, reasonCode: 'CONTRACT_CORRECTION', evidenceNote: '수수료율 정정' });
    expect((await apply(f, second.approvalId)).statusCode).toBe(200);
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ adjustmentAmount: -15_000, payoutAmount: 24_905_000, grossAmount: 30_000_000, commissionAmount: 2_800_000 });
  });

  test('J-T36 ⑤ 반려하면 조정 행이 VOID이고 이의는 열린 채 남으며, 그 승인으로는 적용되지 않는다', async () => {
    const f = await open();
    const d = await disputed(f, 'REFUND_AMOUNT');
    const { approvalId } = await registered(f, d.statementId, { amount: 100_000, reasonCode: 'REFUND_AMOUNT', disputeId: d.disputeId });
    const res = await voidIt(f, approvalId);
    expect(res.statusCode).toBe(200);
    expect((await f.store.findAdjustmentByApproval(approvalId))?.status).toBe('VOID');
    expect((await f.store.listDisputes(d.statementId))[0]).toMatchObject({ result: null });
    expect(await f.store.findStatementById(d.statementId)).toMatchObject({ status: 'DISPUTED', adjustmentAmount: 0, payoutAmount: 24_920_000 });
    expect((await apply(f, approvalId)).statusCode).toBe(409);
    expect(await f.store.findStatementById(d.statementId)).toMatchObject({ status: 'DISPUTED', adjustmentAmount: 0 });
    // 반려 뒤에는 새 조정을 요청할 수 있다(적용 전 조정이 남지 않는다)
    expect((await register(f, d.statementId, { amount: 50_000, reasonCode: 'REFUND_AMOUNT', disputeId: d.disputeId })).statusCode).toBe(201);
  });
});

describe('J-T36 ⑧ 지급액 식 하나(리뷰 RV-02)', () => {
  // 정본 §4.1 지급액 칸·§4.3 '적용': 조정을 적용한 정산서의 지급액 = 계산 때 지급액 + 조정 합계, 지급을 늘리는 조정은 미수금을 만들지 않는다.
  test('J-T36 ⑧ 승인 100만 + 승인 뒤 전액 취소 200만 정산서(계산 지급 89만)에 +30만을 적용하면 119만이고 확정 때 미수금이 없다', async () => {
    const f = await open();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await f.settlements.recordKyc(promoterId, 'VERIFIED');
    f.payments.set(eventId, 'TOSS', [fact({ amount: 1_000_000, status: 'APPROVED' }), fact({ amount: 2_000_000, cancelledAmount: 2_000_000, status: 'CANCELED' })]);
    const s = await f.settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    // 정본 §4.1: 판매 300만 − 환급 200만 → 수수료 10만·부가세 1만·지급 89만
    expect(s).toMatchObject({ grossAmount: 3_000_000, refundAmount: 2_000_000, commissionAmount: 100_000, commissionVat: 10_000, payoutAmount: 890_000 });
    const calculatedPayout = s.payoutAmount;
    const { approvalId } = await registered(f, s.statementId, { amount: 300_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 오류 정정' });
    f.at(APPLY_AT);
    expect((await apply(f, approvalId)).statusCode).toBe(200);
    const after = (await f.store.findStatementById(s.statementId))!;
    expect(after.payoutAmount).toBe(calculatedPayout + 300_000);
    expect(after).toMatchObject({ payoutAmount: 1_190_000, adjustmentAmount: 300_000, grossAmount: 3_000_000, refundAmount: 2_000_000, commissionAmount: 100_000, commissionVat: 10_000 });
    f.at(Date.parse(APPLY_DUE));
    await f.settlements.confirmDueStatements();
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('CONFIRMED');
    expect(f.store.receivables.size).toBe(0);
  });

  test('J-T36 ⑧ 계산 지급액 500만 정산서에 +30만을 적용하면 530만(= 계산 지급액 + 조정 합)이다', async () => {
    flow = await settlementFlow({ now: NOTIFY_AT, commissionRateBp: 0 });
    const f = flow;
    const s = await notified(f, 5_000_000, 0);
    expect(s.payoutAmount).toBe(5_000_000);
    const { approvalId } = await registered(f, s.statementId, { amount: 300_000, reasonCode: 'CONTRACT_CORRECTION', evidenceNote: '수수료율 정정' });
    expect((await apply(f, approvalId)).statusCode).toBe(200);
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ payoutAmount: 5_300_000, adjustmentAmount: 300_000, grossAmount: 5_000_000 });
  });
});

describe('J-T36 ② 이의 중 정산서의 이의 없는 조정(리뷰 RV-07)', () => {
  // 정본 §4.3 '검사'(리뷰 반영으로 더함): 이의 없는 세 코드는 DISPUTED에 쓰지 않는다. 요청은 422, 요청 뒤 이의가 들어와 DISPUTED면 적용은 409 settlement-adjustment-not-allowed
  test('J-T36 ② DISPUTED 정산서에 LEDGER_ERROR·CONTRACT_CORRECTION·AGREED_DEDUCTION 요청은 각각 422이고 조정 행이 없다', async () => {
    const f = await open();
    const d = await disputed(f, 'GROSS_AMOUNT');
    for (const reasonCode of ['LEDGER_ERROR', 'CONTRACT_CORRECTION', 'AGREED_DEDUCTION']) {
      const res = await register(f, d.statementId, { amount: -10_000, reasonCode, evidenceNote: '근거 메모' });
      expect({ reasonCode, code: res.statusCode }).toEqual({ reasonCode, code: 422 });
      expect(JSON.parse(res.payload).type).toContain('settlement-adjustment-dispute-mismatch');
    }
    expect(f.store.adjustments.size).toBe(0);
  });

  test('J-T36 ② NOTIFIED에서 요청한 AGREED_DEDUCTION 뒤 이의가 들어오면 적용은 409 settlement-adjustment-not-allowed이고 조정 행·정산서가 그대로다', async () => {
    const f = await open();
    const s = await notified(f);
    const { approvalId } = await registered(f, s.statementId, { amount: -100_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의 차감' });
    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'OFFSET' })).statusCode).toBe(202);
    const before = await snapshot(f, s.statementId);
    const res = await apply(f, approvalId);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).type).toContain('settlement-adjustment-not-allowed');
    expect(await snapshot(f, s.statementId)).toEqual(before);
    expect(before).toMatchObject({ status: 'DISPUTED', adjustmentAmount: 0 });
    expect((await f.store.findAdjustmentByApproval(approvalId))?.status).toBe('PENDING');
    expect((await f.store.listDisputes(s.statementId))[0]).toMatchObject({ result: null });
  });
});

describe('J-T36 ⑦·J-T12 0 아래 정산서', () => {
  /** 판매 786,516원·수수료 10% → 수수료 78,651·부가세 7,865·지급 700,000원(J-T12의 70만 원) */
  const J_T12_GROSS = 786_516;

  test('J-T12 J-T36 ⑦ 70만 원 정산서에 AGREED_DEDUCTION −100만 원을 적용하면 −30만 원이고 1영업일 뒤 CARRIED_OVER·미수금 30만 원 한 행이다', async () => {
    const f = await open();
    const s = await notified(f, J_T12_GROSS, 0);
    expect(s.payoutAmount).toBe(700_000);
    const { approvalId } = await registered(f, s.statementId, { amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '파트너와 합의한 차감' });
    f.at(APPLY_AT);
    expect((await apply(f, approvalId)).statusCode).toBe(200);
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ status: 'NOTIFIED', payoutAmount: -300_000, adjustmentAmount: -1_000_000 });
    // 다시 알린 기한 전에는 확정하지 않는다
    f.at(Date.parse(APPLY_DUE) - 1);
    await f.settlements.confirmDueStatements();
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('NOTIFIED');
    expect(f.store.receivables.size).toBe(0);
    f.at(Date.parse(APPLY_DUE));
    await f.settlements.confirmDueStatements();
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ status: 'CARRIED_OVER', payoutAmount: -300_000 });
    const receivables = [...f.store.receivables.values()];
    expect(receivables).toEqual([expect.objectContaining({ promoterId: s.promoterId, pg: 'TOSS', cause: 'NEGATIVE_STATEMENT', amount: 300_000, remaining: 300_000, status: 'OPEN', sourceRef: `negative-statement:${s.statementId}` })]);
    const tail = f.store.outbox.filter((m) => m.value.statementId === s.statementId).map((m) => m.value);
    expect(tail.filter((e) => e.type === 'STATEMENT_CARRIED_OVER')).toHaveLength(1);
    expect(tail.filter((e) => e.type === 'RECEIVABLE_OPENED')).toEqual([expect.objectContaining({ amount: 300_000, pg: 'TOSS', promoterId: s.promoterId })]);
    // 지급 요청 없이 끝난다: 그 지급일의 묶음에 들지 않는다
    await expect(f.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: s.payoutDate!, actor: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(f.store.batches.size).toBe(0);
  });

  test('J-T36 ⑦ 같은 정산서를 겹쳐 확정해도 미수금은 한 행이다', async () => {
    const f = await open();
    const s = await notified(f, J_T12_GROSS, 0);
    const { approvalId } = await registered(f, s.statementId, { amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의 차감' });
    f.at(APPLY_AT);
    expect((await apply(f, approvalId)).statusCode).toBe(200);
    f.at(Date.parse(APPLY_DUE));
    await Promise.allSettled([f.settlements.confirmDue(s.statementId), f.settlements.confirmDue(s.statementId), f.settlements.confirmDueStatements()]);
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('CARRIED_OVER');
    expect([...f.store.receivables.values()].filter((r) => r.sourceRef === `negative-statement:${s.statementId}`)).toHaveLength(1);
    expect(f.store.outbox.filter((m) => m.value.statementId === s.statementId && m.value.type === 'RECEIVABLE_OPENED')).toHaveLength(1);
  });

  test('J-T36 ⑦ 보류를 푼 재확정(HELD → CONFIRMED)도 지급액이 0 아래면 CARRIED_OVER와 미수금을 만든다', async () => {
    const f = await open();
    const s = await notified(f, J_T12_GROSS, 0);
    const { approvalId } = await registered(f, s.statementId, { amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '합의 차감' });
    expect((await apply(f, approvalId)).statusCode).toBe(200);
    await force(f, s.statementId, { status: 'HELD', holdReason: 'BALANCE' });
    await f.settlements.reconfirmStatement(s.statementId, { actor: 'ops', evidence: { balanceConfirmed: true } });
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('CARRIED_OVER');
    expect([...f.store.receivables.values()]).toEqual([expect.objectContaining({ cause: 'NEGATIVE_STATEMENT', amount: 300_000 })]);
  });
});
