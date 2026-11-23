// 추가 검증 이의 결정 경로의 권한·검사·차례(F-06-7 GAT-280, B-T28 ②). 시험 담당 lane3-f067-test.
// 실제 ops-svc 조립(메모리)의 POST /v1/ops/cases/{caseId}/verification-appeal-decision과 PATCH /v1/ops/cases/{caseId}를 역할 다섯으로 부른다.
// 정본: docs/features/bot-defense.md §12 'CS 처리 첫 구현'의 '결정'(받는 차례: Idempotency-Key 400 → 본문 400 → 404 → 403 case-update-not-allowed
// → 409 case-action-not-applicable → If-Match 428·412 → 409 case-already-resolved → 메모 2,001자 400·없음·공백 422 case-result-note-required),
// openapi createOpsCaseVerificationAppealDecision·updateOpsCase(이의 건 RESOLVED는 409 case-action-not-applicable), ADR-0364 결정 9,
// docs/api/guidelines.md '동시 수정'(If-Match "n"·W/"n")과 멱등 키(없음 400 idempotency-key-invalid, 같은 키 다른 본문 422 idempotency-key-reused).
// 메모 글자 수는 코드 포인트로 센다(PATCH와 같은 셈, F-06-2 cs-cases.ts). 한글·이모지(UTF-16 두 단위)를 섞어 단위가 틀린 셈을 잡는다.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NOTE, appealHarness, typeOf, untilAttempted, type AppealHarness } from './cs-appeal-support.js';
import { caseRequest, type OpsRole } from './cs-support.js';

let h: AppealHarness;
beforeEach(async () => {
  h = await appealHarness();
});
afterEach(async () => {
  await h.close();
});

const ACCEPT = { outcome: 'ACCEPTED', resultNote: NOTE } as const;
/** 결정 경로가 부른 받는 쪽 호출 수(결과 반영 셋) */
const decisionCalls = () => [h.stubs.queue.count('ResolveVerificationAppeal'), h.stubs.trust.count('ApplyLabel'), h.stubs.identity.of('SetAccountHold').filter((r) => r.state === 'ACCOUNT_HOLD_STATE_CLOSED').length];

async function openReady() {
  const o = await h.openAppeal();
  await h.runDispatch();
  return o;
}

describe('B-T28 ② 역할', () => {
  test('B-T28 ② operator·commander는 403 case-update-not-allowed, viewer는 403이고 받는 쪽 호출 0·건 그대로다', async () => {
    const { caseId } = await openReady();
    for (const role of ['operator', 'commander'] as const) {
      const r = await h.decide(h.as(role), caseId, ACCEPT, { ifMatch: '"1"' });
      expect([role, r.status, typeOf(r.body)]).toEqual([role, 403, 'case-update-not-allowed']);
    }
    expect((await h.decide(h.as('viewer'), caseId, ACCEPT, { ifMatch: '"1"' })).status).toBe(403);
    await h.advanceAndRun(3_600_000);
    expect(decisionCalls()).toEqual([0, 0, 0]);
    expect((await h.get(h.as('cs_agent'), caseId)).body).toMatchObject({ status: 'OPEN', version: 1, resultNote: null });
  });

  test('B-T28 ② cs_agent·cs_lead는 202다', async () => {
    for (const role of ['cs_agent', 'cs_lead'] as const) {
      const { caseId } = await openReady();
      const r = await h.decide(h.as(role), caseId, { outcome: 'REJECTED', resultNote: `${role} 기각` }, { ifMatch: '"1"' });
      expect([role, r.status, r.body.status]).toEqual([role, 202, 'RESOLVED']);
    }
  });
});

describe('B-T28 ② 메모', () => {
  test('B-T28 ② 메모 없음·빈 글·공백만은 422 case-result-note-required이고 건은 그대로다', async () => {
    const { caseId } = await openReady();
    for (const body of [{ outcome: 'ACCEPTED' }, { outcome: 'ACCEPTED', resultNote: '' }, { outcome: 'REJECTED', resultNote: ' \n\t　 ' }]) {
      const r = await h.decide(h.as('cs_agent'), caseId, body, { ifMatch: '"1"' });
      expect([JSON.stringify(body), r.status, typeOf(r.body)]).toEqual([JSON.stringify(body), 422, 'case-result-note-required']);
    }
    expect(decisionCalls()).toEqual([0, 0, 0]);
    expect((await h.get(h.as('cs_agent'), caseId)).body).toMatchObject({ status: 'OPEN', version: 1 });
  });

  test('B-T28 ② 메모 2,000자(코드 포인트, 한글·이모지 섞음)는 202이고 2,001자는 400 invalid-body다', async () => {
    const note2000 = '가'.repeat(1_000) + '😀'.repeat(1_000); // 코드 포인트 2,000, UTF-16 3,000
    const note2001 = `${note2000}a`;
    expect([[...note2000].length, note2000.length]).toEqual([2_000, 3_000]);
    const over = await openReady();
    const r1 = await h.decide(h.as('cs_agent'), over.caseId, { outcome: 'ACCEPTED', resultNote: note2001 }, { ifMatch: '"1"' });
    expect([r1.status, typeOf(r1.body)]).toEqual([400, 'invalid-body']);
    expect((await h.get(h.as('cs_agent'), over.caseId)).body.status).toBe('OPEN');
    const ok = await openReady();
    const r2 = await h.decide(h.as('cs_agent'), ok.caseId, { outcome: 'ACCEPTED', resultNote: note2000 }, { ifMatch: '"1"' });
    expect([r2.status, r2.body.resultNote]).toEqual([202, note2000]);
  });
});

describe('B-T28 ② 판·해결된 건·종류', () => {
  test('B-T28 ② If-Match 없음 428, 옛 판 412, W/"n" 꼴은 받는다', async () => {
    const { caseId } = await openReady();
    const agent = h.as('cs_agent');
    expect((await h.patch(agent, caseId, { status: 'IN_PROGRESS' }, '"1"')).status).toBe(200); // 판 2
    const none = await h.decide(agent, caseId, ACCEPT, { ifMatch: null });
    expect([none.status, typeOf(none.body)]).toEqual([428, 'precondition-required']);
    const stale = await h.decide(agent, caseId, ACCEPT, { ifMatch: '"1"' });
    expect([stale.status, typeOf(stale.body)]).toEqual([412, 'precondition-failed']);
    expect(decisionCalls()).toEqual([0, 0, 0]);
    const weak = await h.decide(agent, caseId, ACCEPT, { ifMatch: 'W/"2"' });
    expect([weak.status, weak.etag, weak.body.version]).toEqual([202, '"3"', 3]);
  });

  test('B-T28 ② 해결된 건에 다시 결정하면 409 case-already-resolved이고 받는 쪽 호출이 늘지 않는다', async () => {
    const { caseId } = await openReady();
    const first = await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' });
    expect(first.status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    const before = decisionCalls();
    for (const outcome of ['ACCEPTED', 'REJECTED']) {
      const again = await h.decide(h.as('cs_lead'), caseId, { outcome, resultNote: '다시' }, { ifMatch: first.etag! });
      expect([outcome, again.status, typeOf(again.body)]).toEqual([outcome, 409, 'case-already-resolved']);
    }
    expect(decisionCalls()).toEqual(before);
    expect(before).toEqual([1, 1, 1]);
  });

  test('B-T28 ② 이의가 아닌 건(분쟁·판정 대기)에 결정 경로는 409 case-action-not-applicable이다', async () => {
    for (const kind of ['DISPUTE', 'JUDGEMENT_PENDING'] as const) {
      const id = (await h.intake(caseRequest(kind, { category: 'X' }))).body.caseId!;
      const r = await h.decide(h.as('cs_agent'), id, ACCEPT, { ifMatch: '"1"' });
      expect([kind, r.status, typeOf(r.body)]).toEqual([kind, 409, 'case-action-not-applicable']);
      expect((await h.get(h.as('cs_agent'), id)).body.status, kind).toBe('OPEN');
    }
  });

  test('B-T28 ② 없는 건·UUID 아님·CS 담당자가 볼 수 없는 지급 건은 404다', async () => {
    const payout = await h.seed('PAYOUT_FAILED', 'payout-batch-f067');
    for (const id of ['0194f067-0000-7000-8000-0000000fffff', 'not-a-uuid', payout]) {
      const r = await h.decide(h.as('cs_agent'), id, ACCEPT, { ifMatch: '"1"' });
      // 경로가 없어서 나는 404(about:blank)가 아니라 건이 없다는 Problem이다
      expect([id, r.status, typeOf(r.body)]).toEqual([id, 404, 'not-found']);
    }
  });
});

describe('B-T28 ② 본문·멱등 키', () => {
  test('B-T28 ② 본문 모양 오류(outcome 없음·모르는 값·모르는 칸·메모가 글이 아님)는 400 invalid-body다', async () => {
    const { caseId } = await openReady();
    for (const body of [{ resultNote: NOTE }, { outcome: 'MAYBE', resultNote: NOTE }, { ...ACCEPT, pid: 'x' }, { outcome: 'ACCEPTED', resultNote: 7 }, 'ACCEPTED']) {
      const r = await h.decide(h.as('cs_agent'), caseId, body, { ifMatch: '"1"' });
      expect([JSON.stringify(body), r.status, typeOf(r.body)]).toEqual([JSON.stringify(body), 400, 'invalid-body']);
    }
  });

  test('B-T28 ② Idempotency-Key가 없거나 UUID v4가 아니면 400 idempotency-key-invalid다', async () => {
    const { caseId } = await openReady();
    for (const key of [null, 'abc', '0194f067-0000-7000-8000-000000000001']) {
      const r = await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"', key });
      expect([String(key), r.status, typeOf(r.body)]).toEqual([String(key), 400, 'idempotency-key-invalid']);
    }
    expect((await h.get(h.as('cs_agent'), caseId)).body.status).toBe('OPEN');
  });

  test('B-T28 ② 같은 키·같은 본문은 202 같은 응답이고 받는 쪽 호출이 다시 가지 않으며, 같은 키·다른 본문은 422 idempotency-key-reused다', async () => {
    const { caseId } = await openReady();
    const agent = h.as('cs_agent');
    const key = randomUUID();
    const first = await h.decide(agent, caseId, ACCEPT, { ifMatch: '"1"', key });
    expect(first.status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    const replay = await h.decide(agent, caseId, ACCEPT, { ifMatch: '"1"', key });
    expect([replay.status, replay.body]).toEqual([202, first.body]);
    const reused = await h.decide(agent, caseId, { outcome: 'REJECTED', resultNote: NOTE }, { ifMatch: '"1"', key });
    expect([reused.status, typeOf(reused.body)]).toEqual([422, 'idempotency-key-reused']);
    await h.advanceAndRun(3_600_000);
    expect(decisionCalls()).toEqual([1, 1, 1]);
    expect(h.stubs.queue.of('ResolveVerificationAppeal')[0]!.outcome).toBe('APPEAL_OUTCOME_ACCEPTED');
  });
});

describe('B-T28 ② 받는 차례(겹친 조건은 앞 오류 하나만)', () => {
  test('B-T28 ② 키 400 → 본문 400 → 404 → 403 → 409 종류 → 428·412 → 409 해결됨 → 메모 400·422 차례다', async () => {
    const { caseId: open } = await openReady();
    const { caseId: done } = await openReady();
    expect((await h.decide(h.as('cs_agent'), done, ACCEPT, { ifMatch: '"1"' })).status).toBe(202); // 판 2, 해결
    const dispute = (await h.intake(caseRequest('DISPUTE'))).body.caseId!;
    const missing = '0194f067-0000-7000-8000-0000000eeeee';
    const op = h.as('operator');
    const agent = h.as('cs_agent');
    const long = 'a'.repeat(2_001);
    const cases: Array<[string, Record<string, string>, string, unknown, { ifMatch?: string | null; key?: string | null }, number, string]> = [
      ['키 없음 + 본문 틀림 + 없는 건 + operator', op, missing, { outcome: 'MAYBE' }, { key: null, ifMatch: null }, 400, 'idempotency-key-invalid'],
      ['본문 틀림 + 없는 건 + operator', op, missing, { outcome: 'MAYBE' }, { ifMatch: null }, 400, 'invalid-body'],
      ['없는 건 + operator + 메모 없음', op, missing, { outcome: 'ACCEPTED' }, { ifMatch: null }, 404, 'not-found'],
      ['operator + 분쟁 건 + If-Match 없음', op, dispute, { outcome: 'ACCEPTED' }, { ifMatch: null }, 403, 'case-update-not-allowed'],
      ['cs_agent + 분쟁 건 + If-Match 없음 + 메모 없음', agent, dispute, { outcome: 'ACCEPTED' }, { ifMatch: null }, 409, 'case-action-not-applicable'],
      ['해결된 건 + If-Match 없음', agent, done, ACCEPT, { ifMatch: null }, 428, 'precondition-required'],
      ['해결된 건 + 옛 판 + 메모 없음', agent, done, { outcome: 'ACCEPTED' }, { ifMatch: '"1"' }, 412, 'precondition-failed'],
      ['해결된 건 + 지금 판 + 메모 없음', agent, done, { outcome: 'ACCEPTED' }, { ifMatch: '"2"' }, 409, 'case-already-resolved'],
      ['해결된 건 + 지금 판 + 메모 2,001자', agent, done, { outcome: 'ACCEPTED', resultNote: long }, { ifMatch: '"2"' }, 409, 'case-already-resolved'],
      ['열린 건 + 메모 2,001자', agent, open, { outcome: 'ACCEPTED', resultNote: long }, { ifMatch: '"1"' }, 400, 'invalid-body'],
      ['열린 건 + 메모 공백', agent, open, { outcome: 'ACCEPTED', resultNote: '   ' }, { ifMatch: '"1"' }, 422, 'case-result-note-required'],
    ];
    for (const [name, who, id, body, o, status, type] of cases) {
      const r = await h.decide(who, id, body, o);
      expect([name, r.status, typeOf(r.body)]).toEqual([name, status, type]);
    }
  });
});

describe('B-T28 ② 처리함 갱신(PATCH)으로는 이의 건을 해결하지 못한다', () => {
  test('B-T28 ② 이의 건 PATCH RESOLVED는 409 case-action-not-applicable이고 건·호출은 그대로, 배정·진행 중은 200이다', async () => {
    const { caseId } = await openReady();
    const agent = h.as('cs_agent');
    const lead = h.as('cs_lead');
    const shut = await h.patch(lead, caseId, { status: 'RESOLVED', resultNote: '호출 없이 닫기' }, '"1"');
    expect([shut.status, typeOf(shut.body)]).toEqual([409, 'case-action-not-applicable']);
    const mixed = await h.patch(agent, caseId, { assignee: agent['x-user-id'], status: 'RESOLVED', resultNote: '같이' }, '"1"');
    expect([mixed.status, typeOf(mixed.body)]).toEqual([409, 'case-action-not-applicable']);
    expect((await h.get(agent, caseId)).body).toMatchObject({ status: 'OPEN', version: 1, assignee: null });
    const assigned = await h.patch(agent, caseId, { assignee: agent['x-user-id'] }, '"1"');
    expect([assigned.status, assigned.etag]).toEqual([200, '"2"']);
    const progress = await h.patch(agent, caseId, { status: 'IN_PROGRESS' }, '"2"');
    expect([progress.status, progress.body.status, progress.etag]).toEqual([200, 'IN_PROGRESS', '"3"']);
    await h.advanceAndRun(3_600_000);
    expect(decisionCalls()).toEqual([0, 0, 0]);
  });

  test('B-T28 ② 다른 종류(분쟁)의 PATCH RESOLVED는 지금처럼 200이다', async () => {
    const id = (await h.intake(caseRequest('DISPUTE'))).body.caseId!;
    const r = await h.patch(h.as('cs_agent'), id, { status: 'RESOLVED', resultNote: '분쟁 끝' }, '"1"');
    expect([r.status, r.body.status]).toEqual([200, 'RESOLVED']);
  });
});

describe('B-T28 ② 동시 결정', () => {
  test('B-T28 ② 같은 판으로 두 담당자가 동시에 결정하면 하나는 202, 하나는 412이고 보낼 호출은 한 벌이다', async () => {
    const { caseId } = await openReady();
    const [a, b] = await Promise.all([
      h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' }),
      h.decide(h.as('cs_lead'), caseId, { outcome: 'REJECTED', resultNote: '기각' }, { ifMatch: '"1"' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 412]);
    const won = a.status === 202 ? 'APPEAL_OUTCOME_ACCEPTED' : 'APPEAL_OUTCOME_REJECTED';
    await h.advanceAndRun(3_600_000);
    await h.advanceAndRun(3_600_000);
    expect(h.stubs.queue.of('ResolveVerificationAppeal').map((r) => [r.outcome, r.case_version])).toEqual([[won, 2]]);
    const va = await h.appealOf(caseId);
    expect((va.dispatch as Array<{ call: string }>).map((d) => d.call)).toEqual(
      won === 'APPEAL_OUTCOME_ACCEPTED' ? ['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'] : ['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE'],
    );
  });
});

/** 역할 다섯이 빠짐없이 위 시험에 들어 있는지(허용·거부 목록은 값마다, 자주 놓친 결함) */
test('B-T28 ② 역할 다섯(viewer·operator·commander·cs_agent·cs_lead) 각각의 결정 답이 정본 표와 같다', async () => {
  const want: Record<OpsRole, number> = { viewer: 403, operator: 403, commander: 403, cs_agent: 202, cs_lead: 202 };
  const got: Record<string, number> = {};
  for (const role of Object.keys(want) as OpsRole[]) {
    const { caseId } = await openReady();
    got[role] = (await h.decide(h.as(role), caseId, ACCEPT, { ifMatch: '"1"' })).status;
  }
  expect(got).toEqual(want);
});
