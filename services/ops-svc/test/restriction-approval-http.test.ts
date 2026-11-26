// F-06-4 일반 남용 예매 제한의 승인·집행·다시 보내기 HTTP 시험(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-01·TR-03·TR-10·TR-11·TR-12·TR-19·TR-21·TR-26 반영).
// 정본: docs/features/transfer-refund.md §3.2·§7.2·§7.4, POL-038 ⑤, R-T13, openapi /v1/ops/approval-requests*.
// FRAUD 이용 제한(R-T34)은 F-04-13 가지 몫이라 여기서 시험하지 않는다(계획 §1.2).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { caseRequest, nextYear, NOW_MS, problemType, restrictionBody, restrictionHarness, type RestrictionHarness } from './restriction-support.js';

let h: RestrictionHarness;
beforeEach(async () => {
  h = await restrictionHarness();
});
afterEach(async () => {
  await h?.close();
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
    expect(h.kit().rows().filter((r) => r.accountId === account)).toEqual([]);
    expect(h.copies).toEqual([]);
  });

  test('R-T13 cs_lead 승인 → ACTIVE 한 행·소명 기한 시작+1일·queue→purchase→view 사본·DONE·confirmed_by는 승인자다', async () => {
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const account = randomUUID();
    const endsAt = Date.parse('2027-02-03T10:00:00.000Z');
    const created = await h.create(agent, restrictionBody({ accountId: account, endsAtMs: endsAt }));
    const approved = await h.approve(lead, String(created.body.approvalId), Number(created.body.version));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('DONE');

    const rows = h.kit().rows().filter((r) => r.approvalId === created.body.approvalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: account, reasonCode: 'ABUSE_CANCEL', status: 'ACTIVE', endsAtMs: endsAt, version: 1, confirmedBy: lead['x-user-id'] });
    expect(Number(rows[0]!.appealDueAtMs) - Number(rows[0]!.startsAtMs)).toBe(86_400_000);
    expect(Number(rows[0]!.startsAtMs)).toBe(NOW_MS);

    expect(h.copies.map((c) => c.target)).toEqual(['queue', 'purchase', 'view']);
    for (const c of h.copies) {
      expect(c.input).toMatchObject({ accountId: account, restrictionId: rows[0]!.restrictionId, state: 'ACTIVE', endsAtMs: endsAt, version: 1 });
    }
    expect(h.copies[2]!.input).toMatchObject({ reasonCode: 'ABUSE_CANCEL', startsAtMs: NOW_MS, appealDueAtMs: Number(rows[0]!.appealDueAtMs) });

    const audited = h.audit.entries.map((e) => e.recordType);
    expect(audited).toEqual(expect.arrayContaining(['APPROVAL_APPROVED', 'APPROVAL_EXECUTING', 'APPROVAL_DONE', 'RESTRICTION_APPLIED']));
    expect(JSON.stringify(h.audit.entries)).not.toContain(AGENT_REASON);
    expect(JSON.stringify(h.audit.entries)).not.toContain(account);
  });

  test('R-T13 승인 전에는 두 집행 사본이 없어 입장·주문을 막는 값이 서지 않는다', async () => {
    const created = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID() }));
    expect(created.status).toBe(201);
    expect(h.copies).toEqual([]);
    expect(h.kit().rows()).toEqual([]);
  });

  test('R-T13 cs_lead가 직접 요청해도 같은 세션 승인은 403이고 다른 cs_lead 승인은 200이다', async () => {
    const lead1 = h.as('cs_lead');
    const lead2 = h.as('cs_lead');
    const created = await h.create(lead1, restrictionBody({ accountId: randomUUID() }));
    expect(created.status).toBe(201);
    const self = await h.approve(lead1, String(created.body.approvalId), Number(created.body.version));
    expect([self.status, problemType(self.body)]).toEqual([403, 'approval-self-not-allowed']);
    expect(h.copies).toEqual([]);
    const other = await h.approve(lead2, String(created.body.approvalId), Number(created.body.version));
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.status).toBe('DONE');
    expect(h.kit().rows()[0]).toMatchObject({ confirmedBy: lead2['x-user-id'] });
  });
});

describe('집행 실패·재시도·기한', () => {
  test('ASVS v5.0.0-8.3.1 화면용 사본만 실패하면 승인은 DONE이고 queue·purchase는 반영된다', async () => {
    h.failNext('view');
    const created = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID() }));
    const approved = await h.approve(h.as('cs_lead'), String(created.body.approvalId), Number(created.body.version));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('DONE');
    expect(h.copies.map((c) => [c.target, c.input.state])).toEqual([['queue', 'ACTIVE'], ['purchase', 'ACTIVE'], ['view', 'ACTIVE']]);
  });

  test('ASVS v5.0.0-8.3.1 purchase 사본이 실패하면 EXECUTING이고 1분 뒤 작업이 같은 판으로 다시 보내 DONE이 된다', async () => {
    h.failNext('purchase');
    const created = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID() }));
    const approvalId = String(created.body.approvalId);
    expect((await h.approve(h.as('cs_lead'), approvalId, Number(created.body.version))).body.status).toBe('EXECUTING');
    const version = h.kit().rows().find((r) => r.approvalId === approvalId)!.version;
    h.clock.advance(60_000 - 1);
    await h.tick();
    expect(h.copies.filter((c) => c.target === 'purchase')).toHaveLength(1);
    h.clock.advance(1);
    await h.tick();
    const after = await h.get(h.as('cs_lead'), approvalId);
    expect(after.body.status).toBe('DONE');
    const purchaseCalls = h.copies.filter((c) => c.target === 'purchase');
    expect(purchaseCalls).toHaveLength(2);
    expect(purchaseCalls.at(-1)!.input.version).toBe(version);
  });

  test('ASVS v5.0.0-2.3.3 처리 기한 1ms 전에는 EXECUTING, 정각에는 FAILED와 실행 실패 건 하나(targetRef=승인 ID)다', async () => {
    h.failNext('purchase', 1000);
    const created = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID() }));
    const approvalId = String(created.body.approvalId);
    const approved = await h.approve(h.as('cs_lead'), approvalId, Number(created.body.version));
    expect(approved.body.status).toBe('EXECUTING');
    const due = Date.parse(String(approved.body.dueAt));
    h.clock.advance(due - NOW_MS - 1);
    await h.tick();
    expect((await h.get(h.as('cs_lead'), approvalId)).body.status).toBe('EXECUTING');
    h.clock.advance(1);
    await h.tick();
    expect((await h.get(h.as('cs_lead'), approvalId)).body.status).toBe('FAILED');
    const cases = (await h.cs.store.list({ statuses: ['OPEN'], limit: 100 })).filter((c) => c.kind === 'APPROVAL_EXECUTION_FAILED' && c.category === 'BOOKING_RESTRICTION');
    expect(cases).toHaveLength(1);
    expect(cases[0]!.targetRef).toBe(approvalId);
    // IR-16: FAILED라도 처리 기한이 지났으면 다시 실행하지 않는다
    const failedRow = await h.get(h.as('cs_lead'), approvalId);
    const retry = await h.approve(h.as('cs_lead'), approvalId, Number(failedRow.body.version));
    expect([retry.status, problemType(retry.body)]).toEqual([409, 'approval-expired']);
  });
});

describe('ASVS 경계', () => {
  test('ASVS v5.0.0-2.2.1 끝이 요청 + 1년 + 1ms면 422 restriction-too-long, 정확히 1년은 201·승인 DONE이다', async () => {
    const tooLong = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), endsAtMs: nextYear() + 1 }));
    expect([tooLong.status, problemType(tooLong.body)]).toEqual([422, 'restriction-too-long']);
    expect(h.kit().rows()).toEqual([]);

    const exact = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), endsAtMs: nextYear() }));
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    const done = await h.approve(h.as('cs_lead'), String(exact.body.approvalId), Number(exact.body.version));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('DONE');
  });

  test('ASVS v5.0.0-2.2.1 과거 끝·amount≠0·끝 시각 없음은 400 invalid-body다', async () => {
    const past = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), endsAtMs: NOW_MS - 1 }));
    expect([past.status, problemType(past.body)]).toEqual([400, 'invalid-body']);
    const amount = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), amount: 1000 }));
    expect([amount.status, problemType(amount.body)]).toEqual([400, 'invalid-body']);
    const { restrictionEndsAt: _e, ...noEnd } = restrictionBody({ accountId: randomUUID() });
    const missing = await h.create(h.as('cs_agent'), noEnd);
    expect([missing.status, problemType(missing.body)]).toEqual([400, 'invalid-body']);
  });

  test('ASVS v5.0.0-2.2.1 다른 종류에 restrictionEndsAt을 보내면 그 이유로 400 invalid-body다', async () => {
    const r = await h.create(h.as('cs_agent'), {
      kind: 'MINOR_CONTRACT_CANCEL',
      targetRef: randomUUID(),
      amount: 0,
      reasonCode: 'MINOR',
      reasonText: '미성년자 계약 취소-시험7741',
      evidenceChecked: 'PHONE_VERIFICATION',
      restrictionEndsAt: new Date(nextYear()).toISOString(),
    });
    expect([r.status, problemType(r.body)]).toEqual([400, 'invalid-body']);
  });

  test('ASVS v5.0.0-2.2.1 사유 FRAUD는 일반 경로에서 422 restriction-reason-not-allowed, 모르는 값도 422다', async () => {
    const fraud = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), reasonCode: 'FRAUD' }));
    expect([fraud.status, problemType(fraud.body)]).toEqual([422, 'restriction-reason-not-allowed']);
    const unknown = await h.create(h.as('cs_agent'), restrictionBody({ accountId: randomUUID(), reasonCode: 'WHATEVER' }));
    expect([unknown.status, problemType(unknown.body)]).toEqual([422, 'restriction-reason-not-allowed']);
  });

  test('ASVS v5.0.0-8.2.2 남의 승인 업무는 상세에서 404이고 요청자 역할이 아니면 403이다', async () => {
    const agent = h.as('cs_agent');
    const created = await h.create(agent, restrictionBody({ accountId: randomUUID() }));
    expect(created.status).toBe(201);
    expect((await h.get(agent, String(created.body.approvalId))).status).toBe(200);
    expect((await h.get(h.as('cs_agent'), String(created.body.approvalId))).status).toBe(404);
    expect((await h.create(h.as('operator'), restrictionBody({ accountId: randomUUID() }))).status).toBe(403);
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
