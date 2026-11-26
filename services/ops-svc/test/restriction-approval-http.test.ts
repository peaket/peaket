// F-06-4 일반 남용 예매 제한의 승인·집행·다시 보내기 HTTP 시험(시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §3.2·§7.2·§7.4, POL-038 ⑤, R-T13·R-T34, openapi /v1/ops/approval-requests*.
// 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다. 시각은 2026-11-26이 아닌 시험 달력(2026-11-20 금 23:30 KST)에서 센다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { approvedRestriction, caseRequest, nextYear, NOW_MS, problemType, restrictionBody, restrictionHarness, type RestrictionHarness } from './restriction-support.js';

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
  h.audit.entries.length = 0;
  h.recover();
});

const AGENT_REASON = '같은 공연 표를 반복해 사고 취소했다-시험7731';

describe('R-T13 일반 남용 예매 제한', () => {
  test('R-T13 시스템 표시(ABUSE_FLAG)만으로는 제한 행·사본이 0이다', async () => {
    const r = await h.intake(caseRequest('ABUSE_FLAG', { category: 'ABUSE_CANCEL' }));
    expect([r.status, r.body.accepted]).toEqual([202, true]);
    expect(h.kit().rows()).toEqual([]);
    expect(h.copies).toEqual([]);
  });

  test('R-T13 cs_agent 요청은 201이고 요청자 포함 2인·승인자는 요청자가 아닌 cs_lead뿐이며 아직 집행하지 않는다', async () => {
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const account = randomUUID();
    const created = await h.create(agent, restrictionBody({ accountId: account }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'BOOKING_RESTRICTION', requiredApprovals: 2, status: 'PENDING_APPROVAL' });
    expect(created.body.canApprove).toBe(false);
    expect((await h.get(lead, String(created.body.approvalId))).body.canApprove).toBe(true);
    expect(h.kit().rows()).toEqual([]);
    expect(h.copies).toEqual([]);
  });

  test('R-T13 cs_lead 승인 → ACTIVE 한 행·소명 기한 시작+1일·queue→purchase→view 사본·DONE', async () => {
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const account = randomUUID();
    const endsAt = Date.parse('2027-02-03T10:00:00.000Z');
    const created = await h.create(agent, restrictionBody({ accountId: account, endsAtMs: endsAt }));
    const approved = await h.approve(lead, String(created.body.approvalId), Number(created.body.version));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('DONE');

    const rows = h.kit().rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: account, reasonCode: 'ABUSE_CANCEL', status: 'ACTIVE', endsAtMs: endsAt, version: 1 });
    expect(Number(rows[0]!.appealDueAtMs) - Number(rows[0]!.startsAtMs)).toBe(86_400_000);
    expect(Number(rows[0]!.startsAtMs)).toBe(NOW_MS);
    expect(rows[0]!.confirmedBy).not.toBe('');

    expect(h.copies.map((c) => c.target)).toEqual(['queue', 'purchase', 'view']);
    for (const c of h.copies) {
      expect(c.input).toMatchObject({
        accountId: account,
        restrictionId: rows[0]!.restrictionId,
        state: 'ACTIVE',
        endsAtMs: endsAt,
        version: 1,
      });
    }
    expect(h.copies[2]!.input).toMatchObject({ reasonCode: 'ABUSE_CANCEL', startsAtMs: NOW_MS, appealDueAtMs: Number(rows[0]!.appealDueAtMs) });

    const audited = h.audit.entries.map((e) => e.recordType);
    expect(audited).toEqual(expect.arrayContaining(['APPROVAL_APPROVED', 'APPROVAL_EXECUTING', 'APPROVAL_DONE', 'RESTRICTION_APPLIED']));
    expect(JSON.stringify(h.audit.entries)).not.toContain(AGENT_REASON);
  });

  test('R-T13 승인 전에는 두 집행 사본이 없어 입장·주문을 막는 값이 서지 않는다', async () => {
    const created = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID() }));
    expect(created.status).toBe(201);
    expect(h.copies).toEqual([]);
    expect(h.kit().rows()).toEqual([]);
  });
});

describe('R-T34 예매 제한 집행·해제의 엔진', () => {
  test('R-T34 ① FRAUD 사유 행도 queue→purchase 두 곳이 모두 반영돼야 DONE 자리에 선다', async () => {
    const account = randomUUID();
    const caseId = randomUUID();
    const r = await h.kit().applyFraud({ accountId: account, fraudCaseId: caseId, endsAtMs: Date.parse('2027-01-05T10:00:00.000Z'), confirmedBy: randomUUID() });
    expect(h.copies.map((c) => c.target)).toEqual(['queue', 'purchase', 'view']);
    expect(h.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ reasonCode: 'FRAUD', fraudCaseId: caseId, status: 'ACTIVE', version: 1 });
  });

  test('R-T34 ① purchase 사본이 실패하면 승인 업무는 DONE이 아니라 EXECUTING이고 queue 사본만 반영된다', async () => {
    h.failNext('purchase');
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const created = await h.create(agent, restrictionBody({ accountId: randomUUID() }));
    const approved = await h.approve(lead, String(created.body.approvalId), Number(created.body.version));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('EXECUTING');
    expect(h.copies.map((c) => c.target)).toEqual(['queue', 'purchase']);
    expect(h.kit().rows()[0]).toMatchObject({ status: 'ACTIVE' });
  });

  test('R-T34 ⑤ 실패한 사본을 다시 보내 성공하면 같은 판으로 DONE이 된다', async () => {
    h.failNext('purchase');
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const created = await h.create(agent, restrictionBody({ accountId: randomUUID() }));
    const approvalId = String(created.body.approvalId);
    expect((await h.approve(lead, approvalId, Number(created.body.version))).body.status).toBe('EXECUTING');
    const version = h.kit().rows()[0]!.version;
    h.recover();
    await h.tick();
    const after = await h.get(lead, approvalId);
    expect(after.body.status).toBe('DONE');
    const purchaseCalls = h.copies.filter((c) => c.target === 'purchase');
    expect(purchaseCalls.length).toBeGreaterThanOrEqual(2);
    expect(purchaseCalls.at(-1)!.input.version).toBe(version);
  });

  test('R-T34 ⑤ 처리 기한이 지나도 집행이 안 끝나면 FAILED와 승인 업무 실행 실패 건이 생긴다', async () => {
    h.failNext('purchase', 1000);
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const created = await h.create(agent, restrictionBody({ accountId: randomUUID() }));
    const approvalId = String(created.body.approvalId);
    expect((await h.approve(lead, approvalId, Number(created.body.version))).body.status).toBe('EXECUTING');
    h.clock.advance(8 * 86_400_000);
    await h.tick();
    const after = await h.get(lead, approvalId);
    expect(after.body.status).toBe('FAILED');
    const cases = await h.cs.store.list({ statuses: ['OPEN'], limit: 100 });
    expect(cases.some((c) => c.kind === 'APPROVAL_EXECUTION_FAILED' && c.category === 'BOOKING_RESTRICTION')).toBe(true);
  });

  test('R-T34 ⑥ 끝이 요청 + 1년 + 1ms면 422 restriction-too-long이고 승인 업무·행이 0이다', async () => {
    const r = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), endsAtMs: nextYear() + 1 }));
    expect(r.status).toBe(422);
    expect(problemType(r.body)).toBe('restriction-too-long');
    expect(h.kit().rows()).toEqual([]);
    expect(h.copies).toEqual([]);
  });

  test('R-T34 ⑥ 정확히 요청 + 1년은 201이고 집행된다', async () => {
    const r = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), endsAtMs: nextYear() }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  test('R-T34 ⑥ 끝나기 전 새 요청은 같은 계정의 다음 판이고 1년을 넘지 않는다', async () => {
    const account = randomUUID();
    const first = await approvedRestriction(h, { accountId: account });
    h.copies.length = 0;
    const second = await h.create(h.as('cs_agent'), restrictionBody({ accountId: account, endsAtMs: Date.parse('2027-03-01T10:00:00.000Z') }));
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await h.approve(h.as('cs_lead'), String(second.body.approvalId), Number(second.body.version))).body.status).toBe('DONE');
    const rows = h.kit().rows().filter((r) => r.accountId === account);
    expect(rows).toHaveLength(2);
    expect(Number(rows[1]!.version)).toBe(Number(first.version) + 1);
    expect(rows[1]!.status).toBe('ACTIVE');
  });

  test('R-T34 ⑥ 다른 종류에 restrictionEndsAt을 보내면 400 invalid-body다', async () => {
    const r = await h.create(h.as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: randomUUID(), amount: 1, reasonCode: 'X', reasonText: '사유', restrictionEndsAt: new Date(nextYear()).toISOString() });
    expect(r.status).toBe(400);
    expect(problemType(r.body)).toBe('invalid-body');
  });
});

describe('ASVS 경계', () => {
  test('ASVS v5.0.0-2.2.1 사유 코드 허용 목록 밖·끝 시각 없음·amount≠0은 400·422다', async () => {
    const agent = h.as('cs_agent');
    const badReason = await h.create(agent, restrictionBody({ accountId: randomUUID(), reasonCode: 'FRAUD' }));
    expect([badReason.status, problemType(badReason.body)]).toEqual([422, 'restriction-reason-not-allowed']);
    const unknown = await h.create(agent, restrictionBody({ accountId: randomUUID(), reasonCode: 'WHATEVER' }));
    expect([unknown.status, problemType(unknown.body)]).toEqual([422, 'restriction-reason-not-allowed']);
    const { restrictionEndsAt: _e, ...noEnd } = restrictionBody({ accountId: randomUUID() });
    const missing = await h.create(agent, noEnd);
    expect([missing.status, problemType(missing.body)]).toEqual([400, 'invalid-body']);
    const amount = await h.create(agent, restrictionBody({ accountId: randomUUID(), amount: 1000 }));
    expect([amount.status, problemType(amount.body)]).toEqual([400, 'invalid-body']);
  });

  test('ASVS v5.0.0-8.2.2 남의 승인 업무는 목록·상세에 없고 요청자 역할이 아니면 403이다', async () => {
    const agent = h.as('cs_agent');
    const created = await h.create(agent, restrictionBody({ accountId: randomUUID() }));
    expect(created.status).toBe(201);
    expect((await h.get(agent, String(created.body.approvalId))).status).toBe(200);
    const other = h.as('cs_agent');
    expect((await h.get(other, String(created.body.approvalId))).status).toBe(404);
    const asOperator = await h.create(h.as('operator'), restrictionBody({ accountId: randomUUID() }));
    expect(asOperator.status).toBe(403);
  });

  test('ASVS v5.0.0-16.3.2 승인·집행은 감사에 남고 사유 원문·계정은 감사에 싣지 않는다', async () => {
    const account = randomUUID();
    await approvedRestriction(h, { accountId: account });
    const text = JSON.stringify(h.audit.entries);
    expect(text).not.toContain(account);
    expect(text).not.toContain(AGENT_REASON);
    expect(h.audit.entries.map((e) => e.recordType)).toEqual(expect.arrayContaining(['APPROVAL_APPROVED', 'RESTRICTION_APPLIED']));
  });

  test('ASVS v5.0.0-16.5.3 없는 승인 업무 상세는 404 Problem 모양이다', async () => {
    const agent = h.as('cs_agent');
    const created = await h.create(agent, restrictionBody({ accountId: randomUUID() }));
    expect(created.status).toBe(201);
    const r = await h.get(agent, randomUUID());
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ status: 404 });
  });
});
