// F-04-15 SCR-071 사건 작업대 운영 경로 배선 시험(동결 로컬, LCH-310).
// 실제 사건·그래프·소명·조치·증거 API만 부르고, IP 원문은 화면 상태에만 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('UI-01 SCR-071 운영 경로는 실제 사건·그래프·소명·조치·증거 API를 부르고 목업을 가져오지 않는다', () => {
  const page = read('./ConnectedPage.tsx');
  for (const name of ['getOpsFraudCase', 'getOpsFraudCaseGraph', 'createOpsFraudCaseIpReveal', 'createOpsFraudCaseAppealRequest', 'createOpsFraudCaseActionRequest', 'createOpsFraudCaseClearance', 'createOpsFraudCaseEvidenceBundle', 'listOpsEvidenceBundles', 'getOpsEvidenceBundle', 'createOpsEvidenceBundleExport', 'createOpsEvidenceBundleHoldChange', 'createOpsEvidenceBundleHoldEndRequest']) {
    assert.match(page, new RegExp(`\\b${name}\\s*\\(`), `${name} 호출식이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/investigations'\)/);
  assert.match(page, /ensureConsoleApi\(/);
  assert.match(page, /await load\(/);
  assert.match(page, /mapCaseDetail\(|mapGraph\(/);
  assert.doesNotMatch(page, /from ['"][^'"]*entities\/fraud-case/);
});

test('UI-01 SCR-071 보드 미리보기는 __PREVIEW__와 ?state=에만 남는다', () => {
  const route = read('./Page.tsx');
  assert.match(route, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(route, /function BoardPage/);
});

test('UI-03 IP 원문은 화면 상태에만 두고 이탈·숨기기에서 지우며 저장소·URL에 쓰지 않는다', () => {
  const page = read('./ConnectedPage.tsx');
  assert.match(page, /useState/);
  assert.match(page, /return \(\) => setRevealed\(null\)/);
  assert.match(page, /원문 숨기기/);
  assert.ok((page.match(/setRevealed\(null\)/g) ?? []).length >= 2);
  assert.doesNotMatch(page, /sessionStorage|localStorage|indexedDB/i);
  assert.doesNotMatch(page, /window\.location[^\n]*ip/i);
  assert.doesNotMatch(page, /console\.(log|info|warn|error)\([^\n]*\bip\b/i);
  assert.doesNotMatch(page, /useRef\([^)]*\)[\s\S]{0,80}revealed/i);
});
