// F-04-15 SCR-071 사건 작업대의 순수 모델 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.4~§6.7.8, docs/design/d3-screens.md SCR-071,
// docs/api/openapi.yaml 태그 investigations, docs/security/asvs/forensic-replay.md 14.3.1.
// 화면은 서버가 준 값만 쓰고, IP 원문은 사유를 적어 연 뒤 화면 메모리에만 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionRequestBody,
  appealDefaults,
  clearanceBody,
  exportBody,
  exportContentType,
  exportFilename,
  exportIssue,
  holdChangeBody,
  holdChangeIssue,
  holdEndIssue,
  holdEndRequestBody,
  investigationsProblem,
  lockText,
  mapCaseDetail,
  mapGraph,
  nodeText,
  revealableNodeIds,
  statusText,
  validateActionRequest,
  validateAppealRequest,
  validateClearance,
  validateIpReveal,
} from './investigation-case.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const A1 = '0194b220-0000-7000-8000-000000000101';
const A2 = '0194b220-0000-7000-8000-000000000102';
const A3 = '0194b220-0000-7000-8000-000000000103';
const B1 = '0194b220-0000-7000-8000-000000000201';
const B2 = '0194b220-0000-7000-8000-000000000202';

const member = (accountId, over = {}) => ({ accountId, ticketCount: 2, signals: ['LINK_GRAPH'], addedBy: 'SYSTEM', removed: false, appealResult: 'REJECTED', appealDueAt: iso(NOW - HOUR), objectionResult: 'NONE', objectionDueAt: null, transferLocked: true, lockExpiresAt: iso(NOW + 14 * DAY), ...over });
const rawCase = (over = {}) => ({
  caseId: 'case-1',
  eventId: 'event-1',
  clusterId: 'cluster-1',
  status: 'ACTIONED',
  reasonCategory: 'MACRO_BOT',
  assigneeId: 'admin-1',
  accountCount: 3,
  ticketCount: 6,
  appealDueAt: iso(NOW - DAY),
  cancelDeadlineAt: iso(NOW + 2 * DAY),
  transferLocked: true,
  approvalId: 'approval-1',
  outcomeLabel: 'BOT',
  version: 5,
  createdAt: iso(NOW - 10 * DAY),
  closedAt: null,
  members: [member(A1), member(A2, { appealResult: 'EXPIRED' }), member(A3, { appealResult: 'ACCEPTED', transferLocked: false, lockExpiresAt: null })],
  snapshot: { version: 3, frozenAt: iso(NOW - 9 * DAY), invHash: 'a'.repeat(64) },
  appealOutcome: 'PARTIAL',
  investigatorOpinion: '같은 기기에서 여러 계정이 샀습니다',
  evidenceBundleIds: [B1, B2],
  events: [{ seq: 1, kind: 'CASE_CREATED', actorId: 'admin-1', note: null, detail: { clusterId: 'cluster-1' }, occurredAt: iso(NOW - 10 * DAY) }],
  ...over,
});

test('C-T71 ⑥ 사건 상세는 계정 라벨·증거 묶음 ID·사건 기록을 서버 값으로 채운다', () => {
  const d = mapCaseDetail(rawCase());
  assert.equal(d.caseId, 'case-1');
  assert.equal(d.members.length, 3);
  assert.equal(d.members[0].label, '계정 1');
  assert.equal(d.members[1].label, '계정 2');
  assert.ok(!d.members.some((m) => m.label.includes(A1)));
  assert.deepEqual(d.evidenceBundleIds, [B1, B2]);
  assert.equal(d.events[0].kind, 'CASE_CREATED');
  assert.equal(d.snapshot?.version, 3);
  assert.equal(d.appealOutcome, 'PARTIAL');
  assert.equal(statusText('OBJECTED'), '이의 접수');
  assert.match(lockText(iso(NOW + 14 * DAY), true), /14일|늦어도/);
  assert.match(lockText(null, false), /풀림|없음/);
});

test('UI-03 [ASVS v5.0.0-14.3.1] 연결 그래프는 가린 IP와 가명만 그리고 원문은 사유를 적어 연 뒤 메모리에만 둔다', () => {
  const g = mapGraph({
    nodes: [
      { nodeId: 'n1', kind: 'ACCOUNT', label: A1, inCluster: true },
      { nodeId: 'n2', kind: 'IP', label: '203.0.113.0/24', inCluster: true },
      { nodeId: 'n3', kind: 'DEVICE', label: 'abcd1234', inCluster: false },
    ],
    edges: [{ from: 'n1', to: 'n2', kind: 'IP', firstSeenAt: iso(NOW - DAY), lastSeenAt: iso(NOW), count: 2 }],
    truncated: false,
    rawIps: ['203.0.113.45'],
  });
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(revealableNodeIds(g), ['n2']);
  assert.equal(nodeText(g.nodes[1]), '203.0.113.0/24');
  assert.ok(!JSON.stringify(g).includes('203.0.113.45'));
  assert.equal(validateIpReveal({ nodeIds: ['n2'], reason: '수사기관 요청 확인' }), undefined);
  assert.match(validateIpReveal({ nodeIds: [], reason: '수사기관 요청 확인' }), /점/);
  assert.match(validateIpReveal({ nodeIds: ['n2'], reason: '짧음' }), /5자/);
  assert.match(validateIpReveal({ nodeIds: Array.from({ length: 51 }, () => 'n2'), reason: '수사기관 요청 확인' }), /50/);
});

test('C-T70 ③ 소명 요청 기본값은 3일·24시간 하한·취소 마감 6시간 전을 지킨다', () => {
  const c = mapCaseDetail(rawCase({ status: 'INVESTIGATING', cancelDeadlineAt: iso(NOW + 5 * DAY) }));
  const d = appealDefaults(c, { nowMs: NOW, entryOpensAtMs: NOW + 6 * DAY });
  assert.deepEqual(d.accountIds, [A1, A2, A3]);
  assert.equal(d.dueAt, iso(NOW + 3 * DAY));
  assert.equal(d.lockExpiresAt, iso(NOW + 14 * DAY));
  assert.equal(d.cancelUnavailable, false);

  const tight = appealDefaults(c, { nowMs: NOW, entryOpensAtMs: NOW + 6 * DAY, cancelDeadlineAtMs: NOW + 20 * HOUR });
  assert.equal(tight.dueAt, iso(NOW + DAY));
  assert.equal(tight.cancelUnavailable, true);
});

test('C-T70 ③ 소명 요청은 사건 계정·사유 범주·기한·입장 시작 전을 서버 전에 검사한다', () => {
  const c = mapCaseDetail(rawCase({ status: 'INVESTIGATING' }));
  const o = { nowMs: NOW, entryOpensAtMs: NOW + 6 * DAY, cancelDeadlineMs: NOW + 5 * DAY };
  assert.equal(validateAppealRequest(c, { accountIds: [A1], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) }, o), undefined);
  assert.match(validateAppealRequest(c, { accountIds: ['outside'], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) }, o), /계정/);
  assert.match(validateAppealRequest(c, { accountIds: [A1], reasonCategories: [], dueAt: iso(NOW + 2 * DAY) }, o), /사유/);
  assert.match(validateAppealRequest(c, { accountIds: [A1], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + HOUR) }, o), /24시간/);
  assert.match(validateAppealRequest(c, { accountIds: [A1], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 7 * DAY) }, o), /입장/);
  assert.match(validateAppealRequest(mapCaseDetail(rawCase({ status: 'DECISION_PENDING' })), { accountIds: [A1], reasonCategories: ['MACRO_BOT'], dueAt: iso(NOW + 2 * DAY) }, o), /상태/);
});

test('C-T70 ③ 조치 요청은 소명 결과·취소 마감·이용 제한 1년·열린 승인 업무를 지킨다', () => {
  const c = mapCaseDetail(rawCase());
  const o = { nowMs: NOW, cancelDeadlineMs: NOW + 2 * DAY };
  assert.equal(validateActionRequest(c, { fraudAction: 'CANCEL_TICKETS', accountIds: [A1], reason: '취소' }, o), undefined);
  assert.match(validateActionRequest(c, { fraudAction: 'CANCEL_TICKETS', accountIds: [A3], reason: '취소' }, o), /소명/);
  assert.match(validateActionRequest(c, { fraudAction: 'CANCEL_TICKETS', accountIds: [A1], reason: '취소' }, { nowMs: NOW + 3 * DAY, cancelDeadlineMs: NOW + 2 * DAY }), /마감/);
  assert.match(validateActionRequest(c, { fraudAction: 'RESTRICT', accountIds: [A1], reason: '제한', restrictionEndsAt: iso(NOW + 366 * DAY) }, o), /1년/);
  assert.equal(validateActionRequest(c, { fraudAction: 'RESTRICT', accountIds: [A1], reason: '제한', restrictionEndsAt: iso(NOW + 300 * DAY) }, o), undefined);
  assert.match(validateActionRequest(c, { fraudAction: 'LIFT_RESTRICTION', accountIds: [A1], reason: '풀기' }, o), /이의/);
  assert.equal(validateActionRequest(mapCaseDetail(rawCase({ status: 'OBJECTED' })), { fraudAction: 'LIFT_RESTRICTION', accountIds: [A1], reason: '풀기' }, o), undefined);
  assert.match(validateActionRequest(c, { fraudAction: 'CANCEL_TICKETS', accountIds: [A1], reason: '' }, o), /사유/);
  assert.match(validateActionRequest(c, { fraudAction: 'CANCEL_TICKETS', accountIds: [A1], reason: '취소' }, { nowMs: NOW, cancelDeadlineMs: NOW + 2 * DAY, openApproval: true }), /승인/);
  assert.deepEqual(actionRequestBody({ fraudAction: 'RESTRICT', accountIds: [A1], reason: '제한', restrictionEndsAt: iso(NOW + DAY) }), { fraudAction: 'RESTRICT', accountIds: [A1], reason: '제한', restrictionEndsAt: iso(NOW + DAY) });
  assert.deepEqual(actionRequestBody({ fraudAction: 'CANCEL_TICKETS', accountIds: [A1], ticketIds: ['t1'], reason: '취소' }), { fraudAction: 'CANCEL_TICKETS', accountIds: [A1], ticketIds: ['t1'], reason: '취소' });
});

test('C-T71 ⑥ 정상 종료와 증거 묶음·보존 이유/끝·내보내기 본문은 서버 규칙과 같다', () => {
  assert.equal(validateClearance({ reason: '근거 없음', outcomeLabel: 'HUMAN' }), undefined);
  assert.match(validateClearance({ reason: '', outcomeLabel: 'HUMAN' }), /사유/);
  assert.deepEqual(clearanceBody({ reason: '근거 없음', outcomeLabel: 'HUMAN' }), { reason: '근거 없음', outcomeLabel: 'HUMAN' });

  assert.equal(holdChangeIssue({ holdReason: 'OBJECTION', status: 'SEALED' }, 'DISPUTE', '민사 소송 접수'), undefined);
  assert.match(holdChangeIssue({ holdReason: 'DISPUTE', status: 'SEALED' }, 'INVESTIGATION', '수사 착수'), /한 번/);
  assert.match(holdChangeIssue({ holdReason: 'OBJECTION', status: 'SEALED' }, 'DISPUTE', '짧음'), /5자/);
  assert.match(holdChangeIssue({ holdReason: 'OBJECTION', status: 'DISPOSED' }, 'DISPUTE', '민사 소송 접수'), /파기/);
  assert.deepEqual(holdChangeBody('INVESTIGATION', '수사 착수'), { holdReason: 'INVESTIGATION', basis: '수사 착수' });

  assert.equal(holdEndIssue({ holdReason: 'DISPUTE', status: 'SEALED', holdEndRequest: null }, '분쟁 종결'), undefined);
  assert.match(holdEndIssue({ holdReason: 'OBJECTION', status: 'SEALED', holdEndRequest: null }, '이의 종결'), /분쟁|수사/);
  assert.match(holdEndIssue({ holdReason: 'DISPUTE', status: 'SEALED', holdEndRequest: { requestedBy: 'a' } }, '분쟁 종결'), /기다/);
  assert.match(holdEndIssue({ holdReason: 'DISPUTE', status: 'SEALED', holdEndRequest: null }, '짧음'), /5자/);
  assert.deepEqual(holdEndRequestBody('분쟁 종결'), { basis: '분쟁 종결' });

  assert.deepEqual(exportBody('COMPLAINT', '고소장'), { kind: 'COMPLAINT', reason: '고소장' });
  assert.deepEqual(exportBody('AUTHORITY', '기관 제출', B1), { kind: 'AUTHORITY', reason: '기관 제출', dataRequestId: B1 });
});

test('FX-T20 ⑪ [ASVS v5.0.0-8.2.3] 내보내기 응답은 양식에 맞는 파일 이름·형식으로 내려받고 AUTHORITY는 documentId를 보인다', () => {
  assert.equal(exportIssue('AUTHORITY', '기관 제출'), '자료 요청 번호가 필요합니다');
  assert.equal(exportIssue('AUTHORITY', '기관 제출', B1), undefined);
  assert.equal(exportIssue('PROMOTER', ''), '사유를 적어 주세요');
  assert.equal(exportFilename('COMPLAINT', B1, NOW), 'peaket-complaint-0194b220-0000-7000-8000-000000000201-20261126.json');
  assert.equal(exportFilename('PROMOTER', B1, NOW), 'peaket-promoter-0194b220-0000-7000-8000-000000000201-20261126.csv');
  assert.match(exportFilename('AUTHORITY', B1, NOW), /^[A-Za-z0-9.-]+$/);
  assert.equal(exportContentType('PROMOTER'), 'text/csv; charset=utf-8');
  assert.equal(exportContentType('COMPLAINT'), 'application/json');
});

test('FX-T20 ⑫ 내보내기 오류는 한도·봉인 전·파기·자료 요청으로 갈린다', () => {
  assert.match(investigationsProblem({ status: 429, code: 'export-rate-limited' }).message, /한도/);
  assert.match(investigationsProblem({ status: 409, code: 'evidence-not-sealed' }).message, /봉인/);
  assert.match(investigationsProblem({ status: 410, code: 'evidence-disposed' }).message, /파기/);
  assert.match(investigationsProblem({ status: 422, code: 'data-request-required' }).message, /자료 요청/);
  assert.match(investigationsProblem({ status: 409, code: 'data-request-not-approved' }).message, /승인/);
  assert.equal(investigationsProblem({ status: 500 }).kind, 'error');
});
