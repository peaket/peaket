// SCR-055 목록이 실제 API로 이어졌는지 소스로 확인한다(F-07-2). 화면을 그리지 않고 배선만 본다.
// 정본: openapi GET /v1/orders·GET /v1/shop/orders, docs/frontend.md §5.29.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('WEB-ORD ④ 목록은 두 실제 경로를 부르고, 한쪽 실패를 부분 실패로 보인다', () => {
  const live = read('./LiveOrders.tsx');
  for (const name of ['listOrders', 'listShopOrders', 'partialFailureNotice', 'liveRows', 'fanApiAvailable']) {
    assert.ok(live.includes(name), `${name} 배선이 없다`);
  }
  assert.match(live, /@peaket\/api-client\/endpoints\/orders/);
  assert.match(live, /@peaket\/api-client\/endpoints\/shop/);
  assert.match(live, /Promise\.allSettled/);
  assert.ok(live.includes('다시 시도'));
  assert.ok(live.includes('로그인한 뒤 다시 확인해 주세요'));
  const page = read('./OrdersPage.tsx');
  assert.match(page, /<LiveOrders /);
  // 미리보기(API 주소 없음)에서는 지금 목업을 그대로 그린다
  assert.match(live, /kind: 'fixture'/);
  assert.match(live, /fixtureTab/);
});
