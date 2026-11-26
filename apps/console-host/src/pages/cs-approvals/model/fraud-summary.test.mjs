// F-04-15 SCR-046 부정 예매 조치의 사건 요약 순수 모델 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '승인자가 보는 것', docs/design/d2 CMP-060,
// docs/api/openapi.yaml FraudCaseSummary·ApprovalDecisionBody, ADR-0173 결정 2.
// 화면은 계정 ID를 '계정 1·2…'로만 부르고, 요약을 열기 전 승인하지 못한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalReasonError,
  approveBlockReason,
  exclusionIssues,
  fraudApprovalBody,
  fraudApprovalProblem,
  mapFraudSummary,
  summaryTargets,
} from './fraud-summary.ts';

const A1 = '0194b220-0000-7000-8000-000000000101';
const A2 = '0194b220-0000-7000-8000-000000000102';
const T1 = '0194b220-0000-7000-8000-000000000201';
const T2 = '0194b220-0000-7000-8000-000000000202';
const T3 = '0194b220-0000-7000-8000-000000000203';

const raw = (over = {}) => ({
  caseId: 'case-1',
  eventId: 'event-1',
  reasonCategory: 'MACRO_BOT',
  accountCount: 2,
  ticketCount: 3,
  purchaseCount: 12,
  limitPerPerson: 4,
  scoreBand: 'HIGH',
  sharedAttributes: ['DEVICE'],
  signals: ['LINK_GRAPH', 'VELOCITY'],
  appealOutcome: 'PARTIAL',
  appealCounts: { accepted: 0, rejected: 1, expired: 1, submitted: 0, pending: 0 },
  investigatorOpinion: '같은 기기에서 여러 계정이 샀습니다',
  cancelDeadlineAt: '2026-11-27T00:00:00.000Z',
  snapshotHash: 'a'.repeat(64),
  targets: [
    { accountId: A1, ticketIds: [T1, T2], holderTicketIds: [], appealOutcome: 'REJECTED' },
    { accountId: A2, ticketIds: [T3], holderTicketIds: [T3], appealOutcome: 'EXPIRED' },
  ],
  ...over,
});

const summary = () => mapFraudSummary(raw());

test('C-T71 ⑤ 사건 요약은 계약 칸만 읽고 계정 라벨에 내부 ID를 넣지 않는다', () => {
  const s = summary();
  assert.ok(s);
  assert.equal(s.caseId, 'case-1');
  assert.equal(s.ticketCount, 3);
  assert.deepEqual(s.appealCounts, { accepted: 0, rejected: 1, expired: 1, submitted: 0, pending: 0 });
  assert.equal(s.snapshotHash, 'a'.repeat(64));
  assert.equal(s.purchaseCount, 12);
  assert.equal(s.limitPerPerson, 4);
  assert.deepEqual(s.signals, ['LINK_GRAPH', 'VELOCITY']);
  assert.equal(s.appealOutcome, 'PARTIAL');
  assert.equal(s.investigatorOpinion, '같은 기기에서 여러 계정이 샀습니다');
  assert.equal(s.cancelDeadlineAt, '2026-11-27T00:00:00.000Z');
  assert.equal(s.targets.length, 2);
  const rows = summaryTargets(s);
  assert.deepEqual(rows.map((r) => r.label), ['계정 1', '계정 2']);
  assert.ok(rows.every((r) => !r.label.includes(A1) && !r.label.includes(A2)));
  assert.deepEqual(rows[0].ticketIds, [T1, T2]);
  assert.deepEqual(rows[0].holderTicketIds, []);
  assert.deepEqual(rows[1].ticketIds, [T3]);
  assert.deepEqual(rows[1].holderTicketIds, [T3]);
  assert.equal(rows[1].appealOutcome, 'EXPIRED');
  assert.equal(mapFraudSummary({}), null);
});

test('C-T71 ⑤ [ASVS v5.0.0-8.2.2] 승인 가능은 요청자·역할·지정·요약 열람·상태로 갈린다', () => {
  const s = summary();
  const base = { summary: s, status: 'PENDING_APPROVAL', canApprove: true, requesterId: 'requester', meId: 'approver', role: 'commander', designations: [], summaryViewedAt: '2026-11-26T00:00:00.000Z' };
  assert.equal(approveBlockReason(base), undefined);
  assert.match(approveBlockReason({ ...base, canApprove: false }), /서버|승인/);
  assert.match(approveBlockReason({ ...base, meId: 'requester' }), /요청자/);
  assert.match(approveBlockReason({ ...base, role: 'cs_lead' }), /권한/);
  assert.match(approveBlockReason({ ...base, designations: ['PSEUDONYM_HANDLER'] }), /가명/);
  assert.match(approveBlockReason({ ...base, summaryViewedAt: null }), /요약/);
  assert.match(approveBlockReason({ ...base, status: 'DONE' }), /승인/);
  assert.match(approveBlockReason({ ...base, summary: null }), /요약/);
});

test('C-T71 ⑤ 판단 이유와 범위 줄이기는 서버 본문으로만 만들고 모두 빼기를 막는다', () => {
  assert.equal(approvalReasonError('판단 이유'), undefined);
  assert.equal(approvalReasonError('가'.repeat(1000)), undefined);
  assert.match(approvalReasonError(''), /이유/);
  assert.match(approvalReasonError('가'.repeat(1001)), /1,000/);
  const s = summary();
  assert.equal(exclusionIssues(s, []), undefined);
  assert.equal(exclusionIssues(s, ['계정 2']), undefined);
  assert.match(exclusionIssues(s, ['계정 3']), /대상/);
  assert.match(exclusionIssues(s, ['계정 1', '계정 2']), /모두/);
  assert.deepEqual(fraudApprovalBody(s, { reason: '표 취소만 승인', excludedLabels: ['계정 2'] }), { reason: '표 취소만 승인', excludeAccountIds: [A2], excludeTicketIds: [T3] });
  assert.deepEqual(fraudApprovalBody(s, { reason: '전부 승인', excludedLabels: [] }), { reason: '전부 승인', excludeAccountIds: [], excludeTicketIds: [] });
});

test('C-T71 ⑤ 승인 오류는 요약 미열람·범위·권한으로 갈린다', () => {
  assert.match(fraudApprovalProblem({ status: 409, code: 'fraud-summary-not-viewed' }).message, /요약/);
  assert.equal(fraudApprovalProblem({ status: 409, code: 'fraud-summary-not-viewed' }).reload, true);
  assert.match(fraudApprovalProblem({ status: 422, code: 'approval-scope-invalid' }).message, /범위/);
  assert.match(fraudApprovalProblem({ status: 403, code: 'fraud-approver-ineligible' }).message, /권한/);
  assert.match(fraudApprovalProblem({ status: 409, code: 'approval-already-open' }).message, /진행/);
  assert.equal(fraudApprovalProblem({ status: 404 }).reload, false);
});
