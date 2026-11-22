// CS 처리함 자동 등록(F-06-2 GAT-280, R-T48 ①~③). 내부 HTTP(POST /internal/v1/cs-cases)를 실제 ops-svc 조립(메모리 저장소)에 보낸다.
// 시험 담당 lane3-f062-test. 정본: docs/features/transfer-refund.md §11 R-T48·§7.1 '첫 구현'·§13 'CS 처리함 건' 행,
// ADR-0364 결정 2·4(받는 종류 아홉, eventKey는 cs_case_request에 한 번, 같은 (종류, 대상)의 열린 건은 그 건), d5 §7.6 기한 칸, data.md cs_case·cs_case_request.
// 생산자 ↔ ops-svc(계획 §6): purchase-svc의 실제 알림 어댑터(http-compensation-case-notice.ts·http-refund-failure-notice.ts)가
// 플랫폼 외부 HTTP 클라이언트로 보낸 본문을 그대로 ops-svc에 넣는다(의존 선언 밖 상대 경로 가져오기, CLAUDE.md '큰 그림' 끝 줄과 같은 꼴).
import { createExternalHttpClient } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { HttpCompensationCaseNotice } from '../../purchase-svc/src/modules/refund/adapters/http-compensation-case-notice.js';
import { HttpRefundFailureNotice } from '../../purchase-svc/src/modules/refund/adapters/http-refund-failure-notice.js';
import { BASE_ISO, BD1, BD10, BD3, caseRequest, csHarness, type CsHarness } from './cs-support.js';

let h: CsHarness;
beforeEach(async () => {
  h = await csHarness();
});
afterEach(async () => {
  await h.close();
});

/** 실제 플랫폼 외부 HTTP 클라이언트가 만든 요청을 같은 프로세스의 ops-svc 경로에 넣는 fetch */
const fetchToOps = (): typeof fetch => async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const r = await h.svc.http.inject({ method: (init?.method ?? 'GET') as 'POST', url: `${url.pathname}${url.search}`, headers, payload: typeof init?.body === 'string' ? init.body : '' });
  return new Response(r.payload, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? 'application/json') } });
};
const opsClient = () => createExternalHttpClient({ provider: 'ops-svc', baseUrl: 'http://ops-svc.internal', timeoutCapMs: 5_000, fetch: fetchToOps() });

const lead = () => h.as('cs_lead');
const detail = async (caseId: string) => {
  const r = await h.get(lead(), caseId);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const pick = (b: Record<string, unknown>) => ({ kind: b.kind, status: b.status, category: b.category, progressDueAt: b.progressDueAt ?? null, resultDueAt: b.resultDueAt ?? null });

describe('R-T48 ① 받는 종류 아홉', () => {
  test('R-T48 ① 아홉 종류를 하나씩 보내면 종류마다 OPEN 건 하나이고 category와 두 기한이 §7.1·d5 §7.6 기한이다(시작은 dueBaseAt, 없으면 createdAt)', async () => {
    // 배상 대기는 '회차 취소 확정 뒤 10영업일'이라 확정 시각(토 08:00 KST)을 dueBaseAt에 싣고, 받은 시각(createdAt)은 그보다 사흘 뒤다
    const confirmedAt = '2026-11-20T23:00:00.000Z';
    const sent = [
      { req: caseRequest('REFUND_FAILED', { category: 'REFUND' }), want: { progressDueAt: null, resultDueAt: BD3 } },
      { req: caseRequest('FLAGGED', { category: 'ENTRY_AFTER_CANCEL' }), want: { progressDueAt: null, resultDueAt: BD1 } },
      { req: caseRequest('JUDGEMENT_PENDING', { category: 'EVENT_CANCELLATION' }), want: { progressDueAt: null, resultDueAt: BD1 } },
      { req: caseRequest('REFUND_ACCOUNT_PENDING', { category: 'REFUND' }), want: { progressDueAt: null, resultDueAt: BD3 } },
      { req: caseRequest('COMPENSATION_PENDING', { category: 'COMPENSATION', createdAt: '2026-11-23T23:00:00.000Z', dueBaseAt: confirmedAt }), want: { progressDueAt: null, resultDueAt: '2026-12-08T23:00:00.000Z' } },
      { req: caseRequest('VERIFICATION_APPEAL', { category: 'EXPLANATION' }), want: { progressDueAt: null, resultDueAt: BD10 } },
      { req: caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' }), want: { progressDueAt: BD3, resultDueAt: BD10 } },
      { req: caseRequest('SCANNER_UNREPORTED', { category: 'QUEUE_NOT_FLUSHED' }), want: { progressDueAt: BD1, resultDueAt: BD3 } },
      { req: caseRequest('APPROVAL_EXECUTION_FAILED', { category: 'CONTRACT_TERMS_CHANGE' }), want: { progressDueAt: null, resultDueAt: null } },
    ];
    const ids: string[] = [];
    for (const s of sent) {
      const r = await h.intake(s.req);
      expect([s.req.kind, r.status, r.body.accepted]).toEqual([s.req.kind, 202, true]);
      ids.push(r.body.caseId!);
      expect(pick(await detail(r.body.caseId!))).toEqual({ kind: s.req.kind, status: 'OPEN', category: s.req.category, ...s.want });
    }
    expect(new Set(ids).size).toBe(9);
    for (const s of sent) expect(await h.requests(s.req.kind, 'opened'), s.req.kind).toBe(1);

    // 목록: 이른 기한 차례, 기한 없는 건(승인 업무 실행 실패)은 끝
    const list = await h.list(lead(), 'limit=100');
    const items = list.body.items as Array<Record<string, string>>;
    const nextDue = (i: Record<string, string>) => [i.progressDueAt, i.resultDueAt].filter(Boolean).sort()[0] ?? null;
    expect(items.map(nextDue)).toEqual([BD1, BD1, BD1, BD3, BD3, BD3, '2026-12-08T23:00:00.000Z', BD10, null]);
    expect(items.at(-1)!.kind).toBe('APPROVAL_EXECUTION_FAILED');
    expect(new Set(items.slice(0, 3).map((i) => i.kind))).toEqual(new Set(['FLAGGED', 'JUDGEMENT_PENDING', 'SCANNER_UNREPORTED']));
    // 같은 기한끼리는 건 ID 차례다
    expect(items.slice(0, 3).map((i) => i.caseId)).toEqual(items.slice(0, 3).map((i) => i.caseId).sort());
  });

  test('R-T48 ① purchase-svc 배상 대기·환급 실패 알림 어댑터가 실제 HTTP 클라이언트로 보낸 본문이 건으로 열린다(배상 대기는 받는 종류다)', async () => {
    const client = opsClient();
    const compensationId = '0194f062-0000-7000-8000-00000000c001';
    const cancellationId = '0194f062-0000-7000-8000-00000000c002';
    const nowMs = Date.parse(BASE_ISO);
    await expect(new HttpCompensationCaseNotice(client).open({ compensationId, orderId: 'o-1', nowMs })).resolves.toBeUndefined();
    await expect(new HttpRefundFailureNotice(client).open({ cancellationId, orderId: 'o-2', attempts: 5, lastError: 'pg 503', nowMs })).resolves.toBeUndefined();
    // 같은 알림을 다시 보내도 같은 건(같은 eventKey)이다
    await new HttpCompensationCaseNotice(client).open({ compensationId, orderId: 'o-1', nowMs: nowMs + 60_000 });

    const items = (await h.list(lead(), 'limit=100')).body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => ({ kind: i.kind, targetRef: i.targetRef, category: i.category, resultDueAt: i.resultDueAt })).sort((a, b) => String(a.kind).localeCompare(String(b.kind)))).toEqual([
      { kind: 'COMPENSATION_PENDING', targetRef: compensationId, category: 'COMPENSATION', resultDueAt: BD10 },
      { kind: 'REFUND_FAILED', targetRef: cancellationId, category: 'REFUND', resultDueAt: BD3 },
    ]);
    expect([await h.requests('COMPENSATION_PENDING', 'opened'), await h.requests('COMPENSATION_PENDING', 'duplicate')]).toEqual([1, 1]);
  });
});

describe('R-T48 ② 멱등', () => {
  test('R-T48 ② 같은 eventKey를 다시, 같은 대상의 다른 eventKey를 보내면 같은 건이고, 해결한 뒤 같은 eventKey는 새 건 0이다', async () => {
    const first = caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' });
    const a = await h.intake(first);
    const again = await h.intake(first);
    const sameTarget = await h.intake({ ...first, eventKey: crypto.randomUUID() });
    expect([again.body, sameTarget.body]).toEqual([
      { accepted: true, caseId: a.body.caseId },
      { accepted: true, caseId: a.body.caseId },
    ]);
    expect([await h.requests('DISPUTE', 'opened'), await h.requests('DISPUTE', 'duplicate'), await h.requests('DISPUTE', 'existing')]).toEqual([1, 1, 1]);

    // CS 담당자가 메모와 함께 해결한다
    const agent = h.as('cs_agent');
    const resolved = await h.patch(agent, a.body.caseId!, { status: 'RESOLVED', resultNote: '분쟁 경과를 팬에게 알렸다' }, '"1"');
    expect([resolved.status, resolved.body.status]).toEqual([200, 'RESOLVED']);

    const replay = await h.intake(first);
    expect(replay.body.accepted).toBe(true);
    expect(replay.body.caseId).toBe(a.body.caseId);
    expect((await h.list(lead(), 'kind=DISPUTE')).body.items).toEqual([]);
    expect(((await h.list(lead(), 'kind=DISPUTE&status=RESOLVED')).body.items as unknown[]).length).toBe(1);

    // 같은 대상이라도 새 사건(다른 eventKey)은 열린 건이 없으니 새 건이다(열린 건에서만 (종류, 대상)이 하나, data.md cs_case.status)
    const next = await h.intake({ ...first, eventKey: crypto.randomUUID() });
    expect(next.body.caseId).not.toBe(a.body.caseId);
    expect(((await h.list(lead(), 'kind=DISPUTE')).body.items as Array<{ caseId: string }>).map((i) => i.caseId)).toEqual([next.body.caseId]);
  });
});

describe('R-T48 ③ 받지 않는 종류와 칸이 빠진 본문', () => {
  test('R-T48 ③ INQUIRY·CONTENT_REPORT·APPEAL과 칸이 빠진 본문은 accepted: false이고 행 0, 지표 결과가 ignored다', async () => {
    for (const kind of ['INQUIRY', 'CONTENT_REPORT', 'APPEAL'] as const) {
      const r = await h.intake(caseRequest(kind));
      expect([kind, r.status, r.body]).toEqual([kind, 202, { accepted: false }]);
      expect(await h.requests(kind, 'ignored'), kind).toBe(1);
    }
    const { sourceId: _drop, ...noSource } = caseRequest('DISPUTE');
    expect((await h.intake(noSource)).body).toEqual({ accepted: false });
    const { createdAt: _drop2, ...noCreatedAt } = caseRequest('REFUND_FAILED');
    expect((await h.intake(noCreatedAt)).body).toEqual({ accepted: false });
    expect([await h.requests('DISPUTE', 'ignored'), await h.requests('REFUND_FAILED', 'ignored')]).toEqual([1, 1]);

    for (const role of ['cs_lead', 'operator'] as const) {
      expect((await h.list(h.as(role), 'limit=100')).body.items, role).toEqual([]);
      expect((await h.list(h.as(role), 'status=RESOLVED&limit=100')).body.items, `${role} 해결`).toEqual([]);
    }
  });

  test('R-T48 ③ 받지 않는 종류를 purchase-svc 어댑터 꼴로 보내면 2xx라도 연 것이 아니다(생산자가 다시 연다)', async () => {
    const r = await opsClient().request({ method: 'POST', path: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, body: JSON.stringify(caseRequest('INQUIRY')) });
    expect([r.status, await r.json()]).toEqual([202, { accepted: false }]);
  });
});
