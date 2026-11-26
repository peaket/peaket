// F-04-15 SCR-046 부정 예매 조치 운영 경로 배선 시험(동결 로컬, LCH-310).
// 승인 상세의 사건 요약은 실제 승인 API로만 읽고, 보드 목업은 ?state= 미리보기에만 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('UI-01 SCR-046 부정 예매 조치 운영 경로는 실제 승인 API를 부르고 목업을 가져오지 않는다', () => {
  const page = read('./ConnectedPage.tsx');
  for (const name of ['listOpsApprovalRequests', 'getOpsApprovalRequest', 'createOpsApprovalRequestApproval', 'createOpsApprovalRequestRejection']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.match(page, /ensureConsoleApi\(/);
  assert.match(page, /mapFraudSummary\(/);
  assert.doesNotMatch(page, /@\/entities\/fraud-case/);
  assert.doesNotMatch(page, /from '@\/entities\/fraud-case'/);
});

test('UI-01 SCR-046 보드 미리보기는 __PREVIEW__와 ?state=에만 남는다', () => {
  const route = read('./Page.tsx');
  assert.match(route, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(route, /function BoardPage/);
});
