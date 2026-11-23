// SCR-045 화면 ↔ 실제 ops-svc 연결(F-06-2 GAT-280, R-T51 ①~⑤, 계획 §6 '화면 ↔ 서버'). 시험 담당 lane3-f062-test.
// 화면과 같은 생성 클라이언트(packages/api-client)와 화면의 값 해석(apps/console-host cs-inbox/model/live.ts)으로 실제 ops-svc 조립(메모리)의 경로를 부른다.
// 가짜 API(MSW)를 쓰지 않는다. 실제 PostgreSQL 위의 같은 흐름은 test-int/cs-cases.int.test.ts가 본다.
// 정본: docs/features/transfer-refund.md §11 R-T51, docs/design/d5-screen-blueprint.md §7.6 상태 표(먼저 고친 건·없는 건·viewer 글), openapi updateOpsCase(If-Match).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { casePageOf, caseViewOf, dueBadge, errorOf, hasUrgent, ifMatchOf, versionOfEtag } from '../../../apps/console-host/src/pages/cs-inbox/model/live.js';
// F-06-7: 새 내보냄(verificationAppealOf)은 구현 전에 없으므로 이름공간으로 가져와 시험 몸 안에서 쓴다(없으면 그 시험만 실패)
import * as live from '../../../apps/console-host/src/pages/cs-inbox/model/live.js';
import { NOTE, appealHarness, untilAttempted, type AppealHarness } from './cs-appeal-support.js';
import { BD3, caseRequest, csHarness, type CsHarness } from './cs-support.js';
import { caught, screenApi, type ScreenApi } from './cs-screen-api.js';

let h: CsHarness;
let agent: Record<string, string>;
let api: ScreenApi;
beforeEach(async () => {
  h = await csHarness();
  agent = h.as('cs_agent');
  api = await screenApi(h.svc, () => agent);
});
afterEach(async () => {
  await h.close();
});

describe('R-T51 화면 ↔ ops-svc', () => {
  test('R-T51 ① 목록이 GET /v1/ops/cases 응답으로 채워지고 행마다 종류·대상·기한·상태가 있으며 임박 건이 있으면 배너를 그린다', async () => {
    const dispute = (await h.intake(caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' }))).body.caseId!;
    const judgement = (await h.intake(caseRequest('JUDGEMENT_PENDING', { category: 'EVENT_CANCELLATION' }))).body.caseId!;
    await h.seed('PAYOUT_FAILED', 'payout-batch-9');
    const r = await api.listOpsCases({ limit: 50 });
    expect(r.status).toBe(200);
    const page = casePageOf(r.data);
    expect(page.items.map((c) => [c.caseId, c.kind, c.status, c.dueState])).toEqual([
      [judgement, 'JUDGEMENT_PENDING', 'OPEN', 'DUE_SOON'],
      [dispute, 'DISPUTE', 'OPEN', 'ON_TRACK'],
    ]);
    expect(page.items[1]!.progressDueAt).toBe(BD3);
    expect(hasUrgent(page.items)).toBe(true);
    expect(page.items.map((c) => dueBadge(c.dueState).tone)).toEqual(['warning', 'outline']);
    expect(api.sent.map((s) => [s.method, s.path])).toEqual([['GET', '/v1/ops/cases?limit=50']]);
  });

  test('R-T51 ① 0건이면 목록이 비고 배너가 없다', async () => {
    const page = casePageOf((await api.listOpsCases({ limit: 50 })).data);
    expect([page.items, page.nextCursor, hasUrgent(page.items)]).toEqual([[], null, false]);
  });

  test('R-T51 ② 상세의 ETag 판으로 PATCH가 If-Match와 함께 가고 상태가 바뀐다(나에게 배정 → 진행 중 → 결과 메모로 해결)', async () => {
    const id = (await h.intake(caseRequest('DISPUTE'))).body.caseId!;
    const d = await api.getOpsCase(id);
    let version = versionOfEtag(d.headers.get('etag'));
    expect([caseViewOf(d.data)?.status, version]).toEqual(['OPEN', 1]);
    for (const body of [{ assignee: agent['x-user-id'] }, { status: 'IN_PROGRESS' }, { status: 'RESOLVED', resultNote: '팬에게 결과를 알렸다' }]) {
      const r = await api.updateOpsCase(id, body, { headers: { 'If-Match': ifMatchOf(version!) } });
      expect(r.status).toBe(200);
      version = versionOfEtag(r.headers.get('etag'));
    }
    expect(version).toBe(4);
    expect(caseViewOf((await api.getOpsCase(id)).data)).toMatchObject({ status: 'RESOLVED', assignee: agent['x-user-id'], resultNote: '팬에게 결과를 알렸다', dueState: 'NONE' });
    expect(api.sent.filter((s) => s.method === 'PATCH').map((s) => s.ifMatch)).toEqual(['"1"', '"2"', '"3"']);
    // 판 없이는 보내지 않는다(생성 클라이언트가 막는다)
    await expect(api.updateOpsCase(id, { status: 'IN_PROGRESS' })).rejects.toThrow(/If-Match/);
    expect(api.sent.filter((s) => s.method === 'PATCH')).toHaveLength(3);
  });

  test('R-T51 ②④ 서버의 메모 없음 422·없는 건 404는 화면 글로 바뀐다', async () => {
    const id = (await h.intake(caseRequest('DISPUTE'))).body.caseId!;
    expect(errorOf(await caught(api.updateOpsCase(id, { status: 'RESOLVED' }, { headers: { 'If-Match': ifMatchOf(1) } })))).toEqual({ kind: 'note-required', text: '결과 메모를 적어 주세요' });
    const payout = await h.seed('PAYOUT_FAILED', 'payout-batch-10');
    for (const missing of [payout, '0194f062-0000-7000-8000-0000000fffff']) {
      expect(errorOf(await caught(api.getOpsCase(missing))), missing).toMatchObject({ kind: 'not-found', text: '없는 건입니다' });
    }
  });

  test('R-T51 ③ 다른 창에서 먼저 고친 건을 고치면 412이고 화면은 먼저 고쳤다는 안내다', async () => {
    const id = (await h.intake(caseRequest('DISPUTE'))).body.caseId!;
    const mine = versionOfEtag((await api.getOpsCase(id)).headers.get('etag'))!;
    // 다른 창(같은 담당자의 다른 탭)이 먼저 진행 중으로 바꾼다
    expect((await api.updateOpsCase(id, { status: 'IN_PROGRESS' }, { headers: { 'If-Match': ifMatchOf(mine) } })).status).toBe(200);
    const stale = await caught(api.updateOpsCase(id, { resultNote: '쓰던 메모' }, { headers: { 'If-Match': ifMatchOf(mine) } }));
    expect(stale.status).toBe(412);
    expect(errorOf(stale)).toEqual({ kind: 'stale', text: '다른 곳에서 이 건을 먼저 고쳤습니다. 다시 불러온 뒤 고쳐 주세요.' });
    expect(caseViewOf((await api.getOpsCase(id)).data)).toMatchObject({ status: 'IN_PROGRESS', resultNote: null });
  });

  test('R-T51 ⑤ viewer의 목록은 403이고 화면은 viewer 안내로 간다, operator는 CS 건에 갱신이 403이다', async () => {
    agent = h.as('viewer');
    const v = await caught(api.listOpsCases({ limit: 50 }));
    expect([v.status, errorOf(v).kind]).toEqual([403, 'forbidden']);
    const id = (await h.intake(caseRequest('DISPUTE'))).body.caseId!;
    agent = h.as('operator');
    const op = await caught(api.updateOpsCase(id, { status: 'IN_PROGRESS' }, { headers: { 'If-Match': ifMatchOf(1) } }));
    expect([op.status, op.type, errorOf(op).kind]).toEqual([403, 'case-update-not-allowed', 'forbidden']);
  });
});

// F-06-7 GAT-280 B-T28 ⑦(시험 담당 lane3-f067-test): SCR-045 이의 심사 패널이 쓰는 생성 함수 createOpsCaseVerificationAppealDecision → 실제 ops-svc(메모리)
// → 실제 gRPC 클라이언트 → 받는 쪽 대역. 화면의 값 해석(verificationAppealOf·errorOf)으로 결과를 읽는다. 정본: openapi createOpsCaseVerificationAppealDecision(If-Match·Idempotency-Key,
// 202 CsCase + ETag), CsCaseDetail.verificationAppeal, d5 §7.6 '이의 반영 중·반영됨'·'해결 메모 없음', bot-defense §17 B-T28 ⑦.
describe('B-T28 ⑦ 이의 심사 패널 ↔ ops-svc', () => {
  let ah: AppealHarness;
  let who: Record<string, string>;
  let screen: ScreenApi;
  beforeEach(async () => {
    ah = await appealHarness();
    who = ah.as('cs_agent');
    screen = await screenApi(ah.svc, () => who);
  });
  afterEach(async () => {
    await ah.close();
  });

  const appealOfView = (data: unknown): Record<string, unknown> | null => {
    if (typeof live.verificationAppealOf !== 'function') throw new Error('live.ts에 verificationAppealOf가 없다(계획 §4 화면)');
    return live.verificationAppealOf(data) as Record<string, unknown> | null;
  };

  test('B-T28 ⑦ 상세의 verificationAppeal을 화면 해석으로 읽고, 인정은 If-Match·Idempotency-Key와 함께 한 번 가며 202 뒤 상세가 결정·반영 상태를 준다', async () => {
    const { caseId, fx } = await ah.openAppeal();
    await ah.runDispatch();
    const d = await screen.getOpsCase(caseId);
    const version = versionOfEtag(d.headers.get('etag'))!;
    expect(appealOfView(d.data)).toMatchObject({ appealId: fx.appealId, content: 'AVAILABLE', text: fx.text, entryState: 'VERIFYING', decision: null });
    const key = crypto.randomUUID();
    const r = await screen.createOpsCaseVerificationAppealDecision(caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { headers: { 'If-Match': ifMatchOf(version), 'Idempotency-Key': key } });
    expect([r.status, versionOfEtag(r.headers.get('etag')), caseViewOf(r.data)?.status]).toEqual([202, 2, 'RESOLVED']);
    expect(screen.sent.filter((s) => s.method === 'POST')).toEqual([{ method: 'POST', path: `/v1/ops/cases/${caseId}/verification-appeal-decision`, ifMatch: '"1"', idempotencyKey: key }]);
    await untilAttempted(ah, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    const after = appealOfView((await screen.getOpsCase(caseId)).data);
    expect(after).toMatchObject({ decision: { outcome: 'ACCEPTED', decidedBy: who['x-user-id'], blockListChange: 'REMOVED' }, reflectState: 'APPLIED' });
    // 시험 리뷰 1 TR-01 반영: 패널이 결과로 바뀐다(실제 서버 응답 → 화면 패널 값, 계획 §4 appealPanelOf)
    if (typeof live.appealPanelOf !== 'function') throw new Error('live.ts에 appealPanelOf가 없다(계획 §4 화면)');
    const panel = live.appealPanelOf(after as Parameters<typeof live.appealPanelOf>[0], 'cs_agent', 'RESOLVED') as { canDecide: boolean; decision: { blockList: string | null } | null; rows: Array<{ call: string; badge: { label: string } }>; banner: unknown };
    expect([panel.canDecide, panel.decision?.blockList, panel.banner]).toEqual([false, '지움', null]);
    expect(panel.rows.map((r) => [r.call, r.badge.label])).toEqual([
      ['APPEAL_COPY', '반영됨'],
      ['ACCOUNT_HOLD_OPEN', '반영됨'],
      ['QUEUE_RESOLVE', '반영됨'],
      ['TRUST_LABEL', '반영됨'],
      ['ACCOUNT_HOLD_CLOSE', '반영됨'],
    ]);
    expect(ah.stubs.queue.count('ResolveVerificationAppeal')).toBe(1);
  });

  test('B-T28 ⑦ 서버의 409 case-action-not-applicable과 case-already-resolved를 화면이 다르게 읽고, 메모 없음 422·operator 403도 화면 글로 바뀐다', async () => {
    const { caseId } = await ah.openAppeal();
    await ah.runDispatch();
    const opts = (v: number) => ({ headers: { 'If-Match': ifMatchOf(v), 'Idempotency-Key': crypto.randomUUID() } });
    expect(errorOf(await caught(screen.createOpsCaseVerificationAppealDecision(caseId, { outcome: 'ACCEPTED' }, opts(1))))).toEqual({ kind: 'note-required', text: '결과 메모를 적어 주세요' });
    // 이의 건을 처리함 갱신으로 닫으려 하면 not-applicable
    const shut = await caught(screen.updateOpsCase(caseId, { status: 'RESOLVED', resultNote: NOTE }, { headers: { 'If-Match': ifMatchOf(1) } }));
    expect([shut.status, shut.type, errorOf(shut).kind]).toEqual([409, 'case-action-not-applicable', 'not-applicable']);
    const dispute = (await ah.intake(caseRequest('DISPUTE'))).body.caseId!;
    const wrong = await caught(screen.createOpsCaseVerificationAppealDecision(dispute, { outcome: 'REJECTED', resultNote: NOTE }, opts(1)));
    expect([wrong.status, wrong.type, errorOf(wrong).kind]).toEqual([409, 'case-action-not-applicable', 'not-applicable']);
    who = ah.as('operator');
    const op = await caught(screen.createOpsCaseVerificationAppealDecision(caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, opts(1)));
    expect([op.status, op.type, errorOf(op).kind]).toEqual([403, 'case-update-not-allowed', 'forbidden']);
    who = ah.as('cs_lead');
    expect((await screen.createOpsCaseVerificationAppealDecision(caseId, { outcome: 'REJECTED', resultNote: NOTE }, opts(1))).status).toBe(202);
    const again = await caught(screen.createOpsCaseVerificationAppealDecision(caseId, { outcome: 'REJECTED', resultNote: NOTE }, opts(2)));
    expect([again.status, again.type, errorOf(again).kind]).toEqual([409, 'case-already-resolved', 'resolved']);
  });

  test('B-T28 ⑦ 네트워크 실패 뒤 같은 키로 다시 누르면 결정은 한 번이고 같은 응답이다', async () => {
    const { caseId } = await ah.openAppeal();
    await ah.runDispatch();
    const key = crypto.randomUUID();
    const body = { outcome: 'ACCEPTED', resultNote: NOTE };
    const first = await screen.createOpsCaseVerificationAppealDecision(caseId, body, { headers: { 'If-Match': ifMatchOf(1), 'Idempotency-Key': key } });
    // 응답을 잃었다고 보고 같은 키·같은 판으로 다시 보낸다(화면 규칙: 네트워크 실패·503 뒤에는 같은 키)
    const retry = await screen.createOpsCaseVerificationAppealDecision(caseId, body, { headers: { 'If-Match': ifMatchOf(1), 'Idempotency-Key': key } });
    expect([first.status, retry.status, retry.data]).toEqual([202, 202, first.data]);
    await untilAttempted(ah, caseId, ['QUEUE_RESOLVE']);
    await ah.advanceAndRun(3_600_000);
    expect(ah.stubs.queue.count('ResolveVerificationAppeal')).toBe(1);
  });
});
