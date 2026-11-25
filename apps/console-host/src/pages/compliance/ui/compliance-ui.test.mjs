// SCR-032 법정 조치 부품·배선 시험(F-03-7 T7·T8·T9·T10·T11·T14·T19, ASVS v5.0.0-8.1.2, C-T57 화면 몫).
// 부품은 props만으로 그리는 서버 그리기로 보고, 칸 가림·막힘·휴대폰·글자 이스케이프를 확인한다.
// 구현 전 트리에는 ui/connected 부품과 ConnectedPage가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textOf } from '../../dashboard/ui/live/live.test.html.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');

const noop = () => undefined;
const AT = '2026-11-23T11:00:00.000Z';
const AT_MS = Date.parse(AT);
const HOUR = 60 * 60_000;
const READ = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function render(mod, name, props) {
  return renderToString(createElement(MemoryRouter, { initialEntries: ['/compliance?tab=requests'] }, createElement(mod[name], props)));
}
function buttons(html) {
  return [...html.matchAll(/<button(\s[^>]*)?>([\s\S]*?)<\/button>/g)].map((m) => {
    const attrs = Object.fromEntries([...(m[1] ?? '').matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    return { ...attrs, text: textOf(m[2]) };
  });
}
const btn = (html, re) => buttons(html).find((b) => re.test(b.text));
const off = (b) => b !== undefined && ('disabled' in b || b['aria-disabled'] === 'true');

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
  summary: '암표 의심 게시물 통보 <img src=x onerror=alert(1)>',
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
  duties: [{ duty: 'KISA_REPORT_24H', dueAt: new Date(AT_MS + 24 * HOUR).toISOString(), doneAt: null }],
  filings: [],
  ...over,
});

test('F-03-7 T7-4 통보 상세는 기관·기한·게시물·노출 차단 단추를 보이고, 요약의 HTML은 글자로만 남는다', async () => {
  const { NoticePanel } = await import('./connected/NoticePanel.tsx');
  const html = render({ NoticePanel }, 'NoticePanel', { role: 'operator', layout: 'desktop', notice: notice(), nowMs: AT_MS, busy: false, onTakedown: noop, onWithdraw: noop, onUpload: noop });
  const text = textOf(html);
  assert.ok(text.includes('한국콘텐츠진흥원'));
  assert.ok(text.includes('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'));
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), '요약은 글자 그대로다');
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(btn(html, /노출 차단/), '노출 차단 단추');
  assert.equal(off(btn(html, /노출 차단/)), false);
});

test('F-03-7 T11 ASVS-8.1.2-3 SUMMARY 통보는 ID·기관·종류·기한·상태만 그리고 게시물·문서 칸을 두지 않는다', async () => {
  const { NoticePanel } = await import('./connected/NoticePanel.tsx');
  const html = render({ NoticePanel }, 'NoticePanel', { role: 'cs_agent', layout: 'desktop', notice: notice({ view: 'SUMMARY', receivedAt: undefined, reviewIds: undefined, documents: undefined }), nowMs: AT_MS, busy: false, onTakedown: noop, onWithdraw: noop, onUpload: noop });
  const text = textOf(html);
  assert.ok(text.includes('요약'));
  assert.equal(text.includes('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'), false, '게시물 ID가 없다');
  assert.ok(off(btn(html, /노출 차단/)));
});

test('F-03-7 T8-4 자료 요청 상세는 점검표·추출 행 수·제출 파일·승인 단추를 보이고, 요청자 본인은 승인 이유를 본다', async () => {
  const { DataRequestPanel } = await import('./connected/DataRequestPanel.tsx');
  const html = render({ DataRequestPanel }, 'DataRequestPanel', { role: 'commander', layout: 'desktop', request: dataRequest(), nowMs: AT_MS, busy: false, onExtract: noop, onApprove: noop, onReject: noop, onSubmit: noop });
  const text = textOf(html);
  assert.ok(text.includes('형사소송법 제215조 제2항'));
  assert.ok(text.includes('acc-1'), 'FULL은 대상자 값이 보인다');
  assert.ok(text.includes('12'), '항목별 행 수');
  assert.equal(off(btn(html, /^승인$/)), false);
  assert.equal(off(btn(html, /^거부$/)), false);
  const selfHtml = render({ DataRequestPanel }, 'DataRequestPanel', { role: 'commander', layout: 'desktop', request: dataRequest({ requestedBySelf: true }), nowMs: AT_MS, busy: false, onExtract: noop, onApprove: noop, onReject: noop, onSubmit: noop });
  const self = textOf(selfHtml);
  assert.ok(self.includes('요청한 분은 승인할 수 없습니다'));
  assert.ok(off(btn(selfHtml, /^승인$/)));
});

test('F-03-7 T11 ASVS-8.1.2-4 SUMMARY 자료 요청은 대상자·범위·제출 파일을 그리지 않는다', async () => {
  const { DataRequestPanel } = await import('./connected/DataRequestPanel.tsx');
  const html = render({ DataRequestPanel }, 'DataRequestPanel', { role: 'cs_agent', layout: 'desktop', request: dataRequest({ view: 'SUMMARY', subjects: undefined, extraction: undefined, documents: undefined, submission: undefined, retainUntil: undefined }), nowMs: AT_MS, busy: false, onExtract: noop, onApprove: noop, onReject: noop, onSubmit: noop });
  const text = textOf(html);
  assert.equal(text.includes('acc-1'), false);
  assert.equal(text.includes('형사소송법'), false);
  assert.ok(text.includes('요약'));
});

test('F-03-7 T9-4 보안 사고 상세는 판단 전 기록 단추를 막고 이유를 보이며, 의무별 기한을 보인다', async () => {
  const { IncidentPanel } = await import('./connected/IncidentPanel.tsx');
  const op = render({ IncidentPanel }, 'IncidentPanel', { role: 'operator', layout: 'desktop', incident: incident(), nowMs: AT_MS, demo: false, busy: false, onDetermine: noop, onFile: noop, onClose: noop });
  const text = textOf(op);
  assert.ok(text.includes('24'), '의무 기한');
  assert.ok(off(btn(op, /신고·통지 기록/)));
  assert.ok(text.includes('commander가 해당 판단을 기록한 뒤'));
  const cmd = render({ IncidentPanel }, 'IncidentPanel', { role: 'commander', layout: 'desktop', incident: incident(), nowMs: AT_MS, demo: false, busy: false, onDetermine: noop, onFile: noop, onClose: noop });
  assert.equal(off(btn(cmd, /판단을 기록/)), false);
});

test('F-03-7 T10-2 접속기록 점검 부품은 운영에서 본인 종결을 막고, 데모에서만 자기 점검(시연)을 연다', async () => {
  const { AccessReviewPanel } = await import('./connected/AccessReviewPanel.tsx');
  const finding = { findingId: 'f'.repeat(36), self: true, state: 'OPEN', kind: '반복 다운로드' };
  const props = { role: 'commander', layout: 'desktop', review: { reviewId: 'r-1', period: '2026-11', state: 'OPEN' }, findings: [finding], busy: false, onComplete: noop, onResolve: noop };
  const prod = render({ AccessReviewPanel }, 'AccessReviewPanel', { ...props, demo: false });
  const prodText = textOf(prod);
  assert.ok(prodText.includes('본인 접속기록은 다른 commander가 점검하고 종결합니다'));
  assert.equal(btn(prod, /자기 점검\(시연\)/), undefined, '운영에는 자기 점검 단추가 없다');
  const demo = render({ AccessReviewPanel }, 'AccessReviewPanel', { ...props, demo: true });
  const demoText = textOf(demo);
  assert.ok(demoText.includes('데모 환경'));
  assert.ok(btn(demo, /자기 점검\(시연\)/), '데모에는 자기 점검 단추');
  assert.equal(off(btn(demo, /자기 점검\(시연\)/)), false);
});

test('F-03-7 T11 ASVS-8.1.2-5 휴대폰은 조회만 하고 등록·집행 단추를 그리지 않는다', async () => {
  const { NoticePanel } = await import('./connected/NoticePanel.tsx');
  const html = render({ NoticePanel }, 'NoticePanel', { role: 'operator', layout: 'phone', notice: notice(), nowMs: AT_MS, busy: false, onTakedown: noop, onWithdraw: noop, onUpload: noop });
  const text = textOf(html);
  assert.ok(text.includes('등록과 집행은 태블릿이나 데스크톱에서 합니다'));
  assert.ok(off(btn(html, /노출 차단/)));
});

test('F-03-7 T19-3 실제 경로는 연결 화면을, 미리보기 ?state=는 보드를 그린다', () => {
  const page = READ('../ui/Page.tsx');
  assert.ok(page.includes("from './ConnectedPage'"));
  assert.match(page, /__PREVIEW__ && .*state.*\? <BoardPage \/> : <ConnectedPage \/>/s);
});

test('F-03-7 T19-4 법정 조치 연결 화면은 계약의 목록·상세·쓰기 함수와 재인증을 실제로 가져온다', () => {
  const page = READ('../ui/ConnectedPage.tsx');
  for (const name of ['listOpsComplianceNotices', 'getOpsComplianceNotice', 'listOpsComplianceDataRequests', 'createOpsComplianceDataRequestExtractionRequest', 'createOpsComplianceDataRequestApproval', 'listOpsComplianceIncidents', 'createOpsComplianceIncidentDetermination', 'listOpsComplianceAccessReviews', 'createOpsComplianceAccessFindingResolution', 'getMyOpsAuthSession']) {
    assert.ok(page.includes(name), `${name}을 가져오지 않는다`);
  }
});
