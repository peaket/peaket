// F-07-12 SCR-063 배선(AC-06). 소문자 UUID이고 ?state=가 없을 때만 라이브 경로를 고르고,
// 라이브 화면이 공연 개요·판매자 정보 API와 순수 변환 함수를 쓰는지 본다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageUrl = new URL('./ui/EventOverviewPage.tsx', import.meta.url);
const liveUrl = new URL('./ui/LiveEventOverview.tsx', import.meta.url);
const page = () => readFileSync(pageUrl, 'utf8');
const live = () => readFileSync(liveUrl, 'utf8');

test('F-07-12 AC-06 UO-06 SCR-063는 UUID 공연이고 ?state=가 없으면 라이브를, 아니면 목업을 고른다', () => {
  assert.equal(existsSync(liveUrl), true, 'LiveEventOverview.tsx가 없다');
  const src = page();
  assert.match(src, /LiveEventOverview/);
  assert.match(src, /UUID\.test\(id\)/);
  assert.match(src, /readParam\([^)]*'state'\)|sp\.state/);
  assert.match(src, /PreviewStateSwitcher/, '?state= 목업 미리보기를 지우면 안 된다');
});

test('F-07-12 AC-06 UO-07 라이브 화면은 개요·판매자 API와 변환 함수를 쓰고 HTML을 주입하지 않는다 [ASVS v5.0.0-1.2.1]', () => {
  const src = live();
  assert.match(src, /getPartnerProduction/);
  assert.match(src, /getPartnerSellerProfile/);
  assert.match(src, /productionOfDetail/);
  assert.match(src, /progressOf/);
  assert.match(src, /eventRowsOf/);
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(src), false);
  assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(page()), false);
});
