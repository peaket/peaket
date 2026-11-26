// F-06-5 ops-svc CS 문의 답변·진행 경과·닫기 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: openapi createOpsCaseReply·updateOpsCase, core.proto SupportCaseService, docs/features/transfer-refund.md §7.1·§7.3, R-T27 ①④⑤.
// core-svc는 실제 gRPC 서버 대역으로 두고, ops는 시작 조립과 같은 클라이언트로 부른다. 구현 전에는 INQUIRY가 받는 종류가 아니어서
// 건이 열리지 않고 답변 경로가 404라 그 자리에서 실패한다.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { caseRequest, BD3 } from './cs-support.js';
import { ACCOUNT_ID, INQUIRY_ID, inquiryRecord, supportCaseHarness, type SupportCaseHarness } from './support-case-support.js';

let s: SupportCaseHarness;
beforeEach(async () => {
  s = await supportCaseHarness();
});
afterEach(async () => {
  await s?.close();
});

const problem = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';

async function openInquiry(category = 'MERCH'): Promise<string> {
  const r = await s.h.intake(caseRequest('INQUIRY', { sourceId: INQUIRY_ID, category }));
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  expect(r.body.accepted, JSON.stringify(r.body)).toBe(true);
  return String(r.body.caseId);
}

describe('문의가 이어진 CS 건의 답변', () => {
  test('R-T27 ④ [ASVS v5.0.0-8.1.2][ASVS v5.0.0-8.2.1] cs_agent 답변은 201이고 담당자는 피켓 고객센터로만 보이며 core에 요청 열쇠·관리자 ID가 간다', async () => {
    const caseId = await openInquiry();
    const me = s.h.as('cs_agent');
    const replyKey = randomUUID();
    const r = await s.reply(me, caseId, { kind: 'ANSWER', body: '확인했습니다. 배송 예정일은 다음 주 수요일입니다.' }, replyKey);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ authorKind: 'AGENT', authorDisplay: '피켓 고객센터', kind: 'ANSWER' });
    expect(String(r.body.body)).toContain('다음 주 수요일');
    expect(r.body.actedBy).toBeUndefined();
    expect(r.body.agentId).toBeUndefined();
    const calls = s.stub.of('AddInquiryReply');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ request_id: replyKey, inquiry_id: INQUIRY_ID, kind: 'INQUIRY_REPLY_KIND_ANSWER', acted_by: me['x-user-id'] });
    expect(s.stub.calls.find((x) => x.method === 'AddInquiryReply')!.md).toMatchObject({ 'x-peaket-internal-token': 'support-case-internal-token-0000', 'x-peaket-caller': 'ops-svc' });
    const audit = s.h.audit.entries.filter((e) => e.recordType === 'CS_CASE_REPLIED');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ caseId, inquiryId: INQUIRY_ID, kind: 'ANSWER' });
    expect(JSON.stringify(audit[0]!.payload)).not.toContain('다음 주 수요일');
    const c = await s.h.get(s.h.as('cs_lead'), caseId);
    expect(c.body.resultDueAt).toBe(BD3);
    const wrong = await supportCaseHarness({ token: 'wrong-token' });
    try {
      const wrongCaseId = await wrong.h.seed('INQUIRY', INQUIRY_ID, { accountId: ACCOUNT_ID });
      const bad = await wrong.reply(wrong.h.as('cs_agent'), wrongCaseId, { kind: 'ANSWER', body: '잘못된 토큰으로 답변을 보내 봅니다.' }, randomUUID());
      expect(bad.status).toBe(503);
      const sent = wrong.stub.calls.filter((x) => x.method === 'AddInquiryReply');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.md['x-peaket-internal-token']).toBe('wrong-token');
      expect(sent[0]!.md['x-peaket-caller']).toBe('ops-svc');
    } finally {
      await wrong.close();
    }
  });

  test('R-T27 ④ 진행 경과는 PROGRESS로 가고 문의 상태는 IN_PROGRESS로 돌아온다', async () => {
    const caseId = await openInquiry();
    s.stub.set('AddInquiryReply', () => ({ value: { result: 'INQUIRY_REPLY_RESULT_RECORDED', status: 'INQUIRY_STATUS_IN_PROGRESS', message: { message_id: 'm-progress', author_kind: 'INQUIRY_AUTHOR_KIND_AGENT', kind: 'INQUIRY_MESSAGE_KIND_PROGRESS', body: '판매자에게 확인 중입니다.', created_at: { seconds: 1_795_000_000, nanos: 0 } } } }));
    const r = await s.reply(s.h.as('cs_agent'), caseId, { kind: 'PROGRESS', body: '판매자에게 확인 중입니다.' }, randomUUID());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.kind).toBe('PROGRESS');
    expect(s.stub.of('AddInquiryReply')[0]!.kind).toBe('INQUIRY_REPLY_KIND_PROGRESS');
  });

  test('R-T27 ④ [ASVS v5.0.0-8.3.1] 답변은 cs_agent만 하고 cs_lead·operator·commander·viewer는 403이다', async () => {
    const caseId = await openInquiry();
    for (const role of ['cs_lead', 'operator', 'commander', 'viewer'] as const) {
      const r = await s.reply(s.h.as(role), caseId, { kind: 'ANSWER', body: '역할 확인을 하는 답변 본문입니다.' }, randomUUID());
      expect(r.status, role).toBe(403);
    }
    expect(s.stub.of('AddInquiryReply')).toHaveLength(0);
  });

  test('R-T27 ④ 문의가 이어지지 않은 건은 409 case-not-inquiry이고 core를 부르지 않는다', async () => {
    const r = await s.h.intake(caseRequest('REFUND_FAILED', { sourceId: 'refund-1', category: 'REFUND' }));
    expect(r.body.accepted).toBe(true);
    const reply = await s.reply(s.h.as('cs_agent'), String(r.body.caseId), { kind: 'ANSWER', body: '환급 실패 건에 답변을 보내 봅니다.' }, randomUUID());
    expect(reply.status).toBe(409);
    expect(problem(reply.body)).toBe('case-not-inquiry');
    expect(s.stub.of('AddInquiryReply')).toHaveLength(0);
  });

  test('R-T27 ④ 해결된 건에는 답변하지 않고 409 case-already-resolved다', async () => {
    const caseId = await openInquiry();
    const got = await s.h.get(s.h.as('cs_agent'), caseId);
    const patched = await s.h.patch(s.h.as('cs_agent'), caseId, { status: 'RESOLVED', resultNote: '답변으로 해결했습니다.' }, `"${String((got.body as Record<string, unknown>).version)}"`);
    expect([200, 202]).toContain(patched.status);
    const reply = await s.reply(s.h.as('cs_agent'), caseId, { kind: 'ANSWER', body: '해결한 건에 다시 답변을 보내 봅니다.' }, randomUUID());
    expect(reply.status).toBe(409);
    expect(problem(reply.body)).toBe('case-already-resolved');
  });

  test('R-T27 ⑤ 닫힌 문의는 409 inquiry-closed다', async () => {
    const caseId = await openInquiry();
    s.stub.next('AddInquiryReply', { value: { result: 'INQUIRY_REPLY_RESULT_INQUIRY_CLOSED', status: 'INQUIRY_STATUS_CLOSED' } });
    const r = await s.reply(s.h.as('cs_agent'), caseId, { kind: 'ANSWER', body: '닫힌 문의에 답변을 보내 봅니다.' }, randomUUID());
    expect(r.status).toBe(409);
    expect(problem(r.body)).toBe('inquiry-closed');
  });

  test('R-T27 ⑤ [ASVS v5.0.0-16.5.2] 건을 해결하면 CloseInquiry를 먼저 부르고, 문의 닫기가 실패하면 503이며 건은 열린 채다', async () => {
    const caseId = await openInquiry();
    s.stub.fail(grpc.status.UNAVAILABLE, 'CloseInquiry');
    const got = await s.h.get(s.h.as('cs_agent'), caseId);
    const failed = await s.h.patch(s.h.as('cs_agent'), caseId, { status: 'RESOLVED', resultNote: '문의 닫기를 실패시키는 시험입니다.' }, `"${String((got.body as Record<string, unknown>).version)}"`);
    expect(failed.status).toBe(503);
    expect(problem(failed.body)).toBe('support-unavailable');
    expect((await s.h.get(s.h.as('cs_agent'), caseId)).body.status).toBe('OPEN');
    s.stub.restore('CloseInquiry');
    s.stub.set('CloseInquiry', { value: { status: 'INQUIRY_STATUS_CLOSED', closed_at: { seconds: 1_795_000_100, nanos: 0 } } });
    const ok = await s.h.patch(s.h.as('cs_agent'), caseId, { status: 'RESOLVED', resultNote: '문의를 닫고 해결합니다.' }, `"${String((got.body as Record<string, unknown>).version)}"`);
    expect([200, 202]).toContain(ok.status);
    expect(s.stub.of('CloseInquiry')).toHaveLength(1);
    expect(s.stub.of('CloseInquiry')[0]).toMatchObject({ inquiry_id: INQUIRY_ID, acted_by: s.h.as('cs_agent')['x-user-id'] });
  });

  test('R-T27 [ASVS v5.0.0-16.1.1][ASVS v5.0.0-16.3.4] core가 멈추면 503 support-unavailable이고 성공 감사를 남기지 않는다', async () => {
    const caseId = await openInquiry();
    s.stub.fail(grpc.status.UNAVAILABLE, 'AddInquiryReply');
    const r = await s.reply(s.h.as('cs_agent'), caseId, { kind: 'ANSWER', body: 'core가 멈췄을 때 답변을 보내 봅니다.' }, randomUUID());
    expect(r.status).toBe(503);
    expect(problem(r.body)).toBe('support-unavailable');
    expect(s.h.audit.entries.filter((e) => e.recordType === 'CS_CASE_REPLIED')).toHaveLength(0);
  });

  test('R-T27 본문 0/2,001자·모르는 종류는 422, Idempotency-Key가 없으면 400이다', async () => {
    const caseId = await openInquiry();
    expect((await s.reply(s.h.as('cs_agent'), caseId, { kind: 'ANSWER', body: '' }, randomUUID())).status).toBe(422);
    expect((await s.reply(s.h.as('cs_agent'), caseId, { kind: 'ANSWER', body: '가'.repeat(2001) }, randomUUID())).status).toBe(422);
    expect((await s.reply(s.h.as('cs_agent'), caseId, { kind: 'NOTE', body: '모르는 종류입니다.' }, randomUUID())).status).toBe(422);
    const noKey = await s.h.svc.http.inject({ method: 'POST', url: `/v1/ops/cases/${caseId}/replies`, headers: { ...s.h.as('cs_agent'), 'content-type': 'application/json' }, payload: JSON.stringify({ kind: 'ANSWER', body: '열쇠 없는 답변 본문입니다.' }) });
    expect(noKey.statusCode).toBe(400);
    expect(s.stub.of('AddInquiryReply')).toHaveLength(0);
  });
});

describe('건 상세의 문의 스레드', () => {
  test('R-T27 ④ [ASVS v5.0.0-14.2.6][ASVS v5.0.0-16.3.2] 정본 CsCaseDetail.messages는 계좌번호를 가려 싣고 담당자 ID를 싣지 않는다', async () => {
    const caseId = await openInquiry();
    s.stub.set('GetInquiryRecord', {
      value: inquiryRecord({ messages: [
        { author: 'INQUIRY_AUTHOR_KIND_FAN', kind: 'INQUIRY_MESSAGE_KIND_MESSAGE', body: '환불은 110-123-456789 계좌로 받고 싶습니다.' },
        { author: 'INQUIRY_AUTHOR_KIND_AGENT', kind: 'INQUIRY_MESSAGE_KIND_ANSWER', body: '계좌는 따로 확인하겠습니다.' },
      ] }),
    });
    const r = await s.h.get(s.h.as('cs_agent'), caseId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ caseId, kind: 'INQUIRY', targetRef: INQUIRY_ID, category: 'MERCH' });
    expect(r.body.inquiry).toBeUndefined();
    const msgs = r.body.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(2);
    expect(String(msgs[0]!.body)).toContain('(계좌번호 지움)');
    expect(String(msgs[0]!.body)).not.toContain('110-123-456789');
    expect(msgs[0]!.authorDisplay).toBe('나');
    expect(msgs[1]!.authorDisplay).toBe('피켓 고객센터');
    expect(JSON.stringify(r.body)).not.toContain('actedBy');
    expect(JSON.stringify(r.body)).not.toContain('agentName');
    expect(s.stub.of('GetInquiryRecord')[0]).toMatchObject({ inquiry_id: INQUIRY_ID, acted_by: s.h.as('cs_agent')['x-user-id'] });
    expect(String(r.headers['cache-control'])).toContain('no-store');
  });
});
