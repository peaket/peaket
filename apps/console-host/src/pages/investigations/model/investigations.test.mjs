// F-04-15 SCR-070 부정 거래 조사 사건 목록의 순수 모델 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.3~§6.7.8, docs/design/d3-screens.md SCR-070,
// docs/api/openapi.yaml 태그 investigations.
// [ASVS v5.0.0-1.2.2] 외부 게시물 주소를 링크로 만들지 않는다, [ASVS v5.0.0-8.2.1] 지정 조사관만,
// [ASVS v5.0.0-8.2.2] 승인 역할 구분. 화면은 서버가 준 값만 쓰고 점수 원값·가중치를 만들지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateRetryText,
  canRerun,
  createCaseBody,
  externalPostFormData,
  externalPostIssues,
  externalPostSummary,
  filterCases,
  investigationsProblem,
  isInvestigator,
  mapCase,
  mapCluster,
  mapOverview,
  maskRegionOfDrag,
  maskRegionsValid,
  postUrlDisplay,
} from './investigations.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const UUID = '0194b220-0000-7000-8000-000000000001';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const capture = (over = {}) => ({ name: 'capture.png', type: 'image/png', sizeBytes: 1024, bytes: new Uint8Array(PNG), ...over });
const post = (over = {}) => ({
  eventId: UUID,
  url: 'https://example.com/market/12345',
  capturedAt: iso(NOW),
  source: 'MANUAL',
  capture: capture(),
  checks: [true, true, true],
  ...over,
});

test('FX-T19 ⑩ [ASVS v5.0.0-1.2.2] 외부 게시물 등록은 주소를 링크로 만들지 않고 서버 규칙대로 폼을 만든다', () => {
  assert.deepEqual(externalPostIssues(post()), []);
  assert.match(externalPostIssues(post({ url: 'javascript:alert(1)' }))[0], /http/);
  assert.match(externalPostIssues(post({ checks: [true, false, true] }))[0], /확인/);
  assert.match(externalPostIssues(post({ source: 'REPORT' }))[0], /신고/);
  assert.deepEqual(externalPostIssues(post({ source: 'REPORT', reportCaseId: 'CS-2610-0377' })), []);
  assert.match(externalPostIssues(post({ capture: capture({ name: 'capture.gif', type: 'image/gif' }) }))[0], /PNG/);
  assert.match(externalPostIssues(post({ capture: capture({ sizeBytes: 10 * 1024 * 1024 + 1 }) }))[0], /10MB/);
  assert.equal(externalPostIssues(post({ capture: capture({ sizeBytes: 10 * 1024 * 1024 }) })).length, 0);
  assert.equal(externalPostIssues(post({ url: 'http://example.com/a' })).length, 0);
  assert.match(externalPostIssues(post({ url: 'https://user:pass@example.com/a' }))[0], /사용자 정보|주소/);
  const url2048 = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  const url2049 = `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}`;
  assert.equal(externalPostIssues(post({ url: url2048 })).length, 0);
  assert.match(externalPostIssues(post({ url: url2049 }))[0], /2,048|2048|주소/);
  assert.equal(externalPostIssues(post({ capture: capture({ name: 'capture.jpg', type: 'image/jpeg', bytes: new Uint8Array(JPEG) }) })).length, 0);
  assert.equal(externalPostIssues(post({ capture: capture({ name: 'capture.pdf', type: 'application/pdf', bytes: new Uint8Array(PDF) }) })).length, 0);
  assert.match(externalPostIssues(post({ maskRegions: Array.from({ length: 21 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })) }))[0], /20/);

  const form = externalPostFormData(post({ postedAt: iso(NOW + HOUR), maskRegions: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }] }));
  assert.ok(form instanceof FormData);
  assert.equal(form.get('eventId'), UUID);
  assert.equal(form.get('source'), 'MANUAL');
  assert.equal(form.get('url'), 'https://example.com/market/12345');
  assert.ok(form.get('capture') instanceof Blob);
  assert.match(String(form.get('maskRegions')), /"x":0.1/);
});

test('FX-T19 ⑩ 가림 상자는 끌기·좌표 입력을 0~1로 정규화하고 캡처 밖을 자르며 20개를 넘기지 않는다', () => {
  assert.deepEqual(maskRegionOfDrag({ x: 10, y: 20 }, { x: 110, y: 70 }, { width: 200, height: 100 }), { x: 0.05, y: 0.2, w: 0.5, h: 0.5 });
  assert.deepEqual(maskRegionOfDrag({ x: 110, y: 70 }, { x: 10, y: 20 }, { width: 200, height: 100 }), { x: 0.05, y: 0.2, w: 0.5, h: 0.5 });
  assert.deepEqual(maskRegionOfDrag({ x: -20, y: -10 }, { x: 210, y: 120 }, { width: 200, height: 100 }), { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(maskRegionOfDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, { width: 200, height: 100 }), null);
  assert.equal(maskRegionsValid(Array.from({ length: 20 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 }))), true);
  assert.equal(maskRegionsValid(Array.from({ length: 21 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 }))), false);
  assert.equal(maskRegionsValid([{ x: 0, y: 0, w: 0, h: 0.1 }]), false);
  assert.equal(maskRegionsValid([{ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }]), false);
});

test('FX-T19 ⑪ 게시물 목록은 검사 상태·보기 가능·맞은 표 수만 보이고 원본·신고자 정보를 싣지 않는다', () => {
  const clean = externalPostSummary({ postId: UUID, url: 'https://example.com/a', source: 'REPORT', scanStatus: 'CLEAN', viewAvailable: true, matchedTicketCount: 2, capturedAt: iso(NOW), claimedSeats: 'A구역 3열 14번', reporterName: '신고자', contactRef: 'c-1' });
  assert.equal(clean.urlText, 'example.com/a');
  assert.equal(clean.viewAvailable, true);
  assert.equal(clean.matchedTicketCount, 2);
  assert.equal(clean.claimedSeats, 'A구역 3열 14번');
  assert.ok(!JSON.stringify(clean).includes('신고자'));
  assert.ok(!JSON.stringify(clean).includes('c-1'));
  assert.equal(externalPostSummary({ scanStatus: 'PENDING', viewAvailable: false }).viewAvailable, false);
  assert.match(externalPostSummary({ scanStatus: 'THREAT' }).scanLabel, /위협/);
  assert.match(externalPostSummary({ scanStatus: 'CLEAN', viewAvailable: false }).scanLabel, /없음|PDF/);
  assert.equal(postUrlDisplay('https://example.com/b'), 'example.com/b');
  assert.equal(postUrlDisplay('javascript:alert(1)'), '주소 형식이 아닙니다');
});

test('C-T71 ⑤ [ASVS v5.0.0-8.1.2] 회차 머리·후보·사건 목록은 서버 값만 쓰고 점수 원값·가중치를 싣지 않는다', () => {
  const overview = mapOverview(
    {
      eventId: UUID,
      snapshot: { version: 3, frozenAt: iso(NOW - HOUR), invHash: 'a'.repeat(64), late: true },
      latestRun: { status: 'FAILED', startedAt: iso(NOW - 2 * HOUR), finishedAt: iso(NOW - HOUR), clusterCount: 4, autoRetriesLeft: 0 },
      rerunAllowed: true,
      summary: { clusterCount: 4, caseCount: 2, byStatus: { INVESTIGATING: 1, ACTIONED: 1 }, actionedTicketCount: 3, restrictedAccountCount: 1, appealAcceptedRatio: 0.5 },
      cancelDeadlineAt: iso(NOW + 26 * HOUR),
      sourceExpiresAt: iso(NOW + 30 * 24 * HOUR),
    },
    UUID,
  );
  assert.equal(overview.snapshot?.version, 3);
  assert.equal(overview.snapshot?.late, true);
  assert.equal(overview.latestRun?.autoRetriesLeft, 0);
  assert.equal(overview.summary.appealAcceptedRatio, 0.5);
  assert.equal(canRerun(overview), true);
  assert.equal(canRerun({ ...overview, rerunAllowed: false }), false);
  assert.equal(canRerun({ ...overview, latestRun: { ...overview.latestRun, status: 'RUNNING' } }), false);
  assert.equal(canRerun({ ...overview, latestRun: { ...overview.latestRun, status: 'DONE' } }), false);
  assert.equal(canRerun({ ...overview, latestRun: { ...overview.latestRun, autoRetriesLeft: 1 } }), false);
  assert.match(candidateRetryText(2), /2/);

  const before = mapOverview({ eventId: UUID, snapshot: null, latestRun: null, rerunAllowed: false, summary: { clusterCount: 0, caseCount: 0, byStatus: {}, actionedTicketCount: 0, restrictedAccountCount: 0, appealAcceptedRatio: null }, cancelDeadlineAt: null, sourceExpiresAt: null }, UUID);
  assert.equal(before.snapshot, null);
  assert.equal(before.latestRun, null);
  assert.equal(canRerun(before), false);

  const cluster = mapCluster({ clusterId: UUID, generation: 2, scoreBand: 'HIGH', accountCount: 9, purchaseCount: 27, limitPerPerson: 4, sharedAttributes: ['DEVICE'], signals: ['LINK_GRAPH'], caseId: null, score: 99, weights: { LINK_GRAPH: 3 } });
  assert.deepEqual(cluster, { clusterId: UUID, generation: 2, scoreBand: 'HIGH', accountCount: 9, purchaseCount: 27, limitPerPerson: 4, sharedAttributes: ['DEVICE'], signals: ['LINK_GRAPH'], caseId: null });

  const cases = [
    mapCase({ caseId: 'c1', status: 'INVESTIGATING', reasonCategory: 'MACRO_BOT', accountCount: 3, ticketCount: 5, assigneeId: 'a1', appealDueAt: null, cancelDeadlineAt: iso(NOW + HOUR), transferLocked: false }),
    mapCase({ caseId: 'c2', status: 'ACTIONED', reasonCategory: 'LIMIT_EVASION', accountCount: 2, ticketCount: 4, assigneeId: 'a1', appealDueAt: iso(NOW - HOUR), cancelDeadlineAt: iso(NOW - HOUR), transferLocked: true }),
  ];
  assert.deepEqual(filterCases(cases, 'ALL').map((c) => c.caseId), ['c1', 'c2']);
  assert.deepEqual(filterCases(cases, 'ACTIONED').map((c) => c.caseId), ['c2']);
  assert.deepEqual(filterCases(cases, 'CLEARED'), []);
});

test('C-T71 ⑤ 사건 만들기·다시 돌리기 가능 판정과 오류 문구는 서버 상태로 갈린다', () => {
  assert.deepEqual(createCaseBody(` ${UUID} `, 'MACRO_BOT'), { clusterId: UUID, reasonCategory: 'MACRO_BOT' });
  assert.match(investigationsProblem({ status: 403, code: 'investigator-required' }).message, /권한/);
  assert.equal(investigationsProblem({ status: 403, code: 'investigator-required' }).kind, 'forbidden');
  assert.equal(investigationsProblem({ status: 410, code: 'investigation-source-expired' }).kind, 'expired');
  assert.equal(investigationsProblem({ status: 409, code: 'fraud-case-exists' }).kind, 'conflict');
  assert.equal(investigationsProblem({ status: 409, code: 'fraud-case-exists' }).reload, true);
  assert.equal(investigationsProblem({ status: 503, code: 'dependency-unavailable' }).kind, 'error');
  assert.match(investigationsProblem(new Error('boom')).message, /불러오지 못했습니다/);
});

test('C-T71 ⑤ [ASVS v5.0.0-8.2.1] 지정 없는 viewer·operator·cs_agent는 조사 화면을 쓸 수 없다', () => {
  assert.equal(isInvestigator('commander', ['FRAUD_INVESTIGATOR']), true);
  assert.equal(isInvestigator('cs_lead', ['FRAUD_INVESTIGATOR']), true);
  assert.equal(isInvestigator('commander', []), false);
  assert.equal(isInvestigator('viewer', ['FRAUD_INVESTIGATOR']), false);
  assert.equal(isInvestigator('operator', ['FRAUD_INVESTIGATOR']), false);
  assert.equal(isInvestigator('cs_agent', ['FRAUD_INVESTIGATOR']), false);
});
