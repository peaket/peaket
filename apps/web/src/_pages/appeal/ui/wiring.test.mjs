// F-04-15 SCR-042 부정 예매 소명 운영 경로 배선 시험(동결 로컬, LCH-310).
// 실제 화면은 listFraudAppealRequests·createAppeal만 부르고, 목업 보드는 apl- id와 ?state=에만 남긴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('UI-05 SCR-042 실제 화면은 listFraudAppealRequests·createAppeal만 부르고 목업을 가져오지 않는다', () => {
  const page = read('./FraudAppealLive.tsx');
  for (const name of ['listFraudAppealRequests', 'createAppeal']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/support'\)/);
  assert.match(page, /ensureBrowserApi\(/);
  assert.doesNotMatch(page, /@\/entities\/appeal/);
  assert.doesNotMatch(page, /from '@\/entities\/appeal'/);
});

test('UI-05 SCR-042 목업 보드는 apl- id와 ?state=에만 남는다', () => {
  const route = read('./AppealPage.tsx');
  assert.match(route, /UUID|uuid/);
  assert.match(route, /FraudAppealLive/);
  assert.match(route, /\/\^\[0-9a-f\]\{8\}-/);
});
