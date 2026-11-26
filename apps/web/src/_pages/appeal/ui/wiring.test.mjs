// F-04-15 SCR-042 부정 예매 소명 운영 경로 배선 시험(동결 로컬, LCH-310).
// 실제 화면은 listFraudAppealRequests·createAppeal만 부르고, 목업 보드는 apl- id와 ?state=에만 남긴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('UI-05 SCR-042 실제 화면은 listFraudAppealRequests·createAppeal만 부르고 목업을 가져오지 않는다', () => {
  const page = read('./FraudAppealLive.tsx');
  for (const name of ['listFraudAppealRequests', 'createAppeal']) {
    assert.match(page, new RegExp(`\\b${name}\\s*\\(`), `${name} 호출식이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/support'\)/);
  assert.match(page, /ensureBrowserApi\(/);
  assert.match(page, /mapFraudLive\(/);
  assert.match(page, /createFraudAppealBody\(/);
  assert.doesNotMatch(page, /from ['"][^'"]*entities\/appeal/);
  // IR-15: 잠금 최대 기한·제외 표·이의 상태를 보이고, 우선 구매 기한은 서버 시각으로 판정한다.
  assert.match(page, /lockExpiresAtMs/);
  assert.match(page, /excludedTicketIds/);
  assert.match(page, /objectionStatus/);
  assert.match(page, /priorityPurchaseRows\(view,\s*nowMs\)/);
  // IR-15: 기한 판정은 마운트 때 한 번이 아니라 그릴 때마다 다시 잡는다.
  assert.match(page, /const nowMs = Date\.now\(\)/);
  assert.doesNotMatch(page, /useState\(\(\) => Date\.now\(\)\)/);
});

test('UI-05 SCR-042 목업 보드는 apl- id와 ?state=에만 남는다', () => {
  const route = read('./AppealPage.tsx');
  assert.match(route, /UUID|uuid/);
  assert.match(route, /FraudAppealLive/);
  assert.match(route, /\/\^\[0-9a-f\]\{8\}-/);
});
