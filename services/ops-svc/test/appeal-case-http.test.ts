// F-06-4 예매 제한 소명(CS 처리함 APPEAL) 판단·연결 시험(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-08·TR-09·TR-10·TR-14·TR-15·TR-17·TR-22·TR-23 반영).
// 정본: docs/features/transfer-refund.md §7.1·§7.2·§7.4, openapi /v1/ops/cases/{caseId}/restriction-appeal-decision, R-T13·R-T32 ①②③⑥.
// FRAUD 이용 제한(R-T34)은 F-04-13 가지 몫이라 여기서 시험하지 않는다(계획 §1.2). 사유 FRAUD 제한의 소명 연결(R-T32 ⑥)만 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { approvedRestriction, BD3, caseRequest, NOW_MS, problemType, restrictionHarness, type AppealSourceRecord, type RestrictionHarness } from './restriction-support.js';

let h: RestrictionHarness;
beforeEach(async () => {
  h = await restrictionHarness();
});
afterEach(async () => {
  await h?.close();
});

const source = (o: Partial<AppealSourceRecord> & { accountId: string; targetId: string }): AppealSourceRecord => ({
  appealId: randomUUID(),
  kind: 'RESTRICTION',
  body: '표를 사려고 했는데 제한되어 있습니다. 사정을 봐 주세요-시험7732',
  submittedAtMs: NOW_MS,
  ...o,
});

async function openAppeal(fx: AppealSourceRecord, category = 'RESTRICTION', extra: { dueBaseAt?: string } = {}) {
  h.appeals.set(fx.appealId, fx);
  const r = await h.intake(caseRequest('APPEAL', { sourceId: fx.appealId, category, ...(extra.dueBaseAt ? { dueBaseAt: extra.dueBaseAt } : {}) }));
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  expect(r.body.accepted).toBe(true);
  return String(r.body.caseId);
}

const seedFraudRestriction = (o: { accountId: string; fraudCaseId: string; appealDueAtMs?: number }): string => {
  const restrictionId = randomUUID();
  h.kit().seed({
    accountId: o.accountId,
    restrictionId,
    reasonCode: 'FRAUD',
    fraudCaseId: o.fraudCaseId,
    confirmedBy: randomUUID(),
    startsAtMs: NOW_MS - 3_600_000,
    endsAtMs: NOW_MS + 365 * 86_400_000,
    appealDueAtMs: o.appealDueAtMs ?? NOW_MS + 86_400_000,
    status: 'ACTIVE',
    version: 1,
  });
  return restrictionId;
};

describe('R-T32 ① 소명 접수와 CS 건', () => {
  test('R-T32 ① 예매 제한 소명은 APPEAL 건으로 열리고 처리 역할은 cs_lead·배정은 비움·3영업일·계정 병합 막기(OPEN, kind APPEAL)가 선다', async () => {
    const restriction = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: restriction.accountId, targetId: restriction.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ kind: 'APPEAL', category: 'RESTRICTION', targetRef: fx.appealId, status: 'OPEN', assignee: null });
    expect(c.body.resultDueAt).toBe(new Date(BD3).toISOString());
    expect(h.holds).toEqual([{ accountId: restriction.accountId, caseId, kind: 'APPEAL', state: 'OPEN', version: 1 }]);
    expect(h.events).toContain('hold:OPEN');
  });

  test('R-T32 ① 부정 예매 사건 소명(FRAUD_CASE)은 조사관을 담당으로 열고 사건 소명 기한(dueBaseAt)을 결과 기한으로 쓴다', async () => {
    const caseId = randomUUID();
    const investigator = randomUUID();
    h.investigators.set(caseId, investigator);
    const accountId = randomUUID();
    const due = '2026-11-30T09:00:00.000Z';
    const fx = source({ accountId, targetId: caseId, kind: 'FRAUD_CASE' });
    const opened = await openAppeal(fx, 'FRAUD_CASE', { dueBaseAt: due });
    const c = await h.caseGet(h.as('cs_lead'), opened);
    expect(c.body).toMatchObject({ kind: 'APPEAL', category: 'FRAUD_CASE', targetRef: fx.appealId, assignee: investigator, status: 'OPEN', resultDueAt: due });
    expect(h.holds[0]).toMatchObject({ kind: 'APPEAL', state: 'OPEN', accountId });
  });

  test('R-T32 ② 없는 제한 ID와 다른 계정의 실제 제한 ID로 낸 소명은 대상 아님으로 닫고 결과 INVALID를 남긴다', async () => {
    const owner = randomUUID();
    const other = await approvedRestriction(h, { accountId: owner });
    for (const targetId of [randomUUID(), other.restrictionId]) {
      const fx = source({ accountId: randomUUID(), targetId });
      const caseId = await openAppeal(fx);
      const c = await h.caseGet(h.as('cs_lead'), caseId);
      expect(c.body.status).toBe('RESOLVED');
      expect(String(c.body.resultNote)).toContain('대상');
      expect(h.results.filter((r) => r.appealId === fx.appealId)).toEqual([expect.objectContaining({ status: 'INVALID' })]);
      expect(h.notices.filter((n) => n.appealId === fx.appealId && n.event === 'INVALID')).toHaveLength(1);
      expect(h.holds.filter((x) => x.caseId === caseId).map((x) => [x.kind, x.state])).toEqual([['APPEAL', 'OPEN'], ['APPEAL', 'CLOSED']]);
    }
    expect(h.events.filter((e) => e === 'result:INVALID')).toHaveLength(2);
  });

  test('R-T32 ③ 소명 기한이 지난 예매 제한은 기한 경과로 닫고 결과 INVALID를 남긴다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    h.clock.advance(86_400_000 + 1);
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId, submittedAtMs: h.clock.now() });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    expect(c.body.status).toBe('RESOLVED');
    expect(String(c.body.resultNote)).toContain('기한');
    expect(h.results.filter((x) => x.appealId === fx.appealId)).toEqual([expect.objectContaining({ status: 'INVALID' })]);
    expect(h.notices.filter((n) => n.appealId === fx.appealId && n.event === 'INVALID')).toHaveLength(1);
  });

  test('R-T32 ① FRAUD_CASE 건에는 예매 제한 해제 결정 경로가 없다(409, 사본·결과 0)', async () => {
    const caseId = randomUUID();
    h.investigators.set(caseId, randomUUID());
    const fx = source({ accountId: randomUUID(), targetId: caseId, kind: 'FRAUD_CASE' });
    const opened = await openAppeal(fx, 'FRAUD_CASE');
    const c = await h.caseGet(h.as('cs_lead'), opened);
    const r = await h.decide(h.as('cs_lead'), opened, { decision: 'ACCEPT', reason: '해제-시험7742' }, Number(c.body.version));
    expect([r.status, problemType(r.body)]).toEqual([409, 'case-action-not-applicable']);
    expect(h.copies).toEqual([]);
    expect(h.results).toEqual([]);
  });
});

describe('R-T13 소명 판단(해제·유지)', () => {
  test('R-T13 소명 인정(ACCEPT) → queue·purchase·view LIFTED 뒤 결과 LIFTED·resultNote를 적고 건 해결·보류 CLOSE·알림', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const decided = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '사정이 확인되어 해제합니다-시험7733' }, Number(c.body.version));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.status).toBe('RESOLVED');
    expect(h.copies.map((x) => [x.target, x.input.state])).toEqual([['queue', 'LIFTED'], ['purchase', 'LIFTED'], ['view', 'LIFTED']]);
    expect(h.results).toEqual([expect.objectContaining({ appealId: fx.appealId, status: 'DECIDED', result: 'LIFTED', resultNote: '사정이 확인되어 해제합니다-시험7733' })]);
    expect(h.notices).toEqual(expect.arrayContaining([expect.objectContaining({ appealId: fx.appealId, event: 'DECIDED' })]));
    expect(h.holds.at(-1)).toMatchObject({ state: 'CLOSED' });
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'LIFTED' });
    // 두 사본 뒤에 결과를 적는다
    const view = h.events.indexOf('copy:view');
    const result = h.events.findIndex((e) => e.startsWith('result:'));
    expect(view).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(view);
  });

  test('R-T13 소명 기각(REJECT) → 사본 0, 결과 KEPT·resultNote, 건 해결·보류 CLOSE·알림, 제한 ACTIVE 그대로', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const decided = await h.decide(h.as('cs_lead'), caseId, { decision: 'REJECT', reason: '근거가 충분합니다-시험7734' }, Number(c.body.version));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.status).toBe('RESOLVED');
    expect(h.copies).toEqual([]);
    expect(h.results).toEqual([expect.objectContaining({ appealId: fx.appealId, status: 'DECIDED', result: 'KEPT', resultNote: '근거가 충분합니다-시험7734' })]);
    expect(h.notices).toEqual(expect.arrayContaining([expect.objectContaining({ appealId: fx.appealId, event: 'DECIDED' })]));
    expect(h.holds.at(-1)).toMatchObject({ kind: 'APPEAL', state: 'CLOSED' });
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'ACTIVE' });
  });

  test('ASVS v5.0.0-8.3.1 화면용 사본만 실패해도 해제는 RESOLVED·LIFTED이고 queue·purchase는 풀린다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    h.failNext('view');
    const decided = await h.decide(h.as('cs_lead'), caseId, { decision: 'ACCEPT', reason: '해제-시험7743' }, Number(c.body.version));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.status).toBe('RESOLVED');
    expect(h.copies.map((x) => [x.target, x.input.state])).toEqual([['queue', 'LIFTED'], ['purchase', 'LIFTED'], ['view', 'LIFTED']]);
    expect(h.results[0]).toMatchObject({ status: 'DECIDED', result: 'LIFTED' });
  });
});

describe('R-T32 ⑥ 사유 FRAUD 제한의 소명', () => {
  test('R-T32 ⑥ 사유 FRAUD 제한의 RESTRICTION 소명은 그 사건 조사관이 담당이고 cs_lead가 ACCEPT·REJECT로 결정하면 403이다', async () => {
    const accountId = randomUUID();
    const fraudCaseId = randomUUID();
    const investigator = randomUUID();
    h.investigators.set(fraudCaseId, investigator);
    const restrictionId = seedFraudRestriction({ accountId, fraudCaseId });
    const fx = source({ accountId, targetId: restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    expect(c.body.assignee).toBe(investigator);
    for (const decision of ['ACCEPT', 'REJECT']) {
      const r = await h.decide(h.as('cs_lead'), caseId, { decision, reason: '판단-시험7744' }, Number(c.body.version));
      expect([r.status, problemType(r.body)]).toEqual([403, 'fraud-restriction-requires-approval']);
    }
    expect(h.copies).toEqual([]);
    expect(h.results).toEqual([]);
    expect((await h.caseGet(h.as('cs_lead'), caseId)).body.status).toBe('OPEN');
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

  test('ASVS v5.0.0-15.4.2 같은 판으로 ACCEPT·REJECT를 동시에 보내면 하나만 200이고 결과·사본은 한 번이다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const c = await h.caseGet(h.as('cs_lead'), caseId);
    const lead = h.as('cs_lead');
    const [a, b] = await Promise.all([
      h.decide(lead, caseId, { decision: 'ACCEPT', reason: '해제-시험7745' }, Number(c.body.version)),
      h.decide(lead, caseId, { decision: 'REJECT', reason: '유지-시험7746' }, Number(c.body.version)),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === 409 || s === 412)).toHaveLength(1);
    expect(h.results).toHaveLength(1);
    const lifted = h.copies.filter((x) => x.input.state === 'LIFTED').length;
    expect(lifted).toBe(h.results[0]!.result === 'LIFTED' ? 3 : 0);
  });

  test('ASVS v5.0.0-3.5.3 소명 결정 경로는 GET을 받지 않는다', async () => {
    const r = await approvedRestriction(h, { accountId: randomUUID() });
    const fx = source({ accountId: r.accountId, targetId: r.restrictionId });
    const caseId = await openAppeal(fx);
    const before = await h.caseGet(h.as('cs_lead'), caseId);
    const got = await h.svc.http.inject({ method: 'GET', url: `/v1/ops/cases/${caseId}/restriction-appeal-decision`, headers: h.as('cs_lead') });
    expect([404, 405]).toContain(got.statusCode);
    expect((await h.caseGet(h.as('cs_lead'), caseId)).body.status).toBe('OPEN');
    expect((await h.caseGet(h.as('cs_lead'), caseId)).body.version).toBe(before.body.version);
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
