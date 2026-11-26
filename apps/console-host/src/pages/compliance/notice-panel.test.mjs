// SCR-032 법정 조치의 통보 탭 연결(F-07-11, d5 §7.5, openapi /v1/ops/compliance/notices*).
// 정본: d5 3258~3263·3287~3306행, docs/security/authz-matrix.md §4.1(CS는 요약, operator·commander는 원문), ASVS 14.2.6.
// 화면은 기관 이름·요약·사유를 글자 노드로만 넣고, 신고자·작성자 계정·주문·팬 이름을 싣지 않는다.
// 이 시험은 구현 전 트리에서 ConnectedPage·model/notice.ts가 없어 실패한다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const path = (p) => new URL(p, import.meta.url);
const has = (p) => existsSync(path(p));
const read = (p) => readFileSync(path(p), 'utf8');

test('CMS-01 통보 탭은 미리보기(?state=)가 아닐 때 실제 화면으로 바뀐다', () => {
  assert.equal(has('./ui/ConnectedPage.tsx'), true);
  const page = read('./ui/Page.tsx');
  assert.match(page, /ConnectedPage/);
  assert.match(page, /__PREVIEW__ && (?:sp|searchParams)\.get\('state'\)/);
});

test('CMS-02 통보 탭은 목록·상세·등록·차단·철회를 실제 생성 호출로 잇는다', () => {
  assert.equal(has('./ui/ConnectedPage.tsx'), true);
  const connected = read('./ui/ConnectedPage.tsx');
  for (const call of ['listOpsComplianceNotices', 'getOpsComplianceNotice', 'createOpsComplianceNotice', 'createOpsComplianceNoticeTakedown', 'createOpsComplianceNoticeWithdrawal']) {
    assert.equal(connected.includes(call), true, `${call}를 부른다`);
  }
  assert.match(connected, /noticeActionsFor/);
  assert.match(connected, /noticeActionPlan/);
  assert.equal(connected.includes('dangerouslySetInnerHTML'), false);
  assert.equal(connected.includes('innerHTML'), false);
});

test('CMS-03 통보 상세 모델은 계정·주문·팬 이름을 버리고 사유·기관·후기 ID만 남긴다', async () => {
  assert.equal(has('./model/notice.ts'), true);
  const model = read('./model/notice.ts');
  for (const fn of ['noticeViewOf', 'noticeDetailOf', 'noticeFilterOf', 'noticeCreatePlan', 'noticeActionPlan', 'noticeActionsFor']) {
    assert.equal(model.includes(fn), true, `${fn}이 있다`);
  }
  // 동작 시험(기준 트리에서는 모듈이 없어 이 한 건은 실행할 수 없다)
  const m = await import('./model/notice.ts');
  const detail = m.noticeDetailOf({
    view: 'FULL',
    noticeId: 'n1',
    requester: 'AGENCY',
    agencyName: '한국콘텐츠진흥원',
    dueAt: '2026-11-27T00:00:00.000Z',
    status: 'OPEN',
    receivedAt: '2026-11-26T00:00:00.000Z',
    deadline: 'H24',
    reviewIds: ['r1'],
    summary: '요약',
    documents: [],
    takenDownAt: null,
    withdrawnAt: null,
    reporterAccountId: 'a1',
    basisOrderId: 'o1',
    payerName: '김피켓',
    authorDisplay: '김**',
  });
  for (const forbidden of ['reporterAccountId', 'basisOrderId', 'payerName', 'authorDisplay', 'body']) {
    assert.equal(Object.hasOwn(detail, forbidden), false, `${forbidden}를 버린다`);
  }
  assert.deepEqual(detail.reviewIds, ['r1']);
  assert.deepEqual(m.noticeActionsFor(detail, 'cs_agent'), []);
  assert.ok(m.noticeActionsFor(detail, 'operator').includes('TAKEDOWN'));
});

test('CMS-04 통보 탭은 자료 요청·보안 사고·접속기록 점검을 이번 범위 밖으로 안내한다', () => {
  assert.equal(has('./ui/ConnectedPage.tsx'), true);
  const connected = read('./ui/ConnectedPage.tsx');
  assert.match(connected, /자료 요청/);
  assert.match(connected, /보안 사고/);
  assert.match(connected, /접속기록 점검/);
  assert.match(connected, /이번 (?:동결 )?범위 밖|다음 묶음|준비 중/);
});
