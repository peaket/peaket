// F-04-15 SCR-070 운영 경로 배선 시험(동결 로컬, LCH-310).
// 운영 경로는 실제 조사 API만 부르고, 목업은 __PREVIEW__·?state= 보드에만 남긴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('UI-01 SCR-070 운영 경로는 실제 조사 API를 부르고 목업을 가져오지 않는다', () => {
  const page = read('./ConnectedPage.tsx');
  for (const name of ['getOpsEventFraudOverview', 'listOpsFraudClusters', 'listOpsFraudCases', 'createOpsFraudCase', 'createOpsEventFraudClusterRun', 'listOpsExternalPosts', 'createOpsExternalPost']) {
    assert.match(page, new RegExp(`\\b${name}\\s*\\(`), `${name} 호출식이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/investigations'\)/);
  assert.match(page, /ensureConsoleApi\(/);
  assert.match(page, /await load\(/);
  assert.match(page, /mapOverview\(|mapCluster\(|mapCase\(/);
  assert.doesNotMatch(page, /from ['"][^'"]*entities\/fraud-case/);
  // IR-14: 회차 머리의 늦은 적재·실행 상태·요약 4칸·취소 마감·원천 보존 끝·게시물 보기
  assert.match(page, /snapshot\?\.late|snapshot\.late/);
  assert.match(page, /latestRun/);
  assert.match(page, /byStatus/);
  assert.match(page, /actionedTicketCount/);
  assert.match(page, /restrictedAccountCount/);
  assert.match(page, /appealAcceptedRatio/);
  assert.match(page, /cancelDeadlineAt/);
  assert.match(page, /sourceExpiresAt/);
  assert.match(page, /viewAvailable/);
  // IR-03: 실제 파일 입력·미리보기·가림 상자 끌기와 키보드 입력
  assert.match(page, /type="file"/);
  assert.match(page, /maskRegionOfDrag\(/);
  assert.match(page, /onPointerDown|onMouseDown/);
  assert.match(page, /createObjectURL|FileReader/);
  assert.doesNotMatch(page, /new Uint8Array\(\[0x89/);
});

test('UI-01 SCR-070 보드 미리보기는 __PREVIEW__와 ?state=에만 남는다', () => {
  const route = read('./Page.tsx');
  assert.match(route, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(route, /function BoardPage/);
});

test('FX-T19 ⑩ [ASVS v5.0.0-3.5.3] 게시물 등록은 multipart POST 하나로 보내고 주소를 링크로 만들지 않는다', () => {
  const page = read('./ConnectedPage.tsx');
  assert.match(page, /createOpsExternalPost\(/);
  assert.match(page, /FormData/);
  assert.match(page, /externalPostFormData\(/);
  assert.doesNotMatch(page, /<a[^>]+href=\{?[^>]*url/i);
  assert.match(page, /postUrlDisplay\(/);
});
