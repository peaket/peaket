// SCR-045 CS 처리함 실제 화면의 값 해석 시험(F-06-2 GAT-280, R-T51 ①③④⑤). 시험 담당 lane3-f062-test.
// 정본: docs/design/d5-screen-blueprint.md §7.6(건 종류 표의 종류 이름, 상태 표의 '기한 1영업일 전·초과'·'빈 화면'·'없는 건'·'먼저 고친 건'·'해결 메모 없음'·'viewer' 글),
// docs/features/transfer-refund.md §11 R-T51(모르는 칸은 버린다, 서버 글은 글자 노드로만), openapi CsCase(dueState ON_TRACK·DUE_SOON·OVERDUE·NONE), docs/api/guidelines.md '동시 수정'(ETag).
// 서버가 실제로 준 응답을 이 해석으로 읽는 시험은 services/ops-svc/test/cs-inbox-screen-link.test.ts·test-int/cs-cases.int.test.ts다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTER_KINDS, canActOn, casePageOf, caseViewOf, dueBadge, dueText, errorOf, hasUrgent, ifMatchOf, kindLabel, statusLabel, versionOfEtag } from './live.ts';
// F-06-7: 새 내보냄(이의 심사 패널 값)은 구현 전에 없으므로 이름공간으로 가져와 시험 몸 안에서 쓴다(없으면 그 시험만 실패)
import * as live from './live.ts';

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

test('R-T51 ① 받는 열 종류(ADR-0364 결정 4의 아홉과 ADR-0368 결정 5의 정산 이의)의 이름은 d5 §7.6 건 종류 표의 이름이고 모르는 종류는 따로 보인다', () => {
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
    STATEMENT_DISPUTE: '정산 이의',
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

// F-06-2 검증 2 놓친 표본 반영(시험 담당 lane3-f062-test): 화면 종류 거르기는 서버가 받는 종류 열과 같다.
// 정본: ADR-0364 결정 4(아홉), ADR-0368 결정 5(정산 이의 STATEMENT_DISPUTE를 받는다), d5 §7.6(CS 담당자에게 지급·대사·KYC 종류는 거르기에도 나오지 않는다, open-items 72번)
test('R-T51 ① 종류 거르기는 받는 종류 열과 같은 집합이고 지급·대사·KYC 종류가 없다', () => {
  const accepted = ['REFUND_FAILED', 'FLAGGED', 'JUDGEMENT_PENDING', 'REFUND_ACCOUNT_PENDING', 'COMPENSATION_PENDING', 'VERIFICATION_APPEAL', 'DISPUTE', 'SCANNER_UNREPORTED', 'APPROVAL_EXECUTION_FAILED', 'STATEMENT_DISPUTE'];
  assert.equal(new Set(FILTER_KINDS).size, FILTER_KINDS.length, '겹친 종류');
  assert.deepEqual([...FILTER_KINDS].sort(), [...accepted].sort());
  for (const k of ['SELLER_KYC_REQUIRED', 'PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH', 'PG_BALANCE_MISMATCH']) assert.equal(FILTER_KINDS.includes(k), false, k);
});

// F-06-7 GAT-280 B-T28 ⑦(시험 담당 lane3-f067-test): SCR-045 이의 심사 패널의 값 해석.
// 정본: openapi CsCaseDetail.verificationAppeal(칸과 값 목록, pid·계정 ID·기기 가명·점수·프로필 판은 없다), docs/design/d5-screen-blueprint.md §7.6
// '추가 검증 이의 상세'(확정 신호 없음·차단 기기 목록·허니팟, 대기 참여 추가 검증 중·통과·끝남)·'이의 반영 중·반영됨'(호출 이름 다섯, 차단 목록 변화 지움·바뀐 것 없음·기기를 찾지 못해 바꾸지 못함,
// 배지 보내는 중·반영됨·반영 실패)·'이의 반영 실패'(danger), bot-defense §12 '결정'(CS 담당자만 결정), openapi 409 case-action-not-applicable.
const need = (name) => {
  assert.equal(typeof live[name], 'function', `live.ts에 ${name}가 없다(계획 §4 화면)`);
  return live[name];
};
const VA = {
  appealId: '0194f067-0000-7000-8000-0000000000a1',
  content: 'AVAILABLE',
  text: '사람입니다 <img src=x onerror=alert(1)>',
  request: 'REVIEW',
  reasonCategory: 'DEVICE_HISTORY',
  receivedAt: '2026-11-20T14:10:00.000Z',
  entryState: 'VERIFYING',
  evidence: { state: 'FOUND', hardSignal: 'BLOCK_LIST', source: 'REALTIME', decidedAt: '2026-11-20T13:58:07.250Z', deviceChallenges: { sent: 11, passed: 3, failed: 7 } },
  decision: { outcome: 'ACCEPTED', decidedBy: '0194f067-0000-7000-8000-0000000000b1', decidedAt: '2026-11-20T15:00:00.000Z', blockListChange: 'REMOVED' },
  reflectState: 'PENDING',
  dispatch: [
    { call: 'APPEAL_COPY', state: 'APPLIED', attempts: 1, lastError: null, updatedAt: '2026-11-20T14:31:00.000Z' },
    { call: 'QUEUE_RESOLVE', state: 'PENDING', attempts: 2, lastError: 'UNAVAILABLE', updatedAt: '2026-11-20T15:00:10.000Z' },
  ],
};

test('B-T28 ⑦ verificationAppealOf는 상세 응답의 verificationAppeal 정본 칸만 옮기고 모르는 칸(pid·계정 ID·점수 등)은 어디서든 버린다', () => {
  const of = need('verificationAppealOf');
  assert.deepEqual(of({ ...CASE, kind: 'VERIFICATION_APPEAL', verificationAppeal: VA }), VA);
  const leaky = {
    ...VA,
    pid: 'pid-secret',
    accountId: '0194f067-0000-7000-8000-0000000000c1',
    evidence: { ...VA.evidence, profileVersion: 918273, score: 0.97, deviceRef: 'k1.' + 'a'.repeat(43) },
    decision: { ...VA.decision, decidedByName: '김담당' },
    dispatch: [{ ...VA.dispatch[0], response: { raw: 1 } }, VA.dispatch[1]],
  };
  const v = of({ ...CASE, kind: 'VERIFICATION_APPEAL', verificationAppeal: leaky });
  assert.deepEqual(v, VA);
  assert.doesNotMatch(JSON.stringify(v), /pid-secret|918273|0\.97|decidedByName|김담당|"response"|k1\./);
});

test('B-T28 ⑦ verificationAppealOf: 칸이 없거나 객체가 아니면 null, 모르는 값은 null로, 모르는 호출 줄은 버린다', () => {
  const of = need('verificationAppealOf');
  assert.equal(of({ ...CASE }), null);
  assert.equal(of({ ...CASE, verificationAppeal: null }), null);
  assert.equal(of({ ...CASE, verificationAppeal: 'x' }), null);
  assert.equal(of(null), null);
  const v = of({ ...CASE, verificationAppeal: { ...VA, entryState: 'FLYING', evidence: { ...VA.evidence, hardSignal: 'MAGIC' }, dispatch: [...VA.dispatch, { call: 'SEND_EMAIL', state: 'APPLIED', attempts: 1, lastError: null, updatedAt: VA.receivedAt }] } });
  assert.equal(v.entryState, null);
  assert.equal(v.evidence.hardSignal, null);
  assert.deepEqual(v.dispatch.map((d) => d.call), ['APPEAL_COPY', 'QUEUE_RESOLVE']);
});

test('B-T28 ⑦ 결정 버튼은 CS 담당자(cs_agent·cs_lead)만 그린다', () => {
  const can = need('canDecideAppeal');
  assert.deepEqual(['cs_agent', 'cs_lead', 'operator', 'commander', 'viewer', ''].map(can), [true, true, false, false, false, false]);
});

test('B-T28 ⑦ 확정 신호·대기 참여·차단 목록 변화·호출·반영 배지의 이름은 d5 §7.6 글이다', () => {
  assert.deepEqual(['NONE', 'BLOCK_LIST', 'HONEYPOT'].map(need('hardSignalLabel')), ['없음', '차단 기기 목록', '허니팟']);
  assert.deepEqual(['VERIFYING', 'PASSED', 'ENDED'].map(need('entryStateLabel')), ['추가 검증 중', '통과', '끝남']);
  assert.deepEqual(['REMOVED', 'NONE', 'DEVICE_NOT_FOUND'].map(need('blockListChangeLabel')), ['지움', '바뀐 것 없음', '기기를 찾지 못해 바꾸지 못함']);
  assert.deepEqual(['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'].map(need('dispatchCallLabel')), [
    '이의 내용 옮기기',
    '계정 병합 막기',
    '대기 참여 반영',
    '봇 라벨·차단 목록 반영',
    '계정 병합 막기 풀기',
  ]);
  const badge = need('reflectBadge');
  assert.deepEqual(['PENDING', 'APPLIED', 'FAILED'].map((s) => badge(s).label), ['보내는 중', '반영됨', '반영 실패']);
  assert.equal(badge('FAILED').tone, 'danger');
  // 사유 범주 여섯은 모두 이름이 있고 서로 다르다(원값 코드를 그대로 보이지 않는다)
  const reasons = ['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK', 'SHARED_PATTERN'];
  const names = reasons.map(need('appealReasonLabel'));
  assert.equal(new Set(names).size, 6);
  for (const [i, n] of names.entries()) assert.ok(n.length > 0 && n !== reasons[i], reasons[i]);
});

test('B-T28 ⑦ errorOf는 409 case-action-not-applicable을 not-applicable로, case-already-resolved와 그 밖의 409는 resolved로 읽는다', () => {
  const P = 'https://problems.peaket.example/';
  const na = errorOf({ status: 409, type: `${P}case-action-not-applicable` });
  assert.equal(na.kind, 'not-applicable');
  assert.ok(na.text.length > 0);
  assert.notEqual(na.text, errorOf({ status: 409, type: 'case-already-resolved' }).text);
  assert.equal(errorOf({ status: 409, type: 'case-already-resolved' }).kind, 'resolved');
  assert.equal(errorOf({ status: 409, type: 'idempotency-request-in-progress' }).kind, 'resolved');
});
