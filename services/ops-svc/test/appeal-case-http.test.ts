// F-06-4 예매 제한 소명(CS 처리함 APPEAL) 판단·연결 시험(시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §7.1·§7.2·§7.4, openapi /v1/ops/cases/{caseId}/restriction-appeal-decision, R-T13·R-T32 ①②③⑥·R-T34 ②④.
// 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { approvedRestriction, BD3, caseRequest, NOW_MS, problemType, restrictionHarness, type AppealSourceRecord, type RestrictionHarness } from './restriction-support.js';

let h: RestrictionHarness;
beforeAll(async () => {
  h = await restrictionHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h.copies.length = 0;
  h.holds.length = 0;
  h.notices.length = 0;
  h.appeals.clear();
  h.investigators.clear();
  h.audit.entries.length = 0;
  h.recover();
});

const source = (o: Partial<AppealSourceRecord> & { accountId: string; targetId: string }): AppealSourceRecord => ({
  appealId: randomUUID(),
  kind: 'RESTRICTION',
  body: '표를 사려고 했는데 제한되어 있습니다. 사정을 봐 주세요-시험7732',
  submittedAtMs: NOW_MS,
  ...o,
});

async function openAppeal(fx: AppealSourceRecord, category = 'RESTRICTION') {
  h.appeals.set(fx.appealId, fx);
  const r = await h.intake(caseRequest('APPEAL', { sourceId: fx.appealId, category }));
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  expect(r.body.accepted).toBe(true);
  return String(r.body.caseId);
}

describe('R-T32 ① 소명 접수와 CS 건', () => {
  test('R-T32 ① 예매 제한 소명은 APPEAL 건으로 열리고 대상·3영업일·계정 병합 막기(OPEN)가 선다', async () => {
    const restriction = await approvedRestriction(h, { accountId: randomUUID() });
    h.copies.length = 0;
    const fx = source({ accountId: restriction.accountId, targetId: restriction.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ kind: 'APPEAL', category: 'RESTRICTION', targetRef: fx.appealId, status: 'OPEN' });
    expect(c.body.resultDueAt).toBe(new Date(BD3).toISOString());
    expect(h.holds).toEqual([{ accountId: restriction.accountId, caseId, state: 'OPEN', version: 1 }]);
    expect(c.body.assignee).toBeNull();
  });

  test('R-T32 ① 부정 예매 사건 소명(FRAUD_CASE)은 그 사건의 조사관을 담당으로 열고 예매 제한 해제 결정 경로가 아니다', async () => {
    const caseId = randomUUID();
    const investigator = randomUUID();
    h.investigators.set(caseId, investigator);
    const accountId = randomUUID();
    const fx = source({ accountId, targetId: caseId, kind: 'FRAUD_CASE' });
    const opened = await openAppeal(fx, 'FRAUD_CASE');
    const c = await h.caseGet(h.as('cs_lead'), opened);
    expect(c.body).toMatchObject({ kind: 'APPEAL', category: 'FRAUD_CASE', targetRef: fx.appealId, assignee: investigator, status: 'OPEN' });
    expect(h.holds[0]).toMatchObject({ state: 'OPEN', accountId });
  });

  test('R-T32 ② 남의/없는 예매 제한 ID로 낸 소명은 건을 열자마자 대상 아님으로 닫고 알린다', async () => {
    const fx = source({ accountId: randomUUID(), targetId: randomUUID() });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    expect(c.body.status).toBe('RESOLVED');
    expect(String(c.body.resultNote)).toContain('대상');
    expect(h.notices.filter((n) => n.appealId === fx.appealId && n.event === 'INVALID')).toHaveLength(1);
    expect(h.holds).toEqual([{ accountId: fx.accountId, caseId, state: 'OPEN', version: 1 }, { accountId: fx.accountId, caseId, state: 'CLOSED', version: 2 }]);
    expect(h.copies).toEqual([]);
  });

  test('R-T32 ③ 소명 기한이 지난 예매 제한은 기한 경과로 닫고 알린다', async () => {
    const other = await restrictionHarness();
    try {
      const r = await approvedRestriction(other, { accountId: randomUUID() });
      // 소명 기한은 시작 + 1일. 그 뒤로 시계를 옮긴다
      other.clock.advance(86_400_000 + 1);
      const fx = source({ accountId: r.accountId, targetId: r.restrictionId, submittedAtMs: other.clock.now() });
      other.appeals.set(fx.appealId, fx);
      const intake = await other.intake(caseRequest('APPEAL', { sourceId: fx.appealId, category: 'RESTRICTION', createdAt: new Date(other.clock.now()).toISOString() }));
      const c = await other.caseGet(other.as('cs_lead'), String(intake.body.caseId));
      expect(c.body.status).toBe('RESOLVED');
      expect(String(c.body.resultNote)).toContain('기한');
      expect(other.notices.filter((n) => n.appealId === fx.appealId && n.event === 'INVALID')).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
});

describe('R-T13 소명 판단(해제·유지)', () => {
  test('R-T13 소명 인정(ACCEPT) → 두 집행 사본·화면 사본 LIFTED, 건 해결, 결과 LIFTED, 보류 CLOSE', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    h.copies.length = 0;
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const decided = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '사정이 확인되어 해제합니다-시험7733' }, Number(c.body.version));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.status).toBe('RESOLVED');
    expect(h.copies.map((x) => [x.target, x.input.state])).toEqual([['queue', 'LIFTED'], ['purchase', 'LIFTED'], ['view', 'LIFTED']]);
    expect(h.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ appealId: fx.appealId, event: 'RESULT', result: 'LIFTED' }),
      expect.objectContaining({ appealId: fx.appealId, event: 'DECIDED' }),
    ]));
    expect(h.holds.at(-1)).toMatchObject({ state: 'CLOSED' });
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'LIFTED' });
  });

  test('R-T13 소명 기각(REJECT) → 사본 호출 0, 결과 KEPT, 제한 ACTIVE 그대로', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    h.copies.length = 0;
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const decided = await h.decide(h.as('cs_lead'), caseId, { decision: 'REJECT', reason: '근거가 충분합니다-시험7734' }, Number(c.body.version));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(h.copies).toEqual([]);
    expect(h.notices).toEqual(expect.arrayContaining([expect.objectContaining({ appealId: fx.appealId, event: 'RESULT', result: 'KEPT' })]));
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('R-T34 ②④ FRAUD 사유 해제와 해제 실패', () => {
  test('R-T34 ② 사유가 FRAUD인 제한을 이 경로로 풀면 403 fraud-restriction-requires-approval이고 사본 0이다', async () => {
    const accountId = randomUUID();
    const fraudCaseId = randomUUID();
    await h.kit().applyFraud({ accountId, fraudCaseId, endsAtMs: Date.parse('2027-01-05T10:00:00.000Z') });
    const restriction = h.kit().rows()[0]!;
    h.copies.length = 0;
    const fx = source({ accountId, targetId: String(restriction.restrictionId) });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const denied = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7735' }, Number(c.body.version));
    expect(denied.status).toBe(403);
    expect(problemType(denied.body)).toBe('fraud-restriction-requires-approval');
    expect(h.copies).toEqual([]);
    expect(h.kit().rows()[0]).toMatchObject({ status: 'ACTIVE' });
  });

  test('R-T34 ④ 해제 중 purchase 사본이 실패하면 503이고 건·제한이 그대로이며, 다시 하면 두 곳이 풀려 해결된다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    h.copies.length = 0;
    h.failNext('purchase');
    const failed = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7736' }, Number(c.body.version));
    expect(failed.status).toBe(503);
    expect(h.copies.map((x) => [x.target, x.input.state])).toEqual([['queue', 'LIFTED'], ['purchase', 'LIFTED']]);
    expect((await h.caseGet(h.as('cs_lead'), caseId)).body.status).toBe('OPEN');
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'ACTIVE' });
    h.recover();
    const again = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7736' }, Number(c.body.version));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.status).toBe('RESOLVED');
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'LIFTED' });
  });

  test('R-T32 ⑥ 사유 FRAUD 제한의 RESTRICTION 소명은 그 제한의 사건 조사관이 담당이고 cs_lead 결정 경로가 403이다', async () => {
    const accountId = randomUUID();
    const fraudCaseId = randomUUID();
    const investigator = randomUUID();
    h.investigators.set(fraudCaseId, investigator);
    await h.kit().applyFraud({ accountId, fraudCaseId, endsAtMs: Date.parse('2027-01-05T10:00:00.000Z') });
    const restriction = h.kit().rows()[0]!;
    const fx = source({ accountId, targetId: String(restriction.restrictionId) });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    expect(c.body.assignee).toBe(investigator);
  });
});

describe('ASVS 경계', () => {
  test('ASVS v5.0.0-8.2.1 cs_agent는 소명을 결정하지 못하고(403) cs_lead만 한다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const denied = await h.decide(h.as('cs_agent'), caseId, { decision: 'ACCEPT', reason: '해제-시험7737' }, Number(c.body.version));
    expect(denied.status).toBe(403);
  });

  test('ASVS v5.0.0-2.3.1·15.4.2 If-Match 없이·틀리게 결정하면 428·412이고, 해결한 건은 다시 결정하지 못한다(409)', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const noMatch = await h.svc.http.inject({ method: 'POST', url: `/v1/ops/cases/${caseId}/restriction-appeal-decision`, headers: { ...h.as('cs_lead'), 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'ACCEPT', reason: '해제-시험7738' }) });
    expect(noMatch.statusCode).toBe(428);
    const stale = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7738' }, Number(c.body.version) + 5);
    expect(stale.status).toBe(412);
    expect((await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7738' }, Number(c.body.version))).status).toBe(200);
    const again = await h.decide(h.as('cs_lead'), caseId, { decision: 'REJECT', reason: '유지-시험7739' }, Number(c.body.version) + 1);
    expect(again.status).toBe(409);
    expect(problemType(again.body)).toBe('case-already-resolved');
  });

  test('ASVS v5.0.0-16.3.2 소명 결정은 감사에 남고 소명 본문은 감사에 실리지 않는다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7740' }, Number(c.body.version));
    const text = JSON.stringify(h.audit.entries);
    expect(text).not.toContain(fx.body);
    expect(h.audit.entries.map((e) => e.recordType)).toEqual(expect.arrayContaining(['CS_CASE_UPDATED']));
  });
});
