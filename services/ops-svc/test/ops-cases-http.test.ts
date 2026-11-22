// CS 처리함 목록·상세·갱신의 권한(F-06-2 GAT-280, R-T49 ①~⑥). 실제 ops-svc 조립(메모리 저장소)의 /v1/ops/cases 경로를 역할 다섯으로 부른다.
// 시험 담당 lane3-f062-test. 정본: docs/features/transfer-refund.md §11 R-T49(기대 결과 칸의 상태 코드·Problem 이름), ADR-0364 결정 5,
// openapi listOpsCases·getOpsCase·updateOpsCase(허용 역할, CsCase 칸), docs/api/guidelines.md '동시 수정'(If-Match·ETag),
// docs/security/asvs/transfer-refund.md 1.2.4·8.2.1·8.2.2·16.3.2 행과 'F-06-2 GAT-280 계획 메모'.
// 지급 건(PAYOUT_FAILED)은 받는 종류가 아니라 실제 조립의 저장소로 연다(그 생산자는 다른 기능). 정산 이의(STATEMENT_DISPUTE)는 F-07-5부터 받는 종류지만,
// 기한 값을 시험이 정해 넣으려고 같은 저장소로 연다.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BD1, BD3, caseRequest, csHarness, type CsHarness, type OpsRole } from './cs-support.js';

let h: CsHarness;
beforeEach(async () => {
  h = await csHarness();
});
afterEach(async () => {
  await h.close();
});

const typeOf = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';
/** openapi CsCase의 칸(이 밖의 칸, 곧 팬 이름·연락처·계좌 같은 칸이 응답에 없다) */
const CS_CASE_FIELDS = new Set(['caseId', 'kind', 'targetRef', 'progressDueAt', 'resultDueAt', 'status', 'category', 'assignee', 'version', 'dueState', 'createdAt', 'resolvedAt', 'resultNote']);

async function openDispute(): Promise<string> {
  const r = await h.intake(caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' }));
  expect(r.body.accepted).toBe(true);
  return r.body.caseId!;
}

describe('R-T49 ① 역할 다섯의 목록·상세 [ASVS v5.0.0-8.2.2]', () => {
  test('R-T49 ① CS 담당자 목록에는 지급·대사·KYC 건이 0건이고 그 상세는 없는 건과 같은 404, operator·commander는 모두, viewer는 403이다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.1]', async () => {
    const dispute = await openDispute();
    const payout = await h.seed('PAYOUT_FAILED', 'payout-batch-1');
    const statement = await h.seed('STATEMENT_DISPUTE', 'statement-1', { resultDueAtMs: Date.parse(BD3) });
    const kyc = await h.seed('SELLER_KYC_REQUIRED', 'seller-1');

    const idsOf = (b: Record<string, unknown>) => new Set((b.items as Array<{ caseId: string }>).map((i) => i.caseId));
    for (const role of ['cs_agent', 'cs_lead'] as const) {
      const list = await h.list(h.as(role), 'limit=100');
      expect([role, list.status]).toEqual([role, 200]);
      expect(idsOf(list.body), role).toEqual(new Set([dispute, statement]));
      // 지급 종류로 걸러도 오류가 아니라 0건이다
      expect((await h.list(h.as(role), 'kind=PAYOUT_FAILED')).body, role).toEqual({ items: [], nextCursor: null });
      const hidden = await h.get(h.as(role), payout);
      const missing = await h.get(h.as(role), '0194f062-0000-7000-8000-0000000fffff');
      expect([hidden.status, typeOf(hidden.body), hidden.body.title]).toEqual([404, typeOf(missing.body), missing.body.title]);
      expect(missing.status).toBe(404);
      expect((await h.get(h.as(role), kyc)).status).toBe(404);
      expect((await h.get(h.as(role), statement)).status).toBe(200);
    }
    for (const role of ['operator', 'commander'] as const) {
      const list = await h.list(h.as(role), 'limit=100');
      expect(idsOf(list.body), role).toEqual(new Set([dispute, payout, statement, kyc]));
      expect((await h.get(h.as(role), payout)).status, role).toBe(200);
      expect((await h.get(h.as(role), dispute)).status, role).toBe(200);
    }
    const viewer = h.as('viewer');
    expect([(await h.list(viewer)).status, (await h.get(viewer, dispute)).status, (await h.patch(viewer, dispute, { status: 'IN_PROGRESS' }, '"1"')).status]).toEqual([403, 403, 403]);

    // 응답에는 CsCase 칸만 있다(팬 이름·연락처·계좌 칸 없음)
    const all = (await h.list(h.as('commander'), 'limit=100')).body.items as Array<Record<string, unknown>>;
    for (const item of [...all, (await h.get(h.as('cs_agent'), dispute)).body]) {
      expect(Object.keys(item).filter((k) => !CS_CASE_FIELDS.has(k)), String(item.kind)).toEqual([]);
    }
  });
});

describe('R-T49 ② 배정 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', () => {
  test('R-T49 ② cs_agent가 다른 담당자에게 배정하면 403 case-update-not-allowed, 자기에게 배정은 200이다 [ASVS v5.0.0-8.2.1]', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    const other = h.as('cs_agent');
    const toOther = await h.patch(agent, id, { assignee: other['x-user-id'] }, '"1"');
    expect([toOther.status, typeOf(toOther.body)]).toEqual([403, 'case-update-not-allowed']);
    const self = await h.patch(agent, id, { assignee: agent['x-user-id'] }, '"1"');
    expect([self.status, self.body.assignee, self.etag]).toEqual([200, agent['x-user-id'], '"2"']);
    // 남에게 배정하려던 403은 건을 바꾸지 않았다(판 1 → 자기 배정으로 2)
    expect((await h.get(other, id)).body).toMatchObject({ assignee: agent['x-user-id'], version: 2 });
  });

  test('R-T49 ② cs_lead는 활성 cs_agent에게 맡기고(200), 활성 CS 담당자가 아닌 계정에게는 422 case-assignee-invalid다', async () => {
    const id = await openDispute();
    const lead = h.as('cs_lead');
    const target = crypto.randomUUID();
    h.admins.seed({ adminAccountId: target, role: 'cs_agent' });
    const ok = await h.patch(lead, id, { assignee: target }, '"1"');
    expect([ok.status, ok.body.assignee, ok.body.version]).toEqual([200, target, 2]);

    const operatorAccount = crypto.randomUUID();
    h.admins.seed({ adminAccountId: operatorAccount, role: 'operator' });
    const invited = crypto.randomUUID();
    h.admins.seed({ adminAccountId: invited, role: 'cs_agent', status: 'INVITED' });
    for (const bad of [operatorAccount, invited, crypto.randomUUID()]) {
      const r = await h.patch(lead, id, { assignee: bad }, '"2"');
      expect([r.status, typeOf(r.body)], bad).toEqual([422, 'case-assignee-invalid']);
    }
    expect((await h.get(lead, id)).body).toMatchObject({ assignee: target, version: 2 });
  });
});

describe('R-T49 ③ If-Match와 ETag', () => {
  test('R-T49 ③ If-Match 없이 428 precondition-required, 옛 판으로 412 precondition-failed, 지금 판으로 200이고 ETag의 판이 1 오른다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    const before = await h.get(agent, id);
    expect([before.status, before.etag, before.body.version]).toEqual([200, '"1"', 1]);

    const none = await h.patch(agent, id, { status: 'IN_PROGRESS' });
    expect([none.status, typeOf(none.body)]).toEqual([428, 'precondition-required']);
    const ok = await h.patch(agent, id, { status: 'IN_PROGRESS' }, '"1"');
    expect([ok.status, ok.etag, ok.body.status, ok.body.version]).toEqual([200, '"2"', 'IN_PROGRESS', 2]);
    const stale = await h.patch(agent, id, { resultNote: '경과 메모' }, '"1"');
    expect([stale.status, typeOf(stale.body)]).toEqual([412, 'precondition-failed']);
    expect((await h.get(agent, id)).etag).toBe('"2"');
  });

  test('R-T49 ③ 판 9에서 10으로 넘어가는 갱신도 지금 판만 받는다(글자 비교 결함)', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    for (let v = 1; v <= 9; v++) {
      const r = await h.patch(agent, id, { resultNote: `경과 ${v}` }, `"${v}"`);
      expect([v, r.status, r.etag]).toEqual([v, 200, `"${v + 1}"`]);
    }
    expect((await h.patch(agent, id, { resultNote: '경과 옛 판' }, '"9"')).status).toBe(412);
    expect((await h.patch(agent, id, { resultNote: '경과 옛 판' }, '"1"')).status).toBe(412);
    const ten = await h.patch(agent, id, { resultNote: '경과 10' }, '"10"');
    expect([ten.status, ten.etag]).toEqual([200, '"11"']);
  });
});

describe('R-T49 ④ 해결 메모', () => {
  test('R-T49 ④ 메모 없이 해결은 422 case-result-note-required, 메모와 함께 200 RESOLVED와 resolvedAt, 해결된 건을 다시 고치면 409 case-already-resolved다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    const noNote = await h.patch(agent, id, { status: 'RESOLVED' }, '"1"');
    expect([noNote.status, typeOf(noNote.body)]).toEqual([422, 'case-result-note-required']);
    const blank = await h.patch(agent, id, { status: 'RESOLVED', resultNote: '   ' }, '"1"');
    expect([blank.status, typeOf(blank.body)]).toEqual([422, 'case-result-note-required']);
    expect((await h.get(agent, id)).body).toMatchObject({ status: 'OPEN', version: 1, resolvedAt: null });

    h.clock.advance(90_000);
    const done = await h.patch(agent, id, { status: 'RESOLVED', resultNote: '판매자 확인 뒤 예외 환불로 잇는다' }, '"1"');
    expect([done.status, done.body.status, done.body.resolvedAt, done.body.resultNote, done.body.dueState]).toEqual([200, 'RESOLVED', new Date(h.clock.now()).toISOString(), '판매자 확인 뒤 예외 환불로 잇는다', 'NONE']);
    const again = await h.patch(agent, id, { resultNote: '다시' }, '"2"');
    expect([again.status, typeOf(again.body)]).toEqual([409, 'case-already-resolved']);
  });

  // F-06-2 리뷰 RV-03 반영(시험 담당 lane3-f062-test): 2,001자는 openapi maxLength 위반이라 400 invalid-body다(R-T49 ⑨, ADR-0364 결정 5)
  test('R-T49 ⑨ 결과 메모는 2,000자까지이고 2,001자는 400 invalid-body로 받지 않는다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    const long = await h.patch(agent, id, { status: 'RESOLVED', resultNote: '가'.repeat(2001) }, '"1"');
    expect([long.status, typeOf(long.body)]).toEqual([400, 'invalid-body']);
    expect((await h.get(agent, id)).body.status).toBe('OPEN');
    const ok = await h.patch(agent, id, { status: 'RESOLVED', resultNote: '가'.repeat(2000) }, '"1"');
    expect([ok.status, (ok.body.resultNote as string).length]).toEqual([200, 2000]);
  });

  // F-06-2 리뷰 RV-03 반영: 상태 차례 밖은 새 이름 case-status-transition-invalid(422)다(R-T49 ⑨, openapi updateOpsCase 422)
  test('R-T49 ⑨ 상태 차례 밖(진행 중 → 열림)은 422 case-status-transition-invalid이고 바뀌지 않는다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    expect((await h.patch(agent, id, { status: 'IN_PROGRESS' }, '"1"')).status).toBe(200);
    const back = await h.patch(agent, id, { status: 'OPEN' }, '"2"');
    expect([back.status, typeOf(back.body)]).toEqual([422, 'case-status-transition-invalid']);
    expect((await h.get(agent, id)).body).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
  });
});

describe('R-T49 ⑤ 역할 밖 갱신 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', () => {
  test('R-T49 ⑤ operator가 CS 건을 고치면 403 case-update-not-allowed이고, operator·commander는 지급 건을 고친다 [ASVS v5.0.0-8.2.1]', async () => {
    const dispute = await openDispute();
    for (const role of ['operator', 'commander'] as const) {
      const r = await h.patch(h.as(role), dispute, { status: 'IN_PROGRESS' }, '"1"');
      expect([role, r.status, typeOf(r.body)]).toEqual([role, 403, 'case-update-not-allowed']);
    }
    expect((await h.get(h.as('cs_agent'), dispute)).body).toMatchObject({ status: 'OPEN', version: 1 });
    const payout = await h.seed('PAYOUT_FAILED', 'payout-batch-2');
    const op = await h.patch(h.as('operator'), payout, { status: 'IN_PROGRESS', resultNote: '계좌 확인 요청' }, '"1"');
    expect([op.status, op.body.status]).toEqual([200, 'IN_PROGRESS']);
  });

  // F-06-2 리뷰 RV-01 반영(정본 73fa48514): GET이 404인 건을 PATCH도 없는 건과 같은 404로 답한다(R-T49 ⑤, ADR-0364 결정 5)
  test('R-T49 ⑤ cs_lead·cs_agent가 지급 건을 고치면 없는 건과 같은 404이고 건이 바뀌지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const payout = await h.seed('PAYOUT_FAILED', 'payout-batch-3');
    for (const role of ['cs_lead', 'cs_agent'] as const) {
      const r = await h.patch(h.as(role), payout, { status: 'IN_PROGRESS' }, '"1"');
      const missing = await h.patch(h.as(role), '0194f062-0000-7000-8000-0000000eeeee', { status: 'IN_PROGRESS' }, '"1"');
      expect([role, r.status, typeOf(r.body), r.body.title]).toEqual([role, 404, typeOf(missing.body), missing.body.title]);
      expect(missing.status).toBe(404);
    }
    expect((await h.get(h.as('operator'), payout)).body).toMatchObject({ status: 'OPEN', version: 1 });
  });

  test('R-T49 ⑤ 역할 밖 갱신·남에게 배정·숨긴 건 열기는 요청 로그에 403·404로 남는다 [ASVS v5.0.0-16.3.2]', async () => {
    const dispute = await openDispute();
    const payout = await h.seed('PAYOUT_FAILED', 'payout-batch-4');
    const agent = h.as('cs_agent');
    await h.patch(h.as('operator'), dispute, { status: 'IN_PROGRESS' }, '"1"');
    await h.patch(agent, dispute, { assignee: crypto.randomUUID() }, '"1"');
    await h.get(agent, payout);
    const denied = h.logs.lines().filter((l) => typeof l.route === 'string' && String(l.route).startsWith('/v1/ops/cases') && (l.status === 403 || l.status === 404));
    expect(denied.map((l) => [l.method, l.status])).toEqual([
      ['PATCH', 403],
      ['PATCH', 403],
      ['GET', 404],
    ]);
    // 기록에 메모·팬 정보가 없다(결정만 남긴다)
    expect(JSON.stringify(denied)).not.toContain('payout-batch-4');
  });
});

// F-06-2 리뷰 RV-02·RV-14 반영(정본 73fa48514): 풀기는 assignee: null, 빈 글은 400 invalid-body, 맡은 사람이 있는 건은 cs_lead만 바꾼다(R-T49 ⑦, ADR-0364 결정 5)
describe('R-T49 ⑦ 배정 풀기와 남의 배정 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2]', () => {
  test('R-T49 ⑦ cs_agent가 자기 배정을 assignee: null로 풀면 200이고 assignee가 null이다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    expect((await h.patch(agent, id, { assignee: agent['x-user-id'] }, '"1"')).status).toBe(200);
    const off = await h.patch(agent, id, { assignee: null }, '"2"');
    expect([off.status, off.body.assignee, off.etag]).toEqual([200, null, '"3"']);
    expect((await h.get(agent, id)).body).toMatchObject({ assignee: null, version: 3 });
  });

  test('R-T49 ⑦ assignee에 빈 글을 보내면 400 invalid-body이고 배정이 그대로다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    expect((await h.patch(agent, id, { assignee: agent['x-user-id'] }, '"1"')).status).toBe(200);
    const blank = await h.patch(agent, id, { assignee: '' }, '"2"');
    expect([blank.status, typeOf(blank.body)]).toEqual([400, 'invalid-body']);
    expect((await h.get(agent, id)).body).toMatchObject({ assignee: agent['x-user-id'], version: 2 });
  });

  test('R-T49 ⑦ 남이 맡은 건을 cs_agent가 풀거나 자기에게 옮기면 403 case-update-not-allowed이고, cs_lead는 바꾼다 [ASVS v5.0.0-8.2.1]', async () => {
    const id = await openDispute();
    const owner = h.as('cs_agent');
    const other = h.as('cs_agent');
    expect((await h.patch(owner, id, { assignee: owner['x-user-id'] }, '"1"')).status).toBe(200);
    const release = await h.patch(other, id, { assignee: null }, '"2"');
    const take = await h.patch(other, id, { assignee: other['x-user-id'] }, '"2"');
    expect([release.status, typeOf(release.body), take.status, typeOf(take.body)]).toEqual([403, 'case-update-not-allowed', 403, 'case-update-not-allowed']);
    expect((await h.get(owner, id)).body).toMatchObject({ assignee: owner['x-user-id'], version: 2 });
    const lead = await h.patch(h.as('cs_lead'), id, { assignee: null }, '"2"');
    expect([lead.status, lead.body.assignee]).toEqual([200, null]);
  });
});

// F-06-2 리뷰 RV-04 반영(정본 73fa48514): '승인 업무 실행 실패' 건은 category(승인 종류)로 나눈다(R-T49 ⑧, ADR-0364 결정 5, authz-matrix, open-items 72번)
describe('R-T49 ⑧ 승인 업무 실행 실패 건의 category별 권한 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', () => {
  const failed = async (category: string) => {
    const r = await h.intake(caseRequest('APPROVAL_EXECUTION_FAILED', { category }));
    expect(r.body.accepted).toBe(true);
    return r.body.caseId!;
  };

  test('R-T49 ⑧ PAYOUT_BATCH·COMMANDER_ROLE_CHANGE·CONTRACT_TERMS_CHANGE 건은 CS 담당자 목록에 0건이고 상세·갱신은 없는 건과 같은 404, 그 밖 승인 종류는 CS 건이다 [ASVS v5.0.0-8.2.2]', async () => {
    const ops = { PAYOUT_BATCH: await failed('PAYOUT_BATCH'), COMMANDER_ROLE_CHANGE: await failed('COMMANDER_ROLE_CHANGE'), CONTRACT_TERMS_CHANGE: await failed('CONTRACT_TERMS_CHANGE') };
    const cs = await failed('SYSTEM_FAULT_REFUND');
    const missingId = '0194f062-0000-7000-8000-0000000ddddd';
    for (const role of ['cs_agent', 'cs_lead'] as const) {
      const ids = ((await h.list(h.as(role), 'kind=APPROVAL_EXECUTION_FAILED&limit=100')).body.items as Array<{ caseId: string }>).map((i) => i.caseId);
      expect([role, ids]).toEqual([role, [cs]]);
      const missingGet = await h.get(h.as(role), missingId);
      const missingPatch = await h.patch(h.as(role), missingId, { status: 'IN_PROGRESS' }, '"1"');
      for (const [category, id] of Object.entries(ops)) {
        const g = await h.get(h.as(role), id);
        const p = await h.patch(h.as(role), id, { status: 'IN_PROGRESS' }, '"1"');
        expect([role, category, g.status, typeOf(g.body), g.body.title]).toEqual([role, category, 404, typeOf(missingGet.body), missingGet.body.title]);
        expect([role, category, p.status, typeOf(p.body), p.body.title]).toEqual([role, category, 404, typeOf(missingPatch.body), missingPatch.body.title]);
      }
    }
    for (const role of ['operator', 'commander'] as const) {
      const ids = new Set(((await h.list(h.as(role), 'kind=APPROVAL_EXECUTION_FAILED&limit=100')).body.items as Array<{ caseId: string }>).map((i) => i.caseId));
      expect([role, ids]).toEqual([role, new Set([...Object.values(ops), cs])]);
      for (const id of Object.values(ops)) expect([role, (await h.get(h.as(role), id)).status]).toEqual([role, 200]);
    }
    // 그 밖 승인 종류는 CS 건이라 CS 담당자가 고치고 operator는 403이다
    const op = await h.patch(h.as('operator'), cs, { status: 'IN_PROGRESS' }, '"1"');
    expect([op.status, typeOf(op.body)]).toEqual([403, 'case-update-not-allowed']);
    expect((await h.patch(h.as('cs_agent'), cs, { status: 'IN_PROGRESS' }, '"1"')).status).toBe(200);
  });

  test('R-T49 ⑧ PAYOUT_BATCH는 operator·commander가 고치고, 관리 역할 변경·계약 변경 실패 건은 commander만 고친다(operator 403 case-update-not-allowed) [ASVS v5.0.0-8.2.1]', async () => {
    for (const role of ['operator', 'commander'] as const) {
      const id = await failed('PAYOUT_BATCH');
      const r = await h.patch(h.as(role), id, { status: 'IN_PROGRESS' }, '"1"');
      expect([role, 'PAYOUT_BATCH', r.status, r.body.status]).toEqual([role, 'PAYOUT_BATCH', 200, 'IN_PROGRESS']);
    }
    for (const category of ['COMMANDER_ROLE_CHANGE', 'CONTRACT_TERMS_CHANGE']) {
      const id = await failed(category);
      const op = await h.patch(h.as('operator'), id, { status: 'IN_PROGRESS' }, '"1"');
      expect([category, op.status, typeOf(op.body)]).toEqual([category, 403, 'case-update-not-allowed']);
      expect((await h.get(h.as('commander'), id)).body).toMatchObject({ status: 'OPEN', version: 1 });
      const cmd = await h.patch(h.as('commander'), id, { status: 'IN_PROGRESS' }, '"1"');
      expect([category, cmd.status, cmd.body.status]).toEqual([category, 200, 'IN_PROGRESS']);
    }
  });
});

describe('R-T49 ⑥ 걸러 보기·커서·감사 [ASVS v5.0.0-1.2.4]', () => {
  test('R-T49 ⑥ next_due_at·ID 차례로 커서로 끝까지 읽으면 빠지거나 겹친 건이 0이고 기한 없는 건은 끝에 온다', async () => {
    const due = [BD3, BD1, null, BD1, '2026-12-09T14:30:00.000Z', null, BD3];
    const ids: Array<{ id: string; next: string | null }> = [];
    for (const [i, d] of due.entries()) ids.push({ id: await h.seed('STATEMENT_DISPUTE', `statement-${i}`, { resultDueAtMs: d === null ? null : Date.parse(d) }), next: d });
    const want = [...ids].sort((a, b) => (a.next ?? '9') < (b.next ?? '9') ? -1 : (a.next ?? '9') > (b.next ?? '9') ? 1 : a.id < b.id ? -1 : 1).map((x) => x.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await h.list(h.as('cs_lead'), `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...(r.body.items as Array<{ caseId: string }>).map((i) => i.caseId));
      cursor = r.body.nextCursor as string | null;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(want);
    expect(pages).toBe(4);
  });

  test('R-T49 ⑥ dueWithinDays n은 n영업일 안에 기한이 드는 건만이다(경계: 정각 포함, 1ms 뒤 제외)', async () => {
    const at = (iso: string, plus = 0) => Date.parse(iso) + plus;
    const a = await h.seed('STATEMENT_DISPUTE', 's-bd1', { resultDueAtMs: at(BD1) });
    const b = await h.seed('STATEMENT_DISPUTE', 's-bd1+1', { resultDueAtMs: at(BD1, 1) });
    const c = await h.seed('STATEMENT_DISPUTE', 's-bd3', { resultDueAtMs: at(BD3) });
    await h.seed('STATEMENT_DISPUTE', 's-none');
    const ids = async (q: string) => (((await h.list(h.as('cs_agent'), q)).body.items ?? []) as Array<{ caseId: string }>).map((i) => i.caseId);
    expect(await ids('dueWithinDays=1')).toEqual([a]);
    expect(await ids('dueWithinDays=3')).toEqual([a, b, c]);
    expect(await ids('dueWithinDays=30')).toEqual([a, b, c]);
  });

  test('R-T49 ⑥ 종류·상태로 거르고, 모르는 종류·상태와 0~30 밖의 dueWithinDays는 400 invalid-query다 [ASVS v5.0.0-1.2.4]', async () => {
    const dispute = await openDispute();
    const appeal = (await h.intake(caseRequest('VERIFICATION_APPEAL'))).body.caseId!;
    const lead = h.as('cs_lead');
    expect(((await h.list(lead, 'kind=DISPUTE')).body.items as Array<{ caseId: string }>).map((i) => i.caseId)).toEqual([dispute]);
    expect(((await h.list(lead, 'kind=VERIFICATION_APPEAL&status=OPEN')).body.items as Array<{ caseId: string }>).map((i) => i.caseId)).toEqual([appeal]);
    expect((await h.list(lead, 'status=IN_PROGRESS')).body.items).toEqual([]);
    for (const q of ['dueWithinDays=0', 'dueWithinDays=30']) expect((await h.list(lead, q)).status, q).toBe(200);
    for (const q of ['kind=NOPE', "kind=DISPUTE'%20OR%201%3D1--", 'status=CLOSED', 'dueWithinDays=31', 'dueWithinDays=-1', 'dueWithinDays=1.5', 'dueWithinDays=x']) {
      const r = await h.list(lead, q);
      expect([q, r.status, typeOf(r.body)]).toEqual([q, 400, 'invalid-query']);
    }
  });

  test('R-T49 ⑥ 갱신마다 감사 체인에 행위자·이전·다음 상태·배정이 한 줄 남고 메모 본문은 남지 않는다', async () => {
    const id = await openDispute();
    const agent = h.as('cs_agent');
    const note = '팬에게 진행 경과를 전화로 알림-비밀메모-7731';
    await h.patch(agent, id, { assignee: agent['x-user-id'], status: 'IN_PROGRESS' }, '"1"');
    await h.patch(agent, id, { status: 'RESOLVED', resultNote: note }, '"2"');
    await h.patch(agent, id, { status: 'RESOLVED', resultNote: note }, '"3"'); // 409는 감사에 남지 않는다
    const rows = h.audit.entries.filter((e) => e.recordType === 'CS_CASE_UPDATED' && e.recordId === id);
    expect(rows.map((e) => e.record.payload)).toEqual([
      expect.objectContaining({ actorAdminAccountId: agent['x-user-id'], actorRole: 'cs_agent', fromStatus: 'OPEN', toStatus: 'IN_PROGRESS', fromAssignee: null, toAssignee: agent['x-user-id'] }),
      expect.objectContaining({ actorAdminAccountId: agent['x-user-id'], actorRole: 'cs_agent', fromStatus: 'IN_PROGRESS', toStatus: 'RESOLVED', fromAssignee: agent['x-user-id'], toAssignee: agent['x-user-id'] }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('비밀메모');
  });
});

describe('역할별 처리 버튼 판정의 서버 짝', () => {
  test('R-T49 ① 다섯 역할 모두가 지급 건 목록 거르기를 오류 없이 받는다(viewer만 403)', async () => {
    const statuses = await Promise.all((['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'] as OpsRole[]).map(async (r) => [r, (await h.list(h.as(r), 'kind=PAYOUT_FAILED')).status]));
    expect(statuses).toEqual([
      ['viewer', 403],
      ['operator', 200],
      ['commander', 200],
      ['cs_agent', 200],
      ['cs_lead', 200],
    ]);
  });
});
