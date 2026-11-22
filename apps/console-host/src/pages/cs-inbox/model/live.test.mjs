// SCR-045 CS 처리함 실제 화면의 값 해석 시험(F-06-2 GAT-280, R-T51 ①③④⑤). 시험 담당 lane3-f062-test.
// 정본: docs/design/d5-screen-blueprint.md §7.6(건 종류 표의 종류 이름, 상태 표의 '기한 1영업일 전·초과'·'빈 화면'·'없는 건'·'먼저 고친 건'·'해결 메모 없음'·'viewer' 글),
// docs/features/transfer-refund.md §11 R-T51(모르는 칸은 버린다, 서버 글은 글자 노드로만), openapi CsCase(dueState ON_TRACK·DUE_SOON·OVERDUE·NONE), docs/api/guidelines.md '동시 수정'(ETag).
// 서버가 실제로 준 응답을 이 해석으로 읽는 시험은 services/ops-svc/test/cs-inbox-screen-link.test.ts·test-int/cs-cases.int.test.ts다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canActOn, casePageOf, caseViewOf, dueBadge, dueText, errorOf, hasUrgent, ifMatchOf, kindLabel, statusLabel, versionOfEtag } from './live.ts';

const CASE = {
  caseId: '0194f062-0000-7000-8000-000000000001',
  kind: 'DISPUTE',
  targetRef: 'inquiry-42',
  category: 'INQUIRY_DISPUTE',
  status: 'OPEN',
  progressDueAt: '2026-11-26T14:30:00.000Z',
  resultDueAt: '2026-12-09T14:30:00.000Z',
  dueState: 'DUE_SOON',
  assignee: null,
  version: 3,
  createdAt: '2026-11-20T14:30:00.000Z',
  resolvedAt: null,
  resultNote: null,
};

test('R-T51 ① 건 하나는 CsCase 칸만 옮기고 모르는 칸(팬 이름·연락처 등)은 버린다', () => {
  const v = caseViewOf({ ...CASE, payerName: '김피켓', phone: '010-0000-0000', bankAccount: '123', nested: { x: 1 } });
  assert.deepEqual(v, CASE);
  for (const k of ['payerName', 'phone', 'bankAccount', 'nested']) assert.equal(k in v, false, k);
});

test('R-T51 ① 건 ID·종류·상태가 없거나 틀린 행은 그리지 않고, 목록은 그 행만 버린다', () => {
  assert.equal(caseViewOf(null), null);
  assert.equal(caseViewOf([CASE]), null);
  assert.equal(caseViewOf({ ...CASE, caseId: '' }), null);
  assert.equal(caseViewOf({ ...CASE, kind: 7 }), null);
  assert.equal(caseViewOf({ ...CASE, status: 'CLOSED' }), null);
  const page = casePageOf({ items: [CASE, { ...CASE, status: 'X' }, 'row', { ...CASE, caseId: '0194f062-0000-7000-8000-000000000002' }], nextCursor: 'abc', secret: 1 });
  assert.deepEqual(page.items.map((c) => c.caseId), [CASE.caseId, '0194f062-0000-7000-8000-000000000002']);
  assert.equal(page.nextCursor, 'abc');
  assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
  assert.deepEqual(casePageOf(undefined), { items: [], nextCursor: null });
  assert.deepEqual(casePageOf({ items: [], nextCursor: '' }), { items: [], nextCursor: null });
});

test('R-T51 ① 기한 상태: 모르는 값은 NONE, 해결된 건은 서버 값과 상관없이 NONE이고, 임박·넘김이 있을 때만 위 배너를 그린다', () => {
  assert.equal(caseViewOf({ ...CASE, dueState: 'LATE' }).dueState, 'NONE');
  assert.equal(caseViewOf({ ...CASE, status: 'RESOLVED', dueState: 'OVERDUE' }).dueState, 'NONE');
  assert.equal(hasUrgent([{ dueState: 'ON_TRACK' }, { dueState: 'NONE' }]), false);
  assert.equal(hasUrgent([{ dueState: 'ON_TRACK' }, { dueState: 'DUE_SOON' }]), true);
  assert.equal(hasUrgent([{ dueState: 'OVERDUE' }]), true);
  assert.equal(hasUrgent([]), false);
  // d5 §7.6 '기한 1영업일 전·초과': warning / overdue. 색만으로 말하지 않게 글이 있다
  assert.equal(dueBadge('DUE_SOON').tone, 'warning');
  assert.notEqual(dueBadge('OVERDUE').tone, dueBadge('ON_TRACK').tone);
  for (const s of ['ON_TRACK', 'DUE_SOON', 'OVERDUE', 'NONE']) assert.ok(dueBadge(s).label.length > 0, s);
  assert.equal(new Set(['ON_TRACK', 'DUE_SOON', 'OVERDUE', 'NONE'].map((s) => dueBadge(s).label)).size, 4);
});

test('R-T51 ① 기한 글은 KST 시각이고(진행·결과 있는 것만) 둘 다 없으면 기한 없음이다', () => {
  const text = dueText(CASE);
  // 2026-11-26T14:30Z = 11월 26일 23:30 KST, 2026-12-09T14:30Z = 12월 9일 23:30 KST
  assert.match(text, /^진행 11\. 26\. 23:30 · 결과 12\. 9\. 23:30$/);
  assert.match(dueText({ progressDueAt: null, resultDueAt: '2026-11-22T15:00:00.000Z' }), /^결과 11\. 23\. 00:00$/);
  assert.equal(dueText({ progressDueAt: null, resultDueAt: null }), '기한 없음');
});

test('R-T51 ① 받는 아홉 종류의 이름은 d5 §7.6 건 종류 표의 이름이고 모르는 종류는 따로 보인다', () => {
  const names = {
    REFUND_FAILED: '환급 실패',
    FLAGGED: '이상 표시',
    JUDGEMENT_PENDING: '판정 대기',
    REFUND_ACCOUNT_PENDING: '환불 대기',
    COMPENSATION_PENDING: '배상 대기',
    VERIFICATION_APPEAL: '추가 검증 이의',
    DISPUTE: '분쟁 접수',
    SCANNER_UNREPORTED: '미보고 스캐너',
    APPROVAL_EXECUTION_FAILED: '승인 업무 실행 실패',
  };
  for (const [k, v] of Object.entries(names)) assert.equal(kindLabel(k), v, k);
  assert.notEqual(kindLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.deepEqual(['OPEN', 'IN_PROGRESS', 'RESOLVED'].map(statusLabel), ['열림', '진행 중', '해결']);
});

test('R-T51 ③ ETag 판 읽기("7"·W/"7"·판 10 이상)와 If-Match 값', () => {
  assert.equal(versionOfEtag('"7"'), 7);
  assert.equal(versionOfEtag('W/"7"'), 7);
  assert.equal(versionOfEtag('"10"'), 10);
  for (const bad of [undefined, null, '', '7', '"0"', '"-1"', '"a"', '"7" "8"']) assert.equal(versionOfEtag(bad), null, String(bad));
  assert.equal(ifMatchOf(10), '"10"');
});

test('R-T51 ③④⑤ 서버 오류는 d5 §7.6 상태 표의 글로 바뀐다', () => {
  const P = 'https://problems.peaket.example/';
  assert.deepEqual(errorOf({ status: 412, type: `${P}precondition-failed` }), { kind: 'stale', text: '다른 곳에서 이 건을 먼저 고쳤습니다. 다시 불러온 뒤 고쳐 주세요.' });
  assert.deepEqual(errorOf({ status: 404, type: 'not-found' }), { kind: 'not-found', text: '없는 건입니다' });
  assert.deepEqual(errorOf({ status: 422, type: 'case-result-note-required' }), { kind: 'note-required', text: '결과 메모를 적어 주세요' });
  assert.equal(errorOf({ status: 403, type: 'forbidden' }).kind, 'forbidden');
  assert.equal(errorOf({ status: 403, type: 'case-update-not-allowed' }).kind, 'forbidden');
  assert.equal(errorOf({ status: 409, type: 'case-already-resolved' }).kind, 'resolved');
  assert.equal(errorOf({ status: 428, type: 'precondition-required' }).kind, 'precondition-required');
  assert.equal(errorOf({ status: 422, type: 'case-assignee-invalid' }).kind, 'assignee-invalid');
  assert.equal(errorOf({ status: 400, type: 'invalid-query' }).kind, 'invalid-query');
  assert.equal(errorOf({ status: 503, type: 'authz-unavailable' }).kind, 'unavailable');
  assert.equal(errorOf(undefined).kind, 'other');
});

test('R-T51 ⑤ 처리 버튼: CS 담당자는 CS 건만, operator·commander는 지급·대사·KYC 건만, viewer는 없다', () => {
  for (const role of ['cs_agent', 'cs_lead']) {
    assert.equal(canActOn(role, 'DISPUTE'), true, role);
    assert.equal(canActOn(role, 'STATEMENT_DISPUTE'), true, role);
    assert.equal(canActOn(role, 'PAYOUT_FAILED'), false, role);
  }
  for (const role of ['operator', 'commander']) {
    assert.equal(canActOn(role, 'DISPUTE'), false, role);
    for (const k of ['SELLER_KYC_REQUIRED', 'PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH', 'PG_BALANCE_MISMATCH']) assert.equal(canActOn(role, k), true, `${role} ${k}`);
  }
  assert.equal(canActOn('viewer', 'DISPUTE'), false);
  assert.equal(canActOn('viewer', 'PAYOUT_FAILED'), false);
});
