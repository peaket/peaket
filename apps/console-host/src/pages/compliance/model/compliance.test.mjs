// SCR-032 법정 조치의 모델 시험(F-03-7 T7~T14, FR-033·034·063·064, ASVS v5.0.0-8.1.2·14.2.1, 시험 먼저).
// 정본: docs/features/control-tower.md §9(점검표·자료 요청 상태 P1~P8·의무별 기한·접속기록 점검), §9.1(통지 문안),
// docs/design/d5-screen-blueprint.md §7.5(화면 글·상태), openapi ComplianceNotice·DataRequest·SecurityIncident·IncidentFilingCreate.
// 기한 경계는 2시간·6시간 양쪽을 본다. 구현 전 트리에는 model/compliance.ts가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./compliance.ts');
const HOUR = 60 * 60_000;
const AT = '2026-11-23T11:00:00.000Z';
const AT_MS = Date.parse(AT);
const SHA = 'd2684315' + 'a'.repeat(56);

const notice = (over = {}) => ({
  view: 'FULL',
  noticeId: '1a2b3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  requester: 'AGENCY',
  agencyName: '한국콘텐츠진흥원',
  dueAt: new Date(AT_MS + 5 * HOUR).toISOString(),
  status: 'OPEN',
  receivedAt: AT,
  deadline: 'H24',
  reviewIds: ['9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'],
  summary: '암표 의심 게시물 통보',
  documents: [],
  takenDownAt: null,
  withdrawnAt: null,
  ...over,
});

const dataRequest = (over = {}) => ({
  view: 'FULL',
  requestId: '2b3c4d5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  requester: 'POLICE',
  agencyName: '서울경찰청 사이버수사대',
  kind: 'CDR',
  dueAt: new Date(AT_MS + 48 * HOUR).toISOString(),
  status: 'PENDING_APPROVAL',
  receivedAt: AT,
  legalBasis: '형사소송법 제215조 제2항',
  purpose: '부정 예매 조사',
  subjects: [{ kind: 'ACCOUNT_ID', value: 'acc-1' }],
  dataItems: ['BOOKINGS', 'ACCESS_LOGS'],
  periodFrom: '2026-11-01T00:00:00.000Z',
  periodTo: '2026-11-20T00:00:00.000Z',
  refusalReason: null,
  documents: [],
  extraction: {
    dataItems: ['BOOKINGS'],
    periodFrom: '2026-11-01T00:00:00.000Z',
    periodTo: '2026-11-10T00:00:00.000Z',
    rowCounts: { BOOKINGS: 12 },
    reason: '결제 내역만 필요합니다',
    requestedAt: AT,
    requesterRole: 'operator',
    approvalExpiresAt: new Date(AT_MS + 24 * HOUR).toISOString(),
  },
  decisions: [],
  submission: null,
  retainUntil: '2033-11-23T11:00:00.000Z',
  ...over,
});

const incident = (over = {}) => ({
  view: 'FULL',
  incidentId: '3c4d5e6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
  kind: 'INTRUSION',
  status: 'OPEN',
  nextDueAt: new Date(AT_MS + 24 * HOUR).toISOString(),
  awareAt: AT,
  affectedCount: 1200,
  sensitiveOrUnique: false,
  externalAccess: true,
  summary: '서비스 거부 공격',
  outageStartedAt: null,
  outageEndedAt: null,
  decidedAt: null,
  duties: [
    { duty: 'KISA_REPORT_24H', dueAt: new Date(AT_MS + 24 * HOUR).toISOString(), doneAt: null },
    { duty: 'USER_NOTICE', dueAt: new Date(AT_MS + 2 * HOUR).toISOString(), doneAt: null },
  ],
  filings: [],
  ...over,
});

test('F-03-7 T7 FR-033-1 기한은 2시간 전부터 danger, 6시간 전부터 warn이고 지나면 overdue다', async () => {
  const { deadlineView } = await load();
  const due = new Date(AT_MS + 5 * HOUR).toISOString();
  assert.equal(deadlineView(due, AT_MS).tone, 'warn', '5시간 남으면 warn');
  assert.equal(deadlineView(due, AT_MS + 3 * HOUR - 1).tone, 'warn', '2시간 1ms 전까지 warn');
  assert.equal(deadlineView(due, AT_MS + 3 * HOUR).tone, 'danger', '2시간 0ms부터 danger');
  const near = deadlineView(due, AT_MS + 3 * HOUR);
  assert.ok(near.text.includes('2시간'), near.text);
  assert.equal(deadlineView(due, AT_MS + 5 * HOUR + 1).tone, 'overdue');
  assert.match(deadlineView(due, AT_MS + 5 * HOUR + 1).text, /지남|지났/);
});

test('F-03-7 T7 FR-033-2 통보 등록은 기관·이름·접수 시각·기한·게시물 ID가 모두 있어야 하고, 기한은 H24·H10 둘뿐이다', async () => {
  const { validateNoticeDraft } = await load();
  const ok = { requester: 'POLICE', agencyName: '경찰청', receivedAt: AT, deadline: 'H24', reviewIds: ['9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'], summary: '' };
  assert.equal(validateNoticeDraft(ok), null);
  assert.match(validateNoticeDraft({ ...ok, agencyName: '  ' }), /기관/);
  assert.match(validateNoticeDraft({ ...ok, receivedAt: 'not-a-date' }), /접수/);
  assert.match(validateNoticeDraft({ ...ok, deadline: 'H48' }), /기한/);
  assert.match(validateNoticeDraft({ ...ok, reviewIds: [] }), /게시물/);
});

test('F-03-7 T7 FR-033-3 통보 등록·차단·철회 응답 문제는 우리 글(409·403·415)로 바뀌고 서버 제목은 싣지 않는다', async () => {
  const { complianceProblemMessage } = await load();
  const conflict = complianceProblemMessage({ status: 409, type: 'already-taken-down', detail: '서버 원문' });
  assert.match(conflict, /이미|철회/);
  assert.equal(conflict.includes('서버 원문'), false);
  assert.match(complianceProblemMessage({ status: 403, type: 'forbidden' }), /권한/);
  assert.match(complianceProblemMessage({ status: 415, type: 'unsupported-media-type' }), /PDF/);
  assert.match(complianceProblemMessage({ status: 413, type: 'payload-too-large' }), /20MB|20MB/);
});

test('F-03-7 T8 FR-034-1 점검표 넷이 참이고, CDR이면 법원 허가서가 참이어야 접수된다', async () => {
  const { validateDataRequestDraft } = await load();
  const ok = {
    requester: 'POLICE',
    agencyName: '경찰청',
    kind: 'CDR',
    receivedAt: AT,
    dueAt: new Date(AT_MS + 48 * HOUR).toISOString(),
    legalBasis: '형사소송법 제215조 제2항',
    purpose: '부정 예매 조사',
    subjects: [{ kind: 'ACCOUNT_ID', value: 'acc-1' }],
    dataItems: ['BOOKINGS'],
    checklist: { legalBasisChecked: true, purposeChecked: true, scopeChecked: true, dueChecked: true, courtWarrantAttached: true },
  };
  assert.equal(validateDataRequestDraft(ok), null);
  assert.match(validateDataRequestDraft({ ...ok, checklist: { ...ok.checklist, scopeChecked: false } }), /범위/);
  assert.match(validateDataRequestDraft({ ...ok, checklist: { ...ok.checklist, courtWarrantAttached: false } }), /법원 허가서|영장/);
  assert.equal(validateDataRequestDraft({ ...ok, kind: 'REPORT', checklist: { ...ok.checklist, courtWarrantAttached: false } }), null, '다른 종류는 허가서가 없어도 된다');
  assert.match(validateDataRequestDraft({ ...ok, subjects: [] }), /대상자/);
});

test('F-03-7 T8 FR-034-2 추출 범위는 요청서 항목·기간 안이어야 하고, 사유가 필요하다', async () => {
  const { validateExtractionDraft } = await load();
  const req = dataRequest();
  assert.equal(validateExtractionDraft({ dataItems: ['BOOKINGS'], periodFrom: '2026-11-02T00:00:00.000Z', periodTo: '2026-11-09T00:00:00.000Z', reason: '결제 내역' }, req), null);
  assert.match(validateExtractionDraft({ dataItems: ['POSTS'], periodFrom: null, periodTo: null, reason: '사유' }, req), /요청서/);
  assert.match(validateExtractionDraft({ dataItems: ['BOOKINGS'], periodFrom: '2026-10-01T00:00:00.000Z', periodTo: null, reason: '사유' }, req), /기간/);
  assert.match(validateExtractionDraft({ dataItems: ['BOOKINGS'], periodFrom: null, periodTo: null, reason: '  ' }, req), /사유/);
});

test('F-03-7 T8 FR-034-3 제출 SHA-256은 64자 소문자 16진수이고, 승인 파일과 다르면 d5의 422 글이다', async () => {
  const { validateSubmissionDraft } = await load();
  const ok = { submittedAt: AT, recipient: '서울경찰청', channel: '전자 제출', fileSha256: SHA };
  assert.equal(validateSubmissionDraft(ok, SHA), null);
  assert.match(validateSubmissionDraft({ ...ok, fileSha256: 'xyz' }, SHA), /SHA-256|64/);
  assert.match(validateSubmissionDraft(ok, 'e'.repeat(64)), /해시가 다릅니다/);
});

test('F-03-7 T9 FR-063-1 판단은 commander만 한 번 적고, 판단 전에는 신고·통지 기록을 막는다', async () => {
  const { actionAvailability, validateDeterminationDraft } = await load();
  const undecided = incident();
  const op = actionAvailability({ role: 'operator', tab: 'incidents', layout: 'desktop', view: 'FULL', detail: undecided });
  assert.equal(op.determine.enabled, false);
  assert.match(op.determine.reason, /commander/);
  assert.equal(op.file.enabled, false);
  assert.match(op.file.reason, /판단/);
  const commander = actionAvailability({ role: 'commander', tab: 'incidents', layout: 'desktop', view: 'FULL', detail: undecided });
  assert.equal(commander.determine.enabled, true);
  const decided = actionAvailability({ role: 'commander', tab: 'incidents', layout: 'desktop', view: 'FULL', detail: incident({ decidedAt: AT }) });
  assert.equal(decided.determine.enabled, false);
  assert.match(decided.determine.reason, /한 번/);
  assert.equal(decided.file.enabled, true);
  assert.equal(validateDeterminationDraft({ outcome: 'APPLICABLE', reason: '침해사고에 해당합니다' }), null);
  assert.match(validateDeterminationDraft({ outcome: 'MAYBE', reason: '사유' }), /판단/);
  assert.match(validateDeterminationDraft({ outcome: 'APPLICABLE', reason: '' }), /사유/);
});

test('F-03-7 T9 FR-063-2 의무별 기한은 24시간·72시간·14일을 남은 시간으로 보이고, 종결은 남은 의무가 있으면 막힌다', async () => {
  const { incidentDutyView, actionAvailability } = await load();
  const duties = incidentDutyView(incident({ decidedAt: AT }), AT_MS);
  const map = Object.fromEntries(duties.map((d) => [d.duty, d]));
  assert.equal(map.KISA_REPORT_24H.remainingMs, 24 * HOUR);
  assert.equal(map.USER_NOTICE.remainingMs, 2 * HOUR);
  assert.equal(map.USER_NOTICE.tone, 'danger');
  assert.ok(map.KISA_REPORT_24H.label.includes('신고'));
  const blocked = actionAvailability({ role: 'commander', tab: 'incidents', layout: 'desktop', view: 'FULL', detail: incident({ decidedAt: AT }) });
  assert.equal(blocked.close.enabled, false);
  assert.match(blocked.close.reason, /남은/);
  const done = incident({ decidedAt: AT, duties: [{ duty: 'KISA_REPORT_24H', dueAt: AT, doneAt: AT }] });
  assert.equal(actionAvailability({ role: 'commander', tab: 'incidents', layout: 'desktop', view: 'FULL', detail: done }).close.enabled, true);
});

test('F-03-7 T9 FR-063-3 통지 문안은 제목 말머리 [피켓]과 필수 칸이 있고, 신고 기록은 의무·기관·시각·요약이 필요하다', async () => {
  const { noticeUserCopy, validateFilingDraft } = await load();
  for (const kind of ['A', 'A2', 'A3', 'B']) {
    const copy = noticeUserCopy(kind);
    assert.ok(copy.title.startsWith('[피켓]'), `${kind} 제목`);
    assert.ok(copy.required.length > 0, `${kind} 필수 칸`);
  }
  const ok = { duty: 'KISA_REPORT_24H', channel: '과학기술정보통신부', doneAt: AT, summary: '신고했습니다' };
  assert.equal(validateFilingDraft(ok), null);
  assert.match(validateFilingDraft({ ...ok, duty: 'OTHER' }), /의무/);
  assert.match(validateFilingDraft({ ...ok, channel: ' ' }), /기관|방법/);
});

test('F-03-7 T10 FR-064-1 접속기록 점검은 commander만 보고, 본인 기록은 운영에서 막고 데모에서만 자기 점검(시연)으로 연다', async () => {
  const { actionAvailability, validateFindingResolution } = await load();
  const finding = { findingId: 'f'.repeat(36), self: true, state: 'OPEN' };
  const op = actionAvailability({ role: 'operator', tab: 'access-reviews', layout: 'desktop', view: 'FULL', detail: finding, demo: false });
  assert.equal(op.resolveFinding.enabled, false);
  assert.equal(op.completeReview.enabled, false);
  const self = actionAvailability({ role: 'commander', tab: 'access-reviews', layout: 'desktop', view: 'FULL', detail: finding, demo: false });
  assert.equal(self.selfResolve.enabled, false);
  assert.match(self.selfResolve.reason, /다른 commander/);
  const demo = actionAvailability({ role: 'commander', tab: 'access-reviews', layout: 'desktop', view: 'FULL', detail: finding, demo: true });
  assert.equal(demo.selfResolve.enabled, true);
  assert.equal(validateFindingResolution({ reason: '본인 조회', action: 'NONE' }), null);
  assert.match(validateFindingResolution({ reason: '', action: 'NONE' }), /사유/);
  assert.match(validateFindingResolution({ reason: '사유', action: 'ETC' }), /사후조치/);
});

test('F-03-7 T11 ASVS-8.1.2-1 SUMMARY 응답이면 대상자·문서·파일 칸이 없고, viewer는 통보·자료 요청을 부르지 않는다', async () => {
  const { listViewOf, actionAvailability, visibleFields } = await load();
  assert.equal(listViewOf({ view: 'SUMMARY' }), 'SUMMARY');
  assert.equal(listViewOf({}), 'UNKNOWN');
  const summary = visibleFields(notice({ view: 'SUMMARY', receivedAt: undefined, reviewIds: undefined, documents: undefined }));
  assert.deepEqual(summary, ['noticeId', 'requester', 'agencyName', 'dueAt', 'status']);
  const reqSummary = visibleFields(dataRequest({ view: 'SUMMARY', subjects: undefined, extraction: undefined, documents: undefined, submission: undefined }));
  assert.deepEqual(reqSummary, ['requestId', 'requester', 'agencyName', 'kind', 'dueAt', 'status']);
  for (const role of ['viewer', 'cs_agent']) {
    const v = actionAvailability({ role, tab: 'requests', layout: 'desktop', view: 'SUMMARY', detail: notice({ view: 'SUMMARY' }) });
    assert.equal(v.register.enabled, false);
    assert.equal(v.takedown.enabled, false);
  }
  const cs = actionAvailability({ role: 'cs_agent', tab: 'requests', layout: 'desktop', view: 'SUMMARY', detail: dataRequest({ view: 'SUMMARY' }) });
  assert.equal(cs.approve.enabled, false);
  assert.equal(cs.extract.enabled, false);
});

test('F-03-7 T11 ASVS-8.1.2-2 요청자 본인은 승인할 수 없고, 승인 대기·제출 대기 상태가 아니면 막는다', async () => {
  const { actionAvailability } = await load();
  const self = actionAvailability({ role: 'commander', tab: 'requests', layout: 'desktop', view: 'FULL', detail: dataRequest({ requestedBySelf: true }) });
  assert.equal(self.approve.enabled, false);
  assert.match(self.approve.reason, /요청한 분|본인/);
  const commander = actionAvailability({ role: 'commander', tab: 'requests', layout: 'desktop', view: 'FULL', detail: dataRequest() });
  assert.equal(commander.approve.enabled, true);
  assert.equal(commander.reject.enabled, true);
  const approved = actionAvailability({ role: 'commander', tab: 'requests', layout: 'desktop', view: 'FULL', detail: dataRequest({ status: 'APPROVED', extraction: null }) });
  assert.equal(approved.approve.enabled, false);
  assert.equal(approved.submit.enabled, false);
});

test('F-03-7 T12 ASVS-3.3.4-1 추출 요청·승인만 act AUTHORITY_DATA를 쓰고, 다른 법정 조치 쓰기는 재인증을 요구하지 않는다', async () => {
  const { reauthActOf, COMPLIANCE_ACTIONS } = await load();
  assert.equal(reauthActOf('extract'), 'AUTHORITY_DATA');
  assert.equal(reauthActOf('approve'), 'AUTHORITY_DATA');
  for (const action of COMPLIANCE_ACTIONS.filter((a) => a !== 'extract' && a !== 'approve')) assert.equal(reauthActOf(action), null, action);
});

test('F-03-7 T13 ASVS-14.2.1-2 법정 조치 화면 주소에는 tab·state·경로 ID만 싣고 대상자·사유·해시를 싣지 않는다', () => {
  const page = readFileSync(new URL('../ui/ConnectedPage.tsx', import.meta.url), 'utf8');
  for (const bad of ["set('subject'", "set('reason'", "set('sha'", "set('q'", "set('token'", 'X-Reauth-Token=']) assert.equal(page.includes(bad), false, bad);
});

test('F-03-7 T14 ASVS-1.2.1-3 법정 조치 화면 파일에는 dangerouslySetInnerHTML이 없다', () => {
  for (const rel of ['../ui/ConnectedPage.tsx', '../ui/connected/NoticePanel.tsx', '../ui/connected/DataRequestPanel.tsx', '../ui/connected/IncidentPanel.tsx', '../ui/connected/AccessReviewPanel.tsx']) {
    assert.equal(readFileSync(new URL(rel, import.meta.url), 'utf8').includes('dangerouslySetInnerHTML'), false, rel);
  }
});
