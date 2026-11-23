// 추가 검증 이의 인정·기각이 부르는 쪽(ops-svc)에서 보내는 호출(F-06-7 GAT-280, B-T28 ③④, B-T10 ③④의 CS 결정 경로). 시험 담당 lane3-f067-test.
// 실제 ops-svc 조립(메모리) + csAppealPortsFromEnv가 만든 실제 gRPC 클라이언트 → 정본 설명자로 띄운 받는 쪽 gRPC 서버 대역(cs-appeal-support.ts).
// 받는 쪽의 실제 처리(queue PASSED·BLOCKED, trust 차단 키 지우기·LABELED_HUMAN)는 test-int/verification-appeal.int.test.ts가 끝에서 끝으로 본다.
// 정본: docs/features/bot-defense.md §12 'CS 처리 첫 구현'의 '결정'·'호출 모양'·'차단 목록 변화', §9 '내부 gRPC 토큰과 acted_by 결속',
// queue.proto ResolveVerificationAppealRequest, trust.proto ApplyLabelRequest, identity.proto SetAccountHoldRequest, openapi CsCaseDetail.verificationAppeal.decision,
// ADR-0364 결정 8·9(감사 CS_CASE_UPDATED에 appealOutcome, 메모·이의 글·pid 없음).
import { internalGrpcActorProof, INTERNAL_GRPC_ACTOR_HEADER, INTERNAL_GRPC_ACTOR_PROOF_HEADER, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { NOTE, appealFixture, appealHarness, untilAttempted, type AppealHarness } from './cs-appeal-support.js';

let h: AppealHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const ALL = ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'] as const;
const REJECT_CALLS = ['QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE'] as const;

async function ready(o: Parameters<typeof appealHarness>[0] = {}) {
  h = await appealHarness(o);
  const opened = await h.openAppeal();
  await h.runDispatch();
  return { h, ...opened };
}

describe('B-T28 ③ B-T10 ③ 인정', () => {
  test('B-T28 ③ B-T10 ③ 인정하면 ResolveVerificationAppeal(ACCEPTED)·ApplyLabel(APPEAL_ACCEPTED, HUMAN)·SetAccountHold(CLOSED)이 새 판으로 각각 한 번이고 건은 RESOLVED·판 2다', async () => {
    const { h, caseId, fx } = await ready();
    const agent = h.as('cs_agent');
    const r = await h.decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"1"' });
    expect([r.status, r.etag]).toEqual([202, '"2"']);
    expect(r.body).toMatchObject({ caseId, kind: 'VERIFICATION_APPEAL', status: 'RESOLVED', version: 2, resultNote: NOTE, resolvedAt: new Date(h.clock.now()).toISOString() });
    await untilAttempted(h, caseId, ALL);
    expect(h.stubs.queue.of('ResolveVerificationAppeal')).toEqual([{ appeal_id: fx.appealId, case_id: caseId, case_version: 2, outcome: 'APPEAL_OUTCOME_ACCEPTED' }]);
    const labels = h.stubs.trust.of('ApplyLabel');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      source_ref: caseId,
      source_version: 2,
      source: 'LABEL_SOURCE_APPEAL_ACCEPTED',
      label: 'LABEL_HUMAN',
      event_id: fx.eventId,
      pid: fx.pid,
      acted_by: agent['x-user-id'],
      queue_entry_id: '',
      device_ref: '',
      review_batch: 'REVIEW_BATCH_UNSPECIFIED',
      applied_verdict: 'VERDICT_UNSPECIFIED',
      verdict_event_key: '',
    });
    expect(h.stubs.identity.of('SetAccountHold')).toEqual([
      { account_id: fx.accountId, kind: 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL', source_ref: caseId, state: 'ACCOUNT_HOLD_STATE_OPEN', source_version: 1 },
      { account_id: fx.accountId, kind: 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL', source_ref: caseId, state: 'ACCOUNT_HOLD_STATE_CLOSED', source_version: 2 },
    ]);
    // 배경 작업이 두 바퀴 더 돌아도 다시 보내지 않는다(모두 반영됨)
    await h.advanceAndRun(3_600_000);
    await h.advanceAndRun(3_600_000);
    expect([h.stubs.queue.count('ResolveVerificationAppeal'), h.stubs.trust.count('ApplyLabel'), h.stubs.identity.count('SetAccountHold')]).toEqual([1, 1, 2]);
    const va = await h.appealOf(caseId);
    expect(va.reflectState).toBe('APPLIED');
    expect((va.dispatch as Array<Record<string, unknown>>).map((d) => [d.call, d.state, d.attempts, d.lastError])).toEqual([
      ['APPEAL_COPY', 'APPLIED', 1, null],
      ['ACCOUNT_HOLD_OPEN', 'APPLIED', 1, null],
      ['QUEUE_RESOLVE', 'APPLIED', 1, null],
      ['TRUST_LABEL', 'APPLIED', 1, null],
      ['ACCOUNT_HOLD_CLOSE', 'APPLIED', 1, null],
    ]);
  });

  test('B-T28 ③ Q-T48 ② 건에 처리자·처리 시각·차단 목록 변화가 남는다: 근거가 차단 기기 목록이면 REMOVED, 기기를 못 찾으면 DEVICE_NOT_FOUND', async () => {
    h = await appealHarness();
    const agent = h.as('cs_agent');
    const blocked = await h.openAppeal();
    const lost = await h.openAppeal(appealFixture({ reasonCategory: 'REASON_CATEGORY_HUMAN_CHECK' }));
    h.stubs.blockList.set(lost.fx.pid, 'BLOCK_LIST_CHANGE_DEVICE_NOT_FOUND');
    await h.runDispatch();
    h.clock.advance(61_000);
    const decidedAt = new Date(h.clock.now()).toISOString();
    for (const c of [blocked, lost]) expect((await h.decide(agent, c.caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
    for (const c of [blocked, lost]) await untilAttempted(h, c.caseId, ALL);
    expect((await h.appealOf(blocked.caseId)).decision).toEqual({ outcome: 'ACCEPTED', decidedBy: agent['x-user-id'], decidedAt, blockListChange: 'REMOVED' });
    expect((await h.appealOf(lost.caseId)).decision).toEqual({ outcome: 'ACCEPTED', decidedBy: agent['x-user-id'], decidedAt, blockListChange: 'DEVICE_NOT_FOUND' });
  });

  test('B-T28 ③ 판 두 자리: 배정 갱신으로 판을 9까지 올린 뒤 결정하면 세 호출의 판이 모두 10이다(9 → 10을 글로 견주지 않는다)', async () => {
    const { h, caseId, fx } = await ready();
    const agent = h.as('cs_agent');
    for (let v = 1; v < 9; v++) {
      const r = await h.patch(agent, caseId, { assignee: v % 2 === 1 ? agent['x-user-id'] : null }, `"${v}"`);
      expect([v, r.status]).toEqual([v, 200]);
    }
    const r = await h.decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"9"' });
    expect([r.status, r.etag, r.body.version]).toEqual([202, '"10"', 10]);
    await untilAttempted(h, caseId, ALL);
    expect(h.stubs.queue.of('ResolveVerificationAppeal').map((q) => q.case_version)).toEqual([10]);
    expect(h.stubs.trust.of('ApplyLabel').map((q) => q.source_version)).toEqual([10]);
    expect(h.stubs.identity.of('SetAccountHold').map((q) => [q.state, q.source_version])).toEqual([
      ['ACCOUNT_HOLD_STATE_OPEN', 1],
      ['ACCOUNT_HOLD_STATE_CLOSED', 10],
    ]);
    expect(h.stubs.queue.of('ResolveVerificationAppeal')[0]!.appeal_id).toBe(fx.appealId);
  });

  test('B-T28 ③ 내부 gRPC 토큰이 있으면 ApplyLabel 메타데이터에 토큰·호출자 ops-svc·처리자·처리자 증명이 실리고, 본문 acted_by와 같다', async () => {
    const token = 'f067-internal-token-for-test';
    const { h, caseId } = await ready({ env: { token } });
    const agent = h.as('cs_lead');
    expect((await h.decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ALL);
    const call = h.stubs.trust.calls.find((c) => c.method === 'ApplyLabel')!;
    expect(call.md[INTERNAL_GRPC_TOKEN_HEADER]).toBe(token);
    expect(call.md[INTERNAL_GRPC_CALLER_HEADER]).toBe('ops-svc');
    expect(call.md[INTERNAL_GRPC_ACTOR_HEADER]).toBe(agent['x-user-id']);
    expect(call.md[INTERNAL_GRPC_ACTOR_PROOF_HEADER]).toBe(internalGrpcActorProof(token, agent['x-user-id']!));
    expect(call.req.acted_by).toBe(agent['x-user-id']);
  });

  test('B-T28 ③ 감사 체인에 결정 한 줄(CS_CASE_UPDATED, appealOutcome ACCEPTED, OPEN → RESOLVED)이 남고 메모·이의 글·pid·계정 ID는 없다', async () => {
    const { h, caseId, fx } = await ready();
    const agent = h.as('cs_agent');
    expect((await h.decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
    const rows = h.audit.entries.filter((e) => e.recordType === 'CS_CASE_UPDATED' && e.recordId === caseId);
    expect(rows.map((e) => e.record.payload)).toEqual([
      expect.objectContaining({ caseId, kind: 'VERIFICATION_APPEAL', actorAdminAccountId: agent['x-user-id'], actorRole: 'cs_agent', fromStatus: 'OPEN', toStatus: 'RESOLVED', version: 2, appealOutcome: 'ACCEPTED' }),
    ]);
    const raw = JSON.stringify(rows);
    for (const secret of [NOTE, fx.text, fx.pid, fx.accountId]) expect(raw).not.toContain(secret);
  });

  test('B-T28 ③ 맡은 사람이 아닌 cs_agent도 결정하고 배정은 그대로다', async () => {
    const { h, caseId } = await ready();
    const owner = h.as('cs_agent');
    const other = h.as('cs_agent');
    expect((await h.patch(owner, caseId, { assignee: owner['x-user-id'] }, '"1"')).status).toBe(200);
    const r = await h.decide(other, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"2"' });
    expect([r.status, r.body.assignee, r.body.status]).toEqual([202, owner['x-user-id'], 'RESOLVED']);
    await untilAttempted(h, caseId, ALL);
    expect(h.stubs.trust.of('ApplyLabel')[0]!.acted_by).toBe(other['x-user-id']);
    expect((await h.appealOf(caseId)).decision).toMatchObject({ decidedBy: other['x-user-id'] });
  });
});

describe('B-T28 ④ B-T10 ④ 기각', () => {
  test('B-T28 ④ B-T10 ④ 기각하면 ResolveVerificationAppeal(REJECTED)만 한 번, ApplyLabel 0번(배경 작업 두 바퀴 뒤에도), 병합 막기 풀기 한 번이다', async () => {
    const { h, caseId, fx } = await ready();
    const r = await h.decide(h.as('cs_lead'), caseId, { outcome: 'REJECTED', resultNote: '판정을 유지한다' }, { ifMatch: '"1"' });
    expect([r.status, r.body.status, r.body.version]).toEqual([202, 'RESOLVED', 2]);
    await untilAttempted(h, caseId, REJECT_CALLS);
    await h.advanceAndRun(3_600_000);
    await h.advanceAndRun(3_600_000);
    expect(h.stubs.queue.of('ResolveVerificationAppeal')).toEqual([{ appeal_id: fx.appealId, case_id: caseId, case_version: 2, outcome: 'APPEAL_OUTCOME_REJECTED' }]);
    expect(h.stubs.trust.count('ApplyLabel')).toBe(0);
    expect(h.stubs.identity.of('SetAccountHold').map((q) => [q.state, q.source_version])).toEqual([
      ['ACCOUNT_HOLD_STATE_OPEN', 1],
      ['ACCOUNT_HOLD_STATE_CLOSED', 2],
    ]);
  });

  test('B-T28 ④ 기각 건의 보낼 호출은 정확히 QUEUE_RESOLVE·ACCOUNT_HOLD_CLOSE이고 차단 목록 변화는 null이다', async () => {
    const { h, caseId } = await ready();
    const lead = h.as('cs_lead');
    expect((await h.decide(lead, caseId, { outcome: 'REJECTED', resultNote: '판정을 유지한다' }, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, REJECT_CALLS);
    const va = await h.appealOf(caseId);
    expect((va.dispatch as Array<{ call: string }>).map((d) => d.call)).toEqual(['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE']);
    expect(va.decision).toEqual({ outcome: 'REJECTED', decidedBy: lead['x-user-id'], decidedAt: new Date(h.clock.now()).toISOString(), blockListChange: null });
    expect(va.reflectState).toBe('APPLIED');
    const audit = h.audit.entries.filter((e) => e.recordType === 'CS_CASE_UPDATED' && e.recordId === caseId).map((e) => e.record.payload);
    expect(audit).toEqual([expect.objectContaining({ appealOutcome: 'REJECTED', toStatus: 'RESOLVED' })]);
  });
});
